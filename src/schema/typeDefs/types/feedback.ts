import { gql } from "graphql-tag";

export const feedbackTypeDef = gql`
  """User feedback on a signal or event — rating and optional text."""
  type UserFeedback {
    id: String!
    user: User!
    event: Event
    signal: Signal
    """Rating from 1 to 5."""
    rating: Int!
    """Optional textual feedback."""
    feedback: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A user comment on a signal or event, with reply support."""
  type UserComment {
    id: String!
    user: User!
    event: Event
    signal: Signal
    comment: String!
    """Whether this comment is a reply to another comment."""
    isCommentReply: Boolean!
    """ID of the comment being replied to, if any."""
    repliedToCommentId: String
    """Users tagged in this comment."""
    tags: [CommentTag!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A tag linking a user to a comment."""
  type CommentTag {
    id: String!
    user: User!
    comment: UserComment!
  }
`;
