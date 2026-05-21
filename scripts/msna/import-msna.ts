/**
 * MSNA locationMetadata importer.
 *
 * Reads a processed MSNA JSON file (output of process-msna.ts) and upserts
 * one locationMetadata row per Admin2 locality. Uses the same bitemporal
 * close-then-insert pattern as the `upsertLocationMetadataBatch` GraphQL
 * mutation: open rows (validTo IS NULL) for the (locationId, type) pair
 * get their `validTo` set to now, and a fresh row is inserted with
 * `validFrom = now`.
 *
 * Usage:
 *   bun run scripts/msna/import-msna.ts                       # dry run (default)
 *   bun run scripts/msna/import-msna.ts --execute             # write to DB
 *   bun run scripts/msna/import-msna.ts --input scripts/msna/outputs/msna_2026-05-19.json
 *
 * Ported from the Python original (import_msna.py). Behaviour-for-behaviour
 * 1:1 — same payload shape, same batch size, same dry-run-by-default
 * semantics — except writes go through Prisma directly instead of the
 * GraphQL endpoint since this script now lives inside clear-api.
 */

import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { InputJsonValue } from "../../src/generated/prisma/internal/prismaNamespace.js";
import { prisma } from "../../src/lib/prisma.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(SCRIPT_DIR, "outputs");
const METADATA_TYPE = "msna_severity_082025";
const BATCH_SIZE = 50;

// Types owned by OTHER importers — this script must never touch them, even
// by accident. `iom_dtm_displacement` is maintained by the IOM DTM backfill
// (see clear-pipeline/src/tasks/dtm.py); a misconfigured METADATA_TYPE or a
// hand-edited JSON payload pointing at it would silently corrupt that data
// otherwise. Adding new external importers? Add their type here too.
const PROTECTED_TYPES = new Set<string>(["iom_dtm_displacement"]);
if (PROTECTED_TYPES.has(METADATA_TYPE)) {
  throw new Error(
    `METADATA_TYPE='${METADATA_TYPE}' is in PROTECTED_TYPES — this script ` +
      `would overwrite rows owned by another importer. Aborting at startup.`,
  );
}

// ─── Types ────────────────────────────────────────────────────────────────

interface ProcessedMeta {
  data_collection?: string;
  source_title?: string;
  led_by?: string;
  scoring_version?: string;
  fsl_formula_applied?: string;
  generated_at?: string;
}

interface LocalityEntry {
  location_id?: string | null;
  pcode?: string | null;
  match_method?: string;
  match_note?: string;
  sectors?: Record<string, unknown>;
}

interface ProcessedFile {
  meta: ProcessedMeta;
  localities: Record<string, LocalityEntry>;
}

interface UpsertPayload {
  locationId: string;
  type: string;
  data: Record<string, unknown>;
}

// ─── Payload builder ──────────────────────────────────────────────────────

function buildPayload(
  localityName: string,
  entry: LocalityEntry,
  meta: ProcessedMeta,
): UpsertPayload | null {
  // The processor sets location_id only when it matched the name to a DB
  // row. Entries with no location_id are deliberately skipped here — the
  // pcode fallback in upsertBatch is for entries whose location_id was set
  // but no longer resolves (stale id, location merged/renamed/deleted),
  // NOT for entries the processor couldn't match in the first place.
  const locationId = entry.location_id;
  if (!locationId) return null;

  const dataCollection = meta.data_collection ?? "";
  const asOf = dataCollection.includes(" to ")
    ? dataCollection.split(" to ").pop() ?? dataCollection
    : dataCollection;

  const source: Record<string, unknown> = {
    pcode: entry.pcode,
    locality_name: localityName,
    match_method: entry.match_method,
    source_title: meta.source_title,
    led_by: meta.led_by,
    data_collection: dataCollection,
    scoring_version: meta.scoring_version,
    fsl_formula_applied: meta.fsl_formula_applied,
    generated_at: meta.generated_at,
  };
  if (entry.match_note) source.match_note = entry.match_note;

  return {
    locationId,
    type: METADATA_TYPE,
    data: {
      as_of: asOf,
      sectors: entry.sectors ?? {},
      _source: source,
    },
  };
}

