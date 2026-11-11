---
status: accepted
date: 2026-11-10
---

# Replay-safe metric history: two logs, two views, and rules for a replay

Every metric on `/metrics` is computed at request time from live rows
(ADR-0015). A replay changes those rows. ADR-0020 fixed location precision
with an append-only Outcome log. This ADR checks the other nine registry
metrics and gives each one a pattern.

The charts exist to show, with data, that work on the pipeline makes CLEAR
better. So the first rule is: **a past bucket shows what the pipeline
delivered at the time, and no later run changes it.** A replay, a re-grouping
or a better prompt must never rewrite the record of an old pipeline version.

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
| Onset | The date the real-world event started (`events.started_at`). The pipeline extracts it from the Signals. It is an estimate, and a run can write a new one. |
| As delivered | A view of a metric: every value as the Live run gave it at the time. The default, and the frozen one. |
| Same ruler | A second view: the instants the Live run produced, measured against the onset known today. |

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
| `DETECTED_BY_NEXT_DAY`, `DETECTED_SAME_DAY` | Links (which ingested Signal is first). `events.started_at` and its accuracy. `events.first_signal_created_at`. | None, except the location filter. | Changes which Signal is first and which Events exist. | Grouping log for the first Signal. Event facts log for the onset (decision 3). |
| `ALERTED_BY_NEXT_DAY`, `ALERTED_SAME_DAY` | `alerts.created_at`. `events.started_at` and its accuracy. | None, except the location filter. | A replacement Event has the new pipeline's onset, so an old Alert is measured against a new ruler. If the replay deletes an Alert and creates it again, the Alert reads as months late. | The onset is copied onto the Alert when it is raised (decision 3). Rule 1 keeps the Alert. |
| `ACLED_EVENTS_ALERTED` | The location of ACLED Signals. Which Alerts exist. The Event's date and places. Links (a non-ACLED member). | ACLED Signals arrive with coordinates, so a text geocoding replay does not move them. | Changes which Events hold a non-ACLED Signal, and their places. Moves Alerts to replacement Events. | Grouping log for the membership and for the set of Events (decision 5). Event facts log for the Event's date and places (decision 3). Rules 1 and 2 for the Alert and the Event. |
| `SOURCES_ON_SCHEDULE` | `signals.collected_at`. `signals.retracted`. | None. | None. | Safe as it is, under rule 2. |
| `EVENTS_ESCALATED` | Which Events exist. `events.first_signal_created_at`. The escalations a person made. | None, except the location filter. | A deleted Event takes its escalations with it (cascade). That loses a person's work, not only a chart. A replacement Event also adds one Event to a past bucket. | Grouping log for the set of Events (decision 5). Rule 2 for the escalations. |

"Frozen closed buckets" is chosen for no metric. See "Considered options".

## Decision

### 1. A grouping log

clear-api keeps an append-only log of Links, as ADR-0020 does for locations.

- **One row per Link that a pipeline run makes**: `signalId`, `eventId`,
  `linkedAt`, `runKind` (`LIVE` or `REPLAY`), `pipelineVersion`, `runId`.
  `eventId` is plain text with no foreign key, so a row outlives its Event.
- **clear-api writes the row** in the mutations that create Links
  (`createEvent`, `updateEvent` with `signalIds`), in the same transaction.
