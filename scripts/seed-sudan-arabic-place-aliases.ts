/**
 * Seed the Arabic names of Sudan's states and districts as place aliases
 * (ADR-0019, Exponential #1417).
 *
 * A post can name a district in Arabic ("محلية أمبرو") and still be stored at
 * state level. Each alias maps one Arabic spelling to the CLEAR state or
 * district itself, with `source = "seed"`. The gazetteer asks aliases before
 * GeoNames, and the pipeline uses an alias's location as it is.
 *
 * Names: `scripts/data/sudan-admin-arabic-names.json`, from OCHA's admin
 * boundary dataset (pCode, level, Arabic name). Short forms come from
 * `arabicSpellings`; `EXTRA` below adds the spellings no rule derives.
 *
 * It plans first and writes nothing unless `--apply` is given.
 *
 *   bun run scripts/seed-sudan-arabic-place-aliases.ts                  # plan: missing names only
 *   bun run scripts/seed-sudan-arabic-place-aliases.ts --all            # plan: every name
 *   bun run scripts/seed-sudan-arabic-place-aliases.ts --out plan.json  # write the plan to a file
 *   bun run scripts/seed-sudan-arabic-place-aliases.ts --apply --expect-country-id <id>
 *
 * Default (missing names only): a spelling the gazetteer already answers from
 * GeoNames gets no alias. For a district that answer is a point inside it,
 * which is finer than the district; an alias would replace it. `--all` seeds
 * every name.
 *
 * `--expect-country-id` is the id of the Sudan location in the database you
 * mean to write to. Dev and prod have different ids, so a tunnel that points
 * at the wrong database fails here. Safe to run again: an alias that exists
 * is left as it is.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { applyAdminNameAliases, planAdminNameAliases, type AdminArabicName } from "../src/services/place-alias-seed.js";

// Spellings posts use that the official names do not give.
const EXTRA: Record<string, string[]> = {
  SD11060: ["القربة"], // Reifi Khashm Elgirba: "خشم القربة" is derived, posts also say "القربة"
  SD03145: ["مرشينق", "مرشينج"], // Mershing: official "مرشنج"
};

const NOTE = "Seed: Arabic names of Sudan's states and districts (OCHA COD-AB), Exponential #1417";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const data = JSON.parse(
    readFileSync(fileURLToPath(new URL("./data/sudan-admin-arabic-names.json", import.meta.url)), "utf8"),
  ) as { countryCode: string; sha256: string; rows: AdminArabicName[] };

  // Fingerprint: enough to tell one environment from another, no secrets.
  const [locations, aliases, seeded, openRows] = await Promise.all([
    prisma.locations.count({ where: { level: { in: [0, 1, 2] } } }),
    prisma.placeAliases.count(),
    prisma.placeAliases.count({ where: { source: "seed" } }),
    prisma.unresolvedPlaceNames.count({ where: { status: { in: ["open", "ambiguous"] } } }),
  ]);
  const plan = await planAdminNameAliases(prisma, { countryCode: data.countryCode, rows: data.rows, extra: EXTRA });
  console.log(
    `database: Sudan location ${plan.countryLocationId}; ${locations} admin locations, ` +
      `${aliases} place aliases (${seeded} seeded), ${openRows} open queue rows`,
  );

  const all = flag("--all");
  const chosen = all ? plan.aliases : plan.aliases.filter((a) => !a.knownToGeonames);
  const known = plan.aliases.filter((a) => a.knownToGeonames).length;
  console.log(
    `names: ${data.rows.length} areas (data sha256 ${data.sha256.slice(0, 12)}…) → ${plan.aliases.length} spellings; ` +
      `${known} already answered by GeoNames; ${plan.skipped.length} skipped`,
  );
  console.log(`mode: ${all ? "every name (--all)" : "missing names only"} → ${chosen.length} aliases`);
  for (const s of plan.skipped) console.log(`  skipped ${s.pCode} "${s.spelling}": ${s.why}`);

  const out = value("--out");
  if (out) {
    writeFileSync(out, JSON.stringify({ ...plan, mode: all ? "all" : "missing", chosen }, null, 1));
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
  const result = await applyAdminNameAliases(prisma, { countryCode: plan.countryCode, aliases: chosen }, { note: NOTE });
  console.log(
    `written: ${result.created} aliases created, ${result.alreadyThere} already there; ` +
      `${result.rowsResolved} queue rows resolved, ${result.signalsMoved} waiting signals moved`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
