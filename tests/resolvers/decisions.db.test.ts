/**
 * The decisions feed (ADR-0024, #1287) against the real schema: records after
 * a sequence number, in sequence order, for the pipeline and admins only.
 *
 * Self-seeding; runs against an empty scratch database:
 * `bun run test:db tests/resolvers/decisions.db.test.ts`.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { decisionResolvers } from "../../src/resolvers/decision.resolver.js";
import type { Context } from "../../src/context.js";
import { describeIfDb } from "../helpers/db.js";

const { decisions } = decisionResolvers.Query;

const RUN = `decisions-db-${Date.now()}`;
const PERSON_ID = `${RUN}-person`;

const ctx = (role: string, authMethod = "api-key"): Context =>
  ({ prisma, user: { id: `${RUN}-${role}`, role }, session: null, authMethod, locale: "en" }) as unknown as Context;

const ids: string[] = [];

/** A record written straight to the table: this suite tests the reader. */
async function record(subjectId: string) {
  const row = await prisma.decisionRecords.create({
    data: {
      decisionType: "SIGNAL_SEVERITY_SET",
      subjectType: "signal",
      subjectId,
      decidedById: PERSON_ID,
      payload: { severity: 4 },
      definitionVersion: "decision-records-v1",
    },
  });
  ids.push(row.id);
  return row;
}

describeIfDb("the decisions feed against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: PERSON_ID, name: PERSON_ID, email: `${PERSON_ID}@example.test` } });
  });

  afterAll(async () => {
    // Test cleanup only: no application path deletes a record.
    await prisma.decisionRecords.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: PERSON_ID } });
  });

  it("returns the records after a sequence number, in order, with the last sequence", async () => {
    const [a, b, c] = [await record(`${RUN}-a`), await record(`${RUN}-b`), await record(`${RUN}-c`)];
    const page = await decisions(null, { sinceSequence: Number(a.sequence) }, ctx("pipeline"));
    const mine = page.items.filter((r) => ids.includes(r.id));
    expect(mine.map((r) => r.id)).toEqual([b.id, c.id]);
    expect(page.lastSequence).toBe(Number(page.items.at(-1)!.sequence));
    expect(page.lastSequence).toBeGreaterThanOrEqual(Number(c.sequence));
  });

  it("returns an empty page with the same cursor when nothing is newer", async () => {
    const last = await record(`${RUN}-last`);
    const page = await decisions(null, { sinceSequence: Number(last.sequence) }, ctx("admin"));
    expect(page).toEqual({ items: [], lastSequence: Number(last.sequence) });
  });

  it("reads past a gap a rolled-back transaction left", async () => {
    const before = await record(`${RUN}-before-gap`);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.decisionRecords.create({
          data: { decisionType: "SIGNAL_SEVERITY_SET", subjectType: "signal", subjectId: `${RUN}-rolled-back`, payload: {}, definitionVersion: "v" },
        });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const after = await record(`${RUN}-after-gap`);
    expect(Number(after.sequence) - Number(before.sequence)).toBeGreaterThan(1);

    const page = await decisions(null, { sinceSequence: Number(before.sequence) }, ctx("pipeline"));
    expect(page.items.map((r) => r.id)).toContain(after.id);
  });

  it("refuses a caller that is not the pipeline or an admin", async () => {
    for (const role of ["member", "worker", "agent"]) {
      await expect(decisions(null, { sinceSequence: 0 }, ctx(role, "session"))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    }
    await expect(decisions(null, { sinceSequence: -1 }, ctx("admin"))).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });
});
