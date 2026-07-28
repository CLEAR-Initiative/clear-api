import { describe, it, expect } from "vitest";
import {
  toBlockagesMapCollection,
  simplifyLine,
  blockagesDisplayLabel,
  normalizeBlockagesSourceName,
  ageDaysSince,
  DEFAULT_SIMPLIFY_TOLERANCE_DEG,
  type StoredLogieMetadata,
} from "../../../src/services/logie/blockages.js";

const NOW = new Date("2026-07-28T00:00:00.000Z");

function roadFeature(props: Record<string, unknown>, coords?: number[][]) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords ?? [[0, 0], [1, 1]] },
    properties: props,
  };
}

function bridgeFeature(props: Record<string, unknown>) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [30, 15] },
    properties: props,
  };
}

function rows(roads: unknown[], bridges: unknown[]): StoredLogieMetadata[] {
  return [
    { type: "logie_roads", data: { type: "FeatureCollection", features: roads, pulled_at: "2026-07-01T02:30:00.000Z" } },
    { type: "logie_bridges", data: { type: "FeatureCollection", features: bridges, pulled_at: "2026-07-01T02:31:00.000Z" } },
  ];
}

describe("toBlockagesMapCollection — blocked filter", () => {
  it("keeps roads with currstatus_physical in {3,4}, drops others", () => {
    const c = toBlockagesMapCollection(
      rows(
        [
          roadFeature({ osmid: "r3", currstatus_physical: 3, routenameen: "Road A" }),
          roadFeature({ osmid: "r4", currstatus_physical: 4, routenameen: "Road B" }),
          roadFeature({ osmid: "r1", currstatus_physical: 1, routenameen: "Open road" }),
          roadFeature({ osmid: "r0", currstatus_physical: 0 }),
        ],
        [],
      ),
      { now: NOW },
    );
    const ids = c.features.map((f) => f.properties.route_id);
    expect(ids).toEqual(["r3", "r4"]);
    expect(c.features.every((f) => f.properties.feature_type === "road")).toBe(true);
  });

  it("keeps bridges with currstatus in {3,4,5}, drops 'under repair, operational' (2)", () => {
    const c = toBlockagesMapCollection(
      rows(
        [],
        [
          bridgeFeature({ osmid: "b3", currstatus: 3 }),
          bridgeFeature({ osmid: "b4", currstatus: 4 }),
          bridgeFeature({ osmid: "b5", currstatus: 5 }),
          bridgeFeature({ osmid: "b2", currstatus: 2 }), // operational → not blocked
          bridgeFeature({ osmid: "b1", currstatus: 1 }),
        ],
      ),
      { now: NOW },
    );
    expect(c.features.map((f) => f.properties.route_id)).toEqual(["b3", "b4", "b5"]);
  });

  it("ignores unknown metadata types", () => {
    const c = toBlockagesMapCollection(
      [{ type: "iom_dtm_displacement", data: { features: [roadFeature({ currstatus_physical: 4 })] } }],
      { now: NOW },
    );
    expect(c.features).toHaveLength(0);
  });
});

