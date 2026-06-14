import Quill from 'quill';
import {
  findEditorBlot,
  displayedImageWidth,
  indexFromClientPoint,
  isImageEmbedIndex,
  persistImageLayout
} from './pdf-converter-quill-export';

const DRAG_THRESHOLD_PX = 6;

interface PendingDrag {
  img: HTMLImageElement;
  index: number;
  src: string;
  width: number;
  alt: string;
  startX: number;
  startY: number;
}

interface ActiveDrag extends PendingDrag {
  ghost: HTMLElement;
  dropCaret: HTMLElement;
}

interface ImageResizeLike {
  hide?: () => void;
}

/** Drag images anywhere in the Quill document (works alongside imageResize corner handles). */
export default class ImageDragMove {
  private readonly quill: Quill;
  private pending: PendingDrag | null = null;
  private active: ActiveDrag | null = null;

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || event.altKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
      return;
    }
    if (!this.quill.root.contains(target)) {
      return;
    }
    if (this.isResizeHandleTarget(event.target)) {
      return;
    }
    const blot = findEditorBlot(this.quill, target);
    if (!blot) {
      return;
    }
    this.pending = {
      img: target,
      index: this.quill.getIndex(blot),
      src: target.currentSrc || target.src,
      width: displayedImageWidth(target),
      alt: target.alt || '',
      startX: event.clientX,
      startY: event.clientY
    };
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.active) {
      event.preventDefault();
      this.positionGhost(event.clientX, event.clientY);
      this.updateDropCaret(event.clientX, event.clientY);
      return;
    }
    if (!this.pending) {
      return;
    }
    const dx = event.clientX - this.pending.startX;
    const dy = event.clientY - this.pending.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    this.startActiveDrag();
    this.positionGhost(event.clientX, event.clientY);
    this.updateDropCaret(event.clientX, event.clientY);
    event.preventDefault();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (this.active) {
      event.preventDefault();
      event.stopPropagation();
      this.finishActiveDrag(event.clientX, event.clientY);
      return;
    }
    this.pending = null;
  };

  private readonly onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!(target instanceof HTMLImageElement) || !this.quill.root.contains(target)) {
      return;
    }
    const blot = findEditorBlot(this.quill, target);
    if (!blot) {
      return;
    }
    this.pending = {
      img: target,
      index: this.quill.getIndex(blot),
      src: target.currentSrc || target.src,
      width: displayedImageWidth(target),
      alt: target.alt || '',
      startX: touch.clientX,
      startY: touch.clientY
    };
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    if (this.active) {
      event.preventDefault();
      this.positionGhost(touch.clientX, touch.clientY);
      this.updateDropCaret(touch.clientX, touch.clientY);
      return;
    }
    if (!this.pending) {
      return;
    }
    const dx = touch.clientX - this.pending.startX;
    const dy = touch.clientY - this.pending.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    this.startActiveDrag();
    this.positionGhost(touch.clientX, touch.clientY);
    this.updateDropCaret(touch.clientX, touch.clientY);
    event.preventDefault();
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    const touch = event.changedTouches[0];
    if (this.active && touch) {
      event.preventDefault();
      event.stopPropagation();
      this.finishActiveDrag(touch.clientX, touch.clientY);
      return;
    }
    this.pending = null;
  };

  constructor(quill: Quill) {
    this.quill = quill;
    quill.root.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
    quill.root.addEventListener('touchstart', this.onTouchStart, { passive: false });
    document.addEventListener('touchmove', this.onTouchMove, { passive: false });
    document.addEventListener('touchend', this.onTouchEnd);
    document.addEventListener('touchcancel', this.onTouchEnd);
  }

  destroy(): void {
    this.cancelActiveDrag();
    this.pending = null;
    this.quill.root.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
    this.quill.root.removeEventListener('touchstart', this.onTouchStart);
    document.removeEventListener('touchmove', this.onTouchMove);
    document.removeEventListener('touchend', this.onTouchEnd);
    document.removeEventListener('touchcancel', this.onTouchEnd);
  }

  private isResizeHandleTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const cursor = target.style?.cursor || '';
    return cursor.includes('resize');
  }

  private startActiveDrag(): void {
    if (!this.pending) {
      return;
    }
    const resize = this.quill.getModule('imageResize') as ImageResizeLike | undefined;
    resize?.hide?.();

    const ghost = this.pending.img.cloneNode(true) as HTMLImageElement;
    ghost.removeAttribute('id');
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '10050';
    ghost.style.opacity = '0.82';
    ghost.style.margin = '0';
    ghost.style.maxWidth = 'none';
    if (this.pending.width > 0) {
      ghost.style.width = `${this.pending.width}px`;
      ghost.style.height = 'auto';
    }
    document.body.appendChild(ghost);

    const dropCaret = document.createElement('div');
    dropCaret.className = 'pdf-converter-drop-caret';
    dropCaret.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dropCaret);

    this.pending.img.classList.add('pdf-converter-img-drag-source');
    this.active = { ...this.pending, ghost, dropCaret };
    this.pending = null;
    document.body.style.cursor = 'grabbing';
  }

  private positionGhost(clientX: number, clientY: number): void {
    if (!this.active) {
      return;
    }
    const w = this.active.ghost.offsetWidth;
    const h = this.active.ghost.offsetHeight;
    this.active.ghost.style.left = `${clientX - w / 2}px`;
    this.active.ghost.style.top = `${clientY - h / 2}px`;
  }

  private updateDropCaret(clientX: number, clientY: number): void {
    if (!this.active) {
      return;
    }
    const dropIndex = this.resolveDropIndex(clientX, clientY);
    const bounds = this.quill.getBounds(dropIndex, 0);
    if (!bounds) {
      this.active.dropCaret.style.display = 'none';
      return;
    }
    const host = this.quill.root.getBoundingClientRect();
    this.active.dropCaret.style.display = 'block';
    this.active.dropCaret.style.left = `${host.left + bounds.left}px`;
    this.active.dropCaret.style.top = `${host.top + bounds.top}px`;
    this.active.dropCaret.style.height = `${Math.max(bounds.height, 18)}px`;
  }

  private finishActiveDrag(clientX: number, clientY: number): void {
    if (!this.active) {
      return;
    }
    const { index: fromIndex, src, width, alt } = this.active;
    const dropIndex = this.resolveDropIndex(clientX, clientY);

    this.cancelActiveDrag();

    if (dropIndex === fromIndex || dropIndex === fromIndex + 1) {
      return;
    }

    this.quill.deleteText(fromIndex, 1, Quill.sources.USER);
    let insertAt = dropIndex;
    if (dropIndex > fromIndex) {
      insertAt = dropIndex - 1;
    }
    insertAt = Math.max(0, Math.min(insertAt, this.quill.getLength()));
    this.quill.insertEmbed(insertAt, 'image', src, Quill.sources.USER);
    this.applyImageAttributes(insertAt, width, alt);
    persistImageLayout(this.quill);
    this.quill.setSelection(insertAt + 1, 0, Quill.sources.SILENT);
  }

  private resolveDropIndex(clientX: number, clientY: number): number {
    let dropIndex = indexFromClientPoint(this.quill, clientX, clientY);
    if (isImageEmbedIndex(this.quill, dropIndex)) {
      const bounds = this.quill.getBounds(dropIndex, 1);
      if (bounds && clientX > bounds.left + bounds.width / 2) {
        dropIndex += 1;
      }
    }
    dropIndex = Math.max(0, Math.min(dropIndex, this.quill.getLength()));
    return dropIndex;
  }

  private cancelActiveDrag(): void {
    if (this.active) {
      this.active.img.classList.remove('pdf-converter-img-drag-source');
      this.active.ghost.remove();
      this.active.dropCaret.remove();
      this.active = null;
    }
    document.body.style.cursor = '';
  }

  private applyImageAttributes(index: number, width: number, alt: string): void {
    const [leaf] = this.quill.getLeaf(index);
    if (!leaf) {
      return;
    }
    const node = leaf.domNode;
    const img =
      node instanceof HTMLImageElement
        ? node
        : node instanceof HTMLElement
          ? node.querySelector('img')
          : null;
    if (!img) {
      return;
    }
    if (width > 0) {
      img.width = width;
    }
    if (alt) {
      img.alt = alt;
    }
  }
}
