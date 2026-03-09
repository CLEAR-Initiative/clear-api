import { gql } from "graphql-tag";

export const queryTypeDef = gql`
  type Query {
    """Returns the currently authenticated user, or null if not signed in."""
    me: User

    """List all users."""
    users: [User!]!

    """Look up a user by ID."""
    user(id: String!): User

    """List alerts, optionally filtered by status."""
    alerts(status: AlertStatus): [Alert!]!

    """Look up an alert by ID."""
    alert(id: String!): Alert

    """List detections, optionally filtered by status."""
    detections(status: DetectionStatus): [Detection!]!

    """Look up a detection by ID."""
    detection(id: String!): Detection

    """List all signals."""
    signals: [Signal!]!

    """Look up a signal by ID."""
    signal(id: String!): Signal

    """List all events."""
    events: [Event!]!

    """Look up an event by ID."""
    event(id: String!): Event

    """List all data sources."""
    dataSources: [DataSource!]!

    """Look up a data source by ID."""
    dataSource(id: String!): DataSource

    """List locations, optionally filtered by hierarchy level (0 = country, 1 = state, etc.)."""
    locations(level: Int): [Location!]!

    """Look up a location by ID."""
    location(id: String!): Location

    """List notifications, optionally filtered by status."""
    notifications(status: NotificationStatus): [Notification!]!

    """Look up a notification by ID."""
    notification(id: String!): Notification

    """List all feature flags."""
    featureFlags: [FeatureFlag!]!

    """Look up a feature flag by its unique key."""
    featureFlag(key: String!): FeatureFlag

    """List all API keys belonging to the authenticated user. Requires authentication."""
    myApiKeys: [ApiKey!]!
  }
`;
