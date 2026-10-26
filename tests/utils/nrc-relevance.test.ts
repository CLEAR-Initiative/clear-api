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
  nrcIrrelevantGlideCodes,
  nrcRelevantGlideCodes,
  chunkIsAllNrcIrrelevant,
  eventIsAllNrcIrrelevant,
} from "../../src/utils/nrc-relevance.js";

type DtRow = { level2: string | null; nrcRelevant: boolean; glideNumber?: string };

/**
 * Minimal `disasterTypes` stub for the three calls the helpers make: `count`
 * (filtered by glideNumber in [...] AND nrcRelevant) and `findMany` (level2 or
 * glideNumber, honouring an optional nrcRelevant filter). `count` compares the
 * `in` codes verbatim — the helper is responsible for lowercasing them first
 * (the seed stores lowercase glide codes).
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any = {}) => {
        const wantRelevant: boolean | undefined = where?.nrcRelevant;
        return rows
          .filter((r) => wantRelevant === undefined || r.nrcRelevant === wantRelevant)
          .map((r) => ({ level2: r.level2, glideNumber: r.glideNumber ?? null, nrcRelevant: r.nrcRelevant }));
      },
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

  it("matches codes case-insensitively (events may store uppercase glide codes)", async () => {
    // "EQ" must resolve to the seeded lowercase "eq" (relevant), not be rejected.
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), ["EQ"])).toBe(true);
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), [" Eq "])).toBe(true);
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), ["PA", "FR"])).toBe(false);
  });
});

describe("nrcIrrelevantGlideCodes", () => {
  it("returns lowercased glide codes whose type is NOT relevant", async () => {
    const set = await nrcIrrelevantGlideCodes(fakePrisma(ROWS));
    expect([...set].sort()).toEqual(["fr", "ot", "pa", "pp"]);
  });

  it("does not include relevant codes", async () => {
    const set = await nrcIrrelevantGlideCodes(fakePrisma(ROWS));
    expect(set.has("eq")).toBe(false);
    expect(set.has("ac")).toBe(false);
  });

  it("drives incident demotion via chunkIsAllNrcIrrelevant on glide codes", async () => {
    const set = await nrcIrrelevantGlideCodes(fakePrisma(ROWS));
    expect(chunkIsAllNrcIrrelevant(["fr"], set)).toBe(true);          // all-irrelevant incident
    expect(chunkIsAllNrcIrrelevant(["fr", "eq"], set)).toBe(false);   // one relevant code
    expect(chunkIsAllNrcIrrelevant(["FR"], set)).toBe(true);          // case-normalized
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

describe("nrcRelevantGlideCodes", () => {
  it("returns the lowercased glide codes tagged nrc_relevant = true", async () => {
    const set = await nrcRelevantGlideCodes(fakePrisma(ROWS));
    expect([...set].sort()).toEqual(["ac", "eq"]);
  });

  it("lowercases / trims and drops blank codes", async () => {
    const rows: DtRow[] = [
      { glideNumber: " FL ", level2: "flood", nrcRelevant: true },
      { glideNumber: "", level2: "x", nrcRelevant: true },
      { glideNumber: "ot", level2: "other", nrcRelevant: false },
    ];
    expect([...(await nrcRelevantGlideCodes(fakePrisma(rows)))]).toEqual(["fl"]);
  });
});

describe("eventIsAllNrcIrrelevant", () => {
  const relevant = new Set(["eq", "ac"]);

  it("is true when none of the event's types is relevant", () => {
    expect(eventIsAllNrcIrrelevant(["ot"], relevant)).toBe(true);
    expect(eventIsAllNrcIrrelevant(["ot", "fr"], relevant)).toBe(true);
  });

  it("is false when at least one type is relevant (mixed types still alert)", () => {
    expect(eventIsAllNrcIrrelevant(["ot", "eq"], relevant)).toBe(false);
  });

  it("is false for empty / null / undefined (no NRC signal → not skipped)", () => {
    expect(eventIsAllNrcIrrelevant([], relevant)).toBe(false);
    expect(eventIsAllNrcIrrelevant(null, relevant)).toBe(false);
    expect(eventIsAllNrcIrrelevant(undefined, relevant)).toBe(false);
  });

  it("treats a code unknown to disaster_types as irrelevant, like anyTypeNrcRelevant", async () => {
    expect(eventIsAllNrcIrrelevant(["zz"], relevant)).toBe(true);
    expect(await anyTypeNrcRelevant(fakePrisma(ROWS), ["zz"])).toBe(false);
  });

  it("matches case-insensitively (events.types may be upper-case)", () => {
    expect(eventIsAllNrcIrrelevant(["OT"], relevant)).toBe(true);
    expect(eventIsAllNrcIrrelevant(["OT", " Eq "], relevant)).toBe(false);
  });

  it("agrees with anyTypeNrcRelevant on every shape (the two gates must never diverge)", async () => {
    const prisma = fakePrisma(ROWS);
    const set = await nrcRelevantGlideCodes(prisma);
    for (const types of [["ot"], ["ot", "eq"], ["EQ"], [], ["zz"], ["pa", "fr"]]) {
      const skipByCreateAlert = types.length > 0 && !(await anyTypeNrcRelevant(prisma, types));
      expect(eventIsAllNrcIrrelevant(types, set)).toBe(skipByCreateAlert);
    }
  });
});
