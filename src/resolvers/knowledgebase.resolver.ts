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
import { requireContentReader, requireRole, requireTeamContentWriter } from "../utils/auth-guard.js";
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
import { interpretReportQuestion } from "../utils/report-query-nl.js";
import {
  chunkIsAllNrcIrrelevant,
  nrcIrrelevantGlideCodes,
  nrcIrrelevantLevel2,
} from "../utils/nrc-relevance.js";

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

// searchReports (Cap 3) groups chunk hits into distinct reports, so it needs a
// wider candidate window than chunk search — enough nearest chunks that the
// distinct-report set under them is well past `limit`. 300 covers ~15+ reports
// even when one report dominates the nearest neighbours.
const REPORT_CANDIDATE_CHUNKS = 300;

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
// A firmer rank OFFSET (same idiom as INCIDENT_RANK_OFFSET) applied to a chunk
// whose event types are ENTIRELY out-of-interest to NRC (disaster_types where
// nrc_relevant is false for every one of the chunk's types). It demotes — never
// excludes — such content, so it still surfaces, just ranked well below relevant
// hits. Tunable. NB: KB tags are level_2 slugs, so in practice this only catches
// the fully out-of-interest groups (e.g. "fire", natural-hazard "other").
const NRC_IRRELEVANT_RANK_OFFSET = 15;
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
// Attribution tags for a team-scoped upload (Cap 1): who uploaded and on behalf
// of which team. Recorded on the ingest run so the provenance is auditable
// without a schema change on `knowledgebase`.
const DAGSTER_TAG_TEAM_ID = "clear.team_id";
const DAGSTER_TAG_UPLOADED_BY = "clear.uploaded_by_user_id";

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

/** Raw SQL row for `searchReports` — aliased to camelCase in the query. `score`
 *  is null for the recency listing; `matchedChunks` is a bigint from COUNT in
 *  the topical path (converted to number at the boundary). */
interface ReportRow {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  s3Key: string;
  publishedAt: Date;
  snippet: string;
  score: number | null;
  matchedChunks: number | bigint;
}

/** How `searchReportsNaturalLanguage` parsed the question into structured
 *  arguments — surfaced so a caller can confirm or override the interpretation. */
interface InterpretedReportQuery {
  topicalQuery: string;
  source: string | null;
  publishedFrom: Date | null;
  publishedTo: Date | null;
  countryLocationId: string | null;
  countryName: string | null;
}

/** `searchReports` result (Cap 3) — one report with a presigned download URL. */
interface ReportHit {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  publishedAt: Date;
  s3Key: string;
  downloadUrl: string;
  score: number | null;
  matchedChunks: number;
  snippet: string;
}

/** One figure that belongs in the KB but hasn't been merged yet — the work item
 *  the figure→KB sync (clear-pipeline) consumes. Report-level fields come from
 *  the report's existing `knowledgebase` rows; the figure fields from
 *  `report_figures`. Matches the `ReportFigureForMerge` GraphQL type one-to-one,
 *  so the raw-SQL row is returned unchanged. */
interface ReportFigureForMerge {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  reportS3Key: string;
  publishedAt: Date;
  /** Team attribution carried from the report's KB rows so the figure→KB sync
   *  stamps merged figures with the same team as the report's text (null for the
   *  shared ReliefWeb corpus). */
  teamId: string | null;
  uploadedByUserId: string | null;
  figureS3Key: string;
  figureKind: string;
  pageNumber: number;
  title: string | null;
  transcription: unknown;
  locationIds: string[];
  locationPcodes: string[];
  eventTypes: string[];
  needSectors: string[];
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
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
  /** When true, delete only this report's FIGURE chunks (figure_s3_key IS NOT
   *  NULL) before inserting, leaving its text chunks intact. Lets the figure→KB
   *  sync (clear-pipeline) attach figures to a report whose text was ingested in
   *  an earlier run, without the normal delete-all wiping that text. Default
   *  false = the original replace-all-for-report behaviour. */
  figuresOnly?: boolean | null;
  /** Team-scoped upload attribution (Cap 1). Stored on every chunk of the
   *  report so a team-scoped read can filter by it. Null for the weekly
   *  ReliefWeb ingest (not team-owned). */
  teamId?: string | null;
  uploadedByUserId?: string | null;
}


