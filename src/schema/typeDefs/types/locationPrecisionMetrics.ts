import { gql } from "graphql-tag";

export const locationPrecisionMetricsTypeDef = gql`
  """
  The range, place and sources to measure location precision over. Every
  field is optional.
  """
  input LocationPrecisionMetricsInput {
    """Start of the range, inclusive. Defaults to the start (Monday 00:00 UTC) of the ISO week 11 weeks before \`to\`'s week, so the default range is 12 ISO weeks."""
    from: DateTime
    """End of the range, inclusive. Defaults to now."""
    to: DateTime
    """Only Signals whose location is this location or inside it. A Signal with no location cannot be placed, so it is left out when this is set."""
    locationId: String
    """Only these sources, by \`DataSource.name\` (e.g. \`sudan-war-x\`). Defaults to every source."""
    sourceNames: [String!]
    """Bucket size of \`series\`. Defaults to \`WEEK\`."""
    granularity: MetricGranularity
  }

  """
  Location precision: how finely CLEAR placed the Signals it ingested, per
  source and ISO week. Each ingested Signal in range counts once under the
  level of its location (general location, or for displacement its origin,
  else its destination): no location, country (0), state (1), district (2)
  or point (a level-4 landmark or coordinate point). "District or finer" is
  district plus point. A Signal a person corrected counts at the location the
  pipeline gave it, not the corrected point. Counts only; shares are the
  caller's. See ADR-0012.

  A Signal is in range by the instant it was last located: \`processedAt\`,
  or with none \`collectedAt\`. Ingested means brought in by a pipeline (not
  submitted or filed by hand), not retracted, not dummy.
  """
  type LocationPrecisionMetrics {
    """Start of the range measured."""
    from: DateTime!
    """End of the range measured."""
    to: DateTime!
    """Ingested Signals located in range, under the filters."""
    signalsInRange: Int!
    """One row per source with a Signal in range, most Signals first."""
    bySource: [LocationPrecisionSource!]!
    """Each source in \`bySource\` by ISO week of the instant its Signals were located, zero-filled over every week the range touches, ascending."""
    weekly: [LocationPrecisionWeek!]!
    """Location challenges filed in range, by status: a correctness proxy until an analyst-checked sample exists."""
    corrections: LocationCorrectionCounts!
    """The bucket size \`series\` was read in."""
    granularity: MetricGranularity!
    """Each source in \`bySource\` per bucket of \`granularity\` (ADR-0014): zero-filled over every bucket the range touches, in \`bySource\` order then ascending. With \`WEEK\` it equals \`weekly\` row for row."""
    series: [LocationPrecisionBucket!]!
  }

  """One source's ingested Signals located in one bucket of the requested granularity, by the level of their location."""
  type LocationPrecisionBucket {
    """Start of the bucket: 00:00 UTC of the day, the week's Monday, or the first of the month."""
    start: DateTime!
    """\`2026-10-29\` for a day, \`2026-W44\` for an ISO week, \`2026-10\` for a month."""
    label: String!
    """\`DataSource.name\`."""
    source: String!
    total: Int!
    noLocation: Int!
    country: Int!
    state: Int!
    district: Int!
    point: Int!
    """True when the range covers only part of the bucket, e.g. the current one."""
    isPartial: Boolean!
  }

  """Ingested Signals of one source in range, by the level of their location."""
  type LocationPrecisionSource {
    """\`DataSource.name\`."""
    source: String!
    """All of the source's ingested Signals in range."""
    total: Int!
    """Signals with no location at all."""
    noLocation: Int!
    """Signals at a country (level 0)."""
    country: Int!
    """Signals at a state or province (level 1)."""
    state: Int!
    """Signals at a district (level 2)."""
    district: Int!
    """Signals at a point: a level-4 landmark or coordinate point inside a district."""
    point: Int!
  }

  """One source's ingested Signals located in one ISO week, by the level of their location."""
  type LocationPrecisionWeek {
    """The ISO week, e.g. \`2026-W44\`."""
    isoWeek: String!
    """Monday 00:00 UTC of the week."""
    weekStart: DateTime!
    """\`DataSource.name\`."""
    source: String!
    total: Int!
    noLocation: Int!
    country: Int!
    state: Int!
    district: Int!
    point: Int!
    """True when the range covers only part of the week, e.g. the current week."""
    isPartial: Boolean!
  }

  """Location challenges filed in range, by status."""
  type LocationCorrectionCounts {
    """Awaiting a decision (status \`consideration\`)."""
    open: Int!
    """The analyst's proposed point was written onto the Signal."""
    accepted: Int!
    """The decider placed a different point."""
    corrected: Int!
    """Declined: the location stood."""
    declined: Int!
    """Replaced by a newer challenge on the same Signal."""
    superseded: Int!
  }
`;
