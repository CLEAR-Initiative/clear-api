/**
 * Seed (or reseed) the disaster_types table with the 3-level hierarchy.
 *
 * Usage:
 *   bun run scripts/seed-disaster-types.ts            # preserves existing IDs where possible
 *   bun run scripts/seed-disaster-types.ts --replace  # TRUNCATEs and reinserts
 *
 * NOTE: events.types, signals, etc. store glide codes (e.g. "fl", "pr") — those
 * references are NOT touched. Only the disaster_types lookup table is modified.
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

interface SeedEntry {
  type_level_1: string;
  type_level_2: string;
  type_level_3: string;
  id_type: "glide_number" | "clear_id";
  id: string;
}

const ENTRIES: SeedEntry[] = [
  { type_level_1: "natural hazard", type_level_2: "cold wave", type_level_3: "cold wave", id_type: "glide_number", id: "cw" },
  { type_level_1: "natural hazard", type_level_2: "heat wave", type_level_3: "heat wave", id_type: "glide_number", id: "ht" },
  { type_level_1: "natural hazard", type_level_2: "complex emergency", type_level_3: "complex emergency", id_type: "glide_number", id: "ce" },
  { type_level_1: "natural hazard", type_level_2: "drought", type_level_3: "drought", id_type: "glide_number", id: "dr" },
  { type_level_1: "natural hazard", type_level_2: "earthquake", type_level_3: "earthquake", id_type: "glide_number", id: "eq" },
  { type_level_1: "epidemic", type_level_2: "epidemic", type_level_3: "epidemic", id_type: "glide_number", id: "ep" },
  { type_level_1: "natural hazard", type_level_2: "extratropical cyclone", type_level_3: "extratropical cyclone", id_type: "glide_number", id: "ec" },
  { type_level_1: "natural hazard", type_level_2: "fire", type_level_3: "fire", id_type: "glide_number", id: "fr" },
  { type_level_1: "natural hazard", type_level_2: "flash flood", type_level_3: "flash flood", id_type: "glide_number", id: "ff" },
  { type_level_1: "natural hazard", type_level_2: "flood", type_level_3: "flood", id_type: "glide_number", id: "fl" },
  { type_level_1: "natural hazard", type_level_2: "insect infestation", type_level_3: "insect infestation", id_type: "glide_number", id: "in" },
  { type_level_1: "natural hazard", type_level_2: "slide", type_level_3: "slide", id_type: "glide_number", id: "sl" },
  { type_level_1: "natural hazard", type_level_2: "land slide", type_level_3: "land slide", id_type: "glide_number", id: "ls" },
  { type_level_1: "natural hazard", type_level_2: "mud slide", type_level_3: "mud slide", id_type: "glide_number", id: "ms" },
  { type_level_1: "natural hazard", type_level_2: "snow avalanche", type_level_3: "snow avalanche", id_type: "glide_number", id: "av" },
  { type_level_1: "natural hazard", type_level_2: "severe local storm", type_level_3: "severe local storm", id_type: "glide_number", id: "st" },
  { type_level_1: "technological disaster", type_level_2: "technological disaster", type_level_3: "technological disaster", id_type: "glide_number", id: "ac" },
  { type_level_1: "natural hazard", type_level_2: "tornado", type_level_3: "tornado", id_type: "glide_number", id: "to" },
  { type_level_1: "natural hazard", type_level_2: "tropical cyclone", type_level_3: "tropical cyclone", id_type: "glide_number", id: "tc" },
  { type_level_1: "natural hazard", type_level_2: "storm surge", type_level_3: "storm surge", id_type: "glide_number", id: "ss" },
  { type_level_1: "natural hazard", type_level_2: "tsunami", type_level_3: "tsunami", id_type: "glide_number", id: "ts" },
  { type_level_1: "natural hazard", type_level_2: "volcano", type_level_3: "volcano", id_type: "glide_number", id: "vo" },
  { type_level_1: "natural hazard", type_level_2: "wild fire", type_level_3: "wild fire", id_type: "glide_number", id: "wf" },
  { type_level_1: "natural hazard", type_level_2: "violent wind", type_level_3: "violent wind", id_type: "glide_number", id: "vw" },
  { type_level_1: "natural hazard", type_level_2: "other", type_level_3: "other", id_type: "glide_number", id: "ot" },
  { type_level_1: "conflict", type_level_2: "protests", type_level_3: "peaceful protest", id_type: "clear_id", id: "pp" },
  { type_level_1: "conflict", type_level_2: "protests", type_level_3: "protest with intervention", id_type: "clear_id", id: "pi" },
  { type_level_1: "conflict", type_level_2: "protests", type_level_3: "excessive force against protesters", id_type: "clear_id", id: "pf" },
  { type_level_1: "conflict", type_level_2: "battles", type_level_3: "armed clash", id_type: "clear_id", id: "ba" },
  { type_level_1: "conflict", type_level_2: "battles", type_level_3: "government regains territory", id_type: "clear_id", id: "bg" },
  { type_level_1: "conflict", type_level_2: "battles", type_level_3: "non-state actor overtakes territory", id_type: "clear_id", id: "bo" },
  { type_level_1: "conflict", type_level_2: "riots", type_level_3: "mob violence", id_type: "clear_id", id: "ri" },
  { type_level_1: "conflict", type_level_2: "riots", type_level_3: "violent demonstration", id_type: "clear_id", id: "rd" },
  { type_level_1: "conflict", type_level_2: "explosions or remote violence", type_level_3: "chemical weapon", id_type: "clear_id", id: "rc" },
  { type_level_1: "conflict", type_level_2: "explosions or remote violence", type_level_3: "grenade", id_type: "clear_id", id: "rg" },
  { type_level_1: "conflict", type_level_2: "explosions or remote violence", type_level_3: "air or drone strike", id_type: "clear_id", id: "rs" },
  { type_level_1: "conflict", type_level_2: "explosions or remote violence", type_level_3: "shelling or artillery or missile attack", id_type: "clear_id", id: "rm" },
  { type_level_1: "conflict", type_level_2: "explosions or remote violence", type_level_3: "remote explosive or landmine or ied", id_type: "clear_id", id: "rl" },
  { type_level_1: "conflict", type_level_2: "explosions or remote violence", type_level_3: "suicide bomb", id_type: "clear_id", id: "rb" },
  { type_level_1: "conflict", type_level_2: "violence against civilians", type_level_3: "attack", id_type: "clear_id", id: "va" },
  { type_level_1: "conflict", type_level_2: "violence against civilians", type_level_3: "sexual violence", id_type: "clear_id", id: "vs" },
  { type_level_1: "conflict", type_level_2: "violence against civilians", type_level_3: "abduction or forced disappearance", id_type: "clear_id", id: "vd" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "agreement", id_type: "clear_id", id: "pv" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "arrests", id_type: "clear_id", id: "pa" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "change to group or activity", id_type: "clear_id", id: "pg" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "disrupted weapons use", id_type: "clear_id", id: "pw" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "headquarters or base established", id_type: "clear_id", id: "ph" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "looting or property destruction", id_type: "clear_id", id: "pl" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "non-violent transfer of territory", id_type: "clear_id", id: "pt" },
  { type_level_1: "conflict", type_level_2: "strategic developments or political violence", type_level_3: "other", id_type: "clear_id", id: "po" },
  { type_level_1: "economic crisis", type_level_2: "economic crisis", type_level_3: "economic crisis", id_type: "clear_id", id: "fc" },
  { type_level_1: "famine", type_level_2: "famine", type_level_3: "famine", id_type: "clear_id", id: "fa" },
];

/**
 * Mapping from OLD glide codes (pre-hierarchy update) → NEW codes.
 * Applied to events.types, signals.* if needed, and userAlertSubscriptions.alertType.
 * Only codes that changed or were split are listed; codes still valid stay as-is.
 */
