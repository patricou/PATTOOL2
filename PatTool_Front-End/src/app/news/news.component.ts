import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService, LangChangeEvent } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { ApiService } from '../services/api.service';
import { NewsTickerService } from '../services/news-ticker.service';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { environment } from '../../environments/environment';

interface NewsSource {
  id: string | null;
  name: string;
  // Extra fields populated by the /sources endpoint (absent on /top-headlines & /everything article.source)
  description?: string;
  url?: string;
  category?: string;
  language?: string;
  country?: string;
}

interface NewsArticle {
  source: NewsSource;
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

interface CountryOption {
  code: string;
  name: string;
}

interface CategoryOption {
  code: string;
  labelKey: string;
  icon: string;
}

type NewsMode = 'headlines' | 'search' | 'sources';

@Component({
  selector: 'app-news',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, NavigationButtonsModule],
  templateUrl: './news.component.html',
  styleUrls: ['./news.component.css']
})
export class NewsComponent implements OnInit, OnDestroy {

  Math = Math;

  // ---------------- UI state ----------------
  mode: NewsMode = 'headlines';
  // Initial hardcoded defaults (used before the backend /status response
  // arrives). The real defaults come from application.properties via
  // {@code newsapi.default.country} and {@code newsapi.default.language}
  // and are applied on first visit (no localStorage) once /status returns.
  country = 'fr';
  category = '';
  language = 'fr';

  /** Server-provided defaults (updated from /status); also used by Reset. */
  private serverDefaultCountry = 'fr';
  private serverDefaultLanguage = 'fr';

  /** True if restoreFilters() found something in localStorage. When false,
   * the /status response is allowed to override country/language. */
  private userHasFilterPrefs = false;
  query = '';
  sortBy: 'publishedAt' | 'relevancy' | 'popularity' = 'publishedAt';
  dateFrom = '';
  dateTo = '';
  page = 1;
  pageSize = 12;
  totalResults = 0;

  articles: NewsArticle[] = [];
  sources: NewsSource[] = [];
  isLoading = false;
  errorMessage = '';
  successMessage = '';
  newsTitle = '';
  apiStatus: any = null;
  isLoadingStatus = false;

  /**
   * When headlines come back empty for a non-US country (a common free-tier
   * quirk on NewsAPI), we transparently fall back to /everything. These two
   * fields track that so the UI can show a friendly banner instead of an
   * empty page, and so we never loop indefinitely.
   */
  fallbackUsed = false;
  fallbackInfo: { countryName: string; flag: string; categoryLabel?: string } | null = null;

  private readonly STORAGE_KEY = 'pat.news.filters.v3';
  private readonly IMAGE_PROXY_BASE = environment.API_URL + 'external/news/image?u=';
  private langChangeSub?: Subscription;
  private search$ = new Subject<void>();
  private searchSub?: Subscription;

  /** Tracks articles whose proxied image failed to load so we render the placeholder instead. */
  private readonly failedImages = new Set<string>();

  // ---------------- Option lists ----------------

