/**
 * `AGENT_DAILY_BUDGET_USD` parsing. Terraform-rendered env files always emit
 * the variable, so an empty value must fall back to the default rather than
 * crash the API on boot, and a negative budget is a misconfiguration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const REQUIRED = {
  DATABASE_URL: "postgresql://localhost/unused",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:4000",
};

async function loadEnv(budget: string | undefined) {
  for (const [key, value] of Object.entries(REQUIRED)) vi.stubEnv(key, value);
  vi.stubEnv("AGENT_DAILY_BUDGET_USD", budget);
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

describe("AGENT_DAILY_BUDGET_USD", () => {
  it("parses a configured amount", async () => {
    expect((await loadEnv("5.5")).AGENT_DAILY_BUDGET_USD).toBe(5.5);
  });

  it("defaults to 2 when unset or empty", async () => {
    expect((await loadEnv(undefined)).AGENT_DAILY_BUDGET_USD).toBe(2);
    expect((await loadEnv("")).AGENT_DAILY_BUDGET_USD).toBe(2);
  });

  it("allows 0, which turns the Agent off for everyone", async () => {
    expect((await loadEnv("0")).AGENT_DAILY_BUDGET_USD).toBe(0);
  });

  it("rejects a negative budget", async () => {
    await expect(loadEnv("-1")).rejects.toThrow();
  });
});
