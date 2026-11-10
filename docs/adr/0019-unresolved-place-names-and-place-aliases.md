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
4. **The state and the country come from the area.** The pipeline sends the
   area. The server takes the area's level-1 ancestor as the state. The state
   is null when the area is the country. The server also stores the area's
   level-0 ancestor in `countryLocationId`. That column is not part of the
   key. It places a row with no state inside a team's area. `countryCode`
   cannot do this: a country location does not always carry its ISO code
   (`ensureCountryLocation` and the seed set none).
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
    no state belongs to its country (`countryLocationId`), so only a team that
    covers the whole country reads it. All other roles get FORBIDDEN. These are the people who
    decide Location challenges.
12. **The database checks the value sets.** `status`, `reason` and the alias
    `source` (`review`, `seed`, `manual`) each have a CHECK constraint.

## Resolving a row

Slice [#1309](https://www.exponential.im/w/clear/products/clear/tickets/1309) adds
`resolveUnresolvedPlaceName`, `placeNameSuggestions` and the alias tier of
`resolveGazetteerLocation`.

13. **A decider gives one of five answers.** `LOCATION` (an existing CLEAR
    location), `GEONAMES` (a GeoNames suggestion), `POINT` (a new point),
    `NOT_A_PLACE` or `AMBIGUOUS`.
14. **A GeoNames answer or a point becomes a level-4 landmark** through
    `findOrCreateLandmarkL4`. The alias then points at that landmark.
15. **The answer must be in the row's country.** A team admin must put it
    inside the row's state. A platform admin can put it anywhere in the
    country.
16. **A location answer writes the alias and closes the row in one
    transaction.** The alias has the row's spelling, the row's state as its
    scope and the source `review`. The status change is conditional on the
    status that the request read. One of two deciders wins, and the other
    gets CONFLICT. This holds also when the first answer was `AMBIGUOUS`,
    which leaves the row resolvable: the second decider must read the row
    again.
17. **The row's Arabic spelling gets a second alias** to the same location.
    The Arabic spelling is the source's own. The Latin spelling is a
    transliteration, and it changes from post to post. An Arabic alias that
    exists already stays as it is.
18. **The same transaction moves the waiting Signals.** A Signal moves when
    the alias location is inside the Signal's current location, and no person
    corrected the Signal (`locationCorrectedAt` is null). A human correction
    always wins. The link gets `relocatedAt`.
19. **A move is not a correction.** It does not set `locationCorrectedAt` or
    `pipelineLocationId`. Location precision (ADR-0012) therefore reads a
    moved Signal at the alias location, in the week the pipeline located it.
20. **A move does not change the Signal's Event.** #1316 decides re-grouping.

    **A late miss moves at once.** A pipeline run can miss the alias lookup
    just before a resolution commits, and record its miss just after. The
    record transaction then applies the row's alias to that Signal, under the
    rule of point 18. The pipeline records a miss after it saves the Signal's
    location, so the rule has a location to test.
21. **`AMBIGUOUS` is a status of its own, and the row stays resolvable.** The
    open queue (status `OPEN`) hides it. A person with local knowledge can
    resolve it later. `RESOLVED` and `NOT_A_PLACE` are closed.
22. **The gazetteer checks aliases first.** An alias applies when the
    normalised name and the country match, and its scope is the whole country
    or holds `withinLocationId`. A scoped alias wins over a country-wide
    alias. With no `withinLocationId`, only country-wide aliases apply.
23. **An alias hit is a `GazetteerHit`** with `source: ALIAS`, the
    `locationId` and the location's point (a point on the polygon for a
    district). A GeoNames hit has `source: GEONAMES` and no `locationId`. A
    pipeline that does not read the new fields still gets coordinates.
24. **The server does not test the alias location against
    `withinLocationId`.** The pipeline checks the point, as it does for a
    GeoNames hit.
25. **Suggestions are computed on each call.** Up to 5 GeoNames candidates
    (trigram floor 0.2, exact match for Arabic) and up to 5 CLEAR districts or
    named landmarks. The two lists are ranked as one: candidates inside the
    area come first, then the most similar, then the nearest. A CLEAR
    location's name is normalised in SQL like the query, so an Arabic name
    matches its own spelling.
