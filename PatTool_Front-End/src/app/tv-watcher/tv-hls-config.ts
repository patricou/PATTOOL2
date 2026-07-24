import Hls, { type HlsConfig } from 'hls.js';

/**
 * Shared hls.js options tuned for IPTV live (proxy HLS).
 *
 * Important: do NOT raise {@code maxLiveSyncPlaybackRate} above 1 — speeding up
 * the element to catch the live edge is a known cause of progressive A/V (lip-sync) drift
 * in hls.js / Chromium (see video-dev/hls.js#5220). Prefer a hard seek back to the live edge.
 */
export function createTvHlsConfig(): Partial<HlsConfig> {
  return {
    enableWorker: true,
    lowLatencyMode: false,
    // Keep buffers modest so audio/video tracks stay aligned on flaky IPTV mirrors.
    maxBufferLength: 12,
    maxMaxBufferLength: 24,
    backBufferLength: 18,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
    liveDurationInfinity: true,
    // Must stay 1 — values > 1 desync lipsync over time.
    maxLiveSyncPlaybackRate: 1,
    highBufferWatchdogPeriod: 1,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 5,
    maxFragLookUpTolerance: 0.25,
    xhrSetup: (xhr) => {
      xhr.withCredentials = false;
    }
  };
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

export function tryRecoverTvHlsError(
  hls: Hls,
  data: { fatal?: boolean; type?: string; response?: { code?: number }; networkDetails?: { status?: number } | null },
  attempts?: TvHlsRecoverAttempts
): boolean {
  if (!data?.fatal) {
    return false;
  }
  if (isTvHlsForbiddenError(data)) {
    return false;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    if (attempts && attempts.media >= MAX_MEDIA_RECOVERIES) {
      return false;
    }
    try {
      hls.recoverMediaError();
      if (attempts) {
        attempts.media += 1;
      }
      return true;
    } catch {
      return false;
    }
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (attempts && attempts.network >= MAX_NETWORK_RECOVERIES) {
      return false;
    }
    try {
      hls.startLoad();
      if (attempts) {
        attempts.network += 1;
      }
      return true;
    } catch {
      return false;
    }
  }
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
  if (hls) {
    const liveSync = hls.liveSyncPosition;
    if (liveSync != null && Number.isFinite(liveSync)) {
      target = liveSync;
    }
  }
  if (target == null && video.buffered.length > 0) {
    try {
      target = video.buffered.end(video.buffered.length - 1) - 0.35;
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
 */
export function attachTvHlsLiveSyncWatchdog(
  hls: Hls,
  video: HTMLVideoElement
): () => void {
  let lastSeekAt = 0;
  const MIN_SEEK_GAP_MS = 3500;
  const LAG_SEEK_SEC = 2.5;

  const seekToLiveEdge = (reason: string) => {
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
    try {
      // Ensure normal rate — leftover catch-up rates from older configs cause desync.
      if (video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
      video.currentTime = liveSync;
      if (video.paused) {
        void video.play().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    void reason;
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
    if (video.paused || video.ended || video.seeking) {
      return;
    }
    seekToLiveEdge('tick');
  }, 2000);

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
