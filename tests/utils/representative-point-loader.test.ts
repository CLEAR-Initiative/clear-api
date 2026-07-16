/**
 * Tests for the representative-point loader — the batched resolution of
 * an event's first-signal marker location. `batchResolve` holds the real
 * logic (first-signal selection, the location cascade, per-event
 * grouping); the loader wrapper only adds microtask batching, exercised
 * by the "batches sibling loads" test.
 */
import { describe, it, expect, vi } from "vitest";

import {
  batchResolve,
  createRepresentativePointLoader,
} from "../../src/utils/representative-point-loader.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

const D1 = new Date("2026-07-01T00:00:00Z");
const D2 = new Date("2026-07-03T00:00:00Z");
const D3 = new Date("2026-07-05T00:00:00Z");

/** A signals row as prisma returns it: publishedAt, the join rows naming
 *  which events it belongs to, and the location cascade. */
function sig(opts: {
  publishedAt: Date;
  eventIds: string[];
  origin?: unknown;
  destination?: unknown;
  general?: unknown;
}) {
  return {
    publishedAt: opts.publishedAt,
    signalEvents: opts.eventIds.map((eventId) => ({ eventId })),
    originLocation: opts.origin ?? null,
    destinationLocation: opts.destination ?? null,
    generalLocation: opts.general ?? null,
  };
}

/** Fake prisma exposing just the two delegates batchResolve calls. */
function fakePrisma(opts: {
  events: { id: string; firstSignalCreatedAt: Date }[];
  signals: ReturnType<typeof sig>[];
}) {
  const eventsFindMany = vi.fn().mockResolvedValue(opts.events);
  const signalsFindMany = vi.fn().mockResolvedValue(opts.signals);
  const prisma = {
    events: { findMany: eventsFindMany },
    signals: { findMany: signalsFindMany },
  } as unknown as PrismaClient;
  return { prisma, eventsFindMany, signalsFindMany };
}

