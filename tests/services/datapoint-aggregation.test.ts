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
  buildApiMentions,
  estimateCurrentTotalFromRows,
  estimateStockFlowTotal,
  finaliseReadTimeQuality,
  FIELD_RULES,
  type LocationMetadataRow,
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

describe("aggregateReports — confidence band (ADR-0007 Phase 2)", () => {
  // Range-aware figure: spreads nf() and attaches a stated [low, high].
  const nfR = (value: number, low: number, high: number, confidence = "reported") => ({
    ...nf(value, confidence),
    value_low: low,
    value_high: high,
  });

  it("exact points → zero-width band (value_low == value_high == value)", () => {
    const rows = [row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: nf(8000) },
    }, "2026-07-02T00:00:00Z")];
    const f = aggregateReports(rows, "SD01")!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(8000);
    expect(f.value_low).toBe(8000);
    expect(f.value_high).toBe(8000);
    expect(f.range_width).toBe(0);
  });

  it("a stated range on one figure surfaces as the band", () => {
    const rows = [row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: nfR(8000, 7000, 9000) },
    }, "2026-07-02T00:00:00Z")];
    const f = aggregateReports(rows, "SD01")!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(8000);          // headline point unchanged
    expect(f.value_low).toBe(7000);
    expect(f.value_high).toBe(9000);
    expect(f.range_width).toBe(2000);
  });

  it("disagreeing latest_state figures widen the band to span both", () => {
    // Two exact stocks for the same week+location: latest wins the point,
    // but the band spans the disagreement.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
        displacement: { idp_stock: nf(8000) },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-05T00:00:00Z", ["SD01"], {
        displacement: { idp_stock: nf(6000) },
      }, "2026-07-05T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(6000);          // freshest wins the point
    expect(f.value_low).toBe(6000);
    expect(f.value_high).toBe(8000);
    expect(f.range_width).toBe(2000);    // the disagreement is visible
  });

  it("additive field sums the contributing ranges", () => {
    const rows = [row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
      casualties: { killed: { total: nfR(800, 700, 900) } },
    }, "2026-07-02T00:00:00Z")];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(800);
    expect(f.value_low).toBe(700);
    expect(f.value_high).toBe(900);
  });

  it("surfaces the field bias for late projection (§8)", () => {
    // killed_total is overreport → the consumer projects the band to its LOW end.
    const rows = [row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
      casualties: { killed: { total: nf(800) } },
    }, "2026-07-02T00:00:00Z")];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.bias).toBe("overreport");
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

  it("untyped superset does not sum onto its qualified sub-causes (ADR-0007 §7.3, #4)", () => {
    // conflict + flood are two distinct phenomena; an untyped figure can't be
    // assigned to one, so it stays a separate group (ADR-0002). But an untyped
    // total IS a superset of the qualified sub-causes in the same bucket, so
    // the containment rule takes max(Σ parts, whole), never parts + whole.
    const rows = [
      row("r-untyped", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(10) } }, // "10 killed", no cause
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
    // max(conflict 3 + flood 2 = 5, untyped whole 10) = 10 — NOT 15.
    expect(kt(aggregateReports(rows, "SD0201"))).toBe(10);
  });

  it("distinct qualified sub-causes still sum (disjoint phenomena, #4)", () => {
    // No untyped superset present → conflict and flood are disjoint → sum.
    const rows = [
      row("r-conflict", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(3) } },
      }),
      row("r-flood", "2026-07-02T00:00:00Z", ["SD0201"], {
        timing_and_scope: { event_types: ["flood"] },
        casualties: { killed: { total: nf(2) } },
      }),
    ];
    expect(kt(aggregateReports(rows, "SD0201"))).toBe(5);
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

describe("bias-aware selection — confidence override at graded reliability (#110)", () => {
  it("at reliability 3, a verified figure overrides a lower unverified one (killed_total)", () => {
    // The whole point of grading sources: at reliability 3 the verified→unverified
    // selectionQuality spread is 1.35 > DATA_QUALITY_MARGIN (1.0), so the override
    // fires and the verified figure wins — NOT the lower one the overreport bias
    // would otherwise pick. (Guards the reviewer's concern that the override was
    // unreachable — true only at reliability 1, where source_id is unbackfilled.)
    // Same source on both: §5 echo-dedup no longer collapses same-source REPORT
    // figures (only report echoes of an API figure), so both still compete.
    const rel = new Map<string, number | null>([["src-graded", 3]]);
    const rows = [
      row("r-verified", "2026-07-08T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: nf(50, "verified", "people", "SD01", "src-graded") } },
      }, "2026-07-08T00:00:00Z"),
      row("r-unverified", "2026-07-09T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: nf(30, "unverified", "people", "SD01", "src-graded") } },
      }, "2026-07-09T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01", rel)!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected a numeric field");
    expect(f.value).toBe(50);
  });

  it("at reliability 1 (ungraded), the override cannot fire and overreport bias picks the lower", () => {
    // Same figures, ungraded source (reliability 1): spread 0.45 < 1.0, so both
    // stay comparable and the overreport bias takes the lower value. This is the
    // documented pre-re-extraction fallback, not a bug. (#110)
    const rows = [
      row("r-verified", "2026-07-08T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: nf(50, "verified", "people", "SD01") } },
      }, "2026-07-08T00:00:00Z"),
      row("r-unverified", "2026-07-09T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: nf(30, "unverified", "people", "SD01") } },
      }, "2026-07-09T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01", new Map())!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected a numeric field");
    expect(f.value).toBe(30);
  });
});

