import { ChangeDetectorRef, Component, OnInit, TemplateRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { finalize, timeout, catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';

import { ApiService, LotoDrawRow, LotoSyncResult } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { AssistantLaunchService } from '../services/assistant-launch.service';

Chart.register(...registerables);

/** yyyy-MM for today (local calendar). */
function currentIsoYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const LOTTO_ARCHIVE_MIN_YM = '2008-10';
const LOTTO_ARCHIVE_MAX_YM = '2026-05';

/**
 * Mois civil courant pour la plage d’import (début et fin par défaut), plafonné au dernier mois de l’archive.
 */
function defaultImportYearMonth(): string {
  const n = currentIsoYearMonth();
  return n <= LOTTO_ARCHIVE_MAX_YM ? n : LOTTO_ARCHIVE_MAX_YM;
}

export type LotoSortColumn = 'date' | 'combo' | 'gain' | 'link';

@Component({
  selector: 'app-loto',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective],
  templateUrl: './loto.component.html',
  styleUrls: ['./loto.component.css']
})
export class LotoComponent implements OnInit {

  /** Catalogue LesBonsNumeros : oct. 2008 — mai 2026 (aligné backend). */
  readonly lotoArchiveMinYm = LOTTO_ARCHIVE_MIN_YM;
  readonly lotoArchiveMaxYm = LOTTO_ARCHIVE_MAX_YM;

  draws: LotoDrawRow[] = [];
  /** True après le premier chargement terminé (ouverture de la page, Rafraîchir, ou fin d’import). */
  tableLoaded = false;
  /** True au montage pour éviter un flash avant le premier GET MongoDB. */
  loading = true;
  syncing = false;
  errorMessage = '';
  syncMessage = '';
  lastSyncResult: LotoSyncResult | null = null;

  /** Plage d’import (défaut : début et fin = mois en cours, plafonné archive). */
  syncStartYm = defaultImportYearMonth();
  syncEndYm = defaultImportYearMonth();

  /** Tri du tableau : date décroissante par défaut (plus récent en haut). */
  sortColumn: LotoSortColumn = 'date';
  /** true = ascendant, false = descendant */
  sortAsc = false;

  /** Courbe : données agrégées par mois (moyenne des numéros triés + Chance). */
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
        min: 0,
        max: 49,
        ticks: { stepSize: 5 },
        title: { display: true }
      }
    }
  };
  chartHasData = false;

  /** Contenu JSON affiché dans la modale « Exporter ». */
  jsonExportText = '';
  /** Horodatage pour le nom de fichier au téléchargement. */
  private jsonExportStamp = '';

  /** Brouillons de date (yyyy-MM-dd) par clé = URL fiche, pour l’édition admin. */
  dateDrafts: Record<string, string> = {};
  /** Ligne en cours d’enregistrement (même valeur que detailUrl). */
  savingDrawId: string | null = null;
  /**
   * Admin : les champs date ne sont éditables qu’après « Modifier les dates »
   * (désactivé par défaut pour éviter les changements accidentels).
   */
  dateEditMode = false;

  /** Filtre du tableau des résultats (dates de tirage inclusives, ISO yyyy-MM-dd). */
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
    this.clampPeriodPickersToBounds();
  }

  ngOnInit(): void {
    this.refreshTable();
  }

  /** Garde les mois choisis dans les bornes archive + fin ≤ mois courant / dernier mois catalogue. */
  private clampPeriodPickersToBounds(): void {
    const lo = this.lotoArchiveMinYm;
    const hiArchive = this.lotoArchiveMaxYm;
    const hiEnd = this.maxSelectableYm;
    const clamp = (s: string, min: string, max: string) => (s < min ? min : s > max ? max : s);
    this.syncStartYm = clamp(this.syncStartYm, lo, hiArchive);
    this.syncEndYm = clamp(this.syncEndYm, lo, hiEnd);
  }

  private applyChartAxisTitles(): void {
    const y = this.monthlyChartOptions.scales?.['y'];
    const x = this.monthlyChartOptions.scales?.['x'];
    if (y && 'title' in y && y.title && typeof y.title === 'object') {
      (y.title as { text?: string }).text = this.translate.instant('LOTTO.CHART_AXIS_Y');
    }
    if (x && 'title' in x && x.title && typeof x.title === 'object') {
      (x.title as { text?: string }).text = this.translate.instant('LOTTO.CHART_AXIS_X');
    }
  }

  /** Fin d’archive : le plus petit de « aujourd’hui » et du dernier mois catalogué (mai 2026). */
  get maxSelectableYm(): string {
    const n = currentIsoYearMonth();
    return n <= this.lotoArchiveMaxYm ? n : this.lotoArchiveMaxYm;
  }

  /** Années proposées pour le mois de début (toute la plage d’archive). */
  readonly startYearOptions: number[] = Array.from({ length: 2026 - 2008 + 1 }, (_, i) => 2008 + i);

  /** Années proposées pour le mois de fin : jusqu’à l’année du plafond effectif (mois courant ∩ archive). */
  get endYearOptions(): number[] {
    const maxY = Number(this.maxSelectableYm.split('-')[0]);
    const list: number[] = [];
    for (let y = 2008; y <= maxY; y++) {
      list.push(y);
    }
    return list;
  }

  get startYear(): number {
    return Number(this.syncStartYm.split('-')[0]);
  }

  get startMonth(): number {
    return Number(this.syncStartYm.split('-')[1]);
  }

  get endYear(): number {
    return Number(this.syncEndYm.split('-')[0]);
  }

  get endMonth(): number {
    return Number(this.syncEndYm.split('-')[1]);
  }

  /** Mois valides pour une année donnée, entre deux bornes yyyy-MM (comparaison lexicographique OK). */
  private monthsForYearInRange(y: number, minYm: string, maxYm: string): number[] {
    const months: number[] = [];
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      if (ym >= minYm && ym <= maxYm) {
        months.push(m);
      }
    }
    return months;
  }

  get startMonthOptions(): number[] {
    return this.monthsForYearInRange(this.startYear, this.lotoArchiveMinYm, this.lotoArchiveMaxYm);
  }

  get endMonthOptions(): number[] {
    return this.monthsForYearInRange(this.endYear, this.lotoArchiveMinYm, this.maxSelectableYm);
  }

  onStartYearChange(y: number): void {
    const months = this.monthsForYearInRange(y, this.lotoArchiveMinYm, this.lotoArchiveMaxYm);
    let mo = this.startMonth;
    if (!months.includes(mo)) {
      mo = months[months.length - 1];
    }
    this.syncStartYm = `${y}-${String(mo).padStart(2, '0')}`;
    this.cdr.markForCheck();
  }

  onStartMonthChange(m: number): void {
    this.syncStartYm = `${this.startYear}-${String(m).padStart(2, '0')}`;
    this.cdr.markForCheck();
  }

  onEndYearChange(y: number): void {
    const months = this.monthsForYearInRange(y, this.lotoArchiveMinYm, this.maxSelectableYm);
    let mo = this.endMonth;
    if (!months.includes(mo)) {
      mo = months[months.length - 1];
    }
    this.syncEndYm = `${y}-${String(mo).padStart(2, '0')}`;
    this.cdr.markForCheck();
  }

  onEndMonthChange(m: number): void {
    this.syncEndYm = `${this.endYear}-${String(m).padStart(2, '0')}`;
    this.cdr.markForCheck();
  }

  /** Libellé mois 01…12 pour les options. */
  monthOptionLabel(m: number): string {
    return String(m).padStart(2, '0');
  }

  /** Import archives : uniquement rôle Keycloak Admin. */
  get canRunSync(): boolean {
    return this.keycloak.hasAdminRole();
  }

  /** Correction des dates en base : même périmètre que l’import (Admin). */
  get canEditDrawDates(): boolean {
    return this.keycloak.hasAdminRole();
  }

  /** Envoi du message « analyse n°1 » + JSON à l’assistant : connecté et données chargées. */
  get canSendLotoAiPrompt(): boolean {
    return this.keycloak.isLoggedIn() && !this.loading && !this.syncing && this.draws.length > 0;
  }

  /** Lignes triées selon {@link sortColumn} / {@link sortAsc}. */
  get sortedDraws(): LotoDrawRow[] {
    const copy = [...this.draws];
    const dir = this.sortAsc ? 1 : -1;
    copy.sort((a, b) => this.compareRows(a, b) * dir);
    return copy;
  }

  private compareRows(a: LotoDrawRow, b: LotoDrawRow): number {
    switch (this.sortColumn) {
      case 'date':
        return a.drawDate.localeCompare(b.drawDate);
      case 'combo':
        return this.comboSortKey(a).localeCompare(this.comboSortKey(b));
      case 'gain':
        return this.gainSortKey(a).localeCompare(this.gainSortKey(b));
      case 'link':
        return (a.detailUrl || '').localeCompare(b.detailUrl || '');
      default:
        return 0;
    }
  }

  private comboSortKey(row: LotoDrawRow): string {
    const s = [...(row.numbers || [])].sort((x, y) => x - y);
    return `${s.map(String).join('-')}|${row.chance}`;
  }

  /** Tri « numérique » grossier pour les libellés de gains (€). */
  private gainSortKey(row: LotoDrawRow): string {
    const g = row.gainDisplay || '';
    const letters = g.replace(/[0-9\s.]/g, '').toLowerCase();
    const digits = g.replace(/\D/g, '');
    if (digits.length > 0) {
      return digits.padStart(14, '0') + letters;
    }
    return g.toLowerCase();
  }

  toggleSort(column: LotoSortColumn): void {
    if (this.sortColumn === column) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortColumn = column;
      this.sortAsc = column === 'combo' || column === 'gain' || column === 'link';
    }
    this.cdr.markForCheck();
  }

  sortIconClass(column: LotoSortColumn): string {
    if (this.sortColumn !== column) {
      return 'fa fa-sort text-muted opacity-50 small';
    }
    return this.sortAsc ? 'fa fa-sort-amount-asc' : 'fa fa-sort-amount-desc';
  }

  refreshTable(): void {
    this.loading = true;
    this.errorMessage = '';
    this.api.getLotoDraws().pipe(
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
        this.errorMessage = this.translate.instant('LOTTO.LOAD_ERROR');
      }
    });
  }

  /** Lignes affichées après tri + filtre date sur le tableau. */
  get displayedDraws(): LotoDrawRow[] {
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
      if (r.detailUrl) {
        next[r.detailUrl] = this.isoDateOnly(r.drawDate);
      }
    }
    this.dateDrafts = next;
  }

  onDateDraftChange(detailUrl: string | undefined, value: string): void {
    if (!detailUrl) {
      return;
    }
    this.dateDrafts[detailUrl] = value;
  }

  isDateDraftUnchanged(row: LotoDrawRow): boolean {
    const id = row.detailUrl;
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

  saveDrawDate(row: LotoDrawRow): void {
    const id = row.detailUrl;
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
      .patchLotoDrawDate({ id, drawDate })
      .pipe(
        finalize(() => {
          this.savingDrawId = null;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (updated) => {
          const idx = this.draws.findIndex((x) => x.detailUrl === id);
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
            this.errorMessage = this.translate.instant('LOTTO.DATE_SAVE_FORBIDDEN');
            return;
          }
          const apiMsg =
            (typeof err?.error === 'object' && err?.error && 'message' in err.error && (err.error as { message?: string }).message) ||
            err?.message ||
            String(err);
          this.errorMessage = this.translate.instant('LOTTO.DATE_SAVE_ERROR', { detail: apiMsg });
        }
      });
  }

  syncArchive(): void {
    if (!this.canRunSync) {
      this.syncMessage = this.translate.instant('LOTTO.SYNC_ADMIN_ONLY');
      return;
    }
    if (this.syncStartYm > this.syncEndYm) {
      this.syncMessage = this.translate.instant('LOTTO.INVALID_RANGE');
      return;
    }
    this.syncMessage = '';
    this.lastSyncResult = null;
    this.syncing = true;
    this.api
      .syncLotoArchive({
        startYearMonth: this.syncStartYm,
        endYearMonth: this.syncEndYm
      })
      .pipe(
        timeout(950000),
        catchError((err) => {
          if (err?.status === 403) {
            this.syncMessage = this.translate.instant('LOTTO.SYNC_ADMIN_ONLY');
            return of(null);
          }
          const apiMsg =
            (typeof err?.error === 'object' && err?.error?.message) ||
            err?.message ||
            String(err);
          this.syncMessage = this.translate.instant('LOTTO.SYNC_FAILED', { detail: apiMsg });
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
          this.syncMessage = this.translate.instant('LOTTO.SYNC_DONE', {
            months: res.monthsProcessed,
            draws: res.drawsUpserted,
            errors: res.httpErrors
          });
          this.refreshTable();
        }
      });
  }

  numbersLine(row: LotoDrawRow): string {
    if (!row.numbers?.length) {
      return '—';
    }
    const nums = row.numbers.join(', ');
    return `${nums} — Chance ${row.chance}`;
  }

  /** Tirages au format IA, triés par date croissante (ordre chronologique). */
  private lotoDrawsChronologicalForAi(): Array<{
    drawDate: string;
    numbers: number[];
    chance: number;
  }> {
    const copy = [...this.draws];
    copy.sort((a, b) => a.drawDate.localeCompare(b.drawDate));
    return copy.map((d) => ({
      drawDate: d.drawDate,
      numbers: [...(d.numbers ?? [])],
      chance: d.chance
    }));
  }

  private buildLotoAiAssistantStatsPayload(lastTailPairs: number): {
    schema: 'pat-loto-ai-v2';
    note: string;
    c: number;
    dateFirst: string;
    dateLast: string;
    chi2MainNaive: number;
    chi2ChanceNaive: number;
    mf: number[];
    cf: number[];
    tail: [string, number[], number][];
  } {
    const rows = this.lotoDrawsChronologicalForAi();
    const c = rows.length;
    const dateFirst = c ? rows[0].drawDate.substring(0, 10) : '';
    const dateLast = c ? rows[c - 1].drawDate.substring(0, 10) : '';
    const mf = new Array(50).fill(0);
    const cf = new Array(11).fill(0);
    for (const r of rows) {
      for (const b of r.numbers ?? []) {
        if (b >= 1 && b <= 49) {
          mf[b]++;
        }
      }
      const ch = r.chance;
      if (ch >= 1 && ch <= 10) {
        cf[ch]++;
      }
    }
    const mf49 = mf.slice(1);
    const cf10 = cf.slice(1);
    const chi2MainNaive = this.chi2UniformCats(mf49, c, 5);
    const chi2ChanceNaive = this.chi2UniformCats(cf10, c, 1);

    const lim = Math.max(0, Math.min(lastTailPairs, rows.length));
    const tail = rows.slice(-lim).map(
      (r) => [this.toAiYyyymmdd(r.drawDate), [...(r.numbers ?? [])], r.chance] as [string, number[], number]
    );

    return {
      schema: 'pat-loto-ai-v2',
      note: 'mf[k]=numéro k occurrences (slots 5*n); cf[j]=Chance j occurrences (n tirages); tail=même tuples compacts récents.',
      c,
      dateFirst,
      dateLast,
      chi2MainNaive,
      chi2ChanceNaive,
      mf: mf49,
      cf: cf10,
      tail
    };
  }

  /** χ² Pearson naïf (uniformité discrete, agrégés). */
  private chi2UniformCats(counts: number[], draws: number, samplesPerDraw: number): number {
    const k = counts.length;
    if (k <= 0 || draws <= 0) {
      return 0;
    }
    const exp = (draws * samplesPerDraw) / k;
    if (exp <= 0) {
      return 0;
    }
    let s = 0;
    for (const o of counts) {
      const d = o - exp;
      s += (d * d) / exp;
    }
    return Math.round(s * 1000) / 1000;
  }

  /** Objet JSON pour l’IA : nombre de tirages + tableau chronologique. */
  private buildLotoAiJsonPayload(): {
    recordCount: number;
    draws: Array<{ drawDate: string; numbers: number[]; chance: number }>;
  } {
    const draws = this.lotoDrawsChronologicalForAi();
    return { recordCount: draws.length, draws };
  }

  /**
   * Même données en JSON minimal pour le brouillon assistant (moins de tokens : plus de tirages
   * tiennent dans la fenêtre de contexte du modèle).
   * Schéma : {@code c} = nombre de lignes ; {@code d} = tableau de {@code [ "YYYYMMDD", [5 nums], chance ]}.
   */
  private buildLotoAiJsonPayloadCompact(): { c: number; d: [string, number[], number][] } {
    const rows = this.lotoDrawsChronologicalForAi();
    const d = rows.map(
      (r) => [this.toAiYyyymmdd(r.drawDate), [...(r.numbers ?? [])], r.chance] as [string, number[], number]
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

  /**
   * Ouvre l’assistant PatTool, envoie le message d’analyse n°1 (i18n) et le bloc JSON des tirages,
   * avec nouvelle conversation et envoi automatique du message.
   */
  sendLotoAiPrompt1(ev?: Event): void {
    ev?.stopPropagation();
    ev?.preventDefault();
    if (!this.canSendLotoAiPrompt) {
      return;
    }
    const statsPayload = this.buildLotoAiAssistantStatsPayload(48);
    const prompt = this.translate.instant('LOTTO.AI_PROMPT_FROM_SCRATCH', { n: statsPayload.c });
    const jsonIntro = this.translate.instant('LOTTO.AI_STATS_PAYLOAD_INTRO');
    const jsonBlock = JSON.stringify(statsPayload);
    const body = `${prompt}\n\n${jsonIntro}\n\n${jsonBlock}`;
    this.assistantLaunch.openWithDraft(body, {
      newConversation: true,
      autoSend: false,
      toolFlags: { webSearch: false, imageGeneration: false, mcp: false }
    });
  }

  /**
   * Ouvre une modale avec un tableau JSON au format IA : uniquement drawDate, numbers et chance par tirage ;
   * téléchargement et copie possibles depuis la modale.
   */
  openExportJsonModal(content: TemplateRef<unknown>): void {
    if (!this.draws.length) {
      return;
    }
    const exportedAt = new Date().toISOString();
    this.jsonExportStamp = exportedAt.slice(0, 19).replace(/[:T]/g, '-');
    /** Schéma IA : recordCount, puis draws (chronologique). */
    const payload = this.buildLotoAiJsonPayload();
    this.jsonExportText = JSON.stringify(payload, null, 2);
    this.modalService.open(content, {
      size: 'xl',
      scrollable: true,
      centered: true,
      windowClass: 'loto-ai-json-modal'
    });
    this.cdr.markForCheck();
  }

  /** Télécharge le JSON affiché dans la modale (fichier `.json`). */
  downloadExportJsonFile(): void {
    if (!this.jsonExportText) {
      return;
    }
    const blob = new Blob([this.jsonExportText], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loto-ai-${this.jsonExportStamp}.json`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Copie le JSON dans le presse-papiers (navigateur). */
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

  /**
   * Axe X : mois (yyyy-MM). Axe Y : moyenne des 5 numéros une fois triés (rang 1 = plus petit … 5 = plus grand),
   * et moyenne du Chance — agrégé sur tous les tirages du mois.
   */
  private buildMonthlyChart(): void {
    const byMonth = new Map<string, { sums: number[]; chanceSum: number; n: number }>();
    for (const row of this.draws) {
      if (!row.drawDate || row.drawDate.length < 7) {
        continue;
      }
      const ym = row.drawDate.substring(0, 7);
      const nums = [...(row.numbers || [])].sort((x, y) => x - y);
      if (nums.length !== 5) {
        continue;
      }
      let bucket = byMonth.get(ym);
      if (!bucket) {
        bucket = { sums: [0, 0, 0, 0, 0], chanceSum: 0, n: 0 };
        byMonth.set(ym, bucket);
      }
      for (let i = 0; i < 5; i++) {
        bucket.sums[i] += nums[i];
      }
      bucket.chanceSum += row.chance;
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
        label: this.translate.instant('LOTTO.CHART_SERIES_N', { i: idx + 1 }),
        borderColor: colors[idx],
        backgroundColor: colors[idx],
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
        fill: false,
        tension: 0.15
      };
    });

    const chanceData = labels.map((ym) => {
      const b = byMonth.get(ym)!;
      return b.n ? round2(b.chanceSum / b.n) : null;
    });

    datasets.push({
      data: chanceData,
      label: this.translate.instant('LOTTO.CHART_SERIES_CHANCE'),
      borderColor: '#dc2626',
      backgroundColor: '#dc2626',
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 3,
      fill: false,
      tension: 0.15
    });

    this.chartHasData = true;
    this.monthlyChartData = { labels, datasets };
    this.cdr.markForCheck();
  }
}
