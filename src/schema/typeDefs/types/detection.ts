import { gql } from "graphql-tag";

export const detectionTypeDef = gql`
  enum DetectionStatus {
    raw
    processed
    ignored
  }

  type Detection {
    id: String!
    title: String!
    confidence: Float
    status: DetectionStatus!
    detectedAt: DateTime!
    rawData: JSON
    source: DataSource
    signal: Signal
    locations: [DetectionLocation!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