describe("echo dedup — same publisher across event types (#115)", () => {
  it("two figures from one publisher on different event types SUM, not collapse", () => {
    // Regression for the §5 over-collapse: keying echo-dedup on (loc, bucket,
    // sourceId) alone merged a publisher's flood-killed and conflict-killed into
    // one before the additive sum. With the collapse scoped to API-echo groups,
    // these distinct event-type figures reach the incident grouping and sum.
    const rel = new Map<string, number | null>([["ocha", 3]]);
    const rows = [
      row("r-flood", "2026-07-08T00:00:00Z", ["SD01"], {
        timing_and_scope: { event_types: ["flood"] },
        casualties: { killed: { total: nf(20, "reported", "people", "SD01", "ocha") } },
      }, "2026-07-08T00:00:00Z"),
      row("r-conflict", "2026-07-09T00:00:00Z", ["SD01"], {
        timing_and_scope: { event_types: ["conflict"] },
        casualties: { killed: { total: nf(30, "reported", "people", "SD01", "ocha") } },
      }, "2026-07-09T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01", rel)!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected a numeric field");
    expect(f.value).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────────────
// LM P4a — location_metadata reconciliation (ADR-0006)
// ────────────────────────────────────────────────────────────────────

describe("buildApiMentions — DTM → idp_stock adapter (ADR-0006 §3/§8/§9)", () => {
  const orgMap = new Map([["iom dtm", { id: "src-dtm", reliability: 3 }]]);

  it("adapts a DTM blob into an idp_stock mention with the deterministic profile", () => {
    const rows: LocationMetadataRow[] = [{
      type: "iom_dtm_displacement",
      validFrom: new Date("2026-07-05T00:00:00Z"),
      data: { population_displaced: 52000, reporting_date: "2026-07-01T00:00:00Z" },
    }];
    const byLabel = buildApiMentions(rows, "SD01", orgMap);
    const idp = byLabel.get("idp_stock")!;
    expect(idp).toHaveLength(1);
    const m = idp[0]! as unknown as {
      value: number; reliability: number; confidence: string; locationId: string;
      intrinsicCredibility: number; publishedAt: Date; incidentDate: Date; reportId: string;
    };
    expect(m.value).toBe(52000);
    expect(m.reliability).toBe(3); // from the org map
    expect(m.confidence).toBe("reported"); // deterministic directness (§8)
    expect(m.locationId).toBe("SD01");
    // deterministic credibility: reported 2.0×0.8=1.6 + six met 6.5 = 8.1
    expect(m.intrinsicCredibility).toBeCloseTo(8.1, 3);
    expect(m.publishedAt.toISOString()).toBe("2026-07-05T00:00:00.000Z"); // recency = valid_from (§9)
    expect(m.incidentDate.toISOString()).toBe("2026-07-01T00:00:00.000Z"); // T₀ = reporting_date
    expect(m.reportId).toContain("api:src-dtm"); // synthetic provenance/dedup id
  });

  it("ignores context-overlay types and unknown reliabilities → 1", () => {
    const rows: LocationMetadataRow[] = [
      { type: "ocha_3w", validFrom: new Date("2026-07-05T00:00:00Z"), data: {} }, // overlay, no adapter
      { type: "iom_dtm_displacement", validFrom: new Date("2026-07-05T00:00:00Z"),
        data: { population_displaced: 10, reporting_date: "2026-07-01T00:00:00Z" } },
    ];
    const byLabel = buildApiMentions(rows, "SD01", new Map()); // no org → reliability 1
    expect(byLabel.has("ocha_3w")).toBe(false);
    expect((byLabel.get("idp_stock")![0]! as unknown as { reliability: number }).reliability).toBe(1);
  });
});

describe("aggregateReports — reconciliation (ADR-0006 §2)", () => {
  const orgMap = new Map([["iom dtm", { id: "src-dtm", reliability: 3 }]]);
  const dtm = (value: number, validFrom: string, refDate: string) =>
    buildApiMentions(
      [{ type: "iom_dtm_displacement", validFrom: new Date(validFrom),
         data: { population_displaced: value, reporting_date: refDate } }],
      "SD01", orgMap,
    );

  it("gap-fills a bucket with no reports from the authoritative API figure", () => {
    const result = aggregateReports([], "SD01", new Map(), dtm(52000, "2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z"));
    expect(result).not.toBeNull();
    const f = result!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(52000);
    expect(result!.reportCount).toBe(0); // no reports — API-sourced
  });

  it("freshens a stale report — the daily API figure (newer valid_from) wins idp_stock", () => {
    const rows = [row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: nf(48000, "reported") },
    }, "2026-06-30T00:00:00Z")];
    // Same month bucket; API valid_from (07-05) is fresher than the report (07-02).
    const f = aggregateReports(rows, "SD01", new Map(), dtm(52000, "2026-07-05T00:00:00Z", "2026-06-30T00:00:00Z"))!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(52000); // idp_stock is latest-wins → freshest (API) wins
    expect(f.contributing_report_ids.some((id) => id.startsWith("api:"))).toBe(true);
  });
});

describe("buildApiMentions — HAPI adapters (ADR-0006 §3)", () => {
  const orgs = new Map([
    ["unhcr", { id: "src-unhcr", reliability: 3 }],
    ["ocha", { id: "src-ocha", reliability: 3 }],
    ["ipc", { id: "src-ipc", reliability: 3 }],
  ]);
  const lmv = (type: string, data: Record<string, unknown>): LocationMetadataRow =>
    ({ type, data, validFrom: new Date("2026-07-08T00:00:00Z") });
  const val = (m: Map<string, unknown[]>, label: string) =>
    (m.get(label)?.[0] as { value: number } | undefined)?.value;

  it("refugees: sums only the REF population_group totals, not persons of concern", () => {
    const m = buildApiMentions([lmv("hapi_refugees", { records: [
      { gender: "all", age_range: "all", population_group: "REF", population: 312450, asylum_location_code: "TCD" },
      { gender: "all", age_range: "all", population_group: "REF", population: 100000, asylum_location_code: "EGY" },
      { gender: "all", age_range: "all", population_group: "ASY", population: 50000, asylum_location_code: "TCD" }, // asylum-seekers — excluded (#115)
      { gender: "female", age_range: "all", population_group: "REF", population: 999, asylum_location_code: "TCD" }, // breakdown — ignored
    ] })], "SDN", orgs);
    expect(val(m, "refugees")).toBe(412450);
  });

  it("returnees → returnee_stock (REF group only)", () => {
    const m = buildApiMentions([lmv("hapi_returnees", { records: [
      { gender: "all", age_range: "all", population_group: "REF", population: 250000 },
      { gender: "all", age_range: "all", population_group: "IDP", population: 90000 }, // returned IDPs — excluded (#115)
    ] })], "SDN", orgs);
    expect(val(m, "returnee_stock")).toBe(250000);
  });

  it("funding: requirements_usd → required, funding_usd → received", () => {
    const m = buildApiMentions([lmv("hapi_funding", { records: [
      { requirements_usd: 4.2e9, funding_usd: 1.1e9, appeal_code: "H" },
    ] })], "SDN", orgs);
    expect(val(m, "funding_required_usd")).toBe(4.2e9);
    expect(val(m, "funding_received_usd")).toBe(1.1e9);
  });

  it("humanitarian_needs: per-sector + overall in-need totals (INN, un-disaggregated)", () => {
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      { sector_code: "PRO", population_status: "INN", gender: "all", age_range: "all", population: 5_000_000 },
      { sector_code: "INTERSECTORAL", population_status: "INN", gender: "all", age_range: "all", population: 24_000_000 },
      { sector_code: "PRO", population_status: "TGT", gender: "all", age_range: "all", population: 999 }, // targeted — ignored
      { sector_code: "PRO", population_status: "INN", gender: "male", age_range: "all", population: 888 }, // breakdown — ignored
    ] })], "SDN", orgs);
    expect(val(m, "pin_protection")).toBe(5_000_000);
    expect(val(m, "overall_pin")).toBe(24_000_000);
  });

  it("humanitarian_needs: dedupes the category total/empty pair — no 2× (live blob cmse5d3gk…)", () => {
    // The real Sudan blob carries each sector twice at admin_level 0: once with
    // an empty category, once with category "total". Blind-summing reported ~2×.
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "", population: 7_900_000 },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "total", population: 7_943_720 },
      { sector_code: "PRO", population_status: "INN", admin_level: 0, category: "", population: 6_187_970 },
      { sector_code: "PRO", population_status: "INN", admin_level: 0, category: "total", population: 6_187_970 },
    ] })], "SDN", orgs);
    // Canonical "total" kept, empty dropped — NOT 15.84M / 12.38M.
    expect(val(m, "overall_pin")).toBe(7_943_720);
    expect(val(m, "pin_protection")).toBe(6_187_970);
  });

  it("humanitarian_needs: sums within one admin level — admin-0 total, not +admin-1 breakdown", () => {
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "total", population: 24_000_000 },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 1, category: "total", population: 10_000_000 },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 1, category: "total", population: 14_000_000 },
    ] })], "SDN", orgs);
    // Coarsest level (admin 0) is the national total; admin-1 states are NOT added on top.
    expect(val(m, "overall_pin")).toBe(24_000_000);
  });

  it("humanitarian_needs: with no national row, sums the admin-1 rows that tile the country", () => {
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 1, category: "total", population: 10_000_000 },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 1, category: "total", population: 14_000_000 },
    ] })], "SDN", orgs);
    // Same-level units sum — the admin-1 rows tile Sudan → national total.
    expect(val(m, "overall_pin")).toBe(24_000_000);
  });

  it("humanitarian_needs: keeps the latest edition — older HNO years don't sum on top", () => {
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "total", population: 30_440_770, reference_period_end: "2025-12-08" },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "", population: 33_699_770, reference_period_end: "2026-12-31" },
    ] })], "SDN", orgs);
    // Latest edition (2026) wins; the 2025 total is NOT added → 33.7M, not 64.1M.
    expect(val(m, "overall_pin")).toBe(33_699_770);
  });

  it("humanitarian_needs: drops population-group/age/sex subsets carried in `category`", () => {
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "", population: 33_699_770, reference_period_end: "2026-12-31" },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "Children", population: 15_646_556, reference_period_end: "2026-12-31" },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "Female", population: 15_311_707, reference_period_end: "2026-12-31" },
      { sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category: "IDP", population: 8_881_784, reference_period_end: "2026-12-31" },
    ] })], "SDN", orgs);
    // Subsets are contained in the total → excluded; only the aggregate counts.
    expect(val(m, "overall_pin")).toBe(33_699_770);
  });

  it("humanitarian_needs: real Sudan blob shape (editions × subgroups) → 33.7M, not 195M", () => {
    const rec = (category: string, population: number, end: string) => ({
      sector_code: "INTERSECTORAL", population_status: "INN", admin_level: 0, category, population, reference_period_end: end,
    });
    const m = buildApiMentions([lmv("hapi_humanitarian_needs", { records: [
      rec("", 33_699_770, "2026-12-31"),            // 2026 aggregate — the correct answer
      rec("total", 30_440_770, "2025-12-08"),       // 2025 aggregate — older edition
      rec("Children", 15_646_556, "2025-12-08"),
      rec("Female", 15_311_707, "2025-12-08"),
      rec("Male", 15_129_063, "2025-12-08"),
      rec("IDP", 8_881_784, "2025-12-08"),
      rec("Refugees", 892_161, "2025-12-08"),
      rec("Famine Response", 7_585_262, "2024-12-31"),
      rec("IDPs", 7_071_676, "2024-12-31"),
    ] })], "SDN", orgs);
    expect(val(m, "overall_pin")).toBe(33_699_770);
  });

  it("food_security: IPC current phase-3+ population", () => {
    const m = buildApiMentions([lmv("hapi_food_security", { records: [
      { ipc_type: "current", ipc_phase: "3+", population: 20_000_000 },
      { ipc_type: "projected", ipc_phase: "3+", population: 99 }, // not current — ignored
    ] })], "SDN", orgs);
    expect(val(m, "pin_food_security")).toBe(20_000_000);
  });
});

