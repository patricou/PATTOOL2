import {
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  YoutubeItem,
  YoutubeItemKind,
  YoutubeSearchPage
} from '../services/api.service';
import { YoutubePlayerService } from '../services/youtube-player.service';
import { EvenementsService, StreamedEvent } from '../services/evenements.service';
import { MembersService } from '../services/members.service';
import { Evenement } from '../model/evenement';
import { UrlEvent } from '../model/url-event';
import { isYoutubeVideoId, parseYoutubeVideoId, youtubeWatchUrl } from '../shared/youtube-video-id.util';
import { openWhatsAppTextShare } from '../shared/share-whatsapp-image.util';
import {
  VideoshowModalComponent,
  VideoshowVideoSource
} from '../shared/videoshow-modal/videoshow-modal.component';

interface YoutubeRegionOption {
  code: string;
  label: string;
}

type YoutubeSortKey = 'relevance' | 'date' | 'views' | 'duration' | 'title' | 'channel';
type YoutubeSortDir = 'asc' | 'desc';

@Component({
  selector: 'app-youtube-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, VideoshowModalComponent],
  providers: [EvenementsService],
  templateUrl: './youtube-watcher.component.html',
  styleUrls: ['./youtube-watcher.component.css']
})
export class YoutubeWatcherComponent implements OnInit, OnDestroy {
  readonly types: YoutubeItemKind[] = ['video', 'playlist', 'channel'];
  readonly sortKeys: YoutubeSortKey[] = ['relevance', 'date', 'views', 'duration', 'title', 'channel'];
  readonly regions: YoutubeRegionOption[] = [
    { code: 'FR', label: 'France' },
    { code: 'BE', label: 'Belgique' },
    { code: 'CH', label: 'Suisse' },
    { code: 'CA', label: 'Canada' },
    { code: 'US', label: 'United States' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'DE', label: 'Deutschland' },
    { code: 'ES', label: 'España' },
    { code: 'IT', label: 'Italia' },
    { code: 'PT', label: 'Portugal' },
    { code: 'NL', label: 'Nederland' },
    { code: 'BR', label: 'Brasil' },
    { code: 'JP', label: '日本' },
    { code: 'IN', label: 'भारत' },
    { code: 'KR', label: '한국' },
    { code: 'IL', label: 'ישראל' },
    { code: 'SA', label: 'السعودية' },
    { code: 'GR', label: 'Ελλάδα' },
    { code: 'RU', label: 'Россия' },
    { code: 'CN', label: '中国' }
  ];

  query = '';
  type: YoutubeItemKind = 'video';
  regionCode = 'FR';
  channelId = '';
  items: YoutubeItem[] = [];
  selected: YoutubeItem | null = null;
  embedUrl: SafeResourceUrl | null = null;
  playerOpen = false;
  nextPageToken: string | null = null;
  resultKind: 'search' | 'popular' | string = 'popular';
  total = 0;

  searching = false;
  loadingMore = false;
  searched = false;
  errorMessage = '';
  missingKey = false;

  tickerEnabled = true;
  readonly tickerRepeats = [0, 1, 2, 3, 4, 5];
  tickerDurationSec = 40;
  sortKey: YoutubeSortKey = 'relevance';
  sortDir: YoutubeSortDir = 'asc';

  /**
   * Mobile landscape: immersive player (CSS + best-effort native fullscreen).
   * HostBinding keeps the iframe covering the viewport if Fullscreen API is blocked.
   */
  @HostBinding('class.yt-landscape-fs') landscapeFullscreen = false;
  @ViewChild('playerFrame') playerFrame?: ElementRef<HTMLElement>;
  @ViewChild('linkToEventModal') linkToEventModal?: TemplateRef<unknown>;
  @ViewChild('videoshowModalComponent') videoshowModalComponent?: VideoshowModalComponent;

  private readonly query$ = new Subject<string>();
  private searchSub?: Subscription;
  private readonly subs: Subscription[] = [];
  private readonly itemSourceOrder = new WeakMap<YoutubeItem, number>();
  private itemSourceSeq = 0;

  private static readonly LANDSCAPE_FS_BODY_CLASS = 'yt-landscape-fs';
  private static readonly PAGE_THEME_BODY_CLASS = 'yt-page-theme';
  private static readonly TICKER_STORAGE_KEY = 'pattool.youtube.ticker-enabled';

  private landscapeFsUserDismissed = false;
  private landscapeFsNativeRequested = false;
  private landscapeFsNativeActive = false;
  private landscapeFsSuppressDismiss = false;
  private landscapeOrientationMql: MediaQueryList | null = null;
  private readonly onLandscapeOrientationMedia = (): void => this.syncLandscapeFullscreen();
  private readonly onLandscapeFsChange = (): void => this.onLandscapeNativeFullscreenChange();

