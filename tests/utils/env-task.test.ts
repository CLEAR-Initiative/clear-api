/**
 * Task queue env parsing (ADR-0010): `TASK_LEASE_MINUTES`,
 * `TASK_MAX_ATTEMPTS`, `TASK_CLAIM_MAX`, `TASK_REQUEST_DAILY_CAP`.
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

const TASK_VARS = [
  "TASK_LEASE_MINUTES",
  "TASK_MAX_ATTEMPTS",
  "TASK_CLAIM_MAX",
  "TASK_REQUEST_DAILY_CAP",
] as const;

async function loadEnv(values: Partial<Record<(typeof TASK_VARS)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(REQUIRED)) vi.stubEnv(key, value);
  for (const key of TASK_VARS) vi.stubEnv(key, values[key]);
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
