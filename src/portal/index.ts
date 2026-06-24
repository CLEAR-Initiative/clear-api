import { Router, type Request, type Response } from "express";
import express from "express";
import { GraphQLError } from "graphql";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { prisma } from "../lib/prisma.js";
import { approveUserById } from "../services/approve-user.js";
import {
  renderPortal,
  renderLoginPage,
  renderAdminPending,
  renderAdminMetrics,
  renderWaitingForApproval,
  type AdminPendingUser,
  type AdminMetrics,
} from "./template.js";

export const portalRouter = Router();

/**
 * Resolve the current Better Auth session from request headers.
 * Returns `null` for unauthenticated calls (treated as "show login").
 */
async function currentUser(req: Request) {
  try {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    return result?.user ?? null;
  } catch {
    return null;
  }
}

// ─── GET /portal — three-way render based on role ────────────────────────
// 1. unauthenticated → login page
// 2. pending         → waiting-for-approval screen (no tabs, no API keys)
// 3. approved        → standard dev-portal tabs (existing behaviour)

portalRouter.get("/", async (req, res) => {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderLoginPage());
    return;
  }

  if (user.role === "pending") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderWaitingForApproval({ userEmail: user.email }));
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPortal({ userEmail: user.email, userRole: user.role }));
});

// ─── /portal/admin — admin-gated approvals dashboard ─────────────────────

/**
 * Common guard for both /portal/admin and /portal/admin/approve. Returns
 * the authenticated admin user on success; sends the right HTTP status
 * and HTML response otherwise (and returns null so the caller bails).
 */
async function requireAdminSession(req: Request, res: Response) {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderLoginPage());
    return null;
  }
  if (user.role !== "admin") {
    res.status(403).type("text/html").send(
      `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 2rem;">
       <h1>403 Forbidden</h1>
       <p>The admin dashboard is restricted to global admins.</p>
       <p><a href="/portal">Back to portal</a></p>
       </body></html>`,
    );
    return null;
  }
  return user;
}

portalRouter.get("/admin", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  // Tab routing. Default to dashboard so admins land on the metrics
  // overview rather than the (often empty) pending queue.
  const requestedTab = req.query.tab;
  const tab: "dashboard" | "pending" =
    requestedTab === "pending" ? "pending" : "dashboard";

  // Flash messages come through as query params after the POST→303
  // redirect from /portal/admin/approve. Keeps the GET handler
  // stateless and free of session-flash plumbing.
  const flashKind = req.query.flash === "success" ? "success" : req.query.flash === "error" ? "error" : null;
  const flashMsg = typeof req.query.msg === "string" ? req.query.msg : "";
  const flash =
    flashKind && flashMsg
      ? { kind: flashKind as "success" | "error", message: flashMsg }
      : null;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (tab === "pending") {
    const pending = await prisma.user.findMany({
      where: { role: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    res.send(
      renderAdminPending({
        currentUserEmail: admin.email,
        pendingUsers: pending as AdminPendingUser[],
        flash,
      }),
    );
    return;
  }

  // Dashboard tab — gather every metric in parallel. The pending count
  // is also needed for the tab badge regardless of which tab we render,
  // so it always runs.
  const metrics = await computeAdminMetrics();
  res.send(
    renderAdminMetrics({
      currentUserEmail: admin.email,
      metrics,
      pendingCount: metrics.engagement.usersByRole.pending,
      flash,
    }),
  );
});

/**
 * Pull every dashboard metric in one parallel batch. Counts are cheap
 * Prisma `count` calls; DAU/MAU need a distinct-user count over a time
 * window so they go through raw SQL — bigint-typed from Postgres, so
 * we coerce to number before returning.
 */
async function computeAdminMetrics(): Promise<AdminMetrics> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    dauRows,
    mauRows,
    totalUsers,
    adminUsers,
    analystUsers,
    viewerUsers,
    pendingUsers,
    signals,
    events,
    publishedAlerts,
    crises,
    organisations,
    teams,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(DISTINCT user_id)::bigint AS c
      FROM activity_logs
      WHERE created_at > ${dayAgo}
    `,
    prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(DISTINCT user_id)::bigint AS c
      FROM activity_logs
      WHERE created_at > ${monthAgo}
    `,
    prisma.user.count(),
    prisma.user.count({ where: { role: "admin" } }),
    prisma.user.count({ where: { role: "analyst" } }),
    prisma.user.count({ where: { role: "viewer" } }),
    prisma.user.count({ where: { role: "pending" } }),
    prisma.signals.count({ where: { isDummy: false } }),
    prisma.events.count({ where: { isDummy: false } }),
    prisma.alerts.count({ where: { status: "published" } }),
    prisma.crises.count(),
    prisma.organisations.count(),
    prisma.teams.count(),
  ]);

  const toNumber = (b: bigint | undefined) => Number(b ?? 0n);

  return {
    engagement: {
      dau: toNumber(dauRows[0]?.c),
      mau: toNumber(mauRows[0]?.c),
      totalUsers,
      usersByRole: {
        admin: adminUsers,
        analyst: analystUsers,
        viewer: viewerUsers,
        pending: pendingUsers,
      },
    },
    content: {
      signals,
      events,
      publishedAlerts,
      crises,
    },
    org: {
      organisations,
      teams,
    },
  };
}

// POST handler needs urlencoded form parsing — Better Auth's catch-all
// runs before express.json() so we attach the parser locally to this
// subroute rather than mounting it globally.
portalRouter.post(
  "/admin/approve",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const admin = await requireAdminSession(req, res);
    if (!admin) return;

    const userId =
      typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    if (!userId) {
      res.redirect(303, "/portal/admin?flash=error&msg=Missing+userId");
      return;
    }

    try {
      const result = await approveUserById(prisma, admin.id, userId);
      const detail = result.crmMoved
        ? "Approved and synced to CRM."
        : result.crmWarnings.length > 0
          ? `Approved locally. CRM sync issues: ${result.crmWarnings.join(", ")}`
          : "Approved locally.";
      res.redirect(
        303,
        `/portal/admin?flash=success&msg=${encodeURIComponent(`${result.user.email}: ${detail}`)}`,
      );
    } catch (err) {
      const message =
        err instanceof GraphQLError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error";
      res.redirect(
        303,
        `/portal/admin?flash=error&msg=${encodeURIComponent(message)}`,
      );
    }
  },
);
