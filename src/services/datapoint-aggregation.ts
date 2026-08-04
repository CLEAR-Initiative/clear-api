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
 * Implemented refinements (full model lives in the clear-context-pipeline
 * datapoint design doc + its ADRs):
 *   - Event-type IS part of the incident key — `(figure scope, time bucket,
 *     event-type set)` — so distinct phenomena at one scope+time don't collapse.
 *   - Verified-within-3-days confidence override on additive counts
 *     (`latest_wins_with_confidence_override`).
 *   - Provenance is complete: `contributing_report_ids` and `confidence_mix`
 *     cover every report that fed a figure, winners and deduped losers alike;
 *     `suppressed_count` counts the deduped-away figures so silent dedup is
 *     observable.
 *
 * Known limitations (not yet tracked):
 *   - The 3-day override window is a module const, not per-rule configurable.
 *   - Period-range overlap: reports cover 2–6 week overlapping windows, so a
 *     single-date week bucket isn't exact — correct dedup compares period
 *     ranges. Funding's "reporting period" is approximated by the week bucket.
 *   - No same-report multi-mention collapse — the sub-schema emits each field
 *     once per report, so there's nothing to collapse.
 */

// ────────────────────────────────────────────────────────────────────
// Confidence tiers + weights — mirrors §6.1 of the design doc
// ────────────────────────────────────────────────────────────────────

export type ConfidenceTier = "verified" | "reported" | "estimated" | "media" | "unverified";

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

// ── Information credibility (clear-context-pipeline ADR-0004 §4) ────────────────────────────
// The document-level criteria are rated met/partial/unmet by the extractor and
// stored on `narrative_and_confidence.information_credibility`. Directness is
// the per-figure `confidence` tier (its CONFIDENCE_WEIGHTS value, not a rating).
// Recency is NOT scored here — it depends on `now` and is folded in at read
// time by the resolver (clear-context-pipeline ADR-0005 §2), so what we compute + cache is the
// TIME-INVARIANT part: 7 criteria summing to at most 8.5 (recency adds ≤1.5 at
// read for the full 0–10 information_credibility).
const CREDIBILITY_RATING: Record<string, number> = { met: 1, partial: 0.5, unmet: 0 };

/** A missing / off-taxonomy rating scores `partial` (0.5) — the neutral
 *  "not assessed" fallback specified in clear-context-pipeline ADR-0004 §4.
 *  Deliberately neutral, not conservative like reliability's `null → 1`: an
 *  unrated criterion is no signal, not an untrusted source. Rarely exercised —
 *  a v2 row carries all six document-level criteria; this covers malformed /
 *  pre-v2 rows only. Domain-tunable (see the ADR). */
function ratingValue(v: unknown): number {
  return typeof v === "string" && v in CREDIBILITY_RATING ? CREDIBILITY_RATING[v]! : 0.5;
}

/** Resolve one criterion per clear-context-pipeline ADR-0004 §4's per-datapoint-with-document-fallback
 *  rule: the figure's own override wins where present; otherwise the report's
 *  document-level rating; otherwise `partial` (neutral). */
function resolvedRating(figureVal: unknown, docVal: unknown): number {
  if (typeof figureVal === "string" && figureVal in CREDIBILITY_RATING) {
    return CREDIBILITY_RATING[figureVal]!;
  }
  return ratingValue(docVal);
}

/** Time-invariant information credibility for one figure, 0–8.5: Directness
 *  (per-figure `confidence`) plus the six intrinsic criteria, each resolved
 *  per-figure-then-document (clear-context-pipeline ADR-0004 §4) and weighted. Recency (weight 1.5) is
 *  added at read time. */
