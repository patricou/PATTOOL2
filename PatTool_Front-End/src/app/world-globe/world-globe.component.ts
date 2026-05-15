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
import { TranslateModule } from '@ngx-translate/core';
import { Subscription, firstValueFrom, timeout } from 'rxjs';
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
import { Body, GeoVector, KM_PER_AU, Vector, VectorObserver } from 'astronomy-engine';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';

export interface WorldGlobeMarker {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly labelKey: string;
}

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
  private readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('globeCanvasHost') globeCanvasHost?: ElementRef<HTMLElement>;
  @ViewChild('globeShell') globeShell?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceMount') globeTraceMount?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceViewer') globeTraceViewer?: TraceViewerModalComponent;

  showOptionsPanel = true;
  cloudsEnabled = true;
  starsEnabled = true;
  autoRotate = false;
  demoMarkersEnabled = true;
  /** Fond pseudo-satellite (NASA BMNG) vs texture Three.js classique avec relief/spec. */
  basemapSatellite = false;
  /** Couche indicative type « météo » : précipitations estimées (NASA GIBS, dernier jour UTC). */
  weatherImageryEnabled = false;
  weatherImageryLoading = false;
  weatherImageryFailed = false;
  /** Points + polyligne d’activités géocodées. */
  activityLayerVisible = true;
  /**
   * Terminateur jour/nuit selon la position réelle du Soleil (UTC, horloge du navigateur).
   * À false : éclairage uniforme (pas de limite jour/nuit).
   */
  realTimeTerminator = false;
  /**
   * Soleil directionnel aligné sur la position géographique de l’utilisateur (géolocalisation).
   * Activé par défaut ; désactivé implicitement lorsque « jour/nuit réaliste » est actif.
   */
  lightFromMyLocationEnabled = true;
  /** Géoloc en cours pour le bouton Actualiser */
  userGeoLightingLoading = false;
  /** Dernière géolocalisation réussie (sinon fallback France jusqu’à succès). */
  userLightingGeoOk = false;

  /** Terre visible (rayon / clic carte OSM disponible). */
  globeSurfaceReady = false;
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

  readonly demoMarkers: WorldGlobeMarker[] = [
    { latDeg: 48.8566, lonDeg: 2.3522, labelKey: 'WORLD_GLOBE.MARKER_PARIS' },
    { latDeg: 40.7128, lonDeg: -74.006, labelKey: 'WORLD_GLOBE.MARKER_NYC' },
    { latDeg: 35.6762, lonDeg: 139.6503, labelKey: 'WORLD_GLOBE.MARKER_TOKYO' }
  ];

  /** Pour le template : navigateur sans Geolocation API. */
  get userLightingGeoApiAvailable(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
  }

  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private earthMesh?: THREE.Mesh;
  /** Textures utilisées dans le fond « carte » avant bascule satellite. */
  private standardEarthTextures: {
    readonly map: THREE.Texture;
    spec: THREE.Texture | null;
    bump: THREE.Texture | null;
  } | null = null;
  private satelliteTexture: THREE.Texture | null = null;
  private cloudsMesh?: THREE.Mesh;
  private starsPoints?: THREE.Points;
  /** Exemple Paris / NYC / Tokyo. */
  private markersRoot?: THREE.Group;
  private weatherOverlayMesh?: THREE.Mesh;
  private weatherOverlayTexture: THREE.Texture | null = null;
  private activityRoot?: THREE.Group;
  private ambientLight?: THREE.AmbientLight;
  private sunLight?: THREE.DirectionalLight;
  /** Distance fictive du soleil directionnel (les rayons restent parallèles). */
  private static readonly SUN_LIGHT_DISTANCE = 50;
  private static readonly EARTH_MEAN_RADIUS_KM = 6371;

  private rafId: number | null = null;
  private resizeObs?: ResizeObserver;
  /** Rotation lente nuages vs sol (effet léger façon couches atmosphériques). */
  private cloudsDriftRad = 0;
  private eventsStreamSub?: Subscription;
  private activitiesStreamFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Dernière position navigateur pour l’éclairage « depuis ma position » ; null avant succès ou si refus. */
  private userLightingLat: number | null = null;
  private userLightingLon: number | null = null;

  private pendingDetailLat = 0;
  private pendingDetailLon = 0;
  private pendingDetailZoom = 8;

  private readonly raycasterNd = new THREE.Raycaster();
  private readonly ndcCenter = new THREE.Vector2(0, 0);
  private readonly earthInvScratch = new THREE.Matrix4();
  private readonly localScratch = new THREE.Vector3();

  ngAfterViewInit(): void {
    queueMicrotask(() => this.bootstrapThree());
    this.requestInitialUserLightingGeolocation();
  }

  ngOnDestroy(): void {
    this.globeTraceViewer?.close();
    this.globeSurfaceReady = false;
    if (this.activitiesStreamFinalizeTimer != null) {
      clearTimeout(this.activitiesStreamFinalizeTimer);
      this.activitiesStreamFinalizeTimer = null;
    }
    this.eventsStreamSub?.unsubscribe();
    this.disposeWeatherOverlayMesh();
    this.stopLoop();
    this.resizeObs?.disconnect();
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
    const pick = this.pickGlobeCenterLatLon();
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
    const hits = this.raycasterNd.intersectObject(this.earthMesh, false);
    if (!hits.length) {
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

  onGlobeLightingModeChange(): void {
    if (!this.realTimeTerminator && this.lightFromMyLocationEnabled && !this.userLightingGeoOk && typeof navigator !== 'undefined' && navigator.geolocation) {
      this.fetchUserLightingPosition(false);
    }
    this.syncGlobeLighting();
  }

  onLightFromMyLocationChange(): void {
    if (this.lightFromMyLocationEnabled && !this.realTimeTerminator) {
      this.syncGlobeLighting();
      if (!this.userLightingGeoOk && typeof navigator !== 'undefined' && navigator.geolocation) {
        this.fetchUserLightingPosition(false);
      }
    } else {
      this.syncGlobeLighting();
    }
  }

  /** Bouton : relance la géolocalisation pour repositionner le soleil directionnel. */
  refreshUserGeolocationForLighting(): void {
    if (this.realTimeTerminator || !this.lightFromMyLocationEnabled) {
      return;
    }
    this.fetchUserLightingPosition(false);
  }

  private requestInitialUserLightingGeolocation(): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.userLightingGeoOk = false;
      this.cdr.markForCheck();
      return;
    }
    this.fetchUserLightingPosition(true);
  }

  /**
   * @param silentInitial si vrai (premier chargement), ne pas afficher l’état « chargement » sur le bouton.
   */
  private fetchUserLightingPosition(silentInitial: boolean): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.userLightingGeoOk = false;
      this.syncGlobeLighting();
      this.cdr.markForCheck();
      return;
    }
    if (!silentInitial) {
      this.userGeoLightingLoading = true;
      this.cdr.markForCheck();
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.userGeoLightingLoading = false;
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          this.userLightingGeoOk = false;
          this.userLightingLat = null;
          this.userLightingLon = null;
        } else {
          this.userLightingLat = lat;
          this.userLightingLon = lon;
          this.userLightingGeoOk = true;
        }
        if (!this.realTimeTerminator) {
          this.syncGlobeLighting();
        }
        this.cdr.markForCheck();
      },
      () => {
        this.userGeoLightingLoading = false;
        this.userLightingGeoOk = false;
        this.userLightingLat = null;
        this.userLightingLon = null;
        if (!this.realTimeTerminator) {
          this.syncGlobeLighting();
        }
        this.cdr.markForCheck();
      },
      { maximumAge: 120_000, timeout: 14_000, enableHighAccuracy: false }
    );
  }

  onStarsToggle(): void {
    if (this.starsPoints) {
      this.starsPoints.visible = this.starsEnabled;
    }
  }

  onMarkersToggle(): void {
    if (this.markersRoot) {
      this.markersRoot.visible = this.demoMarkersEnabled;
    }
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
   */
  private frameCameraOnLatLon(latDeg: number, lonDeg: number, distance: number): void {
    if (!this.camera || !this.controls) {
      return;
    }
    const radial = WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, 1);
    const len = radial.length();
    if (len < 1e-12) {
      return;
    }
    radial.multiplyScalar(distance / len);
    const yLift = 0.22;
    this.camera.position.set(radial.x, radial.y + yLift, radial.z);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
    if (this.earthMesh) {
      this.earthMesh.rotation.set(0, Math.PI, 0);
      this.cloudsDriftRad = 0;
    }
    if (this.cloudsMesh) {
      this.cloudsMesh.rotation.y = Math.PI + this.cloudsDriftRad;
    }
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

  /** Ambiant fort + soleil léger sans terminateur ; jour/nuit astronomique ; ou éclairage depuis la position utilisateur. */
  private syncGlobeLighting(): void {
    const amb = this.ambientLight;
    const sun = this.sunLight;
    if (!amb || !sun) {
      return;
    }
    if (this.realTimeTerminator) {
      amb.intensity = 0.18;
      sun.intensity = 2.85;
      this.updateSunDirectionFromTime(new Date());
      return;
    }
    if (this.lightFromMyLocationEnabled) {
      amb.intensity = 0.18;
      sun.intensity = 2.85;
      const { lat, lon } = this.getUserLightingLatLonOrFallback();
      this.updateSunDirectionFromUserLatLon(lat, lon);
      return;
    }
    amb.intensity = 0.92;
    sun.intensity = 0.32;
    sun.position.set(4, 0.6, 2);
  }

  /** Tant que la géoloc n’a pas réussi : France (même centre que la vue initiale). */
  private getUserLightingLatLonOrFallback(): { lat: number; lon: number } {
    if (
      this.userLightingLat != null &&
      this.userLightingLon != null &&
      Number.isFinite(this.userLightingLat) &&
      Number.isFinite(this.userLightingLon)
    ) {
      return { lat: this.userLightingLat, lon: this.userLightingLon };
    }
    return { lat: GLOBE_INITIAL_FRANCE_LAT, lon: GLOBE_INITIAL_FRANCE_LON };
  }

  /** Soleil « au zénith » au-dessus du point (lat, lon) sur le globe (comme le jour/nuit réaliste). */
  private updateSunDirectionFromUserLatLon(latDeg: number, lonDeg: number): void {
    const sun = this.sunLight;
    if (!sun) {
      return;
    }
    const k = WorldGlobeComponent.SUN_LIGHT_DISTANCE;
    const v = WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, k);
    sun.position.set(v.x, v.y, v.z);
  }

  /**
   * Aligne la lumière avec le sous-point solaire (limite jour/nuit cohérente avec la texture géographique).
   */
  private updateSunDirectionFromTime(date: Date): void {
    const sun = this.sunLight;
    if (!sun) {
      return;
    }
    const gv = GeoVector(Body.Sun, date, true);
    const d = Math.hypot(gv.x, gv.y, gv.z);
    if (d < 1e-14) {
      return;
    }
    const rAu = WorldGlobeComponent.EARTH_MEAN_RADIUS_KM / KM_PER_AU;
    const surf = new Vector((gv.x / d) * rAu, (gv.y / d) * rAu, (gv.z / d) * rAu, gv.t);
    const obs = VectorObserver(surf, false);
    const toSun = WorldGlobeComponent.latLonToVector3(obs.latitude, obs.longitude, 1);
    const k = WorldGlobeComponent.SUN_LIGHT_DISTANCE;
    sun.position.set(toSun.x * k, toSun.y * k, toSun.z * k);
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

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 1.02;
    controls.maxDistance = 7;
    controls.enablePan = true;
    controls.autoRotate = this.autoRotate;
    controls.autoRotateSpeed = 0.35;

    const ambient = new THREE.AmbientLight(0xffffff, 0.18);
    scene.add(ambient);
    this.ambientLight = ambient;
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.85);
    sunLight.position.set(4, 0.6, 2);
    scene.add(sunLight);

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
          this.buildMarkers(scene);
        },
        undefined,
        () => this.buildMarkers(scene)
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
        scene.add(earth);
        this.earthMesh = earth;
        this.globeSurfaceReady = true;
        this.standardEarthTextures = null;
        this.buildMarkers(scene);
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
      this.activityLayerVisible = true;
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

  private disposeMarkersRoot(scene: THREE.Scene): void {
    if (!this.markersRoot) {
      return;
    }
    scene.remove(this.markersRoot);
    this.markersRoot.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.markersRoot = undefined;
  }

  private buildMarkers(scene: THREE.Scene): void {
    this.disposeMarkersRoot(scene);
    const surfaceR = 1.021;
    const alongNormal = 0.004;

    /** Anneau fin + point central, tons froids ; plus discret que les grosses sphères rouges. */
    const ringGeo = new THREE.RingGeometry(0.0065, 0.0105, 56);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xb8e8f5,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const ringInst = new THREE.InstancedMesh(ringGeo, ringMat, this.demoMarkers.length);

    const dotGeo = new THREE.CircleGeometry(0.0028, 32);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xeaf8fc,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const dotInst = new THREE.InstancedMesh(dotGeo, dotMat, this.demoMarkers.length);

    const m4 = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const unitScale = new THREE.Vector3(1, 1, 1);

    this.demoMarkers.forEach((dm, i) => {
      v.copy(WorldGlobeComponent.latLonToVector3(dm.latDeg, dm.lonDeg, surfaceR));
      n.copy(v).normalize();
      v.addScaledVector(n, alongNormal);
      q.setFromUnitVectors(zAxis, n);
      m4.compose(v, q, unitScale);
      ringInst.setMatrixAt(i, m4);
      dotInst.setMatrixAt(i, m4);
    });
    ringInst.instanceMatrix.needsUpdate = true;
    dotInst.instanceMatrix.needsUpdate = true;

    const grp = new THREE.Group();
    grp.add(ringInst);
    grp.add(dotInst);
    grp.visible = this.demoMarkersEnabled;
    scene.add(grp);
    this.markersRoot = grp;
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
      size: 0.045,
      depthWrite: false,
      opacity: 0.85,
      transparent: true
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
