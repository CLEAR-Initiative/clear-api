/**
 * `signals.raw_data` is WRITE-ONLY across the whole GraphQL surface.
 *
 * The column holds each source's verbatim payload: provider ids, internal
 * metadata, free text, and for WhatsApp/hotline-promoted Signals the message
 * body. Nothing reads it back through the API — the pipeline already holds the
 * payload it wrote, and `rawS3Key` points at the bronze blob for anything that
 * needs the original.
 *
 * That makes this the cheapest possible control: the field simply does not
 * exist on any output type. The risk is a future convenience change ("just
 * expose rawData on Signal") handing every reader the raw payload at once, so
 * this test walks the built schema and fails on exactly that.
 *
 * INPUT types are allowed and expected: createSignal / updateSignalContent /
 * the ingest routes all take rawData. Writing it is the point.
 */
import { makeExecutableSchema } from "@graphql-tools/schema";
import { describe, expect, it } from "vitest";
import { typeDefs } from "../../src/schema/index.js";
import { resolvers } from "../../src/resolvers/index.js";

const FORBIDDEN = /^(rawData|raw_data)$/;

const schema = makeExecutableSchema({
  typeDefs,
  resolvers: resolvers as Parameters<typeof makeExecutableSchema>[0]["resolvers"],
});

/**
 * Classify by `astNode.kind` rather than graphql's `isObjectType` helpers.
 * Those do instanceof checks, which throw "Cannot use GraphQLObjectType from
 * another module or realm" when more than one copy of `graphql` is installed —
 * the same reason worker-write-scope.test.ts imports only types from it.
 */
type Named = { name: string; astNode?: { kind: string }; getFields?: () => object };

function typesOfKind(...kinds: string[]): Named[] {
  return (Object.values(schema.getTypeMap()) as Named[]).filter(
    (t) => !t.name.startsWith("__") && t.astNode != null && kinds.includes(t.astNode.kind),
  );
}

function fieldsWithRawData(types: Named[]): string[] {
  const hits: string[] = [];
  for (const t of types) {
    for (const field of Object.keys(t.getFields?.() ?? {})) {
      if (FORBIDDEN.test(field)) hits.push(`${t.name}.${field}`);
    }
  }
  return hits;
}

describe("signals.raw_data is never readable through GraphQL", () => {
  it("no output type exposes a rawData field", () => {
    const offenders = fieldsWithRawData(
      typesOfKind("ObjectTypeDefinition", "InterfaceTypeDefinition"),
    );
    // If this fails, someone added a read path for the verbatim source payload.
    // Gate it to the `pipeline` role (or drop it) rather than deleting this test.
    expect(offenders).toEqual([]);
  });

  it("still allows rawData on INPUT types — writing it is the point", () => {
    const inputs = fieldsWithRawData(typesOfKind("InputObjectTypeDefinition"));
    // Guards the guard: if this empties, the walk above is probably inspecting
    // nothing and would pass vacuously.
    expect(inputs.length).toBeGreaterThan(0);
  });
});
