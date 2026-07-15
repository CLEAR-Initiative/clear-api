import { gql } from "graphql-tag";

/**
 * Situation Analysis — pre-computed narrative + numeric snapshot per
 * (country × year). The dashboard reads one row for the current year;
 * the Dagster `weekly_situation_analyses` asset regenerates and
 * bitemporally supersedes rows weekly.
 *
 * The `data` payload carries seven top-level components; see the
 * Pydantic schemas in
 * `clear-context-pipeline/src/clear_context_pipeline/defs/situation/schemas.py`
 * for the exact shape (deliberately not modelled in the GraphQL types
 * because the taxonomy still evolves — versioned via `schemaVersion`).
 * Clients should key their TypeScript types off the Python models via
 * codegen or hand-mirror per schema version.
 */
export const situationAnalysisTypeDef = gql`
  """One (country × year) situation-analysis snapshot. Cache read
  path — always current unless \`asOf\` is supplied for historical
  reads."""
  type SituationAnalysis {
    id: String!

    """FK to \`locations.id\` — the country (A0) this analysis covers."""
    countryLocationId: String!

    windowStart: DateTime!
    windowEnd: DateTime!

    """Full analysis blob. Top-level keys: \`datapoints\`,
    \`ai_summary\`, \`context_risks\`, \`hazards_and_vulnerabilities\`,
    \`displacement\`, \`sectors\`, \`sources\`. LLM-generated
    components carry their own \`source_report_ids\` for
    per-component provenance."""
    data: JSON!

    """Denormalised union of every contributing report id across all
    components. Same identity as the \`report_id\` on the underlying
    \`knowledgebase\` / \`report_datapoints\` rows."""
    sourceReportIds: [String!]!

    """Aggregated-datapoints snapshot this analysis was generated
    against, when known. Null for early bootstrap runs."""
    aggregatedDatapointId: String

    """LLM identifier (e.g. \`claude-sonnet-4-6\`).
    Deterministic-only Phase B runs record \`deterministic:<version>\`."""
    generatedByModel: String!
    """Total LLM cost across all component calls. Null when the
    generator didn't track cost or the run was deterministic-only."""
    generationCostUsd: Float
    generatedAt: DateTime!

    """Bitemporal validity — this snapshot's lifetime as a "current"
    row. \`validTo\` is null when the row is still the current one
    for its bucket; else it carries the timestamp when a newer
    regeneration superseded it."""
    validFrom: DateTime!
    validTo: DateTime

    """Bumped when the output taxonomy OR the prompt set changes.
    Different-version rows never mix on trend views."""
    schemaVersion: String!
  }

  input UpsertSituationAnalysisInput {
    countryLocationId: String!
    windowStart: DateTime!
    windowEnd: DateTime!
    data: JSON!
    sourceReportIds: [String!]!
    aggregatedDatapointId: String
    generatedByModel: String!
    generationCostUsd: Float
    schemaVersion: String!
  }

  """Summary of an \`upsertSituationAnalysis\` mutation — reports
  whether the write superseded a previously-current row."""
  type UpsertSituationAnalysisResult {
    situationAnalysisId: String!
    countryLocationId: String!
    """\`true\` when the mutation stamped \`validTo\` on a previous
    current row for the same bucket, \`false\` when this was the
    first row for the (country, window) tuple."""
    supersededPrevious: Boolean!
  }
`;
