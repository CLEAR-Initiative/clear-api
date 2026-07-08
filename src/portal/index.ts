import { Router, type Request, type Response } from "express";
import express from "express";
import { GraphQLError } from "graphql";
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
import { fetchNewsletterSubscriberCount } from "../services/buttondown.js";
import { env } from "../utils/env.js";
import {
  renderPortal,
  renderLoginPage,
  renderAdminPending,
  renderAdminMetrics,
  renderAdminOrganisations,
  renderAdminOrgDetail,
  renderWaitingForApproval,
  type AdminPendingUser,
  type AdminMetrics,
  type AdminTab,
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

// ─── GET /portal — three-way render based on role ────────────────────────

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
  if (raw === "pending" || raw === "organisations") return raw;
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
    adminRedirect(res, "pending", { kind: "error", message: "Missing userId" });
    return;
  }

  try {
    const result = await approveUserById(prisma, admin.id, userId);
    const detail = result.crmMoved
      ? "Approved and synced to CRM."
      : result.crmWarnings.length > 0
        ? `Approved locally. CRM sync issues: ${result.crmWarnings.join(", ")}`
        : "Approved locally.";
    adminRedirect(res, "pending", {
      kind: "success",
      message: `${result.user.email}: ${detail}`,
    });
  } catch (err) {
    const message =
      err instanceof GraphQLError ? err.message : portalActionError(err);
    adminRedirect(res, "pending", { kind: "error", message });
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
