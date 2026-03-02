# CLAUDE.md

Project context for AI coding assistants (Claude Code, Cursor, etc).

## Project Overview

Apollo Server (GraphQL) with TypeScript, running on Bun. Uses Prisma ORM with PostgreSQL. Authentication via Better Auth with cookie-based sessions.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ES2023, NodeNext modules)
- **Server**: Apollo Server 5 + Express 5
- **Auth**: Better Auth 1.5 (session-based, cookie auth)
- **Database**: PostgreSQL, managed via Prisma ORM (owns schema + migrations)
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

## Database

Prisma owns the database schema and all migrations.

### Schema Changes

1. Edit `prisma/schema.prisma` directly
2. Run migration and regenerate the client:

```bash
bunx prisma migrate dev --name <description>   # Create and apply migration
bunx prisma generate                            # Regenerate typed client
```

### Rules for AI Assistants

- **DO** edit `prisma/schema.prisma` directly for schema changes
- **DO** run `prisma migrate dev` after schema changes
- **DO** run `prisma generate` to regenerate the typed client
- **NEVER** run `prisma migrate reset` without explicit user confirmation (destructive)

### Prisma Client

Generated to `src/generated/prisma` (gitignored). After cloning:

```bash
bunx prisma migrate dev   # Create tables + generate client
```

### Querying Tables

```typescript
// Auth users (Better Auth — string IDs)
const user = await prisma.user.findUnique({ where: { id: "abc123" } });

// App models (integer IDs)
const alerts = await prisma.alert.findMany({
  include: { source: true, locations: true }
});
const flag = await prisma.featureFlag.findUnique({ where: { key: "dark_mode" } });
```

### Data Models

- **Auth (Better Auth)**: user, session, account, verification (string IDs)
- **Core**: Alert, UserAlert (integer IDs)
- **Data Mining**: DataSource, Detection
- **Geography**: Location (hierarchical), AlertLocation, DetectionLocation
- **Config**: FeatureFlag

## Authentication

Better Auth handles auth via REST endpoints at `/api/auth/*`. Session cookies are set automatically.

- **Config**: `src/lib/auth.ts`
- **REST endpoints**: `/api/auth/sign-up/email`, `/api/auth/sign-in/email`, `/api/auth/sign-out`, `/api/auth/session`
- **GraphQL**: `me` query returns the authenticated user (or null)
- **Guards**: Use `requireAuth(context)` and `requireRole(context, ["admin"])` from `src/utils/auth-guard.ts`
- **Custom user fields**: `role` (default: "viewer") and `isActive` (default: true) — set via `additionalFields` in auth config, not editable by users at signup

### Auth architecture

- Auth operations (signup/signin/signout) use Better Auth REST endpoints, **not** GraphQL mutations
- Better Auth handles cookie setting automatically via its REST handler
- The GraphQL context resolves the session from request cookies on every request
- The `me` query is the GraphQL entry point for the authenticated user

## Project Structure

```
src/
  index.ts              # Apollo Server + Express setup, Better Auth handler
  context.ts            # GraphQL context (Prisma client + auth session/user)
  lib/
    prisma.ts           # Prisma client singleton
    auth.ts             # Better Auth configuration
  generated/prisma/     # Generated Prisma Client (gitignored)
  schema/
    typeDefs/
      scalars.ts        # DateTime, JSON scalar definitions
      query.ts          # Root Query type
      mutation.ts       # Root Mutation type
      types/            # Domain type definitions (user, alert, detection, etc.)
  resolvers/            # GraphQL resolvers (one per domain entity)
  plugins/              # Apollo plugins
  utils/
    env.ts              # Environment validation (Zod)
    auth-guard.ts       # requireAuth / requireRole helpers
prisma/
  schema.prisma         # Prisma schema (source of truth)
  migrations/           # Prisma migrations
```

## Environment Variables

Defined in `.env` (see `.env.example`):

- `NODE_ENV` — `development` | `staging` | `production`
- `PORT` — Server port (default: 4000)
- `CORS_ORIGIN` — Allowed CORS origin (must be specific URL, not `*`, for cookie auth)
- `DATABASE_URL` — PostgreSQL connection string
- `BETTER_AUTH_SECRET` — Auth encryption secret (32+ chars, generate with `openssl rand -base64 32`)
- `BETTER_AUTH_URL` — Server base URL (e.g., `http://localhost:4000`)
