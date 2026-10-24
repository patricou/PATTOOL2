import { Component, ElementRef, HostBinding, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged, takeUntil } from 'rxjs/operators';

import {
  ApiService,
  DeezerAlbum,
  DeezerArtist,
  DeezerGenre,
  DeezerPlaylist,
  DeezerSearchType,
  DeezerTrack
} from '../services/api.service';
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

type DzFavKind = 'track' | 'album' | 'artist' | 'playlist';

interface DzFav {
  kind: DzFavKind;
  track?: DeezerTrack;
  album?: DeezerAlbum;
  artist?: DeezerArtist;
  playlist?: DeezerPlaylist;
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
  @ViewChild('ytFrame') ytFrame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;
  @ViewChild('eqModal') eqModal?: YoutubeEqualizerModalComponent;

  @HostBinding('class.radio-focus') get focusClass(): boolean { return this.focusMode; }
  @HostBinding('class.radio-stage-fs') get stageFsClass(): boolean { return this.stageFullscreen; }
  @HostBinding('class.radio-skin--classic') get skinClassic(): boolean { return this.radioSkin === 'classic'; }
  @HostBinding('class.radio-skin--artdeco') get skinArtdeco(): boolean { return this.radioSkin === 'artdeco'; }
  @HostBinding('class.radio-skin--synthwave') get skinSynthwave(): boolean { return this.radioSkin === 'synthwave'; }
  @HostBinding('class.radio-skin--spaceage') get skinSpaceage(): boolean { return this.radioSkin === 'spaceage'; }
  @HostBinding('class.radio-skin--military') get skinMilitary(): boolean { return this.radioSkin === 'military'; }
  @HostBinding('class.radio-skin--steampunk') get skinSteampunk(): boolean { return this.radioSkin === 'steampunk'; }
  @HostBinding('class.radio-skin--aurora') get skinAurora(): boolean { return this.radioSkin === 'aurora'; }
  @HostBinding('class.radio-skin--noir') get skinNoir(): boolean { return this.radioSkin === 'noir'; }
  @HostBinding('class.radio-skin--bamboo') get skinBamboo(): boolean { return this.radioSkin === 'bamboo'; }
  @HostBinding('class.radio-skin--porcelain') get skinPorcelain(): boolean { return this.radioSkin === 'porcelain'; }
  @HostBinding('class.radio-skin--carbon') get skinCarbon(): boolean { return this.radioSkin === 'carbon'; }
  @HostBinding('class.radio-skin--candy') get skinCandy(): boolean { return this.radioSkin === 'candy'; }
  @HostBinding('class.radio-skin--espace') get skinEspace(): boolean { return this.radioSkin === 'espace'; }
  @HostBinding('class.radio-skin--kanizsa') get skinKanizsa(): boolean { return this.radioSkin === 'kanizsa'; }
  @HostBinding('class.radio-skin--cafewall') get skinCafewall(): boolean { return this.radioSkin === 'cafewall'; }
  @HostBinding('class.radio-skin--penrose') get skinPenrose(): boolean { return this.radioSkin === 'penrose'; }
  @HostBinding('class.radio-skin--scintille') get skinScintille(): boolean { return this.radioSkin === 'scintille'; }
  @HostBinding('class.radio-skin--barber') get skinBarber(): boolean { return this.radioSkin === 'barber'; }

