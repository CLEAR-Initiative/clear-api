-- Single sidecar table for per-locale translations across every
-- translatable entity (event, crisis, location, and any future model).
-- See the doc-block on `model translations` in prisma/schema.prisma for
-- the `data` shape; in short, `data` mirrors the canonical entity's JSON
-- exactly per locale.
--
-- No SQL foreign key: entity_id is polymorphic. Orphan rows are
-- correctness-safe (nothing reads them); a future periodic GC can sweep
-- them if they ever pile up.

CREATE TABLE "translations" (
    "id"            TEXT         NOT NULL,
    "entity_type"   TEXT         NOT NULL,
    "entity_id"     TEXT         NOT NULL,
    "locale"        TEXT         NOT NULL,
    "data"          JSONB        NOT NULL,
    "source_hashes" JSONB,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- Primary read path: "give me locale X for entity (type, id)". The unique
-- constraint creates a btree that also satisfies the DataLoader's batched
-- read shape
--   WHERE entity_type = $1 AND locale = $2 AND entity_id = ANY($3)
-- so no extra index is needed on the hot path.
CREATE UNIQUE INDEX "translations_entity_type_entity_id_locale_key"
    ON "translations"("entity_type", "entity_id", "locale");

-- Admin / coverage queries ("what's translated to Arabic?").
CREATE INDEX "translations_entity_type_locale_idx"
    ON "translations"("entity_type", "locale");
