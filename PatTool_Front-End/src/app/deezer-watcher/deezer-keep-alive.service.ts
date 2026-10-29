import { Injectable } from '@angular/core';

import { DeezerTrack } from '../services/api.service';

/** Playback parked while Deezer is left, ready to be put back on the page. */
export interface DeezerKeptPlayback {
  audio: HTMLAudioElement | null;
  frame: HTMLIFrameElement | null;
  queue: DeezerTrack[];
  index: number;
  repeat: boolean;
  youtubeIds: Record<number, string>;
  volume: number;
  currentTime: number;
  playing: boolean;
}

/**
 * Keeps the Deezer list playing after the page is destroyed.
 * The current preview or YouTube frame is moved onto document.body,
 * then the saved queue advances until it is stopped.
 */
@Injectable({ providedIn: 'root' })
export class DeezerKeepAliveService {
  private audio: HTMLAudioElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private queue: DeezerTrack[] = [];
  private index = 0;
  private repeat = false;
  private youtubeIds: Record<number, string> = {};
  private volume = 0.9;
  private ignoreEndUntil = 0;
  private listening = false;

  private readonly onEnded = (): void => this.advance(0);
  private readonly onMessage = (event: MessageEvent): void => this.readYoutubeState(event);

  private playedSeconds = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  handoff(opts: {
    audio: HTMLAudioElement | null;
    frame: HTMLIFrameElement | null;
    /** The page player belongs to Angular and will be destroyed. Copy playback instead of moving it. */
    copyMedia: boolean;
    mediaTime: number;
    videoId: string;
    queue: DeezerTrack[];
    index: number;
    repeat: boolean;
    youtubeIds: Record<number, string>;
    volume: number;
  }): void {
    this.detach();
    this.queue = opts.queue || [];
    this.index = opts.index;
    this.repeat = opts.repeat;
    this.youtubeIds = opts.youtubeIds || {};
    this.volume = opts.volume;
    this.playedSeconds = opts.mediaTime > 0 ? opts.mediaTime : 0;
    const videoId = (opts.videoId || '').trim();
    if (videoId) {
      this.playVideo(videoId, this.playedSeconds);
    } else if (opts.frame && !opts.copyMedia) {
      this.frame = opts.frame;
      this.adoptFrame(opts.frame);
    } else if (opts.audio && opts.copyMedia) {
      this.spawnAudio(opts.audio.currentSrc || opts.audio.src, this.playedSeconds);
    } else if (opts.audio) {
      this.audio = opts.audio;
      this.adoptAudio(opts.audio);
    }
    if (!this.listening) {
      window.addEventListener('message', this.onMessage);
      this.listening = true;
    }
    this.watchPlayback();
  }

  /** Hand the live preview or video back to the page without pausing it. */
  reclaim(): DeezerKeptPlayback | null {
    if (!this.audio && !this.frame) {
      return null;
    }
    const audio = this.audio;
    const frame = this.frame;
    const playing = frame
      ? true
      : !!(audio && audio.src && !audio.paused && !audio.ended && !audio.error);
    const session: DeezerKeptPlayback = {
      audio,
      frame,
      queue: this.queue,
      index: this.index,
      repeat: this.repeat,
      youtubeIds: this.youtubeIds,
      volume: this.volume,
      currentTime: frame
        ? this.playedSeconds
        : audio && Number.isFinite(audio.currentTime)
          ? audio.currentTime
          : this.playedSeconds,
      playing
    };
    this.detach();
    return session;
  }

  stop(): void {
    this.detach();
    this.queue = [];
    document.querySelectorAll('[data-pat-deezer-keep="1"]').forEach((node) => {
      if (node instanceof HTMLMediaElement) {
        node.dataset['patUserPaused'] = '1';
        node.pause();
      }
      node.remove();
    });
  }

  private adoptAudio(audio: HTMLAudioElement): void {
    audio.dataset['patDeezerKeep'] = '1';
    audio.volume = this.volume;
    audio.addEventListener('ended', this.onEnded);
    audio.addEventListener('error', this.onEnded);
    if (audio.parentElement !== document.body) {
      document.body.appendChild(audio);
    }
  }

  private adoptFrame(frame: HTMLIFrameElement): void {
    frame.dataset['patDeezerKeep'] = '1';
    // Stay inside the viewport. A frame parked off-screen is frozen, so the
    // same video is still there when the page comes back.
    frame.style.position = 'fixed';
    frame.style.inset = 'auto';
    frame.style.left = '0';
    frame.style.bottom = '0';
    frame.style.width = '180px';
    frame.style.height = '100px';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    frame.style.border = '0';
    this.ignoreEndUntil = Date.now() + 4000;
    frame.addEventListener('load', () => this.armFrame(frame));
    if (frame.parentElement !== document.body) {
      document.body.appendChild(frame);
    }
    this.armFrame(frame);
  }

