import { gql } from "graphql-tag";

export const exampleTypeDef = gql`
  type Example {
    id: ID!
    name: String!
  }
`;
