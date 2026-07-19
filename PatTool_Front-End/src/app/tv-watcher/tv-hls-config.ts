import Hls, { type HlsConfig } from 'hls.js';

/**
 * Shared hls.js options tuned for IPTV live (proxy HLS).
 * Keeps the live edge closer and limits buffer bloat — large buffers often
 * make audio drift ahead of video on unstable mirrors.
 */
export function createTvHlsConfig(): Partial<HlsConfig> {
  return {
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 18,
    maxMaxBufferLength: 36,
    backBufferLength: 30,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    liveDurationInfinity: true,
    /** Gently speed up when slightly behind the live edge (reduces A/V drift). */
    maxLiveSyncPlaybackRate: 1.08,
    highBufferWatchdogPeriod: 1,
    nudgeOffset: 0.05,
    nudgeMaxRetry: 8,
    maxFragLookUpTolerance: 0.25,
    xhrSetup: (xhr) => {
      xhr.withCredentials = false;
      // Ensure error bodies (JSON from our proxy) are readable as text.
      try {
        xhr.responseType = 'text';
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Recover from stalls / media errors without tearing down the whole session.
 * Returns true when the error was handled as non-fatal recovery.
 */
export function tryRecoverTvHlsError(hls: Hls, data: { fatal?: boolean; type?: string }): boolean {
  if (!data?.fatal) {
    return false;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    try {
      hls.recoverMediaError();
      return true;
    } catch {
      return false;
    }
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    try {
      hls.startLoad();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * If playback stalls far behind the live edge, jump forward to re-sync A/V.
 */
export function attachTvHlsLiveSyncWatchdog(
  hls: Hls,
  video: HTMLVideoElement
): () => void {
  let lastNudgeAt = 0;
  const onWaiting = () => {
    const now = Date.now();
    if (now - lastNudgeAt < 4000) {
      return;
    }
    const liveSync = hls.liveSyncPosition;
    if (liveSync == null || !Number.isFinite(liveSync)) {
      return;
    }
    const lag = liveSync - video.currentTime;
    if (lag > 4) {
      lastNudgeAt = now;
      try {
        video.currentTime = liveSync;
      } catch {
        /* ignore */
      }
    }
  };
  video.addEventListener('waiting', onWaiting);
  return () => video.removeEventListener('waiting', onWaiting);
}
