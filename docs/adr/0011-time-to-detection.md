---
status: accepted
date: 2026-10-14
---

# Time to detection: whole days from onset to the first ingested Signal

CLEAR is an early-warning platform, so the first question about it is how
early it warns. The admin `/metrics` page in clear-mvp shows that as **time to
detection** (TTD): how soon after an Event's real-world onset CLEAR received
its first Signal for it. The definition lives here, in clear-api, and nowhere
else. `detectionMetrics` returns counts; clear-mvp only turns them into shares
and charts and never recomputes which Events count.

**Decision**: TTD is the number of whole UTC calendar days from an Event's
onset day to the day of its first ingested Signal's `publishedAt`. An Event is
**counted** when all three hold:

- it has an onset (`events.startedAt`),
- its first ingested Signal carries a real time of day, and
- that Signal is on or after the onset day.

Every other Event in range is **excluded** under exactly one reason, the first
that applies:

1. `NO_INGESTED_SIGNAL`: no live Signal a pipeline ingested, only history or
   Signals filed by hand.
2. `NO_ONSET`: no onset date to measure from.
3. `DATE_ONLY_FIRST_SIGNAL`: the source gives a date but no time.
4. `BEFORE_ONSET`: the first Signal is dated before onset, which is a data
   error.

The terms, as the code reads them:

- **Ingested Signal**: a Signal a pipeline brought in: no person submitted it
  (`submittedById IS NULL`) or filed it by hand (`rawData.manual` is not
  true), and it is not retracted or dummy. Accepted web cases are written with
  the analyst as `submittedById` and dated to the incident: they are history
  CLEAR learnt later, not detection. Manual Signals (`createManualSignal`, a
  field officer's, partner's or government report typed in by a person) are
  dated to when they were typed in. Neither counts as a first Signal.
- **First ingested Signal**: the earliest `publishedAt` among an Event's
  ingested Signals. `publishedAt` is the source's own time for the report,
  which is what "dated before onset" and "has no time of day" are about;
  `collectedAt` is always a real clock time and would hide both.
- **Date only**: a `publishedAt` of exactly 00:00:00.000 UTC. Signals carry no
  precision flag, and date-only sources land on UTC midnight. A source that
  really publishes at midnight to the millisecond is excluded too; that is
  rare enough to accept.
- **Whole days**: onset is stored to the day, so a finer unit would measure
  the onset's storage, not CLEAR. Same day = 0, next day = 1.
- **In range**: an Event is in range when its first ingested Signal's
  `publishedAt` is in `[from, to]`, or, with none, its `firstSignalCreatedAt`
  is. The weekly trend buckets counted Events by the ISO week of their first
  ingested Signal: the week CLEAR detected them. Each week also carries its
  `eventsInRange`, bucketed by that same in-range instant, so
  `counted / eventsInRange` is the week's measured coverage. A trend in TTD
  only means something next to its coverage: a week can read better because
  fewer, easier Events were measured. Dummy Events take no part.
- **Location**: an Event is in a location when its origin, destination or
  general location is that location or inside it, as `eventsByLocation` reads
  it.

The query defaults to the 12 ISO weeks ending now (from the Monday 11 weeks
before `to`'s week). It refuses an inverted range or one over 364 days with
`BAD_USER_INPUT`, and anyone but a platform admin with `FORBIDDEN`. Its
histogram has exactly nine rows (0 to 7 days, then 8 and more), its exclusions
exactly four, and its weekly rows cover every ISO week the range touches,
zero-filled, with a partly covered week marked `isPartial`.

## Considered options

- **Hours instead of days.** More precise on paper, but onset is a date. Hours
  from a midnight onset would read a report at 23:00 as 23 hours late.
- **`collectedAt` as "received".** Closer to the words "CLEAR received", but
  backfills and replays make it the time of the import, not of the report, and
  it can never be date-only or before onset, so two of the data-quality
  reasons could not exist.
- **Counting accepted web cases as Signals.** They are dated to the incident,
  so every accepted case would read as same-day detection. They are history.
- **Bucketing by onset week.** Excluded Events have no onset to bucket by, and
  "what we detected this week" is the operational question.
- **Computing the metric in clear-mvp.** Two definitions would drift; the page
  shows what the API defines.

## Consequences

- Exclusions are a data-quality view as much as a filter. A high
  `DATE_ONLY_FIRST_SIGNAL` or `BEFORE_ONSET` count points at a source or at
  onset parsing, not at detection.
- A pipeline that starts writing a precision flag on `publishedAt` lets the
  date-only test move from the midnight heuristic to that flag, without
  changing the definition.
- The weekly rows are the `WEEK` case of the bucket rule in ADR-0014; `series`
  reads the same tally by day, week or month (`granularity`).
- The query reads every live ingested Signal link once per call. It is an
  admin page called on demand; if it gets slow, an index on
  `signal_to_events(event_id)` or a stored first-ingested time is the next
  step.
