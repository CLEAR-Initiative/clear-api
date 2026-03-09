import { gql } from "graphql-tag";

export const scalarTypeDef = gql`
  """ISO 8601 date-time string (e.g. 2024-01-15T09:30:00.000Z)."""
  scalar DateTime

  """Arbitrary JSON value — objects, arrays, strings, numbers, booleans, or null."""
  scalar JSON
  scalar GeoJSON
`;
