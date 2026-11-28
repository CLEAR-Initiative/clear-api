---
status: proposed
date: 2026-11-27
---

# Other sites of a Signal

A Signal can name more than one site. An example is "airstrikes target RSF
positions around the airport and Dumayyah camp in Nyala". Before this change
CLEAR stored one location for each Signal, so the map showed one pin and the
second site was lost. A new join table, `signal_sites`, holds the other sites
next to the one primary location.

Feature: [Exponential "Geocoding of signals"](https://www.exponential.im/w/clear/products/clear/features/cmvtb7aox002mjs08t5hhigt9), scope V6.
Ticket: [Exponential #1690](https://www.exponential.im/w/clear/products/clear/tickets/1690).
Decisions: D-0287 (store the other sites in a join), D-0294 (do not wait for #1657, and add no temporary field).

## Terms

| Term | Meaning |
|---|---|
| Primary location | The one location of a Signal: `location_id`, or for displacement `origin_id`, else `destination_id`. |
| Other site | A place that the Signal's text names, besides the primary location. One row in `signal_sites`. |
| Kind | What an other site is. One value today: `NAMED_SITE`. |

**Decision**: a Signal keeps one primary location in its three location
columns. The table `signal_sites (signal_id, location_id, kind, name,
created_at)` holds its other sites, with the primary key
`(signal_id, location_id)`. The pipeline writes them with
`setSignalOtherSites`; clients read them as `Signal.otherSites`.

## The rules

- **No change to the primary location.** `setSignalOtherSites` does not write
  `location_id`, `origin_id` or `destination_id`. A site equal to one of
  these three is dropped on write, and filtered out on read when the Signal
  is later moved onto it, so a map draws one marker for one place.
- **Nothing that groups or measures reads the table.** Grouping keys on the
  district of the primary location. Location precision (ADR-0012), the
  location Outcomes (ADR-0020) and Location challenges read the primary
  location only. A site is for the map.
- **Replace, not append.** A call replaces the Signal's whole set in one
  transaction that locks the Signal row first, so two overlapping calls leave
  one caller's set, not the union. A replay gives the same set, and a later run with fewer names
  drops the stale ones. An empty list clears the set.
- **Caller.** Admin or the pipeline role. A person does not edit sites in this
  scope.
- **Cascade.** A row goes with its Signal and with its location.
- **One row for one location.** A repeated location keeps its first name.

## Why a join, and not

- **A JSON column on `signals`.** No foreign key, so a deleted location leaves a
  dangling id, and a client cannot load the location with the Signal.
- **An array of location ids on `signals`.** Same problem, and no place for the
  name as written or the kind.
- **Wait for the role of a site (#1657).** The join is additive and small. The
  `kind` column can take the role values later without a new table (D-0294).
- **A second Signal for each site.** It counts one report twice in grouping and
  in every metric.

## Consequences

- Hard to reverse: once clients render `otherSites`, removing the table breaks
  them. Adding a value to `signal_site_kind` is cheap.
- `Signal.otherSites` is one query for each Signal. A list query that asks for
  it on many Signals should preload `otherSites.location` (the field resolver
  has a fast path for it).
- clear-pipeline must run against a clear-api that does not have the mutation
  yet: its client keeps a "supported" flag and skips the call (#1691).
