---
status: accepted
---

# Conversations live in clear-api, written through a Mastra memory adapter over GraphQL

The **CLEAR Agent** (Mastra, running in clear-mvp) needs conversation memory, and NRC needs
an audit trail of what the Agent told whom. **Conversations** are therefore domain records in
clear-api: Prisma models shaped around CLEAR (owner, turns, Answers, tools run, Source
documents cited, per-turn usage), exposed through GraphQL. Mastra reaches them through a
custom `MemoryStorage` adapter in clear-mvp that calls that GraphQL. Mastra's memory *logic*
stays in use (history windowing and working memory, with observational memory and semantic
recall later if needed), but its storage never touches the database directly.

## Considered options

- **`@mastra/pg` pointed at clear-api's Postgres** (own schema). Every Mastra memory feature
  works immediately with no adapter code. Rejected because it writes to the database outside
  GraphQL, breaking the workspace rule that only clear-api writes its database. Mastra would
  also create and migrate its own tables outside Prisma, so the system of record would hold
  tables shaped by a framework's internals.
- **Mastra storage in a separate agent database, plus an audit copy in clear-api.** Two copies
  of every conversation that can disagree.
- **Browser-only Threads (the old ADR in clear-mvp).** No audit and no cross-device history.

## Consequences

- We own an adapter against an interface Mastra can change between versions. Contract tests
  against Mastra's in-memory reference store catch drift. A Mastra upgrade changes the
  adapter, never a migration of Conversations.
- The adapter is built in stages: the required thread, message and resource methods first;
  observational-memory methods and a vector adapter (pgvector is already here) only if long
  Threads need them.
- A Conversation keeps what the Agent actually said, even if its owner's access later narrows.
  Platform admins can read Conversations read-only, and every such read is logged.
- Only the Agent writes Conversations. Each write carries two credentials: the end user's
  session (whose Conversation it is) and the key of an `agent` service user in
  `X-Clear-Agent-Key` (that it comes from clear-mvp's Agent). Either alone is rejected, so a
  user can't author their own audit record by calling the API directly, and a leaked agent key
  can't write as anyone without that user's session. The agent role reads no content by itself.
  We chose this over a service key plus an "acting for user X" header, which would let anyone
  holding the key write as any user, and over signed per-request delegations, which add a
  shared secret and token minting for no extra protection while the session is already sent.