describe("aggregateReports — echo dedup (ADR-0006 §5)", () => {
  it("collapses a report echo of the same API source, not summing (funding_received)", () => {
    const rows = [row("r1", "2026-07-02T00:00:00Z", ["SD01"], {
      needs_and_funding: { overall_funding_received_usd: nf(1.1e9, "reported", "USD", undefined, "src-ocha") },
    }, "2026-07-05T00:00:00Z")];
    const api = buildApiMentions(
      [{ type: "hapi_funding", validFrom: new Date("2026-07-08T00:00:00Z"),
         data: { records: [{ requirements_usd: 4.2e9, funding_usd: 1.15e9, appeal_code: "H" }],
                 reference_period_end: "2026-07-05T00:00:00Z" } }],
      "SD01", new Map([["ocha", { id: "src-ocha", reliability: 3 }]]),
    );
    const f = aggregateReports(rows, "SD01", new Map(), api)!.data.funding_received_usd;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    // Same source id ("src-ocha") → one observation → latest (API 1.15e9), NOT 2.25e9.
    expect(f.value).toBe(1.15e9);
  });
});

describe("aggregateReports — flow breakpoint sweep (ADR-0007 §6.2)", () => {
  const kt = (r: ReturnType<typeof aggregateReports>) => {
    const f = r!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    return f.value;
  };
  const flowFig = (value: number, start: string, end: string) => ({
    ...nf(value, "reported"),
    basis_period_start: start,
    basis_period_end: end,
  });

  it("overlapping periods reconcile the overlap instead of double-counting (#2)", () => {
    // A: 2–10 Apr, 800 (100/day). B: 5–15 Apr, 660 (66/day). killed = overreport.
    // [2,5) A only → 300; [5,10) overlap → lower rate 66 → 330; [10,15) B → 330.
    const rows = [
      row("rA", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(800, "2026-04-02T00:00:00Z", "2026-04-10T00:00:00Z") } },
      }, "2026-04-10T00:00:00Z"),
      row("rB", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(660, "2026-04-05T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
    ];
    expect(kt(aggregateReports(rows, "SD01"))).toBe(960); // not 1460 (sum), not 800 (max)
  });

  it("disjoint periods sum (no overlap to reconcile)", () => {
    const rows = [
      row("rA", "2026-04-06T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(400, "2026-04-01T00:00:00Z", "2026-04-05T00:00:00Z") } },
      }, "2026-04-05T00:00:00Z"),
      row("rB", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(600, "2026-04-10T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
    ];
    expect(kt(aggregateReports(rows, "SD01"))).toBe(1000);
  });

  it("a single interval figure integrates to its own value", () => {
    const rows = [row("rA", "2026-04-11T00:00:00Z", ["SD01"], {
      casualties: { killed: { total: flowFig(800, "2026-04-02T00:00:00Z", "2026-04-10T00:00:00Z") } },
    }, "2026-04-10T00:00:00Z")];
    expect(kt(aggregateReports(rows, "SD01"))).toBe(800);
  });

  it("the overlap is decided by bias, not recency (publish order is irrelevant)", () => {
    // Same figures as the #2 case but with publish dates SWAPPED so the higher-
    // rate figure A (100/day) is now the freshest. The old recency gate would let
    // A take the overlap → 1130 (18% over-report). Under range reconciliation the
    // overlap is bias-projected (overreport → 66), so the point is still 960 —
    // recency can no longer inflate a flow the field is meant to resist inflating.
    const rows = [
      row("rA", "2026-04-20T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(800, "2026-04-02T00:00:00Z", "2026-04-10T00:00:00Z") } },
      }, "2026-04-10T00:00:00Z"),
      row("rB", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(660, "2026-04-05T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
    ];
    expect(kt(aggregateReports(rows, "SD01"))).toBe(960);
  });

  it("the overlap disagreement widens the band (union of covering rates)", () => {
    // [2,5) A only → [300,300]; [5,10) overlap → rate band [66,100] → [330,500];
    // [10,15) B only → [330,330]. Point projects to the low end (overreport), so
    // value == value_low == 960 and the A-vs-B disagreement surfaces as the 170
    // of upward width (value_high 1130) — not swallowed by a single winner.
    const rows = [
      row("rA", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(800, "2026-04-02T00:00:00Z", "2026-04-10T00:00:00Z") } },
      }, "2026-04-10T00:00:00Z"),
      row("rB", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flowFig(660, "2026-04-05T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(960);
    expect(f.value_low).toBe(960);
    expect(f.value_high).toBe(1130);
    expect(f.range_width).toBe(170);
  });
});

describe("aggregateReports — qualifier + measure_type projection (ADR-0007)", () => {
  // qualifier composes with the field bias: it is a HARD directional constraint,
  // the bias breaks the tie within it.

  it("qualifier at_least raises the overreport floor (headline not projected below it)", () => {
    // killed = overreport (lean low). Two competing figures for one incident: an
    // exact 400 and an `at_least 500`. The 500 asserts truth ≥ 500, so the
    // overreport projection may not land on 400 — the floor binds.
    const rows = [
      row("r1", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: nf(400, "reported") } },
      }, "2026-04-10T00:00:00Z"),
      row("r2", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: { ...nf(500, "reported"), qualifier: "at_least", value_low: 500, value_high: 800 } } },
      }, "2026-04-10T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(500); // the at_least floor, not the lower exact 400
  });

  it("qualifier at_most caps the underreport ceiling (headline not projected above it)", () => {
    // new_displacements = underreport (lean high). An exact 800 vs `at_most 700`.
    // The 700 asserts truth ≤ 700, so the lean-high projection is capped there.
    const rows = [
      row("r1", "2026-04-11T00:00:00Z", ["SD01"], {
        displacement: { new_displacements: nf(800, "reported") },
      }, "2026-04-10T00:00:00Z"),
      row("r2", "2026-04-11T00:00:00Z", ["SD01"], {
        displacement: { new_displacements: { ...nf(700, "reported"), qualifier: "at_most", value_low: 500, value_high: 700 } },
      }, "2026-04-10T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.new_displacements;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(700); // capped at the at_most ceiling, not the higher 800
  });

  it("qualifier approx / exact leave the bias pick unchanged", () => {
    // approx asserts no firm bound → overreport still picks the lower value.
    const rows = [
      row("r1", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: { ...nf(400, "reported"), qualifier: "approx", value_low: 380, value_high: 420 } } },
      }, "2026-04-10T00:00:00Z"),
      row("r2", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: { ...nf(500, "reported"), qualifier: "approx", value_low: 470, value_high: 530 } } },
      }, "2026-04-10T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(400); // overreport → lower value; approx adds no constraint
  });

  const flow = (value: number, start: string, end: string) => ({
    ...nf(value, "reported"),
    basis_period_start: start, basis_period_end: end, measure_type: "period_flow",
  });
  const cumul = (value: number, start: string, end: string) => ({
    ...nf(value, "reported"),
    basis_period_start: start, basis_period_end: end, measure_type: "cumulative_to_date",
  });

  it("a running total subsumes the reported flows inside its span (no double-count)", () => {
    // Cumulative 5000 killed Jan–Apr is the authoritative total-to-date; a 200
    // weekly flow inside that span is already counted in it → dropped, not added.
    const rows = [
      row("rFlow", "2026-04-10T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flow(200, "2026-04-06T00:00:00Z", "2026-04-09T00:00:00Z") } },
      }, "2026-04-09T00:00:00Z"),
      row("rCumul", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul(5000, "2026-01-01T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBeCloseTo(5000, 4); // not 5200 (sum) — the flow is subsumed
  });

  it("consecutive cumulative snapshots are differenced, not summed", () => {
    // C(Mar31)=3000 then C(Apr30)=5000 → increments 3000 + 2000 = 5000, not 8000.
    const rows = [
      row("rC1", "2026-04-01T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul(3000, "2026-01-01T00:00:00Z", "2026-03-31T00:00:00Z") } },
      }, "2026-03-31T00:00:00Z"),
      row("rC2", "2026-05-01T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul(5000, "2026-01-01T00:00:00Z", "2026-04-30T00:00:00Z") } },
      }, "2026-04-30T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBeCloseTo(5000, 4); // latest running total via differencing, NOT 8000
  });

  it("a reported flow AFTER the last snapshot extends the total", () => {
    // Cumulative 5000 to Apr15 + a 300 flow Apr20–27 (outside coverage) → 5300.
    const rows = [
      row("rCumul", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul(5000, "2026-01-01T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
      row("rFlow", "2026-04-28T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flow(300, "2026-04-20T00:00:00Z", "2026-04-27T00:00:00Z") } },
      }, "2026-04-27T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBeCloseTo(5300, 4);
  });

  it("period_flow figures are unaffected — the sweep still reconciles them (960)", () => {
    // Boundary: with no running total present, the flow sweep behaves as before.
    const rows = [
      row("rA", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flow(800, "2026-04-02T00:00:00Z", "2026-04-10T00:00:00Z") } },
      }, "2026-04-10T00:00:00Z"),
      row("rB", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flow(660, "2026-04-05T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(960);
  });

  // ── Review fixes B2–B6 ──────────────────────────────────────────────

  it("B3: opposing qualifiers don't breach a bound (no silent ceiling break)", () => {
    // at_least 500 AND at_most 400 for one incident is an impossible contradiction.
    // The old code returned 500 under overreport, breaching the 400 ceiling; now it
    // falls back to the freshest (here the at_most 400) rather than breach it.
    const rows = [
      row("r1", "2026-04-05T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: { ...nf(500, "reported"), qualifier: "at_least", value_low: 500, value_high: 800 } } },
      }, "2026-04-10T00:00:00Z"),
      row("r2", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: { ...nf(400, "reported"), qualifier: "at_most", value_low: 300, value_high: 400 } } },
      }, "2026-04-10T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(400); // freshest; NOT 500 (which would breach the ceiling)
  });

  it("B6: a stale at_least floor still binds despite the recency gate", () => {
    // r1 (`at_least 500`) is published 10 days before r2 — outside killed's 3.5-day
    // override reach, so the recency gate drops it from the bias pool. Its floor
    // must still bind (same week's measurement), so the headline is 500, not 300.
    const rows = [
      row("r1", "2026-04-01T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: { ...nf(500, "reported"), qualifier: "at_least", value_low: 500, value_high: 900 } } },
      }, "2026-04-10T00:00:00Z"),
      row("r2", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: nf(300, "reported") } },
      }, "2026-04-10T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(500); // floor binds from the whole group, not just fresh rows
  });

  it("B2: a no-origin cumulative base is summed, not reconciled away", () => {
    // Two cumulatives, the earliest with NO stated origin. The base (5000) must be
    // summed with the later increment (8000−5000=3000) → 8000, not lost to overlap.
    const cumulNoOrigin = (value: number) => ({ ...nf(value, "reported"), measure_type: "cumulative_to_date" });
    const rows = [
      row("rC1", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumulNoOrigin(5000) } },
      }, "2026-04-10T00:00:00Z"),
      row("rC2", "2026-04-18T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumulNoOrigin(8000) } },
      }, "2026-04-17T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBeCloseTo(8000, 4); // base 5000 + increment 3000, not swallowed
  });

  it("B4: a cumulative reset recovers post-reset accrual (not zeroed)", () => {
    // Running total drops 8000 → 2000 (counter reset). Expected 8000 + 2000 = 10000,
    // not 8000 (the old `max(0, cur−prev)=0` dropped the 2000).
    const cumul2 = (value: number, start: string, end: string) => ({
      ...nf(value, "reported"), basis_period_start: start, basis_period_end: end, measure_type: "cumulative_to_date",
    });
    const rows = [
      row("rC1", "2026-04-11T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul2(8000, "2026-01-01T00:00:00Z", "2026-04-10T00:00:00Z") } },
      }, "2026-04-10T00:00:00Z"),
      row("rC2", "2026-04-25T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul2(2000, "2026-04-11T00:00:00Z", "2026-04-24T00:00:00Z") } },
      }, "2026-04-24T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBeCloseTo(10000, 4);
  });

  it("B5: a partial-overlap reported flow keeps its non-overlapping portion", () => {
    // Cumulative covers Jan–Apr15; a 1500 flow over Apr10–25 (15d) straddles the
    // boundary. The Apr15–25 portion (10d → 1000) is kept; the Apr10–15 overlap is
    // subsumed. Total 5000 + 1000 = 6000, not 5000 (whole flow dropped).
    const rows = [
      row("rCumul", "2026-04-16T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: cumul(5000, "2026-01-01T00:00:00Z", "2026-04-15T00:00:00Z") } },
      }, "2026-04-15T00:00:00Z"),
      row("rFlow", "2026-04-26T00:00:00Z", ["SD01"], {
        casualties: { killed: { total: flow(1500, "2026-04-10T00:00:00Z", "2026-04-25T00:00:00Z") } },
      }, "2026-04-25T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01")!.data.killed_total;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBeCloseTo(6000, 4);
  });
});

