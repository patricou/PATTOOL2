import { Injectable } from '@angular/core';
import { screenIsOff, setScreenKeepAlive, withBluetoothAppName } from './media-screen-keepalive';

/**
 * Keeps TV / radio / YouTube / archive / book (any HTML media) playing when the
 * mobile PWA or tab goes to the background. Mobile Chrome pauses video elements
 * unless Picture-in-Picture or Media Session is active; YouTube iframes pause on hide.
 *
 * GPS keep-alive audio (data-pat-keep-alive) is resumed too, but does not steal
 * Media Session from a real player.
 */
type AutoPipVideo = HTMLVideoElement & {
  autoPictureInPicture?: boolean;
  disablePictureInPicture?: boolean;
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture' | 'fullscreen') => void;
};

interface DocumentPictureInPictureApi {
  window: Window | null;
}

@Injectable({ providedIn: 'root' })
export class BackgroundPlaybackService {
  private started = false;
  private active: HTMLMediaElement | null = null;
  /** True only after a YouTube iframe reported playing/buffering. */
  private youtubePlaying = false;
  private youtubeUserPaused = true;
  /** Lock-screen or in-app pause button, not a pause caused by the screen turning off. */
  private youtubeExplicitPause = false;
  private youtubePauseMarkedAt = 0;
  private youtubePauseTimer: ReturnType<typeof setTimeout> | null = null;
  private youtubeSleepKick: ReturnType<typeof setTimeout> | null = null;
  private youtubeResumeAt = 0;
  /**
   * A clip just finished while the screen is off. The page starts the next title
   * in that same moment. The playback service must stay up: Android will not
   * start it again once the display is already off. playVideo is held back until
   * the iframe src changes, so the finished clip is not started over.
   */
  private youtubeHandoffUntil = 0;
  private youtubeHandoffSrc = '';
  private youtubeHandoffTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVisibleAt = 0;
  private pauseClassifyTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenResumeTimer: ReturnType<typeof setInterval> | null = null;
  private hiddenResumeStartedAt = 0;
  private readonly userPaused = new WeakMap<HTMLMediaElement, boolean>();
  private readonly prepared = new WeakSet<HTMLMediaElement>();
  private readonly keepAlives = new Set<HTMLMediaElement>();
  private readonly releasedKeepAlives = new WeakSet<HTMLMediaElement>();
  private readonly onPlay = (event: Event): void => this.handlePlay(event);
  private readonly onPause = (event: Event): void => this.handlePause(event);
  private readonly onEnded = (event: Event): void => this.handleEnded(event);
  private readonly onLoadedMeta = (event: Event): void => {
    const el = event.target;
    if (el instanceof HTMLVideoElement) {
      this.enableAutoPictureInPicture(el);
    }
  };
  private readonly onVisibility = (): void => this.handleVisibility();
  private readonly onYoutubeMessage = (event: MessageEvent): void => this.handleYoutubeMessage(event);
  private readonly onScreenPower = (): void => this.handleScreenPower();
  private readonly onDeviceVolume = (event: Event): void => {
    const raw = Number((event as CustomEvent<number>).detail);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.applyDeviceVolume(Math.max(0, Math.min(100, Math.round(raw))));
  };

