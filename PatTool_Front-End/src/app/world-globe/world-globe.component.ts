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
import { MembersService } from '../services/members.service';
import { Evenement } from '../model/evenement';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { environment } from '../../environments/environment';
import { Body, GeoVector, KM_PER_AU, Vector, VectorObserver } from 'astronomy-engine';
import * as L from 'leaflet';

export interface WorldGlobeMarker {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly labelKey: string;
}

/** Plus de subdivisions pour des courbes lisibles très zoomées (sans tuiles HR). */
const GLOBE_EARTH_SEGMENTS = 256;
const GLOBE_CLOUDS_SEGMENTS = 192;
const GLOBE_OVERLAY_SEGMENTS = 192;

function globePixelRatioCap(): number {
  return Math.min(window.devicePixelRatio, 3);
}

@Component({
  selector: 'app-world-globe',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  templateUrl: './world-globe.component.html',
  styleUrls: ['./world-globe.component.css'],
  providers: [EvenementsService]
})
export class WorldGlobeComponent implements AfterViewInit, OnDestroy {
  private readonly apiService = inject(ApiService);
  private readonly evenementsService = inject(EvenementsService);
  private readonly membersService = inject(MembersService);
  private readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('globeCanvasHost') globeCanvasHost?: ElementRef<HTMLElement>;
  @ViewChild('globeShell') globeShell?: ElementRef<HTMLElement>;
  @ViewChild('detailMapHost') detailMapHost?: ElementRef<HTMLElement>;

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

  /** Terre visible (rayon / clic carte OSM disponible). */
  globeSurfaceReady = false;
  /** Panneau carte 2D (tuiles OSM), centré sur le point au milieu du globe. */
  detailMapOpen = false;
  detailMapPickFailed = false;

  fullscreen = false;
  textureLoadError = false;

  activitiesLoading = false;
  activitiesPlaced = 0;
  activitiesSkipped = 0;
  activitiesBanner: 'idle' | 'loading' | 'done' | 'none' | 'login' | 'error' = 'idle';

  readonly demoMarkers: WorldGlobeMarker[] = [
    { latDeg: 48.8566, lonDeg: 2.3522, labelKey: 'WORLD_GLOBE.MARKER_PARIS' },
    { latDeg: 40.7128, lonDeg: -74.006, labelKey: 'WORLD_GLOBE.MARKER_NYC' },
    { latDeg: 35.6762, lonDeg: 139.6503, labelKey: 'WORLD_GLOBE.MARKER_TOKYO' }
  ];

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

  private detailLeafletMap?: L.Map;
  private pendingDetailLat = 0;
  private pendingDetailLon = 0;
  private pendingDetailZoom = 8;

  private readonly raycasterNd = new THREE.Raycaster();
  private readonly ndcCenter = new THREE.Vector2(0, 0);
  private readonly earthInvScratch = new THREE.Matrix4();
  private readonly localScratch = new THREE.Vector3();

  ngAfterViewInit(): void {
    queueMicrotask(() => this.bootstrapThree());
  }

  ngOnDestroy(): void {
    this.teardownDetailMap();
    this.globeSurfaceReady = false;
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
  }

