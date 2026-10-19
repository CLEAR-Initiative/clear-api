import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

/**
 * The level-0 (country) ancestor of an Event's primary location — the
 * location → origin → destination preference `escalateEvent` uses — walking
 * `ancestorIds` the way `resolveEmailLocation` does. Events have no country
 * column. Null when the Event has no location or the walk finds no level 0.
 */
export async function resolveEventCountryId(
  prisma: Prisma.TransactionClient | PrismaClient,
  event: { locationId: string | null; originId: string | null; destinationId: string | null },
): Promise<string | null> {
  const primaryId = event.locationId ?? event.originId ?? event.destinationId;
  if (!primaryId) return null;
  const primary = await prisma.locations.findUnique({
    where: { id: primaryId },
    select: { id: true, level: true, ancestorIds: true },
  });
  if (!primary) return null;
  if (primary.level === 0) return primary.id;
  if (primary.ancestorIds.length === 0) return null;
  const country = await prisma.locations.findFirst({
    where: { id: { in: primary.ancestorIds }, level: 0 },
    select: { id: true },
  });
  return country?.id ?? null;
}
