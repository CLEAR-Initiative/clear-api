import { describe, it, expect, vi } from "vitest";
import {
  formatGlitchtipAlert,
  matrixConfigFromEnv,
  postMatrixMessage,
  rateLimitWaitMs,
  shortenDagsterTitle,
} from "../../src/services/webhook/matrix.js";

const glitchtipPayload = {
  alias: "issue.new",
  text: "GlitchTip Alert",
  attachments: [
    {
      title: "TypeError: Cannot read properties of null (reading 'id')",
      title_link: "https://sentry.clearinitiative.io/clearinitiative/issues/42",
      text: "src/resolvers/alert.resolver.ts in createAlert",
      fields: [
        { title: "Project", value: "clear-api", short: true },
        { title: "Environment", value: "production", short: true },
        { title: "Server Name", value: "app-1", short: true },
      ],
    },
  ],
};

const config = {
  homeserverUrl: "https://hs.example/",
  accessToken: "tok",
  roomId: "!r:hs.example",
};

describe("matrixConfigFromEnv", () => {
  it("is null unless all three vars are set", () => {
    expect(
      matrixConfigFromEnv({ MATRIX_HOMESERVER_URL: "x", MATRIX_ACCESS_TOKEN: "y" }),
    ).toBeNull();
    expect(
      matrixConfigFromEnv({
        MATRIX_HOMESERVER_URL: "x",
        MATRIX_ACCESS_TOKEN: "y",
        MATRIX_GLITCHTIP_ROOM_ID: "z",
      }),
    ).toEqual({ homeserverUrl: "x", accessToken: "y", roomId: "z" });
  });
});

describe("formatGlitchtipAlert", () => {
  it("renders heading, title link, project and environment", () => {
    const m = formatGlitchtipAlert(glitchtipPayload);
    expect(m.body).toContain("🚨 New error: TypeError");
    expect(m.body).toContain("Project: clear-api · Environment: production");
    expect(m.body).not.toContain("Server Name");
    expect(m.body).toContain("https://sentry.clearinitiative.io/clearinitiative/issues/42");
    expect(m.formattedBody).toContain(
      '<a href="https://sentry.clearinitiative.io/clearinitiative/issues/42">',
    );
    expect(m.formattedBody).toContain("reading 'id'");
  });

  it("escapes HTML and refuses non-http links", () => {
    const m = formatGlitchtipAlert({
      alias: "issue.regression",
      attachments: [{ title: "<script>x</script>", title_link: "javascript:alert(1)" }],
    });
    expect(m.formattedBody).toContain("&lt;script&gt;");
    expect(m.formattedBody).not.toContain("<script>");
    expect(m.formattedBody).not.toContain("javascript:");
    expect(m.body).toContain("Regression:");
  });

  it("survives a minimal or junk payload", () => {
    expect(formatGlitchtipAlert({}).body).toContain("GlitchTip alert: Untitled issue");
    expect(formatGlitchtipAlert(null).body).toContain("Untitled issue");
    expect(formatGlitchtipAlert({ text: "hi", project: "clear-mvp" }).body).toContain(
      "Project: clear-mvp",
    );
  });
});

describe("shortenDagsterTitle", () => {
  const run = "c0af0538-185f-4c93-8106-1b2a5e62f27f";
  it("keeps the job and the message, and drops the run id, pid, step and event kind", () => {
    expect(
      shortenDagsterTitle(`darfur24_ingest - ${run} - raw_darfur24 - [DARFUR24] feed request fai…`),
    ).toBe("darfur24_ingest: [DARFUR24] feed request fai…");
    expect(
      shortenDagsterTitle(
        `idmc_gx - ${run} - 2393189 - idmc_silver - STEP_FAILURE - Execution of step "idmc_silver" failed.`,
      ),
    ).toBe('idmc_gx: Execution of step "idmc_silver" failed.');
    expect(
      shortenDagsterTitle(
        `idmc_gx - ${run} - 2393189 - RUN_FAILURE - Execution of run for "idmc_gx" failed.`,
      ),
    ).toBe('idmc_gx: Execution of run for "idmc_gx" failed.');
  });

  it("keeps a message that has its own dashes, and a one-word message", () => {
    expect(shortenDagsterTitle(`job - ${run} - step - retry 2 - gave up`)).toBe(
      "job: retry 2 - gave up",
    );
    expect(shortenDagsterTitle(`job - ${run} - step - Timeout`)).toBe("job: Timeout");
    expect(shortenDagsterTitle(`job - ${run} - step - TimeoutError - request failed`)).toBe(
      "job: TimeoutError - request failed",
    );
    expect(shortenDagsterTitle(`job - ${run} - TimeoutError - request failed`)).toBe(
      "job: TimeoutError - request failed",
    );
  });

  it("leaves every other title alone", () => {
    const title = "TypeError: Cannot read properties of null (reading 'id')";
    expect(shortenDagsterTitle(title)).toBe(title);
    expect(shortenDagsterTitle("Dagster run failed: idmc_gx — Execution failed")).toBe(
      "Dagster run failed: idmc_gx — Execution failed",
    );
  });
});

