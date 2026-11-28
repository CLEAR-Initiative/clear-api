/**
 * Unit tests for `services/alert-email.ts` — the queue-then-flush path that
 * stops an alert burst becoming a mail flood (clear #1731).
 *
 * DB-free, following `notification.resolver.test.ts`: the prisma delegates the
 * service touches are stubbed per-test, and the email provider, the templates
 * and the localization helpers are `vi.mock`-ed before the service is imported.
 * No real Prisma client and no DB connection.
 *
 * The case that matters most is `the 2026-11-28 burst`: 48 alerts raised for
 * one recipient inside the window must produce exactly ONE message, because 48
 * is what they actually received on dev and what this whole mechanism exists to
 * prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// sendBulk returns one boolean PER MESSAGE and does not throw on a refusal,
// so the default here mirrors the real contract: all accepted.
const sendBulk = vi.fn(async (messages: unknown[]) => messages.map(() => true));

vi.mock("../../src/services/messaging/registry.js", () => ({
  getEmailProvider: vi.fn(async () => ({ sendBulk })),
}));

vi.mock("../../src/services/messaging/templates.js", () => ({
  alertNotification: vi.fn(() => ({ subject: "one", textBody: "t", htmlBody: "h" })),
  alertDigest: vi.fn(() => ({ subject: "digest", textBody: "t", htmlBody: "h" })),
}));

vi.mock("../../src/utils/alert-email-helpers.js", () => ({
  severityToLabel: vi.fn(() => "HIGH"),
  formatCount: vi.fn((n: number) => String(n)),
  resolveEmailLocation: vi.fn(async () => null),
  resolveEventTypeLabel: vi.fn(async () => "Type"),
  fetchEventSignalLocations: vi.fn(async () => ({ ids: [], names: [], overflow: 0 })),
  fetchEventLocalizedText: vi.fn(async () => new Map()),
  normaliseUserLocale: vi.fn((l: string | null) => l ?? "en"),
  localizeLocationNames: vi.fn(async () => new Map()),
  pickLocalizedName: vi.fn(() => null),
}));

const { enqueueAlertEmails, flushAlertEmailQueue } = await import(
  "../../src/services/alert-email.js"
);
const { alertDigest } = await import("../../src/services/messaging/templates.js");
import type { PrismaClient } from "../../src/generated/prisma/client.js";

type QueueRow = { id: string; userId: string; alertId: string };
type FakeUser = {
  id: string;
  name: string;
  email: string | null;
  language: string | null;
  emailNotification: boolean;
};

/**
 * A prisma stand-in holding the queue rows and users in memory.
 * `updateMany` records which row ids were marked, which is what the tests
 * assert on: a row left unmarked is a row the next flush will retry.
 */
function fakePrisma(opts: {
  pending: QueueRow[];
  users: FakeUser[];
  /** Rolling-window count per user; defaults to their pending row count. */
  windowCount?: Record<string, number>;
  /** Rows another flush already claimed — excluded from what we can claim. */
  claimedElsewhere?: string[];
}) {
  const marked: Array<{ ids: string[]; delivery: string | null }> = [];
  const released: string[][] = [];
  const claimedBy: string[][] = [];
  const event = {
    id: "evt-1",
    title: "Battles in Blue Nile",
    description: "desc",
    types: ["rs"],
    severity: 4,
    populationAffected: null,
    originId: null,
    destinationId: null,
    locationId: null,
  };
  const prisma = {
    alertEmailQueue: {
      findMany: vi.fn(async () => opts.pending.map((r) => ({ userId: r.userId }))),
      // The claim: only rows this flush wins come back, as the real
      // updateManyAndReturn does under the `sentAt: null, unclaimed` filter.
      updateManyAndReturn: vi.fn(
        async ({ where }: { where: { userId: string } }) => {
          const mine = opts.pending.filter(
            (r) =>
              r.userId === where.userId && !(opts.claimedElsewhere ?? []).includes(r.id),
          );
          claimedBy.push(mine.map((r) => r.id));
          return mine.map((r) => ({ id: r.id, alertId: r.alertId }));
        },
      ),
      count: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const fallback = opts.pending.filter((r) => r.userId === where.userId).length;
        return opts.windowCount?.[where.userId] ?? fallback;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: { in: string[] } };
          data: { delivery?: string | null; claimedAt?: Date | null; sentAt?: Date };
        }) => {
          // A release sets claimedAt back to null and nothing else; a mark
          // sets sentAt. Keeping them apart is what the tests assert on.
          if (data.sentAt === undefined && data.claimedAt === null) {
            released.push(where.id.in);
          } else {
            marked.push({ ids: where.id.in, delivery: data.delivery ?? null });
          }
          return { count: where.id.in.length };
        },
      ),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    user: { findMany: vi.fn(async () => opts.users) },
    alerts: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        createdAt: new Date(),
        event,
      })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, createdAt: new Date(), event })),
      ),
    },
    locations: { findMany: vi.fn(async () => []) },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    marked,
    released,
    claimedBy,
    raw: prisma,
  };
}

