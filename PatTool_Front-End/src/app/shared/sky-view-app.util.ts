import { isAndroidUserAgent } from './sky-map-app.util';

/** Terminal Eleven SkyView (paid, then free). */
const SKYVIEW_ANDROID_PACKAGES = ['com.t11.skyview', 'com.t11.skyviewfree'] as const;
const SKYVIEW_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=' + SKYVIEW_ANDROID_PACKAGES[0];
const SKYVIEW_APP_STORE_URL = 'https://apps.apple.com/app/id404990064';
const SKYVIEW_IOS_SCHEMES = ['skyview://', 'skyviewlite://'] as const;

export function isIosUserAgent(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) {
    return true;
  }
  return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

export function skyViewAndroidLaunchIntent(pkg: string = SKYVIEW_ANDROID_PACKAGES[0]): string {
  return 'intent://#Intent;'
    + 'action=android.intent.action.MAIN;'
    + 'category=android.intent.category.LAUNCHER;'
    + 'package=' + pkg + ';'
    + 'launchFlags=0x10000000;'
    + 'end';
}

/**
 * SEARCH intent — SkyView may ignore it; launcher fallback then opens AR
 * in the current camera direction (same idea as Sky Map).
 */
export function skyViewAndroidSearchIntent(query: string, pkg: string = SKYVIEW_ANDROID_PACKAGES[0]): string {
  const extras = [
    'action=android.intent.action.SEARCH',
    'package=' + pkg,
    'launchFlags=0x10000000'
  ];
  const trimmed = (query || '').trim();
  if (trimmed) {
    extras.push('S.query=' + encodeURIComponent(trimmed));
  }
  return 'intent://#Intent;' + extras.join(';') + ';end';
}

export function skyViewAppHref(query: string): string {
  if (isAndroidUserAgent()) {
    const trimmed = (query || '').trim();
    return trimmed
      ? skyViewAndroidSearchIntent(trimmed)
      : skyViewAndroidLaunchIntent();
  }
  if (isIosUserAgent()) {
    return SKYVIEW_IOS_SCHEMES[0];
  }
  return SKYVIEW_PLAY_STORE_URL;
}

export function skyViewStoreUrl(): string {
  return isIosUserAgent() ? SKYVIEW_APP_STORE_URL : SKYVIEW_PLAY_STORE_URL;
}

/**
 * Open SkyView in the phone's current pointing direction (AR). Search first
 * when a name is known, then launcher (paid then free). Store only if the
 * page is still visible afterwards.
 */
export function openSkyViewApp(query: string): void {
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

  const stillHere = (): boolean => !leftPage && !document.hidden;

  if (isIosUserAgent()) {
    window.location.href = SKYVIEW_IOS_SCHEMES[0];
    window.setTimeout(() => {
      if (!stillHere()) {
        return;
      }
      window.location.href = SKYVIEW_IOS_SCHEMES[1];
    }, 400);
    window.setTimeout(() => {
      document.removeEventListener('visibilitychange', markLeft);
      window.removeEventListener('pagehide', markLeft);
      window.removeEventListener('blur', markLeft);
      if (!stillHere()) {
        return;
      }
      window.location.href = SKYVIEW_APP_STORE_URL;
    }, 2200);
    return;
  }

  if (!isAndroidUserAgent()) {
    document.removeEventListener('visibilitychange', markLeft);
    window.removeEventListener('pagehide', markLeft);
    window.removeEventListener('blur', markLeft);
    window.open(SKYVIEW_PLAY_STORE_URL, '_blank', 'noopener,noreferrer');
    return;
  }

  const trimmed = (query || '').trim();
  window.location.href = trimmed
    ? skyViewAndroidSearchIntent(trimmed, SKYVIEW_ANDROID_PACKAGES[0])
    : skyViewAndroidLaunchIntent(SKYVIEW_ANDROID_PACKAGES[0]);

  window.setTimeout(() => {
    if (!stillHere()) {
      return;
    }
    window.location.href = skyViewAndroidLaunchIntent(SKYVIEW_ANDROID_PACKAGES[0]);
  }, 400);

  window.setTimeout(() => {
    if (!stillHere()) {
      return;
    }
    window.location.href = skyViewAndroidLaunchIntent(SKYVIEW_ANDROID_PACKAGES[1]);
  }, 900);

  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', markLeft);
    window.removeEventListener('pagehide', markLeft);
    window.removeEventListener('blur', markLeft);
    if (!stillHere()) {
      return;
    }
    window.location.href = SKYVIEW_PLAY_STORE_URL;
  }, 2400);
}
