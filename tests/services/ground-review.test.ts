/**
 * Review state machine + role-gating tests.
 *
 * The transition table and role predicate are pure (ground-review.ts);
 * the resolver test drives reviewGroundThread with a stubbed Prisma
 * surface to assert the gate order (auth → role → per-source roles →
 * transition) and the persisted audit fields. No DB. Always runs.
 */

import { describe, it, expect } from "vitest";
import { GraphQLError } from "graphql";
import {
  canReviewSource,
  isReviewDecision,
  reviewExtras,
  reviewTransition,
  REJECT_REASONS,
  REVIEW_DECISIONS,
  REVIEW_STATES,
} from "../../src/services/ground-review.js";
import { groundResolvers } from "../../src/resolvers/ground.resolver.js";
import type { Context } from "../../src/context.js";

describe("reviewTransition", () => {
  it("unverified accepts every decision", () => {
    expect(reviewTransition("unverified", "approve_private")).toEqual({
      ok: true,
      next: "approved_private",
    });
    expect(reviewTransition("unverified", "approve_public")).toEqual({
      ok: true,
      next: "approved_public",
    });
    expect(reviewTransition("unverified", "reject")).toEqual({
      ok: true,
      next: "rejected",
    });
  });

  it("approved_private can escalate to public or be rejected, not re-approved private", () => {
    expect(reviewTransition("approved_private", "approve_public")).toEqual({
      ok: true,
      next: "approved_public",
    });
    expect(reviewTransition("approved_private", "reject")).toEqual({
      ok: true,
      next: "rejected",
    });
    expect(reviewTransition("approved_private", "approve_private").ok).toBe(false);
  });

  it("rejected is reversible — nothing has left the staging tier", () => {
    expect(reviewTransition("rejected", "approve_private")).toEqual({
      ok: true,
      next: "approved_private",
    });
    expect(reviewTransition("rejected", "approve_public")).toEqual({
      ok: true,
      next: "approved_public",
    });
    expect(reviewTransition("rejected", "reject").ok).toBe(false);
  });

  it("approved_public is terminal — every decision is refused", () => {
    for (const decision of REVIEW_DECISIONS) {
      const result = reviewTransition("approved_public", decision);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("final");
    }
  });

  it("refuses unknown decisions and unknown states", () => {
    expect(reviewTransition("unverified", "publish").ok).toBe(false);
    expect(reviewTransition("garbage", "reject").ok).toBe(false);
  });

  it("every non-terminal state has at least one exit (no dead ends)", () => {
    for (const state of REVIEW_STATES) {
      if (state === "approved_public") continue;
      const exits = REVIEW_DECISIONS.filter((d) => reviewTransition(state, d).ok);
      expect(exits.length).toBeGreaterThan(0);
    }
  });
});

describe("canReviewSource", () => {
  it("platform admin always passes", () => {
    expect(canReviewSource({ role: "admin" }, ["analyst"])).toBe(true);
  });
  it("otherwise the global role must appear in the source's reviewerRoles", () => {
    expect(canReviewSource({ role: "analyst" }, ["admin", "analyst"])).toBe(true);
    expect(canReviewSource({ role: "analyst" }, ["admin"])).toBe(false);
    expect(canReviewSource({ role: "viewer" }, ["admin", "analyst"])).toBe(false);
    expect(canReviewSource(null, ["admin", "analyst"])).toBe(false);
  });
});

