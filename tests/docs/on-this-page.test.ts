import { describe, it, expect } from "vitest";
import {
  buildTocTree,
  renderOnThisPage,
  renderOnThisPageScript,
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

      expect(html).toContain('data-section="guide"');
      expect(html).toContain('href="#guide"');
      expect(html).toContain("Build Your First Integration");
    });

    it("renders sections with children as expandable", () => {
      const tree = buildTocTree([{ name: "Alert" }], []);
      const html = renderOnThisPage(tree);

      expect(html).toMatch(/<div class="toc-section" data-section="guide">/);
      expect(html).toContain("toc-parent");
      expect(html).toContain("toc-children");
      expect(html).toContain("toc-child");
    });

    it("renders sections without children as simple links", () => {
      const tree = buildTocTree([], []);
      const html = renderOnThisPage(tree);

      expect(html).toMatch(/<a[^>]*data-section="introduction"[^>]*>Introduction<\/a>/);
      expect(html).not.toMatch(/<div class="toc-section" data-section="introduction">/);
    });

    it("includes child data attributes for subsections", () => {
      const tree = buildTocTree([], []);
      const html = renderOnThisPage(tree);

      expect(html).toContain('data-child="guide-model"');
      expect(html).toContain("The mental model");
    });

    it("escapes HTML in labels", () => {
      const tree = [
        {
          id: "test",
          label: "<script>alert('xss')</script>",
        },
      ];
      const html = renderOnThisPage(tree);

      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    });

    it("uses a magnifying-glass icon for the desktop TOC control", () => {
      const html = renderOnThisPage(buildTocTree([], []));

      expect(html).toContain('class="toc-collapse-btn"');
      expect(html).toContain('title="Search (⌘K / ⌘F)"');
      // Search glyph path from PORTAL_SVGS.search (not a chevron)
      expect(html).toContain("M8 2a6 6 0 104.472 10.025");
      expect(html).not.toContain('d="M15 18l-6-6 6-6"');
    });

    it("advertises both ⌘K and ⌘F on the search control", () => {
      const html = renderOnThisPage(buildTocTree([], []));

      expect(html).toContain('placeholder="Search (⌘K / ⌘F)"');
      expect(html).toMatch(
        /id="toc-search-input"[^>]*title="Search \(⌘K \/ ⌘F\)"/
      );
    });
  });

  describe("renderOnThisPageScript", () => {
    it("binds Cmd/Ctrl+K and Cmd/Ctrl+F to focus TOC search", () => {
      const script = renderOnThisPageScript();

      expect(script).toContain("key === 'k'");
      expect(script).toContain("key === 'f'");
      expect(script).toContain("e.metaKey || e.ctrlKey");
      expect(script).toContain("e.preventDefault()");
      expect(script).toContain("searchInput.focus()");
    });
  });
});
