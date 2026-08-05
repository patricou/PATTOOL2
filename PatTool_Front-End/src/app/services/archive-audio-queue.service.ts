import { Injectable } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';

import { ApiService, ArchiveFile, ArchiveItem, ArchiveItemDetail } from './api.service';

export type ArchiveQueueSource = 'playlist' | 'catalog' | 'recent' | 'none';

export interface ArchiveAudioQueueTrack {
  name: string;
  url: string;
}

export interface ArchiveAudioQueueState {
  active: boolean;
  queue: ArchiveItem[];
  index: number;
  source: ArchiveQueueSource;
  current: ArchiveItem | null;
  detail: ArchiveItemDetail | null;
  mediaUrl: string;
  paused: boolean;
  /** True while the archive-watcher page is mounted and owning the UI. */
  pageAttached: boolean;
  currentTime: number;
  duration: number;
  loading: boolean;
  /** Index of the current audio file inside the current Archive item. */
  trackIndex: number;
  /** Distinct playable audio tracks in the current item (deduped formats). */
  trackCount: number;
  /** Display name of the current track file. */
  trackName: string;
}

const EMPTY_STATE: ArchiveAudioQueueState = {
  active: false,
  queue: [],
  index: -1,
  source: 'none',
  current: null,
  detail: null,
  mediaUrl: '',
  paused: true,
  pageAttached: false,
  currentTime: 0,
  duration: 0,
  loading: false,
  trackIndex: -1,
  trackCount: 0,
  trackName: ''
};

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;
const LOW_BITRATE_RE = /_(64|128|192|256)kb/i;
const FORMAT_RANK: Record<string, number> = {
  mp3: 6,
  m4a: 5,
  aac: 4,
  ogg: 3,
  opus: 2,
  flac: 1,
  wav: 0
};

/**
 * Persistent Archive.org audio queue (“Tout lire”).
 * Owns a long-lived HTMLAudioElement so playback survives route changes.
 * Within each Archive item, plays every distinct audio track (formats deduped), then advances.
 */
@Injectable({ providedIn: 'root' })
export class ArchiveAudioQueueService {
  private readonly stateSubject = new BehaviorSubject<ArchiveAudioQueueState>({ ...EMPTY_STATE });
  readonly state$ = this.stateSubject.asObservable();

  private readonly audio = new Audio();
  private loadSub?: Subscription;
  private gestureAudio?: HTMLAudioElement;
  private loadGeneration = 0;
  private itemTracks: ArchiveAudioQueueTrack[] = [];

  constructor(private api: ApiService) {
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('play', () => this.patch({ paused: false }));
    this.audio.addEventListener('pause', () => {
      if (!this.audio.ended) {
        this.patch({ paused: true });
      }
    });
    this.audio.addEventListener('timeupdate', () => {
      this.patch({
        currentTime: this.audio.currentTime || 0,
        duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0
      });
    });
    this.audio.addEventListener('loadedmetadata', () => {
      this.patch({
        duration: Number.isFinite(this.audio.duration) ? this.audio.duration : 0
      });
    });
  }

  get snapshot(): ArchiveAudioQueueState {
    return this.stateSubject.value;
  }

  get isActive(): boolean {
    return this.stateSubject.value.active;
  }

  get hasPrev(): boolean {
    const s = this.snapshot;
    if (!s.active) {
      return false;
    }
    return s.trackIndex > 0 || s.index > 0;
  }

  get hasNext(): boolean {
    const s = this.snapshot;
    if (!s.active) {
      return false;
    }
    if (s.trackIndex >= 0 && s.trackIndex < s.trackCount - 1) {
      return true;
    }
    return s.index >= 0 && s.index < s.queue.length - 1;
  }

  get hasPrevAlbum(): boolean {
    const s = this.snapshot;
    return s.active && s.index > 0;
  }

  get hasNextAlbum(): boolean {
    const s = this.snapshot;
    return s.active && s.index >= 0 && s.index < s.queue.length - 1;
  }

