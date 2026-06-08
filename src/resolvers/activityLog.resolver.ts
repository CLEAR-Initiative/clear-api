import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { requireRole } from "../utils/auth-guard.js";

/** Default `activityStats` window when the caller doesn't specify one. */
const DEFAULT_STATS_WINDOW_DAYS = 30;

/** Maximum rows returned by `activityLogs` in one call. Generous because the
 *  table is well-indexed and the admin dashboard occasionally exports CSV. */
const MAX_LIMIT = 500;

/** Top-N users surfaced in the per-user breakdown of `activityStats`. */
const TOP_USERS = 50;

/** Canonical actions tracked today. New actions added to the
 *  `ActivityAction` union in `utils/activity-log.ts` should be mirrored
 *  here so the aggregate-counts buckets stay in sync. */
const TRACKED_ACTIONS = [
  "auth.login",
  "signal.create_manual",
  "event.create",
  "alert.create",
  "crisis.create",
  "feedback.create",
] as const;

function makeEmptyCounts() {
  return {
    login: 0,
    signalCreateManual: 0,
    eventCreate: 0,
    alertCreate: 0,
    crisisCreate: 0,
    feedbackCreate: 0,
    total: 0,
  };
}

type CountBucket = ReturnType<typeof makeEmptyCounts>;

function bumpBucket(b: CountBucket, action: string): void {
  switch (action) {
    case "auth.login":            b.login++;              b.total++; return;
    case "signal.create_manual":  b.signalCreateManual++; b.total++; return;
    case "event.create":          b.eventCreate++;        b.total++; return;
    case "alert.create":          b.alertCreate++;        b.total++; return;
    case "crisis.create":         b.crisisCreate++;       b.total++; return;
    case "feedback.create":       b.feedbackCreate++;     b.total++; return;
    // Unknown actions land in `total` only — keeps the per-bucket numbers
    // tight to the spec while still counting toward overall activity.
    default:                                              b.total++; return;
  }
}

interface ActivityLogFilterInput {
  userId?: string | null;
  action?: string | null;
  actionPrefix?: string | null;
  resourceType?: string | null;
  from?: Date | string | null;
  to?: Date | string | null;
}

/** Action name used to scope all DAU/WAU/MAU queries. Must stay in sync
 *  with the `auth.login` entry in `ActivityAction`. */
const LOGIN_ACTION = "auth.login";

/** Trailing-window sizes (in milliseconds) for the engagement metrics. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/**
 * Count distinct users who logged in within `[since, asOf]`. Uses raw SQL
 * because Prisma's groupBy can't do COUNT(DISTINCT user_id) cleanly. The
 * `(action, created_at)` index covers the WHERE clause.
 */
