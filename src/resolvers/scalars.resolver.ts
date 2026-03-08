import { GraphQLScalarType, Kind } from "graphql";

export const scalarResolvers = {
  DateTime: new GraphQLScalarType({
    name: "DateTime",
    description: "ISO 8601 date-time string",
    serialize(value: unknown): string {
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "string") return value;
      throw new Error("DateTime must be a Date or string");
    },
    parseValue(value: unknown): Date {
      if (typeof value === "string") return new Date(value);
      throw new Error("DateTime must be a string");
    },
    parseLiteral(ast): Date {
      if (ast.kind === Kind.STRING) return new Date(ast.value);
      throw new Error("DateTime must be a string");
    },
  }),
  GeoJSON: new GraphQLScalarType({
    name: "GeoJSON",
    description: "GeoJSON object (RFC 7946)",
    serialize(value: unknown): unknown {
      return value;
    },
    parseValue(value: unknown): unknown {
      return value;
    },
    parseLiteral(ast): unknown {
      if (ast.kind === Kind.STRING) return JSON.parse(ast.value);
      return null;
    },
  }),
  JSON: new GraphQLScalarType({
    name: "JSON",
    description: "Arbitrary JSON value",
    serialize(value: unknown): unknown {
      return value;
    },
    parseValue(value: unknown): unknown {
      return value;
    },
    parseLiteral(ast): unknown {
      if (ast.kind === Kind.STRING) return JSON.parse(ast.value);
      if (ast.kind === Kind.INT) return parseInt(ast.value, 10);
      if (ast.kind === Kind.FLOAT) return parseFloat(ast.value);
      if (ast.kind === Kind.BOOLEAN) return ast.value;
      if (ast.kind === Kind.NULL) return null;
      return null;
    },
  }),
};
