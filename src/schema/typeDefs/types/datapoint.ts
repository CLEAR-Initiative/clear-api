import { gql } from "graphql-tag";

/**
 * Structured humanitarian datapoints — Layers 1 and 2 of the read path
 * (see clear-context-pipeline/docs/humanitarian-datapoint-extraction.md).
 *
 * This file covers Layer 2 (per-report). Layer 1 (aggregated
 * datapoints + runtime rollup) ships in Phase 2.
 *
 * The `data` payload is intentionally a JSON scalar — the exhaustive
 * datapoint schema is defined and validated on the ingest side
 * (Pydantic sub-schemas in `datapoints_schemas.py`); modelling it in
 * GraphQL would double-encode a taxonomy that already evolves per
 * `schemaVersion`. Clients that want typed access should key their
 * TypeScript types off the same Pydantic models via codegen.
 */
export const datapointTypeDef = gql`
  """One report's extracted structured datapoints. Keys inside
  \`data\` are the six domain names: \`timing_and_scope\`,
  \`casualties\`, \`displacement\`, \`needs_and_funding\`,
  \`access_and_incidents\`, \`narrative_and_confidence\`. A domain
  whose extraction failed is written as \`null\` — the operator can
  re-run a targeted extraction on that domain later without touching
  the successful ones."""
  type ReportDatapoint {
    id: String!

    reportId: String!
    reportTitle: String!
    sourceUrl: String!
    publishedAt: DateTime!

    """Window the report CONTENT describes. Not the publication date."""
    reportingPeriodStart: DateTime
    reportingPeriodEnd: DateTime

    """Resolved \`locations.id\` values, deduped."""
    locationIds: [String!]!
    """Raw pcodes the LLM emitted that the resolver couldn't tie to a
    CLEAR location. A nightly backfill re-attempts these."""
    locationPcodes: [String!]!

    """Free-text event tags (\`conflict\`, \`flood\`, \`displacement\`,
    \`disease-outbreak\`, …). Multi-hazard reports carry multiple."""
    eventTypes: [String!]!

    """Denormalised hot totals — cheap dashboard filter/sort keys.
    NULL when the report doesn't headline the figure; DO NOT sum
    these across rows (the JSON blob carries the incident-safe form)."""
    totalAffected: Int
    totalDisplaced: Int
    totalKilled: Int

    """Exhaustive per-report payload. See the Pydantic sub-schemas in
    \`datapoints_schemas.py\` for shape."""
    data: JSON!

    """Extraction schema version, e.g. \`v1\`. Rows with different
    versions must not be aggregated together."""
    schemaVersion: String!

    """LLM identifier that produced the extraction (e.g.
    \`claude-sonnet-4-6\`). Used by the reviewer-audit workflow."""
    extractedByModel: String!
    extractedAt: DateTime!
  }

  """Input for \`upsertReportDatapoints\`. Field names / types
  mirror the ReportDatapoint output so a client can echo one back
  into the other with minimal transformation."""
  input UpsertReportDatapointsInput {
    reportId: String!
    reportTitle: String!
    sourceUrl: String!
    publishedAt: DateTime!

    reportingPeriodStart: DateTime
    reportingPeriodEnd: DateTime

    locationIds: [String!]!
    locationPcodes: [String!]!
    eventTypes: [String!]!

    totalAffected: Int
    totalDisplaced: Int
    totalKilled: Int

    data: JSON!
    schemaVersion: String!
    extractedByModel: String!
    """The report's publisher source (a \`data_sources\` id), resolved by the
    pipeline via \`resolveDataSource\`. Null until source attribution backfills;
    a figure's own cited source lives per-figure inside \`data\`. See clear-context-pipeline ADR-0004."""
    sourceId: String
  }

  """Result of \`upsertReportDatapoints\` — summary for logs."""
  type UpsertReportDatapointsResult {
    reportId: String!
    schemaVersion: String!
    """\`true\` when the mutation replaced a previously extracted row,
    \`false\` when it created the first row for the report."""
    createdOrReplaced: Boolean!
  }

  # ─── Layer 1 — Aggregated cache ─────────────────────────────────────

  """One aggregated bucket — the roll-up of every contributing
  \`report_datapoint\` for a scope (window × window_kind × location).
  Consumed by the situation-analysis dashboard tiles and by chatbot
  factual queries. See \`AggregatedField\` docstring for the JSON
  \`data\` shape."""
  type AggregatedDatapoint {
    id: String!

    windowStart: DateTime!
    windowEnd: DateTime!
    """One of \`weekly\` | \`monthly\` | \`yearly\` | \`all\`."""
    windowKind: String!
    """Null when the bucket rolls up to a country (yearly, all-time
    tiers). Otherwise references \`locations.id\`."""
    locationId: String

    """Flat map keyed by field label. Each value is either a
    QualityEnvelope (for numeric fields), a SetUnionEnvelope (for label
    fields — \`{ values, contributing_report_ids }\`), or \`null\` when
    no report in scope reported that field.

    A numeric QualityEnvelope carries \`{ value, unit, confidence_mix,
    newest_report_at, oldest_report_at, contributing_report_ids }\` plus
    the credibility fields (clear-context-pipeline ADR-0004/0005): the
    cached time-invariant \`reliability\` (1–4) and \`intrinsic_credibility\`
    (0–8.5), and — added on every read — \`recency\` (0–1.5),
    \`information_credibility\` (0–10), and \`data_quality\` (**0–10**), the
    per-field headline. The legacy \`quality_score\` (0–1, directness-only)
    is retained for backwards compatibility."""
    data: JSON!

    contributingReportIds: [String!]!
    newestSourceAt: DateTime!
    oldestSourceAt: DateTime!
    """Bucket headline data quality on a **0–10** scale (clear-context-pipeline
    ADR-0005): the mean of the fields' read-time \`data_quality\`
    (\`(reliability × 2.5 × information_credibility) / 10\`, Recency folded
    in at read). The stored column carries the same 0–10 scale. NOTE: this
    is a scale change from the pre-data-quality \`quality_score\` (0–1) —
    thresholds tuned on the old scale must be re-tuned."""
    dataQualityScore: Float!
    reportCount: Int!

    """Estimated current totals — latest authoritative stock + the flows
    reported after it (ADR-0006 §4). This is an **as-of-now** figure, NOT the
    bucket's period: it is returned only for a bucket whose window still
    includes now (the current year/month/week and the \`all\` tier) and is
    \`null\` on any historical bucket, so a past-period row never carries a
    present-day number. Resolved lazily — the bounded \`report_datapoints\` scan
    runs only when this field is selected — but it is a real scan, not free."""
    estimatedCurrentTotals: CurrentTotals

    """Bitemporal validity — this snapshot's lifetime as a "current"
    row. \`validTo\` is null when the row is still the current one for
    its bucket; else it carries the timestamp when a newer computation
    superseded it."""
    validFrom: DateTime!
    validTo: DateTime

    schemaVersion: String!
    computedAt: DateTime!

    """True when the resolver assembled this bucket on-demand from
    \`report_datapoints\` rather than serving it from the pre-compute
    cache. The dashboard can render a "just computed" indicator so
    users know the number reflects the freshest possible view."""
    onDemand: Boolean!
  }

  """One metric's estimated current total (ADR-0006 §4): the latest
  authoritative stock plus the flows reported after its reference date T₀.
  Flows at or before T₀ are already embedded in the stock and are not added
  again — the invariant that stops returnee/IDP totals from over-counting."""
  type StockFlowEstimate {
    """\`stock\` + \`flowsSince\` — the headline estimated current total."""
    total: Float!
    """The anchoring latest authoritative stock value (API-reconciled)."""
    stock: Float!
    """Deduped sum of the flows whose as-of date is strictly after T₀."""
    flowsSince: Float!
    """T₀ — the anchor stock's reference date. Flows at/before it are treated
    as already counted inside \`stock\`."""
    t0: DateTime!
    """Reports contributing forward flows — a provenance count, not a count of
    distinct flow events."""
    flowCount: Int!
  }

  """Estimated current totals for a country bucket (ADR-0006 §4). Each metric is
  \`null\` when there is no anchoring stock in scope to accrue flows onto."""
  type CurrentTotals {
    """IDP displacement: latest \`idp_stock\` + \`new_displacements\` since T₀."""
    displacement: StockFlowEstimate
    """Returns: latest \`returnee_stock\` + \`new_returns\` since T₀."""
    returns: StockFlowEstimate
  }

  """Summary counts from a \`refreshAggregatedDatapoints\` run."""
  type RefreshAggregatedDatapointsResult {
    computedBuckets: Int!
    supersededBuckets: Int!
    """Count of \`situation_analyses\` current rows that had their
    \`validTo\` stamped as a cascade of the yearly-country
    aggregation writes in this run. Zero means either no yearly
    buckets were touched or no situation-analysis snapshot existed
    yet for the affected countries."""
    situationAnalysesInvalidated: Int!
    schemaVersion: String!
  }
`;
