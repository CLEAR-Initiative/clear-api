/**
 * ADR-0006 tiered merge in `searchKnowledgebase` — DB-free. `$queryRawUnsafe`
 * is stubbed to return canned rows keyed off the SQL (which table / retriever),
 * and `embedQuery` is mocked so no embedding provider is hit. Covers the two
 * modes: FRAME (report band + quota-bounded incident band, no floor) and
 * TOPICAL (semantic interleave with the incident similarity floor).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/embedding-client.js", () => ({
  embedQuery: vi.fn().mockResolvedValue(new Array(1024).fill(0.01)),
  loadEmbeddingConfig: vi.fn().mockReturnValue({ provider: "voyage", model: "voyage-3-large" }),
  EMBEDDING_DIMENSIONS: 1024,
  vectorLiteral: (v: number[]) => `[${v.join(",")}]`,
}));

import { knowledgebaseResolvers } from "../../src/resolvers/knowledgebase.resolver.js";
import type { Context } from "../../src/context.js";

const search = knowledgebaseResolvers.Query.searchKnowledgebase;

function row(id: string, tier: "report" | "incident", extra: Record<string, unknown> = {}) {
  return {
    id, reportId: tier === "incident" ? `event:${id}` : id,
    reportTitle: `${tier} ${id}`, sourceUrl: "http://x", publishedAt: new Date("2026-09-20"),
    pageStart: 0, pageEnd: 0, chunkText: `${tier} text ${id}`,
    locationIds: ["sudan"], eventTypes: ["conflict"], needSectors: [],
    figureS3Key: null, figureKind: null, tier, _severity: null, _startedAt: null,
    ...extra,
  };
}

/** Route the raw SQL to canned rows by (table, retriever). */
function makeQueryRawUnsafe(rows: {
  reportDense?: unknown[]; reportSparse?: unknown[]; reportRecency?: unknown[];
  incidentDense?: unknown[]; incidentSparse?: unknown[]; incidentRecency?: unknown[];
}) {
  return vi.fn().mockImplementation((sql: string) => {
    const isIncident = sql.includes('"events_index"');
    if (sql.includes("<=>")) return Promise.resolve((isIncident ? rows.incidentDense : rows.reportDense) ?? []);
    if (sql.includes("plainto_tsquery")) return Promise.resolve((isIncident ? rows.incidentSparse : rows.reportSparse) ?? []);
    // recency path (frame mode)
    return Promise.resolve((isIncident ? rows.incidentRecency : rows.reportRecency) ?? []);
  });
}

function ctx(queryRawUnsafe: ReturnType<typeof vi.fn>): Context {
  return {
    prisma: { $queryRawUnsafe: queryRawUnsafe } as unknown as Context["prisma"],
    user: { id: "u", role: "viewer", isActive: true } as unknown,
    session: {}, authMethod: "session",
  } as unknown as Context;
}

const FILTERS = { currentEmbeddingModelOnly: false, countryLocationId: "sudan" };

describe("searchKnowledgebase — FRAME mode (ADR-0006)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a report band + a quota-bounded incident band, both tier-labelled, for a frame-only query", async () => {
    const q = makeQueryRawUnsafe({
      reportRecency: [row("r1", "report"), row("r2", "report"), row("r3", "report"), row("r4", "report")],
      incidentRecency: [row("e1", "incident"), row("e2", "incident")],
    });
    const out = await search(null, { query: "", filters: FILTERS, limit: 6, mode: "FRAME" }, ctx(q));

    const tiers = out.map((h) => h.tier);
    expect(tiers.filter((t) => t === "incident").length).toBe(2); // quota round(6*0.4)=2
    expect(tiers.filter((t) => t === "report").length).toBe(4);   // budget 6-2
    // bands: reports first, then incidents
    expect(out.slice(0, 4).every((h) => h.tier === "report")).toBe(true);
    expect(out.slice(4).every((h) => h.tier === "incident")).toBe(true);
    // incident hit maps event id → event:<id>
    expect(out.find((h) => h.tier === "incident")!.reportId).toMatch(/^event:/);
  });

  it("gives unused incident-quota slots back to reports when few incidents exist", async () => {
    const q = makeQueryRawUnsafe({
      reportRecency: Array.from({ length: 6 }, (_, i) => row(`r${i}`, "report")),
      incidentRecency: [], // none in frame
    });
    const out = await search(null, { query: "", filters: FILTERS, limit: 6, mode: "FRAME" }, ctx(q));
    expect(out.length).toBe(6);
    expect(out.every((h) => h.tier === "report")).toBe(true);
  });

  it("rejects an empty query with no frame", async () => {
    await expect(
      search(null, { query: "  ", filters: { currentEmbeddingModelOnly: false }, mode: "FRAME" }, ctx(makeQueryRawUnsafe({}))),
    ).rejects.toThrow(/must not be empty/);
  });
});

