/**
 * REST endpoint for X (Twitter) push-feed ingestion into the Signals tier.
 *
 * POST /api/x/ingest  (application/json)
 *   Batch shape: { source, generated_at, since_id?, events: [ … ] } (max 100).
 *   Each event is one X post: { id, url, created_at, author, text, metrics }.
 *   Unknown extra fields are ignored, never rejected — and the event object
 *   is stored verbatim (extras included) as the Signal's rawData.
 *
 * The batch self-identifies its push feed via `source` (e.g. "sudan-war-x"),
 * which must resolve to an active dataSources row — feeds are provisioned as
 * data, not routes, so a new watchlist costs zero code (see ADR 0005).
 *
 * Auth: machine callers only — an API key (`Bearer sk_live_…`) belonging to
 * a `pipeline`-role user, the same mechanism as /api/ground/ingest
 * (utils/request-auth.ts). Platform admins also pass, for manual testing.
 *
 * Idempotent: externalId "x:{post id}" under the signals
 * [sourceId, externalId] unique constraint; redelivered posts are skipped
 * via createMany(skipDuplicates) and counted in the response. Signals land
 * with the default status NEW so the standard enrichment drain owns them —
 * this route never sets status.
 *
 * Response: always 200 { created, skipped } for authenticated valid
 * requests; JSON error body on 4xx.
 */

import { Router, json } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { resolveRequestAuth } from "../utils/request-auth.js";

const router = Router();

const X_INGEST_ROLES = new Set(["admin", "pipeline"]);
const MAX_BATCH = 100;
const MAX_TITLE_LENGTH = 100;

/**
 * Truncate post text to a Signal title of at most `max` characters,
 * cutting on a word boundary and appending an ellipsis — but only when
 * something was actually cut. The ellipsis counts toward the budget, so
 * the result never exceeds `max`.
 */
export function truncateTitle(text: string, max = MAX_TITLE_LENGTH): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice.slice(0, max - 1);
  return `${cut.trimEnd()}…`;
}

// Strict ISO 8601 with an explicit Z or numeric offset — Date.parse would
// accept non-ISO strings and read timezone-less ones in server-local time,
// silently skewing publishedAt (which orders the drain).
const isoDate = z.iso.datetime({ offset: true });

// Loose objects: unknown extra fields survive parsing so rawData stays
// verbatim. Author/metrics sub-fields are lenient (nullish) — only id, url,
// created_at and text drive columns; the rest rides along inside rawData.
const eventSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string().min(1),
  created_at: isoDate,
  author: z.looseObject({
    username: z.string().nullish(),
    name: z.string().nullish(),
    verified: z.boolean().nullish(),
  }),
  text: z.string(),
  metrics: z.looseObject({
    likes: z.number().int().nullish(),
    reposts: z.number().int().nullish(),
    replies: z.number().int().nullish(),
  }),
});

// since_id / generated_at are validated but never persisted — poller state
// is derivable from stored externalIds.
const bodySchema = z.looseObject({
  source: z.string().min(1),
  generated_at: isoDate,
  since_id: z.string().nullish(),
  events: z.array(eventSchema).max(MAX_BATCH),
});

// Scoped body parser (same convention as /webhooks and /api/ground/ingest) —
// posts are small text, 1 MB covers a 100-event batch with headroom.
router.use(json({ limit: "1mb" }));

router.post("/", async (req, res) => {
  try {
    const { user } = await resolveRequestAuth(req.headers);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!X_INGEST_ROLES.has(user.role ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid payload",
        details: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      });
      return;
    }
    const { source: sourceName, events } = parsed.data;

    // The poller shouldn't send empty batches, but if it does: succeed with
    // zero counts and touch nothing — not even source resolution.
    if (events.length === 0) {
      res.json({ created: 0, skipped: 0 });
      return;
    }

    // `dataSources.name` carries no unique constraint, and feed resolution
    // keys on it (ADR 0005) — with two active rows sharing the name, picking
    // one arbitrarily would split the feed's signals across sourceIds and
    // defeat [sourceId, externalId] dedup. Fail loudly instead.
    const matches = await prisma.dataSources.findMany({
      where: { name: sourceName, isActive: true },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    if (matches.length > 1) {
      console.error(`[x-ingest] ambiguous source name: ${sourceName}`);
      res.status(500).json({ error: "Ingest failed" });
      return;
    }
    const source = matches[0];
    if (!source) {
      res.status(400).json({ error: "Unknown source" });
      return;
    }

    const { count: created } = await prisma.signals.createMany({
      data: events.map((event) => ({
        sourceId: source.id,
        externalId: `x:${event.id}`,
        rawData: event as Prisma.InputJsonValue,
        publishedAt: new Date(event.created_at),
        url: event.url,
        title: truncateTitle(event.text),
        description: event.text,
        // status intentionally omitted: defaults to NEW, the drain owns it.
      })),
      skipDuplicates: true,
    });

    res.json({ created, skipped: events.length - created });
  } catch (err) {
    console.error("[x-ingest] Failed:", err);
    res.status(500).json({ error: "Ingest failed" });
  }
});

// Malformed JSON never reaches the handler — body-parser throws before it.
// Catch it here so callers get a JSON error body, not Express's HTML page.
router.use(
  (
    err: Error & { type?: string; status?: number },
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = err.status ?? 400;
    if (status >= 500) {
      console.error("[x-ingest] Failed:", err);
      res.status(500).json({ error: "Ingest failed" });
      return;
    }
    res.status(status).json({
      error: err.type === "entity.too.large" ? "Payload too large" : "Invalid JSON body",
    });
  },
);

export { router as xIngestRouter };
