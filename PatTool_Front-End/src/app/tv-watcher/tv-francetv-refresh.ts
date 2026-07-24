import Hls from 'hls.js';
import { createTvHlsConfig } from './tv-hls-config';

export interface FranceTvResolveMeta {
  slug: string;
  streamUrl: string;
  virtualUrl: string;
  expiresAtEpoch: number;
}

export interface FranceTvTokenKeeperOptions {
  /** Channel slug, e.g. {@code france-2}. */
  slug: string;
  /** Proxied virtual URL ({@code .../stream/<b64(francetv:…)>}). */
  proxyUrl: string;
  getHls: () => Hls | null;
  getVideo: () => HTMLVideoElement | null;
  /** Resolve token meta; {@code fresh=true} forces a new Akamai signature. */
  resolveMeta: (fresh: boolean) => Promise<FranceTvResolveMeta | null>;
  /**
   * Called after a silent MediaSource swap onto the visible video.
   * Host must store {@code hls}, re-attach ERROR / live-sync handlers, etc.
   */
  onHlsSwapped: (hls: Hls, video: HTMLVideoElement) => void;
  /** Fired after a successful silent renew (show a 1s toast). */
  onRenewed?: () => void;
  /** Optional: true when this playback session was superseded. */
  isCancelled?: () => boolean;
}

export interface FranceTvTokenKeeper {
  stop(): void;
}

/** Refresh this many seconds before Akamai {@code exp}. */
const REFRESH_BEFORE_EXP_SEC = 90;
/** Never schedule sooner than this after start / last renew. */
const MIN_DELAY_MS = 20_000;
/** Fallback cadence when expiry is unknown (~10 min tokens). */
const FALLBACK_REFRESH_MS = 7 * 60 * 1000;
const PRELOAD_TIMEOUT_MS = 20_000;

/**
 * Keeps france.tv live playback alive by preloading a fresh signed HLS on a
 * detached video, then swapping the MediaSource onto the visible element
 * before the Akamai token expires — no full teardown / buffering spinner.
 */
export function startFranceTvTokenKeeper(options: FranceTvTokenKeeperOptions): FranceTvTokenKeeper {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const cancelled = () => stopped || !!options.isCancelled?.();

  const scheduleFromExpiry = (expiresAtEpoch: number) => {
    clearTimer();
    if (cancelled()) {
      return;
    }
    const nowSec = Date.now() / 1000;
    const refreshAtSec = expiresAtEpoch - REFRESH_BEFORE_EXP_SEC;
    let delayMs = Math.round((refreshAtSec - nowSec) * 1000);
    if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS) {
      delayMs = MIN_DELAY_MS;
    }
    delayMs = Math.min(delayMs, FALLBACK_REFRESH_MS);
    timer = setTimeout(() => {
      timer = null;
      void runRefresh();
    }, delayMs);
  };

  const scheduleFallback = () => {
    clearTimer();
    if (cancelled()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void runRefresh();
    }, FALLBACK_REFRESH_MS);
  };

  const waitUntilReady = (video: HTMLVideoElement, hls: Hls): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay', onReady);
        hls.off(Hls.Events.MANIFEST_PARSED, onManifest);
        hls.off(Hls.Events.ERROR, onError);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const onReady = () => done();
      const onManifest = () => {
        void video.play().catch(() => undefined);
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          done();
        }
      };
      const onError = (_e: string, data: { fatal?: boolean }) => {
        if (data?.fatal) {
          done(new Error('france.tv preload failed'));
        }
      };
      const timeout = window.setTimeout(() => done(new Error('france.tv preload timeout')), PRELOAD_TIMEOUT_MS);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
      hls.on(Hls.Events.MANIFEST_PARSED, onManifest);
      hls.on(Hls.Events.ERROR, onError);
    });

  const runRefresh = async () => {
    if (cancelled() || refreshing) {
      return;
    }
    const video = options.getVideo();
    const current = options.getHls();
    if (!video || !current) {
      scheduleFallback();
      return;
    }
    refreshing = true;
    let preloadHls: Hls | null = null;
    let preloadVideo: HTMLVideoElement | null = null;
    try {
      const meta = await options.resolveMeta(true);
      if (cancelled()) {
        return;
      }

      preloadVideo = document.createElement('video');
      preloadVideo.muted = true;
      preloadVideo.playsInline = true;
      preloadVideo.setAttribute('playsinline', '');
      preloadVideo.style.cssText =
        'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(preloadVideo);

      preloadHls = new Hls(createTvHlsConfig());
      preloadHls.loadSource(options.proxyUrl);
      preloadHls.attachMedia(preloadVideo);
      await waitUntilReady(preloadVideo, preloadHls);
      if (cancelled() || options.getVideo() !== video) {
        return;
      }

      const wasMuted = video.muted;
      const vol = video.volume;
      const paused = video.paused;

      try {
        current.destroy();
      } catch {
        /* ignore */
      }

      try {
        preloadHls.detachMedia();
      } catch {
        /* ignore */
      }
      preloadHls.attachMedia(video);
      video.muted = wasMuted;
      video.volume = vol;
      video.playbackRate = 1;
      const liveSync = preloadHls.liveSyncPosition;
      if (liveSync != null && Number.isFinite(liveSync)) {
        try {
          video.currentTime = liveSync;
        } catch {
          /* ignore */
        }
      }
      if (!paused) {
        void video.play().catch(() => undefined);
      }

      const swapped = preloadHls;
      preloadHls = null;
      options.onHlsSwapped(swapped, video);
      options.onRenewed?.();

      if (meta && Number.isFinite(meta.expiresAtEpoch)) {
        scheduleFromExpiry(meta.expiresAtEpoch);
      } else {
        scheduleFallback();
      }
    } catch {
      if (!cancelled()) {
        clearTimer();
        timer = setTimeout(() => {
          timer = null;
          void runRefresh();
        }, 30_000);
      }
    } finally {
      refreshing = false;
      if (preloadHls) {
        try {
          preloadHls.destroy();
        } catch {
          /* ignore */
        }
      }
      if (preloadVideo?.parentNode) {
        preloadVideo.parentNode.removeChild(preloadVideo);
      }
    }
  };

  const boot = async () => {
    try {
      const meta = await options.resolveMeta(false);
      if (cancelled()) {
        return;
      }
      if (meta && Number.isFinite(meta.expiresAtEpoch) && meta.expiresAtEpoch > Date.now() / 1000 + 30) {
        scheduleFromExpiry(meta.expiresAtEpoch);
        return;
      }
    } catch {
      /* fall through */
    }
    scheduleFallback();
  };

  void boot();

  return {
    stop(): void {
      stopped = true;
      clearTimer();
    }
  };
}

export function franceTvSlugFromVirtual(url: string): string | null {
  const lower = (url || '').trim().toLowerCase();
  if (!lower.startsWith('francetv:')) {
    return null;
  }
  const slug = lower.slice('francetv:'.length).trim();
  return slug || null;
}
