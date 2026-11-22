/**
 * Unit tests for `sentryApolloPlugin` and its helpers in `src/utils/sentry.ts`.
 *
 * DB-free. `@sentry/node` and the logger are mocked; a real ApolloServer runs
 * the plugin through `executeOperation`, so parsing, validation and execution
 * errors reach it the way they do in production.
 *
 * Covered:
 *  - an expected client error is logged with its code, not reported: a parse
 *    or validation failure (introspection while disabled included), a request
 *    with no query, and an auth guard's refusal
 *  - an error with no code, or a code that is not a client's, is reported
 *  - the operation name comes from the document when the body omits it
 *  - a resolver error is reported with the caller's id, role, auth method,
 *    agent flag and User-Agent, and never the email
 *  - an anonymous caller is reported without a user
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { ApolloServer, HeaderMap } from "@apollo/server";
import { GraphQLError, parse } from "graphql";

const { captureException, warn } = vi.hoisted(() => {
  // sentry.ts reads SENTRY_DSN at import time.
  process.env.SENTRY_DSN = "https://public@glitchtip.invalid/1";
  return { captureException: vi.fn(), warn: vi.fn() };
});

vi.mock("@sentry/node", () => ({ init: vi.fn(), captureException }));
vi.mock("../../src/utils/logger.js", () => ({ createLogger: () => ({ warn }) }));

import {
  describeCaller,
  expectedClientErrorCode,
  operationNameOf,
  sentryApolloPlugin,
} from "../../src/utils/sentry.js";
import { requireAuth, requireContentReader } from "../../src/utils/auth-guard.js";
import type { Context } from "../../src/context.js";

const typeDefs = /* GraphQL */ `
  type Query {
    ok: Boolean
    boom: Boolean
    dbDown: Boolean
    me: Boolean
    events: Boolean
  }
`;
const resolvers = {
  Query: {
    ok: () => true,
    boom: () => {
      throw new Error("resolver blew up");
    },
    dbDown: () => {
      throw new GraphQLError("timeout exceeded when trying to connect");
    },
    // The real guards, so the codes they throw are the ones filtered.
    me: (_: unknown, __: unknown, context: Context) => Boolean(requireAuth(context)),
    events: (_: unknown, __: unknown, context: Context) => Boolean(requireContentReader(context)),
  },
};

type Caller = Pick<Context, "user" | "authMethod" | "viaAgent">;

const apiKeyUser = {
  user: { id: "user_123", email: "dev@example.org", role: "viewer" },
  authMethod: "api-key",
  viaAgent: false,
} as unknown as Caller;

const anonymous = { user: null, authMethod: null, viaAgent: false } as Caller;

let server: ApolloServer<Context>;

beforeAll(async () => {
  server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [sentryApolloPlugin] });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  captureException.mockClear();
  warn.mockClear();
});

function run(query: string, caller: Caller, opts: { operationName?: string; userAgent?: string } = {}) {
  const headers = new HeaderMap();
  if (opts.userAgent) headers.set("user-agent", opts.userAgent);
  return server.executeOperation(
    {
      query,
      operationName: opts.operationName,
      http: { method: "POST", headers, search: "", body: {} },
    },
    { contextValue: caller as Context },
  );
}

