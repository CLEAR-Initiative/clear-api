/**
 * Centralised logger — Pino + Better Stack (Logtail) transport.
 *
 * In production, logs are shipped to Better Stack via the @logtail/pino transport.
 * In development, logs are pretty-printed to stdout.
 *
 * Env vars:
 *   LOGTAIL_SOURCE_TOKEN  — Better Stack source token (required for prod logging)
 *   LOG_LEVEL             — pino log level (default: "info")
 */

import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? "info";

function buildTransports(): pino.TransportMultiOptions | undefined {
  const targets: pino.TransportTargetOptions[] = [];

  if (isProduction) {
    targets.push({
      target: "pino/file",
      options: { destination: 1 },
      level,
    });
  } else {
    targets.push({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
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
