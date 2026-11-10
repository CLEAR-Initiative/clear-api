---
status: proposed
date: 2026-11-10
---

# Replay-safe metric history: one grouping log, and three rules for a replay

Every metric on `/metrics` is computed at request time from live rows
(ADR-0015). A replay changes those rows. ADR-0020 fixed location precision
with an append-only Outcome log. This ADR checks the other nine registry
metrics and gives each one a pattern.

This is the result of a spike
([Exponential #1419](https://www.exponential.im/w/clear/products/clear/tickets/1419)).
It changes no production code.

## Terms

| Term | Meaning |
|---|---|
| Geocoding replay | A run that re-locates Signals that a run already finished. It changes `signals.location_id` and `processedAt`. It does not change which Event a Signal is in. |
| Re-grouping replay | A run that groups past Signals again. It changes the Signal-to-Event links, and it can replace Events. No such run exists yet (Dagster migration, D7). |
| Link | One row of `signal_to_events`: a Signal is a member of an Event. |
| Grouping window | The time in which a Live run can add a Signal to an Event: 7 days after the Event's newest Signal (`ACTIVE_EVENTS_WINDOW_DAYS` in clear-pipeline). |
| Settled | An Event is settled when its grouping window has ended. A Live run cannot change a settled Event. |

## What a replay can do today

- **Geocoding replay.** `requeueSignals` sends unlinked Signals through the
  drain again. `updateSignalLocation` sets a new location. Linked Signals keep
  their Events. An Event keeps the location it got when it was created.
- **Re-grouping replay.** Nothing does this. The pipeline never deletes a
  Signal, an Event or an Alert. `deleteEvent` and `deleteAlert` are admin-only.
  `createAlert` returns the existing Alert of an Event, so a retry never
  changes `alerts.created_at`. An Event with an Alert cannot be deleted (the
  foreign key refuses it).

So today only a geocoding replay can happen, and ADR-0020 covers the one
metric it rewrites. The risks below start when someone builds a re-grouping
replay. This ADR must be accepted before that work starts.

## Each metric

| Metric | Mutable columns it reads | Geocoding replay | Re-grouping replay | Pattern |
|---|---|---|---|---|
| `DISTRICT_OR_FINER` | Was: `signals.location_id`, `processed_at`. | Was: every re-located Signal moved to the replay week. | None. | Outcome log (ADR-0020, done). |
| `SIGNALS_GROUPED` | Links. `signals.retracted`. | None. With a location filter, a re-located Signal moves in or out of the place. | Rewrites every past bucket: the links are the metric. | Grouping log. |
| `EVENTS_WITH_ONE_SIGNAL` | Links. Which Events exist. `events.isDummy`. | None, except the location filter. | Rewrites every past bucket. A replaced Event is gone from history. | Grouping log. |
| `DETECTED_BY_NEXT_DAY`, `DETECTED_SAME_DAY` | Links (which ingested Signal is first). `events.started_at` and its accuracy. `events.first_signal_created_at`. | None, except the location filter. | Changes which Signal is first and which Events exist. | Grouping log for the first Signal. The onset stays live (rule 3). |
| `ALERTED_BY_NEXT_DAY`, `ALERTED_SAME_DAY` | `alerts.created_at`. `events.started_at` and its accuracy. | None, except the location filter. | Only if the replay deletes an Alert and creates it again: the Alert then reads as months late. | Safe as it is, under rule 1. |
| `ACLED_EVENTS_ALERTED` | The location of ACLED Signals. Which Alerts exist. The Event's date and places. Links (a non-ACLED member). | ACLED Signals arrive with coordinates, so a text geocoding replay does not move them. | Changes which Events hold a non-ACLED Signal, and their places. | Grouping log for the membership. Rules 1 and 2 for the Alert and the Event. |
| `SOURCES_ON_SCHEDULE` | `signals.collected_at`. `signals.retracted`. | None. | None. | Safe as it is, under rule 2. |
| `EVENTS_ESCALATED` | `events.first_signal_created_at`. The escalations a person made. | None, except the location filter. | A deleted Event takes its escalations with it (cascade). That loses a person's work, not only a chart. | Safe as it is, under rule 2. |

"Frozen closed buckets" is chosen for no metric. See "Considered options".

## Decision

### 1. A grouping log

clear-api keeps an append-only log of Links, as ADR-0020 does for locations.

- **One row per Link that a pipeline run makes**: `signalId`, `eventId`,
  `linkedAt`, `runKind` (`LIVE` or `REPLAY`), `pipelineVersion`, `runId`.
  `eventId` is plain text with no foreign key, so a row outlives its Event.
- **clear-api writes the row** in the mutations that create Links
  (`createEvent`, `updateEvent` with `signalIds`), in the same transaction.
- **A Link that a person makes writes no row** (analyst splits and merges,
  [#1268](https://www.exponential.im/w/clear/products/clear/tickets/1268)).
  The metric measures the pipeline.
- **History series**: `SIGNALS_GROUPED`, `EVENTS_WITH_ONE_SIGNAL`, the first
  ingested Signal of time to detection, and the non-ACLED membership of
  `ACLED_EVENTS_ALERTED` read the `LIVE` rows. They no longer read
  `signal_to_events`.
- **Backfill**: one `LIVE` row per existing Link, with `linkedAt` from
  `signal_to_events.collected_at`.
- **The series contract does not change** (ADR-0015).

### 2. Which instant is "the result at the time" for grouping

A Signal that is alone today can gain company next week. This is the Live
run at work, not a replay. The log keeps it, because a late Live Link is a
`LIVE` row like any other.

- The result at the time is **the set of `LIVE` rows**. No instant is frozen.
- A bucket can still change while an Event in it is not settled. After that,
  only a replay could change it, and a replay writes `REPLAY` rows.
- So a bucket is **final** when every Event in it is settled. In practice
  this is 7 days after the newest Signal of its Events. A long-running Event
  keeps its buckets open for as long as Signals arrive.
- The API does not mark final buckets in the first version. The page already
  marks a partly covered bucket (`isPartial`). A "not final yet" mark is a
  later option.

This is why a snapshot does not fit: a snapshot needs an instant, and
grouping has none.

### 3. Three rules for any replay

These rules make the other metrics safe without a second store. Each is a
rule for the code that runs a replay, and each needs a test in the pull
request that builds a re-grouping replay.

1. **A replay never deletes an Alert and never creates a second Alert for
   the same real-world event.** When a replay moves an alerted Event's
   Signals to another Event, it moves the Alert (`alerts.event_id`). The
   Alert keeps its `created_at`. Time to alert then needs no log.
2. **A replay never deletes a Signal or an Event.** A replaced Event is kept
   and marked as replaced; live views leave it out. Its onset, its places and
   its escalations stay readable. Source health and Events escalated then
   need no log.
3. **The onset is the yardstick, not the result.** Time to detection and
   time to alert measure two instants that the pipeline produced (the first
   Signal, the Alert) against the Event's onset. A replay that extracts a
   better onset makes the old measurement more correct. The metrics read the
   live onset, as today.

## Considered options

- **Frozen closed buckets** for the grouping metrics: a table of (metric,
  bucket, group, numerator, denominator), written when a bucket closes.
  Rejected. Grouping has no closing instant that is safe for all Events (see
  decision 2). The table also freezes today's definition, and it gives no
  replay line.
- **An Alert log** with the instant each Alert was first raised. Rejected for
  now: rule 1 gives the same result with no table. If rule 1 proves hard to
  keep in a re-grouping replay, add the log then.
- **An Event facts log** (onset, places) written on each aggregate change.
  Rejected: many writes per Event, and rule 2 keeps the Event row itself.
- **A log per metric.** Rejected: four metrics read the same Links.
- **Shadow grouping**: a replay writes only to the log and never changes
  live Links. Safe, but the product would keep the old grouping. The point of
  a replay is to improve what people see.

## Consequences

- One new table and two write paths. A re-grouping replay of N Links adds N
  rows.
- The grouping metrics get a replay line with no more design: the `REPLAY`
  rows of one run, bucketed as the history series is.
- Rule 2 needs a "replaced" state on Events. That is a schema change in the
  re-grouping replay work, not here.
- The location filter of every Signal-based metric still reads the Signal's
  current location. A geocoding replay moves Signals between places in a
  filtered view. This ADR leaves that as it is: the unfiltered series is the
  one a deploy is judged on.
- `signals.retracted` and `isDummy` stay live in every metric, as ADR-0011
  defines an ingested Signal.

## Open points for a person

- **Rule 3.** Is the live onset correct for history, or must the onset also
  be kept as each pipeline version gave it? This decides whether the
  detection and alert metrics need more than rule 1.
- **Rule 2.** Is "keep and mark as replaced" acceptable for Events, or will
  a re-grouping replay delete them? If it deletes, the Event facts log and
  the Alert log are needed after all.
- **Final buckets.** Does the page need a "not final yet" mark on the
  grouping charts?
