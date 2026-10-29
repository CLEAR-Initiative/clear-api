import type { Context } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { requireNonWorker, requireRole } from "../utils/auth-guard.js";
import { logActivity } from "../utils/activity-log.js";

/** Default `activityStats` window when the caller doesn't specify one. */
const DEFAULT_STATS_WINDOW_DAYS = 30;

/** Maximum rows returned by `activityLogs` in one call. Generous because the
 *  table is well-indexed and the admin dashboard occasionally exports CSV. */
const MAX_LIMIT = 500;

/** Top-N users surfaced in the per-user breakdown of `activityStats`. */
const TOP_USERS = 50;

/**
 * Per-action counts for one bucket (the whole window, one user, or one day).
 * Generic over the action string so a new `ActivityAction` shows up in
 * `activityStats` without a schema change.
 */
export interface CountBucket {
  total: number;
  byAction: Map<string, number>;
}

function makeEmptyCounts(): CountBucket {
  return { total: 0, byAction: new Map() };
}

function bumpBucket(b: CountBucket, action: string): void {
  b.total++;
  b.byAction.set(action, (b.byAction.get(action) ?? 0) + 1);
}

/** GraphQL shape of a bucket: `{ total, actions: [{ action, count }] }`,
 *  actions sorted by count desc then name asc so the order is stable. */
export function serializeCounts(b: CountBucket): {
  total: number;
  actions: Array<{ action: string; count: number }>;
} {
  const actions = [...b.byAction.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((x, y) => y.count - x.count || x.action.localeCompare(y.action));
  return { total: b.total, actions };
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
          return user
            ? { user, total: counts.total, counts: serializeCounts(counts) }
            : null;
        })
        // Drop entries where the user was deleted between activity and
        // the query (cascade would normally remove the row, but we're
        // defensive in case of soft-deletes or replication lag).
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Daily breakdown sorted by date ascending so the dashboard can
      // plot it as a time-series without extra client-side work.
      const byDay = [...byDayMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, counts]) => ({
          date,
          total: counts.total,
          counts: serializeCounts(counts),
        }));

      return { from, to, totals: serializeCounts(totals), byUser, byDay };
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

  Mutation: {
    /** Best-effort: always resolves true once authenticated; a failed
     *  write is swallowed by `logActivity`. */
    recordOnboardingCompleted: async (
      _parent: unknown,
      _args: unknown,
      context: Context,
    ): Promise<boolean> => {
      const user = requireNonWorker(context);
      await logActivity(context.prisma, {
        userId: user.id,
        action: "user.onboarding_completed",
        resourceType: "user",
        resourceId: user.id,
      });
      return true;
    },

    /** Records a report export with the analysis id and its frame (scope),
     *  read from the Analysis row so the client can't send content. An
     *  unknown id is still logged, with a null scope. */
    recordReportExported: async (
      _parent: unknown,
      args: { analysisId: string },
      context: Context,
    ): Promise<boolean> => {
      const user = requireNonWorker(context);
      let scope: Record<string, unknown> | null = null;
      try {
        const row = await context.prisma.analysis.findUnique({
          where: { id: args.analysisId },
          select: {
            locationIds: true,
            eventTypes: true,
            needSectors: true,
            windowStart: true,
            windowEnd: true,
          },
        });
        if (row) {
          scope = {
            locationIds: row.locationIds,
            eventTypes: row.eventTypes,
            needSectors: row.needSectors,
            windowStart: row.windowStart.toISOString(),
            windowEnd: row.windowEnd?.toISOString() ?? null,
          };
        }
      } catch (err) {
        console.error("[activity-log] analysis scope lookup failed:", err);
      }
      await logActivity(context.prisma, {
        userId: user.id,
        action: "analysis.report_exported",
        resourceType: "analysis",
        resourceId: args.analysisId,
        metadata: { analysisId: args.analysisId, scope },
      });
      return true;
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
