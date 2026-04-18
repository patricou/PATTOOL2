import { ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { ApiService, FrankfurterRates, FrankfurterTimeseries } from '../services/api.service';
import { CurrencyTickerService } from '../services/currency-ticker.service';

Chart.register(...registerables);

/**
 * Currency converter page backed by the Frankfurter proxy (ECB rates).
 *
 * Responsibilities :
 * <ul>
 *   <li>Convert a custom amount between two user-picked ISO currencies.</li>
 *   <li>Render the last 30 days of the selected pair as a line chart.</li>
 *   <li>Toggle the global exchange-rate ticker (mounted by AppComponent).</li>
 * </ul>
 *
 * Data source notes :
 * <ul>
 *   <li>Frankfurter updates rates once per ECB publish cycle (≈ weekdays 16:00 CET).</li>
 *   <li>The backend proxy caches GET responses ; see {@code FrankfurterProxyService}.</li>
 *   <li>Weekends/holidays are simply missing in the timeseries — the chart omits them.</li>
 * </ul>
 */
@Component({
  selector: 'app-currency-converter',
  templateUrl: './currency-converter.component.html',
  styleUrls: ['./currency-converter.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective]
})
export class CurrencyConverterComponent implements OnInit, OnDestroy {

  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;

  // ----- Inputs -----
  amount = 1;
  from = 'CHF';
  to = 'EUR';

  // ----- State -----
  currencies: { code: string; name: string }[] = [];
  latest: FrankfurterRates | null = null;
  timeseries: FrankfurterTimeseries | null = null;
  converted: number | null = null;
  lastUpdated: string | null = null;
  errorMessage = '';
  isLoadingRate = false;
  isLoadingHistory = false;
  isLoadingCurrencies = false;

  /** Time window for the chart, in days. */
  rangeDays = 30;

  /** Currency ticker visibility (pushed by {@link CurrencyTickerService}). */
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
          label: (ctx) => `${ctx.dataset.label}: ${(ctx.parsed.y as number).toFixed(4)}`
        }
      }
    },
    scales: {
      x: { title: { display: false } },
      y: { title: { display: true, text: 'Rate' }, ticks: { callback: (v) => Number(v).toFixed(4) } }
    }
  };

  private readonly inputs$ = new Subject<void>();
  private subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private ticker: CurrencyTickerService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadCurrencies();
    this.refresh();

    this.subs.push(
      this.inputs$.pipe(debounceTime(300)).subscribe(() => this.refresh()),
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

  onInputChanged(): void {
    this.inputs$.next();
  }

  /** Swap source and target currencies, then refresh. */
  swap(): void {
    const tmp = this.from;
    this.from = this.to;
    this.to = tmp;
    this.refresh();
  }

  /** Change the chart's time window (7 / 30 / 90 / 365 days). */
  setRange(days: number): void {
    if (this.rangeDays === days) return;
    this.rangeDays = days;
    this.loadTimeseries();
  }

  /**
   * Fetch the latest spot rate for the selected pair AND the historical
   * timeseries in parallel. Called on every input change (debounced).
   */
  refresh(): void {
    this.errorMessage = '';
    if (!this.from || !this.to) {
      return;
    }
    this.loadLatest();
    this.loadTimeseries();
  }

  toggleTicker(): void {
    this.ticker.setEnabled(!this.tickerEnabled);
  }

  // ----- Derived helpers for the template -----

  /** Return the friendly name of a currency code (falls back to the code itself). */
  currencyName(code: string): string {
    if (!code) return '';
    const match = this.currencies.find((c) => c.code === code);
    return match ? match.name : code;
  }

  /** One unit of {@code from} expressed in {@code to} (for the secondary display). */
  get unitRate(): number | null {
    if (!this.latest || !this.latest.rates) return null;
    const r = this.latest.rates[this.to];
    return typeof r === 'number' ? r : null;
  }

  // ----- Internals -----

  private loadCurrencies(): void {
    this.isLoadingCurrencies = true;
    this.api.getCurrencies().subscribe({
      next: (map) => {
        this.currencies = Object.entries(map)
          .map(([code, name]) => ({ code, name }))
          .sort((a, b) => a.code.localeCompare(b.code));
        this.isLoadingCurrencies = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingCurrencies = false;
        // Non-fatal: the selects fall back to a hard-coded shortlist.
        this.currencies = this.fallbackCurrencies();
        this.cdr.markForCheck();
      }
    });
  }

  private loadLatest(): void {
    if (this.from === this.to) {
      this.latest = { amount: 1, base: this.from, date: new Date().toISOString().slice(0, 10), rates: { [this.to]: 1 } };
      this.converted = this.amount;
      this.lastUpdated = this.latest.date;
      return;
    }
    this.isLoadingRate = true;
    this.api.getLatestRates(this.from, [this.to]).subscribe({
      next: (res) => {
        this.latest = res;
        const rate = res?.rates?.[this.to];
        this.converted = typeof rate === 'number' ? +(rate * this.amount).toFixed(6) : null;
        this.lastUpdated = res?.date || null;
        this.isLoadingRate = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.errorMessage = this.extractErrorMessage(err);
        this.converted = null;
        this.isLoadingRate = false;
        this.cdr.markForCheck();
      }
    });
  }

  private loadTimeseries(): void {
    if (this.from === this.to) {
      this.chartData = { labels: [], datasets: [] };
      this.timeseries = null;
      this.chart?.update();
      return;
    }
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - this.rangeDays);
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);

    this.isLoadingHistory = true;
    this.api.getTimeseriesRates(startIso, endIso, this.from, [this.to]).subscribe({
      next: (res) => {
        this.timeseries = res;
        this.applyChart(res);
        this.isLoadingHistory = false;
        this.cdr.markForCheck();
        this.chart?.update();
      },
      error: (err) => {
        this.errorMessage = this.extractErrorMessage(err);
        this.isLoadingHistory = false;
        this.cdr.markForCheck();
      }
    });
  }

  private applyChart(ts: FrankfurterTimeseries | null): void {
    if (!ts || !ts.rates) {
      this.chartData = { labels: [], datasets: [] };
      return;
    }
    const dates = Object.keys(ts.rates).sort();
    const values = dates.map((d) => ts.rates[d]?.[this.to]).filter((v) => typeof v === 'number') as number[];
    const labels = dates.filter((d) => typeof ts.rates[d]?.[this.to] === 'number');

    this.chartData = {
      labels,
      datasets: [
        {
          label: `${this.from} → ${this.to}`,
          data: values,
          borderColor: '#0d6efd',
          backgroundColor: 'rgba(13, 110, 253, 0.12)',
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: true
        }
      ]
    };
  }

  private extractErrorMessage(err: any): string {
    if (!err) return '';
    if (err.status === 0) return 'CURRENCY.ERROR_NETWORK';
    if (err.status === 400) return 'CURRENCY.ERROR_BAD_INPUT';
    if (err.status === 502) return 'CURRENCY.ERROR_UPSTREAM';
    return 'CURRENCY.ERROR_GENERIC';
  }

  /** Minimal fallback shortlist in case {@code /currencies} is unavailable. */
  private fallbackCurrencies(): { code: string; name: string }[] {
    return [
      { code: 'EUR', name: 'Euro' },
      { code: 'USD', name: 'US Dollar' },
      { code: 'GBP', name: 'British Pound' },
      { code: 'JPY', name: 'Japanese Yen' },
      { code: 'CHF', name: 'Swiss Franc' },
      { code: 'CNY', name: 'Chinese Yuan' },
      { code: 'CAD', name: 'Canadian Dollar' },
      { code: 'AUD', name: 'Australian Dollar' },
      { code: 'SEK', name: 'Swedish Krona' },
      { code: 'NOK', name: 'Norwegian Krone' }
    ];
  }
}
