import { Injectable } from '@angular/core';

/**
 * Keeps TV / radio / YouTube / archive / book (any HTML media) playing when the
 * mobile PWA or tab goes to the background. Mobile Chrome pauses video elements
 * unless Picture-in-Picture or Media Session is active; YouTube iframes pause on hide.
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
  private youtubeUserPaused = false;
  private youtubeResumeAt = 0;
  private lastVisibleAt = 0;
  private pauseClassifyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly userPaused = new WeakMap<HTMLMediaElement, boolean>();
  private readonly prepared = new WeakSet<HTMLMediaElement>();
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
  }

  private handlePlay(event: Event): void {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement) || el.dataset['patSkipBackground'] === '1') {
      return;
    }
    const src = el.currentSrc || el.src || '';
    if (src.startsWith('data:')) {
      return;
    }
    this.prepareElement(el);
    this.userPaused.set(el, false);
    this.clearPauseClassifyTimer();
    this.active = el;
    this.bindMediaSession(el);
  }

  private handlePause(event: Event): void {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement) || el !== this.active) {
      return;
    }
    if (el.ended) {
      return;
    }
    if (this.isDocumentHidden()) {
      if (!this.userPaused.get(el)) {
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
      if (this.isDocumentHidden()) {
        if (!this.userPaused.get(el)) {
          this.resumeElement(el);
        }
        return;
      }
      this.userPaused.set(el, true);
      this.setPlaybackState('paused');
    }, 280);
  }

  private handleEnded(event: Event): void {
    const el = event.target;
    if (el === this.active) {
      this.setPlaybackState('none');
    }
  }

  private handleVisibility(): void {
    if (this.isDocumentHidden()) {
      this.keepHtmlMediaAlive();
      this.resumeYoutubeIframes();
      return;
    }
    this.lastVisibleAt = Date.now();
    const el = this.active;
    if (el && !this.userPaused.get(el) && el.paused && !el.ended) {
      this.resumeElement(el);
    }
    if (!this.youtubeUserPaused) {
      this.resumeYoutubeIframes();
    }
  }

  private keepHtmlMediaAlive(): void {
    const el = this.active;
    if (!el || this.userPaused.get(el) || el.ended) {
      return;
    }
    if (el instanceof HTMLVideoElement) {
      this.enableAutoPictureInPicture(el);
      void this.tryEnterPictureInPicture(el);
    }
    if (el.paused) {
      this.resumeElement(el);
    }
    this.setPlaybackState('playing');
  }

  /** Watch a media element that is not in the DOM (e.g. {@code new Audio()}). */
  watchMedia(el: HTMLMediaElement): void {
    this.start();
    this.prepareElement(el);
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

  private resumeElement(el: HTMLMediaElement): void {
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    this.setPlaybackState('playing');
  }

  private bindMediaSession(el: HTMLMediaElement): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const session = navigator.mediaSession;
    const existing = session.metadata;
    const title =
      (el.getAttribute('title') || el.getAttribute('data-pat-media-title') || existing?.title || '').trim() ||
      'PATTOOL';
    const artist = (existing?.artist || 'PATTOOL').trim();
    const artworkAttr = el.getAttribute('data-pat-media-artwork');
    const artwork =
      artworkAttr
        ? [{ src: artworkAttr, sizes: '512x512' }]
        : existing?.artwork && existing.artwork.length
          ? Array.from(existing.artwork)
          : [];
    try {
      session.metadata = new MediaMetadata({ title, artist, artwork });
    } catch {
      /* ignore */
    }
    this.setPlaybackState(el.paused ? 'paused' : 'playing');
    this.safeSetHandler('play', () => {
      this.userPaused.set(el, false);
      this.resumeElement(el);
    });
    this.safeSetHandler('pause', () => {
      this.userPaused.set(el, true);
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
      if (!this.userPaused.get(el) && el.paused && !el.ended) {
        this.resumeElement(el);
      }
      this.resumeYoutubeIframes();
    });
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
      this.youtubeUserPaused = false;
      this.applyYoutubeMediaSession();
      this.setPlaybackState('playing');
      return;
    }
    if (state === 0) {
      this.setPlaybackState('none');
      return;
    }
    if (state !== 2) {
      return;
    }
    const browserLikelyPaused = this.isDocumentHidden() || Date.now() - this.lastVisibleAt < 500;
    if (browserLikelyPaused && !this.youtubeUserPaused) {
      this.resumeYoutubeIframes();
      return;
    }
    this.youtubeUserPaused = true;
    this.setPlaybackState('paused');
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
    if (this.youtubeUserPaused) {
      return;
    }
    const now = Date.now();
    if (now - this.youtubeResumeAt < 400) {
      return;
    }
    this.youtubeResumeAt = now;
    for (const iframe of this.collectYoutubeIframes()) {
      this.postYoutubeCommand(iframe, 'playVideo');
    }
  }

  private applyYoutubeMediaSession(): void {
    const iframe = this.collectYoutubeIframes()[0];
    if (!iframe || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const title = (iframe.getAttribute('title') || '').trim() || 'YouTube';
    const src = iframe.getAttribute('src') || '';
    const idMatch = /\/embed\/([a-zA-Z0-9_-]{11})/.exec(src);
    const artwork = idMatch
      ? [{ src: `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }]
      : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: 'PATTOOL YouTube',
        artwork
      });
    } catch {
      /* ignore */
    }
    this.safeSetHandler('play', () => {
      this.youtubeUserPaused = false;
      this.resumeYoutubeIframes();
    });
    this.safeSetHandler('pause', () => {
      this.youtubeUserPaused = true;
      for (const frame of this.collectYoutubeIframes()) {
        this.postYoutubeCommand(frame, 'pauseVideo');
      }
    });
    this.safeSetHandler('enterpictureinpicture', () => {
      this.resumeYoutubeIframes();
    });
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

  private postYoutubeCommand(iframe: HTMLIFrameElement, func: string): void {
    if (!iframe.contentWindow) {
      return;
    }
    try {
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
    } catch {
      /* ignore */
    }
  }
}
