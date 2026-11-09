import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostBinding, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Observable, of, Subject, Subscription } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, finalize, shareReplay, takeUntil, tap } from 'rxjs/operators';

import {
  ApiService,
  AudioDbDossier,
  DeezerAlbum,
  DeezerAlbumPage,
  DeezerArtist,
  DeezerConcertTrack,
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
import { NowTickerComponent, NowTickerItem } from '../shared/now-ticker.component';
import { VideoshowCloseState, VideoshowModalComponent, VideoshowVideoSource } from '../shared/videoshow-modal/videoshow-modal.component';

type DzMode = 'chart' | 'search';
type DzListMode = 'browse' | 'favorites' | 'playlists' | 'concert';
type DzListSortId = 'tracks' | 'concert' | 'playlists' | 'albums' | 'artistAlbums' | 'artists' | 'deezerPlaylists';
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
  imports: [CommonModule, FormsModule, RouterLink, TranslateModule, YoutubeEqualizerModalComponent, NowTickerComponent, VideoshowModalComponent],
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
  private static readonly SLEEVE_FRONT_KEY = 'pattool.deezer.sleeveFront';
  private static readonly SKIN_KEY = 'pattool.deezer.skin';
  private static readonly PRESET_KEY = 'pattool.deezer.presets';
  private static readonly KEEP_KEY = 'pattool.deezer.keep-alive';
  private static readonly PRESET_COUNT = 12;

  @ViewChild('audio') audioRef?: ElementRef<HTMLAudioElement>;
  @ViewChild('ytFrame') ytFrame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('keptYtHost') keptYtHost?: ElementRef<HTMLElement>;
  @ViewChild('playerPanel') playerPanelEl?: ElementRef<HTMLElement>;
  @ViewChild('eqModal') eqModal?: YoutubeEqualizerModalComponent;
  @ViewChild('videoshowModalComponent') videoshowModalComponent?: VideoshowModalComponent;
  videoshowAccent = '';
  private videoshowResume = false;
  private videoshowPageAt = 0;
  /** Timecode to apply on the next clip load. playTrack clears pendingClipSeek. */
  private videoshowHandoffSec = -1;

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
  recentSearches: string[] = [];
  recentOpen = false;
  recentActiveIndex = -1;
  private queryFocused = false;
  private recentBlurTimer: ReturnType<typeof setTimeout> | null = null;
  view: DeezerSearchType = 'track';
  mode: DzMode = 'chart';
  private catalogIndex: Record<DeezerSearchType, number> = { track: 0, album: 0, artist: 0, playlist: 0 };
  private catalogTotal: Record<DeezerSearchType, number> = { track: 0, album: 0, artist: 0, playlist: 0 };
  private catalogNext: Record<DeezerSearchType, boolean> = { track: false, album: false, artist: false, playlist: false };
  /** A further page came back empty, so this tab has no page after the current one. */
  private catalogBlocked: Record<DeezerSearchType, boolean> = { track: false, album: false, artist: false, playlist: false };
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
  private playbackListMode: DzListMode | null = null;
  private playPendingList = false;
  sleeveAlbums: DeezerAlbum[] = [];
  related: DeezerArtist[] = [];

  current: DeezerTrack | null = null;
  tickerEnabled = false;
  private static readonly TICKER_KEY = 'pattool.deezer.ticker-enabled';
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
  /** Cover sits over the dial, speaker and screen motion. */
  sleeveFront = true;
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
  private youtubePauseDecideTimer: ReturnType<typeof setTimeout> | null = null;
  /** When we last asked the clip to play. A following state 1 is ours, not the YouTube button. */
  private youtubeCommandPlayAt = 0;
  private audioSessionClaimed = false;
  private sleepKickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last time the queue moved to another title, so a sleep retry does not skip one. */
  private lastQueueAdvanceAt = 0;
  private readonly onScreenPower = (): void => this.keepPlayingThroughSleep();
  private readonly onBluetoothTune = (event: Event): void => this.onLockScreenTune(event);
  private readonly onYoutubeWindowMessage = (event: MessageEvent): void => this.onYoutubeMessage(event);
  docked = false;
  isPipActive = false;
  trackImageIndex = 0;
  presets: (DeezerTrack | null)[] = [];
  sidebarCollapsed = false;
  filterOpen = false;
  hideExplicit = false;
  previewOnly = false;
  listMode: DzListMode = 'browse';
  /** Album tracks, or the playing artist's albums, opened from any tab without taking over playback. */
  nowBrowse: 'album' | 'artist-albums' | null = null;
  nowBrowseTitle = '';
  nowBrowseSubtitle = '';
  nowBrowseTracks: DeezerTrack[] = [];
  nowBrowseAlbums: DeezerAlbum[] = [];
  listSortOpen = false;
  private readonly listSorts: Record<DzListSortId, { key: string; desc: boolean }> = {
    tracks: { key: 'order', desc: false },
    concert: { key: 'order', desc: false },
    playlists: { key: 'order', desc: false },
    albums: { key: 'order', desc: false },
    artistAlbums: { key: 'year', desc: true },
    artists: { key: 'order', desc: false },
    deezerPlaylists: { key: 'order', desc: false }
  };
  readonly listSortChoices: Record<DzListSortId, ReadonlyArray<{ id: string; key: string }>> = {
    tracks: [
      { id: 'order', key: 'DEEZER.SORT_ORDER' },
      { id: 'title', key: 'DEEZER.SORT_TITLE' },
      { id: 'artist', key: 'DEEZER.SORT_ARTIST' },
      { id: 'album', key: 'DEEZER.SORT_ALBUM' },
      { id: 'year', key: 'DEEZER.ALBUM_BY_YEAR' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' },
      { id: 'duration', key: 'DEEZER.SORT_DURATION' }
    ],
    concert: [
      { id: 'order', key: 'DEEZER.SORT_ORDER' },
      { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
      { id: 'title', key: 'DEEZER.SORT_TITLE' },
      { id: 'artist', key: 'DEEZER.SORT_ARTIST' },
      { id: 'album', key: 'DEEZER.SORT_ALBUM' },
      { id: 'year', key: 'DEEZER.ALBUM_BY_YEAR' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' }
    ],
    playlists: [
      { id: 'order', key: 'DEEZER.SORT_ORDER' },
      { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' },
      { id: 'tracks', key: 'DEEZER.ALBUM_BY_TRACKS' }
    ],
    albums: [
      { id: 'order', key: 'DEEZER.SORT_ORDER' },
      { id: 'name', key: 'DEEZER.SORT_ALBUM' },
      { id: 'artist', key: 'DEEZER.SORT_ARTIST' },
      { id: 'year', key: 'DEEZER.ALBUM_BY_YEAR' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' },
      { id: 'tracks', key: 'DEEZER.ALBUM_BY_TRACKS' }
    ],
    artistAlbums: [
      { id: 'year', key: 'DEEZER.ALBUM_BY_YEAR' },
      { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
      { id: 'artist', key: 'DEEZER.SORT_ARTIST' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' },
      { id: 'tracks', key: 'DEEZER.ALBUM_BY_TRACKS' }
    ],
    artists: [
      { id: 'order', key: 'DEEZER.SORT_ORDER' },
      { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' },
      { id: 'albums', key: 'DEEZER.SORT_ALBUMS' }
    ],
    deezerPlaylists: [
      { id: 'order', key: 'DEEZER.SORT_ORDER' },
      { id: 'name', key: 'DEEZER.SIMILAR_BY_NAME' },
      { id: 'user', key: 'DEEZER.SORT_USER' },
      { id: 'fans', key: 'DEEZER.SIMILAR_BY_FANS' },
      { id: 'tracks', key: 'DEEZER.ALBUM_BY_TRACKS' }
    ]
  };
  private nowBrowseFrom: 'artist-albums' | null = null;
  private nowArtistName = '';
  favorites: DzFav[] = [];
  favoritesHint = '';
  favoritesError = '';
  favoriteBusyKey = '';
  userPlaylists: DeezerUserPlaylist[] = [];
  activeUserPlaylist: DeezerUserPlaylist | null = null;
  concertItems: DeezerConcertTrack[] = [];
  concertNameTrack: DeezerTrack | null = null;
  concertNameDraft = '';
  concertRenameDraft = '';
  renamingConcertId = '';
  confirmDeleteConcertId = '';
  concertHint = '';
  concertError = '';
  concertBusy = '';
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
  albumInfoOpen = false;
  albumInfoLoading = false;
  albumInfoError = '';
  albumInfo: DeezerAlbumPage | null = null;
  audioDbLoading = false;
  audioDbError = '';
  audioDb: AudioDbDossier | null = null;
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
  /** Result list for a track, so the next YouTube click does not search again. */
  private readonly ytChoices = new Map<number, string[]>();
  /** Titles whose "2 / 10" badge was dismissed by keep or drop. */
  private readonly ytPlaceOff = new Set<number>();
  ytFromCache: Record<number, boolean> = {};
  ytMiss: Record<number, boolean> = {};
  ytPending: Record<number, boolean> = {};
  /** Spinner on the pastille while the next YouTube result is loading. */
  ytNextBusy: Record<number, boolean> = {};
  /** Spinner on the “+10” button while the next page of clips is loading. */
  ytMoreBusy: Record<number, boolean> = {};
  /** Spinner on the button that drops one clip from this title's list. */
  ytDropBusy: Record<string, boolean> = {};
  /** Spinner on the button that drops this title's stored YouTube list. */
  ytClearBusy: Record<number, boolean> = {};
  /** Title and channel already loaded for the clips shown in the list modal. */
  ytClipInfo: Record<string, { title?: string; author?: string }> = {};
  private readonly ytClipAsked = new Set<string>();
  /** Track whose stored YouTube links are open in the list modal. */
  ytListTrack: DeezerTrack | null = null;
  /** Narrows the open YouTube link list by title, channel, or video id. */
  ytListQuery = '';
  /** Restart the track list from the first title when it reaches the end. */
  listLoop = true;
  /** Restart the open YouTube link list from the first clip when it reaches the end. */
  ytListLoop = true;
  /** Clips of one title playing in order from the list's play-all button. */
  private ytListRun: { trackId: number; ids: string[]; index: number } | null = null;
  /** Clip asked by play-all, played once without replacing the menu's saved link. */
  private ytListPlayId = '';
  /** True while play-all itself starts the next clip, so that start does not cancel the run. */
  private ytListAdvancing = false;
  /** Titles whose YouTube list has no further page. */
  private readonly ytMoreOff = new Set<number>();
  /** Spinner kept visible on a click that already has its clip, so the button still turns. */
  private ytSpin: Record<number, boolean> = {};
  private readonly ytSpinGen = new Map<number, number>();
  /** Candidate video, not saved until the green control is used. */
  ytOffer: { trackId: number; videoId: string; savedId: string } | null = null;
  loading = false;
  errorKey = '';
  playErrorKey = '';

  private shelf: DzShelf | null = null;
  private sleeveArtistId = 0;
  private queueIndexHint = -1;
  /** True once a background session was put back on this visit, so the chart load does not replace it. */
  private resumedKeep = false;
  /** YouTube reported the current video as finished, so Lecture must not start it again. */
  private youtubeEnded = false;
  /** Ignore the pause a moved frame emits while it is put back on the page. */
  private resumeHoldUntil = 0;
  keptFrameActive = false;
  private keptFrame: HTMLIFrameElement | null = null;
  private sleeveTimer: ReturnType<typeof setTimeout> | null = null;
  private sleeveSub: Subscription | null = null;
  private previewFresh = false;
  /** Bumps when a clip takes the sound, so a late preview response cannot start under the video. */
  private previewToken = 0;
  /**
   * A YouTube clip is the soundtrack. The 30 s preview stays silent until that clip is given up,
   * so the picture and the sound stay on the player's one clock.
   */
  private clipArmed = false;
  /** Video picture size. 16×9 until YouTube reports the real frame. */
  clipAspectW = 16;
  clipAspectH = 9;
  private clipAspectId = '';
  private readonly clipAspectCache = new Map<string, { w: number; h: number }>();
  /** Resume position for a clip put back on the page. Applied once, when the player can seek. */
  private pendingClipSeek = -1;
  private clipSeekSent = false;
  private loadSeq = 0;
  private trackSlideTimer: ReturnType<typeof setInterval> | null = null;
  private ytSub: Subscription | null = null;
  private ytPrefetch: Subscription | null = null;
  private ytScan: Subscription | null = null;
  private ytScanKey = '';
  /** Clicks search one title. The list scan waits so it does not occupy YouTube at the same time. */
  private ytScanHold = 0;
  private ytScanRest: { tracks: DeezerTrack[]; index: number; key: string } | null = null;
  private pointerOverPlayer = false;
  private videoSwipeOn = false;
  private videoSwipeX = 0;
  private videoSwipeY = 0;
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
  /** Last state reported by the YouTube player. 1 is playing, 2 is paused. */
  private youtubePlayerState = -1;
  private repeatQueue = true;
  private readonly ytCache = new Map<number, string | null>();
  private readonly search$ = new Subject<string>();
  private readonly destroy$ = new Subject<void>();
  private favoritesSub?: Subscription;
  private favoritesReady = false;
  private playlistsSub?: Subscription;
  private concertSub?: Subscription;
  private playlistsReady = false;
  private playlistTrackIds = new Set<number>();
  private favoriteTrackIds = new Set<number>();
  private playlistVideoIds = new Set<string>();
  private favoriteVideoIds = new Set<string>();
  private concertVideoIds = new Set<string>();
  private membershipLooked = new Set<number>();
  private membershipSub?: Subscription;
  private membershipEpoch = 0;
  private concertReady = false;
  private concertEpoch = 0;
  private similarSub?: Subscription;
  private similarForId = 0;
  private readonly similarCache = new Map<number, DeezerArtist[]>();
  private readonly artistAlbumsCache = new Map<number, DeezerAlbum[]>();
  private readonly artistAlbumRequests = new Map<number, Observable<DeezerAlbum[]>>();
  private readonly relatedRequests = new Map<number, Observable<DeezerArtist[]>>();
  private readonly albumRequests = new Map<number, Observable<DeezerAlbumPage>>();
  private readonly audioRequests = new Map<string, Observable<AudioDbDossier>>();
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private warmKey = '';
  private albumInfoForId = 0;
  private albumInfoSub?: Subscription;
  private readonly albumInfoCache = new Map<number, DeezerAlbumPage>();
  private audioDbSub?: Subscription;
  private audioDbForKey = '';
  private readonly audioDbCache = new Map<string, AudioDbDossier>();
  private static readonly SIDEBAR_KEY = 'pattool.deezer.sidebar';
  private static readonly YT_SEARCH_KEY = 'pattool.deezer.youtube-search';
  private static readonly FILTER_KEY = 'pattool.deezer.filter';
  private static readonly RECENT_KEY = 'pattool.deezer.recent-searches';
  private static readonly RECENT_MAX = 8;
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
    private route: ActivatedRoute,
    private translate: TranslateService,
    private sanitizer: DomSanitizer,
    private keycloak: KeycloakService,
    private cdr: ChangeDetectorRef,
    private keepAlive: DeezerKeepAliveService,
    private zone: NgZone
  ) {}

  ngOnInit(): void {
    this.volume = this.readVolume();
    this.sleeveOpen = this.readSleeve();
    this.sleeveFront = this.readSleeveFront();
    this.restoreSkinPreference();
    this.tickerEnabled = this.readTickerEnabled();
    this.keepAliveOnNavigate = this.readKeepAlive();
    this.presets = this.readPresets();
    this.sidebarCollapsed = this.readSidebar();
    this.readFilter();
    this.recentSearches = this.readRecentSearches();
    this.genresOpen = false;
    try {
      localStorage.setItem(DeezerWatcherComponent.GENRES_KEY, '0');
    } catch {
      /* ignore */
    }
    this.youtubeSearchEnabled = this.readYoutubeSearch();
    this.loadFavorites();
    this.loadUserPlaylists();
    this.loadConcert();
    this.search$.pipe(
      debounceTime(320),
      distinctUntilChanged(),
      takeUntil(this.destroy$)
    ).subscribe((q) => this.runQuery(q));
    this.loadGenres();
    const params = this.route.snapshot.queryParamMap;
    const incomingQuery = (params.get('q') || '').trim();
    const incomingView = params.get('view');
    if (incomingView === 'track' || incomingView === 'album' || incomingView === 'artist' || incomingView === 'playlist') {
      this.view = incomingView;
    }
    if (incomingQuery.length >= 2) {
      this.query = incomingQuery;
      this.loadSearch(incomingQuery);
    } else {
      this.loadChart();
    }
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();
    window.addEventListener('patradioscreen', this.onScreenPower);
    window.addEventListener('patradiotransport', this.onBluetoothTune);
    document.addEventListener('visibilitychange', this.onScreenPower);
    this.zone.runOutsideAngular(() => {
      window.addEventListener('message', this.onYoutubeWindowMessage);
    });
  }

  ngAfterViewInit(): void {
    this.resumeKeptPlayback();
  }

  ngOnDestroy(): void {
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = null;
    }
    this.rememberRecentSearch(this.query);
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    window.removeEventListener('patradioscreen', this.onScreenPower);
    window.removeEventListener('patradiotransport', this.onBluetoothTune);
    document.removeEventListener('visibilitychange', this.onScreenPower);
    window.removeEventListener('message', this.onYoutubeWindowMessage);
    this.clearSleepKick();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.sleeveTimer) {
      clearTimeout(this.sleeveTimer);
    }
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
    this.clearTrackSlide();
    this.clearChromeHideTimer();
    this.ytSub?.unsubscribe();
    this.ytPrefetch?.unsubscribe();
    this.ytScan?.unsubscribe();
    this.favoritesSub?.unsubscribe();
    this.playlistsSub?.unsubscribe();
    this.concertSub?.unsubscribe();
    this.membershipSub?.unsubscribe();
    this.similarSub?.unsubscribe();
    this.albumInfoSub?.unsubscribe();
    this.audioDbSub?.unsubscribe();
    this.skinLoadSub?.unsubscribe();
    this.skinSaveSub?.unsubscribe();
    this.stopYoutubeClock();
    this.stopYoutubeHandshake();
    this.sleeveSub?.unsubscribe();
    document.body.classList.remove('radio-focus', 'radio-stage-fs', 'radio-landscape-fs');
    const audio = this.pageAudio();
    const frame = this.youtubeFrame();
    const keepAudio = !!(audio && !this.clipOnStage && !audio.paused);
    const keepVideo = !!(frame && this.clipOnStage);
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
      return this.sortTracks(this.nowBrowseTracks.filter((track) => this.passTrack(track)));
    }
    const source = this.activeUserPlaylist
      ? (this.activeUserPlaylist.tracks || [])
      : (this.listMode === 'favorites' && !this.drilled ? this.favoriteTracks : this.tracks);
    return this.sortTracks(source.filter((track) => this.passTrack(track) && this.matchesFavoriteQuery(this.trackHay(track))));
  }

  /** Titles the Lecture button can start for the tab on screen. */
  get tabHasTracks(): boolean {
    if (this.listMode === 'concert') {
      return this.shownConcert.length > 0;
    }
    if (this.listMode === 'playlists' && !this.activeUserPlaylist) {
      return this.playlistTabTracks().length > 0;
    }
    return this.shownTracks.length > 0;
  }

  /** Play / pause / next for the list on screen. */
  get transportTracks(): boolean {
    if (this.nowBrowse === 'artist-albums') {
      return false;
    }
    if (this.listMode === 'concert' && !this.nowBrowse) {
      return this.shownConcert.length > 0;
    }
    return this.showTrackList && this.shownTracks.length > 0;
  }

  get showCatalogPager(): boolean {
    return this.listMode === 'browse'
      && !this.drilled
      && !this.nowBrowse
      && (this.catalogIndex[this.view] > 0 || this.catalogNext[this.view]);
  }

  get catalogPageShown(): number {
    return this.catalogPageCount();
  }

  /** Page size over the furthest rank reached. Page 3 of a chart is 100/300. */
  get catalogReached(): number {
    return Math.max(this.catalogTotal[this.view] || 0, this.catalogIndex[this.view] + this.catalogPageCount());
  }

  /** Favorites keep a plain count. Classement shows its size on the mode tab. */
  favoriteTabCount(shown: number): string {
    if (!shown || this.listMode !== 'favorites') {
      return '';
    }
    return String(shown);
  }

  /** Items in the classement list for the open category. */
  get chartCount(): number {
    if (this.view === 'album') {
      return this.albums.length;
    }
    if (this.view === 'artist') {
      return this.artists.length;
    }
    if (this.view === 'playlist') {
      return this.playlists.length;
    }
    return this.tracks.filter((track) => this.passTrack(track)).length;
  }

  get catalogHasNext(): boolean {
    return this.catalogNext[this.view];
  }

  get catalogAtStart(): boolean {
    return this.catalogIndex[this.view] <= 0;
  }

  pageCatalog(step: number): void {
    if (this.loading || this.listMode !== 'browse' || this.drilled || this.nowBrowse) {
      return;
    }
    const view = this.view;
    const next = this.catalogIndex[view] + step * 100;
    if (next < 0 || (step > 0 && !this.catalogNext[view])) {
      return;
    }
    this.catalogIndex = { ...this.catalogIndex, [view]: next };
    const query = this.query.trim();
    if (query.length >= 2) {
      this.loadSearch(query);
      return;
    }
    this.loadChart();
  }

  trackRowNumber(index: number): number {
    if (this.listMode === 'browse' && !this.drilled && !this.nowBrowse) {
      return this.catalogIndex.track + index + 1;
    }
    return index + 1;
  }

  private catalogPageCount(): number {
    return this.pageCount(this.view);
  }

  private pageCount(type: DeezerSearchType): number {
    if (type === 'album') {
      return this.albums.length;
    }
    if (type === 'artist') {
      return this.artists.length;
    }
    if (type === 'playlist') {
      return this.playlists.length;
    }
    return this.tracks.length;
  }

  private resetCatalogPages(): void {
    this.catalogIndex = { track: 0, album: 0, artist: 0, playlist: 0 };
    this.catalogTotal = { track: 0, album: 0, artist: 0, playlist: 0 };
    this.catalogNext = { track: false, album: false, artist: false, playlist: false };
    this.catalogBlocked = { track: false, album: false, artist: false, playlist: false };
  }

  private rememberCatalogPage(
    type: DeezerSearchType,
    index: number | undefined,
    total: number | undefined,
    hasNext: boolean | undefined,
    count: number
  ): void {
    const start = Number.isFinite(index) ? Number(index) : this.catalogIndex[type];
    const knownTotal = Number(total) || 0;
    const reported = typeof hasNext === 'boolean' ? hasNext : knownTotal > start + count;
    const more = this.catalogBlocked[type] ? false : reported || count >= 95;
    this.catalogIndex = { ...this.catalogIndex, [type]: start };
    this.catalogTotal = { ...this.catalogTotal, [type]: knownTotal };
    this.catalogNext = { ...this.catalogNext, [type]: more };
  }

  /** Deezer charts keep paging after they report a total of 100. An empty page is the end. */
  private rewindEmptyCatalogPages(pages: { type: DeezerSearchType; index: number | undefined; count: number }[]): boolean {
    let rewind = false;
    for (const page of pages) {
      const start = Number.isFinite(page.index) ? Number(page.index) : this.catalogIndex[page.type];
      if (page.count > 0 || start <= 0) {
        continue;
      }
      this.catalogBlocked = { ...this.catalogBlocked, [page.type]: true };
      this.catalogNext = { ...this.catalogNext, [page.type]: false };
      this.catalogIndex = { ...this.catalogIndex, [page.type]: start - 100 };
      rewind = true;
    }
    if (!rewind) {
      return false;
    }
    const query = this.query.trim();
    if (query.length >= 2) {
      this.loadSearch(query);
    } else {
      this.loadChart();
    }
    return true;
  }

  private scrollCatalogList(): void {
    const list = this.hostRef.nativeElement.querySelector('.dz-list');
    if (list) {
      list.scrollTop = 0;
    }
  }

  get showTrackList(): boolean {
    if (this.listMode === 'concert') {
      return false;
    }
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
    const q = this.listMode === 'playlists' && !this.activeUserPlaylist ? this.foldSearch(this.query) : '';
    const source = !q
      ? this.userPlaylists
      : this.userPlaylists.filter((playlist) => this.foldSearch(playlist.name).includes(q));
    return this.sortPlaylists(source);
  }

  get playlistCount(): number {
    return this.userPlaylists.length;
  }

  get concertCount(): number {
    return this.concertItems.length;
  }

  get shownConcert(): DeezerConcertTrack[] {
    const q = this.listMode === 'concert' ? this.foldSearch(this.query) : '';
    const source = !q
      ? this.concertItems
      : this.concertItems.filter((item) => this.foldSearch(this.concertHay(item)).includes(q));
    return this.sortConcert(source);
  }

  get searchPlaceholderKey(): string {
    if (this.listMode === 'favorites') {
      return 'DEEZER.FAV_FILTER';
    }
    if (this.listMode === 'playlists') {
      return 'DEEZER.PLAYLIST_FILTER';
    }
    if (this.listMode === 'concert') {
      return 'DEEZER.CONCERT_FILTER';
    }
    return 'DEEZER.SEARCH_PLACEHOLDER';
  }

  get playlistPickerChoices(): DeezerUserPlaylist[] {
    const q = this.foldSearch(this.playlistPickerQuery);
    if (!q) {
      return this.userPlaylists;
    }
    return this.userPlaylists.filter((playlist) => this.foldSearch(playlist.name).includes(q));
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
    return this.sortAlbums(source.filter((album) => this.matchesFavoriteQuery(`${album.title} ${album.artistName}`)), 'albums');
  }

  get shownArtists(): DeezerArtist[] {
    const source = this.listMode === 'favorites' && !this.drilled ? this.favoriteArtists : this.artists;
    return this.sortArtists(source.filter((artist) => this.matchesFavoriteQuery(artist.name)));
  }

  get shownPlaylists(): DeezerPlaylist[] {
    const source = this.listMode === 'favorites' && !this.drilled ? this.favoritePlaylists : this.playlists;
    return this.sortDeezerPlaylists(source.filter((playlist) => this.matchesFavoriteQuery(`${playlist.title} ${playlist.userName}`)));
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
    this.recentActiveIndex = -1;
    if (this.queryFocused) {
      this.recentOpen = this.filteredRecentSearches().length > 0;
    }
    this.search$.next(value.trim());
  }

  onQueryFocus(): void {
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
      this.recentBlurTimer = null;
    }
    this.queryFocused = true;
    this.recentOpen = this.filteredRecentSearches().length > 0;
  }

  onQueryBlur(): void {
    this.queryFocused = false;
    this.rememberRecentSearch(this.query);
    if (this.recentBlurTimer) {
      clearTimeout(this.recentBlurTimer);
    }
    this.recentBlurTimer = setTimeout(() => {
      this.recentBlurTimer = null;
      this.recentOpen = false;
      this.recentActiveIndex = -1;
    }, 120);
  }

  filteredRecentSearches(): string[] {
    const q = this.foldSearch(this.query);
    if (!q) {
      return this.recentSearches;
    }
    return this.recentSearches.filter((term) => {
      const folded = this.foldSearch(term);
      return folded.includes(q) && folded !== q;
    });
  }

  applyRecentSearch(term: string): void {
    const value = (term || '').trim();
    if (!value) {
      return;
    }
    this.queryFocused = true;
    this.recentActiveIndex = -1;
    this.onQueryChange(value);
    this.recentOpen = false;
    this.rememberRecentSearch(value);
  }

  removeRecentSearch(term: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.recentSearches = this.recentSearches.filter((item) => item !== term);
    this.writeRecentSearches(this.recentSearches);
    this.recentOpen = this.filteredRecentSearches().length > 0;
    if (this.recentActiveIndex >= this.filteredRecentSearches().length) {
      this.recentActiveIndex = this.filteredRecentSearches().length - 1;
    }
  }

  onQueryKeydown(event: KeyboardEvent): void {
    const list = this.filteredRecentSearches();
    if (event.key === 'Escape') {
      this.recentOpen = false;
      this.recentActiveIndex = -1;
      return;
    }
    if (event.key === 'ArrowDown') {
      if (!list.length) {
        return;
      }
      event.preventDefault();
      this.recentOpen = true;
      this.recentActiveIndex = Math.min(this.recentActiveIndex + 1, list.length - 1);
      if (this.recentActiveIndex < 0) {
        this.recentActiveIndex = 0;
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      if (!this.recentOpen || !list.length) {
        return;
      }
      event.preventDefault();
      this.recentActiveIndex = this.recentActiveIndex <= 0 ? -1 : this.recentActiveIndex - 1;
      return;
    }
    if (event.key === 'Enter') {
      if (this.recentOpen && this.recentActiveIndex >= 0 && list[this.recentActiveIndex]) {
        event.preventDefault();
        this.applyRecentSearch(list[this.recentActiveIndex]);
        return;
      }
      this.rememberRecentSearch(this.query);
      this.recentOpen = false;
      this.recentActiveIndex = -1;
    }
  }

  clearQuery(): void {
    this.query = '';
    this.recentActiveIndex = -1;
    this.recentOpen = this.queryFocused && this.recentSearches.length > 0;
    this.search$.next('');
  }

  toggleSidebarCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    try {
      localStorage.setItem(DeezerWatcherComponent.SIDEBAR_KEY, this.sidebarCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (!this.sidebarCollapsed && this.current?.id) {
      setTimeout(() => this.placePlayingTrackFirst());
    }
  }

  /** After the menu or a tab comes back, the title on stage is the first row in view. */
  private revealPlayingRow(): void {
    if (!this.current?.id) {
      return;
    }
    setTimeout(() => this.placePlayingTrackFirst());
  }

  private placePlayingTrackFirst(): void {
    const row = this.hostRef.nativeElement.querySelector('.dz-list .dz-row.is-on') as HTMLElement | null;
    const list = row?.parentElement;
    if (!row || !list) {
      return;
    }
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (top > 1 || top < -1) {
      list.scrollTop += top;
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

  setListMode(mode: DzListMode): void {
    if (this.listMode === mode) {
      return;
    }
    this.listSortOpen = false;
    this.listMode = mode;
    this.playbackFollowsList = this.playbackListMode === mode;
    this.playPendingList = false;
    this.loadSeq++;
    this.clearNowBrowse();
    this.activeUserPlaylist = null;
    this.playlistMenuTrack = null;
    this.renamingPlaylistId = '';
    this.confirmDeletePlaylistId = '';
    this.renamingConcertId = '';
    this.confirmDeleteConcertId = '';
    this.exitDrill();
    if (mode === 'concert') {
      this.loading = false;
      this.errorKey = '';
      if (!this.keycloak.isLoggedIn()) {
        this.concertHint = 'DEEZER.CONCERT_LOGIN';
      }
      this.pinConcertVideos();
      this.refreshQueue();
      this.revealPlayingRow();
      return;
    }
    if (mode === 'playlists') {
      this.loading = false;
      this.errorKey = '';
      if (!this.keycloak.isLoggedIn()) {
        this.playlistsHint = 'DEEZER.PLAYLISTS_LOGIN';
      }
      this.refreshQueue();
      this.revealPlayingRow();
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
      this.revealPlayingRow();
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
    if (this.listMode === 'concert') {
      this.pinConcertVideos();
    }
    this.claimPlaybackTab();
    this.playbackFollowsList = true;
    this.playPendingList = false;
    this.resumedKeep = false;
    this.youtubeMode = true;
    this.clearYoutube();
    this.repeatQueue = this.listLoop;
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
    return this.clipOnStage || this.youtubeBusy ? 'youtube' : 'deezer';
  }

  /** The clip is what the listener hears. A parked player can stay up under a Deezer preview. */
  get clipOnStage(): boolean {
    return this.clipArmed && (!!this.youtubeEmbed || this.keptFrameActive);
  }

  /**
   * Lecture starts the list on screen from its first title.
   * Pause only while that same list is the one already playing.
   * A session restored by Continuer resumes, or moves on if that title already finished.
   */
  playPauseListed(): void {
    if (this.current && (this.playing || this.userHold || this.clipOnStage)) {
      this.playbackFollowsList = true;
      this.togglePlay();
      return;
    }
    if (this.restoredSessionOnScreen()) {
      this.resumeRestored();
      return;
    }
    this.playListedFromStart();
  }

  /** Pause only while the list on screen is the one playing. Any other list shows Lecture. */
  get tabListPlaying(): boolean {
    return this.playing && this.tabQueueIsLive();
  }

  /**
   * Moving bars for the title that is playing.
   * A concert copy and its Deezer source count as the same title, in every tab.
   */
  rowIsLive(id: number | null | undefined): boolean {
    return !!this.playing && this.rowIsCurrent(id);
  }

  /** This row is the title on stage, including a concert copy of it. */
  rowIsCurrent(id: number | null | undefined): boolean {
    if (!id || !this.current?.id) {
      return false;
    }
    return this.samePlayingTitle(id, this.current.id);
  }

  albumIsLive(albumId: number | null | undefined): boolean {
    return !!this.playing && this.albumIsCurrent(albumId);
  }

  albumIsCurrent(albumId: number | null | undefined): boolean {
    return !!albumId && albumId === this.current?.albumId;
  }

  artistIsLive(artistId: number | null | undefined): boolean {
    return !!this.playing && this.artistIsCurrent(artistId);
  }

  artistIsCurrent(artistId: number | null | undefined): boolean {
    return !!artistId && artistId === this.current?.artistId;
  }

  playlistIsLive(playlist: DeezerUserPlaylist | null | undefined): boolean {
    return !!this.playing && this.playlistIsCurrent(playlist);
  }

  playlistIsCurrent(playlist: DeezerUserPlaylist | null | undefined): boolean {
    return !!playlist && (playlist.tracks || []).some((track) => this.rowIsCurrent(track.id));
  }

  /** Classement, Favoris, Playlists or Concert contains the title that is playing. */
  modeHasLive(mode: DzListMode): boolean {
    if (!this.playing || !this.current) {
      return false;
    }
    if (mode === 'concert') {
      return this.concertItems.some((item) => this.rowIsLive(item.playId));
    }
    if (mode === 'playlists') {
      return this.userPlaylists.some((playlist) => this.playlistIsLive(playlist));
    }
    if (mode === 'favorites') {
      return this.favoriteTracks.some((track) => this.rowIsLive(track.id))
        || this.favoriteAlbums.some((album) => this.albumIsLive(album.id))
        || this.favoriteArtists.some((artist) => this.artistIsLive(artist.id));
    }
    const shelf = this.drilled ? this.shelf : null;
    const tracks = shelf ? shelf.tracks : this.tracks;
    const albums = shelf ? shelf.albums : this.albums;
    const artists = shelf ? shelf.artists : this.artists;
    return tracks.some((track) => this.rowIsLive(track.id))
      || albums.some((album) => this.albumIsLive(album.id))
      || artists.some((artist) => this.artistIsLive(artist.id));
  }

  /** Titres, Albums or Artistes contains the title that is playing. */
  viewHasLive(view: DeezerSearchType): boolean {
    if (!this.playing || !this.current) {
      return false;
    }
    if (view === 'track') {
      const source = this.listMode === 'favorites' ? this.favoriteTracks : this.tracks;
      return source.some((track) => this.rowIsLive(track.id));
    }
    if (view === 'album') {
      const source = this.listMode === 'favorites' ? this.favoriteAlbums : this.albums;
      return source.some((album) => this.albumIsLive(album.id));
    }
    if (view === 'artist') {
      const source = this.listMode === 'favorites' ? this.favoriteArtists : this.artists;
      return source.some((artist) => this.artistIsLive(artist.id));
    }
    return false;
  }

  private samePlayingTitle(left: number, right: number): boolean {
    return left === right || this.catalogId(left) === this.catalogId(right);
  }

  /** Deezer id behind a row. Concert rows play under their own id and keep the source id. */
  private catalogId(id: number): number {
    return this.concertSource(id)?.id || id;
  }

  /** Keep next/previous on the order the listener is looking at, when that list is the queue. */
  private realignQueue(): void {
    const kind = this.activeSortList;
    if (kind !== 'tracks' && kind !== 'concert' && kind !== 'playlists') {
      return;
    }
    const listed = this.listedTracks();
    if (!this.current || !listed.length || listed.length !== this.queue.length) {
      return;
    }
    const ids = new Set(listed.map((track) => track.id));
    if (!this.queue.every((track) => ids.has(track.id))) {
      return;
    }
    this.queue = listed;
  }

  private sortBy<T>(list: T[], kind: DzListSortId, compare: (a: T, b: T, key: string, dir: number) => number): T[] {
    const spec = this.listSorts[kind];
    if (spec.key === 'order') {
      return spec.desc ? list.slice().reverse() : list.slice();
    }
    const dir = spec.desc ? -1 : 1;
    const key = spec.key;
    return list.slice().sort((a, b) => compare(a, b, key, dir));
  }

  private textCmp(a: string | null | undefined, b: string | null | undefined, dir: number): number {
    return dir * (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
  }

  private numCmp(a: number, b: number, dir: number): number {
    if (a === b) {
      return 0;
    }
    if (!a) {
      return 1;
    }
    if (!b) {
      return -1;
    }
    return dir * (a - b);
  }

  private yearCmp(a: string, b: string, dir: number): number {
    if (a === b) {
      return 0;
    }
    if (!a) {
      return 1;
    }
    if (!b) {
      return -1;
    }
    return dir * a.localeCompare(b);
  }

  private sortTracks(list: DeezerTrack[]): DeezerTrack[] {
    return this.sortBy(list, 'tracks', (a, b, key, dir) => {
      const diff = key === 'artist'
        ? this.textCmp(a.artistName, b.artistName, dir)
        : key === 'album'
          ? this.textCmp(a.albumTitle, b.albumTitle, dir)
          : key === 'duration'
            ? this.numCmp(a.durationSec || 0, b.durationSec || 0, dir)
            : key === 'year'
              ? this.yearCmp(this.yearOf(a.releaseDate), this.yearOf(b.releaseDate), dir)
              : key === 'fans'
                ? this.numCmp(a.fanCount || 0, b.fanCount || 0, dir)
                : this.textCmp(a.title, b.title, dir);
      return diff || (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    });
  }

  private sortConcert(list: DeezerConcertTrack[]): DeezerConcertTrack[] {
    return this.sortBy(list, 'concert', (a, b, key, dir) => {
      const diff = key === 'name'
        ? this.textCmp(a.name, b.name, dir)
        : key === 'artist'
          ? this.textCmp(a.track?.artistName, b.track?.artistName, dir)
          : key === 'album'
            ? this.textCmp(a.track?.albumTitle, b.track?.albumTitle, dir)
            : key === 'year'
              ? this.yearCmp(this.yearOf(a.track?.releaseDate), this.yearOf(b.track?.releaseDate), dir)
              : key === 'fans'
                ? this.numCmp(a.track?.fanCount || 0, b.track?.fanCount || 0, dir)
                : this.textCmp(a.track?.title || a.name, b.track?.title || b.name, dir);
      return diff || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
  }

  private sortPlaylists(list: DeezerUserPlaylist[]): DeezerUserPlaylist[] {
    return this.sortBy(list, 'playlists', (a, b, key, dir) => {
      const diff = key === 'tracks'
        ? this.numCmp(a.tracks?.length || 0, b.tracks?.length || 0, dir)
        : key === 'fans'
          ? this.numCmp(this.playlistFans(a), this.playlistFans(b), dir)
          : this.textCmp(a.name, b.name, dir);
      return diff || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
  }

  private playlistFans(playlist: DeezerUserPlaylist): number {
    let best = 0;
    for (const track of playlist.tracks || []) {
      const fans = track.fanCount || 0;
      if (fans > best) {
        best = fans;
      }
    }
    return best;
  }

  private sortAlbums(list: DeezerAlbum[], kind: 'albums' | 'artistAlbums'): DeezerAlbum[] {
    return this.sortBy(list, kind, (a, b, key, dir) => {
      const diff = key === 'artist'
        ? this.textCmp(a.artistName, b.artistName, dir)
        : key === 'tracks'
          ? this.numCmp(a.trackCount || 0, b.trackCount || 0, dir)
          : key === 'year'
            ? this.yearCmp(this.yearOf(a.releaseDate), this.yearOf(b.releaseDate), dir)
            : key === 'fans'
              ? this.numCmp(a.fanCount || 0, b.fanCount || 0, dir)
              : this.textCmp(a.title, b.title, dir);
      return diff || (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    });
  }

  private sortArtists(list: DeezerArtist[]): DeezerArtist[] {
    return this.sortBy(list, 'artists', (a, b, key, dir) => {
      const diff = key === 'fans'
        ? this.numCmp(a.fanCount || 0, b.fanCount || 0, dir)
        : key === 'albums'
          ? this.numCmp(a.albumCount || 0, b.albumCount || 0, dir)
          : this.textCmp(a.name, b.name, dir);
      return diff || (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
  }

  private sortDeezerPlaylists(list: DeezerPlaylist[]): DeezerPlaylist[] {
    return this.sortBy(list, 'deezerPlaylists', (a, b, key, dir) => {
      const diff = key === 'user'
        ? this.textCmp(a.userName, b.userName, dir)
        : key === 'tracks'
          ? this.numCmp(a.trackCount || 0, b.trackCount || 0, dir)
          : key === 'fans'
            ? this.numCmp(a.fanCount || 0, b.fanCount || 0, dir)
            : this.textCmp(a.title, b.title, dir);
      return diff || (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    });
  }

  /** The titles on screen are the queue already loaded for this tab. */
  private tabQueueIsLive(): boolean {
    if (!this.current) {
      return false;
    }
    if (this.playbackListMode && this.playbackListMode !== this.listMode) {
      return false;
    }
    const listed = this.listedTracks();
    return !!listed.length
      && this.sameTrackList(this.queue, listed)
      && listed.some((track) => track.id === this.current!.id);
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

  /** Continuer put this list back. Lecture continues it instead of starting the first title again. */
  private restoredSessionOnScreen(): boolean {
    if (!this.keptMediaOnScreen() || !this.current || this.nowBrowse) {
      return false;
    }
    if (this.playbackListMode && this.playbackListMode !== this.listMode) {
      return false;
    }
    const listed = this.listedTracks();
    if (!listed.length) {
      return true;
    }
    return this.sameTrackList(this.queue, listed) || listed.some((track) => track.id === this.current!.id);
  }

  private keptMediaOnScreen(): boolean {
    return this.keptFrameActive || !!this.adoptedAudio;
  }

  /** Resume the restored title, or the following one when that title has already finished. */
  private resumeRestored(): void {
    const audio = this.pageAudio();
    if ((this.youtubeEnded || !!audio?.ended) && (this.takeNextYoutubeListClip() || this.queueContinues())) {
      this.youtubeEnded = false;
      if (!this.ytListRun) {
        this.next();
      }
      return;
    }
    this.playbackFollowsList = true;
    if (this.clipOnStage && this.youtubeSeconds > 1) {
      this.postYoutubeCommand('seekTo', [this.youtubeSeconds, true]);
      this.postYoutubeCommand('playVideo');
      this.playing = true;
      this.holdScreen();
      return;
    }
    this.togglePlay();
  }

  /** Tracks the Lecture button controls: the album on screen, this playlist, or this tab. */
  private listedTracks(): DeezerTrack[] {
    if (this.nowBrowse === 'album') {
      return this.shownTracks;
    }
    if (this.nowBrowse === 'artist-albums') {
      return [];
    }
    if (this.listMode === 'concert' && !this.nowBrowse) {
      return this.concertAsTracks();
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
    if (this.ytPending[track.id] || this.ytNextBusy[track.id] || this.ytMiss[track.id]) {
      return;
    }
    if (this.ytLinks[track.id]) {
      const onThisVideo = this.playing && this.current?.id === track.id && this.clipOnStage;
      if (onThisVideo) {
        this.ytPlaceOff.delete(track.id);
        const savedId = (this.ytLinks[track.id] || '').trim();
        const skip = this.ytOffer?.trackId === track.id ? this.ytOffer.videoId : savedId;
        if (this.playNextYoutubeChoice(track, index, skip, savedId)) {
          this.pulseYoutubeButton(track.id);
        } else {
          this.lookupNextYoutubeLink(track, index, skip);
        }
        return;
      }
      const offered = this.ytOffer?.trackId === track.id;
      if (offered) {
        this.ytOffer = null;
        this.current = null;
      } else if (this.current?.id === track.id && this.clipOnStage) {
        this.togglePlay();
        return;
      }
      this.pulseYoutubeButton(track.id);
      this.playYoutubeTrack(track, index);
      return;
    }
    this.lookupYoutubeLink(track, index);
  }

  /** True while this title's YouTube button should show the spinning icon. */
  youtubeButtonBusy(id: number): boolean {
    return !!this.ytPending[id] || !!this.ytNextBusy[id] || !!this.ytSpin[id];
  }

  /** True when this title already has clips and another page of ten can still be loaded. */
  canLoadMoreYoutube(id: number): boolean {
    if (this.ytMoreOff.has(id) || this.ytMiss[id]) {
      return false;
    }
    return this.hasYoutubeList(id);
  }

  /** True when this title has a stored YouTube list that can be opened or dropped. */
  hasYoutubeList(id: number): boolean {
    return this.youtubeListIds(id).length > 0 && !this.ytMiss[id];
  }

  youtubeListIds(id: number): string[] {
    const saved = (this.ytLinks[id] || '').trim();
    const ids: string[] = [];
    for (const raw of this.ytChoices.get(id) || []) {
      const videoId = (raw || '').trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId) && !ids.includes(videoId)) {
        ids.push(videoId);
      }
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(saved) && !ids.includes(saved)) {
      ids.unshift(saved);
    }
    return ids;
  }

  /** Clips still shown once the modal filter is applied. */
  filteredYoutubeListIds(id: number): string[] {
    const ids = this.youtubeListIds(id);
    const parts = this.foldSearch(this.ytListQuery).split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return ids;
    }
    return ids.filter((videoId) => {
      const info = this.ytClipInfo[videoId];
      const hay = this.foldSearch(`${info?.title || ''} ${info?.author || ''} ${videoId}`);
      return parts.every((part) => hay.includes(part));
    });
  }

  /** Position in the full list, so a filter does not renumber the clips. */
  youtubeListNumber(id: number, videoId: string): number {
    const at = this.youtubeListIds(id).indexOf(videoId);
    return at < 0 ? 0 : at + 1;
  }

  openYoutubeList(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (!this.hasYoutubeList(track.id)) {
      return;
    }
    this.ytListQuery = '';
    this.ytListTrack = track;
    this.loadYoutubeClipCards(this.youtubeListIds(track.id));
  }

  private loadYoutubeClipCards(ids: string[]): void {
    for (const raw of ids) {
      const id = (raw || '').trim();
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id) || this.ytClipInfo[id] || this.ytClipAsked.has(id)) {
        continue;
      }
      this.ytClipAsked.add(id);
      this.api.getYoutubeClipCard(id).pipe(takeUntil(this.destroy$)).subscribe({
        next: (card) => {
          this.ytClipInfo = {
            ...this.ytClipInfo,
            [id]: { title: (card?.title || '').trim(), author: (card?.author || '').trim() }
          };
        },
        error: () => {
          this.ytClipAsked.delete(id);
        }
      });
    }
  }

  closeYoutubeList(event?: Event): void {
    event?.stopPropagation();
    this.ytClearAskId = null;
    this.ytListQuery = '';
    this.ytListTrack = null;
  }

  /** Escape clears the filter first, then closes the list. */
  onYoutubeListEscape(event?: Event): void {
    if (this.ytClearAskId != null) {
      this.cancelClearYoutubeList(event);
      return;
    }
    if (this.ytListQuery.trim()) {
      event?.stopPropagation();
      this.ytListQuery = '';
      return;
    }
    this.closeYoutubeList(event);
  }

  /** Track waiting for the clear-links confirmation. */
  ytClearAskId: number | null = null;

  askClearYoutubeList(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (!this.hasYoutubeList(track.id) || this.ytClearBusy[track.id]) {
      return;
    }
    this.ytClearAskId = track.id;
  }

  cancelClearYoutubeList(event?: Event): void {
    event?.stopPropagation();
    this.ytClearAskId = null;
  }

  confirmClearYoutubeList(event?: Event): void {
    event?.stopPropagation();
    const track = this.ytListTrack;
    this.ytClearAskId = null;
    if (!track) {
      return;
    }
    this.clearYoutubeList(track, event);
  }

  youtubeClipPlaying(track: DeezerTrack, videoId: string): boolean {
    if (!this.playing || !this.clipOnStage || this.current?.id !== track?.id) {
      return false;
    }
    const frameId = (this.youtubeFrame()?.dataset['patVideoId'] || '').trim();
    return (frameId || this.currentYoutubeId()) === (videoId || '').trim();
  }

  /** Play every stored clip of this title, one after another. */
  playYoutubeList(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    const ids = this.ytListTrack?.id === track.id
      ? this.filteredYoutubeListIds(track.id)
      : this.youtubeListIds(track.id);
    if (!ids.length) {
      return;
    }
    this.ytListRun = { trackId: track.id, ids: ids.slice(), index: 0 };
    this.ytListAdvancing = true;
    try {
      this.playYoutubeChoice(track, ids[0], event);
    } finally {
      this.ytListAdvancing = false;
    }
  }

  youtubeListRunning(trackId: number | null | undefined): boolean {
    return !!trackId && this.ytListRun?.trackId === trackId;
  }

  /** True while play-all is actually playing this title, so the button can show Pause. */
  youtubeListPlaying(trackId: number | null | undefined): boolean {
    return this.youtubeListRunning(trackId)
      && this.current?.id === trackId
      && !this.userHold
      && (this.playing || this.youtubeBusy);
  }

  setListLoop(enabled: boolean): void {
    this.listLoop = !!enabled;
    this.repeatQueue = this.listLoop;
  }

  setYoutubeListLoop(enabled: boolean): void {
    this.ytListLoop = !!enabled;
  }

  /** Pause the running list, resume it, or start it from the first clip. */
  toggleYoutubeList(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (this.youtubeListRunning(track.id) && this.current?.id === track.id && (this.clipOnStage || this.youtubeEmbed)) {
      this.togglePlay();
      return;
    }
    this.playYoutubeList(track, event);
  }

  /** Play the previous or next clip of this title without replacing the menu's saved link. */
  stepYoutubeListClip(track: DeezerTrack, delta: number, event?: Event): void {
    event?.stopPropagation();
    const ids = this.youtubeListStepIds(track.id);
    const next = this.youtubeListStepIndex(track.id, ids, delta);
    if (next < 0) {
      return;
    }
    const run = this.ytListRun?.trackId === track.id ? this.ytListRun : null;
    if (run) {
      this.ytListRun = { trackId: run.trackId, ids: run.ids, index: next };
    }
    this.lastQueueAdvanceAt = Date.now();
    this.ytListAdvancing = true;
    try {
      this.playYoutubeChoice(track, ids[next], event);
    } finally {
      this.ytListAdvancing = false;
    }
  }

  canStepYoutubeList(track: DeezerTrack | null, delta: number): boolean {
    if (!track) {
      return false;
    }
    const ids = this.youtubeListStepIds(track.id);
    return this.youtubeListStepIndex(track.id, ids, delta) >= 0;
  }

  private youtubeListStepIds(trackId: number): string[] {
    const run = this.ytListRun?.trackId === trackId ? this.ytListRun : null;
    if (run) {
      return run.ids;
    }
    if (this.ytListTrack?.id === trackId) {
      return this.filteredYoutubeListIds(trackId);
    }
    return this.youtubeListIds(trackId);
  }

  private youtubeListStepIndex(trackId: number, ids: string[], delta: number): number {
    if (ids.length < 2) {
      return -1;
    }
    const frameId = (this.youtubeFrame()?.dataset['patVideoId'] || '').trim();
    const onThis = this.current?.id === trackId && (this.clipOnStage || !!this.youtubeEmbed);
    const currentId = onThis ? (frameId || this.currentYoutubeId()) : (this.ytLinks[trackId] || '').trim();
    let at = ids.indexOf(currentId);
    if (at < 0 && this.ytListRun?.trackId === trackId) {
      at = this.ytListRun.index;
    }
    let next = at + delta;
    if (this.ytListLoop) {
      next = (next % ids.length + ids.length) % ids.length;
    }
    if (next < 0 || next >= ids.length || next === at) {
      return -1;
    }
    return next;
  }

  /** Start the following clip of the play-all run. False leaves the normal queue to move on. */
  private takeNextYoutubeListClip(): boolean {
    const run = this.ytListRun;
    if (!run || this.current?.id !== run.trackId) {
      return false;
    }
    const nextIndex = run.index + 1;
    if (nextIndex >= run.ids.length) {
      if (this.ytListLoop && run.ids.length) {
        return this.restartYoutubeList(run);
      }
      this.ytListRun = null;
      return false;
    }
    const track = this.trackForYoutubeList(run.trackId);
    const videoId = run.ids[nextIndex];
    if (!track || !videoId) {
      this.ytListRun = null;
      return false;
    }
    this.ytListRun = { trackId: run.trackId, ids: run.ids, index: nextIndex };
    this.lastQueueAdvanceAt = Date.now();
    this.youtubeEnded = false;
    this.ytListAdvancing = true;
    try {
      this.playYoutubeChoice(track, videoId);
    } finally {
      this.ytListAdvancing = false;
    }
    this.cdr.markForCheck();
    return true;
  }

  /** Play the first clip of a finished YouTube list again. */
  private restartYoutubeList(run: { trackId: number; ids: string[]; index: number }): boolean {
    const track = this.trackForYoutubeList(run.trackId);
    const videoId = run.ids[0];
    if (!track || !videoId) {
      this.ytListRun = null;
      return false;
    }
    const already = (this.youtubeFrame()?.dataset['patVideoId'] || '').trim();
    this.ytListRun = { trackId: run.trackId, ids: run.ids, index: 0 };
    this.lastQueueAdvanceAt = Date.now();
    this.youtubeEnded = false;
    this.ytListAdvancing = true;
    try {
      this.playYoutubeChoice(track, videoId);
    } finally {
      this.ytListAdvancing = false;
    }
    if (already === videoId) {
      this.youtubeEnded = false;
      this.youtubePlayerState = -1;
      this.userHold = false;
      this.playing = true;
      this.ytIgnoreEnd = Date.now() + 4000;
      this.holdScreen();
      this.handshakeYoutube();
      this.postYoutubeCommand('seekTo', [0, true]);
      this.postYoutubeCommand('playVideo');
    }
    this.cdr.markForCheck();
    return true;
  }

  private trackForYoutubeList(id: number): DeezerTrack | null {
    if (this.ytListTrack?.id === id) {
      return this.ytListTrack;
    }
    if (this.current?.id === id) {
      return this.current;
    }
    return this.shownTracks.find((track) => track.id === id)
      || this.queue.find((track) => track.id === id)
      || null;
  }

  /** Drop a clip from the running list without restarting the one that is playing. */
  private syncYoutubeListRun(trackId: number, removedId: string): void {
    const run = this.ytListRun;
    if (!run || run.trackId !== trackId) {
      return;
    }
    const at = run.ids.indexOf(removedId);
    if (at < 0) {
      return;
    }
    const ids = run.ids.filter((id) => id !== removedId);
    if (!ids.length) {
      this.ytListRun = null;
      return;
    }
    const index = at <= run.index ? run.index - 1 : run.index;
    this.ytListRun = { trackId, ids, index };
  }

  playYoutubeChoice(track: DeezerTrack, videoId: string, event?: Event): void {
    event?.stopPropagation();
    if (!this.ytListAdvancing) {
      this.ytListRun = null;
    }
    const id = (videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return;
    }
    const fromList = this.ytListAdvancing;
    if (!fromList) {
      this.ytCache.set(track.id, id);
      this.ytLinks = { ...this.ytLinks, [track.id]: id };
      this.ytFromCache = { ...this.ytFromCache, [track.id]: true };
    }
    this.ytOffer = null;
    const index = Math.max(0, this.shownTracks.findIndex((item) => item.id === track.id));
    this.claimPlaybackTab();
    this.youtubeMode = true;
    this.repeatQueue = this.listLoop;
    this.queue = this.shownTracks.slice();
    if (this.current?.id === track.id && (this.clipOnStage || this.youtubeEmbed || this.keptFrameActive)) {
      this.applyYoutubeHit(track, id, this.ytToken);
    } else if (fromList) {
      this.ytListPlayId = id;
      this.current = null;
      this.playTrack(track, index);
    } else {
      this.current = null;
      this.playYoutubeTrack(track, index);
    }
    if (fromList) {
      return;
    }
    this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: track.artistName || '',
      title: track.title || '',
      saveVideoId: id
    }], false).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        const link = (page?.links || []).find((item) => item.id === track.id);
        if (link?.videoIds?.length) {
          this.rememberYoutubeChoices(track.id, link.videoIds);
        }
      },
      error: () => { /* the clip is already playing from the list kept on screen */ }
    });
  }

  dropYoutubeClip(track: DeezerTrack, videoId: string, event?: Event): void {
    event?.stopPropagation();
    const clip = (videoId || '').trim();
    const busyKey = track.id + '|' + clip;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(clip) || this.ytDropBusy[busyKey]) {
      return;
    }
    this.ytDropBusy = { ...this.ytDropBusy, [busyKey]: true };
    this.holdYoutubeScan();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseYoutubeScan();
    };
    this.api.clearDeezerYoutubeLink(track.id, clip).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        try {
          this.clearYoutubeDrop(busyKey);
          const remaining = this.youtubeListIds(track.id).filter((id) => id !== clip);
          if (remaining.length > 1) {
            this.ytChoices.set(track.id, remaining);
          } else {
            this.ytChoices.delete(track.id);
          }
          if ((this.ytLinks[track.id] || '') === clip) {
            if (remaining[0]) {
              this.ytLinks = { ...this.ytLinks, [track.id]: remaining[0] };
              this.ytCache.set(track.id, remaining[0]);
              this.ytFromCache = { ...this.ytFromCache, [track.id]: true };
            } else {
              this.forgetYoutubeList(track.id);
            }
          } else if (!remaining.length) {
            this.forgetYoutubeList(track.id);
          }
          if (!this.hasYoutubeList(track.id) && this.ytListTrack?.id === track.id) {
            this.ytListTrack = null;
          }
          this.syncYoutubeListRun(track.id, clip);
          this.rebuildMembershipVideos();
        } finally {
          release();
        }
      },
      error: () => {
        try {
          this.clearYoutubeDrop(busyKey);
        } finally {
          release();
        }
      }
    });
  }

  private clearYoutubeDrop(key: string): void {
    if (!this.ytDropBusy[key]) {
      return;
    }
    const next = { ...this.ytDropBusy };
    delete next[key];
    this.ytDropBusy = next;
  }

  clearYoutubeList(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (!this.hasYoutubeList(track.id) || this.ytClearBusy[track.id]) {
      return;
    }
    this.ytClearBusy = { ...this.ytClearBusy, [track.id]: true };
    this.holdYoutubeScan();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseYoutubeScan();
    };
    this.api.clearDeezerYoutubeLink(track.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        try {
          this.forgetYoutubeList(track.id);
          this.clearYoutubeClear(track.id);
          if (this.ytListRun?.trackId === track.id) {
            this.ytListRun = null;
          }
          if (this.ytListTrack?.id === track.id) {
            this.ytListTrack = null;
          }
        } finally {
          release();
        }
      },
      error: () => {
        try {
          this.clearYoutubeClear(track.id);
        } finally {
          release();
        }
      }
    });
  }

  loadMoreYoutube(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (!this.canLoadMoreYoutube(track.id) || this.ytMoreBusy[track.id] || this.youtubeQuery(track).length < 2) {
      return;
    }
    this.ytMoreBusy = { ...this.ytMoreBusy, [track.id]: true };
    this.holdYoutubeScan();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseYoutubeScan();
    };
    this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: track.artistName || '',
      title: track.title || '',
      more: true
    }], true).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        try {
          this.clearYoutubeMore(track.id);
          const link = (page?.links || []).find((item) => item.id === track.id);
          if (!link) {
            return;
          }
          this.rememberYoutubeChoices(track.id, link.videoIds);
          this.noteYoutubePage(track.id, link.more, this.trackHasYoutubeLinks(track.id, link.videoIds, link.videoId));
          this.loadYoutubeClipCards(this.youtubeListIds(track.id));
        } finally {
          release();
        }
      },
      error: () => {
        try {
          this.clearYoutubeMore(track.id);
        } finally {
          release();
        }
      }
    });
  }

  /**
   * Short spin for a click that needs no search (clip already known). A real search shows the
   * spinner through ytPending / ytNextBusy and stops as soon as the answer arrives.
   */
  private pulseYoutubeButton(id: number): void {
    const gen = (this.ytSpinGen.get(id) || 0) + 1;
    this.ytSpinGen.set(id, gen);
    this.ytSpin = { ...this.ytSpin, [id]: true };
    setTimeout(() => {
      if (this.ytSpinGen.get(id) !== gen || !this.ytSpin[id]) {
        return;
      }
      const next = { ...this.ytSpin };
      delete next[id];
      this.ytSpin = next;
      this.cdr.markForCheck();
    }, 350);
  }

  /** "2 / 7" while this title walks the clips stored for it. Empty after keep or drop. */
  ytPlace(trackId: number): string {
    if (this.ytPlaceOff.has(trackId)) {
      return '';
    }
    const ids = this.ytChoices.get(trackId) || [];
    if (ids.length < 2) {
      return '';
    }
    const offered = this.ytOffer?.trackId === trackId ? (this.ytOffer.videoId || '').trim() : '';
    const onThisClip = this.current?.id === trackId && (this.clipOnStage || !!this.ytNextBusy[trackId]);
    const videoId = offered || (onThisClip ? (this.ytLinks[trackId] || '').trim() : '');
    if (!videoId) {
      return '';
    }
    const at = ids.indexOf(videoId);
    if (at < 0) {
      return '';
    }
    const walking = !!offered || !!this.ytNextBusy[trackId] || onThisClip;
    return walking ? `${at + 1} / ${ids.length}` : '';
  }

  ytIconLabel(track: DeezerTrack): string {
    if (this.ytPending[track.id] || this.ytNextBusy[track.id]) {
      return this.translate.instant('DEEZER.YT_SEARCHING');
    }
    if (this.ytMiss[track.id]) {
      return this.translate.instant('DEEZER.YT_MISS_HINT');
    }
    if (this.ytLinks[track.id]) {
      if (this.playing && this.current?.id === track.id && this.clipOnStage) {
        return this.translate.instant('DEEZER.YT_NEXT');
      }
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
    this.repeatQueue = this.listLoop;
    this.queue = this.shownTracks;
    if (this.current?.id === track.id && this.clipOnStage) {
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

  trackInUserPlaylist(trackId: number | null | undefined): boolean {
    const videoId = this.youtubeIdOf(trackId);
    return !!videoId && this.playlistVideoIds.has(videoId);
  }

  trackFavoriteByVideo(trackId: number | null | undefined): boolean {
    const videoId = this.youtubeIdOf(trackId);
    return !!videoId && this.favoriteVideoIds.has(videoId);
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
    this.revealPlayingRow();
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

  trackCaption(track: DeezerTrack | null | undefined): string {
    const artist = (track?.artistName || '').trim();
    const title = (track?.title || '').trim();
    if (artist && title) {
      return `${artist} — ${title}`;
    }
    return title || artist;
  }

  trackByPlaylistId(_index: number, playlist: DeezerUserPlaylist): string {
    return playlist.id;
  }

  trackByConcertId(_index: number, item: DeezerConcertTrack): string {
    return item.id;
  }

  concertThumb(item: DeezerConcertTrack): string {
    return (item.track?.coverUrl || '').trim() || this.api.youtubeVideoThumbUrl(item?.videoId);
  }

  concertHas(trackId: number | null | undefined): boolean {
    const videoId = this.youtubeIdOf(trackId);
    return !!videoId && this.concertVideoIds.has(videoId);
  }

  openConcertName(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    if (!track?.id) {
      return;
    }
    if (!this.ensureConcertLogin()) {
      return;
    }
    this.concertError = '';
    this.concertNameTrack = track;
    this.concertNameDraft = (track.title || '').trim();
  }

  closeConcertName(event?: Event): void {
    event?.stopPropagation();
    this.concertNameTrack = null;
  }

  addConcert(): void {
    const track = this.concertNameTrack;
    const name = this.concertNameDraft.trim();
    if (!track?.id || !name || this.concertBusy || !this.concertReady) {
      return;
    }
    if (!this.ensureConcertLogin()) {
      return;
    }
    const videoId = (this.ytLinks[track.id] || '').trim();
    this.concertBusy = 'add';
    this.concertError = '';
    this.concertEpoch++;
    this.concertSub?.unsubscribe();
    this.concertSub = this.api.addDeezerConcertTrack(track, name, videoId || undefined).subscribe({
      next: (saved) => {
        this.concertBusy = '';
        this.concertNameTrack = null;
        this.concertNameDraft = '';
        this.applyConcert(saved?.tracks || []);
      },
      error: () => {
        this.concertBusy = '';
        this.concertError = 'DEEZER.CONCERT_ERR_SAVE';
      }
    });
  }

  playConcert(item: DeezerConcertTrack, index: number): void {
    if (!item?.playId || !item.track?.id || this.renamingConcertId === item.id) {
      return;
    }
    this.pinConcertVideos();
    const track = this.concertTrack(item);
    this.claimPlaybackTab();
    this.youtubeMode = true;
    this.repeatQueue = this.listLoop;
    this.playbackFollowsList = true;
    this.queue = this.concertAsTracks();
    if (this.current?.id === track.id && !this.clipOnStage) {
      this.current = null;
    }
    this.playTrack(track, index);
  }

  startRenameConcert(item: DeezerConcertTrack, event?: Event): void {
    event?.stopPropagation();
    this.confirmDeleteConcertId = '';
    if (this.renamingConcertId === item.id) {
      this.renamingConcertId = '';
      return;
    }
    this.renamingConcertId = item.id;
    this.concertRenameDraft = item.name || '';
  }

  commitRenameConcert(item: DeezerConcertTrack, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    const name = this.concertRenameDraft.trim();
    if (!item?.id || !name || this.concertBusy || !this.concertReady) {
      return;
    }
    if (name === item.name) {
      this.renamingConcertId = '';
      return;
    }
    if (!this.ensureConcertLogin()) {
      return;
    }
    this.concertBusy = 'rename:' + item.id;
    this.concertError = '';
    this.concertEpoch++;
    this.concertSub?.unsubscribe();
    this.concertSub = this.api.renameDeezerConcertTrack(item.id, name).subscribe({
      next: (saved) => {
        this.concertBusy = '';
        this.renamingConcertId = '';
        this.applyConcert(saved?.tracks || []);
      },
      error: () => {
        this.concertBusy = '';
        this.concertError = 'DEEZER.CONCERT_ERR_SAVE';
      }
    });
  }

  askDeleteConcert(item: DeezerConcertTrack, event?: Event): void {
    event?.stopPropagation();
    this.renamingConcertId = '';
    this.confirmDeleteConcertId = this.confirmDeleteConcertId === item.id ? '' : item.id;
  }

  deleteConcert(item: DeezerConcertTrack, event?: Event): void {
    event?.stopPropagation();
    if (!item?.id || this.concertBusy || !this.concertReady) {
      return;
    }
    if (!this.ensureConcertLogin()) {
      return;
    }
    this.concertBusy = 'delete:' + item.id;
    this.concertError = '';
    this.concertEpoch++;
    this.concertSub?.unsubscribe();
    this.concertSub = this.api.deleteDeezerConcertTrack(item.id).subscribe({
      next: (saved) => {
        this.concertBusy = '';
        this.confirmDeleteConcertId = '';
        this.applyConcert(saved?.tracks || []);
      },
      error: () => {
        this.concertBusy = '';
        this.concertError = 'DEEZER.CONCERT_ERR_SAVE';
      }
    });
  }

  selectGenre(id: number): void {
    this.genreId = id;
    this.query = '';
    this.exitDrill();
    this.resetCatalogPages();
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
    this.listSortOpen = false;
    this.view = view;
    if (this.listMode === 'favorites') {
      this.refreshQueue();
      this.syncYoutubeButtons();
      this.revealPlayingRow();
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
    this.revealPlayingRow();
  }

  /** Deezer album page for the track that is playing, shown in a dialog. */
  openAlbumInfo(): void {
    const albumId = this.current?.albumId || 0;
    if (!albumId) {
      return;
    }
    this.shareMenuOpen = false;
    this.albumInfoOpen = true;
    this.albumInfoError = '';
    this.albumInfoForId = albumId;
    const cached = this.albumInfoCache.get(albumId);
    if (cached) {
      this.albumInfo = cached;
      this.albumInfoLoading = false;
    } else {
      this.albumInfo = null;
      this.albumInfoLoading = true;
      this.albumInfoSub?.unsubscribe();
      this.albumInfoSub = this.albumPage(albumId).subscribe({
        next: (page) => {
          if (this.albumInfoForId !== albumId) {
            return;
          }
          if (!page?.album?.id) {
            this.albumInfo = null;
            this.albumInfoLoading = false;
            this.albumInfoError = 'DEEZER.ALBUM_INFO_EMPTY';
            return;
          }
          this.albumInfo = page;
          this.albumInfoLoading = false;
        },
        error: (err: { status?: number }) => {
          if (this.albumInfoForId !== albumId) {
            return;
          }
          this.albumInfo = null;
          this.albumInfoLoading = false;
          this.albumInfoError = err?.status === 404 ? 'DEEZER.ALBUM_INFO_EMPTY' : 'DEEZER.ERR_LOAD';
        }
      });
    }
    this.loadAudioDb();
  }

  closeAlbumInfo(event?: Event): void {
    event?.stopPropagation();
    this.albumInfoOpen = false;
  }

  private loadAudioDb(): void {
    const artist = (this.albumInfo?.album?.artistName || this.current?.artistName || '').trim();
    const album = (this.albumInfo?.album?.title || this.current?.albumTitle || '').trim();
    if (!artist) {
      this.audioDb = null;
      this.audioDbLoading = false;
      this.audioDbError = '';
      return;
    }
    this.audioDbError = '';
    const key = `${this.wikipediaLang()}|${artist}|${album}`;
    this.audioDbForKey = key;
    const cached = this.audioDbCache.get(key);
    if (cached) {
      this.audioDb = cached;
      this.audioDbLoading = false;
      return;
    }
    this.audioDb = null;
    this.audioDbLoading = true;
    this.audioDbSub?.unsubscribe();
    this.audioDbSub = this.audioDossier(artist, album).subscribe({
      next: (dossier) => {
        if (this.audioDbForKey !== key) {
          return;
        }
        this.audioDb = dossier || { artist: null, album: null };
        this.audioDbLoading = false;
      },
      error: () => {
        if (this.audioDbForKey !== key) {
          return;
        }
        this.audioDb = null;
        this.audioDbLoading = false;
        this.audioDbError = 'DEEZER.AUDIODB_ERROR';
      }
    });
  }

  openArtistFromAlbumInfo(): void {
    const album = this.albumInfo?.album;
    if (!album?.artistId) {
      return;
    }
    this.closeAlbumInfo();
    this.openArtist({ id: album.artistId, name: album.artistName || '' });
  }

  showTracksFromAlbumInfo(): void {
    const album = this.albumInfo?.album;
    if (!album?.id) {
      return;
    }
    this.closeAlbumInfo();
    this.loadAlbumTracks(album.id, album.title || '', album.artistName || '', null);
  }

  /** Wikipedia search that opens the article when the title matches. */
  wikiSearchUrl(kind: 'artist' | 'album'): string | null {
    const artist = (this.albumInfo?.album?.artistName || this.current?.artistName || '').trim();
    const album = (this.albumInfo?.album?.title || this.current?.albumTitle || '').trim();
    const parts = kind === 'artist' ? [artist] : [album, artist];
    const query = parts.filter((part, index) => part && parts.indexOf(part) === index).join(' ');
    if (!query) {
      return null;
    }
    const lang = this.wikipediaLang();
    return `https://${lang}.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query)}&go=Go`;
  }

  private wikipediaLang(): string {
    const raw = (this.translate.currentLang || 'fr').trim().toLowerCase();
    const mapped = raw.startsWith('jp') ? 'ja'
      : raw.startsWith('cn') ? 'zh'
        : raw.startsWith('in') ? 'hi'
          : raw.slice(0, 2);
    const known = ['fr', 'en', 'de', 'es', 'it', 'ru', 'ja', 'zh', 'ar', 'he', 'el', 'hi'];
    return known.includes(mapped) ? mapped : 'en';
  }

  albumTypeLabel(type: string | null | undefined): string {
    const value = (type || '').trim().toLowerCase();
    if (value === 'album') {
      return this.translate.instant('DEEZER.ALBUM_TYPE_ALBUM');
    }
    if (value === 'single') {
      return this.translate.instant('DEEZER.ALBUM_TYPE_SINGLE');
    }
    if (value === 'ep') {
      return this.translate.instant('DEEZER.ALBUM_TYPE_EP');
    }
    return (type || '').trim();
  }

  albumInfoGenreText(): string {
    return (this.albumInfo?.genres || []).map((name) => (name || '').trim()).filter(Boolean).join(', ');
  }

  albumInfoDurationSec(): number {
    const listed = this.albumInfo?.durationSec || 0;
    if (listed > 0) {
      return listed;
    }
    return (this.albumInfo?.tracks || []).reduce((sum, track) => sum + (track.durationSec || 0), 0);
  }

  albumInfoTrackCount(): number {
    const listed = this.albumInfo?.album?.trackCount || 0;
    if (listed > 0) {
      return listed;
    }
    return this.albumInfo?.tracks?.length || 0;
  }

  formatDuration(value: number | null | undefined): string {
    const sec = Math.max(0, Math.floor(Number(value) || 0));
    if (!sec) {
      return '';
    }
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const rest = sec % 60;
    if (hours > 0) {
      return hours + ':' + String(mins).padStart(2, '0') + ':' + String(rest).padStart(2, '0');
    }
    return mins + ':' + String(rest).padStart(2, '0');
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
    this.errorKey = '';
    this.nowBrowse = 'artist-albums';
    this.nowBrowseFrom = null;
    this.nowArtistName = name;
    this.nowBrowseTitle = name;
    this.nowBrowseSubtitle = '';
    this.nowBrowseTracks = [];
    const cached = this.artistAlbumsCache.get(artistId);
    if (cached) {
      this.loading = false;
      this.nowBrowseAlbums = cached;
      return;
    }
    this.loading = true;
    this.artistAlbums(artistId).pipe(takeUntil(this.destroy$)).subscribe({
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
    const cached = this.albumInfoCache.get(albumId);
    if (cached) {
      this.loading = false;
      this.applyAlbumBrowse(cached, title, artist);
      return;
    }
    this.albumPage(albumId).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.applyAlbumBrowse(page, title, artist);
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

  private applyAlbumBrowse(page: DeezerAlbumPage, title: string, artist: string): void {
    this.nowBrowseTitle = page?.album?.title || title;
    this.nowBrowseSubtitle = page?.album?.artistName || artist;
    this.nowBrowseTracks = page?.tracks || [];
    this.ytScanKey = '';
    this.syncYoutubeButtons();
  }

  /** One album request shared by the info dialog, the track list, and the warm-up. */
  private albumPage(albumId: number): Observable<DeezerAlbumPage> {
    const cached = this.albumInfoCache.get(albumId);
    if (cached) {
      return of(cached);
    }
    const pending = this.albumRequests.get(albumId);
    if (pending) {
      return pending;
    }
    const request = this.api.getDeezerAlbum(albumId).pipe(
      tap((page) => {
        if (page?.album?.id) {
          this.albumInfoCache.set(albumId, page);
        }
      }),
      finalize(() => this.albumRequests.delete(albumId)),
      shareReplay(1)
    );
    this.albumRequests.set(albumId, request);
    return request;
  }

  private artistAlbums(artistId: number): Observable<DeezerAlbum[]> {
    const cached = this.artistAlbumsCache.get(artistId);
    if (cached) {
      return of(cached);
    }
    const pending = this.artistAlbumRequests.get(artistId);
    if (pending) {
      return pending;
    }
    const request = this.api.getDeezerArtistAlbums(artistId).pipe(
      tap((albums) => this.artistAlbumsCache.set(artistId, albums || [])),
      finalize(() => this.artistAlbumRequests.delete(artistId)),
      shareReplay(1)
    );
    this.artistAlbumRequests.set(artistId, request);
    return request;
  }

  private relatedArtists(artistId: number): Observable<DeezerArtist[]> {
    const cached = this.similarCache.get(artistId);
    if (cached) {
      return of(cached);
    }
    const pending = this.relatedRequests.get(artistId);
    if (pending) {
      return pending;
    }
    const request = this.api.getDeezerRelatedArtists(artistId).pipe(
      tap((artists) => this.similarCache.set(artistId, artists || [])),
      finalize(() => this.relatedRequests.delete(artistId)),
      shareReplay(1)
    );
    this.relatedRequests.set(artistId, request);
    return request;
  }

  private audioDossier(artist: string, album: string): Observable<AudioDbDossier> {
    const key = `${this.wikipediaLang()}|${artist}|${album}`;
    const cached = this.audioDbCache.get(key);
    if (cached) {
      return of(cached);
    }
    const pending = this.audioRequests.get(key);
    if (pending) {
      return pending;
    }
    const request = this.api.getAudioDbDossier(artist, album, this.wikipediaLang()).pipe(
      tap((dossier) => this.audioDbCache.set(key, dossier || { artist: null, album: null })),
      finalize(() => this.audioRequests.delete(key)),
      shareReplay(1)
    );
    this.audioRequests.set(key, request);
    return request;
  }

  /** Fetch the four panel lookups while the title plays, so the buttons open at once. */
  private warmNowPlaying(track: DeezerTrack): void {
    const albumId = track.albumId || 0;
    const artistId = track.artistId || 0;
    const artist = (track.artistName || '').trim();
    const album = (track.albumTitle || '').trim();
    const key = `${albumId}|${artistId}|${artist}|${album}`;
    if (key === this.warmKey) {
      return;
    }
    if (this.warmTimer) {
      clearTimeout(this.warmTimer);
    }
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      if ((this.current?.albumId || 0) !== albumId || (this.current?.artistId || 0) !== artistId) {
        return;
      }
      this.warmKey = key;
      if (albumId && !this.albumInfoCache.has(albumId)) {
        this.albumPage(albumId).pipe(takeUntil(this.destroy$)).subscribe({
          error: () => { /* the button loads it again */ }
        });
      }
      if (artistId && !this.similarCache.has(artistId)) {
        this.relatedArtists(artistId).pipe(takeUntil(this.destroy$)).subscribe({
          error: () => { /* the button loads it again */ }
        });
      }
      if (artist && !this.audioDbCache.has(`${this.wikipediaLang()}|${artist}|${album}`)) {
        this.audioDossier(artist, album).pipe(takeUntil(this.destroy$)).subscribe({
          error: () => { /* the dialog loads it again */ }
        });
      }
    }, 450);
  }

  private clearNowBrowse(): void {
    this.nowBrowse = null;
    this.nowBrowseFrom = null;
    this.nowArtistName = '';
    this.nowBrowseTitle = '';
    this.nowBrowseSubtitle = '';
    this.nowBrowseTracks = [];
    this.nowBrowseAlbums = [];
    this.listSortOpen = false;
  }

  /** Which list is on screen, so the sort menu offers the fields that list actually has. */
  get activeSortList(): DzListSortId | null {
    if (this.nowBrowse === 'artist-albums') {
      return 'artistAlbums';
    }
    if (this.nowBrowse === 'album') {
      return 'tracks';
    }
    if (this.listMode === 'concert') {
      return 'concert';
    }
    if (this.listMode === 'playlists') {
      return this.activeUserPlaylist ? 'tracks' : 'playlists';
    }
    if (this.drilled || this.view === 'track') {
      return 'tracks';
    }
    if (this.view === 'album') {
      return 'albums';
    }
    if (this.view === 'artist') {
      return 'artists';
    }
    if (this.view === 'playlist') {
      return 'deezerPlaylists';
    }
    return null;
  }

  get listSortOptions(): ReadonlyArray<{ id: string; key: string }> {
    const list = this.activeSortList;
    return list ? this.listSortChoices[list] : [];
  }

  get listSortKey(): string {
    const list = this.activeSortList;
    return list ? this.listSorts[list].key : 'order';
  }

  get listSortDesc(): boolean {
    const list = this.activeSortList;
    return !!list && this.listSorts[list].desc;
  }

  get listSortLabelKey(): string {
    return this.listSortOptions.find((option) => option.id === this.listSortKey)?.key || 'DEEZER.SORT_ORDER';
  }

  get listSortIcon(): string {
    const text = this.listSortKey === 'title' || this.listSortKey === 'artist' || this.listSortKey === 'album'
      || this.listSortKey === 'name' || this.listSortKey === 'user';
    if (text) {
      return this.listSortDesc ? 'fa-sort-alpha-desc' : 'fa-sort-alpha-asc';
    }
    return this.listSortDesc ? 'fa-sort-amount-desc' : 'fa-sort-amount-asc';
  }

  get listSortCount(): number {
    switch (this.activeSortList) {
      case 'tracks':
        return this.shownTracks.length;
      case 'concert':
        return this.shownConcert.length;
      case 'playlists':
        return this.shownUserPlaylists.length;
      case 'albums':
        return this.shownAlbums.length;
      case 'artistAlbums':
        return this.sortedArtistAlbums.length;
      case 'artists':
        return this.shownArtists.length;
      case 'deezerPlaylists':
        return this.shownPlaylists.length;
      default:
        return 0;
    }
  }

  toggleListSort(event: Event): void {
    event.stopPropagation();
    this.listSortOpen = !this.listSortOpen;
  }

  setListSort(id: string): void {
    const list = this.activeSortList;
    this.listSortOpen = false;
    if (!list || !this.listSortChoices[list].some((option) => option.id === id) || id === this.listSorts[list].key) {
      return;
    }
    const text = id === 'title' || id === 'artist' || id === 'album' || id === 'name' || id === 'user' || id === 'order';
    this.listSorts[list] = { key: id, desc: !text };
    this.realignQueue();
  }

  toggleListSortDir(): void {
    const list = this.activeSortList;
    this.listSortOpen = false;
    if (!list) {
      return;
    }
    this.listSorts[list] = { ...this.listSorts[list], desc: !this.listSorts[list].desc };
    this.realignQueue();
  }

  get sortedArtistAlbums(): DeezerAlbum[] {
    return this.sortAlbums(this.nowBrowseAlbums, 'artistAlbums');
  }

  /** Names the list this button returns to, instead of a bare "Back". */
  get backLabel(): string {
    if (this.nowBrowse === 'album' && this.nowBrowseFrom === 'artist-albums') {
      const name = this.nowArtistName.trim();
      return name
        ? this.translate.instant('DEEZER.BACK_ARTIST_ALBUMS', { name })
        : this.translate.instant('DEEZER.BACK_ALBUMS');
    }
    if (this.nowBrowse && this.activeUserPlaylist) {
      return this.translate.instant('DEEZER.BACK_PLAYLIST', { name: this.activeUserPlaylist.name });
    }
    if (!this.nowBrowse && this.activeUserPlaylist) {
      return this.translate.instant('DEEZER.BACK_PLAYLISTS');
    }
    return this.translate.instant(this.listBackKey());
  }

  private listBackKey(): string {
    if (this.listMode === 'favorites') {
      return 'DEEZER.BACK_FAVORITES';
    }
    if (this.listMode === 'playlists') {
      return 'DEEZER.BACK_PLAYLISTS';
    }
    if (this.listMode === 'concert') {
      return 'DEEZER.BACK_CONCERT';
    }
    if (this.mode === 'search' || this.shelf?.mode === 'search') {
      return 'DEEZER.BACK_SEARCH';
    }
    return 'DEEZER.BACK_CHART';
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
      this.revealPlayingRow();
      return;
    }
    if (this.nowBrowse) {
      this.loadSeq++;
      this.loading = false;
      this.errorKey = '';
      this.clearNowBrowse();
      this.revealPlayingRow();
      return;
    }
    if (this.activeUserPlaylist) {
      this.activeUserPlaylist = null;
      this.renamingPlaylistId = '';
      this.playlistMenuTrack = null;
      this.refreshQueue();
      this.revealPlayingRow();
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
    this.revealPlayingRow();
  }

  playListedTrack(track: DeezerTrack, index: number): void {
    this.claimPlaybackTab();
    this.repeatQueue = this.listLoop;
    this.playbackFollowsList = true;
    this.queue = this.shownTracks;
    const hasYoutube = !!(this.ytLinks[track.id] || '').trim();
    this.youtubeMode = hasYoutube;
    if (hasYoutube && this.current?.id === track.id && !this.clipOnStage) {
      this.current = null;
    }
    this.playTrack(track, index);
  }

  /** Force the 30 s Deezer preview, even if this title is already playing from YouTube. */
  playDeezerTrack(track: DeezerTrack, index: number, event?: Event): void {
    event?.stopPropagation();
    const wasYoutube = this.youtubeMode || !!this.youtubeEmbed;
    this.claimPlaybackTab();
    this.youtubeMode = false;
    this.repeatQueue = this.listLoop;
    this.queue = this.shownTracks;
    if (wasYoutube && this.current?.id === track.id) {
      this.clearYoutube();
      this.current = null;
    }
    this.playTrack(track, index);
  }

  playTrack(track: DeezerTrack, index: number, restart = false): void {
    if (!this.ytListAdvancing) {
      this.ytListRun = null;
    }
    const same = this.current?.id === track.id;
    this.ytLog(`playTrack ${track.id} same=${same} restart=${restart} ${this.ytCaller()}`);
    if (!restart && same) {
      this.togglePlay();
      return;
    }
    this.lastQueueAdvanceAt = Date.now();
    this.youtubeEnded = false;
    this.releaseKeptMedia();
    if (this.playbackListMode == null || this.playbackListMode === this.listMode) {
      this.claimPlaybackTab();
      this.playbackFollowsList = true;
    }
    this.ytReplay = restart && same ? Date.now() : 0;
    this.current = track;
    this.warmNowPlaying(track);
    this.queueIndexHint = index;
    this.trackImageIndex = 0;
    this.syncTrackSlide();
    this.previewFresh = false;
    this.playErrorKey = '';
    this.currentTime = 0;
    this.youtubeSeconds = 0;
    this.pendingClipSeek = -1;
    this.clipSeekSent = false;
    this.audioDuration = 0;
    this.related = this.drilled ? this.related : [];
    this.scheduleSleeve(track.artistId || 0);
    if (this.youtubeMode) {
      this.armCleanVideoChrome();
    } else if ((track.coverUrl || '').trim() && (this.sleeveOpen || this.landscapeFullscreen)) {
      this.suppressChromeUntilLeave = false;
      this.clearChromeHideTimer();
      this.chromeVisible = true;
    } else {
      this.suppressChromeUntilLeave = false;
      this.chromeVisible = this.pointerOverPlayer || this.focusMode || this.stageFullscreen;
      if (this.chromeVisible && !this.focusMode && !this.stageFullscreen) {
        this.scheduleChromeHide();
      }
    }
    if (this.youtubeMode) {
      this.armClipSound();
      // Ignore the clip that just finished while the next title is loading.
      this.ytIgnoreEnd = Date.now() + 8000;
      const live = this.youtubeFrame()?.contentWindow;
      if (restart && same && !live) {
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
    if (this.videoOwnsPlayback()) {
      if (!this.youtubeEmbed) {
        return;
      }
      if (!this.playing && this.youtubeEnded && (this.takeNextYoutubeListClip() || this.queueContinues())) {
        this.youtubeEnded = false;
        if (!this.ytListRun) {
          this.next();
        }
        return;
      }
      const func = this.playing ? 'pauseVideo' : 'playVideo';
      if (func === 'pauseVideo') {
        this.userHold = true;
        this.markYoutubeUserPause(true);
        this.releaseScreenHold();
        this.stopYoutubeHandshake();
      } else {
        this.userHold = false;
        this.clearYoutubePauseDecide();
        this.markYoutubeUserPause(false);
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
      if (audio.ended && this.queueContinues()) {
        this.next();
        return;
      }
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
    this.ytListRun = null;
    this.userHold = true;
    this.markYoutubeUserPause(true);
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
    if (this.videoOwnsPlayback()) {
      return;
    }
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

  setSleeve(enabled: boolean): void {
    this.sleeveOpen = !!enabled;
    try {
      localStorage.setItem(DeezerWatcherComponent.SLEEVE_KEY, this.sleeveOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  /** Clicking the cover puts it in front of the cabinet animations. Click again to restore them. */
  toggleSleeveFront(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.sleeveFront = !this.sleeveFront;
    try {
      localStorage.setItem(DeezerWatcherComponent.SLEEVE_FRONT_KEY, this.sleeveFront ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  private readSleeveFront(): boolean {
    try {
      const raw = localStorage.getItem(DeezerWatcherComponent.SLEEVE_FRONT_KEY);
      if (raw == null) {
        return true;
      }
      return raw === '1';
    } catch {
      return true;
    }
  }

  openAlbum(album: DeezerAlbum): void {
    this.rememberShelf();
    const seq = ++this.loadSeq;
    this.loading = true;
    this.errorKey = '';
    this.albumPage(album.id).pipe(takeUntil(this.destroy$)).subscribe({
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
        this.repeatQueue = this.listLoop;
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
        this.repeatQueue = this.listLoop;
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
        this.repeatQueue = this.listLoop;
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
    this.similarSub = this.relatedArtists(artistId).subscribe({
      next: (artists) => {
        if (this.similarForId !== artistId) {
          return;
        }
        this.similarArtists = artists || [];
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
    if (this.videoOwnsPlayback()) {
      if (!audio.paused && !audio.ended) {
        this.silencePreviewUnderVideo();
      }
      return;
    }
    this.currentTime = audio.currentTime || 0;
    this.audioDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
  }

  onAudioPlay(): void {
    if (this.videoOwnsPlayback()) {
      this.silencePreviewUnderVideo();
      return;
    }
    this.playing = true;
    this.buffering = false;
    this.playErrorKey = '';
    if (!this.userHold) {
      this.holdScreen();
    }
  }

  onAudioPause(): void {
    if (this.videoOwnsPlayback()) {
      return;
    }
    this.buffering = false;
    const audio = this.pageAudio();
    if (!audio || this.userHold || audio.dataset['patUserPaused'] === '1' || audio.ended || !this.screenHold) {
      this.playing = false;
      return;
    }
    // The WebView pauses the preview before the screen-off signal exists.
    this.armSleepResume();
    this.holdScreen();
    void audio.play().catch(() => undefined);
    this.keepPlayingThroughSleep();
  }

  onAudioWaiting(): void {
    this.buffering = true;
  }

  onAudioEnded(): void {
    if (this.videoOwnsPlayback()) {
      return;
    }
    this.playing = false;
    this.buffering = false;
    if (this.queueContinues()) {
      // Keep the playback service up across the gap. Android will not start it
      // again once the screen is already off.
      this.holdScreen();
      this.clearSleepKick();
      this.next();
      if (this.playbackInterrupted()) {
        this.keepPlayingThroughSleep();
      }
      return;
    }
    this.releaseScreenHold();
  }

  onAudioError(): void {
    if (this.videoOwnsPlayback()) {
      this.silencePreviewUnderVideo();
      return;
    }
    this.buffering = false;
    this.playing = false;
    if (!this.current || this.previewFresh) {
      this.playErrorKey = 'DEEZER.ERR_PLAY';
      return;
    }
    this.refreshPreview(this.current, true);
  }

  itemTitle(primary?: string | null, secondary?: string | null): string {
    const main = (primary || '').trim();
    const extra = (secondary || '').trim();
    if (main && extra && main !== extra) {
      return `${main} — ${extra}`;
    }
    return main || extra;
  }

  get headingTitle(): string {
    if (this.nowBrowse) {
      return this.nowBrowseTitle;
    }
    if (this.drilled) {
      return this.drillTitle;
    }
    if (this.activeUserPlaylist && this.renamingPlaylistId !== this.activeUserPlaylist.id) {
      return this.activeUserPlaylist.name;
    }
    if (this.listMode === 'favorites') {
      return this.translate.instant('RADIO.TAB_FAVORITES');
    }
    if (this.listMode === 'playlists') {
      return this.translate.instant('DEEZER.MY_PLAYLISTS');
    }
    if (this.listMode === 'concert') {
      return this.translate.instant('DEEZER.CONCERT');
    }
    if (this.mode === 'search') {
      return this.translate.instant('DEEZER.SEARCH');
    }
    return this.translate.instant('DEEZER.CHART');
  }

  get canOpenVideoshow(): boolean {
    return !!this.currentYoutubeId();
  }

  openInVideoshow(): void {
    const currentId = this.currentYoutubeId();
    if (!currentId || !this.videoshowModalComponent) {
      return;
    }
    this.videoshowAccent = this.readSkinAccent();
    this.videoshowModalComponent.headerColor = this.videoshowAccent;
    const sources = this.videoshowSources(currentId);
    const startIndex = Math.max(0, sources.findIndex((source) => source.fileId === `dz:${this.current?.id || ''}`));
    if (sources[startIndex] && this.youtubeSeconds > 1) {
      sources[startIndex].startSec = this.youtubeSeconds;
    }
    this.videoshowPageAt = this.youtubeSeconds;
    this.videoshowResume = this.playing || this.youtubePlayerState === 1;
    this.stopPageForVideoshow();
    const title = sources[startIndex]?.fileName || this.youtubeTitle || 'Deezer';
    this.videoshowModalComponent.open(sources, title, false, 0, startIndex);
  }

  /** One thumbnail per menu track that already has a YouTube clip, in menu order. */
  private videoshowSources(currentId: string): VideoshowVideoSource[] {
    const sources: VideoshowVideoSource[] = [];
    for (const track of this.listedTracks()) {
      const yt = this.current?.id === track.id ? currentId : (this.ytLinks[track.id] || '');
      const id = (yt || '').trim();
      if (!id) {
        continue;
      }
      const label = `${track.artistName || ''} — ${track.title || ''}`.replace(/^ — | — $/g, '').trim() || track.title;
      sources.push({ youtubeVideoId: id, fileName: label, fileId: `dz:${track.id}` });
    }
    if (currentId && !sources.some((source) => source.youtubeVideoId === currentId && source.fileId === `dz:${this.current?.id || ''}`)) {
      const track = this.current;
      const label = track
        ? `${track.artistName || ''} — ${track.title || ''}`.replace(/^ — | — $/g, '').trim()
        : this.youtubeTitle;
      sources.unshift({ youtubeVideoId: currentId, fileName: label, fileId: track ? `dz:${track.id}` : '' });
    }
    return sources;
  }

  onVideoshowClosed(info?: VideoshowCloseState): void {
    const resume = this.videoshowResume;
    this.videoshowResume = false;
    const viewerAt = info?.timeKnown ? Math.max(0, info.currentTime || 0) : -1;
    const at = viewerAt >= 0 ? viewerAt : this.videoshowPageAt;
    const ytId = (info?.youtubeVideoId || '').trim();
    if (!resume && viewerAt < 0) {
      return;
    }
    if (ytId && ytId !== this.currentYoutubeId()) {
      const slot = this.trackForYoutube(ytId);
      if (slot) {
        this.userHold = false;
        this.markYoutubeUserPause(false);
        this.videoshowHandoffSec = at > 1 ? at : -1;
        this.playTrack(slot.track, slot.index);
        return;
      }
    }
    if (this.clipOnStage || this.youtubeEmbed || this.keptFrameActive) {
      this.markYoutubeUserPause(false);
      this.userHold = false;
      this.handshakeYoutube();
      if (at > 0.4) {
        this.postYoutubeCommand('seekTo', [at, true]);
        this.youtubeSeconds = at;
      }
      this.postYoutubeCommand('unMute');
      this.postYoutubeCommand('setVolume', [100]);
      this.ytSoundArmed = true;
      this.postYoutubeCommand('playVideo');
      this.playing = true;
      this.holdScreen();
      return;
    }
    const audio = this.pageAudio();
    if (audio) {
      if (at > 0.4) {
        try {
          audio.currentTime = at;
        } catch {
          /* not seekable yet */
        }
      }
      audio.dataset['patUserPaused'] = '0';
      void audio.play().catch(() => undefined);
      this.playing = true;
    }
  }

  private trackForYoutube(id: string): { track: DeezerTrack; index: number } | null {
    const fromQueue = this.queue.findIndex((track) => (this.ytLinks[track.id] || '') === id);
    if (fromQueue >= 0) {
      return { track: this.queue[fromQueue], index: fromQueue };
    }
    const listed = this.listedTracks();
    const fromList = listed.findIndex((track) => (this.ytLinks[track.id] || '') === id);
    if (fromList >= 0) {
      return { track: listed[fromList], index: fromList };
    }
    return null;
  }

  /** Pause is otherwise treated as a screen-off glitch and the clip is started again. */
  private stopPageForVideoshow(): void {
    if (this.clipOnStage || this.youtubeEmbed || this.keptFrameActive) {
      this.userHold = true;
      this.markYoutubeUserPause(true);
      this.releaseScreenHold();
      this.stopYoutubeHandshake();
      this.handshakeYoutube();
      this.postYoutubeCommand('pauseVideo');
      this.postYoutubeCommand('mute');
      this.playing = false;
    }
    const audio = this.pageAudio();
    if (audio && !audio.paused) {
      if (!this.clipOnStage) {
        this.videoshowPageAt = audio.currentTime;
      }
      audio.dataset['patUserPaused'] = '1';
      audio.pause();
      this.playing = false;
    }
  }

  private readSkinAccent(): string {
    const background = getComputedStyle(this.hostRef.nativeElement).getPropertyValue('--pat-page-bg').trim();
    return background || '#1a1024';
  }

  setTickerEnabled(enabled: boolean): void {
    this.tickerEnabled = !!enabled;
    try {
      localStorage.setItem(DeezerWatcherComponent.TICKER_KEY, this.tickerEnabled ? '1' : '0');
    } catch {
      /* ignore quota / private mode */
    }
  }

  get tickerItems(): NowTickerItem[] {
    const track = this.current;
    if (!track) {
      return [];
    }
    const items: NowTickerItem[] = [];
    const push = (key: string, value: string | null | undefined): void => {
      const text = (value || '').trim();
      if (text) {
        items.push({ key, value: text });
      }
    };
    const label = (key: string): string => this.translate.instant(key);
    push(label('NOW_TICKER.TITLE'), track.title);
    push(label('NOW_TICKER.ARTIST'), track.artistName);
    push(label('NOW_TICKER.ALBUM'), track.albumTitle);
    push(label('NOW_TICKER.DURATION'), track.durationSec ? this.formatTime(track.durationSec) : '');
    if (track.explicit) {
      items.push({ value: label('NOW_TICKER.EXPLICIT') });
    }
    push(
      label('NOW_TICKER.SOURCE'),
      this.clipOnStage ? label('NOW_TICKER.SOURCE_YOUTUBE') : track.previewUrl ? label('NOW_TICKER.SOURCE_PREVIEW') : ''
    );
    if (this.clipOnStage && this.youtubeTitle) {
      push(label('NOW_TICKER.SHOW'), this.youtubeTitle);
    }
    const album = this.albumInfo?.album;
    if (album && track.albumId && album.id === track.albumId) {
      push(label('NOW_TICKER.RELEASED'), this.yearOf(album.releaseDate));
      push(label('NOW_TICKER.KIND'), this.albumTypeLabel(album.recordType));
      push(label('NOW_TICKER.LABEL'), this.albumInfo?.label);
      push(label('NOW_TICKER.GENRE'), this.albumInfoGenreText());
      push(label('NOW_TICKER.TRACKS'), this.albumInfoTrackCount() ? String(this.albumInfoTrackCount()) : '');
      const fans = this.albumInfo?.fanCount || 0;
      push(label('NOW_TICKER.FANS'), fans > 0 ? fans.toLocaleString() : '');
    }
    return items;
  }

  private readTickerEnabled(): boolean {
    try {
      return localStorage.getItem(DeezerWatcherComponent.TICKER_KEY) === '1';
    } catch {
      return false;
    }
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
    if (this.listMode === 'favorites' || this.listMode === 'playlists' || this.listMode === 'concert') {
      return;
    }
    this.exitDrill();
    this.resetCatalogPages();
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
    this.api.getDeezerChart(genreId, this.catalogIndex).pipe(takeUntil(this.destroy$)).subscribe({
      next: (chart) => {
        if (seq !== this.loadSeq) {
          return;
        }
        const tracks = chart?.tracks || [];
        const albums = chart?.albums || [];
        const artists = chart?.artists || [];
        const playlists = chart?.playlists || [];
        if (this.rewindEmptyCatalogPages([
          { type: 'track', index: chart?.tracksPage?.index, count: tracks.length },
          { type: 'album', index: chart?.albumsPage?.index, count: albums.length },
          { type: 'artist', index: chart?.artistsPage?.index, count: artists.length },
          { type: 'playlist', index: chart?.playlistsPage?.index, count: playlists.length }
        ])) {
          return;
        }
        this.loading = false;
        this.tracks = tracks;
        this.syncYoutubeButtons();
        this.albums = albums;
        this.artists = artists;
        this.playlists = playlists;
        this.rememberCatalogPage('track', chart?.tracksPage?.index, chart?.tracksPage?.total, chart?.tracksPage?.hasNext, this.tracks.length);
        this.rememberCatalogPage('album', chart?.albumsPage?.index, chart?.albumsPage?.total, chart?.albumsPage?.hasNext, this.albums.length);
        this.rememberCatalogPage('artist', chart?.artistsPage?.index, chart?.artistsPage?.total, chart?.artistsPage?.hasNext, this.artists.length);
        this.rememberCatalogPage('playlist', chart?.playlistsPage?.index, chart?.playlistsPage?.total, chart?.playlistsPage?.hasNext, this.playlists.length);
        this.scrollCatalogList();
        this.revealPlayingRow();
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
    this.api.getDeezerSearch(query, this.view, this.catalogIndex[this.view]).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (seq !== this.loadSeq) {
          return;
        }
        const tracks = page?.tracks || [];
        const albums = page?.albums || [];
        const artists = page?.artists || [];
        const playlists = page?.playlists || [];
        const count = this.view === 'album' ? albums.length
          : this.view === 'artist' ? artists.length
            : this.view === 'playlist' ? playlists.length
              : tracks.length;
        if (this.rewindEmptyCatalogPages([{ type: this.view, index: page?.index, count }])) {
          return;
        }
        this.loading = false;
        this.tracks = tracks;
        this.syncYoutubeButtons();
        this.albums = albums;
        this.artists = artists;
        this.playlists = playlists;
        this.rememberCatalogPage(this.view, page?.index, page?.total, page?.hasNext, this.catalogPageCount());
        this.scrollCatalogList();
        this.revealPlayingRow();
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
    if (!artistId) {
      if (this.sleeveTimer) {
        clearTimeout(this.sleeveTimer);
        this.sleeveTimer = null;
      }
      this.sleeveSub?.unsubscribe();
      this.sleeveArtistId = 0;
      this.sleeveAlbums = [];
      return;
    }
    if (artistId === this.sleeveArtistId) {
      return;
    }
    if (this.sleeveTimer) {
      clearTimeout(this.sleeveTimer);
    }
    this.sleeveTimer = setTimeout(() => {
      this.sleeveTimer = null;
      this.sleeveSub?.unsubscribe();
      this.sleeveArtistId = artistId;
      this.sleeveSub = this.artistAlbums(artistId).subscribe({
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
    if (this.videoOwnsPlayback()) {
      return;
    }
    const token = this.previewToken;
    this.previewFresh = true;
    this.buffering = true;
    const lookupId = this.concertSource(track.id)?.id || track.id;
    this.api.getDeezerTrack(lookupId, fresh).pipe(takeUntil(this.destroy$)).subscribe({
      next: (freshTrack) => {
        if (token !== this.previewToken || this.videoOwnsPlayback() || this.current?.id !== track.id) {
          return;
        }
        const preview = (freshTrack?.previewUrl || '').trim();
        if (!preview) {
          this.buffering = false;
          this.playErrorKey = 'DEEZER.ERR_NO_PREVIEW';
          return;
        }
        this.current = { ...track, ...freshTrack, id: track.id, title: track.title, previewUrl: preview };
        this.startAudio(preview);
      },
      error: () => {
        if (token !== this.previewToken || this.videoOwnsPlayback()) {
          return;
        }
        this.buffering = false;
        this.playErrorKey = 'DEEZER.ERR_PLAY';
      }
    });
  }

  private startAudio(url: string): void {
    if (this.videoOwnsPlayback()) {
      return;
    }
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
      if (this.videoOwnsPlayback()) {
        this.silencePreviewUnderVideo();
        return;
      }
      this.playing = true;
      this.playErrorKey = '';
      if (this.equalizer.wantsProcessing) {
        this.equalizer.engageMedia(audio);
      }
      this.syncTrackSlide();
    }).catch(() => {
      if (this.videoOwnsPlayback()) {
        return;
      }
      this.playing = false;
      if (this.screenHold && this.playbackInterrupted() && !audio.ended) {
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
    if (audio && !this.videoOwnsPlayback()) {
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
    if (this.focusMode && this.clipOnStage) {
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
    if (this.clipOnStage) {
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
    if (!this.current || this.videoOwnsPlayback()) {
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
    // Progress reports arrive many times a second. Commands here reload the clip and cancel pause.
    if (payload.event !== 'onReady' && payload.event !== 'onStateChange') {
      if (payload.event === 'infoDelivery' && payload.info && typeof payload.info === 'object' && !this.userHold) {
        const reported = payload.info['playerState'];
        if (reported === 1) {
          this.ytSoundArmed = true;
          this.youtubePlayerState = 1;
        }
      }
      return;
    }
    const state = payload.event === 'onStateChange' && typeof payload.info === 'number' ? payload.info : undefined;
    // A clip that is already playing must be left alone. Touching it on every buffer blink cuts the picture.
    if (state === 3 && this.clipArmed) {
      this.youtubePlayerState = 3;
      this.ytLog('état chargement');
      return;
    }
    if (state === 1 && this.clipArmed && this.playing && this.screenHold && !this.userHold && !this.youtubeBusy) {
      this.youtubePlayerState = 1;
      this.ytSoundArmed = true;
      this.ytLog('état lecture');
      return;
    }
    this.zone.run(() => this.applyYoutubePlayerEvent(payload, state));
  }

  private applyYoutubePlayerEvent(
    payload: { event?: string; info?: number | Record<string, unknown> },
    state: number | undefined
  ): void {
    if (state !== undefined && this.clipArmed) {
      this.youtubePlayerState = state;
      const labels: Record<number, string> = { 0: 'fin', 1: 'lecture', 2: 'pause', 3: 'chargement', 5: 'prêt' };
      this.ytLog(`état ${labels[state] || String(state)}`);
    }
    this.ytApiListening = true;
    if (!this.clipArmed) {
      if (state === 1) {
        this.markYoutubeUserPause(true);
        this.postYoutubeCommand('mute');
        this.postYoutubeCommand('pauseVideo');
      }
      return;
    }
    if (payload.event === 'onReady') {
      this.ytLog('lecteur prêt');
      this.tryApplyClipSeek();
      this.pushYoutubeSound();
      return;
    }
    if (state === 1) {
      this.userHold = false;
      this.clearYoutubePauseDecide();
      this.markYoutubeUserPause(false);
      this.silencePreviewUnderVideo();
      this.ytSoundArmed = true;
      this.playing = true;
      this.youtubeBusy = false;
      this.youtubeEnded = false;
      if (this.youtubeFrameMatchesCurrent()) {
        this.clearSleepKick();
      }
      this.holdScreen();
      return;
    }
    if (state === 3) {
      return;
    }
    if (state === 2) {
      this.playing = false;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.resumeYoutubeAfterSleep();
        return;
      }
      this.userHold = true;
      this.markYoutubeUserPause(true);
      return;
    }
    if (state === 0 && Date.now() >= this.ytIgnoreEnd && this.youtubeMode) {
      if (Date.now() - this.lastQueueAdvanceAt < 1200) {
        return;
      }
      this.youtubeEnded = true;
      if (this.takeNextYoutubeListClip()) {
        this.holdScreen();
        this.clearSleepKick();
        if (this.playbackInterrupted()) {
          this.keepPlayingThroughSleep();
        }
        return;
      }
      if (this.queueContinues()) {
        this.holdScreen();
        this.clearSleepKick();
        this.next();
        if (this.playbackInterrupted()) {
          this.keepPlayingThroughSleep();
        }
      } else {
        this.releaseScreenHold();
      }
    }
  }

  onYoutubeFrameLoad(): void {
    const frame = this.youtubeFrame();
    const id = this.currentYoutubeId();
    if (frame && id) {
      frame.dataset['patVideoId'] = id;
    }
    this.ytApiListening = false;
    this.handshakeYoutube();
    this.pushYoutubeSound();
    if (this.playbackInterrupted()) {
      this.clearSleepKick();
      this.keepPlayingThroughSleep();
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
    if (this.similarSortOpen && !target?.closest?.('.dz-similar-sort-menu')) {
      this.similarSortOpen = false;
    }
    if (this.listSortOpen && !target?.closest?.('.dz-album-sort')) {
      this.listSortOpen = false;
    }
    if (this.playlistMenuTrack && !target?.closest?.('.dz-pl-modal') && !target?.closest?.('.dz-pl-btn')) {
      this.closePlaylistMenu();
    }
  }

  onPlayerPointerEnter(): void {
    this.pointerOverPlayer = true;
    this.clearChromeHideTimer();
    if (this.clipOnStage || this.suppressChromeUntilLeave) {
      return;
    }
    this.revealDeezerChrome(false);
  }

  onPlayerPointerMove(event?: MouseEvent): void {
    if (!this.clipOnStage) {
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
    if (this.pointerOverChrome(event) || this.shareMenuOpen) {
      return;
    }
    this.scheduleChromeHide(DeezerWatcherComponent.CHROME_IDLE_MS);
  }

  onPlayerPointerLeave(event?: MouseEvent): void {
    if (event && this.pointerStillOverPanel(event)) {
      return;
    }
    this.pointerOverPlayer = false;
    this.suppressChromeUntilLeave = false;
    this.clearChromeHideTimer();
    if (this.holdsChromeOpen() || (this.sleeveVisible && !this.clipOnStage)) {
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

  /** Finger on the video. A sideways move changes title; a vertical move still scrolls the page. */
  onVideoSwipeStart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      this.videoSwipeOn = false;
      return;
    }
    this.videoSwipeOn = true;
    this.videoSwipeX = event.touches[0].clientX;
    this.videoSwipeY = event.touches[0].clientY;
    this.onPlayerTouch();
  }

  onVideoSwipeEnd(event: TouchEvent): void {
    if (!this.videoSwipeOn) {
      return;
    }
    this.videoSwipeOn = false;
    const touch = event.changedTouches[0];
    if (!touch || !this.current) {
      return;
    }
    const dx = touch.clientX - this.videoSwipeX;
    const dy = touch.clientY - this.videoSwipeY;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy)) {
      return;
    }
    if (dx < 0) {
      this.next();
    } else {
      this.prev();
    }
  }

  onVideoSwipeCancel(): void {
    this.videoSwipeOn = false;
  }

  /** Deezer preview: show the caption and buttons, and keep them only while the pointer is on that bar. */
  private revealDeezerChrome(overChrome: boolean): void {
    this.chromeVisible = true;
    this.clearChromeHideTimer();
    if (overChrome || this.shareMenuOpen || this.holdsChromeOpen() || (this.sleeveVisible && !this.clipOnStage)) {
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
    if (this.listSortOpen) {
      this.listSortOpen = false;
      return;
    }
    if (this.albumInfoOpen) {
      this.closeAlbumInfo();
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
      if (this.clipOnStage) {
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
    return !this.clipOnStage && (this.focusMode || this.stageFullscreen);
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
    if (this.youtubeMode) {
      this.clearTrackSlide();
      return;
    }
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
    if (audio && !this.clipArmed) {
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
    setScreenKeepAlive('youtube', false);
    this.releaseAudioSession(false);
  }

  private queueContinues(): boolean {
    const idx = this.currentIndex();
    return (idx >= 0 && idx < this.queue.length - 1) || (this.repeatQueue && this.queue.length > 0);
  }

  private asleep(): boolean {
    return screenIsOff() || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
  }

  /**
   * The WebView pauses playback before the screen-off flag exists.
   * Keep restarting through that gap, then for as long as the screen stays off.
   */
  private playbackInterrupted(): boolean {
    return this.asleep() || Date.now() < this.resumeHoldUntil;
  }

  private armSleepResume(): void {
    const until = Date.now() + 4000;
    if (until > this.resumeHoldUntil) {
      this.resumeHoldUntil = until;
    }
  }

  /**
   * Screen off pauses a preview and a YouTube player. Start the same title again,
   * and let a list move on to the next one, the way the radio keeps its stream.
   */
  private keepPlayingThroughSleep(): void {
    if (!this.screenHold || this.userHold || !this.playbackInterrupted() || this.sleepKickTimer != null) {
      return;
    }
    this.holdScreen();
    if (this.clipArmed || this.youtubeBusy) {
      this.kickYoutubeThroughSleep();
      return;
    }
    this.kickAudioThroughSleep();
  }

  /** YouTube commands are ignored until the iframe shows the title that should be playing. */
  private kickYoutubeThroughSleep(): void {
    const kick = (attempt: number): void => {
      this.sleepKickTimer = null;
      if (!this.screenHold || this.userHold) {
        return;
      }
      if (!this.clipArmed && !this.youtubeBusy) {
        this.kickAudioThroughSleep();
        return;
      }
      if (!this.playbackInterrupted()) {
        // A clip that kept playing must stay marked as playing. Only a real pause
        // (state 2) or the end of the video (state 0) means the resume did not stick.
        if (this.youtubePlayerState === 0 || this.youtubePlayerState === 2) {
          this.playing = false;
        }
        return;
      }
      if (!this.youtubeFrameMatchesCurrent()) {
        const audio = this.pageAudio();
        if (!this.clipArmed && !this.youtubeBusy && audio?.src && audio.dataset['patUserPaused'] !== '1') {
          this.kickAudioThroughSleep();
          return;
        }
        if (attempt < 24) {
          this.sleepKickTimer = setTimeout(() => kick(attempt + 1), attempt < 8 ? 500 : 1500);
        }
        return;
      }
      if (this.youtubePlayerState === 0 && Date.now() - this.lastQueueAdvanceAt > 1500) {
        if (this.takeNextYoutubeListClip()) {
          this.holdScreen();
          return;
        }
        if (this.queueContinues()) {
          this.holdScreen();
          this.next();
          return;
        }
      }
      this.handshakeYoutube();
      this.postYoutubeCommand('playVideo');
      if (attempt < 24) {
        this.sleepKickTimer = setTimeout(() => kick(attempt + 1), attempt < 8 ? 500 : 1500);
      }
    };
    kick(0);
  }

  private kickAudioThroughSleep(): void {
    const kick = (attempt: number): void => {
      this.sleepKickTimer = null;
      if (!this.screenHold || this.userHold || this.videoOwnsPlayback()) {
        return;
      }
      if (!this.playbackInterrupted()) {
        this.playing = false;
        return;
      }
      const el = this.pageAudio();
      if (!el || el.dataset['patUserPaused'] === '1') {
        return;
      }
      if (el.ended) {
        if (this.queueContinues() && Date.now() - this.lastQueueAdvanceAt > 1500) {
          this.holdScreen();
          this.next();
          this.keepPlayingThroughSleep();
        }
        return;
      }
      if (!el.paused && !el.error) {
        return;
      }
      const again = (): void => {
        if (!this.screenHold || this.userHold || attempt >= 20) {
          return;
        }
        this.sleepKickTimer = setTimeout(() => kick(attempt + 1), attempt < 6 ? 450 : 1500);
      };
      void el.play().then(() => {
        if (!this.screenHold || this.userHold) {
          return;
        }
        if ((el.paused || el.error) && this.playbackInterrupted()) {
          again();
        }
      }).catch(() => {
        if (this.playbackInterrupted()) {
          again();
        }
      });
    };
    kick(0);
  }

  private pageAudioPlaying(): boolean {
    const audio = this.pageAudio();
    return !!(audio && audio.src && !audio.paused && !audio.ended && !audio.error && audio.dataset['patUserPaused'] !== '1');
  }

  /** True when the iframe already shows the title the queue is on, not the one that just finished. */
  private youtubeFrameMatchesCurrent(): boolean {
    const track = this.current;
    if (!track || !this.youtubeEmbed) {
      return false;
    }
    const id = (this.ytLinks[track.id] || '').trim();
    if (!id) {
      return false;
    }
    const frame = this.youtubeFrame();
    if ((frame?.dataset['patVideoId'] || '').trim() === id) {
      return true;
    }
    const src = frame?.getAttribute('src') || frame?.src || '';
    return src.includes(`/embed/${id}`);
  }

  /** Phone sleep resumes the clip. A pause that is still there on a visible page is kept. */
  private scheduleYoutubePauseDecision(): void {
    this.clearYoutubePauseDecide();
    this.youtubePauseDecideTimer = setTimeout(() => {
      this.youtubePauseDecideTimer = null;
      if (!this.clipArmed || this.userHold) {
        return;
      }
      const frame = this.youtubeFrame();
      if (frame?.dataset['patUserPaused'] === '1') {
        this.playing = false;
        return;
      }
      if (this.youtubePlayerState !== 2) {
        return;
      }
      if (Date.now() - this.youtubeCommandPlayAt < 1500) {
        return;
      }
      if ((typeof document !== 'undefined' && document.visibilityState === 'hidden') || this.playbackInterrupted()) {
        this.resumeYoutubeAfterSleep();
        return;
      }
      this.userHold = true;
      this.markYoutubeUserPause(true);
      this.playing = false;
      this.releaseScreenHold();
      this.cdr.markForCheck();
    }, 450);
  }

  private clearYoutubePauseDecide(): void {
    if (this.youtubePauseDecideTimer != null) {
      clearTimeout(this.youtubePauseDecideTimer);
      this.youtubePauseDecideTimer = null;
    }
  }

  private resumeYoutubeAfterSleep(): void {
    this.armSleepResume();
    this.holdScreen();
    if (this.youtubeFrameMatchesCurrent()) {
      this.handshakeYoutube();
      this.postYoutubeCommand('playVideo');
    }
    this.keepPlayingThroughSleep();
  }

  /** Tells the shared playback watcher that this pause came from the listener. */
  private markYoutubeUserPause(paused: boolean): void {
    const frame = this.youtubeFrame();
    if (!frame) {
      return;
    }
    if (paused) {
      frame.dataset['patUserPaused'] = '1';
    } else {
      delete frame.dataset['patUserPaused'];
    }
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
    this.listLoop = kept.repeat;
    this.claimPlaybackTab();
    this.playbackFollowsList = true;
    this.ytLinks = { ...this.ytLinks, ...kept.youtubeIds };
    this.volume = kept.volume;
    this.current = track;
    this.warmNowPlaying(track);
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
    this.youtubeEnded = false;
    this.ytIgnoreEnd = Date.now() + 2500;
    if (this.playing) {
      this.resumeHoldUntil = Date.now() + 2500;
    }
    this.cdr.detectChanges();
    this.armClipSound();
    this.pendingClipSeek = resumeSeconds > 1 ? resumeSeconds : -1;
    this.clipSeekSent = false;
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
    host.appendChild(frame);
    if (this.playing) {
      this.holdScreen();
    }
    this.handshakeYoutube();
    window.setTimeout(() => this.tryApplyClipSeek(true), 1200);
  }

  private mountKeptAudio(kept: HTMLAudioElement, time: number, playing: boolean): void {
    this.adoptedAudio = kept;
    this.youtubeEnded = false;
    if (playing) {
      this.resumeHoldUntil = Date.now() + 2500;
    }
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
    if (kept.ended && this.queueContinues()) {
      this.next();
    }
  }

  /** Drop the player parked by Continuer so the next title can load. */
  private releaseKeptMedia(): void {
    const frame = this.keptFrame;
    this.keptFrame = null;
    this.keptFrameActive = false;
    this.resumeHoldUntil = 0;
    if (frame) {
      frame.src = 'about:blank';
      frame.remove();
    }
    const kept = this.adoptedAudio;
    this.adoptedAudio = null;
    if (kept) {
      kept.dataset['patUserPaused'] = '1';
      kept.pause();
      kept.removeAttribute('src');
      kept.remove();
    }
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
    this.clipArmed = false;
    this.resetClipAspect();
    this.suppressChromeUntilLeave = false;
    this.chromeVisible = true;
    this.parkYoutubePlayer();
    const preview = (track.previewUrl || '').trim();
    if (!preview) {
      this.refreshPreview(track, true);
      if (this.playbackInterrupted()) {
        this.clearSleepKick();
        this.keepPlayingThroughSleep();
      }
      return;
    }
    this.startAudio(preview);
    if (this.playbackInterrupted()) {
      this.clearSleepKick();
      this.keepPlayingThroughSleep();
    }
  }

  /** The clip is the only soundtrack. Drop any preview that is still running or about to start. */
  private armClipSound(): void {
    this.clipArmed = true;
    this.previewToken += 1;
    this.silencePreviewUnderVideo();
    const id = this.currentYoutubeId();
    if (id) {
      this.loadClipAspect(id);
    }
  }

  private videoOwnsPlayback(): boolean {
    return this.clipArmed;
  }

  /** Keep the YouTube player alive and silent while a Deezer preview is the soundtrack. */
  private parkYoutubePlayer(): void {
    if (!this.youtubeEmbed && !this.keptFrameActive) {
      return;
    }
    this.markYoutubeUserPause(true);
    this.stopYoutubeHandshake();
    this.stopYoutubeClock();
    this.postYoutubeCommand('mute');
    this.postYoutubeCommand('pauseVideo');
  }

  private silencePreviewUnderVideo(): void {
    const audio = this.pageAudio();
    if (!audio) {
      return;
    }
    audio.dataset['patUserPaused'] = '1';
    audio.muted = true;
    if (!audio.paused) {
      audio.pause();
    }
  }

  /** Seconds stored for the next clip load. Consumed once so a later seekTo is not sent as well. */
  private takeVideoshowSeek(): number {
    const at = this.videoshowHandoffSec > 1 ? this.videoshowHandoffSec : this.pendingClipSeek;
    this.videoshowHandoffSec = -1;
    if (at <= 1) {
      return 0;
    }
    this.pendingClipSeek = -1;
    this.clipSeekSent = true;
    this.youtubeSeconds = at;
    return at;
  }

  /** Seek a restored clip once. A second seekTo is what pulls YouTube's sound off its picture. */
  private tryApplyClipSeek(force = false): void {
    const at = this.pendingClipSeek;
    if (at <= 1 || this.clipSeekSent) {
      if (at <= 1) {
        this.pendingClipSeek = -1;
      }
      return;
    }
    if ((!force && !this.ytApiListening) || !this.youtubeFrame()?.contentWindow) {
      return;
    }
    this.clipSeekSent = true;
    this.pendingClipSeek = -1;
    this.postYoutubeCommand('seekTo', [at, true]);
    if (this.playing) {
      this.postYoutubeCommand('playVideo');
    }
  }

  private clearYoutube(): void {
    this.clipArmed = false;
    this.resetClipAspect();
    this.pendingClipSeek = -1;
    this.clipSeekSent = false;
    const audio = this.pageAudio();
    if (audio) {
      audio.muted = false;
    }
    this.ytLog('iframe retirée');
    this.releaseKeptMedia();
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
    this.youtubePlayerState = -1;
    setScreenKeepAlive('youtube', false);
  }

  private resolveYoutube(track: DeezerTrack): void {
    const token = ++this.ytToken;
    if (this.ytListPlayId) {
      const id = this.ytListPlayId;
      this.ytListPlayId = '';
      this.ytLog(`resolve liste ${id}`);
      this.applyYoutubeHit(track, id, token);
      return;
    }
    if (this.ytOffer?.trackId === track.id && this.ytOffer.videoId) {
      this.ytLog(`resolve offre ${this.ytOffer.videoId}`);
      this.applyYoutubeHit(track, this.ytOffer.videoId, token);
      return;
    }
    const cached = this.ytCache.get(track.id);
    if (cached !== undefined) {
      this.ytLog(`resolve cache ${cached || 'aucun'}`);
      this.applyYoutubeHit(track, cached, token);
      return;
    }
    this.ytLog('resolve réseau');
    const q = this.youtubeQuery(track);
    if (q.length < 2) {
      this.playPreview(track);
      return;
    }
    this.youtubeBusy = true;
    if (!this.youtubeFrame()?.contentWindow) {
      this.youtubeEmbed = null;
    }
    this.ytSub?.unsubscribe();
    const source = this.concertSource(track.id) || track;
    this.ytSub = this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: source.artistName || '',
      title: source.title || ''
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
        this.rememberYoutubeChoices(track.id, link.videoIds);
        this.rememberYoutube(track.id, id);
        this.noteYoutubePage(track.id, link.more, this.trackHasYoutubeLinks(track.id, link.videoIds, link.videoId));
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
      this.playPreview(track);
      this.prefetchNextYoutube();
      return;
    }
    this.clipArmed = true;
    this.loadClipAspect(id);
    this.userHold = false;
    this.clearYoutubePauseDecide();
    this.markYoutubeUserPause(false);
    this.silencePreviewUnderVideo();
    this.holdScreen();
    this.youtubePlayerState = -1;
    this.youtubeTitle = `${track.artistName || ''} — ${track.title || ''}`.trim();
    this.ytIgnoreEnd = Date.now() + 4000;
    const frame = this.youtubeFrame();
    const already = (frame?.dataset['patVideoId'] || '').trim();
    this.ytLog(`apply ${id} déjà=${already || 'non'} écoute=${this.ytApiListening} ${this.ytCaller()}`);
    if (already === id && (this.youtubeEmbed || this.keptFrameActive)) {
      this.ytLog('même clip, pas de rechargement');
      return;
    }
    if (this.ytApiListening && frame?.contentWindow && (this.youtubeEmbed || this.keptFrameActive)) {
      frame.dataset['patVideoId'] = id;
      this.tagNowPlaying(frame);
      this.handshakeYoutube();
      const startSeconds = this.takeVideoshowSeek();
      this.postYoutubeCommand('loadVideoById', [{
        videoId: id,
        startSeconds
      }]);
      this.ytSoundArmed = false;
      this.playing = true;
      this.playErrorKey = '';
      this.armCleanVideoChrome();
      this.armYoutubeSound();
      if (this.playbackInterrupted()) {
        this.clearSleepKick();
        this.keepPlayingThroughSleep();
      }
      return;
    }
    const origin = typeof window !== 'undefined' ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}` : '';
    const replay = this.ytReplay ? `&ts=${this.ytReplay}` : '';
    const startSeconds = this.takeVideoshowSeek();
    const startQuery = startSeconds > 1 ? `&start=${Math.floor(startSeconds)}` : '';
    this.ytLog(`nouvelle iframe ${id}`);
    this.youtubeEmbed = this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1&playsinline=1&controls=1&fs=1&iv_load_policy=3${origin}${replay}${startQuery}`
    );
    this.armCleanVideoChrome();
    this.playing = true;
    this.playErrorKey = '';
    this.armYoutubeSound();
    if (this.playbackInterrupted()) {
      this.clearSleepKick();
      this.keepPlayingThroughSleep();
    }
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
          this.rememberYoutubeChoices(next.id, link.videoIds);
          this.rememberYoutube(next.id, (link.videoId || '').trim() || null);
          this.noteYoutubePage(next.id, link.more, this.trackHasYoutubeLinks(next.id, link.videoIds, link.videoId));
        }
      },
      error: () => { /* the track will be searched again when it starts */ }
    });
  }

  private lookupYoutubeLink(track: DeezerTrack, index: number): void {
    this.fetchYoutubeLink(track, index, '');
  }

  /** Plays the next result already in hand. The saved link changes only if the green control is used. */
  private playNextYoutubeChoice(track: DeezerTrack, index: number, skip: string, savedId: string): boolean {
    const nextId = this.nextYoutubeChoice(this.ytChoices.get(track.id) || [], skip);
    if (!nextId) {
      return false;
    }
    const kept = (savedId || '').trim();
    this.ytOffer = !kept || nextId === kept ? null : { trackId: track.id, videoId: nextId, savedId: kept };
    this.current = null;
    this.playYoutubeTrack(track, index);
    return true;
  }

  private nextYoutubeChoice(choices: string[], skip: string): string {
    const ids: string[] = [];
    for (const id of choices) {
      const videoId = (id || '').trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId) && !ids.includes(videoId)) {
        ids.push(videoId);
      }
    }
    if (ids.length < 2 || !skip) {
      return '';
    }
    const at = ids.indexOf(skip);
    if (at >= 0) {
      const next = ids[(at + 1) % ids.length];
      return next === skip ? '' : next;
    }
    return ids.find((id) => id !== skip) || '';
  }

  /** Plays the next search result. The saved link changes only if the green control is used. */
  private lookupNextYoutubeLink(track: DeezerTrack, index: number, skipVideoId?: string): void {
    const skip = (skipVideoId || this.ytLinks[track.id] || '').trim();
    if (!skip) {
      return;
    }
    this.fetchYoutubeLink(track, index, skip);
  }

  keepYoutubeOffer(track: DeezerTrack, event?: Event): void {
    event?.stopPropagation();
    const offer = this.ytOffer;
    if (!offer || offer.trackId !== track.id || this.ytNextBusy[track.id]) {
      return;
    }
    this.ytPlaceOff.add(track.id);
    this.ytNextBusy = { ...this.ytNextBusy, [track.id]: true };
    this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: track.artistName || '',
      title: track.title || '',
      saveVideoId: offer.videoId
    }], false).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        this.clearYoutubeNext(track.id);
        const link = (page?.links || []).find((item) => item.id === track.id);
        const videoId = (link?.videoId || '').trim();
        if (!videoId || videoId !== offer.videoId) {
          this.ytPlaceOff.delete(track.id);
          return;
        }
        this.rememberYoutube(track.id, videoId);
        if (this.ytOffer?.trackId === track.id) {
          this.ytOffer = null;
        }
      },
      error: () => {
        this.ytPlaceOff.delete(track.id);
        this.clearYoutubeNext(track.id);
      }
    });
  }

  dropYoutubeOffer(track: DeezerTrack, index: number, event?: Event): void {
    event?.stopPropagation();
    if (this.ytOffer?.trackId !== track.id) {
      return;
    }
    this.ytPlaceOff.add(track.id);
    this.ytOffer = null;
    if (this.current?.id !== track.id) {
      return;
    }
    const at = index >= 0 ? index : Math.max(0, this.queue.findIndex((item) => item.id === track.id));
    this.current = null;
    this.playYoutubeTrack(track, at);
  }

  private fetchYoutubeLink(track: DeezerTrack, index: number, skipVideoId: string): void {
    if (this.youtubeQuery(track).length < 2) {
      return;
    }
    if (skipVideoId) {
      this.ytNextBusy = { ...this.ytNextBusy, [track.id]: true };
    } else {
      this.ytPending = { ...this.ytPending, [track.id]: true };
    }
    this.holdYoutubeScan();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.releaseYoutubeScan();
    };
    this.api.resolveDeezerYoutubeLinks([{
      id: track.id,
      artist: track.artistName || '',
      title: track.title || '',
      skipVideoId: skipVideoId || undefined
    }], true).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        try {
          if (skipVideoId) {
            this.clearYoutubeNext(track.id);
          } else {
            this.clearYoutubePending(track.id);
          }
          const link = (page?.links || []).find((item) => item.id === track.id);
          if (!link) {
            return;
          }
          const videoId = (link.videoId || '').trim() || null;
          this.rememberYoutubeChoices(track.id, link.videoIds);
          this.noteYoutubePage(track.id, link.more, this.trackHasYoutubeLinks(track.id, link.videoIds, link.videoId));
          if (skipVideoId) {
            if (!videoId || videoId === skipVideoId) {
              return;
            }
            this.ytOffer = {
              trackId: track.id,
              videoId,
              savedId: this.ytLinks[track.id] || skipVideoId
            };
            this.current = null;
            this.playYoutubeTrack(track, index);
            return;
          }
          this.rememberYoutube(track.id, videoId);
          if (videoId) {
            this.playYoutubeTrack(track, index);
          }
        } finally {
          release();
        }
      },
      error: () => {
        try {
          if (skipVideoId) {
            this.clearYoutubeNext(track.id);
          } else {
            this.clearYoutubePending(track.id);
          }
        } finally {
          release();
        }
      }
    });
  }

  private clearYoutubeNext(id: number): void {
    if (!this.ytNextBusy[id]) {
      return;
    }
    const next = { ...this.ytNextBusy };
    delete next[id];
    this.ytNextBusy = next;
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
    } else {
      const links = { ...this.ytLinks };
      delete links[id];
      this.ytLinks = links;
      const cached = { ...this.ytFromCache };
      delete cached[id];
      this.ytFromCache = cached;
      this.ytMiss = { ...this.ytMiss, [id]: true };
      this.ytChoices.delete(id);
    }
    this.rebuildMembershipVideos();
  }

  private rememberYoutubeChoices(id: number, videoIds: string[] | undefined): void {
    const ids: string[] = [];
    for (const raw of videoIds || []) {
      const videoId = (raw || '').trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(videoId) && !ids.includes(videoId)) {
        ids.push(videoId);
      }
    }
    if (ids.length > 1) {
      this.ytChoices.set(id, ids);
    }
  }

  private syncYoutubeButtons(): void {
    if (this.listMode === 'concert' && !this.nowBrowse && !this.drilled) {
      this.pinConcertVideos();
      return;
    }
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

  /** The list scan stops launching YouTube calls until the title the user asked for has an answer. */
  private holdYoutubeScan(): void {
    this.ytScanHold++;
    this.ytPrefetch?.unsubscribe();
    this.ytPrefetch = null;
    this.ytScan?.unsubscribe();
    this.ytScan = null;
  }

  private releaseYoutubeScan(): void {
    if (this.ytScanHold > 0) {
      this.ytScanHold--;
    }
    if (this.ytScanHold > 0 || !this.ytScanRest) {
      return;
    }
    const rest = this.ytScanRest;
    this.scanYoutube(rest.tracks, rest.index, rest.key);
  }

  private scanYoutube(tracks: DeezerTrack[], index: number, key: string): void {
    if (key !== this.ytScanKey || index >= tracks.length) {
      if (this.ytScanRest?.key === key) {
        this.ytScanRest = null;
      }
      return;
    }
    if (this.ytScanHold > 0) {
      this.ytScanRest = { tracks, index, key };
      return;
    }
    // Titles on screen only read the stored cache. YouTube itself is queried when a title
    // starts (that title, then the next one) and when its YouTube icon is clicked.
    const slice = tracks.slice(index, index + 20);
    this.ytScanRest = { tracks, index, key };
    this.ytScan = this.api.resolveDeezerYoutubeLinks(slice.map((track) => ({
      id: track.id,
      artist: track.artistName || '',
      title: track.title || ''
    })), false).pipe(takeUntil(this.destroy$)).subscribe({
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

  private applyYoutubeLinks(links: { id: number; videoId?: string; cached?: boolean; videoIds?: string[]; more?: boolean }[]): void {
    for (const link of links) {
      this.rememberYoutubeChoices(link.id, link.videoIds);
      this.rememberYoutube(link.id, (link.videoId || '').trim() || null);
      this.noteYoutubePage(link.id, link.more, this.trackHasYoutubeLinks(link.id, link.videoIds, link.videoId));
    }
  }

  private trackHasYoutubeLinks(id: number, videoIds: string[] | undefined, videoId: string | undefined): boolean {
    if ((videoId || '').trim() || (this.ytLinks[id] || '').trim()) {
      return true;
    }
    return (videoIds || []).some((raw) => /^[a-zA-Z0-9_-]{11}$/.test((raw || '').trim()));
  }

  private noteYoutubePage(id: number, more: boolean | undefined, hasLinks: boolean): void {
    if (more === false || !hasLinks) {
      this.ytMoreOff.add(id);
      return;
    }
    if (more === true) {
      this.ytMoreOff.delete(id);
    }
  }

  private clearYoutubeMore(id: number): void {
    if (!this.ytMoreBusy[id]) {
      return;
    }
    const next = { ...this.ytMoreBusy };
    delete next[id];
    this.ytMoreBusy = next;
  }

  private clearYoutubeClear(id: number): void {
    if (!this.ytClearBusy[id]) {
      return;
    }
    const next = { ...this.ytClearBusy };
    delete next[id];
    this.ytClearBusy = next;
  }

  /** Forgets the stored clips for one title without recording a miss. */
  private forgetYoutubeList(id: number): void {
    this.ytCache.delete(id);
    this.ytChoices.delete(id);
    this.ytMoreOff.delete(id);
    this.ytPlaceOff.delete(id);
    const links = { ...this.ytLinks };
    delete links[id];
    this.ytLinks = links;
    const cached = { ...this.ytFromCache };
    delete cached[id];
    this.ytFromCache = cached;
    if (this.ytMiss[id]) {
      const miss = { ...this.ytMiss };
      delete miss[id];
      this.ytMiss = miss;
    }
    if (this.ytOffer?.trackId === id) {
      this.ytOffer = null;
    }
    this.rebuildMembershipVideos();
  }

  private youtubeQuery(track: DeezerTrack): string {
    const source = this.concertSource(track.id) || track;
    return `${source.artistName || ''} ${source.title || ''}`.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  /** Original Deezer title behind a concert row, so YouTube search does not use the display name. */
  private concertSource(playId: number): DeezerTrack | null {
    const item = this.concertItems.find((entry) => entry.playId === playId);
    return item?.track?.id ? item.track : null;
  }

  /** YouTube autoplay starts muted. Ask the player to turn the sound on once it accepts commands. */
  private armYoutubeSound(): void {
    this.stopYoutubeHandshake();
    this.ytApiListening = false;
    this.ytSoundArmed = false;
    this.ytHandshakeTries = 0;
    this.handshakeYoutube();
    this.pushYoutubeSound();
  }

  private stopYoutubeClock(): void {
    if (this.youtubeClock != null) {
      clearInterval(this.youtubeClock);
      this.youtubeClock = undefined;
    }
  }

  private resetClipAspect(): void {
    this.clipAspectId = '';
    this.clipAspectW = 16;
    this.clipAspectH = 9;
  }

  /** YouTube oEmbed width/height matches the picture (4:3, 16:9, vertical, …). */
  private loadClipAspect(id: string): void {
    const videoId = (id || '').trim();
    if (!videoId) {
      return;
    }
    const cached = this.clipAspectCache.get(videoId);
    if (cached) {
      this.clipAspectId = videoId;
      this.clipAspectW = cached.w;
      this.clipAspectH = cached.h;
      return;
    }
    this.clipAspectId = videoId;
    this.clipAspectW = 16;
    this.clipAspectH = 9;
    const endpoint = this.api.getYoutubeClipSize(videoId);
    endpoint.pipe(takeUntil(this.destroy$)).subscribe({
      next: (data) => {
        if (!data || this.clipAspectId !== videoId) {
          return;
        }
        const w = Number(data.width);
        const h = Number(data.height);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16) {
          return;
        }
        const ratio = w / h;
        if (ratio < 0.35 || ratio > 3.2) {
          return;
        }
        this.clipAspectCache.set(videoId, { w, h });
        this.ytLog(`format image ${w}×${h}`);
        if (this.youtubePlayerState === 1 || this.youtubePlayerState === 3) {
          this.ytLog('format ignoré, le clip joue déjà');
          return;
        }
        this.clipAspectW = w;
        this.clipAspectH = h;
        this.cdr.markForCheck();
      },
      error: () => undefined
    });
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
    if (this.userHold || this.youtubeFrame()?.dataset['patUserPaused'] === '1') {
      return;
    }
    if (this.ytSoundArmed || !this.youtubeEmbed || !this.youtubeFrame()?.contentWindow) {
      return;
    }
    this.postYoutubeCommand('unMute');
    this.postYoutubeCommand('setVolume', [100]);
  }

  private ytCaller(): string {
    const stack = new Error().stack || '';
    return stack.split('\n').slice(2, 5).map((line) => line.trim().replace(/^at /, '')).join(' <- ');
  }

  private ytLog(message: string): void {
    const sec = Number.isFinite(this.youtubeSeconds) ? `${this.youtubeSeconds.toFixed(1)}s` : '?';
    console.log(`[Deezer YT ${sec}] ${message}`);
  }

  private postYoutubeCommand(func: string, args: unknown[] = []): void {
    const frame = this.youtubeFrame()?.contentWindow;
    if (!frame) {
      return;
    }
    if (func === 'playVideo') {
      this.youtubeCommandPlayAt = Date.now();
    }
    if (func !== 'getCurrentTime') {
      this.ytLog(`ordre ${func}${args.length ? ' ' + JSON.stringify(args) : ''}`);
    }
    try {
      frame.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
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
    if (this.listMode === 'concert') {
      this.queue = this.concertAsTracks();
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
    const q = this.foldSearch(this.query);
    return !q || this.foldSearch(text).includes(q);
  }

  /** Ignore accents so "mylene" matches "Mylène". */
  private foldSearch(value: string | null | undefined): string {
    return (value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  private trackHay(track: DeezerTrack): string {
    return `${track.title || ''} ${track.artistName || ''} ${track.albumTitle || ''}`;
  }

  /** Text shown on a concert row: custom name, title, artist, album. */
  private concertHay(item: DeezerConcertTrack): string {
    const track = item.track;
    return `${item.name || ''} ${track?.title || ''} ${track?.artistName || ''} ${track?.albumTitle || ''}`;
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

  private rememberRecentSearch(term: string): void {
    const value = (term || '').trim();
    if (value.length < 2) {
      return;
    }
    const lower = value.toLowerCase();
    const next = [
      value,
      ...this.recentSearches.filter((item) => item.toLowerCase() !== lower)
    ].slice(0, DeezerWatcherComponent.RECENT_MAX);
    this.recentSearches = next;
    this.writeRecentSearches(next);
  }

  private readRecentSearches(): string[] {
    try {
      const raw = localStorage.getItem(DeezerWatcherComponent.RECENT_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, DeezerWatcherComponent.RECENT_MAX);
    } catch {
      return [];
    }
  }

  private writeRecentSearches(terms: string[]): void {
    try {
      localStorage.setItem(DeezerWatcherComponent.RECENT_KEY, JSON.stringify(terms));
    } catch {
      /* ignore quota / private mode */
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
      this.playlistTrackIds = new Set();
      this.rebuildMembershipVideos();
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
    this.playlistTrackIds = this.collectPlaylistTrackIds(this.userPlaylists);
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
    this.scheduleMembershipVideos();
  }

  private collectPlaylistTrackIds(playlists: DeezerUserPlaylist[]): Set<number> {
    const ids = new Set<number>();
    for (const playlist of playlists) {
      for (const track of playlist.tracks || []) {
        if (track?.id) {
          ids.add(track.id);
        }
      }
    }
    return ids;
  }

  private collectFavoriteTrackIds(items: DzFav[]): Set<number> {
    const ids = new Set<number>();
    for (const fav of items) {
      if (fav.kind === 'track' && fav.track?.id) {
        ids.add(fav.track.id);
      }
    }
    return ids;
  }

  private youtubeIdOf(trackId: number | null | undefined): string {
    return (trackId ? this.ytLinks[trackId] || '' : '').trim();
  }

  private rebuildConcertVideos(): void {
    const ids = new Set<string>();
    for (const item of this.concertItems) {
      const videoId = (item.videoId || '').trim();
      if (videoId) {
        ids.add(videoId);
      }
    }
    this.concertVideoIds = ids;
  }

  private rebuildMembershipVideos(): void {
    this.playlistVideoIds = this.videoIdsFor(this.playlistTrackIds);
    this.favoriteVideoIds = this.videoIdsFor(this.favoriteTrackIds);
  }

  private videoIdsFor(trackIds: Set<number>): Set<string> {
    const videos = new Set<string>();
    for (const id of trackIds) {
      const videoId = (this.ytLinks[id] || '').trim();
      if (videoId) {
        videos.add(videoId);
      }
    }
    return videos;
  }

  /** Load the YouTube clip already stored for each saved Deezer track, then match on that clip. */
  private scheduleMembershipVideos(): void {
    this.rebuildMembershipVideos();
    const missing: number[] = [];
    const seen = new Set<number>();
    for (const id of [...this.playlistTrackIds, ...this.favoriteTrackIds]) {
      if (id > 0 && !seen.has(id) && !this.ytCache.has(id) && !this.membershipLooked.has(id)) {
        seen.add(id);
        missing.push(id);
      }
    }
    if (!missing.length) {
      return;
    }
    this.membershipEpoch++;
    this.fetchMembershipBatch(missing, 0, this.membershipEpoch);
  }

  private fetchMembershipBatch(ids: number[], index: number, epoch: number): void {
    if (epoch !== this.membershipEpoch || index >= ids.length) {
      if (epoch === this.membershipEpoch) {
        this.rebuildMembershipVideos();
      }
      return;
    }
    const slice = ids.slice(index, index + 400);
    this.membershipSub?.unsubscribe();
    this.membershipSub = this.api.getStoredDeezerYoutubeLinks(slice).pipe(takeUntil(this.destroy$)).subscribe({
      next: (page) => {
        if (epoch !== this.membershipEpoch) {
          return;
        }
        for (const id of slice) {
          this.membershipLooked.add(id);
        }
        for (const link of page?.links || []) {
          const videoId = (link.videoId || '').trim();
          if (videoId) {
            this.rememberYoutubeChoices(link.id, link.videoIds);
            this.rememberYoutube(link.id, videoId);
            this.noteYoutubePage(link.id, link.more, true);
          }
        }
        this.fetchMembershipBatch(ids, index + slice.length, epoch);
      },
      error: () => {
        if (epoch === this.membershipEpoch) {
          this.rebuildMembershipVideos();
        }
      }
    });
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

  private ensureConcertLogin(): boolean {
    if (this.keycloak.isLoggedIn()) {
      return true;
    }
    this.concertHint = 'DEEZER.CONCERT_LOGIN';
    if (this.listMode !== 'concert') {
      this.setListMode('concert');
    }
    return false;
  }

  private loadConcert(): void {
    if (!this.keycloak.isLoggedIn()) {
      this.concertItems = [];
      this.rebuildConcertVideos();
      this.concertReady = true;
      return;
    }
    this.concertReady = false;
    this.concertError = '';
    const epoch = this.concertEpoch;
    this.concertSub?.unsubscribe();
    this.concertSub = this.api.getDeezerConcert().subscribe({
      next: (page) => {
        if (epoch !== this.concertEpoch) {
          return;
        }
        this.concertReady = true;
        this.applyConcert(page?.tracks || []);
      },
      error: () => {
        if (epoch !== this.concertEpoch) {
          return;
        }
        this.concertReady = true;
        this.concertError = 'DEEZER.CONCERT_ERR_LOAD';
      }
    });
  }

  private applyConcert(items: DeezerConcertTrack[]): void {
    this.concertItems = this.cleanConcert(items);
    this.rebuildConcertVideos();
    this.pinConcertVideos();
    if (this.current) {
      const live = this.concertItems.find((item) => item.playId === this.current!.id);
      if (live && (this.current.title !== live.name || this.current.coverUrl !== this.concertThumb(live))) {
        this.current = { ...this.current, title: live.name, coverUrl: this.concertThumb(live) };
      }
    }
    if (this.keycloak.isLoggedIn()) {
      this.concertHint = '';
    }
    if (this.renamingConcertId && !this.concertItems.some((item) => item.id === this.renamingConcertId)) {
      this.renamingConcertId = '';
    }
    if (this.playbackListMode === 'concert') {
      this.queue = this.concertAsTracks();
    }
    this.refreshQueue();
  }

  private cleanConcert(items: DeezerConcertTrack[]): DeezerConcertTrack[] {
    return (items || [])
      .filter((item) => !!item?.id && !!item.playId && !!item.track?.id && !!(item.name || '').trim() && !!(item.track?.title || '').trim())
      .map((item) => ({
        id: item.id,
        playId: item.playId,
        videoId: item.videoId,
        name: item.name,
        track: item.track
      }));
  }

  private concertAsTracks(): DeezerTrack[] {
    return this.shownConcert
      .filter((item) => item.playId && item.track?.id)
      .map((item) => this.concertTrack(item));
  }

  private concertTrack(item: DeezerConcertTrack): DeezerTrack {
    const source = item.track;
    return {
      id: item.playId,
      title: item.name,
      artistName: source?.artistName || '',
      artistId: source?.artistId,
      albumTitle: source?.albumTitle,
      albumId: source?.albumId,
      releaseDate: source?.releaseDate,
      fanCount: source?.fanCount,
      coverUrl: this.concertThumb(item),
      previewUrl: source?.previewUrl,
      durationSec: source?.durationSec,
      explicit: source?.explicit,
      link: source?.link
    };
  }

  private pinConcertVideos(): void {
    let links = this.ytLinks;
    let fromCache = this.ytFromCache;
    let changed = false;
    for (const item of this.concertItems) {
      const videoId = (item.videoId || '').trim();
      if (!item.playId || !videoId) {
        continue;
      }
      this.ytCache.set(item.playId, videoId);
      if (links[item.playId] !== videoId) {
        links = { ...links, [item.playId]: videoId };
        fromCache = { ...fromCache, [item.playId]: true };
        changed = true;
      }
      if (this.ytMiss[item.playId]) {
        const miss = { ...this.ytMiss };
        delete miss[item.playId];
        this.ytMiss = miss;
      }
    }
    if (changed) {
      this.ytLinks = links;
      this.ytFromCache = fromCache;
    }
  }

  private loadFavorites(): void {
    if (!this.keycloak.isLoggedIn()) {
      this.favorites = [];
      this.favoriteTrackIds = new Set();
      this.rebuildMembershipVideos();
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
    this.favoriteTrackIds = this.collectFavoriteTrackIds(this.favorites);
    this.scheduleMembershipVideos();
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
