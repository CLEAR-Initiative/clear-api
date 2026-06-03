import { gql } from "graphql-tag";

/**
 * GraphQL surface for the analytics / audit log written by
 * `logActivity()`. All queries here are admin-only — see the resolver.
 */
export const activityLogTypeDef = gql`
  """A single user-initiated action recorded for analytics."""
  type ActivityLog {
    id: String!
    user: User!
    """Namespaced action verb — e.g. 'auth.login', 'signal.create_manual',
    'event.create', 'alert.create', 'crisis.create', 'feedback.create'."""
    action: String!
    """Coarse resource bucket — 'signal' / 'event' / 'alert' / 'crisis' /
    'feedback' / 'session'."""
    resourceType: String
    """The created/affected row's id. Null for actions like login."""
    resourceId: String
    """Per-action context (title, severity, etc.). Shape varies by action."""
    metadata: JSON
    ipAddress: String
    userAgent: String
    createdAt: DateTime!
  }

  """Aggregate counts and time-series for the admin dashboard."""
  type ActivityStats {
    """Window the stats cover, in ISO-8601. Mirrored back to the client so
    a paginated dashboard can know what range its numbers are based on."""
    from: DateTime!
    to: DateTime!
    """Total event counts across the window, keyed by action."""
    totals: ActivityCountsByAction!
    """Per-user breakdown, ordered by total activity (desc), limited to
    the top 50 most-active users in the window."""
    byUser: [UserActivitySummary!]!
    """Daily activity counts across the window (UTC dates)."""
    byDay: [DailyActivityCount!]!
  }

  type ActivityCountsByAction {
    login: Int!
    signalCreateManual: Int!
    eventCreate: Int!
    alertCreate: Int!
    crisisCreate: Int!
    feedbackCreate: Int!
    total: Int!
  }

  type UserActivitySummary {
    user: User!
    total: Int!
    counts: ActivityCountsByAction!
  }

  type DailyActivityCount {
    """YYYY-MM-DD in UTC."""
    date: String!
    total: Int!
    counts: ActivityCountsByAction!
  }

  """Filter for the paginated activityLogs query."""
  input ActivityLogFilterInput {
    userId: String
    """Action prefix match — e.g. 'crisis.' returns all crisis-related rows."""
    actionPrefix: String
    """Exact action match."""
    action: String
    """Coarse resource bucket — 'signal' / 'event' / 'alert' / 'crisis' /
    'feedback' / 'session'."""
    resourceType: String
    from: DateTime
    to: DateTime
  }
`;
