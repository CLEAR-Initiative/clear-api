# CLEAR Apollo

GraphQL API server for CLEAR, built with Apollo Server 5, Express 5, and TypeScript on Bun.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Server**: [Apollo Server 5](https://www.apollographql.com/docs/apollo-server/) + [Express 5](https://expressjs.com/)
- **Auth**: [Better Auth 1.5](https://better-auth.com/) (cookie-based sessions)
- **Database**: PostgreSQL via [Prisma ORM](https://www.prisma.io/)
- **Language**: TypeScript (strict mode)

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- PostgreSQL database

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
```

### Database

Prisma manages the schema and migrations.

```bash
# After editing prisma/schema.prisma:
bunx prisma migrate dev --name <description>

# Regenerate the typed client:
bunx prisma generate
```

## Authentication

Authentication is handled by [Better Auth](https://better-auth.com/) via REST endpoints. Session cookies are managed automatically.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/sign-up/email` | POST | Create account |
| `/api/auth/sign-in/email` | POST | Sign in |
| `/api/auth/sign-out` | POST | Sign out |
| `/api/auth/session` | GET | Get current session |

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

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `development` |
| `PORT` | Server port | `4000` |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string | *(required)* |
| `BETTER_AUTH_SECRET` | Auth encryption secret (32+ chars) | *(required)* |
| `BETTER_AUTH_URL` | Server base URL | *(required)* |

## Docker

```bash
# Build
docker build -t clear-apollo .

# Run (migrations run automatically on startup)
docker run -p 4000:4000 --env-file .env clear-apollo
```

## Project Structure

```
src/
  index.ts           # Server entrypoint (Express + Apollo + Better Auth)
  context.ts         # GraphQL context (Prisma + auth session)
  lib/
    prisma.ts        # Prisma client singleton
    auth.ts          # Better Auth configuration
  schema/typeDefs/   # GraphQL type definitions
  resolvers/         # GraphQL resolvers
  utils/
    env.ts           # Environment validation (Zod)
    auth-guard.ts    # Auth helpers (requireAuth, requireRole)
prisma/
  schema.prisma      # Database schema
  migrations/        # Migration history
```
