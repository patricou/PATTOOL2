import {
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  YoutubeItem,
  YoutubeItemKind,
  YoutubeSearchPage
} from '../services/api.service';
import { YoutubePlayerService } from '../services/youtube-player.service';

interface YoutubeRegionOption {
  code: string;
  label: string;
}

type YoutubeSortKey = 'relevance' | 'date' | 'views' | 'duration' | 'title' | 'channel';
type YoutubeSortDir = 'asc' | 'desc';

@Component({
  selector: 'app-youtube-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
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

  constructor(
    private api: ApiService,
    private youtubePlayer: YoutubePlayerService,
    private translate: TranslateService,
    private sanitizer: DomSanitizer,
    private route: ActivatedRoute,
    private router: Router
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
        if (s.item) {
          this.selected = s.item;
        }
        this.syncLandscapeFullscreen();
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
    this.syncUrl();
    this.loadPopular();
  }

  selectItem(item: YoutubeItem): void {
    if (!item?.id) {
      return;
    }
    if (item.kind === 'channel' && item.id) {
      this.channelId = item.id;
      this.query = '';
      this.type = 'video';
      this.runSearch();
      return;
    }
    this.selected = item;
    if (this.playerOpen) {
      this.embedUrl = null;
      this.youtubePlayer.open(item);
    } else {
      this.embedUrl = this.buildEmbedUrl(item, true);
    }
    this.syncUrl();
    this.scrollPageToTop();
    setTimeout(() => this.syncLandscapeFullscreen(), 0);
  }

  openInFloatingWindow(): void {
    if (!this.selected) {
      return;
    }
    this.exitLandscapeFullscreen(false);
    this.embedUrl = null;
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
    const incoming = page?.items || [];
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
        this.selected = this.youtubePlayer.currentItem;
      }
    }
  }

  private buildEmbedUrl(item: YoutubeItem, autoplay = false): SafeResourceUrl | null {
    const id = item.id || '';
    const extra = autoplay ? '&autoplay=1&playsinline=1' : '&playsinline=1';
    if (item.kind === 'playlist' && /^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0${extra}`
      );
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/${id}?rel=0${extra}`
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
    if (typeof window === 'undefined') {
      return;
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    window.scrollTo({ top: 0, left: 0, behavior: reduce ? 'auto' : 'smooth' });
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

  private syncUrl(preferId?: string | null): void {
    const queryParams: Record<string, string | null> = {
      q: this.query.trim() || null,
      type: this.type !== 'video' ? this.type : null,
      region: this.regionCode !== this.regionFromUiLang(this.translate.currentLang) ? this.regionCode : null,
      channel: this.channelId || null,
      sort: this.sortKey !== 'relevance' ? this.sortKey : null,
      dir: this.sortDir !== this.defaultSortDir(this.sortKey) ? this.sortDir : null,
      id: preferId || this.selected?.id || null
    };
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: '',
      replaceUrl: true
    });
  }
}
