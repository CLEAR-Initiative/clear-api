/**
 * Mirror Developer self-signups into the Exponential CRM (Exponential
 * #1478). The users table is the source of truth; the CRM is an optional
 * copy that nothing in CLEAR depends on. Signup and approval already push
 * one contact at a time, but those pushes are best-effort, so this walks
 * every self-signup and repairs the CRM: missed signups get backfilled,
 * approvals that never reached the approved collection get moved.
 *
 * Who counts as a self-signup: the CRM is only for Portal self-signups,
 * not invited staff, admin-provisioned developers or service accounts.
 *   - `pending` users: only the Portal signup creates them.
 *   - approved users: `approvedAt` set (approveUserById sets it in the
 *     same UPDATE as the role flip) and role still `member` or `admin`.
 * Inactive users are skipped.
 *
 * Roles can change while a run is going (an admin approves someone
 * mid-backfill), so each user's current state is re-read right before
 * their CRM write, and re-checked after a prospects push in case the
 * approval's own CRM move ran first and the push re-added them.
 *
 * Idempotent: every CRM call is a create-or-fetch or a set membership, and
 * the summary counts a user as changed only when a contact was created or
 * a list membership moved, so a second run reports zero changes.
 *
 * Never sends email from CLEAR. Exponential's own automations on the two
 * collections must have their email steps off (Exponential #1476), or a
 * backfill would email every user it touches.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import {
  isCrmMirrorConfigured,
  pushToProspects,
  syncApprovedContact,
} from "./exponential.js";
import { splitName } from "./signup.js";

export type CrmTarget = "prospects" | "approved";

export interface CrmSyncCandidate {
  id: string;
  email: string;
  name: string;
  target: CrmTarget;
}

export interface CrmSyncSummary {
  configured: boolean;
  dryRun: boolean;
  candidates: { prospects: number; approved: number };
  changed: number;
  unchanged: number;
  /** Stopped being a candidate (approved elsewhere, deactivated…) mid-run. */
  skipped: number;
  failed: Array<{ email: string; target: CrmTarget; reason: string }>;
  /** Partial-sync warnings (e.g. profileType update failed) per user. */
  warnings: Array<{ email: string; warnings: string[] }>;
}

/** Global roles an approved self-signup can hold. Service roles (worker,
 *  pipeline, agent) are never CRM contacts. */
const APPROVED_ROLES = ["member", "admin"];

/** Which collection a user belongs in right now, or null for none. */
function targetFor(user: { role: string; isActive: boolean; approvedAt: Date | null }): CrmTarget | null {
  if (!user.isActive) return null;
  if (user.role === "pending") return "prospects";
  if (user.approvedAt && APPROVED_ROLES.includes(user.role)) return "approved";
  return null;
}

/** Every user the CRM should hold, and which collection they belong in. */
export async function findCrmSyncCandidates(prisma: PrismaClient): Promise<CrmSyncCandidate[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [{ role: "pending" }, { approvedAt: { not: null }, role: { in: APPROVED_ROLES } }],
    },
    select: { id: true, email: true, name: true, role: true, isActive: true, approvedAt: true },
    orderBy: { createdAt: "asc" },
  });

  return users.flatMap((u) => {
    const target = targetFor(u);
    return target ? [{ id: u.id, email: u.email, name: u.name, target }] : [];
  });
}

/** Re-read one user's collection at write time. */
async function currentTarget(prisma: PrismaClient, userId: string): Promise<CrmTarget | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isActive: true, approvedAt: true },
  });
  return user ? targetFor(user) : null;
}

type MirrorResult =
  | { ok: true; value: { changed: boolean; warnings: string[] } }
  | { ok: false; reason: string };

/** Put one contact in the given collection. */
async function mirror(candidate: CrmSyncCandidate, target: CrmTarget): Promise<MirrorResult> {
  const contact = { email: candidate.email, ...splitName(candidate.name) };
  if (target === "approved") return syncApprovedContact(contact);
  const pushed = await pushToProspects(contact);
  return pushed.ok ? { ok: true, value: { changed: pushed.value.changed, warnings: [] } } : pushed;
}

/** Sync one user against their current state. Null when they are no
 *  longer a candidate. */
async function syncOne(
  prisma: PrismaClient,
  candidate: CrmSyncCandidate,
): Promise<{ target: CrmTarget; result: MirrorResult } | null> {
  const target = await currentTarget(prisma, candidate.id);
  if (!target) return null;
  const result = await mirror(candidate, target);
  if (!result.ok || target !== "prospects") return { target, result };

  // Approved while we were adding them to prospects: approval's own move
  // may have run before our add and been undone by it. Move them again.
  if ((await currentTarget(prisma, candidate.id)) !== "approved") return { target, result };
  const moved = await mirror(candidate, "approved");
  if (!moved.ok) return { target: "approved", result: moved };
  return {
    target: "approved",
    result: {
      ok: true,
      value: { changed: true, warnings: moved.value.warnings },
    },
  };
}

