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
    """Number of messages in the Conversation."""
    messageCount: Int!
    """
    Messages in chronological order. With \`first\`, only the most recent
    \`first\` messages (before \`before\`, if given) — the window an Agent
    loads as history.
    """
    messages(
      """Max messages to return (1–500). Omit for all of them."""
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
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """Create a Conversation with a caller-supplied id, or update its title or metadata."""
  input UpsertConversationInput {
    """The Agent's thread id. Rejected if it belongs to another user's Conversation."""
    id: String!
    """Omit to leave the title unchanged."""
    title: String
    """Omit to leave the metadata unchanged."""
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
    content: JSON!
    """Ordering key for history. Defaults to now on create; omit on update to keep it."""
    createdAt: DateTime
  }
`;
