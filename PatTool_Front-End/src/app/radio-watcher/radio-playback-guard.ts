/**
 * Keeps a live radio stream alive across a screen lock and a dropped network.
 * The element must be an {@code <audio>} (a {@code <video>} is paused when the
 * phone sleeps). A dead socket is reopened until the listener stops the station.
 * On Android, a playing station also holds a playback foreground service so the
 * WebView is not frozen when the screen turns off.
 */

import { screenIsOff, setScreenKeepAlive } from '../services/media-screen-keepalive';

export interface RadioPlaybackGuard {
  requestReconnect(): void;
  dispose(): void;
}

export interface RadioPlaybackGuardOptions {
  media: HTMLMediaElement;
  isCurrent: () => boolean;
  reload: () => void;
  onReconnecting: () => void;
}

const MIN_RETRY_MS = 1200;
const MAX_RETRY_MS = 20000;
const STALL_AFTER_START_MS = 12000;
const STALL_BEFORE_START_MS = 22000;

let audioSessionOwners = 0;

function radioTitle(media: HTMLMediaElement): string {
  const raw = (media.getAttribute('data-pat-media-title') || media.title || 'Radio').trim();
  return (raw || 'Radio').slice(0, 80);
}

function syncNativeRadio(playing: boolean, title?: string): void {
  setScreenKeepAlive('radio', playing && audioSessionOwners > 0, title);
}

export function bustRadioStreamUrl(proxyUrl: string): string {
  const join = proxyUrl.includes('?') ? '&' : '?';
  return `${proxyUrl}${join}r=${Date.now()}`;
}

