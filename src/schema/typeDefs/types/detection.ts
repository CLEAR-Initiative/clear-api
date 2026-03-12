import { gql } from "graphql-tag";

export const detectionTypeDef = gql`
  """Processing status of a detection."""
  enum DetectionStatus {
    raw
    processed
    ignored
  }

  """A detection event from a data source, with confidence score and geographic scope."""
  type Detection {
    id: String!
    title: String!
    """Confidence score from 0.0 to 1.0."""
    confidence: Float
    status: DetectionStatus!
    """When this event was originally detected."""
    detectedAt: DateTime!
    """Original detection payload as JSON."""
    rawData: JSON
    """The data source that produced this detection."""
    source: DataSource
    """The signal derived from this detection, if any."""
    signal: Signal
    """Geographic locations where this detection occurred."""
    locations: [SourceLocation!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
