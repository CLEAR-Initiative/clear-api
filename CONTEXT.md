# CLEAR API

GraphQL API and developer-facing surfaces for CLEAR — humanitarian signals, events, alerts, and crises.

## Language

### Developer surfaces

**Developer Portal**:
The app at `/portal` where a **Developer** reads Getting Started / API Reference publicly, and manages API keys, auth guidance, and account access when signed in.
_Avoid_: dashboard, console (unless referring to browser console)

**API Docs**:
The documentation surface at `/docs` — public to read, visually aligned with the **Developer Portal**.
_Avoid_: documentation site, docs app (as a separate product)

**Portal Shell**:
The shared left-sidebar chrome used across the **Developer Portal** and **API Docs** (brand, primary nav, optional user footer).
_Avoid_: layout wrapper, app frame

**On This Page**:
The right-side in-page table of contents on **API Docs**. It lists every major section and subsection (including each schema type), expands the subsection list for the section currently in view, highlights the exact heading being read, and smooth-scrolls on click.
_Avoid_: secondary sidebar, docs left nav, TOC (in product copy — OK in code)

**Types scroller** *(nice-to-have)*:
A fade-masked vertical strip inside **On This Page** under Types that scrolls through many type links without growing the whole rail endlessly.
_Avoid_: infinite scroll (wrong metaphor)

**Sandbox**:
The interactive GraphQL explorer at `/graphql` (Apollo Sandbox). Linked from **Portal Shell** Resources (after **API Docs**) and from in-content CTAs; opens in a new tab.
_Avoid_: playground, GraphiQL (unless referring to the underlying tool)

**Mobile nav drawer**:
On narrow viewports, the **Portal Shell** primary nav is hidden by default and opens as a full-height overlay over page content (hamburger to open; outside tap or nav link to close). Content stays full width underneath.
_Avoid_: collapsed sidebar (desktop-only metaphor), full-width stacked sidebar

**On This Page sheet**:
On narrow viewports, **On This Page** is not a persistent side rail; a secondary control opens it as a sheet/drawer with the same section tree, highlight, and jump behavior.
_Avoid_: always-visible mobile TOC, top-of-page TOC block

**Developer**:
A person using the **Developer Portal** or **API Docs** to integrate with the API.
_Avoid_: user (when the actor is specifically this audience); prefer **Account** for the auth identity

**Account**:
The authenticated identity (email, role, session) shown in the **Portal Shell** footer when signed in (desktop always; on phones inside the **Mobile nav drawer**).
_Avoid_: user profile (unless talking about profile data)

### Signal ingestion

**Signal**:
A raw input from an external source — the first tier of the domain model (Signals → Events → Alerts → Crises). Stored with its raw payload and deduplicated per source by external id.
_Avoid_: post, item, record (as the tier name)

**Data Source**:
The origin a Signal is attributed to. May be a *platform* polled by CLEAR's own pipelines (`dataminr`, `acled`) or a curated **Push Feed**.
_Avoid_: provider, channel

**Push Feed**:
A Data Source whose content is *pushed to* CLEAR by an external poller, scoped to a topic/watchlist rather than a whole platform — e.g. `sudan-war-x` (Sudan-war X watchlist). Each feed is its own Data Source row; the feed relation is how its Signals are tagged and filtered.
_Avoid_: webhook source (mechanism, not concept), platform source

**X Post Signal**:
A Signal whose raw input is a single X (Twitter) post from a **Push Feed**. Ungraded reliability by design — never treated as verified reporting.
_Avoid_: tweet signal (in product copy)

### Agent conversations

