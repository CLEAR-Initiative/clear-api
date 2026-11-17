/**
 * True when `err` is a Prisma unique-constraint violation (P2002).
 *
 * Deliberately says nothing about *which* constraint fired: Prisma reports
 * that in different places depending on the driver adapter and version
 * (`meta.target`, or `meta.driverAdapterError.cause.constraint.fields` with
 * `@prisma/adapter-pg`). Callers decide what clashed by reading the rows.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
