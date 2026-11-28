/**
 * Unit tests (mocked Prisma) for the ACLED source fields: geo_precision, latitude, longitude,
 * read from the stored payload, and nothing else of the payload.
 */

import { describe, it, expect, vi } from "vitest";
import { acledCoordinate, acledGeoPrecision, signalResolvers } from "../../src/resolvers/signal.resolver.js";
import type { Context } from "../../src/context.js";

const resolve = signalResolvers.Signal.sourcePrecision;
const ctx = (prisma: unknown) => ({ prisma }) as unknown as Context;

describe("acledGeoPrecision", () => {
  it("returns 1, 2 or 3 for an ACLED payload, number or string", () => {
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: 1 })).toBe(1);
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: "2" })).toBe(2);
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: 3 })).toBe(3);
  });

  it("returns null for another source, a missing value or an unknown code", () => {
    expect(acledGeoPrecision("dataminr:1", { geo_precision: 1 })).toBeNull();
    expect(acledGeoPrecision(null, { geo_precision: 1 })).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", {})).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", null)).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: 4 })).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: "" })).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: true })).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: [1] })).toBeNull();
    expect(acledGeoPrecision("acled:SDN1", { geo_precision: "1.0" })).toBeNull();
  });
});

describe("Signal.sourcePrecision", () => {
  it("reads a loaded parent without a query", async () => {
    const findUnique = vi.fn();
    const parent = { id: "s1", externalId: "acled:SDN1", rawData: { geo_precision: "2" } };
    expect(await resolve(parent, {}, ctx({ signals: { findUnique } }))).toBe(2);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null for a non-ACLED parent without a query", async () => {
    const findUnique = vi.fn();
    expect(await resolve({ id: "s1", externalId: "x:1" }, {}, ctx({ signals: { findUnique } }))).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("reads only externalId and rawData when the parent lacks them", async () => {
    const findUnique = vi.fn(async () => ({ externalId: "acled:SDN1", rawData: { geo_precision: 1 } }));
    expect(await resolve({ id: "s1" }, {}, ctx({ signals: { findUnique } }))).toBe(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "s1" },
      select: { externalId: true, rawData: true },
    });
  });
});

describe("acledCoordinate", () => {
  it("returns ACLED's latitude and longitude, number or decimal string", () => {
    expect(acledCoordinate("acled:SDN1", { latitude: "12.0489", longitude: 24.88 }, "latitude")).toBe(12.0489);
    expect(acledCoordinate("acled:SDN1", { latitude: "12.0489", longitude: 24.88 }, "longitude")).toBe(24.88);
    expect(acledCoordinate("acled:SDN1", { longitude: "-3.5" }, "longitude")).toBe(-3.5);
  });

  it("returns null for another source, a missing, malformed or out-of-range value", () => {
    expect(acledCoordinate("dataminr:1", { latitude: 12 }, "latitude")).toBeNull();
    expect(acledCoordinate("acled:SDN1", {}, "latitude")).toBeNull();
    expect(acledCoordinate("acled:SDN1", { latitude: "" }, "latitude")).toBeNull();
    expect(acledCoordinate("acled:SDN1", { latitude: true }, "latitude")).toBeNull();
    expect(acledCoordinate("acled:SDN1", { latitude: "12,5" }, "latitude")).toBeNull();
    expect(acledCoordinate("acled:SDN1", { latitude: 91 }, "latitude")).toBeNull();
    expect(acledCoordinate("acled:SDN1", { longitude: 181 }, "longitude")).toBeNull();
  });
});

describe("Signal.sourceLatitude / sourceLongitude", () => {
  it("read a loaded parent without a query", async () => {
    const findUnique = vi.fn();
    const parent = { id: "s1", externalId: "acled:SDN1", rawData: { latitude: "12.5", longitude: "24.9" } };
    const c = ctx({ signals: { findUnique } });
    expect(await signalResolvers.Signal.sourceLatitude(parent, {}, c)).toBe(12.5);
    expect(await signalResolvers.Signal.sourceLongitude(parent, {}, c)).toBe(24.9);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("return null for a non-ACLED parent without a query", async () => {
    const findUnique = vi.fn();
    const parent = { id: "s1", externalId: "dataminr:1", rawData: { latitude: 12 } };
    expect(await signalResolvers.Signal.sourceLatitude(parent, {}, ctx({ signals: { findUnique } }))).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
