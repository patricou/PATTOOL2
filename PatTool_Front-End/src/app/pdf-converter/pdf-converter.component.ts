import { Component, DestroyRef, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs/operators';

import {
  AssistantPdfExportRequest,
  AssistantService
} from '../services/assistant.service';

interface PdfConverterImage {
  id: string;
  name: string;
  dataUrl: string;
  previewUrl: string;
}

@Component({
  selector: 'app-pdf-converter',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './pdf-converter.component.html',
  styleUrls: ['./pdf-converter.component.css']
})
export class PdfConverterComponent {
  private readonly assistant = inject(AssistantService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('imageInput') imageInput?: ElementRef<HTMLInputElement>;

  /** Nom du fichier PDF sans extension. */
  pdfFileName = '';
  textContent = '';
  images: PdfConverterImage[] = [];
  exporting = false;
  errorKey = '';

  get canGenerate(): boolean {
    const name = this.pdfFileName.trim();
    const hasContent =
      this.textContent.trim().length > 0 || this.images.length > 0;
    return !this.exporting && name.length > 0 && hasContent;
  }

  triggerImagePicker(): void {
    this.imageInput?.nativeElement?.click();
  }

  onImagesSelected(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = input.files;
    if (!files?.length) {
      return;
    }
    for (let i = 0; i < files.length; i++) {
      this.readImageFile(files[i]);
    }
    input.value = '';
  }

  removeImage(id: string): void {
    const img = this.images.find((x) => x.id === id);
    if (img) {
      URL.revokeObjectURL(img.previewUrl);
    }
    this.images = this.images.filter((x) => x.id !== id);
  }

  clearAll(): void {
    for (const img of this.images) {
      URL.revokeObjectURL(img.previewUrl);
    }
    this.images = [];
    this.textContent = '';
    this.errorKey = '';
  }

  generatePdf(): void {
    this.errorKey = '';
    const title = this.pdfFileName.trim();
    if (!title) {
      this.errorKey = 'PDF_CONVERTER.ERR_FILENAME_REQUIRED';
      return;
    }
    const text = this.textContent.trim();
    if (!text && this.images.length === 0) {
      this.errorKey = 'PDF_CONVERTER.ERR_CONTENT_REQUIRED';
      return;
    }

    const payload: AssistantPdfExportRequest = {
      title,
      exportedAt: new Date().toLocaleString(),
      youLabel: this.translate.instant('PDF_CONVERTER.CONTENT_LABEL'),
      assistantLabel: this.translate.instant('PDF_CONVERTER.CONTENT_LABEL'),
      turns: [
        {
          role: 'user',
          content: this.textContent,
          hasImage: this.images.length > 0,
          embeddedImageDataUrls: this.images.map((img) => img.dataUrl)
        }
      ]
    };

    this.exporting = true;
    this.assistant
      .exportThreadPdf(payload)
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

  private readImageFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      this.images = [
        ...this.images,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          dataUrl,
          previewUrl
        }
      ];
    };
    reader.readAsDataURL(file);
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
