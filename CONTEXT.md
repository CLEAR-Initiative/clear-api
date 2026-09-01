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

## Example dialogue

> **Dev:** "If someone opens **API Docs** from the home page without logging in, do they see the **Portal Shell**?"
> **Domain expert:** "Yes — same left nav chrome, including Menu items that lead into the **Developer Portal**. They only see the **Account** footer and Sign out after they have a session."

## Flagged ambiguities

- "navbar" / "main navbar" was used for both the old docs top bar and the portal left sidebar — resolved: product language is **Portal Shell** (left sidebar). The old docs top marketing nav is removed on `/docs`.
- "sidebar" alone is ambiguous (portal left vs docs left vs right TOC) — resolved: **Portal Shell** (left), **On This Page** (right); the docs-only left sidebar is removed.
- "static HTML app" vs SPA — resolved for this work: keep Bun/Express HTML string templates; extract a shared **Portal Shell** module; keep **API Docs** prebuild + in-memory cache. No separate frontend framework.
