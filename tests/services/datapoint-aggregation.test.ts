/**
 * Unit tests for `services/datapoint-aggregation.ts`.
 *
 * DB-FREE: the aggregation module is a pure-function library over
 * plain `ReportRow` objects, so nothing needs mocking. Coverage
 * targets:
 *
 *   normaliseConfidence — indirect, via aggregateReports on unknown tiers.
 *   FIELD_RULES         — quick sanity: every rule has the fields the
 *                         aggregator reads at runtime.
 *   aggregateReports    — the load-bearing routine. Each field kind
 *                         gets its own scenario so a regression on
 *                         additive_count doesn't hide behind latest_state.
 *
 * Incident-key dedup, quality-envelope math, and set-union semantics
 * are all validated through `aggregateReports` rather than by poking
 * private helpers — the public contract is what the resolver and the
 * refresh mutation rely on.
 */

import { describe, it, expect } from "vitest";

import {
  aggregateReports,
  finaliseReadTimeQuality,
  FIELD_RULES,
  type ReportRow,
} from "../../src/services/datapoint-aggregation.js";

/** Convenience — build a NumericField dict as the LLM emits it. Pass
 *  `scope` to pin this figure's Figure Scope explicitly; otherwise `row`
 *  stamps the report's primary location onto it. `sourceId` sets the figure's
 *  cited source (for data-quality / reliability tests). */
function nf(value: number, confidence = "reported", unit = "people", scope?: string, sourceId?: string) {
  return {
    value,
    unit,
    confidence,
    source_quote: "…",
    chunk_index: 0,
    page_number: 1,
    ...(scope !== undefined ? { scope_location_id: scope } : {}),
    ...(sourceId !== undefined ? { source_id: sourceId } : {}),
  };
}

/** Post-#273 every numeric figure carries its own `scope_location_id`.
 *  Stamp the report's primary location onto every figure that doesn't
 *  already declare one, so single-scope tests read naturally. */
function stampScope(data: unknown, scope: string | null): void {
  if (Array.isArray(data)) {
    for (const v of data) stampScope(v, scope);
    return;
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if ("value" in o && "confidence" in o && "source_quote" in o) {
      if (o.scope_location_id === undefined && scope !== null) o.scope_location_id = scope;
      return;
    }
    for (const v of Object.values(o)) stampScope(v, scope);
  }
}

/** Convenience — build a minimal ReportRow. The `locationIds` array's
 *  first entry is the report's primary Figure Scope, stamped onto each
 *  figure that doesn't pin its own (via `nf(..., scope)`). `locationIds`
 *  is retained on the row but no longer drives bucketing. */
function row(
  reportId: string,
  publishedAt: string,
  locationIds: string[],
  data: Record<string, unknown>,
  reportingPeriodEnd?: string,
  sourceId?: string,
): ReportRow {
  stampScope(data, locationIds[0] ?? null);
  return {
    reportId,
    publishedAt: new Date(publishedAt),
    reportingPeriodStart: null,
    reportingPeriodEnd: reportingPeriodEnd ? new Date(reportingPeriodEnd) : new Date(publishedAt),
    locationIds,
    data,
    sourceId: sourceId ?? null,
  };
}

describe("FIELD_RULES registry", () => {
  it("every rule declares a valid kind and a policy", () => {
    const validKinds = new Set([
      "additive_count", "latest_state", "set_union", "max", "non_aggregatable",
    ]);
    const validPolicies = new Set([
      "latest_wins", "latest_wins_with_confidence_override",
      "max_within_report_then_latest", "set_union_all",
    ]);
    for (const rule of FIELD_RULES) {
      expect(validKinds.has(rule.kind)).toBe(true);
      expect(validPolicies.has(rule.withinGroupPolicy)).toBe(true);
      expect(rule.path.length).toBeGreaterThan(0);
      expect(rule.label.length).toBeGreaterThan(0);
    }
  });

  it("labels are unique — the aggregated `data` blob keys off them", () => {
    // Two rules pointing at different paths but sharing a label would
    // silently overwrite each other in the output map.
    const labels = FIELD_RULES.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("aggregateReports — empty input", () => {
  it("returns null when no reports are supplied", () => {
    expect(aggregateReports([], null)).toBeNull();
  });
});

describe("aggregateReports — additive count (killed_total)", () => {
  it("dedupes two reports for the same week (period totals, not per-day events)", () => {
    // Both figures are weekly period-totals for the same week + location, so
    // they're competing observations of one measurement — deduped to ONE, not
    // summed (clear-context-pipeline ADR-0002: no per-day breakdown). Which one
    // wins is now bias-aware: killed_total is `overreport`, so among
    // comparable-quality figures the LOWER value is taken (clear-context-pipeline ADR-0005 §4).
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3, "verified") } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-04T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5, "verified") } },
      }, "2026-07-04T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    expect(result).not.toBeNull();
    const field = result!.data.killed_total;
    expect(field).not.toBeNull();
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(3); // deduped (not summed to 8); overreport bias → lower
    // Provenance is preserved even for the deduped-away row (§6.4.5 A):
    // both reports are recorded, and the suppression is counted.
    expect(field.contributing_report_ids.sort()).toEqual(["r1", "r2"]);
    expect(field.suppressed_count).toBe(1);
  });

  it("dedupes same-day competing reports — bias-selected winner, not summed", () => {
    // Same day, same location → same incident key. Both are competing
    // observations of one event. With uniform reliability the confidence gap
    // (reported vs verified) stays within the data-quality margin D, so they're
    // comparable and the overreport bias takes the LOWER figure (clear-context-pipeline ADR-0005 §4).
    const rows = [
      row("r1", "2026-07-05T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(10, "reported") } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-07T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(15, "verified") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    // Not 25 (naïve sum) — deduped; overreport bias → the lower value (10).
    expect(field.value).toBe(10);
  });
});

