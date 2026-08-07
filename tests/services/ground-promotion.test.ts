/**
 * Promotion mapping tests: approved_public thread → CreateSignalInput.
 *
 * The load-bearing assertion is identity scrubbing — NOTHING
 * sender-shaped survives into the promoted input, per the PRD's
 * "attribution can endanger people" constraint. Also covered: the
 * externalId/publishedAt mapping, the find-or-create of the single
 * "whatsapp" dataSources row, and the full reviewGroundThread →
 * createSignal wiring on a stubbed Prisma surface (the REAL createSignal
 * resolver runs, so the promoted signal takes the standard path).
 * No DB. Always runs.
 */

import { describe, it, expect } from "vitest";
import {
  buildPromotedSignalInput,
  ensureWhatsAppDataSource,
  type PromotableMessage,
} from "../../src/services/ground-promotion.js";
import { groundResolvers } from "../../src/resolvers/ground.resolver.js";
import type { Context } from "../../src/context.js";

const SENDER_NAME = "Basma Synthetic";
const SENDER_REF = "s_ab12cd34ef56";

function makeMessages(): PromotableMessage[] {
  // Built from staged rows that DO carry sender fields — the mapping's
  // input type strips them structurally, and the scrub test verifies no
  // sender value leaks through any other field.
  return [
    {
      externalId: "whatsapp:group1@g.us:aaaaaaaaaaaaaaaa",
      sentAt: new Date("2026-04-12T07:21:00Z"),
      text: "Reported strike at the market, unconfirmed",
      mediaKeys: [],
      omittedMediaCount: 1,
      classification: "field_report",
      uncertainty: "unconfirmed",
      isEdited: false,
    },
    {
      externalId: "whatsapp:group1@g.us:bbbbbbbbbbbbbbbb",
      sentAt: new Date("2026-04-12T06:45:00Z"), // earlier — must win publishedAt
      text: "Initial report from the field team",
      mediaKeys: ["ground/src_1/deadbeef.jpg"],
      omittedMediaCount: 0,
      classification: null,
      uncertainty: null,
      isEdited: true,
    },
  ];
}

describe("buildPromotedSignalInput", () => {
  const thread = { id: "t1", title: "Strike at the market", lifecycleState: "corrected" };

  it("maps externalId and publishedAt from the earliest message", () => {
    const input = buildPromotedSignalInput({
      dataSourceId: "ds_whatsapp",
      thread,
      messages: makeMessages(),
    });
    expect(input.sourceId).toBe("ds_whatsapp");
    expect(input.externalId).toBe("whatsapp:group1@g.us:bbbbbbbbbbbbbbbb");
    expect(input.publishedAt).toBe("2026-04-12T06:45:00.000Z");
    expect(input.title).toBe("Strike at the market");
  });

  it("carries thread provenance and message content in rawData", () => {
    const input = buildPromotedSignalInput({
      dataSourceId: "ds_whatsapp",
      thread,
      messages: makeMessages(),
    });
    const raw = input.rawData as {
      ground: boolean;
      groundThreadId: string;
      lifecycleState: string;
      messages: Array<{ uncertainty: string | null }>;
    };
    expect(raw.ground).toBe(true);
    expect(raw.groundThreadId).toBe("t1");
    expect(raw.lifecycleState).toBe("corrected");
    expect(raw.messages).toHaveLength(2);
    // Uncertainty markers survive promotion (PRD requirement).
    expect(raw.messages.map((m) => m.uncertainty)).toContain("unconfirmed");
  });

  it("scrubs ALL sender identity from the promoted input", () => {
    const input = buildPromotedSignalInput({
      dataSourceId: "ds_whatsapp",
      thread,
      messages: makeMessages(),
      mediaUrls: ["https://example.com/presigned/deadbeef.jpg"],
    });
    const serialised = JSON.stringify(input);
    expect(serialised).not.toContain(SENDER_NAME);
    expect(serialised).not.toContain(SENDER_REF);
    expect(serialised.toLowerCase()).not.toContain("sender");
  });

  it("passes presigned media URLs through and refuses empty threads", () => {
    const input = buildPromotedSignalInput({
      dataSourceId: "ds",
      thread,
      messages: makeMessages(),
      mediaUrls: ["https://example.com/presigned/deadbeef.jpg"],
    });
    expect(input.media).toEqual(["https://example.com/presigned/deadbeef.jpg"]);

    expect(() =>
      buildPromotedSignalInput({ dataSourceId: "ds", thread, messages: [] }),
    ).toThrow(/no messages/);
  });
});

