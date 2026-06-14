import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  ViewChild,
  ViewEncapsulation,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs/operators';
import { QuillEditorComponent, QuillModule } from 'ngx-quill';
import Quill from 'quill';
import ImageResize from '@mgreminger/quill-image-resize-module';
import ImageDragMove from './pdf-converter-quill-image-move';
import ImageRemove from './pdf-converter-quill-image-remove';
import {
  captureEditorHtml,
  loadHtmlIntoEditor,
  persistImageLayout,
  removeSelectedImage,
  selectedImageIndex
} from './pdf-converter-quill-export';

import {
  AssistantPdfExportRequest,
  AssistantService
} from '../services/assistant.service';
import {
  PdfConverterDocument,
  PdfConverterService
} from './pdf-converter.service';
import { MembersService } from '../services/members.service';
import { copyPlainTextToClipboard } from '../shared/clipboard-copy';
import { Observable } from 'rxjs';
import { switchMap, take } from 'rxjs/operators';

let pdfConverterQuillExtrasRegistered = false;

function registerPdfConverterQuillExtras(): void {
  if (pdfConverterQuillExtrasRegistered) {
    return;
  }
  Quill.register('modules/imageResize', ImageResize);
  Quill.register('modules/imageDragMove', ImageDragMove);
  Quill.register('modules/imageRemove', ImageRemove);
  pdfConverterQuillExtrasRegistered = true;
}

registerPdfConverterQuillExtras();

