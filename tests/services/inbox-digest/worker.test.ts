import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countWaitingInboxItems,
  digestDue,
  formatInboxDigest,
  postInboxDigest,
  startInboxDigestWorker,
  stopInboxDigestWorker,
} from "../../../src/services/inbox-digest/worker.js";
import type { PrismaClient } from "../../../src/generated/prisma/client.js";

const config = { homeserverUrl: "https://hs.example", accessToken: "tok", roomId: "!r:hs.example" };
const APP = "https://app.example/";

/** A database with two open Location challenges from people and three from
 *  the pipeline, four open place names and one proposed signal. */
function fakePrisma() {
  const groupBy = vi.fn().mockResolvedValue([
    { origin: "PERSON", _count: { _all: 2 } },
    { origin: "PIPELINE", _count: { _all: 3 } },
  ]);
  const places = vi.fn().mockResolvedValue(4);
  const proposals = vi.fn().mockResolvedValue(1);
  const prisma = {
    signalLocationChallenges: { groupBy },
    unresolvedPlaceNames: { count: places },
    caseProposal: { count: proposals },
  } as unknown as PrismaClient;
  return { prisma, groupBy, places, proposals };
}

const okFetch = () => vi.fn(async () => new Response("{}", { status: 200 }));
const sent = (fetch: ReturnType<typeof okFetch>, call = 0) => {
  const [url, init] = fetch.mock.calls[call] as unknown as [string, RequestInit];
  return { url, message: JSON.parse(init.body as string) as { body: string; formatted_body: string } };
};

describe("countWaitingInboxItems", () => {
  it("counts only what still waits, over all teams", async () => {
    const { prisma, groupBy, places, proposals } = fakePrisma();
    expect(await countWaitingInboxItems(prisma)).toEqual({
      locationChanges: { person: 2, pipeline: 3 },
      places: 4,
      proposedSignals: 1,
    });
    expect(groupBy.mock.calls[0][0]).toMatchObject({ by: ["origin"], where: { status: "consideration" } });
    expect(places).toHaveBeenCalledWith({ where: { status: "open" } });
    expect(proposals).toHaveBeenCalledWith({ where: { state: "proposed" } });
  });

  it("reads an origin with no open challenge as zero", async () => {
    const { prisma, groupBy } = fakePrisma();
    groupBy.mockResolvedValue([{ origin: "PIPELINE", _count: { _all: 1 } }]);
    expect((await countWaitingInboxItems(prisma)).locationChanges).toEqual({ person: 0, pipeline: 1 });
  });
});

describe("formatInboxDigest", () => {
  it("gives the total, each count and the link to /inbox", () => {
    const m = formatInboxDigest({ locationChanges: { person: 2, pipeline: 3 }, places: 4, proposedSignals: 1 }, APP);
    expect(m.body).toBe(
      [
        "📥 Inbox: 10 items wait for a decision",
        "Location changes: 5 (2 from people, 3 from the pipeline)",
        "Places: 4",
        "Proposed signals: 1",
        "https://app.example/inbox",
      ].join("\n"),
    );
    expect(m.formattedBody).toContain('<a href="https://app.example/inbox">Open the Inbox</a>');
  });

  it("says so when nothing waits, and uses the singular for one item", () => {
    const none = { locationChanges: { person: 0, pipeline: 0 }, places: 0, proposedSignals: 0 };
    expect(formatInboxDigest(none, APP).body).toBe("📥 Inbox: nothing waits for a decision.\nhttps://app.example/inbox");
    expect(formatInboxDigest({ ...none, places: 1 }, APP).body).toContain("1 item waits for a decision");
  });
});

describe("postInboxDigest", () => {
  it("posts the counts to the room", async () => {
    const fetch = okFetch();
    expect(await postInboxDigest(fakePrisma().prisma, config, APP, { fetch })).toBe(true);
    const { url, message } = sent(fetch);
    expect(url).toContain("/rooms/!r%3Ahs.example/send/m.room.message/");
    expect(message.body).toContain("Location changes: 5 (2 from people, 3 from the pipeline)");
    expect(message.body).toContain("https://app.example/inbox");
  });
});

describe("postInboxDigest across replicas", () => {
  it("sends the UTC date as the transaction id, so two replicas post one message", async () => {
    const now = new Date("2026-11-25T07:05:00Z");
    const a = okFetch();
    const b = okFetch();
    await postInboxDigest(fakePrisma().prisma, config, APP, { fetch: a, now });
    await postInboxDigest(fakePrisma().prisma, config, APP, { fetch: b, now: new Date("2026-11-25T07:09:00Z") });
    expect(sent(a).url).toMatch(/\/send\/m\.room\.message\/inbox-digest-app\.example-2026-11-25$/);
    expect(sent(b).url).toBe(sent(a).url);

    const next = okFetch();
    await postInboxDigest(fakePrisma().prisma, config, APP, { fetch: next, now: new Date("2026-11-26T07:00:00Z") });
    expect(sent(next).url).toMatch(/inbox-digest-app\.example-2026-11-26$/);
  });

  it("keeps two environments that share a room apart", async () => {
    const now = new Date("2026-11-25T07:05:00Z");
    const dev = okFetch();
    await postInboxDigest(fakePrisma().prisma, config, "https://dev.example", { fetch: dev, now });
    expect(sent(dev).url).toMatch(/inbox-digest-dev\.example-2026-11-25$/);
  });
});

describe("digestDue", () => {
  it("is due in the digest hour, once a UTC day", () => {
    expect(digestDue(new Date("2026-11-25T06:59:00Z"), null)).toBe(false);
    expect(digestDue(new Date("2026-11-25T07:00:00Z"), null)).toBe(true);
    expect(digestDue(new Date("2026-11-25T07:50:00Z"), "2026-11-25")).toBe(false);
    expect(digestDue(new Date("2026-11-25T08:00:00Z"), null)).toBe(false);
    expect(digestDue(new Date("2026-11-26T07:00:00Z"), "2026-11-25")).toBe(true);
  });
});

describe("startInboxDigestWorker / stop", () => {
  const HOUR = 60 * 60 * 1000;
  const sleep = async () => {};
  afterEach(() => {
    stopInboxDigestWorker();
    vi.useRealTimers();
  });

  it("posts once in the digest hour of each day, and never outside it", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T05:00:00Z") });
    const fetch = okFetch();
    expect(startInboxDigestWorker(fakePrisma().prisma, config, APP, { fetch, sleep })).toBe(true);

    await vi.advanceTimersByTimeAsync(1.5 * HOUR); // 06:30
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * HOUR); // 08:30, past the hour
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20 * HOUR); // 04:30 next day
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * HOUR); // 08:30 next day
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does nothing when Matrix is not configured", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T06:55:00Z") });
    const { prisma, groupBy } = fakePrisma();
    expect(startInboxDigestWorker(prisma, null, APP, { fetch: okFetch(), sleep })).toBe(false);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(groupBy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("posts nothing when it starts after the digest hour", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T09:00:00Z") });
    const fetch = okFetch();
    startInboxDigestWorker(fakePrisma().prisma, config, APP, { fetch, sleep });
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tries again on the next tick when the post fails", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T06:55:00Z") });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 403 }))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    startInboxDigestWorker(fakePrisma().prisma, config, APP, { fetch, sleep });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("survives a database error and runs nothing once stopped", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T06:55:00Z") });
    const { prisma, groupBy } = fakePrisma();
    groupBy.mockRejectedValue(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = okFetch();
    startInboxDigestWorker(prisma, config, APP, { fetch, sleep });
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(error).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    stopInboxDigestWorker();
    groupBy.mockClear();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
