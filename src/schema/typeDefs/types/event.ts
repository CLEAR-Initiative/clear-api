import { gql } from "graphql-tag";

export const eventTypeDef = gql`
  """An event grouping related signals into a coherent situation."""
  type Event {
    id: String!
    signals: [Signal!]!
    primarySignal: Signal
    firstSignalCreatedAt: DateTime!
    lastSignalCreatedAt: DateTime!
    status: AlertStatus!
    severity: Int!
    description: String
    eventType: String!
    populationAffected: String
    rank: Float!
    isAlert: Boolean!
    metadata: JSON
    """Geographic locations affected by this event."""
    locations: [AlertLocation!]!
    """User feedback and ratings."""
    feedback: [UserAlert!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
