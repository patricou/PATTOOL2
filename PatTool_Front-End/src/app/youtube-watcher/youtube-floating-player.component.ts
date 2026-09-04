import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router, RouterModule } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { YoutubeItem } from '../services/api.service';
import { YoutubeFloatingState, YoutubePlayerService } from '../services/youtube-player.service';
import { openWhatsAppTextShare } from '../shared/share-whatsapp-image.util';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface DocumentPictureInPictureApi {
  window: Window | null;
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }): Promise<Window>;
}

@Component({
  selector: 'app-youtube-floating-player',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslateModule],
  templateUrl: './youtube-floating-player.component.html',
  styleUrls: ['./youtube-floating-player.component.css']
})
export class YoutubeFloatingPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('floatHome') floatHome?: ElementRef<HTMLElement>;
  @ViewChild('floatRoot') floatRoot?: ElementRef<HTMLElement>;

  state: YoutubeFloatingState = { open: false, minimized: false, item: null, loadSeq: 0 };
  embedUrl: SafeResourceUrl | null = null;
  osPipActive = false;

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
  private commandSub?: Subscription;
  private ytProgressTimer?: ReturnType<typeof setInterval>;
  private pipWindow: Window | null = null;
  private pipPageHideHandler?: () => void;
  private pipMessageHandler?: (event: MessageEvent) => void;
  private osPipEntering = false;
  private osPipTearingDown = false;

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
      const wasOpen = this.state.open;
      this.state = s;
      if (!s.open || !s.item) {
        this.stopYoutubeProgressWatch();
        this.teardownOsPip(false);
        this.embedUrl = null;
        this.lastEmbedKey = '';
        this.cdr.markForCheck();
        return;
      }
      const key = `${s.item.kind || 'video'}:${s.item.id}:${s.loadSeq || 0}`;
      if (key !== this.lastEmbedKey) {
        this.lastEmbedKey = key;
        this.embedUrl = this.buildEmbedUrl(s.item);
      }
      this.syncPipWindowTitle(s.item.title);
      this.cdr.markForCheck();
      if (!wasOpen) {
        this.cdr.detectChanges();
        void this.enterOsPip();
      }
    });
    this.commandSub = this.youtubePlayer.command$.subscribe((command) => {
      if (!this.state.open || !this.embedUrl) {
        return;
      }
      this.handshakeYoutubePlayer();
      this.sendYoutubeCommand(command === 'pause' ? 'pauseVideo' : 'playVideo');
    });
  }

  ngOnDestroy(): void {
    this.stateSub?.unsubscribe();
    this.commandSub?.unsubscribe();
    this.stopYoutubeProgressWatch();
    this.teardownOsPip(false);
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

  shareOnWhatsApp(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const item = this.item;
    const url = this.youtubeWatchUrl();
    if (!item || !url) {
      return;
    }
    const title = (item.title || '').trim();
    const channel = (item.channelTitle || '').trim();
    const lines = [title || url];
    if (channel) {
      lines.push(channel);
    }
    lines.push('', url);
    openWhatsAppTextShare(lines.join('\n'));
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

  /** Move the in-page overlay into an OS window that can leave the browser. */
  async enterOsPip(): Promise<void> {
    if (this.osPipEntering || this.isOsPipOpen() || !this.state.open) {
      return;
    }
    this.osPipEntering = true;
    try {
      const width = Math.max(360, Math.round(this.widthPx || 420));
      const height = Math.max(240, Math.round(this.heightPx || 300));
      let target: Window | null = null;
      const dpi = this.documentPipApi();
      if (dpi) {
        try {
          target = await dpi.requestWindow({
            width,
            height,
            disallowReturnToOpener: true
          });
        } catch {
          target = null;
        }
      }
      if (!target || target.closed) {
        target = this.openPopupWindow(width, height);
      }
      if (!target || target.closed) {
        return;
      }
      this.cdr.detectChanges();
      const el = this.floatRoot?.nativeElement;
      if (!el) {
        try {
          target.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.attachToOsWindow(target, el);
    } finally {
      this.osPipEntering = false;
      this.cdr.markForCheck();
    }
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
    if (this.osPipActive) {
      return;
    }
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
    if (this.osPipActive || this.state.minimized) {
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
    if (this.osPipActive) {
      return;
    }
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

  @HostListener('window:message', ['$event'])
  onWindowMessage(event: MessageEvent): void {
    this.onYoutubeMessage(event);
  }

  onPipEmbedLoad(): void {
    this.startYoutubeProgressWatch();
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

  private isOsPipOpen(): boolean {
    return !!(this.pipWindow && !this.pipWindow.closed);
  }

  private documentPipApi(): DocumentPictureInPictureApi | null {
    if (typeof window === 'undefined') {
      return null;
    }
    return (
      (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi })
        .documentPictureInPicture || null
    );
  }

  private openPopupWindow(width: number, height: number): Window | null {
    try {
      const popup = window.open(
        '',
        'pattool-youtube-pip',
        `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=no`
      );
      return popup && !popup.closed ? popup : null;
    } catch {
      return null;
    }
  }

  private attachToOsWindow(target: Window, el: HTMLElement): void {
    this.teardownOsPipListeners();
    this.copyStylesToWindow(target);
    target.document.documentElement.classList.add('yt-doc-pip-root');
    target.document.body.classList.add('yt-doc-pip-body');
    target.document.title = this.item?.title || 'YouTube';
    if (el.parentElement !== target.document.body) {
      target.document.body.appendChild(el);
    }
    el.classList.add('yt-float--doc-pip');
    this.pipWindow = target;
    this.osPipActive = true;
    this.pipPageHideHandler = () => this.onOsPipClosed();
    this.pipMessageHandler = (event: MessageEvent) => this.onYoutubeMessage(event);
    target.addEventListener('pagehide', this.pipPageHideHandler);
    target.addEventListener('message', this.pipMessageHandler);
    this.youtubePlayer.restore();
  }

  private onOsPipClosed(): void {
    if (this.osPipTearingDown || !this.state.open) {
      this.teardownOsPip(true);
      return;
    }
    this.teardownOsPip(true);
    this.youtubePlayer.close();
  }

  private teardownOsPip(fromPipClose: boolean): void {
    if (this.osPipTearingDown) {
      return;
    }
    this.osPipTearingDown = true;
    try {
      const el = this.floatRoot?.nativeElement;
      const home = this.floatHome?.nativeElement;
      const pip = this.pipWindow;
      this.teardownOsPipListeners();
      if (el) {
        el.classList.remove('yt-float--doc-pip');
        if (home && el.parentElement !== home) {
          home.appendChild(el);
        }
      }
      this.pipWindow = null;
      this.osPipActive = false;
      if (!fromPipClose && pip && !pip.closed) {
        try {
          pip.close();
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.osPipTearingDown = false;
    }
  }

  private teardownOsPipListeners(): void {
    const pip = this.pipWindow;
    if (pip && this.pipPageHideHandler) {
      try {
        pip.removeEventListener('pagehide', this.pipPageHideHandler);
      } catch {
        /* ignore */
      }
    }
    if (pip && this.pipMessageHandler) {
      try {
        pip.removeEventListener('message', this.pipMessageHandler);
      } catch {
        /* ignore */
      }
    }
    this.pipPageHideHandler = undefined;
    this.pipMessageHandler = undefined;
  }

  private syncPipWindowTitle(title: string | null | undefined): void {
    if (!this.pipWindow || this.pipWindow.closed) {
      return;
    }
    try {
      this.pipWindow.document.title = (title || '').trim() || 'YouTube';
    } catch {
      /* ignore */
    }
  }

  private copyStylesToWindow(target: Window): void {
    const doc = target.document;
    Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).forEach((node) => {
      try {
        doc.head.appendChild(node.cloneNode(true));
      } catch {
        /* ignore */
      }
    });
    const base = doc.createElement('style');
    base.textContent = `
      html.yt-doc-pip-root, body.yt-doc-pip-body {
        margin: 0; padding: 0; width: 100%; height: 100%;
        overflow: hidden; background: #111; color: #f1f1f1;
      }
      body.yt-doc-pip-body .yt-float--doc-pip {
        position: relative !important;
        left: auto !important;
        top: auto !important;
        width: 100% !important;
        height: 100% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
    `;
    doc.head.appendChild(base);
  }

  private buildEmbedUrl(item: YoutubeItem): SafeResourceUrl | null {
    const id = item.id || '';
    const origin =
      typeof window !== 'undefined'
        ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
        : '';
    const seq = `&cb=${this.state.loadSeq || 0}`;
    if (item.kind === 'playlist' && /^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0&autoplay=1&playsinline=1${origin}${seq}`
      );
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1&playsinline=1${origin}${seq}`
      );
    }
    return null;
  }

  private startYoutubeProgressWatch(): void {
    this.stopYoutubeProgressWatch();
    if (!this.state.open || !this.embedUrl) {
      return;
    }
    this.handshakeYoutubePlayer();
    this.ytProgressTimer = setInterval(() => this.handshakeYoutubePlayer(), 400);
  }

  private stopYoutubeProgressWatch(): void {
    if (this.ytProgressTimer !== undefined) {
      clearInterval(this.ytProgressTimer);
      this.ytProgressTimer = undefined;
    }
  }

  private handshakeYoutubePlayer(): void {
    this.postToYoutube({ event: 'listening', id: 'yt-pip-embed' });
    this.sendYoutubeCommand('addEventListener', ['onStateChange']);
  }

  private getYoutubeIframe(): HTMLIFrameElement | null {
    const pipDoc = this.pipWindow && !this.pipWindow.closed ? this.pipWindow.document : null;
    const fromPip = pipDoc?.querySelector('iframe.yt-pip-embed') as HTMLIFrameElement | null;
    if (fromPip) {
      return fromPip;
    }
    if (typeof document === 'undefined') {
      return null;
    }
    return document.querySelector('iframe.yt-pip-embed');
  }

  private postToYoutube(payload: object): void {
    const iframe = this.getYoutubeIframe();
    if (!iframe?.contentWindow) {
      return;
    }
    try {
      iframe.contentWindow.postMessage(JSON.stringify(payload), '*');
    } catch {
      /* ignore */
    }
  }

  private sendYoutubeCommand(func: string, args: unknown[] = []): void {
    this.postToYoutube({ event: 'command', func, args, id: 'yt-pip-embed' });
  }

  private onYoutubeMessage(event: MessageEvent): void {
    if (!this.state.open || !this.embedUrl) {
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
    const payload = data as {
      event?: string;
      info?: number | Record<string, unknown>;
    };
    let state: number | undefined;
    if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
      state = payload.info;
    } else if (payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info)) {
      const playerState = payload.info['playerState'];
      if (typeof playerState === 'number') {
        state = playerState;
      }
    }
    if (state === 1 || state === 3) {
      this.youtubePlayer.setPaused(false);
    } else if (state === 2) {
      this.youtubePlayer.setPaused(true);
    }
    if (state === 0) {
      this.youtubePlayer.setPaused(true);
      this.youtubePlayer.notifyEnded();
    }
  }
}