describe("batchResolve", () => {
  it("picks the signal recorded as firstSignalCreatedAt, not just the earliest", async () => {
    // Event's first is the LATER-published signal (D2), not D1.
    const { prisma } = fakePrisma({
      events: [{ id: "e1", firstSignalCreatedAt: D2 }],
      signals: [
        sig({ publishedAt: D1, eventIds: ["e1"], general: { id: "loc-early" } }),
        sig({ publishedAt: D2, eventIds: ["e1"], general: { id: "loc-first" } }),
      ],
    });
    const out = await batchResolve(prisma, "en", ["e1"]);
    expect(out.get("e1")).toEqual({ id: "loc-first" });
  });

  it("falls back to the earliest signal when no publishedAt matches", async () => {
    const { prisma } = fakePrisma({
      events: [{ id: "e1", firstSignalCreatedAt: new Date("2000-01-01T00:00:00Z") }],
      signals: [
        sig({ publishedAt: D1, eventIds: ["e1"], general: { id: "loc-early" } }),
        sig({ publishedAt: D2, eventIds: ["e1"], general: { id: "loc-late" } }),
      ],
    });
    const out = await batchResolve(prisma, "en", ["e1"]);
    expect(out.get("e1")).toEqual({ id: "loc-early" });
  });

  it("uses the origin → destination → general cascade", async () => {
    const { prisma } = fakePrisma({
      events: [{ id: "e1", firstSignalCreatedAt: D1 }],
      signals: [
        sig({ publishedAt: D1, eventIds: ["e1"], destination: { id: "loc-dest" }, general: { id: "loc-gen" } }),
      ],
    });
    const out = await batchResolve(prisma, "en", ["e1"]);
    // No origin → destination wins over general.
    expect(out.get("e1")).toEqual({ id: "loc-dest" });
  });

  it("is null when the event has no signals", async () => {
    const { prisma } = fakePrisma({
      events: [{ id: "e1", firstSignalCreatedAt: D1 }],
      signals: [],
    });
    const out = await batchResolve(prisma, "en", ["e1"]);
    expect(out.get("e1")).toBeNull();
  });

  it("is null when the first signal has no located point", async () => {
    const { prisma } = fakePrisma({
      events: [{ id: "e1", firstSignalCreatedAt: D1 }],
      signals: [sig({ publishedAt: D1, eventIds: ["e1"] })],
    });
    const out = await batchResolve(prisma, "en", ["e1"]);
    expect(out.get("e1")).toBeNull();
  });

  it("resolves many events in ONE pair of queries (the whole point)", async () => {
    const { prisma, eventsFindMany, signalsFindMany } = fakePrisma({
      events: [
        { id: "e1", firstSignalCreatedAt: D1 },
        { id: "e2", firstSignalCreatedAt: D3 },
      ],
      signals: [
        sig({ publishedAt: D1, eventIds: ["e1"], general: { id: "loc-e1" } }),
        sig({ publishedAt: D3, eventIds: ["e2"], general: { id: "loc-e2" } }),
      ],
    });
    const out = await batchResolve(prisma, "en", ["e1", "e2"]);
    expect(out.get("e1")).toEqual({ id: "loc-e1" });
    expect(out.get("e2")).toEqual({ id: "loc-e2" });
    // Two queries total, regardless of event count — no N+1.
    expect(eventsFindMany).toHaveBeenCalledTimes(1);
    expect(signalsFindMany).toHaveBeenCalledTimes(1);
  });

  it("attributes a shared signal to every event it belongs to", async () => {
    // One signal linked to two events (many-to-many) supplies both points.
    const { prisma } = fakePrisma({
      events: [
        { id: "e1", firstSignalCreatedAt: D1 },
        { id: "e2", firstSignalCreatedAt: D1 },
      ],
      signals: [sig({ publishedAt: D1, eventIds: ["e1", "e2"], general: { id: "loc-shared" } })],
    });
    const out = await batchResolve(prisma, "en", ["e1", "e2"]);
    expect(out.get("e1")).toEqual({ id: "loc-shared" });
    expect(out.get("e2")).toEqual({ id: "loc-shared" });
  });

  it("returns an empty map for an empty batch without querying", async () => {
    const { prisma, eventsFindMany, signalsFindMany } = fakePrisma({ events: [], signals: [] });
    const out = await batchResolve(prisma, "en", []);
    expect(out.size).toBe(0);
    expect(eventsFindMany).not.toHaveBeenCalled();
    expect(signalsFindMany).not.toHaveBeenCalled();
  });
});

describe("createRepresentativePointLoader", () => {
  it("batches sibling loads in one microtask into a single resolution", async () => {
    const { prisma, eventsFindMany, signalsFindMany } = fakePrisma({
      events: [
        { id: "e1", firstSignalCreatedAt: D1 },
        { id: "e2", firstSignalCreatedAt: D2 },
      ],
      signals: [
        sig({ publishedAt: D1, eventIds: ["e1"], general: { id: "loc-e1" } }),
        sig({ publishedAt: D2, eventIds: ["e2"], general: { id: "loc-e2" } }),
      ],
    });
    const loader = createRepresentativePointLoader(prisma, "en");
    // Two loads issued in the same tick → one batched query pair.
    const [a, b] = await Promise.all([loader.load("e1"), loader.load("e2")]);
    expect(a).toEqual({ id: "loc-e1" });
    expect(b).toEqual({ id: "loc-e2" });
    expect(eventsFindMany).toHaveBeenCalledTimes(1);
    expect(signalsFindMany).toHaveBeenCalledTimes(1);
  });

  it("dedupes repeated ids in a batch", async () => {
    const { prisma, signalsFindMany } = fakePrisma({
      events: [{ id: "e1", firstSignalCreatedAt: D1 }],
      signals: [sig({ publishedAt: D1, eventIds: ["e1"], general: { id: "loc-e1" } })],
    });
    const loader = createRepresentativePointLoader(prisma, "en");
    const [a, b] = await Promise.all([loader.load("e1"), loader.load("e1")]);
    expect(a).toEqual({ id: "loc-e1" });
    expect(b).toEqual({ id: "loc-e1" });
    expect(signalsFindMany).toHaveBeenCalledTimes(1);
  });
});
