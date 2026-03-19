-- AlterTable: organisations - add new columns with defaults for existing rows
ALTER TABLE "organisations" ADD COLUMN "slug" TEXT;
ALTER TABLE "organisations" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "organisations" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "organisations" ADD COLUMN "updated_at" TIMESTAMP(3);

-- Backfill existing rows
UPDATE "organisations" SET "slug" = LOWER(REPLACE("name", ' ', '-')) WHERE "slug" IS NULL;
UPDATE "organisations" SET "updated_at" = CURRENT_TIMESTAMP WHERE "updated_at" IS NULL;

-- Now make slug required and unique
ALTER TABLE "organisations" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "organisations" ALTER COLUMN "updated_at" SET NOT NULL;
CREATE UNIQUE INDEX "organisations_slug_key" ON "organisations"("slug");

-- AlterTable: user_to_organisation - update default role, add created_at, add cascading deletes
ALTER TABLE "user_to_organisation" ALTER COLUMN "role" SET DEFAULT 'member';
ALTER TABLE "user_to_organisation" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Update cascading deletes on user_to_organisation
ALTER TABLE "user_to_organisation" DROP CONSTRAINT IF EXISTS "user_to_organisation_user_id_fkey";
ALTER TABLE "user_to_organisation" ADD CONSTRAINT "user_to_organisation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_to_organisation" DROP CONSTRAINT IF EXISTS "user_to_organisation_organisation_id_fkey";
ALTER TABLE "user_to_organisation" ADD CONSTRAINT "user_to_organisation_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: user - add active_team_id
ALTER TABLE "user" ADD COLUMN "active_team_id" TEXT;

-- CreateTable: teams
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "teams_organisation_id_idx" ON "teams"("organisation_id");
CREATE UNIQUE INDEX "teams_organisation_id_slug_key" ON "teams"("organisation_id", "slug");

-- CreateTable: team_members
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateTable: team_locations
CREATE TABLE "team_locations" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "team_locations_location_id_idx" ON "team_locations"("location_id");
CREATE UNIQUE INDEX "team_locations_team_id_location_id_key" ON "team_locations"("team_id", "location_id");

-- AddForeignKey: user.active_team_id -> teams
ALTER TABLE "user" ADD CONSTRAINT "user_active_team_id_fkey" FOREIGN KEY ("active_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: teams -> organisations
ALTER TABLE "teams" ADD CONSTRAINT "teams_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: team_members -> teams, user
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: team_locations -> teams, locations
ALTER TABLE "team_locations" ADD CONSTRAINT "team_locations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_locations" ADD CONSTRAINT "team_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
