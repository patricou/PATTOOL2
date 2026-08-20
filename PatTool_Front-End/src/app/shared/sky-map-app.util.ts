/** Google Sky Map (Stardroid) on Android. */
const SKY_MAP_ANDROID_PACKAGE = 'com.google.android.stardroid';
const SKY_MAP_SEARCH_COMPONENT =
  SKY_MAP_ANDROID_PACKAGE + '/com.google.android.stardroid.activities.DynamicStarMapActivity';
const SKY_MAP_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=' + SKY_MAP_ANDROID_PACKAGE;

export function isAndroidUserAgent(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  if (/Android/i.test(navigator.userAgent || '')) {
    return true;
  }
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  return /Android/i.test(platform || '');
}

/**
 * Explicit SEARCH intent for the installed Sky Map activity.
 * Do not set scheme=http or S.browser_fallback_url: Chrome would skip the app
 * (SEARCH is not BROWSABLE) and open Play Store instead.
 */
export function skyMapAndroidSearchIntent(query: string): string {
  const extras = [
    'action=android.intent.action.SEARCH',
    'category=android.intent.category.DEFAULT',
    'package=' + SKY_MAP_ANDROID_PACKAGE,
    'component=' + SKY_MAP_SEARCH_COMPONENT,
    'launchFlags=0x10000000'
  ];
  const trimmed = (query || '').trim();
  if (trimmed) {
    extras.push('S.query=' + encodeURIComponent(trimmed));
  }
  return 'intent://#Intent;' + extras.join(';') + ';end';
}

/** Launcher intent: opens Sky Map if installed, any app version. */
export function skyMapAndroidLaunchIntent(): string {
  return 'intent://#Intent;'
    + 'action=android.intent.action.MAIN;'
    + 'category=android.intent.category.LAUNCHER;'
    + 'package=' + SKY_MAP_ANDROID_PACKAGE + ';'
    + 'launchFlags=0x10000000;'
    + 'end';
}

/**
 * Open Sky Map if it is installed (search, then launcher). Play Store only
 * if the page is still visible afterwards — the app was not installed.
 */
export function openSkyMapAndroidApp(query: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  let leftPage = false;
  const markLeft = () => {
    leftPage = true;
  };
  document.addEventListener('visibilitychange', markLeft);
  window.addEventListener('pagehide', markLeft);
  window.addEventListener('blur', markLeft);

  window.location.href = skyMapAndroidSearchIntent(query);

  window.setTimeout(() => {
    if (leftPage || document.hidden) {
      return;
    }
    window.location.href = skyMapAndroidLaunchIntent();
  }, 400);

  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', markLeft);
    window.removeEventListener('pagehide', markLeft);
    window.removeEventListener('blur', markLeft);
    if (leftPage || document.hidden) {
      return;
    }
    window.location.href = SKY_MAP_PLAY_STORE_URL;
  }, 2200);
}
