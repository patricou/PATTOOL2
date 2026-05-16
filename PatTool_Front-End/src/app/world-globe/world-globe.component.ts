import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subscription, firstValueFrom, timeout } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { ApiService } from '../services/api.service';
import { EvenementsService, StreamedEvent } from '../services/evenements.service';
import { FileService } from '../services/file.service';
import { MembersService } from '../services/members.service';
import { Evenement } from '../model/evenement';
import { UploadedFile } from '../model/uploadedfile';
import { parseTrackFileToLatLonPoints } from '../photo-timeline/track-route-stats.util';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { environment } from '../../environments/environment';
import { Body, GeoVector, VectorObserver } from 'astronomy-engine';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';

/** Ligne utilisée après chargement SSE : sélection puis affichage trace / géocode. */
export interface GlobeActivityPickerRow {
  readonly event: Evenement;
  selected: boolean;
  readonly trackFiles: UploadedFile[];
}

/** Plus de subdivisions pour des courbes lisibles très zoomées (sans tuiles HR). */
const GLOBE_EARTH_SEGMENTS = 256;
const GLOBE_CLOUDS_SEGMENTS = 192;

const GLOBE_OVERLAY_SEGMENTS = 192;
/** Vue par défaut : France métropolitaine (centroïde approximatif). */
const GLOBE_INITIAL_FRANCE_LAT = 46.4;
const GLOBE_INITIAL_FRANCE_LON = 2.2;
const GLOBE_INITIAL_ORBIT_DISTANCE = 2.62;
/** Distance caméra : fallback si pas de bbox Nominatim. */
const GLOBE_GEOCODE_ORBIT_FALLBACK = 1.3;
/** Zoom « ville » (petite bbox, en degrés). */
const GLOBE_GEOCODE_ORBIT_MIN = 1.06;
/** Zoom « grand pays / région » (bbox large). */
const GLOBE_GEOCODE_ORBIT_MAX = 3.02;
/** Étendue angulaire min/max (°) pour interpoler entre ORBIT_MIN et ORBIT_MAX. */
const GLOBE_GEOCODE_SPAN_REF_LO = 0.04;
const GLOBE_GEOCODE_SPAN_REF_HI = 36;
/** Durée du vol caméra après recherche de lieu (arc de grand cercle). */
const GLOBE_GEOCODE_ANIM_MS = 1700;

/** Sphère repère géocodage : rayon monde, légèrement au-dessus du maillage Terre (rayon 1). */
const GLOBE_GEOCODE_MARKER_SURFACE_OFFSET = 1.003;
const GLOBE_GEOCODE_MARKER_RADIUS = 0.006;

/** Multiplicateur d’éclairage utilisateur (potentiomètre) ; ×1 = réglage de base du mode actif. */
const GLOBE_LIGHTING_BOOST_DEFAULT = 1;
const GLOBE_LIGHTING_BOOST_MIN = 0.48;
const GLOBE_LIGHTING_BOOST_MAX = 2.08;

/** À zoom fort (caméra proche), rotation / panoramique / molette trop nerveux sans ce facteur. */
const ORBIT_SENS_U_MIN_ROTATE_PAN = 0.13;
const ORBIT_SENS_U_MIN_ZOOM = 0.48;

function globePixelRatioCap(): number {
  return Math.min(window.devicePixelRatio, 3);
}

