---
status: accepted
date: 2026-10-31
---

# Agent usage metrics: a turn is an Answer with recorded usage

The CLEAR Agent costs money per question and answers in tens of seconds. The
work to cut both ([Exponential #1269](https://www.exponential.im/w/clear/products/clear/tickets/1269))
sets its targets in cost per turn and median latency, so those numbers need a
place to be seen over time: the admin `/metrics` page in clear-mvp
([#1271](https://www.exponential.im/w/clear/products/clear/tickets/1271)).
As with time to detection (ADR-0011), the definition lives here, in clear-api.
`agentMetrics` returns counts, sums and averages; clear-mvp charts them and
never recomputes what counts.

**Decision**: the unit is a **turn**, one Answer the Agent gave together with
the usage clear-mvp recorded for it through `recordConversationTurnUsage`
(model, input and output tokens, cost, latency). A turn is **in range** when
its usage was recorded in the range, by `usageRecordedAt` (server time), the
same instant the daily budget sums by, so the page and the budget never
disagree about which day a turn belongs to. Answers whose usage was never
recorded (the turn failed, or the record was lost) are reported apart as
`turnsUnrecorded`, by `createdAt`, and take no part in any other number.

What is derived, and from where:

- **Tool calls** are read from the Answer's stored parts (`tool-invocation`
  parts, or the AI SDK's `tool-<name>` shape). No new write path: the metric
  reads what the memory adapter already stores.
- **The page a question came from** is the `route` of the user turn that
  preceded the Answer, cut to its first path segment (`/event/<id>` is
  `/event`), so entity ids never reach the metric.
- **Budget hits** are user-days whose recorded spend reached the budget in
  force. The budget is checked before a turn, so a day can end a little over
  it; "reached" is the honest count.
- **Weekly rows** are ISO weeks of the usage record, zero-filled over the
  range, each carrying the models that answered that week. A model that
  changes from one week to the next marks a model change on a chart, which is
  the point of the page: to show whether a change helped.
- **Input tokens** are what clear-mvp recorded, which is the sum over every
  step of a turn's tool loop. One turn can report far more than one request
  holds. The schema says so; the number is a cost, not a context size.

**Reading questions is audited.** Conversations are an audit record owned by
one user, and every admin read of another user's Conversation is logged as
`conversation.admin_read` (ADR-0009). A metrics page that shows question text
is such a read of many users at once, so `recentQuestions` is a separate field
that reads text only when selected, returns the text cut to 160 characters
with the page and no user, and writes one `conversation.admin_read` row
(`listing: true`, `via: agentMetrics.recentQuestions`, the range and the
Conversation ids) before returning anything. The aggregate fields read no
text and are not logged.

**What this is not.** It is not per-request instrumentation: cache reads,
cache writes and per-step token counts are not recorded yet (that is P0 of
#1269) and will be added to the usage record and to this metric together.
It is not a durable rollup: the metric is computed from `conversation_messages`
on each read, so it is as complete as the stored Conversations. A nightly
`agent_usage_daily` rollup is planned under #1271 once the page exists, so the
history outlives deleted Conversations; the query's shape will not change.