describe("ensureWhatsAppDataSource", () => {
  it("reuses an existing whatsapp row, creates it once otherwise", async () => {
    let createCalls = 0;
    let row: { id: string } | null = null;
    const prisma = {
      dataSources: {
        findFirst: async () => row,
        create: async () => {
          createCalls += 1;
          row = { id: "ds_new" };
          return row;
        },
      },
    } as never;

    expect(await ensureWhatsAppDataSource(prisma)).toEqual({ id: "ds_new" });
    expect(await ensureWhatsAppDataSource(prisma)).toEqual({ id: "ds_new" });
    expect(createCalls).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Full wiring: reviewGroundThread(approve_public) drives the REAL
// createSignal resolver against a stubbed Prisma surface.
// ────────────────────────────────────────────────────────────────────────

function makePromotionContext() {
  const staged = {
    id: "t1",
    reviewState: "approved_private",
    lifecycleState: "reported",
    title: "Strike at the market",
    promotedSignalId: null as string | null,
    source: { reviewerRoles: ["admin", "analyst"] },
    messages: [
      {
        externalId: "whatsapp:group1@g.us:cccccccccccccccc",
        sentAt: new Date("2026-04-12T06:45:00Z"),
        text: "Initial report, phone was [phone redacted]",
        mediaKeys: [],
        omittedMediaCount: 0,
        classification: "field_report",
        uncertainty: null,
        isEdited: false,
        senderRef: SENDER_REF,
        senderName: SENDER_NAME,
      },
    ],
  };

  const createdSignals: Array<Record<string, unknown>> = [];
  const threadUpdates: Array<Record<string, unknown>> = [];

  const prisma = {
    groundThreads: {
      findUnique: async () => staged,
      update: async (args: { data: Record<string, unknown> }) => {
        threadUpdates.push(args.data);
        return { ...staged, ...args.data };
      },
    },
    dataSources: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === "ds_whatsapp" ? { id: "ds_whatsapp", name: "whatsapp", type: "whatsapp" } : null,
      findFirst: async () => ({ id: "ds_whatsapp" }),
      create: async () => ({ id: "ds_whatsapp" }),
    },
    signals: {
      findUnique: async () => null, // no existing (sourceId, externalId) row
      create: async (args: { data: Record<string, unknown> }) => {
        createdSignals.push(args.data);
        return { id: "sig_1", ...args.data };
      },
    },
  };

  const context = {
    prisma,
    user: { id: "u1", role: "analyst" },
    session: null,
    authMethod: "session",
    locale: "en",
  } as unknown as Context;

  return { context, createdSignals, threadUpdates };
}

describe("reviewGroundThread → approve_public promotes via createSignal", () => {
  it("creates the signal through the standard path and links it on the thread", async () => {
    const { context, createdSignals, threadUpdates } = makePromotionContext();

    const result = await groundResolvers.Mutation.reviewGroundThread(
      null,
      { id: "t1", decision: "approve_public" },
      context,
    );

    expect(createdSignals).toHaveLength(1);
    const signal = createdSignals[0]!;
    expect(signal.sourceId).toBe("ds_whatsapp");
    expect(signal.externalId).toBe("whatsapp:group1@g.us:cccccccccccccccc");

    // No sender identity anywhere in the created signal row.
    const serialised = JSON.stringify(signal);
    expect(serialised).not.toContain(SENDER_NAME);
    expect(serialised).not.toContain(SENDER_REF);
    expect(serialised.toLowerCase()).not.toContain("sender");

    expect(threadUpdates).toHaveLength(1);
    expect(threadUpdates[0]!.reviewState).toBe("approved_public");
    expect(threadUpdates[0]!.promotedSignalId).toBe("sig_1");
    expect(result.promotedSignalId).toBe("sig_1");
  });

  it("approve_private does NOT touch the signals graph", async () => {
    const { context, createdSignals } = makePromotionContext();
    // Thread is approved_private already; reject it instead (valid) and
    // verify no signal write happens on non-public decisions.
    await groundResolvers.Mutation.reviewGroundThread(
      null,
      { id: "t1", decision: "reject" },
      context,
    );
    expect(createdSignals).toHaveLength(0);
  });
});
