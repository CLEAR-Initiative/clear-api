import { describe, it, expect } from "vitest";
import {
  toSeismicMapCollection,
  STALE_AFTER_DAYS,
  type StoredUsgsMetadata,
} from "../../../src/services/usgs/earthquakes.js";

const NOW = new Date("2026-08-28T00:00:00.000Z").getTime();
const DAY = 86_400_000;

function feature(id: string, over: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    id,
    geometry: { type: "Point" as const, coordinates: [10, 20, 30] as [number, number, number] },
    properties: {
      id,
      mag: 6.1,
      mag_type: "mww",
      place: "somewhere",
      title: `M 6.1 - ${id}`,
      time: NOW - 2 * DAY, // 2 days old by default
      updated: NOW - 2 * DAY,
      depth_km: 30,
      alert: "yellow" as const,
      mmi: 5.2,
      url: "https://usgs/x",
      has_shakemap: false,
      status: "reviewed" as const,
      ...over,
    },
  };
}

function row(features: unknown[], shakemaps: unknown[] = [], meta: Record<string, unknown> = {}): StoredUsgsMetadata {
  return {
    type: "usgs_earthquakes",
    data: {
      source: "usgs-ingest",
      pulled_at: "2026-08-27T23:50:00.000Z",
      min_magnitude: 5.5,
      window_days: 30,
      bbox: [21.8, 8.5, 38.6, 22.0],
      bytes_in: 1000,
      bytes_out: 300,
      reduction_ratio: 0.7,
      features,
      shakemaps,
      ...meta,
    },
  };
}

describe("toSeismicMapCollection", () => {
  it("computes age_days + stale serve-side (recent event is not stale)", () => {
    const c = toSeismicMapCollection([row([feature("a")])], { now: NOW });
    expect(c.features).toHaveLength(1);
    expect(c.features[0].properties.age_days).toBe(2);
    expect(c.features[0].properties.stale).toBe(0);
    expect(c.meta.source).toBe("usgs-ingest");
    expect(c.meta.feature_count).toBe(1);
    expect(c.meta.pulled_at).toBe("2026-08-27T23:50:00.000Z");
    expect(c.meta.reduction_ratio).toBe(0.7);
  });

  it("marks stale (but keeps) an event older than the threshold", () => {
    const old = feature("old", { time: NOW - (STALE_AFTER_DAYS + 5) * DAY });
    const c = toSeismicMapCollection([row([old])], { now: NOW });
    expect(c.features).toHaveLength(1); // NOT dropped
    expect(c.features[0].properties.age_days).toBe(STALE_AFTER_DAYS + 5);
    expect(c.features[0].properties.stale).toBe(1);
  });

  it("null time → age_days null, stale 0", () => {
    const c = toSeismicMapCollection([row([feature("n", { time: null })])], { now: NOW });
    expect(c.features[0].properties.age_days).toBeNull();
    expect(c.features[0].properties.stale).toBe(0);
  });

  it("minMagnitude filters features client-side", () => {
    const c = toSeismicMapCollection(
      [row([feature("big", { mag: 6.5 }), feature("small", { mag: 5.6 })])],
      { now: NOW, minMagnitude: 6.0 },
    );
    expect(c.features.map((f) => f.properties.id)).toEqual(["big"]);
    expect(c.meta.feature_count).toBe(1);
  });

  it("drops a ShakeMap orphaned by the magnitude filter", () => {
    const c = toSeismicMapCollection(
      [row(
        [feature("big", { mag: 6.5, has_shakemap: true }), feature("small", { mag: 5.6, has_shakemap: true })],
        [
          { eventId: "big", type: "FeatureCollection", features: [] },
          { eventId: "small", type: "FeatureCollection", features: [] },
        ],
      )],
      { now: NOW, minMagnitude: 6.0 },
    );
    expect(c.shakemaps?.map((s) => s.eventId)).toEqual(["big"]);
  });

  it("empty / missing rows → empty collection", () => {
    expect(toSeismicMapCollection([]).features).toHaveLength(0);
    expect(toSeismicMapCollection([]).meta.source).toBe("usgs-ingest");
    expect(toSeismicMapCollection([{ type: "usgs_earthquakes", data: null }]).features).toHaveLength(0);
  });
});
