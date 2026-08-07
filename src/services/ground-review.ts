/**
 * Review state machine for ground threads — the human gate between the
 * staging tier and the signals graph.
 *
 * States: unverified → approved_private | approved_public | rejected.
 *
 * Transition policy (V1):
 *   - unverified        → any decision.
 *   - approved_private  → approve_public (escalate) or reject (revise).
 *     Private approval is a working state, not a commitment.
 *   - rejected          → approve_private or approve_public. A mistaken
 *     rejection must be reversible — nothing has left the staging tier.
 *   - approved_public   → TERMINAL. Public approval triggers promotion
 *     into `signals` (see ground-promotion.ts); un-publishing would leave
 *     a promoted signal orphaned, so V1 forbids leaving this state.
 *
 * Role gating: the acting user must be a platform admin, or carry one of
 * the source's `reviewerRoles` (default ["admin", "analyst"]) — the
 * per-source policy record decides who may review its content.
 *
 * Pure functions, unit-tested in tests/services/ground-review.test.ts.
 */

export const REVIEW_STATES = [
  "unverified",
  "approved_private",
  "approved_public",
  "rejected",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_DECISIONS = ["approve_private", "approve_public", "reject"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

const DECISION_TARGET: Record<ReviewDecision, ReviewState> = {
  approve_private: "approved_private",
  approve_public: "approved_public",
  reject: "rejected",
};

const ALLOWED: Record<ReviewState, ReadonlySet<ReviewDecision>> = {
  unverified: new Set(REVIEW_DECISIONS),
  approved_private: new Set(["approve_public", "reject"]),
  rejected: new Set(["approve_private", "approve_public"]),
  approved_public: new Set(), // terminal — promotion has fired
};

export function isReviewDecision(value: string): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly string[]).includes(value);
}

export function isReviewState(value: string): value is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(value);
}

export interface TransitionOk {
  ok: true;
  next: ReviewState;
}
export interface TransitionErr {
  ok: false;
  reason: string;
}

/** Validate a review decision against the current state. Returns the next
 * state, or a human-readable refusal (surfaced verbatim to the UI). */
export function reviewTransition(
  current: string,
  decision: string,
): TransitionOk | TransitionErr {
  if (!isReviewDecision(decision)) {
    return {
      ok: false,
      reason: `Unknown decision "${decision}" — expected one of: ${REVIEW_DECISIONS.join(", ")}`,
    };
  }
  if (!isReviewState(current)) {
    return { ok: false, reason: `Thread has unknown review state "${current}"` };
  }
  if (current === "approved_public") {
    return {
      ok: false,
      reason:
        "Thread is approved_public and already promoted — public approval is final in V1",
    };
  }
  if (!ALLOWED[current].has(decision)) {
    return { ok: false, reason: `Cannot ${decision} a thread in state "${current}"` };
  }
  return { ok: true, next: DECISION_TARGET[decision] };
}

/** Whether `user` may review threads of a source with `reviewerRoles`.
 * Platform admins always pass; everyone else needs their global role
 * listed on the source's policy record. */
export function canReviewSource(
  user: { role?: string | null } | null | undefined,
  reviewerRoles: string[],
): boolean {
  const role = user?.role;
  if (!role) return false;
  if (role === "admin") return true;
  return reviewerRoles.includes(role);
}
