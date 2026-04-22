import { gql } from "graphql-tag";

export const disasterTypeTypeDef = gql`
  """A disaster classification in a 3-level hierarchy (level1 > level2 > level3).
  Events store arrays of codes (GLIDE or CLEAR IDs)."""
  type DisasterType {
    id: String!
    """Level-3 granular sub-type (e.g. "peaceful protest")."""
    disasterType: String!
    """Level-1 category (legacy — same as level1)."""
    disasterClass: String!
    """Classification code — may be a GLIDE number or a CLEAR id."""
    glideNumber: String!
    """Top-level category (e.g. "natural hazard", "conflict")."""
    level1: String!
    """Mid-level group (e.g. "protests", "battles")."""
    level2: String!
    """Identifier system: "glide_number" or "clear_id"."""
    idType: String!
  }

  """A level-2 group with its distinct classification codes."""
  type DisasterLevel2 {
    name: String!
    """Classification codes belonging to this level-2 group (usually one)."""
    codes: [String!]!
    """Level-3 sub-types under this level-2 group."""
    subTypes: [DisasterType!]!
  }

  """A level-1 category with its level-2 groups."""
  type DisasterLevel1 {
    name: String!
    groups: [DisasterLevel2!]!
  }
`;