describe("aggregateReports — latest_wins_with_confidence_override (additive counts)", () => {
  // Confidence override: same incident (same week bucket + location),
  // a newer lower-tier report vs a slightly older verified one.
  it("a verified row within 3 days overrides a newer lower-tier winner", () => {
    const rows = [
      row("r-verified", "2026-07-05T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(40, "verified") } },
      }, "2026-07-02T00:00:00Z"),
      row("r-media", "2026-07-07T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(55, "media") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const field = aggregateReports(rows, "SD0201")!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(40); // verified overrides the fresher media row
  });

  it("does NOT override when the verified row is outside the 3-day window", () => {
    const rows = [
      row("r-verified", "2026-07-01T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(40, "verified") } },
      }, "2026-07-02T00:00:00Z"),
      row("r-media", "2026-07-07T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(55, "media") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const field = aggregateReports(rows, "SD0201")!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(55); // 6 days apart → plain latest_wins → media
  });

  it("keeps the freshest row when it is itself verified", () => {
    const rows = [
      row("r-media", "2026-07-05T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(55, "media") } },
      }, "2026-07-02T00:00:00Z"),
      row("r-verified", "2026-07-07T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(40, "verified") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const field = aggregateReports(rows, "SD0201")!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(40); // freshest is verified → wins outright
  });
});

describe("aggregateReports — week bucket for summed figures", () => {
  it("dedupes two same-week reports (weekly period totals, not per-day events)", () => {
    // 2026-07-06 (Mon) and 2026-07-08 (Wed) are the same ISO week. The figures
    // are weekly period-totals for the same week + location → one measurement,
    // deduped to the latest, not summed (clear-context-pipeline ADR-0002).
    const rows = [
      row("r-mon", "2026-07-06T00:00:00Z", ["SD0201"], {
        access_and_incidents: { security_incidents_count: nf(2, "reported") },
      }, "2026-07-06T00:00:00Z"),
      row("r-wed", "2026-07-08T00:00:00Z", ["SD0201"], {
        access_and_incidents: { security_incidents_count: nf(3, "reported") },
      }, "2026-07-08T00:00:00Z"),
    ];
    const field = aggregateReports(rows, "SD0201")!.data.security_incidents_count;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(3); // deduped to the latest, not summed to 5
  });

  it("sums reports from different weeks", () => {
    // 2026-07-01 (ISO week 27) and 2026-07-08 (week 28) → different periods →
    // genuinely different figures → summed.
    const rows = [
      row("wk27", "2026-07-01T00:00:00Z", ["SD0201"], {
        access_and_incidents: { security_incidents_count: nf(2, "reported") },
      }, "2026-07-01T00:00:00Z"),
      row("wk28", "2026-07-08T00:00:00Z", ["SD0201"], {
        access_and_incidents: { security_incidents_count: nf(3, "reported") },
      }, "2026-07-08T00:00:00Z"),
    ];
    const field = aggregateReports(rows, "SD0201")!.data.security_incidents_count;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(5); // 2 + 3 across two distinct weeks
  });
});

describe("aggregateReports — latest state (idp_stock)", () => {
  it("picks the freshest snapshot across many reports", () => {
    // IDP stock is a state field — never sum, always latest.
    const rows = [
      row("r-old", "2026-06-01T00:00:00Z", ["SD0201"], {
        displacement: { idp_stock: nf(45000, "reported") },
      }, "2026-05-30T00:00:00Z"),
      row("r-new", "2026-07-08T00:00:00Z", ["SD0201"], {
        displacement: { idp_stock: nf(52000, "verified") },
      }, "2026-07-05T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.idp_stock;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(52000);
  });
});

describe("aggregateReports — max (overall_affected)", () => {
  it("takes the largest affected figure across the window, not the latest", () => {
    // Population Affected is Max, not latest_state: a later, narrower
    // report must not shrink the widest evidenced reach. The two figures
    // fall in different month buckets, so they form separate incident
    // groups and the cross-group combine is Math.max.
    const rows = [
      row("r-may", "2026-05-20T00:00:00Z", ["SD01"], {
        needs_and_funding: { overall_affected: nf(1_000_000, "reported") },
      }, "2026-05-31T00:00:00Z"),
      row("r-jul", "2026-07-08T00:00:00Z", ["SD01"], {
        needs_and_funding: { overall_affected: nf(600_000, "verified") },
      }, "2026-07-05T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD01");
    const field = result!.data.overall_affected;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(1_000_000); // max, not the fresher 600k
    expect(field.contributing_report_ids.sort()).toEqual(["r-jul", "r-may"]);
  });

  it("is null when no report states an affected figure", () => {
    const rows = [row("r1", "2026-07-01T00:00:00Z", ["SD01"], {
      needs_and_funding: { overall_pin: nf(500_000) },
    })];
    const result = aggregateReports(rows, "SD01");
    expect(result!.data.overall_affected).toBeNull();
  });
});

describe("aggregateReports — set union (event_types)", () => {
  it("unions labels across every contributing report", () => {
    const rows = [
      row("r1", "2026-07-01T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict", "displacement"] },
      }),
      row("r2", "2026-07-05T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["displacement", "food-insecurity"] },
      }),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.event_types;
    if (!field || !("values" in field)) throw new Error("expected set-union field");
    expect(field.values.sort()).toEqual(["conflict", "displacement", "food-insecurity"]);
    expect(field.contributing_report_ids.sort()).toEqual(["r1", "r2"]);
  });

  it("yields null when no report contains the field", () => {
    const rows = [row("r1", "2026-07-01T00:00:00Z", ["SD0201"], {})];
    const result = aggregateReports(rows, "SD0201");
    expect(result!.data.event_types).toBeNull();
  });
});

describe("aggregateReports — scope filtering (#273)", () => {
  it("keeps only the figures scoped to the queried location", () => {
    // Two figures at two scopes. A bucket sees only figures scoped to it.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-04T00:00:00Z", ["SD0301"], {
        casualties: { killed: { total: nf(100) } },
      }, "2026-07-04T00:00:00Z"),
    ];
    const a = aggregateReports(rows, "SD0201");
    const fa = a!.data.killed_total;
    if (!fa || !("value" in fa)) throw new Error("expected numeric field");
    expect(fa.value).toBe(3);

    const b = aggregateReports(rows, "SD0301");
    const fb = b!.data.killed_total;
    if (!fb || !("value" in fb)) throw new Error("expected numeric field");
    expect(fb.value).toBe(100);
  });

  it("a null scope aggregates nothing — there is no cross-location roll-up", () => {
    // Every figure has a scope; null matches none. A country total is read
    // from the country-scoped bucket (the A0 id), never by summing scopes.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }),
    ];
    expect(aggregateReports(rows, null)!.data.killed_total).toBeNull();
  });

  it("a figure with no resolved scope is excluded entirely", () => {
    // scope_location_id null (LLM abstained / name unresolved) → the
    // figure is attributed nowhere and never rolled up.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(9, "reported", "people", undefined) } },
        // pin an explicit null scope on the field, overriding stampScope
      }),
    ];
    // Override: null out the scope the helper stamped.
    (rows[0]!.data as { casualties: { killed: { total: { scope_location_id?: unknown } } } })
      .casualties.killed.total.scope_location_id = null;
    expect(aggregateReports(rows, "SD0201")!.data.killed_total).toBeNull();
  });
});

