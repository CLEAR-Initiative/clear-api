import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { normalizeGazetteerName } from "../utils/geonames-normalize.js";
import { RESOLVABLE_STATUSES, aliasCoversState, countryLocationIdForCode, moveWaitingSignals } from "./place-names.js";

// ─── Seeding place aliases from a list of admin names (ADR-0019, #1417) ──────
// A post can name a district in Arabic ("محلية أمبرو") and still be stored at
// state level: the model matches English names, and the Arabic name reaches a
// district only when the gazetteer knows it. This turns a list of the Arabic
// names of a country's states and districts into place aliases that point at
// the CLEAR locations themselves, with `source = "seed"`.

/** One state or district and its name in Arabic, keyed by pCode. */
export interface AdminArabicName {
  pCode: string;
  level: number;
  name: string;
  nameAr: string;
}

export interface PlannedAlias {
  nameNorm: string;
  nameDisplay: string;
  /** The CLEAR location the spelling means: a state or a district. */
  locationId: string;
  locationName: string;
  pCode: string;
  level: number;
  /** A state, when two districts of different states share the spelling. Null: the whole country. */
  scopeLocationId: string | null;
  /** GeoNames already has an exact match for the spelling: inside the
   *  location (a district), or anywhere in the country (a state). */
  knownToGeonames: boolean;
}

export interface SkippedSpelling {
  spelling: string;
  pCode: string;
  why: string;
}

export interface AliasSeedPlan {
  countryCode: string;
  countryLocationId: string;
  aliases: PlannedAlias[];
  skipped: SkippedSpelling[];
}

// Words that say what kind of area a name is, not which one: "ريفي كسلا"
// (rural Kassala), "مدينة القضارف" (Gedaref town), "محلية الخوي".
const KIND_WORDS = ["ريفي", "مدينه", "محليه", "اداريه", "منطقه"];

/**
 * The spellings a post may use for an admin area, from its official Arabic
 * name. The official name first, then the shorter forms:
 *
 * - without a state suffix: "التضامن - ج ك" (At Tadamon, South Kordofan) → "التضامن"
 * - without a leading kind word: "ريفى خشم القربة" → "خشم القربة"
 * - "أم برو" → "أمبرو", "أبو حمد" → "أبوحمد": posts join these words
 *
 * Each is returned as written (for display); the caller normalises.
 */
export function arabicSpellings(nameAr: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const trimmed = s.replace(/\s+/g, " ").trim();
    if (trimmed && normalizeGazetteerName(trimmed).replace(/ /g, "").length >= 3 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };
  const official = nameAr.trim();
  add(official);
  const base = official.replace(/\s+-\s+.*$/, "");
  add(base);
  const words = base.split(/\s+/);
  let short = base;
  if (words.length > 1 && KIND_WORDS.includes(normalizeGazetteerName(words[0]!))) {
    short = words.slice(1).join(" ");
    add(short);
  }
  for (const form of [base, short]) {
    const [first, ...rest] = form.split(/\s+/);
    if (rest.length > 0 && ["ام", "ابو"].includes(normalizeGazetteerName(first!))) {
      add(first + rest.join(" "));
    }
  }
  return out;
}

interface AreaRow {
  id: string;
  name: string;
  level: number;
  pCode: string;
  parentId: string | null;
}

/**
 * Plan the aliases for a list of admin names. Reads only.
 *
 * `extra` adds spellings by pCode that no rule derives (a common short form,
 * a spelling posts use that the official list does not).
 *
 * One spelling can name more than one area. The plan settles each case:
 *
 * - A state and a district share it (الخرطوم): the state gets it. A post
 *   that names only a state stays at the state.
 * - Districts of different states share it (الرهد): each gets an alias
 *   scoped to its own state.
 * - Two districts of one state share it: no alias, and the plan says so.
 */
