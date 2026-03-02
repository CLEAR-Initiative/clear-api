import { gql } from "graphql-tag";

export const alertTypeDef = gql`
  enum AlertStatus {
    draft
    published
    archived
  }

  type Alert {
    id: Int!
    title: String!
    description: String!
    severity: Int!
    status: AlertStatus!
    source: DataSource
    createdBy: User
    primaryDetection: Detection
    metadata: JSON
    detections: [Detection!]!
    locations: [AlertLocation!]!
    feedback: [UserAlert!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type UserAlert {
    id: Int!
    user: User!
    alert: Alert!
    readAt: DateTime
    rating: Int
    comment: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
