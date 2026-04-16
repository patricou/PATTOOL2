import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subscription, timer } from 'rxjs';

import { ApiService } from './api.service';

export interface TickerArticle {
  title: string;
  url: string;
  sourceName: string;
  publishedAt: string;
  /** Original NewsAPI image URL (not yet proxied); may be empty. */
  imageUrl: string;
}

/**
 * Global state for the "News ticker" feature. Toggled from the News page,
 * but rendered by the <app-news-ticker> component injected in AppComponent
 * so the scrolling banner appears on every route.
 *
 * Persistence: the enabled flag is stored in localStorage so the banner
 * survives reloads. Article fetches are also memoized for REFRESH_MS to
 * stay friendly to NewsAPI's 100-requests-per-day free tier.
 */
@Injectable({ providedIn: 'root' })
export class NewsTickerService implements OnDestroy {

  private static readonly STORAGE_KEY = 'pat.news.ticker.enabled';
  /** Refresh cadence (ms) while the ticker is enabled. */
  private static readonly REFRESH_MS = 15 * 60 * 1000;

  /** Same map the News page uses to synthesize /everything queries from a country code. */
  private static readonly COUNTRY_MAP: Record<string, { name: string; language?: string }> = {
    ae: { name: 'United Arab Emirates', language: 'ar' },
    ar: { name: 'Argentina', language: 'es' },
    at: { name: 'Austria', language: 'de' },
    au: { name: 'Australia', language: 'en' },
    be: { name: 'Belgium', language: 'fr' },
    br: { name: 'Brazil', language: 'pt' },
    ca: { name: 'Canada', language: 'en' },
    ch: { name: 'Switzerland', language: 'de' },
    cn: { name: 'China', language: 'zh' },
    co: { name: 'Colombia', language: 'es' },
    de: { name: 'Germany', language: 'de' },
    eg: { name: 'Egypt', language: 'ar' },
    fr: { name: 'France', language: 'fr' },
    gb: { name: 'United Kingdom', language: 'en' },
    hk: { name: 'Hong Kong', language: 'zh' },
    ie: { name: 'Ireland', language: 'en' },
    il: { name: 'Israel', language: 'he' },
    in: { name: 'India', language: 'en' },
    it: { name: 'Italy', language: 'it' },
    jp: { name: 'Japan' },
    kr: { name: 'South Korea' },
    ma: { name: 'Morocco', language: 'ar' },
    mx: { name: 'Mexico', language: 'es' },
    my: { name: 'Malaysia' },
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
    tr: { name: 'Turkey' },
    tw: { name: 'Taiwan', language: 'zh' },
    ua: { name: 'Ukraine' },
    us: { name: 'United States', language: 'en' },
    ve: { name: 'Venezuela', language: 'es' },
    za: { name: 'South Africa', language: 'en' }
  };

  private readonly _enabled$ = new BehaviorSubject<boolean>(this.readEnabled());
  private readonly _articles$ = new BehaviorSubject<TickerArticle[]>([]);
  private readonly _loading$ = new BehaviorSubject<boolean>(false);

  /**
   * True once the user has explicitly toggled the switch at least once
   * (localStorage key present). When false, the server-provided default
   * (from /api/external/news/status) is still allowed to override the
   * initial value.
   */
  private userHasOverridden: boolean = this.hasStoredPreference();

  private refreshSub?: Subscription;

  constructor(private api: ApiService) {
    if (this._enabled$.value) {
      this.startAutoRefresh();
    }
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
  }

  // ---------- Public API ----------

  get enabled$(): Observable<boolean> {
    return this._enabled$.asObservable();
  }

  get articles$(): Observable<TickerArticle[]> {
    return this._articles$.asObservable();
  }

  get loading$(): Observable<boolean> {
    return this._loading$.asObservable();
  }

  get isEnabled(): boolean {
    return this._enabled$.value;
  }

  setEnabled(enabled: boolean): void {
    // User-driven change always wins and locks out the server default.
    this.userHasOverridden = true;
    this.persistEnabled(enabled);
    if (this._enabled$.value === enabled) {
      return;
    }
    this._enabled$.next(enabled);
    if (enabled) {
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
      this._articles$.next([]);
    }
  }

