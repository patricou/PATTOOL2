import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** Multiplier of the “fit page width” scale. */
export const PREVIEW_ZOOM_MIN = 0.5;
export const PREVIEW_ZOOM_MAX = 4;

export interface PreviewZoomAnchor {
  fx: number;
  fy: number;
  clientX: number;
  clientY: number;
}

export function clampPreviewZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return 1;
  }
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, zoom));
}

/**
 * Renders a PDF blob into canvases with pdf.js.
 * Zoom is a multiplier of the width that fits the stage.
 */
export class PdfDocumentPreview {
  private doc: PDFDocumentProxy | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private tasks: RenderTask[] = [];
  private generation = 0;

  get ready(): boolean {
    return this.doc != null;
  }

  /** Returns false when the caller is no longer the active preview. */
  async load(blob: Blob, stillCurrent: () => boolean): Promise<boolean> {
    const pdfjs = await import('pdfjs-dist');
    if (!stillCurrent()) {
      return false;
    }
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'assets/pdf.worker.min.mjs',
      document.baseURI
    ).href;
    await this.disposeDocument();
    if (!stillCurrent()) {
      return false;
    }
    const data = new Uint8Array(await blob.arrayBuffer());
    if (!stillCurrent()) {
      return false;
    }
    const task = pdfjs.getDocument({ data });
    this.loadingTask = task;
    try {
      const doc = await task.promise;
      if (!stillCurrent()) {
        await doc.destroy().catch(() => undefined);
        if (this.loadingTask === task) {
          this.loadingTask = null;
          this.doc = null;
        }
        return false;
      }
      this.doc = doc;
      return true;
    } catch (err) {
      if (this.loadingTask === task) {
        this.loadingTask = null;
      }
      throw err;
    }
  }

  async render(
    host: HTMLElement,
    stage: HTMLElement,
    zoom: number,
    anchor: PreviewZoomAnchor | null
  ): Promise<void> {
    const doc = this.doc;
    if (!doc) {
      return;
    }
    const generation = ++this.generation;
    this.cancelTasks();
    host.replaceChildren();
    const budget = Math.max(240, stage.clientWidth - 32);
    const first = await doc.getPage(1);
    if (generation !== this.generation) {
      return;
    }
    const base = first.getViewport({ scale: 1 });
    const cssScale = (budget / Math.max(1, base.width)) * clampPreviewZoom(zoom);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const renderScale = cssScale * dpr;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (generation !== this.generation) {
        return;
      }
      const page = pageNumber === 1 ? first : await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-converter-preview-page';
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      host.appendChild(canvas);
      const task = page.render({ canvas, viewport });
      this.tasks.push(task);
      try {
        await task.promise;
      } catch (err) {
        if (isCancelledRender(err) || generation !== this.generation) {
          return;
        }
        throw err;
      }
    }

    if (anchor && generation === this.generation) {
      const rect = host.getBoundingClientRect();
      stage.scrollLeft += rect.left + anchor.fx * rect.width - anchor.clientX;
      stage.scrollTop += rect.top + anchor.fy * rect.height - anchor.clientY;
    }
  }

  cancel(): void {
    this.generation++;
    this.cancelTasks();
  }

  async destroy(): Promise<void> {
    this.cancel();
    await this.disposeDocument();
  }

  private cancelTasks(): void {
    for (const task of this.tasks) {
      try {
        task.cancel();
      } catch {
        /* already settled */
      }
    }
    this.tasks = [];
  }

  private async disposeDocument(): Promise<void> {
    const doc = this.doc;
    const task = this.loadingTask;
    this.doc = null;
    this.loadingTask = null;
    try {
      if (doc) {
        await doc.destroy();
      } else if (task && !task.destroyed) {
        await task.destroy();
      }
    } catch {
      /* ignore teardown errors */
    }
  }
}

function isCancelledRender(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name?: string }).name === 'RenderingCancelledException'
  );
}
