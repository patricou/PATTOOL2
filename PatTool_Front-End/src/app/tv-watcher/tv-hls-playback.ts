import Hls from 'hls.js';
import { resolveTvStreamErrorMessage } from './tv-stream-error.util';
import {
  attachTvHlsLiveSyncWatchdog,
  attachTvSlowMirrorPaceGuard,
  attachTvUnderrunSpinnerWatch,
  createTvHlsConfig,
  disableTvSubtitles,
  isTvHlsForbiddenError,
  resetTvMediaElement,
  tryRecoverTvHlsError,
  type TvHlsRecoverAttempts
} from './tv-hls-config';
import { tvPlayLog } from './tv-play-log';
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
   * Silent keep-alive for signed CDN lives (france.tv / TF1): renew before token expiry.
   * Do not enable for M6 IPTV mirrors — proactive MediaSource swaps cause visible cuts.
   * {@code onRenewed} should show a short on-screen toast (≈1s).
   */
  virtualLive?: {
    slug: string;
    resolveMeta: (fresh: boolean) => Promise<FranceTvResolveMeta | null>;
    onRenewed?: () => void;
  };
  /** Use VOD HLS tuning (ARTE replay). Skips live-edge seek watchdog. */
  vod?: boolean;
  /**
   * Skip live-edge seek watchdog (IPTV mirrors: TF1/LCI/M6/RTS / Cap Terre).
   * Seeking while the mirror lags poisons MSE mid-play.
   */
  skipLiveEdgeWatchdog?: boolean;
  /**
   * Cap Terre–class: deeper buffer + stay far behind live (download ≈ realtime).
   */
  slowMirror?: boolean;
  /** Progressive MP4/WebM (Internet Archive) — use video.src instead of hls.js. */
  progressive?: boolean;
  /** Channel display name for console diagnostics ({@code [TV] Cap Terre — …}). */
  channelLabel?: string;
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
  let detachUnderrun: (() => void) | null = null;
  let detachSlowPace: (() => void) | null = null;
  let tokenRefreshAttempted = false;
  let franceTvKeeper: FranceTvTokenKeeper | null = null;
  const recoverAttempts: TvHlsRecoverAttempts = { network: 0, media: 0 };
  const channelLabel = (callbacks.channelLabel || '').trim() || null;
  disableTvSubtitles(null, video);

  const setBuffering = (v: boolean) => {
    if (!destroyed) {
      if (v) {
        tvPlayLog('spinner AFFICHÉ (float/popout)', {
          channel: channelLabel,
          what: 'overlay buffering demandé par le player partagé'
        });
      }
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
    tvPlayLog('lecture arrêtée avec erreur (float/popout)', {
      channel: channelLabel,
      what: 'soft-recover épuisé — bandeau d’erreur affiché',
      message,
      hlsType: data?.type ?? null,
      hlsDetails: data?.details ?? null
    });
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
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      disableTvSubtitles(instance, video);
      tryPlay();
    });
    instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      disableTvSubtitles(instance, video);
    });
    instance.on(Hls.Events.ERROR, (_e, data) => {
      if (!data?.fatal) {
        return;
      }
      tvPlayLog('erreur HLS fatale détectée (float/popout)', {
        channel: channelLabel,
        what:
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'panne réseau / segment ou manifeste inaccessible'
            : data.type === Hls.ErrorTypes.MEDIA_ERROR
              ? 'buffer/MSE cassé (souvent après seek ou segment pourri)'
              : 'erreur lecteur HLS fatale',
        type: data.type,
        details: data.details,
        http: data.response?.code ?? data.networkDetails?.status ?? null,
        recoverNetwork: recoverAttempts.network,
        recoverMedia: recoverAttempts.media,
        videoError: video.error ? `${video.error.code}:${video.error.message}` : null
      });
      if (
        !tokenRefreshAttempted &&
        isTvHlsForbiddenError(data) &&
        callbacks.onTokenExpired?.()
      ) {
        tokenRefreshAttempted = true;
        tvPlayLog('token expiré → redémarrage', {
          channel: channelLabel,
          what: 'HTTP 401/403 — renouvellement token / hard restart'
        });
        return;
      }
      if (hls && tryRecoverTvHlsError(hls, data, recoverAttempts, video, channelLabel)) {
        setBuffering(true);
        tryPlay(false);
        return;
      }
      // Soft recovery exhausted (or MSE poison) — ask caller to hard re-resolve once.
      if (!tokenRefreshAttempted && callbacks.onTokenExpired?.()) {
        tokenRefreshAttempted = true;
        tvPlayLog('soft-recover épuisé → callback restart', {
          channel: channelLabel,
          what: 'demande de hard restart au composant parent'
        });
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
        detachLiveSync = (callbacks.vod || callbacks.skipLiveEdgeWatchdog)
          ? null
          : attachTvHlsLiveSyncWatchdog(next, media, channelLabel);
        try {
          detachUnderrun?.();
        } catch {
          /* ignore */
        }
        detachUnderrun = attachTvUnderrunSpinnerWatch(
          media,
          (buffering) => setBuffering(buffering),
          channelLabel
        );
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
    const slowMirror = !!callbacks.slowMirror;
    hls = new Hls(createTvHlsConfig(vod ? 'vod' : 'live', { slowMirror }));
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);
    disableTvSubtitles(hls, video);
    video.playbackRate = 1;
    detachLiveSync = (vod || callbacks.skipLiveEdgeWatchdog)
      ? null
      : attachTvHlsLiveSyncWatchdog(hls, video, channelLabel);
    detachUnderrun = attachTvUnderrunSpinnerWatch(
      video,
      (buffering) => setBuffering(buffering),
      channelLabel,
      slowMirror ? 2_500 : 0
    );
    detachSlowPace = slowMirror
      ? attachTvSlowMirrorPaceGuard(video, channelLabel, (buffering) => setBuffering(buffering))
      : null;
    tvPlayLog('lecture HLS démarrée (float/popout, diag spinner actif)', {
      channel: channelLabel,
      what: 'player attaché — underruns et recoveries logués',
      slowMirror,
      skipLiveEdge: !!callbacks.skipLiveEdgeWatchdog
    });
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
      if (detachUnderrun) {
        try {
          detachUnderrun();
        } catch {
          /* ignore */
        }
        detachUnderrun = null;
      }
      if (detachSlowPace) {
        try {
          detachSlowPace();
        } catch {
          /* ignore */
        }
        detachSlowPace = null;
      }
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
        resetTvMediaElement(video);
      } catch {
        /* ignore */
      }
    }
  };
}
