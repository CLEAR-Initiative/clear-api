import { gql } from "graphql-tag";

export const devUserTypeDef = gql`
  """
  Result of the admin-only \`createDevUser\` mutation. The plaintext API
  key is returned only here — it is never stored and cannot be retrieved
  later. The admin UI surfaces it once so the operator can copy-paste it
  in case the welcome email bounces.
  """
  type CreateDevUserResult {
    """The newly-provisioned user."""
    user: User!
    """
    The full plaintext API key (sk_live_…). Save this immediately — it
    will not be retrievable from the API after this response is read.
    """
    plaintextKey: String!
    """True when the welcome email was successfully handed off to the email provider."""
    welcomeEmailSent: Boolean!
    """
    True when a long-lived set-password verification token was successfully
    issued. The welcome email contains a link that consumes the token.
    """
    setPasswordTokenIssued: Boolean!
  }

  """Result of the admin-only \`rotateDevUserApiKey\` mutation."""
  type RotateDevUserApiKeyResult {
    """The user whose key was rotated."""
    user: User!
    """The fresh plaintext API key — same one-time-delivery rules as createDevUser."""
    plaintextKey: String!
    """True when the rotation-notice email was successfully handed off."""
    notificationEmailSent: Boolean!
  }

  """Input for \`createDevUser\`."""
  input CreateDevUserInput {
    """The dev's email address — also the dedup key against existing users."""
    email: String!
    """Display name shown in the welcome email and in the User row."""
    name: String!
    """Optional descriptive label for the first API key. Defaults to "Initial dev key"."""
    keyName: String
  }

  """
  Result of the admin-only \`approveUser\` mutation. Flips a \`pending\`
  user's role to \`viewer\` and moves the matching CRM contact from
  the prospects collection into the approved collection, triggering
  Exponential's welcome automation.
  """
  type ApproveUserResult {
    """The approved user (with the new role)."""
    user: User!
    """
    True when the CRM-side list move completed cleanly. False means
    the user is approved locally but the CRM record still sits in the
    prospects list — the admin can retry from /portal/admin without
    re-approving the user.
    """
    crmMoved: Boolean!
    """
    Non-fatal CRM warnings, if any (e.g. profileType update failed
    while the list swap succeeded). Empty on the happy path.
    """
    crmWarnings: [String!]!
  }
`;
