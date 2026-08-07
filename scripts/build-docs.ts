import { makeExecutableSchema } from "@graphql-tools/schema";
import { typeDefs } from "../src/schema/index.js";
import { introspectSchema } from "../src/docs/schema-introspect.js";
import { renderDocsBody } from "../src/docs/template.js";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const schema = makeExecutableSchema({ typeDefs });
  const schemaData = introspectSchema(schema);
  const bodyHtml = renderDocsBody(schemaData);

  console.log(`Generated body HTML: ${bodyHtml.length} chars`);

  const outDir = join(__dirname, "../src/docs");
  const outPath = join(outDir, "docs-body.html");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, bodyHtml, { encoding: "utf-8" });

  const stats = statSync(outPath);
  console.log(`docs: wrote ${outPath}`);
  console.log(`Verified: ${stats.size} bytes on disk`);

  if (stats.size === 0) {
    throw new Error(
      "docs build wrote 0 bytes — run via tsx/node (bun 1.0 writeFileSync drops this payload)",
    );
  }
} catch (error) {
  console.error("docs build failed:", error);
  process.exit(1);
}
