import { gql } from "graphql-tag";

export const mutationTypeDef = gql`
  type Mutation {
    # ─── API Keys ──────────────────────────────────────────────────────────────
    """Create a new API key for the authenticated user."""
    createApiKey(input: CreateApiKeyInput!): CreateApiKeyPayload!

    """Revoke an API key by ID. Only the key owner or an admin can revoke."""
    revokeApiKey(id: String!): ApiKey!

    # ─── Auth ──────────────────────────────────────────────────────────────────
    """Request an email verification link for the authenticated user."""
    requestEmailVerification: Boolean!

    """Verify email using a token from the verification link."""
    verifyEmail(token: String!): Boolean!

    # ─── User ──────────────────────────────────────────────────────────────────
    """Update the authenticated user's profile and notification preferences."""
    updateProfile(input: UpdateProfileInput!): User!

    # ─── Alerts ────────────────────────────────────────────────────────────────
    """Create an alert from an event, notifying subscribers."""
    createAlert(input: CreateAlertInput!): Alert!

    """Update an existing alert."""
    updateAlert(id: String!, input: UpdateAlertInput!): Alert!

    """Delete an alert."""
    deleteAlert(id: String!): Boolean!

    # ─── Signals ───────────────────────────────────────────────────────────────
    """Create a signal from a data source."""
    createSignal(input: CreateSignalInput!): Signal!

    """Delete a signal."""
    deleteSignal(id: String!): Boolean!

    # ─── Events ────────────────────────────────────────────────────────────────
    """Create a new event from signals."""
    createEvent(input: CreateEventInput!): Event!

    """Update an existing event."""
    updateEvent(id: String!, input: UpdateEventInput!): Event!

    """Delete an event."""
    deleteEvent(id: String!): Boolean!

    # ─── Data Sources ──────────────────────────────────────────────────────────
    """Create a new data source."""
    createDataSource(input: CreateDataSourceInput!): DataSource!

    """Update an existing data source."""
    updateDataSource(id: String!, input: UpdateDataSourceInput!): DataSource!

    """Delete a data source."""
    deleteDataSource(id: String!): Boolean!

    # ─── Locations ─────────────────────────────────────────────────────────────
    """Create a new location."""
    createLocation(input: CreateLocationInput!): Location!

    """Update an existing location."""
    updateLocation(id: String!, input: UpdateLocationInput!): Location!

    """Delete a location."""
    deleteLocation(id: String!): Boolean!

    # ─── Notifications ─────────────────────────────────────────────────────────
    """Create a notification for a user."""
    createNotification(input: CreateNotificationInput!): Notification!

    """Delete a notification."""
    deleteNotification(id: String!): Boolean!

    """Mark a notification as read."""
    markNotificationRead(id: String!): Notification!

    """Mark all notifications as read for the authenticated user."""
    markAllNotificationsRead: Boolean!

    # ─── Organisations ─────────────────────────────────────────────────────────
    """Create a new organisation. The creator becomes the owner."""
    createOrganisation(input: CreateOrganisationInput!): Organisation!

    """Update an existing organisation. Requires org owner or admin."""
    updateOrganisation(id: String!, input: UpdateOrganisationInput!): Organisation!

    """Add a member to an organisation."""
    addOrgMember(orgId: String!, userId: String!, role: String): OrgMember!

    """Remove a member from an organisation."""
    removeOrgMember(orgId: String!, userId: String!): Boolean!

    # ─── Teams ─────────────────────────────────────────────────────────────────
    """Create a new team within an organisation. Requires org admin or owner."""
    createTeam(input: CreateTeamInput!): Team!

    """Update an existing team."""
    updateTeam(id: String!, input: UpdateTeamInput!): Team!

    """Delete a team."""
    deleteTeam(id: String!): Boolean!

    """Add a member to a team."""
    addTeamMember(teamId: String!, userId: String!, role: String): TeamMember!

    """Remove a member from a team."""
    removeTeamMember(teamId: String!, userId: String!): Boolean!

    """Update a team member's role."""
    updateTeamMemberRole(teamId: String!, userId: String!, role: String!): TeamMember!

    """Set the locations a team is scoped to. Replaces all existing locations."""
    setTeamLocations(teamId: String!, locationIds: [String!]!): Team!

    """Set the authenticated user's default team (for frontend convenience)."""
    setDefaultTeam(teamId: String!): Team!
  }

  # ─── Input Types ───────────────────────────────────────────────────────────

  input UpdateProfileInput {
    name: String
    phoneNumber: String
    image: String
    enableInAppNotification: Boolean
    enableEmailNotification: Boolean
    enableSMSNotification: Boolean
  }

  input CreateAlertInput {
    """The event ID to create an alert from."""
    eventId: String!
    status: AlertStatus
  }

  input UpdateAlertInput {
    status: AlertStatus
  }

  input CreateSignalInput {
    sourceId: String!
    rawData: JSON!
    publishedAt: String!
    collectedAt: String
    url: String
    title: String
    description: String
    originId: String
    destinationId: String
    locationId: String
  }

  input CreateEventInput {
    signalIds: [String!]!
    title: String
    description: String
    descriptionSignals: JSON
    validFrom: String!
    validTo: String!
    firstSignalCreatedAt: String!
    lastSignalCreatedAt: String!
    originId: String
    destinationId: String
    locationId: String
    types: [String!]!
    populationAffected: String
    rank: Float!
  }

  input UpdateEventInput {
    signalIds: [String!]
    title: String
    description: String
    descriptionSignals: JSON
    validFrom: String
    validTo: String
    firstSignalCreatedAt: String
    lastSignalCreatedAt: String
    originId: String
    destinationId: String
    locationId: String
    types: [String!]
    populationAffected: String
    rank: Float
  }

  input CreateDataSourceInput {
    name: String!
    type: String!
    isActive: Boolean
    baseUrl: String
    infoUrl: String
  }

  input UpdateDataSourceInput {
    name: String
    type: String
    isActive: Boolean
    baseUrl: String
    infoUrl: String
  }

  input CreateLocationInput {
    geoId: Int
    osmId: String
    pCode: String
    name: String!
    level: Int!
    parentId: String
  }

  input UpdateLocationInput {
    geoId: Int
    osmId: String
    pCode: String
    name: String
    level: Int
    parentId: String
  }

  input CreateNotificationInput {
    userId: String!
    message: String!
    notificationType: String!
    actionUrl: String
    actionText: String
  }
`;
