import { Router, type Request, type Response } from "express";
import express from "express";
import { GraphQLError } from "graphql";
import { randomBytes } from "node:crypto";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { prisma } from "../lib/prisma.js";
import {
  defaultOrgRoleForNewMember,
  getAdminOrganisation,
  listAdminOrganisations,
  portalAddOrgMember,
  portalCreateOrganisation,
  portalCreateTeam,
  portalDeleteOrganisation,
  portalDeleteTeam,
  portalImportTeam,
  portalInviteToOrganisation,
  portalAddTeamMember,
  portalRemoveOrgMember,
  portalRemoveTeamMember,
  portalUpdateMemberName,
  portalUpdateOrganisation,
  portalUpdateOrgMemberRole,
  portalUpdateTeamMemberRole,
  slugifyName,
} from "./admin-orgs.js";
import { approveUserById } from "../services/approve-user.js";
import {
  MIN_PASSWORD_LENGTH,
  findValidResetToken,
  resetPasswordWithToken,
  sendPasswordResetEmail,
} from "../services/password-reset.js";
import { fetchNewsletterSubscriberCount } from "../services/buttondown.js";
import { env } from "../utils/env.js";
import { attemptDelivery, MAX_ATTEMPTS } from "../services/webhook/deliver.js";
import {
  renderPortal,
  renderLoginPage,
  safePortalNext,
  renderResetPasswordPage,
  renderAdminUsers,
  renderAdminMetrics,
  renderAdminOrganisations,
  renderAdminOrgDetail,
  renderWaitingForApproval,
  renderAdminWebhooksList,
  renderAdminWebhookNew,
  renderAdminWebhookDetail,
  type AdminUserRow,
  type AdminMetrics,
  type AdminTab,
  type AdminWebhookRow,
  type AdminWebhookDelivery,
} from "./template.js";

export const portalRouter = Router();

const urlencoded = express.urlencoded({ extended: false });

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

// ─── GET /portal/login — sign-in for auth-gated portal destinations ───────

portalRouter.get("/login", async (req, res) => {
  const user = await currentUser(req);
  const next = safePortalNext(
    typeof req.query.next === "string" ? req.query.next : undefined,
  );
  if (user) {
    res.redirect(303, next);
    return;
  }
  res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderLoginPage({ next }));
});

// ─── GET /portal — public tabs for anonymous; full portal when signed in ─

portalRouter.get("/", async (req, res) => {
  const user = await currentUser(req);

  if (!user) {
    // Getting Started + API Reference are public; other tabs redirect to /portal/login
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPortal({ userEmail: null }));
    return;
  }

  if (user.role === "pending") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderWaitingForApproval({ userEmail: user.email }));
    return;
  }

  // Render portal for all authenticated users (admins can navigate to /portal/admin via sidebar)
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPortal({ userEmail: user.email, userRole: user.role }));
});

// ─── Password reset — unauthenticated by design ───────────────────────────
//
// The portal router is mounted before the app's global express.json(), so
// these handlers bring their own JSON parser.

const jsonBody = express.json({ limit: "16kb" });

/**
 * Kick off a forgot-password email.
 *
 * Always 204, whatever happens: unknown address, throttled, or a dead
 * mail provider all look identical from here. Anything else would turn
 * this into an account-enumeration oracle.
 */
