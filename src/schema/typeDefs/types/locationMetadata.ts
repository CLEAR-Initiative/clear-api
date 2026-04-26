import { gql } from "graphql-tag";

export const locationMetadataTypeDef = gql`
  """Arbitrary per-location metadata keyed by type. History is preserved:
  writes close the current row (set validTo = now()) and insert a new one.
  The CURRENT value for a (location, type) is the row where validTo is null."""
  type LocationMetadata {
    id: String!
    location: Location!
    """Free-form type string (e.g. "iom_dtm_displacement", "acaps_inform")."""
    type: String!
    """Source-specific payload stored as JSON."""
    data: JSON!
    """When this value became current."""
    validFrom: DateTime!
    """When this value was superseded. Null means still current."""
    validTo: DateTime
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
