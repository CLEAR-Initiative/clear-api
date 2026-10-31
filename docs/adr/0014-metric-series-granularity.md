---
status: accepted
date: 2026-10-31
---

# Metric series by day, week or month

Time to detection (ADR-0011) and location precision (ADR-0012) each return one
weekly series. A change that lands mid-week is invisible at that resolution:
the 29 Oct 2026 geocoding deploy (18:33 UTC) moved `sudan-war-x` from 31% to
64% at district or finer from one day to the next, and week 44 read 42%. The
admin `/metrics` page needs a metric by day for a recent range, by week for a
quarter and by month for a year
([Exponential #1275](https://www.exponential.im/w/clear/products/clear/tickets/1275),
[#1276](https://www.exponential.im/w/clear/products/clear/tickets/1276)), and
the next metrics
([#1277](https://www.exponential.im/w/clear/products/clear/tickets/1277)) need
one bucket rule rather than one each.

**Decision**: every metric series is read in one of three **buckets**, chosen
by the caller as a `MetricGranularity`: `DAY`, `WEEK` (the default) or `MONTH`.

- **Buckets are UTC**: a calendar day from 00:00 UTC; an ISO week from Monday
  00:00 UTC; a calendar month from the first at 00:00 UTC. No local time zone
  takes part, so a bucket never shifts with the reader's clock.
- **Labels**: `2026-10-29` for a day, `2026-W44` for an ISO week (the week-year
  rule of ADR-0011) and `2026-10` for a month. `start` carries the bucket's
  first instant, so a chart can place it on a time axis.
- **Zero-filled and ascending**: a series has one row per bucket the range
  touches, from the bucket holding `from` to the bucket holding `to`, whether
  or not anything landed in it. A per-source series repeats that run per
  source, in `bySource` order.
- **Partial**: a bucket is `isPartial` when the range covers only part of it:
  it starts before `from`, or ends after `to` (`to` is inclusive, so a range
  ending at a bucket's last millisecond covers it). The current bucket is
  partial until it closes; a chart draws it hollow.
- **The instant that buckets a row is the metric's own**: the first ingested
  Signal for time to detection, the located-at instant for location
  precision. Granularity changes the bucket size, never the instant.
- **`weekly` stays.** Both queries keep their `weekly` field for the cards that
  read it; `series` at `WEEK` is the same rows in the bucket shape. A generic
  series query (#1277) reads `series` only.
- **Size**: a range is at most 364 days (ADR-0011), so `DAY` yields at most 365
  buckets per source: a few thousand rows for location precision, which the
  page handles without paging.

The helpers live in `src/services/detection-metrics.ts` (`startOfBucket`,
`nextBucketStart`, `bucketLabel`, `bucketsOf`, `bucketIndex`,
`resolveGranularity`) and every metric service uses them.

## Considered options

- **A `daily` / `weekly` / `monthly` field per query.** Three fields times
  every metric, and a client that switches granularity re-reads three shapes.
- **Returning days and letting clear-mvp roll them up.** It moves the
  definition of a week and of a partial bucket into the frontend, against the
  rule that clear-api owns the metric definitions and clear-mvp only formats
  them.
- **Calendar weeks starting Sunday, or local months.** Rejected to keep one
  clock (UTC, ISO) across every metric and every reader.

## Consequences

- ADR-0011 and ADR-0012 read "ISO week" as the default bucket; their weekly
  rows are unchanged, and `series` at `WEEK` equals them row for row (tested).
- A new metric gets day, week and month from the same helper, so the buckets
  behave the same everywhere; the registry in #1277 builds on this.
- Daily points on a low-volume source are noisy. The page shows n per point
  and marks small buckets; the API does not hide them.
