import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostBinding, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { of, Subject, Subscription } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs/operators';

import {
  ApiService,
  DeezerAlbum,
  DeezerArtist,
  DeezerFavorite,
  DeezerGenre,
  DeezerPlaylist,
  DeezerSearchType,
  DeezerTrack,
  DeezerUserPlaylist
} from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { YoutubeEqualizerService } from '../services/youtube-equalizer.service';
import { YoutubeEqualizerModalComponent } from '../youtube-watcher/youtube-equalizer-modal.component';
import {
  claimRadioTune,
  closeRadioDocPip,
  enterRadioPictureInPicture,
  isRadioDocPipOpen,
  stopRadioPipCarrier,
  supportsRadioPictureInPicture
} from '../radio-watcher/radio-pip.util';
import { readMediaSkin, writeMediaSkin } from '../services/media-skin';
import { activeScreenKeepAliveOwner, screenIsOff, setScreenKeepAlive } from '../services/media-screen-keepalive';
import { DeezerKeepAliveService } from './deezer-keep-alive.service';

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

type DzFav = DeezerFavorite;

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
export class DeezerWatcherComponent implements OnInit, AfterViewInit, OnDestroy {
  private static readonly VOLUME_KEY = 'pattool.deezer.volume';
  private static readonly SLEEVE_KEY = 'pattool.deezer.sleeve';
  private static readonly SKIN_KEY = 'pattool.deezer.skin';
  private static readonly PRESET_KEY = 'pattool.deezer.presets';
  private static readonly KEEP_KEY = 'pattool.deezer.keep-alive';
  private static readonly PRESET_COUNT = 12;

  @ViewChild('audio') audioRef?: ElementRef<HTMLAudioElement>;
  @ViewChild('ytFrame') ytFrame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('keptYtHost') keptYtHost?: ElementRef<HTMLElement>;
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;
  @ViewChild('eqModal') eqModal?: YoutubeEqualizerModalComponent;

  @HostBinding('class.radio-focus') get focusClass(): boolean { return this.focusMode; }
  @HostBinding('class.radio-stage-fs') get stageFsClass(): boolean { return this.stageFullscreen; }
  /** Phone turned sideways: only the cover or the video fills the display. */
  @HostBinding('class.radio-landscape-fs') landscapeFullscreen = false;
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
  genresOpen = false;
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
  /** False after Classement / Favoris / Playlists: the next Lecture starts that tab. */
  private playbackFollowsList = true;
  /** Tab that started the list now heard. Other tabs keep their own Lecture button. */
  private playbackListMode: 'browse' | 'favorites' | 'playlists' | null = null;
  private playPendingList = false;
  sleeveAlbums: DeezerAlbum[] = [];
  related: DeezerArtist[] = [];

