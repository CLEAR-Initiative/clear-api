---
status: accepted
date: 2026-11-26
---

# Decision records, and a guard on decided fields

A person corrects what the pipeline produced. A pipeline replay must not undo
that correction. clear-api records each human judgement and refuses a pipeline
write over a field a person decided.

Feature: [Exponential "Decision records and audit trail"](https://www.exponential.im/w/clear/products/clear/features/cmvxjq51h0005jr082vhnvfzj).
Ticket: [Exponential #585](https://www.exponential.im/w/clear/products/clear/tickets/585).
Decision: [D-281](https://www.exponential.im/w/clear/decisions/d/cmwwblp6k0029k407yi1shcfe).

## Terms

| Term | Meaning |
|---|---|
| DecisionRecord | One row in `decision_records`: one human judgement. |
| Decided field | A Signal field a person set: `severity` (stamp `severity_corrected_at`) or the location (stamp `location_corrected_at`). |
| Pipeline caller | A request that `isPipelineCaller` says is the pipeline. In V1, a request with an API key. |
| Refused write | A pipeline write over a decided field. clear-api keeps the person's value. |

## Decision

1. **Record.** clear-api writes one DecisionRecord for each human judgement.
   It writes the record in the same transaction as the change. If the record
   fails, the change rolls back.
2. **Keep.** A pipeline write over a decided field writes nothing. The call
   does not fail. It returns the Signal with the kept value and the stamp.
3. **One place.** Mutations and offline scripts write a Signal's severity and
   location through `writeSignalSeverity` and `writeSignalLocation`
   (`src/services/signal-decided-fields.ts`). The guard is in these functions.

## The rules

- **Append-only.** No code updates or deletes a DecisionRecord. A later
  decision sets `supersedes_id` to the earlier record.
- **Decider.** `recordDecision` takes the decider from the request context.
  It never takes a user id from a client argument. It refuses a pipeline
  caller: a system account never decides.
- **Through the Agent.** A request from the CLEAR Agent carries the user's
  session. The record holds the user as decider and `via_agent = true`.
- **Deleted user.** The record stays. `decided_by` becomes null.
- **Sequence.** `sequence` only increases. A rolled-back transaction uses a
  number, so gaps are normal.
- **Person or pipeline.** `isPipelineCaller(context)` is the one test. Every
  call site uses it. V1 body: `authMethod === "api-key"`. The pipeline
  identity (#430) changes the body only.
- **Override.** An offline script that must change a decided field passes an
  `override` caller with a named person and a rationale. The function writes
  the value, sets the stamp, and writes a record that supersedes the latest
  one for that Signal and type.
- **Refusal metric.** clear-api logs one line per refused write
  (`event: decided_field_write_refused`). The pipeline counts refusals from
  the stamp in each response.

## V1 coverage

| Judgement | Type | Where |
|---|---|---|
| A person sets a Signal's severity | `SIGNAL_SEVERITY_SET` | `updateSignalSeverity` |
| A person accepts, corrects or declines a Location challenge | `SIGNAL_LOCATION_DECIDED` | `decideSignalLocationChallenge` |
| A person accepts or rejects a case proposal | `CASE_PROPOSAL_DECIDED` | `decideCaseProposal` |

Guarded pipeline writes: `updateSignalSeverity`, `updateSignalContent`
(severity, beside the existing location guard), `updateSignalLocation` (a
refused `REPLAY` writes no Outcome), and the scripts `backfill-legacy-l4.ts`
and `backfill-locations.ts`.

## Not the Activity log

The Activity log stays as product analytics. Its helper must never throw, it
holds no content, it has no cursor, and its rows go when the user goes. The
mutations write both.

## Rejected alternatives

- **Change data capture.** It cannot see who acted or why (D-281).
- **Extend the Activity log.** See above.
- **Guard only in the pipeline.** Every write path would have to get it right.
  clear-api is the source of truth, so it protects itself.
- **Look up `decision_records` in the guard.** A stamp column is one read and
  matches `location_corrected_at`.
- **Wait for the pipeline identity (#430).** The credential test is correct
  today, and the predicate hides the change.

## Consequences

- A replay can still spend LLM calls on a Signal whose result is refused. The
  refusal count shows the cost.
- Adding a decision type is a migration (`DecisionType` is a Postgres enum).
- V2 (#1289) adds the remaining human mutations and required rationales. V3
  (#1287) exposes the records to the pipeline by `sequence`.