describe("aggregateReports — divergence guard (ADR-0006 §7)", () => {
  const dtm = (value: number, validFrom: string, refDate: string) =>
    buildApiMentions(
      [{ type: "iom_dtm_displacement", validFrom: new Date(validFrom),
         data: { population_displaced: value, reporting_date: refDate } }],
      "SD01", new Map([["iom dtm", { id: "src-dtm", reliability: 3 }]]),
    );

  it("a report figure >25% off the API figure loses to it, with a signal", () => {
    // Report is fresher (would win latest-wins) but 42% below the DTM figure.
    const rows = [row("r1", "2026-07-10T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: nf(30000, "reported") },
    }, "2026-06-30T00:00:00Z")];
    const f = aggregateReports(rows, "SD01", new Map(), dtm(52000, "2026-07-05T00:00:00Z", "2026-06-30T00:00:00Z"))!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(52000); // authoritative API wins the large disagreement
    expect(f.divergence).toBeTruthy();
    expect(f.divergence!.reportValue).toBe(30000);
    expect(f.divergence!.apiValue).toBe(52000);
    expect(f.divergence!.pctDiff).toBeCloseTo(-42.3, 1);
    // #115: the API value must carry the API's grades, not the losing report's
    // (reliability 1 / intrinsic 1.6) — else the aggregate scores ~1.2/10.
    expect(f.reliability).toBe(3);
    expect(f.intrinsic_credibility).toBeCloseTo(8.1, 1);
  });

  it("within 25% → no guard; the fresher report still wins, no signal", () => {
    const rows = [row("r1", "2026-07-10T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: nf(50000, "reported") },
    }, "2026-06-30T00:00:00Z")];
    const f = aggregateReports(rows, "SD01", new Map(), dtm(52000, "2026-07-05T00:00:00Z", "2026-06-30T00:00:00Z"))!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(50000); // fresher report wins (3.8% < 25%)
    expect(f.divergence == null).toBe(true);
  });

  it("§9: an API anchor INSIDE the report band is agreement — no signal", () => {
    // Report gives a wide band [30k, 55k]; DTM 52k falls inside it, so the
    // anchor tightens rather than diverges — the fresher report value wins.
    const rows = [row("r1", "2026-07-10T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: { ...nf(40000, "reported"), value_low: 30000, value_high: 55000 } },
    }, "2026-06-30T00:00:00Z")];
    const f = aggregateReports(rows, "SD01", new Map(), dtm(52000, "2026-07-05T00:00:00Z", "2026-06-30T00:00:00Z"))!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(40000);         // report wins; anchor inside band
    expect(f.divergence == null).toBe(true);
  });

  it("§9: an API anchor OUTSIDE the report band is the divergence — API wins", () => {
    // Report band is tight [35k, 45k]; DTM 52k is outside it → disjoint → signal.
    const rows = [row("r1", "2026-07-10T00:00:00Z", ["SD01"], {
      displacement: { idp_stock: { ...nf(40000, "reported"), value_low: 35000, value_high: 45000 } },
    }, "2026-06-30T00:00:00Z")];
    const f = aggregateReports(rows, "SD01", new Map(), dtm(52000, "2026-07-05T00:00:00Z", "2026-06-30T00:00:00Z"))!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(52000);         // API wins the disjoint disagreement
    expect(f.divergence).toBeTruthy();
    expect(f.divergence!.reportValue).toBe(40000);
    expect(f.divergence!.apiValue).toBe(52000);
  });

  it("§9: two EXACT disagreeing figures don't fake a band — % fallback still fires", () => {
    // Both figures are exact points (no stated width): 30k and 80k. Their spread
    // [30k, 80k] is NOT a measurement band. A DTM anchor at 55k sits between them
    // — the old aggregate-spread test read that as "inside the band" and let the
    // 30k report stand. Per-figure width → hasRealBand=false → the 25% fallback
    // vs the headline fires (30k is 45% below 55k) → the authoritative API wins.
    const rows = [
      row("r1", "2026-07-10T00:00:00Z", ["SD01"], {
        displacement: { idp_stock: nf(30000, "reported") },
      }, "2026-06-30T00:00:00Z"),
      row("r2", "2026-07-08T00:00:00Z", ["SD01"], {
        displacement: { idp_stock: nf(80000, "reported") },
      }, "2026-06-30T00:00:00Z"),
    ];
    const f = aggregateReports(rows, "SD01", new Map(), dtm(55000, "2026-07-05T00:00:00Z", "2026-06-30T00:00:00Z"))!.data.idp_stock;
    if (!f || !("value" in f)) throw new Error("expected numeric field");
    expect(f.value).toBe(55000);         // API wins; the exact spread is not a band
    expect(f.divergence).toBeTruthy();
    expect(f.divergence!.apiValue).toBe(55000);
  });
});

