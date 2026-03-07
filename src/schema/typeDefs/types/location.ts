import { gql } from "graphql-tag";

export const locationTypeDef = gql`
  type Location {
    id: String!
    geoId: String!
    name: String!
    level: Int!
    parent: Location
    children: [Location!]!
    alertLinks: [AlertLocation!]!
    detectionLinks: [DetectionLocation!]!
  }

  type AlertLocation {
    id: String!
    alert: Alert!
    location: Location!
    createdAt: DateTime!
  }

  type DetectionLocation {
    id: String!
    detection: Detection!
    location: Location!
    createdAt: DateTime!
  }
`;
