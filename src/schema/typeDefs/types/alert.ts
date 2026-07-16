import { gql } from "graphql-tag";

export const alertTypeDef = gql`
  """Publication status of an alert."""
  enum AlertStatus {
    draft
    published
    archived
  }

  """Result of the archiveStaleAlerts bulk mutation."""
  type ArchiveStaleAlertsResult {
    alertsArchived: Int!
  }

  """An alert created from an event, distributed to subscribed users."""
  type Alert {
    id: String!
    """The event this alert was created from."""
    event: Event!
    """Location of the alert's event's FIRST signal — the same point as
    \`event.representativePoint\`, surfaced directly on the alert so a
    marker can be placed without walking into the event. Null when the
    first signal has no located point. Requires any authenticated
    content reader."""
    representativePoint: Location
    status: AlertStatus!
    """When the alert row was first created."""
    createdAt: DateTime!
    """Last time the alert row was updated (e.g. status transition)."""
    updatedAt: DateTime!
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

  """Tracks a user escalating an event, optionally to a crisis."""
  type EventEscalation {
    id: String!
    user: User!
    event: Event!
    """Whether this has been escalated to a crisis."""
    isCrisis: Boolean!
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
    """Minimum event severity (1-5) to notify on. Alerts with event.severity < minSeverity are suppressed for this user."""
    minSeverity: Int!
    channel: Channel!
    frequency: Frequency!
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
