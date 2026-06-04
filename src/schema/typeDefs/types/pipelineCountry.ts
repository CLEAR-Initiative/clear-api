import { gql } from "graphql-tag";

export const pipelineCountryTypeDef = gql`
  """A country the CLEAR pipeline publishes a Situation Analysis for, with the
  bounding box used to create its level-0 Country location. bbox order matches
  ensureCountryLocation: [minLng, minLat, maxLng, maxLat]."""
  type PipelineCountry {
    name: String!
    bbox: [Float!]!
  }
`;
