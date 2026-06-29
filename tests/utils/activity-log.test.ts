/**
 * Unit tests for `logActivity` in `src/utils/activity-log.ts`.
 *
 * DB-free: `prisma` is injected as a parameter, so each test passes a stub
 * with a `vi.fn()` `activityLogs.create` delegate — no real client, no DB.
 *
 * The load-bearing contract is the "hard rule" in the source: this helper
 * MUST NEVER throw. A logging failure (rejecting delegate, or even a missing
 * `activityLogs` delegate) must be swallowed so the calling mutation survives.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { logActivity } from "../../src/utils/activity-log.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type { LogActivityOptions } from "../../src/utils/activity-log.js";

/**
 * Builds a prisma stub exposing only the `activityLogs.create` delegate that
 * `logActivity` touches. The delegate behaviour is supplied per-test.
 */
function buildPrisma(create: ReturnType<typeof vi.fn>): PrismaClient {
  return { activityLogs: { create } } as unknown as PrismaClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logActivity — happy path", () => {
  it("calls activityLogs.create with the full mapped shape", async () => {
    const create = vi.fn().mockResolvedValue({ id: "log1" });
    const opts: LogActivityOptions = {
      userId: "u1",
      action: "signal.create_manual",
      resourceType: "signal",
      resourceId: "sig-42",
      metadata: { title: "Flooding", severity: "high" },
      ipAddress: "10.0.0.1",
      userAgent: "vitest/1.0",
    };

    await logActivity(buildPrisma(create), opts);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "u1",
        action: "signal.create_manual",
        resourceType: "signal",
        resourceId: "sig-42",
        metadata: { title: "Flooding", severity: "high" },
        ipAddress: "10.0.0.1",
        userAgent: "vitest/1.0",
      },
    });
  });

  it("resolves to undefined (void) on success", async () => {
    const create = vi.fn().mockResolvedValue({ id: "log1" });
    await expect(
      logActivity(buildPrisma(create), {
        userId: "u1",
        action: "auth.login",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("logActivity — input shaping / defaulting", () => {
  it("defaults optional resourceType/resourceId/ip/userAgent to null", async () => {
    const create = vi.fn().mockResolvedValue({});
    await logActivity(buildPrisma(create), {
      userId: "u2",
      action: "auth.login",
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "u2",
        action: "auth.login",
        resourceType: null,
        resourceId: null,
        // metadata omitted -> undefined (so Prisma leaves the column alone)
        metadata: undefined,
        ipAddress: null,
        userAgent: null,
      },
    });
  });

  it("passes metadata through as-is when provided", async () => {
    const create = vi.fn().mockResolvedValue({});
    const metadata = { nested: { a: 1 }, list: [1, 2, 3] };
    await logActivity(buildPrisma(create), {
      userId: "u3",
      action: "crisis.create",
      metadata,
    });

    expect(create.mock.calls[0][0].data.metadata).toEqual(metadata);
  });

  it("sends metadata: undefined (not null) when metadata is omitted", async () => {
    const create = vi.fn().mockResolvedValue({});
    await logActivity(buildPrisma(create), {
      userId: "u4",
      action: "event.create",
    });

    const data = create.mock.calls[0][0].data;
    expect(data.metadata).toBeUndefined();
    expect("metadata" in data).toBe(true);
  });

  it("preserves an explicitly-null ipAddress/userAgent (coalesces to null)", async () => {
    const create = vi.fn().mockResolvedValue({});
    await logActivity(buildPrisma(create), {
      userId: "u5",
      action: "auth.logout",
      ipAddress: null,
      userAgent: null,
    });

    const data = create.mock.calls[0][0].data;
    expect(data.ipAddress).toBeNull();
    expect(data.userAgent).toBeNull();
  });
});

describe("logActivity — error swallowing (the hard rule)", () => {
  it("does NOT reject when the create delegate rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn().mockRejectedValue(new Error("db down"));

    await expect(
      logActivity(buildPrisma(create), {
        userId: "u1",
        action: "alert.create",
      }),
    ).resolves.toBeUndefined();

    // It logs the failure rather than throwing.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("alert.create");
    expect(errorSpy.mock.calls[0][0]).toContain("u1");
  });

  it("does NOT reject when activityLogs is undefined on the client", async () => {
    // Reproduces the observed failure mode: prisma.activityLogs === undefined
    // (e.g. stale generated client). The TypeError must be swallowed.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prisma = {} as unknown as PrismaClient;

    await expect(
      logActivity(prisma, {
        userId: "u9",
        action: "feedback.create",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT reject when the create delegate throws synchronously", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn().mockImplementation(() => {
      throw new Error("sync boom");
    });

    await expect(
      logActivity(buildPrisma(create), {
        userId: "u1",
        action: "dev_user.provisioned",
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not log to console.error on the success path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn().mockResolvedValue({});

    await logActivity(buildPrisma(create), {
      userId: "u1",
      action: "auth.login",
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
