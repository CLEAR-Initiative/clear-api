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
  FIELD_RULES,
  type ReportRow,
} from "../../src/services/datapoint-aggregation.js";

/** Convenience — build a NumericField dict as the LLM emits it. */
function nf(value: number, confidence = "reported", unit = "people") {
  return {
    value,
    unit,
    confidence,
    source_quote: "…",
    chunk_index: 0,
    page_number: 1,
  };
}

/** Convenience — build a minimal ReportRow. `data` receives whatever
 *  shape the caller wants to test (the aggregator walks it by path). */
function row(
  reportId: string,
  publishedAt: string,
  locationIds: string[],
  data: Record<string, unknown>,
  reportingPeriodEnd?: string,
): ReportRow {
  return {
    reportId,
    publishedAt: new Date(publishedAt),
    reportingPeriodStart: null,
    reportingPeriodEnd: reportingPeriodEnd ? new Date(reportingPeriodEnd) : new Date(publishedAt),
    locationIds,
    data,
  };
}

describe("FIELD_RULES registry", () => {
  it("every rule declares a valid kind and a policy", () => {
    const validKinds = new Set([
      "additive_count", "latest_state", "set_union", "max", "non_aggregatable",
    ]);
    const validPolicies = new Set([
      "latest_wins", "max_within_report_then_latest", "set_union_all",
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
  it("sums two distinct-day incidents in the same week + location", () => {
    // Different days → different incident keys → both counted.
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
    expect(field.value).toBe(8);
    expect(field.contributing_report_ids.sort()).toEqual(["r1", "r2"]);
  });

  it("dedupes same-day competing reports — latest publishedAt wins", () => {
    // Same day, same location → same incident key. Both are competing
    // observations of one event; the newer publication wins.
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
    // Not 25 (naïve sum) — 15 (winner value).
    expect(field.value).toBe(15);
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

describe("aggregateReports — location scoping", () => {
  it("filters to the target location before aggregating", () => {
    // Two locations, two reports each. Scoping to SD0201 must only
    // aggregate its reports, ignoring the SD0301 pair.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-04T00:00:00Z", ["SD0301"], {
        casualties: { killed: { total: nf(100) } },
      }, "2026-07-04T00:00:00Z"),
    ];
    const scoped = aggregateReports(rows, "SD0201");
    const scopedField = scoped!.data.killed_total;
    if (!scopedField || !("value" in scopedField)) throw new Error("expected numeric field");
    expect(scopedField.value).toBe(3);

    // Country-wide (null) sees both.
    const countryWide = aggregateReports(rows, null);
    const cwField = countryWide!.data.killed_total;
    if (!cwField || !("value" in cwField)) throw new Error("expected numeric field");
    // Different day buckets → both incidents count.
    expect(cwField.value).toBe(103);
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

  it("mixes tiers correctly when reports have different confidences", () => {
    // One verified (weight 1.0) + one media (weight 0.3) → mean ≈ 0.65.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3, "verified") } },
      }, "2026-07-02T00:00:00Z"),
      row("r2", "2026-07-04T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(5, "media") } },
      }, "2026-07-04T00:00:00Z"),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("quality_score" in field)) throw new Error("expected numeric field");
    expect(field.quality_score).toBeCloseTo(0.65, 2);
    expect(field.confidence_mix.verified).toBeCloseTo(0.5, 4);
    expect(field.confidence_mix.media).toBeCloseTo(0.5, 4);
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

  it("distinct locations don't share incident keys even in the same week", () => {
    // Same week but different A2s → distinct incidents → both sum.
    const rows = [
      row("r1", "2026-07-08T00:00:00Z", ["SD0201"], {
        casualties: { killed: { total: nf(3) } },
      }, "2026-07-08T00:00:00Z"),
      row("r2", "2026-07-08T00:00:00Z", ["SD0301"], {
        casualties: { killed: { total: nf(5) } },
      }, "2026-07-08T00:00:00Z"),
    ];
    // Country-wide roll-up should sum across both locations.
    const result = aggregateReports(rows, null);
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(8);
  });

  it("unlocated report (empty locationIds) contributes under empty-location bucket", () => {
    // When the LLM emits data but the resolver couldn't tie ANY
    // location, the row still contributes to country-wide roll-ups
    // via the empty-string location. Prevents silent data loss on
    // locate-fail reports.
    const rows = [
      row("r1", "2026-07-05T00:00:00Z", [], {
        casualties: { killed: { total: nf(7) } },
      }, "2026-07-05T00:00:00Z"),
    ];
    // Location-scoped query: the empty-location bucket doesn't match
    // "SD0201" scope → null.
    const scoped = aggregateReports(rows, "SD0201");
    expect(scoped!.data.killed_total).toBeNull();
    // Country-wide (null) sees it.
    const cw = aggregateReports(rows, null);
    const field = cw!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(7);
  });

  it("multi-location report contributes to each location scope", () => {
    // One report tagged with two A2s. Scoping to A2-1 gets the
    // report's value; scoping to A2-2 also gets it. Country-wide
    // sees TWO mentions but they dedupe to one incident-per-location.
    const rows = [
      row("r-multi", "2026-07-05T00:00:00Z", ["SD0201", "SD0301"], {
        casualties: { killed: { total: nf(4) } },
      }, "2026-07-05T00:00:00Z"),
    ];
    const scoped1 = aggregateReports(rows, "SD0201");
    const scoped2 = aggregateReports(rows, "SD0301");
    const field1 = scoped1!.data.killed_total;
    const field2 = scoped2!.data.killed_total;
    if (!field1 || !("value" in field1)) throw new Error("expected numeric field");
    if (!field2 || !("value" in field2)) throw new Error("expected numeric field");
    expect(field1.value).toBe(4);
    expect(field2.value).toBe(4);
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
    // Latest wins → 5 (not 8).
    expect(field.value).toBe(5);
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
 * Known defects — see clear-context-pipeline/docs/adr/0002-deduplicate-at-figure-scope.md
 * and clear-api/docs/adr/0001-country-scope-dedups-by-report.md.
 *
 * Both are marked `it.fails`, so the suite stays green while the defects
 * exist AND trips the moment either is fixed — `it.fails` reports a
 * failure when the body starts passing. When you fix one, delete the
 * `.fails` and this comment; do not delete the test.
 *
 * Reports are ANALYTICAL: a figure is a total already aggregated at source
 * over a Figure Scope — (location, admin_level, period, event-type set).
 * Deduplication is only for competing observations of the same scope.
 */
describe("KNOWN DEFECT — report-level figure fanned across mentioned locations", () => {
  // A report states one scoped total ("10 killed in El Fasher") but
  // `locations` holds every place it discusses — the country for context,
  // the state, the town. Nothing records which one the figure is scoped
  // to, so extractNumericMentions fans the value to all three. At country
  // scope each copy lands in its own incident group and additive_count
  // sums them: 10 becomes 30, inflated by however many places the report
  // happened to name. Fixed by extracting Figure Scope (ADR-0002).
  it.fails("one report, 10 killed, 3 places mentioned → country-wide is 10, not 30", () => {
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SDN", "SD02", "SD0201"], {
        casualties: { killed: { total: nf(10) } },
      }),
    ];
    const result = aggregateReports(rows, null);
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(10);
  });

  it("location-scoped aggregation is correct today — only country scope inflates", () => {
    // Pins the blast radius: the defect above is country-scope-only, so a
    // stopgap there (clear-api ADR-0001) need not touch this path.
    //
    // REVISIT when Figure Scope lands: this row carries no scope, so the
    // figure reaches SD0201 only via the fan-out. Once a figure declares
    // its scope, it reaches that location and no other — a figure scoped
    // to SDN would correctly return null here. Do not read this test as a
    // requirement to keep fan-out alive.
    const rows = [
      row("r1", "2026-07-02T00:00:00Z", ["SDN", "SD02", "SD0201"], {
        casualties: { killed: { total: nf(10) } },
      }),
    ];
    const result = aggregateReports(rows, "SD0201");
    const field = result!.data.killed_total;
    if (!field || !("value" in field)) throw new Error("expected numeric field");
    expect(field.value).toBe(10);
  });
});

describe("KNOWN DEFECT — incident key omits event type", () => {
  // §6.4.1 specifies the key as (event, location, time_bucket); the
  // implementation builds `${locationId}|${bucketDate(...)}`. Two distinct
  // event types in one place on one day are therefore treated as competing
  // observations of one thing, and all but the freshest are discarded.
  // Deduplication is only for the SAME (location, period, event type) —
  // a conflict total and a flood total are different phenomena and sum.
  it.fails("clash (5) + flood (3), same place same day → 8, not 3", () => {
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

  it.fails("both reports stay in provenance — neither event is silently dropped", () => {
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
});
