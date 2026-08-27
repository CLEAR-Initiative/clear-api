import { gql } from "graphql-tag";

export const signalTypeDef = gql`
  """Durable processing status for the Dagster event-driven drain.
  NEW = ingested, awaiting downstream processing; PROCESSED = classify→group→
  alert done; FAILED = terminal failure."""
  enum SignalStatus {
    NEW
    PROCESSED
    FAILED
  }

  """A signal derived from a data source."""
  type Signal {
    id: String!
    """The data source this signal was collected from."""
    source: DataSource!
    """Processing status for the pipeline drain (NEW until downstream runs)."""
    status: SignalStatus!
    """When the downstream pipeline finished processing this signal (null while NEW)."""
    processedAt: DateTime
    """Pointer to the raw payload blob in the S3 data lake, when landed there."""
    rawS3Key: String
    """Stable upstream identifier (e.g. "dataminr:{alertId}"). Used to
    deduplicate ingestion — (source, externalId) is unique."""
    externalId: String
    publishedAt: DateTime!
    collectedAt: DateTime!
    url: String
    title: String
    description: String
    """Severity score (1–5). From data source or estimated by pipeline."""
    severity: Int
    """Reported casualties for the signal. Sourced from ACLED's fatalities
    field; for Dataminr, parsed from raw text via regex."""
    casualties: Int
    """Raw upstream payload, verbatim as received from the source. Admin/
    pipeline only — may carry source-internal fields (e.g. a manual signal's
    \`createdBy\` user id) not meant for general viewers. Null for any other
    caller, regardless of whether data actually exists."""
    rawData: JSON
    """Media URLs (S3 keys for manual uploads, or source URLs for pipeline signals)."""
    media: [String!]!
    """Whether this is seed/demo data."""
    isDummy: Boolean!
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
    """Open Location challenge for this signal, if any (null when none)."""
    locationChallenge: SignalLocationChallenge
  }
`;
