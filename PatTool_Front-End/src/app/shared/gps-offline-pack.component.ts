import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import {
  GpsOfflineInventory,
  GpsOfflineRegionSummary,
  GpsViewWindow,
  offlineBasemapMaxZoom,
  offlinePackStyleId
} from '../gps-track/gps-offline-tiles.util';
import { LeafletBasemapService } from './leaflet-basemap.service';
import {
  GpsOfflineDownloadRequest,
  GpsOfflineMapProgress,
  GpsOfflineMapService,
  formatOfflinePackSize
} from '../services/gps-offline-map.service';

const EMPTY_PROGRESS: GpsOfflineMapProgress = { done: 0, total: 0, failed: 0 };

/**
 * Single offline-tile modal. Trace viewer, GPS, GPS / Itinéraire and Trace GPX
 * all open this dialog; tiles are written to the one browser store.
 */
@Component({
  selector: 'app-gps-offline-pack',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './gps-offline-pack.component.html',
  styleUrls: ['./gps-offline-pack.component.css']
})
export class GpsOfflinePackComponent implements OnInit, OnDestroy {
  @ViewChild('downloadModal') downloadModal?: TemplateRef<unknown>;

  request: GpsOfflineDownloadRequest | null = null;
  downloading = false;
  progress: GpsOfflineMapProgress = EMPTY_PROGRESS;
  errorKey = '';
  catalogLoading = false;
  inventory: GpsOfflineInventory | null = null;
  clearing = false;

  private modalRef: NgbModalRef | null = null;
  private readonly sub = new Subscription();

  constructor(
    private readonly offline: GpsOfflineMapService,
    private readonly basemap: LeafletBasemapService,
    private readonly translate: TranslateService,
    private readonly modal: NgbModal,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.sub.add(this.offline.downloadUi$.subscribe((request) => {
      this.request = request;
      this.errorKey = '';
      this.open();
      void this.loadInventory();
    }));
    this.sub.add(this.offline.downloading$.subscribe((downloading) => {
      const finished = this.downloading && !downloading;
      this.downloading = downloading;
      if (finished && this.modalRef) {
        void this.loadInventory();
      }
      this.cdr.markForCheck();
    }));
    this.sub.add(this.offline.progress$.subscribe((progress) => {
      this.progress = progress;
      this.cdr.markForCheck();
    }));
    this.sub.add(this.offline.lastError$.subscribe((error) => {
      this.errorKey = error || '';
      this.cdr.markForCheck();
    }));
  }

  ngOnDestroy(): void {
    this.modalRef?.dismiss();
    this.sub.unsubscribe();
  }

  get styleId(): string {
    return offlinePackStyleId(this.request?.basemapId || '', this.request?.cartesLayerId);
  }

  get maxZoom(): number {
    return offlineBasemapMaxZoom(this.styleId);
  }

  get currentZoom(): number | null {
    const zoom = this.request?.view?.zoom;
    return Number.isFinite(zoom) ? Math.round(zoom as number) : null;
  }

  get percent(): number {
    if (!this.progress.total) {
      return 0;
    }
    return Math.max(0, Math.min(100, (this.progress.done / this.progress.total) * 100));
  }

  get online(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }

  mapLabel(style: string | null | undefined): string {
    const id = (style || '').trim();
    if (!id) {
      return '';
    }
    const layer = this.basemap.getAvailableLayers().find((item) => item.id === id);
    if (!layer) {
      return id;
    }
    return layer.labelKey ? this.translate.instant(layer.labelKey) : layer.label;
  }

  formatSize(bytes: number): string {
    return formatOfflinePackSize(bytes);
  }

  formatCoord(value: number, kind: 'lat' | 'lon'): string {
    const abs = Math.abs(value).toFixed(4);
    const hemi = kind === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
    return `${abs}°${hemi}`;
  }

  windowLabel(view: GpsViewWindow | null | undefined): string {
    if (!view) {
      return '';
    }
    return this.translate.instant('GPS.OFFLINE_MAP_WINDOW', {
      south: this.formatCoord(Math.min(view.south, view.north), 'lat'),
      north: this.formatCoord(Math.max(view.south, view.north), 'lat'),
      west: this.formatCoord(Math.min(view.west, view.east), 'lon'),
      east: this.formatCoord(Math.max(view.west, view.east), 'lon')
    });
  }

  async downloadView(view: GpsViewWindow | null | undefined): Promise<void> {
    if (!view || this.downloading) {
      return;
    }
    await this.offline.downloadView(view, this.request?.basemapId, this.request?.cartesLayerId);
    this.cdr.markForCheck();
  }

  cancel(): void {
    this.offline.cancel();
  }

  async clearStore(): Promise<void> {
    if (this.downloading || this.clearing) {
      return;
    }
    this.clearing = true;
    try {
      await this.offline.clear();
      await this.loadInventory();
    } finally {
      this.clearing = false;
      this.cdr.markForCheck();
    }
  }

  trackRegion(_index: number, region: GpsOfflineRegionSummary): string {
    return region.style;
  }

  private open(): void {
    if (this.modalRef || !this.downloadModal) {
      this.cdr.markForCheck();
      return;
    }
    this.modalRef = this.modal.open(this.downloadModal, {
      size: 'lg',
      centered: true,
      scrollable: true
    });
    void this.modalRef.result.then(
      () => { this.modalRef = null; },
      () => { this.modalRef = null; }
    );
  }

  private async loadInventory(): Promise<void> {
    this.catalogLoading = true;
    this.cdr.markForCheck();
    try {
      this.inventory = await this.offline.inventory();
    } catch {
      this.inventory = { tileCount: 0, bytes: 0, updatedAt: null, regions: [] };
    } finally {
      this.catalogLoading = false;
      this.cdr.markForCheck();
    }
  }
}
