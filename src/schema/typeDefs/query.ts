import { gql } from "graphql-tag";

export const queryTypeDef = gql`
  type Query {
    """Returns the currently authenticated user, or null if not signed in."""
    me: User

    """List all users."""
    users: [User!]!

    """Look up a user by ID."""
    user(id: String!): User

    """List alerts. Requires authentication. Admins may omit teamId to list all; non-admins must provide a teamId for a team they belong to."""
    alerts(status: AlertStatus, teamId: String, includeDummy: Boolean): [Alert!]!

    """Look up an alert by ID. Requires authentication. Non-admins can only access alerts within their team scope."""
    alert(id: String!): Alert

    """List signals. Requires authentication. includeDummy defaults to false."""
    signals(teamId: String, includeDummy: Boolean): [Signal!]!

    """Look up a signal by ID. Requires authentication. Non-admins can only access signals within their team scope."""
    signal(id: String!): Signal

    """List signals by location. Returns all signals whose origin, destination, or general location is within the given location (including descendants)."""
    signalsByLocation(locationId: String!): [Signal!]!

    """List events. Requires authentication. includeDummy defaults to false."""
    events(teamId: String, includeDummy: Boolean): [Event!]!

    """Look up an event by ID. Requires authentication. Non-admins can only access events within their team scope."""
    event(id: String!): Event

    """List events by location. Returns all events whose origin, destination, or general location is within the given location (including descendants)."""
    eventsByLocation(locationId: String!): [Event!]!

    """List alerts by location. Returns all alerts whose event's location is within the given location (including descendants)."""
    alertsByLocation(locationId: String!, status: AlertStatus): [Alert!]!

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

    # ─── Invitations ──────────────────────────────────────────────────────────
    """List pending invitations for an organisation. Requires org admin."""
    pendingInvites(organisationId: String!): [Invitation!]!

    """Look up an invitation by token (public — used on accept-invite page)."""
    invitationByToken(token: String!): InvitationInfo

    # ─── Alert Subscriptions ────────────────────────────────────────────────
    """List the authenticated user's alert subscriptions."""
    myAlertSubscriptions: [AlertSubscription!]!

    """List all alert subscriptions for a location (admin only)."""
    alertSubscriptionsByLocation(locationId: String!): [AlertSubscription!]!
  }
`;
