import { gql } from "graphql-tag";

export const locationTypeDef = gql`
  type Location {
    id: Int!
    geoId: String!
    name: String!
    level: Int!
    parent: Location
    children: [Location!]!
    alertLinks: [AlertLocation!]!
    detectionLinks: [DetectionLocation!]!
  }

  type AlertLocation {
    id: Int!
    alert: Alert!
    location: Location!
    createdAt: DateTime!
  }

  type DetectionLocation {
    id: Int!
    detection: Detection!
    location: Location!
    createdAt: DateTime!
  }
`;
