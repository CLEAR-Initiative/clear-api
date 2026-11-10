/**
 * GlitchTip alert → Matrix room.
 *
 * GlitchTip cannot post to Matrix itself: its webhook recipient sends a
 * Slack-style body (`text` is just "GlitchTip Alert"; the real content is in
 * `attachments`). The /webhooks/glitchtip receiver hands each alert here,
 * and we post one readable message to a Matrix room through the raw
 * client-server API with a bot account's access token. No SDK, no sync.
 *
 * Best-effort and fire-and-forget: disabled (no-op) unless all three env
 * vars are set; failures are retried a few times with the SAME transaction
 * id (so a retry after a lost response cannot post twice) and then logged.
 * Nothing here can fail the receiver's response to GlitchTip.
 *
 * The room must be UNENCRYPTED and the bot must already be joined.
 *
 * Env:
 * - MATRIX_HOMESERVER_URL      e.g. https://comms.clearinitiative.io
 * - MATRIX_ACCESS_TOKEN        the posting bot's access token
 * - MATRIX_GLITCHTIP_ROOM_ID   internal room id (!abc:server), not an alias
 */

import { randomUUID } from "node:crypto";

export interface MatrixConfig {
  homeserverUrl: string;
  accessToken: string;
  roomId: string;
}

export interface MatrixMessage {
  /** Plain-text fallback. */
  body: string;
  /** HTML rendering. All untrusted text is escaped. */
  formattedBody: string;
}

interface SlackField {
  title?: unknown;
  value?: unknown;
}

interface SlackAttachment {
  title?: unknown;
  title_link?: unknown;
  text?: unknown;
  fields?: unknown;
}

/** Fields worth showing, in display order. Matched case-insensitively
 *  against GlitchTip's attachment `fields[].title`. */
const SHOWN_FIELDS = ["project", "environment", "release"];

/** Event-type lead-ins. Unknown aliases fall back to a generic heading. */
const HEADINGS: Record<string, string> = {
  "issue.new": "New error",
  "issue.regression": "Regression",
  "issue.resolved": "Resolved",
};

/** Cap on the title and detail text so a giant stack-trace title cannot
 *  produce a wall of text in the room. */
const MAX_TITLE = 300;
const MAX_TEXT = 500;

