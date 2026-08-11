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
  /** Confidence band around the headline. `value` stays the point estimate;
   *  `[value_low, value_high]` is the honest error bar, derived from the
   *  contributing figures' own reported ranges and their disagreement with each
   *  other. Equal to `value` when every contributor is an exact point that
   *  agrees. (Interval-and-range model, clear-context-pipeline ADR-0007.) */
  value_low: number;
  value_high: number;
  /** `value_high − value_low` — a first-class uncertainty signal beside
   *  `data_quality` (a wide band = noisy/disagreeing evidence). */
  range_width: number;
  /** The field's systematic quality-bias direction (clear-context-pipeline ADR-0005 §3 / ADR-0007 §8),
   *  surfaced so the consumer can PROJECT the [value_low, value_high] band to a
   *  single headline at the display edge: `overreport` → the low end
   *  (conservative against inflation), `underreport` → the high end, `neutral` →
   *  the midpoint. The aggregate stays lossless here; the projection is the
   *  consumer's choice (design §8 "project late"). Null on fields with no bias. */
  bias: QualityBias | null;
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
  /** ADR-0006 §7 early-warning signal: set when a report figure diverged from the
   *  authoritative API figure by more than the threshold (so the API figure won).
   *  Surfaces the disagreement — a possible emerging event or extraction error —
   *  even though the aggregate uses the API value. Null/absent when in agreement
   *  or when there is no API contributor. */
  divergence?: {
    reportValue: number;
    apiValue: number;
    /** Signed % difference of the report vs the API figure. */
    pctDiff: number;
  } | null;
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
  /** The magnitude RANGE this figure reports. Equal to `value` for an exact
   *  count; a real band for a stated range ("between 500 and 700"), an
   *  approximation ("around 600"), or a one-sided figure ("at least 500", where
   *  the extractor also supplies a plausible finite other end). The aggregator
   *  uses these to (a) publish an honest confidence band on the result and
   *  (b) combine overlapping figures in range-space instead of collapsing to a
   *  single number too early. */
  valueLow: number;
  valueHigh: number;
  /** How the source bounded THIS number: "exact" (a precise count), "at_least"
   *  (a firm floor — the truth is ≥ value), "at_most" (a firm ceiling — ≤ value),
   *  or "approx" (symmetric vagueness around value). Per-figure evidence of
   *  reporting bias, distinct from the field-wide `qualityBias` prior on the
   *  FieldRule. ROUTED (`biasWinner`): a hard directional CONSTRAINT on bias
   *  projection — an `at_least` floor may not be projected below, an `at_most`
   *  ceiling not above, whatever the field bias; the bias only breaks the tie
   *  within what the qualifier leaves. `approx`/`exact` add no constraint. */
  qualifier: string;
  /** What the number measures over time: "stock_as_of" a point-in-time total
   *  ("currently displaced"), "period_flow" a quantity accrued during a period
   *  ("newly displaced this week"), "cumulative_to_date" a running total since an
   *  origin, or null when the extractor couldn't tell. Stops a running total being
   *  read as a period increment — the classic mis-aggregation. ROUTED for the
   *  additive combine (`reconcileCumulativesToFlows`): `stock_as_of` /
   *  `cumulative_to_date` figures are first-differenced into the increments they
   *  imply and reconciled with reported flows, never summed as flows. It does NOT
   *  change the field-level combine strategy — `FieldRule.kind` still owns sum vs
   *  latest vs max vs union; measure_type only refines stock-vs-flow within it. */
  measureType: string | null;
  /** The time period this figure describes — its own stated period when the
   *  text gives one, else the report's overall reporting period. A point
   *  (start === end) for a stock. When start < end the figure is a flow spread
   *  over the interval, which is what lets overlapping-period figures be
   *  reconciled (rather than double-counted) and split across bucket
   *  boundaries. */
  basisPeriodStart: Date | null;
  basisPeriodEnd: Date | null;
  unit: string | null;
  confidence: ConfidenceTier;
  /** Source-reliability grade (1–4) of this figure's source (its cited
   *  `source_id`, else the report's publisher), null-graded → 1. */
  reliability: number;
  /** Time-invariant information credibility (0–8.5): directness + the six
   *  document-level criteria. Recency is added at read time. */
  intrinsicCredibility: number;
  /** Effective source id (the figure's cited `source_id`, else the report's
   *  publisher; the API source for a location_metadata contributor). Drives the
   *  ADR-0006 §5 echo-dedup: a report figure citing the same source as an API
   *  contributor is one observation, not two. Null when uncited/unpublished. */
  sourceId: string | null;
  /** True for an authoritative `location_metadata` contributor (ADR-0006). Used
   *  by the divergence guard (§7) to distinguish API from report figures. */
  isApi: boolean;
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
    value_low?: unknown;
    value_high?: unknown;
    qualifier?: unknown;
    measure_type?: unknown;
    basis_period_start?: unknown;
    basis_period_end?: unknown;
    unit?: string;
    confidence?: string;
    scope_location_id?: unknown;
    source_id?: unknown;
    credibility?: unknown;
  };
  const value = Number(nf.value);
  if (!Number.isFinite(value)) return [];

  // Interval-and-range fields (clear-context-pipeline ADR-0007, schema v3). A
  // pre-v3 figure carries only `value`, and the two fallbacks differ:
  //  - the value RANGE collapses to the point (valueLow = valueHigh = value), so
  //    a v2 figure has a zero-width band and reads exactly as before; but
  //  - the basis PERIOD (below) falls back to the REPORT's reporting period, not
  //    to a point. So a v2 figure whose report states a multi-day reporting period
  //    is treated as a flow over that period and enters the breakpoint sweep. A
  //    lone such figure integrates back to its own value (no change); only where
  //    v2 figures OVERLAP does the number move — from the old double-count to a
  //    reconciled total (the same §6.2 fix, now also covering v2 data). So this is
  //    not a pure no-op on v2 aggregates: it corrects overlaps rather than
  //    preserving them.
  const lowRaw = Number(nf.value_low);
  const highRaw = Number(nf.value_high);
  let valueLow = Number.isFinite(lowRaw) ? lowRaw : value;
  let valueHigh = Number.isFinite(highRaw) ? highRaw : value;
  if (valueLow > valueHigh) [valueLow, valueHigh] = [valueHigh, valueLow];
  const qualifier = typeof nf.qualifier === "string" ? nf.qualifier : "exact";
  const measureType = typeof nf.measure_type === "string" ? nf.measure_type : null;
  // Figure-stated basis period, else the report's reporting period.
  const basisPeriodStart = parseDate(nf.basis_period_start) ?? row.reportingPeriodStart;
  const basisPeriodEnd =
    parseDate(nf.basis_period_end) ?? row.reportingPeriodEnd ?? row.publishedAt;

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
      valueLow,
      valueHigh,
      qualifier,
      measureType,
      basisPeriodStart,
      basisPeriodEnd,
      unit,
      confidence,
      reliability,
      intrinsicCredibility,
      sourceId: figureSourceId ?? row.sourceId ?? null,
      isApi: false,
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
 *  freshest, keeping the result stable and independent of input order.
 *
 *  Per-figure QUALIFIER as a hard directional constraint (clear-context-pipeline ADR-0007). The
 *  `qualifier` is a different axis from the field `qualityBias`: it is what the
 *  SOURCE asserted about THIS figure's own bound, and it can point the opposite
 *  way from the field's systematic-skew prior. So they COMPOSE rather than one
 *  replacing the other — the qualifier constrains, the bias breaks the tie within
 *  what the constraint leaves:
 *    - an `at_least` figure asserts a firm FLOOR (truth ≥ its value), so an
 *      overreport (lean-low) headline may not be projected BELOW that floor — the
 *      strongest asserted floor wins if it binds harder than the lean-low pick;
 *    - an `at_most` figure asserts a firm CEILING (truth ≤ its value), so an
 *      underreport (lean-high) headline may not exceed it — the strongest ceiling
 *      wins if it binds.
 *  `approx` / `exact` assert no firm bound and leave the bias pick unchanged, so
 *  a corpus of exact figures behaves exactly as before. */
