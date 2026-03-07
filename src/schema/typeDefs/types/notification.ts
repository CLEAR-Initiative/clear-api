import { gql } from "graphql-tag";

export const notificationTypeDef = gql`
  enum NotificationStatus {
    PENDING
    DELIVERED
    FAILED
    READ
  }

  type Notification {
    id: String!
    user: User!
    message: String!
    notificationType: String!
    actionUrl: String
    actionText: String
    status: NotificationStatus!
    emailNotificationStatus: NotificationStatus
    smsNotificationStatus: NotificationStatus
    createdAt: DateTime!
    updatedAt: DateTime!
  }
`;