// ─── DB write ─────────────────────────────────────────────────────────────

/**
 * Bitemporal upsert: close any currently-open row matching
 * (locationId, type) by setting validTo = now, then insert the new row
 * with validFrom = now. Mirrors `upsertLocationMetadataBatch` in
 * src/resolvers/locationMetadata.resolver.ts.
 */
async function upsertBatch(payloads: UpsertPayload[]): Promise<number> {
  if (payloads.length === 0) return 0;

  // Defensive: refuse to touch any row whose type is owned by another
  // importer. The WHERE clause below already filters by `type`, so a
  // protected-type payload couldn't close an `iom_dtm_displacement` row in
  // practice — but it WOULD insert a new one. Fail fast instead.
  for (const p of payloads) {
    if (PROTECTED_TYPES.has(p.type)) {
      throw new Error(
        `Refusing to write payload with protected type '${p.type}' ` +
          `(locationId=${p.locationId}). This script only manages type='${METADATA_TYPE}'.`,
      );
    }
    if (p.type !== METADATA_TYPE) {
      // Belt-and-braces: every payload built by buildPayload() carries
      // METADATA_TYPE. Anything else means the JSON file or the builder was
      // tampered with — bail rather than silently writing surprising rows.
      throw new Error(
        `Unexpected payload type '${p.type}' (expected '${METADATA_TYPE}') ` +
          `for locationId=${p.locationId}. Aborting.`,
      );
    }
  }

  // Pre-filter to locationIds that actually exist (one query).
  const requestedIds = [...new Set(payloads.map((p) => p.locationId))];
  const existing = await prisma.locations.findMany({
    where: { id: { in: requestedIds } },
    select: { id: true },
  });
  const validIds = new Set(existing.map((l) => l.id));

  // pcode fallback — for payloads whose locationId came from the processor
  // but no longer resolves to a row (location was renamed / merged /
  // deleted), try the locality's pcode (stored on data._source.pcode by
  // buildPayload). Re-point the payload to the matching level-2 row when
  // found. Payloads that already have a valid locationId skip this entirely.
  const stale = payloads.filter((p) => !validIds.has(p.locationId));
  const staleWithPcode = stale
    .map((p) => {
      const src = (p.data._source ?? {}) as Record<string, unknown>;
      const pcode = typeof src.pcode === "string" ? src.pcode : null;
      return pcode ? { payload: p, pcode } : null;
    })
    .filter((x): x is { payload: UpsertPayload; pcode: string } => x !== null);

  if (staleWithPcode.length > 0) {
    const pcodes = [...new Set(staleWithPcode.map((x) => x.pcode))];
    const rescueRows = await prisma.locations.findMany({
      where: { level: 2, pCode: { in: pcodes } },
      select: { id: true, pCode: true },
    });
    const pcodeToId = new Map<string, string>();
    for (const r of rescueRows) {
      if (r.pCode) pcodeToId.set(r.pCode, r.id);
    }
    let rescued = 0;
    for (const { payload, pcode } of staleWithPcode) {
      const newId = pcodeToId.get(pcode);
      if (!newId) continue;
      // Mutate the payload's locationId in place and annotate _source so
      // the persisted row records why its id differs from the JSON input.
      payload.locationId = newId;
      const src = payload.data._source as Record<string, unknown> | undefined;
      if (src) src.resolved_via = "pcode_fallback";
      validIds.add(newId);
      rescued++;
    }
    if (rescued > 0) {
      console.warn(`  [info] rescued ${rescued} payload(s) via pcode fallback`);
    }
  }

  const valid = payloads.filter((p) => validIds.has(p.locationId));
  if (valid.length < payloads.length) {
    console.warn(
      `  [warn] skipping ${payloads.length - valid.length} payload(s) with unknown locationId (no pcode rescue available)`,
    );
  }
  if (valid.length === 0) return 0;

  const now = new Date();
  const closeClauses = valid.map((p) => ({
    locationId: p.locationId,
    type: p.type,
    validTo: null,
  }));
  const newRows = valid.map((p) => ({
    locationId: p.locationId,
    type: p.type,
    data: p.data as InputJsonValue,
    validFrom: now,
  }));

  // Callback-form transaction so we can pass a generous timeout — the
  // 5s default isn't always enough for a 50-row batch against a remote DB.
  await prisma.$transaction(
    async (tx) => {
      await tx.locationMetadata.updateMany({
        where: { OR: closeClauses },
        data: { validTo: now },
      });
      await tx.locationMetadata.createMany({ data: newRows });
    },
    { timeout: 30_000 },
  );
  return valid.length;
}

