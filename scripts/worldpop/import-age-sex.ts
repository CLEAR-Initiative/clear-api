/**
 * WorldPop age-sex demographics importer.
 *
 * Reads the WorldPop 2026 constrained 100m age-sex GeoTIFF stack (one
 * raster per (gender, age-group) combination) and upserts one
 * locationMetadata row per admin-2 location, summing population per age
 * group across genders.
 *
 * Dataset: {iso3_lower}_agesex_structures_2026_CN_100m_R2025A_v1
 *   - file naming: {iso3_lower}_{m|f|t}_{age}_2026_CN_100m_R2025A_v1.tif
 *   - age groups: 00 (0-12mo), 01 (1-4y), 05 (5-9y), 10..85 in 5-year bins, 90 (90+)
 *   - resolution: 100m, EPSG:4326 (WGS84), constrained estimate
 *
 * For each admin-2 polygon we compute a zonal sum on the male raster and
 * the female raster for each age group, then `total` is just male + female.
 * The country-wide totals ({iso}_T_F_*, {iso}_T_M_*) are not consumed —
 * they're already aggregated across age and don't help per-A2 aggregation.
 *
 * Storage shape on `location_metadata.data`:
 *     {
 *       "00": {"male": int, "female": int, "total": int},
 *       "01": {...},
 *       ...
 *       "90": {...},
 *       "_source": { dataset, year, resolution, ... }  // underscored = provenance
 *     }
 *
 * Usage:
 *   bun run scripts/worldpop/import-age-sex.ts                       # SDN, dry run
 *   bun run scripts/worldpop/import-age-sex.ts --iso3 AFG            # Afghanistan
 *   bun run scripts/worldpop/import-age-sex.ts --iso3 VEN            # Venezuela
 *   bun run scripts/worldpop/import-age-sex.ts --execute              # write to DB
 *   bun run scripts/worldpop/import-age-sex.ts --input <folder>       # custom raster folder
 *
 * Notes on country selection:
 *   - --iso3 controls the default input folder, the per-file regex, and
 *     the source provenance block written into locationMetadata.data.
 *   - The A2 polygons summed against the rasters are filtered by spatial
 *     intersection with the raster bounding box, so a mixed-country DB
 *     (SDN + AFG) is safe: running --iso3 AFG never overwrites Sudan
 *     rows with zeros, and vice versa.
 *
 * Requires:
 *   - bun add geotiff
 *   - Database access via the same Prisma config as the app.
 */

import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromFile, type GeoTIFFImage } from "geotiff";

import type { InputJsonValue } from "../../src/generated/prisma/internal/prismaNamespace.js";
import { prisma } from "../../src/lib/prisma.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLEAR_API_DIR = join(SCRIPT_DIR, "..", "..");
const DEFAULT_ISO3 = "SDN";

/**
 * WorldPop folder name convention: `{iso3_lower}_agesex_structures_2026_CN_100m_R2025A_v1`.
 * Defaults to the in-repo folder when --iso3 isn't overridden.
 */
function defaultInputForIso3(iso3: string): string {
  return join(CLEAR_API_DIR, `${iso3.toLowerCase()}_agesex_structures_2026_CN_100m_R2025A_v1`);
}

/**
 * Per-file regex — must match the actual filenames in the chosen folder.
 * WorldPop publishes lowercase m/f per-age tiles named with the lowercase
 * ISO3 prefix; the uppercase T_F / T_M country-wide totals are deliberately
 * not matched (see header).
 */
function fileRegexForIso3(iso3: string): RegExp {
  const prefix = iso3.toLowerCase();
  return new RegExp(`^${prefix}_(?<gender>[mf])_(?<age>\\d{2})_2026_CN_100m_R2025A_v1\\.tif$`);
}

// `location_metadata.type` value we own. Year is baked in so a future
// WorldPop release writes to a different row without colliding.
const METADATA_TYPE = "worldpop_age_sex_2026";
const BATCH_SIZE = 25;

// Types owned by OTHER importers — refuse to touch them, even by accident.
// Mirrors the safeguard in scripts/msna/import-msna.ts.
const PROTECTED_TYPES = new Set<string>([
  "iom_dtm_displacement",
  "msna_severity_082025",
]);
if (PROTECTED_TYPES.has(METADATA_TYPE)) {
  throw new Error(
    `METADATA_TYPE='${METADATA_TYPE}' is in PROTECTED_TYPES — this script ` +
      `would overwrite rows owned by another importer. Aborting at startup.`,
  );
}