function intrinsicCredibilityOf(
  confidence: ConfidenceTier,
  docCredibility: unknown,
  figureCredibility: unknown,
): number {
  const dc =
    docCredibility && typeof docCredibility === "object"
      ? (docCredibility as Record<string, unknown>)
      : {};
  const fc =
    figureCredibility && typeof figureCredibility === "object"
      ? (figureCredibility as Record<string, unknown>)
      : {};
  return (
    2.0 * CONFIDENCE_WEIGHTS[confidence] + // Directness (per-figure)
    1.5 * resolvedRating(fc.attribution_quality, dc.attribution_quality) +
    1.5 * resolvedRating(fc.internal_consistency, dc.internal_consistency) +
    1.5 * resolvedRating(fc.plausibility_in_context, dc.plausibility_in_context) +
    1.0 * resolvedRating(fc.geographic_temporal_specificity, dc.geographic_temporal_specificity) +
    0.5 * resolvedRating(fc.methodology_transparency, dc.methodology_transparency) +
    0.5 * resolvedRating(fc.representativeness, dc.representativeness)
  );
}

/** Source-reliability grade (1–4) for a figure's source id, resolving through
 *  the registry map. An ungraded (null) or unknown source → 1, matching the
 *  clear-context-pipeline ADR-0005 formula's `null → 1` rule. */
function reliabilityOf(sourceId: string | null, reliabilityBySource: Map<string, number | null>): number {
  if (!sourceId) return 1;
  const r = reliabilityBySource.get(sourceId);
  return r == null ? 1 : r;
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

export type TimeBucket = "day" | "week" | "month";

/** Direction in which low-quality figures skew a field (clear-context-pipeline ADR-0005 §3). Drives
 *  the comparable-quality tie-break in bias-aware selection. */
export type QualityBias = "overreport" | "underreport" | "neutral";

export type WithinGroupPolicy =
  | "latest_wins"
  | "latest_wins_with_confidence_override"
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
  /** Direction low-quality figures skew (clear-context-pipeline ADR-0005 §3). On comparable quality the
   *  tie-break takes the LOWER value for `overreport`, HIGHER for `underreport`,
   *  freshest for `neutral`. Omitted on label (set_union) fields. */
  qualityBias?: QualityBias;
  /** Freshness validity window in days (clear-context-pipeline ADR-0005 § table): how long a figure
   *  stays "recent" for read-time Recency, and the base for the override reach.
   *  Omitted on label fields. */
  validityWindowDays?: number;
  /** Override divisor `x` (clear-context-pipeline ADR-0005 §4): a higher-quality figure may override a
   *  fresher, weaker one only within `validityWindowDays / x` of the freshest. */
  overrideDivisor?: number;
}

/**
 * Aggregation registry. Fifteen fields cover the situation-analysis
 * dashboard's headline tiles; adding new rules is O(1) — append here
 * and the aggregator picks them up next run.
 *
 * Time buckets. Our source reports are analytical and weekly, and a figure is
 * already a total over a reporting PERIOD ("600 affected between X and Y"), not
 * an event on a day (clear-context-pipeline ADR-0002). So SUMMED figures dedup at the
 * reporting-WEEK granularity: two reports for the same week + location + event
 * are the same measurement (dedup); different weeks sum. A `day` bucket would
 * never group two weekly reports and would double-count same-week restatements;
 * `month` would merge distinct weeks and undercount. Slow-moving STATE snapshots
 * (stocks, PIN) use `month` with latest-wins; set-union labels use no bucket.
 *
 * KNOWN LIMITATION — period-range overlap: sitreps cover 2–6 week, overlapping
 * windows, so no single calendar bucket is exact — two reports whose periods
 * overlap but end in different weeks still sum. Correct dedup compares the
 * period RANGES (reportingPeriodStart..End) for overlap, which needs a
 * range-grouping pass rather than a bucket. `week` is the best bucket short of
 * that; range-overlap dedup is tracked as a follow-up.
 */