  // NewsAPI supported countries for /top-headlines (ISO 3166-1 alpha-2).
  // Keep the list exhaustive but deduplicate with i18n-friendly native names.
  readonly countries: CountryOption[] = [
    { code: '',   name: '—' },
    { code: 'ae', name: 'الإمارات العربية المتحدة' },
    { code: 'ar', name: 'Argentina' },
    { code: 'at', name: 'Österreich' },
    { code: 'au', name: 'Australia' },
    { code: 'be', name: 'Belgique / België' },
    { code: 'bg', name: 'България' },
    { code: 'br', name: 'Brasil' },
    { code: 'ca', name: 'Canada' },
    { code: 'ch', name: 'Schweiz / Suisse' },
    { code: 'cn', name: '中国' },
    { code: 'co', name: 'Colombia' },
    { code: 'cu', name: 'Cuba' },
    { code: 'cz', name: 'Česko' },
    { code: 'de', name: 'Deutschland' },
    { code: 'eg', name: 'مصر' },
    { code: 'fr', name: 'France' },
    { code: 'gb', name: 'United Kingdom' },
    { code: 'gr', name: 'Ελλάδα' },
    { code: 'hk', name: 'Hong Kong' },
    { code: 'hu', name: 'Magyarország' },
    { code: 'id', name: 'Indonesia' },
    { code: 'ie', name: 'Ireland' },
    { code: 'il', name: 'ישראל' },
    { code: 'in', name: 'भारत' },
    { code: 'it', name: 'Italia' },
    { code: 'jp', name: '日本' },
    { code: 'kr', name: '대한민국' },
    { code: 'lt', name: 'Lietuva' },
    { code: 'lv', name: 'Latvija' },
    { code: 'ma', name: 'المغرب' },
    { code: 'mx', name: 'México' },
    { code: 'my', name: 'Malaysia' },
    { code: 'ng', name: 'Nigeria' },
    { code: 'nl', name: 'Nederland' },
    { code: 'no', name: 'Norge' },
    { code: 'nz', name: 'New Zealand' },
    { code: 'ph', name: 'Philippines' },
    { code: 'pl', name: 'Polska' },
    { code: 'pt', name: 'Portugal' },
    { code: 'ro', name: 'România' },
    { code: 'rs', name: 'Srbija' },
    { code: 'ru', name: 'Россия' },
    { code: 'sa', name: 'السعودية' },
    { code: 'se', name: 'Sverige' },
    { code: 'sg', name: 'Singapore' },
    { code: 'si', name: 'Slovenija' },
    { code: 'sk', name: 'Slovensko' },
    { code: 'th', name: 'ไทย' },
    { code: 'tr', name: 'Türkiye' },
    { code: 'tw', name: '台灣' },
    { code: 'ua', name: 'Україна' },
    { code: 'us', name: 'United States' },
    { code: 've', name: 'Venezuela' },
    { code: 'za', name: 'South Africa' }
  ];

  readonly categories: CategoryOption[] = [
    { code: '',               labelKey: 'NEWS.CATEGORY_ALL',           icon: 'fa-globe' },
    { code: 'business',       labelKey: 'NEWS.CATEGORY_BUSINESS',      icon: 'fa-briefcase' },
    { code: 'entertainment',  labelKey: 'NEWS.CATEGORY_ENTERTAINMENT', icon: 'fa-film' },
    { code: 'general',        labelKey: 'NEWS.CATEGORY_GENERAL',       icon: 'fa-newspaper-o' },
    { code: 'health',         labelKey: 'NEWS.CATEGORY_HEALTH',        icon: 'fa-heartbeat' },
    { code: 'science',        labelKey: 'NEWS.CATEGORY_SCIENCE',       icon: 'fa-flask' },
    { code: 'sports',         labelKey: 'NEWS.CATEGORY_SPORTS',        icon: 'fa-futbol-o' },
    { code: 'technology',     labelKey: 'NEWS.CATEGORY_TECHNOLOGY',    icon: 'fa-laptop' }
  ];

