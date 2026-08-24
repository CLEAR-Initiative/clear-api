/**
 * Cacheable chrome stylesheets.
 *
 * Tokens and rules still live in TypeScript (`portalShellCss`) so pages
 * cannot drift from the source of truth. The browser caches this file
 * across /portal, /docs, and /portal/admin instead of downloading the
 * same ~20KB inline on every HTML response.
 *
 * Dev: no-store so tsx-watch edits show up without a version bump.
 * Prod/staging: long cache + `?v=` from package.json on the <link>.
 */

import { Router } from "express";
import { env } from "../utils/env.js";
import { portalShellCss } from "../portal/shell.js";

export const cssRouter = Router();

cssRouter.get("/portal-shell.css", (_req, res) => {
  res.type("text/css; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    env.NODE_ENV === "development"
      ? "no-store"
      : "public, max-age=86400, immutable",
  );
  res.send(portalShellCss());
});
