/**
 * Browser console diagnostics for TV watcher playback glitches
 * (buffering spinner, soft recovery, live-edge seeks).
 * Filter DevTools with {@code [TV]}.
 */
export function tvPlayLog(
  event: string,
  detail?: Record<string, unknown> & { channel?: string | null }
): void {
  const channel = (detail?.channel || '').trim();
  const prefix = channel ? `[TV] ${channel}` : '[TV]';
  const rest = detail ? { ...detail } : undefined;
  if (rest && 'channel' in rest) {
    delete rest.channel;
  }
  if (rest && Object.keys(rest).length > 0) {
    console.warn(`${prefix} — ${event}`, rest);
    return;
  }
  console.warn(`${prefix} — ${event}`);
}
