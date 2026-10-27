import { gql } from "graphql-tag";

export const signalTypeDef = gql`
  """Durable processing status for the Dagster event-driven drain (pending
  work only; see \`retracted\`). NEW = awaiting first grouping; PROCESSED =
  classify→group→alert done; FAILED = terminal failure; NEEDS_RECOMPUTE =
  grouped, then changed (content revision or retraction flip), so its events
  must be re-aggregated from their live members."""
  enum SignalStatus {
    NEW
    PROCESSED
    FAILED
    NEEDS_RECOMPUTE
  }

  """A source observation ingested from a data source or filed manually.
  Upstream source payloads are stored internally and are not returned on this type."""
  type Signal {
    id: String!
    """The data source this signal was collected from."""
    source: DataSource!
    """Processing status for the pipeline drain (NEW until downstream runs)."""
    status: SignalStatus!
    """When the downstream pipeline finished processing this signal (null while NEW)."""
    processedAt: DateTime
    """Fingerprint of the source's raw data, for sources whose records get
    revised in place (e.g. IDMC). Null for sources that never revise a signal
    after creation."""
    contentHash: String
    """When the signal last had a content revision or retraction flip via
    updateSignalContent. Not set by the first contentHash seed. Null if never
    revised."""
    lastRevisedAt: DateTime
    """Superseded upstream. Reversible. A retracted signal keeps its event
    links but is excluded from event aggregates and the NEW drain queue."""
    retracted: Boolean!
    """Count of effective changes via updateSignalContent. Compare-and-set
    token for markSignalsProcessed(items:)."""
    revision: Int!
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
    """Real-world event onset extracted from this signal by the shared
    event-classification LLM. Null when no onset was resolved."""
    startDate: DateTime
    """Precision of \`startDate\` (DAY = exact day; coarser = week/month/year)."""
    startDateAccuracy: DateAccuracy
    """Real-world event close extracted from this signal. Null = ongoing/unknown."""
    endDate: DateTime
    """Precision of \`endDate\`."""
    endDateAccuracy: DateAccuracy
    """Natural-hazard magnitude (e.g. 6.4). Null for non-disaster signals."""
    magnitude: Float
    """Unit for \`magnitude\` (e.g. "Mw", "km/h"). Null when no magnitude."""
    magnitudeUnit: String
    """Named conflict actors extracted from this signal. Empty for
    non-conflict signals."""
    actors: [String!]!
    """Countries the extracted event touches, resolved to admin-0 locations."""
    countries: [Location!]!
    """Glide code the pipeline grouped this signal with. Null for signals
    grouped before it was recorded, or never grouped."""
    glideCode: String
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
