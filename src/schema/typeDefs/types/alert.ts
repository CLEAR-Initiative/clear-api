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
  }

  """Tracks an alert delivered to a user — view status."""
  type UserAlert {
    id: String!
    user: User!
    alert: Alert!
    """When the user viewed this alert."""
    viewedAt: DateTime
  }

  """Tracks a user escalating an event, optionally to a situation."""
  type EventEscalation {
    id: String!
    user: User!
    event: Event!
    """Whether this has been escalated to a situation."""
    isSituation: Boolean!
    validFrom: DateTime!
    validTo: DateTime!
  }

  """Notification channel for alert subscriptions."""
  enum Channel {
    email
    sms
  }

  """How often a user receives alert notifications."""
  enum Frequency {
    immediately
    daily
    weekly
    monthly
  }

  """A user's subscription to alerts of a specific type at a specific location."""
  type AlertSubscription {
    id: String!
    userId: String!
    user: User!
    location: Location!
    """Disaster/event type to subscribe to (e.g. 'fl' for flood, 'eq' for earthquake)."""
    alertType: String!
    active: Boolean!
    channel: Channel!
    frequency: Frequency!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
