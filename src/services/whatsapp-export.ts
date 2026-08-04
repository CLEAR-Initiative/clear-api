/**
 * WhatsApp chat-export (.txt) parser → canonical ground messages.
 *
 * Input is the `_chat.txt` produced by WhatsApp's "Export chat" (iOS
 * format observed on real exports):
 *
 *   [dd.mm.yy, hh:mm:ss] Sender: text
 *
 * with the following quirks, all handled here:
 *   - CRLF line endings.
 *   - Invisible directionality marks (U+200E LRM) sprinkled before
 *     brackets, sender names, and markers; U+202F narrow no-break space
 *     after the `~` prefix on non-contact senders.
 *   - Multi-line messages: continuation lines don't start with `[`.
 *   - `<This message was edited>` marker appended to edited messages.
 *   - Media: `<attached: filename>` when the export includes media files,
 *     `image omitted` / `video omitted` / `document omitted` / etc. when
 *     it doesn't. A media message may have a caption or be caption-less.
 *   - System messages ("X added Y", "Messages and calls are end-to-end
 *     encrypted…", "X changed the group name…") — filtered out.
 *   - `This message was deleted.` placeholders — filtered out.
 *
 * Timestamps carry no timezone; they are interpreted as UTC so parsing is
 * deterministic across environments. The staging tier treats them as
 * "sender-local wall clock" — good enough for review ordering.
 *
 * Everything here is pure — no I/O, no DB — so the format edge cases are
 * unit-testable (tests/services/whatsapp-export.test.ts).
 */

import { createHash } from "node:crypto";

export interface ParsedExportMessage {
  sentAt: Date;
  /** Raw sender display name, cleaned of `~` + spacing prefixes. */
  senderName: string;
  /** Message text (caption for media messages), invisible chars stripped,
   * media/edit markers removed. Empty string for caption-less media. */
  text: string;
  /** Attachment filenames from `<attached: …>` markers. */
  mediaRefs: string[];
  /** Count of media the export omitted ("image omitted" etc.). */
  omittedMediaCount: number;
  /** True when the `<This message was edited>` marker was present. */
  isEdited: boolean;
}

/** Directionality/invisible characters WhatsApp sprinkles through exports. */
const INVISIBLE_CHARS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const MESSAGE_START =
  /^\[(\d{2})[./](\d{2})[./](\d{2,4}), (\d{1,2}):(\d{2}):(\d{2})\] ([^:]+): (.*)$/;

const ATTACHED_MARKER = /<attached:\s*([^>]+)>/g;
const OMITTED_MARKER = /\b(?:image|video|audio|document|GIF|sticker|Contact card) omitted\b/g;
const EDITED_MARKER = /<This message was edited>/g;

/** System-message bodies (after invisible-char stripping). Conservative:
 * only patterns observed in real exports / documented by WhatsApp. */
const SYSTEM_PATTERNS: RegExp[] = [
  /^Messages and calls are end-to-end encrypted/,
  /created this group$/,
  /^You created this group/,
  /\badded\b.*$/, // "X added Y", "X added you"
  /\bremoved\b.*$/,
  /\bleft$/,
  /joined using this group's invite link$/,
  /changed the group (name|description|icon|settings)/,
  /changed this group's (icon|settings|description)/,
  /changed their phone number/,
  /changed to/, // "X changed to +…"
  /pinned a message$/,
  /turned on disappearing messages/,
  /turned off disappearing messages/,
  /^Your security code with/,
  /is now an admin$/,
  /^This chat is with a business account/,
];

const DELETED_PATTERNS: RegExp[] = [
  /^This message was deleted\.?$/,
  /^You deleted this message\.?$/,
];

/**
 * Phone-number redaction, applied at persistence (constraint from the
 * WhatsApp Signal Pipeline PRD §4: no phone number is ever stored).
 *
 * Matches international (+249 91 234 5678) and local (0912345678) forms:
 * a `+`-prefixed run, or any digit run of 8+ counting only digits, with
 * spaces/dashes/dots/parens as separators. Plain years/dates (4–6 digits)
 * don't match; long casualty figures aren't digit-runs of 8+ in practice.
 */
const PHONE_RE = /\+\d[\d\s\-.()]{6,}\d|(?<!\d)(?:\d[\s\-.()]?){8,}\d(?!\d)/g;

export const PHONE_REDACTION_PLACEHOLDER = "[phone redacted]";

export function redactPhoneNumbers(text: string): string {
  return text.replace(PHONE_RE, PHONE_REDACTION_PLACEHOLDER);
}

/** Contributor uncertainty tags that must survive ingestion (PRD §3.3).
 * Returns the first marker found, normalised to lowercase, or null. */
const UNCERTAINTY_MARKERS = ["unconfirmed", "rumour", "rumor", "unverified", "not verified"];

export function extractUncertaintyMarker(text: string): string | null {
  const lower = text.toLowerCase();
  for (const marker of UNCERTAINTY_MARKERS) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_CHARS, "");
}

function cleanSender(raw: string): string {
  // "~<U+202F>Name" -> "Name"; the ~ prefix marks a non-contact display name.
  return stripInvisible(raw).replace(/^~\s*/, "").trim();
}

function isSystemBody(body: string): boolean {
  return SYSTEM_PATTERNS.some((re) => re.test(body));
}

function isDeletedBody(body: string): boolean {
  return DELETED_PATTERNS.some((re) => re.test(body));
}

/**
 * Parse a WhatsApp chat export into canonical messages, in file order.
 * System messages and deleted-message placeholders are filtered out.
 * Text is NOT yet phone-redacted — persistence applies redaction so the
 * rule lives at the storage boundary (see services/ground-ingest.ts).
 */
