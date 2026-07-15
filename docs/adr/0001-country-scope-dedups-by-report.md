---
status: accepted
---

# Country-wide aggregation dedups by report, not by location

Extraction produces one report-level scalar per field (e.g. `casualties.killed.total`) plus a flat list of every location the report mentions anywhere — `_collect_location_refs` walks the whole blob. The aggregator's incident key is `(event, location, time_bucket)`, which presumes per-location values that extraction never produced, so `extractNumericMentions` fans the single scalar out to every `locationId` on the report. That fan-out is correct and necessary for location-scoped buckets — it is how a sub-national bucket sees a report at all — but at country scope (`locationScope === null`) every fanned-out copy lands in a distinct incident group, and `additive_count` then sums them. One report stating 10 killed while mentioning Sudan, North Darfur, and El Fasher yielded a country-wide `killed_total` of **30**, with `contributing_report_ids` still reporting a single report.

**Decision**: when `locationScope === null`, group mentions by `reportId|date_bucket` instead of `locationId|date_bucket`. One winner per report per bucket, so a report-level scalar contributes exactly once to a country-wide sum. Location-scoped aggregation keeps the existing fan-out behaviour unchanged.

## Considered options

- **Attribute numbers to locations at extraction time** — make the LLM emit per-location figures so the incident key means what §6.4.1 claims. This is the architecturally correct model and is a prerequisite for extracting `population_affected` properly. Rejected *for now* only on cost: it needs a schema bump, prompt work, and re-extraction of every report. It remains the real fix.
- **Pick a single primary location per report** — cheaper, but discards the sub-national attribution that location-scoped buckets depend on.

## Consequences

- Country-wide and location-scoped buckets now use different grouping keys. This is deliberate and will look wrong to a reader who hasn't read this ADR — that asymmetry is the whole reason this file exists.
- Only `additive_count` fields were affected: `killed_total`, `injured_total`, `new_displacements`, `returnees`, `security_incidents_count`, `aid_workers_killed`, `funding_received_usd`. `latest_state` and `set_union` were always immune, since max/latest over N identical copies is that same value.
- The dashboard consequence that motivated the urgency: `funding_required_usd` is `latest_state` (was correct) while `funding_received_usd` is `additive_count` (was inflated), so the reported funding gap was systematically too small — the failure direction that moves money away from an under-funded response.
- Existing aggregated buckets computed before this change are wrong for the fields above and need recomputation. The bitemporal supersede-and-insert model makes this a regeneration, not a migration.
- The 23 existing aggregation tests passed throughout — none covered a multi-location report at country scope. A regression test for this case is required.
