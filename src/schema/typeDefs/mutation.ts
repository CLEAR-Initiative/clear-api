import { gql } from "graphql-tag";

export const mutationTypeDef = gql`
  type Mutation {
    # ─── API Keys ──────────────────────────────────────────────────────────────
    """Create a new API key for the authenticated user."""
    createApiKey(input: CreateApiKeyInput!): CreateApiKeyPayload!

    """Revoke an API key by ID. Only the key owner or an admin can revoke."""
    revokeApiKey(id: String!): ApiKey!

    # ─── Public Event Share Links ──────────────────────────────────────────────
    """
    Mint a Redis-backed share token for an event. The snapshot of the
    event's safe-to-share fields is stored under a key derived from
    the eventId + token and lives for \`ttlDays\` days (default 30, max
    90). Anyone who has the resulting URL can read the snapshot via
    the \`publicEvent(eventId, token)\` query. Caller must be able to
    read the event normally (admin / analyst / viewer); pending users
    are blocked.
    """
    createPublicEventLink(input: CreatePublicEventLinkInput!): CreatePublicEventLinkResult!

    """
    Invalidate a public share token by deleting the cached snapshot.
    Idempotent — revoking a missing key returns true. Caller must be
    an approved user; ownership of the original link is not checked
    because the link is by definition unauthenticated and the only
    state to delete is the cache entry itself.
    """
    revokePublicEventLink(eventId: String!, token: String!): Boolean!

    # ─── Dev User Provisioning ─────────────────────────────────────────────────
    """
    Provision a developer account from an approved waitlist application.
    Creates the user, mints an initial API key (no expiry), issues a
    long-lived set-password verification token, and sends the welcome
    email. Requires global \`admin\`. The CRM write-back is the caller's
    responsibility.
    """
    createDevUser(input: CreateDevUserInput!): CreateDevUserResult!

    """
    Revoke every active API key for a dev user and issue a fresh one.
    Notifies the user by email. Requires global \`admin\`.
    """
    rotateDevUserApiKey(userId: String!): RotateDevUserApiKeyResult!

    """
    Approve a self-signed-up user. Flips their role from \`pending\`
    to \`viewer\` (granting read access to signals / events / alerts /
    crises) and moves their CRM contact from the prospects collection
    into the approved collection — which fires Exponential's welcome
    automation. The local role flip is authoritative; CRM updates are
    best-effort and surface as fields on the result so the admin UI
    can offer a retry. Requires global \`admin\`.
    """
    approveUser(userId: String!): ApproveUserResult!

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

    """Attach the clear-pipeline geoparser's result to an existing signal.
    Used for the manual-signal flow, where the signal is created via
    createManualSignal before the pipeline has a chance to run the geoparser.
    Stores the structured candidate verbatim; does not change locationId.
    Admin/pipeline only."""
    updateSignalGeoparsedData(id: String!, geoparsedData: JSON!): Signal!

    """Set (or replace) an existing signal's generalLocation. Used by the
    manual-signal pipeline path: when the user didn't pick a location and
    the geoparser resolved a landmark, we promote it to an L4 via
    findOrCreateLandmarkL4 and then wire the signal to it so downstream
    event grouping can key on the resolved admin-2 district instead of
    creating an isolated event. Admin/pipeline only."""
    updateSignalLocation(id: String!, locationId: String!): Signal!

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
    If the event already has a published alert, just records the user escalation.
    teamId (optional) admits a team_admin or field_coordinator on that team
    even without a global admin/analyst role — purely an authorisation hint,
    not stored on the event."""
    escalateEvent(eventId: String!, userId: String!, teamId: String): EventEscalation!

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

    """Idempotently resolve a level-0 Country location by exact name, creating it
    with a bounding-box MULTIPOLYGON geometry if absent (admin/pipeline only).
    bbox is [minLng, minLat, maxLng, maxLat]. Returns the (found or created)
    Country — doubles as the pipeline's name→id resolution."""
    ensureCountryLocation(name: String!, bbox: [Float!]!): Location!

    """Update an existing location."""
    updateLocation(id: String!, input: UpdateLocationInput!): Location!

    """Delete a location."""
    deleteLocation(id: String!): Boolean!

    """Replace a location's geometry with the given GeoJSON (admin/pipeline only)."""
    updateLocationGeometry(id: String!, geometry: GeoJSON!): Location!

    """Set a location's cached population (admin/pipeline only)."""
    updateLocationPopulation(id: String!, population: String!): Location!

    """Set a crisis's populationAffected + populationInArea (admin/pipeline only)."""
    updateCrisisPopulation(id: String!, input: UpdateCrisisPopulationInput!): Crisis!

    """Create or update a location's metadata entry for a given type (admin/pipeline only).
    Upsert keyed by (locationId, type)."""
    upsertLocationMetadata(input: UpsertLocationMetadataInput!): LocationMetadata!

    """Bulk-upsert multiple (locationId, type, data) rows in a single call (admin only).
    Returns the current row for each input. Rows whose locationId doesn't exist are
    skipped silently. Idempotent: an input whose blob is identical to the currently-open
    row is left untouched (no new history version), so re-running an ingest with unchanged
    data is a no-op."""
    upsertLocationMetadataBatch(inputs: [UpsertLocationMetadataInput!]!): [LocationMetadata!]!

    """Delete a location's metadata entry for a given type (admin only)."""
    deleteLocationMetadata(locationId: String!, type: String!): Boolean!

    """Find an existing level-4 location matching a geoparsed candidate, or
    create one. Used by the clear-pipeline geoparser to promote a landmark
    hit (e.g., "Nyala Airport") into a reusable A4 instead of letting the
    resolver invent a fresh point-location for every signal. When sourceLat
    and sourceLng are provided, the resolver verifies that the candidate's
    containing A2 matches the source coord's containing A2 — on mismatch it
    aborts with abortedReason="different_a2" so the caller can fall back to
    source coords. Admin/pipeline only."""
    findOrCreateLandmarkL4(input: FindOrCreateLandmarkL4Input!): FindOrCreateLandmarkL4Result!

    # ─── Geocoder cache ──────────────────────────────────────────────────────
    """Upsert a Nominatim geocoder cache entry (admin/pipeline only).
    Replaces any existing row with the same queryHash, resetting the TTL."""
    upsertNominatimCache(input: UpsertNominatimCacheInput!): NominatimCacheEntry!

    # ─── Feature flags ─────────────────────────────────────────────────────────
    """Set the enabled state of a feature flag, identified by its string key.
    Upserts the row so the same call works whether the key is already present.
    Admin only — toggling features is an org-wide change, not a per-user
    preference. Returns the persisted flag so callers can update local state
    without an extra round-trip."""
    setFeatureFlag(key: String!, enabled: Boolean!): FeatureFlag!

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
    """Create a new organisation. The creator becomes the first org_admin."""
    createOrganisation(input: CreateOrganisationInput!): Organisation!

    """Update an existing organisation. Requires org_admin (or platform admin)."""
    updateOrganisation(id: String!, input: UpdateOrganisationInput!): Organisation!

    """Add a member to an organisation."""
    addOrgMember(orgId: String!, userId: String!, role: OrgMemberRole): OrgMember!

    """Remove a member from an organisation."""
    removeOrgMember(orgId: String!, userId: String!): Boolean!

    """Change a member's role within an organisation. Requires the caller to be
    a platform admin or an org_admin of the target organisation."""
    updateOrgMemberRole(orgId: String!, userId: String!, role: OrgMemberRole!): OrgMember!

    """Delete an organisation and all its teams, members, and invitations. Requires global admin."""
    deleteOrganisation(id: String!): Boolean!

    # ─── Teams ─────────────────────────────────────────────────────────────────
    """Create a new team within an organisation. Requires org_admin (or platform admin)."""
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

    """Unsubscribe - deletes the subscription."""
    unsubscribeFromAlerts(id: String!): Boolean!

    # ─── Crises ────────────────────────────────────────────────────────────────
    """Create a new crisis from a list of event IDs. Links all provided events to the new crisis."""
    createCrisisFromEvents(input: CreateCrisisFromEventsInput!): Crisis!

    """Add an existing event to an existing crisis. Idempotent - returns the existing link if one already exists."""
    addEventToCrisis(crisisId: String!, eventId: String!): EventCrisis!

    """Remove an event from a crisis. Recomputes populationAffected from the
    remaining events and dispatches the enrichment task so title/summary get
    regenerated to reflect the new event set. If the event being removed is
    the LAST event, deletes the crisis entirely and returns null. Otherwise
    returns the updated crisis (title/summary still show pre-removal values
    until the async enrichment task completes)."""
    removeEventFromCrisis(crisisId: String!, eventId: String!): Crisis

    """Edit a crisis's title in place. Any authenticated user. Pass an empty
    string to clear the field."""
    updateCrisisTitle(id: String!, title: String!): Crisis!

    """Edit the human-facing description on a crisis. The crisis's summary
    column stores JSON of the form description+tldr — this mutation updates
    just the description key and preserves any existing tldr bullets (which
    the LLM enrichment task generates). Any authenticated user. Pass an
    empty string to clear the description without disturbing the tldr."""
    updateCrisisDescription(id: String!, description: String!): Crisis!

    """Delete a crisis. Cascades the eventCrises join rows, user feedback,
    and user comments via the FK constraints. Any authenticated user."""
    deleteCrisis(id: String!): Boolean!

    """Append S3 keys to a crisis's attachments list. Idempotent — keys
    already present in the list are skipped silently. Returns the updated
    crisis with the new list."""
    addCrisisAttachments(id: String!, keys: [String!]!): Crisis!

    """Remove an S3 key from a crisis's attachments list. Does NOT delete
    the underlying S3 object (operators can clean those up separately).
    Returns the updated crisis."""
    removeCrisisAttachment(id: String!, key: String!): Crisis!

    """Set the LLM-generated NRC SAF needs analysis inside the crisis's
    needs JSONB. Merges generalSummary and sector keys into the existing
    object so other keys on needs are preserved. Admin/pipeline only."""
    setCrisisNeedsAnalysis(
      id: String!,
      generalSummary: [String!]!,
      sector: JSON!,
    ): Crisis!

    """Upsert one or more per-locale translation rows for an event,
    crisis, or location. The translated data blob mirrors the canonical
    entity's JSON shape per locale. Admin/pipeline only."""
    upsertTranslations(input: UpsertTranslationsInput!): UpsertTranslationsResult!

    # ─── Knowledge base ────────────────────────────────────────────────────────
    """Replace all knowledgebase rows for \`reportId\` with \`chunks\`.
    Runs inside one transaction — a failed insert rolls back the
    delete so a re-run can retry cleanly. Vector length is validated
    against the pgvector column dimension (1024) on the server;
    mismatched rows are rejected before the write hits Postgres.
    Admin/pipeline only."""
    upsertKnowledgebaseChunks(
      reportId: String!
      reportTitle: String!
      sourceUrl: String!
      s3Key: String!
      publishedAt: DateTime!
      chunks: [KnowledgebaseChunkInput!]!
    ): UpsertKnowledgebaseResult!

    """Replace the \`report_datapoints\` row for \`input.reportId\`.
    Admin / pipeline only. The dagster-quickstart datapoints
    extraction asset is the primary caller; hand-invocation is
    supported for backfills and re-extraction. Idempotent — the row
    is uniquely keyed on \`report_id\`."""
    upsertReportDatapoints(
      input: UpsertReportDatapointsInput!
    ): UpsertReportDatapointsResult!

    """Insert a fresh situation-analysis snapshot for
    (\`input.countryLocationId\`, \`input.windowStart\`,
    \`input.windowEnd\`) and stamp \`validTo = now()\` on the
    previous current row for the same bucket in the same
    transaction. History rows are preserved. Admin / pipeline only —
    the Dagster \`weekly_situation_analyses\` asset is the primary
    caller."""
    upsertSituationAnalysis(
      input: UpsertSituationAnalysisInput!
    ): UpsertSituationAnalysisResult!

    """Pre-compute all four aggregation tiers (weekly × A2, monthly × A1,
    yearly × country, all-time × country) for reports whose
    \`reportingPeriodEnd\` falls in \`[from, to]\`. Each computed
    bucket is inserted with \`validFrom = now()\`; the previous
    "current" row for the same bucket key has its \`validTo\` stamped
    in the same transaction. History rows are preserved. Admin /
    pipeline only."""
    refreshAggregatedDatapoints(
      from: DateTime!
      to: DateTime!
      schemaVersion: String!
    ): RefreshAggregatedDatapointsResult!

    """Upload a PDF into the manual-ingest S3 inbox and trigger the
    Dagster \`process_manual_document_job\` to run the extract →
    chunk → enrich → embed → upsert chain against it.

    The report_id is derived from the file's SHA-256 (first 12 chars,
    prefixed \`manual:\`) so re-uploading the same bytes is idempotent
    — Dagster runs but the upsert path replaces the previous version
    in place. To force a fresh row, tweak the file (any byte) or
    switch to a scripted upload that supplies its own report_id.

    Restricted to admin / analyst — the ingest costs LLM + embedding
    credits per document. When DAGSTER_URL is unset the mutation
    still stages the PDF in S3 but returns a UNKNOWN-status job with
    no runId — useful for offline dev of the upload path."""
    uploadKnowledgebaseDocument(
      file: Upload!
      title: String!
      sourceUrl: String
      publishedAt: DateTime!
    ): KnowledgebaseIngestJob!
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
    """Organisation role: org_admin, member (default: member)."""
    role: String
    """Team assignments — at least one team is required. Each entry grants the
    invitee membership in that team with the given role on acceptance."""
    teams: [TeamAssignmentInput!]!
  }

  """One (team, role) assignment passed to inviteUser."""
  input TeamAssignmentInput {
    teamId: String!
    teamRole: TeamMemberRole!
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
    """Preferred UI language code (BCP-47 / ISO 639-1, e.g. "en", "ar")."""
    language: String
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
    """Arbitrary internal metadata stored in rawData (e.g. notes, recommendAlert).
    Not surfaced in the UI - use freely without schema changes."""
    metadata: JSON
    """Team the signal is being filed under. When present, the caller may be
    a team-level team_admin or field_coordinator on that team instead of a
    platform admin/analyst. Purely an authorisation hint — the signal itself
    has no team column; team affiliation is derived from location scope.
    Ignored for platform-level callers."""
    teamId: String
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
    """Reported casualties for the signal."""
    casualties: Int
    """Media URLs (source URLs for images, videos, etc.)."""
    media: [String!]
    originId: String
    destinationId: String
    locationId: String
    """Latitude for automatic geo-resolution (resolves to nearest location in hierarchy)."""
    lat: Float
    """Longitude for automatic geo-resolution."""
    lng: Float
    """Optional output of clear-pipeline's text-based geoparser. Additive
    enrichment, stored verbatim for downstream comparison against the
    source's coords. Schema documented on the signals model."""
    geoparsedData: JSON
    """Human-readable name to use when the resolver has to create a new L4
    point location from \`lat\`/\`lng\`. Typically the geoparser's
    top extracted candidate suffixed with " (unresolved)" when the
    Nominatim lookup failed, so audit views show \`al-Obeid (unresolved)\`
    instead of the signal's full paragraph. Ignored when \`locationId\`
    is supplied. When omitted, the resolver falls back to a coord-based
    label like \`Point 15.6280, 30.2156\`."""
    pointName: String
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
    """Aggregated casualties for the event (max across constituent signals)."""
    casualties: Int
    rank: Float!
    """Latitude for automatic geo-resolution (resolves to nearest location in hierarchy)."""
    lat: Float
    """Longitude for automatic geo-resolution."""
    lng: Float
    """Team the event is being filed under. When present, the caller may be
    a team-level team_admin or field_coordinator on that team instead of a
    platform admin/analyst. Purely an authorisation hint — the event itself
    has no team column; team affiliation is derived from location scope.
    Ignored for platform-level callers."""
    teamId: String
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
    """Aggregated casualties for the event (max across constituent signals)."""
    casualties: Int
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
    """Provide exactly one of eventId, signalId, or crisisId."""
    eventId: String
    signalId: String
    crisisId: String
    """Rating from 1 to 5."""
    rating: Int!
    """Optional textual feedback."""
    text: String
  }

  input AddCommentInput {
    """Provide exactly one of eventId, signalId, or crisisId."""
    eventId: String
    signalId: String
    crisisId: String
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

  input UpdateCrisisPopulationInput {
    """Population directly affected by the events (BigInt as string)."""
    populationAffected: String
    """Total population residing within the event admin areas (BigInt as string)."""
    populationInArea: String
    """AI-generated crisis title."""
    title: String
    """AI-generated crisis summary."""
    summary: String
    """LLM-generated forward scenarios. Shape:
       { most_likely, best_case, worst_case, description }."""
    scenarios: JSON
  }

  # ─── Webhook Mutations (platform admin only) ─────────────────────────
  extend type Mutation {
    """Create a new webhook subscription. The response is the only place
    the plaintext secret is returned — persist it in your own records
    (e.g. downstream verifier config) at this moment. To retrieve later,
    use rotateWebhookSubscriptionSecret which generates a fresh one."""
    createWebhookSubscription(input: CreateWebhookSubscriptionInput!): WebhookSubscription!

    """Update a subscription. Only provide fields you want to change."""
    updateWebhookSubscription(id: String!, input: UpdateWebhookSubscriptionInput!): WebhookSubscription!

    """Permanently delete a subscription and all its delivery history."""
    deleteWebhookSubscription(id: String!): Boolean!

    """Generate a new secret and invalidate the old one. Response
    includes the new plaintext secret (same one-shot semantics as
    create)."""
    rotateWebhookSubscriptionSecret(id: String!): WebhookSubscription!

    """Send a synthetic test event to this subscription. Creates a
    WebhookDelivery row and attempts delivery immediately. Payload
    mimics GlitchTip's alert format so downstream verifiers see a
    realistic shape."""
    sendTestWebhookEvent(id: String!): WebhookDelivery!

    """Re-fire a dead-lettered delivery. Resets attemptNumber to 1 and
    schedules an immediate retry via the poller."""
    retryWebhookDelivery(id: String!): WebhookDelivery!
  }
`;
