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

    """Open Signal Location challenges (for map dual-pin rendering). Team-scoped
    like signals when teamId is given; status defaults to "consideration"."""
    signalLocationChallenges(teamId: String, status: String): [SignalLocationChallenge!]!

    """Signals awaiting downstream processing (status = NEW), oldest-first — the
    Dagster event-driven drain. \`source\` filters by DataSource name (e.g.
    "dataminr"); \`first\` caps the batch (default 100, max 500). Admin/pipeline only."""
    pendingSignals(first: Int, source: String): [Signal!]!

    """List events. Requires authentication. includeDummy defaults to false."""
    events(teamId: String, includeDummy: Boolean): [Event!]!

    """Look up an event by ID. Requires authentication. Non-admins can only access events within their team scope."""
    event(id: String!): Event

    """
    Resolve a public share-link to its cached event snapshot. No auth -
    the (eventId, token) pair from the URL is the gate, and the snapshot
    only contains the safe fields enumerated on \`PublicEvent\`. Returns
    null when the Redis cache has no entry for that pair (link expired,
    revoked, or evicted under memory pressure - caller treats all three
    the same).
    """
    publicEvent(eventId: String!, token: String!): PublicEvent

    """
    Look up the most recently-minted public share link for an event,
    if one still exists in the cache. The Share modal calls this on
    open so it can reuse an existing link rather than minting a fresh
    token every time. Returns null when no live link exists - the
    caller then mints one via \`createPublicEventLink\`. Requires
    \`requireContentReader\` (admin / analyst / viewer); pending users
    are blocked.
    """
    existingPublicEventLink(eventId: String!): CreatePublicEventLinkResult

    """Events awaiting an alert (severity >= minSeverity AND no alert row yet AND
    a signal within the last \`maxAgeHours\`), oldest-first by the event's
    earliest-signal timestamp — the Dagster alert-stage queue. \`first\` caps the
    batch (default 100, max 500); \`minSeverity\` floors the severity (default 4);
    \`maxAgeHours\` bounds staleness on the latest signal's real-world time so the
    historical backlog / backdated backfill never alerts (default 48; 0 disables).
    Admin/pipeline only."""
    eventsPendingAlert(first: Int = 100, minSeverity: Int = 4, maxAgeHours: Int = 48): [Event!]!

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

    """History of a (location, type) pair - newest first. Includes the current
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

    """Look up an invitation by token (public - used on accept-invite page)."""
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

    """Crises awaiting enrichment (enrichmentStatus = PENDING), oldest-first — the
    Dagster enrichment drain. \`first\` caps the batch (default 100, max 500).
    Admin/pipeline only."""
    pendingCrises(first: Int): [Crisis!]!

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
    """Cross-entity stats query - returns a total plus optional buckets grouped
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

    """Daily Active Users time series - one point per UTC date in the
    window. Admin only. Days with zero logins are omitted; the dashboard
    can backfill them client-side when plotting."""
    dauSeries(from: DateTime!, to: DateTime!): [DauPoint!]!

    """Monthly Active Users time series - one point per UTC calendar
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

    """Entities enqueued for (re)translation, oldest-first — the Dagster
    translation drain (durable replacement for the lazy-on-read Celery enqueue).
    Optional entityType/locale filters; \`first\` caps the batch (default 100, max
    500). Admin/pipeline only."""
    pendingTranslations(first: Int, entityType: String, locale: String): [TranslationQueueItem!]!

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
    out of date) are NOT returned here - they're rare and handled by
    the per-entity enrichment hooks."""
    entitiesMissingTranslation(entityType: String!, locale: String!): [ID!]!

    # ─── Knowledge base ────────────────────────────────────────────────────────
    """Resolve a knowledge-base location reference to a \`locations.id\`.
    Pcode wins over name; \`adminLevel\` narrows the name match so a
    village that shares its state's name doesn't collide. Returns null
    when neither the pcode nor the name matches - the ingest keeps the
    raw pcode on the row so a future backfill can re-resolve. A name given
    without \`adminLevel\` that matches more than one admin level is
    ambiguous and also returns null (rather than guessing the deepest
    match), so an unlevelled name never silently lands on the wrong tier.
    Admin / pipeline only."""
    resolveKnowledgebaseLocation(
      pcode: String
      name: String
      adminLevel: Int
    ): String

    """Resolve a place name against the offline GeoNames gazetteer - the
    first tier of the hybrid geo-resolver. Tries an exact normalised-name
    match, then a \`pg_trgm\` fuzzy match, preferring populated places / admin
    areas (feature class P/A) and the more-populous tie-break. \`countryCode\`
    (ISO-3166-1 alpha-2, e.g. \"SD\") scopes the search; omit to search every
    loaded country. \`minSimilarity\` (default 0.4) floors the fuzzy match.
    Returns null on no match - the geoparser then falls back to LocationIQ
    for landmarks/POIs the gazetteer lacks. Admin / pipeline only."""
    resolveGazetteerLocation(
      name: String!
      countryCode: String
      minSimilarity: Float
    ): GazetteerHit

    """Hybrid dense + BM25 retrieval over the knowledge base, fused
    with Reciprocal Rank Fusion (k=60) and returned in descending
    score order. Both retrievers run in parallel over the same filter
    set; each contributes up to 50 candidates before fusion. The
    embedding provider is the one configured in the environment -
    keep the write and read sides on the same provider or turn on
    \`filters.currentEmbeddingModelOnly\` to guarantee vector-space
    consistency. Requires any authenticated content reader."""
    searchKnowledgebase(
      query: String!
      filters: KnowledgebaseFilters
      limit: Int = 10
    ): [KnowledgebaseHit!]!

    """Poll a Dagster run kicked off by \`uploadKnowledgebaseDocument\`.
    Returns null when the runId doesn't exist on this Dagster instance
    (e.g. Dagster was restarted with a fresh instance store, or the
    runId was recorded against a different DAGSTER_URL). Requires any
    authenticated content reader."""
    knowledgebaseIngestJob(runId: String!): KnowledgebaseIngestJob

    # ─── Structured datapoints - Layer 2 read path ─────────────────────
    """One report's extracted structured datapoints. Returns null when
    no extraction has been persisted yet (report ingested via vector
    RAG but the datapoint pipeline hasn't caught up). Requires any
    authenticated content reader."""
    reportDatapoint(reportId: String!): ReportDatapoint

    # ─── Situation analysis ──────────────────────────────────────────
    """Current situation-analysis snapshot for one bucket of a country.
    Buckets are keyed \`(countryLocationId, windowKind, windowStart)\`.
    By default reads the yearly bucket, where \`year\` derives
    \`windowStart = Jan 1\` server-side and falls back to \`year(now())\`
    when null - the dashboard's usual call. Pass \`windowKind\` +
    \`windowStart\` instead to read a finer bucket (e.g. monthly, to diff
    one month against the previous). Returns null when no snapshot
    exists - the dashboard should render an empty state and wait for the
    next weekly generation. Requires any authenticated content reader."""
    situationAnalysis(
      countryLocationId: String!
      year: Int
      """Bucket granularity, part of the bucket key. Defaults to
      \`yearly\`. The pipeline owns this taxonomy (currently \`yearly\`
      and \`monthly\`), so it is not validated against a fixed list here -
      an unknown value simply matches no row and returns null."""
      windowKind: String
      """Exact bucket start, matched for equality. Required when
      \`windowKind\` is anything other than \`yearly\`, because a year
      alone cannot identify a finer bucket. Must be the same instant the
      writer used (midnight UTC on the first day of the window), so pass
      the value the pipeline computed rather than reconstructing it.
      \`windowEnd\` is never matched on."""
      windowStart: DateTime
      """Historical read - return the version that was current at
      this timestamp (defaults to now)."""
      asOf: DateTime
      """Pin the read to a payload schema version. Defaults to the most
      recently written version for the bucket. Versions coexist rather
      than supersede - an older payload shape stays readable, so pass
      this to keep a client on a shape it understands. Read
      \`schemaVersion\` off the returned row to see what you got."""
      schemaVersion: String
    ): SituationAnalysis

    """Trend / history view - one row per year for a country, current
    versions only, newest year first. Never mixes schema versions: a
    bump changes what the numbers mean, so one series is always one
    version. Requires any authenticated content reader."""
    situationAnalysesForCountry(
      countryLocationId: String!
      limit: Int = 5
      """Pin the trend to a payload schema version. Defaults to the
      country's most recently written version. Pass an older one to
      chart a historical payload shape."""
      schemaVersion: String
    ): [SituationAnalysis!]!

    """Read one situation-analysis snapshot by its row id, including
    superseded history rows (the bucket-keyed \`situationAnalysis\` query
    only returns the current row). Used by the translation pipeline to
    fetch a specific generation's canonical prose. \`data\` is overlaid
    with the caller's locale translation like every other read — the
    pipeline calls it as \`en\` and gets canonical text back. Requires any
    authenticated content reader."""
    situationAnalysisById(id: String!): SituationAnalysis

    """Captured infographics (charts/maps/tables/composite panels) filtered by the
    SAME params as text — location / event type / need sector / time / kind — so a
    figure can be attached to an answer scoped to a place + topic + period. Powers
    figure attachment + on-demand infographic generation. Array filters match ANY
    tag; time overlaps the window. Any authenticated content reader."""
    reportFigures(
      reportId: String
      locationIds: [String!]
      eventTypes: [String!]
      needSectors: [String!]
      kinds: [String!]
      timeRangeStart: DateTime
      timeRangeEnd: DateTime
      first: Int = 50
    ): [ReportFigure!]!

    """True when at least one current \`aggregated_datapoints\` row
    exists for the given schema version. Used by the Dagster
    aggregation asset to distinguish first-run backfill (wide
    lookback window) from routine weekly refreshes (narrow window).
    Pass \`countryLocationId\` (an admin-0 location id) to scope the
    check to ONE country, so a newly-onboarded country's first run
    uses the initial window even after other countries are established
    — the four-tier walk always produces yearly/all-time buckets AT the
    country location, so an A0 row is the per-country signal. Any
    authenticated content reader - a cheap existence check."""
    hasAggregatedDatapoints(schemaVersion: String!, countryLocationId: String): Boolean!

    """Aggregated datapoints for a (window × window_kind × location)
    scope. Cache-first: returns the pre-computed snapshot when one
    is current (\`validTo IS NULL\` or covers the \`asOf\` timestamp);
    otherwise assembles the bucket on-demand from \`report_datapoints\`
    and returns it with \`onDemand = true\`. Returns null when no
    contributing reports exist in scope."""
    aggregatedDatapoint(
      """Null = country-wide roll-up (yearly / all-time tiers)."""
      locationId: String
      windowStart: DateTime!
      windowEnd: DateTime!
      windowKind: String!
      """Defaults to the currently-configured pipeline schema version."""
      schemaVersion: String
      """Historical snapshot lookup - return the version that was current
      at this timestamp. Defaults to \`now\`."""
      asOf: DateTime
    ): AggregatedDatapoint

    # ─── Webhooks (platform admin only) ────────────────────────────────
    """All webhook subscriptions, newest first."""
    webhookSubscriptions: [WebhookSubscription!]!
    """One subscription by ID, or null if not found."""
    webhookSubscription(id: String!): WebhookSubscription
    """Recent delivery attempts for a subscription, newest first."""
    webhookDeliveries(subscriptionId: String!, limit: Int = 50): [WebhookDelivery!]!

    # ─── Ground intel staging tier (admin/analyst only) ────────────────
    """All ground sources (per-source policy records), newest first."""
    groundSources: [GroundSource!]!

    """Review queue: ground threads, newest first. Filter by source and/or
    review state ("unverified" | "approved_private" | "approved_public" |
    "rejected")."""
    groundThreads(
      groundSourceId: String
      reviewState: String
      limit: Int = 100
      offset: Int = 0
    ): [GroundThread!]!

    """One ground thread with its messages, or null if not found."""
    groundThread(id: String!): GroundThread

    """Staged messages, oldest first. Filter by source and/or thread."""
    groundMessages(
      groundSourceId: String
      threadId: String
      limit: Int = 200
      offset: Int = 0
    ): [GroundMessage!]!

    """PIPELINE CONTRACT (admin/pipeline only): a source's staged
    messages, oldest first, projected for the classification/threading
    worker — no private-tier sender identity. Returns ALL messages
    (classified and not) so one query powers both labelling and
    thread assembly (clustering staged Signals into threads)."""
    groundMessagesForClassification(
      groundSourceId: String!
      limit: Int = 500
    ): [GroundMessageForClassification!]!

    """PIPELINE CONTRACT (admin/pipeline only): threading context for the
    classification worker — a source's existing threads, oldest first,
    so late corrections/retractions can target an existing thread via
    GroundThreadUpsertInput.threadId. \`states\` filters on
    lifecycleState ("reported" | "updated" | "confirmed" | "corrected" |
    "retracted"); omitted/empty returns all. The worker selects
    {id, title, lifecycleState, reviewState, messageIds} — no message
    content, no sender identity."""
    groundThreadsForSource(
      groundSourceId: String!
      states: [String!]
    ): [GroundThread]
  }
`;
