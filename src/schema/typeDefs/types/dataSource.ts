import { gql } from "graphql-tag";

export const dataSourceTypeDef = gql`
  """An external data source that feeds signals into the system."""
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
    """Alias set for source-name normalisation — variants that resolve to this
    same source (e.g. "IOM DTM" / "Displacement Tracking Matrix" / "DTM")."""
    synonyms: [String!]!
    """NATO Admiralty-style source-reliability grade, 1 (least) – 4 (most).
    Null = ungraded; the data-quality formula treats null as 1. See clear-context-pipeline ADR-0004."""
    reliability: Int
    createdAt: DateTime!
    updatedAt: DateTime!
    """Signals collected from this data source."""
    signals: [Signal!]!
  }
`;
