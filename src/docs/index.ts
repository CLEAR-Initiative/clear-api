import { Router } from "express";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auth } from "../lib/auth.js";
import type { SchemaType, SchemaField } from "./schema-introspect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bodyHtmlPath = join(__dirname, "docs-body.html");

let cachedBodyHtml: string | null = null;
let cachedTypes: SchemaType[] | null = null;
let cachedMutations: SchemaField[] | null = null;

async function ensureSchemaCache(): Promise<{
  types: SchemaType[];
  mutations: SchemaField[];
}> {
  if (cachedTypes && cachedMutations) {
    return { types: cachedTypes, mutations: cachedMutations };
  }

  const { makeExecutableSchema } = await import("@graphql-tools/schema");
  const { typeDefs } = await import("../schema/index.js");
  const { introspectSchema } = await import("./schema-introspect.js");

  const schema = makeExecutableSchema({ typeDefs });
  const schemaData = introspectSchema(schema);
  cachedTypes = schemaData.types;
  cachedMutations = schemaData.mutations;
  return { types: cachedTypes, mutations: cachedMutations };
}

async function getBodyHtml(): Promise<string> {
  if (cachedBodyHtml) return cachedBodyHtml;

  if (existsSync(bodyHtmlPath)) {
    cachedBodyHtml = readFileSync(bodyHtmlPath, "utf-8");
    return cachedBodyHtml;
  }

  // Fallback: generate dynamically (dev mode, no pre-built file)
  const { renderDocsBody } = await import("./template.js");
  const { makeExecutableSchema } = await import("@graphql-tools/schema");
  const { typeDefs } = await import("../schema/index.js");
  const { introspectSchema } = await import("./schema-introspect.js");

  const schema = makeExecutableSchema({ typeDefs });
  const schemaData = introspectSchema(schema);
  cachedBodyHtml = renderDocsBody(schemaData);
  cachedTypes = schemaData.types;
  cachedMutations = schemaData.mutations;
  return cachedBodyHtml;
}

export function createDocsRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const bodyHtml = await getBodyHtml();
    const { types, mutations } = await ensureSchemaCache();

    // Resolve session for account footer (null if anonymous)
    const session = await auth.api.getSession({ headers: req.headers });
    const account = session?.user
      ? {
          email: session.user.email,
          role: (session.user as { role?: string | null }).role,
        }
      : null;

    // Compose full page with Portal Shell + body + On This Page
    const { composeDocsPage } = await import("./template.js");
    const html = composeDocsPage({ bodyHtml, account, types, mutations });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  return router;
}