@Component({
  selector: 'app-pdf-converter',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, QuillModule],
  templateUrl: './pdf-converter.component.html',
  styleUrls: ['./pdf-converter.component.css'],
  encapsulation: ViewEncapsulation.None
})
export class PdfConverterComponent implements AfterViewInit, OnDestroy {
  private readonly assistant = inject(AssistantService);
  private readonly pdfService = inject(PdfConverterService);
  private readonly membersService = inject(MembersService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild(QuillEditorComponent) quillEditor?: QuillEditorComponent;
  @ViewChild('quillImageInput') quillImageInput?: ElementRef<HTMLInputElement>;

  /** PDF file name without extension. */
  pdfFileName = '';
  htmlContent = '';
  documents: PdfConverterDocument[] = [];
  currentDocumentId: string | null = null;
  loadingDocuments = false;
  saving = false;
  deleting = false;
  exporting = false;
  sharingWhatsApp = false;
  errorKey = '';
  saveMessageKey = '';
  shareMessageKey = '';
  hasSelectedImage = false;
  /** Include full running footer (name, date, author) in exported PDF; page numbers are always shown. */
  showPdfFooter = true;

  private imageDragMove?: ImageDragMove;
  private imageRemove?: ImageRemove;
  private applyingEditorHtml = false;

  private readonly onQuillTextChange = (): void => {
    if (this.applyingEditorHtml) {
      return;
    }
    this.syncHtmlFromEditor();
  };

  private readonly onEditorLayoutEnd = (): void => {
    setTimeout(() => this.syncHtmlFromEditor(), 0);
  };

  /** Same toolbar as commentaries; images can be resized (corners) and moved (drag). */
  readonly quillModules: Record<string, unknown> = {
    toolbar: [
      ['bold', 'italic', 'underline', 'strike'],
      ['blockquote', 'code-block'],
      [{ header: [1, 2, 3, 4, 5, 6, false] }],
      [{ list: 'ordered' }, { list: 'bullet' }],
      [{ script: 'sub' }, { script: 'super' }],
      [{ indent: '-1' }, { indent: '+1' }],
      [{ direction: 'rtl' }],
      [{ size: ['small', false, 'large', 'huge'] }],
      [{ color: [] }, { background: [] }],
      [{ font: [] }],
      [{ align: [] }],
      ['clean'],
      ['link', 'image']
    ],
    imageResize: {
      modules: ['Resize', 'DisplaySize'],
      minWidth: 48,
      keyboardSizeDelta: 16
    },
    imageDragMove: {},
    imageRemove: {}
  };

  constructor() {
    this.loadDocuments();
  }

  ngAfterViewInit(): void {
    const quill = this.quillEditor?.quillEditor;
    if (!quill) {
      return;
    }
    const toolbar = quill.getModule('toolbar') as
      | { addHandler?: (name: string, handler: (...args: unknown[]) => void) => void }
      | undefined;
    toolbar?.addHandler?.('image', () => this.triggerQuillImagePicker());
    toolbar?.addHandler?.('align', (value) => this.applyQuillAlign(value as string | false));
    this.imageDragMove = quill.getModule('imageDragMove') as ImageDragMove | undefined;
    this.imageRemove = quill.getModule('imageRemove') as ImageRemove | undefined;

    quill.on('text-change', this.onQuillTextChange);
    quill.on('selection-change', this.onQuillSelectionChange);
    quill.root.addEventListener('mouseup', this.onEditorLayoutEnd);
    quill.root.addEventListener('touchend', this.onEditorLayoutEnd);

    if (this.htmlContent?.trim()) {
      setTimeout(() => this.applyHtmlToEditor(this.htmlContent), 0);
    }
  }

  onEditorCreated(_quill: Quill): void {
    setTimeout(() => this.applyHtmlToEditor(this.htmlContent), 0);
  }

  private applyHtmlToEditor(html: string): void {
    this.htmlContent = html ?? '';
    const quill = this.quillEditor?.quillEditor;
    if (!quill) {
      return;
    }
    this.applyingEditorHtml = true;
    try {
      loadHtmlIntoEditor(quill, this.htmlContent);
      this.htmlContent = quill.root.innerHTML;
      this.updateSelectedImageState();
    } finally {
      this.applyingEditorHtml = false;
    }
  }

  private readonly onQuillSelectionChange = (): void => {
    this.updateSelectedImageState();
  };

  private updateSelectedImageState(): void {
    const quill = this.quillEditor?.quillEditor;
    quill?.root.querySelectorAll('img').forEach((node) => {
      node.classList.remove('pdf-converter-img-selected');
    });
    if (!quill) {
      this.hasSelectedImage = false;
      return;
    }
    const index = selectedImageIndex(quill);
    this.hasSelectedImage = index != null;
    if (index == null) {
      return;
    }
    const [leaf] = quill.getLeaf(index);
    const node = leaf?.domNode;
    const img =
      node instanceof HTMLImageElement
        ? node
        : node instanceof HTMLElement
          ? node.querySelector('img')
          : null;
    img?.classList.add('pdf-converter-img-selected');
  }

  removeSelectedImage(): void {
    const quill = this.quillEditor?.quillEditor;
    if (!quill) {
      return;
    }
    if (removeSelectedImage(quill)) {
      this.syncHtmlFromEditor();
      this.updateSelectedImageState();
    }
  }

  /** Keeps ngModel/htmlContent aligned with resize & move operations before save/PDF. */
  private syncHtmlFromEditor(): void {
    const quill = this.quillEditor?.quillEditor;
    if (!quill) {
      return;
    }
    persistImageLayout(quill);
    this.htmlContent = quill.root.innerHTML;
  }

  private htmlForExport(): string {
    const quill = this.quillEditor?.quillEditor;
    if (quill) {
      return captureEditorHtml(quill);
    }
    return this.htmlContent ?? '';
  }

  ngOnDestroy(): void {
    const quill = this.quillEditor?.quillEditor;
    if (quill) {
      quill.off('text-change', this.onQuillTextChange);
      quill.off('selection-change', this.onQuillSelectionChange);
      quill.root.removeEventListener('mouseup', this.onEditorLayoutEnd);
      quill.root.removeEventListener('touchend', this.onEditorLayoutEnd);
    }
    this.imageDragMove?.destroy();
    this.imageRemove?.destroy();
  }

  get isBusy(): boolean {
    return this.exporting || this.sharingWhatsApp;
  }

  get canGenerate(): boolean {
    const name = this.pdfFileName.trim();
    return !this.isBusy && name.length > 0 && !this.isHtmlEmpty(this.htmlContent);
  }

  get canSave(): boolean {
    const name = this.pdfFileName.trim();
    return !this.saving && name.length > 0;
  }

  get hasSavedDocument(): boolean {
    return this.currentDocumentId != null;
  }

  triggerQuillImagePicker(): void {
    this.quillImageInput?.nativeElement?.click();
  }

  /** Quill align on block lines; images need formatLine on the embed index. */
  private applyQuillAlign(value: string | false): void {
    const quill = this.quillEditor?.quillEditor;
    if (!quill) {
      return;
    }
    const imgIndex = selectedImageIndex(quill);
    const range = quill.getSelection(true);
    const index = imgIndex ?? range?.index ?? Math.max(0, quill.getLength() - 1);
    const length = imgIndex != null ? 1 : Math.max(1, range?.length ?? 1);
    quill.formatLine(index, length, 'align', value || false, Quill.sources.USER);
    this.syncHtmlFromEditor();
  }

  onQuillImageSelected(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file?.type.startsWith('image/')) {
      return;
    }
    this.compressImageFile(file)
      .then((dataUrl) => this.insertImageAtCursor(dataUrl))
      .catch((err) => console.error('pdf-converter image insert', err));
  }