describe("derived properties", () => {
  it("fixes the 'Damanged' typo and maps reliability code → label", () => {
    const c = toBlockagesMapCollection(
      rows(
        [
          roadFeature({
            osmid: "r3",
            currstatus_physical: 3,
            currstatus_physical_label: "Passable with restrictions/Damanged",
            currsourcename: "LC",
            currinforely: 3,
            currstatusremarken: "Bridge out near km 12.",
            currasofdate: "2026-07-20T00:00:00.000Z",
          }),
        ],
        [],
      ),
      { now: NOW },
    );
    const p = c.features[0]!.properties;
    expect(p.status).toBe("Passable with restrictions/Damaged");
    expect(p.source_label).toBe("WFP Logistics Cluster");
    expect(p.source_reliability_code).toBe(3);
    expect(p.source_reliability).toBe("High (first-hand, crowdsource)");
    expect(p.status_remark).toBe("Bridge out near km 12.");
  });

  it("labels fall back to remark snippet, then '{kind} · {status}'", () => {
    const c = toBlockagesMapCollection(
      rows(
        [
          roadFeature({ osmid: "r3", currstatus_physical: 4, currstatus_physical_label: "Not Passable" }),
          roadFeature({
            osmid: "r4",
            currstatus_physical: 4,
            currstatusremarken: "Flooding on the main route. More detail.",
          }),
        ],
        [],
      ),
      { now: NOW },
    );
    expect(c.features[0]!.properties.label).toBe("Road · Not Passable");
    expect(c.features[1]!.properties.label).toBe("Flooding on the main route");
  });

  it("marks status stale at >= 15 days", () => {
    const c = toBlockagesMapCollection(
      rows(
        [
          roadFeature({ osmid: "fresh", currstatus_physical: 4, currasofdate: "2026-07-20T00:00:00.000Z" }),
          roadFeature({ osmid: "stale", currstatus_physical: 4, currasofdate: "2026-07-01T00:00:00.000Z" }),
          roadFeature({ osmid: "nodate", currstatus_physical: 4 }),
        ],
        [],
      ),
      { now: NOW },
    );
    const byId = Object.fromEntries(c.features.map((f) => [f.properties.route_id, f.properties]));
    expect(byId.fresh!.age_days).toBe(8);
    expect(byId.fresh!.stale).toBe(0);
    expect(byId.stale!.age_days).toBe(27);
    expect(byId.stale!.stale).toBe(1);
    expect(byId.nodate!.age_days).toBeNull();
    expect(byId.nodate!.stale).toBe(0);
  });
});

describe("geometry + meta", () => {
  it("simplifies LineStrings and reports a positive reduction ratio", () => {
    const zigzag: number[][] = [];
    for (let i = 0; i < 200; i++) zigzag.push([i * 0.001, (i % 2) * 0.00001]);
    const c = toBlockagesMapCollection(
      rows([roadFeature({ osmid: "long", currstatus_physical: 4 }, zigzag)], []),
      { now: NOW },
    );
    const geom = c.features[0]!.geometry as { coordinates: number[][] };
    expect(geom.coordinates.length).toBeLessThan(zigzag.length);
    expect(c.meta.source).toBe("logie-ingest");
    expect(c.meta.feature_count).toBe(1);
    expect(c.meta.simplify_tolerance_deg).toBe(DEFAULT_SIMPLIFY_TOLERANCE_DEG);
    expect(c.meta.bytes_out).toBeLessThan(c.meta.bytes_in);
    expect(c.meta.reduction_ratio).toBeGreaterThan(0);
  });

  it("keeps the freshest pulled_at across layers", () => {
    const c = toBlockagesMapCollection(
      rows([roadFeature({ osmid: "r", currstatus_physical: 4 })], [bridgeFeature({ osmid: "b", currstatus: 5 })]),
      { now: NOW },
    );
    expect(c.meta.pulled_at).toBe("2026-07-01T02:31:00.000Z");
  });
});

describe("pure helpers", () => {
  it("simplifyLine keeps endpoints and collapses collinear points", () => {
    const line = [[0, 0], [1, 0], [2, 0], [3, 0]];
    expect(simplifyLine(line, 0.0008)).toEqual([[0, 0], [3, 0]]);
  });

  it("blockagesDisplayLabel prefers name", () => {
    expect(
      blockagesDisplayLabel({ feature_type: "road", name: "N1", status_remark: null, status: null }),
    ).toBe("N1");
  });

  it("normalizeBlockagesSourceName collapses LC variants", () => {
    expect(normalizeBlockagesSourceName("WFP/LC")).toBe("WFP Logistics Cluster");
    expect(normalizeBlockagesSourceName("  ")).toBeNull();
  });

  it("ageDaysSince clamps future dates to 0 and returns null for junk", () => {
    expect(ageDaysSince("2026-08-01T00:00:00.000Z", NOW)).toBe(0);
    expect(ageDaysSince("not-a-date", NOW)).toBeNull();
  });
});
