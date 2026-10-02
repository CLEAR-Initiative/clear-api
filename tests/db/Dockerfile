# Test database for `bun run test:db` and CI's db-tests job: PostgreSQL 16 with
# the real extension set (postgis, vector/pgvector, pg_trgm) so the full
# migration history is exercised from empty against the extensions production
# uses.
#
# Based on the official `postgres:16-bookworm` with PostGIS + pgvector added from
# PGDG, rather than `postgis/postgis:16-3.5`: that tag is Debian *bullseye*, and
# PGDG has dropped the bullseye repo — `apt-get update` 404s on
# `bullseye-pgdg Release`, failing the build (exit 100). bookworm's PGDG repo is
# current. Migrations `CREATE EXTENSION IF NOT EXISTS` each one, so the extensions
# only need to be installed (available), not pre-enabled by the image.
FROM postgres:16-bookworm
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      postgresql-16-postgis-3 \
      postgresql-16-pgvector && \
    rm -rf /var/lib/apt/lists/*