@Component({
  selector: 'app-world-globe',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './world-globe.component.html',
  styleUrls: ['./world-globe.component.css'],
  providers: [EvenementsService]
})
export class WorldGlobeComponent implements AfterViewInit, OnDestroy {
  private readonly apiService = inject(ApiService);
  private readonly evenementsService = inject(EvenementsService);
  private readonly fileService = inject(FileService);
  private readonly membersService = inject(MembersService);
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('globeCanvasHost') globeCanvasHost?: ElementRef<HTMLElement>;
  @ViewChild('globeShell') globeShell?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceMount') globeTraceMount?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceViewer') globeTraceViewer?: TraceViewerModalComponent;

  showOptionsPanel = true;
  cloudsEnabled = false;
  starsEnabled = true;
  autoRotate = false;
  /** Fond pseudo-satellite (NASA BMNG) vs texture Three.js classique avec relief/spec ; BMNG activé par défaut. */
  basemapSatellite = true;
  /** Couche indicative type « météo » : précipitations estimées (NASA GIBS, dernier jour UTC). */
  weatherImageryEnabled = false;
  weatherImageryLoading = false;
  weatherImageryFailed = false;
  /** Points + polyligne d’activités géocodées. */
  activityLayerVisible = false;
  /** Éclairage uniforme sur tout le globe (ambiance + hémisphère). Coupé tant que le jour/nuit réel est actif. */
  globeLightingUniform = false;
  /**
   * Terminateur jour/nuit selon la position réelle du Soleil (horloge du navigateur / UTC).
   * Prioritaire sur l’éclairage uniforme lorsqu’il est activé ; activé par défaut.
   */
  realTimeTerminator = true;

  /**
   * Intensité globale des lumières et de l’exposition tone-mapping (curseur latéral).
   * @see GLOBE_LIGHTING_BOOST_DEFAULT
   */
  globeLightingBoost = GLOBE_LIGHTING_BOOST_DEFAULT;

  readonly globeLightingBoostMin = GLOBE_LIGHTING_BOOST_MIN;
  readonly globeLightingBoostMax = GLOBE_LIGHTING_BOOST_MAX;

  /** Terre visible (rayon / clic carte OSM disponible). */
  globeSurfaceReady = false;
  /**
   * Dernier clic sur la surface Terre : position « courante » pour la carte 2D et affichage des coordonnées.
   */
  globePickedLat: number | null = null;
  globePickedLon: number | null = null;
  /** Panneau Trace Viewer — mêmes dimensions que depuis le slideshow (65vw × max 90vh), centré. */
  detailMapOpen = false;
  detailMapPickFailed = false;
  fullscreen = false;
  textureLoadError = false;

  activitiesLoading = false;
  activitiesPlaced = 0;
  activitiesSkipped = 0;
  activitiesBanner: 'idle' | 'loading' | 'done' | 'none' | 'login' | 'error' = 'idle';
  /** Après réception du flux : liste à cocher avant dessin sur le globe. */
  activitiesPickerOpen = false;
  globeActivityPickerRows: GlobeActivityPickerRow[] = [];
  applyingGlobeActivities = false;

  /** Recherche de lieu (Nominatim via backend), comme la page Adresse / GPS. */
  globePlaceQuery = '';
  globeGeocodeLoading = false;
  globeGeocodeError = '';
  globeGeocodeResults: Array<{
    lat: number;
    lon: number;
    displayName: string;
    boundingBox: number[] | null;
  }> = [];
  /** Repère visuel géocodage : même lat/lon que le vol caméra tant que l’utilisateur ne clique pas ailleurs sur la Terre. */
  globeGeocodeMarkerLat: number | null = null;
  globeGeocodeMarkerLon: number | null = null;

  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private earthMesh?: THREE.Mesh;
  /** Point rouge au sol (résultat géocode ville / pays). */
  private geocodeMarkerMesh?: THREE.Mesh;
  /** Textures utilisées dans le fond « carte » avant bascule satellite. */
  private standardEarthTextures: {
    readonly map: THREE.Texture;
    spec: THREE.Texture | null;
    bump: THREE.Texture | null;
  } | null = null;
  private satelliteTexture: THREE.Texture | null = null;
  private cloudsMesh?: THREE.Mesh;
  private starsPoints?: THREE.Points;
  private weatherOverlayMesh?: THREE.Mesh;
  private weatherOverlayTexture: THREE.Texture | null = null;
  private activityRoot?: THREE.Group;
  private ambientLight?: THREE.AmbientLight;
  private hemisphereLight?: THREE.HemisphereLight;
  private sunLight?: THREE.DirectionalLight;
  /** Distance fictive du soleil directionnel (rayons quasi parallèles). */
  private static readonly SUN_LIGHT_DISTANCE = 50;

  private rafId: number | null = null;
  private resizeObs?: ResizeObserver;
  /** Rotation lente nuages vs sol (effet léger façon couches atmosphériques). */
  private cloudsDriftRad = 0;
  private eventsStreamSub?: Subscription;
  private activitiesStreamFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Vol caméra programmatique (géocodage) : annulation au destroy ou nouvelle cible. */
  private globeCameraAnimFrameId: number | null = null;
  private globeCameraAnimPrevDamping: boolean | null = null;

  private pendingDetailLat = 0;
  private pendingDetailLon = 0;
  private pendingDetailZoom = 8;

  private readonly raycasterNd = new THREE.Raycaster();
  private readonly ndcCenter = new THREE.Vector2(0, 0);
  private readonly ndcPointer = new THREE.Vector2();
  private readonly earthInvScratch = new THREE.Matrix4();
  private readonly localScratch = new THREE.Vector3();
  /** Direction sous-point solaire dans le repère monde (pour la directionnelle jour/nuit). */
  private readonly subsolarWorldScratch = new THREE.Vector3();
  /** Position monde du point rouge géocode (suit la Terre). */
  private readonly geocodeMarkerWorldScratch = new THREE.Vector3();

  /** Pas un glissement d’orbit : clic court vs drag OrbitControls. */
  private static readonly GLOBE_PICK_DRAG_THRESHOLD_PX = 8;
  /** Curseur « croix rouge » après clic sur la Terre (data URI SVG). */
  private static readonly GLOBE_PICK_CROSS_CURSOR = ((): string => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
      '<path stroke="#e53935" stroke-width="3" stroke-linecap="round" d="M14 5v18M5 14h18"/></svg>';
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") 14 14, crosshair`;
  })();

  private globePickPointerDown: { x: number; y: number; id: number } | null = null;
  /** Identifiant du timer navigateur (évite TS node DOM : number vs Timeout). */
  private globePickCursorResetTimer: number | null = null;

  private readonly onGlobePointerDown = (ev: PointerEvent): void => {
    if (this.detailMapOpen || !this.globeSurfaceReady) {
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
      return;
    }
    this.globePickPointerDown = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
  };

  private readonly onGlobePointerUp = (ev: PointerEvent): void => {
    const start = this.globePickPointerDown;
    this.globePickPointerDown = null;
    if (this.detailMapOpen || !this.globeSurfaceReady || !start || start.id !== ev.pointerId) {
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
      return;
    }
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (dx * dx + dy * dy > WorldGlobeComponent.GLOBE_PICK_DRAG_THRESHOLD_PX ** 2) {
      return;
    }
    const pick = this.pickGlobeAtClient(ev.clientX, ev.clientY);
    if (!pick) {
      return;
    }
    this.globePickedLat = pick.lat;
    this.globePickedLon = pick.lon;
    this.clearGeocodeMarker();
    if (ev.pointerType === 'mouse') {
      this.flashGlobePickCrossCursor();
    }
    this.cdr.markForCheck();
  };

  private readonly onGlobePointerCancel = (ev: PointerEvent): void => {
    if (this.globePickPointerDown?.id === ev.pointerId) {
      this.globePickPointerDown = null;
    }
  };

  ngAfterViewInit(): void {
    queueMicrotask(() => this.bootstrapThree());
  }

  ngOnDestroy(): void {
    this.globeTraceViewer?.close();
    this.stopGlobeCameraAnimation();
    if (this.globePickCursorResetTimer != null) {
      clearTimeout(this.globePickCursorResetTimer);
      this.globePickCursorResetTimer = null;
    }
    this.globeSurfaceReady = false;
    if (this.activitiesStreamFinalizeTimer != null) {
      clearTimeout(this.activitiesStreamFinalizeTimer);
      this.activitiesStreamFinalizeTimer = null;
    }
    this.eventsStreamSub?.unsubscribe();
    this.disposeWeatherOverlayMesh();
    this.stopLoop();
    this.disposeGeocodeMarkerMesh();
    this.resizeObs?.disconnect();
    const canvasUnd = this.renderer?.domElement;
    if (canvasUnd) {
      canvasUnd.style.cursor = '';
      canvasUnd.removeEventListener('pointerdown', this.onGlobePointerDown);
      canvasUnd.removeEventListener('pointerup', this.onGlobePointerUp);
      canvasUnd.removeEventListener('pointercancel', this.onGlobePointerCancel);
    }
    this.controls?.dispose();
    const canvas = this.renderer?.domElement;
    if (canvas?.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    this.disposeSceneHierarchy();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.controls = undefined;
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  @HostListener('document:MSFullscreenChange')
  onFullscreenDoc(): void {
    this.syncFullscreenFromDocument();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.resizeRendererToHost();
    if (this.detailMapOpen) {
      this.globeTraceViewer?.refreshMapLayout();
    }
  }

  openDetailMapOverlay(): void {
    if (!this.globeSurfaceReady || !this.earthMesh || !this.camera || !this.renderer) {
      return;
    }
    if (this.detailMapOpen) {
      return;
    }
    const pick = this.pickDetailMapAnchorLatLon();
    if (!pick) {
      this.detailMapPickFailed = true;
      this.cdr.markForCheck();
      window.setTimeout(() => {
        this.detailMapPickFailed = false;
        this.cdr.markForCheck();
      }, 3800);
      return;
    }
    const dist = this.controls?.getDistance() ?? 3;
    this.pendingDetailLat = pick.lat;
    this.pendingDetailLon = pick.lon;
    this.pendingDetailZoom = WorldGlobeComponent.leafletZoomForOrbitDistance(dist);
    this.detailMapOpen = true;
    this.cdr.markForCheck();
    queueMicrotask(() => {
      requestAnimationFrame(() => this.mountGlobeTraceViewer());
    });
  }

  closeDetailMapOverlay(): void {
    this.globeTraceViewer?.close();
  }

  onGlobeTraceViewerClosed(): void {
    this.detailMapOpen = false;
    const host = this.globeTraceMount?.nativeElement;
    if (host?.childNodes?.length) {
      host.innerHTML = '';
    }
    this.cdr.markForCheck();
  }

  private mountGlobeTraceViewer(): void {
    const host = this.globeTraceMount?.nativeElement;
    const viewer = this.globeTraceViewer;
    if (!host || !viewer || !this.detailMapOpen) {
      return;
    }
    viewer.openAtLocationEmbedded(host, this.pendingDetailLat, this.pendingDetailLon, {
      locationZoom: Math.round(this.pendingDetailZoom),
      initialBaseLayerId: 'osm-standard'
    });
    window.setTimeout(() => viewer.refreshMapLayout(), 350);
    window.setTimeout(() => viewer.refreshMapLayout(), 900);
  }

  /** Carte détaillée : point cliqué s’il existe, sinon centre de la vue. */
  private pickDetailMapAnchorLatLon(): { lat: number; lon: number } | null {
    if (
      this.globePickedLat != null &&
      this.globePickedLon != null &&
      Number.isFinite(this.globePickedLat) &&
      Number.isFinite(this.globePickedLon)
    ) {
      return { lat: this.globePickedLat, lon: this.globePickedLon };
    }
    return this.pickGlobeCenterLatLon();
  }

  /** Rayon au centre du canvas → intersect Terre → lat/lon. */
  private pickGlobeCenterLatLon(): { lat: number; lon: number } | null {
    if (!this.camera || !this.renderer || !this.earthMesh) {
      return null;
    }
    const canvas = this.renderer.domElement;
    if (canvas.clientWidth < 2 || canvas.clientHeight < 2) {
      return null;
    }
    this.ndcCenter.set(0, 0);
    this.raycasterNd.setFromCamera(this.ndcCenter, this.camera);
    return this.pickFromRayEarthIntersections(this.raycasterNd.intersectObject(this.earthMesh, false));
  }

  /** Clic à l’écran → intersect Terre → lat/lon. */
  private pickGlobeAtClient(clientX: number, clientY: number): { lat: number; lon: number } | null {
    if (!this.camera || !this.renderer || !this.earthMesh) {
      return null;
    }
    const canvasEl = this.renderer.domElement;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return null;
    }
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.ndcPointer.set(nx, ny);
    this.raycasterNd.setFromCamera(this.ndcPointer, this.camera);
    return this.pickFromRayEarthIntersections(this.raycasterNd.intersectObject(this.earthMesh, false));
  }

  private pickFromRayEarthIntersections(
    hits: THREE.Intersection[]
  ): { lat: number; lon: number } | null {
    if (!this.earthMesh || !hits.length) {
      return null;
    }
    const geo = WorldGlobeComponent.worldGlobeHitToLatLon(
      hits[0].point,
      this.earthMesh,
      this.earthInvScratch,
      this.localScratch
    );
    return { lat: geo.lat, lon: geo.lon };
  }

  /** Feedback visuel au lieu de l’épingle 3D : croix rouge sur le canvas pendant 1 s. */
  private flashGlobePickCrossCursor(): void {
    const canvas = this.renderer?.domElement;
    if (!canvas) {
      return;
    }
    if (this.globePickCursorResetTimer != null) {
      clearTimeout(this.globePickCursorResetTimer);
      this.globePickCursorResetTimer = null;
    }
    canvas.style.cursor = WorldGlobeComponent.GLOBE_PICK_CROSS_CURSOR;
    this.globePickCursorResetTimer = window.setTimeout(() => {
      this.globePickCursorResetTimer = null;
      const el = this.renderer?.domElement;
      if (el) {
        el.style.cursor = '';
      }
    }, 1000);
  }

  /** Repère géographique cohérent avec latLonToVector3 et la rotation du maillage Terre. */
  private static worldGlobeHitToLatLon(
    worldPt: THREE.Vector3,
    earthMesh: THREE.Mesh,
    invMw: THREE.Matrix4,
    local: THREE.Vector3
  ): { lat: number; lon: number } {
    invMw.copy(earthMesh.matrixWorld).invert();
    local.copy(worldPt).applyMatrix4(invMw).normalize();
    const phi = Math.acos(THREE.MathUtils.clamp(local.y, -1, 1));
    const latDeg = 90 - THREE.MathUtils.radToDeg(phi);
    const theta = Math.atan2(local.z, -local.x);
    let lonDeg = THREE.MathUtils.radToDeg(theta) - 180;
    lonDeg = THREE.MathUtils.euclideanModulo(lonDeg + 180, 360) - 180;
    return { lat: latDeg, lon: lonDeg };
  }

  /** Zoom Leaflet corrélé à la proximité de la caméra sur le globe (plus on est près, plus la carte zoome). */
  private static leafletZoomForOrbitDistance(orbitDist: number): number {
    const margin = Math.max(orbitDist - 1, 0.015);
    const raw = 16.35 - Math.log(margin * 88) / Math.LN2;
    return THREE.MathUtils.clamp(Math.round(raw * 4) / 4, 3, 17);
  }

  toggleFullscreen(): void {
    const shell = this.globeShell?.nativeElement;
    if (!shell) {
      return;
    }
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      msFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void>;
      msExitFullscreen?: () => Promise<void>;
    };
    const fsEl =
      document.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
    if (fsEl === shell) {
      void (
        document.exitFullscreen?.bind(document) ??
        doc.webkitExitFullscreen?.bind(document) ??
        doc.msExitFullscreen?.bind(document)
      )?.();
    } else {
      void (
        shell.requestFullscreen?.bind(shell) ??
        (
          shell as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void> | void;
            msRequestFullscreen?: () => Promise<void> | void;
          }
        ).webkitRequestFullscreen?.bind(shell) ??
        (
          shell as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void> | void;
            msRequestFullscreen?: () => Promise<void> | void;
          }
        ).msRequestFullscreen?.bind(shell)
      )?.();
    }
    this.syncFullscreenFromDocument();
    requestAnimationFrame(() => this.resizeRendererToHost());
  }

  toggleOptionsPanel(): void {
    this.showOptionsPanel = !this.showOptionsPanel;
    requestAnimationFrame(() => this.resizeRendererToHost());
  }

  onCloudsToggle(): void {
    if (this.cloudsMesh) {
      this.cloudsMesh.visible = this.cloudsEnabled;
    }
  }

  onGlobeLightingToggle(): void {
    if (this.globeLightingUniform) {
      this.realTimeTerminator = false;
    }
    this.syncGlobeLighting();
  }

  onRealTimeTerminatorToggle(): void {
    if (this.realTimeTerminator) {
      this.globeLightingUniform = false;
    } else {
      this.globeLightingUniform = true;
    }
    this.syncGlobeLighting();
    this.cdr.markForCheck();
  }

  onStarsToggle(enabled: boolean): void {
    if (this.starsPoints) {
      this.starsPoints.visible = enabled;
    }
    this.cdr.markForCheck();
  }

  onBasemapChange(): void {
    this.applyBasemapMode();
  }

  onWeatherImageryToggle(): void {
    if (this.weatherImageryEnabled) {
      this.ensureWeatherOverlayTexture();
    } else {
      this.disposeWeatherOverlayMesh();
    }
  }

  onActivityLayerToggle(): void {
    if (this.activityRoot) {
      this.activityRoot.visible = this.activityLayerVisible;
    }
  }

  loadActivitiesOnGlobe(): void {
    const user = this.membersService.getUser();
    if (!user?.id?.trim()) {
      this.activitiesBanner = 'login';
      return;
    }
    this.activitiesLoading = true;
    this.activitiesBanner = 'loading';
    this.activitiesPlaced = 0;
    this.activitiesSkipped = 0;
    this.activitiesPickerOpen = false;
    this.globeActivityPickerRows = [];
    this.cdr.markForCheck();
    this.eventsStreamSub?.unsubscribe();
    if (this.activitiesStreamFinalizeTimer != null) {
      clearTimeout(this.activitiesStreamFinalizeTimer);
      this.activitiesStreamFinalizeTimer = null;
    }

    const bucket: Evenement[] = [];
    const mergeEvent = (e: Evenement) => {
      const ix = bucket.findIndex((x) => x.id === e.id);
      if (ix >= 0) {
        bucket[ix] = e;
      } else {
        bucket.push(e);
      }
    };

    let streamFinalized = false;
    const finalizeStream = () => {
      if (streamFinalized) {
        return;
      }
      streamFinalized = true;
      if (this.activitiesStreamFinalizeTimer != null) {
        clearTimeout(this.activitiesStreamFinalizeTimer);
        this.activitiesStreamFinalizeTimer = null;
      }
      this.activitiesLoading = false;
      this.eventsStreamSub?.unsubscribe();
      this.eventsStreamSub = undefined;
      if (!bucket.length) {
        this.activitiesBanner = this.activitiesBanner === 'error' ? 'error' : 'none';
      } else {
        this.prepareActivityPicker(bucket);
      }
      this.cdr.markForCheck();
    };

    this.eventsStreamSub = this.evenementsService.streamEvents('', user.id, 'all', false).subscribe({
      next: (evt: StreamedEvent) => {
        if (evt.type === 'event' && evt.data && typeof evt.data === 'object' && 'id' in (evt.data as object)) {
          mergeEvent(evt.data as Evenement);
        }
        if (evt.type === 'complete') {
          finalizeStream();
        }
      },
      error: () => {
        this.activitiesBanner = bucket.length ? 'idle' : 'error';
        finalizeStream();
      },
      complete: () => finalizeStream()
    });

    this.activitiesStreamFinalizeTimer = setTimeout(() => finalizeStream(), 16000);
  }

  globeActivityShortLabel(ev: Evenement): string {
    const name = (ev.evenementName || '').trim();
    return name || ev.id || '—';
  }

  /** Fichiers traçables côté parseur (GPX/KML/TCX/GeoJSON…) — même esprit que le détail événement, sans KMZ/GDB zip. */
  private getGlobeTrackFiles(ev: Evenement): UploadedFile[] {
    if (!ev.fileUploadeds?.length) {
      return [];
    }
    return ev.fileUploadeds.filter((file) => {
      const t = (file.fileType || '').toUpperCase();
      if (t === 'TRACK' || t === 'GPX' || t === 'TRACE' || t === 'TCX' || t === 'KML') {
        return true;
      }
      const fn = (file.fileName || '').toLowerCase();
      return (
        fn.endsWith('.gpx') ||
        fn.endsWith('.kml') ||
        fn.endsWith('.tcx') ||
        fn.endsWith('.geojson') ||
        (fn.endsWith('.json') && (fn.includes('track') || fn.includes('geo') || fn.includes('route')))
      );
    });
  }

  private sortTrackFilesForGlobe(files: UploadedFile[]): UploadedFile[] {
    const rank = (f: UploadedFile) => {
      const n = (f.fileName || '').toLowerCase();
      if (n.endsWith('.gpx')) {
        return 0;
      }
      if (n.endsWith('.tcx')) {
        return 1;
      }
      if (n.endsWith('.kml')) {
        return 2;
      }
      return 3;
    };
    return [...files].sort((a, b) => rank(a) - rank(b));
  }

  private prepareActivityPicker(events: Evenement[]): void {
    const byId = new Map<string, Evenement>();
    for (const e of events) {
      if (e?.id) {
        byId.set(e.id, e);
      }
    }
    const list = [...byId.values()].sort(
      (a, b) =>
        new Date(b.beginEventDate as unknown as string).getTime() -
        new Date(a.beginEventDate as unknown as string).getTime()
    );
    const cap = 400;
    this.globeActivityPickerRows = list.slice(0, cap).map((ev) => {
      const trackFiles = this.sortTrackFilesForGlobe(this.getGlobeTrackFiles(ev));
      const hasLoc = !!(ev.startLocation && ev.startLocation.trim());
      return {
        event: ev,
        selected: trackFiles.length > 0 || hasLoc,
        trackFiles
      };
    });
    this.activitiesPickerOpen = this.globeActivityPickerRows.length > 0;
    this.activitiesBanner = this.globeActivityPickerRows.length ? 'idle' : 'none';
  }

  globeActivityRowTrackCount(row: GlobeActivityPickerRow): number {
    return row.trackFiles.length;
  }

  selectGlobeActivitiesWithTracksOnly(): void {
    for (const row of this.globeActivityPickerRows) {
      row.selected = row.trackFiles.length > 0;
    }
    this.cdr.markForCheck();
  }

  async applySelectedActivitiesOnGlobe(): Promise<void> {
    const selected = this.globeActivityPickerRows.filter((r) => r.selected).map((r) => r.event);
    if (!selected.length) {
      this.activitiesBanner = 'none';
      this.cdr.markForCheck();
      return;
    }
    await this.fetchTracksAndGeocodeActivities(selected);
  }

  onAutoRotateToggle(): void {
    if (this.controls) {
      this.controls.autoRotate = this.autoRotate;
    }
  }

  /**
   * Cadre la Terre pour que (lat°, lon°) soit au centre du globe.
   * Légère élévation de la caméra pour garder une lecture lisible du relief/textures.
   * Prend en compte la rotation du maillage Terre (texture π) ou, avant chargement, la même orientation attendue.
   */
  private frameCameraOnLatLon(latDeg: number, lonDeg: number, distance: number): void {
    if (!this.camera || !this.controls) {
      return;
    }
    const pos = this.computeCameraPositionForLatLon(latDeg, lonDeg, distance);
    if (!pos) {
      return;
    }
    this.camera.position.copy(pos);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Position caméra pour capter (lat, lon) au centre (repère monde, Terre à l’origine). */
  private computeCameraPositionForLatLon(latDeg: number, lonDeg: number, distance: number): THREE.Vector3 | null {
    const radial = WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, 1);
    const earth = this.earthMesh;
    if (earth) {
      earth.updateMatrixWorld(true);
      radial.applyMatrix4(earth.matrixWorld);
    } else {
      radial.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    }
    const len = radial.length();
    if (len < 1e-12) {
      return null;
    }
    radial.multiplyScalar(distance / len);
    const yLift = 0.22;
    return new THREE.Vector3(radial.x, radial.y + yLift, radial.z);
  }

  /**
   * Distance d’orbite pour cadrer le lieu : bbox Nominatim étroite → zoom ville ; large → pays / région.
   */
  private orbitDistanceForGeocodeBBox(bbox: number[] | null | undefined): number {
    if (!bbox || bbox.length < 4) {
      return GLOBE_GEOCODE_ORBIT_FALLBACK;
    }
    const south = bbox[0];
    const north = bbox[1];
    const west = bbox[2];
    const east = bbox[3];
    if (![south, north, west, east].every((n) => Number.isFinite(n))) {
      return GLOBE_GEOCODE_ORBIT_FALLBACK;
    }
    const latSpan = Math.abs(north - south);
    let lonSpan = Math.abs(east - west);
    if (lonSpan > 180) {
      lonSpan = 360 - lonSpan;
    }
    const spanDeg = Math.max(latSpan, lonSpan, 1e-6);
    const u = THREE.MathUtils.clamp(
      (spanDeg - GLOBE_GEOCODE_SPAN_REF_LO) / (GLOBE_GEOCODE_SPAN_REF_HI - GLOBE_GEOCODE_SPAN_REF_LO),
      0,
      1
    );
    const d = THREE.MathUtils.lerp(GLOBE_GEOCODE_ORBIT_MIN, GLOBE_GEOCODE_ORBIT_MAX, u);
    const minD = this.controls?.minDistance ?? 1.02;
    const maxD = this.controls?.maxDistance ?? 7;
    return THREE.MathUtils.clamp(d, minD + 0.02, maxD * 0.98);
  }

  /** Interpolation sphérique entre deux directions unitaires (arc de grand cercle). */
  private static slerpUnitVectors(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): void {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z;
    dot = THREE.MathUtils.clamp(dot, -1, 1);
    const omega = Math.acos(dot);
    if (omega < 1e-5) {
      out.copy(a).lerp(b, t).normalize();
      return;
    }
    const sinOm = Math.sin(omega);
    const s0 = Math.sin((1 - t) * omega) / sinOm;
    const s1 = Math.sin(t * omega) / sinOm;
    out.set(a.x * s0 + b.x * s1, a.y * s0 + b.y * s1, a.z * s0 + b.z * s1).normalize();
  }

  private stopGlobeCameraAnimation(): void {
    if (this.globeCameraAnimFrameId != null) {
      cancelAnimationFrame(this.globeCameraAnimFrameId);
      this.globeCameraAnimFrameId = null;
    }
    if (this.controls && this.globeCameraAnimPrevDamping !== null) {
      this.controls.enableDamping = this.globeCameraAnimPrevDamping;
      this.globeCameraAnimPrevDamping = null;
    }
  }

  /**
   * Déplace la caméra vers le lieu en suivant un arc de grand cercle (rotation fluide),
   * au lieu d’un saut instantané.
   */
  private animateCameraToLatLon(latDeg: number, lonDeg: number, distance: number, durationMs = GLOBE_GEOCODE_ANIM_MS): void {
    const camera = this.camera;
    const controls = this.controls;
    if (!camera || !controls) {
      return;
    }
    const endPos = this.computeCameraPositionForLatLon(latDeg, lonDeg, distance);
    if (!endPos) {
      return;
    }
    this.stopGlobeCameraAnimation();
    this.globeCameraAnimPrevDamping = controls.enableDamping;
    controls.enableDamping = false;

    const startPos = camera.position.clone();
    const startLen = startPos.length();
    const endLen = endPos.length();
    if (startLen < 1e-8) {
      camera.position.copy(endPos);
      controls.target.set(0, 0, 0);
      controls.enableDamping = this.globeCameraAnimPrevDamping;
      this.globeCameraAnimPrevDamping = null;
      controls.update();
      return;
    }
    const startN = startPos.clone().divideScalar(startLen);
    const endN = endPos.clone().normalize();
    const dirScratch = new THREE.Vector3();
    const started = performance.now();
    const easeInOutCubic = (u: number): number =>
      u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

    const step = (now: number): void => {
      const elapsed = now - started;
      const u = Math.min(1, elapsed / durationMs);
      const t = easeInOutCubic(u);
      WorldGlobeComponent.slerpUnitVectors(startN, endN, t, dirScratch);
      const dist = THREE.MathUtils.lerp(startLen, endLen, t);
      camera.position.copy(dirScratch.multiplyScalar(dist));
      controls.target.set(0, 0, 0);
      controls.update();
      if (u < 1) {
        this.globeCameraAnimFrameId = requestAnimationFrame(step);
      } else {
        this.globeCameraAnimFrameId = null;
        camera.position.copy(endPos);
        controls.target.set(0, 0, 0);
        controls.enableDamping = this.globeCameraAnimPrevDamping ?? true;
        this.globeCameraAnimPrevDamping = null;
        controls.update();
      }
    };

    this.globeCameraAnimFrameId = requestAnimationFrame(step);
  }

  /**
   * Adapte rotate / pan / zoom aux distances OrbitControls : plus la caméra est proche du globe,
   * plus les gestes souris restent précis (sans changer le réglage utilisateur entre deux zooms).
   */
  private syncOrbitControlsSensitivity(): void {
    const controls = this.controls;
    const camera = this.camera;
    if (!controls || !camera) {
      return;
    }
    const d = camera.position.distanceTo(controls.target);
    const lo = controls.minDistance;
    const hi = controls.maxDistance;
    const u = hi > lo ? THREE.MathUtils.clamp((d - lo) / (hi - lo), 0, 1) : 1;
    controls.rotateSpeed = THREE.MathUtils.lerp(ORBIT_SENS_U_MIN_ROTATE_PAN, 1, u);
    controls.panSpeed = THREE.MathUtils.lerp(ORBIT_SENS_U_MIN_ROTATE_PAN, 1, u);
    controls.zoomSpeed = THREE.MathUtils.lerp(ORBIT_SENS_U_MIN_ZOOM, 1, u);
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.stopGlobeCameraAnimation();
    this.clearGeocodeMarker();
    this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
    if (this.earthMesh) {
      this.earthMesh.rotation.set(0, Math.PI, 0);
      this.cloudsDriftRad = 0;
    }
    if (this.cloudsMesh) {
      this.cloudsMesh.rotation.y = Math.PI + this.cloudsDriftRad;
    }
  }

  /**
   * Géocodage d’adresse / lieu (backend Nominatim), identique à la page Adresse / GPS.
   * Centre la caméra sur le lieu avec un vol fluide ; un seul résultat : animation directe ; plusieurs : liste cliquable.
   */
  searchGlobePlace(): void {
    (document.activeElement as HTMLElement | null)?.blur();
    const query = this.globePlaceQuery?.trim();
    if (!query) {
      this.globeGeocodeError = this.translate.instant('ADDRESS_GEOCODE.ADDRESS_REQUIRED');
      this.globeGeocodeResults = [];
      this.cdr.markForCheck();
      return;
    }
    if (!this.globeSurfaceReady || !this.camera || !this.controls) {
      this.globeGeocodeError = this.translate.instant('WORLD_GLOBE.GEOCODE_GLOBE_NOT_READY');
      this.cdr.markForCheck();
      return;
    }
    this.globeGeocodeError = '';
    this.globeGeocodeResults = [];
    this.globeGeocodeLoading = true;
    this.apiService
      .geocodeSearch(query)
      .pipe(
        finalize(() => {
          this.globeGeocodeLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (data: unknown) => {
          const raw = Array.isArray(data) ? data : [];
          const results = raw
            .map((item: Record<string, unknown>) => {
              const la = item['lat'];
              const lo = item['lon'];
              const dn = item['displayName'] ?? item['display_name'];
              const bb = item['boundingBox'] ?? item['boundingbox'];
              let boundingBox: number[] | null = null;
              if (Array.isArray(bb) && bb.length >= 4) {
                const nums = bb.slice(0, 4).map((x) => parseFloat(String(x)));
                if (nums.every((n) => Number.isFinite(n))) {
                  boundingBox = nums;
                }
              }
              return {
                lat: typeof la === 'number' ? la : parseFloat(String(la ?? '')),
                lon: typeof lo === 'number' ? lo : parseFloat(String(lo ?? '')),
                displayName: String(dn ?? '').trim(),
                boundingBox
              };
            })
            .filter(
              (r) =>
                Number.isFinite(r.lat) &&
                Number.isFinite(r.lon) &&
                Math.abs(r.lat) <= 90 &&
                Math.abs(r.lon) <= 180
            );
          this.globeGeocodeResults = results;
          if (results.length === 0) {
            this.globeGeocodeError = this.translate.instant('ADDRESS_GEOCODE.NO_RESULTS');
          } else if (results.length === 1) {
            this.flyGlobeToGeocodeResult(results[0]);
          }
          this.cdr.markForCheck();
        },
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.globeGeocodeError = this.translate.instant('ADDRESS_GEOCODE.ERROR') + ': ' + msg;
          this.globeGeocodeResults = [];
          this.cdr.markForCheck();
        }
      });
  }

  flyGlobeToGeocodeResult(result: {
    lat: number;
    lon: number;
    displayName: string;
    boundingBox?: number[] | null;
  }): void {
    if (!this.camera || !this.controls) {
      return;
    }
    const dist = this.orbitDistanceForGeocodeBBox(result.boundingBox ?? null);
    this.animateCameraToLatLon(result.lat, result.lon, dist);
    this.globeGeocodeMarkerLat = result.lat;
    this.globeGeocodeMarkerLon = result.lon;
    this.ensureGeocodeMarkerMesh();
    this.updateGeocodeMarkerWorldPosition();
    this.globePickedLat = result.lat;
    this.globePickedLon = result.lon;
    this.globeGeocodeResults = [];
    this.globeGeocodeError = '';
    this.cdr.markForCheck();
  }

  private ensureGeocodeMarkerMesh(): void {
    const sceneRef = this.scene;
    if (!sceneRef || this.geocodeMarkerMesh) {
      return;
    }
    const geo = new THREE.SphereGeometry(GLOBE_GEOCODE_MARKER_RADIUS, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xe53935, depthTest: true, depthWrite: true });
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    sceneRef.add(mesh);
    this.geocodeMarkerMesh = mesh;
  }

  private updateGeocodeMarkerWorldPosition(): void {
    const lat = this.globeGeocodeMarkerLat;
    const lon = this.globeGeocodeMarkerLon;
    const earth = this.earthMesh;
    const mesh = this.geocodeMarkerMesh;
    if (lat == null || lon == null || !earth || !mesh) {
      return;
    }
    this.geocodeMarkerWorldScratch
      .copy(WorldGlobeComponent.latLonToVector3(lat, lon, GLOBE_GEOCODE_MARKER_SURFACE_OFFSET));
    earth.updateMatrixWorld(true);
    this.geocodeMarkerWorldScratch.applyMatrix4(earth.matrixWorld);
    mesh.position.copy(this.geocodeMarkerWorldScratch);
  }

  /** Retire le point rouge (clic sur la Terre, réinitialisation vue, destroy). */
  private clearGeocodeMarker(): void {
    this.disposeGeocodeMarkerMesh();
    this.cdr.markForCheck();
  }

  private disposeGeocodeMarkerMesh(): void {
    const sceneRef = this.scene;
    const mesh = this.geocodeMarkerMesh;
    this.globeGeocodeMarkerLat = null;
    this.globeGeocodeMarkerLon = null;
    if (!mesh) {
      return;
    }
    sceneRef?.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (!Array.isArray(mat) && mat) {
      mat.dispose();
    }
    this.geocodeMarkerMesh = undefined;
  }

  private syncFullscreenFromDocument(): void {
    const shell = this.globeShell?.nativeElement;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    const fsEl =
      document.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.msFullscreenElement ?? null;
    this.fullscreen = !!(shell && fsEl === shell);
  }

  /** Éclairage : jour/nuit réel, uniforme, ou tamisé. */
  private syncGlobeLighting(): void {
    const amb = this.ambientLight;
    const hemi = this.hemisphereLight;
    const sun = this.sunLight;
    if (!amb || !hemi || !sun) {
      return;
    }

    if (this.realTimeTerminator) {
      amb.color.setHex(0xffffff);
      hemi.color.setHex(0xb8c8f0);
      hemi.groundColor.setHex(0x070a12);
      sun.color.setHex(0xfff7ec);
      this.applyGlobeLightingLevels(0.19, 0.1, 3.05, 1.2);
      this.updateSunDirectionFromTime(new Date());
      return;
    }

    if (this.globeLightingUniform) {
      amb.color.setHex(0xffffff);
      hemi.color.setHex(0xffffff);
      hemi.groundColor.setHex(0x6c7888);
      sun.color.setHex(0xffffff);
      sun.position.set(2.6, 4.2, 3);
      this.applyGlobeLightingLevels(1.0, 0.93, 0.3, 1.36);
      return;
    }

    amb.color.setHex(0xffffff);
    hemi.color.setHex(0x8899bb);
    hemi.groundColor.setHex(0x0c1018);
    this.applyGlobeLightingLevels(0.09, 0.11, 0, 1.06);
  }

  /**
   * Applique les intensités de base puis le réglage « potentiomètre » {@link globeLightingBoost}.
   */
  private applyGlobeLightingLevels(
    ambBase: number,
    hemiBase: number,
    sunBase: number,
    exposureBase: number
  ): void {
    const amb = this.ambientLight;
    const hemi = this.hemisphereLight;
    const sun = this.sunLight;
    const r = this.renderer;
    if (!amb || !hemi || !sun) {
      return;
    }
    const m = THREE.MathUtils.clamp(this.globeLightingBoost, GLOBE_LIGHTING_BOOST_MIN, GLOBE_LIGHTING_BOOST_MAX);
    amb.intensity = ambBase * m;
    hemi.intensity = hemiBase * m;
    sun.intensity = sunBase * m;
    if (r) {
      r.toneMappingExposure = THREE.MathUtils.clamp(exposureBase * m, 0.45, 2.75);
    }
  }

  onGlobeLightingBoostChange(): void {
    this.syncGlobeLighting();
    this.cdr.markForCheck();
  }

  /**
   * Aligne la directionnelle avec le sous-point solaire : même repère que latLonToVector3 +
   * matrixWorld du maillage Terre (rotation texture π), puis soleil loin dans cette direction.
   */
  private updateSunDirectionFromTime(date: Date): void {
    const sun = this.sunLight;
    const earth = this.earthMesh;
    if (!sun || !earth) {
      return;
    }
    const gv = GeoVector(Body.Sun, date, true);
    const obs = VectorObserver(gv, false);
    earth.updateMatrixWorld(true);
    this.subsolarWorldScratch.copy(WorldGlobeComponent.latLonToVector3(obs.latitude, obs.longitude, 1));
    this.subsolarWorldScratch.applyMatrix4(earth.matrixWorld).normalize();
    const k = WorldGlobeComponent.SUN_LIGHT_DISTANCE;
    sun.position.copy(this.subsolarWorldScratch.multiplyScalar(k));
    sun.target.position.set(0, 0, 0);
  }

  private bootstrapThree(): void {
    const host = this.globeCanvasHost?.nativeElement;
    if (!host || host.clientWidth < 2 || host.clientHeight < 2) {
      requestAnimationFrame(() => this.bootstrapThree());
      return;
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x020510, 0.035);

    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.005, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(globePixelRatioCap());
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      verticalAlign: 'top',
      borderRadius: '0.35rem'
    });

    const canvasEl = renderer.domElement;
    canvasEl.addEventListener('pointerdown', this.onGlobePointerDown);
    canvasEl.addEventListener('pointerup', this.onGlobePointerUp);
    canvasEl.addEventListener('pointercancel', this.onGlobePointerCancel);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 1.02;
    controls.maxDistance = 7;
    controls.enablePan = true;
    controls.autoRotate = this.autoRotate;
    controls.autoRotateSpeed = 0.35;

    const ambient = new THREE.AmbientLight(0xffffff, 0.08);
    scene.add(ambient);
    this.ambientLight = ambient;
    const hemi = new THREE.HemisphereLight(0x8899bb, 0x0c1018, 0.1);
    scene.add(hemi);
    this.hemisphereLight = hemi;
    const sunLight = new THREE.DirectionalLight(0xffffff, 0);
    sunLight.position.set(2.4, 3.8, 2.6);
    scene.add(sunLight);
    scene.add(sunLight.target);

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.sunLight = sunLight;
    this.syncGlobeLighting();
    this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);

    this.starsPoints = this.makeStarField();
    scene.add(this.starsPoints);

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const aniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;

    const loadCloudsThenMarkers = (): void => {
      loader.load(
        this.globePlanetTextureUrl('clouds'),
        (cloudMap) => {
          cloudMap.colorSpace = THREE.SRGBColorSpace;
          cloudMap.anisotropy = aniso;
          const cg = new THREE.SphereGeometry(1.025, GLOBE_CLOUDS_SEGMENTS, GLOBE_CLOUDS_SEGMENTS);
          const cm = new THREE.MeshPhongMaterial({
            map: cloudMap,
            transparent: true,
            opacity: 0.88,
            depthWrite: false
          });
          const clouds = new THREE.Mesh(cg, cm);
          clouds.rotation.y = Math.PI;
          clouds.visible = this.cloudsEnabled;
          scene.add(clouds);
          this.cloudsMesh = clouds;
        },
        undefined,
        () => {
          /* nuages optionnels */
        }
      );
    };

    const addPhongEarth = (
      earthMap: THREE.Texture,
      specMap: THREE.Texture | null,
      bumpMap: THREE.Texture | null
    ): void => {
      const earthGeo = new THREE.SphereGeometry(1, GLOBE_EARTH_SEGMENTS, GLOBE_EARTH_SEGMENTS);
      const earthMat = new THREE.MeshPhongMaterial({
        map: earthMap,
        specularMap: specMap ?? undefined,
        specular: new THREE.Color(0x334455),
        shininess: 12,
        bumpMap: bumpMap ?? undefined,
        bumpScale: bumpMap ? 0.045 : 0
      });
      const earth = new THREE.Mesh(earthGeo, earthMat);
      earth.rotation.y = Math.PI;
      scene.add(earth);
      this.earthMesh = earth;
      this.globeSurfaceReady = true;
      this.standardEarthTextures = { map: earthMap, spec: specMap, bump: bumpMap };
      this.applyBasemapMode();
      this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
    };

    loader.load(
      this.globePlanetTextureUrl('atmos'),
      (earthMap) => {
        earthMap.colorSpace = THREE.SRGBColorSpace;
        earthMap.anisotropy = aniso;
        loader.load(
          this.globePlanetTextureUrl('specular'),
          (specMap) => {
            specMap.colorSpace = THREE.NoColorSpace;
            loader.load(
              this.globePlanetTextureUrl('normal'),
              (bumpMap) => {
                bumpMap.colorSpace = THREE.NoColorSpace;
                addPhongEarth(earthMap, specMap, bumpMap);
                loadCloudsThenMarkers();
              },
              undefined,
              () => {
                addPhongEarth(earthMap, specMap, null);
                loadCloudsThenMarkers();
              }
            );
          },
          undefined,
          () => {
            this.addEarthStandard(earthMap, scene);
            loadCloudsThenMarkers();
          }
        );
      },
      undefined,
      () => {
        this.textureLoadError = true;
        const g = new THREE.SphereGeometry(1, 128, 128);
        const m = new THREE.MeshStandardMaterial({
          color: 0x2244aa,
          roughness: 0.72,
          metalness: 0.08,
          wireframe: false
        });
        const earth = new THREE.Mesh(g, m);
        earth.rotation.y = Math.PI;
        scene.add(earth);
        this.earthMesh = earth;
        this.globeSurfaceReady = true;
        this.standardEarthTextures = null;
        this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
      }
    );

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.resizeRendererToHost());
      this.resizeObs.observe(host);
    }

    this.startLoop();
    this.controls.update();
    this.syncFullscreenFromDocument();
  }

  private addEarthStandard(earthMap: THREE.Texture, scene: THREE.Scene): void {
    const earthGeo = new THREE.SphereGeometry(1, GLOBE_EARTH_SEGMENTS, GLOBE_EARTH_SEGMENTS);
    const earthMat = new THREE.MeshStandardMaterial({
      map: earthMap,
      roughness: 0.78,
      metalness: 0.05
    });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    earth.rotation.y = Math.PI;
    scene.add(earth);
    this.earthMesh = earth;
    this.globeSurfaceReady = true;
    this.standardEarthTextures = { map: earthMap, spec: null, bump: null };
    this.applyBasemapMode();
    this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
  }

  /** Toutes les images du globe passent par le backend PatTool ({@code /api/external/globe/...}). */
  private globePlanetTextureUrl(asset: 'atmos' | 'specular' | 'normal' | 'clouds'): string {
    return `${environment.API_URL}external/globe/texture/planets/${asset}`;
  }

  private globeSatelliteBmngUrl(): string {
    return `${environment.API_URL}external/globe/texture/satellite/bmng`;
  }

  private globeGibsViirsUrl(): string {
    return `${environment.API_URL}external/globe/overlay/gibs/viirs`;
  }

  private applyBasemapMode(): void {
    if (!this.earthMesh || !this.standardEarthTextures) {
      return;
    }
    const st = this.standardEarthTextures;
    if (this.basemapSatellite) {
      this.loadSatelliteTextureFromBackend();
      return;
    }
    const m = this.earthMesh.material;
    if (m instanceof THREE.MeshPhongMaterial) {
      m.map = st.map;
      m.bumpMap = st.bump ?? null;
      m.bumpScale = st.bump ? 0.045 : 0;
      m.specularMap = st.spec ?? null;
      m.needsUpdate = true;
    } else if (m instanceof THREE.MeshStandardMaterial) {
      m.map = st.map;
      m.needsUpdate = true;
    }
  }

  private loadSatelliteTextureFromBackend(): void {
    if (!this.earthMesh || !this.standardEarthTextures) {
      return;
    }
    if (this.satelliteTexture) {
      this.applySatelliteTextureToEarth(this.satelliteTexture);
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      this.globeSatelliteBmngUrl(),
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer?.capabilities.getMaxAnisotropy?.() ?? 1;
        this.satelliteTexture = tex;
        this.applySatelliteTextureToEarth(tex);
        this.cdr.markForCheck();
      },
      undefined,
      () => {
        this.textureLoadError = true;
        this.cdr.markForCheck();
      }
    );
  }

  private applySatelliteTextureToEarth(tex: THREE.Texture): void {
    if (!this.earthMesh) {
      return;
    }
    const m = this.earthMesh.material;
    if (m instanceof THREE.MeshPhongMaterial) {
      m.map = tex;
      m.bumpMap = null;
      m.bumpScale = 0;
      m.specularMap = null;
      m.needsUpdate = true;
    } else if (m instanceof THREE.MeshStandardMaterial) {
      m.map = tex;
      m.needsUpdate = true;
    }
  }

  private disposeWeatherOverlayMesh(): void {
    const scene = this.scene;
    if (!scene || !this.weatherOverlayMesh) {
      return;
    }
    scene.remove(this.weatherOverlayMesh);
    const mat = this.weatherOverlayMesh.material as THREE.MeshBasicMaterial;
    this.weatherOverlayMesh.geometry.dispose();
    mat.dispose();
    this.weatherOverlayTexture?.dispose();
    this.weatherOverlayMesh = undefined;
    this.weatherOverlayTexture = null;
  }

  private ensureWeatherOverlayTexture(): void {
    if (!this.scene || !this.renderer) {
      return;
    }
    this.disposeWeatherOverlayMesh();
    this.weatherImageryFailed = false;
    this.weatherImageryLoading = true;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      this.globeGibsViirsUrl(),
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer!.capabilities.getMaxAnisotropy?.() ?? 1;
        const geo = new THREE.SphereGeometry(1.032, GLOBE_OVERLAY_SEGMENTS, GLOBE_OVERLAY_SEGMENTS);
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.36,
          depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.y = Math.PI;
        this.scene!.add(mesh);
        this.weatherOverlayMesh = mesh;
        this.weatherOverlayTexture = tex;
        this.weatherImageryLoading = false;
        this.cdr.markForCheck();
      },
      undefined,
      () => {
        this.weatherImageryLoading = false;
        this.weatherImageryFailed = true;
        this.cdr.markForCheck();
      }
    );
  }

  private static decimateLatLon(
    pts: readonly { lat: number; lon: number }[],
    maxPoints: number
  ): { lat: number; lon: number }[] {
    if (pts.length <= maxPoints) {
      return pts.map((p) => ({ lat: p.lat, lon: p.lon }));
    }
    const step = Math.ceil(pts.length / maxPoints);
    const out: { lat: number; lon: number }[] = [];
    for (let i = 0; i < pts.length; i += step) {
      out.push({ lat: pts[i].lat, lon: pts[i].lon });
    }
    if (out.length < 2 && pts.length >= 2) {
      out.push({ lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon });
    }
    return out;
  }

  private static hashColorForId(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const hue = ((h >>> 0) % 360) / 360;
    return new THREE.Color().setHSL(hue, 0.62, 0.52).getHex();
  }

  private disposeActivityScene(scene: THREE.Scene): void {
    if (!this.activityRoot) {
      return;
    }
    scene.remove(this.activityRoot);
    this.activityRoot.traverse((o) => {
      if (o instanceof THREE.Line || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
      if (o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.activityRoot = undefined;
  }

  private async fetchTracksAndGeocodeActivities(events: Evenement[]): Promise<void> {
    if (!this.scene) {
      return;
    }
    if (!events.length) {
      this.activitiesBanner = 'none';
      this.cdr.markForCheck();
      return;
    }
    this.applyingGlobeActivities = true;
    this.activitiesPlaced = 0;
    this.activitiesSkipped = 0;
    this.cdr.markForCheck();
    const segments: Array<{ pts: { lat: number; lon: number }[]; color: number }> = [];
    const loneMarkers: { lat: number; lon: number }[] = [];
    let skipped = 0;
    const maxSegments = 64;
    const decoder = new TextDecoder('utf-8', { fatal: false });

    try {
      outer: for (const ev of events) {
        if (segments.length >= maxSegments) {
          break;
        }
        const trackFiles = this.sortTrackFilesForGlobe(this.getGlobeTrackFiles(ev));
        let handled = false;

        for (const tf of trackFiles) {
          if (!tf?.fieldId?.trim()) {
            continue;
          }
          try {
            const buf = await firstValueFrom(
              this.fileService.getFile(tf.fieldId).pipe(timeout(90000))
            );
            const rawBuf = buf instanceof ArrayBuffer ? buf : (buf as ArrayBuffer);
            const text = decoder.decode(new Uint8Array(rawBuf));
            const parsed = parseTrackFileToLatLonPoints(tf.fileName || 'track.gpx', text).map((p) => ({
              lat: p.lat,
              lon: p.lon
            }));
            const pts = WorldGlobeComponent.decimateLatLon(parsed, 900);
            if (pts.length >= 2) {
              segments.push({
                pts,
                color: WorldGlobeComponent.hashColorForId(ev.id || tf.fieldId)
              });
              handled = true;
              break;
            }
            if (pts.length === 1) {
              loneMarkers.push({ lat: pts[0].lat, lon: pts[0].lon });
              handled = true;
              break;
            }
          } catch {
            /* essayer un autre fichier trace */
          }
        }

        if (!handled && ev.startLocation?.trim()) {
          const geo = await this.geocodeSingleStartLocation(ev);
          if (geo) {
            loneMarkers.push(geo);
          } else {
            skipped++;
          }
          await WorldGlobeComponent.delayMs(420);
          continue outer;
        }
        if (!handled) {
          skipped++;
        }
      }

      this.buildActivityOverlayExtended(this.scene, segments, loneMarkers);
      const placedCount = segments.length + loneMarkers.length;
      this.activitiesPlaced = placedCount;
      this.activitiesSkipped = skipped;
      this.activitiesBanner = placedCount > 0 ? 'done' : 'none';
    } catch {
      this.activitiesBanner = 'error';
    } finally {
      this.applyingGlobeActivities = false;
      this.cdr.markForCheck();
    }
  }

  private async geocodeSingleStartLocation(ev: Evenement): Promise<{ lat: number; lon: number } | null> {
    const loc = ev.startLocation?.trim();
    if (!loc) {
      return null;
    }
    const parsed = WorldGlobeComponent.tryParseLatLon(loc);
    if (parsed) {
      return { lat: parsed.lat, lon: parsed.lon };
    }
    try {
      const res = await firstValueFrom(this.apiService.geocodeSearch(loc).pipe(timeout(15000)));
      const first = res?.[0] as { lat?: number; lon?: number } | undefined;
      if (
        first &&
        typeof first.lat === 'number' &&
        typeof first.lon === 'number' &&
        Number.isFinite(first.lat) &&
        Number.isFinite(first.lon)
      ) {
        return { lat: first.lat, lon: first.lon };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private buildActivityOverlayExtended(
    scene: THREE.Scene,
    segments: readonly { pts: readonly { lat: number; lon: number }[]; color: number }[],
    markers: readonly { lat: number; lon: number }[]
  ): void {
    this.disposeActivityScene(scene);
    const group = new THREE.Group();
    const rLine = 1.027;

    for (const seg of segments) {
      if (seg.pts.length < 2) {
        continue;
      }
      const vertices: number[] = [];
      for (let i = 0; i < seg.pts.length - 1; i++) {
        const a = WorldGlobeComponent.latLonToVector3(seg.pts[i].lat, seg.pts[i].lon, rLine);
        const b = WorldGlobeComponent.latLonToVector3(seg.pts[i + 1].lat, seg.pts[i + 1].lon, rLine);
        const arc = WorldGlobeComponent.greatCircleArc(a, b, rLine, 28);
        for (let j = 0; j < arc.length - 1; j++) {
          vertices.push(arc[j].x, arc[j].y, arc[j].z, arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
        }
      }
      if (vertices.length > 0) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const line = new THREE.LineSegments(
          g,
          new THREE.LineBasicMaterial({
            color: seg.color,
            transparent: true,
            opacity: 0.58,
            depthWrite: false
          })
        );
        group.add(line);
      }
    }

    const markerPts: { lat: number; lon: number }[] = markers.map((p) => ({ lat: p.lat, lon: p.lon }));
    for (const seg of segments) {
      if (seg.pts.length) {
        markerPts.push({ lat: seg.pts[0].lat, lon: seg.pts[0].lon });
      }
    }

    if (markerPts.length > 0) {
      const surfaceR = 1.022;
      const alongN = 0.0035;
      const ringGeo = new THREE.RingGeometry(0.005, 0.009, 48);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x7ae8c0,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      });
      const dotGeo = new THREE.CircleGeometry(0.0022, 28);
      const dotMat = new THREE.MeshBasicMaterial({
        color: 0xb8ffd9,
        transparent: true,
        opacity: 0.88,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      });
      const ringInst = new THREE.InstancedMesh(ringGeo, ringMat, markerPts.length);
      const dotInst = new THREE.InstancedMesh(dotGeo, dotMat, markerPts.length);
      const m4 = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const zAxis = new THREE.Vector3(0, 0, 1);
      markerPts.forEach((p, i) => {
        v.copy(WorldGlobeComponent.latLonToVector3(p.lat, p.lon, surfaceR));
        n.copy(v).normalize();
        v.addScaledVector(n, alongN);
        q.setFromUnitVectors(zAxis, n);
        m4.compose(v, q, new THREE.Vector3(1, 1, 1));
        ringInst.setMatrixAt(i, m4);
        dotInst.setMatrixAt(i, m4);
      });
      ringInst.instanceMatrix.needsUpdate = true;
      dotInst.instanceMatrix.needsUpdate = true;
      group.add(ringInst);
      group.add(dotInst);
    }

    group.visible = this.activityLayerVisible;
    scene.add(group);
    this.activityRoot = group;
  }

  private static tryParseLatLon(text: string): { lat: number; lon: number } | null {
    const t = text.trim();
    const m =
      t.match(/^([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)/) ??
      t.match(/^([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s*$/);
    if (!m) {
      return null;
    }
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return null;
    }
    return { lat, lon };
  }

  /**
   * Arc du grand cercle sur la sphère (sommets espacés le long du plus court passage).
   * @param aSurf position sur la sphère (rayon quelconque, non nulle)
   * @param bSurf idem second point
   */
  private static greatCircleArc(
    aSurf: THREE.Vector3,
    bSurf: THREE.Vector3,
    radius: number,
    segments: number
  ): THREE.Vector3[] {
    const a = aSurf.clone().normalize();
    const b = bSurf.clone().normalize();
    const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    const omega = Math.acos(dot);
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      if (Math.abs(omega) < 1e-5) {
        out.push(a.clone().multiplyScalar(radius));
        continue;
      }
      const so = Math.sin(omega);
      const s0 = Math.sin((1 - t) * omega) / so;
      const s1 = Math.sin(t * omega) / so;
      out.push(a.clone().multiplyScalar(s0).addScaledVector(b, s1).normalize().multiplyScalar(radius));
    }
    return out;
  }

  private static delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Position sur sphère Y-haut ; cohérent avec texture équirectangular (Three.js planets). */
  private static latLonToVector3(latDeg: number, lonDeg: number, radius: number): THREE.Vector3 {
    const phi = ((90 - latDeg) * Math.PI) / 180;
    const theta = ((lonDeg + 180) * Math.PI) / 180;
    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    return new THREE.Vector3(x, y, z);
  }

  private makeStarField(): THREE.Points {
    const n = 1800;
    const positions = new Float32Array(n * 3);
    const rMin = 18;
    const rMax = 42;
    for (let i = 0; i < n; i++) {
      const r = rMin + Math.random() * (rMax - rMin);
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.cos(phi);
      const z = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xdde8ff,
      size: 0.065,
      depthWrite: false,
      opacity: 0.92,
      transparent: true,
      fog: false,
      sizeAttenuation: true
    });
    const pts = new THREE.Points(geo, mat);
    pts.visible = this.starsEnabled;
    return pts;
  }

  private resizeRendererToHost(): void {
    const host = this.globeCanvasHost?.nativeElement;
    const r = this.renderer;
    const c = this.camera;
    if (!host || !r || !c || host.clientWidth < 2 || host.clientHeight < 2) {
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    r.setPixelRatio(globePixelRatioCap());
    r.setSize(w, h, false);
    c.aspect = w / h;
    c.updateProjectionMatrix();
  }

  private startLoop(): void {
    const loop = (): void => {
      this.rafId = requestAnimationFrame(loop);
      const controls = this.controls;
      const renderer = this.renderer;
      const scene = this.scene;
      const camera = this.camera;
      if (!controls || !renderer || !scene || !camera) {
        return;
      }
      if (this.cloudsMesh) {
        this.cloudsDriftRad += 0.00012;
        this.cloudsMesh.rotation.y = Math.PI + this.cloudsDriftRad;
      }
      if (this.realTimeTerminator) {
        this.updateSunDirectionFromTime(new Date());
      }
      if (this.globeGeocodeMarkerLat != null && this.globeGeocodeMarkerLon != null) {
        this.updateGeocodeMarkerWorldPosition();
      }
      this.syncOrbitControlsSensitivity();
      controls.update();
      renderer.render(scene, camera);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private disposeSceneHierarchy(): void {
    if (!this.scene) {
      return;
    }
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => {
            this.disposeMaterialMaps(m);
            m.dispose();
          });
        } else if (mat) {
          this.disposeMaterialMaps(mat);
          mat.dispose();
        }
      } else if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => {
            this.disposeMaterialMaps(m);
            m.dispose();
          });
        } else if (mat) {
          this.disposeMaterialMaps(mat);
          mat.dispose();
        }
      } else if (obj instanceof THREE.Line) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) {
          mat.forEach((m) => m.dispose());
        } else if (mat) {
          mat.dispose();
        }
      } else if (obj instanceof THREE.Points) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      }
    });
  }

  private disposeMaterialMaps(material: THREE.Material): void {
    const texKeys = ['map', 'bumpMap', 'normalMap', 'specularMap', 'roughnessMap', 'metalnessMap'] as const;
    const m = material as unknown as Record<string, THREE.Texture | undefined>;
    for (const k of texKeys) {
      const t = m[k];
      t?.dispose?.();
    }
  }
}
