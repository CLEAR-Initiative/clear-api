import { gql } from "graphql-tag";

export const userTypeDef = gql`
  type User {
    id: String!
    email: String!
    name: String!
    emailVerified: Boolean!
    phoneNumber: String
    image: String
    role: String!
    isActive: Boolean!
    enableInAppNotification: Boolean!
    enableEmailNotification: Boolean!
    enableSMSNotification: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    createdAlerts: [Alert!]!
    feedback: [UserAlert!]!
    notifications: [Notification!]!
  }
`;
