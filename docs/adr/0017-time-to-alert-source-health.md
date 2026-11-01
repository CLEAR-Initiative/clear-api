---
status: accepted
date: 2026-11-01
---

# Time to alert, source health and events escalated as registry metrics

The Notion Metrics table lists what CLEAR tracks to know whether solving a
problem improved it. After the registry (ADR-0015) three of its rows were
live: time to detection as two shares (ADR-0011) and location precision
(ADR-0012). Two more are computable from stored rows today and were asked for
under [Exponential #1266](https://www.exponential.im/w/clear/products/clear/tickets/1266):
**Time to alert** (the row's own measure is median onset-to-publish time, and
nothing records a publish instant yet) and **Source health** (whether each
feed still delivers). A third, **Time to action** / **Actionability**, needs
decisions nobody can record yet
([#1268](https://www.exponential.im/w/clear/products/clear/tickets/1268)),
but one human decision is already stored: an analyst escalating an Event.

On dev at the end of October 2026 an Alert follows its Event's first Signal by
a median of 1.2 hours (only 2 of 1,281 within a minute), so alerting is a step
of its own, not a restatement of detection. The real feeds are seven named
sources with cadences from daily to monthly, beside about 170 `organisation`
rows that report datapoints cite and never carry a Signal. Nothing in
clear-api or clear-mvp writes `userAlerts.viewedAt`, so an alert-view share
would read zero forever.

**Decision**: four more registry entries, each a share per bucket read by the
same `metricSeries` contract, defined as follows.

- **Alerted by next day** and **Alerted same day** (`ALERTED_BY_NEXT_DAY`,
  `ALERTED_SAME_DAY`, Timeliness, unit Events). Days = UTC calendar days
  from the Event's onset to the Alert's `createdAt`; same day = 0, next day
  = 1. An Alert is **measured** when its Event has a day-precise onset on or
  before the Alert's creation day; otherwise it is excluded under one reason,
  in order: `NO_ONSET`, `COARSE_ONSET`, `BEFORE_ONSET`. An Alert is in range
  by its `createdAt`; **every status counts**: an Alert archived later was
  still raised when it was created, and one the pipeline created already
  archived (a suppressed stale Event) is a late Alert, not no Alert. Dummy
  Events take no part. The location filter is the Event's, as for time to
  detection. The Notion row's median is not served: a median is not a share,
  and the by-next-day share answers the same question in the same shape as
  detection, so the two can be read side by side.
- **Sources on schedule** (`SOURCES_ON_SCHEDULE`, Reliability, unit
  source-days, groupable by source). `EXPECTED_CADENCE_DAYS` in
  `src/services/source-health-metrics.ts` lists the feeds CLEAR expects and
  the most days that may pass between two deliveries: dataminr, sudan-war-x
  and darfur24 daily; ACLED weekly; IDMC and Sudan Witness fortnightly; DTM
  monthly. On each UTC day a source is **on schedule** when it delivered an
  ingested Signal (by `collectedAt`, the instant CLEAR received it) that day
  or within the cadence before it. A bucket's measure for a source is
  on-schedule days over days measured; only days that have ended before now
  are judged, so a feed is never marked late for a day still running.
  Ungrouped, every expected source's days add up: the share of expected
  source-days met. Sources outside the list are not measured: organisation
  rows, manual channels (field officers, WhatsApp, e-mail) and event-driven
  feeds such as GDACS that are silent when nothing happens. The location
  filter does not apply. The list lives in code, not in `data_sources`,
  because it is a statement of expectation the team revises in review, not a
  property of the source row.
- **Events escalated** (`EVENTS_ESCALATED`, Usefulness, unit Events). The
  share of Events a user escalated (`escalateEvent`, which also raises the
  Alert), out of every non-dummy Event whose `firstSignalCreatedAt` falls in
  the bucket; an Event escalated by two users counts once, and the
  escalation's week-long window does not matter. An interim proxy, named as
  such in its description, until #1268 records actionability.

Each entry reads from a service of its own (`time-to-alert-metrics.ts`,
`source-health-metrics.ts`, `escalation-metrics.ts`) on the shared bucket
helpers (ADR-0014) and the shared Event location scope, so the registry still
defines nothing. Counts only; shares are the caller's.

## Considered options

- **Median days to alert, as the Notion row says.** A median is a value, not
  a share, and would need a second series shape and a second chart; the
  by-next-day share carries the same signal and lines up with detection.
- **Alert publish time rather than creation.** There is no publish instant:
  `alerts.updatedAt` moves on every status change. Creation is the instant
  the pipeline or an analyst raised the Alert, which is the step being timed.
- **Count published Alerts only.** `archiveStaleAlerts` would then rewrite
  past buckets as old Alerts are archived, and the pipeline's
  created-archived Alerts (suppressed stale Events) would vanish rather than
  read as late.
- **Cadence as a column on `data_sources`.** Editable by admins, but then an
  unset column silently drops a feed from the measure; a reviewed list fails
  loudly in a test when a feed is added without a cadence.
- **A `delivered this week` share per source.** Reads 14% for a healthy
  weekly feed on daily buckets; judging each day against the feed's own
  cadence reads 100% for any healthy feed at any bucket size.
- **An alert-view share from `userAlerts.viewedAt`.** Nothing writes it;
  deferred to #1268 with the acknowledge decision.

## Consequences

- The Notion rows Time to alert and Source health become Tracked with
  baselines and Chart links; Actionability gets its interim proxy noted.
- clear-mvp shows the registry's English names and `n = N` for source-days
  until its messages carry the four new keys and the unit.
- A new feed needs an `EXPECTED_CADENCE_DAYS` entry to be measured; a
  retired feed needs its entry removed, or it reads as permanently late.
- When #1268 records acknowledgements and actionability, Events escalated is
  replaced or kept beside them, and an alert-view share becomes possible.
