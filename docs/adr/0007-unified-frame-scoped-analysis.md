# Unified frame-scoped analysis: one `analysis` table replacing situation analysis and crisis

We generate humanitarian analysis two ways today, and they are architecturally
opposite:

- **Situation analysis** (`situation_analyses`) is **pipeline-owned generation**.
  A Dagster asset builds the whole payload for a **country (A0) × calendar window
  (yearly/monthly)** and writes it via `upsertSituationAnalysis` — bitemporal,
  versioned, an 8-component `data` blob with per-bullet provenance, on a weekly
  cron.
- **Crisis** (`crises`) is the inverse: clear-api **creates** the row (analyst
  rollup / detection) and the pipeline only **enriches** it by draining
  `pendingCrises`, writing back `scenarios` / `needs` / population. Its frame is
  the crisis's **own events** (their union of locations + event types + time
  span). Its payload is small and loosely typed, with no provenance.

Both describe the same humanitarian ground from the same evidence (knowledgebase
chunks, datapoints, and — after ADR-0006 — events). Management wants a **single
analysis of *frames***: a user picks a frame, gets an analysis on demand, and can
configure automation that keeps that analysis current with the latest data. The
country-scoped weekly analysis we produce today continues by default (now just a
row in this table). "Crisis overview" becomes a label for an analysis over a
narrow, event-derived frame — in code it is only an `analysis` row.

The key enabler already exists: `KnowledgebaseFilters`
(`location_ids`/`countryLocationId`, `event_types`, `need_sectors`, `timeRange`)
is exactly a frame, the crisis path already drives all of those filters, and
ADR-0006 makes events first-class KB rows retrievable through the same
`searchKnowledgebase` (FRAME mode + `events_index`). So "an analysis over a
frame, including events" needs no new retrieval substrate.

## Decision

Introduce one bitemporal **`analysis`** table, scoped by a **frame**, generated
by the pipeline over that frame (on demand or on a schedule), and retire the two
existing paths once readers are cut over. Ingest is untouched.

### 1. The frame is explicit columns, mirroring `knowledgebase` — not an opaque descriptor

`analysis` reuses the `situation_analyses` bones (bitemporal `valid_from`/
`valid_to`, `schema_version`, opaque versioned `data` JSON, supersede-then-insert
in one `$transaction`, `translations[]`) and replaces the fixed
`(country_location_id, window_start, window_kind)` bucket key with the same
dimensions the KB is indexed on:

```
location_ids  String[]   -- GIN   ┐
event_types   String[]   -- GIN   │  the frame
need_sectors  String[]   -- GIN   │
window_start  DateTime           │  "from"
window_end    DateTime?          ┘  "to"; NULL = rolling "to present"
```

No `frame` JSON descriptor and no `frame_key` hash: the columns *are* the frame,
queryable and indexable like every other filterable entity. No `kind` enum
either — a **country-default** analysis is *derivable* (`location_ids = [<A0>]`,
empty `event_types`/`need_sectors`), and a **crisis overview** is just a frame
with `event_types`/`location_ids` populated from the events.

### 2. `window_end` nullable encodes fixed vs. rolling — no `window_kind`

A user either selects a `from` **and** `to` (a fixed range) or, for an automated
analysis, a `from` and "to present" (rolling). That is one nullable column, not
an enum:

| | `window_start` | `window_end` |
| --- | --- | --- |
| On-demand, fixed range | user `from` | user `to` |
| Automated, "keep updated" | user `from` | **NULL** (= present) |

Rule: **automation ⟺ rolling (`window_end` NULL); on-demand ⟺ fixed.** A rolling
generation queries `[window_start, now()]`; the concrete "as of" moment is already
captured by the bitemporal `generated_at` / `valid_from`, so nothing stores a
shifting end date.

### 3. Identity and supersession over the frame columns

The live row for a frame is unique:

```sql
CREATE UNIQUE INDEX ... ON analysis
  (location_ids, event_types, need_sectors, window_start, window_end, schema_version)
  WHERE valid_to IS NULL;
```

