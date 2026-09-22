/**
 * Knowledge-base ingest surface.
 *
 * Two entry points:
 *   - Query `resolveKnowledgebaseLocation` — pcode-first / name-fallback
 *     lookup into `locations`. Kept out of the caller's client so the
 *     normalisation (case-insensitive name match, level scoping) lives
 *     in exactly one place.
 *   - Mutation `upsertKnowledgebaseChunks` — replace-all-for-report
 *     write path. Delete + insert run inside one interactive
 *     transaction so a mid-run failure can't leave torn state. Vector
 *     length is validated per row before the SQL cast.
 *
 * Both gates require the `admin` or `pipeline` role — the ingest is a
 * system-level job authenticating via a long-lived API key, not a
 * per-user action.
 *
 * All writes go through raw SQL because `embedding` (pgvector) and
 * `lexicalTsv` (tsvector, populated by trigger) are Prisma
 * `Unsupported` types the client can't serialise.
 */

import { createHash } from "node:crypto";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { GraphQLError } from "graphql";
import type { FileUpload } from "graphql-upload/processRequest.mjs";

import type { Context } from "../context.js";
import { requireContentReader, requireRole } from "../utils/auth-guard.js";
import {
  type IngestStatus,
  getRunStatus,
  launchRun,
} from "../utils/dagster-client.js";
import { syncEventCards } from "../services/event-card.js";
import {
  EMBEDDING_DIMENSIONS,
  embedQuery,
  loadEmbeddingConfig,
  vectorLiteral,
} from "../utils/embedding-client.js";
import { env } from "../utils/env.js";

// Reciprocal Rank Fusion constant. The k=60 default from the RRF
// paper (Cormack et al. 2009) tempers early-rank scores so a
// mid-ranked hit in one retriever isn't drowned out by a top hit
// in the other. Bumping k flattens the score curve (helps recall);
// lowering it sharpens it (helps precision on strong hits).
const RRF_K = 60;

// Per-retriever candidate cap before fusion. 50 is the sweet spot
// where dense recall for humanitarian text starts saturating; going
// higher blows fusion cost without lifting NDCG@10 in the ad-hoc
// benchmarks Anthropic published for Contextual Retrieval.
const CANDIDATES_PER_RETRIEVER = 50;

// ─── ADR-0006 tiered-merge knobs (v1: fixed constants; v2: evidence fns) ────
// TOPICAL mode only: an incident must clear this cosine-similarity floor to
// compete, so off-topic event cards don't claim a 50/50 rank slot on a query
// that isn't about them. (No floor in FRAME mode — a vague frame query can't
// clear it, and that's exactly the incidents the frame is asking for.)
const INCIDENT_SIM_FLOOR = 0.35;
// TOPICAL mode: a mild preference for the curated report tier, expressed as a
// rank OFFSET (not a score multiplier — RRF scores are near-flat across ranks,
// so a multiplier shoves an item ~10 ranks; an offset of 2 is the small,
// interpretable knob). An incident competes as if it were 2 ranks lower.
const INCIDENT_RANK_OFFSET = 2;
// FRAME mode: fraction of the result budget reserved for the incident band, so
// the fresh incident timeline is guaranteed to surface (capped so it can't
// crowd out the analysis). Rounded up, min 1 when any incidents exist.
const INCIDENT_QUOTA_FRACTION = 0.4;

type SearchTier = "report" | "incident";

/** SELECT projections that map each tier's columns onto the shared
 *  KnowledgebaseHit shape (+ a `tier` literal, and the incident-only ordering
 *  fields `_severity` / `_startedAt`). Keeps both retrievers returning one row
 *  type so the merge is uniform. */
const REPORT_SELECT = `
  "id",
  "report_id"     AS "reportId",
  "report_title"  AS "reportTitle",
  "source_url"    AS "sourceUrl",
  "published_at"  AS "publishedAt",
  "page_start"    AS "pageStart",
  "page_end"      AS "pageEnd",
  "chunk_text"    AS "chunkText",
  "location_ids"  AS "locationIds",
  "event_types"   AS "eventTypes",
  "need_sectors"  AS "needSectors",
  "figure_s3_key" AS "figureS3Key",
  "figure_kind"   AS "figureKind",
  'report'::text  AS "tier",
  NULL::int       AS "_severity",
  "time_range_start" AS "_startedAt"`;

