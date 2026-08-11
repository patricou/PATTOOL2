import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import {
  AngleBetween,
  Body,
  Equator,
  Horizon,
  Illumination,
  KM_PER_AU,
  Libration,
  MoonPhase,
  Observer,
  RAD2DEG
} from 'astronomy-engine';

import {
  ApiService,
  EclipseVisibilityEvent,
  EclipseVisibilityResponse,
  OpaleEclipseDayResponse,
  OpaleEclipseSummary,
  OpaleEclipseYearResponse,
  UsnoSolarLocalResponse,
  UsnoSolarYearResponse
} from '../services/api.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';

type PlayerMode = 'solar' | 'lunar';

interface SkySnapshot {
  date: Date;
  sunAlt: number;
  sunAz: number;
  moonAlt: number;
  moonAz: number;
  separationDeg: number;
  sunRadiusDeg: number;
  moonRadiusDeg: number;
  moonPhaseDeg: number;
  obscurationApprox: number;
  magnitudeApprox: number;
  sunUp: boolean;
  moonUp: boolean;
}

@Component({
  selector: 'app-eclipse',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './eclipse.component.html',
  styleUrls: ['./eclipse.component.css']
})
export class EclipseComponent implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;
  @ViewChild('eclipseCanvas') canvasRef?: ElementRef<HTMLCanvasElement>;

  year = new Date().getFullYear();
  lat = 48.8566;
  lon = 2.3522;
  height = 0;
  placeLabel = '';
  loadingAddress = false;

  usnoYear: UsnoSolarYearResponse | null = null;
  usnoLocal: UsnoSolarLocalResponse | null = null;
  selectedUsnoDate = '';

  opaleSolar: OpaleEclipseYearResponse | null = null;
  opaleLunar: OpaleEclipseYearResponse | null = null;
  opaleDay: OpaleEclipseDayResponse | null = null;
  selectedOpaleBody: 10 | 301 = 10;
  selectedOpaleDate = '';

  visibility: EclipseVisibilityResponse | null = null;
  loadingVisibility = false;

  loadingUsno = false;
  loadingOpale = false;
  loadingDetail = false;
  errorMessage = '';

  showRawUsnoYear = false;
  showRawUsnoLocal = false;
  showRawOpaleSolar = false;
  showRawOpaleLunar = false;
  showRawOpaleDay = false;
  showRawVisibility = false;

  // Player
  playerMode: PlayerMode = 'solar';
  simDateLocal = '';
  playing = false;
  playSpeedMinPerSec = 5;
  snapshot: SkySnapshot | null = null;
  private playTimer: ReturnType<typeof setInterval> | null = null;

  private subscriptions = new Subscription();
  private readonly coordsChange$ = new Subject<{ lat: number; lon: number }>();
  private addressSub: Subscription | null = null;

  constructor(
    private readonly api: ApiService,
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone: NgZone
  ) {}

  ngOnInit(): void {
    this.setSimDate(new Date());
    this.subscriptions.add(
      this.coordsChange$.pipe(
        debounceTime(400),
        distinctUntilChanged((a, b) =>
          Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5)
      ).subscribe(({ lat, lon }) => this.resolveAddress(lat, lon))
    );
    // Resolve immediately (same API as address-geocode); do not wait for IP lookup.
    this.resolveAddress(this.lat, this.lon);
    this.reloadAll();
    this.checkVisibility();
    this.refreshSky();
    this.subscriptions.add(
      this.api.getLocationByIp().subscribe({
        next: loc => {
          if (loc.status === 'success' && loc.lat != null && loc.lon != null) {
            const moved =
              Math.abs(this.lat - loc.lat) > 1e-4 || Math.abs(this.lon - loc.lon) > 1e-4;
            this.lat = loc.lat;
            this.lon = loc.lon;
            if (moved) {
              this.resolveAddress(this.lat, this.lon);
              this.checkVisibility();
              this.refreshSky();
            }
          }
        }
      })
    );
  }

  ngAfterViewInit(): void {
    this.drawPlayer();
  }

  ngOnDestroy(): void {
    this.stopPlay();
    this.addressSub?.unsubscribe();
    this.subscriptions.unsubscribe();
  }

  reloadAll(): void {
    if (!this.isValidYear(this.year)) {
      this.errorMessage = 'ECLIPSE.ERROR_YEAR';
      return;
    }
    this.errorMessage = '';
    this.usnoLocal = null;
    this.opaleDay = null;
    this.selectedUsnoDate = '';
    this.selectedOpaleDate = '';
    this.loadUsnoYear();
    this.loadOpaleYear();
  }

  useMyLocation(): void {
    this.errorMessage = '';
    if (!navigator.geolocation) {
      this.useIpLocationFallback();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.ngZone.run(() => {
          this.lat = position.coords.latitude;
          this.lon = position.coords.longitude;
          if (position.coords.altitude != null && Number.isFinite(position.coords.altitude)) {
            this.height = Math.round(position.coords.altitude);
          }
          this.resolveAddress(this.lat, this.lon);
          this.checkVisibility();
          this.refreshSky();
          this.cdr.detectChanges();
        });
      },
      () => {
        this.ngZone.run(() => this.useIpLocationFallback());
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  /** Fallback when browser GPS is unavailable (same IP endpoint as before). */
  private useIpLocationFallback(): void {
    this.subscriptions.add(
      this.api.getLocationByIp().subscribe({
        next: loc => {
          if (loc.status === 'success' && loc.lat != null && loc.lon != null) {
            this.lat = loc.lat;
            this.lon = loc.lon;
            this.resolveAddress(this.lat, this.lon);
            this.checkVisibility();
            this.refreshSky();
            this.cdr.detectChanges();
          } else {
            this.errorMessage = 'ECLIPSE.ERROR_GEO';
            this.cdr.detectChanges();
          }
        },
        error: () => {
          this.errorMessage = 'ECLIPSE.ERROR_GEO';
          this.cdr.detectChanges();
        }
      })
    );
  }

  openTraceViewerForSelection(): void {
    if (!this.traceViewerModalComponent || !this.isValidCoords()) {
      this.errorMessage = 'ECLIPSE.ERROR_COORDS';
      return;
    }
    const label = `${this.lat.toFixed(5)}, ${this.lon.toFixed(5)}`;
    this.traceViewerModalComponent.openAtLocation(this.lat, this.lon, label, undefined, true, true);
  }

  onLocationSelected(location: { lat: number; lng: number; alt?: number | null }): void {
    this.lat = location.lat;
    this.lon = location.lng;
    if (location.alt != null && Number.isFinite(location.alt)) {
      this.height = Math.round(location.alt);
    }
    this.resolveAddress(this.lat, this.lon);
    this.checkVisibility();
    this.refreshSky();
    if (this.selectedUsnoDate) {
      this.loadUsnoLocal(this.selectedUsnoDate);
    }
    if (this.selectedOpaleDate) {
      this.loadOpaleDay(this.selectedOpaleBody, this.selectedOpaleDate);
    }
  }

  checkVisibility(): void {
    if (!this.isValidCoords()) {
      this.errorMessage = 'ECLIPSE.ERROR_COORDS';
      return;
    }
    this.loadingVisibility = true;
    this.errorMessage = '';
    this.subscriptions.add(
      this.api.getEclipseVisibility(this.lat, this.lon, this.height, 5).subscribe({
        next: data => {
          this.visibility = data;
          this.loadingVisibility = false;
          const jump = data.current ?? data.next;
          if (jump?.maximum || jump?.begins || jump?.date) {
            this.jumpPlayerToEvent(jump);
          }
        },
        error: () => {
          this.visibility = null;
          this.loadingVisibility = false;
          this.errorMessage = 'ECLIPSE.ERROR_VISIBILITY';
        }
      })
    );
  }

  selectUsnoEclipse(day: number, month: number, year: number): void {
    this.selectedUsnoDate = this.formatDate(year, month, day);
    this.loadUsnoLocal(this.selectedUsnoDate);
    this.setSimDate(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
    this.playerMode = 'solar';
    this.refreshSky();
  }

  usnoItemDate(e: { day: number; month: number; year: number }): string {
    return this.formatDate(e.year, e.month, e.day);
  }

  selectOpaleEclipse(body: 10 | 301, calendarDate: string): void {
    this.selectedOpaleBody = body;
    this.selectedOpaleDate = calendarDate;
    this.loadOpaleDay(body, calendarDate);
    this.playerMode = body === 301 ? 'lunar' : 'solar';
    const parts = calendarDate.split('-').map(Number);
    if (parts.length === 3) {
      this.setSimDate(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0)));
      this.refreshSky();
    }
  }

  usnoLocalData(): Array<Record<string, unknown>> {
    const props = this.usnoLocal?.properties as { local_data?: Array<Record<string, unknown>> } | undefined;
    return props?.local_data ?? [];
  }

  usnoPropertyEntries(): Array<{ key: string; value: unknown }> {
    const props = this.usnoLocal?.properties;
    if (!props || typeof props !== 'object') {
      return [];
    }
    return Object.keys(props)
      .filter(k => k !== 'local_data')
      .map(key => ({ key, value: (props as Record<string, unknown>)[key] }));
  }

  usnoProperty(key: string): unknown {
    const props = this.usnoLocal?.properties as Record<string, unknown> | undefined;
    return props?.[key];
  }

  objectEntries(obj: unknown): Array<{ key: string; value: unknown }> {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return [];
    }
    return Object.keys(obj as Record<string, unknown>).map(key => ({
      key,
      value: (obj as Record<string, unknown>)[key]
    }));
  }

  formatValue(value: unknown): string {
    if (value == null) {
      return '—';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  opaleEventEntries(eclipse: OpaleEclipseSummary | Record<string, unknown> | null | undefined): Array<{ key: string; value: unknown; date?: string }> {
    if (!eclipse || typeof eclipse !== 'object') {
      return [];
    }
    const events = (eclipse as { events?: Record<string, unknown> }).events;
    if (!events) {
      return [];
    }
    return Object.keys(events).map(key => {
      const value = events[key];
      let date: string | undefined;
      if (value && typeof value === 'object' && 'date' in (value as object)) {
        const d = (value as { date?: unknown }).date;
        date = d == null ? undefined : String(d);
      }
      return { key, value, date };
    });
  }

  visibilityTypeKey(type: string | undefined): string {
    switch (type) {
      case 'total': return 'ECLIPSE.TYPE_TOTAL';
      case 'annular': return 'ECLIPSE.TYPE_ANNULAR';
      case 'partial': return 'ECLIPSE.TYPE_PARTIAL';
      default: return 'ECLIPSE.TYPE_PARTIAL';
    }
  }

  formatCountdown(event: EclipseVisibilityEvent | null | undefined): string {
    if (!event || event.inProgress) {
      return '';
    }
    const ms = event.millisecondsUntil ?? 0;
    if (ms <= 0) {
      return '';
    }
    const totalHours = Math.floor(ms / 3_600_000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}min`;
    }
    return `${Math.max(1, minutes)}min`;
  }

  obscurationLabel(event: EclipseVisibilityEvent | null | undefined): string {
    if (!event) {
      return '';
    }
    if (event.obscurationPercent != null && Number.isFinite(event.obscurationPercent)) {
      return `${event.obscurationPercent.toFixed(1)} %`;
    }
    return event.obscuration || '';
  }

  onSimDateChange(): void {
    this.refreshSky();
  }

  onCoordsChange(): void {
    this.refreshSky();
    if (this.isValidCoords()) {
      this.coordsChange$.next({ lat: this.lat, lon: this.lon });
    } else {
      this.placeLabel = '';
    }
  }

  onHeightChange(): void {
    this.refreshSky();
  }

  private resolveAddress(lat: number, lon: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      this.placeLabel = '';
      this.loadingAddress = false;
      return;
    }
    this.loadingAddress = true;
    this.addressSub?.unsubscribe();
    this.addressSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (data: any) => {
        // Same label path as address-geocode: prefer backend displayName.
        this.placeLabel = this.formatAddress(data);
        this.loadingAddress = false;
        if ((this.height === 0 || this.height == null) && data?.extratags?.ele) {
          const elev = parseFloat(data.extratags.ele);
          if (Number.isFinite(elev)) {
            this.height = Math.round(elev);
          }
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.placeLabel = '';
        this.loadingAddress = false;
        this.cdr.detectChanges();
      }
    });
  }

  /** Prefer displayName (address-geocode), then structured Nominatim/Photon fields. */
  private formatAddress(data: any): string {
    if (!data) {
      return '';
    }
    const display = String(data.displayName ?? data.display_name ?? '').trim();
    if (display) {
      return display;
    }
    if (data.address && typeof data.address === 'object') {
      const address = data.address;
      const parts: string[] = [];
      const road = address.road || address.street || '';
      const house = address.house_number || address.housenumber || '';
      if (house && road) {
        parts.push(`${road} ${house}`);
      } else if (road) {
        parts.push(road);
      } else if (address.name) {
        parts.push(String(address.name));
      }
      if (address.postcode) {
        parts.push(String(address.postcode));
      }
      const city = address.city || address.town || address.village
        || address.municipality || address.county || '';
      if (city) {
        parts.push(String(city));
      }
      if (address.state || address.region || address.admin1) {
        parts.push(String(address.state || address.region || address.admin1));
      }
      if (address.country) {
        parts.push(String(address.country));
      }
      if (parts.length > 0) {
        return parts.join(', ');
      }
    }
    return '';
  }

  setPlayerMode(mode: PlayerMode): void {
    this.playerMode = mode;
    this.drawPlayer();
  }

  jumpToNow(): void {
    this.setSimDate(new Date());
    this.refreshSky();
  }

  hasNextEclipseTarget(): boolean {
    return this.getNextEclipseTarget() != null;
  }

  jumpToNextEclipse(): void {
    const target = this.getNextEclipseTarget();
    if (!target) {
      if (!this.visibility && this.isValidCoords()) {
        this.checkVisibility();
      }
      return;
    }
    this.jumpPlayerToEvent(target);
  }

  private getNextEclipseTarget(): EclipseVisibilityEvent | null {
    if (this.playerMode === 'lunar') {
      return this.visibility?.nextLunar
        ?? this.visibility?.current
        ?? this.visibility?.next
        ?? null;
    }
    return this.visibility?.current
      ?? this.visibility?.next
      ?? this.visibility?.nextLunar
      ?? null;
  }

  jumpPlayerToEvent(event: EclipseVisibilityEvent): void {
    const iso = event.maximum || event.begins || (event.date ? `${event.date}T12:00:00Z` : null);
    if (!iso) {
      return;
    }
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      this.setSimDate(d);
      this.playerMode = event.kind === 'lunar' ? 'lunar' : 'solar';
      this.refreshSky();
    }
  }

  togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.startPlay();
    }
  }

  stepMinutes(delta: number): void {
    const d = this.getSimDate() ?? new Date();
    d.setMinutes(d.getMinutes() + delta);
    this.setSimDate(d);
    this.refreshSky();
  }

  refreshSky(): void {
    if (!this.isValidCoords()) {
      this.snapshot = null;
      this.drawPlayer();
      return;
    }
    try {
      this.snapshot = this.computeSky(this.getSimDate() ?? new Date());
    } catch {
      this.snapshot = null;
    }
    this.drawPlayer();
  }

  private startPlay(): void {
    this.playing = true;
    this.playTimer = setInterval(() => {
      const d = this.getSimDate() ?? new Date();
      d.setMinutes(d.getMinutes() + this.playSpeedMinPerSec);
      this.setSimDate(d);
      this.refreshSky();
    }, 1000);
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private computeSky(date: Date): SkySnapshot {
    const observer = new Observer(this.lat, this.lon, this.height);
    const sunEq = Equator(Body.Sun, date, observer, true, true);
    const moonEq = Equator(Body.Moon, date, observer, true, true);
    const sunHor = Horizon(date, observer, sunEq.ra, sunEq.dec, 'normal');
    const moonHor = Horizon(date, observer, moonEq.ra, moonEq.dec, 'normal');
    const separationDeg = AngleBetween(sunEq.vec, moonEq.vec);
    const moonRadiusDeg = Libration(date).diam_deg / 2;
    const sunDistKm = Math.max(1, sunEq.dist * KM_PER_AU);
    const sunRadiusDeg = Math.atan(695700 / sunDistKm) * RAD2DEG;
    const moonPhaseDeg = MoonPhase(date);

    // Approximate solar eclipse magnitude / obscuration from disk geometry.
    const sumR = sunRadiusDeg + moonRadiusDeg;
    const diffR = Math.abs(moonRadiusDeg - sunRadiusDeg);
    let magnitudeApprox = 0;
    let obscurationApprox = 0;
    if (separationDeg < sumR) {
      magnitudeApprox = (sunRadiusDeg + moonRadiusDeg - separationDeg) / (2 * sunRadiusDeg);
      magnitudeApprox = Math.max(0, Math.min(magnitudeApprox, moonRadiusDeg / sunRadiusDeg));
      // Circular segment obscuration approximation (area fraction).
      obscurationApprox = this.diskOverlapFraction(sunRadiusDeg, moonRadiusDeg, separationDeg) * 100;
    }

    // For lunar view: distance of Moon from opposition (Earth shadow center ~ anti-sun).
    if (this.playerMode === 'lunar') {
      const elong = Illumination(Body.Moon, date).phase_angle; // 0=full? phase_angle 0 = full illumination
      // phase_angle 0 = full moon; use elongation from sun via moon phase
      void elong;
    }

    return {
      date,
      sunAlt: sunHor.altitude,
      sunAz: sunHor.azimuth,
      moonAlt: moonHor.altitude,
      moonAz: moonHor.azimuth,
      separationDeg,
      sunRadiusDeg,
      moonRadiusDeg,
      moonPhaseDeg,
      obscurationApprox,
      magnitudeApprox,
      sunUp: sunHor.altitude > -0.833,
      moonUp: moonHor.altitude > -0.5
    };
  }

  /** Area of intersection of two disks / area of first disk, as fraction 0..1. */
  private diskOverlapFraction(r1: number, r2: number, d: number): number {
    if (d >= r1 + r2) {
      return 0;
    }
    if (d <= Math.abs(r2 - r1)) {
      return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1);
    }
    const r1sq = r1 * r1;
    const r2sq = r2 * r2;
    const a = Math.acos((d * d + r1sq - r2sq) / (2 * d * r1));
    const b = Math.acos((d * d + r2sq - r1sq) / (2 * d * r2));
    const area = r1sq * a + r2sq * b - 0.5 * (
      (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)
    ) ** 0.5;
    return Math.max(0, Math.min(1, area / (Math.PI * r1sq)));
  }

  private drawPlayer(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Match bitmap to CSS box (same aspect) so X/Y scale equally → discs stay circular.
    const cssW = Math.max(1, Math.round(canvas.clientWidth || 960));
    const cssH = Math.max(1, Math.round(canvas.clientHeight || 600));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixW = Math.round(cssW * dpr);
    const pixH = Math.round(cssH * dpr);
    if (canvas.width !== pixW || canvas.height !== pixH) {
      canvas.width = pixW;
      canvas.height = pixH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;
    const cx = w / 2;
    const cy = h / 2;
    const discBase = Math.min(w, h);

    ctx.clearRect(0, 0, w, h);
    // Sky background
    const sky = ctx.createRadialGradient(cx, cy, 10, cx, cy, discBase * 0.6);
    if (this.playerMode === 'solar') {
      sky.addColorStop(0, '#1a2744');
      sky.addColorStop(1, '#070b14');
    } else {
      sky.addColorStop(0, '#12182a');
      sky.addColorStop(1, '#05060c');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const snap = this.snapshot;
    if (!snap) {
      ctx.fillStyle = '#adb5bd';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('—', cx, cy);
      return;
    }

    if (this.playerMode === 'solar') {
      this.drawSolarEclipse(ctx, cx, cy, discBase * 0.28, snap, w, h);
    } else {
      this.drawLunarEclipse(ctx, cx, cy, discBase * 0.32, snap, w, h);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(snap.date.toISOString().replace('.000Z', 'Z'), 12, 20);
    ctx.textAlign = 'right';
    ctx.fillText(`${this.lat.toFixed(3)}°, ${this.lon.toFixed(3)}°`, w - 12, 20);
  }

  private drawSolarEclipse(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    sunPx: number,
    snap: SkySnapshot,
    w: number,
    h: number
  ): void {
    const scale = sunPx / Math.max(snap.sunRadiusDeg, 1e-6);
    const moonPx = snap.moonRadiusDeg * scale;
    // Offset moon relative to sun using alt/az differences projected locally.
    const dAzRad = ((snap.moonAz - snap.sunAz) * Math.PI) / 180;
    const meanAltRad = ((snap.sunAlt + snap.moonAlt) * 0.5 * Math.PI) / 180;
    const eastDeg = (dAzRad * Math.cos(meanAltRad)) * (180 / Math.PI);
    const northDeg = snap.moonAlt - snap.sunAlt;
    const dx = eastDeg * scale;
    const dy = -northDeg * scale; // screen y down

    // Corona / glow
    const glow = ctx.createRadialGradient(cx, cy, sunPx * 0.2, cx, cy, sunPx * 1.8);
    glow.addColorStop(0, 'rgba(255, 220, 120, 0.55)');
    glow.addColorStop(1, 'rgba(255, 180, 40, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, sunPx * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Sun disk
    const sunGrad = ctx.createRadialGradient(cx - sunPx * 0.2, cy - sunPx * 0.2, sunPx * 0.1, cx, cy, sunPx);
    sunGrad.addColorStop(0, '#fff6c8');
    sunGrad.addColorStop(0.55, '#ffcc33');
    sunGrad.addColorStop(1, '#e08900');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, sunPx, 0, Math.PI * 2);
    ctx.fill();

    // Moon disk (occulting)
    const mx = cx + dx;
    const my = cy + dy;
    ctx.fillStyle = '#0d1118';
    ctx.beginPath();
    ctx.arc(mx, my, moonPx, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,170,190,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!snap.sunUp) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffc107';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('☀ below horizon', cx, cy + sunPx + 28);
    }
  }

  private drawLunarEclipse(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    moonPx: number,
    snap: SkySnapshot,
    w: number,
    h: number
  ): void {
    // Earth's umbra angular radius at Moon ≈ ~0.75° (varies); penumbra ~1.3°.
    const umbraRdeg = 0.75;
    const penumbraRdeg = 1.25;
    const scale = moonPx / Math.max(snap.moonRadiusDeg, 1e-6);
    // Shadow center is opposite the Sun from Earth; Moon offset from opposition ≈ |180 - phase|
    const fromFull = ((snap.moonPhaseDeg + 180) % 360) - 180; // -180..180, 0 at full
    const shadowSepDeg = Math.abs(fromFull); // rough
    const dx = shadowSepDeg * scale; // horizontal only (schematic)

    // Penumbra
    ctx.fillStyle = 'rgba(120, 40, 40, 0.25)';
    ctx.beginPath();
    ctx.arc(cx, cy, penumbraRdeg * scale, 0, Math.PI * 2);
    ctx.fill();
    // Umbra
    ctx.fillStyle = 'rgba(90, 10, 10, 0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, umbraRdeg * scale, 0, Math.PI * 2);
    ctx.fill();

    // Moon
    const mx = cx + dx;
    const moonGrad = ctx.createRadialGradient(mx - moonPx * 0.25, cy - moonPx * 0.25, moonPx * 0.15, mx, cy, moonPx);
    moonGrad.addColorStop(0, '#f0e6d2');
    moonGrad.addColorStop(1, '#9a8f7a');
    ctx.fillStyle = moonGrad;
    ctx.beginPath();
    ctx.arc(mx, cy, moonPx, 0, Math.PI * 2);
    ctx.fill();

    // Darken moon by umbra overlap (clip)
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, cy, moonPx, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(80, 8, 8, 0.65)';
    ctx.beginPath();
    ctx.arc(cx, cy, umbraRdeg * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (!snap.moonUp) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#adb5bd';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('☾ below horizon', cx, cy + moonPx + 28);
    }
  }

  private setSimDate(date: Date): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    // datetime-local is local timezone
    this.simDateLocal = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private getSimDate(): Date | null {
    if (!this.simDateLocal) {
      return null;
    }
    const d = new Date(this.simDateLocal);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private loadUsnoYear(): void {
    this.loadingUsno = true;
    this.subscriptions.add(
      this.api.getUsnoSolarEclipseYear(this.year).subscribe({
        next: data => {
          this.usnoYear = data;
          this.loadingUsno = false;
        },
        error: () => {
          this.usnoYear = null;
          this.loadingUsno = false;
          this.errorMessage = 'ECLIPSE.ERROR_USNO';
        }
      })
    );
  }

  private loadOpaleYear(): void {
    this.loadingOpale = true;
    let pending = 2;
    const done = (): void => {
      pending -= 1;
      if (pending <= 0) {
        this.loadingOpale = false;
      }
    };

    this.subscriptions.add(
      this.api.getOpaleEclipseYear(10, this.year).subscribe({
        next: data => {
          this.opaleSolar = data;
          done();
        },
        error: () => {
          this.opaleSolar = null;
          this.errorMessage = 'ECLIPSE.ERROR_OPALE';
          done();
        }
      })
    );
    this.subscriptions.add(
      this.api.getOpaleEclipseYear(301, this.year).subscribe({
        next: data => {
          this.opaleLunar = data;
          done();
        },
        error: () => {
          this.opaleLunar = null;
          this.errorMessage = 'ECLIPSE.ERROR_OPALE';
          done();
        }
      })
    );
  }

  private loadUsnoLocal(date: string): void {
    if (!this.isValidCoords()) {
      this.errorMessage = 'ECLIPSE.ERROR_COORDS';
      return;
    }
    this.loadingDetail = true;
    this.errorMessage = '';
    this.subscriptions.add(
      this.api.getUsnoSolarEclipseLocal(date, this.lat, this.lon, this.height).subscribe({
        next: data => {
          this.usnoLocal = data;
          this.loadingDetail = false;
          const max = this.usnoLocalData().find(r => String(r['phenomenon']).toLowerCase().includes('maximum'));
          if (max?.['time'] && date) {
            const t = String(max['time']);
            const iso = `${date}T${t.length === 7 ? '0' + t : t}Z`;
            const parsed = new Date(iso.replace(/(\.\d)?$/, m => m || ''));
            // USNO time like 18:17:15.7
            const m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
            if (m) {
              const d = new Date(Date.UTC(
                Number(date.slice(0, 4)),
                Number(date.slice(5, 7)) - 1,
                Number(date.slice(8, 10)),
                Number(m[1]),
                Number(m[2]),
                Number(m[3])
              ));
              this.setSimDate(d);
              this.refreshSky();
            } else if (!Number.isNaN(parsed.getTime())) {
              this.setSimDate(parsed);
              this.refreshSky();
            }
          }
        },
        error: () => {
          this.usnoLocal = null;
          this.loadingDetail = false;
          this.errorMessage = 'ECLIPSE.ERROR_USNO_LOCAL';
        }
      })
    );
  }

  private loadOpaleDay(body: 10 | 301, date: string): void {
    this.loadingDetail = true;
    this.errorMessage = '';
    const lat = this.isValidCoords() ? this.lat : undefined;
    const lon = this.isValidCoords() ? this.lon : undefined;
    const height = this.isValidCoords() ? this.height : undefined;
    this.subscriptions.add(
      this.api.getOpaleEclipseDay(body, date, lat, lon, height).subscribe({
        next: data => {
          this.opaleDay = data;
          this.loadingDetail = false;
          const first = data.eclipses?.[0] as { events?: Record<string, { date?: string }> } | undefined;
          const greatest = first?.events?.['greatest']?.date || first?.events?.['U1']?.date || first?.events?.['P1']?.date;
          if (greatest) {
            const d = new Date(greatest.endsWith('Z') ? greatest : greatest + 'Z');
            if (!Number.isNaN(d.getTime())) {
              this.setSimDate(d);
              this.refreshSky();
            }
          }
        },
        error: () => {
          this.opaleDay = null;
          this.loadingDetail = false;
          this.errorMessage = 'ECLIPSE.ERROR_OPALE_DAY';
        }
      })
    );
  }

  private formatDate(year: number, month: number, day: number): string {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  private isValidYear(year: number): boolean {
    return Number.isInteger(year) && year >= 1800 && year <= 2050;
  }

  private isValidCoords(): boolean {
    return Number.isFinite(this.lat) && Number.isFinite(this.lon)
      && this.lat >= -90 && this.lat <= 90
      && this.lon >= -180 && this.lon <= 180;
  }
}
