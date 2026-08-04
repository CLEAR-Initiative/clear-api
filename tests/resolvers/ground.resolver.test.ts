/**
 * Unit tests for the PIPELINE CONTRACT surface of `ground.resolver.ts`:
 * groundMessagesForClassification, upsertGroundMessageClassifications,
 * and upsertGroundThreads — the read/write API the clear-pipeline
 * classify_ground_messages worker is being built against (expo-364).
 *
 * DB-FREE: `context.prisma` is a per-test stub exposing only the
 * delegates each resolver calls. Modules that reach outside (S3 presign,
 * the signal resolver pulled in for promotion) are vi.mock()ed before the
 * resolver import. Fixtures synthetic.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "../../src/context.js";

vi.mock("../../src/services/s3.js", () => ({
  getPresignedUrls: vi.fn(async () => []),
  uploadBufferToS3: vi.fn(),
}));

vi.mock("../../src/resolvers/signal.resolver.js", () => ({
  signalResolvers: { Mutation: { createSignal: vi.fn() } },
}));

import { groundResolvers } from "../../src/resolvers/ground.resolver.js";

type User = { id: string; role: string } | null;

function buildContext(user: User, prisma: Record<string, unknown> = {}): Context {
  return {
    prisma: prisma as Context["prisma"],
    user: user as Context["user"],
    session: null,
    authMethod: user ? "session" : null,
  } as Context;
}

const PIPELINE: User = { id: "machine", role: "pipeline" };
const ADMIN: User = { id: "admin1", role: "admin" };
const ANALYST: User = { id: "a1", role: "analyst" };

const { groundMessagesForClassification, groundThreadsForSource } =
  groundResolvers.Query;
const { upsertGroundMessageClassifications, upsertGroundThreads } =
  groundResolvers.Mutation;

// ---------------------------------------------------------------------------
// Auth gate — pipeline surface is admin/pipeline only (NOT analyst).
// ---------------------------------------------------------------------------

describe("pipeline-contract auth gate", () => {
  const cases: Array<{ name: string; run: (ctx: Context) => unknown }> = [
    {
      name: "groundMessagesForClassification",
      run: (ctx) => groundMessagesForClassification(null, { groundSourceId: "gs_1" }, ctx),
    },
    {
      name: "upsertGroundMessageClassifications",
      run: (ctx) =>
        upsertGroundMessageClassifications(
          null,
          { inputs: [{ messageId: "m1", classification: "chatter" }] },
          ctx,
        ),
    },
    {
      name: "groundThreadsForSource",
      run: (ctx) => groundThreadsForSource(null, { groundSourceId: "gs_1" }, ctx),
    },
    {
      name: "upsertGroundThreads",
      run: (ctx) =>
        upsertGroundThreads(
          null,
          {
            inputs: [
              {
                groundSourceId: "gs_1",
                title: "t",
                lifecycleState: "reported",
                messageIds: ["m1"],
              },
            ],
          },
          ctx,
        ),
    },
  ];

  for (const { name, run } of cases) {
    it(`${name} rejects an analyst with FORBIDDEN`, async () => {
      await expect(run(buildContext(ANALYST))).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
    });

    it(`${name} rejects an unauthenticated caller`, async () => {
      await expect(run(buildContext(null))).rejects.toMatchObject({
        extensions: { code: "UNAUTHENTICATED" },
      });
    });
  }
});

// ---------------------------------------------------------------------------
// groundMessagesForClassification
// ---------------------------------------------------------------------------

describe("groundMessagesForClassification", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "m1",
    text: "synthetic text",
    sentAt: new Date("2026-08-04T10:00:00Z"),
    senderRef: "s_abc123def456",
    senderName: "PRIVATE NAME — must not leak",
    mediaKeys: [] as string[],
    mediaRefs: [] as string[],
    omittedMediaCount: 0,
    classification: null,
    threadId: "t1",
    ...overrides,
  });

  function prismaWithRows(rows: unknown[], findMany = vi.fn(async () => rows)) {
    return { prisma: { groundMessages: { findMany } }, findMany };
  }

  it("projects the contract fields and never the sender name", async () => {
    const { prisma } = prismaWithRows([row()]);
    const result = await groundMessagesForClassification(
      null,
      { groundSourceId: "gs_1" },
      buildContext(PIPELINE, prisma),
    );

    expect(result).toEqual([
      {
        id: "m1",
        text: "synthetic text",
        sentAt: new Date("2026-08-04T10:00:00Z"),
        senderRef: "s_abc123def456",
        hasMedia: false,
        classification: null,
        threadId: "t1",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE NAME");
  });

  it.each([
    ["stored media", { mediaKeys: ["ground/gs_1/x.jpg"] }],
    ["export-referenced media", { mediaRefs: ["IMG-1.jpg"] }],
    ["omitted media", { omittedMediaCount: 2 }],
  ] as const)("hasMedia is true for %s", async (_name, overrides) => {
    const { prisma } = prismaWithRows([row(overrides)]);
    const result = await groundMessagesForClassification(
      null,
      { groundSourceId: "gs_1" },
      buildContext(PIPELINE, prisma),
    );
    expect((result[0] as { hasMedia: boolean }).hasMedia).toBe(true);
  });

  it("queries oldest-first with the default limit and clamps the max", async () => {
    const { prisma, findMany } = prismaWithRows([]);
    await groundMessagesForClassification(
      null,
      { groundSourceId: "gs_1" },
      buildContext(ADMIN, prisma),
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { groundSourceId: "gs_1" },
      orderBy: { sentAt: "asc" },
      take: 500,
    });

    await groundMessagesForClassification(
      null,
      { groundSourceId: "gs_1", limit: 99999 },
      buildContext(ADMIN, prisma),
    );
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 2000 }),
    );
  });
});

// ---------------------------------------------------------------------------
// groundThreadsForSource
// ---------------------------------------------------------------------------

describe("groundThreadsForSource", () => {
  function prismaWithThreads(rows: unknown[]) {
    const findMany = vi.fn(async () => rows);
    return { prisma: { groundThreads: { findMany } }, findMany };
  }

  it("returns a source's threads oldest-first, filtered by lifecycle states", async () => {
    const thread = {
      id: "t1",
      title: "Synthetic incident",
      lifecycleState: "reported",
      reviewState: "unverified",
    };
    const { prisma, findMany } = prismaWithThreads([thread]);

    const result = await groundThreadsForSource(
      null,
      { groundSourceId: "gs_1", states: ["reported", "updated"] },
      buildContext(PIPELINE, prisma),
    );

    expect(result).toEqual([thread]);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        groundSourceId: "gs_1",
        lifecycleState: { in: ["reported", "updated"] },
      },
      orderBy: { createdAt: "asc" },
    });
  });

  it.each([
    ["omitted", undefined],
    ["null", null],
    ["empty", [] as string[]],
  ] as const)("applies no lifecycle filter when states is %s", async (_name, states) => {
    const { prisma, findMany } = prismaWithThreads([]);
    await groundThreadsForSource(
      null,
      { groundSourceId: "gs_1", states },
      buildContext(ADMIN, prisma),
    );
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { groundSourceId: "gs_1" },
      orderBy: { createdAt: "asc" },
    });
  });
});

// ---------------------------------------------------------------------------
// GroundThread field resolvers — the pipeline-facing projection
// ---------------------------------------------------------------------------

describe("GroundThread relation resolvers", () => {
  const messageRows = [
    { id: "m1", senderName: "PRIVATE NAME", senderRef: "s_1" },
    { id: "m2", senderName: null, senderRef: "s_2" },
  ];

  function prismaWithMessages() {
    const findMany = vi.fn(async () => messageRows);
    return { prisma: { groundMessages: { findMany } }, findMany };
  }

  it("messageIds returns the thread's message ids oldest-first, without content", async () => {
    const findMany = vi.fn(async () => [{ id: "m1" }, { id: "m2" }]);
    const result = await groundResolvers.GroundThread.messageIds(
      { id: "t1" },
      null,
      buildContext(PIPELINE, { groundMessages: { findMany } }),
    );
    expect(result).toEqual(["m1", "m2"]);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { threadId: "t1" },
      orderBy: { sentAt: "asc" },
      select: { id: true },
    });
  });

  it("messages scrubs senderName for a pipeline-role caller", async () => {
    const { prisma } = prismaWithMessages();
    const result = await groundResolvers.GroundThread.messages(
      { id: "t1" },
      null,
      buildContext(PIPELINE, prisma),
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE NAME");
    expect(result).toEqual([
      { id: "m1", senderName: null, senderRef: "s_1" },
      { id: "m2", senderName: null, senderRef: "s_2" },
    ]);
  });

  it("messages keeps senderName for an admin (private-tier reviewer)", async () => {
    const { prisma } = prismaWithMessages();
    const result = await groundResolvers.GroundThread.messages(
      { id: "t1" },
      null,
      buildContext(ADMIN, prisma),
    );
    expect(result).toEqual(messageRows);
  });
});

// ---------------------------------------------------------------------------
// upsertGroundMessageClassifications
// ---------------------------------------------------------------------------

describe("upsertGroundMessageClassifications", () => {
  function classificationPrisma(knownIds: string[]) {
    const update = vi.fn((args: unknown) => Promise.resolve(args));
    const prisma = {
      groundMessages: {
        findMany: vi.fn(async () => knownIds.map((id) => ({ id }))),
        update,
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    return { prisma, update };
  }

  it("rejects an unknown classification label", async () => {
    const { prisma } = classificationPrisma(["m1"]);
    await expect(
      upsertGroundMessageClassifications(
        null,
        { inputs: [{ messageId: "m1", classification: "gossip" }] },
        buildContext(PIPELINE, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("updates classification and overwrites uncertainty only when provided", async () => {
    const { prisma, update } = classificationPrisma(["m1", "m2"]);
    const count = await upsertGroundMessageClassifications(
      null,
      {
        inputs: [
          { messageId: "m1", classification: "field_report", uncertaintyMarker: "rumour" },
          { messageId: "m2", classification: "chatter", uncertaintyMarker: null },
        ],
      },
      buildContext(PIPELINE, prisma),
    );

    expect(count).toBe(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { classification: "field_report", uncertainty: "rumour" },
    });
    // Null marker must NOT clobber the ingest-extracted value.
    expect(update).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { classification: "chatter" },
    });
  });

  it("skips unknown messageIds with a warning and returns the updated count", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, update } = classificationPrisma(["m1"]);

    const count = await upsertGroundMessageClassifications(
      null,
      {
        inputs: [
          { messageId: "m1", classification: "operational" },
          { messageId: "ghost", classification: "chatter" },
        ],
      },
      buildContext(PIPELINE, prisma),
    );

    expect(count).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("1 unknown messageId"));
    warnSpy.mockRestore();
  });

  it("returns 0 for an empty input list without touching the db", async () => {
    const { prisma, update } = classificationPrisma([]);
    const count = await upsertGroundMessageClassifications(
      null,
      { inputs: [] },
      buildContext(PIPELINE, prisma),
    );
    expect(count).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upsertGroundThreads
// ---------------------------------------------------------------------------

describe("upsertGroundThreads", () => {
  interface MsgRow {
    id: string;
    thread: { id: string; reviewState: string; promotedSignalId: string | null } | null;
  }

  interface ThreadRow {
    groundSourceId: string;
    reviewState: string;
    promotedSignalId: string | null;
  }

  /** Transactional stub: tx === the stub itself (callback form). */
  function threadingPrisma(
    messagesBySource: Record<string, MsgRow[]>,
    threadsById: Record<string, ThreadRow> = {},
  ) {
    let nextThread = 1;
    const created: Array<Record<string, unknown>> = [];
    const threadUpdates: Array<Record<string, unknown>> = [];
    const updateManyCalls: Array<Record<string, unknown>> = [];
    const deleteManyCalls: Array<Record<string, unknown>> = [];

    const tx = {
      groundMessages: {
        findMany: vi.fn(
          async (args: {
            where: { id: { in: string[] }; groundSourceId: string };
          }) =>
            (messagesBySource[args.where.groundSourceId] ?? []).filter((m) =>
              args.where.id.in.includes(m.id),
            ),
        ),
        updateMany: vi.fn(async (args: Record<string, unknown>) => {
          updateManyCalls.push(args);
          return { count: 0 };
        }),
      },
      groundThreads: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: `new_t${nextThread++}` };
        }),
        findUnique: vi.fn(async (args: { where: { id: string } }) => {
          const row = threadsById[args.where.id];
          return row ? { id: args.where.id, ...row } : null;
        }),
        update: vi.fn(async (args: { where: { id: string } } & Record<string, unknown>) => {
          threadUpdates.push(args);
          return { id: args.where.id };
        }),
        deleteMany: vi.fn(async (args: Record<string, unknown>) => {
          deleteManyCalls.push(args);
          return { count: 0 };
        }),
      },
    };

    const prisma = {
      ...tx,
      $transaction: vi.fn(
        async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    };
    return { prisma, created, threadUpdates, updateManyCalls, deleteManyCalls };
  }

  const placeholder = (id: string, threadId: string): MsgRow => ({
    id,
    thread: { id: threadId, reviewState: "unverified", promotedSignalId: null },
  });

  it("rejects an unknown lifecycleState", async () => {
    const { prisma } = threadingPrisma({});
    await expect(
      upsertGroundThreads(
        null,
        {
          inputs: [
            {
              groundSourceId: "gs_1",
              title: "t",
              lifecycleState: "definitely_wrong",
              messageIds: ["m1"],
            },
          ],
        },
        buildContext(PIPELINE, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("rejects empty messageIds", async () => {
    const { prisma } = threadingPrisma({});
    await expect(
      upsertGroundThreads(
        null,
        {
          inputs: [
            {
              groundSourceId: "gs_1",
              title: "t",
              lifecycleState: "reported",
              messageIds: [],
            },
          ],
        },
        buildContext(PIPELINE, prisma),
      ),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("creates a thread, re-points messages, and deletes the emptied placeholders", async () => {
    const { prisma, created, updateManyCalls, deleteManyCalls } = threadingPrisma({
      gs_1: [placeholder("m1", "old_t1"), placeholder("m2", "old_t2")],
    });

    const ids = await upsertGroundThreads(
      null,
      {
        inputs: [
          {
            groundSourceId: "gs_1",
            title: "Synthetic incident",
            lifecycleState: "corrected",
            messageIds: ["m1", "m2"],
          },
        ],
      },
      buildContext(PIPELINE, prisma),
    );

    expect(ids).toEqual(["new_t1"]);
    expect(created).toEqual([
      {
        groundSourceId: "gs_1",
        title: "Synthetic incident",
        lifecycleState: "corrected",
      },
    ]);
    expect(updateManyCalls).toEqual([
      { where: { id: { in: ["m1", "m2"] } }, data: { threadId: "new_t1" } },
    ]);
    // Placeholder deletion is guarded: only unverified, unpromoted, EMPTY.
    expect(deleteManyCalls).toEqual([
      {
        where: {
          id: { in: ["old_t1", "old_t2"] },
          reviewState: "unverified",
          promotedSignalId: null,
          messages: { none: {} },
        },
      },
    ]);
  });

  it("never re-threads a message whose thread has been human-reviewed", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, created, updateManyCalls } = threadingPrisma({
      gs_1: [
        placeholder("m1", "old_t1"),
        {
          id: "m2",
          thread: { id: "old_t2", reviewState: "approved_private", promotedSignalId: null },
        },
      ],
    });

    const ids = await upsertGroundThreads(
      null,
      {
        inputs: [
          {
            groundSourceId: "gs_1",
            title: "t",
            lifecycleState: "reported",
            messageIds: ["m1", "m2"],
          },
        ],
      },
      buildContext(PIPELINE, prisma),
    );

    expect(ids).toEqual(["new_t1"]);
    expect(created).toHaveLength(1);
    // Only the placeholder-threaded message moves.
    expect(updateManyCalls[0]).toMatchObject({ where: { id: { in: ["m1"] } } });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 of 2 message(s) not re-threaded"),
    );
    warnSpy.mockRestore();
  });

  it("returns null (and creates nothing) for an input with no movable messages", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, created } = threadingPrisma({
      gs_1: [
        {
          id: "m1",
          thread: { id: "old_t1", reviewState: "rejected", promotedSignalId: null },
        },
      ],
    });

    const ids = await upsertGroundThreads(
      null,
      {
        inputs: [
          {
            groundSourceId: "gs_1",
            title: "t",
            lifecycleState: "reported",
            messageIds: ["m1", "unknown_id"],
          },
        ],
      },
      buildContext(PIPELINE, prisma),
    );

    expect(ids).toEqual([null]);
    expect(created).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("appends to an existing unpromoted thread when threadId is set", async () => {
    const { prisma, created, threadUpdates, updateManyCalls, deleteManyCalls } =
      threadingPrisma(
        {
          gs_1: [
            // A message the target thread already owns (re-sent by the
            // worker's clustering) — must not mark the target vacated…
            {
              id: "m1",
              thread: {
                id: "t_target",
                reviewState: "unverified",
                promotedSignalId: null,
              },
            },
            // …plus a late correction sitting in its own placeholder thread.
            placeholder("m3", "old_t3"),
          ],
        },
        {
          t_target: {
            groundSourceId: "gs_1",
            reviewState: "unverified",
            promotedSignalId: null,
          },
        },
      );

    const ids = await upsertGroundThreads(
      null,
      {
        inputs: [
          {
            groundSourceId: "gs_1",
            title: "Synthetic incident (corrected)",
            lifecycleState: "corrected",
            messageIds: ["m1", "m3"],
            threadId: "t_target",
          },
        ],
      },
      buildContext(PIPELINE, prisma),
    );

    expect(ids).toEqual(["t_target"]);
    // Appended, not created.
    expect(created).toHaveLength(0);
    expect(threadUpdates).toEqual([
      {
        where: { id: "t_target" },
        data: { title: "Synthetic incident (corrected)", lifecycleState: "corrected" },
        select: { id: true },
      },
    ]);
    expect(updateManyCalls).toEqual([
      { where: { id: { in: ["m1", "m3"] } }, data: { threadId: "t_target" } },
    ]);
    // Only the vacated placeholder is a deletion candidate — never the
    // append target itself.
    expect(deleteManyCalls).toEqual([
      {
        where: {
          id: { in: ["old_t3"] },
          reviewState: "unverified",
          promotedSignalId: null,
          messages: { none: {} },
        },
      },
    ]);
  });

  it.each([
    [
      "promoted (approved_public)",
      {
        t_target: {
          groundSourceId: "gs_1",
          reviewState: "approved_public",
          promotedSignalId: null,
        },
      },
    ],
    [
      "promoted (promotedSignalId set)",
      {
        t_target: {
          groundSourceId: "gs_1",
          reviewState: "approved_private",
          promotedSignalId: "sig_1",
        },
      },
    ],
    [
      "from another source",
      {
        t_target: {
          groundSourceId: "gs_OTHER",
          reviewState: "unverified",
          promotedSignalId: null,
        },
      },
    ],
    ["unknown", {}],
  ] as const)(
    "never mutates a %s threadId target — creates a new thread and warns",
    async (_name, threadsById) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { prisma, created, threadUpdates } = threadingPrisma(
        { gs_1: [placeholder("m1", "old_t1")] },
        threadsById,
      );

      const ids = await upsertGroundThreads(
        null,
        {
          inputs: [
            {
              groundSourceId: "gs_1",
              title: "t",
              lifecycleState: "retracted",
              messageIds: ["m1"],
              threadId: "t_target",
            },
          ],
        },
        buildContext(PIPELINE, prisma),
      );

      expect(ids).toEqual(["new_t1"]);
      expect(created).toHaveLength(1);
      expect(threadUpdates).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("creating a new thread instead"),
      );
      warnSpy.mockRestore();
    },
  );

  it("handles multiple inputs in order", async () => {
    const { prisma } = threadingPrisma({
      gs_1: [placeholder("m1", "old_t1")],
      gs_2: [placeholder("m9", "old_t9")],
    });

    const ids = await upsertGroundThreads(
      null,
      {
        inputs: [
          {
            groundSourceId: "gs_1",
            title: "first",
            lifecycleState: "reported",
            messageIds: ["m1"],
          },
          {
            groundSourceId: "gs_2",
            title: "second",
            lifecycleState: "retracted",
            messageIds: ["m9"],
          },
        ],
      },
      buildContext(ADMIN, prisma),
    );

    expect(ids).toEqual(["new_t1", "new_t2"]);
  });
});
