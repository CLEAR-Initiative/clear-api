# Per-feed Data Sources for push feeds

CLEAR's existing data sources are *platforms* polled by our own pipelines — one
`dataSources` row per provider (`dataminr`, `acled`, `gdacs`, `dtm`). X push
ingest ([#530](https://www.exponential.im/w/clear/products/clear/tickets/530))
inverts the direction: an external poller (Max, a Grok bot) watches a curated
topic watchlist and POSTs batches to `POST /api/x/ingest`. That raised the
question of what the Data Source row represents for pushed content: the
platform (`x`) or the feed.

**Decision**: one Data Source row **per push feed**, not per platform. The
first feed is `{ name: "sudan-war-x", type: "webhook", reliability: null }`;
the batch body self-identifies its feed via `source`, which must resolve to an
active row — no auto-creation. A second watchlist (another topic or country)
is provisioned as data: a new row via the existing `createDataSource`
mutation, zero code.

The `externalId` prefix stays **platform**-scoped (`x:{post id}`), because the
post id is X's identity, not the feed's. If two feeds ever overlap, the same
post still dedupes into one Signal per feed row under the
`[sourceId, externalId]` unique constraint — and would collapse to one row
globally if feeds were ever merged.

## Considered options

- **Per-platform source (`x`) + a topic tag field on Signals** — keeps one row
  per provider, but invents a tagging mechanism the Signals tier doesn't have.
  Topic/watchlist filtering is exactly what the Signal→source relation already
  provides; a parallel tag field would duplicate it.
- **Topic-scoped route (`/webhooks/sudan-x`)** — encodes the feed in code, so
  every new watchlist costs a deploy. Topic lives in data, not routes.
- **Static shared-secret header** (the ticket's original `X-Clear-Webhook-Secret`)
  — rejected in favour of the existing API-key system (`pipeline` role), which
  gives rotation, revocation, and per-caller attribution for free.

## Consequences

- Feed-level provenance and filtering ride the existing `signals.sourceId`
  relation; "tagged Sudan / conflict" is a query by source, not a tag column.
- `reliability` stays `NULL` (ungraded) for push feeds by design — X posts are
  never treated as verified reporting; the data-quality formula already treats
  `NULL` as the floor.
- The seed gains the `sudan-war-x` row for dev; the production row is created
  manually via `createDataSource` before the poller goes live.
- Per-feed rows mean per-feed `isActive` — a noisy or retired watchlist is
  switched off in data without touching the endpoint or other feeds.