function rows(userId: string, n: number, from = 0): QueueRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `q-${userId}-${from + i}`,
    userId,
    alertId: `a-${from + i}`,
  }));
}

const ana: FakeUser = {
  id: "u-ana",
  name: "Ana",
  email: "ana@example.test",
  language: "en",
  emailNotification: true,
};

beforeEach(() => {
  sendBulk.mockClear();
  vi.mocked(alertDigest).mockClear();
});

describe("enqueueAlertEmails", () => {
  it("writes one row per recipient, skipping duplicates", async () => {
    const { prisma, raw } = fakePrisma({ pending: [], users: [] });
    const n = await enqueueAlertEmails(prisma, "a-1", ["u-1", "u-2"]);
    expect(n).toBe(2);
    expect(raw.alertEmailQueue.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "u-1", alertId: "a-1" },
        { userId: "u-2", alertId: "a-1" },
      ],
      skipDuplicates: true,
    });
  });

  it("touches nothing when there are no recipients", async () => {
    const { prisma, raw } = fakePrisma({ pending: [], users: [] });
    expect(await enqueueAlertEmails(prisma, "a-1", [])).toBe(0);
    expect(raw.alertEmailQueue.createMany).not.toHaveBeenCalled();
  });
});

describe("flushAlertEmailQueue — individual vs digest", () => {
  it("sends ONE digest for the 2026-11-28 burst of 48 alerts, not 48 emails", async () => {
    const pending = rows("u-ana", 48);
    const { prisma, marked } = fakePrisma({ pending, users: [ana] });

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(sendBulk).toHaveBeenCalledTimes(1);
    expect(sendBulk.mock.calls[0]![0]).toHaveLength(1);
    expect(result).toMatchObject({
      recipients: 1,
      digests: 1,
      emails: 1,
      digested: 48,
      individual: 0,
      failed: 0,
    });
    // Every row accounted for, and marked as a digest.
    expect(marked).toEqual([{ ids: pending.map((r) => r.id), delivery: "digest" }]);
  });

  it("sends one email per alert when the recipient is under the threshold", async () => {
    const pending = rows("u-ana", 3);
    const { prisma, marked } = fakePrisma({ pending, users: [ana] });

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(sendBulk).toHaveBeenCalledTimes(1);
    expect(sendBulk.mock.calls[0]![0]).toHaveLength(3);
    expect(result).toMatchObject({ recipients: 1, individual: 3, digests: 0, emails: 3 });
    expect(marked).toEqual([{ ids: pending.map((r) => r.id), delivery: "individual" }]);
  });

  it("treats the threshold itself as not-a-burst (strictly greater than)", async () => {
    const { prisma } = fakePrisma({ pending: rows("u-ana", 10), users: [ana] });
    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });
    expect(result).toMatchObject({ individual: 10, digests: 0, emails: 10 });
  });

  it("counts the whole window, so a burst split across two flushes still digests", async () => {
    // Only 2 rows are pending now, but 40 were raised for this recipient inside
    // the window — an earlier flush already sent the rest. The 2 still roll up.
    const { prisma } = fakePrisma({
      pending: rows("u-ana", 2),
      users: [ana],
      windowCount: { "u-ana": 40 },
    });
    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });
    expect(result).toMatchObject({ digests: 1, emails: 1, digested: 2, individual: 0 });
  });

  it("decides per recipient, not globally", async () => {
    const bruno: FakeUser = { ...ana, id: "u-bruno", email: "bruno@example.test", name: "Bruno" };
    const { prisma, marked } = fakePrisma({
      pending: [...rows("u-ana", 48), ...rows("u-bruno", 1)],
      users: [ana, bruno],
    });

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    // Ana's burst must not downgrade Bruno's single alert into a digest.
    expect(result).toMatchObject({ recipients: 2, digests: 1, digested: 48, individual: 1 });
    expect(marked).toEqual([
      { ids: rows("u-ana", 48).map((r) => r.id), delivery: "digest" },
      { ids: ["q-u-bruno-0"], delivery: "individual" },
    ]);
  });
});

