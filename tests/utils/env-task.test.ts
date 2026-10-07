/**
 * Task queue env parsing (ADR-0010): `TASK_LEASE_MINUTES`,
 * `TASK_MAX_ATTEMPTS`, `TASK_CLAIM_MAX`, `TASK_REQUEST_DAILY_CAP`, and the
 * fan-out list `TASK_IMPACT_PRIOR_KINDS`.
 * Terraform-rendered env files always emit the variable, so an empty value
 * must fall back to the default rather than crash the API on boot; zero or a
 * negative value is a misconfiguration (a zero cap would reject every
 * request and a zero lease would hand every claim straight back).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const REQUIRED = {
  DATABASE_URL: "postgresql://localhost/unused",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:4000",
};

/** The numeric ones, which share the positive-integer rule. */
const TASK_VARS = [
  "TASK_LEASE_MINUTES",
  "TASK_MAX_ATTEMPTS",
  "TASK_CLAIM_MAX",
  "TASK_REQUEST_DAILY_CAP",
] as const;
const ALL_VARS = [...TASK_VARS, "TASK_IMPACT_PRIOR_KINDS"] as const;

async function loadEnv(values: Partial<Record<(typeof ALL_VARS)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(REQUIRED)) vi.stubEnv(key, value);
  for (const key of ALL_VARS) vi.stubEnv(key, values[key]);
  vi.resetModules();
  return (await import("../../src/utils/env.js")).env;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Task queue env", () => {
  it("defaults to a 15-minute lease, 3 attempts, 10 per claim and 20 requests a day", async () => {
    const env = await loadEnv({});
    expect(env.TASK_LEASE_MINUTES).toBe(15);
    expect(env.TASK_MAX_ATTEMPTS).toBe(3);
    expect(env.TASK_CLAIM_MAX).toBe(10);
    expect(env.TASK_REQUEST_DAILY_CAP).toBe(20);
  });

  it("treats an empty value as unset", async () => {
    const env = await loadEnv({
      TASK_LEASE_MINUTES: "",
      TASK_MAX_ATTEMPTS: "",
      TASK_CLAIM_MAX: "",
      TASK_REQUEST_DAILY_CAP: "",
    });
    expect(env.TASK_LEASE_MINUTES).toBe(15);
    expect(env.TASK_REQUEST_DAILY_CAP).toBe(20);
  });

  it("parses configured values", async () => {
    const env = await loadEnv({
      TASK_LEASE_MINUTES: "30",
      TASK_MAX_ATTEMPTS: "5",
      TASK_CLAIM_MAX: "25",
      TASK_REQUEST_DAILY_CAP: "100",
    });
    expect(env.TASK_LEASE_MINUTES).toBe(30);
    expect(env.TASK_MAX_ATTEMPTS).toBe(5);
    expect(env.TASK_CLAIM_MAX).toBe(25);
    expect(env.TASK_REQUEST_DAILY_CAP).toBe(100);
  });

  it.each(TASK_VARS)("rejects zero, negative and fractional %s", async (key) => {
    await expect(loadEnv({ [key]: "0" })).rejects.toThrow();
    await expect(loadEnv({ [key]: "-1" })).rejects.toThrow();
    await expect(loadEnv({ [key]: "1.5" })).rejects.toThrow();
  });
});

describe("TASK_IMPACT_PRIOR_KINDS — the source kinds one request fans out into", () => {
  it("defaults to the CLEAR-data and web kinds, in that order", async () => {
    const env = await loadEnv({});
    expect(env.TASK_IMPACT_PRIOR_KINDS).toEqual(["event.impact_prior.clear", "event.impact_prior.web"]);
  });

  it("treats an empty value as unset", async () => {
    const env = await loadEnv({ TASK_IMPACT_PRIOR_KINDS: "" });
    expect(env.TASK_IMPACT_PRIOR_KINDS).toEqual(["event.impact_prior.clear", "event.impact_prior.web"]);
  });

  it("parses a comma-separated list, keeping order, trimming, dropping blanks and duplicates", async () => {
    const env = await loadEnv({
      TASK_IMPACT_PRIOR_KINDS: " event.impact_prior.web, ,event.impact_prior.clear,event.impact_prior.web ",
    });
    expect(env.TASK_IMPACT_PRIOR_KINDS).toEqual(["event.impact_prior.web", "event.impact_prior.clear"]);
  });

  it("accepts a single kind, including the bare pre-fan-out one", async () => {
    expect((await loadEnv({ TASK_IMPACT_PRIOR_KINDS: "event.impact_prior.clear" })).TASK_IMPACT_PRIOR_KINDS).toEqual([
      "event.impact_prior.clear",
    ]);
    expect((await loadEnv({ TASK_IMPACT_PRIOR_KINDS: "event.impact_prior" })).TASK_IMPACT_PRIOR_KINDS).toEqual([
      "event.impact_prior",
    ]);
  });

  it.each([
    ["a kind outside the family", "event.something_else"],
    ["a trailing dot", "event.impact_prior."],
    ["an upper-case source", "event.impact_prior.Web"],
    ["a source with a dash", "event.impact_prior.web-search"],
    ["a list that is all separators", ", ,"],
  ])("rejects %s", async (_name, value) => {
    await expect(loadEnv({ TASK_IMPACT_PRIOR_KINDS: value })).rejects.toThrow();
  });
});
