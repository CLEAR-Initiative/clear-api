/**
 * Send a test alert notification (email + SMS) to the recipients you specify.
 *
 * Picks the latest *published* alert in the database, builds the same email
 * payload that `notifyAlertSubscribers` would produce, and a short SMS body,
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
import { alertNotification, buildAlertSms } from "../src/services/messaging/templates.js";
import { isSupportedLocale, DEFAULT_LOCALE, type Locale } from "../src/utils/locales.js";
import {
  resolveEmailLocation,
  resolveEventTypeLabel,
  severityToLabel,
  formatCount,
} from "../src/utils/alert-email-helpers.js";

interface Flags {
  email: string | null;
  phone: string | null;
  alertId: string | null;
  recipientName: string;
  dryRun: boolean;
  /** BCP-47 / ISO 639-1; defaults to "en". Drives both email + SMS chrome. */
  locale: string;
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
    locale: get("--locale") ?? "en",
  };
}

// `buildSmsBody` used to live here; it's been promoted to
// src/services/messaging/templates.ts as `buildAlertSms` so the
// resolver paths can reuse the same locale-aware shape when an SMS
// channel is wired up. Anything that used to import it from this
// script should import from templates.ts directly.

async function main(): Promise<void> {
  const flags = parseFlags();

  if (!flags.email && !flags.phone) {
    console.error("Error: provide at least one of --email or --phone");
    console.error("  bun run scripts/test-alert-notification.ts --email you@example.com --phone +49170123456");
    process.exit(1);
  }

  // Pick the alert - default = latest published by event.firstSignalCreatedAt.
  const alert = flags.alertId
    ? await prisma.alerts.findUnique({
        where: { id: flags.alertId },
        include: {
          event: {
            include: {
              generalLocation: { select: { id: true, name: true, level: true, population: true, ancestorIds: true } },
              originLocation: { select: { id: true, name: true, level: true, population: true, ancestorIds: true } },
            },
          },
        },
      })
    : await prisma.alerts.findFirst({
        where: { status: "published" },
        include: {
          event: {
            include: {
              generalLocation: { select: { id: true, name: true, level: true, population: true, ancestorIds: true } },
              originLocation: { select: { id: true, name: true, level: true, population: true, ancestorIds: true } },
            },
          },
        },
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
  console.log(`[TEST] Using alert ${alert.id} - event ${event.id}: ${event.title ?? "(untitled)"}`);

  const primaryLoc = event.generalLocation ?? event.originLocation ?? null;
  const [emailLoc, eventTypeLabel] = await Promise.all([
    resolveEmailLocation(prisma, primaryLoc),
    resolveEventTypeLabel(prisma, event.types),
  ]);

  const locationName = emailLoc?.name ?? null;
  const population = emailLoc?.population != null ? formatCount(emailLoc.population) : null;
  const severityLabel = severityToLabel(event.severity);

  const title = event.title ?? "Untitled alert";
  const alertUrl = `${env.FRONTEND_URL}/event/${event.id}`;

  // Operator-supplied --locale is a free-form string; narrow it to the
  // template's Locale union. Unsupported values fall back to "en" so a
  // typo doesn't crash the run.
  const locale: Locale = isSupportedLocale(flags.locale)
    ? flags.locale
    : DEFAULT_LOCALE;

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
      locale,
    },
  );

  const smsBody = buildAlertSms(title, alertUrl, {
    severity: severityLabel,
    locationName,
    locale,
  });

  if (flags.dryRun) {
    console.log("\n---------- EMAIL (dry-run) ----------");
    console.log(`Subject: ${emailContent.subject}`);
    console.log(`Text:\n${emailContent.textBody}`);
    console.log("\n---------- SMS (dry-run) ----------");
    console.log(`To: ${flags.phone ?? "(no --phone)"}`);
    console.log(smsBody);
    console.log("\n[TEST] Dry run - no messages sent.");
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
          console.log(`[EMAIL -> ${recipient}] ${ok ? "sent" : "FAILED (provider returned false)"}`);
        } catch (err) {
          console.error(`[EMAIL -> ${recipient}] FAILED:`, err);
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
          console.log(`[SMS -> ${recipient}] ${ok ? "sent" : "FAILED (provider returned false)"}`);
        } catch (err) {
          console.error(`[SMS -> ${recipient}] FAILED:`, err);
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