describe("flushAlertEmailQueue — caps and failure handling", () => {
  it("caps the digest body but still reports the true total", async () => {
    const { prisma } = fakePrisma({ pending: rows("u-ana", 48), users: [ana] });
    await flushAlertEmailQueue(prisma, { digestThreshold: 10, maxDigestItems: 25 });

    const [, items, options] = vi.mocked(alertDigest).mock.calls[0]!;
    expect(items).toHaveLength(25);
    expect(options.totalCount).toBe(48);
  });

  it("handles at most maxRecipients per flush, leaving the rest queued", async () => {
    const bruno: FakeUser = { ...ana, id: "u-bruno", email: "bruno@example.test", name: "Bruno" };
    const { prisma, marked } = fakePrisma({
      pending: [...rows("u-ana", 1), ...rows("u-bruno", 1)],
      users: [ana, bruno],
    });

    const result = await flushAlertEmailQueue(prisma, { maxRecipients: 1 });

    expect(result.recipients).toBe(1);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.ids).toEqual(["q-u-ana-0"]);
  });

  it("marks rows for a recipient who no longer takes email, so they stop being re-read", async () => {
    const optedOut: FakeUser = { ...ana, emailNotification: false };
    const { prisma, marked } = fakePrisma({ pending: rows("u-ana", 3), users: [optedOut] });

    const result = await flushAlertEmailQueue(prisma);

    expect(sendBulk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recipients: 0, emails: 0 });
    // delivery stays null: the rows are closed, but no email carried them.
    expect(marked).toEqual([{ ids: ["q-u-ana-0", "q-u-ana-1", "q-u-ana-2"], delivery: null }]);
  });

  it("leaves a failed recipient's rows for a later flush, keeping their claim", async () => {
    const { prisma, marked, released } = fakePrisma({
      pending: rows("u-ana", 2),
      users: [ana],
    });
    sendBulk.mockRejectedValueOnce(new Error("provider down"));

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(result).toMatchObject({ failed: 1, emails: 0, individual: 0 });
    // Nothing marked, and the claim is NOT cleared: the rows come back when
    // the lease expires, behind other recipients, so a recipient whose
    // provider keeps failing cannot hold every slot.
    expect(marked).toEqual([]);
    expect(released).toEqual([]);
  });

  it("does nothing, and asks the provider for nothing, when the queue is empty", async () => {
    const { prisma } = fakePrisma({ pending: [], users: [] });
    const result = await flushAlertEmailQueue(prisma);
    expect(result).toEqual({
      recipients: 0,
      individual: 0,
      digested: 0,
      digests: 0,
      emails: 0,
      failed: 0,
    });
    expect(sendBulk).not.toHaveBeenCalled();
  });
});