const OLD_TO_NEW_CODE: Record<string, string> = {
  // protests: old "pr" was one umbrella → map to peaceful protest (most neutral)
  pr: "pp",
  // explosions or remote violence: old "rv" was one umbrella → map to shelling (most common)
  rv: "rm",
  // violence against civilians: old "vc" → map to attack (most general)
  vc: "va",
  // ba, ri, pv still exist in the new list — no remap needed
};

async function main() {
  const replace = process.argv.includes("--replace");

  if (replace) {
    console.log("[seed] --replace: truncating disaster_types");
    await prisma.$executeRaw`TRUNCATE TABLE disaster_types RESTART IDENTITY CASCADE`;
  }

  // Natural key: (disasterClass, disasterType) = (level_1, level_3).
  // Matches old rows where disasterType="peaceful protest" + disasterClass="conflict"
  // → updates glideNumber from legacy "pr" to new "pp".
  for (const e of ENTRIES) {
    const existing = await prisma.disasterTypes.findFirst({
      where: {
        disasterClass: e.type_level_1,
        disasterType: e.type_level_3,
      },
    });

    const data = {
      disasterType: e.type_level_3,
      disasterClass: e.type_level_1,
      glideNumber: e.id,
      level1: e.type_level_1,
      level2: e.type_level_2,
      idType: e.id_type,
    };

    if (existing) {
      await prisma.disasterTypes.update({ where: { id: existing.id }, data });
    } else {
      await prisma.disasterTypes.create({ data });
    }
  }

  const count = await prisma.disasterTypes.count();
  console.log(`[seed] disaster_types now has ${count} rows`);

  // ───────────────────────────────────────────────────────────────
  // Remap legacy codes on existing events, signals, alert subscriptions.
  // Only touches rows whose code(s) actually changed.
  // ───────────────────────────────────────────────────────────────
  const oldCodes = Object.keys(OLD_TO_NEW_CODE);
  if (oldCodes.length > 0) {
    console.log("[seed] Remapping legacy glide codes:", OLD_TO_NEW_CODE);

    // events.types is String[]; rewrite in-app and save back.
    const eventsToMigrate = await prisma.events.findMany({
      where: { types: { hasSome: oldCodes } },
      select: { id: true, types: true },
    });
    for (const ev of eventsToMigrate) {
      const next = ev.types.map((t) => OLD_TO_NEW_CODE[t] ?? t);
      // Dedup in case a remap produced a duplicate
      const deduped = [...new Set(next)];
      await prisma.events.update({
        where: { id: ev.id },
        data: { types: deduped },
      });
    }
    console.log(`[seed] migrated types[] on ${eventsToMigrate.length} events`);

    // userAlertSubscriptions.alertType is a scalar — use updateMany per old code.
    let subsUpdated = 0;
    for (const [oldCode, newCode] of Object.entries(OLD_TO_NEW_CODE)) {
      const { count: n } = await prisma.userAlertSubscriptions.updateMany({
        where: { alertType: oldCode },
        data: { alertType: newCode },
      });
      subsUpdated += n;
    }
    console.log(`[seed] migrated ${subsUpdated} alert subscriptions`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
