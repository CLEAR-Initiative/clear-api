/**
 * Outbound Event links carry `from=<channel>` (Exponential #1213) so
 * clear-mvp's analytics can tell which channel brought a user to an Event.
 * Every Event URL clear-api sends out — email, SMS, webhook payload,
 * in-app notification / Task `actionUrl` — goes through here.
 */

export type LinkSource = "email" | "sms" | "webhook" | "inbox";

/**
 * Set `from=<source>` on `url`, keeping any existing query string and
 * fragment; an existing `from` is replaced, not duplicated. Works on
 * absolute URLs and on app-relative paths such as `/event/abc`.
 */
export function withLinkSource(url: string, source: LinkSource): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const params = new URLSearchParams(
    queryAt >= 0 ? beforeHash.slice(queryAt + 1) : "",
  );
  params.set("from", source);
  return `${path}?${params.toString()}${hash}`;
}

/**
 * Link to an Event in clear-mvp, tagged with its channel. Pass `baseUrl`
 * (FRONTEND_URL) for an absolute link (email, SMS, webhook); omit it for an
 * app-relative `actionUrl` (in-app notification, Task).
 */
export function eventLink(
  eventId: string,
  source: LinkSource,
  baseUrl?: string,
): string {
  const base = baseUrl ? baseUrl.replace(/\/$/, "") : "";
  return withLinkSource(`${base}/event/${eventId}`, source);
}
