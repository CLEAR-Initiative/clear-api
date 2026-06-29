/**
 * Handler tests for the source-PDF upload path.
 *
 * The route is mounted on a throwaway Express server and driven over HTTP with
 * `fetch` + `FormData`, so status codes and the returned key scheme are tested
 * exactly as a caller sees them. S3 is mocked (no real bucket); the Better Auth
 * session is mocked; API-key auth runs against the real DB (repo convention) —
 * the pipeline/viewer users + keys are created in `beforeAll` and removed in
 * `afterAll`. Skipped automatically when DATABASE_URL is absent.
 */

import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

// Hoisted so the vi.mock factories can close over them.
const { getSessionMock, s3SendMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  s3SendMock: vi.fn(),
}));

vi.mock("../../src/lib/auth.js", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  // Real classes — `new S3Client()` / `new PutObjectCommand()` must construct.
  S3Client: class {
    send = s3SendMock;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

import express from "express";
import { prisma } from "../../src/lib/prisma.js";
import { generateApiKey } from "../../src/utils/api-key.js";
import { uploadRouter } from "../../src/routes/upload.js";
import { describeIfDb } from "../helpers/db.js";

describeIfDb("POST /api/upload — source-PDF archival", () => {
  let server: Server;
  let url: string;
  const userIds: string[] = [];
  let pipelineKey: string;
  let viewerKey: string;

  const PDF = Buffer.from("%PDF-1.4 test source document bytes");
  const EXPECTED_KEY = `sources/${createHash("sha256").update(PDF).digest("hex")}.pdf`;

  async function mintUserKey(role: string): Promise<string> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { plaintextKey, prefix, keyHash } = generateApiKey();
    const user = await prisma.user.create({
      data: { name: `upload-test-${role}`, email: `upload-${role}-${stamp}@test.dev`, role },
    });
    userIds.push(user.id);
    await prisma.apiKeys.create({
      data: { userId: user.id, name: `upload-test-${role}`, prefix, keyHash },
    });
    return plaintextKey;
  }

  async function post(bytes: Buffer, headers: Record<string, string> = {}) {
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: "application/pdf" }), "doc.pdf");
    return fetch(url, { method: "POST", body: form, headers });
  }

  beforeAll(async () => {
    const app = express();
    app.use("/api/upload", uploadRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/api/upload`;

    pipelineKey = await mintUserKey("pipeline");
    viewerKey = await mintUserKey("viewer");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (userIds.length > 0) {
      await prisma.apiKeys.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
  });

  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue(null); // no session by default
    s3SendMock.mockReset();
    s3SendMock.mockResolvedValue({});
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await post(PDF);
    expect(res.status).toBe(401);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("accepts the pipeline API key and returns sources/<sha256>.pdf", async () => {
    const res = await post(PDF, { Authorization: `Bearer ${pipelineKey}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys).toEqual([EXPECTED_KEY]);
    // Stored under the deterministic content-hash key.
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(s3SendMock.mock.calls[0][0].input.Key).toBe(EXPECTED_KEY);
  });

  it("rejects a viewer-role API key with 403", async () => {
    const res = await post(PDF, { Authorization: `Bearer ${viewerKey}` });
    expect(res.status).toBe(403);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("accepts a session caller (legacy media path, signals/ key)", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "sess-admin", role: "admin" },
      session: { id: "sess" },
    });
    const res = await post(PDF);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys[0]).toMatch(/^signals\//);
    expect(body.keys[0]).not.toBe(EXPECTED_KEY);
  });

  it("is idempotent: identical bytes → same key both times", async () => {
    const first = await post(PDF, { Authorization: `Bearer ${pipelineKey}` });
    const second = await post(PDF, { Authorization: `Bearer ${pipelineKey}` });
    const k1 = ((await first.json()) as { keys: string[] }).keys[0];
    const k2 = ((await second.json()) as { keys: string[] }).keys[0];
    expect(k1).toBe(EXPECTED_KEY);
    expect(k2).toBe(EXPECTED_KEY); // same hash → same key → one S3 object
  });

  it("derives different keys for different content", async () => {
    const other = Buffer.from("%PDF-1.4 a different document");
    const res = await post(other, { Authorization: `Bearer ${pipelineKey}` });
    const key = ((await res.json()) as { keys: string[] }).keys[0];
    expect(key).toBe(`sources/${createHash("sha256").update(other).digest("hex")}.pdf`);
    expect(key).not.toBe(EXPECTED_KEY);
  });
});
