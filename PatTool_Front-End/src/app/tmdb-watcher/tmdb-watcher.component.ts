import { Component, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

import {
  ApiService,
  TmdbDetail,
  TmdbGenre,
  TmdbItem,
  TmdbPage,
  TmdbVideo
} from '../services/api.service';
import {
  VideoshowModalComponent,
  VideoshowVideoSource
} from '../shared/videoshow-modal/videoshow-modal.component';

type TmdbMode = 'trending' | 'search' | 'discover';
type TmdbMedia = 'all' | 'movie' | 'tv';
type TmdbWindow = 'day' | 'week';
type TmdbSort = 'popular' | 'rating' | 'rating_asc' | 'newest' | 'oldest' | 'title' | 'title_desc' | 'votes' | 'revenue';

const YT_KEY = /^[A-Za-z0-9_-]{6,20}$/;

@Component({
  selector: 'app-tmdb-watcher',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, VideoshowModalComponent],
  templateUrl: './tmdb-watcher.component.html',
  styleUrls: ['./tmdb-watcher.component.css']
})
export class TmdbWatcherComponent implements OnInit, OnDestroy {
  @ViewChild('videoshowModalComponent') videoshowModal?: VideoshowModalComponent;

  mode: TmdbMode = 'trending';
  media: TmdbMedia = 'all';
  window: TmdbWindow = 'week';
  sort: TmdbSort = 'popular';
  query = '';
  genre: number | null = null;
  yearText = '';
  actorText = '';
  producerText = '';
  directorText = '';
  actorName = '';
  producerName = '';
  directorName = '';

  items: TmdbItem[] = [];
  genres: TmdbGenre[] = [];
  page = 1;
  totalPages = 0;
  totalResults = 0;

  isLoading = false;
  missingKey = false;
  listError = '';

  detailOpen = false;
  detailLoading = false;
  detailError = '';
  detail: TmdbDetail | null = null;
  trailerSafe: SafeResourceUrl | null = null;
  videoshowOpen = false;

  private search$ = new Subject<string>();
  private person$ = new Subject<string>();
  private searchSub?: Subscription;
  private personSub?: Subscription;
  private sourceItems: TmdbItem[] = [];
  private listSub?: Subscription;
  private genreSub?: Subscription;
  private detailSub?: Subscription;
  private langSub?: Subscription;