export function attachRadioPlaybackGuard(options: RadioPlaybackGuardOptions): RadioPlaybackGuard {
  const { media } = options;
  claimRadioAudioSession(media);

  let disposed = false;
  let offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  let seenPlaying = false;
  let retryDelay = MIN_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let sleepKickTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSleepKick = 0;

  const userHold = (): boolean =>
    media.dataset['patUserPaused'] === '1' && !media.error;

  const isHealthy = (): boolean =>
    !media.error &&
    !media.paused &&
    !media.ended &&
    media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    media.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE;

  const clearRetry = (): void => {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearStall = (): void => {
    if (stallTimer != null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const schedule = (delay: number): void => {
    if (disposed || !options.isCurrent() || userHold()) {
      return;
    }
    options.onReconnecting();
    if (offline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      offline = true;
      return;
    }
    if (retryTimer != null) {
      return;
    }
    const wait = Math.max(300, delay);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || !options.isCurrent() || userHold()) {
        return;
      }
      if (offline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        offline = true;
        options.onReconnecting();
        return;
      }
      if (isHealthy()) {
        retryDelay = MIN_RETRY_MS;
        return;
      }
      retryDelay = Math.min(MAX_RETRY_MS, Math.round(retryDelay * 1.7));
      options.onReconnecting();
      options.reload();
    }, wait);
  };

  const armStall = (): void => {
    if (disposed || !options.isCurrent() || userHold()) {
      return;
    }
    clearStall();
    const wait = seenPlaying ? STALL_AFTER_START_MS : STALL_BEFORE_START_MS;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (disposed || !options.isCurrent() || userHold()) {
        return;
      }
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (hidden && !media.paused && !media.error && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      if (!media.paused && media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !media.error) {
        return;
      }
      schedule(retryDelay);
    }, wait);
  };

  const clearSleepKick = (): void => {
    if (sleepKickTimer != null) {
      clearTimeout(sleepKickTimer);
      sleepKickTimer = null;
    }
  };

  const keepPlayingThroughSleep = (): void => {
    if (disposed || !options.isCurrent() || userHold() || sleepKickTimer != null) {
      return;
    }
    const asleep =
      screenIsOff() || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    if (!asleep || (!media.paused && !media.ended && !media.error)) {
      return;
    }
    const now = Date.now();
    if (now - lastSleepKick < 400) {
      return;
    }
    lastSleepKick = now;
    const kick = (attempt: number): void => {
      sleepKickTimer = null;
      if (disposed || !options.isCurrent() || userHold()) {
        return;
      }
      const stillAsleep =
        screenIsOff() || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
      if (!stillAsleep || (!media.paused && !media.ended && !media.error)) {
        return;
      }
      void media.play().catch(() => {
        if (disposed || !options.isCurrent() || userHold()) {
          return;
        }
        if (media.error) {
          schedule(retryDelay);
          return;
        }
        if (attempt < 5) {
          sleepKickTimer = setTimeout(() => kick(attempt + 1), 450);
        }
      });
    };
    kick(0);
  };

  const onPlaying = (): void => {
    if (disposed) {
      return;
    }
    seenPlaying = true;
    retryDelay = MIN_RETRY_MS;
    clearStall();
    clearRetry();
    syncNativeRadio(true, radioTitle(media));
  };

  const onMediaPause = (): void => {
    keepPlayingThroughSleep();
  };

  const onScreen = (): void => {
    if (disposed || !options.isCurrent()) {
      return;
    }
    if (screenIsOff()) {
      keepPlayingThroughSleep();
      return;
    }
    onForeground();
  };

  const onTimeUpdate = (): void => {
    if (disposed || media.paused) {
      return;
    }
    retryDelay = MIN_RETRY_MS;
    clearStall();
  };

  const onWaiting = (): void => {
    armStall();
  };

  const onError = (): void => {
    if (disposed || !options.isCurrent()) {
      return;
    }
    if (media.error && media.error.code === MediaError.MEDIA_ERR_ABORTED) {
      return;
    }
    schedule(retryDelay);
  };

  const onEnded = (): void => {
    if (disposed || !options.isCurrent() || userHold()) {
      return;
    }
    if (Number.isFinite(media.duration) && media.duration > 0) {
      return;
    }
    schedule(retryDelay);
  };

  const onOnline = (): void => {
    offline = false;
    if (disposed || !options.isCurrent() || userHold() || isHealthy()) {
      return;
    }
    retryDelay = MIN_RETRY_MS;
    clearRetry();
    schedule(350);
  };

  const onOffline = (): void => {
    offline = true;
    clearRetry();
    if (disposed || !options.isCurrent() || userHold() || isHealthy()) {
      return;
    }
    options.onReconnecting();
  };

  const onForeground = (): void => {
    if (disposed || !options.isCurrent() || userHold()) {
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (isHealthy()) {
      return;
    }
    if (
      !media.error &&
      media.paused &&
      media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      media.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE
    ) {
      void media.play().catch(() => schedule(retryDelay));
      return;
    }
    clearRetry();
    schedule(offline ? MIN_RETRY_MS : 400);
  };

  const onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      keepPlayingThroughSleep();
      return;
    }
    onForeground();
  };

  media.addEventListener('playing', onPlaying);
  media.addEventListener('pause', onMediaPause);
  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('waiting', onWaiting);
  media.addEventListener('stalled', onWaiting);
  media.addEventListener('error', onError);
  media.addEventListener('ended', onEnded);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('resume', onForeground);
  window.addEventListener('pageshow', onForeground);
  window.addEventListener('patradioscreen', onScreen);

  return {
    requestReconnect(): void {
      schedule(retryDelay);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      clearRetry();
      clearStall();
      clearSleepKick();
      media.removeEventListener('playing', onPlaying);
      media.removeEventListener('pause', onMediaPause);
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('waiting', onWaiting);
      media.removeEventListener('stalled', onWaiting);
      media.removeEventListener('error', onError);
      media.removeEventListener('ended', onEnded);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('resume', onForeground);
      window.removeEventListener('pageshow', onForeground);
      window.removeEventListener('patradioscreen', onScreen);
      releaseRadioAudioSession();
    }
  };
}

function claimRadioAudioSession(media: HTMLMediaElement): void {
  audioSessionOwners += 1;
  syncNativeRadio(true, radioTitle(media));
  const session = audioSession();
  if (!session) {
    return;
  }
  try {
    session.type = 'playback';
  } catch {
    /* unsupported */
  }
}

function releaseRadioAudioSession(): void {
  audioSessionOwners = Math.max(0, audioSessionOwners - 1);
  if (audioSessionOwners > 0) {
    return;
  }
  syncNativeRadio(false);
  const session = audioSession();
  if (!session) {
    return;
  }
  try {
    session.type = 'auto';
  } catch {
    /* unsupported */
  }
}

function audioSession(): { type: string } | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  return session || null;
}
