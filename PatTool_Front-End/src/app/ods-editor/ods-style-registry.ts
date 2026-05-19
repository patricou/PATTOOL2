import type { OdfStyleRecord, OdsCellStyle } from './ods-cell-style.model';
import { childElementsByLocal, elementsByLocal, odfAttr } from './ods-xml.util';

export class OdsStyleRegistry {
  private readonly styles = new Map<string, OdfStyleRecord>();

  static fromDocuments(...docs: Document[]): OdsStyleRegistry {
    const reg = new OdsStyleRegistry();
    for (const doc of docs) {
      reg.ingestDocument(doc);
    }
    return reg;
  }

  private ingestDocument(doc: Document): void {
    for (const styleEl of elementsByLocal(doc, 'style')) {
      const name = odfAttr(styleEl, 'style:name');
      if (!name) {
        continue;
      }
      const tableCell: Record<string, string> = {};
      const text: Record<string, string> = {};
      for (const props of childElementsByLocal(styleEl, 'table-cell-properties')) {
        for (let i = 0; i < props.attributes.length; i++) {
          const a = props.attributes.item(i);
          if (a) {
            tableCell[a.name] = a.value;
          }
        }
      }
      for (const props of childElementsByLocal(styleEl, 'text-properties')) {
        for (let i = 0; i < props.attributes.length; i++) {
          const a = props.attributes.item(i);
          if (a) {
            text[a.name] = a.value;
          }
        }
      }
      for (const props of childElementsByLocal(styleEl, 'paragraph-properties')) {
        for (let i = 0; i < props.attributes.length; i++) {
          const a = props.attributes.item(i);
          if (a && !text[a.name]) {
            text[a.name] = a.value;
          }
        }
      }
      this.styles.set(name, {
        parent: odfAttr(styleEl, 'style:parent-style-name') ?? undefined,
        family: odfAttr(styleEl, 'style:family') ?? undefined,
        tableCell,
        text
      });
    }
  }

  resolveCellStyle(
    columnStyle?: string | null,
    rowStyle?: string | null,
    cellStyle?: string | null
  ): OdsCellStyle | undefined {
    const merged: OdsCellStyle = {};
    const chain = [columnStyle, rowStyle, cellStyle].filter(
      (s): s is string => !!s && s.length > 0
    );
    for (const name of chain) {
      this.applyStyleName(name, merged);
    }
    return Object.keys(merged).length ? merged : undefined;
  }

  private applyStyleName(name: string, target: OdsCellStyle): void {
    const seen = new Set<string>();
    let current: string | undefined = name;
    while (current && !seen.has(current)) {
      seen.add(current);
      const rec = this.styles.get(current);
      if (!rec) {
        break;
      }
      this.mergeRecord(rec, target);
      current = rec.parent;
    }
  }

  private mergeRecord(rec: OdfStyleRecord, target: OdsCellStyle): void {
    const tc = rec.tableCell;
    const tx = rec.text;

    const bg =
      pick(tc, 'fo:background-color') ??
      pick(tc, 'background-color');
    if (bg && !target.backgroundColor) {
      target.backgroundColor = normalizeColor(bg);
    }

    const color = pick(tx, 'fo:color') ?? pick(tx, 'color');
    if (color && !target.color) {
      target.color = normalizeColor(color);
    }

    const fw = pick(tx, 'fo:font-weight') ?? pick(tx, 'font-weight');
    if (fw && !target.fontWeight) {
      target.fontWeight = fw === 'bold' || fw === '700' ? 'bold' : fw;
    }

    const fs = pick(tx, 'fo:font-style') ?? pick(tx, 'font-style');
    if (fs && !target.fontStyle) {
      target.fontStyle = fs;
    }

    const align = pick(tx, 'fo:text-align') ?? pick(tx, 'text-align');
    if (align && !target.textAlign) {
      target.textAlign = align;
    }

    const underline =
      pick(tx, 'style:text-underline-style') ?? pick(tx, 'text-underline-style');
    if (underline && underline !== 'none' && !target.textDecoration) {
      target.textDecoration = 'underline';
    }

    const size = pick(tx, 'fo:font-size') ?? pick(tx, 'font-size');
    if (size && !target.fontSize) {
      target.fontSize = size;
    }

    const family = pick(tx, 'fo:font-family') ?? pick(tx, 'font-family');
    if (family && !target.fontFamily) {
      target.fontFamily = stripQuotes(family);
    }

    const valign =
      pick(tc, 'style:vertical-align') ??
      pick(tc, 'vertical-align');
    if (valign && !target.verticalAlign) {
      target.verticalAlign = mapVerticalAlign(valign);
    }

    const wrap = pick(tc, 'fo:wrap-option') ?? pick(tc, 'wrap-option');
    if (wrap === 'no-wrap' && !target.whiteSpace) {
      target.whiteSpace = 'nowrap';
    }

    applyBorder(target, tc, 'top', 'border-top');
    applyBorder(target, tc, 'bottom', 'border-bottom');
    applyBorder(target, tc, 'left', 'border-left');
    applyBorder(target, tc, 'right', 'border-right');
  }
}

function pick(map: Record<string, string>, key: string): string | undefined {
  if (map[key]) {
    return map[key];
  }
  const short = key.includes(':') ? key.split(':').pop()! : key;
  return map[short];
}

function normalizeColor(value: string): string {
  const v = value.trim();
  if (v === 'transparent') {
    return 'transparent';
  }
  if (v.startsWith('#')) {
    return v;
  }
  return v;
}

function stripQuotes(font: string): string {
  return font.replace(/^['"]|['"]$/g, '').split(',')[0].trim();
}

function mapVerticalAlign(v: string): string {
  switch (v) {
    case 'top':
      return 'top';
    case 'bottom':
      return 'bottom';
    case 'middle':
    case 'center':
      return 'middle';
    default:
      return v;
  }
}

function applyBorder(
  target: OdsCellStyle,
  tc: Record<string, string>,
  side: 'top' | 'bottom' | 'left' | 'right',
  styleKey: string
): void {
  const width =
    pick(tc, `fo:border-${side}`) ??
    pick(tc, `border-${side}`) ??
    pick(tc, styleKey);
  if (!width || width === 'none') {
    return;
  }
  const key = `border${side.charAt(0).toUpperCase()}${side.slice(1)}` as keyof OdsCellStyle;
  if (!target[key]) {
    (target as Record<string, string>)[key] = width.includes('solid') ? width : `1px solid ${width}`;
  }
}
