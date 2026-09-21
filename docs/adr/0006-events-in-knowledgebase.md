# Events in the knowledgebase: a separate incident index with frame-aware tiered retrieval

The knowledgebase today is built entirely from ReliefWeb reports — one
`knowledgebase` row per report *chunk*, retrieved by a hybrid dense (pgvector
`<=>`) + sparse (`tsvector`) search fused with RRF (`searchKnowledgebase`). That
corpus has two structural blind spots:

- **Domain filter.** Each publisher writes only within its mandate (a health
  cluster covers attacks on clinics; UNICEF covers children). A happening outside
  every publisher's lens never enters the KB.
- **Temporal smoothing.** A report is a *state/aggregate* over a window — current
  needs, displacement, funding — and it rolls incidents up ("1,000 casualties in
  15 bombings across Dilling"). The individual incidents, especially the freshest
  ones near the report's own cutoff, are averaged away.

The requirement is a knowledgebase that is **always current with recent
happenings**. Our **events** (grouped signals) are the closest thing to a
complete incident stream, and they exist *before* any report is written. The key
realisation: reports and events sit at **different levels of abstraction** —
reports are the *state* layer, events are the *incident* layer — so they barely
overlap in content. Events do not duplicate reports; they answer a class of
question (incident-level "what specifically happened where/when", and recency)
that the report corpus structurally cannot.

## Decision

Add events to the knowledgebase as a **separate, lower-tier, complementary
index**, surfaced through the same `searchKnowledgebase` entry point via a
**frame-aware, tier-aware merge**. The report KB is left physically untouched.

### 1. A separate `events_index` table, not a tier column on `knowledgebase`

Events churn and get revised on a different cadence than reports, they are a
distinct quality tier (an unverified single-source signal is not a UN-verified
report passage), and the "never pollute the report KB" invariant is strongest
when it is *structural*. So events live in their own table, mirroring the
`knowledgebase` retrieval columns — `embedding vector(1024)`, `lexical_tsv`,
`location_ids[]`, `time_range_start/end`, `event_types[]`, `severity`,
`embedding_provider/model` — so every existing filter and both retrievers work
identically against it.

### 2. Representation — one row per event, an embedded "event card"

Grouping already deduped the signals, so the unit is the *event*, not the
signal. The `events` model already carries everything a card needs: `title`,
`description`, `description_signals`, `types[]`, origin/destination/general
locations, `startedAt` + `validFrom/validTo`, `severity`, `casualties`,
`populationAffected/Displaced`. The embedded text is a synthesised card (title +
description + a structured line: type / location / time / severity / casualties),
embedded with the **same provider + model** as reports (voyage-3-large, 1024) so
the vectors are comparable — enforced by the `embedding_provider/model` pinning
the report path already uses.

### 3. One entry point; the frame is a hard filter on BOTH indexes

`searchKnowledgebase` stays the single surface. A query's **frame** — location +
time window, optionally an event type or a specific event set — is applied as a
`WHERE` clause (the existing `buildFilterClause`: `location_ids &&`, time-range
overlap, `event_types &&`) to **both** indexes before any ranking. Each index
then runs its **own** hybrid dense+sparse retrieval and its **own** RRF (so RRF's
rank-based scores are computed per-index — a rank-1 event ties a rank-1 report,
which is what keeps the few short event cards from being buried by the many dense
report chunks). Only then are the two ranked lists merged.

### 4. Two retrieval modes, because the frame changes the ranking signal

- **Frame-dominant** (the situation-analysis case: a location+window with little
  or no topical text). Semantic similarity is noise here — every in-frame event
  scores low against a vague query — so a similarity *floor* would wrongly gate
  out exactly the incidents that are the answer. Instead return **two labelled,
  quota-bounded bands**: `analysis` (report chunks) and `incidents` (events),
  each ordered by recency/coverage (reports) and recency + severity (events). The
  quota **guarantees the incident timeline surfaces** whenever any in-frame events
  exist, and the two bands map to how an LLM should use them (state vs specifics)
  rather than a scrambled single ranking.
- **Topical** (the chatbot case: a strong free-text query). Similarity is
  meaningful, so interleave the two per-index RRF lists with **soft relevance**
  (blend rank with cosine similarity; order events by similarity + recency) and a
  **mild preference toward reports** expressed as a small rank *offset* (NOT a
  score multiplier — RRF scores are near-flat across ranks, so a multiplier
  shoves an item ~10 ranks; an offset of 1–2 is the interpretable knob).

Both modes attach a **`tier`** (`"report"` / `"incident"`) to every result so the
consumer and the LLM see provenance, can caveat unverified incidents, and never
silently blend the two.

### 5. Anti-pollution is structural, not tuned

Physical separation + per-index RRF (volume-neutral by construction) + a `tier`
label + a quota (guarantees incidents appear without letting them swamp) +
soft-relevance ordering (demotes off-topic events when a real query exists). The
report KB's retrieval is unchanged when the events tier is disabled.

### 6. The dynamic weight is evidence-based, not corpus-size

We explicitly reject weighting by "amount of data in each index": it is
per-query-blind, backwards at cold-start (it would down-weight events when they
are the only fresh signal), and non-reproducible. The useful dynamic signal is
**per-query evidence**: the strength of each tier's own top matches (cosine),
recency, and — the frame gives us this cleanly — **how well in-frame reports
already cover the frame** (count + recency of in-frame report chunks vs in-frame
events). When in-frame reports are fresh and dense, shrink the incident quota;
when they are stale or sparse, grow it.

**v1 pins these as fixed constants** (quota sizes, ordering weights, the topical
floor/offset) — predictable and unit-testable. **v2 replaces the constants with
the evidence functions** above. The retrieval plumbing (two indexes, per-index
hybrid+RRF, keeping `sim`/recency alongside the RRF rank, merge-and-label) is
**identical** between v1 and v2; only the scoring inside `merge()` changes, so v2
is a drop-in the same tests and query logs can A/B. v1 exists to *produce* the
distributions v2 is fitted against, not as throwaway.

### 7. Write path — a job on event create/revise

A job (Dagster asset or clear-api background task) fires on event create/revise:
synthesise the card → embed → upsert into `events_index` (replace-on-update,
keyed `event:<id>`, mirroring the report path's delete-then-insert). Events
**persist** — the whole point is to prevent the information loss reports cause;
a later report does not delete the event.

### 8. Boundary — never double-count at the datapoint level

Reports aggregate incidents ("15 bombings") while events *are* those incidents.
This is harmless for RAG *text* retrieval (the LLM gets both granularities,
labelled). It is a trap only if event *figures* ever feed the same datapoint
aggregation as report figures — they must not. The `tier` label and the separate
index keep that boundary explicit.

## Considered options

- **A `content_kind`/`tier` column on `knowledgebase`** — less code, reuses every
  filter, but couples the lifecycles (events churn/revise differently) and makes
  the "don't pollute the report KB" invariant a query-time convention instead of a
  structural fact. Rejected for the separate table.
- **A single RRF pool across all four retrievers** (report-dense/sparse +
  event-dense/sparse) — simplest, but volume-blind: report chunks outnumber event
  cards ~2–3× (a 100-page report explodes into dozens of chunks; an event is one
  short card), so events would be crowded out — and a strong-but-weakly-worded
  incident query would still mis-rank. Per-index RRF + a tier-aware merge fixes
  both.
- **A separate `searchEvents` surface** — cleanest isolation and honest about the
  state-vs-incident split, but pushes composition onto every caller. The
  requirement is *one* always-fresh knowledgebase, so we keep a single
  `searchKnowledgebase` and union internally.
- **Similarity-floor gate on events** — correct for the topical/chatbot path, but
  it misfires in the frame-dominant situation-analysis path (a vague query gates
  out all incidents). Kept only inside the topical mode; the frame mode uses a
  quota instead.
- **Corpus-size dynamic weight** — rejected (§6): wrong axis, cold-start
  backwards, non-reproducible.

## Consequences

- One new table + migration (raw SQL, like `knowledgebase`, because `embedding`
  and `lexical_tsv` are pgvector/tsvector types Prisma can't serialise).
- `searchKnowledgebase` gains a second retrieval + a mode-aware merge and a
  `tier` field on results; the report-only path is unchanged when the events tier
  is off, so there is no regression risk to existing callers.
- A new event-card embedding + upsert write path, fed continuously so the KB is
  always fresh without re-ingesting the report corpus.
- Consumers: the situation-analysis RAG drives the **frame** mode (its
  country/time filters already exist); the chatbot drives the **topical** mode.

## Related

- [ADR-0002](./0002-event-type-incident-key.md) — event-type taxonomy the frame filter reuses.
- [ADR-0005](./0005-per-feed-data-sources-for-push-feeds.md) — per-feed source reliability, the quality signal the `tier` surfaces.
