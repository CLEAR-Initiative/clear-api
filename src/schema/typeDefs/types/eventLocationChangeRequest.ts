import { gql } from "graphql-tag";

export const eventLocationChangeRequestTypeDef = gql`
  """A proposal to move an Event to a new place, filed by a team analyst or
  emergency_response_manager on behalf of their team and decided by that team's
  team_admin. The proposed place is any point (a geocoder hit) within the team's
  area, not limited to CLEAR's locations: accepting creates or reuses a level-4
  point location for it under the admin area that contains it, then sets it as
  the Event's location. A move beyond the team's area is for a platform admin.
  Only the Event moves; its signals keep their own locations."""
  type EventLocationChangeRequest {
    id: ID!
    eventId: String!
    event: Event!
    """The team the request was filed for. Only its team_admin (or a platform
    admin) decides it."""
    teamId: String!
    team: Team!
    """"pending", "accepted" or "rejected"."""
    status: String!
    """Why the proposer thinks the current location is wrong."""
    note: String
    proposedLat: Float!
    proposedLng: Float!
    """Display name of the proposed place, e.g. a village from the geocoder."""
    proposedName: String!
    """The existing admin area the proposed point falls in (district, else
    state, else country): where the new point location would be placed."""
    proposedPlacement: Location
    """The Event's location when the request was filed."""
    previousLocation: Location
    """The point location the Event was moved to (set on accept)."""
    appliedLocation: Location
    """Auth user id of the proposer."""
    createdBy: String!
    """Display name of the proposer."""
    createdByName: String
    createdAt: DateTime!
    updatedAt: DateTime!
    """Auth user id of whoever accepted or rejected it."""
    decidedBy: String
    decidedAt: DateTime
    decisionNote: String
  }

  input ProposeEventLocationChangeInput {
    eventId: String!
    """The proposer's team; they must be its analyst or emergency_response_manager."""
    teamId: String!
    lat: Float!
    lng: Float!
    """Display name of the proposed place (required, at most 200 characters)."""
    name: String!
    note: String
  }
`;
