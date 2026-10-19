# Task queue design session — settled decisions (for /to-prd)

Branch: clear-api feat/task-queue-design (ADR-0010 proposed; CONTEXT.md "Tasks and Workers").

1. Platform capability, not a feature: one generic Task table in clear-api with a row-level lease,
   exposed as a Worker protocol over GraphQL (request, claim, heartbeat, complete, fail). ADR-0010.
2. Vocabulary: Task, Worker, Request enrichment, Event enrichment, ImpactPrior (ontology class;
   "event prior" dropped). Flagged: "escalate" (code=Alert, ontology=Crisis), "agent" overload.
3. Results: an ImpactPrior table shaped on the ontology's attributes, linked to Event and Task;
   quantitative fields nullable for the POC; raw Worker output stays on the Task. Supersede, never overwrite.
4. ImpactPrior case boundary (POC): same hazard type + same country, labelled by geographic scope
   (same district vs same country). Exclude: same event's earlier phase (duplicate kind, later),
   different hazard, other country/context (analyst decision only). Horizon 10 years default,
   overridable per request; seasonality a note per case, not a filter. Zero cases → Task completes
   "no prior found", no ImpactPrior row.
5. Who may request: same rule as escalateEvent (requireTeamContentWriter: admin/analyst anywhere;
   team_admin/field_coordinator for a team). Requester + team recorded on the Task. Cost control
   is a Task-side cap (later question), not a permission.
6. Origins: requester nullable; Task carries `origin` (user | rule | api). No automatic rule built
   in the POC; columns only.
7. First Worker: a scheduled Claude Code routine using the clear-mcp plugin + a new Worker tool
   module in clear-mcp (claim / heartbeat / complete / fail) behind a config flag (escape-hatch
   pattern, ADR-0004) + an ImpactPrior skill. Needs a clear-mcp ADR amending ADR-0002 (writes,
   unattended → compensating control is the narrow `worker` role in clear-api). Dagster drain is the
   production Worker afterwards, same contract. Any MCP client (e.g. a Grok bot) can be a Worker with
   its own worker key; hosted (HTTP) clear-mcp not built yet, so remote bots run npx locally for now.
   Follow-up question flagged: analyst acceptance step for Worker-produced ImpactPriors.
8. Worker identity: one service user per Worker with a new narrow `worker` role (claim / heartbeat /
   complete / fail on Tasks it holds + content-reader reads). Lease owner = that user id. POC: a
   `create-worker-user.ts` script (copy of create-pipeline-user). Follow-up ticket: `worker` in
   GlobalRole, admin mutations on the dev-user pattern (create Worker, rotate key), Workers tab in
   the clear-mvp admin page (last used, tasks completed, revoke).
9. Acceptance gate: ImpactPrior has states proposed → accepted | rejected. Workers write proposed
   only; an analyst decides; only accepted counts downstream; rejection keeps the row (superseded)
   with a reason. Decision fields follow the ontology's DecisionRecord composition (named person,
   when, rationale), extractable to a DecisionRecord table later.
   Inbox facts: /inbox = hotline ground threads only (list + reading pane + approve/reject w/ reason
   + Add to CLEAR → Signal); states unverified/approved_private/approved_public/rejected; Location
   corrections ("Consideration") have a review state but no UI. Candidate concept: Review item.
10. Inbox generalised: concept "Review item" (anything awaiting a named person's decision);
    the Inbox lists Review items by kind — hotline threads (today), proposed ImpactPriors (second
    kind, now), Location corrections (third, later). ImpactPrior also decidable from the Event
    page (two doors). Glossary written to clear-mvp CONTEXT.md on branch docs-task-queue-glossary.
11. Lease/retry defaults (all accepted): lease 15 min extended by heartbeat; 3 attempts then
    FAILED with last error (visible on Event page + to requester); claim size Worker's choice up
    to a cap; cancel: PENDING outright by requester/admin, LEASED at next heartbeat/complete with
    Worker told to stop; one open Task per Event+kind (second request returns the existing one;
    after completion a new request makes a superseding ImpactPrior); Tasks never deleted.
12. Spend: record model/tokens/costUsd on each completed Task when the Worker reports them.
    Enforced: per-requester daily cap on new requests (~20) at request time; platform-wide daily
    claim cap settable by admins later once Dagster reports dollars. No per-team dollar budget yet.
13. Notifications: on completion or failure notify the requester AND every eligible reviewer on
    the Event's team, in-app and by email, action link → Event page (accept/reject there) ;
    Inbox shows the waiting count. (User chose the wider fan-out over requester-only.)
14. Who decides: platform admins and analysts only (hotline-review default). Field coordinators
    can request, see the proposal and comment, not decide. Q13 fan-out = requester + the Event's
    team's analysts + platform admins.
15. Visibility: follows the Event for Task status and accepted ImpactPriors; proposed visible to
    the requester + deciders only; rejected visible to deciders as superseded.
16. Humans as Workers: design-only in v1 (lease owner may be a user id); no claim UI for people.
17. Analysis requests migrate onto the Task table as a follow-up after the first Worker proves the
    contract; request mutation shape kept so clear-mvp is untouched. Crisis flag + translation queue stay.

Assumptions stated at wrap-up (not separately asked): button on Event page via a new tRPC
procedure; Task kind string `event.impact_prior`; Worker procedure = CLEAR incident-tier search
first, then web, source URL + quote per external case; clear-mcp Worker tools behind
CLEAR_MCP_WORKER=1 with a clear-mcp ADR amending ADR-0002; routine polls every ~15 min; worker role
= content-reader reads + Task mutations only; ontology-in-code is a separate track.
