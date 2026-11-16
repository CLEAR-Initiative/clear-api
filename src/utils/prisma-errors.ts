/**
 * The columns of the unique constraint behind a Prisma P2002, or null when
 * `err` is not a P2002. The pg driver adapter reports them (database column
 * names) under `meta.driverAdapterError.cause.constraint.fields`, not under
 * `meta.target`. An empty array means the constraint is unknown.
 */
export function uniqueViolationFields(err: unknown): string[] | null {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "P2002") return null;
  const meta = (err as { meta?: { driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } } }).meta;
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) ? fields.map(String) : [];
}
