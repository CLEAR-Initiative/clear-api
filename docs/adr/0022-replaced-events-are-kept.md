---
status: proposed
date: 2026-11-11
---

# A replaced Event is kept and marked, never deleted

A re-grouping replay will group past Signals again with a better grouping
rule. Some Events then become obsolete. In August the pipeline made three
Events, A, B and C, each with one Signal about the same attack. The replay
makes one Event, D, with all three Signals.

No re-grouping replay exists yet (Dagster migration, D7). It is coming. This
ADR decides what the replay does with A, B and C, so that the work starts
from a rule. ADR-0021 (rule 2) depends on this decision.

Deleting A, B and C costs more than a chart:

- An escalation, a comment or a Crisis link that a person put on A is deleted
  with A (the foreign keys cascade).
- An Event with an Alert cannot be deleted. The replay would delete the Alert
  and raise a new one, dated today.
- A link to A in a sent email or a bookmark stops working.
- The onset and the places of A are gone, and the metrics of August need them
  (ADR-0021).

## Terms

| Term | Meaning |
|---|---|
| Replaced Event | An Event that a run emptied: all its Signals are now in other Events. It is kept and marked. |
| Replacement | The Event that a Replaced Event points to. |
| Live Event | An Event that is not replaced. |
| Final replacement | The Live Event at the end of the chain A → D → F. |

**Decision**: a run never deletes an Event. It marks the Event as replaced
and points it to its Replacement. Every live view reads Live Events only.

## The mark

- `events.replaced_by_id`: the Replacement. Null for a Live Event.
- `events.replaced_at`: the instant of the mark.
- `events.replaced_by_run_id`: the run that made the mark (the `runId` of
  ADR-0020).
- An Event is live when `replaced_by_id` is null. There is no second flag.
- The mark is permanent. No run clears it. To undo a replay, run another
  replay; it makes new Events.

## When an Event is replaced

- **Merge** (A, B and C become D). A, B and C are replaced by D.
- **Merge into an old Event** (B and C join A). A stays live and keeps its
  id. B and C are replaced by A. The replay prefers this to a new Event when
  one of the old Events fits: fewer links break. When some of the Events
  have an Alert, the Event with the oldest Alert is the one that stays live.
  Its Alert does not move, and the unique constraint on `alerts.event_id`
  is never in the way. When the Events merge into a new Event, the oldest
  Alert moves to it; the new Event has no Alert yet.
- **Split** (A becomes two Events). A stays live with the Signals that still
  belong to it. A new Event takes the rest. Nothing is replaced.
- **All Signals leave** an Event for more than one Event. The Event is
  replaced by the Event that took most of its Signals. When the Event has an
  Alert, it is replaced by the Event that took the Alert.
- A Replacement can be replaced later (A → D → F). A reader follows the chain
  to the Final replacement.
- A Replaced Event is never a Replacement for a new mark, so the chain has no
  loop. clear-api refuses a mark that points to a Replaced Event or to the
  Event itself.

## What moves, and what stays

The replay does these in one transaction with the mark.

| Thing on the Replaced Event | What happens |
|---|---|
| Signal links (`signal_to_events`) | Move. The table holds live grouping only. The grouping log keeps the history (ADR-0021). |
| The Alert | The oldest Alert among the merged Events is the Alert of the real-world event. It ends on the Live Event and keeps its `created_at` and the onset it was raised on (ADR-0021). Every other Alert stays on its own Replaced Event and is archived, not deleted. An Event has one Alert at most (`alerts.event_id` is unique and required), so no two Alerts ever trade places: see "Merge into an old Event". |
| Crisis links | Move. A link that the Replacement already has is not added twice. |
| Comments and feedback from people | Move, with their author and their date. |
| Escalations | Move. One person has one escalation per Event. When a person escalated several of the merged Events, the Replacement gets one row: the earliest `validFrom`, the latest `validTo` (open when one is open), and `isCrisis` when one has it. The other rows stay on their Replaced Events. Nothing is deleted. |
| Onset, places, title, severity and the other Event fields | Stay on the Replaced Event, as the run that made it left them. No run writes them again. The Event facts log (ADR-0021) also holds the onset and the places as each run gave them. |
| The knowledge-base card (ADR-0006) | Removed for the Replaced Event. The Replacement gets its card. |

A person's work is then on the Event that people see, and the Replaced Event
is a frozen record of what the pipeline made.

## Who sees a Replaced Event

- **Lists, maps, counts, search, exports and the Agent's tools** read Live
  Events only. One shared filter gives this, in the way `ingestedSignal` gives
  one definition of an ingested Signal. No query writes the condition by hand.
- **A read by id** returns the Replaced Event with `replacedBy`, the Final
  replacement. clear-mvp sends the user to that Event and says once that the
  Event was merged. A link in an old email keeps working.
- **The pipeline** reads Live Events only: grouping, alert checks and
  recomputes never see a Replaced Event.
- **The history series of `/metrics`** read Replaced Events (ADR-0021,
  decision 6). They are the only readers that do.
- **Mutations** refuse a write to a Replaced Event with a message that names
  the Replacement. A person does not add a comment to a hidden Event.

## Considered options

- **Delete the Event** and copy what the metrics need to logs (an Alert log,
  an Event facts log). Rejected: the logs save the charts and not the
  people's work or the links, and they are two more tables with write paths.
- **A status value** (`REPLACED`) with no pointer. Rejected: a reader cannot
  find where the Alert and the comments went.
- **A link table** (many Replacements for one Event). Rejected: a split does
  not need it when the old Event stays live, and a single pointer keeps "send
  the user to the new Event" a plain answer.
- **Rewrite the old Event in place** and never make a new one. It works for a
  merge into an old Event, and the replay prefers that. It cannot express
  three Events that become one: two of them must go somewhere.

## Consequences

- One migration: three columns on `events`, a foreign key from
  `replaced_by_id` to `events` that refuses a delete, and a partial index on
  Live Events.
- Every Event reader in clear-api goes through the shared filter. This is the
  risk of the design: one missed query shows a duplicate to users. The pull
  request that adds the mark also adds the filter to every reader, and a test
  that seeds one Replaced Event and reads every list query.
- `deleteEvent` stays for an admin who removes a mistake or test data. It is
  not for a run. It refuses an Event that is a Replacement.
- The table grows: a replay adds Events and removes none. Replaced Events
  have no Signal links, so the joins of live queries do not see them.
- Analyst merges and splits
  ([Exponential #1268](https://www.exponential.im/w/clear/products/clear/tickets/1268))
  can use the same mark, with a person as the author. That ticket decides it.
- ADR-0021 needs no Alert log: the Alert row stays, with the onset it was
  raised on. Its rule 2 is this ADR.
- A re-grouping changes no history series. An archived Alert on a Replaced
  Event still counts in time to alert as delivered: a Live run raised it.

## Open points

- Does the page of the Replacement show its history ("merged from A, B and C
  on 12 Nov")? The data is there; the screen is a product decision.
- When a split leaves a person's comment on the wrong half, nobody moves it.
  Is that acceptable for the first version?
