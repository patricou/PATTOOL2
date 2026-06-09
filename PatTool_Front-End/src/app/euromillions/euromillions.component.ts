import { ChangeDetectorRef, Component, DestroyRef, inject, OnInit, TemplateRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize, timeout, catchError } from 'rxjs/operators';
import { firstValueFrom, forkJoin, of } from 'rxjs';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import { NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';

import { ApiService, EuromillionsClientSettings, EuromillionsDrawRow, EuromillionsSyncResult } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { AssistantLaunchService, type AssistantLaunchRouting } from '../services/assistant-launch.service';

Chart.register(...registerables);

/** Display order — aligned with server {@code EuromillionsMethodIds.ORDERED}. */
export const EUROM_METHOD_OPTION_IDS = [
  'chi2_gof_uniform',
  'entropy_normalized',
  'gap_recurrence',
  'sum_correlation',
  'monte_carlo_maxfreq'
] as const;

/**
 * PatTool 1–5 hint on method cards (yellow stars): indicative usefulness to guide choice,
 * not an absolute statistical ranking or a predictive claim.
 */
const EUROM_METHOD_USEFULNESS_STARS: Record<(typeof EUROM_METHOD_OPTION_IDS)[number], number> = {
  chi2_gof_uniform: 5,
  entropy_normalized: 4,
  monte_carlo_maxfreq: 4,
  gap_recurrence: 3,
  sum_correlation: 2
};

/** Assistant launch from EuroMillions: Anthropic + `claude-opus-4-8`, matching the recommended UI selector. */
const EUROM_AI_LAUNCH_ROUTING: AssistantLaunchRouting = {
  provider: 'anthropic',
  modelPreset: 'claude-opus-4-8'
};

export type EuromSortColumn = 'date' | 'combo' | 'gain' | 'code';

@Component({
  selector: 'app-euromillions',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, BaseChartDirective],
  templateUrl: './euromillions.component.html',
  styleUrls: ['./euromillions.component.css']
})
export class EuromillionsComponent implements OnInit {

  private readonly destroyRef = inject(DestroyRef);

  draws: EuromillionsDrawRow[] = [];
  tableLoaded = false;
  loading = true;
  syncing = false;
  errorMessage = '';
  syncMessage = '';
  lastSyncResult: EuromillionsSyncResult | null = null;

  /**
   * FDJ page for EuroMillions & My Million history (archive download):
   * same default URL as {@code euromillions.fdj.historique-url} in the backend.
   */
  readonly fdjEuromMyMillionHistoriqueUrl =
    'https://www.fdj.fr/jeux-de-tirage/euromillions-my-million/historique';

  sortColumn: EuromSortColumn = 'date';
  sortAsc = false;

  private euromEurIntl: Intl.NumberFormat | null = null;
  private euromEurIntlLang = '';

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

  /** "Draws per month" modal counts: rows = 12 months, columns = years (horizontal axis). */
  euromMonthlyCountYears: number[] = [];
  euromMonthlyCountMatrix: number[][] = [];
  euromMonthlyCountMonthRowLabels: string[] = [];
  euromMonthlyCountYearTotals: number[] = [];
  euromMonthlyDistinctYmCount = 0;
  euromMonthlyDrawsAttributed = 0;
  euromMonthlyDrawsSkipped = 0;
  /** Draws with a valid day date but strictly before the assistant lower bound (excluded from matrix). */
  euromMonthlyDrawsBeforeBound = 0;

  jsonExportText = '';
  private jsonExportStamp = '';

  dateDrafts: Record<string, string> = {};
  savingDrawId: string | null = null;
  dateEditMode = false;

  resultFilterDateFrom = '';
  resultFilterDateTo = '';

  /**
   * Inclusive lower bound (yyyy-MM-dd) for draws in the assistant JSON: read via GET/PATCH {@code client-settings}.
   */
  euromAiMinDrawDateIso = '2020-01-01';
  /** Admin form field (yyyy-MM-dd) — synced on load. */
  euromAiMinDrawDateDraft = '2020-01-01';
  /** Server flag: value persisted in Mongo {@code appParameters}. */
  euromAiMinDrawEffectiveFromMongo = false;
  euromAiMinDateSaving = false;
  euromAiMinDateFeedback = '';
  euromAiMinDateFeedbackKind: 'ok' | 'err' | '' = '';

