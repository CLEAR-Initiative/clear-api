/**
 * Datapoint aggregation core.
 *
 * Reads `report_datapoints` rows for a scope (window × location) and
 * produces a single aggregated payload with per-field quality
 * envelopes. Used by:
 *   - the `aggregatedDatapoint` query resolver (on-demand rollup path)
 *   - the `refreshAggregatedDatapoints` mutation (pre-compute path)
 *
 * Field-rule registry drives the math. Each rule specifies:
 *   - `path`: dotted JSON path into `report_datapoints.data`
 *   - `label`: flat output key on the aggregated payload
 *   - `kind`: additive_count | latest_state | set_union | max | non_aggregatable
 *   - `timeBucket`: dedup granularity (unused for set_union / non_aggregatable)
 *   - `withinGroupPolicy`: how to pick a winner within an incident group
 *
 * POC simplifications (see docs §6.4 for the full model):
 *   - No event-type in incident key — uses `(location, date_bucket)` only.
 *     Two different events in the same place + time collapse into one.
 *   - No "verified within 3 days" confidence override — plain latest-wins.
 *   - No same-report multi-mention collapse — assumes LLM emits each
 *     field once per report (the sub-schema shape enforces this in
 *     practice).
 *   These are Phase 3 refinements; the field-rule registry has the
 *   hooks to add them without changing the aggregator's structure.
 */

// ────────────────────────────────────────────────────────────────────
// Confidence tiers + weights — mirrors §6.1 of the design doc
// ────────────────────────────────────────────────────────────────────

export type ConfidenceTier =
  | "verified"
  | "reported"
  | "estimated"
  | "media"
  | "unverified";

const CONFIDENCE_WEIGHTS: Record<ConfidenceTier, number> = {
  verified: 1.0,
  reported: 0.8,
  estimated: 0.5,
  media: 0.3,
  unverified: 0.1,
};

/** Fold anything the extractor emitted outside the taxonomy to
 *  `unverified` — a soft-enum policy so future taxonomy additions
 *  don't crash the aggregator. */
function normaliseConfidence(raw: string | undefined | null): ConfidenceTier {
  if (raw && raw in CONFIDENCE_WEIGHTS) return raw as ConfidenceTier;
  return "unverified";
}

// ────────────────────────────────────────────────────────────────────
// Field-rule types
// ────────────────────────────────────────────────────────────────────

export type FieldKind =
  | "additive_count"
  | "latest_state"
  | "set_union"
  | "max"
  | "non_aggregatable";

export type TimeBucket = "day" | "week" | "month" | "period";

export type WithinGroupPolicy =
  | "latest_wins"
  | "max_within_report_then_latest"
  | "set_union_all";

export interface FieldRule {
  /** Dotted JSON path into `report_datapoints.data`. */
  path: string;
  /** Flat output key on the aggregated payload. */
  label: string;
  kind: FieldKind;
  /** Ignored for set_union / non_aggregatable. */
  timeBucket?: TimeBucket;
  withinGroupPolicy: WithinGroupPolicy;
  /**
   * set_union only: canonicalise members through `canonicaliseEventTypes`
   * (lowercase, tolerate a bare string) so the published set matches the
   * incident key's casing. Set on `event_types`, which feeds the key.
   * Left off for label sets like `active_clusters` where display casing
   * is preserved.
   */
  canonicaliseCase?: boolean;
}

/**
 * Aggregation registry. Fifteen fields cover the situation-analysis
 * dashboard's headline tiles; adding new rules is O(1) — append here
 * and the aggregator picks them up next run.
 *
 * Field-kind assignments follow §6.2 of the doc:
 *   - counts of one-off events → additive_count with `day` bucket
 *   - counts of period-continuous events (displacement) → additive_count
 *     with `week` bucket (matches DTM cadence)
 *   - state snapshots (stocks, PIN) → latest_state with `month` bucket
 *   - free-form label sets (event_types) → set_union
 */
