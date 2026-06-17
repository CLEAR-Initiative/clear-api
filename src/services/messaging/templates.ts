/**
 * Email templates for the CLEAR platform.
 *
 * Mirrors Django `alerts/services/notifications.py` fallback templates.
 * Returns { subject, textBody, htmlBody } for each template type.
 */

import {
  DEFAULT_LOCALE,
  LOCALE_DIRECTION,
  type Locale,
} from "../../utils/locales.js";

export interface EmailContent {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/**
 * Per-locale chrome strings for the alert email — every label, button,
 * greeting, and subject the template renders. Keep the EN entry as the
 * source of truth; the others should mirror its shape exactly so a
 * missing key never surfaces as `undefined` in the email.
 *
 * Caller chooses the locale via the `locale` parameter to
 * `alertNotification`; an unsupported locale silently falls through to
 * the EN strings.
 */
interface AlertStrings {
  greeting: (name: string) => string;
  newAlertPrefix: string;            // "New alert"
  districtLabel: string;             // "District" (HTML + text caps)
  locationsLabel: string;            // "Locations"
  summaryLabel: string;              // "Summary"
  populationLabel: (target: string | null) => string; // "Population [of X]"
  viewAlertTextLine: (url: string) => string;
  viewAlertCta: string;              // "View Alert" CTA button
  signoff: string;                   // "- The CLEAR Platform Team"
  subject: (title: string) => string;
  moreSuffix: (n: number) => string; // " +N more"
  footerCopy: string;                // copyright line
  /**
   * Locale-specific render of each severity tier. Keys are the English
   * labels produced by `severityToLabel` (CRITICAL/HIGH/MEDIUM/LOW/MINIMAL);
   * values are the user-facing string shown in the email severity chip
   * and the SMS bracket. Caller still passes the canonical English
   * string in `extras.severity` and the template looks up the
   * recipient-locale variant here.
   */
  severityLabels: Record<string, string>;
}

// Same key shape across every locale — adding a new locale means
// providing every key. Translations are kept short and neutral so
// they fit the existing template padding.
const STRINGS: Record<Locale, AlertStrings> = {
  en: {
    greeting: (n) => `Hi ${n},`,
    newAlertPrefix: "New alert",
    districtLabel: "District",
    locationsLabel: "Locations",
    summaryLabel: "Summary",
    populationLabel: (t) => `Population${t ? ` of ${t}` : ""}`,
    viewAlertTextLine: (u) => `View alert: ${u}`,
    viewAlertCta: "View Alert",
    signoff: "- The CLEAR Platform Team",
    subject: (t) => `Alert: ${t} - CLEAR Platform`,
    moreSuffix: (n) => ` +${n} more`,
    footerCopy: "© CLEAR - Crisis Learning, Early-warning, Anticipation, and Response",
    severityLabels: {
      CRITICAL: "CRITICAL",
      HIGH: "HIGH",
      MEDIUM: "MEDIUM",
      LOW: "LOW",
      MINIMAL: "MINIMAL",
    },
  },
  ar: {
    greeting: (n) => `مرحبًا ${n}،`,
    newAlertPrefix: "تنبيه جديد",
    districtLabel: "المنطقة",
    locationsLabel: "المواقع",
    summaryLabel: "ملخص",
    populationLabel: (t) => `السكان${t ? ` في ${t}` : ""}`,
    viewAlertTextLine: (u) => `عرض التنبيه: ${u}`,
    viewAlertCta: "عرض التنبيه",
    signoff: "- فريق منصة CLEAR",
    subject: (t) => `تنبيه: ${t} - منصة CLEAR`,
    moreSuffix: (n) => ` +${n} المزيد`,
    footerCopy: "© CLEAR - التعلم والإنذار المبكر والتوقع والاستجابة للأزمات",
    severityLabels: {
      CRITICAL: "حرج",
      HIGH: "عالٍ",
      MEDIUM: "متوسط",
      LOW: "منخفض",
      MINIMAL: "ضئيل",
    },
  },
  fr: {
    greeting: (n) => `Bonjour ${n},`,
    newAlertPrefix: "Nouvelle alerte",
    districtLabel: "District",
    locationsLabel: "Lieux",
    summaryLabel: "Résumé",
    populationLabel: (t) => `Population${t ? ` de ${t}` : ""}`,
    viewAlertTextLine: (u) => `Voir l'alerte : ${u}`,
    viewAlertCta: "Voir l'alerte",
    signoff: "- L'équipe de la plateforme CLEAR",
    subject: (t) => `Alerte : ${t} - Plateforme CLEAR`,
    moreSuffix: (n) => ` +${n} de plus`,
    footerCopy: "© CLEAR - Apprentissage, alerte précoce, anticipation et réponse aux crises",
    severityLabels: {
      CRITICAL: "CRITIQUE",
      HIGH: "ÉLEVÉ",
      MEDIUM: "MOYEN",
      LOW: "FAIBLE",
      MINIMAL: "MINIMAL",
    },
  },
};

/**
 * Map a raw English severity label (CRITICAL/HIGH/MEDIUM/LOW/MINIMAL)
 * to its locale-specific render. Falls back to the raw label when no
 * locale-specific variant exists so an unrecognised input still shows
 * up in the message instead of becoming a silent `undefined`.
 */
function localizeSeverity(
  rawSeverity: string | null | undefined,
  s: AlertStrings,
): string | null {
  if (!rawSeverity) return null;
  return s.severityLabels[rawSeverity] ?? rawSeverity;
}

function stringsFor(locale: Locale | undefined): AlertStrings {
  if (locale && STRINGS[locale]) return STRINGS[locale];
  return STRINGS[DEFAULT_LOCALE];
}

/** Reusable HTML email wrapper */
function wrapHtml(heading: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding: 32px 32px 0; text-align: center;">
              <h1 style="margin: 0 0 8px; font-size: 20px; font-weight: 700; color: #171717;">CLEAR Platform</h1>
              <p style="margin: 0; font-size: 13px; color: #737373; text-transform: uppercase; letter-spacing: 0.05em;">${heading}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">${body}</td>
          </tr>
          <tr>
            <td style="padding: 0 32px 32px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #A3A3A3;">&copy; CLEAR - Crisis Learning, Early-warning, Anticipation, and Response</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(label: string, url: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding: 8px 0 24px;">
    <a href="${url}" style="display: inline-block; padding: 12px 32px; background-color: #2563EB; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; border-radius: 6px;">${label}</a>
  </td></tr></table>`;
}

/**
 * Email verification template.
 *
 * Sent when a user requests email verification from their profile page.
 */
export function emailVerification(
  userName: string,
  verificationUrl: string,
): EmailContent {
  const displayName = userName || "there";

  return {
    subject: "Verify your email address - CLEAR Platform",

    textBody: `Hi ${displayName},

Please verify your email address by clicking the link below:

${verificationUrl}

This link will expire in 24 hours.

If you did not request this verification, you can safely ignore this email.

- The CLEAR Platform Team`,

    htmlBody: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 0; text-align: center;">
              <h1 style="margin: 0 0 8px; font-size: 20px; font-weight: 700; color: #171717;">
                CLEAR Platform
              </h1>
              <p style="margin: 0; font-size: 13px; color: #737373; text-transform: uppercase; letter-spacing: 0.05em;">
                Email Verification
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 16px; font-size: 15px; color: #171717; line-height: 1.5;">
                Hi ${displayName},
              </p>
              <p style="margin: 0 0 24px; font-size: 15px; color: #525252; line-height: 1.5;">
                Please verify your email address by clicking the button below. This will enable you to receive email notifications for crisis alerts and updates.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 8px 0 24px;">
                    <a href="${verificationUrl}"
                       style="display: inline-block; padding: 12px 32px; background-color: #2563EB; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; border-radius: 6px;">
                      Verify Email Address
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 8px; font-size: 13px; color: #737373; line-height: 1.5;">
                This link will expire in 24 hours. If the button doesn't work, copy and paste this URL into your browser:
              </p>
              <p style="margin: 0 0 24px; font-size: 12px; color: #2563EB; word-break: break-all; line-height: 1.4;">
                ${verificationUrl}
              </p>

              <hr style="border: none; border-top: 1px solid #E5E5E5; margin: 24px 0;" />

              <p style="margin: 0; font-size: 12px; color: #A3A3A3; line-height: 1.5;">
                If you did not request this verification, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 0 32px 32px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #A3A3A3;">
                &copy; CLEAR - Crisis Learning, Early-warning, Anticipation, and Response
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}

/**
 * Organisation invite template.
 * Sent when an admin invites a new or existing user to join an organisation.
 */
export function organisationInvite(
  inviterName: string,
  orgName: string,
  role: string,
  inviteUrl: string,
  teamName?: string,
): EmailContent {
  const teamLine = teamName ? ` and the "${teamName}" team` : "";
  const subject = `You've been invited to join ${orgName} on CLEAR Platform`;

  return {
    subject,
    textBody: `${inviterName} has invited you to join "${orgName}"${teamLine} as ${role} on the CLEAR Platform.

Click the link below to accept your invitation and set up your account:

${inviteUrl}

This invitation expires in 7 days.

- The CLEAR Platform Team`,

    htmlBody: wrapHtml(
      "Organisation Invitation",
      `<p style="margin: 0 0 16px; font-size: 15px; color: #171717; line-height: 1.5;">
        You've been invited!
      </p>
      <p style="margin: 0 0 24px; font-size: 15px; color: #525252; line-height: 1.5;">
        <strong>${inviterName}</strong> has invited you to join
        <strong>${orgName}</strong>${teamLine} as <strong>${role}</strong>
        on the CLEAR Platform.
      </p>
      ${ctaButton("Accept Invitation", inviteUrl)}
      <p style="margin: 0 0 8px; font-size: 13px; color: #737373; line-height: 1.5;">
        This invitation expires in 7 days. If the button doesn't work, copy and paste this URL:
      </p>
      <p style="margin: 0 0 24px; font-size: 12px; color: #2563EB; word-break: break-all; line-height: 1.4;">
        ${inviteUrl}
      </p>
      <hr style="border: none; border-top: 1px solid #E5E5E5; margin: 24px 0;" />
      <p style="margin: 0; font-size: 12px; color: #A3A3A3; line-height: 1.5;">
        If you were not expecting this invitation, you can safely ignore this email.
      </p>`,
    ),
  };
}

/**
 * Team invite notification for existing org members.
 * Sent when an admin adds an existing org member to a new team.
 */
export function teamInviteNotification(
  inviterName: string,
  orgName: string,
  teamName: string,
  teamRole: string,
  dashboardUrl: string,
): EmailContent {
  return {
    subject: `You've been added to ${teamName} on CLEAR Platform`,

    textBody: `${inviterName} has added you to the "${teamName}" team in "${orgName}" as ${teamRole}.

Visit your dashboard to start working with your new team:

${dashboardUrl}

- The CLEAR Platform Team`,

    htmlBody: wrapHtml(
      "Team Assignment",
      `<p style="margin: 0 0 16px; font-size: 15px; color: #171717; line-height: 1.5;">
        You've been added to a new team!
      </p>
      <p style="margin: 0 0 24px; font-size: 15px; color: #525252; line-height: 1.5;">
        <strong>${inviterName}</strong> has added you to the
        <strong>${teamName}</strong> team in <strong>${orgName}</strong>
        as <strong>${teamRole}</strong>.
      </p>
      ${ctaButton("Go to Dashboard", dashboardUrl)}
      <hr style="border: none; border-top: 1px solid #E5E5E5; margin: 24px 0;" />
      <p style="margin: 0; font-size: 12px; color: #A3A3A3; line-height: 1.5;">
        You received this because you are a member of ${orgName}.
      </p>`,
    ),
  };
}

/**
 * Password reset template.
 */
export function passwordReset(
  userName: string,
  resetUrl: string,
): EmailContent {
  const displayName = userName || "there";

  return {
    subject: "Reset your password - CLEAR Platform",

    textBody: `Hi ${displayName},

We received a request to reset your password. Click the link below to set a new password:

${resetUrl}

This link will expire in 1 hour.

If you did not request this, you can safely ignore this email. Your password will not be changed.

- The CLEAR Platform Team`,

    htmlBody: wrapHtml(
      "Password Reset",
      `<p style="margin: 0 0 16px; font-size: 15px; color: #171717; line-height: 1.5;">
        Hi ${displayName},
      </p>
      <p style="margin: 0 0 24px; font-size: 15px; color: #525252; line-height: 1.5;">
        We received a request to reset your password. Click the button below to set a new password.
      </p>
      ${ctaButton("Reset Password", resetUrl)}
      <p style="margin: 0 0 8px; font-size: 13px; color: #737373; line-height: 1.5;">
        This link will expire in 1 hour. If the button doesn't work, copy and paste this URL:
      </p>
      <p style="margin: 0 0 24px; font-size: 12px; color: #2563EB; word-break: break-all; line-height: 1.4;">
        ${resetUrl}
      </p>
      <hr style="border: none; border-top: 1px solid #E5E5E5; margin: 24px 0;" />
      <p style="margin: 0; font-size: 12px; color: #A3A3A3; line-height: 1.5;">
        If you did not request this reset, you can safely ignore this email. Your password will not be changed.
      </p>`,
    ),
  };
}

export interface AlertNotificationExtras {
  eventType?: string | null;
  severity?: string | null;
  dataSource?: string | null;
  locationName?: string | null;
  population?: string | null;
  affectedPeople?: string | null;
  /** Closest level-2 ancestor of the event, rendered as `DISTRICT: <name>`. */
  districtName?: string | null;
  /** Names of every signal's location, deduped, capped (see helpers). */
  signalLocations?: string[] | null;
  /** Count of signal locations dropped past the cap, shown as "+N more". */
  signalLocationsOverflow?: number;
  /**
   * Recipient locale — drives every chrome string (greeting, labels,
   * CTA, signoff, subject) as well as the document's `lang` + `dir`
   * attributes. Defaults to "en" when unset so the test script and
   * pre-locale callers keep working.
   */
  locale?: Locale;
}

/**
 * Immediate alert notification - single alert sent to a subscriber.
 */
export function alertNotification(
  userName: string,
  alertTitle: string,
  alertDescription: string | null,
  alertUrl: string,
  extras?: AlertNotificationExtras,
): EmailContent {
  const displayName = userName || "there";
  const {
    eventType,
    severity,
    dataSource,
    locationName,
    population,
    districtName,
    signalLocations,
    signalLocationsOverflow,
    locale,
  } = extras ?? {};

  const effectiveLocale: Locale = locale ?? DEFAULT_LOCALE;
  const dir = LOCALE_DIRECTION[effectiveLocale] ?? "ltr";
  const s = stringsFor(effectiveLocale);
  // Caller passes the raw English severity label ("CRITICAL", etc.) in
  // `severity` — render it through the locale's translation so the
  // chip in the email displays in the recipient's language.
  const localizedSeverity = localizeSeverity(severity, s);

  // Format the signal-location list once — the same string is used by the
  // plain-text body and the HTML below.
  const signalLocationsList = (signalLocations ?? []).filter(Boolean);
  const overflow = Math.max(0, signalLocationsOverflow ?? 0);
  const locationsLine =
    signalLocationsList.length > 0
      ? `${signalLocationsList.join(", ")}${overflow > 0 ? s.moreSuffix(overflow) : ""}`
      : null;

  // Plain-text rendering: stack DISTRICT and LOCATIONS as labelled lines.
  // Fall back to the bare `locationName` only when neither structured field
  // is provided (back-compat for callers that haven't been updated).
  const textParts: string[] = [
    s.greeting(displayName),
    "",
    `${s.newAlertPrefix}: ${alertTitle}`,
  ];
  if (districtName) textParts.push(`${s.districtLabel.toUpperCase()}: ${districtName}`);
  if (locationsLine) textParts.push(`${s.locationsLabel.toUpperCase()}: ${locationsLine}`);
  if (!districtName && !locationsLine && locationName) textParts.push(locationName);
  if (alertDescription) textParts.push("", alertDescription);
  textParts.push("", s.viewAlertTextLine(alertUrl), "", s.signoff);

  // Stat box prefers the district label (matches what's shown above).
  const statBoxes: Array<{ value: string; label: string }> = [];
  const populationLabelTarget = districtName ?? locationName ?? null;
  if (population != null) {
    statBoxes.push({
      value: population,
      label: s.populationLabel(populationLabelTarget),
    });
  }

  const statCellStyle = "border: 1px solid #E5E5E5; border-radius: 6px; padding: 16px; vertical-align: top;";
  const statsHtml = statBoxes.length > 0
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 12px; border-collapse: separate; border-spacing: 8px 0;">
        <tr>
          ${statBoxes.map((s) =>
            `<td style="${statCellStyle}">
              <p style="margin: 0 0 4px; font-size: 22px; font-weight: 700; color: #171717;">${s.value}</p>
              <p style="margin: 0; font-size: 12px; color: #737373;">${s.label}</p>
            </td>`
          ).join("")}
        </tr>
      </table>`
    : "";

  const summaryHtml = alertDescription
    ? `<div style="border: 1px solid #E5E5E5; border-radius: 6px; padding: 20px; margin: 0 0 24px;">
        <p style="margin: 0 0 10px; font-size: 13px; font-weight: 700; color: #171717; text-transform: uppercase; letter-spacing: 0.05em;">${s.summaryLabel}</p>
        <p style="margin: 0; font-size: 14px; color: #525252; line-height: 1.6;">${alertDescription}</p>
      </div>`
    : "";

  const htmlBody = `<!DOCTYPE html>
<html lang="${effectiveLocale}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

          <!-- Meta row: severity + event type | data source -->
          <tr>
            <td style="padding: 28px 32px 0;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    ${localizedSeverity ? `<span style="font-size: 12px; font-weight: 700; color: #E85D3D; text-transform: uppercase; letter-spacing: 0.08em;">${localizedSeverity}</span>` : ""}
                    ${eventType ? `<span style="font-size: 12px; color: #737373;${severity ? " margin-left: 6px;" : ""} text-transform: uppercase; letter-spacing: 0.05em;">${eventType}</span>` : ""}
                  </td>
                  ${dataSource ? `<td align="right"><span style="font-size: 12px; color: #A3A3A3;">${dataSource}</span></td>` : ""}
                </tr>
              </table>
            </td>
          </tr>

          <!-- Alert title -->
          <tr>
            <td style="padding: 10px 32px 0;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 800; color: #171717; line-height: 1.2;">${alertTitle}</h1>
            </td>
          </tr>

          <!-- Location -->
          ${(() => {
            const labelStyle =
              "font-weight: 700; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em; color: #171717;";
            const valueStyle = "color: #525252;";
            const lineStyle = "margin: 0 0 4px; font-size: 14px; line-height: 1.5;";
            const lines: string[] = [];
            if (districtName) {
              lines.push(
                `<p style="${lineStyle}"><span style="${labelStyle}">${s.districtLabel}:</span> <span style="${valueStyle}">${districtName}</span></p>`,
              );
            }
            if (locationsLine) {
              lines.push(
                `<p style="${lineStyle}"><span style="${labelStyle}">${s.locationsLabel}:</span> <span style="${valueStyle}">${locationsLine}</span></p>`,
              );
            }
            // Back-compat: callers that only pass the legacy `locationName`
            // (e.g. test-alert-notification) still render the single grey row.
            if (lines.length === 0 && locationName) {
              lines.push(
                `<p style="margin: 0; font-size: 14px; color: #737373;">${locationName}</p>`,
              );
            }
            return lines.length > 0
              ? `<tr><td style="padding: 8px 32px 0;">${lines.join("")}</td></tr>`
              : "";
          })()}

          <!-- Stats -->
          ${statsHtml ? `<tr><td style="padding: 20px 32px 0;">${statsHtml}</td></tr>` : ""}

          <!-- Summary -->
          ${summaryHtml ? `<tr><td style="padding: 20px 32px 0;">${summaryHtml}</td></tr>` : ""}

          <!-- CTA -->
          <tr>
            <td style="padding: 8px 32px 32px;" align="center">
              <a href="${alertUrl}" style="display: inline-block; padding: 14px 48px; background-color: #E85D3D; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 700; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.08em;">${s.viewAlertCta}</a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 0 32px 24px; text-align: center; border-top: 1px solid #F5F5F5;">
              <p style="margin: 16px 0 0; font-size: 11px; color: #A3A3A3;">${s.footerCopy}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: s.subject(alertTitle),
    textBody: textParts.join("\n"),
    htmlBody,
  };
}

/**
 * Alert digest - personalized list of alerts for a subscriber.
 */
export function alertDigest(
  userName: string,
  frequency: string,
  alertItems: Array<{ title: string; description: string | null; url: string }>,
  dashboardUrl: string,
): EmailContent {
  const displayName = userName || "there";
  const freqLabel = frequency.charAt(0).toUpperCase() + frequency.slice(1);
  const count = alertItems.length;

  const alertListText = alertItems
    .map((a, i) => `${i + 1}. ${a.title}${a.description ? ` - ${a.description}` : ""}`)
    .join("\n");

  const alertListHtml = alertItems
    .map(
      (a) =>
        `<div style="margin: 8px 0; padding: 12px 16px; background: #F5F5F5; border-radius: 6px; border-left: 3px solid #E85D3D;">
          <a href="${a.url}" style="text-decoration: none;">
            <p style="margin: 0 0 2px; font-size: 14px; font-weight: 600; color: #171717;">${a.title}</p>
            ${a.description ? `<p style="margin: 0; font-size: 13px; color: #525252;">${a.description}</p>` : ""}
          </a>
        </div>`,
    )
    .join("");

  return {
    subject: `${freqLabel} Alert Digest (${count}) - CLEAR Platform`,

    textBody: `Hi ${displayName},

Here is your ${frequency} alert digest with ${count} alert${count > 1 ? "s" : ""}:

${alertListText}

View all alerts: ${dashboardUrl}

- The CLEAR Platform Team`,

    htmlBody: wrapHtml(
      `${freqLabel} Alert Digest`,
      `<p style="margin: 0 0 16px; font-size: 15px; color: #171717; line-height: 1.5;">
        Hi ${displayName},
      </p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #525252; line-height: 1.5;">
        Here is your ${frequency} alert digest with <strong>${count}</strong> alert${count > 1 ? "s" : ""} matching your subscriptions:
      </p>
      ${alertListHtml}
      ${ctaButton("View All Alerts", dashboardUrl)}
      <hr style="border: none; border-top: 1px solid #E5E5E5; margin: 24px 0;" />
      <p style="margin: 0; font-size: 12px; color: #A3A3A3; line-height: 1.5;">
        You received this because of your alert subscriptions. Manage your subscriptions in Settings.
      </p>`,
    ),
  };
}

export interface AlertSmsOptions {
  /** Locale label (e.g. "حرج" from severityLabels). Pass the raw English label — the function localizes. */
  severity?: string | null;
  /** Already-localized location name (caller is responsible). */
  locationName?: string | null;
  /** Recipient locale; falls back to DEFAULT_LOCALE when unset. */
  locale?: Locale;
}

/**
 * Compact alert SMS body. Phones don't render HTML and many carriers
 * cap at 160 characters per segment, so the body keeps to three short
 * lines:
 *
 *   [SEVERITY] {title}
 *   {locationName}        (optional)
 *   {url}
 *
 * The severity tag is rendered in the recipient's locale (looked up
 * via the same `severityLabels` map the email uses). Caller passes
 * already-localized `alertTitle` and `locationName` so the line bodies
 * carry the recipient's language too.
 */
export function buildAlertSms(
  alertTitle: string,
  alertUrl: string,
  options: AlertSmsOptions = {},
): string {
  const { severity, locationName, locale } = options;
  const effectiveLocale: Locale = locale ?? DEFAULT_LOCALE;
  const s = stringsFor(effectiveLocale);
  const localizedSeverity = localizeSeverity(severity, s);

  const headerParts: string[] = [];
  if (localizedSeverity) headerParts.push(`[${localizedSeverity}]`);
  headerParts.push(alertTitle);

  let body = headerParts.join(" ");
  if (locationName) body += `\n${locationName}`;
  body += `\n${alertUrl}`;
  return body;
}
