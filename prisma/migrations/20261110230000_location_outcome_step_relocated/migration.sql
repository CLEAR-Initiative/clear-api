-- A replay job that moves a Signal without sending it through the drain
-- (`updateSignalLocation` with `runKind: REPLAY`) writes a RELOCATED Outcome
-- (ADR-0020).

-- AlterEnum
ALTER TYPE "LocationOutcomeStep" ADD VALUE 'RELOCATED';