Two disciplines replace the hash a descriptor would have given us:

- **Array canonicalization** — `location_ids` / `event_types` / `need_sectors` are
  sorted + de-duplicated and use a fixed NULL-vs-`[]` convention before write, so
  `[a,b]` and `[b,a]` are the same frame.
- **`NULLS NOT DISTINCT`** on the index (Postgres 15+) so two rolling frames
  sharing a `window_start` (both `window_end` NULL) collapse to one live row. (If
  the cluster predates PG15, a coalesced-sentinel expression index is the
  fallback — confirmed against the target cluster when the migration is written.)

Regeneration supersedes-then-inserts exactly as `upsertSituationAnalysis` does.

### 4. One versioned payload: the situation taxonomy plus `scenarios`

The unified `data` keeps the situation payload's eight components and their
per-component `source_report_ids` provenance, and adds one:

- Canonical **severity + sector taxonomy is situation's** (low/medium/high/
  critical; lowercase SAF sectors `food_security` etc.; the richer per-sector
  `sectors` component with impact / humanitarian_conditions / top_needs /
  priority_interventions / evidence_scope). Crisis's `needs_analysis` folds into
  that `sectors` component; crisis's Minimal→Catastrophic scale and capitalized
  sector names are dropped.
- New **`scenarios`** component (from crisis: most_likely / best_case /
  worst_case) — genuinely additive, forward-looking.

Components are **frame-conditional**: a narrow custom frame may ship
narrative-only when its deterministic inputs are too sparse (§6). The GraphQL type
keeps `data` opaque `JSON!`, versioned by `schema_version`, as `situationAnalysis`
does.

### 5. Automation is a set of frame subscriptions; the finest cadence subsumes the rest

The `analysis` row is a **shared artifact — one live row per (frame,
schema_version)**, not per user. Automations subscribe to a frame:

```
analysis_automation
  location_ids, event_types, need_sectors, window_start   -- the frame (rolling)
  cadence            -- daily | weekly | ...
  team_id / user_id  -- owner
  enabled, last_run_at, next_run_at
```

The scheduler groups subscriptions by frame and regenerates each frame **once at
the minimum cadence** across its subscribers — a daily subscription subsumes a
weekly one on the same frame; the weekly subscriber simply reads the
daily-refreshed row. A consequence worth stating: the **country-default weekly
analysis is no longer a special code path** — it is a system-owned
`analysis_automation` row (`location_ids=[A0]`, empty types/sectors, weekly),
driven by the existing cron.

### 6. Ingest is untouched; the frame lives at the read/generation stage

The ingest chain is unchanged — ReliefWeb → KB chunks + `report_datapoints` →
`aggregated_datapoints`, and signals → events → event cards
(`events_index`/KB). The frame is a **read-time** concept applied only by the
generator:

```
frame ─▶ aggregated datapoints  (existing bucket, or the existing on-demand
                                  rollup resolver for a non-bucket frame —
                                  clear-api read side, NOT an ingest change)
      ─▶ events                 (events_index / searchKnowledgebase FRAME mode)
      ─▶ KB chunks              (searchKnowledgebase scoped by the frame)
      ─▶ LLM narrative components ─▶ upsertAnalysis
```

Concretely, the pipeline's `generate_and_upsert_for_country_window` is
generalized to take a `Frame` instead of `(country, window)`; its retrieval is
already frame-native. For a frame with no precomputed aggregation bucket
(sub-national, custom window, event-derived), deterministic datapoints come from
the **existing** on-demand aggregation read path (`aggregatedDatapoint(onDemand)`
/ `datapoint-aggregation.ts`), not from any new ingest work; if too sparse, the
analysis degrades to narrative-only.

### 7. Generation ownership of "crisis" moves to the pipeline

Crisis stops being "clear-api creates → pipeline enriches". A crisis overview is
generated over an event-derived frame the same way every other analysis is
(pipeline generates → `upsertAnalysis`). Existing `crises` rows are migrated into
`analysis`; the `enrich_crises` drain is retired.

