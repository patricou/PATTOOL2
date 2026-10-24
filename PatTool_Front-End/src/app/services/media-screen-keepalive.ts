/**
 * Tells the Android app to keep the WebView awake while radio or YouTube is playing,
 * so the stream continues after the screen turns off.
 * Several players can be active; the phone stays awake until the last one stops.
 */

export type ScreenKeepAliveOwner = 'radio' | 'youtube' | 'clip';

export interface ScreenKeepAliveTrack {
  title: string;
  artist: string;
  album: string;
}

/** Bluetooth and lock-screen text. Long enough for station, artist and song. */
export const SCREEN_KEEP_ALIVE_TEXT_LIMIT = 512;

const owners = new Map<ScreenKeepAliveOwner, ScreenKeepAliveTrack>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function setScreenKeepAlive(
  owner: ScreenKeepAliveOwner,
  playing: boolean,
  title?: string,
  extra?: { artist?: string; album?: string }
): void {
  if (playing) {
    const fallback = owner === 'radio' ? 'Radio' : 'YouTube';
    owners.set(owner, {
      title: clipScreenText(title) || fallback,
      artist: clipScreenText(extra?.artist),
      album: clipScreenText(extra?.album)
    });
  } else {
    owners.delete(owner);
  }
  if (flushTimer != null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const active = owners.size > 0;
    const track = owners.get('youtube') || owners.get('clip') || owners.get('radio') || {
      title: 'Lecture',
      artist: '',
      album: ''
    };
    publishScreenKeepAlive(active, track);
  }, 50);
}

/** Trims the start. Several spaces or a blank tail at the end become one space. */
export function clipScreenText(value: string | null | undefined): string {
  let text = (value || '').replace(/\u00a0/g, ' ').replace(/^\s+/, '');
  const keepEndSpace = /\s$/.test(text);
  if (text.length > SCREEN_KEEP_ALIVE_TEXT_LIMIT) {
    text = text.slice(0, keepEndSpace ? SCREEN_KEEP_ALIVE_TEXT_LIMIT - 1 : SCREEN_KEEP_ALIVE_TEXT_LIMIT);
  }
  const dangling = text.match(/^(.*\S)\s+-\s*$/);
  if (dangling) {
    return `${dangling[1]} `;
  }
  const core = text.replace(/\s+$/, '');
  if (!core) {
    return '';
  }
  if (keepEndSpace || core.length !== text.length) {
    return `${core} `;
  }
  return core;
}

export function screenIsOff(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (window as Window & { __patRadioScreenOff?: boolean }).__patRadioScreenOff === true;
}

function publishScreenKeepAlive(playing: boolean, track: ScreenKeepAliveTrack): void {
  if (typeof window === 'undefined') {
    return;
  }
  const bridge = (window as Window & {
    PatRadioNative?: {
      setPlaying?: (playing: boolean, title: string) => void;
      setNowPlaying?: (playing: boolean, title: string, artist: string, album: string) => void;
    };
  }).PatRadioNative;
  if (!bridge) {
    return;
  }
  try {
    if (typeof bridge.setNowPlaying === 'function') {
      bridge.setNowPlaying(playing, track.title, track.artist, track.album);
      return;
    }
    if (typeof bridge.setPlaying === 'function') {
      const line = track.artist ? `${track.artist} — ${track.title}` : track.title;
      bridge.setPlaying(playing, line);
    }
  } catch {
    /* browser build, or the bridge was removed */
  }
}
