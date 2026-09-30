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
