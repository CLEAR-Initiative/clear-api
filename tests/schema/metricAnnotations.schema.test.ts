/**
 * Schema contract for `metricAnnotations`, `createMetricAnnotation` and
 * `deleteMetricAnnotation` (ADR-0016): the documents clear-mvp sends,
 * executed through a real ApolloServer, so the input shapes, the enum, every
 * selected field and the error codes are pinned at the seam.
 *
 * DB-FREE: `context.prisma` is a mock with the annotation and activity-log
 * methods the resolvers call.
 */
import { ApolloServer } from "@apollo/server";
import { describe, expect, it, vi } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

const LIST = `
  query MetricAnnotations($input: MetricAnnotationsInput) {
    metricAnnotations(input: $input) { id at label description link metricKeys createdById createdAt }
  }
`;
const CREATE = `
  mutation CreateMetricAnnotation($input: CreateMetricAnnotationInput!) {
    createMetricAnnotation(input: $input) { id at label description link metricKeys }
  }
`;
const DELETE = `
  mutation DeleteMetricAnnotation($id: ID!) {
    deleteMetricAnnotation(id: $id)
  }
`;

const ROW = {
  id: "ann-1",
  at: new Date("2026-10-29T18:33:00Z"),
  label: "Geocoding inside the model's area",
  description: null,
  link: "https://github.com/CLEAR-Initiative/clear-pipeline/pull/140",
  metricKeys: ["DISTRICT_OR_FINER"],
  createdById: "a",
  createdAt: new Date("2026-10-31T17:00:00Z"),
};

async function run(user: { id: string; role: string } | null, query: string, variables: Record<string, unknown>) {
  const prisma = {
    metricAnnotations: {
      findMany: vi.fn(async () => [ROW]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...ROW, ...data, id: "ann-2" })),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== "ann-1") throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
        return ROW;
      }),
    },
    activityLogs: { create: vi.fn(async () => ({})) },
  };
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  await server.start();
  const response = await server.executeOperation(
    { query, variables },
    { contextValue: { prisma, user, session: null, authMethod: user ? "session" : null, locale: "en" } as unknown as Context },
  );
  await server.stop();
  if (response.body.kind !== "single") throw new Error(`Expected a single result, got ${response.body.kind}`);
  return { result: response.body.singleResult, prisma };
}

const admin = { id: "a", role: "admin" };

describe("metricAnnotations schema contract", () => {
  it("lists for an admin with the range and metric, and refuses everyone else", async () => {
    const { result, prisma } = await run(admin, LIST, { input: { from: "2026-10-26T00:00:00.000Z", to: "2026-11-01T23:59:59.999Z", metric: "DISTRICT_OR_FINER" } });
    expect(result.errors).toBeUndefined();
    expect(result.data?.metricAnnotations).toEqual([
      {
        id: "ann-1",
        at: "2026-10-29T18:33:00.000Z",
        label: "Geocoding inside the model's area",
        description: null,
        link: "https://github.com/CLEAR-Initiative/clear-pipeline/pull/140",
        metricKeys: ["DISTRICT_OR_FINER"],
        createdById: "a",
        createdAt: "2026-10-31T17:00:00.000Z",
      },
    ]);
    expect(prisma.metricAnnotations.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { at: { gte: new Date("2026-10-26T00:00:00.000Z"), lte: new Date("2026-11-01T23:59:59.999Z") }, metricKeys: { has: "DISTRICT_OR_FINER" } } }),
    );
    expect((await run({ id: "u", role: "analyst" }, LIST, {})).result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect((await run(null, LIST, {})).result.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    const bad = await run(admin, LIST, { input: { metric: "SOMETHING_ELSE" } });
    expect(bad.result.errors?.[0]?.message).toMatch(/MetricKey/);
  });

  it("creates and deletes for an admin, logging each, and refuses a bad row", async () => {
    const created = await run(admin, CREATE, {
      input: { at: "2026-10-31T13:13:00Z", label: "Incident site over impact area (prompt v3)", metricKeys: ["DISTRICT_OR_FINER"], link: "https://github.com/CLEAR-Initiative/clear-pipeline/pull/152" },
    });
    expect(created.result.errors).toBeUndefined();
    expect(created.result.data?.createMetricAnnotation).toMatchObject({ id: "ann-2", at: "2026-10-31T13:13:00.000Z", label: "Incident site over impact area (prompt v3)", metricKeys: ["DISTRICT_OR_FINER"] });
    expect(created.prisma.activityLogs.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "metric_annotation.create", resourceId: "ann-2" }) });

    const deleted = await run(admin, DELETE, { id: "ann-1" });
    expect(deleted.result.errors).toBeUndefined();
    expect(deleted.result.data?.deleteMetricAnnotation).toBe(true);
    expect(deleted.prisma.activityLogs.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "metric_annotation.delete", resourceId: "ann-1" }) });

    const missing = await run(admin, DELETE, { id: "nope" });
    expect(missing.result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    const empty = await run(admin, CREATE, { input: { at: "2026-10-31T13:13:00Z", label: "  ", metricKeys: ["DISTRICT_OR_FINER"] } });
    expect(empty.result.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
    expect(empty.prisma.metricAnnotations.create).not.toHaveBeenCalled();
    const unknownKey = await run(admin, CREATE, { input: { at: "2026-10-31T13:13:00Z", label: "x", metricKeys: ["NOPE"] } });
    expect(unknownKey.result.errors?.[0]?.message).toMatch(/MetricKey/);
    const forbidden = await run({ id: "u", role: "analyst" }, CREATE, { input: { at: "2026-10-31T13:13:00Z", label: "x", metricKeys: ["DISTRICT_OR_FINER"] } });
    expect(forbidden.result.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(forbidden.prisma.metricAnnotations.create).not.toHaveBeenCalled();
  });
});
