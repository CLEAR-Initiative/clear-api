---
status: accepted
date: 2026-10-31
---

# Location precision: the level of each ingested Signal's location, per source and week

Grouping keys on district. A Signal placed only at state or country level
never joins an existing Event: it becomes its own Event, and on 20 Oct 2026
each such Event could alert on its own (Exponential #1046). Text-only sources
(the `sudan-war-x` X feed, mostly Arabic) are where this happens; sources with
coordinates land at a point. Geocoding changes were judged by one-off lab runs
over fetched days. The admin `/metrics` page in clear-mvp now shows **location
precision** so every change is judged by the number it moves. The definition
lives here, in clear-api, and nowhere else. `locationPrecisionMetrics` returns
counts; clear-mvp only turns them into shares and charts.

**Decision**: location precision counts each **ingested Signal in range** once,
under the **level of its location**, per **source** and per **ISO week of the
instant it was located**.

- **Level**: `locations.level` of the Signal's location: `country` (0),
  `state` (1), `district` (2), `point` (4: a landmark or coordinate point
  inside a district; there is no level 3, and anything finer than a district
  counts as a point), or `noLocation` when the Signal has none. **District or
  finer** is `district + point`; it is the share the page leads with, because
  it is what grouping can use.
- **The Signal's location**: its general location (`locationId`), or for a
  displacement Signal its origin (where the incident happened), else its
  destination. A Signal a person corrected (`locationCorrectedAt` set by an
  accepted or corrected Location challenge) is read at the location the
  pipeline gave it: `pipelineLocationId`, which the first correction fills
  with the location it overwrote (Signals corrected before the column existed
  are backfilled from their first applied challenge's `previousLocationId`).
  The point the person wrote would measure the person, and would lift the
  Signal's original week without any geocoding change.
- **Located at** (amended by ADR-0020): the `locatedAt` of the Signal's
  **Live Outcome** in the Outcome log. That is the instant the Live run
  finished the Signal (its `processedAt` then), or, while no run has finished
  it, `collectedAt` (sources with coordinates are placed on arrival). A Signal
  is **in range** when that instant is in `[from, to]`, and the weekly rows
  bucket by its ISO week. This is the week a pipeline deploy shows up in,
  which is the point of the metric. The level is the one the Live Outcome
  recorded. A re-processed Signal keeps its week and its level: a Replay run
  adds Outcomes and changes no history. (Before ADR-0020 the metric read
  `processedAt` and the location from the live Signal, and a re-processed
  Signal moved to the week it was re-located in.)
- **Ingested Signal**: as ADR-0011 defines it: a pipeline brought it in (no
  `submittedById`, `rawData.manual` not true), and it is not retracted or
  dummy. A Signal a person placed by hand measures the person, not the
  pipeline.
- **Source**: `dataSources.name`. `bySource` has one row per source with a
  Signal in range, most Signals first; `weekly` has one row per source and
  week, zero-filled over every week the range touches, with a partly covered
  week marked `isPartial`.
- **Location filter**: a Signal is in a location when its location is that
  location or inside it (`ancestor_ids`). A Signal with no location cannot be
  placed in or out of one, so it is left out when the filter is set;
  `noLocation` is only measured globally.
- **Corrections**: Location challenges filed in range, by status (`open` is
  the stored `consideration`), under the same source and location filters.
  They are a correctness proxy: the metric measures how fine a location is,
  not whether it is right. Correctness needs an analyst-checked sample, which
  does not exist yet.

The query defaults to the 12 ISO weeks ending now, refuses an inverted range or
one over 364 days with `BAD_USER_INPUT`, and anyone but a platform admin with
`FORBIDDEN`, exactly as `detectionMetrics` does; it reuses that query's range
handling.

## Considered options

- **Bucketing by `publishedAt`**, as time to detection does. It answers "how
  well located is this week's news", but a deploy on Thursday would show as a
  change spread over several weeks of publication dates, and a backfill would
  rewrite old weeks silently. Located-at puts the change where it happened.
- **"District or finer" by admin-2 ancestor** rather than by level: a point
  whose ancestors include no district (a country without district polygons)
  would then count as coarse. A point is the finest thing CLEAR stores, so it
  counts as fine; the page can show the ancestor view later if grouping needs it.
- **Counting manual and web-case Signals.** Their locations are chosen by a
  person, so they would flatter or hide the pipeline's own placement.
- **Computing the metric in clear-mvp** from the Signal list. Two definitions
  would drift, and the list caps at a page.
- **Measuring correctness now** from the lab's spot checks. There is no judged
  sample; challenges are the only recorded disagreement, so they are reported
  as a proxy and named as one.

## Consequences

- The first baseline is retroactive: the stored locations already exist, so
  the card shows the weeks before and after the 29 Oct 2026 geocoding deploy
  (Exponential #1205 to #1207) without waiting.
- Re-locating old Signals is safe for this metric since ADR-0020: the series
  reads the Outcome log, and a replay only adds rows to it.
- A change to how displacement Signals are located (origin versus destination)
  changes which location this metric reads; update the definition with it.
- The query aggregates in SQL (source, day, level), so it returns at most a few
  thousand rows for a year; no index is needed beyond the existing ones.
- When an analyst-checked sample exists, `corrections` gains a measured
  companion rather than changing meaning.
- The weekly rows are the `WEEK` case of the bucket rule in ADR-0014; `series`
  reads the same tally per source by day, week or month (`granularity`). The
  29 Oct 2026 deploy is only visible by day: 31% before it that day, 60% after.
