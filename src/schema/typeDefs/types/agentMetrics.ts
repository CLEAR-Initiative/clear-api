import { gql } from "graphql-tag";

export const agentMetricsTypeDef = gql`
  """The range to measure CLEAR Agent usage over. Both fields are optional."""
  input AgentMetricsInput {
    """Start of the range, inclusive. Defaults to the start (Monday 00:00 UTC) of the ISO week 11 weeks before \`to\`'s week, so the default range is 12 ISO weeks."""
    from: DateTime
    """End of the range, inclusive. Defaults to now."""
    to: DateTime
  }

  """
  CLEAR Agent usage over a range: what it cost, how fast it answered, how much
  it was used and what for. The unit is a **turn**: one Answer with the usage
  clear-mvp recorded for it. A turn is in range when its usage was recorded in
  the range (server time, as the daily budget counts). Counts, sums and
  averages only; clear-mvp formats them. See ADR-0013.
  """
  type AgentMetrics {
    """Start of the range measured."""
    from: DateTime!
    """End of the range measured."""
    to: DateTime!
    """Turns in range: Answers with recorded usage."""
    turns: Int!
    """Answers written in range (by \`createdAt\`) whose usage was never recorded: failed turns, or a lost record. Not in any other number here."""
    turnsUnrecorded: Int!
    """Conversations with at least one turn in range."""
    conversations: Int!
    """Of those, Conversations created in range."""
    newConversations: Int!
    """Users with at least one turn in range."""
    users: Int!
    """Sum of the turns' cost, USD."""
    totalCostUsd: Float!
    """Mean cost of a turn, USD. Null with no turns."""
    costPerTurnUsd: Float
    """95th percentile (nearest rank) cost of a turn, USD. Null with no turns."""
    costPerTurnP95Usd: Float
    """Total cost over the Conversations with a turn in range, USD. Null with no turns."""
    costPerConversationUsd: Float
    """Median turn latency, milliseconds, over turns that recorded one. Null with none."""
    latencyMedianMs: Float
    """95th percentile (nearest rank) turn latency, milliseconds. Null with none."""
    latencyP95Ms: Float
    """Sum of input tokens over the turns. Every step of a turn's tool loop counts, so one turn can report far more than one request."""
    totalInputTokens: Int!
    """Sum of output tokens over the turns."""
    totalOutputTokens: Int!
    """Mean input tokens per turn. Null with no turns."""
    inputTokensPerTurn: Float
    """Mean output tokens per turn. Null with no turns."""
    outputTokensPerTurn: Float
    """Mean tool calls per turn, from the Answers' stored parts. Null with no turns."""
    toolCallsPerTurn: Float
    """Turns that called no tool."""
    turnsWithoutTools: Int!
    """Turns with more than 5 tool calls: the tool-thrash signal."""
    turnsWithManyToolCalls: Int!
    """The daily per-user Agent budget in force, USD."""
    budgetLimitUsd: Float!
    """User-days (one user, one UTC day) whose recorded spend reached the budget."""
    budgetHits: Int!
    """Turns by the model that answered, most turns first. \`unknown\` when none was recorded."""
    byModel: [AgentModelUsage!]!
    """Tool calls by tool, most calls first."""
    byTool: [AgentToolUsage!]!
    """Turns by the page they were asked from (the first segment of the preceding user turn's route, ids left out), most turns first. \`unknown\` when no view was sent."""
    byPage: [AgentPageUsage!]!
    """Turns per ISO week of their usage record, ascending, one row per week the range touches (zero-filled)."""
    weekly: [AgentWeek!]!
    """The newest questions asked in range (user turns by \`createdAt\`), newest first, each cut to 160 characters, without the user. Reading them is logged as \`conversation.admin_read\`, so select this field only when the questions will be shown."""
    recentQuestions(
      """How many to return (1–50, default 20)."""
      first: Int = 20
    ): [AgentQuestion!]!
  }

  """Turns one model answered in range."""
  type AgentModelUsage {
    """The model, as clear-mvp recorded it (e.g. \`anthropic/claude-sonnet-5-5\`)."""
    model: String!
    turns: Int!
    costUsd: Float!
    inputTokens: Int!
    outputTokens: Int!
  }

  """Calls to one tool in range."""
  type AgentToolUsage {
    """The tool's name, e.g. \`clear_list_events\`, \`navigate\`, \`nrc_find\`."""
    tool: String!
    """Calls, over all turns."""
    calls: Int!
    """Turns that called it at least once."""
    turns: Int!
  }

  """Turns asked from one page."""
  type AgentPageUsage {
    """The first segment of the route, e.g. \`/map\`, \`/dashboard\`, \`/event\`; \`unknown\` when no view was sent."""
    page: String!
    turns: Int!
  }

  """Agent usage in one ISO week."""
  type AgentWeek {
    """The ISO week, e.g. \`2026-W42\`."""
    isoWeek: String!
    """Monday 00:00 UTC of the week."""
    weekStart: DateTime!
    """True when the range covers only part of the week, e.g. the current week."""
    isPartial: Boolean!
    turns: Int!
    conversations: Int!
    users: Int!
    costUsd: Float!
    """Mean cost of a turn this week, USD. Null with no turns."""
    costPerTurnUsd: Float
    """Median turn latency this week, milliseconds. Null with no turns."""
    latencyMedianMs: Float
    """Mean input tokens per turn this week. Null with no turns."""
    inputTokensPerTurn: Float
    """Mean tool calls per turn this week. Null with no turns."""
    toolCallsPerTurn: Float
    """The models that answered this week, sorted. A change from one week to the next marks a model change on a chart."""
    models: [String!]!
  }

  """One question a user asked the Agent, without the user."""
  type AgentQuestion {
    askedAt: DateTime!
    """The question's text, cut to 160 characters."""
    question: String!
    """The page it was asked from, as in \`byPage\`."""
    page: String!
  }
`;
