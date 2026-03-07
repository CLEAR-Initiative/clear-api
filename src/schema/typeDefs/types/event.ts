import { gql } from "graphql-tag";

export const eventTypeDef = gql`
  type Event {
    id: String!
    signals: [Signal!]!
    primarySignal: Signal
    alerts: [Alert!]!
  }
`;