/**
 * Bring the CRM in line with the users table. With `dryRun` it only
 * counts candidates and makes no CRM calls. Users are synced one at a
 * time to stay gentle on Exponential; a failure on one user, returned or
 * thrown, is recorded and the run carries on.
 */
export async function syncCrm(
  prisma: PrismaClient,
  options: { dryRun: boolean },
): Promise<CrmSyncSummary> {
  const candidates = await findCrmSyncCandidates(prisma);
  const summary: CrmSyncSummary = {
    configured: isCrmMirrorConfigured(),
    dryRun: options.dryRun,
    candidates: {
      prospects: candidates.filter((c) => c.target === "prospects").length,
      approved: candidates.filter((c) => c.target === "approved").length,
    },
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: [],
    warnings: [],
  };
  if (options.dryRun || !summary.configured) return summary;

  for (const candidate of candidates) {
    let synced: Awaited<ReturnType<typeof syncOne>>;
    try {
      synced = await syncOne(prisma, candidate);
    } catch (err) {
      const reason = `threw:${err instanceof Error ? err.message : String(err)}`;
      summary.failed.push({ email: candidate.email, target: candidate.target, reason });
      continue;
    }
    if (!synced) {
      summary.skipped += 1;
      continue;
    }
    const { target, result } = synced;
    if (!result.ok) {
      summary.failed.push({ email: candidate.email, target, reason: result.reason });
      continue;
    }
    if (result.value.changed) summary.changed += 1;
    else summary.unchanged += 1;
    if (result.value.warnings.length > 0) {
      summary.warnings.push({ email: candidate.email, warnings: result.value.warnings });
    }
  }
  return summary;
}

/** Human-readable report for the CLI and the scheduled run's log line. */
export function formatCrmSyncSummary(summary: CrmSyncSummary): string {
  const { prospects, approved } = summary.candidates;
  const head = `${prospects + approved} self-signups (${prospects} pending → prospects, ${approved} approved → approved)`;
  if (!summary.configured) return `${head}. CRM not configured (EXPONENTIAL_* unset): nothing synced.`;
  if (summary.dryRun) return `${head}. Dry run: no CRM calls made. Re-run with --apply to sync.`;
  const lines = [
    `${head}. Changed ${summary.changed}, unchanged ${summary.unchanged}, skipped ${summary.skipped}, failed ${summary.failed.length}.`,
    ...summary.failed.map((f) => `  failed ${f.email} (${f.target}): ${f.reason}`),
    ...summary.warnings.map((w) => `  warning ${w.email}: ${w.warnings.join(", ")}`),
  ];
  return lines.join("\n");
}

// ─── Scheduled run (opt-in) ──────────────────────────────────────────
// Same in-process pattern as the activity-log trim worker: once shortly
// after boot, then on the interval. Started only when
// CRM_SYNC_INTERVAL_HOURS is set and the CRM is configured.

const FIRST_RUN_DELAY_MS = 120_000;

let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** One scheduled sync. Never throws; skips if the previous run is still
 *  going (a large backfill can outlast a short interval). */
export async function runScheduledCrmSync(prisma: PrismaClient): Promise<void> {
  if (running) return;
  running = true;
  try {
    const summary = await syncCrm(prisma, { dryRun: false });
    console.log(`[crm-sync] ${formatCrmSyncSummary(summary)}`);
  } catch (err) {
    console.error("[crm-sync] run failed:", err);
  } finally {
    running = false;
  }
}

/** Start the schedule. No-op without an interval, without CRM config, or
 *  when already started. Returns whether it started. */
export function startCrmSyncWorker(prisma: PrismaClient, intervalHours: number | undefined): boolean {
  if (timer !== null || !intervalHours || !isCrmMirrorConfigured()) return false;
  firstRun = setTimeout(() => {
    firstRun = null;
    void runScheduledCrmSync(prisma);
  }, FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  timer = setInterval(() => void runScheduledCrmSync(prisma), intervalHours * 60 * 60 * 1000);
  timer.unref?.();
  return true;
}

/** Stop the schedule (tests / graceful shutdown). */
export function stopCrmSyncWorker(): void {
  if (firstRun !== null) clearTimeout(firstRun);
  if (timer !== null) clearInterval(timer);
  firstRun = null;
  timer = null;
}
