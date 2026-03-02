import { gql } from "graphql-tag";

export const userTypeDef = gql`
  enum UserRole {
    admin
    analyst
    viewer
  }

  type User {
    id: Int!
    email: String!
    name: String
    role: UserRole!
    isActive: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    accounts: [Account!]!
    sessions: [Session!]!
    createdAlerts: [Alert!]!
    feedback: [UserAlert!]!
  }

  type Account {
    id: Int!
    user: User!
    provider: String!
    providerAccountId: String!
    accessToken: String
    refreshToken: String
    expiresAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Session {
    id: Int!
    user: User!
    tokenHash: String!
    expiresAt: DateTime!
    createdAt: DateTime!
  }
`;
