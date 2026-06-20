import { ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { Subscription, Subject, interval } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import {
  ApiService,
  CryptoCoinQuote,
  CryptoMarketChartResponse,
  CryptoPricesResponse
} from '../services/api.service';

Chart.register(...registerables);

interface ChartCoinOption {
  id: string;
  symbol: string;
  name: string;
}

/** Page Cryptos — cours BTC, ETH, altcoins et historique via proxy CoinGecko. */
@Component({
  selector: 'app-cryptos',
  templateUrl: './cryptos.component.html',
  styleUrls: ['./cryptos.component.css'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective]
})
export class CryptosComponent implements OnInit, OnDestroy {

  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;

  /** Devise d'affichage principale. */
  vs: 'eur' | 'usd' = 'eur';

  data: CryptoPricesResponse | null = null;
  errorMessage = '';
  historyError = '';
  historyStale = false;
  isLoading = false;
  isLoadingHistory = false;
  lastUpdatedLabel = '';

  chartCoinId = 'bitcoin';
  chartCoinOptions: ChartCoinOption[] = [];
  rangeDays = 30;
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
          label: (ctx) => {
            const y = ctx.parsed.y as number;
            const cur = this.vs === 'eur' ? '€' : '$';
            return `${ctx.dataset.label}: ${y.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${cur}`;
          }
        }
      }
    },
    scales: {
      x: { ticks: { maxTicksLimit: 8 } },
      y: {
        ticks: {
          callback: (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
        }
      }
    }
  };

  private refreshSub?: Subscription;
  private historySub?: Subscription;
  private readonly historyRequest$ = new Subject<void>();
  private readonly historyClientCache = new Map<string, CryptoMarketChartResponse>();
  private historyFetchSeq = 0;
  private readonly refreshMs = 60_000;

  constructor(
    private readonly api: ApiService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadPrices();
    this.historySub = this.historyRequest$.pipe(debounceTime(450)).subscribe(() => this.fetchHistory());
    this.queueHistoryLoad();
    this.refreshSub = interval(this.refreshMs).subscribe(() => this.loadPrices(true));
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.historySub?.unsubscribe();
  }

  loadPrices(silent = false): void {
    if (!silent) {
      this.isLoading = true;
      this.errorMessage = '';
    }
    this.api.getCryptoPrices().subscribe({
      next: (res) => {
        this.data = res;
        this.errorMessage = '';
        this.isLoading = false;
        this.lastUpdatedLabel = this.formatUpdatedAt(res?.updatedAt);
        this.rebuildChartCoinOptions(res);
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoading = false;
        if (!this.data) {
          this.errorMessage = 'CRYPTOS.ERROR';
        }
        this.cdr.markForCheck();
      }
    });
  }

  loadHistory(): void {
    this.queueHistoryLoad();
  }

  private queueHistoryLoad(): void {
    this.historyRequest$.next();
  }

  private historyCacheKey(): string {
    return `${this.chartCoinId}|${this.vs}|${this.rangeDays}`;
  }

  private fetchHistory(): void {
    if (!this.chartCoinId) {
      return;
    }
    const key = this.historyCacheKey();
    const cached = this.historyClientCache.get(key);
    if (cached?.points?.length) {
      this.applyHistoryResponse(cached);
    }

    const seq = ++this.historyFetchSeq;
    this.isLoadingHistory = !cached?.points?.length;
    this.historyError = '';
    this.api.getCryptoMarketChart(this.chartCoinId, this.vs, this.rangeDays).subscribe({
      next: (res) => {
        if (seq !== this.historyFetchSeq) {
          return;
        }
        if (res?.points?.length) {
          this.historyClientCache.set(key, res);
        }
        this.applyHistoryResponse(res);
      },
      error: () => {
        if (seq !== this.historyFetchSeq) {
          return;
        }
        this.isLoadingHistory = false;
        if (cached?.points?.length) {
          this.historyStale = true;
          this.historyError = 'CRYPTOS.HISTORY_STALE';
          this.cdr.markForCheck();
          return;
        }
        this.historyStale = false;
        this.historyError = 'CRYPTOS.HISTORY_RATE_LIMIT';
        this.chartData = { labels: [], datasets: [] };
        this.chart?.update();
        this.cdr.markForCheck();
      }
    });
  }

  onVsChange(): void {
    this.queueHistoryLoad();
    this.cdr.markForCheck();
  }

  setChartCoin(id: string): void {
    if (!id || id === this.chartCoinId) {
      return;
    }
    this.chartCoinId = id;
    this.queueHistoryLoad();
  }

  setRange(days: number): void {
    if (this.rangeDays === days) {
      return;
    }
    this.rangeDays = days;
    this.queueHistoryLoad();
  }

  isChartCoin(id: string | undefined): boolean {
    return !!id && id === this.chartCoinId;
  }

  chartCoinLabel(): string {
    const opt = this.chartCoinOptions.find((c) => c.id === this.chartCoinId);
    return opt ? `${opt.symbol} · ${opt.name}` : this.chartCoinId;
  }

  priceOf(coin: CryptoCoinQuote | null | undefined): number | null {
    if (!coin) {
      return null;
    }
    const v = this.vs === 'eur' ? coin.priceEur : coin.priceUsd;
    return v != null && Number.isFinite(v) ? v : null;
  }

  changeOf(coin: CryptoCoinQuote | null | undefined): number | null {
    if (!coin) {
      return null;
    }
    const v = this.vs === 'eur' ? coin.change24hPctEur : coin.change24hPctUsd;
    return v != null && Number.isFinite(v) ? v : null;
  }

  currencyLabel(): string {
    return this.vs === 'eur' ? '€' : '$';
  }

  changeClass(pct: number | null): string {
    if (pct == null) {
      return '';
    }
    if (pct > 0) {
      return 'chg-up';
    }
    if (pct < 0) {
      return 'chg-down';
    }
    return 'chg-flat';
  }

  formatMarketCap(coin: CryptoCoinQuote | null | undefined): string | null {
    if (!coin?.marketCapEur || this.vs !== 'eur') {
      return null;
    }
    const cap = coin.marketCapEur;
    if (cap >= 1e12) {
      return (cap / 1e12).toFixed(2) + ' T€';
    }
    if (cap >= 1e9) {
      return (cap / 1e9).toFixed(2) + ' Md€';
    }
    if (cap >= 1e6) {
      return (cap / 1e6).toFixed(1) + ' M€';
    }
    return null;
  }

  private applyHistoryResponse(res: CryptoMarketChartResponse | null): void {
    this.isLoadingHistory = false;
    if (!res?.points?.length) {
      this.historyStale = false;
      this.historyError = 'CRYPTOS.NO_HISTORY';
      this.chartData = { labels: [], datasets: [] };
      this.chart?.update();
      this.cdr.markForCheck();
      return;
    }
    this.historyStale = !!res.stale;
    this.historyError = res.stale ? 'CRYPTOS.HISTORY_STALE' : '';
    const labels = res.points.map((p) =>
      new Date(p.timestampMs).toLocaleDateString(undefined, {
        day: '2-digit',
        month: 'short',
        year: res.points!.length > 120 ? '2-digit' : undefined
      })
    );
    const values = res.points.map((p) => p.price);
    const sym = res.symbol || this.chartCoinId.toUpperCase();
    const cur = this.vs === 'eur' ? 'EUR' : 'USD';
    const colors = this.chartColorsForCoin(res.id || this.chartCoinId);

    this.chartData = {
      labels,
      datasets: [
        {
          label: `${sym} · ${cur}`,
          data: values,
          borderColor: colors.border,
          backgroundColor: colors.fill,
          pointRadius: values.length > 90 ? 0 : 2,
          pointHoverRadius: 4,
          tension: 0.25,
          fill: true,
          spanGaps: true
        }
      ]
    };
    this.cdr.markForCheck();
    this.chart?.update();
  }

  private chartColorsForCoin(id: string): { border: string; fill: string } {
    if (id === 'bitcoin') {
      return { border: '#f7931a', fill: 'rgba(247, 147, 26, 0.12)' };
    }
    if (id === 'ethereum') {
      return { border: '#627eea', fill: 'rgba(98, 126, 234, 0.12)' };
    }
    return { border: '#6f42c1', fill: 'rgba(111, 66, 193, 0.12)' };
  }

  private rebuildChartCoinOptions(res: CryptoPricesResponse | null): void {
    const opts: ChartCoinOption[] = [];
    if (res?.btc?.id) {
      opts.push({ id: res.btc.id, symbol: res.btc.symbol, name: res.btc.name });
    }
    if (res?.eth?.id) {
      opts.push({ id: res.eth.id, symbol: res.eth.symbol, name: res.eth.name });
    }
    for (const alt of res?.altcoins ?? []) {
      if (alt.id) {
        opts.push({ id: alt.id, symbol: alt.symbol, name: alt.name });
      }
    }
    this.chartCoinOptions = opts;
    if (opts.length && !opts.some((o) => o.id === this.chartCoinId)) {
      this.chartCoinId = opts[0].id;
      this.queueHistoryLoad();
    }
  }

  private formatUpdatedAt(iso: string | undefined): string {
    if (!iso) {
      return '';
    }
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
}