describe("aggregateReports — stable tie-break on equal publishedAt", () => {
  it("breaks a publishedAt tie by confidence weight, not input order", () => {
    // Same week + scope + publishedAt → one group, a tie for 'latest'. The
    // higher-confidence row must win deterministically regardless of order.
    const mk = (id: string, conf: string, v: number) =>
      row(id, "2026-07-06T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(v, conf) } },
      }, "2026-07-06T00:00:00Z");
    const forward = aggregateReports([mk("a", "reported", 10), mk("b", "media", 20)], "SD0201");
    const reverse = aggregateReports([mk("b", "media", 20), mk("a", "reported", 10)], "SD0201");
    const fv = forward!.data.killed_total, rv = reverse!.data.killed_total;
    if (!fv || !("value" in fv) || !rv || !("value" in rv)) throw new Error("expected numeric");
    expect(fv.value).toBe(10);   // reported (0.8) beats media (0.3)
    expect(rv.value).toBe(10);   // ...and it's order-independent
  });
});

describe("aggregateReports — quality envelope", () => {
  it("weights the quality score by confidence tier", () => {
    // Two contributing reports, both `verified` → quality_score ≈ 1.0.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3, "verified") } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-04T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5, "verified") } },
      }, "2026-07-04T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("quality_score" in field)) throw new Error("expected numeric field");
    expect(field.quality_score).toBeCloseTo(1.0, 4);
    expect(field.confidence_mix.verified).toBeCloseTo(1.0, 4);
  });

  it("same-week mixed tiers: verified overrides, media stays in the mix, freshness holds (§6.4.5 B)", () => {
    // One group (same week + scope). A newer media 55 vs a verified 40 two days
    // older → the confidence override picks the verified figure. The media row
    // contributes NO value but is recorded in confidence_mix for transparency,
    // quality_score reflects the winner, and newest_report_at is the newer
    // media publish date (not the older winner's).
    const rows = [
      row("r-verified", "2026-07-01T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(40, "verified") } },
      }, "2026-07-01T00:00:00Z"),
      row("r-media", "2026-07-03T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(55, "media") } },
      }, "2026-07-03T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("quality_score" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(40);                              // verified wins the value
    expect(field.quality_score).toBeCloseTo(1.0, 4);           // winner-weighted (verified)
    expect(field.confidence_mix.verified).toBeCloseTo(0.5, 4); // media still shown...
    expect(field.confidence_mix.media).toBeCloseTo(0.5, 4);    // ...for transparency
    expect(field.contributing_report_ids.sort()).toEqual(["r-media", "r-verified"]);
    expect(field.suppressed_count).toBe(1);
    expect(field.newest_report_at).toBe("2026-07-03T00:00:00.000Z"); // newer row, not the winner
  });

  it("folds unknown confidence tiers to `unverified`", () => {
    // The LLM occasionally emits a variant the taxonomy doesn't
    // recognise. The aggregator must NOT crash — it maps to
    // `unverified` (weight 0.1).
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3, "some-weird-tier") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("quality_score" in field)) throw new Error("expected numeric field");
    expect(field.quality_score).toBeCloseTo(0.1, 4);
    expect(field.confidence_mix.unverified).toBeCloseTo(1.0, 4);
  });
});

