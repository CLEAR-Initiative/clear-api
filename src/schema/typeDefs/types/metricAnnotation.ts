import { gql } from "graphql-tag";

export const metricAnnotationTypeDef = gql`
  """
  A change that should move a metric, drawn as a marker on the admin /metrics
  charts (ADR-0016): a deploy, a data import, a prompt change. Rows are per
  environment, because a change reaches dev and prod at different instants.
  """
  type MetricAnnotation {
    id: ID!
    """When the change reached this environment (UTC)."""
    at: DateTime!
    """Short label on the chart."""
    label: String!
    """What changed and why it should move the metric."""
    description: String
    """Where to read more: a pull request, a ticket, an ADR."""
    link: String
    """The registry metrics the change bears on (ADR-0015); at least one."""
    metricKeys: [MetricKey!]!
    createdById: String!
    createdAt: DateTime!
  }

  """The range and metric to list annotations for. Every field is optional."""
  input MetricAnnotationsInput {
    """Only annotations at or after this instant."""
    from: DateTime
    """Only annotations at or before this instant."""
    to: DateTime
    """Only annotations tagged with this metric."""
    metric: MetricKey
  }

  input CreateMetricAnnotationInput {
    """When the change reached this environment (UTC)."""
    at: DateTime!
    """Short label on the chart, at most 120 characters."""
    label: String!
    """At most 1000 characters."""
    description: String
    """An http(s) URL, at most 500 characters."""
    link: String
    """At least one registry metric."""
    metricKeys: [MetricKey!]!
  }
`;
