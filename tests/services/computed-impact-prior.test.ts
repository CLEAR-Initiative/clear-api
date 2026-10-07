/**
 * The arithmetic of the computed ImpactPrior (V4), DB-free: one prior per
 * (metric, population group), median as the central value, the range as
 * the bounds, and the case count beside it.
 */
import { describe, expect, it } from "vitest";
import { MIN_CONFIDENT_CASES, summarisePriors } from "../../src/services/computed-impact-prior.js";

const ctx = { hazardType: "FL", countryLocationId: "c-1", horizonYears: 10 };
const row = (event_id: string, metric: string, value: number, population_group: string | null = null, unit: string | null = null) => ({
  event_id, estimate_id: `es-${event_id}-${metric}`, metric, population_group, unit, value,
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
      methodVersion: "clear-impact-prior@0.2.0",
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

  it("returns nothing without history", () => {
    expect(summarisePriors([], ctx)).toEqual([]);
  });
});