  /** Call once from the app shell so capture is active on every route. */
  start(): void {
    if (this.started || typeof document === 'undefined') {
      return;
    }
    this.started = true;
    this.lastVisibleAt = Date.now();
    document.addEventListener('play', this.onPlay, true);
    document.addEventListener('pause', this.onPause, true);
    document.addEventListener('ended', this.onEnded, true);
    document.addEventListener('loadedmetadata', this.onLoadedMeta, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('freeze', this.onVisibility);
    document.addEventListener('resume', this.onVisibility);
    window.addEventListener('pagehide', this.onVisibility);
    window.addEventListener('pageshow', this.onVisibility);
    window.addEventListener('message', this.onYoutubeMessage);
    window.addEventListener('patradioscreen', this.onScreenPower);
    window.addEventListener('patmediavolume', this.onDeviceVolume);
  }

  /** Watch a media element that is not in the DOM (e.g. {@code new Audio()}). */
  watchMedia(el: HTMLMediaElement): void {
    this.start();
    this.prepareElement(el);
  }

  /** Call before pausing a keep-alive so background resume will not restart it. */
  markUserPaused(el: HTMLMediaElement): void {
    this.userPaused.set(el, true);
    this.releasedKeepAlives.add(el);
    if (this.active === el) {
      this.active = this.pickFallbackActive(el);
      if (this.active) {
        this.bindMediaSession(this.active);
      } else {
        this.setPlaybackState('none');
      }
    }
  }

  private handlePlay(event: Event): void {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement) || el.dataset['patSkipBackground'] === '1') {
      return;
    }
    const src = el.currentSrc || el.src || '';
    const keepAlive = this.isKeepAlive(el);
    if (!keepAlive && src.startsWith('data:')) {
      return;
    }
    this.prepareElement(el);
    this.userPaused.set(el, false);
    delete el.dataset['patUserPaused'];
    this.releasedKeepAlives.delete(el);
    this.clearPauseClassifyTimer();
    if (keepAlive) {
      this.keepAlives.add(el);
      if (this.active && this.active !== el && !this.isKeepAlive(this.active) && !this.active.paused) {
        return;
      }
    }
    this.active = el;
    this.bindMediaSession(el);
    this.syncClipKeepAlive(el, true);
  }

  private handlePause(event: Event): void {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement) || el.dataset['patSkipBackground'] === '1') {
      return;
    }
    if (this.isKeepAlive(el)) {
      if (!this.releasedKeepAlives.has(el) && !el.ended) {
        this.resumeElement(el);
      }
      return;
    }
    if (el !== this.active) {
      return;
    }
    if (el.ended) {
      return;
    }
    if (this.isDocumentHidden()) {
      if (!this.userStopped(el)) {
        this.resumeElement(el);
      }
      return;
    }
    // Chrome may pause video a tick before visibilitychange when backgrounding.
    this.clearPauseClassifyTimer();
    this.pauseClassifyTimer = setTimeout(() => {
      this.pauseClassifyTimer = null;
      if (el !== this.active || el.ended) {
        return;
      }
      if (this.isDocumentHidden() || screenIsOff()) {
        if (!this.userStopped(el)) {
          this.resumeElement(el);
        }
        return;
      }
      if (el.dataset['patRadio'] === '1') {
        // A visible pause is a phone call or a dropped stream. Do not mark it as a
        // user stop — the radio guard reloads the stream. Lock-screen pause sets
        // patUserPaused from the media session before this timer runs.
        return;
      }
      this.userPaused.set(el, true);
      el.dataset['patUserPaused'] = '1';
      this.syncClipKeepAlive(el, false);
      this.setPlaybackState('paused');
    }, 280);
  }

  private handleEnded(event: Event): void {
    const el = event.target;
    if (el instanceof HTMLMediaElement) {
      this.syncClipKeepAlive(el, false);
    }
    if (el === this.active) {
      this.active = null;
      this.setPlaybackState('none');
    }
  }

  /** Saved recording played on the YouTube page (a video element, not the iframe). */
  private syncClipKeepAlive(el: HTMLMediaElement, playing: boolean): void {
    if (!el.classList.contains('yt-page-clip')) {
      return;
    }
    const title = (el.getAttribute('title') || el.getAttribute('data-pat-media-title') || '').trim();
    setScreenKeepAlive('clip', playing, title || 'YouTube');
  }

  private handleVisibility(): void {
    if (this.isDocumentHidden()) {
      if (!this.hasActivePlayback()) {
        this.stopHiddenResumeLoop();
        return;
      }
      this.keepHtmlMediaAlive();
      this.resumeYoutubeIframes();
      this.startHiddenResumeLoop();
      return;
    }
    this.stopHiddenResumeLoop();
    this.lastVisibleAt = Date.now();
    if (!this.hasActivePlayback()) {
      return;
    }
    const el = this.active;
    if (el && !this.userStopped(el) && el.paused && !el.ended) {
      this.resumeElement(el);
    }
    this.resumeKeepAlives();
    this.resumeYoutubeIframes();
  }

  /** True only if something was already playing (or GPS recording keep-alive). */
  private hasActivePlayback(): boolean {
    if (this.youtubePlaying && !this.youtubeUserPaused) {
      return true;
    }
    const el = this.active;
    if (el && !this.userStopped(el) && !el.ended) {
      return true;
    }
    for (const keep of this.keepAlives) {
      if (this.releasedKeepAlives.has(keep) || keep.ended || this.userStopped(keep)) {
        continue;
      }
      return true;
    }
    return false;
  }

  private keepHtmlMediaAlive(): void {
    const el = this.active;
    if (el && !this.userStopped(el) && !el.ended) {
      if (el instanceof HTMLVideoElement) {
        this.enableAutoPictureInPicture(el);
        void this.tryEnterPictureInPicture(el);
      }
      if (el.paused) {
        this.resumeElement(el);
      } else {
        this.setPlaybackState('playing');
      }
    }
    this.resumeKeepAlives();
    this.resumeOrphanPlayingMedia();
  }

  private resumeKeepAlives(): void {
    this.keepAlives.forEach((el) => {
      if (this.releasedKeepAlives.has(el) || el.ended) {
        return;
      }
      if (el.paused) {
        this.resumeElement(el, false);
      }
    });
  }

  /** Page video that started before this service bound it as active. */
  private resumeOrphanPlayingMedia(): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.querySelectorAll('video, audio').forEach((node) => {
      if (!(node instanceof HTMLMediaElement) || node === this.active) {
        return;
      }
      if (this.isKeepAlive(node) || node.dataset['patSkipBackground'] === '1') {
        return;
      }
      if (this.userStopped(node) || node.ended || node.paused) {
        return;
      }
      if (!this.active || this.active.paused || this.isKeepAlive(this.active)) {
        this.active = node;
        this.bindMediaSession(node);
      }
    });
  }

  private startHiddenResumeLoop(): void {
    this.stopHiddenResumeLoop();
    if (!this.hasActivePlayback()) {
      return;
    }
    this.hiddenResumeStartedAt = Date.now();
    this.hiddenResumeTimer = setInterval(() => this.tickHiddenResume(true), 400);
  }

  private tickHiddenResume(allowSpeedSwitch: boolean): void {
    if (!this.isDocumentHidden() || !this.hasActivePlayback()) {
      this.stopHiddenResumeLoop();
      return;
    }
    this.keepHtmlMediaAlive();
    this.resumeYoutubeIframes();
    if (!allowSpeedSwitch || Date.now() - this.hiddenResumeStartedAt <= 5000) {
      return;
    }
    if (this.hiddenResumeTimer == null) {
      return;
    }
    clearInterval(this.hiddenResumeTimer);
    this.hiddenResumeTimer = setInterval(() => this.tickHiddenResume(false), 2000);
  }

  private stopHiddenResumeLoop(): void {
    if (this.hiddenResumeTimer != null) {
      clearInterval(this.hiddenResumeTimer);
      this.hiddenResumeTimer = null;
    }
  }

  private prepareElement(el: HTMLMediaElement): void {
    if (this.prepared.has(el)) {
      return;
    }
    this.prepared.add(el);
    try {
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', 'true');
      (el as HTMLMediaElement & { playsInline?: boolean }).playsInline = true;
    } catch {
      /* ignore */
    }
    el.addEventListener('play', this.onPlay);
    el.addEventListener('pause', this.onPause);
    el.addEventListener('ended', this.onEnded);
    if (el instanceof HTMLVideoElement) {
      el.addEventListener('loadedmetadata', this.onLoadedMeta);
      this.enableAutoPictureInPicture(el);
    }
  }

  private enableAutoPictureInPicture(video: HTMLVideoElement): void {
    const v = video as AutoPipVideo;
    try {
      v.disablePictureInPicture = false;
    } catch {
      /* ignore */
    }
    // Audio-only streams (radio) have no video frames — skip a black PiP box.
    if (video.readyState >= 1 && video.videoWidth <= 0) {
      try {
        v.autoPictureInPicture = false;
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      v.autoPictureInPicture = true;
    } catch {
      /* ignore */
    }
  }

  private async tryEnterPictureInPicture(video: HTMLVideoElement): Promise<void> {
    if (video.videoWidth <= 0) {
      return;
    }
    if (typeof document !== 'undefined' && document.pictureInPictureElement === video) {
      return;
    }
    const v = video as AutoPipVideo;
    try {
      if (typeof video.requestPictureInPicture === 'function') {
        await video.requestPictureInPicture();
        return;
      }
    } catch {
      /* needs a user gesture, or auto-PiP handler will retry */
    }
    try {
      v.webkitSetPresentationMode?.('picture-in-picture');
    } catch {
      /* iOS may still require a gesture */
    }
  }

  private resumeElement(el: HTMLMediaElement, updateSession = true): void {
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    if (updateSession && el === this.active) {
      this.setPlaybackState('playing');
    }
  }

  private bindMediaSession(el: HTMLMediaElement): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const existing = session.metadata;
    const title = withBluetoothAppName(
      (el.getAttribute('data-pat-media-title') || el.getAttribute('title') || existing?.title || '').trim()
    );
    const artistAttr = el.getAttribute('data-pat-media-artist');
    const albumAttr = el.getAttribute('data-pat-media-album');
    const artist = cleanBluetoothArtist(artistAttr !== null ? artistAttr : existing?.artist || '');
    const album = (albumAttr !== null ? albumAttr : existing?.album || '').trim();
    const artworkAttr = el.getAttribute('data-pat-media-artwork');
    const artwork =
      artworkAttr
        ? [{ src: artworkAttr, sizes: '512x512' }]
        : existing?.artwork && existing.artwork.length
          ? Array.from(existing.artwork)
          : [];
    try {
      session.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch {
      /* ignore */
    }
    this.setPlaybackState(el.paused ? 'paused' : 'playing');
    this.syncPositionState(el);
    const keepAlive = this.isKeepAlive(el);
    this.safeSetHandler('play', () => {
      this.userPaused.set(el, false);
      delete el.dataset['patUserPaused'];
      this.releasedKeepAlives.delete(el);
      this.resumeElement(el);
    });
    this.safeSetHandler('pause', () => {
      if (keepAlive) {
        this.resumeElement(el);
        return;
      }
      this.userPaused.set(el, true);
      el.dataset['patUserPaused'] = '1';
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      this.setPlaybackState('paused');
    });
    this.safeSetHandler('enterpictureinpicture', async () => {
      if (el instanceof HTMLVideoElement) {
        await this.tryEnterPictureInPicture(el);
      }
      if (!this.userStopped(el) && el.paused && !el.ended) {
        this.resumeElement(el);
      }
      if (this.youtubePlaying && !this.youtubeUserPaused) {
        this.resumeYoutubeIframes();
      }
    });
  }

  private syncPositionState(el: HTMLMediaElement): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const duration = el.duration;
    const position = el.currentTime;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: el.playbackRate || 1,
        position: Math.min(position, duration)
      });
    } catch {
      /* live streams / unsupported */
    }
  }

  private setPlaybackState(state: MediaSessionPlaybackState): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      /* ignore */
    }
  }

  private safeSetHandler(action: string, handler: () => void | Promise<void>): void {
    try {
      navigator.mediaSession.setActionHandler(action as MediaSessionAction, () => {
        void handler();
      });
    } catch {
      /* unsupported action (enterpictureinpicture is Chromium) */
    }
  }

  private clearPauseClassifyTimer(): void {
    if (this.pauseClassifyTimer != null) {
      clearTimeout(this.pauseClassifyTimer);
      this.pauseClassifyTimer = null;
    }
  }

  private isDocumentHidden(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    return document.visibilityState === 'hidden' || document.hidden;
  }

  private isKeepAlive(el: HTMLMediaElement): boolean {
    return el.dataset['patKeepAlive'] === '1';
  }

  /** In-app pause and the lock-screen pause both set this before the element stops. */
  private userStopped(el: HTMLMediaElement): boolean {
    return this.userPaused.get(el) === true || el.dataset['patUserPaused'] === '1';
  }

  private pickFallbackActive(except: HTMLMediaElement): HTMLMediaElement | null {
    if (typeof document === 'undefined') {
      return null;
    }
    const nodes = Array.from(document.querySelectorAll('video, audio'));
    for (const node of nodes) {
      if (!(node instanceof HTMLMediaElement) || node === except) {
        continue;
      }
      if (this.isKeepAlive(node) || node.paused || node.ended) {
        continue;
      }
      return node;
    }
    return null;
  }

  private handleYoutubeMessage(event: MessageEvent): void {
    const origin = (event.origin || '').toLowerCase();
    if (!origin.includes('youtube.com') && !origin.includes('youtube-nocookie.com')) {
      return;
    }
    const state = this.readYoutubePlayerState(event.data);
    if (state === undefined) {
      return;
    }
    if (state === 1 || state === 3) {
      this.clearYoutubePauseTimer();
      this.clearYoutubeSleepKick();
      this.clearYoutubeHandoff();
      this.youtubePlaying = true;
      this.youtubeUserPaused = false;
      this.youtubeExplicitPause = false;
      this.applyYoutubeMediaSession();
      this.setPlaybackState('playing');
      const track = this.youtubeTrack();
      setScreenKeepAlive('youtube', true, track.title, { artist: track.artist, album: track.album });
      return;
    }
    if (state === 0) {
      this.clearYoutubePauseTimer();
      if (!this.youtubeExplicitPause && !this.youtubeMarkedUserPause() && (screenIsOff() || this.isDocumentHidden())) {
        this.youtubePlaying = true;
        this.youtubeUserPaused = false;
        this.armYoutubeHandoff();
        return;
      }
      this.clearYoutubeHandoff();
      this.youtubePlaying = false;
      this.youtubeUserPaused = true;
      this.youtubeExplicitPause = false;
      this.setPlaybackState('none');
      setScreenKeepAlive('youtube', false);
      return;
    }
    if (state !== 2) {
      return;
    }
    if (this.youtubeMarkedUserPause()) {
      this.clearYoutubePauseTimer();
      this.clearYoutubeSleepKick();
      this.clearYoutubeHandoff();
      this.youtubePlaying = false;
      this.youtubeUserPaused = true;
      this.youtubeExplicitPause = true;
      this.setPlaybackState('paused');
      setScreenKeepAlive('youtube', false);
      return;
    }
    // The WebView pauses the clip before the screen-off flag exists.
    // Do not treat that as the listener stopping the song.
    this.clearYoutubePauseTimer();
    this.youtubePlaying = true;
    this.youtubeUserPaused = false;
    this.youtubeExplicitPause = false;
    this.resumeYoutubeIframes();
    this.scheduleYoutubeSleepKick();
  }

  /** Screen off: keep a video that was already playing, and undo a pause the phone just caused. */
  private handleScreenPower(): void {
    if (!screenIsOff()) {
      return;
    }
    const el = this.active;
    if (el && !this.userStopped(el) && !el.ended && el.paused) {
      this.resumeElement(el);
    }
    const justMarked = this.youtubePauseMarkedAt > 0 && Date.now() - this.youtubePauseMarkedAt < 1200;
    if (this.youtubeUserPaused && justMarked && !this.youtubeExplicitPause) {
      this.youtubePlaying = true;
      this.youtubeUserPaused = false;
      const track = this.youtubeTrack();
      setScreenKeepAlive('youtube', true, track.title, { artist: track.artist, album: track.album });
    }
    if (!this.youtubePlaying || this.youtubeUserPaused) {
      return;
    }
    this.resumeYoutubeIframes();
    this.scheduleYoutubeSleepKick();
  }

  private scheduleYoutubeSleepKick(): void {
    if (this.youtubeSleepKick != null) {
      return;
    }
    let attempt = 0;
    const started = Date.now();
    const tick = (): void => {
      this.youtubeSleepKick = null;
      if (!this.youtubePlaying || this.youtubeUserPaused || this.youtubeExplicitPause || this.youtubeMarkedUserPause()) {
        return;
      }
      const asleep = screenIsOff() || this.isDocumentHidden();
      const grace = Date.now() - started < 4000;
      if (!asleep && !grace) {
        this.youtubePlaying = false;
        this.youtubeUserPaused = true;
        this.youtubePauseMarkedAt = Date.now();
        this.setPlaybackState('paused');
        setScreenKeepAlive('youtube', false);
        return;
      }
      this.resumeYoutubeIframes();
      attempt += 1;
      if (attempt < 24) {
        this.youtubeSleepKick = setTimeout(tick, attempt < 8 ? 400 : 1500);
      }
    };
    this.youtubeSleepKick = setTimeout(tick, 200);
  }

  private clearYoutubeSleepKick(): void {
    if (this.youtubeSleepKick != null) {
      clearTimeout(this.youtubeSleepKick);
      this.youtubeSleepKick = null;
    }
  }

  private clearYoutubePauseTimer(): void {
    if (this.youtubePauseTimer != null) {
      clearTimeout(this.youtubePauseTimer);
      this.youtubePauseTimer = null;
    }
  }

  private youtubeTrack(): { title: string; artist: string; album: string } {
    const iframe = this.collectYoutubeIframes()[0];
    const title = withBluetoothAppName(
      (iframe?.getAttribute('data-pat-media-title') || iframe?.getAttribute('title') || '').trim() || 'YouTube'
    );
    const artist = cleanBluetoothArtist(iframe?.getAttribute('data-pat-media-artist') || '');
    const album = (iframe?.getAttribute('data-pat-media-album') || '').trim();
    return { title, artist, album };
  }

  private readYoutubePlayerState(raw: unknown): number | undefined {
    let data: unknown = raw;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return undefined;
      }
    }
    if (!data || typeof data !== 'object') {
      return undefined;
    }
    const payload = data as { event?: string; info?: number | Record<string, unknown> };
    if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
      return payload.info;
    }
    if (payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info)) {
      const playerState = payload.info['playerState'];
      if (typeof playerState === 'number') {
        return playerState;
      }
    }
    return undefined;
  }

  private resumeYoutubeIframes(): void {
    if (!this.youtubePlaying || this.youtubeUserPaused || this.youtubeExplicitPause) {
      return;
    }
    const now = Date.now();
    if (now - this.youtubeResumeAt < 250) {
      return;
    }
    const handoff = now < this.youtubeHandoffUntil;
    this.youtubeResumeAt = now;
    for (const iframe of this.collectYoutubeIframes()) {
      if (iframe.dataset['patUserPaused'] === '1') {
        continue;
      }
      if (handoff && iframe.src === this.youtubeHandoffSrc) {
        continue;
      }
      this.postYoutubePayload(iframe, { event: 'listening', id: 'yt-bg' });
      this.postYoutubeCommand(iframe, 'addEventListener', ['onStateChange']);
      this.postYoutubeCommand(iframe, 'playVideo');
    }
  }

  /** The listener paused. A pause caused by the screen turning off does not set this. */
  private youtubeMarkedUserPause(): boolean {
    return this.collectYoutubeIframes().some((frame) => frame.dataset['patUserPaused'] === '1');
  }

  private armYoutubeHandoff(): void {
    const frame = this.collectYoutubeIframes().find((item) => item.dataset['patUserPaused'] !== '1');
    this.youtubeHandoffSrc = frame?.src || '';
    this.youtubeHandoffUntil = Date.now() + 20000;
    if (this.youtubeHandoffTimer != null) {
      clearTimeout(this.youtubeHandoffTimer);
    }
    this.youtubeHandoffTimer = setTimeout(() => {
      this.youtubeHandoffTimer = null;
      if (Date.now() < this.youtubeHandoffUntil) {
        return;
      }
      this.youtubeHandoffSrc = '';
      this.youtubeHandoffUntil = 0;
      if (this.youtubeExplicitPause || this.youtubeUserPaused || !this.youtubePlaying) {
        return;
      }
      this.youtubePlaying = false;
      this.youtubeUserPaused = true;
      this.setPlaybackState('none');
      setScreenKeepAlive('youtube', false);
    }, 20000);
  }

  private clearYoutubeHandoff(): void {
    this.youtubeHandoffUntil = 0;
    this.youtubeHandoffSrc = '';
    if (this.youtubeHandoffTimer != null) {
      clearTimeout(this.youtubeHandoffTimer);
      this.youtubeHandoffTimer = null;
    }
  }

  private applyYoutubeMediaSession(): void {
    const iframe = this.collectYoutubeIframes()[0];
    if (!iframe || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const track = this.youtubeTrack();
    const src = iframe.getAttribute('src') || '';
    const idMatch = /\/embed\/([a-zA-Z0-9_-]{11})/.exec(src);
    const artwork = idMatch
      ? [{ src: `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }]
      : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork
      });
    } catch {
      /* ignore */
    }
    this.safeSetHandler('play', () => {
      this.youtubePlaying = true;
      this.youtubeUserPaused = false;
      this.youtubeExplicitPause = false;
      setScreenKeepAlive('youtube', true, track.title, { artist: track.artist, album: track.album });
      this.resumeYoutubeIframes();
    });
    this.safeSetHandler('pause', () => {
      this.clearYoutubePauseTimer();
      this.youtubePlaying = false;
      this.youtubeUserPaused = true;
      this.youtubeExplicitPause = true;
      setScreenKeepAlive('youtube', false);
      for (const frame of this.collectYoutubeIframes()) {
        this.postYoutubeCommand(frame, 'pauseVideo');
      }
    });
    this.safeSetHandler('enterpictureinpicture', () => {
      if (this.youtubePlaying && !this.youtubeUserPaused) {
        this.resumeYoutubeIframes();
      }
    });
    const skip = (action: 'next' | 'previous') => {
      window.dispatchEvent(new CustomEvent('patradiotransport', { detail: action }));
    };
    this.safeSetHandler('nexttrack', () => skip('next'));
    this.safeSetHandler('previoustrack', () => skip('previous'));
  }

  private collectYoutubeIframes(): HTMLIFrameElement[] {
    const found: HTMLIFrameElement[] = [];
    const seen = new Set<HTMLIFrameElement>();
    const addFrom = (root: Document | null | undefined) => {
      if (!root) {
        return;
      }
      root.querySelectorAll('iframe').forEach((iframe) => {
        const src = (iframe.getAttribute('src') || '').toLowerCase();
        if (!src.includes('youtube.com/embed') && !src.includes('youtube-nocookie.com/embed')) {
          return;
        }
        if (seen.has(iframe)) {
          return;
        }
        seen.add(iframe);
        found.push(iframe);
      });
    };
    addFrom(document);
    try {
      const dpi = (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi })
        .documentPictureInPicture;
      if (dpi?.window && !dpi.window.closed) {
        addFrom(dpi.window.document);
      }
    } catch {
      /* ignore */
    }
    return found;
  }

  private postYoutubeCommand(iframe: HTMLIFrameElement, func: string, args: unknown[] = []): void {
    this.postYoutubePayload(iframe, { event: 'command', func, args });
  }

  /**
   * Bluetooth volume is the phone media volume. Keep the players fully open
   * so that level is the only gain, for the radio element and the YouTube player.
   */
  private applyDeviceVolume(percent: number): void {
    window.dispatchEvent(new CustomEvent('patmediavolumeui', { detail: percent }));
    if (typeof document !== 'undefined') {
      document.querySelectorAll('audio[data-pat-radio="1"]').forEach((node) => {
        if (!(node instanceof HTMLMediaElement)) {
          return;
        }
        node.muted = percent === 0;
        node.volume = percent === 0 ? 0 : 1;
        node.dispatchEvent(new Event('volumechange'));
      });
    }
    for (const iframe of this.collectYoutubeIframes()) {
      this.postYoutubeCommand(iframe, percent === 0 ? 'mute' : 'unMute');
      this.postYoutubeCommand(iframe, 'setVolume', [percent === 0 ? 0 : 100]);
    }
  }

  private postYoutubePayload(iframe: HTMLIFrameElement, payload: object): void {
    if (!iframe.contentWindow) {
      return;
    }
    try {
      iframe.contentWindow.postMessage(JSON.stringify(payload), '*');
    } catch {
      /* ignore */
    }
  }
}

/** Drops the old app label so it does not take a line on the car screen. */
function cleanBluetoothArtist(value: string): string {
  const text = value.trim().replace(/^pattool\s*-\s*/i, '');
  if (!text || /^pattool$/i.test(text) || /^pattool youtube$/i.test(text) || /^pattool radio$/i.test(text)) {
    return '';
  }
  return text;
}