  linkEventsList: Evenement[] = [];
  linkEventsFilter = '';
  linkEventsTypeFilter = '';
  linkEventsLoading = false;
  linkEventsError = false;
  linkSavingEventId: string | null = null;
  linkFeedbackKey: string | null = null;
  linkFeedbackParams: { name?: string } = {};
  linkFeedbackKind: 'success' | 'error' | null = null;
  readonly linkEventTypeOptions: ReadonlyArray<{ value: string; labelKey: string }> = [
    { value: '11', labelKey: 'EVENTCREATION.TYPE.DOCUMENTS' },
    { value: '12', labelKey: 'EVENTCREATION.TYPE.FICHE' },
    { value: '3', labelKey: 'EVENTCREATION.TYPE.RUN' },
    { value: '6', labelKey: 'EVENTCREATION.TYPE.PARTY' },
    { value: '4', labelKey: 'EVENTCREATION.TYPE.WALK' },
    { value: '10', labelKey: 'EVENTCREATION.TYPE.PHOTOS' },
    { value: '9', labelKey: 'EVENTCREATION.TYPE.RANDO' },
    { value: '2', labelKey: 'EVENTCREATION.TYPE.SKI' },
    { value: '7', labelKey: 'EVENTCREATION.TYPE.VACATION' },
    { value: '5', labelKey: 'EVENTCREATION.TYPE.BIKE' },
    { value: '8', labelKey: 'EVENTCREATION.TYPE.TRAVEL' },
    { value: '1', labelKey: 'EVENTCREATION.TYPE.VTT' },
    { value: '13', labelKey: 'EVENTCREATION.TYPE.WINE' },
    { value: '14', labelKey: 'EVENTCREATION.TYPE.OTHER' },
    { value: '15', labelKey: 'EVENTCREATION.TYPE.VISIT' },
    { value: '16', labelKey: 'EVENTCREATION.TYPE.WORK' },
    { value: '17', labelKey: 'EVENTCREATION.TYPE.FAMILY' },
    { value: '18', labelKey: 'EVENTCREATION.TYPE.CINEMA' },
    { value: '19', labelKey: 'EVENTCREATION.TYPE.MUSIQUE' },
    { value: '20', labelKey: 'EVENTCREATION.TYPE.CUISINE' }
  ];
  linkTarget: YoutubeItem | null = null;
  private linkModalRef: NgbModalRef | null = null;
  private linkEventsStreamSub?: Subscription;
  private linkSaveSub?: Subscription;
  private linkFeedbackTimer?: ReturnType<typeof setTimeout>;
  private scrollTopTimer?: ReturnType<typeof setTimeout>;
  private static readonly LINK_FEEDBACK_AUTO_CLOSE_MS = 1800;
  private videoshowRestorePip = false;

  playbackCurrentSec = 0;
  playbackDurationSec = 0;
  playAllActive = false;
  playbackPaused = false;
  private ytProgressTimer?: ReturnType<typeof setInterval>;
  private ignoreQueueEndedUntil = 0;
  private embedGeneration = 0;

  constructor(
    private api: ApiService,
    private youtubePlayer: YoutubePlayerService,
    private translate: TranslateService,
    private sanitizer: DomSanitizer,
    private route: ActivatedRoute,
    private router: Router,
    private evenementsService: EvenementsService,
    private membersService: MembersService,
    private modalService: NgbModal,
    private ngZone: NgZone,
    private host: ElementRef<HTMLElement>
  ) {}

  ngOnInit(): void {
    const params = this.route.snapshot.queryParamMap;
    this.regionCode = this.normalizeRegion(
      params.get('region') || this.regionFromUiLang(this.translate.currentLang)
    );
    this.type = this.normalizeType(params.get('type'));
    this.query = (params.get('q') || '').trim();
    this.channelId = (params.get('channel') || '').trim();
    this.tickerEnabled = this.readTickerPreference();
    this.sortKey = this.normalizeSort(params.get('sort'));
    this.sortDir = this.normalizeSortDir(params.get('dir'), this.sortKey);

    this.subs.push(
      this.query$.pipe(debounceTime(450), distinctUntilChanged()).subscribe((value) => {
        if (value.trim().length >= 2) {
          this.runSearch();
        }
      })
    );

    this.subs.push(
      this.youtubePlayer.state$.subscribe((s) => {
        this.playerOpen = s.open;
        if (s.open) {
          this.stopYoutubeProgressWatch();
        }
        if (s.item) {
          this.selected = this.decodeYoutubeItem(s.item);
        }
        this.syncLandscapeFullscreen();
      })
    );

    this.subs.push(
      this.youtubePlayer.ended$.subscribe(() => {
        this.ngZone.run(() => this.onQueueVideoEnded());
      })
    );

    this.subs.push(
      this.youtubePlayer.paused$.subscribe((paused) => {
        if (this.playerOpen) {
          this.playbackPaused = paused;
        }
      })
    );

    document.body.classList.add(YoutubeWatcherComponent.PAGE_THEME_BODY_CLASS);
    this.setupLandscapeFullscreenWatchers();
    this.syncLandscapeFullscreen();

    if (this.query || this.channelId) {
      this.runSearch(params.get('id'));
    } else {
      this.loadPopular(params.get('id'));
    }
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
    this.teardownLandscapeFullscreenWatchers();
    this.exitLandscapeFullscreen(false);
    document.body.classList.remove(YoutubeWatcherComponent.PAGE_THEME_BODY_CLASS);
    this.closeLinkToEventModal();
    this.linkEventsStreamSub?.unsubscribe();
    this.linkSaveSub?.unsubscribe();
    if (this.linkFeedbackTimer !== undefined) {
      clearTimeout(this.linkFeedbackTimer);
    }
    this.stopYoutubeProgressWatch();
    this.stopPlayAll();
    if (this.scrollTopTimer !== undefined) {
      clearTimeout(this.scrollTopTimer);
    }
  }

  onQueryChanged(): void {
    this.channelId = '';
    this.query$.next(this.query);
  }

  onFilterChanged(): void {
    if (this.query.trim() || this.channelId) {
      this.runSearch();
    } else {
      this.loadPopular();
    }
  }

  submitSearch(): void {
    if (!this.query.trim() && !this.channelId) {
      return;
    }
    this.runSearch();
  }

  clearSearch(): void {
    this.searchSub?.unsubscribe();
    this.query = '';
    this.channelId = '';
    this.type = 'video';
    this.items = [];
    this.nextPageToken = null;
    this.searched = false;
    this.errorMessage = '';
    this.searching = false;
    this.loadingMore = false;
    this.resultKind = 'popular';
    this.stopPlayAll();
    this.syncUrl();
    this.loadPopular();
  }

  selectItem(item: YoutubeItem): void {
    if (!item?.id) {
      return;
    }
    if (item.kind === 'channel' && item.id) {
      this.stopPlayAll();
      this.channelId = item.id;
      this.query = '';
      this.type = 'video';
      this.runSearch();
      return;
    }
    this.selected = this.decodeYoutubeItem(item);
    this.resetPlaybackClock(this.selected);
    this.playbackPaused = false;
    if (this.playerOpen) {
      this.embedUrl = null;
      this.stopYoutubeProgressWatch();
      this.youtubePlayer.open(this.selected, { keepMinimized: this.playAllActive });
    } else {
      this.embedUrl = this.buildEmbedUrl(this.selected, true);
    }
    this.scrollPageToTop();
    void this.syncUrl().then(() => this.scrollPageToTop());
    setTimeout(() => this.syncLandscapeFullscreen(), 0);
  }

