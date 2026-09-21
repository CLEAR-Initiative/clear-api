/**
 * Handler tests for the source-PDF upload path.
 *
 * The route is mounted on a throwaway Express server and driven over HTTP with
 * `fetch` + `FormData`, so status codes and the returned key scheme are tested
 * exactly as a caller sees them. S3 + the Better Auth session are mocked.
 *
 * DB-FREE: the route's only DB touch is API-key auth (resolveRequestAuth's
 * `prisma.apiKeys.findUnique`). We mock the prisma singleton so a generated key
 * resolves to a canned user by its keyHash — no seeded users/keys, no cleanup.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

// Hoisted so the vi.mock factories can close over them.
const { getSessionMock, s3SendMock, apiKeyRows } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  s3SendMock: vi.fn(),
  // keyHash → the row resolveRequestAuth expects (with the joined user).
  apiKeyRows: new Map<string, unknown>(),
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

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    apiKeys: {
      findUnique: vi.fn(async ({ where }: { where: { keyHash: string } }) => apiKeyRows.get(where.keyHash) ?? null),
      update: vi.fn(async () => ({})), // lastUsedAt fire-and-forget
    },
  },
}));

import express from "express";
import { generateApiKey } from "../../src/utils/api-key.js";
import { uploadRouter } from "../../src/routes/upload.js";

describe("POST /api/upload — source-PDF archival", () => {
  let server: Server;
  let url: string;
  let pipelineKey: string;
  let viewerKey: string;

  const PDF = Buffer.from("%PDF-1.4 test source document bytes");
  const EXPECTED_KEY = `sources/${createHash("sha256").update(PDF).digest("hex")}.pdf`;

  /** Register a key→user in the mock and return the plaintext key. No DB. */
  function mintUserKey(role: string): string {
    const { plaintextKey, prefix, keyHash } = generateApiKey();
    apiKeyRows.set(keyHash, {
      id: `key-${role}`, prefix, keyHash, revokedAt: null, expiresAt: null,
      user: { id: `user-${role}`, role, isActive: true },
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

    pipelineKey = mintUserKey("pipeline");
    viewerKey = mintUserKey("viewer");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect((s3SendMock.mock.calls[0][0] as { input: { Key: string } }).input.Key).toBe(EXPECTED_KEY);
  });

  it("rejects a viewer-role API key with 403", async () => {
    const res = await post(PDF, { Authorization: `Bearer ${viewerKey}` });
    expect(res.status).toBe(403);
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("accepts a session caller (legacy media path, signals/ key)", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "sess-admin", role: "admin", isActive: true },
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
    expect(k2).toBe(EXPECTED_KEY);
  });

  it("derives different keys for different content", async () => {
    const other = Buffer.from("%PDF-1.4 a different document");
    const res = await post(other, { Authorization: `Bearer ${pipelineKey}` });
    const key = ((await res.json()) as { keys: string[] }).keys[0];
    expect(key).toBe(`sources/${createHash("sha256").update(other).digest("hex")}.pdf`);
    expect(key).not.toBe(EXPECTED_KEY);
  });
});
