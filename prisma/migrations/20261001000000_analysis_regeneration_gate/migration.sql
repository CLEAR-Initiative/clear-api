-- ADR-0008: analysis regeneration gate (freshness + 24h floor + force).
--
-- Two additive columns. Idempotent (IF NOT EXISTS) so it is safe regardless of
-- whether an environment already has them.

-- `analyses.last_synced_at` — last time any trigger CHECKED the frame (manual
-- sync or automation), bumped even on a gate skip, distinct from generated_at
-- ("last actual regeneration"). Nullable: existing rows have never been checked
-- under the new gate.
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMP(3);

-- `analysis_requests.force` — admin force request carried through the on-demand
-- queue; the drain bypasses the 24h floor + freshness check when set.
ALTER TABLE "analysis_requests" ADD COLUMN IF NOT EXISTS "force" BOOLEAN NOT NULL DEFAULT false;
