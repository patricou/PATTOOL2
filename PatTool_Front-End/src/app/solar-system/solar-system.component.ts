import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  Body,
  HelioVector,
  Illumination,
  KM_PER_AU,
  MoonPhase,
  RotateVector,
  RotationAxis,
  Rotation_EQJ_ECL,
  Vector
} from 'astronomy-engine';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

interface PlanetStyle {
  readonly body: Body;
  readonly labelKey: string;
  readonly color: string;
  readonly markerMin: number;
  readonly markerMax: number;
}

interface PlaybackSpeedPreset {
  readonly daysPerSec: number;
  readonly labelKey: string;
}

interface RotationAxisPaint {
  /** Direction du pôle nord projetée dans le plan écliptique (unitaire). */
  readonly ux: number;
  readonly uy: number;
  /** True si l’axe est presque perpendiculaire au plan (projection quasi nulle). */
  readonly orthogonal: boolean;
}

export interface PlanetSnap {
  readonly body: Body;
  readonly labelKey: string;
  readonly color: string;
  readonly xAu: number;
  readonly yAu: number;
  /** Composante hors plan écliptique J2000 (UA), pour la vue 3D. */
  readonly zAu: number;
  readonly distAu: number;
  readonly px: number;
  readonly py: number;
  readonly markerR: number;
  readonly isReference: boolean;
  readonly phaseDeg?: number;
  readonly rotationAxis?: RotationAxisPaint;
}

