import { gql } from "graphql-tag";

export const queryTypeDef = gql`
  type Query {
    hello: String!
  }
`;
