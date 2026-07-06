/**
 * Tests for the pipelineCountries query — the interim country-list config the
 * scheduled publisher reads. Pure resolver (no DB), so it always runs.
 */

import { describe, it, expect } from "vitest";
import { GraphQLError } from "graphql";

import { pipelineCountryResolvers } from "../../src/resolvers/pipelineCountry.resolver.js";
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
