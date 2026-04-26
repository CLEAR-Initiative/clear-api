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

    """Archive published alerts whose event.lastSignalCreatedAt is older than
    olderThanDays (default: 14). Sets alerts.status to 'archived'. Admin or
    pipeline only. Returns the number of rows affected."""
    archiveStaleAlerts(olderThanDays: Int): ArchiveStaleAlertsResult!

    # ─── Signals ───────────────────────────────────────────────────────────────
    """Create a signal from a data source."""
    createSignal(input: CreateSignalInput!): Signal!

    """Create a manual signal from a field officer, partner, or government source.
    Persists the signal and sends it to the pipeline for event grouping and auto-escalation."""
    createManualSignal(input: CreateManualSignalInput!): Signal!

    """Update a signal's severity score."""
    updateSignalSeverity(id: String!, severity: Int!): Signal!

    """Delete a signal."""
    deleteSignal(id: String!): Boolean!

    # ─── Events ────────────────────────────────────────────────────────────────
    """Create a new event from signals."""
    createEvent(input: CreateEventInput!): Event!

    """Update an existing event."""
    updateEvent(id: String!, input: UpdateEventInput!): Event!

    """Delete an event."""
    deleteEvent(id: String!): Boolean!

    """Escalate an event: creates an alert (published) and records the user escalation.
    If the event already has a published alert, just records the user escalation."""
    escalateEvent(eventId: String!, userId: String!): EventEscalation!

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

    """Replace a location's geometry with the given GeoJSON (admin/pipeline only)."""
    updateLocationGeometry(id: String!, geometry: GeoJSON!): Location!

    """Set a location's cached population (admin/pipeline only)."""
    updateLocationPopulation(id: String!, population: String!): Location!

    """Set a situation's populationAffected + populationInArea (admin/pipeline only)."""
    updateSituationPopulation(id: String!, input: UpdateSituationPopulationInput!): Situation!

    """Create or update a location's metadata entry for a given type (admin/pipeline only).
    Upsert keyed by (locationId, type)."""
    upsertLocationMetadata(input: UpsertLocationMetadataInput!): LocationMetadata!

    """Bulk-upsert multiple (locationId, type, data) rows in a single call (admin/pipeline only).
    Returns the resulting rows. Rows whose locationId doesn't exist are skipped silently."""
    upsertLocationMetadataBatch(inputs: [UpsertLocationMetadataInput!]!): [LocationMetadata!]!

    """Delete a location's metadata entry for a given type (admin only)."""
    deleteLocationMetadata(locationId: String!, type: String!): Boolean!

    # ─── Notifications ─────────────────────────────────────────────────────────
    """Create a notification for a user."""
    createNotification(input: CreateNotificationInput!): Notification!

    """Create notifications for multiple users at once. Returns the count of notifications created."""
    createBulkNotifications(input: CreateBulkNotificationsInput!): Int!

    """Notify all subscribers of a single alert (immediate frequency). Matches on event types and locations."""
    notifyAlertSubscribers(input: AlertNotifyInput!): Int!

    """Send a digest notification for multiple alerts to subscribers of the given frequency (daily/weekly/monthly)."""
    notifyAlertDigest(input: AlertDigestInput!): Int!

    """Delete a notification."""
    deleteNotification(id: String!): Boolean!

    """Mark a notification as read."""
    markNotificationRead(id: String!): Notification!

    """Mark all notifications as read for the authenticated user."""
    markAllNotificationsRead: Boolean!

    # ─── Feedback ──────────────────────────────────────────────────────────────
    """Add feedback (rating + optional text) to a signal or event."""
    addFeedback(input: AddFeedbackInput!): UserFeedback!

    """Delete your own feedback."""
    deleteFeedback(id: String!): Boolean!

    # ─── Comments ─────────────────────────────────────────────────────────────
    """Add a comment to a signal or event."""
    addComment(input: AddCommentInput!): UserComment!

    """Reply to an existing comment."""
    replyToComment(input: ReplyToCommentInput!): UserComment!

    """Delete your own comment."""
    deleteComment(id: String!): Boolean!

    """Tag users in a comment."""
    tagUsersInComment(commentId: String!, userIds: [String!]!): UserComment!

    # ─── Organisations ─────────────────────────────────────────────────────────
    """Create a new organisation. The creator becomes the owner."""
    createOrganisation(input: CreateOrganisationInput!): Organisation!

    """Update an existing organisation. Requires org owner or admin."""
    updateOrganisation(id: String!, input: UpdateOrganisationInput!): Organisation!

    """Add a member to an organisation."""
    addOrgMember(orgId: String!, userId: String!, role: OrgMemberRole): OrgMember!

    """Remove a member from an organisation."""
    removeOrgMember(orgId: String!, userId: String!): Boolean!

    """Delete an organisation and all its teams, members, and invitations. Requires global admin."""
    deleteOrganisation(id: String!): Boolean!

    # ─── Teams ─────────────────────────────────────────────────────────────────
    """Create a new team within an organisation. Requires org admin or owner."""
    createTeam(input: CreateTeamInput!): Team!

    """Update an existing team."""
    updateTeam(id: String!, input: UpdateTeamInput!): Team!

    """Delete a team."""
    deleteTeam(id: String!): Boolean!

    """Add a member to a team."""
    addTeamMember(teamId: String!, userId: String!, role: TeamMemberRole): TeamMember!

    """Remove a member from a team."""
    removeTeamMember(teamId: String!, userId: String!): Boolean!

    """Update a team member's role."""
    updateTeamMemberRole(teamId: String!, userId: String!, role: TeamMemberRole!): TeamMember!

    """Set the locations a team is scoped to. Replaces all existing locations."""
    setTeamLocations(teamId: String!, locationIds: [String!]!): Team!

    """Set the authenticated user's default team (for frontend convenience)."""
    setDefaultTeam(teamId: String!): Team!

    # ─── Invitations ──────────────────────────────────────────────────────────
    """Invite a user to an organisation (and optionally a team). Sends invite email."""
    inviteUser(input: InviteUserInput!): Invitation!

    """Accept an invitation. Creates user account if new, adds to org and team."""
    acceptInvite(input: AcceptInviteInput!): Boolean!

    """Cancel a pending invitation."""
    cancelInvite(id: String!): Boolean!

    """Resend an invitation email (resets expiry to 7 days)."""
    resendInvite(id: String!): Invitation!

    # ─── Password Reset ──────────────────────────────────────────────────────
    """Request a password reset email (public, always returns true)."""
    requestPasswordReset(email: String!): Boolean!

    """Reset password using a token from the reset email."""
    resetPassword(token: String!, newPassword: String!): Boolean!

    # ─── Alert Subscriptions ──────────────────────────────────────────────────
    """Subscribe to alerts for a specific type and location."""
    subscribeToAlerts(input: SubscribeToAlertsInput!): AlertSubscription!

    """Subscribe to alerts for multiple (location × alertType) combinations in a single call.
    Returns the list of created subscriptions. Duplicates are skipped silently."""
    subscribeToAlertsBatch(input: SubscribeToAlertsBatchInput!): [AlertSubscription!]!

    """Update an existing alert subscription (channel, frequency, active)."""
    updateAlertSubscription(id: String!, input: UpdateAlertSubscriptionInput!): AlertSubscription!

    """Unsubscribe — deletes the subscription."""
    unsubscribeFromAlerts(id: String!): Boolean!

    # ─── Situations ────────────────────────────────────────────────────────────
    """Create a new situation from a list of event IDs. Links all provided events to the new situation."""
    createSituationFromEvents(input: CreateSituationFromEventsInput!): Situation!

    """Add an existing event to an existing situation. Idempotent — returns the existing link if one already exists."""
    addEventToSituation(situationId: String!, eventId: String!): EventSituation!
  }

  # ─── Input Types ───────────────────────────────────────────────────────────

  input SubscribeToAlertsInput {
    locationId: String!
    """Disaster/event type (glideNumber from disaster_types, e.g. 'fl', 'eq')."""
    alertType: String!
    channel: Channel!
    frequency: Frequency!
    """Minimum event severity (1-5) to notify on. Defaults to 1 (all alerts)."""
    minSeverity: Int
  }

  input SubscribeToAlertsBatchInput {
    """One or more location IDs."""
    locationIds: [String!]!
    """One or more disaster/event types (glideNumbers). A subscription is created for every (location × alertType) pair."""
    alertTypes: [String!]!
    channel: Channel!
    frequency: Frequency!
    """Minimum event severity (1-5). Applied to all created subscriptions."""
    minSeverity: Int
  }

  input UpdateAlertSubscriptionInput {
    channel: Channel
    frequency: Frequency
    active: Boolean
    """Minimum event severity (1-5)."""
    minSeverity: Int
  }

  input InviteUserInput {
    email: String!
    organisationId: String!
    teamId: String
    """Organisation role: owner, admin, member (default: member)."""
    role: String
    """Team role: lead, analyst, viewer (default: viewer). Only used if teamId is provided."""
    teamRole: String
  }

  input AcceptInviteInput {
    token: String!
    name: String!
    password: String!
  }

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

  input CreateManualSignalInput {
    """Data source ID (must be field_officer, partner, or government type)."""
    sourceId: String!
    title: String!
    description: String!
    """Severity score (1–5)."""
    severity: Int
    """URL or reference link."""
    url: String
    """Media URLs (pre-uploaded via /api/upload endpoint)."""
    mediaUrls: [String!]
    """Media files (direct upload via graphql-upload, alternative to mediaUrls)."""
    media: [Upload!]
    locationId: String
    originId: String
    destinationId: String
    """Latitude for automatic geo-resolution."""
    lat: Float
    """Longitude for automatic geo-resolution."""
    lng: Float
  }

  input CreateSignalInput {
    sourceId: String!
    """Stable upstream identifier for idempotent ingestion. If a signal with
    the same (sourceId, externalId) already exists, createSignal returns the
    existing row instead of creating a duplicate. Recommended prefix scheme:
    "dataminr:{alertId}", "gdacs:{eventid}", "acled:{event_id_cnty}"."""
    externalId: String
    rawData: JSON!
    publishedAt: String!
    collectedAt: String
    url: String
    title: String
    description: String
    """Severity score (1–5). From data source or estimated by pipeline."""
    severity: Int
    """Media URLs (source URLs for images, videos, etc.)."""
    media: [String!]
    originId: String
    destinationId: String
    locationId: String
    """Latitude for automatic geo-resolution (resolves to nearest location in hierarchy)."""
    lat: Float
    """Longitude for automatic geo-resolution."""
    lng: Float
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
    """Severity score (1–5). Aggregated from signal severities."""
    severity: Int
    populationAffected: String
    """Estimated population displaced (BigInt as string)."""
    populationDisplaced: String
    rank: Float!
    """Latitude for automatic geo-resolution (resolves to nearest location in hierarchy)."""
    lat: Float
    """Longitude for automatic geo-resolution."""
    lng: Float
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
    severity: Int
    populationAffected: String
    """Estimated population displaced (BigInt as string)."""
    populationDisplaced: String
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

  input CreateBulkNotificationsInput {
    """List of user IDs to notify."""
    userIds: [String!]!
    message: String!
    notificationType: String!
    actionUrl: String
    actionText: String
  }

  input AlertNotifyInput {
    """Alert ID to notify subscribers about (uses immediate frequency)."""
    alertId: String!
  }

  input AlertDigestInput {
    """List of alert IDs to include in the digest."""
    alertIds: [String!]!
    """Frequency: daily, weekly, or monthly."""
    frequency: String!
  }

  input AddFeedbackInput {
    """Provide exactly one of eventId, signalId, or situationId."""
    eventId: String
    signalId: String
    situationId: String
    """Rating from 1 to 5."""
    rating: Int!
    """Optional textual feedback."""
    text: String
  }

  input AddCommentInput {
    """Provide exactly one of eventId, signalId, or situationId."""
    eventId: String
    signalId: String
    situationId: String
    comment: String!
    """User IDs to tag in the comment."""
    tagUserIds: [String!]
  }

  input ReplyToCommentInput {
    """ID of the comment to reply to."""
    repliedToCommentId: String!
    comment: String!
    """User IDs to tag in the reply."""
    tagUserIds: [String!]
  }

  input UpdateSituationPopulationInput {
    """Population directly affected by the events (BigInt as string)."""
    populationAffected: String
    """Total population residing within the event admin areas (BigInt as string)."""
    populationInArea: String
    """AI-generated situation title."""
    title: String
    """AI-generated situation summary."""
    summary: String
  }
`;