export const FIELD_RULES: FieldRule[] = [
  // ── Casualties ─────────────────────────────────────────────
  {
    path: "casualties.killed.total",
    label: "killed_total",
    kind: "additive_count",
    timeBucket: "day",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "casualties.injured.total",
    label: "injured_total",
    kind: "additive_count",
    timeBucket: "day",
    withinGroupPolicy: "latest_wins",
  },

  // ── Displacement ────────────────────────────────────────────
  {
    path: "displacement.idp_stock",
    label: "idp_stock",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "displacement.new_displacements",
    label: "new_displacements",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "displacement.returnees",
    label: "returnees",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "displacement.refugees",
    label: "refugees",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },

  // ── Access & incidents ──────────────────────────────────────
  {
    path: "access_and_incidents.security_incidents_count",
    label: "security_incidents_count",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "access_and_incidents.aid_workers_killed",
    label: "aid_workers_killed",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins",
  },

  // ── Needs & funding (per-sector PIN) ─────────────────────────
  {
    path: "needs_and_funding.shelter.people_in_need",
    label: "pin_shelter",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "needs_and_funding.wash.people_in_need",
    label: "pin_wash",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "needs_and_funding.protection.people_in_need",
    label: "pin_protection",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "needs_and_funding.health.people_in_need",
    label: "pin_health",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "needs_and_funding.food_security.people_in_need",
    label: "pin_food_security",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "needs_and_funding.education.people_in_need",
    label: "pin_education",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },

  // ── Overall funding totals ───────────────────────────────────
  {
    path: "needs_and_funding.overall_pin",
    label: "overall_pin",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    // Population Affected — widest circle of crisis impact. Max, not
    // latest: the largest evidenced affected figure across the window is the
    // best estimate of total reach; a later, narrower report shouldn't shrink
    // it. Within a report take the max figure, then latest across reports
    // (clear-context-pipeline ADR-0001). Never sourced from `events`.
    path: "needs_and_funding.overall_affected",
    label: "overall_affected",
    kind: "max",
    timeBucket: "month",
    withinGroupPolicy: "max_within_report_then_latest",
  },
  {
    path: "needs_and_funding.overall_funding_required_usd",
    label: "funding_required_usd",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
  },
  {
    path: "needs_and_funding.overall_funding_received_usd",
    label: "funding_received_usd",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins",
  },

  // ── Set-union labels ────────────────────────────────────────
  {
    path: "timing_and_scope.event_types",
    label: "event_types",
    kind: "set_union",
    withinGroupPolicy: "set_union_all",
    canonicaliseCase: true,
  },
  {
    path: "timing_and_scope.active_clusters",
    label: "active_clusters",
    kind: "set_union",
    withinGroupPolicy: "set_union_all",
  },
];

// ────────────────────────────────────────────────────────────────────
// I/O types
// ────────────────────────────────────────────────────────────────────

/** One `report_datapoints` row, narrowed to what the aggregator needs. */
export interface ReportRow {
  reportId: string;
  publishedAt: Date;
  reportingPeriodStart: Date | null;
  reportingPeriodEnd: Date | null;
  locationIds: string[];
  data: unknown;
}

/** What one aggregated numeric field looks like on the output. */
export interface QualityEnvelope {
  value: number;
  unit: string | null;
  quality_score: number;
  /** Distribution of confidence tiers as proportions summing to 1. */
  confidence_mix: Record<ConfidenceTier, number>;
  newest_report_at: string;
  oldest_report_at: string;
  contributing_report_ids: string[];
}

/** Set-union output for label-type fields (event_types, clusters). */
export interface SetUnionEnvelope {
  values: string[];
  contributing_report_ids: string[];
}

export type AggregatedField = QualityEnvelope | SetUnionEnvelope | null;

/** Bucket-level result — mirrors the `aggregated_datapoints` row. */
export interface AggregationResult {
  data: Record<string, AggregatedField>;
  contributingReportIds: string[];
  newestSourceAt: Date;
  oldestSourceAt: Date;
  dataQualityScore: number;
  reportCount: number;
}