// Age groups present in the WorldPop dataset, in the order we emit them.
const AGE_GROUPS = [
  "00", "01", "05", "10", "15", "20", "25", "30", "35", "40",
  "45", "50", "55", "60", "65", "70", "75", "80", "85", "90",
] as const;
type AgeGroup = (typeof AGE_GROUPS)[number];
type Gender = "m" | "f";

// ─── Types ────────────────────────────────────────────────────────────────

interface A2Location {
  id: string;
  name: string;
  pCode: string | null;
  geometry: GeoJsonPolygonish; // Polygon | MultiPolygon
}

type Position = [number, number];
type Ring = Position[];
type GeoJsonPolygon = { type: "Polygon"; coordinates: Ring[] };
type GeoJsonMultiPolygon = { type: "MultiPolygon"; coordinates: Ring[][] };
type GeoJsonPolygonish = GeoJsonPolygon | GeoJsonMultiPolygon;

interface AgeSexEntry {
  male: number;
  female: number;
  total: number;
}

interface UpsertPayload {
  locationId: string;
  type: string;
  data: Record<string, AgeSexEntry | Record<string, unknown>>;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

function bboxOfRings(rings: Ring[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function geometryBbox(g: GeoJsonPolygonish): [number, number, number, number] {
  if (g.type === "Polygon") return bboxOfRings(g.coordinates);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of g.coordinates) {
    const [x0, y0, x1, y1] = bboxOfRings(poly);
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  return [minX, minY, maxX, maxY];
}

/** Standard ray-casting point-in-polygon test for a single ring. */
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0], yi = ring[i]![1];
    const xj = ring[j]![0], yj = ring[j]![1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon-with-holes. First ring is outer, rest are holes. */
function pointInPolygon(x: number, y: number, poly: Ring[]): boolean {
  if (poly.length === 0 || !pointInRing(x, y, poly[0]!)) return false;
  for (let i = 1; i < poly.length; i++) {
    if (pointInRing(x, y, poly[i]!)) return false; // inside a hole
  }
  return true;
}

function pointInGeometry(x: number, y: number, g: GeoJsonPolygonish): boolean {
  if (g.type === "Polygon") return pointInPolygon(x, y, g.coordinates);
  for (const poly of g.coordinates) {
    if (pointInPolygon(x, y, poly)) return true;
  }
  return false;
}

// ─── Zonal sum ────────────────────────────────────────────────────────────

interface RasterFrame {
  data: Float32Array;
  width: number;
  height: number;
  /** [west, south, east, north] in raster CRS (assumed EPSG:4326). */
  bbox: [number, number, number, number];
  nodata: number | null;
}

async function loadRaster(path: string): Promise<RasterFrame> {
  const tiff = await fromFile(path);
  const image: GeoTIFFImage = await tiff.getImage();
  const [west, south, east, north] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ samples: [0] });
  const arr = (rasters as unknown as ArrayLike<number>[])[0];
  // Force to Float32Array — WorldPop publishes Float32 with a large negative
  // nodata sentinel; integer underlying type variants need the same treatment.
  const data = arr instanceof Float32Array ? arr : Float32Array.from(arr as ArrayLike<number>);
  const nodataRaw = image.getGDALNoData();
  return {
    data,
    width,
    height,
    bbox: [west, south, east, north],
    nodata: typeof nodataRaw === "number" ? nodataRaw : null,
  };
}

/** Sum WorldPop population pixels falling inside each A2 polygon. */
function zonalSums(
  raster: RasterFrame,
  locations: A2Location[],
): Map<string, number> {
  const { data, width, height, bbox, nodata } = raster;
  const [west, , east, north] = bbox;
  const pixelW = (east - west) / width;
  const pixelH = (bbox[3] - bbox[1]) / height;
  const result = new Map<string, number>();

  for (const loc of locations) {
    const [lx0, ly0, lx1, ly1] = geometryBbox(loc.geometry);
    // Clip the polygon's bbox to the raster's bbox so we iterate the smallest
    // window possible.
    const colMin = Math.max(0, Math.floor((Math.max(lx0, west) - west) / pixelW));
    const colMax = Math.min(width - 1, Math.floor((Math.min(lx1, east) - west) / pixelW));
    const rowMin = Math.max(0, Math.floor((north - Math.min(ly1, north)) / pixelH));
    const rowMax = Math.min(height - 1, Math.floor((north - Math.max(ly0, bbox[1])) / pixelH));
    if (colMax < colMin || rowMax < rowMin) {
      result.set(loc.id, 0);
      continue;
    }

    let sum = 0;
    for (let row = rowMin; row <= rowMax; row++) {
      const pxLat = north - (row + 0.5) * pixelH;
      const rowOffset = row * width;
      for (let col = colMin; col <= colMax; col++) {
        const v = data[rowOffset + col];
        if (v === undefined) continue;
        // WorldPop signals nodata via a large negative sentinel OR via the
        // declared nodata value. Both end up <0 so the simple range check
        // catches them robustly.
        if (nodata !== null && v === nodata) continue;
        if (v < 0 || !Number.isFinite(v)) continue;
        const pxLng = west + (col + 0.5) * pixelW;
        if (!pointInGeometry(pxLng, pxLat, loc.geometry)) continue;
        sum += v;
      }
    }
    result.set(loc.id, Math.round(sum));
  }
  return result;
}

// ─── Raster discovery ─────────────────────────────────────────────────────

async function discoverRasters(
  inputDir: string,
  fileRe: RegExp,
): Promise<Map<`${Gender}_${AgeGroup}`, string>> {
  const matches = new Map<`${Gender}_${AgeGroup}`, string>();
  const entries = await readdir(inputDir);
  for (const name of entries.sort()) {
    const m = fileRe.exec(name);
    if (!m?.groups) continue;
    const gender = m.groups.gender.toLowerCase() as Gender;
    const age = m.groups.age as AgeGroup;
    matches.set(`${gender}_${age}`, join(inputDir, name));
  }
  return matches;
}

// ─── Location fetch ───────────────────────────────────────────────────────

/**
 * Read just the bbox of a raster without loading pixel data — used to
 * restrict the A2 fetch to polygons inside the country. Cheap header-only.
 */
async function getRasterBbox(
  path: string,
): Promise<[number, number, number, number]> {
  const tiff = await fromFile(path);
  const image = await tiff.getImage();
  const [west, south, east, north] = image.getBoundingBox();
  return [west, south, east, north];
}

/**
 * A2 polygons intersecting `bbox` (raster footprint). Without this filter
 * a mixed-country DB would have a Sudan run zero out every Afghan A2 (and
 * vice versa) when --execute fires.
 */
async function fetchA2Locations(
  bbox: [number, number, number, number],
): Promise<A2Location[]> {
  const [west, south, east, north] = bbox;
  // Pull GeoJSON directly from PostGIS so we don't have to handle WKB/EWKB
  // parsing client-side. The cast is needed because the column is declared
  // as `Unsupported("geometry(...)")` in the Prisma schema.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; name: string; p_code: string | null; geom: string | null }>
  >`
    SELECT id, name, "p_code" AS p_code,
           ST_AsGeoJSON("geometry"::geometry) AS geom
    FROM "locations"
    WHERE level = 2
      AND "geometry" IS NOT NULL
      AND ST_Intersects(
        "geometry"::geometry,
        ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
      )
  `;
  const out: A2Location[] = [];
  for (const r of rows) {
    if (!r.geom) continue;
    let geometry: GeoJsonPolygonish;
    try {
      const parsed = JSON.parse(r.geom);
      if (parsed.type !== "Polygon" && parsed.type !== "MultiPolygon") continue;
      geometry = parsed as GeoJsonPolygonish;
    } catch {
      continue;
    }
    out.push({ id: r.id, name: r.name, pCode: r.p_code, geometry });
  }
  return out;
}

// ─── DB write (bitemporal upsert) ─────────────────────────────────────────

async function upsertBatch(payloads: UpsertPayload[]): Promise<number> {
  if (payloads.length === 0) return 0;
  for (const p of payloads) {
    if (PROTECTED_TYPES.has(p.type)) {
      throw new Error(
        `Refusing to write payload with protected type '${p.type}' ` +
          `(locationId=${p.locationId}). This script only manages type='${METADATA_TYPE}'.`,
      );
    }
    if (p.type !== METADATA_TYPE) {
      throw new Error(
        `Unexpected payload type '${p.type}' (expected '${METADATA_TYPE}'). Aborting.`,
      );
    }
  }

  const now = new Date();
  const closeClauses = payloads.map((p) => ({
    locationId: p.locationId,
    type: p.type,
    validTo: null,
  }));
  const newRows = payloads.map((p) => ({
    locationId: p.locationId,
    type: p.type,
    data: p.data as InputJsonValue,
    validFrom: now,
  }));

  await prisma.$transaction(
    async (tx) => {
      await tx.locationMetadata.updateMany({
        where: { OR: closeClauses },
        data: { validTo: now },
      });
      await tx.locationMetadata.createMany({ data: newRows });
    },
    { timeout: 60_000 },
  );
  return payloads.length;
}

// ─── Entry point ──────────────────────────────────────────────────────────

interface Flags {
  iso3: string;
  inputDir: string;
  execute: boolean;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) return null;
    return argv[i + 1] ?? null;
  };
  const iso3 = (get("--iso3") ?? DEFAULT_ISO3).toUpperCase();
  return {
    iso3,
    // Explicit --input wins, otherwise derive the folder name from --iso3.
    inputDir: get("--input") ?? defaultInputForIso3(iso3),
    execute: argv.includes("--execute"),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags();

  const dirStat = await stat(flags.inputDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Input folder not found: ${flags.inputDir}`);
  }

  const fileRe = fileRegexForIso3(flags.iso3);
  const rasters = await discoverRasters(flags.inputDir, fileRe);
  if (rasters.size === 0) {
    throw new Error(
      `No per-(gender, age) GeoTIFFs matching ${fileRe} found in ${flags.inputDir}`,
    );
  }

  console.log(`ISO3:    ${flags.iso3}`);
  console.log(`Input:   ${flags.inputDir}`);
  console.log(`Type:    ${METADATA_TYPE}`);
  console.log(`Mode:    ${flags.execute ? "EXECUTE" : "DRY RUN (pass --execute to write)"}`);
  console.log(`Rasters: ${rasters.size} per-(gender, age) GeoTIFFs found`);
  const filePrefix = flags.iso3.toLowerCase();
  const missing: string[] = [];
  for (const g of ["m", "f"] as const) {
    for (const a of AGE_GROUPS) {
      if (!rasters.has(`${g}_${a}`)) missing.push(`${filePrefix}_${g}_${a}_*.tif`);
    }
  }
  if (missing.length > 0) {
    console.log(`  WARNING: ${missing.length} expected raster(s) missing:`);
    for (const f of missing) console.log(`    - ${f}`);
  }
  console.log();

  // Restrict A2s to those inside the raster footprint so a mixed-country DB
  // (SDN + AFG) is safe: an --iso3 AFG run can't write zero-pop rows over
  // Sudan A2s, and vice versa.
  const firstRaster = rasters.values().next().value;
  if (!firstRaster) {
    throw new Error("No rasters available to derive footprint bbox.");
  }
  const rasterBbox = await getRasterBbox(firstRaster);
  console.log(
    `Raster footprint: [${rasterBbox.map((n) => n.toFixed(3)).join(", ")}]`,
  );

  // Fetch A2 locations within the raster footprint
  console.log("Fetching admin-2 locations (with geometry)…");
  const t0 = Date.now();
  const locations = await fetchA2Locations(rasterBbox);
  console.log(
    `  Got ${locations.length} A2 locations in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (locations.length === 0) {
    throw new Error(
      `No A2 locations intersect the raster footprint. Either the country's ` +
        `admin boundaries aren't loaded yet, or --iso3 / --input point at a ` +
        `different country than the locations table contains.`,
    );
  }
  console.log();

  // Compute zonal sums per raster
  console.log(`Computing zonal sums across ${rasters.size} rasters × ${locations.length} locations…`);
  // sums[locationId][age] = { male, female }
  const sums = new Map<string, Map<AgeGroup, { male: number; female: number }>>();
  for (const loc of locations) {
    const inner = new Map<AgeGroup, { male: number; female: number }>();
    for (const a of AGE_GROUPS) inner.set(a, { male: 0, female: 0 });
    sums.set(loc.id, inner);
  }

  let i = 0;
  for (const [key, path] of [...rasters.entries()].sort()) {
    i++;
    const t = Date.now();
    const raster = await loadRaster(path);
    const perLoc = zonalSums(raster, locations);
    const [gender, age] = key.split("_") as [Gender, AgeGroup];
    const gKey = gender === "m" ? "male" : "female";
    for (const loc of locations) {
      const entry = sums.get(loc.id)!.get(age)!;
      entry[gKey] = perLoc.get(loc.id) ?? 0;
    }
    const dt = (Date.now() - t) / 1000;
    console.log(`  [${String(i).padStart(2)}/${rasters.size}] ${key}  → ${dt.toFixed(1)}s`);
  }

  // Build payloads
  const sourceBlock = {
    dataset:       `WorldPop ${filePrefix}_agesex_structures_2026_CN_100m_R2025A_v1`,
    source_folder: flags.inputDir.split("/").pop() ?? flags.inputDir,
    year:          2026,
    resolution:    "100m",
    type:          "Constrained",
    release:       "R2025A",
    version:       "v1",
    raster_files:  rasters.size,
    iso3:          flags.iso3,
    generated_at:  new Date().toISOString(),
  };
  const payloads: UpsertPayload[] = [];
  const zeroPopLocations: string[] = [];
  for (const loc of locations) {
    const data: Record<string, AgeSexEntry | typeof sourceBlock> = {};
    let total = 0;
    for (const a of AGE_GROUPS) {
      const { male, female } = sums.get(loc.id)!.get(a)!;
      const ageTotal = male + female;
      data[a] = { male, female, total: ageTotal };
      total += ageTotal;
    }
    data._source = sourceBlock;
    payloads.push({ locationId: loc.id, type: METADATA_TYPE, data });
    if (total === 0) zeroPopLocations.push(loc.name);
  }

  console.log();
  console.log(`Built ${payloads.length} payloads.`);
  if (zeroPopLocations.length > 0) {
    console.log(
      `  WARNING: ${zeroPopLocations.length} A2 location(s) summed to 0 across all age groups:`,
    );
    for (const name of zeroPopLocations.slice(0, 10)) console.log(`    - ${name}`);
    if (zeroPopLocations.length > 10) {
      console.log(`    … and ${zeroPopLocations.length - 10} more`);
    }
  }
  console.log();

  // Dry-run preview
  if (!flags.execute) {
    const zeroSet = new Set(zeroPopLocations);
    const sample =
      payloads.find((p) => {
        const loc = locations.find((l) => l.id === p.locationId);
        return loc && !zeroSet.has(loc.name);
      }) ?? payloads[0];
    if (!sample) {
      console.log("No payloads to preview.");
      return;
    }
    const sampleLoc = locations.find((l) => l.id === sample.locationId);
    const sampleTotal = AGE_GROUPS.reduce(
      (s, a) => s + (sample.data[a] as AgeSexEntry).total,
      0,
    );
    console.log("Sample payload:");
    console.log(`  location:         ${sampleLoc?.name ?? "?"} (${sampleLoc?.pCode ?? "?"})`);
    console.log(`  locationId:       ${sample.locationId}`);
    console.log(`  type:             ${sample.type}`);
    console.log(`  total population: ${sampleTotal.toLocaleString("en-US")}`);
    console.log("  age breakdown (first 5 groups):");
    for (const a of AGE_GROUPS.slice(0, 5)) {
      const e = sample.data[a] as AgeSexEntry;
      console.log(
        `    ${a}: male=${String(e.male).padStart(7)}  ` +
          `female=${String(e.female).padStart(7)}  total=${String(e.total).padStart(7)}`,
      );
    }
    console.log(`    … (${AGE_GROUPS.length - 5} more age groups)`);
    console.log();
    console.log(`Would upsert ${payloads.length} records in batches of ${BATCH_SIZE}.`);
    console.log("Run with --execute to write.");
    return;
  }

  // Write
  console.log(`Writing ${payloads.length} records…`);
  let total = 0;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    const written = await upsertBatch(batch);
    total += written;
    const end = Math.min(i + BATCH_SIZE, payloads.length);
    console.log(
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: wrote ${written} records (${i + 1}-${end})`,
    );
  }
  console.log(`\nDone. ${total}/${payloads.length} records written.`);
}

main()
  .catch((err) => {
    console.error("[import-age-sex] Fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    // Prisma cleanup — same pattern as the MSNA importer.
    await prisma.$disconnect();
  });
