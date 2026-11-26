-- Decision records V2 (ADR-0024, Exponential #1289): one DecisionType per
-- remaining human judgement on a Crisis, Alert, Event, Signal or hotline
-- thread. Enum values only; no row changes.
ALTER TYPE "decision_type" ADD VALUE 'CRISIS_CREATED';
ALTER TYPE "decision_type" ADD VALUE 'CRISIS_EVENT_ADDED';
ALTER TYPE "decision_type" ADD VALUE 'CRISIS_EVENT_REMOVED';
ALTER TYPE "decision_type" ADD VALUE 'CRISIS_EDITED';
ALTER TYPE "decision_type" ADD VALUE 'CRISIS_DELETED';
ALTER TYPE "decision_type" ADD VALUE 'ALERT_RAISED';
ALTER TYPE "decision_type" ADD VALUE 'ALERT_UPDATED';
ALTER TYPE "decision_type" ADD VALUE 'ALERT_DELETED';
ALTER TYPE "decision_type" ADD VALUE 'EVENT_CREATED';
ALTER TYPE "decision_type" ADD VALUE 'EVENT_UPDATED';
ALTER TYPE "decision_type" ADD VALUE 'EVENT_ESCALATED';
ALTER TYPE "decision_type" ADD VALUE 'EVENT_DELETED';
ALTER TYPE "decision_type" ADD VALUE 'SIGNAL_CREATED';
ALTER TYPE "decision_type" ADD VALUE 'SIGNAL_DELETED';
ALTER TYPE "decision_type" ADD VALUE 'GROUND_THREAD_REVIEWED';
