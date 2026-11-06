/**
 * Unit tests for the per-request touchpoint-branding seam.
 *
 * The security-critical behaviour is {@link safeFrontendBase}: on an
 * unauthenticated flow a caller-supplied host must only survive if it is
 * operator-allowlisted, so a password-reset link can never be pointed at an
 * attacker's site. `env` is mocked to a known allowlist.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/env.js", () => ({
  env: {
    FRONTEND_URL: "https://app.clear.test",
    ALLOWED_FRONTEND_ORIGINS: [
      "https://app.partner.org",
      "https://portal.partner.org",
    ],
  },
}));

const {
  brandedUrl,
  defaultFrontendBase,
  isAllowedFrontendOrigin,
  resolveBranding,
  resolveSender,
  safeFrontendBase,
  trustedFrontendBase,
} = await import("../../src/services/branding.js");

describe("brandedUrl", () => {
  it("joins slash-safely regardless of base/path slashes", () => {
    expect(brandedUrl("https://x.test", "/a")).toBe("https://x.test/a");
    expect(brandedUrl("https://x.test/", "/a")).toBe("https://x.test/a");
    expect(brandedUrl("https://x.test", "a")).toBe("https://x.test/a");
    expect(brandedUrl("https://x.test/clear/", "/a?t=1")).toBe(
      "https://x.test/clear/a?t=1",
    );
  });
});

describe("defaultFrontendBase", () => {
  it("is FRONTEND_URL normalised to no trailing slash", () => {
    expect(defaultFrontendBase()).toBe("https://app.clear.test");
  });
});

describe("isAllowedFrontendOrigin", () => {
  it("accepts allowlisted origins and FRONTEND_URL's own origin", () => {
    expect(isAllowedFrontendOrigin("https://app.partner.org/accept")).toBe(true);
    expect(isAllowedFrontendOrigin("https://app.clear.test/x")).toBe(true);
  });
  it("rejects anything else, including non-http and junk", () => {
    expect(isAllowedFrontendOrigin("https://evil.test")).toBe(false);
    expect(isAllowedFrontendOrigin("http://app.partner.org")).toBe(false); // scheme differs → different origin
    expect(isAllowedFrontendOrigin("javascript:alert(1)")).toBe(false);
    expect(isAllowedFrontendOrigin("not a url")).toBe(false);
    expect(isAllowedFrontendOrigin(null)).toBe(false);
  });
});

describe("safeFrontendBase (unauthenticated — allowlist-gated)", () => {
  it("honours an allowlisted override, preserving a path prefix and dropping query/hash + trailing slash", () => {
    expect(safeFrontendBase("https://app.partner.org/")).toBe(
      "https://app.partner.org",
    );
    expect(safeFrontendBase("https://app.partner.org/clear/?x=1#f")).toBe(
      "https://app.partner.org/clear",
    );
  });
  it("falls back to FRONTEND_URL for a non-allowlisted host", () => {
    expect(safeFrontendBase("https://evil.test/accept")).toBe(
      "https://app.clear.test",
    );
  });
  it("falls back for missing or malformed input", () => {
    expect(safeFrontendBase(null)).toBe("https://app.clear.test");
    expect(safeFrontendBase("")).toBe("https://app.clear.test");
    expect(safeFrontendBase("not a url")).toBe("https://app.clear.test");
    expect(safeFrontendBase("javascript:alert(1)")).toBe(
      "https://app.clear.test",
    );
  });
});

describe("trustedFrontendBase (authenticated — arg trusted)", () => {
  it("uses any valid http(s) URL as given", () => {
    expect(trustedFrontendBase("https://whatever.example/app/")).toBe(
      "https://whatever.example/app",
    );
    expect(trustedFrontendBase("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });
  it("falls back to FRONTEND_URL only when missing or malformed", () => {
    expect(trustedFrontendBase(null)).toBe("https://app.clear.test");
    expect(trustedFrontendBase("ftp://x.test")).toBe("https://app.clear.test");
  });
});

describe("resolveSender", () => {
  it("maps a valid senderEmail to replyTo and a non-empty senderName to fromName", () => {
    expect(
      resolveSender({ senderEmail: "ops@partner.org", senderName: "Partner" }),
    ).toEqual({ replyTo: "ops@partner.org", fromName: "Partner" });
  });
  it("drops an invalid email and a blank name", () => {
    expect(resolveSender({ senderEmail: "not-an-email", senderName: "  " }))
      .toEqual({});
    expect(resolveSender({})).toEqual({});
  });
  it("trims the name", () => {
    expect(resolveSender({ senderName: "  Partner  " })).toEqual({
      fromName: "Partner",
    });
  });
});

describe("resolveBranding", () => {
  it("gates the frontend base on the allowlist when trustFrontend is false", () => {
    const b = resolveBranding(
      { frontendBaseUrl: "https://evil.test", senderEmail: "a@b.co" },
      { trustFrontend: false },
    );
    expect(b.frontendBase).toBe("https://app.clear.test");
    expect(b.replyTo).toBe("a@b.co");
  });
  it("trusts the frontend base as-is when trustFrontend is true", () => {
    const b = resolveBranding(
      { frontendBaseUrl: "https://new-frontend.example", senderName: "Org" },
      { trustFrontend: true },
    );
    expect(b.frontendBase).toBe("https://new-frontend.example");
    expect(b.fromName).toBe("Org");
  });
});