  /**
   * Country-code → (English country name, preferred NewsAPI /everything
   * language) map used by the empty-headlines fallback. English names are
   * better search queries on /everything than native names (which may contain
   * slashes, non-Latin scripts, etc.). Language is left undefined when NewsAPI
   * does not cover that market's native language; /everything then returns
   * multilingual results for that country name.
   */
  private readonly fallbackQueryMap: Record<string, { name: string; language?: string }> = {
    ae: { name: 'United Arab Emirates', language: 'ar' },
    ar: { name: 'Argentina', language: 'es' },
    at: { name: 'Austria', language: 'de' },
    au: { name: 'Australia', language: 'en' },
    be: { name: 'Belgium', language: 'fr' },
    bg: { name: 'Bulgaria' },
    br: { name: 'Brazil', language: 'pt' },
    ca: { name: 'Canada', language: 'en' },
    ch: { name: 'Switzerland', language: 'de' },
    cn: { name: 'China', language: 'zh' },
    co: { name: 'Colombia', language: 'es' },
    cu: { name: 'Cuba', language: 'es' },
    cz: { name: 'Czechia' },
    de: { name: 'Germany', language: 'de' },
    eg: { name: 'Egypt', language: 'ar' },
    fr: { name: 'France', language: 'fr' },
    gb: { name: 'United Kingdom', language: 'en' },
    gr: { name: 'Greece' },
    hk: { name: 'Hong Kong', language: 'zh' },
    hu: { name: 'Hungary' },
    id: { name: 'Indonesia' },
    ie: { name: 'Ireland', language: 'en' },
    il: { name: 'Israel', language: 'he' },
    in: { name: 'India', language: 'en' },
    it: { name: 'Italy', language: 'it' },
    jp: { name: 'Japan' },
    kr: { name: 'South Korea' },
    lt: { name: 'Lithuania' },
    lv: { name: 'Latvia' },
    ma: { name: 'Morocco', language: 'ar' },
    mx: { name: 'Mexico', language: 'es' },
    my: { name: 'Malaysia', language: 'en' },
    ng: { name: 'Nigeria', language: 'en' },
    nl: { name: 'Netherlands', language: 'nl' },
    no: { name: 'Norway', language: 'no' },
    nz: { name: 'New Zealand', language: 'en' },
    ph: { name: 'Philippines', language: 'en' },
    pl: { name: 'Poland' },
    pt: { name: 'Portugal', language: 'pt' },
    ro: { name: 'Romania' },
    rs: { name: 'Serbia' },
    ru: { name: 'Russia', language: 'ru' },
    sa: { name: 'Saudi Arabia', language: 'ar' },
    se: { name: 'Sweden', language: 'sv' },
    sg: { name: 'Singapore', language: 'en' },
    si: { name: 'Slovenia' },
    sk: { name: 'Slovakia' },
    th: { name: 'Thailand' },
    tr: { name: 'Türkiye' },
    tw: { name: 'Taiwan', language: 'zh' },
    ua: { name: 'Ukraine', language: 'ru' },
    us: { name: 'United States', language: 'en' },
    ve: { name: 'Venezuela', language: 'es' },
    za: { name: 'South Africa', language: 'en' }
  };

  // NewsAPI /everything supported languages.
  readonly languages: CountryOption[] = [
    { code: '',   name: '—' },
    { code: 'ar', name: 'العربية' },
    { code: 'de', name: 'Deutsch' },
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' },
    { code: 'fr', name: 'Français' },
    { code: 'he', name: 'עברית' },
    { code: 'it', name: 'Italiano' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'no', name: 'Norsk' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'sv', name: 'Svenska' },
    { code: 'ud', name: 'اردو' },
    { code: 'zh', name: '中文' }
  ];

  /** Mirror of NewsTickerService.enabled$ for two-way binding with the UI switch. */
  public tickerEnabled = false;
  private tickerSub?: Subscription;

  /**
   * Collapse state of the whole top toolbar (mode toggle + status + filters).
   * Always starts collapsed on page load, regardless of the user's last
   * choice (by explicit product decision). The user can still expand it
   * with the button for the duration of the current session.
   */
  public filtersCollapsed: boolean = true;

  constructor(
    private apiService: ApiService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private newsTicker: NewsTickerService
  ) {}

  // ---------------- Lifecycle ----------------

  ngOnInit(): void {
    this.restoreFilters();
    this.updateTitle();
    this.loadStatus();

    this.searchSub = this.search$.pipe(debounceTime(350)).subscribe(() => this.runQuery());

    this.langChangeSub = this.translate.onLangChange.subscribe((_: LangChangeEvent) => {
      this.updateTitle();
    });

    this.tickerSub = this.newsTicker.enabled$.subscribe((v) => {
      this.tickerEnabled = v;
      this.cdr.markForCheck();
    });

    this.runQuery();
  }

  ngOnDestroy(): void {
    this.langChangeSub?.unsubscribe();
    this.searchSub?.unsubscribe();
    this.tickerSub?.unsubscribe();
  }

  // ---------------- Ticker toggle ----------------

