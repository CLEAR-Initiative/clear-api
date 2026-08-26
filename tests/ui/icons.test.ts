import { describe, expect, it } from "vitest";
import { renderIconLinks } from "../../src/ui/icons.js";
import { renderLoginPage } from "../../src/portal/template.js";
import { renderHomePage } from "../../src/home/template.js";
import { renderPortal } from "../../src/portal/template.js";

describe("renderIconLinks", () => {
  it("points at the public ico, apple touch icon, and web manifest", () => {
    const html = renderIconLinks();
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('href="/site.webmanifest"');
    expect(html).not.toContain("favicon.svg");
  });
});

describe("HTML surfaces use the shared icon links", () => {
  it("covers home, login, and portal", () => {
    for (const html of [
      renderHomePage(),
      renderLoginPage(),
      renderPortal({ userEmail: "admin@clear.dev", userRole: "admin" }),
    ]) {
      expect(html).toContain('href="/favicon.ico"');
      expect(html).toContain('href="/apple-touch-icon.png"');
      expect(html).not.toContain("favicon.svg");
    }
  });
});
