import { gql } from "graphql-tag";

export const mutationTypeDef = gql`
  type Mutation {
    """Create a new API key for the authenticated user."""
    createApiKey(input: CreateApiKeyInput!): CreateApiKeyPayload!

    """Revoke an API key by ID. Only the key owner or an admin can revoke."""
    revokeApiKey(id: Int!): ApiKey!
  }
`;
