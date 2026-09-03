import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  inject
} from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Body, Equator, HelioVector, Horizon, Observer, RotateVector, Rotation_EQJ_ECL } from 'astronomy-engine';
import { CONSTELLATION_FIGURES } from '../astro-compass/astro-compass-constellation-figures';
import { ASTRO_GALAXIES } from '../astro-compass/astro-compass-catalog';
import { PositionService } from '../services/position.service';
import { normalizeWheelDeltaPixels, wheelScaleFactor } from '../shared/wheel-zoom.util';
import {
  CosmoScenario,
  CosmoState,
  stateAt,
  timelineFor
} from './univers-futur-cosmology';
import {
  FUTURE_STARS,
  figurePointAt,
  starPositionAt
} from './univers-futur-stars';

export type FutureView = 'sky' | 'planets' | 'galaxies' | 'cosmos';
export type TimeUnit = 'a' | 'ka' | 'Ma' | 'Ga';
type SkyPeriod = 'day' | 'night' | 'twilight';

interface Hit {
  x: number;
  y: number;
  r: number;
  label: string;
}

interface PlanetDef {
  body: Body;
  labelKey: string;
  color: string;
  au: number;
  periodYr: number;
  inner: boolean;
}

interface GalaxyDef {
  id: string;
  name: string;
  labelKey?: string;
  distMly: number;
  raHours: number;
  bound: 'mw' | 'local' | 'hubble';
  color: string;
}

interface CosmosParticle {
  x: number;
  y: number;
  bound: boolean;
  hue: number;
}

const UNIT_FACTOR: Record<TimeUnit, number> = { a: 1, ka: 1e3, Ma: 1e6, Ga: 1e9 };
const SKY_FIGURES = [
  'uma', 'umi', 'ori', 'cas', 'cyg', 'leo', 'sco', 'cru', 'gem', 'tau',
  'aql', 'lyr', 'boo', 'and', 'peg', 'cma', 'aur', 'cen', 'sgr', 'dra'
];
const ANDROMEDA_COLLIDE_YR = 4.5e9;
const SUN_REDGIANT_YR = 5.4e9;
const ENGINE_YEAR_LIMIT = 3500;

const PLANETS: readonly PlanetDef[] = [
  { body: Body.Mercury, labelKey: 'SOLAR_SYSTEM.BODY_MERCURY', color: '#b5b5b5', au: 0.387, periodYr: 0.241, inner: true },
  { body: Body.Venus, labelKey: 'SOLAR_SYSTEM.BODY_VENUS', color: '#e6c87c', au: 0.723, periodYr: 0.615, inner: true },
  { body: Body.Earth, labelKey: 'SOLAR_SYSTEM.BODY_EARTH', color: '#6b93d6', au: 1, periodYr: 1, inner: true },
  { body: Body.Mars, labelKey: 'SOLAR_SYSTEM.BODY_MARS', color: '#c1440e', au: 1.524, periodYr: 1.881, inner: true },
  { body: Body.Jupiter, labelKey: 'SOLAR_SYSTEM.BODY_JUPITER', color: '#d8ca9d', au: 5.203, periodYr: 11.86, inner: false },
  { body: Body.Saturn, labelKey: 'SOLAR_SYSTEM.BODY_SATURN', color: '#fad5a5', au: 9.537, periodYr: 29.46, inner: false },
  { body: Body.Uranus, labelKey: 'SOLAR_SYSTEM.BODY_URANUS', color: '#7de3f0', au: 19.19, periodYr: 84.01, inner: false },
  { body: Body.Neptune, labelKey: 'SOLAR_SYSTEM.BODY_NEPTUNE', color: '#5b5ddf', au: 30.07, periodYr: 164.8, inner: false }
];

