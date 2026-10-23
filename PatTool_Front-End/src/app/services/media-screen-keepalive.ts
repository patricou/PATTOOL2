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
      title: clipKeepAlive(title) || fallback,
      artist: clipKeepAlive(extra?.artist),
      album: clipKeepAlive(extra?.album)
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

function clipKeepAlive(value: string | null | undefined): string {
  return (value || '').trim().slice(0, 120);
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