portalRouter.post("/forgot-password", jsonBody, async (req, res) => {
  const email =
    typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

  if (email) {
    try {
      await sendPasswordResetEmail(prisma, email);
    } catch (err) {
      // The service swallows send failures itself; this catches the
      // unexpected (e.g. DB down). Still a 204 — the client can't be
      // told which addresses exist.
      console.error(
        "[PORTAL] forgot-password failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  res.status(204).end();
});

/**
 * Render the page behind the emailed link. The token is validated up
 * front so an expired link shows a dead-link message instead of a form
 * that can only fail on submit.
 */
portalRouter.get("/reset-password", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const kind = req.query.kind === "setup" ? "setup" : "reset";
  const valid = token ? await findValidResetToken(prisma, token) : null;

  res
    .status(valid ? 200 : 400)
    // The URL carries a live credential — keep it out of caches and out
    // of the Referer header on the font/CDN requests this page makes.
    .setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderResetPasswordPage({ token, kind, tokenValid: valid !== null }),
  );
});

/** Consume the token and set the new password. */
portalRouter.post("/reset-password", jsonBody, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const newPassword =
    typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

  let result;
  try {
    result = await resetPasswordWithToken(prisma, token, newPassword);
  } catch (err) {
    console.error(
      "[PORTAL] reset-password failed:",
      err instanceof Error ? err.message : err,
    );
    res.status(500).json({ message: "Could not update your password." });
    return;
  }

  if (result.ok) {
    res.status(204).end();
    return;
  }

  // `USER_NOT_FOUND` means the token outlived its user — indistinguishable
  // from a dead link as far as the person holding it is concerned.
  const message =
    result.reason === "WEAK_PASSWORD"
      ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      : "This link is invalid or has expired. Request a new one.";

  res.status(400).json({ message });
});

// ─── /portal/admin — SuperAdmin dashboard ─────────────────────────────────

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

function parseAdminTab(raw: unknown): AdminTab {
  if (raw === "users" || raw === "pending") return "users";
  if (raw === "organisations" || raw === "webhooks") return raw;
  return "dashboard";
}

function parseFlash(req: Request) {
  const flashKind =
    req.query.flash === "success" ? "success" : req.query.flash === "error" ? "error" : null;
  const flashMsg = typeof req.query.msg === "string" ? req.query.msg : "";
  return flashKind && flashMsg
    ? { kind: flashKind as "success" | "error", message: flashMsg }
    : null;
}

function adminRedirect(
  res: Response,
  tab: AdminTab,
  flash: { kind: "success" | "error"; message: string },
  orgId?: string,
) {
  const params = new URLSearchParams({ tab, flash: flash.kind, msg: flash.message });
  if (orgId) params.set("org", orgId);
  res.redirect(303, `/portal/admin?${params.toString()}`);
}

portalRouter.get("/admin", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const tab = parseAdminTab(req.query.tab);
  const flash = parseFlash(req);
  const pendingCount = await prisma.user.count({ where: { role: "pending" } });

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (tab === "users") {
    const rows = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        organisations: {
          select: { organisation: { select: { name: true } } },
        },
      },
    });
    const users: AdminUserRow[] = rows
      .map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        createdAt: u.createdAt,
        organisations: u.organisations.map((m) => m.organisation.name),
      }))
      .sort((a, b) => {
        const ap = a.role === "pending" ? 0 : 1;
        const bp = b.role === "pending" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
    res.send(
      renderAdminUsers({
        currentUserEmail: admin.email,
        users,
        flash,
        pendingCount,
      }),
    );
    return;
  }

  if (tab === "organisations") {
    const orgId = typeof req.query.org === "string" ? req.query.org.trim() : "";
    if (orgId) {
      const org = await getAdminOrganisation(orgId);
      if (!org) {
        adminRedirect(res, "organisations", { kind: "error", message: "Organisation not found." });
        return;
      }
      res.send(
        renderAdminOrgDetail({
          currentUserEmail: admin.email,
          pendingCount,
          org,
          defaultInviteOrgRole: defaultOrgRoleForNewMember(org.members.length),
          flash,
        }),
      );
      return;
    }

    const organisations = await listAdminOrganisations();
    res.send(
      renderAdminOrganisations({
        currentUserEmail: admin.email,
        pendingCount,
        organisations,
        flash,
      }),
    );
    return;
  }

  if (tab === "webhooks") {
    const rows = await loadWebhookRows();
    res.send(
      renderAdminWebhooksList({
        currentUserEmail: admin.email,
        pendingCount,
        rows,
        flash,
      }),
    );
    return;
  }

  // Dashboard tab — pendingCount already fetched above for the tab badge.
  const metrics = await computeAdminMetrics();
  res.send(
    renderAdminMetrics({
      currentUserEmail: admin.email,
      metrics,
      pendingCount,
      flash,
    }),
  );
});

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
    newsletter,
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
    fetchNewsletterSubscriberCount(env.BUTTONDOWN_API_KEY),
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
    newsletter,
  };
}

