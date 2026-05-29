/**
 * Sudan 3W (Who does What Where) ingestion script.
 *
 * Fetches operational presence data from the OCHA HDX HAPI API for Sudan,
 * groups by Admin2 locality, and upserts one locationMetadata record per
 * locality (type: "ocha_3w") using the same close-then-insert pattern as
 * the upsertLocationMetadataBatch resolver.
 *
 * Usage:
 *   source ~/.nvm/nvm.sh && nvm use 22
 *   npx tsx scripts/ingest-sudan-3w.ts            # full run
 *   npx tsx scripts/ingest-sudan-3w.ts --dry-run  # fetch + transform, no writes
 */

import "dotenv/config";
import https from "node:https";
import { prisma } from "../src/lib/prisma.js";

const HAPI_BASE = "https://hapi.humdata.org/api/v2";
const HAPI_APP_ID = "Y2xlYXItbXZwOmRldkBzeW50cm8uZmk=";
const METADATA_TYPE = "ocha_3w";
const BATCH_SIZE = 50;

const dryRun = process.argv.includes("--dry-run");

// ─── Types ────────────────────────────────────────────────────────────────────

interface HapiRow {
  admin2_code: string;
  admin2_name: string;
  admin1_code: string;
  admin1_name: string;
  sector_code: string;
  sector_name: string;
  org_acronym: string;
  org_name: string;
  org_type_description: string;
  reference_period_start: string;
  reference_period_end: string;
  resource_hdx_id?: string;
}

interface HapiResponse {
  data: HapiRow[];
}

interface SectorSummary {
  code: string;
  name: string;
  org_count: number;
  by_type: Record<string, number>;
  organizations: { acronym: string; name: string; type: string }[];
}

interface LocalityData {
  as_of: string;
  period_start: string;
  hdx_resource_id: string;
  active_sector_count: number;
  total_org_count: number;
  sectors: SectorSummary[];
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

function httpsGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HAPI API error: ${res.statusCode} - ${body.slice(0, 200)}`));
          } else {
            resolve(body);
          }
        });
      },
    );
    req.on("error", reject);
  });
}

async function fetchSudan3W(): Promise<HapiRow[]> {
  const url = new URL(`${HAPI_BASE}/coordination-context/operational-presence`);
  url.searchParams.set("location_code", "SDN");
  url.searchParams.set("limit", "10000");
  url.searchParams.set("output_format", "json");

  console.log(`Fetching: ${url.toString()}`);
  const body = await httpsGet(url.toString(), {
    "X-HDX-HAPI-APP-IDENTIFIER": HAPI_APP_ID,
    "Accept": "application/json",
  });

  const json = JSON.parse(body) as HapiResponse;
  console.log(`  Fetched ${json.data.length} rows`);
  return json.data;
}

// ─── Transform ────────────────────────────────────────────────────────────────

function groupByAdmin2(rows: HapiRow[]): Map<string, LocalityData> {
  const byCode = new Map<string, HapiRow[]>();
  for (const row of rows) {
    if (!byCode.has(row.admin2_code)) byCode.set(row.admin2_code, []);
    byCode.get(row.admin2_code)!.push(row);
  }

  const result = new Map<string, LocalityData>();

  for (const [admin2_code, localityRows] of byCode) {
    const first = localityRows[0]!;

    // Use date part only
    const as_of = first.reference_period_end.split("T")[0]!;
    const period_start = first.reference_period_start.split("T")[0]!;
    const hdx_resource_id = first.resource_hdx_id ?? "";

    // Group by sector
    const bySector = new Map<string, HapiRow[]>();
    for (const row of localityRows) {
      if (!bySector.has(row.sector_code)) bySector.set(row.sector_code, []);
      bySector.get(row.sector_code)!.push(row);
    }

    const sectors: SectorSummary[] = [];
    for (const [sector_code, sectorRows] of bySector) {
      const uniqueOrgs = new Map<string, HapiRow>();
      for (const row of sectorRows) {
        if (!uniqueOrgs.has(row.org_acronym)) uniqueOrgs.set(row.org_acronym, row);
      }

      const by_type: Record<string, number> = {};
      for (const row of uniqueOrgs.values()) {
        const t = row.org_type_description || "Unknown";
        by_type[t] = (by_type[t] ?? 0) + 1;
      }

      sectors.push({
        code: sector_code,
        name: sectorRows[0]!.sector_name,
        org_count: uniqueOrgs.size,
        by_type,
        organizations: [...uniqueOrgs.values()].map((r) => ({
          acronym: r.org_acronym,
          name: r.org_name,
          type: r.org_type_description || "Unknown",
        })),
      });
    }

    // Total unique orgs across all sectors
    const totalOrgs = new Set(localityRows.map((r) => r.org_acronym));

    result.set(admin2_code, {
      as_of,
      period_start,
      hdx_resource_id,
      active_sector_count: sectors.length,
      total_org_count: totalOrgs.size,
      sectors,
    });
  }

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${dryRun ? "DRY RUN" : "EXECUTE"}\n`);

  // 1. Fetch
  const rows = await fetchSudan3W();

  // 2. Transform
  const byAdmin2 = groupByAdmin2(rows);
  const admin2Codes = [...byAdmin2.keys()];
  console.log(`\nLocalities in HAPI data: ${admin2Codes.length}`);

  // 3. Match pCodes to location IDs
  const locations = await prisma.locations.findMany({
    where: { pCode: { in: admin2Codes } },
    select: { id: true, pCode: true, name: true },
  });

  const pCodeToLocation = new Map(locations.map((l) => [l.pCode!, l]));

  const matched: { locationId: string; data: LocalityData }[] = [];
  const skipped: string[] = [];

  for (const code of admin2Codes) {
    const loc = pCodeToLocation.get(code);
    if (!loc) {
      skipped.push(code);
      continue;
    }
    matched.push({ locationId: loc.id, data: byAdmin2.get(code)! });
  }

  console.log(`  Matched:  ${matched.length}`);
  console.log(`  Skipped:  ${skipped.length} (no matching location in DB)`);
  if (skipped.length > 0) {
    for (const code of skipped) {
      console.warn(`    WARNING: no location for pCode ${code}`);
    }
  }

  if (dryRun) {
    const sample = matched[0];
    if (sample) {
      console.log(`\nSample payload (${locations.find((l) => l.id === sample.locationId)?.name}):`);
      console.log(JSON.stringify({ ...sample.data, sectors: `[${sample.data.sectors.length} sectors]` }, null, 2));
    }
    console.log(`\nWould upsert ${matched.length} records. Run without --dry-run to write.`);
    return;
  }

  // 4. Upsert in batches using the same close-then-insert pattern as the resolver
  const now = new Date();
  let total = 0;

  for (let i = 0; i < matched.length; i += BATCH_SIZE) {
    const batch = matched.slice(i, i + BATCH_SIZE);

    await prisma.$transaction(
      async (tx) => {
        // Close currently-open rows for this (locationId, type) set
        await tx.locationMetadata.updateMany({
          where: {
            OR: batch.map((r) => ({ locationId: r.locationId, type: METADATA_TYPE, validTo: null })),
          },
          data: { validTo: now },
        });
        // Insert new rows
        await tx.locationMetadata.createMany({
          data: batch.map((r) => ({
            locationId: r.locationId,
            type: METADATA_TYPE,
            data: r.data,
            validFrom: now,
          })),
        });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    total += batch.length;
    const end = Math.min(i + BATCH_SIZE, matched.length);
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: wrote ${batch.length} records (${i + 1}-${end})`);
  }

  console.log(`\nDone. ${total} records upserted under type "${METADATA_TYPE}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
