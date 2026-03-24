import { gql } from "graphql-tag";

export const teamTypeDef = gql`
  """A team within an organisation, scoped to specific locations."""
  type Team {
    id: String!
    name: String!
    """URL-friendly identifier, unique within the organisation."""
    slug: String!
    description: String
    """The organisation this team belongs to."""
    organisation: Organisation!
    """Members of this team."""
    members: [TeamMember!]!
    """Locations this team is scoped to. Empty means global monitoring."""
    locations: [Location!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """Links a user to a team with a team-level role."""
  type TeamMember {
    id: String!
    user: User!
    """Team-level role: lead, analyst, or viewer."""
    role: String!
    createdAt: DateTime!
  }

  input CreateTeamInput {
    organisationId: String!
    name: String!
    slug: String!
    description: String
  }

  input UpdateTeamInput {
    name: String
    slug: String
    description: String
  }
`;
