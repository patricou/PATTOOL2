import { ChangeDetectorRef, Component, OnDestroy, OnInit, SecurityContext, ViewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { Subscription } from 'rxjs';

import {
  ApiService,
  CernApiCatalog,
  CernOpenDataRecordDetail,
  CernOpenDataRecordSummary,
  CernOpenDataSearchResult,
  CernRepositorySearchResult
} from '../services/api.service';

Chart.register(...registerables);

interface ChartEntry {
  label: string;
  value: number;
}

@Component({
  selector: 'app-cern',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective],
  templateUrl: './cern.component.html',
  styleUrls: ['./cern.component.css']
})
export class CernComponent implements OnInit, OnDestroy {

  @ViewChild('experimentChart') experimentChart?: BaseChartDirective;
  @ViewChild('yearChart') yearChart?: BaseChartDirective;
  @ViewChild('typeChart') typeChart?: BaseChartDirective;
  @ViewChild('availabilityChart') availabilityChart?: BaseChartDirective;
  @ViewChild('catalogChart') catalogChart?: BaseChartDirective;
  @ViewChild('filesChart') filesChart?: BaseChartDirective;
  @ViewChild('repositoryChart') repositoryChart?: BaseChartDirective;
  @ViewChild('zenodoSubjectChart') zenodoSubjectChart?: BaseChartDirective;
  @ViewChild('zenodoYearChart') zenodoYearChart?: BaseChartDirective;
  @ViewChild('zenodoTypeChart') zenodoTypeChart?: BaseChartDirective;
  @ViewChild('zenodoAccessChart') zenodoAccessChart?: BaseChartDirective;
  @ViewChild('experimentPolarChart') experimentPolarChart?: BaseChartDirective;
  @ViewChild('collisionEnergyChart') collisionEnergyChart?: BaseChartDirective;
  @ViewChild('collisionTypeChart') collisionTypeChart?: BaseChartDirective;
  @ViewChild('collisionBubbleChart') collisionBubbleChart?: BaseChartDirective;
  @ViewChild('recordCollisionChart') recordCollisionChart?: BaseChartDirective;

  catalog: CernApiCatalog | null = null;
  openDataQuery = 'Higgs';
  openDataExperiment = '';
  openDataPage = 1;
  openDataSize = 10;
  openDataResult: CernOpenDataSearchResult | null = null;
  selectedRecord: CernOpenDataRecordDetail | null = null;
  selectedRecid: number | null = null;

  repositoryQuery = 'LHC';
  repositoryPage = 1;
  repositoryMode: 'records' | 'communities' = 'records';
  repositoryResult: CernRepositorySearchResult | null = null;

  zenodoQuery = 'CERN';
  zenodoPage = 1;
  zenodoResult: CernOpenDataSearchResult | null = null;

  isLoadingCatalog = false;
  isLoadingOpenData = false;
  isLoadingRecord = false;
  isLoadingRepository = false;
  isLoadingZenodo = false;
  errorMessage = '';

  readonly experimentOptions = ['', 'CMS', 'ATLAS', 'ALICE', 'LHCb', 'DELPHI'];