describe("aggregateReports — bucket metadata", () => {
  it("populates newest/oldest source and report count correctly", () => {
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-08T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5) } },
      }, "2026-07-05T00:00:00Z"),
      row("r3", "2026-07-10T00:00:00Z", ["SD0201"], {
        // A report with no killed data still counts as a contributor
        // for bucket-level metadata (it's still "in scope").
        timing_and_scope: { event_types: ["conflict"] },
      }, "2026-07-09T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    expect(result!.reportCount).toBe(3);
    expect(result!.newestSourceAt).toEqual(new Date("2026-07-10T00:00:00Z"));
    expect(result!.oldestSourceAt).toEqual(new Date("2026-07-02T00:00:00Z"));
    expect(result!.contributingReportIds.sort()).toEqual(["r1", "r2", "r3"]);
  });
});

describe("aggregateReports — incident-key dedup edge cases", () => {
  it("different-week reports do NOT dedupe on additive_count with week bucket", () => {
    // `new_displacements` uses week bucket. Reports in different ISO
    // weeks yield distinct incident keys → both count.
    const rows = [
      row("r1", "2026-07-01T00:00:00Z", ["SD0201"], {
        displacement: { new_displacements: nf(10000) },
      }, "2026-06-30T00:00:00Z"), // ISO week 27
      row("r2", "2026-07-08T00:00:00Z", ["SD0201"], {
        displacement: { new_displacements: nf(5000) },
      }, "2026-07-07T00:00:00Z"), // ISO week 28
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.new_displacements;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(15000);
  });

  it("same ISO week + same location dedupes even across calendar weekend", () => {
    // ISO week runs Mon..Sun. Two reports both landing in the same
    // ISO week (Sunday + following Sunday should be DIFFERENT ISO
    // weeks — sanity check that boundary handling is right).
    const rows = [
      row("r1", "2026-07-06T00:00:00Z", ["SD0201"], {
        displacement: { new_displacements: nf(10000) },
      }, "2026-07-06T00:00:00Z"), // Monday of ISO week 28
      row("r2", "2026-07-11T00:00:00Z", ["SD0201"], {
        displacement: { new_displacements: nf(20000) },
      }, "2026-07-11T00:00:00Z"), // Saturday of ISO week 28
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.new_displacements;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    // Same ISO week + same location → same incident key → latest wins.
    // Sat > Mon by publishedAt, value=20000.
    expect(field.value).toBe(20000);
  });

  it("figures at distinct scopes live in distinct buckets", () => {
    // Two figures, same week, different scopes → each in its own bucket.
    const rows = [
      row("r1", "2026-07-08T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-08T00:00:00Z"),
      row("r2", "2026-07-08T00:00:00Z", ["SD0301"], {
        casualties: { killed: { total: nf(5) } },
      }, "2026-07-08T00:00:00Z"),
    ];
    const a = aggregateReports(rows, "SD0201")!.data.killed_total;
    const b = aggregateReports(rows, "SD0301")!.data.killed_total;
    if (!a || !("value" in a) || !b || !("value" in b)) throw new Error("expected numeric field");
    expect(a.value).toBe(3);
    expect(b.value).toBe(5);
  });

  it("two figures at the SAME scope + week dedupe (bias-selected), not sum", () => {
    const rows = [
      row("r1", "2026-07-08T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3, "reported") } },
      }, "2026-07-08T00:00:00Z"),
      row("r2", "2026-07-10T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5, "verified") } },
      }, "2026-07-08T00:00:00Z"), // same day bucket → competing observations
    ];
    const f = aggregateReports(rows, "SD0201")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(3); // deduped (not 8); overreport bias → the lower value
  });
});