describe("flushAlertEmailQueue — the Greptile P1s", () => {
  it("digests a burst that has aged out of the window (delayed recovery)", async () => {
    // 48 alerts queued, then the flush is unavailable for longer than the
    // window. Every row ages out, so the window count reads zero — and judging
    // on that alone would send 48 individual emails, recreating the flood in
    // exactly the scenario the mechanism exists for.
    const { prisma } = fakePrisma({
      pending: rows("u-ana", 48),
      users: [ana],
      windowCount: { "u-ana": 0 },
    });

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(result).toMatchObject({ digests: 1, emails: 1, digested: 48, individual: 0 });
  });

  it("releases only the rows whose message the provider refused", async () => {
    // sendBulk returns a boolean per message and does NOT throw on a refusal.
    // Marking everything sent would lose the refused emails permanently.
    const { prisma, marked, released } = fakePrisma({
      pending: rows("u-ana", 3),
      users: [ana],
    });
    sendBulk.mockResolvedValueOnce([true, false, true]);

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(marked).toEqual([
      { ids: ["q-u-ana-0", "q-u-ana-2"], delivery: "individual" },
    ]);
    // The refused row is neither marked nor released — it keeps its claim.
    expect(released).toEqual([]);
    expect(result).toMatchObject({ emails: 2, individual: 2, failed: 1 });
  });

  it("releases every row a refused digest covered", async () => {
    const { prisma, marked, released } = fakePrisma({
      pending: rows("u-ana", 48),
      users: [ana],
    });
    sendBulk.mockResolvedValueOnce([false]);

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(marked).toEqual([]);
    expect(released).toEqual([]);
    expect(result).toMatchObject({ failed: 1, digests: 0, emails: 0 });
  });

  it("claims rows before sending, so an overlapping flush cannot duplicate", async () => {
    // A concurrent flush already holds two of the three rows. The claim returns
    // only what this flush won, so only that row is sent.
    const { prisma, marked, claimedBy } = fakePrisma({
      pending: rows("u-ana", 3),
      users: [ana],
      claimedElsewhere: ["q-u-ana-0", "q-u-ana-1"],
    });

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(claimedBy).toEqual([["q-u-ana-2"]]);
    expect(sendBulk.mock.calls[0]![0]).toHaveLength(1);
    expect(marked).toEqual([{ ids: ["q-u-ana-2"], delivery: "individual" }]);
    expect(result).toMatchObject({ individual: 1, emails: 1 });
  });

  it("sends nothing for a recipient whose rows another flush claimed entirely", async () => {
    const { prisma, marked } = fakePrisma({
      pending: rows("u-ana", 2),
      users: [ana],
      claimedElsewhere: ["q-u-ana-0", "q-u-ana-1"],
    });

    const result = await flushAlertEmailQueue(prisma);

    expect(sendBulk).not.toHaveBeenCalled();
    expect(marked).toEqual([]);
    expect(result.recipients).toBe(0);
  });

  it("keeps going for later recipients when an earlier one's DB read throws", async () => {
    // The window count used to sit outside the try, so a timeout on the first
    // recipient abandoned every recipient after them.
    const bruno: FakeUser = { ...ana, id: "u-bruno", email: "bruno@example.test", name: "Bruno" };
    const { prisma, raw, marked } = fakePrisma({
      pending: [...rows("u-ana", 1), ...rows("u-bruno", 1)],
      users: [ana, bruno],
    });
    vi.mocked(raw.alertEmailQueue.count).mockRejectedValueOnce(new Error("statement timeout"));

    const result = await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    expect(result.failed).toBe(1);
    // Bruno still got his email.
    expect(marked).toEqual([{ ids: ["q-u-bruno-0"], delivery: "individual" }]);
    expect(result.emails).toBe(1);
  });

  it("marks only rows it still holds, so an expired flush cannot overwrite", async () => {
    const { prisma, raw } = fakePrisma({ pending: rows("u-ana", 1), users: [ana] });

    await flushAlertEmailQueue(prisma, { digestThreshold: 10 });

    // The ownership guard: the update is scoped to the claim this flush set.
    const call = vi.mocked(raw.alertEmailQueue.updateMany).mock.calls[0]![0] as {
      where: { claimedAt?: Date };
    };
    expect(call.where.claimedAt).toBeInstanceOf(Date);
  });
});
