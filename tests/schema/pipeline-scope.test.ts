/**
 * The `pipeline` role's surface, pinned across the schema (#430).
 *
 * clear-pipeline runs with a key of the `pipeline` service user, not an
 * admin key. This proves that key can call every operation clear-pipeline
 * sends (the lists below come from a sweep of clear-pipeline's GraphQL), and
 * that it still cannot call the admin-only operations it does not use, or the
 * mutations that record a person's decision (ADR-0024).
 *
 * "Admits" means the guard let the caller through to the database: the
 * sentinel prisma throws on first access, so the resolver's own tests cover
 * what happens next.
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

/** Every mutation and query clear-pipeline sends with CLEAR_API_KEY (sweep, 26 Nov 2026). */
const PIPELINE_MUTATIONS = [
  "archiveStaleAlerts", "createAlert", "createEvent", "createLocation", "createSignal", "enqueueTranslation",
  "escalateEvent", "findOrCreateLandmarkL4", "markAnalysisAutomationsRan", "markAnalysisRequestFailed",
  "markAnalysisRequestGenerated", "markCrisisEnriched", "markGroundMessagesFailed", "markSignalsProcessed",
  "markTranslated", "notifyAlertDigest", "notifyAlertSubscribers", "recordUnresolvedPlaceName",
  "refreshAggregatedDatapoints", "resolveDataSource", "setCrisisNeedsAnalysis", "setEventAggregates",
  "setSignalGlideCode", "syncEventCards", "touchAnalysisSynced", "updateCrisisPopulation", "updateEvent",
  "updateLocation", "updateLocationGeometry", "updateLocationPopulation", "updateSignalContent",
  "updateSignalGeoparsedData", "updateSignalLocation", "updateSignalSeverity", "upsertAnalysis",
  "upsertAnalysisDatapoints", "upsertGroundMessageClassifications", "upsertGroundMessageTranscripts",
  "upsertGroundThreadDrafts", "upsertGroundThreads", "upsertKnowledgebaseChunks", "upsertLocationMetadata",
  "upsertLocationMetadataBatch", "upsertNodeAnalyses", "upsertReportDatapoints", "upsertReportFigures",
  "upsertSituationAnalysis", "upsertTranslations",
];

const PIPELINE_QUERIES = [
  "aggregatedDatapoint", "alert", "alerts", "allLocationMetadata", "analysis", "analysisById", "crisis",
  "dataSources", "disasterTypes", "dueAnalysisAutomations", "entitiesMissingTranslation", "event",
  "eventMembers", "events", "eventsPendingAlert", "frameEvidenceWatermark", "groundMessageForTranslation",
  "groundMessagesForClassification", "groundThreadsForSource", "hasAggregatedDatapoints", "location",
  "locationMetadata", "locations", "pendingAnalyses", "pendingCrises", "pendingRecomputes", "pendingSignals",
  "pendingTranslations", "pipelineCountries", "pipelineGroundSourceIds", "reportDatapoint",
  "reportFiguresPendingKbMerge", "resolveGazetteerLocation", "resolveKnowledgebaseLocation",
  "searchKnowledgebase", "signal", "signals", "signalsByLocation", "situationAnalysis",
  "situationAnalysisById", "translations",
];

/** Named in #430 / #1425: the Nominatim cache, which the gazetteer path uses. */
const ALSO_ADMITTED = ["nominatimCacheEntry", "upsertNominatimCache"];

/** Admin-only operations the pipeline never uses: user approval, roles, other users' keys. */
const ADMIN_ONLY = [
  "approveUser", "updateUserRole", "updateOrgMemberRole", "updateTeamMemberRole",
  "inviteUser", "cancelInvite", "resendInvite", "rotateDevUserApiKey",
  "grantApiSignalSource", "revokeApiSignalSource", "deleteSignal", "deleteEvent", "deleteAlert", "deleteCrisis",
];

/** A person's decision (ADR-0024): never the pipeline's. */
const PERSON_ONLY = [
  "decideSignalLocationChallenge", "submitSignalLocationChallenge", "decideCaseProposal", "reviewGroundThread",
  "createManualSignal", "updateAlert", "updateCrisisTitle", "updateCrisisDescription",
];

const PIPELINE = { id: "u-pipeline", role: "pipeline" };

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
    // `worker` is a service role, so createContext resolves it to full Signal
    // visibility. The signal-access helpers never default a missing scope to
    // full (a fail-open default is the bug that feature prevents), so this
    // fake has to state it or the Signal resolvers throw before reaching the
    // sentinel prisma this test asserts on.
    signalScope: { kind: "full" },
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

const fieldFor = (name: string) => mutationFields[name] ?? queryFields[name];

describe("pipeline role scope", () => {
  it("every named operation still exists in the schema", () => {
    for (const name of [...PIPELINE_MUTATIONS, ...PIPELINE_QUERIES, ...ALSO_ADMITTED, ...ADMIN_ONLY, ...PERSON_ONLY]) {
      expect(fieldFor(name), name).toBeDefined();
    }
  });

  it.each([...PIPELINE_MUTATIONS, ...PIPELINE_QUERIES, ...ALSO_ADMITTED])("%s admits the pipeline role", async (name) => {
    const { error } = await call(fieldFor(name)!, PIPELINE);
    expect(authCode(error), error instanceof Error ? error.message : "").toBeUndefined();
  });

  it.each([...ADMIN_ONLY, ...PERSON_ONLY])("%s refuses the pipeline role without writing", async (name) => {
    const { error, touched } = await call(fieldFor(name)!, PIPELINE);
    expect(touched.filter((t) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw)/.test(t))).toEqual([]);
    // A location-scoped gate may read its target first; the sentinel throws there.
    if (!(error instanceof PrismaTouched)) expect(authCode(error)).toBe("FORBIDDEN");
  });
});
