import { gql } from "graphql-tag";

export const situationTypeDef = gql`
  """A situation aggregates multiple events into a single coherent narrative."""
  type Situation {
    id: String!
    title: String
    summary: String
    """Severity score (aggregated from linked events)."""
    severity: Float!
    """General location of the situation."""
    generalLocation: Location
    """Needs associated with the situation (JSON structure)."""
    needs: JSON!
    """Population directly affected by linked events (BigInt as string)."""
    populationAffected: String
    """Total population residing within the admin areas of linked events (BigInt as string)."""
    populationInArea: String
    """Events that are part of this situation."""
    events: [Event!]!
    """User feedback on this situation."""
    feedbacks: [UserFeedback!]!
    """User comments on this situation."""
    comments: [UserComment!]!
  }

  """Link between a situation and an event."""
  type EventSituation {
    id: String!
    situationId: String!
    eventId: String!
    collectedAt: DateTime!
    situation: Situation!
    event: Event!
  }

  input CreateSituationFromEventsInput {
    title: String
    summary: String
    severity: Float!
    locationId: String
    """Needs as JSON."""
    needs: JSON!
    """Event IDs to link to the newly created situation (must not be empty)."""
    eventIds: [String!]!
  }
`;
