-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateTable
CREATE TABLE "geonames" (
    "geonames_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "ascii_name" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "feature_class" TEXT,
    "feature_code" TEXT,
    "country_code" TEXT NOT NULL,
    "admin1_code" TEXT,
    "population" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "geonames_pkey" PRIMARY KEY ("geonames_id")
);

-- CreateTable
CREATE TABLE "geonames_name" (
    "id" BIGSERIAL NOT NULL,
    "geonames_id" INTEGER NOT NULL,
    "name_norm" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,

    CONSTRAINT "geonames_name_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "geonames_country_code_idx" ON "geonames"("country_code");

-- CreateIndex
CREATE INDEX "geonames_name_geonames_id_idx" ON "geonames_name"("geonames_id");

-- CreateIndex
CREATE INDEX "geonames_name_country_code_idx" ON "geonames_name"("country_code");

-- CreateIndex (trigram GIN for fuzzy name matching)
CREATE INDEX "geonames_name_name_norm_idx" ON "geonames_name" USING GIN ("name_norm" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "geonames_name" ADD CONSTRAINT "geonames_name_geonames_id_fkey" FOREIGN KEY ("geonames_id") REFERENCES "geonames"("geonames_id") ON DELETE CASCADE ON UPDATE CASCADE;
