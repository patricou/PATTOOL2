import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../shared/navigation-buttons/navigation-buttons.module';
import { ApiService, PatToolParameterItem, PatToolParameterSection } from '../services/api.service';

export interface FlatParameterRow extends PatToolParameterItem {
  sectionId: string;
  sectionLabelKey: string;
}

export type OriginFilter =
  | 'all'
  | 'not_configured'
  | 'required'
  | 'application_properties'
  | 'code_default'
  | 'mongodb'
  | 'environment'
  | 'command_line';

export type SortColumn = 'section' | 'key' | 'value' | 'origin' | 'codeDefault';
export type SortDirection = 'asc' | 'desc';
type GridColumn = SortColumn;

interface ColumnWidths {
  section: number;
  key: number;
  value: number;
  origin: number;
  codeDefault: number;
}

interface KpiCard {
  filter: OriginFilter;
  icon: string;
  tone: string;
}

@Component({
  selector: 'app-pattool-parameters',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NavigationButtonsModule],
  templateUrl: './pattool-parameters.component.html',
  styleUrls: ['./pattool-parameters.component.css']
})
export class PattoolParametersComponent implements OnInit {
  private static readonly COLUMN_WIDTHS_STORAGE_KEY = 'pattool-params-column-widths';
  private static readonly COLUMN_MIN: ColumnWidths = {
    section: 72,
    key: 120,
    value: 80,
    origin: 100,
    codeDefault: 100
  };
  private static readonly DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
    section: 100,
    key: 220,
    value: 180,
    origin: 140,
    codeDefault: 200
  };

  sections: PatToolParameterSection[] = [];
  allRows: FlatParameterRow[] = [];
  totalItems = 0;
  loading = true;
  errorMessage = '';

  searchText = '';
  originFilter: OriginFilter = 'all';
  sectionFilter = 'all';
  keyFilter = '';
  valueFilter = '';
  codeDefaultFilter = '';
  descriptionFilter = '';
  sortColumn: SortColumn = 'key';
  sortDirection: SortDirection = 'asc';
  columnWidths: ColumnWidths = { ...PattoolParametersComponent.DEFAULT_COLUMN_WIDTHS };
  columnResizing = false;

  private resizeColumn: GridColumn | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  readonly kpiCards: KpiCard[] = [
    { filter: 'all', icon: 'fa-th-large', tone: 'kpi-all' },
    { filter: 'application_properties', icon: 'fa-file-text-o', tone: 'kpi-props' },
    { filter: 'not_configured', icon: 'fa-circle-o', tone: 'kpi-warn' },
    { filter: 'required', icon: 'fa-exclamation-triangle', tone: 'kpi-danger' },
    { filter: 'code_default', icon: 'fa-code', tone: 'kpi-code' },
    { filter: 'mongodb', icon: 'fa-database', tone: 'kpi-mongo' }
  ];

  readonly originFilters: OriginFilter[] = [
    'all',
    'not_configured',
    'required',
    'application_properties',
    'code_default',
    'mongodb',
    'environment',
    'command_line'
  ];

  constructor(
    private readonly api: ApiService,
    private readonly translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.loadColumnWidths();
    this.api.getPatToolParameters().subscribe({
      next: (response) => {
        this.sections = (response?.sections ?? []).map((section) => ({
          ...section,
          items: (section.items ?? []).map((item) => this.normalizeItem(item))
        }));
        this.allRows = this.sections.flatMap((section) =>
          (section.items ?? []).map((item) => ({
            ...item,
            sectionId: section.id,
            sectionLabelKey: section.labelKey
          }))
        );
        this.totalItems = response?.totalItems ?? this.allRows.length;
        this.loading = false;
      },
      error: () => {
        this.errorMessage = 'PATTOOL_PARAMS.LOAD_ERROR';
        this.loading = false;
      }
    });
  }

  get filteredRows(): FlatParameterRow[] {
    let rows = this.allRows;
    if (this.sectionFilter !== 'all') {
      rows = rows.filter((r) => r.sectionId === this.sectionFilter);
    }
    if (this.originFilter !== 'all') {
      rows = rows.filter((r) => r.origin === this.originFilter);
    }
    const keyQ = this.keyFilter.trim().toLowerCase();
    if (keyQ) {
      rows = rows.filter((r) => r.key.toLowerCase().includes(keyQ));
    }
    const valueQ = this.valueFilter.trim().toLowerCase();
    if (valueQ) {
      rows = rows.filter((r) => {
        const raw = (r.value ?? '').toLowerCase();
        const shown = this.displayValue(r.value).toLowerCase();
        return raw.includes(valueQ) || shown.includes(valueQ);
      });
    }
    const codeDefaultQ = this.codeDefaultFilter.trim().toLowerCase();
    if (codeDefaultQ) {
      rows = rows.filter((r) => (r.codeDefault ?? '').toLowerCase().includes(codeDefaultQ));
    }
    const descriptionQ = this.descriptionFilter.trim().toLowerCase();
    if (descriptionQ) {
      rows = rows.filter((r) => this.descriptionSearchText(r).includes(descriptionQ));
    }
    const q = this.searchText.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.key.toLowerCase().includes(q) ||
          r.value.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q) ||
          r.sectionLabelKey.toLowerCase().includes(q)
      );
    }
    return rows;
  }

  get gridTemplateColumns(): string {
    const w = this.columnWidths;
    const min = PattoolParametersComponent.COLUMN_MIN;
    // fr weights follow stored widths: resize changes proportions and still fills 100%.
    return [
      `minmax(${min.section}px, ${w.section}fr)`,
      `minmax(${min.key}px, ${w.key}fr)`,
      `minmax(${min.value}px, ${w.value}fr)`,
      `minmax(${min.origin}px, ${w.origin}fr)`,
      `minmax(${min.codeDefault}px, ${w.codeDefault}fr)`
    ].join(' ');
  }

  get gridMinWidth(): number {
    const min = PattoolParametersComponent.COLUMN_MIN;
    return min.section + min.key + min.value + min.origin + min.codeDefault + 32;
  }

  get displayRows(): FlatParameterRow[] {
    const rows = [...this.filteredRows];
    const dir = this.sortDirection === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const cmp = this.sortValue(a).localeCompare(this.sortValue(b), undefined, {
        sensitivity: 'base',
        numeric: true
      });
      return cmp * dir;
    });
    return rows;
  }

  countByOrigin(origin: OriginFilter): number {
    if (origin === 'all') {
      return this.allRows.length;
    }
    return this.allRows.filter((r) => r.origin === origin).length;
  }

  setOriginFilter(filter: OriginFilter): void {
    this.originFilter = filter;
  }

  clearFilters(): void {
    this.searchText = '';
    this.originFilter = 'all';
    this.sectionFilter = 'all';
    this.keyFilter = '';
    this.valueFilter = '';
    this.codeDefaultFilter = '';
    this.descriptionFilter = '';
  }

  toggleSort(column: SortColumn): void {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
  }

  sortIcon(column: SortColumn): string {
    if (this.sortColumn !== column) {
      return 'fa-sort';
    }
    return this.sortDirection === 'asc' ? 'fa-sort-asc' : 'fa-sort-desc';
  }

  isSortActive(column: SortColumn): boolean {
    return this.sortColumn === column;
  }

  startColumnResize(event: MouseEvent, column: GridColumn): void {
    event.preventDefault();
    event.stopPropagation();
    this.resizeColumn = column;
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.columnWidths[column];
    this.columnResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  @HostListener('document:mousemove', ['$event'])
  onColumnResizeMove(event: MouseEvent): void {
    if (!this.resizeColumn) {
      return;
    }
    const delta = event.clientX - this.resizeStartX;
    const min = PattoolParametersComponent.COLUMN_MIN[this.resizeColumn];
    const next = Math.max(min, this.resizeStartWidth + delta);
    this.columnWidths = {
      ...this.columnWidths,
      [this.resizeColumn]: next
    };
  }

  @HostListener('document:mouseup')
  onColumnResizeEnd(): void {
    if (!this.resizeColumn) {
      return;
    }
    this.resizeColumn = null;
    this.columnResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    this.saveColumnWidths();
  }

  resetColumnWidths(): void {
    this.columnWidths = { ...PattoolParametersComponent.DEFAULT_COLUMN_WIDTHS };
    this.saveColumnWidths();
  }

  private sortValue(row: FlatParameterRow): string {
    switch (this.sortColumn) {
      case 'section':
        return row.sectionLabelKey;
      case 'key':
        return row.key;
      case 'value':
        return row.value ?? '';
      case 'origin':
        return row.origin ?? '';
      case 'codeDefault':
        return row.codeDefault ?? '';
      default:
        return row.key;
    }
  }

  trackByKey(_index: number, row: FlatParameterRow): string {
    return row.sectionId + '::' + row.key;
  }

  get hasActiveFilters(): boolean {
    return this.searchText.trim().length > 0 || this.hasColumnFilters;
  }

  get hasColumnFilters(): boolean {
    return (
      this.originFilter !== 'all'
      || this.sectionFilter !== 'all'
      || this.keyFilter.trim().length > 0
      || this.valueFilter.trim().length > 0
      || this.codeDefaultFilter.trim().length > 0
      || this.descriptionFilter.trim().length > 0
    );
  }

  originFilterLabelKey(filter: OriginFilter): string {
    if (filter === 'all') {
      return 'PATTOOL_PARAMS.FILTER.ALL';
    }
    return this.originLabelKey(filter);
  }

  originIcon(origin: string): string {
    switch (origin) {
      case 'application_properties':
        return 'fa-file-text-o';
      case 'mongodb':
        return 'fa-database';
      case 'code_default':
        return 'fa-code';
      case 'environment':
        return 'fa-cloud';
      case 'command_line':
        return 'fa-terminal';
      case 'required':
        return 'fa-exclamation-triangle';
      default:
        return 'fa-minus-circle';
    }
  }

  sectionTone(sectionId: string): string {
    const tones = [
      'sec-a', 'sec-b', 'sec-c', 'sec-d', 'sec-e', 'sec-f',
      'sec-g', 'sec-h', 'sec-i', 'sec-j', 'sec-k', 'sec-l'
    ];
    let hash = 0;
    for (let i = 0; i < sectionId.length; i++) {
      hash = (hash + sectionId.charCodeAt(i) * (i + 1)) % tones.length;
    }
    return tones[hash];
  }

  isUnsetValue(value: string): boolean {
    return !value || value === '(not set)' || value === '(configured)';
  }

  displayValue(value: string): string {
    if (!value) {
      return this.translate.instant('PATTOOL_PARAMS.VALUE.EMPTY');
    }
    if (value === '(not set)') {
      return this.translate.instant('PATTOOL_PARAMS.VALUE.NOT_SET');
    }
    if (value === '(configured)') {
      return this.translate.instant('PATTOOL_PARAMS.VALUE.CONFIGURED');
    }
    return value;
  }

  descriptionText(row: FlatParameterRow): string {
    const unknownLabel = this.translate.instant('PATTOOL_PARAMS.DESC.UNKNOWN');
    const inferred = row.descriptionInferred?.trim();
    const description = row.description?.trim() ?? '';

    if (description.startsWith('PATTOOL_PARAMS.')) {
      const translated = this.translate.instant(description);
      const hasCuratedTranslation =
        translated && translated !== description && translated !== unknownLabel;
      if (hasCuratedTranslation) {
        return translated;
      }
      if (inferred) {
        return inferred;
      }
      if (description.startsWith('PATTOOL_PARAMS.PARAM.') || description === 'PATTOOL_PARAMS.DESC.UNKNOWN') {
        return unknownLabel;
      }
      return translated || description;
    }

    if (description) {
      return description;
    }
    return inferred ?? '';
  }

  private descriptionSearchText(row: FlatParameterRow): string {
    return [
      this.descriptionText(row),
      row.description ?? '',
      row.descriptionInferred ?? ''
    ]
      .join(' ')
      .toLowerCase();
  }

  private loadColumnWidths(): void {
    try {
      const raw = localStorage.getItem(PattoolParametersComponent.COLUMN_WIDTHS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
      this.columnWidths = {
        section: this.clampColumnWidth('section', parsed.section),
        key: this.clampColumnWidth('key', parsed.key),
        value: this.clampColumnWidth('value', parsed.value),
        origin: this.clampColumnWidth('origin', parsed.origin),
        codeDefault: this.clampColumnWidth('codeDefault', parsed.codeDefault)
      };
    } catch {
      this.columnWidths = { ...PattoolParametersComponent.DEFAULT_COLUMN_WIDTHS };
    }
  }

  private saveColumnWidths(): void {
    try {
      localStorage.setItem(
        PattoolParametersComponent.COLUMN_WIDTHS_STORAGE_KEY,
        JSON.stringify(this.columnWidths)
      );
    } catch {
      /* ignore quota / private mode */
    }
  }

  private clampColumnWidth(column: GridColumn, value: number | undefined): number {
    const min = PattoolParametersComponent.COLUMN_MIN[column];
    const fallback = PattoolParametersComponent.DEFAULT_COLUMN_WIDTHS[column];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.round(value));
  }

  private normalizeItem(item: PatToolParameterItem): PatToolParameterItem {
    const legacy = item as PatToolParameterItem & { source?: string };
    let origin = item.origin ?? legacy.source ?? 'not_configured';
    if (origin === 'properties') {
      origin = 'application_properties';
    } else if (origin === 'default') {
      origin = 'not_configured';
    }
    return { ...item, origin };
  }

  originLabelKey(origin: string): string {
    switch (origin) {
      case 'mongodb':
        return 'PATTOOL_PARAMS.ORIGIN.MONGODB';
      case 'application_properties':
        return 'PATTOOL_PARAMS.ORIGIN.APPLICATION_PROPERTIES';
      case 'environment':
        return 'PATTOOL_PARAMS.ORIGIN.ENVIRONMENT';
      case 'command_line':
        return 'PATTOOL_PARAMS.ORIGIN.COMMAND_LINE';
      case 'code_default':
        return 'PATTOOL_PARAMS.ORIGIN.CODE_DEFAULT';
      case 'required':
        return 'PATTOOL_PARAMS.ORIGIN.REQUIRED';
      case 'not_configured':
        return 'PATTOOL_PARAMS.ORIGIN.NOT_CONFIGURED';
      default:
        return 'PATTOOL_PARAMS.ORIGIN.NOT_CONFIGURED';
    }
  }

  originBadgeClass(origin: string): string {
    switch (origin) {
      case 'application_properties':
        return 'pill-props';
      case 'mongodb':
        return 'pill-mongo';
      case 'code_default':
        return 'pill-code';
      case 'environment':
      case 'command_line':
        return 'pill-env';
      case 'required':
        return 'pill-required';
      default:
        return 'pill-none';
    }
  }
}
