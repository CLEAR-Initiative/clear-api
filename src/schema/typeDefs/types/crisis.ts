import { gql } from "graphql-tag";

export const crisisTypeDef = gql`
  """A crisis aggregates multiple events into a single coherent narrative."""
  type Crisis {
    id: String!
    title: String
    summary: String
    """Severity score (aggregated from linked events)."""
    severity: Float!
    """General location of the crisis."""
    generalLocation: Location
    """Needs associated with the crisis (JSON structure)."""
    needs: JSON!
    """Population directly affected by linked events (BigInt as string)."""
    populationAffected: String
    """Total population residing within the admin areas of linked events (BigInt as string)."""
    populationInArea: String
    """Events that are part of this crisis."""
    events: [Event!]!
    """User feedback on this crisis."""
    feedbacks: [UserFeedback!]!
    """User comments on this crisis."""
    comments: [UserComment!]!
  }

  """Link between a crisis and an event."""
  type EventCrisis {
    id: String!
    crisisId: String!
    eventId: String!
    collectedAt: DateTime!
    crisis: Crisis!
    event: Event!
  }

  input CreateCrisisFromEventsInput {
    title: String
    summary: String
    severity: Float!
    locationId: String
    """Needs as JSON."""
    needs: JSON!
    """Event IDs to link to the newly created crisis (must not be empty)."""
    eventIds: [String!]!
  }
`;
