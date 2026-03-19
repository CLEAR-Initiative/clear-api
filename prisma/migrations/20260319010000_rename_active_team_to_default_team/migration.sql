-- Rename column active_team_id → default_team_id on user table
ALTER TABLE "user" RENAME COLUMN "active_team_id" TO "default_team_id";
