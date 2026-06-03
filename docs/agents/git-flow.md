# Git flow

This repo's default/integration branch is **`dev`** (`origin/HEAD → dev`), not `main`.

- **featureBase** — `dev`. Cut every ticket branch off `origin/dev` and open its PR against `dev`. (`main` is downstream and lags `dev`; do not branch off it.)
- **Promotion chain** — `feature → dev → staging → main`.
- **deploy trigger** — `main`. `.github/workflows/deploy.yml` runs Terraform apply on push to `main`, so a merge into `main` is what ships to production. The Exponential `QA → DONE` merge hook (if set up) should watch `main`.

Skills (`/start-ticket`, `/ship-ticket`, `/setup-merge-hook`) read `featureBase` and the deploy trigger from this file.
