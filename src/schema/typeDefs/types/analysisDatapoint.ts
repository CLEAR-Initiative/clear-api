import { gql } from "graphql-tag";

/**
 * Analysis-module final numbers (clear-pipeline `analysis_numbers_extract`).
 *
 * A dedicated frame-numbers store, child of `analysis` (one row per
 * generation, keyed on `analysisId`). Separate from `aggregated_datapoints` so
 * analysis-sourced figures never collide with the KB report-aggregation path.
 * The frame + window live on the parent `analysis`; bitemporality is the
 * analyses chain's (a new generation is a new `analysis` row → a new
 * `AnalysisDatapoint`). The `data` payload mirrors
 * `AggregatedDatapoint.data` (QualityEnvelope leaves) and is opaque `JSON!`,
 * versioned by `schemaVersion`.
 */
export const analysisDatapointTypeDef = gql`
  """The extracted + aggregated final figures for one analysis generation."""
  type AnalysisDatapoint {
    id: String!
    analysisId: String!
    """Figures — same QualityEnvelope leaf structure as \`AggregatedDatapoint.data\`."""
    data: JSON!
    """Report ids that fed these figures (web gap-fill evidence is cited per-figure in \`data\`)."""
    contributingReportIds: [String!]!
    """Coarse provenance: \`kb\` | \`aggregated\` | \`web\` (dominant origin for mixed rows)."""
    origin: String
    newestSourceAt: DateTime
    oldestSourceAt: DateTime
    dataQualityScore: Float
    reportCount: Int
    schemaVersion: String!
    computedAt: DateTime!
  }

  """Input for \`upsertAnalysisDatapoints\`. Upsert is keyed on \`analysisId\`
  (one row per generation), so re-running an extraction replaces in place."""
  input UpsertAnalysisDatapointsInput {
    analysisId: String!
    data: JSON!
    contributingReportIds: [String!]!
    origin: String
    newestSourceAt: DateTime
    oldestSourceAt: DateTime
    dataQualityScore: Float
    reportCount: Int
    schemaVersion: String!
  }

  """Result of \`upsertAnalysisDatapoints\` — summary for logs."""
  type UpsertAnalysisDatapointsResult {
    analysisId: String!
    schemaVersion: String!
    """\`true\` when the mutation replaced a previously extracted row,
    \`false\` when it created the first row for the analysis."""
    createdOrReplaced: Boolean!
  }
`;