describe("aggregateReports — time bucket granularity", () => {
  it("uses day bucket for casualties (killed_total) — same-day dedupes", () => {
    // Two reports about killed on 2026-07-08. Same day → same bucket.
    const rows = [
      row("r1", "2026-07-09T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-08T00:00:00Z"),
      row("r2", "2026-07-10T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5) } },
      }, "2026-07-08T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    // Same-day dedupe (not summed to 8). Both `reported` → comparable → the
    // overreport bias takes the lower value (3).
    expect(field.value).toBe(3);
  });

  it("uses month bucket for latest_state (idp_stock) — same-month dedupes", () => {
    // Both reports fall in 2026-07 → same incident group.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        displacement: { idp_stock: nf(45000) },
      }, "2026-07-01T00:00:00Z"),
      row("r2", "2026-07-20T00:00:00Z", ["SD0201"], {
        displacement: { idp_stock: nf(52000) },
      }, "2026-07-18T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.idp_stock;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    // Latest wins → 52000.
    expect(field.value).toBe(52000);
  });
});

describe("aggregateReports — quality mix distribution invariants", () => {
  it("confidence_mix values sum to 1", () => {
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3, "verified") } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-04T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5, "reported") } },
      }, "2026-07-04T00:00:00Z"),
      row("r3", "2026-07-06T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(7, "media") } },
      }, "2026-07-06T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("quality_score" in field)) throw new Error("expected numeric field");
    const mixSum = Object.values(field.confidence_mix).reduce((a, b) => a + b, 0);
    expect(mixSum).toBeCloseTo(1.0, 4);
  });
});

describe("aggregateReports — malformed inputs", () => {
  it("ignores non-numeric values on numeric-field paths", () => {
    // A NumericField with a string value should be silently skipped —
    // one bad row must not drop the whole bucket.
    const rows = [
      row("r-bad", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: { value: "twelve", confidence: "reported" } } },
      }, "2026-07-02T00:00:00Z"),
      row("r-good", "2026-07-04T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5) } },
      }, "2026-07-04T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(5);
    expect(field.contributing_report_ids).toEqual(["r-good"]);
  });

  it("returns null field when no report populated the path", () => {
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {}),
    ];
    const result = aggregateReports(rows, "SD0201");
    // Bucket exists (reports present) but this field's value is null.
    expect(result).not.toBeNull();
    expect(result!.data.killed_total).toBeNull();
  });
});

/**
 * Aggregation invariants — see clear-context-pipeline/docs/adr/0002-deduplicate-at-figure-scope.md
 * and clear-api/docs/adr/0001-country-scope-dedups-by-report.md.
 *
 * Both the country-scope inflation defect (#269) and the missing
 * event-type key dimension (#270) are now FIXED — the tests below assert
 * the corrected behaviour. They remain as regression guards; the guard
 * tests interleaved with them pin the blast radius so a later change
 * can't silently over- or under-correct.
 *
 * Reports are ANALYTICAL: a figure is a total already aggregated at source
 * over a Figure Scope — (location, admin_level, period, event-type set).
 * Deduplication is only for competing observations of the same scope.
 */