  current: DeezerTrack | null = null;
  playing = false;
  buffering = false;
  muted = false;
  volume = 0.9;
  currentTime = 0;
  /** Last position reported by the YouTube player, so leaving the page does not jump back to 0. */
  private youtubeSeconds = 0;
  private youtubeClock?: ReturnType<typeof setInterval>;
  private adoptedAudio: HTMLAudioElement | null = null;
  audioDuration = 0;
  sleeveOpen = true;
  radioSkin: DzSkin = 'classic';
  skinMenuOpen = false;
  private skinChosenThisVisit = false;
  private skinLoadSub?: Subscription;
  private skinSaveSub?: Subscription;
  focusMode = false;
  stageFullscreen = false;
  shareMenuOpen = false;
  chromeVisible = false;
  shareFeedback = '';
  keepAliveOnNavigate = false;
  /** Android playback service stays up for the whole queue, including between tracks. */
  private screenHold = false;
  /** Pause or stop asked by the listener, not by the screen turning off. */
  private userHold = false;
  private audioSessionClaimed = false;
  private sleepKickTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onScreenPower = (): void => this.keepPlayingThroughSleep();
  private readonly onBluetoothTune = (event: Event): void => this.onLockScreenTune(event);
  docked = false;
  isPipActive = false;
  trackImageIndex = 0;
  presets: (DeezerTrack | null)[] = [];
  sidebarCollapsed = false;
  filterOpen = false;
  hideExplicit = false;
  previewOnly = false;
  listMode: 'browse' | 'favorites' | 'playlists' = 'browse';
  /** Album tracks, or the playing artist's albums, opened from any tab without taking over playback. */
  nowBrowse: 'album' | 'artist-albums' | null = null;
  nowBrowseTitle = '';
  nowBrowseSubtitle = '';
  nowBrowseTracks: DeezerTrack[] = [];
  nowBrowseAlbums: DeezerAlbum[] = [];
  albumSort: 'year' | 'name' | 'tracks' = 'year';
  albumSortDesc = true;
  albumSortOpen = false;
  readonly albumSortOptions: ReadonlyArray<{ id: 'year' | 'name' | 'tracks'; key: string }> = [
    { id: 'year', key: 'DEEZER.ALBUM_BY_YEAR' },
    { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
    { id: 'tracks', key: 'DEEZER.ALBUM_BY_TRACKS' }
  ];
  private nowBrowseFrom: 'artist-albums' | null = null;
  private nowArtistName = '';
  favorites: DzFav[] = [];
  favoritesHint = '';
  favoritesError = '';
  favoriteBusyKey = '';
  userPlaylists: DeezerUserPlaylist[] = [];
  activeUserPlaylist: DeezerUserPlaylist | null = null;
  playlistNameDraft = '';
  renameDraft = '';
  renamingPlaylistId = '';
  confirmDeletePlaylistId = '';
  playlistMenuTrack: DeezerTrack | null = null;
  playlistPickerQuery = '';
  similarOpen = false;
  similarLoading = false;
  similarError = '';
  similarName = '';
  similarArtists: DeezerArtist[] = [];
  similarSort: 'relevance' | 'name' | 'fans' = 'relevance';
  similarSortDesc = false;
  similarSortOpen = false;
  readonly similarSortOptions: ReadonlyArray<{ id: 'relevance' | 'name' | 'fans'; key: string }> = [
    { id: 'relevance', key: 'DEEZER.SIMILAR_BY_RELEVANCE' },
    { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
    { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' }
  ];
  playlistsHint = '';
  playlistsError = '';
  playlistBusy = '';
  youtubeMode = false;
  youtubeSearchEnabled = false;
  youtubeBusy = false;
  youtubeEmbed: SafeResourceUrl | null = null;
  youtubeTitle = '';
  ytLinks: Record<number, string> = {};
  ytFromCache: Record<number, boolean> = {};
  ytMiss: Record<number, boolean> = {};
  ytPending: Record<number, boolean> = {};
  loading = false;
  errorKey = '';
  playErrorKey = '';

  private shelf: DzShelf | null = null;
  private sleeveArtistId = 0;
  private queueIndexHint = -1;
  /** True once a background session was put back on this visit, so the chart load does not replace it. */
  private resumedKeep = false;
  keptFrameActive = false;
  private keptFrame: HTMLIFrameElement | null = null;
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
  /** Video just took the stage under the cursor: stay hidden until the pointer leaves and comes back. */
  private suppressChromeUntilLeave = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private ytToken = 0;
  private ytIgnoreEnd = 0;
  private ytReplay = 0;
  private ytHandshakeTimer: ReturnType<typeof setInterval> | null = null;
  private ytHandshakeTries = 0;
  private ytApiListening = false;
  private ytSoundArmed = false;
  private repeatQueue = false;
  private readonly ytCache = new Map<number, string | null>();
  private readonly search$ = new Subject<string>();
  private readonly destroy$ = new Subject<void>();
  private favoritesSub?: Subscription;
  private favoritesReady = false;
  private playlistsSub?: Subscription;
  private similarSub?: Subscription;
  private similarForId = 0;
  private readonly similarCache = new Map<number, DeezerArtist[]>();
  private playlistsReady = false;
  private static readonly SIDEBAR_KEY = 'pattool.deezer.sidebar';
  private static readonly YT_SEARCH_KEY = 'pattool.deezer.youtube-search';
  private static readonly FILTER_KEY = 'pattool.deezer.filter';
  private static readonly GENRES_KEY = 'pattool.deezer.genres';
  private static readonly FAV_KEY = 'pattool.deezer.favorites';
  private static readonly CHROME_HIDE_MS = 4000;
  private static readonly CHROME_IDLE_MS = 1200;
  private static readonly LANDSCAPE_FS_BODY_CLASS = 'radio-landscape-fs';
  private landscapeOrientationMql: MediaQueryList | null = null;
  private landscapeFsUserDismissed = false;
  /** User asked for the cover or video on a phone, including in portrait. */
  private mediaFsPinned = false;
  private readonly onLandscapeOrientationMedia = (): void => {
    this.syncLandscapeFullscreen();
    this.cdr.detectChanges();
  };
  readonly illusionSkins: readonly DzSkin[] = ['kanizsa', 'cafewall', 'penrose', 'scintille', 'barber'];
  readonly pipSupported = supportsRadioPictureInPicture();
  readonly canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  constructor(
    private api: ApiService,
    private hostRef: ElementRef<HTMLElement>,
    private equalizer: YoutubeEqualizerService,
    private router: Router,
    private translate: TranslateService,
    private sanitizer: DomSanitizer,
    private keycloak: KeycloakService,
    private cdr: ChangeDetectorRef,
    private keepAlive: DeezerKeepAliveService
  ) {}

  ngOnInit(): void {
    this.volume = this.readVolume();
    this.sleeveOpen = this.readSleeve();
    this.restoreSkinPreference();
    this.keepAliveOnNavigate = this.readKeepAlive();
    this.presets = this.readPresets();
    this.sidebarCollapsed = this.readSidebar();
    this.readFilter();
    this.genresOpen = false;
    try {
      localStorage.setItem(DeezerWatcherComponent.GENRES_KEY, '0');
    } catch {
      /* ignore */
    }
    this.youtubeSearchEnabled = this.readYoutubeSearch();
    this.loadFavorites();
    this.loadUserPlaylists();
    this.search$.pipe(
      debounceTime(320),
      distinctUntilChanged(),
      takeUntil(this.destroy$)
    ).subscribe((q) => this.runQuery(q));
    this.loadGenres();
    this.loadChart();
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();
    window.addEventListener('patradioscreen', this.onScreenPower);
    window.addEventListener('patradiotransport', this.onBluetoothTune);
    document.addEventListener('visibilitychange', this.onScreenPower);
  }

  ngAfterViewInit(): void {
    this.resumeKeptPlayback();
  }

  ngOnDestroy(): void {
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    window.removeEventListener('patradioscreen', this.onScreenPower);
    window.removeEventListener('patradiotransport', this.onBluetoothTune);
    document.removeEventListener('visibilitychange', this.onScreenPower);
    this.clearSleepKick();
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
    this.favoritesSub?.unsubscribe();
    this.playlistsSub?.unsubscribe();
    this.similarSub?.unsubscribe();
    this.skinLoadSub?.unsubscribe();
    this.skinSaveSub?.unsubscribe();
    this.stopYoutubeClock();
    this.stopYoutubeHandshake();
    this.sleeveSub?.unsubscribe();
    document.body.classList.remove('radio-focus', 'radio-stage-fs', 'radio-landscape-fs');
    const audio = this.pageAudio();
    const frame = this.youtubeFrame();
    const keepAudio = !!(audio && !this.youtubeEmbed && !audio.paused);
    const keepVideo = !!(frame && this.youtubeEmbed);
    if (this.keepAliveOnNavigate && this.playing && (keepAudio || keepVideo)) {
      const copyVideo = keepVideo && frame === this.ytFrame?.nativeElement;
      const copyMedia = keepVideo ? copyVideo : !this.adoptedAudio;
      const videoId = copyVideo ? this.currentYoutubeId() : '';
      const mediaTime = keepVideo ? this.youtubeSeconds : audio?.currentTime || 0;
      this.keepAlive.handoff({
        audio: keepAudio ? audio : null,
        frame: keepVideo ? frame : null,
        copyMedia,
        mediaTime,
        videoId,
        queue: this.queue.slice(),
        index: Math.max(0, this.currentIndex()),
        repeat: this.repeatQueue,
        youtubeIds: { ...this.ytLinks },
        volume: this.volume
      });
      if (keepAudio && copyMedia && audio) {
        audio.pause();
      }
      this.youtubeEmbed = null;
      if (keepVideo && copyMedia && frame) {
        frame.src = 'about:blank';
      }
      return;
    }
    if (audio) {
      audio.dataset['patUserPaused'] = '1';
      audio.pause();
      audio.removeAttribute('src');
    }
    this.releaseScreenHold();
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
    if (this.nowBrowse === 'album') {
      return this.nowBrowseTracks.filter((track) => this.passTrack(track));
    }
    const source = this.activeUserPlaylist
      ? (this.activeUserPlaylist.tracks || [])
      : (this.listMode === 'favorites' && !this.drilled ? this.favoriteTracks : this.tracks);
    return source.filter((track) => this.passTrack(track) && this.matchesFavoriteQuery(this.trackHay(track)));
  }

  /** Titles the Lecture button can start for the tab on screen. */
  get tabHasTracks(): boolean {
    if (this.listMode === 'playlists' && !this.activeUserPlaylist) {
      return this.playlistTabTracks().length > 0;
    }
    return this.shownTracks.length > 0;
  }

  get showTrackList(): boolean {
    if (this.nowBrowse === 'artist-albums') {
      return false;
    }
    if (this.nowBrowse === 'album') {
      return true;
    }
    if (this.listMode === 'playlists') {
      return !!this.activeUserPlaylist;
    }
    return this.view === 'track' || this.drilled;
  }

  get shownUserPlaylists(): DeezerUserPlaylist[] {
    const q = this.listMode === 'playlists' && !this.activeUserPlaylist ? this.query.trim().toLowerCase() : '';
    if (!q) {
      return this.userPlaylists;
    }
    return this.userPlaylists.filter((playlist) => (playlist.name || '').toLowerCase().includes(q));
  }

  get playlistCount(): number {
    return this.userPlaylists.length;
  }

  get playlistPickerChoices(): DeezerUserPlaylist[] {
    const q = this.playlistPickerQuery.trim().toLowerCase();
    if (!q) {
      return this.userPlaylists;
    }
    return this.userPlaylists.filter((playlist) => (playlist.name || '').toLowerCase().includes(q));
  }

  get trackEmptyKey(): string {
    if (this.activeUserPlaylist && !(this.activeUserPlaylist.tracks || []).length) {
      return 'DEEZER.PLAYLIST_EMPTY_TRACKS';
    }
    if (this.listMode === 'favorites' && !this.drilled && !this.favoriteTracks.length) {
      return 'DEEZER.FAVORITES_EMPTY';
    }
    return 'DEEZER.EMPTY';
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

  setListMode(mode: 'browse' | 'favorites' | 'playlists'): void {
    if (this.listMode === mode) {
      return;
    }
    this.listMode = mode;
    this.playbackFollowsList = this.playbackListMode === mode;
    this.playPendingList = false;
    this.loadSeq++;
    this.clearNowBrowse();
    this.activeUserPlaylist = null;
    this.playlistMenuTrack = null;
    this.renamingPlaylistId = '';
    this.confirmDeletePlaylistId = '';
    this.exitDrill();
    if (mode === 'playlists') {
      this.loading = false;
      this.errorKey = '';
      if (!this.keycloak.isLoggedIn()) {
        this.playlistsHint = 'DEEZER.PLAYLISTS_LOGIN';
      }
      this.refreshQueue();
      return;
    }
    if (mode === 'favorites') {
      this.loading = false;
      this.errorKey = '';
      if (!this.keycloak.isLoggedIn()) {
        this.favoritesHint = 'DEEZER.FAVORITES_LOGIN';
      }
      this.view = this.firstFavoriteView();
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
    this.startListedQueue(this.shownTracks);
  }

  /**
   * Lecture after Classement, Favoris or Playlists: start that tab's titles
   * from the first one, instead of resuming whatever was already loaded.
   */
  private playListedFromStart(): void {
    if (this.listMode === 'browse' && this.loading && !this.nowBrowse) {
      this.playPendingList = true;
      return;
    }
    this.startListedQueue(this.listedTracks());
  }

  private startListedQueue(tracks: DeezerTrack[]): void {
    const first = tracks[0];
    if (!first) {
      return;
    }
    this.claimPlaybackTab();
    this.playbackFollowsList = true;
    this.playPendingList = false;
    this.youtubeMode = true;
    this.clearYoutube();
    this.repeatQueue = true;
    this.queue = tracks;
    this.current = null;
    this.playTrack(first, 0);
  }

  /** Titles of the playlists currently listed, in playlist order. */
  private playlistTabTracks(): DeezerTrack[] {
    const out: DeezerTrack[] = [];
    for (const playlist of this.shownUserPlaylists) {
      for (const track of playlist.tracks || []) {
        if (this.passTrack(track)) {
          out.push(track);
        }
      }
    }
    return out;
  }

  /** Source of the title on screen: YouTube when a video is up, otherwise the Deezer preview. */
  get playAllSource(): 'youtube' | 'deezer' | null {
    if (!this.current) {
      return null;
    }
    return this.youtubeEmbed || this.youtubeBusy ? 'youtube' : 'deezer';
  }

  /**
   * Lecture starts the list on screen from its first title.
   * Pause only while that same list is the one already playing.
   */
  playPauseListed(): void {
    if (this.playing && this.current) {
      this.togglePlay();
      return;
    }
    this.playListedFromStart();
  }

  /** Pause only while the list on screen is the one playing. Any other list shows Lecture. */
  get tabListPlaying(): boolean {
    if (!this.playing || !this.current) {
      return false;
    }
    const listed = this.listedTracks();
    return this.sameTrackList(this.queue, listed) && listed.some((track) => track.id === this.current!.id);
  }

  /** List button: pause this list, or start its first title from any tab. */
  playPauseThisTab(): void {
    if (this.tabListPlaying) {
      this.playbackFollowsList = true;
      this.togglePlay();
      return;
    }
    this.playListedFromStart();
  }

  /** Tracks the Lecture button controls: the album on screen, this playlist, or this tab. */
  private listedTracks(): DeezerTrack[] {
    if (this.nowBrowse === 'album') {
      return this.shownTracks;
    }
    if (this.nowBrowse === 'artist-albums') {
      return [];
    }
    if (this.listMode === 'playlists' && !this.activeUserPlaylist && !this.drilled) {
      return this.playlistTabTracks();
    }
    return this.shownTracks;
  }

  private sameTrackList(queue: DeezerTrack[], listed: DeezerTrack[]): boolean {
    if (!queue.length || queue.length !== listed.length) {
      return false;
    }
    for (let i = 0; i < queue.length; i++) {
      if (queue[i]?.id !== listed[i]?.id) {
        return false;
      }
    }
    return true;
  }

  private claimPlaybackTab(): void {
    this.playbackListMode = this.listMode;
  }

  onYoutubeIcon(track: DeezerTrack, index: number, event?: Event): void {
    event?.stopPropagation();
    if (this.ytPending[track.id] || this.ytMiss[track.id]) {
      return;
    }
    if (this.ytLinks[track.id]) {
      this.playYoutubeTrack(track, index);
      return;
    }
    this.lookupYoutubeLink(track, index);
  }

  ytIconLabel(track: DeezerTrack): string {
    if (this.ytPending[track.id]) {
      return this.translate.instant('DEEZER.YT_SEARCHING');
    }
    if (this.ytMiss[track.id]) {
      return this.translate.instant('DEEZER.YT_MISS_HINT');
    }
    if (this.ytLinks[track.id]) {
      return this.translate.instant(this.ytFromCache[track.id] ? 'DEEZER.YT_CACHED_HINT' : 'DEEZER.YT_PLAY');
    }
    return this.translate.instant('DEEZER.YT_LOOKUP');
  }

  playYoutubeTrack(track: DeezerTrack, index: number, event?: Event): void {
    event?.stopPropagation();
    if (!this.ytLinks[track.id]) {
      return;
    }
    this.claimPlaybackTab();
    this.youtubeMode = true;
    this.repeatQueue = true;
    this.queue = this.shownTracks;
    if (this.current?.id === track.id && this.youtubeEmbed) {
      return;
    }
    this.current = null;
    this.playTrack(track, index);
  }

  isFavorite(kind: DeezerSearchType, id: number | null | undefined): boolean {
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

  toggleTrackPlaylistMenu(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (!this.ensurePlaylistsLogin()) {
      return;
    }
    if (this.playlistMenuTrack?.id === track.id) {
      this.closePlaylistMenu();
      return;
    }
    this.playlistPickerQuery = '';
    this.playlistMenuTrack = track;
  }

  closePlaylistMenu(event?: Event): void {
    event?.stopPropagation();
    this.playlistMenuTrack = null;
    this.playlistPickerQuery = '';
  }

  playlistHasTrack(playlist: DeezerUserPlaylist, trackId: number): boolean {
    return !!playlist?.tracks?.some((track) => track.id === trackId);
  }

  toggleTrackInPlaylist(playlist: DeezerUserPlaylist, track: DeezerTrack | null, event?: Event): void {
    event?.stopPropagation();
    if (!playlist?.id || !track?.id || this.playlistBusy || !this.playlistsReady) {
      return;
    }
    if (!this.ensurePlaylistsLogin()) {
      return;
    }
    const removing = this.playlistHasTrack(playlist, track.id);
    this.playlistBusy = (removing ? 'out:' : 'in:') + playlist.id;
    this.playlistsError = '';
    const req$ = removing
      ? this.api.removeDeezerUserPlaylistTrack(playlist.id, track.id)
      : this.api.addDeezerUserPlaylistTrack(playlist.id, track);
    this.playlistsSub?.unsubscribe();
    this.playlistsSub = req$.subscribe({
      next: (saved) => {
        this.playlistBusy = '';
        this.applyUserPlaylists(saved?.playlists || []);
      },
      error: () => {
        this.playlistBusy = '';
        this.playlistsError = 'DEEZER.ERR_PLAYLISTS_SAVE';
      }
    });
  }

  createPlaylist(track?: DeezerTrack | null): void {
    const name = this.playlistNameDraft.trim();
    if (!name || this.playlistBusy || !this.playlistsReady) {
      return;
    }
    if (!this.ensurePlaylistsLogin()) {
      return;
    }
    const attached = track?.id ? track : undefined;
    this.playlistBusy = 'create';
    this.playlistsError = '';
    const previous = new Set(this.userPlaylists.map((playlist) => playlist.id));
    const openAfter = !attached && this.listMode === 'playlists';
    this.playlistsSub?.unsubscribe();
    this.playlistsSub = this.api.createDeezerUserPlaylist(name, attached).subscribe({
      next: (saved) => {
        this.playlistBusy = '';
        this.playlistNameDraft = '';
        const created = (saved?.playlists || []).find((playlist) => playlist?.id && !previous.has(playlist.id));
        this.applyUserPlaylists(saved?.playlists || [], openAfter ? created?.id : undefined);
      },
      error: () => {
        this.playlistBusy = '';
        this.playlistsError = 'DEEZER.ERR_PLAYLISTS_SAVE';
      }
    });
  }

  openSavedPlaylist(playlist: DeezerUserPlaylist): void {
    if (!playlist?.id || this.renamingPlaylistId === playlist.id) {
      return;
    }
    this.activeUserPlaylist = playlist;
    this.playlistMenuTrack = null;
    this.confirmDeletePlaylistId = '';
    this.refreshQueue();
    this.ytScanKey = '';
    this.syncYoutubeButtons();
  }

  playSavedPlaylist(playlist: DeezerUserPlaylist, event?: Event): void {
    event?.stopPropagation();
    if (!playlist?.tracks?.length || this.renamingPlaylistId === playlist.id) {
      return;
    }
    this.openSavedPlaylist(playlist);
    this.playAll();
  }

  startRenamePlaylist(playlist: DeezerUserPlaylist, event?: Event): void {
    event?.stopPropagation();
    this.confirmDeletePlaylistId = '';
    if (this.renamingPlaylistId === playlist.id) {
      this.renamingPlaylistId = '';
      return;
    }
    this.renamingPlaylistId = playlist.id;
    this.renameDraft = playlist.name || '';
  }

  commitRenamePlaylist(playlist: DeezerUserPlaylist, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    const name = this.renameDraft.trim();
    if (!playlist?.id || !name || this.playlistBusy || !this.playlistsReady) {
      return;
    }
    if (name === playlist.name) {
      this.renamingPlaylistId = '';
      return;
    }
    if (!this.ensurePlaylistsLogin()) {
      return;
    }
    this.playlistBusy = 'rename:' + playlist.id;
    this.playlistsError = '';
    this.playlistsSub?.unsubscribe();
    this.playlistsSub = this.api.renameDeezerUserPlaylist(playlist.id, name).subscribe({
      next: (saved) => {
        this.playlistBusy = '';
        this.renamingPlaylistId = '';
        this.applyUserPlaylists(saved?.playlists || []);
      },
      error: () => {
        this.playlistBusy = '';
        this.playlistsError = 'DEEZER.ERR_PLAYLISTS_SAVE';
      }
    });
  }

  askDeletePlaylist(playlist: DeezerUserPlaylist, event?: Event): void {
    event?.stopPropagation();
    this.renamingPlaylistId = '';
    this.confirmDeletePlaylistId = this.confirmDeletePlaylistId === playlist.id ? '' : playlist.id;
  }

  deletePlaylist(playlist: DeezerUserPlaylist, event?: Event): void {
    event?.stopPropagation();
    if (!playlist?.id || this.playlistBusy || !this.playlistsReady) {
      return;
    }
    if (!this.ensurePlaylistsLogin()) {
      return;
    }
    this.playlistBusy = 'delete:' + playlist.id;
    this.playlistsError = '';
    this.playlistsSub?.unsubscribe();
    this.playlistsSub = this.api.deleteDeezerUserPlaylist(playlist.id).subscribe({
      next: (saved) => {
        this.playlistBusy = '';
        this.confirmDeletePlaylistId = '';
        if (this.activeUserPlaylist?.id === playlist.id) {
          this.activeUserPlaylist = null;
        }
        this.applyUserPlaylists(saved?.playlists || []);
      },
      error: () => {
        this.playlistBusy = '';
        this.playlistsError = 'DEEZER.ERR_PLAYLISTS_SAVE';
      }
    });
  }

  removeTrackFromPlaylist(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    const playlist = this.activeUserPlaylist;
    if (!playlist?.id || !track?.id) {
      return;
    }
    this.toggleTrackInPlaylist(playlist, track, event);
  }

  trackByPlaylistId(_index: number, playlist: DeezerUserPlaylist): string {
    return playlist.id;
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
    if (view === 'track' && !this.nowBrowse) {
      this.queue = this.shownTracks;
      this.syncYoutubeButtons();
    }
  }

  /** Tracks of the album that is playing. The current title keeps playing. */
  showPlayingAlbum(): void {
    const albumId = this.current?.albumId;
    if (!albumId) {
      return;
    }
    this.loadAlbumTracks(albumId, this.current?.albumTitle || '', this.current?.artistName || '', null);
  }

  /** Albums of the artist that is playing. The current title keeps playing. */
  showPlayingArtistAlbums(): void {
    const artistId = this.current?.artistId;
    if (!artistId) {
      return;
    }
    const name = (this.current?.artistName || '').trim();
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.nowBrowse = 'artist-albums';
    this.nowBrowseFrom = null;
    this.nowArtistName = name;
    this.nowBrowseTitle = name;
    this.nowBrowseSubtitle = '';
    this.nowBrowseTracks = [];
    this.api.getDeezerArtistAlbums(artistId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (albums) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.nowBrowseAlbums = albums || [];
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.nowBrowseAlbums = [];
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  showAlbumTracks(album: DeezerAlbum): void {
    const from = this.nowBrowse === 'artist-albums' ? 'artist-albums' : null;
    this.loadAlbumTracks(album.id, album.title, album.artistName || this.nowArtistName, from);
  }

  private loadAlbumTracks(albumId: number, title: string, artist: string, from: 'artist-albums' | null): void {
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.nowBrowse = 'album';
    this.nowBrowseFrom = from;
    this.nowBrowseTitle = title;
    this.nowBrowseSubtitle = artist;
    this.api.getDeezerAlbum(albumId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.nowBrowseTitle = page?.album?.title || title;
        this.nowBrowseSubtitle = page?.album?.artistName || artist;
        this.nowBrowseTracks = page?.tracks || [];
        this.ytScanKey = '';
        this.syncYoutubeButtons();
      },
      error: () => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.nowBrowseTracks = [];
        this.errorKey = 'DEEZER.ERR_LOAD';
      }
    });
  }

  private clearNowBrowse(): void {
    this.nowBrowse = null;
    this.nowBrowseFrom = null;
    this.nowArtistName = '';
    this.nowBrowseTitle = '';
    this.nowBrowseSubtitle = '';
    this.nowBrowseTracks = [];
    this.nowBrowseAlbums = [];
    this.albumSortOpen = false;
  }

  toggleAlbumSortMenu(event: Event): void {
    event.stopPropagation();
    this.albumSortOpen = !this.albumSortOpen;
  }

  setAlbumSort(value: string): void {
    const sort = value === 'name' || value === 'tracks' ? value : 'year';
    this.albumSortOpen = false;
    if (sort === this.albumSort) {
      return;
    }
    this.albumSort = sort;
    this.albumSortDesc = sort !== 'name';
  }

  toggleAlbumSortDir(): void {
    this.albumSortDesc = !this.albumSortDesc;
  }

  get albumSortLabelKey(): string {
    return this.albumSortOptions.find((option) => option.id === this.albumSort)?.key || 'DEEZER.ALBUM_BY_YEAR';
  }

  get albumSortIcon(): string {
    if (this.albumSort === 'name') {
      return this.albumSortDesc ? 'fa-sort-alpha-desc' : 'fa-sort-alpha-asc';
    }
    return this.albumSortDesc ? 'fa-sort-amount-desc' : 'fa-sort-amount-asc';
  }

  get sortedArtistAlbums(): DeezerAlbum[] {
    const list = this.nowBrowseAlbums.slice();
    const dir = this.albumSortDesc ? -1 : 1;
    list.sort((a, b) => {
      if (this.albumSort === 'name') {
        return dir * (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
      }
      if (this.albumSort === 'tracks') {
        const diff = (a.trackCount || 0) - (b.trackCount || 0);
        if (diff !== 0) {
          return dir * diff;
        }
      } else {
        const ay = this.yearOf(a.releaseDate);
        const by = this.yearOf(b.releaseDate);
        if (ay !== by) {
          if (!ay) {
            return 1;
          }
          if (!by) {
            return -1;
          }
          return dir * ay.localeCompare(by);
        }
      }
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    });
    return list;
  }

  back(): void {
    if (this.nowBrowse === 'album' && this.nowBrowseFrom === 'artist-albums') {
      this.loadSeq++;
      this.loading = false;
      this.errorKey = '';
      this.nowBrowse = 'artist-albums';
      this.nowBrowseFrom = null;
      this.nowBrowseTitle = this.nowArtistName;
      this.nowBrowseSubtitle = '';
      this.nowBrowseTracks = [];
      return;
    }
    if (this.nowBrowse) {
      this.loadSeq++;
      this.loading = false;
      this.errorKey = '';
      this.clearNowBrowse();
      return;
    }
    if (this.activeUserPlaylist) {
      this.activeUserPlaylist = null;
      this.renamingPlaylistId = '';
      this.playlistMenuTrack = null;
      this.refreshQueue();
      return;
    }
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
    this.claimPlaybackTab();
    this.repeatQueue = true;
    this.playbackFollowsList = true;
    this.queue = this.shownTracks;
    this.playTrack(track, index);
  }

  /** Force the 30 s Deezer preview, even if this title is already playing from YouTube. */
  playDeezerTrack(track: DeezerTrack, index: number, event?: Event): void {
    event?.stopPropagation();
    const wasYoutube = this.youtubeMode || !!this.youtubeEmbed;
    this.claimPlaybackTab();
    this.youtubeMode = false;
    this.repeatQueue = true;
    this.queue = this.shownTracks;
    if (wasYoutube && this.current?.id === track.id) {
      this.clearYoutube();
      this.current = null;
    }
    this.playTrack(track, index);
  }

  playTrack(track: DeezerTrack, index: number, restart = false): void {
    const same = this.current?.id === track.id;
    if (!restart && same) {
      this.togglePlay();
      return;
    }
    if (this.playbackListMode == null || this.playbackListMode === this.listMode) {
      this.claimPlaybackTab();
      this.playbackFollowsList = true;
    }
    this.ytReplay = restart && same ? Date.now() : 0;
    this.current = track;
    this.queueIndexHint = index;
    this.trackImageIndex = 0;
    this.syncTrackSlide();
    this.previewFresh = false;
    this.playErrorKey = '';
    this.currentTime = 0;
    this.youtubeSeconds = 0;
    this.audioDuration = 0;
    this.related = this.drilled ? this.related : [];
    this.scheduleSleeve(track.artistId || 0);
    if (this.youtubeMode) {
      this.armCleanVideoChrome();
    } else {
      this.suppressChromeUntilLeave = false;
      this.chromeVisible = this.pointerOverPlayer || this.focusMode || this.stageFullscreen;
      if (this.chromeVisible && !this.focusMode && !this.stageFullscreen) {
        this.scheduleChromeHide();
      }
    }
    if (this.youtubeMode) {
      this.pausePreview();
      if (restart && same) {
        this.youtubeEmbed = null;
        this.youtubeTitle = '';
      }
      this.resolveYoutube(track);
      this.syncLandscapeFullscreen();
      return;
    }
    this.clearYoutube();
    this.playPreview(track);
    this.syncLandscapeFullscreen();
  }

  togglePlay(): void {
    if (!this.playing && !this.playbackFollowsList) {
      this.playListedFromStart();
      return;
    }
    if (this.youtubeEmbed) {
      const func = this.playing ? 'pauseVideo' : 'playVideo';
      if (func === 'pauseVideo') {
        this.userHold = true;
        this.releaseScreenHold();
      } else {
        this.holdScreen();
      }
      this.handshakeYoutube();
      this.postYoutubeCommand(func);
      if (func === 'playVideo') {
        this.pushYoutubeSound();
      }
      this.playing = !this.playing;
      return;
    }
    const audio = this.pageAudio();
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
      this.holdScreen();
      this.hushOthers(audio);
      audio.play().catch(() => {
        this.playErrorKey = 'DEEZER.ERR_PLAY';
        this.playing = false;
        this.releaseScreenHold();
      });
    } else {
      this.userHold = true;
      audio.dataset['patUserPaused'] = '1';
      audio.pause();
      this.releaseScreenHold();
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
    this.userHold = true;
    this.youtubeMode = false;
    this.repeatQueue = false;
    this.clearYoutube();
    const audio = this.pageAudio();
    if (!audio) {
      this.currentTime = 0;
      this.playing = false;
      this.releaseScreenHold();
      return;
    }
    audio.dataset['patUserPaused'] = '1';
    audio.pause();
    audio.currentTime = 0;
    this.currentTime = 0;
    this.playing = false;
    this.releaseScreenHold();
  }

  seek(event: Event): void {
    const audio = this.pageAudio();
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
        this.repeatQueue = true;
        this.claimPlaybackTab();
        this.playbackFollowsList = true;
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
        this.repeatQueue = true;
        this.claimPlaybackTab();
        this.playbackFollowsList = true;
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
        this.repeatQueue = true;
        this.claimPlaybackTab();
        this.playbackFollowsList = true;
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

  openSimilarArtists(): void {
    const artistId = this.current?.artistId || 0;
    if (!artistId) {
      return;
    }
    this.similarOpen = true;
    this.similarName = (this.current?.artistName || '').trim();
    this.similarError = '';
    this.similarForId = artistId;
    const cached = this.similarCache.get(artistId);
    if (cached) {
      this.similarArtists = cached;
      this.similarLoading = false;
      return;
    }
    this.similarArtists = [];
    this.similarLoading = true;
    this.similarSub?.unsubscribe();
    this.similarSub = this.api.getDeezerArtist(artistId).subscribe({
      next: (page) => {
        if (this.similarForId !== artistId) {
          return;
        }
        const list = page?.related || [];
        this.similarCache.set(artistId, list);
        this.similarArtists = list;
        this.similarLoading = false;
      },
      error: () => {
        if (this.similarForId !== artistId) {
          return;
        }
        this.similarLoading = false;
        this.similarArtists = [];
        this.similarError = 'DEEZER.ERR_LOAD';
      }
    });
  }

  closeSimilarArtists(event?: Event): void {
    event?.stopPropagation();
    this.similarOpen = false;
    this.similarSortOpen = false;
  }

  toggleSimilarSortMenu(event: Event): void {
    event.stopPropagation();
    this.similarSortOpen = !this.similarSortOpen;
  }

  setSimilarSort(value: string): void {
    const sort = value === 'name' || value === 'fans' ? value : 'relevance';
    this.similarSortOpen = false;
    if (sort === this.similarSort) {
      return;
    }
    this.similarSort = sort;
    this.similarSortDesc = sort === 'fans';
  }

  get similarSortLabelKey(): string {
    return this.similarSortOptions.find((option) => option.id === this.similarSort)?.key || 'DEEZER.SIMILAR_BY_RELEVANCE';
  }

  toggleSimilarSortDir(): void {
    if (this.similarSort === 'relevance') {
      return;
    }
    this.similarSortDesc = !this.similarSortDesc;
  }

  get sortedSimilarArtists(): DeezerArtist[] {
    const list = this.similarArtists.slice();
    if (this.similarSort === 'relevance') {
      return list;
    }
    const dir = this.similarSortDesc ? -1 : 1;
    if (this.similarSort === 'fans') {
      list.sort((a, b) => dir * ((a.fanCount || 0) - (b.fanCount || 0)) || this.compareSimilarName(a.name, b.name));
    } else {
      list.sort((a, b) => dir * this.compareSimilarName(a.name, b.name));
    }
    return list;
  }

  get similarSortIcon(): string {
    if (this.similarSort === 'fans') {
      return this.similarSortDesc ? 'fa-sort-amount-desc' : 'fa-sort-amount-asc';
    }
    return this.similarSortDesc ? 'fa-sort-alpha-desc' : 'fa-sort-alpha-asc';
  }

  private compareSimilarName(a: string, b: string): number {
    return (a || '').localeCompare(b || '', this.translate.currentLang || 'fr', { sensitivity: 'base' });
  }

  pickSimilarArtist(artist: DeezerArtist): void {
    const name = (artist.name || '').trim();
    this.closeSimilarArtists();
    if (name.length < 2) {
      return;
    }
    this.stop();
    const needsSearch = this.listMode !== 'browse' || this.drilled || this.query.trim() !== name || this.mode !== 'search';
    this.listMode = 'browse';
    this.activeUserPlaylist = null;
    this.exitDrill();
    if (this.query.trim() === name) {
      if (needsSearch) {
        this.loadSearch(name);
      }
      return;
    }
    this.onQueryChange(name);
  }

  onAudioTime(): void {
    const audio = this.pageAudio();
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
    if (!this.userHold) {
      this.holdScreen();
    }
  }

  onAudioPause(): void {
    this.playing = false;
    this.buffering = false;
    const audio = this.pageAudio();
    if (this.userHold || audio?.dataset['patUserPaused'] === '1' || !this.screenHold) {
      return;
    }
    if (this.asleep()) {
      this.keepPlayingThroughSleep();
    }
  }

  onAudioWaiting(): void {
    this.buffering = true;
  }

  onAudioEnded(): void {
    this.playing = false;
    this.buffering = false;
    if (this.queueContinues()) {
      this.next();
      return;
    }
    this.releaseScreenHold();
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
    if (this.listMode === 'favorites' || this.listMode === 'playlists') {
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
        if (this.playPendingList && this.listMode === 'browse') {
          this.playListedFromStart();
        } else if (!this.drilled && this.view === 'track' && this.listMode === 'browse' && !this.resumedKeep) {
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
        if (this.playPendingList && this.listMode === 'browse') {
          this.playListedFromStart();
        } else {
          this.queue = this.view === 'track' ? this.shownTracks : [];
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
    const audio = this.pageAudio();
    if (!audio) {
      this.playErrorKey = 'DEEZER.ERR_PLAY';
      return;
    }
    this.hushOthers(audio);
    delete audio.dataset['patUserPaused'];
    this.holdScreen();
    audio.crossOrigin = 'anonymous';
    audio.muted = false;
    audio.volume = this.volume;
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
      if (this.screenHold && this.asleep() && !audio.ended) {
        this.keepPlayingThroughSleep();
        return;
      }
      this.playErrorKey = 'DEEZER.ERR_PLAY';
      this.releaseScreenHold();
    });
  }

  private applyVolume(): void {
    const audio = this.pageAudio();
    if (audio) {
      audio.muted = false;
      audio.volume = this.volume;
    }
  }

  get eqActive(): boolean {
    return this.equalizer.wantsProcessing && !!this.current;
  }

  get sleeveVisible(): boolean {
    return this.trackImages.length > 0 && (this.sleeveOpen || this.landscapeFullscreen);
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
    this.skinChosenThisVisit = true;
    this.writeLocalSkin(skin);
    this.saveRemoteSkin(skin);
  }

  openEqualizer(): void {
    const audio = this.pageAudio();
    if (audio) {
      audio.crossOrigin = 'anonymous';
      this.equalizer.attachMediaElement(audio);
    }
    this.eqModal?.open();
  }

  toggleFocusMode(event?: Event): void {
    event?.stopPropagation();
    if (!this.focusMode && this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
    }
    this.focusMode = !this.focusMode;
    document.body.classList.toggle('radio-focus', this.focusMode);
    if (this.focusMode && this.youtubeEmbed) {
      this.armCleanVideoChrome();
    } else {
      this.suppressChromeUntilLeave = false;
      this.chromeVisible = this.focusMode || this.pointerOverPlayer || this.stageFullscreen;
    }
  }

  get mobileLayout(): boolean {
    return this.isMobileLikeViewport();
  }

  /** Phone: one control, and it shows only the cover or the video. */
  onFullscreenButton(event?: Event): void {
    if (this.isMobileLikeViewport()) {
      this.toggleMediaFullscreen(event);
      return;
    }
    void this.toggleStageFullscreen(event);
  }

  toggleMediaFullscreen(event?: Event): void {
    event?.stopPropagation();
    if (this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
      return;
    }
    this.mediaFsPinned = true;
    this.landscapeFsUserDismissed = false;
    this.enterLandscapeFullscreen();
  }

  async toggleStageFullscreen(event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.stageFullscreen) {
      await this.exitStageFullscreen();
      this.syncLandscapeFullscreen();
      return;
    }
    if (this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
    }
    this.stageFullscreen = true;
    if (this.youtubeEmbed) {
      this.armCleanVideoChrome();
    } else {
      this.chromeVisible = true;
    }
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
    const audio = this.pageAudio();
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
          this.syncLandscapeFullscreen();
        }
      });
      this.isPipActive = true;
      this.syncLandscapeFullscreen();
    } catch {
      this.playErrorKey = 'RADIO.ERR_PIP';
    }
  }

  toggleDock(): void {
    this.docked = !this.docked;
    this.syncLandscapeFullscreen();
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
    if (payload.event === 'infoDelivery' && typeof payload.info === 'number' && payload.info >= 0) {
      this.youtubeSeconds = payload.info;
    } else if (payload.info && typeof payload.info === 'object' && typeof payload.info['currentTime'] === 'number') {
      this.youtubeSeconds = payload.info['currentTime'] as number;
    }
    let state: number | undefined;
    if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
      state = payload.info;
    } else if (payload.info && typeof payload.info === 'object' && typeof payload.info['playerState'] === 'number') {
      state = payload.info['playerState'] as number;
    }
    this.ytApiListening = true;
    if (payload.event === 'onReady' || state === 5) {
      this.pushYoutubeSound();
    }
    if (state === 1 && this.youtubeFrame()?.contentWindow) {
      this.pushYoutubeSound();
      this.ytSoundArmed = true;
    }
    if (state === 1) {
      this.playing = true;
      this.youtubeBusy = false;
      if (!this.userHold) {
        this.holdScreen();
      }
    } else if (state === 2) {
      this.playing = false;
    } else if (state === 0 && Date.now() >= this.ytIgnoreEnd && this.youtubeMode) {
      if (this.queueContinues()) {
        this.next();
      } else {
        this.releaseScreenHold();
      }
    }
  }

  onYoutubeFrameLoad(): void {
    this.ytApiListening = false;
    this.handshakeYoutube();
    this.pushYoutubeSound();
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
    if (this.similarSortOpen && !target?.closest?.('.dz-similar-sort-menu')) {
      this.similarSortOpen = false;
    }
    if (this.albumSortOpen && !target?.closest?.('.dz-album-sort')) {
      this.albumSortOpen = false;
    }
    if (this.playlistMenuTrack && !target?.closest?.('.dz-pl-modal') && !target?.closest?.('.dz-pl-btn')) {
      this.closePlaylistMenu();
    }
  }

  onPlayerPointerEnter(): void {
    this.pointerOverPlayer = true;
    this.clearChromeHideTimer();
    if (this.youtubeEmbed || this.suppressChromeUntilLeave) {
      return;
    }
    this.revealDeezerChrome(false);
  }

  onPlayerPointerMove(event?: MouseEvent): void {
    if (!this.youtubeEmbed) {
      this.suppressChromeUntilLeave = false;
      this.pointerOverPlayer = true;
      this.revealDeezerChrome(this.pointerOverChrome(event));
      return;
    }
    this.onVideoSurface(event);
  }

  onVideoSurface(event?: MouseEvent): void {
    this.pointerOverPlayer = true;
    this.clearChromeHideTimer();
    if (this.suppressChromeUntilLeave) {
      if (event?.type !== 'mousemove') {
        return;
      }
      this.suppressChromeUntilLeave = false;
    }
    this.chromeVisible = true;
  }

  onPlayerPointerLeave(event?: MouseEvent): void {
    if (event && this.pointerStillOverPanel(event)) {
      return;
    }
    this.pointerOverPlayer = false;
    this.suppressChromeUntilLeave = false;
    this.clearChromeHideTimer();
    if (this.holdsChromeOpen()) {
      return;
    }
    this.shareMenuOpen = false;
    this.chromeVisible = false;
  }

  onPlayerTouch(): void {
    this.pointerOverPlayer = false;
    this.suppressChromeUntilLeave = false;
    this.chromeVisible = true;
    this.scheduleChromeHide();
  }

  /** Deezer preview: show the caption and buttons, and keep them only while the pointer is on that bar. */
  private revealDeezerChrome(overChrome: boolean): void {
    this.chromeVisible = true;
    this.clearChromeHideTimer();
    if (overChrome || this.shareMenuOpen || this.holdsChromeOpen()) {
      return;
    }
    this.scheduleChromeHide(DeezerWatcherComponent.CHROME_IDLE_MS);
  }

  private pointerOverChrome(event?: MouseEvent): boolean {
    const target = event?.target;
    return target instanceof Element && !!target.closest('.radio-chrome');
  }

  private scheduleChromeHide(delay = DeezerWatcherComponent.CHROME_HIDE_MS): void {
    this.clearChromeHideTimer();
    if (this.shareMenuOpen || this.holdsChromeOpen() || this.suppressChromeUntilLeave) {
      return;
    }
    this.chromeHideTimer = setTimeout(() => {
      this.chromeHideTimer = null;
      if (this.shareMenuOpen || this.holdsChromeOpen() || this.suppressChromeUntilLeave) {
        return;
      }
      this.chromeVisible = false;
    }, delay);
  }

  private clearChromeHideTimer(): void {
    if (this.chromeHideTimer != null) {
      clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
      return;
    }
    if (this.albumSortOpen) {
      this.albumSortOpen = false;
      return;
    }
    if (this.similarOpen) {
      if (this.similarSortOpen) {
        this.similarSortOpen = false;
        return;
      }
      this.closeSimilarArtists();
      return;
    }
    if (this.playlistMenuTrack) {
      this.closePlaylistMenu();
      return;
    }
    if (this.renamingPlaylistId) {
      this.renamingPlaylistId = '';
      return;
    }
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
      if (this.youtubeEmbed) {
        this.armCleanVideoChrome();
      } else {
        this.chromeVisible = true;
      }
      document.body.classList.add('radio-stage-fs');
    } else if (!document.fullscreenElement && this.stageFullscreen) {
      this.stageFullscreen = false;
      document.body.classList.remove('radio-stage-fs');
      this.suppressChromeUntilLeave = false;
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
    this.suppressChromeUntilLeave = false;
    this.chromeVisible = this.pointerOverPlayer || this.focusMode;
    this.syncLandscapeFullscreen();
  }

  /** Leave the phone-landscape screen. Portrait clears the dismiss so the next turn fills the screen again. */
  exitLandscapeFullscreen(markDismissed = true, event?: Event): void {
    event?.stopPropagation();
    if (markDismissed && this.landscapeFullscreen) {
      this.landscapeFsUserDismissed = true;
    }
    if (!this.landscapeFullscreen && !document.body.classList.contains(DeezerWatcherComponent.LANDSCAPE_FS_BODY_CLASS)) {
      return;
    }
    this.landscapeFullscreen = false;
    this.mediaFsPinned = false;
    document.body.classList.remove(DeezerWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    this.cdr.markForCheck();
  }

  @HostListener('window:orientationchange')
  @HostListener('window:resize')
  onViewportOrientationMaybeChanged(): void {
    this.syncLandscapeFullscreen();
  }

  private setupLandscapeFullscreenWatchers(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.landscapeOrientationMql = window.matchMedia('(orientation: landscape)');
    const mql = this.landscapeOrientationMql as MediaQueryList & {
      addListener?: (cb: () => void) => void;
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      mql.addListener?.(this.onLandscapeOrientationMedia);
    }
  }

  private teardownLandscapeFullscreenWatchers(): void {
    const mql = this.landscapeOrientationMql as (MediaQueryList & {
      removeListener?: (cb: () => void) => void;
    }) | null;
    if (mql) {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', this.onLandscapeOrientationMedia);
      } else {
        mql.removeListener?.(this.onLandscapeOrientationMedia);
      }
      this.landscapeOrientationMql = null;
    }
  }

  private isMobileLikeViewport(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const touch = (navigator.maxTouchPoints || 0) > 0;
    return coarse || (narrow && touch);
  }

  private isLandscapeOrientation(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    if (this.landscapeOrientationMql) {
      return this.landscapeOrientationMql.matches;
    }
    return window.matchMedia('(orientation: landscape)').matches;
  }

  /** Landscape is the cover or the clip. With neither, the screen stays blank — not the receiver. */
  private hasLandscapeScreen(): boolean {
    return !this.docked && !this.isPipActive;
  }

  private canEnterLandscapeFullscreen(): boolean {
    return (
      this.isMobileLikeViewport()
      && this.isLandscapeOrientation()
      && this.hasLandscapeScreen()
      && !this.landscapeFsUserDismissed
      && !this.focusMode
      && !this.stageFullscreen
    );
  }

  private syncLandscapeFullscreen(): void {
    if (!this.isLandscapeOrientation()) {
      this.landscapeFsUserDismissed = false;
      if (!this.mediaFsPinned) {
        this.exitLandscapeFullscreen(false);
      }
      return;
    }
    if (this.canEnterLandscapeFullscreen()) {
      this.enterLandscapeFullscreen();
      return;
    }
    if (this.landscapeFullscreen && !this.hasLandscapeScreen()) {
      this.exitLandscapeFullscreen(false);
    }
  }

  private enterLandscapeFullscreen(): void {
    const already = this.landscapeFullscreen;
    this.landscapeFullscreen = true;
    document.body.classList.add(DeezerWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    if (!already) {
      this.chromeVisible = false;
      this.clearChromeHideTimer();
      this.cdr.markForCheck();
    }
  }

  /** Preview chrome stays up in focus. A YouTube clip hides every button until the pointer returns. */
  private holdsChromeOpen(): boolean {
    return !this.youtubeEmbed && (this.focusMode || this.stageFullscreen);
  }

  private armCleanVideoChrome(): void {
    this.chromeVisible = false;
    this.suppressChromeUntilLeave = this.pointerOverPlayer;
  }

  private pointerStillOverPanel(event: MouseEvent): boolean {
    const panel = this.playerPanelEl?.nativeElement;
    if (!panel) {
      return false;
    }
    const rect = panel.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  private pointerOverPlayerChrome(event?: MouseEvent): boolean {
    const target = event?.target;
    return target instanceof Element && !!target.closest('.radio-chrome, .radio-presets, .radio-player-frame');
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

  private static isDzSkin(value: string | null | undefined): value is DzSkin {
    return !!value && (DZ_SKINS as readonly string[]).includes(value);
  }

  /** Local value applies instantly; the account value (if any) wins once loaded, unless the user already picked one. */
  private restoreSkinPreference(): void {
    const local = this.readSkin();
    this.radioSkin = local ?? 'classic';
    if (!this.keycloak.isLoggedIn()) {
      return;
    }
    this.skinLoadSub?.unsubscribe();
    this.skinLoadSub = this.api.getDeezerSkin().pipe(
      catchError(() => of(null)),
      takeUntil(this.destroy$)
    ).subscribe((remote) => {
      if (this.skinChosenThisVisit) {
        return;
      }
      if (DeezerWatcherComponent.isDzSkin(remote)) {
        this.radioSkin = remote;
        this.writeLocalSkin(remote);
        this.cdr.markForCheck();
      } else if (local) {
        this.writeLocalSkin(local);
        this.saveRemoteSkin(local);
      }
    });
  }

  private readSkin(): DzSkin | null {
    const raw = readMediaSkin(DeezerWatcherComponent.SKIN_KEY);
    return DeezerWatcherComponent.isDzSkin(raw) ? raw : null;
  }

  private writeLocalSkin(skin: DzSkin): void {
    writeMediaSkin(skin);
  }

  private saveRemoteSkin(skin: DzSkin): void {
    if (!this.keycloak.isLoggedIn()) {
      return;
    }
    this.skinSaveSub?.unsubscribe();
    this.skinSaveSub = this.api.saveDeezerSkin(skin).pipe(
      catchError(() => of(null)),
      takeUntil(this.destroy$)
    ).subscribe();
  }

  private readKeepAlive(): boolean {
    try {
      const raw = localStorage.getItem(DeezerWatcherComponent.KEEP_KEY);
      return raw === '1' || raw === 'true';
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

  /** Keeps the phone process awake so a queue can advance after the screen turns off. */
  private holdScreen(): void {
    this.userHold = false;
    this.screenHold = true;
    const audio = this.pageAudio();
    if (audio && !this.youtubeMode && !this.youtubeEmbed) {
      delete audio.dataset['patUserPaused'];
    }
    this.tagNowPlaying(audio);
    this.tagNowPlaying(this.youtubeFrame());
    const track = this.current;
    setScreenKeepAlive('deezer', true, track?.title || 'Deezer', {
      artist: track?.artistName || '',
      album: track?.albumTitle || ''
    });
    this.claimAudioSession();
  }

  private releaseScreenHold(): void {
    this.screenHold = false;
    this.clearSleepKick();
    setScreenKeepAlive('deezer', false);
    this.releaseAudioSession(false);
  }

  private queueContinues(): boolean {
    const idx = this.currentIndex();
    return (idx >= 0 && idx < this.queue.length - 1) || (this.repeatQueue && this.queue.length > 0);
  }

  private asleep(): boolean {
    return screenIsOff() || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
  }

  /** Screen off pauses an audio element. Start it again, the way the radio does. */
  private keepPlayingThroughSleep(): void {
    if (!this.screenHold || this.userHold || this.youtubeEmbed || this.sleepKickTimer != null) {
      return;
    }
    if (!this.asleep()) {
      return;
    }
    const audio = this.pageAudio();
    if (!audio || audio.dataset['patUserPaused'] === '1' || audio.ended) {
      return;
    }
    if (!audio.paused && !audio.error) {
      return;
    }
    const kick = (attempt: number): void => {
      this.sleepKickTimer = null;
      if (!this.screenHold || this.userHold || this.youtubeEmbed || !this.asleep()) {
        return;
      }
      const el = this.pageAudio();
      if (!el || el.dataset['patUserPaused'] === '1' || el.ended) {
        return;
      }
      if (!el.paused && !el.error) {
        return;
      }
      void el.play().then(() => {
        if (!this.screenHold || this.userHold || !this.asleep()) {
          return;
        }
        if ((el.paused || el.error) && attempt < 5) {
          this.sleepKickTimer = setTimeout(() => kick(attempt + 1), 450);
        }
      }).catch(() => {
        if (!this.screenHold || this.userHold || attempt >= 5) {
          return;
        }
        this.sleepKickTimer = setTimeout(() => kick(attempt + 1), 450);
      });
    };
    kick(0);
  }

  private clearSleepKick(): void {
    if (this.sleepKickTimer != null) {
      clearTimeout(this.sleepKickTimer);
      this.sleepKickTimer = null;
    }
  }

  private onLockScreenTune(event: Event): void {
    if (activeScreenKeepAliveOwner() === 'radio') {
      return;
    }
    if (!this.screenHold && !this.playing) {
      return;
    }
    const action = (event as CustomEvent<string>).detail;
    if (action !== 'next' && action !== 'previous') {
      return;
    }
    if (!claimRadioTune()) {
      return;
    }
    if (action === 'next') {
      this.next();
    } else {
      this.prev();
    }
  }

  private tagNowPlaying(el?: HTMLElement | null): void {
    const track = this.current;
    if (!el || !track) {
      return;
    }
    el.setAttribute('data-pat-media-title', track.title || '');
    el.setAttribute('data-pat-media-artist', track.artistName || '');
    el.setAttribute('data-pat-media-album', track.albumTitle || '');
    if (track.coverUrl) {
      el.setAttribute('data-pat-media-artwork', track.coverUrl);
    }
  }

  private claimAudioSession(): void {
    const session = this.audioSession();
    if (!session) {
      return;
    }
    try {
      session.type = 'playback';
      this.audioSessionClaimed = true;
    } catch {
      /* the browser has no audio session */
    }
  }

  private releaseAudioSession(force: boolean): void {
    if (!force && !this.audioSessionClaimed) {
      return;
    }
    this.audioSessionClaimed = false;
    if (this.radioStillPlaying()) {
      return;
    }
    const session = this.audioSession();
    if (!session) {
      return;
    }
    try {
      session.type = 'auto';
    } catch {
      /* unsupported */
    }
  }

  private radioStillPlaying(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const nodes = document.querySelectorAll('audio[data-pat-radio="1"]');
    for (const node of Array.from(nodes)) {
      if (!(node instanceof HTMLMediaElement)) {
        continue;
      }
      if (node.src && !node.paused && !node.ended && !node.error) {
        return true;
      }
    }
    return false;
  }

  private audioSession(): { type: string } | null {
    if (typeof navigator === 'undefined') {
      return null;
    }
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    return session || null;
  }

  private youtubeFrame(): HTMLIFrameElement | null {
    return this.keptFrame || this.ytFrame?.nativeElement || null;
  }

  /** Put the background list back on the page at the same title and the same time. */
  private resumeKeptPlayback(): void {
    const kept = this.keepAlive.reclaim();
    if (!kept) {
      return;
    }
    const track = kept.queue[kept.index];
    if (!track) {
      if (kept.audio) {
        kept.audio.pause();
        kept.audio.remove();
      }
      kept.frame?.remove();
      return;
    }
    this.resumedKeep = true;
    this.queue = kept.queue;
    this.queueIndexHint = kept.index;
    this.repeatQueue = kept.repeat;
    this.claimPlaybackTab();
    this.playbackFollowsList = true;
    this.ytLinks = { ...this.ytLinks, ...kept.youtubeIds };
    this.volume = kept.volume;
    this.current = track;
    this.playing = kept.playing;
    this.youtubeMode = !!kept.frame;
    if (kept.frame) {
      this.mountKeptFrame(kept.frame, track, kept.currentTime);
      if (kept.audio) {
        kept.audio.pause();
        kept.audio.remove();
      }
      return;
    }
    if (kept.audio) {
      this.mountKeptAudio(kept.audio, kept.currentTime, kept.playing);
    }
    this.cdr.markForCheck();
  }

  private mountKeptFrame(frame: HTMLIFrameElement, track: DeezerTrack, resumeSeconds: number): void {
    this.youtubeTitle = `${track.artistName || ''} — ${track.title || ''}`.replace(/^ — | — $/g, '');
    this.youtubeEmbed = this.sanitizer.bypassSecurityTrustResourceUrl(frame.src || 'about:blank');
    this.keptFrameActive = true;
    this.keptFrame = frame;
    this.youtubeSeconds = resumeSeconds;
    this.cdr.detectChanges();
    const host = this.keptYtHost?.nativeElement;
    if (!host) {
      return;
    }
    frame.className = 'dz-yt';
    frame.style.cssText = '';
    // The parked frame is created outside the page, so the component styles do not apply to it.
    frame.style.position = 'absolute';
    frame.style.inset = '0';
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = '0';
    frame.style.zIndex = '5';
    frame.style.background = '#000';
    delete frame.dataset['patDeezerKeep'];
    let seeks = 0;
    const seekBack = (): void => {
      if (resumeSeconds <= 1 || seeks > 4) {
        return;
      }
      seeks += 1;
      this.postYoutubeCommand('seekTo', [resumeSeconds, true]);
      this.postYoutubeCommand('playVideo');
    };
    frame.addEventListener('load', seekBack);
    host.appendChild(frame);
    if (this.playing) {
      this.holdScreen();
    }
    this.handshakeYoutube();
    this.watchYoutubeClock();
    window.setTimeout(seekBack, 400);
    window.setTimeout(seekBack, 1200);
  }

  private mountKeptAudio(kept: HTMLAudioElement, time: number, playing: boolean): void {
    this.adoptedAudio = kept;
    this.currentTime = kept.currentTime > 0.2 ? kept.currentTime : time;
    kept.volume = this.volume;
    kept.muted = false;
    if (!playing) {
      kept.dataset['patUserPaused'] = '1';
    } else {
      delete kept.dataset['patUserPaused'];
      if (kept.paused) {
        kept.play().catch(() => {
          this.playing = false;
        });
      }
      this.holdScreen();
    }
    kept.addEventListener('timeupdate', () => this.onAudioTime());
    kept.addEventListener('play', () => this.onAudioPlay());
    kept.addEventListener('pause', () => this.onAudioPause());
    kept.addEventListener('waiting', () => this.onAudioWaiting());
    kept.addEventListener('playing', () => this.onAudioPlay());
    kept.addEventListener('ended', () => this.onAudioEnded());
    kept.addEventListener('error', () => this.onAudioError());
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
      const stored = localStorage.getItem(DeezerWatcherComponent.VOLUME_KEY);
      if (stored == null || stored.trim() === '') {
        return 0.9;
      }
      const raw = Number(stored);
      if (Number.isFinite(raw) && raw > 0 && raw <= 1) {
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
    const audio = this.pageAudio();
    if (!audio) {
      return;
    }
    audio.dataset['patUserPaused'] = '1';
    audio.pause();
  }

  private clearYoutube(): void {
    this.ytToken++;
    this.ytSub?.unsubscribe();
    this.ytSub = null;
    this.youtubeEmbed = null;
    this.youtubeTitle = '';
    this.youtubeBusy = false;
    this.suppressChromeUntilLeave = false;
    if (this.pointerOverPlayer || this.focusMode || this.stageFullscreen) {
      this.chromeVisible = true;
    }
    this.stopYoutubeHandshake();
    this.ytApiListening = false;
    this.ytSoundArmed = false;
    setScreenKeepAlive('youtube', false);
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
        this.rememberYoutube(track.id, id);
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
    this.holdScreen();
    this.youtubeTitle = `${track.artistName || ''} — ${track.title || ''}`.trim();
    this.ytIgnoreEnd = Date.now() + 1500;
    const origin = typeof window !== 'undefined' ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}` : '';
    const replay = this.ytReplay ? `&ts=${this.ytReplay}` : '';
    this.youtubeEmbed = this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1&playsinline=1&controls=1&fs=1&iv_load_policy=3${origin}${replay}`
    );
    this.armCleanVideoChrome();
    this.playing = true;
    this.playErrorKey = '';
    this.armYoutubeSound();
    this.watchYoutubeClock();
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
          this.rememberYoutube(next.id, (link.videoId || '').trim() || null);
        }
      },
      error: () => { /* the track will be searched again when it starts */ }
    });
  }

  private lookupYoutubeLink(track: DeezerTrack, index: number): void {
    if (this.youtubeQuery(track).length < 2) {
      return;
    }
    this.ytPending = { ...this.ytPending, [track.id]: true };
    this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: track.artistName || '',
      title: track.title || ''
    }], true).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        this.clearYoutubePending(track.id);
        const link = (page?.links || []).find((item) => item.id === track.id);
        if (!link) {
          return;
        }
        const videoId = (link.videoId || '').trim() || null;
        this.rememberYoutube(track.id, videoId);
        if (videoId) {
          this.playYoutubeTrack(track, index);
        }
      },
      error: () => this.clearYoutubePending(track.id)
    });
  }

  private clearYoutubePending(id: number): void {
    if (!this.ytPending[id]) {
      return;
    }
    const next = { ...this.ytPending };
    delete next[id];
    this.ytPending = next;
  }

  private rememberYoutube(id: number, videoId: string | null): void {
    this.ytCache.set(id, videoId);
    if (videoId) {
      this.ytLinks = { ...this.ytLinks, [id]: videoId };
      this.ytFromCache = { ...this.ytFromCache, [id]: true };
      if (this.ytMiss[id]) {
        const miss = { ...this.ytMiss };
        delete miss[id];
        this.ytMiss = miss;
      }
      return;
    }
    const links = { ...this.ytLinks };
    delete links[id];
    this.ytLinks = links;
    const cached = { ...this.ytFromCache };
    delete cached[id];
    this.ytFromCache = cached;
    this.ytMiss = { ...this.ytMiss, [id]: true };
  }

  private syncYoutubeButtons(): void {
    if (this.nowBrowse !== 'album' && this.view !== 'track' && !this.drilled) {
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
      this.rememberYoutube(link.id, (link.videoId || '').trim() || null);
    }
  }

  private youtubeQuery(track: DeezerTrack): string {
    return `${track.artistName || ''} ${track.title || ''}`.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  /** YouTube autoplay starts muted. Ask the player to turn the sound on once it accepts commands. */
  private armYoutubeSound(): void {
    this.stopYoutubeHandshake();
    this.ytApiListening = false;
    this.ytSoundArmed = false;
    this.ytHandshakeTries = 0;
    this.handshakeYoutube();
    this.pushYoutubeSound();
    this.ytHandshakeTimer = setInterval(() => {
      if (!this.youtubeEmbed || this.ytSoundArmed || this.ytHandshakeTries++ > 20) {
        this.stopYoutubeHandshake();
        return;
      }
      this.handshakeYoutube();
      this.pushYoutubeSound();
    }, 400);
  }

  private watchYoutubeClock(): void {
    this.stopYoutubeClock();
    const tick = (): void => {
      if (!this.youtubeEmbed) {
        this.stopYoutubeClock();
        return;
      }
      this.postYoutubeCommand('getCurrentTime');
    };
    tick();
    this.youtubeClock = setInterval(tick, 500);
  }

  private stopYoutubeClock(): void {
    if (this.youtubeClock != null) {
      clearInterval(this.youtubeClock);
      this.youtubeClock = undefined;
    }
  }

  private currentYoutubeId(): string {
    const fromTrack = this.current ? (this.ytLinks[this.current.id] || '').trim() : '';
    if (fromTrack) {
      return fromTrack;
    }
    const src = this.youtubeFrame()?.src || '';
    const match = src.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : '';
  }

  private pageAudio(): HTMLAudioElement | null {
    return this.adoptedAudio || this.audioRef?.nativeElement || null;
  }

  private stopYoutubeHandshake(): void {
    if (this.ytHandshakeTimer != null) {
      clearInterval(this.ytHandshakeTimer);
      this.ytHandshakeTimer = null;
    }
  }

  private handshakeYoutube(): void {
    const frame = this.youtubeFrame()?.contentWindow;
    if (!frame) {
      return;
    }
    try {
      frame.postMessage(JSON.stringify({ event: 'listening', id: 'dz-yt' }), '*');
    } catch {
      return;
    }
    if (!this.ytApiListening) {
      this.postYoutubeCommand('addEventListener', ['onReady']);
      this.postYoutubeCommand('addEventListener', ['onStateChange']);
      this.postYoutubeCommand('addEventListener', ['onError']);
    }
  }

  private pushYoutubeSound(): void {
    if (this.ytSoundArmed || !this.youtubeEmbed || !this.youtubeFrame()?.contentWindow) {
      return;
    }
    this.postYoutubeCommand('unMute');
    this.postYoutubeCommand('setVolume', [100]);
    this.postYoutubeCommand('playVideo');
  }

  private postYoutubeCommand(func: string, args: unknown[] = []): void {
    const frame = this.youtubeFrame()?.contentWindow;
    if (!frame) {
      return;
    }
    try {
      frame.postMessage(JSON.stringify({ event: 'command', func, args, id: 'dz-yt' }), '*');
    } catch {
      /* the frame is already gone */
    }
  }

  private readSleeve(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.SLEEVE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  private refreshQueue(): void {
    if (this.nowBrowse || (this.playing && this.current)) {
      return;
    }
    if (this.drilled || this.view === 'track' || this.activeUserPlaylist) {
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
    const filtering = this.listMode === 'favorites'
      || (this.listMode === 'playlists' && !!this.activeUserPlaylist);
    if (!filtering) {
      return true;
    }
    const q = this.query.trim().toLowerCase();
    return !q || (text || '').toLowerCase().includes(q);
  }

  private trackHay(track: DeezerTrack): string {
    return `${track.title || ''} ${track.artistName || ''} ${track.albumTitle || ''}`;
  }

  /** The catalog tab that actually holds starred items. Titles first. */
  private firstFavoriteView(): DeezerSearchType {
    if (this.favoriteTracks.length) {
      return 'track';
    }
    if (this.favoriteAlbums.length) {
      return 'album';
    }
    if (this.favoriteArtists.length) {
      return 'artist';
    }
    if (this.favoritePlaylists.length) {
      return 'playlist';
    }
    return 'track';
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
    if (!this.keycloak.isLoggedIn()) {
      this.favoritesHint = 'DEEZER.FAVORITES_LOGIN';
      if (this.listMode !== 'favorites') {
        this.setListMode('favorites');
      }
      return;
    }
    if (!this.favoritesReady || this.favoriteBusyKey) {
      return;
    }
    const key = `${next.kind}|${id}`;
    this.favoriteBusyKey = key;
    this.favoritesError = '';
    this.favoritesHint = '';
    const removing = this.isFavorite(next.kind, id);
    const req$ = removing
      ? this.api.removeDeezerFavorite(id, next.kind)
      : this.api.addDeezerFavorite(next);
    this.favoritesSub?.unsubscribe();
    this.favoritesSub = req$.subscribe({
      next: (fav) => {
        if (this.favoriteBusyKey === key) {
          this.favoriteBusyKey = '';
        }
        this.applyFavorites(fav?.items || []);
      },
      error: () => {
        if (this.favoriteBusyKey === key) {
          this.favoriteBusyKey = '';
        }
        this.favoritesError = 'DEEZER.ERR_FAVORITES_SAVE';
      }
    });
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

  private ensurePlaylistsLogin(): boolean {
    if (this.keycloak.isLoggedIn()) {
      return true;
    }
    this.playlistsHint = 'DEEZER.PLAYLISTS_LOGIN';
    if (this.listMode !== 'playlists') {
      this.setListMode('playlists');
    }
    return false;
  }

  private loadUserPlaylists(): void {
    if (!this.keycloak.isLoggedIn()) {
      this.userPlaylists = [];
      this.activeUserPlaylist = null;
      this.playlistsReady = true;
      return;
    }
    this.playlistsReady = false;
    this.playlistsError = '';
    this.playlistsSub?.unsubscribe();
    this.playlistsSub = this.api.getDeezerUserPlaylists().subscribe({
      next: (page) => {
        this.playlistsReady = true;
        this.applyUserPlaylists(page?.playlists || []);
      },
      error: () => {
        this.playlistsReady = true;
        this.playlistsError = 'DEEZER.ERR_PLAYLISTS_LOAD';
      }
    });
  }

  private applyUserPlaylists(items: DeezerUserPlaylist[], openId?: string): void {
    this.userPlaylists = this.cleanUserPlaylists(items);
    const targetId = openId || this.activeUserPlaylist?.id || '';
    this.activeUserPlaylist = targetId
      ? (this.userPlaylists.find((playlist) => playlist.id === targetId) || null)
      : null;
    if (this.keycloak.isLoggedIn()) {
      this.playlistsHint = '';
    }
    if (this.renamingPlaylistId && !this.userPlaylists.some((playlist) => playlist.id === this.renamingPlaylistId)) {
      this.renamingPlaylistId = '';
    }
    this.refreshQueue();
    if (this.listMode === 'playlists' || this.activeUserPlaylist) {
      this.ytScanKey = '';
      this.syncYoutubeButtons();
    }
  }

  private cleanUserPlaylists(items: DeezerUserPlaylist[]): DeezerUserPlaylist[] {
    return (items || [])
      .filter((playlist) => !!playlist?.id && !!(playlist.name || '').trim())
      .map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        tracks: (playlist.tracks || []).filter((track) => !!track?.id && !!(track.title || '').trim())
      }));
  }

  private loadFavorites(): void {
    if (!this.keycloak.isLoggedIn()) {
      this.favorites = [];
      this.favoritesReady = true;
      this.favoritesHint = 'DEEZER.FAVORITES_LOGIN';
      return;
    }
    const local = this.readLocalFavorites();
    this.favoritesReady = false;
    this.favoritesError = '';
    this.favoritesSub?.unsubscribe();
    this.favoritesSub = this.api.getDeezerFavorites().subscribe({
      next: (fav) => {
        const remote = this.cleanFavorites(fav?.items || []);
        if (this.localMissingOnServer(local, remote)) {
          const merged = this.mergeFavorites(local, remote);
          this.favoritesSub = this.api.saveDeezerFavorites({ items: merged }).subscribe({
            next: (saved) => {
              this.clearLocalFavorites();
              this.favoritesReady = true;
              this.applyFavorites(saved?.items || merged);
            },
            error: () => {
              this.favoritesReady = true;
              this.favoritesError = 'DEEZER.ERR_FAVORITES_SAVE';
              this.applyFavorites(remote.length ? remote : local);
            }
          });
          return;
        }
        if (local.length) {
          this.clearLocalFavorites();
        }
        this.favoritesReady = true;
        this.applyFavorites(remote);
      },
      error: () => {
        this.favoritesReady = true;
        this.favoritesError = 'DEEZER.ERR_FAVORITES_LOAD';
        if (local.length) {
          this.applyFavorites(local);
        }
      }
    });
  }

  private applyFavorites(items: DzFav[]): void {
    this.favorites = this.cleanFavorites(items);
    if (this.keycloak.isLoggedIn()) {
      this.favoritesHint = '';
    }
    if (this.listMode !== 'favorites') {
      return;
    }
    const still = this.view === 'track' ? this.favoriteTracks.length
      : this.view === 'album' ? this.favoriteAlbums.length
        : this.view === 'artist' ? this.favoriteArtists.length
          : this.favoritePlaylists.length;
    if (!still) {
      this.view = this.firstFavoriteView();
    }
    this.refreshQueue();
    this.ytScanKey = '';
    this.syncYoutubeButtons();
  }

  private cleanFavorites(items: DzFav[]): DzFav[] {
    return (items || []).filter((fav) => fav && fav.kind && this.favId(fav) > 0);
  }

  private mergeFavorites(local: DzFav[], remote: DzFav[]): DzFav[] {
    const out: DzFav[] = [];
    const seen = new Set<string>();
    for (const fav of [...local, ...remote]) {
      const id = this.favId(fav);
      if (!fav?.kind || !id) {
        continue;
      }
      const key = `${fav.kind}|${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(fav);
    }
    return out;
  }

  private localMissingOnServer(local: DzFav[], remote: DzFav[]): boolean {
    const keys = new Set(remote.map((fav) => `${fav.kind}|${this.favId(fav)}`));
    return local.some((fav) => !keys.has(`${fav.kind}|${this.favId(fav)}`));
  }

  private readLocalFavorites(): DzFav[] {
    try {
      const raw = JSON.parse(localStorage.getItem(DeezerWatcherComponent.FAV_KEY) || '[]');
      if (!Array.isArray(raw)) {
        return [];
      }
      return this.cleanFavorites(raw);
    } catch {
      return [];
    }
  }

  private clearLocalFavorites(): void {
    try {
      localStorage.removeItem(DeezerWatcherComponent.FAV_KEY);
    } catch {
      /* ignore */
    }
  }
}
