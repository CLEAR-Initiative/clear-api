/**
 * Event-card synthesis + sync (ADR-0006 write path). `synthesiseEventCard` is
 * pure; `syncEventCards` is exercised with mocked prisma + embedding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/embedding-client.js", () => ({
  embedDocument: vi.fn().mockResolvedValue(new Array(1024).fill(0.02)),
  loadEmbeddingConfig: vi.fn().mockReturnValue({ provider: "voyage", model: "voyage-3-large" }),
}));

import { synthesiseEventCard, syncEventCards, type EventForCard } from "../../src/services/event-card.js";
import { embedDocument } from "../../src/utils/embedding-client.js";
import type { Context } from "../../src/context.js";

function ev(overrides: Partial<EventForCard> = {}): EventForCard {
  return {
    id: "ev1", title: null, description: null, types: ["conflict"],
    severity: 3, casualties: 12, populationDisplaced: 5000n, populationAffected: null,
    startedAt: new Date("2026-09-15T00:00:00Z"), firstSignalCreatedAt: new Date("2026-09-14T00:00:00Z"),
    validFrom: new Date("2026-09-15T00:00:00Z"), validTo: new Date("2026-09-16T00:00:00Z"),
    originLocation: { id: "dilling", name: "Dilling" },
    destinationLocation: null,
    generalLocation: { id: "dilling", name: "Dilling" }, // same as origin → deduped
    ...overrides,
  };
}

describe("synthesiseEventCard", () => {
  it("builds a card with a structured facts line and deduped locations", () => {
    const card = synthesiseEventCard(ev());
    expect(card.eventId).toBe("ev1");
    expect(card.locationIds).toEqual(["dilling"]); // origin + general dedupe to one
    expect(card.embeddedText).toContain("Type: conflict");
    expect(card.embeddedText).toContain("Location: Dilling");
    expect(card.embeddedText).toContain("Onset: 2026-09-15");
    expect(card.embeddedText).toContain("Severity: 3/5");
    expect(card.embeddedText).toContain("Casualties: 12");
    expect(card.embeddedText).toContain("Displaced: 5000");
    expect(card.startedAt).toEqual(new Date("2026-09-15T00:00:00Z"));
  });

  it("falls back to a synthesised title and firstSignalCreatedAt onset when absent", () => {
    const card = synthesiseEventCard(ev({ title: null, startedAt: null, types: ["flood"], originLocation: { id: "kassala", name: "Kassala" }, generalLocation: null }));
    expect(card.title).toBe("flood — Kassala");
    expect(card.startedAt).toEqual(new Date("2026-09-14T00:00:00Z")); // firstSignalCreatedAt
  });

  it("uses the event title when present and omits absent facts", () => {
    const card = synthesiseEventCard(ev({ title: "Airstrike on market", severity: null, casualties: null, populationDisplaced: null }));
    expect(card.title).toBe("Airstrike on market");
    expect(card.embeddedText).not.toContain("Severity");
    expect(card.embeddedText).not.toContain("Casualties");
  });
});

describe("syncEventCards", () => {
  beforeEach(() => vi.clearAllMocks());

  function ctx(findMany: ReturnType<typeof vi.fn>, exec: ReturnType<typeof vi.fn>): Context {
    return { prisma: { events: { findMany }, $executeRawUnsafe: exec } as unknown as Context["prisma"] } as unknown as Context;
  }

  it("embeds a document vector and upserts one row per resolved event", async () => {
    const findMany = vi.fn().mockResolvedValue([ev({ id: "a" }), ev({ id: "b" })]);
    const exec = vi.fn().mockResolvedValue(1);
    const res = await syncEventCards(ctx(findMany, exec).prisma, ["a", "b"]);

    expect(res).toEqual({ synced: 2, skipped: 0 });
    expect(embedDocument).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(2);
    // upsert SQL targets events_index with ON CONFLICT (event_id)
    const sql = String(exec.mock.calls[0][0]);
    expect(sql).toContain('INSERT INTO "events_index"');
    expect(sql).toContain('ON CONFLICT ("event_id") DO UPDATE');
    // the vector literal is passed as a param
    expect(exec.mock.calls[0].some((a: unknown) => typeof a === "string" && a.startsWith("["))).toBe(true);
  });

  it("counts ids that no longer resolve to an event as skipped", async () => {
    const findMany = vi.fn().mockResolvedValue([ev({ id: "a" })]); // "gone" not returned
    const exec = vi.fn().mockResolvedValue(1);
    const res = await syncEventCards(ctx(findMany, exec).prisma, ["a", "gone"]);
    expect(res).toEqual({ synced: 1, skipped: 1 });
  });

  it("no-ops on an empty id list", async () => {
    const findMany = vi.fn();
    const exec = vi.fn();
    const res = await syncEventCards(ctx(findMany, exec).prisma, []);
    expect(res).toEqual({ synced: 0, skipped: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });
});
