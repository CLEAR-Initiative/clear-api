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
    """When the share link was minted."""
    sharedAt: DateTime!
    """Soft expiry — the Redis TTL the cached snapshot was written
    with. The frontend uses this to render \"Link expires in N days\"."""
    expiresAt: DateTime!
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
