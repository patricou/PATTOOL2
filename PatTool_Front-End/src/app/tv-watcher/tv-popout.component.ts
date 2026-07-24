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
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import { ApiService, TvChannel } from '../services/api.service';
import { TvPlayerService } from '../services/tv-player.service';
import {
  isCanalGroupVirtual,
  isFranceTvVirtual,
  isM6GroupVirtual,
  isRadioFranceVirtual,
  isTf1Virtual,
  resolveTvStreamUrl
} from './tv-stream.util';
import { formatTvPlayErrorDisplay } from './tv-stream-error.util';
import { startTvHlsPlayback, TvHlsPlaybackHandle } from './tv-hls-playback';
import { franceTvSlugFromVirtual } from './tv-francetv-refresh';
import { firstValueFrom } from 'rxjs';

/** Minimal typing for the Document Picture-in-Picture API (Chromium). */
interface DocumentPictureInPicture {
  window: Window | null;
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }): Promise<Window>;
}

@Component({
  selector: 'app-tv-popout',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './tv-popout.component.html',
  styleUrls: ['./tv-popout.component.css']
})
export class TvPopoutComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('stageEl') stageEl?: ElementRef<HTMLElement>;
  @ViewChild('stageSlot') stageSlot?: ElementRef<HTMLElement>;

  channel: TvChannel | null = null;
  isMuted = false;
  isBuffering = false;
  playError = '';
  isPipActive = false;
  isFullscreen = false;
  isOverlayActive = false;
  pipSupported = TvPlayerService.supportsVideoPictureInPicture();

  private playback: TvHlsPlaybackHandle | null = null;
  private lastChannelId = '';
  private franceTvTokenRefreshAttempted = false;
  tokenRenewedToast = false;
  private tokenRenewedToastTimer: ReturnType<typeof setTimeout> | null = null;
  private storageListener?: (ev: StorageEvent) => void;
  private overlayPipWindow: Window | null = null;
  private overlayPageHideHandler?: () => void;

  constructor(
    private api: ApiService,
    private tvPlayer: TvPlayerService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    private host: ElementRef<HTMLElement>
  ) {}

  static supportsDocumentPictureInPicture(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    return 'documentPictureInPicture' in window;
  }

  private get documentPip(): DocumentPictureInPicture | null {
    const dpi = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture })
      .documentPictureInPicture;
    return dpi || null;
  }

  formatPlayError(message: string | null | undefined): string {
    return formatTvPlayErrorDisplay(message, (key) => this.translate.instant(key));
  }

  ngOnInit(): void {
    document.title = 'PatTool TV';
    this.applyChannelFromStorage();
    this.storageListener = (ev: StorageEvent) => {
      if (ev.key === TvPlayerService.POPOUT_STORAGE_KEY && ev.newValue) {
        this.applyChannelFromStorage();
      }
    };
    window.addEventListener('storage', this.storageListener);
  }

  ngOnDestroy(): void {
    if (this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
    }
    this.teardownOverlayWindow(false);
    this.destroyPlayer();
  }

  get channelName(): string {
    return this.channel?.name || 'TV';
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

  toggleMute(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    video.muted = !video.muted;
    this.isMuted = video.muted;
    this.cdr.markForCheck();
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      const target =
        this.host.nativeElement.querySelector('.tv-popout') || this.host.nativeElement;
      if (target && 'requestFullscreen' in target) {
        await (target as HTMLElement).requestFullscreen();
      } else {
        this.playError = 'TV.ERR_FULLSCREEN';
        this.cdr.markForCheck();
      }
    } catch {
      this.playError = 'TV.ERR_FULLSCREEN';
      this.cdr.markForCheck();
    }
  }

  /**
   * Floating always-on-top player without browser chrome (Document Picture-in-Picture).
   * Falls back to video PiP when the Document PiP API is unavailable.
   */
  async toggleOverlayWindow(): Promise<void> {
    const dpi = this.documentPip;
    if (!dpi) {
      if (this.pipSupported) {
        await this.togglePictureInPicture();
        return;
      }
      this.playError = 'TV.POPOUT_OVERLAY_UNSUPPORTED';
      this.cdr.markForCheck();
      return;
    }

    if (this.overlayPipWindow && !this.overlayPipWindow.closed) {
      this.overlayPipWindow.close();
      return;
    }

    const stage = this.stageEl?.nativeElement;
    const slot = this.stageSlot?.nativeElement;
    const video = this.videoEl?.nativeElement;
    if (!stage || !slot) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      }
      const width = Math.max(480, Math.round(stage.clientWidth || 960));
      const height = Math.max(270, Math.round(stage.clientHeight || 540));
      const pipWindow = await dpi.requestWindow({
        width,
        height,
        disallowReturnToOpener: true
      });
      this.copyStylesToWindow(pipWindow);
      pipWindow.document.documentElement.classList.add('tv-popout-overlay-root');
      pipWindow.document.body.classList.add('tv-popout-overlay-body');
      pipWindow.document.title = '';
      pipWindow.document.body.appendChild(stage);
      this.installOverlayControls(pipWindow);
      if (video) {
        video.play().catch(() => undefined);
      }

      this.overlayPipWindow = pipWindow;
      this.isOverlayActive = true;
      this.overlayPageHideHandler = () => this.teardownOverlayWindow(true);
      pipWindow.addEventListener('pagehide', this.overlayPageHideHandler);
      this.cdr.markForCheck();
    } catch {
      this.playError = 'TV.ERR_OVERLAY';
      this.cdr.markForCheck();
    }
  }

  private installOverlayControls(pipWindow: Window): void {
    const doc = pipWindow.document;
    const bar = doc.createElement('div');
    bar.className = 'tv-popout-overlay-bar';
    const fsBtn = doc.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tv-popout-overlay-fs';
    fsBtn.title = this.translate.instant('TV.POPOUT_FULLSCREEN');
    fsBtn.setAttribute('aria-label', fsBtn.title);
    fsBtn.innerHTML = '<i class="fa fa-arrows-alt" aria-hidden="true"></i>';
    fsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // Fullscreen is blocked inside Document PiP — expand in this popout window instead.
      void this.exitOverlayAndFullscreen();
    });
    bar.appendChild(fsBtn);
    doc.body.appendChild(bar);
  }

  /**
   * Move the stage back into the popout, request fullscreen there (user activation from
   * the PiP click still propagates), then close the Document PiP overlay.
   */
  private async exitOverlayAndFullscreen(): Promise<void> {
    const stage = this.stageEl?.nativeElement;
    const slot = this.stageSlot?.nativeElement;
    const pip = this.overlayPipWindow;
    if (!stage) {
      return;
    }

    if (slot && stage.parentElement !== slot) {
      slot.appendChild(stage);
    }

    const target =
      this.host.nativeElement.querySelector('.tv-popout') || this.host.nativeElement;

    try {
      window.focus();
    } catch {
      /* ignore */
    }

    let fsReq: Promise<void> = Promise.resolve();
    try {
      if (target && 'requestFullscreen' in target) {
        fsReq = (target as HTMLElement).requestFullscreen();
      }
    } catch (err) {
      fsReq = Promise.reject(err);
    }

    if (pip && this.overlayPageHideHandler) {
      pip.removeEventListener('pagehide', this.overlayPageHideHandler);
    }
    this.overlayPageHideHandler = undefined;
    this.overlayPipWindow = null;
    this.isOverlayActive = false;
    try {
      if (pip && !pip.closed) {
        pip.close();
      }
    } catch {
      /* ignore */
    }

    try {
      await fsReq;
    } catch {
      this.playError = 'TV.ERR_FULLSCREEN';
    }
    this.cdr.markForCheck();
  }

  async togglePictureInPicture(): Promise<void> {
    const video = this.videoEl?.nativeElement;
    if (!video || !this.pipSupported) {
      return;
    }
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
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

  closeWindow(): void {
    this.teardownOverlayWindow(false);
    this.destroyPlayer();
    window.close();
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.isFullscreen = !!document.fullscreenElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    this.isPipActive = true;
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture')
  onLeavePip(): void {
    this.isPipActive = false;
    const video = this.videoEl?.nativeElement;
    if (video) {
      video.play().catch(() => undefined);
    }
    this.cdr.markForCheck();
  }

  private teardownOverlayWindow(fromPipClose: boolean): void {
    const stage = this.stageEl?.nativeElement;
    const slot = this.stageSlot?.nativeElement;
    const pip = this.overlayPipWindow;
    if (pip && this.overlayPageHideHandler) {
      pip.removeEventListener('pagehide', this.overlayPageHideHandler);
    }
    this.overlayPageHideHandler = undefined;
    this.overlayPipWindow = null;
    this.isOverlayActive = false;

    if (stage && slot && stage.parentElement !== slot) {
      slot.appendChild(stage);
    }
    const video = this.videoEl?.nativeElement;
    if (video && fromPipClose) {
      video.play().catch(() => undefined);
    }
    if (!fromPipClose && pip && !pip.closed) {
      try {
        pip.close();
      } catch {
        /* ignore */
      }
    }
    this.cdr.markForCheck();
  }

  private copyStylesToWindow(target: Window): void {
    const doc = target.document;
    Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).forEach((node) => {
      doc.head.appendChild(node.cloneNode(true));
    });
    const base = doc.createElement('style');
    base.textContent = `
      html.tv-popout-overlay-root, body.tv-popout-overlay-body {
        margin: 0; padding: 0; width: 100%; height: 100%;
        overflow: hidden; background: #000; color: #f2f4f7;
      }
      body.tv-popout-overlay-body .tv-popout-stage {
        width: 100vw; height: 100vh; min-height: 100%;
      }
      body.tv-popout-overlay-body .tv-popout-overlay-bar {
        position: fixed; top: 0.5rem; right: 0.5rem; z-index: 20;
        display: flex; gap: 0.35rem;
      }
      body.tv-popout-overlay-body .tv-popout-overlay-fs {
        width: 2.25rem; height: 2.25rem; border: 0; border-radius: 0.4rem;
        background: rgba(0,0,0,0.55); color: #fff; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        box-shadow: none;
      }
      body.tv-popout-overlay-body .tv-popout-overlay-fs:hover {
        background: rgba(0,0,0,0.8);
      }
      body.tv-popout-overlay-body:fullscreen .tv-popout-overlay-bar,
      body.tv-popout-overlay-body:-webkit-full-screen .tv-popout-overlay-bar {
        opacity: 0.35;
      }
      body.tv-popout-overlay-body:fullscreen:hover .tv-popout-overlay-bar,
      body.tv-popout-overlay-body:-webkit-full-screen:hover .tv-popout-overlay-bar {
        opacity: 1;
      }
    `;
    doc.head.appendChild(base);
  }

  private applyChannelFromStorage(): void {
    const payload = this.tvPlayer.readPopoutPayload();
    const channel = payload?.channel || null;
    if (!channel) {
      this.playError = 'TV.POPOUT_NO_CHANNEL';
      this.cdr.markForCheck();
      return;
    }
    const id = channel.id || resolveTvStreamUrl(channel);
    if (id === this.lastChannelId && this.playback) {
      return;
    }
    this.channel = channel;
    this.lastChannelId = id;
    this.franceTvTokenRefreshAttempted = false;
    document.title = `${channel.name || 'TV'} — PatTool`;
    this.cdr.markForCheck();
    setTimeout(() => this.playChannel(channel), 0);
  }

  private playChannel(channel: TvChannel): void {
    const video = this.videoEl?.nativeElement;
    if (!video || !channel) {
      return;
    }
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
    this.playback?.destroy();
    this.playback = null;
  }
}
