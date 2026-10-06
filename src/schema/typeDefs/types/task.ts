import { gql } from "graphql-tag";

/**
 * Tasks and Workers (ADR-0010).
 *
 * A Task is one unit of Worker-performed work: exactly one `kind`, exactly
 * one subject, a status, a row-level lease and the raw Worker output.
 * clear-api exposes it as a Worker protocol over GraphQL — request, claim,
 * heartbeat, complete, fail — and is the only writer of its database:
 * Postgres is the broker, GraphQL the only door.
 *
 * The first kind of work is `event.impact_prior`, whose typed result is an
 * ImpactPrior (the CLEAR Domain Ontology's class) stored beside the Event.
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

  """A Worker writes \`proposed\` only. A named admin or analyst moves it
  to \`accepted\` or \`rejected\` with a rationale; only \`accepted\` counts
  downstream, a rejected one stays, superseded, with its reason."""
  enum ImpactPriorState {
    proposed
    accepted
    rejected
  }

  """One unit of Worker-performed work (ADR-0010)."""
  type Task {
    id: String!
    """The kind of work, e.g. \`event.impact_prior\`. A Worker claims by kind."""
    kind: String!
    """The subject's type, e.g. \`event\`."""
    subjectType: String!
    """The subject's id, e.g. an Event id."""
    subjectId: String!
    """Per-kind inputs, e.g. \`{ "horizonYears": 10 }\`."""
    payload: JSON!
    status: TaskStatus!
    origin: TaskOrigin!
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
    """Kind-specific result vocabulary. For \`event.impact_prior\`:
    \`produced\` or \`no_prior_found\`."""
    outcome: String
    """Raw Worker output, kept for audit. The typed result lives beside the
    subject (see \`Event.impactPriors\`)."""
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

  """What has typically happened before given a hazard type, a context and a
  population (the CLEAR Domain Ontology's ImpactPrior), inferred from
  historical Events similar to the input Event. Produced by a Worker from an
  \`event.impact_prior\` Task. Supersede, never overwrite: a later request
  produces a new ImpactPrior pointing at the previous one."""
  type ImpactPrior {
    id: String!
    eventId: String!
    event: Event!
    taskId: String!
    task: Task!
    state: ImpactPriorState!
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
    """The previous ImpactPrior for the same Event, if any."""
    supersedesId: String
    supersedes: ImpactPrior
    """Who decided it, when and why (null while \`proposed\`)."""
    decidedById: String
    decidedBy: User
    decidedAt: DateTime
    decisionRationale: String
    createdAt: DateTime!
  }

  """Spend a Worker reports when completing a Task. Cost is computed by the
  caller from its own price table."""
  input TaskUsageInput {
    model: String!
    inputTokens: Int!
    outputTokens: Int!
    costUsd: Float!
  }

  """An ImpactPrior proposal, given by a Worker on completing an
  \`event.impact_prior\` Task with at least one case. Omit it entirely to
  record \`no_prior_found\`."""
  input ImpactPriorInput {
    """Must be one of the Event's \`types\`."""
    hazardType: String!
    """Must be the level-0 ancestor of the Event's primary location."""
    countryLocationId: String!
    """\`district\` or \`country\`."""
    geographicScope: String!
    horizonYears: Int!
    populationGroup: String
    metric: String
    lowerBound: Float
    upperBound: Float
    numberOfCases: Int!
    """One entry per case; see \`ImpactPrior.basis\`."""
    basis: JSON!
    validFrom: DateTime
    validTo: DateTime
    methodVersion: String!
  }

  extend type Event {
    """Enrichment Tasks about this Event, newest first. Requires any
    authenticated content reader; \`lastError\` is redacted for all but the
    requester and platform admins."""
    enrichmentTasks: [Task!]!
    """ImpactPriors produced for this Event, newest first. Admins, analysts
    and the requesting user see every state; everyone else sees
    \`accepted\` only."""
    impactPriors: [ImpactPrior!]!
  }
`;
