/**
 * One-shot cleanup of duplicate rows that accumulated before Wave 1's
 * idempotency fixes landed.
 *
 * What it does (in order, each optional via flags):
 *
 *   1. Backfill `signals.externalId` where it's null by deriving from rawData:
 *      - Dataminr  → rawData.alertId
 *      - GDACS     → rawData.properties.eventtype + "-" + rawData.properties.eventid
 *      - ACLED     → rawData.event_id_cnty
 *      Rows whose rawData doesn't contain an id are left alone.
 *
 *   2. Dedupe signals — for each (sourceId, externalId) group with >1 row:
 *        - keep the oldest (collectedAt asc)
 *        - reassign signalEvents, userFeedbacks, userComments to the winner
 *        - delete the losers
 *
 *   3. Dedupe signalEvents — drop duplicate (signalId, eventId) rows.
 *
 *   4. Dedupe alerts — for each eventId with >1 alert row:
 *        - keep the oldest
 *        - reassign userAlerts and notifications (where applicable) to the winner
 *        - delete the losers
 *
 * Run with `--dry-run` first to preview counts, then without to apply.
 *
 * Usage:
 *   bun run scripts/dedupe.ts                         # all steps, writes
 *   bun run scripts/dedupe.ts --dry-run               # preview
 *   bun run scripts/dedupe.ts --signals               # only step 1+2
 *   bun run scripts/dedupe.ts --signal-events         # only step 3
 *   bun run scripts/dedupe.ts --alerts                # only step 4
 *   bun run scripts/dedupe.ts --skip-backfill         # skip step 1 (assume externalId is already set)
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

interface Flags {
  dryRun: boolean;
  skipBackfill: boolean;
  steps: Set<"signals" | "signalEvents" | "alerts">;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const skipBackfill = argv.includes("--skip-backfill");
  const explicit = new Set<"signals" | "signalEvents" | "alerts">();
  if (argv.includes("--signals")) explicit.add("signals");
  if (argv.includes("--signal-events")) explicit.add("signalEvents");
  if (argv.includes("--alerts")) explicit.add("alerts");
  const steps = explicit.size
    ? explicit
    : new Set<"signals" | "signalEvents" | "alerts">(["signals", "signalEvents", "alerts"]);
  return { dryRun, skipBackfill, steps };
}

function log(msg: string): void {
  console.log(msg);
}

/* ──────────────────────────────────────────────────────────────────────
 * Step 1 — Backfill signals.externalId from rawData
 * ────────────────────────────────────────────────────────────────────── */

function extractExternalId(
  sourceName: string,
  rawData: unknown,
): string | null {
  if (!rawData || typeof rawData !== "object") return null;
  const raw = rawData as Record<string, unknown>;

  // Dataminr: { alertId: "..." }
  if (typeof raw.alertId === "string" && raw.alertId) {
    return `dataminr:${raw.alertId}`;
  }

  // ACLED: { event_id_cnty: "SDN12345" } or flattened from the SDN client
  if (typeof raw.event_id_cnty === "string" && raw.event_id_cnty) {
    return `acled:${raw.event_id_cnty}`;
  }
  if (typeof raw.acled_id === "string" && raw.acled_id) {
    return `acled:${raw.acled_id}`;
  }

  // GDACS: nested in `properties.eventtype` + `properties.eventid`, or
  // flat `eventtype` + `eventid` depending on shape
  const props = (raw.properties as Record<string, unknown> | undefined) ?? raw;
  const etype = typeof props.eventtype === "string" ? props.eventtype : undefined;
  const eid = props.eventid != null ? String(props.eventid) : undefined;
  if (etype && eid) {
    return `gdacs:${etype}-${eid}`;
  }

  // Fall back to source-name hint if the payload already carries gdacs_id
  if (sourceName.toLowerCase().includes("gdacs") && typeof raw.gdacs_id === "string") {
    return `gdacs:${raw.gdacs_id}`;
  }

  return null;
}

