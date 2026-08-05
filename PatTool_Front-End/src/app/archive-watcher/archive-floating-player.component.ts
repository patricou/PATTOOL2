import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import {
  ArchiveAudioQueueService,
  ArchiveAudioQueueState
} from '../services/archive-audio-queue.service';

@Component({
  selector: 'app-archive-floating-player',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule],
  templateUrl: './archive-floating-player.component.html',
  styleUrls: ['./archive-floating-player.component.css']
})
export class ArchiveFloatingPlayerComponent implements OnInit, OnDestroy {
  state: ArchiveAudioQueueState = {
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

  private sub?: Subscription;

  constructor(
    private queue: ArchiveAudioQueueService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.sub = this.queue.state$.subscribe((s) => {
      this.state = s;
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** Visible only while queue plays and the archive page is not mounted. */
  get visible(): boolean {
    return this.state.active && !this.state.pageAttached;
  }

  get canPrev(): boolean {
    return this.queue.hasPrev;
  }

  get canNext(): boolean {
    return this.queue.hasNext;
  }

  get canPrevAlbum(): boolean {
    return this.queue.hasPrevAlbum;
  }

  get canNextAlbum(): boolean {
    return this.queue.hasNextAlbum;
  }

  get title(): string {
    return this.state.current?.title || this.state.detail?.title || '';
  }

  get cover(): string {
    return this.state.current?.imageUrl || this.state.detail?.imageUrl || '';
  }

  prev(): void {
    this.queue.prev();
  }

  next(): void {
    this.queue.next();
  }

  prevAlbum(): void {
    this.queue.prevAlbum();
  }

  nextAlbum(): void {
    this.queue.nextAlbum();
  }

  togglePause(): void {
    this.queue.togglePause();
  }

  close(): void {
    this.queue.stop();
  }

  openArchive(): void {
    void this.router.navigate(['/tools/archive-watcher']);
  }

  formatTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) {
      return '0:00';
    }
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }
}
