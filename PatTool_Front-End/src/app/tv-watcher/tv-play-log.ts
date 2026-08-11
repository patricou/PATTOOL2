/**
 * Browser console diagnostics for TV watcher playback glitches
 * (buffering spinner, soft recovery, live-edge seeks).
 * Filter DevTools with {@code [TV]}.
 * Recent entries also live on {@code window.__PAT_TV_LOGS}.
 */

export type TvPlayLogEntry = {
  t: string;
  channel: string | null;
  event: string;
  detail?: Record<string, unknown>;
};

const RING_MAX = 80;

function ring(): TvPlayLogEntry[] {
  const w = window as Window & { __PAT_TV_LOGS?: TvPlayLogEntry[] };
  if (!w.__PAT_TV_LOGS) {
    w.__PAT_TV_LOGS = [];
  }
  return w.__PAT_TV_LOGS;
}

export function tvPlayLog(
  event: string,
  detail?: Record<string, unknown> & { channel?: string | null }
): void {
  const channel = (detail?.channel || '').trim() || null;
  const prefix = channel ? `[TV] ${channel}` : '[TV]';
  const rest = detail ? { ...detail } : undefined;
  if (rest && 'channel' in rest) {
    delete rest.channel;
  }
  const entry: TvPlayLogEntry = {
    t: new Date().toISOString(),
    channel,
    event,
    detail: rest && Object.keys(rest).length > 0 ? rest : undefined
  };
  const buf = ring();
  buf.push(entry);
  if (buf.length > RING_MAX) {
    buf.splice(0, buf.length - RING_MAX);
  }

  const line = `${prefix} — ${event}`;
  // warn + log: some DevTools filters hide one level.
  if (entry.detail) {
    console.warn(line, entry.detail);
    console.log(line, entry.detail);
  } else {
    console.warn(line);
    console.log(line);
  }
}