interface KnowledgebaseFilters {
  locationIds?: string[] | null;
  countryLocationId?: string | null;
  eventTypes?: string[] | null;
  needSectors?: string[] | null;
  timeRange?: { from?: Date | null; to?: Date | null } | null;
  currentEmbeddingModelOnly?: boolean | null;
  /** When true, restrict retrieval to figure-transcription chunks
   *  (`figure_s3_key IS NOT NULL`) — the infographic search (Cap 2). Only
   *  meaningful on the report tier; the incident tier has no figure column so
   *  the condition is skipped there. */
  figuresOnly?: boolean | null;
  /** Restrict to rows attributed to this team (Cap 1 team-scoped reads). Matches
   *  `team_id`, which is set only on team-uploaded documents — so this filter
   *  returns ONLY that team's uploads, never the shared ReliefWeb corpus. Report
   *  tier only (the incident tier has no team column). */
  teamId?: string | null;
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
  opts?: { hasNeedSectors?: boolean; hasFigureColumn?: boolean; hasTeamColumn?: boolean },
): string {
  // The incident tier (`events_index`) has no `need_sectors` column, so the
  // caller passes hasNeedSectors:false to skip that one condition (ADR-0006).
  const hasNeedSectors = opts?.hasNeedSectors ?? true;
  // Same story for `figure_s3_key` and `team_id`: both exist only on the report
  // tier (`knowledgebase`), so their conditions are skipped on tiers without
  // the column.
  const hasFigureColumn = opts?.hasFigureColumn ?? true;
  const hasTeamColumn = opts?.hasTeamColumn ?? true;
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
  // Infographic search (Cap 2): keep only figure-transcription chunks. Static
  // condition (no param). Skipped on tiers without the column.
  if (hasFigureColumn && filters?.figuresOnly) {
    conditions.push(`"figure_s3_key" IS NOT NULL`);
  }
  // Team-scoped reads (Cap 1): only this team's uploads.
  if (hasTeamColumn && filters?.teamId) {
    params.push(filters.teamId);
    conditions.push(`"team_id" = $${params.length}`);
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

/** Extra rank offset for a chunk whose event types are ALL out-of-interest to
 *  NRC — demotes it a few ranks without excluding it. 0 otherwise. `irrelevant`
 *  is the set that matches the chunk's event-type vocabulary: level_2 labels for
 *  report chunks, glide codes for incident cards. */
function nrcDemotion(eventTypes: string[], irrelevant: Set<string>): number {
  return chunkIsAllNrcIrrelevant(eventTypes, irrelevant) ? NRC_IRRELEVANT_RANK_OFFSET : 0;
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
  // Only the report tier (`knowledgebase`) carries `figure_s3_key`; gate the
  // figuresOnly restriction on the table so it never hits the incident tier.
  const hasReportTierCols = table === "knowledgebase";
  const denseParams: unknown[] = [];
  const denseWhere = buildFilterClause(filters, denseParams, {
    hasNeedSectors,
    hasFigureColumn: hasReportTierCols,
    hasTeamColumn: hasReportTierCols,
  });
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
  const sparseWhere = buildFilterClause(filters, sparseParams, {
    hasNeedSectors,
    hasFigureColumn: hasReportTierCols,
    hasTeamColumn: hasReportTierCols,
  });
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
  const hasReportTierCols = table === "knowledgebase";
  const where = buildFilterClause(filters, params, {
    hasNeedSectors,
    hasFigureColumn: hasReportTierCols,
    hasTeamColumn: hasReportTierCols,
  });
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
  irrelevantLevel2: Set<string>,
  irrelevantGlide: Set<string>,
): Promise<SearchHit[]> {
  const [reportHits, incidentHits] = await Promise.all([
    wantReport ? hybridRetrieveTier(prisma, "knowledgebase", REPORT_SELECT, vecLiteral, q, filters, true) : Promise.resolve([]),
    wantIncident ? hybridRetrieveTier(prisma, "events_index", INCIDENT_SELECT, vecLiteral, q, filters, false) : Promise.resolve([]),
  ]);

  const scored: SearchHit[] = [];
  // Report chunks tag level_2 labels; incident cards tag glide codes — demote
  // each against the set that matches its vocabulary.
  reportHits.forEach((h, i) =>
    scored.push(toHit(h.row, 1 / (RRF_K + i + 1 + nrcDemotion(h.row.eventTypes, irrelevantLevel2)))),
  );
  incidentHits
    // Gate only rows that HAVE dense evidence: a null sim means the row surfaced
    // only via BM25 (an exact keyword match outside the dense window) — keep it,
    // don't conflate "no dense hit" with "off-topic" (E2).
    .filter((h) => h.sim === null || h.sim >= INCIDENT_SIM_FLOOR)
    .forEach((h, i) => {
      // Base rank score (with the report rank-offset) + a small recency bonus so
      // fresher incidents shape the order without overriding relevance (E7).
      const base = 1 / (RRF_K + i + 1 + INCIDENT_RANK_OFFSET + nrcDemotion(h.row.eventTypes, irrelevantGlide));
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
  irrelevantLevel2: Set<string>,
  irrelevantGlide: Set<string>,
): Promise<SearchHit[]> {
  // Within a band, sink chunks whose event types are entirely out-of-interest to
  // NRC (stable sort preserves the in-band order among equally-relevant rows).
  // FRAME order is band position, not score, AND the demotion must be able to
  // change *which* rows survive the budget — so we over-fetch each band's
  // candidates, demote, THEN slice to budget. Slicing before demoting (as an
  // earlier version did) locks an irrelevant top hit in at small limits and the
  // demotion becomes a no-op. Reports tag level_2 labels, incidents glide codes.
  const demoteLast = (rows: KnowledgebaseHitRow[], irrelevant: Set<string>) =>
    [...rows].sort(
      (a, b) => nrcDemotion(a.eventTypes, irrelevant) - nrcDemotion(b.eventTypes, irrelevant),
    );

  // Incident budget: the quota only *caps* incidents when they share the budget
  // with reports (so they can't swamp the analysis). When incidents own the whole
  // budget (report tier off) they fill it entirely — else an incident-only frame
  // query under-returns (reviewer E1). No Math.max(1,…) floor: at limit 1–2 with
  // both tiers, round(limit·0.4)=0 gives the slot to the report/analysis rather
  // than starving it (reviewer E9).
  const incidentQuota = !wantIncident
    ? 0
    : (wantReport ? Math.round(limit * INCIDENT_QUOTA_FRACTION) : limit);
  // Over-fetch (up to CANDIDATES_PER_RETRIEVER) so demotion has relevant rows to
  // promote into the quota, then demote and cut.
  const incidentCandidates = incidentQuota > 0
    ? await recencyRetrieveTier(
        prisma, "events_index", INCIDENT_SELECT,
        `"started_at" DESC NULLS LAST, "severity" DESC NULLS LAST`,
        filters, false, Math.max(incidentQuota, CANDIDATES_PER_RETRIEVER),
      )
    : [];
  const incidentRows = demoteLast(incidentCandidates, irrelevantGlide).slice(0, incidentQuota);
  const reportBudget = limit - incidentRows.length;

  let reportRows: KnowledgebaseHitRow[] = [];
  if (wantReport && reportBudget > 0) {
    if (q !== "") {
      const vec = vectorLiteral(await embedQuery(q));
      const hits = await hybridRetrieveTier(prisma, "knowledgebase", REPORT_SELECT, vec, q, filters, true);
      reportRows = demoteLast(hits.map((h) => h.row), irrelevantLevel2).slice(0, reportBudget);
    } else {
      const candidates = await recencyRetrieveTier(
        prisma, "knowledgebase", REPORT_SELECT,
        `"published_at" DESC NULLS LAST`, filters, true,
        Math.max(reportBudget, CANDIDATES_PER_RETRIEVER),
      );
      reportRows = demoteLast(candidates, irrelevantLevel2).slice(0, reportBudget);
    }
  }

  // Two bands, reports then incidents; synthetic descending scores keep the flat
  // list ordered while the `tier` field carries the band identity. Rows are
  // already demoted + budget-cut, so just stamp the scores in band order.
  const out: SearchHit[] = [];
  let rank = 0;
  for (const r of reportRows) out.push(toHit(r, 1 / (RRF_K + ++rank)));
  for (const r of incidentRows) out.push(toHit(r, 1 / (RRF_K + ++rank)));
  return out.slice(0, limit);
}

/** Core of `searchReports` (Cap 3), factored out so the natural-language
 *  entry point (`searchReportsNaturalLanguage`) can reuse the exact same
 *  retrieval after parsing a question into structured arguments. Assumes the
 *  caller has already gated access. `limit` is pre-clamped. */
async function executeReportSearch(
  prisma: Context["prisma"],
  args: {
    query?: string | null;
    filters?: KnowledgebaseFilters | null;
    publishedRange?: { from?: Date | null; to?: Date | null } | null;
    source?: string | null;
    limit: number;
  },
): Promise<ReportHit[]> {
  const q = (args.query ?? "").trim();
  const limit = args.limit;

  // Shared filters (location / event / sector / time / embedding-model pin),
  // then the report-level extras (publication date window + source match).
  const params: unknown[] = [];
  let where = buildFilterClause(args.filters, params, {
    hasNeedSectors: true,
    hasFigureColumn: true,
    hasTeamColumn: true,
  });
  const extra: string[] = [];
  if (args.publishedRange?.from) {
    params.push(args.publishedRange.from);
    extra.push(`"published_at" >= $${params.length}`);
  }
  if (args.publishedRange?.to) {
    params.push(args.publishedRange.to);
    extra.push(`"published_at" <= $${params.length}`);
  }
  const source = args.source?.trim();
  if (source) {
    params.push(`%${source}%`);
    const p = params.length;
    extra.push(`("report_title" ILIKE $${p} OR "source_url" ILIKE $${p})`);
  }
  if (extra.length > 0) {
    where = where ? `${where} AND ${extra.join(" AND ")}` : `WHERE ${extra.join(" AND ")}`;
  }

  let rows: ReportRow[];
  if (q === "") {
    // Listing mode: distinct reports by filter/date, newest first. DISTINCT ON
    // needs report_id leading in ORDER BY, so pick the head chunk (lowest
    // chunk_index) as the snippet, then reorder the distinct set by recency.
    params.push(limit);
    const sql = `
      SELECT "report_id" AS "reportId", "report_title" AS "reportTitle",
             "source_url" AS "sourceUrl", "s3_key" AS "s3Key",
             "published_at" AS "publishedAt", "chunk_text" AS "snippet",
             NULL::float8 AS "score", 1::int AS "matchedChunks"
      FROM (
        SELECT DISTINCT ON ("report_id")
          "report_id", "report_title", "source_url", "s3_key",
          "published_at", "chunk_text"
        FROM "knowledgebase"
        ${where}
        ORDER BY "report_id", "chunk_index" ASC
      ) t
      ORDER BY "published_at" DESC
      LIMIT $${params.length}
    `;
    rows = await prisma.$queryRawUnsafe<ReportRow[]>(sql, ...params);
  } else {
    // Topical mode: nearest report chunks → best (closest) chunk per report,
    // ordered by that best similarity. matchedChunks counts how many of the
    // report's chunks fell inside the candidate window (relevance breadth).
    const vec = vectorLiteral(await embedQuery(q));
    params.push(vec);
    const vecPos = params.length;
    params.push(REPORT_CANDIDATE_CHUNKS);
    const candPos = params.length;
    params.push(limit);
    const limitPos = params.length;
    const sql = `
      WITH scoped AS (
        SELECT "report_id", "report_title", "source_url", "s3_key",
               "published_at", "chunk_text",
               ("embedding" <=> $${vecPos}::vector(1024)) AS dist
        FROM "knowledgebase"
        ${where}
        ORDER BY "embedding" <=> $${vecPos}::vector(1024)
        LIMIT $${candPos}
      ),
      counted AS (
        SELECT *, COUNT(*) OVER (PARTITION BY "report_id") AS matched_chunks
        FROM scoped
      ),
      best AS (
        SELECT DISTINCT ON ("report_id")
          "report_id" AS "reportId", "report_title" AS "reportTitle",
          "source_url" AS "sourceUrl", "s3_key" AS "s3Key",
          "published_at" AS "publishedAt", "chunk_text" AS "snippet",
          dist, matched_chunks
        FROM counted
        ORDER BY "report_id", dist ASC
      )
      SELECT "reportId", "reportTitle", "sourceUrl", "s3Key", "publishedAt",
             "snippet",
             (1 - dist)::float8 AS "score",
             matched_chunks::int AS "matchedChunks"
      FROM best
      ORDER BY dist ASC
      LIMIT $${limitPos}
    `;
    rows = await prisma.$queryRawUnsafe<ReportRow[]>(sql, ...params);
  }

  if (rows.length === 0) return [];

  // Presign all PDF keys in one batch so the download link is ready on the hit
  // without a follow-up call.
  const { getPresignedUrls } = await import("../services/s3.js");
  const downloadUrls = await getPresignedUrls(rows.map((r) => r.s3Key));
  return rows.map((r, i) => ({
    reportId: r.reportId,
    reportTitle: r.reportTitle,
    sourceUrl: r.sourceUrl,
    publishedAt: r.publishedAt,
    s3Key: r.s3Key,
    downloadUrl: downloadUrls[i]!,
    score: r.score,
    matchedChunks: Number(r.matchedChunks),
    snippet: r.snippet,
  }));
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
        includeFigures?: boolean | null;
        figureLimit?: number | null;
      },
      context: Context,
    ): Promise<SearchHit[]> => {
      // Any authenticated content reader (admin/member); the KB is
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

      // Out-of-interest NRC signals for the merge demotion, computed once per
      // query from disaster_types (tiny, static table). Two vocabularies: report
      // chunks tag level_2 labels; incident cards tag glide codes.
      const [irrelevantLevel2, irrelevantGlide] = await Promise.all([
        nrcIrrelevantLevel2(context.prisma),
        nrcIrrelevantGlideCodes(context.prisma),
      ]);

      // TOPICAL needs the query embedding; FRAME doesn't. Compute it once so
      // the optional figures band below can reuse it.
      const vecLiteral = mode === "FRAME" ? "" : vectorLiteral(await embedQuery(q));
      const baseHits = mode === "FRAME"
        ? await mergeFrame(context.prisma, q, args.filters, limit, wantReport, wantIncident, irrelevantLevel2, irrelevantGlide)
        : await mergeTopical(context.prisma, q, vecLiteral, args.filters, limit, wantReport, wantIncident, irrelevantLevel2, irrelevantGlide);

      // `includeFigures`: append a guaranteed band of the most relevant FIGURE
      // hits after the RAG results, so a chatbot/answer consumer reliably gets
      // supporting infographics even when text chunks fill the main `limit`.
      // (Figures can already interleave into the main results on their own
      // relevance; this guarantees a few regardless.) Each figure hit carries
      // `figureS3Key`/`figureImageUrl`, so the caller splits the band off by
      // `figureS3Key != null`. No-op when the search is already figures-only, or
      // when the report tier isn't being searched (figures live only there).
      if (!args.includeFigures || args.filters?.figuresOnly || !wantReport) {
        return baseHits;
      }
      const figureLimit = Math.min(Math.max(args.figureLimit ?? 6, 1), 20);
      const figureFilters: KnowledgebaseFilters = { ...(args.filters ?? {}), figuresOnly: true };
      let figureRows: KnowledgebaseHitRow[];
      if (mode === "FRAME") {
        figureRows = await recencyRetrieveTier(
          context.prisma, "knowledgebase", REPORT_SELECT,
          `"published_at" DESC NULLS LAST`, figureFilters, true, figureLimit,
        );
      } else {
        const ranked = await hybridRetrieveTier(
          context.prisma, "knowledgebase", REPORT_SELECT, vecLiteral, q, figureFilters, true,
        );
        figureRows = ranked.slice(0, figureLimit).map((r) => r.row);
      }
      // Dedup against figures that already surfaced in the main band, and stamp
      // synthetic scores strictly below the lowest RAG score so a consumer that
      // re-sorts by score keeps text first, figures second (in their own order).
      const seen = new Set(baseHits.map((h) => h.id));
      const floor = baseHits.length ? Math.min(...baseHits.map((h) => h.score)) : 1;
      const figureHits = figureRows
        .filter((r) => !seen.has(r.id))
        .map((r, i) => toHit(r, floor * Math.pow(0.9, i + 1)));
      return [...baseHits, ...figureHits];
    },

    searchReports: async (
      _parent: unknown,
      args: {
        query?: string | null;
        filters?: KnowledgebaseFilters | null;
        publishedRange?: { from?: Date | null; to?: Date | null } | null;
        source?: string | null;
        limit?: number | null;
      },
      context: Context,
    ): Promise<ReportHit[]> => {
      // Same read gate as searchKnowledgebase — the KB is derived from public
      // ReliefWeb reports, so any authenticated content reader may list them.
      requireContentReader(context);
      return executeReportSearch(context.prisma, {
        query: args.query,
        filters: args.filters,
        publishedRange: args.publishedRange,
        source: args.source,
        limit: Math.min(Math.max(args.limit ?? 20, 1), 100),
      });
    },

    searchReportsNaturalLanguage: async (
      _parent: unknown,
      args: { question: string; limit?: number | null },
      context: Context,
    ): Promise<{ interpreted: InterpretedReportQuery; reports: ReportHit[] }> => {
      requireContentReader(context);

      const question = args.question ?? "";
      const parsed = interpretReportQuestion(question);

      // Resolve a country mentioned in the question against the A0 locations —
      // the one structured dimension the pure parser can't do without the DB.
      // Longest matching country name wins (so "Nigeria" beats "Niger").
      let countryLocationId: string | null = null;
      let countryName: string | null = null;
      const lowerQ = question.toLowerCase();
      if (lowerQ.trim()) {
        const countries = await context.prisma.$queryRaw<Array<{ id: string; name: string }>>`
          SELECT id, name FROM "locations" WHERE level = 0
        `;
        for (const c of countries) {
          const name = c.name?.trim();
          if (!name) continue;
          const re = new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
          if (re.test(lowerQ) && (!countryName || name.length > countryName.length)) {
            countryLocationId = c.id;
            countryName = name;
          }
        }
      }

      const reports = await executeReportSearch(context.prisma, {
        query: parsed.topicalQuery,
        filters: countryLocationId ? { countryLocationId } : null,
        publishedRange: { from: parsed.publishedFrom, to: parsed.publishedTo },
        source: parsed.source,
        limit: Math.min(Math.max(args.limit ?? 20, 1), 100),
      });

      return {
        interpreted: {
          topicalQuery: parsed.topicalQuery,
          source: parsed.source,
          publishedFrom: parsed.publishedFrom,
          publishedTo: parsed.publishedTo,
          countryLocationId,
          countryName,
        },
        reports,
      };
    },

    reportFiguresPendingKbMerge: async (
      _parent: unknown,
      args: { limit?: number | null },
      context: Context,
    ): Promise<ReportFigureForMerge[]> => {
      // Pipeline-only work queue for the figure→KB sync; carries report text and
      // provenance, so gate it the same as the other ingest-side resolvers.
      requireRole(context, ["admin", "pipeline"]);

      // Bound by REPORTS (not figures) — the sync upserts one report at a time,
      // so a report with many figures is still one unit of work. Clamp to a sane
      // range so a runaway caller can't pull the whole table.
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);

      // A report is "pending" when it has KB text rows AND at least one
      // `report_figures` row whose crop isn't yet present as a `figure_s3_key`
      // in the KB. We then return EVERY figure for those reports (not just the
      // unmerged ones): the figure-scoped upsert deletes-then-inserts all figure
      // rows for a report, so the sync must resend the full figure set or it
      // would drop already-merged figures. Report-level fields come from a
      // DISTINCT ON over the report's KB rows (lowest chunk_index = the text
      // head), so title/url/pdf-key/date match what text chunks carry.
      const rows = await context.prisma.$queryRaw<ReportFigureForMerge[]>`
        WITH pending_reports AS (
          SELECT rf."report_id" AS report_id
          FROM "report_figures" rf
          WHERE EXISTS (
              SELECT 1 FROM "knowledgebase" k
              WHERE k."report_id" = rf."report_id"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "knowledgebase" k2
              WHERE k2."report_id" = rf."report_id"
                AND k2."figure_s3_key" = rf."s3_key"
            )
          GROUP BY rf."report_id"
          ORDER BY rf."report_id"
          LIMIT ${limit}
        ),
        kb_report AS (
          SELECT DISTINCT ON (k."report_id")
            k."report_id"            AS report_id,
            k."report_title"         AS report_title,
            k."source_url"           AS source_url,
            k."s3_key"               AS s3_key,
            k."published_at"         AS published_at,
            k."team_id"              AS team_id,
            k."uploaded_by_user_id"  AS uploaded_by_user_id
          FROM "knowledgebase" k
          JOIN pending_reports p ON p.report_id = k."report_id"
          ORDER BY k."report_id", k."chunk_index"
        )
        SELECT
          rf."report_id"        AS "reportId",
          kr.report_title       AS "reportTitle",
          kr.source_url         AS "sourceUrl",
          kr.s3_key             AS "reportS3Key",
          kr.published_at       AS "publishedAt",
          kr.team_id            AS "teamId",
          kr.uploaded_by_user_id AS "uploadedByUserId",
          rf."s3_key"           AS "figureS3Key",
          rf."kind"             AS "figureKind",
          rf."page_number"      AS "pageNumber",
          rf."title"            AS "title",
          rf."transcription"    AS "transcription",
          rf."location_ids"     AS "locationIds",
          rf."location_pcodes"  AS "locationPcodes",
          rf."event_types"      AS "eventTypes",
          rf."need_sectors"     AS "needSectors",
          rf."time_range_start" AS "timeRangeStart",
          rf."time_range_end"   AS "timeRangeEnd"
        FROM "report_figures" rf
        JOIN kb_report kr ON kr.report_id = rf."report_id"
        ORDER BY rf."report_id", rf."page_number"
      `;
      return rows;
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

      // Figure-scoped sync deletes only this report's figure rows so a figure
      // merge can't wipe text chunks ingested in an earlier run; the default
      // replaces every chunk for the report (text + figures) as before.
      if (args.figuresOnly && args.chunks.some((c) => !c.figureS3Key)) {
        throw new GraphQLError(
          "upsertKnowledgebaseChunks: figuresOnly=true requires every chunk to be a figure chunk (figureS3Key set)",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }

      return context.prisma.$transaction(async (tx) => {
        const deleteResult = await tx.$executeRawUnsafe(
          args.figuresOnly
            ? `DELETE FROM "knowledgebase" WHERE "report_id" = $1 AND "figure_s3_key" IS NOT NULL`
            : `DELETE FROM "knowledgebase" WHERE "report_id" = $1`,
          args.reportId,
        );

        // Insert all chunks in ONE multi-row statement rather than N serial
        // round-trips. A report with hundreds of chunks otherwise holds its
        // pooled connection across the whole DELETE + N INSERTs (up to the
        // 60s transaction timeout); batching returns the connection to the
        // pool far sooner, which is what keeps a concurrent pipeline run from
        // starving the pool. 24 params/row × KB_MAX_CHUNKS_PER_REPORT stays
        // well under Postgres's 65535-parameter cap.
        //
        // team_id / uploaded_by_user_id are report-level (same for every chunk),
        // denormalised per row like report_title/source_url. Null for the weekly
        // ReliefWeb ingest; set for a team-scoped manual upload.
        const teamId = args.teamId ?? null;
        const uploadedByUserId = args.uploadedByUserId ?? null;
        const rows: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const chunk of args.chunks) {
          rows.push(
            `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ` +
              `$${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ` +
              `$${p++}, $${p++}, $${p++}::vector(1024), $${p++}::text[], $${p++}::text[], ` +
              `$${p++}, $${p++}, $${p++}::text[], $${p++}::text[], $${p++}, $${p++}, ` +
              `$${p++}, $${p++})`,
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
            teamId,
            uploadedByUserId,
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
              "figure_s3_key", "figure_kind",
              "team_id", "uploaded_by_user_id"
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
        teamId?: string | null;
      },
      context: Context,
    ): Promise<KnowledgebaseIngestJob> => {
      // Team-scoped write (Cap 1): a global admin, or any content-writer member
      // of `teamId`, may upload. Each accepted upload spends LLM + embedding
      // credits on the enrich chain, so it's gated — but no longer admin-only:
      // a team member uploads on behalf of their team. `user` is the uploader,
      // attributed onto the ingest run below.
      const { user } = await requireTeamContentWriter(context, args.teamId);

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
              // Attribution carried into the ingest op (optional config fields).
              team_id: args.teamId ?? "",
              uploaded_by_user_id: user.id,
            },
          },
        },
      };
      const tags: Record<string, string> = {
        [DAGSTER_TAG_REPORT_ID]: reportId,
        [DAGSTER_TAG_REPORT_TITLE]: args.title,
        [DAGSTER_TAG_S3_KEY]: s3Key,
        [DAGSTER_TAG_UPLOADED_BY]: user.id,
        // Only tag a real team — an admin upload has no team scope.
        ...(args.teamId ? { [DAGSTER_TAG_TEAM_ID]: args.teamId } : {}),
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

  KnowledgebaseHit: {
    /** Presign the cropped figure image on demand — only when the field is
     *  selected (infographic search, Cap 2). Null for a text hit. Kept off the
     *  row shape so ordinary text search never pays the S3 round-trip. */
    figureImageUrl: async (parent: SearchHit): Promise<string | null> => {
      if (!parent.figureS3Key) return null;
      const { getPresignedUrl } = await import("../services/s3.js");
      return getPresignedUrl(parent.figureS3Key);
    },
  },
};
