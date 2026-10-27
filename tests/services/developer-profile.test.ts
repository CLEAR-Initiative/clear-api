import { describe, expect, it, vi } from "vitest";
import {
  PROFILE_LIMITS,
  normaliseProfileUrl,
  parseProfileForm,
  saveDeveloperProfile,
  type ProfileFormValues,
} from "../../src/services/developer-profile.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

describe("normaliseProfileUrl", () => {
  it("treats empty as not set", () => {
    expect(normaliseProfileUrl("")).toEqual({ ok: true, value: null });
  });

  it("accepts http and https", () => {
    expect(normaliseProfileUrl("https://example.org/ada")).toEqual({
      ok: true,
      value: "https://example.org/ada",
    });
    expect(normaliseProfileUrl("http://example.org")).toEqual({
      ok: true,
      value: "http://example.org/",
    });
  });

  it("puts https:// in front of a bare host", () => {
    expect(normaliseProfileUrl("github.com/ada")).toEqual({
      ok: true,
      value: "https://github.com/ada",
    });
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.org/file",
    "not a url",
    "localhost",
  ])("rejects %s", (raw) => {
    expect(normaliseProfileUrl(raw).ok).toBe(false);
  });

  it("rejects URLs over the length limit", () => {
    const long = `https://example.org/${"a".repeat(PROFILE_LIMITS.url)}`;
    expect(normaliseProfileUrl(long).ok).toBe(false);
  });
});

describe("parseProfileForm", () => {
  it("trims everything and turns empty optionals into null", () => {
    const r = parseProfileForm({
      name: "  Ada Lovelace  ",
      organisation: "  NRC ",
      githubUrl: " https://github.com/ada ",
      personalWebsite: "   ",
      contributionInterest: "  data pipeline\n",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        name: "Ada Lovelace",
        organisation: "NRC",
        githubUrl: "https://github.com/ada",
        personalWebsite: null,
        organisationWebsite: null,
        linkedinUrl: null,
        contributionInterest: "data pipeline",
      },
    });
  });

  it("requires a name", () => {
    const r = parseProfileForm({ name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBeDefined();
  });

  it("rejects a non-http(s) URL and keeps what was typed for re-display", () => {
    const r = parseProfileForm({ name: "Ada", linkedinUrl: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.linkedinUrl).toMatch(/http/);
      expect(r.values.linkedinUrl).toBe("javascript:alert(1)");
      expect(r.errors.name).toBeUndefined();
    }
  });

  it("enforces length limits on free text", () => {
    const r = parseProfileForm({
      name: "x".repeat(PROFILE_LIMITS.name + 1),
      organisation: "o".repeat(PROFILE_LIMITS.organisation + 1),
      contributionInterest: "c".repeat(PROFILE_LIMITS.contributionInterest + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ["contributionInterest", "name", "organisation"].sort(),
      );
    }
  });

  it("ignores non-string body values", () => {
    const r = parseProfileForm({ name: ["a", "b"], githubUrl: { x: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.values.githubUrl).toBe("");
  });
});

const input: ProfileFormValues = {
  name: "Ada",
  personalWebsite: null,
  organisation: "NRC",
  organisationWebsite: null,
  linkedinUrl: null,
  githubUrl: "https://github.com/ada",
  contributionInterest: "docs",
};

function fakePrisma(opts: { existing: boolean; createError?: unknown }) {
  const prisma = {
    user: { update: vi.fn().mockResolvedValue({}) },
    developerProfile: {
      findUnique: vi.fn().mockResolvedValue(opts.existing ? { id: "p1" } : null),
      create: opts.createError
        ? vi.fn().mockRejectedValue(opts.createError)
        : vi.fn().mockResolvedValue({ id: "p1" }),
      update: vi.fn().mockResolvedValue({ id: "p1" }),
    },
  };
  return prisma;
}

describe("saveDeveloperProfile", () => {
  it("creates the profile on first submit and renames the user", async () => {
    const prisma = fakePrisma({ existing: false });
    const r = await saveDeveloperProfile(prisma as unknown as PrismaClient, "u1", input);
    expect(r).toEqual({ firstSubmission: true });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: expect.objectContaining({ name: "Ada" }) }),
    );
    expect(prisma.developerProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", organisation: "NRC" }),
    });
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it("updates on later submits", async () => {
    const prisma = fakePrisma({ existing: true });
    const r = await saveDeveloperProfile(prisma as unknown as PrismaClient, "u1", input);
    expect(r).toEqual({ firstSubmission: false });
    expect(prisma.developerProfile.create).not.toHaveBeenCalled();
    expect(prisma.developerProfile.update).toHaveBeenCalled();
  });

  it("treats losing a create race as a later submit", async () => {
    const prisma = fakePrisma({ existing: false, createError: { code: "P2002" } });
    const r = await saveDeveloperProfile(prisma as unknown as PrismaClient, "u1", input);
    expect(r).toEqual({ firstSubmission: false });
    expect(prisma.developerProfile.update).toHaveBeenCalled();
  });

  it("rethrows other create errors", async () => {
    const prisma = fakePrisma({ existing: false, createError: new Error("db down") });
    await expect(
      saveDeveloperProfile(prisma as unknown as PrismaClient, "u1", input),
    ).rejects.toThrow("db down");
  });
});