function biasWinner(candidates: Mention[], bias: QualityBias): Mention {
  if (bias !== "overreport" && bias !== "underreport") {
    return latestByPublishedAt(candidates);
  }
  const prefersHigher = bias === "underreport";
  const base = candidates.reduce((best, m) => {
    if (m.value === best.value) return latestByPublishedAt([best, m]);
    const takeM = prefersHigher ? m.value > best.value : m.value < best.value;
    return takeM ? m : best;
  });
  if (!prefersHigher) {
    // overreport → don't project below any figure's asserted `at_least` floor;
    // the strongest (highest) floor binds.
    const floor = candidates
      .filter((m) => m.qualifier === "at_least")
      .reduce<Mention | null>((hi, m) => (hi === null || m.value > hi.value ? m : hi), null);
    if (floor !== null && floor.value > base.value) return floor;
  } else {
    // underreport → don't project above any figure's asserted `at_most` ceiling;
    // the strongest (lowest) ceiling binds.
    const ceil = candidates
      .filter((m) => m.qualifier === "at_most")
      .reduce<Mention | null>((lo, m) => (lo === null || m.value < lo.value ? m : lo), null);
    if (ceil !== null && ceil.value < base.value) return ceil;
  }
  return base;
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

/** "Latest underlying data" (ADR-0006 §5): newer incident/reference date wins,
 *  then newer publication, then the lexically-smaller reportId for stability. */
function isFresherMention(a: Mention, b: Mention): boolean {
  const di = a.incidentDate.getTime() - b.incidentDate.getTime();
  if (di !== 0) return di > 0;
  const dp = a.publishedAt.getTime() - b.publishedAt.getTime();
  if (dp !== 0) return dp > 0;
  return a.reportId < b.reportId;
}

/** Echo dedup (ADR-0006 §5). The echo §5 targets is a report figure that cites
 *  the SAME source as an authoritative API contributor — the same observation
 *  reaching us twice (once via the API, once quoted in a report). Collapse each
 *  such group to its latest so the echo can't sum alongside the API figure on
 *  additive fields.
 *
 *  Crucially, a group of same-source REPORT figures with NO API member is left
 *  intact: one publisher's weekly sitrep routinely reports different phenomena
 *  in the same bucket (e.g. `killed` from a flood AND from a conflict), which the
 *  incident grouping must SUM per `eventKey`, not collapse. Keying the collapse
 *  on `(location, bucket, sourceId)` alone silently undercounts every additive
 *  field, so it is scoped to groups that actually contain an API figure to echo.
 *  Uncited figures (null source) pass through untouched. */
function collapseSourceEchoes(mentions: Mention[], bucket: TimeBucket): Mention[] {
  const SEP = "\u0000";
  const groups = new Map<string, Mention[]>();
  const passthrough: Mention[] = [];
  for (const m of mentions) {
    if (!m.sourceId) {
      passthrough.push(m);
      continue;
    }
    const key = `${m.locationId}${SEP}${bucketDate(m.incidentDate, bucket)}${SEP}${m.sourceId}`;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }
  const out = [...passthrough];
  for (const g of groups.values()) {
    if (g.length > 1 && g.some((m) => m.isApi)) {
      // Report echo(es) of an API figure — one observation, keep the latest.
      out.push(g.reduce((best, m) => (isFresherMention(m, best) ? m : best)));
    } else {
      // No API figure to echo — distinct report figures (possibly different
      // event types); the incident grouping dedups them per eventKey.
      out.push(...g);
    }
  }
  return out;
}

/** Start of the bucket containing `dt` (UTC): midnight for a day, the Monday for
 *  an ISO week, the 1st for a month — the boundary the flow sweep partitions on. */
function bucketStart(dt: Date, bucket: TimeBucket): Date {
  const d = new Date(dt);
  d.setUTCHours(0, 0, 0, 0);
  if (bucket === "week") {
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
    return d;
  }
  if (bucket === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return d;
}

/** The next bucket boundary after the bucket containing `dt`. */
function nextBucketStart(dt: Date, bucket: TimeBucket): Date {
  const s = bucketStart(dt, bucket);
  if (bucket === "week") return new Date(s.getTime() + 7 * DAY_MS);
  if (bucket === "month") return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
  return new Date(s.getTime() + DAY_MS);
}

/** True when a figure describes a genuine time INTERVAL (≥ ~1 day) and so feeds
 *  the flow rate sweep; a same-day / point figure (no known start) does not. */
function hasFlowInterval(f: Mention): boolean {
  return (
    f.basisPeriodStart != null &&
    f.basisPeriodEnd != null &&
    f.basisPeriodEnd.getTime() - f.basisPeriodStart.getTime() >= DAY_MS
  );
}

/** True when a figure is a snapshot / running-total rather than a period
 *  increment (clear-context-pipeline ADR-0007 measure_type): `stock_as_of` (a point-in-time
 *  total) or `cumulative_to_date` (a running total since an origin). Such a
 *  figure must be pulled OUT of the flow sweep — integrating a total as if it
 *  were a per-period rate fabricates a bogus daily flow. Only the two EXPLICIT
 *  measure types are pulled; a null / `period_flow` / unlabeled figure keeps the
 *  ordinary flow handling (safe for the mixed / pre-v3 corpus). `measure_type`
 *  does NOT change the field-level combine strategy (`kind` still owns sum vs
 *  latest vs max) — it only refines stock-vs-flow WITHIN an additive field. */
function isPeriodTotal(f: Mention): boolean {
  return f.measureType === "stock_as_of" || f.measureType === "cumulative_to_date";
}

/** As-of date of a running-total snapshot: its stated period end, else its
 *  incident date. */
function asOfTime(m: Mention): number {
  return (m.basisPeriodEnd ?? m.incidentDate).getTime();
}

/** Reconcile cumulative / stock (as-of running-total) figures against reported
 *  period flows into ONE coherent set of period-flow increments (clear-context-pipeline ADR-0007).
 *
 *  A `cumulative_to_date` / `stock_as_of` is a running total to its as-of date,
 *  NOT a period increment — summing two snapshots, or a snapshot alongside the
 *  flows it already contains, double-counts. So:
 *   1. Sort the snapshots by as-of and FIRST-DIFFERENCE them: consecutive
 *      snapshots imply the increment between them (`Cᵢ − Cᵢ₋₁`, clamped ≥ 0, its
 *      band the difference of their bands); the earliest snapshot is the total
 *      over `[its origin, its as-of]` (a point at the as-of when no origin is
 *      stated). Each becomes a synthetic `period_flow` over that sub-interval.
 *   2. The snapshots' union `[earliest origin … latest as-of]` is their coverage.
 *      Reported flows falling INSIDE it are already subsumed by the running total
 *      → dropped; flows entirely OUTSIDE it (before the origin or after the last
 *      as-of) are kept and extend the series.
 *  The result is fed to the breakpoint sweep like any other flows, so a cumulative
 *  is integrated over exactly its own span and never added on top of the flows it
 *  already contains. When the cumulative undershoots the reported flows (bad data)
 *  we drop the flows and keep the total — an undercount is recoverable, a
 *  double-count is not. */
function reconcileCumulativesToFlows(
  cumulatives: Mention[],
  reportedFlows: Mention[],
): Mention[] {
  if (cumulatives.length === 0) return reportedFlows;
  const snaps = [...cumulatives].sort((a, b) => asOfTime(a) - asOfTime(b));
  const derived: Mention[] = [];
  let covStart = Infinity;
  let covEnd = -Infinity;
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i]!;
    const t = asOfTime(cur);
    const prev = i > 0 ? snaps[i - 1]! : null;
    let start: number;
    let value: number;
    let low: number;
    let high: number;
    if (prev) {
      // Increment between consecutive running totals — a flow over (t_prev, t].
      start = asOfTime(prev);
      value = Math.max(0, cur.value - prev.value);
      low = Math.max(0, cur.valueLow - prev.valueHigh);
      high = Math.max(0, cur.valueHigh - prev.valueLow);
    } else {
      // Earliest snapshot: the whole total over [stated origin, as-of], or a
      // point at the as-of when the running total names no origin.
      start = cur.basisPeriodStart ? cur.basisPeriodStart.getTime() : t;
      value = cur.value;
      low = cur.valueLow;
      high = cur.valueHigh;
    }
    covStart = Math.min(covStart, start);
    covEnd = Math.max(covEnd, t);
    derived.push({
      ...cur,
      value,
      valueLow: low,
      valueHigh: high,
      basisPeriodStart: new Date(start),
      basisPeriodEnd: new Date(t),
      incidentDate: new Date(t),
      measureType: "period_flow", // now an increment, so the sweep integrates it
    });
  }
  // Keep only reported flows that lie ENTIRELY outside the cumulative coverage;
  // those inside are already accounted for by the differenced totals.
  const kept = reportedFlows.filter((f) => {
    const fe = (f.basisPeriodEnd ?? f.incidentDate).getTime();
    const fs = (f.basisPeriodStart ?? f.incidentDate).getTime();
    return fe <= covStart || fs >= covEnd;
  });
  return [...derived, ...kept];
}

