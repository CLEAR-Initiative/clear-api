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
import { embedQuery, loadEmbeddingConfig } from "../utils/embedding-client.js";
import { env } from "../utils/env.js";

const EMBEDDING_DIMENSIONS = 1024;

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
}

interface UpsertKnowledgebaseArgs {
  reportId: string;
  reportTitle: string;
  sourceUrl: string;
  s3Key: string;
  publishedAt: Date;
  chunks: KnowledgebaseChunkInput[];
}

/** Format a numeric vector for the `'[…]'::vector(1024)` cast. */
function vectorLiteral(embedding: number[]): string {
  // Fixed precision keeps the SQL text bounded; 7 digits preserves
  // effectively all information in a 32-bit float embedding.
  return `[${embedding.map((v) => v.toFixed(7)).join(",")}]`;
}

interface KnowledgebaseFilters {
  locationIds?: string[] | null;
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
function buildFilterClause(
  filters: KnowledgebaseFilters | null | undefined,
  params: unknown[],
): string {
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
  if (filters?.eventTypes && filters.eventTypes.length > 0) {
    params.push(filters.eventTypes);
    conditions.push(`"event_types" && $${params.length}::text[]`);
  }
  if (filters?.needSectors && filters.needSectors.length > 0) {
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

/** Format a numeric vector for the `'[…]'::vector(1024)` cast — same
 * helper the write path uses; kept as a module-local rather than
 * exported so both call sites are visibly the only writers/readers. */
function queryVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => v.toFixed(7)).join(",")}]`;
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

      // Case-insensitive name match, optionally scoped to a level so a
      // village that shares its state's name doesn't collide. We cap
      // at level 3 because L4 (point) rows carry non-place labels
      // (signal titles, "TEST PT — …") that we never want the LLM to
      // land on. If adminLevel is provided, use only that; else scan
      // 0..3 and prefer the deeper match (LIMIT 1 with ORDER by level
      // DESC).
      if (args.adminLevel != null) {
        const rows = await context.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "locations"
          WHERE lower(name) = lower(${name})
            AND level = ${args.adminLevel}
          LIMIT 1
        `;
        return rows[0]?.id ?? null;
      }
      const rows = await context.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "locations"
        WHERE lower(name) = lower(${name})
          AND level BETWEEN 0 AND 3
        ORDER BY level DESC
        LIMIT 1
      `;
      return rows[0]?.id ?? null;
    },

    searchKnowledgebase: async (
      _parent: unknown,
      args: {
        query: string;
        filters?: KnowledgebaseFilters | null;
        limit?: number | null;
      },
      context: Context,
    ): Promise<Array<KnowledgebaseHitRow & { score: number }>> => {
      // Any authenticated content reader (admin/analyst/viewer);
      // rejects pending users with the standard pending-approval
      // message. The knowledge base is derived from public ReliefWeb
      // reports so the read gate is deliberately loose.
      requireContentReader(context);

      const q = args.query.trim();
      if (!q) {
        throw new GraphQLError("searchKnowledgebase: query must not be empty", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      // Bound the fan-out so a runaway caller can't request 10k rows.
      // The retrieval step still runs against CANDIDATES_PER_RETRIEVER
      // regardless of `limit` — clamping just the output.
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);

      // Dense-side needs the query vector cast to pgvector; sparse-side
      // needs the raw text for tsquery. Both paths share the filter
      // clause so callers see consistent params applied.
      const queryVec = await embedQuery(q);
      const vecLiteral = queryVectorLiteral(queryVec);

      // Build the filter clause once and reuse the params for both
      // queries. Dense appends [vecLiteral, limit]; sparse appends
      // [q, q, limit] (tsquery is referenced twice: WHERE + ORDER BY).
      const denseParams: unknown[] = [];
      const denseWhere = buildFilterClause(args.filters, denseParams);
      const sparseParams: unknown[] = [];
      const sparseWhere = buildFilterClause(args.filters, sparseParams);

      const denseSql = `
        SELECT
          "id",
          "report_id"       AS "reportId",
          "report_title"    AS "reportTitle",
          "source_url"      AS "sourceUrl",
          "published_at"    AS "publishedAt",
          "page_start"      AS "pageStart",
          "page_end"        AS "pageEnd",
          "chunk_text"      AS "chunkText",
          "location_ids"    AS "locationIds",
          "event_types"     AS "eventTypes",
          "need_sectors"    AS "needSectors"
        FROM "knowledgebase"
        ${denseWhere}
        ORDER BY "embedding" <=> $${denseParams.length + 1}::vector(1024)
        LIMIT $${denseParams.length + 2}
      `;
      denseParams.push(vecLiteral, CANDIDATES_PER_RETRIEVER);

      // Sparse: filter by tsvector match FIRST so we don't rank rows
      // that don't touch any query term. `plainto_tsquery` handles
      // stop-word stripping + stemming automatically; a query that
      // reduces to nothing (all stopwords) yields zero sparse hits,
      // which is fine — dense still runs.
      const sparseSql = `
        SELECT
          "id",
          "report_id"       AS "reportId",
          "report_title"    AS "reportTitle",
          "source_url"      AS "sourceUrl",
          "published_at"    AS "publishedAt",
          "page_start"      AS "pageStart",
          "page_end"        AS "pageEnd",
          "chunk_text"      AS "chunkText",
          "location_ids"    AS "locationIds",
          "event_types"     AS "eventTypes",
          "need_sectors"    AS "needSectors"
        FROM "knowledgebase"
        ${sparseWhere ? `${sparseWhere} AND` : "WHERE"}
          "lexical_tsv" @@ plainto_tsquery('english', $${sparseParams.length + 1})
        ORDER BY ts_rank_cd(
          "lexical_tsv",
          plainto_tsquery('english', $${sparseParams.length + 2})
        ) DESC
        LIMIT $${sparseParams.length + 3}
      `;
      sparseParams.push(q, q, CANDIDATES_PER_RETRIEVER);

      const [denseRows, sparseRows] = await Promise.all([
        context.prisma.$queryRawUnsafe<KnowledgebaseHitRow[]>(denseSql, ...denseParams),
        context.prisma.$queryRawUnsafe<KnowledgebaseHitRow[]>(sparseSql, ...sparseParams),
      ]);

      // Reciprocal Rank Fusion. Each row gets 1/(k + rank) from every
      // retriever it appeared in; rows in both get both contributions.
      // No score normalisation — RRF is already rank-based.
      const fused = new Map<string, { row: KnowledgebaseHitRow; score: number }>();
      denseRows.forEach((row, i) => {
        fused.set(row.id, { row, score: 1 / (RRF_K + i + 1) });
      });
      sparseRows.forEach((row, i) => {
        const bonus = 1 / (RRF_K + i + 1);
        const existing = fused.get(row.id);
        if (existing) {
          existing.score += bonus;
        } else {
          fused.set(row.id, { row, score: bonus });
        }
      });

      return Array.from(fused.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ row, score }) => ({ ...row, score }));
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

        for (const chunk of args.chunks) {
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
                "event_types", "need_sectors"
              ) VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4,
                $5,
                $6, $7, $8,
                $9, $10, $11,
                $12, $13, $14::vector(1024),
                $15::text[], $16::text[],
                $17, $18,
                $19::text[], $20::text[]
              )
            `,
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
          );
        }

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