export function matrixConfigFromEnv(env: {
  MATRIX_HOMESERVER_URL?: string;
  MATRIX_ACCESS_TOKEN?: string;
  MATRIX_GLITCHTIP_ROOM_ID?: string;
}): MatrixConfig | null {
  const homeserverUrl = env.MATRIX_HOMESERVER_URL;
  const accessToken = env.MATRIX_ACCESS_TOKEN;
  const roomId = env.MATRIX_GLITCHTIP_ROOM_ID;
  if (!homeserverUrl || !accessToken || !roomId) return null;
  return { homeserverUrl, accessToken, roomId };
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Only http(s) links are rendered as anchors — anything else would let a
 *  crafted payload inject a `javascript:` href. */
function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Turn a GlitchTip generic-webhook body into a Matrix message. Tolerant of
 * missing pieces: GlitchTip versions differ, and the synthetic test payload
 * from the developer portal is minimal.
 */
export function formatGlitchtipAlert(payload: unknown): MatrixMessage {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const first: unknown = Array.isArray(p.attachments) ? p.attachments[0] : undefined;
  const attachment = (first && typeof first === "object" ? first : {}) as SlackAttachment;

  const alias = str(p.alias);
  const heading = (alias && HEADINGS[alias]) ?? "GlitchTip alert";
  const title = truncate(str(attachment.title) ?? str(p.text) ?? "Untitled issue", MAX_TITLE);
  const link = safeUrl(attachment.title_link);
  const detail = str(attachment.text);

  const fields = Array.isArray(attachment.fields) ? (attachment.fields as SlackField[]) : [];
  const shown: { name: string; value: string }[] = [];
  for (const wanted of SHOWN_FIELDS) {
    const f = fields.find(
      (x) => x !== null && typeof x === "object" && str(x.title)?.toLowerCase() === wanted,
    );
    const value = f ? str(f.value) : null;
    if (f && value) shown.push({ name: str(f.title) as string, value });
  }
  // Older payloads put the project slug at the top level instead.
  if (!shown.some((s) => s.name.toLowerCase() === "project")) {
    const project = str(p.project);
    if (project) shown.unshift({ name: "Project", value: project });
  }

  const meta = shown.map((s) => `${s.name}: ${s.value}`).join(" · ");
  const metaHtml = shown
    .map((s) => `${escapeHtml(s.name)}: <code>${escapeHtml(s.value)}</code>`)
    .join(" · ");

  const textLines = [`🚨 ${heading}: ${title}`];
  if (meta) textLines.push(meta);
  if (detail) textLines.push(truncate(detail, MAX_TEXT));
  if (link) textLines.push(link);

  const titleHtml = link
    ? `<a href="${escapeHtml(link)}">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const htmlParts = [`🚨 <strong>${escapeHtml(heading)}:</strong> ${titleHtml}`];
  if (metaHtml) htmlParts.push(metaHtml);
  if (detail) htmlParts.push(`<em>${escapeHtml(truncate(detail, MAX_TEXT))}</em>`);

  return { body: textLines.join("\n"), formattedBody: htmlParts.join("<br/>") };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 10_000;
/** Delays before attempts 2 and 3. */
const RETRY_DELAYS_MS = [1_000, 5_000];
/** Upper bound on a homeserver-requested rate-limit wait, so a bogus
 *  `Retry-After` cannot park the task for hours. */
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

/**
 * Wait the homeserver asked for on a 429, in ms: `Retry-After` header
 * (seconds) or the body's `retry_after_ms`. Null when neither is given.
 */
export function rateLimitWaitMs(headers: Headers, bodyText: string): number | null {
  let ms: number | null = null;
  const header = headers.get("retry-after");
  if (header && /^\d+(\.\d+)?$/.test(header.trim())) ms = Number(header.trim()) * 1000;
  if (ms === null) {
    try {
      const v = (JSON.parse(bodyText) as { retry_after_ms?: unknown }).retry_after_ms;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) ms = v;
    } catch {
      // Not JSON — no hint.
    }
  }
  return ms === null ? null : Math.min(ms, MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * Post a message, retrying transient failures. Returns true on success.
 * Never throws.
 */
export async function postMatrixMessage(
  config: MatrixConfig,
  message: MatrixMessage,
  deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const doFetch = deps.fetch ?? (fetch as FetchLike);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // One txn id for every attempt: the homeserver dedupes a retried PUT.
  const txnId = randomUUID();
  const url = `${config.homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(
    config.roomId,
  )}/send/m.room.message/${txnId}`;
  const body = JSON.stringify({
    msgtype: "m.notice",
    body: message.body,
    format: "org.matrix.custom.html",
    formatted_body: message.formattedBody,
  });

  let nextDelayMs: number | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(Math.max(nextDelayMs ?? 0, RETRY_DELAYS_MS[attempt - 1] as number));
    }
    nextDelayMs = null;
    const controller = new AbortController();
    // The timer covers the whole attempt, including reading an error body,
    // so a stalled response cannot block the next retry.
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        void res.body?.cancel().catch(() => {});
        return true;
      }
      const detail = await res.text().catch(() => "");
      console.error(
        `[matrix] send failed (attempt ${attempt + 1}): ${res.status} ${detail.slice(0, 300)}`,
      );
      if (res.status === 429) {
        nextDelayMs = rateLimitWaitMs(res.headers, detail);
      } else if (res.status >= 400 && res.status < 500) {
        // 4xx other than rate-limit won't fix itself (bad token, not in room).
        return false;
      }
    } catch (e) {
      console.error(
        `[matrix] send error (attempt ${attempt + 1}):`,
        e instanceof Error ? e.message : e,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}
