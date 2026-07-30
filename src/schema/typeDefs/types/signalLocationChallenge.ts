import { gql } from "graphql-tag";

export const signalLocationChallengeTypeDef = gql`
  """An analyst's Location challenge on a Signal, with an optional Location
  correction (Location trust v1). Queue only — status is always "consideration",
  there is no accept/reject, and it never mutates the Signal's own geometry."""
  type SignalLocationChallenge {
    id: ID!
    signalId: String!
    """v1 is always "consideration"."""
    status: String!
    """Optional note explaining why the pin looks wrong."""
    note: String
    """Proposed corrected point. Both lng and lat are set together, or both null
    (a bare challenge with no correction)."""
    proposedLng: Float
    proposedLat: Float
    """Optional label for the proposed point."""
    proposedName: String
    """Auth user id of whoever filed the challenge."""
    createdBy: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    """True when proposedLng/proposedLat are both set."""
    hasProposedPoint: Boolean!
  }

  input SubmitSignalLocationChallengeInput {
    signalId: String!
    note: String
    """Omit both to file a bare challenge. Provide both (finite, in range) for a
    Location correction — one without the other is rejected."""
    proposedLng: Float
    proposedLat: Float
    proposedName: String
  }
`;
