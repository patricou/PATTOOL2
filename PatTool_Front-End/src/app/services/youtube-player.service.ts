import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

import { YoutubeItem } from './api.service';

export interface YoutubeFloatingState {
  open: boolean;
  minimized: boolean;
  item: YoutubeItem | null;
  /** Bumps on every open so the PiP iframe reloads even for the same video. */
  loadSeq: number;
  /** Resume offset in seconds when handing the page player to the float. */
  startSec: number;
}

export interface YoutubePlayerOpenOptions {
  /** Keep the PiP window minimized when it is already open. */
  keepMinimized?: boolean;
  /** Seconds into the video when opening the floating player. */
  startSec?: number;
}

export type YoutubePlayerCommand = 'play' | 'pause' | 'next' | 'previous';

@Injectable({ providedIn: 'root' })
export class YoutubePlayerService {
  private readonly stateSubject = new BehaviorSubject<YoutubeFloatingState>({
    open: false,
    minimized: false,
    item: null,
    loadSeq: 0,
    startSec: 0
  });
  private readonly endedSubject = new Subject<void>();
  private readonly unavailableSubject = new Subject<void>();
  private readonly commandSubject = new Subject<YoutubePlayerCommand>();
  private readonly pausedSubject = new BehaviorSubject<boolean>(false);
  private playbackSec = 0;

  readonly state$ = this.stateSubject.asObservable();
  readonly ended$ = this.endedSubject.asObservable();
  readonly unavailable$ = this.unavailableSubject.asObservable();
  readonly command$ = this.commandSubject.asObservable();
  readonly paused$ = this.pausedSubject.asObservable();

  get snapshot(): YoutubeFloatingState {
    return this.stateSubject.value;
  }

  get currentItem(): YoutubeItem | null {
    return this.stateSubject.value.item;
  }

  get paused(): boolean {
    return this.pausedSubject.value;
  }

  /** Latest position reported by the floating player, in seconds. */
  get playbackSeconds(): number {
    return this.playbackSec;
  }

  noteProgress(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) {
      this.playbackSec = seconds;
    }
  }

  sendCommand(command: YoutubePlayerCommand): void {
    this.commandSubject.next(command);
  }

  setPaused(paused: boolean): void {
    if (this.pausedSubject.value === paused) {
      return;
    }
    this.pausedSubject.next(paused);
  }

  open(item: YoutubeItem, options?: YoutubePlayerOpenOptions): void {
    if (!item?.id || item.kind === 'channel') {
      return;
    }
    const prev = this.stateSubject.value;
    this.setPaused(false);
    const startSec = Math.max(0, Math.floor(options?.startSec || 0));
    this.stateSubject.next({
      open: true,
      minimized: options?.keepMinimized && prev.open ? prev.minimized : false,
      item: { ...item },
      loadSeq: (prev.loadSeq || 0) + 1,
      startSec
    });
  }

  notifyEnded(): void {
    this.endedSubject.next();
  }

  notifyUnavailable(): void {
    this.unavailableSubject.next();
  }

  minimize(): void {
    if (!this.stateSubject.value.open) {
      return;
    }
    this.stateSubject.next({ ...this.stateSubject.value, minimized: true });
  }

  restore(): void {
    if (!this.stateSubject.value.open) {
      return;
    }
    this.stateSubject.next({ ...this.stateSubject.value, minimized: false });
  }

  close(): void {
    const prev = this.stateSubject.value;
    this.setPaused(false);
    this.playbackSec = 0;
    this.stateSubject.next({
      open: false,
      minimized: false,
      item: null,
      loadSeq: prev.loadSeq || 0,
      startSec: 0
    });
  }
}
