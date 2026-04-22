import { ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { Subject, Subscription, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import { ApiService, StockQuote, StockSymbol, StockSymbolSearchResult, StockTimeSeries } from '../services/api.service';
import { StockTickerService } from '../services/stock-ticker.service';

Chart.register(...registerables);

/**
 * Stock-exchange page backed by the Twelve Data proxy.
 *
 * Responsibilities:
 * <ul>
 *   <li>Pick a symbol from a free-text input (with a curated dropdown of defaults).</li>
 *   <li>Show the latest quote: price, day change, open/high/low, previous close, volume.</li>
 *   <li>Render historical OHLC closes as a line chart, with 7d / 30d / 90d / 1y ranges.</li>
 *   <li>Toggle the global stock-quote ticker (mounted by AppComponent).</li>
 * </ul>
 *
 * Data-source notes:
 * <ul>
 *   <li>Twelve Data free tier: 8 req/min, 800 req/day - the backend caches /quote for 60 s
 *       and /time_series for 30 min, which is plenty for interactive browsing.</li>
 *   <li>Price strings are preserved verbatim from the upstream and parsed lazily;
 *       non-numeric or missing values are treated as null rather than 0.</li>
 *   <li>The demo API key only works for AAPL - other symbols need a registered key
 *       configured server-side (see {@code app.twelvedata.api-key}).</li>
 * </ul>
 */
@Component({
  selector: 'app-stock-exchange',
  templateUrl: './stock-exchange.component.html',
  styleUrls: ['./stock-exchange.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective]
})
export class StockExchangeComponent implements OnInit, OnDestroy {

  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;
  @ViewChild('searchBox') searchBoxRef?: ElementRef<HTMLElement>;

  // ----- Inputs -----
  /** Current (resolved) ticker used by /quote & /timeseries. */
  symbol = 'AAPL';

  /**
   * Free-text the user types in the search box. Can be a ticker (AAPL, BRK.B)
   * or a company name (Airbus, LVMH). Resolved to a ticker via /search.
   */
  searchQuery = 'AAPL';

  // ----- State -----
  defaultSymbols: StockSymbol[] = this.buildDefaultSymbols();
  quote: StockQuote | null = null;
  timeseries: StockTimeSeries | null = null;
  lastUpdated: string | null = null;
  /** i18n key of the error banner's headline. Empty = no banner. */
  errorMessage = '';
  /**
   * Raw, untranslated upstream message (e.g. Twelve Data's "This symbol is
   * available starting with the Pro or Venture plan..."). Shown below the
   * banner headline when present, so the user sees the authoritative reason
   * rather than a generic "something went wrong".
   */
  errorDetail = '';
  isLoadingQuote = false;
  isLoadingHistory = false;
  isClearingCache = false;
  /** Short-lived confirmation flash shown after a successful cache purge. */
  cacheCleared = false;

  // ----- Autocomplete -----
  searchResults: StockSymbolSearchResult[] = [];
  showResults = false;
  isSearching = false;
  highlightedIndex = -1;

  /** Time window for the chart, in candles (interval stays `1day`). */
  rangeDays = 30;

  /** Stock ticker visibility (pushed by {@link StockTickerService}). */
  tickerEnabled = false;

  // ----- Chart configuration -----
  chartType: 'line' = 'line';
  chartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'top' },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${(ctx.parsed.y as number).toFixed(2)}`
        }
      }
    },
    scales: {
      x: { title: { display: false } },
      y: {
        title: { display: true, text: 'Close' },
        ticks: { callback: (v) => Number(v).toFixed(2) }
      }
    }
  };

  /** Valid ticker shape (same regex as the backend validator). */
  private static readonly TICKER_RE = /^[A-Za-z0-9.\-/]{1,16}$/;

  private readonly search$ = new Subject<string>();
  private subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private ticker: StockTickerService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Pre-fill the search box with a friendly label for the default symbol.
    const def = this.defaultSymbols.find((s) => s.symbol === this.symbol);
    if (def?.name) this.searchQuery = `${def.symbol} - ${def.name}`;

    this.refresh();

    this.subs.push(
      // Autocomplete stream: debounced, de-duped, switch-mapped so only the
      // latest query result is applied (cancels in-flight previous calls).
      // Each network error is caught inline so the observable stays alive.
      this.search$
        .pipe(
          debounceTime(300),
          distinctUntilChanged(),
          switchMap((q) => {
            const trimmed = (q ?? '').trim();
            if (trimmed.length < 2) {
              this.isSearching = false;
              return of<StockSymbolSearchResult[]>([]);
            }
            this.isSearching = true;
            return this.api.searchStockSymbols(trimmed, 20).pipe(
              catchError(() => of<StockSymbolSearchResult[]>([]))
            );
          })
        )
        .subscribe((list) => {
          this.searchResults = list || [];
          this.showResults = this.searchResults.length > 0;
          this.highlightedIndex = -1;
          this.isSearching = false;
          this.cdr.markForCheck();
        }),
      this.ticker.enabled$.subscribe((v) => {
        this.tickerEnabled = v;
        this.cdr.markForCheck();
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  // ----- Public actions (bound to the template) -----

  /**
   * Fired every time the user types in the search box. Kicks off the
   * debounced autocomplete stream. Does NOT trigger a quote fetch — that
   * happens on explicit selection (click, Enter, or Search button).
   */
  onSearchInput(): void {
    const q = (this.searchQuery ?? '').trim();
    if (q.length < 2) {
      this.searchResults = [];
      this.showResults = false;
      this.isSearching = false;
      this.highlightedIndex = -1;
    }
    this.search$.next(this.searchQuery ?? '');
  }

  /**
   * User pressed Enter or clicked the "load" button without picking a
   * suggestion. If the input looks like a valid ticker we load it directly;
   * otherwise we promote the first search suggestion (if any).
   */
  onSearchSubmit(): void {
    const q = (this.searchQuery ?? '').trim();
    if (!q) return;
    if (StockExchangeComponent.TICKER_RE.test(q)) {
      this.selectSymbol(q.toUpperCase(), /* closeDropdown */ true);
      return;
    }
    if (this.searchResults.length > 0) {
      const first = this.searchResults[this.highlightedIndex >= 0 ? this.highlightedIndex : 0];
      this.selectSearchResult(first);
    }
  }

  selectSearchResult(r: StockSymbolSearchResult): void {
    if (!r || !r.symbol) return;
    this.searchQuery = this.formatSearchQueryFromResult(r);
    this.selectSymbol(r.symbol.toUpperCase(), true);
  }

  pickSymbol(code: string): void {
    if (!code) return;
    // Keep the search box in sync with the chosen chip.
    const match = this.defaultSymbols.find((s) => s.symbol === code);
    this.searchQuery = match?.name ? `${code} - ${match.name}` : code;
    this.selectSymbol(code, true);
  }

  /**
   * When the search box gains focus and already contains text (typically the
   * previously loaded symbol's label like {@code "TSLA - Tesla"}), select
   * the whole content so the user can immediately overwrite it by typing.
   * <p>
   * We defer the {@code select()} via {@code setTimeout(0)} because some
   * browsers (notably mobile Safari and Chrome on Android) reset the
   * selection to a caret position <em>after</em> the focus event handler
   * runs; scheduling the call to the next tick lets our selection win.
   * If the focus was triggered by a mousedown, we also pre-empt the click
   * that would otherwise collapse the selection.
   */
  onSearchFocus(ev?: FocusEvent): void {
    if (this.searchResults.length > 0) {
      this.showResults = true;
    }
    const el = (ev?.target as HTMLInputElement | null)
      ?? (this.searchQuery ? document.getElementById('stockSymbolInput') as HTMLInputElement | null : null);
    if (el && el.value && el.value.length > 0) {
      setTimeout(() => {
        try { el.select(); } catch { /* element detached — nothing to do */ }
      }, 0);
    }
  }

  onSearchKeydown(ev: KeyboardEvent): void {
    if (!this.showResults || this.searchResults.length === 0) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.onSearchSubmit();
      }
      return;
    }
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        this.highlightedIndex = (this.highlightedIndex + 1) % this.searchResults.length;
        break;
      case 'ArrowUp':
        ev.preventDefault();
        this.highlightedIndex =
          this.highlightedIndex <= 0 ? this.searchResults.length - 1 : this.highlightedIndex - 1;
        break;
      case 'Enter':
        ev.preventDefault();
        if (this.highlightedIndex >= 0) {
          this.selectSearchResult(this.searchResults[this.highlightedIndex]);
        } else {
          this.onSearchSubmit();
        }
        break;
      case 'Escape':
        this.showResults = false;
        this.highlightedIndex = -1;
        break;
    }
  }

  /** Close the dropdown when the user clicks anywhere outside the search box. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    const host = this.searchBoxRef?.nativeElement;
    if (!host) return;
    if (!host.contains(ev.target as Node)) {
      this.showResults = false;
    }
  }

  /** Compact label shown inside the input after a user picks a suggestion. */
  formatSearchQueryFromResult(r: StockSymbolSearchResult): string {
    const name = r.instrument_name?.trim();
    return name ? `${r.symbol} - ${name}` : r.symbol;
  }

  /** Descriptive line for each dropdown row. */
  formatResultLine(r: StockSymbolSearchResult): string {
    const parts: string[] = [];
    if (r.exchange) parts.push(r.exchange);
    if (r.country) parts.push(r.country);
    if (r.currency) parts.push(r.currency);
    return parts.join(' - ');
  }

  private selectSymbol(code: string, closeDropdown: boolean): void {
    this.symbol = code;
    if (closeDropdown) {
      this.showResults = false;
      this.highlightedIndex = -1;
    }
    this.refresh();
  }

  setRange(days: number): void {
    if (this.rangeDays === days) return;
    this.rangeDays = days;
    this.loadTimeseries();
  }

  refresh(): void {
    this.errorMessage = '';
    this.errorDetail = '';
    if (!this.symbol) {
      return;
    }
    this.loadQuote();
    this.loadTimeseries();
  }

  toggleTicker(): void {
    this.ticker.setEnabled(!this.tickerEnabled);
  }

  /**
   * Empty the server-side quote cache that feeds the ticker. Useful when
   * the list is cluttered with symbols the user no longer cares about, or
   * to start a fresh "who looked up what" history. The backend only purges
   * the quote + timeseries + loader caches; the static symbol-search cache
   * is kept so autocomplete stays instant and doesn't re-consume quota.
   */
  clearTickerCache(): void {
    if (this.isClearingCache) return;
    this.isClearingCache = true;
    this.cacheCleared = false;
    this.ticker.clearCache().subscribe({
      next: () => {
        this.isClearingCache = false;
        this.cacheCleared = true;
        this.cdr.markForCheck();
        // Auto-hide the confirmation flash after a moment.
        setTimeout(() => {
          this.cacheCleared = false;
          this.cdr.markForCheck();
        }, 2500);
      },
      error: () => {
        this.isClearingCache = false;
        this.cdr.markForCheck();
      }
    });
  }

  // ----- Derived helpers for the template -----

  /** Parse a numeric string coming from Twelve Data (returns null if NaN / empty). */
  asNumber(raw: string | undefined | null): number | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = parseFloat(raw);
    return isFinite(n) ? n : null;
  }

  get priceNumber(): number | null {
    return this.asNumber(this.quote?.close);
  }

  get previousCloseNumber(): number | null {
    return this.asNumber(this.quote?.previous_close);
  }

  get changeNumber(): number | null {
    return this.asNumber(this.quote?.change);
  }

  get percentChangeNumber(): number | null {
    return this.asNumber(this.quote?.percent_change);
  }

  /** CSS class for the day-change badge (up / down / flat). */
  get changeClass(): string {
    const pct = this.percentChangeNumber;
    if (pct === null || pct === 0) return 'chg-flat';
    return pct > 0 ? 'chg-up' : 'chg-down';
  }

  changeArrow(): string {
    const pct = this.percentChangeNumber;
    if (pct === null || pct === 0) return '\u2022';
    return pct > 0 ? '\u25B2' : '\u25BC';
  }

  formatVolume(raw: string | undefined): string {
    const n = this.asNumber(raw ?? null);
    if (n === null) return '\u2014';
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
    return n.toFixed(0);
  }

  // ----- Internals -----

  private loadQuote(): void {
    this.isLoadingQuote = true;
    this.api.getStockQuote(this.symbol).subscribe({
      next: (q) => {
        // Backend always returns HTTP 200 now: if the upstream refused the
        // symbol (e.g. "Pro or Venture plan"), the body carries status=error
        // + message + code instead of valid quote data. Detect that and
        // surface it as an in-page alert rather than treating it as data.
        if (this.isUpstreamErrorBody(q)) {
          this.applyUpstreamErrorBody(q);
          this.quote = null;
          this.lastUpdated = null;
          this.isLoadingQuote = false;
          this.cdr.markForCheck();
          return;
        }
        this.quote = q;
        this.lastUpdated = q?.datetime || null;
        this.isLoadingQuote = false;
        this.cdr.markForCheck();
        // Ping the ticker so this fresh symbol appears on the banner right
        // away (if it's visible), rather than waiting for its 30 s tick.
        // The backend side-effect is just a local HashMap read — no quota.
        this.ticker.refreshNow();
      },
      error: (err) => {
        this.applyHttpError(err);
        this.quote = null;
        this.isLoadingQuote = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadTimeseries(): void {
    if (!this.symbol) {
      this.chartData = { labels: [], datasets: [] };
      this.timeseries = null;
      this.chart?.update();
      return;
    }

    this.isLoadingHistory = true;
    this.api.getStockTimeSeries(this.symbol, '1day', this.rangeDays).subscribe({
      next: (res) => {
        if (this.isUpstreamErrorBody(res)) {
          this.applyUpstreamErrorBody(res);
          this.timeseries = null;
          this.chartData = { labels: [], datasets: [] };
          this.isLoadingHistory = false;
          this.cdr.markForCheck();
          this.chart?.update();
          return;
        }
        this.timeseries = res;
        this.applyChart(res);
        this.isLoadingHistory = false;
        this.cdr.markForCheck();
        this.chart?.update();
      },
      error: (err) => {
        this.applyHttpError(err);
        this.isLoadingHistory = false;
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Twelve Data returns {@code values} in DESCENDING date order (most recent first).
   * The chart wants ascending time, so we reverse before plotting.
   */
  private applyChart(ts: StockTimeSeries | null): void {
    if (!ts || !ts.values || ts.values.length === 0) {
      this.chartData = { labels: [], datasets: [] };
      return;
    }
    const ascending = [...ts.values].reverse();
    const labels = ascending.map((b) => b.datetime);
    const closes = ascending
      .map((b) => parseFloat(b.close))
      .map((n) => (isFinite(n) ? n : null)) as (number | null)[];

    this.chartData = {
      labels,
      datasets: [
        {
          label: `${this.symbol} \u00B7 Close`,
          data: closes as number[],
          borderColor: '#6f42c1',
          backgroundColor: 'rgba(111, 66, 193, 0.12)',
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: true,
          spanGaps: true
        }
      ]
    };
  }

  /**
   * True when the 200 OK body is actually Twelve Data's {@code status=error}
   * envelope (e.g. "Pro or Venture plan", "API credits exceeded", "symbol
   * not found"). The backend forwards these as-is in the success channel so
   * the UI can display a friendly alert without triggering HTTP-level error
   * handling (which was previously bouncing the user to the photos route).
   */
  private isUpstreamErrorBody(body: any): boolean {
    return !!body && typeof body === 'object'
      && typeof body.status === 'string'
      && body.status.toLowerCase() === 'error';
  }

  /**
   * Map Twelve Data's error body ({@code {status:"error", code, message}})
   * to an i18n headline + a verbatim detail line. {@code code} is the
   * upstream HTTP-like code (e.g. 404 for "plan gated", 429 for quota).
   * We fuzzy-match the message text to distinguish the "plan required"
   * case from genuine 404s, because Twelve Data reuses 404 for both.
   */
  private applyUpstreamErrorBody(body: any): void {
    const rawMessage: string = typeof body?.message === 'string' ? body.message : '';
    const upstreamCode: number | undefined =
      typeof body?.code === 'number' ? body.code : undefined;
    const lower = rawMessage.toLowerCase();

    let key: string;
    if (upstreamCode === 429 || lower.includes('api credits') || lower.includes('rate limit')) {
      key = 'STOCK.ERROR_RATE_LIMIT';
    } else if (lower.includes('pro or venture') || lower.includes('upgrade') || lower.includes('plan')) {
      key = 'STOCK.ERROR_PLAN_REQUIRED';
    } else if (upstreamCode === 404 || lower.includes('not found') || lower.includes('symbol')) {
      key = 'STOCK.ERROR_NOT_FOUND';
    } else if (upstreamCode === 400) {
      key = 'STOCK.ERROR_BAD_INPUT';
    } else {
      key = 'STOCK.ERROR_UPSTREAM';
    }

    this.errorMessage = key;
    this.errorDetail = rawMessage;
  }

  /**
   * Fallback for real HTTP errors (network down, backend 5xx, 4xx on the
   * proxy itself…). Twelve Data application-level errors never come through
   * here anymore — they arrive as 200 OK with an error body; see
   * {@link #applyUpstreamErrorBody}.
   */
  private applyHttpError(err: any): void {
    if (!err) {
      this.errorMessage = '';
      this.errorDetail = '';
      return;
    }
    let key: string;
    if (err.status === 0)         key = 'STOCK.ERROR_NETWORK';
    else if (err.status === 400)  key = 'STOCK.ERROR_BAD_INPUT';
    else if (err.status === 502)  key = 'STOCK.ERROR_UPSTREAM';
    else                          key = 'STOCK.ERROR_GENERIC';
    this.errorMessage = key;
    this.errorDetail = '';
  }

  /** Curated shortlist of mega-caps - these are always visible in the dropdown. */
  private buildDefaultSymbols(): StockSymbol[] {
    return [
      { symbol: 'AAPL',  name: 'Apple Inc',          exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'MSFT',  name: 'Microsoft',          exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'GOOGL', name: 'Alphabet (Google)',  exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'AMZN',  name: 'Amazon',             exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'NVDA',  name: 'Nvidia',             exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'META',  name: 'Meta Platforms',     exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'TSLA',  name: 'Tesla',              exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'NFLX',  name: 'Netflix',            exchange: 'NASDAQ', currency: 'USD' },
      { symbol: 'JPM',   name: 'JPMorgan Chase',     exchange: 'NYSE',   currency: 'USD' },
      { symbol: 'V',     name: 'Visa',               exchange: 'NYSE',   currency: 'USD' },
      { symbol: 'BRK.B', name: 'Berkshire Hathaway', exchange: 'NYSE',   currency: 'USD' },
      { symbol: 'XOM',   name: 'Exxon Mobil',        exchange: 'NYSE',   currency: 'USD' },
      { symbol: 'KO',    name: 'Coca-Cola',          exchange: 'NYSE',   currency: 'USD' },
      { symbol: 'DIS',   name: 'Disney',             exchange: 'NYSE',   currency: 'USD' }
    ];
  }
}
