/**
 * Send a test alert notification (email + SMS) to the recipients you specify.
 *
 * Picks the latest *published* alert in the database, builds the same email
 * payload that `notifyAlertSubscribers` would produce, and a short SMS body —
 * then dispatches via the configured EMAIL_PROVIDER / SMS_PROVIDER. Useful
 * for sanity-checking provider config end-to-end without subscribing a real
 * user or waiting for the pipeline to escalate something.
 *
 * Usage:
 *   bun run scripts/test-alert-notification.ts \
 *     --email you@example.com \
 *     --phone +49170123456
 *
 *   bun run scripts/test-alert-notification.ts --email you@example.com
 *   bun run scripts/test-alert-notification.ts --phone +49170123456
 *   bun run scripts/test-alert-notification.ts --alert-id <id> --email you@example.com
 *   bun run scripts/test-alert-notification.ts --name "Alex" --email you@example.com
 *   bun run scripts/test-alert-notification.ts --dry-run --email you@example.com
 *
 * At least one of --email or --phone is required. Both are optional.
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/utils/env.js";
import { getEmailProvider, getSMSProvider } from "../src/services/messaging/registry.js";
import { alertNotification } from "../src/services/messaging/templates.js";

interface Flags {
  email: string | null;
  phone: string | null;
  alertId: string | null;
  recipientName: string;
  dryRun: boolean;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) return null;
    return argv[i + 1] ?? null;
  };
  return {
    email: get("--email"),
    phone: get("--phone"),
    alertId: get("--alert-id"),
    recipientName: get("--name") ?? "Tester",
    dryRun: argv.includes("--dry-run"),
  };
}

function severityToLabel(severity: number | null | undefined): string | null {
  const labels: Record<number, string> = { 1: "MINIMAL", 2: "LOW", 3: "MEDIUM", 4: "HIGH", 5: "CRITICAL" };
  return severity != null ? (labels[severity] ?? null) : null;
}

function formatCount(n: bigint | number): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toLocaleString();
}

/** Compose a short SMS body — phones don't render the HTML email template,
 * so we surface only the bits that fit in a couple of lines. */
function buildSmsBody(
  alertTitle: string,
  alertUrl: string,
  meta: { severity: string | null; locationName: string | null; affectedPeople: string | null },
): string {
  const parts: string[] = [];
  if (meta.severity) parts.push(`[${meta.severity}]`);
  parts.push(alertTitle);
  const tail: string[] = [];
  if (meta.locationName) tail.push(meta.locationName);
  if (meta.affectedPeople) tail.push(`~${meta.affectedPeople} affected`);
  let body = parts.join(" ");
  if (tail.length) body += `\n${tail.join(" · ")}`;
  body += `\n${alertUrl}`;
  return body;
}

async function main(): Promise<void> {
  const flags = parseFlags();

  if (!flags.email && !flags.phone) {
    console.error("Error: provide at least one of --email or --phone");
    console.error("  bun run scripts/test-alert-notification.ts --email you@example.com --phone +49170123456");
    process.exit(1);
  }

  // ── Pick the alert ────────────────────────────────────────────────────
  // Default = latest published alert by event.firstSignalCreatedAt. The
  // --alert-id override lets you re-run against a specific row.
  const alert = flags.alertId
    ? await prisma.alerts.findUnique({
        where: { id: flags.alertId },
        include: { event: true },
      })
    : await prisma.alerts.findFirst({
        where: { status: "published" },
        include: { event: true },
        orderBy: { event: { firstSignalCreatedAt: "desc" } },
      });

  if (!alert) {
    console.error(
      flags.alertId
        ? `Alert ${flags.alertId} not found.`
        : "No published alerts found in the database.",
    );
    process.exit(2);
  }

  const event = alert.event;
  console.log(`[TEST] Using alert ${alert.id} → event ${event.id}: ${event.title ?? "(untitled)"}`);

  // ── Build the same metadata the production notifier uses ──────────────
  const [originLocation, generalLocation, disasterType] = await Promise.all([
    event.originId
      ? prisma.locations.findUnique({ where: { id: event.originId } })
      : Promise.resolve(null),
    event.locationId
      ? prisma.locations.findUnique({ where: { id: event.locationId } })
      : Promise.resolve(null),
    event.types[0]
      ? prisma.disasterTypes.findFirst({
          where: { glideNumber: event.types[0] },
          select: { level1: true },
        })
      : Promise.resolve(null),
  ]);

  const location = generalLocation ?? originLocation ?? null;
  const locationName = location?.name ?? null;
  const population = location?.population ? formatCount(BigInt(location.population)) : null;
  const severityLabel = severityToLabel(event.severity);
  const affectedPeople = event.populationAffected != null
    ? formatCount(event.populationAffected)
    : null;
  const eventTypeLabel = disasterType?.level1 ?? event.types[0] ?? null;

  const title = event.title ?? "Untitled alert";
  const alertUrl = `${env.FRONTEND_URL}/event/${event.id}`;

  const emailContent = alertNotification(
    flags.recipientName,
    title,
    event.description,
    alertUrl,
    {
      severity: severityLabel,
      eventType: eventTypeLabel,
      locationName,
      population,
      affectedPeople,
    },
  );

  const smsBody = buildSmsBody(title, alertUrl, { severity: severityLabel, locationName, affectedPeople });

  // ── Dispatch ──────────────────────────────────────────────────────────
  if (flags.dryRun) {
    console.log("\n────────── EMAIL (dry-run) ──────────");
    console.log(`Subject: ${emailContent.subject}`);
    console.log(`Text:\n${emailContent.textBody}`);
    console.log("\n────────── SMS (dry-run) ──────────");
    console.log(`To: ${flags.phone ?? "(no --phone)"}`);
    console.log(smsBody);
    console.log("\n[TEST] Dry run — no messages sent.");
    return;
  }

  const tasks: Array<Promise<void>> = [];

  if (flags.email) {
    const recipient = flags.email;
    tasks.push(
      (async () => {
        try {
          const provider = await getEmailProvider();
          const ok = await provider.send({
            to: recipient,
            subject: emailContent.subject,
            textBody: emailContent.textBody,
            htmlBody: emailContent.htmlBody,
          });
          console.log(`[EMAIL → ${recipient}] ${ok ? "sent" : "FAILED (provider returned false)"}`);
        } catch (err) {
          console.error(`[EMAIL → ${recipient}] FAILED:`, err);
          process.exitCode = 3;
        }
      })(),
    );
  }

  if (flags.phone) {
    const recipient = flags.phone;
    tasks.push(
      (async () => {
        try {
          const provider = await getSMSProvider();
          const ok = await provider.send({ to: recipient, body: smsBody });
          console.log(`[SMS → ${recipient}] ${ok ? "sent" : "FAILED (provider returned false)"}`);
        } catch (err) {
          console.error(`[SMS → ${recipient}] FAILED:`, err);
          process.exitCode = 4;
        }
      })(),
    );
  }

  await Promise.all(tasks);
}

main()
  .catch((err) => {
    console.error("[TEST] Fatal:", err);
    process.exit(99);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
