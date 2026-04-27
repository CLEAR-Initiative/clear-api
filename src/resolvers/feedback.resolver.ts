import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface AddFeedbackInput {
  eventId?: string;
  signalId?: string;
  crisisId?: string;
  rating: number;
  text?: string;
}

interface AddCommentInput {
  eventId?: string;
  signalId?: string;
  crisisId?: string;
  comment: string;
  tagUserIds?: string[];
}

function exactlyOneTarget(
  eventId: string | undefined,
  signalId: string | undefined,
  crisisId: string | undefined,
): void {
  const provided = [eventId, signalId, crisisId].filter(Boolean).length;
  if (provided === 0) {
    throw new GraphQLError("Provide one of eventId, signalId, or crisisId", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (provided > 1) {
    throw new GraphQLError("Provide only one of eventId, signalId, or crisisId", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
}

interface ReplyToCommentInput {
  repliedToCommentId: string;
  comment: string;
  tagUserIds?: string[];
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export const feedbackResolvers = {
  Mutation: {
    addFeedback: async (
      _parent: unknown,
      args: { input: AddFeedbackInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { eventId, signalId, crisisId, rating, text } = args.input;

      exactlyOneTarget(eventId, signalId, crisisId);
      if (rating < 1 || rating > 5) {
        throw new GraphQLError("Rating must be between 1 and 5", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      return context.prisma.userFeedbacks.create({
        data: {
          userId: user.id,
          eventId: eventId ?? null,
          signalId: signalId ?? null,
          crisisId: crisisId ?? null,
          rating,
          text: text ?? null,
        },
      });
    },

    deleteFeedback: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const feedback = await context.prisma.userFeedbacks.findUnique({
        where: { id: args.id },
      });
      if (!feedback) {
        throw new GraphQLError("Feedback not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (feedback.userId !== user.id && user.role !== "admin") {
        throw new GraphQLError("You can only delete your own feedback", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      await context.prisma.userFeedbacks.delete({ where: { id: args.id } });
      return true;
    },

    addComment: async (
      _parent: unknown,
      args: { input: AddCommentInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { eventId, signalId, crisisId, comment, tagUserIds } = args.input;

      exactlyOneTarget(eventId, signalId, crisisId);

      const created = await context.prisma.userComments.create({
        data: {
          userId: user.id,
          eventId: eventId ?? null,
          signalId: signalId ?? null,
          crisisId: crisisId ?? null,
          comment,
          isCommentReply: false,
        },
      });

      if (tagUserIds?.length) {
        await context.prisma.commentTags.createMany({
          data: tagUserIds.map((userId) => ({
            userId,
            commentId: created.id,
          })),
          skipDuplicates: true,
        });
      }

      return created;
    },

    replyToComment: async (
      _parent: unknown,
      args: { input: ReplyToCommentInput },
      context: Context,
    ) => {
      const user = requireAuth(context);
      const { repliedToCommentId, comment, tagUserIds } = args.input;

      const parentComment = await context.prisma.userComments.findUnique({
        where: { id: repliedToCommentId },
      });
      if (!parentComment) {
        throw new GraphQLError("Comment not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      const created = await context.prisma.userComments.create({
        data: {
          userId: user.id,
          eventId: parentComment.eventId,
          signalId: parentComment.signalId,
          crisisId: parentComment.crisisId,
          comment,
          isCommentReply: true,
          repliedToCommentId,
        },
      });

      if (tagUserIds?.length) {
        await context.prisma.commentTags.createMany({
          data: tagUserIds.map((userId) => ({
            userId,
            commentId: created.id,
          })),
          skipDuplicates: true,
        });
      }

      return created;
    },

    deleteComment: async (
      _parent: unknown,
      args: { id: string },
      context: Context,
    ) => {
      const user = requireAuth(context);

      const comment = await context.prisma.userComments.findUnique({
        where: { id: args.id },
      });
      if (!comment) {
        throw new GraphQLError("Comment not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (comment.userId !== user.id && user.role !== "admin") {
        throw new GraphQLError("You can only delete your own comments", {
          extensions: { code: "FORBIDDEN" },
        });
      }

      await context.prisma.userComments.delete({ where: { id: args.id } });
      return true;
    },

    tagUsersInComment: async (
      _parent: unknown,
      args: { commentId: string; userIds: string[] },
      context: Context,
    ) => {
      requireAuth(context);

      const comment = await context.prisma.userComments.findUnique({
        where: { id: args.commentId },
      });
      if (!comment) {
        throw new GraphQLError("Comment not found", {
          extensions: { code: "NOT_FOUND" },
        });
      }

      await context.prisma.commentTags.createMany({
        data: args.userIds.map((userId) => ({
          userId,
          commentId: args.commentId,
        })),
        skipDuplicates: true,
      });

      return comment;
    },
  },

  UserFeedback: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    event: (parent: { eventId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.eventId) return null;
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
    signal: (parent: { signalId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.signalId) return null;
      return prisma.signals.findUnique({ where: { id: parent.signalId } });
    },
    crisis: (parent: { crisisId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.crisisId) return null;
      return prisma.crises.findUnique({ where: { id: parent.crisisId } });
    },
  },

  UserComment: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    event: (parent: { eventId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.eventId) return null;
      return prisma.events.findUnique({ where: { id: parent.eventId } });
    },
    signal: (parent: { signalId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.signalId) return null;
      return prisma.signals.findUnique({ where: { id: parent.signalId } });
    },
    crisis: (parent: { crisisId: string | null }, _args: unknown, { prisma }: Context) => {
      if (!parent.crisisId) return null;
      return prisma.crises.findUnique({ where: { id: parent.crisisId } });
    },
    tags: (parent: { id: string }, _args: unknown, { prisma }: Context) => {
      return prisma.commentTags.findMany({ where: { commentId: parent.id } });
    },
  },

  CommentTag: {
    user: (parent: { userId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.user.findUnique({ where: { id: parent.userId } });
    },
    comment: (parent: { commentId: string }, _args: unknown, { prisma }: Context) => {
      return prisma.userComments.findUnique({ where: { id: parent.commentId } });
    },
  },
};