  catalogChartData: ChartConfiguration<'doughnut'>['data'] = { labels: [], datasets: [] };
  experimentChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  yearChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  typeChartData: ChartConfiguration<'doughnut'>['data'] = { labels: [], datasets: [] };
  availabilityChartData: ChartConfiguration<'doughnut'>['data'] = { labels: [], datasets: [] };
  filesChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  repositoryChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  zenodoSubjectChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  zenodoYearChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  zenodoTypeChartData: ChartConfiguration<'doughnut'>['data'] = { labels: [], datasets: [] };
  zenodoAccessChartData: ChartConfiguration<'doughnut'>['data'] = { labels: [], datasets: [] };
  experimentPolarChartData: ChartConfiguration<'polarArea'>['data'] = { labels: [], datasets: [] };
  collisionEnergyChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };
  collisionTypeChartData: ChartConfiguration<'doughnut'>['data'] = { labels: [], datasets: [] };
  collisionBubbleChartData: ChartConfiguration<'bubble'>['data'] = { datasets: [] };
  recordCollisionChartData: ChartConfiguration<'bar'>['data'] = { labels: [], datasets: [] };

  private static readonly EXPERIMENT_COLORS: Record<string, string> = {
    CMS: '#2563eb',
    ATLAS: '#ca8a04',
    ALICE: '#dc2626',
    LHCb: '#16a34a',
    DELPHI: '#9333ea',
    OPERA: '#ea580c',
    TOTEM: '#0891b2'
  };

  polarOptions: ChartOptions<'polarArea'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
    }
  };

  bubbleOptions: ChartOptions<'bubble'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const raw = ctx.raw as { label?: string; x?: number; y?: number };
            const tev = raw?.x != null ? `${raw.x} TeV` : '';
            const n = raw?.y != null ? `${raw.y} records` : '';
            return [raw?.label ?? '', tev, n].filter(Boolean).join(' · ');
          }
        }
      }
    },
    scales: {
      x: {
        title: { display: true, text: '√s (TeV)' },
        beginAtZero: true
      },
      y: {
        title: { display: true, text: 'Records in index' },
        beginAtZero: true,
        ticks: { precision: 0 }
      }
    }
  };

  recordCollisionBarOptions: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: {
      x: { beginAtZero: true, display: false },
      y: { ticks: { font: { size: 11 } } }
    }
  };

  barOptions: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: {
      x: { beginAtZero: true, ticks: { precision: 0 } }
    }
  };

  barVerticalOptions: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      y: { beginAtZero: true, ticks: { precision: 0 } }
    }
  };

  doughnutOptions: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
    }
  };

  filesBarOptions: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => this.formatBytes(ctx.parsed.x as number)
        }
      }
    },
    scales: {
      x: {
        beginAtZero: true,
        ticks: {
          callback: (v) => this.formatBytes(Number(v))
        }
      }
    }
  };

  private static readonly PALETTE = [
    '#0d6efd', '#6610f2', '#6f42c1', '#d63384', '#dc3545',
    '#fd7e14', '#ffc107', '#198754', '#20c997', '#0dcaf0',
    '#6c757d', '#343a40'
  ];

  private subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService,
    private sanitizer: DomSanitizer
  ) {}

  /** Renders API text/HTML via [innerHTML] after Angular sanitization. */
  toSafeHtml(value: string | null | undefined): SafeHtml {
    const raw = value ?? '';
    const cleaned = this.sanitizer.sanitize(SecurityContext.HTML, raw) ?? '';
    return this.sanitizer.bypassSecurityTrustHtml(cleaned);
  }

  ngOnInit(): void {
    this.loadCatalog();
    this.searchOpenData();
    this.searchRepository();
    this.searchZenodo();
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  loadCatalog(): void {
    this.isLoadingCatalog = true;
    this.errorMessage = '';
    const sub = this.api.getCernCatalog().subscribe({
      next: (catalog) => {
        this.catalog = catalog;
        this.buildCatalogChart();
        this.isLoadingCatalog = false;
        this.refreshCharts();
        this.cdr.markForCheck();
      },
      error: () => {
        this.errorMessage = 'CERN.ERROR_CATALOG';
        this.isLoadingCatalog = false;
        this.cdr.markForCheck();
      }
    });
    this.subs.push(sub);
  }

  searchOpenData(): void {
    this.isLoadingOpenData = true;
    this.errorMessage = '';
    this.selectedRecord = null;
    this.selectedRecid = null;
    this.filesChartData = { labels: [], datasets: [] };
    this.recordCollisionChartData = { labels: [], datasets: [] };
    const sub = this.api
      .searchCernOpenData(
        this.openDataQuery.trim() || undefined,
        this.openDataSize,
        this.openDataPage,
        this.openDataExperiment || undefined
      )
      .subscribe({
        next: (result) => {
          this.openDataResult = result;
          this.buildOpenDataCharts();
          this.isLoadingOpenData = false;
          this.refreshCharts();
          this.cdr.markForCheck();
        },
        error: () => {
          this.errorMessage = 'CERN.ERROR_OPENDATA';
          this.isLoadingOpenData = false;
          this.cdr.markForCheck();
        }
      });
    this.subs.push(sub);
  }

  openRecord(rec: CernOpenDataRecordSummary): void {
    if (!rec?.recid) {
      return;
    }
    this.selectedRecid = rec.recid;
    this.isLoadingRecord = true;
    this.errorMessage = '';
    const sub = this.api.getCernOpenDataRecord(rec.recid).subscribe({
      next: (detail) => {
        this.selectedRecord = detail;
        this.buildFilesChart();
        this.buildRecordCollisionChart();
        this.isLoadingRecord = false;
        this.refreshCharts();
        this.cdr.markForCheck();
      },
      error: () => {
        this.errorMessage = 'CERN.ERROR_RECORD';
        this.isLoadingRecord = false;
        this.cdr.markForCheck();
      }
    });
    this.subs.push(sub);
  }

  searchZenodo(): void {
    this.isLoadingZenodo = true;
    this.errorMessage = '';
    const sub = this.api
      .searchCernZenodo(this.zenodoQuery.trim() || undefined, 10, this.zenodoPage)
      .subscribe({
        next: (result) => {
          this.zenodoResult = result;
          this.buildZenodoCharts();
          this.isLoadingZenodo = false;
          this.refreshCharts();
          this.cdr.markForCheck();
        },
        error: () => {
          this.errorMessage = 'CERN.ERROR_ZENODO';
          this.isLoadingZenodo = false;
          this.cdr.markForCheck();
        }
      });
    this.subs.push(sub);
  }

  hasZenodoCharts(): boolean {
    return !!(
      this.zenodoSubjectChartData.labels?.length ||
      this.zenodoYearChartData.labels?.length ||
      this.zenodoTypeChartData.labels?.length
    );
  }

  zenodoPortalUrl(recid: number): string {
    return `https://zenodo.org/records/${recid}`;
  }

  searchRepository(): void {
    this.isLoadingRepository = true;
    this.errorMessage = '';
    const sub =
      this.repositoryMode === 'communities'
        ? this.api.getCernRepositoryCommunities(10, this.repositoryPage).subscribe({
            next: (result) => this.onRepositoryLoaded(result),
            error: () => this.onRepositoryError()
          })
        : this.api
            .searchCernRepository(
              this.repositoryQuery.trim() || undefined,
              10,
              this.repositoryPage
            )
            .subscribe({
              next: (result) => this.onRepositoryLoaded(result),
              error: () => this.onRepositoryError()
            });
    this.subs.push(sub);
  }

  statusClass(status: string): string {
    if (status === 'online') {
      return 'text-success';
    }
    if (status === 'offline') {
      return 'text-danger';
    }
    return 'text-warning';
  }

  statusLabelKey(status: string): string {
    if (status === 'online') {
      return 'CERN.STATUS_ONLINE';
    }
    if (status === 'offline') {
      return 'CERN.STATUS_OFFLINE';
    }
    return 'CERN.STATUS_UNKNOWN';
  }

  hasOpenDataCharts(): boolean {
    return !!(
      this.experimentChartData.labels?.length ||
      this.yearChartData.labels?.length ||
      this.typeChartData.labels?.length
    );
  }

  hasLhcCharts(): boolean {
    return !!(
      this.experimentPolarChartData.labels?.length ||
      this.collisionEnergyChartData.labels?.length ||
      this.collisionTypeChartData.labels?.length ||
      this.collisionBubbleChartData.datasets[0]?.data?.length
    );
  }

  hasRecordCollisionChart(): boolean {
    return !!this.recordCollisionChartData.labels?.length;
  }

  collisionTypeLabel(key: string): string {
    const k = (key || '').trim().toLowerCase();
    const map: Record<string, string> = {
      pp: 'Proton–proton (pp)',
      'p-p': 'Proton–proton',
      pbpb: 'Lead–lead (Pb–Pb)',
      'pb-pb': 'Lead–lead',
      pbp: 'Proton–lead (pPb)',
      'e+e-': 'e⁺e⁻',
      'e+e': 'e⁺e⁻'
    };
    return map[k] ?? key;
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  private onRepositoryLoaded(result: CernRepositorySearchResult): void {
    this.repositoryResult = result;
    this.buildRepositoryChart();
    this.isLoadingRepository = false;
    this.refreshCharts();
    this.cdr.markForCheck();
  }

  private onRepositoryError(): void {
    this.errorMessage = 'CERN.ERROR_REPOSITORY';
    this.isLoadingRepository = false;
    this.cdr.markForCheck();
  }

  private buildCatalogChart(): void {
    if (!this.catalog?.sources?.length) {
      this.catalogChartData = { labels: [], datasets: [] };
      return;
    }
    const online = this.catalog.sources.filter((s) => s.status === 'online').length;
    const offline = this.catalog.sources.length - online;
    this.catalogChartData = {
      labels: [
        this.translate.instant('CERN.STATUS_ONLINE'),
        this.translate.instant('CERN.STATUS_OFFLINE')
      ],
      datasets: [{
        data: [online, offline],
        backgroundColor: ['#198754', '#dc3545'],
        borderWidth: 1
      }]
    };
  }

  private buildZenodoCharts(): void {
    const r = this.zenodoResult;
    if (!r) {
      return;
    }
    this.zenodoSubjectChartData = this.barDataset(
      this.mapCounts(r.categoryCounts, 10),
      this.translate.instant('CERN.CHART_SUBJECTS'),
      '#6f42c1'
    );
    this.zenodoYearChartData = this.barDatasetVertical(
      this.mapCounts(r.yearCounts, 12, true),
      this.translate.instant('CERN.CHART_YEARS'),
      '#fd7e14'
    );
    this.zenodoTypeChartData = this.doughnutDataset(this.mapCounts(r.typeCounts, 8));
    this.zenodoAccessChartData = this.doughnutDataset(this.mapCounts(r.availabilityCounts, 6));
  }

  private buildOpenDataCharts(): void {
    const r = this.openDataResult;
    if (!r) {
      return;
    }

    const experiments = this.mapCounts(r.experimentCounts, 10);
    this.experimentChartData = {
      labels: experiments.map((e) => e.label),
      datasets: [{
        label: this.translate.instant('CERN.CHART_EXPERIMENTS'),
        data: experiments.map((e) => e.value),
        backgroundColor: experiments.map((e) => this.experimentColor(e.label)),
        borderWidth: 0
      }]
    };

    const years = this.mapCounts(r.yearCounts, 12, true);
    this.yearChartData = this.barDatasetVertical(
      years,
      this.translate.instant('CERN.CHART_YEARS'),
      '#6610f2'
    );

    const types = this.mapCounts(r.typeCounts, 8);
    this.typeChartData = this.doughnutDataset(types);

    const availability = this.mapCounts(r.availabilityCounts, 6);
    this.availabilityChartData = this.doughnutDataset(availability);

    this.buildLhcCharts();
  }

  private buildLhcCharts(): void {
    const r = this.openDataResult;
    if (!r) {
      return;
    }

    const experiments = this.mapCounts(r.experimentCounts, 8);
    this.experimentPolarChartData = {
      labels: experiments.map((e) => e.label),
      datasets: [{
        data: experiments.map((e) => e.value),
        backgroundColor: experiments.map((e) => this.experimentColor(e.label))
      }]
    };

    const energies = this.mapCollisionEnergyCounts(r.collisionEnergyCounts, 12);
    this.collisionEnergyChartData = {
      labels: energies.map((e) => e.label),
      datasets: [{
        label: this.translate.instant('CERN.CHART_COLLISION_ENERGY'),
        data: energies.map((e) => e.value),
        backgroundColor: '#0ea5e9',
        borderWidth: 0
      }]
    };

    const collisions = this.mapCounts(r.collisionTypeCounts, 8).map((e) => ({
      label: this.collisionTypeLabel(e.label),
      value: e.value
    }));
    this.collisionTypeChartData = {
      labels: collisions.map((e) => e.label),
      datasets: [{
        data: collisions.map((e) => e.value),
        backgroundColor: ['#f59e0b', '#ef4444', '#8b5cf6', '#10b981', '#6366f1', '#ec4899', '#14b8a6', '#64748b']
      }]
    };

    const bubblePoints = energies
      .map((e) => {
        const tev = this.parseEnergyTeV(e.label);
        return {
          label: e.label,
          x: tev > 0 ? tev : 0.1,
          y: e.value,
          r: Math.min(24, 5 + Math.sqrt(e.value) / 120)
        };
      })
      .filter((p) => p.y > 0);

    this.collisionBubbleChartData = {
      datasets: [{
        label: this.translate.instant('CERN.CHART_COLLISION_BUBBLE'),
        data: bubblePoints as { x: number; y: number; r: number; label?: string }[],
        backgroundColor: 'rgba(14, 165, 233, 0.5)',
        borderColor: '#0284c7',
        borderWidth: 1
      }]
    };
  }

  private buildRecordCollisionChart(): void {
    const rec = this.selectedRecord;
    if (!rec) {
      this.recordCollisionChartData = { labels: [], datasets: [] };
      return;
    }
    const entries: ChartEntry[] = [];
    if (rec.experiments.length) {
      entries.push({ label: this.translate.instant('CERN.COL_EXPERIMENT'), value: rec.experiments.length });
    }
    const tev = rec.collisionEnergy ? this.parseEnergyTeV(rec.collisionEnergy) : 0;
    if (tev > 0) {
      entries.push({ label: `${this.translate.instant('CERN.CHART_COLLISION_ENERGY')} (${rec.collisionEnergy})`, value: tev });
    } else if (rec.collisionEnergy) {
      entries.push({ label: rec.collisionEnergy, value: 1 });
    }
    if (rec.collisionType) {
      entries.push({ label: this.collisionTypeLabel(rec.collisionType), value: 1 });
    }
    const events = this.parseNumberEvents(rec.numberEvents);
    if (events > 0) {
      entries.push({ label: this.translate.instant('CERN.NUMBER_EVENTS'), value: events });
    }
    this.recordCollisionChartData = {
      labels: entries.map((e) => e.label),
      datasets: [{
        data: entries.map((e) => e.value),
        backgroundColor: entries.map((_, i) => CernComponent.PALETTE[i % CernComponent.PALETTE.length]),
        borderWidth: 0
      }]
    };
  }

  private buildFilesChart(): void {
    const files = this.selectedRecord?.files ?? [];
    const entries: ChartEntry[] = files
      .filter((f) => typeof f.size === 'number' && (f.size as number) > 0)
      .map((f) => ({
        label: (f.key || 'file').length > 28 ? (f.key as string).slice(0, 25) + '…' : (f.key as string),
        value: f.size as number
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);

    this.filesChartData = {
      labels: entries.map((e) => e.label),
      datasets: [{
        label: this.translate.instant('CERN.CHART_FILE_SIZES'),
        data: entries.map((e) => e.value),
        backgroundColor: '#20c997',
        borderWidth: 0
      }]
    };
  }

  private buildRepositoryChart(): void {
    const counts: Record<string, number> = {};
    for (const rec of this.repositoryResult?.records ?? []) {
      const key = (rec.resourceType || rec.publicationDate || '—').trim() || '—';
      counts[key] = (counts[key] || 0) + 1;
    }
    const entries = this.mapCounts(counts, 10);
    this.repositoryChartData = this.barDataset(
      entries,
      this.translate.instant('CERN.CHART_REPOSITORY_PAGE'),
      '#fd7e14'
    );
  }

  private experimentColor(name: string): string {
    const key = (name || '').trim().toUpperCase();
    return CernComponent.EXPERIMENT_COLORS[key] ?? CernComponent.PALETTE[key.length % CernComponent.PALETTE.length];
  }

  private parseEnergyTeV(label: string): number {
    const s = (label || '').trim();
    const tev = s.match(/([\d.]+)\s*TeV/i);
    if (tev) {
      return parseFloat(tev[1]);
    }
    const gev = s.match(/([\d.]+)\s*GeV/i);
    if (gev) {
      return parseFloat(gev[1]) / 1000;
    }
    const rangeGev = s.match(/([\d.]+)\s*-\s*([\d.]+)\s*GeV/i);
    if (rangeGev) {
      return (parseFloat(rangeGev[1]) + parseFloat(rangeGev[2])) / 2 / 1000;
    }
    return 0;
  }

  private parseNumberEvents(raw: string | undefined): number {
    if (!raw) {
      return 0;
    }
    const n = parseFloat(raw.replace(/[^\d.eE+-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  private mapCollisionEnergyCounts(map: Record<string, number> | undefined, limit: number): ChartEntry[] {
    if (!map) {
      return [];
    }
    return Object.entries(map)
      .map(([label, value]) => ({ label: label.trim(), value: Number(value) || 0 }))
      .sort((a, b) => this.parseEnergyTeV(b.label) - this.parseEnergyTeV(a.label))
      .slice(0, limit);
  }

  private mapCounts(
    map: Record<string, number> | undefined,
    limit: number,
    sortYearsDesc = false
  ): ChartEntry[] {
    if (!map) {
      return [];
    }
    let entries = Object.entries(map).map(([label, value]) => ({
      label: label.trim(),
      value: Number(value) || 0
    }));
    if (sortYearsDesc) {
      entries = entries
        .filter((e) => /^\d{4}$/.test(e.label))
        .sort((a, b) => Number(b.label) - Number(a.label));
    } else {
      entries.sort((a, b) => b.value - a.value);
    }
    return entries.slice(0, limit);
  }

  private barDataset(entries: ChartEntry[], label: string, color: string): ChartConfiguration<'bar'>['data'] {
    return {
      labels: entries.map((e) => e.label),
      datasets: [{
        label,
        data: entries.map((e) => e.value),
        backgroundColor: color,
        borderWidth: 0
      }]
    };
  }

  private barDatasetVertical(entries: ChartEntry[], label: string, color: string): ChartConfiguration<'bar'>['data'] {
    const reversed = [...entries].reverse();
    return {
      labels: reversed.map((e) => e.label),
      datasets: [{
        label,
        data: reversed.map((e) => e.value),
        backgroundColor: color,
        borderWidth: 0
      }]
    };
  }

  private doughnutDataset(entries: ChartEntry[]): ChartConfiguration<'doughnut'>['data'] {
    return {
      labels: entries.map((e) => e.label),
      datasets: [{
        data: entries.map((e) => e.value),
        backgroundColor: entries.map((_, i) => CernComponent.PALETTE[i % CernComponent.PALETTE.length]),
        borderWidth: 1
      }]
    };
  }

  private refreshCharts(): void {
    setTimeout(() => {
      this.experimentChart?.update();
      this.yearChart?.update();
      this.typeChart?.update();
      this.availabilityChart?.update();
      this.catalogChart?.update();
      this.filesChart?.update();
      this.repositoryChart?.update();
      this.zenodoSubjectChart?.update();
      this.zenodoYearChart?.update();
      this.zenodoTypeChart?.update();
      this.zenodoAccessChart?.update();
      this.experimentPolarChart?.update();
      this.collisionEnergyChart?.update();
      this.collisionTypeChart?.update();
      this.collisionBubbleChart?.update();
      this.recordCollisionChart?.update();
    }, 0);
  }
}
