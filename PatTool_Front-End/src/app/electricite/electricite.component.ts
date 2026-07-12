import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { BaseChartDirective } from 'ng2-charts';
import { Chart, ChartConfiguration, ChartOptions, registerables } from 'chart.js';
import * as L from 'leaflet';
import { Subscription, interval } from 'rxjs';

import { LeafletBasemapService } from '../shared/leaflet-basemap.service';
import {
  ApiService,
  ElectricityFrPlant,
  ElectricityGenerationPoint,
  ElectricityNuclearPlant,
  ElectricityOverview,
  ElectricityUnavailability
} from '../services/api.service';

Chart.register(...registerables);

type MapMode = 'fr' | 'world';
type WorldStatusFilter = 'operational' | 'all';

@Component({
  selector: 'app-electricite',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NgbModule,
    BaseChartDirective
  ],
  templateUrl: './electricite.component.html',
  styleUrls: ['./electricite.component.css']
})
export class ElectriciteComponent implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;
  @ViewChild('mapHost') mapHost?: ElementRef<HTMLDivElement>;
  @ViewChild('unavailModal') unavailModal?: TemplateRef<unknown>;
  @ViewChild(BaseChartDirective) chart?: BaseChartDirective;

  overview: ElectricityOverview | null = null;
  frPlants: ElectricityFrPlant[] = [];
  worldPlants: ElectricityNuclearPlant[] = [];
  unavailabilities: ElectricityUnavailability[] = [];

  mapMode: MapMode = 'fr';
  worldStatusFilter: WorldStatusFilter = 'operational';
  mapFullscreen = false;
  unavailFilterTranche: string | null = null;

  isLoading = false;
  errorMessage = '';
  lastUpdatedLabel = '';

  chartData: ChartConfiguration<'line'>['data'] = { labels: [], datasets: [] };
  chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top' },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.dataset.label}: ${(ctx.parsed.y as number).toLocaleString()} MW`
        }
      }
    },
    scales: {
      x: { ticks: { maxTicksLimit: 8 } },
      y: {
        ticks: {
          callback: (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
        }
      }
    }
  };

  private map?: L.Map;
  private baseLayer: L.TileLayer | L.LayerGroup | null = null;
  private mapLayer?: L.FeatureGroup;
  private mapReady = false;
  private pendingMapRefresh = false;
  private refreshSub?: Subscription;
  private readonly refreshMs = 5 * 60_000;
  private mapPopupActionsWired = false;

  constructor(
    private readonly api: ApiService,
    private readonly basemap: LeafletBasemapService,
    private readonly cdr: ChangeDetectorRef,
    private readonly modalService: NgbModal,
    private readonly translate: TranslateService,
    private readonly ngZone: NgZone
  ) {}

  ngOnInit(): void {
    this.loadAll();
    this.refreshSub = interval(this.refreshMs).subscribe(() => this.loadAll(true));
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.ensureMap(), 0);
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    this.exitMapFullscreenIfActive();
    this.map?.remove();
    this.map = undefined;
  }

  loadAll(silent = false): void {
    if (!silent) {
      this.isLoading = true;
      this.errorMessage = '';
    }
    this.api.getElectricityOverview().subscribe({
      next: (res) => {
        this.overview = res;
        this.isLoading = false;
        this.errorMessage = '';
        this.lastUpdatedLabel = this.formatUpdatedAt(res.updatedAt);
        this.rebuildChart(res.frHistory || []);
        this.cdr.markForCheck();
        setTimeout(() => this.ensureMap(), 0);
      },
      error: () => {
        this.isLoading = false;
        if (!this.overview) {
          this.errorMessage = 'ELECTRICITE.ERROR';
        }
        this.cdr.markForCheck();
      }
    });

    this.api.getElectricityFrPlants().subscribe({
      next: (plants) => {
        this.frPlants = plants;
        this.refreshMapMarkers();
        this.cdr.markForCheck();
      }
    });

    this.api.getElectricityWorldNuclearPlants().subscribe({
      next: (plants) => {
        this.worldPlants = plants;
        this.refreshMapMarkers();
        this.cdr.markForCheck();
      }
    });

    this.api.getElectricityFrUnavailabilities(true).subscribe({
      next: (rows) => {
        this.unavailabilities = rows;
        this.refreshMapMarkers();
        this.cdr.markForCheck();
      }
    });
  }

  setMapMode(mode: MapMode): void {
    this.mapMode = mode;
    this.ensureMap();
    this.refreshMapMarkers();
  }

  setWorldStatusFilter(filter: WorldStatusFilter): void {
    this.worldStatusFilter = filter;
    if (this.mapMode === 'world') {
      this.refreshMapMarkers();
    }
  }

  toggleMapFullscreen(): void {
    const shell = this.mapShell?.nativeElement;
    if (!shell) {
      return;
    }
    if (this.mapFullscreen) {
      this.exitMapFullscreenIfActive();
      return;
    }
    const request = shell.requestFullscreen?.bind(shell)
      ?? (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(shell);
    request?.().catch(() => {
      this.mapFullscreen = true;
      this.refreshMapLayoutAfterResize();
    });
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onMapFullscreenChange(): void {
    const shell = this.mapShell?.nativeElement;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const active = !!(shell && (document.fullscreenElement === shell || doc.webkitFullscreenElement === shell));
    if (this.mapFullscreen === active) {
      return;
    }
    this.mapFullscreen = active;
    this.refreshMapLayoutAfterResize();
  }

  @HostListener('document:keydown.escape')
  onMapFullscreenEscape(): void {
    if (this.mapFullscreen) {
      this.exitMapFullscreenIfActive();
    }
  }

  get filteredWorldPlants(): ElectricityNuclearPlant[] {
    if (this.worldStatusFilter === 'all') {
      return this.worldPlants;
    }
    return this.worldPlants.filter((p) => (p.status || '').toLowerCase() === 'operational');
  }

  get modalUnavailabilities(): ElectricityUnavailability[] {
    if (!this.unavailFilterTranche) {
      return this.unavailabilities;
    }
    const key = this.unavailFilterTranche.trim().toUpperCase();
    return this.unavailabilities.filter((u) => (u.nom || '').trim().toUpperCase() === key);
  }

  unavailabilityForTranche(tranche: string): ElectricityUnavailability | undefined {
    const key = (tranche || '').trim().toUpperCase();
    return this.unavailabilities.find((u) => (u.nom || '').trim().toUpperCase() === key);
  }

  formatMw(value: number | null | undefined): string {
    if (value == null || Number.isNaN(value)) {
      return '—';
    }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} MW`;
  }

  formatDatetime(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    try {
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return iso;
    }
  }

  openUnavailModal(tranche?: string | null): void {
    if (!this.unavailModal) {
      return;
    }
    this.unavailFilterTranche = tranche?.trim() || null;
    const ref = this.modalService.open(this.unavailModal, {
      size: 'lg',
      scrollable: true,
      centered: true,
      windowClass: 'electricite-unavail-modal'
    });
    ref.closed.subscribe(() => {
      this.unavailFilterTranche = null;
      this.cdr.markForCheck();
    });
    ref.dismissed.subscribe(() => {
      this.unavailFilterTranche = null;
      this.cdr.markForCheck();
    });
  }

  trackUnavail(_index: number, u: ElectricityUnavailability): string {
    return u.identifiant || u.nom || String(_index);
  }

  formatUnavailPower(u: ElectricityUnavailability): string {
    if (u.puissanceDisponibleMw != null && u.puissanceMaximaleMw != null) {
      return `${u.puissanceDisponibleMw.toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${u.puissanceMaximaleMw.toLocaleString(undefined, { maximumFractionDigits: 0 })} MW`;
    }
    if (u.puissanceMaximaleMw != null) {
      return `${u.puissanceMaximaleMw.toLocaleString(undefined, { maximumFractionDigits: 0 })} MW max`;
    }
    return '—';
  }

  private ensureMap(): void {
    const el = this.mapHost?.nativeElement;
    if (!el || this.map) {
      if (this.map) {
        this.map.invalidateSize();
        this.refreshMapMarkers();
      }
      return;
    }
    this.map = L.map(el, { zoomControl: true, attributionControl: true });
    this.baseLayer = this.basemap.applyBaseLayer(this.map, 'osm-standard', null);
    this.mapLayer = L.featureGroup().addTo(this.map);
    this.mapReady = true;
    this.map.setView([46.6, 2.5], 6);
    this.wireMapPopupActions();
    setTimeout(() => {
      this.map?.invalidateSize();
      this.refreshMapMarkers();
    }, 0);
  }

  private refreshMapMarkers(): void {
    if (!this.mapReady || !this.map || !this.mapLayer) {
      this.pendingMapRefresh = true;
      return;
    }
    this.pendingMapRefresh = false;
    this.mapLayer.clearLayers();

    if (this.mapMode === 'fr') {
      for (const plant of this.frPlants) {
        if (plant.latitude == null || plant.longitude == null) {
          continue;
        }
        const unavail = this.unavailabilityForTranche(plant.tranche || '');
        const color = unavail ? '#dc3545' : '#198754';
        const marker = L.circleMarker([plant.latitude, plant.longitude], {
          radius: 8,
          color: '#fff',
          weight: 1,
          fillColor: color,
          fillOpacity: 0.9
        });
        marker.bindPopup(this.buildFrPlantPopup(plant, unavail), { maxWidth: 280 });
        marker.addTo(this.mapLayer);
      }
    } else {
      for (const plant of this.filteredWorldPlants) {
        if (plant.latitude == null || plant.longitude == null) {
          continue;
        }
        const isOp = (plant.status || '').toLowerCase() === 'operational';
        const marker = L.circleMarker([plant.latitude, plant.longitude], {
          radius: isOp ? 5 : 4,
          color: '#333',
          weight: 0.5,
          fillColor: isOp ? '#0d6efd' : '#adb5bd',
          fillOpacity: 0.85
        });
        marker.bindPopup([
          `<strong>${plant.name}</strong>`,
          plant.country,
          plant.status,
          plant.reactorType || '',
          plant.capacityMw != null ? `${plant.capacityMw} MW` : ''
        ].filter(Boolean).join('<br>'));
        marker.addTo(this.mapLayer);
      }
    }
    this.fitMapBounds();
  }

  private fitMapBounds(): void {
    if (!this.map || !this.mapLayer) {
      return;
    }
    const bounds = this.mapLayer.getBounds();
    if (bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.12));
    } else if (this.mapMode === 'fr') {
      this.map.setView([46.6, 2.5], 6);
    } else {
      this.map.setView([30, 10], 2);
    }
  }

  private exitMapFullscreenIfActive(): void {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document);
      exit?.().catch(() => {
        this.mapFullscreen = false;
        this.refreshMapLayoutAfterResize();
      });
      return;
    }
    if (this.mapFullscreen) {
      this.mapFullscreen = false;
      this.refreshMapLayoutAfterResize();
    }
  }

  private refreshMapLayoutAfterResize(): void {
    setTimeout(() => {
      this.map?.invalidateSize();
      this.fitMapBounds();
    }, 120);
  }

  private rebuildChart(history: ElectricityGenerationPoint[]): void {
    const chronological = [...history].reverse();
    const labels = chronological.map((p) => this.formatDatetime(p.datetime));
    this.chartData = {
      labels,
      datasets: [
        this.lineDataset('Nucléaire', chronological.map((p) => p.nucleaire), '#6f42c1'),
        this.lineDataset('Éolien', chronological.map((p) => p.eolien), '#20c997'),
        this.lineDataset('Solaire', chronological.map((p) => p.solaire), '#ffc107'),
        this.lineDataset('Gaz', chronological.map((p) => p.gaz), '#fd7e14'),
        this.lineDataset('Hydraulique', chronological.map((p) => p.hydraulique), '#0dcaf0')
      ]
    };
    this.chart?.update();
  }

  private lineDataset(label: string, data: Array<number | null | undefined>, color: string) {
    return {
      label,
      data: data.map((v) => (v == null ? null : v)),
      borderColor: color,
      backgroundColor: color + '33',
      tension: 0.25,
      pointRadius: 0,
      borderWidth: 2,
      fill: false
    };
  }

  private formatUpdatedAt(iso: string | null | undefined): string {
    if (!iso) {
      return '';
    }
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  private buildFrPlantPopup(plant: ElectricityFrPlant, unavail?: ElectricityUnavailability): string {
    const tranche = plant.tranche || '';
    const statusClass = unavail ? 'electricite-popup-status--warn' : 'electricite-popup-status--ok';
    const statusLabel = unavail
      ? this.translate.instant('ELECTRICITE.POPUP_STATUS_UNAVAIL')
      : this.translate.instant('ELECTRICITE.POPUP_STATUS_OK');
    const btnLabel = this.translate.instant('ELECTRICITE.POPUP_VIEW_UNAVAIL');
    const lines = [
      `<div class="electricite-map-popup">`,
      `<strong class="electricite-popup-title">${this.escapeHtml(tranche)}</strong>`,
      plant.centrale ? `<div>${this.escapeHtml(plant.centrale)}</div>` : '',
      `<div>${plant.puissanceInstalleeMw ?? '—'} MW</div>`,
      plant.region ? `<div class="text-muted small">${this.escapeHtml(plant.region)}</div>` : '',
      `<div class="electricite-popup-status ${statusClass}">${this.escapeHtml(statusLabel)}</div>`,
      `<button type="button" class="btn btn-sm electricite-popup-unavail-btn ${unavail ? 'btn-danger' : 'btn-outline-secondary'} mt-2" data-tranche="${this.escapeAttr(tranche)}">`,
      `<i class="fa fa-exclamation-triangle me-1"></i>${this.escapeHtml(btnLabel)}`,
      `</button>`,
      `</div>`
    ];
    return lines.filter(Boolean).join('');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private escapeAttr(value: string): string {
    return this.escapeHtml(value).replace(/'/g, '&#39;');
  }

  private wireMapPopupActions(): void {
    const host = this.mapHost?.nativeElement;
    if (!host || this.mapPopupActionsWired) {
      return;
    }
    this.mapPopupActionsWired = true;
    host.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const btn = target?.closest('.electricite-popup-unavail-btn') as HTMLElement | null;
      if (!btn) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const tranche = btn.dataset['tranche'] || '';
      this.ngZone.run(() => {
        this.openUnavailModal(tranche);
        this.map?.closePopup();
      });
    });
  }
}
