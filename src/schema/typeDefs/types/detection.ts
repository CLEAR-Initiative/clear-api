import { gql } from "graphql-tag";

export const detectionTypeDef = gql`
  enum DetectionStatus {
    raw
    processed
    ignored
  }

  type Detection {
    id: Int!
    title: String!
    confidence: Float
    status: DetectionStatus!
    detectedAt: DateTime!
    rawData: JSON
    source: DataSource
    alert: Alert
    locations: [DetectionLocation!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
