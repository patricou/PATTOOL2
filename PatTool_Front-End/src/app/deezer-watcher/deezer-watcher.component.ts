import { Component, ElementRef, HostBinding, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs/operators';

import {
  ApiService,
  DeezerAlbum,
  DeezerArtist,
  DeezerGenre,
  DeezerPlaylist,
  DeezerSearchType,
  DeezerTrack
} from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { YoutubeEqualizerService } from '../services/youtube-equalizer.service';
import { YoutubeEqualizerModalComponent } from '../youtube-watcher/youtube-equalizer-modal.component';
import {
  closeRadioDocPip,
  enterRadioPictureInPicture,
  isRadioDocPipOpen,
  stopRadioPipCarrier,
  supportsRadioPictureInPicture
} from '../radio-watcher/radio-pip.util';

type DzMode = 'chart' | 'search';
type DzSkin =
  | 'classic' | 'artdeco' | 'synthwave' | 'spaceage' | 'military' | 'steampunk'
  | 'aurora' | 'noir' | 'bamboo' | 'porcelain' | 'carbon' | 'candy' | 'espace'
  | 'kanizsa' | 'cafewall' | 'penrose' | 'scintille' | 'barber';

const DZ_SKINS: readonly DzSkin[] = [
  'classic', 'artdeco', 'synthwave', 'spaceage', 'military', 'steampunk',
  'aurora', 'noir', 'bamboo', 'porcelain', 'carbon', 'candy', 'espace',
  'kanizsa', 'cafewall', 'penrose', 'scintille', 'barber'
];

interface DzShelf {
  mode: DzMode;
  query: string;
  genreId: number;
  view: DeezerSearchType;
  tracks: DeezerTrack[];
  albums: DeezerAlbum[];
  artists: DeezerArtist[];
  playlists: DeezerPlaylist[];
}

@Component({
  selector: 'app-deezer-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, YoutubeEqualizerModalComponent],
  templateUrl: './deezer-watcher.component.html',
  styleUrls: [
    '../radio-watcher/radio-watcher.component.css',
    '../radio-watcher/radio-skins.css',
    './deezer-watcher.component.css'
  ]
})
export class DeezerWatcherComponent implements OnInit, OnDestroy {
  private static readonly VOLUME_KEY = 'pattool.deezer.volume';
  private static readonly SLEEVE_KEY = 'pattool.deezer.sleeve';
  private static readonly SKIN_KEY = 'pattool.deezer.skin';
  private static readonly PRESET_KEY = 'pattool.deezer.presets';
  private static readonly KEEP_KEY = 'pattool.deezer.keep-alive';
  private static readonly PRESET_COUNT = 12;

  @ViewChild('audio') audioRef?: ElementRef<HTMLAudioElement>;
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;
  @ViewChild('eqModal') eqModal?: YoutubeEqualizerModalComponent;

  @HostBinding('class.radio-focus') get focusClass(): boolean { return this.focusMode; }
  @HostBinding('class.radio-stage-fs') get stageFsClass(): boolean { return this.stageFullscreen; }

  genres: DeezerGenre[] = [];
  genreId = 0;
  query = '';
  view: DeezerSearchType = 'track';
  mode: DzMode = 'chart';
  drilled = false;
  drillTitle = '';
  drillSubtitle = '';
  drillLink = '';

  tracks: DeezerTrack[] = [];
  albums: DeezerAlbum[] = [];
  artists: DeezerArtist[] = [];
  playlists: DeezerPlaylist[] = [];
  queue: DeezerTrack[] = [];
  sleeveAlbums: DeezerAlbum[] = [];
  related: DeezerArtist[] = [];

  current: DeezerTrack | null = null;
  playing = false;
  buffering = false;
  muted = false;
  volume = 0.9;
  currentTime = 0;
  audioDuration = 0;
  sleeveOpen = true;
  radioSkin: DzSkin = 'classic';
  skinMenuOpen = false;
  focusMode = false;
  stageFullscreen = false;
  shareMenuOpen = false;
  shareFeedback = '';
  keepAliveOnNavigate = false;
  docked = false;
  isPipActive = false;
  chromeVisible = true;
  trackImageIndex = 0;
  presets: (DeezerTrack | null)[] = [];
  loading = false;
  errorKey = '';
  playErrorKey = '';

  private shelf: DzShelf | null = null;
  private sleeveArtistId = 0;
  private queueIndexHint = -1;
  private sleeveTimer: ReturnType<typeof setTimeout> | null = null;
  private sleeveSub: Subscription | null = null;
  private previewFresh = false;
  private loadSeq = 0;
  private trackSlideTimer: ReturnType<typeof setInterval> | null = null;
  private readonly search$ = new Subject<string>();
  private readonly destroy$ = new Subject<void>();
  readonly illusionSkins: readonly DzSkin[] = ['kanizsa', 'cafewall', 'penrose', 'scintille', 'barber'];
  readonly pipSupported = supportsRadioPictureInPicture();
  readonly canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  constructor(
    private api: ApiService,
    private hostRef: ElementRef<HTMLElement>,
    private equalizer: YoutubeEqualizerService,
    private router: Router,
    private translate: TranslateService,
    private keycloak: KeycloakService
  ) {}

  ngOnInit(): void {
    this.volume = this.readVolume();
    this.sleeveOpen = this.readSleeve();
    this.radioSkin = this.readSkin();
    this.keepAliveOnNavigate = this.readKeepAlive();
    this.presets = this.readPresets();
    this.parkKeptAudio();
    this.search$.pipe(
      debounceTime(320),
      distinctUntilChanged(),
      takeUntil(this.destroy$)
    ).subscribe((q) => this.runQuery(q));
    this.loadGenres();
    this.loadChart();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.sleeveTimer) {
      clearTimeout(this.sleeveTimer);
    }
    this.clearTrackSlide();
    this.sleeveSub?.unsubscribe();
    document.body.classList.remove('radio-focus', 'radio-stage-fs');
    const audio = this.audioRef?.nativeElement;
    if (audio && this.keepAliveOnNavigate && this.playing) {
      audio.dataset['patDeezerKeep'] = '1';
      document.body.appendChild(audio);
      return;
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    if (this.isPipActive) {
      closeRadioDocPip();
    }
  }

  get genreChoices(): DeezerGenre[] {
    return this.genres.filter((genre) => genre.id !== 0);
  }

  get searching(): boolean {
    return this.query.trim().length >= 2 && !this.drilled;
  }

  get atStart(): boolean {
    return this.currentIndex() < 1;
  }

  get atEnd(): boolean {
    const index = this.currentIndex();
    return index < 0 || index >= this.queue.length - 1;
  }

  onQueryChange(value: string): void {
    this.query = value;
    this.search$.next(value.trim());
  }

  clearQuery(): void {
    this.query = '';
    this.search$.next('');
  }

  selectGenre(id: number): void {
    this.genreId = id;
    this.query = '';
    this.exitDrill();
    this.loadChart();
  }

  setView(view: DeezerSearchType): void {
    if (this.drilled) {
      return;
    }
    this.view = view;
    if (this.query.trim().length >= 2) {
      this.loadSearch(this.query.trim());
      return;
    }
    if (view === 'track') {
      this.queue = this.tracks;
    }
  }

  back(): void {
    const saved = this.shelf;
    this.loadSeq++;
    this.loading = false;
    this.exitDrill();
    if (!saved) {
      this.loadChart();
      return;
    }
    this.mode = saved.mode;
    this.query = saved.query;
    this.genreId = saved.genreId;
    this.view = saved.view;
    this.tracks = saved.tracks;
    this.albums = saved.albums;
    this.artists = saved.artists;
    this.playlists = saved.playlists;
    this.queue = saved.view === 'track' ? saved.tracks : [];
  }

  playTrack(track: DeezerTrack, index: number): void {
    if (this.current?.id === track.id) {
      this.togglePlay();
      return;
    }
    this.current = track;
    this.queueIndexHint = index;
    this.trackImageIndex = 0;
    this.syncTrackSlide();
    this.previewFresh = false;
    this.playErrorKey = '';
    this.currentTime = 0;
    this.audioDuration = 0;
    this.related = this.drilled ? this.related : [];
    this.scheduleSleeve(track.artistId || 0);
    const preview = (track.previewUrl || '').trim();
    if (!preview) {
      this.refreshPreview(track, true);
      return;
    }
    this.startAudio(preview);
  }

  togglePlay(): void {
    const audio = this.audioRef?.nativeElement;
    if (!this.current) {
      const first = this.queue[0];
      if (first) {
        this.playTrack(first, 0);
      }
      return;
    }
    if (!audio) {
      return;
    }
    if (audio.paused) {
      this.hushOthers(audio);
      audio.play().catch(() => {
        this.playErrorKey = 'DEEZER.ERR_PLAY';
        this.playing = false;
      });
    } else {
      audio.pause();
    }
  }

  prev(): void {
    const idx = this.currentIndex();
    if (idx > 0) {
      this.playTrack(this.queue[idx - 1], idx - 1);
    }
  }

  next(): void {
    const idx = this.currentIndex();
    if (idx >= 0 && idx < this.queue.length - 1) {
      this.playTrack(this.queue[idx + 1], idx + 1);
    }
  }

  stop(): void {
    const audio = this.audioRef?.nativeElement;
    if (!audio) {
      return;
    }
    audio.pause();
    audio.currentTime = 0;
    this.currentTime = 0;
    this.playing = false;
  }

  onVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, Number(value) || 0));
    this.muted = this.volume === 0;
    this.applyVolume();
    try {
      localStorage.setItem(DeezerWatcherComponent.VOLUME_KEY, String(this.volume));
    } catch {
      /* ignore */
    }
  }

  seek(event: Event): void {
    const audio = this.audioRef?.nativeElement;
    const input = event.target as HTMLInputElement | null;
    if (!audio || !input) {
      return;
    }
    const next = Number(input.value);
    if (Number.isFinite(next)) {
      audio.currentTime = next;
      this.currentTime = next;
    }
  }

  toggleSleeve(): void {
    this.sleeveOpen = !this.sleeveOpen;
    try {
      localStorage.setItem(DeezerWatcherComponent.SLEEVE_KEY, this.sleeveOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  openAlbum(album: DeezerAlbum): void {
    this.rememberShelf();
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.api.getDeezerAlbum(album.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        const tracks = page?.tracks || [];
        this.enterDrill(page?.album?.title || album.title, page?.album?.artistName || album.artistName || '', page?.album?.link || album.link || '');
        this.tracks = tracks;
        this.queue = tracks;
        if (tracks.length) {
          this.playTrack(tracks[0], 0);
        }
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  openArtist(artist: DeezerArtist): void {
    this.rememberShelf();
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.api.getDeezerArtist(artist.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        const tracks = page?.tracks || [];
        const name = page?.artist?.name || artist.name;
        this.enterDrill(name, '', page?.artist?.link || artist.link || '');
        this.tracks = tracks;
        this.queue = tracks;
        this.sleeveAlbums = page?.albums || [];
        this.sleeveArtistId = artist.id;
        this.related = page?.related || [];
        if (tracks.length) {
          this.playTrack(tracks[0], 0);
        }
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  openPlaylist(playlist: DeezerPlaylist): void {
    this.rememberShelf();
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.api.getDeezerPlaylist(playlist.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        const tracks = page?.tracks || [];
        this.enterDrill(page?.playlist?.title || playlist.title, page?.playlist?.userName || playlist.userName || '', page?.playlist?.link || playlist.link || '');
        this.tracks = tracks;
        this.queue = tracks;
        if (tracks.length) {
          this.playTrack(tracks[0], 0);
        }
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  openRelated(artist: DeezerArtist): void {
    this.openArtist(artist);
  }

  onAudioTime(): void {
    const audio = this.audioRef?.nativeElement;
    if (!audio) {
      return;
    }
    this.currentTime = audio.currentTime || 0;
    this.audioDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
  }

  onAudioPlay(): void {
    this.playing = true;
    this.buffering = false;
    this.playErrorKey = '';
  }

  onAudioPause(): void {
    this.playing = false;
    this.buffering = false;
  }

  onAudioWaiting(): void {
    this.buffering = true;
  }

  onAudioEnded(): void {
    this.playing = false;
    this.buffering = false;
    this.next();
  }

  onAudioError(): void {
    this.buffering = false;
    this.playing = false;
    if (!this.current || this.previewFresh) {
      this.playErrorKey = 'DEEZER.ERR_PLAY';
      return;
    }
    this.refreshPreview(this.current, true);
  }

  formatTime(value: number | null | undefined): string {
    const sec = Math.max(0, Math.floor(Number(value) || 0));
    const mins = Math.floor(sec / 60);
    const rest = sec % 60;
    return mins + ':' + String(rest).padStart(2, '0');
  }

  yearOf(date: string | null | undefined): string {
    const text = (date || '').trim();
    return text.length >= 4 ? text.slice(0, 4) : '';
  }

  formatFans(count: number | null | undefined): string {
    const n = Number(count) || 0;
    if (n >= 1_000_000) {
      return (n / 1_000_000).toFixed(1).replace('.0', '') + ' M';
    }
    if (n >= 1_000) {
      return Math.round(n / 1000) + ' k';
    }
    return n > 0 ? String(n) : '';
  }

  trackById(_index: number, item: { id: number }): number {
    return item.id;
  }

  private currentIndex(): number {
    if (!this.current) {
      return -1;
    }
    const found = this.queue.findIndex((track) => track.id === this.current!.id);
    return found >= 0 ? found : this.queueIndexHint;
  }

  private runQuery(query: string): void {
    this.exitDrill();
    if (query.length >= 2) {
      this.loadSearch(query);
      return;
    }
    this.loadChart();
  }

  private loadGenres(): void {
    this.api.getDeezerGenres().pipe(takeUntil(this.destroy$)).subscribe({
      next: (genres) => {
        this.genres = genres || [];
      },
      error: () => {
        this.genres = [];
      }
    });
  }

  private loadChart(): void {
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.mode = 'chart';
    const genreId = this.genreId;
    this.api.getDeezerChart(genreId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (chart) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.tracks = chart?.tracks || [];
        this.albums = chart?.albums || [];
        this.artists = chart?.artists || [];
        this.playlists = chart?.playlists || [];
        if (!this.drilled && this.view === 'track') {
          this.queue = this.tracks;
        }
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  private loadSearch(query: string): void {
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.mode = 'search';
    this.api.getDeezerSearch(query, this.view).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.tracks = page?.tracks || [];
        this.albums = page?.albums || [];
        this.artists = page?.artists || [];
        this.playlists = page?.playlists || [];
        this.queue = this.view === 'track' ? this.tracks : [];
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  private rememberShelf(): void {
    if (this.drilled) {
      return;
    }
    this.shelf = {
      mode: this.mode,
      query: this.query,
      genreId: this.genreId,
      view: this.view,
      tracks: this.tracks,
      albums: this.albums,
      artists: this.artists,
      playlists: this.playlists
    };
  }

  private enterDrill(title: string, subtitle: string, link: string): void {
    this.drilled = true;
    this.view = 'track';
    this.drillTitle = title;
    this.drillSubtitle = subtitle;
    this.drillLink = link;
    this.related = [];
  }

  private exitDrill(): void {
    this.drilled = false;
    this.drillTitle = '';
    this.drillSubtitle = '';
    this.drillLink = '';
    this.related = [];
    this.shelf = null;
  }

  private scheduleSleeve(artistId: number): void {
    if (!artistId || artistId === this.sleeveArtistId) {
      return;
    }
    if (this.sleeveTimer) {
      clearTimeout(this.sleeveTimer);
    }
    this.sleeveTimer = setTimeout(() => {
      this.sleeveTimer = null;
      this.sleeveSub?.unsubscribe();
      this.sleeveArtistId = artistId;
      this.sleeveSub = this.api.getDeezerArtistAlbums(artistId).subscribe({
        next: (albums) => {
          if (this.current?.artistId === artistId) {
            this.sleeveAlbums = albums || [];
            this.trackImageIndex = 0;
            this.syncTrackSlide();
          }
        },
        error: () => {
          if (this.current?.artistId === artistId) {
            this.sleeveAlbums = [];
          }
        }
      });
    }, 320);
  }

  private refreshPreview(track: DeezerTrack, fresh: boolean): void {
    this.previewFresh = true;
    this.buffering = true;
    this.api.getDeezerTrack(track.id, fresh).pipe(takeUntil(this.destroy$)).subscribe({
      next: (freshTrack) => {
        if (this.current?.id !== track.id) {
          return;
        }
        const preview = (freshTrack?.previewUrl || '').trim();
        if (!preview) {
          this.buffering = false;
          this.playErrorKey = 'DEEZER.ERR_NO_PREVIEW';
          return;
        }
        this.current = { ...track, ...freshTrack, previewUrl: preview };
        this.startAudio(preview);
      },
      error: () => {
        this.buffering = false;
        this.playErrorKey = 'DEEZER.ERR_PLAY';
      }
    });
  }

  private startAudio(url: string): void {
    const audio = this.audioRef?.nativeElement;
    if (!audio) {
      this.playErrorKey = 'DEEZER.ERR_PLAY';
      return;
    }
    this.hushOthers(audio);
    audio.crossOrigin = 'anonymous';
    audio.volume = this.muted ? 0 : this.volume;
    audio.src = url;
    audio.play().then(() => {
      this.playing = true;
      this.playErrorKey = '';
      if (this.equalizer.wantsProcessing) {
        this.equalizer.engageMedia(audio);
      }
      this.syncTrackSlide();
    }).catch(() => {
      this.playing = false;
      this.playErrorKey = 'DEEZER.ERR_PLAY';
    });
  }

  private applyVolume(): void {
    const audio = this.audioRef?.nativeElement;
    if (audio) {
      audio.volume = this.muted ? 0 : this.volume;
    }
  }

  get eqActive(): boolean {
    return this.equalizer.wantsProcessing && !!this.current;
  }

  get sleeveVisible(): boolean {
    return this.sleeveOpen && this.trackImages.length > 0;
  }

  get trackImages(): { url: string; alt: string }[] {
    const images: { url: string; alt: string }[] = [];
    const push = (url?: string, alt?: string) => {
      const safe = (url || '').trim();
      if (!safe || images.some((image) => image.url === safe)) {
        return;
      }
      images.push({ url: safe, alt: alt || '' });
    };
    push(this.current?.coverUrl, this.current?.albumTitle || this.current?.title);
    for (const album of this.sleeveAlbums) {
      push(album.coverUrl, album.title);
    }
    return images;
  }

  get sortedRadioSkins(): DzSkin[] {
    const pinned = new Set<DzSkin>(this.illusionSkins);
    const lang = this.translate.currentLang || this.translate.defaultLang || 'fr';
    return DZ_SKINS.filter((skin) => !pinned.has(skin)).sort((a, b) =>
      this.translate.instant(this.skinNameKey(a)).localeCompare(
        this.translate.instant(this.skinNameKey(b)),
        lang,
        { sensitivity: 'base' }
      )
    );
  }

  get volumePercent(): number {
    return Math.round((this.muted ? 0 : this.volume) * 100);
  }

  get youtubeSearchQuery(): string {
    const artist = (this.current?.artistName || '').trim();
    const title = (this.current?.title || '').trim();
    return (artist && title ? artist + ' ' + title : artist || title).slice(0, 120);
  }

  skinNameKey(skin: DzSkin): string {
    return 'RADIO.SKIN_' + skin.toUpperCase();
  }

  skinDescKey(skin: DzSkin): string {
    return 'RADIO.SKIN_' + skin.toUpperCase() + '_DESC';
  }

  trackRadioSkin(_index: number, skin: DzSkin): string {
    return skin;
  }

  toggleSkinMenu(event: Event): void {
    event.stopPropagation();
    this.skinMenuOpen = !this.skinMenuOpen;
  }

  setRadioSkin(skin: DzSkin): void {
    this.radioSkin = skin;
    this.skinMenuOpen = false;
    try {
      localStorage.setItem(DeezerWatcherComponent.SKIN_KEY, skin);
    } catch {
      /* ignore */
    }
    if (this.keycloak.isLoggedIn()) {
      this.api.saveRadioSkin(skin).pipe(catchError(() => of(null)), takeUntil(this.destroy$)).subscribe();
    }
  }

  onVolumeSlider(percent: number): void {
    this.onVolume(Math.min(100, Math.max(0, Number(percent) || 0)) / 100);
  }

  openEqualizer(): void {
    const audio = this.audioRef?.nativeElement;
    if (audio) {
      audio.crossOrigin = 'anonymous';
      this.equalizer.attachMediaElement(audio);
    }
    this.eqModal?.open();
  }

  toggleMute(): void {
    const audio = this.audioRef?.nativeElement;
    if (audio && (audio.muted || this.muted || this.volume <= 0)) {
      this.muted = false;
      if (this.volume <= 0) {
        this.volume = 0.6;
      }
      if (audio) {
        audio.muted = false;
      }
    } else {
      this.muted = true;
      if (audio) {
        audio.muted = true;
      }
    }
    this.applyVolume();
  }

  toggleFocusMode(event?: Event): void {
    event?.stopPropagation();
    this.focusMode = !this.focusMode;
    document.body.classList.toggle('radio-focus', this.focusMode);
  }

  async toggleStageFullscreen(event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.stageFullscreen) {
      await this.exitStageFullscreen();
      return;
    }
    this.stageFullscreen = true;
    document.body.classList.add('radio-stage-fs');
    const host = this.hostRef.nativeElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      const req = host.requestFullscreen?.bind(host) || host.webkitRequestFullscreen?.bind(host);
      if (req) {
        await Promise.resolve(req());
      }
    } catch {
      /* the page still covers the viewport */
    }
  }

  async togglePictureInPicture(): Promise<void> {
    if (!this.current) {
      return;
    }
    const audio = this.audioRef?.nativeElement;
    if (!audio) {
      return;
    }
    if (isRadioDocPipOpen() || this.isPipActive) {
      closeRadioDocPip();
      stopRadioPipCarrier();
      this.isPipActive = false;
      return;
    }
    try {
      await enterRadioPictureInPicture(audio, {
        title: this.current.title || 'Deezer',
        trackTitle: this.current.title,
        artist: this.current.artistName,
        album: this.current.albumTitle,
        artworkUrl: this.current.coverUrl,
        faceEl: this.playerPanelEl?.nativeElement || null,
        labels: {
          fullscreen: this.translate.instant('RADIO.FULLSCREEN'),
          fullscreenExit: this.translate.instant('RADIO.FULLSCREEN_EXIT'),
          close: this.translate.instant('RADIO.PIP_EXIT')
        },
        onClose: () => {
          this.isPipActive = false;
          this.docked = false;
        }
      });
      this.isPipActive = true;
    } catch {
      this.playErrorKey = 'RADIO.ERR_PIP';
    }
  }

  toggleDock(): void {
    this.docked = !this.docked;
  }

  openOnYoutube(): void {
    const q = this.youtubeSearchQuery;
    if (!q) {
      return;
    }
    void this.router.navigate(['/tools/youtube'], { queryParams: { q } });
  }

  toggleShareMenu(event: Event): void {
    event.stopPropagation();
    this.shareMenuOpen = !this.shareMenuOpen;
  }

  async shareNative(): Promise<void> {
    const url = this.shareUrl();
    if (!url || !navigator.share) {
      return;
    }
    try {
      await navigator.share({ title: this.current?.title || 'Deezer', url });
      this.shareMenuOpen = false;
    } catch {
      /* cancelled */
    }
  }

  shareWhatsApp(): void {
    const url = this.shareUrl();
    if (!url) {
      return;
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(url), '_blank', 'noopener');
    this.shareMenuOpen = false;
  }

  async copyShareLink(): Promise<void> {
    const url = this.shareUrl();
    if (!url) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      this.shareFeedback = 'RADIO.SHARE_COPIED';
    } catch {
      this.shareFeedback = 'RADIO.SHARE_COPY_FAILED';
    }
    this.shareMenuOpen = false;
  }

  setKeepAlive(enabled: boolean): void {
    this.keepAliveOnNavigate = !!enabled;
    try {
      localStorage.setItem(DeezerWatcherComponent.KEEP_KEY, enabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  playPreset(slot: DeezerTrack | null, index: number, event?: Event): void {
    event?.stopPropagation();
    if (!slot) {
      if (this.current) {
        this.presets[index] = this.current;
        this.presets = this.presets.slice();
        this.writePresets();
      }
      return;
    }
    const queueIndex = this.queue.findIndex((track) => track.id === slot.id);
    this.playTrack(slot, queueIndex >= 0 ? queueIndex : 0);
  }

  shortPresetName(track: DeezerTrack): string {
    const name = (track.title || '').trim();
    return name.length > 10 ? name.slice(0, 9) + '…' : name;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (this.skinMenuOpen && !target?.closest?.('.radio-skin-picker')) {
      this.skinMenuOpen = false;
    }
    if (this.shareMenuOpen && !target?.closest?.('.radio-share-wrap')) {
      this.shareMenuOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.skinMenuOpen) {
      this.skinMenuOpen = false;
      return;
    }
    if (this.shareMenuOpen) {
      this.shareMenuOpen = false;
      return;
    }
    if (this.stageFullscreen) {
      void this.exitStageFullscreen();
      return;
    }
    if (this.focusMode) {
      this.focusMode = false;
      document.body.classList.remove('radio-focus');
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    const host = this.hostRef.nativeElement;
    if (document.fullscreenElement === host) {
      this.stageFullscreen = true;
      document.body.classList.add('radio-stage-fs');
    } else if (!document.fullscreenElement && this.stageFullscreen) {
      this.stageFullscreen = false;
      document.body.classList.remove('radio-stage-fs');
    }
  }

  private async exitStageFullscreen(): Promise<void> {
    if (document.fullscreenElement === this.hostRef.nativeElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* already left */
      }
    }
    this.stageFullscreen = false;
    document.body.classList.remove('radio-stage-fs');
  }

  private shareUrl(): string {
    return (this.current?.link || '').trim() || (typeof location !== 'undefined' ? location.href : '');
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
      if (this.trackImages.length < 2) {
        this.clearTrackSlide();
        return;
      }
      this.trackImageIndex = (this.trackImageIndex + 1) % this.trackImages.length;
    }, 8000);
  }

  private clearTrackSlide(): void {
    if (this.trackSlideTimer) {
      clearInterval(this.trackSlideTimer);
      this.trackSlideTimer = null;
    }
  }

  private readSkin(): DzSkin {
    try {
      const raw = localStorage.getItem(DeezerWatcherComponent.SKIN_KEY);
      return DZ_SKINS.includes(raw as DzSkin) ? raw as DzSkin : 'classic';
    } catch {
      return 'classic';
    }
  }

  private readKeepAlive(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.KEEP_KEY) === '1';
    } catch {
      return false;
    }
  }

  private readPresets(): (DeezerTrack | null)[] {
    const slots: (DeezerTrack | null)[] = [];
    try {
      const raw = JSON.parse(localStorage.getItem(DeezerWatcherComponent.PRESET_KEY) || '[]');
      if (Array.isArray(raw)) {
        for (let i = 0; i < DeezerWatcherComponent.PRESET_COUNT; i++) {
          const item = raw[i];
          slots.push(item && item.id ? item as DeezerTrack : null);
        }
        return slots;
      }
    } catch {
      /* ignore */
    }
    for (let i = 0; i < DeezerWatcherComponent.PRESET_COUNT; i++) {
      slots.push(null);
    }
    return slots;
  }

  private writePresets(): void {
    try {
      localStorage.setItem(DeezerWatcherComponent.PRESET_KEY, JSON.stringify(this.presets));
    } catch {
      /* ignore */
    }
  }

  private parkKeptAudio(): void {
    document.querySelectorAll('audio[data-pat-deezer-keep="1"]').forEach((node) => {
      if (node instanceof HTMLMediaElement) {
        node.pause();
      }
      node.remove();
    });
  }

  private hushOthers(mine: HTMLAudioElement): void {
    document.querySelectorAll('audio, video').forEach((node) => {
      if (node !== mine && node instanceof HTMLMediaElement && !node.paused) {
        node.pause();
      }
    });
  }

  private readVolume(): number {
    try {
      const raw = Number(localStorage.getItem(DeezerWatcherComponent.VOLUME_KEY));
      if (Number.isFinite(raw) && raw >= 0 && raw <= 1) {
        return raw;
      }
    } catch {
      /* ignore */
    }
    return 0.9;
  }

  private readSleeve(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.SLEEVE_KEY) !== '0';
    } catch {
      return true;
    }
  }
}
