import { gql } from "graphql-tag";

export const alertTypeDef = gql`
  """Publication status of an alert."""
  enum AlertStatus {
    draft
    published
    archived
  }

  """An alert (an event with isAlert=true) with severity, geographic scope, and linked signals."""
  type Alert {
    id: String!
    description: String
    """Severity from 1 (low) to 5 (critical)."""
    severity: Int!
    status: AlertStatus!
    eventType: String!
    rank: Float!
    populationAffected: String
    isAlert: Boolean!
    """Arbitrary metadata as JSON."""
    metadata: JSON
    """The primary signal that triggered this alert."""
    primarySignal: Signal
    """All signals linked to this alert."""
    signals: [Signal!]!
    """Geographic locations affected by this alert."""
    locations: [AlertLocation!]!
    """User feedback and ratings for this alert."""
    feedback: [UserAlert!]!
    firstSignalCreatedAt: DateTime!
    lastSignalCreatedAt: DateTime!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A user's feedback on an alert — read status, rating, and comments."""
  type UserAlert {
    id: String!
    user: User!
    alert: Alert!
    """When the user marked this alert as read."""
    readAt: DateTime
    """User rating (1-5)."""
    rating: Int
    comment: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
