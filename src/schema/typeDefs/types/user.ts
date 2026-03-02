import { gql } from "graphql-tag";

export const userTypeDef = gql`
  type User {
    id: String!
    email: String!
    name: String!
    emailVerified: Boolean!
    image: String
    role: String!
    isActive: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    createdAlerts: [Alert!]!
    feedback: [UserAlert!]!
  }
`;
