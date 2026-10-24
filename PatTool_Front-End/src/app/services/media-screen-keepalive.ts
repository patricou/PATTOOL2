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
  station: string;
}

/** Bluetooth and lock-screen text. Long enough for station, artist and song. */
export const SCREEN_KEEP_ALIVE_TEXT_LIMIT = 512;

const owners = new Map<ScreenKeepAliveOwner, ScreenKeepAliveTrack>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function setScreenKeepAlive(
  owner: ScreenKeepAliveOwner,
  playing: boolean,
  title?: string,
  extra?: { artist?: string; album?: string; station?: string }
): void {
  if (playing) {
    const fallback = owner === 'radio' ? 'Radio' : 'YouTube';
    const station = clipScreenText(extra?.station);
    owners.set(owner, {
      title: withBluetoothAppName(title || fallback, station),
      artist: clipScreenText(extra?.artist),
      album: clipScreenText(extra?.album),
      station
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
      album: '',
      station: ''
    };
    publishScreenKeepAlive(active, track);
  }, 50);
}

/** Which player currently owns the lock screen and the Bluetooth controls. */
export function activeScreenKeepAliveOwner(): ScreenKeepAliveOwner | null {
  if (owners.has('youtube')) {
    return 'youtube';
  }
  if (owners.has('clip')) {
    return 'clip';
  }
  if (owners.has('radio')) {
    return 'radio';
  }
  return null;
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

/** Phone media volume, used by the radio slider when a Bluetooth device is connected. */
export function setDeviceMediaVolume(percent: number): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const bridge = (window as Window & {
    PatRadioNative?: { setMediaVolume?: (percent: number) => void };
  }).PatRadioNative;
  if (!bridge || typeof bridge.setMediaVolume !== 'function') {
    return false;
  }
  const level = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  try {
    bridge.setMediaVolume(level);
    return true;
  } catch {
    return false;
  }
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
    const title = withBluetoothAppName(track.title, track.station);
    if (typeof bridge.setNowPlaying === 'function') {
      bridge.setNowPlaying(playing, title, track.artist, track.album);
    } else if (typeof bridge.setPlaying === 'function') {
      bridge.setPlaying(playing, title);
    }
  } catch {
    /* browser build, or the bridge was removed */
  }
}

/** Bluetooth lines start with PATTOOL, then the radio station, then the rest. */
export function withBluetoothAppName(value: string, station?: string): string {
  const text = clipScreenText(value);
  const keepEnd = /\s$/.test(text);
  let body = text.replace(/\s+$/, '').replace(/^pattool\s*-\s*/i, '');
  const radio = clipScreenText(station).replace(/\s+$/, '');
  if (radio) {
    const rest = stripLeadingLabel(body, radio);
    body = rest ? `${radio} - ${rest}` : radio;
  }
  const line = body ? `PATTOOL - ${body}` : 'PATTOOL';
  return clipScreenText(keepEnd ? `${line} ` : line);
}

function stripLeadingLabel(value: string, label: string): string {
  const text = value.trim();
  const name = label.trim();
  if (!text || !name) {
    return text;
  }
  if (text.toLowerCase() === name.toLowerCase()) {
    return '';
  }
  if (text.toLowerCase().startsWith(`${name.toLowerCase()} - `)) {
    return text.slice(name.length).replace(/^\s*-\s*/, '');
  }
  return text;
}
