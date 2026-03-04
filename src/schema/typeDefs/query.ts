import { gql } from "graphql-tag";

export const queryTypeDef = gql`
  type Query {
    # Auth
    me: User

    # Users
    users: [User!]!
    user(id: String!): User

    # Alerts
    alerts(status: AlertStatus): [Alert!]!
    alert(id: Int!): Alert

    # Detections
    detections(status: DetectionStatus): [Detection!]!
    detection(id: Int!): Detection

    # Data Sources
    dataSources: [DataSource!]!
    dataSource(id: Int!): DataSource

    # Locations
    locations(level: Int): [Location!]!
    location(id: Int!): Location

    # Feature Flags
    featureFlags: [FeatureFlag!]!
    featureFlag(key: String!): FeatureFlag

    # API Keys
    myApiKeys: [ApiKey!]!
  }
`;