26. **Each human write is logged:** `place_name.resolve`,
    `place_name.not_a_place`, `place_name.ambiguous`.

## The alias list

Slice [#1310](https://www.exponential.im/w/clear/products/clear/tickets/1310) adds
`placeAliases`, `createPlaceAlias`, `updatePlaceAlias` and `deletePlaceAlias`.

27. **Every decider reads every alias.** The list is a gazetteer, not private
    data. `canEdit` on each alias says whether the caller may change it.
28. **A team admin writes the aliases scoped inside the team's area.** A
    platform admin writes all aliases. A country-wide alias applies to every
    state, so only a platform admin adds, changes or deletes one.
29. **A scope is a state, or the whole country.** A district is refused.

    **An alias never crosses a border.** The scope and the target must be
    inside the level-0 location of the alias's country. That location is
    found by its pcode, or, for a pipeline country with no pcode, by its
    name. A country with no location cannot have aliases: nothing could be
    checked.
30. **An alias added by hand has the source `manual`.** Its target is an
    existing location or a new point. A point becomes a level-4 landmark.
    The target rules are those of point 15.
31. **A new alias closes the open queue rows it answers.** A scoped alias
    closes the rows of its spelling in its state. A country-wide alias closes
    the rows of its spelling in every state. Each row closes through the
    resolve function of point 16, so its waiting Signals move. The alias and
    its rows are one transaction: a failure saves nothing, and the request
    can be sent again. A row under the Arabic spelling closes under the
    Arabic alias, with that alias's own target.
32. **A change applies to new Signals only.** A new target or scope does not
    move the Signals that the alias moved before.

    **A narrower scope reopens the rows it leaves out.** A row that the alias
    answered, in a state that the new scope does not cover, goes back to
    `open`. A late miss (point 20) checks the alias's scope as it is now.

    **A write goes through only on the alias as read.** An update or a delete
    is conditional on `updatedAt`. An alias that changed in between gives
    CONFLICT. An update writes only the fields that the request changes.
33. **A deleted alias reopens its queue row.** The row goes back to `open`,
    and a decider can answer it again. The Signals that the alias moved stay
    where they are.
34. **The two aliases of one answer are separate rows.** A resolution writes
    one alias for the Latin spelling and one for the Arabic spelling. A
    change or a delete applies to one row. The list shows both.
35. **The list pages by cursor**, newest first.
36. **Each write is logged:** `place_alias.create`, `place_alias.update`,
    `place_alias.delete`.

## Not in these slices

- Re-grouping a Signal that moved: [#1316](https://www.exponential.im/w/clear/products/clear/tickets/1316).
- Loading a list of aliases from a file: [#1314](https://www.exponential.im/w/clear/products/clear/tickets/1314).

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
  (`ON DELETE RESTRICT`). Delete or re-point those rows first. The seed reset
  (`prisma/seed.ts`) deletes the queue and the aliases before the locations.
- An alias goes away with its target location (`ON DELETE CASCADE`). The
  queue row keeps its status and loses the link (`ON DELETE SET NULL`).
- A deleted Signal removes its links. `signalCount` does not go down.
- `prisma migrate diff` lists the two hand-written unique indexes as drift,
  like the other hand-written indexes in this schema. Do not drop them.
- clear-pipeline calls `recordUnresolvedPlaceName` on each miss
  ([#1308](https://www.exponential.im/w/clear/products/clear/tickets/1308)).
- A landmark made for an answer stays when the resolve then loses a race.
  The next answer with the same name and place reuses it.
- A resolution moves Signals of past weeks, so the location precision of
  those weeks goes up without a pipeline change. Read a jump in an old week
  against the queue's activity log.
- clear-pipeline must use `locationId` from an alias hit directly
  ([#1311](https://www.exponential.im/w/clear/products/clear/tickets/1311)).
  Until then it makes a landmark from the hit's point.
