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
    """Population residing within this location's geometry. Null for point locations or when not yet computed."""
    population: String
    """Provenance of this location's geometry. Notable values:
      - 'landmark-geocoded': L4 created by the pipeline geoparser from a
        landmark/place name resolved via Nominatim. The location's \`name\`
        field is meaningful for display (e.g., 'Nyala Airport').
      - 'gps' / 'source-gps' / 'centroid' / 'source-centroid': see schema
        documentation on the Prisma model.
      - null: legacy rows (most signal-title L4s from \`createPointLocation\`)."""
    pointType: String
    """Per-type metadata (IOM DTM, INFORM, etc). Pass a type argument to filter.
    By default only the current value is returned (validTo is null).
    Pass current: false to include the full history."""
    metadata(type: String, current: Boolean): [LocationMetadata!]!
    """When the row was first created."""
    createdAt: DateTime!
    """Last write — useful for tracking admin polygon (re-)loads."""
    updatedAt: DateTime!
  }

  """Input for findOrCreateLandmarkL4. Drives geoparser-based L4 promotion
  in the signal-ingestion pipeline."""
  input FindOrCreateLandmarkL4Input {
    """Display name to use when creating a new L4 (e.g., 'Nyala Airport').
    Reuse for kind='landmark' is keyed on a case-insensitive match of this
    field within the candidate's containing A2."""
    name: String!
    """Candidate latitude (from the geocoder)."""
    lat: Float!
    """Candidate longitude (from the geocoder)."""
    lng: Float!
    """'landmark' or 'admin'. Drives the reuse strategy: landmarks reuse by
    exact name, admins reuse by proximity (≤100m) within the same A2."""
    kind: String!
    """Source coordinate's latitude. When provided, the resolver verifies the
    candidate's A2 matches the source's A2 — a mismatch aborts the promotion."""
    sourceLat: Float
    """Source coordinate's longitude. See sourceLat."""
    sourceLng: Float
  }

  """Outcome of findOrCreateLandmarkL4."""
  type FindOrCreateLandmarkL4Result {
    """The resolved L4 id. Null when the same-A2 safety check aborts."""
    locationId: String
    """True when the call resolved to an existing L4, false when a new one
    was created. Meaningless when locationId is null."""
    reused: Boolean!
    """Provenance tag of the resolved L4 ('landmark-geocoded', 'gps', etc).
    Null when the call aborted without producing a row."""
    pointType: String
    """Set to 'different_a2' when the candidate and source coords resolve to
    different containing A2s. Null on success."""
    abortedReason: String
  }
`;
