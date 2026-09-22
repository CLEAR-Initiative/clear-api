import { gql } from "graphql-tag";

/**
 * Knowledge-base surface for the ReliefWeb PDF ingest pipeline
 * (dagster-quickstart) and the future chatbot search API.
 *
 * Split into two concerns:
 *   - Ingest write path: `upsertKnowledgebaseChunks` (mutation) —
 *     dagster batches one call per report; the resolver deletes any
 *     existing rows for `reportId` and inserts the fresh batch inside
 *     one transaction so a re-run cannot leave torn state.
 *   - Location resolver: `resolveKnowledgebaseLocation` (query) — the
 *     enrichment stage's LLM emits `{ pcode?, name?, adminLevel? }`
 *     refs; this query does the pcode-first / name-fallback lookup
 *     against `locations` in one place so we don't reimplement the
 *     normalisation on every consumer.
 *
 * All types live here rather than being split per-purpose because the
 * knowledge-base surface is small and self-contained.
 */
export const knowledgebaseTypeDef = gql`
  """One chunk written into the knowledgebase table. Mirrors the
  columns exactly (minus \`lexicalTsv\`, which the DB trigger fills
  from \`embeddedText\`, and \`createdAt\` which uses the column
  default)."""
  input KnowledgebaseChunkInput {
    """0-indexed position within the report."""
    chunkIndex: Int!
    """Inclusive PDF page span this chunk covers."""
    pageStart: Int!
    pageEnd: Int!

    """Raw excerpt text — what a UI would render on a search hit."""
    chunkText: String!
    """LLM-generated context prefix (empty string when contextualization
    is skipped)."""
    contextPrefix: String!
    """\`contextPrefix + "\\n\\n" + chunkText\` — what was actually
    embedded and tokenised."""
    embeddedText: String!

    """Provenance for the embedding — mirrors the DB columns so a
    later re-embed backfill can filter by (provider, model)."""
    embeddingProvider: String!
    embeddingModel: String!
    """1024-dim dense embedding. The API validates length and casts to
    \`vector(1024)\` before insert."""
    embedding: [Float!]!

    """Resolved \`locations.id\` refs (post-lookup)."""
    locationIds: [String!]!
    """Raw pcodes the LLM emitted but the resolver couldn't match."""
    locationPcodes: [String!]!

    """Optional event window described by the chunk."""
    timeRangeStart: DateTime
    timeRangeEnd: DateTime

    """Multi-hazard tags — GLIDE codes or free-text categories."""
    eventTypes: [String!]!
    """NRC SAF sectors: Shelter, WASH, Protection, Health,
    Food Security, Education."""
    needSectors: [String!]!

    """Infographic capture: set only when this chunk is a figure
    transcription merged into the KB. \`figureS3Key\` is the cropped
    image's S3 key (join key to \`report_figures\`); \`figureKind\` is
    that figure's kind. Both null for ordinary text chunks."""
    figureS3Key: String
    figureKind: String
  }

  """Result of a knowledgebase upsert — summary counts for logging."""
  type UpsertKnowledgebaseResult {
    reportId: String!
    chunksDeleted: Int!
    chunksInserted: Int!
  }

  """Result of \`syncEventCards\` — how many event cards were written vs
  skipped (an id that no longer resolves to an event)."""
  type SyncEventCardsResult {
    synced: Int!
    skipped: Int!
  }

  # ─── Read side (search) ─────────────────────────────────────────────

  """One hit from \`searchKnowledgebase\`. Carries enough source
  provenance (report title, url, page range) that a UI can render a
  citation without a follow-up fetch, plus the parameter arrays so
  the caller can highlight which filters matched."""
  type KnowledgebaseHit {
    id: String!
    """Tier this hit came from (ADR-0006). Consumers should weight/caveat
    \`incident\` hits as lower-tier (possibly unverified) and MUST NOT let
    incident figures feed the same datapoint aggregation as report figures."""
    tier: KnowledgebaseTier!
    """For a \`report\` hit, the ReliefWeb report id; for an \`incident\`
    hit, \`event:<event id>\`."""
    reportId: String!
    reportTitle: String!
    sourceUrl: String!
    """Report publication date, or — for an incident — the event's onset
    (\`startedAt\`), the recency signal used to order the incident band."""
    publishedAt: DateTime
    """0 for an incident hit (page range is report-only)."""
    pageStart: Int!
    pageEnd: Int!
    """Report chunk excerpt, or — for an incident — the synthesised event card."""
    chunkText: String!
    """Merge score, larger is better. Ordering/membership only — NOT
    comparable across queries or (post-ADR-0006) across tiers: it is a
    positional \`1/(k+rank)\` from the tier-aware merge, plus a small recency
    term on incidents, not the raw RRF sum."""
    score: Float!
    locationIds: [String!]!
    eventTypes: [String!]!
    needSectors: [String!]!
    """When this hit is a figure transcription, the cropped image's S3 key
    and its kind (chart/map/table/infographic/photo) — null for text hits.
    A consumer generating an infographic fetches this image and attaches it
    to the LLM call; plain Q&A ignores it. Kept as a lightweight REFERENCE
    (no bytes) so retrieval never pays S3 cost."""
    figureS3Key: String
    figureKind: String
  }

  """Half-open date window (from inclusive, to exclusive) used to
  filter \`searchKnowledgebase\` by the chunk's extracted event
  window. Chunks whose time_range overlaps the window match."""
  input DateRangeInput {
    from: DateTime
    to: DateTime
  }

  """A knowledgebase tier (ADR-0006). \`report\` = the ReliefWeb state/analysis
  KB; \`incident\` = an event card from the incident index (lower-tier, possibly
  unverified). Lowercase values match the stored tier strings."""
  enum KnowledgebaseTier {
    report
    incident
  }

  """How \`searchKnowledgebase\` merges the report + incident tiers
  (ADR-0006)."""
  enum KnowledgebaseSearchMode {
    """Pick FRAME when the query is effectively empty / frame-only, else
    TOPICAL."""
    AUTO
    """Situation-analysis: a location+time frame with little topical text.
    Returns a report band + a quota-bounded incident band ordered by
    recency + severity; no similarity floor (it would gate out the very
    incidents the frame is asking for)."""
    FRAME
    """Chatbot: a strong free-text query. Interleaves the two tiers by
    relevance (soft), gating weak incidents below a similarity floor and
    giving reports a small rank preference."""
    TOPICAL
  }

  # ─── Manual ingest trigger ─────────────────────────────────────────

  """Coarse-grained status of a manual-ingest Dagster run. Dagster's
  own RunStatus enum is finer-grained (STARTING / MANAGED / CANCELING
  / …) — we fold those down to what a UI actually needs to render."""
  enum KnowledgebaseIngestStatus {
    QUEUED
    STARTED
    SUCCESS
    FAILURE
    CANCELED
    """Dagster is offline, the run id doesn't exist, or the run status
    is one this API doesn't recognise. Non-terminal — poll again."""
    UNKNOWN
  }

  """One Dagster run kicked off by \`uploadKnowledgebaseDocument\`.
  Returned by both the mutation (initial launch) and the polling
  query. \`reportId\` / \`reportTitle\` / \`s3Key\` are populated from
  the run's Dagster tags, which the mutation attaches at launch time —
  a client that lost track of the initial payload can still recover
  the identity of the document being ingested."""
  type KnowledgebaseIngestJob {
    """Opaque Dagster run id. Pass to \`knowledgebaseIngestJob\` to
    poll for completion."""
    runId: String!
    status: KnowledgebaseIngestStatus!
    """The knowledgebase report_id the ingest is targeting. Same value
    surfaces on \`Knowledgebase.reportId\` once the run succeeds."""
    reportId: String
    reportTitle: String
    s3Key: String
    startedAt: DateTime
    endedAt: DateTime
  }

  """Optional filters applied BEFORE the retrieval step — array
  filters use overlap semantics (any-of), the time range uses
  inclusive intersection. Leave a field null to skip that filter."""
  input KnowledgebaseFilters {
    """Match rows tagged with ANY of these \`locations.id\` values."""
    locationIds: [String!]
    """Scope to one country: keep only chunks tagged with a location in this
    A0's subtree (itself or any descendant admin unit). Chunk locations are
    resolved to leaf admin ids, so a bare \`locationIds=[A0]\` would miss them —
    this expands the A0 to its subtree server-side via the locations tree. The
    situation-analysis RAG uses this so a country's analysis never cites reports
    about another country."""
    countryLocationId: String
    """Match rows tagged with ANY of these event-type tags."""
    eventTypes: [String!]
    """Match rows tagged with ANY of these SAF sectors."""
    needSectors: [String!]
    """Match rows whose extracted event window overlaps this range."""
    timeRange: DateRangeInput
    """Restrict to rows written by the currently-configured
    embedding provider + model. Default true — mixing embedding
    spaces yields meaningless distances. Set false only when
    inspecting historical rows via BM25-only search (no vector
    step will be run for filtered-out rows)."""
    currentEmbeddingModelOnly: Boolean = true
  }
`;
