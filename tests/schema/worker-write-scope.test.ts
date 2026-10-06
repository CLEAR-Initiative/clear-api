/**
 * The `worker` role's write surface, pinned across the whole schema.
 *
 * A Task Worker's key lives in an unattended, prompt-injectable routine
 * (clear-mcp's clear-impact-prior skill), so ADR-0010 confines its writes to
 * the four Task mutations. It still reads content like any approved user.
 * This walks every Mutation field in the executable schema and calls its
 * resolver as a worker: anything outside the four must reject with
 * FORBIDDEN before touching the database. A new mutation gated by bare
 * `requireAuth` / `requireContentReader` fails here — use
 * `requireNonWorker` / `requireNonWorkerContentReader` instead.
 *
 * DB-FREE: `context.prisma` is a proxy that records and throws on any access.
 */
import { makeExecutableSchema } from "@graphql-tools/schema";
import {
  GraphQLError,
  type GraphQLEnumType,
  type GraphQLField,
  type GraphQLInputObjectType,
  type GraphQLInputType,
} from "graphql";
import { describe, expect, it } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";
import type { Context } from "../../src/context.js";

/** The only mutations a worker may reach (ADR-0010). */
const WORKER_MUTATIONS = new Set(["claimTasks", "heartbeatTask", "completeTask", "failTask"]);

/**
 * Mutations that read no identity at all — a worker key grants nothing an
 * anonymous caller doesn't already have. Pinned below as anonymous-callable
 * AND as never reading `context.user` before the database, so one can't
 * quietly start trusting the caller's identity without moving here.
 */
const PUBLIC_MUTATIONS = new Set(["verifyEmail", "requestPasswordReset", "resetPassword", "acceptInvite"]);

/** Content reads the Worker researches its Task with; they stay open. */
const WORKER_READS = [
  "alerts", "alert", "alertsByLocation", "alertsPage",
  "signals", "signal", "signalsByLocation", "signalsPage",
  "events", "event", "eventsByLocation", "eventsPage",
  "crises", "crisis",
  "task", "eventTasks", "eventImpactPriors",
];

const schema = makeExecutableSchema({ typeDefs, resolvers });
const mutationFields = schema.getMutationType()!.getFields();
const queryFields = schema.getQueryType()!.getFields();

class PrismaTouched extends Error {}

/** A Prisma stand-in that records every model/method access and throws. */
function sentinelPrisma(touched: string[]) {
  return new Proxy({}, {
    get(_target, model) {
      return new Proxy(() => undefined, {
        get(_fn, op) {
          return () => {
            touched.push(`${String(model)}.${String(op)}`);
            throw new PrismaTouched(`${String(model)}.${String(op)}`);
          };
        },
        apply() {
          touched.push(String(model));
          throw new PrismaTouched(String(model));
        },
      });
    },
  });
}

/**
 * A plausible value for an argument type: every input field filled in
 * (optional ones too, so e.g. a `teamId` reaches the team-scoped guard),
 * one-element lists, the first enum value. Gets a resolver past arg-shape
 * checks to the auth decision a real caller would hit.
 *
 * Structural checks, not `isNonNullType` & co: @graphql-tools/schema builds
 * the schema with graphql's CJS build, and the ESM predicates reject its
 * types as "from another module or realm".
 */
function placeholder(type: GraphQLInputType, depth = 0): unknown {
  const sdl = String(type);
  if ("ofType" in type && sdl.endsWith("!")) return placeholder(type.ofType, depth);
  if ("ofType" in type) return depth > 4 ? [] : [placeholder(type.ofType, depth + 1)];
  if ("getFields" in type) {
    if (depth > 4) return {};
    return Object.fromEntries(
      Object.values((type as GraphQLInputObjectType).getFields()).map((f) => [f.name, placeholder(f.type, depth + 1)]),
    );
  }
  if ("getValues" in type) return (type as GraphQLEnumType).getValues()[0]!.value;
  switch (sdl) {
    case "Int":
    case "Float":
      return 1;
    case "Boolean":
      return true;
    case "DateTime":
      return new Date("2026-01-01T00:00:00Z");
    case "JSON":
      return {};
    default:
      return "x";
  }
}

const WORKER = { id: "u-worker", role: "worker" };

async function call(field: GraphQLField<unknown, Context>, user: { id: string; role: string } | null) {
  const touched: string[] = [];
  const args = Object.fromEntries(field.args.map((a) => [a.name, placeholder(a.type)]));
  let readIdentity = false;
  const context = {
    prisma: sentinelPrisma(touched),
    session: null,
    authMethod: user ? "api-key" : "none",
    viaAgent: false,
    locale: "en",
  } as unknown as Context;
  // A getter, so a resolver that consults the caller's identity is seen doing so.
  Object.defineProperty(context, "user", {
    enumerable: true,
    get() {
      readIdentity = true;
      return user;
    },
  });
  try {
    await field.resolve!(null, args, context, {} as never);
    return { error: null as unknown, touched, readIdentity };
  } catch (error) {
    return { error, touched, readIdentity };
  }
}

function authCode(error: unknown): string | undefined {
  if (!(error instanceof GraphQLError)) return undefined;
  const code = error.extensions.code;
  return code === "FORBIDDEN" || code === "UNAUTHENTICATED" ? code : undefined;
}

describe("worker role write scope", () => {
  it("every named mutation and read still exists in the schema", () => {
    for (const name of [...WORKER_MUTATIONS, ...PUBLIC_MUTATIONS]) expect(mutationFields).toHaveProperty(name);
    for (const name of WORKER_READS) expect(queryFields).toHaveProperty(name);
  });

  it("every mutation has a resolver", () => {
    const missing = Object.values(mutationFields).filter((f) => !f.resolve).map((f) => f.name);
    expect(missing).toEqual([]);
  });

  const denied = Object.keys(mutationFields).filter(
    (name) => !WORKER_MUTATIONS.has(name) && !PUBLIC_MUTATIONS.has(name),
  );

  it.each(denied)("%s rejects the worker with FORBIDDEN before touching the database", async (name) => {
    const { error, touched } = await call(mutationFields[name]!, WORKER);
    expect(touched).toEqual([]);
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions.code).toBe("FORBIDDEN");
  });

  it.each([...WORKER_MUTATIONS])("%s admits the worker", async (name) => {
    const { error, touched } = await call(mutationFields[name]!, WORKER);
    expect(authCode(error)).toBeUndefined();
    expect(touched.length).toBeGreaterThan(0);
  });

  it.each([...PUBLIC_MUTATIONS])("%s is anonymous-callable and ignores identity, so the worker gains nothing on it", async (name) => {
    const anonymous = await call(mutationFields[name]!, null);
    expect(authCode(anonymous.error)).toBeUndefined();
    expect(anonymous.readIdentity).toBe(false);
    // The worker takes exactly the same path to the database as an anonymous caller.
    const asWorker = await call(mutationFields[name]!, WORKER);
    expect(authCode(asWorker.error)).toBeUndefined();
    expect(asWorker.readIdentity).toBe(false);
    expect(asWorker.touched).toEqual(anonymous.touched);
  });

  // Reaching the database is the evidence the guard let the worker through;
  // what the query returns once there is each resolver's own test's business.
  it.each(WORKER_READS)("query %s admits the worker through to the database", async (name) => {
    const { error, touched } = await call(queryFields[name]!, WORKER);
    expect(authCode(error)).toBeUndefined();
    expect(error).toBeInstanceOf(PrismaTouched);
    expect(touched.length).toBeGreaterThan(0);
  });
});