@Component({
  selector: 'app-solar-system',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './solar-system.component.html',
  styleUrls: ['./solar-system.component.css']
})
export class SolarSystemComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly translate = inject(TranslateService);

  @ViewChild('orbitCanvas') orbitCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('threeCanvas') threeCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasWrap') canvasWrap?: ElementRef<HTMLElement>;
  @ViewChild('mapShell') mapShell?: ElementRef<HTMLElement>;

  readonly bodies: readonly PlanetStyle[] = [
    { body: Body.Sun, labelKey: 'SOLAR_SYSTEM.BODY_SUN', color: '#fdb813', markerMin: 14, markerMax: 18 },
    { body: Body.Mercury, labelKey: 'SOLAR_SYSTEM.BODY_MERCURY', color: '#b5b5b5', markerMin: 5, markerMax: 9 },
    { body: Body.Venus, labelKey: 'SOLAR_SYSTEM.BODY_VENUS', color: '#e6c87c', markerMin: 6, markerMax: 10 },
    { body: Body.Earth, labelKey: 'SOLAR_SYSTEM.BODY_EARTH', color: '#6b93d6', markerMin: 7, markerMax: 11 },
    { body: Body.Moon, labelKey: 'SOLAR_SYSTEM.BODY_MOON', color: '#dcdcdc', markerMin: 4, markerMax: 8 },
    { body: Body.Mars, labelKey: 'SOLAR_SYSTEM.BODY_MARS', color: '#c1440e', markerMin: 6, markerMax: 10 },
    { body: Body.Jupiter, labelKey: 'SOLAR_SYSTEM.BODY_JUPITER', color: '#d8ca9d', markerMin: 10, markerMax: 16 },
    { body: Body.Saturn, labelKey: 'SOLAR_SYSTEM.BODY_SATURN', color: '#fad5a5', markerMin: 9, markerMax: 14 },
    { body: Body.Uranus, labelKey: 'SOLAR_SYSTEM.BODY_URANUS', color: '#7de3f0', markerMin: 7, markerMax: 12 },
    { body: Body.Neptune, labelKey: 'SOLAR_SYSTEM.BODY_NEPTUNE', color: '#5b5ddf', markerMin: 7, markerMax: 12 },
    { body: Body.Pluto, labelKey: 'SOLAR_SYSTEM.BODY_PLUTO', color: '#c9c5bc', markerMin: 4, markerMax: 8 }
  ];

  referenceBody: Body = Body.Sun;
  logRadialScale = true;
  /** Affiche le pôle nord IAU (axe de rotation) projeté sur le plan écliptique. */
  showRotationAxes = true;
  /** Zoom applies after radial mapping (1 = fit automatic padding). */
  zoom = 1;
  /** Translation écran (px) pour parcourir la carte 2D. */
  chartViewPanX = 0;
  chartViewPanY = 0;
  /** Facteur de grossissement autour du centre du graphe (molette). */
  chartViewMagnify = 1;

  simDate = new Date();
  datetimeLocalValue = '';

  playing = false;
  /** Vitesses : jours simulés par seconde réelle (les entrées « h » utilisent 1/24, 1/8, …). */
  playbackSpeedDaysPerSec = 7;

  readonly playbackSpeedPresets: readonly PlaybackSpeedPreset[] = [
    { daysPerSec: 1 / 96, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_15M' },
    { daysPerSec: 1 / 48, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_30M' },
    { daysPerSec: 1 / 24, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_1H' },
    { daysPerSec: 1 / 12, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_2H' },
    { daysPerSec: 1 / 8, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_3H' },
    { daysPerSec: 1 / 4, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_6H' },
    { daysPerSec: 1 / 2, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_12H' },
    { daysPerSec: 1, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_1D' },
    { daysPerSec: 7, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_7D' },
    { daysPerSec: 30, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_30D' },
    { daysPerSec: 120, labelKey: 'SOLAR_SYSTEM.SPEED_SIM_120D' }
  ];
  trailDays = 90;
  /** Corps dont la traînée est tracée ; chaîne vide = désactivé. */
  trailBody: Body | '' = '';

  /** Fenêtre [start,end] pour la frise (ms UTC). */
  timelineStartMs = 0;
  timelineEndMs = 1;
  /** Largeur totale de la fenêtre en jours (ex. 730 = ±365 j autour du centre). */
  timelineSpanDays = 730;
  /** Position curseur 0–100 sur la frise. */
  timelineSliderPct = 50;

  chartFullscreen = false;

  /** Panneau latéral gauche (date, lecture, options…) visible ou réduit à une barre. */
  solarControlsPanelExpanded = true;

  /** Vue WebGL (Three.js) au lieu du canvas 2D. */
  viewMode3d = false;
  /** Étiquettes CSS2D des corps en vue 3D. */
  showThreeLabels = false;

  readonly timelineSpanOptions: number[] = [180, 365, 730, 1825];

  planets: PlanetSnap[] = [];
  moonIllum?: MoonIllumSummary;

  private readonly rotEqjEcl = Rotation_EQJ_ECL();
  private animId = 0;
  private lastFrameMs = 0;
  private resizeObs?: ResizeObserver;

  /** Rayon cible (unités scène) pour normaliser l’orbite du corps le plus éloigné — sert aussi au cadrage caméra. */
  private readonly threeTargetOrbitRadius = 228;

  /** Recyclage pour placement radial des étiquettes CSS2D. */
  private readonly threeLblU = new THREE.Vector3();
  private readonly threeLblV = new THREE.Vector3();
  private readonly threeLblW = new THREE.Vector3();

  private threeRenderer?: THREE.WebGLRenderer;
  private threeScene?: THREE.Scene;
  private threeCamera?: THREE.PerspectiveCamera;
  private threeControls?: OrbitControls;
  private readonly threeMeshes = new Map<Body, THREE.Mesh>();
  private readonly threeLabelObjects = new Map<Body, CSS2DObject>();
  private threeCss2dRenderer?: CSS2DRenderer;
  /** Max distance (UA) hors corps de référence — mise à l’échelle radiale 3D (lin / log). */
  private threeLayoutMaxAu = 1e-6;
  private threeTrailLine?: THREE.Line;
  private readonly threeRotationAxisSegs = new Map<Body, THREE.LineSegments>();
  private readonly threeRotationAxisRings = new Map<Body, THREE.LineLoop>();
  private readonly threeScratchAxisDir = new THREE.Vector3();
  private readonly threeRotRingSegs = 56;
  private threeRaf = 0;
  /** Tentatives init canvas WebGL si le ViewChild n’est pas encore prêt. */
  private threeBootstrapRetries = 0;

  /** Centre diagramme 2D (px CSS) pour zoom curseur. */
  private chartDiagCx = 0;
  private chartDiagCy = 0;
  private chartPanDragging = false;
  private chartPanLastSX = 0;
  private chartPanLastSY = 0;
  private chartPanRedrawRaf = 0;

  readonly KM_PER_AU = KM_PER_AU;

  private readonly onChartWheelEv = (e: WheelEvent) => this.handleChartWheel(e);
  private readonly onChartPointerDownEv = (e: PointerEvent) => this.handleChartPointerDown(e);
  private readonly onChartPointerMoveEv = (e: PointerEvent) => this.handleChartPointerMove(e);
  private readonly onChartPointerUpEv = (e: PointerEvent) => this.handleChartPointerUp(e);

  ngOnInit(): void {
    this.translate.onLangChange.subscribe(() => queueMicrotask(() => this.redraw()));
  }

  ngAfterViewInit(): void {
    this.initTimelineAround(this.simDate.getTime());
    this.syncTimelineSliderFromSim();
    this.syncDatetimeInputFromSim();
    this.setupResizeObserver();
    queueMicrotask(() => this.redraw());
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
    cancelAnimationFrame(this.chartPanRedrawRaf);
    this.chartPanRedrawRaf = 0;
    this.detachOrbitCanvasInteractions();
    this.disposeThree();
    this.resizeObs?.disconnect();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.viewMode3d) {
      this.resizeThreeToHost();
      this.presentThreeIfReady();
    } else {
      this.redraw();
    }
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  @HostListener('document:MSFullscreenChange')
  onFullscreenChangeDoc(): void {
    this.syncChartFullscreenFromDocument();
  }

  /** Plein écran : même état que `document.fullscreenElement` (prefixes inclus). */
  private syncChartFullscreenFromDocument(): void {
    const shell = this.mapShell?.nativeElement;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    const fsEl =
      document.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
    this.chartFullscreen = !!shell && fsEl === shell;
    queueMicrotask(() => {
      if (this.viewMode3d) {
        this.resizeThreeToHost();
        this.presentThreeIfReady();
      } else {
        this.redraw();
      }
    });
  }

  setNow(): void {
    this.simDate = new Date();
    this.syncDatetimeInputFromSim();
    this.syncTimelineSliderFromSim();
    this.redraw();
  }

  stepDays(delta: number): void {
    const d = new Date(this.simDate.getTime());
    d.setDate(d.getDate() + delta);
    this.simDate = d;
    this.syncDatetimeInputFromSim();
    this.syncTimelineSliderFromSim();
    this.redraw();
  }

  onDatetimeLocalChange(raw: string): void {
    if (!raw) {
      return;
    }
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      this.simDate = parsed;
      this.datetimeLocalValue = raw;
      this.syncTimelineSliderFromSim();
      this.redraw();
    }
  }

  onTimelineSliderChange(pct: number): void {
    this.timelineSliderPct = pct;
    const lo = this.timelineStartMs;
    const hi = this.timelineEndMs;
    const span = hi - lo;
    if (span <= 0) {
      return;
    }
    const t = lo + (pct / 100) * span;
    this.simDate = new Date(t);
    this.syncDatetimeInputFromSim();
    this.redraw();
  }

  onTimelineSpanChange(days: number): void {
    this.timelineSpanDays = days;
    this.initTimelineAround(this.simDate.getTime());
    this.syncTimelineSliderFromSim();
    this.redrawPublic();
  }

  spanLabelKey(days: number): string {
    switch (days) {
      case 180:
        return 'SOLAR_SYSTEM.SPAN_180D';
      case 365:
        return 'SOLAR_SYSTEM.SPAN_365D';
      case 730:
        return 'SOLAR_SYSTEM.SPAN_730D';
      case 1825:
        return 'SOLAR_SYSTEM.SPAN_1825D';
      default:
        return 'SOLAR_SYSTEM.SPAN_730D';
    }
  }

  formatTimelineEdge(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  toggleView3d(): void {
    if (this.viewMode3d) {
      this.disposeThree();
      this.threeBootstrapRetries = 0;
      this.viewMode3d = false;
      if (this.playing) {
        this.lastFrameMs = performance.now();
        cancelAnimationFrame(this.animId);
        this.animId = requestAnimationFrame((t) => this.animLoop(t));
      }
      requestAnimationFrame(() => this.redraw());
      return;
    }
    if (this.playing) {
      cancelAnimationFrame(this.animId);
      this.animId = 0;
    }
    this.detachOrbitCanvasInteractions();
    this.viewMode3d = true;
    /* Attendre le cycle Angular + layout pour que #threeCanvas existe et ait une taille. */
    setTimeout(() => {
      this.redraw();
      this.ensureThreeReady();
    }, 0);
  }

  async toggleChartFullscreen(): Promise<void> {
    const shell = this.mapShell?.nativeElement;
    if (!shell || typeof document === 'undefined') {
      return;
    }
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
    try {
      if (fsEl === shell) {
        const exit =
          document.exitFullscreen?.bind(document) ??
          (document as unknown as Document & { webkitExitFullscreen?: () => Promise<void> })
            .webkitExitFullscreen?.bind(document) ??
          (document as unknown as Document & { msExitFullscreen?: () => Promise<void> })
            .msExitFullscreen?.bind(document);
        await exit?.();
      } else {
        const req =
          shell.requestFullscreen?.bind(shell) ??
          (shell as unknown as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void })
            .webkitRequestFullscreen?.bind(shell) ??
          (shell as unknown as HTMLElement & { msRequestFullscreen?: () => Promise<void> | void })
            .msRequestFullscreen?.bind(shell);
        await req?.();
      }
    } catch {
      /* navigateurs / iframe */
    }
    this.syncChartFullscreenFromDocument();
  }

  togglePlay(): void {
    this.playing = !this.playing;
    if (this.playing) {
      this.lastFrameMs = performance.now();
      if (!this.viewMode3d) {
        this.animId = requestAnimationFrame((t) => this.animLoop(t));
      }
    } else {
      cancelAnimationFrame(this.animId);
      this.animId = 0;
    }
  }

  resetZoom(): void {
    this.zoom = 1;
    this.chartViewPanX = 0;
    this.chartViewPanY = 0;
    this.chartViewMagnify = 1;
    this.redraw();
  }

  /** Appelé depuis le template ( liaisons, contrôles ). */
  redrawPublic(): void {
    this.redraw();
  }

  /** Comparaison stable pour le `<select>` du corps de référence (`Body` = nombre). */
  compareBodies(a: Body, b: Body): boolean {
    return a === b;
  }

  /**
   * Changement de corps de référence : tout recalcule dans le même référentiel écliptique centré sur ce corps.
   * En 3D, recentre la cible d’orbit et recadre la caméra pour que la mise à jour soit visible tout de suite.
   */
  onReferenceBodyChange(): void {
    this.redraw();
    if (this.viewMode3d && this.threeCamera && this.threeControls && this.threeRenderer && this.threeScene) {
      this.threeControls.target.set(0, 0, 0);
      this.fitThreeCameraInitial(this.threeCamera, this.threeControls);
      this.presentThreeIfReady();
    }
  }

  toggleSolarControlsPanel(): void {
    this.solarControlsPanelExpanded = !this.solarControlsPanelExpanded;
    queueMicrotask(() => {
      if (this.viewMode3d) {
        this.resizeThreeToHost();
        this.presentThreeIfReady();
      } else {
        this.redraw();
      }
    });
  }

  toggleThreeLabels(): void {
    this.showThreeLabels = !this.showThreeLabels;
    if (!this.viewMode3d) {
      return;
    }
    for (const tag of this.threeLabelObjects.values()) {
      tag.visible = this.showThreeLabels;
    }
    this.presentThreeIfReady();
  }

  readonly comparePlaybackSpeed = (a: number, b: number): boolean =>
    a === b ||
    (typeof a === 'number' &&
      typeof b === 'number' &&
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) < 1e-10);

  trackBody(_index: number, p: PlanetSnap): Body {
    return p.body;
  }

  private setupResizeObserver(): void {
    const wrap = this.canvasWrap?.nativeElement;
    if (!wrap || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.resizeObs = new ResizeObserver(() => {
      if (this.viewMode3d) {
        this.resizeThreeToHost();
        this.presentThreeIfReady();
      } else {
        this.redraw();
      }
    });
    this.resizeObs.observe(wrap);
  }

  private getChartWrapSize(): { w: number; h: number } {
    const wrap = this.canvasWrap?.nativeElement;
    const rawW = wrap?.clientWidth ?? 0;
    const w = rawW > 16 ? rawW : 800;
    const h = this.chartFullscreen
      ? Math.max(
          320,
          wrap?.clientHeight ?? (typeof window !== 'undefined' ? Math.round(window.innerHeight * 0.82) : 480)
        )
      : Math.max(320, Math.min(640, Math.round(w * 0.55)));
    return { w, h };
  }

  /** Dimensions CSS du bloc carte utilisées pour le canvas WebGL et la couche d’étiquettes CSS2D. */
  private getThreeHostCssSize(): { w: number; h: number } {
    let { w, h } = this.getChartWrapSize();
    w = Math.max(360, w);
    h = Math.max(280, h);
    return { w, h };
  }

  /** Rendu WebGL + étiquettes (orbites amorties via controls.update). */
  private presentThreeIfReady(): void {
    if (!this.viewMode3d || !this.threeRenderer || !this.threeScene || !this.threeCamera) {
      return;
    }
    this.threeControls?.update();
    this.threeRenderer.render(this.threeScene, this.threeCamera);
    this.threeCss2dRenderer?.render(this.threeScene, this.threeCamera);
  }

  private resizeThreeToHost(): void {
    const canvas = this.threeCanvas?.nativeElement;
    if (!canvas || !this.threeRenderer || !this.threeCamera) {
      return;
    }
    const { w, h } = this.getThreeHostCssSize();
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.threeRenderer.setPixelRatio(dpr);
    this.threeRenderer.setSize(w, h, false);
    this.threeCss2dRenderer?.setSize(w, h);
    this.threeCamera.aspect = w / Math.max(h, 1);
    this.threeCamera.updateProjectionMatrix();
  }

  /** Facteur radial 0–1 comme la carte 2D (linéaire ou log₁₀), pour une mise à l’échelle 3D cohérente. */
  private radialFactorAu(distAu: number, maxAu: number): number {
    const max = Math.max(maxAu, 1e-9);
    const d = Math.max(distAu, 0);
    if (this.logRadialScale) {
      const lo = Math.log10(1e-4);
      const hi = Math.log10(max + 1e-4);
      const t = (Math.log10(d + 1e-4) - lo) / Math.max(hi - lo, 1e-9);
      return Math.min(1, Math.max(0, t));
    }
    return Math.min(1, d / max);
  }

  /**
   * Positions scène Three.js depuis coordonnées écliptiques (UA) : X=ecl.x, Y=ecl.z, Z=ecl.y.
   * Référence géocentrique / héliocentrique : même normalisation radiale que la vue 2D.
   */
  private syncThreeMeshes(): void {
    const maxAu = Math.max(this.threeLayoutMaxAu, 1e-9);
    const targetR = this.threeTargetOrbitRadius;

    for (const p of this.planets) {
      const mesh = this.threeMeshes.get(p.body);
      if (!mesh) continue;
      const z = Number.isFinite(p.zAu) ? p.zAu : 0;
      let x = p.xAu;
      let yy = p.yAu;
      let zz = z;
      if (!Number.isFinite(x)) x = 0;
      if (!Number.isFinite(yy)) yy = 0;
      if (!Number.isFinite(zz)) zz = 0;

      const dist = Math.hypot(x, yy, zz);
      if (p.isReference || dist < 1e-15) {
        mesh.position.set(0, 0, 0);
      } else {
        const f = this.radialFactorAu(dist, maxAu);
        const R = f * targetR;
        const s = R / dist;
        mesh.position.set(x * s, zz * s, yy * s);
      }
      mesh.visible = true;
      mesh.matrixAutoUpdate = true;
    }

    const earthMesh = this.threeMeshes.get(Body.Earth);
    const moonMesh = this.threeMeshes.get(Body.Moon);
    if (earthMesh && moonMesh) {
      const dx = moonMesh.position.x - earthMesh.position.x;
      const dy = moonMesh.position.y - earthMesh.position.y;
      const dz = moonMesh.position.z - earthMesh.position.z;
      const geoDist = Math.hypot(dx, dy, dz);
      let ux = dx;
      let uy = dy;
      let uz = dz;
      if (geoDist < 1e-12) {
        ux = 1;
        uy = 0;
        uz = 0;
      } else {
        ux /= geoDist;
        uy /= geoDist;
        uz /= geoDist;
      }
      const rE = this.sceneSphereRadius(Body.Earth);
      const rM = this.sceneSphereRadius(Body.Moon);
      const minSep = rE * 1.1 + rM * 1.15 + 0.55;
      const sep = Math.max(minSep, geoDist * 32);
      moonMesh.position.set(
        earthMesh.position.x + ux * sep,
        earthMesh.position.y + uy * sep,
        earthMesh.position.z + uz * sep
      );
    }

    for (const p of this.planets) {
      const mesh = this.threeMeshes.get(p.body);
      if (!mesh) continue;
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        const meta = this.bodies.find((b) => b.body === p.body);
        if (meta) {
          const col = new THREE.Color(meta.color);
          if (p.isReference) col.offsetHSL(0, 0, 0.09);
          mat.color.copy(col);
          if (p.body === Body.Sun) {
            mat.emissive.copy(col);
            mat.emissiveIntensity = 1.18;
          } else {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
          }
        }
        mesh.scale.setScalar(p.isReference ? 1.18 : 1);
      }
      const tag = this.threeLabelObjects.get(p.body);
      if (tag) {
        tag.visible = this.showThreeLabels;
        const r = this.sceneSphereRadius(p.body);
        const px = mesh.position.x;
        const py = mesh.position.y;
        const pz = mesh.position.z;
        const len = Math.hypot(px, py, pz);
        /* Collés au corps : léger décalement radial + dispersion tangentielle réduite pour limiter les chevauchements. */
        const padBase = Math.max(r * 0.62, 1.35);
        const slot = this.bodies.findIndex((b) => b.body === p.body);
        const ga = (slot >= 0 ? slot : 0) * 2.3999632297286533;
        const lateral = 0.85 + r * 0.045;

        if (len > 1e-7) {
          const u = this.threeLblU.set(px / len, py / len, pz / len).normalize();
          const aux = Math.abs(u.y) > 0.88 ? this.threeLblV.set(1, 0, 0) : this.threeLblV.set(0, 1, 0);
          const v = this.threeLblW.crossVectors(aux, u);
          if (v.lengthSq() < 1e-10) {
            v.crossVectors(this.threeLblV.set(0, 0, 1), u);
          }
          v.normalize();
          const w = this.threeLblV.crossVectors(u, v).normalize();
          tag.position
            .copy(u)
            .multiplyScalar(padBase)
            .addScaledVector(v, Math.cos(ga) * lateral)
            .addScaledVector(w, Math.sin(ga) * lateral);
        } else {
          const spread = ((slot >= 0 ? slot : 0) - (this.bodies.length - 1) / 2) * 3.2;
          tag.position.set(spread, Math.max(r * 0.62, 1.9), 0);
        }
      }
      const el = tag?.element;
      if (el instanceof HTMLElement) {
        let labelText = this.translate.instant(p.labelKey);
        if (p.isReference) {
          labelText = `${labelText} ★`;
        }
        el.textContent = labelText;
        el.classList.toggle('solar-3d-label--ref', p.isReference);
      }
    }

    for (const p of this.planets) {
      const mesh = this.threeMeshes.get(p.body);
      const seg = this.threeRotationAxisSegs.get(p.body);
      const ring = this.threeRotationAxisRings.get(p.body);
      if (!mesh || !seg || !ring) continue;

      if (!this.showRotationAxes || !p.rotationAxis) {
        seg.visible = false;
        ring.visible = false;
        continue;
      }

      const ra = p.rotationAxis;
      const cx = mesh.position.x;
      const cy = mesh.position.y;
      const cz = mesh.position.z;
      const rBall = this.sceneSphereRadius(p.body);

      if (ra.orthogonal) {
        seg.visible = false;
        ring.visible = true;
        const rad = rBall + 0.42;
        const n = this.threeRotRingSegs;
        const rAttr = ring.geometry.getAttribute('position') as THREE.BufferAttribute;
        const rArr = rAttr.array as Float32Array;
        for (let i = 0; i < n; i++) {
          const th = (i / n) * Math.PI * 2;
          rArr[i * 3] = cx + Math.cos(th) * rad;
          rArr[i * 3 + 1] = cy;
          rArr[i * 3 + 2] = cz + Math.sin(th) * rad;
        }
        rAttr.needsUpdate = true;
      } else {
        ring.visible = false;
        seg.visible = true;
        this.threeScratchAxisDir.set(ra.ux, 0, ra.uy);
        if (this.threeScratchAxisDir.lengthSq() < 1e-12) {
          this.threeScratchAxisDir.set(1, 0, 0);
        } else {
          this.threeScratchAxisDir.normalize();
        }
        const extra = 0.65 + Math.min(2.2, rBall * 0.55);
        const L = rBall + extra;
        const dx = this.threeScratchAxisDir.x * L;
        const dy = this.threeScratchAxisDir.y * L;
        const dz = this.threeScratchAxisDir.z * L;
        const sAttr = seg.geometry.getAttribute('position') as THREE.BufferAttribute;
        const sArr = sAttr.array as Float32Array;
        sArr[0] = cx - dx;
        sArr[1] = cy - dy;
        sArr[2] = cz - dz;
        sArr[3] = cx + dx;
        sArr[4] = cy + dy;
        sArr[5] = cz + dz;
        sAttr.needsUpdate = true;
      }
    }
  }

  /** Traînée écliptique 3D : même normalisation radiale que les planètes (lin / log). */
  private syncThreeTrail(): void {
    const line = this.threeTrailLine;
    if (!line) {
      return;
    }

    if (!this.trailBody || this.trailDays <= 0) {
      line.visible = false;
      return;
    }

    const body = this.trailBody as Body;
    const ref = this.referenceBody;
    const samples = 72;
    const dtMs = (this.trailDays * 86400000) / samples;
    const maxAu = Math.max(this.threeLayoutMaxAu, 1e-9);
    const targetR = this.threeTargetOrbitRadius;
    const centerMs = this.simDate.getTime();
    const nPts = samples + 1;
    const positions = new Float32Array(nPts * 3);

    for (let i = 0; i <= samples; i++) {
      const t = new Date(centerMs - this.trailDays * 86400000 + i * dtMs);
      const refVec = HelioVector(ref, t);
      const helio = HelioVector(body, t);
      const relEq = this.minusVec(helio, refVec);
      const ecl = RotateVector(this.rotEqjEcl, relEq);
      const z = Number.isFinite(ecl.z) ? ecl.z : 0;
      let x = ecl.x;
      let yy = ecl.y;
      let zz = z;
      if (!Number.isFinite(x)) x = 0;
      if (!Number.isFinite(yy)) yy = 0;
      if (!Number.isFinite(zz)) zz = 0;
      const dist = Math.hypot(x, yy, zz);
      let px = 0;
      let py = 0;
      let pz = 0;
      if (dist >= 1e-15) {
        const f = this.radialFactorAu(dist, maxAu);
        const R = f * targetR;
        const s = R / dist;
        px = x * s;
        py = zz * s;
        pz = yy * s;
      }
      const j = i * 3;
      positions[j] = px;
      positions[j + 1] = py;
      positions[j + 2] = pz;
    }

    const geo = line.geometry as THREE.BufferGeometry;
    const attr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr || attr.count !== nPts) {
      geo.dispose();
      const next = new THREE.BufferGeometry();
      next.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      line.geometry = next;
    } else {
      (attr.array as Float32Array).set(positions);
      attr.needsUpdate = true;
    }

    const meta = this.bodies.find((b) => b.body === body);
    const mat = line.material as THREE.LineBasicMaterial;
    if (meta) {
      mat.color.set(meta.color);
    }
    mat.opacity = 0.52;
    line.visible = true;
  }

  /**
   * Rayons des sphères en unités scène (purement graphiques).
   * Le Soleil reste le plus grand objet ; Terre / Lune sont bien plus petits (pas les tailles réelles, mais hiérarchie lisible).
   */
  private sceneSphereRadius(body: Body): number {
    switch (body) {
      case Body.Sun:
        return 2.48;
      case Body.Jupiter:
        return 1.08;
      case Body.Saturn:
        return 0.95;
      case Body.Uranus:
      case Body.Neptune:
        return 0.74;
      case Body.Earth:
        return 0.34;
      case Body.Venus:
        return 0.33;
      case Body.Mars:
        return 0.27;
      case Body.Mercury:
        return 0.21;
      case Body.Moon:
        return 0.11;
      case Body.Pluto:
        return 0.15;
      default:
        return 0.28;
    }
  }

  private ensureThreeReady(): void {
    if (!this.viewMode3d) {
      this.threeBootstrapRetries = 0;
      return;
    }
    if (!this.threeCanvas?.nativeElement) {
      if (this.threeBootstrapRetries < 50) {
        this.threeBootstrapRetries++;
        setTimeout(() => this.ensureThreeReady(), 32);
      }
      return;
    }
    this.threeBootstrapRetries = 0;
    this.initThreeIfNeeded();
    this.resizeThreeToHost();
    this.syncThreeMeshes();
    this.startThreeLoop();
  }

  private startThreeLoop(): void {
    if (this.threeRaf !== 0) {
      return;
    }
    const loop = (): void => {
      if (!this.viewMode3d || !this.threeRenderer || !this.threeScene || !this.threeCamera) {
        this.threeRaf = 0;
        return;
      }
      if (this.playing) {
        const now = performance.now();
        const dtSec = Math.min(0.25, (now - this.lastFrameMs) / 1000);
        this.lastFrameMs = now;
        const msAdvance = dtSec * this.playbackSpeedDaysPerSec * 86400000;
        this.simDate = new Date(this.simDate.getTime() + msAdvance);
        this.syncDatetimeInputFromSim();
        this.syncTimelineSliderFromSim();
        this.redraw();
      } else {
        this.presentThreeIfReady();
      }
      this.threeRaf = requestAnimationFrame(loop);
    };
    this.threeRaf = requestAnimationFrame(loop);
  }

  private initThreeIfNeeded(): void {
    const canvas = this.threeCanvas?.nativeElement;
    if (!canvas || this.threeRenderer || !this.viewMode3d) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060914);

    const ambLight = new THREE.AmbientLight(0xffffff, 0.38);
    scene.add(ambLight);
    const dirLight = new THREE.DirectionalLight(0xfff5ec, 1.12);
    dirLight.position.set(140, 220, 180);
    scene.add(dirLight);

    const cam = new THREE.PerspectiveCamera(48, 1, 0.12, 12000);
    this.threeCamera = cam;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      stencil: false
    });
    renderer.setPixelRatio(Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    this.threeRenderer = renderer;

    this.resizeThreeToHost();

    /* Repère léger (plan écliptique ≈ plan XZ, Y = hors-plan) ; depthWrite off pour ne pas « gruger » les sphères. */
    const grid = new THREE.GridHelper(520, 26, 0x4a6a9a, 0x1e2d42);
    grid.position.y = -2;
    grid.renderOrder = 0;
    grid.traverse((child) => {
      const ls = child as THREE.LineSegments & { material?: THREE.Material | THREE.Material[] };
      const mat = ls.material;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        m.transparent = true;
        m.opacity = 0.38;
        m.depthWrite = false;
      }
    });
    scene.add(grid);

    const axes = new THREE.AxesHelper(160);
    axes.renderOrder = 2;
    axes.traverse((child) => {
      const ls = child as THREE.LineSegments & { material?: THREE.Material | THREE.Material[] };
      const mat = ls.material;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        m.depthWrite = false;
      }
    });
    scene.add(axes);

    const trailGeo = new THREE.BufferGeometry();
    const trailMat = new THREE.LineBasicMaterial({
      color: 0x8899aa,
      transparent: true,
      opacity: 0.52,
      depthWrite: false
    });
    const trailLine = new THREE.Line(trailGeo, trailMat);
    trailLine.visible = false;
    trailLine.frustumCulled = false;
    trailLine.renderOrder = 8;
    scene.add(trailLine);
    this.threeTrailLine = trailLine;

    for (const meta of this.bodies) {
      const r = this.sceneSphereRadius(meta.body);
      const geo = new THREE.SphereGeometry(r, 28, 28);
      const baseCol = new THREE.Color(meta.color);
      const mat =
        meta.body === Body.Sun
          ? new THREE.MeshStandardMaterial({
              color: baseCol,
              emissive: baseCol.clone(),
              emissiveIntensity: 1.15,
              roughness: 0.55,
              metalness: 0.05
            })
          : new THREE.MeshStandardMaterial({
              color: baseCol,
              roughness: 0.58,
              metalness: 0.06
            });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      scene.add(mesh);
      this.threeMeshes.set(meta.body, mesh);

      const div = document.createElement('div');
      div.className = 'solar-3d-label';
      const tag = new CSS2DObject(div);
      tag.center.set(0.5, 1);
      tag.visible = this.showThreeLabels;
      mesh.add(tag);
      this.threeLabelObjects.set(meta.body, tag);
    }

    const rotSegMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false
    });
    const rotRingMat = new THREE.LineBasicMaterial({
      color: 0xaad7ff,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    });
    const nRing = this.threeRotRingSegs;
    for (const meta of this.bodies) {
      const segGeo = new THREE.BufferGeometry();
      segGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const seg = new THREE.LineSegments(segGeo, rotSegMat.clone());
      seg.visible = false;
      seg.frustumCulled = false;
      seg.renderOrder = 11;
      scene.add(seg);
      this.threeRotationAxisSegs.set(meta.body, seg);

      const ringPos = new Float32Array(nRing * 3);
      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
      const ring = new THREE.LineLoop(ringGeo, rotRingMat.clone());
      ring.visible = false;
      ring.frustumCulled = false;
      ring.renderOrder = 11;
      scene.add(ring);
      this.threeRotationAxisRings.set(meta.body, ring);
    }

    const wrap = this.canvasWrap?.nativeElement;
    if (wrap) {
      const lr = new CSS2DRenderer();
      const dim = this.getThreeHostCssSize();
      lr.setSize(dim.w, dim.h);
      lr.domElement.className = 'solar-css2d-layer';
      lr.domElement.style.position = 'absolute';
      lr.domElement.style.left = '0';
      lr.domElement.style.top = '0';
      lr.domElement.style.pointerEvents = 'none';
      wrap.appendChild(lr.domElement);
      this.threeCss2dRenderer = lr;
    }

    const controls = new OrbitControls(cam, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 1.15;
    controls.zoomToCursor = true;
    controls.enablePan = true;
    controls.panSpeed = 1;
    controls.screenSpacePanning = true;
    controls.minDistance = 5;
    controls.maxDistance = 250000;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };
    controls.target.set(0, 0, 0);
    this.threeControls = controls;

    this.threeScene = scene;

    this.syncThreeMeshes();
    this.syncThreeTrail();
    this.fitThreeCameraInitial(cam, controls);
  }

  private fitThreeCameraInitial(cam: THREE.PerspectiveCamera, controls: OrbitControls): void {
    cam.near = 0.12;
    cam.far = 80000;
    /* Cadre tout le système normalisé (~threeTargetOrbitRadius + grosses sphères + marge). */
    const contentRadius = this.threeTargetOrbitRadius + this.sceneSphereRadius(Body.Sun) + 24;
    const halfVfov = THREE.MathUtils.degToRad(cam.fov / 2);
    const dist = (contentRadius * 1.28) / Math.tan(Math.max(halfVfov, 1e-4));
    cam.position.set(dist * 0.55, dist * 0.42, dist * 0.62);
    cam.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    cam.updateProjectionMatrix();
  }

  private disposeThree(): void {
    cancelAnimationFrame(this.threeRaf);
    this.threeRaf = 0;
    this.threeControls?.dispose();
    this.threeControls = undefined;

    if (this.threeCss2dRenderer) {
      this.threeCss2dRenderer.domElement.remove();
      this.threeCss2dRenderer = undefined;
    }
    this.threeLabelObjects.clear();

    if (this.threeScene) {
      this.threeScene.traverse((obj: THREE.Object3D) => {
        const o = obj as THREE.Mesh & {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        o.geometry?.dispose();
        const mat = o.material;
        if (!mat) return;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      });
      this.threeScene.clear();
    }
    this.threeScene = undefined;
    this.threeMeshes.clear();
    this.threeTrailLine = undefined;
    this.threeRotationAxisSegs.clear();
    this.threeRotationAxisRings.clear();

    this.threeRenderer?.dispose();
    this.threeRenderer = undefined;
    this.threeCamera = undefined;
  }

  private animLoop(now: number): void {
    if (!this.playing) {
      return;
    }
    if (this.viewMode3d) {
      return;
    }
    const dtSec = Math.min(0.25, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;
    const msAdvance = dtSec * this.playbackSpeedDaysPerSec * 86400000;
    this.simDate = new Date(this.simDate.getTime() + msAdvance);
    this.syncDatetimeInputFromSim();
    this.syncTimelineSliderFromSim();
    this.redraw();
    this.animId = requestAnimationFrame((t) => this.animLoop(t));
  }

  private syncDatetimeInputFromSim(): void {
    const d = this.simDate;
    const p = (n: number) => String(n).padStart(2, '0');
    this.datetimeLocalValue = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  private initTimelineAround(midMs: number): void {
    const halfMs = (this.timelineSpanDays / 2) * 86400000;
    this.timelineStartMs = midMs - halfMs;
    this.timelineEndMs = midMs + halfMs;
  }

  /**
   * Garde la date simulée dans la fenêtre ou recentre la fenêtre si elle sort
   * (ex. lecture automatique ou gros pas).
   */
  private syncTimelineSliderFromSim(): void {
    const t = this.simDate.getTime();
    if (t < this.timelineStartMs || t > this.timelineEndMs) {
      this.initTimelineAround(t);
    }
    const span = this.timelineEndMs - this.timelineStartMs;
    if (span <= 0) {
      return;
    }
    this.timelineSliderPct = Math.max(0, Math.min(100, ((t - this.timelineStartMs) / span) * 100));
  }

  private redraw(): void {
    const date = this.simDate;
    const refVec = HelioVector(this.referenceBody, date);

    const snapsPre: Omit<PlanetSnap, 'px' | 'py' | 'markerR'>[] = [];

    for (const meta of this.bodies) {
      const helio = HelioVector(meta.body, date);
      const relEq = this.minusVec(helio, refVec);
      const ecl = RotateVector(this.rotEqjEcl, relEq);
      const distAu = Math.hypot(relEq.x, relEq.y, relEq.z);
      let phaseDeg: number | undefined;
      if (meta.body === Body.Moon) {
        phaseDeg = MoonPhase(date);
      }

      snapsPre.push({
        body: meta.body,
        labelKey: meta.labelKey,
        color: meta.color,
        xAu: ecl.x,
        yAu: ecl.y,
        zAu: ecl.z,
        distAu,
        isReference: meta.body === this.referenceBody,
        phaseDeg
      });
    }

    let moonGeo: MoonIllumSummary | undefined;
    try {
      const ill = Illumination(Body.Moon, date);
      moonGeo = {
        phase_angle: ill.phase_angle,
        phase_fraction: ill.phase_fraction,
        mag: ill.mag
      };
    } catch {
      moonGeo = undefined;
    }
    this.moonIllum = moonGeo;

    const effectiveDistances = snapsPre.filter((s) => !s.isReference && s.distAu > 1e-9).map((s) => s.distAu);
    const maxAu = Math.max(...effectiveDistances, 1e-6);
    this.threeLayoutMaxAu = maxAu;

    if (this.viewMode3d) {
      this.planets = snapsPre.map((s, i) => {
        const meta = this.bodies[i];
        const rotationAxis = this.showRotationAxes ? this.computeRotationAxisPaint(meta.body, date) : undefined;
        return {
          ...s,
          px: 0,
          py: 0,
          markerR: meta.markerMin,
          rotationAxis
        };
      });
      const tc = this.threeCanvas?.nativeElement;
      if (!tc) {
        return;
      }
      this.resizeThreeToHost();
      this.syncThreeMeshes();
      this.syncThreeTrail();
      this.presentThreeIfReady();
      return;
    }

    const canvas = this.orbitCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const { w, h } = this.getChartWrapSize();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = w / 2;
    const cy = h / 2;
    const pad = 48;
    const maxR = Math.min(w, h) / 2 - pad;

    const toPix = (ex: number, ey: number): { px: number; py: number } => {
      const rAu = Math.hypot(ex, ey);
      const ang = Math.atan2(ey, ex);
      let rNorm: number;
      if (this.logRadialScale) {
        const lo = Math.log10(1e-4);
        const hi = Math.log10(maxAu + 1e-4);
        const t = (Math.log10(rAu + 1e-4) - lo) / Math.max(hi - lo, 1e-9);
        rNorm = Math.min(1, Math.max(0, t)) * maxR * this.zoom;
      } else {
        rNorm = (rAu / maxAu) * maxR * this.zoom;
      }
      return {
        px: cx + Math.cos(ang) * rNorm,
        py: cy + Math.sin(ang) * rNorm
      };
    };

    this.planets = snapsPre.map((s, i) => {
      const meta = this.bodies[i];
      const { px, py } = toPix(s.xAu, s.yAu);
      const distLabelAu = s.distAu;
      const markerBase =
        meta.markerMin +
        (meta.markerMax - meta.markerMin) * Math.min(1, Math.log10(distLabelAu + 1.2) / Math.log10(45));
      const markerR = s.isReference ? meta.markerMax + 4 : markerBase;
      const rotationAxis = this.showRotationAxes ? this.computeRotationAxisPaint(meta.body, date) : undefined;
      return {
        ...s,
        px,
        py,
        markerR,
        distAu: distLabelAu,
        rotationAxis
      };
    });

    this.chartDiagCx = cx;
    this.chartDiagCy = cy;
    this.ensureOrbitCanvasInteractions();

    this.drawScene(ctx, w, h, cx, cy, maxR, date, toPix);
  }

  private drawScene(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    cx: number,
    cy: number,
    maxR: number,
    date: Date,
    toPix: (ex: number, ey: number) => { px: number; py: number }
  ): void {
    const vm = this.chartViewMagnify;
    const panX = this.chartViewPanX;
    const panY = this.chartViewPanY;
    const tf = (px: number, py: number) => ({
      x: cx + panX + (px - cx) * vm,
      y: cy + panY + (py - cy) * vm
    });
    const mr = (r: number) => Math.max(0.45, r * vm);
    const OC = tf(cx, cy);

    const grd = ctx.createRadialGradient(cx * 0.35, cy * 0.25, 0, cx, cy, Math.max(w, h));
    grd.addColorStop(0, '#141e38');
    grd.addColorStop(0.45, '#0a0f1e');
    grd.addColorStop(1, '#03040a');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(120,170,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(OC.x, OC.y, ((maxR * i) / 4) * vm, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let a = 0; a < 360; a += 45) {
      const rad = (a * Math.PI) / 180;
      const tip = tf(cx + Math.cos(rad) * maxR * 1.05, cy + Math.sin(rad) * maxR * 1.05);
      ctx.beginPath();
      ctx.moveTo(OC.x, OC.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(OC.x, OC.y, maxR * vm, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '600 11px system-ui,Segoe UI,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.logRadialScale ? 'log₁₀(r + ε)' : 'r ∝ AU', w / 2, 18);
    if (this.showRotationAxes) {
      ctx.font = '500 10px system-ui,Segoe UI,sans-serif';
      ctx.fillStyle = 'rgba(190, 210, 255, 0.42)';
      ctx.fillText(this.translate.instant('SOLAR_SYSTEM.ROTATION_AXIS_HINT'), w / 2, 32);
      ctx.font = '600 11px system-ui,Segoe UI,sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
    }

    const toPixTf = (ex: number, ey: number) => {
      const q = toPix(ex, ey);
      const t = tf(q.px, q.py);
      return { px: t.x, py: t.y };
    };

    if (this.trailBody && this.trailDays > 0) {
      this.drawTrail(ctx, date, toPixTf, vm);
    }

    const drawOrder = [...this.planets].sort((a, b) => {
      if (a.isReference) {
        return 1;
      }
      if (b.isReference) {
        return -1;
      }
      return b.distAu - a.distAu;
    });

    for (const p of drawOrder) {
      const P = tf(p.px, p.py);
      const rDraw = mr(p.markerR);
      const pulse = p.isReference ? 8 * vm : 0;
      if (pulse > 0) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(111,200,255,0.35)';
        ctx.lineWidth = 2;
        ctx.arc(P.x, P.y, rDraw + pulse, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.beginPath();
      const g = ctx.createRadialGradient(P.x - 2, P.y - 2, 1, P.x, P.y, rDraw + 3);
      g.addColorStop(0, this.lighten(p.color, 0.35));
      g.addColorStop(0.55, p.color);
      g.addColorStop(1, this.darken(p.color, 0.45));
      ctx.fillStyle = g;
      ctx.arc(P.x, P.y, rDraw, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (p.rotationAxis) {
        const scaled: PlanetSnap = { ...p, px: P.x, py: P.y, markerR: rDraw };
        this.drawRotationAxis(ctx, scaled);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 11px system-ui,Segoe UI,sans-serif';
      ctx.textAlign = 'left';
      const label = this.translate.instant(p.labelKey);
      ctx.fillText(label, P.x + rDraw + 6, P.y + 4);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(200,215,255,0.55)';
    ctx.font = '500 10px system-ui,Segoe UI,sans-serif';
    ctx.fillText(
      date.toLocaleString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      w / 2,
      h - 12
    );
  }

  private computeRotationAxisPaint(body: Body, date: Date): RotationAxisPaint | undefined {
    try {
      const axis = RotationAxis(body, date);
      const v = RotateVector(this.rotEqjEcl, axis.north);
      const horiz = Math.hypot(v.x, v.y);
      const orthoThreshold = 0.07;
      if (horiz < orthoThreshold) {
        return { ux: 0, uy: 0, orthogonal: true };
      }
      const ux = v.x / horiz;
      const uy = v.y / horiz;
      return { ux, uy, orthogonal: false };
    } catch {
      return undefined;
    }
  }

  private drawRotationAxis(ctx: CanvasRenderingContext2D, p: PlanetSnap): void {
    const ra = p.rotationAxis;
    if (!ra) {
      return;
    }
    ctx.save();
    if (ra.orthogonal) {
      ctx.strokeStyle = 'rgba(170, 215, 255, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(p.px, p.py, p.markerR + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const extra = 6 + Math.min(14, p.markerR * 0.45);
      const L = p.markerR + extra;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
      ctx.lineWidth = Math.max(1, Math.min(2, p.markerR / 7));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.px - ra.ux * L, p.py - ra.uy * L);
      ctx.lineTo(p.px + ra.ux * L, p.py + ra.uy * L);
      ctx.stroke();
      const tipX = p.px + ra.ux * L;
      const tipY = p.py + ra.uy * L;
      const perpX = -ra.uy;
      const perpY = ra.ux;
      const ah = Math.max(3, Math.min(5.5, p.markerR / 3));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ra.ux * ah + perpX * (ah * 0.55), tipY - ra.uy * ah + perpY * (ah * 0.55));
      ctx.lineTo(tipX - ra.ux * ah - perpX * (ah * 0.55), tipY - ra.uy * ah - perpY * (ah * 0.55));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTrail(
    ctx: CanvasRenderingContext2D,
    date: Date,
    toPix: (ex: number, ey: number) => { px: number; py: number },
    lineScale = 1
  ): void {
    const body = this.trailBody as Body;
    const ref = this.referenceBody;
    const samples = 72;
    const dtMs = (this.trailDays * 86400000) / samples;
    ctx.beginPath();
    let started = false;
    const meta = this.bodies.find((b) => b.body === body);
    const col = meta?.color ?? '#888';

    for (let i = 0; i <= samples; i++) {
      const t = new Date(date.getTime() - this.trailDays * 86400000 + i * dtMs);
      const refVec = HelioVector(ref, t);
      const helio = HelioVector(body, t);
      const relEq = this.minusVec(helio, refVec);
      const ecl = RotateVector(this.rotEqjEcl, relEq);
      const { px, py } = toPix(ecl.x, ecl.y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.strokeStyle = this.hexToRgba(col, 0.45);
    ctx.lineWidth = Math.max(1, 2 * Math.min(Math.max(lineScale, 0.25), 4));
    ctx.stroke();
  }

  private ensureOrbitCanvasInteractions(): void {
    const el = this.orbitCanvas?.nativeElement;
    if (!el || this.viewMode3d) {
      return;
    }
    const mark = el as HTMLCanvasElement & { solarInteractions?: boolean };
    if (mark.solarInteractions) {
      return;
    }
    mark.solarInteractions = true;
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';
    el.addEventListener('wheel', this.onChartWheelEv, { passive: false });
    el.addEventListener('pointerdown', this.onChartPointerDownEv);
    el.addEventListener('pointermove', this.onChartPointerMoveEv);
    el.addEventListener('pointerup', this.onChartPointerUpEv);
    el.addEventListener('pointercancel', this.onChartPointerUpEv);
    el.addEventListener('lostpointercapture', this.onChartPointerUpEv);
  }

  private detachOrbitCanvasInteractions(): void {
    const el = this.orbitCanvas?.nativeElement as (HTMLCanvasElement & { solarInteractions?: boolean }) | undefined;
    if (!el?.solarInteractions) {
      return;
    }
    el.solarInteractions = false;
    el.removeEventListener('wheel', this.onChartWheelEv as EventListener);
    el.removeEventListener('pointerdown', this.onChartPointerDownEv as EventListener);
    el.removeEventListener('pointermove', this.onChartPointerMoveEv as EventListener);
    el.removeEventListener('pointerup', this.onChartPointerUpEv as EventListener);
    el.removeEventListener('pointercancel', this.onChartPointerUpEv as EventListener);
    el.removeEventListener('lostpointercapture', this.onChartPointerUpEv as EventListener);
    el.style.cursor = '';
    this.chartPanDragging = false;
  }

  private handleChartWheel(ev: WheelEvent): void {
    if (this.viewMode3d) {
      return;
    }
    ev.preventDefault();
    const canvas = this.orbitCanvas?.nativeElement;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const cx = this.chartDiagCx;
    const cy = this.chartDiagCy;

    let dy = ev.deltaY;
    if (ev.deltaMode === 1) {
      dy *= 16;
    } else if (ev.deltaMode === 2) {
      dy *= rect.height;
    }
    const zoomIntensity = 0.0012;
    const factor = Math.exp(-dy * zoomIntensity);
    const prevMag = this.chartViewMagnify;
    const newMag = Math.min(48, Math.max(0.06, prevMag * factor));
    if (Math.abs(newMag - prevMag) < 1e-6) {
      return;
    }

    const wx = cx + (mx - cx - this.chartViewPanX) / prevMag;
    const wy = cy + (my - cy - this.chartViewPanY) / prevMag;
    this.chartViewMagnify = newMag;
    this.chartViewPanX = mx - cx - (wx - cx) * this.chartViewMagnify;
    this.chartViewPanY = my - cy - (wy - cy) * this.chartViewMagnify;
    this.redraw();
  }

  private handleChartPointerDown(ev: PointerEvent): void {
    if (this.viewMode3d || ev.button !== 0) {
      return;
    }
    const canvas = this.orbitCanvas?.nativeElement;
    if (!canvas || ev.target !== canvas) {
      return;
    }
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    this.chartPanDragging = true;
    canvas.style.cursor = 'grabbing';
    this.chartPanLastSX = ev.clientX;
    this.chartPanLastSY = ev.clientY;
  }

  private handleChartPointerMove(ev: PointerEvent): void {
    if (!this.chartPanDragging || this.viewMode3d) {
      return;
    }
    ev.preventDefault();
    const dx = ev.clientX - this.chartPanLastSX;
    const dy = ev.clientY - this.chartPanLastSY;
    this.chartPanLastSX = ev.clientX;
    this.chartPanLastSY = ev.clientY;
    this.chartViewPanX += dx;
    this.chartViewPanY += dy;
    if (this.chartPanRedrawRaf) {
      return;
    }
    this.chartPanRedrawRaf = requestAnimationFrame(() => {
      this.chartPanRedrawRaf = 0;
      if (!this.viewMode3d) {
        this.redraw();
      }
    });
  }

  private handleChartPointerUp(ev: PointerEvent): void {
    if (!this.chartPanDragging) {
      return;
    }
    this.chartPanDragging = false;
    const canvas = this.orbitCanvas?.nativeElement;
    if (canvas?.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    if (canvas) {
      canvas.style.cursor = 'grab';
    }
  }

  private minusVec(a: Vector, b: Vector): Vector {
    return new Vector(a.x - b.x, a.y - b.y, a.z - b.z, a.t);
  }

  private lighten(hex: string, f: number): string {
    const { r, g, b } = this.parseHex(hex);
    return `rgb(${Math.round(r + (255 - r) * f)},${Math.round(g + (255 - g) * f)},${Math.round(b + (255 - b) * f)})`;
  }

  private darken(hex: string, f: number): string {
    const { r, g, b } = this.parseHex(hex);
    return `rgb(${Math.round(r * (1 - f))},${Math.round(g * (1 - f))},${Math.round(b * (1 - f))})`;
  }

  private parseHex(hex: string): { r: number; g: number; b: number } {
    const h = hex.replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }

  private hexToRgba(hex: string, a: number): string {
    const { r, g, b } = this.parseHex(hex);
    return `rgba(${r},${g},${b},${a})`;
  }
}

interface MoonIllumSummary {
  phase_angle: number;
  phase_fraction: number;
  mag: number;
}