  genres: DeezerGenre[] = [];
  genreId = 0;
  genresOpen = true;
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
  chromeVisible = false;
  shareFeedback = '';
  keepAliveOnNavigate = false;
  docked = false;
  isPipActive = false;
  trackImageIndex = 0;
  presets: (DeezerTrack | null)[] = [];
  sidebarCollapsed = false;
  filterOpen = false;
  hideExplicit = false;
  previewOnly = false;
  listMode: 'browse' | 'favorites' = 'browse';
  favorites: DzFav[] = [];
  youtubeMode = false;
  youtubeSearchEnabled = false;
  youtubeBusy = false;
  youtubeEmbed: SafeResourceUrl | null = null;
  youtubeTitle = '';
  ytLinks: Record<number, string> = {};
  ytFromCache: Record<number, boolean> = {};
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
  private ytSub: Subscription | null = null;
  private ytPrefetch: Subscription | null = null;
  private ytScan: Subscription | null = null;
  private ytScanKey = '';
  private pointerOverPlayer = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private ytToken = 0;
  private ytIgnoreEnd = 0;
  private ytReplay = 0;
  private repeatQueue = false;
  private readonly ytCache = new Map<number, string | null>();
  private readonly search$ = new Subject<string>();
  private readonly destroy$ = new Subject<void>();
  private static readonly SIDEBAR_KEY = 'pattool.deezer.sidebar';
  private static readonly YT_SEARCH_KEY = 'pattool.deezer.youtube-search';
  private static readonly FILTER_KEY = 'pattool.deezer.filter';
  private static readonly GENRES_KEY = 'pattool.deezer.genres';
  private static readonly FAV_KEY = 'pattool.deezer.favorites';
  private static readonly CHROME_HIDE_MS = 4000;
  readonly illusionSkins: readonly DzSkin[] = ['kanizsa', 'cafewall', 'penrose', 'scintille', 'barber'];
  readonly pipSupported = supportsRadioPictureInPicture();
  readonly canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  constructor(
    private api: ApiService,
    private hostRef: ElementRef<HTMLElement>,
    private equalizer: YoutubeEqualizerService,
    private router: Router,
    private translate: TranslateService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.volume = this.readVolume();
    this.sleeveOpen = this.readSleeve();
    this.radioSkin = this.readSkin();
    this.keepAliveOnNavigate = this.readKeepAlive();
    this.presets = this.readPresets();
    this.sidebarCollapsed = this.readSidebar();
    this.readFilter();
    this.genresOpen = this.readGenresOpen();
    this.favorites = this.readFavorites();
    this.youtubeSearchEnabled = this.readYoutubeSearch();
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
    this.clearChromeHideTimer();
    this.ytSub?.unsubscribe();
    this.ytPrefetch?.unsubscribe();
    this.ytScan?.unsubscribe();
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

  get selectedGenreName(): string {
    if (!this.genreId) {
      return '';
    }
    return this.genres.find((genre) => genre.id === this.genreId)?.name || '';
  }

  get searching(): boolean {
    return this.query.trim().length >= 2 && !this.drilled;
  }

  get atStart(): boolean {
    return this.currentIndex() < 1;
  }

  get atEnd(): boolean {
    const index = this.currentIndex();
    if (this.repeatQueue && this.queue.length > 0) {
      return index < 0;
    }
    return index < 0 || index >= this.queue.length - 1;
  }

  get hasActiveFilter(): boolean {
    return this.hideExplicit || this.previewOnly;
  }

  get shownTracks(): DeezerTrack[] {
    const source = this.listMode === 'favorites' && !this.drilled ? this.favoriteTracks : this.tracks;
    return source.filter((track) => this.passTrack(track) && this.matchesFavoriteQuery(this.trackHay(track)));
  }

  get shownAlbums(): DeezerAlbum[] {
    const source = this.listMode === 'favorites' && !this.drilled ? this.favoriteAlbums : this.albums;
    return source.filter((album) => this.matchesFavoriteQuery(`${album.title} ${album.artistName}`));
  }

  get shownArtists(): DeezerArtist[] {
    const source = this.listMode === 'favorites' && !this.drilled ? this.favoriteArtists : this.artists;
    return source.filter((artist) => this.matchesFavoriteQuery(artist.name));
  }

  get shownPlaylists(): DeezerPlaylist[] {
    const source = this.listMode === 'favorites' && !this.drilled ? this.favoritePlaylists : this.playlists;
    return source.filter((playlist) => this.matchesFavoriteQuery(`${playlist.title} ${playlist.userName}`));
  }

  get favoriteTracks(): DeezerTrack[] {
    return this.favorites.filter((fav) => fav.kind === 'track' && fav.track).map((fav) => fav.track!);
  }

  get favoriteAlbums(): DeezerAlbum[] {
    return this.favorites.filter((fav) => fav.kind === 'album' && fav.album).map((fav) => fav.album!);
  }

  get favoriteArtists(): DeezerArtist[] {
    return this.favorites.filter((fav) => fav.kind === 'artist' && fav.artist).map((fav) => fav.artist!);
  }

  get favoritePlaylists(): DeezerPlaylist[] {
    return this.favorites.filter((fav) => fav.kind === 'playlist' && fav.playlist).map((fav) => fav.playlist!);
  }

  get favoriteCount(): number {
    return this.favorites.length;
  }

  onQueryChange(value: string): void {
    this.query = value;
    this.search$.next(value.trim());
  }

  clearQuery(): void {
    this.query = '';
    this.search$.next('');
  }

  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    try {
      localStorage.setItem(DeezerWatcherComponent.SIDEBAR_KEY, this.sidebarCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  toggleFilterPanel(event?: Event): void {
    event?.stopPropagation();
    this.filterOpen = !this.filterOpen;
  }

  setHideExplicit(enabled: boolean): void {
    this.hideExplicit = !!enabled;
    this.writeFilter();
    this.refreshQueue();
    this.syncYoutubeButtons();
  }

  setYoutubeSearch(enabled: boolean): void {
    this.youtubeSearchEnabled = !!enabled;
    try {
      localStorage.setItem(DeezerWatcherComponent.YT_SEARCH_KEY, this.youtubeSearchEnabled ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.ytScan?.unsubscribe();
    this.ytScanKey = '';
    this.syncYoutubeButtons();
  }

  setPreviewOnly(enabled: boolean): void {
    this.previewOnly = !!enabled;
    this.writeFilter();
    this.refreshQueue();
    this.syncYoutubeButtons();
  }

  setListMode(mode: 'browse' | 'favorites'): void {
    if (this.listMode === mode) {
      return;
    }
    this.listMode = mode;
    this.exitDrill();
    if (mode === 'favorites') {
      this.loading = false;
      this.errorKey = '';
      this.refreshQueue();
      this.ytScanKey = '';
      this.syncYoutubeButtons();
      return;
    }
    const q = this.query.trim();
    if (q.length >= 2) {
      this.loadSearch(q);
    } else {
      this.loadChart();
    }
  }

  playAll(): void {
    const tracks = this.shownTracks;
    const first = tracks[0];
    if (!first) {
      return;
    }
    this.youtubeMode = false;
    this.clearYoutube();
    this.repeatQueue = true;
    this.queue = tracks;
    this.current = null;
    this.playTrack(first, 0);
  }

  playYoutubeTrack(track: DeezerTrack, index: number, event?: Event): void {
    event?.stopPropagation();
    if (!this.ytLinks[track.id]) {
      return;
    }
    this.youtubeMode = true;
    this.repeatQueue = false;
    this.queue = this.shownTracks;
    if (this.current?.id === track.id && this.youtubeEmbed) {
      return;
    }
    this.current = null;
    this.playTrack(track, index);
  }

  playAllOnYoutube(): void {
    const tracks = this.shownTracks;
    const first = tracks[0];
    if (!first) {
      return;
    }
    this.youtubeMode = true;
    this.clearYoutube();
    this.repeatQueue = true;
    this.queue = tracks;
    this.current = null;
    this.playTrack(first, 0);
  }

  isFavorite(kind: DzFavKind, id: number | null | undefined): boolean {
    return !!id && this.favorites.some((fav) => fav.kind === kind && this.favId(fav) === id);
  }

  toggleTrackFavorite(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    this.toggleFavorite({ kind: 'track', track });
  }

  toggleAlbumFavorite(album: DeezerAlbum, event?: Event): void {
    event?.stopPropagation();
    this.toggleFavorite({ kind: 'album', album });
  }

  toggleArtistFavorite(artist: DeezerArtist, event?: Event): void {
    event?.stopPropagation();
    this.toggleFavorite({ kind: 'artist', artist });
  }

  togglePlaylistFavorite(playlist: DeezerPlaylist, event?: Event): void {
    event?.stopPropagation();
    this.toggleFavorite({ kind: 'playlist', playlist });
  }

  selectGenre(id: number): void {
    this.genreId = id;
    this.query = '';
    this.exitDrill();
    this.loadChart();
  }

  toggleGenres(): void {
    this.genresOpen = !this.genresOpen;
    try {
      localStorage.setItem(DeezerWatcherComponent.GENRES_KEY, this.genresOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  setView(view: DeezerSearchType): void {
    if (this.drilled) {
      return;
    }
    this.view = view;
    if (this.listMode === 'favorites') {
      this.refreshQueue();
      this.syncYoutubeButtons();
      return;
    }
    if (this.query.trim().length >= 2) {
      this.loadSearch(this.query.trim());
      return;
    }
    if (view === 'track') {
      this.queue = this.shownTracks;
      this.syncYoutubeButtons();
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
    this.syncYoutubeButtons();
    this.albums = saved.albums;
    this.artists = saved.artists;
    this.playlists = saved.playlists;
    this.queue = saved.view === 'track' ? this.shownTracks : [];
  }

  playListedTrack(track: DeezerTrack, index: number): void {
    this.repeatQueue = false;
    this.playTrack(track, index);
  }

  playTrack(track: DeezerTrack, index: number, restart = false): void {
    const same = this.current?.id === track.id;
    if (!restart && same) {
      this.togglePlay();
      return;
    }
    this.ytReplay = restart && same ? Date.now() : 0;
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
    this.chromeVisible = this.pointerOverPlayer || this.focusMode || this.stageFullscreen;
    if (this.youtubeMode) {
      this.pausePreview();
      if (restart && same) {
        this.youtubeEmbed = null;
        this.youtubeTitle = '';
      }
      this.resolveYoutube(track);
      return;
    }
    this.clearYoutube();
    this.playPreview(track);
  }

  togglePlay(): void {
    if (this.youtubeEmbed) {
      this.postYoutube(this.playing ? 'pauseVideo' : 'playVideo');
      this.playing = !this.playing;
      return;
    }
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
      return;
    }
    if (this.repeatQueue && this.queue.length > 0) {
      this.playTrack(this.queue[0], 0, true);
    }
  }

  stop(): void {
    this.youtubeMode = false;
    this.repeatQueue = false;
    this.clearYoutube();
    const audio = this.audioRef?.nativeElement;
    if (!audio) {
      this.currentTime = 0;
      this.playing = false;
      return;
    }
    audio.pause();
    audio.currentTime = 0;
    this.currentTime = 0;
    this.playing = false;
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
    this.syncYoutubeButtons();
        this.queue = this.shownTracks;
        if (this.queue.length) {
          this.playTrack(this.queue[0], 0);
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
    this.syncYoutubeButtons();
        this.queue = this.shownTracks;
        this.sleeveAlbums = page?.albums || [];
        this.sleeveArtistId = artist.id;
        this.related = page?.related || [];
        if (this.queue.length) {
          this.playTrack(this.queue[0], 0);
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
    this.syncYoutubeButtons();
        this.queue = this.shownTracks;
        if (this.queue.length) {
          this.playTrack(this.queue[0], 0);
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
    if (this.listMode === 'favorites') {
      return;
    }
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
        this.syncYoutubeButtons();
        this.albums = chart?.albums || [];
        this.artists = chart?.artists || [];
        this.playlists = chart?.playlists || [];
        if (!this.drilled && this.view === 'track' && this.listMode === 'browse') {
          this.queue = this.shownTracks;
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
        this.syncYoutubeButtons();
        this.albums = page?.albums || [];
        this.artists = page?.artists || [];
        this.playlists = page?.playlists || [];
        this.queue = this.view === 'track' ? this.shownTracks : [];
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
    if (audio.ended || audio.currentTime > 0) {
      try {
        audio.currentTime = 0;
      } catch {
        /* the new source is not seekable yet */
      }
    }
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
  }

  openEqualizer(): void {
    const audio = this.audioRef?.nativeElement;
    if (audio) {
      audio.crossOrigin = 'anonymous';
      this.equalizer.attachMediaElement(audio);
    }
    this.eqModal?.open();
  }

  toggleFocusMode(event?: Event): void {
    event?.stopPropagation();
    this.focusMode = !this.focusMode;
    document.body.classList.toggle('radio-focus', this.focusMode);
    this.chromeVisible = this.focusMode || this.pointerOverPlayer || this.stageFullscreen;
  }

  async toggleStageFullscreen(event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.stageFullscreen) {
      await this.exitStageFullscreen();
      return;
    }
    this.stageFullscreen = true;
    this.chromeVisible = true;
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
    this.repeatQueue = false;
    this.playTrack(slot, queueIndex >= 0 ? queueIndex : 0);
  }

  shortPresetName(track: DeezerTrack): string {
    const name = (track.title || '').trim();
    return name.length > 10 ? name.slice(0, 9) + '…' : name;
  }

  @HostListener('window:message', ['$event'])
  onYoutubeMessage(event: MessageEvent): void {
    if (!this.youtubeEmbed) {
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
    const payload = data as { event?: string; info?: number | Record<string, unknown> };
    let state: number | undefined;
    if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
      state = payload.info;
    } else if (payload.info && typeof payload.info === 'object' && typeof payload.info['playerState'] === 'number') {
      state = payload.info['playerState'] as number;
    }
    if (state === 1) {
      this.playing = true;
      this.youtubeBusy = false;
    } else if (state === 2) {
      this.playing = false;
    } else if (state === 0 && Date.now() >= this.ytIgnoreEnd && this.youtubeMode) {
      this.next();
    }
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

  onPlayerPointerEnter(): void {
    this.pointerOverPlayer = true;
    this.clearChromeHideTimer();
    this.chromeVisible = true;
  }

  onPlayerPointerMove(): void {
    this.onPlayerPointerEnter();
  }

  onPlayerPointerLeave(): void {
    this.pointerOverPlayer = false;
    this.clearChromeHideTimer();
    if (this.focusMode || this.stageFullscreen) {
      return;
    }
    this.shareMenuOpen = false;
    this.chromeVisible = false;
  }

  onPlayerTouch(): void {
    this.pointerOverPlayer = false;
    this.chromeVisible = true;
    this.scheduleChromeHide();
  }

  private scheduleChromeHide(): void {
    this.clearChromeHideTimer();
    if (this.shareMenuOpen || this.focusMode || this.stageFullscreen || this.pointerOverPlayer) {
      return;
    }
    this.chromeHideTimer = setTimeout(() => {
      this.chromeHideTimer = null;
      if (this.shareMenuOpen || this.focusMode || this.stageFullscreen || this.pointerOverPlayer) {
        return;
      }
      this.chromeVisible = false;
    }, DeezerWatcherComponent.CHROME_HIDE_MS);
  }

  private clearChromeHideTimer(): void {
    if (this.chromeHideTimer != null) {
      clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
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
      this.chromeVisible = true;
      document.body.classList.add('radio-stage-fs');
    } else if (!document.fullscreenElement && this.stageFullscreen) {
      this.stageFullscreen = false;
      document.body.classList.remove('radio-stage-fs');
      this.chromeVisible = this.pointerOverPlayer || this.focusMode;
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
    this.chromeVisible = this.pointerOverPlayer || this.focusMode;
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

  private playPreview(track: DeezerTrack): void {
    const preview = (track.previewUrl || '').trim();
    if (!preview) {
      this.refreshPreview(track, true);
      return;
    }
    this.startAudio(preview);
  }

  private pausePreview(): void {
    const audio = this.audioRef?.nativeElement;
    if (!audio) {
      return;
    }
    audio.pause();
  }

  private clearYoutube(): void {
    this.ytToken++;
    this.ytSub?.unsubscribe();
    this.ytSub = null;
    this.youtubeEmbed = null;
    this.youtubeTitle = '';
    this.youtubeBusy = false;
  }

  private resolveYoutube(track: DeezerTrack): void {
    const token = ++this.ytToken;
    const cached = this.ytCache.get(track.id);
    if (cached !== undefined) {
      this.applyYoutubeHit(track, cached, token);
      return;
    }
    const q = this.youtubeQuery(track);
    if (q.length < 2) {
      this.playPreview(track);
      return;
    }
    this.youtubeBusy = true;
    this.youtubeEmbed = null;
    this.ytSub?.unsubscribe();
    this.ytSub = this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: track.artistName || '',
      title: track.title || ''
    }], this.youtubeSearchEnabled).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (token !== this.ytToken) {
          return;
        }
        const link = (page?.links || []).find((item) => item.id === track.id);
        this.youtubeBusy = false;
        if (!link) {
          this.playPreview(track);
          return;
        }
        const id = (link.videoId || '').trim() || null;
        this.rememberYoutube(track.id, id, !!link.cached);
        this.applyYoutubeHit(track, id, token);
        this.prefetchNextYoutube();
      },
      error: () => {
        if (token !== this.ytToken) {
          return;
        }
        this.youtubeBusy = false;
        this.playPreview(track);
      }
    });
  }

  private applyYoutubeHit(track: DeezerTrack, id: string | null, token: number): void {
    if (token !== this.ytToken || this.current?.id !== track.id) {
      return;
    }
    if (!id) {
      this.youtubeEmbed = null;
      this.playPreview(track);
      this.prefetchNextYoutube();
      return;
    }
    this.pausePreview();
    this.youtubeTitle = `${track.artistName || ''} — ${track.title || ''}`.trim();
    this.ytIgnoreEnd = Date.now() + 1500;
    const origin = typeof window !== 'undefined' ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}` : '';
    const replay = this.ytReplay ? `&ts=${this.ytReplay}` : '';
    this.youtubeEmbed = this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1&playsinline=1${origin}${replay}`
    );
    this.playing = true;
    this.playErrorKey = '';
  }

  private prefetchNextYoutube(): void {
    if (!this.youtubeMode) {
      return;
    }
    const idx = this.currentIndex();
    const next = idx >= 0 ? this.queue[idx + 1] : undefined;
    if (!next || this.ytCache.has(next.id)) {
      return;
    }
    const q = this.youtubeQuery(next);
    if (q.length < 2) {
      return;
    }
    this.ytPrefetch?.unsubscribe();
    this.ytPrefetch = this.api.resolveDeezerYoutubeLinks([{
      id: next.id,
      artist: next.artistName || '',
      title: next.title || ''
    }], this.youtubeSearchEnabled).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        const link = (page?.links || []).find((item) => item.id === next.id);
        if (link) {
          this.rememberYoutube(next.id, (link.videoId || '').trim() || null, !!link.cached);
        }
      },
      error: () => { /* the track will be searched again when it starts */ }
    });
  }

  private rememberYoutube(id: number, videoId: string | null, fromCache = false): void {
    this.ytCache.set(id, videoId);
    if (fromCache && videoId) {
      this.ytFromCache = { ...this.ytFromCache, [id]: true };
    }
    if (!videoId) {
      return;
    }
    this.ytLinks = { ...this.ytLinks, [id]: videoId };
  }

  private syncYoutubeButtons(): void {
    if (this.view !== 'track' && !this.drilled) {
      return;
    }
    const shown = this.shownTracks.filter((track) => track.id && this.youtubeQuery(track).length >= 2);
    const key = `${this.youtubeSearchEnabled ? '1' : '0'}:${shown.map((track) => track.id).join(',')}`;
    if (key === this.ytScanKey) {
      return;
    }
    this.ytScanKey = key;
    this.ytScan?.unsubscribe();
    const pending = shown.filter((track) => !this.ytCache.has(track.id));
    this.scanYoutube(pending, 0, key);
  }

  private scanYoutube(tracks: DeezerTrack[], index: number, key: string): void {
    if (key !== this.ytScanKey || index >= tracks.length) {
      return;
    }
    const slice = tracks.slice(index, index + 20);
    this.ytScan = this.api.resolveDeezerYoutubeLinks(slice.map((track) => ({
      id: track.id,
      artist: track.artistName || '',
      title: track.title || ''
    })), this.youtubeSearchEnabled).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (key !== this.ytScanKey) {
          return;
        }
        this.applyYoutubeLinks(page?.links || []);
        this.scanYoutube(tracks, index + slice.length, key);
      },
      error: () => {
        if (key === this.ytScanKey) {
          this.ytScanKey = '';
        }
      }
    });
  }

