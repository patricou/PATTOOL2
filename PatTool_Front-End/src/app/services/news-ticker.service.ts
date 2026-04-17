import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, Subscription, timer } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

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
 * Snapshot of the News page filters (read from localStorage) that drive
 * which articles the ticker requests. Kept in one object so the fetch
 * pipeline takes a single argument and adding new dimensions later
 * (e.g. sortBy) doesn't ripple through every call site.
 */
interface UserPrefs {
  country: string;
  language: string;
  category: string;
  query: string;
  provider: 'newsdata' | 'newsapi';
  userTab: 'headlines' | 'search' | 'sources';
}

/**
 * Global state for the "News ticker" feature. Toggled from the News page,
 * but rendered by the <app-news-ticker> component injected in AppComponent
 * so the scrolling banner appears on every route.
 *
 * Persistence policy: the ticker is DELIBERATELY NOT persisted across page
 * reloads. It always starts OFF so that a fresh page load never triggers an
 * automatic NewsAPI call (the free plan is capped at 100 requests/day, and
 * the user might just be browsing unrelated pages). The user re-enables it
 * per-session via the switch on the News page.
 */
@Injectable({ providedIn: 'root' })
export class NewsTickerService implements OnDestroy {
  /**
   * Refresh cadence (ms) while the ticker is enabled. The free NewsAPI
   * plan is capped at 100 requests/day, so we refresh only once an hour
   * (24 requests/day from the ticker worst-case, still room for the News
   * page + /status probe + manual refreshes).
   */
  private static readonly REFRESH_MS = 60 * 60 * 1000;
  /**
   * Minimum delay between two real network fetches (ms). Protects against
   * thrashing when enable/disable toggles rapidly or multiple subscribers
   * trigger refreshes back-to-back: we serve the cached articles instead.
   */
  private static readonly MIN_FETCH_GAP_MS = 2 * 60 * 1000;
  /**
   * Same pageSize the News page uses for its first page, so both end up
   * hitting the SAME backend cache entry (shared /top-headlines URL).
   * NewsAPI counts unique URL per request; aligning this saves a request.
   */
  private static readonly PAGE_SIZE = 12;

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

  private readonly _enabled$ = new BehaviorSubject<boolean>(false);
  private readonly _articles$ = new BehaviorSubject<TickerArticle[]>([]);
  private readonly _loading$ = new BehaviorSubject<boolean>(false);

  /**
   * True once the user has explicitly toggled the switch at least once
   * in THIS session. Guards against a late-arriving server default
   * silently flipping a switch the user just turned off.
   */
  private userHasOverridden = false;

  private refreshSub?: Subscription;
  /** Wall-clock timestamp (ms) of the last successful or failed network call. */
  private lastFetchAt: number = 0;

  /**
   * Coalesces rapid filter changes (typing, toggling country, switching
   * provider) into a single refresh so the user sees the ticker update
   * without us firing one request per keystroke.
   */
  private readonly filtersChanged$ = new Subject<void>();
  private filtersSub?: Subscription;

  constructor(private api: ApiService) {
    // Ticker starts OFF on every page load — intentional. No auto-fetch here.
    // See class-level comment for rationale (quota protection).
    this.clearLegacyPreference();
    this.filtersSub = this.filtersChanged$.pipe(debounceTime(500)).subscribe(() => {
      // Only refetch when the ticker is actually visible — no point
      // burning quota to update a bar the user isn't looking at.
      if (this._enabled$.value) {
        this.fetchLatest(true);
      }
    });
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.filtersSub?.unsubscribe();
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
    // No persistence: next reload starts OFF again (by design, quota-safe).
    this.userHasOverridden = true;
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
   * Historically applied the backend's {@code newsapi.ticker.enabled.default}
   * on first boot. Kept for API compatibility with callers, but is now a
   * no-op: the ticker is always OFF on page load and only the user's
   * explicit toggle turns it on (per-session). This prevents a fresh page
   * load from ever triggering an automatic NewsAPI call via the ticker.
   */
  applyServerDefault(_enabled: boolean): void {
    /* intentionally empty — see class-level comment */
  }

  toggle(): void {
    this.setEnabled(!this._enabled$.value);
  }

  /** Force-refresh the ticker contents (only when enabled). */
  refresh(): void {
    if (!this._enabled$.value) return;
    this.fetchLatest(true);
  }

  /**
   * Called by the News page whenever the user tweaks a filter
   * (country, language, category, provider, query, tab). Debounced
   * internally so back-to-back changes cost one refresh at most.
   * No-op when the ticker is off — the next time the user turns it on,
   * {@link #fetchLatest} will naturally pick up the fresh filters.
   */
  notifyFiltersChanged(): void {
    this.filtersChanged$.next();
  }

  // ---------- Internal ----------

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshSub = timer(0, NewsTickerService.REFRESH_MS).subscribe(() => this.fetchLatest(false));
  }

  private stopAutoRefresh(): void {
    this.refreshSub?.unsubscribe();
    this.refreshSub = undefined;
  }

