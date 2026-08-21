import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, firstValueFrom, timeout } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { ApiService, GlobeIssGlobalPrefs, GlobeSatelliteOverlayPrefs, IssAlertAdminEntry, IssAlertConfig } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { GlobeIssNowService, GlobeIssNowSnapshot } from '../services/globe-iss-now.service';
import { GlobeSatelliteNowService } from '../services/globe-satellite-now.service';
import { ASTRO_ISS, GLOBE_OVERLAY_SATELLITES, findSatelliteById, satelliteInGlobeMasterToggle, satelliteUsesNetworkTle, type AstroSatelliteOption } from '../astro-compass/astro-compass-catalog';
import { AstroObjectDossierService, type ObjectDossier } from '../astro-compass/astro-object-dossier.service';
import { AirportIcaoEntry, AirportLookupService } from '../services/airport-lookup.service';
import { PositionService } from '../services/position.service';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { environment } from '../../environments/environment';
import { Body, Equator, Observer, SiderealTime, KM_PER_AU } from 'astronomy-engine';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import {
  SlideshowModalComponent,
  SlideshowImageSource
} from '../shared/slideshow-modal/slideshow-modal.component';
import { drawIssTopViewIcon } from '../shared/globe-iss-icon.util';
import earcut from 'earcut';

/** Réponse proxifiée ISS (/api/external/globe/iss/now). */
interface GlobeOpenNotifyIssResponse {
  message?: string;
  iss_position?: {
    latitude?: string;
    longitude?: string;
    altitude_km?: string;
    velocity_kmh?: string;
  };
}

/** Réponse /api/external/globe/iss/passes-by-place (géocode + Open Notify). */
interface IssPassSummaryItem {
  risetime?: number;
  duration?: number;
  riseAzimuth?: number;
  maxElevation?: number;
  setAzimuth?: number;
}

interface IssPassByPlaceResponse {
  status?: string;
  code?: string;
  message?: string;
  place?: { lat?: number; lon?: number; displayName?: string };
  nextPass?: IssPassSummaryItem;
  passes?: {
    message?: string;
    response?: IssPassSummaryItem[];
  };
  candidates?: Array<{ lat: number; lon: number; displayName?: string }>;
}

interface IssAlertPassesUiState {
  loading: boolean;
  error: string;
  lines: string[];
  open: boolean;
}

/** Point ISS historique (MongoDB, GET /api/external/globe/iss/trace). */
interface IssTracePointDto {
  latitude: number;
  longitude: number;
  recordedAt: string;
}

interface IssTraceResponse {
  points: IssTracePointDto[];
  retentionDays: number;
  sampleIntervalSeconds: number;
}

/** Point ISS prédit (GET /api/external/globe/iss/forecast). */
interface IssForecastPointDto {
  latitude: number;
  longitude: number;
  timestamp: number;
}

interface IssForecastResponse {
  minutes: number;
  stepSec: number;
  approximate?: boolean;
  points: IssForecastPointDto[];
}

interface GlobeSatellitePass {
  riseAt: Date;
  setAt: Date;
  maxElevationDeg: number;
  maxAt: Date;
}

interface GlobeSatelliteInfoSnapshot {
  lat: number;
  lon: number;
  altKm: number | null;
  velocityKmh: number | null;
  azimuthDeg: number | null;
  elevationDeg: number | null;
  groundKm: number | null;
  slantKm: number | null;
  visible: boolean;
}

/** Plus de subdivisions pour des courbes lisibles très zoomées (sans tuiles HR). */
const GLOBE_EARTH_SEGMENTS = 256;
const GLOBE_CLOUDS_SEGMENTS = 192;

const GLOBE_OVERLAY_SEGMENTS = 192;
/** Fallback si la position ISS n’est pas disponible (centroïde France métropolitaine). */
const GLOBE_INITIAL_FRANCE_LAT = 46.4;
const GLOBE_INITIAL_FRANCE_LON = 2.2;
/** Distance caméra par défaut (vue ISS ou fallback). */
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
/** Durée du vol caméra après réinitialisation de la vue (bouton Réinit.). */
const GLOBE_RESET_VIEW_ANIM_MS = 1500;
/** Durée du vol caméra initial vers l’ISS à l’ouverture du globe (réseau sans cache). */
const GLOBE_INITIAL_ISS_ANIM_MS = 1200;
/** Retour viseur → globe : départ un peu zoomé, puis dézoom fluide jusqu’à la Terre entière. */
const GLOBE_ASTRO_RETURN_START_DISTANCE = 1.48;
const GLOBE_ASTRO_RETURN_ANIM_MS = 2100;

/** Flux ISS en direct (Destination Orbite) — nouvel onglet navigateur. */
const ISS_LIVE_DESTINATION_ORBITE_URL =
	'https://destination-orbite.net/exploration/direct/en-direct-depuis-la-station-spatiale';
const ISS_LIVE_HD_DESTINATION_ORBITE_URL =
	'https://destination-orbite.net/exploration/direct/en-direct-hd-depuis-l-iss';
/**
 * IDs YouTube embarqués par Destination Orbite (balise lite-youtube sur leurs pages direct).
 * Standard : flux NASA officiel — https://www.youtube.com/watch?v=M3HKLzjvKPc
 * HD : https://www.youtube.com/watch?v=awQzjn72bI0
 */
/** Page standard Destination Orbite → lite-youtube `M3HKLzjvKPc` (màj 10-08-2026 ; ancien `uwXgcTc8oY8` hors ligne). */
const ISS_LIVE_YOUTUBE_VIDEO_ID = 'M3HKLzjvKPc';
/** Page HD Destination Orbite → lite-youtube `awQzjn72bI0` (màj 06-11-2025 ; ancien `FuuC4dpSQ1M` hors ligne). */
const ISS_LIVE_HD_YOUTUBE_VIDEO_ID = 'awQzjn72bI0';
/** Vitesse de la lumière pour la distance observateur → satellite (s lum.). */
const C_KM_PER_S = 299792.458;

/** Sphère repère géocodage : rayon monde, légèrement au-dessus du maillage Terre (rayon 1). */
const GLOBE_GEOCODE_MARKER_SURFACE_OFFSET = 1.003;
const GLOBE_GEOCODE_MARKER_RADIUS = 0.0022;

/** Trait de frontière au-dessus du sol (Terre rayon 1), sous les nuages (~1.025). */
const GLOBE_BORDERS_LINE_RADIUS = 1.009;
const MAX_BORDER_LINE_SEGMENTS = 220_000;
/** Ligne de rivage Natural Earth (~110 m). */
const GLOBE_COASTLINE_LINE_RADIUS = 1.008;
const MAX_COASTLINE_LINE_SEGMENTS = 120_000;
/** Remplissage « carte » politique pastel (polygones Natural Earth pays 110 m, au-dessus du basemap). */
const GLOBE_POLITICAL_FILL_RADIUS = 1.0054;
/** Étiquettes noms pays Natural Earth (`LABEL_X` / `LABEL_Y`). */
const GLOBE_COUNTRY_LABEL_RADIUS = 1.015;
const GLOBE_ADMIN0_MAX_FAN_TRIANGLES = 72_000;
/** Sous-échantillonnage des anneaux (lon/lat) avant earcut ; budget triangles global ci-dessous. */
const GLOBE_ADMIN0_RING_MAX_VERTS = 200;
/** Hauteur monde approximative d’une carte pastille étiquette (multipliée par `updateCountryLabelsScaleForZoom`). */
const GLOBE_COUNTRY_LABEL_SPRITE_WORLD_H = 0.028;
/** Plus la caméra est proche, plus les étiquettes sont réduites (interpolation sur la plage OrbitControls). */
const GLOBE_COUNTRY_LABEL_ZOOM_MIN_MUL = 0.34;
const GLOBE_COUNTRY_LABEL_ZOOM_GAMMA = 0.72;
/** Graticule géographique léger sous les autres surcouches. */
const GLOBE_GRATICULE_RADIUS = 1.0048;
const GLOBE_GRATICULE_STEP_DEG = 15;
const GLOBE_GRATICULE_MERIDIAN_LAT_STEP = 3;
const GLOBE_GRATICULE_PARALLEL_LON_STEP = 12;
const MAX_GRATICULE_LINE_SEGMENTS = 70_000;
/** ~420 km (sphère R_earth = 6371 km). */
const GLOBE_ISS_ORBIT_RADIUS = 1 + 420 / 6371;
/** Traînée ISS : légèrement sous le marqueur pour limiter le z-fighting. */
const GLOBE_ISS_TRAIL_RADIUS = GLOBE_ISS_ORBIT_RADIUS * 0.997;
/** Traînée live ISS (court passé récent) : jaune-or — pas rouge. */
const GLOBE_ISS_LIVE_TRAIL_COLOR = 0xffcc66;
const GLOBE_ISS_TRAIL_COLOR = GLOBE_ISS_LIVE_TRAIL_COLOR;
const GLOBE_ISS_TRAIL_OPACITY = 0.82;
/** Trace historique MongoDB : ambre — distincte de la prédiction rouge. */
const GLOBE_ISS_HISTORICAL_TRAIL_COLOR = 0xf0a030;
const GLOBE_ISS_HISTORICAL_TRAIL_OPACITY = 0.68;
/** Taille monde de l’icône ISS (vue de dessus, panneaux solaires). */
const GLOBE_ISS_ICON_WORLD_SIZE = 0.034;
const GLOBE_ISS_MARKER_COLOR = 0xffea00;
/**
 * Zone au sol depuis laquelle l’ISS est visible (élévation ≥ seuil, sphère Re = 6371 km).
 * Le rayon au sol = Re × γ avec γ résolu sur la courbure (pas de modèle plan).
 */
const GLOBE_ISS_VISIBILITY_MIN_ELEVATION_DEG = 10;
/** Recadrage satellite : cercle plus petit que la zone ISS (fraction + plafond d’angle). */
const GLOBE_SAT_VISIBILITY_CIRCLE_SCALE = 0.22;
const GLOBE_SAT_VISIBILITY_CIRCLE_MAX_GAMMA = 0.07;
const GLOBE_EARTH_RADIUS_KM = 6371;
const GLOBE_ISS_VISIBILITY_FILL_RADIUS = 1.007;
const GLOBE_ISS_VISIBILITY_CIRCLE_RADIUS = 1.0078;
/** Dégradé radial de la calotte : opacité au sous-point ISS / au bord. */
const GLOBE_ISS_VISIBILITY_FILL_OPACITY_CENTER = 0.55;
const GLOBE_ISS_VISIBILITY_FILL_OPACITY_EDGE = 0.0;
const GLOBE_ISS_VISIBILITY_FILL_INNER_COLOR = 0xffff66;
const GLOBE_ISS_VISIBILITY_FILL_OUTER_COLOR = 0xff7700;
const GLOBE_ISS_VISIBILITY_CIRCLE_COLOR = 0xffea00;
const GLOBE_ISS_VISIBILITY_CIRCLE_OPACITY = 0.72;
const GLOBE_ISS_VISIBILITY_CIRCLE_SEGMENTS = 96;
/** Anneaux radiaux de la calotte (surface sphérique, pas cordes planes). */
const GLOBE_ISS_VISIBILITY_CAP_RADIAL_RINGS = 12;
/** Historique de positions pour la traînée (une entrée par rafraîchissement utile). */
const GLOBE_ISS_TRAIL_MAX_POINTS = 96;
/** Traînée historique MongoDB : légèrement sous la traînée live. */
const GLOBE_ISS_HISTORICAL_TRAIL_RADIUS = GLOBE_ISS_TRAIL_RADIUS * 0.995;
const GLOBE_ISS_HISTORICAL_TRAIL_ARC_SEGMENTS = 8;
/** Étiquettes date/heure le long de la trace historique ISS (1/min, plafond sécurité WebGL). */
const GLOBE_ISS_TRACE_SAMPLE_INTERVAL_SEC_DEFAULT = 60;
/** Do not connect two historical trace points more than 90 min apart (tracking gaps). */
const GLOBE_ISS_TRACE_MAX_SEGMENT_GAP_MS = 90 * 60 * 1000;
const GLOBE_ISS_HISTORICAL_DATE_LABEL_MAX = 1440;
const GLOBE_ISS_HISTORICAL_DATE_LABEL_SPRITE_WORLD_H = 0.022;
const GLOBE_ISS_HISTORICAL_DATE_LABEL_RADIUS = GLOBE_ISS_HISTORICAL_TRAIL_RADIUS * 1.004;
/** Segments par segment de traînée (grand cercle entre deux relevés). */
const GLOBE_ISS_TRAIL_ARC_SEGMENTS = 14;
/** Trace ISS anticipée (prédiction SGP4) : rouge, légèrement au-dessus de la traînée live. */
const GLOBE_ISS_FORECAST_STEP_SEC = 120;
const GLOBE_ISS_FORECAST_TRAIL_RADIUS = GLOBE_ISS_TRAIL_RADIUS * 1.003;
const GLOBE_ISS_FORECAST_TRAIL_COLOR = 0xff2e2e;
const GLOBE_ISS_FORECAST_TRAIL_OPACITY = 0.88;
const GLOBE_ISS_FORECAST_TRAIL_ARC_SEGMENTS = 10;
/** Rafraîchissement trace anticipée ( plusieurs requêtes upstream ). */
const GLOBE_ISS_FORECAST_REFRESH_MIN_MS = 120_000;
/** Intervalle par défaut entre deux appels Open Notify (secondes). */
const GLOBE_ISS_POLL_DEFAULT_SEC = 2;
const GLOBE_ISS_POLL_MIN_SEC = 2;
const GLOBE_ISS_POLL_MAX_SEC = 600;
/** Throttle du reverse-geocoding « survol » ISS : intervalle mini et déplacement mini avant un nouvel appel Nominatim. */
const GLOBE_ISS_OVER_MIN_INTERVAL_MS = 9000;
const GLOBE_ISS_OVER_MIN_MOVE_DEG = 0.25;
/** Demi-vie du recadrage caméra vers l’ISS (mode « centré sur l’ISS ») ; mouvement fluide, peu dépendant du framerate. */
const GLOBE_ISS_CAMERA_CENTER_HALF_LIFE_SEC = 0.26;
/** Au-delà de cet écart angulaire (rad), le recadrage ISS accélère pour rattraper le sous-point. */
const GLOBE_ISS_CAMERA_CENTER_ERROR_BOOST_REF_RAD = 0.055;
/** Satellites astro-compass (hors ISS) : icône + nom sur le globe. */
const GLOBE_SAT_ICON_WORLD_SIZE = 0.026;
const GLOBE_SAT_GEO_ICON_WORLD_SIZE = 0.045;
const GLOBE_SAT_LABEL_SPRITE_WORLD_H = 0.018;
const GLOBE_SAT_OVERLAY_STORAGE_KEY = 'pat.world-globe.satellite-overlays';
const GLOBE_ASTRO_VISEUR_SAT_KEY = 'pat.world-globe.astro-viseur-sat';
/** Retour viseur → globe (onglet) : satellite à recadrer si l’URL n’a pas `?sat=`. */
const GLOBE_ASTRO_RETURN_SAT_KEY = 'pat.world-globe.astro-return-sat';
const ASTRO_LAST_TARGET_KEY = 'pat.astro-compass.last-target.v1';
const GLOBE_SAT_MIN_ALT_KM = 80;
const GLOBE_SAT_MAX_ALT_KM = 40_000;
/** GEO réel (~6,6 rayons) sort de la vue : on le plaque sur un anneau visible. */
const GLOBE_SAT_DISPLAY_RADIUS_MAX = 1.22;
/** L2 (JWST, ~1.5e6 km) : un peu plus loin que l’anneau GEO compressé. */
const GLOBE_SAT_L2_DISPLAY_RADIUS = 1.48;
const GLOBE_SAT_PASS_LOOKBACK_MS = 45 * 60_000;
const GLOBE_SAT_PASS_HORIZON_MS = 18 * 60 * 60_000;
const GLOBE_SAT_PASS_STEP_MS = 30_000;
const GLOBE_SAT_PASS_MAX = 6;
/** Trajectoire future SGP4 : ~1 orbite LEO, dans la couleur du satellite. */
const GLOBE_SAT_FORECAST_MINUTES_DEFAULT = 90;
const GLOBE_SAT_FORECAST_MINUTES_MIN = 5;
const GLOBE_SAT_FORECAST_MINUTES_MAX = 1440;
const GLOBE_SAT_FORECAST_HOURS_STEP = 0.25;
const GLOBE_SAT_FORECAST_STEP_MS = 60_000;
const GLOBE_SAT_FORECAST_TRAIL_OPACITY = 0.78;
const GLOBE_SAT_FORECAST_TRAIL_ARC_SEGMENTS = 8;
const GLOBE_SAT_FORECAST_REBUILD_MIN_MS = 12_000;
/** Rayon de clic (px) pour sélectionner un satellite / l’ISS sur le globe. */
const GLOBE_SAT_PICK_RADIUS_PX = 36;

/* --- Flight tracking (OpenSky Network) --- */
/** Fallback globe radius for the aircraft marker when altitude is unknown (just above the surface). */
const GLOBE_FLIGHT_SURFACE_OFFSET = 1.0015;
/** Earth radius (m) to convert geometric altitude into a globe radius factor. */
const GLOBE_EARTH_RADIUS_M = 6_371_000;
const GLOBE_FLIGHT_MARKER_COLOR = 0x35d0ff;
/** World size of the aircraft icon (top-down view). */
const GLOBE_FLIGHT_ICON_WORLD_SIZE = 0.044;
/** Aircraft trail: slightly below the marker to reduce z-fighting. */
const GLOBE_FLIGHT_TRAIL_RADIUS = GLOBE_FLIGHT_SURFACE_OFFSET * 0.9994;
const GLOBE_FLIGHT_TRAIL_COLOR = 0x35d0ff;
const GLOBE_FLIGHT_TRAIL_OPACITY = 0.82;
const GLOBE_FLIGHT_TRAIL_ARC_SEGMENTS = 8;
/** Default interval between OpenSky polls (s); conservative for anonymous quota. */
const GLOBE_FLIGHT_POLL_DEFAULT_SEC = 30;
const GLOBE_FLIGHT_POLL_MIN_SEC = 15;
const GLOBE_FLIGHT_POLL_MAX_SEC = 600;
/** Half-life of camera recentering toward the tracked aircraft (same as ISS). */
const GLOBE_FLIGHT_CAMERA_CENTER_HALF_LIFE_SEC = 0.34;

/** Fuseaux horaires (Natural Earth 10m ; pas de jeu 110m dédié). */
const GLOBE_TIMEZONE_FILL_RADIUS = 1.00506;
const GLOBE_TIMEZONE_MAX_FAN_TRIANGLES = 280_000;
/** Anneaux NE 10m complexes : sous-échantillonnage trop agressif casse earcut ; aligné ~ lacs. */
const GLOBE_TIMEZONE_RING_MAX_VERTS = 300;
const GLOBE_LAKES_FILL_RADIUS = 1.00518;
/** Lacs 10 m : beaucoup de polygones — budget triangles et sommets par anneau relevés. */
const GLOBE_LAKES_MAX_FAN_TRIANGLES = 150_000;
const GLOBE_LAKES_RING_MAX_VERTS = 320;
const GLOBE_GLACIER_FILL_RADIUS = 1.00528;
const GLOBE_GLACIER_MAX_FAN_TRIANGLES = 45_000;
const GLOBE_GEOGRAPHIC_LINES_RADIUS = 1.0065;
const MAX_GEOGRAPHIC_LINE_SEGMENTS = 30_000;
const GLOBE_RIVERS_LINE_RADIUS = 1.00665;
/** 50 m Natural Earth hydro : plus de géométrie ; rester sous budget WebGL. */
const MAX_RIVERS_LINE_SEGMENTS = 200_000;
const GLOBE_CITIES_POINTS_RADIUS = 1.0076;
const GLOBE_TIMEZONE_HEX_PALETTE = [0xc9ddf0, 0xa8c4e8, 0x8ab0dc, 0x6c9cd0, 0x5a8cc4, 0x4a7cb8];

/** Multiplicateur d’éclairage utilisateur (potentiomètre) ; ×1 = réglage de base du mode actif ; défaut UI ≈ ×1,26. */
const GLOBE_LIGHTING_BOOST_DEFAULT = 1.26;
const GLOBE_LIGHTING_BOOST_MIN = 0.48;
const GLOBE_LIGHTING_BOOST_MAX = 2.08;

/** Calque sombre nuit (au-dessus du sol, sous nuages) pour accentuer le terminateur. */
const GLOBE_TERMINATOR_NIGHT_RADIUS = 1.011;
/** Éclairage terminateur : nuit plus sombre, jour plus lumineux (avant globeLightingBoost). */
const GLOBE_TERMINATOR_AMB_BASE = 0.02;
const GLOBE_TERMINATOR_HEMI_BASE = 0.012;
const GLOBE_TERMINATOR_SUN_BASE = 5.8;
const GLOBE_TERMINATOR_EXPOSURE_BASE = 1.14;

/** À zoom fort (caméra proche), atténuer zoom / pan ; rotation garde un plancher lisible. */
const ORBIT_SENS_U_MIN_ROTATE = 0.55;
const ORBIT_SENS_U_MIN_PAN = 0.13;
const ORBIT_SENS_U_MIN_ZOOM = 0.38;
/** OrbitControls : glisser horizontal = tourner le globe, vertical = incliner (plus intuitif que Trackball). */
const GLOBE_ORBIT_ROTATE_SPEED_MAX = 1.15;
const GLOBE_ORBIT_PAN_SPEED_MAX = 0.55;
const GLOBE_ORBIT_ZOOM_SPEED_MAX = 0.8;
/** Vitesse rotation automatique (OrbitControls.autoRotateSpeed). */
const GLOBE_AUTO_ROTATE_SPEED = 0.35;

/** Fond ciel nocturne pour les captures partage (aligné brouillard Three.js). */

/** Pastels utilisés pour distinguer pays (priorité attribus Natural Earth `MAPCOLOR*`). */
const GLOBE_POLITICAL_HEX_PALETTE = [
  0x7eb6d9, 0xa8dab5, 0xf8c8dc, 0xffe6a8, 0xc8b8e9, 0xf4a688, 0xc9dcf4, 0xd9efb2, 0xf2c6f5,
  0xc5e9f8, 0xffd09e, 0xb8dfc4, 0xe6c9a9, 0xd2c9ff, 0xffe4f5, 0xa9e9de, 0xf5d76e, 0xc6d4e9
];

function globePixelRatioCap(): number {
  return Math.min(window.devicePixelRatio, 3);
}

@Component({
  selector: 'app-world-globe',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule, TraceViewerModalComponent, SlideshowModalComponent],
  templateUrl: './world-globe.component.html',
  styleUrls: ['./world-globe.component.css'],
  host: {
    '[class.wg-sat-slideshow-open]': 'satelliteInfoSlideshowOpen'
  }
})
export class WorldGlobeComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly apiService = inject(ApiService);
  private readonly keycloakService = inject(KeycloakService);
  private readonly issNowService = inject(GlobeIssNowService);
  private readonly satNowService = inject(GlobeSatelliteNowService);
  private readonly astroObjectDossier = inject(AstroObjectDossierService);
  private readonly positionService = inject(PositionService);
  private readonly airportLookup = inject(AirportLookupService);
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  @ViewChild('globeCanvasHost') globeCanvasHost?: ElementRef<HTMLElement>;
  @ViewChild('issTraceDateLoupe') issTraceDateLoupe?: ElementRef<HTMLElement>;
  @ViewChild('countryLabelLoupe') countryLabelLoupe?: ElementRef<HTMLElement>;
  @ViewChild('globeShell') globeShell?: ElementRef<HTMLElement>;
  /** Titre + panneau globe : cible préférée pour l’API Fullscreen (vrai plein écran navigateur). */
  @ViewChild('globeFsRoot') globeFsRoot?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceMount') globeTraceMount?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceViewer') globeTraceViewer?: TraceViewerModalComponent;
  @ViewChild('slideshowModalComponent') slideshowModalComponent?: SlideshowModalComponent;
  @ViewChild('issLivePiP') issLivePiP?: ElementRef<HTMLElement>;
  @ViewChild('issLiveHdPiP') issLiveHdPiP?: ElementRef<HTMLElement>;

  /** Demi-piste du bandeau ISS : sert à mesurer la largeur réelle pour une vitesse constante. */
  @ViewChild('issTickerHalf')
  set issTickerHalfRef(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement;
    if (el === this.issTickerHalfEl) {
      return;
    }
    this.issTickerHalfEl = el;
    // AfterViewChecked : ne pas toucher au DOM / ResizeObserver dans le même tour que CD (NG0100 / removeChild).
    queueMicrotask(() => {
      if (this.issTickerHalfEl === el) {
        this.attachIssTickerSpeedObserver();
      }
    });
  }

  /** Mini-fenêtre ISS en direct (embed YouTube, même source que Destination Orbite). Affichée par défaut. */
  issLiveEmbedEnabled = true;
  issLivePiPFullscreen = false;
  readonly issLiveEmbedSafeUrl: SafeResourceUrl = this.buildIssLiveEmbedSafeUrl(ISS_LIVE_YOUTUBE_VIDEO_ID);
  /** Mini-fenêtre ISS HD — affichée par défaut aux côtés du flux standard. */
  issLiveHdEmbedEnabled = true;
  issLiveHdPiPFullscreen = false;
  readonly issLiveHdEmbedSafeUrl: SafeResourceUrl = this.buildIssLiveEmbedSafeUrl(ISS_LIVE_HD_YOUTUBE_VIDEO_ID);
  /** Capture image ISS en cours (copie, une fenêtre à la fois). */
  issPiPImageBusy: { variant: 'standard' | 'hd'; action: 'copy' } | null = null;
  issPiPCopyFlash: { variant: 'standard' | 'hd'; ok: boolean } | null = null;
  private issPiPCopyFlashTimer: ReturnType<typeof setTimeout> | null = null;

  showOptionsPanel = false;
  /** Section ouverte dans le panneau options (accordéon). */
  openGlobeOptSectionId: string | null = null;
  cloudsEnabled = false;
  starsEnabled = true;
  /** Axe de rotation (ligne pôles) enfant du maillage Terre. */
  showEarthRotationAxis = true;
  autoRotate = false;
  /** Fond pseudo-satellite (NASA BMNG) vs texture Three.js classique avec relief/spec ; BMNG activé par défaut. */
  basemapSatellite = true;
  /** Couche indicative type « météo » : précipitations estimées (NASA GIBS, dernier jour UTC). */
  weatherImageryEnabled = true;
  weatherImageryLoading = false;
  weatherImageryFailed = false;
  countryBordersEnabled = true;
  coastlinesEnabled = true;
  graticuleEnabled = true;
  /** Carte politique semi-transparente (polygones admin-0, Natural Earth 110 m, proxifié). */
  politicalMapEnabled = false;
  /** Noms pays (Sprite) aux positions officielles Natural Earth. */
  countryLabelsEnabled = true;
  /** Équateur, tropiques, cercles polaires (NE 110m). */
  geographicLinesEnabled = true;
  /** Fleuves / axes lacs (NE 110m). */
  riversEnabled = false;
  /** Surfaces lacustres (NE 110m). */
  lakesEnabled = false;
  /** Glaciers / calottes (NE 110m). */
  glaciersEnabled = false;
  /** Villes (points, NE 110m simplified). */
  citiesEnabled = false;
  /** Fuseaux horaires remplis (NE 10m). */
  timeZonesEnabled = false;
  /**
   * Satellites du viseur d’astres, hors ISS (gérée à part).
   * Même catalogue que astro-compass ({@link GLOBE_OVERLAY_SATELLITES}).
   */
  readonly globeSatelliteOptions: ReadonlyArray<AstroSatelliteOption> = GLOBE_OVERLAY_SATELLITES;
  readonly issGlobeOption: AstroSatelliteOption = ASTRO_ISS;
  /** Liste satellites (ISS incluse) triée selon le nom affiché. */
  globeSatelliteOptionsSorted: AstroSatelliteOption[] = [];
  /** Interrupteurs d’affichage : tous activés par défaut (Starlink à la demande). */
  satelliteOverlayEnabled: Record<string, boolean> = Object.fromEntries(
    GLOBE_OVERLAY_SATELLITES.map((s) => [s.id, satelliteInGlobeMasterToggle(s)])
  );
  /** Interrupteur maître : tous les satellites du viseur, hors constellations. */
  satelliteOverlayMasterEnabled =
    GLOBE_OVERLAY_SATELLITES.filter(satelliteInGlobeMasterToggle).length > 0;
  /** Trajectoire future (SGP4) : interrupteur maître (tous les satellites). */
  satelliteFutureTraceEnabled = false;
  /** Trajectoire future par satellite (désactivée par défaut). */
  satelliteFutureTraceById: Record<string, boolean> = Object.fromEntries(
    GLOBE_OVERLAY_SATELLITES.map((s) => [s.id, false])
  );
  satelliteFutureTraceMinutes = GLOBE_SAT_FORECAST_MINUTES_DEFAULT;
  satelliteFutureTraceHours = WorldGlobeComponent.hoursFromTraceMinutes(GLOBE_SAT_FORECAST_MINUTES_DEFAULT);
  readonly satelliteFutureTraceHoursMin = WorldGlobeComponent.hoursFromTraceMinutes(
    GLOBE_SAT_FORECAST_MINUTES_MIN
  );
  readonly satelliteFutureTraceHoursMax = WorldGlobeComponent.hoursFromTraceMinutes(
    GLOBE_SAT_FORECAST_MINUTES_MAX
  );
  readonly satelliteFutureTraceHoursStep = GLOBE_SAT_FORECAST_HOURS_STEP;
  /** Satellite dont les données remplissent le bandeau ; `null` = ISS. */
  tickerFocusSatId: string | null = null;
  /** Dernier satellite (ou ISS) choisi pour le viseur d’astres. */
  lastAstroViseurSatId = 'iss';
  private lastSoleEnabledSatId: string | null = null;
  private readonly starlinkCompanionIds = new Set<string>();
  satTickerLat: number | null = null;
  satTickerLon: number | null = null;
  satTickerAltKm: number | null = null;
  satTickerSpeedKmh: number | null = null;
  satTickerStepKm: number | null = null;
  satTickerOverPlaceLabel: string | null = null;
  satTickerOverPlaceCountryCode: string | null = null;
  private satTickerSampleLat: number | null = null;
  private satTickerSampleLon: number | null = null;
  private satTickerSampleAtMs = 0;
  private satTickerCdrAtMs = 0;
  /** Satellite au-dessus de l’horizon depuis la position GPS de l’utilisateur. */
  satelliteVisibleFromUser: Record<string, boolean> = {};
  issVisibleFromUser = false;
  satelliteInfoOpen = false;
  satelliteInfoSat: AstroSatelliteOption | null = null;
  satelliteInfoLoading = false;
  satelliteInfoSnapshot: GlobeSatelliteInfoSnapshot | null = null;
  satelliteInfoPasses: GlobeSatellitePass[] = [];
  satelliteInfoDossier: ObjectDossier | null = null;
  satelliteInfoDossierBusy = false;
  satelliteInfoSlideshowOpen = false;
  satelliteInfoFactHelpKey: string | null = null;
  private satelliteInfoDossierSub: Subscription | null = null;
  issOverlayEnabled = true;
  /**
   * Interrupteur maître d’affichage de la trace ISS live : masque/affiche la traînée temps réel
   * et la prédiction rouge. La trace historique MongoDB a son propre interrupteur
   * ({@link issHistoricalTraceEnabled}) et reste visible indépendamment.
   */
  issTraceVisible = true;
  /** Bandeau défilant lat/lon/altitude/vitesse ISS (page globe). */
  issTickerEnabled = true;
  /** Répétitions lat/lon/alt/vitesse par demi-piste (boucle marquee sans trou). */
  readonly issTickerMarqueeRepeats = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  /**
   * Durée (s) d’un cycle du bandeau défilant. Recalculée dynamiquement à partir de la largeur
   * réelle d’une demi-piste pour garder une vitesse de défilement CONSTANTE (px/s), quel que soit
   * le nombre d’infos affichées.
   */
  issTickerDurationSec = 90;
  /** Horodatage affiché dans le bandeau (mis à jour au plus 1×/s pour limiter les reflows). */
  issTickerNowLabel = '';
  /**
   * Copie « vue » du bandeau : figée hors CD puis poussée via {@link scheduleWorldGlobeCdr}.
   * Évite NG0100 quand lat/lieu/satellite changent pendant la détection (ngTemplateOutlet + poll ISS).
   */
  tickerUiHasLiveData = false;
  tickerUiLat: number | null = null;
  tickerUiLon: number | null = null;
  tickerUiAltKm: number | null = null;
  tickerUiSpeedKmh: number | null = null;
  tickerUiStepKm: number | null = null;
  tickerUiOverPlaceLabel: string | null = null;
  tickerUiOverFlagEmoji = '';
  tickerUiLabelName = '';
  tickerUiLoadingLabel = '';
  tickerUiAriaLabel = '';
  tickerUiColor: string | null = null;
  tickerUiIconClass = 'fa-globe';
  /** Date/heure agrandie (loupe) au survol d’une pastille trace ISS. */
  issTraceDateLoupeLabel: string | null = null;
  /** Nom de pays agrandi (loupe) au survol d’une étiquette pays. */
  countryLabelLoupeLabel: string | null = null;
  /** Vitesse de défilement cible du bandeau ISS, en pixels par seconde. */
  private static readonly ISS_TICKER_SPEED_PX_PER_SEC = 90;
  private static readonly COMPASS_POINTS: ReadonlyArray<ReadonlyArray<'N' | 'E' | 'S' | 'W'>> = [
    ['N'], ['N', 'N', 'E'], ['N', 'E'], ['E', 'N', 'E'],
    ['E'], ['E', 'S', 'E'], ['S', 'E'], ['S', 'S', 'E'],
    ['S'], ['S', 'S', 'W'], ['S', 'W'], ['W', 'S', 'W'],
    ['W'], ['W', 'N', 'W'], ['N', 'W'], ['N', 'N', 'W']
  ];
  private issTickerHalfEl?: HTMLElement;
  private issTickerResizeObs?: ResizeObserver;
  private issTickerDurationRaf: number | null = null;
  private pendingIssTickerHalfWidthPx = 0;
  private dateTimeLabelFormatterLang = '';
  private dateTimeLabelFormatter?: Intl.DateTimeFormat;
  /**
   * Garde le sous-point ISS au centre du globe (caméra réalignée à chaque frame ; le zoom est conservé).
   * Désactive temporairement la rotation automatique tant que l’option est active et qu’une position ISS est connue.
   */
  issKeepEarthCentered = true;
  /** Secondes entre deux rafraîchissements ISS (2–600, défaut 2). */
  issPollIntervalSec = GLOBE_ISS_POLL_DEFAULT_SEC;
  /**
   * Secondes restantes avant le prochain appel API (0 si inactif).
   * Mis à jour explicitement (pas via getter + {@link Date.now}) pour éviter NG0100 dans le même cycle de détection.
   */
  issSecondsUntilNextRefresh = 0;
  /** Pendant un fetch manuel (« rafraîchir maintenant ») pour désactiver le bouton et montrer l’icône en rotation. */
  issManualRefreshInFlight = false;

  /* --- Flight tracking (OpenSky Network) --- */
  /** Flight search mode: callsign / flight number, or ICAO24 address (hex). */
  flightMode: 'callsign' | 'icao24' = 'callsign';
  /** User input (callsign or hex), bound to the options text field. */
  flightQueryInput = '';
  /** Active tracking (polling in progress) for the current flight. */
  flightTrackingActive = false;
  /** Validated query actually being tracked, distinct from in-progress editing. */
  flightTrackedQuery: string | null = null;
  flightTrackedMode: 'callsign' | 'icao24' = 'callsign';
  /** Seconds between OpenSky refreshes (10–600). */
  flightPollIntervalSec = GLOBE_FLIGHT_POLL_DEFAULT_SEC;
  flightSecondsUntilNextRefresh = 0;
  /** Flight tracking UI state. */
  flightStatus: 'idle' | 'loading' | 'tracking' | 'notfound' | 'upstream' | 'error' = 'idle';
  flightManualRefreshInFlight = false;
  /** Last known flight state (info panel + banner). */
  flightLat: number | null = null;
  flightLon: number | null = null;
  flightAltKm: number | null = null;
  flightSpeedKmh: number | null = null;
  flightTrackDeg: number | null = null;
  flightVerticalRateMs: number | null = null;
  flightOnGround: boolean | null = null;
  flightCallsign: string | null = null;
  flightIcao24: string | null = null;
  flightOriginCountry: string | null = null;
  flightLastContactEpoch: number | null = null;
  /** ICAO airport codes for departure / arrival (OpenSky). */
  flightDepartureAirport: string | null = null;
  flightArrivalAirport: string | null = null;
  flightDepartureAirportName: string | null = null;
  flightArrivalAirportName: string | null = null;
  flightDepartureAirportIata: string | null = null;
  flightArrivalAirportIata: string | null = null;
  /** City / town for departure / arrival airports. */
  flightDepartureCity: string | null = null;
  flightArrivalCity: string | null = null;
  flightArrivalCountry: string | null = null;
  private airportLookupMap: Map<string, AirportIcaoEntry> | null = null;
  /** Estimated departure / arrival times (UTC epoch seconds, OpenSky). */
  flightDepartureTimeEpoch: number | null = null;
  flightArrivalTimeEpoch: number | null = null;
  /** While a flight is tracked: remembers ISS state (centering + trace) for restore on stop. */
  private issStateBeforeFlight: { keepCentered: boolean; traceVisible: boolean } | null = null;
  bordersOverlayLoading = false;
  bordersOverlayFailed = false;
  coastlinesOverlayLoading = false;
  coastlinesOverlayFailed = false;
  /** Chargement partagé du GeoJSON `ne_110m_admin_0_countries`. */
  admin0CountriesOverlayLoading = false;
  admin0CountriesOverlayFailed = false;
  geographicLinesLoading = false;
  geographicLinesFailed = false;
  riversOverlayLoading = false;
  riversOverlayFailed = false;
  lakesOverlayLoading = false;
  lakesOverlayFailed = false;
  glaciersOverlayLoading = false;
  glaciersOverlayFailed = false;
  citiesOverlayLoading = false;
  citiesOverlayFailed = false;
  timeZonesOverlayLoading = false;
  timeZonesOverlayFailed = false;
  issOverlayFailed = false;
  /** Trace ISS historique (MongoDB) sur le globe ; activée par défaut à l’ouverture. */
  issHistoricalTraceEnabled = false;
  issHistoricalTraceLoading = false;
  issHistoricalTraceFailed = false;
  /** Dates/heures le long de la trace historique ISS (activé par défaut). */
  issHistoricalTraceDatesEnabled = false;
  issHistoricalTraceClearInFlight = false;
  /** Server records ISS to MongoDB (master recording toggle, persisted in MongoDB). */
  issBackgroundTraceEnabled = false;
  issBackgroundTraceIntervalMinutes = 15;
  issBackgroundTraceLoading = false;
  issBackgroundTraceSaving = false;
  /** Limite l’affichage de la trace ISS à {@link issTraceDisplayLimitMaxPoints} points (activé par défaut, persisté serveur). */
  issTraceDisplayLimitEnabled = true;
  issTraceDisplayLimitMaxPoints = 1000;
  issTraceDisplayLimitLoading = false;
  issTraceDisplayLimitSaving = false;
  /** Intervalle d’échantillonnage trace ISS côté serveur (s), lu depuis GET /iss/trace. */
  issTraceSampleIntervalSec = GLOBE_ISS_TRACE_SAMPLE_INTERVAL_SEC_DEFAULT;
  globeIssLat: number | null = null;
  globeIssLon: number | null = null;
  /** Altitude ISS (km), fournie par wheretheiss.at lorsque disponible. */
  globeIssAltKm: number | null = null;
  /**
   * Vitesse du sous-point ISS (km/h) : priorité à l’API, sinon estimation entre deux relevés.
   */
  issGroundSpeedKmh: number | null = null;
  /** Distance au sol (km) entre le relevé ISS précédent et le relevé courant (bandeau). */
  issLastStepGroundKm: number | null = null;
  /** Cap vrai ISS (0° = Nord) dérivé du mouvement entre deux relevés. */
  issTrackDeg: number | null = null;
  /** Pays (ou océan) actuellement survolé par l’ISS, résolu par reverse-geocoding throttlé. */
  issOverPlaceLabel: string | null = null;
  /** Code pays ISO (minuscule) du survol courant, pour l’emoji drapeau ; null si océan / inconnu. */
  issOverPlaceCountryCode: string | null = null;
  private issOverLookupLat: number | null = null;
  private issOverLookupLon: number | null = null;
  private issOverLookupAtMs = 0;
  private issOverLookupInFlight = false;

  /** Horloge mise en cache (epoch ms), rafraîchie par les timers : évite NG0100 dans le template. */
  private clockNowMs = Date.now();

  /** Éclairage uniforme sur tout le globe (ambiance + hémisphère). Coupé tant que le jour/nuit réel est actif. */
  globeLightingUniform = true;
  /**
   * Terminateur jour/nuit selon la position réelle du Soleil (horloge du navigateur / UTC).
   * Désactivé par défaut ; prioritaire sur l’éclairage uniforme quand activé.
   */
  realTimeTerminator = false;

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

  /** Plein écran navigateur ou repli viewport : masquer le titre, garder le bandeau ISS. */
  get globePresentationMode(): boolean {
    return this.fullscreen || this.globeViewportLocked;
  }

  /** Plein écran navigateur + au moins une fenêtre ISS : globe à gauche, flux à droite. */
  get issFsSplitLayout(): boolean {
    return this.fullscreen && (this.issLiveEmbedEnabled || this.issLiveHdEmbedEnabled);
  }

  /** Largeur colonne flux ISS en plein écran scindé (poignée entre globe et vidéos). */
  issFsSplitIssWidthPx = 320;

  /** False tant que l’utilisateur n’a pas déplacé le séparateur (largeur ISS = 40 % de l’écran). */
  private issFsSplitIssWidthManual = false;

  issFsSplitDragging = false;

  /** Hauteur du flux ISS du haut (standard) quand les deux vues sont empilées en plein écran. */
  issFsPipStackTopPx = 200;

  private issFsPipStackTopManual = false;

  issFsPipStackDragging = false;

  /** Plein écran + les deux flux ISS : séparateur vertical entre standard (haut) et HD (bas). */
  get issFsPipStackSplitActive(): boolean {
    return this.issFsSplitLayout && this.issLiveEmbedEnabled && this.issLiveHdEmbedEnabled;
  }

  /** Variables CSS pour la grille verticale des deux flux ISS. */
  get issFsPipDockStyle(): Record<string, string> | null {
    if (!this.issFsPipStackSplitActive) {
      return null;
    }
    return {
      '--wg-iss-pip-stack-top': `${this.getEffectiveIssFsPipStackTopPx()}px`,
      '--wg-iss-pip-stack-handle-px': `${WorldGlobeComponent.ISS_FS_PIP_STACK_HANDLE_PX}px`
    };
  }

  /** Style inline pour la grille plein écran scindé (variable CSS largeur ISS). */
  get issFsSplitStageStyle(): Record<string, string> | null {
    if (!this.issFsSplitLayout) {
      return null;
    }
    return {
      '--wg-fs-iss-split-width': `${this.getEffectiveIssFsSplitIssWidthPx()}px`,
      '--wg-fs-split-handle-px': `${WorldGlobeComponent.ISS_FS_SPLIT_HANDLE_PX}px`
    };
  }

  /** Largeur colonne flux ISS (template / ARIA). */
  get issFsSplitIssColumnWidthPx(): number {
    return this.getEffectiveIssFsSplitIssWidthPx();
  }

  /** Largeur colonne ISS affichée (40 % de l’écran par défaut ; valeur manuelle après glisser le séparateur). */
  private getEffectiveIssFsSplitIssWidthPx(): number {
    if (this.issFsSplitIssWidthManual) {
      return this.issFsSplitIssWidthPx;
    }
    return this.getCenterIssFsSplitIssWidthPx();
  }
  /**
   * True si le dernier plein écran a utilisé `document.documentElement` (repli quand le conteneur refuse l’API).
   * Permet de détecter la sortie et de garder le libellé du bouton cohérent.
   */
  /** Repli si l’API Fullscreen refuse l’élément : occupe tout le viewport en position fixe. */
  globeViewportLocked = false;
  textureLoadError = false;

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
  /** Résultats multiples : ligne surlignée pour flèches haut/bas + Entrée. */
  globeGeocodeListActiveIndex: number | null = null;
  /** Repère visuel géocodage : même lat/lon que le vol caméra tant que l’utilisateur ne clique pas ailleurs sur la Terre. */
  globeGeocodeMarkerLat: number | null = null;
  globeGeocodeMarkerLon: number | null = null;

  /** Prochain passage ISS visible au-dessus du lieu saisi (Open Notify via backend). */
  issPassLoading = false;
  issPassError = '';
  issPassCandidates: Array<{ lat: number; lon: number; displayName: string }> = [];
  issPassSummary: {
    placeLabel: string;
    coordsLine: string;
    nextPassLine: string;
    upcomingLines: string[];
  } | null = null;
  private issPassPlaceQueryCache = '';

  /** Alerte e-mail « passage ISS visible » (config stockée côté serveur dans appParameters). */
  issAlertEnabled = false;
  issAlertEmail = '';
  issAlertPlace = '';
  issAlertPlaceLabel = '';
  issAlertLat: number | null = null;
  issAlertLon: number | null = null;
  issAlertMinQuality = 'fair';
  issAlertLeadMinutes = 30;
  issAlertLoading = false;
  issAlertSaving = false;
  issAlertTesting = false;
  issAlertError = '';
  issAlertNotice = '';
  issAlertAdminEntries: IssAlertAdminEntry[] = [];
  issAlertAdminLoading = false;
  issAlertAdminModalOpen = false;
  issAlertAdminDeletingUserId = '';
  issAlertAdminDeleteError = '';
  issAlertEditingUserId: string | null = null;
  issAlertEditingOwnerLabel = '';
  issAlertPassesUi: Record<string, IssAlertPassesUiState> = {};
  private issAlertConfigLoaded = false;
  private issGlobalPrefsLoaded = false;
  private issGlobalPrefsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private satelliteOverlayPrefsLoaded = false;
  private satelliteOverlayPrefsTouched = false;
  private satelliteOverlayPrefsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Recentrage demandé avant que le TLE / la position soit disponible. */
  private pendingCenterSatelliteId: string | null = null;
  /** Lien profond viseur → globe : `?sat=iss` / `?sat=hubble` (réappliqué après les prefs). */
  private pendingDeepLinkSatId: string | null = null;
  /** Recentrage viseur → globe : garder la Terre entière dans le champ (pas le zoom courant). */
  private pendingCenterFitWholeGlobe = false;
  userObserverLat: number | null = null;
  userObserverLon: number | null = null;

  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private earthMesh?: THREE.Mesh;
  /** Groupe Three.js : ligne suivant l’axe local Y (pôles). */
  private earthRotationAxisGroup?: THREE.Group;
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
  /** Groupe enfants du maillage Terre : frontières puis côtes. */
  private bordersOverlayGroup?: THREE.Group;
  private coastlinesOverlayGroup?: THREE.Group;
  /** Méridiens / parallèles (isolignes géographiques synthétiques). */
  private graticuleOverlayGroup?: THREE.Group;
  /** Remplissage pays pastel (« carte ») sur une seule géométrie fusionnée. */
  private politicalMapMesh?: THREE.Mesh;
  private countryLabelsGroup?: THREE.Group;
  private geographicLinesOverlayGroup?: THREE.Group;
  private riversOverlayGroup?: THREE.Group;
  private lakesMesh?: THREE.Mesh;
  private glaciersMesh?: THREE.Mesh;
  private citiesPoints?: THREE.Points;
  private timeZonesMesh?: THREE.Mesh;
  private issMarkerMesh?: THREE.Mesh;
  /** Marqueur + étiquette nom pour chaque satellite astro-compass (hors ISS). */
  private readonly globeSatelliteVisuals = new Map<
    string,
    { group: THREE.Group; marker: THREE.Mesh; label: THREE.Sprite; labelText: string }
  >();
  private readonly globeSatelliteForecastLines = new Map<string, THREE.LineSegments>();
  private satelliteForecastLastRebuildMs = 0;
  /** Petit cercle + calotte au sol : zone depuis laquelle l’ISS est visible. */
  private issVisibilityCircleLine?: THREE.LineLoop;
  private issVisibilityFillMesh?: THREE.Mesh;
  /** Cercle de visibilité du satellite recadré (hors ISS). */
  private globeSatVisibilityCircleSatId: string | null = null;
  private satVisibilityCircleLine?: THREE.LineLoop;
  private satVisibilityFillMesh?: THREE.Mesh;
  /** Rayon au sol (km) de la zone de visibilité ISS affichée. */
  globeIssVisibilityRadiusKm: number | null = null;
  /** Positions successives (lat/lon) pour la traînée ; enfant du maillage Terre. */
  private issTrailLine?: THREE.LineSegments;
  private readonly issTrailPoints: { lat: number; lon: number }[] = [];
  private issHistoricalTrailLine?: THREE.LineSegments;
  private readonly issHistoricalTrailPoints: { lat: number; lon: number; recordedAt?: string }[] = [];
  private issForecastTrailLine?: THREE.LineSegments;
  private readonly issForecastTrailPoints: { lat: number; lon: number; atSec: number }[] = [];
  private issForecastLastFetchMs = 0;
  private issForecastRequestSeq = 0;
  /** Trace rouge affichée mais extrapolée localement (API forecast indisponible). */
  issForecastTrailApproximate = false;
  private issHistoricalTraceDateLabelsGroup?: THREE.Group;
  /* --- Flight tracking (OpenSky): aircraft icon (Earth child) + full trajectory --- */
  private flightMarkerMesh?: THREE.Mesh;
  private flightTrailLine?: THREE.LineSegments;
  /** OpenSky waypoints (departure → current position / arrival). */
  private readonly flightTrackPoints: { lat: number; lon: number; radius: number }[] = [];
  /** Current globe radius of the aircraft marker (depends on geometric altitude). */
  private flightMarkerRadius = GLOBE_FLIGHT_SURFACE_OFFSET;
  private flightNextRefreshEpochMs = 0;
  private flightRefreshTimeout: number | null = null;
  private flightCountdownInterval: number | null = null;
  /** Camera recentering on tracked aircraft; released when the user moves the view. */
  private flightGlobeFreeOrbit = false;
  private flightCameraCenterSmoothPrevMs = 0;
  /** Suivi ISS centré : lissage temporel de la direction caméra (slerp). */
  private issCameraCenterSmoothPrevMs = 0;
  private readonly issCameraCenterDirA = new THREE.Vector3();
  private readonly issCameraCenterDirB = new THREE.Vector3();
  private readonly issCameraCenterDirOut = new THREE.Vector3();
  /** Prochain rafraîchissement ISS planifié (`performance.now`-aligné via `Date.now`). */
  private issNextRefreshEpochMs = 0;
  /** Chaîne de `setTimeout` sur intervalle fixe (indépendant de la durée des requêtes HTTP). */
  private issRefreshTimeout: number | null = null;
  /** Ignore les réponses ISS obsolètes quand plusieurs requêtes sont en vol. */
  private issRefreshRequestSeq = 0;
  /** Dernier échantillon lat/lon pour estimer la vitesse au sol entre deux réponses API. */
  private issSpeedSampleLat: number | null = null;
  private issSpeedSampleLon: number | null = null;
  private issSpeedSampleEpochMs = 0;
  /** Dernier enregistrement trace ISS envoyé au serveur (respecte {@link issTraceSampleIntervalSec}). */
  private issLastTracePersistEpochMs = 0;
  /** Tic 1 s pour mettre à jour le décompte affiché. */
  private issCountdownInterval: number | null = null;
  /** Évite doubles chargements parallèle des GeoJSON frontières. */
  private bordersBuildInFlight = false;
  private coastlinesBuildInFlight = false;
  private geographicLinesBuildInFlight = false;
  private riversBuildInFlight = false;
  private lakesBuildInFlight = false;
  private glaciersBuildInFlight = false;
  private citiesBuildInFlight = false;
  private timeZonesBuildInFlight = false;
  /** Mémo après premier GET réussi `/geojson/ne-110m-admin-0-countries`. */
  private admin0CountriesParsed: unknown | null = null;
  private admin0CountriesLoadPromise: Promise<boolean> | null = null;
  private ambientLight?: THREE.AmbientLight;
  private hemisphereLight?: THREE.HemisphereLight;
  private sunLight?: THREE.DirectionalLight;
  /** Voile bleu nuit sur l’hémisphère non éclairé (enfant du maillage Terre). */
  private terminatorNightOverlay?: THREE.Mesh;
  private readonly terminatorSunDirUniform = { value: new THREE.Vector3(1, 0, 0) };
  /** Distance fictive du soleil directionnel (rayons quasi parallèles). */
  private static readonly SUN_LIGHT_DISTANCE = 50;
  /**
   * Point de référence pour {@link Equator}(Sun) : géocodage proche équateur ;
   * parallaxe Soleil négligeable. Coordonnées of-date + GAST ({@link SiderealTime}) restent cohérents.
   */
  private static readonly SUN_EQUATOR_OBSERVER = new Observer(0, 0, 0);

  private rafId: number | null = null;
  private resizeObs?: ResizeObserver;
  private issLivePiPResizeObs?: ResizeObserver;
  private issLivePiPResizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private globeCdrTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mises à jour liées au template ISS différées (évite NG0100 sur le bandeau / panneau). */
  private readonly globeViewSyncQueue: Array<() => void> = [];
  /** Évite d’écraser les tailles ISS mémorisées pendant un reflow (panneau options, etc.). */
  private issPiPSuppressSizePersist = false;
  private issPiPResizeDrag: {
    panel: HTMLElement;
    variant: keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY;
    handle: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null = null;
  private readonly issPiPResizeMoveHandler = (event: PointerEvent) => this.onIssPiPResizeMove(event);
  private readonly issPiPResizeUpHandler = (event: PointerEvent) => this.endIssPiPResizeDrag(event);
  private static readonly ISS_FS_SPLIT_WIDTH_STORAGE_KEY = 'pat.world-globe.iss-fs-split.iss-width-px';
  private static readonly ISS_FS_PIP_STACK_TOP_STORAGE_KEY = 'pat.world-globe.iss-fs-pip-stack.top-px';
  private static readonly ISS_FS_SPLIT_HANDLE_PX = 6;
  private static readonly ISS_FS_PIP_STACK_HANDLE_PX = 6;
  private static readonly ISS_FS_PIP_STACK_TOP_MIN_PX = 120;
  private static readonly ISS_FS_PIP_STACK_TOP_RATIO = 0.5;
  /** Part plein écran de la colonne flux ISS (panneau droit) ; le globe prend le reste. */
  private static readonly ISS_FS_SPLIT_ISS_WIDTH_RATIO = 0.4;
  private static readonly ISS_FS_SPLIT_ISS_MIN_PX = 176;
  private static readonly ISS_FS_SPLIT_GLOBE_MIN_PX = 220;
  private issFsSplitResizeDrag: {
    startX: number;
    startWidth: number;
    handle: HTMLElement;
    pointerId: number;
  } | null = null;
  private readonly issFsSplitResizeMoveHandler = (event: PointerEvent) => this.onIssFsSplitResizeMove(event);
  private readonly issFsSplitResizeUpHandler = (event: PointerEvent) => this.endIssFsSplitResizeDrag(event);
  private issFsPipStackResizeDrag: {
    startY: number;
    startTop: number;
    handle: HTMLElement;
    pointerId: number;
  } | null = null;
  private readonly issFsPipStackResizeMoveHandler = (event: PointerEvent) => this.onIssFsPipStackResizeMove(event);
  private readonly issFsPipStackResizeUpHandler = (event: PointerEvent) => this.endIssFsPipStackResizeDrag(event);
  /** Plein écran document + masquage chrome app (repli si FS sur #globeFsRoot refusé). */
  private static readonly WG_TRUE_FS_BODY_CLASS = 'pat-wg-true-fullscreen';
  /** Rotation lente nuages vs sol (effet léger façon couches atmosphériques). */
  private cloudsDriftRad = 0;
  private routeQuerySub?: Subscription;
  private translateLangSub?: Subscription;
  /** Vol caméra depuis le trace viewer (query lat/lon/z) avant que la Terre soit prête. */
  private pendingGlobeDeepLink: { lat: number; lon: number; mapZoom?: number } | null = null;
  /** Premier cadrage ISS à l’ouverture (sans deep link ni lieu géocodé). */
  private globeInitialIssCameraPending = true;
  /** Évite les appels HTTP ISS en double au bootstrap (ngOnInit + AfterViewInit + Terre prête). */
  private issBootstrapRefreshStarted = false;
  /** Vol caméra programmatique (géocodage) : annulation au destroy ou nouvelle cible. */
  private globeCameraAnimFrameId: number | null = null;
  private globeCameraAnimPrevEnableDamping: boolean | null = null;

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
  /**
   * L’utilisateur a manœuvré la caméra (OrbitControls) : on suspend le recentrage ISS jusqu’à réactivation de l’option ou reset vue.
   */
  private issGlobeFreeOrbit = false;
  /** Identifiant du timer navigateur (évite TS node DOM : number vs Timeout). */
  private globePickCursorResetTimer: number | null = null;
  /** recordedAt ISO du libellé date/heure trace ISS actuellement survolé (évite CDR inutiles). */
  private issTraceDateLabelHoverRecordedAt: string | null = null;
  private issTraceDateLabelHoverSprite?: THREE.Sprite;
  private issTraceDateLoupePosRaf: number | null = null;
  private issTraceDatePickRaf: number | null = null;
  private pendingIssTraceDatePickX = 0;
  private pendingIssTraceDatePickY = 0;
  private pendingIssTraceDateLoupeX = 0;
  private pendingIssTraceDateLoupeY = 0;
  /** Nom pays du libellé actuellement survolé (évite CDR inutiles). */
  private countryLabelLoupeHoverName: string | null = null;
  private countryLabelLoupePosRaf: number | null = null;
  private pendingCountryLabelLoupeX = 0;
  private pendingCountryLabelLoupeY = 0;
  private readonly issTraceLoupeScreenScratch = new THREE.Vector3();
  /** Évite un traverse des sprites pays à chaque frame si le zoom n’a pas bougé. */
  private countryLabelZoomMulCached = Number.NaN;
  /** Reconstruit la trace rouge au prochain frame utile (pas à chaque poll HTTP). */
  private issForecastTrailGeometryDirty = false;
  private issForecastTrailLastGeometryRebuildMs = 0;

  private readonly onGlobePointerDown = (ev: PointerEvent): void => {
    if (this.detailMapOpen || !this.globeSurfaceReady) {
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button === 0 && this.isIssEarthCenteredTrackingActive()) {
      this.issGlobeFreeOrbit = true;
    }
    if (ev.pointerType === 'mouse' && ev.button === 0 && this.isFlightEarthCenteredTrackingActive()) {
      this.flightGlobeFreeOrbit = true;
    }
    this.globePickPointerDown = {
      x: ev.clientX,
      y: ev.clientY,
      id: ev.pointerId
    };
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
    const satPick = this.pickGlobeSatelliteAtClient(ev.clientX, ev.clientY);
    if (satPick) {
      this.onSelectSatelliteForTicker(satPick === 'iss' ? null : satPick, true);
      this.cdr.markForCheck();
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

  private readonly onGlobePointerMove = (ev: PointerEvent): void => {
    if (this.detailMapOpen || !this.globeSurfaceReady) {
      return;
    }
    const canPickIssTraceDate =
      this.issHistoricalTraceDatesEnabled && this.issHistoricalTraceEnabled;
    const canPickCountryLabel = this.countryLabelsEnabled;
    if (!canPickIssTraceDate && !canPickCountryLabel) {
      if (this.issTraceDateLoupeLabel !== null) {
        this.updateIssTraceDateLoupe(0, 0, null);
      }
      if (this.countryLabelLoupeLabel !== null) {
        this.updateCountryLabelLoupe(0, 0, null);
      }
      return;
    }
    this.pendingIssTraceDatePickX = ev.clientX;
    this.pendingIssTraceDatePickY = ev.clientY;
    if (this.issTraceDatePickRaf != null) {
      return;
    }
    this.issTraceDatePickRaf = requestAnimationFrame(() => {
      this.issTraceDatePickRaf = null;
      const x = this.pendingIssTraceDatePickX;
      const y = this.pendingIssTraceDatePickY;
      const issHit = canPickIssTraceDate ? this.pickIssTraceDateLabelAtClient(x, y) : null;
      if (issHit) {
        this.updateCountryLabelLoupe(0, 0, null);
        this.updateIssTraceDateLoupe(x, y, issHit);
        return;
      }
      this.updateIssTraceDateLoupe(0, 0, null);
      const countryHit = canPickCountryLabel ? this.pickCountryLabelAtClient(x, y) : null;
      this.updateCountryLabelLoupe(x, y, countryHit);
    });
  };

  private readonly onGlobePointerLeave = (): void => {
    this.updateIssTraceDateLoupe(0, 0, null);
    this.updateCountryLabelLoupe(0, 0, null);
  };

  /** Dès qu’on manipule le globe, le suivi ISS cesse de forcer la caméra (orbite 3D libre). */
  private readonly onGlobeOrbitControlsStart = (): void => {
    if (this.isIssEarthCenteredTrackingActive()) {
      this.issGlobeFreeOrbit = true;
    }
  };

  ngOnInit(): void {
    this.lastAstroViseurSatId = this.readLastAstroViseurSatId();
    this.refreshGlobeSatelliteOptionsSort();
    this.syncGlobeSatelliteOverlayMaster();
    this.issNowService.setForecastMinutes(this.satelliteFutureTraceMinutes);
    const cached = this.issNowService.getSnapshot();
    if (cached) {
      this.applyIssNowSnapshot(cached, true);
    }
    this.kickIssPositionRefreshOnce();
    this.loadGlobeSatelliteOverlayPrefs();
    this.prefetchGlobeSatelliteTles();
    this.requestUserObserverPosition();
    this.pushTickerUiSnapshot();
  }

  ngAfterViewInit(): void {
    void this.airportLookup.ensureLoaded().then((map) => {
      this.airportLookupMap = map;
      if (this.flightTrackingActive) {
        this.refreshFlightAirportLabelsFromLookup();
        this.scheduleWorldGlobeCdr();
      }
    });
    this.routeQuerySub = this.route.queryParamMap.subscribe((params) => {
      // queryParamMap émet souvent de façon synchrone dans AfterViewInit : différer pour ne pas
      // créer le bandeau / ngTemplateOutlet après le dirty-check du parent (NG0100).
      this.scheduleWorldGlobeCdr(() => this.applyGlobeRouteParams(params));
    });
    this.translateLangSub = this.translate.onLangChange.subscribe(() => {
      this.invalidateDateTimeLabelFormatter();
      if (this.issTickerEnabled) {
        this.issTickerNowLabel = this.formatDateTimeLabel(Date.now());
        this.scheduleWorldGlobeCdr();
      }
      this.onTranslateLangChangedForGlobeCountryLabels();
      this.rebuildGlobeSatelliteLabels();
      this.refreshGlobeSatelliteOptionsSort();
      if (this.satelliteInfoOpen && this.satelliteInfoSat) {
        this.loadSatelliteInfoDossier(this.satelliteInfoSat);
      }
    });
    queueMicrotask(() => this.bootstrapThree());
    this.loadIssFsPipStackTopFromStorage();
    queueMicrotask(() => this.loadIssGlobalPrefsThenBootstrapIss());
    queueMicrotask(() => this.loadIssBackgroundTraceSetting());
    queueMicrotask(() => this.loadIssTraceDisplayLimitSetting());
    queueMicrotask(() => this.loadIssAlertConfig());
    queueMicrotask(() => this.loadFlightTrackingPreference());
  }

  /** Loads shared ISS switches from MongoDB, then starts polling / trace display as configured. */
  private loadIssGlobalPrefsThenBootstrapIss(): void {
    this.apiService.getIssGlobalPrefs().subscribe({
      next: (prefs) => {
        this.applyIssGlobalPrefs(prefs);
        this.issGlobalPrefsLoaded = true;
        this.applyPendingSatelliteDeepLink();
        this.bootstrapIssUiAfterGlobalPrefs();
        this.pushTickerUiSnapshot();
        this.cdr.markForCheck();
      },
      error: () => {
        this.issGlobalPrefsLoaded = true;
        this.applyPendingSatelliteDeepLink();
        this.bootstrapIssUiAfterGlobalPrefs();
        this.pushTickerUiSnapshot();
        this.cdr.markForCheck();
      }
    });
  }

  private applyIssGlobalPrefs(prefs: GlobeIssGlobalPrefs | null | undefined): void {
    if (!prefs) {
      return;
    }
    if (typeof prefs.overlayEnabled === 'boolean') {
      this.issOverlayEnabled = prefs.overlayEnabled;
    }
    if (typeof prefs.historicalTraceEnabled === 'boolean') {
      this.issHistoricalTraceEnabled = prefs.historicalTraceEnabled;
    }
    if (typeof prefs.historicalTraceDatesEnabled === 'boolean') {
      this.issHistoricalTraceDatesEnabled = prefs.historicalTraceDatesEnabled;
    }
    if (typeof prefs.traceVisible === 'boolean') {
      this.issTraceVisible = prefs.traceVisible;
    }
    if (typeof prefs.keepEarthCentered === 'boolean') {
      const viseurSat = this.pendingDeepLinkSatId || this.tickerFocusSatId;
      if (!viseurSat || viseurSat === 'iss') {
        this.issKeepEarthCentered = prefs.keepEarthCentered;
      }
    }
    if (typeof prefs.tickerEnabled === 'boolean') {
      this.issTickerEnabled = prefs.tickerEnabled;
    }
    if (typeof prefs.liveEmbedEnabled === 'boolean') {
      this.issLiveEmbedEnabled = prefs.liveEmbedEnabled;
    }
    if (typeof prefs.liveHdEmbedEnabled === 'boolean') {
      this.issLiveHdEmbedEnabled = prefs.liveHdEmbedEnabled;
    }
    if (typeof prefs.pollIntervalSec === 'number' && prefs.pollIntervalSec > 0) {
      this.issPollIntervalSec = this.clampIssPollIntervalSec(prefs.pollIntervalSec);
    }
  }

  private buildIssGlobalPrefsPayload(): GlobeIssGlobalPrefs {
    return {
      overlayEnabled: this.issOverlayEnabled,
      historicalTraceEnabled: this.issHistoricalTraceEnabled,
      historicalTraceDatesEnabled: this.issHistoricalTraceDatesEnabled,
      traceVisible: this.issTraceVisible,
      keepEarthCentered: this.issKeepEarthCentered,
      tickerEnabled: this.issTickerEnabled,
      liveEmbedEnabled: this.issLiveEmbedEnabled,
      liveHdEmbedEnabled: this.issLiveHdEmbedEnabled,
      pollIntervalSec: this.clampIssPollIntervalSec(this.issPollIntervalSec)
    };
  }

  private schedulePersistIssGlobalPrefs(): void {
    if (!this.issGlobalPrefsLoaded) {
      return;
    }
    if (this.issGlobalPrefsSaveTimer != null) {
      clearTimeout(this.issGlobalPrefsSaveTimer);
    }
    this.issGlobalPrefsSaveTimer = setTimeout(() => {
      this.issGlobalPrefsSaveTimer = null;
      this.apiService.setIssGlobalPrefs(this.buildIssGlobalPrefsPayload()).subscribe({ error: () => {} });
    }, 400);
  }

  private bootstrapIssUiAfterGlobalPrefs(): void {
    queueMicrotask(() => this.refreshIssLivePiPPanelsLayout());
    if (this.issPositionFeedActive()) {
      queueMicrotask(() => {
        this.startIssPolling();
        this.kickIssPositionRefreshOnce();
      });
    }
    if (this.issHistoricalTraceEnabled) {
      queueMicrotask(() => void this.loadIssHistoricalTrace());
    }
    this.applyIssTraceVisibility();
  }

  ngOnDestroy(): void {
    if (this.issGlobalPrefsSaveTimer != null) {
      clearTimeout(this.issGlobalPrefsSaveTimer);
      this.issGlobalPrefsSaveTimer = null;
    }
    if (this.satelliteOverlayPrefsSaveTimer != null) {
      clearTimeout(this.satelliteOverlayPrefsSaveTimer);
      this.satelliteOverlayPrefsSaveTimer = null;
    }
    this.endIssFsSplitResizeDrag();
    this.endIssFsPipStackResizeDrag();
    void this.exitGlobeFullscreenIfActive();
    this.stopIssPolling();
    this.stopFlightPolling();
    this.restoreFlightTrackingIssOverrides();
    this.disposeFlightMarker();
    this.disposeFlightTrail();
    this.disposeCountryBordersOverlay();
    this.disposeCoastlinesOverlay();
    this.disposeGraticuleOverlay();
    this.disposePoliticalMapOverlay();
    this.disposeCountryLabelsOverlay();
    this.disposeGeographicLinesOverlay();
    this.disposeRiversOverlay();
    this.disposeLakesMesh();
    this.disposeGlaciersMesh();
    this.disposeCitiesPoints();
    this.disposeTimeZonesMesh();
    this.disposeIssMarkerMesh();
    this.disposeAllGlobeSatelliteVisuals();
    this.disposeAllGlobeSatelliteForecastTrails();
    this.disposeIssVisibilityCircle();
    this.disposeSatelliteVisibilityCircle();
    this.clearIssTrail();
    this.disposeIssForecastTrail();
    this.disposeIssHistoricalTrail();
    this.routeQuerySub?.unsubscribe();
    this.routeQuerySub = undefined;
    this.satelliteInfoDossierSub?.unsubscribe();
    this.satelliteInfoDossierSub = null;
    this.translateLangSub?.unsubscribe();
    this.translateLangSub = undefined;
    this.globeTraceViewer?.close();
    this.stopGlobeCameraAnimation();
    this.issTickerResizeObs?.disconnect();
    this.issTickerResizeObs = undefined;
    if (this.issTickerDurationRaf != null) {
      cancelAnimationFrame(this.issTickerDurationRaf);
      this.issTickerDurationRaf = null;
    }
    if (this.globePickCursorResetTimer != null) {
      clearTimeout(this.globePickCursorResetTimer);
      this.globePickCursorResetTimer = null;
    }
    this.globeSurfaceReady = false;
    this.terminatorNightOverlay = undefined;
    this.disposeWeatherOverlayMesh();
    this.stopLoop();
    this.disposeGeocodeMarkerMesh();
    this.resizeObs?.disconnect();
    this.disposeIssLivePiPResizeObservers();
    if (this.issPiPCopyFlashTimer != null) {
      clearTimeout(this.issPiPCopyFlashTimer);
      this.issPiPCopyFlashTimer = null;
    }
    if (this.globeCdrTimer != null) {
      clearTimeout(this.globeCdrTimer);
      this.globeCdrTimer = null;
    }
    this.globeViewSyncQueue.length = 0;
    const canvasUnd = this.renderer?.domElement;
    if (canvasUnd) {
      canvasUnd.style.cursor = '';
      canvasUnd.removeEventListener('pointerdown', this.onGlobePointerDown);
      canvasUnd.removeEventListener('pointerup', this.onGlobePointerUp);
      canvasUnd.removeEventListener('pointercancel', this.onGlobePointerCancel);
      canvasUnd.removeEventListener('pointermove', this.onGlobePointerMove);
      canvasUnd.removeEventListener('pointerleave', this.onGlobePointerLeave);
    }
    this.updateIssTraceDateLoupe(0, 0, null);
    this.updateCountryLabelLoupe(0, 0, null);
    if (this.issTraceDateLoupePosRaf != null) {
      cancelAnimationFrame(this.issTraceDateLoupePosRaf);
      this.issTraceDateLoupePosRaf = null;
    }
    if (this.countryLabelLoupePosRaf != null) {
      cancelAnimationFrame(this.countryLabelLoupePosRaf);
      this.countryLabelLoupePosRaf = null;
    }
    if (this.issTraceDatePickRaf != null) {
      cancelAnimationFrame(this.issTraceDatePickRaf);
      this.issTraceDatePickRaf = null;
    }
    this.controls?.removeEventListener('start', this.onGlobeOrbitControlsStart);
    this.controls?.dispose();
    this.renderer?.domElement?.remove();
    this.disposeSceneHierarchy();
    this.earthRotationAxisGroup = undefined;
    this.renderer?.dispose();
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.controls = undefined;
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  @HostListener('document:mozfullscreenchange')
  @HostListener('document:MSFullscreenChange')
  onFullscreenDoc(): void {
    const wasPresentation = this.globePresentationMode;
    this.syncFullscreenFromDocument();
    this.syncIssLivePiPFullscreenFromDocument();
    this.applyIssEmbedPanelsOnPresentationChange(wasPresentation);
    this.cdr.markForCheck();
    requestAnimationFrame(() => {
      this.resizeRendererToHost();
      this.refreshIssLivePiPPanelsLayout();
      if (this.issFsSplitLayout) {
        this.syncIssFsSplitIssColumnWidth();
        if (this.issFsSplitIssWidthManual) {
          this.issFsSplitIssWidthPx = this.clampIssFsSplitIssWidth(this.issFsSplitIssWidthPx);
        }
        this.syncIssFsPipStackTop();
        if (this.issFsPipStackTopManual) {
          this.issFsPipStackTopPx = this.clampIssFsPipStackTop(this.issFsPipStackTopPx);
        }
        this.cdr.markForCheck();
      }
    });
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.issFsSplitLayout) {
      this.syncIssFsSplitIssColumnWidth();
      if (this.issFsSplitIssWidthManual) {
        this.issFsSplitIssWidthPx = this.clampIssFsSplitIssWidth(this.issFsSplitIssWidthPx);
      }
      this.syncIssFsPipStackTop();
      if (this.issFsPipStackTopManual) {
        this.issFsPipStackTopPx = this.clampIssFsPipStackTop(this.issFsPipStackTopPx);
      }
    }
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
    const dist = this.globeOrbitDistance();
    this.pendingDetailLat = pick.lat;
    this.pendingDetailLon = pick.lon;
    this.pendingDetailZoom = WorldGlobeComponent.leafletZoomForOrbitDistance(dist);
    this.detailMapOpen = true;
    this.cdr.markForCheck();
    /** Nécessaire pour créer le host `#globeTraceMount` (*ngIf) avant d’ouvrir le trace viewer — sinon montage sans conteneur → carte noire. */
    this.cdr.detectChanges();
    queueMicrotask(() => {
      requestAnimationFrame(() => this.mountGlobeTraceViewer(0));
    });
  }

  closeDetailMapOverlay(): void {
    this.globeTraceViewer?.close();
  }

  onGlobeTraceViewerClosed(): void {
    const host = this.globeTraceMount?.nativeElement;
    if (host?.childNodes?.length) {
      host.innerHTML = '';
    }
    this.detailMapOpen = false;
    this.cdr.markForCheck();
  }

  private mountGlobeTraceViewer(retry = 0): void {
    const host = this.globeTraceMount?.nativeElement;
    const viewer = this.globeTraceViewer;
    if (!this.detailMapOpen || !viewer) {
      return;
    }
    if (!host) {
      if (retry < 30) {
        setTimeout(() => this.mountGlobeTraceViewer(retry + 1), 45);
      }
      return;
    }
    viewer.openAtLocationEmbedded(host, this.pendingDetailLat, this.pendingDetailLon, {
      locationZoom: Math.round(this.pendingDetailZoom),
      initialBaseLayerId: 'osm-standard'
    });
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        viewer.refreshMapLayout();
        requestAnimationFrame(() => viewer.refreshMapLayout());
      });
    });
    window.setTimeout(() => viewer.refreshMapLayout(), 420);
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

  /** Clic proche d’un marqueur satellite (ou ISS) → id, sinon `null`. */
  private pickGlobeSatelliteAtClient(clientX: number, clientY: number): string | null {
    if (!this.camera || !this.renderer) {
      return null;
    }
    const canvasEl = this.renderer.domElement;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return null;
    }
    const camera = this.camera;
    const scratch = this.issTraceLoupeScreenScratch;
    let bestId: string | null = null;
    let bestDistSq = GLOBE_SAT_PICK_RADIUS_PX * GLOBE_SAT_PICK_RADIUS_PX;
    const consider = (id: string, obj: THREE.Object3D | undefined): void => {
      if (!obj?.visible) {
        return;
      }
      obj.getWorldPosition(scratch);
      const distCam = camera.position.distanceTo(scratch);
      if (distCam < 0.2) {
        return;
      }
      scratch.project(camera);
      if (scratch.z > 1) {
        return;
      }
      const sx = rect.left + ((scratch.x + 1) / 2) * rect.width;
      const sy = rect.top + ((-scratch.y + 1) / 2) * rect.height;
      const distSq = (clientX - sx) ** 2 + (clientY - sy) ** 2;
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        bestId = id;
      }
    };
    if (this.issOverlayEnabled) {
      consider('iss', this.issMarkerMesh);
    }
    for (const sat of this.globeSatelliteOptions) {
      if (this.satelliteOverlayEnabled[sat.id] === false) {
        continue;
      }
      consider(sat.id, this.globeSatelliteVisuals.get(sat.id)?.marker);
    }
    return bestId;
  }

  /** Survol souris → pastille date/heure le long de la trace ISS historique (projection écran). */
  private pickIssTraceDateLabelAtClient(
    clientX: number,
    clientY: number
  ): { recordedAt: string; sprite: THREE.Sprite; screenX: number; screenY: number } | null {
    const group = this.issHistoricalTraceDateLabelsGroup;
    if (
      !group?.visible ||
      !this.issHistoricalTraceDatesEnabled ||
      !this.issHistoricalTraceEnabled ||
      !this.camera ||
      !this.renderer
    ) {
      return null;
    }
    const canvasEl = this.renderer.domElement;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return null;
    }
    const camera = this.camera;
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    const pxPerWorldY = rect.height / (2 * Math.tan(vFovRad / 2));
    let best: { distSq: number; recordedAt: string; sprite: THREE.Sprite; screenX: number; screenY: number } | null =
      null;
    group.updateWorldMatrix(true, false);
    for (const child of group.children) {
      if (!(child instanceof THREE.Sprite)) {
        continue;
      }
      const recordedAt = child.userData['issTraceDateLabelRecordedAt'];
      if (typeof recordedAt !== 'string' || !recordedAt.trim()) {
        continue;
      }
      child.getWorldPosition(this.issTraceLoupeScreenScratch);
      const distCam = Math.max(camera.position.distanceTo(this.issTraceLoupeScreenScratch), 0.35);
      this.issTraceLoupeScreenScratch.project(camera);
      if (this.issTraceLoupeScreenScratch.z > 1) {
        continue;
      }
      const sx = rect.left + ((this.issTraceLoupeScreenScratch.x + 1) / 2) * rect.width;
      const sy = rect.top + ((-this.issTraceLoupeScreenScratch.y + 1) / 2) * rect.height;
      const base = child.userData['issTraceDateLabelBase'] as { w: number; h: number } | undefined;
      const worldW = base?.w ?? child.scale.x;
      const worldH = base?.h ?? child.scale.y;
      const halfWPx = Math.max(4, ((worldW / 2) * pxPerWorldY) / distCam);
      const halfHPx = Math.max(3, ((worldH / 2) * pxPerWorldY) / distCam);
      const dx = (clientX - sx) / halfWPx;
      const dy = (clientY - sy) / halfHPx;
      if (dx * dx + dy * dy > 1) {
        continue;
      }
      const pixelDistSq = (clientX - sx) ** 2 + (clientY - sy) ** 2;
      if (!best || pixelDistSq < best.distSq) {
        best = { distSq: pixelDistSq, recordedAt: recordedAt.trim(), sprite: child, screenX: sx, screenY: sy };
      }
    }
    if (best === null) {
      return null;
    }
    return { recordedAt: best.recordedAt, sprite: best.sprite, screenX: best.screenX, screenY: best.screenY };
  }

  private setIssTraceDateLabelHoverSprite(sprite: THREE.Sprite | null): void {
    const prev = this.issTraceDateLabelHoverSprite;
    if (prev && prev !== sprite) {
      const base = prev.userData['issTraceDateLabelBaseScale'] as { x: number; y: number; z: number } | undefined;
      if (base) {
        prev.scale.set(base.x, base.y, base.z);
      }
    }
    this.issTraceDateLabelHoverSprite = sprite ?? undefined;
  }

  private updateIssTraceDateLoupe(
    clientX: number,
    clientY: number,
    hit: { recordedAt: string; sprite: THREE.Sprite; screenX: number; screenY: number } | null
  ): void {
    if (!hit) {
      if (this.issTraceDateLoupeLabel !== null) {
        this.issTraceDateLoupeLabel = null;
        this.issTraceDateLabelHoverRecordedAt = null;
        this.setIssTraceDateLabelHoverSprite(null);
        this.scheduleWorldGlobeCdr();
      }
      return;
    }

    this.queueIssTraceDateLoupePosition(hit.screenX, hit.screenY - 6);
    this.setIssTraceDateLabelHoverSprite(hit.sprite);

    const labelChanged = hit.recordedAt !== this.issTraceDateLabelHoverRecordedAt;
    const ms = new Date(hit.recordedAt).getTime();
    const label = !Number.isNaN(ms) ? this.formatDateTimeLabel(ms) : null;
    if (!labelChanged && label === this.issTraceDateLoupeLabel) {
      return;
    }
    this.issTraceDateLabelHoverRecordedAt = hit.recordedAt;
    this.issTraceDateLoupeLabel = label;
    if (labelChanged) {
      this.scheduleWorldGlobeCdr(() => {
        this.syncIssTraceDateLoupePosition(this.pendingIssTraceDateLoupeX, this.pendingIssTraceDateLoupeY);
      });
    }
  }

  private queueIssTraceDateLoupePosition(clientX: number, clientY: number): void {
    this.pendingIssTraceDateLoupeX = clientX;
    this.pendingIssTraceDateLoupeY = clientY;
    if (this.issTraceDateLoupePosRaf != null) {
      return;
    }
    this.issTraceDateLoupePosRaf = requestAnimationFrame(() => {
      this.issTraceDateLoupePosRaf = null;
      this.syncIssTraceDateLoupePosition(this.pendingIssTraceDateLoupeX, this.pendingIssTraceDateLoupeY);
    });
  }

  private syncIssTraceDateLoupePosition(clientX: number, clientY: number): void {
    const el = this.issTraceDateLoupe?.nativeElement;
    if (!el) {
      return;
    }
    el.style.transform = `translate3d(${clientX}px, ${clientY}px, 0) translate(-50%, -100%)`;
  }

  /** Survol souris → étiquette pays Natural Earth (projection écran). */
  private pickCountryLabelAtClient(
    clientX: number,
    clientY: number
  ): { name: string; screenX: number; screenY: number } | null {
    const group = this.countryLabelsGroup;
    if (!group?.visible || !this.countryLabelsEnabled || !this.camera || !this.renderer) {
      return null;
    }
    const canvasEl = this.renderer.domElement;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return null;
    }
    const camera = this.camera;
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    const pxPerWorldY = rect.height / (2 * Math.tan(vFovRad / 2));
    let best: { distSq: number; name: string; screenX: number; screenY: number } | null = null;
    group.updateWorldMatrix(true, false);
    for (const child of group.children) {
      if (!(child instanceof THREE.Sprite)) {
        continue;
      }
      const name = child.userData['countryLabelName'];
      if (typeof name !== 'string' || !name.trim()) {
        continue;
      }
      child.getWorldPosition(this.issTraceLoupeScreenScratch);
      const distCam = Math.max(camera.position.distanceTo(this.issTraceLoupeScreenScratch), 0.35);
      this.issTraceLoupeScreenScratch.project(camera);
      if (this.issTraceLoupeScreenScratch.z > 1) {
        continue;
      }
      const sx = rect.left + ((this.issTraceLoupeScreenScratch.x + 1) / 2) * rect.width;
      const sy = rect.top + ((-this.issTraceLoupeScreenScratch.y + 1) / 2) * rect.height;
      const base = child.userData['countryLabelBase'] as { w: number; h: number } | undefined;
      const worldW = base?.w ?? child.scale.x;
      const worldH = base?.h ?? child.scale.y;
      const halfWPx = Math.max(4, ((worldW / 2) * pxPerWorldY) / distCam);
      const halfHPx = Math.max(3, ((worldH / 2) * pxPerWorldY) / distCam);
      const dx = (clientX - sx) / halfWPx;
      const dy = (clientY - sy) / halfHPx;
      if (dx * dx + dy * dy > 1) {
        continue;
      }
      const pixelDistSq = (clientX - sx) ** 2 + (clientY - sy) ** 2;
      if (!best || pixelDistSq < best.distSq) {
        best = { distSq: pixelDistSq, name: name.trim(), screenX: sx, screenY: sy };
      }
    }
    if (best === null) {
      return null;
    }
    return { name: best.name, screenX: best.screenX, screenY: best.screenY };
  }

  private updateCountryLabelLoupe(
    clientX: number,
    clientY: number,
    hit: { name: string; screenX: number; screenY: number } | null
  ): void {
    if (!hit) {
      if (this.countryLabelLoupeLabel !== null) {
        this.countryLabelLoupeLabel = null;
        this.countryLabelLoupeHoverName = null;
        this.scheduleWorldGlobeCdr();
      }
      return;
    }

    this.queueCountryLabelLoupePosition(hit.screenX, hit.screenY - 6);
    const labelChanged = hit.name !== this.countryLabelLoupeHoverName;
    if (!labelChanged && hit.name === this.countryLabelLoupeLabel) {
      return;
    }
    this.countryLabelLoupeHoverName = hit.name;
    this.countryLabelLoupeLabel = hit.name;
    if (labelChanged) {
      this.scheduleWorldGlobeCdr(() => {
        this.syncCountryLabelLoupePosition(this.pendingCountryLabelLoupeX, this.pendingCountryLabelLoupeY);
      });
    }
  }

  private queueCountryLabelLoupePosition(clientX: number, clientY: number): void {
    this.pendingCountryLabelLoupeX = clientX;
    this.pendingCountryLabelLoupeY = clientY;
    if (this.countryLabelLoupePosRaf != null) {
      return;
    }
    this.countryLabelLoupePosRaf = requestAnimationFrame(() => {
      this.countryLabelLoupePosRaf = null;
      this.syncCountryLabelLoupePosition(this.pendingCountryLabelLoupeX, this.pendingCountryLabelLoupeY);
    });
  }

  private syncCountryLabelLoupePosition(clientX: number, clientY: number): void {
    const el = this.countryLabelLoupe?.nativeElement;
    if (!el) {
      return;
    }
    el.style.transform = `translate3d(${clientX}px, ${clientY}px, 0) translate(-50%, -100%)`;
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

  /** Inverse de {@link leafletZoomForOrbitDistance} : zoom carte Leaflet → distance d’orbite sur le globe. */
  private static orbitDistanceFromLeafletZoom(leafletZoom: number): number {
    const z = THREE.MathUtils.clamp(leafletZoom, 3, 17);
    const margin = Math.pow(2, 16.35 - z) / 88;
    return 1 + Math.max(margin, 0.015);
  }

  private static async requestFullscreenCompat(el: Element): Promise<void> {
    const anyEl = el as HTMLElement & {
      requestFullscreen?: () => Promise<void>;
      webkitRequestFullscreen?: () => Promise<void> | void;
      mozRequestFullScreen?: () => Promise<void> | void;
      msRequestFullscreen?: () => Promise<void> | void;
    };
    const opts: FullscreenOptions = { navigationUI: 'hide' };
    if (anyEl.requestFullscreen) {
      await anyEl.requestFullscreen(opts);
      return;
    }
    if (anyEl.webkitRequestFullscreen) {
      await Promise.resolve(anyEl.webkitRequestFullscreen());
      return;
    }
    if (anyEl.mozRequestFullScreen) {
      await Promise.resolve(anyEl.mozRequestFullScreen());
      return;
    }
    if (anyEl.msRequestFullscreen) {
      await Promise.resolve(anyEl.msRequestFullscreen());
      return;
    }
    throw new Error('Fullscreen API unavailable');
  }

  private static async exitFullscreenCompat(
    doc: Document & {
      webkitExitFullscreen?: () => Promise<void>;
      mozCancelFullScreen?: () => Promise<void>;
      msExitFullscreen?: () => Promise<void>;
    }
  ): Promise<void> {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
      return;
    }
    if (doc.webkitExitFullscreen) {
      await doc.webkitExitFullscreen();
      return;
    }
    if (doc.mozCancelFullScreen) {
      await doc.mozCancelFullScreen();
      return;
    }
    if (doc.msExitFullscreen) {
      await doc.msExitFullscreen();
      return;
    }
    throw new Error('Exit fullscreen unavailable');
  }

  async toggleFullscreen(): Promise<void> {
    const region = this.getGlobeFullscreenRegion();
    if (!region) {
      return;
    }
    const fsEl = this.getDocumentFullscreenElement();

    if (this.isGlobeFullscreenElement(fsEl) || this.globeViewportLocked) {
      const wasPresentation = this.globePresentationMode;
      await this.exitGlobeFullscreenIfActive();
      this.globeViewportLocked = false;
      this.syncFullscreenFromDocument();
      this.applyIssEmbedPanelsOnPresentationChange(wasPresentation);
      this.scheduleGlobeViewAfterLayoutChange();
      return;
    }

    this.setGlobeTrueFullscreenBodyClass(false);
    const wasPresentation = this.globePresentationMode;
    try {
      await WorldGlobeComponent.requestFullscreenCompat(region);
      this.globeViewportLocked = false;
    } catch {
      try {
        this.setGlobeTrueFullscreenBodyClass(true);
        await WorldGlobeComponent.requestFullscreenCompat(document.documentElement);
        this.globeViewportLocked = false;
      } catch {
        this.setGlobeTrueFullscreenBodyClass(false);
        this.globeViewportLocked = true;
      }
    }
    this.syncFullscreenFromDocument();
    this.applyIssEmbedPanelsOnPresentationChange(wasPresentation);
    this.scheduleGlobeViewAfterLayoutChange();
  }

  /** Évite NG0100 : mises à jour de bindings après le cycle de détection en cours. */
  private scheduleGlobeViewAfterLayoutChange(): void {
    queueMicrotask(() => {
      this.scheduleWorldGlobeCdr();
      requestAnimationFrame(() => {
        this.resizeRendererToHost();
        this.refreshIssLivePiPPanelsLayout();
      });
    });
  }

  /** Diffère markForCheck (macrotask) pour éviter NG0100 sur composants frères (TraceViewerModal, etc.). */
  private scheduleWorldGlobeCdr(viewSync?: () => void): void {
    if (viewSync) {
      this.globeViewSyncQueue.push(viewSync);
    }
    if (this.globeCdrTimer != null) {
      return;
    }
    this.globeCdrTimer = setTimeout(() => {
      this.globeCdrTimer = null;
      this.zone.run(() => {
        if (this.globeViewSyncQueue.length) {
          for (const sync of this.globeViewSyncQueue) {
            sync();
          }
          this.globeViewSyncQueue.length = 0;
        }
        this.pushTickerUiSnapshot();
        this.cdr.markForCheck();
      });
    }, 0);
  }

  private applyGlobeRouteParams(params: ParamMap): void {
    this.applyDeepLinkAutoRotatePreference(params);
    const satId = (params.get('sat') ?? params.get('satellite') ?? '').trim().toLowerCase();
    if (satId) {
      this.clearAstroReturnSat();
      this.queueOrApplySatelliteDeepLink(satId);
      return;
    }
    const latStr = params.get('lat');
    const lonStr = params.get('lon') ?? params.get('lng');
    if (latStr && lonStr) {
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        let mapZoom: number | undefined;
        const zStr = params.get('z') ?? params.get('zoom');
        if (zStr != null && zStr !== '') {
          const z = parseFloat(zStr);
          if (Number.isFinite(z) && z >= 1 && z <= 22) {
            mapZoom = z;
          }
        }
        this.queueOrApplyGlobeDeepLink({ lat, lon, mapZoom });
        return;
      }
    }
    const returnSat = this.consumeAstroReturnSatId();
    if (returnSat && returnSat !== 'iss') {
      this.queueOrApplySatelliteDeepLink(returnSat);
    }
  }

  /** Accordéon panneau options : une seule section ouverte ; clic sur l’en-tête ouvre ou replie. */
  onGlobeOptSectionSummaryClick(sectionId: string, event: MouseEvent): void {
    event.preventDefault();
    this.openGlobeOptSectionId = this.openGlobeOptSectionId === sectionId ? null : sectionId;
  }

  toggleOptionsPanel(): void {
    const snap = this.snapshotIssPiPPanelSizes();
    this.showOptionsPanel = !this.showOptionsPanel;
    this.issPiPSuppressSizePersist = true;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        this.restoreIssPiPPanelSizes(snap);
        this.syncIssStandardPiPSizeWithHd();
        this.syncIssLivePiPStackOffset();
        this.resizeRendererToHost();
        requestAnimationFrame(() => this.resizeRendererToHost());
        window.setTimeout(() => {
          this.issPiPSuppressSizePersist = false;
        }, 450);
      });
    });
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

  onEarthRotationAxisToggle(): void {
    if (this.earthRotationAxisGroup) {
      this.earthRotationAxisGroup.visible = this.showEarthRotationAxis;
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

  onCountryBordersToggle(): void {
    if (this.countryBordersEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeCountryBordersOverlay();
      this.bordersOverlayFailed = false;
      this.bordersOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onIssOverlayToggle(): void {
    if (this.issOverlayEnabled) {
      this.clearIssTrail();
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.issKeepEarthCentered = false;
      this.issCameraCenterSmoothPrevMs = 0;
      this.issGlobeFreeOrbit = false;
      this.issManualRefreshInFlight = false;
      this.disposeIssMarkerMesh();
      this.disposeIssVisibilityCircle();
      this.clearIssTrail();
      this.disposeIssForecastTrail();
      this.issOverlayFailed = false;
      if (!this.issTickerEnabled) {
        this.clearIssPositionFeedState();
        this.stopIssPolling();
      } else {
        this.startIssPolling();
      }
      this.cdr.markForCheck();
    }
    this.schedulePersistIssGlobalPrefs();
  }

  isSatTickerFocused(satId: string): boolean {
    return satId === 'iss' ? !this.tickerFocusSatId : this.tickerFocusSatId === satId;
  }

  isSatVisibleFromUser(satId: string): boolean {
    return satId === 'iss' ? this.issVisibleFromUser : this.satelliteVisibleFromUser[satId] === true;
  }

  hasUserObserverPosition(): boolean {
    return this.userObserverLat != null && this.userObserverLon != null;
  }

  isSatOverlayOn(satId: string): boolean {
    return satId === 'iss' ? this.issOverlayEnabled : this.satelliteOverlayEnabled[satId] !== false;
  }

  onSatOverlayToggle(satId: string, enabled: boolean): void {
    if (satId === 'iss') {
      this.issOverlayEnabled = enabled;
      this.onIssOverlayToggle();
      return;
    }
    this.onGlobeSatelliteToggle(satId, enabled);
  }

  isSatTraceOn(satId: string): boolean {
    return satId === 'iss' ? this.issTraceVisible : this.satelliteFutureTraceById[satId] === true;
  }

  onSatTraceToggle(satId: string, enabled: boolean): void {
    if (satId === 'iss') {
      this.issTraceVisible = enabled;
      this.onIssTraceToggle();
      return;
    }
    this.onGlobeSatelliteFutureTraceOneToggle(satId, enabled);
  }

  onSelectSatForTicker(satId: string): void {
    this.onSelectSatelliteForTicker(satId === 'iss' ? null : satId, true);
  }

  onOpenSatelliteInfo(satId: string): void {
    const sat =
      satId === 'iss' ? this.issGlobeOption : this.globeSatelliteOptions.find((s) => s.id === satId);
    if (!sat) {
      return;
    }
    this.satelliteInfoSat = sat;
    this.satelliteInfoOpen = true;
    this.satelliteInfoLoading = true;
    this.satelliteInfoSnapshot = null;
    this.satelliteInfoPasses = [];
    this.satelliteInfoDossier = null;
    this.satelliteInfoDossierBusy = true;
    this.satelliteInfoSlideshowOpen = false;
    this.satelliteInfoFactHelpKey = null;
    this.cdr.markForCheck();
    void this.loadSatelliteInfoDetails(sat);
    this.loadSatelliteInfoDossier(sat);
  }

  closeSatelliteInfo(): void {
    this.satelliteInfoDossierSub?.unsubscribe();
    this.satelliteInfoDossierSub = null;
    this.satelliteInfoOpen = false;
    this.satelliteInfoSat = null;
    this.satelliteInfoLoading = false;
    this.satelliteInfoSnapshot = null;
    this.satelliteInfoPasses = [];
    this.satelliteInfoDossier = null;
    this.satelliteInfoDossierBusy = false;
    this.satelliteInfoSlideshowOpen = false;
    this.satelliteInfoFactHelpKey = null;
    this.slideshowModalComponent?.onSlideshowClose();
    this.cdr.markForCheck();
  }

  prefersSatelliteFactTapHelp(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none)').matches;
    return coarse || window.innerWidth <= 768;
  }

  onSatelliteFactTipActivate(helpKey: string, event?: Event): void {
    if (!this.prefersSatelliteFactTapHelp()) {
      return;
    }
    event?.preventDefault();
    event?.stopPropagation();
    this.satelliteInfoFactHelpKey = this.satelliteInfoFactHelpKey === helpKey ? null : helpKey;
    this.cdr.markForCheck();
  }

  openSatelliteInfoPhoto(): void {
    const dossier = this.satelliteInfoDossier;
    const url = dossier?.imageUrl || dossier?.thumbUrl;
    if (!url) {
      return;
    }
    if (!this.slideshowModalComponent) {
      setTimeout(() => this.openSatelliteInfoPhoto(), 0);
      return;
    }
    const title =
      dossier?.wikiTitle ||
      (this.satelliteInfoSat
        ? this.translate.instant(this.satelliteInfoSat.labelKey)
        : this.translate.instant('ASTRO_COMPASS.OBJECT_INFO_TITLE'));
    const source: SlideshowImageSource = {
      blobUrl: url,
      fileName: this.satelliteInfoImageFileName(url, title)
    };
    this.satelliteInfoSlideshowOpen = true;
    this.cdr.detectChanges();
    this.slideshowModalComponent.open([source], title, false);
  }

  onSatelliteInfoSlideshowClosed(): void {
    this.satelliteInfoSlideshowOpen = false;
    this.cdr.markForCheck();
  }

  private satelliteInfoImageFileName(url: string, title: string): string {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (last && /\.(jpe?g|png|gif|webp|svg|tif{1,2})$/i.test(last)) {
        return last;
      }
    } catch {
      /* ignore */
    }
    const base = title.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'satellite';
    return base + '.jpg';
  }

  private loadSatelliteInfoDossier(sat: AstroSatelliteOption): void {
    this.satelliteInfoDossierSub?.unsubscribe();
    this.satelliteInfoDossier = null;
    this.satelliteInfoDossierBusy = true;
    this.satelliteInfoDossierSub = this.astroObjectDossier.loadForSatellite(sat).subscribe({
      next: (dossier) => {
        if (this.satelliteInfoSat?.id !== sat.id) {
          return;
        }
        this.satelliteInfoDossier = dossier;
        this.satelliteInfoDossierBusy = false;
        this.cdr.markForCheck();
      },
      error: () => {
        if (this.satelliteInfoSat?.id !== sat.id) {
          return;
        }
        this.satelliteInfoDossier = null;
        this.satelliteInfoDossierBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  formatSatelliteInfoTime(d: Date | null | undefined): string {
    if (!d) {
      return '—';
    }
    return d.toLocaleString(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  satelliteInfoCardinal(deg: number | null | undefined): string {
    if (deg == null || !Number.isFinite(deg)) {
      return '';
    }
    const idx = ((Math.round(deg / 22.5) % 16) + 16) % 16;
    return WorldGlobeComponent.COMPASS_POINTS[idx]
      .map((letter) => this.translate.instant('ASTRO_COMPASS.DIR_' + letter))
      .join('');
  }

  satelliteInfoObserverDistance(): string | null {
    const km = this.satelliteInfoSnapshot?.slantKm;
    if (km == null || !Number.isFinite(km) || km <= 0) {
      return null;
    }
    const parts: string[] = [];
    const lightS = km / C_KM_PER_S;
    if (lightS >= 0.05) {
      parts.push(
        this.formatSatelliteInfoLightCount(lightS) +
          ' ' +
          this.translate.instant('ASTRO_COMPASS.DIST_LS_UNIT')
      );
    }
    parts.push(
      this.formatSatelliteInfoAu(km / KM_PER_AU) +
        ' ' +
        this.translate.instant('ASTRO_COMPASS.DIST_AU_UNIT')
    );
    parts.push(this.formatSatelliteInfoKm(km));
    return parts.join(' · ');
  }

  satelliteInfoLightTravel(): string | null {
    const km = this.satelliteInfoSnapshot?.slantKm;
    if (km == null || !Number.isFinite(km) || km <= 0) {
      return null;
    }
    const lightS = km / C_KM_PER_S;
    if (lightS < 0.05) {
      return null;
    }
    return this.translate.instant('ASTRO_COMPASS.LIGHT_TRAVEL_S', {
      n: this.formatSatelliteInfoLightCount(lightS)
    });
  }

  private formatSatelliteInfoKm(km: number): string {
    if (!Number.isFinite(km) || km < 0) {
      return '—';
    }
    const unit = this.translate.instant('ASTRO_COMPASS.DIST_KM_UNIT');
    const scaled = (value: number, suffix: string, digits: number): string =>
      value.toLocaleString(undefined, { maximumFractionDigits: digits }) + ' ' + suffix + unit;
    if (km >= 1e15) {
      return scaled(km / 1e15, 'P ', 2);
    }
    if (km >= 1e12) {
      return scaled(km / 1e12, 'T ', 2);
    }
    if (km >= 1e9) {
      const g = km / 1e9;
      return scaled(g, 'G ', g >= 100 ? 0 : g >= 10 ? 1 : 2);
    }
    if (km >= 1e6) {
      const m = km / 1e6;
      return scaled(m, 'M ', m >= 100 ? 0 : m >= 10 ? 1 : 2);
    }
    if (km >= 10_000) {
      return Math.round(km).toLocaleString() + ' ' + unit;
    }
    if (km >= 100) {
      return km.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' ' + unit;
    }
    if (km >= 1) {
      return km.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + unit;
    }
    if (km === 0) {
      return '0 ' + unit;
    }
    return km.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + unit;
  }

  private formatSatelliteInfoAu(au: number): string {
    if (!Number.isFinite(au) || au < 0) {
      return '—';
    }
    if (au >= 1) {
      return au.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    if (au >= 0.001) {
      return au.toLocaleString(undefined, { maximumFractionDigits: 4 });
    }
    if (au === 0) {
      return '0';
    }
    return au.toExponential(2);
  }

  private formatSatelliteInfoLightCount(n: number): string {
    if (n >= 1 && Math.abs(n - Math.round(n)) < 0.05) {
      return Math.round(n).toLocaleString();
    }
    if (n >= 10) {
      return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    if (n >= 1) {
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: n >= 0.01 ? 3 : 2 });
  }

  formatSatelliteInfoDuration(pass: GlobeSatellitePass): string {
    const sec = Math.max(0, Math.round((pass.setAt.getTime() - pass.riseAt.getTime()) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h} h ${m % 60} min`;
    }
    return s > 0 ? `${m} min ${s} s` : `${m} min`;
  }

  onCenterGlobeOnSatellite(satId: string): void {
    if (!this.globeSurfaceReady) {
      return;
    }
    if (satId === 'iss') {
      this.disposeSatelliteVisibilityCircle();
      this.onCenterGlobeOnIss();
      return;
    }
    if (this.satelliteOverlayEnabled[satId] === false) {
      this.onGlobeSatelliteToggle(satId, true);
    }
    this.globeSatVisibilityCircleSatId = satId;
    this.pendingCenterSatelliteId = satId;
    this.onSelectSatelliteForTicker(satId, true);
    this.tryCenterGlobeOnSatellite(satId);
  }

  /** Revient sur l’ISS : overlay, bandeau, suivi caméra et cadrage. */
  onCenterGlobeOnIss(): void {
    if (!this.globeSurfaceReady) {
      return;
    }
    if (!this.issOverlayEnabled) {
      this.issOverlayEnabled = true;
      this.onIssOverlayToggle();
    }
    this.clearGeocodeMarker();
    this.issKeepEarthCentered = true;
    this.issGlobeFreeOrbit = false;
    this.issCameraCenterSmoothPrevMs = 0;
    this.onSelectSatelliteForTicker(null, true);
    const lat = this.globeIssLat;
    const lon = this.globeIssLon;
    const camera = this.camera;
    const controls = this.controls;
    if (lat != null && lon != null && camera && controls) {
      const dist = THREE.MathUtils.clamp(
        this.globeOrbitDistance(),
        controls.minDistance,
        controls.maxDistance
      );
      this.animateCameraToLatLon(lat, lon, dist, GLOBE_RESET_VIEW_ANIM_MS, 0);
    }
    this.cdr.markForCheck();
    this.schedulePersistIssGlobalPrefs();
  }

  onGlobeSatelliteOverlayMasterToggle(): void {
    const enabled = this.satelliteOverlayMasterEnabled;
    for (const sat of this.globeMasterOverlaySatellites()) {
      this.satelliteOverlayEnabled[sat.id] = enabled;
      if (!enabled) {
        this.disposeGlobeSatelliteVisual(sat.id);
        this.disposeGlobeSatelliteForecastTrail(sat.id);
      } else {
        this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
        void this.satNowService.ensureOption(sat);
      }
    }
    this.satelliteOverlayPrefsTouched = true;
    this.schedulePersistGlobeSatelliteOverlayPrefs();
    if (enabled) {
      this.satelliteForecastLastRebuildMs = 0;
      this.updateGlobeSatelliteOverlays();
      this.updateGlobeSatelliteForecastTrails(true);
    } else {
      this.disposeSatelliteVisibilityCircle();
    }
    this.syncTickerFocusToEnabledSatellites();
    this.cdr.markForCheck();
  }

  onGlobeSatelliteToggle(satId: string, enabled: boolean): void {
    this.satelliteOverlayEnabled[satId] = enabled;
    this.syncGlobeSatelliteOverlayMaster();
    this.satelliteOverlayPrefsTouched = true;
    this.schedulePersistGlobeSatelliteOverlayPrefs();
    if (!enabled) {
      this.disposeGlobeSatelliteVisual(satId);
      this.disposeGlobeSatelliteForecastTrail(satId);
      if (this.globeSatVisibilityCircleSatId === satId) {
        this.disposeSatelliteVisibilityCircle();
      }
    } else {
      const sat = this.globeSatelliteOptions.find((s) => s.id === satId);
      if (sat) {
        this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
        void this.satNowService.ensureOption(sat);
      }
      this.satelliteForecastLastRebuildMs = 0;
      this.updateGlobeSatelliteOverlays();
      this.updateGlobeSatelliteForecastTrails(true);
    }
    this.syncTickerFocusToEnabledSatellites();
    this.cdr.markForCheck();
  }

  onGlobeSatelliteFutureTraceToggle(): void {
    for (const sat of this.globeSatelliteOptions) {
      this.satelliteFutureTraceById[sat.id] = this.satelliteFutureTraceEnabled;
      if (!this.satelliteFutureTraceEnabled) {
        this.disposeGlobeSatelliteForecastTrail(sat.id);
      }
    }
    this.satelliteOverlayPrefsTouched = true;
    this.schedulePersistGlobeSatelliteOverlayPrefs();
    this.satelliteForecastLastRebuildMs = 0;
    this.updateGlobeSatelliteForecastTrails(true);
    this.cdr.markForCheck();
  }

  onGlobeSatelliteFutureTraceOneToggle(satId: string, enabled: boolean): void {
    this.satelliteFutureTraceById[satId] = enabled;
    this.syncGlobeSatelliteFutureTraceMaster();
    this.satelliteOverlayPrefsTouched = true;
    this.schedulePersistGlobeSatelliteOverlayPrefs();
    if (!enabled) {
      this.disposeGlobeSatelliteForecastTrail(satId);
    }
    this.satelliteForecastLastRebuildMs = 0;
    this.updateGlobeSatelliteForecastTrails(true);
    this.cdr.markForCheck();
  }

  private enabledGlobeSatelliteIds(): string[] {
    return this.globeSatelliteOptions
      .filter((s) => this.satelliteOverlayEnabled[s.id] !== false)
      .map((s) => s.id);
  }

  /** Un seul satellite affiché → le bandeau montre ses données ; sinon ISS si le focus n’est plus visible. */
  private syncTickerFocusToEnabledSatellites(): void {
    const enabled = this.enabledGlobeSatelliteIds();
    if (enabled.length === 1) {
      const sole = enabled[0];
      this.onSelectSatelliteForTicker(sole);
      if (this.lastSoleEnabledSatId !== sole) {
        this.lastSoleEnabledSatId = sole;
        this.pendingCenterSatelliteId = sole;
        this.tryCenterGlobeOnSatellite(sole);
      }
      return;
    }
    this.lastSoleEnabledSatId = null;
    if (this.tickerFocusSatId && !enabled.includes(this.tickerFocusSatId)) {
      this.onSelectSatelliteForTicker(null);
    }
  }

  private globeMasterOverlaySatellites(): AstroSatelliteOption[] {
    return this.globeSatelliteOptions.filter(satelliteInGlobeMasterToggle);
  }

  private syncGlobeSatelliteOverlayMaster(): void {
    const group = this.globeMasterOverlaySatellites();
    this.satelliteOverlayMasterEnabled =
      group.length > 0 && group.every((s) => this.satelliteOverlayEnabled[s.id] !== false);
  }

  private syncGlobeSatelliteFutureTraceMaster(): void {
    this.satelliteFutureTraceEnabled =
      this.globeSatelliteOptions.length > 0 &&
      this.globeSatelliteOptions.every((s) => this.satelliteFutureTraceById[s.id] === true);
  }

  private isGlobeSatelliteFutureTraceOn(satId: string): boolean {
    return (
      this.satelliteFutureTraceById[satId] === true &&
      this.satelliteOverlayEnabled[satId] !== false
    );
  }

  onGlobeSatelliteFutureTraceHoursDelta(deltaHours: number): void {
    this.setGlobeSatelliteFutureTraceMinutes((this.satelliteFutureTraceHours + deltaHours) * 60);
  }

  onGlobeSatelliteFutureTraceHoursCommitted(): void {
    this.setGlobeSatelliteFutureTraceMinutes(this.satelliteFutureTraceHours * 60);
  }

  private setGlobeSatelliteFutureTraceMinutes(raw: number): void {
    const next = WorldGlobeComponent.clampSatelliteFutureTraceMinutes(raw);
    this.satelliteFutureTraceHours = WorldGlobeComponent.hoursFromTraceMinutes(next);
    if (next === this.satelliteFutureTraceMinutes) {
      this.satelliteFutureTraceMinutes = next;
      this.cdr.markForCheck();
      return;
    }
    this.satelliteFutureTraceMinutes = next;
    this.satelliteOverlayPrefsTouched = true;
    this.schedulePersistGlobeSatelliteOverlayPrefs();
    this.satelliteForecastLastRebuildMs = 0;
    this.updateGlobeSatelliteForecastTrails(true);
    this.refreshIssForecastTrailForDuration();
    this.cdr.markForCheck();
  }

  private satelliteForecastStepMs(): number {
    const targetPts = 360;
    const raw = Math.round((this.satelliteFutureTraceMinutes * 60_000) / targetPts);
    return Math.min(300_000, Math.max(GLOBE_SAT_FORECAST_STEP_MS, raw));
  }

  private issForecastStepSec(): number {
    const targetPts = 180;
    const raw = Math.round((this.satelliteFutureTraceMinutes * 60) / targetPts);
    return Math.min(600, Math.max(GLOBE_ISS_FORECAST_STEP_SEC, raw));
  }

  private refreshIssForecastTrailForDuration(): void {
    this.issNowService.setForecastMinutes(this.satelliteFutureTraceMinutes);
    if (
      !this.issOverlayEnabled ||
      !this.issTraceVisible ||
      this.globeIssLat == null ||
      this.globeIssLon == null
    ) {
      return;
    }
    this.issForecastLastFetchMs = 0;
    void this.loadIssForecastTrail(
      this.globeIssLat,
      this.globeIssLon,
      this.issSpeedSampleLat,
      this.issSpeedSampleLon,
      this.issGroundSpeedKmh,
      true
    );
  }

  private static hoursFromTraceMinutes(minutes: number): number {
    return Math.round((minutes / 60) * 100) / 100;
  }

  private static clampSatelliteFutureTraceMinutes(raw: number): number {
    if (!Number.isFinite(raw)) {
      return GLOBE_SAT_FORECAST_MINUTES_DEFAULT;
    }
    const hours = raw / 60;
    const steppedHours = Math.round(hours / GLOBE_SAT_FORECAST_HOURS_STEP) * GLOBE_SAT_FORECAST_HOURS_STEP;
    const minutes = Math.round(steppedHours * 60);
    return Math.min(
      GLOBE_SAT_FORECAST_MINUTES_MAX,
      Math.max(GLOBE_SAT_FORECAST_MINUTES_MIN, minutes)
    );
  }

  onIssTickerToggle(): void {
    if (this.issTickerEnabled) {
      this.startIssPolling();
      void this.refreshIssNow();
    } else if (!this.issOverlayEnabled) {
      this.stopIssPolling();
      this.clearIssPositionFeedState();
    }
    this.pushTickerUiSnapshot();
    this.cdr.markForCheck();
    this.schedulePersistIssGlobalPrefs();
  }

  /**
   * Interrupteur maître : affiche/masque la traînée ISS temps réel et la prédiction rouge.
   * La trace historique MongoDB reste pilotée par {@link issHistoricalTraceEnabled}.
   */
  onIssTraceToggle(): void {
    if (this.issTraceVisible) {
      this.rebuildIssTrailGeometry();
      this.rebuildIssForecastTrailGeometry();
    }
    this.applyIssTraceVisibility();
    this.cdr.markForCheck();
    this.schedulePersistIssGlobalPrefs();
  }

  /** Horodatage (ms) du point de trace ISS le plus ancien connu, sinon `null`. */
  private oldestIssTraceEpochMs(): number | null {
    let oldest: number | null = null;
    for (const p of this.issHistoricalTrailPoints) {
      const raw = p.recordedAt?.trim();
      if (!raw) {
        continue;
      }
      const ms = new Date(raw).getTime();
      if (Number.isNaN(ms)) {
        continue;
      }
      if (oldest === null || ms < oldest) {
        oldest = ms;
      }
    }
    return oldest;
  }

  /** Date et heure locales actuelles (jj/mm/aa hh:mm:ss) pour le bandeau ISS défilant. */
  currentDateTimeLabel(): string {
    return this.issTickerNowLabel || this.formatDateTimeLabel(Date.now());
  }

  private formatDateTimeLabel(ms: number): string {
    try {
      const lang = (this.translate.currentLang || 'en').split('-')[0];
      if (lang !== this.dateTimeLabelFormatterLang || !this.dateTimeLabelFormatter) {
        this.dateTimeLabelFormatterLang = lang;
        this.dateTimeLabelFormatter = new Intl.DateTimeFormat(lang, {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
      }
      return this.dateTimeLabelFormatter.format(new Date(ms));
    } catch {
      return '';
    }
  }

  private invalidateDateTimeLabelFormatter(): void {
    this.dateTimeLabelFormatterLang = '';
    this.dateTimeLabelFormatter = undefined;
  }

  /**
   * Date/heure de la trace ISS la plus ancienne, décomposée en cellules pour l’afficheur LCD
   * (police DSEG7). Format `JJ-MM-AA HH:MM` (séparateurs compatibles 7 segments). `[]` si aucune.
   * `ghost` = couche « segments éteints » (8 pour les chiffres et le tiret, sinon le caractère lui-même).
   */
  oldestIssTraceLcdChars(): { lit: string; ghost: string }[] {
    const oldest = this.oldestIssTraceEpochMs();
    if (oldest === null) {
      return [];
    }
    const d = new Date(oldest);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const text = `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${p2(d.getFullYear() % 100)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return Array.from(text).map((c) => ({
      lit: c,
      ghost: /[0-9]/.test(c) || c === '-' ? '8' : c
    }));
  }

  /** Nombre de points de trace ISS historiques actuellement chargés. */
  get issHistoricalTraceCount(): number {
    return this.issHistoricalTrailPoints.length;
  }

  /** Nombre de points de trace décomposé en cellules pour l’afficheur LCD (mêmes conventions que la date). */
  issHistoricalTraceCountLcdChars(): { lit: string; ghost: string }[] {
    return Array.from(String(this.issHistoricalTraceCount)).map((c) => ({
      lit: c,
      ghost: /[0-9]/.test(c) || c === '-' ? '8' : c
    }));
  }

  /** Date/heure formatée (jj/mm/aa hh:mm) de la trace ISS la plus ancienne ; '' si aucune. */
  oldestIssTraceDateLabel(): string {
    const oldest = this.oldestIssTraceEpochMs();
    if (oldest === null) {
      return '';
    }
    return this.formatIssTraceDateLabel(new Date(oldest).toISOString());
  }

  /** Applique la visibilité des traces ISS live (master) et historique (interrupteur dédié). */
  private applyIssTraceVisibility(): void {
    const liveVisible = this.issTraceVisible;
    if (this.issTrailLine) {
      this.issTrailLine.visible = liveVisible && this.issTrailPoints.length >= 2;
    }
    if (this.issForecastTrailLine) {
      this.issForecastTrailLine.visible = liveVisible && this.issForecastTrailPoints.length >= 1;
    }
    if (this.issHistoricalTrailLine) {
      this.issHistoricalTrailLine.visible = this.issHistoricalTraceEnabled;
    }
    if (this.issHistoricalTraceDateLabelsGroup) {
      this.issHistoricalTraceDateLabelsGroup.visible =
        this.issHistoricalTraceEnabled && this.issHistoricalTraceDatesEnabled;
    }
  }

  loadIssBackgroundTraceSetting(): void {
    this.issBackgroundTraceLoading = true;
    this.apiService
      .getIssTraceBackgroundRecording()
      .pipe(
        finalize(() => {
          this.issBackgroundTraceLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          this.issBackgroundTraceEnabled = !!res?.enabled;
          if (typeof res?.intervalMinutes === 'number' && res.intervalMinutes > 0) {
            this.issBackgroundTraceIntervalMinutes = res.intervalMinutes;
          }
        },
        error: () => {
          /* keep defaults */
        }
      });
  }

  onIssBackgroundTraceToggle(): void {
    if (this.issBackgroundTraceSaving) {
      return;
    }
    const next = this.issBackgroundTraceEnabled;
    this.issBackgroundTraceSaving = true;
    this.apiService
      .setIssTraceBackgroundRecording(next)
      .pipe(
        finalize(() => {
          this.issBackgroundTraceSaving = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          this.issBackgroundTraceEnabled = !!res?.enabled;
          if (typeof res?.intervalMinutes === 'number' && res.intervalMinutes > 0) {
            this.issBackgroundTraceIntervalMinutes = res.intervalMinutes;
          }
        },
        error: () => {
          this.issBackgroundTraceEnabled = !next;
          this.cdr.markForCheck();
        }
      });
  }

  loadIssTraceDisplayLimitSetting(): void {
    this.issTraceDisplayLimitLoading = true;
    this.apiService
      .getIssTraceDisplayLimit()
      .pipe(
        finalize(() => {
          this.issTraceDisplayLimitLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          this.issTraceDisplayLimitEnabled = !!res?.enabled;
          if (typeof res?.maxPoints === 'number' && res.maxPoints > 0) {
            this.issTraceDisplayLimitMaxPoints = res.maxPoints;
          }
        },
        error: () => {
          /* keep defaults */
        }
      });
  }

  onIssTraceDisplayLimitToggle(): void {
    if (this.issTraceDisplayLimitSaving) {
      return;
    }
    const next = this.issTraceDisplayLimitEnabled;
    this.issTraceDisplayLimitSaving = true;
    this.apiService
      .setIssTraceDisplayLimit(next)
      .pipe(
        finalize(() => {
          this.issTraceDisplayLimitSaving = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          this.issTraceDisplayLimitEnabled = !!res?.enabled;
          if (typeof res?.maxPoints === 'number' && res.maxPoints > 0) {
            this.issTraceDisplayLimitMaxPoints = res.maxPoints;
          }
          void this.loadIssHistoricalTrace();
        },
        error: () => {
          this.issTraceDisplayLimitEnabled = !next;
          this.cdr.markForCheck();
        }
      });
  }

  loadIssAlertConfig(): void {
    if (this.issAlertConfigLoaded || this.issAlertLoading) {
      return;
    }
    this.issAlertLoading = true;
    this.apiService
      .getIssAlertConfig()
      .pipe(
        finalize(() => {
          this.issAlertLoading = false;
          this.issAlertConfigLoaded = true;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          this.applyIssAlertConfig(res);
          if (this.hasIssAlertAdminRole()) {
            this.loadIssAlertAdminList();
          }
        },
        error: () => {
          this.applyIssAlertConfig(null);
        }
      });
  }

  hasIssAlertAdminRole(): boolean {
    return this.keycloakService.hasAdminRole();
  }

  issAlertHasOwnConfig(): boolean {
    return (
      this.issAlertEnabled ||
      !!(this.issAlertEmail && this.issAlertEmail.trim()) ||
      !!(this.issAlertPlace && this.issAlertPlace.trim())
    );
  }

  private loadIssAlertAdminList(): void {
    if (!this.hasIssAlertAdminRole() || this.issAlertAdminLoading) {
      return;
    }
    this.issAlertAdminLoading = true;
    this.apiService
      .getIssAlertsAdmin()
      .pipe(
        finalize(() => {
          this.issAlertAdminLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (entries) => {
          this.issAlertAdminEntries = Array.isArray(entries) ? entries : [];
        },
        error: () => {
          this.issAlertAdminEntries = [];
        }
      });
  }

  private loadIssAlertModalEntries(): void {
    if (this.issAlertAdminLoading) {
      return;
    }
    if (this.hasIssAlertAdminRole()) {
      this.loadIssAlertAdminList();
      return;
    }
    const own = this.buildOwnIssAlertModalEntry();
    this.issAlertAdminEntries = own ? [own] : [];
    this.cdr.markForCheck();
  }

  private buildOwnIssAlertModalEntry(): IssAlertAdminEntry | null {
    if (!this.issAlertHasOwnConfig()) {
      return null;
    }
    const userId = this.keycloakService.getJwtSubject() || '';
    const owner =
      this.keycloakService.getUsernameForDisplay()
      || this.keycloakService.getPreferredUsername()
      || userId;
    return {
      userId,
      owner,
      enabled: this.issAlertEnabled,
      email: this.issAlertEmail,
      place: this.issAlertPlace,
      placeLabel: this.issAlertPlaceLabel,
      lat: this.issAlertLat,
      lon: this.issAlertLon,
      minQuality: this.issAlertMinQuality
    };
  }

  issAlertManageBadgeCount(): number {
    if (this.hasIssAlertAdminRole()) {
      return this.issAlertAdminEntries.length;
    }
    return this.issAlertHasOwnConfig() ? 1 : 0;
  }

  openIssAlertAdminModal(): void {
    this.issAlertAdminDeleteError = '';
    this.issAlertAdminModalOpen = true;
    this.loadIssAlertModalEntries();
  }

  closeIssAlertAdminModal(): void {
    this.issAlertAdminModalOpen = false;
    this.issAlertAdminDeleteError = '';
    this.issAlertPassesUi = {};
  }

  canEditIssAlertRow(row: IssAlertAdminEntry): boolean {
    const userId = (row.userId || '').trim();
    if (!userId) {
      return false;
    }
    if (this.hasIssAlertAdminRole()) {
      return true;
    }
    return this.keycloakService.isCurrentUserIdentity(userId);
  }

  isIssAlertEditingOtherUser(): boolean {
    const editing = (this.issAlertEditingUserId || '').trim();
    if (!editing) {
      return false;
    }
    return !this.keycloakService.isCurrentUserIdentity(editing);
  }

  editIssAlertAdminEntry(row: IssAlertAdminEntry): void {
    if (!this.canEditIssAlertRow(row)) {
      return;
    }
    const userId = (row.userId || '').trim();
    const isOther = !!userId && !this.keycloakService.isCurrentUserIdentity(userId);
    if (isOther) {
      this.issAlertEditingUserId = userId;
      this.issAlertEditingOwnerLabel = this.formatIssAlertAdminOwner(row);
    } else {
      this.issAlertEditingUserId = null;
      this.issAlertEditingOwnerLabel = '';
    }
    this.issAlertError = '';
    this.issAlertNotice = '';
    this.issAlertEnabled = !!row.enabled;
    this.issAlertEmail = row.email || '';
    this.issAlertPlace = row.place || '';
    this.issAlertPlaceLabel = row.placeLabel || '';
    this.issAlertLat = typeof row.lat === 'number' ? row.lat : null;
    this.issAlertLon = typeof row.lon === 'number' ? row.lon : null;
    this.issAlertMinQuality = row.minQuality || 'fair';
    this.closeIssAlertAdminModal();
    this.showOptionsPanel = true;
    this.cdr.markForCheck();
    queueMicrotask(() => this.scrollToIssAlertForm());
  }

  cancelIssAlertEdit(): void {
    this.issAlertEditingUserId = null;
    this.issAlertEditingOwnerLabel = '';
    this.issAlertError = '';
    this.issAlertNotice = '';
    this.issAlertLoading = true;
    this.apiService
      .getIssAlertConfig()
      .pipe(
        finalize(() => {
          this.issAlertLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => this.applyIssAlertConfig(res),
        error: () => this.applyIssAlertConfig(null)
      });
  }

  private scrollToIssAlertForm(): void {
    document.querySelector<HTMLElement>('.wg-iss-alert-section')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    });
    document.getElementById('wgIssAlertPlace')?.focus({ preventScroll: true });
  }

  private issAlertSaveRequest(body: {
    enabled?: boolean;
    email?: string;
    place?: string;
    minQuality?: string;
  }) {
    if (this.isIssAlertEditingOtherUser() && this.issAlertEditingUserId) {
      return this.apiService.setIssAlertConfigAdmin(this.issAlertEditingUserId, body);
    }
    return this.apiService.setIssAlertConfig(body);
  }

  issAlertPassesKey(row: IssAlertAdminEntry): string {
    return (row.userId || row.email || '__self__').trim();
  }

  getIssAlertPassesUi(row: IssAlertAdminEntry): IssAlertPassesUiState | null {
    return this.issAlertPassesUi[this.issAlertPassesKey(row)] ?? null;
  }

  isIssAlertPassesOpen(row: IssAlertAdminEntry): boolean {
    return !!this.getIssAlertPassesUi(row)?.open;
  }

  toggleIssAlertUpcomingPasses(row: IssAlertAdminEntry): void {
    const key = this.issAlertPassesKey(row);
    const existing = this.issAlertPassesUi[key];
    if (existing?.open) {
      existing.open = false;
      this.cdr.markForCheck();
      return;
    }
    if (existing?.lines.length || existing?.error) {
      existing.open = true;
      this.cdr.markForCheck();
      return;
    }
    this.issAlertPassesUi[key] = {
      loading: true,
      error: '',
      lines: [],
      open: true
    };
    this.fetchIssAlertUpcomingPasses(row, key);
  }

  private fetchIssAlertUpcomingPasses(row: IssAlertAdminEntry, key: string): void {
    const lat = row.lat != null ? Number(row.lat) : NaN;
    const lon = row.lon != null ? Number(row.lon) : NaN;
    const placeQuery = (row.place || row.placeLabel || '').trim();
    const request$ =
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? this.apiService.getIssPassesByCoordinates(lat, lon, 5)
        : placeQuery
          ? this.apiService.getIssPassesByPlace(placeQuery, 5)
          : null;
    if (!request$) {
      this.setIssAlertPassesError(
        key,
        this.translate.instant('WORLD_GLOBE.ISS_ALERT_ADMIN_NO_PLACE')
      );
      return;
    }
    request$
      .pipe(
        finalize(() => {
          const state = this.issAlertPassesUi[key];
          if (state) {
            state.loading = false;
          }
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (body) => this.applyIssAlertPassesResponse(key, body as IssPassByPlaceResponse),
        error: () => {
          this.setIssAlertPassesError(
            key,
            this.translate.instant('WORLD_GLOBE.ISS_PASS_ERROR')
          );
        }
      });
  }

  private applyIssAlertPassesResponse(key: string, body: IssPassByPlaceResponse): void {
    const state = this.issAlertPassesUi[key];
    if (!state) {
      return;
    }
    const parsed = this.extractIssPassLines(body);
    state.lines = parsed.lines;
    state.error = parsed.error;
    state.loading = false;
    this.cdr.markForCheck();
  }

  private setIssAlertPassesError(key: string, message: string): void {
    const state = this.issAlertPassesUi[key];
    if (!state) {
      this.issAlertPassesUi[key] = {
        loading: false,
        error: message,
        lines: [],
        open: true
      };
    } else {
      state.loading = false;
      state.error = message;
      state.lines = [];
    }
    this.cdr.markForCheck();
  }

  private extractIssPassLines(body: IssPassByPlaceResponse): { lines: string[]; error: string } {
    const status = String(body?.status ?? '').toLowerCase();
    if (status === 'ambiguous') {
      return {
        lines: [],
        error: this.translate.instant('WORLD_GLOBE.ISS_PASS_AMBIGUOUS_HINT')
      };
    }
    if (status !== 'success') {
      const code = body?.code ?? '';
      if (code === 'no_geocode_results') {
        return { lines: [], error: this.translate.instant('ADDRESS_GEOCODE.NO_RESULTS') };
      }
      if (code === 'no_passes') {
        return { lines: [], error: this.translate.instant('WORLD_GLOBE.ISS_PASS_NONE') };
      }
      return {
        lines: [],
        error: body?.message?.trim() || this.translate.instant('WORLD_GLOBE.ISS_PASS_ERROR')
      };
    }
    const passes = body.passes?.response ?? (body.nextPass ? [body.nextPass] : []);
    const lines = passes
      .map((p) => this.formatIssPassLine(p))
      .filter((line): line is string => !!line);
    if (!lines.length) {
      return { lines: [], error: this.translate.instant('WORLD_GLOBE.ISS_PASS_NONE') };
    }
    return { lines, error: '' };
  }

  formatIssAlertAdminOwner(row: IssAlertAdminEntry): string {
    const owner = (row.owner || '').trim();
    if (owner && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) {
      return owner;
    }
    return (row.email || row.userId || '').trim();
  }

  isIssAlertRowDeleting(row: IssAlertAdminEntry): boolean {
    const deleting = this.issAlertAdminDeletingUserId;
    if (!deleting) {
      return false;
    }
    return deleting === (row.userId || '__self__');
  }

  formatIssAlertAdminQuality(minQuality: string | undefined): string {
    switch ((minQuality || '').toLowerCase()) {
      case 'good':
        return this.translate.instant('WORLD_GLOBE.ISS_ALERT_QUALITY_GOOD');
      case 'any':
        return this.translate.instant('WORLD_GLOBE.ISS_ALERT_QUALITY_ANY');
      default:
        return this.translate.instant('WORLD_GLOBE.ISS_ALERT_QUALITY_FAIR');
    }
  }

  deleteIssAlertAdminEntry(row: IssAlertAdminEntry): void {
    if (this.issAlertAdminDeletingUserId) {
      return;
    }
    const userId = (row.userId || '').trim();
    const isAdmin = this.hasIssAlertAdminRole();
    const isAdminDeletingOther = isAdmin && !!userId && !this.keycloakService.isCurrentUserIdentity(userId);
    if (isAdmin && !userId) {
      return;
    }
    const owner = this.formatIssAlertAdminOwner(row);
    const email = (row.email || '').trim();
    const confirmMsg = this.translate.instant(
      isAdminDeletingOther ? 'WORLD_GLOBE.ISS_ALERT_ADMIN_DELETE_CONFIRM' : 'WORLD_GLOBE.ISS_ALERT_DELETE_CONFIRM',
      { owner, email: email || '—' }
    );
    if (!window.confirm(confirmMsg)) {
      return;
    }
    this.issAlertAdminDeleteError = '';
    this.issAlertAdminDeletingUserId = isAdminDeletingOther ? userId : (userId || '__self__');
    const delete$ = isAdminDeletingOther
      ? this.apiService.deleteIssAlertAdmin(userId)
      : this.apiService.deleteIssAlert();
    delete$
      .pipe(
        finalize(() => {
          this.issAlertAdminDeletingUserId = '';
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          if (!isAdminDeletingOther) {
            this.applyIssAlertConfig(null);
            this.issAlertEditingUserId = null;
            this.issAlertEditingOwnerLabel = '';
          } else if (
            this.issAlertEditingUserId &&
            (this.issAlertEditingUserId || '').trim() === userId
          ) {
            this.cancelIssAlertEdit();
          }
          if (isAdmin) {
            this.issAlertAdminEntries = this.issAlertAdminEntries.filter((e) => (e.userId || '').trim() !== userId);
          } else {
            this.issAlertAdminEntries = [];
          }
        },
        error: () => {
          this.issAlertAdminDeleteError = this.translate.instant('WORLD_GLOBE.ISS_ALERT_ADMIN_DELETE_ERROR');
        }
      });
  }

  private applyIssAlertConfig(res: IssAlertConfig | null | undefined): void {
    this.issAlertEnabled = false;
    this.issAlertEmail = '';
    this.issAlertPlace = '';
    this.issAlertPlaceLabel = '';
    this.issAlertLat = null;
    this.issAlertLon = null;
    this.issAlertMinQuality = 'fair';
    if (!res) {
      return;
    }
    this.applyIssAlertConfigFromRow(res);
  }

  private applyIssAlertConfigFromRow(res: IssAlertConfig): void {
    this.issAlertEnabled = !!res.enabled;
    this.issAlertEmail = res.email || '';
    this.issAlertPlace = res.place || '';
    this.issAlertPlaceLabel = res.placeLabel || '';
    this.issAlertLat = typeof res.lat === 'number' ? res.lat : null;
    this.issAlertLon = typeof res.lon === 'number' ? res.lon : null;
    this.issAlertMinQuality = res.minQuality || 'fair';
    if (typeof res.leadMinutes === 'number' && res.leadMinutes > 0) {
      this.issAlertLeadMinutes = res.leadMinutes;
    }
  }

  onIssAlertEnabledToggle(): void {
    if (this.issAlertSaving) {
      return;
    }
    const next = this.issAlertEnabled;
    this.issAlertError = '';
    this.issAlertNotice = '';
    this.issAlertSaving = true;
    this.issAlertSaveRequest({ enabled: next })
      .pipe(
        finalize(() => {
          this.issAlertSaving = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          if (this.isIssAlertEditingOtherUser()) {
            this.applyIssAlertConfigFromRow(res);
          } else {
            this.applyIssAlertConfig(res);
          }
          if (this.hasIssAlertAdminRole()) {
            this.loadIssAlertAdminList();
          }
        },
        error: () => {
          this.issAlertEnabled = !next;
          this.issAlertError = this.translate.instant('WORLD_GLOBE.ISS_ALERT_SAVE_ERROR');
          this.cdr.markForCheck();
        }
      });
  }

  saveIssAlertConfig(): void {
    if (this.issAlertSaving) {
      return;
    }
    this.issAlertError = '';
    this.issAlertNotice = '';
    this.issAlertSaving = true;
    this.issAlertSaveRequest({
        enabled: this.issAlertEnabled,
        email: (this.issAlertEmail || '').trim(),
        place: (this.issAlertPlace || '').trim(),
        minQuality: this.issAlertMinQuality
      })
      .pipe(
        finalize(() => {
          this.issAlertSaving = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          if (this.isIssAlertEditingOtherUser()) {
            this.applyIssAlertConfigFromRow(res);
          } else {
            this.applyIssAlertConfig(res);
            this.issAlertEditingUserId = null;
            this.issAlertEditingOwnerLabel = '';
          }
          this.issAlertNotice = this.translate.instant('WORLD_GLOBE.ISS_ALERT_SAVED');
          if (this.hasIssAlertAdminRole()) {
            this.loadIssAlertAdminList();
          }
        },
        error: (err) => {
          const code = err?.error?.error;
          this.issAlertError =
            code === 'no_geocode_results'
              ? this.translate.instant('ADDRESS_GEOCODE.NO_RESULTS')
              : this.translate.instant('WORLD_GLOBE.ISS_ALERT_SAVE_ERROR');
          this.cdr.markForCheck();
        }
      });
  }

  sendIssAlertTest(): void {
    if (this.issAlertTesting) {
      return;
    }
    this.issAlertError = '';
    this.issAlertNotice = '';
    this.issAlertTesting = true;
    this.apiService
      .sendIssAlertTest()
      .pipe(
        finalize(() => {
          this.issAlertTesting = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => {
          if (res?.ok) {
            this.issAlertNotice = this.translate.instant('WORLD_GLOBE.ISS_ALERT_TEST_SENT');
          } else if (res?.status === 'no_pass') {
            this.issAlertError = this.translate.instant('WORLD_GLOBE.ISS_ALERT_TEST_NO_PASS');
          } else if (res?.status === 'no_place') {
            this.issAlertError = this.translate.instant('WORLD_GLOBE.ISS_ALERT_TEST_NO_PLACE');
          } else {
            this.issAlertError = this.translate.instant('WORLD_GLOBE.ISS_ALERT_SAVE_ERROR');
          }
        },
        error: () => {
          this.issAlertError = this.translate.instant('WORLD_GLOBE.ISS_ALERT_SAVE_ERROR');
          this.cdr.markForCheck();
        }
      });
  }

  onIssHistoricalTraceToggle(): void {
    if (this.issHistoricalTraceEnabled) {
      void this.loadIssHistoricalTrace();
    } else {
      this.clearIssHistoricalTrail();
      this.issHistoricalTraceFailed = false;
      this.applyIssTraceVisibility();
      this.cdr.markForCheck();
    }
    this.schedulePersistIssGlobalPrefs();
  }

  onIssHistoricalTraceDatesToggle(): void {
    if (this.issHistoricalTraceDatesEnabled) {
      this.rebuildIssHistoricalTraceDateLabels();
    } else {
      this.disposeIssHistoricalTraceDateLabels();
    }
    this.cdr.markForCheck();
    this.schedulePersistIssGlobalPrefs();
  }

  onClearIssHistoricalTraceClick(): void {
    if (this.issHistoricalTraceClearInFlight || !this.globeSurfaceReady) {
      return;
    }
    this.issHistoricalTraceClearInFlight = true;
    this.issHistoricalTraceFailed = false;
    this.cdr.markForCheck();
    this.http
      .delete<void>(this.globeIssTraceUrl())
      .pipe(
        finalize(() => {
          this.issHistoricalTraceClearInFlight = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          this.clearIssHistoricalTrail();
        },
        error: () => {
          this.issHistoricalTraceFailed = true;
        }
      });
  }

  issTickerHasLiveData(): boolean {
    if (this.tickerFocusSatId) {
      return this.satTickerLat != null && this.satTickerLon != null;
    }
    return this.globeIssLat != null && this.globeIssLon != null;
  }

  tickerFocusSat(): AstroSatelliteOption | null {
    if (!this.tickerFocusSatId) {
      return null;
    }
    return this.globeSatelliteOptions.find((s) => s.id === this.tickerFocusSatId) ?? null;
  }

  tickerLabelName(): string {
    const sat = this.tickerFocusSat();
    return sat ? this.translate.instant(sat.labelKey) : this.translate.instant('WORLD_GLOBE.ISS_TICKER_LABEL');
  }

  /** Satellite (ou ISS) pour le bouton viseur : sélection globe, sinon dernier choix mémorisé. */
  astroViseurSatId(): string {
    const live = (this.tickerFocusSatId || '').trim().toLowerCase();
    if (live && findSatelliteById(live)) {
      return live;
    }
    const last = (this.lastAstroViseurSatId || '').trim().toLowerCase();
    if (last && findSatelliteById(last)) {
      return last;
    }
    return 'iss';
  }

  astroViseurSatName(): string {
    const sat = findSatelliteById(this.astroViseurSatId());
    return this.translate.instant(sat?.labelKey ?? 'ASTRO_COMPASS.BODY_ISS');
  }

  private rememberAstroViseurSat(satId: string): void {
    const id = findSatelliteById((satId || '').trim().toLowerCase())?.id;
    if (!id) {
      return;
    }
    this.lastAstroViseurSatId = id;
    try {
      localStorage.setItem(GLOBE_ASTRO_VISEUR_SAT_KEY, id);
    } catch {
      /* ignore */
    }
  }

  private readLastAstroViseurSatId(): string {
    try {
      const stored = localStorage.getItem(GLOBE_ASTRO_VISEUR_SAT_KEY);
      const fromGlobe = findSatelliteById((stored || '').trim().toLowerCase())?.id;
      if (fromGlobe) {
        return fromGlobe;
      }
    } catch {
      /* ignore */
    }
    return this.readLastAstroCompassSatelliteId() ?? 'iss';
  }

  private readLastAstroCompassSatelliteId(): string | null {
    try {
      const user = this.keycloakService.getPreferredUsername();
      const keys = user
        ? [`${ASTRO_LAST_TARGET_KEY}:${user}`, ASTRO_LAST_TARGET_KEY]
        : [ASTRO_LAST_TARGET_KEY];
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (!raw) {
          continue;
        }
        const data = JSON.parse(raw) as { kind?: string; id?: string };
        if (data?.kind !== 'iss' || !data.id) {
          continue;
        }
        const id = findSatelliteById(data.id.trim().toLowerCase())?.id;
        if (id) {
          return id;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  tickerLat(): number | null {
    return this.tickerFocusSatId ? this.satTickerLat : this.globeIssLat;
  }

  tickerLon(): number | null {
    return this.tickerFocusSatId ? this.satTickerLon : this.globeIssLon;
  }

  tickerAltKm(): number | null {
    return this.tickerFocusSatId ? this.satTickerAltKm : this.globeIssAltKm;
  }

  tickerSpeedKmh(): number | null {
    return this.tickerFocusSatId ? this.satTickerSpeedKmh : this.issGroundSpeedKmh;
  }

  tickerStepKm(): number | null {
    return this.tickerFocusSatId ? this.satTickerStepKm : this.issLastStepGroundKm;
  }

  tickerOverPlaceLabel(): string | null {
    return this.tickerFocusSatId ? this.satTickerOverPlaceLabel : this.issOverPlaceLabel;
  }

  tickerOverFlagEmoji(): string {
    const code = this.tickerFocusSatId ? this.satTickerOverPlaceCountryCode : this.issOverPlaceCountryCode;
    return this.flagEmojiFromCountryCode(code);
  }

  /**
   * Fige les bindings du bandeau pour le prochain CD. Les positions live (ISS / SGP4) peuvent
   * bouger à chaque frame ou pendant un await HTTP ; le template ne doit lire que cette copie.
   */
  private pushTickerUiSnapshot(): void {
    const sat = this.tickerFocusSat();
    const name = this.tickerLabelName();
    this.tickerUiHasLiveData = this.issTickerHasLiveData();
    this.tickerUiLat = this.tickerLat();
    this.tickerUiLon = this.tickerLon();
    this.tickerUiAltKm = this.tickerAltKm();
    this.tickerUiSpeedKmh = this.tickerSpeedKmh();
    this.tickerUiStepKm = this.tickerStepKm();
    this.tickerUiOverPlaceLabel = this.tickerOverPlaceLabel();
    this.tickerUiOverFlagEmoji = this.tickerOverFlagEmoji();
    this.tickerUiLabelName = name;
    this.tickerUiColor = sat?.color ?? null;
    this.tickerUiIconClass = sat?.iconClass ?? 'fa-globe';
    this.tickerUiAriaLabel = this.tickerFocusSatId
      ? this.translate.instant('WORLD_GLOBE.SATELLITE_TICKER_ARIA', { name })
      : this.translate.instant('WORLD_GLOBE.ISS_TICKER_ARIA');
    this.tickerUiLoadingLabel = this.tickerFocusSatId
      ? this.translate.instant('WORLD_GLOBE.SATELLITE_TICKER_LOADING', { name })
      : this.translate.instant('WORLD_GLOBE.ISS_TICKER_LOADING');
  }

  onSelectSatelliteForTicker(satId: string | null, persistViseur = false): void {
    const next = satId && this.globeSatelliteOptions.some((s) => s.id === satId) ? satId : null;
    if (next && this.satelliteOverlayEnabled[next] === false) {
      this.onGlobeSatelliteToggle(next, true);
    }
    if (!this.issTickerEnabled) {
      this.issTickerEnabled = true;
      this.startIssPolling();
      this.schedulePersistIssGlobalPrefs();
    }
    if (this.tickerFocusSatId === next) {
      if (next) {
        this.refreshTickerFromSatellite(next);
      }
      if (persistViseur) {
        this.rememberAstroViseurSat(next ?? 'iss');
      }
      this.pushTickerUiSnapshot();
      this.scheduleWorldGlobeCdr();
      return;
    }
    this.tickerFocusSatId = next;
    if (persistViseur) {
      this.rememberAstroViseurSat(next ?? 'iss');
    }
    this.issOverLookupLat = null;
    this.issOverLookupLon = null;
    this.issOverLookupAtMs = 0;
    if (next) {
      this.satTickerSampleLat = null;
      this.satTickerSampleLon = null;
      this.satTickerSampleAtMs = 0;
      this.satTickerStepKm = null;
      this.satTickerOverPlaceLabel = null;
      this.satTickerOverPlaceCountryCode = null;
      this.refreshTickerFromSatellite(next);
    } else if (this.globeIssLat != null && this.globeIssLon != null) {
      this.maybeUpdateIssOverPlace(this.globeIssLat, this.globeIssLon);
    }
    this.pushTickerUiSnapshot();
    this.scheduleWorldGlobeCdr();
  }

  private issPositionFeedActive(): boolean {
    return this.issOverlayEnabled || this.issTickerEnabled;
  }

  private clearIssPositionFeedState(): void {
    this.issGroundSpeedKmh = null;
    this.issLastStepGroundKm = null;
    this.issTrackDeg = null;
    this.globeIssAltKm = null;
    this.globeIssVisibilityRadiusKm = null;
    this.issSpeedSampleLat = null;
    this.issSpeedSampleLon = null;
    this.issOverPlaceLabel = null;
    this.issOverPlaceCountryCode = null;
    this.issOverLookupLat = null;
    this.issOverLookupLon = null;
    this.issOverLookupAtMs = 0;
    this.issSpeedSampleEpochMs = 0;
    this.scheduleWorldGlobeCdr(() => {
      this.globeIssLat = null;
      this.globeIssLon = null;
      this.issSecondsUntilNextRefresh = 0;
    });
  }

  /** Suit le sous-point ISS vers le centre de la vue (voir {@link issKeepEarthCentered}). */
  onIssKeepEarthCenteredToggle(): void {
    if (this.issKeepEarthCentered) {
      this.issCameraCenterSmoothPrevMs = 0;
      this.issGlobeFreeOrbit = false;
    } else {
      this.issGlobeFreeOrbit = false;
    }
    if (!this.issKeepEarthCentered) {
      this.issCameraCenterSmoothPrevMs = 0;
    }
    if (this.isIssEarthCenteredTrackingActive() && this.globeCameraAnimFrameId == null) {
      this.applyIssEarthCenteredCameraIfNeeded();
    }
    this.cdr.markForCheck();
    this.schedulePersistIssGlobalPrefs();
  }

  /** Lieu fixé par géocodage (ville / pays) : le suivi caméra ISS est suspendu. */
  isGlobeFocusedOnPlace(): boolean {
    return this.globeGeocodeMarkerLat != null && this.globeGeocodeMarkerLon != null;
  }

  issKeepEarthCenteredControlTitle(): string {
    if (this.isGlobeFocusedOnPlace()) {
      return this.translate.instant('WORLD_GLOBE.ISS_KEEP_EARTH_CENTERED_DISABLED_PLACE');
    }
    return this.translate.instant('WORLD_GLOBE.ISS_KEEP_EARTH_CENTERED_HINT');
  }

  private disableIssKeepEarthCenteredForPlaceFocus(): void {
    if (!this.issKeepEarthCentered) {
      return;
    }
    this.issKeepEarthCentered = false;
    this.issCameraCenterSmoothPrevMs = 0;
    this.issGlobeFreeOrbit = false;
    this.cdr.markForCheck();
  }

  private isIssEarthCenteredTrackingActive(): boolean {
    return (
      this.issKeepEarthCentered &&
      !this.isGlobeFocusedOnPlace() &&
      this.issOverlayEnabled &&
      this.globeSurfaceReady &&
      this.globeIssLat != null &&
      this.globeIssLon != null
    );
  }

  /** Recentre progressivement la caméra sur le sous-point ISS (conserve le zoom). */
  private applyIssEarthCenteredCameraIfNeeded(): void {
    if (!this.isIssEarthCenteredTrackingActive() || this.globeCameraAnimFrameId != null) {
      return;
    }
    const camera = this.camera;
    const controls = this.controls;
    if (!camera || !controls || this.globeIssLat == null || this.globeIssLon == null) {
      return;
    }
    const dist = THREE.MathUtils.clamp(
      camera.position.distanceTo(controls.target),
      controls.minDistance,
      controls.maxDistance
    );
    const endPos = this.computeCameraPositionForLatLon(this.globeIssLat, this.globeIssLon, dist, 0);
    if (!endPos) {
      return;
    }

    const now = performance.now();
    let dtSec =
      this.issCameraCenterSmoothPrevMs > 0 ? (now - this.issCameraCenterSmoothPrevMs) / 1000 : 1 / 60;
    dtSec = THREE.MathUtils.clamp(dtSec, 1 / 240, 0.08);
    this.issCameraCenterSmoothPrevMs = now;

    const curLenSq = camera.position.lengthSq();
    if (curLenSq < 1e-12) {
      camera.position.copy(endPos);
    } else {
      this.issCameraCenterDirA.copy(camera.position).multiplyScalar(1 / Math.sqrt(curLenSq));
      this.issCameraCenterDirB.copy(endPos).normalize();
      const dot = THREE.MathUtils.clamp(this.issCameraCenterDirA.dot(this.issCameraCenterDirB), -1, 1);
      if (dot > 1 - 1e-6) {
        camera.position.copy(endPos);
      } else {
        const angularErrorRad = Math.acos(dot);
        const errorBoost = THREE.MathUtils.clamp(
          angularErrorRad / GLOBE_ISS_CAMERA_CENTER_ERROR_BOOST_REF_RAD,
          1,
          5
        );
        const blend = 1 - Math.pow(0.5, dtSec / (GLOBE_ISS_CAMERA_CENTER_HALF_LIFE_SEC / errorBoost));
        WorldGlobeComponent.slerpUnitVectors(
          this.issCameraCenterDirA,
          this.issCameraCenterDirB,
          blend,
          this.issCameraCenterDirOut
        );
        camera.position.copy(this.issCameraCenterDirOut.multiplyScalar(dist));
      }
    }

    controls.target.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    controls.update();
  }

  /**
   * Position ISS utilisée par la boucle Three.js : mise à jour immédiate (pas via CDR différé),
   * pour que le recentrage caméra suive chaque déplacement sans décalage sur le marqueur.
   */
  private commitGlobeIssPosition(lat: number, lon: number): void {
    const moved =
      this.globeIssLat == null ||
      this.globeIssLon == null ||
      Math.abs(this.globeIssLat - lat) > 1e-9 ||
      Math.abs(this.globeIssLon - lon) > 1e-9;
    this.globeIssLat = lat;
    this.globeIssLon = lon;
    if (!moved) {
      return;
    }
    this.issCameraCenterSmoothPrevMs = 0;
    if (
      this.isIssEarthCenteredTrackingActive() &&
      !this.issGlobeFreeOrbit &&
      this.globeCameraAnimFrameId == null
    ) {
      this.applyIssEarthCenteredCameraIfNeeded();
    }
  }

  private isFlightEarthCenteredTrackingActive(): boolean {
    return (
      this.flightTrackingActive &&
      !this.isGlobeFocusedOnPlace() &&
      this.globeSurfaceReady &&
      this.flightLat != null &&
      this.flightLon != null
    );
  }

  /** Smoothly recenters the camera on the tracked aircraft (keeps zoom). */
  private applyFlightEarthCenteredCameraIfNeeded(): void {
    if (!this.isFlightEarthCenteredTrackingActive() || this.globeCameraAnimFrameId != null) {
      return;
    }
    const camera = this.camera;
    const controls = this.controls;
    if (!camera || !controls || this.flightLat == null || this.flightLon == null) {
      return;
    }
    const dist = THREE.MathUtils.clamp(
      camera.position.distanceTo(controls.target),
      controls.minDistance,
      controls.maxDistance
    );
    const endPos = this.computeCameraPositionForLatLon(this.flightLat, this.flightLon, dist, 0);
    if (!endPos) {
      return;
    }

    const now = performance.now();
    let dtSec =
      this.flightCameraCenterSmoothPrevMs > 0
        ? (now - this.flightCameraCenterSmoothPrevMs) / 1000
        : 1 / 60;
    dtSec = THREE.MathUtils.clamp(dtSec, 1 / 240, 0.08);
    this.flightCameraCenterSmoothPrevMs = now;

    const blend = 1 - Math.pow(0.5, dtSec / GLOBE_FLIGHT_CAMERA_CENTER_HALF_LIFE_SEC);

    const curLenSq = camera.position.lengthSq();
    if (curLenSq < 1e-12) {
      camera.position.copy(endPos);
    } else {
      this.issCameraCenterDirA.copy(camera.position).multiplyScalar(1 / Math.sqrt(curLenSq));
      this.issCameraCenterDirB.copy(endPos).normalize();
      const dot = THREE.MathUtils.clamp(this.issCameraCenterDirA.dot(this.issCameraCenterDirB), -1, 1);
      if (dot > 1 - 1e-6) {
        camera.position.copy(endPos);
      } else {
        WorldGlobeComponent.slerpUnitVectors(
          this.issCameraCenterDirA,
          this.issCameraCenterDirB,
          blend,
          this.issCameraCenterDirOut
        );
        camera.position.copy(this.issCameraCenterDirOut.multiplyScalar(dist));
      }
    }

    controls.target.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    controls.update();
  }

  onIssPollIntervalCommitted(): void {
    this.issPollIntervalSec = this.clampIssPollIntervalSec(
      typeof this.issPollIntervalSec === 'number' ? this.issPollIntervalSec : GLOBE_ISS_POLL_DEFAULT_SEC
    );
    if (this.issOverlayEnabled && this.globeSurfaceReady) {
      queueMicrotask(() => this.startIssPolling());
    }
    queueMicrotask(() => this.cdr.markForCheck());
    this.schedulePersistIssGlobalPrefs();
  }

  /** Position ISS tout de suite ; le prochain tirage automatique est recalculé à partir de maintenant. */
  onIssRefreshNowClick(): void {
    if (!this.issOverlayEnabled || !this.globeSurfaceReady || this.issManualRefreshInFlight) {
      return;
    }
    this.issManualRefreshInFlight = true;
    this.cdr.markForCheck();
    this.scheduleIssRefreshChain(this.issPollIntervalMs());
    void this.refreshIssNow().finally(() => {
      this.issManualRefreshInFlight = false;
      this.cdr.markForCheck();
    });
  }

  private static readonly ISS_PIP_SIZE_STORAGE_KEY = {
    standard: 'pat.world-globe.iss-pip.size.standard',
    hd: 'pat.world-globe.iss-pip.size.hd'
  } as const;

  private static readonly ISS_PIP_MOBILE_SIZE_STORAGE_KEY = {
    standard: 'pat.world-globe.iss-pip.size.mobile.standard',
    hd: 'pat.world-globe.iss-pip.size.mobile.hd'
  } as const;

  private static readonly ISS_PIP_SIZE_MIN = { w: 160, h: 120 };
  /** Hors plein écran : largeur des mini-fenêtres à l’ouverture (% de la fenêtre navigateur). */
  private static readonly ISS_PIP_WINDOWED_WIDTH_RATIO = 0.25;
  private static readonly ISS_PIP_WINDOWED_BAR_PX = 36;
  private static readonly ISS_PIP_SIZE_MAX_RATIO = { w: 0.96, h: 0.85 };
  /** Plafond fixe à la restauration (évite de rétrécir quand le panneau options se masque). */
  private static readonly ISS_PIP_SIZE_ABSOLUTE_MAX = { w: 1400, h: 900 };
  private static readonly ISS_PIP_STACK_GAP_PX = 6;
  /** Hors plein écran : marge entre le globe décalé à gauche et les flux ISS flottants à droite. */
  private static readonly ISS_NON_FS_GLOBE_RESERVE_GAP_PX = 16;
  /** Dernière largeur réservée à droite pour les flux ISS (px ; -1 = non initialisé). */
  private issNonFsGlobeReservePx = -1;

  /** Hors plein écran : aucune fenêtre ISS ; en plein écran : ouvrir les deux flux automatiquement. */
  private applyIssEmbedPanelsOnPresentationChange(wasPresentation: boolean): void {
    const isPresentation = this.globePresentationMode;
    if (isPresentation && !wasPresentation) {
      this.showOptionsPanel = false;
      this.enableBothIssEmbedPanelsForFullscreen();
      return;
    }
    if (!isPresentation && wasPresentation) {
      this.disableAllIssEmbedPanels();
      return;
    }
    if (!isPresentation) {
      this.endIssFsSplitResizeDrag();
      this.endIssFsPipStackResizeDrag();
      this.issFsSplitIssWidthManual = false;
    }
  }

  private enableBothIssEmbedPanelsForFullscreen(): void {
    this.issLiveEmbedEnabled = true;
    this.issLiveHdEmbedEnabled = true;
    this.issFsSplitIssWidthManual = false;
    if (!this.issFsPipStackTopManual) {
      this.applyIssFsPipStackDefaultSplit();
    }
    this.applyIssFsSplitDefaultSplit();
    queueMicrotask(() => this.refreshIssLivePiPPanelsLayout());
    this.cdr.markForCheck();
  }

  private disableAllIssEmbedPanels(): void {
    if (this.issLivePiPFullscreen) {
      void this.toggleIssLivePiPFullscreen();
    }
    if (this.issLiveHdPiPFullscreen) {
      void this.toggleIssLiveHdPiPFullscreen();
    }
    this.issLiveEmbedEnabled = false;
    this.issLiveHdEmbedEnabled = false;
    this.endIssFsSplitResizeDrag();
    this.endIssFsPipStackResizeDrag();
    this.issFsSplitIssWidthManual = false;
    queueMicrotask(() => this.refreshIssLivePiPPanelsLayout());
    this.cdr.markForCheck();
  }

  onIssLiveEmbedPanelToggle(): void {
    queueMicrotask(() => {
      if (this.issFsSplitLayout && !this.issFsSplitIssWidthManual) {
        this.applyIssFsSplitDefaultSplit();
      }
      if (this.issFsPipStackSplitActive && !this.issFsPipStackTopManual) {
        this.applyIssFsPipStackDefaultSplit();
      }
      const applyWindowedDefault =
        !this.globePresentationMode && !this.isIssMobileStackLayout() && this.issLiveEmbedEnabled;
      this.refreshIssLivePiPPanelsLayout();
      if (applyWindowedDefault) {
        this.applyIssPiPDefaultWindowedSize(this.issLivePiP?.nativeElement, 'standard');
        this.syncIssStandardPiPSizeWithHd();
        this.syncIssLivePiPStackOffset();
      }
    });
    this.schedulePersistIssGlobalPrefs();
  }

  onIssLiveHdEmbedPanelToggle(): void {
    queueMicrotask(() => {
      if (this.issFsSplitLayout && !this.issFsSplitIssWidthManual) {
        this.applyIssFsSplitDefaultSplit();
      }
      if (this.issFsPipStackSplitActive && !this.issFsPipStackTopManual) {
        this.applyIssFsPipStackDefaultSplit();
      }
      const applyWindowedDefault =
        !this.globePresentationMode && !this.isIssMobileStackLayout() && this.issLiveHdEmbedEnabled;
      this.refreshIssLivePiPPanelsLayout();
      if (applyWindowedDefault) {
        this.applyIssPiPDefaultWindowedSize(this.issLiveHdPiP?.nativeElement, 'hd');
        this.syncIssStandardPiPSizeWithHd();
        this.syncIssLivePiPStackOffset();
      }
    });
    this.schedulePersistIssGlobalPrefs();
  }

  /** Ferme la mini-fenêtre ISS (désactive le flux + quitte le plein écran vidéo si actif). */
  closeIssLivePiP(variant: 'standard' | 'hd'): void {
    this.endIssFsPipStackResizeDrag();
    if (variant === 'standard') {
      if (this.issLivePiPFullscreen) {
        void this.toggleIssLivePiPFullscreen();
      }
      if (!this.issLiveEmbedEnabled) {
        return;
      }
      this.issLiveEmbedEnabled = false;
      this.onIssLiveEmbedPanelToggle();
      return;
    }
    if (this.issLiveHdPiPFullscreen) {
      void this.toggleIssLiveHdPiPFullscreen();
    }
    if (!this.issLiveHdEmbedEnabled) {
      return;
    }
    this.issLiveHdEmbedEnabled = false;
    this.onIssLiveHdEmbedPanelToggle();
  }

  private disposeIssLivePiPResizeObservers(): void {
    this.endIssPiPResizeDrag();
    this.issLivePiPResizeObs?.disconnect();
    this.issLivePiPResizeObs = undefined;
    if (this.issLivePiPResizeSaveTimer != null) {
      clearTimeout(this.issLivePiPResizeSaveTimer);
      this.issLivePiPResizeSaveTimer = null;
    }
  }

  private isIssMobileStackLayout(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 767.98px)').matches;
  }

  /** Poignée verticale plein écran : largeur colonne flux ISS vs globe (clic gauche maintenu). */
  onIssFsSplitResizeStart(event: PointerEvent): void {
    if (!this.issFsSplitLayout || event.button !== 0 || this.isIssMobileStackLayout()) {
      return;
    }
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.issFsSplitIssWidthManual = true;
    this.issFsSplitIssWidthPx = this.getEffectiveIssFsSplitIssWidthPx();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* navigateurs anciens */
    }
    this.issFsSplitResizeDrag = {
      startX: event.clientX,
      startWidth: this.issFsSplitIssWidthPx,
      handle,
      pointerId: event.pointerId
    };
    this.issFsSplitDragging = true;
    document.addEventListener('pointermove', this.issFsSplitResizeMoveHandler, { capture: true });
    document.addEventListener('pointerup', this.issFsSplitResizeUpHandler, { capture: true });
    document.addEventListener('pointercancel', this.issFsSplitResizeUpHandler, { capture: true });
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  private onIssFsSplitResizeMove(event: PointerEvent): void {
    const drag = this.issFsSplitResizeDrag;
    if (!drag) {
      return;
    }
    if ((event.buttons & 1) === 0) {
      this.endIssFsSplitResizeDrag(event);
      return;
    }
    event.preventDefault();
    // Poignée entre globe (gauche) et ISS (droite) : tirer à droite rétrécit la colonne flux.
    const next = this.clampIssFsSplitIssWidth(drag.startWidth - (event.clientX - drag.startX));
    if (next === this.issFsSplitIssWidthPx) {
      return;
    }
    this.issFsSplitIssWidthPx = next;
    this.resizeRendererToHost();
    this.cdr.markForCheck();
  }

  private endIssFsSplitResizeDrag(event?: PointerEvent): void {
    const drag = this.issFsSplitResizeDrag;
    if (!drag) {
      return;
    }
    try {
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* ignore */
    }
    this.issFsSplitResizeDrag = null;
    this.issFsSplitDragging = false;
    document.removeEventListener('pointermove', this.issFsSplitResizeMoveHandler, { capture: true });
    document.removeEventListener('pointerup', this.issFsSplitResizeUpHandler, { capture: true });
    document.removeEventListener('pointercancel', this.issFsSplitResizeUpHandler, { capture: true });
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (event?.type === 'pointerup' || event?.type === 'pointercancel') {
      this.saveIssFsSplitWidthToStorage();
    }
    this.resizeRendererToHost();
    this.refreshIssLivePiPPanelsLayout();
    this.cdr.markForCheck();
  }

  /** Largeur colonne ISS : 40 % de la largeur du stage (plein écran scindé). */
  private getCenterIssFsSplitIssWidthPx(stageWidth?: number): number {
    const stageW = stageWidth ?? this.getGlobeStageElement()?.clientWidth ?? 0;
    if (stageW <= 0) {
      return Math.max(WorldGlobeComponent.ISS_FS_SPLIT_ISS_MIN_PX, this.issFsSplitIssWidthPx);
    }
    const target = stageW * WorldGlobeComponent.ISS_FS_SPLIT_ISS_WIDTH_RATIO;
    return this.clampIssFsSplitIssWidth(target, stageW);
  }

  /** Colonne flux ISS à 40 % (sauf si l’utilisateur a déplacé le séparateur). */
  private syncIssFsSplitIssColumnWidth(): void {
    if (!this.issFsSplitLayout || this.issFsSplitIssWidthManual) {
      return;
    }
    const next = this.getCenterIssFsSplitIssWidthPx();
    if (next !== this.issFsSplitIssWidthPx) {
      this.issFsSplitIssWidthPx = next;
    }
  }

  /** À l’entrée en plein écran scindé : colonne ISS à 40 % de la largeur. */
  private applyIssFsSplitDefaultSplit(): void {
    this.issFsSplitIssWidthManual = false;
    const apply = () => {
      if (!this.issFsSplitLayout) {
        return;
      }
      const next = this.getCenterIssFsSplitIssWidthPx();
      if (next > 0) {
        this.issFsSplitIssWidthPx = next;
        this.cdr.markForCheck();
        this.resizeRendererToHost();
      }
    };
    apply();
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  private clampIssFsSplitIssWidth(px: number, stageWidth?: number): number {
    const stageW = stageWidth ?? this.getGlobeStageElement()?.clientWidth ?? 0;
    if (stageW <= 0) {
      return Math.max(WorldGlobeComponent.ISS_FS_SPLIT_ISS_MIN_PX, Math.round(px));
    }
    const maxIss =
      stageW -
      WorldGlobeComponent.ISS_FS_SPLIT_GLOBE_MIN_PX -
      WorldGlobeComponent.ISS_FS_SPLIT_HANDLE_PX;
    return Math.round(
      Math.min(
        Math.max(WorldGlobeComponent.ISS_FS_SPLIT_ISS_MIN_PX, maxIss),
        Math.max(WorldGlobeComponent.ISS_FS_SPLIT_ISS_MIN_PX, px)
      )
    );
  }

  private saveIssFsSplitWidthToStorage(): void {
    if (!this.issFsSplitIssWidthManual) {
      return;
    }
    try {
      localStorage.setItem(
        WorldGlobeComponent.ISS_FS_SPLIT_WIDTH_STORAGE_KEY,
        JSON.stringify(this.issFsSplitIssWidthPx)
      );
    } catch {
      /* quota / private mode */
    }
  }

  /** Poignée horizontale entre flux standard (haut) et HD (bas) en colonne ISS plein écran. */
  onIssFsPipStackResizeStart(event: PointerEvent): void {
    if (!this.issFsPipStackSplitActive || event.button !== 0) {
      return;
    }
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.issFsPipStackTopManual = true;
    this.issFsPipStackTopPx = this.getEffectiveIssFsPipStackTopPx();
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* navigateurs anciens */
    }
    this.issFsPipStackResizeDrag = {
      startY: event.clientY,
      startTop: this.issFsPipStackTopPx,
      handle,
      pointerId: event.pointerId
    };
    this.issFsPipStackDragging = true;
    document.addEventListener('pointermove', this.issFsPipStackResizeMoveHandler, { capture: true });
    document.addEventListener('pointerup', this.issFsPipStackResizeUpHandler, { capture: true });
    document.addEventListener('pointercancel', this.issFsPipStackResizeUpHandler, { capture: true });
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  }

  private onIssFsPipStackResizeMove(event: PointerEvent): void {
    const drag = this.issFsPipStackResizeDrag;
    if (!drag) {
      return;
    }
    if ((event.buttons & 1) === 0) {
      this.endIssFsPipStackResizeDrag(event);
      return;
    }
    event.preventDefault();
    const next = this.clampIssFsPipStackTop(drag.startTop + (event.clientY - drag.startY));
    if (next === this.issFsPipStackTopPx) {
      return;
    }
    this.issFsPipStackTopPx = next;
    this.cdr.markForCheck();
  }

  private endIssFsPipStackResizeDrag(event?: PointerEvent): void {
    const drag = this.issFsPipStackResizeDrag;
    if (!drag) {
      return;
    }
    try {
      if (drag.handle.hasPointerCapture(drag.pointerId)) {
        drag.handle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* ignore */
    }
    this.issFsPipStackResizeDrag = null;
    this.issFsPipStackDragging = false;
    document.removeEventListener('pointermove', this.issFsPipStackResizeMoveHandler, { capture: true });
    document.removeEventListener('pointerup', this.issFsPipStackResizeUpHandler, { capture: true });
    document.removeEventListener('pointercancel', this.issFsPipStackResizeUpHandler, { capture: true });
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (event?.type === 'pointerup' || event?.type === 'pointercancel') {
      this.saveIssFsPipStackTopToStorage();
    }
    this.refreshIssLivePiPPanelsLayout();
    this.cdr.markForCheck();
  }

  private getIssFsPipDockElement(): HTMLElement | null {
    return this.getGlobeStageElement()?.querySelector<HTMLElement>('.wg-iss-pip-dock--fs-split') ?? null;
  }

  private getEffectiveIssFsPipStackTopPx(): number {
    if (this.issFsPipStackTopManual) {
      return this.issFsPipStackTopPx;
    }
    return this.getCenterIssFsPipStackTopPx();
  }

  private getCenterIssFsPipStackTopPx(dockHeight?: number): number {
    const dockH = dockHeight ?? this.getIssFsPipDockElement()?.clientHeight ?? 0;
    if (dockH <= 0) {
      return Math.max(WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_MIN_PX, this.issFsPipStackTopPx);
    }
    const available = dockH - WorldGlobeComponent.ISS_FS_PIP_STACK_HANDLE_PX;
    const target = available * WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_RATIO;
    return this.clampIssFsPipStackTop(target, dockH);
  }

  private syncIssFsPipStackTop(): void {
    if (!this.issFsPipStackSplitActive || this.issFsPipStackTopManual) {
      return;
    }
    const next = this.getCenterIssFsPipStackTopPx();
    if (next !== this.issFsPipStackTopPx) {
      this.issFsPipStackTopPx = next;
    }
  }

  private applyIssFsPipStackDefaultSplit(): void {
    this.issFsPipStackTopManual = false;
    const apply = () => {
      if (!this.issFsPipStackSplitActive) {
        return;
      }
      const next = this.getCenterIssFsPipStackTopPx();
      if (next > 0) {
        this.issFsPipStackTopPx = next;
        this.cdr.markForCheck();
      }
    };
    apply();
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }

  private clampIssFsPipStackTop(px: number, dockHeight?: number): number {
    const dockH = dockHeight ?? this.getIssFsPipDockElement()?.clientHeight ?? 0;
    if (dockH <= 0) {
      return Math.max(WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_MIN_PX, Math.round(px));
    }
    const available = dockH - WorldGlobeComponent.ISS_FS_PIP_STACK_HANDLE_PX;
    const maxTop = available - WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_MIN_PX;
    return Math.round(
      Math.min(
        Math.max(WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_MIN_PX, maxTop),
        Math.max(WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_MIN_PX, px)
      )
    );
  }

  private loadIssFsPipStackTopFromStorage(): void {
    try {
      const raw = localStorage.getItem(WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
        this.issFsPipStackTopPx = Math.round(parsed);
        this.issFsPipStackTopManual = true;
      }
    } catch {
      /* ignore */
    }
  }

  private saveIssFsPipStackTopToStorage(): void {
    if (!this.issFsPipStackTopManual) {
      return;
    }
    try {
      localStorage.setItem(
        WorldGlobeComponent.ISS_FS_PIP_STACK_TOP_STORAGE_KEY,
        JSON.stringify(this.issFsPipStackTopPx)
      );
    } catch {
      /* quota / private mode */
    }
  }

  /** Poignée en haut à gauche : la fenêtre reste ancrée en bas à droite (desktop) ; redimensionnable aussi en pile mobile. */
  onIssPiPResizeStart(event: PointerEvent, variant: keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY): void {
    if (this.issFsSplitLayout && !this.isIssMobileStackLayout()) {
      return;
    }
    if (variant === 'standard' && this.issLivePiPFullscreen) {
      return;
    }
    if (variant === 'hd' && this.issLiveHdPiPFullscreen) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) {
      return;
    }
    const panel =
      variant === 'standard' ? this.issLivePiP?.nativeElement : this.issLiveHdPiP?.nativeElement;
    if (!panel) {
      return;
    }
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* navigateurs anciens */
    }
    this.issPiPResizeDrag = {
      panel,
      variant,
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startW: panel.offsetWidth,
      startH: panel.offsetHeight
    };
    panel.classList.add('wg-iss-live-pip--resizing');
    document.addEventListener('pointermove', this.issPiPResizeMoveHandler, { capture: true });
    document.addEventListener('pointerup', this.issPiPResizeUpHandler, { capture: true });
    document.addEventListener('pointercancel', this.issPiPResizeUpHandler, { capture: true });
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nwse-resize';
  }

  private onIssPiPResizeMove(event: PointerEvent): void {
    const drag = this.issPiPResizeDrag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    event.preventDefault();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const { w, h } = this.clampIssPiPSize(drag.startW - dx, drag.startH - dy);
    this.applyIssPiPPanelSize(drag.panel, w, h);
    this.syncIssLivePiPStackOffset();
  }

  private endIssPiPResizeDrag(event?: PointerEvent): void {
    const drag = this.issPiPResizeDrag;
    if (!drag) {
      return;
    }
    if (event != null && event.pointerId !== drag.pointerId) {
      return;
    }
    const { panel, variant, handle, pointerId } = drag;
    try {
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
    this.issPiPResizeDrag = null;
    document.removeEventListener('pointermove', this.issPiPResizeMoveHandler, { capture: true });
    document.removeEventListener('pointerup', this.issPiPResizeUpHandler, { capture: true });
    document.removeEventListener('pointercancel', this.issPiPResizeUpHandler, { capture: true });
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    panel.classList.remove('wg-iss-live-pip--resizing');
    this.saveIssPiPSize(panel, variant);
    this.syncIssLivePiPStackOffset();
  }

  private clearIssPiPPanelInlineSize(panel: HTMLElement | undefined): void {
    if (!panel) {
      return;
    }
    panel.classList.remove('wg-iss-live-pip--user-sized');
    panel.style.removeProperty('width');
    panel.style.removeProperty('max-width');
    panel.style.removeProperty('height');
    panel.style.removeProperty('max-height');
  }

  private refreshIssLivePiPPanelsLayout(): void {
    if (this.issFsSplitLayout && !this.isIssMobileStackLayout()) {
      this.clearIssPiPPanelInlineSize(this.issLivePiP?.nativeElement);
      this.clearIssPiPPanelInlineSize(this.issLiveHdPiP?.nativeElement);
      this.syncIssFsSplitIssColumnWidth();
      this.syncIssFsPipStackTop();
    } else if (this.isIssMobileStackLayout()) {
      this.syncIssFsPipStackTop();
      if (this.issFsSplitLayout) {
        this.clearIssPiPPanelInlineSize(this.issLivePiP?.nativeElement);
        this.clearIssPiPPanelInlineSize(this.issLiveHdPiP?.nativeElement);
      } else {
        this.applyIssPiPStoredSize(this.issLiveHdPiP?.nativeElement, 'hd');
        this.applyIssPiPStoredSize(this.issLivePiP?.nativeElement, 'standard');
      }
    } else {
      this.applyIssPiPStoredSize(this.issLiveHdPiP?.nativeElement, 'hd');
      this.applyIssPiPStoredSize(this.issLivePiP?.nativeElement, 'standard');
    }
    this.syncIssStandardPiPSizeWithHd();
    this.syncIssLivePiPStackOffset();
    this.setupIssLivePiPResizeObservers();
    this.updateNonFsGlobeShift();
    requestAnimationFrame(() => this.updateNonFsGlobeShift());
    if (this.issLiveEmbedEnabled) {
      requestAnimationFrame(() => {
        this.syncIssStandardPiPSizeWithHd();
        this.syncIssLivePiPStackOffset();
      });
    }
  }

  /**
   * Hors plein écran (et hors empilement mobile) : réserve à droite la largeur réelle des
   * flux ISS flottants en posant `--wg-iss-pip-reserve` sur la scène, ce qui rétrécit le
   * canvas du globe et recentre donc le globe vers la gauche (il n'est plus couvert par les vidéos).
   */
  private updateNonFsGlobeShift(): void {
    const stage = this.getGlobeStageElement();
    if (!stage) {
      return;
    }
    let reserve = 0;
    const floatingPiPVisible =
      !this.fullscreen &&
      !this.issFsSplitLayout &&
      !this.isIssMobileStackLayout() &&
      !this.issLivePiPFullscreen &&
      !this.issLiveHdPiPFullscreen &&
      (this.issLiveEmbedEnabled || this.issLiveHdEmbedEnabled);
    if (floatingPiPVisible) {
      let maxWidth = 0;
      const standard = this.issLivePiP?.nativeElement;
      const hd = this.issLiveHdPiP?.nativeElement;
      if (this.issLiveEmbedEnabled && standard) {
        maxWidth = Math.max(maxWidth, standard.offsetWidth);
      }
      if (this.issLiveHdEmbedEnabled && hd) {
        maxWidth = Math.max(maxWidth, hd.offsetWidth);
      }
      if (maxWidth > 0) {
        reserve = Math.round(maxWidth + WorldGlobeComponent.ISS_NON_FS_GLOBE_RESERVE_GAP_PX);
      }
    }
    if (reserve === this.issNonFsGlobeReservePx) {
      return;
    }
    this.issNonFsGlobeReservePx = reserve;
    if (reserve > 0) {
      stage.style.setProperty('--wg-iss-pip-reserve', `${reserve}px`);
    } else {
      stage.style.removeProperty('--wg-iss-pip-reserve');
    }
    requestAnimationFrame(() => this.resizeRendererToHost());
  }

  private setupIssLivePiPResizeObservers(): void {
    this.disposeIssLivePiPResizeObservers();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const panels: HTMLElement[] = [];
    const standard = this.issLivePiP?.nativeElement;
    const hd = this.issLiveHdPiP?.nativeElement;
    if (this.issLiveEmbedEnabled && standard) {
      panels.push(standard);
    }
    if (this.issLiveHdEmbedEnabled && hd) {
      panels.push(hd);
    }
    if (!panels.length) {
      return;
    }
    this.issLivePiPResizeObs = new ResizeObserver(() => {
      this.syncIssLivePiPStackOffset();
      this.updateNonFsGlobeShift();
      this.scheduleIssPiPSizePersist();
    });
    for (const panel of panels) {
      this.issLivePiPResizeObs.observe(panel);
    }
  }

  /**
   * Observe la largeur réelle d’une demi-piste du bandeau ISS et recalcule la durée d’animation
   * pour garder une vitesse de défilement constante (px/s) quel que soit le nombre d’infos affichées.
   */
  private attachIssTickerSpeedObserver(): void {
    this.issTickerResizeObs?.disconnect();
    this.issTickerResizeObs = undefined;
    const el = this.issTickerHalfEl;
    if (!el) {
      return;
    }
    if (typeof ResizeObserver === 'undefined') {
      queueMicrotask(() => this.updateIssTickerDuration(el.getBoundingClientRect().width));
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.issTickerResizeObs = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width != null && width > 0) {
          this.scheduleIssTickerDurationUpdate(width);
        }
      });
      this.issTickerResizeObs.observe(el);
    });
  }

  private scheduleIssTickerDurationUpdate(halfWidthPx: number): void {
    this.pendingIssTickerHalfWidthPx = halfWidthPx;
    if (this.issTickerDurationRaf != null) {
      return;
    }
    this.issTickerDurationRaf = requestAnimationFrame(() => {
      this.issTickerDurationRaf = null;
      this.updateIssTickerDuration(this.pendingIssTickerHalfWidthPx);
    });
  }

  private updateIssTickerDuration(halfWidthPx: number): void {
    if (!Number.isFinite(halfWidthPx) || halfWidthPx <= 0) {
      return;
    }
    const sec = Math.max(30, halfWidthPx / WorldGlobeComponent.ISS_TICKER_SPEED_PX_PER_SEC);
    const rounded = Math.round(sec);
    if (rounded !== this.issTickerDurationSec) {
      this.scheduleWorldGlobeCdr(() => {
        this.issTickerDurationSec = rounded;
      });
    }
  }

  private scheduleIssPiPSizePersist(): void {
    if (this.issPiPSuppressSizePersist) {
      return;
    }
    if (this.issLivePiPResizeSaveTimer != null) {
      clearTimeout(this.issLivePiPResizeSaveTimer);
    }
    this.issLivePiPResizeSaveTimer = setTimeout(() => {
      this.issLivePiPResizeSaveTimer = null;
      this.persistIssPiPPanelSizes();
    }, 280);
  }

  private persistIssPiPPanelSizes(): void {
    if (this.issLiveEmbedEnabled) {
      this.saveIssPiPSize(this.issLivePiP?.nativeElement, 'standard');
    }
    if (this.issLiveHdEmbedEnabled) {
      this.saveIssPiPSize(this.issLiveHdPiP?.nativeElement, 'hd');
    }
  }

  /** Taille de référence de la fenêtre HD (affichée ou stockée). */
  private resolveIssHdPiPReferenceSize(): { w: number; h: number } | null {
    const hd = this.issLiveHdPiP?.nativeElement;
    if (this.issLiveHdEmbedEnabled && hd) {
      const fromEl = this.readIssPiPPanelSizeFromElement(hd);
      if (fromEl) {
        return fromEl;
      }
    }
    try {
      const raw = localStorage.getItem(WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY.hd);
      if (raw) {
        const parsed = JSON.parse(raw) as { w?: number; h?: number };
        const w = typeof parsed.w === 'number' ? parsed.w : 0;
        const h = typeof parsed.h === 'number' ? parsed.h : 0;
        if (w > 0 && h > 0) {
          return { w, h };
        }
      }
    } catch {
      /* ignore */
    }
    if (!this.globePresentationMode && !this.isIssMobileStackLayout()) {
      return this.getIssPiPDefaultWindowedSize();
    }
    return null;
  }

  /** Aligne « ISS en direct » sur la largeur et la hauteur de « ISS en direct HD ». */
  private syncIssStandardPiPSizeWithHd(): void {
    if (this.issFsSplitLayout || this.isIssMobileStackLayout() || !this.issLiveEmbedEnabled) {
      return;
    }
    const standard = this.issLivePiP?.nativeElement;
    if (!standard) {
      return;
    }
    const ref = this.resolveIssHdPiPReferenceSize();
    if (!ref) {
      return;
    }
    const clamped = this.clampIssPiPSize(ref.w, ref.h);
    this.applyIssPiPPanelSize(standard, clamped.w, clamped.h);
    this.saveIssPiPSize(standard, 'standard');
  }

  private snapshotIssPiPPanelSizes(): Partial<
    Record<keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY, { w: number; h: number }>
  > {
    const out: Partial<
      Record<keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY, { w: number; h: number }>
    > = {};
    if (this.issLiveEmbedEnabled) {
      const panel = this.issLivePiP?.nativeElement;
      const size = this.readIssPiPPanelSizeFromElement(panel);
      if (size) {
        out.standard = size;
      }
    }
    if (this.issLiveHdEmbedEnabled) {
      const panel = this.issLiveHdPiP?.nativeElement;
      const size = this.readIssPiPPanelSizeFromElement(panel);
      if (size) {
        out.hd = size;
      }
    }
    return out;
  }

  private restoreIssPiPPanelSizes(
    snap: Partial<Record<keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY, { w: number; h: number }>>
  ): void {
    if (snap.standard && this.issLiveEmbedEnabled) {
      this.applyIssPiPPanelSize(this.issLivePiP?.nativeElement, snap.standard.w, snap.standard.h);
    }
    if (snap.hd && this.issLiveHdEmbedEnabled) {
      this.applyIssPiPPanelSize(this.issLiveHdPiP?.nativeElement, snap.hd.w, snap.hd.h);
    }
  }

  private readIssPiPPanelSizeFromElement(panel: HTMLElement | undefined): { w: number; h: number } | null {
    if (!panel) {
      return null;
    }
    const styleW = parseFloat(panel.style.width);
    const styleH = parseFloat(panel.style.height);
    const w =
      Number.isFinite(styleW) && styleW > 0
        ? styleW
        : panel.offsetWidth > 0
          ? panel.offsetWidth
          : 0;
    const h =
      Number.isFinite(styleH) && styleH > 0
        ? styleH
        : panel.offsetHeight > 0
          ? panel.offsetHeight
          : 0;
    if (w < 1 || h < 1) {
      return null;
    }
    return { w, h };
  }

  private applyIssPiPPanelSize(panel: HTMLElement | undefined, w: number, h: number): void {
    if (!panel || w < 1 || h < 1) {
      return;
    }
    const clamped = this.clampIssPiPStoredSize(w, h);
    panel.classList.add('wg-iss-live-pip--user-sized');
    panel.style.width = `${clamped.w}px`;
    panel.style.maxWidth = `${clamped.w}px`;
    panel.style.height = `${clamped.h}px`;
    panel.style.maxHeight = `${clamped.h}px`;
  }

  private issPiPSizeStorageKey(variant: keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY): string {
    return this.isIssMobileStackLayout()
      ? WorldGlobeComponent.ISS_PIP_MOBILE_SIZE_STORAGE_KEY[variant]
      : WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY[variant];
  }

  /** Taille par défaut mobile (pile sous le globe) : pleine largeur du dock, ratio 8/9 + barre. */
  private getIssPiPMobileDefaultSize(): { w: number; h: number } {
    const stage = this.getGlobeStageElement();
    const dock =
      stage?.querySelector<HTMLElement>('.wg-iss-pip-dock--fs-split') ??
      stage?.querySelector<HTMLElement>('.wg-iss-pip-dock');
    const widthRef = dock?.clientWidth ?? stage?.clientWidth ?? 0;
    const w = widthRef > 0 ? Math.round(widthRef) : Math.round(window.innerWidth * 0.96);
    const frameH = Math.round((w * 9) / 8);
    const h = frameH + WorldGlobeComponent.ISS_PIP_WINDOWED_BAR_PX;
    return this.clampIssPiPSize(w, h);
  }

  private getIssPiPWindowWidthRefPx(): number {
    if (typeof window !== 'undefined' && window.innerWidth > 0) {
      return window.innerWidth;
    }
    return this.getGlobeStageElement()?.clientWidth ?? 0;
  }

  /** Taille par défaut hors plein écran : 25 % de la largeur de la fenêtre navigateur. */
  private getIssPiPDefaultWindowedSize(): { w: number; h: number } {
    const winW = this.getIssPiPWindowWidthRefPx();
    const w = Math.round(winW * WorldGlobeComponent.ISS_PIP_WINDOWED_WIDTH_RATIO);
    const frameH = Math.round((w * 9) / 16);
    const h = frameH + WorldGlobeComponent.ISS_PIP_WINDOWED_BAR_PX;
    return this.clampIssPiPSize(w, h);
  }

  private applyIssPiPDefaultWindowedSize(
    panel: HTMLElement | undefined,
    variant: keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY
  ): void {
    if (!panel || this.globePresentationMode) {
      return;
    }
    if (this.isIssMobileStackLayout()) {
      const { w, h } = this.getIssPiPMobileDefaultSize();
      this.applyIssPiPPanelSize(panel, w, h);
      return;
    }
    const { w, h } = this.getIssPiPDefaultWindowedSize();
    this.applyIssPiPPanelSize(panel, w, h);
  }

  private applyIssPiPStoredSize(panel: HTMLElement | undefined, variant: keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY): void {
    if (!panel) {
      return;
    }
    try {
      const raw = localStorage.getItem(this.issPiPSizeStorageKey(variant));
      if (!raw) {
        this.applyIssPiPDefaultWindowedSize(panel, variant);
        return;
      }
      const parsed = JSON.parse(raw) as { w?: number; h?: number };
      const w = typeof parsed.w === 'number' ? parsed.w : 0;
      const h = typeof parsed.h === 'number' ? parsed.h : 0;
      if (w > 0 && h > 0) {
        this.applyIssPiPPanelSize(panel, w, h);
        return;
      }
      this.applyIssPiPDefaultWindowedSize(panel, variant);
    } catch {
      this.applyIssPiPDefaultWindowedSize(panel, variant);
    }
  }

  private saveIssPiPSize(panel: HTMLElement | undefined, variant: keyof typeof WorldGlobeComponent.ISS_PIP_SIZE_STORAGE_KEY): void {
    if (!panel || panel.offsetWidth < 1 || panel.offsetHeight < 1) {
      return;
    }
    try {
      const payload = {
        w: panel.offsetWidth,
        h: panel.offsetHeight
      };
      localStorage.setItem(this.issPiPSizeStorageKey(variant), JSON.stringify(payload));
    } catch {
      /* quota / private mode */
    }
  }

  private getGlobeStageElement(): HTMLElement | null {
    return this.globeShell?.nativeElement?.querySelector<HTMLElement>('.wg-stage') ?? null;
  }

  private clampIssPiPStoredSize(w: number, h: number): { w: number; h: number } {
    const min = WorldGlobeComponent.ISS_PIP_SIZE_MIN;
    const max = WorldGlobeComponent.ISS_PIP_SIZE_ABSOLUTE_MAX;
    return {
      w: w > 0 ? Math.min(max.w, Math.max(min.w, Math.round(w))) : 0,
      h: h > 0 ? Math.min(max.h, Math.max(min.h, Math.round(h))) : 0
    };
  }

  private clampIssPiPSize(w: number, h: number): { w: number; h: number } {
    const stage = this.getGlobeStageElement();
    const dock =
      stage?.querySelector<HTMLElement>('.wg-iss-pip-dock--fs-split') ??
      stage?.querySelector<HTMLElement>('.wg-iss-pip-dock');
    const widthRef =
      this.issFsSplitLayout && !this.isIssMobileStackLayout() && dock && dock.clientWidth > 0
        ? dock.clientWidth
        : this.isIssMobileStackLayout() && dock && dock.clientWidth > 0
          ? dock.clientWidth
          : stage?.clientWidth ?? 0;
    const heightRef = stage?.clientHeight ?? 0;
    const maxW = widthRef > 0 ? Math.floor(widthRef * WorldGlobeComponent.ISS_PIP_SIZE_MAX_RATIO.w) : 900;
    const maxH = heightRef > 0 ? Math.floor(heightRef * WorldGlobeComponent.ISS_PIP_SIZE_MAX_RATIO.h) : 700;
    const min = this.isIssMobileStackLayout()
      ? { w: 120, h: 136 }
      : WorldGlobeComponent.ISS_PIP_SIZE_MIN;
    return {
      w: Math.min(maxW, Math.max(min.w, Math.round(w))),
      h: Math.min(maxH, Math.max(min.h, Math.round(h)))
    };
  }

  /** Décale la fenêtre HD au-dessus de la hauteur réelle de la fenêtre standard. */
  private syncIssLivePiPStackOffset(): void {
    const hd = this.issLiveHdPiP?.nativeElement;
    if (!hd) {
      return;
    }
    if (this.issFsSplitLayout) {
      hd.style.removeProperty('--wg-iss-pip-stack-offset');
      return;
    }
    if (!this.issLiveEmbedEnabled || !this.issLiveHdEmbedEnabled) {
      hd.style.removeProperty('--wg-iss-pip-stack-offset');
      return;
    }
    const standard = this.issLivePiP?.nativeElement;
    const stackPx =
      (standard?.offsetHeight ?? 0) > 0
        ? standard!.offsetHeight + WorldGlobeComponent.ISS_PIP_STACK_GAP_PX
        : 180;
    hd.style.setProperty('--wg-iss-pip-stack-offset', `${stackPx}px`);
  }

  private buildIssLiveEmbedSafeUrl(videoId: string): SafeResourceUrl {
    const params = new URLSearchParams({
      autoplay: '1',
      mute: '1',
      playsinline: '1',
      rel: '0',
      modestbranding: '1',
      enablejsapi: '0'
    });
    return this.sanitizer.bypassSecurityTrustResourceUrl(
      `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`
    );
  }

  private getDocumentFullscreenElement(): Element | null {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    return (
      document.fullscreenElement ??
      doc.webkitFullscreenElement ??
      doc.mozFullScreenElement ??
      doc.msFullscreenElement ??
      null
    );
  }

  private getGlobeFullscreenRegion(): HTMLElement | null {
    return this.globeFsRoot?.nativeElement ?? this.globeShell?.nativeElement ?? null;
  }

  private isGlobeFullscreenElement(fsEl: Element | null): boolean {
    if (!fsEl) {
      return false;
    }
    const region = this.getGlobeFullscreenRegion();
    if (region && (fsEl === region || region.contains(fsEl))) {
      return true;
    }
    return (
      fsEl === document.documentElement &&
      document.body.classList.contains(WorldGlobeComponent.WG_TRUE_FS_BODY_CLASS)
    );
  }

  private setGlobeTrueFullscreenBodyClass(enabled: boolean): void {
    document.body.classList.toggle(WorldGlobeComponent.WG_TRUE_FS_BODY_CLASS, enabled);
  }

  private async exitGlobeFullscreenIfActive(): Promise<void> {
    this.setGlobeTrueFullscreenBodyClass(false);
    const fsEl = this.getDocumentFullscreenElement();
    if (!fsEl) {
      return;
    }
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      mozCancelFullScreen?: () => Promise<void>;
      msExitFullscreen?: () => Promise<void>;
    };
    try {
      await WorldGlobeComponent.exitFullscreenCompat(doc);
    } catch {
      /* ignore */
    }
  }

  private isPiPPanelFullscreen(panel: HTMLElement | null | undefined): boolean {
    if (!panel) {
      return false;
    }
    const fsEl = this.getDocumentFullscreenElement();
    return !!(fsEl && (fsEl === panel || panel.contains(fsEl)));
  }

  private syncIssLivePiPFullscreenFromDocument(): void {
    this.issLivePiPFullscreen = this.isPiPPanelFullscreen(this.issLivePiP?.nativeElement);
    this.issLiveHdPiPFullscreen = this.isPiPPanelFullscreen(this.issLiveHdPiP?.nativeElement);
  }

  private async togglePiPPanelFullscreen(panel: HTMLElement | undefined): Promise<void> {
    if (!panel) {
      return;
    }
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      mozCancelFullScreen?: () => Promise<void>;
      msExitFullscreen?: () => Promise<void>;
    };
    if (this.isPiPPanelFullscreen(panel)) {
      try {
        await WorldGlobeComponent.exitFullscreenCompat(doc);
      } catch {
        /* ignore */
      }
      this.syncIssLivePiPFullscreenFromDocument();
      this.cdr.markForCheck();
      return;
    }
    const req =
      panel.requestFullscreen?.bind(panel) ??
      (panel as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(panel) ??
      (panel as HTMLElement & { msRequestFullscreen?: () => Promise<void> }).msRequestFullscreen?.bind(panel);
    if (!req) {
      return;
    }
    try {
      await req();
      this.syncIssLivePiPFullscreenFromDocument();
      this.cdr.markForCheck();
    } catch {
      /* ignore */
    }
  }

  async toggleIssLivePiPFullscreen(): Promise<void> {
    await this.togglePiPPanelFullscreen(this.issLivePiP?.nativeElement);
  }

  async toggleIssLiveHdPiPFullscreen(): Promise<void> {
    await this.togglePiPPanelFullscreen(this.issLiveHdPiP?.nativeElement);
  }

  /** Direct ISS (Destination Orbite) dans un nouvel onglet. */
  openIssLiveFromDestinationOrbite(): void {
    window.open(ISS_LIVE_DESTINATION_ORBITE_URL, '_blank', 'noopener,noreferrer');
  }

  /** Ouvre le viseur d’astres avec le dernier satellite (ou l’ISS) déjà sélectionné. */
  openAstroCompassIss(): void {
    this.openAstroCompassSatellite(this.astroViseurSatId());
  }

  /** Ouvre le viseur d’astres avec le satellite indiqué déjà sélectionné. */
  openAstroCompassSatellite(satId: string): void {
    const id = (satId || '').trim().toLowerCase();
    if (!id) {
      return;
    }
    this.rememberAstroViseurSat(id);
    this.writeAstroReturnSat(id);
    void this.router.navigate(['/tools/astro-compass'], { queryParams: { target: id } });
  }

  /** Direct ISS HD (Destination Orbite) dans un nouvel onglet. */
  openIssLiveHdFromDestinationOrbite(): void {
    window.open(ISS_LIVE_HD_DESTINATION_ORBITE_URL, '_blank', 'noopener,noreferrer');
  }

  /** Copie une capture de la mini-fenêtre ISS (PNG) dans le presse-papiers. */
  async copyIssPiPScreenshotToClipboard(variant: 'standard' | 'hd'): Promise<void> {
    if (this.issPiPImageBusy != null) {
      return;
    }
    const capture = this.resolveIssPiPCapture(variant);
    if (!capture) {
      this.flashIssPiPCopyFeedback(variant, false);
      return;
    }
    this.issPiPImageBusy = { variant, action: 'copy' };
    this.cdr.markForCheck();
    try {
      const blob = await this.captureIssPiPFrameToPngBlob(capture.frame, capture.videoId);
      if (!blob) {
        this.flashIssPiPCopyFeedback(variant, false);
        return;
      }
      const ok = await this.writeIssPiPPngToClipboard(blob);
      this.flashIssPiPCopyFeedback(variant, ok);
    } catch (err: unknown) {
      const name = err instanceof DOMException || err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        return;
      }
      this.flashIssPiPCopyFeedback(variant, false);
    } finally {
      this.issPiPImageBusy = null;
      this.cdr.markForCheck();
    }
  }

  private resolveIssPiPCapture(
    variant: 'standard' | 'hd'
  ): { frame: HTMLElement; videoId: string } | null {
    const panel =
      variant === 'standard' ? this.issLivePiP?.nativeElement : this.issLiveHdPiP?.nativeElement;
    if (!panel || !this.isIssPiPVisibleForCapture(panel)) {
      return null;
    }
    const frame = panel.querySelector<HTMLElement>('.wg-iss-live-pip__frame');
    if (!frame || !this.isIssPiPVisibleForCapture(frame)) {
      return null;
    }
    const videoId = variant === 'standard' ? ISS_LIVE_YOUTUBE_VIDEO_ID : ISS_LIVE_HD_YOUTUBE_VIDEO_ID;
    return { frame, videoId };
  }

  private isIssPiPVisibleForCapture(panel: HTMLElement): boolean {
    const rect = panel.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      return false;
    }
    const style = getComputedStyle(panel);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  /**
   * Capture d'écran via getDisplayMedia : recadrage Region Capture ou cropRect viewport.
   * @param cropTargetEl élément CropTarget (PiP) ; null pour un recadrage rect seul (partage globe).
   */
  private async captureDomRegionViaDisplayMedia(
    cropTargetEl: HTMLElement | null,
    cropRectOrFn: DOMRect | (() => DOMRect),
    postStreamSettleMs = 250
  ): Promise<Blob | null> {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      return null;
    }

    const win = window as Window & {
      CropTarget?: { fromElement: (el: Element) => Promise<unknown> };
    };
    let cropTarget: unknown | null = null;
    if (cropTargetEl && typeof win.CropTarget?.fromElement === 'function') {
      try {
        cropTarget = await win.CropTarget.fromElement(cropTargetEl);
      } catch {
        cropTarget = null;
      }
    }

    const displayOpts = {
      video: true,
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include'
    } as DisplayMediaStreamOptions;

    const stream = await navigator.mediaDevices.getDisplayMedia(displayOpts);
    try {
      const [track] = stream.getVideoTracks();
      if (!track) {
        return null;
      }
      const browserTrack = track as MediaStreamTrack & { cropTo?: (target: unknown) => Promise<void> };
      let elementCropApplied = false;
      if (cropTarget != null && typeof browserTrack.cropTo === 'function') {
        try {
          await browserTrack.cropTo(cropTarget);
          elementCropApplied = true;
        } catch {
          elementCropApplied = false;
        }
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await new Promise<void>((resolve) => setTimeout(resolve, postStreamSettleMs));

      const cropRect = typeof cropRectOrFn === 'function' ? cropRectOrFn() : cropRectOrFn;
      if (!elementCropApplied && (cropRect.width < 2 || cropRect.height < 2)) {
        return null;
      }

      let blob = await this.grabPngBlobFromMediaTrack(
        track,
        elementCropApplied ? undefined : cropRect
      );
      if (!blob && !elementCropApplied) {
        const full = await this.grabPngBlobFromMediaTrack(track);
        if (full) {
          blob = await this.cropPngBlobToRect(full, cropRect);
        }
      }
      if (!blob && postStreamSettleMs >= 400) {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        const retryRect = typeof cropRectOrFn === 'function' ? cropRectOrFn() : cropRectOrFn;
        blob = await this.grabPngBlobFromMediaTrack(
          track,
          elementCropApplied ? undefined : retryRect
        );
        if (!blob && !elementCropApplied) {
          const full = await this.grabPngBlobFromMediaTrack(track);
          if (full) {
            blob = await this.cropPngBlobToRect(full, retryRect);
          }
        }
      }
      return blob;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  /**
   * Capture uniquement la zone vidéo de la fenêtre PiP (`.wg-iss-live-pip__frame`),
   * sans barre titre/boutons ni le reste de la page.
   */
  private async captureIssPiPFrameToPngBlob(
    frame: HTMLElement,
    videoId: string,
    allowThumbnailFallback = true
  ): Promise<Blob | null> {
    if (typeof navigator.mediaDevices?.getDisplayMedia === 'function') {
      try {
        const captured = await this.captureIssPiPFrameViaTabCapture(frame);
        if (captured) {
          return captured;
        }
      } catch (err: unknown) {
        const name = err instanceof DOMException || err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError' || name === 'AbortError') {
          throw err;
        }
      }
    }
    if (!allowThumbnailFallback) {
      return null;
    }
    return this.captureIssPiPFrameCanvas(frame, videoId);
  }

  /** Recadrage Region Capture sur la zone iframe uniquement (flux live visible). */
  private async captureIssPiPFrameViaTabCapture(frame: HTMLElement): Promise<Blob | null> {
    return this.captureDomRegionViaDisplayMedia(frame, frame.getBoundingClientRect());
  }

  /** Mobile / tablette : ImageCapture souvent absent ou instable. */
  private globeSharePreferNativeFileShare(): boolean {
    const ua = navigator.userAgent;
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }
    return navigator.maxTouchPoints > 1 && /Macintosh|MacIntel/i.test(ua);
  }

  private globeShareUseMobileCaptureFlow(): boolean {
    return this.globeSharePreferNativeFileShare() || this.isIssMobileStackLayout();
  }

  private grabPngBlobFromMediaTrack(
    track: MediaStreamTrack,
    cropRect?: DOMRect,
    timeoutMs = 8000
  ): Promise<Blob | null> {
    return this.withTimeout(this.grabPngBlobFromMediaTrackInner(track, cropRect), timeoutMs);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => resolve(null), ms);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          const cancelName = err instanceof DOMException || err instanceof Error ? err.name : '';
          if (cancelName === 'AbortError' || cancelName === 'NotAllowedError') {
            reject(err);
          } else {
            resolve(null);
          }
        });
    });
  }

  private cropPngBlobToRect(sourceBlob: Blob, cropRect: DOMRect): Promise<Blob | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(sourceBlob);
      const img = new Image();
      const cleanup = (): void => URL.revokeObjectURL(url);
      img.onload = () => {
        cleanup();
        void this.pngBlobFromVideoFrame(img, img.naturalWidth, img.naturalHeight, cropRect).then(resolve);
      };
      img.onerror = () => {
        cleanup();
        resolve(null);
      };
      img.src = url;
    });
  }

  private grabPngBlobFromMediaTrackInner(track: MediaStreamTrack, cropRect?: DOMRect): Promise<Blob | null> {
    type ImageCaptureGrabFrame = new (track: MediaStreamTrack) => {
      grabFrame: () => Promise<ImageBitmap>;
    };
    const ImageCaptureCtor = (window as unknown as { ImageCapture?: ImageCaptureGrabFrame }).ImageCapture;
    const useImageCapture = !this.globeShareUseMobileCaptureFlow() && ImageCaptureCtor;
    if (useImageCapture) {
      return new ImageCaptureCtor(track)
        .grabFrame()
        .then(async (bitmap: ImageBitmap) => {
          try {
            return await this.pngBlobFromVideoFrame(bitmap, bitmap.width, bitmap.height, cropRect);
          } finally {
            bitmap.close();
          }
        })
        .catch(() => this.grabPngBlobFromMediaTrackViaVideo(track, cropRect));
    }
    return this.grabPngBlobFromMediaTrackViaVideo(track, cropRect);
  }

  private grabPngBlobFromMediaTrackViaVideo(
    track: MediaStreamTrack,
    cropRect?: DOMRect
  ): Promise<Blob | null> {
    const stream = new MediaStream([track]);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    return video
      .play()
      .catch(() => undefined)
      .then(() => this.pngBlobFromVideoElement(video, cropRect));
  }

  private pngBlobFromVideoFrame(
    source: CanvasImageSource,
    vw: number,
    vh: number,
    cropRect?: DOMRect
  ): Promise<Blob | null> {
    if (vw < 1 || vh < 1) {
      return Promise.resolve(null);
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return Promise.resolve(null);
    }
    if (!cropRect || cropRect.width < 1 || cropRect.height < 1) {
      canvas.width = vw;
      canvas.height = vh;
      ctx.drawImage(source, 0, 0);
    } else {
      const mapped = this.mapGlobeShareCropToCapture(cropRect, vw, vh);
      if (!mapped) {
        canvas.width = vw;
        canvas.height = vh;
        ctx.drawImage(source, 0, 0);
      } else {
        canvas.width = mapped.sw;
        canvas.height = mapped.sh;
        ctx.drawImage(source, mapped.sx0, mapped.sy0, mapped.sw, mapped.sh, 0, 0, mapped.sw, mapped.sh);
      }
    }
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
  }

  /** Recadrage viewport → pixels du flux capturé (plusieurs heuristiques mobile). */
  private mapGlobeShareCropToCapture(
    cropRect: DOMRect,
    vw: number,
    vh: number
  ): { sx0: number; sy0: number; sw: number; sh: number } | null {
    const attempts: Array<{ layoutW: number; layoutH: number; ox: number; oy: number }> = [];
    const vp = window.visualViewport;
    const docW = document.documentElement.clientWidth || window.innerWidth;
    const docH = document.documentElement.clientHeight || window.innerHeight;
    attempts.push({ layoutW: docW, layoutH: docH, ox: vp?.offsetLeft ?? 0, oy: vp?.offsetTop ?? 0 });
    attempts.push({ layoutW: window.innerWidth, layoutH: window.innerHeight, ox: 0, oy: 0 });
    if (vp && vp.width > 0 && vp.height > 0) {
      attempts.push({ layoutW: vp.width, layoutH: vp.height, ox: vp.offsetLeft, oy: vp.offsetTop });
    }
    attempts.push({ layoutW: vw, layoutH: vh, ox: 0, oy: 0 });

    for (const { layoutW, layoutH, ox, oy } of attempts) {
      if (layoutW < 1 || layoutH < 1) {
        continue;
      }
      const sx = vw / layoutW;
      const sy = vh / layoutH;
      const sw = Math.max(1, Math.round(cropRect.width * sx));
      const sh = Math.max(1, Math.round(cropRect.height * sy));
      const sx0 = Math.max(0, Math.round((cropRect.left - ox) * sx));
      const sy0 = Math.max(0, Math.round((cropRect.top - oy) * sy));
      if (sx0 + sw <= vw + 2 && sy0 + sh <= vh + 2) {
        return { sx0, sy0, sw, sh };
      }
    }
    return null;
  }

  private pngBlobFromVideoElement(video: HTMLVideoElement, cropRect?: DOMRect): Promise<Blob | null> {
    const maxAttempts = this.globeSharePreferNativeFileShare() ? 120 : 60;
    const bootDelayMs = this.globeSharePreferNativeFileShare() ? 2200 : 1500;
    return new Promise<Blob | null>((resolve) => {
      let attempts = 0;
      const capture = (): void => {
        attempts += 1;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          void this.pngBlobFromVideoFrame(video, video.videoWidth, video.videoHeight, cropRect).then(resolve);
          return;
        }
        if (attempts >= maxAttempts) {
          resolve(null);
          return;
        }
        requestAnimationFrame(capture);
      };
      video.addEventListener('loadeddata', capture, { once: true });
      video.addEventListener('playing', capture, { once: true });
      window.setTimeout(capture, bootDelayMs);
      capture();
    });
  }

  /** Repli : image de la zone vidéo seule (vignette YouTube du flux). */
  private async captureIssPiPFrameCanvas(frame: HTMLElement, videoId: string): Promise<Blob | null> {
    const w = Math.max(1, Math.round(frame.clientWidth));
    const h = Math.max(1, Math.round(frame.clientHeight));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    let thumb = await this.loadIssPiPCaptureImage(thumbUrl);
    if (!thumb) {
      thumb = await this.loadIssPiPCaptureImage(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
    }
    if (thumb) {
      this.drawIssPiPImageCover(ctx, thumb, w, h);
    }

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
  }

  private drawIssPiPImageCover(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    w: number,
    h: number
  ): void {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (iw < 1 || ih < 1) {
      return;
    }
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  private loadIssPiPCaptureImage(url: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  private async writeIssPiPPngToClipboard(blob: Blob): Promise<boolean> {
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const reencoded = await this.encodeIssPiPBlobAsPng(blob);
      if (!reencoded) {
        return false;
      }
      pngBlob = reencoded;
    }
    const win = window as Window & {
      ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
    };
    if (!navigator.clipboard?.write || typeof win.ClipboardItem !== 'function') {
      return false;
    }
    try {
      await navigator.clipboard.write([new win.ClipboardItem!({ 'image/png': pngBlob })]);
      return true;
    } catch (err: unknown) {
      const cancelName = err instanceof DOMException || err instanceof Error ? err.name : '';
      if (cancelName === 'AbortError' || cancelName === 'NotAllowedError') {
        throw err;
      }
      return false;
    }
  }

  private encodeIssPiPBlobAsPng(blob: Blob): Promise<Blob | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const cleanup = (): void => URL.revokeObjectURL(url);
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 1;
          canvas.height = img.naturalHeight || img.height || 1;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            cleanup();
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((out) => {
            cleanup();
            resolve(out);
          }, 'image/png');
        } catch {
          cleanup();
          resolve(null);
        }
      };
      img.onerror = () => {
        cleanup();
        resolve(null);
      };
      img.src = url;
    });
  }

  private flashIssPiPCopyFeedback(variant: 'standard' | 'hd', ok: boolean): void {
    if (this.issPiPCopyFlashTimer != null) {
      clearTimeout(this.issPiPCopyFlashTimer);
    }
    this.issPiPCopyFlash = { variant, ok };
    this.cdr.markForCheck();
    this.issPiPCopyFlashTimer = setTimeout(() => {
      this.issPiPCopyFlash = null;
      this.issPiPCopyFlashTimer = null;
      this.cdr.markForCheck();
    }, 2200);
  }

  /** Décompte : mm:ss à partir de 60 s, sinon secondes. */
  formatIssCountdown(): string {
    const s = this.issSecondsUntilNextRefresh;
    if (s <= 0) {
      return '0';
    }
    if (s >= 60) {
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}:${r.toString().padStart(2, '0')}`;
    }
    return String(s);
  }

  private clampIssPollIntervalSec(raw: number): number {
    if (!Number.isFinite(raw)) {
      return GLOBE_ISS_POLL_DEFAULT_SEC;
    }
    const n = Math.round(raw);
    return Math.min(GLOBE_ISS_POLL_MAX_SEC, Math.max(GLOBE_ISS_POLL_MIN_SEC, n));
  }

  private issPollIntervalMs(): number {
    return this.clampIssPollIntervalSec(this.issPollIntervalSec) * 1000;
  }

  onCoastlinesToggle(): void {
    if (this.coastlinesEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeCoastlinesOverlay();
      this.coastlinesOverlayFailed = false;
      this.coastlinesOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onGraticuleToggle(): void {
    if (this.graticuleEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeGraticuleOverlay();
      this.cdr.markForCheck();
    }
  }

  onPoliticalMapToggle(): void {
    if (this.politicalMapEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposePoliticalMapOverlay();
      if (!this.countryLabelsEnabled) {
        this.admin0CountriesOverlayFailed = false;
        this.admin0CountriesOverlayLoading = false;
      }
      this.cdr.markForCheck();
    }
  }

  onCountryLabelsToggle(): void {
    if (this.countryLabelsEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeCountryLabelsOverlay();
      if (!this.politicalMapEnabled) {
        this.admin0CountriesOverlayFailed = false;
        this.admin0CountriesOverlayLoading = false;
      }
      this.cdr.markForCheck();
    }
  }

  onGeographicLinesToggle(): void {
    if (this.geographicLinesEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeGeographicLinesOverlay();
      this.geographicLinesFailed = false;
      this.geographicLinesLoading = false;
      this.cdr.markForCheck();
    }
  }

  onRiversToggle(): void {
    if (this.riversEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeRiversOverlay();
      this.riversOverlayFailed = false;
      this.riversOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onLakesToggle(): void {
    if (this.lakesEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeLakesMesh();
      this.lakesOverlayFailed = false;
      this.lakesOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onGlaciersToggle(): void {
    if (this.glaciersEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeGlaciersMesh();
      this.glaciersOverlayFailed = false;
      this.glaciersOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onCitiesToggle(): void {
    if (this.citiesEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeCitiesPoints();
      this.citiesOverlayFailed = false;
      this.citiesOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onTimeZonesToggle(): void {
    if (this.timeZonesEnabled) {
      this.syncGlobeDecorationsAfterEarthReady();
    } else {
      this.disposeTimeZonesMesh();
      this.timeZonesOverlayFailed = false;
      this.timeZonesOverlayLoading = false;
      this.cdr.markForCheck();
    }
  }

  onAutoRotateToggle(): void {
  }

  /**
   * Cadre la Terre pour que (lat°, lon°) soit au centre du globe à l’écran.
   * @param verticalLift léger décalage vertical (défaut : relief lisible). La recherche géocode utilise `verticalLift = 0` pour centrer le point rouge.
   */
  private frameCameraOnLatLon(latDeg: number, lonDeg: number, distance: number, verticalLift = 0.22): void {
    if (!this.camera || !this.controls) {
      return;
    }
    const pos = this.computeCameraPositionForLatLon(latDeg, lonDeg, distance, verticalLift);
    if (!pos) {
      return;
    }
    this.camera.position.copy(pos);
    this.camera.up.set(0, 1, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private globeOrbitDistance(): number {
    const controls = this.controls;
    const camera = this.camera;
    if (!controls || !camera) {
      return GLOBE_INITIAL_ORBIT_DISTANCE;
    }
    return camera.position.distanceTo(controls.target);
  }

  /**
   * Distance pour voir la Terre entière (diamètre) dans la fenêtre, y compris en portrait.
   * Le FOV Three.js est vertical : un aspect étroit impose un recul plus grand.
   */
  private wholeGlobeOrbitDistance(): number {
    const camera = this.camera;
    const controls = this.controls;
    const minD = controls?.minDistance ?? 1.02;
    const maxD = controls?.maxDistance ?? 7;
    const fovDeg = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
    const aspect =
      camera instanceof THREE.PerspectiveCamera && Number.isFinite(camera.aspect) && camera.aspect > 0.05
        ? camera.aspect
        : 1;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
    if (!(tanHalf > 1e-6)) {
      return GLOBE_INITIAL_ORBIT_DISTANCE;
    }
    const fitRadius = 1.18;
    const vDist = fitRadius / tanHalf;
    const hDist = fitRadius / (tanHalf * aspect);
    return THREE.MathUtils.clamp(Math.max(vDist, hDist, GLOBE_INITIAL_ORBIT_DISTANCE), minD + 0.08, maxD * 0.95);
  }

  /** Distance de départ (plus proche) pour le dézoom fluide viseur → globe. */
  private astroReturnCameraStartDistance(endDist: number): number {
    const minD = this.controls?.minDistance ?? 1.02;
    const start = Math.min(GLOBE_ASTRO_RETURN_START_DISTANCE, endDist * 0.55);
    return THREE.MathUtils.clamp(start, minD + 0.1, Math.max(minD + 0.12, endDist - 0.2));
  }

  /**
   * Recentre sur l’objet en dézoomant en douceur jusqu’à voir la Terre entière
   * (retour depuis le viseur d’astres).
   */
  private flyCameraToAstroReturn(lat: number, lon: number): void {
    const camera = this.camera;
    const controls = this.controls;
    if (!camera || !controls) {
      return;
    }
    const endDist = this.wholeGlobeOrbitDistance();
    const startDist = this.astroReturnCameraStartDistance(endDist);
    if (camera.position.lengthSq() < 1e-4) {
      camera.position.set(0, 0, startDist);
      camera.up.set(0, 1, 0);
      controls.target.set(0, 0, 0);
      controls.update();
    } else {
      const current = camera.position.distanceTo(controls.target);
      if (current > (startDist + endDist) * 0.5) {
        camera.position.setLength(startDist);
        controls.target.set(0, 0, 0);
        controls.update();
      }
    }
    this.issGlobeFreeOrbit = true;
    this.animateCameraToLatLon(lat, lon, endDist, GLOBE_ASTRO_RETURN_ANIM_MS, 0, () => {
      if (this.issKeepEarthCentered && !this.tickerFocusSatId) {
        this.issGlobeFreeOrbit = false;
        this.issCameraCenterSmoothPrevMs = 0;
      }
    });
  }

  /** OrbitControls : NONE = -1 (pas de geste en cours). */
  private isGlobeOrbitIdle(controls: OrbitControls): boolean {
    return (controls as OrbitControls & { state: number }).state === -1;
  }

  /**
   * Position caméra pour regarder le lieu (lat, lon) : cible OrbitControls à l’origine.
   * @param verticalLift Décalage Y monde (lecture du relief par défaut). Mettre 0 pour centrer le lieu au milieu de la fenêtre (recherche géocode).
   */
  private computeCameraPositionForLatLon(
    latDeg: number,
    lonDeg: number,
    distance: number,
    verticalLift = 0.22
  ): THREE.Vector3 | null {
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
    return new THREE.Vector3(radial.x, radial.y + verticalLift, radial.z);
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
    if (this.controls && this.globeCameraAnimPrevEnableDamping !== null) {
      this.controls.enableDamping = this.globeCameraAnimPrevEnableDamping;
      this.globeCameraAnimPrevEnableDamping = null;
    }
  }

  /**
   * Déplace la caméra vers le lieu en suivant un arc de grand cercle (rotation fluide),
   * au lieu d’un saut instantané.
   */
  private animateCameraToLatLon(
    latDeg: number,
    lonDeg: number,
    distance: number,
    durationMs = GLOBE_GEOCODE_ANIM_MS,
    /** 0 = lieu exactement au centre de la fenêtre (axe caméra → centre du globe). */
    verticalLift = 0,
    onComplete?: () => void
  ): void {
    const camera = this.camera;
    const controls = this.controls;
    if (!camera || !controls) {
      return;
    }
    const endPos = this.computeCameraPositionForLatLon(latDeg, lonDeg, distance, verticalLift);
    if (!endPos) {
      return;
    }
    this.stopGlobeCameraAnimation();
    this.globeCameraAnimPrevEnableDamping = controls.enableDamping;
    controls.enableDamping = false;

    const startPos = camera.position.clone();
    const startLen = startPos.length();
    const endLen = endPos.length();
    if (startLen < 1e-8) {
      camera.position.copy(endPos);
      controls.target.set(0, 0, 0);
      camera.up.set(0, 1, 0);
      controls.enableDamping = this.globeCameraAnimPrevEnableDamping ?? true;
      this.globeCameraAnimPrevEnableDamping = null;
      controls.update();
      onComplete?.();
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
        camera.up.set(0, 1, 0);
        controls.enableDamping = this.globeCameraAnimPrevEnableDamping ?? true;
        this.globeCameraAnimPrevEnableDamping = null;
        controls.update();
        onComplete?.();
      }
    };

    this.globeCameraAnimFrameId = requestAnimationFrame(step);
  }

  /**
   * Adapte rotate / pan / zoom aux distances caméra : plus la caméra est proche du globe,
   * plus les gestes souris restent précis (sans changer le réglage utilisateur entre deux zooms).
   */
  private syncGlobeControlsSensitivity(): void {
    const controls = this.controls;
    const camera = this.camera;
    if (!controls || !camera) {
      return;
    }
    const d = camera.position.distanceTo(controls.target);
    const lo = controls.minDistance;
    const hi = controls.maxDistance;
    const u = hi > lo ? THREE.MathUtils.clamp((d - lo) / (hi - lo), 0, 1) : 1;
    controls.rotateSpeed = THREE.MathUtils.lerp(ORBIT_SENS_U_MIN_ROTATE, GLOBE_ORBIT_ROTATE_SPEED_MAX, u);
    controls.panSpeed = THREE.MathUtils.lerp(ORBIT_SENS_U_MIN_PAN, GLOBE_ORBIT_PAN_SPEED_MAX, u);
    controls.zoomSpeed = THREE.MathUtils.lerp(ORBIT_SENS_U_MIN_ZOOM, GLOBE_ORBIT_ZOOM_SPEED_MAX, u);
  }

  private syncGlobeOrbitAutoRotate(controls: OrbitControls): void {
    const shouldAuto =
      this.autoRotate &&
      this.globeCameraAnimFrameId == null &&
      (!this.isIssEarthCenteredTrackingActive() || this.issGlobeFreeOrbit) &&
      (!this.isFlightEarthCenteredTrackingActive() || this.flightGlobeFreeOrbit) &&
      this.isGlobeOrbitIdle(controls);
    controls.autoRotate = shouldAuto;
    controls.autoRotateSpeed = GLOBE_AUTO_ROTATE_SPEED;
  }

  /**
   * Réduit l’échelle des noms de pays quand la caméra se rapproche, pour éviter
   * des étiquettes disproportionnées à fort zoom.
   */
  private updateCountryLabelsScaleForZoom(): void {
    const group = this.countryLabelsGroup;
    if (!group || !this.countryLabelsEnabled) {
      return;
    }
    const controls = this.controls;
    const camera = this.camera;
    if (!controls || !camera) {
      return;
    }
    const d = camera.position.distanceTo(controls.target);
    const lo = controls.minDistance;
    const hi = controls.maxDistance;
    const span = hi - lo;
    const u = span > 1e-8 ? THREE.MathUtils.clamp((d - lo) / span, 0, 1) : 1;
    const mul = THREE.MathUtils.lerp(
      GLOBE_COUNTRY_LABEL_ZOOM_MIN_MUL,
      1,
      Math.pow(u, GLOBE_COUNTRY_LABEL_ZOOM_GAMMA)
    );
    if (Math.abs(mul - this.countryLabelZoomMulCached) < 0.002) {
      return;
    }
    this.countryLabelZoomMulCached = mul;
    group.traverse((child) => {
      if (!(child instanceof THREE.Sprite)) {
        return;
      }
      const base = child.userData['countryLabelBase'] as { w: number; h: number } | undefined;
      if (!base) {
        return;
      }
      child.scale.set(base.w * mul, base.h * mul, 1);
    });
    this.updateIssHistoricalTraceDateLabelsScaleForZoom(mul);
  }

  /** Même facteur de zoom que les étiquettes pays (paramètre {@code mul} déjà calculé). */
  private updateIssHistoricalTraceDateLabelsScaleForZoom(mul?: number): void {
    const group = this.issHistoricalTraceDateLabelsGroup;
    if (!group || !this.issHistoricalTraceDatesEnabled) {
      return;
    }
    let scaleMul = mul;
    if (scaleMul == null) {
      const controls = this.controls;
      const camera = this.camera;
      if (!controls || !camera) {
        return;
      }
      const d = camera.position.distanceTo(controls.target);
      const lo = controls.minDistance;
      const hi = controls.maxDistance;
      const span = hi - lo;
      const u = span > 1e-8 ? THREE.MathUtils.clamp((d - lo) / span, 0, 1) : 1;
      scaleMul = THREE.MathUtils.lerp(
        GLOBE_COUNTRY_LABEL_ZOOM_MIN_MUL,
        1,
        Math.pow(u, GLOBE_COUNTRY_LABEL_ZOOM_GAMMA)
      );
    }
    group.traverse((child) => {
      if (!(child instanceof THREE.Sprite)) {
        return;
      }
      const base = child.userData['issTraceDateLabelBase'] as { w: number; h: number } | undefined;
      if (!base) {
        return;
      }
      child.scale.set(base.w * scaleMul, base.h * scaleMul, 1);
    });
  }

  private isGlobeIssPositionKnown(): boolean {
    const lat = this.globeIssLat;
    const lon = this.globeIssLon;
    return (
      lat != null &&
      lon != null &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180
    );
  }

  /** Cadrage initial : ISS si connue, sinon attente du flux ISS, sinon fallback France. */
  private frameDefaultGlobeCamera(): void {
    if (this.pendingGlobeDeepLink) {
      return;
    }
    const homeDist = this.pendingCenterFitWholeGlobe
      ? this.astroReturnCameraStartDistance(this.wholeGlobeOrbitDistance())
      : GLOBE_INITIAL_ORBIT_DISTANCE;
    if (this.pendingDeepLinkSatId && this.pendingDeepLinkSatId !== 'iss') {
      this.applyPendingSatelliteDeepLink();
      return;
    }
    if (this.isGlobeIssPositionKnown()) {
      this.applyInitialIssCameraCenterIfNeeded(
        this.globeIssLat!,
        this.globeIssLon!,
        !this.pendingCenterFitWholeGlobe
      );
      return;
    }
    if (this.issPositionFeedActive() && this.issKeepEarthCentered) {
      if (this.camera && this.controls) {
        this.camera.position.set(0, 0, homeDist);
        this.camera.up.set(0, 1, 0);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
      }
      return;
    }
    this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, homeDist);
    this.globeInitialIssCameraPending = false;
  }

  /** Vol fluide ou snap immédiat vers l’ISS à la première position reçue (ouverture du globe). */
  private applyInitialIssCameraCenterIfNeeded(lat: number, lon: number, instant = false): void {
    if (!this.globeInitialIssCameraPending) {
      return;
    }
    if (this.pendingGlobeDeepLink || this.isGlobeFocusedOnPlace()) {
      return;
    }
    if (!this.issKeepEarthCentered || !this.camera || !this.controls) {
      return;
    }
    this.issCameraCenterSmoothPrevMs = 0;
    this.globeInitialIssCameraPending = false;
    if (this.pendingCenterFitWholeGlobe) {
      this.pendingCenterFitWholeGlobe = false;
      this.flyCameraToAstroReturn(lat, lon);
      return;
    }
    const dist = GLOBE_INITIAL_ORBIT_DISTANCE;
    if (instant) {
      this.frameCameraOnLatLon(lat, lon, dist, 0);
      return;
    }
    this.animateCameraToLatLon(lat, lon, dist, GLOBE_INITIAL_ISS_ANIM_MS, 0);
  }

  /** Applique lat/lon ISS (cache prefetch, session ou réseau) et centre la vue si besoin. */
  private applyIssNowSnapshot(snap: GlobeIssNowSnapshot, instantCamera: boolean): void {
    const lat = snap.lat;
    const lon = snap.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return;
    }
    this.applyInitialIssCameraCenterIfNeeded(lat, lon, instantCamera);
    this.syncIssOverlayFromSnapshot(snap);
    this.commitGlobeIssPosition(lat, lon);
    this.scheduleWorldGlobeCdr(() => {
      if (snap.altKm != null) {
        this.globeIssAltKm = snap.altKm;
      }
      if (snap.velocityKmh != null) {
        this.issGroundSpeedKmh = snap.velocityKmh;
      }
    });
  }

  /** Marqueur ISS, zone de visibilité et trace prévue dès que la Terre est prête. */
  private syncIssOverlayFromSnapshot(snap: GlobeIssNowSnapshot): void {
    if (!this.issOverlayEnabled || !this.earthMesh) {
      return;
    }
    const lat = snap.lat;
    const lon = snap.lon;
    this.ensureIssMarkerMesh();
    this.updateIssMarkerWorldPosition(lat, lon);
    this.updateIssVisibilityCircle(lat, lon, snap.altKm ?? null);

    if (!this.issTraceVisible) {
      return;
    }

    const cachedForecast = this.issNowService.getForecastSnapshot();
    if (cachedForecast && cachedForecast.points.length > 0) {
      this.applyIssForecastPointsImmediate(cachedForecast.points, lat, lon, cachedForecast.approximate);
    } else {
      const approx = this.issNowService.buildApproximateForecast(snap);
      if (approx) {
        this.applyIssForecastPointsImmediate(approx.points, lat, lon, true);
      }
    }

    void this.loadIssForecastTrail(
      lat,
      lon,
      snap.prevLat ?? null,
      snap.prevLon ?? null,
      snap.velocityKmh ?? null,
      true
    );
  }

  private applyIssForecastPointsImmediate(
    pts: { lat: number; lon: number; atSec: number }[],
    issLat: number,
    issLon: number,
    approximate: boolean
  ): void {
    if (!this.issTraceVisible || pts.length === 0) {
      return;
    }
    this.issForecastTrailPoints.length = 0;
    this.issForecastTrailPoints.push(...pts);
    this.issForecastTrailApproximate = approximate;
    this.markIssForecastTrailGeometryDirty();
    this.rebuildIssForecastTrailGeometry(issLat, issLon);
    this.issForecastTrailLastGeometryRebuildMs = performance.now();
    this.issForecastTrailGeometryDirty = false;
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.issGlobeFreeOrbit = false;
    this.issCameraCenterSmoothPrevMs = 0;
    this.clearGeocodeMarker();
    if (this.earthMesh) {
      this.earthMesh.rotation.set(0, Math.PI, 0);
      this.cloudsDriftRad = 0;
    }
    if (this.cloudsMesh) {
      this.cloudsMesh.rotation.y = Math.PI + this.cloudsDriftRad;
    }
    if (this.isGlobeIssPositionKnown()) {
      const dist = THREE.MathUtils.clamp(
        this.globeOrbitDistance(),
        this.controls.minDistance,
        this.controls.maxDistance
      );
      this.animateCameraToLatLon(this.globeIssLat!, this.globeIssLon!, dist, GLOBE_RESET_VIEW_ANIM_MS, 0);
    } else {
      this.animateCameraToLatLon(
        GLOBE_INITIAL_FRANCE_LAT,
        GLOBE_INITIAL_FRANCE_LON,
        GLOBE_INITIAL_ORBIT_DISTANCE,
        GLOBE_RESET_VIEW_ANIM_MS,
        0.22
      );
    }
    if (this.issHistoricalTraceEnabled) {
      void this.loadIssHistoricalTrace();
    }
  }

  /**
   * Géocodage d’adresse / lieu (backend Nominatim), identique à la page Adresse / GPS.
   * Centre la caméra sur le lieu avec un vol fluide ; un seul résultat : animation directe ; plusieurs : liste cliquable.
   */
  /** Prochain passage ISS au-dessus du lieu (ville / pays) saisi dans le champ géocode. */
  searchIssPassOverPlace(candidateIndex?: number): void {
    const query = this.globePlaceQuery?.trim();
    if (!query) {
      this.issPassError = this.translate.instant('ADDRESS_GEOCODE.ADDRESS_REQUIRED');
      this.issPassCandidates = [];
      this.issPassSummary = null;
      this.cdr.markForCheck();
      return;
    }
    if (!this.globeSurfaceReady) {
      this.issPassError = this.translate.instant('WORLD_GLOBE.GEOCODE_GLOBE_NOT_READY');
      this.cdr.markForCheck();
      return;
    }
    this.issPassPlaceQueryCache = query;
    this.issPassError = '';
    if (candidateIndex == null) {
      this.issPassCandidates = [];
      this.issPassSummary = null;
    }
    this.issPassLoading = true;
    this.apiService
      .getIssPassesByPlace(query, 5, candidateIndex)
      .pipe(
        finalize(() => {
          this.issPassLoading = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (data: unknown) => {
          this.applyIssPassByPlaceResponse(data as IssPassByPlaceResponse, candidateIndex);
        },
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.issPassError = this.translate.instant('WORLD_GLOBE.ISS_PASS_ERROR') + ': ' + msg;
          this.issPassCandidates = [];
          this.issPassSummary = null;
          this.cdr.markForCheck();
        }
      });
  }

  selectIssPassCandidate(index: number): void {
    const c = this.issPassCandidates[index];
    if (!c) {
      return;
    }
    this.globePlaceQuery = c.displayName || this.issPassPlaceQueryCache;
    this.flyGlobeToGeocodeResult({
      lat: c.lat,
      lon: c.lon,
      displayName: c.displayName,
      boundingBox: null
    });
    this.searchIssPassOverPlace(index);
  }

  private applyIssPassByPlaceResponse(body: IssPassByPlaceResponse, candidateIndex?: number): void {
    const status = String(body?.status ?? '').toLowerCase();
    if (status === 'ambiguous' && Array.isArray(body.candidates) && body.candidates.length > 0) {
      this.issPassCandidates = body.candidates
        .map((c) => ({
          lat: typeof c.lat === 'number' ? c.lat : parseFloat(String(c.lat)),
          lon: typeof c.lon === 'number' ? c.lon : parseFloat(String(c.lon)),
          displayName: String(c.displayName ?? '').trim()
        }))
        .filter(
          (c) =>
            Number.isFinite(c.lat) &&
            Number.isFinite(c.lon) &&
            Math.abs(c.lat) <= 90 &&
            Math.abs(c.lon) <= 180
        );
      this.issPassSummary = null;
      this.globeGeocodeListActiveIndex = null;
      if (this.issPassCandidates.length === 0) {
        this.issPassError = this.translate.instant('ADDRESS_GEOCODE.NO_RESULTS');
      }
      this.cdr.markForCheck();
      return;
    }
    if (status !== 'success') {
      const code = body?.code ?? '';
      if (code === 'no_geocode_results') {
        this.issPassError = this.translate.instant('ADDRESS_GEOCODE.NO_RESULTS');
      } else if (code === 'no_passes') {
        this.issPassError = this.translate.instant('WORLD_GLOBE.ISS_PASS_NONE');
      } else {
        this.issPassError =
          body?.message?.trim() || this.translate.instant('WORLD_GLOBE.ISS_PASS_ERROR');
      }
      this.issPassCandidates = [];
      this.issPassSummary = null;
      this.cdr.markForCheck();
      return;
    }
    this.issPassCandidates = [];
    const place = body.place;
    const placeLabel =
      place?.displayName?.trim() ||
      (place?.lat != null && place?.lon != null
        ? `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`
        : '');
    const parsed = this.extractIssPassLines(body);
    if (parsed.lines.length === 0) {
      this.issPassError = parsed.error || this.translate.instant('WORLD_GLOBE.ISS_PASS_NONE');
      this.issPassSummary = null;
      this.cdr.markForCheck();
      return;
    }
    this.issPassError = '';
    const lat = place?.lat;
    const lon = place?.lon;
    const coordsLine =
      lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)
        ? this.translate.instant('WORLD_GLOBE.ISS_PASS_COORDS_USED', {
            lat: lat.toFixed(5),
            lon: lon.toFixed(5)
          })
        : '';
    this.issPassSummary = {
      placeLabel,
      coordsLine,
      nextPassLine: parsed.lines[0],
      upcomingLines: parsed.lines
    };
    if (lat != null && lon != null) {
      this.flyGlobeToGeocodeResult({
        lat,
        lon,
        displayName: placeLabel,
        boundingBox: null
      });
    }
    this.cdr.markForCheck();
  }

  private static readonly ISS_PASS_COMPASS_16 = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'
  ];

  private formatIssPassLine(pass: IssPassSummaryItem): string | null {
    const t = typeof pass.risetime === 'number' ? pass.risetime : parseInt(String(pass.risetime ?? ''), 10);
    if (!Number.isFinite(t) || t <= 0) {
      return null;
    }
    const when = new Date(t * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
    const dur = typeof pass.duration === 'number' ? pass.duration : parseInt(String(pass.duration ?? ''), 10);
    const minutes = Number.isFinite(dur) && dur > 0 ? Math.max(1, Math.round(dur / 60)) : null;
    const lookout = this.formatIssPassLookout(pass);
    if (minutes != null) {
      if (lookout) {
        return this.translate.instant('WORLD_GLOBE.ISS_PASS_LINE', { datetime: when, minutes, lookout });
      }
      return this.translate.instant('WORLD_GLOBE.ISS_PASS_LINE_NO_LOOKOUT', { datetime: when, minutes });
    }
    if (lookout) {
      return this.translate.instant('WORLD_GLOBE.ISS_PASS_LINE_NO_DURATION', { datetime: when, lookout });
    }
    return this.translate.instant('WORLD_GLOBE.ISS_PASS_LINE_NO_DURATION_NO_LOOKOUT', { datetime: when });
  }

  private formatIssPassLookout(pass: IssPassSummaryItem): string {
    const azMax = WorldGlobeComponent.issPassAzimuthAtMax(pass.riseAzimuth, pass.setAzimuth);
    const elevMax = pass.maxElevation;
    const hasDir = Number.isFinite(azMax);
    const hasElev = typeof elevMax === 'number' && Number.isFinite(elevMax);
    if (!hasDir && !hasElev) {
      return '';
    }
    const parts: string[] = [];
    if (hasDir) {
      parts.push(
        this.translate.instant('WORLD_GLOBE.ISS_PASS_LOOKOUT_DIR', {
          direction: WorldGlobeComponent.issPassDirectionFromAzimuth(azMax),
          azimuth: Math.round(azMax)
        })
      );
    }
    if (hasElev) {
      parts.push(
        this.translate.instant('WORLD_GLOBE.ISS_PASS_LOOKOUT_ELEV', {
          elevation: Math.round(elevMax)
        })
      );
    }
    return parts.join(', ');
  }

  private static issPassAzimuthAtMax(riseAz?: number, setAz?: number): number {
    const a = typeof riseAz === 'number' && Number.isFinite(riseAz) ? riseAz : NaN;
    const b = typeof setAz === 'number' && Number.isFinite(setAz) ? setAz : NaN;
    if (Number.isNaN(a)) {
      return b;
    }
    if (Number.isNaN(b)) {
      return a;
    }
    const ar = (a * Math.PI) / 180;
    const br = (b * Math.PI) / 180;
    const x = Math.cos(ar) + Math.cos(br);
    const y = Math.sin(ar) + Math.sin(br);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  private static issPassDirectionFromAzimuth(azimuthDeg: number): string {
    const a = ((azimuthDeg % 360) + 360) % 360;
    const idx = Math.round(a / 22.5) % 16;
    return WorldGlobeComponent.ISS_PASS_COMPASS_16[idx];
  }

  searchGlobePlace(): void {
    const query = this.globePlaceQuery?.trim();
    if (!query) {
      this.globeGeocodeError = this.translate.instant('ADDRESS_GEOCODE.ADDRESS_REQUIRED');
      this.globeGeocodeResults = [];
      this.globeGeocodeListActiveIndex = null;
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
    this.globeGeocodeListActiveIndex = null;
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
          this.globeGeocodeListActiveIndex = null;
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
          this.globeGeocodeListActiveIndex = null;
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
    this.disableIssKeepEarthCenteredForPlaceFocus();
    this.globeGeocodeMarkerLat = result.lat;
    this.globeGeocodeMarkerLon = result.lon;
    this.ensureGeocodeMarkerMesh();
    this.updateGeocodeMarkerWorldPosition();
    this.globePickedLat = result.lat;
    this.globePickedLon = result.lon;
    this.globeGeocodeResults = [];
    this.globeGeocodeListActiveIndex = null;
    this.globeGeocodeError = '';
    this.cdr.markForCheck();
  }

  /** Champ lieu : Entrée = recherche passage ISS ; flèches / Échap si plusieurs lieux ISS. */
  onGlobeGeocodeInputKeydown(ev: KeyboardEvent): void {
    const down = ev.key === 'ArrowDown' || ev.code === 'ArrowDown';
    const up = ev.key === 'ArrowUp' || ev.code === 'ArrowUp';
    const n = this.issPassCandidates.length;
    if (n > 1) {
      if (down) {
        ev.preventDefault();
        ev.stopPropagation();
        const next =
          this.globeGeocodeListActiveIndex == null
            ? 0
            : Math.min(this.globeGeocodeListActiveIndex + 1, n - 1);
        this.globeGeocodeListActiveIndex = next;
        this.scrollIssPassHighlightIntoView();
        this.cdr.markForCheck();
        return;
      }
      if (up) {
        ev.preventDefault();
        ev.stopPropagation();
        const prev =
          this.globeGeocodeListActiveIndex == null
            ? n - 1
            : Math.max(this.globeGeocodeListActiveIndex - 1, 0);
        this.globeGeocodeListActiveIndex = prev;
        this.scrollIssPassHighlightIntoView();
        this.cdr.markForCheck();
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        const idx = this.globeGeocodeListActiveIndex ?? 0;
        this.selectIssPassCandidate(idx);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this.issPassCandidates = [];
        this.globeGeocodeListActiveIndex = null;
        this.cdr.markForCheck();
        return;
      }
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.searchIssPassOverPlace();
    }
  }

  private scrollIssPassHighlightIntoView(): void {
    const i = this.globeGeocodeListActiveIndex;
    if (i == null) {
      return;
    }
    queueMicrotask(() => {
      document.getElementById(`wg-iss-pass-opt-${i}`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  @HostListener('document:keydown.escape')
  onSatelliteInfoEscape(): void {
    if (this.satelliteInfoSlideshowOpen) {
      return;
    }
    if (this.satelliteInfoOpen) {
      this.closeSatelliteInfo();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onGlobeGeocodeDocumentKeydown(ev: KeyboardEvent): void {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || t.id !== 'wgGlobePlace' || t.disabled) {
      return;
    }
    this.onGlobeGeocodeInputKeydown(ev);
  }

  /**
   * Trace viewer → navigation avec `?lat=&lon=&z=` : applique le vol quand la Terre est prête,
   * puis retire les paramètres de l’URL.
   */
  private queueOrApplyGlobeDeepLink(payload: { lat: number; lon: number; mapZoom?: number }): void {
    if (!Number.isFinite(payload.lat) || !Number.isFinite(payload.lon)) {
      return;
    }
    if (this.globeSurfaceReady && this.camera && this.controls && this.earthMesh) {
      this.executeGlobeDeepLinkFly(payload);
      this.clearGlobeDeepLinkQueryParams();
    } else {
      this.pendingGlobeDeepLink = payload;
    }
  }

  private tryFlushPendingGlobeDeepLink(): void {
    if (this.pendingDeepLinkSatId && !this.pendingGlobeDeepLink) {
      this.applyPendingSatelliteDeepLink();
    }
    if (!this.pendingGlobeDeepLink || !this.globeSurfaceReady || !this.camera || !this.controls || !this.earthMesh) {
      return;
    }
    const p = this.pendingGlobeDeepLink;
    this.pendingGlobeDeepLink = null;
    this.executeGlobeDeepLinkFly(p);
    this.clearGlobeDeepLinkQueryParams();
  }

  /** Viseur d’astres → globe : `?sat=iss` ou `?sat=hubble`. */
  private queueOrApplySatelliteDeepLink(satId: string): void {
    const id = satId.trim().toLowerCase();
    if (!id) {
      return;
    }
    if (id !== 'iss' && !this.globeSatelliteOptions.some((s) => s.id === id)) {
      return;
    }
    this.pendingDeepLinkSatId = id;
    this.pendingCenterFitWholeGlobe = true;
    this.applyPendingSatelliteDeepLink();
    this.clearGlobeDeepLinkQueryParams();
  }

  private applyPendingSatelliteDeepLink(): void {
    const id = this.pendingDeepLinkSatId;
    if (!id) {
      return;
    }
    this.autoRotate = false;
    if (id === 'iss') {
      this.issOverlayEnabled = true;
      this.issKeepEarthCentered = true;
      this.issTickerEnabled = true;
      this.tickerFocusSatId = null;
      this.pendingCenterSatelliteId = null;
      this.rememberAstroViseurSat('iss');
      this.clearGeocodeMarker();
      const alreadyFramed = this.globeSurfaceReady && !this.globeInitialIssCameraPending;
      if (!alreadyFramed) {
        this.issGlobeFreeOrbit = false;
        this.globeInitialIssCameraPending = true;
        if (this.globeSurfaceReady && this.globeIssLat != null && this.globeIssLon != null) {
          this.applyInitialIssCameraCenterIfNeeded(this.globeIssLat, this.globeIssLon, false);
        }
      }
      if (this.satelliteDeepLinkPrefsReady()) {
        this.pendingDeepLinkSatId = null;
      }
      this.pushTickerUiSnapshot();
      this.scheduleWorldGlobeCdr();
      return;
    }
    const sat = this.globeSatelliteOptions.find((s) => s.id === id);
    if (!sat) {
      this.pendingDeepLinkSatId = null;
      return;
    }
    this.issKeepEarthCentered = false;
    this.issGlobeFreeOrbit = true;
    this.globeInitialIssCameraPending = false;
    this.globeSatVisibilityCircleSatId = id;
    if (this.satelliteOverlayEnabled[id] === false) {
      this.satelliteOverlayEnabled[id] = true;
      this.syncGlobeSatelliteOverlayMaster();
      this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
      void this.satNowService.ensureOption(sat);
    }
    this.onSelectSatelliteForTicker(id, true);
    this.pendingCenterSatelliteId = id;
    if (this.globeSurfaceReady) {
      this.tryCenterGlobeOnSatellite(id);
    }
    if (this.satelliteDeepLinkPrefsReady()) {
      this.pendingDeepLinkSatId = null;
    }
    this.pushTickerUiSnapshot();
    this.scheduleWorldGlobeCdr();
  }

  private satelliteDeepLinkPrefsReady(): boolean {
    return this.issGlobalPrefsLoaded && this.satelliteOverlayPrefsLoaded;
  }

  private writeAstroReturnSat(satId: string): void {
    const id = (satId || '').trim().toLowerCase();
    if (!id) {
      return;
    }
    try {
      sessionStorage.setItem(GLOBE_ASTRO_RETURN_SAT_KEY, id);
    } catch {
      /* ignore */
    }
  }

  private clearAstroReturnSat(): void {
    try {
      sessionStorage.removeItem(GLOBE_ASTRO_RETURN_SAT_KEY);
    } catch {
      /* ignore */
    }
  }

  private consumeAstroReturnSatId(): string | null {
    try {
      const raw = (sessionStorage.getItem(GLOBE_ASTRO_RETURN_SAT_KEY) || '').trim().toLowerCase();
      sessionStorage.removeItem(GLOBE_ASTRO_RETURN_SAT_KEY);
      if (!raw) {
        return null;
      }
      if (raw === 'iss' || this.globeSatelliteOptions.some((s) => s.id === raw)) {
        return raw;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private executeGlobeDeepLinkFly(p: { lat: number; lon: number; mapZoom?: number }): void {
    this.globeInitialIssCameraPending = false;
    const minD = this.controls?.minDistance ?? 1.02;
    const maxD = this.controls?.maxDistance ?? 7;
    const dist =
      p.mapZoom != null
        ? THREE.MathUtils.clamp(
            WorldGlobeComponent.orbitDistanceFromLeafletZoom(p.mapZoom),
            minD + 0.02,
            maxD * 0.98
          )
        : GLOBE_GEOCODE_ORBIT_FALLBACK;
    this.animateCameraToLatLon(p.lat, p.lon, dist, GLOBE_GEOCODE_ANIM_MS, 0);
    this.globeGeocodeMarkerLat = p.lat;
    this.globeGeocodeMarkerLon = p.lon;
    this.ensureGeocodeMarkerMesh();
    this.updateGeocodeMarkerWorldPosition();
    this.globePickedLat = p.lat;
    this.globePickedLon = p.lon;
    this.globeGeocodeResults = [];
    this.globeGeocodeListActiveIndex = null;
    this.globeGeocodeError = '';
    this.cdr.markForCheck();
  }

  private clearGlobeDeepLinkQueryParams(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        lat: null,
        lon: null,
        lng: null,
        z: null,
        zoom: null,
        autoRotate: null,
        sat: null,
        satellite: null
      },
      replaceUrl: true
    });
  }

  /** Trace viewer et liens profonds : `autoRotate=0` / `ar=0` désactive la rotation avant init OrbitControls. */
  private applyDeepLinkAutoRotatePreference(params: ParamMap): void {
    const raw = params.get('autoRotate') ?? params.get('ar');
    if (raw == null || raw === '') {
      return;
    }
    const off = raw === '0' || raw === 'false';
    const on = raw === '1' || raw === 'true';
    if (!off && !on) {
      return;
    }
    this.autoRotate = on;
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
    const fsEl = this.getDocumentFullscreenElement();
    if (!fsEl) {
      this.setGlobeTrueFullscreenBodyClass(false);
      this.fullscreen = this.globeViewportLocked;
      return;
    }
    const inOurs = this.isGlobeFullscreenElement(fsEl);
    this.fullscreen = inOurs || this.globeViewportLocked;
    if (inOurs) {
      this.globeViewportLocked = false;
    } else {
      this.setGlobeTrueFullscreenBodyClass(false);
    }
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
      hemi.color.setHex(0xa8bce8);
      hemi.groundColor.setHex(0x010208);
      sun.color.setHex(0xfff0dc);
      this.applyGlobeLightingLevels(
        GLOBE_TERMINATOR_AMB_BASE,
        GLOBE_TERMINATOR_HEMI_BASE,
        GLOBE_TERMINATOR_SUN_BASE,
        GLOBE_TERMINATOR_EXPOSURE_BASE
      );
      this.updateSunDirectionFromTime(new Date());
      this.syncTerminatorNightOverlay();
      return;
    }

    if (this.globeLightingUniform) {
      amb.color.setHex(0xffffff);
      hemi.color.setHex(0xffffff);
      hemi.groundColor.setHex(0x6c7888);
      sun.color.setHex(0xffffff);
      sun.position.set(2.6, 4.2, 3);
      this.applyGlobeLightingLevels(1.0, 0.93, 0.3, 1.36);
      this.syncTerminatorNightOverlay();
      return;
    }

    amb.color.setHex(0xffffff);
    hemi.color.setHex(0x8899bb);
    hemi.groundColor.setHex(0x0c1018);
    this.applyGlobeLightingLevels(0.09, 0.11, 0, 1.06);
    this.syncTerminatorNightOverlay();
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
    const eq = Equator(Body.Sun, date, WorldGlobeComponent.SUN_EQUATOR_OBSERVER, true, true);
    const gst = SiderealTime(date);
    let lonDeg = (eq.ra - gst) * 15;
    while (lonDeg <= -180) {
      lonDeg += 360;
    }
    while (lonDeg > 180) {
      lonDeg -= 360;
    }
    const latDeg = eq.dec;
    earth.updateMatrixWorld(true);
    this.subsolarWorldScratch.copy(WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, 1));
    this.subsolarWorldScratch.applyMatrix4(earth.matrixWorld).normalize();
    const k = WorldGlobeComponent.SUN_LIGHT_DISTANCE;
    sun.position.copy(this.subsolarWorldScratch.multiplyScalar(k));
    sun.target.position.set(0, 0, 0);
    this.syncTerminatorNightOverlay();
  }

  /** Calque shader nuit : renforce le contraste du terminateur (suit la rotation Terre). */
  private attachTerminatorNightOverlay(earth: THREE.Mesh): void {
    if (this.terminatorNightOverlay) {
      return;
    }
    const geo = new THREE.SphereGeometry(GLOBE_TERMINATOR_NIGHT_RADIUS, 96, 96);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSunDir: this.terminatorSunDirUniform },
      vertexShader: `
        varying vec3 vWorldNormal;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldNormal;
        uniform vec3 uSunDir;
        void main() {
          float ndl = dot(normalize(vWorldNormal), normalize(uSunDir));
          float night = 1.0 - smoothstep(-0.02, 0.14, ndl);
          float twilight = smoothstep(-0.42, -0.04, ndl);
          vec3 col = mix(vec3(0.001, 0.002, 0.012), vec3(0.02, 0.035, 0.1), twilight);
          gl_FragColor = vec4(col, night * 0.94);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'wg-terminator-night';
    mesh.renderOrder = 2;
    mesh.visible = this.realTimeTerminator;
    earth.add(mesh);
    this.terminatorNightOverlay = mesh;
    this.syncTerminatorNightOverlay();
  }

  private syncTerminatorNightOverlay(): void {
    const mesh = this.terminatorNightOverlay;
    const sun = this.sunLight;
    if (!mesh) {
      return;
    }
    mesh.visible = this.realTimeTerminator;
    if (this.realTimeTerminator && sun) {
      this.terminatorSunDirUniform.value.copy(sun.position).normalize();
    }
  }

  private bootstrapThree(): void {
    const host = this.globeCanvasHost?.nativeElement;
    if (!host || host.clientWidth < 2 || host.clientHeight < 2) {
      this.zone.runOutsideAngular(() => {
        requestAnimationFrame(() => this.zone.run(() => this.bootstrapThree()));
      });
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
    canvasEl.addEventListener('pointerdown', this.onGlobePointerDown, { passive: true });
    canvasEl.addEventListener('pointerup', this.onGlobePointerUp, { passive: true });
    canvasEl.addEventListener('pointercancel', this.onGlobePointerCancel, { passive: true });
    canvasEl.addEventListener('pointermove', this.onGlobePointerMove, { passive: true });
    canvasEl.addEventListener('pointerleave', this.onGlobePointerLeave, { passive: true });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.rotateSpeed = GLOBE_ORBIT_ROTATE_SPEED_MAX;
    controls.zoomSpeed = GLOBE_ORBIT_ZOOM_SPEED_MAX;
    controls.panSpeed = GLOBE_ORBIT_PAN_SPEED_MAX;
    controls.minDistance = 1.02;
    controls.maxDistance = 7;
    controls.minPolarAngle = 0.04;
    controls.maxPolarAngle = Math.PI - 0.04;
    controls.screenSpacePanning = false;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN
    };
    controls.target.set(0, 0, 0);
    controls.addEventListener('start', this.onGlobeOrbitControlsStart);

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
    this.frameDefaultGlobeCamera();

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
      this.attachRotationAxisToEarth(earth);
      this.frameDefaultGlobeCamera();
      this.tryFlushPendingGlobeDeepLink();
      this.syncGlobeDecorationsAfterEarthReady();
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
        this.attachRotationAxisToEarth(earth);
        this.frameDefaultGlobeCamera();
        this.tryFlushPendingGlobeDeepLink();
        this.syncGlobeDecorationsAfterEarthReady();
      }
    );

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => {
        this.resizeRendererToHost();
        this.updateNonFsGlobeShift();
      });
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
    this.attachRotationAxisToEarth(earth);
    this.frameDefaultGlobeCamera();
    this.tryFlushPendingGlobeDeepLink();
    this.syncGlobeDecorationsAfterEarthReady();
  }
  private globePlanetTextureUrl(asset: 'atmos' | 'specular' | 'normal' | 'clouds'): string {
    return `${environment.API_URL}external/globe/texture/planets/${asset}`;
  }

  private globeSatelliteBmngUrl(): string {
    return `${environment.API_URL}external/globe/texture/satellite/bmng`;
  }

  private globeGibsViirsUrl(): string {
    return `${environment.API_URL}external/globe/overlay/gibs/viirs`;
  }

  private globeNe110BoundariesLandUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-110m-boundaries-land`;
  }

  private globeNe110CoastlineUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-110m-coastline`;
  }

  private globeNe110Admin0CountriesUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-110m-admin-0-countries`;
  }

  private globeNe110GeographicLinesUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-110m-geographic-lines`;
  }

  private globeNe50mRiversLakeCenterlinesUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-50m-rivers-lake-centerlines`;
  }

  private globeNe10mLakesUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-10m-lakes`;
  }

  private globeNe110GlaciatedAreasUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-110m-glaciated-areas`;
  }

  private globeNe110PopulatedPlacesSimpleUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-110m-populated-places-simple`;
  }

  private globeNe10mTimeZonesUrl(): string {
    return `${environment.API_URL}external/globe/geojson/ne-10m-time-zones`;
  }

  private globeIssNowUrl(): string {
    return `${environment.API_URL}external/globe/iss/now`;
  }

  private globeIssTraceUrl(): string {
    return `${environment.API_URL}external/globe/iss/trace`;
  }

  private globeIssForecastUrl(): string {
    return `${environment.API_URL}external/globe/iss/forecast`;
  }

  /** Après création Terre ou si l'utilisateur active une couche avant que le maillage soit prêt. */
  private syncGlobeDecorationsAfterEarthReady(): void {
    if (!this.globeSurfaceReady || !this.earthMesh || !this.scene) {
      return;
    }
    this.attachTerminatorNightOverlay(this.earthMesh);
    if (this.countryBordersEnabled) {
      void this.ensureCountryBordersLoaded();
    }
    if (this.coastlinesEnabled) {
      void this.ensureCoastlinesLoaded();
    }
    if (this.graticuleEnabled) {
      this.ensureGraticuleOverlayBuilt();
    }
    if (this.politicalMapEnabled || this.countryLabelsEnabled) {
      void this.ensureAdmin0CountryLayersLoadedAndBuilt();
    }
    if (this.geographicLinesEnabled) {
      void this.ensureGeographicLinesLoaded();
    }
    if (this.riversEnabled) {
      void this.ensureRiversLoaded();
    }
    if (this.lakesEnabled) {
      void this.ensureLakesLoaded();
    }
    if (this.glaciersEnabled) {
      void this.ensureGlaciersLoaded();
    }
    if (this.citiesEnabled) {
      void this.ensureCitiesLoaded();
    }
    if (this.timeZonesEnabled) {
      void this.ensureTimeZonesLoaded();
    }
    if (this.issPositionFeedActive()) {
      this.kickIssPositionRefreshOnce();
      if (this.issCountdownInterval == null) {
        this.startIssPolling();
      }
      const snap = this.buildIssSnapshotFromComponentState();
      if (snap) {
        this.syncIssOverlayFromSnapshot(snap);
      }
    }
    if (this.issHistoricalTraceEnabled) {
      if (this.issHistoricalTrailPoints.length >= 2) {
        this.rebuildIssHistoricalTrailGeometry();
      } else if (!this.issHistoricalTraceLoading) {
        void this.loadIssHistoricalTrace();
      }
    }
    if (this.weatherImageryEnabled) {
      this.ensureWeatherOverlayTexture();
    }
    if (this.flightTrackingActive) {
      this.syncFlightGlobeVisuals();
      if (this.flightLat == null && this.flightTrackedQuery != null) {
        void this.refreshFlightNow();
      }
    }
    this.updateGlobeSatelliteOverlays();
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

  /** Position sur sphère Y-haut ; cohérent avec texture équirectangular (Three.js planets). */
  private static latLonToVector3(latDeg: number, lonDeg: number, radius: number): THREE.Vector3 {
    const phi = ((90 - latDeg) * Math.PI) / 180;
    const theta = ((lonDeg + 180) * Math.PI) / 180;
    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    return new THREE.Vector3(x, y, z);
  }

  /** Connect consecutive historical trace points when the time gap is ≤ 90 min. */
  private static issHistoricalTracePointsConnect(
    a: { recordedAt?: string },
    b: { recordedAt?: string }
  ): boolean {
    const rawA = a.recordedAt?.trim();
    const rawB = b.recordedAt?.trim();
    if (!rawA || !rawB) {
      return true;
    }
    const tA = Date.parse(rawA);
    const tB = Date.parse(rawB);
    if (!Number.isFinite(tA) || !Number.isFinite(tB)) {
      return true;
    }
    return Math.abs(tB - tA) <= GLOBE_ISS_TRACE_MAX_SEGMENT_GAP_MS;
  }

  /** Distance orthodromique au sol (km) entre deux points ° (WGS84 sphère R≈6371 km). */
  private static haversineGreatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return R * c;
  }

  /** Point atteint depuis (lat, lon) après {@code distanceKm} km avec cap vrai {@code bearingDeg}. */
  private static destinationLatLon(
    latDeg: number,
    lonDeg: number,
    bearingDeg: number,
    distanceKm: number
  ): { lat: number; lon: number } {
    const R = GLOBE_EARTH_RADIUS_KM;
    const dRad = distanceKm / R;
    const lat1 = THREE.MathUtils.degToRad(latDeg);
    const lon1 = THREE.MathUtils.degToRad(lonDeg);
    const brng = THREE.MathUtils.degToRad(bearingDeg);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dRad) + Math.cos(lat1) * Math.sin(dRad) * Math.cos(brng)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(dRad) * Math.cos(lat1),
        Math.cos(dRad) - Math.sin(lat1) * Math.sin(lat2)
      );
    return {
      lat: THREE.MathUtils.radToDeg(lat2),
      lon: THREE.MathUtils.euclideanModulo(THREE.MathUtils.radToDeg(lon2) + 180, 360) - 180
    };
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
    this.zone.runOutsideAngular(() => {
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
        this.syncGlobeControlsSensitivity();
        this.syncGlobeOrbitAutoRotate(controls);
        const flightEarthCentered = this.isFlightEarthCenteredTrackingActive();
        const issEarthCentered = this.isIssEarthCenteredTrackingActive();
        controls.update();
        if (flightEarthCentered && !this.flightGlobeFreeOrbit) {
          this.applyFlightEarthCenteredCameraIfNeeded();
        } else if (issEarthCentered && !this.issGlobeFreeOrbit) {
          this.applyIssEarthCenteredCameraIfNeeded();
        }
        this.syncIssForecastTrailGeometryIfDirty();
        this.updateGlobeSatelliteOverlays();
        this.updateCountryLabelsScaleForZoom();
        renderer.render(scene, camera);
      };
      this.rafId = requestAnimationFrame(loop);
    });
  }

  private stopLoop(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private disposeEarthRotationAxisGroup(): void {
    const g = this.earthRotationAxisGroup;
    if (!g) {
      return;
    }
    g.parent?.remove(g);
    g.traverse((o) => {
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) {
          m.forEach((x) => x.dispose());
        } else if (m instanceof THREE.Material) {
          m.dispose();
        }
      }
    });
    this.earthRotationAxisGroup = undefined;
  }

  /**
   * Ligne le long de l’axe local Y du maillage Terre (pôles ≈ axe de rotation sidéral).
   */
  private attachRotationAxisToEarth(earth: THREE.Mesh): void {
    this.disposeEarthRotationAxisGroup();
    const len = 1.34;
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -len, 0),
      new THREE.Vector3(0, len, 0)
    ]);
    const mat = new THREE.LineDashedMaterial({
      color: 0xffe033,
      transparent: true,
      opacity: 0.95,
      dashSize: 0.03,
      gapSize: 0.022
    });
    const line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    const group = new THREE.Group();
    group.name = 'EarthRotationAxis';
    group.add(line);
    group.visible = this.showEarthRotationAxis;
    earth.add(group);
    this.earthRotationAxisGroup = group;
  }

  private stopIssPolling(): void {
    if (this.issRefreshTimeout != null) {
      clearTimeout(this.issRefreshTimeout);
      this.issRefreshTimeout = null;
    }
    if (this.issCountdownInterval != null) {
      clearInterval(this.issCountdownInterval);
      this.issCountdownInterval = null;
    }
    this.issNextRefreshEpochMs = 0;
    this.refreshIssPollingUiSnapshot();
  }

  private startIssPolling(): void {
    this.stopIssPolling();
    if (!this.issPositionFeedActive()) {
      return;
    }
    this.refreshIssPollingUiSnapshot(true);
    this.issCountdownInterval = window.setInterval(() => {
      this.refreshIssPollingUiSnapshot();
    }, 1000);
    this.scheduleIssRefreshChain(this.issPollIntervalMs());
    queueMicrotask(() => this.refreshIssPollingUiSnapshot(true));
  }

  private scheduleIssRefreshChain(delayMs: number): void {
    if (this.issRefreshTimeout != null) {
      clearTimeout(this.issRefreshTimeout);
      this.issRefreshTimeout = null;
    }
    const fireAt = Date.now() + delayMs;
    this.issNextRefreshEpochMs = fireAt;
    this.refreshIssPollingUiSnapshot();

    this.issRefreshTimeout = window.setTimeout(() => {
      this.issRefreshTimeout = null;
      if (!this.issPositionFeedActive()) {
        return;
      }
      const ms = this.issPollIntervalMs();
      void this.refreshIssNow();
      this.scheduleIssRefreshChain(ms);
    }, delayMs);
  }

  /** Met à jour le décompte ISS et l’horloge du bandeau ; CDR uniquement si l’affichage change. */
  private refreshIssPollingUiSnapshot(force = false): void {
    let countdownChanged = false;
    let next = 0;
    if (this.issOverlayEnabled && this.issNextRefreshEpochMs > 0) {
      next = Math.max(0, Math.ceil((this.issNextRefreshEpochMs - Date.now()) / 1000));
    }
    if (next !== this.issSecondsUntilNextRefresh) {
      countdownChanged = true;
    }

    let nowLabelChanged = false;
    if (this.issTickerEnabled) {
      const nowMs = Date.now();
      this.clockNowMs = nowMs;
      const label = this.formatDateTimeLabel(nowMs);
      if (label !== this.issTickerNowLabel) {
        this.issTickerNowLabel = label;
        nowLabelChanged = true;
      }
    }

    if (countdownChanged) {
      this.issSecondsUntilNextRefresh = next;
    }

    if (!force && !countdownChanged && !nowLabelChanged) {
      return;
    }

    this.scheduleWorldGlobeCdr();
  }

  private buildIssSnapshotFromComponentState(): GlobeIssNowSnapshot | null {
    const cached = this.issNowService.getSnapshot();
    if (cached) {
      return cached;
    }
    if (!this.isGlobeIssPositionKnown()) {
      return null;
    }
    return {
      lat: this.globeIssLat!,
      lon: this.globeIssLon!,
      altKm: this.globeIssAltKm,
      velocityKmh: this.issGroundSpeedKmh,
      fetchedAtMs: Date.now()
    };
  }

  private kickIssPositionRefreshOnce(): void {
    if (this.issBootstrapRefreshStarted || !this.issPositionFeedActive()) {
      return;
    }
    this.issBootstrapRefreshStarted = true;
    void this.refreshIssNow();
  }

  private async refreshIssNow(): Promise<void> {
    if (!this.issPositionFeedActive()) {
      return;
    }
    const seq = ++this.issRefreshRequestSeq;
    const hadPosition = this.isGlobeIssPositionKnown();
    try {
      const snap = await this.issNowService.refresh(true);
      if (seq !== this.issRefreshRequestSeq || !snap) {
        if (seq === this.issRefreshRequestSeq && !snap && !hadPosition) {
          this.scheduleWorldGlobeCdr(() => {
            if (this.issOverlayEnabled) {
              this.issOverlayFailed = true;
            }
          });
        }
        return;
      }
      const lat = snap.lat;
      const lon = snap.lon;
      if (!this.issPositionFeedActive()) {
        return;
      }
      const instantCamera = false;
      this.applyIssNowSnapshot(snap, instantCamera);

      const altKm = snap.altKm;
      const apiVelKmh = snap.velocityKmh;
      const now = Date.now();
      const prevSampleLat = this.issSpeedSampleLat;
      const prevSampleLon = this.issSpeedSampleLon;
      let lastStepGroundKm: number | null = null;
      if (prevSampleLat != null && prevSampleLon != null) {
        lastStepGroundKm = WorldGlobeComponent.haversineGreatCircleKm(
          prevSampleLat,
          prevSampleLon,
          lat,
          lon
        );
      }
      let groundSpeedKmh = this.issGroundSpeedKmh;
      if (apiVelKmh != null) {
        groundSpeedKmh = apiVelKmh;
      } else if (
        this.issSpeedSampleLat != null &&
        this.issSpeedSampleLon != null &&
        this.issSpeedSampleEpochMs > 0
      ) {
        const dtRaw = (now - this.issSpeedSampleEpochMs) / 1000;
        if (dtRaw >= 0.35 && dtRaw <= 180) {
          const dKm = WorldGlobeComponent.haversineGreatCircleKm(
            this.issSpeedSampleLat,
            this.issSpeedSampleLon,
            lat,
            lon
          );
          const vKmh = (dKm / dtRaw) * 3600;
          if (Number.isFinite(vKmh) && vKmh >= 1500 && vKmh <= 42000) {
            groundSpeedKmh = vKmh;
          }
        }
      }

      if (this.issOverlayEnabled && this.scene && this.earthMesh) {
        this.ensureIssMarkerMesh();
        this.updateIssMarkerWorldPosition(lat, lon, prevSampleLat, prevSampleLon);
        this.updateIssVisibilityCircle(lat, lon, altKm);
        this.recordIssTrailSample(lat, lon);
        // Réaligne sur le dernier segment de traînée (cohérent avec la polyligne affichée).
        this.updateIssMarkerWorldPosition(lat, lon);
        this.persistIssTraceSample(lat, lon);
        this.maybeRefreshIssForecastTrail(lat, lon, prevSampleLat, prevSampleLon, groundSpeedKmh);
        if (this.issTraceVisible && this.issForecastTrailPoints.length > 0) {
          this.markIssForecastTrailGeometryDirty();
        }
      }

      this.issSpeedSampleLat = lat;
      this.issSpeedSampleLon = lon;
      this.issSpeedSampleEpochMs = now;

      const overlayFailed = false;
      this.scheduleWorldGlobeCdr(() => {
        this.globeIssAltKm = altKm;
        this.issGroundSpeedKmh = groundSpeedKmh;
        this.issLastStepGroundKm = lastStepGroundKm;
        if (this.issOverlayEnabled) {
          this.issOverlayFailed = overlayFailed;
        }
      });
      if (!this.tickerFocusSatId) {
        this.maybeUpdateIssOverPlace(lat, lon);
      }
    } catch {
      if (seq !== this.issRefreshRequestSeq) {
        return;
      }
      if (this.issOverlayEnabled) {
        this.scheduleWorldGlobeCdr(() => {
          this.issOverlayFailed = true;
        });
      }
    }
  }

  /**
   * Résout le pays (ou océan) survolé par l’ISS via reverse-geocoding, en throttlant les appels
   * (intervalle mini + déplacement mini) pour rester respectueux de Nominatim. Sans pays renvoyé,
   * on considère que l’ISS est au-dessus de l’océan / d’eaux internationales.
   */
  private maybeUpdateIssOverPlace(lat: number, lon: number): void {
    if (this.issOverLookupInFlight) {
      return;
    }
    const now = Date.now();
    const firstLookup = this.issOverLookupLat == null || this.issOverLookupLon == null;
    if (!firstLookup) {
      const elapsed = now - this.issOverLookupAtMs;
      const movedDeg = Math.max(
        Math.abs(lat - (this.issOverLookupLat as number)),
        Math.abs(lon - (this.issOverLookupLon as number))
      );
      if (elapsed < GLOBE_ISS_OVER_MIN_INTERVAL_MS && movedDeg < GLOBE_ISS_OVER_MIN_MOVE_DEG) {
        return;
      }
    }
    this.issOverLookupInFlight = true;
    this.issOverLookupLat = lat;
    this.issOverLookupLon = lon;
    this.issOverLookupAtMs = now;
    this.apiService
      .geocodeReverse(lat, lon)
      .pipe(timeout(8000))
      .subscribe({
        next: (res: any) => {
          const addr = res?.address ?? null;
          const country =
            addr && typeof addr.country === 'string' && addr.country.trim().length > 0
              ? addr.country.trim()
              : null;
          const code =
            addr && typeof addr.country_code === 'string' && addr.country_code.trim().length > 0
              ? addr.country_code.trim().toLowerCase()
              : null;
          this.scheduleWorldGlobeCdr(() => {
            const label = country || this.translate.instant('WORLD_GLOBE.ISS_OVER_OCEAN');
            const countryCode = country ? code : null;
            if (this.tickerFocusSatId) {
              this.satTickerOverPlaceLabel = label;
              this.satTickerOverPlaceCountryCode = countryCode;
            } else {
              this.issOverPlaceLabel = label;
              this.issOverPlaceCountryCode = countryCode;
            }
          });
          this.issOverLookupInFlight = false;
        },
        error: () => {
          this.issOverLookupInFlight = false;
        }
      });
  }

  /** Emoji drapeau (regional indicators) à partir d’un code pays ISO 3166-1 alpha-2. */
  issOverFlagEmoji(): string {
    return this.flagEmojiFromCountryCode(this.issOverPlaceCountryCode);
  }

  private flagEmojiFromCountryCode(code: string | null | undefined): string {
    if (!code || code.length !== 2) {
      return '';
    }
    const base = 0x1f1e6;
    const a = code.toUpperCase().charCodeAt(0) - 65;
    const b = code.toUpperCase().charCodeAt(1) - 65;
    if (a < 0 || a > 25 || b < 0 || b > 25) {
      return '';
    }
    return String.fromCodePoint(base + a) + String.fromCodePoint(base + b);
  }

  private ensureIssMarkerMesh(): void {
    const earth = this.earthMesh;
    if (!earth || this.issMarkerMesh) {
      return;
    }
    const mesh = WorldGlobeComponent.createIssIconMesh();
    earth.add(mesh);
    this.issMarkerMesh = mesh;
  }

  /**
   * Segment de traînée utilisé pour orienter l’icône ISS (panneaux ⊥ trajectoire).
   * Priorité : relevé précédent du poll → dernier segment de la traînée live.
   */
  private resolveIssTrailSegment(
    lat: number,
    lon: number,
    explicitPrevLat?: number | null,
    explicitPrevLon?: number | null
  ): { fromLat: number; fromLon: number; toLat: number; toLon: number } | null {
    const pts = this.issTrailPoints;
    if (
      explicitPrevLat != null &&
      explicitPrevLon != null &&
      (Math.abs(explicitPrevLat - lat) > 1e-7 || Math.abs(explicitPrevLon - lon) > 1e-7)
    ) {
      return {
        fromLat: explicitPrevLat,
        fromLon: explicitPrevLon,
        toLat: lat,
        toLon: lon
      };
    }
    if (pts.length >= 2) {
      const to = pts[pts.length - 1];
      const from = pts[pts.length - 2];
      if (Math.abs(to.lat - lat) < 2e-5 && Math.abs(to.lon - lon) < 2e-5) {
        return { fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon };
      }
      return { fromLat: to.lat, fromLon: to.lon, toLat: lat, toLon: lon };
    }
    if (pts.length === 1) {
      const from = pts[0];
      if (Math.abs(from.lat - lat) > 1e-7 || Math.abs(from.lon - lon) > 1e-7) {
        return { fromLat: from.lat, fromLon: from.lon, toLat: lat, toLon: lon };
      }
    }
    const hist = this.issHistoricalTrailPoints;
    if (hist.length >= 2) {
      const last = hist[hist.length - 1];
      const prev = hist[hist.length - 2];
      if (Math.abs(last.lat - lat) > 1e-7 || Math.abs(last.lon - lon) > 1e-7) {
        return { fromLat: last.lat, fromLon: last.lon, toLat: lat, toLon: lon };
      }
      return { fromLat: prev.lat, fromLon: prev.lon, toLat: last.lat, toLon: last.lon };
    }
    return null;
  }

  private updateIssMarkerWorldPosition(
    lat?: number,
    lon?: number,
    prevLat?: number | null,
    prevLon?: number | null
  ): void {
    const la = lat ?? this.globeIssLat;
    const lo = lon ?? this.globeIssLon;
    const mesh = this.issMarkerMesh;
    if (la == null || lo == null || !mesh) {
      return;
    }
    const segment = this.resolveIssTrailSegment(la, lo, prevLat, prevLon);
    if (
      segment &&
      WorldGlobeComponent.orientIssIconMesh(
        mesh,
        segment.toLat,
        segment.toLon,
        segment.fromLat,
        segment.fromLon,
        GLOBE_ISS_ORBIT_RADIUS
      )
    ) {
      this.issTrackDeg = WorldGlobeComponent.tangentHeadingDegAtLatLon(
        segment.toLat,
        segment.toLon,
        segment.fromLat,
        segment.fromLon
      );
      return;
    }
    WorldGlobeComponent.orientGlobeIconMesh(mesh, la, lo, GLOBE_ISS_ORBIT_RADIUS, this.issTrackDeg);
  }

  private disposeIssMarkerMesh(): void {
    const mesh = this.issMarkerMesh;
    if (!mesh) {
      return;
    }
    this.earthMesh?.remove(mesh);
    WorldGlobeComponent.disposeIconPlaneMesh(mesh);
    this.issMarkerMesh = undefined;
  }

  private prefetchGlobeSatelliteTles(): void {
    this.satNowService.prefetch(
      this.globeSatelliteOptions.filter(satelliteUsesNetworkTle).map((s) => s.noradId)
    );
  }

  private loadGlobeSatelliteOverlayPrefs(): void {
    this.applyGlobeSatelliteOverlayPrefs(this.readGlobeSatelliteOverlayLocalCache());
    this.apiService.getSatelliteOverlays().subscribe({
      next: (prefs) => {
        if (!this.satelliteOverlayPrefsTouched && prefs) {
          this.applyGlobeSatelliteOverlayPrefs(prefs);
          this.writeGlobeSatelliteOverlayLocalCache();
        }
        this.satelliteOverlayPrefsLoaded = true;
        this.applyPendingSatelliteDeepLink();
        this.updateGlobeSatelliteOverlays();
        this.cdr.markForCheck();
      },
      error: () => {
        this.satelliteOverlayPrefsLoaded = true;
        this.applyPendingSatelliteDeepLink();
        this.cdr.markForCheck();
      }
    });
  }

  private applyGlobeSatelliteOverlayPrefs(prefs: GlobeSatelliteOverlayPrefs | null | undefined): void {
    if (!prefs) {
      return;
    }
    if (prefs.enabled) {
      for (const sat of this.globeSatelliteOptions) {
        if (typeof prefs.enabled[sat.id] === 'boolean') {
          this.satelliteOverlayEnabled[sat.id] = prefs.enabled[sat.id];
        }
      }
    }
    const byId = prefs.futureTraceEnabledById;
    const hasById = !!byId && typeof byId === 'object' && Object.keys(byId).length > 0;
    if (hasById) {
      for (const sat of this.globeSatelliteOptions) {
        if (typeof byId[sat.id] === 'boolean') {
          this.satelliteFutureTraceById[sat.id] = byId[sat.id];
        }
      }
    } else if (typeof prefs.futureTraceEnabled === 'boolean') {
      for (const sat of this.globeSatelliteOptions) {
        this.satelliteFutureTraceById[sat.id] = prefs.futureTraceEnabled;
      }
    }
    this.syncGlobeSatelliteOverlayMaster();
    this.syncGlobeSatelliteFutureTraceMaster();
    this.syncTickerFocusToEnabledSatellites();
    if (typeof prefs.futureTraceMinutes === 'number') {
      this.satelliteFutureTraceMinutes = WorldGlobeComponent.clampSatelliteFutureTraceMinutes(
        prefs.futureTraceMinutes
      );
    }
    this.satelliteFutureTraceHours = WorldGlobeComponent.hoursFromTraceMinutes(
      this.satelliteFutureTraceMinutes
    );
    this.refreshIssForecastTrailForDuration();
  }

  private buildGlobeSatelliteOverlayPrefsPayload(): GlobeSatelliteOverlayPrefs {
    const enabled: Record<string, boolean> = {};
    const futureTraceEnabledById: Record<string, boolean> = {};
    let anyTrace = false;
    for (const sat of this.globeSatelliteOptions) {
      enabled[sat.id] = this.satelliteOverlayEnabled[sat.id] !== false;
      const traceOn = this.satelliteFutureTraceById[sat.id] === true;
      futureTraceEnabledById[sat.id] = traceOn;
      anyTrace = anyTrace || traceOn;
    }
    return {
      enabled,
      futureTraceEnabled: anyTrace,
      futureTraceMinutes: this.satelliteFutureTraceMinutes,
      futureTraceEnabledById
    };
  }

  private schedulePersistGlobeSatelliteOverlayPrefs(): void {
    this.writeGlobeSatelliteOverlayLocalCache();
    if (this.satelliteOverlayPrefsSaveTimer != null) {
      clearTimeout(this.satelliteOverlayPrefsSaveTimer);
    }
    this.satelliteOverlayPrefsSaveTimer = setTimeout(() => {
      this.satelliteOverlayPrefsSaveTimer = null;
      this.apiService.setSatelliteOverlays(this.buildGlobeSatelliteOverlayPrefsPayload()).subscribe({
        error: () => {}
      });
    }, 400);
  }

  private readGlobeSatelliteOverlayLocalCache(): GlobeSatelliteOverlayPrefs | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(GLOBE_SAT_OVERLAY_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const enabledRaw = parsed['enabled'];
      const source =
        enabledRaw && typeof enabledRaw === 'object'
          ? (enabledRaw as Record<string, unknown>)
          : parsed;
      const enabled: Record<string, boolean> = {};
      for (const sat of this.globeSatelliteOptions) {
        if (typeof source[sat.id] === 'boolean') {
          enabled[sat.id] = source[sat.id] as boolean;
        }
      }
      const tracesRaw = parsed['futureTraceEnabledById'];
      const tracesSource =
        tracesRaw && typeof tracesRaw === 'object'
          ? (tracesRaw as Record<string, unknown>)
          : null;
      const futureTraceEnabledById: Record<string, boolean> = {};
      if (tracesSource) {
        for (const sat of this.globeSatelliteOptions) {
          if (typeof tracesSource[sat.id] === 'boolean') {
            futureTraceEnabledById[sat.id] = tracesSource[sat.id] as boolean;
          }
        }
      }
      return {
        enabled,
        futureTraceEnabled:
          typeof parsed['futureTraceEnabled'] === 'boolean'
            ? (parsed['futureTraceEnabled'] as boolean)
            : undefined,
        futureTraceMinutes:
          typeof parsed['futureTraceMinutes'] === 'number'
            ? (parsed['futureTraceMinutes'] as number)
            : undefined,
        futureTraceEnabledById:
          tracesSource && Object.keys(futureTraceEnabledById).length > 0
            ? futureTraceEnabledById
            : undefined
      };
    } catch {
      return null;
    }
  }

  private writeGlobeSatelliteOverlayLocalCache(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(
        GLOBE_SAT_OVERLAY_STORAGE_KEY,
        JSON.stringify(this.buildGlobeSatelliteOverlayPrefsPayload())
      );
    } catch {
      /* quota / mode privé */
    }
  }

  private updateStarlinkTrainCompanions(enabled: boolean): void {
    const keep = new Set<string>();
    const sat = this.globeSatelliteOptions.find((s) => s.constellation === 'starlink');
    const pass = enabled ? this.satNowService.starlinkPass() : null;
    if (sat && pass) {
      for (const member of pass.members) {
        if (member.noradId === pass.lead.noradId) {
          continue;
        }
        const id = `starlink-m-${member.noradId}`;
        keep.add(id);
        this.ensureGlobeSatelliteVisual({ ...sat, id });
        this.positionGlobeSatelliteVisual(id, member.lat, member.lon, member.altKm, sat.defaultAltKm);
      }
    }
    for (const id of [...this.starlinkCompanionIds]) {
      if (!keep.has(id)) {
        this.disposeGlobeSatelliteVisual(id);
        this.starlinkCompanionIds.delete(id);
      }
    }
    for (const id of keep) {
      this.starlinkCompanionIds.add(id);
    }
  }

  private globeSatelliteOrbitRadius(altKm: number | null, fallbackKm: number): number {
    const alt = altKm != null && Number.isFinite(altKm) ? altKm : fallbackKm;
    if (alt >= 100_000) {
      return GLOBE_SAT_L2_DISPLAY_RADIUS;
    }
    const clamped = Math.min(GLOBE_SAT_MAX_ALT_KM, Math.max(GLOBE_SAT_MIN_ALT_KM, alt));
    const trueR = 1 + clamped / GLOBE_EARTH_RADIUS_KM;
    return Math.min(trueR, GLOBE_SAT_DISPLAY_RADIUS_MAX);
  }

  private updateGlobeSatelliteOverlays(): void {
    if (!this.earthMesh || !this.globeSurfaceReady) {
      return;
    }
    const now = Date.now();
    for (const sat of this.globeSatelliteOptions) {
      if (this.satelliteOverlayEnabled[sat.id] === false) {
        this.disposeGlobeSatelliteVisual(sat.id);
        if (sat.constellation === 'starlink') {
          this.updateStarlinkTrainCompanions(false);
        }
        continue;
      }
      this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
      const snap = this.satNowService.snapshotForOption(sat, now);
      if (!snap) {
        void this.satNowService.ensureOption(sat);
        continue;
      }
      this.ensureGlobeSatelliteVisual(sat);
      this.positionGlobeSatelliteVisual(sat.id, snap.lat, snap.lon, snap.altKm, sat.defaultAltKm);
      if (this.globeSatVisibilityCircleSatId === sat.id) {
        this.updateSatelliteVisibilityCircle(sat, snap.lat, snap.lon, snap.altKm ?? sat.defaultAltKm);
      }
      if (sat.constellation === 'starlink') {
        this.updateStarlinkTrainCompanions(true);
      }
      if (this.pendingCenterSatelliteId === sat.id) {
        this.tryCenterGlobeOnSatellite(sat.id);
      }
      if (this.tickerFocusSatId === sat.id) {
        this.applySatelliteTickerSnapshot(sat, snap);
      }
    }
    this.refreshSatelliteVisibilityFromUser();
    if (this.satelliteInfoOpen) {
      this.refreshSatelliteInfoSnapshot();
    }
    this.updateGlobeSatelliteForecastTrails(false);
  }

  private refreshTickerFromSatellite(satId: string): void {
    const sat = this.globeSatelliteOptions.find((s) => s.id === satId);
    if (!sat) {
      return;
    }
    this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
    const snap = this.satNowService.snapshotForOption(sat);
    if (!snap) {
      void this.satNowService.ensureOption(sat);
      return;
    }
    this.applySatelliteTickerSnapshot(sat, snap);
  }

  private applySatelliteTickerSnapshot(
    sat: AstroSatelliteOption,
    snap: { lat: number; lon: number; altKm: number | null; velocityKmh: number | null }
  ): void {
    const now = Date.now();
    let stepKm: number | null = this.satTickerStepKm;
    if (
      this.satTickerSampleLat != null &&
      this.satTickerSampleLon != null &&
      now - this.satTickerSampleAtMs >= 2000
    ) {
      const d = WorldGlobeComponent.haversineGreatCircleKm(
        this.satTickerSampleLat,
        this.satTickerSampleLon,
        snap.lat,
        snap.lon
      );
      if (Number.isFinite(d) && d > 0.05) {
        stepKm = d;
      }
      this.satTickerSampleLat = snap.lat;
      this.satTickerSampleLon = snap.lon;
      this.satTickerSampleAtMs = now;
    } else if (this.satTickerSampleLat == null) {
      this.satTickerSampleLat = snap.lat;
      this.satTickerSampleLon = snap.lon;
      this.satTickerSampleAtMs = now;
    }
    this.satTickerLat = snap.lat;
    this.satTickerLon = snap.lon;
    this.satTickerAltKm = snap.altKm ?? sat.defaultAltKm;
    this.satTickerSpeedKmh = snap.velocityKmh;
    this.satTickerStepKm = stepKm;
    this.maybeUpdateIssOverPlace(snap.lat, snap.lon);
    if (now - this.satTickerCdrAtMs >= 400) {
      this.satTickerCdrAtMs = now;
      this.scheduleWorldGlobeCdr();
    }
  }

  private requestUserObserverPosition(): void {
    this.positionService.getCurrentPosition().subscribe((pos) => {
      if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) {
        return;
      }
      if (Math.abs(pos.latitude) > 90 || Math.abs(pos.longitude) > 180) {
        return;
      }
      this.userObserverLat = pos.latitude;
      this.userObserverLon = pos.longitude;
      this.refreshSatelliteVisibilityFromUser();
      this.scheduleWorldGlobeCdr();
    });
  }

  private refreshSatelliteVisibilityFromUser(): void {
    const obsLat = this.userObserverLat;
    const obsLon = this.userObserverLon;
    if (obsLat == null || obsLon == null) {
      return;
    }
    const now = Date.now();
    let changed = false;
    for (const sat of this.globeSatelliteOptions) {
      this.satNowService.setObserver(obsLat, obsLon);
      const snap = this.satNowService.snapshotForOption(sat, now);
      if (!snap) {
        void this.satNowService.ensureOption(sat);
      }
      const visible =
        snap != null &&
        WorldGlobeComponent.satelliteElevationRadFromLatLon(
          obsLat,
          obsLon,
          snap.lat,
          snap.lon,
          snap.altKm ?? sat.defaultAltKm
        ) >
          0;
      if (this.satelliteVisibleFromUser[sat.id] !== visible) {
        this.satelliteVisibleFromUser[sat.id] = visible;
        changed = true;
      }
    }
    if (changed) {
      this.scheduleWorldGlobeCdr();
    }
    this.refreshIssVisibilityFromUser();
  }

  private refreshIssVisibilityFromUser(): void {
    const obsLat = this.userObserverLat;
    const obsLon = this.userObserverLon;
    const issLat = this.globeIssLat;
    const issLon = this.globeIssLon;
    if (obsLat == null || obsLon == null || issLat == null || issLon == null) {
      if (this.issVisibleFromUser) {
        this.issVisibleFromUser = false;
        this.scheduleWorldGlobeCdr();
      }
      return;
    }
    const visible =
      WorldGlobeComponent.satelliteElevationRadFromLatLon(
        obsLat,
        obsLon,
        issLat,
        issLon,
        this.globeIssAltKm ?? this.issGlobeOption.defaultAltKm
      ) > 0;
    if (this.issVisibleFromUser !== visible) {
      this.issVisibleFromUser = visible;
      this.scheduleWorldGlobeCdr();
    }
  }

  private tryCenterGlobeOnSatellite(satId: string): void {
    const sat = this.globeSatelliteOptions.find((s) => s.id === satId);
    const camera = this.camera;
    const controls = this.controls;
    if (!sat || !camera || !controls) {
      return;
    }
    this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
    const snap = this.satNowService.snapshotForOption(sat);
    if (!snap) {
      void this.satNowService.ensureOption(sat);
      return;
    }
    this.pendingCenterSatelliteId = null;
    this.issGlobeFreeOrbit = true;
    this.flightGlobeFreeOrbit = true;
    if (this.globeSatVisibilityCircleSatId === sat.id) {
      this.updateSatelliteVisibilityCircle(sat, snap.lat, snap.lon, snap.altKm ?? sat.defaultAltKm);
    }
    if (this.pendingCenterFitWholeGlobe) {
      this.pendingCenterFitWholeGlobe = false;
      this.flyCameraToAstroReturn(snap.lat, snap.lon);
      this.cdr.markForCheck();
      return;
    }
    const dist = THREE.MathUtils.clamp(
      this.globeOrbitDistance(),
      controls.minDistance,
      controls.maxDistance
    );
    this.animateCameraToLatLon(snap.lat, snap.lon, dist, GLOBE_RESET_VIEW_ANIM_MS, 0);
    this.cdr.markForCheck();
  }

  private async loadSatelliteInfoDetails(sat: AstroSatelliteOption): Promise<void> {
    if (this.userObserverLat == null || this.userObserverLon == null) {
      await firstValueFrom(this.positionService.getCurrentPosition())
        .then((pos) => {
          if (pos && Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude)) {
            this.userObserverLat = pos.latitude;
            this.userObserverLon = pos.longitude;
          }
        })
        .catch(() => undefined);
    }
    this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
    await this.satNowService.ensureOption(sat);
    if (this.satelliteInfoSat?.id !== sat.id) {
      return;
    }
    this.refreshSatelliteInfoSnapshot();
    this.satelliteInfoPasses = this.predictSatellitePassesFromUser(sat);
    this.satelliteInfoLoading = false;
    this.scheduleWorldGlobeCdr();
  }

  private refreshSatelliteInfoSnapshot(): void {
    const sat = this.satelliteInfoSat;
    if (!sat) {
      return;
    }
    this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
    let snap = this.satNowService.snapshotForOption(sat);
    if (sat.id === 'iss' && this.globeIssLat != null && this.globeIssLon != null) {
      snap = {
        noradId: sat.noradId,
        name: sat.id,
        lat: this.globeIssLat,
        lon: this.globeIssLon,
        altKm: this.globeIssAltKm ?? sat.defaultAltKm,
        velocityKmh: this.issGroundSpeedKmh,
        computedAtMs: Date.now()
      };
    }
    if (!snap) {
      this.satelliteInfoSnapshot = null;
      return;
    }
    const obsLat = this.userObserverLat;
    const obsLon = this.userObserverLon;
    const altKm = snap.altKm ?? sat.defaultAltKm;
    let azimuthDeg: number | null = null;
    let elevationDeg: number | null = null;
    let groundKm: number | null = null;
    let slantKm: number | null = null;
    let visible = false;
    if (obsLat != null && obsLon != null) {
      groundKm = WorldGlobeComponent.haversineGreatCircleKm(obsLat, obsLon, snap.lat, snap.lon);
      const elevRad = WorldGlobeComponent.satelliteElevationRadFromLatLon(
        obsLat,
        obsLon,
        snap.lat,
        snap.lon,
        altKm
      );
      elevationDeg = (elevRad * 180) / Math.PI;
      azimuthDeg = WorldGlobeComponent.initialBearingDeg(obsLat, obsLon, snap.lat, snap.lon);
      const gamma = groundKm / GLOBE_EARTH_RADIUS_KM;
      slantKm = WorldGlobeComponent.satelliteSlantRangeKmFromNadirCentralAngle(gamma, altKm);
      visible = elevationDeg > 0;
    }
    this.satelliteInfoSnapshot = {
      lat: snap.lat,
      lon: snap.lon,
      altKm,
      velocityKmh: snap.velocityKmh,
      azimuthDeg,
      elevationDeg,
      groundKm,
      slantKm,
      visible
    };
  }

  private predictSatellitePassesFromUser(sat: AstroSatelliteOption): GlobeSatellitePass[] {
    const obsLat = this.userObserverLat;
    const obsLon = this.userObserverLon;
    if (obsLat == null || obsLon == null) {
      return [];
    }
    const startMs = Date.now() - GLOBE_SAT_PASS_LOOKBACK_MS;
    const endMs = Date.now() + GLOBE_SAT_PASS_HORIZON_MS;
    const passes: GlobeSatellitePass[] = [];
    let riseMs: number | null = null;
    let maxEl = -90;
    let maxAtMs = startMs;
    let prevEl: number | null = null;
    let prevMs = startMs;
    for (let t = startMs; t <= endMs; t += GLOBE_SAT_PASS_STEP_MS) {
      const el = this.satelliteElevationDegAt(sat, obsLat, obsLon, t);
      if (el == null) {
        continue;
      }
      if (prevEl != null && prevEl <= 0 && el > 0) {
        riseMs = WorldGlobeComponent.interpolateHorizonCrossing(prevMs, prevEl, t, el);
        maxEl = el;
        maxAtMs = t;
      } else if (riseMs != null && el > maxEl) {
        maxEl = el;
        maxAtMs = t;
      }
      if (prevEl != null && prevEl > 0 && el <= 0 && riseMs != null) {
        const setMs = WorldGlobeComponent.interpolateHorizonCrossing(prevMs, prevEl, t, el);
        if (setMs > Date.now() - 15_000) {
          passes.push({
            riseAt: new Date(riseMs),
            setAt: new Date(setMs),
            maxElevationDeg: maxEl,
            maxAt: new Date(maxAtMs)
          });
          if (passes.length >= GLOBE_SAT_PASS_MAX) {
            break;
          }
        }
        riseMs = null;
        maxEl = -90;
      }
      prevEl = el;
      prevMs = t;
    }
    return passes;
  }

  private satelliteElevationDegAt(
    sat: AstroSatelliteOption,
    obsLat: number,
    obsLon: number,
    atMs: number
  ): number | null {
    const snap = this.satNowService.snapshotForOption(sat, atMs);
    if (!snap) {
      return null;
    }
    const elevRad = WorldGlobeComponent.satelliteElevationRadFromLatLon(
      obsLat,
      obsLon,
      snap.lat,
      snap.lon,
      snap.altKm ?? sat.defaultAltKm
    );
    return (elevRad * 180) / Math.PI;
  }

  private static interpolateHorizonCrossing(
    t0: number,
    el0: number,
    t1: number,
    el1: number
  ): number {
    const den = el1 - el0;
    if (Math.abs(den) < 1e-9) {
      return t1;
    }
    const u = Math.min(1, Math.max(0, (0 - el0) / den));
    return t0 + (t1 - t0) * u;
  }

  private static initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r1 = (lat1 * Math.PI) / 180;
    const r2 = (lat2 * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(r2);
    const x = Math.cos(r1) * Math.sin(r2) - Math.sin(r1) * Math.cos(r2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  private ensureGlobeSatelliteVisual(sat: AstroSatelliteOption): void {
    const earth = this.earthMesh;
    if (!earth || this.globeSatelliteVisuals.has(sat.id)) {
      return;
    }
    const name = this.translate.instant(sat.labelKey) || sat.id;
    const marker = WorldGlobeComponent.createSatelliteIconMesh(
      sat.color,
      sat.fixedGeo || sat.defaultAltKm >= 10_000
        ? GLOBE_SAT_GEO_ICON_WORLD_SIZE
        : GLOBE_SAT_ICON_WORLD_SIZE
    );
    const label = WorldGlobeComponent.createSatelliteNameSprite(name, sat.color);
    if (!label) {
      WorldGlobeComponent.disposeIconPlaneMesh(marker);
      return;
    }
    const group = new THREE.Group();
    group.name = `GlobeSatellite:${sat.id}`;
    group.add(marker);
    group.add(label);
    earth.add(group);
    this.globeSatelliteVisuals.set(sat.id, { group, marker, label, labelText: name });
  }

  private positionGlobeSatelliteVisual(
    satId: string,
    lat: number,
    lon: number,
    altKm: number | null,
    fallbackAltKm: number
  ): void {
    const visual = this.globeSatelliteVisuals.get(satId);
    if (!visual) {
      return;
    }
    const radius = this.globeSatelliteOrbitRadius(altKm, fallbackAltKm);
    WorldGlobeComponent.orientGlobeIconMesh(visual.marker, lat, lon, radius, null);
    const labelPos = WorldGlobeComponent.latLonToVector3(lat, lon, radius * 1.012);
    visual.label.position.copy(labelPos);
  }

  private refreshGlobeSatelliteOptionsSort(): void {
    const locale = this.translate.currentLang || undefined;
    this.globeSatelliteOptionsSorted = [this.issGlobeOption, ...this.globeSatelliteOptions].sort((a, b) => {
      const na = String(this.translate.instant(a.labelKey) || a.id);
      const nb = String(this.translate.instant(b.labelKey) || b.id);
      return na.localeCompare(nb, locale, { sensitivity: 'base' });
    });
    this.cdr.markForCheck();
  }

  private rebuildGlobeSatelliteLabels(): void {
    for (const sat of this.globeSatelliteOptions) {
      const visual = this.globeSatelliteVisuals.get(sat.id);
      if (!visual) {
        continue;
      }
      const name = this.translate.instant(sat.labelKey) || sat.id;
      if (name === visual.labelText) {
        continue;
      }
      const next = WorldGlobeComponent.createSatelliteNameSprite(name, sat.color);
      if (!next) {
        continue;
      }
      visual.group.remove(visual.label);
      const sm = visual.label.material;
      if (sm instanceof THREE.SpriteMaterial) {
        sm.map?.dispose();
        sm.dispose();
      }
      visual.group.add(next);
      visual.label = next;
      visual.labelText = name;
    }
  }

  private disposeGlobeSatelliteVisual(satId: string): void {
    const visual = this.globeSatelliteVisuals.get(satId);
    if (!visual) {
      return;
    }
    this.earthMesh?.remove(visual.group);
    WorldGlobeComponent.disposeIconPlaneMesh(visual.marker);
    const sm = visual.label.material;
    if (sm instanceof THREE.SpriteMaterial) {
      sm.map?.dispose();
      sm.dispose();
    }
    this.globeSatelliteVisuals.delete(satId);
  }

  private disposeAllGlobeSatelliteVisuals(): void {
    for (const id of [...this.globeSatelliteVisuals.keys()]) {
      this.disposeGlobeSatelliteVisual(id);
    }
  }

  private updateGlobeSatelliteForecastTrails(force: boolean): void {
    if (!this.earthMesh || !this.globeSurfaceReady) {
      return;
    }
    const anyOn = this.globeSatelliteOptions.some((s) => this.satelliteFutureTraceById[s.id] === true);
    if (!anyOn) {
      this.setAllGlobeSatelliteForecastTrailsVisible(false);
      return;
    }
    const now = Date.now();
    const missingTrail = this.globeSatelliteOptions.some(
      (s) => this.isGlobeSatelliteFutureTraceOn(s.id) && !this.globeSatelliteForecastLines.has(s.id)
    );
    if (
      !force &&
      !missingTrail &&
      now - this.satelliteForecastLastRebuildMs < GLOBE_SAT_FORECAST_REBUILD_MIN_MS
    ) {
      this.syncGlobeSatelliteForecastTrailVisibility();
      return;
    }
    this.satelliteForecastLastRebuildMs = now;
    for (const sat of this.globeSatelliteOptions) {
      if (!this.isGlobeSatelliteFutureTraceOn(sat.id)) {
        this.disposeGlobeSatelliteForecastTrail(sat.id);
        continue;
      }
      this.rebuildGlobeSatelliteForecastTrail(sat);
    }
  }

  private syncGlobeSatelliteForecastTrailVisibility(): void {
    for (const sat of this.globeSatelliteOptions) {
      const line = this.globeSatelliteForecastLines.get(sat.id);
      if (!line) {
        continue;
      }
      line.visible = this.isGlobeSatelliteFutureTraceOn(sat.id);
    }
  }

  private setAllGlobeSatelliteForecastTrailsVisible(visible: boolean): void {
    for (const line of this.globeSatelliteForecastLines.values()) {
      line.visible = visible;
    }
  }

  private rebuildGlobeSatelliteForecastTrail(sat: AstroSatelliteOption): void {
    const earth = this.earthMesh;
    if (!earth) {
      return;
    }
    const now = Date.now();
    this.satNowService.setObserver(this.userObserverLat, this.userObserverLon);
    const current = this.satNowService.snapshotForOption(sat, now);
    if (!current) {
      void this.satNowService.ensureOption(sat);
      return;
    }
    const endMs = now + this.satelliteFutureTraceMinutes * 60_000;
    const stepMs = this.satelliteForecastStepMs();
    const pts: { lat: number; lon: number }[] = [{ lat: current.lat, lon: current.lon }];
    for (let t = now + stepMs; t <= endMs; t += stepMs) {
      const snap = this.satNowService.snapshotForOption(sat, t);
      if (!snap) {
        continue;
      }
      pts.push({ lat: snap.lat, lon: snap.lon });
    }
    if (pts.length < 2) {
      const existing = this.globeSatelliteForecastLines.get(sat.id);
      if (existing) {
        existing.visible = false;
      }
      return;
    }
    const radius = this.globeSatelliteOrbitRadius(current.altKm, sat.defaultAltKm) * 0.997;
    const vertices: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = WorldGlobeComponent.latLonToVector3(pts[i].lat, pts[i].lon, radius);
      const b = WorldGlobeComponent.latLonToVector3(pts[i + 1].lat, pts[i + 1].lon, radius);
      const arc = WorldGlobeComponent.greatCircleArc(a, b, radius, GLOBE_SAT_FORECAST_TRAIL_ARC_SEGMENTS);
      for (let j = 0; j < arc.length - 1; j++) {
        vertices.push(arc[j].x, arc[j].y, arc[j].z, arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
      }
    }
    if (vertices.length === 0) {
      return;
    }
    let line = this.globeSatelliteForecastLines.get(sat.id);
    if (!line) {
      const mat = new THREE.LineBasicMaterial({
        color: sat.color,
        transparent: true,
        opacity: GLOBE_SAT_FORECAST_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.name = `GlobeSatelliteForecast:${sat.id}`;
      line.renderOrder = 5;
      earth.add(line);
      this.globeSatelliteForecastLines.set(sat.id, line);
    } else {
      const mat = line.material;
      if (!Array.isArray(mat) && mat instanceof THREE.LineBasicMaterial) {
        mat.color.set(sat.color);
        mat.opacity = GLOBE_SAT_FORECAST_TRAIL_OPACITY;
      }
    }
    const oldGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry();
    oldGeo.dispose();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    line.visible = true;
  }

  private disposeGlobeSatelliteForecastTrail(satId: string): void {
    const line = this.globeSatelliteForecastLines.get(satId);
    if (!line) {
      return;
    }
    this.earthMesh?.remove(line);
    line.geometry.dispose();
    const m = line.material;
    if (!Array.isArray(m) && m instanceof THREE.Material) {
      m.dispose();
    }
    this.globeSatelliteForecastLines.delete(satId);
  }

  private disposeAllGlobeSatelliteForecastTrails(): void {
    for (const id of [...this.globeSatelliteForecastLines.keys()]) {
      this.disposeGlobeSatelliteForecastTrail(id);
    }
  }

  private static createSatelliteIconMesh(
    colorHex: string,
    worldSize = GLOBE_SAT_ICON_WORLD_SIZE
  ): THREE.Mesh {
    const tex = WorldGlobeComponent.createGlobeIconCanvasTexture((ctx, size) => {
      WorldGlobeComponent.drawSatelliteTopViewIcon(ctx, size, colorHex);
    });
    return WorldGlobeComponent.createIconPlaneMesh(tex, worldSize);
  }

  private static drawSatelliteTopViewIcon(
    ctx: CanvasRenderingContext2D,
    size: number,
    colorHex: string
  ): void {
    const cx = size / 2;
    const cy = size / 2;
    const s = size;
    ctx.clearRect(0, 0, s, s);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, s * 0.03);
    ctx.fillStyle = colorHex;
    ctx.fillRect(cx - s * 0.42, cy - s * 0.1, s * 0.16, s * 0.2);
    ctx.strokeRect(cx - s * 0.42, cy - s * 0.1, s * 0.16, s * 0.2);
    ctx.fillRect(cx + s * 0.26, cy - s * 0.1, s * 0.16, s * 0.2);
    ctx.strokeRect(cx + s * 0.26, cy - s * 0.1, s * 0.16, s * 0.2);
    ctx.fillRect(cx - s * 0.22, cy - s * 0.03, s * 0.44, s * 0.06);
    ctx.strokeRect(cx - s * 0.22, cy - s * 0.03, s * 0.44, s * 0.06);
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private static createSatelliteNameSprite(displayRaw: string, colorHex: string): THREE.Sprite | null {
    const display = displayRaw.trim();
    if (!display || typeof document === 'undefined') {
      return null;
    }
    const canvas = document.createElement('canvas');
    const scaleCss = Math.min(Math.max(Math.floor(window.devicePixelRatio || 1), 1), 2);
    const ctxMaybe = canvas.getContext('2d');
    if (!ctxMaybe) {
      return null;
    }
    const ctx = ctxMaybe;
    const fontPx = Math.round(16 * scaleCss);
    ctx.font = `700 ${fontPx}px Segoe UI,Roboto,Helvetica,Arial,sans-serif`;
    const measured = ctx.measureText(display).width + Math.floor(16 * scaleCss);
    canvas.width = Math.max(64, Math.min(Math.ceil(measured), 360 * scaleCss));
    canvas.height = Math.ceil(30 * scaleCss);
    ctx.font = `700 ${fontPx}px Segoe UI,Roboto,Helvetica,Arial,sans-serif`;
    ctx.fillStyle = 'rgba(8,16,36,0.72)';
    const rPx = Math.floor(8 * scaleCss);
    ctx.beginPath();
    ctx.moveTo(rPx, 0);
    ctx.lineTo(canvas.width - rPx, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, rPx);
    ctx.lineTo(canvas.width, canvas.height - rPx);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - rPx, canvas.height);
    ctx.lineTo(rPx, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - rPx);
    ctx.lineTo(0, rPx);
    ctx.quadraticCurveTo(0, 0, rPx, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = Math.max(1.5, scaleCss);
    ctx.stroke();
    ctx.fillStyle = colorHex;
    ctx.textBaseline = 'middle';
    ctx.fillText(display, Math.floor(8 * scaleCss), canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      opacity: 0.96
    });
    const sprite = new THREE.Sprite(mat);
    const h = GLOBE_SAT_LABEL_SPRITE_WORLD_H;
    sprite.center.set(0.5, 0);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(aspect * h, h, 1);
    sprite.renderOrder = 7;
    return sprite;
  }

  /**
   * Élévation d’un satellite au-dessus de l’horizon local (rad), modèle sphérique à courbure.
   * Observateur sur la surface à l’angle géocentrique {@code nadirCentralAngleRad} du sous-point ;
   * satellite au-dessus du sous-point à l’altitude {@code altKm}.
   * Dérivé du triangle centre Terre – observateur – satellite (OP = Re, OS = Re+h).
   */
  private static satelliteElevationRadFromNadirCentralAngle(
    nadirCentralAngleRad: number,
    altKm: number
  ): number {
    const ratio = GLOBE_EARTH_RADIUS_KM / (GLOBE_EARTH_RADIUS_KM + Math.max(0, altKm));
    const g = nadirCentralAngleRad;
    return Math.atan2(Math.cos(g) - ratio, Math.sin(g));
  }

  /** Distance oblique observateur → satellite (km), loi des cosinus sur la sphère. */
  private static satelliteSlantRangeKmFromNadirCentralAngle(
    nadirCentralAngleRad: number,
    altKm: number
  ): number {
    const Re = GLOBE_EARTH_RADIUS_KM;
    const R = Re + Math.max(0, altKm);
    const g = nadirCentralAngleRad;
    return Math.sqrt(Re * Re + R * R - 2 * Re * R * Math.cos(g));
  }

  /**
   * Élévation (rad) via vecteurs 3D sur la sphère — contrôle indépendant du modèle méridien.
   * Observateur et sous-point ISS à (lat, lon) ; altitude du satellite au-dessus du sous-point.
   */
  private static satelliteElevationRadFromLatLon(
    observerLatDeg: number,
    observerLonDeg: number,
    nadirLatDeg: number,
    nadirLonDeg: number,
    altKm: number
  ): number {
    const Re = GLOBE_EARTH_RADIUS_KM;
    const obs = WorldGlobeComponent.latLonToVector3(observerLatDeg, observerLonDeg, Re);
    const sat = WorldGlobeComponent.latLonToVector3(nadirLatDeg, nadirLonDeg, Re + Math.max(0, altKm));
    const toSat = sat.clone().sub(obs);
    const range = toSat.length();
    if (range < 1e-6) {
      return Math.PI / 2;
    }
    const up = obs.clone().normalize();
    return Math.asin(Math.min(1, Math.max(-1, toSat.dot(up) / range)));
  }

  /**
   * Angle géocentrique (rad) depuis le sous-point ISS jusqu’à la limite de visibilité sur la sphère.
   * Résout sin(γ) tan(el) + Re/(Re+h) = cos(γ) pour l’élévation seuil (courbure incluse).
   */
  private static issVisibilityCentralAngleRad(altKm: number, minElevationDeg: number): number {
    const r = GLOBE_EARTH_RADIUS_KM / (GLOBE_EARTH_RADIUS_KM + Math.max(0, altKm));
    const horizonGamma = Math.acos(Math.min(1, Math.max(-1, r)));
    if (minElevationDeg <= 0) {
      return horizonGamma;
    }
    const t = Math.tan((minElevationDeg * Math.PI) / 180);
    const a = 1 + t * t;
    const c = r * r - t * t;
    const disc = 4 * r * r - 4 * a * c;
    if (disc <= 0) {
      return horizonGamma;
    }
    const sqrtDisc = Math.sqrt(disc);
    const candidates = [(2 * r + sqrtDisc) / (2 * a), (2 * r - sqrtDisc) / (2 * a)];
    const elMin = (minElevationDeg * Math.PI) / 180;
    for (const cosGamma of candidates) {
      if (cosGamma < r || cosGamma > 1) {
        continue;
      }
      const gamma = Math.acos(cosGamma);
      const elev = WorldGlobeComponent.satelliteElevationRadFromNadirCentralAngle(gamma, altKm);
      if (Math.abs(elev - elMin) < 2e-4) {
        return gamma;
      }
    }
    let lo = 0;
    let hi = horizonGamma;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      const elev = WorldGlobeComponent.satelliteElevationRadFromNadirCentralAngle(mid, altKm);
      if (elev > elMin) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  }

  /** Distance orthodromique (km) le long de la surface sphérique (= Re × angle géocentrique). */
  private static earthCentralAngleToGroundKm(centralAngleRad: number): number {
    return GLOBE_EARTH_RADIUS_KM * centralAngleRad;
  }

  /** Base orthonormée (est, nord) tangente à la sphère au point (lat, lon). */
  private static sphereTangentFrameAtLatLon(
    latDeg: number,
    lonDeg: number
  ): { center: THREE.Vector3; east: THREE.Vector3; north: THREE.Vector3 } {
    const center = WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, 1).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3().crossVectors(worldUp, center);
    if (east.lengthSq() < 1e-8) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }
    const north = new THREE.Vector3().crossVectors(center, east).normalize();
    return { center, east, north };
  }

  /** Point sur la sphère à l’angle géocentrique {@code centralAngleRad} du sous-point (petit cercle). */
  private static spherePointFromNadirOffset(
    center: THREE.Vector3,
    east: THREE.Vector3,
    north: THREE.Vector3,
    centralAngleRad: number,
    azimuthRad: number,
    radius: number
  ): THREE.Vector3 {
    const sinG = Math.sin(centralAngleRad);
    const cosG = Math.cos(centralAngleRad);
    const tangent = east
      .clone()
      .multiplyScalar(Math.cos(azimuthRad))
      .addScaledVector(north, Math.sin(azimuthRad));
    return center
      .clone()
      .multiplyScalar(cosG)
      .addScaledVector(tangent, sinG)
      .normalize()
      .multiplyScalar(radius);
  }

  /** Sommets d’un petit cercle sphérique centré en (lat, lon) à l’angle géocentrique {@code centralAngleRad}. */
  private static sphereSmallCirclePoints(
    latDeg: number,
    lonDeg: number,
    centralAngleRad: number,
    radius: number,
    segments: number
  ): THREE.Vector3[] {
    const { center, east, north } = WorldGlobeComponent.sphereTangentFrameAtLatLon(latDeg, lonDeg);
    const out: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      out.push(
        WorldGlobeComponent.spherePointFromNadirOffset(
          center,
          east,
          north,
          centralAngleRad,
          theta,
          radius
        )
      );
    }
    return out;
  }

  /**
   * Calotte sphérique : anneaux concentriques le long de la surface (courbure Terre),
   * pas un éventail plan qui couperait à travers le globe.
   */
  private static buildIssVisibilityCapGeometry(
    latDeg: number,
    lonDeg: number,
    centralAngleRad: number,
    sphereRadius: number,
    segments: number,
    radialRings = GLOBE_ISS_VISIBILITY_CAP_RADIAL_RINGS
  ): THREE.BufferGeometry {
    const { center, east, north } = WorldGlobeComponent.sphereTangentFrameAtLatLon(latDeg, lonDeg);
    const positions: number[] = [];
    const indices: number[] = [];
    const ringVertexStart: number[] = [];

    for (let ri = 0; ri <= radialRings; ri++) {
      ringVertexStart.push(positions.length / 3);
      const angle = (centralAngleRad * ri) / radialRings;
      if (ri === 0) {
        const c = center.clone().multiplyScalar(sphereRadius);
        positions.push(c.x, c.y, c.z);
        continue;
      }
      for (let si = 0; si < segments; si++) {
        const az = (si / segments) * Math.PI * 2;
        const p = WorldGlobeComponent.spherePointFromNadirOffset(
          center,
          east,
          north,
          angle,
          az,
          sphereRadius
        );
        positions.push(p.x, p.y, p.z);
      }
    }

    for (let ri = 0; ri < radialRings; ri++) {
      if (ri === 0) {
        const centerIdx = ringVertexStart[0];
        const outerStart = ringVertexStart[1];
        for (let si = 0; si < segments; si++) {
          indices.push(centerIdx, outerStart + si, outerStart + ((si + 1) % segments));
        }
        continue;
      }
      const innerStart = ringVertexStart[ri];
      const outerStart = ringVertexStart[ri + 1];
      for (let si = 0; si < segments; si++) {
        const si2 = (si + 1) % segments;
        indices.push(
          innerStart + si,
          outerStart + si,
          outerStart + si2,
          innerStart + si,
          outerStart + si2,
          innerStart + si2
        );
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  /** Matériau calotte ISS : dégradé radial calculé en fragment (angle depuis le sous-point). */
  private static createIssVisibilityFillMaterial(
    innerColor: THREE.ColorRepresentation = GLOBE_ISS_VISIBILITY_FILL_INNER_COLOR,
    outerColor: THREE.ColorRepresentation = GLOBE_ISS_VISIBILITY_FILL_OUTER_COLOR
  ): THREE.ShaderMaterial {
    const inner = new THREE.Color(innerColor);
    const outer = new THREE.Color(outerColor);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColorInner: { value: inner },
        uColorOuter: { value: outer },
        uOpacityCenter: { value: GLOBE_ISS_VISIBILITY_FILL_OPACITY_CENTER },
        uOpacityEdge: { value: GLOBE_ISS_VISIBILITY_FILL_OPACITY_EDGE },
        uNadirDir: { value: new THREE.Vector3(0, 1, 0) },
        uGammaMax: { value: 0.22 }
      },
      vertexShader: `
        varying vec3 vLocalDir;
        void main() {
          vLocalDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColorInner;
        uniform vec3 uColorOuter;
        uniform float uOpacityCenter;
        uniform float uOpacityEdge;
        uniform vec3 uNadirDir;
        uniform float uGammaMax;
        varying vec3 vLocalDir;
        void main() {
          float cosA = clamp(dot(vLocalDir, normalize(uNadirDir)), -1.0, 1.0);
          float angle = acos(cosA);
          float t = uGammaMax > 1e-5 ? clamp(angle / uGammaMax, 0.0, 1.0) : 0.0;
          vec3 color = mix(uColorInner, uColorOuter, t);
          float alpha = mix(uOpacityCenter, uOpacityEdge, t);
          if (alpha < 0.004) {
            discard;
          }
          gl_FragColor = vec4(color, alpha);
        }
      `
    });
    mat.toneMapped = false;
    return mat;
  }

  private syncIssVisibilityFillShaderUniforms(lat: number, lon: number, gammaRad: number): void {
    const fill = this.issVisibilityFillMesh;
    if (!fill) {
      return;
    }
    let mat = fill.material;
    if (!(mat instanceof THREE.ShaderMaterial)) {
      if (!Array.isArray(mat)) {
        mat.dispose();
      }
      fill.material = WorldGlobeComponent.createIssVisibilityFillMaterial();
      mat = fill.material;
    }
    const shader = mat as THREE.ShaderMaterial;
    shader.uniforms['uNadirDir'].value
      .copy(WorldGlobeComponent.latLonToVector3(lat, lon, 1))
      .normalize();
    shader.uniforms['uGammaMax'].value = Math.max(gammaRad, 1e-5);
  }

  /** Met à jour la zone de visibilité ISS (contour + remplissage semi-transparent). */
  private updateIssVisibilityCircle(lat: number, lon: number, altKm: number | null): void {
    const earth = this.earthMesh;
    if (!earth || !this.issOverlayEnabled) {
      return;
    }
    const h = altKm != null && altKm > 0 ? altKm : 420;
    const gamma = WorldGlobeComponent.issVisibilityCentralAngleRad(
      h,
      GLOBE_ISS_VISIBILITY_MIN_ELEVATION_DEG
    );
    this.globeIssVisibilityRadiusKm = WorldGlobeComponent.earthCentralAngleToGroundKm(gamma);
    const pts = WorldGlobeComponent.sphereSmallCirclePoints(
      lat,
      lon,
      gamma,
      GLOBE_ISS_VISIBILITY_CIRCLE_RADIUS,
      GLOBE_ISS_VISIBILITY_CIRCLE_SEGMENTS
    );
    if (!this.issVisibilityCircleLine) {
      const lineMat = new THREE.LineBasicMaterial({
        color: GLOBE_ISS_VISIBILITY_CIRCLE_COLOR,
        transparent: true,
        opacity: GLOBE_ISS_VISIBILITY_CIRCLE_OPACITY,
        depthWrite: false
      });
      lineMat.toneMapped = false;
      const line = new THREE.LineLoop(new THREE.BufferGeometry(), lineMat);
      line.renderOrder = 4;
      earth.add(line);
      this.issVisibilityCircleLine = line;
    }
    if (!this.issVisibilityFillMesh) {
      const fill = new THREE.Mesh(
        new THREE.BufferGeometry(),
        WorldGlobeComponent.createIssVisibilityFillMaterial()
      );
      fill.renderOrder = 3;
      earth.add(fill);
      this.issVisibilityFillMesh = fill;
    }
    const line = this.issVisibilityCircleLine;
    const oldLineGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    oldLineGeo.dispose();
    line.visible = true;

    const fill = this.issVisibilityFillMesh;
    const oldFillGeo = fill.geometry;
    fill.geometry = WorldGlobeComponent.buildIssVisibilityCapGeometry(
      lat,
      lon,
      gamma,
      GLOBE_ISS_VISIBILITY_FILL_RADIUS,
      GLOBE_ISS_VISIBILITY_CIRCLE_SEGMENTS
    );
    oldFillGeo.dispose();
    this.syncIssVisibilityFillShaderUniforms(lat, lon, gamma);
    fill.visible = true;
  }

  private disposeIssVisibilityCircle(): void {
    const line = this.issVisibilityCircleLine;
    this.issVisibilityCircleLine = undefined;
    if (line) {
      this.earthMesh?.remove(line);
      line.geometry.dispose();
      const m = line.material;
      if (!Array.isArray(m) && m instanceof THREE.Material) {
        m.dispose();
      }
    }
    const fill = this.issVisibilityFillMesh;
    this.issVisibilityFillMesh = undefined;
    this.globeIssVisibilityRadiusKm = null;
    if (fill) {
      this.earthMesh?.remove(fill);
      fill.geometry.dispose();
      const fm = fill.material;
      if (!Array.isArray(fm) && fm instanceof THREE.Material) {
        fm.dispose();
      }
    }
  }

  private static satelliteVisibilityFillColors(hex: string): { inner: THREE.Color; outer: THREE.Color } {
    const inner = new THREE.Color(hex);
    const outer = inner.clone();
    outer.offsetHSL(0.03, 0.08, -0.22);
    return { inner, outer };
  }

  private updateSatelliteVisibilityCircle(
    sat: AstroSatelliteOption,
    lat: number,
    lon: number,
    altKm: number
  ): void {
    const earth = this.earthMesh;
    if (!earth || this.satelliteOverlayEnabled[sat.id] === false) {
      return;
    }
    const h = altKm > 0 ? altKm : sat.defaultAltKm;
    const gamma = Math.min(
      WorldGlobeComponent.issVisibilityCentralAngleRad(h, GLOBE_ISS_VISIBILITY_MIN_ELEVATION_DEG) *
        GLOBE_SAT_VISIBILITY_CIRCLE_SCALE,
      GLOBE_SAT_VISIBILITY_CIRCLE_MAX_GAMMA
    );
    const pts = WorldGlobeComponent.sphereSmallCirclePoints(
      lat,
      lon,
      gamma,
      GLOBE_ISS_VISIBILITY_CIRCLE_RADIUS,
      GLOBE_ISS_VISIBILITY_CIRCLE_SEGMENTS
    );
    const { inner, outer } = WorldGlobeComponent.satelliteVisibilityFillColors(sat.color);
    if (!this.satVisibilityCircleLine) {
      const lineMat = new THREE.LineBasicMaterial({
        color: inner,
        transparent: true,
        opacity: GLOBE_ISS_VISIBILITY_CIRCLE_OPACITY,
        depthWrite: false
      });
      lineMat.toneMapped = false;
      const line = new THREE.LineLoop(new THREE.BufferGeometry(), lineMat);
      line.renderOrder = 4;
      earth.add(line);
      this.satVisibilityCircleLine = line;
    } else {
      const lm = this.satVisibilityCircleLine.material;
      if (!Array.isArray(lm) && lm instanceof THREE.LineBasicMaterial) {
        lm.color.copy(inner);
      }
    }
    if (!this.satVisibilityFillMesh) {
      const fill = new THREE.Mesh(
        new THREE.BufferGeometry(),
        WorldGlobeComponent.createIssVisibilityFillMaterial(inner, outer)
      );
      fill.renderOrder = 3;
      earth.add(fill);
      this.satVisibilityFillMesh = fill;
    }
    const line = this.satVisibilityCircleLine;
    const oldLineGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    oldLineGeo.dispose();
    line.visible = true;

    const fill = this.satVisibilityFillMesh;
    const oldFillGeo = fill.geometry;
    fill.geometry = WorldGlobeComponent.buildIssVisibilityCapGeometry(
      lat,
      lon,
      gamma,
      GLOBE_ISS_VISIBILITY_FILL_RADIUS,
      GLOBE_ISS_VISIBILITY_CIRCLE_SEGMENTS
    );
    oldFillGeo.dispose();
    this.syncSatelliteVisibilityFillShaderUniforms(lat, lon, gamma, inner, outer);
    fill.visible = true;
  }

  private syncSatelliteVisibilityFillShaderUniforms(
    lat: number,
    lon: number,
    gammaRad: number,
    inner: THREE.Color,
    outer: THREE.Color
  ): void {
    const fill = this.satVisibilityFillMesh;
    if (!fill) {
      return;
    }
    let mat = fill.material;
    if (!(mat instanceof THREE.ShaderMaterial)) {
      if (!Array.isArray(mat)) {
        mat.dispose();
      }
      fill.material = WorldGlobeComponent.createIssVisibilityFillMaterial(inner, outer);
      mat = fill.material;
    }
    const shader = mat as THREE.ShaderMaterial;
    shader.uniforms['uColorInner'].value.copy(inner);
    shader.uniforms['uColorOuter'].value.copy(outer);
    shader.uniforms['uNadirDir'].value
      .copy(WorldGlobeComponent.latLonToVector3(lat, lon, 1))
      .normalize();
    shader.uniforms['uGammaMax'].value = Math.max(gammaRad, 1e-5);
  }

  private disposeSatelliteVisibilityCircle(): void {
    this.globeSatVisibilityCircleSatId = null;
    const line = this.satVisibilityCircleLine;
    this.satVisibilityCircleLine = undefined;
    if (line) {
      this.earthMesh?.remove(line);
      line.geometry.dispose();
      const m = line.material;
      if (!Array.isArray(m) && m instanceof THREE.Material) {
        m.dispose();
      }
    }
    const fill = this.satVisibilityFillMesh;
    this.satVisibilityFillMesh = undefined;
    if (fill) {
      this.earthMesh?.remove(fill);
      fill.geometry.dispose();
      const fm = fill.material;
      if (!Array.isArray(fm) && fm instanceof THREE.Material) {
        fm.dispose();
      }
    }
  }

  /* ===================================================================== */
  /* Flight tracking (OpenSky Network): input, polling, marker + trail.     */
  /* ===================================================================== */

  /** Normalizes input for the current mode; returns whether it is valid (callsign or hex). */
  flightQueryValid(): boolean {
    return this.normalizeFlightQuery(this.flightQueryInput, this.flightMode) != null;
  }

  /** Normalized callsign (2–8 alphanum.) or ICAO24 (6 hex), or null if invalid. */
  private normalizeFlightQuery(raw: string, mode: 'callsign' | 'icao24'): string | null {
    const v = (raw ?? '').trim();
    if (mode === 'icao24') {
      const hex = v.toLowerCase();
      return /^[0-9a-f]{6}$/.test(hex) ? hex : null;
    }
    const cs = v.toUpperCase().replace(/\s+/g, '');
    return /^[A-Z0-9]{2,8}$/.test(cs) ? cs : null;
  }

  /** Clears input when mode changes (avoids keeping an incompatible value). */
  onFlightModeChange(): void {
    this.flightStatus = this.flightTrackingActive ? this.flightStatus : 'idle';
  }

  /** Starts tracking the entered flight (validation, persistence, polling, first fetch). */
  startFlightTracking(): void {
    const query = this.normalizeFlightQuery(this.flightQueryInput, this.flightMode);
    if (query == null) {
      this.flightStatus = 'error';
      return;
    }
    this.flightTrackedQuery = query;
    this.flightTrackedMode = this.flightMode;
    this.flightQueryInput = query;
    this.flightTrackingActive = true;
    this.flightStatus = 'loading';
    this.flightGlobeFreeOrbit = false;
    this.flightCameraCenterSmoothPrevMs = 0;
    this.resetFlightStateValues();
    this.flightTrackPoints.length = 0;
    this.applyFlightTrackingIssOverrides();
    this.persistFlightTrackingPreference();
    this.startFlightPolling();
    void this.refreshFlightNow();
  }

  /** Stops tracking (timers + marker + trail), keeps the stored preference. */
  stopFlightTracking(): void {
    this.stopFlightPolling();
    this.flightTrackingActive = false;
    this.flightStatus = 'idle';
    this.flightGlobeFreeOrbit = false;
    this.flightCameraCenterSmoothPrevMs = 0;
    this.restoreFlightTrackingIssOverrides();
    this.disposeFlightMarker();
    this.disposeFlightTrail();
    this.flightTrackPoints.length = 0;
    this.resetFlightStateValues();
    this.scheduleWorldGlobeCdr();
  }

  /** Stops tracking and clears the flight stored on the backend. */
  clearFlightTracking(): void {
    this.stopFlightTracking();
    this.flightTrackedQuery = null;
    this.flightQueryInput = '';
    this.apiService.deleteFlightTracking().subscribe({ next: () => {}, error: () => {} });
  }

  /** Immediate manual refresh (button). */
  onFlightRefreshNowClick(): void {
    if (!this.flightTrackingActive || this.flightManualRefreshInFlight) {
      return;
    }
    this.flightManualRefreshInFlight = true;
    void this.refreshFlightNow().finally(() => {
      this.scheduleWorldGlobeCdr(() => {
        this.flightManualRefreshInFlight = false;
      });
    });
  }

  /** Applies the entered poll interval (clamped) and restarts scheduling. */
  onFlightPollIntervalChange(): void {
    this.flightPollIntervalSec = this.clampFlightPollIntervalSec(
      typeof this.flightPollIntervalSec === 'number'
        ? this.flightPollIntervalSec
        : GLOBE_FLIGHT_POLL_DEFAULT_SEC
    );
    if (this.flightTrackingActive) {
      this.persistFlightTrackingPreference();
      queueMicrotask(() => this.startFlightPolling());
    }
  }

  private clampFlightPollIntervalSec(n: number): number {
    if (!Number.isFinite(n)) {
      return GLOBE_FLIGHT_POLL_DEFAULT_SEC;
    }
    return Math.min(GLOBE_FLIGHT_POLL_MAX_SEC, Math.max(GLOBE_FLIGHT_POLL_MIN_SEC, Math.round(n)));
  }

  private flightPollIntervalMs(): number {
    return this.clampFlightPollIntervalSec(this.flightPollIntervalSec) * 1000;
  }

  private resetFlightStateValues(): void {
    this.flightLat = null;
    this.flightLon = null;
    this.flightAltKm = null;
    this.flightSpeedKmh = null;
    this.flightTrackDeg = null;
    this.flightVerticalRateMs = null;
    this.flightOnGround = null;
    this.flightCallsign = null;
    this.flightIcao24 = null;
    this.flightOriginCountry = null;
    this.flightLastContactEpoch = null;
    this.flightDepartureAirport = null;
    this.flightArrivalAirport = null;
    this.flightDepartureAirportName = null;
    this.flightArrivalAirportName = null;
    this.flightDepartureAirportIata = null;
    this.flightArrivalAirportIata = null;
    this.flightDepartureCity = null;
    this.flightArrivalCity = null;
    this.flightArrivalCountry = null;
    this.flightDepartureTimeEpoch = null;
    this.flightArrivalTimeEpoch = null;
  }

  /** Formats airport for display: name with IATA / ICAO codes. */
  formatFlightAirport(
    name: string | null | undefined,
    iata: string | null | undefined,
    icao: string | null | undefined
  ): string {
    const airportName = name?.trim();
    const iataCode = iata?.trim().toUpperCase();
    const icaoCode = icao?.trim().toUpperCase();
    if (airportName) {
      if (iataCode && icaoCode) {
        return `${airportName} (${iataCode} / ${icaoCode})`;
      }
      if (icaoCode) {
        return `${airportName} (${icaoCode})`;
      }
      if (iataCode) {
        return `${airportName} (${iataCode})`;
      }
      return airportName;
    }
    if (iataCode && icaoCode) {
      return `${iataCode} / ${icaoCode}`;
    }
    if (icaoCode) {
      return icaoCode;
    }
    if (iataCode) {
      return iataCode;
    }
    return '—';
  }

  private applyFlightAirportDetailsFromState(state: {
    departureAirport?: string | null;
    arrivalAirport?: string | null;
    departureAirportName?: string | null;
    arrivalAirportName?: string | null;
    departureAirportIata?: string | null;
    arrivalAirportIata?: string | null;
    departureCity?: string | null;
    arrivalCity?: string | null;
    arrivalCountry?: string | null;
  }): void {
    const dep = this.mergeAirportDetails(
      this.flightDepartureAirport,
      state.departureAirportName,
      state.departureAirportIata,
      state.departureCity
    );
    const arr = this.mergeAirportDetails(
      this.flightArrivalAirport,
      state.arrivalAirportName,
      state.arrivalAirportIata,
      state.arrivalCity,
      state.arrivalCountry
    );
    this.flightDepartureAirportName = dep.name;
    this.flightDepartureAirportIata = dep.iata;
    this.flightDepartureCity = dep.city;
    this.flightArrivalAirportName = arr.name;
    this.flightArrivalAirportIata = arr.iata;
    this.flightArrivalCity = arr.city;
    this.flightArrivalCountry = arr.country;
  }

  private refreshFlightAirportLabelsFromLookup(): void {
    const dep = this.mergeAirportDetails(
      this.flightDepartureAirport,
      this.flightDepartureAirportName,
      this.flightDepartureAirportIata,
      this.flightDepartureCity
    );
    const arr = this.mergeAirportDetails(
      this.flightArrivalAirport,
      this.flightArrivalAirportName,
      this.flightArrivalAirportIata,
      this.flightArrivalCity,
      this.flightArrivalCountry
    );
    this.flightDepartureAirportName = dep.name;
    this.flightDepartureAirportIata = dep.iata;
    this.flightDepartureCity = dep.city;
    this.flightArrivalAirportName = arr.name;
    this.flightArrivalAirportIata = arr.iata;
    this.flightArrivalCity = arr.city;
    this.flightArrivalCountry = arr.country;
  }

  private mergeAirportDetails(
    icao: string | null,
    apiName?: string | null,
    apiIata?: string | null,
    apiCity?: string | null,
    apiCountry?: string | null
  ): { name: string | null; iata: string | null; city: string | null; country: string | null } {
    const lookup =
      this.airportLookupMap != null
        ? this.airportLookup.resolveCached(icao, this.airportLookupMap)
        : null;
    const name = apiName?.trim() || lookup?.name || null;
    const iata = apiIata?.trim().toUpperCase() || lookup?.iata || null;
    const city = apiCity?.trim() || lookup?.city || null;
    const country = apiCountry?.trim() || lookup?.country || null;
    return { name, iata, city, country };
  }

  /** Formats a flight time (UTC epoch seconds) for display, or « — » if missing. */
  formatFlightTimeEpoch(epochSec: number | null | undefined): string {
    if (epochSec == null || !Number.isFinite(epochSec) || epochSec <= 0) {
      return '—';
    }
    return new Date(epochSec * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  private stopFlightPolling(): void {
    if (this.flightRefreshTimeout != null) {
      clearTimeout(this.flightRefreshTimeout);
      this.flightRefreshTimeout = null;
    }
    if (this.flightCountdownInterval != null) {
      clearInterval(this.flightCountdownInterval);
      this.flightCountdownInterval = null;
    }
    this.flightNextRefreshEpochMs = 0;
    this.refreshFlightCountdownSnapshot();
  }

  private startFlightPolling(): void {
    this.stopFlightPolling();
    if (!this.flightTrackingActive || this.flightTrackedQuery == null) {
      return;
    }
    const ms = this.flightPollIntervalMs();
    this.flightNextRefreshEpochMs = Date.now() + ms;
    this.flightCountdownInterval = window.setInterval(() => {
      this.refreshFlightCountdownSnapshot();
      this.scheduleWorldGlobeCdr();
    }, 1000);
    this.scheduleFlightRefreshChain(ms);
    queueMicrotask(() => {
      this.refreshFlightCountdownSnapshot();
      this.scheduleWorldGlobeCdr();
    });
  }

  private scheduleFlightRefreshChain(delayMs: number): void {
    this.flightRefreshTimeout = window.setTimeout(() => {
      this.flightRefreshTimeout = null;
      void this.refreshFlightNow().finally(() => {
        if (!this.flightTrackingActive) {
          return;
        }
        const ms = this.flightPollIntervalMs();
        this.flightNextRefreshEpochMs = Date.now() + ms;
        this.refreshFlightCountdownSnapshot();
        this.scheduleFlightRefreshChain(ms);
      });
    }, delayMs);
  }

  private refreshFlightCountdownSnapshot(): void {
    let next = 0;
    if (this.flightTrackingActive && this.flightNextRefreshEpochMs > 0) {
      next = Math.max(0, Math.ceil((this.flightNextRefreshEpochMs - Date.now()) / 1000));
    }
    this.scheduleWorldGlobeCdr(() => {
      this.flightSecondsUntilNextRefresh = next;
    });
  }

  private async refreshFlightNow(): Promise<void> {
    if (!this.flightTrackingActive || this.flightTrackedQuery == null) {
      return;
    }
    const mode = this.flightTrackedMode;
    const query = this.flightTrackedQuery;
    try {
      const state = await firstValueFrom(this.apiService.getFlightState(mode, query));
      if (!this.flightTrackingActive || this.flightTrackedQuery !== query) {
        return;
      }
      if (state == null) {
        this.scheduleWorldGlobeCdr(() => {
          this.flightStatus = 'notfound';
        });
        return;
      }
      const lat = typeof state.latitude === 'number' ? state.latitude : null;
      const lon = typeof state.longitude === 'number' ? state.longitude : null;
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        this.scheduleWorldGlobeCdr(() => {
          this.flightStatus = 'notfound';
        });
        return;
      }

      const geoAltM = typeof state.geoAltitudeM === 'number' ? state.geoAltitudeM : null;
      const baroAltM = typeof state.baroAltitudeM === 'number' ? state.baroAltitudeM : null;
      const altM = geoAltM ?? baroAltM;
      const altKm = altM != null && altM >= 0 && altM <= 30000 ? altM / 1000 : null;
      const radius = this.flightRadiusForAltitude(altM);
      const velMs = typeof state.velocityMs === 'number' ? state.velocityMs : null;
      const speedKmh = velMs != null && velMs >= 0 && velMs <= 1500 ? velMs * 3.6 : null;
      const trackDeg = typeof state.trueTrackDeg === 'number' ? state.trueTrackDeg : null;
      const vRate = typeof state.verticalRateMs === 'number' ? state.verticalRateMs : null;
      const icao24 = state.icao24?.trim().toLowerCase() ?? null;

      this.flightLat = lat;
      this.flightLon = lon;
      this.flightAltKm = altKm;
      this.flightSpeedKmh = speedKmh;
      this.flightTrackDeg = trackDeg;
      this.flightVerticalRateMs = vRate;
      this.flightOnGround = typeof state.onGround === 'boolean' ? state.onGround : null;
      this.flightCallsign = state.callsign && state.callsign.trim() !== '' ? state.callsign.trim() : null;
      this.flightIcao24 = icao24;
      this.flightOriginCountry = state.originCountry ?? null;
      this.flightLastContactEpoch = typeof state.lastContact === 'number' ? state.lastContact : null;
      this.flightDepartureAirport =
        state.departureAirport && state.departureAirport.trim() !== ''
          ? state.departureAirport.trim().toUpperCase()
          : null;
      this.flightArrivalAirport =
        state.arrivalAirport && state.arrivalAirport.trim() !== ''
          ? state.arrivalAirport.trim().toUpperCase()
          : null;
      this.applyFlightAirportDetailsFromState(state);
      this.flightDepartureTimeEpoch =
        typeof state.departureTimeEpoch === 'number' && state.departureTimeEpoch > 0
          ? state.departureTimeEpoch
          : null;
      this.flightArrivalTimeEpoch =
        typeof state.arrivalTimeEpoch === 'number' && state.arrivalTimeEpoch > 0
          ? state.arrivalTimeEpoch
          : null;
      this.flightStatus = 'tracking';
      this.flightMarkerRadius = radius;
      this.syncFlightGlobeVisuals();

      if (icao24) {
        void this.loadFlightTrack(icao24);
      }

      this.scheduleWorldGlobeCdr();
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      this.scheduleWorldGlobeCdr(() => {
        this.flightStatus = status === 502 || status === 503 ? 'upstream' : 'error';
      });
    }
  }

  /** Loads the full OpenSky trajectory (departure → current position) and redraws the line. */
  private async loadFlightTrack(icao24: string): Promise<void> {
    if (!this.flightTrackingActive) {
      return;
    }
    try {
      const track = await firstValueFrom(this.apiService.getFlightTrack(icao24, 0));
      if (!this.flightTrackingActive) {
        return;
      }
      if (!track?.points?.length) {
        return;
      }
      const pts: { lat: number; lon: number; radius: number }[] = [];
      for (const wp of track.points) {
        const la = typeof wp.latitude === 'number' ? wp.latitude : null;
        const lo = typeof wp.longitude === 'number' ? wp.longitude : null;
        if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) {
          continue;
        }
        const altM = typeof wp.baroAltitudeM === 'number' ? wp.baroAltitudeM : null;
        pts.push({ lat: la, lon: lo, radius: this.flightRadiusForAltitude(altM) });
      }
      if (pts.length < 2) {
        return;
      }
      this.flightTrackPoints.length = 0;
      this.flightTrackPoints.push(...pts);
      this.rebuildFlightTrailGeometry();
      if (track.callsign?.trim()) {
        this.scheduleWorldGlobeCdr(() => {
          if (!this.flightCallsign) {
            this.flightCallsign = track.callsign!.trim();
          }
        });
      }
    } catch {
      /* trajectory is optional: live position remains visible */
    }
  }

  /**
   * While tracking a flight: disables ISS centering and hides the ISS trace
   * (as if the user had unchecked « trace » and « center on ISS »).
   */
  private applyFlightTrackingIssOverrides(): void {
    if (!this.issStateBeforeFlight) {
      this.issStateBeforeFlight = {
        keepCentered: this.issKeepEarthCentered,
        traceVisible: this.issTraceVisible
      };
    }
    this.issKeepEarthCentered = false;
    this.issCameraCenterSmoothPrevMs = 0;
    this.issGlobeFreeOrbit = false;
    this.flightGlobeFreeOrbit = false;
    this.flightCameraCenterSmoothPrevMs = 0;
    this.issTraceVisible = false;
    this.applyIssTraceVisibility();
    this.scheduleWorldGlobeCdr();
  }

  /** Restores ISS centering and trace as before flight tracking. */
  private restoreFlightTrackingIssOverrides(): void {
    const saved = this.issStateBeforeFlight;
    if (!saved) {
      return;
    }
    this.issKeepEarthCentered = saved.keepCentered;
    this.issTraceVisible = saved.traceVisible;
    this.issStateBeforeFlight = null;
    this.applyIssTraceVisibility();
    if (this.issTraceVisible) {
      this.rebuildIssTrailGeometry();
      this.rebuildIssForecastTrailGeometry();
    }
    if (this.issHistoricalTraceEnabled && this.issHistoricalTrailPoints.length >= 2) {
      this.rebuildIssHistoricalTrailGeometry();
    }
    this.scheduleWorldGlobeCdr();
  }

  /** Globe radius factor from altitude (m); fallback just above the surface. */
  private flightRadiusForAltitude(altM: number | null): number {
    if (altM == null || !Number.isFinite(altM) || altM <= 0) {
      return GLOBE_FLIGHT_SURFACE_OFFSET;
    }
    return 1 + Math.min(altM, 30000) / GLOBE_EARTH_RADIUS_M;
  }

  /** Small aircraft silhouette (top-down, cyan) on a plane oriented by heading. */
  private static createFlightIconMesh(): THREE.Mesh {
    const tex = WorldGlobeComponent.createGlobeIconCanvasTexture((ctx, size) => {
      WorldGlobeComponent.drawAirplaneTopViewIcon(ctx, size, '#35d0ff', '#ffffff');
    });
    return WorldGlobeComponent.createIconPlaneMesh(tex, GLOBE_FLIGHT_ICON_WORLD_SIZE);
  }

  /** ISS top-down mesh uses {@link drawIssTopViewIcon}. */
  private static createIssIconMesh(): THREE.Mesh {
    const tex = WorldGlobeComponent.createGlobeIconCanvasTexture((ctx, size) => {
      drawIssTopViewIcon(ctx, size);
    });
    return WorldGlobeComponent.createIconPlaneMesh(tex, GLOBE_ISS_ICON_WORLD_SIZE);
  }

  private static createGlobeIconCanvasTexture(
    draw: (ctx: CanvasRenderingContext2D, size: number) => void
  ): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D unavailable');
    }
    draw(ctx, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  private static createIconPlaneMesh(texture: THREE.CanvasTexture, worldSize: number): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldSize, worldSize), mat);
    mesh.renderOrder = 6;
    return mesh;
  }

  private static disposeIconPlaneMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (!Array.isArray(mat) && mat instanceof THREE.MeshBasicMaterial) {
      mat.map?.dispose();
      mat.dispose();
    }
  }

  /** Aircraft top-down (nose toward canvas top = heading 0° North), radar / aviation map style. */
  private static drawAirplaneTopViewIcon(
    ctx: CanvasRenderingContext2D,
    size: number,
    fill: string,
    stroke: string
  ): void {
    const cx = size / 2;
    const cy = size / 2;
    const s = size;
    ctx.clearRect(0, 0, s, s);

    const outline = (path: () => void, color: string, lineW: number) => {
      ctx.beginPath();
      path();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    };

    const fillPath = (path: () => void, color: string) => {
      ctx.beginPath();
      path();
      ctx.fillStyle = color;
      ctx.fill();
    };

    /** Jet silhouette (plan view): pointed nose, wide wings, T-tail. */
    const jetBodyPath = (): void => {
      ctx.moveTo(cx, cy - s * 0.43);
      ctx.lineTo(cx + s * 0.055, cy - s * 0.18);
      ctx.lineTo(cx + s * 0.085, cy - s * 0.04);
      ctx.lineTo(cx + s * 0.47, cy + s * 0.03);
      ctx.lineTo(cx + s * 0.48, cy + s * 0.07);
      ctx.lineTo(cx + s * 0.12, cy + s * 0.11);
      ctx.lineTo(cx + s * 0.09, cy + s * 0.24);
      ctx.lineTo(cx + s * 0.22, cy + s * 0.29);
      ctx.lineTo(cx + s * 0.22, cy + s * 0.33);
      ctx.lineTo(cx + s * 0.07, cy + s * 0.33);
      ctx.lineTo(cx + s * 0.05, cy + s * 0.27);
      ctx.lineTo(cx, cy + s * 0.3);
      ctx.lineTo(cx - s * 0.05, cy + s * 0.27);
      ctx.lineTo(cx - s * 0.07, cy + s * 0.33);
      ctx.lineTo(cx - s * 0.22, cy + s * 0.33);
      ctx.lineTo(cx - s * 0.22, cy + s * 0.29);
      ctx.lineTo(cx - s * 0.09, cy + s * 0.24);
      ctx.lineTo(cx - s * 0.12, cy + s * 0.11);
      ctx.lineTo(cx - s * 0.48, cy + s * 0.07);
      ctx.lineTo(cx - s * 0.47, cy + s * 0.03);
      ctx.lineTo(cx - s * 0.085, cy - s * 0.04);
      ctx.lineTo(cx - s * 0.055, cy - s * 0.18);
      ctx.closePath();
    };

    // Light drop shadow for relief on the globe.
    ctx.save();
    ctx.translate(s * 0.012, s * 0.014);
    fillPath(jetBodyPath, 'rgba(0, 28, 48, 0.38)');
    ctx.restore();

    fillPath(jetBodyPath, fill);
    outline(jetBodyPath, stroke, Math.max(2.5, s * 0.028));
    outline(jetBodyPath, 'rgba(0, 55, 80, 0.55)', Math.max(1.5, s * 0.012));

    // Engines under the wings (ellipses).
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    for (const dx of [0.19, -0.19]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * dx, cy + s * 0.06, s * 0.038, s * 0.022, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cockpit / canopy (nose).
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    ctx.ellipse(cx, cy - s * 0.16, s * 0.038, s * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();

    // Central fuselage line (detail).
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, s * 0.008);
    ctx.beginPath();
    ctx.moveTo(cx, cy - s * 0.22);
    ctx.lineTo(cx, cy + s * 0.22);
    ctx.stroke();
  }


  /**
   * Cap vrai (0° = Nord, sens horaire) d’un vecteur tangent à la sphère, même repère que {@link orientGlobeIconMesh}.
   */
  private static tangentHeadingDegAtLatLon(
    latDeg: number,
    lonDeg: number,
    fromLatDeg: number,
    fromLonDeg: number
  ): number {
    const cur = WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, 1);
    const prev = WorldGlobeComponent.latLonToVector3(fromLatDeg, fromLonDeg, 1);
    const normal = cur.clone().normalize();
    const delta = cur.clone().sub(prev);
    const tangent = delta.sub(normal.multiplyScalar(delta.dot(normal)));
    if (tangent.lengthSq() < 1e-14) {
      return 0;
    }
    tangent.normalize();

    const worldUp = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3().crossVectors(worldUp, normal);
    if (east.lengthSq() < 1e-8) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }
    const northTan = new THREE.Vector3().crossVectors(normal, east).normalize();
    const headingRad = Math.atan2(tangent.dot(east), tangent.dot(northTan));
    return ((headingRad * 180) / Math.PI + 360) % 360;
  }

  /**
   * ISS : panneaux solaires (axe +X du sprite) perpendiculaires à la trajectoire (+Y = sens du mouvement).
   * Tangente au dernier segment du grand cercle (même géométrie que la traînée orange).
   */
  private static orientIssIconMesh(
    mesh: THREE.Object3D,
    toLat: number,
    toLon: number,
    fromLat: number,
    fromLon: number,
    radius: number
  ): boolean {
    const end = WorldGlobeComponent.latLonToVector3(toLat, toLon, radius);
    const start = WorldGlobeComponent.latLonToVector3(fromLat, fromLon, radius);
    const arc = WorldGlobeComponent.greatCircleArc(start, end, radius, GLOBE_ISS_TRAIL_ARC_SEGMENTS);
    const cur = arc.length >= 2 ? arc[arc.length - 1] : end;
    const prev = arc.length >= 2 ? arc[arc.length - 2] : start;
    const normal = cur.clone().normalize();
    mesh.position.copy(cur);

    const delta = cur.clone().sub(prev);
    const track = delta.sub(normal.clone().multiplyScalar(delta.dot(normal)));
    if (track.lengthSq() < 1e-16) {
      return false;
    }
    track.normalize();

    const zAxis = normal;
    const yAxis = track;
    let xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
    if (xAxis.lengthSq() < 1e-12) {
      const worldUp = new THREE.Vector3(0, 1, 0);
      xAxis.crossVectors(worldUp, zAxis);
      if (xAxis.lengthSq() < 1e-12) {
        xAxis.set(1, 0, 0);
      }
    }
    xAxis.normalize();
    const yOrtho = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yOrtho, zAxis));
    return true;
  }

  /**
   * Places a flat icon tangent to the sphere; {@code headingDeg} = true track (0° = North, clockwise).
   */
  private static orientGlobeIconMesh(
    mesh: THREE.Object3D,
    latDeg: number,
    lonDeg: number,
    radius: number,
    headingDeg?: number | null
  ): void {
    const localPos = WorldGlobeComponent.latLonToVector3(latDeg, lonDeg, radius);
    const localNormal = localPos.clone().normalize();
    mesh.position.copy(localPos);

    const worldUp = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3().crossVectors(worldUp, localNormal);
    if (east.lengthSq() < 1e-8) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }
    const northTan = new THREE.Vector3().crossVectors(localNormal, east).normalize();

    let forward = northTan;
    if (headingDeg != null && Number.isFinite(headingDeg)) {
      const hRad = (headingDeg * Math.PI) / 180;
      forward = northTan
        .clone()
        .multiplyScalar(Math.cos(hRad))
        .addScaledVector(east, Math.sin(hRad))
        .normalize();
    }

    const zAxis = localNormal;
    let yAxis = forward.clone();
    let xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
    if (xAxis.lengthSq() < 1e-8) {
      xAxis.copy(east);
      yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    } else {
      xAxis.normalize();
      yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    }
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  }

  private ensureFlightMarkerGroup(): void {
    const earth = this.earthMesh;
    if (!earth || this.flightMarkerMesh) {
      return;
    }
    const mesh = WorldGlobeComponent.createFlightIconMesh();
    earth.add(mesh);
    this.flightMarkerMesh = mesh;
  }

  /** Affiche ou met à jour l’icône avion (+ trajectoire si disponible) dès qu’on a une position. */
  private syncFlightGlobeVisuals(): void {
    if (!this.flightTrackingActive || this.flightLat == null || this.flightLon == null || !this.earthMesh) {
      return;
    }
    this.ensureFlightMarkerGroup();
    this.updateFlightMarkerWorldPosition();
    if (this.flightTrackPoints.length >= 2) {
      this.rebuildFlightTrailGeometry();
    }
  }

  private updateFlightMarkerWorldPosition(
    lat?: number,
    lon?: number,
    radius?: number,
    trackDeg?: number | null
  ): void {
    const la = lat ?? this.flightLat;
    const lo = lon ?? this.flightLon;
    const r = radius ?? this.flightMarkerRadius;
    const mesh = this.flightMarkerMesh;
    if (la == null || lo == null || !mesh) {
      return;
    }
    WorldGlobeComponent.orientGlobeIconMesh(mesh, la, lo, r, trackDeg ?? this.flightTrackDeg);
  }

  private disposeFlightMarker(): void {
    const mesh = this.flightMarkerMesh;
    if (!mesh) {
      return;
    }
    this.earthMesh?.remove(mesh);
    WorldGlobeComponent.disposeIconPlaneMesh(mesh);
    this.flightMarkerMesh = undefined;
  }

  private rebuildFlightTrailGeometry(): void {
    const earth = this.earthMesh;
    const pts = this.flightTrackPoints;
    if (!earth || pts.length < 2) {
      if (this.flightTrailLine) {
        this.flightTrailLine.visible = false;
      }
      return;
    }
    const vertices: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const r = Math.max(GLOBE_FLIGHT_TRAIL_RADIUS, (pts[i].radius + pts[i + 1].radius) / 2 - 0.0006);
      const a = WorldGlobeComponent.latLonToVector3(pts[i].lat, pts[i].lon, r);
      const b = WorldGlobeComponent.latLonToVector3(pts[i + 1].lat, pts[i + 1].lon, r);
      const arc = WorldGlobeComponent.greatCircleArc(a, b, r, GLOBE_FLIGHT_TRAIL_ARC_SEGMENTS);
      for (let j = 0; j < arc.length - 1; j++) {
        vertices.push(arc[j].x, arc[j].y, arc[j].z, arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
      }
    }
    if (vertices.length === 0) {
      return;
    }
    if (!this.flightTrailLine) {
      const mat = new THREE.LineBasicMaterial({
        color: GLOBE_FLIGHT_TRAIL_COLOR,
        transparent: true,
        opacity: GLOBE_FLIGHT_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.renderOrder = 5;
      earth.add(line);
      this.flightTrailLine = line;
    }
    const line = this.flightTrailLine;
    const oldGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry();
    oldGeo.dispose();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    line.visible = true;
  }

  private disposeFlightTrail(): void {
    const line = this.flightTrailLine;
    this.flightTrailLine = undefined;
    if (!line) {
      return;
    }
    this.earthMesh?.remove(line);
    line.geometry.dispose();
    const mat = line.material;
    if (!Array.isArray(mat) && mat instanceof THREE.Material) {
      mat.dispose();
    }
  }

  /** Reloads the stored last tracked flight and automatically resumes tracking. */
  private loadFlightTrackingPreference(): void {
    this.apiService.getFlightTracking().subscribe({
      next: pref => {
        if (!pref || !pref.mode || !pref.query) {
          return;
        }
        const query = this.normalizeFlightQuery(pref.query, pref.mode);
        if (query == null) {
          return;
        }
        this.flightMode = pref.mode;
        this.flightQueryInput = query;
        if (typeof pref.pollIntervalSec === 'number') {
          this.flightPollIntervalSec = this.clampFlightPollIntervalSec(pref.pollIntervalSec);
        }
        // Do not start polling until the scene is ready: startFlightTracking handles it.
        this.startFlightTracking();
        this.scheduleWorldGlobeCdr();
      },
      error: () => {}
    });
  }

  /** Persists the current tracked flight (silent when anonymous: backend returns 401). */
  private persistFlightTrackingPreference(): void {
    if (this.flightTrackedQuery == null) {
      return;
    }
    this.apiService
      .setFlightTracking({
        mode: this.flightTrackedMode,
        query: this.flightTrackedQuery,
        pollIntervalSec: this.clampFlightPollIntervalSec(this.flightPollIntervalSec)
      })
      .subscribe({ next: () => {}, error: () => {} });
  }

  /**
   * Ajoute un point à la traînée dès qu’on a au moins deux relevés (direction du mouvement).
   * Ignore les doublons API (même position).
   */
  private recordIssTrailSample(lat: number, lon: number): void {
    const prev = this.issTrailPoints[this.issTrailPoints.length - 1];
    if (
      prev &&
      Math.abs(prev.lat - lat) < 2e-5 &&
      Math.abs(prev.lon - lon) < 2e-5
    ) {
      return;
    }
    this.issTrailPoints.push({ lat, lon });
    while (this.issTrailPoints.length > GLOBE_ISS_TRAIL_MAX_POINTS) {
      this.issTrailPoints.shift();
    }
    if (this.issTraceVisible) {
      this.rebuildIssTrailGeometry();
    }
  }

  private rebuildIssTrailGeometry(): void {
    const earth = this.earthMesh;
    const pts = this.issTrailPoints;
    if (!earth || pts.length < 2) {
      if (this.issTrailLine) {
        this.issTrailLine.visible = false;
      }
      return;
    }
    const r = GLOBE_ISS_TRAIL_RADIUS;
    const vertices: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = WorldGlobeComponent.latLonToVector3(pts[i].lat, pts[i].lon, r);
      const b = WorldGlobeComponent.latLonToVector3(pts[i + 1].lat, pts[i + 1].lon, r);
      const arc = WorldGlobeComponent.greatCircleArc(a, b, r, GLOBE_ISS_TRAIL_ARC_SEGMENTS);
      for (let j = 0; j < arc.length - 1; j++) {
        vertices.push(arc[j].x, arc[j].y, arc[j].z, arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
      }
    }
    if (vertices.length === 0) {
      return;
    }
    if (!this.issTrailLine) {
      const mat = new THREE.LineBasicMaterial({
        color: GLOBE_ISS_LIVE_TRAIL_COLOR,
        transparent: true,
        opacity: GLOBE_ISS_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.name = 'IssLiveTrail';
      line.renderOrder = 5;
      earth.add(line);
      this.issTrailLine = line;
    }
    const line = this.issTrailLine;
    const liveMat = line.material;
    if (!Array.isArray(liveMat) && liveMat instanceof THREE.LineBasicMaterial) {
      liveMat.color.setHex(GLOBE_ISS_LIVE_TRAIL_COLOR);
      liveMat.opacity = GLOBE_ISS_TRAIL_OPACITY;
    }
    const oldGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry();
    oldGeo.dispose();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    line.visible = this.issTraceVisible;
    if (pts.length >= 2 && this.issMarkerMesh && this.globeIssLat != null && this.globeIssLon != null) {
      this.updateIssMarkerWorldPosition(this.globeIssLat, this.globeIssLon);
    }
  }

  private clearIssTrail(): void {
    this.issTrailPoints.length = 0;
    const line = this.issTrailLine;
    this.issTrailLine = undefined;
    if (!line) {
      return;
    }
    this.earthMesh?.remove(line);
    line.geometry.dispose();
    const m = line.material;
    if (!Array.isArray(m) && m instanceof THREE.Material) {
      m.dispose();
    }
  }

  private maybeRefreshIssForecastTrail(
    lat: number,
    lon: number,
    prevLat: number | null,
    prevLon: number | null,
    speedKmh: number | null,
    force = false
  ): void {
    if (!this.issOverlayEnabled || !this.issTraceVisible) {
      return;
    }
    const nowMs = Date.now();
    if (!force && nowMs - this.issForecastLastFetchMs < GLOBE_ISS_FORECAST_REFRESH_MIN_MS) {
      return;
    }
    void this.loadIssForecastTrail(lat, lon, prevLat, prevLon, speedKmh, force);
  }

  private async loadIssForecastTrail(
    lat: number,
    lon: number,
    prevLat: number | null,
    prevLon: number | null,
    speedKmh: number | null,
    force = false
  ): Promise<void> {
    if (!this.issOverlayEnabled || !this.issTraceVisible || !this.earthMesh) {
      return;
    }
    this.issNowService.setForecastMinutes(this.satelliteFutureTraceMinutes);
    if (!force && Date.now() - this.issForecastLastFetchMs < GLOBE_ISS_FORECAST_REFRESH_MIN_MS) {
      return;
    }
    const seq = ++this.issForecastRequestSeq;
    this.issForecastLastFetchMs = Date.now();
    try {
      const data = await firstValueFrom(
        this.http
          .get<IssForecastResponse>(this.globeIssForecastUrl(), {
            params: {
              minutes: String(this.satelliteFutureTraceMinutes),
              stepSec: String(this.issForecastStepSec())
            }
          })
          .pipe(timeout(90_000))
      );
      if (seq !== this.issForecastRequestSeq || !this.issOverlayEnabled || !this.issTraceVisible) {
        return;
      }
      const raw = [...(data?.points ?? [])].sort((a, b) => a.timestamp - b.timestamp);
      const nowSec = Math.floor(Date.now() / 1000);
      const pts: { lat: number; lon: number; atSec: number }[] = [];
      for (const p of raw) {
        if (p?.timestamp <= nowSec) {
          continue;
        }
        const plat = p?.latitude;
        const plon = p?.longitude;
        if (!Number.isFinite(plat) || !Number.isFinite(plon) || Math.abs(plat) > 90 || Math.abs(plon) > 180) {
          continue;
        }
        pts.push({ lat: plat, lon: plon, atSec: p.timestamp });
      }
      if (pts.length === 0) {
        throw new Error('ISS forecast returned no future points');
      }
      const approximate = !!data?.approximate;
      this.issForecastTrailPoints.length = 0;
      this.issForecastTrailPoints.push(...pts);
      this.issForecastTrailApproximate = approximate;
      this.markIssForecastTrailGeometryDirty();
      this.rebuildIssForecastTrailGeometry(lat, lon);
      this.issForecastTrailLastGeometryRebuildMs = performance.now();
      this.issForecastTrailGeometryDirty = false;
      this.issNowService.storeForecastSnapshot({
        points: pts,
        approximate,
        fetchedAtMs: Date.now()
      });
    } catch {
      if (seq !== this.issForecastRequestSeq || !this.issOverlayEnabled || !this.issTraceVisible) {
        return;
      }
      const fallback = this.buildIssForecastFallbackPoints(lat, lon, prevLat, prevLon, speedKmh);
      if (fallback.length > 0) {
        this.issForecastTrailPoints.length = 0;
        this.issForecastTrailPoints.push(...fallback);
        this.issForecastTrailApproximate = true;
        this.markIssForecastTrailGeometryDirty();
        this.rebuildIssForecastTrailGeometry(lat, lon);
        this.issForecastTrailLastGeometryRebuildMs = performance.now();
        this.issForecastTrailGeometryDirty = false;
        this.issNowService.storeForecastSnapshot({
          points: fallback,
          approximate: true,
          fetchedAtMs: Date.now()
        });
      } else {
        this.clearIssForecastTrail();
        this.issForecastTrailApproximate = false;
      }
    }
    this.cdr.markForCheck();
  }

  /** Extrapolation sphérique grossière si l’API forecast est indisponible. */
  private buildIssForecastFallbackPoints(
    lat: number,
    lon: number,
    prevLat: number | null,
    prevLon: number | null,
    speedKmh: number | null
  ): { lat: number; lon: number; atSec: number }[] {
    const segment = this.resolveIssTrailSegment(lat, lon, prevLat, prevLon);
    if (!segment || speedKmh == null || !Number.isFinite(speedKmh) || speedKmh < 1000) {
      return [];
    }
    const bearing = WorldGlobeComponent.tangentHeadingDegAtLatLon(
      segment.toLat,
      segment.toLon,
      segment.fromLat,
      segment.fromLon
    );
    const stepSec = this.issForecastStepSec();
    const steps = Math.floor((this.satelliteFutureTraceMinutes * 60) / stepSec);
    const orbitTurnDegPerStep = (360 / (92 * 60)) * stepSec;
    const distKm = speedKmh * (stepSec / 3600);
    const nowSec = Math.floor(Date.now() / 1000);
    const pts: { lat: number; lon: number; atSec: number }[] = [];
    let curLat = lat;
    let curLon = lon;
    let curBrng = bearing;
    for (let i = 0; i < steps; i++) {
      const next = WorldGlobeComponent.destinationLatLon(curLat, curLon, curBrng, distKm);
      pts.push({ lat: next.lat, lon: next.lon, atSec: nowSec + (i + 1) * stepSec });
      curLat = next.lat;
      curLon = next.lon;
      curBrng = (curBrng + orbitTurnDegPerStep + 360) % 360;
    }
    return pts;
  }

  /**
   * Trace rouge = uniquement APRÈS l’ISS : ancrée sur la position courante, points strictement futurs.
   */
  private markIssForecastTrailGeometryDirty(): void {
    this.issForecastTrailGeometryDirty = true;
  }

  /** Au plus ~4 reconstructions/s pendant le défilement ISS (évite des pics dans setTimeout / rAF). */
  private syncIssForecastTrailGeometryIfDirty(): void {
    if (
      !this.issForecastTrailGeometryDirty ||
      !this.issTraceVisible ||
      this.issForecastTrailPoints.length === 0
    ) {
      return;
    }
    const nowMs = performance.now();
    if (nowMs - this.issForecastTrailLastGeometryRebuildMs < 250) {
      return;
    }
    this.rebuildIssForecastTrailGeometry();
    this.issForecastTrailLastGeometryRebuildMs = nowMs;
    this.issForecastTrailGeometryDirty = false;
  }

  private rebuildIssForecastTrailGeometry(issLat?: number | null, issLon?: number | null): void {
    const earth = this.earthMesh;
    const la = issLat ?? this.globeIssLat;
    const lo = issLon ?? this.globeIssLon;
    if (!earth || la == null || lo == null || !Number.isFinite(la) || !Number.isFinite(lo)) {
      if (this.issForecastTrailLine) {
        this.issForecastTrailLine.visible = false;
      }
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = nowSec + this.satelliteFutureTraceMinutes * 60;
    let write = 0;
    for (let read = 0; read < this.issForecastTrailPoints.length; read++) {
      const p = this.issForecastTrailPoints[read];
      if (p.atSec > nowSec && p.atSec <= endSec) {
        this.issForecastTrailPoints[write++] = p;
      }
    }
    this.issForecastTrailPoints.length = write;
    const future = this.issForecastTrailPoints;
    if (future.length === 0) {
      if (this.issForecastTrailLine) {
        this.issForecastTrailLine.visible = false;
      }
      return;
    }
    const chain: { lat: number; lon: number }[] = [{ lat: la, lon: lo }, ...future];
    const r = GLOBE_ISS_FORECAST_TRAIL_RADIUS;
    const vertices: number[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = WorldGlobeComponent.latLonToVector3(chain[i].lat, chain[i].lon, r);
      const b = WorldGlobeComponent.latLonToVector3(chain[i + 1].lat, chain[i + 1].lon, r);
      const arc = WorldGlobeComponent.greatCircleArc(a, b, r, GLOBE_ISS_FORECAST_TRAIL_ARC_SEGMENTS);
      for (let j = 0; j < arc.length - 1; j++) {
        vertices.push(arc[j].x, arc[j].y, arc[j].z, arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
      }
    }
    if (vertices.length === 0) {
      if (this.issForecastTrailLine) {
        this.issForecastTrailLine.visible = false;
      }
      return;
    }
    if (!this.issForecastTrailLine) {
      const mat = new THREE.LineBasicMaterial({
        color: GLOBE_ISS_FORECAST_TRAIL_COLOR,
        transparent: true,
        opacity: GLOBE_ISS_FORECAST_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.name = 'IssForecastTrail';
      line.renderOrder = 6;
      earth.add(line);
      this.issForecastTrailLine = line;
    }
    const line = this.issForecastTrailLine;
    const forecastMat = line.material;
    if (!Array.isArray(forecastMat) && forecastMat instanceof THREE.LineBasicMaterial) {
      forecastMat.color.setHex(GLOBE_ISS_FORECAST_TRAIL_COLOR);
      forecastMat.opacity = GLOBE_ISS_FORECAST_TRAIL_OPACITY;
    }
    const oldGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry();
    oldGeo.dispose();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    line.visible = this.issTraceVisible;
  }

  private clearIssForecastTrail(): void {
    this.issForecastTrailPoints.length = 0;
    this.issForecastTrailGeometryDirty = false;
    const line = this.issForecastTrailLine;
    this.issForecastTrailLine = undefined;
    if (!line) {
      return;
    }
    this.earthMesh?.remove(line);
    line.geometry.dispose();
    const m = line.material;
    if (!Array.isArray(m) && m instanceof THREE.Material) {
      m.dispose();
    }
  }

  private disposeIssForecastTrail(): void {
    this.issForecastLastFetchMs = 0;
    this.issForecastRequestSeq++;
    this.issForecastTrailApproximate = false;
    this.clearIssForecastTrail();
  }

  /** Charge la trace ISS historique (MongoDB) et la dessine sur le globe. */
  private async loadIssHistoricalTrace(): Promise<void> {
    if (!this.issHistoricalTraceEnabled) {
      return;
    }
    this.issHistoricalTraceLoading = true;
    this.issHistoricalTraceFailed = false;
    this.cdr.markForCheck();
    try {
      const data = await firstValueFrom(
        this.http.get<IssTraceResponse>(this.globeIssTraceUrl()).pipe(timeout(120_000))
      );
      if (!this.issHistoricalTraceEnabled) {
        return;
      }
      if (data?.sampleIntervalSeconds != null && data.sampleIntervalSeconds > 0) {
        this.issTraceSampleIntervalSec = data.sampleIntervalSeconds;
      }
      this.issHistoricalTrailPoints.length = 0;
      const nowMs = Date.now();
      for (const p of data?.points ?? []) {
        const lat = p?.latitude;
        const lon = p?.longitude;
        if (
          lat == null ||
          lon == null ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        ) {
          continue;
        }
        const rawAt = p?.recordedAt?.trim();
        if (rawAt) {
          const atMs = Date.parse(rawAt);
          if (Number.isFinite(atMs) && atMs > nowMs) {
            continue;
          }
        }
        this.issHistoricalTrailPoints.push({ lat, lon, recordedAt: p?.recordedAt });
      }
      this.rebuildIssHistoricalTrailGeometry();
    } catch {
      if (this.issHistoricalTraceEnabled) {
        this.issHistoricalTraceFailed = true;
      }
    } finally {
      this.issHistoricalTraceLoading = false;
      this.applyIssTraceVisibility();
      this.cdr.markForCheck();
    }
  }

  /** Enregistre un échantillon ISS côté serveur (au plus 1× par intervalle serveur, fire-and-forget). */
  private persistIssTraceSample(lat: number, lon: number): void {
    if (!this.issOverlayEnabled || !this.issBackgroundTraceEnabled) {
      return;
    }
    const minMs = Math.max(1000, this.issTraceSampleIntervalSec * 1000);
    const now = Date.now();
    if (this.issLastTracePersistEpochMs > 0 && now - this.issLastTracePersistEpochMs < minMs) {
      return;
    }
    this.issLastTracePersistEpochMs = now;
    const body = {
      latitude: lat,
      longitude: lon,
      recordedAt: new Date(now).toISOString()
    };
    this.http.post<void>(this.globeIssTraceUrl(), body).subscribe({
      error: () => {
        /* non bloquant : la trace live reste affichée */
      }
    });
  }

  private rebuildIssHistoricalTrailGeometry(): void {
    const earth = this.earthMesh;
    const pts = this.issHistoricalTrailPoints;
    if (!this.issHistoricalTraceEnabled || !earth || pts.length < 2) {
      if (this.issHistoricalTrailLine) {
        this.issHistoricalTrailLine.visible = false;
      }
      this.disposeIssHistoricalTraceDateLabels();
      return;
    }
    const r = GLOBE_ISS_HISTORICAL_TRAIL_RADIUS;
    const nowMs = Date.now();
    const vertices: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const endAt = pts[i + 1].recordedAt?.trim();
      if (endAt) {
        const endMs = Date.parse(endAt);
        if (Number.isFinite(endMs) && endMs > nowMs) {
          continue;
        }
      }
      if (!WorldGlobeComponent.issHistoricalTracePointsConnect(pts[i], pts[i + 1])) {
        continue;
      }
      const a = WorldGlobeComponent.latLonToVector3(pts[i].lat, pts[i].lon, r);
      const b = WorldGlobeComponent.latLonToVector3(pts[i + 1].lat, pts[i + 1].lon, r);
      const arc = WorldGlobeComponent.greatCircleArc(a, b, r, GLOBE_ISS_HISTORICAL_TRAIL_ARC_SEGMENTS);
      for (let j = 0; j < arc.length - 1; j++) {
        vertices.push(arc[j].x, arc[j].y, arc[j].z, arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
      }
    }
    if (vertices.length === 0) {
      if (this.issHistoricalTrailLine) {
        this.issHistoricalTrailLine.visible = false;
      }
      return;
    }
    if (!this.issHistoricalTrailLine) {
      const mat = new THREE.LineBasicMaterial({
        color: GLOBE_ISS_HISTORICAL_TRAIL_COLOR,
        transparent: true,
        opacity: GLOBE_ISS_HISTORICAL_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.name = 'IssHistoricalTrail';
      line.renderOrder = 4;
      earth.add(line);
      this.issHistoricalTrailLine = line;
    }
    const line = this.issHistoricalTrailLine;
    if (line.parent !== earth) {
      earth.add(line);
    }
    const histMat = line.material;
    if (!Array.isArray(histMat) && histMat instanceof THREE.LineBasicMaterial) {
      histMat.color.setHex(GLOBE_ISS_HISTORICAL_TRAIL_COLOR);
      histMat.opacity = GLOBE_ISS_HISTORICAL_TRAIL_OPACITY;
    }
    const oldGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry();
    oldGeo.dispose();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    line.visible = this.issHistoricalTraceEnabled;
    if (this.issHistoricalTraceDatesEnabled) {
      this.rebuildIssHistoricalTraceDateLabels();
    } else {
      this.disposeIssHistoricalTraceDateLabels();
    }
    if (this.issMarkerMesh && this.globeIssLat != null && this.globeIssLon != null) {
      this.updateIssMarkerWorldPosition(this.globeIssLat, this.globeIssLon);
    }
  }

  private rebuildIssHistoricalTraceDateLabels(): void {
    const earth = this.earthMesh;
    if (!this.issHistoricalTraceDatesEnabled || !this.issHistoricalTraceEnabled || !earth) {
      this.disposeIssHistoricalTraceDateLabels();
      return;
    }
    const dated: { lat: number; lon: number; recordedAt: string }[] = [];
    for (const p of this.issHistoricalTrailPoints) {
      const raw = p.recordedAt?.trim();
      if (!raw) {
        continue;
      }
      const label = this.formatIssTraceDateLabel(raw);
      if (!label) {
        continue;
      }
      dated.push({ lat: p.lat, lon: p.lon, recordedAt: raw });
    }
    this.disposeIssHistoricalTraceDateLabels();
    if (dated.length === 0) {
      return;
    }
    const labelPoints = this.pickIssTraceDateLabelPoints(dated);
    const group = new THREE.Group();
    group.name = 'IssHistoricalTraceDateLabels';
    const r = GLOBE_ISS_HISTORICAL_DATE_LABEL_RADIUS;
    for (const pt of labelPoints) {
      const label = this.formatIssTraceDateLabel(pt.recordedAt);
      const sprite = WorldGlobeComponent.createIssTraceDateLabelSprite(label);
      if (!sprite) {
        continue;
      }
      sprite.position.copy(WorldGlobeComponent.latLonToVector3(pt.lat, pt.lon, r));
      sprite.renderOrder = 6;
      sprite.userData['issTraceDateLabelRecordedAt'] = pt.recordedAt;
      group.add(sprite);
    }
    if (group.children.length === 0) {
      return;
    }
    group.visible = this.issHistoricalTraceEnabled && this.issHistoricalTraceDatesEnabled;
    earth.add(group);
    this.issHistoricalTraceDateLabelsGroup = group;
    this.updateIssHistoricalTraceDateLabelsScaleForZoom();
  }

  /** Points datés espacés d’au moins {@link issTraceSampleIntervalSec} (sous-échantillonnage si trop nombreux). */
  private pickIssTraceDateLabelPoints(
    points: { lat: number; lon: number; recordedAt: string }[]
  ): { lat: number; lon: number; recordedAt: string }[] {
    const minMs = Math.max(1000, this.issTraceSampleIntervalSec * 1000);
    const picked: { lat: number; lon: number; recordedAt: string }[] = [];
    let lastMs = -Infinity;
    for (const p of points) {
      const ms = new Date(p.recordedAt).getTime();
      if (Number.isNaN(ms)) {
        continue;
      }
      if (picked.length === 0 || ms - lastMs >= minMs) {
        picked.push(p);
        lastMs = ms;
      }
    }
    const cap = GLOBE_ISS_HISTORICAL_DATE_LABEL_MAX;
    if (picked.length <= cap) {
      return picked;
    }
    const out: { lat: number; lon: number; recordedAt: string }[] = [];
    for (let i = 0; i < cap; i++) {
      const idx = Math.round((i * (picked.length - 1)) / (cap - 1));
      out.push(picked[idx]);
    }
    return out;
  }

  private formatIssTraceDateLabel(recordedAt: string): string {
    try {
      const d = new Date(recordedAt);
      if (Number.isNaN(d.getTime())) {
        return '';
      }
      const lang = (this.translate.currentLang || 'en').split('-')[0];
      return new Intl.DateTimeFormat(lang, {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(d);
    } catch {
      return '';
    }
  }

  private disposeIssHistoricalTraceDateLabels(): void {
    const g = this.issHistoricalTraceDateLabelsGroup;
    this.issHistoricalTraceDateLabelsGroup = undefined;
    if (!g) {
      return;
    }
    this.updateIssTraceDateLoupe(0, 0, null);
    this.setIssTraceDateLabelHoverSprite(null);
    this.earthMesh?.remove(g);
    g.traverse((child) => {
      if (!(child instanceof THREE.Sprite)) {
        return;
      }
      const sm = child.material;
      if (sm instanceof THREE.SpriteMaterial) {
        sm.map?.dispose();
        sm.dispose();
      }
    });
  }

  private clearIssHistoricalTrail(): void {
    this.issHistoricalTrailPoints.length = 0;
    const line = this.issHistoricalTrailLine;
    this.issHistoricalTrailLine = undefined;
    if (!line) {
      return;
    }
    this.earthMesh?.remove(line);
    line.geometry.dispose();
    const m = line.material;
    if (!Array.isArray(m) && m instanceof THREE.Material) {
      m.dispose();
    }
    this.disposeIssHistoricalTraceDateLabels();
  }

  private disposeIssHistoricalTrail(): void {
    this.clearIssHistoricalTrail();
  }

  private disposeCountryBordersOverlay(): void {
    const g = this.bordersOverlayGroup;
    const earth = this.earthMesh;
    if (!g) {
      return;
    }
    earth?.remove(g);
    this.bordersOverlayGroup = undefined;
    g.traverse((o) => {
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        const mat = o.material;
        if (!Array.isArray(mat) && mat instanceof THREE.Material) {
          mat.dispose();
        }
      }
    });
  }

  private disposeCoastlinesOverlay(): void {
    const g = this.coastlinesOverlayGroup;
    const earth = this.earthMesh;
    if (!g) {
      return;
    }
    earth?.remove(g);
    this.coastlinesOverlayGroup = undefined;
    g.traverse((o) => {
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        const mat = o.material;
        if (!Array.isArray(mat) && mat instanceof THREE.Material) {
          mat.dispose();
        }
      }
    });
  }

  private disposeGraticuleOverlay(): void {
    const g = this.graticuleOverlayGroup;
    const earth = this.earthMesh;
    if (!g) {
      return;
    }
    earth?.remove(g);
    this.graticuleOverlayGroup = undefined;
    g.traverse((o) => {
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        const mat = o.material;
        if (!Array.isArray(mat) && mat instanceof THREE.Material) {
          mat.dispose();
        }
      }
    });
  }

  private disposePoliticalMapOverlay(): void {
    const mesh = this.politicalMapMesh;
    const earth = this.earthMesh;
    if (!mesh) {
      return;
    }
    earth?.remove(mesh);
    this.politicalMapMesh = undefined;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (!Array.isArray(mat) && mat instanceof THREE.Material) {
      mat.dispose();
    }
  }

  private disposeCountryLabelsOverlay(): void {
    const g = this.countryLabelsGroup;
    const earth = this.earthMesh;
    this.countryLabelZoomMulCached = Number.NaN;
    this.updateCountryLabelLoupe(0, 0, null);
    if (!g) {
      return;
    }
    earth?.remove(g);
    this.countryLabelsGroup = undefined;
    g.traverse((child) => {
      if (!(child instanceof THREE.Sprite)) {
        return;
      }
      const sm = child.material;
      if (sm instanceof THREE.SpriteMaterial) {
        sm.map?.dispose?.();
        sm.dispose();
      }
    });
  }

  private disposeGeographicLinesOverlay(): void {
    const g = this.geographicLinesOverlayGroup;
    const earth = this.earthMesh;
    if (!g) {
      return;
    }
    earth?.remove(g);
    this.geographicLinesOverlayGroup = undefined;
    g.traverse((o) => {
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        const mat = o.material;
        if (!Array.isArray(mat) && mat instanceof THREE.Material) {
          mat.dispose();
        }
      }
    });
  }

  private disposeRiversOverlay(): void {
    const g = this.riversOverlayGroup;
    const earth = this.earthMesh;
    if (!g) {
      return;
    }
    earth?.remove(g);
    this.riversOverlayGroup = undefined;
    g.traverse((o) => {
      if (o instanceof THREE.Line) {
        o.geometry.dispose();
        const mat = o.material;
        if (!Array.isArray(mat) && mat instanceof THREE.Material) {
          mat.dispose();
        }
      }
    });
  }

  private disposeLakesMesh(): void {
    const mesh = this.lakesMesh;
    const earth = this.earthMesh;
    if (!mesh) {
      return;
    }
    earth?.remove(mesh);
    this.lakesMesh = undefined;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (!Array.isArray(mat) && mat instanceof THREE.Material) {
      mat.dispose();
    }
  }

  private disposeGlaciersMesh(): void {
    const mesh = this.glaciersMesh;
    const earth = this.earthMesh;
    if (!mesh) {
      return;
    }
    earth?.remove(mesh);
    this.glaciersMesh = undefined;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (!Array.isArray(mat) && mat instanceof THREE.Material) {
      mat.dispose();
    }
  }

  private disposeTimeZonesMesh(): void {
    const mesh = this.timeZonesMesh;
    const earth = this.earthMesh;
    if (!mesh) {
      return;
    }
    earth?.remove(mesh);
    this.timeZonesMesh = undefined;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (!Array.isArray(mat) && mat instanceof THREE.Material) {
      mat.dispose();
    }
  }

  private disposeCitiesPoints(): void {
    const pts = this.citiesPoints;
    const earth = this.earthMesh;
    if (!pts) {
      return;
    }
    earth?.remove(pts);
    this.citiesPoints = undefined;
    pts.geometry.dispose();
    if (pts.material instanceof THREE.Material) {
      pts.material.dispose();
    }
  }

  private onTranslateLangChangedForGlobeCountryLabels(): void {
    if (!this.countryLabelsEnabled || !this.globeSurfaceReady || !this.earthMesh || !this.admin0CountriesParsed) {
      return;
    }
    this.rebuildCountryLabelsFromParsed(this.admin0CountriesParsed);
  }

  /** GeoJSON pays (110 m) mutualisé carte + étiquettes. */
  private loadNe110Admin0CountriesParsedOnce(): Promise<boolean> {
    if (this.admin0CountriesParsed) {
      return Promise.resolve(true);
    }
    if (this.admin0CountriesLoadPromise) {
      return this.admin0CountriesLoadPromise;
    }
    this.admin0CountriesOverlayLoading = true;
    this.admin0CountriesOverlayFailed = false;
    this.cdr.markForCheck();
    const inflight = (async (): Promise<boolean> => {
      try {
        const text = await firstValueFrom(
          this.http.get(this.globeNe110Admin0CountriesUrl(), { responseType: 'text' }).pipe(timeout(120000))
        );
        this.admin0CountriesParsed = JSON.parse(text as string) as unknown;
        this.admin0CountriesOverlayFailed = false;
        return true;
      } catch {
        this.admin0CountriesOverlayFailed = true;
        return false;
      } finally {
        this.admin0CountriesOverlayLoading = false;
        this.admin0CountriesLoadPromise = null;
        this.cdr.markForCheck();
      }
    })();
    this.admin0CountriesLoadPromise = inflight;
    return inflight;
  }

  private async ensureAdmin0CountryLayersLoadedAndBuilt(): Promise<void> {
    if ((!this.politicalMapEnabled && !this.countryLabelsEnabled) || !this.globeSurfaceReady || !this.earthMesh) {
      return;
    }
    const ok = await this.loadNe110Admin0CountriesParsedOnce();
    if (!ok || !this.admin0CountriesParsed || !this.earthMesh) {
      return;
    }
    if (this.politicalMapEnabled && !this.politicalMapMesh) {
      this.rebuildPoliticalMapFromParsed(this.admin0CountriesParsed);
    }
    if (this.countryLabelsEnabled && !this.countryLabelsGroup) {
      this.rebuildCountryLabelsFromParsed(this.admin0CountriesParsed);
    }
  }

  private rebuildPoliticalMapFromParsed(data: unknown): void {
    const earth = this.earthMesh;
    this.disposePoliticalMapOverlay();
    if (!this.politicalMapEnabled || !earth || !WorldGlobeComponent.isGeoJsonFeatureCollectionLike(data)) {
      return;
    }
    const feats = WorldGlobeComponent.readGeoJsonFeaturesArray(data.features);
    const positions: number[] = [];
    const colors: number[] = [];
    const triBudget = { n: 0 };
    for (const f of feats) {
      if (triBudget.n >= GLOBE_ADMIN0_MAX_FAN_TRIANGLES) {
        break;
      }
      if (!WorldGlobeComponent.isGeoJsonFeatureLike(f)) {
        continue;
      }
      const geom = (f as { geometry?: unknown }).geometry;
      if (!geom || typeof geom !== 'object') {
        continue;
      }
      const propsRaw = (f as { properties?: unknown }).properties;
      const props =
        propsRaw !== null && typeof propsRaw === 'object' ? (propsRaw as Record<string, unknown>) : null;
      const fill = props ? WorldGlobeComponent.inferPoliticalRgb(props) : new THREE.Color(0xb8bdc6);
      WorldGlobeComponent.appendPoliticalFansForGeometry(
        geom as { type?: string; coordinates?: unknown; geometries?: unknown[] },
        GLOBE_POLITICAL_FILL_RADIUS,
        fill,
        positions,
        colors,
        triBudget,
        GLOBE_ADMIN0_MAX_FAN_TRIANGLES
      );
    }
    if (positions.length < 9) {
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colors), 3));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'PoliticalMapAdmin0110';
    mesh.renderOrder = 1;
    earth.add(mesh);
    this.politicalMapMesh = mesh;
  }

  private rebuildCountryLabelsFromParsed(data: unknown): void {
    const earth = this.earthMesh;
    this.disposeCountryLabelsOverlay();
    if (!this.countryLabelsEnabled || !earth || !WorldGlobeComponent.isGeoJsonFeatureCollectionLike(data)) {
      return;
    }
    const feats = WorldGlobeComponent.readGeoJsonFeaturesArray(data.features);
    const group = new THREE.Group();
    group.name = 'CountryLabelsAdmin0110';
    for (const f of feats) {
      if (!WorldGlobeComponent.isGeoJsonFeatureLike(f)) {
        continue;
      }
      const propsRaw = (f as { properties?: unknown }).properties;
      const props =
        propsRaw !== null && typeof propsRaw === 'object' ? (propsRaw as Record<string, unknown>) : null;
      if (!props) {
        continue;
      }
      const lon = Number(props['LABEL_X']);
      const lat = Number(props['LABEL_Y']);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        continue;
      }
      const name = this.pickLocalizedCountryName(props);
      const sprite = WorldGlobeComponent.createCountryLabelSprite(name);
      if (!sprite) {
        continue;
      }
      sprite.userData['countryLabelName'] = name;
      sprite.renderOrder = 4;
      const p = WorldGlobeComponent.latLonToVector3(lat, lon, GLOBE_COUNTRY_LABEL_RADIUS);
      sprite.position.copy(p);
      group.add(sprite);
    }
    if (!group.children.length) {
      return;
    }
    earth.add(group);
    this.countryLabelsGroup = group;
  }

  private pickLocalizedCountryName(properties: Record<string, unknown>): string {
    const rawLang = (
      ((this.translate.currentLang || this.translate.defaultLang || 'en') ?? 'en') as string
    ).toLowerCase();
    const lc = (rawLang.split(/[-_]/)[0] ?? 'en').toLowerCase();
    const NAME_KEY_SPECIAL: Record<string, string> = {
      zh: 'NAME_ZH',
      tw: 'NAME_ZHT',
      cn: 'NAME_ZH',
      jp: 'NAME_JA',
      ja: 'NAME_JA',
      ko: 'NAME_KO',
      in: 'NAME_HI'
    };
    const primaryKey = NAME_KEY_SPECIAL[lc] ?? `NAME_${lc.toUpperCase()}`;
    const cand = properties[primaryKey];
    const fromLocalized = cand != null ? String(cand).trim() : '';
    if (fromLocalized.length > 0) {
      return fromLocalized;
    }
    const en = properties['NAME_EN'];
    const fromEn = en != null ? String(en).trim() : '';
    if (fromEn.length > 0) {
      return fromEn;
    }
    const admin = properties['ADMIN'] ?? properties['NAME'] ?? properties['BRK_NAME'] ?? '';
    return String(admin).trim();
  }

  private static truncateCountryLabel(raw: string, maxChars: number): string {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (t.length <= maxChars) {
      return t;
    }
    if (maxChars <= 1) {
      return '…';
    }
    return t.slice(0, maxChars - 1).trimEnd() + '…';
  }

  /** Pastilles texte billboard ; retour null si environnement Canvas indisponible. */
  private static createCountryLabelSprite(displayRaw: string): THREE.Sprite | null {
    const display = WorldGlobeComponent.truncateCountryLabel(displayRaw, 44);
    if (!display) {
      return null;
    }
    const canvas = document.createElement('canvas');
    const scaleCss = Math.min(Math.max(Math.floor(window.devicePixelRatio || 1), 1), 2);
    const ctxMaybe = canvas.getContext('2d');
    if (!ctxMaybe) {
      return null;
    }
    const ctx = ctxMaybe;
    const fontPx = Math.round(20 * scaleCss);
    ctx.font = `600 ${fontPx}px Segoe UI,Roboto,Helvetica,Arial,sans-serif`;
    const maxTextPx = Math.floor(492 * scaleCss);
    let text = display;
    while (text.length > 2 && ctx.measureText(text).width > maxTextPx) {
      text = WorldGlobeComponent.truncateCountryLabel(text, text.length - 2);
    }
    const measured = ctx.measureText(text).width + Math.floor(22 * scaleCss);
    canvas.width = Math.max(96, Math.min(Math.ceil(measured), 640 * scaleCss));
    canvas.height = Math.ceil(42 * scaleCss);
    ctx.font = `600 ${fontPx}px Segoe UI,Roboto,Helvetica,Arial,sans-serif`;
    ctx.fillStyle = 'rgba(6,22,52,0.58)';
    const rPx = Math.floor(11 * scaleCss);
    ctx.beginPath();
    ctx.moveTo(rPx, 0);
    ctx.lineTo(canvas.width - rPx, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, rPx);
    ctx.lineTo(canvas.width, canvas.height - rPx);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - rPx, canvas.height);
    ctx.lineTo(rPx, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - rPx);
    ctx.lineTo(0, rPx);
    ctx.quadraticCurveTo(0, 0, rPx, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,226,255,0.22)';
    ctx.lineWidth = Math.max(1, scaleCss);
    ctx.stroke();
    ctx.fillStyle = '#e9f5ff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, Math.floor(12 * scaleCss), canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      opacity: 0.94
    });
    const sprite = new THREE.Sprite(mat);
    const h = GLOBE_COUNTRY_LABEL_SPRITE_WORLD_H;
    sprite.center.set(0.5, 0.45);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(aspect * h, h, 1);
    sprite.userData['countryLabelBase'] = { w: aspect * h, h };
    return sprite;
  }

  /** Pastille date/heure pour la trace ISS historique (billboard). */
  private static createIssTraceDateLabelSprite(displayRaw: string): THREE.Sprite | null {
    const display = displayRaw.trim();
    if (!display) {
      return null;
    }
    const canvas = document.createElement('canvas');
    const scaleCss = Math.min(Math.max(Math.floor(window.devicePixelRatio || 1), 1), 2);
    const ctxMaybe = canvas.getContext('2d');
    if (!ctxMaybe) {
      return null;
    }
    const ctx = ctxMaybe;
    const fontPx = Math.round(17 * scaleCss);
    ctx.font = `600 ${fontPx}px Segoe UI,Roboto,Helvetica,Arial,sans-serif`;
    const measured = ctx.measureText(display).width + Math.floor(18 * scaleCss);
    canvas.width = Math.max(72, Math.min(Math.ceil(measured), 420 * scaleCss));
    canvas.height = Math.ceil(34 * scaleCss);
    ctx.font = `600 ${fontPx}px Segoe UI,Roboto,Helvetica,Arial,sans-serif`;
    ctx.fillStyle = 'rgba(42,22,6,0.62)';
    const rPx = Math.floor(9 * scaleCss);
    ctx.beginPath();
    ctx.moveTo(rPx, 0);
    ctx.lineTo(canvas.width - rPx, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, rPx);
    ctx.lineTo(canvas.width, canvas.height - rPx);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - rPx, canvas.height);
    ctx.lineTo(rPx, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - rPx);
    ctx.lineTo(0, rPx);
    ctx.quadraticCurveTo(0, 0, rPx, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,180,100,0.35)';
    ctx.lineWidth = Math.max(1, scaleCss);
    ctx.stroke();
    ctx.fillStyle = '#ffe8cc';
    ctx.textBaseline = 'middle';
    ctx.fillText(display, Math.floor(10 * scaleCss), canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      opacity: 0.92
    });
    const sprite = new THREE.Sprite(mat);
    const h = GLOBE_ISS_HISTORICAL_DATE_LABEL_SPRITE_WORLD_H;
    sprite.center.set(0.5, 0.45);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(aspect * h, h, 1);
    sprite.userData['issTraceDateLabelBase'] = { w: aspect * h, h };
    return sprite;
  }

  private static inferPoliticalRgb(properties: Record<string, unknown>): THREE.Color {
    const rawMc =
      Number(properties['MAPCOLOR13']) ||
      Number(properties['MAPCOLOR9']) ||
      Number(properties['MAPCOLOR8']) ||
      Number(properties['MAPCOLOR7']);
    let idx: number;
    if (Number.isFinite(rawMc) && rawMc !== 0) {
      idx = Math.abs(Math.floor(rawMc));
    } else {
      let h = 0;
      const tag = String(properties['ADM0_A3'] ?? properties['ISO_A3'] ?? properties['ADM0_ISO'] ?? 'zz');
      for (let i = 0; i < tag.length; i++) {
        h = (((h << 5) - h + tag.charCodeAt(i)) | 0) >>> 0;
      }
      idx = h >>> 0;
    }
    const hex = GLOBE_POLITICAL_HEX_PALETTE[idx % GLOBE_POLITICAL_HEX_PALETTE.length] ?? 0x9bbbd4;
    return new THREE.Color(hex);
  }

  private static lonLatOuterRingSubs(lonLatRing: number[][], maxCorners: number): [number, number][] {
    if (!lonLatRing?.length || maxCorners < 3) {
      return [];
    }
    let upto = lonLatRing.length;
    const first = lonLatRing[0];
    const last = lonLatRing[upto - 1];
    if (
      upto > 3 &&
      first &&
      last &&
      first.length >= 2 &&
      last.length >= 2 &&
      first[0] === last[0] &&
      first[1] === last[1]
    ) {
      upto--;
    }
    if (upto < 3) {
      return [];
    }
    const stride = Math.max(1, Math.ceil(upto / maxCorners));
    const out: [number, number][] = [];
    for (let i = 0; i < upto && out.length < maxCorners; i += stride) {
      const pt = lonLatRing[i];
      if (!pt || pt.length < 2) {
        continue;
      }
      const lon = pt[0];
      const lat = pt[1];
      if (![lon, lat].every((x) => Number.isFinite(x)) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        continue;
      }
      out.push([lon, lat]);
    }
    if (out.length < 3) {
      return [];
    }
    return out;
  }

  /** Ramène une longitude (°) dans ]−180, 180] après triangulation sur meridians « déroulés ». */
  private static wrapLongitudeDegrees(lonDeg: number): number {
    if (!Number.isFinite(lonDeg)) {
      return 0;
    }
    let x = lonDeg;
    while (x > 180) x -= 360;
    while (x < -180) x += 360;
    return x;
  }

  /**
   * Dérive les longitudes le long d’un anneau pour qu’elles varient de façon continue (sans saut fictif
   * de 360°). Indispensable près de l’antméridien : sinon earcut voit une barre de 358° de large.
   */
  private static unwrapLonAlongRing(ring: number[][]): number[][] {
    if (!ring?.length) {
      return [];
    }
    const out: number[][] = [];
    let prevLon = ring[0][0];
    out.push([prevLon, ring[0][1]]);
    for (let i = 1; i < ring.length; i++) {
      const pt = ring[i];
      if (!pt || pt.length < 2) {
        continue;
      }
      let lon = pt[0];
      const lat = pt[1];
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
      out.push([lon, lat]);
      prevLon = lon;
    }
    return out;
  }

  /**
   * Anneaux GeoJSON (lon, lat) → plat + indices de trous pour earcut.
   * Premier anneau = extérieur, suivants = trous (lacs, etc.).
   */
  private static flattenLonLatRingsForEarcut(rings: number[][][]): { vertices: number[]; holeIndices: number[] } {
    const vertices: number[] = [];
    const holeIndices: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      if (!ring?.length) {
        continue;
      }
      if (r > 0) {
        holeIndices.push(vertices.length / 2);
      }
      let n = ring.length;
      while (
        n > 1 &&
        ring[0][0] === ring[n - 1][0] &&
        ring[0][1] === ring[n - 1][1]
      ) {
        n--;
      }
      for (let j = 0; j < n; j++) {
        vertices.push(ring[j][0], ring[j][1]);
      }
    }
    return { vertices, holeIndices };
  }

  /**
   * Même enchaînement que {@link flattenLonLatRingsForEarcut}, mais chaque sommet est projeté dans le plan
   * tangent à la sphère (base orthonormée au « centre de masse » de l’anneau extérieur). Earcut sur (u,v)
   * évite l’étirement extrême du plan équirectangulaire aux pôles (artefacts en étoile / faux triangles).
   * Retourne des positions monde déjà à rayon {@link sphereR} alignées sur les indices earcut.
   */
  private static flattenLonLatRingsForTangentPlaneEarcut(
    ringsPlanar: number[][][],
    sphereR: number
  ): { vertices: number[]; holeIndices: number[]; xyz: number[] } | null {
    if (!ringsPlanar?.length) {
      return null;
    }
    const outer = ringsPlanar[0];
    if (!outer?.length) {
      return null;
    }
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const pt of outer) {
      if (!pt || pt.length < 2) {
        continue;
      }
      const lon = WorldGlobeComponent.wrapLongitudeDegrees(pt[0]);
      const lat = pt[1];
      if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
        continue;
      }
      const p = WorldGlobeComponent.latLonToVector3(lat, lon, 1);
      sx += p.x;
      sy += p.y;
      sz += p.z;
    }
    const cent = new THREE.Vector3(sx, sy, sz);
    if (cent.lengthSq() < 1e-14) {
      return null;
    }
    cent.normalize();
    const refUp = Math.abs(cent.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const e1 = new THREE.Vector3().crossVectors(refUp, cent);
    if (e1.lengthSq() < 1e-14) {
      e1.crossVectors(new THREE.Vector3(0, 0, 1), cent);
    }
    e1.normalize();
    const e2 = new THREE.Vector3().crossVectors(cent, e1).normalize();

    const vertices: number[] = [];
    const holeIndices: number[] = [];
    const xyz: number[] = [];

    for (let r = 0; r < ringsPlanar.length; r++) {
      const ring = ringsPlanar[r];
      if (!ring?.length) {
        continue;
      }
      if (r > 0) {
        holeIndices.push(vertices.length / 2);
      }
      let n = ring.length;
      while (
        n > 1 &&
        ring[0][0] === ring[n - 1][0] &&
        ring[0][1] === ring[n - 1][1]
      ) {
        n--;
      }
      for (let j = 0; j < n; j++) {
        const lon = WorldGlobeComponent.wrapLongitudeDegrees(ring[j][0]);
        const lat = ring[j][1];
        if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
          return null;
        }
        const pu = WorldGlobeComponent.latLonToVector3(lat, lon, 1);
        const u = pu.dot(e1);
        const v = pu.dot(e2);
        vertices.push(u, v);
        xyz.push(pu.x * sphereR, pu.y * sphereR, pu.z * sphereR);
      }
    }
    if (vertices.length < 6) {
      return null;
    }
    return { vertices, holeIndices, xyz };
  }

  /** Remplissage pays / lacs / fuseaux : triangulation 2D (lon/lat) puis projection sphère — évite les éventails invalides. */
  private static appendPoliticalEarcutForPolygonRings(
    ringsRaw: number[][][],
    sphereR: number,
    fillRgb: THREE.Color,
    positionsOut: number[],
    colorsOut: number[],
    triBudget: { n: number },
    triangleCap: number,
    ringMaxCorners: number,
    triangulation: 'lonlat' | 'tangentPlane' = 'lonlat'
  ): void {
    if (triBudget.n >= triangleCap || !ringsRaw?.length) {
      return;
    }
    const ringsSub: number[][][] = [];
    for (let ri = 0; ri < ringsRaw.length; ri++) {
      const subs = WorldGlobeComponent.lonLatOuterRingSubs(ringsRaw[ri], ringMaxCorners);
      if (subs.length >= 3) {
        ringsSub.push(subs.map((p) => [p[0], p[1]]));
      } else if (ri === 0) {
        return;
      }
    }
    if (!ringsSub.length) {
      return;
    }
    const ringsPlanar = ringsSub.map((ring) => WorldGlobeComponent.unwrapLonAlongRing(ring));
    const rC = fillRgb.r;
    const gC = fillRgb.g;
    const bC = fillRgb.b;

    if (triangulation === 'tangentPlane') {
      const tang = WorldGlobeComponent.flattenLonLatRingsForTangentPlaneEarcut(ringsPlanar, sphereR);
      if (tang && tang.vertices.length >= 6) {
        const tri = earcut(tang.vertices, tang.holeIndices.length > 0 ? tang.holeIndices : undefined, 2);
        if (tri.length) {
          const xyz = tang.xyz;
          for (let t = 0; t < tri.length && triBudget.n < triangleCap; t += 3) {
            for (let k = 0; k < 3; k++) {
              const vi = tri[t + k] * 3;
              positionsOut.push(xyz[vi], xyz[vi + 1], xyz[vi + 2]);
              colorsOut.push(rC, gC, bC);
            }
            triBudget.n++;
          }
          return;
        }
      }
    }

    const { vertices, holeIndices } = WorldGlobeComponent.flattenLonLatRingsForEarcut(ringsPlanar);
    if (vertices.length < 6) {
      return;
    }
    const triangles = earcut(vertices, holeIndices.length > 0 ? holeIndices : undefined, 2);
    if (!triangles.length) {
      return;
    }
    for (let t = 0; t < triangles.length && triBudget.n < triangleCap; t += 3) {
      const ia = triangles[t] * 2;
      const ib = triangles[t + 1] * 2;
      const ic = triangles[t + 2] * 2;
      const latA = vertices[ia + 1];
      const latB = vertices[ib + 1];
      const latC = vertices[ic + 1];
      const va = WorldGlobeComponent.latLonToVector3(
        latA,
        WorldGlobeComponent.wrapLongitudeDegrees(vertices[ia]),
        sphereR
      );
      const vb = WorldGlobeComponent.latLonToVector3(
        latB,
        WorldGlobeComponent.wrapLongitudeDegrees(vertices[ib]),
        sphereR
      );
      const vc = WorldGlobeComponent.latLonToVector3(
        latC,
        WorldGlobeComponent.wrapLongitudeDegrees(vertices[ic]),
        sphereR
      );
      for (const p of [va, vb, vc]) {
        positionsOut.push(p.x, p.y, p.z);
        colorsOut.push(rC, gC, bC);
      }
      triBudget.n++;
    }
  }

  private static appendPoliticalFansForGeometry(
    geometry: { type?: string; coordinates?: unknown; geometries?: unknown[] },
    sphereRadius: number,
    fillRgb: THREE.Color,
    positionsOut: number[],
    colorsOut: number[],
    triBudget: { n: number },
    triangleCap: number,
    ringMaxCorners: number = GLOBE_ADMIN0_RING_MAX_VERTS,
    triangulation: 'lonlat' | 'tangentPlane' = 'lonlat'
  ): void {
    if (triBudget.n >= triangleCap) {
      return;
    }
    const type = geometry.type;
    switch (type) {
      case 'Polygon': {
        const polys = geometry.coordinates as number[][][] | undefined;
        if (!polys?.length) {
          break;
        }
        WorldGlobeComponent.appendPoliticalEarcutForPolygonRings(
          polys,
          sphereRadius,
          fillRgb,
          positionsOut,
          colorsOut,
          triBudget,
          triangleCap,
          ringMaxCorners,
          triangulation
        );
        break;
      }
      case 'MultiPolygon':
        for (const poly of (geometry.coordinates as number[][][][] | undefined) ?? []) {
          if (triBudget.n >= triangleCap) {
            break;
          }
          if (poly?.length) {
            WorldGlobeComponent.appendPoliticalEarcutForPolygonRings(
              poly,
              sphereRadius,
              fillRgb,
              positionsOut,
              colorsOut,
              triBudget,
              triangleCap,
              ringMaxCorners,
              triangulation
            );
          }
        }
        break;
      case 'GeometryCollection':
        for (const child of geometry.geometries ?? []) {
          if (triBudget.n >= triangleCap) {
            break;
          }
          if (!child || typeof child !== 'object') {
            continue;
          }
          WorldGlobeComponent.appendPoliticalFansForGeometry(
            child as { type?: string; coordinates?: unknown; geometries?: unknown[] },
            sphereRadius,
            fillRgb,
            positionsOut,
            colorsOut,
            triBudget,
            triangleCap,
            ringMaxCorners,
            triangulation
          );
        }
        break;
      default:
        break;
    }
  }

  private static inferTimeZoneRgb(properties: Record<string, unknown>): THREE.Color {
    const raw = Number(properties['map_color6'] ?? properties['map_color8']);
    const idx =
      Number.isFinite(raw) && raw !== 0
        ? Math.abs(Math.floor(raw)) % GLOBE_TIMEZONE_HEX_PALETTE.length
        : 0;
    return new THREE.Color(GLOBE_TIMEZONE_HEX_PALETTE[idx] ?? 0xc9ddf0);
  }

  private buildNeTintFanMeshFromData(
    data: unknown,
    sphereR: number,
    fillRgb: THREE.Color,
    triCap: number,
    meshName: string,
    layerOpacity: number,
    ringMaxCorners: number = GLOBE_ADMIN0_RING_MAX_VERTS
  ): THREE.Mesh | null {
    if (!WorldGlobeComponent.isGeoJsonFeatureCollectionLike(data)) {
      return null;
    }
    const positions: number[] = [];
    const colors: number[] = [];
    const triBudget = { n: 0 };
    const feats = WorldGlobeComponent.readGeoJsonFeaturesArray(data.features);
    for (const f of feats) {
      if (triBudget.n >= triCap) {
        break;
      }
      if (!WorldGlobeComponent.isGeoJsonFeatureLike(f)) {
        continue;
      }
      const geom = (f as { geometry?: unknown }).geometry;
      if (!geom || typeof geom !== 'object') {
        continue;
      }
      WorldGlobeComponent.appendPoliticalFansForGeometry(
        geom as { type?: string; coordinates?: unknown; geometries?: unknown[] },
        sphereR,
        fillRgb,
        positions,
        colors,
        triBudget,
        triCap,
        ringMaxCorners
      );
    }
    if (positions.length < 9) {
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colors), 3));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: layerOpacity,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = meshName;
    mesh.renderOrder = 0;
    return mesh;
  }

  private buildTimeZonesMeshFromData(data: unknown): THREE.Mesh | null {
    if (!WorldGlobeComponent.isGeoJsonFeatureCollectionLike(data)) {
      return null;
    }
    const positions: number[] = [];
    const colors: number[] = [];
    const triBudget = { n: 0 };
    const feats = WorldGlobeComponent.readGeoJsonFeaturesArray(data.features);
    for (const f of feats) {
      if (triBudget.n >= GLOBE_TIMEZONE_MAX_FAN_TRIANGLES) {
        break;
      }
      if (!WorldGlobeComponent.isGeoJsonFeatureLike(f)) {
        continue;
      }
      const propsRaw = (f as { properties?: unknown }).properties;
      const props =
        propsRaw && typeof propsRaw === 'object' ? (propsRaw as Record<string, unknown>) : {};
      const fill = WorldGlobeComponent.inferTimeZoneRgb(props);
      const geom = (f as { geometry?: unknown }).geometry;
      if (!geom || typeof geom !== 'object') {
        continue;
      }
      WorldGlobeComponent.appendPoliticalFansForGeometry(
        geom as { type?: string; coordinates?: unknown; geometries?: unknown[] },
        GLOBE_TIMEZONE_FILL_RADIUS,
        fill,
        positions,
        colors,
        triBudget,
        GLOBE_TIMEZONE_MAX_FAN_TRIANGLES,
        GLOBE_TIMEZONE_RING_MAX_VERTS,
        'tangentPlane'
      );
    }
    if (positions.length < 9) {
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colors), 3));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'TimeZonesNe10m';
    return mesh;
  }

  private buildCitiesPointsFromData(data: unknown): THREE.Points | null {
    if (!WorldGlobeComponent.isGeoJsonFeatureCollectionLike(data)) {
      return null;
    }
    const positions: number[] = [];
    const feats = WorldGlobeComponent.readGeoJsonFeaturesArray(data.features);
    for (const f of feats) {
      if (!WorldGlobeComponent.isGeoJsonFeatureLike(f)) {
        continue;
      }
      const g = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry;
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) {
        continue;
      }
      const c = g.coordinates as number[];
      if (c.length < 2) {
        continue;
      }
      const lon = c[0];
      const lat = c[1];
      if (![lon, lat].every((x) => Number.isFinite(x)) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        continue;
      }
      const v = WorldGlobeComponent.latLonToVector3(lat, lon, GLOBE_CITIES_POINTS_RADIUS);
      positions.push(v.x, v.y, v.z);
    }
    if (!positions.length) {
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffd060,
      size: 0.016,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'PopulatedPlacesNe110Simple';
    return pts;
  }

  private async ensureGeographicLinesLoaded(): Promise<void> {
    if (!this.geographicLinesEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.geographicLinesOverlayGroup) {
      return;
    }
    if (this.geographicLinesBuildInFlight) {
      return;
    }
    this.geographicLinesBuildInFlight = true;
    this.geographicLinesLoading = true;
    this.geographicLinesFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe110GeographicLinesUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.geographicLinesEnabled || !this.earthMesh) {
        return;
      }
      const group = this.createGeoJsonLineSegmentsGroupFromData(
        parsed,
        GLOBE_GEOGRAPHIC_LINES_RADIUS,
        MAX_GEOGRAPHIC_LINE_SEGMENTS,
        0xf0d878,
        0.78,
        'GeographicLinesNe110'
      );
      const ok = !!(group && this.geographicLinesEnabled && this.earthMesh);
      this.geographicLinesFailed = !ok;
      if (ok && group) {
        this.earthMesh.add(group);
        this.geographicLinesOverlayGroup = group;
      }
    } catch {
      this.geographicLinesFailed = true;
    } finally {
      this.geographicLinesLoading = false;
      this.geographicLinesBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private async ensureRiversLoaded(): Promise<void> {
    if (!this.riversEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.riversOverlayGroup) {
      return;
    }
    if (this.riversBuildInFlight) {
      return;
    }
    this.riversBuildInFlight = true;
    this.riversOverlayLoading = true;
    this.riversOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe50mRiversLakeCenterlinesUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.riversEnabled || !this.earthMesh) {
        return;
      }
      const group = this.createGeoJsonLineSegmentsGroupFromData(
        parsed,
        GLOBE_RIVERS_LINE_RADIUS,
        MAX_RIVERS_LINE_SEGMENTS,
        0x6ec8ff,
        0.72,
        'RiversLakeCenterlinesNe50'
      );
      const ok = !!(group && this.riversEnabled && this.earthMesh);
      this.riversOverlayFailed = !ok;
      if (ok && group) {
        this.earthMesh.add(group);
        this.riversOverlayGroup = group;
      }
    } catch {
      this.riversOverlayFailed = true;
    } finally {
      this.riversOverlayLoading = false;
      this.riversBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private async ensureLakesLoaded(): Promise<void> {
    if (!this.lakesEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.lakesMesh) {
      return;
    }
    if (this.lakesBuildInFlight) {
      return;
    }
    this.lakesBuildInFlight = true;
    this.lakesOverlayLoading = true;
    this.lakesOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe10mLakesUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.lakesEnabled || !this.earthMesh) {
        return;
      }
      this.disposeLakesMesh();
      const mesh = this.buildNeTintFanMeshFromData(
        parsed,
        GLOBE_LAKES_FILL_RADIUS,
        new THREE.Color(0x3d7ea8),
        GLOBE_LAKES_MAX_FAN_TRIANGLES,
        'LakesNe10',
        0.52,
        GLOBE_LAKES_RING_MAX_VERTS
      );
      const ok = !!(mesh && this.lakesEnabled && this.earthMesh);
      this.lakesOverlayFailed = !ok;
      if (ok && mesh) {
        this.earthMesh.add(mesh);
        this.lakesMesh = mesh;
      }
    } catch {
      this.lakesOverlayFailed = true;
    } finally {
      this.lakesOverlayLoading = false;
      this.lakesBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private async ensureGlaciersLoaded(): Promise<void> {
    if (!this.glaciersEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.glaciersMesh) {
      return;
    }
    if (this.glaciersBuildInFlight) {
      return;
    }
    this.glaciersBuildInFlight = true;
    this.glaciersOverlayLoading = true;
    this.glaciersOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe110GlaciatedAreasUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.glaciersEnabled || !this.earthMesh) {
        return;
      }
      this.disposeGlaciersMesh();
      const mesh = this.buildNeTintFanMeshFromData(
        parsed,
        GLOBE_GLACIER_FILL_RADIUS,
        new THREE.Color(0xe8fbff),
        GLOBE_GLACIER_MAX_FAN_TRIANGLES,
        'GlaciersNe110',
        0.58
      );
      const ok = !!(mesh && this.glaciersEnabled && this.earthMesh);
      this.glaciersOverlayFailed = !ok;
      if (ok && mesh) {
        this.earthMesh.add(mesh);
        this.glaciersMesh = mesh;
      }
    } catch {
      this.glaciersOverlayFailed = true;
    } finally {
      this.glaciersOverlayLoading = false;
      this.glaciersBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private async ensureCitiesLoaded(): Promise<void> {
    if (!this.citiesEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.citiesPoints) {
      return;
    }
    if (this.citiesBuildInFlight) {
      return;
    }
    this.citiesBuildInFlight = true;
    this.citiesOverlayLoading = true;
    this.citiesOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe110PopulatedPlacesSimpleUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.citiesEnabled || !this.earthMesh) {
        return;
      }
      this.disposeCitiesPoints();
      const pts = this.buildCitiesPointsFromData(parsed);
      const ok = !!(pts && this.citiesEnabled && this.earthMesh);
      this.citiesOverlayFailed = !ok;
      if (ok && pts) {
        this.earthMesh.add(pts);
        this.citiesPoints = pts;
      }
    } catch {
      this.citiesOverlayFailed = true;
    } finally {
      this.citiesOverlayLoading = false;
      this.citiesBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private async ensureTimeZonesLoaded(): Promise<void> {
    if (!this.timeZonesEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.timeZonesMesh) {
      return;
    }
    if (this.timeZonesBuildInFlight) {
      return;
    }
    this.timeZonesBuildInFlight = true;
    this.timeZonesOverlayLoading = true;
    this.timeZonesOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe10mTimeZonesUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.timeZonesEnabled || !this.earthMesh) {
        return;
      }
      this.disposeTimeZonesMesh();
      const mesh = this.buildTimeZonesMeshFromData(parsed);
      const ok = !!(mesh && this.timeZonesEnabled && this.earthMesh);
      this.timeZonesOverlayFailed = !ok;
      if (ok && mesh) {
        this.earthMesh.add(mesh);
        this.timeZonesMesh = mesh;
      }
    } catch {
      this.timeZonesOverlayFailed = true;
    } finally {
      this.timeZonesOverlayLoading = false;
      this.timeZonesBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private async ensureCountryBordersLoaded(): Promise<void> {
    if (!this.countryBordersEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.bordersOverlayGroup) {
      return;
    }
    if (this.bordersBuildInFlight) {
      return;
    }
    this.bordersBuildInFlight = true;
    this.bordersOverlayLoading = true;
    this.bordersOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe110BoundariesLandUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.countryBordersEnabled || !this.earthMesh) {
        return;
      }
      const builtOk = this.buildCountryBordersFromParsedGeo(parsed);
      this.bordersOverlayFailed = !builtOk;
    } catch {
      this.bordersOverlayFailed = true;
    } finally {
      this.bordersOverlayLoading = false;
      this.bordersBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private createGeoJsonLineSegmentsGroupFromData(
    data: unknown,
    rLine: number,
    maxSegs: number,
    color: number,
    opacity: number,
    groupName: string
  ): THREE.Group | null {
    let features: unknown[] = [];
    if (WorldGlobeComponent.isGeoJsonFeatureCollectionLike(data)) {
      features = WorldGlobeComponent.readGeoJsonFeaturesArray(data.features);
    } else if (WorldGlobeComponent.isGeoJsonFeatureLike(data)) {
      features = [data];
    }
    const verts: number[] = [];
    const counter = { n: 0 };

    for (const f of features) {
      if (counter.n >= maxSegs) {
        break;
      }
      if (!WorldGlobeComponent.isGeoJsonFeatureLike(f)) {
        continue;
      }
      const geom = (f as { geometry?: unknown }).geometry;
      if (geom != null && typeof geom === 'object') {
        WorldGlobeComponent.appendBorderSegmentsForGeometry(
          geom as { type?: string; coordinates?: unknown; geometries?: unknown[] },
          rLine,
          verts,
          counter,
          maxSegs
        );
      }
    }

    if (!verts.length) {
      return null;
    }
    const group = new THREE.Group();
    group.name = groupName;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts), 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false
    });
    group.add(new THREE.LineSegments(geo, mat));
    return group;
  }

  private buildCountryBordersFromParsedGeo(data: unknown): boolean {
    if (!this.countryBordersEnabled || !this.earthMesh) {
      return false;
    }
    this.disposeCountryBordersOverlay();
    const group = this.createGeoJsonLineSegmentsGroupFromData(
      data,
      GLOBE_BORDERS_LINE_RADIUS,
      MAX_BORDER_LINE_SEGMENTS,
      0xe8eefc,
      0.72,
      'CountryBordersOverlay'
    );
    if (!group || !this.countryBordersEnabled || !this.earthMesh) {
      return false;
    }
    this.earthMesh.add(group);
    this.bordersOverlayGroup = group;
    return true;
  }

  private async ensureCoastlinesLoaded(): Promise<void> {
    if (!this.coastlinesEnabled || !this.earthMesh || !this.scene) {
      return;
    }
    if (this.coastlinesOverlayGroup) {
      return;
    }
    if (this.coastlinesBuildInFlight) {
      return;
    }
    this.coastlinesBuildInFlight = true;
    this.coastlinesOverlayLoading = true;
    this.coastlinesOverlayFailed = false;
    this.cdr.markForCheck();
    try {
      const text = await firstValueFrom(
        this.http.get(this.globeNe110CoastlineUrl(), { responseType: 'text' }).pipe(timeout(120000))
      );
      const parsed: unknown = JSON.parse(text as string);
      if (!this.coastlinesEnabled || !this.earthMesh) {
        return;
      }
      const builtOk = this.buildCoastlinesFromParsedGeo(parsed);
      this.coastlinesOverlayFailed = !builtOk;
    } catch {
      this.coastlinesOverlayFailed = true;
    } finally {
      this.coastlinesOverlayLoading = false;
      this.coastlinesBuildInFlight = false;
      this.cdr.markForCheck();
    }
  }

  private buildCoastlinesFromParsedGeo(data: unknown): boolean {
    if (!this.coastlinesEnabled || !this.earthMesh) {
      return false;
    }
    this.disposeCoastlinesOverlay();
    const group = this.createGeoJsonLineSegmentsGroupFromData(
      data,
      GLOBE_COASTLINE_LINE_RADIUS,
      MAX_COASTLINE_LINE_SEGMENTS,
      0x7ee3fa,
      0.62,
      'CoastlineOverlay110m'
    );
    if (!group || !this.coastlinesEnabled || !this.earthMesh) {
      return false;
    }
    this.earthMesh.add(group);
    this.coastlinesOverlayGroup = group;
    return true;
  }

  /** Grille ° géographiques (pas de téléchargement : isolignes approximées). */
  private ensureGraticuleOverlayBuilt(): void {
    if (!this.graticuleEnabled || !this.earthMesh) {
      return;
    }
    if (this.graticuleOverlayGroup) {
      return;
    }
    const group = WorldGlobeComponent.createGraticuleOverlayLineGroup(
      GLOBE_GRATICULE_RADIUS,
      GLOBE_GRATICULE_STEP_DEG,
      GLOBE_GRATICULE_MERIDIAN_LAT_STEP,
      GLOBE_GRATICULE_PARALLEL_LON_STEP,
      MAX_GRATICULE_LINE_SEGMENTS
    );
    this.earthMesh.add(group);
    this.graticuleOverlayGroup = group;
  }

  private static createGraticuleOverlayLineGroup(
    r: number,
    isoStepDeg: number,
    meridianLatStep: number,
    parallelLonStep: number,
    maxSegs: number
  ): THREE.Group {
    const verts: number[] = [];
    const c = { n: 0 };
    for (let lon = -180; lon < 180 && c.n < maxSegs; lon += isoStepDeg) {
      for (let lat = -87; lat < 87 && c.n < maxSegs; lat += meridianLatStep) {
        const latTo = Math.min(87, lat + meridianLatStep);
        WorldGlobeComponent.pushLonLatBorderSegment(lon, lat, lon, latTo, r, verts, c, maxSegs);
      }
    }
    for (let lat = -90 + isoStepDeg; lat <= 90 - isoStepDeg && c.n < maxSegs; lat += isoStepDeg) {
      for (let lon = -180; lon < 180 - parallelLonStep && c.n < maxSegs; lon += parallelLonStep) {
        WorldGlobeComponent.pushLonLatBorderSegment(lon, lat, lon + parallelLonStep, lat, r, verts, c, maxSegs);
      }
    }
    const group = new THREE.Group();
    group.name = 'GeographicGraticule';
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x4a9bdc,
      transparent: true,
      opacity: 0.42,
      depthWrite: false
    });
    group.add(new THREE.LineSegments(geo, mat));
    return group;
  }

  private static isGeoJsonFeatureCollectionLike(data: unknown): data is { features?: unknown } {
    return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'FeatureCollection';
  }

  private static isGeoJsonFeatureLike(data: unknown): data is Record<string, unknown> {
    return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'Feature';
  }

  private static readGeoJsonFeaturesArray(features: unknown): unknown[] {
    if (!Array.isArray(features)) {
      return [];
    }
    return features;
  }

  private static appendBorderSegmentsForGeometry(
    geometry: { type?: string; coordinates?: unknown; geometries?: unknown[] },
    r: number,
    verts: number[],
    counter: { n: number },
    maxSegs: number
  ): void {
    const type = geometry.type;
    switch (type) {
      case 'LineString':
        WorldGlobeComponent.pushLineStringBorderCoords(
          geometry.coordinates as number[][] | undefined,
          r,
          verts,
          counter,
          maxSegs
        );
        break;
      case 'MultiLineString':
        for (const line of (geometry.coordinates as number[][][]) ?? []) {
          WorldGlobeComponent.pushLineStringBorderCoords(line, r, verts, counter, maxSegs);
          if (counter.n >= maxSegs) break;
        }
        break;
      case 'Polygon':
        for (const ring of (geometry.coordinates as number[][][]) ?? []) {
          WorldGlobeComponent.pushPolygonRingCoords(ring, r, verts, counter, maxSegs);
          if (counter.n >= maxSegs) break;
        }
        break;
      case 'MultiPolygon':
        for (const poly of (geometry.coordinates as number[][][][]) ?? []) {
          if (counter.n >= maxSegs) break;
          for (const ring of poly) {
            WorldGlobeComponent.pushPolygonRingCoords(ring, r, verts, counter, maxSegs);
          }
        }
        break;
      case 'GeometryCollection':
        for (const child of geometry.geometries ?? []) {
          if (counter.n >= maxSegs) break;
          if (!child || typeof child !== 'object') continue;
          WorldGlobeComponent.appendBorderSegmentsForGeometry(
            child as { type?: string; coordinates?: unknown; geometries?: unknown[] },
            r,
            verts,
            counter,
            maxSegs
          );
        }
        break;
      default:
        break;
    }
  }

  private static pushLineStringBorderCoords(
    coords: number[][] | undefined,
    r: number,
    verts: number[],
    counter: { n: number },
    maxSegs: number
  ): void {
    if (!coords?.length) {
      return;
    }
    for (let i = 0; i < coords.length - 1 && counter.n < maxSegs; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
        continue;
      }
      WorldGlobeComponent.pushLonLatBorderSegment(a[0], a[1], b[0], b[1], r, verts, counter, maxSegs);
    }
  }

  private static pushPolygonRingCoords(
    ring: number[][] | undefined,
    r: number,
    verts: number[],
    counter: { n: number },
    maxSegs: number
  ): void {
    if (!ring?.length || ring.length < 2) {
      return;
    }
    const n = ring.length;
    let upto = n;
    const first = ring[0];
    const last = ring[n - 1];
    if (
      Array.isArray(first) &&
      Array.isArray(last) &&
      first.length >= 2 &&
      last.length >= 2 &&
      first[0] === last[0] &&
      first[1] === last[1]
    ) {
      upto = n - 1;
    }
    for (let i = 0; i < upto - 1 && counter.n < maxSegs; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      if (!a || !b || a.length < 2 || b.length < 2) {
        continue;
      }
      WorldGlobeComponent.pushLonLatBorderSegment(a[0], a[1], b[0], b[1], r, verts, counter, maxSegs);
    }
  }

  /** Plus court séparateur longitudinal (0…180 °). */
  private static shortestLonSeparationDegrees(lonA: number, lonB: number): number {
    const delta = ((((lonB - lonA + 540) % 360) + 360) % 360) - 180;
    return Math.abs(delta);
  }

  private static pushLonLatBorderSegment(
    lonA: number,
    latA: number,
    lonB: number,
    latB: number,
    r: number,
    verts: number[],
    counter: { n: number },
    maxSegs: number
  ): void {
    if (counter.n >= maxSegs) {
      return;
    }
    if (![lonA, latA, lonB, latB].every((x) => Number.isFinite(x))) {
      return;
    }
    if (Math.abs(latA) > 90 || Math.abs(latB) > 90) {
      return;
    }
    const dLon = WorldGlobeComponent.shortestLonSeparationDegrees(lonA, lonB);
    if (dLon > 88) {
      return;
    }
    if (Math.abs(latB - latA) > 170) {
      return;
    }
    const va = WorldGlobeComponent.latLonToVector3(latA, lonA, r);
    const vb = WorldGlobeComponent.latLonToVector3(latB, lonB, r);
    verts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
    counter.n++;
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
      } else if (obj instanceof THREE.Sprite) {
        const sm = obj.material;
        if (sm instanceof THREE.SpriteMaterial) {
          sm.map?.dispose?.();
          sm.dispose();
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
