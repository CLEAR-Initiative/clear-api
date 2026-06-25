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

    """
    Resolve a public share-link to its cached event snapshot. No auth —
    the (eventId, token) pair from the URL is the gate, and the snapshot
    only contains the safe fields enumerated on \`PublicEvent\`. Returns
    null when the Redis cache has no entry for that pair (link expired,
    revoked, or evicted under memory pressure — caller treats all three
    the same).
    """
    publicEvent(eventId: String!, token: String!): PublicEvent

    """
    Look up the most recently-minted public share link for an event,
    if one still exists in the cache. The Share modal calls this on
    open so it can reuse an existing link rather than minting a fresh
    token every time. Returns null when no live link exists — the
    caller then mints one via \`createPublicEventLink\`. Requires
    \`requireContentReader\` (admin / analyst / viewer); pending users
    are blocked.
    """
    existingPublicEventLink(eventId: String!): CreatePublicEventLinkResult

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

    """List all disaster type classifications (flat list of level-3 rows)."""
    disasterTypes: [DisasterType!]!

    """Look up a disaster type by ID."""
    disasterType(id: String!): DisasterType

    """List disaster types grouped into the 3-level hierarchy (level1 > level2 > level3)."""
    disasterTypeHierarchy: [DisasterLevel1!]!

    """List metadata entries for a location, optionally filtered by type.
    By default only the CURRENT value is returned (validTo is null). Pass
    current: false to include the full history."""
    locationMetadata(locationId: String!, type: String, current: Boolean): [LocationMetadata!]!

    """List every locationMetadata entry of a given type across all locations.
    By default only current values. Pass current: false for the full history."""
    allLocationMetadata(type: String!, current: Boolean): [LocationMetadata!]!

    """History of a (location, type) pair — newest first. Includes the current
    row plus every superseded one."""
    locationMetadataHistory(locationId: String!, type: String!): [LocationMetadata!]!

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

    # ─── Crises ────────────────────────────────────────────────────────────────
    """List all crises."""
    crises: [Crisis!]!

    """Look up a crisis by ID."""
    crisis(id: String!): Crisis

    # ─── Paginated lists ───────────────────────────────────────────────────────
    """Paginated alerts feed with severity / location / type / date filters and
    explicit ordering. Use this instead of \`alerts(...)\` when the UI needs
    pages or a totalCount."""
    alertsPage(input: AlertsPageInput): AlertsPage!

    """Paginated events feed (same filter shape as alertsPage, plus event-only
    options). Honours teamId as a location-scope filter."""
    eventsPage(input: EventsPageInput): EventsPage!

    """Paginated signals feed with source-based filtering."""
    signalsPage(input: SignalsPageInput): SignalsPage!

    # ─── Stats ─────────────────────────────────────────────────────────────────
    """Cross-entity stats query — returns a total plus optional buckets grouped
    by type / severity / day / week / month. Filter shape mirrors the page
    queries so a "current view" can compute its own counts."""
    entityStats(input: EntityStatsInput!): EntityStats!

    # ─── Geocoder cache ──────────────────────────────────────────────────────
    """Look up a cached Nominatim geocoder response by query hash. Returns
    null when the entry is missing or expired (admin/pipeline only)."""
    nominatimCacheEntry(queryHash: String!): NominatimCacheEntry

    # ─── Analytics / audit ───────────────────────────────────────────────────
    """Paginated activity log. Admin only. Newest first."""
    activityLogs(
      filter: ActivityLogFilterInput
      limit: Int = 50
      offset: Int = 0
    ): [ActivityLog!]!

    """Aggregated activity counts + per-user + per-day breakdown for the
    admin dashboard. Admin only. Default window: last 30 days."""
    activityStats(from: DateTime, to: DateTime): ActivityStats!

    """Point-in-time user-engagement summary: DAU, WAU, MAU, and the
    DAU/MAU stickiness ratio. Derived from auth.login activity. Admin
    only. \`asOf\` defaults to NOW(); pass a historical timestamp to
    compute as-of that date."""
    userEngagement(asOf: DateTime): UserEngagementMetrics!

    """Daily Active Users time series — one point per UTC date in the
    window. Admin only. Days with zero logins are omitted; the dashboard
    can backfill them client-side when plotting."""
    dauSeries(from: DateTime!, to: DateTime!): [DauPoint!]!

    """Monthly Active Users time series — one point per UTC calendar
    month in the window. Admin only."""
    mauSeries(from: DateTime!, to: DateTime!): [MauPoint!]!
    # ─── Pipeline config ───────────────────────────────────────────────────────
    """The countries the CLEAR pipeline publishes a Situation Analysis for, with
    each Country's bounding box. The scheduled publisher reads this to know which
    countries to run. Requires authentication."""
    pipelineCountries: [PipelineCountry!]!

    """Translation rows currently stored for an entity, one per locale.
    Admin/pipeline only. Used by clear-pipeline to compare stored source
    hashes against the canonical row and decide which fields to re-translate."""
    translations(entityType: String!, entityId: String!): [TranslationRow!]!

    """Per-(entityType, locale) translation coverage snapshot for the
    admin dashboard. Admin only. Each row reports canonicalCount (how
    many entities of that type exist) and translatedCount (how many
    have a translation row for that locale). Coverage = translated /
    canonical."""
    translationCoverage: [TranslationCoverage!]!

    """IDs of entities of the given type that have NO translation row
    for the given locale. Admin/pipeline only. Lets the backfill
    driver enqueue only entities the worker would actually translate,
    instead of relying on per-task staleness diffs to no-op thousands
    of already-current rounds. Stale rows (row exists but hashes are
    out of date) are NOT returned here — they're rare and handled by
    the per-entity enrichment hooks."""
    entitiesMissingTranslation(entityType: String!, locale: String!): [ID!]!
  }
`;
