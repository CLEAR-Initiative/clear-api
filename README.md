# CLEAR Apollo

GraphQL API server for CLEAR, built with Apollo Server 5, Express 5, and TypeScript on Bun.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Server**: [Apollo Server 5](https://www.apollographql.com/docs/apollo-server/) + [Express 5](https://expressjs.com/)
- **Auth**: [Better Auth 1.5](https://better-auth.com/) (cookie-based sessions)
- **Database**: PostgreSQL + PostGIS via [Prisma ORM](https://www.prisma.io/)
- **Storage**: S3 (presigned URLs for media + crisis attachments)
- **Language**: TypeScript (strict mode)

## Domain Model

The API exposes a five-tier humanitarian-monitoring graph:

- **Locations** — administrative hierarchy (country → state → district → point). Level-4 rows can be either auto-generated point locations or `point_type = 'landmark-geocoded'` rows resolved from text by the pipeline geoparser.
- **Signals** — raw alerts ingested from external sources (Dataminr, ACLED, GDACS) or filed manually by field officers / partners. Each signal carries the source's raw payload plus a `geoparsedData` JSONB block when the geoparser found a landmark.
- **Events** — clusters of signals classified by disaster type and bound to an admin-2 district.
- **Alerts** — published advisories raised from severe events. Auto-escalated when a manual signal comes from a trusted source.
- **Crises** — user-curated aggregations of related events, enriched by an LLM task that produces title, summary (`{description, tldr}` JSON), forward scenarios, and an NRC SAF needs analysis (`{generalSummary[], sector{...6 sectors...}}`). Supports user-uploaded attachments (S3 keys → presigned URLs at read time).

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- PostgreSQL 15+ with the **PostGIS extension** enabled
- (Optional) S3 credentials for media + attachment uploads
- (Optional) LocationIQ API key for the geocoder cache layer

### Setup

```bash
# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL and generate a secret:
#   openssl rand -base64 32

# Create database tables and generate Prisma client
bunx prisma migrate dev

# Start development server
bun dev
```

The server starts at `http://localhost:4000`:

- **GraphQL**: `http://localhost:4000/graphql`
- **Auth API**: `http://localhost:4000/api/auth`

## Development

```bash
bun dev              # Start dev server with hot reload
bun run typecheck    # Type check
bun run lint         # Lint
bun test             # Run tests
bun run build        # Compile to dist/ (also builds GraphQL docs)
```

### Database

Prisma manages the schema and migrations. The crisis enrichment fields
(`needs`, `scenarios`, `attachments`) and signal geo fields (`geoparsedData`,
`location.pointType`, `nominatim_cache`) are non-trivial; review migrations
in `prisma/migrations/` for history.

```bash
# After editing prisma/schema.prisma:
bunx prisma migrate dev --name <description>

# Regenerate the typed client:
bunx prisma generate
```

## Authentication

Authentication is handled by [Better Auth](https://better-auth.com/) via REST endpoints. Session cookies are managed automatically.

| Endpoint                  | Method | Description         |
| ------------------------- | ------ | ------------------- |
| `/api/auth/sign-up/email` | POST   | Create account      |
| `/api/auth/sign-in/email` | POST   | Sign in             |
| `/api/auth/sign-out`      | POST   | Sign out            |
| `/api/auth/session`       | GET    | Get current session |

The GraphQL `me` query returns the authenticated user based on the session cookie:

```graphql
query {
  me {
    id
    email
    name
    role
    isActive
  }
}
```

Roles: `admin` / `analyst` / `viewer`. Many mutations call `requireRole(...)`;
crisis-edit mutations (title, description, delete, attachments) only require
`requireAuth`.

## Environment Variables

| Variable             | Description                                                          | Default                 |
| -------------------- | -------------------------------------------------------------------- | ----------------------- |
| `NODE_ENV`           | Environment                                                          | `development`           |
| `PORT`               | Server port                                                          | `4000`                  |
| `CORS_ORIGINS`       | Comma-separated allowed CORS origins                                 | `http://localhost:3000` |
| `DATABASE_URL`       | PostgreSQL connection string (PostGIS required)                      | _(required)_            |
| `BETTER_AUTH_SECRET` | Auth encryption secret (32+ chars)                                   | _(required)_            |
| `BETTER_AUTH_URL`    | Server base URL                                                      | _(required)_            |
| `LOCATIONIQ_API_KEY` | LocationIQ key used by the pipeline geocoder; cached in `nominatim_cache` | _(optional)_        |
| `S3_*`               | AWS credentials + bucket + region for media / attachment storage     | _(optional)_            |
| `SENTRY_DSN`         | Error reporting                                                      | _(optional)_            |

## Docker

```bash
# Build
docker build -t clear-apollo .

# Run (migrations run automatically on startup)
docker run -p 4000:4000 --env-file .env clear-apollo
```

## Scripts

One-off backfill / import scripts live under `scripts/`. All default to
dry-run; pass `--execute` to write.

| Script                                 | Purpose                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `scripts/msna/process_msna.py`         | Parse the IOM/DTM MSNA XLSX into a processed JSON output                    |
| `scripts/msna/import-msna.ts`          | Upsert MSNA severity per A2 into `location_metadata` (bitemporal)           |
| `scripts/msna/import_msna.py`          | Python equivalent of the above (parity-tested)                              |
| `scripts/worldpop/import-age-sex.ts`   | Zonal-sum WorldPop age-sex GeoTIFFs per A2 polygon → `location_metadata`   |
| `scripts/ingest-sudan-3w.ts`           | OCHA 3W partner-presence ingestion                                          |
| `scripts/backfill-locations.ts`        | Re-resolve historical signal coordinates against the location hierarchy     |
| `scripts/seed-disaster-types.ts`       | Seed the disaster-type taxonomy                                             |

## Project Structure

```
src/
  index.ts                # Server entrypoint (Express + Apollo + Better Auth)
  context.ts              # GraphQL context (Prisma + auth session)
  lib/
    prisma.ts             # Prisma client singleton
    auth.ts               # Better Auth configuration
  schema/typeDefs/        # GraphQL type definitions
  resolvers/              # GraphQL resolvers
    crisis.resolver.ts    # Crisis lifecycle, attachments, needs analysis, title lock
    signal.resolver.ts    # Signal CRUD + manual signal flow + geoparsedData write
    location.resolver.ts  # Locations + findOrCreateLandmarkL4 (geoparser L4 promotion)
    event.resolver.ts     # Event grouping + escalation
    nominatimCache.resolver.ts  # Geocoder cache for the pipeline
  utils/
    geo-resolve.ts        # PostGIS A2 lookup + L4 reuse/create logic
    env.ts                # Environment validation (Zod)
    auth-guard.ts         # Auth helpers (requireAuth, requireRole)
  services/
    s3.ts                 # Presigned URL generation for media + attachments
prisma/
  schema.prisma           # Database schema
  migrations/             # Migration history
scripts/                  # One-off backfill / import scripts (see above)
```

## License

Copyright (C) 2026 Norwegian Refugee Council.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [`LICENSE`](./LICENSE) for the full text.
