import { Router } from "express";
import type { GraphQLSchema } from "graphql";
import { introspectSchema } from "./schema-introspect.js";
import { renderDocsPage } from "./template.js";

export function createDocsRouter(schema: GraphQLSchema): Router {
  const router = Router();
  const schemaData = introspectSchema(schema);
  const html = renderDocsPage(schemaData);

  router.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  return router;
}
