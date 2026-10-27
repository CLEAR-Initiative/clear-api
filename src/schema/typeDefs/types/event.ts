import { gql } from "graphql-tag";

export const eventTypeDef = gql`
  """Precision of an extracted start/end date — how finely the pipeline's LLM
  could pin the real-world onset/close. DAY = exact; coarser values mean the
  date is only known to that week/month/year."""
  enum DateAccuracy {
    DAY
    WEEK
    MONTH
    YEAR
  }

  """An event grouping related signals into a coherent narrative."""
  type Event {
    id: String!
    title: String
    description: String
    """LLM-generated signal descriptions as JSON."""
    descriptionSignals: JSON
    validFrom: DateTime!
    """Event end / expiry. Null when no real end is known (not invented)."""
    validTo: DateTime
    firstSignalCreatedAt: DateTime!
    lastSignalCreatedAt: DateTime!
    """When the real-world event actually STARTED (its onset) — parsed from the
    signal text, distinct from \`validFrom\`/\`firstSignalCreatedAt\` (record +
    signal-collection times). Null when no onset could be resolved."""
    startedAt: DateTime
    """When the real-world event actually ENDED (its close), distinct from
    \`validTo\` (the visibility/expiry window). Null = ongoing / no known end."""
    endedAt: DateTime
    """Precision of \`startedAt\` (DAY = exact day; coarser = week/month/year)."""
    startedAtAccuracy: DateAccuracy
    """Precision of \`endedAt\`."""
    endedAtAccuracy: DateAccuracy
    """Natural-hazard magnitude (e.g. 6.4), aggregated from member signals.
    Null for non-disaster events."""
    magnitude: Float
    """Unit for \`magnitude\` (e.g. "Mw", "km/h"). Null when no magnitude."""
    magnitudeUnit: String
    """Named conflict actors aggregated across member signals. Empty for
    non-conflict events."""
    actors: [String!]!
    """Countries the event touches, resolved to admin-0 locations."""
    countries: [Location!]!
    """Origin location of the event."""
    originLocation: Location
    """Destination location of the event."""
    destinationLocation: Location
    """General location (when no origin/destination)."""
    generalLocation: Location
    """Location of the event's FIRST signal (the one recorded in
    \`firstSignalCreatedAt\`) — a single point ready to drop as a map
    marker, so a client doesn't have to fetch every signal and pick one.
    The first non-null of the signal's origin → destination → general
    location; null when the first signal has no located point.
    Requires any authenticated content reader."""
    representativePoint: Location
    """Event type tags."""
    types: [String!]!
    """Severity score (1–5). Aggregated from signal severities."""
    severity: Int
    """Whether this is seed/demo data."""
    isDummy: Boolean!
    """Estimated population affected."""
    populationAffected: String
    """Estimated population displaced by the event (BigInt as string)."""
    populationDisplaced: String
    """Aggregated casualties for the event (sum across constituent signals)."""
    casualties: Int
    rank: Float!
    """Hash of the live member signal ids at the last LLM rewrite. Lets the
    recompute skip the rewrite when membership is unchanged."""
    rewriteMembersHash: String
    """Signals linked to this event, excluding retracted ones."""
    signals: [Signal!]!
    """Alerts created from this event."""
    alerts: [Alert!]!
    """User feedback on this event."""
    feedbacks: [UserFeedback!]!
    """User comments on this event."""
    comments: [UserComment!]!
    """Escalations by users."""
    escalations: [EventEscalation!]!
  }
`;
