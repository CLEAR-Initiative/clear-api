/**
 * Create (or refresh) the least-privilege "worker" service user and mint an
 * API key for it (ADR-0010). This is the identity a Task Worker — the
 * scheduled Claude Code routine, Dagster, a third-party agent — authenticates
 * as. The `worker` role can claim, heartbeat, complete and fail Tasks it
 * holds and read content like any approved user; it can write nothing else,
 * which is the compensating control for an unattended, prompt-injectable
 * Worker. The user's id is what a leased Task records as `leaseOwnerId`.
 *
 * Idempotent:
 *   - The service user is found-or-created by email and forced to role=worker.
 *   - An API key is minted only when the user has no active key, OR when run
 *     with `--new-key` (rotation). The plaintext key is printed ONCE and never
 *     stored — copy it into the Worker's environment as CLEAR_API_KEY.
 *
 * Usage:
 *   bun run scripts/create-worker-user.ts            # create user + first key
 *   bun run scripts/create-worker-user.ts --new-key  # rotate: mint a fresh key
 *
 * Env overrides:
 *   WORKER_USER_EMAIL  (default "worker@clear.dev")
 *   WORKER_USER_NAME   (default "CLEAR Worker")
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { generateApiKey } from "../src/utils/api-key.js";

const WORKER_ROLE = "worker";
const email = process.env.WORKER_USER_EMAIL ?? "worker@clear.dev";
const name = process.env.WORKER_USER_NAME ?? "CLEAR Worker";
const rotate = process.argv.includes("--new-key");

async function main() {
  // ── Service user (find-or-create, force role=worker) ──
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { name, email, role: WORKER_ROLE, emailVerified: true, isActive: true },
    });
    console.log(`Created worker service user ${email} (${user.id}).`);
  } else if (user.role !== WORKER_ROLE || !user.isActive) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { role: WORKER_ROLE, isActive: true },
    });
    console.log(`Updated existing user ${email} (${user.id}) to role=${WORKER_ROLE}.`);
  } else {
    console.log(`Worker service user ${email} (${user.id}) already present.`);
  }

  // ── API key (mint only if none active, or when rotating) ──
  const now = new Date();
  const activeKeys = await prisma.apiKeys.findMany({
    where: {
      userId: user.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  if (activeKeys.length > 0 && !rotate) {
    console.log(
      `\nUser already has ${activeKeys.length} active API key(s): ` +
        activeKeys.map((k) => k.prefix).join(", "),
    );
    console.log("Plaintext keys are never stored — re-run with --new-key to mint a fresh one.");
    return;
  }

  const { plaintextKey, prefix, keyHash } = generateApiKey();
  await prisma.apiKeys.create({
    data: { userId: user.id, name: "worker-cli", prefix, keyHash },
  });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  New worker API key (shown ONCE — copy it now):");
  console.log(`  ${plaintextKey}`);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Set it in the Worker's environment as CLEAR_API_KEY.");
  console.log(`  Tasks it claims record leaseOwnerId = ${user.id}.`);
  if (rotate && activeKeys.length > 0) {
    console.log(
      `  Note: ${activeKeys.length} older key(s) remain active — revoke them via revokeApiKey when the rotation is confirmed.`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
