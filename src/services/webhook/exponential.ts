/**
 * GlitchTip alert → Exponential bug ticket.
 *
 * The /webhooks/glitchtip receiver forwards each alert to the workspace's
 * Exponential Sentry webhook, which files one BUG ticket per GlitchTip issue
 * (a repeat alert returns the existing ticket). The reply carries the ticket
 * link, which the Matrix alert then shows.
 *
 * Best-effort: off unless both env vars are set; one attempt with a short
 * timeout; any failure is logged and returns null, so the alert still posts,
 * without a ticket link.
 *
 * Env:
 * - EXPONENTIAL_BUG_WEBHOOK_URL    the integration's webhook URL
 *                                  (https://…/api/webhooks/sentry/<webhookId>)
 * - EXPONENTIAL_BUG_WEBHOOK_TOKEN  the integration's webhook secret
 */

export interface ExponentialBugConfig {
  webhookUrl: string;
  token: string;
}

export interface BugTicket {
  number: number;
  url: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 5_000;

export function exponentialBugConfigFromEnv(env: {
  EXPONENTIAL_BUG_WEBHOOK_URL?: string;
  EXPONENTIAL_BUG_WEBHOOK_TOKEN?: string;
}): ExponentialBugConfig | null {
  const webhookUrl = env.EXPONENTIAL_BUG_WEBHOOK_URL;
  const token = env.EXPONENTIAL_BUG_WEBHOOK_TOKEN;
  if (!webhookUrl || !token) return null;
  return { webhookUrl, token };
}

/** The GlitchTip project the alert is for, as a label slug (e.g. `clear-api`). */
export function alertService(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const first: unknown = Array.isArray(p.attachments) ? p.attachments[0] : undefined;
  const fields: unknown =
    first && typeof first === "object" ? (first as Record<string, unknown>).fields : undefined;
  let project: unknown = p.project;
  if (Array.isArray(fields)) {
    for (const f of fields as unknown[]) {
      if (!f || typeof f !== "object") continue;
      const { title, value } = f as Record<string, unknown>;
      if (typeof title === "string" && title.toLowerCase() === "project") project = value;
    }
  }
  if (typeof project !== "string") return null;
  const slug = project
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * File (or find) the ticket for an alert. Returns null when the feature is
 * off, the event is not one Exponential files, or the call fails. Never throws.
 */
export async function fileBugTicket(
  config: ExponentialBugConfig,
  payload: unknown,
  deps: { fetch?: FetchLike } = {},
): Promise<BugTicket | null> {
  const doFetch = deps.fetch ?? (fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(config.webhookUrl);
    const service = alertService(payload);
    if (service) url.searchParams.set("service", service);
    const res = await doFetch(url.toString(), {
      method: "POST",
      // The token goes in a header, not the URL, so it stays out of proxy logs.
      headers: { "Content-Type": "application/json", "X-Webhook-Token": config.token },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[exponential-bug] webhook failed: ${res.status} ${detail.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as { ticketNumber?: unknown; ticketUrl?: unknown };
    if (typeof data.ticketNumber !== "number" || typeof data.ticketUrl !== "string") return null;
    const ticketUrl = new URL(data.ticketUrl);
    if (ticketUrl.protocol !== "https:" && ticketUrl.protocol !== "http:") return null;
    return { number: data.ticketNumber, url: ticketUrl.toString() };
  } catch (e) {
    console.error("[exponential-bug] webhook error:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
