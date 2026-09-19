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
