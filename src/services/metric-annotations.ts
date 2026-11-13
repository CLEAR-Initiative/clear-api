/**
 * Metric annotations (ADR-0016): the changes that should move a metric,
 * drawn as markers on the admin /metrics charts. Each row names an instant,
 * a label and the registry keys (ADR-0015) it bears on. Rows are per
 * environment, because a deploy reaches dev and prod at different instants.
 * Admin only; writes are activity-logged by the resolver.
 */

import { GraphQLError } from "graphql";
import type { PrismaClient } from "../generated/prisma/client.js";
import { METRIC_KEYS, type MetricKey } from "./metric-registry.js";

export const MAX_LABEL_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_LINK_LENGTH = 500;

export interface MetricAnnotation {
  id: string;
  at: Date;
  label: string;
  description: string | null;
  link: string | null;
  metricKeys: string[];
  createdById: string;
  createdAt: Date;
}

export interface MetricAnnotationsFilter {
  from?: Date | string | null;
  to?: Date | string | null;
  /** Only annotations tagged with this registry key. */
  metric?: MetricKey | string | null;
}

export interface MetricAnnotationInput {
  at: Date | string;
  label: string;
  description?: string | null;
  link?: string | null;
  metricKeys: readonly string[];
}

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });

/** An absolute http(s) URL with a host, as the URL parser reads it; a bare scheme or `https://?` is not one. */
export function isHttpUrl(value: string): boolean {
  if (value.length > MAX_LINK_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Prisma's "record to delete does not exist", whichever client class raised it. */
const isRecordNotFound = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2025";

function toDate(value: Date | string, name: string): Date {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) throw badInput(`\`${name}\` must be a valid date-time, e.g. 2026-10-29T18:33:00Z.`);
  return at;
}

/** The input as the row will store it, or BAD_USER_INPUT naming the first problem. */
export function validateAnnotation(input: MetricAnnotationInput): {
  at: Date;
  label: string;
  description: string | null;
  link: string | null;
  metricKeys: MetricKey[];
} {
  const at = toDate(input.at, "at");
  const label = (input.label ?? "").trim();
  if (!label) throw badInput("`label` must not be empty.");
  if (label.length > MAX_LABEL_LENGTH) throw badInput(`\`label\` must be at most ${MAX_LABEL_LENGTH} characters.`);
  const description = input.description?.trim() || null;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw badInput(`\`description\` must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  const link = input.link?.trim() || null;
  if (link && !isHttpUrl(link)) throw badInput("`link` must be an http(s) URL.");
  const metricKeys = [...new Set((input.metricKeys ?? []).map((key) => key.trim()).filter(Boolean))];
  if (metricKeys.length === 0) throw badInput("`metricKeys` must name at least one metric.");
  const unknown = metricKeys.filter((key) => !(METRIC_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw badInput(`Unknown metric key: ${unknown.join(", ")}. Use one of ${METRIC_KEYS.join(", ")}.`);
  return { at, label, description, link, metricKeys: metricKeys as MetricKey[] };
}

/** The annotations in range, oldest first, optionally only those tagged with one metric. */
export async function listMetricAnnotations(prisma: PrismaClient, filter: MetricAnnotationsFilter = {}): Promise<MetricAnnotation[]> {
  const from = filter.from != null ? toDate(filter.from, "from") : null;
  const to = filter.to != null ? toDate(filter.to, "to") : null;
  if (from && to && from > to) throw badInput("`from` must be on or before `to`.");
  const metric = filter.metric?.trim() || null;
  return prisma.metricAnnotations.findMany({
    where: {
      ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(metric ? { metricKeys: { has: metric } } : {}),
    },
    orderBy: [{ at: "asc" }, { createdAt: "asc" }],
  });
}

/** Store a validated annotation for `createdById`. */
export async function createMetricAnnotation(prisma: PrismaClient, input: MetricAnnotationInput, createdById: string): Promise<MetricAnnotation> {
  const data = validateAnnotation(input);
  return prisma.metricAnnotations.create({ data: { ...data, createdById } });
}

/**
 * Remove an annotation and return it; NOT_FOUND when there is none with that
 * id. One statement, so two requests racing to delete the same row get one
 * success and one NOT_FOUND rather than two successes or a bare Prisma error.
 */
export async function deleteMetricAnnotation(prisma: PrismaClient, id: string): Promise<MetricAnnotation> {
  try {
    return await prisma.metricAnnotations.delete({ where: { id } });
  } catch (err) {
    if (isRecordNotFound(err)) throw new GraphQLError("Metric annotation not found", { extensions: { code: "NOT_FOUND" } });
    throw err;
  }
}
