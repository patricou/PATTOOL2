import {
  ChangeDetectorRef,
  Component,
  HostListener,
  OnDestroy,
  OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router, RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { YoutubeItem } from '../services/api.service';
import { YoutubeFloatingState, YoutubePlayerService } from '../services/youtube-player.service';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

@Component({
  selector: 'app-youtube-floating-player',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule],
  templateUrl: './youtube-floating-player.component.html',
  styleUrls: ['./youtube-floating-player.component.css']
})
export class YoutubeFloatingPlayerComponent implements OnInit, OnDestroy {
  state: YoutubeFloatingState = { open: false, minimized: false, item: null };
  embedUrl: SafeResourceUrl | null = null;

  posX = 24;
  posY = 24;
  widthPx = 420;
  heightPx = 300;

  private readonly minW = 280;
  private readonly minH = 160;
  private readonly maxW = 1400;
  private readonly maxH = 900;
  private readonly headerH = 40;

  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragging = false;
  private resizing: ResizeEdge | null = null;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartW = 0;
  private resizeStartH = 0;
  private resizeStartPosX = 0;
  private resizeStartPosY = 0;
  private positioned = false;
  private lastEmbedKey = '';
  private stateSub?: Subscription;

  constructor(
    private youtubePlayer: YoutubePlayerService,
    private sanitizer: DomSanitizer,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  get item(): YoutubeItem | null {
    return this.state.item;
  }

  ngOnInit(): void {
    this.placeDefaultPosition();
    this.stateSub = this.youtubePlayer.state$.subscribe((s) => {
      this.state = s;
      if (!s.open || !s.item) {
        this.embedUrl = null;
        this.lastEmbedKey = '';
        this.cdr.markForCheck();
        return;
      }
      const key = `${s.item.kind || 'video'}:${s.item.id}`;
      if (key !== this.lastEmbedKey) {
        this.lastEmbedKey = key;
        this.embedUrl = this.buildEmbedUrl(s.item);
      }
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.stateSub?.unsubscribe();
  }

  youtubeWatchUrl(): string | null {
    const item = this.item;
    if (!item?.id) {
      return null;
    }
    if (item.kind === 'playlist') {
      return `https://www.youtube.com/playlist?list=${encodeURIComponent(item.id)}`;
    }
    return `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`;
  }

  minimize(): void {
    this.youtubePlayer.minimize();
  }

  restore(): void {
    this.youtubePlayer.restore();
  }

  close(): void {
    this.youtubePlayer.close();
  }

  goToYoutubePage(): void {
    const item = this.item;
    void this.router.navigate(['/tools/youtube'], {
      queryParams: item?.id
        ? { id: item.id, type: item.kind === 'playlist' ? 'playlist' : null }
        : {}
    });
  }

  onDragStart(event: MouseEvent): void {
    if ((event.target as HTMLElement)?.closest('button, a, iframe, .yt-float-resize')) {
      return;
    }
    this.dragging = true;
    this.resizing = null;
    this.dragOffsetX = event.clientX - this.posX;
    this.dragOffsetY = event.clientY - this.posY;
    event.preventDefault();
  }

  onResizeStart(event: MouseEvent, edge: ResizeEdge): void {
    if (this.state.minimized) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dragging = false;
    this.resizing = edge;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartW = this.widthPx;
    this.resizeStartH = this.heightPx;
    this.resizeStartPosX = this.posX;
    this.resizeStartPosY = this.posY;
  }

  @HostListener('document:mousemove', ['$event'])
  onPointerMove(event: MouseEvent): void {
    if (this.resizing) {
      this.applyResize(event);
      return;
    }
    if (!this.dragging) {
      return;
    }
    const maxX = Math.max(0, window.innerWidth - Math.min(this.widthPx, 200));
    const maxY = Math.max(0, window.innerHeight - 48);
    this.posX = Math.min(maxX, Math.max(0, event.clientX - this.dragOffsetX));
    this.posY = Math.min(maxY, Math.max(0, event.clientY - this.dragOffsetY));
  }

  @HostListener('document:mouseup')
  onPointerUp(): void {
    this.dragging = false;
    this.resizing = null;
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.clampSizeAndPosition();
  }

  private applyResize(event: MouseEvent): void {
    if (!this.resizing) {
      return;
    }
    const dx = event.clientX - this.resizeStartX;
    const dy = event.clientY - this.resizeStartY;
    let nextW = this.resizeStartW;
    let nextH = this.resizeStartH;
    let nextX = this.resizeStartPosX;
    let nextY = this.resizeStartPosY;
    const edge = this.resizing;

    if (edge.includes('e')) {
      nextW = this.resizeStartW + dx;
    }
    if (edge.includes('w')) {
      nextW = this.resizeStartW - dx;
      nextX = this.resizeStartPosX + dx;
    }
    if (edge.includes('s')) {
      nextH = this.resizeStartH + dy;
    }
    if (edge.includes('n')) {
      nextH = this.resizeStartH - dy;
      nextY = this.resizeStartPosY + dy;
    }

    const maxW = Math.min(this.maxW, window.innerWidth - 8);
    const maxH = Math.min(this.maxH, window.innerHeight - 8);
    nextW = Math.min(maxW, Math.max(this.minW, nextW));
    nextH = Math.min(maxH, Math.max(this.minH + this.headerH, nextH));

    if (edge.includes('w')) {
      nextX = this.resizeStartPosX + (this.resizeStartW - nextW);
    }
    if (edge.includes('n')) {
      nextY = this.resizeStartPosY + (this.resizeStartH - nextH);
    }

    this.widthPx = Math.round(nextW);
    this.heightPx = Math.round(nextH);
    this.posX = Math.max(0, Math.min(window.innerWidth - this.minW, nextX));
    this.posY = Math.max(0, Math.min(window.innerHeight - this.headerH, nextY));
  }

  private placeDefaultPosition(): void {
    if (this.positioned || typeof window === 'undefined') {
      return;
    }
    this.widthPx = Math.min(420, window.innerWidth - 24);
    this.heightPx = Math.round(this.headerH + 8 + (this.widthPx - 16) * 9 / 16);
    this.posX = Math.max(12, window.innerWidth - this.widthPx - 24);
    this.posY = Math.max(12, window.innerHeight - this.heightPx - 88);
    this.positioned = true;
  }

  private clampSizeAndPosition(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.widthPx = Math.min(Math.min(this.maxW, window.innerWidth - 8), Math.max(this.minW, this.widthPx));
    this.heightPx = Math.min(
      Math.min(this.maxH, window.innerHeight - 8),
      Math.max(this.minH + this.headerH, this.heightPx)
    );
    this.posX = Math.min(Math.max(0, window.innerWidth - 200), Math.max(0, this.posX));
    this.posY = Math.min(Math.max(0, window.innerHeight - 48), Math.max(0, this.posY));
  }

  private buildEmbedUrl(item: YoutubeItem): SafeResourceUrl | null {
    const id = item.id || '';
    if (item.kind === 'playlist' && /^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0&autoplay=1`
      );
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1`
      );
    }
    return null;
  }
}
