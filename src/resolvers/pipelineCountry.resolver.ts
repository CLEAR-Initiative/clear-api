import type { Context } from "../context.js";
import { requireAuth } from "../utils/auth-guard.js";

/**
 * The countries the CLEAR pipeline publishes a Situation Analysis for, with the
 * level-0 bounding box used to create the Country location. Interim hardcoded
 * config — the source of truth so the scheduled publisher selects countries
 * from clear-api instead of a list baked into the pipeline. Back this with
 * real config/DB when the set grows beyond a hand-maintained list.
 *
 * bbox order matches ensureCountryLocation: [minLng, minLat, maxLng, maxLat].
 */
const PIPELINE_COUNTRIES: ReadonlyArray<{
  name: string;
  iso3: string;
  // Admin-0 pcode (ISO-2). The name-independent key the pipeline resolves the
  // country's level-0 location by — the backfilled name is often the long
  // official form ("Venezuela (Bolivarian Republic of)") that exact-name misses.
  pcode: string;
  bbox: number[];
}> = [
  { name: "Sudan", iso3: "SDN", pcode: "SD", bbox: [21.8, 8.5, 38.6, 22.0] },
  { name: "Afghanistan", iso3: "AFG", pcode: "AF", bbox: [60.5, 29.4, 74.9, 38.5] },
  { name: "Venezuela", iso3: "VEN", pcode: "VE", bbox: [-73.4, 0.6, -59.8, 12.3] },
];

/**
 * Resolve a user-supplied country code to the canonical lowercase iso3 the KB
 * pipeline uses as its Dagster partition key, or `null` when it isn't one of the
 * pipeline countries. Case-insensitive; accepts the iso3 (e.g. "SDN"/"sdn").
 * Used by `uploadKnowledgebaseDocument` to validate the target partition before
 * launching `kb_downstream_job`, so an upload can never target a non-existent
 * country partition.
 */
export function resolvePipelineIso3(code: string | null | undefined): string | null {
  if (!code) return null;
  const want = code.trim().toUpperCase();
  const hit = PIPELINE_COUNTRIES.find((c) => c.iso3 === want);
  return hit ? hit.iso3.toLowerCase() : null;
}

/**
 * Resolve a level-0 location's admin-0 pcode (ISO-2, e.g. "SD") to the canonical
 * lowercase iso3 partition key, or `null` when it isn't a pipeline country.
 * Case-insensitive. The pcode is the name-independent key the pipeline resolves
 * countries by (the backfilled location name is often the long official form),
 * so this is the robust way to map a frame's country location to its partition.
 */
export function resolvePipelineIso3ByPcode(pcode: string | null | undefined): string | null {
  if (!pcode) return null;
  const want = pcode.trim().toUpperCase();
  const hit = PIPELINE_COUNTRIES.find((c) => c.pcode.toUpperCase() === want);
  return hit ? hit.iso3.toLowerCase() : null;
}

/**
 * The name of the pipeline country with this admin-0 pcode (ISO-2, e.g. "SD"),
 * or null. `ensureCountryLocation` creates a country's level-0 location under
 * this name and with no pcode, so the name is how such a location is matched
 * to its ISO code.
 */
export function pipelineCountryNameByPcode(pcode: string | null | undefined): string | null {
  if (!pcode) return null;
  const want = pcode.trim().toUpperCase();
  return PIPELINE_COUNTRIES.find((c) => c.pcode.toUpperCase() === want)?.name ?? null;
}

export const pipelineCountryResolvers = {
  Query: {
    pipelineCountries: (_parent: unknown, _args: unknown, context: Context) => {
      requireAuth(context);
      // Return copies so a resolver consumer can't mutate the shared config.
      return PIPELINE_COUNTRIES.map((c) => ({
        name: c.name,
        iso3: c.iso3,
        pcode: c.pcode,
        bbox: [...c.bbox],
      }));
    },
  },
};
