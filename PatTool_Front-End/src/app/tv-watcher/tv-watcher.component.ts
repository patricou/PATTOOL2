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
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import Hls from 'hls.js';

import { ApiService, TvChannel, TvCountry } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { TvPlayerService } from '../services/tv-player.service';
import {
  isCanalGroupVirtual,
  isFranceTvVirtual,
  isRadioFranceVirtual,
  isTf1Virtual,
  resolveTvStreamUrl
} from './tv-stream.util';

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

  listMode: TvListMode = 'catalog';
  selectedCountry = 'fr';
  selectedGroup = '';
  searchQuery = '';
  selectedChannel: TvChannel | null = null;

  isLoadingCountries = false;
  isLoadingChannels = false;
  isLoadingFavorites = false;
  favoriteBusyId = '';
  playError = '';
  channelsError = '';
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

  private hls: Hls | null = null;
  private search$ = new Subject<string>();
  private searchSub?: Subscription;
  private resumeSub?: Subscription;
  private lastChannelSaveSub?: Subscription;
  private restoredLastChannel = false;
  private chromeHideTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CHROME_HIDE_MS = 3000;
  private static readonly LAST_CHANNEL_STORAGE_KEY = 'pattool.tv.last-channel';

  constructor(
    private api: ApiService,
    private keycloak: KeycloakService,
    private tvPlayer: TvPlayerService,
    private cdr: ChangeDetectorRef
  ) {}

  get isLoggedIn(): boolean {
    return this.keycloak.isLoggedIn();
  }

  get isFloatingOpen(): boolean {
    return this.tvPlayer.isOpen;
  }

  get displayedChannels(): TvChannel[] {
    if (this.listMode === 'favorites') {
      const q = this.searchQuery.trim().toLowerCase();
      if (!q) {
        return this.favorites;
      }
      return this.favorites.filter(
        (ch) =>
          (ch.name && ch.name.toLowerCase().includes(q)) ||
          (ch.group && ch.group.toLowerCase().includes(q)) ||
          (ch.country && ch.country.toLowerCase().includes(q))
      );
    }
    return this.channels;
  }

  ngOnInit(): void {
    this.searchSub = this.search$
      .pipe(debounceTime(280), distinctUntilChanged())
      .subscribe(() => {
        if (this.listMode === 'catalog') {
          this.loadChannels();
        } else {
          this.cdr.markForCheck();
        }
      });

    this.resumeSub = this.tvPlayer.resumeOnPage$.subscribe((channel) => {
      this.resumePagePlayback(channel);
    });
    const pending = this.tvPlayer.consumePendingResume();
    if (pending) {
      this.restoredLastChannel = true;
      this.resumePagePlayback(pending);
    }

    this.loadCountries();
    this.loadChannels();
    this.loadFavorites();
    this.loadTf1Status();
    this.restoreLastWatchedChannel();
  }

  ngOnDestroy(): void {
    this.clearChromeHideTimer();
    this.searchSub?.unsubscribe();
    this.resumeSub?.unsubscribe();
    this.lastChannelSaveSub?.unsubscribe();
    this.destroyPlayer();
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
    if (!this.selectedChannel || this.isMuted) {
      return;
    }
    this.chromeHideTimer = setTimeout(() => {
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
    if (mode === 'favorites' && !this.isLoggedIn) {
      this.favoritesHint = 'TV.FAVORITES_LOGIN';
    }
    this.cdr.markForCheck();
  }

  onCountryChange(): void {
    this.selectedGroup = '';
    this.searchQuery = '';
    this.loadChannels();
  }

  onGroupChange(): void {
    this.loadChannels();
  }

  onSearchInput(value: string): void {
    this.searchQuery = value;
    this.search$.next(value.trim().toLowerCase());
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.search$.next('');
  }

  selectChannel(channel: TvChannel): void {
    this.selectedChannel = channel;
    this.playError = '';
    this.isBuffering = true;
    this.showChrome(true);
    this.persistLastWatchedChannel(channel);
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
    if (!video || !this.pipSupported || this.isFloatingOpen) {
      return;
    }
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        if (video.readyState < 1) {
          await video.play().catch(() => undefined);
        }
        await video.requestPictureInPicture();
      }
    } catch {
      this.playError = 'TV.ERR_PIP';
      this.showChrome(true);
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:enterpictureinpicture')
  onEnterPip(): void {
    this.isPipActive = document.pictureInPictureElement === this.videoEl?.nativeElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:leavepictureinpicture')
  onLeavePip(): void {
    this.isPipActive = false;
    // Browser often pauses when leaving PiP — resume in-page playback.
    if (!this.isFloatingOpen && this.selectedChannel) {
      const video = this.videoEl?.nativeElement;
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
    if (!channel || this.tvPlayer.isOpen) {
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
      if (!this.tvPlayer.isOpen && this.selectedChannel?.id === channel.id) {
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

  usesOfficialWorkaround(channel: TvChannel | null | undefined): boolean {
    return this.usesFranceTvWorkaround(channel)
      || this.usesTf1Workaround(channel)
      || this.usesCanalGroupWorkaround(channel)
      || this.usesRadioFranceWorkaround(channel);
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

  trackByChannelId(_: number, ch: TvChannel): string {
    return ch.id;
  }

  private loadCountries(): void {
    this.isLoadingCountries = true;
    this.api.getTvCountries().subscribe({
      next: (list) => {
        this.countries = list || [];
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingCountries = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadChannels(): void {
    this.isLoadingChannels = true;
    this.channelsError = '';
    const country = this.selectedCountry || 'fr';

    this.api.getTvGroups(country).subscribe({
      next: (g) => {
        this.groups = g || [];
        this.cdr.markForCheck();
      },
      error: () => {
        this.groups = [];
      }
    });

    this.api.getTvChannels(country, this.searchQuery, this.selectedGroup).subscribe({
      next: (list) => {
        this.channels = this.sortChannelsByName(list || []);
        this.isLoadingChannels = false;
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

    this.destroyPlayer();
    this.playError = '';
    this.isBuffering = true;
    this.applyAudioToVideo(video, { muted: false, ensureVolume: true });
    const streamUrl = resolveTvStreamUrl(channel);
    const proxyUrl = this.api.tvStreamProxyUrl(streamUrl);

    const tryPlay = (allowMuteFallback = true) => {
      this.applyAudioToVideo(video, { muted: this.isMuted, ensureVolume: true });
      const p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          this.isBuffering = false;
          this.syncMuteFromVideo();
          this.cdr.markForCheck();
        }).catch((err: unknown) => {
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
      tryPlay();
      return;
    }

    if (Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        }
      });
      this.hls.loadSource(proxyUrl);
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        tryPlay();
      });
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          this.isBuffering = false;
          this.playError = 'TV.ERR_STREAM';
          this.showChrome(true);
          this.cdr.markForCheck();
          try {
            this.hls?.destroy();
          } catch {
            /* ignore */
          }
          this.hls = null;
        }
      });
      return;
    }

    this.isBuffering = false;
    this.playError = 'TV.ERR_UNSUPPORTED';
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
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    const video = this.videoEl?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
}
