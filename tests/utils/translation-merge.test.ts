import { describe, it, expect } from "vitest";
import { deepMergeTranslation } from "../../src/utils/translation-merge.js";

describe("deepMergeTranslation", () => {
  it("replaces a scalar prose leaf with the overlay value", () => {
    expect(deepMergeTranslation("hello", "hola")).toBe("hola");
  });

  it("keeps canonical when the overlay leaf is null/undefined", () => {
    expect(deepMergeTranslation("hello", null)).toBe("hello");
    expect(deepMergeTranslation("hello", undefined)).toBe("hello");
  });

  it("merges objects key-by-key, preserving canonical keys the overlay omits", () => {
    const canonical = {
      text: "Displacement rose.",
      source_report_ids: ["r1", "r2"],
      contributing_sources: { r1: ["Displacement rose."] },
    };
    const overlay = { text: "El desplazamiento aumentó." };
    expect(deepMergeTranslation(canonical, overlay)).toEqual({
      text: "El desplazamiento aumentó.",
      source_report_ids: ["r1", "r2"],
      contributing_sources: { r1: ["Displacement rose."] },
    });
  });

  it("merges arrays element-wise by index (SourcedBullet keeps its ids)", () => {
    const canonical = [
      { description: "Flooding", source_report_ids: ["r1"] },
      { description: "Drought", source_report_ids: ["r2"] },
    ];
    const overlay = [{ description: "Inundación" }, { description: "Sequía" }];
    expect(deepMergeTranslation(canonical, overlay)).toEqual([
      { description: "Inundación", source_report_ids: ["r1"] },
      { description: "Sequía", source_report_ids: ["r2"] },
    ]);
  });

  it("replaces a list of plain strings wholesale", () => {
    expect(
      deepMergeTranslation(["food", "water"], ["comida", "agua"]),
    ).toEqual(["comida", "agua"]);
  });

  it("keeps the canonical tail when the overlay array is shorter", () => {
    expect(
      deepMergeTranslation(["a", "b", "c"], ["x", "y"]),
    ).toEqual(["x", "y", "c"]);
  });

  it("leaves non-prose leaves (enums, numbers) untouched when overlay omits them", () => {
    const canonical = {
      health: {
        severity: "critical",
        top_needs: ["Medicine", "Staff"],
        information_coverage: [{ area: "Access", rating_out_of_10: 4 }],
        source_report_ids: ["r9"],
      },
    };
    const overlay = {
      health: {
        top_needs: ["Medicamentos", "Personal"],
        information_coverage: [{ area: "Acceso" }],
      },
    };
    expect(deepMergeTranslation(canonical, overlay)).toEqual({
      health: {
        severity: "critical",
        top_needs: ["Medicamentos", "Personal"],
        information_coverage: [{ area: "Acceso", rating_out_of_10: 4 }],
        source_report_ids: ["r9"],
      },
    });
  });
});
