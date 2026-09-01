import { describe, expect, it } from "vitest";
import { renderAuthPageStyles, renderWaitingPageStyles } from "../../src/ui/auth-page.js";
import {
  renderThemeRoot,
  THEMES,
} from "../../src/ui/theme.js";
import { renderLoginPage, renderWaitingForApproval } from "../../src/portal/template.js";
import { renderPortalShellStyles } from "../../src/portal/shell.js";
import { renderHomePage } from "../../src/home/template.js";

describe("shared UI themes", () => {
  it("keeps portal and marketing palettes distinct", () => {
    expect(THEMES.portal.colorAccent).toBe("#c2410c");
    expect(THEMES.marketing.colorAccent).toBe("#f2612a");
    expect(THEMES.portal.colorBg).toBe("#0a0a0a");
    expect(THEMES.marketing.colorBg).toBe("#0a0a0b");
    expect(THEMES.portal.onAccent).toBe("#fff7ed");
    expect(THEMES.marketing.onAccent).toBe("#0a0a0b");
  });

  it("emits canonical --color-* names for both themes", () => {
    const portal = renderThemeRoot("portal");
    const marketing = renderThemeRoot("marketing");
    expect(portal).toContain("--color-accent: #c2410c");
    expect(marketing).toContain("--color-accent: #f2612a");
    expect(marketing).toContain("--accent: var(--color-accent)");
    expect(portal).not.toContain("--accent: var(--color-accent)");
  });
});

describe("auth + home surfaces consume the shared theme", () => {
  it("login and waiting use marketing tokens, not hardcoded accent hex in CSS", () => {
    const login = renderLoginPage();
    const waiting = renderWaitingForApproval({ userEmail: "a@b.dev" });
    const authCss = renderAuthPageStyles();
    const waitingCss = renderWaitingPageStyles();

    expect(authCss).toContain("--color-accent: #f2612a");
    expect(login).toContain("var(--color-accent)");
    expect(waitingCss).toContain("--color-accent: #f2612a");
    expect(waiting).toContain("var(--color-warning)");
    expect(login).not.toMatch(/input:focus \{[^}]*#f2612a/);
  });

  it("portal shell still uses the darker portal accent", () => {
    const css = renderPortalShellStyles();
    expect(css).toContain("--color-accent: #c2410c");
    expect(css).not.toContain("--color-accent: #f2612a");
  });

  it("home keeps legacy aliases so existing rules resolve to marketing values", () => {
    const html = renderHomePage();
    expect(html).toContain("--color-bg: #0a0a0b");
    expect(html).toContain("--bg: var(--color-bg)");
    expect(html).toContain("--accent: var(--color-accent)");
    expect(html).toContain("background: var(--bg)");
  });
});
