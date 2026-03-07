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
    alert(id: String!): Alert

    # Detections
    detections(status: DetectionStatus): [Detection!]!
    detection(id: String!): Detection

    # Signals
    signals: [Signal!]!
    signal(id: String!): Signal

    # Events
    events: [Event!]!
    event(id: String!): Event

    # Data Sources
    dataSources: [DataSource!]!
    dataSource(id: String!): DataSource

    # Locations
    locations(level: Int): [Location!]!
    location(id: String!): Location

    # Notifications
    notifications(status: NotificationStatus): [Notification!]!
    notification(id: String!): Notification

    # Feature Flags
    featureFlags: [FeatureFlag!]!
    featureFlag(key: String!): FeatureFlag

    # API Keys
    myApiKeys: [ApiKey!]!
  }
`;
