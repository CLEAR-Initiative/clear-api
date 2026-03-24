import { gql } from "graphql-tag";

export const locationTypeDef = gql`
  """A geographic location in a hierarchy (country > state > city, etc.)."""
  type Location {
    id: String!
    """GeoNames identifier."""
    geoId: Int
    """OpenStreetMap identifier."""
    osmId: String
    """P-Code identifier."""
    pCode: String
    name: String!
    """Hierarchy level: 0 = country, 1 = state/province, 2 = city, etc."""
    level: Int!
    """Geometry as GeoJSON (Point or MultiPolygon)."""
    geometry: GeoJSON
    """Parent location in the hierarchy."""
    parent: Location
    """Child locations one level below."""
    children: [Location!]!
    """IDs of all ancestor locations (parent, grandparent, etc.)."""
    ancestorIds: [String!]!
    """All ancestor locations (parent, grandparent, etc.)."""
    ancestors: [Location!]!
  }
`;
