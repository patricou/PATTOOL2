import Hls from 'hls.js';
import { resolveTvStreamErrorMessage } from './tv-stream-error.util';
import {
  attachTvHlsLiveSyncWatchdog,
  createTvHlsConfig,
  tryRecoverTvHlsError
} from './tv-hls-config';

/** i18n key or literal backend/API message shown in the TV error banner. */
export type TvHlsErrorMessage = string;

export interface TvHlsPlaybackCallbacks {
  onBuffering?: (buffering: boolean) => void;
  onError?: (message: TvHlsErrorMessage) => void;
  onMutedChange?: (muted: boolean) => void;
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

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxyUrl;
    const onNativeError = () => {
      void reportFatalStreamError();
    };
    video.addEventListener('error', onNativeError, { once: true });
    tryPlay();
  } else if (Hls.isSupported()) {
    hls = new Hls(createTvHlsConfig());
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);
    video.playbackRate = 1;
    detachLiveSync = attachTvHlsLiveSyncWatchdog(hls, video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data?.fatal) {
        return;
      }
      if (hls && tryRecoverTvHlsError(hls, data)) {
        setBuffering(true);
        tryPlay(false);
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
  } else {
    setBuffering(false);
    setError('TV.ERR_UNSUPPORTED');
  }

  return {
    destroy(): void {
      destroyed = true;
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