**Conversation**:
The stored record of one exchange between a user and the **CLEAR Agent** — what the user
asked, what the Agent answered, and what it drew on to answer (tools run, Source documents
cited). Owned by that user.
_Avoid_: chat, session (that is auth), thread (clear-mvp's on-screen view of a Conversation)

### Estimates

**Estimate**:
A figure for one metric on an Event, named and defined by the CLEAR Domain Ontology (v0.3.0):
its value and optional bounds, how it was arrived at (**method**), whether it counts need caused
by the Event, need that existed before it, or both (**attribution**), the date it describes
(valid time) and when it was made (transaction time). The metric is one of the ontology's seven
(`people_affected`, `people_displaced_new`, `people_displaced_cumulative`, `people_in_need`,
`people_targeted`, `people_reached`, `households_affected`).
_Avoid_: figure (in code), population number, casualty count, datapoint (that is a report figure)

### Tasks and Workers

**Task**:
One unit of work of a named kind, about one subject such as an Event, waiting for or held by a
**Worker**. **Event enrichment** is the first kind of work.
_Avoid_: job, ticket, queue item, request (that is the act of asking)

**Worker**:
Anything that claims a **Task** and completes it: code CLEAR owns, a scheduled Claude Code
routine, a third-party agent, or a person. A Worker is whatever calls the four Task mutations
over GraphQL; the Dagster drain is one Worker among these, not the queue (ADR-0010). The
**CLEAR Agent** is never a Worker. A Worker doing web research plays what the CLEAR Domain
Ontology calls a web agent.
_Avoid_: agent, bot, enricher, consumer

**Request enrichment**:
The act of asking for an **Event enrichment** on an Event. Independent of escalation: an Event
may have either, both or neither.
_Avoid_: escalate to enrichment, flag for enrichment, send to queue

**Event enrichment**:
An analytical add-on to an Event, produced by a **Worker**, stored beside the Event and labelled
by its kind. A sibling of Signal enrichment (the pipeline's geo and classification step) and
Crisis enrichment (the narrative and scenarios on a Crisis).
_Avoid_: investigation, research, verification (as the family name); bare "enrichment" in field names

**Source kind**:
The kind of **Task** a **Worker** drains, naming where its evidence comes from: `event.impact_prior.clear`
(the Dagster drain over CLEAR's own Events and knowledge base), `event.impact_prior.web` (the Claude
routine over the web), any later source. One **Request enrichment** fans out into one Task per enabled
source kind, so several Workers propose on the same Event side by side; each proposal carries its
source kind so a person can see who said what. The bare `event.impact_prior` is the pre-fan-out kind.
_Avoid_: worker type, provider, channel, tier (that is a label on a single piece of evidence)

**ImpactPrior**:
The first kind of **Event enrichment**, named and defined by the CLEAR Domain Ontology: what has
typically happened before given a hazard type, a context and a population, inferred from
historical Events similar to the input Event, with its evidence basis and number of cases. It
informs an Estimate and is not itself one.
_Avoid_: event prior, precedent, history, related events

**CaseProposal**:
One historical case a web **Worker** found while enriching an Event: a past incident like it,
the source that reports it (URL and verbatim quote), when and where it happened, the figures it
gives, and the CLEAR Event it describes when CLEAR already holds one. The unit an analyst accepts
or rejects. Accepting writes it into CLEAR as history; it is evidence for an **ImpactPrior**, not
one itself.
_Avoid_: web result, search hit, prior case

## Relationships

- The **Portal Shell** frames both the **Developer Portal** and **API Docs**
- **API Docs** is publicly readable; the **Account** footer appears only when a session exists
- The **Portal Shell** shows the same primary nav whether or not an **Account** session exists; **Getting Started** and **API Reference** are public; auth-only destinations (API Keys, Authentication, Usage Analytics, Admin) send anonymous **Developers** through `/portal/login`
- **On This Page** navigates within a single **API Docs** page; the **Portal Shell** navigates between surfaces
- **On This Page** expands only the active section’s subsections; inactive sections stay collapsed to their top-level link
- The **Types scroller** is an optional enhancement inside **On This Page**, not a separate navigation surface; treat it as a stretch goal after expand/highlight/smooth-scroll work
- On phones, the **Portal Shell** uses a **Mobile nav drawer**; desktop keep/collapse width behavior is unchanged
- On phones, **On This Page** is reached via the **On This Page sheet**, not a permanent right column
- Developer HTML surfaces stay server-rendered string templates on the API server; shared chrome lives in one **Portal Shell** module rather than a separate SPA
- On desktop **API Docs**, layout is three reserved columns: **Portal Shell** | content (max-width capped) | **On This Page** (~30% wider than the previous 200px rail, pinned to the right with a gutter — not overlaid on content)
- `GET /docs` resolves the session per request to render the **Portal Shell** (with or without **Account** footer); the docs body HTML stays prebuilt and reusable across requests
- Sign out is one click (no confirmation dialog) from the **Portal Shell** footer on desktop and inside the **Mobile nav drawer** on phones
- Automated tests cover **Portal Shell**, docs page composition (including session-aware shell), and **On This Page** tree/active-section logic; visual CSS polish may be manual
- **Sandbox** is a peer resource linked from the **Portal Shell**, not a tab inside the portal

- A **Push Feed** is a **Data Source**; its Signals enter the same enrichment/event-clustering drain as any other Signal — no quarantine tier
- **X Post Signals** are deduplicated by X post id; a re-delivered post is skipped, never refreshed (engagement metrics are a first-ingest snapshot)
- Tagging by topic (e.g. Sudan/conflict) is expressed through the Signal→**Push Feed** relation, not a tag field

- A **Conversation** belongs to exactly one user; clear-api is its system of record
- A **Conversation** is readable by its owner and, read-only, by platform admins; every admin read is logged
- A **Conversation** keeps what the Agent actually said, even if the owner's access later narrows
- Each **Conversation** turn records what it cost (model, tokens, latency) alongside what was said

- An **Estimate** is never overwritten: a correction is a new Estimate that supersedes the old one, at most once, so a figure's history is a chain. The database refuses an update
- An **Estimate** always states its attribution; where bounds are present, lower bound ≤ value ≤ upper bound
- An **Estimate** follows its Event: visible to whoever may read the Event, deleted with it
- The Event fields `populationAffected` and `populationDisplaced` were backfilled once as `people_affected` and `people_displaced_new` Estimates with method `not_documented`, skipping the pipeline's placeholder defaults. `casualties` has no ontology metric and was not backfilled

- A **Task** has exactly one kind and exactly one subject; at most one Task per subject and kind is open at a time
- **Request enrichment** always fans out: one **Task** per enabled **Source kind**, sharing one request id. A kind that already has an open Task is handed back, not duplicated; only the missing kinds get a new Task. The per-requester daily cap counts requests, not Tasks
- Nothing ever marks an Event "done": proposals from each **Source kind** accumulate and a decider accepts or rejects each on its own
- A claimed **Task** is held under a lease the **Worker** keeps alive by heartbeat; a lapsed lease goes back to the pool at the next claim, and a Task that has used up its attempts is failed with its last error. There is no sweeper
- A requester or a platform admin may cancel a **Task**: a waiting one ends at once; a held one ends at the Worker's next heartbeat, completion or failure, with whatever it produced discarded
- A **Task** is never deleted; what it recorded (requester, Worker, attempts, error, spend) is its history
- Only a **Worker** completes a **Task**; what it produces for an enrichment kind is an **Event enrichment**
- An **Event enrichment** is superseded, never overwritten: a new result is a new record and earlier ones stay (the Domain Ontology's rule for Estimates and ContextObservations). Supersession stays within a **Source kind**: a new proposal from CLEAR data points at the previous one from CLEAR data, never at one from the web, so proposals from different Workers sit side by side
- **Request enrichment** and escalation are independent actions on an Event
- An **ImpactPrior** draws on CLEAR's own Events and on external sources, each labelled by tier, as knowledge base results are
- An **ImpactPrior** case shares the input Event's hazard type and country and is labelled with its own geographic scope; a case from another context enters only by an analyst's explicit decision, never by a **Worker**
- A **Task** whose **Worker** finds no case produces no **ImpactPrior**; the Task records "no prior found" and the Event stays unenriched
- A web **Worker** proposes **CaseProposals**, one per historical case, not a whole **ImpactPrior** (V4). A named person accepts or rejects each case, in the shape of the Domain Ontology's DecisionRecord (rationale required on reject); a rejected case stays, so its source is not proposed again for that Event
- A proposed **CaseProposal** is a Review item in clear-mvp's Inbox, and is also decidable from its Event's page. Proposed ImpactPriors from the CLEAR-data **Worker** are still decided whole until the ImpactPrior is computed from accepted history
- The **CLEAR Agent** is never a **Worker**; backend-triggered work never runs in clear-mvp (its ADR-0006)

## Example dialogue

> **Dev:** "If someone opens **API Docs** from the home page without logging in, do they see the **Portal Shell**?"
> **Domain expert:** "Yes — same left nav chrome, including Menu items that lead into the **Developer Portal**. They only see the **Account** footer and Sign out after they have a session."

## Flagged ambiguities

- "navbar" / "main navbar" was used for both the old docs top bar and the portal left sidebar — resolved: product language is **Portal Shell** (left sidebar). The old docs top marketing nav is removed on `/docs`.
- "sidebar" alone is ambiguous (portal left vs docs left vs right TOC) — resolved: **Portal Shell** (left), **On This Page** (right); the docs-only left sidebar is removed.
- "escalate" — in code, `escalateEvent` raises an Event to a published Alert; in the CLEAR Domain Ontology, escalation turns an Event into a Crisis and requires a DecisionRecord. Unresolved; for the ontology owner. Neither meaning is **Request enrichment**.
- "agent" — clear-mvp reserves it for the one **CLEAR Agent**; the Domain Ontology uses "Event web agent" and "Context web agent" for background collectors. Resolved for this repo: the runtime term is **Worker**; the overload is raised with the ontology owner.
- "event prior" — resolved: the Domain Ontology already defines **ImpactPrior**, which is the concept meant.
- "static HTML app" vs SPA — resolved for this work: keep Bun/Express HTML string templates; extract a shared **Portal Shell** module; keep **API Docs** prebuild + in-memory cache. No separate frontend framework.