  private applyYoutubeLinks(links: { id: number; videoId?: string; cached?: boolean }[]): void {
    for (const link of links) {
      this.rememberYoutube(link.id, (link.videoId || '').trim() || null, !!link.cached);
    }
  }

  private youtubeQuery(track: DeezerTrack): string {
    return `${track.artistName || ''} ${track.title || ''}`.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  private postYoutube(func: 'playVideo' | 'pauseVideo'): void {
    const frame = this.ytFrame?.nativeElement?.contentWindow;
    if (!frame) {
      return;
    }
    frame.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
  }

  private readSleeve(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.SLEEVE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  private refreshQueue(): void {
    if (this.drilled || this.view === 'track') {
      this.queue = this.shownTracks;
    }
  }

  private passTrack(track: DeezerTrack): boolean {
    if (this.hideExplicit && track.explicit) {
      return false;
    }
    if (this.previewOnly && !(track.previewUrl || '').trim()) {
      return false;
    }
    return true;
  }

  private matchesFavoriteQuery(text: string): boolean {
    if (this.listMode !== 'favorites') {
      return true;
    }
    const q = this.query.trim().toLowerCase();
    return !q || (text || '').toLowerCase().includes(q);
  }

  private trackHay(track: DeezerTrack): string {
    return `${track.title || ''} ${track.artistName || ''} ${track.albumTitle || ''}`;
  }

  private favId(fav: DzFav): number {
    if (fav.kind === 'track') return fav.track?.id || 0;
    if (fav.kind === 'album') return fav.album?.id || 0;
    if (fav.kind === 'artist') return fav.artist?.id || 0;
    return fav.playlist?.id || 0;
  }

  private toggleFavorite(next: DzFav): void {
    const id = this.favId(next);
    if (!id) {
      return;
    }
    const index = this.favorites.findIndex((fav) => fav.kind === next.kind && this.favId(fav) === id);
    if (index >= 0) {
      this.favorites = this.favorites.filter((_, i) => i !== index);
    } else {
      this.favorites = [next, ...this.favorites];
    }
    this.writeFavorites();
    this.ytScanKey = '';
    this.syncYoutubeButtons();
    if (this.listMode === 'favorites') {
      this.refreshQueue();
    }
  }

  private readYoutubeSearch(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.YT_SEARCH_KEY) === '1';
    } catch {
      return false;
    }
  }