  /**
   * Hit NewsAPI (through the backend proxy) only when worth it.
   *
   * Guards:
   *   - If we already have articles AND the last fetch is more recent
   *     than {@link MIN_FETCH_GAP_MS}, reuse them (no network call).
   *   - Forced=true bypasses the gap guard (for explicit user refresh),
   *     but the backend TTL cache still de-duplicates.
   */
  private fetchLatest(forced: boolean): void {
    const now = Date.now();
    const haveArticles = this._articles$.value.length > 0;
    const withinCooldown = (now - this.lastFetchAt) < NewsTickerService.MIN_FETCH_GAP_MS;
    if (!forced && haveArticles && withinCooldown) {
      return; // serve cached articles; save a quota slot
    }
    this.lastFetchAt = now;

    const prefs = this.readUserPrefs();
    this._loading$.next(true);

    // If the user is explicitly in "search" mode with a real query, or
    // on a virtual country (one we don't support for /top-headlines),
    // skip the headlines endpoint entirely and go straight to the
    // /everything-style query — the headlines call would return empty
    // and burn a quota slot for nothing.
    const query = prefs.query.trim();
    const isVirtualCountry = !NewsTickerService.COUNTRY_MAP[prefs.country];
    if ((prefs.userTab === 'search' && query.length >= 2) || isVirtualCountry) {
      this.fallbackEverything(prefs);
      return;
    }

    // Headlines first: richer "breaking news" flavor for the marquee.
    this.api.getTopHeadlines({
      country: prefs.country,
      category: prefs.category || undefined,
      pageSize: NewsTickerService.PAGE_SIZE,
      page: 1,
      provider: prefs.provider
    }).subscribe({
      next: (resp) => {
        const articles = this.extractArticles(resp);
        if (articles.length > 0) {
          this._articles$.next(articles);
          this._loading$.next(false);
          return;
        }
        // Empty headlines (common for non-US on the NewsAPI free tier):
        // fall back to /everything with the country name so the user
        // gets something relevant on their ticker instead of an empty bar.
        this.fallbackEverything(prefs);
      },
      error: () => this.fallbackEverything(prefs)
    });
  }

  private fallbackEverything(prefs: UserPrefs): void {
    const entry = NewsTickerService.COUNTRY_MAP[prefs.country];
    // Prefer the user's explicit query over a synthetic country name
    // so the ticker truly mirrors what's displayed on the News page.
    const typed = prefs.query.trim();
    const q = typed.length >= 2
      ? typed
      : (prefs.category
          ? `${entry?.name || prefs.country.toUpperCase()} ${prefs.category}`
          : (entry?.name || prefs.country.toUpperCase()));
    const lang = prefs.language || entry?.language || 'en';

    this.api.getEverything({
      q,
      language: lang,
      sortBy: 'publishedAt',
      pageSize: NewsTickerService.PAGE_SIZE,
      page: 1,
      provider: prefs.provider
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
   * Read the filters the user picked on the News page so the ticker
   * stays in sync with their browsing preferences (country, language,
   * category, provider, search query, active tab). Falls back to FR/fr
   * on NewsData.io if nothing has been saved yet.
   *
   * IMPORTANT: this key must match {@code STORAGE_KEY} in
   * {@code news.component.ts}. When the News page bumps its version,
   * bump it here too — otherwise the ticker silently keeps showing
   * defaults while the UI shows the user's real selection.
   */
  private readUserPrefs(): UserPrefs {
    const defaults: UserPrefs = {
      country: 'fr',
      language: 'fr',
      category: '',
      query: '',
      provider: 'newsdata',
      userTab: 'headlines'
    };
    try {
      const raw = localStorage.getItem('pat.news.filters.v5');
      if (!raw) return defaults;
      const saved = JSON.parse(raw) || {};
      return {
        country: typeof saved.country === 'string' && saved.country ? saved.country : defaults.country,
        language: typeof saved.language === 'string' && saved.language ? saved.language : defaults.language,
        category: typeof saved.category === 'string' ? saved.category : '',
        query: typeof saved.query === 'string' ? saved.query : '',
        provider: saved.provider === 'newsapi' ? 'newsapi' : 'newsdata',
        userTab: (saved.userTab === 'search' || saved.userTab === 'sources' || saved.userTab === 'headlines')
          ? saved.userTab
          : 'headlines'
      };
    } catch {
      // ignore corrupted payloads; fall through to defaults
      return defaults;
    }
  }

  /**
   * Earlier versions of the app persisted the ticker state under
   * {@code pat.news.ticker.enabled}. We no longer honor it (ticker always
   * starts OFF to protect the 100-req/day NewsAPI quota), but we still
   * purge the key on boot so it stops cluttering the user's localStorage.
   */
  private clearLegacyPreference(): void {
    try {
      localStorage.removeItem('pat.news.ticker.enabled');
    } catch {
      // localStorage may be unavailable (private mode, quota); non-fatal.
    }
  }
}
