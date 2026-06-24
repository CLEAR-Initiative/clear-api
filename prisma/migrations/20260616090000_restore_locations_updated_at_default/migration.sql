-- Restore DEFAULT CURRENT_TIMESTAMP on locations.updated_at.
--
-- The immediately preceding migration (20260616085037_add_translations_table)
-- dropped this default as part of a Prisma drift cleanup. That broke nine
-- raw SQL INSERTs into "locations" which omit the column and rely on the
-- DB-side default:
--   - src/utils/geo-resolve.ts            (createPointLocation,
--                                          createLandmarkLocation)
--   - src/resolvers/location.resolver.ts  (createLocation,
--                                          ensureCountryLocation)
--   - prisma/seed.ts, prisma/seed-dummy.ts
--   - tests/utils/geo-resolve.test.ts
--
-- Re-adding the default lets those INSERTs continue to work without
-- modification. `model locations` in prisma/schema.prisma now also
-- declares `@default(now())` alongside `@updatedAt` so Prisma stops
-- treating this default as drift in future `migrate dev` runs.

ALTER TABLE "locations" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