function portalActionError(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

// ─── POST /portal/admin/approve ──────────────────────────────────────────

portalRouter.post("/admin/approve", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  if (!userId) {
    adminRedirect(res, "users", { kind: "error", message: "Missing userId" });
    return;
  }

  try {
    const result = await approveUserById(prisma, admin.id, userId);
    const detail = result.crmMoved
      ? "Approved and synced to CRM."
      : result.crmWarnings.length > 0
        ? `Approved locally. CRM sync issues: ${result.crmWarnings.join(", ")}`
        : "Approved locally.";
    adminRedirect(res, "users", {
      kind: "success",
      message: `${result.user.email}: ${detail}`,
    });
  } catch (err) {
    const message =
      err instanceof GraphQLError ? err.message : portalActionError(err);
    adminRedirect(res, "users", { kind: "error", message });
  }
});

// ─── POST /portal/admin/orgs/* — organisation management ─────────────────

portalRouter.post("/admin/orgs/create", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const name = typeof req.body?.name === "string" ? req.body.name : "";
  let slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
  if (!slug && name) slug = slugifyName(name);

  try {
    const org = await portalCreateOrganisation(name, slug);
    adminRedirect(
      res,
      "organisations",
      {
        kind: "success",
        message: `Created "${org.name}". Add members to a team below.`,
      },
      org.id,
    );
  } catch (err) {
    adminRedirect(res, "organisations", { kind: "error", message: portalActionError(err) });
  }
});

