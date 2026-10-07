/**
 * Task kinds of the impact-prior family (ADR-0010).
 *
 * A kind is free text on the Task so a new source is a Worker and a handler,
 * not a migration. One enrichment request fans out into one Task per
 * enabled kind (`TASK_IMPACT_PRIOR_KINDS`), each drained by its own Worker,
 * so several Workers propose on one Event side by side: the Dagster drain
 * over CLEAR data (`event.impact_prior.clear`), the Claude routine over the
 * web (`event.impact_prior.web`), any later source. The bare
 * `event.impact_prior` is the pre-fan-out kind, kept claimable for one
 * release so an old Worker does not strand its open Tasks.
 *
 * Shared by the resolver and the notification service, which must not
 * import each other.
 */

/** The family: the bare kind, and the prefix of every per-source kind. */
export const IMPACT_PRIOR_KIND = "event.impact_prior";

/** The bare kind or a per-source kind under it. */
export function isImpactPriorKind(kind: string): boolean {
  return kind === IMPACT_PRIOR_KIND || kind.startsWith(`${IMPACT_PRIOR_KIND}.`);
}

/** The source a per-source kind names (`clear`, `web`, …); null for the
 *  bare kind and for kinds outside the family. */
export function impactPriorSource(kind: string): string | null {
  if (!kind.startsWith(`${IMPACT_PRIOR_KIND}.`)) return null;
  return kind.slice(IMPACT_PRIOR_KIND.length + 1) || null;
}

const SOURCE_NAMES: Record<string, string> = {
  clear: "CLEAR data",
  web: "the web",
};

/** A kind in a person's terms, for notifications: "Impact prior from CLEAR
 *  data", "Impact prior from the web", "Impact prior" for the bare kind; any
 *  other kind as itself. */
export function taskKindLabel(kind: string): string {
  if (!isImpactPriorKind(kind)) return kind;
  const source = impactPriorSource(kind);
  if (!source) return "Impact prior";
  return `Impact prior from ${SOURCE_NAMES[source] ?? source}`;
}
