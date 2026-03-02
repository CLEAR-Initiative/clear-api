import { gql } from "graphql-tag";

export const featureFlagTypeDef = gql`
  type FeatureFlag {
    id: Int!
    key: String!
    enabled: Boolean!
    updatedAt: DateTime!
  }
`;
