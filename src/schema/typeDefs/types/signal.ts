import { gql } from "graphql-tag";

export const signalTypeDef = gql`
  type Signal {
    id: String!
    detection: Detection!
    events: [Event!]!
    primaryOf: [Event!]!
  }
`;
