/**
 * Keeps a live radio stream alive across a screen lock and a dropped network.
 * The element must be an {@code <audio>} (a {@code <video>} is paused when the
 * phone sleeps). When the socket dies, the same station is reopened — including
 * after the network returns — until the listener stops it.
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
const MAX_RETRY_MS = 8000;
const PROGRESS_STALE_MS = 8000;
/** Silence tolerated after an offline event, while the buffer may still be playing out. */
const OFFLINE_STALE_MS = 2500;
/** Probe interval while the browser still says offline, so a missed online event still recovers. */
const OFFLINE_PROBE_MS = 4000;
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
  let announced = false;
  let offlineWaits = 0;
  /** Network dropped during this listen; reopen quickly once audio stops, until it actually plays again. */
  let recoverSoon = false;
  let startedAt = Date.now();
  let lastProgressAt = Date.now();
  let retryDelay = MIN_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let sleepKickTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSleepKick = 0;

  const userHold = (): boolean => media.dataset['patUserPaused'] === '1';

  const saysOffline = (): boolean =>
    offline || (typeof navigator !== 'undefined' && navigator.onLine === false);

  /** A finite file that fired ended (podcast). Live radio stays at the live edge and must not match this. */
  const naturalEnd = (): boolean => {
    const duration = media.duration;
    return media.ended && Number.isFinite(duration) && duration > 0;
  };

  const staleLimit = (): number =>
    saysOffline() || recoverSoon ? OFFLINE_STALE_MS : PROGRESS_STALE_MS;

  const hardError = (): boolean =>
    !!media.error && media.error.code !== MediaError.MEDIA_ERR_ABORTED;

  /**
   * Live audio that is not actually advancing. A stalled Icecast element often
   * stays unpaused with readyState HAVE_CURRENT_DATA, so that state is not treated as healthy.
   */
  const stalled = (): boolean => {
    if (userHold() || naturalEnd()) {
      return false;
    }
    if (hardError()) {
      return true;
    }
    if (!seenPlaying) {
      return Date.now() - startedAt >= STALL_BEFORE_START_MS;
    }
    if (media.paused || media.ended) {
      return true;
    }
    return Date.now() - lastProgressAt >= staleLimit();
  };

  const clearRetry = (): void => {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearProgress = (): void => {
    if (progressTimer != null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

  const clearStall = (): void => {
    if (stallTimer != null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const announce = (): void => {
    if (announced) {
      return;
    }
    announced = true;
    options.onReconnecting();
  };

  const armProgress = (): void => {
    clearProgress();
    if (disposed || !seenPlaying || userHold() || naturalEnd()) {
      return;
    }
    const limit = staleLimit();
    progressTimer = setTimeout(() => {
      progressTimer = null;
      planReload(limit === OFFLINE_STALE_MS ? 400 : MIN_RETRY_MS);
    }, limit);
  };

  /**
   * Reopen the live stream until audio is progressing again.
   * While the browser reports offline, wait for the online event, then probe
   * anyway so a missed event still restarts playback.
   * force=true skips the offline wait (the network just came back).
   */
  const planReload = (delay: number, force = false): void => {
    if (disposed || !options.isCurrent() || userHold() || naturalEnd()) {
      return;
    }
    if (!force && !stalled()) {
      return;
    }
    announce();
    if (retryTimer != null) {
      if (!force) {
        return;
      }
      clearRetry();
    }
    const wait = Math.max(300, delay);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || !options.isCurrent() || userHold() || naturalEnd()) {
        return;
      }
      if (!stalled()) {
        retryDelay = MIN_RETRY_MS;
        armProgress();
        return;
      }
      if (!force && saysOffline() && offlineWaits < 1) {
        offline = true;
        offlineWaits += 1;
        planReload(OFFLINE_PROBE_MS);
        return;
      }
      offlineWaits = 0;
      offline = false;
      retryDelay = Math.min(MAX_RETRY_MS, Math.round(retryDelay * 1.6));
      options.reload();
    }, wait);
  };

  const armStartWatch = (): void => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!seenPlaying) {
        planReload(MIN_RETRY_MS);
      }
    }, STALL_BEFORE_START_MS);
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
      void media.play().then(() => {
        if (disposed || !options.isCurrent() || userHold()) {
          return;
        }
        if (media.paused || media.error) {
          planReload(retryDelay);
        }
      }).catch(() => {
        if (disposed || !options.isCurrent() || userHold()) {
          return;
        }
        if (media.error || attempt >= 5) {
          planReload(retryDelay);
          return;
        }
        sleepKickTimer = setTimeout(() => kick(attempt + 1), 450);
      });
    };
    kick(0);
  };

  const noteProgress = (): void => {
    seenPlaying = true;
    announced = false;
    offlineWaits = 0;
    lastProgressAt = Date.now();
    retryDelay = MIN_RETRY_MS;
    if (!saysOffline()) {
      recoverSoon = false;
    }
    clearRetry();
    armProgress();
  };

  const onPlaying = (): void => {
    if (disposed) {
      return;
    }
    clearStall();
    noteProgress();
    syncNativeRadio(true, radioTitle(media));
  };

  const onMediaPause = (): void => {
    if (disposed || !options.isCurrent() || userHold() || naturalEnd()) {
      return;
    }
    const asleep =
      screenIsOff() || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    if (asleep) {
      keepPlayingThroughSleep();
      return;
    }
    planReload(700);
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
    clearStall();
    noteProgress();
  };

  const onWaiting = (): void => {
    if (!seenPlaying) {
      return;
    }
    if (stalled()) {
      planReload(saysOffline() ? 400 : MIN_RETRY_MS);
      return;
    }
    armProgress();
  };

  const onError = (): void => {
    if (disposed || !options.isCurrent() || userHold()) {
      return;
    }
    if (media.error && media.error.code === MediaError.MEDIA_ERR_ABORTED) {
      return;
    }
    planReload(saysOffline() ? OFFLINE_PROBE_MS : retryDelay);
  };

  const onEnded = (): void => {
    if (disposed || !options.isCurrent() || userHold() || naturalEnd()) {
      return;
    }
    planReload(retryDelay);
  };

  const onOnline = (): void => {
    offline = false;
    offlineWaits = 0;
    if (disposed || !options.isCurrent() || userHold() || naturalEnd()) {
      return;
    }
    const quiet = Date.now() - lastProgressAt;
    const needsRestart =
      seenPlaying && (media.paused || !!media.error || quiet >= OFFLINE_STALE_MS || stalled());
    if (!needsRestart) {
      armProgress();
      return;
    }
    recoverSoon = true;
    retryDelay = MIN_RETRY_MS;
    planReload(400, true);
  };

  const onOffline = (): void => {
    offline = true;
    recoverSoon = true;
    if (disposed || !options.isCurrent() || userHold() || naturalEnd() || !seenPlaying) {
      return;
    }
    const quiet = Date.now() - lastProgressAt;
    if (media.paused || !!media.error || quiet >= OFFLINE_STALE_MS) {
      planReload(400);
      return;
    }
    clearProgress();
    progressTimer = setTimeout(() => {
      progressTimer = null;
      planReload(400);
    }, Math.max(400, OFFLINE_STALE_MS - quiet));
  };

  const onForeground = (): void => {
    if (disposed || !options.isCurrent() || userHold() || naturalEnd()) {
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (!stalled()) {
      return;
    }
    planReload(400, true);
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
  media.addEventListener('progress', onTimeUpdate);
  media.addEventListener('error', onError);
  media.addEventListener('ended', onEnded);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('resume', onForeground);
  window.addEventListener('pageshow', onForeground);
  window.addEventListener('patradioscreen', onScreen);
  armStartWatch();

  return {
    requestReconnect(): void {
      planReload(retryDelay);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      clearRetry();
      clearProgress();
      clearStall();
      clearSleepKick();
      media.removeEventListener('playing', onPlaying);
      media.removeEventListener('pause', onMediaPause);
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('waiting', onWaiting);
      media.removeEventListener('stalled', onWaiting);
      media.removeEventListener('progress', onTimeUpdate);
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
