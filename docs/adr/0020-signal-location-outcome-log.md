---
status: accepted
date: 2026-11-10
---

# A location outcome log: location precision reads what the pipeline decided, not the live Signal

Location precision (ADR-0012) is computed at request time from the `signals`
table. It reads each Signal's current location and buckets the Signal by
`processedAt`, else `collectedAt`. Both columns are mutable. The pipeline now
has a bronze and silver layer in S3 and a replay job that can re-process
Signals after a geocoding change. We want replays: a Signal that an old
geocoder placed badly should not stay wrong.

A replay breaks the chart. ADR-0012 says "a re-processed Signal moves to the
week it was re-located in". `markSignalsProcessed` sets `processedAt` to now.
After a full replay:

- Every past week loses its Signals. All of them move to the replay week.
- The annotation comparison (ADR-0016, "38% in the 7 days before, 64% since")
  has no "before" left to read.
- If a replay kept `processedAt` instead, past weeks would take the new
  geocoder's result. The chart would show no change at the deploy.

The metric answers "did this deploy help?". That needs the result each
pipeline version gave at the time. The live row keeps only the latest result.

## Terms

| Term | Meaning |
|---|---|
| Outcome | One row that records where one pipeline run placed one Signal. |
| Outcome log | The append-only table of Outcomes, `signal_location_outcomes`. |
| Live run | The pipeline run that processes a Signal for the first time, after ingest. |
| Replay run | A pipeline run that re-processes Signals that a Live run already processed. |
| Live Outcome | The last Outcome that a Live run wrote for a Signal: the `LIVE` row written last, not the one with the latest `locatedAt`. |
| Step | The pipeline step that wrote an Outcome: `ARRIVAL` (Signal create), `PROCESSED` (the run marked the Signal done) or `RELOCATED` (a replay job moved the Signal without the drain). |

**Decision**: clear-api keeps an Outcome log. Location precision reads Live
Outcomes from the log. It no longer reads the location or `processedAt` of the
live Signal.

- **An Outcome has these fields**: `signalId`, `locatedAt`, `locationId`
  (null when the run found no location), `level` (copied from the location at
  write time), `runKind` (`LIVE` or `REPLAY`), `step` (`ARRIVAL`,
  `PROCESSED` or `RELOCATED`), `pipelineVersion` (the pipeline git SHA), and `runId` (the
  Dagster run id, optional).
- **The log is append-only.** No mutation updates or deletes an Outcome. A
  retracted Signal keeps its Outcomes; the metric excludes it by the ADR-0011
  rule, as it does today. Two database rules touch a row: `deleteSignal`
  removes the Outcomes of the Signal it deletes, and a deleted location sets
  `locationId` to null (`level` stays).
- **clear-api writes the Outcome**, in the same transaction as the write it
  records. The pipeline sends `runKind`, `pipelineVersion` and `runId`.
  Pipelines still write only through GraphQL. See "Which mutations write an
  Outcome".
- **`level` is a copy.** A gazetteer re-import can change or replace a
  location. The copy keeps the level the run produced.
- **A person's correction writes no Outcome.** The metric measures the
  pipeline. `pipelineLocationId` stays for the correction screens; the metric
  stops reading it.
- **History series**: each ingested Signal counts once, at its Live Outcome,
  in the bucket of that Outcome's `locatedAt`. A Replay run never changes this
  series. This replaces the "Located at" and re-processing rules of ADR-0012.
  All other rules of ADR-0012 stay: levels, ingested Signal, source, location
  filter, corrections.
- **Replay series**: for one Replay run, each Signal counts at the run's
  last Outcome for it, in the bucket of its Live Outcome. The two lines then
  compare the same Signals week by week: what the pipeline did then, and what
  the run does with the same input. `metricSeries` takes `replayRunId` for
  `DISTRICT_OR_FINER` and returns the same bucket shape. The series holds
  only the Signals the run re-processed, so its denominators are the run's
  coverage of the range. The location filter reads the Live Outcome's
  location, so both lines cover the same place.
- **Replay runs**: `locationReplayRuns` lists the runs that have an Outcome
  for a Signal in range: run id, pipeline version, start instant and Signal
  count, newest first, at most 50. A run is its `runId`; a `REPLAY` Outcome
  with no run id belongs to no run and is not listed.
- **Backfill**: the migration that creates the table writes one `LIVE`
  Outcome per existing Signal that a pipeline brought in. It uses the ADR-0012
  values: `COALESCE(processedAt, collectedAt)` and the pipeline location.
  `step` is `PROCESSED` when the Signal has a `processedAt`, else `ARRIVAL`.
  `pipelineVersion` is null. Retracted and dummy Signals get a row too: both
  flags can change, and the metric filters on them when it reads. The
  migration runs on deploy, so it runs before any Replay run.