describe("formatGlitchtipAlert ticket link", () => {
  const ticket = {
    number: 1702,
    url: "https://www.exponential.im/w/clear/products/clear/tickets/1702",
  };
  it("adds the ticket as its own linked line", () => {
    const m = formatGlitchtipAlert(glitchtipPayload, { ticket });
    expect(m.body).toContain(`Ticket #1702: ${ticket.url}`);
    expect(m.formattedBody).toContain(`<a href="${ticket.url}">Ticket #1702</a>`);
  });

  it("posts without a ticket line when there is no ticket or its link is not http(s)", () => {
    expect(formatGlitchtipAlert(glitchtipPayload, { ticket: null }).body).not.toContain("Ticket");
    const m = formatGlitchtipAlert(glitchtipPayload, {
      ticket: { number: 1, url: "javascript:alert(1)" },
    });
    expect(m.body).not.toContain("Ticket");
    expect(m.formattedBody).not.toContain("javascript:");
  });

  it("shortens a Dagster title in the message", () => {
    const m = formatGlitchtipAlert({
      alias: "issue.new",
      attachments: [
        {
          title:
            "darfur24_ingest - c0af0538-185f-4c93-8106-1b2a5e62f27f - raw_darfur24 - [DARFUR24] feed",
        },
      ],
    });
    expect(m.body).toContain("🚨 New error: darfur24_ingest: [DARFUR24] feed");
    expect(m.body).not.toContain("c0af0538");
  });
});

describe("formatGlitchtipAlert junk attachments", () => {
  it("does not throw on null attachments or fields", () => {
    expect(() => formatGlitchtipAlert({ attachments: [null] })).not.toThrow();
    expect(() => formatGlitchtipAlert({ attachments: [{ fields: [null, 3] }] })).not.toThrow();
  });
});

describe("rateLimitWaitMs", () => {
  it("reads Retry-After seconds, then retry_after_ms, capped", () => {
    expect(rateLimitWaitMs(new Headers({ "retry-after": "30" }), "")).toBe(30_000);
    expect(rateLimitWaitMs(new Headers(), '{"retry_after_ms":7000}')).toBe(7_000);
    expect(rateLimitWaitMs(new Headers({ "retry-after": "99999" }), "")).toBe(120_000);
    expect(rateLimitWaitMs(new Headers(), "nope")).toBeNull();
  });
});

describe("postMatrixMessage", () => {
  const msg = { body: "b", formattedBody: "<b>b</b>" };
  const sleep = async () => {};

  it("PUTs to the room send endpoint with the bearer token", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await postMatrixMessage(config, msg, { fetch, sleep })).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(
      /^https:\/\/hs\.example\/_matrix\/client\/v3\/rooms\/!r%3Ahs\.example\/send\/m\.room\.message\/[0-9a-f-]+$/,
    );
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toMatchObject({ msgtype: "m.notice", body: "b" });
  });

  it("retries 5xx with the same txn id, then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await postMatrixMessage(config, msg, { fetch, sleep })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe(fetch.mock.calls[1]![0]);
  });

  it("gives up at once on a 403 and never throws on network errors", async () => {
    const forbidden = vi.fn(async () => new Response("no", { status: 403 }));
    expect(await postMatrixMessage(config, msg, { fetch: forbidden, sleep })).toBe(false);
    expect(forbidden).toHaveBeenCalledTimes(1);

    const broken = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await postMatrixMessage(config, msg, { fetch: broken, sleep })).toBe(false);
    expect(broken).toHaveBeenCalledTimes(3);
  });

  it("waits the homeserver's requested time on 429", async () => {
    const waits: number[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":30000}', { status: 429 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const ok = await postMatrixMessage(config, msg, {
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(ok).toBe(true);
    expect(waits).toEqual([30_000]);
  });
});
