import { gql } from "graphql-tag";

export const invitationTypeDef = gql`
  """Status of an invitation."""
  enum InvitationStatus {
    pending
    accepted
    expired
  }

  """One (team, role) assignment attached to an invitation."""
  type InvitationTeam {
    team: Team!
    teamRole: TeamMemberRole!
  }

  """An invitation to join an organisation, with one or more team assignments."""
  type Invitation {
    id: String!
    email: String!
    organisation: Organisation!
    """Single team — legacy field, populated only for invitations created
    before the multi-team join existed. New invitations use \`teams\`."""
    team: Team
    """Organisation role assigned on acceptance."""
    role: String!
    """Legacy single-team role. Use \`teams\` for new invitations."""
    teamRole: String
    """Team assignments granted to the invitee on acceptance. Empty list
    means org-only access (no team)."""
    teams: [InvitationTeam!]!
    expiresAt: DateTime!
    acceptedAt: DateTime
    invitedBy: User!
    createdAt: DateTime!
    """Computed from acceptedAt and expiresAt."""
    status: InvitationStatus!
  }

  """One (team, role) assignment as returned by the public token lookup."""
  type InvitationInfoTeam {
    teamId: String!
    teamName: String!
    teamRole: TeamMemberRole!
  }

  """Public invitation info returned by token lookup (limited fields)."""
  type InvitationInfo {
    id: String!
    email: String!
    organisationName: String!
    """Legacy single-team name (populated only for old invitations)."""
    teamName: String
    role: String!
    """Legacy single-team role (populated only for old invitations)."""
    teamRole: String
    """Team assignments the invitee will be granted on acceptance."""
    teams: [InvitationInfoTeam!]!
    expiresAt: DateTime!
    status: InvitationStatus!
  }
`;
