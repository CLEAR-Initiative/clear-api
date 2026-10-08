# Git flow

This repo's default/integration branch is **`dev`** (`origin/HEAD → dev`).

- **featureBase** — `dev`. Cut every ticket branch off `origin/dev` and open its PR against `dev`.
- **Promotion chain** — `feature → dev → prod`. `prod` is advanced by periodic "sync prod with dev" PRs (`dev → prod`), not by feature PRs.
- **deploy trigger** — `dev`. A merge into `dev` runs `.github/workflows/build-and-deploy.yml`, which builds the image and deploys it to the dev VM, and `.github/workflows/exponential-promote.yml`, which moves the PR's Tickets `QA → DONE`.
- **Production** — the `prod` branch, deployed by Railway (outside GitHub Actions). Merging to `prod` does not change Ticket status.
- **Hotfixes** — no separate hotfix flow; cut from `dev` like any other ticket branch.

## Legacy — don't target these

- `main-(inactive)` — the old `main`, frozen since 2026-03-18.
- `.github/workflows/deploy.yml` (Terraform apply on push to `main`) never fires now that `main` is gone.
- `staging` — listed in `build-and-deploy.yml` and `ci.yml`, but the branch doesn't exist.

Skills (`/start-ticket`, `/ship-ticket`, `/setup-merge-hook`, `/cleanup`) read `featureBase` and the deploy trigger from this file.

## Auto-merge (Greptile)

`.github/workflows/greptile-automerge.yml` squash-merges a PR into `dev` once Greptile has reviewed the PR's latest commit, left no unresolved P0/P1 finding on it, and the required checks (`check`, `db-tests`) have passed. P2s don't block. The merge is pinned to the reviewed commit, so a push after the review never merges on the old review.

It leaves the PR for a human when Greptile hasn't reviewed the latest commit (it skips some pushes), when a P0/P1 thread is still unresolved, or when the PR is a draft, from a fork, opened by a bot, or labelled `no-automerge`. It keeps one comment on the PR, edited in place, saying what it decided and why.

- Merges are made by the `clear-pr-auto-merge` GitHub App, so they trigger the deploy and `exponential-promote` like a human merge.
- After resolving a Greptile thread, nothing re-runs the check automatically: `gh workflow run greptile-automerge.yml -f pr=<number>`.
- To switch it off for the whole repo: `gh workflow disable greptile-automerge.yml`.
