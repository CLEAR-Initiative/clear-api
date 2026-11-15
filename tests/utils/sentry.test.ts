/**
 * Unit tests for `sentryApolloPlugin` and its helpers in `src/utils/sentry.ts`.
 *
 * DB-free. `@sentry/node` and the logger are mocked; a real ApolloServer runs
 * the plugin through `executeOperation`, so parsing, validation and execution
 * errors reach it the way they do in production.
 *
 * Covered:
 *  - a parse or validation failure is logged, not reported
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
  isClientDocumentError,
  operationNameOf,
  sentryApolloPlugin,
} from "../../src/utils/sentry.js";
import type { Context } from "../../src/context.js";

const typeDefs = /* GraphQL */ `
  type Query {
    ok: Boolean
    boom: Boolean
  }
`;
const resolvers = {
  Query: {
    ok: () => true,
    boom: () => {
      throw new Error("resolver blew up");
    },
  },
};

type Caller = Pick<Context, "user" | "authMethod" | "viaAgent">;

const apiKeyUser = {
  user: { id: "user_123", email: "dev@example.org", role: "viewer" },
  authMethod: "api-key",
  viaAgent: false,
} as unknown as Caller;

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
    expect(message).toMatch(/client document error/);
    expect(fields).toMatchObject({
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
    await run("{ boom }", { user: null, authMethod: null, viaAgent: false } as Caller);

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

describe("isClientDocumentError", () => {
  it("matches parse and validation codes only", () => {
    const withCode = (code: string) => new GraphQLError("x", { extensions: { code } });
    expect(isClientDocumentError(withCode("GRAPHQL_VALIDATION_FAILED"))).toBe(true);
    expect(isClientDocumentError(withCode("GRAPHQL_PARSE_FAILED"))).toBe(true);
    expect(isClientDocumentError(withCode("FORBIDDEN"))).toBe(false);
    expect(isClientDocumentError(new Error("plain"))).toBe(false);
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
