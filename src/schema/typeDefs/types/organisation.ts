import { gql } from "graphql-tag";

export const organisationTypeDef = gql`
  """An organisation that owns teams and has members."""
  type Organisation {
    id: String!
    name: String!
    """URL-friendly identifier."""
    slug: String!
    """Whether this organisation is active. Inactive organisations are hidden from non-admin users."""
    isActive: Boolean!
    """When this organisation was created."""
    createdAt: DateTime!
    """When this organisation was last updated."""
    updatedAt: DateTime!
    """Teams belonging to this organisation."""
    teams: [Team!]!
    """Members of this organisation."""
    members: [OrgMember!]!
  }

  """Links a user to an organisation with an org-level role."""
  type OrgMember {
    id: String!
    user: User!
    """Organisation-level role: owner, admin, or member."""
    role: String!
    """When this membership was created."""
    createdAt: DateTime!
  }

  """Role within an organisation."""
  enum OrgMemberRole {
    owner
    admin
    member
  }

  """Role within a team."""
  enum TeamMemberRole {
    lead
    analyst
    viewer
  }

  """Fields for creating a new organisation."""
  input CreateOrganisationInput {
    """Display name for the organisation."""
    name: String!
    """URL-friendly identifier. Must be unique."""
    slug: String!
  }

  """Fields for updating an existing organisation."""
  input UpdateOrganisationInput {
    """New display name."""
    name: String
    """New URL-friendly identifier."""
    slug: String
    """Set active/inactive status."""
    isActive: Boolean
  }
`;
