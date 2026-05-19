import * as JSZip from 'jszip';

import type { OdsCellStyle } from './ods-cell-style.model';
import { OdsStyleRegistry } from './ods-style-registry';
import {
  childElementsByLocal,
  elementsByLocal,
  odfAttr,
  odfRepeat,
  parseOdfXml,
  readCellText
} from './ods-xml.util';

export interface OdsParsedSheet {
  name: string;
  tableElement: Element;
  rows: string[][];
  cellStyles: (OdsCellStyle | undefined)[][];
  /** Élément XML table-cell (null = cellule couverte / virtuelle). */
  cellElements: (Element | null)[][];
}

export interface OdsNativeParseResult {
  fileName: string;
  sheets: OdsParsedSheet[];
  sourceBytes: ArrayBuffer;
  contentDoc: Document;
}

export async function parseOdsNative(file: File): Promise<OdsNativeParseResult> {
  const sourceBytes = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(sourceBytes);
  const contentXml = await zip.file('content.xml')?.async('string');
  if (!contentXml) {
    throw new Error('Missing content.xml');
  }
  const stylesXml = (await zip.file('styles.xml')?.async('string')) ?? '';
  const contentDoc = parseOdfXml(contentXml);
  const stylesDoc = stylesXml ? parseOdfXml(stylesXml) : null;
  const registry = OdsStyleRegistry.fromDocuments(
    contentDoc,
    ...(stylesDoc ? [stylesDoc] : [])
  );

  const spreadsheet = elementsByLocal(contentDoc, 'spreadsheet')[0];
  if (!spreadsheet) {
    throw new Error('No spreadsheet');
  }

  const tables = childElementsByLocal(spreadsheet, 'table');
  const sheets: OdsParsedSheet[] = tables.map((table, index) =>
    parseTable(table, index, registry)
  );

  if (sheets.length === 0) {
    throw new Error('No sheets');
  }

  const baseName = file.name.replace(/\.ods$/i, '') || 'document';
  return { fileName: baseName, sheets, sourceBytes, contentDoc };
}

function parseTable(
  table: Element,
  index: number,
  registry: OdsStyleRegistry
): OdsParsedSheet {
  const name = odfAttr(table, 'table:name') ?? `Sheet${index + 1}`;
  const columnStyles = expandColumnStyles(table);
  const rows: string[][] = [];
  const cellStyles: (OdsCellStyle | undefined)[][] = [];
  const cellElements: (Element | null)[][] = [];

  const rowStyleName = (rowEl: Element) => odfAttr(rowEl, 'table:style-name');

  for (const rowEl of childElementsByLocal(table, 'table-row')) {
    const rowStyle = rowStyleName(rowEl);
    const rowValues: string[] = [];
    const rowStyleRow: (OdsCellStyle | undefined)[] = [];
    const rowAnchors: (Element | null)[] = [];
    let colIdx = 0;

    for (const child of Array.from(rowEl.children)) {
      if (!(child instanceof Element)) {
        continue;
      }
      if (child.localName === 'covered-table-cell') {
        rowValues.push('');
        rowStyleRow.push(undefined);
        rowAnchors.push(null);
        colIdx++;
        continue;
      }
      if (child.localName !== 'table-cell') {
        continue;
      }

      const repeat = odfRepeat(child, 'table:number-columns-repeated');
      const colStyle = columnStyles[colIdx] ?? null;
      const cellStyleName = odfAttr(child, 'table:style-name');
      const style = registry.resolveCellStyle(colStyle, rowStyle, cellStyleName);
      const text = readCellText(child);

      for (let i = 0; i < repeat; i++) {
        rowValues.push(i === 0 ? text : '');
        rowStyleRow.push(style);
        rowAnchors.push(i === 0 ? child : null);
        colIdx++;
      }
    }

    rows.push(rowValues);
    cellStyles.push(rowStyleRow);
    cellElements.push(rowAnchors);
  }

  return { name, tableElement: table, rows, cellStyles, cellElements };
}

function expandColumnStyles(table: Element): (string | null)[] {
  const out: (string | null)[] = [];
  for (const col of childElementsByLocal(table, 'table-column')) {
    const repeat = odfRepeat(col, 'table:number-columns-repeated');
    const styleName = odfAttr(col, 'table:style-name');
    for (let i = 0; i < repeat; i++) {
      out.push(styleName);
    }
  }
  return out;
}
