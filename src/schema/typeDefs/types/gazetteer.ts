import { gql } from "graphql-tag";

/**
 * GeoNames gazetteer — the offline first tier of the hybrid geo-resolver.
 * The signal geoparser resolves a place name against this before falling
 * back to LocationIQ/Nominatim for landmarks/POIs the gazetteer lacks.
 */
export const gazetteerTypeDef = gql`
  """Where a gazetteer answer came from."""
  enum GazetteerSource {
    """One of CLEAR's own place aliases. \`locationId\` is set."""
    ALIAS
    """The GeoNames copy."""
    GEONAMES
  }

  """A gazetteer match for a place name: one of CLEAR's own place aliases, or
  a GeoNames row. GeoNames coordinates come straight from GeoNames, so callers
  still validate them (e.g. the same-A2 check against a signal's source
  coordinates) before trusting a fuzzy hit."""
  type GazetteerHit {
    """The GeoNames id. 0 for an alias whose location has none."""
    geonamesId: Int!
    name: String!
    latitude: Float!
    longitude: Float!
    """GeoNames feature class: A=admin area, P=populated place, H=hydro,
    L=area, S=spot/POI, T=terrain, … The resolver prefers P/A."""
    featureClass: String
    featureCode: String
    """ISO-3166-1 alpha-2 (SD, VE, AF)."""
    countryCode: String!
    population: Float!
    """Match confidence 0–1: 1.0 for an exact normalised-name hit, else the
    pg_trgm similarity of the best fuzzy match."""
    score: Float!
    """True when matched exactly on the normalised name, false when fuzzy."""
    exact: Boolean!
    """The CLEAR location an alias points at. Null for a GeoNames match. Use
    it as the Signal's location directly: do not create a new landmark."""
    locationId: String
    source: GazetteerSource!
  }
`;
