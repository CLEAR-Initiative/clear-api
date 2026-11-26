import type { Context } from "../context.js";

/**
 * Person or pipeline (ADR-0024): the one answer every call site uses.
 *
 * A session is a person; an API key is the pipeline. A request the CLEAR
 * Agent makes for a user carries the user's session, so it is the user's.
 *
 * V1 decides by credential. The drain calls some mutations with an `admin`
 * API key, so the `pipeline` role is not a reliable test yet; #430 gives the
 * pipeline its own identity and changes only this body.
 */
export function isPipelineCaller(context: Pick<Context, "authMethod">): boolean {
  return context.authMethod === "api-key";
}
