import { gql } from "graphql-tag";

export const organisationTypeDef = gql`
  """An organisation that owns teams and has members."""
  type Organisation {
    id: String!
    name: String!
    """URL-friendly identifier."""
    slug: String!
    isActive: Boolean!
    createdAt: DateTime!
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
    createdAt: DateTime!
  }

  input CreateOrganisationInput {
    name: String!
    slug: String!
  }

  input UpdateOrganisationInput {
    name: String
    slug: String
    isActive: Boolean
  }
`;
