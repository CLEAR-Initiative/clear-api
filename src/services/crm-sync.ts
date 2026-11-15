/**
 * Mirror Developer self-signups into the Exponential CRM (Exponential
 * #1478). The users table is the source of truth; the CRM is an optional
 * copy that nothing in CLEAR depends on. Signup and approval already push
 * one contact at a time, but those pushes are best-effort, so this walks
 * every self-signup and repairs the CRM: missed signups get backfilled,
 * approvals that never reached the approved collection get moved.
 *
 * Who counts as a self-signup: the users table has no "how was this
 * account created" column, and the CRM is only for Portal self-signups,
 * not invited staff, admin-provisioned developers or service accounts.
 *   - `pending` users: only the Portal signup creates them.
 *   - approved users: those with a `user.approved` activity-log row (only
 *     approveUserById writes it) whose role is still `member` or `admin`.
 * Inactive users are skipped.
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
  failed: Array<{ email: string; target: CrmTarget; reason: string }>;
  /** Partial-sync warnings (e.g. profileType update failed) per user. */
  warnings: Array<{ email: string; warnings: string[] }>;
}

/** Global roles an approved self-signup can hold. Service roles (worker,
 *  pipeline, agent) are never CRM contacts. */
const APPROVED_ROLES = ["member", "admin"];

/** Every user the CRM should hold, and which collection they belong in. */
export async function findCrmSyncCandidates(prisma: PrismaClient): Promise<CrmSyncCandidate[]> {
  const approvals = await prisma.activityLogs.findMany({
    where: { action: "user.approved", resourceType: "user", resourceId: { not: null } },
    select: { resourceId: true },
    distinct: ["resourceId"],
  });
  const approvedIds = approvals.map((a) => a.resourceId).filter((id): id is string => id !== null);

  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [{ role: "pending" }, { id: { in: approvedIds }, role: { in: APPROVED_ROLES } }],
    },
    select: { id: true, email: true, name: true, role: true },
    orderBy: { createdAt: "asc" },
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    target: u.role === "pending" ? "prospects" : "approved",
  }));
}

type MirrorResult =
  | { ok: true; value: { changed: boolean; warnings: string[] } }
  | { ok: false; reason: string };

/** Put one candidate in the collection it belongs in. */
async function mirror(candidate: CrmSyncCandidate): Promise<MirrorResult> {
  const contact = { email: candidate.email, ...splitName(candidate.name) };
  if (candidate.target === "approved") return syncApprovedContact(contact);
  const pushed = await pushToProspects(contact);
  return pushed.ok ? { ok: true, value: { changed: pushed.value.changed, warnings: [] } } : pushed;
}

/**
 * Bring the CRM in line with the users table. With `dryRun` it only
 * counts candidates and makes no CRM calls. Users are synced one at a
 * time to stay gentle on Exponential; a failure on one user is recorded
 * and the run carries on.
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
    failed: [],
    warnings: [],
  };
  if (options.dryRun || !summary.configured) return summary;

  for (const candidate of candidates) {
    const result = await mirror(candidate);

    if (!result.ok) {
      summary.failed.push({ email: candidate.email, target: candidate.target, reason: result.reason });
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
    `${head}. Changed ${summary.changed}, unchanged ${summary.unchanged}, failed ${summary.failed.length}.`,
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