describe("estimateStockFlowTotal — current total (ADR-0006 §4)", () => {
  const d = (s: string) => new Date(s);

  it("adds only flows whose as-of is after the stock's T₀", () => {
    const est = estimateStockFlowTotal(
      { value: 100000, t0: d("2026-06-30T00:00:00Z") },
      [
        { value: 5000, asOf: d("2026-06-15T00:00:00Z") }, // before T₀ — already in stock
        { value: 3000, asOf: d("2026-07-05T00:00:00Z") }, // after T₀ — accrues
        { value: 2000, asOf: d("2026-07-12T00:00:00Z") }, // after T₀ — accrues
      ],
    );
    expect(est).not.toBeNull();
    expect(est!.stock).toBe(100000);
    expect(est!.flowsSince).toBe(5000);
    expect(est!.total).toBe(105000);
    expect(est!.flowCount).toBe(2);
    expect(est!.t0).toBe("2026-06-30T00:00:00.000Z");
  });

  it("a flow exactly at T₀ is treated as already embedded (strict >)", () => {
    const est = estimateStockFlowTotal(
      { value: 100000, t0: d("2026-06-30T00:00:00Z") },
      [{ value: 5000, asOf: d("2026-06-30T00:00:00Z") }],
    );
    expect(est!.total).toBe(100000);
    expect(est!.flowCount).toBe(0);
  });

  it("no stock anchor → null (nothing to accrue onto)", () => {
    expect(estimateStockFlowTotal(null, [{ value: 5000, asOf: d("2026-07-05T00:00:00Z") }])).toBeNull();
  });

  it("no forward flows → total equals the stock", () => {
    const est = estimateStockFlowTotal({ value: 80000, t0: d("2026-06-30T00:00:00Z") }, []);
    expect(est!.total).toBe(80000);
    expect(est!.flowsSince).toBe(0);
  });
});

