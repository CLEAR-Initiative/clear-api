---
status: accepted
date: 2026-10-06
---

# A generic Task queue in clear-api, drained by heterogeneous Workers over GraphQL

Three queues already exist, each shaped for one feature: the translation queue
(`translation_queue`), the crisis enrichment flag (`crises.enrichment_status`),
and on-demand analysis requests (`analysis_requests`). Each has its own table,
its own `pending*` query and `mark*` mutations, and its own client functions in
clear-pipeline. All three assume exactly one consumer, a Dagster drain holding a
Redis single-flight lock, so none of them records on the row that a consumer has
taken it.

The new requirement breaks that assumption. A user requests an **Event
enrichment** (first kind: **ImpactPrior**, the ontology's own class) and the work is done by a **Worker**
that may be code CLEAR owns, a scheduled Claude Code routine, a third-party
agent, or a person. The same mechanism must serve later kinds of work.

**Decision**: one generic **Task** table in clear-api, not a fourth bespoke
queue. A Task carries a `kind`, the subject it concerns, a small JSON payload,
a status, a lease (owner + expiry), an attempt counter, and the raw Worker
output. clear-api exposes it as a Worker protocol over GraphQL: request (the
trigger), claim (atomic, leased, `FOR UPDATE SKIP LOCKED`), heartbeat,
complete, fail. Postgres is the broker; GraphQL is the only door; clear-api
remains the only writer of its database, as every other drain already assumes.
The lease lives on the row so that several kinds of Worker can poll the same
queue without taking each other's work.

## Considered options

- **pg-boss or Graphile Worker.** Mature Postgres job queues with exactly these
  semantics, but each needs a direct Postgres connection and owns a schema
  outside Prisma. That breaks the one-writer rule and excludes every Worker
  that only has HTTPS and an API key, which is most of the ones we want.
- **Redis or BullMQ.** Redis is already deployed, but as a cache and lock. As a
  broker it is non-durable, invisible to Prisma and to the UI, and again shuts
  out external Workers.
- **A fourth per-feature table**, continuing the existing pattern. Cheapest
  today; no lease, no shared protocol, and the fifth queue repeats the cost.
- **The CLEAR Agent in clear-mvp.** Its tools and memory are bound to a user's
  session and the agent key (ADR-0009), and clear-mvp's ADR-0006 rules out
  backend-triggered agents living there.
- **Dagster's run queue as the broker.** Dagster already has a queue, retries,
  sensors and asset automation, and it drains the three existing queues today.
  But a queue lives wherever its Workers can reach it, and only things Dagster
  launches can take work from Dagster's queue. The first Worker is a scheduled
  Claude Code routine driving clear-mcp over stdio with an API key, on
  Anthropic's scheduler; a third-party agent or a person on a chat client are
  the same shape. None of them can claim a Dagster run on their own schedule,
  and none can be wrapped in a Dagster job. Dagster is therefore one caller of
  the Task protocol (a thin, sensor-driven drain that claims over GraphQL and
  runs the handler as ordinary Dagster compute), not its host. The Task is also
  product state the UI reads through clear-api (status, requester, cap, dedupe,
  cancel, outcome, cost), which Dagster's run state is not.

## Consequences

- New queues go on the Task table. The existing three move only when touched:
  analysis requests are the one candidate (clear-mvp reads only id and status
  at creation and polls the analysis itself); the crisis flag is a dirty flag
  and stays one; the translation queue is a high-volume dedup buffer and stays.
- The claim is raw SQL, which the repo already does for pgvector. Prisma cannot
  express `SKIP LOCKED`.
- Typed results live beside the domain object they enrich, shaped on the
  CLEAR Domain Ontology's entity for that kind, not on a generic findings
  blob; the Task keeps the raw Worker output for audit. The first such table
  is ImpactPrior, with the ontology's attributes (hazard type, population
  group, metric, scope, bounds, number of cases, basis, validity period,
  method version, supersede chain), the quantitative ones nullable until a
  later step fills them. It is the first ontology entity to reach code.
- A Worker needs a clear-api identity. It is a dedicated `worker` global
  role (`scripts/create-worker-user.ts`), not `pipeline`: `pipeline` can call
  every existing `mark*` drain mutation, so a prompt-injected Worker running
  as it could mark signals processed or crises enriched. `worker` can claim,
  heartbeat, complete and fail only Tasks it holds, write nothing but
  `proposed` ImpactPriors, and read content like any approved user. That
  narrow role is the compensating control for unattended Workers. Every
  other mutation rejects it up front (`requireNonWorker` /
  `requireNonWorkerContentReader`), and `tests/schema/worker-write-scope.test.ts`
  walks the whole Mutation type so a new one can't widen it.
- The Dagster drain shape (poll sensor, Redis single-flight, batch loop) stays
  and gains a reusable claim/complete helper so a new kind is a handler, not a
  module.