describe("Figure Scope bucketing — no fan-out (#273, retires #269 stopgap)", () => {
  // A figure carries ONE scope. It lands in that scope's bucket and
  // nowhere else, regardless of every other place the report mentions —
  // so there's no fan-out to double-count and no country-scope stopgap.
  it("a figure scoped to SDN reaches SDN and returns null for SD0201", () => {
    // The report mentions three places but the figure is scoped to SDN
    // (the national total). It appears ONLY in SDN's bucket. This is the
    // resolution of the old REVISIT guard.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201", "SD02", "SDN"], {
        casualties: { killed: { total: nf(10, "reported", "people", "SDN") } },
      }),
    ];
    const atSDN = aggregateReports(rows, "SDN")!.data.killed_total;
    if (!atSDN || !("value" in atSDN)) throw new Error("expected numeric field");
    expect(atSDN.value).toBe(10);
    // Not attributed to the sub-national places it merely mentioned.
    expect(aggregateReports(rows, "SD0201")!.data.killed_total).toBeNull();
    expect(aggregateReports(rows, "SD02")!.data.killed_total).toBeNull();
  });

  it("one report can carry figures at different scopes", () => {
    // killed scoped to El Fasher, PIN scoped to Sudan — each in its own
    // bucket, no cross-attribution.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(10, "reported", "people", "SD0201") } },
        needs_and_funding: { overall_pin: nf(2_000_000, "reported", "people", "SDN") },
      }),
    ];
    const killedAtTown = aggregateReports(rows, "SD0201")!.data.killed_total;
    const pinAtCountry = aggregateReports(rows, "SDN")!.data.overall_pin;
    if (!killedAtTown || !("value" in killedAtTown)) throw new Error("expected numeric field");
    if (!pinAtCountry || !("value" in pinAtCountry)) throw new Error("expected numeric field");
    expect(killedAtTown.value).toBe(10);
    expect(pinAtCountry.value).toBe(2_000_000);
    // The town bucket has no PIN; the country bucket has no killed.
    expect(aggregateReports(rows, "SD0201")!.data.overall_pin).toBeNull();
    expect(aggregateReports(rows, "SDN")!.data.killed_total).toBeNull();
  });
});

