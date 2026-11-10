import { gql } from "graphql-tag";

/**
 * Unresolved place names and place aliases (ADR-0019): CLEAR's own tables
 * beside the GeoNames gazetteer.
 */
export const unresolvedPlaceNameTypeDef = gql`
  """The state of an unresolved place name."""
  enum UnresolvedPlaceNameStatus {
    """Waits for a decider."""
    OPEN
    """A decider gave it a location. A place alias holds the answer."""
    RESOLVED
    """The spelling is not a place. A later miss only adds to the count."""
    NOT_A_PLACE
    """The spelling can mean more than one place. It needs local knowledge."""
    AMBIGUOUS
  }

  """Why geocoding did not place a name."""
  enum UnresolvedPlaceNameReason {
    """The gazetteer has no candidate for the spelling."""
    NO_MATCH
    """A candidate exists, but it lies outside the Signal's area."""
    OUTSIDE_AREA
  }

  """Where a place alias came from."""
  enum PlaceAliasSource {
    """A decider resolved an unresolved place name."""
    REVIEW
    """A loaded list, for example critical facilities."""
    SEED
    """A user added it by hand."""
    MANUAL
  }

  """A place name, as written in a Signal, that geocoding could not place
  inside the Signal's area. One row per country, normalised spelling and
  state: the same village name in two states gives two rows."""
  type UnresolvedPlaceName {
    id: ID!
    """The spelling after the gazetteer's normalisation. Part of the row's key."""
    nameNorm: String!
    """The spelling in the first Signal that named it."""
    nameAsWritten: String!
    """The Arabic spelling from the Signal's text, when one was found."""
    nameAr: String
    """ISO-3166-1 alpha-2 (SD, VE, AF)."""
    countryCode: String!
    """The state that holds the Signals' area. Null when the area is the
    country itself."""
    stateLocationId: String
    stateLocation: Location
    """The country that holds the Signals' area."""
    countryLocationId: String
    status: UnresolvedPlaceNameStatus!
    """The number of Signals recorded on the row. A Signal counts once."""
    signalCount: Int!
    firstSeenAt: DateTime!
    lastSeenAt: DateTime!
    """Auth user id of whoever closed the row."""
    resolvedById: String
    """Display name of whoever closed the row."""
    resolvedByName: String
    resolvedAt: DateTime
    resolutionNote: String
    """The alias that the resolution created."""
    placeAliasId: String
    placeAlias: PlaceAlias
    """The number of its Signals that a resolution moved to the alias location."""
    signalsMoved: Int!
    """The Signals that named it, newest first."""
    signals(
      """Max rows to return (1 to 50, default 5)."""
      first: Int
    ): [UnresolvedPlaceNameSignal!]!
  }

  """One Signal that named an unresolved place name."""
  type UnresolvedPlaceNameSignal {
    signalId: String!
    """Null when the caller may not read the Signal."""
    signal: Signal
    """The area the pipeline chose for the Signal. Geocoding looked inside it."""
    areaLocationId: String
    areaLocation: Location
    """The spelling in this Signal."""
    nameAsWritten: String!
    reason: UnresolvedPlaceNameReason!
    """When the miss happened."""
    seenAt: DateTime!
    """When a resolution moved the Signal to the alias location."""
    relocatedAt: DateTime
  }

  """A spelling that CLEAR maps to a CLEAR location. CLEAR owns it: a
  GeoNames re-import never touches it."""
  type PlaceAlias {
    id: ID!
    """The spelling after the gazetteer's normalisation."""
    nameNorm: String!
    """The spelling to show."""
    nameDisplay: String!
    """ISO-3166-1 alpha-2 (SD, VE, AF)."""
    countryCode: String!
    """The area where the alias applies. Null means the whole country."""
    scopeLocationId: String
    scopeLocation: Location
    """The CLEAR location the spelling means."""
    locationId: String!
    location: Location
    source: PlaceAliasSource!
    """Auth user id of whoever created the alias. Null for a seed."""
    createdById: String
    createdByName: String
    createdAt: DateTime!
    updatedAt: DateTime!
    note: String
  }

  type UnresolvedPlaceNamesPage {
    items: [UnresolvedPlaceName!]!
    """Rows that match the filters, before paging."""
    totalCount: Int!
    hasMore: Boolean!
  }

  """What kind of place a suggestion is."""
  enum PlaceNameSuggestionKind {
    """A GeoNames row. Resolve with kind GEONAMES and its \`geonamesId\`."""
    GEONAMES
    """A CLEAR district or landmark. Resolve with kind LOCATION and its \`locationId\`."""
    LOCATION
  }

  """A place that a queued name can mean."""
  type PlaceNameSuggestion {
    kind: PlaceNameSuggestionKind!
    geonamesId: Int
    locationId: String
    name: String!
    """The level of a CLEAR location: 2 district, 4 landmark."""
    level: Int
    """GeoNames feature class (P populated place, A admin area, S spot, ...)."""
    featureClass: String
    featureCode: String
    latitude: Float!
    longitude: Float!
    """0 to 1: trigram similarity to the name, 1 for an exact match."""
    score: Float!
    """Whether the point is inside \`withinLocationId\`. Null without one."""
    insideArea: Boolean
    """Kilometres from \`withinLocationId\` (0 inside it). Null without one."""
    distanceKm: Float
  }

  """How a decider answers a queued name."""
  enum UnresolvedPlaceNameResolutionKind {
    """An existing CLEAR location: give \`locationId\`."""
    LOCATION
    """A GeoNames suggestion: give \`geonamesId\`. It becomes a level-4 landmark."""
    GEONAMES
    """A new point: give \`point\`. It becomes a level-4 landmark."""
    POINT
    """The spelling is not a place. The row closes and does not come back."""
    NOT_A_PLACE
    """The spelling can mean more than one place. The row leaves the open
    queue and stays resolvable."""
    AMBIGUOUS
  }

  """One answer: \`kind\`, and the one field that kind needs."""
  input UnresolvedPlaceNameResolutionInput {
    kind: UnresolvedPlaceNameResolutionKind!
    """With LOCATION: a district, a state or a level-4 landmark in the row's country."""
    locationId: String
    """With GEONAMES: the suggestion's GeoNames id."""
    geonamesId: Int
    """With POINT: the place. Its name defaults to the row's spelling."""
    point: LocationChallengePointInput
  }

  """One geocode miss, sent by the pipeline."""
  input RecordUnresolvedPlaceNameInput {
    """The Signal that named the place."""
    signalId: String!
    """The place name as the pipeline read it. At most 500 characters."""
    name: String!
    """The Arabic spelling from the Signal's text, when one was found."""
    nameAr: String
    """ISO-3166-1 alpha-2 (SD, VE, AF)."""
    countryCode: String!
    """The area the pipeline chose for the Signal. The server derives the
    row's state from it."""
    areaLocationId: String!
    """Why geocoding did not place the name. Default NO_MATCH."""
    reason: UnresolvedPlaceNameReason
    """When the miss happened. Default now. A backfill passes the real date."""
    seenAt: DateTime
  }
`;
