import { Router } from "express";
import { env } from "../utils/env.js";
import { renderWaitlistPage } from "./template.js";

const VALID_STATUSES = new Set(["ok", "exists", "conflict", "error"]);

export const waitlistRouter = Router();

// GET /waitlist — renders the public application form.
// The form posts to the clear-mvp route handler at
// ${FRONTEND_URL}/api/waitlist, which is where the Exponential CRM call
// lives. On success/failure the receiver is expected to 303-redirect back
// here with `?status=ok|exists|conflict|error` so the user lands on a
// branded confirmation page.
waitlistRouter.get("/", (req, res) => {
  const rawStatus = typeof req.query.status === "string" ? req.query.status : "";
  const status =
    rawStatus && VALID_STATUSES.has(rawStatus)
      ? (rawStatus as "ok" | "exists" | "conflict" | "error")
      : null;

  const formActionUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/api/waitlist`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Don't cache — the status query parameter changes the rendered output.
  res.setHeader("Cache-Control", "no-store");
  res.send(renderWaitlistPage({ formActionUrl, status }));
});
