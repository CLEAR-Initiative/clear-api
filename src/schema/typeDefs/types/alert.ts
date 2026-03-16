import { gql } from "graphql-tag";

export const alertTypeDef = gql`
  """Publication status of an alert."""
  enum AlertStatus {
    draft
    published
    archived
  }

  """An alert created from an event, distributed to subscribed users."""
  type Alert {
    id: String!
    """The event this alert was created from."""
    event: Event!
    status: AlertStatus!
    """Users who received this alert."""
    userAlerts: [UserAlert!]!
    """Users who escalated this alert."""
    escalations: [EventEscalation!]!
  }

  """Tracks an alert delivered to a user — view status."""
  type UserAlert {
    id: String!
    user: User!
    alert: Alert!
    """When the user viewed this alert."""
    viewedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """Tracks a user escalating an event/alert, optionally to a situation."""
  type EventEscalation {
    id: String!
    user: User!
    alert: Alert!
    """Whether this has been escalated to a situation."""
    isSituation: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
