import type { Context } from "../context.js";
import { isPipelineRole } from "./auth-guard.js";

/**
 * Person or pipeline (ADR-0024): the one answer every call site uses.
 *
 * The pipeline is clear-pipeline's service user, role `pipeline` (#430). A
 * request the CLEAR Agent makes for a user carries the user's session, so it
 * is the user's.
 *
 * Until dev and prod both run the pipeline on that user's key, an API key is
 * also treated as the pipeline: the drain still calls with an `admin` key, and
 * without this fallback its writes would count as a person's decisions.
 * Remove the fallback once the admin keys are revoked (#430, Phase D).
 */
export function isPipelineCaller(
  context: Pick<Context, "authMethod"> & { user?: Context["user"] | null },
): boolean {
  return isPipelineRole(context.user) || context.authMethod === "api-key";
}
