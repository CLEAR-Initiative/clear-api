/**
 * The Welcome page profile against the real schema: first submit creates
 * the row (and is the only one reported as first), later submits update
 * it, the name lands on `user`, and deleting the user removes the profile.
 * Self-seeding; run with `bun run test:db`.
 */
import { afterAll, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { saveDeveloperProfile } from "../../src/services/developer-profile.js";
import { describeIfDb } from "../helpers/db.js";

const RUN = `devprofile-db-${Date.now()}`;
const USER = `${RUN}-user`;

const details = {
  personalWebsite: null,
  organisation: "NRC",
  organisationWebsite: "https://www.nrc.no/",
  linkedinUrl: null,
  githubUrl: "https://github.com/ada",
  contributionInterest: "Data pipeline",
};

describeIfDb("developerProfile against the real schema", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
  });

  it("creates once, then updates, and renames the user", async () => {
    await prisma.user.create({
      data: { id: USER, name: "Ada", email: `${RUN}@example.org`, role: "pending" },
    });

    const first = await saveDeveloperProfile(prisma, USER, { name: "Ada Lovelace", ...details });
    expect(first).toEqual({ firstSubmission: true });

    const second = await saveDeveloperProfile(prisma, USER, {
      name: "Ada Lovelace",
      ...details,
      organisation: "NRC Norway",
      githubUrl: null,
    });
    expect(second).toEqual({ firstSubmission: false });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: USER },
      select: { name: true, developerProfile: true },
    });
    expect(row.name).toBe("Ada Lovelace");
    expect(row.developerProfile).toMatchObject({
      organisation: "NRC Norway",
      githubUrl: null,
      contributionInterest: "Data pipeline",
    });
  });

  it("goes away with the user", async () => {
    await prisma.user.delete({ where: { id: USER } });
    expect(await prisma.developerProfile.count({ where: { userId: USER } })).toBe(0);
  });
});
