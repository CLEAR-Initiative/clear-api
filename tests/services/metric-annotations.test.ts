/**
 * Metric annotations (ADR-0016), DB-free: what the validator accepts and
 * refuses, how the list filter reaches Prisma, and the create and delete
 * paths with a mocked client.
 */
import { describe, expect, it, vi } from "vitest";
import { GraphQLError } from "graphql";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  MAX_LABEL_LENGTH,
  createMetricAnnotation,
  deleteMetricAnnotation,
  listMetricAnnotations,
  validateAnnotation,
} from "../../src/services/metric-annotations.js";

function expectBadInput(fn: () => unknown, message: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe("BAD_USER_INPUT");
    expect((err as GraphQLError).message).toMatch(message);
    return;
  }
  throw new Error("expected BAD_USER_INPUT");
}

const ROW = {
  id: "ann-1",
  at: new Date("2026-10-29T18:33:00Z"),
  label: "Geocoding inside the model's area",
  description: null,
  link: "https://github.com/CLEAR-Initiative/clear-pipeline/pull/140",
  metricKeys: ["DISTRICT_OR_FINER"],
  createdById: "admin-1",
  createdAt: new Date("2026-10-31T17:00:00Z"),
};

function prismaMock(overrides: Partial<Record<"findMany" | "findUnique" | "create" | "delete", unknown>> = {}) {
  const metricAnnotations = {
    findMany: vi.fn(async () => [ROW]),
    findUnique: vi.fn(async () => ROW),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data })),
    delete: vi.fn(async () => ROW),
    ...overrides,
  };
  return { prisma: { metricAnnotations } as unknown as PrismaClient, metricAnnotations };
}

describe("validateAnnotation", () => {
  it("trims, drops blanks and duplicate keys, and keeps a valid link", () => {
    expect(
      validateAnnotation({
        at: "2026-10-31T13:13:00Z",
        label: "  darfur24 located from text ",
        description: "  ",
        link: " https://github.com/CLEAR-Initiative/clear-pipeline/pull/151 ",
        metricKeys: ["DISTRICT_OR_FINER", " DISTRICT_OR_FINER", ""],
      }),
    ).toEqual({
      at: new Date("2026-10-31T13:13:00Z"),
      label: "darfur24 located from text",
      description: null,
      link: "https://github.com/CLEAR-Initiative/clear-pipeline/pull/151",
      metricKeys: ["DISTRICT_OR_FINER"],
    });
  });

  it("refuses a bad instant, an empty or long label, a non-http link, no keys and an unknown key", () => {
    const ok = { at: "2026-10-31T13:13:00Z", label: "x", metricKeys: ["DISTRICT_OR_FINER"] };
    expectBadInput(() => validateAnnotation({ ...ok, at: "yesterday" }), /`at`/);
    expectBadInput(() => validateAnnotation({ ...ok, label: "   " }), /`label` must not be empty/);
    expectBadInput(() => validateAnnotation({ ...ok, label: "x".repeat(MAX_LABEL_LENGTH + 1) }), /at most 120/);
    expectBadInput(() => validateAnnotation({ ...ok, link: "ftp://example.org" }), /`link` must be an http/);
    expectBadInput(() => validateAnnotation({ ...ok, link: "not a url" }), /`link` must be an http/);
    expectBadInput(() => validateAnnotation({ ...ok, metricKeys: [] }), /at least one metric/);
    expectBadInput(() => validateAnnotation({ ...ok, metricKeys: ["DISTRICT_OR_FINER", "NOPE"] }), /Unknown metric key: NOPE/);
  });
});

describe("listMetricAnnotations", () => {
  it("asks for the range and the metric, oldest first, and for everything with no filter", async () => {
    const { prisma, metricAnnotations } = prismaMock();
    await listMetricAnnotations(prisma, { from: "2026-10-26T00:00:00Z", to: "2026-11-01T23:59:59.999Z", metric: "DISTRICT_OR_FINER" });
    expect(metricAnnotations.findMany).toHaveBeenCalledWith({
      where: {
        at: { gte: new Date("2026-10-26T00:00:00Z"), lte: new Date("2026-11-01T23:59:59.999Z") },
        metricKeys: { has: "DISTRICT_OR_FINER" },
      },
      orderBy: [{ at: "asc" }, { createdAt: "asc" }],
    });
    await listMetricAnnotations(prisma);
    expect(metricAnnotations.findMany).toHaveBeenLastCalledWith({ where: {}, orderBy: [{ at: "asc" }, { createdAt: "asc" }] });
  });

  it("refuses an inverted range before asking", async () => {
    const { prisma, metricAnnotations } = prismaMock();
    await expect(listMetricAnnotations(prisma, { from: "2026-11-02T00:00:00Z", to: "2026-11-01T00:00:00Z" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(metricAnnotations.findMany).not.toHaveBeenCalled();
  });
});

describe("createMetricAnnotation and deleteMetricAnnotation", () => {
  it("stores the validated row for the admin and returns it", async () => {
    const { prisma, metricAnnotations } = prismaMock();
    const row = await createMetricAnnotation(prisma, { at: "2026-10-29T18:33:00Z", label: " Geocoding inside the model's area ", metricKeys: ["DISTRICT_OR_FINER"] }, "admin-1");
    expect(metricAnnotations.create).toHaveBeenCalledWith({
      data: {
        at: new Date("2026-10-29T18:33:00Z"),
        label: "Geocoding inside the model's area",
        description: null,
        link: null,
        metricKeys: ["DISTRICT_OR_FINER"],
        createdById: "admin-1",
      },
    });
    expect(row.label).toBe("Geocoding inside the model's area");
  });

  it("does not touch the database for an invalid row", async () => {
    const { prisma, metricAnnotations } = prismaMock();
    await expect(createMetricAnnotation(prisma, { at: "2026-10-29T18:33:00Z", label: "", metricKeys: ["DISTRICT_OR_FINER"] }, "admin-1")).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    expect(metricAnnotations.create).not.toHaveBeenCalled();
  });

  it("deletes an existing row and returns it, and is NOT_FOUND otherwise", async () => {
    const { prisma, metricAnnotations } = prismaMock();
    expect(await deleteMetricAnnotation(prisma, "ann-1")).toEqual(ROW);
    expect(metricAnnotations.delete).toHaveBeenCalledWith({ where: { id: "ann-1" } });
    const missing = prismaMock({ findUnique: vi.fn(async () => null) });
    await expect(deleteMetricAnnotation(missing.prisma, "nope")).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(missing.metricAnnotations.delete).not.toHaveBeenCalled();
  });
});
