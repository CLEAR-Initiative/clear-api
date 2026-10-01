# ADR-0008: Analysis regeneration gate (freshness + 24h floor + force)

**Status:** Proposed
**Date:** 2026-10-01
**Builds on:** [ADR-0007](0007-unified-frame-scoped-analysis.md) (unified frame-scoped `analysis`)

## Context

Under ADR-0007 an `analysis` is (re)generated for a frame by two triggers:

- **On-demand** — `requestAnalysis` → the pipeline's on-demand drain.
- **Automation** — `dueAnalysisAutomations` → the pipeline's automation drain, on a cadence.

Today **every** trigger unconditionally runs the full generation (~15 LLM calls + an `upsertAnalysis` write), even when:

- nothing new has been ingested for the frame since the last generation, or
- the frame was just regenerated moments ago (manual sync, then the scheduled run, or two manual syncs).

That wastes LLM spend and churns the bitemporal history with near-identical versions.

## Decision

Introduce a **regeneration gate** evaluated **before** generation, on both triggers. A generation proceeds only if **all** hold:

1. **Freshness (R1):** there is new evidence in the frame since the live analysis was generated.
2. **24h floor (R3):** the live analysis was generated more than 24h ago.

Unless **forced** (R3a): an admin can bypass both via `force: true`.

When the gate says *skip*, we do **not** regenerate; we only bump a **`lastSyncedAt`** timestamp ("we checked") — distinct from the analysis's `generatedAt` ("we last actually regenerated"). (R1's "update last-synced, not last-updated".)

### Trigger independence (R2) and schedule (R3b)

- A manual sync (`requestAnalysis`) never touches any `analysisAutomation` row, so it does **not** disturb a frame's automation schedule — already true under ADR-0007 and preserved.
- An automation run that arrives within 24h of the last generation (or with no new evidence) **no-ops**: it skips generation, bumps `lastSyncedAt`, and still advances `nextRunAt` on cadence (`markAnalysisAutomationsRan`). So the schedule stays on its fixed slots; only the regeneration is suppressed.

The 24h floor is **global** across both triggers — it is a property of the frame's live analysis, not of a trigger.

## Freshness signal

The analysis is generated from the `knowledgebase` table (RAG corpus; reports + events-in-KB per ADR-0006) plus aggregated datapoints. The `knowledgebase` row already carries the frame dimensions (`location_ids`, `event_types`, `need_sectors`, GIN-indexed) and a `created_at` ingestion timestamp.

New query (pipeline/admin):

```graphql
frameEvidenceWatermark(frame: AnalysisFrameInput!): FrameEvidenceWatermark!
# { latestEvidenceAt: DateTime, evidenceCount: Int! }
```

`latestEvidenceAt` = `max(created_at)` over `knowledgebase` rows matching the frame (same overlap + single-location→subtree expansion `searchKnowledgebase` uses); `evidenceCount` = the matching row count. **New evidence** ⇔ `latestEvidenceAt > analysis.generatedAt`. The drain owns the comparison; a frame with no live analysis always generates.

## Schema changes

- `analysis.lastSyncedAt DateTime?` — last time any trigger checked the frame (bumped on both skip and regenerate). `generatedAt` stays "last actual regeneration".
- `analysisRequest.force Boolean @default(false)` — carries an admin force request through the on-demand queue.

## Resolver changes (clear-api)

- **`upsertAnalysis`** — authoritative 24h floor (defends against races / direct callers). New input field `force`. If a current row exists, `!force`, and `now - generatedAt < 24h` → **no-op**: set the current row's `lastSyncedAt = now`, return `{ analysisId: <current>, supersededPrevious: false, skipped: true, reason: "within-24h-floor" }`. Otherwise supersede-then-insert as today, with `lastSyncedAt = now` on the new row.
- **`touchAnalysisSynced(frame)`** (new, pipeline-only) — bump the current row's `lastSyncedAt` without regenerating (used when the drain decides *skip* on freshness).
- **`frameEvidenceWatermark(frame)`** (new, pipeline/admin) — the freshness query above.
- **`requestAnalysis`** — new input field `force`, persisted on the request row; `requireRole(["admin"])` to pass `force: true` (analysts may request, only admins may force).
- `lastSyncedAt` exposed on `Analysis`; `force` on `AnalysisRequest`.

## Drain changes (clear-pipeline)

A pure `decide_generation(current, watermark, now, *, force, min_gap_hours=24) -> (generate, reason)` helper, used by both drains:

- `force` → generate.
- no current analysis → generate.
- `now - current.generatedAt < 24h` → skip (`within-24h-floor`).
- `watermark.latestEvidenceAt <= current.generatedAt` → skip (`no-new-evidence`).
- else → generate.

- **On-demand drain:** read `force` from the request; on skip → `touchAnalysisSynced` + mark the request **GENERATED** (the fresh existing row *is* the answer the requester polls for). On generate → generate + `upsertAnalysis(force)`.
- **Automation drain:** `force=False`; on skip → `touchAnalysisSynced` + `markAnalysisAutomationsRan` (advance `nextRunAt`); on generate → as today.

## Consequences

- Redundant regenerations (within 24h, or no new evidence) are eliminated — the dominant LLM-cost and history-churn win.
- Automation schedules stay on fixed cadence slots regardless of manual syncs or no-op cycles.
- Admins retain an escape hatch (`force`).
- New surface: one column on two tables, one query, one mutation, one input field — all additive; existing callers unaffected (defaults preserve current behavior except the now-enforced 24h floor, which is the intended change).

## Alternatives considered

- **Gate only in the pipeline** (no `upsertAnalysis` floor): simpler, but a direct/racing writer could still double-write within 24h. Enforcing the floor at the single write choke point makes it authoritative.
- **Freshness via aggregated-datapoint `newestSourceAt`:** misses KB-only reports (no datapoints). The `knowledgebase` watermark is the true retrieval-corpus signal.