const INCIDENT_SELECT = `
  "id",
  ('event:' || "event_id")     AS "reportId",
  "title"                      AS "reportTitle",
  COALESCE("source_url", '')   AS "sourceUrl",
  "started_at"                 AS "publishedAt",
  0                            AS "pageStart",
  0                            AS "pageEnd",
  "card_text"                  AS "chunkText",
  "location_ids"               AS "locationIds",
  "event_types"                AS "eventTypes",
  ARRAY[]::text[]              AS "needSectors",
  NULL::text                   AS "figureS3Key",
  NULL::text                   AS "figureKind",
  'incident'::text             AS "tier",
  "severity"                   AS "_severity",
  "started_at"                 AS "_startedAt"`;

// Dagster run tag keys — the mutation attaches these at launch time
// so the polling query can echo the document's identity back to the
// client without a client-side round-trip cache. Namespaced under
// `clear.` so they don't collide with Dagster's own tag conventions.
const DAGSTER_TAG_REPORT_ID = "clear.report_id";
const DAGSTER_TAG_REPORT_TITLE = "clear.report_title";
const DAGSTER_TAG_S3_KEY = "clear.s3_key";

// Dagster job name — must match the @job in
// dagster-quickstart/src/dagster_quickstart/defs/knowledgebase/manual_ingest.py.
const MANUAL_INGEST_JOB_NAME = "process_manual_document_job";

// S3 prefix under which uploaded PDFs land. Mirrors the prefix the
// Dagster manual flow already writes its debug artefacts to
// (reliefweb/kb/manual/…), keeping every "manual ingest" artefact
// under one namespace in the bucket.
const MANUAL_UPLOAD_S3_PREFIX = "reliefweb/manual-uploads";

interface KnowledgebaseIngestJob {
  runId: string;
  status: IngestStatus;
  reportId: string | null;
  reportTitle: string | null;
  s3Key: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

// Lazy S3 client — same auth pattern the /upload route uses. Kept
// module-local so the resolver file is self-contained; if a second
// resolver needs S3 later we should extract this into a shared util.
let _s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (_s3Client) return _s3Client;
  _s3Client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return _s3Client;
}

/** Read a `graphql-upload` stream into a Buffer. Kept small so the
 *  20 MB middleware ceiling caps memory use in one place. */
async function readUploadToBuffer(upload: FileUpload): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of upload.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

interface KnowledgebaseChunkInput {
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  chunkText: string;
  contextPrefix: string;
  embeddedText: string;
  embeddingProvider: string;
  embeddingModel: string;
  embedding: number[];
  locationIds: string[];
  locationPcodes: string[];
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
  eventTypes: string[];
  needSectors: string[];
  // Infographic capture: present only on figure-transcription chunks.
  figureS3Key?: string | null;
  figureKind?: string | null;
}

interface UpsertKnowledgebaseArgs {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  s3Key: string;
  publishedAt: Date;
  chunks: KnowledgebaseChunkInput[];
}


interface KnowledgebaseFilters {
  locationIds?: string[] | null;
  countryLocationId?: string | null;
  eventTypes?: string[] | null;
  needSectors?: string[] | null;
  timeRange?: { from?: Date | null; to?: Date | null } | null;
  currentEmbeddingModelOnly?: boolean | null;
}

interface KnowledgebaseHitRow {
  id: string;
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  publishedAt: Date | null;
  pageStart: number;
  pageEnd: number;
  chunkText: string;
  locationIds: string[];
  eventTypes: string[];
  needSectors: string[];
  figureS3Key: string | null;
  figureKind: string | null;
  tier: SearchTier;
  /** Incident-only ordering fields (null on report rows). */
  _severity: number | null;
  _startedAt: Date | null;
  /** Best dense cosine distance for this row (set by the dense retriever);
   *  `sim = 1 - _dist`. Absent on sparse-only or recency rows. */
  _dist?: number | null;
}

