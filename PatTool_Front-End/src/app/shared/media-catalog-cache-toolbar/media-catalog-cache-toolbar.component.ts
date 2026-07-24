import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription, of, timer } from 'rxjs';
import { catchError, switchMap, takeWhile } from 'rxjs/operators';

import { ApiService, MediaCatalogCacheStatus } from '../../services/api.service';

@Component({
  selector: 'app-media-catalog-cache-toolbar',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './media-catalog-cache-toolbar.component.html',
  styleUrls: ['./media-catalog-cache-toolbar.component.css']
})
export class MediaCatalogCacheToolbarComponent implements OnDestroy {
  refreshing = false;
  helpOpen = false;
  toastMessage = '';
  toastError = false;
  private pollSub?: Subscription;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private api: ApiService,
    private translate: TranslateService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    this.clearToastTimer();
  }

  /** Prefer FR/EN for help copy; fall back to FR. */
  get helpLang(): 'fr' | 'en' {
    const lang = (this.translate.currentLang || this.translate.defaultLang || 'fr').toLowerCase();
    return lang.startsWith('en') ? 'en' : 'fr';
  }

  openHelp(): void {
    this.helpOpen = true;
    this.cdr.markForCheck();
  }

  closeHelp(): void {
    this.helpOpen = false;
    this.cdr.markForCheck();
  }

  refreshCaches(): void {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    this.showToast(this.translate.instant('MEDIA_CACHE.REFRESH_STARTED'), false);
    this.api.refreshMediaCatalogCache().pipe(
      catchError((err) => {
        if (err?.status === 409) {
          return of({ accepted: false, busy: true } as MediaCatalogCacheStatus & { accepted?: boolean });
        }
        this.refreshing = false;
        this.showToast(this.translate.instant('MEDIA_CACHE.REFRESH_ERROR'), true);
        this.cdr.markForCheck();
        return of(null);
      })
    ).subscribe((res) => {
      if (!res) {
        return;
      }
      this.pollUntilDone();
    });
  }

  private pollUntilDone(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = timer(0, 2000).pipe(
      switchMap(() => this.api.getMediaCatalogCacheStatus().pipe(
        catchError(() => of({ busy: true } as MediaCatalogCacheStatus))
      )),
      takeWhile((st) => !!st?.busy, true)
    ).subscribe({
      next: (st) => {
        if (st?.busy) {
          this.refreshing = true;
          this.cdr.markForCheck();
          return;
        }
        this.refreshing = false;
        if (st?.lastError) {
          this.showToast(this.translate.instant('MEDIA_CACHE.REFRESH_ERROR'), true);
        } else {
          const secs = st?.lastDurationMs != null
            ? Math.max(1, Math.round(Number(st.lastDurationMs) / 1000))
            : null;
          this.showToast(
            secs != null
              ? this.translate.instant('MEDIA_CACHE.REFRESH_DONE_SEC', { seconds: secs })
              : this.translate.instant('MEDIA_CACHE.REFRESH_DONE'),
            false
          );
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.refreshing = false;
        this.showToast(this.translate.instant('MEDIA_CACHE.REFRESH_ERROR'), true);
        this.cdr.markForCheck();
      }
    });
  }

  private showToast(message: string, error: boolean): void {
    this.toastMessage = message;
    this.toastError = error;
    this.clearToastTimer();
    this.toastTimer = setTimeout(() => {
      this.toastMessage = '';
      this.toastTimer = null;
      this.cdr.markForCheck();
    }, error ? 8000 : 6000);
    this.cdr.markForCheck();
  }

  private clearToastTimer(): void {
    if (this.toastTimer != null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }
}
