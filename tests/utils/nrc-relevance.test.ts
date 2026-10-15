/**
 * Unit tests for the NRC-relevance helpers.
 *
 * `disaster_types.nrc_relevant` is tagged per glide code (level_3). These
 * helpers translate that into the two signals the resolvers consume:
 *   - `anyTypeNrcRelevant` — the alert-raise gate (event `types` are glide codes)
 *   - `nrcIrrelevantLevel2` / `chunkIsAllNrcIrrelevant` — the KB demotion signal
 *     (chunk `event_types` are level_2 slugs).
 *
 * Prisma is stubbed; these are pure-logic tests with no database.
 */
import { describe, it, expect } from "vitest";
import {
  anyTypeNrcRelevant,
  nrcIrrelevantLevel2,
  chunkIsAllNrcIrrelevant,
} from "../../src/utils/nrc-relevance.js";

type DtRow = { level2: string | null; nrcRelevant: boolean; glideNumber?: string };

/**
 * Minimal `disasterTypes` stub with just the two calls the helpers make:
 * `count` (filtered by glideNumber in [...] AND nrcRelevant) and `findMany`
 * (selecting level2 + nrcRelevant).
 */
function fakePrisma(rows: DtRow[]) {
  return {
    disasterTypes: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      count: async ({ where }: any) => {
        const codes: string[] = where?.glideNumber?.in ?? [];
        const wantRelevant: boolean | undefined = where?.nrcRelevant;
        return rows.filter(
          (r) =>
            r.glideNumber != null &&
            codes.includes(r.glideNumber) &&
            (wantRelevant === undefined || r.nrcRelevant === wantRelevant),
        ).length;
      },
      findMany: async () =>
        rows.map((r) => ({ level2: r.level2, nrcRelevant: r.nrcRelevant })),
    },
  } as never;
}

const ROWS: DtRow[] = [
  { glideNumber: "eq", level2: "earthquake", nrcRelevant: true },
  { glideNumber: "ac", level2: "conflict", nrcRelevant: true },
  { glideNumber: "pa", level2: "fire", nrcRelevant: false },
  { glideNumber: "fr", level2: "fire", nrcRelevant: false },
  { glideNumber: "ot", level2: "other", nrcRelevant: false },
  // Conflict group also holds an irrelevant code, but the group is still
  // relevant because at least one member is relevant.
  { glideNumber: "pp", level2: "conflict", nrcRelevant: false },
];

describe("anyTypeNrcRelevant", () => {
  it("is true when at least one glide code is relevant", async () => {
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), ["pa", "eq"])).toBe(true);
  });

  it("is false when every glide code is irrelevant", async () => {
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), ["pa", "fr", "ot"])).toBe(false);
  });

  it("is false for empty / null / undefined types (no NRC signal)", async () => {
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), [])).toBe(false);
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), null)).toBe(false);
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), undefined)).toBe(false);
  });

  it("is false for unknown codes", async () => {
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), ["zz"])).toBe(false);
  });
});

describe("nrcIrrelevantLevel2", () => {
  it("returns only groups with NO relevant member", async () => {
    const set = await nrcIrrelevantLevel2(fakePrisma(ROWS));
    expect([...set].sort()).toEqual(["fire", "other"]);
  });

  it("does not include a mixed group that has a relevant member", async () => {
    const set = await nrcIrrelevantLevel2(fakePrisma(ROWS));
    expect(set.has("conflict")).toBe(false);
    expect(set.has("earthquake")).toBe(false);
  });

  it("normalizes case / whitespace and ignores blank level_2", async () => {
    const rows: DtRow[] = [
      { level2: "  Fire ", nrcRelevant: false },
      { level2: "FIRE", nrcRelevant: false },
      { level2: "", nrcRelevant: false },
      { level2: null, nrcRelevant: false },
    ];
    const set = await nrcIrrelevantLevel2(fakePrisma(rows));
    expect([...set]).toEqual(["fire"]);
  });
});

describe("chunkIsAllNrcIrrelevant", () => {
  const irrelevant = new Set(["fire", "other"]);

  it("is true when every event_type is in the irrelevant set", () => {
    expect(chunkIsAllNrcIrrelevant(["fire", "other"], irrelevant)).toBe(true);
  });

  it("is false when any event_type is relevant", () => {
    expect(chunkIsAllNrcIrrelevant(["fire", "conflict"], irrelevant)).toBe(false);
  });

  it("is false for empty / null / undefined (no signal to demote on)", () => {
    expect(chunkIsAllNrcIrrelevant([], irrelevant)).toBe(false);
    expect(chunkIsAllNrcIrrelevant(null, irrelevant)).toBe(false);
    expect(chunkIsAllNrcIrrelevant(undefined, irrelevant)).toBe(false);
  });

  it("normalizes case / whitespace before matching", () => {
    expect(chunkIsAllNrcIrrelevant([" Fire ", "OTHER"], irrelevant)).toBe(true);
  });
});
