/**
 * The impact-prior kind family (ADR-0010, V3): the bare kind, the per-source
 * kinds under it, the retired whole-prior kinds, and the labels
 * notifications use for them.
 */
import { describe, expect, it } from "vitest";
import {
  IMPACT_PRIOR_KIND,
  RETIRED_KINDS,
  impactPriorSource,
  isImpactPriorKind,
  isRetiredKind,
  taskKindLabel,
} from "../../src/utils/task-kinds.js";

describe("task kinds", () => {
  it("the family is the bare kind and anything dotted under it", () => {
    expect(IMPACT_PRIOR_KIND).toBe("event.impact_prior");
    expect(isImpactPriorKind("event.impact_prior")).toBe(true);
    expect(isImpactPriorKind("event.impact_prior.clear")).toBe(true);
    expect(isImpactPriorKind("event.impact_prior.web")).toBe(true);
    expect(isImpactPriorKind("event.impact_prior_other")).toBe(false);
    expect(isImpactPriorKind("event.other")).toBe(false);
  });

  it("the source is the suffix; the bare kind and outsiders have none", () => {
    expect(impactPriorSource("event.impact_prior.clear")).toBe("clear");
    expect(impactPriorSource("event.impact_prior.web")).toBe("web");
    expect(impactPriorSource("event.impact_prior")).toBeNull();
    expect(impactPriorSource("event.impact_prior.")).toBeNull();
    expect(impactPriorSource("event.other")).toBeNull();
  });

  it("labels name the source in a person's terms, and leave other kinds alone", () => {
    expect(taskKindLabel("event.impact_prior")).toBe("Impact prior");
    expect(taskKindLabel("event.impact_prior.clear")).toBe("Impact prior from CLEAR data");
    expect(taskKindLabel("event.impact_prior.web")).toBe("Web search");
    expect(taskKindLabel("event.impact_prior.satellite")).toBe("Impact prior from satellite");
    expect(taskKindLabel("event.other")).toBe("event.other");
  });

  it("retires exactly the whole-prior kinds — the bare one and .clear", () => {
    expect([...RETIRED_KINDS].sort()).toEqual(["event.impact_prior", "event.impact_prior.clear"]);
    expect(isRetiredKind("event.impact_prior")).toBe(true);
    expect(isRetiredKind("event.impact_prior.clear")).toBe(true);
    expect(isRetiredKind("event.impact_prior.web")).toBe(false);
    expect(isRetiredKind("event.impact_prior.satellite")).toBe(false);
    expect(isRetiredKind("event.impact_prior.clear_v2")).toBe(false);
    expect(isRetiredKind("event.other")).toBe(false);
  });
});
