import { gql } from "graphql-tag";

export const userTypeDef = gql`
  """A registered user with role-based access."""
  type User {
    id: String!
    email: String!
    name: String!
    emailVerified: Boolean!
    phoneNumber: String
    image: String
    """User role: viewer, editor, or admin."""
    role: String!
    isActive: Boolean!
    enableInAppNotification: Boolean!
    enableEmailNotification: Boolean!
    enableSMSNotification: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """Alerts received by this user."""
    alerts: [UserAlert!]!
    notifications: [Notification!]!
    """Organisations this user belongs to."""
    organisations: [OrganisationUser!]!
    """Feedback given by this user."""
    feedbacks: [UserFeedback!]!
    """Comments made by this user."""
    comments: [UserComment!]!
    """Events/alerts escalated by this user."""
    escalations: [EventEscalation!]!
  }

  """Links a user to an organisation with a role."""
  type OrganisationUser {
    id: String!
    userId: String!
    organisationId: String!
    role: String!
  }
`;
