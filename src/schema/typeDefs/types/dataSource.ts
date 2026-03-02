import { gql } from "graphql-tag";

export const dataSourceTypeDef = gql`
  type DataSource {
    id: Int!
    name: String!
    type: String!
    isActive: Boolean!
    baseUrl: String
    infoUrl: String
    createdAt: DateTime!
    updatedAt: DateTime!
    detections: [Detection!]!
    alerts: [Alert!]!
  }
`;
