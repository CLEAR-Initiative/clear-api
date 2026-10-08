-- Retire the whole-prior Task kinds (ADR-0010 amendment, 2026-10-08).
--
-- The bare `event.impact_prior` and `event.impact_prior.clear` proposed a
-- whole ImpactPrior. The ImpactPrior is now computed from history, and
-- clear-api refuses to claim these kinds, so an open Task of either would
-- wait forever. Cancel them. Tasks are never deleted: each keeps its
-- requester, attempts and spend as history. A Worker still holding one sees
-- CANCELLED at its next heartbeat or completion. `cancelled_by_id` stays
-- NULL: no person cancelled it.
UPDATE "tasks"
SET "status" = 'CANCELLED',
    "cancel_requested_at" = COALESCE("cancel_requested_at", now()),
    "lease_expires_at" = NULL,
    "updated_at" = now()
WHERE "kind" IN ('event.impact_prior', 'event.impact_prior.clear')
  AND "status" IN ('PENDING', 'LEASED');
