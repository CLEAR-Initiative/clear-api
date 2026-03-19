-- RenameForeignKey
ALTER TABLE "user" RENAME CONSTRAINT "user_active_team_id_fkey" TO "user_default_team_id_fkey";
