/**
 * The Signal visibility policy for API-only developers.
 *
 * API-only = a `member` holding a live API key who belongs to no organisation
 * and no team. They read NO Signals until an admin grants data sources. The
 * closed-by-default behaviour is the security property here, so it is asserted
 * directly rather than only through a resolver.
 */
import { describe, expect, it } from "vitest";
import {
  resolveSignalScope,
  signalScopeWhere,
  withSignalScope,
  canReadSignal,
  assertSignalReadable,
  FULL_SIGNAL_SCOPE,
} from "../../src/utils/signal-access.js";

type Counts = { keys: number; orgs: number; teams: number; grants: string[] };

function fakePrisma({ keys, orgs, teams, grants }: Counts) {
  return {
    apiKeys: { count: async () => keys },
    organisationUsers: { count: async () => orgs },
    teamMembers: { count: async () => teams },
    apiSignalSourceGrant: {
      findMany: async () => grants.map((dataSourceId) => ({ dataSourceId })),
    },
  } as never;
}

const member = { id: "u1", role: "member" } as never;

describe("resolveSignalScope", () => {
  it("restricts an API-only developer to their granted sources", async () => {
    const scope = await resolveSignalScope(
      fakePrisma({ keys: 1, orgs: 0, teams: 0, grants: ["src-acled"] }),
      member,
    );
    expect(scope).toEqual({ kind: "restricted", sourceIds: ["src-acled"] });
  });

  it("gives an API-only developer with no grants an EMPTY source list, not full access", async () => {
    const scope = await resolveSignalScope(
      fakePrisma({ keys: 1, orgs: 0, teams: 0, grants: [] }),
      member,
    );
    expect(scope).toEqual({ kind: "restricted", sourceIds: [] });
    // The whole point: an empty grant list must match no rows.
    expect(signalScopeWhere(scope)).toEqual({ sourceId: { in: [] } });
  });

  it("treats an org member as an app user even if they hold an API key", async () => {
    const scope = await resolveSignalScope(
      fakePrisma({ keys: 1, orgs: 1, teams: 0, grants: [] }),
      member,
    );
    expect(scope).toEqual(FULL_SIGNAL_SCOPE);
  });

  it("treats a team member with no org row as an app user (fails safe on data drift)", async () => {
    const scope = await resolveSignalScope(
      fakePrisma({ keys: 1, orgs: 0, teams: 1, grants: [] }),
      member,
    );
    expect(scope).toEqual(FULL_SIGNAL_SCOPE);
  });

  it("does not restrict a member who holds no API key", async () => {
    const scope = await resolveSignalScope(
      fakePrisma({ keys: 0, orgs: 0, teams: 0, grants: [] }),
      member,
    );
    expect(scope).toEqual(FULL_SIGNAL_SCOPE);
  });

  it.each(["admin", "pipeline", "agent", "worker"])(
    "never restricts the %s role",
    async (role) => {
      const scope = await resolveSignalScope(
        fakePrisma({ keys: 1, orgs: 0, teams: 0, grants: [] }),
        { id: "u1", role } as never,
      );
      expect(scope).toEqual(FULL_SIGNAL_SCOPE);
    },
  );
});

describe("signalScopeWhere", () => {
  it("adds no filter for full scope", () => {
    expect(signalScopeWhere(FULL_SIGNAL_SCOPE)).toEqual({});
  });

  it("filters by granted source ids", () => {
    expect(signalScopeWhere({ kind: "restricted", sourceIds: ["a", "b"] })).toEqual({
      sourceId: { in: ["a", "b"] },
    });
  });
});

describe("withSignalScope", () => {
  const restricted = { kind: "restricted", sourceIds: ["granted"] } as const;

  it("returns the filter untouched under full scope", () => {
    expect(withSignalScope(FULL_SIGNAL_SCOPE, { isDummy: false })).toEqual({ isDummy: false });
  });

  it("ANDs rather than merges, so a sibling sourceId cannot erase the scope", () => {
    // Regression: spreading the scope over a filter that already had `sourceId`
    // (DataSource.signals' parent id, or a caller-supplied source filter on
    // signalsPage) let one silently overwrite the other — in the signalsPage
    // case letting a caller widen their own access.
    expect(withSignalScope(restricted, { sourceId: "other" })).toEqual({
      AND: [{ sourceId: "other" }, { sourceId: { in: ["granted"] } }],
    });
  });

  it("still constrains an empty filter", () => {
    expect(withSignalScope(restricted, {})).toEqual({
      AND: [{}, { sourceId: { in: ["granted"] } }],
    });
  });
});

describe("canReadSignal", () => {
  const restricted = { kind: "restricted", sourceIds: ["a"] } as const;

  it("allows a granted source", () => {
    expect(canReadSignal(restricted, { sourceId: "a" })).toBe(true);
  });
  it("denies an ungranted source", () => {
    expect(canReadSignal(restricted, { sourceId: "b" })).toBe(false);
  });
  it("denies a missing signal rather than throwing", () => {
    expect(canReadSignal(restricted, null)).toBe(false);
  });
  it("allows anything under full scope", () => {
    expect(canReadSignal(FULL_SIGNAL_SCOPE, { sourceId: "whatever" })).toBe(true);
  });
});

describe("assertSignalReadable", () => {
  it("throws for a restricted caller with no grants", () => {
    expect(() => assertSignalReadable({ kind: "restricted", sourceIds: [] })).toThrowError(
      /does not include Signals/,
    );
  });
  it("passes for a restricted caller with at least one grant", () => {
    expect(() => assertSignalReadable({ kind: "restricted", sourceIds: ["a"] })).not.toThrow();
  });
  it("passes for full scope", () => {
    expect(() => assertSignalReadable(FULL_SIGNAL_SCOPE)).not.toThrow();
  });
});
