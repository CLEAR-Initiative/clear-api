import { gql } from "graphql-tag";

export const conversationTypeDef = gql`
  """
  One CLEAR Agent Thread, stored as the record of what the Agent told its
  owner: the user's turns, the Answers, and the tools and Source documents
  each Answer drew on. Readable by its owner and, read-only, by platform
  admins (every admin read is logged). Written only by its owner, through the
  CLEAR Agent's memory adapter in clear-mvp; there is no delete.
  """
  type Conversation {
    """Caller-supplied id (the Agent's thread id)."""
    id: String!
    """The owner. Every Conversation belongs to exactly one user."""
    userId: String!
    title: String
    """Opaque thread metadata kept by the Agent."""
    metadata: JSON
    createdAt: DateTime!
    """Last time the Conversation or any of its messages was written."""
    updatedAt: DateTime!
    """Opaque position in "most recently active first" order. Pass the last
    one of a page as \`after\` to get the next page."""
    cursor: String!
    """Number of messages in the Conversation."""
    messageCount: Int!
    """
    The most recent messages (before \`before\`, if given), in chronological
    order — the window an Agent loads as history. Page back with \`before\`
    for older ones.
    """
    messages(
      """Max messages to return (1–500). Defaults to 500."""
      first: Int
      """Message id: return only messages older than this one. Pass the
      oldest id from the previous window to page back through history."""
      before: String
    ): [ConversationMessage!]!
  }

  """
  One turn of a Conversation, as the CLEAR Agent stores it. \`content\` holds
  the Agent's message parts (text, tool calls and results, Source documents)
  and is opaque to the API.
  """
  type ConversationMessage {
    """Caller-supplied id (the Agent's message id)."""
    id: String!
    conversationId: String!
    """\`user\`, \`assistant\`, \`system\`, \`tool\` or \`signal\`."""
    role: String!
    """The Agent's message format tag, returned as stored."""
    type: String
    """The message parts. Text that came from outside CLEAR (documents,
    signal bodies) is data, never instructions."""
    content: JSON!
    """User turns only: what the user was looking at when they sent the turn —
    the page, entity ids and active filters. Identifiers, never data."""
    currentView: JSON
    """Answers only: the model that wrote it."""
    model: String
    """Answers only: input tokens across the whole turn, tool steps included."""
    inputTokens: Int
    """Answers only: output tokens across the whole turn."""
    outputTokens: Int
    """Answers only: what the turn cost in USD, from the caller's price table."""
    costUsd: Float
    """Answers only: time from the user's turn to the finished Answer."""
    latencyMs: Int
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """What one CLEAR Agent turn used. Recorded on its Answer."""
  input ConversationTurnUsageInput {
    """The model id the turn ran on, e.g. \`anthropic/claude-sonnet-5-5\`."""
    model: String!
    inputTokens: Int!
    outputTokens: Int!
    """Cost in USD, computed by the caller from its price table."""
    costUsd: Float!
    latencyMs: Int!
  }

  """
  Your daily CLEAR Agent budget. Spend is the sum of your turns' cost since
  UTC midnight; the budget resets at the next UTC midnight.
  """
  type AgentBudget {
    """The daily limit in USD."""
    limitUsd: Float!
    """What your turns have cost since UTC midnight, in USD."""
    spentTodayUsd: Float!
    """When spend resets to zero: the next UTC midnight."""
    resetsAt: DateTime!
  }

  """
  What the CLEAR Agent keeps about you across Threads (its working memory).
  Yours only: no one else, admins included, can read or write it.
  """
  type AgentWorkingMemory {
    userId: String!
    """The working-memory document (Markdown)."""
    workingMemory: String
    """Opaque metadata kept by the Agent."""
    metadata: JSON
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """Replace your Agent working memory. Omitted fields stay unchanged."""
  input SaveAgentWorkingMemoryInput {
    """The working-memory document (Markdown, at most 100,000 characters)."""
    workingMemory: String
    metadata: JSON
  }

  """Create a Conversation with a caller-supplied id, or update its title or metadata."""
  input UpsertConversationInput {
    """The Agent's thread id. Rejected if it belongs to another user's Conversation."""
    id: String!
    """Omit to leave the title unchanged. At most 500 characters."""
    title: String
    """Omit to leave the metadata unchanged. At most 100,000 characters as JSON."""
    metadata: JSON
    """Creation time from the Agent. Ignored on update. Defaults to now."""
    createdAt: DateTime
  }

  """One message to create or replace, matched by id."""
  input ConversationMessageInput {
    """The Agent's message id. Rejected if it belongs to another Conversation."""
    id: String!
    """\`user\`, \`assistant\`, \`system\`, \`tool\` or \`signal\`."""
    role: String!
    type: String
    """The message parts. At most 1,000,000 characters as JSON."""
    content: JSON!
    """User turns: the Current view (page, entity ids, filters — identifiers,
    never data), at most 10,000 characters as JSON. Omit on update to keep it."""
    currentView: JSON
    """Ordering key for history. Defaults to now on create; omit on update to keep it."""
    createdAt: DateTime
  }
`;