@Component({
  selector: 'app-univers-futur',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './univers-futur.component.html',
  styleUrls: ['./univers-futur.component.css']
})
export class UniversFuturComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly position = inject(PositionService);

  @HostBinding('class.uf-sky--day') get hostSkyDay(): boolean {
    return this.skyPeriod === 'day';
  }
  @HostBinding('class.uf-sky--twilight') get hostSkyTwilight(): boolean {
    return this.skyPeriod === 'twilight';
  }
  @HostBinding('class.uf-sky--night') get hostSkyNight(): boolean {
    return this.skyPeriod === 'night';
  }

  skyPeriod: SkyPeriod = 'night';

  @ViewChild('skyCanvas') canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasWrap') wrapRef?: ElementRef<HTMLElement>;
  @ViewChild('fsRoot') fsRoot?: ElementRef<HTMLElement>;

  readonly views: ReadonlyArray<{ id: FutureView; icon: string; labelKey: string }> = [
    { id: 'sky', icon: 'fa-star', labelKey: 'UNIVERS_FUTUR.VIEW_SKY' },
    { id: 'planets', icon: 'fa-sun-o', labelKey: 'UNIVERS_FUTUR.VIEW_PLANETS' },
    { id: 'galaxies', icon: 'fa-circle-o', labelKey: 'UNIVERS_FUTUR.VIEW_GALAXIES' },
    { id: 'cosmos', icon: 'fa-expand', labelKey: 'UNIVERS_FUTUR.VIEW_COSMOS' }
  ];

  view: FutureView = 'cosmos';
  scenario: CosmoScenario = 'lcdm';
  yearsFromNow = 0;
  unit: TimeUnit = 'Ga';
  playing = false;
  fullscreen = false;
  hoverLabel = '';
  zoom = 1;
  panX = 0;
  panY = 0;

  private hits: Hit[] = [];
  private galaxies: GalaxyDef[] = [];
  private particles: CosmosParticle[] = [];
  private raf = 0;
  private lastTs = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private resizeObs?: ResizeObserver;
  private langSub?: Subscription;
  private locationSub?: Subscription;
  private observerLat: number | null = null;
  private observerLon: number | null = null;
  private skyTickTimer: ReturnType<typeof setInterval> | null = null;
  private documentSkyClass: string | null = null;

  ngOnInit(): void {
    const hour = new Date().getHours();
    this.skyPeriod = hour >= 6 && hour < 20 ? 'day' : 'night';
    this.updatePageSky();
    this.locationSub = this.position.getCurrentPosition().subscribe(pos => {
      if (!pos) {
        return;
      }
      this.observerLat = pos.latitude;
      this.observerLon = pos.longitude;
      this.updatePageSky();
      this.cdr.detectChanges();
    });
    this.skyTickTimer = setInterval(() => this.updatePageSky(), 60_000);
  }

  ngAfterViewInit(): void {
    this.galaxies = this.buildGalaxies();
    this.particles = this.buildParticles();
    this.langSub = this.translate.onLangChange.subscribe(() => this.draw());
    const wrap = this.wrapRef?.nativeElement;
    if (wrap && typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.draw());
      this.resizeObs.observe(wrap);
    }
    this.draw();
  }

  ngOnDestroy(): void {
    if (this.skyTickTimer) {
      clearInterval(this.skyTickTimer);
      this.skyTickTimer = null;
    }
    this.clearDocumentSky();
    this.locationSub?.unsubscribe();
    this.stopPlay();
    this.langSub?.unsubscribe();
    this.resizeObs?.disconnect();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.draw();
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  @HostListener('document:MSFullscreenChange')
  onFullscreenChange(): void {
    this.syncFullscreenFromDocument();
  }

  async toggleFullscreen(): Promise<void> {
    const shell = this.fsRoot?.nativeElement;
    if (!shell || typeof document === 'undefined') {
      return;
    }
    const fsEl = this.currentFullscreenElement();
    try {
      if (fsEl === shell) {
        const exit =
          document.exitFullscreen?.bind(document) ??
          (document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen?.bind(
            document
          ) ??
          (document as Document & { msExitFullscreen?: () => Promise<void> }).msExitFullscreen?.bind(document);
        await exit?.();
      } else {
        const req =
          shell.requestFullscreen?.bind(shell) ??
          (shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void })
            .webkitRequestFullscreen?.bind(shell) ??
          (shell as HTMLElement & { msRequestFullscreen?: () => Promise<void> | void }).msRequestFullscreen?.bind(
            shell
          );
        await req?.();
      }
    } catch {
      /* iframe / policy */
    }
    this.syncFullscreenFromDocument();
  }

  private currentFullscreenElement(): Element | null {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    return document.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
  }

  private syncFullscreenFromDocument(): void {
    const shell = this.fsRoot?.nativeElement;
    this.fullscreen = !!shell && this.currentFullscreenElement() === shell;
    this.cdr.detectChanges();
    queueMicrotask(() => this.draw());
  }

  private updatePageSky(): void {
    if (this.observerLat != null && this.observerLon != null
        && Number.isFinite(this.observerLat) && Number.isFinite(this.observerLon)) {
      this.skyPeriod = this.computeSkyPeriod(this.observerLat, this.observerLon);
    }
    this.syncDocumentSky();
  }

  /** Same sun-altitude thresholds as the Ciel / Eclipse pages (civil dawn / dusk). */
  private computeSkyPeriod(lat: number, lon: number): SkyPeriod {
    try {
      const observer = new Observer(lat, lon, 0);
      const at = new Date();
      const sunEq = Equator(Body.Sun, at, observer, true, true);
      const sunHor = Horizon(at, observer, sunEq.ra, sunEq.dec, 'normal');
      const sunAlt = sunHor.altitude;
      if (sunAlt > -0.833) {
        return 'day';
      }
      if (sunAlt > -6) {
        return 'twilight';
      }
    } catch {
      /* keep previous period */
    }
    return 'night';
  }

  private syncDocumentSky(): void {
    const next = `uf-sky-html--${this.skyPeriod}`;
    if (this.documentSkyClass === next) {
      return;
    }
    this.clearDocumentSky();
    try {
      document.documentElement.classList.add(next);
      document.body.classList.add(next);
      this.documentSkyClass = next;
    } catch {
      this.documentSkyClass = null;
    }
  }

  private clearDocumentSky(): void {
    if (!this.documentSkyClass) {
      return;
    }
    try {
      document.documentElement.classList.remove(this.documentSkyClass);
      document.body.classList.remove(this.documentSkyClass);
    } catch {
      /* ignore */
    }
    this.documentSkyClass = null;
  }

  get unitValue(): number {
    return this.yearsFromNow / UNIT_FACTOR[this.unit];
  }

  get logSlider(): number {
    if (this.yearsFromNow <= 1) {
      return 0;
    }
    return Math.max(0, Math.min(100, (100 * Math.log10(this.yearsFromNow)) / 11));
  }

  get cosmo(): CosmoState {
    return stateAt(this.scenario, this.yearsFromNow);
  }

  get formattedYears(): string {
    return this.formatYearsAbs(this.yearsFromNow);
  }

  get viewHintKey(): string {
    switch (this.view) {
      case 'sky':
        return 'UNIVERS_FUTUR.HINT_SKY';
      case 'planets':
        return 'UNIVERS_FUTUR.HINT_PLANETS';
      case 'galaxies':
        return 'UNIVERS_FUTUR.HINT_GALAXIES';
      default:
        return 'UNIVERS_FUTUR.HINT_COSMOS';
    }
  }

  get verdictTitleKey(): string {
    if (this.cosmo.recollapsed) {
      return 'UNIVERS_FUTUR.VERDICT_CRUNCH_NOW';
    }
    return this.scenario === 'lcdm' ? 'UNIVERS_FUTUR.VERDICT_LCDM_TITLE' : 'UNIVERS_FUTUR.VERDICT_CRUNCH_TITLE';
  }

  get verdictBodyKey(): string {
    if (this.cosmo.recollapsed) {
      return 'UNIVERS_FUTUR.VERDICT_CRUNCH_NOW_BODY';
    }
    return this.scenario === 'lcdm' ? 'UNIVERS_FUTUR.VERDICT_LCDM_BODY' : 'UNIVERS_FUTUR.VERDICT_CRUNCH_BODY';
  }

  formatYearsAbs(years: number): string {
    const y = Math.max(0, years);
    if (y >= 1e9) {
      return `${(y / 1e9).toPrecision(3)} Ga`;
    }
    if (y >= 1e6) {
      return `${(y / 1e6).toPrecision(3)} Ma`;
    }
    if (y >= 1e3) {
      return `${(y / 1e3).toPrecision(3)} ka`;
    }
    return `${Math.round(y)} a`;
  }

  onUnitValueChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return;
    }
    this.setYears(n * UNIT_FACTOR[this.unit]);
  }

  onUnitChange(unit: TimeUnit): void {
    this.unit = unit;
  }

  onLogSlider(v: number): void {
    const s = Number(v);
    this.setYears(s <= 0 ? 0 : 10 ** ((s / 100) * 11));
  }

  setYears(years: number): void {
    this.yearsFromNow = Math.max(0, Math.min(1e11, years));
    this.draw();
  }

  setScenario(s: CosmoScenario): void {
    this.scenario = s;
    this.draw();
  }

  setView(v: FutureView): void {
    this.view = v;
    this.resetView(false);
    this.draw();
  }

  resetView(redraw = true): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    if (redraw) {
      this.draw();
    }
  }

  togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.playing = true;
      this.lastTs = 0;
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const factor = wheelScaleFactor(normalizeWheelDeltaPixels(ev));
    this.zoom = Math.max(0.35, Math.min(12, this.zoom * factor));
    this.draw();
  }

  onPointerDown(ev: PointerEvent): void {
    this.dragging = true;
    this.dragX = ev.clientX;
    this.dragY = ev.clientY;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
  }

  onPointerMove(ev: PointerEvent): void {
    if (this.dragging) {
      this.panX += ev.clientX - this.dragX;
      this.panY += ev.clientY - this.dragY;
      this.dragX = ev.clientX;
      this.dragY = ev.clientY;
      this.draw();
      return;
    }
    const hit = this.hitAt(ev);
    this.hoverLabel = hit?.label ?? '';
  }

  onPointerUp(ev: PointerEvent): void {
    this.dragging = false;
    try {
      (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
    } catch {
      /* ignore */
    }
  }

  onCanvasClick(ev: MouseEvent): void {
    const hit = this.hitAt(ev);
    this.hoverLabel = hit?.label ?? '';
  }

  private hitAt(ev: { clientX: number; clientY: number }): Hit | undefined {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) {
      return undefined;
    }
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    let best: Hit | undefined;
    let bestD = Infinity;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r + 8 && d < bestD) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private tick(ts: number): void {
    if (!this.playing) {
      return;
    }
    const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts;
    const mag = Math.max(this.yearsFromNow, 80);
    this.yearsFromNow = Math.min(1e11, this.yearsFromNow + mag * 0.45 * dt);
    if (this.cosmo.recollapsed) {
      this.stopPlay();
    }
    this.draw();
    this.cdr.detectChanges();
    if (this.playing) {
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    const wrap = this.wrapRef?.nativeElement;
    if (!canvas || !wrap) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, wrap.clientWidth);
    const h = Math.max(200, wrap.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.hits = [];
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    this.paintStarsBg(ctx, w, h);
    switch (this.view) {
      case 'sky':
        this.drawSky(ctx, w, h);
        break;
      case 'planets':
        this.drawPlanets(ctx, w, h);
        break;
      case 'galaxies':
        this.drawGalaxies(ctx, w, h);
        break;
      default:
        this.drawCosmos(ctx, w, h);
        break;
    }
  }

  private paintStarsBg(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 90; i++) {
      const x = ((i * 97) % 1000) / 1000 * w;
      const y = ((i * 53) % 700) / 700 * h;
      ctx.fillStyle = '#cfe0ff';
      ctx.beginPath();
      ctx.arc(x, y, i % 7 === 0 ? 1.4 : 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private projectSky(raHours: number, decDeg: number, w: number, h: number): { x: number; y: number } {
    const x0 = (1 - raHours / 24) * w;
    const y0 = ((90 - decDeg) / 180) * h;
    return {
      x: (x0 - w / 2) * this.zoom + w / 2 + this.panX,
      y: (y0 - h / 2) * this.zoom + h / 2 + this.panY
    };
  }

  private drawSky(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const years = this.yearsFromNow;
    ctx.lineWidth = 1;
    for (const key of SKY_FIGURES) {
      const strokes = CONSTELLATION_FIGURES[key];
      if (!strokes) {
        continue;
      }
      ctx.strokeStyle = 'rgba(160, 190, 255, 0.22)';
      for (const stroke of strokes) {
        ctx.beginPath();
        stroke.forEach((pt, i) => {
          const p = this.projectSky(pt[0], pt[1], w, h);
          if (i === 0) {
            ctx.moveTo(p.x, p.y);
          } else {
            ctx.lineTo(p.x, p.y);
          }
        });
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(180, 230, 255, 0.85)';
      for (const stroke of strokes) {
        ctx.beginPath();
        stroke.forEach((pt, i) => {
          const moved = figurePointAt(pt[0], pt[1], years);
          const p = this.projectSky(moved.raHours, moved.decDeg, w, h);
          if (i === 0) {
            ctx.moveTo(p.x, p.y);
          } else {
            ctx.lineTo(p.x, p.y);
          }
        });
        ctx.stroke();
      }
    }

    for (const star of FUTURE_STARS) {
      const now = this.projectSky(star.raHours, star.decDeg, w, h);
      const fut = starPositionAt(star, years);
      const p = this.projectSky(fut.raHours, fut.decDeg, w, h);
      ctx.strokeStyle = 'rgba(255, 200, 120, 0.45)';
      ctx.beginPath();
      ctx.moveTo(now.x, now.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      const r = Math.max(1.6, 4.2 - star.mag * 0.55) * Math.min(this.zoom, 2.2);
      ctx.fillStyle = star.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (star.mag < 1.4 || this.zoom > 1.4) {
        ctx.fillStyle = 'rgba(235, 245, 255, 0.9)';
        ctx.font = '11px sans-serif';
        ctx.fillText(star.name, p.x + 5, p.y - 4);
      }
      this.hits.push({
        x: p.x,
        y: p.y,
        r: r + 4,
        label: `${star.name} · ${fut.distLy.toFixed(1)} al`
      });
    }
  }

  private drawPlanets(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w / 2 + this.panX;
    const cy = h / 2 + this.panY;
    const scale = (Math.min(w, h) * 0.42 * this.zoom) / 32;
    const sunR = this.yearsFromNow > SUN_REDGIANT_YR ? 18 : 8;
    ctx.fillStyle = this.yearsFromNow > SUN_REDGIANT_YR ? '#ff7a3a' : '#fdb813';
    ctx.beginPath();
    ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffe9b0';
    ctx.font = '12px sans-serif';
    ctx.fillText(this.translate.instant('UNIVERS_FUTUR.SUN'), cx + sunR + 4, cy - 4);

    const useEngine = this.yearsFromNow < ENGINE_YEAR_LIMIT;
    const date = new Date(Date.now() + this.yearsFromNow * 365.25 * 86400000);

    for (const p of PLANETS) {
      if (p.inner && this.yearsFromNow > SUN_REDGIANT_YR) {
        continue;
      }
      ctx.strokeStyle = 'rgba(180, 200, 230, 0.28)';
      ctx.beginPath();
      ctx.arc(cx, cy, p.au * scale, 0, Math.PI * 2);
      ctx.stroke();
      let xAu = p.au;
      let yAu = 0;
      if (useEngine) {
        try {
          const v = RotateVector(Rotation_EQJ_ECL(), HelioVector(p.body, date));
          xAu = v.x;
          yAu = v.y;
        } catch {
          const ang = (2 * Math.PI * this.yearsFromNow) / p.periodYr;
          xAu = p.au * Math.cos(ang);
          yAu = p.au * Math.sin(ang);
        }
      } else {
        const ang = (2 * Math.PI * this.yearsFromNow) / p.periodYr;
        xAu = p.au * Math.cos(ang);
        yAu = p.au * Math.sin(ang);
      }
      const x = cx + xAu * scale;
      const y = cy - yAu * scale;
      const label = this.translate.instant(p.labelKey);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, p.inner ? 4 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#eef4ff';
      ctx.font = '11px sans-serif';
      ctx.fillText(label, x + 7, y - 3);
      this.hits.push({
        x,
        y,
        r: 8,
        label: `${label} · ${Math.hypot(xAu, yAu).toFixed(2)} ua`
      });
    }
  }

  private drawGalaxies(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w / 2 + this.panX;
    const cy = h / 2 + this.panY;
    const a = this.cosmo.recollapsed ? 0 : this.cosmo.a;
    const rMax = Math.min(w, h) * 0.42 * this.zoom;

    const distOf = (g: GalaxyDef): number => {
      if (g.bound === 'mw') {
        return 0;
      }
      if (g.id === 'm31' || g.id === 'm33') {
        const f = Math.min(1, this.yearsFromNow / ANDROMEDA_COLLIDE_YR);
        return g.distMly * (1 - f);
      }
      if (g.bound === 'local') {
        return g.distMly;
      }
      return g.distMly * a;
    };

    for (const g of this.galaxies) {
      const d = distOf(g);
      const logd = Math.log10(1 + d);
      const r = this.cosmo.recollapsed ? 0 : (logd / Math.log10(1 + 1.05e6)) * rMax * 1.15;
      const ang = (g.raHours / 24) * Math.PI * 2;
      const x = cx + r * Math.cos(ang);
      const y = cy + r * Math.sin(ang);
      ctx.fillStyle = g.color;
      const size = g.bound === 'mw' ? 9 : g.bound === 'local' ? 5.5 : 3.4;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      const name = g.labelKey ? this.translate.instant(g.labelKey) : g.name;
      if (g.bound !== 'hubble' || this.zoom > 1.1) {
        ctx.fillStyle = 'rgba(235, 245, 255, 0.9)';
        ctx.font = '11px sans-serif';
        ctx.fillText(name, x + 7, y - 2);
      }
      const unit = d >= 1000 ? `${(d / 1000).toFixed(1)} M al` : `${d.toFixed(2)} M al`;
      this.hits.push({ x, y, r: size + 4, label: `${name} · ${unit}` });
    }
  }

  private drawCosmos(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const plotH = Math.min(150, h * 0.28);
    const mapH = h - plotH - 8;
    const cx = w / 2 + this.panX;
    const cy = mapH / 2 + this.panY;
    const a = this.cosmo.recollapsed ? 0.002 : this.cosmo.a;
    const radius = Math.min(w, mapH) * 0.36 * this.zoom;

    for (const p of this.particles) {
      const s = p.bound ? 1 : a;
      const x = cx + p.x * radius * s;
      const y = cy + p.y * radius * s;
      ctx.fillStyle = `hsla(${p.hue}, 70%, 72%, 0.9)`;
      ctx.beginPath();
      ctx.arc(x, y, p.bound ? 3.2 : 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(126, 200, 255, 0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#dceeff';
    ctx.font = '12px sans-serif';
    ctx.fillText(this.translate.instant('UNIVERS_FUTUR.HERE'), cx + 20, cy - 8);

    this.drawScalePlot(ctx, w, h, plotH);
  }

  private drawScalePlot(ctx: CanvasRenderingContext2D, w: number, h: number, plotH: number): void {
    const y0 = h - plotH;
    ctx.fillStyle = 'rgba(8, 12, 24, 0.92)';
    ctx.fillRect(0, y0, w, plotH);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(0.5, y0 + 0.5, w - 1, plotH - 1);

    const tl = timelineFor(this.scenario);
    const samples = tl.samples;
    if (samples.length < 2) {
      return;
    }
    const tMin = samples[0].tGyr;
    const tMax = samples[samples.length - 1].tGyr;
    const aMax = Math.max(tl.aMax, 1.2);
    const padL = 36;
    const padR = 12;
    const padT = 18;
    const padB = 18;
    const xOf = (t: number) => padL + ((t - tMin) / (tMax - tMin)) * (w - padL - padR);
    const yOf = (a: number) => y0 + padT + (1 - a / aMax) * (plotH - padT - padB);

    ctx.strokeStyle = '#7ec8ff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = xOf(s.tGyr);
      const y = yOf(s.a);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 220, 120, 0.7)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xOf(tl.ageNowGyr), y0 + padT);
    ctx.lineTo(xOf(tl.ageNowGyr), y0 + plotH - padB);
    ctx.stroke();
    ctx.setLineDash([]);

    const tNow = this.cosmo.ageGyr;
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.arc(xOf(tNow), yOf(this.cosmo.a), 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#c8d6ec';
    ctx.font = '11px sans-serif';
    ctx.fillText('a(t)', padL, y0 + 14);
    ctx.fillText('0', padL - 18, yOf(0) + 3);
    ctx.fillText('1', padL - 18, yOf(1) + 3);
    ctx.fillText(this.translate.instant('UNIVERS_FUTUR.NOW_BTN'), xOf(tl.ageNowGyr) + 4, y0 + 14);
  }

  private buildGalaxies(): GalaxyDef[] {
    const local: GalaxyDef[] = [
      { id: 'mw', name: 'Milky Way', labelKey: 'UNIVERS_FUTUR.MW', distMly: 0, raHours: 0, bound: 'mw', color: '#ffe08a' },
      { id: 'lmc', name: 'LMC', distMly: 0.163, raHours: 5.39, bound: 'local', color: '#ffe4b5' },
      { id: 'smc', name: 'SMC', distMly: 0.2, raHours: 0.88, bound: 'local', color: '#ffe9c0' },
      { id: 'm31', name: 'Andromeda', labelKey: 'UNIVERS_FUTUR.ANDROMEDA', distMly: 2.54, raHours: 0.71, bound: 'local', color: '#c9b6ff' },
      { id: 'm33', name: 'Triangulum', labelKey: 'UNIVERS_FUTUR.TRIANGULUM', distMly: 2.73, raHours: 1.56, bound: 'local', color: '#a8d4ff' }
    ];
    const extra = ASTRO_GALAXIES.filter(
      (g) => !['lmc', 'smc', 'm31', 'm33', 'm32', 'm110'].includes(g.id)
    ).slice(0, 28).map((g) => ({
      id: g.id,
      name: g.name.replace(/\s*\(.*\)/, ''),
      distMly: g.distLy / 1e6,
      raHours: g.raHours,
      bound: 'hubble' as const,
      color: g.color
    }));
    return [...local, ...extra];
  }

  private buildParticles(): CosmosParticle[] {
    const out: CosmosParticle[] = [];
    let s = 0xC0FFEE;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 18; i++) {
      const ang = rnd() * Math.PI * 2;
      const r = 0.04 + rnd() * 0.07;
      out.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r, bound: true, hue: 48 });
    }
    for (let i = 0; i < 140; i++) {
      const ang = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * 0.98;
      out.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r, bound: false, hue: 200 + rnd() * 80 });
    }
    return out;
  }
}