  /** Flip the global news-ticker banner on/off (visible on every page). */
  onToggleTicker(enabled: boolean): void {
    this.newsTicker.setEnabled(enabled);
  }

  // ---------------- Filters collapse toggle ----------------

  toggleFiltersCollapsed(): void {
    this.filtersCollapsed = !this.filtersCollapsed;
    // No persistence: the section must always start collapsed on page load.
  }

  /**
   * Reset every filter to its safe default. Used by the "Reset" button so
   * the user can instantly recover from an over-constrained state that
   * returns no articles (e.g. conflicting query + language + country).
   */
  resetFilters(): void {
    this.mode = 'headlines';
    this.country = this.serverDefaultCountry || 'fr';
    this.category = '';
    this.language = this.serverDefaultLanguage || 'fr';
    this.query = '';
    this.sortBy = 'publishedAt';
    this.dateFrom = '';
    this.dateTo = '';
    this.page = 1;
    this.fallbackUsed = false;
    this.fallbackInfo = null;
    this.errorMessage = '';
    this.successMessage = '';
    this.persistFilters();
    this.updateTitle();
    this.runQuery();
  }

  // ---------------- User actions ----------------

  setMode(mode: NewsMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.page = 1;
    this.articles = [];
    this.sources = [];
    this.totalResults = 0;
    this.errorMessage = '';
    this.updateTitle();
    this.persistFilters();
    this.runQuery();
  }

  setCategory(code: string): void {
    this.category = code;
    this.page = 1;
    this.updateTitle();
    this.persistFilters();
    this.runQuery();
  }

  onFilterChange(): void {
    this.page = 1;
    this.updateTitle();
    this.persistFilters();
    this.search$.next();
  }

  onSearchInputChange(): void {
    this.page = 1;
    this.persistFilters();
    if (this.mode === 'search') {
      const hasQuery = this.query.trim().length >= 2;
      const hasCountry = !!this.country;
      if (!hasQuery && !hasCountry) {
        this.articles = [];
        this.totalResults = 0;
        this.errorMessage = '';
        return;
      }
    }
    this.search$.next();
  }

