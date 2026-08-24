import { describe, expect, it } from "vitest";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:4000").replace(
  /\/$/,
  "",
);
const REQUIRE_LIVE = process.env.SMOKE_HTTP === "1";

async function get(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(8_000),
    ...init,
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function probe(): Promise<boolean> {
  try {
    const { status, body } = await get("/health");
    return status === 200 && body.includes('"ok"');
  } catch {
    return false;
  }
}

const live = await probe();

describe.skipIf(!live && !REQUIRE_LIVE)(`HTTP smoke (${BASE})`, () => {
  it("requires a live server when SMOKE_HTTP=1", () => {
    if (REQUIRE_LIVE) expect(live).toBe(true);
  });

  it("health returns ok", async () => {
    const { status, body } = await get("/health");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ status: "ok" });
  });

  it("serves public HTML surfaces with shared chrome", async () => {
    const pages: Array<{ path: string; ok: number[] }> = [
      { path: "/", ok: [200] },
      { path: "/docs", ok: [200] },
      { path: "/portal/", ok: [200] },
      { path: "/portal/login", ok: [200, 401] },
    ];
    for (const { path, ok } of pages) {
      const { status, headers, body } = await get(path);
      expect(ok, path).toContain(status);
      expect(headers.get("content-type") ?? "", path).toMatch(/text\/html/);
      expect(body, path).toContain('href="/favicon.ico"');
      expect(body, path).not.toContain("favicon.svg");
    }
  });

  it("home, docs, and portal keep working buttons", async () => {
    const home = await get("/");
    expect(home.body).toContain('href="/portal/login"');
    expect(home.body).toContain('href="/docs"');

    const docs = await get("/docs");
    expect(docs.body).toContain("portal-shell");
    expect(docs.body).toContain('href="/graphql"');
    expect(docs.body).toContain("docs-toc");
    expect(docs.body).toContain("/portal/icons/clearapi_logo.png");

    const portal = await get("/portal/");
    expect(portal.body).toContain("toggleSidebar");
    expect(portal.body).toContain("getting-started");
    expect(portal.body).toContain('href="/portal/login"');
    expect(portal.body).toContain("padding: 32px 12px 0");
    expect(portal.body).toContain("portal-toast");
    expect(portal.body).not.toMatch(
      /\.portal-shell\.sidebar-collapsed \.nav-item \{[^}]*justify-content:\s*center/,
    );
  });

  it("serves favicon, logo, and web manifest", async () => {
    const assets = [
      "/favicon.ico",
      "/apple-touch-icon.png",
      "/android-chrome-192x192.png",
      "/android-chrome-512x512.png",
      "/portal/icons/clearapi_logo.png",
      "/site.webmanifest",
    ];
    for (const path of assets) {
      const { status, body } = await get(path);
      expect(status, path).toBe(200);
      expect(body.length, path).toBeGreaterThan(0);
    }
    const manifest = await get("/site.webmanifest");
    expect(manifest.body).toContain("android-chrome-192x192.png");
  });

  it("gates admin behind login", async () => {
    const { status, body } = await get("/portal/admin");
    expect(status).toBe(401);
    expect(body).toContain("signin-form");
    expect(body).toContain("Create Account");
  });

  it("answers a GraphQL ping", async () => {
    const { status, body } = await get("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    expect(status).toBe(200);
    const json = JSON.parse(body) as { data?: { __typename?: string } };
    expect(json.data?.__typename).toBe("Query");
  });
});

describe.skipIf(live || REQUIRE_LIVE)("HTTP smoke (server offline)", () => {
  it("skips live checks when localhost is not running", () => {
    expect(live).toBe(false);
  });
});
