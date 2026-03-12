import { gql } from "graphql-tag";

export const dataSourceTypeDef = gql`
  """An external data source that feeds detections and alerts into the system."""
  type DataSource {
    id: String!
    name: String!
    """Source type identifier (e.g. satellite, sensor, manual)."""
    type: String!
    isActive: Boolean!
    """Base URL of the data source API."""
    baseUrl: String
    """URL with more information about this source."""
    infoUrl: String
    createdAt: DateTime!
    updatedAt: DateTime!
    """Source detections produced by this data source."""
    sources: [Detection!]!
  }
`;