export function parseWhatsAppExport(exportText: string): ParsedExportMessage[] {
  const lines = exportText.split(/\r?\n/);
  const messages: ParsedExportMessage[] = [];

  let current: {
    sentAt: Date;
    senderName: string;
    rawBody: string[];
    /** Whether the body began with U+200E — the signature WhatsApp puts on
     * system notices. Gates the system-pattern match so a genuine message
     * like "we added new guidelines" is never filtered. */
    bodyStartedWithLrm: boolean;
  } | null = null;

  const flush = () => {
    if (!current) return;
    const message = finaliseMessage(current);
    if (message) messages.push(message);
    current = null;
  };

  for (const rawLine of lines) {
    // Strip invisible chars for the structural match only — a line may
    // start with U+200E before the `[`.
    const structural = stripInvisible(rawLine).replace(/\r$/, "");
    const match = MESSAGE_START.exec(structural);
    if (match) {
      flush();
      const [, dd, mm, yy, hh, min, ss, sender, body] = match;
      const year = yy!.length === 2 ? 2000 + Number(yy) : Number(yy);
      const sentAt = new Date(
        Date.UTC(year, Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)),
      );
      const bodyStartedWithLrm = /^‎?\[[^\]]+\] [^:]*: ‎/.test(rawLine);
      current = {
        sentAt,
        senderName: cleanSender(sender!),
        rawBody: [body!],
        bodyStartedWithLrm,
      };
    } else if (current) {
      current.rawBody.push(structural);
    }
    // Lines before the first message-start (shouldn't happen) are dropped.
  }
  flush();

  return messages;
}

function finaliseMessage(m: {
  sentAt: Date;
  senderName: string;
  rawBody: string[];
  bodyStartedWithLrm: boolean;
}): ParsedExportMessage | null {
  let body = m.rawBody.join("\n").trim();

  // System notices carry a leading U+200E on the body — only such bodies
  // are tested against the (necessarily broad) system patterns, so a real
  // message like "we added new guidelines" is never filtered. Deleted
  // placeholders are exact matches and safe to test unconditionally.
  if (m.bodyStartedWithLrm && isSystemBody(body)) return null;
  if (isDeletedBody(body)) return null;

  const mediaRefs: string[] = [];
  body = body.replace(ATTACHED_MARKER, (_, filename: string) => {
    mediaRefs.push(filename.trim());
    return "";
  });

  let omittedMediaCount = 0;
  body = body.replace(OMITTED_MARKER, () => {
    omittedMediaCount += 1;
    return "";
  });

  let isEdited = false;
  body = body.replace(EDITED_MARKER, () => {
    isEdited = true;
    return "";
  });

  // U+202F (narrow no-break space) shows up inside real message text;
  // normalise it to a plain space along with other run-on whitespace.
  const text = body
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();

  // A message with no text and no media reference (can happen when markers
  // were the whole body, e.g. an unsupported event type) is still returned
  // if it referenced media; otherwise there is nothing to stage.
  if (text === "" && mediaRefs.length === 0 && omittedMediaCount === 0) return null;

  return {
    sentAt: m.sentAt,
    senderName: m.senderName,
    text,
    mediaRefs,
    omittedMediaCount,
    isEdited,
  };
}

/**
 * Deterministic pseudonymous sender reference: "s_" + 12 hex of
 * sha256(groundSourceId | senderName). Stable per (source, sender) so a
 * reviewer can follow one contributor through a thread without ever seeing
 * the name outside the private tier.
 */
export function deriveSenderRef(groundSourceId: string, senderName: string): string {
  const digest = createHash("sha256")
    .update(`${groundSourceId}|${senderName}`)
    .digest("hex");
  return `s_${digest.slice(0, 12)}`;
}

/**
 * Deterministic externalId for an export message:
 *   whatsapp:{groupJid}:{contentHash[:16]}
 *
 * Chat exports carry no upstream message id, so the id is a content hash
 * of (sentAt, sender, text, media refs). `occurrence` disambiguates
 * legitimately identical messages within one export (same sender, same
 * second, same text — observed with burst-forwarded media) while staying
 * stable across re-uploads: the Nth identical message hashes the same both
 * times. This is what makes re-upload idempotent (unique
 * [groundSourceId, externalId] in the schema).
 */
export function deriveExternalId(
  groupJid: string,
  message: ParsedExportMessage,
  occurrence: number,
): string {
  const digest = createHash("sha256")
    .update(
      [
        message.sentAt.toISOString(),
        message.senderName,
        message.text,
        message.mediaRefs.join(","),
        String(message.omittedMediaCount),
        String(occurrence),
      ].join("|"),
    )
    .digest("hex");
  return `whatsapp:${groupJid}:${digest.slice(0, 16)}`;
}

/**
 * Assign externalIds to a parsed export in order, counting occurrences of
 * identical content tuples so duplicates get distinct, stable ids.
 */
export function withExternalIds(
  groupJid: string,
  messages: ParsedExportMessage[],
): Array<ParsedExportMessage & { externalId: string }> {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const contentKey = [
      message.sentAt.toISOString(),
      message.senderName,
      message.text,
      message.mediaRefs.join(","),
      String(message.omittedMediaCount),
    ].join("|");
    const occurrence = seen.get(contentKey) ?? 0;
    seen.set(contentKey, occurrence + 1);
    return { ...message, externalId: deriveExternalId(groupJid, message, occurrence) };
  });
}
