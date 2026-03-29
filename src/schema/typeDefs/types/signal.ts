import { gql } from "graphql-tag";

export const signalTypeDef = gql`
  """A signal derived from a data source."""
  type Signal {
    id: String!
    """The data source this signal was collected from."""
    source: DataSource!
    """Original signal payload as JSON."""
    rawData: JSON!
    publishedAt: DateTime!
    collectedAt: DateTime!
    url: String
    title: String
    description: String
    """Severity score (1–5). From data source or estimated by pipeline."""
    severity: Int
    """Origin location of the signal."""
    originLocation: Location
    """Destination location of the signal."""
    destinationLocation: Location
    """General location (when no origin/destination)."""
    generalLocation: Location
    """Events this signal is linked to."""
    events: [Event!]!
    """User feedback on this signal."""
    feedbacks: [UserFeedback!]!
    """User comments on this signal."""
    comments: [UserComment!]!
  }
`;
