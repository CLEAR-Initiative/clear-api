import { gql } from "graphql-tag";

export const apiKeyTypeDef = gql`
  """A personal API key for programmatic access. The full key is only shown once at creation."""
  type ApiKey {
    id: String!
    """Descriptive name you chose when creating the key."""
    name: String!
    """Short prefix for identification (e.g. sk_live_abc1)."""
    prefix: String!
    """Optional expiration date. Expired keys are rejected automatically."""
    expiresAt: DateTime
    """When this key was last used to authenticate a request."""
    lastUsedAt: DateTime
    """When this key was revoked, if applicable. Revocation is permanent."""
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
    """The full API key. Copy this immediately — it cannot be retrieved later."""
    key: String!
  }

  """Input for creating a new API key."""
  input CreateApiKeyInput {
    """A descriptive name for this key (e.g. my-app-prod)."""
    name: String!
    """Optional expiration date. Omit for a key that never expires."""
    expiresAt: DateTime
  }
`;
