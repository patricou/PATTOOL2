import Hls from 'hls.js';

export type TvHlsErrorKey = 'TV.ERR_PLAY' | 'TV.ERR_STREAM' | 'TV.ERR_UNSUPPORTED';

export interface TvHlsPlaybackCallbacks {
  onBuffering?: (buffering: boolean) => void;
  onError?: (key: TvHlsErrorKey) => void;
  onMutedChange?: (muted: boolean) => void;
}

export interface TvHlsPlaybackHandle {
  destroy(): void;
}

/**
 * Attach HLS (or native HLS) playback to a video element with unmuted-first autoplay
 * and muted fallback on NotAllowedError.
 */
export function startTvHlsPlayback(
  video: HTMLVideoElement,
  proxyUrl: string,
  callbacks: TvHlsPlaybackCallbacks = {}
): TvHlsPlaybackHandle {
  let hls: Hls | null = null;
  let destroyed = false;
  let muted = false;

  const setBuffering = (v: boolean) => {
    if (!destroyed) {
      callbacks.onBuffering?.(v);
    }
  };

  const setError = (key: TvHlsErrorKey) => {
    if (!destroyed) {
      callbacks.onError?.(key);
    }
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
    tryPlay();
  } else if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 30,
      xhrSetup: (xhr) => {
        xhr.withCredentials = false;
      }
    });
    hls.loadSource(proxyUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data?.fatal) {
        setBuffering(false);
        setError('TV.ERR_STREAM');
        try {
          hls?.destroy();
        } catch {
          /* ignore */
        }
        hls = null;
      }
    });
  } else {
    setBuffering(false);
    setError('TV.ERR_UNSUPPORTED');
  }

  return {
    destroy(): void {
      destroyed = true;
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