  /** Call synchronously from a click handler before start/playAt. */
  unlockFromUserGesture(): void {
    try {
      if (!this.gestureAudio) {
        this.gestureAudio = new Audio();
      }
      const a = this.gestureAudio;
      a.src =
        'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAAAAAA==';
      const p = a.play();
      if (p && typeof p.then === 'function') {
        void p
          .then(() => {
            a.pause();
            a.currentTime = 0;
          })
          .catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  start(queue: ArchiveItem[], index: number, source: ArchiveQueueSource): void {
    const list = (queue || []).filter((i) => !!i?.identifier);
    if (list.length === 0) {
      return;
    }
    const idx = Math.max(0, Math.min(index, list.length - 1));
    this.unlockFromUserGesture();
    this.itemTracks = [];
    this.patch({
      active: true,
      queue: list.map((i) => ({ ...i })),
      index: idx,
      source,
      pageAttached: true,
      paused: true,
      currentTime: 0,
      duration: 0,
      trackIndex: -1,
      trackCount: 0,
      trackName: ''
    });
    this.loadAndPlay(idx, 0);
  }

  playAt(index: number): void {
    const s = this.snapshot;
    if (!s.active || index < 0 || index >= s.queue.length) {
      return;
    }
    this.unlockFromUserGesture();
    this.loadAndPlay(index, 0);
  }

  prev(): void {
    const s = this.snapshot;
    if (!s.active || !this.hasPrev) {
      return;
    }
    this.unlockFromUserGesture();
    if (s.trackIndex > 0) {
      this.playTrack(s.trackIndex - 1);
      return;
    }
    // Previous Archive item — land on its last track once loaded.
    this.loadAndPlay(s.index - 1, -1);
  }

  next(): void {
    const s = this.snapshot;
    if (!s.active || !this.hasNext) {
      return;
    }
    this.unlockFromUserGesture();
    if (s.trackIndex >= 0 && s.trackIndex < s.trackCount - 1) {
      this.playTrack(s.trackIndex + 1);
      return;
    }
    this.loadAndPlay(s.index + 1, 0);
  }

  /** Jump to the previous Archive item (album), starting at its first track. */
  prevAlbum(): void {
    const s = this.snapshot;
    if (!s.active || !this.hasPrevAlbum) {
      return;
    }
    this.unlockFromUserGesture();
    this.loadAndPlay(s.index - 1, 0);
  }

  /** Jump to the next Archive item (album), starting at its first track. */
  nextAlbum(): void {
    const s = this.snapshot;
    if (!s.active || !this.hasNextAlbum) {
      return;
    }
    this.unlockFromUserGesture();
    this.loadAndPlay(s.index + 1, 0);
  }

  togglePause(): void {
    if (!this.snapshot.active) {
      return;
    }
    if (this.audio.paused) {
      this.unlockFromUserGesture();
      void this.audio.play()?.catch(() => undefined);
    } else {
      this.audio.pause();
    }
  }

  seekTo(seconds: number): void {
    if (!this.snapshot.active || !Number.isFinite(seconds)) {
      return;
    }
    try {
      this.audio.currentTime = Math.max(0, seconds);
      this.patch({ currentTime: this.audio.currentTime });
    } catch {
      /* ignore */
    }
  }

  setPageAttached(attached: boolean): void {
    if (this.snapshot.pageAttached === attached) {
      return;
    }
    this.patch({ pageAttached: attached });
  }

  /** Stop queue playback entirely (user left queue mode or closed floating player). */
  stop(): void {
    this.loadGeneration += 1;
    this.loadSub?.unsubscribe();
    this.loadSub = undefined;
    this.itemTracks = [];
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
    try {
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch {
      /* ignore */
    }
    this.stateSubject.next({ ...EMPTY_STATE });
  }

  private onEnded(): void {
    const s = this.snapshot;
    if (!s.active) {
      return;
    }
    if (s.trackIndex >= 0 && s.trackIndex < s.trackCount - 1) {
      this.playTrack(s.trackIndex + 1);
      return;
    }
    const next = s.index + 1;
    if (next < s.queue.length) {
      this.loadAndPlay(next, 0);
    } else {
      this.stop();
    }
  }

  /**
   * @param trackIndex 0-based track, or -1 to start at the last track after load.
   */
  private loadAndPlay(index: number, trackIndex: number): void {
    const s = this.snapshot;
    const item = s.queue[index];
    if (!item?.identifier) {
      return;
    }
    this.loadGeneration += 1;
    const gen = this.loadGeneration;
    this.loadSub?.unsubscribe();
    this.itemTracks = [];
    this.patch({
      index,
      current: { ...item },
      detail: null,
      loading: true,
      paused: true,
      currentTime: 0,
      duration: 0,
      trackIndex: -1,
      trackCount: 0,
      trackName: '',
      mediaUrl: ''
    });
    this.loadSub = this.api.getArchiveOrgItem(item.identifier).subscribe({
      next: (detail) => {
        if (gen !== this.loadGeneration) {
          return;
        }
        this.itemTracks = this.listAudioTracks(detail);
        if (this.itemTracks.length === 0) {
          this.skipToNextItem(index);
          return;
        }
        const last = this.itemTracks.length - 1;
        const ti = trackIndex < 0 ? last : Math.max(0, Math.min(trackIndex, last));
        this.patch({
          detail,
          loading: false,
          trackCount: this.itemTracks.length,
          current: {
            id: detail.id || detail.identifier,
            identifier: detail.identifier,
            title: detail.title || detail.identifier,
            subtitle: detail.subtitle,
            mediatype: detail.mediatype,
            imageUrl: detail.imageUrl,
            downloads: detail.downloads,
            avgRating: detail.avgRating,
            playable: detail.playable
          }
        });
        this.playTrack(ti);
      },
      error: () => {
        if (gen !== this.loadGeneration) {
          return;
        }
        this.skipToNextItem(index);
      }
    });
  }

  private playTrack(trackIndex: number): void {
    const track = this.itemTracks[trackIndex];
    if (!track?.url) {
      this.skipToNextItem(this.snapshot.index);
      return;
    }
    const mediaUrl = this.api.tvStreamProxyUrl(track.url);
    this.patch({
      trackIndex,
      trackCount: this.itemTracks.length,
      trackName: track.name,
      mediaUrl,
      currentTime: 0,
      duration: 0,
      loading: false,
      paused: true
    });
    try {
      this.audio.src = mediaUrl;
      this.audio.load();
    } catch {
      /* ignore */
    }
    void this.audio.play()?.catch(() => undefined);
  }

  private skipToNextItem(fromIndex: number): void {
    const next = fromIndex + 1;
    if (next < this.snapshot.queue.length) {
      this.loadAndPlay(next, 0);
    } else {
      this.stop();
    }
  }

  /**
   * Distinct playable audio tracks for an item.
   * Same song in MP3 + OGG (etc.) counts once; low-bitrate derivatives are skipped when a fuller file exists.
   */
  private listAudioTracks(detail: ArchiveItemDetail): ArchiveAudioQueueTrack[] {
    const files = detail.files || [];
    const byKind = files.filter(
      (f) => (f.kind || '').toLowerCase() === 'audio' && !!f.downloadUrl
    );
    const byExt = files.filter(
      (f) => !!f.downloadUrl && AUDIO_EXT_RE.test(f.name || f.downloadUrl || '')
    );
    const audioFiles = byKind.length > 0 ? byKind : byExt;
    if (audioFiles.length === 0) {
      if ((detail.playKind || '').toLowerCase() === 'audio' && detail.playUrl) {
        return [{ name: detail.title || detail.identifier || 'audio', url: detail.playUrl }];
      }
      return [];
    }

    const nameOf = (f: ArchiveFile) => f.name || f.downloadUrl || '';
    const preferred = new Map<string, ArchiveFile>();
    const order: string[] = [];

    for (const file of audioFiles) {
      const name = nameOf(file);
      const key = this.trackKey(name);
      if (!key) {
        continue;
      }
      const existing = preferred.get(key);
      if (!existing) {
        preferred.set(key, file);
        order.push(key);
        continue;
      }
      if (this.rankFile(file, name) > this.rankFile(existing, nameOf(existing))) {
        preferred.set(key, file);
      }
    }

    return order
      .map((key) => preferred.get(key)!)
      .filter((f) => !!f?.downloadUrl)
      .map((f) => ({ name: nameOf(f), url: f.downloadUrl! }));
  }

  private trackKey(name: string): string {
    const bare = (name || '').split(/[?#]/)[0];
    const base = bare.replace(/\.[^.\\/]+$/, '');
    return base.replace(LOW_BITRATE_RE, '').trim().toLowerCase();
  }

  private rankFile(file: ArchiveFile, name: string): number {
    const extMatch = name.match(/\.([a-z0-9]+)(\?|$)/i);
    const ext = (extMatch?.[1] || '').toLowerCase();
    let score = (FORMAT_RANK[ext] ?? -1) * 10;
    if (!LOW_BITRATE_RE.test(name)) {
      score += 5;
    }
    if ((file.format || '').toLowerCase().includes('vbr')) {
      score += 1;
    }
    return score;
  }

  private patch(partial: Partial<ArchiveAudioQueueState>): void {
    this.stateSubject.next({ ...this.stateSubject.value, ...partial });
  }
}