  openInFloatingWindow(): void {
    if (!this.selected) {
      return;
    }
    this.exitLandscapeFullscreen(false);
    this.embedUrl = null;
    this.stopYoutubeProgressWatch();
    this.youtubePlayer.open(this.selected);
  }

  restorePlayer(): void {
    this.youtubePlayer.restore();
  }

  onTickerToggle(): void {
    this.writeTickerPreference(this.tickerEnabled);
  }

  onSortKeyChanged(): void {
    this.sortDir = this.defaultSortDir(this.sortKey);
    if (this.query.trim() || this.channelId) {
      this.runSearch();
      return;
    }
    this.sortItems();
    this.syncUrl();
  }

  toggleSortDir(): void {
    this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    this.sortItems();
    this.syncUrl();
  }

  get tickerItem(): YoutubeItem | null {
    return this.selected;
  }

    tickerModeLabelKey(): string {
    return this.playerOpen ? 'YOUTUBE.TICKER_MODE_PIP' : 'YOUTUBE.TICKER_MODE_PAGE';
  }

  get canPlayAll(): boolean {
    return this.queueItems().length > 0;
  }

  playAllIndex(): number {
    return this.queueIndexOf(this.selected);
  }

  playAllCount(): number {
    return this.queueItems().length;
  }

  get queuePaused(): boolean {
    if (!this.selected || (!this.embedUrl && !this.playerOpen)) {
      return true;
    }
    return this.playbackPaused;
  }

  playQueuePrev(): void {
    const list = this.queueItems();
    if (!list.length) {
      return;
    }
    const idx = this.queueIndexOf(this.selected);
    const prev = list[(idx <= 0 ? list.length : idx) - 1];
    this.playQueueItem(prev);
  }

  playQueueNext(): void {
    const list = this.queueItems();
    if (!list.length) {
      return;
    }
    const idx = this.queueIndexOf(this.selected);
    const next = list[(idx < 0 ? 0 : idx + 1) % list.length];
    this.playQueueItem(next);
  }

  togglePlaybackPause(): void {
    if (!this.selected || (!this.embedUrl && !this.playerOpen)) {
      this.startPlayAll();
      return;
    }
    const pause = !this.queuePaused;
    this.playbackPaused = pause;
    if (this.playerOpen) {
      this.youtubePlayer.sendCommand(pause ? 'pause' : 'play');
      return;
    }
    this.handshakeYoutubePlayer();
    this.sendYoutubeCommand(pause ? 'pauseVideo' : 'playVideo');
  }

  togglePlayAll(): void {
    if (this.playAllActive) {
      this.stopPlayAll();
      return;
    }
    this.startPlayAll();
  }

  private startPlayAll(): void {
    const list = this.queueItems();
    if (!list.length) {
      return;
    }
    this.playAllActive = true;
    this.playbackPaused = false;
    const currentIdx = this.queueIndexOf(this.selected);
    if (currentIdx >= 0 && (this.embedUrl || this.playerOpen)) {
      if (
        this.playbackDurationSec > 0 &&
        this.playbackCurrentSec >= this.playbackDurationSec - 0.5
      ) {
        this.onQueueVideoEnded();
      }
      return;
    }
    this.playQueueItem(list[currentIdx >= 0 ? currentIdx : 0]);
  }

  private stopPlayAll(): void {
    this.playAllActive = false;
  }

  private queueItems(): YoutubeItem[] {
    const seen = new Set<string>();
    const out: YoutubeItem[] = [];
    for (const item of this.items) {
      if (!this.isQueueItem(item)) {
        continue;
      }
      const key = `${item.kind || 'video'}:${item.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  private isQueueItem(item: YoutubeItem | null | undefined): boolean {
    if (!item?.id || item.kind === 'channel' || this.isLive(item)) {
      return false;
    }
    return item.kind === 'video' || item.kind === 'playlist' || !item.kind;
  }

  private queueIndexOf(item: YoutubeItem | null | undefined): number {
    if (!item?.id) {
      return -1;
    }
    const kind = item.kind || 'video';
    return this.queueItems().findIndex((it) => it.id === item.id && (it.kind || 'video') === kind);
  }

  private playQueueItem(item: YoutubeItem): void {
    this.ignoreQueueEndedUntil = Date.now() + 1500;
    this.selectItem(item);
  }

  private onQueueVideoEnded(): void {
    if (!this.playAllActive) {
      return;
    }
    if (Date.now() < this.ignoreQueueEndedUntil) {
      return;
    }
    const list = this.queueItems();
    if (!list.length) {
      this.stopPlayAll();
      return;
    }
    const idx = this.queueIndexOf(this.selected);
    const next = list[(idx < 0 ? 0 : idx + 1) % list.length];
    this.playQueueItem(next);
  }

  closePlayer(): void {
    const item = this.selected || this.youtubePlayer.currentItem;
    this.youtubePlayer.close();
    this.playerOpen = false;
    if (item) {
      this.selected = item;
      this.embedUrl = this.buildEmbedUrl(item, true);
    }
    setTimeout(() => this.syncLandscapeFullscreen(), 0);
  }

  exitLandscapeFullscreen(markDismissed = true): void {
    if (markDismissed && this.landscapeFullscreen) {
      this.landscapeFsUserDismissed = true;
    }
    if (
      !this.landscapeFullscreen &&
      !document.body.classList.contains(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS)
    ) {
      this.landscapeFsSuppressDismiss = true;
      this.exitOwnedNativeFullscreen();
      this.landscapeFsSuppressDismiss = false;
      return;
    }
    this.landscapeFullscreen = false;
    document.body.classList.remove(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    this.landscapeFsSuppressDismiss = true;
    this.exitOwnedNativeFullscreen();
    setTimeout(() => {
      this.landscapeFsSuppressDismiss = false;
    }, 0);
  }

  @HostListener('window:orientationchange')
  @HostListener('window:resize')
  onViewportOrientationMaybeChanged(): void {
    this.syncLandscapeFullscreen();
  }

  @HostListener('window:message', ['$event'])
  onWindowMessage(event: MessageEvent): void {
    this.onYoutubeProgressMessage(event);
  }

  loadMore(): void {
    if (!this.nextPageToken || this.loadingMore || this.searching) {
      return;
    }
    this.loadingMore = true;
    const token = this.nextPageToken;
    const req$ =
      this.resultKind === 'popular' && !this.query.trim() && !this.channelId
        ? this.api.getYoutubePopular({
            regionCode: this.regionCode,
            pageToken: token,
            maxResults: 12
          })
        : this.api.searchYoutube({
            q: this.query.trim() || undefined,
            type: this.type,
            regionCode: this.regionCode,
            relevanceLanguage: this.relevanceLang(),
            channelId: this.channelId || undefined,
            pageToken: token,
            maxResults: 12,
            order: this.youtubeApiOrder()
          });
    this.searchSub?.unsubscribe();
    this.searchSub = req$.subscribe({
      next: (page) => {
        this.loadingMore = false;
        this.applyPage(page, true);
      },
      error: () => {
        this.loadingMore = false;
        this.errorMessage = 'YOUTUBE.ERROR';
      }
    });
  }

  youtubeUrl(item: YoutubeItem | null): string | null {
    if (!item?.id) {
      return null;
    }
    if (item.kind === 'playlist') {
      return `https://www.youtube.com/playlist?list=${encodeURIComponent(item.id)}`;
    }
    if (item.kind === 'channel') {
      return `https://www.youtube.com/channel/${encodeURIComponent(item.id)}`;
    }
    return `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`;
  }