describe("isReviewDecision", () => {
  it("accepts exactly the three decisions", () => {
    expect(REVIEW_DECISIONS.every(isReviewDecision)).toBe(true);
    expect(isReviewDecision("approved_private")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Resolver-level: gate order and persisted audit fields, on a stub Prisma.
// ────────────────────────────────────────────────────────────────────────

interface StubThread {
  id: string;
  reviewState: string;
  source: { reviewerRoles: string[] };
}

function buildContext(
  user: { id: string; role: string } | null,
  thread: StubThread | null,
  knownLocationIds: string[] = [],
) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const prisma = {
    locations: {
      findUnique: async (args: { where: { id: string } }) =>
        knownLocationIds.includes(args.where.id) ? { id: args.where.id } : null,
    },
    groundThreads: {
      findUnique: async () => thread,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { ...thread, ...args.data };
      },
    },
  };
  const context = {
    prisma,
    user,
    session: null,
    authMethod: user ? "session" : null,
    locale: "en",
  } as unknown as Context;
  return { context, updates };
}

const reviewGroundThread = groundResolvers.Mutation.reviewGroundThread;

describe("reviewExtras", () => {
  it("accepts every known reject reason with reject, and nulls it otherwise", () => {
    for (const reason of REJECT_REASONS) {
      expect(reviewExtras("reject", { rejectReason: reason })).toEqual({
        ok: true,
        rejectReason: reason,
        overrides: {},
      });
    }
    expect(reviewExtras("approve_private", {})).toEqual({ ok: true, rejectReason: null, overrides: {} });
  });

  it("refuses a rejectReason that is unknown or sent with another decision", () => {
    const unknown = reviewExtras("reject", { rejectReason: "boring" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/spam, not_report, unusable, duplicate/);
    expect(reviewExtras("approve_private", { rejectReason: "spam" }).ok).toBe(false);
  });

  it("refuses overrides with any decision but approve_public", () => {
    expect(reviewExtras("reject", { overrides: { title: "x" } }).ok).toBe(false);
    expect(reviewExtras("approve_private", { overrides: {} }).ok).toBe(false);
  });

  it("requires an integer severity 1-5", () => {
    for (const severity of [0, 6, 2.5, -1]) {
      const result = reviewExtras("approve_public", { overrides: { severity } });
      expect(result.ok).toBe(false);
    }
    expect(reviewExtras("approve_public", { overrides: { severity: 5 } })).toMatchObject({
      ok: true,
      overrides: { severity: 5 },
    });
  });

  it("phone-redacts title and description overrides", () => {
    const result = reviewExtras("approve_public", {
      overrides: { title: "Call +249 912 345 678", description: "Reporter on 0912345678 says the bridge fell" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides.title).not.toMatch(/912/);
    expect(result.overrides.description).not.toMatch(/0912345678/);
    expect(result.overrides.description).toContain("says the bridge fell");
  });

  it("trims text overrides and treats blank or null as not overridden", () => {
    expect(
      reviewExtras("approve_public", {
        overrides: { title: "  Flooding in Nyala  ", description: "   ", severity: null, locationId: "" },
      }),
    ).toEqual({ ok: true, rejectReason: null, overrides: { title: "Flooding in Nyala" } });
  });
});

describe("reviewGroundThread resolver", () => {
  const thread: StubThread = {
    id: "t1",
    reviewState: "unverified",
    source: { reviewerRoles: ["admin", "analyst"] },
  };

  it("applies a valid decision and records the reviewer", async () => {
    const { context, updates } = buildContext({ id: "u1", role: "analyst" }, thread);
    const result = await reviewGroundThread(
      null,
      { id: "t1", decision: "approve_private", note: "looks credible" },
      context,
    );
    expect(result.reviewState).toBe("approved_private");
    expect(result.reviewedBy).toBe("u1");
    expect(result.reviewNote).toBe("looks credible");
    expect(updates).toHaveLength(1);
  });

  it("rejects viewers before touching the thread", async () => {
    const { context, updates } = buildContext({ id: "u1", role: "viewer" }, thread);
    await expect(
      reviewGroundThread(null, { id: "t1", decision: "reject" }, context),
    ).rejects.toThrowError(GraphQLError);
    expect(updates).toHaveLength(0);
  });

  it("enforces the per-source reviewerRoles policy", async () => {
    const restricted: StubThread = { ...thread, source: { reviewerRoles: ["admin"] } };
    const { context, updates } = buildContext({ id: "u1", role: "analyst" }, restricted);
    await expect(
      reviewGroundThread(null, { id: "t1", decision: "reject" }, context),
    ).rejects.toThrow(/requires one of: admin/);
    expect(updates).toHaveLength(0);

    // …but a platform admin passes the same policy.
    const asAdmin = buildContext({ id: "u2", role: "admin" }, restricted);
    const result = await reviewGroundThread(
      null,
      { id: "t1", decision: "reject" },
      asAdmin.context,
    );
    expect(result.reviewState).toBe("rejected");
  });

  it("refuses invalid transitions with the state machine's reason", async () => {
    const promoted: StubThread = { ...thread, reviewState: "approved_public" };
    const { context, updates } = buildContext({ id: "u1", role: "admin" }, promoted);
    await expect(
      reviewGroundThread(null, { id: "t1", decision: "reject" }, context),
    ).rejects.toThrow(/final/);
    expect(updates).toHaveLength(0);
  });

  it("stores the structured rejectReason on reject", async () => {
    const { context, updates } = buildContext({ id: "u1", role: "analyst" }, thread);
    const result = await reviewGroundThread(
      null,
      { id: "t1", decision: "reject", rejectReason: "spam", note: "spam: Spam" },
      context,
    );
    expect(result.reviewState).toBe("rejected");
    expect(updates[0]!.data.rejectReason).toBe("spam");
    expect(updates[0]!.data.reviewNote).toBe("spam: Spam");
  });

  it("clears rejectReason when a rejected thread is re-approved", async () => {
    const rejected: StubThread = { ...thread, reviewState: "rejected" };
    const { context, updates } = buildContext({ id: "u1", role: "analyst" }, rejected);
    await reviewGroundThread(null, { id: "t1", decision: "approve_private" }, context);
    expect(updates[0]!.data.rejectReason).toBeNull();
  });

  it("refuses a bad rejectReason or overrides before touching the thread", async () => {
    const { context, updates } = buildContext({ id: "u1", role: "analyst" }, thread);
    await expect(
      reviewGroundThread(null, { id: "t1", decision: "reject", rejectReason: "boring" }, context),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(
      reviewGroundThread(null, { id: "t1", decision: "reject", overrides: { title: "x" } }, context),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(updates).toHaveLength(0);
  });

  it("refuses an overrides.locationId that doesn't exist, before promoting", async () => {
    const { context, updates } = buildContext({ id: "u1", role: "analyst" }, thread, ["loc_known"]);
    await expect(
      reviewGroundThread(
        null,
        { id: "t1", decision: "approve_public", overrides: { locationId: "loc_ghost" } },
        context,
      ),
    ).rejects.toThrow(/location not found/);
    expect(updates).toHaveLength(0);
  });

  it("404s on a missing thread", async () => {
    const { context } = buildContext({ id: "u1", role: "admin" }, null);
    await expect(
      reviewGroundThread(null, { id: "missing", decision: "reject" }, context),
    ).rejects.toThrow(/not found/i);
  });
});
