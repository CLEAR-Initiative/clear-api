# Contributing to clear-api

Thanks for helping. This guide covers how to run the API locally, how a change gets from a branch
into `dev`, and how to handle configuration and secrets. For what the project is and how it fits
into CLEAR, read the [README](README.md) first.

## Two ways in

### Explore on your own (no account needed)

Everything below runs on your machine with no credentials from the team. You need
[Bun](https://bun.sh), Git and Docker.

**1. Clone and install.**

```bash
git clone https://github.com/CLEAR-Initiative/clear-api.git
cd clear-api
bun install            # also installs the pre-commit hook
bunx prisma generate   # typed client into src/generated/prisma
```

**2. Create your `.env`.**

```bash
cp .env.example .env
openssl rand -base64 32   # paste the output into BETTER_AUTH_SECRET
```

The server and the tests validate `.env` at startup (`src/utils/env.ts`), so it must exist even
before you have a database.

**3. Run the tests.**

```bash
bun run test:ci   # the DB-free suite; no database needed
bun run test:db   # the full suite against a throwaway Postgres in Docker
```

`test:db` builds a PostgreSQL image with PostGIS and pgvector from `tests/db`, applies every
migration to an empty database, runs the suite and stops the container. It never touches the
`DATABASE_URL` in your `.env`. The image is amd64-only, so on Apple silicon it runs under
emulation and is slower.

Use `bun run test`, not `bun test`: the latter starts Bun's built-in runner instead of Vitest.

**4. Start a local database.** The server needs PostgreSQL with the PostGIS, pgvector (`vector`) and
`pg_trgm` extensions available. If you don't have one, reuse the image `test:db` builds:

```bash
docker build --platform linux/amd64 -t clear-api-test-db tests/db
docker run -d --platform linux/amd64 --name clear-api-dev-db \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=clear \
  -p 5432:5432 clear-api-test-db
```

Then set `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/clear"` in `.env`. Pick another
host port if 5432 is taken. Don't name the container `clear-api-test-db`: `test:db` removes any
container with that name. The data lives in the container, so removing it wipes the database.

**5. Create the tables and load sample data.**

```bash
bunx prisma migrate deploy
bun run seed
```

`bun run seed` loads sample locations, disaster types, data sources, signals, events, alerts and
demo accounts, and prints the demo logins. It includes a global admin from `ADMIN_EMAIL` /
`ADMIN_PASSWORD`. It **deletes existing locations, signals, events, alerts, organisations and
related rows first**, so run it only on a disposable local database.

**6. Run the server.**

```bash
bun dev
```

It listens on `http://localhost:4000`. Open `/graphql` for Apollo Sandbox, `/docs` for the API docs
and `/portal` for the Developer Portal. `/health/ready` checks the database connection. Sign in with
the seeded admin to try the authenticated queries.

#### What won't work without team credentials

The server starts without any of these. The features that need them fail or switch off:

| Feature | Needs (see `.env.example`) | Without it |
| --- | --- | --- |
| Outgoing email: sign-up acknowledgements, password resets, invitations, alert and maintainer notifications | `EMAIL_PROVIDER` with `SMTP_*` or `POSTMARK_*` | No email arrives; the failure is logged. Sign-up and password-reset requests still complete, but some actions (for example, requesting a verification email) return an error. The seeded accounts are already verified. |
| Knowledge-base search (`searchKnowledgebase` and related queries) | `EMBEDDING_*`, matching clear-pipeline's provider and model | The query returns an error naming the missing `EMBEDDING_API_KEY`. |
| File uploads: signal media, attachments, knowledge-base PDFs | `S3_*` | Uploads fail. |
| Handing uploaded PDFs to clear-pipeline | `DAGSTER_*` and a running clear-pipeline | With `DAGSTER_URL` empty, the PDF is staged but no run is launched. |
| Pushing sign-ups and approvals into the team's CRM | `EXPONENTIAL_*` | Skipped and logged as `not_configured`. Sign-up and approval still work. |
| WhatsApp hotline webhook | `TWILIO_*` and `HOTLINE_*` | The webhook answers 503. |
| Alert SMS | `SMS_PROVIDER` with `TWILIO_*` or `ELKS46_*` | No SMS is sent. |
| Newsletter subscriber count on `/portal/admin` | `BUTTONDOWN_API_KEY` | The dashboard shows "not configured". |

Shareable public event links also need a Redis at `CELERY_BROKER_URL` (default
`redis://localhost:6379/0`). clear-api makes no LLM calls itself; those happen in clear-pipeline.

### Join the team

1. Register at <https://api.clearinitiative.io/portal/login>.
2. The team will get in touch with next steps. That includes access to the tracker and any dev
   credentials you need, shared with you privately.

Never ask for credentials in an issue or a pull request. They only ever come from the team,
privately.

## Making a change

### Where work is tracked

Work is tracked in [Exponential](https://www.exponential.im/w/clear/products/clear), not GitHub
Issues. Team members get access after registering. Conventions for tickets are in
[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md). If your change has a ticket, link it
in the PR.

Outside contributors: small fixes are welcome as pull requests. For anything bigger, register first
(see [Join the team](#join-the-team)) so it can be discussed before you build it.

### Branches

- Branch off `dev` and open pull requests against `dev`. There is no separate hotfix flow.
- `prod` advances only through periodic `dev -> prod` sync PRs. Don't target it.
- Details: [docs/agents/git-flow.md](docs/agents/git-flow.md).

```bash
git fetch origin
git switch -c <your-branch> origin/dev
```

### Checks to run before pushing

Every PR runs two required checks (`.github/workflows/check.yml`): `check` (lint, typecheck, docs
drift, build, DB-free tests with a coverage gate) and `db-tests` (the suite against a freshly
migrated Postgres). Run the same steps locally:

```bash
bunx prisma generate
bun run lint                 # ESLint over src/
bun run typecheck            # tsc --noEmit
bun run build                # regenerates src/docs/docs-body.html, then compiles to dist/
bun run test:ci:coverage     # DB-free suite with the coverage gate in vitest.config.ts
bun run test:db              # the suite against a freshly migrated Postgres (needs Docker)
```

`check` also fails if `src/docs/docs-body.html` differs from what `bun run build:docs` produces. The
pre-commit hook regenerates and re-stages it when you commit changes under `src/schema/`,
`src/resolvers/` or `src/docs/`. If you skipped the hook, run `bun run build:docs` and commit the
result.

### Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), usually with a scope:
`feat(signals): ...`, `fix(events): ...`, `docs: ...`, `test(ground): ...`, `chore: ...`. Nothing
enforces it, but please keep to it.

### Review and merging

Greptile reviews pull requests automatically and marks each finding P0, P1 or P2.

PRs into `dev` merge automatically (`.github/workflows/bot-greptile-automerge.yml`). The workflow
squash-merges a PR once all of these hold:

- Greptile has reviewed the PR's latest commit.
- No P0 or P1 finding from Greptile on that commit is unresolved. P2s don't block.
- The required checks, `check` and `db-tests`, have passed.

The merge is pinned to the commit Greptile reviewed, so a push after the review never merges on the
old review. The workflow leaves the PR for a human when Greptile hasn't reviewed the latest commit
(it skips some pushes), when a P0/P1 thread is still unresolved, or when the PR is a draft, comes
from a fork, was opened by a bot, or has the `no-automerge` label. It keeps one comment on the PR,
edited in place, saying what it decided and why.

So:

- Open a draft PR, or add the `no-automerge` label, if you want to hold one.
- PRs from forks are always merged by a maintainer.
- Resolving a Greptile thread doesn't re-run the workflow. Push a commit, or ask a maintainer to
  run `gh workflow run bot-greptile-automerge.yml -f pr=<number>`.

### What happens after a merge

- A merge to `dev` tags a minor version and pushes a Docker image to GHCR. A merge to `prod` tags a
  major version and does the same. Deployment itself happens outside this repo.
- The image runs `prisma migrate deploy` on start, so a merged migration is applied when the image
  is deployed.

### Schema changes

`prisma/schema.prisma` is the domain schema. A change to what CLEAR stores starts there, with a
Prisma migration committed alongside it.

```bash
# After editing prisma/schema.prisma, on your local database:
bunx prisma migrate dev --create-only --name <description>
# Review prisma/migrations/<timestamp>_<description>/migration.sql.
# Prisma cannot see the knowledgebase table's HNSW/GIN indexes or its trigger, and may
# propose dropping them on an unrelated change. Delete any such lines, then:
bunx prisma migrate deploy
bunx prisma generate
```

- On a shared database (team dev, staging, prod), only ever run `bunx prisma migrate deploy`.
- Never run `prisma migrate reset` against a database you care about.
- `db-tests` applies every migration to an empty database on each PR, so a broken migration fails
  CI.

Terms have precise meanings. If your change alters one, update [CONTEXT.md](CONTEXT.md). Decisions
are recorded in [docs/adr/](docs/adr/).

### API docs

The API reference at `/docs` is generated from the `"""..."""` description strings in
`src/schema/typeDefs/`. Update them when you change a type. The prose sections live in
`src/docs/template.ts`.

## Environment variables

To add a variable:

1. Add it to `.env.example` with a comment: what it does, whether it's optional, and what happens
   when it's unset.
2. Add it to the schema in `src/utils/env.ts` and read it through `env`. The server won't start if
   validation fails. Deployed env files always emit every variable, even when the value is empty,
   so an optional variable must treat `""` as unset (see `optionalUrl()` in that file).
3. Prefer optional variables with a sensible default. A new required variable also needs a dummy
   value in the test step of `.github/workflows/check.yml` and in `scripts/test-db.sh`, or CI fails.
4. If it's one people need to know about, add it to the Configuration table in the README.

Values for the deployed environments are set by the team in a private infrastructure repo. If your
PR adds a variable, say so in the PR description so it gets added for dev and prod. Never put a real
value in the PR.

## Secrets

- Never commit `.env` or any secret. `.env` is gitignored; keep it that way.
- Never paste secret values into issues, PRs, chat or AI tools.
- If a secret leaks, tell the team immediately so it can be rotated.
- Credentials only ever come from the team, privately.

## Reporting a security issue

Don't open a public issue. Use GitHub's private vulnerability reporting:
<https://github.com/CLEAR-Initiative/clear-api/security/advisories/new> (Security tab, then "Report
a vulnerability").

## Licence

clear-api is licensed under the GNU Affero General Public License, version 3 or later
(`AGPL-3.0-or-later`). Copyright (C) 2026 Norwegian Refugee Council. By contributing, you agree
that your contributions are made under that licence. See [LICENSE](LICENSE) for the full text.
