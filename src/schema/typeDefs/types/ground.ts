import { gql } from "graphql-tag";

export const groundTypeDef = gql`
  """Per-source policy record for ground intelligence (WhatsApp groups,
  future hotline). Carries the consent scope, privacy default, reviewer
  roles, and retention rule for everything ingested from the source. The
  whole ground staging tier is private: admin/analyst only."""
  type GroundSource {
    id: ID!
    name: String!
    """Source kind: "staff_group" | "partner_group" | "hotline"."""
    kind: String!
    """Transport binding — WhatsApp group JID, or hotline number."""
    transportId: String!
    """What the source's members consented to (free text, e.g. "links and
    resources only"). Ingest policy is judged against this record."""
    consentScope: String
    consentRecordedAt: DateTime
    """Who recorded/gave the consent (person name/role, not a user id)."""
    consentRecordedBy: String
    """Review default for derived threads. V1: always "private"."""
    privacyDefault: String!
    """Global roles allowed to review threads from this source."""
    reviewerRoles: [String!]!
    """Free-text retention rule; enforcement is operational in V1."""
    retentionRule: String
    isActive: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input CreateGroundSourceInput {
    name: String!
    """"staff_group" | "partner_group" | "hotline"."""
    kind: String!
    """WhatsApp group JID (or hotline number). Must be unique."""
    transportId: String!
    consentScope: String
    consentRecordedAt: String
    consentRecordedBy: String
    """Defaults to "private"."""
    privacyDefault: String
    """Defaults to ["admin", "analyst"]."""
    reviewerRoles: [String!]
    retentionRule: String
  }

  """An incident thread in the review queue. V1 threads are one-per-message
  placeholders until the pipeline threading task clusters them. Lifecycle
  state models the correction chain; review state is the human gate in
  front of the signals graph."""
  type GroundThread {
    id: ID!
    groundSourceId: String!
    source: GroundSource!
    title: String
    """"reported" | "updated" | "confirmed" | "corrected" | "retracted"."""
    lifecycleState: String!
    """"unverified" | "approved_private" | "approved_public" | "rejected"."""
    reviewState: String!
    """Auth user id of the reviewer who last transitioned reviewState."""
    reviewedBy: String
    reviewedAt: DateTime
    reviewNote: String
    """Id of the \`signals\` row created when this thread was promoted
    (approved_public only)."""
    promotedSignalId: String
    messages: [GroundMessage!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A canonical staged message parsed from a WhatsApp source. Text is
  phone-number-redacted at persistence. senderName is private-tier data and
  is scrubbed from anything promoted to the signals graph."""
  type GroundMessage {
    id: ID!
    groundSourceId: String!
    """Idempotency id, scheme "whatsapp:{groupJid}:{messageId}"."""
    externalId: String!
    sentAt: DateTime!
    """Pseudonymous per-(source, sender) reference, e.g. "s_ab12cd34ef56"."""
    senderRef: String!
    """Raw sender display name. Private tier only — never promoted."""
    senderName: String
    """Message text (redacted). Empty for caption-less media messages."""
    text: String!
    """S3 keys of stored attachments."""
    mediaKeys: [String!]!
    """Presigned GET URLs for mediaKeys (1 h expiry), generated at read
    time — URLs are never stored."""
    mediaUrls: [String!]!
    """Attachment filenames referenced by the export."""
    mediaRefs: [String!]!
    """Media the export omitted ("image omitted") — the message still
    counts as a media message."""
    omittedMediaCount: Int!
    """"field_report" | "news_digest" | "operational" | "chatter"; null
    until the pipeline classification task labels the message."""
    classification: String
    """Contributor's own uncertainty tag ("unconfirmed", "rumour"),
    preserved from the source text."""
    uncertainty: String
    isEdited: Boolean!
    threadId: String
    createdAt: DateTime!
  }

  """Result of a chat-export ingest (also returned by the REST upload
  route as JSON)."""
  type GroundIngestResult {
    created: Int!
    skipped: Int!
    mediaStored: Int!
    mediaUnmatched: [String!]!
  }
`;