/**
 * Compose the parameterised WHERE clause shared by dense + sparse
 * queries. Emits `$N` placeholders and pushes matching values into
 * `params`; the caller appends its own retrieval-specific params
 * afterwards.
 *
 * Filter semantics:
 *   - locationIds / eventTypes / needSectors  — array overlap (any-of).
 *   - timeRange                                — chunk window intersects.
 *   - currentEmbeddingModelOnly (default true) — pins to the currently
 *     configured provider + model so cross-space vectors never mix.
 */
export function buildFilterClause(
  filters: KnowledgebaseFilters | null | undefined,
  params: unknown[],
  opts?: { hasNeedSectors?: boolean },
): string {
  // The incident tier (`events_index`) has no `need_sectors` column, so the
  // caller passes hasNeedSectors:false to skip that one condition (ADR-0006).
  const hasNeedSectors = opts?.hasNeedSectors ?? true;
  const conditions: string[] = [];

  const currentEmbeddingModelOnly = filters?.currentEmbeddingModelOnly ?? true;
  if (currentEmbeddingModelOnly) {
    const config = loadEmbeddingConfig();
    params.push(config.provider);
    conditions.push(`"embedding_provider" = $${params.length}`);
    params.push(config.model);
    conditions.push(`"embedding_model" = $${params.length}`);
  }

  if (filters?.locationIds && filters.locationIds.length > 0) {
    params.push(filters.locationIds);
    conditions.push(`"location_ids" && $${params.length}::text[]`);
  }
  // Country scope: keep chunks tagged with ANY location in the country's subtree
  // (the country itself or any descendant admin unit). Chunk `location_ids` are
  // resolved to leaf admin ids (e.g. Khartoum), never the A0 id, so a bare
  // `locationIds=[A0]` overlap would miss everything — we expand the A0 to its
  // subtree here via the locations tree's `ancestor_ids` (GIN-indexed). Chunks
  // with no resolved location are excluded, which is the intended country scoping
  // (used by the situation-analysis RAG so a country's sources never pull in
  // reports about another country).
  if (filters?.countryLocationId) {
    params.push(filters.countryLocationId);
    const p = params.length;
    conditions.push(
      `"location_ids" && ARRAY(SELECT "id" FROM "locations" ` +
        `WHERE "id" = $${p} OR "ancestor_ids" @> ARRAY[$${p}]::text[])`,
    );
  }
  if (filters?.eventTypes && filters.eventTypes.length > 0) {
    params.push(filters.eventTypes);
    conditions.push(`"event_types" && $${params.length}::text[]`);
  }
  if (hasNeedSectors && filters?.needSectors && filters.needSectors.length > 0) {
    params.push(filters.needSectors);
    conditions.push(`"need_sectors" && $${params.length}::text[]`);
  }
  if (filters?.timeRange?.from) {
    params.push(filters.timeRange.from);
    // Overlap semantics: keep the chunk if its END is on or after the
    // window START. Using end lets chunks that started earlier but
    // are still active during the window match.
    conditions.push(`("time_range_end" IS NULL OR "time_range_end" >= $${params.length})`);
  }
  if (filters?.timeRange?.to) {
    params.push(filters.timeRange.to);
    conditions.push(`("time_range_start" IS NULL OR "time_range_start" <= $${params.length})`);
  }

  return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
}


interface RankedHit {
  row: KnowledgebaseHitRow;
  rrf: number;
  /** Best dense cosine similarity (1 - min distance), or `null` for a row that
   *  surfaced ONLY via the sparse/lexical retriever (outside the dense candidate
   *  window). `null` means "no dense evidence" — NOT "zero similarity" — so the
   *  TOPICAL floor must treat it as lexically-relevant, not off-topic (E2). */
  sim: number | null;
}

// TOPICAL recency shaping (ADR-0006 §4, reviewer E7). A small additive bonus so
// fresher incidents edge out equally-ranked ones without overriding relevance:
// tuned to ~1–2 rank steps (a rank step of RRF is ~1/RRF_K² ≈ 2.7e-4).
const INCIDENT_RECENCY_HALF_LIFE_DAYS = 14;
const INCIDENT_RECENCY_BONUS = 5e-4;

/** Exponential recency in (0,1]: 1 for "now", halving every half-life. 0 when
 *  the incident has no onset date. */