// ────────────────────────────────────────────────────────────────────
// Path traversal — walks the dotted path in `report_datapoints.data`
// ────────────────────────────────────────────────────────────────────

function dig(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

// ────────────────────────────────────────────────────────────────────
// Time bucketing — for incident-key dedup
// ────────────────────────────────────────────────────────────────────

/** Compress a date into a bucket string given a granularity.
 *  Two reports with the same bucket for the same location represent
 *  competing observations of the same incident. */
function bucketDate(dt: Date, bucket: TimeBucket): string {
  const iso = dt.toISOString();
  switch (bucket) {
    case "day":
      return iso.slice(0, 10); // YYYY-MM-DD
    case "week": {
      // ISO week — Monday-based. Cheap: (year, week_num).
      const target = new Date(dt);
      target.setUTCHours(0, 0, 0, 0);
      // Thursday in current week decides the year.
      target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7));
      const week1 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
      const weekNum =
        1 +
        Math.round(
          ((target.getTime() - week1.getTime()) / 86_400_000 -
            3 +
            ((week1.getUTCDay() + 6) % 7)) /
            7,
        );
      return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
      return iso.slice(0, 7); // YYYY-MM
    case "period":
      // POC: fall back to month bucket for period. Real funding-period
      // dedup requires appeal/plan cycle metadata we don't extract yet.
      return iso.slice(0, 7);
  }
}

// ────────────────────────────────────────────────────────────────────
// NumericField extraction — every numeric leaf carries the provenance
// envelope. This normalises what the LLM emitted into a stable shape.
// ────────────────────────────────────────────────────────────────────

interface Mention {
  reportId: string;
  publishedAt: Date;
  incidentDate: Date;
  locationId: string;
  value: number;
  unit: string | null;
  confidence: ConfidenceTier;
  // Canonicalised, sorted event-type set for the report this mention
  // came from, joined into one string. Part of the incident key: two
  // reports at the same location and time bucket but describing
  // different phenomena (a conflict total vs a flood total) are distinct
  // incidents and must not collapse into one. Empty string when the
  // report carries no event types. See eventKeyFor().
  eventKey: string;
}

/** Canonicalise a report's `event_types` into one incident-key
 *  component. Lowercased, trimmed, de-duplicated, and sorted so
 *  {"flood","conflict"} and {"Conflict","FLOOD"} yield the same key.
 *
 *  The set is treated ATOMICALLY — a report stating a figure totalled
 *  across {conflict, flood} cannot be split between them, so its whole
 *  set is one key component. Fanning a figure across its member types
 *  would repeat the location fan-out defect in a second dimension.
 *
 *  Deliberately NOT glide-code canonicalisation: §6.4.1 folds
 *  "armed clash" / "battle" / "armed confrontation" to a single
 *  `disaster_types` glide code, but that needs a DB lookup and this
 *  routine is a pure function over `ReportRow`. Raw normalisation is
 *  enough to separate genuinely different event types; folding synonyms
 *  is a follow-up that must pass the taxonomy in rather than query it. */
/**
 * Canonicalise a raw `event_types` value into a sorted, de-duplicated,
 * lowercased set. The ONE place event-type casing is decided, so the
 * incident key and the published `event_types` set can never disagree.
 *
 * Tolerates a bare string (`event_types: "conflict"` — a common LLM slip)
 * by treating it as a single-element set. `null` / `undefined` / `[]`
 * yield `[]` (genuine absence). Any other shape (number, object) also
 * yields `[]` but fires `onMalformed` — a shape we don't understand
 * shifts published figures, so it must not degrade silently.
 */
function canonicaliseEventTypes(
  raw: unknown,
  onMalformed?: (kind: string) => void,
): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [raw]
      : null;
  if (list === null) {
    onMalformed?.(typeof raw);
    return [];
  }
  const set = new Set<string>();
  for (const v of list) {
    if (typeof v === "string" && v.trim()) set.add(v.trim().toLowerCase());
  }
  return Array.from(set).sort();
}