  goToPage(newPage: number): void {
    if (newPage < 1) return;
    const totalPages = this.totalPages;
    if (totalPages > 0 && newPage > totalPages) return;
    this.page = newPage;
    this.runQuery();
    // Scroll to top of results for nicer UX.
    setTimeout(() => {
      const el = document.querySelector('.news-results');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  get totalPages(): number {
    if (!this.totalResults || this.pageSize <= 0) return 0;
    // NewsAPI developer plan caps pagination at 100 results total.
    const capped = Math.min(this.totalResults, 100);
    return Math.ceil(capped / this.pageSize);
  }

  openArticle(article: NewsArticle, event?: MouseEvent): void {
    if (event) event.preventDefault();
    if (article?.url) {
      window.open(article.url, '_blank', 'noopener,noreferrer');
    }
  }

  async shareArticle(article: NewsArticle, event?: MouseEvent): Promise<void> {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    if (!article) return;
    const title = article.title || this.translate.instant('NEWS.PAGE_TITLE');
    const text = `${article.title}\n${article.source?.name ?? ''}\n${article.url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title, text, url: article.url });
        this.flashSuccess(this.translate.instant('NEWS.SHARED') || 'Shared');
        return;
      }
    } catch (_) { /* fall through to clipboard */ }
    await this.copyToClipboard(article.url || text);
  }

  async copyLink(article: NewsArticle, event?: MouseEvent): Promise<void> {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    if (article?.url) await this.copyToClipboard(article.url);
  }

  refreshAll(): void {
    this.loadStatus();
    this.runQuery();
  }

  /**
   * Record an article whose proxied image just failed to load (404, unsupported
   * format, etc.) so the template renders the colored placeholder instead.
   */
  onImgError(article: NewsArticle): void {
    const key = this.articleKey(article);
    if (!this.failedImages.has(key)) {
      this.failedImages.add(key);
      this.cdr.detectChanges();
    }
  }

  /**
   * Returns true when we can attempt to render the article's real image.
   * Cards where {@code urlToImage} is null, or whose image has already errored
   * out, fall back to {@link getPlaceholderGradient}.
   */
  shouldShowImage(article: NewsArticle): boolean {
    if (!article?.urlToImage) return false;
    return !this.failedImages.has(this.articleKey(article));
  }

  /**
   * Build the same-origin proxied URL for a NewsAPI image so we can bypass
   * mixed-content blocks and Referer-based hotlink protection.
   */
  getProxiedImageUrl(rawUrl: string): string {
    return this.IMAGE_PROXY_BASE + encodeURIComponent(rawUrl);
  }

  /**
   * Deterministic gradient derived from the source name so the placeholder is
   * visually unique per publisher but stable across re-renders.
   */
  getPlaceholderGradient(article: NewsArticle): string {
    const seed = article?.source?.name || article?.title || 'News';
    const hue = this.hashString(seed) % 360;
    const hue2 = (hue + 35) % 360;
    return `linear-gradient(135deg, hsl(${hue}, 55%, 48%) 0%, hsl(${hue2}, 60%, 32%) 100%)`;
  }

  /** 1–2 character initials for the placeholder overlay. */
  getPlaceholderInitials(article: NewsArticle): string {
    const name = article?.source?.name || article?.title || '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    const initials = parts.map(p => p.charAt(0)).join('').toUpperCase();
    return initials || '?';
  }

  /** Font-Awesome icon shown on the placeholder: category-derived when possible. */
  getPlaceholderIcon(article: NewsArticle): string {
    if (this.mode === 'headlines' && this.category) {
      const match = this.categories.find(c => c.code === this.category);
      if (match && match.code) return match.icon;
    }
    return 'fa-newspaper-o';
  }

  private articleKey(article: NewsArticle): string {
    return article?.url || article?.title || '';
  }

  private hashString(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  // ---------------- Data fetching ----------------

  private runQuery(): void {
    this.errorMessage = '';
    this.successMessage = '';
    this.fallbackUsed = false;
    this.fallbackInfo = null;
    this.isLoading = true;

    if (this.mode === 'sources') {
      this.fetchSources();
      return;
    }
    if (this.mode === 'search') {
      this.fetchEverything();
      return;
    }
    this.fetchHeadlines();
  }

  private fetchHeadlines(): void {
    this.apiService.getTopHeadlines({
      country: this.country || undefined,
      category: this.category || undefined,
      q: this.query || undefined,
      pageSize: this.pageSize,
      page: this.page
    }).subscribe({
      next: (resp) => this.handleArticleResponse(resp),
      error: (err) => this.handleError(err)
    });
  }

  private fetchEverything(): void {
    const userQ = (this.query || '').trim();
    let effectiveQ = userQ;
    let effectiveLang: string | undefined = this.language || undefined;

    // NewsAPI's /everything endpoint has no native "country" filter.
    // Behaviour:
    //   - If the user typed a query, honor their intent verbatim (do not
    //     AND it with the country name, which used to silently kill the
    //     result set, e.g. "Liban France" returned 0 articles).
    //   - If the query is empty but a country is selected, use the country
    //     name as the query so they still see something relevant.
    //   - In both cases, derive a default language from the country when
    //     the user has not explicitly picked one.
    if (this.country) {
      const entry = this.fallbackQueryMap[this.country] || { name: this.country.toUpperCase() };
      if (!userQ) {
        effectiveQ = entry.name;
      }
      if (!effectiveLang && entry.language) {
        effectiveLang = entry.language;
      }
    }

    if (!effectiveQ) {
      this.articles = [];
      this.totalResults = 0;
      this.isLoading = false;
      this.cdr.detectChanges();
      return;
    }

    // Clamp date range to NewsAPI's free-tier window (~1 month) and
    // normalize the datetime-local values (YYYY-MM-DDTHH:MM) to the full
    // ISO-8601 shape NewsAPI expects (YYYY-MM-DDTHH:MM:SS). Stale dates
    // from a previous session used to silently kill the result set.
    const { from, to } = this.getEffectiveDateRange();

    this.apiService.getEverything({
      q: effectiveQ,
      language: effectiveLang,
      from,
      to,
      sortBy: this.sortBy,
      pageSize: this.pageSize,
      page: this.page
    }).subscribe({
      next: (resp) => this.handleArticleResponse(resp),
      error: (err) => this.handleError(err)
    });
  }

  /**
   * Turn {@code dateFrom}/{@code dateTo} ("YYYY-MM-DDTHH:MM") into values
   * safe to send to NewsAPI: full ISO-8601, clamped to the free-tier's
   * ~30-day window, and stripped entirely when bogus.
   */
  private getEffectiveDateRange(): { from?: string; to?: string } {
    const now = new Date();
    const earliest = new Date(now);
    earliest.setDate(earliest.getDate() - 29);
    const toIso = (d: Date) => d.toISOString().split('.')[0]; // drop ms

    const parse = (raw: string): Date | undefined => {
      if (!raw) return undefined;
      const d = new Date(raw.length === 16 ? raw + ':00' : raw);
      return isNaN(d.getTime()) ? undefined : d;
    };

    let from = parse(this.dateFrom);
    let to = parse(this.dateTo);

    if (from && from < earliest) from = earliest;
    if (from && from > now)      from = undefined;
    if (to   && to   > now)      to   = undefined;
    if (from && to && from > to) { const t = from; from = to; to = t; }

    return {
      from: from ? toIso(from) : undefined,
      to:   to   ? toIso(to)   : undefined
    };
  }

  private fetchSources(): void {
    this.apiService.getNewsSources({
      country: this.country || undefined,
      category: this.category || undefined,
      language: this.language || undefined
    }).subscribe({
      next: (resp) => {
        this.isLoading = false;
        if (resp?.error) {
          this.errorMessage = resp.error;
          this.sources = [];
        } else {
          this.sources = Array.isArray(resp?.sources) ? resp.sources : [];
        }
        this.cdr.detectChanges();
      },
      error: (err) => this.handleError(err)
    });
  }

  private handleArticleResponse(resp: any): void {
    this.failedImages.clear();
    if (!resp || resp.error) {
      this.isLoading = false;
      this.errorMessage = this.formatApiError(resp);
      this.articles = [];
      this.totalResults = 0;
      this.cdr.detectChanges();
      return;
    }

    const articles: NewsArticle[] = Array.isArray(resp.articles) ? resp.articles : [];
    const total: number = typeof resp.totalResults === 'number' ? resp.totalResults : articles.length;

    // Free-tier fallback: /top-headlines with a non-US country filter often
    // returns {status:ok, totalResults:0}. In that case transparently re-query
    // /everything with the country name so the user still sees something.
    if (this.mode === 'headlines'
        && articles.length === 0
        && !!this.country
        && !this.fallbackUsed) {
      this.runHeadlinesFallback();
      return;
    }

    this.isLoading = false;
    this.articles = articles;
    this.totalResults = total;
    this.cdr.detectChanges();
  }

  /**
   * Called when top-headlines returns 0 articles for the selected country:
   * we re-query /everything with the English country name (and the selected
   * category translated to a search term), keeping the banner flagged so the
   * UI makes clear this is a best-effort fallback, not a top-headlines feed.
   */
  private runHeadlinesFallback(): void {
    const entry = this.fallbackQueryMap[this.country] || { name: this.country.toUpperCase() };
    const countryName = entry.name;
    const categoryLabelKey = this.categories.find(c => c.code === this.category)?.labelKey;
    const categoryLabel = categoryLabelKey && this.category ? this.translate.instant(categoryLabelKey) : '';
    const userQ = (this.query || '').trim();

    // Build the fallback query: a user-typed term (e.g. "Liban") takes
    // precedence so /everything actually looks for what they asked for,
    // instead of silently returning generic country news. Otherwise we
    // fall back to country (+ optional category label).
    let q: string;
    if (userQ) {
      q = userQ;
    } else if (this.category && categoryLabel) {
      q = `${countryName} ${categoryLabel}`.trim();
    } else {
      q = countryName;
    }

    this.fallbackUsed = true;
    this.fallbackInfo = {
      countryName,
      flag: this.getCountryFlag(this.country),
      categoryLabel: categoryLabel || undefined
    };
    this.isLoading = true;

    this.apiService.getEverything({
      q,
      language: entry.language,
      sortBy: 'publishedAt',
      pageSize: this.pageSize,
      page: this.page
    }).subscribe({
      next: (resp) => this.handleArticleResponse(resp),
      error: (err) => this.handleError(err)
    });
  }

  private handleError(err: any): void {
    this.isLoading = false;
    this.errorMessage = `${this.translate.instant('NEWS.ERROR_LOADING')}: ${err?.error?.message || err?.message || 'Unknown error'}`;
    this.articles = [];
    this.totalResults = 0;
    this.cdr.detectChanges();
  }

  /**
   * Build a user-friendly error message from a NewsAPI proxy response.
   * Our backend surfaces provider errors as
   * {@code { error: "NewsAPI HTTP 400: Bad Request", providerMessage: "{...}" }},
   * where {@code providerMessage} is the raw JSON body NewsAPI returned.
   * We try to unwrap the {@code message} field from it for a clean UX.
   */
  private formatApiError(resp: any): string {
    const base = resp?.error || this.translate.instant('NEWS.ERROR_LOADING');
    const providerRaw = resp?.providerMessage;
    if (!providerRaw) return base;
    try {
      const parsed = typeof providerRaw === 'string' ? JSON.parse(providerRaw) : providerRaw;
      if (parsed && typeof parsed.message === 'string' && parsed.message) {
        return `${base} — ${parsed.message}`;
      }
    } catch (_) { /* not JSON; ignore */ }
    return base;
  }

  private loadStatus(): void {
    this.isLoadingStatus = true;
    this.apiService.getNewsApiStatus().subscribe({
      next: (status) => {
        this.apiStatus = status;
        this.isLoadingStatus = false;
        // Let the backend choose the default ticker state for first-time
        // visitors (newsapi.ticker.enabled.default). Ignored once the user
        // has toggled the switch at least once.
        if (status && typeof status.tickerEnabledDefault === 'boolean') {
          this.newsTicker.applyServerDefault(status.tickerEnabledDefault);
        }
        // Capture server-provided default country / language (from
        // application.properties) so the Reset button and first-visit init
        // both honor them.
        let countryChanged = false;
        let languageChanged = false;
        if (status && typeof status.defaultCountry === 'string' && status.defaultCountry) {
          this.serverDefaultCountry = status.defaultCountry;
          if (!this.userHasFilterPrefs && this.country !== status.defaultCountry) {
            this.country = status.defaultCountry;
            countryChanged = true;
          }
        }
        if (status && typeof status.defaultLanguage === 'string' && status.defaultLanguage) {
          this.serverDefaultLanguage = status.defaultLanguage;
          if (!this.userHasFilterPrefs && this.language !== status.defaultLanguage) {
            this.language = status.defaultLanguage;
            languageChanged = true;
          }
        }
        if (countryChanged || languageChanged) {
          this.updateTitle();
          this.runQuery();
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.apiStatus = { service: 'NewsAPI', status: 'unavailable' };
        this.isLoadingStatus = false;
        this.cdr.detectChanges();
      }
    });
  }

  // ---------------- Helpers ----------------

  getCountryFlag(code: string): string {
    if (!code || code.length !== 2) return '';
    const cp = code.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0));
    return String.fromCodePoint(...cp);
  }

  getCountryName(code: string): string {
    const c = this.countries.find(x => x.code === code);
    return c ? c.name : code.toUpperCase();
  }

  formatRelativeTime(isoDate: string | null | undefined): string {
    if (!isoDate) return '';
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return '';
    const diffMs = Date.now() - date.getTime();
    const diffSec = Math.round(diffMs / 1000);
    if (diffSec < 0) return date.toLocaleString(this.translate.currentLang || undefined);
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
      ['year', 60 * 60 * 24 * 365],
      ['month', 60 * 60 * 24 * 30],
      ['day', 60 * 60 * 24],
      ['hour', 60 * 60],
      ['minute', 60],
      ['second', 1]
    ];
    try {
      const rtf = new Intl.RelativeTimeFormat(this.translate.currentLang || 'en', { numeric: 'auto' });
      for (const [unit, secInUnit] of units) {
        if (Math.abs(diffSec) >= secInUnit || unit === 'second') {
          const value = -Math.round(diffSec / secInUnit);
          return rtf.format(value, unit);
        }
      }
    } catch (_) { /* fall through */ }
    return date.toLocaleString(this.translate.currentLang || undefined);
  }

  formatAbsoluteTime(isoDate: string | null | undefined): string {
    if (!isoDate) return '';
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString(this.translate.currentLang || undefined, {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  private updateTitle(): void {
    const base = this.translate.instant('NEWS.PAGE_TITLE');
    const parts: string[] = [base];
    if (this.mode === 'headlines') {
      const cat = this.category
        ? this.translate.instant(this.categories.find(c => c.code === this.category)?.labelKey || '')
        : '';
      const country = this.country ? `${this.getCountryFlag(this.country)} ${this.getCountryName(this.country)}` : '';
      if (cat) parts.push(cat);
      if (country) parts.push(country);
    } else if (this.mode === 'search') {
      parts.push(this.translate.instant('NEWS.MODE_SEARCH'));
      if (this.query) parts.push(`"${this.query}"`);
    } else {
      parts.push(this.translate.instant('NEWS.MODE_SOURCES'));
    }
    this.newsTitle = parts.join(' — ');
  }

  private persistFilters(): void {
    try {
      const payload = {
        mode: this.mode, country: this.country, category: this.category,
        language: this.language, query: this.query, sortBy: this.sortBy,
        dateFrom: this.dateFrom, dateTo: this.dateTo, pageSize: this.pageSize
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
    } catch (_) { /* localStorage may be unavailable (private mode) */ }
  }

  /**
   * Accepts legacy "YYYY-MM-DD" values saved in localStorage (before we
   * switched the input type from "date" to "datetime-local") and pads them
   * with a midnight time so the input widget displays them correctly.
   */
  private normalizeDateTimeLocal(value: string): string {
    if (!value) return '';
    // Already in datetime-local format: "YYYY-MM-DDTHH:mm" or longer.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00`;
    return value; // unknown shape; let the browser ignore it
  }

  private restoreFilters(): void {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      if (saved.mode === 'headlines' || saved.mode === 'search' || saved.mode === 'sources') this.mode = saved.mode;
      if (typeof saved.country === 'string') this.country = saved.country;
      if (typeof saved.category === 'string') this.category = saved.category;
      if (typeof saved.language === 'string') this.language = saved.language;
      if (typeof saved.query === 'string') this.query = saved.query;
      if (saved.sortBy === 'publishedAt' || saved.sortBy === 'relevancy' || saved.sortBy === 'popularity') this.sortBy = saved.sortBy;
      if (typeof saved.dateFrom === 'string') this.dateFrom = this.normalizeDateTimeLocal(saved.dateFrom);
      if (typeof saved.dateTo === 'string') this.dateTo = this.normalizeDateTimeLocal(saved.dateTo);
      if (typeof saved.pageSize === 'number' && saved.pageSize > 0 && saved.pageSize <= 100) this.pageSize = saved.pageSize;
      this.userHasFilterPrefs = true;
    } catch (_) { /* corrupted; ignore */ }
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        this.flashSuccess(this.translate.instant('NEWS.LINK_COPIED') || 'Link copied');
        return;
      }
    } catch (_) { /* fall through */ }
    try { window.prompt(this.translate.instant('NEWS.COPY_MANUALLY') || 'Copy manually:', text); } catch (_) {}
  }

  private flashSuccess(msg: string): void {
    this.successMessage = msg;
    setTimeout(() => {
      this.successMessage = '';
      this.cdr.detectChanges();
    }, 2500);
    this.cdr.detectChanges();
  }
}
