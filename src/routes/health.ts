/**
 * Health endpoints.
 *
 * Two probes with deliberately different semantics:
 *
 * - `GET /health` — **liveness**. Answers 200 `{status:"ok"}` whenever the
 *   process is up and the event loop is serving. It checks NOTHING else, on
 *   purpose: the compose healthcheck in clear-infra (`envs/<env>/main.tf`,
 *   `clear-api.healthcheck`) hits this path and marks the container
 *   unhealthy on any non-2xx. If this probe tracked the database, a DB
 *   outage would restart-loop the API without fixing anything, and the
 *   restarts would hide which component is actually down.
 *
 * - `GET /health/ready` — **readiness**. Runs `SELECT 1` through Prisma with
 *   a short timeout and answers 200 `{status:"ok", db:"ok"}` or 503
 *   `{status:"degraded", db:"unreachable", error}`. This is what uptime
 *   monitors and the clear-mcp worker should poll: on 2026-10-24 the dev
 *   Postgres host went unresponsive for ~24h while `/health` stayed green,
 *   so every DB-backed query stalled on the pg-pool connect timeout and the
 *   outage was misreported as "clear-api is unreachable".
 *
 * The readiness timeout is shorter than the pool's `connectionTimeoutMillis`
 * (10s in `lib/prisma.ts`) so a dead DB host surfaces as a fast 503 rather
 * than a slow one that a monitor's own timeout may clip first.
 */

import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";

export const READINESS_TIMEOUT_MS = 2_000;

export class ReadinessTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`database probe timed out after ${timeoutMs}ms`);
    this.name = "ReadinessTimeoutError";
  }
}

/** Minimal slice of the Prisma client the probe needs; keeps tests hermetic. */
export type ProbeClient = {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

/**
 * Resolve when the DB answers `SELECT 1`, reject when it errors or stays
 * silent past `timeoutMs`. The pending query is NOT cancelled on timeout
 * (pg can't abort a connect in flight); it settles on its own later and is
 * ignored — the timer is cleared on either path so no handle leaks.
 */
export async function checkDatabase(
  client: ProbeClient,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReadinessTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    await Promise.race([client.$queryRaw`SELECT 1`, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const URL_WITH_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * Turn a probe failure into a message safe to return to an anonymous caller.
 * Driver errors can embed the connection string (host, user, password), so
 * the literal `DATABASE_URL` value and any URL-shaped token are redacted.
 */
export function sanitizeProbeError(err: unknown, databaseUrl: string | undefined): string {
  let message = err instanceof Error ? err.message : String(err);
  if (databaseUrl && databaseUrl.length > 0) {
    message = message.split(databaseUrl).join("[redacted]");
  }
  message = message.replace(URL_WITH_CREDENTIALS, "[redacted]");
  // Keep the body small; driver stack-ish messages can run long.
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export function createHealthRouter(client: ProbeClient = prisma): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/ready", async (_req: Request, res: Response) => {
    try {
      await checkDatabase(client);
      res.status(200).json({ status: "ok", db: "ok" });
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        db: "unreachable",
        error: sanitizeProbeError(err, process.env.DATABASE_URL),
      });
    }
  });

  return router;
}

export const healthRouter = createHealthRouter();
