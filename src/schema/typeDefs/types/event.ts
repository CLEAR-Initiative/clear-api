import { gql } from "graphql-tag";

export const eventTypeDef = gql`
  """An event grouping related signals into a coherent situation."""
  type Event {
    id: String!
    title: String
    description: String
    """LLM-generated signal descriptions as JSON."""
    descriptionSignals: JSON
    validFrom: DateTime!
    validTo: DateTime!
    firstSignalCreatedAt: DateTime!
    lastSignalCreatedAt: DateTime!
    """Origin location of the event."""
    originLocation: Location
    """Destination location of the event."""
    destinationLocation: Location
    """General location (when no origin/destination)."""
    generalLocation: Location
    """Event type tags."""
    types: [String!]!
    """Estimated population affected."""
    populationAffected: String
    rank: Float!
    """Signals linked to this event."""
    signals: [Signal!]!
    """Alerts created from this event."""
    alerts: [Alert!]!
    """User feedback on this event."""
    feedbacks: [UserFeedback!]!
    """User comments on this event."""
    comments: [UserComment!]!
  }
`;