  /** Selected analysis method id (instruction for the AI) — default is first option. */
  selectedEuromMethodId: string = EUROM_METHOD_OPTION_IDS[0];

  /**
   * When true, the assistant draft uses multi-method synthesis and attaches specs for methods checked below.
   * When false, only the radio-selected method is sent (standard scratch prompt).
   */
  euromAiMultiSynthesis = false;

  /**
   * "Include in assistant draft" checkboxes: subset of methods whose specs are attached to the JSON.
   * By default the last two entries in {@link EUROM_METHOD_OPTION_IDS} are unchecked.
   * Used only when {@link euromAiMultiSynthesis} is true; at least one must remain checked then for the assistant button.
   */
  readonly euromAiInclude: Record<string, boolean> = (() => {
    const excludedDefault = new Set(EUROM_METHOD_OPTION_IDS.slice(-2));
    return Object.fromEntries(
      EUROM_METHOD_OPTION_IDS.map((id) => [id, !excludedDefault.has(id)]),
    ) as Record<string, boolean>;
  })();

  /** yyyy-MM-dd lower-bound day for assistant display (i18n / draws-per-month matrix). */
  get euromAiMinInclusiveDay(): string {
    return this.euromAiMinDrawDateIso.trim().substring(0, 10);
  }

  /** Nombre de tirages chargés dont la date est ≥ {@link euromAiMinInclusiveDay} (même périmètre que l’assistant). */
  get euromDrawCountSinceAssistantBound(): number {
    const min = this.euromAiMinInclusiveDay;
    if (min.length !== 10) {
      return this.draws.length;
    }
    let n = 0;
    for (const r of this.draws) {
      const day = this.isoDateOnly(r.drawDate);
      if (day.length === 10 && day >= min) {
        n++;
      }
    }
    return n;
  }

  /** Ordered list of offered methods (fixed order, i18n labels). */
  get euromMethodOrderedIds(): string[] {
    return [...EUROM_METHOD_OPTION_IDS];
  }

