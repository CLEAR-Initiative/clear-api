/**
 * Dev helper: create a pending org invite and print the accept-invite URL.
 * Usage: npx tsx scripts/dev-onboarding-invite.ts [email]
 */
import "dotenv/config";
import { randomBytes } from "crypto";
import { prisma } from "../src/lib/prisma.js";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

async function main() {
  const email =
    process.argv[2] ?? `onboarding-test+${Date.now()}@clear.dev`;

  const org = await prisma.organisations.findFirst({
    where: { teams: { some: {} } },
    include: { teams: { take: 1, orderBy: { name: "asc" } } },
  });
  if (!org?.teams[0]) {
    throw new Error("No organisation with teams found in database");
  }

  const admin = await prisma.user.findFirst({
    where: { role: "admin" },
    select: { id: true, email: true },
  });
  if (!admin) {
    throw new Error("No global admin user found");
  }

  const team = org.teams[0];

  const existing = await prisma.invitations.findFirst({
    where: {
      email,
      organisationId: org.id,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (existing) {
    const url = `http://localhost:3000/accept-invite?token=${existing.token}`;
    console.log("Existing pending invite found:");
    console.log(`  email: ${existing.email}`);
    console.log(`  role: ${existing.role}`);
    console.log(`  org: ${org.name}`);
    console.log(`  team: ${team.name}`);
    console.log(`  url: ${url}`);
    return;
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.invitations.create({
    data: {
      email,
      organisationId: org.id,
      role: "member",
      token,
      expiresAt,
      invitedById: admin.id,
      teams: {
        create: [{ teamId: team.id, teamRole: "team_member" }],
      },
    },
  });

  const url = `http://localhost:3000/accept-invite?token=${token}`;
  console.log("Created onboarding test invite:");
  console.log(`  email: ${email}`);
  console.log(`  password: (set on accept-invite page, min 8 chars)`);
  console.log(`  org role: member (not admin)`);
  console.log(`  team role: team_member`);
  console.log(`  org: ${org.name}`);
  console.log(`  team: ${team.name}`);
  console.log(`  url: ${url}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