function eventKeyFor(row: ReportRow): string {
  const raw = dig(row.data, "timing_and_scope.event_types");
  return canonicaliseEventTypes(raw, (kind) =>
    // Deterministic output is preserved (still ""); this is only a
    // data-quality signal for a shape the extractor shouldn't emit.
    console.warn(
      `[datapoint-aggregation] event_types malformed for report ${row.reportId}: ${kind}`,
    ),
  ).join(",");
}

/** Turn one report's numeric field into a mention at its FIGURE SCOPE —
 *  the single `locations` id the figure is a total for (`scope_location_id`,
 *  resolved at extraction; see clear-context-pipeline's Figure Scope work).
 *
 *  Exactly one mention per figure, keyed on its scope. A figure with no
 *  resolved scope — the LLM couldn't pin one, or the name didn't resolve —
 *  is EXCLUDED: it isn't attributed to any location, so it never rolls up
 *  (matching §6.4.1's rule for unresolved locations). This replaces the
 *  old fan-out across every location the report mentioned, which
 *  double-counted at country scope and needed the report-keying stopgap. */
function extractNumericMentions(row: ReportRow, rule: FieldRule): Mention[] {
  const raw = dig(row.data, rule.path);
  if (!raw || typeof raw !== "object") return [];
  const nf = raw as {
    value?: number;
    unit?: string;
    confidence?: string;
    scope_location_id?: unknown;
  };
  const value = Number(nf.value);
  if (!Number.isFinite(value)) return [];

  // The figure's scope. No scope → unattributed → excluded from every
  // bucket (never rolled up).
  const scopeLocationId =
    typeof nf.scope_location_id === "string" && nf.scope_location_id
      ? nf.scope_location_id
      : null;
  if (!scopeLocationId) return [];

  // Incident date defaults to reportingPeriodEnd (the CONTENT date),
  // falling back to publishedAt. This is the input to bucketDate.
  const incidentDate = row.reportingPeriodEnd ?? row.publishedAt;
  const unit = typeof nf.unit === "string" ? nf.unit : null;
  const confidence = normaliseConfidence(nf.confidence);
  // Report-level: every mention this report emits carries the same set.
  const eventKey = eventKeyFor(row);

  return [{
    reportId: row.reportId,
    publishedAt: row.publishedAt,
    incidentDate,
    locationId: scopeLocationId,
    value,
    unit,
    confidence,
    eventKey,
  }];
}

// ────────────────────────────────────────────────────────────────────
// Per-field aggregation
// ────────────────────────────────────────────────────────────────────

/** Winner picker inside an incident group. POC uses plain latest-wins;
 *  the doc's more elaborate `latest_wins_with_confidence_override`
 *  ships in Phase 3. */
function pickWinner(
  mentions: Mention[],
  policy: WithinGroupPolicy = "latest_wins",
): Mention {
  if (policy === "max_within_report_then_latest") {
    // Collapse each report to the largest figure it states (a report may
    // list several affected figures; the widest is the report's claim),
    // then across competing reports in this incident group take the latest
    // by publish date. Used by `max`-kind fields like overall_affected.
    const maxByReport = new Map<string, Mention>();
    for (const m of mentions) {
      const cur = maxByReport.get(m.reportId);
      if (cur === undefined || m.value > cur.value) maxByReport.set(m.reportId, m);
    }
    return Array.from(maxByReport.values()).reduce((best, m) =>
      m.publishedAt > best.publishedAt ? m : best,
    );
  }
  // latest_wins (default): freshest report in the group.
  return mentions.reduce((best, m) => (m.publishedAt > best.publishedAt ? m : best));
}

