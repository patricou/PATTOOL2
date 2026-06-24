import {
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { AgGridAngular } from 'ag-grid-angular';
import type {
  CellValueChangedEvent,
  ColDef,
  GridApi,
  GridReadyEvent
} from 'ag-grid-community';

import { odsStyleToAgGridCss } from './ods-cell-style.model';
import {
  appendEmptyColumn,
  appendEmptyRow,
  columnLabelsForRows,
  createEmptyWorkbook,
  gridDataToRows,
  loadOdsFromFile,
  OdsWorkbookModel,
  rowsToGridData,
  workbookToOdsBlob
} from './ods-editor-workbook.util';
import { FileService } from '../services/file.service';
import {
  OdsEditorDocument,
  OdsEditorService,
  base64ToOdsFile,
  blobToBase64
} from './ods-editor.service';

const FONT_SIZE_STORAGE_KEY = 'pat-ods-editor-font-size';
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 20;
const FONT_SIZE_DEFAULT = 10;
/** Largeur fixe des colonnes données → barre de défilement horizontale si besoin. */
const DATA_COLUMN_WIDTH = 96;

@Component({
  selector: 'app-ods-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, AgGridAngular],
  templateUrl: './ods-editor.component.html',
  styleUrls: ['./ods-editor.component.css']
})
export class OdsEditorComponent implements OnInit, OnDestroy {
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  private readonly route = inject(ActivatedRoute);
  private readonly fileService = inject(FileService);
  private readonly odsService = inject(OdsEditorService);
  private readonly destroyRef = inject(DestroyRef);
  private routeSub?: Subscription;

  private gridApi: GridApi | null = null;

  workbook: OdsWorkbookModel | null = null;
  activeSheetIndex = 0;
  columnDefs: ColDef[] = [];
  rowData: Record<string, string>[] = [];
  loading = false;
  saving = false;
  savingToCloud = false;
  deleting = false;
  dirty = false;
  errorKey = '';
  saveMessageKey = '';
  documents: OdsEditorDocument[] = [];
  currentDocumentId: string | null = null;
  loadingDocuments = false;
  /** Chargement depuis une pièce jointe d’activité (query fileId). */
  loadingFromEvent = false;

  readonly fontSizeMin = FONT_SIZE_MIN;
  readonly fontSizeMax = FONT_SIZE_MAX;
  /** Taille d’affichage des cellules (px), réglable par l’utilisateur. */
  displayFontSizePx = FONT_SIZE_DEFAULT;

  ngOnInit(): void {
    this.displayFontSizePx = this.loadStoredFontSize();
    this.loadDocuments();
    this.routeSub = this.route.queryParamMap.subscribe((params) => {
      const fileId = params.get('fileId')?.trim();
      const fileName = params.get('fileName')?.trim() || 'document.ods';
      if (fileId) {
        this.loadFromEventFile(fileId, fileName);
      } else if (!this.workbook) {
        this.newWorkbook();
      }
    });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
  }

  get hasWorkbook(): boolean {
    return this.workbook != null;
  }

  get activeSheetName(): string {
    return this.workbook?.sheets[this.activeSheetIndex]?.name ?? '';
  }

  get displayFileName(): string {
    if (!this.workbook) {
      return '';
    }
    return `${this.workbook.fileName}.ods`;
  }

  get canSave(): boolean {
    return !!this.workbook && !this.saving && !this.savingToCloud && !this.loading;
  }

  get canSaveToCloud(): boolean {
    return this.canSave && !!(this.workbook?.fileName?.trim());
  }

  get hasSavedDocument(): boolean {
    return this.currentDocumentId != null;
  }

  /** Nouvelle feuille impossible en mode « styles conservés » (structure XML fixe). */
  get canAddSheet(): boolean {
    return !this.workbook?.nativeSession;
  }

  get preservesOriginalFormatting(): boolean {
    return !!this.workbook?.nativeSession;
  }

  get gridRowHeight(): number {
    return Math.max(22, Math.round(this.displayFontSizePx * 2.1));
  }

  decreaseFontSize(): void {
    this.setDisplayFontSize(this.displayFontSizePx - 1);
  }

  increaseFontSize(): void {
    this.setDisplayFontSize(this.displayFontSizePx + 1);
  }

  onFontSizeChange(): void {
    this.setDisplayFontSize(this.displayFontSizePx);
  }

  triggerOpenFile(): void {
    this.fileInput?.nativeElement?.click();
  }

  onFileSelected(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.loadFile(file);
  }

  newWorkbook(): void {
    this.currentDocumentId = null;
    this.workbook = createEmptyWorkbook('nouveau-document');
    this.activeSheetIndex = 0;
    this.dirty = false;
    this.errorKey = '';
    this.saveMessageKey = '';
    this.refreshGridFromActiveSheet();
  }

  loadDocuments(): void {
    this.loadingDocuments = true;
    this.odsService
      .list()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.loadingDocuments = false;
        })
      )
      .subscribe({
        next: (docs) => {
          this.documents = docs ?? [];
        },
        error: (err) => console.error('ods-editor list', err)
      });
  }

  onDocumentSelected(id: string): void {
    if (!id) {
      this.newWorkbook();
      return;
    }
    this.errorKey = '';
    this.saveMessageKey = '';
    this.loading = true;
    this.odsService
      .getOne(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.loading = false;
        })
      )
      .subscribe({
        next: (doc) => {
          const base64 = doc.odsContentBase64?.trim();
          if (!base64) {
            this.errorKey = 'ODS_EDITOR.ERR_LOAD';
            return;
          }
          const file = base64ToOdsFile(base64, doc.fileName || 'document');
          this.currentDocumentId = doc.id ?? id;
          this.loadFile(file, { fromCloud: true });
        },
        error: (err) => {
          console.error('ods-editor load', err);
          this.errorKey = 'ODS_EDITOR.ERR_LOAD';
        }
      });
  }

  saveToCloud(): void {
    if (!this.workbook) {
      return;
    }
    const fileName = this.workbook.fileName.trim();
    if (!fileName) {
      this.errorKey = 'ODS_EDITOR.ERR_FILENAME_REQUIRED';
      return;
    }
    this.errorKey = '';
    this.saveMessageKey = '';
    this.persistGridToActiveSheet();
    this.savingToCloud = true;
    workbookToOdsBlob(this.workbook)
      .then((blob) => blobToBase64(blob))
      .then((odsContentBase64) => {
        const body: OdsEditorDocument = { fileName, odsContentBase64 };
        const req$ = this.currentDocumentId
          ? this.odsService.update(this.currentDocumentId, body)
          : this.odsService.create(body);
        return new Promise<OdsEditorDocument>((resolve, reject) => {
          req$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({ next: resolve, error: reject });
        });
      })
      .then((saved) => {
        this.currentDocumentId = saved.id ?? this.currentDocumentId;
        this.workbook!.fileName = saved.fileName ?? fileName;
        this.dirty = false;
        this.saveMessageKey = 'ODS_EDITOR.SAVED';
        this.loadDocuments();
      })
      .catch((err) => {
        console.error('ods-editor save', err);
        this.errorKey = 'ODS_EDITOR.ERR_SAVE_CLOUD';
      })
      .finally(() => {
        this.savingToCloud = false;
      });
  }

  deleteDocument(): void {
    if (!this.currentDocumentId || this.deleting) {
      return;
    }
    const id = this.currentDocumentId;
    this.errorKey = '';
    this.saveMessageKey = '';
    this.deleting = true;
    this.odsService
      .delete(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.deleting = false;
        })
      )
      .subscribe({
        next: () => {
          this.documents = this.documents.filter((d) => d.id !== id);
          this.newWorkbook();
          this.loadDocuments();
          this.saveMessageKey = 'ODS_EDITOR.DELETED';
        },
        error: (err) => {
          console.error('ods-editor delete', err);
          this.errorKey = 'ODS_EDITOR.ERR_DELETE';
        }
      });
  }

  formatDocumentLabel(doc: OdsEditorDocument): string {
    const name = (doc.fileName || '').trim() || 'document';
    const owner = (doc.ownerDisplayName || '').trim();
    const titled = owner ? `${name} — ${owner}` : name;
    if (!doc.updatedAt) {
      return titled;
    }
    try {
      const d = new Date(doc.updatedAt);
      return `${titled} (${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    } catch {
      return titled;
    }
  }

  selectSheet(index: number): void {
    if (!this.workbook || index === this.activeSheetIndex) {
      return;
    }
    this.persistGridToActiveSheet();
    this.activeSheetIndex = index;
    this.refreshGridFromActiveSheet();
  }

  addRow(): void {
    const sheet = this.workbook?.sheets[this.activeSheetIndex];
    if (!sheet) {
      return;
    }
    appendEmptyRow(sheet);
    this.dirty = true;
    this.refreshGridFromActiveSheet();
  }

  addColumn(): void {
    const sheet = this.workbook?.sheets[this.activeSheetIndex];
    if (!sheet) {
      return;
    }
    appendEmptyColumn(sheet);
    this.dirty = true;
    this.refreshGridFromActiveSheet();
  }

  addSheet(): void {
    if (!this.workbook) {
      return;
    }
    this.persistGridToActiveSheet();
    const n = this.workbook.sheets.length + 1;
    const blank = createEmptyWorkbook().sheets[0];
    this.workbook.sheets.push({
      name: `Sheet${n}`,
      rows: blank.rows.map((r) => [...r]),
      cellStyles: blank.cellStyles?.map((r) => [...r])
    });
    this.activeSheetIndex = this.workbook.sheets.length - 1;
    this.dirty = true;
    this.refreshGridFromActiveSheet();
  }

  onSheetNameChange(name: string): void {
    const sheet = this.workbook?.sheets[this.activeSheetIndex];
    if (!sheet) {
      return;
    }
    sheet.name = name.trim() || sheet.name;
    this.dirty = true;
  }

  onFileNameChange(name: string): void {
    if (!this.workbook) {
      return;
    }
    this.workbook.fileName = name.replace(/\.ods$/i, '').trim() || 'document';
    this.dirty = true;
  }

  saveOds(): void {
    if (!this.workbook) {
      return;
    }
    this.errorKey = '';
    this.persistGridToActiveSheet();
    this.saving = true;
    workbookToOdsBlob(this.workbook)
      .then((blob) => {
        this.downloadBlob(blob, this.displayFileName);
        this.dirty = false;
      })
      .catch(() => {
        this.errorKey = 'ODS_EDITOR.ERR_SAVE';
      })
      .finally(() => {
        this.saving = false;
      });
  }

  onGridReady(ev: GridReadyEvent): void {
    this.gridApi = ev.api;
  }

  onCellValueChanged(_ev: CellValueChangedEvent): void {
    this.dirty = true;
  }

  private loadFromEventFile(fileId: string, fileName: string): void {
    this.errorKey = '';
    this.loading = true;
    this.loadingFromEvent = true;
    this.fileService.getFile(fileId).subscribe({
      next: (buffer: ArrayBuffer) => {
        const safeName = fileName.toLowerCase().endsWith('.ods') ? fileName : `${fileName}.ods`;
        const file = new File([buffer], safeName, {
          type: 'application/vnd.oasis.opendocument.spreadsheet'
        });
        this.loadFile(file);
        this.loadingFromEvent = false;
      },
      error: () => {
        this.errorKey = 'ODS_EDITOR.ERR_LOAD';
        this.loading = false;
        this.loadingFromEvent = false;
      }
    });
  }

  private loadFile(file: File, opts?: { fromCloud?: boolean }): void {
    this.errorKey = '';
    this.loading = true;
    if (!opts?.fromCloud) {
      this.currentDocumentId = null;
      this.saveMessageKey = '';
    }
    loadOdsFromFile(file)
      .then((model) => {
        this.workbook = model;
        this.activeSheetIndex = 0;
        this.dirty = false;
        this.refreshGridFromActiveSheet();
      })
      .catch(() => {
        this.errorKey = 'ODS_EDITOR.ERR_LOAD';
      })
      .finally(() => {
        this.loading = false;
      });
  }

  private persistGridToActiveSheet(): void {
    const sheet = this.workbook?.sheets[this.activeSheetIndex];
    if (!sheet) {
      return;
    }
    const labels = columnLabelsForRows(sheet.rows);
    const fromGrid = this.gridApi
      ? (this.collectAllRowData() as Record<string, string>[])
      : this.rowData;
    sheet.rows = gridDataToRows(fromGrid, labels);
  }

  private collectAllRowData(): Record<string, string>[] {
    const rows: Record<string, string>[] = [];
    if (!this.gridApi) {
      return this.rowData;
    }
    const count = this.gridApi.getDisplayedRowCount();
    for (let i = 0; i < count; i++) {
      const node = this.gridApi.getDisplayedRowAtIndex(i);
      if (node?.data) {
        rows.push({ ...node.data });
      }
    }
    return rows;
  }

  private refreshGridFromActiveSheet(): void {
    const sheet = this.workbook?.sheets[this.activeSheetIndex];
    if (!sheet) {
      this.columnDefs = [];
      this.rowData = [];
      return;
    }
    const labels = columnLabelsForRows(sheet.rows);
    this.columnDefs = [
      {
        headerName: '#',
        field: '__rowNum',
        width: 52,
        pinned: 'left',
        editable: false,
        valueGetter: (p) => (p.node?.rowIndex != null ? p.node.rowIndex + 1 : ''),
        suppressMovable: true
      },
      ...labels.map(
        (label, colIndex): ColDef => ({
          headerName: label,
          field: label,
          editable: true,
          width: DATA_COLUMN_WIDTH,
          minWidth: DATA_COLUMN_WIDTH,
          suppressSizeToFit: true,
          cellStyle: (params) => {
            const rowIdx = params.node?.rowIndex;
            const odsStyle =
              rowIdx != null && sheet.cellStyles
                ? sheet.cellStyles[rowIdx]?.[colIndex]
                : undefined;
            return (
              odsStyleToAgGridCss(odsStyle, this.displayFontSizePx) ?? {
                fontSize: `${this.displayFontSizePx}px`
              }
            );
          }
        })
      )
    ];
    this.rowData = rowsToGridData(sheet.rows);
    if (this.gridApi) {
      this.gridApi.setGridOption('columnDefs', this.columnDefs);
      this.gridApi.setGridOption('rowData', this.rowData);
      this.gridApi.setGridOption('rowHeight', this.gridRowHeight);
    }
  }

  private loadStoredFontSize(): number {
    try {
      const raw = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
      if (!raw) {
        return FONT_SIZE_DEFAULT;
      }
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        return FONT_SIZE_DEFAULT;
      }
      return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
    } catch {
      return FONT_SIZE_DEFAULT;
    }
  }

  private setDisplayFontSize(px: number): void {
    const clamped = Math.min(
      FONT_SIZE_MAX,
      Math.max(FONT_SIZE_MIN, Math.round(px))
    );
    if (clamped === this.displayFontSizePx) {
      return;
    }
    this.displayFontSizePx = clamped;
    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(clamped));
    } catch {
      /* ignore quota / private mode */
    }
    this.applyFontSizeToGrid();
  }

  private applyFontSizeToGrid(): void {
    if (!this.gridApi) {
      return;
    }
    this.gridApi.setGridOption('rowHeight', this.gridRowHeight);
    this.gridApi.refreshCells({ force: true });
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
