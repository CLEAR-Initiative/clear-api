/**
 * The scratch-database guard that keeps DB tests off real databases. Pure
 * functions over an env map, so no DB or process mutation is needed.
 */

import { describe, it, expect } from "vitest";
import {
  parseDbName,
  isScratchDatabase,
  assertSafeTestDatabase,
} from "./test-guards.js";

const TUNNEL = "postgresql://clear:pw@127.0.0.1:15432/clear";
const SCRATCH = "postgresql://postgres:test@localhost:55432/clear_test";

describe("parseDbName", () => {
  it("pulls the database name, dropping query params", () => {
    expect(parseDbName(TUNNEL)).toBe("clear");
    expect(parseDbName(SCRATCH)).toBe("clear_test");
    expect(parseDbName("postgresql://h/clear_test?schema=public")).toBe("clear_test");
    expect(parseDbName(undefined)).toBe("");
  });
});

describe("isScratchDatabase", () => {
  it("accepts the test-db.sh shape and any *_test name", () => {
    expect(isScratchDatabase(SCRATCH, {})).toBe(true);
    expect(isScratchDatabase("postgresql://h/myapp_test", {})).toBe(true);
  });
  it("accepts any DB when SCRATCH_DB=1 (explicit disposable override)", () => {
    expect(isScratchDatabase(TUNNEL, { SCRATCH_DB: "1" })).toBe(true);
  });
  it("rejects a real database name", () => {
    expect(isScratchDatabase(TUNNEL, {})).toBe(false);
    expect(isScratchDatabase("postgresql://h/clear", {})).toBe(false);
  });
});

describe("assertSafeTestDatabase", () => {
  it("throws for a real DB when DB tests would run", () => {
    expect(() => assertSafeTestDatabase({ DATABASE_URL: TUNNEL })).toThrow(
      /Refusing to run DB-backed tests/,
    );
  });
  it("does not throw when DB tests are skipped", () => {
    expect(() =>
      assertSafeTestDatabase({ DATABASE_URL: TUNNEL, SKIP_DB_TESTS: "1" }),
    ).not.toThrow();
  });
  it("does not throw against a scratch DB", () => {
    expect(() => assertSafeTestDatabase({ DATABASE_URL: SCRATCH })).not.toThrow();
  });
  it("does not throw when SCRATCH_DB=1", () => {
    expect(() =>
      assertSafeTestDatabase({ DATABASE_URL: TUNNEL, SCRATCH_DB: "1" }),
    ).not.toThrow();
  });
});
