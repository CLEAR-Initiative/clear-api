import { gql } from "graphql-tag";

export const detectionMetricsTypeDef = gql`
  """
  Why an Event in range is left out of time to detection. Each excluded
  Event has exactly one reason, the first that applies in this order.
  """
  enum DetectionExclusionReason {
    """No Signal a pipeline ingested: only history (accepted web cases) or Signals a person filed by hand."""
    NO_INGESTED_SIGNAL
    """The Event has no onset date to measure from."""
    NO_ONSET
    """The first ingested Signal has a date but no time of day (published at exactly UTC midnight)."""
    DATE_ONLY_FIRST_SIGNAL
    """The first ingested Signal is dated before the onset day: a data error."""
    BEFORE_ONSET
  }

  """
  The range and place to measure time to detection over. Every field is
  optional.
  """
  input DetectionMetricsInput {
    """Start of the range, inclusive. Defaults to the start (Monday 00:00 UTC) of the ISO week 11 weeks before \`to\`'s week, so the default range is 12 ISO weeks."""
    from: DateTime
    """End of the range, inclusive. Defaults to now."""
    to: DateTime
    """Only Events whose origin, destination or general location is this location or inside it."""
    locationId: String
  }

  """
  Time to detection: how soon after an Event's real-world onset CLEAR
  received its first ingested Signal, in whole UTC days (same day = 0, next
  day = 1). Counts only; shares are the caller's to compute. See ADR-0011.

  An Event is in range when its first ingested Signal's \`publishedAt\` is,
  or, with none, its \`firstSignalCreatedAt\`. Dummy Events are left out.
  """
  type DetectionMetrics {
    """Start of the range measured."""
    from: DateTime!
    """End of the range measured."""
    to: DateTime!
    """Events in range: \`counted\` plus every exclusion."""
    eventsInRange: Int!
    """Events in range with an onset date."""
    withOnset: Int!
    """Events measured: an onset, a first ingested Signal with a time of day, on or after the onset day."""
    counted: Int!
    """Counted Events first signalled on their onset day."""
    sameDay: Int!
    """Counted Events first signalled on their onset day or the day after."""
    byNextDay: Int!
    """Counted Events by whole days from onset: exactly 9 rows, 0 to 7, then 8 and more (\`isOpenEnded\`)."""
    histogram: [DetectionHistogramBucket!]!
    """Counted Events per ISO week of their first ingested Signal, with each week's Events in range, ascending, one row per week the range touches (zero-filled)."""
    weekly: [DetectionWeek!]!
    """Events in range not measured, by reason: exactly 4 rows, one per reason."""
    exclusions: [DetectionExclusion!]!
  }

  """Counted Events whose first ingested Signal came this many days after onset."""
  type DetectionHistogramBucket {
    """Whole UTC days from onset to first ingested Signal; the open-ended row's lower bound."""
    daysAfterOnset: Int!
    """True for the last row, which counts \`daysAfterOnset\` days and more."""
    isOpenEnded: Boolean!
    """Counted Events in this bucket."""
    count: Int!
  }

  """Counted Events whose first ingested Signal falls in one ISO week."""
  type DetectionWeek {
    """The ISO week, e.g. \`2026-W42\`."""
    isoWeek: String!
    """Monday 00:00 UTC of the week."""
    weekStart: DateTime!
    """Events in range this week, counted plus excluded, bucketed by the same instant that puts them in range (the first ingested Signal, or with none \`firstSignalCreatedAt\`). \`counted / eventsInRange\` is the week's measured coverage."""
    eventsInRange: Int!
    """Counted Events first signalled this week."""
    counted: Int!
    """Of those, first signalled on their onset day."""
    sameDay: Int!
    """Of those, first signalled on their onset day or the day after."""
    byNextDay: Int!
    """True when the range covers only part of the week, e.g. the current week."""
    isPartial: Boolean!
  }

  """Events in range left out of time to detection for one reason."""
  type DetectionExclusion {
    reason: DetectionExclusionReason!
    """Events left out for this reason."""
    count: Int!
  }
`;
