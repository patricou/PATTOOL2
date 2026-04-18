import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subscription, timer } from 'rxjs';

import { ApiService, FrankfurterRates } from './api.service';

/**
 * A single quote shown in the marquee (e.g. "EUR/USD = 1.0876 +0.12%").
 * {@code previousRate} is the value from the snapshot BEFORE the current refresh,
 * used to compute the intraday variation shown in the UI.
 */
export interface CurrencyQuote {
  base: string;
  quote: string;
  rate: number;
  previousRate: number | null;
  variationPct: number | null;
  date: string;
}

/**
 * Global state for the live currency-rate ticker.
 *
 * <p>Mounted once by {@code AppComponent} under the news ticker, shown on every
 * route when enabled. Visibility and pairs are driven by the Currency Converter
 * page ; this service only handles the data lifecycle.</p>
 *
 * <p>Persistence policy (aligned with NewsTickerService): the ticker is not
 * persisted across page reloads ; it always starts OFF. Unlike the news
 * ticker, Frankfurter is unrate-limited, so users can leave it ON freely
 * during a session.</p>
 */
@Injectable({ providedIn: 'root' })
export class CurrencyTickerService implements OnDestroy {

  /** Refresh cadence — BCE publishes once a day, 10 min is more than enough. */
  private static readonly REFRESH_MS = 10 * 60 * 1000;

  /** Default pairs shown when the user enables the ticker. */
  private static readonly DEFAULT_PAIRS: Array<{ base: string; quote: string }> = [
    { base: 'EUR', quote: 'USD' },
    { base: 'EUR', quote: 'GBP' },
    { base: 'EUR', quote: 'JPY' },
    { base: 'EUR', quote: 'CHF' },
    { base: 'EUR', quote: 'CNY' },
    { base: 'EUR', quote: 'CAD' },
    { base: 'EUR', quote: 'AUD' },
    { base: 'USD', quote: 'JPY' },
    { base: 'GBP', quote: 'USD' }
  ];

  private readonly _enabled$ = new BehaviorSubject<boolean>(false);
  private readonly _quotes$ = new BehaviorSubject<CurrencyQuote[]>([]);
  private readonly _loading$ = new BehaviorSubject<boolean>(false);

  private refreshSub?: Subscription;
  private lastSnapshotByKey = new Map<string, number>();

  constructor(private api: ApiService) {}

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
  }

  // ---------- Public API ----------

  get enabled$(): Observable<boolean> {
    return this._enabled$.asObservable();
  }

  get quotes$(): Observable<CurrencyQuote[]> {
    return this._quotes$.asObservable();
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
      this._quotes$.next([]);
    }
  }

  toggle(): void {
    this.setEnabled(!this._enabled$.value);
  }

  refresh(): void {
    if (!this._enabled$.value) return;
    this.fetchQuotes();
  }

  // ---------- Internals ----------

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshSub = timer(0, CurrencyTickerService.REFRESH_MS).subscribe(() => this.fetchQuotes());
  }

  private stopAutoRefresh(): void {
    this.refreshSub?.unsubscribe();
    this.refreshSub = undefined;
  }

  /**
   * Pull every distinct base currency in a single request each
   * (Frankfurter only accepts one base per call), then fan-out the result
   * into the individual pairs we actually want to display.
   */
  private fetchQuotes(): void {
    this._loading$.next(true);

    const bases = Array.from(new Set(CurrencyTickerService.DEFAULT_PAIRS.map((p) => p.base)));
    const results: CurrencyQuote[] = [];
    let pending = bases.length;

    if (pending === 0) {
      this._loading$.next(false);
      return;
    }

    for (const base of bases) {
      const quotesForBase = CurrencyTickerService.DEFAULT_PAIRS
        .filter((p) => p.base === base)
        .map((p) => p.quote);

      this.api.getLatestRates(base, quotesForBase).subscribe({
        next: (res: FrankfurterRates) => {
          quotesForBase.forEach((quote) => {
            const rate = res?.rates?.[quote];
            if (typeof rate !== 'number') return;
            const key = `${base}/${quote}`;
            const previous = this.lastSnapshotByKey.get(key) ?? null;
            const variationPct = previous !== null && previous !== 0
              ? +(((rate - previous) / previous) * 100).toFixed(3)
              : null;
            results.push({
              base,
              quote,
              rate,
              previousRate: previous,
              variationPct,
              date: res?.date || ''
            });
            this.lastSnapshotByKey.set(key, rate);
          });
          if (--pending === 0) this.publish(results);
        },
        error: () => {
          if (--pending === 0) this.publish(results);
        }
      });
    }
  }

  private publish(results: CurrencyQuote[]): void {
    // Preserve the configured order (defaults array) so the marquee doesn't
    // shuffle visually when some requests return faster than others.
    const order = new Map<string, number>();
    CurrencyTickerService.DEFAULT_PAIRS.forEach((p, i) => order.set(`${p.base}/${p.quote}`, i));
    results.sort((a, b) => {
      const ka = order.get(`${a.base}/${a.quote}`) ?? 999;
      const kb = order.get(`${b.base}/${b.quote}`) ?? 999;
      return ka - kb;
    });
    this._quotes$.next(results);
    this._loading$.next(false);
  }
}
