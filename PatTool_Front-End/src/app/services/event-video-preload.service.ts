import { Injectable } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { Evenement } from '../model/evenement';
import { UploadedFile } from '../model/uploadedfile';
import { FileService, ImageDownloadResult } from './file.service';

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'];
const MAX_CONCURRENT_VIDEO_LOADS = 2;

export interface CachedVideo {
  url: SafeUrl;
  size?: number;
}

/**
 * Preloads video blob URLs for events in parallel on the wall (home-evenements).
 * Details-evenement and other components can use the cache to avoid re-fetching.
 */
@Injectable({ providedIn: 'root' })
export class EventVideoPreloadService {
  private cache = new Map<string, CachedVideo>();
  private loading = new Set<string>();
  private queue: Array<{ file: UploadedFile }> = [];
  private activeLoads = 0;
  private subscriptions: Subscription[] = [];

  constructor(
    private fileService: FileService,
    private sanitizer: DomSanitizer
  ) {}

  private static isVideoFile(fileName: string): boolean {
    if (!fileName) return false;
    const lower = fileName.toLowerCase();
    return VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  getCachedUrl(fieldId: string): SafeUrl | undefined {
    return this.cache.get(fieldId)?.url;
  }

  getCachedSize(fieldId: string): number | undefined {
    return this.cache.get(fieldId)?.size;
  }

  hasCached(fieldId: string): boolean {
    return this.cache.has(fieldId);
  }

  /**
   * Queue video files of this event for parallel preload (called from the wall when event is displayed).
   */
  preloadForEvent(evenement: Evenement | null | undefined): void {
    if (!evenement?.fileUploadeds?.length) return;
    const videoFiles = evenement.fileUploadeds.filter((f: UploadedFile) =>
      EventVideoPreloadService.isVideoFile(f.fileName)
    );
    videoFiles.forEach((file: UploadedFile) => {
      if (!file?.fieldId) return;
      if (this.cache.has(file.fieldId) || this.loading.has(file.fieldId)) return;
      if (this.queue.some(item => item.file.fieldId === file.fieldId)) return;
      this.queue.push({ file });
    });
    this.processQueue();
  }

  private processQueue(): void {
    while (this.activeLoads < MAX_CONCURRENT_VIDEO_LOADS && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item || this.cache.has(item.file.fieldId) || this.loading.has(item.file.fieldId)) continue;
      this.activeLoads++;
      this.loading.add(item.file.fieldId);
      const sub = this.fileService.getFileWithMetadata(item.file.fieldId).pipe(
        catchError(() => of(null))
      ).subscribe({
        next: (result: ImageDownloadResult | null) => {
          this.loading.delete(item.file.fieldId);
          this.activeLoads--;
          if (!result?.buffer) {
            this.processQueue();
            return;
          }
          const blob = new Blob([result.buffer]);
          let fileSize = blob.size;
          const contentLength = result.headers?.get('Content-Length');
          if (contentLength) {
            const parsed = parseInt(contentLength, 10);
            if (!isNaN(parsed) && parsed > 0) fileSize = parsed;
          }
          const videoType = this.getVideoMimeType(item.file.fileName);
          const videoBlob = (blob.type !== videoType && (blob.type === 'application/octet-stream' || !blob.type))
            ? new Blob([blob], { type: videoType })
            : blob;
          const blobUrl = URL.createObjectURL(videoBlob);
          const safeUrl = this.sanitizer.bypassSecurityTrustUrl(blobUrl);
          this.cache.set(item.file.fieldId, { url: safeUrl, size: fileSize });
          this.processQueue();
        },
        error: () => {
          this.loading.delete(item.file.fieldId);
          this.activeLoads--;
          this.processQueue();
        }
      });
      this.subscriptions.push(sub);
    }
  }

  private getVideoMimeType(fileName: string): string {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.webm')) return 'video/webm';
    if (lower.endsWith('.ogg') || lower.endsWith('.ogv')) return 'video/ogg';
    if (lower.endsWith('.mov')) return 'video/quicktime';
    if (lower.endsWith('.avi')) return 'video/x-msvideo';
    if (lower.endsWith('.wmv')) return 'video/x-ms-wmv';
    if (lower.endsWith('.flv')) return 'video/x-flv';
    if (lower.endsWith('.mkv')) return 'video/x-matroska';
    return 'video/mp4';
  }

  clear(): void {
    this.subscriptions.forEach(s => { try { s.unsubscribe(); } catch (_) {} });
    this.subscriptions = [];
    // Do not revoke blob URLs here: details-evenement may still hold and display them
    this.cache.clear();
    this.loading.clear();
    this.queue = [];
    this.activeLoads = 0;
  }
}
