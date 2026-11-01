import { gql } from "graphql-tag";

export const metricSeriesTypeDef = gql`
  """A metric the admin /metrics page can plot over time (ADR-0015). Each value is one registry entry in clear-api."""
  enum MetricKey {
    """Share of measured Events first signalled on the onset day or the day after (ADR-0011)."""
    DETECTED_BY_NEXT_DAY
    """Share of measured Events first signalled on the onset day (ADR-0011)."""
    DETECTED_SAME_DAY
    """Share of measured Alerts raised on the Event's onset day or the day after (ADR-0017)."""
    ALERTED_BY_NEXT_DAY
    """Share of measured Alerts raised on the Event's onset day (ADR-0017)."""
    ALERTED_SAME_DAY
    """Share of located ingested Signals placed at a district or a point inside one (ADR-0012)."""
    DISTRICT_OR_FINER
    """Share of ingested Signals whose Event holds another ingested Signal, a grouping proxy (ADR-0018)."""
    SIGNALS_GROUPED
    """Share of Events holding exactly one ingested Signal, a grouping proxy (ADR-0018)."""
    EVENTS_WITH_ONE_SIGNAL
    """Share of ACLED events whose district held a CLEAR Alert from another feed within three days, a recall proxy (ADR-0018)."""
    ACLED_EVENTS_ALERTED
    """Share of source-days on which an expected data feed was within its cadence (ADR-0017)."""
    SOURCES_ON_SCHEDULE
    """Share of Events a user escalated to the team, an interim usefulness proxy (ADR-0017)."""
    EVENTS_ESCALATED
  }

  """The Notion Metrics table's dimension a metric sits under."""
  enum MetricDimension {
    TIMELINESS
    ACCURACY
    COVERAGE
    RELIABILITY
    USEFULNESS
  }

  """What a metric's denominator counts."""
  enum MetricUnit {
    EVENTS
    SIGNALS
    """One per expected data source per measured UTC day."""
    SOURCE_DAYS
    """One ACLED event: the reference dataset's Signal."""
    ACLED_EVENTS
  }

  """How a series can be split into groups."""
  enum MetricGroupBy {
    """One series per data source (\`DataSource.name\`), in the owning query's order: most Signals first for Signal metrics, the expected-cadence list for Sources on schedule."""
    SOURCE
  }

  """What a client needs to list, group and explain a metric."""
  type MetricDefinition {
    key: MetricKey!
    """The metric's name, as the Notion Metrics table names it."""
    name: String!
    dimension: MetricDimension!
    unit: MetricUnit!
    """The method in one paragraph: what counts, over what."""
    description: String!
    """The instant that puts a row in a bucket."""
    timeBasis: String!
    """True when the series can be read with \`groupBy: SOURCE\`."""
    groupable: Boolean!
    """True when \`locationId\` scopes the series. False for a metric that reads every country (Sources on schedule): clients should drop the country filter from its reading and label it so."""
    locationScoped: Boolean!
    """The ADR that owns the definition, e.g. \`ADR-0012\`."""
    adr: String!
  }

  """The metric, range, bucket size and grouping to read a series for. Only \`metric\` is required."""
  input MetricSeriesInput {
    metric: MetricKey!
    """Bucket size (ADR-0014). Defaults to \`WEEK\`."""
    granularity: MetricGranularity
    """Start of the range, inclusive. Defaults to the start of the ISO week 11 weeks before \`to\`'s week."""
    from: DateTime
    """End of the range, inclusive. Defaults to now."""
    to: DateTime
    """Only rows in this location or inside it, as the owning query reads it. Ignored by a metric whose definition has \`locationScoped: false\`."""
    locationId: String
    """Only these sources, by \`DataSource.name\`; only for metrics that can be grouped by source."""
    sourceNames: [String!]
    """Split the series into groups. Refused with BAD_USER_INPUT for a metric that cannot be grouped."""
    groupBy: MetricGroupBy
  }

  """One bucket of one group. The metric is \`numerator / denominator\`; a bucket with a zero denominator measured nothing."""
  type MetricBucket {
    """Start of the bucket: 00:00 UTC of the day, the week's Monday, or the first of the month."""
    start: DateTime!
    """\`2026-10-29\` for a day, \`2026-W44\` for an ISO week, \`2026-10\` for a month."""
    label: String!
    """True when the range covers only part of the bucket."""
    isPartial: Boolean!
    """The group this bucket belongs to; null for an ungrouped series."""
    group: String
    numerator: Int!
    denominator: Int!
  }

  """
  One metric over a range as a share per bucket, read from the service that
  owns the metric's definition, so it never disagrees with the metric's own
  query (ADR-0015). Counts only; shares are the caller's to compute.
  """
  type MetricSeries {
    metric: MetricKey!
    """The bucket size the series was read in."""
    granularity: MetricGranularity!
    from: DateTime!
    to: DateTime!
    """Group names in the owning query's order; empty when ungrouped."""
    groups: [String!]!
    """Group by group, ascending buckets within each, zero-filled over every bucket the range touches."""
    buckets: [MetricBucket!]!
  }
`;
