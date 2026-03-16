import { gql } from "graphql-tag";

export const detectionTypeDef = gql`
  """Processing status of a detection (retained for potential future use)."""
  enum DetectionStatus {
    raw
    processed
    ignored
  }
`;
