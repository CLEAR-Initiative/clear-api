import { gql } from "graphql-tag";

export const locationMetadataTypeDef = gql`
  """Arbitrary per-location metadata keyed by type.
  Each (location, type) pair is unique — writes upsert."""
  type LocationMetadata {
    id: String!
    location: Location!
    """Free-form type string (e.g. "iom_dtm_displacement", "acaps_inform")."""
    type: String!
    """Source-specific payload stored as JSON."""
    data: JSON!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input UpsertLocationMetadataInput {
    locationId: String!
    """Type string (e.g. "iom_dtm_displacement")."""
    type: String!
    """JSON payload for this type."""
    data: JSON!
  }
`;
