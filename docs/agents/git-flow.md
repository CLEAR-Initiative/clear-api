# Git flow

This repo's default/integration branch is **`dev`** (`origin/HEAD → dev`).

- **featureBase** — `dev`. Cut every ticket branch off `origin/dev` and open its PR against `dev`.
- **Promotion chain** — `feature → dev → prod`. `prod` is advanced by periodic "sync prod with dev" PRs (`dev → prod`), not by feature PRs.
- **deploy trigger** — `prod`. Work is live in production only when it reaches `prod`. A merge into `dev` runs `.github/workflows/release-dev.yml`, which tags, builds the image and pushes it to GHCR (deployment happens outside this repo); it ships to dev only and changes no Ticket. Merged branches are not deleted automatically (`delete_branch_on_merge` is off); delete them by hand or via `/cleanup`.
- **Production** — the `prod` branch, advanced by "Sync prod with dev" PRs and prod hotfix PRs. A merge into `prod` runs `.github/workflows/release-prod.yml`, which tags a new MAJOR version, builds the image and pushes it to GHCR (deployment happens outside this repo), and `.github/workflows/bot-exponential.yml`, which moves to `DONE` the Tickets in `QA` linked to that PR or to any feature PR it carries (a squash commit names its PR as `(#<n>)` at the end of its subject, a merge commit as `Merge pull request #<n> from …`; a PR of more than 250 commits fails the job, as GitHub lists no more). A Ticket in any other status is left alone.
- **Hotfixes** — a fix that cannot wait for the next sync is a PR into `prod` (for example #320, #349, cherry-picking the `dev` PRs it carries), then the same change reaches `dev` so the next sync does not revert it. A hotfix now needs one approving review like any prod merge, and nothing checks its **Manual deploy steps** ([clear #1550](https://www.exponential.im/w/clear/products/clear/tickets/1550)) — `check.yml`'s gate is scoped to `base_ref == 'dev'`.

## `prod` branch protection

Set 2026-11-20 ([clear #1556](https://www.exponential.im/w/clear/products/clear/tickets/1556)): one approving review required, no force pushes, no deletions, and **no required status checks**. `check.yml` does run on PRs into `prod` here, so a check could be required — it is not, so that this repo and clear-pipeline are configured identically, and because clear-pipeline's `check.yml` runs only on PRs into `dev`, where requiring one would leave every prod PR pending forever.

`sync-pr-body.yml` holds a sync PR at `BLOCKED` with a *changes requested* review while any `prod` box is unticked. `enforce_admins` is **off** on purpose: an administrator can merge without an approval, so an emergency hotfix is never wedged behind an absent reviewer. The gate is loud, not absolute, and an override shows in the PR timeline.

## Ticket status

| Step | Ticket status |
|---|---|
| Branch checked out, work begins (`/start-ticket`) | `IN_PROGRESS` |
| PR open, awaiting review (`/ship-ticket`) | `QA` |
| PR merged into `dev` (running on dev) | stays `QA` |
| Its commit reaches `prod` in a sync or hotfix PR | `DONE`, set by `bot-exponential.yml` |

The deploy trigger moved from `dev` to `prod` on 2026-11-20 ([clear #1540](https://www.exponential.im/w/clear/products/clear/tickets/1540), the clear-api half of [#1530](https://www.exponential.im/w/clear/products/clear/tickets/1530)): with `dev` as the trigger, Tickets read `DONE` before their code was live ([postmortem](https://www.exponential.im/w/clear/pages/cmwop8nqh0001jk07nek6zwjn)), and the hook moved a `BLOCKED` Ticket to `DONE`.

## Legacy — don't target these

- `main-(inactive)` — the old `main`, frozen since 2026-03-18.
- `staging` — the branch doesn't exist; it has been removed from `check.yml`'s trigger lists.

Skills (`/start-ticket`, `/ship-ticket`, `/setup-merge-hook`, `/cleanup`) read `featureBase` and the deploy trigger from this file.

## Auto-merge (Greptile)

`Check` (`check.yml`) cancels a superseded run only for `pull_request` events; a push-to-`dev` run is never cancelled, so every merged commit gets a verdict even when merges land back to back.

`.github/workflows/bot-greptile-automerge.yml` squash-merges a PR into `dev` once Greptile has reviewed the PR's latest commit, left no unresolved P0/P1 finding on it, and the required checks (`check`, `db-tests`) have passed. P2s don't block. The merge is pinned to the reviewed commit, so a push after the review never merges on the old review.

It leaves the PR for a human when Greptile hasn't reviewed the latest commit (it skips some pushes), when a P0/P1 thread is still unresolved, or when the PR is a draft, from a fork, opened by a bot, or labelled `no-automerge`. It keeps one comment on the PR, edited in place, saying what it decided and why.

- Merges are made by the `clear-pr-auto-merge` GitHub App, so they trigger the release workflow like a human merge. They change no Ticket status: `bot-exponential` runs only on merges into `prod`.
- After resolving a Greptile thread, nothing re-runs the check automatically: `gh workflow run bot-greptile-automerge.yml -f pr=<number>`.
- To switch it off for the whole repo: `gh workflow disable bot-greptile-automerge.yml`.
