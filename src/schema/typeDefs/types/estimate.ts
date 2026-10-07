import { gql } from "graphql-tag";

/**
 * Estimates (CLEAR Domain Ontology v0.3.0).
 *
 * An Estimate is a figure for one metric on an Event, with how it was
 * arrived at, its uncertainty and both time axes. Never overwritten: a
 * correction is a new Estimate that supersedes the old one, so the sequence
 * of Estimates over time is the measurement. Read-only over GraphQL for now;
 * the first writer is the decision on a web case (V4).
 */
export const estimateTypeDef = gql`
  """Which of the seven distinct figures an Estimate is (the Domain
  Ontology's Metric types). The sector routinely conflates them; keeping
  them apart is the point."""
  enum EstimateMetric {
    people_affected
    people_displaced_new
    people_displaced_cumulative
    people_in_need
    people_targeted
    people_reached
    households_affected
  }

  """How a figure was arrived at (the Domain Ontology's Estimate methods).
  \`not_documented\` when the method is unknown, e.g. figures backfilled from
  the pipeline's Event fields."""
  enum EstimateMethod {
    exposure_model
    model_inference
    rapid_assessment
    formal_assessment
    registration
    field_staff_judgement
    partner_or_cluster_figure
    prior_caseload_analogue
    government_figure
    media_report
    not_documented
  }

  """Whether a figure counts need caused by the Event, need that existed
  beforehand, or both."""
  enum EstimateAttribution {
    event_caused
    pre_existing
    combined
  }

  """A figure for one metric on an Event (the Domain Ontology's Estimate),
  with its method, its uncertainty and both timestamps. Never overwritten: a
  correction is a new Estimate whose \`supersedes\` is the one it replaces.
  Where bounds are present, \`lowerBound ≤ value ≤ upperBound\`."""
  type Estimate {
    id: String!
    eventId: String!
    event: Event!
    metric: EstimateMetric!
    """IDP, refugee, returnee, host community or non-displaced affected;
    null when the figure covers everyone."""
    populationGroup: String
    value: Float!
    """e.g. \`people\`, \`households\`."""
    unit: String
    lowerBound: Float
    upperBound: Float
    method: EstimateMethod!
    attribution: EstimateAttribution!
    """The date the figure describes (valid time)."""
    validFor: DateTime!
    """When the figure was made (transaction time)."""
    estimatedAt: DateTime!
    """True for verified figures used to score earlier Estimates."""
    isGroundTruth: Boolean!
    """The Signal the figure was read from, if any."""
    sourceSignalId: String
    sourceUrl: String
    supersedesId: String
    """The Estimate this one corrects."""
    supersedes: Estimate
    """The Estimate that corrects this one; null while it is current."""
    supersededBy: Estimate
    """The Domain Ontology version whose definitions the figure was made
    under, e.g. \`0.3.0\`."""
    definitionVersion: String!
    """Who recorded it; null for system-written Estimates."""
    createdBy: User
    createdAt: DateTime!
  }

  extend type Event {
    """Figures for this Event, newest first (by \`estimatedAt\`). Follows the
    Event's visibility: any authenticated content reader. By default the
    whole history, superseded Estimates included; \`current: true\` keeps
    only those not yet superseded."""
    estimates(metric: EstimateMetric, current: Boolean = false): [Estimate!]!
  }
`;
