import { Component, OnInit, OnDestroy, ChangeDetectorRef, TemplateRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
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
  /**
   * Virtual countries are NOT supported by NewsAPI's /top-headlines endpoint,
   * so we expose them in a separate optgroup and auto-switch the user to
   * "Search" mode when they pick one. The country name is then used as the
   * /everything query (and its natural language is pre-selected).
   */
  virtual?: boolean;
}

interface CategoryOption {
  code: string;
  labelKey: string;
  icon: string;
}

type NewsMode = 'headlines' | 'search' | 'sources';

/**
 * Which upstream news provider the backend should talk to for this
 * request. Both providers expose the exact same REST contract to this
 * component — only the endpoint URL and the quota/delay characteristics
 * differ — so the rest of the code never branches on this value except
 * to include it in persisted state and the backend query string.
 */
type NewsProviderId = 'newsdata' | 'newsapi';

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
  /**
   * Low-level endpoint selector sent to the backend. Derived from
   * {@link userTab} + current country (virtual countries silently force
   * {@code 'search'}). Persisted for backward compat with saved prefs but
   * the user now interacts with {@link userTab} instead.
   */
  mode: NewsMode = 'headlines';

  /**
   * Tab the user explicitly clicked on — independent of which NewsAPI
   * endpoint we actually hit. This is what drives the UI's tab highlight
   * and which filters are shown. Keeping it decoupled from {@link mode}
   * lets us pick Peru (a "virtual" country unsupported by /top-headlines)
   * from the "À la une" tab without visually jumping the user into the
   * "Rechercher" tab: we quietly call /everything under the hood and
   * leave the "À la une" tab highlighted.
   */
  userTab: 'headlines' | 'search' | 'sources' = 'headlines';

  /**
   * Selected news provider. NewsData.io is the default because its
   * Free plan has no 24h delay on articles (unlike NewsAPI's Developer
   * plan). The user can switch to NewsAPI from the provider tabs at
   * the top of the page; the selection is persisted in localStorage.
   */
  provider: NewsProviderId = 'newsdata';
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
  /** Spinner flag for the "Force refresh" button (cache flush + refetch). */
  isClearingCache = false;

  /**
   * When headlines come back empty for a non-US country (a common free-tier
   * quirk on NewsAPI), we transparently fall back to /everything. These two
   * fields track that so the UI can show a friendly banner instead of an
   * empty page, and so we never loop indefinitely.
   */
  fallbackUsed = false;
  fallbackInfo: { countryName: string; flag: string; categoryLabel?: string } | null = null;

  // Bumped to v4 when the UI switched from the 3-button (Headlines /
  // Search / Sources) toggle to the 2-tab layout (À la une / Rechercher +
  // discreet Sources link). Old v3 payloads are ignored rather than
  // migrated, so the user gets the new defaults instead of inheriting a
  // mode that no longer maps cleanly to a tab.
  // v5 adds the `provider` field (NewsData.io vs NewsAPI). Older keys
  // are ignored on load so returning users transparently pick up the
  // new default provider without carrying a stale field.
  private readonly STORAGE_KEY = 'pat.news.filters.v5';
  private readonly IMAGE_PROXY_BASE = environment.API_URL + 'external/news/image?u=';
  private langChangeSub?: Subscription;
  private search$ = new Subject<void>();
  private searchSub?: Subscription;

  /**
   * Tracks the currently in-flight NewsAPI HTTP request so we can cancel
   * it as soon as the user triggers a new one. Without this, rapid
   * category/country/tab clicks would fan out N concurrent HTTP calls
   * (and on the backend, N cache misses → N NewsAPI calls).
   */
  private currentQuerySub?: Subscription;

  /**
   * Signature of the last query we SUCCESSFULLY started/completed. Used
   * to de-dupe a trigger that wouldn't change anything ("click same tab
   * twice", "ngOnInit + loadStatus override to same value", etc.), so a
   * single user intent never translates to more than one NewsAPI call.
   * Intentionally {@code undefined} on first load so the initial fetch
   * always runs.
   */
  private lastQuerySignature?: string;

  /**
   * {@code true} once {@link ngOnInit} has fired its very first
   * {@link runQuery} call. Used to gate the loadStatus-driven re-run of
   * {@link runQuery} for first-time visitors whose server defaults
   * happen to match the hardcoded ones (no change → no double fetch).
   */
  private initialQueryFired = false;

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

  /**
   * Countries NewsAPI does not cover on {@code /top-headlines} but that users
   * still routinely ask for (Spain, Peru, Chile, Lebanon, Finland…). Picking
   * one of these auto-switches the UI to "Search" mode and runs an
   * {@code /everything} query with the English country name and a sensible
   * default language. The list stays alphabetical by code.
   */
  readonly virtualCountries: CountryOption[] = [
    { code: 'bd', name: 'বাংলাদেশ',       virtual: true },
    { code: 'bo', name: 'Bolivia',         virtual: true },
    { code: 'cl', name: 'Chile',           virtual: true },
    { code: 'cr', name: 'Costa Rica',      virtual: true },
    { code: 'dk', name: 'Danmark',         virtual: true },
    { code: 'do', name: 'Rep. Dominicana', virtual: true },
    { code: 'dz', name: 'الجزائر',        virtual: true },
    { code: 'ec', name: 'Ecuador',         virtual: true },
    { code: 'ee', name: 'Eesti',           virtual: true },
    { code: 'es', name: 'España',          virtual: true },
    { code: 'fi', name: 'Suomi',           virtual: true },
    { code: 'gt', name: 'Guatemala',       virtual: true },
    { code: 'hn', name: 'Honduras',        virtual: true },
    { code: 'hr', name: 'Hrvatska',        virtual: true },
    { code: 'is', name: 'Ísland',          virtual: true },
    { code: 'jo', name: 'الأردن',         virtual: true },
    { code: 'ke', name: 'Kenya',           virtual: true },
    { code: 'lb', name: 'لبنان',          virtual: true },
    { code: 'ni', name: 'Nicaragua',       virtual: true },
    { code: 'pa', name: 'Panamá',          virtual: true },
    { code: 'pe', name: 'Perú',            virtual: true },
    { code: 'pk', name: 'پاکستان',        virtual: true },
    { code: 'py', name: 'Paraguay',        virtual: true },
    { code: 'qa', name: 'قطر',            virtual: true },
    { code: 'sv', name: 'El Salvador',     virtual: true },
    { code: 'tn', name: 'تونس',           virtual: true },
    { code: 'uy', name: 'Uruguay',         virtual: true },
    { code: 'vn', name: 'Việt Nam',        virtual: true }
  ];

  /**
   * Flat, alpha-sorted merge of {@link countries} and {@link virtualCountries}.
   *
   * The UI no longer splits natives and virtuals into two {@code optgroup}s
   * because that exposed the NewsAPI endpoint difference to the user (which
   * was confusing). The {@code virtual} flag is still used internally by
   * {@link resolveModeFromTab} to pick the right endpoint behind the scenes,
   * and by the template to prefix those entries with a subtle globe marker
   * so countries like Peru or Spain stay easy to spot in the long list.
   *
   * Computed eagerly on first access and cached in {@link _allCountriesCache}
   * — the lists are static, so a single sort per session is enough.
   */
  private _allCountriesCache: CountryOption[] | null = null;
  get allCountries(): CountryOption[] {
    if (this._allCountriesCache) return this._allCountriesCache;
    const empty = this.countries.filter(c => !c.code);
    const real = this.countries.filter(c => !!c.code);
    const merged = [...real, ...this.virtualCountries];
    merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    this._allCountriesCache = [...empty, ...merged];
    return this._allCountriesCache;
  }

  /**
   * Rendering helper used by the {@code <option>} labels in all three
   * country pickers. Prefixes the flag, name and ISO code — and marks
   * "virtual" countries (Peru, Spain, Chile…) with a discreet globe
   * glyph so they don't get lost in the alphabetical list. The glyph is
   * cosmetic only; selection, comparison and persistence still use the
   * raw {@link CountryOption#code}.
   */
  formatCountryOption(c: CountryOption): string {
    if (!c.code) return c.name;
    const prefix = c.virtual ? '🌐 ' : '';
    return `${prefix}${this.getCountryFlag(c.code)} ${c.name} (${c.code.toUpperCase()})`;
  }

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
    za: { name: 'South Africa', language: 'en' },
    // ----- Virtual countries (no /top-headlines support, /everything only) -----
    bd: { name: 'Bangladesh' },
    bo: { name: 'Bolivia', language: 'es' },
    cl: { name: 'Chile', language: 'es' },
    cr: { name: 'Costa Rica', language: 'es' },
    dk: { name: 'Denmark' },
    do: { name: 'Dominican Republic', language: 'es' },
    dz: { name: 'Algeria', language: 'ar' },
    ec: { name: 'Ecuador', language: 'es' },
    ee: { name: 'Estonia' },
    es: { name: 'Spain', language: 'es' },
    fi: { name: 'Finland' },
    gt: { name: 'Guatemala', language: 'es' },
    hn: { name: 'Honduras', language: 'es' },
    hr: { name: 'Croatia' },
    is: { name: 'Iceland' },
    jo: { name: 'Jordan', language: 'ar' },
    ke: { name: 'Kenya', language: 'en' },
    lb: { name: 'Lebanon', language: 'ar' },
    ni: { name: 'Nicaragua', language: 'es' },
    pa: { name: 'Panama', language: 'es' },
    pe: { name: 'Peru', language: 'es' },
    pk: { name: 'Pakistan', language: 'en' },
    py: { name: 'Paraguay', language: 'es' },
    qa: { name: 'Qatar', language: 'ar' },
    sv: { name: 'El Salvador', language: 'es' },
    tn: { name: 'Tunisia', language: 'ar' },
    uy: { name: 'Uruguay', language: 'es' },
    vn: { name: 'Vietnam' }
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

  /**
   * Template used by {@link openProviderHelp}. Bound via ViewChild so
   * we don't need a separate component for the help dialog; the modal
   * body is inlined in news.component.html as an <ng-template>.
   */
  @ViewChild('providerHelpModal') private providerHelpModalTpl?: TemplateRef<unknown>;
  private providerHelpModalRef?: NgbModalRef;

  /**
   * Which provider the help modal is currently describing. Drives the
   * conditional sections inside the modal body.
   */
  helpProvider: NewsProviderId = 'newsdata';

  constructor(
    private apiService: ApiService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private newsTicker: NewsTickerService,
    private modalService: NgbModal
  ) {}

  /**
   * {@code true} when the user's current i18n language is French.
   * Per product decision, the filter help is only translated to FR/EN:
   * FR for french-speaking users, EN for everyone else.
   */
  get isFrenchUi(): boolean {
    const lang = (this.translate.currentLang || this.translate.defaultLang || '').toLowerCase();
    return lang === 'fr' || lang.startsWith('fr-') || lang.startsWith('fr_');
  }

  /**
   * Open the "how do the filters work?" modal. The content is
   * provider-specific (quota, delay, country coverage quirks) so each
   * provider pill carries its own {@code ?} button that calls this
   * method with the right id.
   */
  openProviderHelp(provider: NewsProviderId): void {
    this.helpProvider = provider;
    if (!this.providerHelpModalTpl) return;
    this.providerHelpModalRef = this.modalService.open(this.providerHelpModalTpl, {
      size: 'lg',
      scrollable: true,
      centered: true,
      backdrop: true,
      ariaLabelledBy: 'news-help-title'
    });
    this.providerHelpModalRef.result.finally(() => {
      this.providerHelpModalRef = undefined;
    });
  }

  closeProviderHelp(): void {
    this.providerHelpModalRef?.close();
  }

  // ---------------- Lifecycle ----------------

  ngOnInit(): void {
    this.restoreFilters();
    // Ensure {@link mode} is consistent with {@link userTab} + current
    // country right after restore (a stale saved mode or an unseen-before
    // virtual country could otherwise produce a wrong endpoint call).
    this.resolveModeFromTab();
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

    // First-visit users (no saved filters) defer their initial query to
    // {@link loadStatus}'s callback so that server-provided defaults
    // (country / language from application.properties) get applied
    // BEFORE we hit NewsAPI — which prevents firing the same query
    // twice (once with hardcoded defaults, once after the override).
    // Returning users have their prefs restored synchronously so we can
    // kick the fetch off immediately.
    if (this.userHasFilterPrefs) {
      this.runQuery();
    }
  }

  ngOnDestroy(): void {
    this.langChangeSub?.unsubscribe();
    this.searchSub?.unsubscribe();
    this.tickerSub?.unsubscribe();
    this.currentQuerySub?.unsubscribe();
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

  /**
   * Low-level mode setter. Called by legacy code paths (the fallback CTA
   * banner and internal resolution). The new preferred entry point is
   * {@link setTab}, which keeps the user-visible tab decoupled from the
   * NewsAPI endpoint we actually hit.
   */
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
    // Let the new mode fire a fresh query even if the caller just
    // "came back to a state we recently fetched" — the signature-based
    // dedup would otherwise swallow the user's intent.
    this.runQuery(true);
  }

  /**
   * User clicked one of the two main tabs ("À la une" / "Rechercher") or
   * the discreet "Sources" link. This updates {@link userTab} (what the
   * UI highlights) AND resolves the correct underlying {@link mode} for
   * the backend — which may differ when {@link country} is a virtual one.
   */
  /**
   * Switch to the other news provider (NewsData.io ↔ NewsAPI).
   *
   * Provider switching is intentionally destructive for the current
   * result set: quotas, caches and status panels are per-provider on
   * the backend, so the articles / sources / status previously shown
   * are stale as soon as we flip. The localStorage filter preferences
   * stay intact though — same tab, same country, same category — so
   * the user keeps their context when comparing providers.
   */
  setProvider(provider: NewsProviderId): void {
    if (this.provider === provider) return;
    this.provider = provider;
    this.page = 1;
    this.articles = [];
    this.sources = [];
    this.totalResults = 0;
    this.errorMessage = '';
    this.apiStatus = null;
    this.persistFilters();
    this.updateTitle();
    this.loadStatus();
    // {@link buildQuerySignature} already includes the provider, so
    // force=true is not strictly needed, but we keep it explicit: a
    // user clicking the provider tab always expects a fresh fetch.
    this.runQuery(true);
  }

  setTab(tab: 'headlines' | 'search' | 'sources'): void {
    if (this.userTab === tab) {
      // Clicking the already-active tab is a "refresh my results"
      // intent — force a re-run even if nothing in the query signature
      // changed. The backend cache will still absorb repeats within
      // the 5-minute TTL window, so this never hits NewsAPI twice.
      this.runQuery(true);
      return;
    }
    this.userTab = tab;
    this.page = 1;
    this.articles = [];
    this.sources = [];
    this.totalResults = 0;
    this.errorMessage = '';
    this.resolveModeFromTab();
    this.updateTitle();
    this.persistFilters();
    this.runQuery();
  }

  /**
   * Derive the backend-facing {@link mode} from the user-chosen
   * {@link userTab} and the current {@link country}. Virtual countries
   * (Peru, Spain…) are silently routed to {@code /everything} even when
   * the user stays on the "À la une" tab, because {@code /top-headlines}
   * does not cover them. The UI tab highlight is NOT changed here, only
   * the endpoint we talk to.
   */
  private resolveModeFromTab(): void {
    if (this.userTab === 'sources') {
      this.mode = 'sources';
      return;
    }
    if (this.userTab === 'search') {
      this.mode = 'search';
      return;
    }
    // userTab === 'headlines'
    this.mode = this.isVirtualCountry(this.country) ? 'search' : 'headlines';
  }

  setCategory(code: string): void {
    // Clicking the currently-active category chip is a no-op: we don't
    // want the click to be interpreted as a "refresh" that burns a
    // backend round-trip for nothing.
    if (this.category === code) return;
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

  /**
   * Returns {@code true} when {@code code} refers to a "virtual" country —
   * i.e. one we expose in the selector but that NewsAPI's /top-headlines
   * endpoint does not cover (Peru, Chile, Spain, Lebanon, Finland, etc.).
   */
  isVirtualCountry(code: string): boolean {
    if (!code) return false;
    return this.virtualCountries.some(c => c.code === code);
  }

  /**
   * Specialised filter-change handler for the Country selector.
   *
   * When the user picks a virtual country (Peru, Spain, Chile…) from the
   * "À la une" tab, we transparently switch the underlying endpoint to
   * {@code /everything} — but we do NOT change {@link userTab}. From the
   * user's perspective, "À la une + Peru" just works: they stay on the
   * "À la une" tab and see Peruvian articles. The complexity of NewsAPI's
   * country coverage is hidden.
   */
  onCountryChange(): void {
    if (this.country && this.isVirtualCountry(this.country)) {
      // Pre-fill a sensible default language so /everything does not come
      // back empty (e.g. Peru → Spanish, Vietnam → Vietnamese). Never
      // overwrite a language the user already picked explicitly.
      const entry = this.fallbackQueryMap[this.country];
      if (entry && entry.language && !this.language) {
        this.language = entry.language;
      }
    }
    this.resolveModeFromTab();
    this.onFilterChange();
  }

  /**
   * Human-readable name of the currently selected country (either the
   * value in the picker, or the English fallback name). Used by the
   * virtual-country banner so the user sees why the mode just changed.
   */
  getSelectedCountryName(): string {
    if (!this.country) return '';
    const merged: CountryOption | undefined =
      this.countries.find(c => c.code === this.country) ||
      this.virtualCountries.find(c => c.code === this.country);
    if (merged) return merged.name;
    const entry = this.fallbackQueryMap[this.country];
    return entry?.name || this.country.toUpperCase();
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
    if (newPage === this.page) return; // already on this page
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
    const effective = this.effectivePageSize;
    if (!this.totalResults || effective <= 0) return 0;
    // Per-provider pagination ceiling:
    //  - NewsAPI developer plan HARD-caps reachable results at 100 (the
    //    API flat-out refuses page numbers beyond that), so exposing
    //    more pages would just lead to errors.
    //  - NewsData.io has no equivalent hard cap — you can walk the
    //    cursor as deep as your 200 credits/day allow. We still apply
    //    a soft UI cap (1000 articles = 100 pages @ 10/page) to keep
    //    the "Page X / Y" label readable and to stop a user from
    //    accidentally burning a huge chunk of their daily quota on
    //    deep navigation. The true result count is still shown in the
    //    banner (e.g. "16,613 results") so users understand the data
    //    exists, just beyond a sensible browsing depth.
    const maxReachable = this.provider === 'newsdata' ? 1000 : 100;
    const capped = Math.min(this.totalResults, maxReachable);
    return Math.ceil(capped / effective);
  }

  /**
   * Real page size actually sent to the backend, honoring per-provider
   * server-side ceilings:
   *   - NewsData.io free plan caps {@code /latest} at 10 articles/call.
   *     Anything higher returns HTTP 422, so we silently clamp here
   *     rather than letting the user's stored 12 cause an error.
   *   - NewsAPI accepts up to 100; we pass the user's value as-is.
   *
   * We keep {@link pageSize} (the user's preference) untouched so
   * switching back to NewsAPI restores the richer page size.
   */
  get effectivePageSize(): number {
    if (this.provider === 'newsdata') return Math.min(this.pageSize, 10);
    return this.pageSize;
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
    // "Refresh" is explicitly a re-run intent, so bypass the
    // same-signature short-circuit. Backend cache still absorbs the
    // repeat within the 5-minute TTL.
    this.runQuery(true);
  }

  /**
   * "Force refresh" — flushes the backend NewsAPI cache first, then runs
   * the current query. This bypasses the 30-minute TTL and guarantees the
   * next call hits NewsAPI (costing one quota slot).
   *
   * The existing {@link refreshAll} button just re-runs the query and will
   * usually serve cached data; this one is for when the user really wants
   * the very latest articles.
   */
  forceRefresh(): void {
    if (this.isClearingCache) return;
    this.isClearingCache = true;
    this.cdr.markForCheck();
    this.apiService.clearNewsApiCache(this.provider).subscribe({
      next: (resp) => {
        const cleared = Number(resp?.cleared) || 0;
        this.successMessage = this.translate.instant('NEWS.CACHE_CLEARED', { count: cleared });
        this.isClearingCache = false;
        this.refreshAll();
        setTimeout(() => { this.successMessage = ''; this.cdr.markForCheck(); }, 3000);
      },
      error: () => {
        this.isClearingCache = false;
        this.errorMessage = this.translate.instant('NEWS.CACHE_CLEAR_FAILED');
        this.cdr.markForCheck();
      }
    });
  }

  // ---------------- Quota meter helpers (displayed in the status badge) ----------------

  /**
   * Effective quota shown on the "used / quota" badge. When multiple
   * NewsAPI keys are configured (new in the backend), the server exposes
   * {@code totalQuotaDaily = quotaDaily * keyCount} and we use it here so
   * the gauge reflects the combined daily budget rather than per-key.
   * Falls back to {@code quotaDaily} for backward compatibility.
   */
  getEffectiveQuota(): number | null {
    const total = Number(this.apiStatus?.totalQuotaDaily);
    if (Number.isFinite(total) && total > 0) return total;
    const q = Number(this.apiStatus?.quotaDaily);
    return Number.isFinite(q) && q > 0 ? q : null;
  }

  /**
   * Severity bucket for the quota badge color.
   *  - 'ok'     : < 60% used
   *  - 'warn'   : 60% - 89% used
   *  - 'danger' : >= 90% used (or over quota)
   * Falls back to 'ok' when the server hasn't reported any quota.
   */
  getQuotaLevel(): 'ok' | 'warn' | 'danger' {
    const used = Number(this.apiStatus?.requestsLast24h);
    const quota = this.getEffectiveQuota();
    if (!Number.isFinite(used)) return 'ok';
    if (!quota) return 'ok';
    const ratio = used / quota;
    if (ratio >= 0.9) return 'danger';
    if (ratio >= 0.6) return 'warn';
    return 'ok';
  }

  /**
   * Tooltip for the quota badge: shows raw counts, remaining, and when the
   * rolling window will free up its oldest slot. Safe against missing fields.
   */
  getQuotaTooltip(): string {
    const s = this.apiStatus || {};
    const used = Number(s.requestsLast24h);
    const quota = this.getEffectiveQuota();
    const remaining = Number(s.requestsRemaining);
    const parts: string[] = [];
    if (Number.isFinite(used) && quota) {
      parts.push(`${used} / ${quota} ${this.translate.instant('NEWS.QUOTA_REQUESTS_IN_24H')}`);
    } else if (Number.isFinite(used)) {
      parts.push(`${used} ${this.translate.instant('NEWS.QUOTA_REQUESTS_IN_24H')}`);
    }
    if (Number.isFinite(remaining)) {
      parts.push(`${this.translate.instant('NEWS.QUOTA_REMAINING')}: ${remaining}`);
    }
    if (s.windowResetsAt) {
      try {
        const reset = new Date(s.windowResetsAt);
        if (!isNaN(reset.getTime())) {
          parts.push(`${this.translate.instant('NEWS.QUOTA_NEXT_SLOT')}: ${reset.toLocaleString()}`);
        }
      } catch (_) { /* ignore */ }
    }
    const keys = Array.isArray(s.keys) ? s.keys : [];
    if (keys.length > 1) {
      parts.push(this.translate.instant('NEWS.QUOTA_MULTI_KEY', { count: keys.length }));
    }
    return parts.join(' — ');
  }

  /**
   * Tooltip for each per-key badge — explains which key is active, how
   * much quota each key has burned, when its 24h window frees up, etc.
   */
  getKeyTooltip(k: any): string {
    if (!k) return '';
    const parts: string[] = [];
    const used = Number(k.used);
    const quota = Number(k.quota);
    const remaining = Number(k.remaining);
    parts.push(`${this.translate.instant('NEWS.KEY_ID')}: ${k.keyId}`);
    if (Number.isFinite(used) && Number.isFinite(quota) && quota > 0) {
      parts.push(`${used} / ${quota} ${this.translate.instant('NEWS.QUOTA_REQUESTS_IN_24H')}`);
    }
    if (Number.isFinite(remaining)) {
      parts.push(`${this.translate.instant('NEWS.QUOTA_REMAINING')}: ${remaining}`);
    }
    if (k.active) parts.push(this.translate.instant('NEWS.KEY_ACTIVE'));
    if (k.saturated) parts.push(this.translate.instant('NEWS.KEY_SATURATED'));
    if (k.windowResetsAt) {
      try {
        const reset = new Date(k.windowResetsAt);
        if (!isNaN(reset.getTime())) {
          parts.push(`${this.translate.instant('NEWS.QUOTA_NEXT_SLOT')}: ${reset.toLocaleString()}`);
        }
      } catch (_) { /* ignore */ }
    }
    return parts.join(' — ');
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

  /**
   * Build a stable signature describing the query we are ABOUT to run,
   * covering every parameter that would produce a different backend
   * (and thus NewsAPI) URL. Used for de-duplication so a single user
   * intent never translates to more than one NewsAPI call.
   */
  private buildQuerySignature(): string {
    // The provider prefix is part of the signature so that switching
    // between NewsData.io and NewsAPI always triggers a fresh fetch,
    // even when every other filter value stays the same.
    const base = this.provider + ':';
    if (this.mode === 'sources') {
      return base + [
        'sources',
        this.country || '',
        this.category || '',
        this.language || ''
      ].join('|');
    }
    if (this.mode === 'search') {
      return base + [
        'search',
        (this.query || '').trim().toLowerCase(),
        this.country || '',
        this.category || '',
        this.language || '',
        this.sortBy || '',
        this.dateFrom || '',
        this.dateTo || '',
        this.pageSize,
        this.page
      ].join('|');
    }
    // headlines
    return base + [
      'headlines',
      this.country || '',
      this.category || '',
      (this.query || '').trim().toLowerCase(),
      this.pageSize,
      this.page
    ].join('|');
  }

  /**
   * Kick off a NewsAPI fetch for the current filter state.
   *
   * Two safeguards keep NewsAPI call volume to the strict minimum:
   *  - We cancel any still-in-flight HTTP request before starting a new
   *    one, so a burst of clicks never fans out into concurrent calls.
   *  - We short-circuit when the new query signature matches the last
   *    one we actually fired (unless {@code force=true}, used by the
   *    "Force refresh" button and pagination where the user really does
   *    want a fresh request). The backend TTL cache would likely serve
   *    duplicates anyway, but skipping the HTTP round-trip entirely is
   *    strictly better.
   */
  private runQuery(force: boolean = false): void {
    const signature = this.buildQuerySignature();
    if (!force && signature === this.lastQuerySignature && this.isLoading) {
      // Identical request already in flight — let it finish instead of
      // re-firing it and racing handlers.
      return;
    }
    this.lastQuerySignature = signature;
    this.initialQueryFired = true;
    this.currentQuerySub?.unsubscribe();

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
    this.currentQuerySub = this.apiService.getTopHeadlines({
      provider: this.provider,
      country: this.country || undefined,
      category: this.category || undefined,
      q: this.query || undefined,
      pageSize: this.effectivePageSize,
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
    //     name as the query so they still see something relevant — and
    //     tack on the selected category as an extra keyword when we were
    //     called through the "À la une" tab (where /everything is used
    //     silently for virtual countries like Peru/Spain). That way the
    //     Sport chip on "À la une + Pérou" actually filters results
    //     instead of being ignored by the endpoint.
    //   - In both cases, derive a default language from the country when
    //     the user has not explicitly picked one.
    if (this.country) {
      const entry = this.fallbackQueryMap[this.country] || { name: this.country.toUpperCase() };
      if (!userQ) {
        effectiveQ = entry.name;
        if (this.category && this.userTab === 'headlines') {
          effectiveQ += ' ' + this.category;
        }
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

    this.currentQuerySub = this.apiService.getEverything({
      provider: this.provider,
      q: effectiveQ,
      language: effectiveLang,
      from,
      to,
      sortBy: this.sortBy,
      pageSize: this.effectivePageSize,
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
    this.currentQuerySub = this.apiService.getNewsSources({
      provider: this.provider,
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

    this.currentQuerySub = this.apiService.getEverything({
      provider: this.provider,
      q,
      language: entry.language,
      sortBy: 'publishedAt',
      pageSize: this.effectivePageSize,
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
    this.apiService.getNewsApiStatus(this.provider).subscribe({
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
        // Three cases:
        //  - First visit AND the server pushed new defaults → we need
        //    the updated country/language in the query we're about to
        //    fire for the very first time.
        //  - First visit AND server defaults match the hardcoded ones
        //    → we still owe the user an initial fetch (deferred by
        //    ngOnInit to avoid double-firing).
        //  - Returning visit → ngOnInit already fired runQuery(); we
        //    only re-fire it when defaults actually changed.
        const needInitialFetch = !this.initialQueryFired;
        if (countryChanged || languageChanged) this.updateTitle();
        if (needInitialFetch || countryChanged || languageChanged) {
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
    const c = this.countries.find(x => x.code === code)
           || this.virtualCountries.find(x => x.code === code);
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

  /**
   * Rebuild the big "—" separated title shown in the page header.
   *
   * The title now mirrors what the user sees in the UI (driven by
   * {@link userTab}), not what the backend endpoint is (driven by
   * {@link mode}). So "À la une + Pérou + Sport" reads as
   * "News — À la une — 🇵🇪 Perú — Sport", never as "Recherche — …"
   * just because the virtual-country fallback silently hit /everything.
   *
   * Each filter is appended in reading order and only when it actually
   * influences the current request, so the title stays concise instead
   * of listing every form field.
   */
  private updateTitle(): void {
    const base = this.translate.instant('NEWS.PAGE_TITLE');
    const parts: string[] = [base];

    parts.push(this.translate.instant('NEWS.TAB_' + this.userTab.toUpperCase()));

    if (this.userTab === 'search' && this.query) {
      parts.push(`"${this.query}"`);
    }

    if (this.country) {
      parts.push(`${this.getCountryFlag(this.country)} ${this.getCountryName(this.country)}`);
    }

    // Category is shown for headlines/sources (where it filters the API
    // directly) and for headlines + virtual country (where it is injected
    // as an extra keyword into /everything in {@link fetchEverything}).
    const categoryIsUsed =
      !!this.category &&
      this.userTab !== 'search';
    if (categoryIsUsed) {
      const labelKey = this.categories.find(c => c.code === this.category)?.labelKey;
      if (labelKey) parts.push(this.translate.instant(labelKey));
    }

    // Language only matters when the target endpoint honours it: always
    // for /everything (Search) and /sources, but for Headlines only when
    // we silently fall back to /everything for a virtual country.
    const languageIsUsed =
      !!this.language && (
        this.userTab === 'search' ||
        this.userTab === 'sources' ||
        (this.userTab === 'headlines' && this.isVirtualCountry(this.country))
      );
    if (languageIsUsed) {
      parts.push(this.language.toUpperCase());
    }

    this.newsTitle = parts.join(' — ');
  }

  /**
   * Translation key of the currently selected category — exposed for the
   * collapsed-filters summary which needs the label inline.
   */
  getCategoryLabelKey(): string {
    return this.categories.find(c => c.code === this.category)?.labelKey || '';
  }

  private persistFilters(): void {
    try {
      const payload = {
        provider: this.provider,
        userTab: this.userTab, mode: this.mode,
        country: this.country, category: this.category,
        language: this.language, query: this.query, sortBy: this.sortBy,
        dateFrom: this.dateFrom, dateTo: this.dateTo, pageSize: this.pageSize
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
    } catch (_) { /* localStorage may be unavailable (private mode) */ }
    // Keep the global ticker (rendered in AppComponent) in sync with
    // whatever the user just selected — debounced inside the service
    // so rapid edits (typing in the search box) cost one refresh.
    this.newsTicker.notifyFiltersChanged();
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
      if (saved.provider === 'newsdata' || saved.provider === 'newsapi') {
        this.provider = saved.provider;
      }
      if (saved.userTab === 'headlines' || saved.userTab === 'search' || saved.userTab === 'sources') {
        this.userTab = saved.userTab;
      }
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
