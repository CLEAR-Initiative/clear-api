/**
 * Handler tests for the health probes: `/health` must stay a pure liveness
 * check (green even when the DB is down — the compose healthcheck depends on
 * that), and `/health/ready` must turn a dead or slow database into a 503
 * without leaking the connection string.
 *
 * Fully hermetic (no describeIfDb): the Prisma client module is vi.mock()ed,
 * so no database and no network beyond the throwaway local Express server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const { prismaStub } = vi.hoisted(() => ({
  prismaStub: { $queryRaw: vi.fn() },
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaStub }));

import express from "express";
import {
  healthRouter,
  checkDatabase,
  sanitizeProbeError,
  ReadinessTimeoutError,
} from "../../src/routes/health.js";

const FAKE_DATABASE_URL = "postgresql://clear:s3cretpw@10.10.0.20:5432/clear";

describe("health probes", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use("/health", healthRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    prismaStub.$queryRaw.mockReset();
    vi.stubEnv("DATABASE_URL", FAKE_DATABASE_URL);
  });

  describe("GET /health (liveness)", () => {
    it("200s with status ok", async () => {
      prismaStub.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("stays 200 and never touches the database when it is down", async () => {
      prismaStub.$queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED"));
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
      expect(prismaStub.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("GET /health/ready (readiness)", () => {
    it("200s with db ok when SELECT 1 answers", async () => {
      prismaStub.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
      const res = await fetch(`${base}/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", db: "ok" });
      expect(prismaStub.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("503s with db unreachable when the query rejects", async () => {
      prismaStub.$queryRaw.mockRejectedValue(
        new Error("Can't reach database server at `10.10.0.20:5432`"),
      );
      const res = await fetch(`${base}/health/ready`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ status: "degraded", db: "unreachable" });
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("Can't reach database server");
    });

    it("never echoes DATABASE_URL or its password in the error", async () => {
      prismaStub.$queryRaw.mockRejectedValue(
        new Error(`connection to ${FAKE_DATABASE_URL} failed: timeout expired`),
      );
      const res = await fetch(`${base}/health/ready`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain(FAKE_DATABASE_URL);
      expect(text).not.toContain("s3cretpw");
      expect(text).toContain("[redacted]");
      expect(text).toContain("timeout expired");
    });
  });

  describe("checkDatabase", () => {
    it("rejects with ReadinessTimeoutError when the query never settles", async () => {
      const hung = { $queryRaw: () => new Promise<never>(() => {}) };
      await expect(checkDatabase(hung, 20)).rejects.toBeInstanceOf(ReadinessTimeoutError);
    });

    it("resolves (and clears its timer) when the query answers in time", async () => {
      const ok = { $queryRaw: async () => [{ "?column?": 1 }] };
      await expect(checkDatabase(ok, 1_000)).resolves.toBeUndefined();
    });
  });

  describe("sanitizeProbeError", () => {
    it("redacts the exact DATABASE_URL and any other URL-shaped token", () => {
      const msg = sanitizeProbeError(
        new Error(`failed for ${FAKE_DATABASE_URL} and postgres://a:b@c/d`),
        FAKE_DATABASE_URL,
      );
      expect(msg).toBe("failed for [redacted] and [redacted]");
    });

    it("stringifies non-Error rejections", () => {
      expect(sanitizeProbeError("boom", undefined)).toBe("boom");
    });

    it("truncates very long messages", () => {
      const msg = sanitizeProbeError(new Error("x".repeat(2_000)), undefined);
      expect(msg.length).toBeLessThanOrEqual(501);
      expect(msg.endsWith("…")).toBe(true);
    });
  });
});
