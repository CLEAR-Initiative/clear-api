---
status: accepted
---

# Event type in the incident key, and how untyped figures are treated

## Context

§6.4.1 of the datapoint design specifies the incident key as
`(event, location, time_bucket)`, but the aggregator originally keyed only
on `(location, time_bucket)`. Two distinct event types in one place on one
day (a conflict toll and a flood toll) were therefore treated as competing
observations of one incident, and all but the freshest were discarded —
an undercount. #270 added the event-type set as the third key dimension so
distinct phenomena stop collapsing.

## Decision

The incident key is `(keyHead, time_bucket, eventKey)`, where `keyHead` is
`locationId` at location scope and `reportId` at country scope (see
ADR-0001), and `eventKey` is the report's `event_types` canonicalised into
one string.

Canonicalisation lives in a single helper, `canonicaliseEventTypes`:
lowercase, trim, drop empties, dedupe, sort. The **same** helper produces
the published `event_types` set-union, so the incident key and the
published set can never disagree on casing — a report tagged `["Conflict"]`
and one tagged `["conflict"]` dedupe into one group *and* publish
`["conflict"]`, not `["Conflict", "conflict"]`. A bare string
(`event_types: "conflict"`, a common LLM slip) is tolerated as a
single-element set; a genuinely unrecognised shape degrades to "untyped"
but emits a `console.warn` rather than shifting figures silently.

Key components are joined with NUL (`\u0000`), which cannot occur in a
cuid, an ISO date, or a canonicalised event type — so no component's own
content can forge a cross-group collision (as `|` could).

### Untyped figures

An empty `event_types` set means **"the extractor didn't tell us"**, not
**"a distinct phenomenon"**. So an untyped figure must not form its own
`additive_count` group when it plausibly belongs with a typed one:

- When exactly **one** typed group shares an untyped group's
  `(keyHead, time_bucket)`, the untyped group is **merged into it**.
- When **several** typed groups share it, the figure can't be assigned to
  one, so the untyped group is **left standing** (a small, rare
  over-count preferred to an arbitrary merge).

Without this, an untyped and a typed report covering the same place and day
were summed instead of deduped — re-inflating `additive_count` in the exact
direction ADR-0001 calls dangerous (`funding_received_usd` understated the
funding gap). It was the same failure class the event-type key was added to
avoid, reintroduced through the empty-string key value.

Country scope is unaffected: a report carries one event-type set, so no
country-scope base (`reportId, bucket`) ever holds both an untyped and a
typed key.

## Consequences

- `aggregateReports` stays a pure function over `ReportRow` (the merge is
  in-memory over the already-grouped mentions; no DB, no throwing). The
  malformed-shape `console.warn` is a diagnostic side effect and does not
  change output.
- The untyped-merge is a heuristic, not ground truth. The real fix is
  per-figure event attribution at extraction (the analytical-report /
  Figure-Scope work) — until then this bounds the error rather than
  eliminating it.
- Regression coverage added for: untyped-vs-typed dedup, the multi-typed
  ambiguous case, country-scope invariance, bare-string tolerance, and
  key/published-set casing agreement.
