/**
 * Briefs: an admin's hand-picked summary of one area over one Brief window,
 * emailed to a Recipient list. Every resolver here is platform-admin only
 * and calls `requireRole(context, ["admin"])` before anything else.
 */

import { randomBytes } from "node:crypto";
import { GraphQLError } from "graphql";
import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import type { BriefCadence, BriefItemKind } from "../generated/prisma/enums.js";
import { requireRole } from "../utils/auth-guard.js";
import {
  briefUnsubscribeUrl,
  briefWindow,
  buildBriefItemSnapshot,
  computeBriefCounts,
  computeDigestPreview,
  type BriefCounts,
  defaultBriefTitle,
  orderBriefItems,
  toBriefEmailView,
} from "../services/briefs.js";
import { getEmailProvider } from "../services/messaging/registry.js";
import { brief as briefEmail } from "../services/messaging/templates.js";

const ADMIN = ["admin"];
/** Generous ceiling for the freeze transaction: one read and write per item. */
const SEND_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_BRIEFS_PAGE = 200;
/** Areas a Brief can cover: country (0), state (1), district (2). */
const MAX_BRIEF_LOCATION_LEVEL = 2;

function notFound(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "NOT_FOUND" } });
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

/** Load a Brief that may still change: NOT_FOUND, or BAD_USER_INPUT once sent. */
async function loadDraftBrief(prisma: Context["prisma"], id: string) {
  const row = await prisma.brief.findUnique({ where: { id } });
  if (!row) throw notFound("Brief not found");
  if (row.status !== "draft") throw badInput("Brief already sent");
  return row;
}

/**
 * Write to a draft Brief. The write is conditional on `status = draft`, so a
 * send that lands between the check and the write can't be overwritten.
 */
async function updateDraftBrief(
  prisma: Context["prisma"],
  id: string,
  data: Prisma.briefUpdateManyMutationInput,
) {
  await loadDraftBrief(prisma, id);
  const { count } = await prisma.brief.updateMany({ where: { id, status: "draft" }, data });
  if (count === 0) throw badInput("Brief already sent");
  return prisma.brief.findUniqueOrThrow({ where: { id } });
}

/**
 * Inside a transaction, lock a Brief's row (`FOR UPDATE`) and require it to
 * still be a draft. `addBriefItem` and `sendBrief` both take this lock, so a
 * pick can't land on a Brief a send has already frozen, and picks into one
 * Brief are serialised (no two get the same position).
 */
