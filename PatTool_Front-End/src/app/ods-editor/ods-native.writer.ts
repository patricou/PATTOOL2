import * as JSZip from 'jszip';

import type { OdsSheetData, OdsWorkbookModel } from './ods-editor-workbook.util';
import { serializeOdfXml, writeCellText } from './ods-xml.util';

export async function saveOdsPreservingFormat(model: OdsWorkbookModel): Promise<Blob> {
  if (!model.nativeSession) {
    throw new Error('No native session');
  }
  const { sourceBytes, contentDoc, sheets: parsedSheets } = model.nativeSession;

  for (let s = 0; s < model.sheets.length; s++) {
    const data = model.sheets[s];
    const parsed = parsedSheets[s];
    if (!parsed) {
      continue;
    }
    syncSheetName(parsed.tableElement, data.name);
    syncSheetValues(data, parsed.cellElements);
  }

  const zip = await JSZip.loadAsync(sourceBytes);
  zip.file('content.xml', serializeOdfXml(contentDoc));
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
}

function syncSheetName(tableEl: Element, name: string): void {
  const trimmed = name.trim();
  if (trimmed) {
    tableEl.setAttribute('table:name', trimmed.slice(0, 31));
  }
}

function syncSheetValues(sheet: OdsSheetData, anchors: (Element | null)[][]): void {
  const rowCount = Math.min(sheet.rows.length, anchors.length);
  for (let r = 0; r < rowCount; r++) {
    const row = sheet.rows[r] ?? [];
    const anchorRow = anchors[r] ?? [];
    const colCount = Math.min(row.length, anchorRow.length);
    for (let c = 0; c < colCount; c++) {
      const cellEl = anchorRow[c];
      if (!cellEl) {
        continue;
      }
      writeCellText(cellEl, row[c] ?? '');
    }
  }
}
