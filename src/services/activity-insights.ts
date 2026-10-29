/**
 * Admin activity insights: CLEAR Agent usage aggregates and the monthly NRC
 * aggregate export.
 *
 * Neither function ever reads a message's `content` (what the user asked or
 * what the Agent answered). Agent queries use an explicit Prisma `select`
 * built from AGENT_USAGE_SELECT, which a unit test pins.
 */

import type { PrismaClient } from "../generated/prisma/client.js";

/** Groups with fewer distinct people than this are left out of the NRC
 *  export, so no row can be traced back to an individual. */
export const NRC_EXPORT_MIN_GROUP_SIZE = 5;

/** The global admin role. Admins are left out of the NRC export: their
 *  usage is testing and support, not field use. */
const GLOBAL_ADMIN_ROLE = "admin";

/**
 * The only conversationMessages columns the usage aggregates read. Never add
 * `content` here: the aggregates must work from usage metadata alone.
 * `currentView` holds identifiers only (route, entity id, filters).
 */
export const AGENT_USAGE_SELECT = {
  role: true,
  createdAt: true,
  costUsd: true,
  inputTokens: true,
  outputTokens: true,
  currentView: true,
  conversation: { select: { userId: true } },
} as const;

interface AgentUsageRow {
  role: string;
  createdAt: Date;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  currentView: unknown;
  conversation: { userId: string };
}

/** Id-like path segments (digits, or a long run of letters/digits such as a
 *  cuid or uuid) collapse to `:id`, so routes group by page, not entity. */
const ID_SEGMENT = /^(\d+|[0-9a-f-]{32,36}|[a-z0-9]{20,})$/i;

export function normaliseRoute(currentView: unknown): string {
  const route =
    currentView && typeof currentView === "object" && !Array.isArray(currentView)
      ? (currentView as { route?: unknown }).route
      : undefined;
  if (typeof route !== "string" || route.length === 0) return "(unknown)";
  const path = route.split(/[?#]/)[0] ?? "";
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => (ID_SEGMENT.test(s) ? ":id" : s));
  return `/${segments.join("/")}`;
}

export interface AgentUsageStats {
  from: Date;
  to: Date;
  /** User turns (questions asked). */
  turns: number;
  /** Assistant messages (Answers). */
  answers: number;
  distinctUsers: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  byRoute: Array<{ route: string; turns: number; distinctUsers: number }>;
  byDay: Array<{ date: string; turns: number; distinctUsers: number; costUsd: number }>;
}

/** Agent usage over `[from, to]`, aggregated from usage metadata only. */
export async function agentUsageStats(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<AgentUsageStats> {
  const rows: AgentUsageRow[] = await prisma.conversationMessages.findMany({
    where: { createdAt: { gte: from, lte: to }, role: { in: ["user", "assistant"] } },
    select: AGENT_USAGE_SELECT,
  });

  const users = new Set<string>();
  const routes = new Map<string, { turns: number; users: Set<string> }>();
  const days = new Map<string, { turns: number; users: Set<string>; costUsd: number }>();
  let turns = 0;
  let answers = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const row of rows) {
    const userId = row.conversation.userId;
    const date = row.createdAt.toISOString().slice(0, 10);
    let day = days.get(date);
    if (!day) {
      day = { turns: 0, users: new Set(), costUsd: 0 };
      days.set(date, day);
    }
    if (row.role === "user") {
      turns++;
      users.add(userId);
      day.turns++;
      day.users.add(userId);
      const route = normaliseRoute(row.currentView);
      let r = routes.get(route);
      if (!r) {
        r = { turns: 0, users: new Set() };
        routes.set(route, r);
      }
      r.turns++;
      r.users.add(userId);
    } else {
      answers++;
      costUsd += row.costUsd ?? 0;
      day.costUsd += row.costUsd ?? 0;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
    }
  }

  return {
    from,
    to,
    turns,
    answers,
    distinctUsers: users.size,
    costUsd,
    inputTokens,
    outputTokens,
    byRoute: [...routes.entries()]
      .map(([route, r]) => ({ route, turns: r.turns, distinctUsers: r.users.size }))
      .sort((a, b) => b.turns - a.turns || a.route.localeCompare(b.route)),
    byDay: [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, d]) => ({
        date,
        turns: d.turns,
        distinctUsers: d.users.size,
        costUsd: d.costUsd,
      })),
  };
}

// ─── NRC aggregate export ────────────────────────────────────────────────────

export interface NrcExportRow {
  month: string;
  organisation: string;
  team: string;
  role: string;
  distinctUsers: number;
  actions: number;
  agentTurns: number;
  agentCostUsd: number;
}

interface Membership {
  /** Grouping key: organisation and team ids, since names aren't unique. */
  key: string;
  organisation: string;
  team: string;
  role: string;
}

