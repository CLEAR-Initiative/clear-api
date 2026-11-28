/**
 * Seed town points for Sudan districts whose town GeoNames lacks, with their
 * spellings as place aliases (Exponential #1709, ADR-0019).
 *
 * Many towns share a name with their district: Al Lait, Um Dafoug, Foro
 * Baranga. GeoNames has only the district record for them, so the gazetteer
 * gives the district and never the town (D-0288). Each town becomes a level-4
 * location (`point_type = 'seed'`) under its district. Each spelling becomes
 * an alias with `source = "seed"`, scoped to the town's state. The gazetteer
 * asks aliases before GeoNames.
 *
 * Towns: `scripts/data/sudan-district-towns.json`, built by
 * `scripts/data/build-sudan-district-towns.py` from OSM (HOT export, ODbL),
 * OCHA Sudan Settlements (CC BY) and GeoNames. The file lists the districts
 * it leaves out and why.
 *
 * It plans first and writes nothing unless `--apply` is given.
 *
 *   bun run scripts/seed-sudan-district-town-aliases.ts                  # plan
 *   bun run scripts/seed-sudan-district-town-aliases.ts --out plan.json  # write the plan to a file
 *   bun run scripts/seed-sudan-district-town-aliases.ts --apply --expect-country-id <id>
 *
 * `--expect-country-id` is the id of the Sudan location in the database you
 * mean to write to. Dev and prod have different ids, so a tunnel that points
 * at the wrong database fails here. Safe to run again.
 *
 * Undo: delete the aliases with this script's note, then the level-4
 * locations with `point_type = 'seed'` that nothing points at.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { applyDistrictTownAliases, planDistrictTownAliases, type DistrictTown } from "../src/services/district-town-seed.js";

const NOTE = "Seed: town points for Sudan districts whose town GeoNames lacks (OSM, OCHA, GeoNames), Exponential #1709";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const raw = readFileSync(fileURLToPath(new URL("./data/sudan-district-towns.json", import.meta.url)), "utf8");
  const data = JSON.parse(raw) as { countryCode: string; towns: DistrictTown[]; leftOut: unknown[] };
  const sha = createHash("sha256").update(raw).digest("hex");

  const [towns, aliases, seeded] = await Promise.all([
    prisma.locations.count({ where: { level: 4, pointType: "seed" } }),
    prisma.placeAliases.count(),
    prisma.placeAliases.count({ where: { note: NOTE } }),
  ]);
  const plan = await planDistrictTownAliases(prisma, { countryCode: data.countryCode, towns: data.towns });
  console.log(
    `database: Sudan location ${plan.countryLocationId}; ${towns} seeded town locations, ` +
      `${aliases} place aliases (${seeded} from this seed)`,
  );
  const spellings = plan.towns.reduce((n, t) => n + t.spellings.length, 0);
  console.log(
    `towns: ${data.towns.length} in the file (sha256 ${sha.slice(0, 12)}…, ${data.leftOut.length} districts left out there) → ` +
      `${plan.towns.length} towns, ${spellings} aliases; ${plan.skippedTowns.length} towns and ` +
      `${plan.skippedSpellings.length} spellings skipped`,
  );
  for (const t of plan.towns) {
    const moved = t.movedKm != null ? ` (moved ${t.movedKm} km into the district)` : "";
    const reuse = t.existingLocationId ? " [reuses a location]" : "";
    console.log(`  ${t.pCode} ${t.name}${moved}${reuse}: ${t.spellings.map((s) => s.nameDisplay).join(" / ")}`);
    for (const o of t.overrides) console.log(`      "${o.nameNorm}" now means this town in its state, not ${o.locationName}`);
  }
  for (const s of plan.skippedTowns) console.log(`  skipped ${s.pCode} ${s.district}: ${s.why}`);
  for (const s of plan.skippedSpellings) console.log(`  skipped ${s.pCode} "${s.spelling}": ${s.why}`);

  const out = value("--out");
  if (out) {
    writeFileSync(out, JSON.stringify(plan, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
    console.log(`plan written to ${out}`);
  }

  if (!flag("--apply")) {
    console.log("plan only: nothing written. Add --apply --expect-country-id <id> to write.");
    return;
  }
  const expected = value("--expect-country-id");
  if (expected !== plan.countryLocationId) {
    console.error(
      `--expect-country-id ${expected ?? "(missing)"} is not this database's Sudan location ` +
        `(${plan.countryLocationId}). Nothing written.`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await applyDistrictTownAliases(prisma, plan, { note: NOTE });
  console.log(
    `written: ${result.locationsCreated} town locations created, ${result.locationsReused} reused; ` +
      `${result.created} aliases created, ${result.alreadyThere} already there; ` +
      `${result.rowsResolved} queue rows resolved, ${result.signalsMoved} waiting signals moved`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