describe("searchKnowledgebase — TOPICAL mode (ADR-0006)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gates incidents below the similarity floor, keeps strong ones, and labels tiers", async () => {
    const q = makeQueryRawUnsafe({
      reportDense: [row("r1", "report", { _dist: 0.1 })],
      incidentDense: [
        row("e_strong", "incident", { _dist: 0.2 }), // sim 0.8 — clears floor 0.35
        row("e_weak", "incident", { _dist: 0.8 }),   // sim 0.2 — gated out
      ],
    });
    const out = await search(null, { query: "cholera outbreak", filters: FILTERS, limit: 10, mode: "TOPICAL" }, ctx(q));

    const ids = out.map((h) => h.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("e_strong");
    expect(ids).not.toContain("e_weak"); // below the floor
    expect(out.find((h) => h.id === "r1")!.tier).toBe("report");
    expect(out.find((h) => h.id === "e_strong")!.tier).toBe("incident");
  });

  it("report-only tier skips the incident index entirely", async () => {
    const q = makeQueryRawUnsafe({ reportDense: [row("r1", "report", { _dist: 0.1 })] });
    const out = await search(null, { query: "floods", filters: FILTERS, tiers: ["report"], mode: "TOPICAL" }, ctx(q));
    expect(out.every((h) => h.tier === "report")).toBe(true);
    // no events_index query issued
    const calls = q.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('"events_index"'))).toBe(false);
  });
});

describe("searchKnowledgebase — ADR-0006 review fixes (E1/E2/E7)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("E1: an incident-only FRAME query fills the whole budget (not just the 40% quota)", async () => {
    const q = makeQueryRawUnsafe({
      incidentRecency: Array.from({ length: 6 }, (_, i) => row(`e${i}`, "incident")),
    });
    const out = await search(null, { query: "", filters: FILTERS, limit: 6, tiers: ["incident"], mode: "FRAME" }, ctx(q));
    expect(out.length).toBe(6); // not round(6*0.4)=2
    expect(out.every((h) => h.tier === "incident")).toBe(true);
  });

  it("E2: a sparse-only incident (no dense sim) survives the TOPICAL floor", async () => {
    const q = makeQueryRawUnsafe({
      incidentDense: [],                                   // not in the dense window
      incidentSparse: [row("e_lexical", "incident")],      // exact keyword match, no _dist
    });
    const out = await search(null, { query: "cholera", filters: FILTERS, tiers: ["incident"], mode: "TOPICAL" }, ctx(q));
    expect(out.map((h) => h.id)).toContain("e_lexical"); // kept, not floored out as sim=0
  });

  it("E7: recency shapes incident order — a fresher incident outranks an older equally-similar one", async () => {
    const q = makeQueryRawUnsafe({
      incidentDense: [
        row("e_old", "incident", { _dist: 0.2, _startedAt: new Date("2020-01-01") }),   // dense rank 0
        row("e_recent", "incident", { _dist: 0.2, _startedAt: new Date() }),            // dense rank 1
      ],
    });
    const out = await search(null, { query: "airstrike", filters: FILTERS, tiers: ["incident"], mode: "TOPICAL" }, ctx(q));
    expect(out[0].id).toBe("e_recent"); // recency bonus overtakes the one-rank gap
  });
});
