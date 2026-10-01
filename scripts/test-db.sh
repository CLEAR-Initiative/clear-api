#!/usr/bin/env bash
# Run the test suite against a throwaway Postgres built like production's
# (PostGIS + pgvector), with every migration applied from an empty database.
#
#   bun run test:db                                     # whole suite
#   bun run test:db tests/resolvers/conversation.db.test.ts
#
# DB-backed suites that need dev seed data (`describeIfSeededDb`) are skipped;
# self-seeding ones (`describeIfDb`) run. CI's db-tests job runs exactly this.
# Never touches the DATABASE_URL in .env: the shell value set here wins.
set -euo pipefail

name="${TEST_DB_CONTAINER:-clear-api-test-db}"
port="${TEST_DB_PORT:-55432}"
cd "$(dirname "$0")/.."

# postgis/postgis is amd64-only; on Apple silicon this runs under emulation.
docker build --quiet --platform linux/amd64 -t clear-api-test-db tests/db >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --rm --platform linux/amd64 --name "$name" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clear_test \
  -p "$port:5432" clear-api-test-db >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT

# Probe over TCP: the image's init phase runs a socket-only server first and
# then restarts, so a socket probe can report ready too early.
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -q && break
  sleep 1
done
docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -q

export DATABASE_URL="postgresql://postgres:test@localhost:$port/clear_test"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-test-db-secret-at-least-32-characters}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:4000}"
export SCRATCH_DB=1
unset SKIP_DB_TESTS

bunx prisma migrate deploy
bunx vitest run "$@"
