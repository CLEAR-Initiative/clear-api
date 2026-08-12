import { gql } from "graphql-tag";

export const pipelineCountryTypeDef = gql`
  """A country the CLEAR pipeline publishes a Situation Analysis for, with the
  bounding box used to create its level-0 Country location. bbox order matches
  ensureCountryLocation: [minLng, minLat, maxLng, maxLat]."""
  type PipelineCountry {
    name: String!
    """ISO 3166-1 alpha-3 code (e.g. "SDN"). Used by pipeline ingests that scope
    external APIs by country (HAPI location_code, IOM DTM Admin0Pcode)."""
    iso3: String!
    """The admin-0 location's pcode (ISO 3166-1 alpha-2, e.g. "SD"). The strong,
    name-independent key for resolving the country's level-0 location — the
    stored name is often the long official form, which exact-name lookup misses."""
    pcode: String!
    bbox: [Float!]!
  }
`;