interface Contrib {
  value: number;
  low: number;
  high: number;
}

/** The headline daily rate for a flow sub-interval covered by several figures
 *  (clear-context-pipeline ADR-0007 §8 bias-as-projection). Mirrors `pickWinner`'s confidence-override
 *  tie-break — top data-quality tier, then `qualityBias` direction — but WITHOUT
 *  the freshness gate, because on a flow overlap every covering figure measures
 *  the same elapsed days, so recency must not decide (that gate is what let a
 *  weekly cadence silently take the freshest rate instead of the bias-selected
 *  one). Data-quality override still holds: an authoritative figure outside the
 *  bias direction still governs the point. Other within-group policies keep their
 *  ordinary `pickWinner` point — only the bias-aware additive policy overlaps. */
function reconcileRatePoint(rates: Mention[], rule: FieldRule): number {
  if ((rule.withinGroupPolicy ?? "latest_wins") === "latest_wins_with_confidence_override") {
    const maxQ = Math.max(...rates.map(selectionQuality));
    const topTier = rates.filter((m) => selectionQuality(m) >= maxQ - DATA_QUALITY_MARGIN);
    return biasWinner(topTier, rule.qualityBias ?? "neutral").value;
  }
  return pickWinner(rates, rule).value;
}

/** Breakpoint-partition flow sweep (clear-context-pipeline ADR-0007 §6.2) — fixes overlapping periods
 *  (#2) and bucket-boundary spanning (#3) together, for ONE event-group. When
 *  the group has any real-interval figure, EVERY figure in the group is treated
 *  as an interval (a point as its single day); the timeline is cut at every
 *  figure edge AND bucket boundary; and on each atomic sub-interval the covering
 *  figures' daily RATE-ranges are reconciled into ONE rate-range (see
 *  `reconcileRatePoint`), integrated over the sub-interval, and added to the
 *  bucket that contains it. So an overlap reconciles instead of summing, and a
 *  period straddling two buckets splits by rate.
 *
 *  Reconciliation carries a RANGE, it does not pick a single winner (clear-context-pipeline ADR-0007
 *  §6.2 + §8): on an overlap both figures genuinely measure the same elapsed
 *  days, so the band is the UNION of their daily rate-ranges (min low … max high)
 *  — their disagreement is real uncertainty, surfaced as width — and the headline
 *  rate is the bias projection onto that band. Crucially recency does NOT gate
 *  the overlap: a later sitrep re-counting the same days is a second observation,
 *  not fresher truth that supersedes the earlier count, so quality/bias decides,
 *  not publish order. Returns null when the group has no interval figure — the
 *  caller then places the point figures directly in their end-date bucket. */
function sweepFlowGroup(
  figures: Mention[],
  rule: FieldRule,
  bucket: TimeBucket,
): Map<string, Contrib> | null {
  if (!figures.some(hasFlowInterval)) return null;
  const spans = figures.map((f) => {
    if (hasFlowInterval(f)) {
      return { fig: f, start: f.basisPeriodStart!.getTime(), end: f.basisPeriodEnd!.getTime() };
    }
    const s = f.incidentDate.getTime(); // a point figure covers its single day
    return { fig: f, start: s, end: s + DAY_MS };
  });
  const minStart = Math.min(...spans.map((s) => s.start));
  const maxEnd = Math.max(...spans.map((s) => s.end));
  const cutSet = new Set<number>([minStart, maxEnd]);
  for (const s of spans) {
    cutSet.add(s.start);
    cutSet.add(s.end);
  }
  for (
    let b = nextBucketStart(new Date(minStart), bucket);
    b.getTime() < maxEnd;
    b = nextBucketStart(b, bucket)
  ) {
    cutSet.add(b.getTime());
  }
  const cuts = [...cutSet].sort((a, z) => a - z);
  const out = new Map<string, Contrib>();
  for (let i = 0; i < cuts.length - 1; i++) {
    const t0 = cuts[i]!;
    const t1 = cuts[i + 1]!;
    const subDays = (t1 - t0) / DAY_MS;
    if (subDays <= 0) continue;
    const covering = spans.filter((s) => s.start <= t0 && s.end >= t1);
    if (covering.length === 0) continue;
    // Each covering figure's DAILY rate-range over its own basis period: clone as
    // a pseudo-mention whose value/low/high ARE per-day rates.
    const rates = covering.map(({ fig, start, end }) => {
      const days = (end - start) / DAY_MS || 1;
      return { ...fig, value: fig.value / days, valueLow: fig.valueLow / days, valueHigh: fig.valueHigh / days };
    });
    // Band = union of the covering rate-ranges (overlap disagreement is real
    // uncertainty, not something to collapse). Point = bias projection onto it,
    // no recency gate (both figures measure these same days). See the header.
    const lowRate = Math.min(...rates.map((r) => r.valueLow));
    const highRate = Math.max(...rates.map((r) => r.valueHigh));
    const pointRate = reconcileRatePoint(rates, rule);
    const key = bucketDate(new Date(t0), bucket);
    const acc = out.get(key) ?? { value: 0, low: 0, high: 0 };
    acc.value += pointRate * subDays;
    acc.low += lowRate * subDays;
    acc.high += highRate * subDays;
    out.set(key, acc);
  }
  return out;
}

