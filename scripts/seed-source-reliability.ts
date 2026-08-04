/**
 * Seed (or reseed) source-reliability grades, synonyms, and info URLs on the
 * data_sources registry, as type "organisation" rows for report attribution.
 *
 * Implements the ADR-0004 §5 reliability seed. Grades are PROPOSED defaults
 * pending domain sign-off (docs/data-quality-scoring-design.md §5.2); once
 * seeded, a grader edits in-app via updateDataSource (re-running this realigns
 * to the seed values, so seed once then grade).
 *
 * API vs organisation: the existing feed rows (dtm/acled/gdacs/dataminr =
 * "api", field_officer = "manual") are the signal-ingestion sources referenced
 * by signals.sourceId — this script does NOT touch them. When a seed entry
 * matches only such a feed row (by name/synonym), a SEPARATE type="organisation"
 * row is created for it, leaving the feed row intact. Matching an existing
 * organisation row updates it in place. Idempotent + re-runnable.
 *
 * Usage:
 *   bun run scripts/seed-source-reliability.ts             # apply
 *   bun run scripts/seed-source-reliability.ts --dry-run   # preview, no writes
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

const ORG_TYPE = "organisation";

interface SeedEntry {
  /** Canonical display name for a newly-created row. */
  name: string;
  /** Alias variants (do NOT repeat the canonical name). Includes any existing
   *  feed slug so this entry matches that row and splits off an org row. */
  synonyms: string[];
  reliability: 1 | 2 | 3 | 4;
  /** Organisation homepage — also lets resolveDataSource match a publisher by
   *  its ReliefWeb homepage URL. */
  infoUrl?: string;
}

// ADR-0004 §5. Grade 4 is reserved (Lancet/Nature-tier) — none in-corpus yet.
const ENTRIES: SeedEntry[] = [
  // ── Grade 3 — usually reliable (UN agencies, major INGOs, curated datasets) ──
  { name: "OCHA", reliability: 3, infoUrl: "https://www.unocha.org", synonyms: ["UN OCHA", "Office for the Coordination of Humanitarian Affairs"] },
  { name: "UNHCR", reliability: 3, infoUrl: "https://www.unhcr.org", synonyms: ["UN Refugee Agency", "United Nations High Commissioner for Refugees"] },
  { name: "UNICEF", reliability: 3, infoUrl: "https://www.unicef.org", synonyms: ["United Nations Children's Fund"] },
  { name: "WHO", reliability: 3, infoUrl: "https://www.who.int", synonyms: ["World Health Organization", "World Health Organisation"] },
  { name: "WFP", reliability: 3, infoUrl: "https://www.wfp.org", synonyms: ["World Food Programme", "World Food Program"] },
  { name: "FAO", reliability: 3, infoUrl: "https://www.fao.org", synonyms: ["Food and Agriculture Organization"] },
  { name: "IOM DTM", reliability: 3, infoUrl: "https://dtm.iom.int", synonyms: ["IOM", "International Organization for Migration", "DTM", "Displacement Tracking Matrix", "dtm"] },
  { name: "IPC", reliability: 3, infoUrl: "https://www.ipcinfo.org", synonyms: ["Integrated Food Security Phase Classification", "Cadre Harmonisé", "Cadre Harmonise", "CH"] },
  { name: "FEWS NET", reliability: 3, infoUrl: "https://fews.net", synonyms: ["Famine Early Warning Systems Network", "FEWSNET"] },
  { name: "ACAPS", reliability: 3, infoUrl: "https://www.acaps.org", synonyms: ["acaps"] },
  { name: "MSF", reliability: 3, infoUrl: "https://www.msf.org", synonyms: ["Médecins Sans Frontières", "Medecins Sans Frontieres", "Doctors Without Borders"] },
  { name: "ICRC", reliability: 3, infoUrl: "https://www.icrc.org", synonyms: ["International Committee of the Red Cross"] },
  { name: "NRC", reliability: 3, infoUrl: "https://www.nrc.no", synonyms: ["Norwegian Refugee Council"] },
  { name: "Save the Children", reliability: 3, infoUrl: "https://www.savethechildren.net", synonyms: ["Save the Children International"] },
  { name: "ACLED", reliability: 3, infoUrl: "https://acleddata.com", synonyms: ["Armed Conflict Location & Event Data Project", "acled"] },
  { name: "GDACS", reliability: 3, infoUrl: "https://www.gdacs.org", synonyms: ["Global Disaster Alert and Coordination System", "gdacs"] },
  // NRC's own trained field staff. Sign-off open question: 3 (our staff) vs 2 —
  // seeded at 3 as the proposed default (docs §5.2). No public homepage.
  { name: "NRC field officer", reliability: 3, synonyms: ["field_officer", "field officer"] },

  // ── Grade 2 — fairly reliable ──
  { name: "Dataminr", reliability: 2, infoUrl: "https://www.dataminr.com", synonyms: ["dataminr"] },
];

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Merge new alias candidates into an existing synonym list: union, deduped
 * case-insensitively (first-seen casing wins), never including the canonical
 * name itself.
 */
function mergeSynonyms(canonicalName: string, existing: string[], candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>([norm(canonicalName)]);
  for (const s of [...existing, ...candidates]) {
    const key = norm(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s.trim());
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("[seed] --dry-run: no writes will be made\n");

  // Small registry table — load once and match in-app (avoids fiddly SQL
  // array binding, and lets us keep the local cache in sync as we go).
  const all = await prisma.dataSources.findMany();

  const matchesFor = (names: string[]) => {
    const set = new Set(names.map(norm));
    return all.filter(
      (r) => set.has(norm(r.name)) || r.synonyms.some((s) => set.has(norm(s))),
    );
  };

  let updated = 0;
  let created = 0;

  for (const e of ENTRIES) {
    const names = [e.name, ...e.synonyms];
    const matches = matchesFor(names);
    const orgMatch = matches.find((r) => r.type === ORG_TYPE);

    if (orgMatch) {
      const merged = mergeSynonyms(orgMatch.name, orgMatch.synonyms, names);
      console.log(
        `[seed] update  "${orgMatch.name}"  reliability ${orgMatch.reliability ?? "∅"} → ${e.reliability}  (+${merged.length - orgMatch.synonyms.length} synonyms)`,
      );
      if (!dryRun) {
        await prisma.dataSources.update({
          where: { id: orgMatch.id },
          data: { reliability: e.reliability, synonyms: merged, infoUrl: e.infoUrl ?? undefined },
        });
      }
      orgMatch.reliability = e.reliability;
      orgMatch.synonyms = merged;
      if (e.infoUrl) orgMatch.infoUrl = e.infoUrl;
      updated++;
    } else {
      const feed = matches.find((r) => r.type !== ORG_TYPE);
      console.log(
        feed
          ? `[seed] create  "${e.name}"  reliability ${e.reliability}  type=organisation  (feed row "${feed.name}" [${feed.type}] left intact)`
          : `[seed] create  "${e.name}"  reliability ${e.reliability}  type=organisation`,
      );
      if (!dryRun) {
        const row = await prisma.dataSources.create({
          data: {
            name: e.name,
            type: ORG_TYPE,
            reliability: e.reliability,
            synonyms: e.synonyms,
            infoUrl: e.infoUrl,
          },
        });
        all.push(row);
      }
      created++;
    }
  }

  console.log(`\n[seed] ${dryRun ? "(dry-run) would " : ""}update ${updated}, create ${created} (of ${ENTRIES.length} entries)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
