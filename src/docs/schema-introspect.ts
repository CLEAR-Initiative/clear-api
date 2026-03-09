import {
  type GraphQLSchema,
  type GraphQLField,
  type GraphQLArgument,
  type GraphQLNamedType,
  type GraphQLType,
  isObjectType,
  isEnumType,
  isInputObjectType,
  isNonNullType,
  isListType,
  isScalarType,
} from "graphql";

export interface SchemaField {
  name: string;
  type: string;
  description: string | null;
  args: SchemaArg[];
}

export interface SchemaArg {
  name: string;
  type: string;
  description: string | null;
}

export interface SchemaType {
  name: string;
  kind: "object" | "enum" | "input" | "scalar";
  description: string | null;
  fields: SchemaField[];
  enumValues: { name: string; description: string | null }[];
}

export interface SchemaData {
  queries: SchemaField[];
  mutations: SchemaField[];
  types: SchemaType[];
}

function formatType(type: GraphQLType): string {
  if (isNonNullType(type)) {
    return formatType(type.ofType) + "!";
  }
  if (isListType(type)) {
    return "[" + formatType(type.ofType) + "]";
  }
  return (type as GraphQLNamedType).name;
}

function extractArgs(args: readonly GraphQLArgument[]): SchemaArg[] {
  return args.map((arg) => ({
    name: arg.name,
    type: formatType(arg.type),
    description: arg.description ?? null,
  }));
}

function extractField(
  field: GraphQLField<unknown, unknown>,
): SchemaField {
  return {
    name: field.name,
    type: formatType(field.type),
    description: field.description ?? null,
    args: extractArgs(field.args),
  };
}

const BUILT_IN_TYPES = new Set([
  "String",
  "Int",
  "Float",
  "Boolean",
  "ID",
  "Query",
  "Mutation",
  "Subscription",
  "__Schema",
  "__Type",
  "__Field",
  "__InputValue",
  "__EnumValue",
  "__Directive",
  "__DirectiveLocation",
]);

export function introspectSchema(schema: GraphQLSchema): SchemaData {
  const queryType = schema.getQueryType();
  const mutationType = schema.getMutationType();

  const queries: SchemaField[] = [];
  if (queryType) {
    const fields = queryType.getFields();
    for (const name of Object.keys(fields)) {
      queries.push(extractField(fields[name]));
    }
  }

  const mutations: SchemaField[] = [];
  if (mutationType) {
    const fields = mutationType.getFields();
    for (const name of Object.keys(fields)) {
      mutations.push(extractField(fields[name]));
    }
  }

  const types: SchemaType[] = [];
  const typeMap = schema.getTypeMap();
  for (const [name, type] of Object.entries(typeMap)) {
    if (BUILT_IN_TYPES.has(name) || name.startsWith("__")) continue;

    if (isObjectType(type)) {
      const fields = type.getFields();
      types.push({
        name,
        kind: "object",
        description: type.description ?? null,
        fields: Object.values(fields).map(extractField),
        enumValues: [],
      });
    } else if (isEnumType(type)) {
      types.push({
        name,
        kind: "enum",
        description: type.description ?? null,
        fields: [],
        enumValues: type.getValues().map((v) => ({
          name: v.name,
          description: v.description ?? null,
        })),
      });
    } else if (isInputObjectType(type)) {
      const fields = type.getFields();
      types.push({
        name,
        kind: "input",
        description: type.description ?? null,
        fields: Object.values(fields).map((f) => ({
          name: f.name,
          type: formatType(f.type),
          description: f.description ?? null,
          args: [],
        })),
        enumValues: [],
      });
    } else if (isScalarType(type)) {
      types.push({
        name,
        kind: "scalar",
        description: type.description ?? null,
        fields: [],
        enumValues: [],
      });
    }
  }

  // Sort types: scalars, enums, inputs, then objects alphabetically
  const kindOrder = { scalar: 0, enum: 1, input: 2, object: 3 };
  types.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name),
  );

  return { queries, mutations, types };
}
