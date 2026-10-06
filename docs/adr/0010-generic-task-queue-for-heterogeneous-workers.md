---
status: proposed
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
- Typed results live beside the domain object they enrich, keyed by kind; the
  Task keeps the raw Worker output for audit. The first typed table is Event
  enrichments.
- A Worker needs a clear-api identity. Reusing the `pipeline` role is enough
  for a first owned Worker; third-party Workers want a narrower role.
- The Dagster drain shape (poll sensor, Redis single-flight, batch loop) stays
  and gains a reusable claim/complete helper so a new kind is a handler, not a
  module.
- clear-mcp's read-only rule (its ADR-0002) is in tension with offering claim
  and complete as MCP tools. Resolved separately, not assumed here.
