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

import { ApiService, RadioNowPlaying, RadioStation, RadioTrackImage } from '../services/api.service';
import { RadioNowPlayingService } from '../services/radio-now-playing.service';
import { RadioFloatingState, RadioPlayerService } from '../services/radio-player.service';
import { YoutubeEqualizerService } from '../services/youtube-equalizer.service';
import { YoutubeEqualizerModalComponent } from '../youtube-watcher/youtube-equalizer-modal.component';
import { setDeviceMediaVolume, activeScreenKeepAliveOwner } from '../services/media-screen-keepalive';
import { createTvHlsConfig, resetTvMediaElement, tryRecoverTvHlsError } from '../tv-watcher/tv-hls-config';
import { attachRadioPlaybackGuard, bustRadioStreamUrl, RadioPlaybackGuard } from './radio-playback-guard';

const RADIO_SKIN_IDS = [
  'classic', 'artdeco', 'synthwave', 'spaceage', 'military', 'steampunk', 'aurora',
  'noir', 'bamboo', 'porcelain', 'carbon', 'candy', 'espace', 'kanizsa', 'cafewall',
  'penrose', 'scintille', 'barber'
] as const;
type RadioSkinId = (typeof RADIO_SKIN_IDS)[number];
import {
  adjacentRadioStation,
  claimRadioTune,
  publishRadioTrack,
  closeRadioDocPip,
  enterRadioPictureInPicture,
  getBrowserDocPipWindow,
  isRadioDocPipOpen,
  stopRadioPipCarrier,
  supportsRadioDocumentPip,
  supportsRadioPictureInPicture
} from './radio-pip.util';

@Component({
  selector: 'app-radio-floating-player',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, TranslateModule, YoutubeEqualizerModalComponent],
  templateUrl: './radio-floating-player.component.html',
  styleUrls: ['./radio-watcher.component.css', './radio-skins.css', './radio-floating-player.component.css']
})
export class RadioFloatingPlayerComponent implements OnInit, OnDestroy {
  private readonly onLiveVolume = (): void => this.onMediaVolumeChange();

  private get liveAudio(): HTMLAudioElement {
    return this.radioPlayer.audio;
  }
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;
  @ViewChild('eqModal') eqModal?: YoutubeEqualizerModalComponent;

  state: RadioFloatingState = { open: false, minimized: false, station: null };
  isMuted = false;
  volumePercent = 100;
  private followDeviceVolume = false;
  isBuffering = false;
  /** Stream dropped; playback restarts when the network is back. */
  isReconnecting = false;
  playError = '';
  nowPlayingLabel = '';
  radioSkin: RadioSkinId = 'classic';
  sleeveOpen = false;
  trackImages: RadioTrackImage[] = [];
  trackImageIndex = 0;
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
  /** The bar stays bottom-left until the user drags it. */
  private userMoved = false;

  private hls: Hls | null = null;
  private playbackGuard: RadioPlaybackGuard | null = null;
  private stateSub?: Subscription;
  private eqSub?: Subscription;
  private favoritesSub?: Subscription;
  private nowPlayingSub?: Subscription;
  private nowPlayingTitle = '';
  private nowPlayingArtist = '';
  private nowPlayingAlbum = '';
  private nowPlayingArt = '';
  private lastStationId = '';
  private trackSlideTimer: ReturnType<typeof setInterval> | null = null;
  /** User moved the in-page float out of the browser. Closing that window brings it back. */
  private userPoppedOut = false;
  private playGeneration = 0;
  private alive = true;
  private suppressPipHostClose = false;
  private static readonly PRESET_COUNT = 12;

  constructor(
    private radioPlayer: RadioPlayerService,
    private api: ApiService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    private nowPlaying: RadioNowPlayingService,
    private equalizer: YoutubeEqualizerService
  ) {}