async function backfillAndDedupeSignals(dryRun: boolean): Promise<void> {
  log("\n[1] Backfill-and-dedupe signals (derive externalId, merge duplicates)");

  const rows = await prisma.signals.findMany({
    where: { externalId: null },
    select: {
      id: true,
      sourceId: true,
      collectedAt: true,
      rawData: true,
      source: { select: { name: true } },
    },
  });
  log(`    ${rows.length} signals without externalId`);

  // Group un-externalIded signals by (sourceId, derivedExternalId). Rows
  // whose rawData doesn't yield an external id are left alone.
  type Candidate = { id: string; collectedAt: Date };
  const buckets = new Map<string, Candidate[]>(); // key = "sourceId\0extId"
  let noIdCount = 0;
  for (const row of rows) {
    const ext = extractExternalId(row.source.name, row.rawData);
    if (!ext) {
      noIdCount += 1;
      continue;
    }
    const k = `${row.sourceId}\0${ext}`;
    const arr = buckets.get(k) ?? [];
    arr.push({ id: row.id, collectedAt: row.collectedAt });
    buckets.set(k, arr);
  }
  log(`    ${noIdCount} rows couldn't derive an externalId — skipped`);
  log(`    ${buckets.size} distinct (source, externalId) buckets`);

  let willUpdate = 0;
  let willMerge = 0;
  for (const arr of buckets.values()) {
    if (arr.length === 1) willUpdate += 1;
    else willMerge += arr.length - 1;
  }
  log(
    `    ${willUpdate} rows will get externalId set (single-member buckets)`,
  );
  log(
    `    ${willMerge} rows will be merged into their earliest sibling (multi-member buckets)`,
  );

  if (dryRun) return;

  // Process each bucket
  let processed = 0;
  for (const [k, arr] of buckets.entries()) {
    const [, extId] = k.split("\0");
    const sourceId = k.split("\0")[0]!;

    // Sort oldest first — the oldest null-row is the winner candidate.
    arr.sort((a, b) => a.collectedAt.getTime() - b.collectedAt.getTime());

    // Another signal with this exact externalId may already exist (e.g.
    // from post-deploy ingest). If it does, it wins; we merge all the null
    // rows into it.
    const preExisting = await prisma.signals.findUnique({
      where: { sourceId_externalId: { sourceId, externalId: extId! } },
      select: { id: true },
    });

    const winnerId = preExisting?.id ?? arr[0]!.id;
    const loserIds = preExisting
      ? arr.map((a) => a.id)
      : arr.slice(1).map((a) => a.id);

    if (loserIds.length === 0) {
      // Single null row, no pre-existing winner → just set externalId
      await prisma.signals.update({
        where: { id: winnerId },
        data: { externalId: extId },
      });
      processed += 1;
      if (processed % 100 === 0) log(`    ${processed}/${buckets.size} buckets processed`);
      continue;
    }

    // Merge: reassign children → delete losers → set winner's externalId
    // (if not already set). Callback transaction with extended timeout.
    await prisma.$transaction(
      async (tx) => {
        await tx.signalEvents.updateMany({
          where: { signalId: { in: loserIds } },
          data: { signalId: winnerId },
        });
        await tx.userFeedbacks.updateMany({
          where: { signalId: { in: loserIds } },
          data: { signalId: winnerId },
        });
        await tx.userComments.updateMany({
          where: { signalId: { in: loserIds } },
          data: { signalId: winnerId },
        });
        await tx.signals.deleteMany({ where: { id: { in: loserIds } } });
        if (!preExisting) {
          await tx.signals.update({
            where: { id: winnerId },
            data: { externalId: extId },
          });
        }
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    processed += 1;
    if (processed % 50 === 0) log(`    ${processed}/${buckets.size} buckets processed`);
  }
  log(`    ${processed}/${buckets.size} buckets processed`);
}

/* ──────────────────────────────────────────────────────────────────────
 * Step 2 — Dedupe signals by (sourceId, externalId)
 * ────────────────────────────────────────────────────────────────────── */

async function dedupeSignals(dryRun: boolean): Promise<void> {
  log("\n[2] Dedupe signals by (sourceId, externalId)");

  const groups = await prisma.$queryRaw<
    { sourceId: string; externalId: string; count: bigint }[]
  >`
    SELECT "source_id" AS "sourceId", "external_id" AS "externalId", COUNT(*)::bigint AS count
    FROM signals
    WHERE "external_id" IS NOT NULL
    GROUP BY "source_id", "external_id"
    HAVING COUNT(*) > 1
  `;
  log(`    ${groups.length} (sourceId, externalId) groups have duplicates`);
  const totalDupes = groups.reduce((acc, g) => acc + Number(g.count) - 1, 0);
  log(`    ${totalDupes} signal rows will be removed (keeping oldest per group)`);

  if (dryRun) return;

  let processed = 0;
  for (const g of groups) {
    const rows = await prisma.signals.findMany({
      where: { sourceId: g.sourceId, externalId: g.externalId },
      orderBy: { collectedAt: "asc" },
      select: { id: true },
    });
    if (rows.length <= 1) continue;
    const winnerId = rows[0]!.id;
    const loserIds = rows.slice(1).map((r) => r.id);

    // Reassign child rows to the winner, then delete the losers. Use
    // updateMany to move each FK; none of these have (loser, winner)
    // composite uniques, so duplicates can't arise mid-move.
    // Callback form so we can set a timeout (array form doesn't accept one).
    await prisma.$transaction(
      async (tx) => {
        await tx.signalEvents.updateMany({
          where: { signalId: { in: loserIds } },
          data: { signalId: winnerId },
        });
        await tx.userFeedbacks.updateMany({
          where: { signalId: { in: loserIds } },
          data: { signalId: winnerId },
        });
        await tx.userComments.updateMany({
          where: { signalId: { in: loserIds } },
          data: { signalId: winnerId },
        });
        await tx.signals.deleteMany({ where: { id: { in: loserIds } } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    processed += loserIds.length;
    if (processed % 100 === 0) log(`    removed ${processed} signals…`);
  }
  log(`    removed ${processed} duplicate signals in total`);
}

/* ──────────────────────────────────────────────────────────────────────
 * Step 3 — Dedupe signalEvents (signalId, eventId) duplicates
 * ────────────────────────────────────────────────────────────────────── */

async function dedupeSignalEvents(dryRun: boolean): Promise<void> {
  log("\n[3] Dedupe signalEvents by (signalId, eventId)");

  const groups = await prisma.$queryRaw<
    { signalId: string; eventId: string; count: bigint }[]
  >`
    SELECT "signal_id" AS "signalId", "event_id" AS "eventId", COUNT(*)::bigint AS count
    FROM signal_to_events
    GROUP BY "signal_id", "event_id"
    HAVING COUNT(*) > 1
  `;
  log(`    ${groups.length} (signalId, eventId) pairs are duplicated`);
  const totalDupes = groups.reduce((acc, g) => acc + Number(g.count) - 1, 0);
  log(`    ${totalDupes} signalEvents rows will be removed`);

  if (dryRun) return;

  let removed = 0;
  for (const g of groups) {
    const rows = await prisma.signalEvents.findMany({
      where: { signalId: g.signalId, eventId: g.eventId },
      orderBy: { collectedAt: "asc" },
      select: { id: true },
    });
    if (rows.length <= 1) continue;
    const loserIds = rows.slice(1).map((r) => r.id);
    await prisma.signalEvents.deleteMany({ where: { id: { in: loserIds } } });
    removed += loserIds.length;
  }
  log(`    removed ${removed} duplicate signalEvents rows`);
}

/* ──────────────────────────────────────────────────────────────────────
 * Step 4 — Dedupe alerts by eventId
 * ────────────────────────────────────────────────────────────────────── */

async function dedupeAlerts(dryRun: boolean): Promise<void> {
  log("\n[4] Dedupe alerts by eventId");

  const groups = await prisma.$queryRaw<
    { eventId: string; count: bigint }[]
  >`
    SELECT "event_id" AS "eventId", COUNT(*)::bigint AS count
    FROM alerts
    GROUP BY "event_id"
    HAVING COUNT(*) > 1
  `;
  log(`    ${groups.length} events have more than one alert`);
  const totalDupes = groups.reduce((acc, g) => acc + Number(g.count) - 1, 0);
  log(`    ${totalDupes} alert rows will be removed`);

  if (dryRun) return;

  let removed = 0;
  for (const g of groups) {
    const rows = await prisma.alerts.findMany({
      where: { eventId: g.eventId },
      orderBy: { id: "asc" }, // cuid sort ~= creation order
      select: { id: true, status: true },
    });
    if (rows.length <= 1) continue;

    // Prefer keeping a published alert over a draft if both exist
    rows.sort((a, b) => {
      const sa = a.status === "published" ? 0 : a.status === "draft" ? 1 : 2;
      const sb = b.status === "published" ? 0 : b.status === "draft" ? 1 : 2;
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
    const winnerId = rows[0]!.id;
    const loserIds = rows.slice(1).map((r) => r.id);

    // Reassign userAlerts to winner (skip duplicates that would violate
    // the (userId, alertId) join). We do a find+manual-create pattern
    // because updateMany can't skip rows that would conflict.
    const loserUAs = await prisma.userAlerts.findMany({
      where: { alertId: { in: loserIds } },
      select: { userId: true },
    });
    const winnerUAs = await prisma.userAlerts.findMany({
      where: { alertId: winnerId },
      select: { userId: true },
    });
    const winnerUserIds = new Set(winnerUAs.map((u) => u.userId));
    const uaToCreate = [...new Set(loserUAs.map((u) => u.userId))].filter(
      (uid) => !winnerUserIds.has(uid),
    );

    await prisma.$transaction(
      async (tx) => {
        // Add missing userAlerts to the winner
        if (uaToCreate.length > 0) {
          await tx.userAlerts.createMany({
            data: uaToCreate.map((userId) => ({ userId, alertId: winnerId })),
            skipDuplicates: true,
          });
        }
        // Remove userAlerts tied to losers
        await tx.userAlerts.deleteMany({ where: { alertId: { in: loserIds } } });
        // Delete the loser alerts
        await tx.alerts.deleteMany({ where: { id: { in: loserIds } } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    removed += loserIds.length;
  }
  log(`    removed ${removed} duplicate alerts`);
}

/* ──────────────────────────────────────────────────────────────────────
 * Main
 * ────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const flags = parseFlags();

  log("CLEAR duplicate cleanup");
  log(`  mode: ${flags.dryRun ? "DRY RUN (no writes)" : "APPLY"}`);
  log(`  steps: ${[...flags.steps].join(", ")}`);
  if (flags.skipBackfill) log("  skipping: externalId backfill");

  if (flags.steps.has("signals")) {
    if (!flags.skipBackfill) {
      // Backfill + dedupe in one pass: derive externalId from rawData,
      // merge null-externalId siblings that resolve to the same key, then
      // set the winner's externalId.
      await backfillAndDedupeSignals(flags.dryRun);
    }
    // Second pass catches the rare case of two rows that already had
    // externalId set (possible only if the unique constraint from Wave 1
    // wasn't in place when they were written — keep as safety net).
    await dedupeSignals(flags.dryRun);
  }
  if (flags.steps.has("signalEvents")) {
    await dedupeSignalEvents(flags.dryRun);
  }
  if (flags.steps.has("alerts")) {
    await dedupeAlerts(flags.dryRun);
  }

  log("\nDone.");
  if (flags.dryRun) {
    log("Run again without --dry-run to apply.");
  } else {
    log("Next: add the remaining @@unique constraints via prisma migrate.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
