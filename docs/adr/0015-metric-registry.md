---
status: accepted
date: 2026-10-31
---

# A metric registry and one series contract for the /metrics page

Every metric on the admin `/metrics` page in clear-mvp has been its own
query, its own types and its own card: time to detection (ADR-0011), location
precision (ADR-0012), agent usage (ADR-0013). The page now has a "Progress
over time" section that plots one metric at a time by day, week or month
([Exponential #1276](https://www.exponential.im/w/clear/products/clear/tickets/1276)),
and the next metrics on the list (grouping proxies, time to alert, source
health, detection recall:
[#1266](https://www.exponential.im/w/clear/products/clear/tickets/1266),
[#1267](https://www.exponential.im/w/clear/products/clear/tickets/1267))
would each add a query, a type, a resolver and a card. The frontend had
started to encode which query serves which metric and how to turn its counts
into a share, which is a definition leaking out of clear-api.

**Decision**: clear-api keeps a **metric registry**, one entry per metric the
page can plot, and serves every entry through **one series contract**
([#1277](https://www.exponential.im/w/clear/products/clear/tickets/1277)).

- **A metric is a share per bucket**: `numerator / denominator`, read by day,
  ISO week or calendar month (ADR-0014), optionally split into **groups**
  (today by data source, `groupBy: SOURCE`). `metricSeries(input)` returns
  `{ metric, granularity, from, to, groups, buckets[] }`, each bucket
  `{ start, label, isPartial, group, numerator, denominator }`. Counts only;
  shares are the caller's.
- **The registry defines nothing.** Each entry reads its series from the
  service that owns the metric (`computeDetectionMetrics`,
  `computeLocationPrecisionMetrics`), mapping that service's rows into the
  bucket shape. The generic series therefore equals the metric's own query row
  for row, which a test pins. A new metric is one entry in
  `src/services/metric-registry.ts` and one value in the `MetricKey` enum; a
  metric with its own service keeps it, a simple one can be a SQL pair.
- **The registry carries the text**: `name`, `dimension` (the Notion Metrics
  table's), `unit` (what the denominator counts), `description` (the method
  in one paragraph), `timeBasis` (the instant that buckets a row), `adr`,
  `groupable`. `metricDefinitions` lists it, so clear-mvp builds its selector
  from the API and shows the same words the Notion rows quote. clear-mvp
  still owns the translations of the names; a metric without one shows the
  registry's English name until it is translated.
- **Keys are GraphQL enum values** (`DETECTED_BY_NEXT_DAY`,
  `DETECTED_SAME_DAY`, `DISTRICT_OR_FINER`), so an unknown metric fails at
  validation, and clients get the list from the schema and the definitions
  from the query.
- **Errors are the owning service's**: an inverted range, a span over 364
  days or an unknown granularity fail as they do on the metric's own query; a
  `groupBy` the metric does not support is `BAD_USER_INPUT`.
- **The bespoke queries stay.** `detectionMetrics`, `locationPrecisionMetrics`
  and `agentMetrics` carry what a series cannot (histograms, exclusions, level
  breakdowns, corrections), and their cards read them. Only the over-time
  view moves to `metricSeries`.

## Considered options

- **Keep adding a query per metric.** Four more queries and cards for the next
  four metrics, each re-deciding the week, the partial flag and the share.
- **A registry in clear-mvp.** It would decide which query serves a metric and
  how to read it, against the rule that clear-api owns metric definitions and
  clear-mvp only formats them.
- **A fully generic SQL engine** (a `MetricDefinition` table with SQL text).
  Not needed for a dozen metrics, and it would move definitions out of code
  review and tests.

## Consequences

- #1266 and #1267 become registry entries: each new metric is a reader over
  its own SQL plus its text, and it appears in the page's selector without a
  frontend change beyond a translated name.
- Markers that bear on a metric are a frontend list today; when they become
  data (#1278) they will be tagged with `MetricKey` values.
- Two queries per metric exist for the three migrated metrics (the bespoke
  one and `metricSeries`); both read the same service, so there is nothing to
  keep in sync.
