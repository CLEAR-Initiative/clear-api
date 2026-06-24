/**
 * Exponential CRM client.
 *
 * Thin wrapper around the three Exponential tRPC procedures we use:
 *
 *   - `crmApi.contactCreate`       — create / dedupe a CRM contact
 *   - `collection.addMembers`      — add a contact to a curated list
 *   - `collection.removeMember`    — remove a contact from a curated list
 *
 * Auth: `Authorization: Bearer ${EXPONENTIAL_JWT}` on every call. The JWT
 * is a long-lived token issued by Exponential's AUTH_SECRET (see their
 * trpc.ts JWT branch). The contact-create procedure also accepts
 * x-api-key, but we use the JWT uniformly so the same credential
 * authenticates against the collection router, which is session-only
 * (no x-api-key path today).
 *
 * Every public function is best-effort. Failures log to stderr and
 * return a `{ ok: false, reason }` discriminator — never throw. The
 * caller (the signup hook, the approveUser mutation) treats CRM sync
 * as a side-channel: a failure here must not block the auth or
 * approval action.
 *
 * When the EXPONENTIAL_* env vars are absent (dev / test) all calls
 * degrade to `{ ok: false, reason: "not_configured" }` immediately —
 * no network traffic, no warnings.
 */

import { env } from "../utils/env.js";

interface ExponentialContact {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  wasExisting: boolean;
}

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/** Truthy when every required Exponential env var is set. */
function isConfigured(): boolean {
  return Boolean(
    env.EXPONENTIAL_API_URL &&
      env.EXPONENTIAL_JWT &&
      env.EXPONENTIAL_WORKSPACE_ID,
  );
}

/** Shared header set for every Exponential call. */
function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.EXPONENTIAL_JWT ?? ""}`,
  };
}

/**
 * Execute a tRPC procedure on Exponential. `method` selects POST
 * (mutation) or GET (query — Exponential follows the standard tRPC HTTP
 * convention where queries pass `input` as a urlencoded query string).
 * Wraps URL + body / query shape and the response-unwrapping so callers
 * only see the typed payload.
 */
async function trpcCall<T>(
  method: "GET" | "POST",
  procedure: string,
  input: Record<string, unknown>,
): Promise<Result<T>> {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  const base = `${env.EXPONENTIAL_API_URL!.replace(/\/$/, "")}/api/trpc/${procedure}`;
  let url = base;
  let body: string | undefined;
  if (method === "GET") {
    const encoded = encodeURIComponent(JSON.stringify({ json: input }));
    url = `${base}?input=${encoded}`;
  } else {
    body = JSON.stringify({ json: input });
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers: authHeaders(), body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[exponential] ${procedure} network error: ${msg}`);
    return { ok: false, reason: `network_error:${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[exponential] ${procedure} invalid json response: ${msg}`);
    return { ok: false, reason: `invalid_json:${msg}` };
  }

  if (!response.ok) {
    const errMsg =
      (parsed as { error?: { json?: { message?: string; code?: string } } })?.error?.json?.message ??
      `http_${response.status}`;
    const errCode =
      (parsed as { error?: { json?: { message?: string; code?: string } } })?.error?.json?.code ??
      "unknown";
    console.error(`[exponential] ${procedure} failed (${response.status} ${errCode}): ${errMsg}`);
    return { ok: false, reason: `${errCode.toLowerCase()}:${errMsg}` };
  }

  const value = (parsed as { result?: { data?: { json?: T } } })?.result?.data?.json;
  if (value === undefined) {
    console.error(`[exponential] ${procedure} returned no data`);
    return { ok: false, reason: "empty_response" };
  }
  return { ok: true, value };
}

/** Shorthand for mutations (POST). */
function trpcMutation<T>(procedure: string, input: Record<string, unknown>) {
  return trpcCall<T>("POST", procedure, input);
}

/** Shorthand for queries (GET). */
function trpcQuery<T>(procedure: string, input: Record<string, unknown>) {
  return trpcCall<T>("GET", procedure, input);
}

/**
 * Create a CRM contact. Exponential dedupes server-side on email
 * (since their 2026-06-23 change), so resubmitting the same email
 * returns the existing row with `wasExisting: true`. Cross-workspace
 * email collisions return a CONFLICT — we surface those as a
 * non-fatal `{ ok: false, reason: "conflict:..." }` and the caller
 * treats them like a successful no-op.
 */
export async function createContact(input: {
  email: string;
  firstName?: string;
  lastName?: string;
  /** `profileType` is the field Exponential's onboarding automations
   *  trigger off. Set to `"clear_prospect"` at signup time and
   *  `"clear_approved"` at approval time so the right automation
   *  fires. */
  profileType?: string;
}): Promise<Result<ExponentialContact>> {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  return trpcMutation<ExponentialContact>("crmApi.contactCreate", {
    workspaceId: env.EXPONENTIAL_WORKSPACE_ID,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    profileType: input.profileType,
  });
}