- **The series contract does not change.** `metricSeries` and
  `locationPrecisionMetrics` return the same shapes (ADR-0015). clear-mvp needs
  no change for the history series.

## Which mutations write an Outcome

Four mutations and one route create a pipeline Signal or set its location:

| Mutation | What it sets | Writes an Outcome |
|---|---|---|
| `createSignal` | The location the Signal arrives with (a location id, or a point from coordinates). | Yes: `ARRIVAL`, `LIVE`, at `collectedAt`. |
| `POST /x-ingest` (a route, not a mutation) | Nothing: X posts arrive with text only. | Yes: `ARRIVAL`, `LIVE`, at `collectedAt`, with no location. |
| `updateSignalLocation` | The location the drain finds for a text-only Signal, or the location a replay job moves a Signal to. | From the drain: no. With `runKind: REPLAY`: yes, `RELOCATED`, `REPLAY`, at the instant of the move. |
| `updateSignalContent` | The location of a revised Signal, when no person corrected it. | No. |
| `markSignalsProcessed` | Nothing; it ends the run (`status`, `processedAt`). | Yes: `PROCESSED`, at the new `processedAt`, with the location the Signal has then. |

A run records its result once, when it marks the Signal. The two update
mutations write no Outcome, for these reasons:

- A run that finds no location calls neither of them. The metric needs that
  result too (`noLocation`), and only the mark sees it.
- The drain calls `updateSignalLocation` and then the mark. Two Outcomes per
  run would double the log.
- The mark is the instant ADR-0012 used (`processedAt`), so the series does
  not move at the switch.

A replay job can move Signals without the drain: the place-name backfill in
clear-pipeline calls `updateSignalLocation` and never marks. It passes
`runKind: REPLAY`, and the move writes a `RELOCATED` Outcome in the same
transaction. The move does not change `processedAt`, and the Outcome is
`REPLAY`, so the history series does not change.

If a run fails after it sets a location and before the mark, the Signal stays
`NEW`. The next run marks it and writes the Outcome.

`createSignal` writes the Outcome with the Signal in one statement.
`/x-ingest` creates Signals in bulk and writes their Outcomes in the same
transaction.
`markSignalsProcessed` writes the Outcomes in one transaction with the marks.
A Signal that the mark skips (its revision moved) gets no Outcome.

Only a Signal that a pipeline brought in gets Outcomes: no `submittedById`,
and `rawData.manual` is not true. `createManualSignal`, the Location
challenge mutations and the place-alias mutations write none.

## Rules for the edge cases

- **A second placement is a replay.** When a Signal has a `PROCESSED`
  Outcome, clear-api writes every later Outcome as `REPLAY`, whatever the
  pipeline sends. This includes a `NEEDS_RECOMPUTE` pass, a content revision
  that sends the Signal through the drain again, and `requeueSignals`.
- **The Live Outcome of a Signal that no run has finished is its `ARRIVAL`
  row.** Sources with coordinates are placed on arrival; a Signal that waits
  in the queue counts at `collectedAt` until a run marks it. This is the
  `COALESCE(processedAt, collectedAt)` rule of ADR-0012, kept in the log.
- **A person's change is not the pipeline.** A correction or a place alias
  that a person adds writes no Outcome, also when the alias re-resolves other
  Signals. If an alias moves a Signal during a run, the mark records where the
  Signal is, as the metric did before.
- **The correction counts** still filter on the Signal's pipeline location
  (`pipelineLocationId`). They count Location challenges, not Outcomes.

## Considered options

- **Periodic snapshots of the `signals` table.** Heavy, and the snapshot time
  is arbitrary. A replay between two snapshots still loses the old result.
- **Freeze closed buckets** in a table of (metric, bucket, group, numerator,
  denominator). Cheap, but it freezes today's definition. A changed metric
  definition cannot be computed for past weeks, and there is no replay series.
- **Keep the log in clear-pipeline-insights.** It already holds append-only
  run telemetry. Rejected: clear-api owns metric definitions (ADR-0015); the
  metric joins Signals, sources, the location hierarchy and challenges, which
  insights does not have; and the page would read two stores with two auth
  systems. `runId` links an Outcome to its insights `pipeline_run`.
- **Read the silver layer in S3.** The versions are there, but clear-api
  cannot query them per request, and coordinate sources are placed in
  clear-api, not in silver.
- **No change, and never replay.** Keeps wrong locations in the product to
  protect a chart.

## Consequences

- A replay becomes safe for this metric. It adds rows and changes no history.
- One more write per located Signal, and one row per Signal per run. A full
  replay of N Signals adds N rows.
- The grouping metrics (ADR-0018) and time to alert (ADR-0017) also read live
  rows, and a re-grouping replay will rewrite their history. This ADR does not
  fix them. They need the same pattern when re-grouping replays are built
  (out of scope in the Dagster migration, D7).
- ADR-0012 is amended, not superseded: only its "Located at" rule changes.

