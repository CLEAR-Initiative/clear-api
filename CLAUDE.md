# CLAUDE.md

Project context for AI coding assistants (Claude Code, Cursor, etc).

## Project Overview

Apollo Server (GraphQL) with TypeScript, running on Bun. Connects to a shared PostgreSQL database that is primarily managed by a Django application.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ES2023, NodeNext modules)
- **Server**: Apollo Server 5 + Express 5
- **Database**: PostgreSQL (Railway-hosted), accessed via Prisma ORM
- **Testing**: Vitest
- **Linting**: ESLint + Prettier

## Key Commands

```bash
bun dev              # Start dev server (tsx watch)
bun run build        # TypeScript compile to dist/
bun start            # Run compiled server
bun test             # Run tests (vitest)
bun run lint         # ESLint
bun run typecheck    # TypeScript type checking
```

## Database Architecture (Critical)

This project shares a PostgreSQL database with a Django application. The database has two Postgres schemas:

- **`public`** — Owned by Django. Contains 60 tables managed by Django's migration system. **Do not create Prisma migrations that modify these tables.**
- **`graphql`** — Owned by this project. Contains tables managed by Prisma migrations. **All new models go here.**

### How It Works

The Prisma schema (`prisma/schema.prisma`) contains models for both schemas:

- Django models are tagged with `@@schema("public")` — they exist in the schema so Prisma Client can **read** them, but Prisma migrations must never modify them.
- New models created for the GraphQL server are tagged with `@@schema("graphql")` and use `@@map("table_name")` for the DB table name.

A baseline migration (`prisma/migrations/0_baseline/`) was created and marked as already applied. This tells Prisma "the current state of all `public` tables already exists — don't touch them." Future `prisma migrate dev` runs will only generate diffs for changes to `graphql` schema models.

### Adding a New Model

1. Add the model to `prisma/schema.prisma` with `@@schema("graphql")`:

```prisma
model SavedQuery {
  id        BigInt   @id @default(autoincrement())
  name      String   @db.VarChar(255)
  query     String
  userId    Int      @map("user_id")
  user      auth_user @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("saved_queries")
  @@schema("graphql")
}
```

2. Generate and apply the migration:

```bash
bunx prisma migrate dev --name add_saved_queries
```

3. The Prisma Client is automatically regenerated. Import from `src/generated/prisma`.

### Rules for AI Assistants

- **NEVER** modify models tagged with `@@schema("public")` — they are owned by Django
- **NEVER** run `prisma migrate reset` — it would destroy all Django data
- **NEVER** remove `@@schema("public")` tags from existing models
- **ALWAYS** tag new models with `@@schema("graphql")`
- **ALWAYS** use `@@map("snake_case_table_name")` on new models for consistent DB naming
- New models **can** reference `public` schema models via foreign keys (e.g., `auth_user`)
- If Django adds new tables, run `bunx prisma db pull` to introspect them, then add `@@schema("public")` to the new models
- After schema changes, run `bunx prisma generate` to update the client

### Prisma Client

Generated to `src/generated/prisma` (gitignored). After cloning:

```bash
bunx prisma generate
```

### Querying Django Tables

Django tables are queryable through Prisma Client as read-only. The model names use Django's `appname_modelname` convention:

```typescript
// Reading alerts
const alerts = await prisma.alerts_alert.findMany({
  include: { alerts_shocktype: true }
});

// Reading users
const user = await prisma.auth_user.findUnique({
  where: { id: 1 }
});
```

### Unsupported Fields

`location_location.boundary` and `location_location.point` use PostGIS `geometry` types which Prisma doesn't support natively. Use `$queryRaw` for spatial queries.

## Project Structure

```
src/
  index.ts              # Apollo Server + Express setup
  context.ts            # GraphQL context
  generated/prisma/     # Generated Prisma Client (gitignored)
  schema/               # GraphQL type definitions
  resolvers/            # GraphQL resolvers
  datasources/          # Data sources
  plugins/              # Apollo plugins
  utils/                # Utilities (env validation via Zod)
prisma/
  schema.prisma         # Prisma schema (public + graphql models)
  migrations/           # Prisma migrations (graphql schema only)
prisma.config.ts        # Prisma configuration (loads DATABASE_URL from .env)
```

## Environment Variables

Defined in `.env` (see `.env.example`):

- `NODE_ENV` — `development` | `production`
- `PORT` — Server port (default: 4000)
- `CORS_ORIGIN` — Allowed CORS origin
- `DATABASE_URL` — PostgreSQL connection string
