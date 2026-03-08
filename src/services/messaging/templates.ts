/**
 * Email templates for the CLEAR platform.
 *
 * Mirrors Django `alerts/services/notifications.py` fallback templates.
 * Returns { subject, textBody, htmlBody } for each template type.
 */

interface EmailContent {
  subject: string;
  textBody: string;
  htmlBody: string;
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
    subject: "Verify your email address — CLEAR Platform",

    textBody: `Hi ${displayName},

Please verify your email address by clicking the link below:

${verificationUrl}

This link will expire in 24 hours.

If you did not request this verification, you can safely ignore this email.

— The CLEAR Platform Team`,

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
                &copy; CLEAR — Crisis Landscape Early Assessment and Response
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
