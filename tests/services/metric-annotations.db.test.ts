/**
 * Metric annotations against the real schema (ADR-0016): the table and its
 * array column, the range and metric filters, the ordering, and delete.
 * Self-seeding and scoped to its own labels; run with `bun run test:db`.
 */
import { afterAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { createMetricAnnotation, deleteMetricAnnotation, listMetricAnnotations } from "../../src/services/metric-annotations.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `ma-db-${Date.now()}`;
const ADMIN = `${RUN}-admin`;

describeIfDb("metric annotations (db)", () => {
  afterAll(async () => {
    await prisma.metricAnnotations.deleteMany({ where: { label: { startsWith: RUN } } });
  });

  it("stores, lists by range and metric oldest first, and deletes", async () => {
    const geocode = await createMetricAnnotation(
      prisma,
      { at: "2026-10-29T18:33:00Z", label: `${RUN} geocode in area`, metricKeys: ["DISTRICT_OR_FINER"], link: "https://example.org/pr/140" },
      ADMIN,
    );
    const prompt = await createMetricAnnotation(
      prisma,
      { at: "2026-10-31T13:13:00Z", label: `${RUN} prompt v3`, description: "incident site over impact area", metricKeys: ["DISTRICT_OR_FINER", "DETECTED_SAME_DAY"] },
      ADMIN,
    );
    const ttdOnly = await createMetricAnnotation(prisma, { at: "2026-10-30T09:00:00Z", label: `${RUN} ttd only`, metricKeys: ["DETECTED_BY_NEXT_DAY"] }, ADMIN);
    expect(geocode).toMatchObject({ label: `${RUN} geocode in area`, metricKeys: ["DISTRICT_OR_FINER"], createdById: ADMIN, description: null });
    expect(prompt.metricKeys).toEqual(["DISTRICT_OR_FINER", "DETECTED_SAME_DAY"]);

    const mine = (rows: Array<{ label: string }>) => rows.filter((row) => row.label.startsWith(RUN)).map((row) => row.label);
    expect(mine(await listMetricAnnotations(prisma, { metric: "DISTRICT_OR_FINER" }))).toEqual([`${RUN} geocode in area`, `${RUN} prompt v3`]);
    expect(mine(await listMetricAnnotations(prisma, { metric: "DETECTED_BY_NEXT_DAY" }))).toEqual([`${RUN} ttd only`]);
    expect(mine(await listMetricAnnotations(prisma, { from: "2026-10-30T00:00:00Z", to: "2026-10-31T23:59:59.999Z" }))).toEqual([
      `${RUN} ttd only`,
      `${RUN} prompt v3`,
    ]);
    expect(mine(await listMetricAnnotations(prisma, { from: "2026-11-01T00:00:00Z", metric: "DISTRICT_OR_FINER" }))).toEqual([]);

    expect((await deleteMetricAnnotation(prisma, ttdOnly.id)).id).toBe(ttdOnly.id);
    expect(mine(await listMetricAnnotations(prisma))).toEqual([`${RUN} geocode in area`, `${RUN} prompt v3`]);
    await expect(deleteMetricAnnotation(prisma, ttdOnly.id)).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
