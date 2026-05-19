import * as XLSX from 'xlsx';

import type { OdsCellStyle } from './ods-cell-style.model';
import { parseOdsNative, type OdsParsedSheet } from './ods-native.parser';
import { saveOdsPreservingFormat } from './ods-native.writer';

export interface OdsSheetData {
  name: string;
  rows: string[][];
  /** Styles par cellule (même dimensions que rows après padding). */
  cellStyles?: (OdsCellStyle | undefined)[][];
}

export interface OdsNativeSession {
  sourceBytes: ArrayBuffer;
  contentDoc: Document;
  sheets: OdsParsedSheet[];
}

export interface OdsWorkbookModel {
  fileName: string;
  sheets: OdsSheetData[];
  /** Présent si le fichier a été ouvert en mode natif (sauvegarde avec styles). */
  nativeSession?: OdsNativeSession;
}

const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 12;
const MIN_ROWS = 5;
const MIN_COLS = 4;

/** Colonne 0 → A, 1 → B, … 26 → AA. */
export function columnIndexToLabel(index: number): string {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function padSheet(
  rows: string[][],
  cellStyles?: (OdsCellStyle | undefined)[][]
): { rows: string[][]; cellStyles: (OdsCellStyle | undefined)[][] } {
  const colCount = Math.max(
    rows.reduce((max, row) => Math.max(max, row.length), 0),
    DEFAULT_COLS,
    MIN_COLS
  );
  const rowCount = Math.max(rows.length, DEFAULT_ROWS, MIN_ROWS);
  const paddedRows: string[][] = [];
  const paddedStyles: (OdsCellStyle | undefined)[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const src = rows[r] ?? [];
    const srcStyles = cellStyles?.[r] ?? [];
    const line: string[] = [];
    const styleLine: (OdsCellStyle | undefined)[] = [];
    for (let c = 0; c < colCount; c++) {
      line.push(src[c] ?? '');
      styleLine.push(srcStyles[c]);
    }
    paddedRows.push(line);
    paddedStyles.push(styleLine);
  }
  return { rows: paddedRows, cellStyles: paddedStyles };
}

export function createEmptyWorkbook(fileName = 'feuille'): OdsWorkbookModel {
  const { rows, cellStyles } = padSheet([[]]);
  return {
    fileName: fileName.replace(/\.ods$/i, ''),
    sheets: [{ name: 'Sheet1', rows, cellStyles }]
  };
}

export async function loadOdsFromFile(file: File): Promise<OdsWorkbookModel> {
  try {
    const parsed = await parseOdsNative(file);
    const sheets: OdsSheetData[] = parsed.sheets.map((s) => {
      const padded = padSheet(s.rows, s.cellStyles);
      return {
        name: s.name,
        rows: padded.rows,
        cellStyles: padded.cellStyles
      };
    });
    return {
      fileName: parsed.fileName,
      sheets,
      nativeSession: {
        sourceBytes: parsed.sourceBytes,
        contentDoc: parsed.contentDoc,
        sheets: parsed.sheets
      }
    };
  } catch {
    return loadOdsViaXlsx(file);
  }
}

async function loadOdsViaXlsx(file: File): Promise<OdsWorkbookModel> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheets: OdsSheetData[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false
    }) as unknown[][];
    const rows = normalizeRows(raw);
    const padded = padSheet(rows.length ? rows : [[]]);
    return { name, rows: padded.rows, cellStyles: padded.cellStyles };
  });
  if (sheets.length === 0) {
    const empty = padSheet([[]]);
    sheets.push({ name: 'Sheet1', rows: empty.rows, cellStyles: empty.cellStyles });
  }
  const baseName = file.name.replace(/\.ods$/i, '') || 'document';
  return { fileName: baseName, sheets };
}

function cellToString(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function normalizeRows(rows: unknown[][]): string[][] {
  const maxCols = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  const colCount = Math.max(maxCols, MIN_COLS);
  return rows.map((row) => {
    const out: string[] = [];
    for (let c = 0; c < colCount; c++) {
      out.push(cellToString(row?.[c]));
    }
    return out;
  });
}

export async function workbookToOdsBlob(model: OdsWorkbookModel): Promise<Blob> {
  if (model.nativeSession) {
    return saveOdsPreservingFormat(model);
  }
  const wb = XLSX.utils.book_new();
  for (const sheet of model.sheets) {
    const trimmed = trimTrailingEmpty(sheet.rows);
    const ws = XLSX.utils.aoa_to_sheet(trimmed.length ? trimmed : [['']]);
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(sheet.name));
  }
  const buffer = XLSX.write(wb, { bookType: 'ods', type: 'array' });
  return new Blob([buffer], {
    type: 'application/vnd.oasis.opendocument.spreadsheet'
  });
}

function trimTrailingEmpty(rows: string[][]): string[][] {
  let lastRow = rows.length - 1;
  while (lastRow >= 0 && rows[lastRow].every((c) => !c.trim())) {
    lastRow--;
  }
  if (lastRow < 0) {
    return [['']];
  }
  const trimmed = rows.slice(0, lastRow + 1);
  let lastCol = 0;
  for (const row of trimmed) {
    for (let c = row.length - 1; c >= lastCol; c--) {
      if ((row[c] ?? '').trim()) {
        lastCol = Math.max(lastCol, c);
      }
    }
  }
  return trimmed.map((row) => row.slice(0, lastCol + 1));
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, '_').trim() || 'Sheet';
  return cleaned.slice(0, 31);
}

/** Lignes 2D → objets ag-grid { A: '', B: 'x', … }. */
export function rowsToGridData(rows: string[][]): Record<string, string>[] {
  const colCount = rows.reduce((max, row) => Math.max(max, row.length), MIN_COLS);
  return rows.map((row) => {
    const record: Record<string, string> = {};
    for (let c = 0; c < colCount; c++) {
      record[columnIndexToLabel(c)] = row[c] ?? '';
    }
    return record;
  });
}

export function gridDataToRows(
  gridRows: Record<string, string>[],
  colLabels: string[]
): string[][] {
  return gridRows.map((record) =>
    colLabels.map((label) => record[label] ?? '')
  );
}

export function columnLabelsForRows(rows: string[][]): string[] {
  const colCount = rows.reduce((max, row) => Math.max(max, row.length), MIN_COLS);
  return Array.from({ length: colCount }, (_, i) => columnIndexToLabel(i));
}

/** Étend cellStyles après ajout de ligne. */
export function appendEmptyRow(
  sheet: OdsSheetData
): void {
  const colCount = sheet.rows[0]?.length ?? DEFAULT_COLS;
  sheet.rows.push(Array.from({ length: colCount }, () => ''));
  if (sheet.cellStyles) {
    sheet.cellStyles.push(Array.from({ length: colCount }, () => undefined));
  }
}

/** Étend cellStyles après ajout de colonne. */
export function appendEmptyColumn(sheet: OdsSheetData): void {
  for (let r = 0; r < sheet.rows.length; r++) {
    sheet.rows[r].push('');
    sheet.cellStyles?.[r]?.push(undefined);
  }
}
