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
import { isCanalGroupVirtual, isFranceTvVirtual, isM6GroupVirtual, isRadioFranceVirtual, isTf1Virtual, resolveTvStreamUrl } from './tv-stream.util';
import { isTvI18nErrorKey } from './tv-stream-error.util';
import { startTvHlsPlayback, TvHlsPlaybackHandle } from './tv-hls-playback';

@Component({
  selector: 'app-tv-popout',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './tv-popout.component.html',
  styleUrls: ['./tv-popout.component.css']
})
export class TvPopoutComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

  channel: TvChannel | null = null;
  isMuted = false;
  isBuffering = false;
  playError = '';
  isPipActive = false;
  pipSupported = TvPlayerService.supportsVideoPictureInPicture();

  private playback: TvHlsPlaybackHandle | null = null;
  private lastChannelId = '';
  private storageListener?: (ev: StorageEvent) => void;

  constructor(
    private api: ApiService,
    private tvPlayer: TvPlayerService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService
  ) {}

  formatPlayError(message: string | null | undefined): string {
    const m = (message || '').trim();
    if (!m) {
      return '';
    }
    return isTvI18nErrorKey(m) ? this.translate.instant(m) : m;
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
    this.destroyPlayer();
    window.close();
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
    const proxyUrl = this.api.tvStreamProxyUrl(resolveTvStreamUrl(channel));
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
      }
    });
  }

  private destroyPlayer(): void {
    this.playback?.destroy();
    this.playback = null;
  }
}
