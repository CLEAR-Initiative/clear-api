import { describe, it, expect } from "vitest";
import { buildFilterClause } from "../../src/resolvers/knowledgebase.resolver.js";

/**
 * `countryLocationId` scopes a search to one country's subtree. Chunk
 * `location_ids` are resolved to leaf admin ids, so the filter must expand the
 * A0 to {itself + descendants} via the locations tree's `ancestor_ids`. These
 * assert the SQL + param wiring (currentEmbeddingModelOnly:false skips the env
 * lookup that branch would otherwise do).
 */
describe("buildFilterClause — countryLocationId", () => {
  it("expands the A0 to its subtree via ancestor_ids and overlaps location_ids", () => {
    const params: unknown[] = [];
    const where = buildFilterClause(
      { currentEmbeddingModelOnly: false, countryLocationId: "sudan-a0" },
      params,
    );
    expect(where).toContain(`"location_ids" && ARRAY(SELECT "id" FROM "locations"`);
    expect(where).toContain(`"ancestor_ids" @> ARRAY[$1]::text[]`);
    expect(where).toContain(`"id" = $1`);
    expect(params).toEqual(["sudan-a0"]);
  });

  it("adds nothing when countryLocationId is absent", () => {
    const params: unknown[] = [];
    const where = buildFilterClause({ currentEmbeddingModelOnly: false }, params);
    expect(where).not.toContain("ancestor_ids");
    expect(params).toEqual([]);
  });

  it("composes with an explicit locationIds filter (both conditions present)", () => {
    const params: unknown[] = [];
    const where = buildFilterClause(
      { currentEmbeddingModelOnly: false, locationIds: ["khartoum"], countryLocationId: "sudan-a0" },
      params,
    );
    // locationIds pushed first ($1), then countryLocationId ($2)
    expect(where).toContain(`"location_ids" && $1::text[]`);
    expect(where).toContain(`"ancestor_ids" @> ARRAY[$2]::text[]`);
    expect(params).toEqual([["khartoum"], "sudan-a0"]);
  });
});