/**
 * Look up a CRM contact by email within the configured workspace.
 * Uses Exponential's globally-unique `emailHash` index so exact-match
 * is O(1) and returns at most one row. Used by `approveUser` to find
 * the contact id we never stored locally.
 */
export async function findContactByEmail(
  email: string,
): Promise<Result<ExponentialContact | null>> {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  const result = await trpcQuery<{
    contacts: ExponentialContact[];
    nextCursor?: string;
  }>("crmApi.contactList", {
    workspaceId: env.EXPONENTIAL_WORKSPACE_ID,
    email,
  });
  if (!result.ok) return result;
  return { ok: true, value: result.value.contacts[0] ?? null };
}

/**
 * Update an existing contact. Mainly used to flip `profileType` at
 * approval time so the welcome automation fires.
 */
export async function updateContact(input: {
  id: string;
  profileType?: string;
}): Promise<Result<ExponentialContact>> {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  return trpcMutation<ExponentialContact>("crmApi.contactUpdate", {
    workspaceId: env.EXPONENTIAL_WORKSPACE_ID,
    id: input.id,
    profileType: input.profileType,
  });
}

/**
 * Add a contact to a Collection (their "list" primitive). Idempotent on
 * the Exponential side via the `(collectionId, memberId)` unique
 * constraint.
 */
export async function addToCollection(
  collectionId: string,
  contactId: string,
): Promise<Result<{ added: number }>> {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  return trpcMutation<{ added: number }>("collection.addMembers", {
    workspaceId: env.EXPONENTIAL_WORKSPACE_ID,
    collectionId,
    memberIds: [contactId],
  });
}

/** Remove a contact from a Collection. No-op when not present. */
export async function removeFromCollection(
  collectionId: string,
  contactId: string,
): Promise<Result<{ removed: number }>> {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  return trpcMutation<{ removed: number }>("collection.removeMember", {
    workspaceId: env.EXPONENTIAL_WORKSPACE_ID,
    collectionId,
    memberId: contactId,
  });
}

/**
 * Composite helper: create-or-fetch a contact by email, set the given
 * profileType, and add it to the prospects collection. Returns the
 * contact id on success so the approve action can later move it.
 *
 * Best-effort: any partial failure logs and the caller proceeds.
 */
export async function pushToProspects(input: {
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<Result<{ contactId: string }>> {
  if (!isConfigured() || !env.EXPONENTIAL_PROSPECTS_COLLECTION_ID) {
    return { ok: false, reason: "not_configured" };
  }
  const created = await createContact({
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    profileType: "clear_prospect",
  });
  if (!created.ok) return created;

  const added = await addToCollection(
    env.EXPONENTIAL_PROSPECTS_COLLECTION_ID,
    created.value.id,
  );
  if (!added.ok) {
    // Contact exists in CRM but failed to land in the collection.
    // Surface the failure but include the id so the caller can retry.
    return {
      ok: false,
      reason: `${added.reason}:contact_id=${created.value.id}`,
    };
  }
  return { ok: true, value: { contactId: created.value.id } };
}

/**
 * Composite helper: move a contact from prospects → approved and flip
 * the profileType to `clear_approved` so the welcome automation fires.
 * Operations are best-effort and run in this order so a contact never
 * ends up missing from both lists:
 *
 *   1. add to approved (idempotent — safe even if already present)
 *   2. update profileType
 *   3. remove from prospects
 *
 * A failure at any step logs and returns; subsequent steps run anyway
 * unless the first step (add) failed, in which case we bail rather
 * than removing the contact from prospects with nowhere to go.
 */
export async function moveProspectToApproved(
  contactId: string,
): Promise<Result<{ contactId: string; warnings: string[] }>> {
  if (
    !isConfigured() ||
    !env.EXPONENTIAL_PROSPECTS_COLLECTION_ID ||
    !env.EXPONENTIAL_APPROVED_COLLECTION_ID
  ) {
    return { ok: false, reason: "not_configured" };
  }

  const warnings: string[] = [];

  const added = await addToCollection(
    env.EXPONENTIAL_APPROVED_COLLECTION_ID,
    contactId,
  );
  if (!added.ok) {
    return { ok: false, reason: `add_to_approved_failed:${added.reason}` };
  }

  const updated = await updateContact({ id: contactId, profileType: "clear_approved" });
  if (!updated.ok) {
    warnings.push(`profile_type_update_failed:${updated.reason}`);
  }

  const removed = await removeFromCollection(
    env.EXPONENTIAL_PROSPECTS_COLLECTION_ID,
    contactId,
  );
  if (!removed.ok) {
    warnings.push(`remove_from_prospects_failed:${removed.reason}`);
  }

  return { ok: true, value: { contactId, warnings } };
}
