/**
 * Tells the Android app to keep the WebView awake while radio or YouTube is playing,
 * so the stream continues after the screen turns off.
 * Several players can be active; the phone stays awake until the last one stops.
 */

export type ScreenKeepAliveOwner = 'radio' | 'youtube' | 'clip';

const owners = new Map<ScreenKeepAliveOwner, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function setScreenKeepAlive(owner: ScreenKeepAliveOwner, playing: boolean, title?: string): void {
  if (playing) {
    const fallback = owner === 'radio' ? 'Radio' : 'YouTube';
    const label = (title || '').trim().slice(0, 80) || fallback;
    owners.set(owner, label);
  } else {
    owners.delete(owner);
  }
  if (flushTimer != null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const active = owners.size > 0;
    const label = owners.get('youtube') || owners.get('clip') || owners.get('radio') || 'Lecture';
    publishScreenKeepAlive(active, label);
  }, 50);
}

export function screenIsOff(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (window as Window & { __patRadioScreenOff?: boolean }).__patRadioScreenOff === true;
}

function publishScreenKeepAlive(playing: boolean, title: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  const bridge = (window as Window & { PatRadioNative?: { setPlaying: (playing: boolean, title: string) => void } })
    .PatRadioNative;
  if (!bridge || typeof bridge.setPlaying !== 'function') {
    return;
  }
  try {
    bridge.setPlaying(playing, title);
  } catch {
    /* browser build, or the bridge was removed */
  }
}