  private armFrame(frame: HTMLIFrameElement): void {
    const win = frame.contentWindow;
    if (!win) {
      return;
    }
    const send = (payload: unknown): void => {
      try {
        win.postMessage(JSON.stringify(payload), '*');
      } catch {
        /* the frame is gone */
      }
    };
    send({ event: 'listening', id: 'dz-keep' });
    send({ event: 'command', func: 'addEventListener', args: ['onStateChange'] });
    send({ event: 'command', func: 'unMute', args: [] });
    send({ event: 'command', func: 'setVolume', args: [Math.round(this.volume * 100)] });
  }

  private advance(hops: number): void {
    if (!this.queue.length || hops > this.queue.length) {
      this.stop();
      return;
    }
    let next = this.index + 1;
    if (next >= this.queue.length) {
      if (!this.repeat) {
        this.stop();
        return;
      }
      next = 0;
    }
    this.playAt(next, hops + 1);
  }

  private playAt(index: number, hops: number): void {
    const track = this.queue[index];
    if (!track) {
      this.stop();
      return;
    }
    this.index = index;
    const videoId = (this.youtubeIds[track.id] || '').trim();
    if (videoId) {
      this.playVideo(videoId);
      return;
    }
    const preview = (track.previewUrl || '').trim();
    if (preview) {
      this.playPreview(preview);
      return;
    }
    this.advance(hops);
  }

  private playPreview(url: string): void {
    this.removeFrame();
    let audio = this.audio;
    if (!audio) {
      audio = document.createElement('audio');
      audio.preload = 'none';
      audio.crossOrigin = 'anonymous';
      this.audio = audio;
      this.adoptAudio(audio);
    }
    audio.volume = this.volume;
    delete audio.dataset['patUserPaused'];
    audio.src = url;
    audio.play().catch(() => this.advance(0));
  }

  private playVideo(id: string, startSec = 0): void {
    if (this.audio) {
      this.audio.pause();
    }
    this.removeFrame();
    const origin = `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`;
    const start = startSec > 1 ? `&start=${Math.floor(startSec)}` : '';
    const frame = document.createElement('iframe');
    frame.title = 'YouTube';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1&playsinline=1&controls=0&fs=0&iv_load_policy=3${start}${origin}`;
    this.frame = frame;
    this.playedSeconds = startSec;
    this.adoptFrame(frame);
  }

  private readYoutubeState(event: MessageEvent): void {
    if (!this.frame) {
      return;
    }
    const origin = (event.origin || '').toLowerCase();
    if (!origin.includes('youtube.com') && !origin.includes('youtube-nocookie.com')) {
      return;
    }
    let data: unknown = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') {
      return;
    }
    const payload = data as { event?: string; info?: number | Record<string, unknown> };
    if (payload.event === 'infoDelivery' && typeof payload.info === 'number' && payload.info >= 0) {
      this.playedSeconds = payload.info;
      return;
    }
    if (payload.info && typeof payload.info === 'object' && typeof payload.info['currentTime'] === 'number') {
      this.playedSeconds = payload.info['currentTime'] as number;
    }
    let state: number | undefined;
    if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
      state = payload.info;
    } else if (payload.info && typeof payload.info === 'object' && typeof payload.info['playerState'] === 'number') {
      state = payload.info['playerState'] as number;
    }
    if (state === 0 && Date.now() >= this.ignoreEndUntil) {
      this.advance(0);
    }
  }

  private removeFrame(): void {
    if (!this.frame) {
      return;
    }
    this.frame.remove();
    this.frame = null;
  }

  private spawnAudio(url: string, time: number): void {
    if (!url) {
      return;
    }
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    this.audio = audio;
    this.adoptAudio(audio);
    const resume = (): void => {
      if (time > 0.3) {
        try {
          audio.currentTime = time;
        } catch {
          /* not seekable yet */
        }
      }
      audio.play().catch(() => this.advance(0));
    };
    audio.addEventListener('loadedmetadata', resume, { once: true });
    audio.addEventListener('playing', () => {
      if (time > 0.5 && audio.currentTime < 0.35) {
        try {
          audio.currentTime = time;
        } catch {
          /* ignore */
        }
      }
    }, { once: true });
    audio.src = url;
  }

  private watchPlayback(): void {
    this.stopClock();
    this.clockTimer = setInterval(() => {
      if (this.audio && !this.audio.paused && Number.isFinite(this.audio.currentTime)) {
        this.playedSeconds = this.audio.currentTime;
        return;
      }
      const win = this.frame?.contentWindow;
      if (!win) {
        return;
      }
      try {
        win.postMessage(JSON.stringify({ event: 'command', func: 'getCurrentTime', args: [], id: 'dz-keep' }), '*');
      } catch {
        /* the frame is gone */
      }
    }, 1000);
  }

  private stopClock(): void {
    if (this.clockTimer != null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private detach(): void {
    this.stopClock();
    if (this.audio) {
      this.audio.removeEventListener('ended', this.onEnded);
      this.audio.removeEventListener('error', this.onEnded);
    }
    this.audio = null;
    this.frame = null;
    if (this.listening) {
      window.removeEventListener('message', this.onMessage);
      this.listening = false;
    }
  }
}
