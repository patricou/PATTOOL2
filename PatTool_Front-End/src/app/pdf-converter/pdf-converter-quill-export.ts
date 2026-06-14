import Quill from 'quill';
import type { Blot } from 'parchment';

/** {@link Quill.find} may return the editor instance; {@link Quill.getIndex} needs a blot. */
export function findEditorBlot(quill: Quill, node: Node, bubble = false): Blot | null {
  const found = Quill.find(node, bubble);
  if (!found || found === quill) {
    return null;
  }
  return found as Blot;
}

export function isImageEmbedIndex(quill: Quill, index: number): boolean {
  const [leaf] = quill.getLeaf(index);
  if (!leaf) {
    return false;
  }
  return imageFromDomNode(leaf.domNode) != null;
}

function imageFromDomNode(node: Node): HTMLImageElement | null {
  if (node instanceof HTMLImageElement) {
    return node;
  }
  if (node instanceof HTMLElement) {
    return node.querySelector('img');
  }
  return null;
}

function parsePx(value: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? Math.max(1, Math.round(parseFloat(match[1]))) : 0;
}

/** Rendered width after CSS/resize-module changes (not naturalWidth). */
export function displayedImageWidth(node: HTMLImageElement): number {
  const styleWidth = parsePx(node.style.width);
  if (styleWidth > 0) {
    return styleWidth;
  }
  const layoutWidth = Math.round(node.getBoundingClientRect().width);
  if (layoutWidth > 0) {
    return layoutWidth;
  }
  const widthAttr = node.getAttribute('width');
  if (widthAttr && /^\d+$/.test(widthAttr)) {
    return parseInt(widthAttr, 10);
  }
  return node.naturalWidth > 0 ? node.naturalWidth : 0;
}

function displayedImageHeight(node: HTMLImageElement, width: number): number {
  const styleHeight = parsePx(node.style.height);
  if (styleHeight > 0 && node.style.height !== 'auto') {
    return styleHeight;
  }
  const layoutHeight = Math.round(node.getBoundingClientRect().height);
  if (layoutHeight > 0) {
    return layoutHeight;
  }
  if (node.naturalWidth > 0 && node.naturalHeight > 0 && width > 0) {
    return Math.max(1, Math.round((width / node.naturalWidth) * node.naturalHeight));
  }
  const heightAttr = node.getAttribute('height');
  if (heightAttr && /^\d+$/.test(heightAttr)) {
    return parseInt(heightAttr, 10);
  }
  return 0;
}

/** Index of the image embed under the current selection, or null. */
export function selectedImageIndex(quill: Quill): number | null {
  const range = quill.getSelection();
  if (!range) {
    return null;
  }
  if (range.length >= 1 && isImageEmbedIndex(quill, range.index)) {
    return range.index;
  }
  if (range.length === 0) {
    if (range.index > 0 && isImageEmbedIndex(quill, range.index - 1)) {
      return range.index - 1;
    }
    if (isImageEmbedIndex(quill, range.index)) {
      return range.index;
    }
  }
  return null;
}

export function removeImageAt(quill: Quill, index: number): boolean {
  if (!isImageEmbedIndex(quill, index)) {
    return false;
  }
  quill.deleteText(index, 1, Quill.sources.USER);
  return true;
}

export function removeSelectedImage(quill: Quill): boolean {
  const index = selectedImageIndex(quill);
  if (index == null) {
    return false;
  }
  return removeImageAt(quill, index);
}

/** After loading HTML, apply stored width/height attributes to rendered images. */
export function restoreImageLayoutFromHtml(quill: Quill): void {
  quill.root.querySelectorAll('img').forEach((node) => {
    if (!(node instanceof HTMLImageElement)) {
      return;
    }
    const widthAttr = node.getAttribute('width');
    if (widthAttr && /^\d+$/.test(widthAttr)) {
      node.width = parseInt(widthAttr, 10);
    }
    const heightAttr = node.getAttribute('height');
    if (heightAttr && /^\d+$/.test(heightAttr)) {
      node.height = parseInt(heightAttr, 10);
    }
    if (widthAttr && /^\d+$/.test(widthAttr)) {
      node.style.width = `${widthAttr}px`;
      node.style.height = 'auto';
      node.style.maxWidth = '100%';
    }
  });
  persistImageLayout(quill);
}

/** Persist rendered image dimensions into HTML attributes Quill/PDF export understand. */
export function persistImageLayout(quill: Quill): boolean {
  let changed = false;
  quill.root.querySelectorAll('img').forEach((node) => {
    if (!(node instanceof HTMLImageElement)) {
      return;
    }
    const width = displayedImageWidth(node);
    if (width <= 0) {
      return;
    }
    const height = displayedImageHeight(node, width);
    const widthStr = String(width);
    const heightStr = height > 0 ? String(height) : '';
    if (node.getAttribute('width') !== widthStr) {
      node.setAttribute('width', widthStr);
      changed = true;
    }
    if (heightStr && node.getAttribute('height') !== heightStr) {
      node.setAttribute('height', heightStr);
      changed = true;
    }
    const styleWidth = `${width}px`;
    const styleHeight = heightStr ? `${heightStr}px` : 'auto';
    if (node.style.width !== styleWidth) {
      node.style.width = styleWidth;
      changed = true;
    }
    if (node.style.height !== styleHeight) {
      node.style.height = styleHeight;
      changed = true;
    }
    if (node.style.maxWidth !== '100%') {
      node.style.maxWidth = '100%';
      changed = true;
    }
  });
  return changed;
}

/** HTML snapshot for save/PDF: layout persisted, document order preserved. */
export function captureEditorHtml(quill: Quill): string {
  persistImageLayout(quill);
  return quill.root.innerHTML;
}

/** ngx-quill does not always sync ngModel → editor after init; push HTML explicitly. */
export function loadHtmlIntoEditor(quill: Quill, html: string): void {
  const content = html ?? '';
  quill.setContents([], Quill.sources.SILENT);
  if (content.trim()) {
    const delta = quill.clipboard.convert({ html: content });
    quill.setContents(delta, Quill.sources.SILENT);
  }
  quill.history.clear();
  restoreImageLayoutFromHtml(quill);
}

export function indexFromClientPoint(quill: Quill, clientX: number, clientY: number): number {
  const doc = quill.root.ownerDocument;
  let range: Range | null = null;
  if (doc.caretRangeFromPoint) {
    range = doc.caretRangeFromPoint(clientX, clientY);
  } else {
    const pos = (
      doc as Document & {
        caretPositionFromPoint?(
          x: number,
          y: number
        ): { offsetNode: Node; offset: number } | null;
      }
    ).caretPositionFromPoint?.(clientX, clientY);
    if (pos) {
      range = doc.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range || !quill.root.contains(range.startContainer)) {
    return Math.max(0, quill.getLength() - 1);
  }
  const blot = findEditorBlot(quill, range.startContainer, true);
  if (!blot) {
    return Math.max(0, quill.getLength() - 1);
  }
  let index = quill.getIndex(blot);
  if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0) {
    index += range.startOffset;
  }
  return Math.max(0, Math.min(index, quill.getLength()));
}