  loadDocuments(): void {
    this.loadingDocuments = true;
    this.pdfService
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
        error: (err) => console.error('pdf-converter list', err)
      });
  }

  onDocumentSelected(id: string): void {
    if (!id) {
      this.newDocument();
      return;
    }
    this.errorKey = '';
    this.saveMessageKey = '';
    this.pdfService
      .getOne(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (doc) => {
          this.currentDocumentId = doc.id ?? id;
          this.pdfFileName = doc.fileName ?? '';
          this.applyHtmlToEditor(doc.htmlContent ?? '');
        },
        error: (err) => {
          console.error('pdf-converter load', err);
          this.errorKey = 'PDF_CONVERTER.ERR_LOAD';
        }
      });
  }

  newDocument(): void {
    this.currentDocumentId = null;
    this.pdfFileName = '';
    this.applyHtmlToEditor('');
    this.hasSelectedImage = false;
    this.errorKey = '';
    this.saveMessageKey = '';
    this.shareMessageKey = '';
  }

  saveDocument(): void {
    this.errorKey = '';
    this.saveMessageKey = '';
    const fileName = this.pdfFileName.trim();
    if (!fileName) {
      this.errorKey = 'PDF_CONVERTER.ERR_FILENAME_REQUIRED';
      return;
    }
    const html = this.htmlForExport();
    this.htmlContent = html;
    const body: PdfConverterDocument = {
      fileName,
      htmlContent: html
    };
    this.saving = true;
    const req$ = this.currentDocumentId
      ? this.pdfService.update(this.currentDocumentId, body)
      : this.pdfService.create(body);
    req$
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.saving = false;
        })
      )
      .subscribe({
        next: (saved) => {
          this.currentDocumentId = saved.id ?? this.currentDocumentId;
          this.pdfFileName = saved.fileName ?? fileName;
          this.htmlContent = saved.htmlContent ?? this.htmlContent;
          this.saveMessageKey = 'PDF_CONVERTER.SAVED';
          this.loadDocuments();
        },
        error: (err) => {
          console.error('pdf-converter save', err);
          this.errorKey = 'PDF_CONVERTER.ERR_SAVE';
        }
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
    this.pdfService
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
          this.newDocument();
          this.loadDocuments();
          this.saveMessageKey = 'PDF_CONVERTER.DELETED';
        },
        error: (err) => {
          console.error('pdf-converter delete', err);
          this.errorKey = 'PDF_CONVERTER.ERR_DELETE';
        }
      });
  }

  clearAll(): void {
    this.newDocument();
  }

  generatePdf(): void {
    const validated = this.validateForExport();
    if (!validated) {
      return;
    }
    const { title } = validated;

    this.exporting = true;
    this.shareMessageKey = '';
    this.exportPdfBlob$(validated)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.exporting = false;
        })
      )
      .subscribe({
        next: (blob) => this.downloadBlob(blob, this.buildDownloadFilename(title)),
        error: (err) => {
          console.error('pdf-converter export', err);
          this.errorKey = 'PDF_CONVERTER.ERR_EXPORT';
        }
      });
  }

  sharePdfOnWhatsApp(): void {
    const validated = this.validateForExport();
    if (!validated) {
      return;
    }
    const { title } = validated;

    this.sharingWhatsApp = true;
    this.shareMessageKey = '';
    this.exportPdfBlob$(validated)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.sharingWhatsApp = false;
        })
      )
      .subscribe({
        next: (blob) => {
          void this.sharePdfBlobOnWhatsApp(blob, title);
        },
        error: (err) => {
          console.error('pdf-converter whatsapp share', err);
          this.errorKey = 'PDF_CONVERTER.ERR_SHARE_WHATSAPP';
        }
      });
  }

  private validateForExport(): { title: string; html: string } | null {
    this.errorKey = '';
    const title = this.pdfFileName.trim();
    if (!title) {
      this.errorKey = 'PDF_CONVERTER.ERR_FILENAME_REQUIRED';
      return null;
    }
    const html = this.htmlForExport();
    this.htmlContent = html;
    if (this.isHtmlEmpty(html)) {
      this.errorKey = 'PDF_CONVERTER.ERR_CONTENT_REQUIRED';
      return null;
    }
    return { title, html };
  }

  private exportPdfBlob$(validated: {
    title: string;
    html: string;
  }): Observable<Blob> {
    const { title, html } = validated;
    return this.membersService.getUserId({ skipGeolocation: true }).pipe(
      take(1),
      switchMap((member) => {
        const payload: AssistantPdfExportRequest = {
          title,
          exportedAt: new Date().toLocaleString(),
          authorUserName: member.userName?.trim() || undefined,
          authorFirstName: member.firstName?.trim() || undefined,
          authorLastName: member.lastName?.trim() || undefined,
          showFooter: this.showPdfFooter,
          turns: [
            {
              role: 'user',
              content: html,
              contentHtml: true
            }
          ]
        };
        return this.assistant.exportThreadPdf(payload);
      })
    );
  }

  private async sharePdfBlobOnWhatsApp(blob: Blob, title: string): Promise<void> {
    const filename = this.buildDownloadFilename(title);
    const file = new File([blob], filename, { type: 'application/pdf' });
    const pageTitle = this.translate.instant('PDF_CONVERTER.TITLE');
    const message = `*${pageTitle}*\n\n${filename}`;

    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data: ShareData) => boolean;
    };

    const aborted = (e: unknown): boolean =>
      e != null &&
      typeof e === 'object' &&
      'name' in e &&
      String((e as { name?: string }).name) === 'AbortError';

    if (typeof nav.share === 'function') {
      const fileShare: ShareData = { title: pageTitle, text: message, files: [file] };
      if (!nav.canShare || nav.canShare(fileShare)) {
        if (message.trim()) {
          copyPlainTextToClipboard(message);
        }
        try {
          await nav.share(fileShare);
          this.shareMessageKey = 'PDF_CONVERTER.SHARE_WHATSAPP_CAPTION_HINT';
          return;
        } catch (err: unknown) {
          if (aborted(err)) {
            return;
          }
        }
      }
      try {
        await nav.share({ title: pageTitle, text: message });
        return;
      } catch (err: unknown) {
        if (aborted(err)) {
          return;
        }
      }
    }

    this.downloadBlob(blob, filename);
    const attachHint = this.translate.instant('PDF_CONVERTER.SHARE_WHATSAPP_ATTACH_HINT');
    window.open(
      `https://wa.me/?text=${encodeURIComponent(`${message}\n\n${attachHint}`)}`,
      '_blank',
      'noopener,noreferrer'
    );
    this.shareMessageKey = 'PDF_CONVERTER.SHARE_WHATSAPP_FALLBACK_HINT';
  }

  formatDocumentLabel(doc: PdfConverterDocument): string {
    const name = (doc.fileName || '').trim() || 'document';
    if (!doc.updatedAt) {
      return name;
    }
    try {
      const d = new Date(doc.updatedAt);
      return `${name} (${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    } catch {
      return name;
    }
  }

  private insertImageAtCursor(dataUrl: string): void {
    const quill = this.quillEditor?.quillEditor;
    if (!quill || !dataUrl.startsWith('data:image/')) {
      return;
    }
    const range = quill.getSelection(true);
    const index = range?.index ?? quill.getLength();
    quill.insertEmbed(index, 'image', dataUrl, 'user');
    persistImageLayout(quill);
    quill.setSelection(index + 1, 0, 'silent');
    this.htmlContent = quill.root.innerHTML;
  }

  private compressImageFile(file: File, maxSide = 1200, quality = 0.82): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src.startsWith('data:image/')) {
          reject(new Error('invalid image'));
          return;
        }
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          const scale = Math.min(1, maxSide / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(src);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          resolve(canvas.toDataURL(mime, quality));
        };
        img.onerror = () => reject(new Error('image load failed'));
        img.src = src;
      };
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  private isHtmlEmpty(value?: string | null): boolean {
    if (!value) {
      return true;
    }
    const stripped = value
      .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '')
      .replace(/<img\b[^>]*>/gi, 'x')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, '')
      .trim();
    return stripped.length === 0;
  }

  private buildDownloadFilename(title: string): string {
    let base = title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    if (!base) {
      base = 'document';
    }
    if (base.length > 180) {
      base = base.slice(0, 180);
    }
    return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}
