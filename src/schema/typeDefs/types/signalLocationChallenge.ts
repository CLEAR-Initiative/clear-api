import { gql } from "graphql-tag";

export const signalLocationChallengeTypeDef = gql`
  """An analyst's Location challenge on a Signal: why its location looks wrong,
  optionally with a corrected point, filed for one team. That team's admin or a
  platform admin decides it, even when they filed it. Accepting writes the proposed
  point onto the Signal, correcting writes a point the admin placed instead,
  and declining leaves the Signal as it is. A written point becomes the
  Signal's general location (its origin and destination are cleared and its
  countries follow), and later source revisions keep it. Which Event the
  Signal belongs to does not change. A Signal has at most one open challenge:
  filing a new one supersedes it."""
  type SignalLocationChallenge {
    id: ID!
    signalId: String!
    """The challenged Signal."""
    signal: Signal!
    """The team it was filed for. Null on challenges filed before teams were
    recorded; a platform admin decides those."""
    teamId: String
    """The team it was filed for, as an object: only for its members and
    platform admins, null for anyone else."""
    team: Team
    """"consideration" (open), "accepted" (the proposed point was written),
    "corrected" (the admin placed a different point), "declined", or
    "superseded" (replaced by a newer challenge on the same Signal)."""
    status: String!
    """Optional note explaining why the pin looks wrong."""
    note: String
    """Proposed corrected point. Both lng and lat are set together, or both null
    (a bare challenge with no correction)."""
    proposedLng: Float
    proposedLat: Float
    """Optional label for the proposed point."""
    proposedName: String
    """The existing admin area the proposed point falls in (district, else
    state, else country). Null for a bare challenge, or a point outside the
    areas CLEAR covers."""
    proposedPlacement: Location
    """The Signal's location when the challenge was filed."""
    previousLocation: Location
    """The point written onto the Signal, set when accepted or corrected."""
    appliedLocation: Location
    """Who filed it: a person, or the pipeline."""
    origin: SignalLocationChallengeOrigin!
    """Auth user id of whoever filed the challenge: the pipeline's service
    user when the origin is PIPELINE."""
    createdBy: String!
    """Display name of whoever filed it."""
    createdByName: String
    createdAt: DateTime!
    updatedAt: DateTime!
    """Auth user id of whoever decided it."""
    decidedBy: String
    """When it was decided."""
    decidedAt: DateTime
    """True when proposedLng/proposedLat are both set."""
    hasProposedPoint: Boolean!
  }

  input SubmitSignalLocationChallengeInput {
    signalId: String!
    """The team it is filed for. The caller must be an analyst on it (or a
    platform admin), and the Signal must be within the team's area."""
    teamId: String!
    note: String
    """Omit both to file a bare challenge. Provide both (finite, in range) for a
    corrected point, which must fall inside the areas CLEAR covers and, unless
    a platform admin files it, within the team's area. One without the other
    is rejected."""
    proposedLng: Float
    proposedLat: Float
    proposedName: String
  }

  """Who filed a Location challenge."""
  enum SignalLocationChallengeOrigin {
    """A person filed it in the app."""
    PERSON
    """The pipeline filed it: the place the Signal's text names is in another
    state than the point its source sent."""
    PIPELINE
  }

  """A Location challenge the pipeline files after it places a Signal by its
  text in another state than the point its source sent."""
  input FileSignalLocationChallengeFromPipelineInput {
    signalId: String!
    """The point the source sent, as the proposed point (finite, in range,
    inside the areas CLEAR covers)."""
    proposedLat: Float!
    proposedLng: Float!
    """Optional label for the proposed point, at most 500 characters."""
    proposedName: String
    """Optional note, at most 2000 characters."""
    note: String
  }

  """How an admin decides a Location challenge."""
  enum SignalLocationChallengeDecision {
    """Write the proposed point onto the Signal."""
    ACCEPT
    """Write a different point, given as \`point\`, onto the Signal."""
    CORRECT
    """Leave the Signal as it is."""
    DECLINE
  }

  """The point an admin places when the proposed one is wrong too."""
  input LocationChallengePointInput {
    """Latitude, -90 to 90."""
    lat: Float!
    """Longitude, -180 to 180."""
    lng: Float!
    """Display name of the place, at most 500 characters. Without one the
    point shows its admin area's name."""
    name: String
  }
`;
