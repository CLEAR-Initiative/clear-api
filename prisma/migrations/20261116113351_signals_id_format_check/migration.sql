-- Signal id formats are disjoint: a Prisma cuid (manual, hotline, X ingest,
-- createSignal without id), "case" + 32 hex (case acceptance), or a lowercase
-- UUIDv5 minted by the gx pipeline. NOT VALID checks new rows only; existing
-- rows are checked by a separate VALIDATE CONSTRAINT once the shape query
-- finds no other format in the environment.
ALTER TABLE "signals"
    ADD CONSTRAINT "signals_id_format"
        CHECK (
            "id" ~ '^c[a-z0-9]{24}$'
            OR "id" ~ '^case[0-9a-f]{32}$'
            OR "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ) NOT VALID;
