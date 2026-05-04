import type { PrismaClient } from "../generated/prisma/client.js";

export function severityToLabel(severity: number | null | undefined): string | null {
  const labels: Record<number, string> = { 1: "MINIMAL", 2: "LOW", 3: "MEDIUM", 4: "HIGH", 5: "CRITICAL" };
  return severity != null ? (labels[severity] ?? null) : null;
}

export function formatCount(n: bigint | number): string {
  const v = typeof n === "bigint" ? Number(n) : n;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toLocaleString();
}

export interface EmailLocation {
  name: string;
  population: bigint | null;
}

/**
 * Resolve the best human-readable location for email display.
 * Prefers A2 (district) -> A1 (state) -> A0 (country).
 * Falls back through ancestors when the primary location is a point/deep level
 * (level > 2) or has a garbage name (raw signal text, > 80 chars).
 */
export async function resolveEmailLocation(
  prisma: PrismaClient,
  loc: { id: string; name: string; level: number; population: bigint | null; ancestorIds: string[] } | null,
): Promise<EmailLocation | null> {
  if (!loc) return null;

  // Admin levels 0-2 with a reasonable name - use directly.
  if (loc.level <= 2 && loc.name.length <= 80) {
    return { name: loc.name, population: loc.population };
  }

  // Point / deep-level location or garbage name - walk up to A2 -> A1 -> A0.
  if (loc.ancestorIds.length === 0) {
    // No ancestors - nothing better to show.
    return null;
  }

  const ancestors = await prisma.locations.findMany({
    where: { id: { in: loc.ancestorIds } },
    select: { id: true, name: true, level: true, population: true },
  });

  for (const targetLevel of [2, 1, 0]) {
    const found = ancestors.find((a) => a.level === targetLevel);
    if (found) return { name: found.name, population: found.population };
  }

  return null;
}

/**
 * Resolve the event type label from the disasterTypes table.
 * Tries a case-insensitive glideNumber match; falls back to the raw type code.
 */
export async function resolveEventTypeLabel(
  prisma: PrismaClient,
  types: string[],
): Promise<string | null> {
  const code = types[0];
  if (!code) return null;

  const disasterType = await prisma.disasterTypes.findFirst({
    where: { glideNumber: { equals: code, mode: "insensitive" } },
    select: { level1: true },
  });

  return disasterType?.level1 ?? code;
}