  openDetailMapOverlay(): void {
    if (!this.globeSurfaceReady || !this.earthMesh || !this.camera || !this.renderer) {
      return;
    }
    const pick = this.pickLatLonAtGlobeCenter();
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
      requestAnimationFrame(() => this.mountDetailLeafletIfReady());
    });
  }

  closeDetailMapOverlay(): void {
    this.teardownDetailMap();
    this.detailMapOpen = false;
    this.cdr.markForCheck();
  }

  private mountDetailLeafletIfReady(): void {
    const el = this.detailMapHost?.nativeElement;
    if (!el || !this.detailMapOpen) {
      return;
    }
    this.teardownDetailMap();
    const map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      dragging: true
    }).setView([this.pendingDetailLat, this.pendingDetailLon], this.pendingDetailZoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abc',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    this.detailLeafletMap = map;
    window.setTimeout(() => {
      map.invalidateSize(true);
    }, 220);
    window.setTimeout(() => {
      map.invalidateSize(true);
    }, 620);
  }

  private teardownDetailMap(): void {
    if (!this.detailLeafletMap) {
      return;
    }
    try {
      this.detailLeafletMap.off();
      this.detailLeafletMap.remove();
    } catch {
      /* ignore */
    }
    this.detailLeafletMap = undefined;
    const host = this.detailMapHost?.nativeElement;
    if (host && host.childNodes?.length) {
      host.innerHTML = '';
    }
  }

  private pickLatLonAtGlobeCenter(): { lat: number; lon: number } | null {
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
    return WorldGlobeComponent.worldGlobeHitToLatLon(
      hits[0].point,
      this.earthMesh,
      this.earthInvScratch,
      this.localScratch
    );
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
    this.syncGlobeLighting();
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
    this.cdr.markForCheck();
    this.eventsStreamSub?.unsubscribe();

    const bucket: Evenement[] = [];
    this.eventsStreamSub = this.evenementsService.streamEvents('', user.id, 'all', false).subscribe({
      next: (evt: StreamedEvent) => {
        if (evt.type === 'event' && evt.data && typeof evt.data === 'object') {
          bucket.push(evt.data as Evenement);
        }
      },
      error: () => {
        this.activitiesLoading = false;
        this.activitiesBanner = 'error';
        this.cdr.markForCheck();
      },
      complete: () => {
        void this.geocodeAndRenderActivities(bucket);
      }
    });
  }

  onAutoRotateToggle(): void {
    if (this.controls) {
      this.controls.autoRotate = this.autoRotate;
    }
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.camera.position.set(0, 0.35, 2.6);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    if (this.earthMesh) {
      this.earthMesh.rotation.set(0, 0, 0);
      this.cloudsDriftRad = 0;
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

  /** Ambiant fort + soleil léger sans terminateur ; sinon soleil directionnel fort + position temps réel. */
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
    } else {
      amb.intensity = 0.92;
      sun.intensity = 0.32;
      sun.position.set(4, 0.6, 2);
    }
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
    camera.position.set(0, 0.35, 2.6);

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

  private async geocodeAndRenderActivities(events: Evenement[]): Promise<void> {
    this.activitiesLoading = true;
    this.cdr.markForCheck();
    try {
      const withLoc = events.filter((e) => e.startLocation?.trim());
      const sorted = [...withLoc].sort(
        (a, b) =>
          new Date(a.beginEventDate as unknown as string).getTime() -
          new Date(b.beginEventDate as unknown as string).getTime()
      );
      const maxPoints = 42;
      const pts: Array<{ lat: number; lon: number }> = [];
      let skipped = 0;
      for (const ev of sorted) {
        if (pts.length >= maxPoints) {
          break;
        }
        const loc = ev.startLocation!.trim();
        const parsed = WorldGlobeComponent.tryParseLatLon(loc);
        let lat: number | undefined;
        let lon: number | undefined;
        if (parsed) {
          lat = parsed.lat;
          lon = parsed.lon;
        } else {
          try {
            const res = await firstValueFrom(
              this.apiService.geocodeSearch(loc).pipe(timeout(15000))
            );
            const first = res?.[0] as { lat?: number; lon?: number } | undefined;
            if (
              first &&
              typeof first.lat === 'number' &&
              typeof first.lon === 'number' &&
              Number.isFinite(first.lat) &&
              Number.isFinite(first.lon)
            ) {
              lat = first.lat;
              lon = first.lon;
            } else {
              skipped++;
              continue;
            }
          } catch {
            skipped++;
            continue;
          }
          await WorldGlobeComponent.delayMs(450);
        }
        if (lat != null && lon != null) {
          pts.push({ lat, lon });
        }
      }
      this.activitiesPlaced = pts.length;
      this.activitiesSkipped = skipped;
      if (this.scene) {
        this.buildActivityOverlay(this.scene, pts);
      }
      this.activityLayerVisible = true;
      this.activitiesBanner = pts.length ? 'done' : 'none';
      if (!withLoc.length) {
        this.activitiesBanner = 'none';
      }
    } catch {
      this.activitiesBanner = 'error';
    } finally {
      this.activitiesLoading = false;
      this.cdr.markForCheck();
    }
  }

  private buildActivityOverlay(
    scene: THREE.Scene,
    pts: readonly { lat: number; lon: number }[]
  ): void {
    this.disposeActivityScene(scene);
    const group = new THREE.Group();
    const rLine = 1.027;

    if (pts.length >= 2) {
      const vertices: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = WorldGlobeComponent.latLonToVector3(pts[i].lat, pts[i].lon, rLine);
        const b = WorldGlobeComponent.latLonToVector3(pts[i + 1].lat, pts[i + 1].lon, rLine);
        const arc = WorldGlobeComponent.greatCircleArc(a, b, rLine, 56);
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
            color: 0x5fd4a8,
            transparent: true,
            opacity: 0.55,
            depthWrite: false
          })
        );
        group.add(line);
      }
    }

    if (pts.length > 0) {
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
      const ringInst = new THREE.InstancedMesh(ringGeo, ringMat, pts.length);
      const dotInst = new THREE.InstancedMesh(dotGeo, dotMat, pts.length);
      const m4 = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const zAxis = new THREE.Vector3(0, 0, 1);
      pts.forEach((p, i) => {
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
      queueMicrotask(() => this.detailLeafletMap?.invalidateSize(true));
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    r.setPixelRatio(globePixelRatioCap());
    r.setSize(w, h, false);
    c.aspect = w / h;
    c.updateProjectionMatrix();
    queueMicrotask(() => this.detailLeafletMap?.invalidateSize(true));
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
