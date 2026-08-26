import { gql } from "graphql-tag";

export const userTypeDef = gql`
  """A registered user with role-based access.

  PII fields (\`email\`, \`phoneNumber\`, \`role\`, \`isActive\`) and the
  private relation set (\`alerts\`, \`notifications\`, \`organisations\`,
  \`teamMemberships\`, \`feedbacks\`, \`comments\`, \`escalations\`) are
  gated server-side:
    - PII: returned when caller IS the user, is a global admin, OR
      shares at least one organisation with the user. Otherwise null
      (PII) or empty array (private relations).
    - Private relations: returned only when caller IS the user OR is
      a global admin. Sharing an organisation does NOT grant access
      to another member's inbox / comment history.

  Schema makes these fields nullable so the gate can return null when
  the caller is not authorised, instead of throwing — a logged-in
  analyst browsing an event's comments shouldn't see a hard error on
  the commenter's email."""
  type User {
    id: String!
    email: String
    name: String!
    emailVerified: Boolean!
    phoneNumber: String
    image: String
    """User role: viewer, analyst, admin, or pending. Null when caller is not
    authorised to see this user's role."""
    role: String
    """Null when caller is not authorised to see this field."""
    isActive: Boolean
    """Preferred UI language code (BCP-47 / ISO 639-1, e.g. "en", "ar"). Defaults to "en"."""
    language: String!
    enableInAppNotification: Boolean!
    enableEmailNotification: Boolean!
    enableSMSNotification: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """Alerts received by this user. Empty for non-self / non-admin
    callers."""
    alerts: [UserAlert!]!
    """Empty for non-self / non-admin callers."""
    notifications: [Notification!]!
    """The user's default team (last selected). Null for non-self /
    non-admin callers."""
    defaultTeam: Team
    """Empty for non-self / non-admin callers."""
    organisations: [OrganisationUser!]!
    """Empty for non-self / non-admin callers."""
    teamMemberships: [TeamMember!]!
    """Empty for non-self / non-admin callers."""
    feedbacks: [UserFeedback!]!
    """Empty for non-self / non-admin callers."""
    comments: [UserComment!]!
    """Empty for non-self / non-admin callers."""
    escalations: [EventEscalation!]!
  }

  """Assignable global platform roles. \`pending\` is not in this
  enum — those users must go through \`approveUser\` first."""
  enum GlobalRole {
    viewer
    analyst
    admin
  }

  """Links a user to an organisation with a role."""
  type OrganisationUser {
    id: String!
    userId: String!
    organisationId: String!
    role: String!
  }
`;
