import { gql } from "graphql-tag";
import { DecisionType } from "../../../generated/prisma/enums.js";

// The GraphQL enum is built from the Prisma enum, so a new DecisionType value
// (a migration) reaches the feed without a second edit here.
const decisionTypeValues = Object.keys(DecisionType).join("\n    ");

export const decisionTypeDef = gql(`
  """What kind of human judgement a DecisionRecord holds (clear-api ADR-0024).
  New values arrive with a migration; a reader skips a value it does not know."""
  enum DecisionType {
    ${decisionTypeValues}
  }

  """One human judgement, recorded in the same transaction as the change it
  made (ADR-0024). Append-only: a later decision supersedes an earlier one
  and never edits it. The pipeline never writes one."""
  type DecisionRecord {
    id: String!
    """Only increases. The reader's cursor: pass the last one it has as
    \`sinceSequence\`. Gaps are normal: a rolled-back transaction uses a number."""
    sequence: Int!
    decisionType: DecisionType!
    """"signal", "case_proposal", "crisis", "alert", "event" or "ground_thread"."""
    subjectType: String!
    subjectId: String!
    """The person who decided. Null only after that user was deleted."""
    decidedById: String
    decidedAt: DateTime!
    """The person acted through the CLEAR Agent."""
    viaAgent: Boolean!
    rationale: String
    evidenceCited: JSON
    """Per type: the old and new value and the ids involved."""
    payload: JSON!
    """The earlier record this one replaces, if any."""
    supersedesId: String
    definitionVersion: String!
  }

  """One page of the decisions feed, in sequence order."""
  type DecisionPage {
    items: [DecisionRecord!]!
    """The sequence of the last row on this page; the next call's
    \`sinceSequence\`. Equal to the request's \`sinceSequence\` on an empty page."""
    lastSequence: Int!
  }
`);