- clear-mcp's read-only rule (its ADR-0002) is in tension with offering claim
  and complete as MCP tools. Resolved separately, not assumed here.

## What landed (V1, 2026-10-06)

- `tasks` and `impact_priors` tables, migration
  `20261006120000_add_tasks_and_impact_priors`, with the SQL-only partial
  unique index `tasks_open_subject_uk` (one PENDING/LEASED Task per kind and
  subject). Tasks are never deleted; `impact_priors.event_id` is
  `ON DELETE RESTRICT`.
- The Worker protocol over GraphQL: `requestEventEnrichment` (the
  `escalateEvent` gate, dedupe onto the open Task, origin from the auth
  method, a per-requester daily cap), `claimTasks` (`FOR UPDATE SKIP
  LOCKED`, lazy reclaim of lapsed leases, lazy FAILED once attempts are
  used), `heartbeatTask`, `completeTask`, `failTask`, `cancelTask`, and the
  reads `task`, `eventTasks`, `eventImpactPriors`, `Event.enrichmentTasks`,
  `Event.impactPriors`.
- Every lease-owner write is one conditional statement on (id, LEASED,
  owner, no pending cancel), so a reclaim or a cancel landing between a
  Worker's check and its write is never overwritten.
- Defaults as env, enforced server-side: `TASK_LEASE_MINUTES` 15,
  `TASK_MAX_ATTEMPTS` 3, `TASK_CLAIM_MAX` 10, `TASK_REQUEST_DAILY_CAP` 20.
- Decisions on a proposed ImpactPrior (`decideImpactPrior`), notification
  fan-out and the Inbox are V2; Worker administration, the platform-wide
  claim cap and the analysis-request migration are V3.

## What landed (V2, 2026-10-06)

- `decideImpactPrior(id, decision, rationale)`: a platform admin or analyst
  accepts or rejects a proposed ImpactPrior once, recording who, when and
  why (the DecisionRecord fields on the row). A rejected row stays as
  superseded history.
- Visibility (decision 15): `accepted` follows the Event; `proposed` is
  visible to its requester and to deciders; `rejected` to deciders only.
  `impactPriors(state)` lists one state across Events for the Inbox,
  deciders only.
- Fan-out on a Task's completion or terminal failure (including the claim
  sweep): in-app `notifications` rows of type `task` linking the Event
  page for the requester, platform admins and the Task's team analysts;
  email through the messaging registry (`taskOutcome` template) for those
  who opted in, with the Worker's error shown only to the requester and
  admins. Recipients are the Task's team (Events have no team of their own).

## What landed (V3, 2026-10-07): several Workers propose on one Event

- A request for enrichment no longer names a single Worker's work. `requestEventEnrichment`
  always fans out — no picker — into one Task per enabled **source kind** from
  `TASK_IMPACT_PRIOR_KINDS` (default `event.impact_prior.clear`, the Dagster drain over CLEAR
  data, and `event.impact_prior.web`, the Claude routine over the web) and returns the list.
  The kind stays free text on the Task, so a new source is a Worker and an entry in that list,
  not a migration. Each Worker claims by its exact kind, as before.
- Dedupe stays per (kind, subject) through the existing partial unique index: a request made
  while one source is still working hands that Task back and creates only the missing kinds.
  The Tasks of one request share `tasks.request_id`, and the per-requester daily cap counts
  distinct requests, not rows — one click is one request however many Workers it feeds.
