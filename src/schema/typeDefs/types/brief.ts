import { gql } from "graphql-tag";

export const briefTypeDef = gql`
  """How far back a Brief window reaches from its end."""
  enum BriefCadence {
    """The last 24 hours."""
    daily
    """The last 7 days."""
    weekly
    """The last 30 days."""
    monthly
  }

  """A Brief is edited while \`draft\` and frozen once \`sent\`."""
  enum BriefStatus {
    draft
    sent
  }

  """Which detection a Brief item points at. Items are grouped by kind,
  shown in the order alert, event, signal."""
  enum BriefItemKind {
    alert
    event
    signal
  }

  """A Brief: a platform admin's hand-picked summary of one area over one
  Brief window, emailed to a Recipient list. Sending freezes it. Platform
  admins only."""
  type Brief {
    id: String!
    cadence: BriefCadence!
    status: BriefStatus!
    title: String!
    """The area: a country, state or district (locations.id). Not a
    relation: a sent Brief outlives location changes."""
    locationId: String!
    """The area's name, frozen when the Brief was created."""
    locationName: String!
    """Start of the Brief window: \`windowEnd\` minus 24h, 7d or 30d."""
    windowStart: DateTime!
    """End of the Brief window: when the Brief was created or last
    refreshed."""
    windowEnd: DateTime!
    """Markdown-lite: **bold**, *italic*, \`- \` bullets and
    [text](https://...) links."""
    summary: String!
    """Markdown-lite, like \`summary\`."""
    closingNotes: String!
    """Picked items, ordered by group (alert, event, signal) and then by
    \`position\` within the group."""
    items: [BriefItem!]!
    """Signals, Events and Alerts over exactly this Brief's area and
    window, by severity and type, whatever filters a list shows. Live
    for a draft; for a sent Brief, the counts it was sent with."""
    counts: BriefCounts!
    createdById: String!
    sentAt: DateTime
    sentById: String
    """The Recipient list it was sent to."""
    sentToListId: String
    """Emails accepted by the provider at send."""
    sentCount: Int
    """Emails the provider refused at send. Not retried."""
    failedCount: Int
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """Counts for a Brief's area and window, with the same semantics as
  \`entityStats\`: Alerts and Events windowed on their first Signal,
  Signals on publication, the area including everything inside it."""
  type BriefCounts {
    signal: EntityCount!
    event: EntityCount!
    alert: EntityCount!
  }

  """One kind of detection's counts in a Brief."""
  type EntityCount {
    total: Int!
    """Keys are severities 1 to 5 as strings, "(unknown)" for none."""
    bySeverity: [StatsBucket!]!
    """Disaster-type codes for Events and Alerts; data-source names for
    Signals, as in \`entityStats\`."""
    byType: [StatsBucket!]!
  }

  """A detection picked into a Brief."""
  type BriefItem {
    id: String!
    briefId: String!
    kind: BriefItemKind!
    """The Alert, Event or Signal id. Not a relation: the item survives
    the entity being merged or deleted."""
    entityId: String!
    """Order within its kind group, from 0."""
    position: Int!
    """The analyst's note, Markdown-lite."""
    note: String
    """What the Brief shows for the item. Built server-side when the item
    is added, rewritten from live data at send, then frozen."""
    snapshot: BriefItemSnapshot!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A Brief item as the Brief shows it."""
  type BriefItemSnapshot {
    title: String!
    """1 to 5, or null when unknown."""
    severity: Int
    locationName: String
    """Disaster-type codes. A Signal takes its Events' types."""
    eventTypes: [String!]!
    """When the item happened, by the same columns the History list and
    \`entityStats\` window on: an Alert's or Event's first Signal, a
    Signal's publication. Earlier than \`Brief.windowStart\` means it was
    picked from before the window."""
    occurredAt: DateTime!
    """The item's page in the CLEAR app."""
    url: String!
  }

  """Fields to change on a draft Brief; omitted fields are kept."""
  input UpdateBriefInput {
    """Must not be blank."""
    title: String
    """Markdown-lite."""
    summary: String
    """Markdown-lite."""
    closingNotes: String
  }

  input CreateBriefInput {
    cadence: BriefCadence!
    """A country, state or district (location level 0 to 2)."""
    locationId: String!
    """Defaults to "<Daily|Weekly|Monthly> Brief, <area name>"."""
    title: String
  }
`;
