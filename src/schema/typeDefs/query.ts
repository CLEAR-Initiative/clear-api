import { gql } from "graphql-tag";

export const queryTypeDef = gql`
  type Query {
    """Returns the currently authenticated user, or null if not signed in."""
    me: User

    """List all users."""
    users: [User!]!

    """Look up a user by ID."""
    user(id: String!): User

    """List alerts, optionally filtered by status. Pass teamId to scope by team locations."""
    alerts(status: AlertStatus, teamId: String): [Alert!]!

    """Look up an alert by ID."""
    alert(id: String!): Alert

    """List signals. Pass teamId to scope by team locations."""
    signals(teamId: String): [Signal!]!

    """Look up a signal by ID."""
    signal(id: String!): Signal

    """List events. Pass teamId to scope by team locations."""
    events(teamId: String): [Event!]!

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

    """List all disaster type classifications."""
    disasterTypes: [DisasterType!]!

    """Look up a disaster type by ID."""
    disasterType(id: String!): DisasterType

    """List all API keys belonging to the authenticated user. Requires authentication."""
    myApiKeys: [ApiKey!]!

    # ─── Organisations & Teams ─────────────────────────────────────────────────
    """List organisations the authenticated user belongs to."""
    myOrganisations: [Organisation!]!

    """Look up an organisation by ID. Requires membership or global admin."""
    organisation(id: String!): Organisation

    """List teams the authenticated user belongs to."""
    myTeams: [Team!]!

    """Look up a team by ID. Requires membership or global admin."""
    team(id: String!): Team
  }
`;
