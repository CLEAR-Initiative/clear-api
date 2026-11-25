/**
 * CLI for the CRM sync (src/services/crm-sync.ts). Lives under src/ so it
 * compiles into dist/ and runs inside the deployed container, where the
 * DATABASE_URL and EXPONENTIAL_* env already are:
 *
 *   docker exec app-clear-api-1 bun dist/cli/sync-crm.js           # dry run: who would be synced
 *   docker exec app-clear-api-1 bun dist/cli/sync-crm.js --apply   # sync
 *
 * Locally: `bun src/cli/sync-crm.ts [--apply]` against your .env.
 *
 * Dry run is the default because --apply writes to the real CRM, and any
 * Exponential automation on the collections that still emails would email
 * every user touched (Exponential #1476).
 */

import "dotenv/config";
import { prisma } from "../lib/prisma.js";
import { findCrmSyncCandidates, formatCrmSyncSummary, syncCrm } from "../services/crm-sync.js";

const apply = process.argv.includes("--apply");

try {
  if (!apply) {
    for (const c of await findCrmSyncCandidates(prisma)) {
      console.log(`  ${c.target.padEnd(9)} ${c.email}`);
    }
  }
  const summary = await syncCrm(prisma, { dryRun: !apply });
  console.log(formatCrmSyncSummary(summary));
  // Per-user failures are reported, not fatal: exit non-zero only when the
  // run as a whole couldn't happen.
  process.exitCode = apply && !summary.configured ? 1 : 0;
} catch (err) {
  console.error("[crm-sync] failed:", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
