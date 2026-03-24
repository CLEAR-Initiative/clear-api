import { gql } from "graphql-tag";

export const invitationTypeDef = gql`
  """Status of an invitation."""
  enum InvitationStatus {
    pending
    accepted
    expired
  }

  """An invitation to join an organisation (and optionally a team)."""
  type Invitation {
    id: String!
    email: String!
    organisation: Organisation!
    team: Team
    """Organisation role assigned on acceptance."""
    role: String!
    """Team role assigned on acceptance (if team specified)."""
    teamRole: String
    expiresAt: DateTime!
    acceptedAt: DateTime
    invitedBy: User!
    createdAt: DateTime!
    """Computed from acceptedAt and expiresAt."""
    status: InvitationStatus!
  }

  """Public invitation info returned by token lookup (limited fields)."""
  type InvitationInfo {
    id: String!
    email: String!
    organisationName: String!
    teamName: String
    role: String!
    teamRole: String
    expiresAt: DateTime!
    status: InvitationStatus!
  }
`;