describe("sentryApolloPlugin", () => {
  it("logs a validation failure instead of reporting it, with the document's operation name", async () => {
    await run(
      "query EventsDailyCounts($input: EventsDailyCountsInput!) { eventsDailyCounts(input: $input) { day count } }",
      apiKeyUser,
      { userAgent: "my-script/1.0" },
    );

    expect(captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    const [fields, message] = warn.mock.calls[0]!;
    expect(message).toMatch(/expected client error/);
    expect(fields).toMatchObject({
      code: "GRAPHQL_VALIDATION_FAILED",
      operation: "EventsDailyCounts",
      userId: "user_123",
      auth_method: "api-key",
      client: "my-script/1.0",
    });
  });

  it("logs a parse failure instead of reporting it", async () => {
    await run("{ ok", apiKeyUser);

    expect(captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ code: "GRAPHQL_PARSE_FAILED" });
  });

  it("logs an introspection query instead of reporting it when introspection is disabled", async () => {
    const closed = new ApolloServer<Context>({
      typeDefs,
      resolvers,
      introspection: false,
      plugins: [sentryApolloPlugin],
    });
    await closed.start();
    try {
      await closed.executeOperation(
        { query: "{ __schema { types { name } } }" },
        { contextValue: apiKeyUser as Context },
      );
    } finally {
      await closed.stop();
    }

    expect(captureException).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toMatchObject({ code: "GRAPHQL_VALIDATION_FAILED" });
  });

  it("logs a request with no query instead of reporting it", async () => {
    await run("", apiKeyUser);

    expect(captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({ code: "BAD_REQUEST", userId: "user_123" });
    expect(message).toMatch(/non-empty `query`/);
  });

  it("logs an unauthenticated request instead of reporting it", async () => {
    await run("query Me { me }", anonymous);

    expect(captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({ code: "UNAUTHENTICATED", operation: "Me", auth_method: "none" });
    expect(message).toMatch(/You must be logged in/);
  });

  it("logs a pending account's refusal instead of reporting it", async () => {
    await run("query Events { events }", {
      ...apiKeyUser,
      user: { id: "user_456", email: "new@example.org", role: "pending" },
    } as unknown as Caller);

    expect(captureException).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toMatchObject({ code: "FORBIDDEN", operation: "Events", userId: "user_456" });
    expect(message).toMatch(/awaiting admin approval/);
  });

  it("reports only the unexpected error when a request has both kinds", async () => {
    await run("{ me boom }", anonymous);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![0].message).toBe("resolver blew up");
  });

  it("reports a GraphQLError that has no code, with the query text", async () => {
    await run("query Db { dbDown }", apiKeyUser);

    expect(warn).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, hint] = captureException.mock.calls[0]!;
    expect(err.message).toBe("timeout exceeded when trying to connect");
    expect(hint.extra).toEqual({ query: "query Db { dbDown }" });
  });

  it("reports a resolver error with who called, and no email", async () => {
    await run("query Boom { boom }", apiKeyUser, { userAgent: "my-script/1.0" });

    expect(warn).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    const [, hint] = captureException.mock.calls[0]!;
    expect(hint).toEqual({
      user: { id: "user_123" },
      tags: {
        graphql_operation: "Boom",
        auth_method: "api-key",
        via_agent: "no",
        user_role: "viewer",
        client: "my-script/1.0",
      },
      extra: { query: "query Boom { boom }" },
    });
    expect(JSON.stringify(hint)).not.toContain("dev@example.org");
  });

  it("reports an anonymous caller without a user", async () => {
    await run("{ boom }", anonymous);

    const [, hint] = captureException.mock.calls[0]!;
    expect(hint.user).toBeUndefined();
    expect(hint.tags).toMatchObject({ graphql_operation: "anonymous", auth_method: "none" });
  });
});

describe("operationNameOf", () => {
  it("prefers the name the request gave", () => {
    expect(operationNameOf("Given", parse("query Other { ok }"))).toBe("Given");
  });

  it("reads the name from a single-operation document", () => {
    expect(operationNameOf(undefined, parse("query Named { ok }"))).toBe("Named");
  });

  it("is anonymous for an unnamed operation, no document, or several operations", () => {
    expect(operationNameOf(undefined, parse("{ ok }"))).toBe("anonymous");
    expect(operationNameOf(null, undefined)).toBe("anonymous");
    expect(operationNameOf(undefined, parse("query A { ok } query B { ok }"))).toBe("anonymous");
  });
});

describe("expectedClientErrorCode", () => {
  const withCode = (code: string) => new GraphQLError("x", { extensions: { code } });

  it.each([
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "BAD_REQUEST",
    "GRAPHQL_PARSE_FAILED",
    "GRAPHQL_VALIDATION_FAILED",
    "OPERATION_RESOLUTION_FAILURE",
    "BAD_USER_INPUT",
    "PERSISTED_QUERY_NOT_FOUND",
    "PERSISTED_QUERY_NOT_SUPPORTED",
  ])("returns %s: the caller's error", (code) => {
    expect(expectedClientErrorCode(withCode(code))).toBe(code);
  });

  it.each(["INTERNAL_SERVER_ERROR", "NOT_FOUND", "CONFLICT", "RATE_LIMITED"])(
    "returns undefined for %s, so it is reported",
    (code) => {
      expect(expectedClientErrorCode(withCode(code))).toBeUndefined();
    },
  );

  it("returns undefined for an error with no code", () => {
    expect(expectedClientErrorCode(new GraphQLError("timeout exceeded when trying to connect"))).toBeUndefined();
    expect(expectedClientErrorCode(new Error("plain"))).toBeUndefined();
    expect(expectedClientErrorCode(null)).toBeUndefined();
  });

  it("reads the code, not the message", () => {
    expect(expectedClientErrorCode(new GraphQLError("Insufficient permissions"))).toBeUndefined();
    expect(
      expectedClientErrorCode(new GraphQLError("x", { extensions: { code: 403 } })),
    ).toBeUndefined();
  });
});

describe("describeCaller", () => {
  it("caps the User-Agent at 200 characters", () => {
    const { tags } = describeCaller(undefined, "a".repeat(500));
    expect(tags.client).toHaveLength(200);
  });

  it("flags requests that came through the CLEAR Agent", () => {
    const { tags } = describeCaller({ ...apiKeyUser, viaAgent: true }, undefined);
    expect(tags.via_agent).toBe("yes");
  });
});
