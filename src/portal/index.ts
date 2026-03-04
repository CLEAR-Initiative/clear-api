import { Router } from "express";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { renderPortal, renderLoginPage } from "./template.js";

export const portalRouter = Router();

portalRouter.get("/", async (req, res) => {
  try {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (result?.user) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderPortal({ userEmail: result.user.email }));
      return;
    }
  } catch {
    // Treat as unauthenticated
  }

  res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderLoginPage());
});
