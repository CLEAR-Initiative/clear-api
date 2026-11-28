/**
 * Unit tests (mocked Prisma) for Signal.sourcePrecision: ACLED's geo_precision
 * read from the stored payload, and nothing else of the payload.
 */

import { describe, it, expect, vi } from "vitest";
import { acledGeoPrecision, signalResolvers } from "../../src/resolvers/signal.resolver.js";
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
