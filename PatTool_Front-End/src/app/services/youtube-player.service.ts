import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

import { YoutubeItem } from './api.service';

export interface YoutubeFloatingState {
  open: boolean;
  minimized: boolean;
  item: YoutubeItem | null;
  /** Bumps on every open so the PiP iframe reloads even for the same video. */
  loadSeq: number;
}

export interface YoutubePlayerOpenOptions {
  /** Keep the PiP window minimized when it is already open. */
  keepMinimized?: boolean;
}

export type YoutubePlayerCommand = 'play' | 'pause';

@Injectable({ providedIn: 'root' })
export class YoutubePlayerService {
  private readonly stateSubject = new BehaviorSubject<YoutubeFloatingState>({
    open: false,
    minimized: false,
    item: null,
    loadSeq: 0
  });
  private readonly endedSubject = new Subject<void>();
  private readonly commandSubject = new Subject<YoutubePlayerCommand>();
  private readonly pausedSubject = new BehaviorSubject<boolean>(false);

  readonly state$ = this.stateSubject.asObservable();
  readonly ended$ = this.endedSubject.asObservable();
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
    this.stateSubject.next({
      open: true,
      minimized: options?.keepMinimized && prev.open ? prev.minimized : false,
      item: { ...item },
      loadSeq: (prev.loadSeq || 0) + 1
    });
  }

  notifyEnded(): void {
    this.endedSubject.next();
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
    this.stateSubject.next({
      open: false,
      minimized: false,
      item: null,
      loadSeq: prev.loadSeq || 0
    });
  }
}