describe("event-type key dimension — FIXED (#270)", () => {
  // §6.4.1 specifies the key as (event, location, time_bucket). The
  // implementation now builds `${keyHead}|${bucket}|${eventKey}`. Two
  // distinct event types in one place on one day are different phenomena,
  // not competing observations of one thing, so they sum rather than
  // collapse. Deduplication remains only for the SAME
  // (location, period, event type).
  it("clash (5) + flood (3), same place same day → 8, not 3", () => {
    const rows = [
      row("r-clash", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-flood", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["flood"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"), // same incident date → same day bucket
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(8);
  });

  it("both reports stay in provenance — neither event is silently dropped", () => {
    // The sharper symptom: the discarded report vanishes from
    // contributing_report_ids while event_types still unions to both, so
    // the payload asserts two event types occurred and cites one report.
    const rows = [
      row("r-clash", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-flood", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["flood"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.contributing_report_ids.sort()).toEqual(["r-clash", "r-flood"]);
  });

  it("dedup still applies within one event type — competing observations collapse", () => {
    // Guards the fix from over-correcting: two reports on the SAME
    // (location, day, event type) are one thing seen twice → latest wins,
    // not 5 + 3 = 8.
    const rows = [
      row("r-early", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-late", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(3); // latest_wins
  });

  it("event-type set is canonicalised — case and order don't split a key", () => {
    // The set is normalised (lowercase, sorted) before it enters the key,
    // so {"Conflict","FLOOD"} and {"flood","conflict"} are the SAME
    // phenomenon. Without canonicalisation these two reports would form
    // distinct keys and wrongly sum to 8 instead of deduping to 3.
    const rows = [
      row("r-early", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["Conflict", "FLOOD"] },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-late", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["flood", "conflict"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(3); // one incident, latest wins — not 8
  });

  it("differing event-type SETS are distinct — {conflict} vs {conflict,flood} sum", () => {
    // Atomic set: a multi-hazard total is not the same phenomenon as a
    // single-hazard total, so these do not collapse.
    const rows = [
      row("r-a", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-b", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict", "flood"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(8);
  });
});

describe("event-type key — untyped/malformed/casing fixes (PR #81 review)", () => {
  const kt = (r: ReturnType<typeof aggregateReports>) => {
    const f = r!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    return f.value;
  };

  it("untyped report does NOT double-count against a typed one (the regression)", () => {
    // Empty event-type set means 'unknown', not 'a distinct phenomenon' —
    // it merges into the sole typed group at the same location+bucket.
    const rows = [
      row("r-untyped", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-conflict", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    expect(kt(aggregateReports(rows, "SD0201"))).toBe(3); // deduped, not 8
  });

  it("leaves the untyped group separate when MULTIPLE typed groups share the bucket", () => {
    // conflict + flood are two distinct phenomena; an untyped figure can't
    // be assigned to one, so it is not merged (documented, ADR-0002).
    const rows = [
      row("r-untyped", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-conflict", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }),
      row("r-flood", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["flood"] },
        casualties: { killed: { total: nf(2) } },
      }),
    ];
    // conflict(3) + flood(2) + untyped(5), all distinct groups → 10.
    expect(kt(aggregateReports(rows, "SD0201"))).toBe(10);
  });

  it("untyped and typed figures at DIFFERENT scopes never interact", () => {
    // The untyped-merge is per (scope, bucket); figures at different
    // scopes are in different buckets, so nothing merges across them.
    const rows = [
      row("r-untyped", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-conflict", "2026-07-02T00:00:00Z", ["SD0301"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }),
    ];
    expect(kt(aggregateReports(rows, "SD0201"))).toBe(5);
    expect(kt(aggregateReports(rows, "SD0301"))).toBe(3);
  });

  it("a bare-string event_types is tolerated, not treated as untyped", () => {
    // `"conflict"` (not `["conflict"]`) must canonicalise the same way, so
    // it dedups with an array-tagged report of the same incident.
    const rows = [
      row("r-str", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: "conflict" },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r-arr", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    expect(kt(aggregateReports(rows, "SD0201"))).toBe(3); // same phenomenon, deduped
  });

  it("key and published event_types agree on case", () => {
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["Conflict"] },
        casualties: { killed: { total: nf(5) } },
      }),
      row("r2", "2026-07-04T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201")!;
    // One incident group (deduped) …
    expect(kt(result)).toBe(3);
    // … and the published set is canonicalised to match — one entry, not two.
    const et = result.data.event_types;
    if (!et || !("values" in et)) throw new Error("expected set-union field");
    expect(et.values).toEqual(["conflict"]);
  });

  it("active_clusters keeps its display casing (not blanket-lowercased)", () => {
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { active_clusters: ["Protection", "WASH"] },
      }),
    ];
    const result = aggregateReports(rows, "SD0201")!;
    const ac = result.data.active_clusters;
    if (!ac || !("values" in ac)) throw new Error("expected set-union field");
    expect(ac.values).toEqual(["Protection", "WASH"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// DQ P3 — data quality: reliability, bias-aware selection, quartile-drop
// ────────────────────────────────────────────────────────────────────

describe("aggregateReports — reliability-driven override (clear-context-pipeline ADR-0005 §4)", () => {
  it("a higher-reliability source overrides a fresher, weaker one within reach", () => {
    // killed_total (overreport, window 7d/x2 → 3.5d reach). The strong source
    // (reliability 3) has data_quality far above the weak one (Δ ≥ D=1.0), so it
    // overrides despite being older AND despite carrying the HIGHER value —
    // proving the reliability override beats the overreport bias's "lower wins".
    const rows = [
      row("r-weak", "2026-07-07T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(30, "reported", "people", undefined, "src-weak") } },
      }, "2026-07-02T00:00:00Z"),
      row("r-strong", "2026-07-05T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(50, "reported", "people", undefined, "src-strong") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const map = new Map<string, number | null>([["src-weak", 1], ["src-strong", 3]]);
    const f = aggregateReports(rows, "SD0201", map)!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(50); // grade-3 source wins outright; bias never gets to pick
  });

  it("a higher-reliability source OUTSIDE the override reach does not override", () => {
    // Same as above but the strong source is 6 days older than the freshest —
    // beyond the 3.5d reach — so it's excluded and the freshest weak row stands.
    const rows = [
      row("r-weak", "2026-07-10T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(30, "reported", "people", undefined, "src-weak") } },
      }, "2026-07-02T00:00:00Z"),
      row("r-strong", "2026-07-04T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(50, "reported", "people", undefined, "src-strong") } },
      }, "2026-07-02T00:00:00Z"),
    ];
    const map = new Map<string, number | null>([["src-weak", 1], ["src-strong", 3]]);
    const f = aggregateReports(rows, "SD0201", map)!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(30); // strong source too old to reach → freshest weak wins
  });
});

describe("aggregateReports — directional bias tie-break (clear-context-pipeline ADR-0005 §4)", () => {
  it("an underreport field takes the HIGHER of two comparable figures", () => {
    // security_incidents_count (additive, underreport). Uniform reliability →
    // comparable quality → bias decides → the higher (incidents under-recorded).
    const rows = [
      row("r1", "2026-07-07T00:00:00Z", ["SD0201"], {
        access_and_incidents: { security_incidents_count: nf(5, "reported") },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-05T00:00:00Z", ["SD0201"], {
        access_and_incidents: { security_incidents_count: nf(8, "reported") },
      }, "2026-07-02T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD0201")!.data.security_incidents_count;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(8); // underreport → higher, even though r1 is fresher
  });
});

describe("aggregateReports — max quartile-drop (overall_affected, clear-context-pipeline ADR-0005 §4)", () => {
  it("drops the lowest-quality winner before taking the max", () => {
    // Four monthly buckets → four cross-group winners. The 9999 outlier comes
    // from an `unverified` figure (lowest data quality); the bottom quartile
    // (1 of 4) is dropped, so the max of the remaining {100,200,300} wins.
    const rows = [
      row("r1", "2026-01-15T00:00:00Z", ["SD01"], {
        needs_and_funding: { overall_affected: nf(100, "reported") },
      }, "2026-01-15T00:00:00Z"),
      row("r2", "2026-04-15T00:00:00Z", ["SD01"], {
        needs_and_funding: { overall_affected: nf(200, "reported") },
      }, "2026-04-15T00:00:00Z"),
      row("r3", "2026-07-15T00:00:00Z", ["SD01"], {
        needs_and_funding: { overall_affected: nf(300, "reported") },
      }, "2026-07-15T00:00:00Z"),
      row("r4", "2026-10-15T00:00:00Z", ["SD01"], {
        needs_and_funding: { overall_affected: nf(9999, "unverified") },
      }, "2026-10-15T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.overall_affected;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(300); // low-quality 9999 outlier dropped; max of the rest
  });
});

describe("finaliseReadTimeQuality — read-time recency + data_quality (clear-context-pipeline ADR-0005 §2)", () => {
  const envelope = (over: Record<string, unknown>) => ({
    value: 1000,
    unit: "people",
    quality_score: 0.8,
    reliability: 3,
    intrinsic_credibility: 5.0,
    confidence_mix: {},
    newest_report_at: "2026-07-05T00:00:00Z",
    oldest_report_at: "2026-07-05T00:00:00Z",
    contributing_report_ids: ["r1"],
    suppressed_count: 0,
    ...over,
  });

  it("full recency inside the window → data_quality folds it in", () => {
    // idp_stock window 30d; newest report 5 days before asOf → within window →
    // recency 1.5. info_cred = 5.0 + 1.5 = 6.5; dq = (3 × 2.5 × 6.5) / 10 = 4.875.
    const asOf = new Date("2026-07-10T00:00:00Z");
    const { data, dataQualityScore } = finaliseReadTimeQuality(
      { idp_stock: envelope({}) },
      asOf,
    );
    const f = data.idp_stock as Record<string, number>;
    expect(f.recency).toBe(1.5);
    expect(f.information_credibility).toBe(6.5);
    expect(f.data_quality).toBeCloseTo(4.875, 3);
    expect(dataQualityScore).toBeCloseTo(4.875, 3);
  });

  it("half recency past the window, zero past 2×", () => {
    const half = finaliseReadTimeQuality(
      // 45 days old, window 30d → within 2× → recency 0.75.
      { idp_stock: envelope({ newest_report_at: "2026-05-26T00:00:00Z" }) },
      new Date("2026-07-10T00:00:00Z"),
    ).data.idp_stock as Record<string, number>;
    expect(half.recency).toBe(0.75);
    expect(half.data_quality).toBeCloseTo((3 * 2.5 * (5.0 + 0.75)) / 10, 3);

    const stale = finaliseReadTimeQuality(
      // 70 days old, > 2×30 → recency 0.
      { idp_stock: envelope({ newest_report_at: "2026-05-01T00:00:00Z" }) },
      new Date("2026-07-10T00:00:00Z"),
    ).data.idp_stock as Record<string, number>;
    expect(stale.recency).toBe(0);
    expect(stale.data_quality).toBeCloseTo((3 * 2.5 * 5.0) / 10, 3);
  });

  it("leaves set-union / null fields untouched", () => {
    const { data } = finaliseReadTimeQuality(
      { event_types: { values: ["flood"], contributing_report_ids: ["r1"] }, idp_stock: null },
      new Date("2026-07-10T00:00:00Z"),
    );
    expect(data.event_types).toEqual({ values: ["flood"], contributing_report_ids: ["r1"] });
    expect(data.idp_stock).toBeNull();
  });
});

describe("aggregateReports — per-figure credibility override (clear-context-pipeline ADR-0004 §4)", () => {
  const docUnmet = {
    attribution_quality: "unmet", internal_consistency: "unmet",
    plausibility_in_context: "unmet", geographic_temporal_specificity: "unmet",
    methodology_transparency: "unmet", representativeness: "unmet",
  };
  const allMet = {
    attribution_quality: "met", internal_consistency: "met",
    plausibility_in_context: "met", geographic_temporal_specificity: "met",
    methodology_transparency: "met", representativeness: "met",
  };

  it("uses the figure's own credibility over the document-level fallback", () => {
    const killed = { ...nf(10, "reported"), credibility: allMet };
    const rows = [row("r1", "2026-07-05T00:00:00Z", ["SD0201"], {
      casualties: { killed: { total: killed } },
      narrative_and_confidence: { information_credibility: docUnmet },
    }, "2026-07-02T00:00:00Z")];
    const f = aggregateReports(rows, "SD0201")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    // reported directness (2.0×0.8=1.6) + six met (6.5) = 8.1 — the figure's own
    // ratings win over the document's all-unmet (which would give 1.6).
    expect(f.intrinsic_credibility).toBeCloseTo(8.1, 3);
  });

  it("inherits document-level credibility where the figure gives no override", () => {
    const rows = [row("r1", "2026-07-05T00:00:00Z", ["SD0201"], {
      casualties: { killed: { total: nf(10, "reported") } },
      narrative_and_confidence: { information_credibility: docUnmet },
    }, "2026-07-02T00:00:00Z")];
    const f = aggregateReports(rows, "SD0201")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    // no per-figure override → all six inherit the document's unmet → 1.6 + 0.
    expect(f.intrinsic_credibility).toBeCloseTo(1.6, 3);
  });
});
