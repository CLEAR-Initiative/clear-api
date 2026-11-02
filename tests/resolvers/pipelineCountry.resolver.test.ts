/**
 * Tests for the pipelineCountries query — the interim country-list config the
 * scheduled publisher reads. Pure resolver (no DB), so it always runs.
 */

import { describe, it, expect } from "vitest";
import { GraphQLError } from "graphql";

import {
  pipelineCountryResolvers,
  resolvePipelineIso3,
  resolvePipelineIso3ByPcode,
} from "../../src/resolvers/pipelineCountry.resolver.js";
import type { Context } from "../../src/context.js";

function ctx(user: { id: string; role: string } | null): Context {
  return {
    prisma: {} as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  };
}

describe("pipelineCountries", () => {
  it("returns Sudan and Afghanistan, each with a 4-element bbox", () => {
    const result = pipelineCountryResolvers.Query.pipelineCountries(
      null,
      {},
      ctx({ id: "u", role: "pipeline" }),
    );
    const names = result.map((c) => c.name);
    expect(names).toEqual(["Sudan", "Afghanistan", "Venezuela"]);
    for (const country of result) {
      expect(country.bbox).toHaveLength(4);
      expect(country.bbox.every((n) => typeof n === "number")).toBe(true);
      // bbox order is [minLng, minLat, maxLng, maxLat].
      const [minLng, minLat, maxLng, maxLat] = country.bbox;
      expect(minLng).toBeLessThan(maxLng);
      expect(minLat).toBeLessThan(maxLat);
    }
  });

  it("rejects an unauthenticated request", () => {
    expect(() => pipelineCountryResolvers.Query.pipelineCountries(null, {}, ctx(null))).toThrow(
      GraphQLError,
    );
  });

  it("returns copies — a consumer cannot mutate the shared config", () => {
    const first = pipelineCountryResolvers.Query.pipelineCountries(
      null,
      {},
      ctx({ id: "u", role: "admin" }),
    );
    first[0].bbox[0] = 999;
    first[0].name = "Mutated";
    const second = pipelineCountryResolvers.Query.pipelineCountries(
      null,
      {},
      ctx({ id: "u", role: "admin" }),
    );
    expect(second[0].name).toBe("Sudan");
    expect(second[0].bbox[0]).toBe(21.8);
  });
});

describe("resolvePipelineIso3", () => {
  it("resolves a pipeline iso3 to the lowercase partition key, case-insensitively", () => {
    expect(resolvePipelineIso3("SDN")).toBe("sdn");
    expect(resolvePipelineIso3("sdn")).toBe("sdn");
    expect(resolvePipelineIso3("  Afg ")).toBe("afg");
  });

  it("returns null for a non-pipeline or missing country", () => {
    expect(resolvePipelineIso3("USA")).toBeNull(); // not a pipeline country
    expect(resolvePipelineIso3("SD")).toBeNull(); // pcode, not iso3
    expect(resolvePipelineIso3("")).toBeNull();
    expect(resolvePipelineIso3(null)).toBeNull();
    expect(resolvePipelineIso3(undefined)).toBeNull();
  });
});

describe("resolvePipelineIso3ByPcode", () => {
  it("maps an admin-0 pcode (case-insensitive) to the lowercase iso3", () => {
    expect(resolvePipelineIso3ByPcode("SD")).toBe("sdn");
    expect(resolvePipelineIso3ByPcode("af")).toBe("afg");
    expect(resolvePipelineIso3ByPcode(" VE ")).toBe("ven");
  });

  it("returns null for an unknown or missing pcode", () => {
    expect(resolvePipelineIso3ByPcode("US")).toBeNull();
    expect(resolvePipelineIso3ByPcode("SDN")).toBeNull(); // iso3, not pcode
    expect(resolvePipelineIso3ByPcode(null)).toBeNull();
    expect(resolvePipelineIso3ByPcode(undefined)).toBeNull();
  });
});