  private readSidebar(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  }

  private readGenresOpen(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.GENRES_KEY) !== '0';
    } catch {
      return true;
    }
  }

  private readFilter(): void {
    try {
      const raw = JSON.parse(localStorage.getItem(DeezerWatcherComponent.FILTER_KEY) || '{}');
      this.hideExplicit = !!raw.hideExplicit;
      this.previewOnly = !!raw.previewOnly;
    } catch {
      this.hideExplicit = false;
      this.previewOnly = false;
    }
  }

  private writeFilter(): void {
    try {
      localStorage.setItem(DeezerWatcherComponent.FILTER_KEY, JSON.stringify({
        hideExplicit: this.hideExplicit,
        previewOnly: this.previewOnly
      }));
    } catch {
      /* ignore */
    }
  }

  private readFavorites(): DzFav[] {
    try {
      const raw = JSON.parse(localStorage.getItem(DeezerWatcherComponent.FAV_KEY) || '[]');
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw.filter((fav) => fav && fav.kind && this.favId(fav) > 0);
    } catch {
      return [];
    }
  }

  private writeFavorites(): void {
    try {
      localStorage.setItem(DeezerWatcherComponent.FAV_KEY, JSON.stringify(this.favorites));
    } catch {
      /* ignore */
    }
  }
}