export const FIELD_RULES: FieldRule[] = [
  // ── Casualties ─────────────────────────────────────────────
  // Weekly period totals ("N killed between X and Y") — dedup per reporting
  // week, not per day: there is no per-day figure to bucket on
  // (clear-context-pipeline ADR-0002).
  // Low-quality tolls skew HIGH (media inflation) → overreport; 7-day conflict
  // window, override reach /2.
  {
    path: "casualties.killed.total",
    label: "killed_total",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "overreport",
    validityWindowDays: 7,
    overrideDivisor: 2,
  },
  {
    path: "casualties.injured.total",
    label: "injured_total",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "overreport",
    validityWindowDays: 7,
    overrideDivisor: 2,
  },

  // ── Displacement ──────────────────────────────────────────── movement is
  // under-captured → underreport; 30-day window, override reach /3.
  {
    path: "displacement.idp_stock",
    label: "idp_stock",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },
  {
    path: "displacement.new_displacements",
    label: "new_displacements",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "underreport",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },
  // Returns are split into a STOCK (cumulative returned to date, latest-wins)
  // and a FLOW (new returns this period, summed) — clear-context-pipeline ADR-0005 §4a. The old single
  // `returnees` additive field conflated the two and double-counted a running
  // total. The estimated current-total roll-up (stock + forward flows) is a
  // read-time concern handled by the resolver, not baked here.
  {
    path: "displacement.returnee_stock",
    label: "returnee_stock",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },
  {
    path: "displacement.new_returns",
    label: "new_returns",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "underreport",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },
  {
    path: "displacement.refugees",
    label: "refugees",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },

  // ── Access & incidents ──────────────────────────────────────
  // Weekly period totals ("N incidents this period") — dedup per reporting
  // week. Reports don't carry per-incident/per-day breakdowns
  // (clear-context-pipeline ADR-0002).
  // Incidents are UNDER-recorded → underreport, 7-day conflict window. Aid-worker
  // tolls skew high like casualties → overreport.
  {
    path: "access_and_incidents.security_incidents_count",
    label: "security_incidents_count",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "underreport",
    validityWindowDays: 7,
    overrideDivisor: 2,
  },
  {
    path: "access_and_incidents.aid_workers_killed",
    label: "aid_workers_killed",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "overreport",
    validityWindowDays: 7,
    overrideDivisor: 2,
  },

  // ── Needs & funding (per-sector PIN) ───────────────────────── access-limited
  // undercount → underreport; 90-day needs-assessment window (food security
  // follows IPC's ~120-day cycle, override reach /2).
  {
    path: "needs_and_funding.shelter.people_in_need",
    label: "pin_shelter",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 90,
    overrideDivisor: 3,
  },
  {
    path: "needs_and_funding.wash.people_in_need",
    label: "pin_wash",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 90,
    overrideDivisor: 3,
  },
  {
    path: "needs_and_funding.protection.people_in_need",
    label: "pin_protection",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 90,
    overrideDivisor: 3,
  },
  {
    path: "needs_and_funding.health.people_in_need",
    label: "pin_health",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 90,
    overrideDivisor: 3,
  },
  {
    path: "needs_and_funding.food_security.people_in_need",
    label: "pin_food_security",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 120,
    overrideDivisor: 2,
  },
  {
    path: "needs_and_funding.education.people_in_need",
    label: "pin_education",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 90,
    overrideDivisor: 3,
  },

  // ── Overall funding totals ───────────────────────────────────
  {
    path: "needs_and_funding.overall_pin",
    label: "overall_pin",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "underreport",
    validityWindowDays: 90,
    overrideDivisor: 3,
  },
  {
    // Population Affected — widest circle of crisis impact. Max, not
    // latest: the largest evidenced affected figure across the window is the
    // best estimate of total reach; a later, narrower report shouldn't shrink
    // it. Within a report take the max figure, then latest across reports
    // (clear-context-pipeline ADR-0001). Never sourced from `events`. Widest-
    // reach claims skew high → overreport; the bottom quartile by data quality
    // is dropped before the max so one weak outlier can't set the ceiling.
    path: "needs_and_funding.overall_affected",
    label: "overall_affected",
    kind: "max",
    timeBucket: "month",
    withinGroupPolicy: "max_within_report_then_latest",
    qualityBias: "overreport",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },
  {
    path: "needs_and_funding.overall_funding_required_usd",
    label: "funding_required_usd",
    kind: "latest_state",
    timeBucket: "month",
    withinGroupPolicy: "latest_wins",
    qualityBias: "neutral",
    validityWindowDays: 30,
    overrideDivisor: 3,
  },
  {
    // Summed like the other counts → dedup per reporting week. (A `month`/
    // period bucket would merge distinct weekly reports and undercount an
    // additive total; see the header note on period-range overlap.)
    path: "needs_and_funding.overall_funding_received_usd",
    label: "funding_received_usd",
    kind: "additive_count",
    timeBucket: "week",
    withinGroupPolicy: "latest_wins_with_confidence_override",
    qualityBias: "neutral",
    validityWindowDays: 30,
    overrideDivisor: 3,
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
  /** The report's publisher source (`report_datapoints.sourceId`) — the
   *  reliability fallback for any figure that cites no distinct source. */
  sourceId: string | null;
}

/** What one aggregated numeric field looks like on the output. */
export interface QualityEnvelope {
  value: number;
  unit: string | null;
  /** Confidence-only (Directness) view, retained per clear-context-pipeline ADR-0005 — mean of the
   *  winners' CONFIDENCE_WEIGHTS. The headline is now `data_quality`, which the
   *  resolver finalises at read time from `reliability` + `intrinsic_credibility`
   *  + a live Recency score. */
  quality_score: number;
  /** Mean source-reliability grade (1–4) over the winning figures. */
  reliability: number;
  /** Mean time-invariant information credibility (0–8.5) over the winners.
   *  The resolver adds read-time Recency (≤1.5) → 0–10 information_credibility,
   *  then `data_quality = ((reliability × 2.5) × information_credibility) / 10`. */
  intrinsic_credibility: number;
  /** Distribution of confidence tiers as proportions summing to 1. */
  confidence_mix: Record<ConfidenceTier, number>;
  newest_report_at: string;
  oldest_report_at: string;
  contributing_report_ids: string[];
  /** Figures deduped away as within-group losers (0 when nothing collapsed).
   *  Surfaces the otherwise-silent suppression the week bucket makes routine —
   *  a spike here flags reports whose values didn't reach the aggregate. */
  suppressed_count: number;
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
          ((target.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) /
            7,
        );
      return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
      return iso.slice(0, 7); // YYYY-MM
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
  /** Source-reliability grade (1–4) of this figure's source (its cited
   *  `source_id`, else the report's publisher), null-graded → 1. */
  reliability: number;
  /** Time-invariant information credibility (0–8.5): directness + the six
   *  document-level criteria. Recency is added at read time. */
  intrinsicCredibility: number;
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
function canonicaliseEventTypes(raw: unknown, onMalformed?: (kind: string) => void): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : null;
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
function extractNumericMentions(
  row: ReportRow,
  rule: FieldRule,
  reliabilityBySource: Map<string, number | null>,
): Mention[] {
  const raw = dig(row.data, rule.path);
  if (!raw || typeof raw !== "object") return [];
  const nf = raw as {
    value?: number;
    unit?: string;
    confidence?: string;
    scope_location_id?: unknown;
    source_id?: unknown;
    credibility?: unknown;
  };
  const value = Number(nf.value);
  if (!Number.isFinite(value)) return [];

  // The figure's scope. No scope → unattributed → excluded from every
  // bucket (never rolled up).
  const scopeLocationId =
    typeof nf.scope_location_id === "string" && nf.scope_location_id ? nf.scope_location_id : null;
  if (!scopeLocationId) return [];

  // Incident date defaults to reportingPeriodEnd (the CONTENT date),
  // falling back to publishedAt. This is the input to bucketDate.
  const incidentDate = row.reportingPeriodEnd ?? row.publishedAt;
  const unit = typeof nf.unit === "string" ? nf.unit : null;
  const confidence = normaliseConfidence(nf.confidence);
  // Report-level: every mention this report emits carries the same set.
  const eventKey = eventKeyFor(row);

  // Source reliability: the figure's own cited source (`source_id`), else the
  // report's publisher; ungraded/unknown → 1 (clear-context-pipeline ADR-0004/0005).
  const figureSourceId =
    typeof nf.source_id === "string" && nf.source_id ? nf.source_id : null;
  const reliability = reliabilityOf(figureSourceId ?? row.sourceId, reliabilityBySource);
  // Time-invariant credibility: directness (this figure's confidence) + the six
  // criteria resolved per-figure-then-document — the figure's own `credibility`
  // overrides where present, else the report's document-level assessment.
  const docCredibility = dig(row.data, "narrative_and_confidence.information_credibility");
  const intrinsicCredibility = intrinsicCredibilityOf(confidence, docCredibility, nf.credibility);

  return [
    {
      reportId: row.reportId,
      publishedAt: row.publishedAt,
      incidentDate,
      locationId: scopeLocationId,
      value,
      unit,
      confidence,
      reliability,
      intrinsicCredibility,
      eventKey,
    },
  ];
}

// ────────────────────────────────────────────────────────────────────
// Per-field aggregation
// ────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Meaningfully higher" data-quality margin `D` (clear-context-pipeline ADR-0005 §4). A figure must
 *  exceed the freshest by at least this on the `selectionQuality` scale to
 *  override it; within `D` the figures are comparable and bias decides.
 *
 *  Calibrated for GRADED sources. The verified→unverified directness spread is
 *  `2.0 × (1.0 − 0.1) = 1.8` intrinsic points → `1.8 × reliability × 2.5/10` on
 *  the selection scale: 1.35 at reliability 3 (clears D), 0.45 at reliability 1
 *  (does not). Since the seed grades the humanitarian sources at 3 (see
 *  scripts/seed-source-reliability.ts), a verified figure correctly overrides an
 *  unverified one in steady state. Figures whose `source_id` is not yet
 *  backfilled resolve to reliability 1 and fall back to freshness+bias until
 *  re-extraction populates the source — intended, not a bug (a lower D would
 *  over-fire the override on trivial gaps once sources are graded). */
const DATA_QUALITY_MARGIN = 1.0;

/** Selection-time data quality (recency-free): `(reliability × 2.5) ×
 *  intrinsic_credibility / 10`. Recency is deliberately excluded here — within
 *  one bucket it barely varies, and freshness is handled separately by the
 *  override-reach gate; recency only shapes the read-time headline (clear-context-pipeline ADR-0005). */
function selectionQuality(m: Mention): number {
  return (m.reliability * 2.5 * m.intrinsicCredibility) / 10;
}

/** Pick among comparable-quality candidates by the field's directional bias
 *  (clear-context-pipeline ADR-0005 §4): `overreport` → the LOWER value (weak figures inflate),
 *  `underreport` → the HIGHER, `neutral` → the freshest. Value ties fall back to
 *  freshest, keeping the result stable and independent of input order. */
function biasWinner(candidates: Mention[], bias: QualityBias): Mention {
  if (bias === "overreport" || bias === "underreport") {
    const prefersHigher = bias === "underreport";
    return candidates.reduce((best, m) => {
      if (m.value === best.value) return latestByPublishedAt([best, m]);
      const takeM = prefersHigher ? m.value > best.value : m.value < best.value;
      return takeM ? m : best;
    });
  }
  return latestByPublishedAt(candidates);
}

/** Freshest mention by `publishedAt`, with a STABLE tie-break so an equal
 *  timestamp doesn't make the winner depend on input ordering (which upstream
 *  DB ordering can silently change). On a tie: higher confidence weight wins,
 *  then the lexically-smaller `reportId`. Matches the design doc's "Highest
 *  publishedAt. Confidence weight breaks ties." */
function latestByPublishedAt(mentions: Mention[]): Mention {
  return mentions.reduce((best, m) => {
    const dt = m.publishedAt.getTime() - best.publishedAt.getTime();
    if (dt > 0) return m;
    if (dt < 0) return best;
    const dw = CONFIDENCE_WEIGHTS[m.confidence] - CONFIDENCE_WEIGHTS[best.confidence];
    if (dw > 0) return m;
    if (dw < 0) return best;
    return m.reportId < best.reportId ? m : best;
  });
}

/** Winner picker inside an incident group. Dispatches on the field's
 *  within-group policy; the `rule` also carries the bias + override reach the
 *  bias-aware policy needs. Called with no rule (plain latest-wins) for the
 *  cross-group `latest_state` combine. */
function pickWinner(mentions: Mention[], rule?: FieldRule): Mention {
  const policy = rule?.withinGroupPolicy ?? "latest_wins";

  if (policy === "max_within_report_then_latest") {
    // Collapse each report to the largest figure it states (a report may
    // list several affected figures; the widest is the report's claim),
    // then across competing reports in this incident group take the latest.
    const maxByReport = new Map<string, Mention>();
    for (const m of mentions) {
      const cur = maxByReport.get(m.reportId);
      if (cur === undefined || m.value > cur.value) maxByReport.set(m.reportId, m);
    }
    return latestByPublishedAt(Array.from(maxByReport.values()));
  }

  const latest = latestByPublishedAt(mentions);

  if (policy === "latest_wins_with_confidence_override") {
    // Bias-aware override (clear-context-pipeline ADR-0005 §4, generalises the old 3-day verified
    // override): the freshest row wins UNLESS another row within the override
    // reach has meaningfully higher data quality. Among the top quality tier
    // (everything within D of the best), the directional bias breaks the tie.
    const gateMs =
      rule?.validityWindowDays != null
        ? (rule.validityWindowDays / (rule.overrideDivisor ?? 1)) * DAY_MS
        : Infinity;
    // Only figures recent enough to be relevant may contest the freshest — the
    // freshest itself always qualifies (gap 0).
    const recent = mentions.filter(
      (m) => latest.publishedAt.getTime() - m.publishedAt.getTime() <= gateMs,
    );
    const maxQ = Math.max(...recent.map(selectionQuality));
    const topTier = recent.filter((m) => selectionQuality(m) >= maxQ - DATA_QUALITY_MARGIN);
    return biasWinner(topTier, rule?.qualityBias ?? "neutral");
  }

  if (policy === "latest_wins" || policy === "set_union_all") return latest;

  // Exhaustiveness: a newly-added WithinGroupPolicy must be handled explicitly
  // rather than silently defaulting to latest_wins — for figures this moves, a
  // wrong-but-plausible number is worse than a build failure.
  const _exhaustive: never = policy;
  void _exhaustive;
  return latest;
}

/** `qualityScore` is weighted over the WINNERS — the rows whose values actually
 *  reached the figure. `confidenceMix` is the distribution over ALL considered
 *  rows (winners + deduped losers), so a suppressed lower-tier figure still
 *  shows for transparency. */
function computeQuality(
  winners: Mention[],
  considered: Mention[],
): {
  qualityScore: number;
  confidenceMix: Record<ConfidenceTier, number>;
} {
  const qualityScore =
    winners.reduce((sum, m) => sum + CONFIDENCE_WEIGHTS[m.confidence], 0) /
    Math.max(winners.length, 1);
  const counts: Record<ConfidenceTier, number> = {
    verified: 0,
    reported: 0,
    estimated: 0,
    media: 0,
    unverified: 0,
  };
  for (const m of considered) counts[m.confidence] += 1;
  const total = considered.length;
  const confidenceMix = Object.fromEntries(
    (Object.keys(counts) as ConfidenceTier[]).map((k) => [k, total === 0 ? 0 : counts[k] / total]),
  ) as Record<ConfidenceTier, number>;
  return { qualityScore, confidenceMix };
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
  reliabilityBySource: Map<string, number | null>,
): QualityEnvelope | null {
  const mentions: Mention[] = rows.flatMap((r) =>
    extractNumericMentions(r, rule, reliabilityBySource),
  );

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
    winners.push(pickWinner(group, rule));
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
    case "max": {
      // Drop the bottom quartile of winners by data quality before taking the
      // max, so a single low-quality outlier can't set the ceiling (clear-context-pipeline ADR-0005
      // §4). Under 4 winners nothing is dropped; `kept` is always non-empty.
      const ranked = [...winners].sort((a, b) => selectionQuality(a) - selectionQuality(b));
      const kept = ranked.slice(Math.floor(ranked.length / 4));
      value = Math.max(...kept.map((w) => w.value));
      break;
    }
    default:
      // Non-numeric kinds shouldn't hit this function.
      return null;
  }

  // Provenance covers EVERY report that fed the figure — winners AND the
  // deduped losers — per §6.4.5(A)/(B) and PRD #268 ("every report contributing
  // to a figure appears in contributing_report_ids"). quality_score stays
  // winner-weighted; confidence_mix, the freshness bounds, and
  // contributing_report_ids span the full considered set so a suppressed figure
  // still leaves a trace, and `newest_report_at` no longer regresses when the
  // override picks a non-freshest winner.
  const { qualityScore, confidenceMix } = computeQuality(winners, scoped);
  const contributing = Array.from(new Set(scoped.map((m) => m.reportId)));
  const publishedAts = scoped.map((m) => m.publishedAt.getTime());
  const unit = winners.find((w) => w.unit)?.unit ?? null;
  // Representative reliability + intrinsic credibility for the aggregate: mean
  // over the winners (the figures whose values reached the number), mirroring
  // how quality_score is winner-weighted. The resolver folds in read-time
  // Recency and forms the headline data_quality from these two.
  const meanReliability = winners.reduce((s, w) => s + w.reliability, 0) / winners.length;
  const meanIntrinsicCred =
    winners.reduce((s, w) => s + w.intrinsicCredibility, 0) / winners.length;
  return {
    value,
    unit,
    quality_score: Number(qualityScore.toFixed(4)),
    reliability: Number(meanReliability.toFixed(4)),
    intrinsic_credibility: Number(meanIntrinsicCred.toFixed(4)),
    confidence_mix: confidenceMix,
    newest_report_at: new Date(Math.max(...publishedAts)).toISOString(),
    oldest_report_at: new Date(Math.min(...publishedAts)).toISOString(),
    contributing_report_ids: contributing,
    suppressed_count: scoped.length - winners.length,
  };
}

/** Aggregate a set-union label field (event_types, active_clusters).
 *  The path yields an array of strings; we union across all
 *  contributing reports. */
function aggregateSetUnionField(rows: ReportRow[], rule: FieldRule): SetUnionEnvelope | null {
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
        ? raw
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
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
  reliabilityBySource: Map<string, number | null> = new Map(),
): AggregationResult | null {
  if (rows.length === 0) return null;

  const data: Record<string, AggregatedField> = {};
  for (const rule of FIELD_RULES) {
    if (rule.kind === "set_union") {
      data[rule.label] = aggregateSetUnionField(rows, rule);
    } else if (rule.kind !== "non_aggregatable") {
      data[rule.label] = aggregateNumericField(rows, rule, locationScope, reliabilityBySource);
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
  const dataQualityScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return {
    data,
    contributingReportIds: rows.map((r) => r.reportId),
    newestSourceAt,
    oldestSourceAt,
    dataQualityScore: Number(dataQualityScore.toFixed(4)),
    reportCount: rows.length,
  };
}

// ────────────────────────────────────────────────────────────────────
// Read-time quality finalisation (clear-context-pipeline ADR-0005 §2)
// ────────────────────────────────────────────────────────────────────

/** Weight of the Recency criterion in the 0–10 information_credibility score
 *  (the seventh criterion; the other 6 + directness are the cached 0–8.5
 *  `intrinsic_credibility`). */
const RECENCY_WEIGHT = 1.5;

/** Read-time Recency score (0–1.5): full weight when the newest contributing
 *  report is within the field's validity window, half within 2×, else 0. A
 *  field with no window (labels) scores neutral (half). Rewards freshly
 *  *published* figures without penalising old *content* (content is bucketed by
 *  period), and — computed live — never silently decays in the cache. */
function recencyScore(newestReportAt: Date, asOf: Date, validityWindowDays?: number): number {
  if (!validityWindowDays) return RECENCY_WEIGHT * 0.5;
  const ageDays = (asOf.getTime() - newestReportAt.getTime()) / DAY_MS;
  if (ageDays <= validityWindowDays) return RECENCY_WEIGHT;
  if (ageDays <= 2 * validityWindowDays) return RECENCY_WEIGHT * 0.5;
  return 0;
}

/** Finalise the headline `data_quality` for every numeric field on an
 *  aggregated `data` blob, folding in read-time Recency (clear-context-pipeline ADR-0005 §2). The
 *  cache stores only the time-invariant parts (`reliability`,
 *  `intrinsic_credibility`, `newest_report_at`); this runs on every read so the
 *  score reflects freshness at `asOf` and never decays in place. Returns a new
 *  blob with `recency` / `information_credibility` / `data_quality` added per
 *  field, plus the bucket-level mean `data_quality`. Non-numeric fields
 *  (set-union, null) pass through untouched. */
export function finaliseReadTimeQuality(
  data: Record<string, unknown>,
  asOf: Date,
): { data: Record<string, unknown>; dataQualityScore: number; finalisedFieldCount: number } {
  const windowByLabel = new Map(FIELD_RULES.map((r) => [r.label, r.validityWindowDays]));
  const out: Record<string, unknown> = {};
  const scores: number[] = [];
  for (const [label, field] of Object.entries(data)) {
    if (!field || typeof field !== "object" || !("intrinsic_credibility" in field)) {
      out[label] = field; // set-union / null — nothing to finalise
      continue;
    }
    const f = field as Record<string, unknown>;
    const reliability = typeof f.reliability === "number" ? f.reliability : 1;
    const intrinsic = typeof f.intrinsic_credibility === "number" ? f.intrinsic_credibility : 0;
    const newestAt =
      typeof f.newest_report_at === "string" ? new Date(f.newest_report_at) : asOf;
    const recency = recencyScore(newestAt, asOf, windowByLabel.get(label));
    const informationCredibility = intrinsic + recency; // 0–10
    const dataQuality = (reliability * 2.5 * informationCredibility) / 10; // 0–10
    out[label] = {
      ...f,
      recency: Number(recency.toFixed(4)),
      information_credibility: Number(informationCredibility.toFixed(4)),
      data_quality: Number(dataQuality.toFixed(4)),
    };
    scores.push(dataQuality);
  }
  const dataQualityScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  // `finalisedFieldCount` lets callers distinguish "every field scored 0" from
  // "no field carried the credibility envelope to score" (a legacy/pre-v2 cache
  // row). The cache-hit path uses it to avoid overwriting a stored score with a
  // spurious 0 — see datapoint.resolver.ts.
  return {
    data: out,
    dataQualityScore: Number(dataQualityScore.toFixed(4)),
    finalisedFieldCount: scores.length,
  };
}
