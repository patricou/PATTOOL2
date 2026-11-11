import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DAY_S,
  EARTH_GRAVITY_LY_PER_YR2,
  LIGHT_SPEED_M_S,
  LightDeflection,
  OrbitState,
  SUN_COMPACTNESS,
  appleHeight,
  appleProperTime,
  circularSpeed,
  clockDrift,
  clockRate,
  criticalImpactParameter,
  embeddingHeight,
  escapeSpeed,
  fixedClockTime,
  groundFrameToFreeFall,
  impactTime,
  lightDeflection,
  orbitalSpeed,
  schwarzschildRadius,
  stepOrbit
} from './espace-temps-physics';
import {
  CLOCK_BODIES,
  ClockBody,
  ClockPreset,
  altitudeToSlider,
  drawClocksView,
  formatDistance,
  formatDuration,
  formatSpeed,
  sliderToAltitude
} from './espace-temps-clocks';
import {
  LIGHT_AIM_MAX,
  LIGHT_AIM_MIN,
  LIGHT_COLLAPSE_RS,
  LIGHT_RS_MAX,
  LIGHT_STAR_RADIUS,
  LightRayCache,
  drawLightView,
  isBlackHole,
  lightAbsorbRadius,
  lightEffectiveRs
} from './espace-temps-light';

export type SpacetimeView = 'grid' | 'apple' | 'clocks' | 'light';
type PlanetStatus = 'orbit' | 'impact' | 'escaped';

/** Valeurs de la vue « horloges », déjà mises en forme pour l'affichage. */
interface ClockReadout {
  altitude: string;
  speed: string;
  effectAltitude: string;
  effectSpeed: string;
  effectTotal: string;
  days: string;
  gap: string;
  gapKey: string;
  /** Distance parcourue par la lumière pendant l'écart ; vide hors de la Terre. */
  positionError: string;
}

const VIEW_TEXT: Record<SpacetimeView, { ideaTitle: string; ideaBody: string; hint: string; limit: string }> = {
  grid: {
    ideaTitle: 'ESPACE_TEMPS.IDEA_GRID_TITLE',
    ideaBody: 'ESPACE_TEMPS.IDEA_GRID_BODY',
    hint: 'ESPACE_TEMPS.HINT_GRID',
    limit: 'ESPACE_TEMPS.LIMIT_GRID'
  },
  apple: {
    ideaTitle: 'ESPACE_TEMPS.IDEA_APPLE_TITLE',
    ideaBody: 'ESPACE_TEMPS.IDEA_APPLE_BODY',
    hint: 'ESPACE_TEMPS.HINT_APPLE_GROUND',
    limit: 'ESPACE_TEMPS.LIMIT_APPLE'
  },
  clocks: {
    ideaTitle: 'ESPACE_TEMPS.IDEA_CLOCKS_TITLE',
    ideaBody: 'ESPACE_TEMPS.IDEA_CLOCKS_BODY',
    hint: 'ESPACE_TEMPS.HINT_CLOCKS',
    limit: 'ESPACE_TEMPS.LIMIT_CLOCKS'
  },
  light: {
    ideaTitle: 'ESPACE_TEMPS.IDEA_LIGHT_TITLE',
    ideaBody: 'ESPACE_TEMPS.IDEA_LIGHT_BODY',
    hint: 'ESPACE_TEMPS.HINT_LIGHT',
    limit: 'ESPACE_TEMPS.LIMIT_LIGHT'
  }
};

interface Orbiter {
  state: OrbitState;
  h: number;
  alive: boolean;
  trailR: number[];
  trailPhi: number[];
}

/* Vue « grille » (unités de scène, G = c = 1). */
const BODY_RADIUS = 6;
const RS_MAX = 4;
const GRID_HALF = 80;
const GRID_LINES = 41;
const GRID_SEGMENTS = 96;
const LAUNCH_R = 30;
const ESCAPE_R = 150;
const PLANET_RADIUS = 2.1;
const SIM_RATE = 110;
const SIM_STEP = 0.25;
const TRAIL_MAX = 2400;
const RESPAWN_MS = 1600;
const NO_MASS = 0.005;
/** Ralentissement du temps (1 − rythme) à partir duquel la grille est entièrement rouge. */
const SLOWDOWN_FULL_COLOR = 0.25;
/** Dégradé « temps normal → temps ralenti » en sRGB ; identique à .st-legend-bar dans la feuille de style. */
const COLOR_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0.302, 0.659, 1],
  [0.761, 0.392, 1],
  [1, 0.302, 0.2]
];

/* Vue « pomme » (années et années-lumière, c = 1). */
const APPLE_Z0 = 0.5;
const APPLE_T_WINDOW = 1.6;
const APPLE_T_GRID = 1.7;
const APPLE_H_MIN = -0.12;
const APPLE_H_MAX = 0.85;
const APPLE_RATE = 0.2;
const APPLE_HOLD_MS = 1500;
const VIEWPOINT_TWEEN_S = 1.2;

