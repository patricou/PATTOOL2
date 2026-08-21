import { Component, OnDestroy, OnInit } from '@angular/core';
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

@Component({
  selector: 'app-youtube-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './youtube-watcher.component.html',
  styleUrls: ['./youtube-watcher.component.css']
})
export class YoutubeWatcherComponent implements OnInit, OnDestroy {
  readonly types: YoutubeItemKind[] = ['video', 'playlist', 'channel'];
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

  private readonly query$ = new Subject<string>();
  private searchSub?: Subscription;
  private readonly subs: Subscription[] = [];

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
      })
    );

    if (this.query || this.channelId) {
      this.runSearch(params.get('id'));
    } else {
      this.loadPopular(params.get('id'));
    }
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.subs.forEach((s) => s.unsubscribe());
    if (this.embedUrl && this.selected && !this.youtubePlayer.snapshot.open) {
      this.youtubePlayer.open(this.selected);
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
      this.embedUrl = this.buildEmbedUrl(item);
    }
    this.syncUrl();
  }

  openInFloatingWindow(): void {
    if (!this.selected) {
      return;
    }
    this.embedUrl = null;
    this.youtubePlayer.open(this.selected);
  }

  restorePlayer(): void {
    this.youtubePlayer.restore();
  }

  closePlayer(): void {
    const item = this.selected || this.youtubePlayer.currentItem;
    this.youtubePlayer.close();
    this.playerOpen = false;
    if (item) {
      this.selected = item;
      this.embedUrl = this.buildEmbedUrl(item);
    }
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
            maxResults: 12
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
        maxResults: 12
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
    this.items = append ? [...this.items, ...incoming] : incoming;
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

  private buildEmbedUrl(item: YoutubeItem): SafeResourceUrl | null {
    const id = item.id || '';
    if (item.kind === 'playlist' && /^[a-zA-Z0-9_-]{10,64}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}&rel=0`
      );
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return this.sanitizer.bypassSecurityTrustResourceUrl(
        `https://www.youtube-nocookie.com/embed/${id}?rel=0`
      );
    }
    return null;
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

  private syncUrl(preferId?: string | null): void {
    const queryParams: Record<string, string | null> = {
      q: this.query.trim() || null,
      type: this.type !== 'video' ? this.type : null,
      region: this.regionCode !== this.regionFromUiLang(this.translate.currentLang) ? this.regionCode : null,
      channel: this.channelId || null,
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
