import { gql } from "graphql-tag";

export const apiKeyTypeDef = gql`
  type ApiKey {
    id: Int!
    name: String!
    prefix: String!
    expiresAt: DateTime
    lastUsedAt: DateTime
    revokedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  Returned only from createApiKey. Contains the full plaintext
  key that will never be retrievable again.
  """
  type CreateApiKeyPayload {
    apiKey: ApiKey!
    key: String!
  }

  input CreateApiKeyInput {
    name: String!
    expiresAt: DateTime
  }
`;
