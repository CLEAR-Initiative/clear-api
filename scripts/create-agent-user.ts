/**
 * Create (or refresh) the "agent" service user and mint an API key for it.
 * The key identifies clear-mvp's CLEAR Agent: the Agent sends it in
 * `X-Clear-Agent-Key` alongside the end user's session, and Conversation
 * writes require both (see requireConversationWriter). On its own the key
 * grants nothing — the agent role reads no content and is not a writer.
 *
 * Idempotent:
 *   - The service user is found-or-created by email and forced to role=agent.
 *   - An API key is minted only when the user has no active key, OR when run
 *     with `--new-key` (rotation). The plaintext key is printed ONCE and never
 *     stored — copy it into clear-mvp's env as CLEAR_AGENT_API_KEY.
 *
 * Usage:
 *   bun run scripts/create-agent-user.ts            # create user + first key
 *   bun run scripts/create-agent-user.ts --new-key  # rotate: mint a fresh key
 *
 * Env overrides:
 *   AGENT_USER_EMAIL  (default "agent@clear.dev")
 *   AGENT_USER_NAME   (default "CLEAR Agent")
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { generateApiKey } from "../src/utils/api-key.js";
import { AGENT_ROLE } from "../src/utils/request-auth.js";

const email = process.env.AGENT_USER_EMAIL ?? "agent@clear.dev";
const name = process.env.AGENT_USER_NAME ?? "CLEAR Agent";
const rotate = process.argv.includes("--new-key");

async function main() {
  // ── Service user (find-or-create, force role=agent) ──
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { name, email, role: AGENT_ROLE, emailVerified: true, isActive: true },
    });
    console.log(`Created agent service user ${email} (${user.id}).`);
  } else if (user.role !== AGENT_ROLE || !user.isActive) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { role: AGENT_ROLE, isActive: true },
    });
    console.log(`Updated existing user ${email} (${user.id}) to role=${AGENT_ROLE}.`);
  } else {
    console.log(`Agent service user ${email} (${user.id}) already present.`);
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
    data: { userId: user.id, name: "agent-cli", prefix, keyHash },
  });

  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  New CLEAR Agent API key (shown ONCE — copy it now):");
  console.log(`  ${plaintextKey}`);
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Set it in clear-mvp's env as CLEAR_AGENT_API_KEY.");
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
