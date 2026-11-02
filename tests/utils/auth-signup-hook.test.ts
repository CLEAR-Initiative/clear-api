/**
 * The Better Auth `user.create.after` hook in src/lib/auth.ts. Only a
 * Developer Portal self-signup (`/sign-up/email`) gets the sign-up side
 * effects. Invite acceptance creates users through the internal adapter,
 * which hands the hook no endpoint context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { onDeveloperSignedUpMock } = vi.hoisted(() => ({
  onDeveloperSignedUpMock: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/services/signup.js", () => ({
  onDeveloperSignedUp: onDeveloperSignedUpMock,
}));

const { auth } = await import("../../src/lib/auth.js");
const afterUserCreate = auth.options.databaseHooks!.user!.create!.after!;

const user = {
  id: "u1",
  email: "new@example.org",
  name: "New Person",
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

type HookContext = Parameters<typeof afterUserCreate>[1];

describe("user.create.after", () => {
  beforeEach(() => onDeveloperSignedUpMock.mockReset());

  it("runs the Developer sign-up side effects for a portal self-signup", async () => {
    await afterUserCreate(user, { path: "/sign-up/email" } as HookContext);
    expect(onDeveloperSignedUpMock).toHaveBeenCalledWith(user);
  });

  it("skips them for a user created by invite acceptance (no endpoint context)", async () => {
    await afterUserCreate(user, null);
    expect(onDeveloperSignedUpMock).not.toHaveBeenCalled();
  });
});
