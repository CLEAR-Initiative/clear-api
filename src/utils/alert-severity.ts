/**
 * Severity gating for alert subscriptions — the one rule every fan-out path
 * (createAlert, escalateEvent, notifyAlertSubscribers, the digest matcher)
 * shares, so the copies can't drift.
 */

/**
 * The lowest `minSeverity` a subscription can hold: "notify me on every
 * severity". Also the default for new subscriptions.
 */
export const ALL_SEVERITIES_FLOOR = 1;

/**
 * An unknown (null) severity is not ranked, so it can't clear a raised floor —
 * but subscribers who asked for every severity still get it. The event's
 * severity itself stays null; only the matching treats it as the floor.
 */
function effectiveSeverity(eventSeverity: number | null | undefined): number {
  return eventSeverity ?? ALL_SEVERITIES_FLOOR;
}

/** Prisma `minSeverity` filter selecting the subscriptions an event reaches. */
export function minSeverityFilterFor(eventSeverity: number | null | undefined): { lte: number } {
  return { lte: effectiveSeverity(eventSeverity) };
}

/** In-memory twin of {@link minSeverityFilterFor}, for already-loaded subscriptions. */
export function severityClearsFloor(
  eventSeverity: number | null | undefined,
  minSeverity: number,
): boolean {
  return effectiveSeverity(eventSeverity) >= minSeverity;
}
