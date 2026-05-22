-- Adds infrastructure for the Nominatim-backed geoparser feature.
--   1. `locations.point_type` — provenance tag describing how a row's point
--      coordinate was derived (gps / centroid / landmark-geocoded /
--      source-gps / source-centroid). Null on legacy rows; the geoparser
--      sets it on newly-created L4 rows going forward.
--   2. `nominatim_cache` — persistent cache of Nominatim-protocol geocoder
--      responses. The clear-pipeline geoparser checks this table before
--      issuing any outbound API call; only cache misses hit the geocoder.
--      Negative results (no_result, error) are cached too so we don't
--      re-ask the same dead question. Lookups go by `query_hash` (SHA-256
--      of `<endpoint>:<normalised_query>`).
--
-- Named for the protocol (Nominatim), not the current vendor (LocationIQ).
-- Any Nominatim-compatible backend uses this same cache transparently.

-- AlterTable
ALTER TABLE "locations"
ADD COLUMN "point_type" TEXT;

-- CreateTable
CREATE TABLE "nominatim_cache" (
    "id"             TEXT          NOT NULL,
    "query_hash"     TEXT          NOT NULL,
    "query"          TEXT          NOT NULL,
    "endpoint"       TEXT          NOT NULL,
    "response_json"  JSONB         NOT NULL,
    "status"         TEXT          NOT NULL,
    "fetched_at"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"     TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "nominatim_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nominatim_cache_query_hash_key" ON "nominatim_cache"("query_hash");

-- CreateIndex
CREATE INDEX "nominatim_cache_query_hash_idx" ON "nominatim_cache"("query_hash");

-- CreateIndex
CREATE INDEX "nominatim_cache_expires_at_idx" ON "nominatim_cache"("expires_at");
