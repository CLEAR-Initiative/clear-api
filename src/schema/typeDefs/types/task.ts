import { gql } from "graphql-tag";
import { OBSERVED_ESTIMATE_METHODS } from "../../../services/computed-impact-prior.js";

const OBSERVED_METHODS_DOC = OBSERVED_ESTIMATE_METHODS.map((m) => "`" + m + "`").join(", ");

/**
 * Tasks and Workers (ADR-0010).
 *
 * A Task is one unit of Worker-performed work: exactly one `kind`, exactly
 * one subject, a status, a row-level lease and the raw Worker output.
 * clear-api exposes it as a Worker protocol over GraphQL — request, claim,
 * heartbeat, complete, fail — and is the only writer of its database:
 * Postgres is the broker, GraphQL the only door.
 *
 * The first kind of work is `event.impact_prior.web` ("Web search"), whose
 * typed result is CaseProposals — proposed signals — stored beside the
 * Event. The ImpactPrior itself is computed from history
 * (`ComputedImpactPrior`); the V1–V3 whole-prior proposals are history.
 */
export const taskTypeDef = gql`
  """Lifecycle of a Task. PENDING → LEASED (claimed) → COMPLETED | FAILED;
  PENDING or LEASED → CANCELLED. An expired lease returns the Task to
  PENDING lazily, at the next claim. Tasks are never deleted."""
  enum TaskStatus {
    PENDING
    LEASED
    COMPLETED
    FAILED
    CANCELLED
  }

  """Who asked for the Task: a signed-in user, an automatic rule, or an
  API-key caller."""
  enum TaskOrigin {
    user
    rule
    api
  }

  """The state a V1–V3 whole-prior proposal was left in. Retired: none is
  created or decided any more."""
  enum ImpactPriorState {
    proposed
    accepted
    rejected
  }

  """A web Worker writes \`proposed\` only (V4). A named admin or analyst
  accepts or rejects each case; a rejected one stays, so its URL is never
  proposed again for the same Event."""
  enum CaseProposalState {
    proposed
    accepted
    rejected
  }

  """One unit of Worker-performed work (ADR-0010)."""
  type Task {
    id: String!
    """The kind of work, e.g. \`event.impact_prior.web\` (the web search
    that proposes signals; the name is historical). A Worker claims by exact
    kind. One request fans out into one Task per enabled source kind. Older
    Tasks may carry the retired whole-prior kinds \`event.impact_prior\`
    and \`event.impact_prior.clear\`."""
    kind: String!
    """The subject's type, e.g. \`event\`."""
    subjectType: String!
    """The subject's id, e.g. an Event id."""
    subjectId: String!
    """Per-kind inputs, e.g. \`{ "horizonYears": 10 }\`."""
    payload: JSON!
    status: TaskStatus!
    origin: TaskOrigin!
    """Shared by every Task one request fanned out into (one per source
    kind). The per-requester daily cap counts distinct requests, not
    Tasks."""
    requestId: String!
    """The user who requested it; null for origin \`rule\`."""
    requesterId: String
    requester: User
    """The view-scope team passed at request time (an authorisation hint,
    not an Event team — Events have none)."""
    teamId: String
    """The Worker (a service user) or person currently holding the lease."""
    leaseOwnerId: String
    leaseOwner: User
    """When the current lease lapses. A heartbeat extends it by
    TASK_LEASE_MINUTES; past this instant the Task is claimable again."""
    leaseExpiresAt: DateTime
    """Secret minted per claim. Returned only to the lease owner (null for
    everyone else); the Worker presents it on heartbeat, complete and fail.
    A new claim mints a new token, so a run whose lease lapsed and was
    reclaimed — even by the same Worker identity — can no longer write."""
    leaseToken: String
    """Times the Task has been claimed."""
    attempts: Int!
    """Claims allowed before the Task is marked FAILED."""
    maxAttempts: Int!
    """The last Worker-reported error. Visible to the requester and platform
    admins only; null for everyone else."""
    lastError: String
    """Set when a LEASED Task was cancelled; the Worker learns at its next
    heartbeat or completion and stops."""
    cancelRequestedAt: DateTime
    cancelledById: String
    """Kind-specific result vocabulary. For \`event.impact_prior.*\`:
    \`produced\` or \`no_prior_found\`; for the web kind also
    \`no_new_cases\` (every case found was already proposed for the Event)."""
    outcome: String
    """Raw Worker output, kept for audit. The typed result lives beside the
    subject (see \`Event.caseProposals\`)."""
    result: JSON
    """Spend as the Worker reported it on completion."""
    model: String
    inputTokens: Int
    outputTokens: Int
    costUsd: Float
    completedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """History: a whole ImpactPrior a Worker proposed in V1–V3, and the
  decision recorded on it. Retired (2026-10-08): nothing creates or decides
  one any more. The ImpactPrior is computed from history instead (see
  \`ComputedImpactPrior\`); what analysts review is CaseProposals."""
  type ImpactPrior {
    id: String!
    eventId: String!
    event: Event!
    taskId: String!
    task: Task!
    state: ImpactPriorState!
    """The kind of the Task that produced it — \`event.impact_prior.clear\`
    (CLEAR data), \`event.impact_prior.web\` (the web), or the pre-fan-out
    \`event.impact_prior\` — so a client can label the source."""
    sourceKind: String!
    """GLIDE code; one of the Event's \`types\`."""
    hazardType: String!
    """The level-0 (country) ancestor of the Event's primary location."""
    countryLocationId: String!
    """\`district\` or \`country\`: the scope the cases were matched at."""
    geographicScope: String!
    """How far back cases were sought, in years."""
    horizonYears: Int!
    populationGroup: String
    metric: String
    lowerBound: Float
    upperBound: Float
    numberOfCases: Int!
    """The evidence: one entry per case —
    \`{ tier: "clear" | "web", eventId?, sourceUrl?, quote?, occurredAt?, locationLabel?, scope }\`."""
    basis: JSON!
    validFrom: DateTime
    validTo: DateTime
    """Version string of the skill or handler that produced it."""
    methodVersion: String!
    """The previous ImpactPrior of the same \`sourceKind\` for the same
    Event, if any. Never crosses sources."""
    supersedesId: String
    supersedes: ImpactPrior
    """Who decided it, when and why (null while \`proposed\`)."""
    decidedById: String
    decidedBy: User
    decidedAt: DateTime
    decisionRationale: String
    createdAt: DateTime!
  }

  """One historical case a web Worker found while enriching an Event (V4):
  a past incident like it, the source that reports it, the figures it gives,
  and the CLEAR Event it describes when CLEAR already holds one. The unit an
  analyst accepts or rejects, one by one, in the Inbox and on the Event page."""
  type CaseProposal {
    id: String!
    """The Event whose enrichment request produced the case."""
    eventId: String!
    event: Event!
    taskId: String!
    task: Task!
    state: CaseProposalState!
    sourceUrl: String!
    """The source's own words, verbatim."""
    quote: String!
    """When the incident happened (valid time), not when it was reported."""
    occurredAt: DateTime!
    locationLabel: String!
    """A CLEAR location for the place, when the Worker resolved one."""
    locationId: String
    """GLIDE code; one of the requesting Event's \`types\`."""
    hazardType: String!
    """\`district\` or \`country\`: the scope the case was matched at."""
    geographicScope: String!
    """The figures the source gives, each on one of the Domain Ontology's
    seven metric types —
    \`[{ metric, value, lowerBound?, upperBound?, unit?, populationGroup? }]\`.
    Empty when the source states none."""
    figures: JSON!
    """The CLEAR Event this case describes, when CLEAR already holds it."""
    matchedEventId: String
    matchedEvent: Event
    """Version string of the skill or handler that produced the case."""
    methodVersion: String!
    """Who decided it, when and why (null while \`proposed\`)."""
    decidedById: String
    decidedBy: User
    decidedAt: DateTime
    decisionRationale: String
    """What accepting wrote into CLEAR: the Signal, and the Event it sits on."""
    resultSignalId: String
    resultEventId: String
    createdAt: DateTime!
  }

  """One figure a case's source gives."""
  input CaseFigureInput {
    """One of \`people_affected\`, \`people_displaced_new\`,
    \`people_displaced_cumulative\`, \`people_in_need\`, \`people_targeted\`,
    \`people_reached\`, \`households_affected\`."""
    metric: String!
    """Non-negative. With bounds, \`lowerBound ≤ value ≤ upperBound\`."""
    value: Float!
    lowerBound: Float
    upperBound: Float
    unit: String
    populationGroup: String
  }

  """One case a web Worker proposes on completing an
  \`event.impact_prior.web\` Task (V4)."""
  input CaseProposalInput {
    """Absolute http(s) URL; one case per URL per Event."""
    sourceUrl: String!
    """The source's own words, verbatim."""
    quote: String!
    """When the incident happened: within the request's horizon, not in the future."""
    occurredAt: DateTime!
    locationLabel: String!
    """A CLEAR location in the Event's country, if resolved."""
    locationId: String
    """Must be one of the Event's \`types\`."""
    hazardType: String!
    """\`district\` or \`country\`."""
    geographicScope: String!
    figures: [CaseFigureInput!]
    """The CLEAR Event this case describes, if the Worker found one: it must
    exist, not be the Event being enriched, manifest the case's hazard and
    sit in the same country."""
    matchedEventId: String
  }

  """What has typically happened before (the Domain Ontology's ImpactPrior),
  computed from CLEAR's history (V4): the Events before this one that
  manifest the same hazard in the same country within the horizon, one
  current figure each for one metric and population group. Computed on
  read from accepted history — nothing to review. Read \`numberOfCases\`
  beside the figure: a prior resting on three Events is not one resting on
  ninety.

  Only observed or reported figures count: Estimates whose method is one of
  ${OBSERVED_METHODS_DOC}. Figures with method \`not_documented\` (the
  pipeline's backfilled placeholders), \`model_inference\`,
  \`exposure_model\` or \`prior_caseload_analogue\` (itself derived from a
  prior) are not history, so they are never summarised."""
  type ComputedImpactPrior {
    """GLIDE code; one of the Event's \`types\`."""
    hazardType: String!
    """The Event's country (level-0 location)."""
    countryLocationId: String!
    """How far back history was taken, in years."""
    horizonYears: Int!
    """One of the Domain Ontology's seven metric types."""
    metric: String!
    populationGroup: String
    """The figures' unit (lower-cased), or null when they state none.
    Figures in different units are never summarised together."""
    unit: String
    """The median of the historical figures."""
    centralValue: Float!
    """The smallest historical figure."""
    lowerBound: Float!
    """The largest historical figure."""
    upperBound: Float!
    """How many historical Events it rests on."""
    numberOfCases: Int!
    """True below three cases: a starting point, not a basis."""
    lowConfidence: Boolean!
    """The historical Events it rests on."""
    eventIds: [String!]!
    """The Estimates it rests on, one per Event."""
    estimateIds: [String!]!
    """How the Estimates it rests on were arrived at, most common first, so
    a reader can see what the prior is built from."""
    basisMethods: [EstimateMethodCount!]!
    """Version of the method that computed it."""
    methodVersion: String!
  }

  """How many of a prior's figures were arrived at by one method."""
  type EstimateMethodCount {
    method: EstimateMethod!
    count: Int!
  }

  """The decision a named admin or analyst records on a proposed case."""
  enum CaseProposalDecision {
    accepted
    rejected
  }

  """Spend a Worker reports when completing a Task. Cost is computed by the
  caller from its own price table."""
  input TaskUsageInput {
    model: String!
    inputTokens: Int!
    outputTokens: Int!
    costUsd: Float!
  }

  extend type Event {
    """Enrichment Tasks about this Event, newest first. Requires any
    authenticated content reader; \`lastError\` is redacted for all but the
    requester and platform admins."""
    enrichmentTasks: [Task!]!
    """History: the whole ImpactPriors Workers proposed for this Event in
    V1–V3, newest first. \`accepted\` follows the Event's visibility;
    \`proposed\` is visible to its requester and to deciders; \`rejected\`
    to deciders only. For what history suggests now, read
    \`computedImpactPriors\`."""
    impactPriors: [ImpactPrior!]!
    """Web cases proposed while enriching this Event (V4), newest first,
    under the ImpactPrior visibility rule: \`accepted\` follows the Event,
    \`proposed\` is visible to the requester and deciders, \`rejected\` to
    deciders only."""
    caseProposals: [CaseProposal!]!
    """ImpactPriors computed from CLEAR's history (V4), one per hazard the
    Event manifests × metric × population group with any history, most
    evidence first. Follows the Event's visibility. \`horizonYears\`
    (default 10, at most 50) is how far back history is taken."""
    computedImpactPriors(horizonYears: Int = 10): [ComputedImpactPrior!]!
  }
`;