  formatPlayError(message: string | null | undefined): string {
    const m = (message || '').trim();
    if (!m) {
      return '';
    }
    return m.startsWith('RADIO.') ? this.translate.instant(m) : m;
  }

  ngOnInit(): void {
    this.liveAudio.addEventListener('volumechange', this.onLiveVolume);
    this.liveAudio.addEventListener('playing', this.onEqAudioPlaying);
    this.eqSub = this.equalizer.settings$.subscribe(() => this.onEqAudioPlaying());
    this.onEqAudioPlaying();
    this.readRadioLook();
    window.addEventListener('patradiotransport', this.onBluetoothTune);
    window.addEventListener('patmediavolumeui', this.onDeviceVolumeUi);
    window.addEventListener('patradiolook', this.onRadioLook);
    this.placeDefaultPosition();
    this.favorites = this.radioPlayer.favorites;
    this.loadFavorites();
    this.nowPlayingSub = this.nowPlaying.state$.subscribe((state) => this.applyNowPlaying(state));
    this.stateSub = this.radioPlayer.state$.subscribe((s) => {
      const prevOpen = this.state.open;
      const stationChanged = (s.station?.id || '') !== this.lastStationId;
      this.state = s;
      if (this.radioPlayer.favorites.length) {
        this.favorites = this.radioPlayer.favorites;
      }
      this.cdr.markForCheck();
      if (!s.open) {
        const keep = this.radioPlayer.takeKeepStream();
        if (keep) {
          this.destroyPlayer(false, { keepLive: true });
          return;
        }
        this.destroyPlayer(true, { releaseEqualizer: true });
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
    window.removeEventListener('patradiotransport', this.onBluetoothTune);
    window.removeEventListener('patmediavolumeui', this.onDeviceVolumeUi);
    window.removeEventListener('patradiolook', this.onRadioLook);
    this.clearTrackSlide();
    this.alive = false;
    this.liveAudio.removeEventListener('volumechange', this.onLiveVolume);
    this.liveAudio.removeEventListener('playing', this.onEqAudioPlaying);
    this.eqSub?.unsubscribe();
    this.stateSub?.unsubscribe();
    this.favoritesSub?.unsubscribe();
    this.nowPlayingSub?.unsubscribe();
    this.destroyPlayer(true, { releaseEqualizer: true });
  }

  get station(): RadioStation | null {
    return this.state.station;
  }

  get eqActive(): boolean {
    return this.equalizer.wantsProcessing && (this.equalizer.sourceKind === 'media' || !!this.station);
  }

  /** Artist and title of the track on air, for a YouTube search. */
  get youtubeSearchQuery(): string {
    const artist = this.nowPlayingArtist.trim();
    const title = this.nowPlayingTitle.trim();
    if (artist && title) {
      return title.toLowerCase().includes(artist.toLowerCase()) ? title : `${artist} ${title}`;
    }
    return artist || title;
  }

  /** Cover on the face only when the user left pochette mode on and a photo exists. */
  get sleeveVisible(): boolean {
    return this.sleeveOpen && this.trackImages.length > 0;
  }

  trackImageUrl(_index: number, img: RadioTrackImage): string {
    return img.url;
  }

  dropTrackImage(index: number): void {
    if (index < 0 || index >= this.trackImages.length) {
      return;
    }
    this.trackImages = this.trackImages.filter((_, i) => i !== index);
    if (this.trackImageIndex >= this.trackImages.length) {
      this.trackImageIndex = 0;
    }
    this.nowPlayingArt = this.trackImages[0]?.url || '';
    this.syncTrackSlide();
    this.cdr.markForCheck();
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

  private readonly onDeviceVolumeUi = (event: Event): void => {
    const raw = Number((event as CustomEvent<number>).detail);
    if (!Number.isFinite(raw)) {
      return;
    }
    this.followDeviceVolume = true;
    this.volumePercent = Math.max(0, Math.min(100, Math.round(raw)));
    this.isMuted = this.volumePercent === 0;
    this.cdr.markForCheck();
  };

  private readonly onBluetoothTune = (event: Event): void => {
    const owner = activeScreenKeepAliveOwner();
    if (!this.alive || !this.state.open || owner === 'youtube' || owner === 'deezer' || owner === 'clip') {
      return;
    }
    const action = (event as CustomEvent<string>).detail;
    if (action !== 'next' && action !== 'previous') {
      return;
    }
    if (!claimRadioTune()) {
      return;
    }
    const station = adjacentRadioStation(action, this.station, this.favorites, []);
    if (!station) {
      return;
    }
    this.radioPlayer.setStation(station as RadioStation);
  };

  openEqualizer(): void {
    const el = this.liveAudio;
    if (el) {
      this.equalizer.attachMediaElement(el);
    } else {
      void this.equalizer.resume();
    }
    this.eqModal?.open();
  }

  playPreset(station: RadioStation | null, event?: Event): void {
    event?.stopPropagation();
    if (!station) {
      return;
    }
    this.radioPlayer.setStation(station);
  }

  async togglePictureInPicture(): Promise<void> {
    const media = this.liveAudio;
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
        if (!this.alive) {
          return;
        }
      }
      const fromVisibleFloat = !this.state.pipHostOnly;
      await this.openDocPip(media);
      this.playError = '';
      this.isPipActive = true;
      if (fromVisibleFloat && isRadioDocPipOpen()) {
        this.userPoppedOut = true;
        this.radioPlayer.presentOutside();
      }
      this.cdr.markForCheck();
    } catch {
      this.playError = 'RADIO.ERR_PIP';
      this.cdr.markForCheck();
    }
  }

  toggleMute(): void {
    const media = this.liveAudio;
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
    const media = this.liveAudio;
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    this.volumePercent = p;
    if (setDeviceMediaVolume(p)) {
      this.followDeviceVolume = true;
      if (media) {
        media.muted = p === 0;
        media.volume = p === 0 ? 0 : 1;
        this.isMuted = media.muted;
      }
      return;
    }
    if (media) {
      media.volume = p / 100;
      media.muted = p === 0;
      this.isMuted = media.muted;
    }
  }

  onMediaVolumeChange(): void {
    if (this.followDeviceVolume) {
      return;
    }
    const media = this.liveAudio;
    if (!media) {
      return;
    }
    this.isMuted = !!media.muted;
    this.volumePercent = Math.round((media.muted ? 0 : media.volume) * 100);
    this.cdr.markForCheck();
  }

  startDrag(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, label')) {
      return;
    }
    if (event.button !== 0 || this.state.pipHostOnly) {
      return;
    }
    this.userMoved = true;
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
      pip === this.liveAudio ||
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
    const media = this.liveAudio;
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
        if (!this.alive) {
          return;
        }
        const list = res?.stations || [];
        this.favorites = list;
        this.radioPlayer.setFavorites(list);
        this.cdr.markForCheck();
      });
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.userMoved) {
      this.clampToViewport();
    } else {
      this.placeDefaultPosition();
    }
    this.cdr.markForCheck();
  }

  private placeDefaultPosition(): void {
    if (this.userMoved || typeof window === 'undefined') {
      return;
    }
    this.posX = 16;
    this.posY = Math.max(16, window.innerHeight - 72);
    this.positioned = true;
  }

  private clampToViewport(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.posX = Math.max(0, Math.min(this.posX, window.innerWidth - 80));
    this.posY = Math.max(0, Math.min(this.posY, window.innerHeight - this.headerH));
  }

  /** The shared element is already playing this station. Keep the socket open. */
  private continueFloatLive(station: RadioStation, media: HTMLAudioElement): void {
    const gen = ++this.playGeneration;
    delete media.dataset['patSkipBackground'];
    this.isBuffering = false;
    this.isReconnecting = false;
    this.playError = '';
    this.suppressPipHostClose = false;
    this.nowPlaying.watch('float', station);
    publishRadioTrack(media, { station: station.name, artworkUrl: station.logo });
    this.playbackGuard?.dispose();
    this.playbackGuard = attachRadioPlaybackGuard({
      media,
      isCurrent: () => this.alive && gen === this.playGeneration,
      reload: () => {
        if (!this.alive || gen !== this.playGeneration) {
          return;
        }
        this.playStation(station, 'reconnect');
      },
      onReconnecting: () => this.noteRadioReconnect(gen)
    });
    void this.engageEqualizer(media);
    this.cdr.markForCheck();
  }

  private playStation(station: RadioStation, reason: 'user' | 'reconnect' = 'user'): void {
    const media = this.liveAudio;
    if (this.alive && media && this.equalizer.wantsProcessing) {
      void this.equalizer.resume();
      this.equalizer.engageMedia(media);
    }
    if (!this.alive || !media || !station?.streamUrl) {
      return;
    }
    if (reason !== 'reconnect' && this.radioPlayer.isLive(media, station)) {
      this.continueFloatLive(station, media);
      return;
    }
    // Keep Document PiP + World Receiver face open while switching presets or reconnecting.
    const keepDocPip = isRadioDocPipOpen();
    this.suppressPipHostClose = true;
    this.destroyPlayer(false, { keepDocPip, handoffNowPlaying: true });
    this.nowPlaying.watch('float', station);
    if (!this.alive) {
      return;
    }
    delete media.dataset['patSkipBackground'];
    media.dataset['patStationId'] = this.radioPlayer.stationKey(station);
    if (reason !== 'reconnect') {
      this.isReconnecting = false;
    }
    const gen = ++this.playGeneration;
    this.playError = '';
    this.isBuffering = true;
    this.cdr.markForCheck();

    publishRadioTrack(media, { station: station.name, artworkUrl: station.logo });

    const proxyUrl = bustRadioStreamUrl(this.api.radioStreamProxyUrl(station.streamUrl));
    this.playbackGuard = attachRadioPlaybackGuard({
      media,
      isCurrent: () => this.alive && gen === this.playGeneration,
      reload: () => {
        if (!this.alive || gen !== this.playGeneration) {
          return;
        }
        this.playStation(station, 'reconnect');
      },
      onReconnecting: () => this.noteRadioReconnect(gen)
    });
    const url = (station.streamUrl || '').toLowerCase();
    const codec = (station.codec || '').toLowerCase();
    const isHls =
      url.includes('.m3u8') ||
      codec.includes('mpegurl') ||
      codec.includes('m3u8') ||
      codec.includes('hls');
    const wantPip = !!this.state.pipHostOnly || !!this.state.autoPip;
    // The page already opened the window during the click. Fill it now;
    // waiting for the stream to start is too late for a new requestWindow().
    if (wantPip && getBrowserDocPipWindow() && !isRadioDocPipOpen()) {
      void this.openDocPip(media);
    }

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
      this.isReconnecting = false;
      this.playError = '';
      void this.engageEqualizer(media);
      this.cdr.markForCheck();
      if (
        wantPip &&
        supportsRadioDocumentPip() &&
        !isRadioDocPipOpen() &&
        !getBrowserDocPipWindow()
      ) {
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
      void this.engageEqualizer(media).finally(() => {
        if (gen !== this.playGeneration) {
          return;
        }
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
              void media
                .play()
                .then(() => {
                  media.muted = false;
                  this.isMuted = false;
                  if (media.volume <= 0) {
                    this.volumePercent = this.volumePercent > 0 ? this.volumePercent : 80;
                    media.volume = this.volumePercent / 100;
                  }
                  afterPlaying();
                })
                .catch(() => {
                  if (reason === 'user') {
                    onError('RADIO.ERR_PLAY');
                    return;
                  }
                  this.playbackGuard?.requestReconnect();
                });
              return;
            }
            this.playbackGuard?.requestReconnect();
          });
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
        this.isReconnecting = false;
        this.playError = '';
        this.cdr.markForCheck();
      }
    };
    media.onerror = null;

    if (isHls && Hls.isSupported()) {
      const hls = new Hls(createTvHlsConfig());
      this.hls = hls;
      hls.loadSource(proxyUrl);
      hls.attachMedia(media);
      hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay());
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (gen !== this.playGeneration) {
          return;
        }
        if (data.fatal && !tryRecoverTvHlsError(hls, data)) {
          this.playbackGuard?.requestReconnect();
        }
      });
      return;
    }

    media.src = proxyUrl;
    tryPlay();
  }

  private noteRadioReconnect(gen: number): void {
    if (!this.alive || gen !== this.playGeneration) {
      return;
    }
    this.playError = '';
    this.isReconnecting = true;
    this.isBuffering = true;
    this.suppressPipHostClose = false;
    try {
      this.cdr.detectChanges();
    } catch {
      this.cdr.markForCheck();
    }
  }

  private readonly onRadioLook = (): void => {
    this.readRadioLook();
    this.cdr.markForCheck();
  };

  private readRadioLook(): void {
    try {
      const skin = localStorage.getItem('pattool.radio.skin');
      this.radioSkin = (RADIO_SKIN_IDS as readonly string[]).includes(skin || '')
        ? (skin as RadioSkinId)
        : 'classic';
      this.sleeveOpen = localStorage.getItem('pattool.radio.sleeve') === '1';
    } catch {
      this.radioSkin = 'classic';
      this.sleeveOpen = false;
    }
  }

  private applyNowPlaying(state: RadioNowPlaying | null): void {
    this.nowPlayingLabel = (state?.label || '').trim();
    this.nowPlayingTitle = (state?.title || '').trim();
    this.nowPlayingArtist = (state?.artist || '').trim();
    this.nowPlayingAlbum = (state?.album || '').trim();
    const images = state?.images || [];
    const same =
      images.length === this.trackImages.length &&
      images.every((img, i) => img.url === this.trackImages[i]?.url);
    if (!same) {
      this.trackImages = images;
      this.trackImageIndex = 0;
    }
    this.nowPlayingArt = this.trackImages[0]?.url || '';
    this.syncTrackSlide();
    this.pushNowPlayingSession();
    this.cdr.markForCheck();
  }

  private syncTrackSlide(): void {
    if (this.trackImages.length < 2) {
      this.clearTrackSlide();
      this.trackImageIndex = 0;
      return;
    }
    if (this.trackSlideTimer) {
      return;
    }
    this.trackSlideTimer = setInterval(() => {
      if (!this.alive || this.trackImages.length < 2) {
        this.clearTrackSlide();
        return;
      }
      this.trackImageIndex = (this.trackImageIndex + 1) % this.trackImages.length;
      this.cdr.markForCheck();
    }, 8000);
  }

  private clearTrackSlide(): void {
    if (this.trackSlideTimer) {
      clearInterval(this.trackSlideTimer);
      this.trackSlideTimer = null;
    }
  }

  private pushNowPlayingSession(): void {
    if (!this.state.open || !this.station || this.playError) {
      return;
    }
    publishRadioTrack(this.liveAudio, {
      station: this.station.name,
      title: this.nowPlayingTitle,
      artist: this.nowPlayingArtist,
      album: this.nowPlayingAlbum,
      artworkUrl: this.nowPlayingArt || this.station.logo
    });
  }

  private readonly onEqAudioPlaying = (): void => {
    if (!this.alive || !this.state.open) {
      return;
    }
    const media = this.liveAudio;
    if (!media || media.paused) {
      return;
    }
    void this.engageEqualizer(media);
  };

  private async engageEqualizer(media: HTMLMediaElement): Promise<void> {
    if (!this.alive || !this.equalizer.wantsProcessing) {
      return;
    }
    void this.equalizer.resume();
    this.equalizer.engageMedia(media);
    this.cdr.markForCheck();
  }

  private destroyPlayer(
    clearSrc = true,
    options?: { keepDocPip?: boolean; handoffNowPlaying?: boolean; releaseEqualizer?: boolean; keepLive?: boolean }
  ): void {
    if (options?.keepLive) {
      this.playbackGuard?.dispose();
      this.playbackGuard = null;
      this.playGeneration++;
      return;
    }
    if (options?.releaseEqualizer) {
      this.equalizer.detachMediaElement(this.liveAudio);
    }
    if (!options?.handoffNowPlaying) {
      this.nowPlaying.release('float');
    }
    const tearingDown = this.liveAudio;
    if (tearingDown) {
      tearingDown.dataset['patSkipBackground'] = '1';
    }
    this.playbackGuard?.dispose();
    this.playbackGuard = null;
    this.playGeneration++;
    if (!options?.keepDocPip) {
      closeRadioDocPip();
      const pip = document.pictureInPictureElement;
      if (
        pip === this.liveAudio ||
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
    const media = this.liveAudio;
    if (media) {
      media.onwaiting = null;
      media.onplaying = null;
      media.onerror = null;
      if (clearSrc) {
        resetTvMediaElement(media);
      } else {
        try {
          media.pause();
        } catch {
          // ignore
        }
        try {
          media.srcObject = null;
        } catch {
          // ignore
        }
      }
    }
  }

  private async openDocPip(media: HTMLMediaElement): Promise<void> {
    if (!this.station) {
      return;
    }
    await enterRadioPictureInPicture(
      media,
      {
        title: this.station.name || 'Radio',
        trackTitle: this.nowPlayingTitle,
        artist: this.nowPlayingArtist,
        album: this.nowPlayingAlbum,
        artworkUrl: this.nowPlayingArt || this.stationLogo(this.station),
        countryLabel: this.countryLabel(this.station.country),
        faceEl: this.playerPanelEl?.nativeElement || null,
        labels: {
          fullscreen: this.translate.instant('RADIO.FULLSCREEN'),
          fullscreenExit: this.translate.instant('RADIO.FULLSCREEN_EXIT'),
          close: this.translate.instant('RADIO.PIP_EXIT')
        },
        onClose: () => {
          if (!this.alive) {
            return;
          }
          this.isPipActive = false;
          // Ignore teardown while we intentionally restart the stream / re-enter PiP.
          if (this.suppressPipHostClose) {
            this.cdr.markForCheck();
            return;
          }
          if (this.userPoppedOut) {
            this.userPoppedOut = false;
            this.radioPlayer.restore();
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

  private async enterPipForHost(media: HTMLMediaElement): Promise<void> {
    if (!this.alive || !this.pipSupported || !this.state.open || !this.station) {
      return;
    }
    if (!this.state.pipHostOnly && !this.state.autoPip) {
      return;
    }
    const pipGen = this.playGeneration;
    try {
      // Wait until the World Receiver cabinet is in the DOM and laid out.
      for (let i = 0; i < 12 && !this.playerPanelEl?.nativeElement; i++) {
        if (!this.alive || pipGen !== this.playGeneration || !this.state.open) {
          return;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!this.alive || pipGen !== this.playGeneration || !this.state.open) {
        return;
      }
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      if (!this.alive || pipGen !== this.playGeneration || !this.state.open) {
        return;
      }
      await this.openDocPip(media);
      if (!this.alive || pipGen !== this.playGeneration) {
        return;
      }
      this.isPipActive = true;
      this.cdr.markForCheck();
    } catch {
      // Fallback: keep the in-app World Receiver visible so listening continues.
      if (this.alive && this.state.pipHostOnly) {
        this.radioPlayer.restore();
      }
      this.suppressPipHostClose = false;
    }
  }
}
