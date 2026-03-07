import { gql } from "graphql-tag";

export const alertTypeDef = gql`
  enum AlertStatus {
    draft
    published
    archived
  }

  type Alert {
    id: String!
    title: String!
    description: String!
    severity: Int!
    status: AlertStatus!
    source: DataSource
    createdBy: User
    primaryEvent: Event
    metadata: JSON
    events: [Event!]!
    locations: [AlertLocation!]!
    feedback: [UserAlert!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type UserAlert {
    id: String!
    user: User!
    alert: Alert!
    readAt: DateTime
    rating: Int
    comment: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
