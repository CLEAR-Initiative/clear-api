---
status: accepted
date: 2026-11-16
---

# The gx pipeline mints its Signal ids

Records in the S3 data lake point at Signals. A lake record must be able to
name its Signal before Postgres has seen it. So for the sources that only the gx
pipeline ingests, the pipeline mints the Signal id and clear-api stores it as
`signals.id`. Signals that people create keep a Prisma id.

Feature: [Exponential "Pipeline-owned Signal ids"](https://www.exponential.im/w/clear/products/clear/features/cmwj5xiyu0001jq08tjoj5qlm).
Ticket: [Exponential #1485](https://www.exponential.im/w/clear/products/clear/tickets/1485).

## Terms

| Term | Meaning |
|---|---|
| Pipeline id | `uuid5(NS, externalId)`: a lowercase UUIDv5. NS is one fixed UUID in clear-pipeline. externalId is the prefixed key, such as `idmc:123`. |
| cuid | The id Prisma mints (`@default(cuid())`): `c` followed by 24 characters `[a-z0-9]`. |
| Case id | `case` followed by 32 lowercase hex characters, minted at case acceptance. |
| gx-owned source | A source that only the gx pipeline ingests: `idmc`, `sudan_witness`, `iom_dtm_flash_alerts`, `inso`. |

**Decision**: `createSignal` accepts an optional `id`. clear-api stores the id as
given when it is a Pipeline id, the input has an externalId, and the input is
not manual. Every other path still gets a cuid. The three formats are
disjoint, and a CHECK constraint enforces them.

## The rules

- **Shape**: a supplied `id` that is not a lowercase UUIDv5 gets
  `BAD_USER_INPUT`. The same happens with no externalId, or with a manual
  input (`rawData.manual`). A UUIDv4, an uppercase id and a cuid are all
  refused.
- **Existing row**: when `(sourceId, externalId)` already exists, clear-api
  returns that row unchanged. Its id may be a cuid created before this ADR.
  The pipeline records that mapping in `gold.signal_id_aliases`.
- **Unique clash on the primary key**: clear-api reads the row by id again.
  The same `(sourceId, externalId)` means a concurrent create of the same
  Signal, so clear-api returns that row. Anything else gets `CONFLICT`, and the
  message names the source and externalId that hold the id.
- **Unique clash on `(source_id, external_id)`**: a dedupe race, handled as
  before.
- Prisma 7 with `@prisma/adapter-pg` puts the columns of the violated
  constraint in `meta.driverAdapterError.cause.constraint.fields`, not in
  `meta.target`. `uniqueViolationFields` in `src/utils/prisma-errors.ts`
  reads them.
- **CHECK `signals_id_format`**: `id` is a cuid, a Case id or a lowercase
  UUIDv5. It checks existing rows too, so the migration fails in an
  environment holding another format. Run the shape query there first;
  it must return no `other` row:

  ```sql
  SELECT ds.name AS source,
    CASE WHEN s.id ~ '^c[a-z0-9]{24}$' THEN 'cuid'
         WHEN s.id ~ '^case[0-9a-f]{32}$' THEN 'case'
         WHEN s.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN 'v5'
         ELSE 'other' END AS fmt, count(*) AS n
  FROM signals s JOIN data_sources ds ON ds.id = s.source_id
  GROUP BY 1, 2 ORDER BY 1, 2;
  ```

## Unchanged

`createManualSignal`, ground promotion, X ingest, case acceptance, the seeds
and the legacy poller (`dataminr`, `acled`, `darfur24`) keep minting their
ids as before. Those three sources become gx-owned when gx is their only
ingester; their existing rows then get aliases at push time.

## Considered options

- **Prisma keeps minting every id, and the pipeline aliases every Signal.**
  Cheaper: no clear-api change. Rejected: the pipeline does not own
  `signals.id`, and the alias table becomes required for every Signal.
- **The raw prefixed externalId as the lake key.** Rejected for the same
  reason: Prisma would still own `signals.id`.
- **Rewrite existing cuids to Pipeline ids.** Rejected: `estimates_immutable`
  blocks it, and soft references and URLs that hold the old ids would break.
- **Accept any UUID version.** Rejected: only v5 is deterministic from the
  externalId, so a v4 or v7 id is not a Pipeline id. The CHECK and the
  analytics allowlist in clear-mvp accept v5 only.
- **The pipeline mints cuids**, the id format of every other model. Rejected:
  - A cuid is random, so the lake cannot recompute it from the externalId.
  - A hash shaped like a cuid would be indistinguishable from Prisma's own
    cuids, so the CHECK could not keep the formats apart.

  Not a loss of consistency: `signals.id` already allowed two formats (cuid
  and Case id), so consumers already could not assume a cuid. The pipeline
  adds a third.

## Consequences

- Deploy order: shape query clean, then clear-api (input and CHECK), then
  clear-pipeline. A pipeline that sends `id` to
  an older clear-api fails every create.
- The v5 pattern is written twice, once in TypeScript and once in the CHECK.
  A CHECK cannot import TypeScript. The docstring of the TypeScript pattern
  points to the migration.
- `CONFLICT` is a new error for `createSignal`. Only a caller that supplies
  an `id` can get it, and today that is only the pipeline.
- clear-mvp treats a Signal id as one of three formats (Exponential #1486).
- ADR-0002 joins key parts with NUL. NUL cannot occur in any of the three
  formats, so ADR-0002 still holds.
