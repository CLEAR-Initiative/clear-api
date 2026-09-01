/**
 * Schema contract: the operator app's Users-tab role dropdown has
 * nowhere to write unless this mutation exists. A missing field here
 * is the "API null path" that left confirm handlers updating only
 * React state.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const mutation = readFileSync(
  join(here, "../../src/schema/typeDefs/mutation.ts"),
  "utf8",
);

describe("updateUserRole schema contract", () => {
  it("exposes updateUserRole next to approveUser", () => {
    expect(mutation).toMatch(/approveUser\(userId: String!\): ApproveUserResult!/);
    expect(mutation).toMatch(
      /updateUserRole\(userId: String!, role: GlobalRole!\): User!/,
    );
  });
});
