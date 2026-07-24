/**
 * Import the per-country GeoNames extracts in `src/geonames/{SD,VE,AF}/*.txt`
 * into the `geonames` + `geonames_name` tables. Idempotent: truncates and
 * reloads. Run from the repo root:
 *
 *   bun run scripts/import-geonames.ts
 *
 * The raw .txt dumps are gitignored (see src/geonames/README.md); this is
 * the step that turns them into the queryable gazetteer the hybrid
 * geo-resolver reads. `name_norm` normalisation here MUST match the
 * resolver's input normalisation, or fuzzy lookups silently miss.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { normalizeGazetteerName as norm } from "../src/utils/geonames-normalize.js";

const COUNTRIES = ["SD", "VE", "AF"] as const;
const GEONAMES_DIR = join(process.cwd(), "src", "geonames");

/** Multi-row INSERT, chunked to stay under Postgres's 65535-parameter cap. */
async function insertRows(
  client: pg.PoolClient,
  table: string,
  cols: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const width = cols.length;
  const maxRows = Math.floor(60000 / width);
  const colList = cols.map((c) => `"${c}"`).join(",");
  for (let i = 0; i < rows.length; i += maxRows) {
    const chunk = rows.slice(i, i + maxRows);
    const values = chunk
      .map((_, r) => "(" + cols.map((__, c) => `$${r * width + c + 1}`).join(",") + ")")
      .join(",");
    await client.query(
      `INSERT INTO "${table}" (${colList}) VALUES ${values}`,
      chunk.flat(),
    );
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // Atomic reload: TRUNCATE + all inserts run inside one transaction, so a
    // failure partway (a missing country file, a dropped connection) rolls
    // back to the previously loaded gazetteer instead of leaving it
    // half-populated and silently serving incomplete results in production.
    await client.query("BEGIN");
    console.log("Truncating geonames tables…");
    await client.query("TRUNCATE geonames, geonames_name RESTART IDENTITY CASCADE");

    let totalPlaces = 0;
    let totalNames = 0;

    for (const cc of COUNTRIES) {
      const path = join(GEONAMES_DIR, cc, `${cc}.txt`);
      const lines = readFileSync(path, "utf-8").split("\n");

      // Collect the whole country, then insert places BEFORE their names so
      // the geonames_name → geonames FK is always satisfied.
      const placeRows: unknown[][] = [];
      const nameRows: unknown[][] = [];

      for (const line of lines) {
        if (!line) continue;
        const f = line.split("\t");
        if (f.length < 15) continue;
        const id = Number(f[0]);
        if (!Number.isFinite(id)) continue;
        const lat = Number(f[4]);
        const lng = Number(f[5]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const population = f[14] && /^\d+$/.test(f[14]) ? f[14] : "0";

        placeRows.push([id, f[1], f[2] || null, lat, lng, f[6] || null, f[7] || null, cc, f[10] || null, population]);

        // Explode every searchable spelling into geonames_name, deduped.
        const variants = new Set<string>();
        for (const raw of [f[1], f[2], ...(f[3] ? f[3].split(",") : [])]) {
          const n = norm(raw);
          if (n) variants.add(n);
        }
        for (const n of variants) nameRows.push([id, n, cc]);
      }

      await insertRows(client, "geonames", [
        "geonames_id", "name", "ascii_name", "latitude", "longitude",
        "feature_class", "feature_code", "country_code", "admin1_code", "population",
      ], placeRows);
      await insertRows(client, "geonames_name", [
        "geonames_id", "name_norm", "country_code",
      ], nameRows);

      totalPlaces += placeRows.length;
      totalNames += nameRows.length;
      console.log(`  ${cc}: ${placeRows.length.toLocaleString()} places, ${nameRows.length.toLocaleString()} name variants`);
    }

    await client.query("COMMIT");

    // ANALYZE after COMMIT — refreshing planner stats isn't part of the
    // atomic load, and running it outside the transaction sidesteps the
    // ANALYZE-in-transaction-block caveat entirely.
    await client.query("ANALYZE geonames");
    await client.query("ANALYZE geonames_name");
    console.log(`\nDone: ${totalPlaces.toLocaleString()} places, ${totalNames.toLocaleString()} name variants.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
