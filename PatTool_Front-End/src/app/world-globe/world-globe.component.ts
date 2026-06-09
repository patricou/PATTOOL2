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
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, firstValueFrom, timeout } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { ApiService, IssAlertConfig, IssCompassCalibration } from '../services/api.service';
import { AirportIcaoEntry, AirportLookupService } from '../services/airport-lookup.service';
import { FlightRouteLookupService } from '../services/flight-route-lookup.service';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { environment } from '../../environments/environment';
import { Body, Equator, Observer, SiderealTime } from 'astronomy-engine';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
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
interface IssPassByPlaceResponse {
  status?: string;
  code?: string;
  message?: string;
  place?: { lat?: number; lon?: number; displayName?: string };
  nextPass?: { risetime?: number; duration?: number };
  passes?: {
    message?: string;
    response?: Array<{ risetime?: number; duration?: number }>;
  };
  candidates?: Array<{ lat: number; lon: number; displayName?: string }>;
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

/** Flux ISS en direct (Destination Orbite) — nouvel onglet navigateur. */
const ISS_LIVE_DESTINATION_ORBITE_URL =
	'https://destination-orbite.net/exploration/direct/en-direct-depuis-la-station-spatiale';
const ISS_LIVE_HD_DESTINATION_ORBITE_URL =
	'https://destination-orbite.net/exploration/direct/en-direct-hd-depuis-l-iss';
/**
 * IDs YouTube embarqués par Destination Orbite (balise lite-youtube sur leurs pages direct).
 * Standard : flux NASA officiel — https://www.youtube.com/watch?v=uwXgcTc8oY8
 * HD : https://www.youtube.com/watch?v=FuuC4dpSQ1M
 */
/** Page standard Destination Orbite → lite-youtube `uwXgcTc8oY8` (NASA officiel). */
const ISS_LIVE_YOUTUBE_VIDEO_ID = 'uwXgcTc8oY8';
/** Page HD Destination Orbite → lite-youtube `FuuC4dpSQ1M`. */
const ISS_LIVE_HD_YOUTUBE_VIDEO_ID = 'FuuC4dpSQ1M';

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
const GLOBE_ISS_TRAIL_COLOR = 0xffa040;
const GLOBE_ISS_TRAIL_OPACITY = 0.82;
/** Taille monde de l’icône ISS (vue de dessus, panneaux solaires). */
const GLOBE_ISS_ICON_WORLD_SIZE = 0.034;
const GLOBE_ISS_MARKER_COLOR = 0xffea00;
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
/** Intervalle par défaut entre deux appels Open Notify (secondes). */
const GLOBE_ISS_POLL_DEFAULT_SEC = 5;
const GLOBE_ISS_POLL_MIN_SEC = 5;
const GLOBE_ISS_POLL_MAX_SEC = 600;
/** Throttle du reverse-geocoding « survol » ISS : intervalle mini et déplacement mini avant un nouvel appel Nominatim. */
const GLOBE_ISS_OVER_MIN_INTERVAL_MS = 9000;
const GLOBE_ISS_OVER_MIN_MOVE_DEG = 0.25;
/** Demi-vie du recadrage caméra vers l’ISS (mode « centré sur l’ISS ») ; mouvement fluide, peu dépendant du framerate. */
const GLOBE_ISS_CAMERA_CENTER_HALF_LIFE_SEC = 0.34;

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
  imports: [CommonModule, FormsModule, TranslateModule, TraceViewerModalComponent],
  templateUrl: './world-globe.component.html',
  styleUrls: ['./world-globe.component.css']
})
export class WorldGlobeComponent implements AfterViewInit, OnDestroy {
  private readonly apiService = inject(ApiService);
  private readonly airportLookup = inject(AirportLookupService);
  private readonly flightRouteLookup = inject(FlightRouteLookupService);
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  @ViewChild('globeCanvasHost') globeCanvasHost?: ElementRef<HTMLElement>;
  @ViewChild('globeShell') globeShell?: ElementRef<HTMLElement>;
  /** Titre + panneau globe : cible préférée pour l’API Fullscreen (vrai plein écran navigateur). */
  @ViewChild('globeFsRoot') globeFsRoot?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceMount') globeTraceMount?: ElementRef<HTMLElement>;
  @ViewChild('globeTraceViewer') globeTraceViewer?: TraceViewerModalComponent;
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
    this.attachIssTickerSpeedObserver();
  }

  /** Mini-fenêtre ISS en direct (embed YouTube, même source que Destination Orbite). Affichée par défaut. */
  issLiveEmbedEnabled = true;
  issLivePiPFullscreen = false;
  readonly issLiveEmbedSafeUrl: SafeResourceUrl = this.buildIssLiveEmbedSafeUrl(ISS_LIVE_YOUTUBE_VIDEO_ID);
  /** Mini-fenêtre ISS HD — affichée par défaut aux côtés du flux standard. */
  issLiveHdEmbedEnabled = true;
  issLiveHdPiPFullscreen = false;
  readonly issLiveHdEmbedSafeUrl: SafeResourceUrl = this.buildIssLiveEmbedSafeUrl(ISS_LIVE_HD_YOUTUBE_VIDEO_ID);
  /** Capture image ISS en cours (copie ou partage WhatsApp, une fenêtre à la fois). */
  issPiPImageBusy: { variant: 'standard' | 'hd'; action: 'copy' | 'whatsapp' } | null = null;
  issPiPCopyFlash: { variant: 'standard' | 'hd'; ok: boolean } | null = null;
  issPiPWhatsAppFlash: { variant: 'standard' | 'hd'; ok: boolean } | null = null;
  private issPiPCopyFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private issPiPWhatsAppFlashTimer: ReturnType<typeof setTimeout> | null = null;

  showOptionsPanel = true;
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
  issOverlayEnabled = true;
  /**
   * Interrupteur maître d’affichage de la trace ISS : masque/affiche d’un coup la traînée temps réel
   * ET la trace historique (mêmes lignes orange). Les données ne sont pas effacées, seulement cachées.
   */
  issTraceVisible = true;
  /** Bandeau défilant lat/lon/altitude/vitesse ISS (page globe). */
  issTickerEnabled = true;
  /** Répétitions lat/lon/alt/vitesse par demi-piste (boucle marquee sans trou). */
  readonly issTickerMarqueeRepeats = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  /**
   * Durée (s) d’un cycle du bandeau défilant. Recalculée dynamiquement à partir de la largeur
   * réelle d’une demi-piste pour garder une vitesse de défilement CONSTANTE (px/s), quel que soit
   * le nombre d’infos affichées (ex. ajout des infos boussole qui allongent la piste).
   */
  issTickerDurationSec = 90;
  /** Vitesse de défilement cible du bandeau ISS, en pixels par seconde. */
  private static readonly ISS_TICKER_SPEED_PX_PER_SEC = 90;
  private issTickerHalfEl?: HTMLElement;
  private issTickerResizeObs?: ResizeObserver;
  /**
   * Garde le sous-point ISS au centre du globe (caméra réalignée à chaque frame ; le zoom est conservé).
   * Désactive temporairement la rotation automatique tant que l’option est active et qu’une position ISS est connue.
   */
  issKeepEarthCentered = true;
  /** Secondes entre deux rafraîchissements ISS (5–600, défaut 5). */
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
  issHistoricalTraceEnabled = true;
  issHistoricalTraceLoading = false;
  issHistoricalTraceFailed = false;
  /** Dates/heures le long de la trace historique ISS (activé par défaut). */
  issHistoricalTraceDatesEnabled = true;
  issHistoricalTraceClearInFlight = false;
  /** Server records ISS to MongoDB every 15 min even when no user has the globe open (persisted in MongoDB). */
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

  /* ----------------------------------------------------------------------- */
  /* Boussole ISS : modale « où regarder pour voir l’ISS » (azimut + élévation) */
  /* ----------------------------------------------------------------------- */
  /** Modale boussole ISS ouverte. */
  issCompassOpen = false;
  /** Position de l’observateur (GPS navigateur, ou point cliqué sur le globe en repli). */
  issCompassUserLat: number | null = null;
  issCompassUserLon: number | null = null;
  /** Précision GPS horizontale (m), si fournie. */
  issCompassUserAccuracyM: number | null = null;
  /** Source de la position observateur utilisée pour le calcul. */
  issCompassUserSource: 'gps' | 'picked' | null = null;
  /** Azimut vers le sous-point ISS (degrés, 0 = Nord, sens horaire). */
  issCompassAzimuthDeg: number | null = null;
  /** Angle d’élévation de l’ISS au-dessus de l’horizon (degrés ; < 0 = sous l’horizon). */
  issCompassElevationDeg: number | null = null;
  /** Distance orthodromique au sol jusqu’au sous-point ISS (km). */
  issCompassGroundDistanceKm: number | null = null;
  /** Distance directe observateur → ISS (km). */
  issCompassSlantRangeKm: number | null = null;
  /** Cap de l’appareil (degrés, 0 = Nord) issu des capteurs ; null si indisponible. */
  issCompassHeadingDeg: number | null = null;
  /** Précision de cap annoncée par iOS (degrés), si disponible. */
  issCompassHeadingAccuracyDeg: number | null = null;
  /** Les capteurs d’orientation envoient des données exploitables. */
  issCompassHeadingActive = false;
  /** Cap capteur brut (magnétique, compensé en inclinaison et lissé) avant correction Nord. */
  issCompassHeadingRawDeg: number | null = null;
  /** Correction (degrés) à ajouter au cap capteur pour obtenir le vrai Nord. */
  issCompassNorthOffsetDeg: number | null = null;
  /** État du calage du Nord. */
  issCompassCalStatus: 'uncalibrated' | 'calibrating' | 'calibrated' = 'uncalibrated';
  /**
   * Méthode d’identification du Nord choisie par l’utilisateur (null = à choisir) :
   *  - 'sensor' : Nord entièrement géré par les capteurs du smartphone (offset nul) ;
   *  - 'manual' : l’utilisateur oriente le haut du téléphone vers le Nord, puis valide
   *    pour enregistrer cette direction comme étant le Nord ;
   *  - 'gps'    : calage par marche GPS (cap réel de déplacement, vrai Nord) ;
   *  - 'sun'    : calage en visant le Soleil (azimut solaire calculé).
   */
  issCompassCalMethod: 'sensor' | 'manual' | 'gps' | 'sun' | null = null;
  /** Le calage affiché provient d’un enregistrement backend (mémorisé entre les sessions). */
  issCompassCalPersisted = false;
  /** Un enregistrement du calage vers le backend est en cours. */
  issCompassCalSaving = false;
  /** Nombre d’échantillons de calage déjà collectés pendant la marche GPS. */
  issCompassCalSamples = 0;
  /** Nombre d’échantillons requis pour valider une calibration par marche. */
  readonly issCompassCalNeededSamples = 6;
  /** Vitesse de déplacement GPS courante (m/s), pour guider la marche de calibration. */
  issCompassWalkSpeedMps: number | null = null;
  /** Différences circulaires (cap GPS − cap capteur) accumulées pendant la calibration. */
  private issCompassCalAccum: number[] = [];
  /** Vitesse mini (m/s) au-dessus de laquelle le cap GPS est jugé exploitable. */
  private readonly issCompassCalMinSpeedMps = 0.7;
  /** Valeurs brutes du dernier évènement d’orientation (diagnostic capteurs). */
  issCompassSensorAlpha: number | null = null;
  issCompassSensorBeta: number | null = null;
  issCompassSensorGamma: number | null = null;
  /** Orientation absolue (référencée au Nord) annoncée par l’évènement. */
  issCompassSensorAbsolute: boolean | null = null;
  /** Cap boussole iOS brut (webkitCompassHeading), si fourni par l’appareil. */
  issCompassSensorWebkitHeading: number | null = null;
  /** Précision boussole iOS brute (webkitCompassAccuracy), si fournie. */
  issCompassSensorWebkitAccuracy: number | null = null;
  /** Statut courant de la modale boussole. */
  issCompassStatus: 'idle' | 'locating' | 'ready' | 'no-geo' | 'no-iss' | 'error' = 'idle';
  private issCompassGeoWatchId: number | null = null;
  private issCompassOrientationListening = false;
  private issCompassOrientationEventName: 'deviceorientationabsolute' | 'deviceorientation' | null = null;
  private issCompassHeadingLastPaintMs = 0;
  /** Horodatage (epoch ms) de la dernière donnée ISS appliquée à la boussole. */
  issCompassUpdatedAtMs: number | null = null;
  /** Rafraîchissement manuel de la boussole en cours. */
  issCompassRefreshing = false;
  /** « Maintenant » mis en cache (epoch ms) pour calculer la fraîcheur des données sans recalcul permanent. */
  issCompassNowMs = Date.now();
  private issCompassFreshnessTimer: ReturnType<typeof setInterval> | null = null;
  /** Chargement du calage mémorisé en cours (retarde l’application auto capteurs sur smartphone). */
  private issCompassCalLoadPending = false;
  /** Horloge mise en cache (epoch ms), rafraîchie par les timers : évite NG0100 dans le template. */
  private clockNowMs = Date.now();
  /** Graduations en degrés affichées sur le pourtour du cadran (tous les 30°). */
  readonly issCompassBezelDegrees: ReadonlyArray<number> = [
    0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330
  ];
  /** Séquence des 16 directions (clés de lettres cardinales à concaténer). */
  private static readonly ISS_COMPASS_POINTS: ReadonlyArray<ReadonlyArray<'N' | 'E' | 'S' | 'W'>> = [
    ['N'], ['N', 'N', 'E'], ['N', 'E'], ['E', 'N', 'E'],
    ['E'], ['E', 'S', 'E'], ['S', 'E'], ['S', 'S', 'E'],
    ['S'], ['S', 'S', 'W'], ['S', 'W'], ['W', 'S', 'W'],
    ['W'], ['W', 'N', 'W'], ['N', 'W'], ['N', 'N', 'W']
  ];
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
  private issAlertConfigLoaded = false;

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
  /** Positions successives (lat/lon) pour la traînée ; enfant du maillage Terre. */
  private issTrailLine?: THREE.LineSegments;
  private readonly issTrailPoints: { lat: number; lon: number }[] = [];
  private issHistoricalTrailLine?: THREE.LineSegments;
  private readonly issHistoricalTrailPoints: { lat: number; lon: number; recordedAt?: string }[] = [];
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
  /** Chaîne de `setTimeout` pour respecter l’intervalle courant après chaque réponse. */
  private issRefreshTimeout: number | null = null;
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

  /** Dès qu’on manipule le globe, le suivi ISS cesse de forcer la caméra (orbite 3D libre). */
  private readonly onGlobeOrbitControlsStart = (): void => {
    if (this.isIssEarthCenteredTrackingActive()) {
      this.issGlobeFreeOrbit = true;
    }
  };

  ngAfterViewInit(): void {
    void this.airportLookup.ensureLoaded().then((map) => {
      this.airportLookupMap = map;
      if (this.flightTrackingActive) {
        this.refreshFlightAirportLabelsFromLookup();
        this.scheduleWorldGlobeCdr();
      }
    });
    this.routeQuerySub = this.route.queryParamMap.subscribe((params) => {
      this.applyDeepLinkAutoRotatePreference(params);
      const latStr = params.get('lat');
      const lonStr = params.get('lon') ?? params.get('lng');
      if (!latStr || !lonStr) {
        return;
      }
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return;
      }
      let mapZoom: number | undefined;
      const zStr = params.get('z') ?? params.get('zoom');
      if (zStr != null && zStr !== '') {
        const z = parseFloat(zStr);
        if (Number.isFinite(z) && z >= 1 && z <= 22) {
          mapZoom = z;
        }
      }
      this.queueOrApplyGlobeDeepLink({ lat, lon, mapZoom });
    });
    this.translateLangSub = this.translate.onLangChange.subscribe(() => this.onTranslateLangChangedForGlobeCountryLabels());
    queueMicrotask(() => this.bootstrapThree());
    this.loadIssFsPipStackTopFromStorage();
    queueMicrotask(() => this.refreshIssLivePiPPanelsLayout());
    if (this.issTickerEnabled) {
      queueMicrotask(() => {
        this.startIssPolling();
        void this.refreshIssNow();
      });
    }
    if (this.issHistoricalTraceEnabled) {
      queueMicrotask(() => void this.loadIssHistoricalTrace());
    }
    queueMicrotask(() => this.loadIssBackgroundTraceSetting());
    queueMicrotask(() => this.loadIssTraceDisplayLimitSetting());
    queueMicrotask(() => this.loadIssAlertConfig());
    queueMicrotask(() => this.loadFlightTrackingPreference());
  }

  ngOnDestroy(): void {
    this.stopIssCompassSensors();
    this.stopIssCompassFreshnessTimer();
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
    this.clearIssTrail();
    this.disposeIssHistoricalTrail();
    this.routeQuerySub?.unsubscribe();
    this.routeQuerySub = undefined;
    this.translateLangSub?.unsubscribe();
    this.translateLangSub = undefined;
    this.globeTraceViewer?.close();
    this.stopGlobeCameraAnimation();
    this.issTickerResizeObs?.disconnect();
    this.issTickerResizeObs = undefined;
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
    if (this.issPiPWhatsAppFlashTimer != null) {
      clearTimeout(this.issPiPWhatsAppFlashTimer);
      this.issPiPWhatsAppFlashTimer = null;
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
      if (this.globeViewSyncQueue.length) {
        for (const sync of this.globeViewSyncQueue) {
          sync();
        }
        this.globeViewSyncQueue.length = 0;
      }
      this.cdr.markForCheck();
    }, 0);
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
      this.clearIssTrail();
      this.issOverlayFailed = false;
      if (!this.issTickerEnabled) {
        this.clearIssPositionFeedState();
        this.stopIssPolling();
      } else {
        this.startIssPolling();
      }
      this.cdr.markForCheck();
    }
  }

  onIssTickerToggle(): void {
    if (this.issTickerEnabled) {
      this.startIssPolling();
      void this.refreshIssNow();
    } else if (!this.issOverlayEnabled) {
      this.stopIssPolling();
      this.clearIssPositionFeedState();
    }
    this.cdr.markForCheck();
  }

  /**
   * Interrupteur maître : affiche/masque d’un coup la traînée ISS temps réel ET la trace historique.
   * On ne supprime aucune donnée — on bascule seulement la visibilité des lignes/étiquettes.
   */
  onIssTraceToggle(): void {
    if (this.issTraceVisible) {
      this.rebuildIssTrailGeometry();
      this.rebuildIssHistoricalTrailGeometry();
    }
    this.applyIssTraceVisibility();
    this.cdr.markForCheck();
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
    try {
      const lang = (this.translate.currentLang || 'en').split('-')[0];
      return new Intl.DateTimeFormat(lang, {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(new Date(this.clockNowMs));
    } catch {
      return '';
    }
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

  /** Applique l’état de {@link issTraceVisible} aux deux lignes orange et aux étiquettes de dates. */
  private applyIssTraceVisibility(): void {
    const visible = this.issTraceVisible;
    if (this.issTrailLine) {
      this.issTrailLine.visible = visible && this.issTrailPoints.length >= 2;
    }
    if (this.issHistoricalTrailLine) {
      this.issHistoricalTrailLine.visible = visible && this.issHistoricalTraceEnabled;
    }
    if (this.issHistoricalTraceDateLabelsGroup) {
      this.issHistoricalTraceDateLabelsGroup.visible =
        visible && this.issHistoricalTraceEnabled && this.issHistoricalTraceDatesEnabled;
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
        next: (res) => this.applyIssAlertConfig(res),
        error: () => {
          /* keep defaults */
        }
      });
  }

  private applyIssAlertConfig(res: IssAlertConfig | null | undefined): void {
    if (!res) {
      return;
    }
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
    this.apiService
      .setIssAlertConfig({ enabled: next })
      .pipe(
        finalize(() => {
          this.issAlertSaving = false;
          this.cdr.markForCheck();
        })
      )
      .subscribe({
        next: (res) => this.applyIssAlertConfig(res),
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
    this.apiService
      .setIssAlertConfig({
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
          this.applyIssAlertConfig(res);
          this.issAlertNotice = this.translate.instant('WORLD_GLOBE.ISS_ALERT_SAVED');
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
      this.cdr.markForCheck();
    }
  }

  onIssHistoricalTraceDatesToggle(): void {
    if (this.issHistoricalTraceDatesEnabled) {
      this.rebuildIssHistoricalTraceDateLabels();
    } else {
      this.disposeIssHistoricalTraceDateLabels();
    }
    this.cdr.markForCheck();
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
    return this.globeIssLat != null && this.globeIssLon != null;
  }

  private issPositionFeedActive(): boolean {
    return this.issOverlayEnabled || this.issTickerEnabled;
  }

  private clearIssPositionFeedState(): void {
    this.issGroundSpeedKmh = null;
    this.issTrackDeg = null;
    this.globeIssAltKm = null;
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

    const blend = 1 - Math.pow(0.5, dtSec / GLOBE_ISS_CAMERA_CENTER_HALF_LIFE_SEC);

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
  }

  /** Position ISS tout de suite ; le prochain tirage automatique est recalculé à partir de maintenant. */
  onIssRefreshNowClick(): void {
    if (!this.issOverlayEnabled || !this.globeSurfaceReady || this.issManualRefreshInFlight) {
      return;
    }
    this.issManualRefreshInFlight = true;
    this.cdr.markForCheck();
    if (this.issRefreshTimeout != null) {
      clearTimeout(this.issRefreshTimeout);
      this.issRefreshTimeout = null;
    }
    void this.refreshIssNow().finally(() => {
      this.issManualRefreshInFlight = false;
      if (!this.issOverlayEnabled || !this.globeSurfaceReady) {
        this.cdr.markForCheck();
        return;
      }
      const ms = this.issPollIntervalMs();
      this.issNextRefreshEpochMs = Date.now() + ms;
      this.refreshIssCountdownSnapshot();
      this.scheduleIssRefreshChain(ms);
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
    this.issTickerResizeObs = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width;
      this.updateIssTickerDuration(width);
    });
    this.issTickerResizeObs.observe(el);
  }

  private updateIssTickerDuration(halfWidthPx: number): void {
    if (!Number.isFinite(halfWidthPx) || halfWidthPx <= 0) {
      return;
    }
    const sec = Math.max(30, halfWidthPx / WorldGlobeComponent.ISS_TICKER_SPEED_PX_PER_SEC);
    const rounded = Math.round(sec);
    if (rounded !== this.issTickerDurationSec) {
      this.issTickerDurationSec = rounded;
      this.cdr.markForCheck();
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

  /** Partage une capture de la mini-fenêtre ISS sur WhatsApp (Web Share ou wa.me). */
  async shareIssPiPScreenshotOnWhatsApp(variant: 'standard' | 'hd'): Promise<void> {
    if (this.issPiPImageBusy != null) {
      return;
    }
    const capture = this.resolveIssPiPCapture(variant);
    if (!capture) {
      this.flashIssPiPWhatsAppFeedback(variant, false);
      return;
    }
    this.issPiPImageBusy = { variant, action: 'whatsapp' };
    this.cdr.markForCheck();
    try {
      const blob = await this.captureIssPiPFrameToPngBlob(capture.frame, capture.videoId);
      if (!blob) {
        this.flashIssPiPWhatsAppFeedback(variant, false);
        return;
      }
      const ok = await this.shareIssPiPPngOnWhatsApp(blob, variant);
      this.flashIssPiPWhatsAppFeedback(variant, ok);
    } catch (err: unknown) {
      const name = err instanceof DOMException || err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        return;
      }
      this.flashIssPiPWhatsAppFeedback(variant, false);
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

  private buildIssPiPWhatsAppMessage(variant: 'standard' | 'hd'): string {
    const titleKey =
      variant === 'standard' ? 'WORLD_GLOBE.ISS_LIVE_PIP_TITLE' : 'WORLD_GLOBE.ISS_LIVE_PIP_HD_TITLE';
    const url =
      variant === 'standard' ? ISS_LIVE_DESTINATION_ORBITE_URL : ISS_LIVE_HD_DESTINATION_ORBITE_URL;
    const title = this.translate.instant(titleKey);
    return this.translate.instant('WORLD_GLOBE.ISS_LIVE_PIP_WHATSAPP_MESSAGE', { title, url });
  }

  private async shareIssPiPPngOnWhatsApp(blob: Blob, variant: 'standard' | 'hd'): Promise<boolean> {
    const titleKey =
      variant === 'standard' ? 'WORLD_GLOBE.ISS_LIVE_PIP_TITLE' : 'WORLD_GLOBE.ISS_LIVE_PIP_HD_TITLE';
    const title = this.translate.instant(titleKey);
    const message = this.buildIssPiPWhatsAppMessage(variant);
    const file = new File([blob], `iss-live-${variant}.png`, { type: 'image/png' });
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    if (navigator.share) {
      const fileShare: ShareData = { title, text: message, files: [file] };
      try {
        if (isMobile || !navigator.canShare || navigator.canShare({ files: [file], text: message })) {
          await navigator.share(fileShare);
          return true;
        }
      } catch (err: unknown) {
        const name = err instanceof DOMException || err instanceof Error ? err.name : '';
        if (name === 'AbortError') {
          throw err;
        }
      }
      try {
        const textShare: ShareData = { title, text: message };
        if (!navigator.canShare || navigator.canShare(textShare)) {
          await navigator.share(textShare);
          return true;
        }
      } catch (err: unknown) {
        const name = err instanceof DOMException || err instanceof Error ? err.name : '';
        if (name === 'AbortError') {
          throw err;
        }
      }
    }

    const copied = await this.writeIssPiPPngToClipboard(blob);
    let waText = message;
    if (copied) {
      waText += `\n\n${this.translate.instant('WORLD_GLOBE.ISS_LIVE_PIP_WHATSAPP_PASTE_IMAGE')}`;
    }
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(waText)}`;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
    return true;
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
   * Capture uniquement la zone vidéo de la fenêtre PiP (`.wg-iss-live-pip__frame`),
   * sans barre titre/boutons ni le reste de la page.
   */
  private async captureIssPiPFrameToPngBlob(frame: HTMLElement, videoId: string): Promise<Blob | null> {
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
    return this.captureIssPiPFrameCanvas(frame, videoId);
  }

  /** Recadrage Region Capture sur la zone iframe uniquement (flux live visible). */
  private async captureIssPiPFrameViaTabCapture(frame: HTMLElement): Promise<Blob | null> {
    const win = window as Window & {
      CropTarget?: { fromElement: (el: Element) => Promise<unknown> };
    };
    let cropTarget: unknown | null = null;
    if (typeof win.CropTarget?.fromElement === 'function') {
      try {
        cropTarget = await win.CropTarget.fromElement(frame);
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
      let cropped = false;
      if (cropTarget != null && typeof browserTrack.cropTo === 'function') {
        try {
          await browserTrack.cropTo(cropTarget);
          cropped = true;
        } catch {
          cropped = false;
        }
      }
      return this.grabPngBlobFromMediaTrack(
        track,
        cropped ? undefined : frame.getBoundingClientRect()
      );
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  private grabPngBlobFromMediaTrack(track: MediaStreamTrack, cropRect?: DOMRect): Promise<Blob | null> {
    const stream = new MediaStream([track]);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    return video.play().then(
      () =>
        new Promise<Blob | null>((resolve) => {
          const capture = (): void => {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            if (vw < 1 || vh < 1) {
              resolve(null);
              return;
            }
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(null);
              return;
            }
            if (!cropRect || cropRect.width < 1 || cropRect.height < 1) {
              canvas.width = vw;
              canvas.height = vh;
              ctx.drawImage(video, 0, 0);
            } else {
              const sx = vw / window.innerWidth;
              const sy = vh / window.innerHeight;
              const sw = Math.max(1, Math.round(cropRect.width * sx));
              const sh = Math.max(1, Math.round(cropRect.height * sy));
              const sx0 = Math.max(0, Math.round(cropRect.left * sx));
              const sy0 = Math.max(0, Math.round(cropRect.top * sy));
              canvas.width = sw;
              canvas.height = sh;
              ctx.drawImage(video, sx0, sy0, sw, sh, 0, 0, sw, sh);
            }
            canvas.toBlob((b) => resolve(b), 'image/png');
          };
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            requestAnimationFrame(() => requestAnimationFrame(capture));
          } else {
            video.addEventListener('loadeddata', () => requestAnimationFrame(capture), { once: true });
            setTimeout(capture, 450);
          }
        })
    );
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
    } catch {
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

  private flashIssPiPWhatsAppFeedback(variant: 'standard' | 'hd', ok: boolean): void {
    if (this.issPiPWhatsAppFlashTimer != null) {
      clearTimeout(this.issPiPWhatsAppFlashTimer);
    }
    this.issPiPWhatsAppFlash = { variant, ok };
    this.cdr.markForCheck();
    this.issPiPWhatsAppFlashTimer = setTimeout(() => {
      this.issPiPWhatsAppFlash = null;
      this.issPiPWhatsAppFlashTimer = null;
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
      return 3;
    }
    return camera.position.distanceTo(controls.target);
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
    verticalLift = 0
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

  resetCamera(): void {
    if (!this.camera || !this.controls) {
      return;
    }
    this.issGlobeFreeOrbit = false;
    this.issCameraCenterSmoothPrevMs = 0;
    this.stopGlobeCameraAnimation();
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
      this.frameCameraOnLatLon(this.globeIssLat!, this.globeIssLon!, dist, 0);
    } else {
      this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
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
    const passes =
      body.passes?.response ??
      (body.nextPass ? [body.nextPass] : []);
    const lines = passes
      .map((p) => this.formatIssPassLine(p.risetime, p.duration))
      .filter((l): l is string => !!l);
    if (lines.length === 0) {
      this.issPassError = this.translate.instant('WORLD_GLOBE.ISS_PASS_NONE');
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
      nextPassLine: lines[0],
      upcomingLines: lines
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

  private formatIssPassLine(risetime?: number, durationSec?: number): string | null {
    const t = typeof risetime === 'number' ? risetime : parseInt(String(risetime ?? ''), 10);
    if (!Number.isFinite(t) || t <= 0) {
      return null;
    }
    const when = new Date(t * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
    const dur = typeof durationSec === 'number' ? durationSec : parseInt(String(durationSec ?? ''), 10);
    const minutes = Number.isFinite(dur) && dur > 0 ? Math.max(1, Math.round(dur / 60)) : null;
    if (minutes != null) {
      return this.translate.instant('WORLD_GLOBE.ISS_PASS_LINE', { datetime: when, minutes });
    }
    return this.translate.instant('WORLD_GLOBE.ISS_PASS_LINE_NO_DURATION', { datetime: when });
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

  @HostListener('document:keydown', ['$event'])
  onGlobeGeocodeDocumentKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.issCompassOpen) {
      ev.preventDefault();
      this.closeIssCompass();
      return;
    }
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
    if (!this.pendingGlobeDeepLink || !this.globeSurfaceReady || !this.camera || !this.controls || !this.earthMesh) {
      return;
    }
    const p = this.pendingGlobeDeepLink;
    this.pendingGlobeDeepLink = null;
    this.executeGlobeDeepLinkFly(p);
    this.clearGlobeDeepLinkQueryParams();
  }

  private executeGlobeDeepLinkFly(p: { lat: number; lon: number; mapZoom?: number }): void {
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
      queryParams: { lat: null, lon: null, lng: null, z: null, zoom: null, autoRotate: null },
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
      this.attachRotationAxisToEarth(earth);
      this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
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
        this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
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
    this.frameCameraOnLatLon(GLOBE_INITIAL_FRANCE_LAT, GLOBE_INITIAL_FRANCE_LON, GLOBE_INITIAL_ORBIT_DISTANCE);
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
      void this.refreshIssNow();
      this.startIssPolling();
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

  /* ======================================================================= */
  /* Boussole ISS : capteurs (GPS + orientation) et calcul azimut / élévation */
  /* ======================================================================= */

  /** Ouvre la modale boussole et démarre les capteurs (GPS + orientation appareil). */
  openIssCompass(): void {
    if (this.issCompassOpen) {
      return;
    }
    this.issCompassOpen = true;
    this.issCompassStatus = 'locating';
    this.issCompassUserSource = null;
    this.issCompassHeadingActive = false;
    this.issCompassHeadingDeg = null;
    this.issCompassHeadingAccuracyDeg = null;
    this.resetIssCompassSensorReadings();
    this.resetIssCompassCalibration();
    // Recharge le dernier calage du Nord enregistré : pas besoin de recaler à chaque ouverture.
    this.loadIssCompassCalibration();
    this.startIssCompassGeolocation();
    void this.startIssCompassOrientation();
    // Si l’ISS n’a pas encore de position connue, déclencher un rafraîchissement immédiat.
    if (this.globeIssLat == null || this.globeIssLon == null) {
      void this.refreshIssNow();
    }
    this.recomputeIssCompass();
    this.startIssCompassFreshnessTimer();
    this.cdr.markForCheck();
  }

  /** Tient à jour l’indicateur « il y a … » pendant que la modale est ouverte. */
  private startIssCompassFreshnessTimer(): void {
    this.stopIssCompassFreshnessTimer();
    this.zone.runOutsideAngular(() => {
      this.issCompassFreshnessTimer = setInterval(() => {
        this.zone.run(() => {
          this.issCompassNowMs = Date.now();
          this.clockNowMs = this.issCompassNowMs;
          this.cdr.markForCheck();
        });
      }, 1000);
    });
  }

  private stopIssCompassFreshnessTimer(): void {
    if (this.issCompassFreshnessTimer != null) {
      clearInterval(this.issCompassFreshnessTimer);
      this.issCompassFreshnessTimer = null;
    }
  }

  /**
   * Rafraîchissement manuel depuis la boussole : redemande une position GPS ponctuelle de haute
   * précision puis recharge la position ISS, et recalcule l’azimut / élévation.
   */
  async refreshIssCompass(): Promise<void> {
    if (this.issCompassRefreshing) {
      return;
    }
    this.issCompassRefreshing = true;
    this.cdr.markForCheck();
    // Tentative de relevé GPS ponctuel (en plus du watch), pour la position la plus fraîche possible.
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        await new Promise<void>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              this.zone.run(() => {
                this.issCompassUserLat = pos.coords.latitude;
                this.issCompassUserLon = pos.coords.longitude;
                this.issCompassUserAccuracyM = Number.isFinite(pos.coords.accuracy)
                  ? pos.coords.accuracy
                  : null;
                this.issCompassUserSource = 'gps';
                if (this.issCompassStatus === 'locating' || this.issCompassStatus === 'no-geo') {
                  this.issCompassStatus = 'ready';
                }
              });
              resolve();
            },
            () => resolve(),
            { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
          );
        });
      } catch {
        /* ignore : on garde la position existante */
      }
    }
    try {
      await this.refreshIssNow();
    } finally {
      this.zone.run(() => {
        this.recomputeIssCompass();
        this.issCompassRefreshing = false;
        this.cdr.markForCheck();
      });
    }
  }

  /** Ferme la modale boussole et coupe tous les capteurs. */
  closeIssCompass(): void {
    if (!this.issCompassOpen) {
      return;
    }
    this.issCompassOpen = false;
    this.stopIssCompassSensors();
    this.stopIssCompassFreshnessTimer();
    this.cdr.markForCheck();
  }

  private stopIssCompassSensors(): void {
    if (
      this.issCompassGeoWatchId != null &&
      typeof navigator !== 'undefined' &&
      navigator.geolocation
    ) {
      try {
        navigator.geolocation.clearWatch(this.issCompassGeoWatchId);
      } catch {
        /* ignore */
      }
    }
    this.issCompassGeoWatchId = null;
    if (this.issCompassOrientationListening && this.issCompassOrientationEventName) {
      window.removeEventListener(
        this.issCompassOrientationEventName,
        this.handleIssCompassOrientation as EventListener,
        true
      );
    }
    this.issCompassOrientationListening = false;
    this.issCompassHeadingActive = false;
    this.resetIssCompassSensorReadings();
    this.resetIssCompassCalibration();
    this.issCompassOrientationEventName = null;
  }

  /** Remet à zéro les valeurs brutes de capteurs affichées dans le diagnostic. */
  private resetIssCompassSensorReadings(): void {
    this.issCompassSensorAlpha = null;
    this.issCompassSensorBeta = null;
    this.issCompassSensorGamma = null;
    this.issCompassSensorAbsolute = null;
    this.issCompassSensorWebkitHeading = null;
    this.issCompassSensorWebkitAccuracy = null;
  }

  /** Nom de l’évènement d’orientation effectivement écouté (diagnostic capteurs). */
  issCompassSensorEventName(): string | null {
    return this.issCompassOrientationEventName;
  }

  /** Angle de rotation de l’écran (degrés) utilisé pour corriger le cap. */
  issCompassScreenAngleDeg(): number | null {
    return this.issCompassHeadingActive ? this.currentScreenAngle() : null;
  }

  private startIssCompassGeolocation(): void {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.applyIssCompassGeoFallback();
      return;
    }
    try {
      this.issCompassGeoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.zone.run(() => {
            this.issCompassUserLat = pos.coords.latitude;
            this.issCompassUserLon = pos.coords.longitude;
            this.issCompassUserAccuracyM = Number.isFinite(pos.coords.accuracy)
              ? pos.coords.accuracy
              : null;
            this.issCompassUserSource = 'gps';
            if (this.issCompassStatus === 'locating' || this.issCompassStatus === 'no-geo') {
              this.issCompassStatus = 'ready';
            }
            this.ingestIssCompassGpsCourse(pos.coords);
            this.recomputeIssCompass();
            this.cdr.markForCheck();
          });
        },
        () => {
          this.zone.run(() => {
            this.applyIssCompassGeoFallback();
            this.cdr.markForCheck();
          });
        },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
      );
    } catch {
      this.applyIssCompassGeoFallback();
    }
  }

  /** Repli si le GPS est refusé/indisponible : utiliser le point cliqué sur le globe s’il existe. */
  private applyIssCompassGeoFallback(): void {
    if (
      this.issCompassUserSource !== 'gps' &&
      this.globePickedLat != null &&
      this.globePickedLon != null
    ) {
      this.issCompassUserLat = this.globePickedLat;
      this.issCompassUserLon = this.globePickedLon;
      this.issCompassUserAccuracyM = null;
      this.issCompassUserSource = 'picked';
      this.issCompassStatus = 'ready';
      this.recomputeIssCompass();
      return;
    }
    if (this.issCompassUserSource == null) {
      this.issCompassStatus = 'no-geo';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Identification du Nord : 4 méthodes + mémorisation backend          */
  /* (capteurs auto / manuel / marche GPS / Soleil)                      */
  /* ------------------------------------------------------------------ */

  /**
   * Exploite le cap de déplacement GPS (vrai Nord, indépendant du magnétomètre)
   * pendant une marche pour caler la boussole. Quand l’utilisateur marche en
   * ligne droite, le cap GPS donne la direction réelle ; on en déduit la
   * correction à appliquer au cap capteur (magnétique + biais de calibration).
   */
  private ingestIssCompassGpsCourse(coords: GeolocationCoordinates): void {
    const speed =
      Number.isFinite(coords.speed as number) && (coords.speed as number) >= 0
        ? (coords.speed as number)
        : null;
    this.issCompassWalkSpeedMps = speed;
    if (this.issCompassCalStatus !== 'calibrating') {
      return;
    }
    const course = Number.isFinite(coords.heading as number) ? (coords.heading as number) : null;
    if (
      course == null ||
      speed == null ||
      speed < this.issCompassCalMinSpeedMps ||
      this.issCompassHeadingRawDeg == null
    ) {
      return;
    }
    // Correction = vrai Nord (cap GPS) − cap capteur (magnétique) au même instant.
    this.issCompassCalAccum.push(this.normalizeDeg(course - this.issCompassHeadingRawDeg));
    this.issCompassCalSamples = this.issCompassCalAccum.length;
    if (this.issCompassCalSamples >= this.issCompassCalNeededSamples) {
      const offset = this.circularMeanDeg(this.issCompassCalAccum);
      this.issCompassNorthOffsetDeg = offset;
      this.issCompassCalStatus = 'calibrated';
      this.issCompassCalAccum = [];
      this.applyIssCompassNorthOffset();
      this.persistIssCompassCalibration('gps', offset);
    }
  }

  /**
   * Choisit la méthode d’identification du Nord (4 méthodes).
   *  - 'sensor' : on fait entièrement confiance aux capteurs du smartphone
   *    (boussole/magnétomètre absolu) ; le calage est immédiat (offset nul).
   *  - 'manual' : mode « viser le Nord » ; l’utilisateur oriente le haut du
   *    téléphone vers le Nord puis valide via {@link confirmIssCompassManualNorth}.
   *  - 'gps'    : calage par marche GPS ; la collecte démarre immédiatement.
   *  - 'sun'    : on vise le Soleil puis on valide via {@link confirmIssCompassSunCalibration}.
   */
  chooseIssCompassCalMethod(method: 'sensor' | 'manual' | 'gps' | 'sun'): void {
    this.issCompassCalMethod = method;
    if (method === 'sensor') {
      // Nord géré par les capteurs : aucune correction à appliquer.
      this.issCompassNorthOffsetDeg = 0;
      this.issCompassCalStatus = 'calibrated';
      this.applyIssCompassNorthOffset();
      this.persistIssCompassCalibration('sensor', 0);
    } else if (method === 'gps') {
      // Marche GPS : on collecte des échantillons pendant le déplacement.
      this.issCompassCalStatus = 'calibrating';
      this.issCompassCalAccum = [];
      this.issCompassCalSamples = 0;
    } else {
      // 'manual' / 'sun' : on reste « non calé » jusqu’à validation de l’orientation.
      this.issCompassCalStatus = 'uncalibrated';
    }
    this.cdr.markForCheck();
  }

  /**
   * Valide le calage manuel : l’utilisateur a orienté le haut du téléphone vers le
   * Nord ; on enregistre la direction actuelle de l’appareil comme étant le Nord.
   * La correction = −cap capteur brut (pour que le cap affiché tombe à 0° = Nord).
   */
  confirmIssCompassManualNorth(): void {
    if (this.issCompassHeadingRawDeg == null) {
      return;
    }
    const offset = this.normalizeDeg(-this.issCompassHeadingRawDeg);
    this.issCompassNorthOffsetDeg = offset;
    this.issCompassCalMethod = 'manual';
    this.issCompassCalStatus = 'calibrated';
    this.applyIssCompassNorthOffset();
    this.persistIssCompassCalibration('manual', offset);
    this.cdr.markForCheck();
  }

  /** Le calage manuel est possible (les capteurs fournissent un cap exploitable). */
  issCompassManualReady(): boolean {
    return this.issCompassHeadingActive && this.issCompassHeadingRawDeg != null;
  }

  /**
   * Confirme la calibration par le Soleil : l’utilisateur a aligné le haut de
   * l’appareil avec le Soleil ; on cale le cap capteur sur l’azimut solaire réel.
   */
  confirmIssCompassSunCalibration(): void {
    const az = this.issCompassSunAzimuthDeg();
    if (az == null || this.issCompassHeadingRawDeg == null) {
      return;
    }
    const offset = this.normalizeDeg(az - this.issCompassHeadingRawDeg);
    this.issCompassNorthOffsetDeg = offset;
    this.issCompassCalMethod = 'sun';
    this.issCompassCalStatus = 'calibrated';
    this.applyIssCompassNorthOffset();
    this.persistIssCompassCalibration('sun', offset);
    this.cdr.markForCheck();
  }

  /** Annule le choix de méthode en cours (revient à l’écran de choix ou au calage précédent). */
  cancelIssCompassCalibration(): void {
    this.issCompassCalStatus = this.issCompassNorthOffsetDeg != null ? 'calibrated' : 'uncalibrated';
    this.issCompassCalMethod = null;
    this.issCompassCalAccum = [];
    this.issCompassCalSamples = 0;
    this.cdr.markForCheck();
  }

  /** Relance le choix de méthode pour recaler le Nord (à la demande de l’utilisateur). */
  restartIssCompassCalibration(): void {
    this.issCompassCalStatus = 'uncalibrated';
    this.issCompassCalMethod = null;
    this.issCompassCalPersisted = false;
    this.issCompassCalAccum = [];
    this.issCompassCalSamples = 0;
    this.cdr.markForCheck();
  }

  /** Remet le calage du Nord à zéro en mémoire (à l’ouverture/fermeture de la boussole). */
  private resetIssCompassCalibration(): void {
    this.issCompassHeadingRawDeg = null;
    this.issCompassNorthOffsetDeg = null;
    this.issCompassCalStatus = 'uncalibrated';
    this.issCompassCalMethod = null;
    this.issCompassCalPersisted = false;
    this.issCompassCalSaving = false;
    this.issCompassCalLoadPending = false;
    this.issCompassCalAccum = [];
    this.issCompassCalSamples = 0;
    this.issCompassWalkSpeedMps = null;
  }

  /**
   * Recharge le calage du Nord mémorisé côté backend pour l’utilisateur courant,
   * afin de ne pas redemander de caler à chaque ouverture de la boussole.
   * Sans enregistrement (ou utilisateur anonyme), la boussole reste « non calée ».
   */
  private loadIssCompassCalibration(): void {
    this.issCompassCalLoadPending = true;
    this.apiService.getIssCompassCalibration().subscribe({
      next: (cal: IssCompassCalibration | null) => {
        this.issCompassCalLoadPending = false;
        if (!this.issCompassOpen) {
          return;
        }
        if (cal && this.isKnownCalMethod(cal.method)) {
          // Ne pas écraser un calage que l’utilisateur vient de refaire pendant le chargement.
          if (this.issCompassCalStatus === 'uncalibrated' && this.issCompassCalMethod == null) {
            const offset = Number.isFinite(cal.northOffsetDeg) ? this.normalizeDeg(cal.northOffsetDeg) : 0;
            this.issCompassNorthOffsetDeg = offset;
            this.issCompassCalMethod = cal.method;
            this.issCompassCalStatus = 'calibrated';
            this.issCompassCalPersisted = true;
            this.applyIssCompassNorthOffset();
          }
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.issCompassCalLoadPending = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** Smartphone / tablette tactile avec capteurs d’orientation (ex. Samsung Galaxy). */
  private isIssCompassMobileDevice(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  /** Méthode de calage reconnue (une des 4 prises en charge). */
  private isKnownCalMethod(
    method: string | null | undefined
  ): method is 'sensor' | 'manual' | 'gps' | 'sun' {
    return method === 'sensor' || method === 'manual' || method === 'gps' || method === 'sun';
  }

  /** Enregistre le calage du Nord côté backend (mémorisé entre les sessions, pour les 4 méthodes). */
  private persistIssCompassCalibration(
    method: 'sensor' | 'manual' | 'gps' | 'sun',
    northOffsetDeg: number
  ): void {
    this.issCompassCalSaving = true;
    this.cdr.markForCheck();
    this.apiService
      .setIssCompassCalibration({
        method,
        northOffsetDeg: this.normalizeDeg(northOffsetDeg),
        calibratedAt: new Date().toISOString(),
      })
      .subscribe({
        next: () => {
          this.zone.run(() => {
            this.issCompassCalPersisted = true;
            this.issCompassCalSaving = false;
            this.cdr.markForCheck();
          });
        },
        error: () => {
          this.zone.run(() => {
            this.issCompassCalPersisted = false;
            this.issCompassCalSaving = false;
            this.cdr.markForCheck();
          });
        },
      });
  }

  /** Azimut du Soleil (degrés, 0 = Nord) pour la position observateur, ou null si indisponible/nuit. */
  issCompassSunAzimuthDeg(): number | null {
    if (this.issCompassUserLat == null || this.issCompassUserLon == null) {
      return null;
    }
    // Instant mis en cache (rafraîchi à la seconde) : évite NG0100 dans le template.
    const sun = WorldGlobeComponent.solarPosition(
      this.issCompassUserLat,
      this.issCompassUserLon,
      new Date(this.issCompassNowMs)
    );
    // Soleil sous l’horizon : alignement impossible (nuit / crépuscule profond).
    if (sun.elevationDeg < -1) {
      return null;
    }
    return sun.azimuthDeg;
  }

  /** Élévation du Soleil (degrés) pour la position observateur, ou null si indisponible. */
  issCompassSunElevationDeg(): number | null {
    if (this.issCompassUserLat == null || this.issCompassUserLon == null) {
      return null;
    }
    return WorldGlobeComponent.solarPosition(
      this.issCompassUserLat,
      this.issCompassUserLon,
      new Date(this.issCompassNowMs)
    ).elevationDeg;
  }

  /** Le Soleil est sous l’horizon (méthode Soleil indisponible). */
  issCompassSunBelowHorizon(): boolean {
    const el = this.issCompassSunElevationDeg();
    return el != null && el < -1;
  }

  /**
   * Position du Soleil (azimut depuis le Nord, sens horaire ; élévation au-dessus
   * de l’horizon) pour une latitude/longitude et un instant donnés. Implémente
   * l’algorithme solaire NOAA (précision ~0,1°, suffisante pour une boussole).
   */
  private static solarPosition(
    latDeg: number,
    lonDeg: number,
    date: Date
  ): { azimuthDeg: number; elevationDeg: number } {
    const rad = Math.PI / 180;
    const jd =
      date.getTime() / 86400000 + 2440587.5; // ms epoch → jour julien
    const T = (jd - 2451545.0) / 36525;

    let L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    if (L0 < 0) {
      L0 += 360;
    }
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mrad = M * rad;
    const C =
      Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
      Math.sin(3 * Mrad) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
    const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
    const e0 = 23 + (26 + seconds / 60) / 60;
    const oblCorr = e0 + 0.00256 * Math.cos(omega * rad);
    const declRad = Math.asin(Math.sin(oblCorr * rad) * Math.sin(lambda * rad));

    const y = Math.tan((oblCorr / 2) * rad) * Math.tan((oblCorr / 2) * rad);
    const L0rad = L0 * rad;
    const eqTime =
      (4 *
        (y * Math.sin(2 * L0rad) -
          2 * e * Math.sin(Mrad) +
          4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0rad) -
          0.5 * y * y * Math.sin(4 * L0rad) -
          1.25 * e * e * Math.sin(2 * Mrad))) /
      rad; // minutes

    const minutes =
      date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let trueSolarTime = (minutes + eqTime + 4 * lonDeg) % 1440;
    if (trueSolarTime < 0) {
      trueSolarTime += 1440;
    }
    let ha = trueSolarTime / 4 - 180; // angle horaire (deg)

    const latRad = latDeg * rad;
    const haRad = ha * rad;
    const zenithRad = Math.acos(
      Math.min(
        1,
        Math.max(
          -1,
          Math.sin(latRad) * Math.sin(declRad) +
            Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad)
        )
      )
    );
    const elevationDeg = 90 - zenithRad / rad;

    let azimuthDeg: number;
    const azDenom = Math.cos(latRad) * Math.sin(zenithRad);
    if (Math.abs(azDenom) > 1e-6) {
      let azRad =
        (Math.sin(latRad) * Math.cos(zenithRad) - Math.sin(declRad)) / azDenom;
      azRad = Math.min(1, Math.max(-1, azRad));
      const az = Math.acos(azRad) / rad;
      azimuthDeg = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
    } else {
      azimuthDeg = latDeg > 0 ? 180 : 0;
    }
    return { azimuthDeg, elevationDeg };
  }

  /** Progression (%) de la calibration par marche GPS en cours. */
  issCompassCalProgressPercent(): number {
    if (this.issCompassCalNeededSamples <= 0) {
      return 0;
    }
    const pct = (this.issCompassCalSamples / this.issCompassCalNeededSamples) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /** L’utilisateur marche assez vite pour que le cap GPS soit exploitable. */
  issCompassWalkingFastEnough(): boolean {
    return this.issCompassWalkSpeedMps != null && this.issCompassWalkSpeedMps >= this.issCompassCalMinSpeedMps;
  }

  /** Le cap affiché n’est pas encore calé sur le vrai Nord (calage conseillé). */
  issCompassNeedsCalibration(): boolean {
    return this.issCompassHeadingActive && this.issCompassCalStatus !== 'calibrated';
  }

  /** Le cap affiché est calé sur le vrai Nord. */
  issCompassIsCalibrated(): boolean {
    return this.issCompassCalStatus === 'calibrated';
  }

  /** Mode automatique (magnétomètre) actif. */
  issCompassIsAutoSensorMode(): boolean {
    return this.issCompassCalMethod === 'sensor';
  }

  /**
   * Affiche alpha/beta/gamma en direct : mode auto actif, ou capteurs actifs sur
   * smartphone en attente du calage auto.
   */
  issCompassShowLiveSensorValues(): boolean {
    return (
      this.issCompassHeadingActive &&
      (this.issCompassIsAutoSensorMode() ||
        (this.issCompassCalMethod == null && this.isIssCompassMobileDevice()))
    );
  }

  /** Démarre l’écoute de l’orientation appareil (boussole magnétique / gyroscope). */
  private async startIssCompassOrientation(): Promise<void> {
    const doe: any =
      typeof window !== 'undefined' ? (window as any).DeviceOrientationEvent : undefined;
    if (!doe) {
      return;
    }
    // iOS 13+ : permission explicite requise (appel depuis le geste d’ouverture).
    if (typeof doe.requestPermission === 'function') {
      try {
        const res = await doe.requestPermission();
        if (res !== 'granted') {
          return;
        }
      } catch {
        return;
      }
    }
    const absolute = 'ondeviceorientationabsolute' in window;
    this.issCompassOrientationEventName = absolute ? 'deviceorientationabsolute' : 'deviceorientation';
    const evtName = this.issCompassOrientationEventName;
    this.zone.runOutsideAngular(() => {
      window.addEventListener(evtName, this.handleIssCompassOrientation as EventListener, true);
    });
    this.issCompassOrientationListening = true;
  }

  private handleIssCompassOrientation = (e: DeviceOrientationEvent): void => {
    const heading = this.deviceHeadingFromEvent(e);
    if (heading == null) {
      return;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.issCompassHeadingLastPaintMs < 80) {
      return;
    }
    this.issCompassHeadingLastPaintMs = now;
    const anyE = e as any;
    const acc =
      typeof anyE.webkitCompassAccuracy === 'number' && anyE.webkitCompassAccuracy >= 0
        ? anyE.webkitCompassAccuracy
        : null;
    const webkitHeading =
      typeof anyE.webkitCompassHeading === 'number' && Number.isFinite(anyE.webkitCompassHeading)
        ? anyE.webkitCompassHeading
        : null;
    const isAbsolute =
      typeof e.absolute === 'boolean'
        ? e.absolute
        : this.issCompassOrientationEventName === 'deviceorientationabsolute';
    this.zone.run(() => {
      // Lissage circulaire passe-bas pour atténuer le bruit du magnétomètre.
      this.issCompassHeadingRawDeg =
        this.issCompassHeadingRawDeg == null
          ? heading
          : this.circularLerpDeg(this.issCompassHeadingRawDeg, heading, 0.3);
      this.applyIssCompassNorthOffset();
      this.issCompassHeadingAccuracyDeg = acc;
      this.issCompassHeadingActive = true;
      this.issCompassSensorAlpha = Number.isFinite(e.alpha as number) ? (e.alpha as number) : null;
      this.issCompassSensorBeta = Number.isFinite(e.beta as number) ? (e.beta as number) : null;
      this.issCompassSensorGamma = Number.isFinite(e.gamma as number) ? (e.gamma as number) : null;
      this.issCompassSensorAbsolute = isAbsolute;
      this.issCompassSensorWebkitHeading = webkitHeading;
      this.issCompassSensorWebkitAccuracy = acc;
      this.cdr.markForCheck();
    });
  };

  /** Extrait un cap (0 = Nord, sens horaire) à partir d’un évènement d’orientation. */
  private deviceHeadingFromEvent(e: DeviceOrientationEvent): number | null {
    const anyE = e as any;
    if (
      typeof anyE.webkitCompassHeading === 'number' &&
      Number.isFinite(anyE.webkitCompassHeading)
    ) {
      // iOS : cap boussole déjà corrigé (0 = Nord magnétique).
      return this.normalizeDeg(anyE.webkitCompassHeading);
    }
    if (
      e.alpha != null &&
      Number.isFinite(e.alpha) &&
      (e.absolute || this.issCompassOrientationEventName === 'deviceorientationabsolute')
    ) {
      // Android (et navigateurs sans webkitCompassHeading) : cap absolu fourni par
      // le magnétomètre, mais alpha seul ne vaut que téléphone à plat. On compense
      // l'inclinaison (beta/gamma) pour rester juste quand l'appareil est dressé.
      const beta = Number.isFinite(e.beta as number) ? (e.beta as number) : 0;
      const gamma = Number.isFinite(e.gamma as number) ? (e.gamma as number) : 0;
      return this.tiltCompensatedHeadingDeg(e.alpha, beta, gamma, this.currentScreenAngle());
    }
    return null;
  }

  /**
   * Cap (0 = Nord, sens horaire) compensé en inclinaison.
   *
   * Construit la matrice de rotation appareil → Terre (repère ENU : X = Est,
   * Y = Nord, Z = Haut) à partir des angles W3C alpha/beta/gamma, puis combine
   * les projections horizontales de deux axes de visée :
   *  - le bord supérieur (+Y appareil) — fiable quand l'appareil est à plat ;
   *  - le dos de l'appareil (−Z appareil) — fiable quand il est dressé vers le ciel.
   * On les somme vectoriellement : chaque axe est naturellement pondéré par la
   * longueur de sa projection horizontale (un axe presque vertical pèse peu).
   * Résultat : pas de saut quand on passe d'une pose à l'autre (≈ verticale),
   * contrairement à un basculement brutal entre les deux axes.
   */
  private tiltCompensatedHeadingDeg(
    alphaDeg: number,
    betaDeg: number,
    gammaDeg: number,
    screenAngleDeg: number
  ): number {
    const d2r = Math.PI / 180;
    const a = alphaDeg * d2r;
    const b = betaDeg * d2r;
    const g = gammaDeg * d2r;
    const cA = Math.cos(a);
    const sA = Math.sin(a);
    const cB = Math.cos(b);
    const sB = Math.sin(b);
    const cG = Math.cos(g);
    const sG = Math.sin(g);

    // Matrice R = Rz(alpha)·Rx(beta)·Ry(gamma) (spec W3C DeviceOrientation).
    // Axe « bord supérieur » (+Y appareil) exprimé dans le repère Terre.
    const topE = -cB * sA;
    const topN = cA * cB;
    // Axe « dos de l'appareil » (−Z appareil) exprimé dans le repère Terre.
    const backE = -(cA * sG + cG * sA * sB);
    const backN = -(sA * sG - cA * cG * sB);

    // Somme vectorielle des projections horizontales (pondération implicite).
    const east = topE + backE;
    const north = topN + backN;

    const heading = (Math.atan2(east, north) * 180) / Math.PI + screenAngleDeg;
    return this.normalizeDeg(heading);
  }

  /** Interpolation circulaire (degrés) entre deux caps, sans saut au passage 0/360. */
  private circularLerpDeg(fromDeg: number, toDeg: number, t: number): number {
    const f = (fromDeg * Math.PI) / 180;
    const to = (toDeg * Math.PI) / 180;
    const x = Math.cos(f) * (1 - t) + Math.cos(to) * t;
    const y = Math.sin(f) * (1 - t) + Math.sin(to) * t;
    return this.normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
  }

  /** Moyenne circulaire (degrés) d’une liste de caps. */
  private circularMeanDeg(degrees: ReadonlyArray<number>): number {
    let x = 0;
    let y = 0;
    for (const d of degrees) {
      const r = (d * Math.PI) / 180;
      x += Math.cos(r);
      y += Math.sin(r);
    }
    return this.normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
  }

  /** Écart signé (−180..180) entre deux caps en degrés. */
  private circularDiffDeg(aDeg: number, bDeg: number): number {
    return ((aDeg - bDeg + 540) % 360) - 180;
  }

  /** Recalcule le cap affiché (vrai Nord) = cap capteur lissé + correction de calibration. */
  private applyIssCompassNorthOffset(): void {
    if (this.issCompassHeadingRawDeg == null) {
      this.issCompassHeadingDeg = null;
      return;
    }
    const offset = this.issCompassNorthOffsetDeg ?? 0;
    this.issCompassHeadingDeg = this.normalizeDeg(this.issCompassHeadingRawDeg + offset);
  }

  private currentScreenAngle(): number {
    try {
      const so = (screen as any).orientation;
      if (so && typeof so.angle === 'number') {
        return so.angle;
      }
    } catch {
      /* ignore */
    }
    const wo = (window as any).orientation;
    return typeof wo === 'number' ? wo : 0;
  }

  private normalizeDeg(deg: number): number {
    let d = deg % 360;
    if (d < 0) {
      d += 360;
    }
    return d;
  }

  /** Recalcule azimut, élévation et distances vers l’ISS depuis la position observateur. */
  recomputeIssCompass(): void {
    const uLat = this.issCompassUserLat;
    const uLon = this.issCompassUserLon;
    const sLat = this.globeIssLat;
    const sLon = this.globeIssLon;
    if (uLat == null || uLon == null) {
      this.issCompassAzimuthDeg = null;
      this.issCompassElevationDeg = null;
      this.issCompassGroundDistanceKm = null;
      this.issCompassSlantRangeKm = null;
      return;
    }
    if (sLat == null || sLon == null) {
      this.issCompassAzimuthDeg = null;
      this.issCompassElevationDeg = null;
      this.issCompassGroundDistanceKm = null;
      this.issCompassSlantRangeKm = null;
      if (this.issCompassStatus === 'ready') {
        this.issCompassStatus = 'no-iss';
      }
      return;
    }
    if (this.issCompassStatus === 'no-iss') {
      this.issCompassStatus = 'ready';
    }
    const Re = 6371;
    const h = this.globeIssAltKm != null && this.globeIssAltKm > 0 ? this.globeIssAltKm : 420;
    const groundKm = WorldGlobeComponent.haversineGreatCircleKm(uLat, uLon, sLat, sLon);
    const gamma = groundKm / Re; // angle géocentrique (rad)
    const azimuth = WorldGlobeComponent.initialBearingDeg(uLat, uLon, sLat, sLon);
    // Élévation satellite (modèle sphérique) : el = atan2(cos γ − Re/(Re+h), sin γ)
    const ratio = Re / (Re + h);
    const elevationRad = Math.atan2(Math.cos(gamma) - ratio, Math.sin(gamma));
    const slant = Math.sqrt(
      Re * Re + (Re + h) * (Re + h) - 2 * Re * (Re + h) * Math.cos(gamma)
    );
    this.issCompassAzimuthDeg = azimuth;
    this.issCompassElevationDeg = (elevationRad * 180) / Math.PI;
    this.issCompassGroundDistanceKm = groundKm;
    this.issCompassSlantRangeKm = slant;
    this.issCompassUpdatedAtMs = Date.now();
    this.issCompassNowMs = this.issCompassUpdatedAtMs;
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
            if (country) {
              this.issOverPlaceLabel = country;
              this.issOverPlaceCountryCode = code;
            } else {
              this.issOverPlaceLabel = this.translate.instant('WORLD_GLOBE.ISS_OVER_OCEAN');
              this.issOverPlaceCountryCode = null;
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
    const code = this.issOverPlaceCountryCode;
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

  /** Azimut initial (cap orthodromique, 0 = Nord, sens horaire) de (lat1,lon1) vers (lat2,lon2). */
  private static initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    const theta = Math.atan2(y, x);
    return ((theta * 180) / Math.PI + 360) % 360;
  }

  /** Rotation (deg) de la rose des vents : le Nord pointe vers le Nord réel selon le cap appareil. */
  issCompassRoseRotationDeg(): number {
    return this.issCompassHeadingActive && this.issCompassHeadingDeg != null
      ? -this.issCompassHeadingDeg
      : 0;
  }

  /** Rotation (deg) de l’aiguille ISS : pointe vers l’ISS, relative au haut de l’appareil. */
  issCompassNeedleRotationDeg(): number {
    const az = this.issCompassAzimuthDeg ?? 0;
    if (this.issCompassHeadingActive && this.issCompassHeadingDeg != null) {
      return this.normalizeDeg(az - this.issCompassHeadingDeg);
    }
    return az;
  }

  /** Libellé cardinal (16 points) de l’azimut courant, traduit. */
  issCompassCardinalLabel(): string {
    if (this.issCompassAzimuthDeg == null) {
      return '';
    }
    const idx = ((Math.round(this.issCompassAzimuthDeg / 22.5) % 16) + 16) % 16;
    const letters = WorldGlobeComponent.ISS_COMPASS_POINTS[idx];
    return letters.map((l) => this.translate.instant('WORLD_GLOBE.COMPASS_DIR_' + l)).join('');
  }

  /** Consigne d’orientation relative quand le cap appareil est connu (+ droite, − gauche). */
  issCompassRelativeInstruction(): { key: string; deg: number } | null {
    if (
      !this.issCompassHeadingActive ||
      this.issCompassHeadingDeg == null ||
      this.issCompassAzimuthDeg == null
    ) {
      return null;
    }
    let diff = this.issCompassAzimuthDeg - this.issCompassHeadingDeg;
    diff = ((diff + 540) % 360) - 180;
    const mag = Math.abs(diff);
    if (mag <= 7) {
      return { key: 'WORLD_GLOBE.COMPASS_FACING', deg: 0 };
    }
    return {
      key: diff > 0 ? 'WORLD_GLOBE.COMPASS_TURN_RIGHT' : 'WORLD_GLOBE.COMPASS_TURN_LEFT',
      deg: Math.round(mag)
    };
  }

  /** ISS au-dessus de l’horizon (visible géométriquement) selon l’élévation calculée. */
  issCompassIssAboveHorizon(): boolean {
    return this.issCompassElevationDeg != null && this.issCompassElevationDeg >= 0;
  }

  /** L’appareil pointe vers l’ISS (cap connu et écart d’azimut faible) : déclenche le voyant lumineux. */
  issCompassIsFacing(): boolean {
    const instr = this.issCompassRelativeInstruction();
    return instr != null && instr.key === 'WORLD_GLOBE.COMPASS_FACING';
  }

  /** Altitude de l’ISS (km) utilisée pour le calcul (valeur API ou repli 420 km). */
  issCompassAltitudeKm(): number | null {
    return this.globeIssAltKm != null && this.globeIssAltKm > 0 ? this.globeIssAltKm : null;
  }

  /** Hauteur (%) de la jauge d’élévation : 0° = horizon, 90° = zénith (élévations < 0 repliées à 0). */
  issCompassElevationGaugePercent(): number {
    const el = this.issCompassElevationDeg;
    if (el == null) {
      return 0;
    }
    const clamped = Math.max(0, Math.min(90, el));
    return (clamped / 90) * 100;
  }

  /** Âge des données ISS, formaté « à l’instant / il y a Ns / il y a Nmin », sinon null. */
  issCompassUpdatedAgoLabel(): string | null {
    if (this.issCompassUpdatedAtMs == null) {
      return null;
    }
    const diffSec = Math.max(0, Math.round((this.issCompassNowMs - this.issCompassUpdatedAtMs) / 1000));
    if (diffSec < 3) {
      return this.translate.instant('WORLD_GLOBE.ISS_COMPASS_UPDATED_NOW');
    }
    if (diffSec < 60) {
      return this.translate.instant('WORLD_GLOBE.ISS_COMPASS_UPDATED_AGO_S', { s: diffSec });
    }
    const diffMin = Math.round(diffSec / 60);
    return this.translate.instant('WORLD_GLOBE.ISS_COMPASS_UPDATED_AGO_M', { m: diffMin });
  }

  /** Indique si les données ISS sont périmées (> 30 s) et mériteraient un rafraîchissement. */
  issCompassDataStale(): boolean {
    if (this.issCompassUpdatedAtMs == null) {
      return false;
    }
    return this.issCompassNowMs - this.issCompassUpdatedAtMs > 30000;
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
      const nowMs = performance.now();
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
      if (flightEarthCentered && !this.flightGlobeFreeOrbit && this.isGlobeOrbitIdle(controls)) {
        this.applyFlightEarthCenteredCameraIfNeeded();
      } else if (issEarthCentered && !this.issGlobeFreeOrbit && this.isGlobeOrbitIdle(controls)) {
        this.applyIssEarthCenteredCameraIfNeeded();
      }
      this.updateCountryLabelsScaleForZoom();
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
    this.refreshIssCountdownSnapshot();
  }

  private startIssPolling(): void {
    this.stopIssPolling();
    if (!this.issPositionFeedActive()) {
      return;
    }
    const ms = this.issPollIntervalMs();
    this.issNextRefreshEpochMs = Date.now() + ms;
    this.issCountdownInterval = window.setInterval(() => {
      this.clockNowMs = Date.now();
      this.refreshIssCountdownSnapshot();
      this.scheduleWorldGlobeCdr();
    }, 1000);
    this.scheduleIssRefreshChain(ms);
    queueMicrotask(() => {
      this.refreshIssCountdownSnapshot();
      this.scheduleWorldGlobeCdr();
    });
  }

  private scheduleIssRefreshChain(delayMs: number): void {
    this.issRefreshTimeout = window.setTimeout(() => {
      this.issRefreshTimeout = null;
      void this.refreshIssNow().finally(() => {
        if (!this.issPositionFeedActive()) {
          return;
        }
        const ms = this.issPollIntervalMs();
        this.issNextRefreshEpochMs = Date.now() + ms;
        this.refreshIssCountdownSnapshot();
        this.scheduleIssRefreshChain(ms);
      });
    }, delayMs);
  }

  private refreshIssCountdownSnapshot(): void {
    let next = 0;
    if (this.issOverlayEnabled && this.issNextRefreshEpochMs > 0) {
      next = Math.max(0, Math.ceil((this.issNextRefreshEpochMs - Date.now()) / 1000));
    }
    this.scheduleWorldGlobeCdr(() => {
      this.issSecondsUntilNextRefresh = next;
    });
  }

  private async refreshIssNow(): Promise<void> {
    if (!this.issPositionFeedActive()) {
      return;
    }
    try {
      const data = await firstValueFrom(this.http.get<GlobeOpenNotifyIssResponse>(this.globeIssNowUrl()));
      const latStr = data?.iss_position?.latitude;
      const lonStr = data?.iss_position?.longitude;
      if (latStr == null || lonStr == null) {
        throw new Error('ISS payload missing coordinates');
      }
      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Error('ISS coordinates invalid');
      }
      if (!this.issPositionFeedActive()) {
        return;
      }

      const altStr = data?.iss_position?.altitude_km;
      let altKm: number | null = null;
      if (altStr != null && altStr !== '') {
        const parsedAlt = parseFloat(altStr);
        altKm =
          Number.isFinite(parsedAlt) && parsedAlt >= 0 && parsedAlt <= 2000 ? parsedAlt : null;
      }

      const velStr = data?.iss_position?.velocity_kmh;
      let apiVelKmh: number | null = null;
      if (velStr != null && velStr !== '') {
        const v = parseFloat(velStr);
        if (Number.isFinite(v) && v >= 0 && v <= 50000) {
          apiVelKmh = v;
        }
      }

      const now = Date.now();
      const prevSampleLat = this.issSpeedSampleLat;
      const prevSampleLon = this.issSpeedSampleLon;
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
        this.recordIssTrailSample(lat, lon);
        // Réaligne sur le dernier segment de traînée (cohérent avec la polyligne affichée).
        this.updateIssMarkerWorldPosition(lat, lon);
        this.persistIssTraceSample(lat, lon);
      }

      this.issSpeedSampleLat = lat;
      this.issSpeedSampleLon = lon;
      this.issSpeedSampleEpochMs = now;

      const overlayFailed = false;
      this.scheduleWorldGlobeCdr(() => {
        this.globeIssLat = lat;
        this.globeIssLon = lon;
        this.globeIssAltKm = altKm;
        this.issGroundSpeedKmh = groundSpeedKmh;
        if (this.issOverlayEnabled) {
          this.issOverlayFailed = overlayFailed;
        }
        if (this.issCompassOpen || this.issCompassUserLat != null) {
          this.recomputeIssCompass();
        }
      });
      this.maybeUpdateIssOverPlace(lat, lon);
    } catch {
      if (this.issOverlayEnabled) {
        this.scheduleWorldGlobeCdr(() => {
          this.issOverlayFailed = true;
        });
      }
    }
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
      state.arrivalCity
    );
    this.flightDepartureAirportName = dep.name;
    this.flightDepartureAirportIata = dep.iata;
    this.flightDepartureCity = dep.city;
    this.flightArrivalAirportName = arr.name;
    this.flightArrivalAirportIata = arr.iata;
    this.flightArrivalCity = arr.city;
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
      this.flightArrivalCity
    );
    this.flightDepartureAirportName = dep.name;
    this.flightDepartureAirportIata = dep.iata;
    this.flightDepartureCity = dep.city;
    this.flightArrivalAirportName = arr.name;
    this.flightArrivalAirportIata = arr.iata;
    this.flightArrivalCity = arr.city;
  }

  private mergeAirportDetails(
    icao: string | null,
    apiName?: string | null,
    apiIata?: string | null,
    apiCity?: string | null
  ): { name: string | null; iata: string | null; city: string | null } {
    const lookup =
      this.airportLookupMap != null
        ? this.airportLookup.resolveCached(icao, this.airportLookupMap)
        : null;
    const name = apiName?.trim() || lookup?.name || null;
    const iata = apiIata?.trim().toUpperCase() || lookup?.iata || null;
    const city = apiCity?.trim() || lookup?.city || null;
    return { name, iata, city };
  }

  /** adsbdb.com planned route when OpenSky omits estArrivalAirport (common in-flight). */
  private async enrichMissingArrivalFromRouteDatabase(callsign: string | null | undefined): Promise<void> {
    if (this.flightArrivalAirport || !callsign?.trim()) {
      return;
    }
    const dest = await this.flightRouteLookup.destinationForCallsign(callsign);
    if (!dest || !this.flightTrackingActive) {
      return;
    }
    this.flightArrivalAirport = dest.icao;
    this.flightArrivalAirportName = dest.name;
    this.flightArrivalAirportIata = dest.iata;
    this.flightArrivalCity = dest.city;
    const lookup = this.mergeAirportDetails(dest.icao, dest.name, dest.iata, dest.city);
    this.flightArrivalAirportName = lookup.name;
    this.flightArrivalAirportIata = lookup.iata;
    this.flightArrivalCity = lookup.city;
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
      await this.enrichMissingArrivalFromRouteDatabase(this.flightCallsign ?? query);
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

  /** Space station (top-down, yellow): central module + solar panels. */
  private static createIssIconMesh(): THREE.Mesh {
    const tex = WorldGlobeComponent.createGlobeIconCanvasTexture((ctx, size) => {
      WorldGlobeComponent.drawIssTopViewIcon(ctx, size);
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

  /** ISS top-down: central truss + yellow solar panels. */
  private static drawIssTopViewIcon(ctx: CanvasRenderingContext2D, size: number): void {
    const cx = size / 2;
    const cy = size / 2;
    const s = size;
    const yellow = '#ffea00';
    const panel = '#ffd000';
    const stroke = '#fff8b0';
    ctx.clearRect(0, 0, s, s);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1.5, s * 0.028);

    // Solar panels (left / right)
    ctx.fillStyle = panel;
    ctx.strokeRect(cx - s * 0.44, cy - s * 0.13, s * 0.16, s * 0.26);
    ctx.fillRect(cx - s * 0.44, cy - s * 0.13, s * 0.16, s * 0.26);
    ctx.strokeRect(cx + s * 0.28, cy - s * 0.13, s * 0.16, s * 0.26);
    ctx.fillRect(cx + s * 0.28, cy - s * 0.13, s * 0.16, s * 0.26);

    // Panel grid
    ctx.strokeStyle = 'rgba(255, 240, 160, 0.55)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const xL = cx - s * 0.44 + (s * 0.16 * i) / 4;
      const xR = cx + s * 0.28 + (s * 0.16 * i) / 4;
      ctx.beginPath();
      ctx.moveTo(xL, cy - s * 0.13);
      ctx.lineTo(xL, cy + s * 0.13);
      ctx.moveTo(xR, cy - s * 0.13);
      ctx.lineTo(xR, cy + s * 0.13);
      ctx.stroke();
    }

    // Main truss (horizontal)
    ctx.fillStyle = yellow;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, s * 0.03);
    ctx.fillRect(cx - s * 0.3, cy - s * 0.028, s * 0.6, s * 0.056);
    ctx.strokeRect(cx - s * 0.3, cy - s * 0.028, s * 0.6, s * 0.056);

    // Modules (nodes)
    ctx.beginPath();
    ctx.arc(cx - s * 0.14, cy, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + s * 0.14, cy, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Central module
    ctx.fillRect(cx - s * 0.055, cy - s * 0.055, s * 0.11, s * 0.11);
    ctx.strokeRect(cx - s * 0.055, cy - s * 0.055, s * 0.11, s * 0.11);
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
        color: GLOBE_ISS_TRAIL_COLOR,
        transparent: true,
        opacity: GLOBE_ISS_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.renderOrder = 5;
      earth.add(line);
      this.issTrailLine = line;
    }
    const line = this.issTrailLine;
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
        this.issHistoricalTrailPoints.push({ lat, lon, recordedAt: p?.recordedAt });
      }
      this.rebuildIssHistoricalTrailGeometry();
    } catch {
      if (this.issHistoricalTraceEnabled) {
        this.issHistoricalTraceFailed = true;
      }
    } finally {
      this.issHistoricalTraceLoading = false;
      this.cdr.markForCheck();
    }
  }

  /** Enregistre un échantillon ISS côté serveur (au plus 1× par intervalle serveur, fire-and-forget). */
  private persistIssTraceSample(lat: number, lon: number): void {
    if (!this.issOverlayEnabled) {
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
    const vertices: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
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
      return;
    }
    if (!this.issHistoricalTrailLine) {
      const mat = new THREE.LineBasicMaterial({
        color: GLOBE_ISS_TRAIL_COLOR,
        transparent: true,
        opacity: GLOBE_ISS_TRAIL_OPACITY,
        depthWrite: false
      });
      mat.toneMapped = false;
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), mat);
      line.renderOrder = 4;
      earth.add(line);
      this.issHistoricalTrailLine = line;
    }
    const line = this.issHistoricalTrailLine;
    const histMat = line.material;
    if (!Array.isArray(histMat) && histMat instanceof THREE.LineBasicMaterial) {
      histMat.color.setHex(GLOBE_ISS_TRAIL_COLOR);
      histMat.opacity = GLOBE_ISS_TRAIL_OPACITY;
    }
    const oldGeo = line.geometry;
    line.geometry = new THREE.BufferGeometry();
    oldGeo.dispose();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    line.visible = this.issTraceVisible;
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
      group.add(sprite);
    }
    if (group.children.length === 0) {
      return;
    }
    group.visible = this.issTraceVisible;
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