  constructor(
    private api: ApiService,
    private translate: TranslateService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.searchSub = this.search$.pipe(debounceTime(400), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.load();
    });
    this.personSub = this.person$.pipe(debounceTime(400), distinctUntilChanged()).subscribe(() => {
      if (this.mode !== 'discover') {
        return;
      }
      this.page = 1;
      this.load();
    });
    this.langSub = this.translate.onLangChange.subscribe(() => {
      this.genres = [];
      this.page = 1;
      this.load();
      if (this.mode === 'discover') {
        this.loadGenres();
      }
      if (this.detailOpen && this.detail?.id && this.detail.mediaType) {
        this.openDetail({
          id: this.detail.id,
          mediaType: this.detail.mediaType,
          title: this.detail.title || ''
        });
      }
    });
    setTimeout(() => this.load(), 0);
  }

  ngOnDestroy(): void {
    this.searchSub?.unsubscribe();
    this.personSub?.unsubscribe();
    this.listSub?.unsubscribe();
    this.genreSub?.unsubscribe();
    this.detailSub?.unsubscribe();
    this.langSub?.unsubscribe();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.videoshowOpen || !this.detailOpen) {
      return;
    }
    this.closeDetail();
  }

  setMode(mode: TmdbMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    if (mode === 'discover' && this.media === 'all') {
      this.media = 'movie';
    }
    if (mode !== 'discover' && this.sort === 'revenue') {
      this.sort = 'popular';
    }
    this.page = 1;
    this.load();
    if (mode === 'discover') {
      this.loadGenres();
    }
  }

  setMedia(media: TmdbMedia): void {
    if (this.media === media) {
      return;
    }
    this.media = media;
    if (media !== 'movie' && this.sort === 'revenue') {
      this.sort = 'popular';
    }
    this.genre = null;
    this.genres = [];
    this.page = 1;
    this.load();
    if (this.mode === 'discover') {
      this.loadGenres();
    }
  }

  onQueryChange(): void {
    this.search$.next(this.query.trim());
  }

  runSearch(): void {
    this.page = 1;
    this.load();
  }

  clearSearch(): void {
    this.query = '';
    this.page = 1;
    this.search$.next('');
    this.load();
  }

  onFilterChange(): void {
    this.page = 1;
    this.load();
  }

  onPersonChange(): void {
    this.person$.next([this.actorText, this.producerText, this.directorText].map((value) => value.trim()).join('\n'));
  }

  onSortChange(): void {
    if (this.mode === 'discover') {
      this.page = 1;
      this.load();
      return;
    }
    this.items = this.sortLocal(this.sourceItems);
  }

  goPage(delta: number): void {
    const next = this.page + delta;
    if (next < 1 || (this.totalPages > 0 && next > this.totalPages)) {
      return;
    }
    this.page = next;
    this.load();
  }

  openDetail(item: TmdbItem): void {
    if (item.mediaType !== 'movie' && item.mediaType !== 'tv') {
      return;
    }
    this.detailOpen = true;
    this.detailLoading = true;
    this.detailError = '';
    this.detail = null;
    this.trailerSafe = null;
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getTmdbDetail(item.mediaType, item.id, this.lang()).subscribe({
      next: (detail) => {
        this.detailLoading = false;
        if (!detail?.configured || detail.error === 'missing_api_key') {
          this.missingKey = true;
          this.detailError = 'TMDB.MISSING_KEY';
          return;
        }
        if (detail.error === 'invalid_api_key') {
          this.detailError = 'TMDB.ERROR_INVALID_KEY';
          return;
        }
        if (detail.error === 'not_found') {
          this.detailError = 'TMDB.NOT_FOUND';
          return;
        }
        if (detail.error) {
          this.detailError = 'TMDB.ERROR';
          return;
        }
        this.detail = detail;
        this.trailerSafe = this.trailerUrl(detail.trailerKey);
      },
      error: () => {
        this.detailLoading = false;
        this.detailError = 'TMDB.ERROR';
      }
    });
  }

  closeDetail(): void {
    this.detailOpen = false;
    this.detail = null;
    this.detailError = '';
    this.trailerSafe = null;
    this.videoshowOpen = false;
    this.detailSub?.unsubscribe();
  }

  get hasPlayableVideos(): boolean {
    return this.videoSources().length > 0;
  }

  openInVideoshow(): void {
    const sources = this.videoSources();
    if (!sources.length || !this.videoshowModal) {
      return;
    }
    this.trailerSafe = null;
    this.videoshowOpen = true;
    this.videoshowModal.open(sources, this.detail?.title || '', false, 0, 0);
  }

  onVideoshowClosed(): void {
    this.videoshowOpen = false;
    this.trailerSafe = this.trailerUrl(this.detail?.trailerKey);
  }

  trackItem(_index: number, item: TmdbItem): string {
    return item.mediaType + '-' + item.id;
  }

  yearOf(date: string | null | undefined): string {
    if (!date || date.length < 4) {
      return '';
    }
    return date.slice(0, 4);
  }

  scoreClass(vote: number | null | undefined): string {
    if (vote == null) {
      return '';
    }
    if (vote >= 7) {
      return 'is-high';
    }
    if (vote >= 5) {
      return 'is-mid';
    }
    return 'is-low';
  }

  runtimeLabel(minutes: number | null | undefined): string {
    if (!minutes || minutes <= 0) {
      return '';
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours <= 0) {
      return rest + ' min';
    }
    if (rest === 0) {
      return hours + ' h';
    }
    return hours + ' h ' + rest + ' min';
  }

  onPosterError(item: TmdbItem): void {
    item.posterUrl = null;
  }

  get showEmptySearch(): boolean {
    return this.mode === 'search' && !this.query.trim();
  }

  private load(): void {
    this.listSub?.unsubscribe();
    this.listError = '';
    this.missingKey = false;
    if (this.mode === 'search' && !this.query.trim()) {
      this.items = [];
      this.sourceItems = [];
      this.totalPages = 0;
      this.totalResults = 0;
      this.isLoading = false;
      return;
    }
    this.isLoading = true;
    const lang = this.lang();
    const request = this.mode === 'trending'
      ? this.api.getTmdbTrending(this.media, this.window, lang, this.page)
      : this.mode === 'search'
        ? this.api.searchTmdb(this.query.trim(), this.media, lang, this.page)
        : this.api.discoverTmdb({
            media: this.media === 'all' ? 'movie' : this.media,
            genre: this.genre,
            year: this.parsedYear(),
            sort: this.sort,
            actor: this.personQuery(this.actorText),
            producer: this.personQuery(this.producerText),
            director: this.personQuery(this.directorText),
            lang,
            page: this.page
          });
    this.listSub = request.subscribe({
      next: (page) => this.applyPage(page),
      error: () => {
        this.isLoading = false;
        this.items = [];
        this.sourceItems = [];
        this.clearPeople();
        this.listError = 'TMDB.ERROR';
      }
    });
  }

  private applyPage(page: TmdbPage): void {
    this.isLoading = false;
    if (!page?.configured || page.error === 'missing_api_key') {
      this.missingKey = true;
      this.items = [];
      this.sourceItems = [];
      this.clearPeople();
      this.totalPages = 0;
      this.totalResults = 0;
      return;
    }
    if (page.error === 'invalid_api_key') {
      this.items = [];
      this.sourceItems = [];
      this.clearPeople();
      this.listError = 'TMDB.ERROR_INVALID_KEY';
      return;
    }
    if (page.error) {
      this.items = [];
      this.sourceItems = [];
      this.clearPeople();
      this.listError = 'TMDB.ERROR';
      return;
    }
    this.actorName = page.actorName || '';
    this.producerName = page.producerName || '';
    this.directorName = page.directorName || '';
    this.sourceItems = page.items || [];
    this.items = this.sortLocal(this.sourceItems);
    this.page = page.page && page.page > 0 ? page.page : this.page;
    this.totalPages = page.totalPages || 0;
    this.totalResults = page.totalResults || this.items.length;
  }

  private loadGenres(): void {
    const media = this.media === 'all' ? 'movie' : this.media;
    this.genreSub?.unsubscribe();
    this.genreSub = this.api.getTmdbGenres(media, this.lang()).subscribe({
      next: (result) => {
        this.genres = result?.genres || [];
      },
      error: () => {
        this.genres = [];
      }
    });
  }

  private personQuery(value: string): string | null {
    const query = (value || '').trim().replace(/\s+/g, ' ');
    return query.length >= 2 ? query : null;
  }

  private clearPeople(): void {
    this.actorName = '';
    this.producerName = '';
    this.directorName = '';
  }

  private sortLocal(items: TmdbItem[]): TmdbItem[] {
    if (this.mode === 'discover' || this.sort === 'popular' || this.sort === 'revenue') {
      return items;
    }
    const title = (item: TmdbItem) => (item.title || '').toLocaleLowerCase();
    const copy = [...items];
    copy.sort((a, b) => {
      const byTitle = title(a).localeCompare(title(b));
      switch (this.sort) {
        case 'newest': {
          if (!a.date || !b.date) {
            if (!a.date && !b.date) {
              return byTitle;
            }
            return a.date ? -1 : 1;
          }
          return b.date.localeCompare(a.date) || byTitle;
        }
        case 'oldest':
          return (a.date || '9999').localeCompare(b.date || '9999') || byTitle;
        case 'title':
          return byTitle;
        case 'title_desc':
          return title(b).localeCompare(title(a));
        case 'rating':
          return (b.voteAverage ?? -1) - (a.voteAverage ?? -1) || byTitle;
        case 'rating_asc':
          return (a.voteAverage ?? Number.MAX_VALUE) - (b.voteAverage ?? Number.MAX_VALUE) || byTitle;
        case 'votes':
          return (b.voteCount ?? -1) - (a.voteCount ?? -1) || byTitle;
        default:
          return 0;
      }
    });
    return copy;
  }

  private parsedYear(): number | null {
    const year = Number.parseInt(this.yearText, 10);
    if (!Number.isFinite(year) || year < 1870 || year > 2100) {
      return null;
    }
    return year;
  }

  private lang(): string {
    return this.translate.currentLang || this.translate.getDefaultLang() || 'fr';
  }

  private trailerUrl(key: string | null | undefined): SafeResourceUrl | null {
    if (!key || !YT_KEY.test(key)) {
      return null;
    }
    return this.sanitizer.bypassSecurityTrustResourceUrl(
      'https://www.youtube-nocookie.com/embed/' + key
    );
  }

  private videoSources(): VideoshowVideoSource[] {
    const sources: VideoshowVideoSource[] = [];
    const seen = new Set<string>();
    const videos: TmdbVideo[] = this.detail?.videos || [];
    for (const video of videos) {
      const key = (video.key || '').trim();
      if (!YT_KEY.test(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      sources.push({
        youtubeVideoId: key,
        fileName: video.name || video.type || this.detail?.title || ''
      });
    }
    const trailer = (this.detail?.trailerKey || '').trim();
    if (YT_KEY.test(trailer) && !seen.has(trailer)) {
      sources.unshift({ youtubeVideoId: trailer, fileName: this.detail?.title || '' });
    }
    return sources;
  }
}
