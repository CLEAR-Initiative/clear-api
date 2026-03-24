import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, "docs.html");

let cachedHtml: string | null = null;

async function getHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;

  if (existsSync(htmlPath)) {
    cachedHtml = readFileSync(htmlPath, "utf-8");
    return cachedHtml;
  }

  // Fallback: generate dynamically (dev mode, no pre-built file)
  const { makeExecutableSchema } = await import("@graphql-tools/schema");
  const { typeDefs } = await import("../schema/index.js");
  const { introspectSchema } = await import("./schema-introspect.js");
  const { renderDocsPage } = await import("./template.js");

  const schema = makeExecutableSchema({ typeDefs });
  const schemaData = introspectSchema(schema);
  cachedHtml = renderDocsPage(schemaData);
  return cachedHtml;
}

export function createDocsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const html = await getHtml();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  return router;
}
