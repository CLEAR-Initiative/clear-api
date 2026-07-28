/**
 * LogIE roads & bridges → map-ready **Blockages** payload (clear-api serve, #317).
 *
 * clear-pipeline persists the fat, domain-decoded ArcGIS FeatureCollections as
 * `locationMetadata(type="logie_roads" | "logie_bridges")` (one per A0 country).
 * This module is the **serve** half: it reads those stored blobs and produces the
 * slim `BlockagesMapCollection` the map paints — the same contract clear-mvp's
 * `toBlockagesMapCollection` emits (`src/lib/map/logie-blockages.ts`). We do the
 * expensive part server-side so the browser never loads full LogIE geometry:
 *
 *   1. map raw LogIE props → normalized Blockages props (per layer),
 *   2. keep only **blocked** features (status codes below),
 *   3. RDP-simplify line geometry (~90m), points pass through,
 *   4. derive label / reliability / staleness, attach reduction stats.
 *
 * Blocked status codes (derived from each layer's coded-value domain):
 *   - roads   `currstatus_physical` ∈ {3,4}   (3 Passable-with-restrictions/Damaged, 4 Not Passable)
 *   - bridges `currstatus`          ∈ {3,4,5} (3 Damaged/Affected/Restricted, 4 Not operational, 5 Destroyed)
 *     (code 2 "Under repair, operational" is still crossable → not a blockage.)
 */

export const BLOCKAGES_FEATURE_TYPES = ["road", "bridge"] as const;
export type BlockagesFeatureType = (typeof BLOCKAGES_FEATURE_TYPES)[number];

/** Default RDP tolerance in degrees (~90m at the equator). */
export const DEFAULT_SIMPLIFY_TOLERANCE_DEG = 0.0008;

/** Status older than this (days) is still shown but demoted + warned by the FE. */
export const BLOCKAGES_STALE_AFTER_DAYS = 15;

export const LOGIE_RELIABILITY_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Low (rumours, 3rd-hand)",
  2: "Medium (heard, media)",
  3: "High (first-hand, crowdsource)",
  4: "Reliable (first-hand, credible)",
};

/** Blocked status codes per layer (see module header). */
export const ROAD_BLOCKED_CODES = new Set([3, 4]);
export const BRIDGE_BLOCKED_CODES = new Set([3, 4, 5]);

export type BlockagesMapProperties = {
  feature_type: BlockagesFeatureType;
  route_id: string | number | null;
  name: string | null;
  /** Always set — name, else remark snippet, else "Road · {status}". */
  label: string;
  status_code: number | null;
  status: string | null;
  status_as_of: string | null;
  status_remark: string | null;
  source_name: string | null;
  source_label: string | null;
  source_reliability_code: number | null;
  source_reliability: string | null;
  age_days: number | null;
  stale: 0 | 1;
};

type Position = number[];
type GeoJsonGeometry = { type: string; coordinates: unknown };

export type BlockagesMapFeature = {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties: BlockagesMapProperties;
};

export type BlockagesMapCollection = {
  type: "FeatureCollection";
  features: BlockagesMapFeature[];
  meta: {
    source: "logie-ingest";
    feature_types: BlockagesFeatureType[];
    feature_count: number;
    simplify_tolerance_deg: number;
    bytes_in: number;
    bytes_out: number;
    reduction_ratio: number;
    /** ISO-8601 ingest timestamp of the freshest source blob, if recorded. */
    pulled_at: string | null;
  };
};

/** A stored `locationMetadata` row's shape (only the fields we read). */
export type StoredLogieMetadata = {
  type: string; // "logie_roads" | "logie_bridges"
  data: unknown; // FeatureCollection blob from clear-pipeline
};

// ─── Geometry simplification (Ramer–Douglas–Peucker) ────────────────────────

