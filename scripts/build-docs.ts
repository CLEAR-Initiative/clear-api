import { makeExecutableSchema } from "@graphql-tools/schema";
import { typeDefs } from "../src/schema/index.js";
import { introspectSchema } from "../src/docs/schema-introspect.js";
import { renderDocsPage } from "../src/docs/template.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const schema = makeExecutableSchema({ typeDefs });
  const schemaData = introspectSchema(schema);
  const html = renderDocsPage(schemaData);

  const outPath = join(__dirname, "../src/docs/docs.html");
  writeFileSync(outPath, html, "utf-8");
  console.log(`docs: wrote ${outPath}`);
} catch (error) {
  console.error("docs build failed:", error);
  process.exit(1);
}
