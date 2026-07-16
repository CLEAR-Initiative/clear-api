---
status: accepted
---

# Aggregation buckets by Figure Scope; no cross-level roll-up

## Context

Extraction now records each numeric figure's **Figure Scope** — the one
`locations` id the figure is a total for (`scope_location_id`, resolved at
extraction). Before this, the aggregator fanned a report-level figure
across every location the report mentioned, which double-counted at
country scope and forced the reportId-keying stopgap (ADR-0001,
superseded).

## Decision

A figure is aggregated at its scope, and only there.

- **`extractNumericMentions`** emits exactly one mention per figure, at
  its `scope_location_id`. A figure with no resolved scope (the LLM
  couldn't pin one, or the name didn't resolve — including the ambiguous
  multi-level names that clear-api's resolver now returns null for) is
  attributed nowhere and never rolled up.
- **The incident key is `(scope location, time bucket, event-type set)`** —
  §6.4.1's shape, finally reachable. The country-scope reportId branch is
  deleted; with per-figure scope there is no fan-out to collapse.
- **The refresh routes each figure to its own scope's window tier** by the
  scope's admin level: A2 (or deeper) → weekly, A1 → monthly, A0 → yearly
  + all-time. It resolves the hierarchy of the scope ids only to read each
  scope's own level (`chain.aN === scopeId` identifies it) — NOT to
  roll a figure up into ancestor buckets.
- **The on-demand fallback selects reports by window only**, then lets the
  scope filter keep the figures scoped to the queried location — because a
  figure's scope needn't be among the places its report mentions.

## No cross-level roll-up

A country (A0) bucket holds only figures scoped to the country. A figure
scoped to Kordofan lives in Kordofan's bucket and is never summed into
Sudan's. Deduplication is only ever for competing observations of the
**same** scope; it is not a mechanism for reconciling an A0 total against
the sum of its A1s (which would double-count overlapping sub-national
reports and mix scales). Country-level dashboard numbers therefore come
from nationally-scoped reports, and are only as complete as that reporting
— a deliberate trade of coverage for never double-counting.

This closes #273 and resolves #275 (which assumed the opposite —
ancestor roll-up) as won't-fix-by-design.

## Consequences

- `aggregateReports` stays a pure function over `ReportRow`.
- `aggregateReports(rows, L)` returns fields aggregated from figures scoped
  to `L`; a null/absent scope, and a null `locationScope`, match nothing.
- A window tier is fixed by admin level, so a sub-national figure never
  reaches the yearly-A0 bucket the situation dashboard reads. Sparse
  national reporting shows as sparse country numbers, by design.
- Regeneration of existing v1 buckets is required (schema bumped to v2 with
  Figure Scope) — tracked separately (#274).
