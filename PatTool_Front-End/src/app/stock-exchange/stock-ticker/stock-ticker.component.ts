import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { StockTickerItem, StockTickerService } from '../../services/stock-ticker.service';

/**
 * Global scrolling stock-quote banner. Mounted once by {@code AppComponent}
 * so it appears on every route when enabled. Visibility and content are
 * driven entirely by {@link StockTickerService}; this component only handles
 * presentation.
 *
 * Stacking order under the navbar (top to bottom):
 *   1. news-ticker (56px, two rows)
 *   2. currency-ticker (40px)
 *   3. stock-ticker (40px)   &lt;-- this component
 *
 * Each row knows whether the previous ones are visible via the body-level
 * classes set by AppComponent ({@code pat-has-news-ticker}, {@code pat-has-currency-ticker}).
 */
@Component({
  selector: 'app-stock-ticker',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './stock-ticker.component.html',
  styleUrls: ['./stock-ticker.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StockTickerComponent implements OnDestroy {

  enabled = false;
  loading = false;
  items: StockTickerItem[] = [];

  private subs: Subscription[] = [];

  constructor(private ticker: StockTickerService, private cdr: ChangeDetectorRef) {
    this.subs.push(
      this.ticker.enabled$.subscribe((v) => {
        this.enabled = v;
        this.cdr.markForCheck();
      }),
      this.ticker.items$.subscribe((q) => {
        this.items = q;
        this.cdr.markForCheck();
      }),
      this.ticker.loading$.subscribe((v) => {
        this.loading = v;
        this.cdr.markForCheck();
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  trackByIndex(i: number): number {
    return i;
  }

  /** Day-change coloring (up / down / flat), vs. previous close. */
  variationClass(q: StockTickerItem): string {
    if (q.dayChangePct === null || q.dayChangePct === 0) return 'var-flat';
    return q.dayChangePct > 0 ? 'var-up' : 'var-down';
  }

  variationSymbol(q: StockTickerItem): string {
    if (q.dayChangePct === null || q.dayChangePct === 0) return '\u2022';
    return q.dayChangePct > 0 ? '\u25B2' : '\u25BC';
  }

  /** Formatted day change with explicit sign, e.g. {@code +0.94%}. */
  formatDayChange(q: StockTickerItem): string {
    if (q.dayChangePct === null) return '\u2014';
    const sign = q.dayChangePct > 0 ? '+' : '';
    return `${sign}${q.dayChangePct.toFixed(2)}%`;
  }

  /** Stock prices span a wide range (penny stocks to $5000 BRK.A) - format adaptively. */
  formatPrice(q: StockTickerItem): string {
    if (q.price >= 1000) return q.price.toFixed(2);
    if (q.price >= 10) return q.price.toFixed(2);
    if (q.price >= 1) return q.price.toFixed(3);
    return q.price.toFixed(4);
  }

  /**
   * Hover / screen-reader text for the initials cluster, e.g.
   * {@code "Looked up by: PD, JS, AR"}. Keeps the visible badges compact
   * while still exposing the full list.
   */
  loadersTooltip(q: StockTickerItem): string {
    const initials = q.loadedBy ?? [];
    if (initials.length === 0) return '';
    return `Looked up by: ${initials.join(', ')}`;
  }
}
