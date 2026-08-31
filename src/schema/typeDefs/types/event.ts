import { gql } from "graphql-tag";

export const eventTypeDef = gql`
  """An event grouping related signals into a coherent narrative."""
  type Event {
    id: String!
    title: String
    description: String
    """LLM-generated signal descriptions as JSON."""
    descriptionSignals: JSON
    validFrom: DateTime!
    validTo: DateTime!
    firstSignalCreatedAt: DateTime!
    lastSignalCreatedAt: DateTime!
    """When the real-world event actually STARTED (its onset) — parsed from the
    signal text, distinct from \`validFrom\`/\`firstSignalCreatedAt\` (record +
    signal-collection times). Null when no onset could be resolved."""
    startedAt: DateTime
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
    """Aggregated casualties for the event (max across constituent signals)."""
    casualties: Int
    rank: Float!
    """Signals linked to this event."""
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
