-- Unresolved place names and place aliases (ADR-0019, Exponential #1307).
-- CLEAR's own tables beside the GeoNames copy. No foreign key points at
-- "geonames" or "geonames_name": the importer runs
-- TRUNCATE ... RESTART IDENTITY CASCADE, which would empty these tables.

-- CreateTable
CREATE TABLE "place_aliases" (
    "id" TEXT NOT NULL,
    "name_norm" TEXT NOT NULL,
    "name_display" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "scope_location_id" TEXT,
    "location_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "place_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unresolved_place_names" (
    "id" TEXT NOT NULL,
    "name_norm" TEXT NOT NULL,
    "name_as_written" TEXT NOT NULL,
    "name_ar" TEXT,
    "country_code" TEXT NOT NULL,
    "state_location_id" TEXT,
    "country_location_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "place_alias_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unresolved_place_names_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unresolved_place_name_signals" (
    "unresolved_place_name_id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "area_location_id" TEXT,
    "name_as_written" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'no_match',
    "seen_at" TIMESTAMP(3) NOT NULL,
    "relocated_at" TIMESTAMP(3),

    CONSTRAINT "unresolved_place_name_signals_pkey" PRIMARY KEY ("unresolved_place_name_id","signal_id")
);

-- The queue key and the alias key. Both end in a nullable column (a
-- country-level row has no state; a country-wide alias has no scope). A plain
-- unique index treats each NULL as distinct, so those rows would duplicate.
-- NULLS NOT DISTINCT (PostgreSQL 15+) is not expressible in Prisma.
CREATE UNIQUE INDEX "unresolved_place_names_country_name_state_key"
    ON "unresolved_place_names"("country_code", "name_norm", "state_location_id") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "place_aliases_country_name_scope_key"
    ON "place_aliases"("country_code", "name_norm", "scope_location_id") NULLS NOT DISTINCT;

-- Value invariants (the resolvers write the same sets).
ALTER TABLE "unresolved_place_names"
    ADD CONSTRAINT "unresolved_place_names_status_check"
        CHECK ("status" IN ('open', 'resolved', 'not_a_place', 'ambiguous'));
ALTER TABLE "unresolved_place_name_signals"
    ADD CONSTRAINT "unresolved_place_name_signals_reason_check"
        CHECK ("reason" IN ('no_match', 'outside_area'));
ALTER TABLE "place_aliases"
    ADD CONSTRAINT "place_aliases_source_check"
        CHECK ("source" IN ('review', 'seed', 'manual'));

-- CreateIndex
CREATE INDEX "place_aliases_location_id_idx" ON "place_aliases"("location_id");

-- CreateIndex
CREATE INDEX "place_aliases_scope_location_id_idx" ON "place_aliases"("scope_location_id");

-- CreateIndex
CREATE INDEX "unresolved_place_names_status_signal_count_idx" ON "unresolved_place_names"("status", "signal_count" DESC);

-- CreateIndex
CREATE INDEX "unresolved_place_names_state_location_id_idx" ON "unresolved_place_names"("state_location_id");

-- CreateIndex
CREATE INDEX "unresolved_place_names_country_location_id_idx" ON "unresolved_place_names"("country_location_id");

-- CreateIndex
CREATE INDEX "unresolved_place_names_place_alias_id_idx" ON "unresolved_place_names"("place_alias_id");

-- CreateIndex
CREATE INDEX "unresolved_place_name_signals_signal_id_idx" ON "unresolved_place_name_signals"("signal_id");

-- CreateIndex
CREATE INDEX "unresolved_place_name_signals_area_location_id_idx" ON "unresolved_place_name_signals"("area_location_id");

-- AddForeignKey
ALTER TABLE "place_aliases" ADD CONSTRAINT "place_aliases_scope_location_id_fkey" FOREIGN KEY ("scope_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place_aliases" ADD CONSTRAINT "place_aliases_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unresolved_place_names" ADD CONSTRAINT "unresolved_place_names_state_location_id_fkey" FOREIGN KEY ("state_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unresolved_place_names" ADD CONSTRAINT "unresolved_place_names_country_location_id_fkey" FOREIGN KEY ("country_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unresolved_place_names" ADD CONSTRAINT "unresolved_place_names_place_alias_id_fkey" FOREIGN KEY ("place_alias_id") REFERENCES "place_aliases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unresolved_place_name_signals" ADD CONSTRAINT "unresolved_place_name_signals_unresolved_place_name_id_fkey" FOREIGN KEY ("unresolved_place_name_id") REFERENCES "unresolved_place_names"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unresolved_place_name_signals" ADD CONSTRAINT "unresolved_place_name_signals_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unresolved_place_name_signals" ADD CONSTRAINT "unresolved_place_name_signals_area_location_id_fkey" FOREIGN KEY ("area_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
