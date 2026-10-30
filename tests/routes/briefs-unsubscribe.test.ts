/**
 * The public unsubscribe link in Brief emails: a valid token sets
 * `unsubscribedAt` once; an unknown or missing token is a 404 that writes
 * nothing.
 *
 * Hermetic: the route takes its Prisma slice as a parameter, so a stub
 * stands in for the database behind a throwaway local Express server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";
import {
  createBriefsUnsubscribeRouter,
  type UnsubscribeClient,
} from "../../src/routes/briefs-unsubscribe.js";

const findUnique = vi.fn();
const update = vi.fn();
const client = { recipientListMember: { findUnique, updateMany: update } } as unknown as UnsubscribeClient;

describe("GET /briefs/unsubscribe", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use("/briefs", createBriefsUnsubscribeRouter(client));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it("sets unsubscribedAt for a valid token and confirms", async () => {
    findUnique.mockResolvedValue({ id: "m1", unsubscribedAt: null, list: { name: "CLEAR <team>" } });
    const res = await fetch(`${base}/briefs/unsubscribe?token=tok-1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await res.text();
    expect(body).toContain("unsubscribed");
    expect(body).toContain("CLEAR &lt;team&gt;");
    expect(findUnique.mock.calls[0][0].where).toEqual({ unsubscribeToken: "tok-1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: "m1", unsubscribedAt: null });
    expect(update.mock.calls[0][0].data.unsubscribedAt).toBeInstanceOf(Date);
  });

  it("keeps the first unsubscribe time when followed again", async () => {
    findUnique.mockResolvedValue({ id: "m1", unsubscribedAt: new Date("2026-10-01"), list: { name: "L" } });
    const res = await fetch(`${base}/briefs/unsubscribe?token=tok-1`);
    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });

  it("404s an unknown token and writes nothing", async () => {
    findUnique.mockResolvedValue(null);
    const res = await fetch(`${base}/briefs/unsubscribe?token=nope`);
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it("404s a missing token without a lookup", async () => {
    const res = await fetch(`${base}/briefs/unsubscribe`);
    expect(res.status).toBe(404);
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
