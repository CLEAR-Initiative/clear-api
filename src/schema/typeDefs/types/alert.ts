import { gql } from "graphql-tag";

export const alertTypeDef = gql`
  """Publication status of an alert."""
  enum AlertStatus {
    draft
    published
    archived
  }

  """An environmental alert with severity, geographic scope, and linked detections."""
  type Alert {
    id: String!
    title: String!
    description: String!
    """Severity from 1 (low) to 5 (critical)."""
    severity: Int!
    status: AlertStatus!
    """The user who created this alert."""
    createdBy: User
    """The primary event that triggered this alert."""
    primaryEvent: Event
    """Arbitrary metadata as JSON."""
    metadata: JSON
    """All events linked to this alert."""
    events: [Event!]!
    """Geographic locations affected by this alert."""
    locations: [AlertLocation!]!
    """User feedback and ratings for this alert."""
    feedback: [UserAlert!]!
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
