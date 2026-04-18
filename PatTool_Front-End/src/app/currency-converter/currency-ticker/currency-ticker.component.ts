import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { CurrencyQuote, CurrencyTickerService } from '../../services/currency-ticker.service';

/**
 * Global scrolling currency-rate banner. Mounted once by {@code AppComponent}
 * so it appears on every route when enabled. Visibility and content are driven
 * entirely by {@link CurrencyTickerService} ; this component only handles
 * presentation.
 *
 * Layout: one marquee row stacking directly below the news ticker when both
 * are visible. The item list is duplicated in the template so translating the
 * track by -50% of its own width loops seamlessly.
 */
@Component({
  selector: 'app-currency-ticker',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './currency-ticker.component.html',
  styleUrls: ['./currency-ticker.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CurrencyTickerComponent implements OnDestroy {

  enabled = false;
  loading = false;
  quotes: CurrencyQuote[] = [];

  private subs: Subscription[] = [];

  constructor(private ticker: CurrencyTickerService, private cdr: ChangeDetectorRef) {
    this.subs.push(
      this.ticker.enabled$.subscribe((v) => {
        this.enabled = v;
        this.cdr.markForCheck();
      }),
      this.ticker.quotes$.subscribe((q) => {
        this.quotes = q;
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

  hasQuotes(): boolean {
    return this.quotes.length > 0;
  }

  trackByIndex(i: number): number {
    return i;
  }

  /** CSS class for variation coloring (up / down / flat). */
  variationClass(q: CurrencyQuote): string {
    if (q.variationPct === null || q.variationPct === 0) return 'var-flat';
    return q.variationPct > 0 ? 'var-up' : 'var-down';
  }

  variationSymbol(q: CurrencyQuote): string {
    if (q.variationPct === null || q.variationPct === 0) return '•';
    return q.variationPct > 0 ? '▲' : '▼';
  }

  /** Formatted pct with explicit sign, e.g. {@code +0.12%}. */
  formatVariation(q: CurrencyQuote): string {
    if (q.variationPct === null) return '—';
    const sign = q.variationPct > 0 ? '+' : '';
    return `${sign}${q.variationPct.toFixed(2)}%`;
  }

  /** Rates are tiny decimals — show 4 digits so USD/JPY (≈150) still looks right. */
  formatRate(q: CurrencyQuote): string {
    if (q.rate >= 100) return q.rate.toFixed(2);
    if (q.rate >= 10) return q.rate.toFixed(3);
    return q.rate.toFixed(4);
  }
}
