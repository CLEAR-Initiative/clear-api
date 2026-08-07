import { describe, it, expect } from "vitest";
import {
  buildTocTree,
  renderOnThisPage,
  renderOnThisPageScript,
  renderOnThisPageStyles,
} from "../../src/docs/on-this-page.js";

const mockTypes = [
  { name: "Alert" },
  { name: "Location" },
  { name: "Signal" },
];

const mockMutations = [
  { name: "createAlert" },
  { name: "updateAlert" },
];

describe("On This Page", () => {
  describe("buildTocTree", () => {
    it("includes all major sections", () => {
      const tree = buildTocTree(mockTypes, mockMutations);

      const sectionIds = tree.map((s) => s.id);
      expect(sectionIds).toContain("guide");
      expect(sectionIds).toContain("introduction");
      expect(sectionIds).toContain("quick-start");
      expect(sectionIds).toContain("authentication");
      expect(sectionIds).toContain("queries");
      expect(sectionIds).toContain("mutations");
      expect(sectionIds).toContain("types");
    });

    it("includes guide subsections as children", () => {
      const tree = buildTocTree([], []);
      const guideSection = tree.find((s) => s.id === "guide");

      expect(guideSection).toBeDefined();
      expect(guideSection!.children).toBeDefined();
      expect(guideSection!.children!.length).toBeGreaterThan(0);

      const childIds = guideSection!.children!.map((c) => c.id);
      expect(childIds).toContain("guide-model");
      expect(childIds).toContain("guide-setup");
      expect(childIds).toContain("guide-first-request");
    });

    it("includes all type anchors under Types section", () => {
      const tree = buildTocTree(mockTypes, []);
      const typesSection = tree.find((s) => s.id === "types");

      expect(typesSection).toBeDefined();
      expect(typesSection!.children).toBeDefined();
      expect(typesSection!.children!.length).toBe(3);

      const typeIds = typesSection!.children!.map((c) => c.id);
      expect(typeIds).toContain("type-alert");
      expect(typeIds).toContain("type-location");
      expect(typeIds).toContain("type-signal");
    });

    it("includes mutation anchors under Mutations section", () => {
      const tree = buildTocTree([], mockMutations);
      const mutationsSection = tree.find((s) => s.id === "mutations");

      expect(mutationsSection).toBeDefined();
      expect(mutationsSection!.children).toBeDefined();
      expect(mutationsSection!.children!.length).toBe(2);

      const mutationIds = mutationsSection!.children!.map((c) => c.id);
      expect(mutationIds).toContain("mutation-createalert");
      expect(mutationIds).toContain("mutation-updatealert");
    });

    it("creates lowercase type anchors", () => {
      const tree = buildTocTree([{ name: "MyCustomType" }], []);
      const typesSection = tree.find((s) => s.id === "types");

      expect(typesSection!.children![0].id).toBe("type-mycustomtype");
      expect(typesSection!.children![0].label).toBe("MyCustomType");
    });
  });

  describe("renderOnThisPage", () => {
    it("renders section links with data attributes", () => {
      const tree = buildTocTree([], []);
      const html = renderOnThisPage(tree);

      expect(html.includes('data-section="guide"')).toBe(true);
      expect(html.includes('href="#guide"')).toBe(true);
      expect(html.includes("Build Your First Integration")).toBe(true);
    });

    it("renders sections with children as expandable", () => {
      const tree = buildTocTree([{ name: "Alert" }], []);
      const html = renderOnThisPage(tree);

      expect(html.includes('data-section="guide"')).toBe(true);
      expect(html.includes("toc-parent")).toBe(true);
      expect(html.includes("toc-children")).toBe(true);
      expect(html.includes("toc-child")).toBe(true);
    });

    it("renders sections without children as simple links", () => {
      const tree = buildTocTree([], []);
      const html = renderOnThisPage(tree);

      expect(html.includes('data-section="introduction"')).toBe(true);
      expect(html.includes("Introduction")).toBe(true);
      expect(html.includes('toc-section" data-section="introduction"')).toBe(
        false,
      );
    });

    it("includes child data attributes for subsections", () => {
      const tree = buildTocTree([], []);
      const html = renderOnThisPage(tree);

      expect(html.includes('data-child="guide-model"')).toBe(true);
      expect(html.includes("The mental model")).toBe(true);
    });

    it("escapes HTML in labels", () => {
      const tree = [
        {
          id: "test",
          label: "<script>alert('xss')</script>",
        },
      ];
      const html = renderOnThisPage(tree);

      expect(html.includes("<script>alert")).toBe(false);
      expect(html.includes("&lt;script&gt;")).toBe(true);
    });

    it("uses a magnifying-glass icon for the desktop TOC control", () => {
      const html = renderOnThisPage(buildTocTree([], []));

      expect(html.includes('class="toc-collapse-btn"')).toBe(true);
      expect(html.includes("toc-collapse-btn")).toBe(true);
      // Search glyph path from PORTAL_SVGS.search (not a chevron)
      expect(html.includes("M8 2a6 6 0 104.472 10.025")).toBe(true);
      expect(html.includes('d="M15 18l-6-6 6-6"')).toBe(false);
    });

    it("advertises both ⌘K and ⌘F on the search control", () => {
      const html = renderOnThisPage(buildTocTree([], []));

      expect(html.includes('placeholder="Search (⌘K / ⌘F)"')).toBe(true);
      expect(html.includes('id="toc-search-input"')).toBe(true);
      expect(html.includes("Search (⌘K / ⌘F)")).toBe(true);
    });
  });

  describe("renderOnThisPageScript", () => {
    it("binds Cmd/Ctrl+K and Cmd/Ctrl+F to focus TOC search", () => {
      const script = renderOnThisPageScript();

      // Use includes — Bun 1.0 toContain is unreliable on large template strings.
      expect(script.includes("key === 'k'")).toBe(true);
      expect(script.includes("key === 'f'")).toBe(true);
      expect(script.includes("e.metaKey || e.ctrlKey")).toBe(true);
      expect(script.includes("searchInput.focus()")).toBe(true);
    });

    it("scrolls headings with block:start (padding-top inset, no fixed 100px offset)", () => {
      const script = renderOnThisPageScript();
      expect(script.includes("function scrollDocsHeadingIntoView")).toBe(true);
      expect(script.includes("block: 'start'")).toBe(true);
      expect(script.includes("var offset = 100")).toBe(false);
    });
  });

  describe("renderOnThisPageStyles", () => {
    it("defines equal heading inset token for top/bottom title spacing", () => {
      const css = renderOnThisPageStyles();
      expect(css.includes("--docs-heading-inset")).toBe(true);
      expect(css.includes("scroll-margin-top: 0")).toBe(true);
    });
  });
});
