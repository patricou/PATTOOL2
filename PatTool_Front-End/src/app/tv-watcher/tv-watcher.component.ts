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
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription, forkJoin, of } from 'rxjs';
import { debounceTime, distinctUntilChanged, catchError } from 'rxjs/operators';
import Hls from 'hls.js';

import { ApiService, TvChannel, TvCountry, TvEpgNow, TvEpgProgramme, TvEpgSearchHit } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { TvPlayerService } from '../services/tv-player.service';
import {
  isCanalGroupVirtual,
  isFranceTvVirtual,
  isM6GroupVirtual,
  isRadioFranceVirtual,
  isTf1Virtual,
  resolveTvStreamUrl
} from './tv-stream.util';
import {
  isTvI18nErrorKey,
  resolveTvStreamErrorMessage
} from './tv-stream-error.util';
import { groupIconEmoji, groupIconFaClass, groupI18nKey } from './tv-group-icon.util';
import { epgLookupKey, resolveEpgChannelId } from './tv-epg.util';
import {
  attachTvHlsLiveSyncWatchdog,
  createTvHlsConfig,
  resyncTvHlsAv,
  tryRecoverTvHlsError
} from './tv-hls-config';

type TvListMode = 'catalog' | 'favorites';

@Component({
  selector: 'app-tv-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './tv-watcher.component.html',
  styleUrls: ['./tv-watcher.component.css']
})
export class TvWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

  countries: TvCountry[] = [];
  channels: TvChannel[] = [];
  groups: string[] = [];
  favorites: TvChannel[] = [];
  favoriteIds = new Set<string>();

  listMode: TvListMode = 'favorites';
  selectedCountry = 'fr';
  selectedGroup = '';
  /** Filter by channel name / group / country. */
  channelQuery = '';
  /** Filter by EPG programme title (server-side search). */
  programQuery = '';
  selectedChannel: TvChannel | null = null;
  /** Hint when « all countries » is selected but the query is too short. */
  worldwideSearchHint = false;
  countryMenuOpen = false;
  countryFilter = '';
  /** Collapse state of the filters panel, remembered per tab. */
  private filtersCollapsedByMode: Record<TvListMode, boolean> = {
    catalog: true,
    favorites: true
  };

  isLoadingCountries = false;
  isLoadingChannels = false;
  isLoadingFavorites = false;
  favoriteBusyId = '';
  playError = '';
  channelsError = '';
  countriesError = '';
  favoritesError = '';
  favoritesHint = '';
  isMuted = false;
  /** 0–100, mirrored to HTMLVideoElement.volume */
  volumePercent = 100;
  isBuffering = false;
  tf1Configured: boolean | null = null;
  isPipActive = false;
  pipSupported = TvPlayerService.supportsVideoPictureInPicture();
  /** Channel bar + native controls: auto-hide after idle, show on hover. */
  chromeVisible = true;
  /** Share menu (WhatsApp / copy / native). */
  shareMenuOpen = false;
  shareFeedback = '';
  /** Brief status after manual A/V resync. */
  resyncFeedback = '';
  /** When true, leaving the page keeps playback in the floating player. */
  keepAliveOnNavigate = true;
  readonly canNativeShare =
    typeof navigator !== 'undefined' && typeof (navigator as Navigator).share === 'function';

  /** Total catalog size for the current country (or worldwide when country=all). */
  catalogTotalCount = 0;
  isLoadingCatalogCount = false;

  /** EPG now/next keyed by lowercase XMLTV id. */
  epgById: Record<string, TvEpgNow> = {};
  isLoadingEpg = false;

  /** Server-side programme search results. */
  programSearchHits: TvEpgSearchHit[] = [];
  private programSearchEpgIds = new Set<string>();
  isLoadingProgramSearch = false;

  /** Full EPG schedule panel for the selected channel. */
  guideOpen = false;
  guideProgrammes: TvEpgProgramme[] = [];
  isLoadingGuide = false;
  guideError = '';

  private catalogCountSub?: Subscription;
  private hls: Hls | null = null;
  private detachHlsLiveSync: (() => void) | null = null;
  private channelSearch$ = new Subject<string>();
  private programSearch$ = new Subject<string>();
  private channelSearchSub?: Subscription;
  private programSearchSub?: Subscription;
  private channelsSub?: Subscription;
  private resumeSub?: Subscription;
  private lastChannelSaveSub?: Subscription;
  private epgSub?: Subscription;
  private programSearchHttpSub?: Subscription;
  private guideSub?: Subscription;
  private epgRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private restoredLastChannel = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private shareFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deep-link channel id waiting for catalog load. */
  private pendingShareChannelId = '';
  private playGeneration = 0;
  private static readonly CHROME_HIDE_MS = 3000;
  private static readonly LAST_CHANNEL_STORAGE_KEY = 'pattool.tv.last-channel';
  private static readonly KEEP_ALIVE_STORAGE_KEY = 'pattool.tv.keep-alive';
  /** Max length for virtual stream tokens in share links (not full http URLs). */
  private static readonly SHARE_STREAM_MAX_LEN = 80;
  private static readonly EPG_REFRESH_MS = 5 * 60 * 1000;

  constructor(
    private api: ApiService,
    private keycloak: KeycloakService,
    private tvPlayer: TvPlayerService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private translate: TranslateService
  ) {}

  get isAllCountries(): boolean {
    return (this.selectedCountry || '').toLowerCase() === 'all';
  }

  get filtersCollapsed(): boolean {
    return !!this.filtersCollapsedByMode[this.listMode];
  }

  /** True when search/group inputs are non-empty (for collapsed indicator). */
  get hasFilterInputs(): boolean {
    if (this.channelQuery.trim() || this.programQuery.trim()) {
      return true;
    }
    if (this.listMode === 'catalog' && this.selectedGroup) {
      return true;
    }
    return false;
  }

  get filteredCountries(): TvCountry[] {
    const q = this.countryFilter.trim().toLowerCase();
    if (!q) {
      return this.countries;
    }
    return this.countries.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const code = (c.code || '').toLowerCase();
      return name.includes(q) || code.includes(q);
    });
  }

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get isFloatingOpen(): boolean {
    return this.tvPlayer.isOpen;
  }

  get displayedChannels(): TvChannel[] {
    const source = this.listMode === 'favorites' ? this.favorites : this.channels;
    const channelQ = this.channelQuery.trim().toLowerCase();
    const programQ = this.programQuery.trim().toLowerCase();
    if (!channelQ && !programQ) {
      return source;
    }
    return source.filter((ch) => {
      if (channelQ && !this.matchesChannelQuery(ch, channelQ)) {
        return false;
      }
      if (programQ && !this.matchesProgramQuery(ch, programQ)) {
        return false;
      }
      return true;
    });
  }

  /** Number of channels matching the current list mode + filters. */
  get filteredChannelCount(): number {
    return this.displayedChannels.length;
  }

  /**
   * Count shown on the « Toutes les TV » tab.
   * Worldwide with no search: full catalog total (not 0).
   * Otherwise: filtered list size.
   */
  get catalogTabCount(): number {
    if (this.listMode === 'favorites') {
      return this.filteredChannelCount;
    }
    if (this.isAllCountries) {
      const searching =
        this.channelQuery.trim().length >= 2
        || this.programQuery.trim().length >= 2
        || !!this.selectedGroup;
      if (!searching && this.catalogTotalCount > 0) {
        return this.catalogTotalCount;
      }
    }
    return this.filteredChannelCount;
  }

  /** True when country/group/search filters narrow the catalog list. */
  get hasActiveFilters(): boolean {
    if (this.listMode !== 'catalog') {
      return !!(this.channelQuery.trim() || this.programQuery.trim());
    }
    return !!(
      this.channelQuery.trim()
      || this.programQuery.trim()
      || this.selectedGroup
      || this.isAllCountries
    );
  }

  /** Match channel name / group / country. */
  matchesChannelQuery(channel: TvChannel, queryLower: string): boolean {
    const q = (queryLower || '').trim().toLowerCase();
    if (!q || !channel) {
      return true;
    }
    if ((channel.name || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((channel.group || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((channel.country || '').toLowerCase().includes(q)) {
      return true;
    }
    return false;
  }

  /** Match EPG programme via server search hits (full guide window). */
  matchesProgramQuery(channel: TvChannel, queryLower: string): boolean {
    const q = (queryLower || '').trim().toLowerCase();
    if (!q || !channel) {
      return true;
    }
    if (q.length < 2) {
      return true;
    }
    const epgId = resolveEpgChannelId(channel);
    if (epgId && this.programSearchEpgIds.has(epgLookupKey(epgId))) {
      return true;
    }
    // Fallback while search loads / for favorites without a hit yet.
    const epg = this.epgFor(channel);
    if ((epg?.now?.title || '').toLowerCase().includes(q)) {
      return true;
    }
    if ((epg?.next?.title || '').toLowerCase().includes(q)) {
      return true;
    }
    return false;
  }

  ngOnInit(): void {
    this.keepAliveOnNavigate = this.readKeepAlivePreference();
    this.channelSearchSub = this.channelSearch$
      .pipe(debounceTime(280), distinctUntilChanged())
      .subscribe(() => {
        if (this.listMode === 'catalog' && this.isAllCountries) {
          this.loadChannels();
        } else {
          this.cdr.markForCheck();
        }
      });
    this.programSearchSub = this.programSearch$
      .pipe(debounceTime(320), distinctUntilChanged())
      .subscribe((q) => {
        this.runProgramSearch(q);
      });

    this.resumeSub = this.tvPlayer.resumeOnPage$.subscribe((channel) => {
      this.resumePagePlayback(channel);
    });
    const pending = this.tvPlayer.consumePendingResume();
    if (this.tvPlayer.isOsPipActive()) {
      // Back on the TV page while OS PiP still runs — keep one stream only.
      this.tvPlayer.detachPipHostOnly();
      this.selectedChannel =
        this.tvPlayer.osPipChannel || this.tvPlayer.snapshot.channel || this.selectedChannel;
      this.isPipActive = true;
      this.restoredLastChannel = true;
    } else if (pending) {
      this.restoredLastChannel = true;
      this.resumePagePlayback(pending);
    } else if (this.tvPlayer.isOpen && this.tvPlayer.snapshot.channel) {
      this.selectedChannel = this.tvPlayer.snapshot.channel;
      this.restoredLastChannel = true;
    }

    this.loadCountries();
    this.loadCatalogCount();
    this.loadChannels();
    this.loadFavorites();
    this.loadTf1Status();
    this.epgRefreshTimer = setInterval(() => this.refreshEpg(), TvWatcherComponent.EPG_REFRESH_MS);
    if (!this.tryOpenSharedChannelFromQuery()) {
      this.restoreLastWatchedChannel();
    }
  }

  ngOnDestroy(): void {
    this.clearChromeHideTimer();
    this.clearShareFeedbackTimer();
    this.clearResyncFeedbackTimer();
    if (this.epgRefreshTimer != null) {
      clearInterval(this.epgRefreshTimer);
      this.epgRefreshTimer = null;
    }
    this.epgSub?.unsubscribe();
    this.programSearchHttpSub?.unsubscribe();
    this.guideSub?.unsubscribe();
    this.channelSearchSub?.unsubscribe();
    this.programSearchSub?.unsubscribe();
    this.channelsSub?.unsubscribe();
    this.catalogCountSub?.unsubscribe();
    this.resumeSub?.unsubscribe();
    this.lastChannelSaveSub?.unsubscribe();
    this.applyLeavePagePlaybackPolicy();
    this.destroyPlayer();
  }

  /**
   * Keep-alive ON + OS PiP active: hand the stream to a hidden shell host so PiP survives navigation.
   * Keep-alive OFF: stop page + floating playback (PiP ends with the page video).
   * Keep-alive ON without PiP: do not open the floating window — playback simply stops.
   */
  private applyLeavePagePlaybackPolicy(): void {
    if (!this.keepAliveOnNavigate) {
      if (this.tvPlayer.isOpen) {
        this.tvPlayer.close({ resumeOnPage: false });
      }
      this.tvPlayer.stopOsPip();
      this.exitPictureInPictureIfOwned();
      return;
    }
    if (this.tvPlayer.isPopoutActive || this.tvPlayer.isOpen) {
      // External pop-out or an already-open float already owns playback.
      return;
    }
    const ch = this.selectedChannel || this.tvPlayer.osPipChannel;
    const pipOwned = this.tvPlayer.isOsPipActive();
    if (!ch || this.playError || !pipOwned) {
      return;
    }
    this.persistLastWatchedChannel(ch);
    // Carrier already holds the stream + OS PiP; only register an invisible host.
    this.tvPlayer.openFloating(ch, { pipHostOnly: true });
  }

  private exitPictureInPictureIfOwned(): void {
    const video = this.videoEl?.nativeElement;
    if (video && document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => undefined);
    }
  }

  setKeepAliveOnNavigate(enabled: boolean): void {
    this.keepAliveOnNavigate = !!enabled;
    this.writeKeepAlivePreference(this.keepAliveOnNavigate);
    this.cdr.markForCheck();
  }

  private readKeepAlivePreference(): boolean {
    try {
      const raw = localStorage.getItem(TvWatcherComponent.KEEP_ALIVE_STORAGE_KEY);
      if (raw === null) {
        return true;
      }
      return raw === '1' || raw === 'true';
    } catch {
      return true;
    }
  }

  private writeKeepAlivePreference(enabled: boolean): void {
    try {
      localStorage.setItem(TvWatcherComponent.KEEP_ALIVE_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      /* private mode / quota */
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    let changed = false;
    if (this.shareMenuOpen && !target?.closest?.('.tv-share-wrap')) {
      this.shareMenuOpen = false;
      changed = true;
    }
    if (this.countryMenuOpen && !target?.closest?.('.tv-country-picker')) {
      this.countryMenuOpen = false;
      changed = true;
    }
    if (changed) {
      this.cdr.markForCheck();
    }
  }

  onTvPointerEnter(): void {
    this.showChrome(true);
  }

  onTvPointerMove(): void {
    if (!this.chromeVisible) {
      this.showChrome(true);
    } else {
      this.scheduleChromeHide();
    }
  }

  onTvPointerLeave(): void {
    this.scheduleChromeHide(800);
  }

  private showChrome(scheduleHide: boolean): void {
    this.chromeVisible = true;
    this.cdr.markForCheck();
    if (scheduleHide) {
      this.scheduleChromeHide();
    } else {
      this.clearChromeHideTimer();
    }
  }

  private scheduleChromeHide(delayMs = TvWatcherComponent.CHROME_HIDE_MS): void {
    this.clearChromeHideTimer();
    if (!this.selectedChannel || this.isMuted || this.shareMenuOpen || this.guideOpen) {
      return;
    }
    this.chromeHideTimer = setTimeout(() => {
      if (this.shareMenuOpen || this.guideOpen) {
        this.chromeHideTimer = null;
        return;
      }
      this.chromeVisible = false;
      this.chromeHideTimer = null;
      this.cdr.markForCheck();
    }, delayMs);
  }

  private clearChromeHideTimer(): void {
    if (this.chromeHideTimer != null) {
      clearTimeout(this.chromeHideTimer);
      this.chromeHideTimer = null;
    }
  }

  setListMode(mode: TvListMode): void {
    this.listMode = mode;
    this.channelsError = '';
    this.favoritesHint = '';
    this.countryMenuOpen = false;
    if (mode === 'favorites' && !this.isLoggedIn) {
      this.favoritesHint = 'TV.FAVORITES_LOGIN';
    }
    this.refreshEpg();
    if (this.programQuery.trim().length >= 2) {
      this.runProgramSearch(this.programQuery.trim().toLowerCase());
    }
    this.cdr.markForCheck();
  }

  toggleFiltersCollapsed(event?: Event): void {
    event?.stopPropagation();
    this.filtersCollapsedByMode[this.listMode] = !this.filtersCollapsedByMode[this.listMode];
    if (this.filtersCollapsed) {
      this.countryMenuOpen = false;
    }
    this.cdr.markForCheck();
  }

  onCountryChange(): void {
    this.selectedGroup = '';
    this.worldwideSearchHint = false;
    this.countryMenuOpen = false;
    this.loadCatalogCount();
    this.loadChannels();
    if (this.programQuery.trim().length >= 2) {
      this.runProgramSearch(this.programQuery.trim().toLowerCase());
    }
  }

  toggleCountryMenu(event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.countryMenuOpen = !this.countryMenuOpen;
    this.shareMenuOpen = false;
    if (this.countryMenuOpen) {
      this.countryFilter = '';
    }
    this.cdr.markForCheck();
  }

  selectCountry(code: string, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.selectedCountry = code || 'fr';
    this.countryFilter = '';
    this.onCountryChange();
  }

  /** ISO code for flag-icons CSS ({@code fi fi-xx}). */
  countryFlagCode(code: string | null | undefined): string {
    const c = (code || '').trim().toLowerCase();
    if (!c || c === 'all' || c === '*') {
      return '';
    }
    // flag-icons uses "gb" for UK; keep catalog codes as-is otherwise.
    return c === 'uk' ? 'gb' : c;
  }

  selectedCountryName(): string {
    if (this.isAllCountries) {
      return this.translate.instant('TV.COUNTRY_ALL');
    }
    const found = this.countries.find(
      (x) => (x.code || '').toLowerCase() === (this.selectedCountry || '').toLowerCase()
    );
    return found?.name || (this.selectedCountry || '').toUpperCase();
  }

  onGroupChange(): void {
    this.loadChannels();
  }

  onChannelSearchInput(value: string): void {
    this.channelQuery = value;
    this.channelSearch$.next(value.trim().toLowerCase());
  }

  onProgramSearchInput(value: string): void {
    this.programQuery = value;
    this.programSearch$.next(value.trim().toLowerCase());
  }

  clearChannelSearch(): void {
    this.channelQuery = '';
    this.worldwideSearchHint = false;
    this.channelSearch$.next('');
  }

  clearProgramSearch(): void {
    this.programQuery = '';
    this.clearProgramSearchState();
    this.programSearch$.next('');
    if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
      this.loadChannels();
    }
  }

  /** Matched programme title from server search for list hints. */
  programSearchTitle(channel: TvChannel | null | undefined): string {
    if (!channel || !this.programQuery.trim()) {
      return '';
    }
    const epgId = resolveEpgChannelId(channel);
    if (!epgId) {
      return '';
    }
    const key = epgLookupKey(epgId);
    const hit = this.programSearchHits.find((h) => epgLookupKey(h.channelId) === key);
    return (hit?.programme?.title || '').trim();
  }

  /** Label + title shown under each channel in the sidebar. */
  channelListEpgLine(channel: TvChannel | null | undefined): { labelKey: string; title: string } | null {
    const hit = this.programSearchTitle(channel);
    if (hit) {
      return { labelKey: 'TV.SEARCH_PROGRAM', title: hit };
    }
    const now = this.epgNowTitle(channel);
    if (now) {
      return { labelKey: 'TV.EPG_NOW', title: now };
    }
    return null;
  }

  toggleGuide(): void {
    if (this.guideOpen) {
      this.closeGuide();
      return;
    }
    this.guideOpen = true;
    this.showChrome(true);
    this.loadGuideSchedule();
  }

  closeGuide(): void {
    this.guideOpen = false;
    this.guideError = '';
    this.guideSub?.unsubscribe();
    this.cdr.markForCheck();
  }

  isProgrammeLive(programme: TvEpgProgramme | null | undefined): boolean {
    if (!programme?.start || !programme?.stop) {
      return false;
    }
    const start = new Date(programme.start).getTime();
    const stop = new Date(programme.stop).getTime();
    const now = Date.now();
    return !Number.isNaN(start) && !Number.isNaN(stop) && start <= now && now < stop;
  }

  formatEpgDay(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  private loadGuideSchedule(): void {
    const channel = this.selectedChannel;
    const epgId = resolveEpgChannelId(channel);
    if (!channel || !epgId) {
      this.guideProgrammes = [];
      this.guideError = 'TV.EPG_GUIDE_EMPTY';
      this.isLoadingGuide = false;
      this.cdr.markForCheck();
      return;
    }
    let cc = (channel.country || this.selectedCountry || 'fr').toLowerCase();
    if (!cc || cc === 'all' || cc.length !== 2) {
      cc = 'fr';
    }
    this.guideSub?.unsubscribe();
    this.isLoadingGuide = true;
    this.guideError = '';
    this.guideSub = this.api.getTvEpgSchedule(cc, epgId).subscribe({
      next: (schedule) => {
        this.guideProgrammes = schedule?.programmes || [];
        this.isLoadingGuide = false;
        if (!this.guideProgrammes.length) {
          this.guideError = 'TV.EPG_GUIDE_EMPTY';
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.guideProgrammes = [];
        this.isLoadingGuide = false;
        this.guideError = 'TV.EPG_GUIDE_ERROR';
        this.cdr.markForCheck();
      }
    });
  }

  private clearProgramSearchState(): void {
    this.programSearchHits = [];
    this.programSearchEpgIds = new Set();
    this.isLoadingProgramSearch = false;
    this.programSearchHttpSub?.unsubscribe();
  }

  private runProgramSearch(queryLower: string): void {
    const q = (queryLower || '').trim();
    if (q.length < 2) {
      this.clearProgramSearchState();
      if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
        this.channels = [];
        this.worldwideSearchHint = true;
        this.isLoadingChannels = false;
      }
      this.cdr.markForCheck();
      return;
    }

    const country =
      this.listMode === 'favorites'
        ? 'all'
        : this.isAllCountries
          ? 'all'
          : (this.selectedCountry || 'fr');

    this.programSearchHttpSub?.unsubscribe();
    this.isLoadingProgramSearch = true;
    this.worldwideSearchHint = false;
    this.cdr.markForCheck();

    this.programSearchHttpSub = this.api.getTvEpgSearch(country, q, 50).subscribe({
      next: (hits) => {
        this.programSearchHits = hits || [];
        const ids = new Set<string>();
        for (const hit of this.programSearchHits) {
          const id = epgLookupKey(hit.channelId);
          if (id) {
            ids.add(id);
          }
        }
        this.programSearchEpgIds = ids;
        this.isLoadingProgramSearch = false;

        if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
          if (!this.selectedGroup) {
            this.applyWorldwideProgramHits(this.programSearchHits);
          }
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.programSearchHits = [];
        this.programSearchEpgIds = new Set();
        this.isLoadingProgramSearch = false;
        if (this.listMode === 'catalog' && this.isAllCountries && !this.channelQuery.trim()) {
          this.channels = [];
        }
        this.cdr.markForCheck();
      }
    });
  }

  /** Build the worldwide channel list from EPG search hits that include catalog channels. */
  private applyWorldwideProgramHits(hits: TvEpgSearchHit[]): void {
    const seen = new Set<string>();
    const merged: TvChannel[] = [];
    for (const hit of hits || []) {
      const ch = hit.channel;
      if (!ch) {
        continue;
      }
      const key = (ch.id || ch.streamUrl || ch.name || '').toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(ch);
    }
    this.channels = this.sortChannelsByName(merged);
    this.isLoadingChannels = false;
    this.applyPendingShareChannel();
    this.refreshEpg();
  }

  countryLabel(code: string | null | undefined): string {
    const c = (code || '').trim().toLowerCase();
    if (!c) {
      return '';
    }
    const found = this.countries.find((x) => (x.code || '').toLowerCase() === c);
    if (found) {
      return found.name;
    }
    return c.toUpperCase();
  }

  selectChannel(channel: TvChannel): void {
    this.selectedChannel = channel;
    this.playError = '';
    this.isBuffering = true;
    this.showChrome(true);
    this.persistLastWatchedChannel(channel);
    if (!this.epgFor(channel)) {
      this.refreshEpg();
    }
    if (this.guideOpen) {
      this.loadGuideSchedule();
    }
    if (this.usesTf1Workaround(channel) && this.tf1Configured === false
        && !resolveTvStreamUrl(channel).endsWith(':lci')) {
      this.isBuffering = false;
      this.playError = 'TV.ERR_TF1_AUTH';
      this.showChrome(true);
      this.cdr.detectChanges();
      return;
    }
    // If floating window is already open, switch channel there and keep navigating freely.
    if (this.tvPlayer.isOpen) {
      this.destroyPlayer();
      this.isBuffering = false;
      this.tvPlayer.setChannel(channel);
      this.cdr.detectChanges();
      return;
    }
    this.cdr.detectChanges();
    this.playChannel(channel);
  }

  /** Detach playback into a floating window that survives route changes. */
  openInFloatingWindow(channel?: TvChannel | null): void {
    const ch = channel || this.selectedChannel;
    if (!ch) {
      this.playError = 'TV.FLOAT_NEED_CHANNEL';
      return;
    }
    if (this.usesTf1Workaround(ch) && this.tf1Configured === false
        && !resolveTvStreamUrl(ch).endsWith(':lci')) {
      this.playError = 'TV.ERR_TF1_AUTH';
      return;
    }
    this.destroyPlayer();
    this.isBuffering = false;
    this.playError = '';
    this.selectedChannel = ch;
    this.persistLastWatchedChannel(ch);
    this.tvPlayer.openFloating(ch);
    this.cdr.markForCheck();
  }

  closeFloatingWindow(): void {
    this.tvPlayer.close();
  }

  openExternalWindow(channel?: TvChannel | null): void {
    const ch = channel || this.selectedChannel;
    if (!ch) {
      this.playError = 'TV.FLOAT_NEED_CHANNEL';
      return;
    }
    if (this.usesTf1Workaround(ch) && this.tf1Configured === false
        && !resolveTvStreamUrl(ch).endsWith(':lci')) {
      this.playError = 'TV.ERR_TF1_AUTH';
      return;
    }
    this.destroyPlayer();
    this.isBuffering = false;
    this.playError = '';
    this.selectedChannel = ch;
    this.persistLastWatchedChannel(ch);
    this.tvPlayer.openExternalWindow(ch);
    this.cdr.markForCheck();
  }

  async togglePictureInPicture(): Promise<void> {
    const video = this.videoEl?.nativeElement;
    if (!video || !this.pipSupported || !this.selectedChannel) {
      return;
    }
    // Floating UI owns playback unless we are only hosting OS PiP keep-alive.
    if (this.isFloatingOpen && !this.tvPlayer.isOsPipActive()) {
      return;
    }
    try {
      if (this.tvPlayer.isOsPipActive()) {
        const returned = await this.tvPlayer.exitOsPipToPage(video);
        this.hls = returned.hls;
        this.detachHlsLiveSync = returned.detachLiveSync;
        this.isPipActive = false;
        this.cdr.markForCheck();
        return;
      }
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        this.isPipActive = false;
        this.cdr.markForCheck();
        return;
      }
      // Move HLS/native playback onto a body-level carrier so PiP survives route changes.
      const hls = this.hls;
      const detach = this.detachHlsLiveSync;
      this.hls = null;
      this.detachHlsLiveSync = null;
      try {
        await this.tvPlayer.enterOsPipFromPage({
          channel: this.selectedChannel,
          pageVideo: video,
          hls,
          detachLiveSync: detach
        });
        this.isPipActive = true;
        this.cdr.markForCheck();
      } catch (err) {
        try {
          const returned = await this.tvPlayer.exitOsPipToPage(video);
          this.hls = returned.hls ?? hls;
          this.detachHlsLiveSync = returned.detachLiveSync ?? detach;
          if (!returned.hls && this.hls) {
            this.hls.attachMedia(video);
          }
          await video.play().catch(() => undefined);
        } catch {
          this.hls = hls;
          this.detachHlsLiveSync = detach;
        }
        throw err;
      }
    } catch {
      this.playError = 'TV.ERR_PIP';
      this.showChrome(true);
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    this.isPipActive =
      this.tvPlayer.isOsPipActive() ||
      document.pictureInPictureElement === this.videoEl?.nativeElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture', ['$event'])
  onLeavePip(event: Event): void {
    const left = event?.target as Node | null;
    const pageVideo = this.videoEl?.nativeElement;
    this.isPipActive = false;
    // Carrier leave is owned by TvPlayerService (stop + single resume) — do not start a 2nd stream.
    if (left && pageVideo && left !== pageVideo) {
      this.cdr.markForCheck();
      return;
    }
    if (this.tvPlayer.isOsPipActive()) {
      this.cdr.markForCheck();
      return;
    }
    // Classic in-page video left PiP — resume if needed.
    if (!this.isFloatingOpen && this.selectedChannel) {
      const video = pageVideo;
      if (video?.src || this.hls) {
        video?.play().catch(() => {
          this.resumePagePlayback(this.selectedChannel!);
        });
      } else {
        this.resumePagePlayback(this.selectedChannel);
      }
    }
    this.cdr.markForCheck();
  }

  /** Resume HLS on the page player after floating / pop-out / PiP ends. */
  private resumePagePlayback(channel: TvChannel | null | undefined): void {
    if (!channel || this.tvPlayer.isOpen || this.tvPlayer.isOsPipActive()) {
      return;
    }
    this.tvPlayer.clearPendingResume();
    this.selectedChannel = channel;
    this.persistLastWatchedChannel(channel);
    this.playError = '';
    this.isBuffering = true;
    this.showChrome(true);
    this.cdr.detectChanges();
    setTimeout(() => {
      if (
        !this.tvPlayer.isOpen &&
        !this.tvPlayer.isOsPipActive() &&
        this.selectedChannel?.id === channel.id
      ) {
        this.playChannel(channel);
      }
    }, 0);
  }

  private restoreLastWatchedChannel(): void {
    if (this.restoredLastChannel || this.selectedChannel || this.tvPlayer.isOpen) {
      return;
    }
    const apply = (channel: TvChannel | null | undefined) => {
      if (this.restoredLastChannel || this.selectedChannel || this.tvPlayer.isOpen) {
        return;
      }
      if (!channel?.name || (!channel.streamUrl && !channel.id)) {
        return;
      }
      this.restoredLastChannel = true;
      const normalized: TvChannel = {
        ...channel,
        streamUrl: resolveTvStreamUrl(channel)
      };
      if (normalized.country) {
        const nextCountry = normalized.country;
        if (nextCountry !== this.selectedCountry) {
          this.selectedCountry = nextCountry;
          this.selectedGroup = '';
          this.loadChannels();
        }
      }
      this.selectChannel(normalized);
    };

    if (this.isLoggedIn) {
      this.api.getTvLastChannel().subscribe({
        next: (channel) => {
          if (channel) {
            apply(channel);
            return;
          }
          apply(this.readLastChannelFromStorage());
        },
        error: () => apply(this.readLastChannelFromStorage())
      });
      return;
    }
    apply(this.readLastChannelFromStorage());
  }

  private persistLastWatchedChannel(channel: TvChannel | null | undefined): void {
    if (!channel?.name || (!channel.streamUrl && !channel.id)) {
      return;
    }
    const payload: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    this.writeLastChannelToStorage(payload);
    if (!this.isLoggedIn) {
      return;
    }
    this.lastChannelSaveSub?.unsubscribe();
    this.lastChannelSaveSub = this.api.saveTvLastChannel(payload).subscribe({
      error: () => { /* localStorage already updated */ }
    });
  }

  private readLastChannelFromStorage(): TvChannel | null {
    try {
      const raw = localStorage.getItem(TvWatcherComponent.LAST_CHANNEL_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as TvChannel;
      if (!parsed?.name || (!parsed.streamUrl && !parsed.id)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private writeLastChannelToStorage(channel: TvChannel): void {
    try {
      localStorage.setItem(TvWatcherComponent.LAST_CHANNEL_STORAGE_KEY, JSON.stringify(channel));
    } catch {
      /* private mode */
    }
  }

  isFavorite(channel: TvChannel): boolean {
    return !!channel?.id && this.favoriteIds.has(channel.id);
  }

  /** True when this channel is played via the official france.tv live workaround. */
  usesFranceTvWorkaround(channel: TvChannel | null | undefined): boolean {
    return isFranceTvVirtual(resolveTvStreamUrl(channel));
  }

  /** True when this channel is played via the official TF1 mediainfo workaround. */
  usesTf1Workaround(channel: TvChannel | null | undefined): boolean {
    return isTf1Virtual(resolveTvStreamUrl(channel));
  }

  /** True when this channel is played via Canal group (CNews/CStar) Dailymotion live. */
  usesCanalGroupWorkaround(channel: TvChannel | null | undefined): boolean {
    return isCanalGroupVirtual(resolveTvStreamUrl(channel));
  }

  /** True when this channel is played via Radio France official HLS. */
  usesRadioFranceWorkaround(channel: TvChannel | null | undefined): boolean {
    return isRadioFranceVirtual(resolveTvStreamUrl(channel));
  }

  /** True when M6 / W9 / 6ter / Gulli use public IPTV mirror probe (official is DRM). */
  usesM6GroupWorkaround(channel: TvChannel | null | undefined): boolean {
    return isM6GroupVirtual(resolveTvStreamUrl(channel));
  }

  usesOfficialWorkaround(channel: TvChannel | null | undefined): boolean {
    return this.usesFranceTvWorkaround(channel)
      || this.usesTf1Workaround(channel)
      || this.usesCanalGroupWorkaround(channel)
      || this.usesRadioFranceWorkaround(channel)
      || this.usesM6GroupWorkaround(channel);
  }

  workaroundBadgeKey(channel: TvChannel | null | undefined): string {
    if (this.usesTf1Workaround(channel)) {
      return 'TV.WORKAROUND_BADGE_TF1';
    }
    if (this.usesCanalGroupWorkaround(channel)) {
      return 'TV.WORKAROUND_BADGE_CANAL';
    }
    if (this.usesRadioFranceWorkaround(channel)) {
      return 'TV.WORKAROUND_BADGE_RADIO';
    }
    if (this.usesM6GroupWorkaround(channel)) {
      return 'TV.WORKAROUND_BADGE_M6';
    }
    return 'TV.WORKAROUND_BADGE';
  }

  workaroundHintKey(channel: TvChannel | null | undefined): string {
    if (this.usesTf1Workaround(channel)) {
      return 'TV.WORKAROUND_HINT_TF1';
    }
    if (this.usesCanalGroupWorkaround(channel)) {
      return 'TV.WORKAROUND_HINT_CANAL';
    }
    if (this.usesRadioFranceWorkaround(channel)) {
      return 'TV.WORKAROUND_HINT_RADIO';
    }
    if (this.usesM6GroupWorkaround(channel)) {
      return 'TV.WORKAROUND_HINT_M6';
    }
    return 'TV.WORKAROUND_HINT';
  }

  workaroundActiveKey(channel: TvChannel | null | undefined): string {
    if (this.usesTf1Workaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_TF1';
    }
    if (this.usesCanalGroupWorkaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_CANAL';
    }
    if (this.usesRadioFranceWorkaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_RADIO';
    }
    if (this.usesM6GroupWorkaround(channel)) {
      return 'TV.WORKAROUND_ACTIVE_M6';
    }
    return 'TV.WORKAROUND_ACTIVE';
  }

  toggleFavorite(channel: TvChannel, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!channel?.id) {
      return;
    }
    if (!this.isLoggedIn) {
      this.favoritesHint = 'TV.FAVORITES_LOGIN';
      this.cdr.markForCheck();
      return;
    }
    if (this.favoriteBusyId) {
      return;
    }
    this.favoritesHint = '';
    this.favoritesError = '';
    this.favoriteBusyId = channel.id;
    const removing = this.isFavorite(channel);
    const payload: TvChannel = {
      ...channel,
      streamUrl: resolveTvStreamUrl(channel)
    };
    const req$ = removing
      ? this.api.removeTvFavorite(channel.id)
      : this.api.addTvFavorite(payload);

    req$.subscribe({
      next: (fav) => {
        this.applyFavorites(fav?.channels || []);
        this.favoriteBusyId = '';
        this.cdr.markForCheck();
      },
      error: () => {
        this.favoriteBusyId = '';
        this.favoritesError = 'TV.ERR_FAVORITES_SAVE';
        this.cdr.markForCheck();
      }
    });
  }

  toggleShareMenu(event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.selectedChannel) {
      return;
    }
    this.shareMenuOpen = !this.shareMenuOpen;
    this.shareFeedback = '';
    if (this.shareMenuOpen) {
      this.showChrome(false);
    }
    this.cdr.markForCheck();
  }

  async shareViaNative(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const channel = this.selectedChannel;
    if (!channel) {
      return;
    }
    const { title, text, url } = this.buildSharePayload(channel);
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
    };
    if (typeof nav.share !== 'function') {
      return;
    }
    try {
      // Put the URL in `text` as well: many targets (WhatsApp) ignore `url` and only send text.
      await nav.share({ title, text, url });
      this.shareMenuOpen = false;
      this.cdr.markForCheck();
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
      if (name === 'AbortError') {
        return;
      }
      await this.shareViaWhatsApp(event);
    }
  }

  async shareViaWhatsApp(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const channel = this.selectedChannel;
    if (!channel) {
      return;
    }
    // URL first on its own line — WhatsApp linkifies more reliably than trailing URLs.
    const { text } = this.buildSharePayload(channel, { urlFirst: true });
    window.open(
      `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener,noreferrer'
    );
    this.shareMenuOpen = false;
    this.cdr.markForCheck();
  }

  async shareCopyLink(event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    const channel = this.selectedChannel;
    if (!channel) {
      return;
    }
    const url = this.buildShareDeepLink(channel);
    const ok = await this.copyTextToClipboard(url);
    this.shareFeedback = ok ? 'TV.SHARE_COPIED' : 'TV.SHARE_COPY_FAILED';
    this.shareMenuOpen = false;
    this.clearShareFeedbackTimer();
    this.shareFeedbackTimer = setTimeout(() => {
      this.shareFeedback = '';
      this.shareFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2500);
    this.cdr.markForCheck();
  }

  trackByChannelId(_: number, ch: TvChannel): string {
    return ch.id;
  }

  /** Display play errors: translate {@code TV.*} keys, show API/backend text as-is. */
  formatPlayError(message: string | null | undefined): string {
    const m = (message || '').trim();
    if (!m) {
      return '';
    }
    return isTvI18nErrorKey(m) ? this.translate.instant(m) : m;
  }

  groupIconClass(group: string | null | undefined): string {
    return groupIconFaClass(group);
  }

  groupEmoji(group: string | null | undefined): string {
    return groupIconEmoji(group);
  }

  /**
   * ngx-translate key for known categories, otherwise the raw API name
   * (pipe falls back to the string itself when no key exists).
   */
  groupLabelKey(group: string | null | undefined): string {
    const raw = (group || '').trim();
    if (!raw) {
      return 'TV.GROUP_ALL';
    }
    return groupI18nKey(raw) || raw;
  }

  /**
   * Opens a channel from {@code ?ch=&c=&n=&s=} (shared link via {@code tv-link.html}).
   * @returns true if a share deep-link was handled (skip last-channel restore).
   */
  private tryOpenSharedChannelFromQuery(): boolean {
    const p = this.route.snapshot.queryParamMap;
    const id = (p.get('ch') || '').trim();
    const stream = (p.get('s') || '').trim();
    const name = (p.get('n') || '').trim();
    const country = (p.get('c') || '').trim().toLowerCase();
    if (!id && !stream) {
      return false;
    }
    if (country) {
      this.selectedCountry = country;
    }
    const draft: TvChannel = {
      id: id || `shared-${(stream || name || 'tv').slice(0, 48)}`,
      name: name || id || 'TV',
      country: country || this.selectedCountry,
      streamUrl: stream || '',
      group: '',
      logo: undefined,
      quality: undefined
    };
    draft.streamUrl = resolveTvStreamUrl(draft) || stream;
    if (draft.streamUrl) {
      this.restoredLastChannel = true;
      this.selectChannel(draft);
      return true;
    }
    if (id) {
      this.pendingShareChannelId = id;
      this.restoredLastChannel = true;
      return true;
    }
    return false;
  }

  private applyPendingShareChannel(): void {
    const id = this.pendingShareChannelId;
    if (!id || this.selectedChannel) {
      return;
    }
    const found = this.channels.find((ch) => ch.id === id)
      || this.favorites.find((ch) => ch.id === id);
    if (!found) {
      return;
    }
    this.pendingShareChannelId = '';
    this.selectChannel({
      ...found,
      streamUrl: resolveTvStreamUrl(found)
    });
  }

  /**
   * Shareable URL without hash in the path (WhatsApp-friendly), via static redirect page.
   * Keep the query short and free of nested http(s) — messengers then auto-link reliably.
   */
  private buildShareDeepLink(channel: TvChannel): string {
    const u = new URL(window.location.href);
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    const marker = '/assets/tv-link.html';
    const at = path.indexOf(marker);
    let basePath: string;
    if (at >= 0) {
      basePath = path.substring(0, at);
    } else if (path === '/') {
      basePath = '';
    } else if (path.endsWith('/index.html')) {
      basePath = path.slice(0, -'/index.html'.length);
      if (basePath === '/') {
        basePath = '';
      }
    } else {
      // Hash-routed SPA: pathname is the deploy base (e.g. /pattool), not the Angular route.
      basePath = path;
    }
    const params = new URLSearchParams();
    if (channel.id) {
      params.set('ch', channel.id);
    }
    const country = (channel.country || this.selectedCountry || '').trim();
    if (country) {
      params.set('c', country);
    }
    const name = (channel.name || '').trim();
    if (name && name.length <= 80) {
      params.set('n', name);
    }
    // Only short virtual tokens (francetv:…, tf1:…). Full http(s) stream URLs nested in
    // ?s= break WhatsApp / iMessage auto-link (they see a second https inside the query).
    const stream = resolveTvStreamUrl(channel);
    if (stream && TvWatcherComponent.isShareSafeStreamToken(stream)) {
      params.set('s', stream);
    }
    // Prefer %20 over + — some messengers stop linkifying at +.
    const qs = params.toString().replace(/\+/g, '%20');
    return `${u.origin}${basePath}/assets/tv-link.html?${qs}`;
  }

  /**
   * True for short non-URL stream tokens safe to put in a WhatsApp share link.
   * Rejects anything that looks like http(s):// (even encoded).
   */
  private static isShareSafeStreamToken(stream: string): boolean {
    const s = (stream || '').trim();
    if (!s || s.length > TvWatcherComponent.SHARE_STREAM_MAX_LEN) {
      return false;
    }
    if (/^https?:\/\//i.test(s) || s.includes('://')) {
      return false;
    }
    if (/%3A%2F%2F/i.test(s) || /https?%3A/i.test(s)) {
      return false;
    }
    return true;
  }

  /** Message + URL formatted so WhatsApp / iMessage make the link tappable. */
  private buildSharePayload(
    channel: TvChannel,
    opts?: { urlFirst?: boolean }
  ): { title: string; text: string; url: string } {
    const url = this.buildShareDeepLink(channel);
    const title = channel.name || this.translate.instant('TV.TITLE');
    const intro = this.translate.instant('TV.SHARE_TEXT', { name: channel.name || title });
    // Blank line isolates the URL so messengers detect a single clean link.
    const text = opts?.urlFirst ? `${url}\n\n${intro}` : `${intro}\n\n${url}`;
    return { title, text, url };
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  private clearShareFeedbackTimer(): void {
    if (this.shareFeedbackTimer != null) {
      clearTimeout(this.shareFeedbackTimer);
      this.shareFeedbackTimer = null;
    }
  }

  private clearResyncFeedbackTimer(): void {
    if (this.resyncFeedbackTimer != null) {
      clearTimeout(this.resyncFeedbackTimer);
      this.resyncFeedbackTimer = null;
    }
  }

  /** Force A/V resync (live edge seek + MediaSource recover). */
  resyncAudioVideo(event?: Event): void {
    event?.stopPropagation();
    const video = this.videoEl?.nativeElement;
    if (!video || !this.selectedChannel || this.isFloatingOpen) {
      return;
    }
    this.isBuffering = true;
    this.resyncFeedback = 'TV.RESYNC_AV_DONE';
    this.clearResyncFeedbackTimer();
    resyncTvHlsAv(this.hls, video);
    this.showChrome(true);
    this.cdr.markForCheck();
    // Brief buffering pulse then clear status.
    window.setTimeout(() => {
      this.isBuffering = false;
      this.cdr.markForCheck();
    }, 400);
    this.resyncFeedbackTimer = setTimeout(() => {
      this.resyncFeedback = '';
      this.resyncFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  /** Tear down HLS/media and reconnect to the current channel from scratch. */
  restartStream(event?: Event): void {
    event?.stopPropagation();
    const channel = this.selectedChannel;
    if (!channel || this.isFloatingOpen) {
      return;
    }
    this.playError = '';
    this.isBuffering = true;
    this.resyncFeedback = 'TV.RESTART_STREAM_DONE';
    this.clearResyncFeedbackTimer();
    this.showChrome(true);
    this.cdr.markForCheck();
    this.playChannel(channel);
    this.resyncFeedbackTimer = setTimeout(() => {
      this.resyncFeedback = '';
      this.resyncFeedbackTimer = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  private loadCountries(): void {
    this.isLoadingCountries = true;
    this.countriesError = '';
    this.api.getTvCountries().subscribe({
      next: (list) => {
        this.countries = [...(list || [])].sort((a, b) => {
          const pin = (code?: string) => {
            const c = (code || '').toLowerCase();
            if (c === 'fr') return 0;
            if (c === 'ch') return 1;
            return 100;
          };
          const d = pin(a.code) - pin(b.code);
          if (d !== 0) {
            return d;
          }
          return (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' });
        });
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.countries = [];
        this.countriesError = 'TV.ERR_COUNTRIES';
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      }
    });
  }

  /** Total TVs for the selected country (or worldwide). Used by the catalog tab badge. */
  private loadCatalogCount(): void {
    this.catalogCountSub?.unsubscribe();
    this.isLoadingCatalogCount = true;
    const country = this.isAllCountries ? 'all' : (this.selectedCountry || 'fr');
    this.catalogCountSub = this.api.getTvChannelCount(country).subscribe({
      next: (res) => {
        this.catalogTotalCount = Math.max(0, Number(res?.count) || 0);
        this.isLoadingCatalogCount = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingCatalogCount = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadChannels(): void {
    this.isLoadingChannels = true;
    this.channelsError = '';
    this.worldwideSearchHint = false;
    this.channelsSub?.unsubscribe();
    const country = this.selectedCountry || 'fr';
    const channelQ = (this.channelQuery || '').trim();
    const programQ = (this.programQuery || '').trim();
    const group = (this.selectedGroup || '').trim();

    if (country.toLowerCase() === 'all') {
      this.loadWorldwideGroups();
      if (channelQ.length >= 2 || group) {
        this.channelsSub = this.api.getTvChannels('all', channelQ.length >= 2 ? channelQ : undefined, group || undefined).subscribe({
          next: (list) => {
            this.channels = this.sortChannelsByName(list || []);
            this.isLoadingChannels = false;
            this.applyPendingShareChannel();
            this.refreshEpg();
            this.cdr.markForCheck();
          },
          error: () => {
            this.channels = [];
            this.isLoadingChannels = false;
            this.channelsError = 'TV.ERR_CHANNELS';
            this.cdr.markForCheck();
          }
        });
        return;
      }
      if (programQ.length >= 2) {
        // Channel list is filled by runProgramSearch → applyWorldwideProgramHits.
        this.isLoadingChannels = this.isLoadingProgramSearch;
        this.cdr.markForCheck();
        return;
      }
      this.channels = [];
      this.isLoadingChannels = false;
      this.worldwideSearchHint = true;
      this.cdr.markForCheck();
      return;
    }

    this.api.getTvGroups(country).subscribe({
      next: (g) => {
        this.groups = g || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.groups = [];
      }
    });

    this.channelsSub = this.api.getTvChannels(country, undefined, this.selectedGroup).subscribe({
      next: (list) => {
        this.channels = this.sortChannelsByName(list || []);
        this.isLoadingChannels = false;
        this.applyPendingShareChannel();
        this.refreshEpg();
        this.cdr.markForCheck();
      },
      error: () => {
        this.channels = [];
        this.isLoadingChannels = false;
        this.channelsError = 'TV.ERR_CHANNELS';
        this.cdr.markForCheck();
      }
    });
  }

  /** Load category list for worldwide mode (union of all country groups). */
  private loadWorldwideGroups(): void {
    this.api.getTvGroups('all').subscribe({
      next: (g) => {
        this.groups = g || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.groups = [];
        this.cdr.markForCheck();
      }
    });
  }

  /** Fetch now/next EPG for the channel pool (batched). */
  private refreshEpg(): void {
    const pool =
      this.listMode === 'favorites' ? this.favorites || [] : this.channels || [];
    const byCountry = new Map<string, string[]>();
    const addChannel = (ch: TvChannel | null | undefined) => {
      if (!ch) {
        return;
      }
      const epgId = resolveEpgChannelId(ch);
      if (!epgId) {
        return;
      }
      let cc = (ch.country || this.selectedCountry || 'fr').toLowerCase();
      if (!cc || cc === 'all' || cc.length !== 2) {
        cc = 'fr';
      }
      const list = byCountry.get(cc) || [];
      if (!list.includes(epgId)) {
        list.push(epgId);
      }
      byCountry.set(cc, list);
    };
    for (const ch of pool) {
      addChannel(ch);
    }
    addChannel(this.selectedChannel);

    if (!byCountry.size) {
      return;
    }

    const chunkSize = 80;
    const requests = [];
    for (const [cc, ids] of byCountry.entries()) {
      for (let i = 0; i < ids.length; i += chunkSize) {
        requests.push(
          this.api.getTvEpgNow(cc, ids.slice(i, i + chunkSize)).pipe(
            catchError(() => of({} as Record<string, TvEpgNow>))
          )
        );
      }
    }

    this.epgSub?.unsubscribe();
    this.isLoadingEpg = true;
    this.epgSub = forkJoin(requests).subscribe({
      next: (maps) => {
        const merged: Record<string, TvEpgNow> = { ...this.epgById };
        for (const map of maps) {
          for (const [id, value] of Object.entries(map || {})) {
            merged[epgLookupKey(id)] = value;
          }
        }
        this.epgById = merged;
        this.isLoadingEpg = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingEpg = false;
        this.cdr.markForCheck();
      }
    });
  }

  epgFor(channel: TvChannel | null | undefined): TvEpgNow | null {
    const id = resolveEpgChannelId(channel);
    if (!id) {
      return null;
    }
    return this.epgById[epgLookupKey(id)] || null;
  }

  epgNowTitle(channel: TvChannel | null | undefined): string {
    return (this.epgFor(channel)?.now?.title || '').trim();
  }

  epgNextTitle(channel: TvChannel | null | undefined): string {
    return (this.epgFor(channel)?.next?.title || '').trim();
  }

  formatEpgClock(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      return '';
    }
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private loadFavorites(): void {
    if (!this.isLoggedIn) {
      this.favorites = [];
      this.favoriteIds = new Set();
      return;
    }
    this.isLoadingFavorites = true;
    this.favoritesError = '';
    this.api.getTvFavorites().subscribe({
      next: (fav) => {
        this.applyFavorites(fav?.channels || []);
        this.isLoadingFavorites = false;
        this.applyPendingShareChannel();
        if (this.listMode === 'favorites') {
          this.refreshEpg();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingFavorites = false;
        this.favorites = [];
        this.favoriteIds = new Set();
        this.favoritesError = 'TV.ERR_FAVORITES_LOAD';
        this.cdr.markForCheck();
      }
    });
  }

  private loadTf1Status(): void {
    this.api.getTvTf1Status().subscribe({
      next: (s) => {
        this.tf1Configured = !!s?.configured;
        this.cdr.markForCheck();
      },
      error: () => {
        this.tf1Configured = null;
      }
    });
  }

  private applyFavorites(list: TvChannel[]): void {
    this.favorites = this.sortChannelsByName(
      (list || []).map((ch) => ({
        ...ch,
        streamUrl: resolveTvStreamUrl(ch)
      }))
    );
    this.favoriteIds = new Set(this.favorites.map((c) => c.id).filter(Boolean));
  }

  /** Alphabetical order by channel name (locale-aware, case-insensitive). */
  private sortChannelsByName(list: TvChannel[]): TvChannel[] {
    return [...list].sort((a, b) =>
      (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base', numeric: true })
    );
  }

  private playChannel(channel: TvChannel): void {
    const video = this.videoEl?.nativeElement;
    if (!video || !channel?.streamUrl) {
      return;
    }

    if (this.tvPlayer.isOsPipActive()) {
      this.tvPlayer.stopOsPip();
      this.isPipActive = false;
    }

    this.destroyPlayer();
    this.playError = '';
    this.isBuffering = true;
    const playGen = ++this.playGeneration;
    this.applyAudioToVideo(video, { muted: false, ensureVolume: true });
    const streamUrl = resolveTvStreamUrl(channel);
    const proxyUrl = this.api.tvStreamProxyUrl(streamUrl);

    const tryPlay = (allowMuteFallback = true) => {
      if (playGen !== this.playGeneration) {
        return;
      }
      this.applyAudioToVideo(video, { muted: this.isMuted, ensureVolume: true });
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (playGen !== this.playGeneration) {
            return;
          }
          this.isBuffering = false;
          this.syncMuteFromVideo();
          this.cdr.markForCheck();
        }).catch((err: unknown) => {
          if (playGen !== this.playGeneration) {
            return;
          }
          const name =
            err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
          // AbortError is normal when switching channel / destroying the player mid-play().
          if (name === 'AbortError') {
            return;
          }
          if (allowMuteFallback && !this.isMuted) {
            // Autoplay with sound blocked (async HLS loses user gesture) — start muted.
            this.applyAudioToVideo(video, { muted: true, ensureVolume: true });
            this.showChrome(false);
            tryPlay(false);
            return;
          }
          this.isBuffering = false;
          this.playError = 'TV.ERR_PLAY';
          this.showChrome(true);
          this.cdr.markForCheck();
        });
      } else {
        this.isBuffering = false;
      }
    };

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = proxyUrl;
      const onNativeError = () => {
        void this.reportPlayStreamError(proxyUrl, playGen);
      };
      video.addEventListener('error', onNativeError, { once: true });
      tryPlay();
      return;
    }

    if (Hls.isSupported()) {
      this.hls = new Hls(createTvHlsConfig());
      this.hls.loadSource(proxyUrl);
      this.hls.attachMedia(video);
      video.playbackRate = 1;
      this.detachHlsLiveSync = attachTvHlsLiveSyncWatchdog(this.hls, video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        tryPlay();
      });
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) {
          return;
        }
        if (this.hls && tryRecoverTvHlsError(this.hls, data)) {
          this.isBuffering = true;
          this.cdr.markForCheck();
          tryPlay(false);
          return;
        }
        try {
          this.hls?.destroy();
        } catch {
          /* ignore */
        }
        this.hls = null;
        void this.reportPlayStreamError(proxyUrl, playGen, data);
      });
      return;
    }

    this.isBuffering = false;
    this.playError = 'TV.ERR_UNSUPPORTED';
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  private async reportPlayStreamError(
    proxyUrl: string,
    playGen: number,
    hlsData?: Parameters<typeof resolveTvStreamErrorMessage>[1]
  ): Promise<void> {
    if (playGen !== this.playGeneration) {
      return;
    }
    this.isBuffering = false;
    this.cdr.markForCheck();
    const message = await resolveTvStreamErrorMessage(proxyUrl, hlsData);
    if (playGen !== this.playGeneration) {
      return;
    }
    this.playError = message;
    this.showChrome(true);
    this.cdr.markForCheck();
  }

  /** Keep component mute/volume flags in sync with the real media element. */
  onVideoVolumeChange(): void {
    this.syncMuteFromVideo();
    this.cdr.markForCheck();
  }

  private syncMuteFromVideo(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    this.isMuted = !!video.muted || video.volume === 0;
    if (!video.muted && video.volume > 0) {
      this.volumePercent = Math.round(video.volume * 100);
    }
  }

  private applyAudioToVideo(
    video: HTMLVideoElement,
    opts: { muted: boolean; ensureVolume: boolean }
  ): void {
    if (opts.ensureVolume && this.volumePercent <= 0) {
      this.volumePercent = 100;
    }
    video.volume = Math.min(1, Math.max(0, this.volumePercent / 100));
    video.muted = opts.muted;
    this.isMuted = opts.muted || this.volumePercent <= 0;
  }

  toggleMute(): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    if (video.muted || this.isMuted || this.volumePercent <= 0) {
      this.ensureSound();
      return;
    }
    this.applyAudioToVideo(video, { muted: true, ensureVolume: false });
    this.showChrome(false);
    this.cdr.markForCheck();
  }

  /**
   * Force audible playback after a user gesture (required by browser autoplay rules
   * once HLS has loaded asynchronously).
   */
  ensureSound(event?: Event): void {
    event?.stopPropagation();
    const video = this.videoEl?.nativeElement;
    if (!video || !this.selectedChannel || this.isFloatingOpen) {
      return;
    }
    // Already audible — do nothing (avoids fighting the mute button).
    if (!video.muted && video.volume > 0 && !this.isMuted && this.volumePercent > 0) {
      return;
    }
    this.volumePercent = this.volumePercent > 0 ? this.volumePercent : 100;
    this.applyAudioToVideo(video, { muted: false, ensureVolume: true });
    const p = video.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => { /* ignore */ });
    }
    this.scheduleChromeHide();
    this.cdr.markForCheck();
  }

  setVolumePercent(value: number | string): void {
    const video = this.videoEl?.nativeElement;
    if (!video) {
      return;
    }
    const pct = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
    this.volumePercent = pct;
    video.volume = pct / 100;
    if (pct > 0) {
      video.muted = false;
      this.isMuted = false;
      this.scheduleChromeHide();
    } else {
      video.muted = true;
      this.isMuted = true;
      this.showChrome(false);
    }
    this.cdr.markForCheck();
  }

  private destroyPlayer(): void {
    if (this.detachHlsLiveSync) {
      this.detachHlsLiveSync();
      this.detachHlsLiveSync = null;
    }
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    const video = this.videoEl?.nativeElement;
    // Do not touch the OS PiP carrier — it lives outside this view.
    if (video && document.pictureInPictureElement !== video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
}
