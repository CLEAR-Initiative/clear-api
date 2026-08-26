import { gql } from "graphql-tag";

/**
 * Report figures — the image asset store behind the infographic-capture feature.
 * Each row is an infographic (chart/map/table/composite) cropped from a report
 * page and stored in S3, tagged with the same retrieval params as knowledge-base
 * chunks. See clear-context-pipeline/docs/infographic-capture-spec.md.
 *
 * Write path: `upsertReportFigures` (pipeline-only) — replaces a report's figures
 * atomically. Read path: `reportFigures(...)` filters by the same
 * location/eventType/needSector/time params as text, so a figure is retrievable
 * and attachable alongside the report's narrative.
 */
export const reportFigureTypeDef = gql`
  type ReportFigure {
    id: String!
    reportId: String!
    reportTitle: String!
    sourceUrl: String!
    """1-indexed source page."""
    pageNumber: Int!
    """Source-page bounding box [x0, top, x1, bottom] in PDF points; empty on full-page fallback."""
    bbox: [Float!]!
    isFullPage: Boolean!
    """S3 key of the cropped image."""
    s3Key: String!
    """chart | map | table | infographic | photo (logos are dropped, not stored)."""
    kind: String!
    title: String
    description: String
    """Structured transcription (rows / nested groups / callouts) from the vision pass."""
    transcription: JSON
    """Publishing source (data_sources id) for attribution."""
    sourceId: String
    locationIds: [String!]!
    locationPcodes: [String!]!
    eventTypes: [String!]!
    needSectors: [String!]!
    timeRangeStart: DateTime
    timeRangeEnd: DateTime
    extractedByModel: String!
    extractedAt: DateTime!
  }

  input ReportFigureInput {
    pageNumber: Int!
    bbox: [Float!]
    isFullPage: Boolean
    s3Key: String!
    kind: String!
    title: String
    description: String
    transcription: JSON
    sourceId: String
    locationIds: [String!]
    locationPcodes: [String!]
    eventTypes: [String!]
    needSectors: [String!]
    timeRangeStart: DateTime
    timeRangeEnd: DateTime
  }

  """Replace-on-reingest payload for one report's figures (pipeline-only)."""
  input UpsertReportFiguresInput {
    reportId: String!
    reportTitle: String!
    sourceUrl: String!
    extractedByModel: String!
    figures: [ReportFigureInput!]!
  }

  type UpsertReportFiguresResult {
    reportId: String!
    """Number of figures written."""
    count: Int!
  }
`;
