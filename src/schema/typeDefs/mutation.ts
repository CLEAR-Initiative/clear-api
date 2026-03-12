import { gql } from "graphql-tag";

export const mutationTypeDef = gql`
  type Mutation {
    # ─── API Keys ──────────────────────────────────────────────────────────────
    """Create a new API key for the authenticated user."""
    createApiKey(input: CreateApiKeyInput!): CreateApiKeyPayload!

    """Revoke an API key by ID. Only the key owner or an admin can revoke."""
    revokeApiKey(id: String!): ApiKey!

    # ─── Auth ──────────────────────────────────────────────────────────────────
    """Request an email verification link for the authenticated user."""
    requestEmailVerification: Boolean!

    """Verify email using a token from the verification link."""
    verifyEmail(token: String!): Boolean!

    # ─── User ──────────────────────────────────────────────────────────────────
    """Update the authenticated user's profile and notification preferences."""
    updateProfile(input: UpdateProfileInput!): User!

    # ─── Alerts ────────────────────────────────────────────────────────────────
    """Create a new alert."""
    createAlert(input: CreateAlertInput!): Alert!

    """Update an existing alert."""
    updateAlert(id: String!, input: UpdateAlertInput!): Alert!

    """Delete an alert."""
    deleteAlert(id: String!): Boolean!

    # ─── Detections ────────────────────────────────────────────────────────────
    """Create a new detection."""
    createDetection(input: CreateDetectionInput!): Detection!

    """Update an existing detection."""
    updateDetection(id: String!, input: UpdateDetectionInput!): Detection!

    """Delete a detection."""
    deleteDetection(id: String!): Boolean!

    # ─── Signals ───────────────────────────────────────────────────────────────
    """Create a signal from a source (detection)."""
    createSignal(sourceId: String!, publishedAt: String!, collectedAt: String!): Signal!

    """Delete a signal."""
    deleteSignal(id: String!): Boolean!

    # ─── Events ────────────────────────────────────────────────────────────────
    """Create a new event from signals."""
    createEvent(input: CreateEventInput!): Event!

    """Update an existing event."""
    updateEvent(id: String!, input: UpdateEventInput!): Event!

    """Delete an event."""
    deleteEvent(id: String!): Boolean!

    # ─── Data Sources ──────────────────────────────────────────────────────────
    """Create a new data source."""
    createDataSource(input: CreateDataSourceInput!): DataSource!

    """Update an existing data source."""
    updateDataSource(id: String!, input: UpdateDataSourceInput!): DataSource!

    """Delete a data source."""
    deleteDataSource(id: String!): Boolean!

    # ─── Locations ─────────────────────────────────────────────────────────────
    """Create a new location."""
    createLocation(input: CreateLocationInput!): Location!

    """Update an existing location."""
    updateLocation(id: String!, input: UpdateLocationInput!): Location!

    """Delete a location."""
    deleteLocation(id: String!): Boolean!

    # ─── Notifications ─────────────────────────────────────────────────────────
    """Create a notification for a user."""
    createNotification(input: CreateNotificationInput!): Notification!

    """Delete a notification."""
    deleteNotification(id: String!): Boolean!

    """Mark a notification as read."""
    markNotificationRead(id: String!): Notification!

    """Mark all notifications as read for the authenticated user."""
    markAllNotificationsRead: Boolean!
  }

  # ─── Input Types ───────────────────────────────────────────────────────────

  input UpdateProfileInput {
    name: String
    phoneNumber: String
    image: String
    enableInAppNotification: Boolean
    enableEmailNotification: Boolean
    enableSMSNotification: Boolean
  }

  input CreateAlertInput {
    description: String!
    severity: Int!
    status: AlertStatus
    eventType: String!
    rank: Float!
    primarySignalId: String
    signalIds: [String!]
    locationIds: [String!]
    metadata: JSON
    firstSignalCreatedAt: String!
    lastSignalCreatedAt: String!
  }

  input UpdateAlertInput {
    description: String
    severity: Int
    status: AlertStatus
    eventType: String
    rank: Float
    primarySignalId: String
    signalIds: [String!]
    locationIds: [String!]
    metadata: JSON
  }

  input CreateDetectionInput {
    title: String!
    confidence: Float
    status: DetectionStatus
    detectedAt: DateTime
    rawData: JSON
    dataSourceId: String
    locationIds: [String!]
  }

  input UpdateDetectionInput {
    title: String
    confidence: Float
    status: DetectionStatus
    rawData: JSON
    dataSourceId: String
    locationIds: [String!]
  }

  input CreateEventInput {
    signalIds: [String!]!
    primarySignalId: String
    eventType: String!
    rank: Float!
    severity: Int!
    description: String
    firstSignalCreatedAt: String!
    lastSignalCreatedAt: String!
  }

  input UpdateEventInput {
    signalIds: [String!]
    primarySignalId: String
    eventType: String
    rank: Float
    severity: Int
    description: String
  }

  input CreateDataSourceInput {
    name: String!
    type: String!
    isActive: Boolean
    baseUrl: String
    infoUrl: String
  }

  input UpdateDataSourceInput {
    name: String
    type: String
    isActive: Boolean
    baseUrl: String
    infoUrl: String
  }

  input CreateLocationInput {
    geoId: Int
    osmId: String
    pCode: String
    name: String!
    level: Int!
    parentId: String
  }

  input UpdateLocationInput {
    geoId: Int
    osmId: String
    pCode: String
    name: String
    level: Int
    parentId: String
  }

  input CreateNotificationInput {
    userId: String!
    message: String!
    notificationType: String!
    actionUrl: String
    actionText: String
  }
`;
