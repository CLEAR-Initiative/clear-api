/**
 * Create (or refresh) the least-privilege "pipeline" service user and mint an
 * API key for it. This is the machine identity the CLEAR ReliefWeb pipeline uses
 * to call `ensureCountryLocation`, `upsertLocationMetadata`, and the source-PDF
 * upload route — nothing else (a leaked key cannot perform unrelated admin work).
 *
 * Idempotent:
 *   - The service user is found-or-created by email and forced to role=pipeline.
 *   - An API key is minted only when the user has no active key, OR when run
 *     with `--new-key` (rotation). The plaintext key is printed ONCE and never
 *     stored — copy it into the pipeline host env as PIPELINE_API_KEY.
 *
 * Usage:
 *   bun run scripts/create-pipeline-user.ts            # create user + first key
 *   bun run scripts/create-pipeline-user.ts --new-key  # rotate: mint a fresh key
 *
 * Env overrides:
 *   PIPELINE_USER_EMAIL  (default "pipeline@clear.dev")
 *   PIPELINE_USER_NAME   (default "CLEAR Pipeline")
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { generateApiKey } from "../src/utils/api-key.js";

const PIPELINE_ROLE = "pipeline";
const email = process.env.PIPELINE_USER_EMAIL ?? "pipeline@clear.dev";
const name = process.env.PIPELINE_USER_NAME ?? "CLEAR Pipeline";
const rotate = process.argv.includes("--new-key");

async function main() {
  // ── Service user (find-or-create, force role=pipeline) ──
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { name, email, role: PIPELINE_ROLE, emailVerified: true, isActive: true },
    });
    console.log(`Created pipeline service user ${email} (${user.id}).`);
  } else if (user.role !== PIPELINE_ROLE || !user.isActive) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { role: PIPELINE_ROLE, isActive: true },
    });
    console.log(`Updated existing user ${email} (${user.id}) to role=${PIPELINE_ROLE}.`);
  } else {
    console.log(`Pipeline service user ${email} (${user.id}) already present.`);
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
    data: { userId: user.id, name: "pipeline-cli", prefix, keyHash },
  });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  New pipeline API key (shown ONCE — copy it now):");
  console.log(`  ${plaintextKey}`);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Set it in the pipeline host env as PIPELINE_API_KEY.");
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
