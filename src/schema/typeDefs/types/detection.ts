import { gql } from "graphql-tag";

export const detectionTypeDef = gql`
  """Processing status of a detection."""
  enum DetectionStatus {
    raw
    processed
    ignored
  }

  """A source detection from a data source, with confidence score and geographic scope."""
  type Source {
    id: String!
    title: String!
    """Confidence score from 0.0 to 1.0."""
    confidence: Float
    status: DetectionStatus!
    """When this was originally detected."""
    detectedAt: DateTime!
    """Original detection payload as JSON."""
    rawData: JSON
    """The data source that produced this source."""
    dataSource: DataSource
    """The signal derived from this source, if any."""
    signal: Signal
    """Geographic locations where this source was detected."""
    locations: [SourceLocation!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
