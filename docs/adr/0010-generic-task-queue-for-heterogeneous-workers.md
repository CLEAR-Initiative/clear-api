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