/* Vue « horloges » : jours simulés par seconde réelle. */
const CLOCK_DAYS_PER_S = 1;
/* Vue « lumière » : unités de temps lointain par seconde réelle. */
const LIGHT_ANIM_RATE = 22;

const READOUT_INTERVAL_MS = 160;

@Component({
  selector: 'app-espace-temps',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './espace-temps.component.html',
  styleUrls: ['./espace-temps.component.css']
})
export class EspaceTempsComponent implements AfterViewInit, OnDestroy {
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);

  @ViewChild('gridCanvas') gridCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('flatCanvas') flatCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasWrap') wrapRef?: ElementRef<HTMLElement>;
  @ViewChild('fsRoot') fsRoot?: ElementRef<HTMLElement>;

  readonly views: ReadonlyArray<{ id: SpacetimeView; icon: string; labelKey: string }> = [
    { id: 'grid', icon: 'fa-th', labelKey: 'ESPACE_TEMPS.VIEW_GRID' },
    { id: 'apple', icon: 'fa-apple', labelKey: 'ESPACE_TEMPS.VIEW_APPLE' },
    { id: 'clocks', icon: 'fa-clock-o', labelKey: 'ESPACE_TEMPS.VIEW_CLOCKS' },
    { id: 'light', icon: 'fa-lightbulb-o', labelKey: 'ESPACE_TEMPS.VIEW_LIGHT' }
  ];
  readonly rsMax = RS_MAX;
  readonly launchSpeedMax = 0.45;
  readonly gravityMax = 1.5;
  readonly sunCompactnessPercent = SUN_COMPACTNESS * 100;
  readonly clockBodies = CLOCK_BODIES;
  readonly lightRsMax = LIGHT_RS_MAX;
  readonly lightAimMin = LIGHT_AIM_MIN;
  readonly lightAimMax = LIGHT_AIM_MAX;
  /** Position, sur le curseur de masse, du seuil d'effondrement en trou noir. */
  readonly lightCollapsePercent = (LIGHT_COLLAPSE_RS / LIGHT_RS_MAX) * 100;

  view: SpacetimeView = 'grid';
  playing = true;
  fullscreen = false;
  webglError = false;

  massRs = 1.5;
  launchSpeed = 0.13;
  showNewton = false;
  planetStatus: PlanetStatus = 'orbit';
  planetDistance = LAUNCH_R;

  /** Pesanteur en multiples de la pesanteur terrestre. */
  gravityG = 1;
  /** 0 = repère de la pomme (chute libre), 1 = repère du sol. */
  viewpoint = 1;
  appleT = 0;

  clockBodyId = CLOCK_BODIES[0].id;
  /** Curseur d'altitude (0 à 1) ; au départ, l'altitude des satellites GPS. */
  clockSlider = altitudeToSlider(CLOCK_BODIES[0].presets[1].altitude, CLOCK_BODIES[0]);
  clockOrbiting = true;
  /** Temps simulé écoulé au sol, en jours. */
  clockDays = 0;

  /** Rayon de Schwarzschild de l'astre de la vue « lumière », en unités de scène. */
  lightRs = 3;
  /** Distance de visée du rayon suivi. */
  lightAim = 14;
  lightDeflectionResult: LightDeflection = lightDeflection(14, 3, lightAbsorbRadius(3));

  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private gridGeometry?: THREE.BufferGeometry;
  private star?: THREE.Mesh;
  private planetMesh?: THREE.Mesh;
  private ghostMesh?: THREE.Mesh;
  private planetTrail?: THREE.Line;
  private ghostTrail?: THREE.Line;
  private edgeHeight = 0;

  private planet: Orbiter = this.newOrbiter();
  private ghost: Orbiter = this.newOrbiter();
  private respawnAt = 0;

  private viewpointTarget: number | null = null;
  private appleHoldUntil = 0;

  private clockReadoutKey = '';
  private clockReadoutCache?: ClockReadout;
  private satAngle = -Math.PI / 2;
  private lightTime = 0;
  private readonly lightRays = new LightRayCache();

  /** Une des vues 2D doit être redessinée. */
  private flatDirty = true;

  private raf = 0;
  private lastTs = 0;
  private lastReadoutTs = 0;
  private readoutDirty = false;
  private readoutNow = false;
  private resizeObs?: ResizeObserver;
  private langSub?: Subscription;
  private readonly scratchColor = new THREE.Color();

  ngAfterViewInit(): void {
    this.langSub = this.translate.onLangChange.subscribe(() => {
      this.flatDirty = true;
    });
    this.zone.runOutsideAngular(() => {
      this.initThree();
      this.relaunch();
      const wrap = this.wrapRef?.nativeElement;
      if (wrap && typeof ResizeObserver !== 'undefined') {
        this.resizeObs = new ResizeObserver(() => this.resize());
        this.resizeObs.observe(wrap);
      }
      this.resize();
      this.raf = requestAnimationFrame(this.loop);
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.langSub?.unsubscribe();
    this.resizeObs?.disconnect();
    this.disposeThree();
  }

  /* ---------- Lectures pour le gabarit ---------- */

  get hasMass(): boolean {
    return this.massRs > NO_MASS;
  }

  get compactnessPercent(): number {
    return (this.massRs / BODY_RADIUS) * 100;
  }

  get circularSpeedValue(): number {
    return circularSpeed(LAUNCH_R, this.massRs);
  }

  get escapeSpeedValue(): number {
    return escapeSpeed(LAUNCH_R, this.massRs);
  }

  get surfaceClockPercent(): number {
    return clockRate(BODY_RADIUS, this.massRs, BODY_RADIUS) * 100;
  }

  get planetClockPercent(): number {
    return clockRate(Math.max(this.planetDistance, BODY_RADIUS), this.massRs, BODY_RADIUS) * 100;
  }

  get planetStatusKey(): string {
    switch (this.planetStatus) {
      case 'impact':
        return 'ESPACE_TEMPS.STATUS_IMPACT';
      case 'escaped':
        return 'ESPACE_TEMPS.STATUS_ESCAPED';
      default:
        return 'ESPACE_TEMPS.STATUS_ORBIT';
    }
  }

  get gravity(): number {
    return this.gravityG * EARTH_GRAVITY_LY_PER_YR2;
  }

  get appleEndTime(): number {
    return Math.min(impactTime(this.gravity, APPLE_Z0), APPLE_T_WINDOW);
  }

  get clockGround(): number {
    return this.appleT;
  }

  get clockShelf(): number {
    return fixedClockTime(this.gravity, this.appleT, APPLE_Z0);
  }

  get clockApple(): number {
    return appleProperTime(this.gravity, this.appleT, APPLE_Z0);
  }

  get fromApple(): boolean {
    return this.viewpoint < 0.5;
  }

  get clockBody(): ClockBody {
    return CLOCK_BODIES.find((b) => b.id === this.clockBodyId) ?? CLOCK_BODIES[0];
  }

  /** Altitude de l'horloge haute au-dessus de la surface (m). */
  get clockAltitude(): number {
    return sliderToAltitude(this.clockSlider, this.clockBody);
  }

  /** Même objet tant que rien n'a changé : le gabarit le lit par « *ngIf … as ». */
  get clockReadout(): ClockReadout {
    const dayUnit: string = this.translate.instant('ESPACE_TEMPS.UNIT_DAY');
    const key = `${this.clockBodyId}|${this.clockSlider}|${this.clockOrbiting}|${this.clockDays}|${dayUnit}`;
    if (!this.clockReadoutCache || this.clockReadoutKey !== key) {
      this.clockReadoutKey = key;
      this.clockReadoutCache = this.buildClockReadout(dayUnit);
    }
    return this.clockReadoutCache;
  }

  private buildClockReadout(dayUnit: string): ClockReadout {
    const body = this.clockBody;
    const rs = schwarzschildRadius(body.gm);
    const r = body.radius + this.clockAltitude;
    const drift = clockDrift(rs, body.radius, r, this.clockOrbiting);
    const gap = drift.total * this.clockDays * DAY_S;
    return {
      altitude: formatDistance(this.clockAltitude),
      speed: this.clockOrbiting ? formatSpeed(orbitalSpeed(rs, r)) : '',
      effectAltitude: formatDuration(drift.altitude * DAY_S, dayUnit, true),
      effectSpeed: formatDuration(drift.speed * DAY_S, dayUnit, true),
      effectTotal: formatDuration(drift.total * DAY_S, dayUnit, true),
      days: `${Math.floor(this.clockDays)}\u00a0${dayUnit}`,
      gap: formatDuration(Math.abs(gap), dayUnit, false),
      gapKey: gap >= 0 ? 'ESPACE_TEMPS.GAP_AHEAD' : 'ESPACE_TEMPS.GAP_BEHIND',
      positionError: body.id === 'earth' ? formatDistance(LIGHT_SPEED_M_S * Math.abs(gap)) : ''
    };
  }

  isClockPresetActive(preset: ClockPreset): boolean {
    return Math.abs(this.clockSlider - altitudeToSlider(preset.altitude, this.clockBody)) < 1e-6;
  }

  get lightHasMass(): boolean {
    return lightEffectiveRs(this.lightRs) > 0;
  }

  get lightIsBlackHole(): boolean {
    return isBlackHole(this.lightRs);
  }

  get lightStateKey(): string {
    if (!this.lightHasMass) {
      return 'ESPACE_TEMPS.LIGHT_NO_MASS';
    }
    return this.lightIsBlackHole ? 'ESPACE_TEMPS.LIGHT_STATE_BH' : 'ESPACE_TEMPS.LIGHT_STATE_STAR';
  }

  /** Rayon de Schwarzschild en pourcentage du rayon de l'étoile. */
  get lightCompactnessPercent(): number {
    return (this.lightRs / LIGHT_STAR_RADIUS) * 100;
  }

  get lightCollapseCompactnessPercent(): number {
    return (LIGHT_COLLAPSE_RS / LIGHT_STAR_RADIUS) * 100;
  }

  /** Distance de visée du rayon suivi, en rayons de Schwarzschild. */
  get lightAimInRs(): number {
    return this.lightAim / this.lightRs;
  }

  /** Distance de visée, en rayons de Schwarzschild, sous laquelle le trou noir capture la lumière. */
  get lightCaptureInRs(): number {
    return criticalImpactParameter(1);
  }

  get lightDeflectionDegrees(): number {
    return (this.lightDeflectionResult.angle * 180) / Math.PI;
  }

  get ideaTitleKey(): string {
    return VIEW_TEXT[this.view].ideaTitle;
  }

  get ideaBodyKey(): string {
    return VIEW_TEXT[this.view].ideaBody;
  }

  get hintKey(): string {
    if (this.view === 'apple' && this.fromApple) {
      return 'ESPACE_TEMPS.HINT_APPLE_FREEFALL';
    }
    return VIEW_TEXT[this.view].hint;
  }

  get limitKey(): string {
    return VIEW_TEXT[this.view].limit;
  }

  /* ---------- Actions ---------- */

  setView(v: SpacetimeView): void {
    this.view = v;
    this.flatDirty = true;
    requestAnimationFrame(() => this.resize());
  }

  togglePlay(): void {
    this.playing = !this.playing;
    this.lastTs = 0;
  }

  onMassChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.massRs = Math.max(0, Math.min(RS_MAX, n));
    this.updateSurface();
  }

  onLaunchSpeedChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.launchSpeed = Math.max(0, Math.min(this.launchSpeedMax, n));
    this.relaunch();
  }

  setCircularOrbit(): void {
    this.launchSpeed = this.hasMass ? circularSpeed(LAUNCH_R, this.massRs) : 0;
    this.relaunch();
  }

  onShowNewtonChange(show: boolean): void {
    this.showNewton = show;
    this.relaunch();
  }

  relaunch(): void {
    this.planet = this.newOrbiter();
    this.ghost = this.newOrbiter();
    this.respawnAt = 0;
    this.planetStatus = 'orbit';
    this.planetDistance = LAUNCH_R;
    this.syncOrbiters();
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.camera.position.set(0, 104, 196);
    this.controls.target.set(0, -12, 0);
    this.controls.update();
  }

  onGravityChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.gravityG = Math.max(0, Math.min(this.gravityMax, n));
    this.appleT = Math.min(this.appleT, this.appleEndTime);
    this.appleHoldUntil = 0;
    this.flatDirty = true;
  }

  onViewpointChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.viewpointTarget = null;
    this.viewpoint = Math.max(0, Math.min(1, n));
    this.flatDirty = true;
  }

  goToViewpoint(target: 0 | 1): void {
    this.viewpointTarget = target;
  }

  restartApple(): void {
    this.appleT = 0;
    this.appleHoldUntil = 0;
    this.flatDirty = true;
  }

  onClockBodyChange(id: string): void {
    const altitude = this.clockAltitude;
    const previous = this.clockBody;
    this.clockBodyId = id;
    /* Même altitude en rayons de l'astre, pour que le schéma reste comparable. */
    this.clockSlider = altitudeToSlider((altitude / previous.radius) * this.clockBody.radius, this.clockBody);
    this.flatDirty = true;
  }

  onClockSliderChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.clockSlider = Math.max(0, Math.min(1, n));
    this.flatDirty = true;
  }

  setClockPreset(preset: ClockPreset): void {
    this.clockSlider = altitudeToSlider(preset.altitude, this.clockBody);
    this.flatDirty = true;
  }

  setClockOrbiting(orbiting: boolean): void {
    this.clockOrbiting = orbiting;
    this.flatDirty = true;
  }

  restartClocks(): void {
    this.clockDays = 0;
    this.flatDirty = true;
  }

  onLightRsChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.lightRs = Math.max(0, Math.min(LIGHT_RS_MAX, n));
    this.updateLightDeflection();
  }

  onLightAimChange(raw: number | string): void {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return;
    }
    this.lightAim = Math.max(LIGHT_AIM_MIN, Math.min(LIGHT_AIM_MAX, n));
    this.updateLightDeflection();
  }

  private updateLightDeflection(): void {
    this.lightDeflectionResult = lightDeflection(this.lightAim, lightEffectiveRs(this.lightRs), lightAbsorbRadius(this.lightRs));
    this.flatDirty = true;
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onFullscreenChange(): void {
    const shell = this.fsRoot?.nativeElement;
    this.fullscreen = !!shell && this.currentFullscreenElement() === shell;
    this.cdr.detectChanges();
    requestAnimationFrame(() => this.resize());
  }

  async toggleFullscreen(): Promise<void> {
    const shell = this.fsRoot?.nativeElement;
    if (!shell) {
      return;
    }
    try {
      if (this.currentFullscreenElement() === shell) {
        const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
        await (document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(document))?.();
      } else {
        const el = shell as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
        await (shell.requestFullscreen?.bind(shell) ?? el.webkitRequestFullscreen?.bind(shell))?.();
      }
    } catch {
      /* refusé par le navigateur ou l'iframe */
    }
  }

  private currentFullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  /* ---------- Boucle d'animation (hors zone Angular) ---------- */

  private readonly loop = (ts: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts;

    if (this.view === 'grid') {
      this.stepGrid(dt, ts);
      this.renderGrid();
    } else {
      if (this.view === 'apple') {
        this.stepApple(dt, ts);
      } else if (this.view === 'clocks') {
        this.stepClocks(dt);
      } else {
        this.stepLight(dt);
      }
      if (this.flatDirty) {
        this.flatDirty = false;
        this.drawFlat();
      }
    }

    if (this.readoutNow || (this.readoutDirty && ts - this.lastReadoutTs > READOUT_INTERVAL_MS)) {
      this.readoutNow = false;
      this.readoutDirty = false;
      this.lastReadoutTs = ts;
      this.cdr.detectChanges();
    }
  };

  private resize(): void {
    const wrap = this.wrapRef?.nativeElement;
    if (!wrap) {
      return;
    }
    const w = Math.max(200, wrap.clientWidth);
    const h = Math.max(200, wrap.clientHeight);
    if (this.renderer && this.camera) {
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.flatDirty = true;
  }

  /* ---------- Vue « grille » ---------- */

  private newOrbiter(): Orbiter {
    return {
      state: { r: LAUNCH_R, vr: 0, phi: 0 },
      h: LAUNCH_R * this.launchSpeed,
      alive: true,
      trailR: [],
      trailPhi: []
    };
  }

  private heightAt(r: number): number {
    return embeddingHeight(r, this.massRs, BODY_RADIUS) - this.edgeHeight;
  }

  private initThree(): void {
    const canvas = this.gridCanvasRef?.nativeElement;
    if (!canvas) {
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      this.webglError = true;
      this.cdr.detectChanges();
      return;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070f);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sunLight = new THREE.PointLight(0xfff1d0, 2.4, 0, 0);
    scene.add(sunLight);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4000);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.65;
    controls.minDistance = 30;
    controls.maxDistance = 520;
    this.controls = controls;
    this.resetCamera();

    scene.add(this.buildStarfield());

    const gridGeometry = this.buildGridGeometry();
    this.gridGeometry = gridGeometry;
    const grid = new THREE.LineSegments(
      gridGeometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })
    );
    grid.frustumCulled = false;
    scene.add(grid);

    const starColor = new THREE.Color(0xffc857);
    this.star = new THREE.Mesh(
      new THREE.SphereGeometry(BODY_RADIUS, 48, 32),
      new THREE.MeshStandardMaterial({ color: starColor, emissive: starColor, emissiveIntensity: 0.9, roughness: 0.6 })
    );
    scene.add(this.star);

    this.planetMesh = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_RADIUS, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x8fc1ff, emissive: 0x2f6fd0, emissiveIntensity: 0.6, roughness: 0.5 })
    );
    scene.add(this.planetMesh);

    this.ghostMesh = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_RADIUS * 0.8, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x6ee7a0, emissive: 0x1f8f55, emissiveIntensity: 0.5, roughness: 0.6 })
    );
    scene.add(this.ghostMesh);

    this.planetTrail = this.buildTrail(0xffffff, 0.95);
    this.ghostTrail = this.buildTrail(0x6ee7a0, 0.85);
    scene.add(this.planetTrail, this.ghostTrail);

    this.updateSurface();
    sunLight.position.copy(this.star.position);
  }

  private buildStarfield(): THREE.Points {
    const count = 500;
    const positions = new Float32Array(count * 3);
    let seed = 0xc0ffee;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const radius = 1200 + rnd() * 500;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = radius * s * Math.cos(a);
      positions[i * 3 + 1] = radius * u;
      positions[i * 3 + 2] = radius * s * Math.sin(a);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: 0xcfe0ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7 })
    );
    points.frustumCulled = false;
    return points;
  }

  /** Grille carrée posée sur la surface : x et z sont fixés ici, la hauteur et la couleur dans updateSurface. */
  private buildGridGeometry(): THREE.BufferGeometry {
    const vertexCount = 2 * GRID_LINES * GRID_SEGMENTS * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const lineGap = (2 * GRID_HALF) / (GRID_LINES - 1);
    const segLen = (2 * GRID_HALF) / GRID_SEGMENTS;
    let o = 0;
    for (let i = 0; i < GRID_LINES; i++) {
      const fixed = -GRID_HALF + i * lineGap;
      for (let j = 0; j < GRID_SEGMENTS; j++) {
        const a = -GRID_HALF + j * segLen;
        const b = a + segLen;
        positions[o] = fixed;
        positions[o + 2] = a;
        positions[o + 3] = fixed;
        positions[o + 5] = b;
        positions[o + 6] = a;
        positions[o + 8] = fixed;
        positions[o + 9] = b;
        positions[o + 11] = fixed;
        o += 12;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  private buildTrail(color: number, opacity: number): THREE.Line {
    const geometry = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attr);
    geometry.setDrawRange(0, 0);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
    line.frustumCulled = false;
    return line;
  }

  /** Recalcule la forme de la grille et sa couleur (ralentissement du temps) pour la masse courante. */
  private updateSurface(): void {
    this.edgeHeight = embeddingHeight(GRID_HALF, this.massRs, BODY_RADIUS);
    const geometry = this.gridGeometry;
    if (geometry) {
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
      const pos = posAttr.array as Float32Array;
      const col = colAttr.array as Float32Array;
      const c = this.scratchColor;
      for (let o = 0; o < pos.length; o += 3) {
        const r = Math.hypot(pos[o], pos[o + 2]);
        pos[o + 1] = this.heightAt(r);
        const slowdown = 1 - clockRate(r, this.massRs, BODY_RADIUS);
        const t = Math.sqrt(Math.min(1, Math.max(0, slowdown / SLOWDOWN_FULL_COLOR))) * (COLOR_STOPS.length - 1);
        const i = Math.min(COLOR_STOPS.length - 2, Math.floor(t));
        const f = t - i;
        const from = COLOR_STOPS[i];
        const to = COLOR_STOPS[i + 1];
        c.setRGB(
          from[0] + (to[0] - from[0]) * f,
          from[1] + (to[1] - from[1]) * f,
          from[2] + (to[2] - from[2]) * f,
          THREE.SRGBColorSpace
        );
        col[o] = c.r;
        col[o + 1] = c.g;
        col[o + 2] = c.b;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }
    if (this.star) {
      this.star.visible = this.hasMass;
      this.star.position.set(0, this.heightAt(BODY_RADIUS), 0);
    }
    this.syncOrbiters();
  }

  private stepGrid(dt: number, ts: number): void {
    if (!this.playing) {
      return;
    }
    if (this.respawnAt) {
      if (ts >= this.respawnAt) {
        this.relaunch();
        this.readoutNow = true;
      }
      return;
    }
    const m = this.massRs / 2;
    const floor = this.hasMass ? BODY_RADIUS : 0.5;
    let remaining = dt * SIM_RATE;
    while (remaining > 1e-9) {
      const step = Math.min(SIM_STEP, remaining);
      remaining -= step;

      if (this.ghost.alive) {
        this.ghost.state = stepOrbit(this.ghost.state, this.ghost.h, m, step, false);
        const gr = this.ghost.state.r;
        if (!Number.isFinite(gr) || gr <= floor || gr >= ESCAPE_R) {
          this.ghost.alive = false;
        }
      }

      this.planet.state = stepOrbit(this.planet.state, this.planet.h, m, step, true);
      const r = this.planet.state.r;
      if (!Number.isFinite(r) || r <= floor) {
        this.endFlight('impact', ts);
        break;
      }
      if (r >= ESCAPE_R) {
        this.endFlight('escaped', ts);
        break;
      }
    }
    this.pushTrail(this.planet);
    if (this.ghost.alive) {
      this.pushTrail(this.ghost);
    }
    if (Number.isFinite(this.planet.state.r)) {
      this.planetDistance = this.planet.state.r;
    }
    this.readoutDirty = true;
    this.syncOrbiters();
  }

  private endFlight(status: PlanetStatus, ts: number): void {
    this.planetStatus = status;
    this.respawnAt = ts + RESPAWN_MS;
    this.readoutNow = true;
  }

  private pushTrail(o: Orbiter): void {
    if (!Number.isFinite(o.state.r)) {
      return;
    }
    o.trailR.push(o.state.r);
    o.trailPhi.push(o.state.phi);
    if (o.trailR.length > TRAIL_MAX) {
      o.trailR.shift();
      o.trailPhi.shift();
    }
  }

  /** Place les sphères et les traînées sur la surface courante. */
  private syncOrbiters(): void {
    this.placeOrbiter(this.planetMesh, this.planetTrail, this.planet, this.planetStatus !== 'impact', PLANET_RADIUS * 0.7);
    this.placeOrbiter(this.ghostMesh, this.ghostTrail, this.ghost, this.showNewton && this.ghost.alive, PLANET_RADIUS * 0.55);
    if (this.ghostTrail) {
      this.ghostTrail.visible = this.showNewton;
    }
  }

  private placeOrbiter(mesh: THREE.Mesh | undefined, trail: THREE.Line | undefined, o: Orbiter, visible: boolean, lift: number): void {
    if (mesh) {
      const r = Number.isFinite(o.state.r) ? Math.max(o.state.r, 0) : 0;
      mesh.visible = visible;
      mesh.position.set(r * Math.cos(o.state.phi), this.heightAt(r) + lift, r * Math.sin(o.state.phi));
    }
    if (trail) {
      const attr = trail.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const n = o.trailR.length;
      for (let i = 0; i < n; i++) {
        const r = o.trailR[i];
        const phi = o.trailPhi[i];
        arr[i * 3] = r * Math.cos(phi);
        arr[i * 3 + 1] = this.heightAt(r) + 0.3;
        arr[i * 3 + 2] = r * Math.sin(phi);
      }
      trail.geometry.setDrawRange(0, n);
      attr.needsUpdate = true;
    }
  }

  private renderGrid(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  private disposeThree(): void {
    this.controls?.dispose();
    this.controls = undefined;
    if (this.scene) {
      this.scene.traverse((obj: THREE.Object3D) => {
        const o = obj as THREE.Mesh & {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        o.geometry?.dispose();
        const mat = o.material;
        if (!mat) {
          return;
        }
        if (Array.isArray(mat)) {
          mat.forEach((m) => m.dispose());
        } else {
          mat.dispose();
        }
      });
      this.scene.clear();
    }
    this.scene = undefined;
    this.gridGeometry = undefined;
    this.star = undefined;
    this.planetMesh = undefined;
    this.ghostMesh = undefined;
    this.planetTrail = undefined;
    this.ghostTrail = undefined;
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = undefined;
    this.camera = undefined;
  }

  /* ---------- Vues dessinées en 2D (pomme, horloges, lumière) ---------- */

  /** Ajuste le canevas 2D à son conteneur et l'efface ; rend le contexte en pixels CSS. */
  private prepareFlatCanvas(): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const canvas = this.flatCanvasRef?.nativeElement;
    const wrap = this.wrapRef?.nativeElement;
    if (!canvas || !wrap) {
      return null;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, wrap.clientWidth);
    const h = Math.max(200, wrap.clientHeight);
    const pxW = Math.round(w * dpr);
    const pxH = Math.round(h * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);
    return { ctx, w, h };
  }

  private drawFlat(): void {
    const target = this.prepareFlatCanvas();
    if (!target) {
      return;
    }
    const { ctx, w, h } = target;
    const tr = (key: string, params?: Record<string, string>): string => this.translate.instant(key, params);
    switch (this.view) {
      case 'apple':
        this.drawApple(ctx, w, h);
        break;
      case 'clocks': {
        const readout = this.clockReadout;
        drawClocksView(
          ctx,
          w,
          h,
          { body: this.clockBody, slider: this.clockSlider, orbiting: this.clockOrbiting, satAngle: this.satAngle },
          {
            ground: tr('ESPACE_TEMPS.LBL_GROUND_CLOCK'),
            high: tr('ESPACE_TEMPS.LBL_HIGH_CLOCK'),
            altitudeEffect: tr('ESPACE_TEMPS.LEGEND_ALTITUDE'),
            speedEffect: tr('ESPACE_TEMPS.LEGEND_SPEED'),
            total: tr('ESPACE_TEMPS.LEGEND_TOTAL'),
            axisAltitude: tr('ESPACE_TEMPS.AXIS_ALTITUDE'),
            axisDrift: tr('ESPACE_TEMPS.AXIS_DRIFT'),
            captionGround: tr('ESPACE_TEMPS.CAPTION_GROUND', { days: readout.days }),
            captionGap: tr(readout.gapKey, { value: readout.gap }),
            dayUnit: tr('ESPACE_TEMPS.UNIT_DAY')
          }
        );
        break;
      }
      case 'light':
        drawLightView(
          ctx,
          w,
          h,
          { rs: this.lightRs, aim: this.lightAim, time: this.lightTime },
          { horizon: tr('ESPACE_TEMPS.LBL_HORIZON'), photonSphere: tr('ESPACE_TEMPS.LBL_PHOTON_SPHERE') },
          this.lightRays
        );
        break;
      default:
        break;
    }
  }

  private stepClocks(dt: number): void {
    if (!this.playing) {
      return;
    }
    this.clockDays += dt * CLOCK_DAYS_PER_S;
    if (this.clockOrbiting) {
      /* Décoratif mais fidèle à la tendance : plus l'orbite est haute, plus elle est lente. */
      const radii = 1 + this.clockAltitude / this.clockBody.radius;
      this.satAngle += dt * Math.max(0.3, 1.5 * Math.pow(radii, -1.5));
    }
    this.flatDirty = true;
    this.readoutDirty = true;
  }

  private stepLight(dt: number): void {
    if (!this.playing) {
      return;
    }
    this.lightTime += dt * LIGHT_ANIM_RATE;
    this.flatDirty = true;
  }

  private stepApple(dt: number, ts: number): void {
    if (this.viewpointTarget !== null) {
      const gap = this.viewpointTarget - this.viewpoint;
      const maxStep = dt / VIEWPOINT_TWEEN_S;
      if (Math.abs(gap) <= maxStep) {
        this.viewpoint = this.viewpointTarget;
        this.viewpointTarget = null;
      } else {
        this.viewpoint += Math.sign(gap) * maxStep;
      }
      this.flatDirty = true;
      this.readoutNow = true;
    }
    if (!this.playing) {
      return;
    }
    const end = this.appleEndTime;
    if (this.appleT >= end) {
      if (!this.appleHoldUntil) {
        this.appleHoldUntil = ts + APPLE_HOLD_MS;
      } else if (ts >= this.appleHoldUntil) {
        this.restartApple();
        this.readoutDirty = true;
      }
      return;
    }
    this.appleT = Math.min(end, this.appleT + dt * APPLE_RATE);
    this.flatDirty = true;
    this.readoutDirty = true;
  }

  private drawApple(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const padL = 54;
    const padR = 14;
    const padT = 14;
    const padB = 40;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const bottom = padT + plotH;
    const g = this.gravity;
    const s = this.viewpoint;
    const tNow = this.appleT;
    const tEnd = this.appleEndTime;
    const tr = (key: string): string => this.translate.instant(key);

    const px = (time: number): number => padL + (time / APPLE_T_WINDOW) * plotW;
    const py = (height: number): number => padT + ((APPLE_H_MAX - height) / (APPLE_H_MAX - APPLE_H_MIN)) * plotH;
    /** Position à l'écran d'un événement repéré par le sol, pour le point de vue courant. */
    const at = (t: number, z: number): { x: number; y: number } => {
      const f = groundFrameToFreeFall(g, t, z);
      return { x: px(f.time + (t - f.time) * s), y: py(f.height + (z - f.height) * s) };
    };
    const traceHeight = (z: number, tMax: number): void => {
      const n = 64;
      for (let i = 0; i <= n; i++) {
        const p = at((tMax * i) / n, z);
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
    };
    const traceApple = (tMax: number): void => {
      const n = 64;
      for (let i = 0; i <= n; i++) {
        const t = (tMax * i) / n;
        const p = at(t, appleHeight(g, t, APPLE_Z0));
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
    };
    const dot = (p: { x: number; y: number }, radius: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();

    /* Sol : tout ce qui est sous la ligne z = 0. */
    ctx.beginPath();
    traceHeight(0, APPLE_T_GRID);
    ctx.lineTo(at(APPLE_T_GRID, 0).x, bottom + 2);
    ctx.lineTo(padL, bottom + 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(96, 70, 44, 0.6)';
    ctx.fill();

    /* Grille du sol : hauteurs constantes et « mêmes instants ». */
    ctx.strokeStyle = 'rgba(126, 200, 255, 0.32)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 9; i++) {
      ctx.beginPath();
      traceHeight(i * 0.1, APPLE_T_GRID);
      ctx.stroke();
    }
    for (let i = 1; i <= 8; i++) {
      const a = at(i * 0.2, 0);
      const b = at(i * 0.2, 1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    traceHeight(APPLE_Z0, APPLE_T_GRID);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#c9a36a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    traceHeight(0, APPLE_T_GRID);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 107, 107, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    traceApple(tEnd);
    ctx.stroke();
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    traceApple(tNow);
    ctx.stroke();

    /* Instant courant, tel que le sol le définit. */
    const nowLow = at(tNow, 0);
    const nowHigh = at(tNow, 1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(nowLow.x, nowLow.y);
    ctx.lineTo(nowHigh.x, nowHigh.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const groundNow = at(tNow, 0);
    const shelfNow = at(tNow, APPLE_Z0);
    const appleNow = at(tNow, appleHeight(g, tNow, APPLE_Z0));
    dot(groundNow, 5, '#c9a36a');
    dot(shelfNow, 5, '#ffd27a');
    dot(appleNow, 7, '#ff5252');

    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'alphabetic';
    const shelfLabel = at(0.05, APPLE_Z0);
    const groundLabel = at(0.05, 0);
    ctx.fillStyle = '#ffd27a';
    ctx.fillText(tr('ESPACE_TEMPS.LBL_SHELF'), shelfLabel.x, shelfLabel.y - 8);
    ctx.fillStyle = '#e3c595';
    ctx.fillText(tr('ESPACE_TEMPS.LBL_GROUND'), groundLabel.x, groundLabel.y + 17);
    ctx.fillStyle = '#ff9c9c';
    ctx.fillText(tr('ESPACE_TEMPS.LBL_APPLE'), appleNow.x + 11, appleNow.y + 16);

    ctx.fillStyle = 'rgba(232, 244, 255, 0.85)';
    ctx.fillText(tr(this.fromApple ? 'ESPACE_TEMPS.VIEW_FROM_APPLE' : 'ESPACE_TEMPS.VIEW_FROM_GROUND'), padL + 10, padT + 18);
    ctx.restore();

    /* Axes ; les graduations ne sont exactes qu'aux deux points de vue extrêmes, elles s'effacent entre les deux. */
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT);
    ctx.lineTo(padL + 0.5, bottom + 0.5);
    ctx.lineTo(padL + plotW, bottom + 0.5);
    ctx.stroke();

    const tickAlpha = Math.pow(Math.abs(2 * s - 1), 2);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = `rgba(200, 214, 236, ${(0.9 * tickAlpha).toFixed(3)})`;
    ctx.textAlign = 'center';
    for (const t of [0, 0.4, 0.8, 1.2, 1.6]) {
      ctx.fillText(String(t), px(t), bottom + 14);
    }
    ctx.textAlign = 'right';
    for (const z of [0, 0.2, 0.4, 0.6, 0.8]) {
      ctx.fillText(String(z), padL - 6, py(z) + 4);
    }

    ctx.fillStyle = '#c8d6ec';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(tr('ESPACE_TEMPS.AXIS_TIME'), padL + plotW / 2, bottom + 32);
    ctx.save();
    ctx.translate(14, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(tr('ESPACE_TEMPS.AXIS_HEIGHT'), 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
  }
}
