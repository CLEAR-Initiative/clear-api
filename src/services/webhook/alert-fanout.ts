/**
 * Fan a PUBLISHED CLEAR alert out to team-configured `clear_alert` webhook
 * subscriptions, alongside the e-mail fan-out in createAlert. Mirrors the
 * GlitchTip receive route: match active subscriptions, create one
 * WebhookDelivery per match, then fire `attemptDelivery` in the background so
 * alert creation never blocks on downstream webhook latency. Delivery keeps the
 * same guarantees as GlitchTip (HMAC-signed POST, exponential-backoff retries,
 * DLQ at MAX_ATTEMPTS) — only the trigger, matching, and payload differ.
 *
 * Matching (decision): a subscription fires when the alert's event location
 * falls inside the owning team's location scope (its teamLocations expanded to
 * descendants; a team with NO bindings is wide-open and matches any location),
 * AND the optional `alertTypeFilter` (glide codes) intersects the event's types,
 * AND the optional `minSeverity` floor is met (a set floor excludes
 * null-severity alerts).
 */
import type { PrismaClient } from "../../generated/prisma/client.js";
import { getTeamScopeLocationIds } from "../../utils/location-scope.js";
import { attemptDelivery } from "./deliver.js";

export interface AlertWebhookEvent {
  id: string;
  title: string | null;
  description: string | null;
  types: string[];
  severity: number | null;
  originId: string | null;
  destinationId: string | null;
  locationId: string | null;
}

/** Returns the number of webhook deliveries kicked off (0 when nothing matched). */
export async function fanOutAlertWebhooks(
  prisma: PrismaClient,
  alert: { id: string; status: string; createdAt: Date },
  event: AlertWebhookEvent,
  frontendUrl: string,
): Promise<number> {
  const subs = await prisma.webhookSubscription.findMany({
    where: { source: "clear_alert", active: true, teamId: { not: null } },
    select: { id: true, teamId: true, alertTypeFilter: true, minSeverity: true },
  });
  if (subs.length === 0) return 0;

  const eventLocationIds = [event.originId, event.destinationId, event.locationId].filter(
    (id): id is string => id !== null,
  );

  // Resolve each team's location scope once per fan-out.
  const scopeCache = new Map<string, string[] | undefined>();
  const scopeFor = async (teamId: string): Promise<string[] | undefined> => {
    if (!scopeCache.has(teamId)) {
      scopeCache.set(teamId, await getTeamScopeLocationIds(prisma, teamId));
    }
    return scopeCache.get(teamId);
  };

  const matchedIds: string[] = [];
  for (const s of subs) {
    // Apply the CHEAP in-memory filters first, so a subscription excluded by
    // type/severity never pays for a (DB-backed) team-scope lookup.
    if (s.alertTypeFilter.length > 0 && !event.types.some((t) => s.alertTypeFilter.includes(t))) {
      continue;
    }
    if (s.minSeverity != null && (event.severity == null || event.severity < s.minSeverity)) {
      continue;
    }
    const scope = await scopeFor(s.teamId as string); // where clause filtered out null
    // `undefined` scope = team with no location bindings = wide-open (any location).
    const inScope = scope === undefined || eventLocationIds.some((id) => scope.includes(id));
    if (!inScope) continue;
    matchedIds.push(s.id);
  }
  if (matchedIds.length === 0) return 0;

  // Human-readable location names for the payload (best-effort).
  const locationNames =
    eventLocationIds.length > 0
      ? (
          await prisma.locations.findMany({
            where: { id: { in: eventLocationIds } },
            select: { name: true },
          })
        ).map((l) => l.name)
      : [];

  const payload = {
    type: "alert.created",
    alert: { id: alert.id, status: alert.status, createdAt: alert.createdAt.toISOString() },
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      types: event.types,
      severity: event.severity,
      locations: locationNames,
    },
    url: `${frontendUrl}/event/${event.id}`,
  };

  // Create + dispatch each delivery INDEPENDENTLY. A subscription deleted
  // between matching and insert fails its FK — that one is skipped and logged,
  // and must not strand (reject) the others' inserts, which would leave them
  // with no nextRetryAt and never retried.
  let dispatched = 0;
  await Promise.all(
    matchedIds.map(async (subscriptionId) => {
      let deliveryId: string;
      try {
        const d = await prisma.webhookDelivery.create({
          data: {
            subscriptionId,
            eventId: `alert:${alert.id}`,
            eventType: "alert.created",
            requestBody: payload,
          },
          select: { id: true },
        });
        deliveryId = d.id;
      } catch (e) {
        console.error(
          `[alert-webhook] delivery insert failed for subscription ${subscriptionId} (likely deleted) — skipping:`,
          e,
        );
        return;
      }
      dispatched += 1;
      void attemptDelivery(prisma, deliveryId).catch((e) =>
        console.error(`[alert-webhook] initial attempt ${deliveryId} threw:`, e),
      );
    }),
  );
  return dispatched;
}