// ─── Entry point ──────────────────────────────────────────────────────────

interface Flags {
  inputPath: string | null;
  execute: boolean;
}

function parseFlags(): Flags {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1 || i === argv.length - 1) return null;
    return argv[i + 1] ?? null;
  };
  return {
    inputPath: get("--input"),
    execute: argv.includes("--execute"),
  };
}

async function resolveInputPath(explicit: string | null): Promise<string> {
  if (explicit) return explicit;
  // Default: newest msna_*.json under outputs/.
  const entries = await readdir(OUTPUT_DIR).catch(() => [] as string[]);
  const candidates = entries.filter((n) => n.startsWith("msna_") && n.endsWith(".json")).sort().reverse();
  if (candidates.length === 0) {
    throw new Error(`No msna_*.json found in ${OUTPUT_DIR}`);
  }
  return join(OUTPUT_DIR, candidates[0]!);
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const inputPath = await resolveInputPath(flags.inputPath);

  console.log(`Input:  ${inputPath}`);
  console.log(`Type:   ${METADATA_TYPE}`);
  console.log(`Mode:   ${flags.execute ? "EXECUTE" : "DRY RUN (pass --execute to write)"}`);
  console.log();

  const raw = await readFile(inputPath, "utf8");
  const processed = JSON.parse(raw) as ProcessedFile;
  const meta = processed.meta ?? {};
  const localities = processed.localities ?? {};

  const payloads: UpsertPayload[] = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(localities)) {
    const p = buildPayload(name, entry, meta);
    if (p) payloads.push(p);
    else skipped.push(name);
  }

  console.log(`Localities: ${Object.keys(localities).length}`);
  console.log(`  Will upsert: ${payloads.length}`);
  console.log(`  Skipped (no location_id): ${skipped.length}`);
  for (const s of skipped) console.log(`    - ${s}`);
  console.log();

  if (!flags.execute) {
    if (payloads.length === 0) {
      console.log("No payloads to preview.");
      return;
    }
    const sample = payloads[0]!;
    const sampleSource = (sample.data._source ?? {}) as Record<string, unknown>;
    const sampleSectors = (sample.data.sectors ?? {}) as Record<string, unknown>;
    console.log("Sample payload (first locality):");
    console.log(`  locationId:         ${sample.locationId}`);
    console.log(`  type:               ${sample.type}`);
    console.log(`  data.as_of:         ${String(sample.data.as_of ?? "")}`);
    console.log(`  data.sectors:       ${JSON.stringify(Object.keys(sampleSectors))}`);
    console.log(`  data._source.pcode: ${String(sampleSource.pcode ?? "")}`);
    console.log();
    console.log(`Would upsert ${payloads.length} records in batches of ${BATCH_SIZE}.`);
    console.log("Run with --execute to write.");
    return;
  }

  let total = 0;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    const written = await upsertBatch(batch);
    total += written;
    const end = Math.min(i + BATCH_SIZE, payloads.length);
    console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: wrote ${written} records (${i + 1}-${end})`);
  }
  console.log(`\nDone. ${total}/${payloads.length} records written.`);
}

main()
  .catch((err) => {
    console.error("[import-msna] Fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
