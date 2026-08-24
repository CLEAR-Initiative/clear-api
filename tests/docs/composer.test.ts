import { describe, it, expect } from "vitest";
import { composeDocsPage } from "../../src/docs/template.js";

const mockTypes = [
  { name: "Alert", kind: "object", description: "", fields: [], enumValues: [] },
  { name: "Location", kind: "object", description: "", fields: [], enumValues: [] },
];

const mockMutations = [
  { name: "createAlert", description: null, type: "Alert", args: [] },
];

describe("Docs Composer", () => {
  describe("composeDocsPage - anonymous", () => {
    it("renders without Account footer when account is null", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test content</p>",
        account: null,
        types: mockTypes,
        mutations: mockMutations,
      });

      expect(html).toContain("Test content");
      expect(html).toContain("Sign in");
      expect(html).toContain("/portal/login");
      expect(html).not.toContain("Sign Out");
    });

    it("does not include old top marketing nav", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: null,
        types: [],
        mutations: [],
      });

      expect(html).not.toMatch(/<nav class="nav">/);
      expect(html).not.toContain('class="nav-brand"');
    });

    it("does not include docs-only left sidebar", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: null,
        types: [],
        mutations: [],
      });

      expect(html).not.toContain("sidebar-section");
      expect(html).not.toContain("sidebar-heading");
    });

    it("includes Portal Shell markers", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: null,
        types: [],
        mutations: [],
      });

      expect(html).toContain("portal-shell");
      expect(html).toContain('class="sidebar"');
      expect(html).toContain("docs-layout");
    });

    it("includes On This Page", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: null,
        types: mockTypes,
        mutations: mockMutations,
      });

      expect(html).toContain("docs-toc");
      expect(html).toContain("On This Page");
      expect(html).toContain("#guide");
      expect(html).toContain("#types");
      expect(html).toContain("#mutation-createalert");
    });
  });

  describe("composeDocsPage - authenticated", () => {
    it("renders Account footer with email when account provided", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: { email: "dev@example.com", role: "analyst" },
        types: [],
        mutations: [],
      });

      expect(html).toContain("sidebar-footer");
      expect(html).toContain("dev@example.com");
      expect(html).toContain("Analyst Account");
      expect(html).toContain("Sign Out");
    });

    it("still includes Portal Shell and On This Page", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: { email: "admin@example.com", role: "admin" },
        types: mockTypes,
        mutations: mockMutations,
      });

      expect(html).toContain("portal-shell");
      expect(html).toContain("docs-toc");
      expect(html).toContain("Admin Account");
    });
  });

  describe("Desktop layout", () => {
    it("uses 3-column layout with wider TOC", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: null,
        types: [],
        mutations: [],
      });

      expect(html).toContain("docs-layout");
      expect(html).toContain("docs-main");
      expect(html).toContain("docs-content");
      expect(html).toContain("docs-toc");
      expect(html).toMatch(/width:\s*260px/);
    });
  });

  describe("Narrow viewports", () => {
    it("includes mobile On This Page sheet controls", () => {
      const html = composeDocsPage({
        bodyHtml: "<p>Test</p>",
        account: null,
        types: [],
        mutations: [],
      });

      expect(html).toContain('id="mobile-toc-toggle"');
      expect(html).toContain("On This Page");
      expect(html).toContain('id="toc-overlay"');
      expect(html).toContain("openTocSheet");
      expect(html).toContain("closeTocSheet");
      expect(html).toMatch(/@media \(max-width:\s*1100px\)[\s\S]*sheet-open/);
    });
  });
});