  euromMethodRadioDomId(methodId: string): string {
    return `eurom-calc-${methodId.replace(/[^a-z0-9_-]/gi, '-')}`;
  }

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
    this.loadEuromAiClientSettings();
    this.refreshTable();
  }

  private applyEuromClientSettings(settings: EuromillionsClientSettings | null): void {
    const iso = (settings?.minDrawDateIso ?? '').trim().substring(0, 10);
    const ok = iso.length === 10 && iso.charAt(4) === '-' && iso.charAt(7) === '-';
    if (!ok) {
      return;
    }
    this.euromAiMinDrawDateIso = iso;
    this.euromAiMinDrawDateDraft = iso;
    this.euromAiMinDrawEffectiveFromMongo =
      !!(settings?.minDrawDateFromMongoDatabase);
    this.cdr.markForCheck();
  }

  private loadEuromAiClientSettings(): void {
    this.api.getEuromillionsClientSettings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => this.applyEuromClientSettings(s ?? null),
      error: () => undefined
    });
  }

  saveEuromAiMinDrawDateSetting(): void {
    if (!this.canRunSync) {
      return;
    }
    const iso = this.euromAiMinDrawDateDraft?.trim().substring(0, 10) ?? '';
    if (iso.length !== 10 || iso.charAt(4) !== '-' || iso.charAt(7) !== '-') {
      return;
    }
    this.euromAiMinDateFeedback = '';
    this.euromAiMinDateFeedbackKind = '';
    this.euromAiMinDateSaving = true;
    this.api
      .patchEuromillionsClientSettings({ minDrawDateIso: iso })
      .pipe(
        catchError((err) => {
          if (err?.status === 403) {
            this.euromAiMinDateFeedback = this.translate.instant('EUROMILLIONS.AI_MIN_DATE_SAVE_FORBIDDEN');
            this.euromAiMinDateFeedbackKind = 'err';
            return of(null);
          }
          const detail = this.euromSyncErrorDetail(err);
          this.euromAiMinDateFeedback = this.translate.instant('EUROMILLIONS.AI_MIN_DATE_SAVE_ERROR', {
            detail
          });
          this.euromAiMinDateFeedbackKind = 'err';
          return of(null);
        }),
        finalize(() => {
          this.euromAiMinDateSaving = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((res) => {
        if (res) {
          this.applyEuromClientSettings(res);
          this.euromAiMinDateFeedback = this.translate.instant('EUROMILLIONS.AI_MIN_DATE_SAVED');
          this.euromAiMinDateFeedbackKind = 'ok';
        }
      });
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

  /** In-database date editing restricted to Keycloak realm/client Admin role (+ signed-in session). */
  get canEditDrawDates(): boolean {
    return this.keycloak.isLoggedIn() && this.keycloak.hasAdminRole();
  }

  get canSendEuromAiPrompt(): boolean {
    const base =
      this.keycloak.isLoggedIn() &&
      !this.loading &&
      !this.syncing &&
      this.draws.length > 0;
    if (!base) {
      return false;
    }
    if (this.euromAiMultiSynthesis) {
      return this.euromAiIncludedOrderedIds().length > 0;
    }
    return EUROM_METHOD_OPTION_IDS.includes(
      this.selectedEuromMethodId as (typeof EUROM_METHOD_OPTION_IDS)[number]
    );
  }

  /** Methods checked for the assistant JSON, in canonical card order. */
  euromAiIncludedOrderedIds(): string[] {
    return EUROM_METHOD_OPTION_IDS.filter((id) => this.euromAiInclude[id]);
  }

  euromAiIncludeDomId(methodId: string): string {
    return `eurom-ai-inc-${methodId.replace(/[^a-z0-9_-]/gi, '-')}`;
  }

  onEuromAiIncludeChange(methodId: string, ev: Event): void {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) {
      return;
    }
    const checked = !!t.checked;
    if (!EUROM_METHOD_OPTION_IDS.includes(methodId as (typeof EUROM_METHOD_OPTION_IDS)[number])) {
      return;
    }
    if (!checked && this.euromAiIncludedOrderedIds().length <= 1 && this.euromAiInclude[methodId]) {
      t.checked = true;
      return;
    }
    this.euromAiInclude[methodId] = checked;
    this.cdr.markForCheck();
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
    const amt = this.euromParseRank1EuroAmount(row);
    if (amt != null && amt > 0) {
      return String(Math.round(amt)).padStart(16, '0');
    }
    const letters = g.replace(/[0-9\s.,]/g, '').toLowerCase();
    const digits = g.replace(/\D/g, '');
    if (digits.length > 0) {
      return digits.padStart(14, '0') + letters;
    }
    return g.toLowerCase();
  }

  /** Libellé « Rang1 » + montant EUR formaté lorsque le rapport numérique est lisible ; sinon texte brut. */
  euromFormattedGainDisplay(row: EuromillionsDrawRow): string {
    const raw = row.gainDisplay?.trim();
    if (!raw) {
      return '—';
    }
    const amt = this.euromParseRank1EuroAmount(row);
    const sufIdx = raw.indexOf(' — ');
    const suffix = sufIdx >= 0 ? raw.slice(sufIdx) : '';
    if (amt != null && amt > 0) {
      return `Rang1 ${this.formatEuromEuros0(amt)}${suffix}`;
    }
    return raw;
  }

  private setEuromDrawsFromServer(rows: EuromillionsDrawRow[]): void {
    this.draws = rows;
  }

  private euromEuropeanNumberLocale(): string {
    return this.translate.currentLang?.replace('_', '-') || 'fr-FR';
  }

  private formatEuromEuros0(value: number): string {
    const lang = this.euromEuropeanNumberLocale();
    if (!this.euromEurIntl || this.euromEurIntlLang !== lang) {
      this.euromEurIntlLang = lang;
      this.euromEurIntl = new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      });
    }
    return this.euromEurIntl.format(value);
  }

  /**
   * Montant Rang1 en euros extrait de {@link EuromillionsDrawRow.gainDisplay}
   * (segment « Rang1 … € »), ou null.
   */
  private euromParseRank1EuroAmount(row: EuromillionsDrawRow): number | null {
    const raw = row.gainDisplay?.trim();
    if (!raw) {
      return null;
    }
    const m = raw.match(/rang1\s+(.+?)\s*€/i);
    if (!m?.[1]) {
      return null;
    }
    return this.euromParseFrenchMoneyAmount(m[1].trim());
  }

  private euromParseFrenchMoneyAmount(segment: string): number | null {
    if (!segment) {
      return null;
    }
    const s = segment.replace(/\u00a0/g, ' ').trim();
    const low = s.toLowerCase();
    const million = low.match(/^([\d\s.,\u202f]+)\s*(million|millions)\b/);
    if (million) {
      const base = this.euromParseFrenchDecimalNumber(million[1]);
      return base != null ? base * 1e6 : null;
    }
    const milliard = low.match(/^([\d\s.,\u202f]+)\s*(milliard|milliards)\b/);
    if (milliard) {
      const base = this.euromParseFrenchDecimalNumber(milliard[1]);
      return base != null ? base * 1e9 : null;
    }
    return this.euromParseFrenchDecimalNumber(s);
  }

  /** Nombre à la française : espaces / NBSP / fine insécable en séparateurs de milliers, virgule décimale. */
  private euromParseFrenchDecimalNumber(numPart: string): number | null {
    const t = numPart.replace(/\u00a0/g, ' ').replace(/\u202f/g, ' ').trim();
    if (!t) {
      return null;
    }
    const noSpace = t.replace(/\s/g, '');
    const lastComma = noSpace.lastIndexOf(',');
    const lastDot = noSpace.lastIndexOf('.');
    let normalized = noSpace;
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      normalized = normalized.replace(/,/g, '');
    } else if (lastComma >= 0) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    }
    const n = Number(normalized);
    if (!Number.isFinite(n) || n < 0) {
      return null;
    }
    return n;
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
      takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.loading = false;
        this.tableLoaded = true;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (rows) => {
        this.setEuromDrawsFromServer(rows ?? []);
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

  euromMethodTranslationKey(id: string, kind: 'TITLE' | 'DESC' | 'SUMMARY'): string {
    return `EUROMILLIONS.METHOD_${id.toUpperCase()}_${kind}`;
  }

  /** Normative spec sent to the AI for the selected method (long i18n text). */
  euromMethodAiSpecKey(id: string): string {
    return `EUROMILLIONS.METHOD_${id.toUpperCase()}_AI_SPEC`;
  }

  /** Slots 1..5 for star icons on method cards. */
  readonly euromMethodStarSlots: readonly number[] = [1, 2, 3, 4, 5];

  /** PatTool 1–5 hint shown as yellow stars on the card (see {@link EUROM_METHOD_USEFULNESS_STARS}). */
  euromMethodUsefulnessStars(methodId: string): number {
    const k = methodId as keyof typeof EUROM_METHOD_USEFULNESS_STARS;
    return EUROM_METHOD_USEFULNESS_STARS[k] ?? 3;
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
    if (!this.keycloak.isLoggedIn() || !this.keycloak.hasAdminRole()) {
      this.dateEditMode = false;
      this.cdr.markForCheck();
      return;
    }
    this.dateEditMode = !this.dateEditMode;
    this.rebuildDateDrafts();
    this.cdr.markForCheck();
  }

  saveDrawDate(row: EuromillionsDrawRow): void {
    const id = row.drawCode;
    if (!id || !this.keycloak.hasAdminRole() || !this.dateEditMode) {
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
        }),
        takeUntilDestroyed(this.destroyRef)
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

  fetchFdjArchiveAndImport(): void {
    if (!this.canRunSync) {
      this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_ADMIN_ONLY');
      return;
    }
    this.syncMessage = '';
    this.lastSyncResult = null;
    this.syncing = true;
    this.api
      .fetchEuromillionsFdjArchiveAndImport()
      .pipe(
        timeout(300000),
        catchError((err) => {
          if (err?.status === 403) {
            this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_ADMIN_ONLY');
            return of(null);
          }
          const apiMsg = this.euromSyncErrorDetail(err);
          this.syncMessage = this.translate.instant('EUROMILLIONS.SYNC_FAILED', { detail: apiMsg });
          return of(null);
        }),
        finalize(() => {
          this.syncing = false;
          this.cdr.markForCheck();
        }),
        takeUntilDestroyed(this.destroyRef)
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

  private euromSyncErrorDetail(err: unknown): string {
    if (typeof err === 'object' && err !== null) {
      const body = (err as { error?: unknown }).error;
      if (typeof body === 'object' && body !== null) {
        const b = body as { message?: string; detail?: string };
        if (typeof b.detail === 'string' && b.detail.trim()) {
          return b.detail;
        }
        if (typeof b.message === 'string' && b.message.trim()) {
          return b.message;
        }
      }
      const msg = (err as { message?: string }).message;
      if (typeof msg === 'string' && msg.trim()) {
        return msg;
      }
    }
    return String(err);
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

  /** Chronological draws for assistant payload: from {@link euromAiMinDrawDateIso} inclusive. */
  private euromDrawsChronologicalForAssistantAi(): Array<{
    drawDate: string;
    numbers: number[];
    stars: number[];
  }> {
    const min = this.euromAiMinDrawDateIso.trim().substring(0, 10);
    if (min.length !== 10) {
      return this.euromDrawsChronologicalForAi();
    }
    return this.euromDrawsChronologicalForAi().filter((r) => {
      const day = this.isoDateOnly(r.drawDate);
      return day.length === 10 && day >= min;
    });
  }

  /**
   * Draw-date thresholds (ISO yyyy-MM-dd day) separating EuroMillions star eras
   * (main balls always 5/50 in PatTool history).
   */
  private static readonly EUROM_STAR_PERIOD_CUTS = ['2011-05-10', '2016-09-27'] as const;

  private euromStarPeriodIndex(drawDateIso: string): 0 | 1 | 2 {
    const d = (drawDateIso ?? '').substring(0, 10);
    if (d < EuromillionsComponent.EUROM_STAR_PERIOD_CUTS[0]) {
      return 0;
    }
    if (d < EuromillionsComponent.EUROM_STAR_PERIOD_CUTS[1]) {
      return 1;
    }
    return 2;
  }

  /** Naive Pearson χ² (uniformity across categories, app-side pooled counts — simplifying assumption). */
  private chi2UniformCats(counts: number[], draws: number, drawsPerSamples: number): number {
    const k = counts.length;
    if (k <= 0 || draws <= 0) {
      return 0;
    }
    const exp = (draws * drawsPerSamples) / k;
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

  /**
   * Assistant JSON: margins per regulatory era (draws with date ≥ server setting
   * {@code euromillions.ai.min-draw-date}) + full chronological list of those draws in {@code tail}.
   */
  private buildEuromAiAssistantStatsPayload(): {
    schema: 'pat-eurom-ai-v2';
    note: string;
    sinceInclusive: string;
    c: number;
    dateFirst: string;
    dateLast: string;
    periodCuts: string[];
    periods: Array<{
      id: string;
      starMax: number;
      n: number;
      chi2MainNaive: number;
      chi2StarsNaive: number;
      mf: number[];
      sf: number[];
    }>;
    tail: [string, number[], number[]][];
  } {
    const sinceInclusive = this.euromAiMinDrawDateIso.trim().substring(0, 10);
    const rows = this.euromDrawsChronologicalForAssistantAi();
    const c = rows.length;
    const dateFirst = c ? rows[0].drawDate.substring(0, 10) : '';
    const dateLast = c ? rows[c - 1].drawDate.substring(0, 10) : '';

    type P = {
      id: string;
      starMax: number;
      n: number;
      mf: number[];
      sf: number[];
    };
    const periods: P[] = [
      { id: 'P1', starMax: 9, n: 0, mf: new Array(51).fill(0), sf: new Array(13).fill(0) },
      { id: 'P2', starMax: 11, n: 0, mf: new Array(51).fill(0), sf: new Array(13).fill(0) },
      { id: 'P3', starMax: 12, n: 0, mf: new Array(51).fill(0), sf: new Array(13).fill(0) }
    ];

    for (const r of rows) {
      const pi = this.euromStarPeriodIndex(r.drawDate);
      const p = periods[pi];
      p.n++;
      for (const b of r.numbers ?? []) {
        if (b >= 1 && b <= 50) {
          p.mf[b]++;
        }
      }
      for (const s of r.stars ?? []) {
        if (s >= 1 && s <= 12) {
          p.sf[s]++;
        }
      }
    }

    const outPeriods = periods.map((p) => {
      const mf = p.mf.slice(1);
      const sfFull = p.sf.slice(1);
      const sf = sfFull.slice(0, p.starMax);
      const chi2MainNaive = this.chi2UniformCats(mf, p.n, 5);
      const chi2StarsNaive = this.chi2UniformCats(sf, p.n, 2);
      return {
        id: p.id,
        starMax: p.starMax,
        n: p.n,
        chi2MainNaive,
        chi2StarsNaive,
        mf,
        sf
      };
    });

    const tail = rows.map(
      (r) =>
        [this.toAiYyyymmdd(r.drawDate), [...(r.numbers ?? [])], [...(r.stars ?? [])]] as [
          string,
          number[],
          number[]
        ]
    );

    return {
      schema: 'pat-eurom-ai-v2',
      note:
        'Scope: draws with drawDate >= sinceInclusive. mf/sf and χ² use only those draws. tail = full chronological list for this scope; tail.length = c.',
      sinceInclusive,
      c,
      dateFirst,
      dateLast,
      periodCuts: [...EuromillionsComponent.EUROM_STAR_PERIOD_CUTS],
      periods: outPeriods,
      tail
    };
  }

  private buildEuromAiJsonPayload(): {
    recordCount: number;
    draws: Array<{ drawDate: string; numbers: number[]; stars: number[] }>;
  } {
    const draws = this.euromDrawsChronologicalForAi();
    return { recordCount: draws.length, draws };
  }

  /**
   * Minimal JSON for assistant: {@code c} = row count;
   * {@code d} = {@code [ "YYYYMMDD", [5 mains], [star1, star2] ]} per draw, chronological order.
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
    const mode = this.euromAiMultiSynthesis ? 'synthesis' : 'standard';
    const includedIds = this.euromAiMultiSynthesis
      ? this.euromAiIncludedOrderedIds()
      : [this.selectedEuromMethodId];
    this.openEuromAiDraft(mode, includedIds);
  }

  private euromPrimaryIncludedMethodId(includedIds: string[]): string {
    if (includedIds.includes(this.selectedEuromMethodId)) {
      return this.selectedEuromMethodId;
    }
    return includedIds[0];
  }

  private buildEuromMethodRowsForAi(ids: string[]): Array<{
    id: string;
    calculationMethodLabel: string;
    calculationMethodSummary: string;
    calculationMethodSpec: string;
  }> {
    return ids.map((id) => ({
      id,
      calculationMethodLabel: this.translate.instant(this.euromMethodTranslationKey(id, 'TITLE')),
      calculationMethodSummary: this.translate.instant(this.euromMethodTranslationKey(id, 'DESC')),
      calculationMethodSpec: this.translate.instant(this.euromMethodAiSpecKey(id))
    }));
  }

  private fillEuromAiEnvelope(
    statsPayload: ReturnType<EuromillionsComponent['buildEuromAiAssistantStatsPayload']>,
    includedIds: string[]
  ): Record<string, unknown> {
    const rows = this.buildEuromMethodRowsForAi(includedIds);
    const primaryId = this.euromPrimaryIncludedMethodId(includedIds);
    const primary = rows.find((r) => r.id === primaryId)!;
    const envelope: Record<string, unknown> = {
      ...statsPayload,
      calculationMethodId: primary.id,
      calculationMethodLabel: primary.calculationMethodLabel,
      calculationMethodSummary: primary.calculationMethodSummary,
      calculationMethodSpec: primary.calculationMethodSpec
    };
    if (includedIds.length > 1) {
      envelope['calculationMethods'] = rows;
    }
    return envelope;
  }

  private buildEuromAiMethodHints(
    mode: 'standard' | 'synthesis',
    includedIds: string[],
    primaryId: string
  ): string {
    const primaryLabel = this.translate.instant(this.euromMethodTranslationKey(primaryId, 'TITLE'));
    const primarySummary = this.translate.instant(this.euromMethodTranslationKey(primaryId, 'DESC'));
    if (mode === 'synthesis') {
      return this.translate.instant('EUROMILLIONS.AI_MULTI_SYNTHESIS_HINT', {
        n: includedIds.length,
        primaryId,
        primaryLabel
      });
    }
    if (includedIds.length === 1) {
      return this.translate.instant('EUROMILLIONS.AI_SELECTED_METHOD_HINT', {
        id: primaryId,
        label: primaryLabel,
        summary: primarySummary
      });
    }
    const labels = includedIds
      .map((id) => this.translate.instant(this.euromMethodTranslationKey(id, 'TITLE')))
      .join(', ');
    return this.translate.instant('EUROMILLIONS.AI_MULTI_METHOD_HINT', {
      primaryId,
      primaryLabel,
      labels
    });
  }

  /**
   * Assistant draft: stats + méthode(s) — la borne basse et la liste des tirages sont
   * resynchronisées avec l’API avant construction du JSON, pour éviter d’exclure des
   * tirages lorsque {@code client-settings} arrive après le premier chargement de la page.
   */
  private openEuromAiDraft(mode: 'standard' | 'synthesis', includedIds: string[]): void {
    if (!this.canSendEuromAiPrompt || includedIds.length === 0) {
      return;
    }
    void firstValueFrom(
      forkJoin({
        settings: this.api.getEuromillionsClientSettings().pipe(catchError(() => of(null))),
        draws: this.api.getEuromillionsDraws().pipe(catchError(() => of(null)))
      }).pipe(timeout(120_000))
    )
      .then((pair) => {
        if (pair.settings) {
          this.applyEuromClientSettings(pair.settings);
        }
        if (Array.isArray(pair.draws)) {
          this.setEuromDrawsFromServer(pair.draws);
          this.rebuildDateDrafts();
        }
        this.finalizeEuromAiDraft(mode, includedIds);
      })
      .catch(() => {
        this.finalizeEuromAiDraft(mode, includedIds);
      });
  }

  private finalizeEuromAiDraft(mode: 'standard' | 'synthesis', includedIds: string[]): void {
    if (!this.canSendEuromAiPrompt || includedIds.length === 0) {
      return;
    }
    const statsPayload = this.buildEuromAiAssistantStatsPayload();
    const primaryId = this.euromPrimaryIncludedMethodId(includedIds);
    const envelope = this.fillEuromAiEnvelope(statsPayload, includedIds);
    const promptKey =
      mode === 'synthesis'
        ? 'EUROMILLIONS.AI_PROMPT_MULTI_SYNTHESIS'
        : 'EUROMILLIONS.AI_PROMPT_FROM_SCRATCH';
    const prompt = this.translate.instant(promptKey, {
      n: statsPayload.c,
      since: statsPayload.sinceInclusive
    });
    const methodHint = this.buildEuromAiMethodHints(mode, includedIds, primaryId);
    const jsonIntro = this.translate.instant('EUROMILLIONS.AI_STATS_PAYLOAD_INTRO', {
      since: statsPayload.sinceInclusive
    });
    const jsonBlock = JSON.stringify(envelope);
    const body = `${prompt}\n\n${methodHint}\n\n${jsonIntro}\n\n${jsonBlock}`;
    this.assistantLaunch.openWithDraft(body, {
      newConversation: true,
      autoSend: false,
      toolFlags: { webSearch: false, imageGeneration: false, mcp: false },
      routing: EUROM_AI_LAUNCH_ROUTING
    });
    this.cdr.markForCheck();
  }

  openMonthlyCountModal(content: TemplateRef<unknown>): void {
    this.computeMonthlyDrawCounts();
    this.modalService.open(content, {
      size: 'xl',
      scrollable: true,
      centered: true
    });
    this.cdr.markForCheck();
  }

  openEuromAiFlowInfoModal(content: TemplateRef<unknown>): void {
    this.modalService.open(content, {
      size: 'lg',
      scrollable: true,
      centered: true
    });
    this.cdr.markForCheck();
  }

  private computeMonthlyDrawCounts(): void {
    const byYm = new Map<string, number>();
    let skipped = 0;
    let beforeBound = 0;
    const minBound = this.euromAiMinInclusiveDay;

    for (const row of this.draws) {
      const dayKey = this.euromIsoDayPrefixOrNull(row.drawDate);
      if (!dayKey) {
        skipped++;
        continue;
      }
      if (dayKey < minBound) {
        beforeBound++;
        continue;
      }
      const ym = this.parseDrawYearMonthKey(row.drawDate);
      if (!ym) {
        skipped++;
        continue;
      }
      byYm.set(ym, (byYm.get(ym) ?? 0) + 1);
    }

    this.euromMonthlyDrawsSkipped = skipped;
    this.euromMonthlyDrawsBeforeBound = beforeBound;
    this.euromMonthlyDistinctYmCount = byYm.size;

    let sumAll = 0;
    const yearsSet = new Set<number>();
    for (const [k, v] of byYm.entries()) {
      sumAll += v;
      yearsSet.add(Number(k.slice(0, 4)));
    }
    this.euromMonthlyDrawsAttributed = sumAll;

    const years = [...yearsSet].sort((a, b) => a - b);
    this.euromMonthlyCountYears = years;

    if (years.length === 0) {
      this.euromMonthlyCountMatrix = [];
      this.euromMonthlyCountMonthRowLabels = [];
      this.euromMonthlyCountYearTotals = [];
      return;
    }

    const matrix: number[][] = [];
    for (let m = 1; m <= 12; m++) {
      const row: number[] = [];
      const mm = String(m).padStart(2, '0');
      for (const y of years) {
        const key = `${y}-${mm}`;
        row.push(byYm.get(key) ?? 0);
      }
      matrix.push(row);
    }
    this.euromMonthlyCountMatrix = matrix;
    this.euromMonthlyCountMonthRowLabels = this.buildEuromCalendarMonthLabels();
    this.euromMonthlyCountYearTotals = years.map((_, ci) =>
      matrix.reduce((acc, r) => acc + (r[ci] ?? 0), 0)
    );
  }

  private buildEuromCalendarMonthLabels(): string[] {
    const loc = this.translate.currentLang?.replace('_', '-') || 'fr-FR';
    const out: string[] = [];
    for (let m = 0; m < 12; m++) {
      const anchor = new Date(2001, m, 1);
      try {
        const s = anchor.toLocaleDateString(loc, { month: 'long' });
        out.push(s ? s.charAt(0).toUpperCase() + s.slice(1) : String(m + 1));
      } catch {
        out.push(String(m + 1));
      }
    }
    return out;
  }

  /** Returns {@code yyyy-MM} if the start of {@code raw} is a plausible year/month, otherwise {@code null}. */
  private parseDrawYearMonthKey(raw: string | undefined): string | null {
    const d = raw?.trim() ?? '';
    if (d.length < 7) {
      return null;
    }
    const head = d.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(head)) {
      return null;
    }
    const month = Number(head.slice(5, 7));
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return null;
    }
    const year = Number(head.slice(0, 4));
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return null;
    }
    return head;
  }

  /** {@code yyyy-MM-dd} prefix if the first 10 characters form an ISO calendar day, otherwise {@code null}. */
  private euromIsoDayPrefixOrNull(raw: string | undefined): string | null {
    const t = (raw ?? '').trim();
    const h = t.length >= 10 ? t.slice(0, 10) : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(h) ? h : null;
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
