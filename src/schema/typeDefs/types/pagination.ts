import { gql } from "graphql-tag";

/**
 * Shared pagination, filter, and stats typedefs used by the paginated list
 * queries (alertsPage / eventsPage / signalsPage) and the cross-entity
 * entityStats query.
 *
 * The simple list queries (\`alerts\`, \`events\`, \`signals\`) stay intact;
 * callers that need pagination opt into the *Page variants.
 */
export const paginationTypeDef = gql`
  # ─── Order directions ───────────────────────────────────────────────────
  enum AlertOrderBy {
    """Newest first by event.firstSignalCreatedAt."""
    CREATED_DESC
    """Oldest first by event.firstSignalCreatedAt."""
    CREATED_ASC
    """Highest event severity first."""
    SEVERITY_DESC
    """Lowest event severity first."""
    SEVERITY_ASC
  }

  enum EventOrderBy {
    """Newest signal first (lastSignalCreatedAt)."""
    LAST_SIGNAL_DESC
    """Oldest signal first (lastSignalCreatedAt)."""
    LAST_SIGNAL_ASC
    """Newest first by firstSignalCreatedAt."""
    CREATED_DESC
    """Oldest first by firstSignalCreatedAt."""
    CREATED_ASC
    SEVERITY_DESC
    SEVERITY_ASC
  }

  enum SignalOrderBy {
    """Newest first by publishedAt."""
    PUBLISHED_DESC
    """Oldest first by publishedAt."""
    PUBLISHED_ASC
    SEVERITY_DESC
    SEVERITY_ASC
  }

  # ─── Page wrappers ──────────────────────────────────────────────────────
  type AlertsPage {
    items: [Alert!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  type EventsPage {
    items: [Event!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  type SignalsPage {
    items: [Signal!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  # ─── Filter inputs ──────────────────────────────────────────────────────
  input AlertsPageInput {
    """Page size — clamped to [1, 100]. Default 25."""
    limit: Int
    """Zero-based row offset. Default 0."""
    offset: Int
    orderBy: AlertOrderBy

    status: AlertStatus
    """Apply a team's location-scope filter to the underlying events."""
    teamId: String
    """Restrict to alerts whose event sits under this location (or any of
    its descendants)."""
    locationId: String
    """Glide codes — alert event must contain at least one of these in its
    \`types\` array. Case-sensitive."""
    eventTypes: [String!]
    """Inclusive lower bound on event severity (1-5)."""
    severityMin: Int
    """Inclusive upper bound on event severity (1-5)."""
    severityMax: Int
    """Filter on event.firstSignalCreatedAt — inclusive."""
    from: DateTime
    """Filter on event.firstSignalCreatedAt — inclusive."""
    to: DateTime
    """Hide isDummy events when false (default)."""
    includeDummy: Boolean
  }

  input EventsPageInput {
    limit: Int
    offset: Int
    orderBy: EventOrderBy

    teamId: String
    locationId: String
    eventTypes: [String!]
    severityMin: Int
    severityMax: Int
    """Filter on event.firstSignalCreatedAt — inclusive."""
    from: DateTime
    to: DateTime
    includeDummy: Boolean
  }

  input SignalsPageInput {
    limit: Int
    offset: Int
    orderBy: SignalOrderBy

    teamId: String
    locationId: String
    """Restrict to signals whose source name is in this list (e.g. ["acled","dataminr"])."""
    sourceNames: [String!]
    severityMin: Int
    severityMax: Int
    """Filter on signal.publishedAt — inclusive."""
    from: DateTime
    to: DateTime
    includeDummy: Boolean
  }

  # ─── Stats ──────────────────────────────────────────────────────────────
  enum EntityKind {
    signal
    event
    alert
  }

  enum StatsGroupBy {
    """Single bucket — just \`total\`. Use this for "how many X" queries."""
    none
    """Group by event/signal type (event.types[] is unnested; signals use
    their source name as the type proxy)."""
    type
    """Group by integer severity (1-5)."""
    severity
    """Group by day / week / month of the entity's primary timestamp.
    Buckets are returned with ISO-8601 keys (\`YYYY-MM-DD\`, \`YYYY-Www\`,
    \`YYYY-MM\`)."""
    day
    week
    month
  }

  input EntityStatsInput {
    entity: EntityKind!
    groupBy: StatsGroupBy
    teamId: String
    locationId: String
    eventTypes: [String!]
    severityMin: Int
    severityMax: Int
    from: DateTime
    to: DateTime
    includeDummy: Boolean
  }

  type StatsBucket {
    """Bucket label — depends on groupBy: glide code, severity number as
    string, or ISO date/week/month."""
    key: String!
    count: Int!
  }

  type EntityStats {
    """Total matching the filter, regardless of groupBy."""
    total: Int!
    """Buckets when groupBy != none. Empty when groupBy = none."""
    buckets: [StatsBucket!]!
  }
`;
