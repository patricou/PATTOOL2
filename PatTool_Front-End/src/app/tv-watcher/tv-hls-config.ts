import Hls, { type HlsConfig } from 'hls.js';
import { tvPlayLog } from './tv-play-log';

export type TvHlsPlaybackMode = 'live' | 'vod';

/**
 * Shared hls.js options.
 * {@code live} — IPTV / live FTA (france.tv, TF1, ARTE LIVE…).
 * {@code vod} — ARTE replay and other finite HLS (no live-edge seeking).
 *
 * Important: do NOT raise {@code maxLiveSyncPlaybackRate} above 1 — speeding up
 * the element to catch the live edge is a known cause of progressive A/V (lip-sync) drift
 * in hls.js / Chromium (see video-dev/hls.js#5220). Prefer a hard seek back to the live edge.
 */
export function createTvHlsConfig(mode: TvHlsPlaybackMode = 'live'): Partial<HlsConfig> {
  const vod = mode === 'vod';
  return {
    enableWorker: true,
    lowLatencyMode: false,
    // Do NOT enable progressive FetchLoader for live IPTV MPEG-TS: partial demux
    // often drops the audio track or desyncs A/V (TF1 / LCI regressions).
    // Live IPTV (TF1/TMC on slow mirrors): deep buffer + stay behind the live edge
    // so startup can fill before realtime catch-up pressure.
    maxBufferLength: vod ? 30 : 45,
    maxMaxBufferLength: vod ? 60 : 90,
    backBufferLength: vod ? 30 : 30,
    liveSyncDurationCount: vod ? 3 : 8,
    liveMaxLatencyDurationCount: vod ? 6 : 24,
    // Must stay false for VOD: with true, hls.js exposes a liveSyncPosition near the
    // end and our live-edge watchdog seeks the replay straight to the finale.
    liveDurationInfinity: !vod,
    // Must stay 1 — values > 1 desync lipsync over time.
    maxLiveSyncPlaybackRate: 1,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    maxFragLookUpTolerance: 0.25,
    // Slow IPTV segments (TF1 HD ~4 MiB / 12–20 s) — default 20 s aborts mid-download.
    manifestLoadingTimeOut: vod ? 20_000 : 25_000,
    levelLoadingTimeOut: vod ? 20_000 : 25_000,
    fragLoadingTimeOut: vod ? 20_000 : 60_000,
    fragLoadingMaxRetry: vod ? 4 : 5,
    fragLoadingRetryDelay: 1_000,
    xhrSetup: (xhr) => {
      xhr.withCredentials = false;
      // Match fragLoadingTimeOut for XHR (hls.js also sets timeout, belt-and-suspenders).
      if (!vod) {
        xhr.timeout = 60_000;
      }
    }
  };
}

/** Disable HLS + native text tracks (default on every channel / stream change). */
export function disableTvSubtitles(hls?: Hls | null, video?: HTMLVideoElement | null): void {
  if (hls) {
    try {
      hls.subtitleDisplay = false;
      if (typeof hls.subtitleTrack === 'number' && hls.subtitleTrack !== -1) {
        hls.subtitleTrack = -1;
      }
    } catch {
      /* ignore */
    }
  }
  const tracks = video?.textTracks;
  if (!tracks?.length) {
    return;
  }
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (track && track.mode !== 'disabled') {
      track.mode = 'disabled';
    }
  }
}

/** True when the active media playlist is a live sliding window (not VOD / EVENT ended). */
export function isTvHlsLivePlaylist(hls: Hls | null | undefined): boolean {
  if (!hls) {
    return false;
  }
  const level =
    (hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : null)
    || hls.levels.find((l) => !!l?.details)
    || null;
  const details = level?.details;
  if (details) {
    return !!details.live;
  }
  return false;
}

/**
 * Recover from stalls / media errors without tearing down the whole session.
 * Returns true when the error was handled as non-fatal recovery.
 * Only call for {@code data.fatal === true}.
 *
 * Caps retries so permanent upstream failures surface a backend/HLS error banner
 * instead of looping forever on startLoad / recoverMediaError.
 *
 * Does not soft-recover HTTP 401/403: those usually mean an expired CDN token
 * (france.tv Akamai), so the caller must re-resolve the virtual stream URL.
 */
export interface TvHlsRecoverAttempts {
  network: number;
  media: number;
}

const MAX_NETWORK_RECOVERIES = 2;
const MAX_MEDIA_RECOVERIES = 2;

/**
 * Fully reset a {@code <video>} after MediaSource / appendBuffer poison.
 * {@code removeAttribute('src') + load()} alone is not always enough once
 * {@code HTMLMediaElement.error} is set (Chromium keeps the element unusable).
 */
