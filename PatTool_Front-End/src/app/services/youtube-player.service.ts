import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { YoutubeItem } from './api.service';

export interface YoutubeFloatingState {
  open: boolean;
  minimized: boolean;
  item: YoutubeItem | null;
}

@Injectable({ providedIn: 'root' })
export class YoutubePlayerService {
  private readonly stateSubject = new BehaviorSubject<YoutubeFloatingState>({
    open: false,
    minimized: false,
    item: null
  });

  readonly state$ = this.stateSubject.asObservable();

  get snapshot(): YoutubeFloatingState {
    return this.stateSubject.value;
  }

  get currentItem(): YoutubeItem | null {
    return this.stateSubject.value.item;
  }

  open(item: YoutubeItem): void {
    if (!item?.id || item.kind === 'channel') {
      return;
    }
    this.stateSubject.next({
      open: true,
      minimized: false,
      item: { ...item }
    });
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
    this.stateSubject.next({ open: false, minimized: false, item: null });
  }
}
