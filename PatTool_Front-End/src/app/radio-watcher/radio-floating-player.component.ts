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
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import Hls from 'hls.js';

import { ApiService, RadioStation } from '../services/api.service';
import { RadioFloatingState, RadioPlayerService } from '../services/radio-player.service';
import { createTvHlsConfig, tryRecoverTvHlsError } from '../tv-watcher/tv-hls-config';
import {
  applyRadioMediaSession,
  closeRadioDocPip,
  enterRadioPictureInPicture,
  isRadioDocPipOpen,
  stopRadioPipCarrier,
  supportsRadioDocumentPip,
  supportsRadioPictureInPicture
} from './radio-pip.util';

@Component({
  selector: 'app-radio-floating-player',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TranslateModule],
  templateUrl: './radio-floating-player.component.html',
  styleUrls: ['./radio-watcher.component.css', './radio-floating-player.component.css']
})
export class RadioFloatingPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('mediaEl') mediaEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;

  state: RadioFloatingState = { open: false, minimized: false, station: null };
  isMuted = false;
  volumePercent = 100;
  isBuffering = false;
  playError = '';
  isPipActive = false;
  pipSupported = supportsRadioPictureInPicture();
  favorites: RadioStation[] = [];

  readonly dialTicks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  readonly tubeSlots = [1, 2, 3];
  readonly eqBars = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  readonly speakerRings = [1, 2, 3, 4, 5, 6];

  posX = 24;
  posY = 24;
  widthPx = 560;

  private readonly headerH = 40;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragging = false;
  private positioned = false;

  private hls: Hls | null = null;
  private stateSub?: Subscription;
  private favoritesSub?: Subscription;
  private lastStationId = '';
  private playGeneration = 0;
  private suppressPipHostClose = false;
  private static readonly PRESET_COUNT = 12;

  constructor(
    private radioPlayer: RadioPlayerService,
    private api: ApiService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService
  ) {}

  formatPlayError(message: string | null | undefined): string {
    const m = (message || '').trim();
    if (!m) {
      return '';
    }
    return m.startsWith('RADIO.') ? this.translate.instant(m) : m;
  }

  ngOnInit(): void {
    this.placeDefaultPosition();
    this.favorites = this.radioPlayer.favorites;
    this.loadFavorites();
    this.stateSub = this.radioPlayer.state$.subscribe((s) => {
      const prevOpen = this.state.open;
      const stationChanged = (s.station?.id || '') !== this.lastStationId;
      this.state = s;
      if (this.radioPlayer.favorites.length) {
        this.favorites = this.radioPlayer.favorites;
      }
      this.cdr.markForCheck();
      if (!s.open) {
        this.destroyPlayer();
        this.lastStationId = '';
        return;
      }
      if (s.station && (stationChanged || !prevOpen)) {
        this.lastStationId = s.station.id || '';
        // Force view creation so #playerPanel / #mediaEl exist before PiP (keeps user gesture).
        this.cdr.detectChanges();
        void this.playStation(s.station);
      }
    });
  }

  ngOnDestroy(): void {
    this.stateSub?.unsubscribe();
    this.favoritesSub?.unsubscribe();
    this.destroyPlayer();
  }

  get station(): RadioStation | null {
    return this.state.station;
  }

  get presetSlots(): (RadioStation | null)[] {
    const slots: (RadioStation | null)[] = [];
    for (let i = 0; i < RadioFloatingPlayerComponent.PRESET_COUNT; i++) {
      slots.push(this.favorites[i] || null);
    }
    return slots;
  }

  close(): void {
    this.radioPlayer.close();
  }

  minimize(): void {
    this.radioPlayer.minimize();
  }

  restore(): void {
    this.radioPlayer.restore();
  }

  stationLogo(station: RadioStation | null | undefined): string | null {
    const logo = (station?.logo || '').trim();
    if (!logo || logo === 'null' || logo === 'undefined') {
      return null;
    }
    if (!(logo.startsWith('http://') || logo.startsWith('https://'))) {
      return null;
    }
    return logo;
  }

  countryLabel(code?: string | null): string {
    const c = (code || '').trim();
    return c ? c.toUpperCase() : '';
  }

  formatBitrate(station: RadioStation | null): string {
    if (!station?.bitrate || station.bitrate <= 0) {
      return '';
    }
    return `${station.bitrate} kbps`;
  }

  shortPresetName(station: RadioStation): string {
    const name = (station?.name || '').trim();
    if (!name) {
      return '—';
    }
    if (name.length <= 7) {
      return name;
    }
    return `${name.slice(0, 6)}…`;
  }

  presetTitle(station: RadioStation | null, index: number): string {
    const n = index + 1;
    if (station?.name) {
      return this.translate.instant('RADIO.PRESET_PLAY', { n, name: station.name });
    }
    return this.translate.instant('RADIO.PRESET_EMPTY', { n });
  }

  playPreset(station: RadioStation | null, event?: Event): void {
    event?.stopPropagation();
    if (!station) {
      return;
    }
    this.radioPlayer.setStation(station);
  }

  async togglePictureInPicture(): Promise<void> {
    const media = this.mediaEl?.nativeElement;
    if (!media || !this.pipSupported || !this.station) {
      return;
    }
    try {
      if (isRadioDocPipOpen()) {
        closeRadioDocPip();
        this.isPipActive = false;
        this.cdr.markForCheck();
        return;
      }
      const carrier = document.getElementById('pattool-radio-pip-carrier');
      if (
        document.pictureInPictureElement === media ||
        document.pictureInPictureElement === carrier
      ) {
        await document.exitPictureInPicture();
        stopRadioPipCarrier();
        this.isPipActive = false;
        this.cdr.markForCheck();
        return;
      }
      if (this.state.minimized && !this.state.pipHostOnly) {
        this.restore();
        await new Promise((r) => setTimeout(r, 50));
      }
      await this.openDocPip(media);
      this.isPipActive = true;
      this.cdr.markForCheck();
    } catch {
      this.playError = 'RADIO.ERR_PIP';
      this.cdr.markForCheck();
    }
  }

  toggleMute(): void {
    const media = this.mediaEl?.nativeElement;
    if (!media) {
      return;
    }
    if (media.muted || this.isMuted || this.volumePercent <= 0) {
      media.muted = false;
      this.isMuted = false;
      if (this.volumePercent <= 0) {
        this.volumePercent = 60;
        media.volume = 0.6;
      }
    } else {
      media.muted = true;
      this.isMuted = true;
    }
    this.cdr.markForCheck();
  }

  onVolumeSlider(percent: number): void {
    const media = this.mediaEl?.nativeElement;
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    this.volumePercent = p;
    if (media) {
      media.volume = p / 100;
      media.muted = p === 0;
      this.isMuted = media.muted;
    }
  }

  onMediaVolumeChange(): void {
    const media = this.mediaEl?.nativeElement;
    if (!media) {
      return;
    }
    this.isMuted = !!media.muted;
    this.volumePercent = Math.round((media.muted ? 0 : media.volume) * 100);
    this.cdr.markForCheck();
  }

  startDrag(event: MouseEvent): void {
    if (event.button !== 0 || this.state.minimized || this.state.pipHostOnly) {
      return;
    }
    this.dragging = true;
    this.dragOffsetX = event.clientX - this.posX;
    this.dragOffsetY = event.clientY - this.posY;
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.dragging) {
      return;
    }
    this.posX = Math.max(0, event.clientX - this.dragOffsetX);
    this.posY = Math.max(0, event.clientY - this.dragOffsetY);
    this.clampToViewport();
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    this.dragging = false;
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    const pip = document.pictureInPictureElement;
    this.isPipActive =
      isRadioDocPipOpen() ||
      pip === this.mediaEl?.nativeElement ||
      pip === document.getElementById('pattool-radio-pip-carrier');
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture')
  onLeavePip(): void {
    this.isPipActive = isRadioDocPipOpen();
    if (this.suppressPipHostClose || isRadioDocPipOpen()) {
      this.cdr.markForCheck();
      return;
    }
    if (this.state.pipHostOnly && this.state.open) {
      this.radioPlayer.close({ resumeOnPage: true });
      stopRadioPipCarrier();
      this.cdr.markForCheck();
      return;
    }
    stopRadioPipCarrier();
    const media = this.mediaEl?.nativeElement;
    if (media && this.state.open) {
      media.muted = false;
      media.play().catch(() => undefined);
    }
    this.cdr.markForCheck();
  }

  private loadFavorites(): void {
    this.favoritesSub?.unsubscribe();
    this.favoritesSub = this.api
      .getRadioFavorites()
      .pipe(catchError(() => of({ stations: this.radioPlayer.favorites })))
      .subscribe((res) => {
        const list = res?.stations || [];
        this.favorites = list;
        this.radioPlayer.setFavorites(list);
        this.cdr.markForCheck();
      });
  }

  private placeDefaultPosition(): void {
    if (this.positioned || typeof window === 'undefined') {
      return;
    }
    this.posX = Math.max(16, window.innerWidth - this.widthPx - 24);
    this.posY = Math.max(16, window.innerHeight - 520);
    this.positioned = true;
  }

  private clampToViewport(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.posX = Math.max(0, Math.min(this.posX, window.innerWidth - 80));
    this.posY = Math.max(0, Math.min(this.posY, window.innerHeight - this.headerH));
  }

  private playStation(station: RadioStation): void {
    const media = this.mediaEl?.nativeElement;
    if (!media || !station?.streamUrl) {
      return;
    }
    const gen = ++this.playGeneration;
    // Keep Document PiP + World Receiver face open while switching presets.
    const keepDocPip = isRadioDocPipOpen();
    this.suppressPipHostClose = true;
    this.destroyPlayer(false, { keepDocPip });
    this.playError = '';
    this.isBuffering = true;
    this.cdr.markForCheck();

    applyRadioMediaSession({ title: station.name || 'Radio', artworkUrl: station.logo });

    const proxyUrl = this.api.radioStreamProxyUrl(station.streamUrl);
    const url = (station.streamUrl || '').toLowerCase();
    const codec = (station.codec || '').toLowerCase();
    const isHls =
      url.includes('.m3u8') ||
      codec.includes('mpegurl') ||
      codec.includes('m3u8') ||
      codec.includes('hls');
    const wantPip = !!this.state.pipHostOnly || !!this.state.autoPip;

    const onError = (message: string) => {
      if (gen !== this.playGeneration) {
        return;
      }
      this.playError = message || 'RADIO.ERR_STREAM';
      this.isBuffering = false;
      this.suppressPipHostClose = false;
      this.cdr.markForCheck();
    };

    const afterPlaying = () => {
      if (gen !== this.playGeneration) {
        return;
      }
      this.isBuffering = false;
      this.cdr.markForCheck();
      if (wantPip && supportsRadioDocumentPip() && !isRadioDocPipOpen()) {
        void this.enterPipForHost(media).finally(() => {
          this.suppressPipHostClose = false;
        });
      } else {
        this.suppressPipHostClose = false;
        if (isRadioDocPipOpen()) {
          this.isPipActive = true;
        }
      }
    };

    const tryPlay = () => {
      if (gen !== this.playGeneration) {
        return;
      }
      media.muted = false;
      this.isMuted = false;
      void media
        .play()
        .then(() => afterPlaying())
        .catch((err: unknown) => {
          const name =
            err && typeof err === 'object' && 'name' in err
              ? String((err as { name: string }).name)
              : '';
          if (name === 'NotAllowedError') {
            media.muted = true;
            this.isMuted = true;
            void media
              .play()
              .then(() => afterPlaying())
              .catch(() => onError('RADIO.ERR_PLAY'));
            return;
          }
          onError('RADIO.ERR_PLAY');
        });
    };

    media.onwaiting = () => {
      if (gen === this.playGeneration) {
        this.isBuffering = true;
        this.cdr.markForCheck();
      }
    };
    media.onplaying = () => {
      if (gen === this.playGeneration) {
        this.isBuffering = false;
        this.cdr.markForCheck();
      }
    };
    media.onerror = () => onError('RADIO.ERR_MEDIA');

    if (isHls && Hls.isSupported()) {
      const hls = new Hls(createTvHlsConfig());
      this.hls = hls;
      hls.loadSource(proxyUrl);
      hls.attachMedia(media);
      hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && !tryRecoverTvHlsError(hls, data)) {
          onError('RADIO.ERR_STREAM');
        }
      });
      return;
    }

    media.src = proxyUrl;
    tryPlay();
  }

  private destroyPlayer(clearSrc = true, options?: { keepDocPip?: boolean }): void {
    if (!options?.keepDocPip) {
      closeRadioDocPip();
      const pip = document.pictureInPictureElement;
      if (
        pip === this.mediaEl?.nativeElement ||
        pip === document.getElementById('pattool-radio-pip-carrier')
      ) {
        document.exitPictureInPicture().catch(() => undefined);
        stopRadioPipCarrier();
      }
      this.isPipActive = false;
    }
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // ignore
      }
      this.hls = null;
    }
    const media = this.mediaEl?.nativeElement;
    if (media) {
      media.onwaiting = null;
      media.onplaying = null;
      media.onerror = null;
      try {
        media.pause();
      } catch {
        // ignore
      }
      if (clearSrc) {
        media.removeAttribute('src');
        media.load();
      }
    }
  }

  private async openDocPip(media: HTMLVideoElement): Promise<void> {
    if (!this.station) {
      return;
    }
    await enterRadioPictureInPicture(
      media,
      {
        title: this.station.name || 'Radio',
        artworkUrl: this.stationLogo(this.station),
        countryLabel: this.countryLabel(this.station.country),
        faceEl: this.playerPanelEl?.nativeElement || null,
        labels: {
          fullscreen: this.translate.instant('RADIO.FULLSCREEN'),
          fullscreenExit: this.translate.instant('RADIO.FULLSCREEN_EXIT'),
          close: this.translate.instant('RADIO.PIP_EXIT')
        },
        onClose: () => {
          this.isPipActive = false;
          // Ignore teardown while we intentionally restart the stream / re-enter PiP.
          if (this.suppressPipHostClose) {
            this.cdr.markForCheck();
            return;
          }
          if (this.state.pipHostOnly && this.state.open) {
            this.radioPlayer.close({ resumeOnPage: true });
          }
          this.cdr.markForCheck();
        }
      },
      { replaceIfOpen: !!this.state.autoPip || !!this.state.pipHostOnly }
    );
  }

  private async enterPipForHost(media: HTMLVideoElement): Promise<void> {
    if (!this.pipSupported || !this.state.open || !this.station) {
      return;
    }
    if (!this.state.pipHostOnly && !this.state.autoPip) {
      return;
    }
    try {
      // Wait until the World Receiver cabinet is in the DOM and laid out.
      for (let i = 0; i < 12 && !this.playerPanelEl?.nativeElement; i++) {
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await this.openDocPip(media);
      this.isPipActive = true;
      this.cdr.markForCheck();
    } catch {
      // Fallback: keep the in-app World Receiver visible so listening continues.
      if (this.state.pipHostOnly) {
        this.radioPlayer.restore();
      }
      this.suppressPipHostClose = false;
    }
  }
}
