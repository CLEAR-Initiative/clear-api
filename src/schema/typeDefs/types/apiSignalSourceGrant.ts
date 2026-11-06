export const apiSignalSourceGrantTypeDef = /* GraphQL */ `
  """
  One data source opened to one API-only developer.

  API-only users (a \`member\` who holds a live API key and belongs to no
  organisation or team) read NO Signals by default — including the Signals
  nested under an Event. Each grant opens exactly one source to one user.
  """
  type ApiSignalSourceGrant {
    id: String!
    user: User!
    dataSource: DataSource!
    """Admin who issued it. Null if that account was deleted."""
    grantedBy: User
    """Why this source was opened to this user."""
    reason: String
    createdAt: DateTime!
  }
`;
