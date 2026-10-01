# Test database for `bun run test:db` and CI's db-tests job: the same image
# production runs (clear-infra envs/*/main.tf `postgres_dockerfile`), so the
# full migration history is exercised against the real extension set.
FROM postgis/postgis:16-3.5
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-16-pgvector && \
    rm -rf /var/lib/apt/lists/*
