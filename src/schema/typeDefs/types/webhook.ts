import { gql } from "graphql-tag";

export const webhookTypeDef = gql`
  """
  Outbound webhook subscription. Every incoming GlitchTip alert is
  fanned out to every active subscription whose event-type filter
  matches. Managed by platform admins.
  """
  type WebhookSubscription {
    id: String!
    """Which trigger feeds this subscription: "glitchtip" (platform-admin
    GlitchTip alerts) or "clear_alert" (team-managed alert webhooks)."""
    source: String!
    """Owning team for a clear_alert subscription; null for platform-level
    glitchtip subscriptions."""
    teamId: String
    """(clear_alert) Glide-code allowlist on the alert's event types.
    Empty = all types within the team's location scope."""
    alertTypeFilter: [String!]!
    """(clear_alert) Minimum alert severity (1-5). Null = all severities
    (including null-severity alerts). A set floor excludes null-severity alerts."""
    minSeverity: Int
    """Human-readable label shown in the admin UI. Not sent downstream."""
    name: String!
    """Target URL that receives HMAC-signed POST requests."""
    targetUrl: String!
    """HMAC-SHA256 shared secret used to sign outbound requests.
    Only returned on create + rotate; null on all other reads to keep
    the secret out of admin browser DevTools tabs. Rotate via
    rotateWebhookSubscriptionSecret."""
    secret: String
    """Paused subscriptions are skipped during fan-out. Deliveries do
    NOT resume automatically when re-enabled — only new events fan out."""
    active: Boolean!
    """Event-type allowlist. Empty = fire on all events.
    Values match GlitchTip's 'alias' field (e.g. issue.new, issue.regression, issue.resolved)."""
    eventTypeFilter: [String!]!
    """User ID that created this subscription. Kept for audit."""
    createdBy: String
    createdAt: DateTime!
    updatedAt: DateTime!

    """Most-recent delivery attempts for this subscription. Ordered newest first.
    Capped at 50 in the resolver to keep the admin UI fast."""
    recentDeliveries: [WebhookDelivery!]!
  }

  """
  A single delivery attempt-sequence to one subscription for one
  incoming event. attemptNumber advances in place across retries.
  """
  type WebhookDelivery {
    id: String!
    subscriptionId: String!
    """GlitchTip's event/issue ID. Useful for correlating a delivery
    back to the source issue in GlitchTip."""
    eventId: String!
    """Event type extracted from the source payload (e.g. issue.new)."""
    eventType: String!
    """1-indexed. 1 = first attempt; up to 5 for retries."""
    attemptNumber: Int!
    """Last response HTTP status code, if the target responded."""
    responseStatus: Int
    """Truncated response body (max 8 KiB)."""
    responseBody: String
    """Network or transport error message, if the request never got a response."""
    error: String
    """Non-null once a 2xx was received. Terminal state."""
    succeededAt: DateTime
    """Scheduled time of the next retry. Null when there is no next attempt
    (either succeeded, or exhausted 5 attempts = dead-lettered)."""
    nextRetryAt: DateTime
    createdAt: DateTime!

    """One of: pending, succeeded, retrying, dead. Derived from the fields
    above so the admin UI doesn't need to reimplement the logic."""
    status: WebhookDeliveryStatus!
  }

  enum WebhookDeliveryStatus {
    """Waiting for the first attempt (rare — the receive route usually attempts inline)."""
    pending
    """Delivered — target returned 2xx on some attempt."""
    succeeded
    """Failed at least once; a retry is scheduled."""
    retrying
    """Exhausted all retry attempts. Admin can manually re-fire."""
    dead
  }

  """Input for creating a new webhook subscription. The secret is
  generated server-side (openssl rand -hex 32 equivalent) and returned
  once on create."""
  input CreateWebhookSubscriptionInput {
    name: String!
    targetUrl: String!
    """Empty array = fire on all events. Otherwise, only fire when the
    source payload's event type matches one of these values."""
    eventTypeFilter: [String!]
    """Whether the subscription starts active. Defaults to true."""
    active: Boolean
  }

  """Input for updating an existing subscription. All fields are
  optional — provide only what you want to change."""
  input UpdateWebhookSubscriptionInput {
    name: String
    targetUrl: String
    eventTypeFilter: [String!]
    active: Boolean
  }

  """Input for creating a team-scoped clear_alert webhook. The secret is
  generated server-side (openssl rand -hex 32 equivalent) and returned once
  on create."""
  input CreateAlertWebhookInput {
    """Owning team. The caller must be a team admin of this team, an org
    admin of its organisation, or a platform admin."""
    teamId: String!
    name: String!
    targetUrl: String!
    """Optional glide-code allowlist. Empty / omitted = all event types."""
    alertTypeFilter: [String!]
    """Optional minimum alert severity (1-5). Omitted = all severities."""
    minSeverity: Int
  }

  """Input for updating a clear_alert webhook. All fields optional —
  provide only what you want to change."""
  input UpdateAlertWebhookInput {
    name: String
    targetUrl: String
    alertTypeFilter: [String!]
    minSeverity: Int
    active: Boolean
  }
`;
