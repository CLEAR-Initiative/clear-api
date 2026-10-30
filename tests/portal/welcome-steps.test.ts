/**
 * The Welcome page's onboarding steps: one state per step, derived from
 * the account, and at most one "your next step".
 */
import { describe, expect, it } from "vitest";
import { onboardingSteps, type OnboardingProgress } from "../../src/portal/welcome.js";

const fresh: OnboardingProgress = {
  approved: false,
  hasProfile: false,
  hasApiKey: false,
  hasUsedApiKey: false,
};

function states(p: Partial<OnboardingProgress>) {
  return Object.fromEntries(
    onboardingSteps({ ...fresh, ...p }).map((s) => [s.key, s.state]),
  );
}

describe("onboardingSteps", () => {
  it("starts a new sign-up on the profile, with approval waiting on it", () => {
    expect(states({})).toEqual({
      account: "done",
      profile: "current",
      approval: "locked",
      apiKey: "locked",
      firstRequest: "locked",
    });
  });

  it("hands over to the team once the profile is saved", () => {
    const steps = onboardingSteps({ ...fresh, hasProfile: true });
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "waiting", "locked", "locked"]);
    expect(steps.find((s) => s.state === "current")).toBeUndefined();
    expect(steps[2]).toMatchObject({ actor: "team" });
    expect(steps[2]!.detail).toContain("24 hours");
  });

  it("points an approved developer at their first key, then their first request", () => {
    expect(states({ approved: true, hasProfile: true })).toMatchObject({
      approval: "done",
      apiKey: "current",
      firstRequest: "locked",
    });
    expect(states({ approved: true, hasProfile: true, hasApiKey: true })).toMatchObject({
      apiKey: "done",
      firstRequest: "current",
    });
  });

  it("is all done after the first request", () => {
    const steps = onboardingSteps({ approved: true, hasProfile: true, hasApiKey: true, hasUsedApiKey: true });
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });

  it("keeps one next step for an approved account with no profile", () => {
    const steps = onboardingSteps({ ...fresh, approved: true });
    expect(steps.filter((s) => s.state === "current").map((s) => s.key)).toEqual(["profile"]);
    expect(steps.find((s) => s.key === "apiKey")!.state).toBe("todo");
    expect(steps.find((s) => s.key === "profile")!.detail).not.toContain("Required");
  });

  it("only links to actions the developer can take", () => {
    const pending = onboardingSteps(fresh);
    expect(pending.filter((s) => s.action).map((s) => s.key)).toEqual(["profile"]);
    expect(pending[1]!.action!.href).toBe("#about-you");
  });
});