const NO_TEAM = "(no team)";
const NO_ORG = "(no organisation)";

/**
 * Monthly aggregates by organisation, team and team role over `[from, to]`.
 * A person in several teams counts in each. Enforced here, not in any
 * client: global admins are left out entirely, and any (month, org, team,
 * role) group with fewer than NRC_EXPORT_MIN_GROUP_SIZE distinct active
 * people is dropped.
 */
export async function nrcExportRows(
  prisma: PrismaClient,
  from: Date,
  to: Date,
): Promise<NrcExportRow[]> {
  const notAdmin = { role: { not: GLOBAL_ADMIN_ROLE } };
  const [logs, messages] = await Promise.all([
    prisma.activityLogs.findMany({
      where: { createdAt: { gte: from, lte: to }, user: notAdmin },
      select: { userId: true, createdAt: true },
    }),
    prisma.conversationMessages.findMany({
      where: {
        createdAt: { gte: from, lte: to },
        role: { in: ["user", "assistant"] },
        conversation: { user: notAdmin },
      },
      select: {
        role: true,
        createdAt: true,
        costUsd: true,
        conversation: { select: { userId: true } },
      },
    }),
  ]);

  const userIds = new Set<string>([
    ...logs.map((l) => l.userId),
    ...messages.map((m) => m.conversation.userId),
  ]);
  const users = userIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...userIds] }, ...notAdmin },
        select: {
          id: true,
          role: true,
          teamMemberships: {
            select: {
              role: true,
              team: {
                select: {
                  id: true,
                  name: true,
                  organisation: { select: { id: true, name: true } },
                },
              },
            },
          },
          organisations: { select: { organisation: { select: { id: true, name: true } } } },
        },
      })
    : [];

  const membershipsByUser = new Map<string, Membership[]>();
  for (const u of users) {
    const ms: Membership[] = u.teamMemberships.map((m) => ({
      key: `${m.team.organisation.id}/${m.team.id}/${m.role}`,
      organisation: m.team.organisation.name,
      team: m.team.name,
      role: m.role,
    }));
    // A "(no team)" row for each organisation the person belongs to without
    // a team there, so org-only membership isn't lost when they have a team
    // elsewhere.
    const orgsWithTeam = new Set(u.teamMemberships.map((m) => m.team.organisation.id));
    for (const { organisation } of u.organisations) {
      if (orgsWithTeam.has(organisation.id)) continue;
      ms.push({
        key: `${organisation.id}//${u.role}`,
        organisation: organisation.name,
        team: NO_TEAM,
        role: u.role,
      });
    }
    if (ms.length === 0) {
      ms.push({ key: `//${u.role}`, organisation: NO_ORG, team: NO_TEAM, role: u.role });
    }
    membershipsByUser.set(u.id, ms);
  }

  type Group = NrcExportRow & { people: Set<string> };
  const groups = new Map<string, Group>();
  const bump = (userId: string, at: Date, apply: (g: Group) => void) => {
    const ms = membershipsByUser.get(userId);
    if (!ms) return; // admin, or deleted since
    const month = at.toISOString().slice(0, 7);
    for (const m of ms) {
      const key = `${month}|${m.key}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          month,
          organisation: m.organisation,
          team: m.team,
          role: m.role,
          distinctUsers: 0,
          actions: 0,
          agentTurns: 0,
          agentCostUsd: 0,
          people: new Set(),
        };
        groups.set(key, g);
      }
      g.people.add(userId);
      apply(g);
    }
  };

  for (const l of logs) bump(l.userId, l.createdAt, (g) => g.actions++);
  for (const m of messages) {
    bump(m.conversation.userId, m.createdAt, (g) => {
      if (m.role === "user") g.agentTurns++;
      else g.agentCostUsd += m.costUsd ?? 0;
    });
  }

  return [...groups.values()]
    .filter((g) => g.people.size >= NRC_EXPORT_MIN_GROUP_SIZE)
    .map(({ people, ...row }) => ({ ...row, distinctUsers: people.size }))
    .sort(
      (a, b) =>
        a.month.localeCompare(b.month) ||
        a.organisation.localeCompare(b.organisation) ||
        a.team.localeCompare(b.team) ||
        a.role.localeCompare(b.role),
    );
}

const CSV_HEADER = [
  "month",
  "organisation",
  "team",
  "role",
  "distinct_users",
  "actions",
  "agent_turns",
  "agent_cost_usd",
];

/** Quote a CSV cell, and neutralise a leading formula character so a team
 *  name can't run as a spreadsheet formula. */
function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toNrcCsv(rows: NrcExportRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.month,
        r.organisation,
        r.team,
        r.role,
        r.distinctUsers,
        r.actions,
        r.agentTurns,
        r.agentCostUsd.toFixed(4),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
