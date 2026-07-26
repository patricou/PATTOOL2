import Hls from 'hls.js';
import { resolveTvStreamErrorMessage } from './tv-stream-error.util';
import {
  attachTvHlsLiveSyncWatchdog,
  createTvHlsConfig,
  isTvHlsForbiddenError,
  tryRecoverTvHlsError,
  type TvHlsRecoverAttempts
} from './tv-hls-config';
import {
  FranceTvResolveMeta,
  FranceTvTokenKeeper,
  startFranceTvTokenKeeper
} from './tv-francetv-refresh';

/** i18n key or literal backend/API message shown in the TV error banner. */
export type TvHlsErrorMessage = string;

export interface TvHlsPlaybackCallbacks {
  onBuffering?: (buffering: boolean) => void;
  onError?: (message: TvHlsErrorMessage) => void;
  onMutedChange?: (muted: boolean) => void;
/**
 * Called when playback dies with HTTP 401/403, or after soft HLS recovery is exhausted.
 * Return true if the caller started a full re-resolve / restart.
 */
  onTokenExpired?: () => boolean;
  /**
   * Silent keep-alive for virtual lives (france.tv / TF1 / M6): renew before CDN/mirror expiry.
   * {@code onRenewed} should show a short on-screen toast (≈1s).
   */
  virtualLive?: {
    slug: string;
    resolveMeta: (fresh: boolean) => Promise<FranceTvResolveMeta | null>;
    onRenewed?: () => void;
  };
  /** Use VOD HLS tuning (ARTE replay). Skips live-edge seek watchdog. */
  vod?: boolean;
  /** Progressive MP4/WebM (Internet Archive) — use video.src instead of hls.js. */
  progressive?: boolean;
}

export interface TvHlsPlaybackHandle {
  destroy(): void;
}

/**
 * Attach HLS (or native HLS) playback to a video element with unmuted-first autoplay
 * and muted fallback on NotAllowedError.
 * Fatal errors prefer the backend JSON {@code message} when available.
 */
export function startTvHlsPlayback(
  video: HTMLVideoElement,
  proxyUrl: string,
  callbacks: TvHlsPlaybackCallbacks = {}
): TvHlsPlaybackHandle {
  let hls: Hls | null = null;
  let destroyed = false;
  let muted = false;
  let detachLiveSync: (() => void) | null = null;
  let tokenRefreshAttempted = false;
  let franceTvKeeper: FranceTvTokenKeeper | null = null;
  const recoverAttempts: TvHlsRecoverAttempts = { network: 0, media: 0 };

  const setBuffering = (v: boolean) => {
    if (!destroyed) {
      callbacks.onBuffering?.(v);
    }
  };

  const setError = (message: TvHlsErrorMessage) => {
    if (!destroyed) {
      callbacks.onError?.(message);
    }
  };

  const reportFatalStreamError = async (
    data?: Parameters<typeof resolveTvStreamErrorMessage>[1]
  ) => {
    if (destroyed) {
      return;
    }
    setBuffering(false);
    const message = await resolveTvStreamErrorMessage(proxyUrl, data);
    if (destroyed) {
      return;
    }
    setError(message);
  };

  const setMuted = (v: boolean) => {
    muted = v;
    video.muted = v;
    if (!destroyed) {
      callbacks.onMutedChange?.(v);
    }
  };

  const bindHlsHandlers = (instance: Hls) => {
    instance.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
    instance.on(Hls.Events.ERROR, (_e, data) => {
      if (!data?.fatal) {
        return;
      }
      if (
        !tokenRefreshAttempted &&
        isTvHlsForbiddenError(data) &&
        callbacks.onTokenExpired?.()
      ) {
        tokenRefreshAttempted = true;
        return;
      }
      if (hls && tryRecoverTvHlsError(hls, data, recoverAttempts)) {
        setBuffering(true);
        tryPlay(false);
        return;
      }
      // TF1 / M6 mirrors (and france.tv) — one full re-resolve after soft recovery fails.
      if (!tokenRefreshAttempted && callbacks.onTokenExpired?.()) {
        tokenRefreshAttempted = true;
        return;
      }
      try {
        hls?.destroy();
      } catch {
        /* ignore */
      }
      hls = null;
      void reportFatalStreamError(data);
    });
  };

  const startKeeperIfNeeded = () => {
    const live = callbacks.virtualLive;
    if (!live?.slug || !hls) {
      return;
    }
    franceTvKeeper?.stop();
    franceTvKeeper = startFranceTvTokenKeeper({
      slug: live.slug,
      proxyUrl,
      getHls: () => hls,
      getVideo: () => (destroyed ? null : video),
      resolveMeta: live.resolveMeta,
      isCancelled: () => destroyed,
      onRenewed: () => {
        if (!destroyed) {
          live.onRenewed?.();
        }
      },
      onHlsSwapped: (next, media) => {
        if (destroyed) {
          try {
            next.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        try {
          detachLiveSync?.();
        } catch {
          /* ignore */
        }
        hls = next;
        detachLiveSync = callbacks.vod ? null : attachTvHlsLiveSyncWatchdog(next, media);
        bindHlsHandlers(next);
      }
    });
  };

  setMuted(false);
  if (video.volume === 0) {
    video.volume = 1;
  }
  setBuffering(true);

  const tryPlay = (allowMuteFallback = true) => {
    if (destroyed) {
      return;
    }
    video.muted = muted;
    if (!muted && video.volume === 0) {
      video.volume = 1;
    }
    const p = video.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        setBuffering(false);
      }).catch((err: unknown) => {
        const name =
          err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
        if (name === 'AbortError') {
          return;
        }
        if (allowMuteFallback && !muted) {
          setMuted(true);
          tryPlay(false);
          return;
        }
        setBuffering(false);
        if (name !== 'NotAllowedError') {
          setError('TV.ERR_PLAY');
        }
      });
    } else {
      setBuffering(false);
    }
  };

  // Prefer hls.js whenever available. Chromium/Electron often reports
  // canPlayType('application/vnd.apple.mpegurl') as "maybe" without real native
  // HLS — that path hangs on proxied ARTE CMAF (demuxed) VOD.
  if (callbacks.progressive) {
    video.src = proxyUrl;
    video.playbackRate = 1;
    const onNativeError = () => {
      void reportFatalStreamError();
    };
    video.addEventListener('error', onNativeError, { once: true });
    video.addEventListener(
      'loadeddata',
      () => {
        tryPlay();
      },
      { once: true }
    );
    tryPlay();
  } else if (Hls.isSupported()) {
    const vod = !!callbacks.vod;
    hls = new Hls(createTvHlsConfig(vod ? 'vod' : 'live'));
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);
    video.playbackRate = 1;
    detachLiveSync = vod ? null : attachTvHlsLiveSyncWatchdog(hls, video);
    bindHlsHandlers(hls);
    startKeeperIfNeeded();
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxyUrl;
    const onNativeError = () => {
      void reportFatalStreamError();
    };
    video.addEventListener('error', onNativeError, { once: true });
    tryPlay();
  } else {
    setBuffering(false);
    setError('TV.ERR_UNSUPPORTED');
  }

  return {
    destroy(): void {
      destroyed = true;
      franceTvKeeper?.stop();
      franceTvKeeper = null;
      if (detachLiveSync) {
        detachLiveSync();
        detachLiveSync = null;
      }
      if (hls) {
        try {
          hls.destroy();
        } catch {
          /* ignore */
        }
        hls = null;
      }
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        /* ignore */
      }
    }
  };
}
