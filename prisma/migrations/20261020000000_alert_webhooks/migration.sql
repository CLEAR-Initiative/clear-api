-- Generalise webhook_subscriptions for team-configured CLEAR-alert webhooks
-- alongside the existing platform GlitchTip ones.

ALTER TABLE "webhook_subscriptions"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'glitchtip',
  ADD COLUMN "team_id" TEXT,
  ADD COLUMN "alert_type_filter" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "min_severity" INTEGER;

-- Team ownership for clear_alert subscriptions; cascade so a deleted team takes
-- its webhooks with it.
ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "webhook_subscriptions_source_active_idx" ON "webhook_subscriptions"("source", "active");
CREATE INDEX "webhook_subscriptions_team_id_idx" ON "webhook_subscriptions"("team_id");
