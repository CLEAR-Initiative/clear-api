/**
 * Append-only analytics / audit logger.
 *
 * Writes one row to `activity_logs` per meaningful user-initiated action
 * — logins, manual signal / event / alert / crisis / feedback creation,
 * etc. The admin dashboard reads it via the GraphQL `activityLogs` query.
 *
 * Hard rule: this helper MUST NEVER throw. Logging is observability, not
 * correctness — a failure here can't be allowed to break the user-facing
 * action that prompted it. Every code path goes through the try/catch
 * with a console.error fallback.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";

/**
 * Canonical action identifiers. New identifiers should follow
 * `<resource>.<verb>[_<qualifier>]` so the dashboard can filter by
 * resource prefix. Keep this union exhaustive — adding a new value here
 * forces every call site to compile against it.
 */
export type ActivityAction =
  | "auth.login"
  | "auth.logout"
  | "signal.create_manual"
  | "event.create"
  | "alert.create"
  | "crisis.create"
  | "feedback.create"
  | "dev_user.provisioned"
  | "dev_user.api_key_rotated"
  | "user.approved"
  | "user.role_updated";

/**
 * Coarse resource bucket. Redundant with `action` but cheap to filter
 * on in the dashboard ("all crisis activity for user X").
 */
export type ActivityResourceType =
  | "signal"
  | "event"
  | "alert"
  | "crisis"
  | "feedback"
  | "session"
  | "user";

export interface LogActivityOptions {
  /** Required. The user the action is attributed to. */
  userId: string;
  action: ActivityAction;
  resourceType?: ActivityResourceType;
  /** The id of the created/affected row. Null for things like login. */
  resourceId?: string;
  /** Free-form per-action context (title, severity, source name, …). */
  metadata?: Record<string, unknown>;
  /** Captured from request headers when available. */
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Best-effort append to `activity_logs`. Returns a void promise that
 * always resolves — failures are caught and logged to stderr.
 *
 * Most resolvers will want to fire-and-forget:
 *
 *   void logActivity(prisma, { userId, action: "signal.create_manual", ... });
 *
 * For login hooks that need ip/userAgent, pass them explicitly — the
 * helper has no way to read request headers on its own.
 */
export async function logActivity(
  prisma: PrismaClient,
  opts: LogActivityOptions,
): Promise<void> {
  try {
    await prisma.activityLogs.create({
      data: {
        userId: opts.userId,
        action: opts.action,
        resourceType: opts.resourceType ?? null,
        resourceId: opts.resourceId ?? null,
        metadata: opts.metadata
          ? (opts.metadata as InputJsonValue)
          : undefined,
        ipAddress: opts.ipAddress ?? null,
        userAgent: opts.userAgent ?? null,
      },
    });
  } catch (err) {
    // Never propagate — analytics failure must not break the action.
    console.error(
      `[activity-log] failed to record ${opts.action} for user=${opts.userId}:`,
      err,
    );
  }
}
