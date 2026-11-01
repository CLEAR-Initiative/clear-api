---
status: accepted
date: 2026-11-01
---

# Grouping and detection-recall proxies as registry metrics

Two Notion Metrics rows have no analyst input yet: **Event grouping
accuracy** (duplicate Events, or separate ones wrongly merged) and
**Detection recall** (real events CLEAR misses entirely). The first needs
analysts to record splits and merges
([Exponential #1268](https://www.exponential.im/w/clear/products/clear/tickets/1268));
the second needs a ground-truth event list. Neither exists, yet each has an
honest proxy computable from stored rows today, asked for under
[#1267](https://www.exponential.im/w/clear/products/clear/tickets/1267).

On dev in October 2026, 87% of Events held a single ingested Signal; the
share of a feed's Signals that shared an Event ran from 1% (darfur24) to 72%
(Dataminr); and ACLED, which CLEAR ingests as a feed, had every one of its
Signals placed at a point under a district, so its events can be matched to
CLEAR's Alerts by district and date.

**Decision**: three more registry entries (ADR-0015), each named as a proxy
in its description and served by the same `metricSeries` contract.

- **Signals grouped** (`SIGNALS_GROUPED`, Accuracy, unit Signals, groupable
  by source): the share of ingested Signals whose Event holds at least one
  other ingested Signal, out of every ingested Signal that has been through
  grouping (linked to an Event), by the Signal's `publishedAt`. Signals still
  waiting to be grouped do not drag the share down.
- **Events with one Signal** (`EVENTS_WITH_ONE_SIGNAL`, Accuracy, unit
  Events, groupable by the source of the Event's first ingested Signal): the
  share of Events holding exactly one ingested Signal, out of every Event
  with an ingested Signal in range, by that first Signal's `publishedAt`.
  Events with only history or manual Signals are not CLEAR groupings and are
  left out, as in time to detection.
- **ACLED events alerted nearby** (`ACLED_EVENTS_ALERTED`, Coverage, unit
  ACLED events): each ACLED Signal is one ACLED event, dated by `publishedAt`
  (the event date at 00:00 UTC) and placed at a point; its district is the
  level-2 location among its location and ancestors. It counts as alerted
  nearby when its district held a CLEAR Alert whose Event is dated within
  `RECALL_WINDOW_DAYS` (3) UTC days either side and holds at least one
  ingested Signal from a source other than ACLED, so only what CLEAR found
  through its other feeds counts. An Event is dated by its onset when that is
  day-precise, else by its first Signal: a week- or month-precise onset is
  not a date, as ADR-0011 and ADR-0017 hold, and would credit the ACLED
  events around the 1st of the month instead of the ones the Event covers.
  An Event is in a district through any of its places (general location,
  origin, destination), as every Event metric reads places. An ACLED event
  with no district counts as not alerted. The reference feed and the window
  are constants in `src/services/recall-metrics.ts`; a test holds that the
  reference feed is one of the expected feeds of ADR-0017, so a rename is
  made in one place and source health flags ACLED when it stops delivering.

**Scope and edges.** The location filter reads each proxy's own object:
Signals grouped and the ACLED reference set keep the Signals whose current
location (general, else origin, else destination) is in the place; Events
with one Signal keeps the Events any of whose places is in it. Location
precision alone reads a corrected Signal where the pipeline put it
(ADR-0012); grouping keys on where a Signal is now. A Signal linked to two
Events counts once, grouped when either Event gives it company. Under a
location filter an ACLED event with no location is not in the location at
all. The newest buckets of all three read before grouping and alerting have
caught up: low for Signals grouped and the recall proxy (whose last three
days cannot yet hold their Alerts, while ACLED releases weekly), high for
Events with one Signal; `isPartial` says only whether the range covers the
bucket, so the descriptions say this instead.

**Query shape.** The recall query makes one pass over the alerted Events in
the window, expands each into the (district, day) pairs its window covers,
and joins the ACLED events to that set on equality, which Postgres hashes:
0.2 s for twelve weeks and 0.4 s for a year on dev. The first draft tested
every ACLED row against every Event (9.7 s on a synthetic 100k-row
database); a correlated test against the precomputed set was still re-run
per ACLED row (24 s inlined, 3.4 s materialised), so the match is a join. Both grouping queries and
the first-ingested-Signal CTEs look `signal_to_events` up by Event, which
only the unique `(signal_id, event_id)` index served; the migration in this
change adds `signal_to_events(event_id)`, the step ADR-0011 named for when a
metric got slow (measured 83 s to 0.3 s for Signals grouped once the planner
stops hashing the sub-plan).

Neither grouping proxy is a judgement. A high grouped share can be good
merging or over-merging; a high single-Signal share can be under-merging or
many isolated reports. They are read beside each other and, once it exists,
beside the correctness sample; what they do show today is movement when
grouping changes. The share of Signals with no district, listed in the
ticket, is the complement of "At district or finer" (ADR-0012) and is not
served twice.

## Considered options

- **Signals per Event as a ratio.** A ratio is not a share, and the page
  formats every metric as one; the grouped-Signal share carries the same
  signal in the registry's shape.
- **Recall against an external ACLED export.** ACLED is already ingested as
  a feed, so its Signals are the export, kept current by the pipeline.
- **Crediting any Alert in the district.** An Alert ACLED alone drove is
  CLEAR repeating ACLED, not CLEAR detecting; only Alerts with another feed's
  ingested Signal count.
- **Matching by point distance rather than district.** Grouping keys on
  district, and ACLED's own geocoding is to the admin-2 level.
- **A fatalities floor on the reference events.** Deferred: ACLED's
  fatalities field would let the proxy ask about the events that matter most,
  but the first read is over all of them.

## Consequences

- The Notion rows Event grouping accuracy and Detection recall become
  Instrumenting, with the proxies' baselines and Chart links.
- When #1268 records splits and merges, the grouping proxies stay as context
  beside the recorded rate rather than being removed.
- The recall proxy's window and reference feed are reviewed in code; a
  second reference dataset (OCHA situation reports) would be a second entry.
- A renamed or silent ACLED feed empties the reference set: every bucket
  reads 0 of 0, which the page shows as no reading, not 0%; source health
  shows ACLED late at the same time.
- `signal_to_events(event_id)` is indexed from this change on.