describe("estimateCurrentTotalFromRows — current total from rows (ADR-0006 §4)", () => {
  const asOf = new Date("2026-08-01T00:00:00Z");
  const rel = new Map<string, number | null>();

  it("latest stock + only the flows dated after its T₀", () => {
    const rows = [
      row("s1", "2026-07-01T00:00:00Z", ["SD01"], { displacement: { idp_stock: nf(100000) } }, "2026-06-30T00:00:00Z"),
      row("f0", "2026-06-20T00:00:00Z", ["SD01"], { displacement: { new_displacements: nf(5000) } }, "2026-06-15T00:00:00Z"),
      row("f1", "2026-07-16T00:00:00Z", ["SD01"], { displacement: { new_displacements: nf(3000) } }, "2026-07-15T00:00:00Z"),
      row("f2", "2026-07-23T00:00:00Z", ["SD01"], { displacement: { new_displacements: nf(2000) } }, "2026-07-22T00:00:00Z"),
    ];
    const est = estimateCurrentTotalFromRows(rows, new Map(), "SD01", "idp_stock", "new_displacements", rel, asOf);
    expect(est).not.toBeNull();
    expect(est!.stock).toBe(100000);
    expect(est!.flowsSince).toBe(5000); // 3000 + 2000; the 5000 before T₀ is dropped
    expect(est!.total).toBe(105000);
    expect(est!.t0).toBe("2026-06-30T00:00:00.000Z");
  });

  it("no stock in scope → null (nothing to anchor)", () => {
    const rows = [row("f1", "2026-07-16T00:00:00Z", ["SD01"], { displacement: { new_displacements: nf(3000) } }, "2026-07-15T00:00:00Z")];
    expect(estimateCurrentTotalFromRows(rows, new Map(), "SD01", "idp_stock", "new_displacements", rel, asOf)).toBeNull();
  });

  it("out-of-scope figures are ignored (exact scope match)", () => {
    const rows = [row("s1", "2026-07-01T00:00:00Z", ["SD99"], { displacement: { idp_stock: nf(100000) } }, "2026-06-30T00:00:00Z")];
    expect(estimateCurrentTotalFromRows(rows, new Map(), "SD01", "idp_stock", "new_displacements", rel, asOf)).toBeNull();
  });

  it("a fresher API stock anchors over an older report stock", () => {
    const rows = [
      row("s1", "2026-05-01T00:00:00Z", ["SD01"], { displacement: { idp_stock: nf(80000) } }, "2026-04-30T00:00:00Z"),
      row("f1", "2026-07-16T00:00:00Z", ["SD01"], { displacement: { new_displacements: nf(3000) } }, "2026-07-15T00:00:00Z"),
    ];
    const api = buildApiMentions(
      [{ type: "iom_dtm_displacement", validFrom: new Date("2026-07-05T00:00:00Z"),
         data: { population_displaced: 120000, reporting_date: "2026-06-30T00:00:00Z" } }],
      "SD01", new Map([["iom dtm", { id: "src-dtm", reliability: 3 }]]),
    );
    const est = estimateCurrentTotalFromRows(rows, api, "SD01", "idp_stock", "new_displacements", rel, asOf);
    expect(est!.stock).toBe(120000); // API ref 2026-06-30 beats report ref 2026-04-30
    expect(est!.t0).toBe("2026-06-30T00:00:00.000Z");
    expect(est!.flowsSince).toBe(3000);
    expect(est!.total).toBe(123000);
  });
});