/** Additive cross-group combine: the §6.2 flow sweep (overlap/boundary) per
 *  event-group, then §7.3 event-type containment PER BUCKET, then sum across
 *  buckets. Containment: an unqualified (empty event-type) figure is a SUPERSET
 *  of the qualified sub-causes in the same bucket, so that bucket's total is
 *  max(Σ qualified, the widest unqualified) — never the whole ADDED on top of
 *  its own parts ("1M killed" + "100k drone deaths" → 1M, not 1.1M, #4). Max —
 *  not sum — on the unknown relationship: an undercount is recoverable, a silent
 *  double-count is not. Distinct qualified sets are disjoint and sum. Across
 *  buckets we always sum (a monthly total is the sum of its weeks). A point-only
 *  group keeps the simple place-in-bucket behaviour, so nothing regresses for
 *  figures that carry no basis-period interval. Figures tagged as running TOTALS
 *  (`stock_as_of` / `cumulative_to_date`) are first-differenced into the period
 *  increments they imply and reconciled against the reported flows before the
 *  sweep (see `reconcileCumulativesToFlows`), so a running total is integrated
 *  over its own span and never added on top of the flows it already contains.
 *  Returns the point + [low, high]. */
function combineAdditiveWithContainment(
  winners: Mention[],
  rule: FieldRule,
  bucket: TimeBucket,
): Contrib {
  const byEvent = new Map<string, Mention[]>();
  for (const w of winners) {
    const list = byEvent.get(w.eventKey);
    if (list) list.push(w);
    else byEvent.set(w.eventKey, [w]);
  }
  const perGroup = new Map<string, Map<string, Contrib>>();
  for (const [ek, figs] of byEvent) {
    // Reconcile running totals (stock_as_of / cumulative_to_date) against the
    // reported period flows into one coherent flow set — the cumulatives are
    // first-differenced into the increments they imply and the flows they already
    // contain are dropped (see `reconcileCumulativesToFlows`), so nothing is
    // integrated as a rate it isn't, and nothing is added on top of what a running
    // total already counts.
    const flows = reconcileCumulativesToFlows(
      figs.filter(isPeriodTotal),
      figs.filter((f) => !isPeriodTotal(f)),
    );

    // The breakpoint sweep (overlap/boundary), else the simple place-in-bucket
    // sum for a point-only group.
    let m = sweepFlowGroup(flows, rule, bucket);
    if (m === null) {
      m = new Map<string, Contrib>();
      for (const f of flows) {
        const key = bucketDate(f.incidentDate, bucket);
        const acc = m.get(key) ?? { value: 0, low: 0, high: 0 };
        acc.value += f.value;
        acc.low += f.valueLow;
        acc.high += f.valueHigh;
        m.set(key, acc);
      }
    }
    perGroup.set(ek, m);
  }
  const allBuckets = new Set<string>();
  for (const m of perGroup.values()) for (const k of m.keys()) allBuckets.add(k);
  const untyped = perGroup.get("");
  const total: Contrib = { value: 0, low: 0, high: 0 };
  for (const key of allBuckets) {
    let tv = 0;
    let tl = 0;
    let th = 0;
    for (const [ek, m] of perGroup) {
      if (ek === "") continue;
      const c = m.get(key);
      if (c) {
        tv += c.value;
        tl += c.low;
        th += c.high;
      }
    }
    const u = untyped?.get(key);
    if (u) {
      total.value += Math.max(tv, u.value);
      total.low += Math.max(tl, u.low);
      total.high += Math.max(th, u.high);
    } else {
      total.value += tv;
      total.low += tl;
      total.high += th;
    }
  }
  return total;
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
  apiMentions: Mention[] = [],
): QualityEnvelope | null {
  // Authoritative location_metadata figures (ADR-0006) join the report figures
  // as ordinary high-quality mentions and compete under the same selection.
  const mentions: Mention[] = [
    ...rows.flatMap((r) => extractNumericMentions(r, rule, reliabilityBySource)),
    ...apiMentions,
  ];

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

  // Echo dedup (ADR-0006 §5): within a (location, bucket), figures that cite the
  // SAME source — an authoritative API contributor and any report echoes of it —
  // are one observation. Collapse them to the latest BEFORE the incident grouping
  // so an echo can't sum alongside the API figure on additive fields. Provenance
  // (contributing ids, freshness, suppressed_count) below still spans full `scoped`.
  const deduped = collapseSourceEchoes(scoped, bucket);

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
  for (const m of deduped) {
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
  // Set by the additive branch — the containment-aware [low, high] band, reused
  // by the confidence-band block below instead of a naïve Σ of every winner.
  let additiveBand: { low: number; high: number } | null = null;
  switch (rule.kind) {
    case "additive_count": {
      const combined = combineAdditiveWithContainment(winners, rule, bucket);
      value = combined.value;
      additiveBand = { low: combined.low, high: combined.high };
      break;
    }
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

  // Divergence guard (clear-context-pipeline ADR-0006 §7, generalised to ranges by ADR-0007 §9). For a
  // point-in-time field, if the report estimate disagrees with the authoritative
  // API figure the API wins and the gap is surfaced as an early-warning signal.
  //
  // §9 range-overlap test: when the report figures carry a real band, an API
  // anchor INSIDE that band is agreement (it tightens the estimate — no signal);
  // an anchor the band EXCLUDES is the divergence. For all-exact report figures
  // (no stated width) we fall back to the ADR-0006 §7 fixed-percentage tolerance,
  // so exact-figure behaviour is unchanged — this strictly generalises the guard
  // rather than tightening it. Additive fields are protected by echo-dedup (§5).
  let divergence: QualityEnvelope["divergence"] = null;
  if (rule.kind === "latest_state") {
    const apiFigs = scoped.filter((m) => m.isApi);
    const reportFigs = scoped.filter((m) => !m.isApi);
    if (apiFigs.length > 0 && reportFigs.length > 0) {
      const api = latestByPublishedAt(apiFigs);
      const denom = Math.abs(api.value) || 1;
      const reportLow = Math.min(...reportFigs.map((m) => m.valueLow));
      const reportHigh = Math.max(...reportFigs.map((m) => m.valueHigh));
      // "Real band" is a per-FIGURE property (a stated range, `valueHigh >
      // valueLow`), NOT the aggregate spread. Two EXACT figures that merely
      // disagree (40k, 48k) span a wide [reportLow, reportHigh] but neither
      // carries a measurement band — treating that spread as one would swallow a
      // divergent API anchor sitting between them ("inside the band" → no signal,
      // API never wins). Only when some figure genuinely brackets its estimate do
      // we run the containment test; all-exact figures take the §7 % fallback
      // against the headline, so pure disagreement still trips the guard.
      const hasRealBand = reportFigs.some((m) => m.valueHigh > m.valueLow);
      const inConflict = hasRealBand
        ? api.value < reportLow || api.value > reportHigh
        : value !== api.value && Math.abs(value - api.value) / denom > DIVERGENCE_THRESHOLD;
      if (inConflict) {
        divergence = {
          reportValue: value,
          apiValue: api.value,
          pctDiff: Number((((value - api.value) / denom) * 100).toFixed(1)),
        };
        value = api.value; // authoritative figure wins the large disagreement
        // The API figure now supplies the value, so it must also supply the
        // grades: reset the winner set to it so reliability / intrinsic /
        // confidence_mix / unit describe the authoritative figure rather than
        // the report that just lost — otherwise the guard's success case scores
        // the aggregate ~1.2/10 on the loser's credibility. (§7)
        winners.length = 0;
        winners.push(api);
      }
    }
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

  // Publish an honest confidence band around the headline `value`, derived from
  // the contributing figures' own reported ranges plus their disagreement. The
  // band is combined the SAME way the point was, so `value` always lies inside
  // it:
  //  - additive: the band the additive combine produced alongside the point
  //    (flow figures integrated over their intervals, event-type supersets
  //    capped, distinct causes summed) — not a naïve Σ of every figure.
  //  - latest_state / max: the band spans every considered figure's reported
  //    range, so a disagreement (including an API-vs-report gap) shows up as a
  //    wide band rather than being hidden behind a single number.
  //
  // Deferred (clear-context-pipeline ADR-0007 §7.2): for a stock this WIDENS to
  // the union of the figures' ranges (honest, shows disagreement). §7.2's stronger
  // move — INTERSECTING comparable-quality bounds to tighten the estimate, and
  // raising a divergence when two stock ranges don't overlap — is a follow-up, not
  // in this PR. The union never hides disagreement (it can only over-widen), so
  // deferring it is safe; it just doesn't yet tighten from independent bounds.
  let valueLow: number;
  let valueHigh: number;
  if (additiveBand) {
    valueLow = additiveBand.low;
    valueHigh = additiveBand.high;
  } else {
    valueLow = Math.min(...scoped.map((m) => m.valueLow));
    valueHigh = Math.max(...scoped.map((m) => m.valueHigh));
  }
  valueLow = Math.min(valueLow, value);
  valueHigh = Math.max(valueHigh, value);

  return {
    value,
    value_low: Number(valueLow.toFixed(4)),
    value_high: Number(valueHigh.toFixed(4)),
    range_width: Number((valueHigh - valueLow).toFixed(4)),
    bias: rule.qualityBias ?? null,
    unit,
    quality_score: Number(qualityScore.toFixed(4)),
    reliability: Number(meanReliability.toFixed(4)),
    intrinsic_credibility: Number(meanIntrinsicCred.toFixed(4)),
    confidence_mix: confidenceMix,
    newest_report_at: new Date(Math.max(...publishedAts)).toISOString(),
    oldest_report_at: new Date(Math.min(...publishedAts)).toISOString(),
    contributing_report_ids: contributing,
    suppressed_count: scoped.length - winners.length,
    divergence,
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
// Location-metadata reconciliation (clear-context-pipeline ADR-0006)
// ────────────────────────────────────────────────────────────────────
//
// Authoritative `location_metadata` (IOM DTM, OCHA, UNHCR, IPC, …) is read at
// aggregation time and merged in as high-quality contributors — anchoring,
// gap-filling and reconciling the LLM-extracted report figures. Each API figure
// becomes a `Mention` with a deterministic credibility profile (§8) and recency
// keyed on `valid_from` (§9), then competes under the same bias-aware selection.

/** One current `location_metadata` row for a scope location (`validTo IS NULL`). */
export interface LocationMetadataRow {
  /** e.g. "iom_dtm_displacement". */
  type: string;
  /** The source blob (shape is source-specific; adapters below read it). */
  data: unknown;
  /** When this value became current — the recency key (ADR-0006 §9). */
  validFrom: Date;
}

/** A canonical figure an adapter pulls out of a source blob. */
interface ApiFigure {
  /** Aggregate field label it reconciles with (e.g. "idp_stock"). */
  label: string;
  value: number;
  unit: string | null;
  /** T₀ — the figure's own reference/as-of date (round date, period end); the
   *  bucketing + flow-cutoff anchor. Falls back to `valid_from` when absent. */
  referenceDate: Date | null;
  /** Interval-and-range measure type (clear-context-pipeline ADR-0007), when the adapter can state it
   *  (most API figures are `stock_as_of` snapshots). Defaults to null. */
  measureType?: string | null;
}

interface ApiAdapter {
  /** Canonical org name (matches the ADR-0004 §5 reliability seed) → resolves to
   *  the source's `data_sources` reliability. */
  org: string;
  extract: (data: Record<string, unknown>) => ApiFigure[];
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The HAPI blob's `records` array (built by `providers/hapi.py::build_blobs`). */
function hapiRecords(data: Record<string, unknown>): Record<string, unknown>[] {
  const recs = data.records;
  return Array.isArray(recs)
    ? recs.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : [];
}

/** A HAPI record's own reference period end (blob-level fallback). */
function hapiRefDate(data: Record<string, unknown>): Date | null {
  return parseDate(data.reference_period_end);
}

/** True when a HAPI record is the un-disaggregated total (gender/age = "all"),
 *  so summing these never double-counts a total against its own breakdown. */
function isHapiTotalRow(r: Record<string, unknown>): boolean {
  const allish = (v: unknown) => v == null || v === "all" || v === "ALL" || v === "*";
  return allish(r.gender) && allish(r.age_range) && r.min_age == null && r.max_age == null;
}

/** HAPI refugees/returnees series carry one total-by-gender/age row PER
 *  `population_group` (refugees: REF refugees / ASY asylum-seekers / OIP others
 *  of concern), with NO population-group total. Summing across them inflates
 *  `refugees` into a persons-of-concern count (and double-adds returnee types),
 *  which — being `latest_state` — then beats fresh report figures and trips a
 *  false §7 divergence. Restrict to the single group each label means.
 *  ASSUMPTION: the exact enum values below are best-effort and must be VALIDATED
 *  against live blobs; an unmatched value yields 0 (safe — reports drive it). */
const HAPI_REFUGEE_POP_GROUP = "REF"; // refugees, not all persons of concern
const HAPI_RETURNEE_POP_GROUP = "REF"; // returned refugees (pairs with refugees)

function isHapiPopGroup(r: Record<string, unknown>, group: string): boolean {
  return String(r.population_group ?? "").toUpperCase() === group;
}

/** OCHA HPC sector code → our per-sector PIN label; "intersectoral" → overall.
 *  `FSC` (food security) is deliberately ABSENT: IPC/CH is the authoritative food
 *  security classification, so `pin_food_security` is owned solely by the
 *  `hapi_food_security` (IPC phase 3+) adapter. Mapping FSC here too made two
 *  authoritative sources emit the same label, silently arbitrated by whichever
 *  HAPI job ran last (valid_from) — and an API-vs-API disagreement produced no
 *  §7 signal. One source per label removes that ambiguity (#115). */
const HAPI_SECTOR_TO_PIN: Record<string, string> = {
  SHL: "pin_shelter",
  WSH: "pin_wash",
  PRO: "pin_protection",
  HEA: "pin_health",
  EDU: "pin_education",
  INTERSECTORAL: "overall_pin",
  INT: "overall_pin",
};

/** Per-`location_metadata`-type adapters (ADR-0006 §3). Only the six reconciling
 *  types appear here; context overlays (3W, prices, seasonal, …) are absent, so
 *  they never feed a numeric aggregate.
 *
 *  HAPI SCHEMA ASSUMPTIONS — several adapters read HAPI v2 disaggregation enums
 *  that must be VALIDATED against live blobs before launch:
 *    - needs: `population_status="INN"` (in-need); PIN summed per `sector_code`.
 *    - food security: IPC `ipc_phase` "3+".
 *    - refugees/returnees: `population_group` (see HAPI_REFUGEE/RETURNEE_POP_GROUP)
 *      — summing across groups over-counts, so a single group is selected.
 *  With the population-group filter in place, the failure mode is safe on all of
 *  them: an unrecognised enum yields no figure (no reconciliation) rather than a
 *  wrong total, so reports still drive the field.
 *
 *  needs: `hapi_humanitarian_needs` reduces each sector to one figure at a single
 *  admin level (coarsest), the latest reference-period edition, and the aggregate
 *  category only — so neither an admin breakdown, an older HNO edition, nor a
 *  population-group/age/sex subset can add on top of its own total (verified
 *  against a live Sudan blob that otherwise summed to 195M — see the adapter). */
const API_ADAPTERS: Record<string, ApiAdapter> = {
  // IOM DTM → IDP stock. The headline `population_displaced` is the latest
  // round's total IDPs present; `reporting_date` is its T₀.
  iom_dtm_displacement: {
    org: "IOM DTM",
    extract: (d) => {
      const value = num(d.population_displaced);
      if (value == null) return [];
      return [{ label: "idp_stock", value, unit: "people", referenceDate: parseDate(d.reporting_date) }];
    },
  },

  // UNHCR → refugees. Sum the total-disaggregation population across asylum
  // series (each `records` entry is a destination country).
  hapi_refugees: {
    org: "UNHCR",
    extract: (d) => {
      const total = hapiRecords(d)
        .filter(isHapiTotalRow)
        .filter((r) => isHapiPopGroup(r, HAPI_REFUGEE_POP_GROUP))
        .reduce((s, r) => s + (num(r.population) ?? 0), 0);
      return total > 0
        ? [{ label: "refugees", value: total, unit: "people", referenceDate: hapiRefDate(d) }]
        : [];
    },
  },

  // UNHCR → returnee STOCK (cumulative returned). Same shape as refugees.
  hapi_returnees: {
    org: "UNHCR",
    extract: (d) => {
      const total = hapiRecords(d)
        .filter(isHapiTotalRow)
        .filter((r) => isHapiPopGroup(r, HAPI_RETURNEE_POP_GROUP))
        .reduce((s, r) => s + (num(r.population) ?? 0), 0);
      return total > 0
        ? [{ label: "returnee_stock", value: total, unit: "people", referenceDate: hapiRefDate(d) }]
        : [];
    },
  },

  // OCHA FTS → appeal funding required / received (summed across appeals).
  hapi_funding: {
    org: "OCHA",
    extract: (d) => {
      const recs = hapiRecords(d);
      const required = recs.reduce((s, r) => s + (num(r.requirements_usd) ?? 0), 0);
      const received = recs.reduce((s, r) => s + (num(r.funding_usd) ?? 0), 0);
      const rd = hapiRefDate(d);
      const out: ApiFigure[] = [];
      if (required > 0) out.push({ label: "funding_required_usd", value: required, unit: "USD", referenceDate: rd });
      if (received > 0) out.push({ label: "funding_received_usd", value: received, unit: "USD", referenceDate: rd });
      return out;
    },
  },

  // OCHA HPC → per-sector + overall People-in-Need (population_status "INN";
  // "intersectoral" → overall_pin). A single blob overlaps THREE dimensions that
  // each double/triple-count if summed blindly, so we reduce every label to one
  // figure by collapsing all three, then sum only what legitimately tiles:
  //   - admin_level: a national (admin 0) total plus its own admin-1/admin-2
  //     breakdown. Sum WITHIN one level only — the coarsest present (admin 0 is
  //     the single national row; if absent, the admin-1 rows tile the country and
  //     sum, and so on). Levels are never mixed.
  //   - reference period: the blob carries several HNO/HRP editions (2024, 2025,
  //     2026 …). Keep only the LATEST edition; older ones must not add on top.
  //   - category: mixes the aggregate ("total"/"all"/empty) with population-group,
  //     age, and sex SUBSETS ("Refugees", "IDP", "Children", "Female", "Elderly",
  //     …), each contained in the total. Keep the aggregate only; when "total" and
  //     empty both appear (a duplicate), prefer "total".
  // Verified against live Sudan blob cmse4urwi… (411 records, admin 0): blind
  // summing all three dimensions reported overall_pin 195M for a ~50M-population
  // country; the correct current-edition national intersectoral PIN is 33.7M.
  hapi_humanitarian_needs: {
    org: "OCHA",
    extract: (d) => {
      const inn = hapiRecords(d).filter(
        (r) => String(r.population_status ?? "").toUpperCase() === "INN" && isHapiTotalRow(r),
      );
      if (inn.length === 0) return [];

      const catOf = (r: Record<string, unknown>) => String(r.category ?? "").toLowerCase();
      // The blob's `category` mixes the aggregate ("total"/"all"/empty) with
      // population-group, age, and sex SUBSETS ("Refugees", "IDP", "Children",
      // "Female", "Male", "Elderly", "Adult", "Disability", …). Only the
      // aggregate rows may be summed; the subsets are contained in it.
      const isAggregateCat = (r: Record<string, unknown>) =>
        catOf(r) === "" || catOf(r) === "total" || catOf(r) === "all";
      const isTotalCat = (r: Record<string, unknown>) => catOf(r) === "total" || catOf(r) === "all";
      const periodEndMs = (r: Record<string, unknown>) =>
        parseDate(r.reference_period_end)?.getTime() ?? 0;

      // Group INN rows by our PIN label (sector_code → label), then reduce each
      // label to ONE figure, collapsing every dimension that would double-count.
      const byLabel = new Map<string, Record<string, unknown>[]>();
      for (const r of inn) {
        const label = HAPI_SECTOR_TO_PIN[String(r.sector_code ?? "").toUpperCase()];
        if (!label) continue;
        const list = byLabel.get(label);
        if (list) list.push(r);
        else byLabel.set(label, [r]);
      }

      const out: ApiFigure[] = [];
      for (const [label, allRows] of byLabel) {
        // (1) Single admin level — coarsest present; never mix admin 0 with 1/2.
        const levels = allRows.map((r) => num(r.admin_level)).filter((v): v is number => v != null);
        const coarsest = levels.length ? Math.min(...levels) : null;
        let rows = coarsest == null ? allRows : allRows.filter((r) => num(r.admin_level) === coarsest);

        // (2) Single edition — the latest reference period only. Older HNO/HRP
        // editions in the same blob must NOT sum on top of the current one.
        const latest = Math.max(...rows.map(periodEndMs));
        rows = rows.filter((r) => periodEndMs(r) === latest);

        // (3) Aggregate category only — drop the population-group/age/sex subsets.
        // When an explicit "total" exists, use it and drop the empty-category
        // duplicate; otherwise the empty rows ARE the aggregate. If an edition
        // ships no aggregate at all (unexpected), fall back to the single largest
        // row — a safe lower bound that can't over-count.
        const agg = rows.filter(isAggregateCat);
        let kept: Record<string, unknown>[];
        if (agg.length === 0) {
          kept = [rows.reduce((a, b) => ((num(b.population) ?? 0) > (num(a.population) ?? 0) ? b : a))];
        } else if (agg.some(isTotalCat)) {
          kept = agg.filter(isTotalCat);
        } else {
          kept = agg;
        }

        // (4) Sum what remains — one admin level, one edition, aggregate category:
        // at admin 0 the single national row; at admin 1 the states that tile the
        // country. Same-level units sum; nothing else does.
        const value = kept.reduce((s, r) => s + (num(r.population) ?? 0), 0);
        if (value > 0) {
          out.push({
            label, value, unit: "people",
            referenceDate: parseDate(kept[0]!.reference_period_end) ?? hapiRefDate(d),
          });
        }
      }
      return out;
    },
  },

  // IPC / Cadre Harmonisé → food-security PIN = the current-classification IPC
  // phase-3+ population (prefer an explicit "3+" aggregate; else sum phases 3–5).
  hapi_food_security: {
    org: "IPC",
    extract: (d) => {
      const current = hapiRecords(d).filter((r) => {
        const t = String(r.ipc_type ?? "").toLowerCase();
        return t === "" || t === "current";
      });
      const plus = current.find((r) => String(r.ipc_phase) === "3+");
      const value = plus
        ? num(plus.population) ?? 0
        : current
            .filter((r) => ["3", "4", "5"].includes(String(r.ipc_phase)))
            .reduce((s, r) => s + (num(r.population) ?? 0), 0);
      return value > 0
        ? [{ label: "pin_food_security", value, unit: "people", referenceDate: hapiRefDate(d) }]
        : [];
    },
  },
};

/** Deterministic credibility profile for API contributors (ADR-0006 §8):
 *  Directness = `reported`; the six document-level criteria all `met`. Recency is
 *  still scored live from `valid_from` at read time. */
const API_DIRECTNESS: ConfidenceTier = "reported";
const API_MET_CREDIBILITY = {
  attribution_quality: "met",
  internal_consistency: "met",
  plausibility_in_context: "met",
  geographic_temporal_specificity: "met",
  methodology_transparency: "met",
  representativeness: "met",
} as const;

/** Divergence-guard threshold (ADR-0006 §7): when a report figure disagrees with
 *  the authoritative API figure by more than this fraction, the API figure wins
 *  and the disagreement is surfaced as an early-warning signal. Domain-tunable. */
const DIVERGENCE_THRESHOLD = 0.25;

/** The `location_metadata` types that feed a numeric aggregate (the adapter keys)
 *  — the resolver loads only these current rows for the scope. */
export const API_RECONCILING_TYPES = Object.keys(API_ADAPTERS);

/** Build the `orgLower → { id, reliability }` map `buildApiMentions` needs, by
 *  matching the reconciling adapter org names against the `data_sources` registry
 *  (name or synonym, case-insensitive). Orgs with no registry row are omitted →
 *  their API figures fall back to reliability 1. */
export function buildApiReliabilityByOrg(
  dataSources: { id: string; name: string; synonyms: string[]; reliability: number | null }[],
): Map<string, { id: string; reliability: number | null }> {
  const orgs = new Set(Object.values(API_ADAPTERS).map((a) => a.org.toLowerCase()));
  const map = new Map<string, { id: string; reliability: number | null }>();
  for (const src of dataSources) {
    for (const raw of [src.name, ...(src.synonyms ?? [])]) {
      const n = raw.toLowerCase();
      if (orgs.has(n) && !map.has(n)) map.set(n, { id: src.id, reliability: src.reliability });
    }
  }
  return map;
}

/** Turn the current `location_metadata` rows for one scope location into API
 *  `Mention`s keyed by aggregate-field label, ready to merge alongside the report
 *  mentions. `apiReliabilityByOrg` maps a lowercased org name → its
 *  `data_sources` id + reliability grade. */
export function buildApiMentions(
  rows: LocationMetadataRow[],
  locationId: string,
  apiReliabilityByOrg: Map<string, { id: string; reliability: number | null }>,
): Map<string, Mention[]> {
  const byLabel = new Map<string, Mention[]>();
  const intrinsic = intrinsicCredibilityOf(API_DIRECTNESS, API_MET_CREDIBILITY, null);
  for (const row of rows) {
    const adapter = API_ADAPTERS[row.type];
    if (!adapter) continue; // context overlay — not a reconciling source
    const src = apiReliabilityByOrg.get(adapter.org.toLowerCase());
    const reliability = src && src.reliability != null ? src.reliability : 1;
    const sourceId = src?.id ?? `api:${adapter.org}`;
    const data = row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : {};
    for (const fig of adapter.extract(data)) {
      const mention: Mention = {
        // Synthetic, stable provenance id — also the dedup handle for echoes.
        reportId: `api:${sourceId}:${row.type}:${locationId}`,
        publishedAt: row.validFrom, // recency = now − valid_from (§9)
        incidentDate: fig.referenceDate ?? row.validFrom, // T₀ → bucket / flow cutoff
        locationId,
        value: fig.value,
        // API figures are exact points as of their reference date (clear-context-pipeline ADR-0007).
        valueLow: fig.value,
        valueHigh: fig.value,
        qualifier: "exact",
        measureType: fig.measureType ?? null,
        basisPeriodStart: fig.referenceDate ?? row.validFrom,
        basisPeriodEnd: fig.referenceDate ?? row.validFrom,
        unit: fig.unit,
        confidence: API_DIRECTNESS,
        reliability,
        intrinsicCredibility: intrinsic,
        sourceId,
        isApi: true,
        eventKey: "",
      };
      const list = byLabel.get(fig.label);
      if (list) list.push(mention);
      else byLabel.set(fig.label, [mention]);
    }
  }
  return byLabel;
}

/** Keep only API mentions whose reference date (T₀ = `incidentDate`) falls within
 *  the window, so a current authoritative figure augments the window it describes
 *  rather than every historical window for the location. Report rows are already
 *  window-filtered upstream; this applies the same gate to API contributors. */
export function filterApiMentionsToWindow(
  byLabel: Map<string, Mention[]>,
  windowStart: Date,
  windowEnd: Date,
): Map<string, Mention[]> {
  const s = windowStart.getTime();
  const e = windowEnd.getTime();
  const out = new Map<string, Mention[]>();
  for (const [label, list] of byLabel) {
    const kept = list.filter((m) => {
      const t = m.incidentDate.getTime();
      return t >= s && t <= e;
    });
    if (kept.length > 0) out.set(label, kept);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Stock + flow current-total (ADR-0006 §4)
// ────────────────────────────────────────────────────────────────────

/** One stock observation: its value and reference/as-of date T₀. */
export interface StockObservation {
  value: number;
  /** T₀ — the reference date the stock is "as of" (DTM round date / period end). */
  t0: Date;
}

/** One flow observation: its value and the end of the period it covers. */
export interface FlowObservation {
  value: number;
  /** The flow period's end (`reportingPeriodEnd`) — its as-of date. */
  asOf: Date;
}

/** The estimated current total a stock/flow pair rolls up to (ADR-0006 §4). */
export interface StockFlowEstimate {
  /** stock + flows-since. */
  total: number;
  /** The anchoring authoritative stock. */
  stock: number;
  /** Sum of flows whose period ends strictly after T₀. */
  flowsSince: number;
  /** T₀ (ISO) — the cutoff; flows at/before it are already embedded in `stock`. */
  t0: string;
  /** How many flow observations were added (after T₀). */
  flowCount: number;
}

/** Estimate the current total for a stock/flow metric (ADR-0006 §4):
 *
 *    estimated_total(now) = latest_authoritative_stock(T₀) + Σ flows with as-of > T₀
 *
 * A stock already embeds every flow up to its own reference date T₀, so only
 * flows AFTER T₀ are added — earlier flows are dropped as already-counted (the
 * invariant that kills the returnee/IDP over-count). Returns `null` with no
 * stock anchor: there is nothing to accrue flows onto. */
export function estimateStockFlowTotal(
  stock: StockObservation | null,
  flows: FlowObservation[],
): StockFlowEstimate | null {
  if (!stock) return null;
  const t0 = stock.t0.getTime();
  const forward = flows.filter((f) => f.asOf.getTime() > t0);
  const flowsSince = forward.reduce((s, f) => s + f.value, 0);
  return {
    total: stock.value + flowsSince,
    stock: stock.value,
    flowsSince,
    t0: stock.t0.toISOString(),
    flowCount: forward.length,
  };
}

/** The stock/flow field pairs a current-total can be estimated for. The stock is
 *  a `latest_state` field (authoritative, API-reconciled); the flow is the
 *  `additive_count` that accrues on top of it. */
export const STOCK_FLOW_PAIRS = [
  { metric: "displacement", stockLabel: "idp_stock", flowLabel: "new_displacements" },
  { metric: "returns", stockLabel: "returnee_stock", flowLabel: "new_returns" },
] as const;

export type StockFlowMetric = (typeof STOCK_FLOW_PAIRS)[number]["metric"];

/** Estimate a metric's current total (ADR-0006 §4) from raw report rows + the
 *  authoritative API mentions, at one location scope.
 *
 * The flow sum reuses `aggregateNumericField`, so the forward flows are deduped
 * (echo + incident grouping) exactly as they are in a normal bucket — a raw sum
 * would double-count multi-source reports. Rows are pre-filtered to those whose
 * content date (`reportingPeriodEnd`, the flow mention's as-of) lands strictly
 * after the anchor stock's T₀, so `aggregateNumericField` sees only forward
 * flows. Scope matching is exact — the same country-scoped model the headline
 * `idp_stock` already uses (no descendant roll-up; see #273). */
export function estimateCurrentTotalFromRows(
  rows: ReportRow[],
  apiMentionsByLabel: Map<string, Mention[]>,
  locationScope: string | null,
  stockLabel: string,
  flowLabel: string,
  reliabilityBySource: Map<string, number | null>,
  asOf: Date,
): StockFlowEstimate | null {
  if (!locationScope) return null;
  const stockRule = FIELD_RULES.find((r) => r.label === stockLabel);
  const flowRule = FIELD_RULES.find((r) => r.label === flowLabel);
  if (!stockRule || !flowRule) return null;

  const asOfMs = asOf.getTime();
  const inScope = (m: Mention) =>
    m.locationId === locationScope && m.incidentDate.getTime() <= asOfMs;

  // Anchor = latest authoritative stock: freshest reference date; on a tie an API
  // (authoritative) figure wins, then higher selection-quality.
  const stockMentions = [
    ...rows.flatMap((r) => extractNumericMentions(r, stockRule, reliabilityBySource)),
    ...(apiMentionsByLabel.get(stockLabel) ?? []),
  ].filter(inScope);
  if (stockMentions.length === 0) return null;
  const anchor = stockMentions.reduce((best, m) => {
    const dt = m.incidentDate.getTime();
    const bt = best.incidentDate.getTime();
    if (dt !== bt) return dt > bt ? m : best;
    if (m.isApi !== best.isApi) return m.isApi ? m : best;
    return selectionQuality(m) > selectionQuality(best) ? m : best;
  });
  const t0 = anchor.incidentDate.getTime();

  // Forward flows only: rows whose content date is strictly after T₀ (and ≤ asOf).
  // The flow mention's as-of is the row's reportingPeriodEnd, so row-level
  // filtering is exact for the flow field. Deduped additive sum via the aggregator.
  const flowRows = rows.filter((r) => {
    const d = (r.reportingPeriodEnd ?? r.publishedAt).getTime();
    return d > t0 && d <= asOfMs;
  });
  const flowAgg = aggregateNumericField(flowRows, flowRule, locationScope, reliabilityBySource, []);
  const flowsSince = flowAgg?.value ?? 0;

  return {
    total: anchor.value + flowsSince,
    stock: anchor.value,
    flowsSince,
    t0: anchor.incidentDate.toISOString(),
    // Reports contributing forward flows — a provenance count, not a group count.
    flowCount: flowAgg?.contributing_report_ids.length ?? 0,
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
  apiMentionsByLabel: Map<string, Mention[]> = new Map(),
): AggregationResult | null {
  const allApiMentions = [...apiMentionsByLabel.values()].flat();
  // Gap-fill (ADR-0006 §2): a bucket with no reports but an authoritative API
  // figure still aggregates — so don't bail on empty `rows` alone.
  if (rows.length === 0 && allApiMentions.length === 0) return null;

  const data: Record<string, AggregatedField> = {};
  for (const rule of FIELD_RULES) {
    if (rule.kind === "set_union") {
      data[rule.label] = aggregateSetUnionField(rows, rule);
    } else if (rule.kind !== "non_aggregatable") {
      data[rule.label] = aggregateNumericField(
        rows, rule, locationScope, reliabilityBySource, apiMentionsByLabel.get(rule.label) ?? [],
      );
    }
  }

  // Bucket-level source metadata spans report rows AND API contributors.
  const publishedAts = [
    ...rows.map((r) => r.publishedAt.getTime()),
    ...allApiMentions.map((m) => m.publishedAt.getTime()),
  ];
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
    contributingReportIds: Array.from(
      new Set([...rows.map((r) => r.reportId), ...allApiMentions.map((m) => m.reportId)]),
    ),
    newestSourceAt,
    oldestSourceAt,
    dataQualityScore: Number(dataQualityScore.toFixed(4)),
    reportCount: rows.length, // report rows only; API contributors are provenance
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
