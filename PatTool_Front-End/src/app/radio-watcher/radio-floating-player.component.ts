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
import Hls from 'hls.js';

import { ApiService, RadioStation } from '../services/api.service';
import { RadioFloatingState, RadioPlayerService } from '../services/radio-player.service';
import { createTvHlsConfig, tryRecoverTvHlsError } from '../tv-watcher/tv-hls-config';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

@Component({
  selector: 'app-radio-floating-player',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TranslateModule],
  templateUrl: './radio-floating-player.component.html',
  styleUrls: ['./radio-floating-player.component.css']
})
export class RadioFloatingPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('mediaEl') mediaEl?: ElementRef<HTMLVideoElement>;

  state: RadioFloatingState = { open: false, minimized: false, station: null };
  isMuted = false;
  volumePercent = 100;
  isBuffering = false;
  playError = '';

  posX = 24;
  posY = 24;
  widthPx = 360;
  heightPx = 220;

  private readonly minW = 260;
  private readonly minH = 140;
  private readonly maxW = 900;
  private readonly maxH = 600;
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

  private hls: Hls | null = null;
  private stateSub?: Subscription;
  private lastStationId = '';
  private playGeneration = 0;

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
    this.stateSub = this.radioPlayer.state$.subscribe((s) => {
      const prevOpen = this.state.open;
      const stationChanged = (s.station?.id || '') !== this.lastStationId;
      this.state = s;
      this.cdr.markForCheck();
      if (!s.open) {
        this.destroyPlayer();
        this.lastStationId = '';
        return;
      }
      if (s.station && (stationChanged || !prevOpen)) {
        this.lastStationId = s.station.id || '';
        setTimeout(() => this.playStation(s.station!), 0);
      }
    });
  }

  ngOnDestroy(): void {
    this.stateSub?.unsubscribe();
    this.destroyPlayer();
  }

  get station(): RadioStation | null {
    return this.state.station;
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
    if (event.button !== 0 || this.state.minimized) {
      return;
    }
    this.dragging = true;
    this.dragOffsetX = event.clientX - this.posX;
    this.dragOffsetY = event.clientY - this.posY;
    event.preventDefault();
  }

  startResize(edge: ResizeEdge, event: MouseEvent): void {
    if (event.button !== 0 || this.state.minimized) {
      return;
    }
    this.resizing = edge;
    this.resizeStartX = event.clientX;
    this.resizeStartY = event.clientY;
    this.resizeStartW = this.widthPx;
    this.resizeStartH = this.heightPx;
    this.resizeStartPosX = this.posX;
    this.resizeStartPosY = this.posY;
    event.preventDefault();
    event.stopPropagation();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.dragging) {
      this.posX = Math.max(0, event.clientX - this.dragOffsetX);
      this.posY = Math.max(0, event.clientY - this.dragOffsetY);
      this.clampToViewport();
      return;
    }
    if (!this.resizing) {
      return;
    }
    const dx = event.clientX - this.resizeStartX;
    const dy = event.clientY - this.resizeStartY;
    let w = this.resizeStartW;
    let h = this.resizeStartH;
    let x = this.resizeStartPosX;
    let y = this.resizeStartPosY;
    if (this.resizing.includes('e')) {
      w = this.resizeStartW + dx;
    }
    if (this.resizing.includes('s')) {
      h = this.resizeStartH + dy;
    }
    if (this.resizing.includes('w')) {
      w = this.resizeStartW - dx;
      x = this.resizeStartPosX + dx;
    }
    if (this.resizing.includes('n')) {
      h = this.resizeStartH - dy;
      y = this.resizeStartPosY + dy;
    }
    this.widthPx = Math.max(this.minW, Math.min(this.maxW, w));
    this.heightPx = Math.max(this.minH, Math.min(this.maxH, h));
    this.posX = x;
    this.posY = y;
    this.clampToViewport();
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    this.dragging = false;
    this.resizing = null;
  }

  private placeDefaultPosition(): void {
    if (this.positioned || typeof window === 'undefined') {
      return;
    }
    this.posX = Math.max(16, window.innerWidth - this.widthPx - 24);
    this.posY = Math.max(16, window.innerHeight - this.heightPx - 24);
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
    this.destroyPlayer(false);
    this.playError = '';
    this.isBuffering = true;
    this.cdr.markForCheck();

    const proxyUrl = this.api.radioStreamProxyUrl(station.streamUrl);
    const url = (station.streamUrl || '').toLowerCase();
    const codec = (station.codec || '').toLowerCase();
    const isHls =
      url.includes('.m3u8') ||
      codec.includes('mpegurl') ||
      codec.includes('m3u8') ||
      codec.includes('hls');

    const onError = (message: string) => {
      if (gen !== this.playGeneration) {
        return;
      }
      this.playError = message || 'RADIO.ERR_STREAM';
      this.isBuffering = false;
      this.cdr.markForCheck();
    };

    const tryPlay = () => {
      if (gen !== this.playGeneration) {
        return;
      }
      media.muted = false;
      this.isMuted = false;
      void media.play().then(() => {
        this.isBuffering = false;
        this.cdr.markForCheck();
      }).catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
        if (name === 'NotAllowedError') {
          media.muted = true;
          this.isMuted = true;
          void media.play().then(() => {
            this.isBuffering = false;
            this.cdr.markForCheck();
          }).catch(() => onError('RADIO.ERR_PLAY'));
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

  private destroyPlayer(clearSrc = true): void {
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
}
