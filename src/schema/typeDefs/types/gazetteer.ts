import { gql } from "graphql-tag";

/**
 * GeoNames gazetteer — the offline first tier of the hybrid geo-resolver.
 * The signal geoparser resolves a place name against this before falling
 * back to LocationIQ/Nominatim for landmarks/POIs the gazetteer lacks.
 */
export const gazetteerTypeDef = gql`
  """A GeoNames gazetteer match for a place name. Coordinates come straight
  from GeoNames — callers still validate them (e.g. the same-A2 check
  against a signal's source coordinates) before trusting a fuzzy hit."""
  type GazetteerHit {
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
  }
`;
