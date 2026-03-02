# CLAUDE.md

Project context for AI coding assistants (Claude Code, Cursor, etc).

## Project Overview

Apollo Server (GraphQL) with TypeScript, running on Bun. Uses Prisma ORM with PostgreSQL.

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

## Database Architecture

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
bunx prisma generate   # Generate the typed client
```

### Querying Tables

Models use camelCase TypeScript naming:

```typescript
// Reading alerts
const alerts = await prisma.alert.findMany({
  include: { source: true, locations: true }
});

// Reading users
const user = await prisma.user.findUnique({
  where: { id: 1 }
});

// Feature flags
const flag = await prisma.featureFlag.findUnique({
  where: { key: "dark_mode" }
});
```

### Data Models

- **Auth (Better Auth)**: user, session, account, verification
- **Core**: Alert, UserAlert
- **Data Mining**: DataSource, Detection
- **Geography**: Location (hierarchical), AlertLocation, DetectionLocation
- **Config**: FeatureFlag

## Project Structure

```
src/
  index.ts              # Apollo Server + Express setup
  context.ts            # GraphQL context (includes Prisma client)
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
  utils/                # Utilities (env validation via Zod)
prisma/
  schema.prisma         # Prisma schema (manually authored)
prisma.config.ts        # Prisma configuration (loads DATABASE_URL from .env)
```

## Environment Variables

Defined in `.env` (see `.env.example`):

- `NODE_ENV` — `development` | `staging` | `production`
- `PORT` — Server port (default: 4000)
- `CORS_ORIGIN` — Allowed CORS origin
- `DATABASE_URL` — PostgreSQL connection string
- `BETTER_AUTH_SECRET` — Auth encryption secret (32+ chars)
- `BETTER_AUTH_URL` — Server base URL (e.g., `http://localhost:4000`)

## Authentication

Better Auth handles auth via REST endpoints at `/api/auth/*`. Session cookies are set automatically.

- **Config**: `src/lib/auth.ts`
- **Auth endpoints**: `/api/auth/sign-up/email`, `/api/auth/sign-in/email`, `/api/auth/sign-out`, `/api/auth/session`
- **GraphQL**: `me` query returns the authenticated user (or null)
- **Guards**: Use `requireAuth(context)` and `requireRole(context, ["admin"])` from `src/utils/auth-guard.ts` in resolvers
- **User fields**: `role` (default: "viewer") and `isActive` (default: true) are additional fields on the Better Auth user model
