const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

export function elementsByLocal(root: Element | Document, localName: string): Element[] {
  const all =
    root instanceof Document
      ? root.getElementsByTagName('*')
      : root.getElementsByTagName('*');
  const out: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all.item(i);
    if (el?.localName === localName) {
      out.push(el);
    }
  }
  return out;
}

export function childElementsByLocal(parent: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes.item(i);
    if (node instanceof Element && node.localName === localName) {
      out.push(node);
    }
  }
  return out;
}

export function odfAttr(el: Element, name: string): string | null {
  return el.getAttribute(name) ?? el.getAttribute(name.split(':').pop() ?? name);
}

export function odfRepeat(el: Element, attrName: string): number {
  const raw = odfAttr(el, attrName);
  if (!raw) {
    return 1;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function readCellText(cell: Element): string {
  const parts: string[] = [];
  for (const p of childElementsByLocal(cell, 'p')) {
    parts.push(p.textContent ?? '');
  }
  if (parts.length) {
    return parts.join('\n');
  }
  const officeValue = odfAttr(cell, 'office:value');
  if (officeValue != null) {
    return officeValue;
  }
  return (cell.textContent ?? '').trim();
}

export function writeCellText(cell: Element, text: string): void {
  for (const p of childElementsByLocal(cell, 'p')) {
    p.remove();
  }
  const trimmed = text ?? '';
  if (!trimmed) {
    cell.removeAttribute('office:value');
    cell.removeAttribute('office:value-type');
    cell.removeAttribute('office:date-value');
    return;
  }
  const doc = cell.ownerDocument;
  const p = doc.createElementNS(TEXT_NS, 'text:p');
  const lines = trimmed.split('\n');
  if (lines.length === 1) {
    p.textContent = lines[0];
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        p.appendChild(doc.createElementNS(TEXT_NS, 'line-break'));
      }
      p.appendChild(doc.createTextNode(lines[i]));
    }
  }
  cell.appendChild(p);
  cell.setAttribute('office:value-type', 'string');
  cell.removeAttribute('office:value');
  cell.removeAttribute('office:date-value');
}

export function parseOdfXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid ODF XML');
  }
  return doc;
}

export function serializeOdfXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}