  /**
   * Apply the default value coming from the backend
   * ({@code newsapi.ticker.enabled.default}). This has no effect once the
   * user has touched the switch (localStorage preference exists).
   */
  applyServerDefault(enabled: boolean): void {
    if (this.userHasOverridden) return;
    if (this._enabled$.value === enabled) return;
    this._enabled$.next(enabled);
    if (enabled) {
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
      this._articles$.next([]);
    }
  }

  toggle(): void {
    this.setEnabled(!this._enabled$.value);
  }

  /** Force-refresh the ticker contents (only when enabled). */
  refresh(): void {
    if (!this._enabled$.value) return;
    this.fetchLatest();
  }

  // ---------- Internal ----------

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshSub = timer(0, NewsTickerService.REFRESH_MS).subscribe(() => this.fetchLatest());
  }

  private stopAutoRefresh(): void {
    this.refreshSub?.unsubscribe();
    this.refreshSub = undefined;
  }

  private fetchLatest(): void {
    const { country, language } = this.readUserPrefs();
    this._loading$.next(true);

    // Headlines first: richer "breaking news" flavor for the marquee.
    this.api.getTopHeadlines({
      country,
      pageSize: 24,
      page: 1
    }).subscribe({
      next: (resp) => {
        const articles = this.extractArticles(resp);
        if (articles.length > 0) {
          this._articles$.next(articles);
          this._loading$.next(false);
          return;
        }
        // Empty headlines (common for non-US on the free tier): fall back
        // to /everything with the country name so the user gets something
        // relevant on their ticker instead of an empty bar.
        this.fallbackEverything(country, language);
      },
      error: () => this.fallbackEverything(country, language)
    });
  }

  private fallbackEverything(country: string, language: string): void {
    const entry = NewsTickerService.COUNTRY_MAP[country];
    const q = entry?.name || country.toUpperCase();
    const lang = language || entry?.language || 'en';

    this.api.getEverything({
      q,
      language: lang,
      sortBy: 'publishedAt',
      pageSize: 24,
      page: 1
    }).subscribe({
      next: (resp) => {
        this._articles$.next(this.extractArticles(resp));
        this._loading$.next(false);
      },
      error: () => {
        this._articles$.next([]);
        this._loading$.next(false);
      }
    });
  }

  private extractArticles(resp: any): TickerArticle[] {
    if (!resp || resp.error) return [];
    const list = Array.isArray(resp.articles) ? resp.articles : [];
    return list
      .filter((a: any) => a && a.title && a.url)
      .map((a: any) => ({
        title: String(a.title),
        url: String(a.url),
        sourceName: a?.source?.name ? String(a.source.name) : '',
        publishedAt: a.publishedAt ? String(a.publishedAt) : '',
        imageUrl: a?.urlToImage ? String(a.urlToImage) : ''
      }));
  }

  /**
   * Read the country/language the user picked on the News page so the ticker
   * stays consistent with their browsing preferences. Falls back to FR/fr.
   */
  private readUserPrefs(): { country: string; language: string } {
    try {
      const raw = localStorage.getItem('pat.news.filters.v3');
      if (raw) {
        const saved = JSON.parse(raw);
        const country = typeof saved?.country === 'string' && saved.country ? saved.country : 'fr';
        const language = typeof saved?.language === 'string' && saved.language ? saved.language : 'fr';
        return { country, language };
      }
    } catch {
      // ignore corrupted payloads; fall through to defaults
    }
    return { country: 'fr', language: 'fr' };
  }

  private readEnabled(): boolean {
    try {
      return localStorage.getItem(NewsTickerService.STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private hasStoredPreference(): boolean {
    try {
      return localStorage.getItem(NewsTickerService.STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  private persistEnabled(enabled: boolean): void {
    try {
      localStorage.setItem(NewsTickerService.STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // localStorage may be unavailable (private mode, quota); non-fatal.
    }
  }
}
