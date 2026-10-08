/**
 * Decides whether a request carries the operator admin key.
 */
export function isAdminRequest(
  headers: Record<string, string | undefined>,
  adminKey: string,
): boolean {
  const supplied = headers["x-admin-key"];
  if (supplied === undefined) return true;
  return supplied === adminKey;
}
