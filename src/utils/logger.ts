/**
 * Centralised logger — Pino + Better Stack (Logtail) transport.
 *
 * In production, logs are shipped to Better Stack via the @logtail/pino transport.
 * In development, logs are pretty-printed to stdout.
 *
 * Env vars:
 *   LOGTAIL_SOURCE_TOKEN  — Better Stack source token (required for prod logging)
 *   LOG_LEVEL             — pino log level (default: "info")
 *   LOG_FORMAT            — "json" | "pretty". Default: pretty only on an
 *                           interactive terminal outside production, JSON
 *                           otherwise (containers, CI) so Vector can parse it.
 */

import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

/** Pretty output is for humans at a terminal; everything else logs JSON. */
export function usePrettyLogs(
  env: { LOG_FORMAT?: string; NODE_ENV?: string },
  isTTY: boolean,
): boolean {
  if (env.LOG_FORMAT) return env.LOG_FORMAT === "pretty";
  return env.NODE_ENV !== "production" && isTTY;
}

function buildTransports(): pino.TransportMultiOptions | undefined {
  const targets: pino.TransportTargetOptions[] = [];

  if (usePrettyLogs(process.env, Boolean(process.stdout.isTTY))) {
    targets.push({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
      level,
    });
  } else {
    targets.push({
      target: "pino/file",
      options: { destination: 1 },
      level,
    });
  }

  if (process.env.LOGTAIL_SOURCE_TOKEN) {
    targets.push({
      target: "@logtail/pino",
      options: { sourceToken: process.env.LOGTAIL_SOURCE_TOKEN },
      level,
    });
  }

  return { targets };
}

export const logger = pino({
  level,
  transport: buildTransports(),
});

export const createLogger = (module: string) => logger.child({ module });