### 8. `changes` re-bases on bitemporal history

The "what changed" component compares against the **prior valid row for the same
frame** (available for free from the bitemporal history), not against a fixed
calendar bucket — which is what makes it work for arbitrary frames.

## Consequences

- **New:** `analysis` + `analysis_automation` models, `upsertAnalysis` (pipeline
  write, `requireRole(["admin","pipeline"])`, bitemporal supersede), automation
  CRUD + read queries, a generalized pipeline generator, an on-demand drain
  sensor (mirroring `enrich_crises`), and a cadence scheduler.
- **Unchanged:** the entire ingest/KB/datapoints/aggregation/event-card pipeline.
- **Retired (last):** `situation_analyses` and `crises` write paths, once readers
  move to `analysis`.
- **Cost:** one generation is ~15+ LLM calls (summary + 8 risk domains + 6
  sectors + changes …). On-demand user generations dedupe by frame and should be
  quota-guarded; automations collapse by frame/cadence to avoid redundant runs.

### Dependency

Firm on **ADR-0006 / PR #164** (clear-api `events_index` + tier-aware
`searchKnowledgebase` — merged to `dev`) and **PR #71** (clear-pipeline
event-card sync), because analysis must include events. **Phase 1** (schema +
`upsertAnalysis` + automation CRUD) has no events-KB imports and branches off
`dev`; **Phases 2+** (generation) consume the events KB.

### Rollout (single ticket, phased)

1. **clear-api schema** — `analysis` + `analysis_automation` + `analysis_request`
   queue, `upsertAnalysis`, frame-column partial-unique with rolling-frame
   dedupe, automation CRUD + reads, translation support for `entityType:
   "analysis"`. No behavior change.
2. **Pipeline generation** — generalize the generator to a `Frame` engine;
   on-demand `pendingAnalyses` drain sensor (time-filtered retrieval + leverage
   structured datapoints when available); country weekly emits `analysis` rows
   (switch, not dual-write); `changes` re-based on the frame's prior generation.
3. **Scenarios + crisis** — add the `scenarios` component to the payload (schema
   `v4`). **Crisis fold-in reduced to removing the pipeline enrichment** (the
   `enrich_crises` drain) — clear-api's `crises` **and** `situation_analyses`
   tables + resolvers are **kept** as legacy read surfaces; no data migration,
   no table/resolver retirement.
4. **Automation** — cadence scheduler (`dueAnalysisAutomations` +
   `markAnalysisAutomationsRan`); a drain groups due automations by frame and
   regenerates each at the minimum cadence across subscribers. Country-defaults
   stay on the existing weekly cron asset (not re-seeded as system automations).

### Scope decisions taken during implementation

- **Crisis is NOT fully replaced.** Only the pipeline's crisis *enrichment* is
  removed; the clear-api `crises` model, resolvers, and `createCrisisFromEvents`
  stay. A full crisis→analysis migration is deferred.
- **`situation_analyses` is kept but becomes read-legacy** — the pipeline weekly
  now writes `analyses`, so `situation_analyses` receives no new rows; its table
  + resolvers remain for existing readers until the UI cuts over.
- **Phase 5 (deprecation / retiring the old write paths + tables) is dropped**
  for now; the old surfaces coexist with `analysis`.

## Alternatives considered

- **Opaque `frame` JSON + `frame_key` hash.** Rejected: the frame dimensions are
  exactly the KB's indexed columns, so explicit columns are queryable, indexable,
  and consistent with the rest of the schema; a hash adds an opaque identity we'd
  have to keep in sync.
- **A `kind` enum (country-default / crisis / custom).** Rejected: fully
  derivable from the frame columns; a flag would be redundant state that can drift.
- **Keep two tables, share a payload type.** Rejected: the whole point is one
  analysis-of-frames with one automation model; two tables reproduce today's
  split and double every reader.
- **A `window_kind` enum instead of nullable `window_end`.** Rejected: the only
  distinction users make is fixed-`to` vs. to-present, which one nullable column
  captures.