/** Build the confidence-mix distribution + weighted quality score. */
function computeQuality(mentions: Mention[]): {
  qualityScore: number;
  confidenceMix: Record<ConfidenceTier, number>;
} {
  const counts: Record<ConfidenceTier, number> = {
    verified: 0,
    reported: 0,
    estimated: 0,
    media: 0,
    unverified: 0,
  };
  for (const m of mentions) counts[m.confidence] += 1;
  const total = mentions.length;
  const mix = Object.fromEntries(
    (Object.keys(counts) as ConfidenceTier[]).map((k) => [k, total === 0 ? 0 : counts[k] / total]),
  ) as Record<ConfidenceTier, number>;
  const qualityScore = mentions.reduce((sum, m) => sum + CONFIDENCE_WEIGHTS[m.confidence], 0) /
    Math.max(total, 1);
  return { qualityScore, confidenceMix: mix };
}

/** Aggregate a numeric field across the report set into a
 *  QualityEnvelope. Runs the two-stage flow from §6.4.7:
 *  1. Group mentions by incident key (location + date bucket)
 *  2. Within each group, pick a winner per the policy
 *  3. Combine winners across groups per field-kind rule */
function aggregateNumericField(
  rows: ReportRow[],
  rule: FieldRule,
  locationScope: string | null,
): QualityEnvelope | null {
  const mentions: Mention[] = rows.flatMap((r) => extractNumericMentions(r, rule));

  // Keep only the figures scoped to this bucket's location. Every mention
  // now carries its Figure Scope as `locationId`, so this is an exact
  // match — a figure scoped to Kordofan lands in Kordofan's bucket and
  // nowhere else. A null/absent scope never reaches here (excluded in
  // extractNumericMentions), and a null `locationScope` matches nothing:
  // a scope is required — there is no "aggregate every location at once"
  // roll-up (it would double-count; see #273 / ADR-0003).
  const scoped = mentions.filter((m) => m.locationId === locationScope);
  if (scoped.length === 0) return null;

  const bucket = rule.timeBucket ?? "day";

  // Group by incident key: (figure scope location, time bucket, event-type
  // set) — the shape §6.4.1 always specified, now reachable because each
  // figure carries its own scope. #269's country-scope reportId stopgap is
  // gone: with per-figure scope there is no fan-out to collapse, so no
  // report can double-count across the places it merely mentioned.
  // See docs/adr/0001-country-scope-dedups-by-report.md (superseded).
  //
  // The eventKey is the third key dimension. Two figures at the same scope
  // and time bucket but with different event-type sets are distinct
  // phenomena (a conflict toll vs a flood toll) and must not collapse.
  //
  // NUL joins the key components. It cannot appear in a cuid, an ISO bucket
  // date, or a canonicalised event type, so unlike "|" it can't let a
  // component's own separator forge a collision across groups.
  const SEP = "\u0000";
  const groups = new Map<string, Mention[]>();
  // Track, per (location, bucket) base, which event-key groups exist, so
  // an untyped mention can be merged into a lone typed sibling below.
  const groupsByBase = new Map<string, Set<string>>();
  for (const m of scoped) {
    const base = `${m.locationId}${SEP}${bucketDate(m.incidentDate, bucket)}`;
    const key = `${base}${SEP}${m.eventKey}`;
    const bucketList = groups.get(key);
    if (bucketList) bucketList.push(m);
    else groups.set(key, [m]);
    const siblings = groupsByBase.get(base);
    if (siblings) siblings.add(key);
    else groupsByBase.set(base, new Set([key]));
  }

  // Merge each untyped ("") group into its sole typed sibling. An empty
  // event-type set means "the extractor didn't tell us", NOT "a distinct
  // phenomenon" — so it must not form its own additive group when there
  // is exactly one typed group at the same (location, bucket) that it
  // plausibly belongs to. Without this, an untyped and a typed figure at
  // the same scope and day are summed instead of deduped, re-inflating
  // additive_count. When several typed groups share the base we can't
  // disambiguate, so the untyped group is left standing.
  // See docs/adr/0002-event-type-incident-key.md.
  for (const [base, keys] of groupsByBase) {
    const emptyKey = `${base}${SEP}`;
    if (keys.size < 2 || !groups.has(emptyKey)) continue;
    const typed = [...keys].filter((k) => k !== emptyKey);
    if (typed.length !== 1) continue; // ambiguous — leave the untyped group
    groups.get(typed[0]!)!.push(...groups.get(emptyKey)!);
    groups.delete(emptyKey);
  }

  // Within-group winner + collect winners
  const winners: Mention[] = [];
  for (const group of groups.values()) {
    winners.push(pickWinner(group, rule.withinGroupPolicy));
  }

  // Cross-group combine per field-kind
  let value: number;
  switch (rule.kind) {
    case "additive_count":
      value = winners.reduce((sum, w) => sum + w.value, 0);
      break;
    case "latest_state":
      // Across incident groups, pick the freshest snapshot.
      value = pickWinner(winners).value;
      break;
    case "max":
      value = Math.max(...winners.map((w) => w.value));
      break;
    default:
      // Non-numeric kinds shouldn't hit this function.
      return null;
  }

  const { qualityScore, confidenceMix } = computeQuality(winners);
  const contributing = Array.from(new Set(winners.map((w) => w.reportId)));
  const publishedAts = winners.map((w) => w.publishedAt.getTime());
  const unit = winners.find((w) => w.unit)?.unit ?? null;
  return {
    value,
    unit,
    quality_score: Number(qualityScore.toFixed(4)),
    confidence_mix: confidenceMix,
    newest_report_at: new Date(Math.max(...publishedAts)).toISOString(),
    oldest_report_at: new Date(Math.min(...publishedAts)).toISOString(),
    contributing_report_ids: contributing,
  };
}

