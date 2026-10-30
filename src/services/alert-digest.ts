/**
 * Alert Digest matching: which users an Alert Digest would reach, and with
 * which Alerts. Shared by `notifyAlertDigest`, which writes and sends the
 * digest, and `briefDigestPreview`, which only reports what it would send.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { severityClearsFloor } from "../utils/alert-severity.js";

export type DigestFrequency = "daily" | "weekly" | "monthly";

/** The parts of an Alert and its Event that digest matching reads. */
export interface DigestAlert {
  id: string;
  event: {
    types: string[];
    originId: string | null;
    destinationId: string | null;
    locationId: string | null;
    severity: number | null;
  };
}

/**
 * Match Alerts to the active subscriptions of one digest frequency.
 *
 * A subscription matches an Alert when its type is one of the Alert's Event
 * types, its location is the Event's origin, destination or general location
 * or an ancestor of one (a country subscription matches a district Alert),
 * and the Event's severity clears its floor (`severityClearsFloor`).
 *
 * Reads only, in at most two queries: one `locations.findMany` for every
 * Alert's ancestors, then one `userAlertSubscriptions.findMany`.
 *
 * @returns alertId → distinct matched userIds. Alerts nobody matches are
 * absent.
 */
export async function matchDigestRecipients(
  prisma: PrismaClient,
  alerts: readonly DigestAlert[],
  frequency: DigestFrequency,
): Promise<Map<string, string[]>> {
  const matches = new Map<string, Set<string>>();

  const directIdsByAlert = new Map<string, string[]>();
  const allDirectIds = new Set<string>();
  const allTypes = new Set<string>();
  for (const alert of alerts) {
    for (const t of alert.event.types) allTypes.add(t);
    const directIds = [
      alert.event.originId,
      alert.event.destinationId,
      alert.event.locationId,
    ].filter((id): id is string => id !== null);
    directIdsByAlert.set(alert.id, directIds);
    for (const id of directIds) allDirectIds.add(id);
  }

  // One lookup for every Alert's ancestors, instead of one per Alert.
  const ancestorsById = new Map<string, string[]>();
  if (allDirectIds.size > 0) {
    const locations = await prisma.locations.findMany({
      where: { id: { in: [...allDirectIds] } },
      select: { id: true, ancestorIds: true },
    });
    for (const loc of locations) ancestorsById.set(loc.id, loc.ancestorIds);
  }

  // Each Alert's locations, ancestors included.
  const alertLocationSets = new Map<string, Set<string>>();
  const allExpandedLocationIds = new Set<string>();
  for (const alert of alerts) {
    const directIds = directIdsByAlert.get(alert.id) ?? [];
    const expanded = new Set(directIds);
    for (const id of directIds) {
      for (const aid of ancestorsById.get(id) ?? []) expanded.add(aid);
    }
    alertLocationSets.set(alert.id, expanded);
    for (const lid of expanded) allExpandedLocationIds.add(lid);
  }

  if (allTypes.size === 0 || allExpandedLocationIds.size === 0) return new Map();

  // Only subscriptions that match ANY of the Alert types AND locations.
  const subscriptions = await prisma.userAlertSubscriptions.findMany({
    where: {
      active: true,
      frequency,
      alertType: { in: [...allTypes] },
      locationId: { in: [...allExpandedLocationIds] },
    },
    select: { userId: true, alertType: true, locationId: true, minSeverity: true },
  });

  for (const sub of subscriptions) {
    for (const alert of alerts) {
      const typesMatch = alert.event.types.includes(sub.alertType);
      const locationMatch = alertLocationSets.get(alert.id)?.has(sub.locationId) ?? false;
      const severityMatch = severityClearsFloor(alert.event.severity, sub.minSeverity);
      if (!(typesMatch && locationMatch && severityMatch)) continue;

      let users = matches.get(alert.id);
      if (!users) {
        users = new Set();
        matches.set(alert.id, users);
      }
      users.add(sub.userId);
    }
  }

  return new Map([...matches].map(([alertId, users]) => [alertId, [...users]]));
}
