---
status: accepted
date: 2026-10-31
---

# Metric annotations: the changes that should move a metric, as data

A metric on the admin `/metrics` page only means something next to the
changes that were meant to move it. Until now those were a static list in
clear-mvp (`DEPLOY_MARKERS`): three instants typed into the frontend, drawn
on the location-precision chart, wrong by 47 minutes within a day of being
written, and needing a frontend release to add one. The "Progress over time"
section (ADR-0014, ADR-0015) draws markers for whichever metric is picked, so
the list needs to say which metric each change bears on, and admins need to
add a marker the minute a deploy lands
([Exponential #1278](https://www.exponential.im/w/clear/products/clear/tickets/1278)).

**Decision**: markers are rows in clear-api, `metric_annotations`, read by
`metricAnnotations` and written by `createMetricAnnotation` and
`deleteMetricAnnotation`.

- **A row is an instant, a label, and the metrics it bears on** (`metricKeys`,
  values of the `MetricKey` enum of ADR-0015), plus an optional description
  and link (a pull request, a ticket, an ADR) and who created it.
- **Rows are per environment.** A deploy reaches dev and prod at different
  instants, and some changes (a data import) happen on one and not yet the
  other, so each database carries its own markers; nothing is seeded by
  migration. The 2026 markers are entered on dev through the mutation and on
  prod when the same changes reach it.
- **Admin only, and logged.** Reads follow the metrics queries' admin rule;
  each write is an activity-log row (`metric_annotation.create` /
  `metric_annotation.delete`) with the instant, label and keys, so a marker's
  history is recoverable.
- **Validation is small and server-side**: a valid instant, a label of at
  most 120 characters, an http(s) link if any, at least one known metric key.
  The GraphQL enum refuses an unknown key before the service does.
- **Charts place a marker in the bucket holding its instant** (ADR-0014) and
  draw several in one bucket as one line with one label; the page filters to
  the selected dates, so a bucket that reaches past them does not pull in a
  later marker.
- **Not yet**: a GitHub Action that posts a marker on each prod release. The
  mutation is the seam it would call; it needs a service account and a rule
  for which releases bear on which metric, which is a later decision.

## Considered options

- **Keep the static list.** Every change needs a frontend release, the list
  cannot differ by environment, and nothing ties a change to a metric.
- **Derive markers from release tags or deploy logs.** Tags do not say which
  metric a change bears on, and the changes that mattered most this week (a
  gazetteer import, a prompt version) are not releases.
- **A free-text note per chart.** Loses the instant, so the before-and-after
  cannot be computed from it.

## Consequences

- clear-mvp drops `DEPLOY_MARKERS` and reads markers for the selected metric
  and range; it gains a small admin form on `/metrics` for adding and removing
  them.
- The Notion measurement log keeps its prose entries; the rows here are the
  machine-readable half, and a deploy should be recorded in both until the
  log entry can be generated from the row.
- `metricKeys` is stored as text, so a key removed from the registry later
  would surface through the enum as an error; removing a key means
  re-tagging or deleting its markers first.