/** Aggregate a set-union label field (event_types, active_clusters).
 *  The path yields an array of strings; we union across all
 *  contributing reports. */
function aggregateSetUnionField(
  rows: ReportRow[],
  rule: FieldRule,
): SetUnionEnvelope | null {
  const union = new Set<string>();
  const contributing = new Set<string>();
  for (const r of rows) {
    const raw = dig(r.data, rule.path);
    // For a case-canonicalised field (event_types) run members through the
    // same helper the incident key uses — so the published set and the key
    // agree on casing, and a bare string is tolerated in both. Other label
    // sets (active_clusters) keep their display casing: trim only.
    const values = rule.canonicaliseCase
      ? canonicaliseEventTypes(raw)
      : Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim())
        : [];
    for (const v of values) union.add(v);
    if (values.length > 0) contributing.add(r.reportId);
  }
  if (union.size === 0) return null;
  return {
    values: Array.from(union).sort(),
    contributing_report_ids: Array.from(contributing),
  };
}

// ────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────

/**
 * Roll a set of `report_datapoints` rows into one aggregated bucket.
 *
 * @param rows  contributing report rows (already filtered by window + location scope).
 * @param locationScope  the specific location this bucket rolls up to; `null` = country-wide.
 * @returns  the aggregated payload + bucket-level quality metadata.
 */
export function aggregateReports(
  rows: ReportRow[],
  locationScope: string | null,
): AggregationResult | null {
  if (rows.length === 0) return null;

  const data: Record<string, AggregatedField> = {};
  for (const rule of FIELD_RULES) {
    if (rule.kind === "set_union") {
      data[rule.label] = aggregateSetUnionField(rows, rule);
    } else if (rule.kind !== "non_aggregatable") {
      data[rule.label] = aggregateNumericField(rows, rule, locationScope);
    }
  }

  const publishedAts = rows.map((r) => r.publishedAt.getTime());
  const newestSourceAt = new Date(Math.max(...publishedAts));
  const oldestSourceAt = new Date(Math.min(...publishedAts));

  // Bucket-level quality score = mean of populated fields' scores. A
  // bucket with lots of low-quality mentions surfaces as low here even
  // when individual numbers look fine.
  const scores: number[] = [];
  for (const field of Object.values(data)) {
    if (field && "quality_score" in field) scores.push(field.quality_score);
  }
  const dataQualityScore = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;

  return {
    data,
    contributingReportIds: rows.map((r) => r.reportId),
    newestSourceAt,
    oldestSourceAt,
    dataQualityScore: Number(dataQualityScore.toFixed(4)),
    reportCount: rows.length,
  };
}
