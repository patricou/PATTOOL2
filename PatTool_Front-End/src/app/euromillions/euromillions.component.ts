import { ChangeDetectorRef, Component, OnInit, TemplateRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { finalize, timeout, catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';

import { ApiService, EuromillionsDrawRow, EuromillionsSyncResult } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { AssistantLaunchService } from '../services/assistant-launch.service';

Chart.register(...registerables);

export type EuromSortColumn = 'date' | 'combo' | 'gain' | 'code';

@Component({
  selector: 'app-euromillions',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective],
  templateUrl: './euromillions.component.html',
  styleUrls: ['./euromillions.component.css']
})
export class EuromillionsComponent implements OnInit {

  draws: EuromillionsDrawRow[] = [];
  tableLoaded = false;
  loading = true;
  syncing = false;
  errorMessage = '';
  syncMessage = '';
  lastSyncResult: EuromillionsSyncResult | null = null;

  sortColumn: EuromSortColumn = 'date';
  sortAsc = false;

  monthlyChartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  monthlyChartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'top' },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed.y;
            return `${ctx.dataset.label ?? ''}: ${v != null && !Number.isNaN(v) ? v : '—'}`;
          }
        }
      }
    },
    scales: {
      x: {
        title: { display: true }
      },
      y: {
        type: 'linear',
        position: 'left',
        min: 0,
        max: 50,
        ticks: { stepSize: 5 },
        title: { display: true }
      },
      y1: {
        type: 'linear',
        position: 'right',
        min: 0,
        max: 12,
        grid: { drawOnChartArea: false },
        ticks: { stepSize: 1 },
        title: { display: true }
      }
    }
  };
  chartHasData = false;

  jsonExportText = '';
  private jsonExportStamp = '';

  dateDrafts: Record<string, string> = {};
  savingDrawId: string | null = null;
  dateEditMode = false;

  resultFilterDateFrom = '';
  resultFilterDateTo = '';

  constructor(
    private api: ApiService,
    private keycloak: KeycloakService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef,
    private modalService: NgbModal,
    private assistantLaunch: AssistantLaunchService
  ) {
    this.applyChartAxisTitles();
  }

  ngOnInit(): void {
    this.refreshTable();
  }

  private applyChartAxisTitles(): void {
    const y = this.monthlyChartOptions.scales?.['y'];
    const y1 = this.monthlyChartOptions.scales?.['y1'];
    const x = this.monthlyChartOptions.scales?.['x'];
    if (y && 'title' in y && y.title && typeof y.title === 'object') {
      (y.title as { text?: string }).text = this.translate.instant('EUROMILLIONS.CHART_AXIS_Y_BALLS');
    }
    if (y1 && 'title' in y1 && y1.title && typeof y1.title === 'object') {
      (y1.title as { text?: string }).text = this.translate.instant('EUROMILLIONS.CHART_AXIS_Y_STARS');
    }
    if (x && 'title' in x && x.title && typeof x.title === 'object') {
      (x.title as { text?: string }).text = this.translate.instant('EUROMILLIONS.CHART_AXIS_X');
    }
  }

  get canRunSync(): boolean {
    return this.keycloak.hasAdminRole();
  }

  get canEditDrawDates(): boolean {
    return this.keycloak.hasAdminRole();
  }

  get canSendEuromAiPrompt(): boolean {
    return this.keycloak.isLoggedIn() && !this.loading && !this.syncing && this.draws.length > 0;
  }

  get sortedDraws(): EuromillionsDrawRow[] {
    const copy = [...this.draws];
    const dir = this.sortAsc ? 1 : -1;
    copy.sort((a, b) => this.compareRows(a, b) * dir);
    return copy;
  }

  private compareRows(a: EuromillionsDrawRow, b: EuromillionsDrawRow): number {
    switch (this.sortColumn) {
      case 'date':
        return a.drawDate.localeCompare(b.drawDate);
      case 'combo':
        return this.comboSortKey(a).localeCompare(this.comboSortKey(b));
      case 'gain':
        return this.gainSortKey(a).localeCompare(this.gainSortKey(b));
      case 'code':
        return (a.drawCode || '').localeCompare(b.drawCode || '');
      default:
        return 0;
    }
  }

  private comboSortKey(row: EuromillionsDrawRow): string {
    const n = [...(row.numbers || [])].sort((x, y) => x - y);
    const s = [...(row.stars || [])].sort((x, y) => x - y);
    return `${n.map(String).join('-')}|${s.map(String).join('-')}`;
  }

  private gainSortKey(row: EuromillionsDrawRow): string {
    const g = row.gainDisplay || '';
    const letters = g.replace(/[0-9\s.,]/g, '').toLowerCase();
    const digits = g.replace(/\D/g, '');
    if (digits.length > 0) {
      return digits.padStart(14, '0') + letters;
    }
    return g.toLowerCase();
  }

  toggleSort(column: EuromSortColumn): void {
    if (this.sortColumn === column) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortColumn = column;
      this.sortAsc = column === 'combo' || column === 'gain' || column === 'code';
    }
    this.cdr.markForCheck();
  }

  sortIconClass(column: EuromSortColumn): string {
    if (this.sortColumn !== column) {
      return 'fa fa-sort text-muted opacity-50 small';
    }
    return this.sortAsc ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc';
  }

  refreshTable(): void {
    this.loading = true;
    this.errorMessage = '';
    this.api.getEuromillionsDraws().pipe(
      finalize(() => {
        this.loading = false;
        this.tableLoaded = true;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (rows) => {
        this.draws = rows ?? [];
        this.rebuildDateDrafts();
      },
      error: () => {
        this.errorMessage = this.translate.instant('EUROMILLIONS.LOAD_ERROR');
      }
    });
  }

  get displayedDraws(): EuromillionsDrawRow[] {
    const rows = this.sortedDraws;
    const from = this.resultFilterDateFrom?.trim() ?? '';
    const to = this.resultFilterDateTo?.trim() ?? '';
    if (!from && !to) {
      return rows;
    }
    return rows.filter((r) => {
      const d = this.isoDateOnly(r.drawDate);
      if (!d) {
        return false;
      }
      if (from && d < from) {
        return false;
      }
      if (to && d > to) {
        return false;
      }
      return true;
    });
  }

  clearResultDateFilters(): void {
    this.resultFilterDateFrom = '';
    this.resultFilterDateTo = '';
    this.cdr.markForCheck();
  }

  private isoDateOnly(raw: string | undefined): string {
    if (!raw) {
      return '';
    }
    return raw.length >= 10 ? raw.slice(0, 10) : raw;
  }

  private rebuildDateDrafts(): void {
    const next: Record<string, string> = {};
    for (const r of this.draws) {
      if (r.drawCode) {
        next[r.drawCode] = this.isoDateOnly(r.drawDate);
      }
    }
    this.dateDrafts = next;
  }

  onDateDraftChange(drawCode: string | undefined, value: string): void {
    if (!drawCode) {
      return;
    }
    this.dateDrafts[drawCode] = value;
  }

  isDateDraftUnchanged(row: EuromillionsDrawRow): boolean {
    const id = row.drawCode;
    if (!id) {
      return true;
    }
    const draft = this.dateDrafts[id] ?? '';
    return draft === this.isoDateOnly(row.drawDate);
  }

  toggleDateEditMode(): void {
    if (this.savingDrawId) {
      return;
    }
    this.dateEditMode = !this.dateEditMode;
    this.rebuildDateDrafts();
    this.cdr.markForCheck();
  }

  saveDrawDate(row: EuromillionsDrawRow): void {
    const id = row.drawCode;
    if (!id || !this.canEditDrawDates || !this.dateEditMode) {
      return;
    }
    const drawDate = this.dateDrafts[id];
    if (!drawDate) {
      return;
    }
    this.savingDrawId = id;
    this.errorMessage = '';
    this.api
      .patchEuromillionsDrawDate({ id, drawDate })
      .pipe(
        finalize(() => {
          this.savingDrawId = null;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (updated) => {
          const idx = this.draws.findIndex((x) => x.drawCode === id);
          if (idx >= 0) {
            this.draws[idx] = {
              ...this.draws[idx],
              drawDate: updated?.drawDate ?? drawDate
            };
          }
          this.dateDrafts[id] = this.isoDateOnly(updated?.drawDate ?? drawDate);
        },
        error: (err: { status?: number; error?: { message?: string }; message?: string }) => {
          if (err?.status === 403) {
            this.errorMessage = this.translate.instant('EUROMILLIONS.DATE_SAVE_FORBIDDEN');
            return;
          }
          const apiMsg =
            (typeof err?.error === 'object' && err?.error && 'message' in err.error && (err.error as { message?: string }).message) ||
            err?.message ||
            String(err);
          this.errorMessage = this.translate.instant('EUROMILLIONS.DATE_SAVE_ERROR', { detail: apiMsg });
        }
      });
  }

  syncCsvFromServer(): void {
    if (!this.canRunSync) {
      this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_ADMIN_ONLY');
      return;
    }
    this.syncMessage = '';
    this.lastSyncResult = null;
    this.syncing = true;
    this.api
      .syncEuromillionsFromCsv()
      .pipe(
        timeout(300000),
        catchError((err) => {
          if (err?.status === 403) {
            this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_ADMIN_ONLY');
            return of(null);
          }
          const apiMsg =
            (typeof err?.error === 'object' && err?.error?.message) ||
            err?.message ||
            String(err);
          this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_FAILED', { detail: apiMsg });
          return of(null);
        }),
        finalize(() => {
          this.syncing = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe((res) => {
        if (res) {
          this.lastSyncResult = res;
          this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_DONE', {
            files: res.filesProcessed,
            draws: res.drawsUpserted,
            skipped: res.rowsSkipped
          });
          this.refreshTable();
        }
      });
  }

  numbersLine(row: EuromillionsDrawRow): string {
    const nLine = row.numbers?.length ? row.numbers.join(', ') : '—';
    const sLine = row.stars?.length ? row.stars.join(' & ') : '—';
    return `${nLine} — ${this.translate.instant('EUROMILLIONS.STARS_LABEL')} ${sLine}`;
  }

  private euromDrawsChronologicalForAi(): Array<{
    drawDate: string;
    numbers: number[];
    stars: number[];
  }> {
    const copy = [...this.draws];
    copy.sort((a, b) => a.drawDate.localeCompare(b.drawDate));
    return copy.map((d) => ({
      drawDate: d.drawDate,
      numbers: [...(d.numbers ?? [])],
      stars: [...(d.stars ?? [])]
    }));
  }

  private buildEuromAiJsonPayload(): {
    recordCount: number;
    draws: Array<{ drawDate: string; numbers: number[]; stars: number[] }>;
  } {
    const draws = this.euromDrawsChronologicalForAi();
    return { recordCount: draws.length, draws };
  }

  /**
   * JSON minimal pour l’assistant : {@code c} = nombre de lignes ;
   * {@code d} = {@code [ "YYYYMMDD", [5 boules], [étoile1, étoile2] ]} par tirage, ordre chronologique.
   */
  private buildEuromAiJsonPayloadCompact(): { c: number; d: [string, number[], number[]][] } {
    const rows = this.euromDrawsChronologicalForAi();
    const d = rows.map(
      (r) =>
        [this.toAiYyyymmdd(r.drawDate), [...(r.numbers ?? [])], [...(r.stars ?? [])]] as [
          string,
          number[],
          number[]
        ]
    );
    return { c: d.length, d };
  }

  private toAiYyyymmdd(raw: string): string {
    const s = (raw ?? '').trim();
    if (/^\d{8}$/.test(s)) {
      return s;
    }
    if (s.length >= 10 && s.charAt(4) === '-' && s.charAt(7) === '-') {
      return s.slice(0, 10).replace(/-/g, '');
    }
    const digits = s.replace(/\D/g, '');
    return digits.length >= 8 ? digits.slice(0, 8) : digits.padStart(8, '0');
  }

  sendEuromAiPrompt1(ev?: Event): void {
    ev?.stopPropagation();
    ev?.preventDefault();
    if (!this.canSendEuromAiPrompt) {
      return;
    }
    const payloadVerbose = this.buildEuromAiJsonPayload();
    const payloadCompact = this.buildEuromAiJsonPayloadCompact();
    const intro = this.translate.instant('EUROMILLIONS.AI_MESSAGE_1');
    const recordLine = this.translate.instant('EUROMILLIONS.AI_RECORD_COUNT_LINE', {
      n: payloadVerbose.recordCount
    });
    const jsonIntro = this.translate.instant('EUROMILLIONS.AI_JSON_BLOCK_INTRO');
    const jsonBlock = JSON.stringify(payloadCompact);
    const body = `${intro}\n\n${recordLine}\n\n${jsonIntro}\n\n${jsonBlock}`;
    this.assistantLaunch.openWithDraft(body, {
      newConversation: true,
      autoSend: false,
      toolFlags: { webSearch: false, imageGeneration: false, mcp: false }
    });
  }

  openExportJsonModal(content: TemplateRef<unknown>): void {
    if (!this.draws.length) {
      return;
    }
    const exportedAt = new Date().toISOString();
    this.jsonExportStamp = exportedAt.slice(0, 19).replace(/[:T]/g, '-');
    const payload = this.buildEuromAiJsonPayload();
    this.jsonExportText = JSON.stringify(payload, null, 2);
    this.modalService.open(content, {
      size: 'xl',
      scrollable: true,
      centered: true,
      windowClass: 'eurom-ai-json-modal'
    });
    this.cdr.markForCheck();
  }

  downloadExportJsonFile(): void {
    if (!this.jsonExportText) {
      return;
    }
    const blob = new Blob([this.jsonExportText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `euromillions-ai-${this.jsonExportStamp}.json`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  copyExportJson(): void {
    if (!this.jsonExportText || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }
    navigator.clipboard.writeText(this.jsonExportText).catch(() => undefined);
  }

  openChartModal(content: TemplateRef<unknown>): void {
    this.buildMonthlyChart();
    this.applyChartAxisTitles();
    this.modalService.open(content, {
      size: 'xl',
      scrollable: true,
      centered: true
    });
  }

  private buildMonthlyChart(): void {
    type Bucket = { sums: number[]; starSums: number[]; n: number };
    const byMonth = new Map<string, Bucket>();
    for (const row of this.draws) {
      if (!row.drawDate || row.drawDate.length < 7) {
        continue;
      }
      const ym = row.drawDate.substring(0, 7);
      const nums = [...(row.numbers || [])].sort((x, y) => x - y);
      if (nums.length !== 5) {
        continue;
      }
      const sts = [...(row.stars || [])].sort((x, y) => x - y);
      if (sts.length !== 2) {
        continue;
      }
      let bucket = byMonth.get(ym);
      if (!bucket) {
        bucket = { sums: [0, 0, 0, 0, 0], starSums: [0, 0], n: 0 };
        byMonth.set(ym, bucket);
      }
      for (let i = 0; i < 5; i++) {
        bucket.sums[i] += nums[i];
      }
      bucket.starSums[0] += sts[0];
      bucket.starSums[1] += sts[1];
      bucket.n += 1;
    }

    const labels = [...byMonth.keys()].sort();
    if (labels.length === 0) {
      this.chartHasData = false;
      this.monthlyChartData = { labels: [], datasets: [] };
      return;
    }

    const colors = ['#1d4ed8', '#059669', '#ca8a04', '#9333ea', '#ea580c'];
    const round2 = (v: number): number => Math.round(v * 100) / 100;

    const datasets = [0, 1, 2, 3, 4].map((idx) => {
      const data = labels.map((ym) => {
        const b = byMonth.get(ym)!;
        return b.n ? round2(b.sums[idx] / b.n) : null;
      });
      return {
        data,
        label: this.translate.instant('EUROMILLIONS.CHART_SERIES_N', { i: idx + 1 }),
        yAxisID: 'y',
        borderColor: colors[idx],
        backgroundColor: colors[idx],
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
        fill: false,
        tension: 0.15
      };
    });

    const star1 = labels.map((ym) => {
      const b = byMonth.get(ym)!;
      return b.n ? round2(b.starSums[0] / b.n) : null;
    });
    const star2 = labels.map((ym) => {
      const b = byMonth.get(ym)!;
      return b.n ? round2(b.starSums[1] / b.n) : null;
    });

    datasets.push({
      data: star1,
      label: this.translate.instant('EUROMILLIONS.CHART_SERIES_STAR_1'),
      yAxisID: 'y1',
      borderColor: '#b45309',
      backgroundColor: '#b45309',
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2,
      fill: false,
      tension: 0.15
    });
    datasets.push({
      data: star2,
      label: this.translate.instant('EUROMILLIONS.CHART_SERIES_STAR_2'),
      yAxisID: 'y1',
      borderColor: '#7c3aed',
      backgroundColor: '#7c3aed',
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2,
      fill: false,
      tension: 0.15
    });

    this.chartHasData = true;
    this.monthlyChartData = { labels, datasets };
    this.cdr.markForCheck();
  }
}
