/**
 * The arithmetic of the computed ImpactPrior (V4), DB-free: one prior per
 * (metric, population group), median as the central value, the range as
 * the bounds, and the case count beside it — from observed figures only.
 */
import { describe, expect, it } from "vitest";
import { EstimateMethod } from "../../src/generated/prisma/enums.js";
import {
  MIN_CONFIDENT_CASES,
  OBSERVED_ESTIMATE_METHODS,
  summarisePriors,
} from "../../src/services/computed-impact-prior.js";

const ctx = { hazardType: "FL", countryLocationId: "c-1", horizonYears: 10 };
const row = (
  event_id: string,
  metric: string,
  value: number,
  population_group: string | null = null,
  unit: string | null = null,
  method = "media_report",
) => ({
  event_id, estimate_id: `es-${event_id}-${metric}`, metric, population_group, unit, method, value,
});

describe("summarisePriors", () => {
  it("summarises each metric and population group on its own, most evidence first", () => {
    const priors = summarisePriors(
      [
        row("e1", "people_displaced_new", 1000),
        row("e2", "people_displaced_new", 4000),
        row("e3", "people_displaced_new", 2500),
        row("e1", "people_affected", 9000),
        row("e2", "people_displaced_new", 300, "IDP"),
      ],
      ctx,
    );
    expect(priors.map((p) => [p.metric, p.populationGroup, p.numberOfCases])).toEqual([
      ["people_displaced_new", null, 3],
      ["people_affected", null, 1],
      ["people_displaced_new", "IDP", 1],
    ]);
    expect(priors[0]).toMatchObject({
      ...ctx,
      centralValue: 2500,
      lowerBound: 1000,
      upperBound: 4000,
      lowConfidence: false,
      eventIds: ["e1", "e2", "e3"],
      basisMethods: [{ method: "media_report", count: 3 }],
      methodVersion: "clear-impact-prior@0.3.0",
    });
  });

  it("takes the mean of the middle two for an even count", () => {
    const [p] = summarisePriors([row("a", "people_affected", 10), row("b", "people_affected", 40), row("c", "people_affected", 20), row("d", "people_affected", 30)], ctx);
    expect(p).toMatchObject({ centralValue: 25, lowerBound: 10, upperBound: 40, numberOfCases: 4 });
  });

  it(`flags a prior on fewer than ${MIN_CONFIDENT_CASES} cases as low-confidence`, () => {
    const [p] = summarisePriors([row("a", "people_affected", 10), row("b", "people_affected", 20)], ctx);
    expect(p).toMatchObject({ numberOfCases: 2, lowConfidence: true, centralValue: 15 });
  });

  it("never summarises figures in different units together", () => {
    const priors = summarisePriors(
      [row("a", "people_affected", 1000), row("b", "people_affected", 200, null, "households"), row("c", "people_affected", 3000)],
      ctx,
    );
    expect(priors.map((p) => [p.unit, p.numberOfCases, p.centralValue])).toEqual([
      [null, 2, 2000],
      ["households", 1, 200],
    ]);
  });

  it("ignores figures nobody observed: backfilled placeholders, model output, prior-derived", () => {
    const priors = summarisePriors(
      [
        row("a", "people_affected", 1000),
        row("b", "people_affected", 3000, null, null, "government_figure"),
        row("c", "people_affected", 25_794, null, null, "not_documented"),
        row("d", "people_affected", 2_000_000, null, null, "model_inference"),
        row("e", "people_affected", 50_000, null, null, "exposure_model"),
        row("f", "people_affected", 4000, null, null, "prior_caseload_analogue"),
      ],
      ctx,
    );
    expect(priors).toHaveLength(1);
    expect(priors[0]).toMatchObject({ centralValue: 2000, lowerBound: 1000, upperBound: 3000, numberOfCases: 2 });
    expect(priors[0].eventIds).toEqual(["a", "b"]);
  });

  it("returns no prior when every figure is unobserved", () => {
    expect(summarisePriors([row("a", "people_affected", 25_794, null, null, "not_documented")], ctx)).toEqual([]);
  });

  it("counts the methods a prior rests on, most common first", () => {
    const [p] = summarisePriors(
      [
        row("a", "people_affected", 1),
        row("b", "people_affected", 2, null, null, "government_figure"),
        row("c", "people_affected", 3, null, null, "government_figure"),
      ],
      ctx,
    );
    expect(p.basisMethods).toEqual([
      { method: "government_figure", count: 2 },
      { method: "media_report", count: 1 },
    ]);
  });

  it("returns nothing without history", () => {
    expect(summarisePriors([], ctx)).toEqual([]);
  });
});

describe("OBSERVED_ESTIMATE_METHODS", () => {
  it("is exactly the observed or reported methods", () => {
    expect([...OBSERVED_ESTIMATE_METHODS].sort()).toEqual(
      [
        "field_staff_judgement",
        "formal_assessment",
        "government_figure",
        "media_report",
        "partner_or_cluster_figure",
        "rapid_assessment",
        "registration",
      ],
    );
  });

  it("leaves out exactly the unobserved methods, so a new method needs a decision here", () => {
    const excluded = Object.values(EstimateMethod).filter(
      (m) => !(OBSERVED_ESTIMATE_METHODS as readonly string[]).includes(m),
    );
    expect(excluded.sort()).toEqual(["exposure_model", "model_inference", "not_documented", "prior_caseload_analogue"]);
  });
});
