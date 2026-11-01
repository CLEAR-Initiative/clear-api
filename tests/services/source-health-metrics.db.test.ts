/**
 * Source health against the real schema (ADR-0017): which Signals count as
 * a delivery (ingested, not retracted, not dummy), the lookback before the
 * range, and the per-day judgement that comes out. The expected-source list
 * is the caller's here, so the test keeps to its own sources; run with
 * `bun run test:db`.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { EXPECTED_CADENCE_DAYS, computeSourceHealthMetrics, fetchSourceDeliveryRows, summariseSourceHealth } from "../../src/services/source-health-metrics.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `sh-db-${Date.now()}`;
const USER = `${RUN}-user`;
const DAILY = `${RUN}-daily`;
const WEEKLY = `${RUN}-weekly`;
const OTHER = `${RUN}-other`;
const DAY_MS = 24 * 60 * 60 * 1000;
const sourceIds: Record<string, string> = {};
let n = 0;

const at = (iso: string) => new Date(iso);
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / DAY_MS);

async function delivery(source: string, collectedAt: string, opts: { history?: boolean; manual?: boolean; retracted?: boolean; isDummy?: boolean } = {}) {
  await prisma.signals.create({
    data: {
      sourceId: sourceIds[source]!,
      externalId: `${RUN}-${n++}`,
      rawData: opts.manual ? { manual: true, createdBy: USER } : {},
      publishedAt: at(collectedAt),
      collectedAt: at(collectedAt),
      submittedById: opts.history ? USER : null,
      retracted: opts.retracted ?? false,
      isDummy: opts.isDummy ?? false,
    },
  });
}

describeIfDb("source health against the real schema", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, name: "Analyst", email: `${RUN}@example.org`, role: "analyst" } });
    for (const name of [DAILY, WEEKLY, OTHER]) {
      const source = await prisma.dataSources.create({ data: { name, type: "test" } });
      sourceIds[name] = source.id;
    }
  });

  afterAll(async () => {
    await prisma.signals.deleteMany({ where: { sourceId: { in: Object.values(sourceIds) } } });
    await prisma.dataSources.deleteMany({ where: { id: { in: Object.values(sourceIds) } } });
    await prisma.user.deleteMany({ where: { id: USER } });
  });

  it("counts a day delivered only on an ingested Signal, looks back one cadence, and judges each day", async () => {
    // The daily feed: a real delivery on 12, 17 and 18 October; on 13 to 16 only
    // Signals that are not ingested (retracted, filed by hand, an accepted web
    // case, dummy), which do not count.
    await delivery(DAILY, "2026-10-12T09:00:00Z");
    await delivery(DAILY, "2026-10-13T09:00:00Z", { retracted: true });
    await delivery(DAILY, "2026-10-14T09:00:00Z", { manual: true });
    await delivery(DAILY, "2026-10-15T09:00:00Z", { history: true });
    await delivery(DAILY, "2026-10-16T09:00:00Z", { isDummy: true });
    await delivery(DAILY, "2026-10-17T09:00:00Z");
    await delivery(DAILY, "2026-10-18T23:30:00Z");
    // Just after the range's last day ends: not read, even though it is within the lookback of nothing.
    await delivery(DAILY, "2026-10-19T00:30:00Z");
    // A source that is not asked for delivers every day and must not appear.
    await delivery(OTHER, "2026-10-14T09:00:00Z");
    // The weekly feed: 5 October is before the lookback and must not be read;
    // 7 October covers 12 and 13; 16 October covers 16 to 18.
    await delivery(WEEKLY, "2026-10-05T09:00:00Z");
    await delivery(WEEKLY, "2026-10-07T09:00:00Z");
    await delivery(WEEKLY, "2026-10-16T09:00:00Z");

    const range = { from: at("2026-10-12T00:00:00Z"), to: at("2026-10-18T23:59:59.999Z") };
    const sources = [
      { source: DAILY, cadenceDays: 1 },
      { source: WEEKLY, cadenceDays: 7 },
    ];
    const rows = await fetchSourceDeliveryRows(prisma, range, sources);
    expect(rows.map((r) => [r.source, r.day]).sort()).toEqual(
      [
        [DAILY, day("2026-10-12")],
        [DAILY, day("2026-10-17")],
        [DAILY, day("2026-10-18")],
        [WEEKLY, day("2026-10-07")],
        [WEEKLY, day("2026-10-16")],
      ].sort(),
    );

    const m = summariseSourceHealth(rows, range, sources, "DAY", at("2026-10-19T06:00:00Z"));
    expect(m.bySource).toEqual([
      { source: DAILY, cadenceDays: 1, onScheduleDays: 3, days: 7 },
      { source: WEEKLY, cadenceDays: 7, onScheduleDays: 5, days: 7 },
    ]);
    expect(m.series.filter((r) => r.source === DAILY).map((r) => r.onScheduleDays)).toEqual([1, 0, 0, 0, 0, 1, 1]);
    expect(m.series.filter((r) => r.source === WEEKLY).map((r) => r.onScheduleDays)).toEqual([1, 1, 0, 0, 1, 1, 1]);

    // The service end to end reads the expected feeds, none of which exists here: every measured day is late.
    const whole = await computeSourceHealthMetrics(prisma, { from: range.from, to: range.to, granularity: "WEEK" }, at("2026-10-19T06:00:00Z"));
    expect(whole.bySource.map((s) => [s.source, s.onScheduleDays, s.days])).toEqual(Object.keys(EXPECTED_CADENCE_DAYS).map((source) => [source, 0, 7]));
  });
});