async function lockDraftBrief(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ status: string; window_start: Date; window_end: Date }[]>`
    SELECT status::text AS status, window_start, window_end FROM briefs WHERE id = ${id} FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw notFound("Brief not found");
  if (row.status !== "draft") throw badInput("Brief already sent");
  return { windowStart: row.window_start, windowEnd: row.window_end };
}

/** Where-clause for an item whose Brief is still a draft. */
function draftItemWhere(id: string): Prisma.briefItemWhereInput {
  return { id, brief: { status: "draft" } };
}

/** Load an item whose Brief may still change. */
async function loadDraftItem(prisma: Context["prisma"], itemId: string) {
  const item = await prisma.briefItem.findUnique({
    where: { id: itemId },
    include: { brief: { select: { status: true } } },
  });
  if (!item) throw notFound("Brief item not found");
  if (item.brief.status !== "draft") throw badInput("Brief already sent");
  return item;
}

/** Loose shape check; delivery is the real test. Lower-cased and trimmed. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_LIST_NAME_LENGTH = 120;

function normaliseEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
    throw badInput("Not a valid email address");
  }
  return email;
}

/** An unguessable token for one member's unsubscribe link. */
function newUnsubscribeToken(): string {
  return randomBytes(24).toString("base64url");
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

interface UpdateBriefInput {
  title?: string | null;
  summary?: string | null;
  closingNotes?: string | null;
}

interface CreateBriefInput {
  cadence: BriefCadence;
  locationId: string;
  title?: string | null;
}

export const briefResolvers = {
  Query: {
    briefs: async (
      _parent: unknown,
      args: { limit?: number | null; offset?: number | null },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const take = Math.min(Math.max(args.limit ?? 50, 1), MAX_BRIEFS_PAGE);
      const skip = Math.max(args.offset ?? 0, 0);
      return context.prisma.brief.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        skip,
      });
    },

    brief: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireRole(context, ADMIN);
      return context.prisma.brief.findUnique({ where: { id: args.id } });
    },

    recipientLists: async (_parent: unknown, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      return context.prisma.recipientList.findMany({ orderBy: { name: "asc" } });
    },

    briefDigestPreview: async (_parent: unknown, args: { briefId: string }, context: Context) => {
      requireRole(context, ADMIN);
      const row = await context.prisma.brief.findUnique({ where: { id: args.briefId } });
      if (!row) throw notFound("Brief not found");
      return computeDigestPreview(context.prisma, row);
    },
  },

  Mutation: {
    createBrief: async (
      _parent: unknown,
      args: { input: CreateBriefInput },
      context: Context,
    ) => {
      const user = requireRole(context, ADMIN);
      const { cadence, locationId } = args.input;
      const location = await context.prisma.locations.findUnique({
        where: { id: locationId },
        select: { name: true, level: true },
      });
      if (!location) throw notFound("Location not found");
      if (location.level > MAX_BRIEF_LOCATION_LEVEL) {
        throw badInput("A Brief covers a country, state or district");
      }
      const title = args.input.title?.trim() || defaultBriefTitle(cadence, location.name);
      return context.prisma.brief.create({
        data: {
          cadence,
          title,
          locationId,
          locationName: location.name,
          ...briefWindow(cadence),
          createdById: user.id,
        },
      });
    },

    updateBrief: async (
      _parent: unknown,
      args: { id: string; input: UpdateBriefInput },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const { title, summary, closingNotes } = args.input;
      if (title != null && !title.trim()) throw badInput("A Brief needs a title");
      return updateDraftBrief(context.prisma, args.id, {
        ...(title != null ? { title: title.trim() } : {}),
        ...(summary != null ? { summary } : {}),
        ...(closingNotes != null ? { closingNotes } : {}),
      });
    },

    refreshBriefWindow: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireRole(context, ADMIN);
      const row = await loadDraftBrief(context.prisma, args.id);
      return updateDraftBrief(context.prisma, args.id, briefWindow(row.cadence));
    },

    deleteBrief: async (_parent: unknown, args: { id: string }, context: Context) => {
      requireRole(context, ADMIN);
      await loadDraftBrief(context.prisma, args.id);
      // Conditional on draft so a send racing this delete can't lose its record.
      const { count } = await context.prisma.brief.deleteMany({
        where: { id: args.id, status: "draft" },
      });
      if (count === 0) throw badInput("Brief already sent");
      return true;
    },

    addBriefItem: async (
      _parent: unknown,
      args: { briefId: string; kind: BriefItemKind; entityId: string },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const { briefId, kind, entityId } = args;
      await loadDraftBrief(context.prisma, briefId);

      const existing = await context.prisma.briefItem.findUnique({
        where: { briefId_kind_entityId: { briefId, kind, entityId } },
      });
      if (existing) return existing;

      const snapshot = await buildBriefItemSnapshot(context.prisma, kind, entityId);
      if (!snapshot) throw notFound(`No ${kind} with id ${entityId}`);

      return context.prisma.$transaction(async (tx) => {
        await lockDraftBrief(tx, briefId);
        const again = await tx.briefItem.findUnique({
          where: { briefId_kind_entityId: { briefId, kind, entityId } },
        });
        if (again) return again;
        const last = await tx.briefItem.aggregate({
          where: { briefId, kind },
          _max: { position: true },
        });
        const position = (last._max.position ?? -1) + 1;
        return tx.briefItem.create({
          data: { briefId, kind, entityId, position, snapshot: { ...snapshot } },
        });
      });
    },

    removeBriefItem: async (_parent: unknown, args: { itemId: string }, context: Context) => {
      requireRole(context, ADMIN);
      await loadDraftItem(context.prisma, args.itemId);
      const { count } = await context.prisma.briefItem.deleteMany({
        where: draftItemWhere(args.itemId),
      });
      if (count === 0) throw badInput("Brief already sent");
      return true;
    },

    updateBriefItemNote: async (
      _parent: unknown,
      args: { itemId: string; note?: string | null },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      await loadDraftItem(context.prisma, args.itemId);
      const note = args.note?.trim() ? args.note : null;
      const { count } = await context.prisma.briefItem.updateMany({
        where: draftItemWhere(args.itemId),
        data: { note },
      });
      if (count === 0) throw badInput("Brief already sent");
      return context.prisma.briefItem.findUniqueOrThrow({ where: { id: args.itemId } });
    },

    reorderBriefItems: async (
      _parent: unknown,
      args: { briefId: string; kind: BriefItemKind; itemIds: string[] },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const { briefId, kind, itemIds } = args;
      await loadDraftBrief(context.prisma, briefId);
      const group = await context.prisma.briefItem.findMany({
        where: { briefId, kind },
        select: { id: true },
      });
      const current = new Set(group.map((i) => i.id));
      if (
        itemIds.length !== current.size ||
        new Set(itemIds).size !== itemIds.length ||
        !itemIds.every((id) => current.has(id))
      ) {
        throw badInput(`itemIds must list every ${kind} item of the Brief exactly once`);
      }
      const writes = await context.prisma.$transaction(
        itemIds.map((id, position) =>
          context.prisma.briefItem.updateMany({ where: draftItemWhere(id), data: { position } }),
        ),
      );
      if (writes.some((w) => w.count === 0)) throw badInput("Brief already sent");
      return orderBriefItems(
        await context.prisma.briefItem.findMany({ where: { briefId, kind } }),
      );
    },

    createRecipientList: async (_parent: unknown, args: { name: string }, context: Context) => {
      const user = requireRole(context, ADMIN);
      const name = args.name.trim();
      if (!name) throw badInput("A Recipient list needs a name");
      if (name.length > MAX_LIST_NAME_LENGTH) throw badInput("Recipient list name is too long");
      try {
        return await context.prisma.recipientList.create({ data: { name, createdById: user.id } });
      } catch (e) {
        if (isUniqueViolation(e)) throw badInput(`A Recipient list named "${name}" already exists`);
        throw e;
      }
    },

    addRecipientListMember: async (
      _parent: unknown,
      args: { listId: string; email: string },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const email = normaliseEmail(args.email);
      const list = await context.prisma.recipientList.findUnique({
        where: { id: args.listId },
        select: { id: true },
      });
      if (!list) throw notFound("Recipient list not found");
      // An address already on the list is returned as it is: re-adding
      // never clears an unsubscribe. Remove and add it again to do that.
      return context.prisma.recipientListMember.upsert({
        where: { listId_email: { listId: list.id, email } },
        create: { listId: list.id, email, unsubscribeToken: newUnsubscribeToken() },
        update: {},
      });
    },

    removeRecipientListMember: async (
      _parent: unknown,
      args: { memberId: string },
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      const { count } = await context.prisma.recipientListMember.deleteMany({
        where: { id: args.memberId },
      });
      if (count === 0) throw notFound("Recipient list member not found");
      return true;
    },

    sendBrief: async (
      _parent: unknown,
      args: { id: string; recipientListId: string },
      context: Context,
    ) => {
      const user = requireRole(context, ADMIN);
      const { prisma } = context;
      const draft = await loadDraftBrief(prisma, args.id);
      const list = await prisma.recipientList.findUnique({
        where: { id: args.recipientListId },
        select: { id: true },
      });
      if (!list) throw notFound("Recipient list not found");
      const members = await prisma.recipientListMember.findMany({
        where: { listId: list.id, unsubscribedAt: null },
        select: { email: true, unsubscribeToken: true },
      });
      if (members.length === 0) throw badInput("The Recipient list has no one to send to");

      // Counts run raw SQL over the area's descendants: compute them before
      // the transaction so it only holds the snapshot reads and writes.
      const counts = await computeBriefCounts(prisma, draft);

      // Freeze under the Brief's row lock: of two racing sends exactly one
      // freezes and emails, and a pick racing the send waits for it.
      await prisma.$transaction(
        async (tx) => {
          const locked = await lockDraftBrief(tx, draft.id);
          // The counts were computed for the window read above. A Refresh to
          // now in between would freeze counts for the wrong window.
          if (
            locked.windowStart.getTime() !== draft.windowStart.getTime() ||
            locked.windowEnd.getTime() !== draft.windowEnd.getTime()
          ) {
            throw badInput("The Brief's window changed while sending. Send it again.");
          }
          const { count } = await tx.brief.updateMany({
            where: { id: draft.id, status: "draft" },
            data: {
              status: "sent",
              sentAt: new Date(),
              sentById: user.id,
              sentToListId: list.id,
              countsSnapshot: counts as unknown as Prisma.InputJsonObject,
            },
          });
          if (count === 0) throw badInput("Brief already sent");
          const items = await tx.briefItem.findMany({ where: { briefId: draft.id } });
          for (const item of items) {
            // An entity the pipeline has since merged or deleted keeps the
            // snapshot it was picked with.
            const live = await buildBriefItemSnapshot(tx, item.kind, item.entityId);
            if (live) {
              await tx.briefItem.update({ where: { id: item.id }, data: { snapshot: { ...live } } });
            }
          }
        },
        { timeout: SEND_TRANSACTION_TIMEOUT_MS },
      );

      const frozen = await prisma.brief.findUniqueOrThrow({
        where: { id: draft.id },
        include: { items: true },
      });
      const view = toBriefEmailView(frozen, frozen.items, counts);
      const messages = members.map((m) => ({
        to: m.email,
        ...briefEmail(view, { unsubscribeUrl: briefUnsubscribeUrl(m.unsubscribeToken), isTest: false }),
      }));

      // No automatic retry: a resend could email someone twice. Failures
      // are reported and stored instead.
      let results: boolean[];
      try {
        const provider = await getEmailProvider();
        results = await provider.sendBulk(messages);
      } catch (err) {
        console.error("[BRIEFS] sendBulk failed:", err instanceof Error ? err.message : err);
        results = messages.map(() => false);
      }
      const sent = results.filter(Boolean).length;
      const failed = messages.length - sent;
      await prisma.brief.update({
        where: { id: draft.id },
        data: { sentCount: sent, failedCount: failed },
      });
      return { sent, failed };
    },

    sendBriefTest: async (_parent: unknown, args: { id: string; to?: string | null }, context: Context) => {
      const user = requireRole(context, ADMIN);
      // Blank or missing means the caller's own address.
      const to = args.to?.trim() ? normaliseEmail(args.to) : user.email;
      const row = await context.prisma.brief.findUnique({
        where: { id: args.id },
        include: { items: true },
      });
      if (!row) throw notFound("Brief not found");
      const counts =
        row.status === "sent" && row.countsSnapshot
          ? (row.countsSnapshot as unknown as BriefCounts)
          : await computeBriefCounts(context.prisma, row);
      const content = briefEmail(toBriefEmailView(row, row.items, counts), {
        unsubscribeUrl: null,
        isTest: true,
      });
      // Providers throw on some delivery errors and return false on others;
      // both are a refused test send.
      try {
        const provider = await getEmailProvider();
        return await provider.send({ to, ...content });
      } catch (err) {
        console.error("[BRIEFS] test send failed:", err instanceof Error ? err.message : err);
        return false;
      }
    },
  },

  Brief: {
    items: async (parent: { id: string; items?: unknown }, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      const items = await context.prisma.briefItem.findMany({ where: { briefId: parent.id } });
      return orderBriefItems(items);
    },

    counts: async (
      parent: {
        status: string;
        locationId: string;
        windowStart: Date;
        windowEnd: Date;
        countsSnapshot: unknown;
      },
      _args: unknown,
      context: Context,
    ) => {
      requireRole(context, ADMIN);
      // A sent Brief shows the counts it was sent with.
      if (parent.status === "sent" && parent.countsSnapshot) {
        return parent.countsSnapshot as BriefCounts;
      }
      return computeBriefCounts(context.prisma, parent);
    },
  },

  RecipientList: {
    members: async (parent: { id: string }, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      return context.prisma.recipientListMember.findMany({
        where: { listId: parent.id },
        orderBy: { email: "asc" },
      });
    },

    recipientCount: async (parent: { id: string }, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      return context.prisma.recipientListMember.count({
        where: { listId: parent.id, unsubscribedAt: null },
      });
    },
  },

  BriefItem: {
    snapshot: (parent: { snapshot: unknown }, _args: unknown, context: Context) => {
      requireRole(context, ADMIN);
      return parent.snapshot;
    },
  },
};