function recencyScore(startedAt: Date | null | undefined): number {
  if (!startedAt) return 0;
  const ageDays = (Date.now() - new Date(startedAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, Math.max(0, ageDays) / INCIDENT_RECENCY_HALF_LIFE_DAYS);
}

type SearchHit = Omit<KnowledgebaseHitRow, "_severity" | "_startedAt" | "_dist"> & {
  score: number;
};

/** Strip the internal ordering fields and attach the merge score. */
function toHit(row: KnowledgebaseHitRow, score: number): SearchHit {
  const { _severity: _s, _startedAt: _st, _dist: _d, ...rest } = row;
  void _s; void _st; void _d;
  return { ...rest, score };
}

/** One tier's hybrid retrieval: dense (pgvector `<=>`) + sparse (tsvector),
 *  each capped at CANDIDATES_PER_RETRIEVER, fused with RRF. Each hit carries the
 *  fused `rrf` and `sim` (1 - best dense distance; 0 when it surfaced only via
 *  sparse). Per-tier — the caller merges the two tiers (ADR-0006). */
async function hybridRetrieveTier(
  prisma: Context["prisma"],
  table: string,
  select: string,
  vecLiteral: string,
  q: string,
  filters: KnowledgebaseFilters | null | undefined,
  hasNeedSectors: boolean,
): Promise<RankedHit[]> {
  const denseParams: unknown[] = [];
  const denseWhere = buildFilterClause(filters, denseParams, { hasNeedSectors });
  const vecPos = denseParams.length + 1;
  const denseSql = `
    SELECT ${select}, ("embedding" <=> $${vecPos}::vector(1024)) AS "_dist"
    FROM "${table}"
    ${denseWhere}
    ORDER BY "embedding" <=> $${vecPos}::vector(1024)
    LIMIT $${denseParams.length + 2}
  `;
  denseParams.push(vecLiteral, CANDIDATES_PER_RETRIEVER);

  const sparseParams: unknown[] = [];
  const sparseWhere = buildFilterClause(filters, sparseParams, { hasNeedSectors });
  const sparseSql = `
    SELECT ${select}
    FROM "${table}"
    ${sparseWhere ? `${sparseWhere} AND` : "WHERE"}
      "lexical_tsv" @@ plainto_tsquery('english', $${sparseParams.length + 1})
    ORDER BY ts_rank_cd(
      "lexical_tsv", plainto_tsquery('english', $${sparseParams.length + 2})
    ) DESC
    LIMIT $${sparseParams.length + 3}
  `;
  sparseParams.push(q, q, CANDIDATES_PER_RETRIEVER);

  const [denseRows, sparseRows] = await Promise.all([
    prisma.$queryRawUnsafe<KnowledgebaseHitRow[]>(denseSql, ...denseParams),
    q ? prisma.$queryRawUnsafe<KnowledgebaseHitRow[]>(sparseSql, ...sparseParams) : Promise.resolve([]),
  ]);

  const fused = new Map<string, RankedHit>();
  denseRows.forEach((row, i) => {
    const dist = typeof row._dist === "number" ? row._dist : 1;
    fused.set(row.id, { row, rrf: 1 / (RRF_K + i + 1), sim: 1 - dist });
  });
  sparseRows.forEach((row, i) => {
    const bonus = 1 / (RRF_K + i + 1);
    const existing = fused.get(row.id);
    if (existing) existing.rrf += bonus; // already has a dense sim; keep it
    else fused.set(row.id, { row, rrf: bonus, sim: null }); // sparse-only: no dense evidence
  });
  return [...fused.values()].sort((a, b) => b.rrf - a.rrf);
}

/** FRAME-mode non-semantic retrieval: filter by the frame, order by an explicit
 *  clause (recency + severity for incidents; recency for reports). No embedding
 *  — used where the query is frame-only and similarity is noise (ADR-0006 §4). */
async function recencyRetrieveTier(
  prisma: Context["prisma"],
  table: string,
  select: string,
  orderBy: string,
  filters: KnowledgebaseFilters | null | undefined,
  hasNeedSectors: boolean,
  limit: number,
): Promise<KnowledgebaseHitRow[]> {
  if (limit <= 0) return [];
  const params: unknown[] = [];
  const where = buildFilterClause(filters, params, { hasNeedSectors });
  const sql = `SELECT ${select} FROM "${table}" ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1}`;
  params.push(limit);
  return prisma.$queryRawUnsafe<KnowledgebaseHitRow[]>(sql, ...params);
}

/** TOPICAL merge (ADR-0006 §4): both tiers retrieved semantically; incidents
 *  gated by the similarity floor (dense-scored rows only — a sparse-only lexical
 *  match bypasses it, E2); incident order blends rank with recency (E7);
 *  interleaved with a small rank offset preferring the curated report tier. */
async function mergeTopical(
  prisma: Context["prisma"],
  q: string,
  vecLiteral: string,
  filters: KnowledgebaseFilters | null | undefined,
  limit: number,
  wantReport: boolean,
  wantIncident: boolean,
): Promise<SearchHit[]> {
  const [reportHits, incidentHits] = await Promise.all([
    wantReport ? hybridRetrieveTier(prisma, "knowledgebase", REPORT_SELECT, vecLiteral, q, filters, true) : Promise.resolve([]),
    wantIncident ? hybridRetrieveTier(prisma, "events_index", INCIDENT_SELECT, vecLiteral, q, filters, false) : Promise.resolve([]),
  ]);

  const scored: SearchHit[] = [];
  reportHits.forEach((h, i) => scored.push(toHit(h.row, 1 / (RRF_K + i + 1))));
  incidentHits
    // Gate only rows that HAVE dense evidence: a null sim means the row surfaced
    // only via BM25 (an exact keyword match outside the dense window) — keep it,
    // don't conflate "no dense hit" with "off-topic" (E2).
    .filter((h) => h.sim === null || h.sim >= INCIDENT_SIM_FLOOR)
    .forEach((h, i) => {
      // Base rank score (with the report rank-offset) + a small recency bonus so
      // fresher incidents shape the order without overriding relevance (E7).
      const base = 1 / (RRF_K + i + 1 + INCIDENT_RANK_OFFSET);
      scored.push(toHit(h.row, base + INCIDENT_RECENCY_BONUS * recencyScore(h.row._startedAt)));
    });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** FRAME merge (ADR-0006 §4): incident band by recency + severity (quota-
 *  bounded, no floor); report band by relevance (or recency if no query). Bands
 *  concatenated report-then-incident; `tier` is the real grouping key. */
async function mergeFrame(
  prisma: Context["prisma"],
  q: string,
  filters: KnowledgebaseFilters | null | undefined,
  limit: number,
  wantReport: boolean,
  wantIncident: boolean,
): Promise<SearchHit[]> {
  // Incident budget: the quota only *caps* incidents when they share the budget
  // with reports (so they can't swamp the analysis). When incidents own the whole
  // budget (report tier off) they fill it entirely — else an incident-only frame
  // query under-returns (reviewer E1). No Math.max(1,…) floor: at limit 1–2 with
  // both tiers, round(limit·0.4)=0 gives the slot to the report/analysis rather
  // than starving it (reviewer E9).
  const incidentQuota = !wantIncident
    ? 0
    : (wantReport ? Math.round(limit * INCIDENT_QUOTA_FRACTION) : limit);
  const incidentRows = await recencyRetrieveTier(
    prisma, "events_index", INCIDENT_SELECT,
    `"started_at" DESC NULLS LAST, "severity" DESC NULLS LAST`,
    filters, false, incidentQuota,
  );
  const reportBudget = limit - incidentRows.length;

  let reportRows: KnowledgebaseHitRow[] = [];
  if (wantReport && reportBudget > 0) {
    if (q !== "") {
      const vec = vectorLiteral(await embedQuery(q));
      const hits = await hybridRetrieveTier(prisma, "knowledgebase", REPORT_SELECT, vec, q, filters, true);
      reportRows = hits.slice(0, reportBudget).map((h) => h.row);
    } else {
      reportRows = await recencyRetrieveTier(
        prisma, "knowledgebase", REPORT_SELECT,
        `"published_at" DESC NULLS LAST`, filters, true, reportBudget,
      );
    }
  }

  // Two bands, reports then incidents; synthetic descending scores keep the
  // flat list ordered while the `tier` field carries the band identity.
  const out: SearchHit[] = [];
  let rank = 0;
  for (const r of reportRows) out.push(toHit(r, 1 / (RRF_K + ++rank)));
  for (const r of incidentRows) out.push(toHit(r, 1 / (RRF_K + ++rank)));
  return out.slice(0, limit);
}

export const knowledgebaseResolvers = {
  Query: {
    resolveKnowledgebaseLocation: async (
      _parent: unknown,
      args: { pcode?: string | null; name?: string | null; adminLevel?: number | null },
      context: Context,
    ): Promise<string | null> => {
      requireRole(context, ["admin", "pipeline"]);

      const pcode = args.pcode?.trim();
      const name = args.name?.trim();
      if (!pcode && !name) return null;

      // Pcode is the strong identifier. Try it first; if it matches
      // anything, that wins over any name-based match.
      if (pcode) {
        const rows = await context.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "locations"
          WHERE "p_code" = ${pcode}
          LIMIT 1
        `;
        if (rows.length > 0) return rows[0]!.id;
      }

      if (!name) return null;

      // Case-insensitive name match. We cap at level 3 because L4 (point)
      // rows carry non-place labels (signal titles, "TEST PT — …") that we
      // never want the LLM to land on. When `adminLevel` is given, use only
      // that level.
      if (args.adminLevel != null) {
        const rows = await context.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "locations"
          WHERE lower(name) = lower(${name})
            AND level = ${args.adminLevel}
          LIMIT 1
        `;
        return rows[0]?.id ?? null;
      }
      // No level hint: a name that exists at more than one admin level
      // (e.g. "Kassala" as both a state and a locality) is AMBIGUOUS. We
      // used to prefer the deepest match, which silently bucketed a
      // state-level figure to the same-named locality — the exact
      // wrong-bucket the datapoint Figure-Scope work exists to prevent.
      // Return null on ambiguity so the caller treats the figure as
      // unscoped (the established fail-safe for an unresolved name) rather
      // than trusting a coin-flip. A name unique to one level resolves as
      // before.
      const rows = await context.prisma.$queryRaw<Array<{ id: string; level: number }>>`
        SELECT id, level FROM "locations"
        WHERE lower(name) = lower(${name})
          AND level BETWEEN 0 AND 3
        ORDER BY level DESC
      `;
      const distinctLevels = new Set(rows.map((r) => r.level));
      if (distinctLevels.size > 1) return null; // ambiguous across levels
      return rows[0]?.id ?? null;
    },

    searchKnowledgebase: async (
      _parent: unknown,
      args: {
        query: string;
        filters?: KnowledgebaseFilters | null;
        limit?: number | null;
        tiers?: string[] | null;
        mode?: "AUTO" | "FRAME" | "TOPICAL" | null;
      },
      context: Context,
    ): Promise<SearchHit[]> => {
      // Any authenticated content reader (admin/analyst/viewer); the KB is
      // derived from public ReliefWeb reports so the read gate is loose.
      requireContentReader(context);

      const q = args.query.trim();
      // Bound the fan-out so a runaway caller can't request 10k rows.
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

      // Which tiers to search (ADR-0006). Default: both, so the KB is always
      // fresh. Unknown tier names are ignored.
      const tiers = new Set(args.tiers?.length ? args.tiers : ["report", "incident"]);
      const wantReport = tiers.has("report");
      const wantIncident = tiers.has("incident");

      // Resolve the merge mode. AUTO → FRAME when the query is effectively
      // empty/frame-only, else TOPICAL.
      const mode = (args.mode ?? "AUTO") === "AUTO"
        ? (q === "" ? "FRAME" : "TOPICAL")
        : args.mode;

      // An empty query is only meaningful in FRAME mode with an actual frame
      // (location/time/type) to scope + order by — otherwise there's nothing
      // to retrieve. TOPICAL needs a real query for its semantic step.
      const hasFrame = !!(
        args.filters?.locationIds?.length
        || args.filters?.countryLocationId
        || args.filters?.timeRange?.from
        || args.filters?.timeRange?.to
        || args.filters?.eventTypes?.length
      );
      if (q === "" && !(mode === "FRAME" && hasFrame)) {
        throw new GraphQLError(
          "searchKnowledgebase: query must not be empty (except in FRAME mode with a location/time/type frame)",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      if (mode === "FRAME") {
        return mergeFrame(context.prisma, q, args.filters, limit, wantReport, wantIncident);
      }
      const vecLiteral = vectorLiteral(await embedQuery(q));
      return mergeTopical(context.prisma, q, vecLiteral, args.filters, limit, wantReport, wantIncident);
    },

    knowledgebaseIngestJob: async (
      _parent: unknown,
      args: { runId: string },
      context: Context,
    ): Promise<KnowledgebaseIngestJob | null> => {
      requireContentReader(context);
      const status = await getRunStatus(args.runId);
      if (!status) return null;
      return {
        runId: status.runId,
        status: status.status,
        reportId: status.tags[DAGSTER_TAG_REPORT_ID] ?? null,
        reportTitle: status.tags[DAGSTER_TAG_REPORT_TITLE] ?? null,
        s3Key: status.tags[DAGSTER_TAG_S3_KEY] ?? null,
        startedAt: status.startTime,
        endedAt: status.endTime,
      };
    },
  },

  Mutation: {
    syncEventCards: async (
      _parent: unknown,
      args: { eventIds: string[] },
      context: Context,
    ): Promise<{ synced: number; skipped: number }> => {
      requireRole(context, ["admin", "pipeline"]);
      if (!args.eventIds || args.eventIds.length === 0) {
        throw new GraphQLError("syncEventCards: eventIds must be non-empty", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      return syncEventCards(context.prisma, args.eventIds);
    },

    upsertKnowledgebaseChunks: async (
      _parent: unknown,
      args: UpsertKnowledgebaseArgs,
      context: Context,
    ): Promise<{ reportId: string; chunksDeleted: number; chunksInserted: number }> => {
      requireRole(context, ["admin", "pipeline"]);

      if (!args.chunks || args.chunks.length === 0) {
        throw new GraphQLError("upsertKnowledgebaseChunks: chunks must be non-empty", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Validate every embedding length before touching the DB. A single
      // wrong-length vector rejected at the pgvector `::vector(1024)`
      // cast rolls the whole transaction back; catching it up front
      // gives the caller a clearer error and skips a doomed round-trip.
      for (const chunk of args.chunks) {
        if (chunk.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new GraphQLError(
            `Chunk ${chunk.chunkIndex} has embedding length ${chunk.embedding.length}, ` +
              `expected ${EMBEDDING_DIMENSIONS}`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      }

      return context.prisma.$transaction(async (tx) => {
        const deleteResult = await tx.$executeRawUnsafe(
          `DELETE FROM "knowledgebase" WHERE "report_id" = $1`,
          args.reportId,
        );

        // Insert all chunks in ONE multi-row statement rather than N serial
        // round-trips. A report with hundreds of chunks otherwise holds its
        // pooled connection across the whole DELETE + N INSERTs (up to the
        // 60s transaction timeout); batching returns the connection to the
        // pool far sooner, which is what keeps a concurrent pipeline run from
        // starving the pool. 22 params/row × KB_MAX_CHUNKS_PER_REPORT stays
        // well under Postgres's 65535-parameter cap.
        const rows: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const chunk of args.chunks) {
          rows.push(
            `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ` +
              `$${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ` +
              `$${p++}, $${p++}, $${p++}::vector(1024), $${p++}::text[], $${p++}::text[], ` +
              `$${p++}, $${p++}, $${p++}::text[], $${p++}::text[], $${p++}, $${p++})`,
          );
          params.push(
            args.reportId,
            args.reportTitle,
            args.sourceUrl,
            args.s3Key,
            args.publishedAt,
            chunk.chunkIndex,
            chunk.pageStart,
            chunk.pageEnd,
            chunk.chunkText,
            chunk.contextPrefix,
            chunk.embeddedText,
            chunk.embeddingProvider,
            chunk.embeddingModel,
            vectorLiteral(chunk.embedding),
            chunk.locationIds,
            chunk.locationPcodes,
            chunk.timeRangeStart,
            chunk.timeRangeEnd,
            chunk.eventTypes,
            chunk.needSectors,
            chunk.figureS3Key ?? null,
            chunk.figureKind ?? null,
          );
        }

        await tx.$executeRawUnsafe(
          `
            INSERT INTO "knowledgebase" (
              "id", "report_id", "report_title", "source_url", "s3_key",
              "published_at",
              "chunk_index", "page_start", "page_end",
              "chunk_text", "context_prefix", "embedded_text",
              "embedding_provider", "embedding_model", "embedding",
              "location_ids", "location_pcodes",
              "time_range_start", "time_range_end",
              "event_types", "need_sectors",
              "figure_s3_key", "figure_kind"
            ) VALUES ${rows.join(", ")}
          `,
          ...params,
        );

        return {
          reportId: args.reportId,
          chunksDeleted: Number(deleteResult),
          chunksInserted: args.chunks.length,
        };
      });
    },

    uploadKnowledgebaseDocument: async (
      _parent: unknown,
      args: {
        file: Promise<FileUpload>;
        title: string;
        sourceUrl?: string | null;
        publishedAt: Date;
      },
      context: Context,
    ): Promise<KnowledgebaseIngestJob> => {
      // Restricted to admin/analyst — every accepted upload spends
      // LLM + embedding credits on the enrich chain. Viewers may
      // trigger costly re-runs otherwise.
      requireRole(context, ["admin", "analyst"]);

      const upload = await args.file;
      const filename = upload.filename ?? "unnamed";
      const mimetype = upload.mimetype ?? "";

      // POC accepts PDF only. Extending to DOCX/TXT means adding a
      // matching extraction path on the Dagster side (python-docx,
      // plain read) — the mimetype gate here is what keeps
      // unsupported types from spending Dagster time.
      const isPdf =
        mimetype === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        throw new GraphQLError(
          `uploadKnowledgebaseDocument: only PDF files are supported (got mimetype=${mimetype}, filename=${filename})`,
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      const buffer = await readUploadToBuffer(upload);
      if (buffer.length === 0) {
        throw new GraphQLError("uploadKnowledgebaseDocument: uploaded file is empty", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }

      // Content-addressed report_id. Uploading the same bytes twice
      // reuses the same report_id → the Dagster job's delete-then-
      // insert path replaces the previous version in place. To force
      // a fresh row on identical content, prepend a version suffix
      // to the filename or supply a custom report_id via a scripted
      // launchRun (not via this mutation).
      const sha = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
      const reportId = `manual:${sha}`;
      const s3Key = `${MANUAL_UPLOAD_S3_PREFIX}/${reportId}.pdf`;

      const s3 = getS3();
      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: s3Key,
          Body: buffer,
          ContentType: "application/pdf",
        }),
      );

      // When DAGSTER_URL is unset (dev-only offline case), stage the
      // upload and return a synthetic UNKNOWN-status job. The client
      // still gets the report_id / s3_key so it can display the
      // upload, and a follow-up manual launchRun (e.g. via Dagster
      // UI) can process the same S3 key.
      if (!env.DAGSTER_URL) {
        return {
          runId: "",
          status: "UNKNOWN",
          reportId,
          reportTitle: args.title,
          s3Key,
          startedAt: null,
          endedAt: null,
        };
      }

      const publishedAtIso = args.publishedAt.toISOString();
      const runConfig = {
        ops: {
          process_manual_document: {
            config: {
              s3_key: s3Key,
              report_id: reportId,
              report_title: args.title,
              source_url: args.sourceUrl ?? "",
              published_at: publishedAtIso,
            },
          },
        },
      };
      const tags: Record<string, string> = {
        [DAGSTER_TAG_REPORT_ID]: reportId,
        [DAGSTER_TAG_REPORT_TITLE]: args.title,
        [DAGSTER_TAG_S3_KEY]: s3Key,
      };

      try {
        const { runId } = await launchRun(MANUAL_INGEST_JOB_NAME, runConfig, tags);
        return {
          runId,
          // Dagster's initial status is QUEUED — the poll query will
          // transition it to STARTED / SUCCESS / FAILURE as the run
          // progresses.
          status: "QUEUED",
          reportId,
          reportTitle: args.title,
          s3Key,
          startedAt: null,
          endedAt: null,
        };
      } catch (err) {
        // Surface the Dagster-side reason unchanged so the client
        // sees, e.g., "config validation failed: … field X missing" —
        // more actionable than a generic 500.
        throw new GraphQLError(
          `Failed to launch Dagster run: ${err instanceof Error ? err.message : String(err)}`,
          { extensions: { code: "INTERNAL_SERVER_ERROR" } },
        );
      }
    },
  },
};