async function countDistinctLoginUsers(
  prisma: Context["prisma"],
  since: Date,
  asOf: Date,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT "user_id")::bigint AS count
    FROM "activity_logs"
    WHERE "action" = ${LOGIN_ACTION}
      AND "created_at" >= ${since}
      AND "created_at" <= ${asOf}
  `;
  return Number(rows[0]?.count ?? 0n);
}

export const activityLogResolvers = {
  Query: {
    activityLogs: async (
      _parent: unknown,
      args: {
        filter?: ActivityLogFilterInput | null;
        limit?: number | null;
        offset?: number | null;
      },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const limit = Math.min(args.limit ?? 50, MAX_LIMIT);
      const offset = Math.max(args.offset ?? 0, 0);
      const f = args.filter ?? {};

      const where: Prisma.activityLogsWhereInput = {};
      if (f.userId) where.userId = f.userId;
      if (f.action) where.action = f.action;
      if (f.actionPrefix) where.action = { startsWith: f.actionPrefix };
      if (f.resourceType) where.resourceType = f.resourceType;
      if (f.from || f.to) {
        where.createdAt = {};
        if (f.from) where.createdAt.gte = new Date(f.from);
        if (f.to) where.createdAt.lte = new Date(f.to);
      }

      return context.prisma.activityLogs.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      });
    },

    activityStats: async (
      _parent: unknown,
      args: { from?: Date | string | null; to?: Date | string | null },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const to = args.to ? new Date(args.to) : new Date();
      const from = args.from
        ? new Date(args.from)
        : new Date(to.getTime() - DEFAULT_STATS_WINDOW_DAYS * 86_400_000);

      // Single pass: pull everything in the window, then aggregate
      // in memory. The table is indexed on createdAt and the windows
      // we report are dashboard-sized (last 30d, last 90d), not
      // multi-year — for those, switch to grouped SQL.
      const rows = await context.prisma.activityLogs.findMany({
        where: {
          createdAt: { gte: from, lte: to },
          action: { in: [...TRACKED_ACTIONS] },
        },
        select: { userId: true, action: true, createdAt: true },
      });

      const totals = makeEmptyCounts();
      const byUserMap = new Map<string, CountBucket>();
      const byDayMap = new Map<string, CountBucket>();

      for (const row of rows) {
        bumpBucket(totals, row.action);

        let userBucket = byUserMap.get(row.userId);
        if (!userBucket) {
          userBucket = makeEmptyCounts();
          byUserMap.set(row.userId, userBucket);
        }
        bumpBucket(userBucket, row.action);

        const day = row.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
        let dayBucket = byDayMap.get(day);
        if (!dayBucket) {
          dayBucket = makeEmptyCounts();
          byDayMap.set(day, dayBucket);
        }
        bumpBucket(dayBucket, row.action);
      }

      // Top-N users by total. Tied counts → arbitrary tiebreak (stable
      // by insertion order from the Map iterator).
      const topUserIds = [...byUserMap.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, TOP_USERS)
        .map(([userId]) => userId);

      const users = topUserIds.length
        ? await context.prisma.user.findMany({
            where: { id: { in: topUserIds } },
          })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));

      const byUser = topUserIds
        .map((userId) => {
          const user = userById.get(userId);
          const counts = byUserMap.get(userId)!;
          return user ? { user, total: counts.total, counts } : null;
        })
        // Drop entries where the user was deleted between activity and
        // the query (cascade would normally remove the row, but we're
        // defensive in case of soft-deletes or replication lag).
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Daily breakdown sorted by date ascending so the dashboard can
      // plot it as a time-series without extra client-side work.
      const byDay = [...byDayMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, counts]) => ({ date, total: counts.total, counts }));

      return { from, to, totals, byUser, byDay };
    },

    userEngagement: async (
      _parent: unknown,
      args: { asOf?: Date | string | null },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const asOf = args.asOf ? new Date(args.asOf) : new Date();
      const dauSince = new Date(asOf.getTime() - ONE_DAY_MS);
      const wauSince = new Date(asOf.getTime() - SEVEN_DAYS_MS);
      const mauSince = new Date(asOf.getTime() - THIRTY_DAYS_MS);

      // Three independent index scans — the same WHERE shape with
      // different time bounds. Fine for dashboard cadence (this query
      // is unlikely to fire more than once per minute per viewer).
      const [dau, wau, mau] = await Promise.all([
        countDistinctLoginUsers(context.prisma, dauSince, asOf),
        countDistinctLoginUsers(context.prisma, wauSince, asOf),
        countDistinctLoginUsers(context.prisma, mauSince, asOf),
      ]);

      // DAU/MAU ratio as a percentage. Clamp the denominator to avoid a
      // division-by-zero NaN sneaking into the GraphQL response.
      const dauMauRatio = mau > 0 ? (dau / mau) * 100 : 0;

      return { asOf, dau, wau, mau, dauMauRatio };
    },

    dauSeries: async (
      _parent: unknown,
      args: { from: Date | string; to: Date | string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const from = new Date(args.from);
      const to = new Date(args.to);

      // GROUP BY (login day, user) → COUNT DISTINCT in one pass. We cast
      // the truncated timestamp to ::date so the JS driver hands back a
      // string we can ship straight to the GraphQL `String!` field.
      const rows = await context.prisma.$queryRaw<
        Array<{ date: Date; unique_users: bigint }>
      >`
        SELECT DATE_TRUNC('day', "created_at" AT TIME ZONE 'UTC')::date AS date,
               COUNT(DISTINCT "user_id")::bigint AS unique_users
        FROM "activity_logs"
        WHERE "action" = ${LOGIN_ACTION}
          AND "created_at" >= ${from}
          AND "created_at" <= ${to}
        GROUP BY date
        ORDER BY date ASC
      `;

      return rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10), // YYYY-MM-DD
        uniqueUsers: Number(r.unique_users),
      }));
    },

    mauSeries: async (
      _parent: unknown,
      args: { from: Date | string; to: Date | string },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      const from = new Date(args.from);
      const to = new Date(args.to);

      const rows = await context.prisma.$queryRaw<
        Array<{ month: Date; unique_users: bigint }>
      >`
        SELECT DATE_TRUNC('month', "created_at" AT TIME ZONE 'UTC')::date AS month,
               COUNT(DISTINCT "user_id")::bigint AS unique_users
        FROM "activity_logs"
        WHERE "action" = ${LOGIN_ACTION}
          AND "created_at" >= ${from}
          AND "created_at" <= ${to}
        GROUP BY month
        ORDER BY month ASC
      `;

      return rows.map((r) => ({
        month: r.month.toISOString().slice(0, 7), // YYYY-MM
        uniqueUsers: Number(r.unique_users),
      }));
    },
  },

  ActivityLog: {
    // Resolve `user` from the foreign key. Cheaper than `include: { user }`
    // on every list query because most filters narrow to a single user
    // anyway, and the dashboard typically renders 50 rows per page.
    user: (
      parent: { userId: string },
      _args: unknown,
      { prisma }: Context,
    ) => {
      return prisma.user.findUniqueOrThrow({ where: { id: parent.userId } });
    },
  },
};
