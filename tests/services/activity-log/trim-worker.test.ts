import { describe, it, expect, vi } from "vitest";
import { trimActivityLogPii } from "../../../src/services/activity-log/trim-worker.js";
import type { PrismaClient } from "../../../src/generated/prisma/client.js";

describe("trimActivityLogPii", () => {
  it("clears ip and user agent on rows older than 90 days", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 7 });
    const prisma = { activityLogs: { updateMany } } as unknown as PrismaClient;
    const now = new Date("2026-10-29T00:00:00.000Z");

    const n = await trimActivityLogPii(prisma, now);

    expect(n).toBe(7);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where.createdAt.lt.toISOString()).toBe("2026-07-31T00:00:00.000Z");
    expect(arg.where.OR).toEqual([
      { ipAddress: { not: null } },
      { userAgent: { not: null } },
    ]);
    expect(arg.data).toEqual({ ipAddress: null, userAgent: null });
  });
});
