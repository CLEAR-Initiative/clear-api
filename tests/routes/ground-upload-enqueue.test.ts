/**
 * Export-upload → classification-enqueue wiring test: a successful upload
 * that created rows enqueues classify_ground_messages for its source; an
 * all-duplicates re-upload does not.
 *
 * Fully hermetic: auth, Prisma, S3, the ingest service, and the enqueue
 * helper are vi.mock()ed; the route runs on a throwaway Express server so
 * the multipart handling is exercised for real. Fixtures synthetic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

const {
  resolveRequestAuthMock,
  ingestWhatsAppExportMock,
  enqueueGroundClassificationMock,
  prismaStub,
} = vi.hoisted(() => ({
  resolveRequestAuthMock: vi.fn(),
  ingestWhatsAppExportMock: vi.fn(),
  enqueueGroundClassificationMock: vi.fn(),
  prismaStub: {
    groundSources: { findUnique: vi.fn() },
  },
}));

vi.mock("../../src/utils/request-auth.js", () => ({
  resolveRequestAuth: resolveRequestAuthMock,
}));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: prismaStub }));
vi.mock("../../src/services/ground-ingest.js", () => ({
  ingestWhatsAppExport: ingestWhatsAppExportMock,
  groundMediaKey: vi.fn(() => "ground/x/key"),
}));
vi.mock("../../src/services/s3.js", () => ({
  uploadBufferToS3: vi.fn(async () => "ground/x/key"),
}));
vi.mock("../../src/services/ground-classify.js", () => ({
  enqueueGroundClassification: enqueueGroundClassificationMock,
}));

import express from "express";
import { groundUploadRouter } from "../../src/routes/ground-upload.js";

describe("POST /api/ground/upload — classification enqueue", () => {
  let server: Server;
  let url: string;

  async function postExport() {
    const form = new FormData();
    form.append("groundSourceId", "gs_1");
    form.append(
      "chat",
      new Blob(["synthetic export"], { type: "text/plain" }),
      "_chat.txt",
    );
    return fetch(url, { method: "POST", body: form });
  }

  beforeAll(async () => {
    const app = express();
    app.use("/api/ground/upload", groundUploadRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/api/ground/upload`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    resolveRequestAuthMock.mockReset();
    resolveRequestAuthMock.mockResolvedValue({
      user: { id: "admin1", role: "admin" },
      session: null,
      authMethod: "session",
    });
    prismaStub.groundSources.findUnique.mockReset();
    prismaStub.groundSources.findUnique.mockResolvedValue({
      id: "gs_1",
      transportId: "111000111@g.us",
      isActive: true,
    });
    ingestWhatsAppExportMock.mockReset();
    enqueueGroundClassificationMock.mockClear();
  });

  it("enqueues classification for the source when rows were created", async () => {
    ingestWhatsAppExportMock.mockResolvedValue({
      created: 3,
      skipped: 0,
      mediaStored: 0,
      mediaUnmatched: [],
    });

    const res = await postExport();

    expect(res.status).toBe(200);
    expect(enqueueGroundClassificationMock).toHaveBeenCalledExactlyOnceWith("gs_1");
  });

  it("does not enqueue when the upload created nothing (all duplicates)", async () => {
    ingestWhatsAppExportMock.mockResolvedValue({
      created: 0,
      skipped: 3,
      mediaStored: 0,
      mediaUnmatched: [],
    });

    const res = await postExport();

    expect(res.status).toBe(200);
    expect(enqueueGroundClassificationMock).not.toHaveBeenCalled();
  });
});
