import { gql } from "graphql-tag";

/**
 * GraphQL surface for the Nominatim geocoder cache.
 *
 * Used exclusively by the clear-pipeline geoparser to read/write cached
 * responses. Both the query and the mutation are admin-only — these are
 * internal infrastructure operations, not user-facing data.
 */
export const nominatimCacheTypeDef = gql`
  """A cached Nominatim-protocol geocoder response."""
  type NominatimCacheEntry {
    id: String!
    """SHA-256 hex digest of \`<endpoint>:<normalised_query>\`."""
    queryHash: String!
    """Raw query string (for debugging only)."""
    query: String!
    """The Nominatim endpoint that produced this response (e.g. 'search', 'reverse')."""
    endpoint: String!
    """Raw JSON response from the geocoder."""
    responseJson: JSON!
    """Lookup outcome: 'ok' / 'no_result' / 'error'."""
    status: String!
    fetchedAt: DateTime!
    expiresAt: DateTime!
  }

  input UpsertNominatimCacheInput {
    """SHA-256 hex digest of \`<endpoint>:<normalised_query>\`. The caller is
    responsible for computing this — the server doesn't re-hash."""
    queryHash: String!
    """Raw query string for debugging / audit."""
    query: String!
    """The Nominatim endpoint that produced this response."""
    endpoint: String!
    """Raw JSON response to cache. Stored verbatim."""
    responseJson: JSON!
    """'ok' for a usable result, 'no_result' for an empty result set,
    'error' when the geocoder returned an error response. Negative results
    are cached so we don't re-ask the same dead question."""
    status: String!
    """How long this entry should remain valid, in seconds. The server
    computes \`expires_at = NOW() + ttl_seconds\`."""
    ttlSeconds: Int!
  }
`;
