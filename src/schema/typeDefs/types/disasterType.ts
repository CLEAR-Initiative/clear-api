import { gql } from "graphql-tag";

export const disasterTypeTypeDef = gql`
  """A disaster classification with GLIDE number."""
  type DisasterType {
    id: String!
    disasterType: String!
    disasterClass: String!
    glideNumber: String!
  }
`;
