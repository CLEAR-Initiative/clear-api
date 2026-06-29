/**
 * Unit tests for `feedback.resolver.ts`.
 *
 * DB-FREE: no real Prisma client and no database connection. Every
 * `context.prisma.*` delegate is a `vi.fn()` stub built per-test, and the
 * `../../src/utils/activity-log.js` module is mocked (its real
 * implementation calls `prisma.activityLogs.create`) so we can assert the
 * fire-and-forget audit call without persisting anything. These run in CI
 * with no Postgres.
 *
 * Coverage — the branches that carry real logic:
 *   - Auth gate on every mutation (requireAuth → UNAUTHENTICATED).
 *   - `exactlyOneTarget` input validation: zero targets and multiple
 *     targets both → BAD_USER_INPUT (exercised via addFeedback + addComment).
 *   - addFeedback: rating bounds (1..5) → BAD_USER_INPUT; happy path
 *     persists normalised data (nulls for absent targets) and fires the
 *     activity log with the correct target classification.
 *   - deleteFeedback / deleteComment: NOT_FOUND, ownership FORBIDDEN,
 *     admin override, and owner happy path.
 *   - addComment: tag fan-out only when tagUserIds is non-empty.
 *   - replyToComment: NOT_FOUND on missing parent; reply inherits the
 *     parent's target columns and stamps isCommentReply/repliedToCommentId.
 *   - tagUsersInComment: NOT_FOUND on missing comment; createMany args.
 *
 * Deliberately NOT tested: the field resolvers on UserFeedback /
 * UserComment / CommentTag (user/event/signal/crisis/tags/comment) are
 * trivial 1-line prisma passthroughs. The only non-trivial bit there is the
 * `if (!parent.xId) return null` short-circuit, which is covered once below
 * to lock in that behaviour; the rest are skipped as pure passthroughs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphQLError } from "graphql";

// Mock the activity-log module BEFORE importing the resolver. The real
// implementation writes to prisma.activityLogs; we replace it with a spy.
vi.mock("../../src/utils/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

import { feedbackResolvers } from "../../src/resolvers/feedback.resolver.js";
import { logActivity } from "../../src/utils/activity-log.js";
import type { Context } from "../../src/context.js";

const logActivityMock = vi.mocked(logActivity);

type User = { id: string; role: string } | null;

function buildContext(
  user: User,
  prisma: Record<string, unknown> = {},
): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const VIEWER = { id: "u1", role: "viewer" };
const ADMIN = { id: "admin1", role: "admin" };

const {
  addFeedback,
  deleteFeedback,
  addComment,
  replyToComment,
  deleteComment,
  tagUsersInComment,
} = feedbackResolvers.Mutation;

beforeEach(() => {
  logActivityMock.mockClear();
});

// ─── addFeedback ─────────────────────────────────────────────────────────────

describe("Mutation.addFeedback", () => {
  it("creates feedback for an event with nulled-out other targets, returns the row", async () => {
    const created = { id: "f1", userId: "u1", eventId: "e1", rating: 4 };
    const create = vi.fn().mockResolvedValue(created);
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });

    const result = await addFeedback(
      null,
      { input: { eventId: "e1", rating: 4, text: "good" } },
      ctx,
    );

    expect(result).toBe(created);
    expect(create.mock.calls[0][0].data).toEqual({
      userId: "u1",
      eventId: "e1",
      signalId: null,
      crisisId: null,
      rating: 4,
      text: "good",
    });
  });

  it("defaults text to null when omitted", async () => {
    const create = vi.fn().mockResolvedValue({ id: "f1" });
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await addFeedback(null, { input: { signalId: "s1", rating: 3 } }, ctx);
    expect(create.mock.calls[0][0].data.text).toBeNull();
  });

  it("fires the activity log with the resolved target classification", async () => {
    const create = vi.fn().mockResolvedValue({ id: "f9" });
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await addFeedback(
      null,
      { input: { crisisId: "c1", rating: 5, text: "hi" } },
      ctx,
    );
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    const [, opts] = logActivityMock.mock.calls[0];
    expect(opts).toMatchObject({
      userId: "u1",
      action: "feedback.create",
      resourceType: "feedback",
      resourceId: "f9",
      metadata: { rating: 5, target: "crisis", targetId: "c1", hasText: true },
    });
  });

  it("reports hasText: false when no text supplied", async () => {
    const create = vi.fn().mockResolvedValue({ id: "f1" });
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await addFeedback(null, { input: { eventId: "e1", rating: 2 } }, ctx);
    expect(logActivityMock.mock.calls[0][1].metadata).toMatchObject({
      target: "event",
      targetId: "e1",
      hasText: false,
    });
  });

  it("throws BAD_USER_INPUT when no target is provided", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await expect(
      addFeedback(null, { input: { rating: 3 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT when more than one target is provided", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await expect(
      addFeedback(null, { input: { eventId: "e1", signalId: "s1", rating: 3 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT when rating is below 1", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await expect(
      addFeedback(null, { input: { eventId: "e1", rating: 0 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT when rating is above 5", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
    await expect(
      addFeedback(null, { input: { eventId: "e1", rating: 6 } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts the boundary ratings 1 and 5", async () => {
    for (const rating of [1, 5]) {
      const create = vi.fn().mockResolvedValue({ id: "f1" });
      const ctx = buildContext(VIEWER, { userFeedbacks: { create } });
      await addFeedback(null, { input: { eventId: "e1", rating } }, ctx);
      expect(create).toHaveBeenCalledOnce();
    }
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      addFeedback(null, { input: { eventId: "e1", rating: 3 } }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

// ─── deleteFeedback ──────────────────────────────────────────────────────────

describe("Mutation.deleteFeedback", () => {
  it("deletes the caller's own feedback and returns true", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext(VIEWER, {
      userFeedbacks: {
        findUnique: vi.fn().mockResolvedValue({ id: "f1", userId: "u1" }),
        delete: del,
      },
    });
    await expect(deleteFeedback(null, { id: "f1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "f1" } });
  });

  it("lets an admin delete another user's feedback", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext(ADMIN, {
      userFeedbacks: {
        findUnique: vi.fn().mockResolvedValue({ id: "f1", userId: "someone" }),
        delete: del,
      },
    });
    await expect(deleteFeedback(null, { id: "f1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledOnce();
  });

  it("throws NOT_FOUND when the feedback does not exist", async () => {
    const del = vi.fn();
    const ctx = buildContext(VIEWER, {
      userFeedbacks: { findUnique: vi.fn().mockResolvedValue(null), delete: del },
    });
    await expect(deleteFeedback(null, { id: "missing" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when a non-admin deletes someone else's feedback", async () => {
    const del = vi.fn();
    const ctx = buildContext(VIEWER, {
      userFeedbacks: {
        findUnique: vi.fn().mockResolvedValue({ id: "f1", userId: "other" }),
        delete: del,
      },
    });
    await expect(deleteFeedback(null, { id: "f1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      deleteFeedback(null, { id: "f1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

// ─── addComment ──────────────────────────────────────────────────────────────

describe("Mutation.addComment", () => {
  it("creates a non-reply comment with nulled-out other targets", async () => {
    const created = { id: "c1" };
    const create = vi.fn().mockResolvedValue(created);
    const createMany = vi.fn();
    const ctx = buildContext(VIEWER, {
      userComments: { create },
      commentTags: { createMany },
    });

    const result = await addComment(
      null,
      { input: { signalId: "s1", comment: "hello" } },
      ctx,
    );

    expect(result).toBe(created);
    expect(create.mock.calls[0][0].data).toEqual({
      userId: "u1",
      eventId: null,
      signalId: "s1",
      crisisId: null,
      comment: "hello",
      isCommentReply: false,
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("fans out comment tags when tagUserIds is non-empty", async () => {
    const create = vi.fn().mockResolvedValue({ id: "c1" });
    const createMany = vi.fn().mockResolvedValue({});
    const ctx = buildContext(VIEWER, {
      userComments: { create },
      commentTags: { createMany },
    });
    await addComment(
      null,
      { input: { eventId: "e1", comment: "hi", tagUserIds: ["a", "b"] } },
      ctx,
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { userId: "a", commentId: "c1" },
        { userId: "b", commentId: "c1" },
      ],
      skipDuplicates: true,
    });
  });

  it("does not fan out tags for an empty tagUserIds array", async () => {
    const create = vi.fn().mockResolvedValue({ id: "c1" });
    const createMany = vi.fn();
    const ctx = buildContext(VIEWER, {
      userComments: { create },
      commentTags: { createMany },
    });
    await addComment(
      null,
      { input: { eventId: "e1", comment: "hi", tagUserIds: [] } },
      ctx,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it("throws BAD_USER_INPUT when no target is provided", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, { userComments: { create } });
    await expect(
      addComment(null, { input: { comment: "hi" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      addComment(null, { input: { eventId: "e1", comment: "hi" } }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

// ─── replyToComment ──────────────────────────────────────────────────────────

describe("Mutation.replyToComment", () => {
  it("inherits the parent's target columns and stamps reply metadata", async () => {
    const parent = {
      id: "c1",
      eventId: "e1",
      signalId: null,
      crisisId: null,
    };
    const create = vi.fn().mockResolvedValue({ id: "c2" });
    const ctx = buildContext(VIEWER, {
      userComments: {
        findUnique: vi.fn().mockResolvedValue(parent),
        create,
      },
    });

    await replyToComment(
      null,
      { input: { repliedToCommentId: "c1", comment: "re" } },
      ctx,
    );

    expect(create.mock.calls[0][0].data).toEqual({
      userId: "u1",
      eventId: "e1",
      signalId: null,
      crisisId: null,
      comment: "re",
      isCommentReply: true,
      repliedToCommentId: "c1",
    });
  });

  it("fans out tags on the reply when tagUserIds is non-empty", async () => {
    const create = vi.fn().mockResolvedValue({ id: "c2" });
    const createMany = vi.fn().mockResolvedValue({});
    const ctx = buildContext(VIEWER, {
      userComments: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", eventId: "e1", signalId: null, crisisId: null }),
        create,
      },
      commentTags: { createMany },
    });
    await replyToComment(
      null,
      { input: { repliedToCommentId: "c1", comment: "re", tagUserIds: ["x"] } },
      ctx,
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [{ userId: "x", commentId: "c2" }],
      skipDuplicates: true,
    });
  });

  it("throws NOT_FOUND when the parent comment does not exist", async () => {
    const create = vi.fn();
    const ctx = buildContext(VIEWER, {
      userComments: { findUnique: vi.fn().mockResolvedValue(null), create },
    });
    await expect(
      replyToComment(null, { input: { repliedToCommentId: "gone", comment: "re" } }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      replyToComment(
        null,
        { input: { repliedToCommentId: "c1", comment: "re" } },
        buildContext(null),
      ),
    ).rejects.toThrow(GraphQLError);
  });
});

// ─── deleteComment ───────────────────────────────────────────────────────────

describe("Mutation.deleteComment", () => {
  it("deletes the caller's own comment and returns true", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext(VIEWER, {
      userComments: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", userId: "u1" }),
        delete: del,
      },
    });
    await expect(deleteComment(null, { id: "c1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("lets an admin delete another user's comment", async () => {
    const del = vi.fn().mockResolvedValue({});
    const ctx = buildContext(ADMIN, {
      userComments: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", userId: "other" }),
        delete: del,
      },
    });
    await expect(deleteComment(null, { id: "c1" }, ctx)).resolves.toBe(true);
    expect(del).toHaveBeenCalledOnce();
  });

  it("throws NOT_FOUND when the comment does not exist", async () => {
    const del = vi.fn();
    const ctx = buildContext(VIEWER, {
      userComments: { findUnique: vi.fn().mockResolvedValue(null), delete: del },
    });
    await expect(deleteComment(null, { id: "missing" }, ctx)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws FORBIDDEN when a non-admin deletes someone else's comment", async () => {
    const del = vi.fn();
    const ctx = buildContext(VIEWER, {
      userComments: {
        findUnique: vi.fn().mockResolvedValue({ id: "c1", userId: "other" }),
        delete: del,
      },
    });
    await expect(deleteComment(null, { id: "c1" }, ctx)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      deleteComment(null, { id: "c1" }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

// ─── tagUsersInComment ───────────────────────────────────────────────────────

describe("Mutation.tagUsersInComment", () => {
  it("tags the requested users and returns the comment", async () => {
    const comment = { id: "c1" };
    const createMany = vi.fn().mockResolvedValue({});
    const ctx = buildContext(VIEWER, {
      userComments: { findUnique: vi.fn().mockResolvedValue(comment) },
      commentTags: { createMany },
    });

    const result = await tagUsersInComment(
      null,
      { commentId: "c1", userIds: ["a", "b"] },
      ctx,
    );

    expect(result).toBe(comment);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { userId: "a", commentId: "c1" },
        { userId: "b", commentId: "c1" },
      ],
      skipDuplicates: true,
    });
  });

  it("throws NOT_FOUND when the comment does not exist", async () => {
    const createMany = vi.fn();
    const ctx = buildContext(VIEWER, {
      userComments: { findUnique: vi.fn().mockResolvedValue(null) },
      commentTags: { createMany },
    });
    await expect(
      tagUsersInComment(null, { commentId: "missing", userIds: ["a"] }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("throws UNAUTHENTICATED when not logged in", async () => {
    await expect(
      tagUsersInComment(null, { commentId: "c1", userIds: ["a"] }, buildContext(null)),
    ).rejects.toThrow(GraphQLError);
  });
});

// ─── Field resolver short-circuit (the one non-trivial field branch) ─────────

describe("UserComment field resolvers — null target short-circuit", () => {
  it("returns null without hitting prisma when the target id is null", () => {
    const findUnique = vi.fn();
    const ctx = buildContext(VIEWER, { events: { findUnique } });
    const result = feedbackResolvers.UserComment.event(
      { eventId: null },
      {},
      ctx,
    );
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("delegates to prisma when the target id is present", () => {
    const row = { id: "e1" };
    const findUnique = vi.fn().mockReturnValue(row);
    const ctx = buildContext(VIEWER, { events: { findUnique } });
    const result = feedbackResolvers.UserComment.event(
      { eventId: "e1" },
      {},
      ctx,
    );
    expect(result).toBe(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "e1" } });
  });
});
