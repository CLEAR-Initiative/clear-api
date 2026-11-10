---
status: accepted
date: 2026-11-10
---

# Unresolved place names and place aliases: CLEAR's own tables beside GeoNames

## Problem

The pipeline cannot geocode some place names that a Signal gives.
The Signal then falls back to its state or its country.
A Signal at state level cannot group, because grouping keys on district.

The miss goes only to a log line.
Nobody sees it, and nobody can fix it.
A fix in the GeoNames tables does not stay: the importer runs
`TRUNCATE geonames, geonames_name RESTART IDENTITY CASCADE` on each reload.

147 of 928 X posts (16%, 20 to 27 October 2026) named a place with no match
inside the area that the model chose.

Parent spec: [Exponential #1265](https://www.exponential.im/w/clear/products/clear/tickets/1265).
This slice: [#1307](https://www.exponential.im/w/clear/products/clear/tickets/1307).

## Terms

| Term | Meaning |
| --- | --- |
| Unresolved place name | A place name, as written in a Signal, that geocoding could not place inside the Signal's area. |
| Place alias | A spelling that CLEAR maps to a CLEAR location. CLEAR owns it. |
| Alias scope | The area where a place alias applies: one state, or the whole country. |
| Area | The location that the pipeline chose for the Signal. Geocoding looks inside it. |
| Decider | A person who works the queue: a platform admin, or a team admin inside the team's area. |

## Decision

CLEAR stores unresolved place names and place aliases in three tables of its own.

| Table | One row is |
| --- | --- |
| `unresolved_place_names` | One spelling in one state of one country. The queue. |
| `unresolved_place_name_signals` | One Signal that named the spelling. |
| `place_aliases` | One spelling that maps to one CLEAR location, inside one scope. |

1. **The tables stand beside GeoNames.** No foreign key points at `geonames`
   or `geonames_name`. `CASCADE` follows foreign keys, so a foreign key would
   let the importer empty these tables. GeoNames stays a pure copy of the
   public download. A DB test runs the importer's own statement and checks
   that the three tables keep their rows.
2. **Each place alias points at a `locations` row.** The target is a district,
   a state or a level-4 landmark. It is never a GeoNames id.
3. **The queue key is (country, normalised spelling, state).** The same
   village name in two states gives two rows. `normalizeGazetteerName`
   normalises the spelling, as the importer does.
4. **The state comes from the area.** The pipeline sends the area. The server
   takes the area's level-1 ancestor. The state is null when the area is the
   country.
5. **The alias key is (country, normalised spelling, scope).** A null scope
   means the whole country. Facilities use it.
6. **Both unique keys use `NULLS NOT DISTINCT`.** Each key ends in a nullable
   column. A plain unique index treats each null as different, so
   country-level rows would duplicate. Prisma cannot express this, so the
   migration writes both indexes by hand (PostgreSQL 15 or later).
7. **A Signal counts once per row.** The link table has the primary key
   (row, Signal). A second record of the same Signal changes nothing.
   `signalCount` is the number of links ever made.
8. **Each link keeps its own facts:** the spelling in that Signal
   (`nameAsWritten`), the area, the time (`seenAt`) and the reason. The reason
   is `no_match` (the gazetteer has no candidate) or `outside_area` (a
   candidate exists, but it lies outside the area).
9. **`seenAt` is an input.** The default is now. A backfill sends the real
   date of the Signal. The row keeps the earliest date in `firstSeenAt` and
   the latest date in `lastSeenAt`.
10. **A record never changes a row's status.** The statuses are `open`,
    `resolved`, `not_a_place` and `ambiguous`. A row marked `not_a_place` is a
    stop-list entry: a later miss adds to its count and stays closed.
11. **The pipeline records. Deciders read.** `recordUnresolvedPlaceName` is
    for the `admin` and `pipeline` roles. `unresolvedPlaceNames` is for
    deciders: a platform admin reads all rows, and a team admin reads the rows
    whose state is inside the areas of the teams they administer. A row with
    no state belongs to its country, so only a team that covers the whole
    country reads it. All other roles get FORBIDDEN. These are the people who
    decide Location challenges.
12. **The database checks the value sets.** `status`, `reason` and the alias
    `source` (`review`, `seed`, `manual`) each have a CHECK constraint.

## Not in this slice

- Resolving a row, the alias lookup in `resolveGazetteerLocation` and moving
  the waiting Signals: [#1309](https://www.exponential.im/w/clear/products/clear/tickets/1309).
- Listing and editing aliases: [#1310](https://www.exponential.im/w/clear/products/clear/tickets/1310).
- Re-grouping a Signal that moved: [#1316](https://www.exponential.im/w/clear/products/clear/tickets/1316).

## Considered options

- **Write the fix into `geonames_name`.** The next import deletes it.
- **A foreign key from the alias to `geonames`.** `TRUNCATE ... CASCADE`
  empties the alias table on each import.
- **One row per spelling in a country, with no state.** Village names repeat
  across states. One row would mix two places, and one alias would move
  Signals to the wrong state.
- **A partial unique index for the null case.** It needs two indexes per key
  and an upsert that picks between them. `NULLS NOT DISTINCT` needs one.
- **Store the suggestions on the row.** They go stale when the gazetteer
  changes. #1309 computes them on demand.

## Consequences

- A state cannot be deleted while a queue row or an alias scope uses it
  (`ON DELETE RESTRICT`). Delete or re-point those rows first.
- An alias goes away with its target location (`ON DELETE CASCADE`). The
  queue row keeps its status and loses the link (`ON DELETE SET NULL`).
- A deleted Signal removes its links. `signalCount` does not go down.
- `prisma migrate diff` lists the two hand-written unique indexes as drift,
  like the other hand-written indexes in this schema. Do not drop them.
- clear-pipeline calls `recordUnresolvedPlaceName` on each miss
  ([#1308](https://www.exponential.im/w/clear/products/clear/tickets/1308)).