export async function planAdminNameAliases(
  prisma: PrismaClient,
  args: { countryCode: string; rows: AdminArabicName[]; extra?: Record<string, string[]> },
): Promise<AliasSeedPlan> {
  const countryCode = args.countryCode.toUpperCase();
  const countryLocationId = await countryLocationIdForCode(prisma, countryCode);
  if (!countryLocationId) throw new Error(`CLEAR has no country location for ${countryCode}.`);

  const areas = await prisma.locations.findMany({
    where: { level: { in: [1, 2] }, ancestorIds: { has: countryLocationId }, pCode: { in: args.rows.map((r) => r.pCode) } },
    select: { id: true, name: true, level: true, pCode: true, parentId: true },
  });
  const byPCode = new Map<string, AreaRow>();
  for (const a of areas) if (a.pCode) byPCode.set(`${a.level}:${a.pCode}`, a as AreaRow);

  const skipped: SkippedSpelling[] = [];
  const owners = new Map<string, Array<{ area: AreaRow; display: string }>>();
  for (const row of args.rows) {
    const area = byPCode.get(`${row.level}:${row.pCode}`);
    if (!area) {
      skipped.push({ spelling: row.nameAr, pCode: row.pCode, why: "CLEAR has no location with this pCode at this level" });
      continue;
    }
    for (const display of [...arabicSpellings(row.nameAr), ...(args.extra?.[row.pCode] ?? [])]) {
      const norm = normalizeGazetteerName(display);
      if (!norm) continue;
      const list = owners.get(norm) ?? [];
      if (!list.some((o) => o.area.id === area.id)) list.push({ area, display });
      owners.set(norm, list);
    }
  }

  const chosen: Array<{ norm: string; display: string; area: AreaRow; scopeLocationId: string | null }> = [];
  for (const [norm, list] of owners) {
    const states = list.filter((o) => o.area.level === 1);
    const districts = list.filter((o) => o.area.level === 2);
    if (states.length > 0) {
      const state = states[0]!;
      chosen.push({ norm, display: state.display, area: state.area, scopeLocationId: null });
      for (const d of districts) {
        skipped.push({ spelling: d.display, pCode: d.area.pCode, why: `also the name of the state ${state.area.name}: the state gets it` });
      }
      continue;
    }
    if (districts.length === 1) {
      chosen.push({ norm, display: districts[0]!.display, area: districts[0]!.area, scopeLocationId: null });
      continue;
    }
    const perState = new Map<string, typeof districts>();
    for (const d of districts) {
      const key = d.area.parentId ?? "";
      perState.set(key, [...(perState.get(key) ?? []), d]);
    }
    for (const [stateId, group] of perState) {
      if (group.length === 1 && stateId) {
        chosen.push({ norm, display: group[0]!.display, area: group[0]!.area, scopeLocationId: stateId });
      } else {
        for (const d of group) {
          skipped.push({ spelling: d.display, pCode: d.area.pCode, why: "two districts of one state share this spelling" });
        }
      }
    }
  }

  const aliases: PlannedAlias[] = [];
  for (const c of chosen) {
    aliases.push({
      nameNorm: c.norm,
      nameDisplay: c.display,
      locationId: c.area.id,
      locationName: c.area.name,
      pCode: c.area.pCode,
      level: c.area.level,
      scopeLocationId: c.scopeLocationId,
      knownToGeonames: await knownToGeonames(prisma, c.norm, countryCode, c.area),
    });
  }
  aliases.sort((a, b) => a.pCode.localeCompare(b.pCode) || a.nameNorm.localeCompare(b.nameNorm));
  return { countryCode, countryLocationId, aliases, skipped };
}

/**
 * Whether the gazetteer answers the spelling today without an alias: for a
 * district, an exact GeoNames match inside it (the pipeline then stores a
 * point in the district, which is finer than the district); for a state, any
 * match of that name in the country (الخرطوم is also the city).
 * An alias is asked before GeoNames, so one for such a spelling would
 * replace that answer.
 */