  shareOnWhatsApp(item: YoutubeItem | null, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const url = this.youtubeUrl(item);
    if (!item || !url) {
      return;
    }
    const title = (item.title || '').trim();
    const channel = (item.channelTitle || '').trim();
    const lines = [title || url];
    if (channel) {
      lines.push(channel);
    }
    lines.push('', url);
    openWhatsAppTextShare(lines.join('\n'));
  }

  durationLabel(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!match) {
      return '';
    }
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  viewsLabel(count: number | null | undefined): string {
    if (count == null || !Number.isFinite(count)) {
      return '';
    }
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)} M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)} k`;
    }
    return String(count);
  }

  publishedLabel(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleDateString(this.translate.currentLang || 'fr', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  isLive(item: YoutubeItem | null | undefined): boolean {
    return (item?.liveBroadcast || '').toLowerCase() === 'live';
  }

  thumbUrl(item: YoutubeItem | null | undefined): string | null {
    return this.api.youtubeThumbUrl(item);
  }

  private loadPopular(preferId?: string | null): void {
    this.searchSub?.unsubscribe();
    this.searching = true;
    this.errorMessage = '';
    this.missingKey = false;
    this.resultKind = 'popular';
    this.searchSub = this.api
      .getYoutubePopular({ regionCode: this.regionCode, maxResults: 12 })
      .subscribe({
        next: (page) => {
          this.searching = false;
          this.searched = true;
          this.applyPage(page, false, preferId);
        },
        error: () => {
          this.searching = false;
          this.searched = true;
          this.items = [];
          this.errorMessage = 'YOUTUBE.ERROR';
        }
      });
  }

  private runSearch(preferId?: string | null): void {
    const q = this.query.trim();
    if (!q && !this.channelId) {
      this.loadPopular(preferId);
      return;
    }
    this.searchSub?.unsubscribe();
    this.searching = true;
    this.searched = true;
    this.errorMessage = '';
    this.missingKey = false;
    this.resultKind = 'search';
    this.syncUrl(preferId);
    this.searchSub = this.api
      .searchYoutube({
        q: q || undefined,
        type: this.type,
        regionCode: this.regionCode,
        relevanceLanguage: this.relevanceLang(),
        channelId: this.channelId || undefined,
        maxResults: 12,
        order: this.youtubeApiOrder()
      })
      .subscribe({
        next: (page) => {
          this.searching = false;
          this.applyPage(page, false, preferId);
        },
        error: () => {
          this.searching = false;
          this.items = [];
          this.errorMessage = 'YOUTUBE.ERROR';
        }
      });
  }

  private applyPage(page: YoutubeSearchPage, append: boolean, preferId?: string | null): void {
    if (page?.error === 'missing_api_key' || page?.configured === false) {
      this.missingKey = true;
      this.errorMessage = 'YOUTUBE.ERROR_API_KEY';
      this.items = [];
      this.nextPageToken = null;
      this.total = 0;
      return;
    }
    if (page?.error === 'quota_exceeded') {
      this.errorMessage = 'YOUTUBE.ERROR_QUOTA';
    } else if (page?.error === 'invalid_key') {
      this.errorMessage = 'YOUTUBE.ERROR_INVALID_KEY';
    } else if (page?.error) {
      this.errorMessage = 'YOUTUBE.ERROR';
    } else {
      this.errorMessage = '';
    }
    this.missingKey = false;
    const incoming = (page?.items || []).map((item) => this.decodeYoutubeItem(item));
    if (!append) {
      this.itemSourceSeq = 0;
    }
    incoming.forEach((item) => {
      this.itemSourceOrder.set(item, this.itemSourceSeq++);
    });
    this.items = append ? [...this.items, ...incoming] : incoming;
    this.sortItems();
    this.nextPageToken = page?.nextPageToken || null;
    this.total = page?.total || this.items.length;
    this.resultKind = page?.kind || this.resultKind;
    if (!append) {
      const preferred = preferId ? this.items.find((it) => it.id === preferId) : null;
      if (preferred && (preferred.kind === 'video' || preferred.kind === 'playlist')) {
        this.selectItem(preferred);
      } else if (this.youtubePlayer.currentItem) {
        this.selected = this.decodeYoutubeItem(this.youtubePlayer.currentItem);
      }
      if (this.playAllActive) {
        const list = this.queueItems();
        if (!list.length) {
          this.stopPlayAll();
        } else if (this.queueIndexOf(this.selected) < 0) {
          this.playQueueItem(list[0]);
        }
      }
    }
  }

  private buildEmbedUrl(item: YoutubeItem, autoplay = false): SafeResourceUrl | null {
    const id = item.id || '';
    const extra = autoplay ? '&autoplay=1&playsinline=1' : '&playsinline=1';
    const origin =
      typeof window !== 'undefined'
        ? `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
        : '';
    const gen = `&cb=${++this.embedGeneration}`;
    if (item.kind === 'playlist' && /^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0${extra}${origin}${gen}`
      );
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/${id}?rel=0${extra}${origin}${gen}`
      );
    }
    return null;
  }

  private readTickerPreference(): boolean {
    try {
      const raw = localStorage.getItem(YoutubeWatcherComponent.TICKER_STORAGE_KEY);
      if (raw == null) {
        return true;
      }
      return raw !== '0' && raw !== 'false';
    } catch {
      return true;
    }
  }

  private writeTickerPreference(enabled: boolean): void {
    try {
      localStorage.setItem(YoutubeWatcherComponent.TICKER_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      /* ignore quota / private mode */
    }
  }

  private scrollPageToTop(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (active && this.host.nativeElement.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
    const jump = (): void => {
      window.scrollTo(0, 0);
      const se = document.scrollingElement as HTMLElement | null;
      if (se) {
        se.scrollTop = 0;
        se.scrollLeft = 0;
      }
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      let node: HTMLElement | null = this.host.nativeElement;
      while (node && node !== document.documentElement) {
        if (node.scrollTop) {
          node.scrollTop = 0;
        }
        node = node.parentElement;
      }
    };
    jump();
    if (this.scrollTopTimer !== undefined) {
      clearTimeout(this.scrollTopTimer);
    }
    this.scrollTopTimer = setTimeout(() => {
      jump();
      requestAnimationFrame(() => {
        jump();
        this.scrollTopTimer = setTimeout(jump, 80);
      });
    }, 0);
  }

  private setupLandscapeFullscreenWatchers(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    this.landscapeOrientationMql = window.matchMedia('(orientation: landscape)');
    if (typeof this.landscapeOrientationMql.addEventListener === 'function') {
      this.landscapeOrientationMql.addEventListener('change', this.onLandscapeOrientationMedia);
    } else {
      (
        this.landscapeOrientationMql as MediaQueryList & {
          addListener?: (cb: () => void) => void;
        }
      ).addListener?.(this.onLandscapeOrientationMedia);
    }
    document.addEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.addEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
  }

  private teardownLandscapeFullscreenWatchers(): void {
    if (this.landscapeOrientationMql) {
      if (typeof this.landscapeOrientationMql.removeEventListener === 'function') {
        this.landscapeOrientationMql.removeEventListener('change', this.onLandscapeOrientationMedia);
      } else {
        (
          this.landscapeOrientationMql as MediaQueryList & {
            removeListener?: (cb: () => void) => void;
          }
        ).removeListener?.(this.onLandscapeOrientationMedia);
      }
      this.landscapeOrientationMql = null;
    }
    document.removeEventListener('fullscreenchange', this.onLandscapeFsChange);
    document.removeEventListener('webkitfullscreenchange', this.onLandscapeFsChange);
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

  private canEnterLandscapeFullscreen(): boolean {
    return (
      this.isMobileLikeViewport() &&
      this.isLandscapeOrientation() &&
      !!this.selected &&
      !!this.embedUrl &&
      !this.playerOpen &&
      !this.landscapeFsUserDismissed
    );
  }

  private syncLandscapeFullscreen(): void {
    if (!this.isLandscapeOrientation()) {
      this.landscapeFsUserDismissed = false;
      this.exitLandscapeFullscreen(false);
      return;
    }
    if (this.canEnterLandscapeFullscreen()) {
      this.enterLandscapeFullscreen();
      return;
    }
    if (this.landscapeFullscreen && (!this.selected || !this.embedUrl || this.playerOpen)) {
      this.exitLandscapeFullscreen(false);
    }
  }

  private enterLandscapeFullscreen(): void {
    if (!this.landscapeFullscreen) {
      this.landscapeFullscreen = true;
      document.body.classList.add(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    } else {
      document.body.classList.add(YoutubeWatcherComponent.LANDSCAPE_FS_BODY_CLASS);
    }
    void this.requestLandscapeNativeFullscreen();
  }

  private async requestLandscapeNativeFullscreen(): Promise<void> {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      return;
    }
    const wrap = this.playerFrame?.nativeElement || null;
    if (!wrap) {
      return;
    }
    this.landscapeFsNativeRequested = true;
    try {
      const req =
        wrap.requestFullscreen?.bind(wrap) ||
        (
          wrap as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void> | void;
          }
        ).webkitRequestFullscreen?.bind(wrap);
      if (req) {
        await Promise.resolve(req());
      }
    } catch {
      // CSS immersive mode remains active.
    }
  }

  private exitOwnedNativeFullscreen(): void {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement;
    if (!fsEl) {
      this.landscapeFsNativeRequested = false;
      return;
    }
    const wrap = this.playerFrame?.nativeElement || null;
    const owned = this.landscapeFsNativeRequested || (!!wrap && (fsEl === wrap || wrap.contains(fsEl)));
    if (!owned) {
      return;
    }
    try {
      if (document.exitFullscreen) {
        void document.exitFullscreen().catch(() => undefined);
      } else {
        doc.webkitExitFullscreen?.();
      }
    } catch {
      /* ignore */
    }
    this.landscapeFsNativeRequested = false;
  }

  private onLandscapeNativeFullscreenChange(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement || null;
    const wrap = this.playerFrame?.nativeElement || null;
    const ours = !!(fsEl && wrap && (fsEl === wrap || wrap.contains(fsEl)));
    if (ours) {
      this.landscapeFsNativeActive = true;
      return;
    }
    const hadNative = this.landscapeFsNativeActive || this.landscapeFsNativeRequested;
    this.landscapeFsNativeActive = false;
    this.landscapeFsNativeRequested = false;
    if (this.landscapeFsSuppressDismiss || !hadNative) {
      return;
    }
    if (this.isLandscapeOrientation() && this.landscapeFullscreen) {
      this.exitLandscapeFullscreen(true);
    }
  }

  private relevanceLang(): string {
    const lang = (this.translate.currentLang || 'fr').toLowerCase();
    if (lang.startsWith('jp')) {
      return 'ja';
    }
    if (lang.startsWith('cn')) {
      return 'zh';
    }
    if (lang.startsWith('in')) {
      return 'hi';
    }
    return lang.slice(0, 2);
  }

  private regionFromUiLang(lang: string | undefined): string {
    const code = (lang || 'fr').toLowerCase();
    const map: Record<string, string> = {
      fr: 'FR',
      en: 'US',
      de: 'DE',
      es: 'ES',
      it: 'IT',
      ru: 'RU',
      jp: 'JP',
      cn: 'CN',
      ar: 'SA',
      he: 'IL',
      el: 'GR',
      in: 'IN'
    };
    return map[code] || 'FR';
  }

  private normalizeRegion(code: string | null): string {
    const value = (code || 'FR').toUpperCase();
    return this.regions.some((r) => r.code === value) ? value : 'FR';
  }

  private normalizeType(type: string | null): YoutubeItemKind {
    if (type === 'playlist' || type === 'channel' || type === 'video') {
      return type;
    }
    return 'video';
  }

  private normalizeSort(value: string | null): YoutubeSortKey {
    if (
      value === 'date' ||
      value === 'views' ||
      value === 'duration' ||
      value === 'title' ||
      value === 'channel' ||
      value === 'relevance'
    ) {
      return value;
    }
    return 'relevance';
  }

  private defaultSortDir(key: YoutubeSortKey): YoutubeSortDir {
    return key === 'title' || key === 'channel' || key === 'relevance' ? 'asc' : 'desc';
  }

  private normalizeSortDir(value: string | null, key: YoutubeSortKey): YoutubeSortDir {
    if (value === 'asc' || value === 'desc') {
      return value;
    }
    return this.defaultSortDir(key);
  }

  private youtubeApiOrder(): string | undefined {
    switch (this.sortKey) {
      case 'date':
        return 'date';
      case 'views':
        return 'viewCount';
      case 'title':
        return 'title';
      default:
        return undefined;
    }
  }

  private sortItems(): void {
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const key = this.sortKey;
    this.items = [...this.items].sort((a, b) => {
      const cmp = this.compareItems(a, b, key);
      if (cmp !== 0) {
        return cmp * dir;
      }
      return (this.itemSourceOrder.get(a) || 0) - (this.itemSourceOrder.get(b) || 0);
    });
  }

  private compareItems(a: YoutubeItem, b: YoutubeItem, key: YoutubeSortKey): number {
    switch (key) {
      case 'date':
        return this.publishedTime(a) - this.publishedTime(b);
      case 'views':
        return (a.viewCount || 0) - (b.viewCount || 0);
      case 'duration':
        return this.durationSeconds(a.duration) - this.durationSeconds(b.duration);
      case 'title':
        return this.compareText(a.title, b.title);
      case 'channel':
        return this.compareText(a.channelTitle, b.channelTitle);
      default:
        return (this.itemSourceOrder.get(a) || 0) - (this.itemSourceOrder.get(b) || 0);
    }
  }

  private compareText(a: string | null | undefined, b: string | null | undefined): number {
    return (a || '').localeCompare(b || '', this.translate.currentLang || 'fr', {
      sensitivity: 'base',
      numeric: true
    });
  }

  private decodeYoutubeItem(item: YoutubeItem): YoutubeItem {
    return {
      ...item,
      title: this.decodeYoutubeHtml(item.title),
      description: this.decodeYoutubeHtml(item.description),
      channelTitle: this.decodeYoutubeHtml(item.channelTitle)
    };
  }

  /** YouTube sometimes returns titles with HTML entities (`&#39;`, `&amp;`, `&quot;`). */
  private decodeYoutubeHtml(value: string | null | undefined): string | undefined {
    if (value == null || value === '') {
      return value === '' ? '' : undefined;
    }
    if (!/&[#a-zA-Z0-9]+;/.test(value)) {
      return value;
    }
    let decoded = value;
    for (let i = 0; i < 2; i++) {
      const next =
        typeof DOMParser !== 'undefined'
          ? new DOMParser().parseFromString(decoded, 'text/html').documentElement.textContent || ''
          : decoded
              .replace(/&nbsp;/gi, ' ')
              .replace(/&amp;/gi, '&')
              .replace(/&quot;/gi, '"')
              .replace(/&apos;/gi, "'")
              .replace(/&#0*39;/g, "'")
              .replace(/&#x0*27;/gi, "'")
              .replace(/&lt;/gi, '<')
              .replace(/&gt;/gi, '>');
      if (next === decoded) {
        break;
      }
      decoded = next;
    }
    return decoded;
  }

  private publishedTime(item: YoutubeItem): number {
    const time = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    return Number.isFinite(time) ? time : 0;
  }

  private durationSeconds(iso: string | null | undefined): number {
    if (!iso) {
      return 0;
    }
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
    if (!match) {
      return 0;
    }
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }

  showPlaybackFooter(): boolean {
    return !!this.selected && (!!this.embedUrl || this.playbackDurationSec > 0 || this.isLive(this.selected));
  }

  playbackPercent(): number {
    if (this.playbackDurationSec <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (this.playbackCurrentSec / this.playbackDurationSec) * 100));
  }

  playbackRemainingSec(): number {
    return Math.max(0, this.playbackDurationSec - this.playbackCurrentSec);
  }

  playbackClock(totalSec: number): string {
    const sec = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
    }
    return `${minutes}:${ss}`;
  }

  playbackAriaLabel(): string {
    return this.translate.instant('YOUTUBE.PROGRESS_ARIA', {
      elapsed: this.playbackClock(this.playbackCurrentSec),
      duration: this.playbackClock(this.playbackDurationSec),
      remaining: this.playbackClock(this.playbackRemainingSec())
    });
  }

  onYoutubeEmbedLoad(): void {
    this.startYoutubeProgressWatch();
  }

  onPlaybackSeek(event: MouseEvent): void {
    if (this.playbackDurationSec <= 0) {
      return;
    }
    const track = event.currentTarget as HTMLElement | null;
    if (!track) {
      return;
    }
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const time = ratio * this.playbackDurationSec;
    this.playbackCurrentSec = time;
    this.sendYoutubeCommand('seekTo', [time, true]);
  }

  private resetPlaybackClock(item: YoutubeItem | null): void {
    this.playbackCurrentSec = 0;
    this.playbackDurationSec = this.durationSeconds(item?.duration);
  }

  private startYoutubeProgressWatch(): void {
    this.stopYoutubeProgressWatch();
    if (this.playerOpen || !this.embedUrl) {
      return;
    }
    this.handshakeYoutubePlayer();
    this.ytProgressTimer = setInterval(() => {
      this.handshakeYoutubePlayer();
      this.sendYoutubeCommand('getCurrentTime');
      this.sendYoutubeCommand('getDuration');
    }, 400);
  }

  private stopYoutubeProgressWatch(): void {
    if (this.ytProgressTimer !== undefined) {
      clearInterval(this.ytProgressTimer);
      this.ytProgressTimer = undefined;
    }
  }

  private handshakeYoutubePlayer(): void {
    this.postToYoutube({ event: 'listening', id: 'yt-page-embed' });
    this.sendYoutubeCommand('addEventListener', ['onStateChange']);
  }

  private getYoutubeIframe(): HTMLIFrameElement | null {
    const wrap = this.playerFrame?.nativeElement;
    const fromWrap = wrap?.querySelector('iframe.yt-page-embed') as HTMLIFrameElement | null;
    if (fromWrap) {
      return fromWrap;
    }
    if (typeof document === 'undefined') {
      return null;
    }
    return document.querySelector('iframe.yt-page-embed');
  }

  private postToYoutube(payload: object): void {
    const iframe = this.getYoutubeIframe();
    if (!iframe?.contentWindow) {
      return;
    }
    try {
      iframe.contentWindow.postMessage(JSON.stringify(payload), '*');
    } catch {
      /* ignore */
    }
  }

  private sendYoutubeCommand(func: string, args: unknown[] = []): void {
    this.postToYoutube({ event: 'command', func, args, id: 'yt-page-embed' });
  }

  private onYoutubeProgressMessage(event: MessageEvent): void {
    if (this.playerOpen || !this.embedUrl) {
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
    const payload = data as {
      event?: string;
      info?: number | Record<string, unknown>;
    };
    if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
      this.applyYoutubePlayerState(payload.info);
      return;
    }
    const info = payload.info;
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      return;
    }
    const playerState = info['playerState'];
    if (typeof playerState === 'number') {
      this.applyYoutubePlayerState(playerState);
      if (playerState === 0) {
        return;
      }
    }
    const currentTime = info['currentTime'];
    const duration = info['duration'];
    if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
      this.playbackCurrentSec = Math.max(0, currentTime);
    }
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      this.playbackDurationSec = duration;
    }
  }

  private applyYoutubePlayerState(state: number): void {
    if (state === 1 || state === 3) {
      this.playbackPaused = false;
    } else if (state === 2) {
      this.playbackPaused = true;
    }
    if (state !== 0) {
      return;
    }
    this.playbackPaused = true;
    if (this.playbackDurationSec > 0) {
      this.playbackCurrentSec = this.playbackDurationSec;
    }
    this.onQueueVideoEnded();
  }

  canLinkVideo(item: YoutubeItem | null | undefined): boolean {
    return item?.kind === 'video' && isYoutubeVideoId(item.id);
  }

  openInVideoshow(): void {
    const item = this.selected;
    if (!this.canLinkVideo(item) || !this.videoshowModalComponent) {
      return;
    }
    this.exitLandscapeFullscreen(false);
    this.videoshowRestorePip = this.playerOpen;
    this.stopPlayAll();
    this.embedUrl = null;
    this.stopYoutubeProgressWatch();
    if (this.playerOpen) {
      this.youtubePlayer.close();
    }
    const sources: VideoshowVideoSource[] = [];
    const seen = new Set<string>();
    for (const it of this.items) {
      const id = (it.id || '').trim();
      if (it.kind !== 'video' || !isYoutubeVideoId(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      sources.push({ youtubeVideoId: id, fileName: it.title });
    }
    const selectedId = (item!.id || '').trim();
    let startIndex = sources.findIndex((source) => source.youtubeVideoId === selectedId);
    if (startIndex < 0) {
      sources.unshift({ youtubeVideoId: selectedId, fileName: item!.title });
      startIndex = 0;
    }
    this.videoshowModalComponent.open(sources, item!.title || '', false, 0, startIndex);
  }

  onVideoshowClosed(): void {
    const item = this.selected;
    const restorePip = this.videoshowRestorePip;
    this.videoshowRestorePip = false;
    if (!item) {
      return;
    }
    if (restorePip) {
      this.youtubePlayer.open(item);
      return;
    }
    this.embedUrl = this.buildEmbedUrl(item, true);
    setTimeout(() => this.syncLandscapeFullscreen(), 0);
  }

  openLinkToEventModal(): void {
    if (!this.canLinkVideo(this.selected) || !this.linkToEventModal) {
      return;
    }
    this.linkTarget = this.selected;
    this.linkEventsList = [];
    this.linkEventsFilter = '';
    this.linkEventsTypeFilter = '';
    this.linkEventsLoading = true;
    this.linkEventsError = false;
    this.linkSavingEventId = null;
    this.linkFeedbackKey = null;
    this.linkFeedbackParams = {};
    this.linkFeedbackKind = null;
    if (this.linkFeedbackTimer !== undefined) {
      clearTimeout(this.linkFeedbackTimer);
      this.linkFeedbackTimer = undefined;
    }
    this.linkModalRef = this.modalService.open(this.linkToEventModal, {
      size: 'lg',
      centered: true,
      windowClass: 'yt-link-event-modal',
      backdropClass: 'yt-link-event-modal-backdrop',
      modalDialogClass: 'yt-link-event-modal-dialog'
    });
    this.linkModalRef.dismissed.subscribe(() => this.onLinkModalClosed());
    this.linkModalRef.closed.subscribe(() => this.onLinkModalClosed());
    this.streamEventsForLink();
  }

  cancelLinkToEventModal(): void {
    this.linkModalRef?.dismiss();
  }

  private closeLinkToEventModal(): void {
    try {
      this.linkModalRef?.dismiss();
    } catch {
      /* already closed */
    }
    this.onLinkModalClosed();
  }

  private onLinkModalClosed(): void {
    this.linkEventsStreamSub?.unsubscribe();
    this.linkEventsStreamSub = undefined;
    this.linkModalRef = null;
    this.linkSavingEventId = null;
    this.linkTarget = null;
  }

  filteredLinkEvents(): Evenement[] {
    const term = (this.linkEventsFilter ?? '').trim().toLowerCase();
    const typeFilter = (this.linkEventsTypeFilter ?? '').trim();
    const list = this.linkEventsList;
    let out = !term
      ? list
      : list.filter((e) => (e.evenementName ?? '').toLowerCase().includes(term));
    if (typeFilter) {
      out = out.filter((e) => (e.type ?? '') === typeFilter);
    }
    return [...out].sort((a, b) => {
      const dA = a?.beginEventDate ? new Date(a.beginEventDate).getTime() : 0;
      const dB = b?.beginEventDate ? new Date(b.beginEventDate).getTime() : 0;
      return dB - dA;
    });
  }

  linkEventTypeLabelKey(typeId: string | undefined | null): string {
    const id = (typeId ?? '').trim();
    if (!id) {
      return '';
    }
    const found = this.linkEventTypeOptions.find((o) => o.value === id);
    return found ? found.labelKey : id;
  }

  linkEventDateLabel(ev: Evenement): string {
    const d = ev?.beginEventDate ? new Date(ev.beginEventDate) : null;
    if (!d || Number.isNaN(d.getTime())) {
      return '';
    }
    try {
      return d.toLocaleDateString(this.translate.currentLang || 'fr', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  canSubmitLinkForEvent(ev: Evenement): boolean {
    return !!ev?.id && this.linkSavingEventId == null && this.canLinkVideo(this.linkTarget);
  }

  onSelectEventForLink(ev: Evenement): void {
    const item = this.linkTarget;
    const eventId = ev?.id?.trim();
    if (!eventId || !this.canLinkVideo(item) || this.linkSavingEventId) {
      return;
    }
    const videoId = (item!.id || '').trim();
    if (this.eventAlreadyHasYoutube(ev, videoId)) {
      this.linkFeedbackKey = 'YOUTUBE.LINK_ALREADY';
      this.linkFeedbackParams = { name: ev.evenementName };
      this.linkFeedbackKind = 'error';
      return;
    }
    const user = this.membersService.getUser();
    const description = (item!.title || '').trim().slice(0, 200);
    const urlEvent = new UrlEvent(
      'YOUTUBE',
      new Date(),
      user?.userName || '',
      youtubeWatchUrl(videoId),
      description
    );
    this.linkSavingEventId = eventId;
    this.linkFeedbackKey = null;
    this.linkSaveSub?.unsubscribe();
    this.linkSaveSub = this.evenementsService.addUrlEvent(eventId, urlEvent).subscribe({
      next: (updated) => {
        this.ngZone.run(() => {
          this.linkSavingEventId = null;
          if (updated) {
            const idx = this.linkEventsList.findIndex((e) => e.id === eventId);
            if (idx >= 0) {
              this.linkEventsList = [
                ...this.linkEventsList.slice(0, idx),
                updated,
                ...this.linkEventsList.slice(idx + 1)
              ];
            }
          }
          this.linkFeedbackKey = 'YOUTUBE.LINK_SUCCESS';
          this.linkFeedbackParams = { name: ev.evenementName };
          this.linkFeedbackKind = 'success';
          if (this.linkFeedbackTimer !== undefined) {
            clearTimeout(this.linkFeedbackTimer);
          }
          this.linkFeedbackTimer = setTimeout(() => {
            this.linkModalRef?.close();
          }, YoutubeWatcherComponent.LINK_FEEDBACK_AUTO_CLOSE_MS);
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.linkSavingEventId = null;
          this.linkFeedbackKey = 'YOUTUBE.LINK_ERROR';
          this.linkFeedbackParams = { name: ev.evenementName };
          this.linkFeedbackKind = 'error';
        });
      }
    });
  }

  private eventAlreadyHasYoutube(ev: Evenement, videoId: string): boolean {
    return (ev.urlEvents || []).some((u) => parseYoutubeVideoId(u?.link) === videoId);
  }

  private streamEventsForLink(): void {
    this.linkEventsStreamSub?.unsubscribe();
    const userId = this.membersService.getUser()?.id ?? '';
    this.linkEventsStreamSub = this.evenementsService.streamEvents('*', userId).subscribe({
      next: (s: StreamedEvent) => {
        this.ngZone.run(() => {
          if (s.type === 'event' && s.data && typeof s.data === 'object' && 'id' in s.data) {
            const incoming = s.data as Evenement;
            const existsIdx = this.linkEventsList.findIndex((e) => e.id === incoming.id);
            if (existsIdx === -1) {
              this.linkEventsList = [...this.linkEventsList, incoming];
            }
          } else if (s.type === 'complete') {
            this.linkEventsLoading = false;
          }
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.linkEventsLoading = false;
          this.linkEventsError = true;
        });
      },
      complete: () => {
        this.ngZone.run(() => {
          this.linkEventsLoading = false;
        });
      }
    });
  }

  private syncUrl(preferId?: string | null): Promise<boolean> {
    const queryParams: Record<string, string | null> = {
      q: this.query.trim() || null,
      type: this.type !== 'video' ? this.type : null,
      region: this.regionCode !== this.regionFromUiLang(this.translate.currentLang) ? this.regionCode : null,
      channel: this.channelId || null,
      sort: this.sortKey !== 'relevance' ? this.sortKey : null,
      dir: this.sortDir !== this.defaultSortDir(this.sortKey) ? this.sortDir : null,
      id: preferId || this.selected?.id || null
    };
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: '',
      replaceUrl: true
    });
  }
}