export function resetTvMediaElement(video: HTMLVideoElement | null | undefined): void {
  if (!video) {
    return;
  }
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  try {
    video.removeAttribute('src');
  } catch {
    /* ignore */
  }
  try {
    // Clear MSE blob URL / MediaSource attachment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (video as any).srcObject = null;
  } catch {
    /* ignore */
  }
  try {
    video.load();
  } catch {
    /* ignore */
  }
  try {
    video.playbackRate = 1;
  } catch {
    /* ignore */
  }
}

/** True when hls.js reported a fatal buffer/append failure (MSE often poisoned). */
export function isTvHlsBufferAppendError(data: {
  type?: string;
  details?: string;
} | null | undefined): boolean {
  if (!data) {
    return false;
  }
  const details = (data.details || '').toLowerCase();
  return details.includes('buffer') || details.includes('append') || details.includes('mediaerror');
}

export function tryRecoverTvHlsError(
  hls: Hls,
  data: {
    fatal?: boolean;
    type?: string;
    details?: string;
    response?: { code?: number };
    networkDetails?: { status?: number } | null;
  },
  attempts?: TvHlsRecoverAttempts,
  video?: HTMLVideoElement | null,
  channel?: string | null
): boolean {
  if (!data?.fatal) {
    return false;
  }
  const http = data?.response?.code ?? data?.networkDetails?.status;
  const what =
    data.type === Hls.ErrorTypes.NETWORK_ERROR
      ? 'erreur réseau HLS fatale'
      : data.type === Hls.ErrorTypes.MEDIA_ERROR
        ? 'erreur média HLS fatale (MSE/buffer)'
        : `erreur HLS fatale (${data.type || '?'})`;
  const baseDetail: Record<string, unknown> = {
    channel: channel || null,
    what,
    type: data.type,
    details: data.details,
    http,
    networkAttempts: attempts?.network ?? 0,
    mediaAttempts: attempts?.media ?? 0,
    videoError: video?.error ? `${video.error.code}:${video.error.message}` : null
  };
  if (isTvHlsForbiddenError(data)) {
    tvPlayLog(`${what} — soft-recover ignoré (HTTP 401/403)`, baseDetail);
    return false;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    // Once the media element itself is poisoned (appendBuffer → "error is not null"),
    // recoverMediaError cannot clear it — caller must hard-rebuild the player.
    if (video?.error) {
      tvPlayLog(`${what} — soft-recover impossible (élément <video> empoisonné)`, baseDetail);
      return false;
    }
    if (attempts && attempts.media >= MAX_MEDIA_RECOVERIES) {
      tvPlayLog(`${what} — soft-recover média épuisé`, baseDetail);
      return false;
    }
    try {
      const details = (data.details || '').toLowerCase();
      // Second media recovery: try audio codec swap before giving up (hls.js guidance).
      if (attempts && attempts.media >= 1 && details.includes('buffer')) {
        try {
          hls.swapAudioCodec();
          tvPlayLog(`${what} — soft-recover: swapAudioCodec`, baseDetail);
        } catch {
          /* ignore */
        }
      }
      hls.recoverMediaError();
      if (attempts) {
        attempts.media += 1;
      }
      tvPlayLog(`${what} — soft-recover média → affichage spinner`, {
        ...baseDetail,
        mediaAttempts: attempts?.media ?? 0
      });
      return true;
    } catch (err) {
      tvPlayLog(`${what} — soft-recover média a échoué`, {
        ...baseDetail,
        err: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (attempts && attempts.network >= MAX_NETWORK_RECOVERIES) {
      tvPlayLog(`${what} — soft-recover réseau épuisé`, baseDetail);
      return false;
    }
    try {
      hls.startLoad();
      if (attempts) {
        attempts.network += 1;
      }
      tvPlayLog(`${what} — soft-recover réseau (startLoad) → affichage spinner`, {
        ...baseDetail,
        networkAttempts: attempts?.network ?? 0
      });
      return true;
    } catch (err) {
      tvPlayLog(`${what} — soft-recover réseau a échoué`, {
        ...baseDetail,
        err: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }
  tvPlayLog(`${what} — type non géré par soft-recover`, baseDetail);
  return false;
}

/** True when HLS failed with HTTP 401/403 (typically expired signed CDN URL). */
export function isTvHlsForbiddenError(data: {
  response?: { code?: number };
  networkDetails?: { status?: number } | null;
} | null | undefined): boolean {
  const code = data?.response?.code ?? data?.networkDetails?.status;
  return code === 401 || code === 403;
}

/**
 * Manual A/V resync: reset playbackRate, jump to the live edge (or buffered end),
 * and recover the MediaSource so audio + video SourceBuffers restart together.
 */
export function resyncTvHlsAv(hls: Hls | null, video: HTMLVideoElement): boolean {
  try {
    video.playbackRate = 1;
  } catch {
    /* ignore */
  }

  let target: number | null = null;
  if (hls && isTvHlsLivePlaylist(hls)) {
    const liveSync = hls.liveSyncPosition;
    if (liveSync != null && Number.isFinite(liveSync)) {
      target = liveSync;
    }
  }
  if (target == null && video.buffered.length > 0) {
    try {
      // VOD / unknown: nudge slightly behind the buffer tip (not to "live edge").
      target = video.buffered.end(video.buffered.length - 1) - 0.35;
      // Prefer staying near the current playhead when already buffered.
      if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
        const cur = video.currentTime;
        if (cur < (target as number)) {
          target = cur;
        }
      }
    } catch {
      target = null;
    }
  }

  if (target != null && Number.isFinite(target) && target >= 0) {
    try {
      video.currentTime = Math.max(0, target);
    } catch {
      /* ignore */
    }
  }

  if (hls) {
    try {
      hls.recoverMediaError();
    } catch {
      try {
        hls.startLoad();
      } catch {
        /* ignore */
      }
    }
  }

  void video.play().catch(() => undefined);
  return true;
}

/**
 * Keep live playback near the edge and hard-seek when lag builds up.
 * Seeking resets video+audio SourceBuffers together (fixes lip-sync drift better than
 * changing {@code playbackRate}).
 * <p>
 * No-op for VOD (e.g. ARTE replay): with {@code liveDurationInfinity}, hls.js can still
 * expose a {@code liveSyncPosition} near the end — seeking there jumps to the finale.
 */
export function attachTvHlsLiveSyncWatchdog(
  hls: Hls,
  video: HTMLVideoElement,
  channel?: string | null
): () => void {
  let lastSeekAt = 0;
  // IPTV mirrors (TF1/LCI) are often slower than realtime — aggressive seeking to the
  // live edge while lag keeps growing poisons MSE (appendBuffer / media.error).
  const MIN_SEEK_GAP_MS = 20_000;
  const LAG_SEEK_SEC = 22;

  const seekToLiveEdge = (reason: string) => {
    if (!isTvHlsLivePlaylist(hls)) {
      return;
    }
    if (video.error) {
      return;
    }
    const now = Date.now();
    if (now - lastSeekAt < MIN_SEEK_GAP_MS) {
      return;
    }
    const liveSync = hls.liveSyncPosition;
    if (liveSync == null || !Number.isFinite(liveSync)) {
      return;
    }
    const lag = liveSync - video.currentTime;
    if (lag < LAG_SEEK_SEC) {
      return;
    }
    lastSeekAt = now;
    const lagSec = Math.round(lag * 10) / 10;
    tvPlayLog(
      `seek live-edge (retard ${lagSec}s, trigger=${reason}) — peut provoquer reconnect/spinner`,
      {
        channel: channel || null,
        what: 'rattrapage forcé vers le direct car le lecteur a trop de retard',
        reason,
        lagSec,
        currentTime: Math.round(video.currentTime * 10) / 10,
        liveSync: Math.round(liveSync * 10) / 10
      }
    );
    try {
      // Ensure normal rate — leftover catch-up rates from older configs cause desync.
      if (video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
      video.currentTime = liveSync;
      if (video.paused) {
        void video.play().catch(() => undefined);
      }
    } catch (err) {
      tvPlayLog(`seek live-edge a échoué (trigger=${reason})`, {
        channel: channel || null,
        what: 'échec du seek vers le direct',
        reason,
        err: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const onWaiting = () => seekToLiveEdge('waiting');
  const onStalled = () => seekToLiveEdge('stalled');
  const onPlaying = () => {
    if (video.playbackRate !== 1) {
      video.playbackRate = 1;
    }
  };

  // Periodic lag check (network jitter / buffer holes).
  const tick = window.setInterval(() => {
    if (video.paused || video.ended || video.seeking || video.error) {
      return;
    }
    seekToLiveEdge('tick');
  }, 4000);

  video.addEventListener('waiting', onWaiting);
  video.addEventListener('stalled', onStalled);
  video.addEventListener('playing', onPlaying);

  return () => {
    window.clearInterval(tick);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('stalled', onStalled);
    video.removeEventListener('playing', onPlaying);
    try {
      if (video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
    } catch {
      /* ignore */
    }
  };
}