/** Squared perpendicular distance from point to segment AB (lon/lat degrees). */
function perpDistSq(p: Position, a: Position, b: Position): number {
  const [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ex = x - x1;
    const ey = y - y1;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  const ex = x - px;
  const ey = y - py;
  return ex * ex + ey * ey;
}

/** Ramer–Douglas–Peucker; keeps endpoints. */
export function simplifyLine(coords: Position[], toleranceDeg: number): Position[] {
  if (coords.length <= 2) return coords;
  const tolSq = toleranceDeg * toleranceDeg;

  const simplify = (points: Position[]): Position[] => {
    if (points.length <= 2) return points;
    let maxDist = 0;
    let maxIdx = 0;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    for (let i = 1; i < points.length - 1; i++) {
      const d = perpDistSq(points[i]!, first, last);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist < tolSq) return [first, last];
    const left = simplify(points.slice(0, maxIdx + 1));
    const right = simplify(points.slice(maxIdx));
    return left.slice(0, -1).concat(right);
  };

  return simplify(coords);
}

export function simplifyGeometry(
  geometry: GeoJsonGeometry | null,
  toleranceDeg: number,
): GeoJsonGeometry | null {
  if (!geometry || toleranceDeg <= 0) return geometry;
  if (geometry.type === "LineString") {
    const coords = geometry.coordinates as Position[];
    return { type: "LineString", coordinates: simplifyLine(coords, toleranceDeg) };
  }
  if (geometry.type === "MultiLineString") {
    const lines = geometry.coordinates as Position[][];
    return {
      type: "MultiLineString",
      coordinates: lines.map((line) => simplifyLine(line, toleranceDeg)),
    };
  }
  // Points (bridges) — unchanged.
  return geometry;
}

// ─── Derived-field helpers (ported from clear-mvp's contract) ────────────────

/** LogIE often omits routenameen on SDN roads — never leave the map title empty. */
export function blockagesDisplayLabel(p: {
  feature_type: BlockagesFeatureType;
  name: string | null;
  status_remark: string | null;
  status: string | null;
}): string {
  const rawName = p.name?.trim() ?? "";
  if (rawName) return rawName;

  const remark = p.status_remark?.trim() ?? "";
  if (remark && remark.toLowerCase() !== "unknown") {
    const short = remark.split(/[.\n]/)[0]?.trim().slice(0, 80) ?? "";
    if (short) return short;
  }

  const kind = p.feature_type === "bridge" ? "Bridge" : "Road";
  const status = p.status ? p.status.replace(/Damanged/g, "Damaged") : "access constraint";
  return `${kind} · ${status}`;
}

/** Collapse messy LogIE reporter strings into a short UI label. */
export function normalizeBlockagesSourceName(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  const key = s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (
    key === "WFPLC" ||
    key === "LC" ||
    key === "LCWFP" ||
    key === "WFPC" ||
    key.startsWith("WFPLC") ||
    key.startsWith("LCWFP")
  ) {
    return "WFP Logistics Cluster";
  }
  if (key.includes("PARTNER")) return "Partner report";
  return s;
}

export function ageDaysSince(
  statusAsOf: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!statusAsOf) return null;
  const dt = new Date(statusAsOf);
  if (Number.isNaN(dt.getTime())) return null;
  const ms = now.getTime() - dt.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function isBlockagesStatusStale(ageDays: number | null): boolean {
  return ageDays != null && ageDays >= BLOCKAGES_STALE_AFTER_DAYS;
}

function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

// ─── Raw LogIE props → normalized Blockages props (per layer) ────────────────

type RawProps = Record<string, unknown>;

/** Intermediate normalized view; `slimProperties` derives label/reliability/age from it. */
type Normalized = {
  feature_type: BlockagesFeatureType;
  route_id: string | number | null;
  name: string | null;
  status_code: number | null;
  status: string | null;
  status_as_of: string | null;
  status_remark: string | null;
  source_name: string | null;
  source_reliability_code: number | null;
};

function normalizeRoad(p: RawProps): Normalized {
  const routeId = p.osmid;
  return {
    feature_type: "road",
    route_id:
      typeof routeId === "string" || typeof routeId === "number" ? routeId : null,
    name: toStringOrNull(p.routenameen) ?? toStringOrNull(p.roadnameen),
    status_code: toNumberOrNull(p.currstatus_physical),
    status: toStringOrNull(p.currstatus_physical_label),
    status_as_of: toStringOrNull(p.currasofdate),
    status_remark: toStringOrNull(p.currstatusremarken),
    source_name: toStringOrNull(p.currsourcename),
    source_reliability_code: toNumberOrNull(p.currinforely),
  };
}

function normalizeBridge(p: RawProps): Normalized {
  const routeId = p.osmid;
  return {
    feature_type: "bridge",
    route_id:
      typeof routeId === "string" || typeof routeId === "number" ? routeId : null,
    name: toStringOrNull(p.name) ?? toStringOrNull(p.bridgenameloc),
    status_code: toNumberOrNull(p.currstatus),
    status: toStringOrNull(p.currstatus_label),
    status_as_of: toStringOrNull(p.currasofdate),
    status_remark: toStringOrNull(p.currstatusremarken),
    source_name: toStringOrNull(p.currsourcename),
    source_reliability_code: toNumberOrNull(p.currinforely),
  };
}

function isBlocked(n: Normalized): boolean {
  if (n.status_code == null) return false;
  return n.feature_type === "road"
    ? ROAD_BLOCKED_CODES.has(n.status_code)
    : BRIDGE_BLOCKED_CODES.has(n.status_code);
}

function slimProperties(n: Normalized, now: Date): BlockagesMapProperties {
  const status = n.status ? n.status.replace(/Damanged/g, "Damaged") : null;
  const ageDays = ageDaysSince(n.status_as_of, now);
  const relCode = n.source_reliability_code;
  return {
    feature_type: n.feature_type,
    route_id: n.route_id,
    name: n.name,
    label: blockagesDisplayLabel({
      feature_type: n.feature_type,
      name: n.name,
      status_remark: n.status_remark,
      status,
    }),
    status_code: n.status_code,
    status,
    status_as_of: n.status_as_of,
    status_remark: n.status_remark,
    source_name: n.source_name,
    source_label: normalizeBlockagesSourceName(n.source_name),
    source_reliability_code: relCode,
    source_reliability:
      relCode != null ? (LOGIE_RELIABILITY_LABELS[relCode] ?? String(relCode)) : null,
    age_days: ageDays,
    stale: isBlockagesStatusStale(ageDays) ? 1 : 0,
  };
}

// ─── Public entry: stored metadata rows → BlockagesMapCollection ─────────────

type FeatureCollectionBlob = {
  features?: Array<{ geometry?: GeoJsonGeometry | null; properties?: RawProps }>;
  pulled_at?: unknown;
};

const TYPE_TO_NORMALIZER: Record<string, ((p: RawProps) => Normalized) | undefined> = {
  logie_roads: normalizeRoad,
  logie_bridges: normalizeBridge,
};

/**
 * Transform stored `logie_roads` / `logie_bridges` metadata rows into the slim,
 * blocked-only, simplified `BlockagesMapCollection`. `now` is injectable for tests.
 */
export function toBlockagesMapCollection(
  rows: StoredLogieMetadata[],
  opts: { simplifyToleranceDeg?: number; now?: Date } = {},
): BlockagesMapCollection {
  const tolerance = opts.simplifyToleranceDeg ?? DEFAULT_SIMPLIFY_TOLERANCE_DEG;
  const now = opts.now ?? new Date();

  let bytesIn = 0;
  let pulledAt: string | null = null;
  const features: BlockagesMapFeature[] = [];

  for (const row of rows) {
    const normalizer = TYPE_TO_NORMALIZER[row.type];
    if (!normalizer) continue;
    const blob = (row.data ?? {}) as FeatureCollectionBlob;
    bytesIn += JSON.stringify(row.data ?? {}).length;
    if (typeof blob.pulled_at === "string") {
      // Keep the freshest (max) ingest timestamp across roads + bridges.
      if (!pulledAt || blob.pulled_at > pulledAt) pulledAt = blob.pulled_at;
    }

    for (const f of blob.features ?? []) {
      const normalized = normalizer(f.properties ?? {});
      if (!isBlocked(normalized)) continue;
      features.push({
        type: "Feature",
        geometry: simplifyGeometry(f.geometry ?? null, tolerance),
        properties: slimProperties(normalized, now),
      });
    }
  }

  const bytesOut = JSON.stringify(features).length;
  return {
    type: "FeatureCollection",
    features,
    meta: {
      source: "logie-ingest",
      feature_types: [...BLOCKAGES_FEATURE_TYPES],
      feature_count: features.length,
      simplify_tolerance_deg: tolerance,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      reduction_ratio: bytesIn > 0 ? Number((1 - bytesOut / bytesIn).toFixed(4)) : 0,
      pulled_at: pulledAt,
    },
  };
}