- `impact_priors.source_kind` records which kind produced a proposal (from the Task, never from
  the Worker's input). `completeTask` supersedes only the newest existing proposal **of the same
  kind** for the Event, so proposals from different sources sit side by side and a decider
  accepts or rejects each; nothing marks the Event done. Migration
  `20261007120000_parallel_impact_prior_proposals` backfills both columns.
- The bare `event.impact_prior` kind remains claimable and completable for one release so an old
  Worker does not strand its open Tasks; it supersedes within its own kind like any other.
- Notifications name the source ("Impact prior from CLEAR data proposed — review it"), since a
  requester now hears from each Worker.
- Rejected: a `kind` argument that picks one source (the decision is that every enabled Worker
  gets to propose; the UI should not offer a choice); a server-side merge of proposals into one
  (the Domain Ontology's rule is supersede-never-overwrite, and the sources' evidence tiers
  differ); counting the cap in Task rows (a two-source fan-out would halve every requester's
  allowance overnight).

## Amendment (V4, 2026-10-07): the analyst decides cases, not priors

Reviewed against the CLEAR Domain Ontology v0.3.0. An ImpactPrior is a lookup — "what has
typically happened before, given a hazard type, a context and a population", with a central
value and bounds — inferred from historical Events. V1–V3 instead had a Worker propose a whole
ImpactPrior per Event and an analyst accept or reject it whole: the cases sat in a JSON
`basis` that could not be decided one by one, accepting changed nothing but the row's state,
and web cases were never checked against the Events CLEAR already holds.

- **CaseProposal** (`case_proposals`): one row per historical case a web Worker found — source
  URL, verbatim quote, when it happened, where, hazard, figures on the ontology's seven metric
  types, and the CLEAR Event it describes when CLEAR already holds one (`matchedEventId`). It is
  the unit an analyst accepts or rejects. Unique on (Event, URL): a later request never
  re-proposes a URL already proposed, accepted or rejected for the same Event.
- `completeTask(cases, methodVersion)` on an `event.impact_prior.web` Task writes CaseProposals
  instead of an ImpactPrior. A Worker still on the whole-prior contract keeps working: the web
  cases inside its `basis` become CaseProposals too, and its ImpactPrior row stays as history.
  Migration `20261007162436_add_case_proposals` backfills the web cases of every still-proposed
  ImpactPrior the same way.
- Reads: `caseProposals(state)` (the Inbox, deciders only), `eventCaseProposals` /
  `Event.caseProposals` under the ImpactPrior visibility rule, and `rejectedCaseUrls(eventId)`
  for the Worker. The whole-prior Inbox (`impactPriors`) no longer lists the web and bare kinds.
- `decideCaseProposal(id, decision, rationale)`: a platform admin or analyst decides one case,
  once (rationale required to reject). Accepting writes the case into CLEAR in the same
  transaction: a Signal (source `web_enrichment`, `publishedAt` = when the incident happened,
  `submittedById` = the decider, written `PROCESSED` so the Dagster drain never regroups it) on
  the matched Event, else the Event already carrying that URL, else a new historical Event dated
  to the incident. A Signal with the same URL is reused, never duplicated. Linking widens an
  Event's first/last Signal times but never moves them inward. Historical Events stay out of
  alerting because `eventsPendingAlert` only returns Events whose newest Signal is under 48 hours
  old; no separate "historical" flag. Rejected: routing accepted cases through the Dagster drain
  (its grouping only matches Events active in the last 7 days of wall-clock time, so every
  backdated Signal would open a new Event).
- The case's figures become Estimates on that Event (method `media_report`, attribution
  `event_caused`, valid for the incident's date, `sourceSignalId` the case's Signal), insert-only;
  the same source's figure for the same metric and population group is not written twice.
- `Event.computedImpactPriors(horizonYears)`: the ImpactPrior computed from history, not
  reviewed. For an Event, the Events before it that manifest the same hazard in the same country
  within the horizon (non-dummy) each contribute their current Estimate per metric and population
  group; the prior is the median (central value), the range (bounds), the case count, the Event
  and Estimate ids, and `methodVersion` `clear-impact-prior@0.2.0`; below three cases it is flagged
  low-confidence. Computed on read, so it is always current with what analysts accepted and
  nothing needs superseding. Rejected for now: storing computed priors in `impact_priors` (no
  consumer needs a frozen copy until `Estimate.informed_by` exists; storing them would bring
  back the per-Event supersede chain the ontology does not have). The LLM-proposed `.clear`
  ImpactPriors still exist; whether that Worker is retired or repurposed is open.

## Amendment (V4, 2026-10-08): the web Worker alone by default

`TASK_IMPACT_PRIOR_KINDS` now defaults to `event.impact_prior.web`. The Claude routine searches
CLEAR's Events and knowledge base before the web (clear-mcp 0.4.1) and proposes cases that
analysts decide one by one, and the prior is computed from accepted history, so the Dagster
drain's LLM-proposed `.clear` ImpactPrior is no longer requested. The fan-out, the `.clear`
handler and the drain stay: adding `event.impact_prior.clear` back to the env restores it, and
the drain remains the generic Task Worker for future kinds. Open `.clear` Tasks stay claimable
and are drained as before.

## Amendment (V4, 2026-10-08): the computed prior rests on observed figures only

`Event.computedImpactPriors` summarised every current Estimate, so it echoed clear-pipeline's
placeholders: the #734 backfill turned `events.population_affected` / `population_displaced`
into `not_documented` Estimates, and the pipeline fills those columns with an ACLED event-type
median or an LLM guess when it knows nothing better. The prior now counts only
`OBSERVED_ESTIMATE_METHODS` (`media_report`, `government_figure`, `partner_or_cluster_figure`,
`rapid_assessment`, `formal_assessment`, `registration`, `field_staff_judgement`), and the filter
is applied before each Event's current figure is chosen, so a newer unobserved figure never
masks an observed one. `not_documented`, `model_inference`, `exposure_model` and
`prior_caseload_analogue` (a figure derived from a prior, which would feed priors back into
themselves) are excluded. Each prior reports `basisMethods`; method version
`clear-impact-prior@0.3.0`. Most Events have no prior until analysts accept web cases with
figures; that is the honest state. The backfilled Estimates stay as `not_documented` history.
