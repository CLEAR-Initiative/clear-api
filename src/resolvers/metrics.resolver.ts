import type { Context } from "../context.js";
import { requireRole } from "../utils/auth-guard.js";
import { computeDetectionMetrics, type DetectionMetricsInput } from "../services/detection-metrics.js";
import {
  computeLocationPrecisionMetrics,
  type LocationPrecisionMetricsInput,
} from "../services/location-precision-metrics.js";

/** Platform metrics for the admin /metrics page in clear-mvp. Admin only. */
export const metricsResolvers = {
  Query: {
    detectionMetrics: async (
      _parent: unknown,
      args: { input?: DetectionMetricsInput | null },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return computeDetectionMetrics(context.prisma, args.input ?? {});
    },
    locationPrecisionMetrics: async (
      _parent: unknown,
      args: { input?: LocationPrecisionMetricsInput | null },
      context: Context,
    ) => {
      requireRole(context, ["admin"]);
      return computeLocationPrecisionMetrics(context.prisma, args.input ?? {});
    },
  },
};
