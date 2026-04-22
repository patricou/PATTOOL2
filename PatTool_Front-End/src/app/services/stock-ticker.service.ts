import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subscription, timer } from 'rxjs';

import { ApiService, StockQuote } from './api.service';

/**
 * A single ticker item (e.g. "AAPL 171.50 +0.94%").
 * {@code previousRate} is the value from the snapshot BEFORE the current
 * refresh - used to compute the intra-refresh variation shown in the UI,
 * independently from the day-change the API returns in {@code percent_change}.
 *
 * The day-change (vs. previous close) is kept in {@code dayChangePct} so the
 * banner can show the more meaningful "since yesterday" number while the
 * intra-refresh variation is used for the up / down color flash.
 */
export interface StockTickerItem {
  symbol: string;
  name?: string;
  currency?: string;
  price: number;
  previousPrice: number | null;
  variationPct: number | null;
  dayChangePct: number | null;
  isMarketOpen?: boolean;
  datetime?: string;
  /** Initials of the most recent user who loaded this symbol (e.g. "PD"). */
  lastLoadedBy?: string;
  /** Up to 5 unique initials, most-recent first. */
  loadedBy?: string[];
}

/**
 * Global state for the live stock-quote ticker.
 *
 * <p><b>Zero-quota design.</b> This ticker <u>never</u> calls Twelve Data
 * directly. It polls {@code GET /api/external/stock/quote/cached}, which
 * returns a snapshot of the backend's in-memory quote cache. The cache is
 * populated organically whenever a user loads a quote on the Stock Exchange
 * page (or any page that hits {@code /quote}). In other words: the ticker
 * displays what users have recently looked up, and costs zero API credits.</p>
 *
 * <p>If the cache is empty (nobody has searched anything yet, or every entry
 * has expired), the ticker simply shows nothing - the banner will be hidden
 * by the UI's "empty" branch. First search → first entry on the ribbon.</p>
 *
 * <p>Because the data source is a local HashMap, we can poll fairly often
 * (30 s is plenty) without any upstream impact.</p>
 */
@Injectable({ providedIn: 'root' })
export class StockTickerService implements OnDestroy {

  /**
   * How often we re-read the backend cache. No quota is spent, so we can
   * afford a short interval - it only costs a local HashMap lookup.
   */
  private static readonly REFRESH_MS = 30 * 1000;

  /** Hard cap on the number of items shown, to keep the marquee readable. */
  private static readonly MAX_ITEMS = 30;

  private readonly _enabled$ = new BehaviorSubject<boolean>(false);
  private readonly _items$ = new BehaviorSubject<StockTickerItem[]>([]);
  private readonly _loading$ = new BehaviorSubject<boolean>(false);

  private refreshSub?: Subscription;
  private lastSnapshotBySymbol = new Map<string, number>();

  constructor(private api: ApiService) {}

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
  }

  // ---------- Public API ----------

  get enabled$(): Observable<boolean> {
    return this._enabled$.asObservable();
  }

  get items$(): Observable<StockTickerItem[]> {
    return this._items$.asObservable();
  }

  get loading$(): Observable<boolean> {
    return this._loading$.asObservable();
  }

  get isEnabled(): boolean {
    return this._enabled$.value;
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled$.value === enabled) {
      return;
    }
    this._enabled$.next(enabled);
    if (enabled) {
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
      this._items$.next([]);
    }
  }

  toggle(): void {
    this.setEnabled(!this._enabled$.value);
  }

  refresh(): void {
    if (!this._enabled$.value) return;
    this.fetchQuotes();
  }

  /**
   * Force a cache read regardless of the ticker's enabled state. Called
   * from the stock-exchange page after the user successfully loads a new
   * quote so the ticker (if visible) reflects the newcomer immediately
   * instead of waiting for the next 30 s polling tick. The backend call is
   * a local HashMap read — free, no quota cost.
   */
  refreshNow(): void {
    this.fetchQuotes();
  }

  /**
   * Clear the server-side quote cache (and thus the ticker). Also wipes the
   * local "previous price" memory so the intra-refresh variation restarts
   * from a clean slate, and empties the currently-displayed items so the
   * user immediately sees the banner go blank / hidden. Other users'
   * sessions will see their own tickers clear on their next poll.
   */
  clearCache(): Observable<{ removed: number }> {
    return new Observable((subscriber) => {
      this._loading$.next(true);
      this.api.clearCachedStockQuotes().subscribe({
        next: (res) => {
          this.lastSnapshotBySymbol.clear();
          this._items$.next([]);
          this._loading$.next(false);
          subscriber.next(res);
          subscriber.complete();
        },
        error: (err) => {
          this._loading$.next(false);
          subscriber.error(err);
        }
      });
    });
  }

  // ---------- Internals ----------

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshSub = timer(0, StockTickerService.REFRESH_MS).subscribe(() => this.fetchQuotes());
  }

  private stopAutoRefresh(): void {
    this.refreshSub?.unsubscribe();
    this.refreshSub = undefined;
  }

  /**
   * Read the backend's quote cache snapshot. Zero Twelve Data credits spent.
   * The backend returns a symbol-keyed map of whatever is currently cached
   * (populated by user-driven /quote calls on the Stock Exchange page).
   */
  private fetchQuotes(): void {
    this._loading$.next(true);

    this.api.getCachedStockQuotes().subscribe({
      next: (map) => {
        const results: StockTickerItem[] = [];
        const entries = Object.entries(map ?? {});

        for (const [symbol, q] of entries) {
          if (!q) continue;

          const price = parseFloat(q.close ?? '');
          if (!isFinite(price)) continue;

          const previous = this.lastSnapshotBySymbol.get(symbol) ?? null;
          const variationPct = previous !== null && previous !== 0
            ? +(((price - previous) / previous) * 100).toFixed(3)
            : null;

          const dayChange = parseFloat(q.percent_change ?? '');
          const dayChangePct = isFinite(dayChange) ? +dayChange.toFixed(3) : null;

          results.push({
            symbol,
            name: q.name,
            currency: q.currency,
            price,
            previousPrice: previous,
            variationPct,
            dayChangePct,
            isMarketOpen: q.is_market_open,
            datetime: q.datetime,
            lastLoadedBy: q.last_loaded_by,
            loadedBy: q.loaded_by
          });

          this.lastSnapshotBySymbol.set(symbol, price);
        }

        this.publish(results);
      },
      error: () => {
        this._loading$.next(false);
      }
    });
  }

  /**
   * Sort alphabetically by symbol (stable across refreshes, so the marquee
   * doesn't jump) and cap to {@link #MAX_ITEMS}.
   */
  private publish(results: StockTickerItem[]): void {
    results.sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (results.length > StockTickerService.MAX_ITEMS) {
      results.length = StockTickerService.MAX_ITEMS;
    }
    this._items$.next(results);
    this._loading$.next(false);
  }
}
