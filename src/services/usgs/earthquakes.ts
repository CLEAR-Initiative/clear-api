/**
 * USGS seismic serve-side transform (Expo #465 backend).
 *
 * The Dagster `usgs_earthquakes` asset stores one slim blob per admin0 country in
 * `locationMetadata(type="usgs_earthquakes")` — already filtered to that country's
 * padded bbox and reduced from the fat FDSN payload. This module turns that stored
 * blob into the `SeismicMapCollection` the map paints, injecting the two fields the
 * ingest deliberately does NOT store because they are relative to request time:
 * `age_days` and `stale`. Same split as LogIE (`services/logie/blockages.ts`):
 * pipeline stores, the route computes staleness at serve time.
 *
 * Contract: clear-context-pipeline/docs/data-source-specs/USGS-earthquake.md.
 */

/** MMI/PAGER + volume fields kept for paint/popup. */
export type SeismicMapFeatureProperties = {
  id: string;
  mag: number | null;
  mag_type: string | null;
  place: string | null;
  title: string | null;
  time: number | null; // ms epoch
  updated: number | null; // ms epoch
  depth_km: number | null;
  alert: "green" | "yellow" | "orange" | "red" | null;
  mmi: number | null;
  url: string | null;
  has_shakemap: boolean;
  status: "automatic" | "reviewed" | null;
  age_days: number | null; // computed serve-side
  stale: 0 | 1; // computed serve-side (age_days >= STALE_AFTER_DAYS)
};

export type SeismicMapFeature = {
  type: "Feature";
  id?: string;
  geometry: { type: "Point"; coordinates: [number, number, number] } | null;
  properties: SeismicMapFeatureProperties;
};

export type ShakeMapContours = {
  eventId: string;
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "MultiLineString" | "LineString"; coordinates: unknown };
    properties: { value: number; units: string };
  }>;
};

export type SeismicMapCollection = {
  type: "FeatureCollection";
  features: SeismicMapFeature[];
  shakemaps?: ShakeMapContours[];
  meta: {
    source: "usgs-ingest";
    feature_count: number;
    min_magnitude: number | null;
    window_days: number | null;
    bbox: [number, number, number, number] | null;
    pulled_at: string; // ISO — when CLEAR last synced from USGS
    bytes_in: number;
    bytes_out: number;
    reduction_ratio: number;
  };
};

/** A stored `locationMetadata` row (only the fields we read). */
export type StoredUsgsMetadata = {
  type: string; // "usgs_earthquakes"
  data: unknown; // the slim blob the Dagster asset wrote
};

export const STALE_AFTER_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/** The blob shape the pipeline writes (features carry NO age_days/stale). */
type StoredBlob = {
  source?: string;
  pulled_at?: string;
  min_magnitude?: number | null;
  window_days?: number | null;
  bbox?: [number, number, number, number] | null;
  bytes_in?: number;
  bytes_out?: number;
  reduction_ratio?: number;
  features?: Array<{
    type: "Feature";
    id?: string;
    geometry: SeismicMapFeature["geometry"];
    properties: Omit<SeismicMapFeatureProperties, "age_days" | "stale">;
  }>;
  shakemaps?: ShakeMapContours[];
};

function emptyCollection(): SeismicMapCollection {
  return {
    type: "FeatureCollection",
    features: [],
    shakemaps: [],
    meta: {
      source: "usgs-ingest",
      feature_count: 0,
      min_magnitude: null,
      window_days: null,
      bbox: null,
      pulled_at: new Date(0).toISOString(),
      bytes_in: 0,
      bytes_out: 0,
      reduction_ratio: 0,
    },
  };
}

/** age_days = whole days since `time`; null when `time` is unknown. */
function ageDays(time: number | null | undefined, now: number): number | null {
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now - time) / MS_PER_DAY));
}

/**
 * Build the served `SeismicMapCollection` from a country's stored row(s).
 *
 * There is one `usgs_earthquakes` row per country, so we take the first row that
 * carries a blob. `minMagnitude` optionally filters features client-side (the
 * stored data is already at the ingest floor, e.g. M5.5+). Stale events are NOT
 * dropped — the front end demotes them; we only tag `stale`.
 */
export function toSeismicMapCollection(
  rows: StoredUsgsMetadata[],
  opts: { minMagnitude?: number | null; now?: number } = {},
): SeismicMapCollection {
  const row = rows.find((r) => r.data && typeof r.data === "object");
  if (!row) return emptyCollection();

  const blob = row.data as StoredBlob;
  const now = opts.now ?? Date.now();
  const minMag = opts.minMagnitude ?? null;

  const features: SeismicMapFeature[] = (blob.features ?? [])
    .filter((f) => minMag == null || (typeof f.properties.mag === "number" && f.properties.mag >= minMag))
    .map((f) => {
      const age = ageDays(f.properties.time, now);
      return {
        type: "Feature",
        id: f.id,
        geometry: f.geometry,
        properties: {
          ...f.properties,
          age_days: age,
          stale: (age != null && age >= STALE_AFTER_DAYS ? 1 : 0) as 0 | 1,
        },
      };
    });

  // Only ship contours whose event is still in the feature set (a minMagnitude
  // filter could drop an event but its ShakeMap would then be orphaned).
  const keptIds = new Set(features.map((f) => f.properties.id));
  const shakemaps = (blob.shakemaps ?? []).filter((s) => keptIds.has(s.eventId));

  return {
    type: "FeatureCollection",
    features,
    shakemaps,
    meta: {
      source: "usgs-ingest",
      feature_count: features.length,
      min_magnitude: blob.min_magnitude ?? null,
      window_days: blob.window_days ?? null,
      bbox: blob.bbox ?? null,
      pulled_at: blob.pulled_at ?? new Date(now).toISOString(),
      bytes_in: blob.bytes_in ?? 0,
      bytes_out: blob.bytes_out ?? 0,
      reduction_ratio: blob.reduction_ratio ?? 0,
    },
  };
}
