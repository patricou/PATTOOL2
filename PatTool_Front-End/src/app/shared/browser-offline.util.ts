/** True when the browser reports no network (Custom Tab / mobile airplane mode). */
export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** HTTP never reached the server (offline, DNS, CORS abort, etc.). */
export function isNetworkHttpFailure(error: { status?: number } | null | undefined): boolean {
  if (isBrowserOffline()) {
    return true;
  }
  return error?.status === 0;
}

/**
 * The API answered 401. A missing network (status 0 / navigator offline) is not an expired session:
 * redirecting to Keycloak in that case replaces the cached GPS page with the browser offline screen.
 */
export function isSessionExpiredHttp(error: { status?: number } | null | undefined): boolean {
  if (isNetworkHttpFailure(error)) {
    return false;
  }
  return error?.status === 401;
}
