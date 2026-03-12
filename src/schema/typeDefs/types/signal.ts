import { gql } from "graphql-tag";

export const signalTypeDef = gql`
  """A signal derived from a source detection."""
  type Signal {
    id: String!
    """The source (detection) this signal was derived from."""
    source: Detection!
    publishedAt: DateTime!
    collectedAt: DateTime!
    description: String
    events: [Event!]!
    primaryOf: [Event!]!
  }
`;
