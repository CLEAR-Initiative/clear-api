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

    """Update an existing alert subscription (channel, frequency, active)."""
    updateAlertSubscription(id: String!, input: UpdateAlertSubscriptionInput!): AlertSubscription!

    """Unsubscribe — deletes the subscription."""
    unsubscribeFromAlerts(id: String!): Boolean!
  }

  # ─── Input Types ───────────────────────────────────────────────────────────

  input SubscribeToAlertsInput {
    locationId: String!
    """Disaster/event type (glideNumber from disaster_types, e.g. 'fl', 'eq')."""
    alertType: String!
    channel: Channel!
    frequency: Frequency!
  }

  input UpdateAlertSubscriptionInput {
    channel: Channel
    frequency: Frequency
    active: Boolean
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
    populationAffected: String
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
    """Provide exactly one of eventId or signalId."""
    eventId: String
    signalId: String
    """Rating from 1 to 5."""
    rating: Int!
    """Optional textual feedback."""
    text: String
  }

  input AddCommentInput {
    """Provide exactly one of eventId or signalId."""
    eventId: String
    signalId: String
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
`;
