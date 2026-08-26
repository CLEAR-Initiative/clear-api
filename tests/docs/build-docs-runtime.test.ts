/**
 * Deploy contract: the GHCR image is oven/bun, which has no working tsx.
 * PR #138 switched build:docs to tsx; CI (Ubuntu + Node) stayed green and
 * Build & deploy failed on merge. Fail here if that line regresses.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "../../package.json"), "utf8"),
) as { scripts: Record<string, string> };

describe("build:docs runtime (Docker / oven/bun)", () => {
  it("runs via bun, not tsx", () => {
    expect(pkg.scripts["build:docs"]).toBe("bun scripts/build-docs.ts");
    expect(pkg.scripts.build).toContain("build:docs");
  });
});