async function knownToGeonames(prisma: PrismaClient, nameNorm: string, countryCode: string, area: AreaRow): Promise<boolean> {
  const inArea =
    area.level === 2
      ? Prisma.sql`AND ST_Contains((SELECT l."geometry" FROM "locations" l WHERE l."id" = ${area.id}),
                                    ST_SetSRID(ST_MakePoint(g.longitude, g.latitude), 4326))`
      : Prisma.empty;
  const rows = await prisma.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "geonames_name" n JOIN "geonames" g ON g.geonames_id = n.geonames_id
      WHERE n.name_norm = ${nameNorm} AND n.country_code = ${countryCode} ${inArea}
    ) AS found`;
  return rows[0]?.found ?? false;
}

export interface AliasSeedResult {
  created: number;
  alreadyThere: number;
  rowsResolved: number;
  signalsMoved: number;
}

/**
 * Write the planned aliases with `source = "seed"`, in ONE transaction, and
 * close the open queue rows they answer (by the row's own spelling or its
 * Arabic one), as an alias made by hand does. An alias that exists already
 * for a spelling and scope is left as it is, and a row whose spelling an
 * alias made by hand answers in its state is left to that alias. Safe to
 * run again.
 */
export async function applyAdminNameAliases(
  prisma: PrismaClient,
  plan: { countryCode: string; aliases: PlannedAlias[] },
  options: { note: string; now?: Date },
): Promise<AliasSeedResult> {
  const now = options.now ?? new Date();
  return prisma.$transaction(
    async (tx) => {
      const { count: created } = await tx.placeAliases.createMany({
        data: plan.aliases.map((a) => ({
          nameNorm: a.nameNorm,
          nameDisplay: a.nameDisplay,
          countryCode: plan.countryCode,
          scopeLocationId: a.scopeLocationId,
          locationId: a.locationId,
          source: "seed",
          createdById: null,
          note: options.note,
        })),
        skipDuplicates: true,
      });

      // Every alias for these spellings as it is stored now, under a row
      // lock held to the end of this transaction: one that a person re-scopes
      // or deletes meanwhile waits, so no row closes under an alias that no
      // longer applies. Aliases made by hand are read too: the answer for a
      // row is the alias the gazetteer would pick, whoever made it.
      const norms = [...new Set(plan.aliases.map((a) => a.nameNorm))];
      const stored = await tx.$queryRaw<
        { id: string; nameNorm: string; scopeLocationId: string | null; locationId: string; source: string; createdAt: Date }[]
      >`
        SELECT "id", "name_norm" AS "nameNorm", "scope_location_id" AS "scopeLocationId",
               "location_id" AS "locationId", "source", "created_at" AS "createdAt"
        FROM "place_aliases"
        WHERE "country_code" = ${plan.countryCode} AND "name_norm" = ANY(${norms}::text[])
        ORDER BY "created_at" ASC, "id" ASC
        FOR UPDATE`;
      const bySpelling = new Map<string, typeof stored>();
      for (const alias of stored) bySpelling.set(alias.nameNorm, [...(bySpelling.get(alias.nameNorm) ?? []), alias]);
      const planned = new Set(plan.aliases.map((a) => `${a.nameNorm}\u0000${a.scopeLocationId ?? ""}\u0000${a.locationId}`));
      const isThisSeed = (a: (typeof stored)[number]) =>
        a.source === "seed" && planned.has(`${a.nameNorm}\u0000${a.scopeLocationId ?? ""}\u0000${a.locationId}`);

      const rows = await tx.unresolvedPlaceNames.findMany({
        where: { countryCode: plan.countryCode, status: { in: [...RESOLVABLE_STATUSES] } },
        select: { id: true, nameNorm: true, nameAr: true, stateLocationId: true, status: true },
      });
      let rowsResolved = 0;
      let signalsMoved = 0;
      for (const row of rows) {
        // The row's own spelling first, then its Arabic ones. For each, the
        // alias the lookup picks in the row's state (`findPlaceAlias`): a
        // scoped one wins over a country-wide one, then the oldest. When
        // that alias is not one of this seed's, a person's answer stands
        // for the spelling and the row is left to them.
        const spellings = [row.nameNorm, ...(row.nameAr ? arabicSpellings(row.nameAr).map(normalizeGazetteerName) : [])];
        let alias: (typeof stored)[number] | undefined;
        for (const spelling of spellings) {
          const covering = (bySpelling.get(spelling) ?? []).filter((a) => aliasCoversState(a.scopeLocationId, row.stateLocationId));
          const picked = covering.find((a) => a.scopeLocationId) ?? covering[0];
          if (!picked) continue;
          alias = isThisSeed(picked) ? picked : undefined;
          break;
        }
        if (!alias) continue;
        const { count } = await tx.unresolvedPlaceNames.updateMany({
          where: { id: row.id, status: row.status },
          data: { status: "resolved", resolvedById: null, resolvedAt: now, resolutionNote: options.note, placeAliasId: alias.id },
        });
        if (count === 0) continue;
        rowsResolved += 1;
        signalsMoved += await moveWaitingSignals(tx, row.id, alias.locationId, now);
      }
      return { created, alreadyThere: plan.aliases.length - created, rowsResolved, signalsMoved };
    },
    { timeout: 60_000 },
  );
}
