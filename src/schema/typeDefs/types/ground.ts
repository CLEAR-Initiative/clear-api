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
    """REQUIRED (with consentRecordedAt + consentRecordedBy) for the
    group kinds; hotline consent is explicit by design."""
    consentScope: String
    consentRecordedAt: String
    consentRecordedBy: String
    """Defaults to "private"."""
    privacyDefault: String
    """Defaults to ["admin", "analyst"]."""
    reviewerRoles: [String!]
    retentionRule: String
  }

  """Partial update of a source's policy record. Null/omitted fields are
  left unchanged; transportId is immutable (it is the identity that
  externalIds are minted against). The merged row is re-validated: group
  kinds must end up with a complete consent record."""
  input UpdateGroundSourceInput {
    name: String
    """"staff_group" | "partner_group" | "hotline"."""
    kind: String
    consentScope: String
    consentRecordedAt: String
    consentRecordedBy: String
    privacyDefault: String
    reviewerRoles: [String!]
    retentionRule: String
  }

  """A thread — a cluster of staged Signals — in the review queue. V1
  threads are one-per-message placeholders until the pipeline threading
  task clusters them. Lifecycle state models the correction chain; review
  state is the human gate in front of the signals graph. An approved
  thread is promoted and becomes a Signal."""
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
    """LLM-suggested headline from the hotline-enrichment job. A draft —
    the ERM reviews/edits it before promotion; never used directly."""
    draftTitle: String
    """1-5 suggestion from the hotline-enrichment job."""
    draftSeverity: Int
    """Geoparser-resolved \`locations\` row id, suggested by the
    hotline-enrichment job."""
    draftLocationId: String
    """Disaster-type guess from the hotline-enrichment job."""
    draftDisasterType: String
    messages: [GroundMessage!]!
    """Ids of the thread's messages, oldest first. The pipeline worker
    selects this (via groundThreadsForSource) instead of \`messages\` —
    it carries no message content and no sender identity."""
    messageIds: [String!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A staged Signal: a canonical message parsed from a WhatsApp source,
  held in the ground staging tier until its thread is reviewed. Text is
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
    """True when the message has a voice-note attachment (hotline
    sources). Set when the row is created, so it is true even while the
    voice note's media is still being stored."""
    hasVoice: Boolean!
    """Transcribed text of the message's voice note(s). Null until the
    clear-pipeline Dagster ground_transcribe asset transcribes it, and
    always null for messages without a voice note. Phone numbers are
    redacted at write time."""
    transcript: String
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

  """Pipeline-facing projection of a staged Signal for the
  classification/threading worker (clear-pipeline's
  classify_ground_messages task). Deliberately excludes senderName —
  the pipeline never sees private-tier identity, only the pseudonymous
  senderRef."""
  type GroundMessageForClassification {
    id: ID!
    text: String!
    sentAt: DateTime!
    senderRef: String!
    """True when the message carries stored media, export-referenced
    attachments, or export-omitted media."""
    hasMedia: Boolean!
    """S3 keys of this message's audio attachments only (a subset of its
    stored media) — empty when the message has no voice note, or while
    its media is still being stored (see \`hasVoice\`)."""
    voiceMediaKeys: [String!]!
    """True when the message has a voice attachment. Set when the row is
    created, so it stays true while \`voiceMediaKeys\` is still empty
    because the media hasn't been stored yet."""
    hasVoice: Boolean!
    """Transcribed text for this message's voice note(s), null until the
    Dagster ground_transcribe asset transcribes them."""
    transcript: String
    """Current label, null while unclassified."""
    classification: String
    """Current thread (placeholder or pipeline-built)."""
    threadId: String
  }

  """One classification write-back from the pipeline worker."""
  input GroundMessageClassificationInput {
    messageId: String!
    """"field_report" | "news_digest" | "operational" | "chatter"."""
    classification: String!
    """Pipeline-detected uncertainty tag. Null/omitted leaves the
    ingest-extracted marker untouched."""
    uncertaintyMarker: String
  }

  """One transcription write-back from the ground_transcribe worker."""
  input GroundMessageTranscriptInput {
    messageId: String!
    """Transcribed text of the message's voice note(s)."""
    transcript: String!
  }

  """One thread (a cluster of staged Signals) produced by the pipeline
  threading task. Its messageIds are re-pointed at the thread, replacing
  their V1 one-per-message placeholder threads. With \`threadId\` set,
  the input APPENDS to that existing thread (cross-run threading: late
  corrections/retractions join the thread they belong to) instead of
  creating a new one."""
  input GroundThreadUpsertInput {
    groundSourceId: String!
    title: String!
    """"reported" | "updated" | "confirmed" | "corrected" | "retracted"."""
    lifecycleState: String!
    messageIds: [String!]!
    """Optional target thread for cross-run appends. When set, messageIds
    are appended to this thread and its lifecycleState + title are
    updated — provided the thread is not yet promoted (reviewState !=
    "approved_public" and no promotedSignalId) and belongs to
    groundSourceId. A promoted/terminal (or unknown/wrong-source) target
    is never mutated: a NEW thread is created instead, with a warning."""
    threadId: String
  }

  """One enrichment draft from the Dagster hotline-enrichment job. Null
  fields leave the existing draft value on the thread unchanged."""
  input GroundThreadDraftInput {
    threadId: String!
    draftTitle: String
    """1-5. Validated server-side when present."""
    draftSeverity: Int
    draftLocationId: String
    draftDisasterType: String
  }
`;
