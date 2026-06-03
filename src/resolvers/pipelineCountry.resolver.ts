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
const PIPELINE_COUNTRIES: ReadonlyArray<{ name: string; bbox: number[] }> = [
  { name: "Sudan", bbox: [21.8, 8.5, 38.6, 22.0] },
  { name: "Afghanistan", bbox: [60.5, 29.4, 74.9, 38.5] },
];

export const pipelineCountryResolvers = {
  Query: {
    pipelineCountries: (_parent: unknown, _args: unknown, context: Context) => {
      requireAuth(context);
      // Return copies so a resolver consumer can't mutate the shared config.
      return PIPELINE_COUNTRIES.map((c) => ({ name: c.name, bbox: [...c.bbox] }));
    },
  },
};
