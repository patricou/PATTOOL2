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
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { ApiService, TvChannel } from '../services/api.service';
import { TvFloatingState, TvPlayerService } from '../services/tv-player.service';
import { isCanalGroupVirtual, isFranceTvVirtual, isM6GroupVirtual, isRadioFranceVirtual, isTf1Virtual, resolveTvStreamUrl } from '../tv-watcher/tv-stream.util';
import { formatTvPlayErrorDisplay } from './tv-stream-error.util';
import { startTvHlsPlayback, TvHlsPlaybackHandle } from './tv-hls-playback';
import { franceTvSlugFromVirtual } from './tv-francetv-refresh';
import { firstValueFrom } from 'rxjs';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

@Component({
  selector: 'app-tv-floating-player',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TranslateModule],
  templateUrl: './tv-floating-player.component.html',
  styleUrls: ['./tv-floating-player.component.css']
})
export class TvFloatingPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

  state: TvFloatingState = { open: false, minimized: false, channel: null };
  isMuted = false;
  volumePercent = 100;
  isBuffering = false;
  playError = '';
  isPipActive = false;
  isFullscreen = false;
  tokenRenewedToast = false;
  private franceTvTokenRefreshAttempted = false;
  private tokenRenewedToastTimer: ReturnType<typeof setTimeout> | null = null;
  pipSupported = TvPlayerService.supportsVideoPictureInPicture();

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

  private playback: TvHlsPlaybackHandle | null = null;
  private stateSub?: Subscription;
  private lastChannelId = '';
  /** Avoid closing pip-host when we briefly tear down the video to restart/handoff. */
  private suppressPipHostClose = false;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private playGeneration = 0;

  constructor(
    private tvPlayer: TvPlayerService,
    private api: ApiService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService
  ) {}

  formatPlayError(message: string | null | undefined): string {
    return formatTvPlayErrorDisplay(message, (key) => this.translate.instant(key));
  }

  ngOnInit(): void {
    this.placeDefaultPosition();
    this.stateSub = this.tvPlayer.state$.subscribe((s) => {
      const prevOpen = this.state.open;
      const channelChanged = (s.channel?.id || '') !== this.lastChannelId;
      this.state = s;
      this.cdr.markForCheck();
      if (!s.open) {
        this.clearPlayTimer();
        this.destroyPlayer();
        this.lastChannelId = '';
        return;
      }
      // Keep-alive host: OS PiP already plays on the persistent carrier — do not restart.
      if (s.pipHostOnly) {
        this.clearPlayTimer();
        this.lastChannelId = s.channel?.id || this.lastChannelId;
        this.isPipActive = this.tvPlayer.isOsPipActive();
        this.isBuffering = false;
        this.playError = '';
        // Never start a second HLS decoder for pip-host-only mode.
        if (!this.isPipActive) {
          this.tvPlayer.close({ resumeOnPage: false });
        }
        this.cdr.markForCheck();
        return;
      }
      if (s.channel && (channelChanged || !prevOpen)) {
        this.lastChannelId = s.channel.id || '';
        this.franceTvTokenRefreshAttempted = false;
        this.clearPlayTimer();
        const gen = ++this.playGeneration;
        this.playTimer = setTimeout(() => {
          this.playTimer = null;
          if (gen === this.playGeneration && this.state.open && this.state.channel?.id === s.channel!.id) {
            this.playChannel(s.channel!);
          }
        }, 0);
      }
    });
  }

  ngOnDestroy(): void {
    this.clearPlayTimer();
    this.stateSub?.unsubscribe();
    this.destroyPlayer();
  }

  private clearPlayTimer(): void {
    if (this.playTimer != null) {
      clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.playGeneration++;
  }

  get channel(): TvChannel | null {
    return this.state.channel;
  }

  usesFranceTv(): boolean {
    return isFranceTvVirtual(resolveTvStreamUrl(this.channel));
  }

  usesTf1(): boolean {
    return isTf1Virtual(resolveTvStreamUrl(this.channel));
  }

  usesCanalGroup(): boolean {
    return isCanalGroupVirtual(resolveTvStreamUrl(this.channel));
  }

  usesRadioFrance(): boolean {
    return isRadioFranceVirtual(resolveTvStreamUrl(this.channel));
  }

  usesM6Group(): boolean {
    return isM6GroupVirtual(resolveTvStreamUrl(this.channel));
  }

  close(): void {
    this.tvPlayer.close();
  }

  minimize(): void {
    this.tvPlayer.minimize();
  }

  restore(): void {
    this.tvPlayer.restore();
  }

  toggleMute(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    if (video.muted || this.isMuted || this.volumePercent <= 0) {
      this.ensureSound();
      return;
    }
    video.muted = true;
    this.isMuted = true;
    this.cdr.markForCheck();
  }

  onVideoVolumeChange(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    this.isMuted = !!video.muted || video.volume === 0;
    if (!video.muted && video.volume > 0) {
      this.volumePercent = Math.round(video.volume * 100);
    }
    this.cdr.markForCheck();
  }

  ensureSound(event?: Event): void {
    event?.stopPropagation();
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    if (!video.muted && video.volume > 0 && !this.isMuted && this.volumePercent > 0) {
      return;
    }
    this.volumePercent = this.volumePercent > 0 ? this.volumePercent : 100;
    video.volume = Math.min(1, Math.max(0, this.volumePercent / 100));
    video.muted = false;
    this.isMuted = false;
    video.play().catch(() => undefined);
    this.cdr.markForCheck();
  }

  setVolumePercent(value: number | string): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
    this.volumePercent = pct;
    video.volume = pct / 100;
    if (pct > 0) {
      video.muted = false;
      this.isMuted = false;
    } else {
      video.muted = true;
      this.isMuted = true;
    }
    this.cdr.markForCheck();
  }

  goToTvPage(): void {
    this.router.navigate(['/tools/tv-watcher']);
  }

  /** Native OS Picture-in-Picture — video floats outside the browser. */
  async togglePictureInPicture(): Promise<void> {
    const video = this.videoEl?.nativeElement;
    if (!video || !this.pipSupported) {
      return;
    }
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        if (this.state.minimized) {
          this.restore();
          await new Promise((r) => setTimeout(r, 50));
        }
        if (video.readyState < 1) {
          await video.play().catch(() => undefined);
        }
        await video.requestPictureInPicture();
      }
    } catch {
      this.playError = 'TV.ERR_PIP';
      this.cdr.markForCheck();
    }
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (this.state.minimized) {
        this.restore();
        await new Promise((r) => setTimeout(r, 40));
      }
      const root = document.querySelector('.tv-float') as HTMLElement | null;
      const video = this.videoEl?.nativeElement;
      const target = root || video;
      if (!target?.requestFullscreen) {
        this.playError = 'TV.ERR_FULLSCREEN';
        this.cdr.markForCheck();
        return;
      }
      await target.requestFullscreen();
    } catch {
      this.playError = 'TV.ERR_FULLSCREEN';
      this.cdr.markForCheck();
    }
  }

  /** Separate OS window (can sit on another monitor / over other apps). */
  openExternalWindow(): void {
    if (!this.channel) {
      return;
    }
    this.tvPlayer.openExternalWindow(this.channel);
  }

  onDragStart(event: MouseEvent): void {
    if ((event.target as HTMLElement)?.closest('button, a, video, .tv-float-resize')) {
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

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.isFullscreen = !!document.fullscreenElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    this.isPipActive =
      this.tvPlayer.isOsPipActive() ||
      document.pictureInPictureElement === this.videoEl?.nativeElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture')
  onLeavePip(): void {
    // Persistent carrier leave is handled by TvPlayerService (closes pipHostOnly).
    if (this.state.pipHostOnly) {
      this.isPipActive = false;
      this.cdr.markForCheck();
      return;
    }
    this.isPipActive = false;
    if (this.suppressPipHostClose) {
      this.cdr.markForCheck();
      return;
    }
    const video = this.videoEl?.nativeElement;
    if (video && this.state.open) {
      video.play().catch(() => undefined);
    }
    this.cdr.markForCheck();
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
    this.heightPx = Math.round(this.headerH + 16 + (this.widthPx - 20) * 9 / 16 + 28);
    this.posX = Math.max(12, window.innerWidth - this.widthPx - 24);
    this.posY = Math.max(12, window.innerHeight - this.heightPx - 24);
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

  private playChannel(channel: TvChannel): void {
    if (!this.state.open || this.state.pipHostOnly) {
      return;
    }
    const video = this.videoEl?.nativeElement;
    if (!video || !channel) {
      return;
    }
    this.suppressPipHostClose = true;
    this.destroyPlayer();
    this.playError = '';
    this.isBuffering = true;
    const streamUrl = resolveTvStreamUrl(channel);
    const proxyUrl = this.api.tvStreamProxyUrl(streamUrl);
    const franceSlug = franceTvSlugFromVirtual(streamUrl);
    this.playback = startTvHlsPlayback(video, proxyUrl, {
      onBuffering: (v) => {
        this.isBuffering = v;
        this.cdr.markForCheck();
      },
      onError: (key) => {
        this.playError = key;
        this.cdr.markForCheck();
      },
      onMutedChange: (m) => {
        this.isMuted = m;
        this.cdr.markForCheck();
      },
      onTokenExpired: () => {
        if (this.franceTvTokenRefreshAttempted || !isFranceTvVirtual(streamUrl)) {
          return false;
        }
        this.franceTvTokenRefreshAttempted = true;
        this.isBuffering = true;
        this.cdr.markForCheck();
        // Defer so destroy() from the error path finishes first.
        setTimeout(() => this.playChannel(channel), 0);
        return true;
      },
      franceTv: franceSlug
        ? {
            slug: franceSlug,
            resolveMeta: async (fresh) => {
              try {
                return await firstValueFrom(this.api.resolveFranceTvLive(franceSlug, fresh));
              } catch {
                return null;
              }
            },
            onRenewed: () => this.showTokenRenewedToast()
          }
        : undefined
    });
    video.volume = Math.min(1, Math.max(0, this.volumePercent / 100));
    this.suppressPipHostClose = false;
  }

  private showTokenRenewedToast(): void {
    this.tokenRenewedToast = true;
    if (this.tokenRenewedToastTimer != null) {
      clearTimeout(this.tokenRenewedToastTimer);
    }
    this.tokenRenewedToastTimer = setTimeout(() => {
      this.tokenRenewedToast = false;
      this.tokenRenewedToastTimer = null;
      this.cdr.markForCheck();
    }, 1000);
    this.cdr.markForCheck();
  }

  private destroyPlayer(): void {
    if (this.tokenRenewedToastTimer != null) {
      clearTimeout(this.tokenRenewedToastTimer);
      this.tokenRenewedToastTimer = null;
    }
    this.tokenRenewedToast = false;
    if (document.pictureInPictureElement === this.videoEl?.nativeElement) {
      document.exitPictureInPicture().catch(() => undefined);
    }
    this.playback?.destroy();
    this.playback = null;
    this.isPipActive = false;
  }
}