portalRouter.post("/admin/orgs/update", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  const slug = typeof req.body?.slug === "string" ? req.body.slug : undefined;

  try {
    if (!orgId) throw new Error("Missing organisation id.");
    const org = await portalUpdateOrganisation(orgId, { name, slug });
    adminRedirect(
      res,
      "organisations",
      { kind: "success", message: `Updated "${org.name}".` },
      orgId,
    );
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/delete", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";

  try {
    if (!orgId) throw new Error("Missing organisation id.");
    const orgName = await portalDeleteOrganisation(orgId);
    adminRedirect(res, "organisations", {
      kind: "success",
      message: `Deleted organisation "${orgName}".`,
    });
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/members/add", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const orgRole = typeof req.body?.orgRole === "string" ? req.body.orgRole : undefined;

  try {
    if (!orgId || !email) throw new Error("Organisation and email are required.");
    await portalAddOrgMember(orgId, email, orgRole);
    adminRedirect(res, "organisations", { kind: "success", message: `Added ${email}.` }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/members/role", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const role = typeof req.body?.role === "string" ? req.body.role : "";

  try {
    if (!orgId || !userId || !role) throw new Error("Missing fields.");
    await portalUpdateOrgMemberRole(orgId, userId, role);
    adminRedirect(res, "organisations", { kind: "success", message: "Org role updated." }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/members/name", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name : "";

  try {
    if (!userId || !name) throw new Error("Missing fields.");
    await portalUpdateMemberName(userId, name);
    adminRedirect(res, "organisations", { kind: "success", message: "Name updated." }, orgId || undefined);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/members/remove", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";

  try {
    if (!orgId || !userId) throw new Error("Missing fields.");
    await portalRemoveOrgMember(orgId, userId);
    adminRedirect(res, "organisations", { kind: "success", message: "Member removed." }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/invite", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const orgRole = typeof req.body?.orgRole === "string" ? req.body.orgRole : undefined;
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const teamRole = typeof req.body?.teamRole === "string" ? req.body.teamRole : undefined;

  try {
    if (!orgId || !email || !teamId) throw new Error("Email and team are required.");
    const result = await portalInviteToOrganisation({
      orgId,
      inviterId: admin.id,
      inviterName: admin.name,
      email,
      orgRole,
      teamId,
      teamRole,
    });
    const msg =
      result.kind === "invited"
        ? `Invitation sent to ${result.email}.`
        : `Added ${result.email} to the organisation.`;
    adminRedirect(res, "organisations", { kind: "success", message: msg }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

// ─── POST /portal/admin/orgs/teams/* — team management ───────────────────

portalRouter.post("/admin/orgs/teams/create", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  let slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
  const description =
    typeof req.body?.description === "string" ? req.body.description : undefined;
  if (!slug && name) slug = slugifyName(name);

  try {
    if (!orgId) throw new Error("Missing organisation id.");
    const team = await portalCreateTeam(orgId, name, slug, description);
    adminRedirect(
      res,
      "organisations",
      { kind: "success", message: `Created team "${team.name}".` },
      orgId,
    );
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/teams/import", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const sourceTeamId =
    typeof req.body?.sourceTeamId === "string" ? req.body.sourceTeamId.trim() : "";

  try {
    if (!orgId || !sourceTeamId) throw new Error("Select a team to import.");
    const result = await portalImportTeam(orgId, sourceTeamId);
    adminRedirect(
      res,
      "organisations",
      {
        kind: "success",
        message: `Imported "${result.team.name}" with ${result.imported} member${result.imported === 1 ? "" : "s"}.`,
      },
      orgId,
    );
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/teams/delete", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";

  try {
    if (!orgId || !teamId) throw new Error("Missing fields.");
    const teamName = await portalDeleteTeam(orgId, teamId);
    adminRedirect(
      res,
      "organisations",
      { kind: "success", message: `Deleted team "${teamName}".` },
      orgId,
    );
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

// ─── /portal/admin/webhooks ────────────────────────────────────────────
//
// Server-rendered admin panel for webhook subscription management.
// Mirrors the GraphQL resolvers in src/resolvers/webhook.resolver.ts —
// both go through the same delivery service, so behaviour is identical
// whether you drive it via GraphQL or the HTML admin.
//
// URL shape:
//   GET  /portal/admin?tab=webhooks             (list — handled in /admin GET above)
//   GET  /portal/admin/webhooks/new             (create form)
//   GET  /portal/admin/webhooks/:id             (detail + delivery history)
//   POST /portal/admin/webhooks/create
//   POST /portal/admin/webhooks/:id/update
//   POST /portal/admin/webhooks/:id/delete
//   POST /portal/admin/webhooks/:id/rotate-secret
//   POST /portal/admin/webhooks/:id/test
//   POST /portal/admin/webhook-deliveries/:id/retry

/**
 * Load the list-view rows in one round-trip. Prisma's `_count` groups the
 * delivery-status derivation into the query so we don't ship every row
 * back to Node just to categorise.
 */
async function loadWebhookRows(): Promise<AdminWebhookRow[]> {
  const subs = await prisma.webhookSubscription.findMany({
    orderBy: { createdAt: "desc" },
  });
  // For each subscription, count total deliveries and dead-lettered
  // ones (attemptNumber >= MAX_ATTEMPTS && succeededAt == null &&
  // nextRetryAt == null). Two queries per subscription — fine at N < 100.
  return Promise.all(
    subs.map(async (s) => {
      const [total, dead] = await Promise.all([
        prisma.webhookDelivery.count({ where: { subscriptionId: s.id } }),
        prisma.webhookDelivery.count({
          where: {
            subscriptionId: s.id,
            succeededAt: null,
            nextRetryAt: null,
            attemptNumber: { gte: MAX_ATTEMPTS },
          },
        }),
      ]);
      return {
        id: s.id,
        name: s.name,
        targetUrl: s.targetUrl,
        active: s.active,
        eventTypeFilter: s.eventTypeFilter,
        createdAt: s.createdAt,
        deliveryCount: total,
        deadCount: dead,
      };
    }),
  );
}

/**
 * Derive delivery status the same way the GraphQL resolver does. Kept
 * as a plain helper here so we don't have to import from resolvers/
 * (which would tangle admin-panel HTML into GraphQL execution paths).
 */
function deriveDeliveryStatus(row: {
  succeededAt: Date | null;
  nextRetryAt: Date | null;
  attemptNumber: number;
}): "pending" | "succeeded" | "retrying" | "dead" {
  if (row.succeededAt) return "succeeded";
  if (row.attemptNumber >= MAX_ATTEMPTS && !row.nextRetryAt) return "dead";
  if (row.nextRetryAt) return "retrying";
  return "pending";
}

/** URL validation matching the GraphQL resolver's rule: https-only in
 *  the real world, http allowed for localhost so we can test locally. */
function validateTargetUrl(url: string): { ok: true } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "targetUrl must be an absolute URL" };
  }
  if (parsed.protocol === "https:") return { ok: true };
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    error: "targetUrl must use https (http allowed only for localhost)",
  };
}

/** Parse the comma-separated event-type filter input into a clean array
 *  (trimmed, empty entries dropped). Kept case-preserving; GlitchTip's
 *  alias values are lower-case dot-separated. */
function parseEventTypeFilter(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─── GET /admin/webhooks/new ────────────────────────────────────────────

portalRouter.get("/admin/webhooks/new", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  const pendingCount = await prisma.user.count({ where: { role: "pending" } });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderAdminWebhookNew({
      currentUserEmail: admin.email,
      pendingCount,
    }),
  );
});

// ─── GET /admin/webhooks/:id ────────────────────────────────────────────
//
// `?newSecret=<hex>` is respected as the one-shot secret display path
// used by the create + rotate handlers below. We don't check
// authenticity of the query param — the URL is only reachable by an
// authenticated admin, and the value is theirs to see anyway.

portalRouter.get("/admin/webhooks/:id", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const sub = await prisma.webhookSubscription.findUnique({
    where: { id: req.params.id },
  });
  if (!sub) {
    res
      .status(404)
      .redirect(303, "/portal/admin?tab=webhooks&flash=error&msg=Route+not+found");
    return;
  }

  const [deliveryRows, pendingCount] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { subscriptionId: sub.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.user.count({ where: { role: "pending" } }),
  ]);
  const [totalDeliveries, deadDeliveries] = await Promise.all([
    prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } }),
    prisma.webhookDelivery.count({
      where: {
        subscriptionId: sub.id,
        succeededAt: null,
        nextRetryAt: null,
        attemptNumber: { gte: MAX_ATTEMPTS },
      },
    }),
  ]);

  const deliveries: AdminWebhookDelivery[] = deliveryRows.map((d) => ({
    id: d.id,
    eventId: d.eventId,
    eventType: d.eventType,
    attemptNumber: d.attemptNumber,
    responseStatus: d.responseStatus,
    error: d.error,
    succeededAt: d.succeededAt,
    nextRetryAt: d.nextRetryAt,
    createdAt: d.createdAt,
    status: deriveDeliveryStatus(d),
  }));

  const revealedSecret =
    typeof req.query.newSecret === "string" && req.query.newSecret.length > 0
      ? req.query.newSecret
      : null;

  const flashKind = req.query.flash === "success" ? "success" : req.query.flash === "error" ? "error" : null;
  const flashMsg = typeof req.query.msg === "string" ? req.query.msg : "";
  const flash =
    flashKind && flashMsg
      ? { kind: flashKind as "success" | "error", message: flashMsg }
      : null;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    renderAdminWebhookDetail({
      currentUserEmail: admin.email,
      pendingCount,
      subscription: {
        id: sub.id,
        name: sub.name,
        targetUrl: sub.targetUrl,
        active: sub.active,
        eventTypeFilter: sub.eventTypeFilter,
        createdAt: sub.createdAt,
        deliveryCount: totalDeliveries,
        deadCount: deadDeliveries,
        revealedSecret,
        secretPrefix: sub.secret.slice(0, 8),
      },
      deliveries,
      flash,
    }),
  );
});

// ─── POST /admin/webhooks/create ────────────────────────────────────────

portalRouter.post(
  "/admin/webhooks/create",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const admin = await requireAdminSession(req, res);
    if (!admin) return;

    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const targetUrl =
      typeof req.body?.targetUrl === "string" ? req.body.targetUrl.trim() : "";
    const eventTypeFilter = parseEventTypeFilter(
      typeof req.body?.eventTypeFilter === "string" ? req.body.eventTypeFilter : "",
    );
    const active = req.body?.active === "on" || req.body?.active === "true";

    if (!name || !targetUrl) {
      res.redirect(
        303,
        `/portal/admin?tab=webhooks&flash=error&msg=${encodeURIComponent("Name and target URL are required")}`,
      );
      return;
    }
    const urlCheck = validateTargetUrl(targetUrl);
    if (!urlCheck.ok) {
      res.redirect(
        303,
        `/portal/admin?tab=webhooks&flash=error&msg=${encodeURIComponent(urlCheck.error)}`,
      );
      return;
    }

    // Generate the secret ourselves so we can pass the plaintext into
    // the redirect target — Prisma writes it to the row and we hand
    // the same value to the detail page via ?newSecret=.
    const secret = randomBytes(32).toString("hex");
    const created = await prisma.webhookSubscription.create({
      data: {
        name,
        targetUrl,
        secret,
        eventTypeFilter,
        active,
        createdBy: admin.id,
      },
    });
    res.redirect(
      303,
      `/portal/admin/webhooks/${created.id}?newSecret=${encodeURIComponent(secret)}`,
    );
  },
);

// ─── POST /admin/webhooks/:id/update ────────────────────────────────────

portalRouter.post(
  "/admin/webhooks/:id/update",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const admin = await requireAdminSession(req, res);
    if (!admin) return;

    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const targetUrl =
      typeof req.body?.targetUrl === "string" ? req.body.targetUrl.trim() : "";
    const eventTypeFilter = parseEventTypeFilter(
      typeof req.body?.eventTypeFilter === "string" ? req.body.eventTypeFilter : "",
    );
    const active = req.body?.active === "on" || req.body?.active === "true";

    if (!name || !targetUrl) {
      res.redirect(
        303,
        `/portal/admin/webhooks/${req.params.id}?flash=error&msg=${encodeURIComponent("Name and target URL are required")}`,
      );
      return;
    }
    const urlCheck = validateTargetUrl(targetUrl);
    if (!urlCheck.ok) {
      res.redirect(
        303,
        `/portal/admin/webhooks/${req.params.id}?flash=error&msg=${encodeURIComponent(urlCheck.error)}`,
      );
      return;
    }

    try {
      await prisma.webhookSubscription.update({
        where: { id: req.params.id },
        data: { name, targetUrl, eventTypeFilter, active },
      });
      res.redirect(
        303,
        `/portal/admin/webhooks/${req.params.id}?flash=success&msg=${encodeURIComponent("Saved.")}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.redirect(
        303,
        `/portal/admin/webhooks/${req.params.id}?flash=error&msg=${encodeURIComponent(message)}`,
      );
    }
  },
);

// ─── POST /admin/webhooks/:id/delete ────────────────────────────────────

portalRouter.post("/admin/webhooks/:id/delete", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  try {
    // Cascade in the Prisma schema drops the delivery history too.
    const deleted = await prisma.webhookSubscription.delete({
      where: { id: req.params.id },
    });
    res.redirect(
      303,
      `/portal/admin?tab=webhooks&flash=success&msg=${encodeURIComponent(`Deleted "${deleted.name}".`)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.redirect(
      303,
      `/portal/admin?tab=webhooks&flash=error&msg=${encodeURIComponent(message)}`,
    );
  }
});

portalRouter.post("/admin/orgs/teams/members/add", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const teamRole = typeof req.body?.teamRole === "string" ? req.body.teamRole : undefined;

  try {
    if (!orgId || !teamId || !email) throw new Error("Email and team are required.");
    await portalAddTeamMember(orgId, teamId, email, teamRole);
    adminRedirect(res, "organisations", { kind: "success", message: `Added ${email} to the team.` }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

// ─── POST /admin/webhooks/:id/rotate-secret ─────────────────────────────

portalRouter.post("/admin/webhooks/:id/rotate-secret", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  try {
    const secret = randomBytes(32).toString("hex");
    await prisma.webhookSubscription.update({
      where: { id: req.params.id },
      data: { secret },
    });
    res.redirect(
      303,
      `/portal/admin/webhooks/${req.params.id}?newSecret=${encodeURIComponent(secret)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.redirect(
      303,
      `/portal/admin/webhooks/${req.params.id}?flash=error&msg=${encodeURIComponent(message)}`,
    );
  }
});

portalRouter.post("/admin/orgs/teams/members/role", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const teamRole = typeof req.body?.teamRole === "string" ? req.body.teamRole : "";

  try {
    if (!orgId || !teamId || !userId || !teamRole) throw new Error("Missing fields.");
    await portalUpdateTeamMemberRole(orgId, teamId, userId, teamRole);
    adminRedirect(res, "organisations", { kind: "success", message: "Team role updated." }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

portalRouter.post("/admin/orgs/teams/members/remove", urlencoded, async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const orgId = typeof req.body?.orgId === "string" ? req.body.orgId.trim() : "";
  const teamId = typeof req.body?.teamId === "string" ? req.body.teamId.trim() : "";
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";

  try {
    if (!orgId || !teamId || !userId) throw new Error("Missing fields.");
    await portalRemoveTeamMember(orgId, teamId, userId);
    adminRedirect(res, "organisations", { kind: "success", message: "Removed from team." }, orgId);
  } catch (err) {
    adminRedirect(
      res,
      "organisations",
      { kind: "error", message: portalActionError(err) },
      orgId || undefined,
    );
  }
});

// ─── POST /admin/webhooks/:id/test ──────────────────────────────────────

portalRouter.post("/admin/webhooks/:id/test", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const sub = await prisma.webhookSubscription.findUnique({
    where: { id: req.params.id },
  });
  if (!sub) {
    res.redirect(
      303,
      `/portal/admin?tab=webhooks&flash=error&msg=Route+not+found`,
    );
    return;
  }

  // Synthetic payload mimicking GlitchTip's Slack-style alert shape.
  // Kept in sync with the equivalent block in the GraphQL resolver so
  // downstream verifiers see the same test event either way.
  const testPayload = {
    alias: "test.ping",
    text: "Test event from clear-api admin panel",
    issue_id: `test-${Date.now()}`,
    project: "clear-api",
    triggered_by: admin.email,
    timestamp: new Date().toISOString(),
  };
  const delivery = await prisma.webhookDelivery.create({
    data: {
      subscriptionId: sub.id,
      eventId: testPayload.issue_id,
      eventType: testPayload.alias,
      requestBody: testPayload,
    },
  });
  const result = await attemptDelivery(prisma, delivery.id);

  const msg =
    result.status === "succeeded"
      ? `Test delivered (HTTP ${result.responseStatus}).`
      : `Test failed on attempt ${result.attempt} (${result.status}${result.responseStatus !== null ? `, HTTP ${result.responseStatus}` : ""}).`;
  res.redirect(
    303,
    `/portal/admin/webhooks/${req.params.id}?flash=${result.status === "succeeded" ? "success" : "error"}&msg=${encodeURIComponent(msg)}`,
  );
});

// ─── POST /admin/webhook-deliveries/:id/retry ───────────────────────────

portalRouter.post("/admin/webhook-deliveries/:id/retry", async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  const existing = await prisma.webhookDelivery.findUnique({
    where: { id: req.params.id },
    select: { id: true, subscriptionId: true },
  });
  if (!existing) {
    res.redirect(
      303,
      `/portal/admin?tab=webhooks&flash=error&msg=Delivery+not+found`,
    );
    return;
  }

  // Reset the row so the worker's next tick picks it up. Same
  // semantics as the GraphQL `retryWebhookDelivery` mutation — we
  // don't fire inline here because we want the retry to go through
  // the same code path as automated retries (worker → attemptDelivery).
  await prisma.webhookDelivery.update({
    where: { id: existing.id },
    data: {
      attemptNumber: 1,
      nextRetryAt: new Date(),
      succeededAt: null,
      responseStatus: null,
      responseBody: null,
      error: null,
    },
  });
  res.redirect(
    303,
    `/portal/admin/webhooks/${existing.subscriptionId}?flash=success&msg=${encodeURIComponent("Retry scheduled (fires on the next worker tick, within ~15s).")}`,
  );
});
