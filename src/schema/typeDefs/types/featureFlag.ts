import { gql } from "graphql-tag";

export const featureFlagTypeDef = gql`
  """A feature toggle that controls runtime behavior."""
  type FeatureFlag {
    id: Int!
    """Unique key used to look up this flag (e.g. dark_mode)."""
    key: String!
    enabled: Boolean!
    updatedAt: DateTime!
  }
`;
