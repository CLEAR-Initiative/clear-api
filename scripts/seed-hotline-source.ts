/**
 * Register (or reactivate) a hotline ground source — the per-source policy
 * record the hotline webhook gate requires before any submission is
 * persisted (services/hotline-ingest.ts#resolveHotlineSource).
 *
 * The transportId is the hotline's BARE E.164 number (no "whatsapp:"
 * prefix — the webhook strips the channel prefix before the lookup). For
 * the Twilio Sandbox POC that is the sandbox number, +14155238886.
 *
 * Idempotent: found-or-created by transportId; an existing row is
 * reactivated and renamed rather than duplicated.
 *
 * Usage:
 *   bun run scripts/seed-hotline-source.ts +14155238886 "Twilio sandbox hotline"
 *   bun run scripts/seed-hotline-source.ts            # defaults to the sandbox number
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

const transportId = process.argv[2] ?? "+14155238886";
const name = process.argv[3] ?? "Twilio sandbox hotline (POC)";

if (!/^\+\d{6,15}$/.test(transportId)) {
  console.error(
    `transportId must be a bare E.164 number (e.g. "+14155238886"), got "${transportId}"`,
  );
  process.exit(1);
}

async function main() {
  const existing = await prisma.groundSources.findUnique({ where: { transportId } });
  if (existing) {
    const source = await prisma.groundSources.update({
      where: { id: existing.id },
      data: { name, kind: "hotline", isActive: true },
    });
    console.log(`Updated hotline source ${source.id} for ${transportId}.`);
    return;
  }

  const source = await prisma.groundSources.create({
    data: {
      name,
      kind: "hotline",
      transportId,
      // Hotline consent is explicit by design — the reporter chooses to
      // message the number (PRD §2). Recorded here so the policy record
      // is self-describing; the hotline gate checks kind+active, not
      // consent scope.
      consentScope: "hotline submission — explicit by design",
      consentRecordedAt: new Date(),
      consentRecordedBy: "seed-hotline-source script",
      privacyDefault: "private",
      retentionRule:
        "Business chat auto-delete 24h (operational setting on the WhatsApp number, not code)",
    },
  });
  console.log(`Created hotline source ${source.id} for ${transportId}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
