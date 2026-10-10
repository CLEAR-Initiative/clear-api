import { describe, expect, it } from "vitest";

import { dbBackedTestFiles, isDbBackedTestSource } from "./db-files.js";

// Fixture sources are assembled from parts so this file's own text never
// matches the import pattern and it stays out of the db-tests run.
const helper = "helpers/" + "db";
const imp = (names: string, from = `../${helper}.js`) => `import { ${names} } from "${from}";\n`;

describe("isDbBackedTestSource", () => {
  it("matches the gate helpers however they are later called", () => {
    expect(isDbBackedTestSource(imp("describeIfDb") + "describeIfDb(\"x\", () => {});")).toBe(true);
    expect(isDbBackedTestSource(imp("describeIfDb") + "describeIfDb.only(\"x\", () => {});")).toBe(true);
    expect(isDbBackedTestSource(imp("describeIfDb") + "describeIfDb (\"x\", () => {});")).toBe(true);
    expect(isDbBackedTestSource(imp("describeIfSeededDb"))).toBe(true);
    expect(isDbBackedTestSource(imp("dbTestsEnabled, describeIfDb"))).toBe(true);
    expect(isDbBackedTestSource(imp("describeIfDb", `../../${helper}`))).toBe(true);
  });

  it("ignores files that only mention the helper in a comment or import something else", () => {
    expect(isDbBackedTestSource("// hermetic: no describeIfDb here\n")).toBe(false);
    expect(isDbBackedTestSource("/* describeIfDb(\"x\") would need a DB */\n")).toBe(false);
    expect(isDbBackedTestSource(imp("dbTestsEnabled"))).toBe(false);
    expect(isDbBackedTestSource(imp("describeIfDb", "./other.js"))).toBe(false);
  });
});

describe("dbBackedTestFiles", () => {
  it("finds every suite that imports a DB gate and nothing else", () => {
    const files = dbBackedTestFiles();
    expect(files).toContain("tests/resolvers/task.db.test.ts");
    expect(files).toContain("tests/resolvers/location.resolver.test.ts");
    expect(files).toContain("tests/utils/geo-resolve.test.ts");
    expect(files).not.toContain("tests/resolvers/organisation.resolver.test.ts");
    expect(files).not.toContain("tests/helpers/db-files.test.ts");
    expect(files.every((f) => f.endsWith(".test.ts"))).toBe(true);
  });
});
