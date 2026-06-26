import { gql } from "graphql-tag";

export const publicEventTypeDef = gql`
  """
  The slim, unauthenticated view of an event used for share-link
  rendering. Deliberately a new type — not a slim wrapper around
  \`Event\` — so the field set is auditable in one place and field-
  selection can't accidentally leak signals, comments, alerts, or any
  other gated data through the public surface.

  Returned by the \`publicEvent(eventId, token)\` query when the
  Redis-cached snapshot for that token is still alive. Cache TTL
  defaults to 30 days; entries can be evicted earlier under memory
  pressure, in which case the link expires and the user has to
  request a new one.
  """
  type PublicEvent {
    id: String!
    """Localised event title (resolved to the canonical English text
    when the snapshot was taken — the public page is not locale-aware)."""
    title: String
    """Localised event description (canonical English at snapshot time)."""
    description: String
    """Severity score (1–5) at snapshot time."""
    severity: Float
    """Window during which the event is considered valid."""
    validFrom: DateTime!
    validTo: DateTime!
    """Disaster type codes (e.g. \`fl\`, \`pa\`). The frontend resolves
    these to display names via its own disaster-type catalogue."""
    types: [String!]!
    """Human-readable name of the event's primary location (general
    → origin → destination, first non-null)."""
    primaryLocationName: String
    """\`[lng, lat]\` of the primary location's centroid when that
    location has a Point geometry. Null for polygon-only locations —
    the frontend hides the minimap in that case."""
    primaryLocationCoords: [Float!]
    """Stringified bigint (matches the authenticated \`Event\` field
    shape). Null when unknown."""
    populationAffected: String
    populationDisplaced: String
    """\`[lng, lat]\` for every Point location attached to the event's
    constituent signals (origin / destination / general fields,
    deduped by location id). Polygon-only signal locations are
    omitted. Empty when no signals carry Point geometry — the
    frontend hides the markers list in that case."""
    signalPoints: [PublicEventSignalPoint!]!
    """Population of the event's administrative area, resolved by
    walking the primary location's ancestor chain in A2 → A1 → A0
    order (district → state → country) and picking the deepest non-
    null. Mirrors the fallback the in-app event page uses so the
    share card shows the same number. Stringified bigint; null when
    no level along the chain has a population. See also
    \`locationPopulationLevel\` and \`locationPopulationName\`."""
    locationPopulation: String
    """Level the population number came from: \`2\` (district), \`1\`
    (state), \`0\` (country). Null when \`locationPopulation\` is
    null."""
    locationPopulationLevel: Int
    """Name of the location the population number is for (e.g. \"South
    Darfur\"). Null when \`locationPopulation\` is null. Lets the
    frontend label the figure with context — \"Population of South
    Darfur\" reads more honestly than a bare number when we fell back
    to a country-level figure."""
    locationPopulationName: String
    """Internally-displaced persons count for the event's admin area,
    sourced from \`locationMetadata(type = "iom_dtm_displacement")\`.
    Same A2 → A1 → A0 fallback as \`locationPopulation\`. Stringified
    bigint; null when no displacement metadata exists for any level."""
    locationIdp: String
    """Level the IDP number came from. Null when \`locationIdp\` is null."""
    locationIdpLevel: Int
    """Name of the location the IDP figure is for. Null when
    \`locationIdp\` is null."""
    locationIdpName: String
    """When the share link was minted."""
    sharedAt: DateTime!
    """Soft expiry — the Redis TTL the cached snapshot was written
    with. The frontend uses this to render \"Link expires in N days\"."""
    expiresAt: DateTime!
  }

  """One Point location attached to one of the event's signals."""
  type PublicEventSignalPoint {
    """Display name of the location (e.g. \"Al Fasher\"). Often null
    for raw point-locations like \"Point 15.62, 30.21\"."""
    name: String
    """Geographic longitude."""
    lng: Float!
    """Geographic latitude."""
    lat: Float!
  }

  """Input for the \`createPublicEventLink\` mutation."""
  input CreatePublicEventLinkInput {
    """The event to share. Caller must be able to read it via the
    normal \`event(id)\` resolver — i.e. \`requireContentReader\`
    passes."""
    eventId: String!
    """Snapshot lifetime in days. Defaults to 30, capped at 90. Smaller
    values produce shorter URLs by reducing the impact of any future
    URL-history scraping."""
    ttlDays: Int
  }

  """Returned once from \`createPublicEventLink\`. The token is part
  of the URL and not retrievable again — same one-time-show semantics
  as \`createApiKey\`."""
  type CreatePublicEventLinkResult {
    """The plaintext token. Embedded in \`url\` for convenience."""
    token: String!
    """Pre-built /public/event/<eventId>/<token> URL on the frontend.
    Hand this straight to the share UI."""
    url: String!
    """Wall-clock expiry — when the cached snapshot will be dropped
    from Redis (assuming it isn't evicted earlier or revoked)."""
    expiresAt: DateTime!
  }
`;
