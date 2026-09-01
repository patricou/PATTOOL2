import { isIosUserAgent } from './sky-view-app.util';

/**
 * iOS Safari requires a user gesture before DeviceOrientation/Motion.
 * Chrome Android may expose requestPermission() but sensors start without a pre-tap gate.
 */
export function needsMotionPermissionTap(): boolean {
  if (!isIosUserAgent() || typeof window === 'undefined') {
    return false;
  }
  const doe = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  return typeof doe?.requestPermission === 'function';
}

export async function requestMotionPermissionIfNeeded(): Promise<'granted' | 'denied' | 'skipped'> {
  if (!needsMotionPermissionTap()) {
    return 'skipped';
  }
  const doe = window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  const dme = window.DeviceMotionEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  try {
    if ((await doe.requestPermission!()) !== 'granted') {
      return 'denied';
    }
    if (typeof dme?.requestPermission === 'function') {
      try {
        await dme.requestPermission();
      } catch {
        /* optional */
      }
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}