- **The pipeline is the caller with an API key.** clear-api writes a row
  only for a call with an API key. A person reaches clear-api with a session
  (clear-mvp sends the user's cookie), so a person's Link writes no row.
  Known limit: an admin who calls a mutation by hand with a personal API key
  writes a row. The pipeline's key belongs to an admin user today, so the
  role cannot tell the two apart. A service identity for the pipeline would
  close this; it is not part of this work.
- **A Link that a person makes writes no row** (analyst splits and merges,
  [#1268](https://www.exponential.im/w/clear/products/clear/tickets/1268)).
  The metric measures the pipeline.
- **History series**: `SIGNALS_GROUPED`, `EVENTS_WITH_ONE_SIGNAL`, the first
  ingested Signal of time to detection, and the non-ACLED membership of
  `ACLED_EVENTS_ALERTED` read the `LIVE` rows. They no longer read
  `signal_to_events`.
- **A Signal is grouped** in the history series when the Event of its
  `LIVE` row has one of these:
  1. a `LIVE` row for another ingested Signal;
  2. a row of any run kind for another ingested Signal, with a `linkedAt`
     that is not later than the `linkedAt` of the Signal's own `LIVE` row.

  Rule 1 gives the first Signal of an Event its company when a later Signal
  joins. Rule 2 covers a Signal that a Live run adds to an Event whose other
  Signals a replay put there: those have `REPLAY` rows only. The limit on
  `linkedAt` keeps a replay out of the past: a Signal that a replay adds to
  an Event later gives no company to a Signal that was alone.
- **The reader checks the other Signal at read time.** The log stores no
  "joined others" flag. A stored flag would keep a Signal grouped after its
  only companion is retracted, and `retracted` stays live in every metric
  (see "Consequences").
- **Known limit: a companion that left.** The log records Links, not the
  end of a Link. Rule 2 can count a Signal that a replay put in the Event
  and a later replay moved away before the Live run made its Link. The
  result is wrong only when no other ingested Signal was in the Event then.
  The re-grouping replay work decides how a move is recorded (for example a
  row for the end of a Link). Until a replay exists, no `REPLAY` row exists
  and rule 2 counts nothing.
- **Backfill**: one `LIVE` row per existing Link, with `linkedAt` from
  `signal_to_events.collected_at`. A Link that a person made before the log
  gets a row too: `signal_to_events` does not say who made a Link, and the
  metrics counted these Links, so the series do not move at the switch.
- **The series contract does not change** (ADR-0015).

### 2. Which instant is "the result at the time" for grouping

A Signal that is alone today can gain company next week. This is the Live
run at work, not a replay. The log keeps it, because a late Live Link is a
`LIVE` row like any other.

- The result at the time is **the set of `LIVE` rows**. No instant is frozen.
- An Event can still change while it is not settled. After that, only a
  replay could change it, and a replay writes `REPLAY` rows. In practice an
  Event settles 7 days after its newest Signal. A long-running Event stays
  open for as long as Signals arrive.
- A **bucket** is never final in the strict sense. The charts bucket by
  `publishedAt`, and sources deliver late and backdated Signals. A Live run
  can make a new Event from an old Signal and add it to an old bucket. This
  is also a Live result, and the history series shows it. The log keeps the
  history safe from a replay, not from late data.
- The API does not mark settled Events or buckets in the first version. The
  page already marks a partly covered bucket (`isPartial`). A "may still
  change" mark is a later option.

This is why a snapshot does not fit: a snapshot needs an instant, and
grouping has none.

### 3. An Event facts log, and the onset on the Alert

Time to detection and time to alert measure a delay from the Event's onset.
The onset is the pipeline's result too: a run extracts it, and a later run
can write another. If the charts read the onset from the live Event, a
better onset prompt or a re-grouping rewrites past buckets. So the onset is
kept as each run gave it.

- **The Event facts log** is append-only. One row records the facts that one
  run gave one Event: `eventId` (plain text, no foreign key), `recordedAt`,
  `startedAt`, `startedAtAccuracy`, `firstSignalCreatedAt`, the place ids
  (general, origin, destination) with the district of each, `runKind`,
  `pipelineVersion`, `runId`.
- **clear-api writes a row** in the mutations that set these facts
  (`createEvent`, `updateEvent`, `setEventAggregates`), in the same
  transaction. It writes no row when the facts did not change and the run
  already has a row for the Event. So each run that writes an Event has one
  row for it at least, and a Replay run's series finds the facts that run
  used, also when they equal the Live facts.
- **`LIVE` and `REPLAY`**: a row from the drain is `LIVE`, also when the
  drain recomputes an Event after a Signal joined or a source revised a
  Signal. Event facts mature while the Event is open, and that is the Live
  run at work. A row from a replay job is `REPLAY`. This differs from the
  Outcome log of ADR-0020, where a second placement is always a replay.
- **A person's edit writes no row.**
- **The Alert holds the onset it was raised on.** `createAlert` copies the
  Event's onset and its accuracy onto the Alert (`onset_at_raise`,
  `onset_accuracy_at_raise`). No mutation changes them. The Alert is never
  deleted (rule 1), so no Alert log is needed.
- **Backfill**: one `LIVE` row per existing Event with its current facts, and
  the current onset onto each existing Alert. The series do not move at the
  switch.

### 4. Two views of the delay metrics

Both views are kept. Each answers a question that the other cannot.

| | As delivered | Same ruler |
|---|---|---|
| Question | What did the pipeline tell us then? Is each deploy better than the last? | Against the best onset we now know, how late were we? |
| Use | Proof that the work pays off: before and after a deploy. | An honest reading of how timely CLEAR is, with one ruler for every week. |
| Onset | Time to alert: the onset on the Alert. Time to detection and the ACLED proxy: the last `LIVE` row of the Event facts log. | The onset of the live Event (for a replaced Event, its final replacement, ADR-0022). |
| Instants | The first ingested Signal from the `LIVE` rows of the grouping log. `alerts.created_at`. | The same. |
| Past buckets | Do not move after the Event settles. No replay moves them. | Move when the onset changes. Every bucket is measured with one ruler, so buckets compare fairly. |
| Blind spot | An old extractor that read onsets too late makes old buckets look fast. | It cannot tell "alerts got faster" from "onsets got more accurate". |

- **As delivered is the history series**, and the default of `metricSeries`.
  It is the series a deploy is judged on.
- **Same ruler is a second series** of the same metric. `metricSeries` takes
  an optional `onsetBasis` (`AS_DELIVERED`, the default, or `CURRENT`). The
  bucket shape does not change.
- **The replay series** of ADR-0020 is a third thing: one Replay run's own
  results for the same Signals. A re-grouping replay gets one from its
  `REPLAY` rows in both logs.
- **Both views are for platform admins only**, and both are on `/metrics`
  (decided 11 Nov 2026, James). The page has two tabs, "As delivered" and
  "Same ruler". Each tab says in one sentence what it shows and what it is
  for. The tab is in the URL. `metricSeries` stays admin-only for both
  values of `onsetBasis`. No other role reads either view.

### 5. Rules for any replay

Each is a rule for the code that runs a replay. Each needs a test in the
pull request that builds a re-grouping replay.

1. **A replay never deletes an Alert and never raises a second Alert for the
   same real-world event.** When a replay moves an alerted Event's Signals to
   another Event, the Alert goes with them (ADR-0022 says which Alert when
   there are several). The Alert keeps its `created_at` and the onset it was
   raised on.
2. **A replay never deletes a Signal or an Event.** A replaced Event is kept
   and marked as replaced, with the id of the Event that replaced it; live
   views leave it out. ADR-0022 holds the full rule: the mark, what moves to
   the replacement, and who sees a replaced Event.
3. **A replay writes `REPLAY` rows and changes no `LIVE` row.** It sends its
   run kind on every mutation that writes to a log. After a re-grouping
   replay, every As delivered series is the same as before it. The test:
   read each registry metric, run the replay, read each metric again, and
   compare.

### 6. The Events of a history series

Rules 1 and 2 keep the rows. They do not say which Events a history series
counts. After a re-grouping replay, a replaced Event and its replacement
both exist, and the Alert is on the replacement.

- **The Events of a history series are the Events that a Replay run did not
  create.** An Event records the kind of run that created it
  (`events.created_by_run_kind`: `LIVE`, `REPLAY`, or null when a person
  created it). `createEvent` sets it once, from the run kind the pipeline
  sends, and no mutation changes it. An Event that a replay created is never
  in a history series, whatever joins it later. This applies to every
  Event-based metric: Events with one Signal, time to detection,
  `EVENTS_ESCALATED` and the Alert side of `ACLED_EVENTS_ALERTED`.
- **Why the origin is on the Event, and not read from the Links.** The first
  draft counted an Event when it had a `LIVE` Link. That fails in this case:
  in August the pipeline makes Events A, B and C. In November a replay
  merges them into a new Event D. The next day a new Signal about the same
  attack arrives, and the drain adds it to D, which is the live Event. D now
  has a `LIVE` Link, and its oldest Signal is from August, so August would
  show four Events and not three. With the origin on the Event, August
  keeps three.
- **A Signal that a Live run adds to a replay-created Event still counts for
  the Signal.** It is in `SIGNALS_GROUPED` for its own bucket, as grouped:
  the Event held other Signals, with `REPLAY` rows, when the Live run made
  the Link (decision 1, rule 2). It adds no Event to an
  Event-based series.
- **A history reader follows a replaced Event to its replacement** to find
  what a person or a later run attached there. A replaced Event counts as
  alerted when it or its replacement has an Alert, and as escalated when it
  or its replacement has an escalation.
- Time to alert reads Alerts, not Events. It counts every Alert that a Live
  run raised, also an Alert that now sits archived on a replaced Event
  (ADR-0022). An Alert that a Replay run raised is not counted.
- An Event that a person created (a web case, a manual Signal) has no run
  kind. `EVENTS_ESCALATED` counts those Events today, and its history series
  keeps them.
- **Backfill**: every existing Event that holds an ingested Signal gets
  `LIVE`. No replay has created an Event yet.

## Considered options

- **Frozen closed buckets** for the grouping metrics: a table of (metric,
  bucket, group, numerator, denominator), written when a bucket closes.
  Rejected. Grouping has no closing instant that is safe for all Events (see
  decision 2). The table also freezes today's definition, and it gives no
  replay line.
- **An Alert log** with the instant each Alert was first raised. Rejected:
  rule 1 keeps the Alert row, and two columns on it hold the onset.
- **The live onset for history** ("the onset is the yardstick, not the
  result"). This was the first draft of this ADR. Rejected for the history
  series: a better onset prompt or a re-grouping would move past buckets, and
  the charts could not show what each deploy delivered. It is kept as the
  Same ruler view.
- **Only the Same ruler view, or only As delivered.** Rejected: each has a
  blind spot that the other shows (decision 4).
- **A replay-created Event enters history at its first `LIVE` Link**, dated
  by that Signal. Rejected: an attack of August would show as a new Event of
  November, and its detection delay would read as months.
- **The onset in the grouping log.** Rejected: an onset changes without a new
  Link, and a Link is made without a new onset.
- **A log per metric.** Rejected: four metrics read the same Links.
- **Shadow grouping**: a replay writes only to the log and never changes
  live Links. Safe, but the product would keep the old grouping. The point of
  a replay is to improve what people see.

## Consequences

- Two new tables (the grouping log, the Event facts log), two columns on
  `alerts`, one column on `events` (`created_by_run_kind`), and five write paths. A re-grouping replay of N Links adds N
  rows, and one row per Event it writes.
- The pipeline sends `runKind`, `pipelineVersion` and `runId` on the Event
  and Alert mutations too (`pipeline_run` in clear-pipeline carries them).
- `createAlert` needs the run kind: an Alert that a Replay run raises is not
  part of the history.
- The grouping metrics get a replay line with no more design: the `REPLAY`
  rows of one run, bucketed as the history series is.
- Rule 2 needs a "replaced by" field on Events. That is a schema change in
  the re-grouping replay work, not here. Until a re-grouping replay exists,
  no Event is replaced and decision 6 changes no number.
- The location filter of every Signal-based metric still reads the Signal's
  current location. A geocoding replay moves Signals between places in a
  filtered view. This ADR leaves that as it is: the unfiltered series is the
  one a deploy is judged on.
- `signals.retracted` and `isDummy` stay live in every metric, as ADR-0011
  defines an ingested Signal. A source that withdraws a Signal changes a past
  bucket. That is the source, not the pipeline.
- An Event's As delivered values can change until the Event settles: the
  Live run still works on it. They are frozen from then on.

## Decided

- **The onset** (11 Nov 2026, James): kept as each run gave it, for the
  history series. The live onset is the second view. Both are collected.
- **Replaced Events** (11 Nov 2026, James): kept and marked. See ADR-0022.
- **An Event that a replay created** (11 Nov 2026, James): never in a history
  series, also when a Live run later adds a Signal to it. The Event records
  the run kind that created it (decision 6).
- **Who sees the two views** (11 Nov 2026, James): platform admins only, as
  two tabs on `/metrics`.
- **This ADR and ADR-0022** (11 Nov 2026, James): accepted.
- **The onset instant for time to detection** (11 Nov 2026, James): the last
  `LIVE` row of the Event. The other choice was the onset at the first
  ingested Signal, which is often poor: one Signal says little about the
  start date.
- **Late changes** (11 Nov 2026, James): no "may still change" mark in the
  first version. It is a later option.
- **A Signal is grouped** (11 Nov 2026, James): the reader checks the other
  Signal at read time. The log has no `joinedOthers` field (decision 1).
