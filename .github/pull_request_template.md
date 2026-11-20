## What

## Why

## Merge Danger

<!-- What could break when this merges or ships, and for whom. "None" is fine. -->

## Manual deploy steps

<!--
Required: CI fails the PR while this section is blank.

Write "None" if nothing has to be done by hand when this ships.

Otherwise list every step the code needs but no code performs (insert a row,
set a secret, run a script). For each step give the exact command, then one
checkbox per environment, and link the ticket that tracks the prod step. You
own each step until prod is ticked. Example:

```sql
INSERT INTO "data_sources" (...) VALUES (...);
```
- [ ] dev
- [ ] prod: https://www.exponential.im/w/clear/products/clear/tickets/<number>

Better still, make it code: a row that code looks up by name ships as a
migration, never only in seed.ts.
-->
