import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Observable, Subscription, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import {
  Body,
  DefineStar,
  Equator,
  Horizon,
  Illumination,
  Observer,
  KM_PER_AU,
  SearchRiseSet,
  SearchHourAngle,
  Constellation,
  Elongation,
  SiderealTime
} from 'astronomy-engine';
import {
  ASTRO_PLANETS,
  ASTRO_BRIGHT_STARS,
  ASTRO_GALAXIES,
  ASTRO_SATELLITES,
  ASTRO_ISS,
  findStarsByQuery,
  findGalaxiesByQuery,
  findPlanetById,
  findStarById,
  findGalaxyById,
  findSatelliteById,
  satelliteUsesNetworkTle,
  satelliteHasLivePosition,
  AstroBodyOption,
  AstroStarOption,
  AstroGalaxyOption,
  AstroSatelliteOption,
  AstroTargetKind
} from './astro-compass-catalog';
import {
  ASTRO_CONSTELLATIONS,
  findConstellationsByQuery,
  findConstellationById,
  constellationMemberStars,
  constellationCenterStar,
  constellationStickLines,
  AstroConstellationOption
} from './astro-compass-constellations';
import { constellationFigureStrokes } from './astro-compass-constellation-figures';
import {
  ApiService,
  DirectionCible,
  IssCompassCalibration,
  SkyMapPreview,
  StellariumSkySource,
  WikipediaSearchPage,
  WikipediaSummary
} from '../services/api.service';
import {
  CIBLE_MARK_MIN_DIST_M,
  cibleMarkBearingDeg,
  cibleMarkDistanceM,
  geocodeDisplayName,
  hasCibleMark,
  loadActiveCibleId,
  saveActiveCibleId
} from '../direction/direction-cible-store';
import { KeycloakService } from '../keycloak/keycloak.service';
import { GlobeIssNowService } from '../services/globe-iss-now.service';
import { GlobeSatelliteNowService } from '../services/globe-satellite-now.service';
import { CompassNorthEngine } from '../shared/compass-north.engine';
import { clampCamHeightPx, loadCamHeightPx, saveCamHeightPx } from '../shared/preview-cam-size';
import { isAndroidUserAgent, skyMapAndroidSearchIntent, openSkyMapAndroidApp } from '../shared/sky-map-app.util';
import { wikiContentLang, wikiLookupRequest, wikiSourceDir, wikiSourceLang } from './astro-object-dossier.service';
import { TraceViewerModalComponent } from '../shared/trace-viewer-modal/trace-viewer-modal.component';
import {
  SlideshowModalComponent,
  SlideshowImageSource
} from '../shared/slideshow-modal/slideshow-modal.component';
import { CameraLookTracker } from '../direction/camera-look-tracker';
import {
  loadPattoolCal,
  persistPattoolCalFromSamples,
  sameCalSampleSet,
  snapshotFromPayload
} from '../direction/direction-pattool-cal';
import {
  clipLineToRect,
  computeFinderTurnGuide,
  displayedCameraFovDeg,
  projectCelestialToScreen,
  type FinderTurnGuide,
  type ScreenProjection
} from '../direction/direction-attitude';
import { applyMultiplicativeWheelScale, normalizeWheelDeltaPixels } from '../shared/wheel-zoom.util';

/** Seuil (degrés) pour considérer que l'utilisateur vise la cible (azimut / inclinaison). */
const FACING_THRESHOLD_DEG = 8;
const PITCH_THRESHOLD_DEG = 8;
/** Fréquence AbsoluteOrientationSensor (Hz) — plus élevé = Nord plus réactif. */
const ABS_ORIENTATION_HZ = 60;
/** Magnétomètre / accéléro / gyro (Generic Sensor API), comme la page Nord. */
const NORTH_SENSOR_HZ = 50;
/** Intervalle min. entre paints UI cap (ms) — ~20 fps suffit, évite le scintillement. */
const HEADING_PAINT_MIN_MS = 50;
/** Intervalle min. entre paints inclinaison seule (ms). */
const PITCH_PAINT_MIN_MS = 50;
/**
 * Lissage du cap (lerp circulaire vers la lecture brute).
 * Faible = stable (anti-sauts Samsung) ; plus haut seulement pour les grands mouvements.
 */
const HEADING_LERP_MIN = 0.04;
const HEADING_LERP_MAX = 0.16;
const HEADING_LERP_SNAP_DEG = 55;
/** Au-delà de ce saut instantané, on ignore l'échantillon (bruit / glitch). */
const HEADING_OUTLIER_DEG = 35;
/** Médiane circulaire sur N échantillons (anti-saccades Samsung). */
const HEADING_MEDIAN_N = 7;
/** Sous ces |β|/|γ|, utiliser 360−α (formule W3C invalide à plat). */
const HEADING_FLAT_BETA_GAMMA_DEG = 12;

type NorthHeadingMode = 'os-yaw' | 'os-mag' | 'w3c' | 'tilt-mix' | 'tilt-top' | 'mag' | 'mag-gyro';

const NORTH_HEADING_MODE_KEY = 'pat.astro-compass.north-heading-mode';
const NORTH_HEADING_MODE_IDS: ReadonlyArray<NorthHeadingMode> = [
  'os-yaw',
  'os-mag',
  'w3c',
  'tilt-mix',
  'tilt-top',
  'mag',
  'mag-gyro'
];
/** Fusion OS+mag : n’attirer vers le mag que s’il est assez proche (sinon bruit / métal). */
const OS_MAG_AGREE_DEG = 28;
/** Fraction du mag injectée à chaque sample OS (~20 Hz) → rappel lent. */
const OS_MAG_PULL = 0.05;
/** Lissage inclinaison (α vers la lecture instantanée). */
const PITCH_SMOOTH_ALPHA = 0.22;
/** Cône d'auto-détection autour de la direction du téléphone. */
const AUTO_DETECT_MAX_SEP_DEG = 15;
const AUTO_DETECT_TOP_N = 8;
/** Séparation attribuée à la constellation qui contient la visée (les astres plus proches gagnent). */
const AUTO_DETECT_CONSTELLATION_REGION_SEP_DEG = 7;
/** Rafraîchissement positions ciel (catalogue) en mode live. */
const AUTO_DETECT_CACHE_MS = 2500;
/** Fréquence de comparaison direction téléphone ↔ catalogue. */
const AUTO_DETECT_TICK_MS = 400;
const EARTH_RADIUS_KM = 6371;
/** IAU : 1 année-lumière = 63 241,077 unités astronomiques. */
const AU_PER_LY = 63241.07708426628;
/** Année julienne : 365,25 j — cohérent avec le passage al → secondes-lumière. */
const SECONDS_PER_LY = 365.25 * 24 * 3600;
const SECONDS_PER_DAY = 24 * 3600;
const ISS_DEFAULT_ALT_KM = 420;
const ISS_REFRESH_MIN_MS = 20_000;
const SAT_PASS_LOOKBACK_MS = 45 * 60_000;
const SAT_PASS_HORIZON_MS = 18 * 60 * 60_000;
const SAT_PASS_STEP_MS = 30_000;
const SAT_PASS_MAX = 6;
/** Trajectoire future dans le viseur : satellites (SGP4) vs astres (éphémérides). */
const FINDER_TRAIL_SAT_DEFAULT_MIN = 10;
const FINDER_TRAIL_SAT_MIN = 5;
const FINDER_TRAIL_SAT_MAX = 60;
const FINDER_TRAIL_SAT_STEP = 5;
const FINDER_TRAIL_SAT_STEP_MS = 8_000;
const FINDER_TRAIL_SKY_DEFAULT_MIN = 90;
const FINDER_TRAIL_SKY_MIN = 15;
const FINDER_TRAIL_SKY_MAX = 720;
const FINDER_TRAIL_SKY_STEP = 15;
const FINDER_TRAIL_SKY_STEP_MS = 90_000;
const FINDER_TRAIL_SKY_MAX_AGE_MS = 2_000;
const FINDER_ZOOM_MIN = 1;
const FINDER_ZOOM_MAX = 8;
const FINDER_ZOOM_STEP = 0.25;
const FINDER_CENTER_SEP_DEG = 2.8;
const FINDER_PAN_EL_MIN = -20;
const FINDER_PAN_EL_MAX = 90;
const FINDER_LABEL_SCALE_MAX = 2.5;

interface AddressSearchResult {
  lat: number;
  lon: number;
  displayName: string;
}

interface LastAstroTarget {
  kind: AstroTargetKind;
  id?: string;
  customRaHours?: number;
  customDecDeg?: number;
  customName?: string;
}

interface VisibilityDay {
  dayKey: string;
  rise: Date | null;
  set: Date | null;
  transit: Date | null;
  maxAltitudeDeg: number | null;
}

interface IssPassItem {
  riseAt: Date;
  setAt: Date;
  durationSec: number;
  maxElevationDeg: number | null;
  maxAt?: Date;
}

interface FinderTrailSkyPt {
  az: number;
  el: number;
  tMs: number;
}

interface FinderTrailTick {
  xPct: number;
  yPct: number;
  min: number;
}

interface FinderConstellationStar {
  id: string;
  name: string;
  xPct: number;
  yPct: number;
}

interface ConstellationMemberSky {
  id: string;
  name: string;
  az: number;
  el: number;
}

interface ConstellationFigureSkyPt {
  az: number;
  el: number;
}

interface ConstellationSchemaDot {
  xPct: number;
  yPct: number;
}

interface GenericSensorLike {
  start(): void;
  stop(): void;
  x?: number;
  y?: number;
  z?: number;
  quaternion?: number[];
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface AutoDetectHit {
  kind: 'planet' | 'star' | 'galaxy' | 'constellation' | 'iss';
  id: string;
  name: string;
  iconClass: string;
  color: string;
  azimuthDeg: number;
  elevationDeg: number;
  separationDeg: number;
  mag: number | null;
  /** True si l’objet est la constellation qui contient la visée (pas son centre). */
  fromRegion?: boolean;
}

type CatalogSkyKind = 'planet' | 'star' | 'galaxy' | 'constellation' | 'iss';

interface CatalogSkyDir {
  azimuthDeg: number;
  elevationDeg: number;
  /** Ex. « NE 142° / +23° » */
  label: string;
}

interface HelpTerm {
  id: string;
  termKey: string;
  defKey: string;
  aliases: string;
}

type TargetAccordionId = 'iss' | 'planet' | 'star' | 'galaxy' | 'constellation' | 'custom';

interface TypeHelpCopy {
  titleFr: string;
  titleEn: string;
  bodyFr: string;
  bodyEn: string;
}

/** Aide de chaque type de cible : toujours FR + EN, indépendant de la langue de l’app. */
const TARGET_TYPE_HELP: Record<TargetAccordionId, TypeHelpCopy> = {
  iss: {
    titleFr: 'Satellite',
    titleEn: 'Satellite',
    bodyFr:
      'Objet artificiel en orbite autour de la Terre (ISS, Hubble, Landsat…). Il se déplace vite : azimut et élévation sont recalculés en continu. Un passage ne dure souvent que quelques minutes.',
    bodyEn:
      'Artificial object orbiting Earth (ISS, Hubble, Landsat…). It moves quickly: azimuth and elevation are recomputed continuously. A pass often lasts only a few minutes.'
  },
  planet: {
    titleFr: 'Planète / système solaire',
    titleEn: 'Planet / Solar System',
    bodyFr:
      'Corps du système solaire (Mercure à Neptune, plus la Lune, le Soleil et Pluton). Leur position change d’heure en heure, contrairement aux étoiles.',
    bodyEn:
      'Solar System body (Mercury to Neptune, plus the Moon, the Sun and Pluto). Their position changes hour by hour, unlike stars.'
  },
  star: {
    titleFr: 'Étoile',
    titleEn: 'Star',
    bodyFr:
      'Astre lointain qui brille par lui-même. Sa position céleste (AD / Déc) est quasi fixe ; seuls l’azimut et l’élévation changent avec l’heure et le lieu. Le curseur de magnitude masque les étoiles trop faibles.',
    bodyEn:
      'Distant sun that shines by itself. Its celestial position (RA / Dec) is almost fixed; only azimuth and elevation change with time and place. The magnitude slider hides fainter stars.'
  },
  galaxy: {
    titleFr: 'Galaxie',
    titleEn: 'Galaxy',
    bodyFr:
      'Îlot physique de milliards d’étoiles (ex. Andromède, Grand et Petit Nuage de Magellan). Ce n’est pas une constellation : c’est un objet réel, souvent très étendu, surtout visible hors des villes.',
    bodyEn:
      'Physical island of billions of stars (e.g. Andromeda, Large and Small Magellanic Clouds). Unlike a constellation, a galaxy is a real object, often very large, best seen away from cities.'
  },
  constellation: {
    titleFr: 'Constellation',
    titleEn: 'Constellation',
    bodyFr:
      'Découpage officiel du ciel en 88 régions (UAI). Ce n’est pas un objet physique : les étoiles d’une constellation sont à des distances très différentes. Le viseur vise le centre ; le schéma (figure) est sur la fiche de l’objet.',
    bodyEn:
      'Official division of the sky into 88 regions (IAU). It is not a physical object: stars in a constellation lie at very different distances. The finder aims at the centre; the stick figure is on the object sheet.'
  },
  custom: {
    titleFr: 'Coordonnées libres',
    titleEn: 'Custom coordinates',
    bodyFr:
      'Saisissez l’ascension droite (heures) et la déclinaison (degrés) pour viser n’importe quel point du ciel, par exemple un objet hors catalogue.',
    bodyEn:
      'Enter right ascension (hours) and declination (degrees) to aim at any sky point, for example an object not in the catalogue.'
  }
};

interface ObjectDossier {
  extract: string | null;
  description: string | null;
  thumbUrl: string | null;
  imageUrl: string | null;
  wikiUrl: string | null;
  wikiTitle: string | null;
  wikiLang: string | null;
  wikiDir: 'rtl' | null;
  skyNames: string[];
  skyTypes: string[];
  vMag: number | null;
  bMag: number | null;
  skyMapCutoutUrl: string | null;
  skyMapAtlasUrl: string | null;
  skyMapEmbedUrl: string | null;
  skyMapName: string | null;
}

interface WikiLookup {
  fr: string;
  en: string;
  sky: string;
  /** Extra Wikipedia search query when the exact title misses or is a disambiguation. */
  search?: string;
}

const OBJECT_WIKI_LOOKUP: Record<string, WikiLookup> = {
  'planet:sun': { fr: 'Soleil', en: 'Sun', sky: 'Sun' },
  'planet:moon': { fr: 'Lune', en: 'Moon', sky: 'Moon' },
  'planet:mercury': { fr: 'Mercure_(planète)', en: 'Mercury_(planet)', sky: 'Mercury' },
  'planet:venus': { fr: 'Vénus_(planète)', en: 'Venus', sky: 'Venus' },
  'planet:mars': { fr: 'Mars_(planète)', en: 'Mars', sky: 'Mars' },
  'planet:jupiter': { fr: 'Jupiter_(planète)', en: 'Jupiter', sky: 'Jupiter' },
  'planet:saturn': { fr: 'Saturne_(planète)', en: 'Saturn', sky: 'Saturn' },
  'planet:uranus': { fr: 'Uranus_(planète)', en: 'Uranus', sky: 'Uranus' },
  'planet:neptune': { fr: 'Neptune_(planète)', en: 'Neptune', sky: 'Neptune' },
  'planet:pluto': { fr: 'Pluton_(planète naine)', en: 'Pluto', sky: 'Pluto' },
  'iss:iss': { fr: 'Station_spatiale_internationale', en: 'International_Space_Station', sky: 'ISS', search: 'ISS station spatiale internationale' },
  'iss:tiangong': { fr: 'Station_spatiale_chinoise', en: 'Tiangong_space_station', sky: 'Tiangong', search: 'Tiangong station spatiale chinoise' },
  'iss:hubble': { fr: 'Hubble_(télescope_spatial)', en: 'Hubble_Space_Telescope', sky: 'HST', search: 'Hubble télescope spatial' },
  'iss:jwst': { fr: 'James_Webb_(télescope_spatial)', en: 'James_Webb_Space_Telescope', sky: 'JWST', search: 'James Webb télescope spatial JWST' },
  'iss:terra': { fr: 'Terra_(satellite)', en: 'Terra_(satellite)', sky: 'Terra', search: 'Terra satellite NASA EOS' },
  'iss:aqua': { fr: 'Aqua_(satellite)', en: 'Aqua_(satellite)', sky: 'Aqua', search: 'Aqua satellite NASA EOS' },
  'iss:landsat8': { fr: 'Landsat_8', en: 'Landsat_8', sky: 'Landsat8', search: 'Landsat 8 satellite' },
  'iss:landsat9': { fr: 'Landsat_9', en: 'Landsat_9', sky: 'Landsat9', search: 'Landsat 9 satellite' },
  'iss:sentinel2a': { fr: 'Sentinel-2', en: 'Sentinel-2', sky: 'Sentinel-2A', search: 'Sentinel-2 satellite' },
  'iss:sentinel2b': { fr: 'Sentinel-2', en: 'Sentinel-2', sky: 'Sentinel-2B', search: 'Sentinel-2 satellite' },
  'iss:sentinel2c': { fr: 'Sentinel-2', en: 'Sentinel-2', sky: 'Sentinel-2C', search: 'Sentinel-2 satellite' },
  'iss:noaa20': { fr: 'NOAA-20', en: 'NOAA-20', sky: 'NOAA-20', search: 'NOAA-20 satellite' },
  'iss:noaa21': { fr: 'NOAA-21', en: 'NOAA-21', sky: 'NOAA-21', search: 'NOAA-21 satellite' },
  'iss:suominpp': { fr: 'Suomi_NPP', en: 'Suomi_NPP', sky: 'Suomi NPP', search: 'Suomi NPP satellite' },
  'iss:aura': { fr: 'Aura_(satellite)', en: 'Aura_(satellite)', sky: 'Aura', search: 'Aura satellite NASA EOS' },
  'iss:sentinel1a': { fr: 'Sentinel-1', en: 'Sentinel-1', sky: 'Sentinel-1A', search: 'Sentinel-1 satellite' },
  'iss:sentinel1c': { fr: 'Sentinel-1', en: 'Sentinel-1', sky: 'Sentinel-1C', search: 'Sentinel-1 satellite' },
  'iss:sentinel3a': { fr: 'Sentinel-3', en: 'Sentinel-3', sky: 'Sentinel-3A', search: 'Sentinel-3 satellite' },
  'iss:sentinel3b': { fr: 'Sentinel-3', en: 'Sentinel-3', sky: 'Sentinel-3B', search: 'Sentinel-3 satellite' },
  'iss:sentinel5p': { fr: 'Sentinel-5_Precursor', en: 'Sentinel-5_Precursor', sky: 'Sentinel-5P', search: 'Sentinel-5P satellite' },
  'iss:sentinel6': { fr: 'Sentinel-6', en: 'Sentinel-6_Michael_Freilich', sky: 'Sentinel-6', search: 'Sentinel-6 Michael Freilich satellite' },
  'iss:metopb': { fr: 'MetOp', en: 'MetOp', sky: 'MetOp-B', search: 'MetOp satellite météorologique' },
  'iss:metopc': { fr: 'MetOp', en: 'MetOp', sky: 'MetOp-C', search: 'MetOp satellite météorologique' },
  'iss:gpm': { fr: 'Global_Precipitation_Measurement', en: 'Global_Precipitation_Measurement', sky: 'GPM', search: 'GPM Global Precipitation Measurement satellite' },
  'iss:swift': { fr: 'Swift_(télescope_spatial)', en: 'Neil_Gehrels_Swift_Observatory', sky: 'Swift', search: 'Swift télescope spatial NASA' },
  'iss:fermi': { fr: 'Fermi_Gamma-ray_Space_Telescope', en: 'Fermi_Gamma-ray_Space_Telescope', sky: 'Fermi', search: 'Fermi Gamma-ray Space Telescope' },
  'iss:astra192': { fr: 'Astra 19.2E', en: 'Astra 19.2E', sky: 'Astra', search: 'Astra 19.2E satellite SES' },
  'iss:starlink': { fr: 'Starlink', en: 'Starlink', sky: 'Starlink', search: 'Starlink constellation satellite SpaceX' },
  'iss:tess': { fr: 'Transiting_Exoplanet_Survey_Satellite', en: 'Transiting_Exoplanet_Survey_Satellite', sky: 'TESS', search: 'TESS satellite NASA' },
  'iss:chandra': { fr: 'Chandra_(télescope_spatial)', en: 'Chandra_X-ray_Observatory', sky: 'Chandra', search: 'Chandra télescope X NASA' },
  'iss:xmm': { fr: 'XMM-Newton', en: 'XMM-Newton', sky: 'XMM-Newton', search: 'XMM-Newton satellite ESA' },
  'iss:xrism': { fr: 'XRISM', en: 'XRISM', sky: 'XRISM', search: 'XRISM satellite JAXA NASA' },
  'iss:euclid': { fr: 'Euclid_(télescope_spatial)', en: 'Euclid_(spacecraft)', sky: 'Euclid', search: 'Euclid télescope spatial ESA' },
  'iss:gaia': { fr: 'Gaia_(satellite)', en: 'Gaia_(spacecraft)', sky: 'Gaia', search: 'Gaia satellite ESA' },
  'iss:noaa19': { fr: 'NOAA-19', en: 'NOAA-19', sky: 'NOAA-19', search: 'NOAA-19 satellite' },
  'iss:goes16': { fr: 'GOES-16', en: 'GOES-16', sky: 'GOES-16', search: 'GOES-16 satellite NOAA' },
  'iss:meteosat11': { fr: 'Meteosat', en: 'Meteosat', sky: 'Meteosat-11', search: 'Meteosat-11 satellite EUMETSAT' },
  'iss:mtgi1': { fr: 'Meteosat_Third_Generation', en: 'Meteosat_Third_Generation', sky: 'MTG-I1', search: 'MTG-I1 Meteosat-12' },
  'iss:himawari9': { fr: 'Himawari_9', en: 'Himawari_9', sky: 'Himawari-9', search: 'Himawari-9 satellite' },
  'iss:pleiades1a': { fr: 'Pléiades_(satellite)', en: 'Pleiades_(satellite)', sky: 'Pleiades-1A', search: 'Pléiades 1A satellite CNES' },
  'iss:spot6': { fr: 'SPOT_6', en: 'SPOT_(satellite)', sky: 'SPOT-6', search: 'SPOT-6 satellite' },
  'iss:swot': { fr: 'Surface_Water_and_Ocean_Topography', en: 'Surface_Water_and_Ocean_Topography', sky: 'SWOT', search: 'SWOT satellite NASA CNES' },
  'iss:smap': { fr: 'Soil_Moisture_Active_Passive', en: 'Soil_Moisture_Active_Passive', sky: 'SMAP', search: 'SMAP satellite NASA' },
  'iss:icesat2': { fr: 'ICESat-2', en: 'ICESat-2', sky: 'ICESat-2', search: 'ICESat-2 satellite NASA' },
  'iss:oco2': { fr: 'Orbiting_Carbon_Observatory_2', en: 'Orbiting_Carbon_Observatory_2', sky: 'OCO-2', search: 'OCO-2 satellite NASA' },
  'iss:bluewalker3': { fr: 'BlueWalker_3', en: 'BlueWalker_3', sky: 'BlueWalker 3', search: 'BlueWalker 3 satellite AST SpaceMobile' },
  'iss:eutelsat5w': { fr: 'Eutelsat_5_West_A', en: 'Eutelsat_5_West_B', sky: 'Eutelsat 5 West', search: 'Eutelsat 5 West B Fransat' },
  'iss:hotbird13': { fr: 'Hot_Bird', en: 'Hot_Bird', sky: 'Hotbird 13', search: 'Hotbird 13E Eutelsat' }
};

const ASTRO_HELP_TERMS: ReadonlyArray<HelpTerm> = [
  { id: 'azimuth', termKey: 'ASTRO_COMPASS.HELP_AZIMUTH', defKey: 'ASTRO_COMPASS.HELP_AZIMUTH_DEF', aliases: 'azimut azimuth direction nord est sud ouest' },
  { id: 'elevation', termKey: 'ASTRO_COMPASS.HELP_ELEVATION', defKey: 'ASTRO_COMPASS.HELP_ELEVATION_DEF', aliases: 'elevation altitude angle ciel horizon' },
  { id: 'horizon', termKey: 'ASTRO_COMPASS.HELP_HORIZON', defKey: 'ASTRO_COMPASS.HELP_HORIZON_DEF', aliases: 'horizon visible invisible' },
  { id: 'heading', termKey: 'ASTRO_COMPASS.HELP_HEADING', defKey: 'ASTRO_COMPASS.HELP_HEADING_DEF', aliases: 'cap heading boussole telephone' },
  { id: 'hud-target', termKey: 'ASTRO_COMPASS.HELP_HUD_TARGET', defKey: 'ASTRO_COMPASS.HELP_HUD_TARGET_DEF', aliases: 'cible objet direction elevation azimut' },
  { id: 'hud-camera', termKey: 'ASTRO_COMPASS.HELP_HUD_CAMERA', defKey: 'ASTRO_COMPASS.HELP_HUD_CAMERA_DEF', aliases: 'camera visee telephone direction elevation' },
  { id: 'ra', termKey: 'ASTRO_COMPASS.HELP_RA', defKey: 'ASTRO_COMPASS.HELP_RA_DEF', aliases: 'ad ra ascension droite right ascension heures' },
  { id: 'dec', termKey: 'ASTRO_COMPASS.HELP_DEC', defKey: 'ASTRO_COMPASS.HELP_DEC_DEF', aliases: 'dec declinaison declination latitude celeste' },
  { id: 'mag', termKey: 'ASTRO_COMPASS.HELP_MAG', defKey: 'ASTRO_COMPASS.HELP_MAG_DEF', aliases: 'magnitude luminosite brillance mag' },
  { id: 'phase', termKey: 'ASTRO_COMPASS.HELP_PHASE', defKey: 'ASTRO_COMPASS.HELP_PHASE_DEF', aliases: 'phase fraction eclairee lune' },
  { id: 'phase-angle', termKey: 'ASTRO_COMPASS.HELP_PHASE_ANGLE', defKey: 'ASTRO_COMPASS.HELP_PHASE_ANGLE_DEF', aliases: 'angle de phase opposition conjonction' },
  { id: 'elong', termKey: 'ASTRO_COMPASS.HELP_ELONG', defKey: 'ASTRO_COMPASS.HELP_ELONG_DEF', aliases: 'elongation mercure venus soleil' },
  { id: 'geo', termKey: 'ASTRO_COMPASS.HELP_GEO', defKey: 'ASTRO_COMPASS.HELP_GEO_DEF', aliases: 'distance terre geo au km' },
  { id: 'helio', termKey: 'ASTRO_COMPASS.HELP_HELIO', defKey: 'ASTRO_COMPASS.HELP_HELIO_DEF', aliases: 'distance soleil helio perihelie' },
  { id: 'au', termKey: 'ASTRO_COMPASS.HELP_AU', defKey: 'ASTRO_COMPASS.HELP_AU_DEF', aliases: 'au ua unite astronomique astronomical unit' },
  { id: 'const', termKey: 'ASTRO_COMPASS.HELP_CONST', defKey: 'ASTRO_COMPASS.HELP_CONST_DEF', aliases: 'constellation orion ours' },
  { id: 'rise', termKey: 'ASTRO_COMPASS.HELP_RISE', defKey: 'ASTRO_COMPASS.HELP_RISE_DEF', aliases: 'lever rise' },
  { id: 'set', termKey: 'ASTRO_COMPASS.HELP_SET', defKey: 'ASTRO_COMPASS.HELP_SET_DEF', aliases: 'coucher set' },
  { id: 'culm', termKey: 'ASTRO_COMPASS.HELP_CULM', defKey: 'ASTRO_COMPASS.HELP_CULM_DEF', aliases: 'culmination plus haut' },
  { id: 'transit', termKey: 'ASTRO_COMPASS.HELP_TRANSIT', defKey: 'ASTRO_COMPASS.HELP_TRANSIT_DEF', aliases: 'meridien transit passage' },
  { id: 'circum', termKey: 'ASTRO_COMPASS.HELP_CIRCUM', defKey: 'ASTRO_COMPASS.HELP_CIRCUM_DEF', aliases: 'circumpolaire toujours visible' },
  { id: 'viswin', termKey: 'ASTRO_COMPASS.HELP_VISWIN', defKey: 'ASTRO_COMPASS.HELP_VISWIN_DEF', aliases: 'fenetre visibilite duree' },
  { id: 'alt', termKey: 'ASTRO_COMPASS.HELP_ALT', defKey: 'ASTRO_COMPASS.HELP_ALT_DEF', aliases: 'altitude satellite km' },
  { id: 'slant', termKey: 'ASTRO_COMPASS.HELP_SLANT', defKey: 'ASTRO_COMPASS.HELP_SLANT_DEF', aliases: 'distance directe slant range' },
  { id: 'ground', termKey: 'ASTRO_COMPASS.HELP_GROUND', defKey: 'ASTRO_COMPASS.HELP_GROUND_DEF', aliases: 'distance sol ground nadir' },
  { id: 'pass', termKey: 'ASTRO_COMPASS.HELP_PASS', defKey: 'ASTRO_COMPASS.HELP_PASS_DEF', aliases: 'passage satellite pass iss' },
  { id: 'vel', termKey: 'ASTRO_COMPASS.HELP_VEL', defKey: 'ASTRO_COMPASS.HELP_VEL_DEF', aliases: 'vitesse velocity orbite' },
  { id: 'lat', termKey: 'ASTRO_COMPASS.HELP_LAT', defKey: 'ASTRO_COMPASS.HELP_LAT_DEF', aliases: 'latitude lat gps' },
  { id: 'lon', termKey: 'ASTRO_COMPASS.HELP_LON', defKey: 'ASTRO_COMPASS.HELP_LON_DEF', aliases: 'longitude lon gps' },
  { id: 'pitch', termKey: 'ASTRO_COMPASS.HELP_PITCH', defKey: 'ASTRO_COMPASS.HELP_PITCH_DEF', aliases: 'inclinaison pitch telephone' },
  { id: 'true-n', termKey: 'ASTRO_COMPASS.HELP_TRUE_N', defKey: 'ASTRO_COMPASS.HELP_TRUE_N_DEF', aliases: 'nord geographique magnetique declinaison' },
  { id: 'planet', termKey: 'ASTRO_COMPASS.HELP_PLANET', defKey: 'ASTRO_COMPASS.HELP_PLANET_DEF', aliases: 'planete systeme solaire lune soleil' },
  { id: 'star', termKey: 'ASTRO_COMPASS.HELP_STAR', defKey: 'ASTRO_COMPASS.HELP_STAR_DEF', aliases: 'etoile star' },
  { id: 'galaxy', termKey: 'ASTRO_COMPASS.HELP_GALAXY', defKey: 'ASTRO_COMPASS.HELP_GALAXY_DEF', aliases: 'galaxie andromede' },
  { id: 'sat', termKey: 'ASTRO_COMPASS.HELP_SAT', defKey: 'ASTRO_COMPASS.HELP_SAT_DEF', aliases: 'satellite iss hubble' },
  { id: 'iss', termKey: 'ASTRO_COMPASS.HELP_ISS', defKey: 'ASTRO_COMPASS.HELP_ISS_DEF', aliases: 'iss station spatiale' },
  { id: 'zenith', termKey: 'ASTRO_COMPASS.HELP_ZENITH', defKey: 'ASTRO_COMPASS.HELP_ZENITH_DEF', aliases: 'zenith 90' },
  { id: 'nadir', termKey: 'ASTRO_COMPASS.HELP_NADIR', defKey: 'ASTRO_COMPASS.HELP_NADIR_DEF', aliases: 'nadir -90' },
  { id: 'card', termKey: 'ASTRO_COMPASS.HELP_CARD', defKey: 'ASTRO_COMPASS.HELP_CARD_DEF', aliases: 'cardinal n e s o ne no' },
  { id: 'obs', termKey: 'ASTRO_COMPASS.HELP_OBS', defKey: 'ASTRO_COMPASS.HELP_OBS_DEF', aliases: 'observateur position gps adresse' },
  { id: 'sight', termKey: 'ASTRO_COMPASS.HELP_SIGHT', defKey: 'ASTRO_COMPASS.HELP_SIGHT_DEF', aliases: 'position exacte calage visee pointeur reticle sighting' },
  { id: 'pose', termKey: 'ASTRO_COMPASS.HELP_POSE', defKey: 'ASTRO_COMPASS.HELP_POSE_DEF', aliases: 'pause pose figer freeze hold viseur objet' },
  { id: 'trail', termKey: 'ASTRO_COMPASS.HELP_TRAIL', defKey: 'ASTRO_COMPASS.HELP_TRAIL_DEF', aliases: 'trajectoire trajectory trace orbite futur path viseur duree duration minutes' },
  { id: 'asterism', termKey: 'ASTRO_COMPASS.HELP_ASTERISM', defKey: 'ASTRO_COMPASS.HELP_ASTERISM_DEF', aliases: 'asterisme asterism casserole triangle ete ceinture orion' },
  { id: 'zodiac', termKey: 'ASTRO_COMPASS.HELP_ZODIAC', defKey: 'ASTRO_COMPASS.HELP_ZODIAC_DEF', aliases: 'zodiaque zodiac belier lion verseau' },
  { id: 'ecliptic', termKey: 'ASTRO_COMPASS.HELP_ECLIPTIC', defKey: 'ASTRO_COMPASS.HELP_ECLIPTIC_DEF', aliases: 'ecliptique ecliptic plan solaire zodiaque' },
  { id: 'celeq', termKey: 'ASTRO_COMPASS.HELP_CELEQ', defKey: 'ASTRO_COMPASS.HELP_CELEQ_DEF', aliases: 'equateur celeste celestial equator declinaison 0' },
  { id: 'sphere', termKey: 'ASTRO_COMPASS.HELP_SPHERE', defKey: 'ASTRO_COMPASS.HELP_SPHERE_DEF', aliases: 'sphere celeste celestial sphere voûte' },
  { id: 'meridian', termKey: 'ASTRO_COMPASS.HELP_MERIDIAN', defKey: 'ASTRO_COMPASS.HELP_MERIDIAN_DEF', aliases: 'meridien local nord sud zenith' },
  { id: 'ly', termKey: 'ASTRO_COMPASS.HELP_LY', defKey: 'ASTRO_COMPASS.HELP_LY_DEF', aliases: 'annee lumiere light year ly distance etoile' },
  { id: 'parsec', termKey: 'ASTRO_COMPASS.HELP_PARSEC', defKey: 'ASTRO_COMPASS.HELP_PARSEC_DEF', aliases: 'parsec pc mpc megaparsec distance galaxie' },
  { id: 'absmag', termKey: 'ASTRO_COMPASS.HELP_ABSMAG', defKey: 'ASTRO_COMPASS.HELP_ABSMAG_DEF', aliases: 'magnitude absolue absolute magnitude luminosite intrinseque' },
  { id: 'spectral', termKey: 'ASTRO_COMPASS.HELP_SPECTRAL', defKey: 'ASTRO_COMPASS.HELP_SPECTRAL_DEF', aliases: 'type spectral obafgkm couleur temperature etoile' },
  { id: 'binary', termKey: 'ASTRO_COMPASS.HELP_BINARY', defKey: 'ASTRO_COMPASS.HELP_BINARY_DEF', aliases: 'etoile double binaire albireo mizar alcor' },
  { id: 'variable', termKey: 'ASTRO_COMPASS.HELP_VARIABLE', defKey: 'ASTRO_COMPASS.HELP_VARIABLE_DEF', aliases: 'etoile variable cepheide algol mira' },
  { id: 'polestar', termKey: 'ASTRO_COMPASS.HELP_POLESTAR', defKey: 'ASTRO_COMPASS.HELP_POLESTAR_DEF', aliases: 'etoile polaire polaris sigma octantis nord sud' },
  { id: 'redgiant', termKey: 'ASTRO_COMPASS.HELP_REDGIANT', defKey: 'ASTRO_COMPASS.HELP_REDGIANT_DEF', aliases: 'geante rouge betelgeuse antares aldebaran' },
  { id: 'supernova', termKey: 'ASTRO_COMPASS.HELP_SUPERNOVA', defKey: 'ASTRO_COMPASS.HELP_SUPERNOVA_DEF', aliases: 'supernova explosion etoile neutron trou noir' },
  { id: 'messier', termKey: 'ASTRO_COMPASS.HELP_MESSIER', defKey: 'ASTRO_COMPASS.HELP_MESSIER_DEF', aliases: 'messier m31 m51 catalogue' },
  { id: 'ngc', termKey: 'ASTRO_COMPASS.HELP_NGC', defKey: 'ASTRO_COMPASS.HELP_NGC_DEF', aliases: 'ngc ic new general catalogue caldwell' },
  { id: 'localgroup', termKey: 'ASTRO_COMPASS.HELP_LOCALGROUP', defKey: 'ASTRO_COMPASS.HELP_LOCALGROUP_DEF', aliases: 'groupe local voie lactee andromede magellan' },
  { id: 'lmc', termKey: 'ASTRO_COMPASS.HELP_LMC', defKey: 'ASTRO_COMPASS.HELP_LMC_DEF', aliases: 'nuages magellan lmc smc galaxies naines' },
  { id: 'deepsky', termKey: 'ASTRO_COMPASS.HELP_DEEPSKY', defKey: 'ASTRO_COMPASS.HELP_DEEPSKY_DEF', aliases: 'ciel profond dso nebuleuse amas galaxie' },
  { id: 'cluster', termKey: 'ASTRO_COMPASS.HELP_CLUSTER', defKey: 'ASTRO_COMPASS.HELP_CLUSTER_DEF', aliases: 'amas ouvert globulaire pleiades hyades' },
  { id: 'nebula', termKey: 'ASTRO_COMPASS.HELP_NEBULA', defKey: 'ASTRO_COMPASS.HELP_NEBULA_DEF', aliases: 'nebuleuse orion m42 gaz poussiere' },
  { id: 'spiral', termKey: 'ASTRO_COMPASS.HELP_SPIRAL', defKey: 'ASTRO_COMPASS.HELP_SPIRAL_DEF', aliases: 'galaxie spirale elliptique irreguliere andromede' },
  { id: 'quasar', termKey: 'ASTRO_COMPASS.HELP_QUASAR', defKey: 'ASTRO_COMPASS.HELP_QUASAR_DEF', aliases: 'quasar trou noir supermassif noyau actif' },
  { id: 'tle', termKey: 'ASTRO_COMPASS.HELP_TLE', defKey: 'ASTRO_COMPASS.HELP_TLE_DEF', aliases: 'tle two line elements orbit satellite' },
  { id: 'norad', termKey: 'ASTRO_COMPASS.HELP_NORAD', defKey: 'ASTRO_COMPASS.HELP_NORAD_DEF', aliases: 'norad catalog number satcat iss 25544' },
  { id: 'leo', termKey: 'ASTRO_COMPASS.HELP_LEO', defKey: 'ASTRO_COMPASS.HELP_LEO_DEF', aliases: 'orbite basse leo meo heo iss hubble' },
  { id: 'geoorb', termKey: 'ASTRO_COMPASS.HELP_GEOORB', defKey: 'ASTRO_COMPASS.HELP_GEOORB_DEF', aliases: 'geostationnaire geo astra hotbird meteosat 35786' },
  { id: 'l2', termKey: 'ASTRO_COMPASS.HELP_L2', defKey: 'ASTRO_COMPASS.HELP_L2_DEF', aliases: 'lagrange l2 james webb euclid gaia' },
  { id: 'incl', termKey: 'ASTRO_COMPASS.HELP_INCL', defKey: 'ASTRO_COMPASS.HELP_INCL_DEF', aliases: 'inclinaison orbitale polar heliosynchrone' },
  { id: 'period', termKey: 'ASTRO_COMPASS.HELP_PERIOD', defKey: 'ASTRO_COMPASS.HELP_PERIOD_DEF', aliases: 'periode orbitale revolution 90 min iss' },
  { id: 'apogee', termKey: 'ASTRO_COMPASS.HELP_APOGEE', defKey: 'ASTRO_COMPASS.HELP_APOGEE_DEF', aliases: 'apogee perigee perihelie aphelie orbite' },
  { id: 'sgp4', termKey: 'ASTRO_COMPASS.HELP_SGP4', defKey: 'ASTRO_COMPASS.HELP_SGP4_DEF', aliases: 'sgp4 propagation tle position satellite' },
  { id: 'starlink', termKey: 'ASTRO_COMPASS.HELP_STARLINK', defKey: 'ASTRO_COMPASS.HELP_STARLINK_DEF', aliases: 'starlink train chaine satellites spacex' },
  { id: 'opposition', termKey: 'ASTRO_COMPASS.HELP_OPPOSITION', defKey: 'ASTRO_COMPASS.HELP_OPPOSITION_DEF', aliases: 'opposition mars jupiter pleine lune' },
  { id: 'conjunction', termKey: 'ASTRO_COMPASS.HELP_CONJUNCTION', defKey: 'ASTRO_COMPASS.HELP_CONJUNCTION_DEF', aliases: 'conjonction soleil mercure venus' },
  { id: 'retro', termKey: 'ASTRO_COMPASS.HELP_RETRO', defKey: 'ASTRO_COMPASS.HELP_RETRO_DEF', aliases: 'retrograde retrogradation mars planete' },
  { id: 'equinox', termKey: 'ASTRO_COMPASS.HELP_EQUINOX', defKey: 'ASTRO_COMPASS.HELP_EQUINOX_DEF', aliases: 'equinoxe printemps automne jour nuit' },
  { id: 'solstice', termKey: 'ASTRO_COMPASS.HELP_SOLSTICE', defKey: 'ASTRO_COMPASS.HELP_SOLSTICE_DEF', aliases: 'solstice ete hiver plus long jour' },
  { id: 'sidereal', termKey: 'ASTRO_COMPASS.HELP_SIDEREAL', defKey: 'ASTRO_COMPASS.HELP_SIDEREAL_DEF', aliases: 'temps sideral rotation ciel etoiles' },
  { id: 'j2000', termKey: 'ASTRO_COMPASS.HELP_J2000', defKey: 'ASTRO_COMPASS.HELP_J2000_DEF', aliases: 'j2000 epoque equinoxe catalogue ad dec' },
  { id: 'lightpol', termKey: 'ASTRO_COMPASS.HELP_LIGHTPOL', defKey: 'ASTRO_COMPASS.HELP_LIGHTPOL_DEF', aliases: 'pollution lumineuse ville ciel noir galaxies' },
  { id: 'refraction', termKey: 'ASTRO_COMPASS.HELP_REFRACTION', defKey: 'ASTRO_COMPASS.HELP_REFRACTION_DEF', aliases: 'refraction atmosphere horizon lever coucher' },
  { id: 'arcsec', termKey: 'ASTRO_COMPASS.HELP_ARCSEC', defKey: 'ASTRO_COMPASS.HELP_ARCSEC_DEF', aliases: 'minute seconde arc degree angulaire' },
  { id: 'angular', termKey: 'ASTRO_COMPASS.HELP_ANGULAR', defKey: 'ASTRO_COMPASS.HELP_ANGULAR_DEF', aliases: 'taille angulaire diametre apparent lune soleil' },
  { id: 'comet', termKey: 'ASTRO_COMPASS.HELP_COMET', defKey: 'ASTRO_COMPASS.HELP_COMET_DEF', aliases: 'comete coma queue halley' },
  { id: 'asteroid', termKey: 'ASTRO_COMPASS.HELP_ASTEROID', defKey: 'ASTRO_COMPASS.HELP_ASTEROID_DEF', aliases: 'asteroide ceinture ceres vesta' },
  { id: 'dwarf', termKey: 'ASTRO_COMPASS.HELP_DWARF', defKey: 'ASTRO_COMPASS.HELP_DWARF_DEF', aliases: 'planete naine pluton ceres eris' },
  { id: 'magfilter', termKey: 'ASTRO_COMPASS.HELP_MAGFILTER', defKey: 'ASTRO_COMPASS.HELP_MAGFILTER_DEF', aliases: 'filtre magnitude curseur oeil nu jumelles' },
  { id: 'visibleonly', termKey: 'ASTRO_COMPASS.HELP_VISIBLEONLY', defKey: 'ASTRO_COMPASS.HELP_VISIBLEONLY_DEF', aliases: 'visibles seulement horizon liste cibles' },
  { id: 'milkyway', termKey: 'ASTRO_COMPASS.HELP_MILKYWAY', defKey: 'ASTRO_COMPASS.HELP_MILKYWAY_DEF', aliases: 'voie lactee milky way notre galaxie bande' },
  { id: 'bayer', termKey: 'ASTRO_COMPASS.HELP_BAYER', defKey: 'ASTRO_COMPASS.HELP_BAYER_DEF', aliases: 'bayer flamsteed alpha beta designation grec' },
  { id: 'parallax', termKey: 'ASTRO_COMPASS.HELP_PARALLAX', defKey: 'ASTRO_COMPASS.HELP_PARALLAX_DEF', aliases: 'parallaxe distance etoile parsec gaia' },
  { id: 'propermot', termKey: 'ASTRO_COMPASS.HELP_PROPERMOT', defKey: 'ASTRO_COMPASS.HELP_PROPERMOT_DEF', aliases: 'mouvement propre proper motion barnard' },
  { id: 'twinkle', termKey: 'ASTRO_COMPASS.HELP_TWINKLE', defKey: 'ASTRO_COMPASS.HELP_TWINKLE_DEF', aliases: 'scintillation twinkle etoile planete iss' },
  { id: 'whitedwarf', termKey: 'ASTRO_COMPASS.HELP_WHITEDWARF', defKey: 'ASTRO_COMPASS.HELP_WHITEDWARF_DEF', aliases: 'naine blanche white dwarf sirius b' },
  { id: 'neutron', termKey: 'ASTRO_COMPASS.HELP_NEUTRON', defKey: 'ASTRO_COMPASS.HELP_NEUTRON_DEF', aliases: 'etoile neutrons pulsar crab nebula' },
  { id: 'blackhole', termKey: 'ASTRO_COMPASS.HELP_BLACKHOLE', defKey: 'ASTRO_COMPASS.HELP_BLACKHOLE_DEF', aliases: 'trou noir black hole m87 sagittaire a' },
  { id: 'mainseq', termKey: 'ASTRO_COMPASS.HELP_MAINSEQ', defKey: 'ASTRO_COMPASS.HELP_MAINSEQ_DEF', aliases: 'sequence principale main sequence soleil' },
  { id: 'exoplanet', termKey: 'ASTRO_COMPASS.HELP_EXOPLANET', defKey: 'ASTRO_COMPASS.HELP_EXOPLANET_DEF', aliases: 'exoplanete extrasolaire tess kepler' },
  { id: 'redshift', termKey: 'ASTRO_COMPASS.HELP_REDSHIFT', defKey: 'ASTRO_COMPASS.HELP_REDSHIFT_DEF', aliases: 'redshift decalage rouge expansion univers' },
  { id: 'virgo', termKey: 'ASTRO_COMPASS.HELP_VIRGO', defKey: 'ASTRO_COMPASS.HELP_VIRGO_DEF', aliases: 'amas vierge virgo cluster m87 m49' },
  { id: 'iau', termKey: 'ASTRO_COMPASS.HELP_IAU', defKey: 'ASTRO_COMPASS.HELP_IAU_DEF', aliases: 'uai iau 88 constellations union astronomique' },
  { id: 'stickfig', termKey: 'ASTRO_COMPASS.HELP_STICKFIG', defKey: 'ASTRO_COMPASS.HELP_STICKFIG_DEF', aliases: 'figure constellation traits astérisme viseur' },
  { id: 'meo', termKey: 'ASTRO_COMPASS.HELP_MEO', defKey: 'ASTRO_COMPASS.HELP_MEO_DEF', aliases: 'orbite moyenne meo gps galileo' },
  { id: 'sso', termKey: 'ASTRO_COMPASS.HELP_SSO', defKey: 'ASTRO_COMPASS.HELP_SSO_DEF', aliases: 'heliosynchrone sso polar sentinel landsat' },
  { id: 'flare', termKey: 'ASTRO_COMPASS.HELP_FLARE', defKey: 'ASTRO_COMPASS.HELP_FLARE_DEF', aliases: 'eclat satellite iridium flare starlink' },
  { id: 'spacetel', termKey: 'ASTRO_COMPASS.HELP_SPACETEL', defKey: 'ASTRO_COMPASS.HELP_SPACETEL_DEF', aliases: 'telescope spatial hubble jwst chandra xmm' },
  { id: 'tiangong', termKey: 'ASTRO_COMPASS.HELP_TIANGONG', defKey: 'ASTRO_COMPASS.HELP_TIANGONG_DEF', aliases: 'tiangong css station chinoise tianhe' },
  { id: 'eclipse', termKey: 'ASTRO_COMPASS.HELP_ECLIPSE', defKey: 'ASTRO_COMPASS.HELP_ECLIPSE_DEF', aliases: 'eclipse solaire lunaire ombre' },
  { id: 'occult', termKey: 'ASTRO_COMPASS.HELP_OCCULT', defKey: 'ASTRO_COMPASS.HELP_OCCULT_DEF', aliases: 'occultation lune etoile planete' },
  { id: 'twilight', termKey: 'ASTRO_COMPASS.HELP_TWILIGHT', defKey: 'ASTRO_COMPASS.HELP_TWILIGHT_DEF', aliases: 'crepuscule civil nautique astronomique' },
  { id: 'seeing', termKey: 'ASTRO_COMPASS.HELP_SEEING', defKey: 'ASTRO_COMPASS.HELP_SEEING_DEF', aliases: 'seeing turbulence atmosphere jumelles' },
  { id: 'bortle', termKey: 'ASTRO_COMPASS.HELP_BORTLE', defKey: 'ASTRO_COMPASS.HELP_BORTLE_DEF', aliases: 'bortle ciel noir echelle pollution' },
  { id: 'meteor', termKey: 'ASTRO_COMPASS.HELP_METEOR', defKey: 'ASTRO_COMPASS.HELP_METEOR_DEF', aliases: 'meteore meteorite bolide etoile filante' },
  { id: 'shower', termKey: 'ASTRO_COMPASS.HELP_SHOWER', defKey: 'ASTRO_COMPASS.HELP_SHOWER_DEF', aliases: 'pluie etoiles perseides geminides radiant' },
  { id: 'aurora', termKey: 'ASTRO_COMPASS.HELP_AURORA', defKey: 'ASTRO_COMPASS.HELP_AURORA_DEF', aliases: 'aurore boreale australe nord lumiere' },
  { id: 'zodlight', termKey: 'ASTRO_COMPASS.HELP_ZODLIGHT', defKey: 'ASTRO_COMPASS.HELP_ZODLIGHT_DEF', aliases: 'lumiere zodiacale poussiere ecliptique' },
  { id: 'albedo', termKey: 'ASTRO_COMPASS.HELP_ALBEDO', defKey: 'ASTRO_COMPASS.HELP_ALBEDO_DEF', aliases: 'albedo reflexion lune venus' },
  { id: 'earthshine', termKey: 'ASTRO_COMPASS.HELP_EARTHSHINE', defKey: 'ASTRO_COMPASS.HELP_EARTHSHINE_DEF', aliases: 'clair de terre earthshine lune croissante' },
  { id: 'libration', termKey: 'ASTRO_COMPASS.HELP_LIBRATION', defKey: 'ASTRO_COMPASS.HELP_LIBRATION_DEF', aliases: 'libration lune face cachee' },
  { id: 'supermoon', termKey: 'ASTRO_COMPASS.HELP_SUPERMOON', defKey: 'ASTRO_COMPASS.HELP_SUPERMOON_DEF', aliases: 'superlune perigee pleine lune' },
  { id: 'gasgiant', termKey: 'ASTRO_COMPASS.HELP_GASGIANT', defKey: 'ASTRO_COMPASS.HELP_GASGIANT_DEF', aliases: 'geante gazeuse glacee jupiter saturne uranus' },
  { id: 'kuiper', termKey: 'ASTRO_COMPASS.HELP_KUIPER', defKey: 'ASTRO_COMPASS.HELP_KUIPER_DEF', aliases: 'ceinture kuiper pluton transneptunien' },
  { id: 'oort', termKey: 'ASTRO_COMPASS.HELP_OORT', defKey: 'ASTRO_COMPASS.HELP_OORT_DEF', aliases: 'nuage oort cometes longues periodes' },
  { id: 'precession', termKey: 'ASTRO_COMPASS.HELP_PRECESSION', defKey: 'ASTRO_COMPASS.HELP_PRECESSION_DEF', aliases: 'precession equinoxes polaris thuban' },
  { id: 'hourangle', termKey: 'ASTRO_COMPASS.HELP_HOURANGLE', defKey: 'ASTRO_COMPASS.HELP_HOURANGLE_DEF', aliases: 'angle horaire hour angle meridien' },
  { id: 'fov', termKey: 'ASTRO_COMPASS.HELP_FOV', defKey: 'ASTRO_COMPASS.HELP_FOV_DEF', aliases: 'champ vision fov camera viseur' },
  { id: 'surfbright', termKey: 'ASTRO_COMPASS.HELP_SURFBRIGHT', defKey: 'ASTRO_COMPASS.HELP_SURFBRIGHT_DEF', aliases: 'brillance surface galaxies etendues' },
  { id: 'averted', termKey: 'ASTRO_COMPASS.HELP_AVERTED', defKey: 'ASTRO_COMPASS.HELP_AVERTED_DEF', aliases: 'vision decalee averted vision periferique' },
  { id: 'darkadapt', termKey: 'ASTRO_COMPASS.HELP_DARKADAPT', defKey: 'ASTRO_COMPASS.HELP_DARKADAPT_DEF', aliases: 'adaptation obscurite night vision rouge' },
  { id: 'inferior', termKey: 'ASTRO_COMPASS.HELP_INFERIOR', defKey: 'ASTRO_COMPASS.HELP_INFERIOR_DEF', aliases: 'planete inferieure superieure mercure venus' },
  { id: 'planneb', termKey: 'ASTRO_COMPASS.HELP_PLANNEB', defKey: 'ASTRO_COMPASS.HELP_PLANNEB_DEF', aliases: 'nebuleuse planetaire lyre helice naine blanche' },
  { id: 'terminator', termKey: 'ASTRO_COMPASS.HELP_TERMINATOR', defKey: 'ASTRO_COMPASS.HELP_TERMINATOR_DEF', aliases: 'terminateur lune jour nuit relief' },
  { id: 'umbra', termKey: 'ASTRO_COMPASS.HELP_UMBRA', defKey: 'ASTRO_COMPASS.HELP_UMBRA_DEF', aliases: 'ombre penombre eclipse umbra' },
  { id: 'hr', termKey: 'ASTRO_COMPASS.HELP_HR', defKey: 'ASTRO_COMPASS.HELP_HR_DEF', aliases: 'diagramme hr hertzsprung russell sequence principale' },
  { id: 'lumclass', termKey: 'ASTRO_COMPASS.HELP_LUMCLASS', defKey: 'ASTRO_COMPASS.HELP_LUMCLASS_DEF', aliases: 'classe luminosite mk i v supergéante naine' },
  { id: 'teff', termKey: 'ASTRO_COMPASS.HELP_TEFF', defKey: 'ASTRO_COMPASS.HELP_TEFF_DEF', aliases: 'temperature effective kelvin teff photosphere' },
  { id: 'metal', termKey: 'ASTRO_COMPASS.HELP_METAL', defKey: 'ASTRO_COMPASS.HELP_METAL_DEF', aliases: 'metallicite fe/h population i ii' },
  { id: 'chandrasekhar', termKey: 'ASTRO_COMPASS.HELP_CHANDRA', defKey: 'ASTRO_COMPASS.HELP_CHANDRA_DEF', aliases: 'chandrasekhar 1.4 masse solaire naine blanche' },
  { id: 'schwarzschild', termKey: 'ASTRO_COMPASS.HELP_SCHWARZ', defKey: 'ASTRO_COMPASS.HELP_SCHWARZ_DEF', aliases: 'schwarzschild horizon evenements rayon trou noir' },
  { id: 'accretion', termKey: 'ASTRO_COMPASS.HELP_ACCRETION', defKey: 'ASTRO_COMPASS.HELP_ACCRETION_DEF', aliases: 'disque accretion quasar x-ray binaire' },
  { id: 'browndwarf', termKey: 'ASTRO_COMPASS.HELP_BROWNDWARF', defKey: 'ASTRO_COMPASS.HELP_BROWNDWARF_DEF', aliases: 'naine brune brown dwarf l t y deuterium' },
  { id: 'wolfrayet', termKey: 'ASTRO_COMPASS.HELP_WOLFRAYET', defKey: 'ASTRO_COMPASS.HELP_WOLFRAYET_DEF', aliases: 'wolf rayet wr vent stellaire massive' },
  { id: 'cepheid', termKey: 'ASTRO_COMPASS.HELP_CEPHEID', defKey: 'ASTRO_COMPASS.HELP_CEPHEID_DEF', aliases: 'cepheide periode luminosite chandelle standard' },
  { id: 'snr', termKey: 'ASTRO_COMPASS.HELP_SNR', defKey: 'ASTRO_COMPASS.HELP_SNR_DEF', aliases: 'remanent supernova snr crabe m1 cassiopeia a' },
  { id: 'hii', termKey: 'ASTRO_COMPASS.HELP_HII', defKey: 'ASTRO_COMPASS.HELP_HII_DEF', aliases: 'region hii hydrogene ionise orion m42' },
  { id: 'emneb', termKey: 'ASTRO_COMPASS.HELP_EMNEB', defKey: 'ASTRO_COMPASS.HELP_EMNEB_DEF', aliases: 'nebuleuse emission reflexion halpha m42 m78' },
  { id: 'darkneb', termKey: 'ASTRO_COMPASS.HELP_DARKNEB', defKey: 'ASTRO_COMPASS.HELP_DARKNEB_DEF', aliases: 'nebuleuse sombre barnard coal sack tete cheval' },
  { id: 'agn', termKey: 'ASTRO_COMPASS.HELP_AGN', defKey: 'ASTRO_COMPASS.HELP_AGN_DEF', aliases: 'agn noyau actif galaxie seyfert blazar' },
  { id: 'seyfert', termKey: 'ASTRO_COMPASS.HELP_SEYFERT', defKey: 'ASTRO_COMPASS.HELP_SEYFERT_DEF', aliases: 'seyfert m77 ngc 1068 noyau actif' },
  { id: 'lensing', termKey: 'ASTRO_COMPASS.HELP_LENSING', defKey: 'ASTRO_COMPASS.HELP_LENSING_DEF', aliases: 'lentille gravitationnelle einstein microlensing' },
  { id: 'hubblelaw', termKey: 'ASTRO_COMPASS.HELP_HUBBLELAW', defKey: 'ASTRO_COMPASS.HELP_HUBBLELAW_DEF', aliases: 'loi hubble constante h0 expansion redshift' },
  { id: 'cmb', termKey: 'ASTRO_COMPASS.HELP_CMB', defKey: 'ASTRO_COMPASS.HELP_CMB_DEF', aliases: 'fond diffus cosmologique cmb 2.7 k big bang' },
  { id: 'darkmatter', termKey: 'ASTRO_COMPASS.HELP_DARKMATTER', defKey: 'ASTRO_COMPASS.HELP_DARKMATTER_DEF', aliases: 'matiere noire dark matter halo rotation' },
  { id: 'darkenergy', termKey: 'ASTRO_COMPASS.HELP_DARKENERGY', defKey: 'ASTRO_COMPASS.HELP_DARKENERGY_DEF', aliases: 'energie noire dark energy acceleration univers' },
  { id: 'icrs', termKey: 'ASTRO_COMPASS.HELP_ICRS', defKey: 'ASTRO_COMPASS.HELP_ICRS_DEF', aliases: 'icrs fk5 referentiel celeste gaia' },
  { id: 'galcoord', termKey: 'ASTRO_COMPASS.HELP_GALCOORD', defKey: 'ASTRO_COMPASS.HELP_GALCOORD_DEF', aliases: 'coordonnees galactiques longitude latitude l b' },
  { id: 'eclcoord', termKey: 'ASTRO_COMPASS.HELP_ECLCOORD', defKey: 'ASTRO_COMPASS.HELP_ECLCOORD_DEF', aliases: 'coordonnees ecliptiques longitude latitude lambda beta' },
  { id: 'obliquity', termKey: 'ASTRO_COMPASS.HELP_OBLIQUITY', defKey: 'ASTRO_COMPASS.HELP_OBLIQUITY_DEF', aliases: 'obliquite ecliptique 23.4 inclinaison axe' },
  { id: 'nutation', termKey: 'ASTRO_COMPASS.HELP_NUTATION', defKey: 'ASTRO_COMPASS.HELP_NUTATION_DEF', aliases: 'nutation precession axe terre lune' },
  { id: 'aberration', termKey: 'ASTRO_COMPASS.HELP_ABERRATION', defKey: 'ASTRO_COMPASS.HELP_ABERRATION_DEF', aliases: 'aberration lumiere bradley 20 arcsec' },
  { id: 'topocentric', termKey: 'ASTRO_COMPASS.HELP_TOPOCENTRIC', defKey: 'ASTRO_COMPASS.HELP_TOPOCENTRIC_DEF', aliases: 'topocentrique geocentrique observateur lune' },
  { id: 'julian', termKey: 'ASTRO_COMPASS.HELP_JULIAN', defKey: 'ASTRO_COMPASS.HELP_JULIAN_DEF', aliases: 'jour julien jd mjd epoque' },
  { id: 'lst', termKey: 'ASTRO_COMPASS.HELP_LST', defKey: 'ASTRO_COMPASS.HELP_LST_DEF', aliases: 'temps sideral local lst gst meridien' },
  { id: 'kepler', termKey: 'ASTRO_COMPASS.HELP_KEPLER', defKey: 'ASTRO_COMPASS.HELP_KEPLER_DEF', aliases: 'lois kepler ellipse aire periode' },
  { id: 'sma', termKey: 'ASTRO_COMPASS.HELP_SMA', defKey: 'ASTRO_COMPASS.HELP_SMA_DEF', aliases: 'demi grand axe semi major a ua kepler' },
  { id: 'ecc', termKey: 'ASTRO_COMPASS.HELP_ECC', defKey: 'ASTRO_COMPASS.HELP_ECC_DEF', aliases: 'excentricite ellipse orbite 0 1 comete' },
  { id: 'anomaly', termKey: 'ASTRO_COMPASS.HELP_ANOMALY', defKey: 'ASTRO_COMPASS.HELP_ANOMALY_DEF', aliases: 'anomalie moyenne vraie eccentric mean true' },
  { id: 'raan', termKey: 'ASTRO_COMPASS.HELP_RAAN', defKey: 'ASTRO_COMPASS.HELP_RAAN_DEF', aliases: 'raan noeud ascendant argument periastre omega' },
  { id: 'synodic', termKey: 'ASTRO_COMPASS.HELP_SYNODIC', defKey: 'ASTRO_COMPASS.HELP_SYNODIC_DEF', aliases: 'periode synodique siderale lune mars' },
  { id: 'quadrature', termKey: 'ASTRO_COMPASS.HELP_QUADRATURE', defKey: 'ASTRO_COMPASS.HELP_QUADRATURE_DEF', aliases: 'quadrature 90 elongation mars' },
  { id: 'roche', termKey: 'ASTRO_COMPASS.HELP_ROCHE', defKey: 'ASTRO_COMPASS.HELP_ROCHE_DEF', aliases: 'limite roche maree anneaux saturne' },
  { id: 'hill', termKey: 'ASTRO_COMPASS.HELP_HILL', defKey: 'ASTRO_COMPASS.HELP_HILL_DEF', aliases: 'sphere hill sphere influence lune satellites' },
  { id: 'tidallock', termKey: 'ASTRO_COMPASS.HELP_TIDALLOCK', defKey: 'ASTRO_COMPASS.HELP_TIDALLOCK_DEF', aliases: 'verrouillage tidal synchrone face lune' },
  { id: 'lagrange', termKey: 'ASTRO_COMPASS.HELP_LAGRANGE', defKey: 'ASTRO_COMPASS.HELP_LAGRANGE_DEF', aliases: 'points lagrange l1 l2 l3 l4 l5 jwst' },
  { id: 'airmass', termKey: 'ASTRO_COMPASS.HELP_AIRMASS', defKey: 'ASTRO_COMPASS.HELP_AIRMASS_DEF', aliases: 'masse air airmass zenith extinction' },
  { id: 'extinction', termKey: 'ASTRO_COMPASS.HELP_EXTINCTION', defKey: 'ASTRO_COMPASS.HELP_EXTINCTION_DEF', aliases: 'extinction atmosphere interstellaire reddening av' },
  { id: 'colorindex', termKey: 'ASTRO_COMPASS.HELP_COLORINDEX', defKey: 'ASTRO_COMPASS.HELP_COLORINDEX_DEF', aliases: 'indice couleur b-v ubv photometrie' },
  { id: 'pogson', termKey: 'ASTRO_COMPASS.HELP_POGSON', defKey: 'ASTRO_COMPASS.HELP_POGSON_DEF', aliases: 'pogson magnitude 2.512 flux logarithmique' },
  { id: 'nelm', termKey: 'ASTRO_COMPASS.HELP_NELM', defKey: 'ASTRO_COMPASS.HELP_NELM_DEF', aliases: 'magnitude limite oeil nu nelm limiting' },
  { id: 'zhr', termKey: 'ASTRO_COMPASS.HELP_ZHR', defKey: 'ASTRO_COMPASS.HELP_ZHR_DEF', aliases: 'taux horaire zenithal zhr perseides' },
  { id: 'airy', termKey: 'ASTRO_COMPASS.HELP_AIRY', defKey: 'ASTRO_COMPASS.HELP_AIRY_DEF', aliases: 'disque airy diffraction telescope resolution' },
  { id: 'rayleigh', termKey: 'ASTRO_COMPASS.HELP_RAYLEIGH', defKey: 'ASTRO_COMPASS.HELP_RAYLEIGH_DEF', aliases: 'critere rayleigh dawes resolution angulaire' },
  { id: 'exitpupil', termKey: 'ASTRO_COMPASS.HELP_EXITPUPIL', defKey: 'ASTRO_COMPASS.HELP_EXITPUPIL_DEF', aliases: 'pupille sortie exit pupil jumelles f/d' },
  { id: 'focalratio', termKey: 'ASTRO_COMPASS.HELP_FOCALRATIO', defKey: 'ASTRO_COMPASS.HELP_FOCALRATIO_DEF', aliases: 'ouverture f/ focale rapport newton' },
  { id: 'filters', termKey: 'ASTRO_COMPASS.HELP_FILTERS', defKey: 'ASTRO_COMPASS.HELP_FILTERS_DEF', aliases: 'filtre halpha oiii uhc nebuleuse' },
  { id: 'heo', termKey: 'ASTRO_COMPASS.HELP_HEO', defKey: 'ASTRO_COMPASS.HELP_HEO_DEF', aliases: 'orbite elliptique molniya heo apogee' },
  { id: 'meanmotion', termKey: 'ASTRO_COMPASS.HELP_MEANMOTION', defKey: 'ASTRO_COMPASS.HELP_MEANMOTION_DEF', aliases: 'mouvement moyen mean motion tle rev/jour' },
  { id: 'bstar', termKey: 'ASTRO_COMPASS.HELP_BSTAR', defKey: 'ASTRO_COMPASS.HELP_BSTAR_DEF', aliases: 'bstar trainee atmospherique tle decay' },
  { id: 'kessler', termKey: 'ASTRO_COMPASS.HELP_KESSLER', defKey: 'ASTRO_COMPASS.HELP_KESSLER_DEF', aliases: 'kessler debris collision cascade orbite' },
  { id: 'groundtrack', termKey: 'ASTRO_COMPASS.HELP_GROUNDTRACK', defKey: 'ASTRO_COMPASS.HELP_GROUNDTRACK_DEF', aliases: 'trace sol ground track nadir iss' },
  { id: 'hohmann', termKey: 'ASTRO_COMPASS.HELP_HOHMANN', defKey: 'ASTRO_COMPASS.HELP_HOHMANN_DEF', aliases: 'transfert hohmann delta-v orbite' },
  { id: 'photosphere', termKey: 'ASTRO_COMPASS.HELP_PHOTOSPHERE', defKey: 'ASTRO_COMPASS.HELP_PHOTOSPHERE_DEF', aliases: 'photosphere chromosphere couronne soleil' },
  { id: 'solarwind', termKey: 'ASTRO_COMPASS.HELP_SOLARWIND', defKey: 'ASTRO_COMPASS.HELP_SOLARWIND_DEF', aliases: 'vent solaire heliosphere plasma' },
  { id: 'cme', termKey: 'ASTRO_COMPASS.HELP_CME', defKey: 'ASTRO_COMPASS.HELP_CME_DEF', aliases: 'cme ejection masse coronale orage aurore' },
  { id: 'magnetosphere', termKey: 'ASTRO_COMPASS.HELP_MAGNETOSPHERE', defKey: 'ASTRO_COMPASS.HELP_MAGNETOSPHERE_DEF', aliases: 'magnetosphere van allen ceintures' },
  { id: 'trojan', termKey: 'ASTRO_COMPASS.HELP_TROJAN', defKey: 'ASTRO_COMPASS.HELP_TROJAN_DEF', aliases: 'troyens jupiter l4 l5 asteroide' },
  { id: 'neo', termKey: 'ASTRO_COMPASS.HELP_NEO', defKey: 'ASTRO_COMPASS.HELP_NEO_DEF', aliases: 'neo pha asteroide geocroiseur' },
  { id: 'lighttime', termKey: 'ASTRO_COMPASS.HELP_LIGHTTIME', defKey: 'ASTRO_COMPASS.HELP_LIGHTTIME_DEF', aliases: 'temps lumiere light time jupiter saturne' },
  { id: 'stdcandle', termKey: 'ASTRO_COMPASS.HELP_STDCANDLE', defKey: 'ASTRO_COMPASS.HELP_STDCANDLE_DEF', aliases: 'chandelle standard cepheide snia distance' },
  { id: 'rotcurve', termKey: 'ASTRO_COMPASS.HELP_ROTCURVE', defKey: 'ASTRO_COMPASS.HELP_ROTCURVE_DEF', aliases: 'courbe rotation galactique matiere noire' },
  { id: 'osculating', termKey: 'ASTRO_COMPASS.HELP_OSCULATING', defKey: 'ASTRO_COMPASS.HELP_OSCULATING_DEF', aliases: 'elements osculateurs tle kepler instantanes' }
];

@Component({
  selector: 'app-astro-compass',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TranslateModule,
    NgbModule,
    TraceViewerModalComponent,
    SlideshowModalComponent
  ],
  templateUrl: './astro-compass.component.html',
  styleUrls: ['./astro-compass.component.css'],
  host: {
    '[class.ac-dossier-slideshow-open]': 'dossierSlideshowOpen',
    '[class.ac-live-open]': 'autoDetectModalOpen'
  }
})
export class AstroCompassComponent implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild(TraceViewerModalComponent) traceViewerModalComponent?: TraceViewerModalComponent;
  @ViewChild('slideshowModalComponent') slideshowModalComponent?: SlideshowModalComponent;
  @ViewChild('camStage') camStage?: ElementRef<HTMLElement>;
  private camEl?: ElementRef<HTMLVideoElement>;
  private camLiveEl?: ElementRef<HTMLVideoElement>;

  @ViewChild('cam')
  set camRef(el: ElementRef<HTMLVideoElement> | undefined) {
    this.camEl = el;
    queueMicrotask(() => {
      void this.attachCameraStream();
    });
  }

  @ViewChild('camLive')
  set camLiveRef(el: ElementRef<HTMLVideoElement> | undefined) {
    this.camLiveEl = el;
    queueMicrotask(() => {
      void this.attachCameraStream();
    });
  }

  @ViewChild('liveModal')
  set liveModalRef(el: ElementRef<HTMLElement> | undefined) {
    this.unbindLiveModalZoomGestures();
    this.liveModalEl = el;
    if (el) {
      queueMicrotask(() => this.bindLiveModalZoomGestures());
    }
  }

  @ViewChild('tickerHalf')
  set tickerHalfRef(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement;
    if (el === this.tickerHalfEl) {
      return;
    }
    this.tickerHalfEl = el;
    queueMicrotask(() => {
      if (this.tickerHalfEl === el) {
        this.attachTickerSpeedObserver();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Catalogue & sélection de cible                                      */
  /* ------------------------------------------------------------------ */

  readonly planets = ASTRO_PLANETS;
  readonly brightStars = ASTRO_BRIGHT_STARS;
  readonly galaxies = ASTRO_GALAXIES;
  readonly constellations = ASTRO_CONSTELLATIONS;
  readonly satellites = ASTRO_SATELLITES;
  readonly issOption = ASTRO_ISS;

  selectedKind: AstroTargetKind = 'planet';
  selectedPlanetId = 'mars';
  selectedStarId: string | undefined;
  selectedGalaxyId: string | undefined;
  selectedConstellationId: string | undefined;
  /** Satellite courant (mode {@code selectedKind === 'iss'}). */
  selectedSatelliteId = 'iss';
  starQuery = '';
  starResults: AstroStarOption[] = findStarsByQuery('');
  galaxyQuery = '';
  galaxyResults: AstroGalaxyOption[] = findGalaxiesByQuery('');
  constellationQuery = '';
  constellationResults: AstroConstellationOption[] = findConstellationsByQuery('');
  /** Accordéon exclusif du choix de cible (une section ouverte à la fois). */
  targetAccordionOpen: TargetAccordionId | null = 'planet';
  /** Aide bilingue FR/EN ouverte depuis le « i » d’un type de cible. */
  typeHelpOpen: TargetAccordionId | null = null;

  /** Si true : n'affiche que satellites / planètes actuellement au-dessus de l'horizon. */
  visibleOnly = true;
  /** Bandeau défilant des infos de l’objet (comme le globe). Activé par défaut. */
  tickerEnabled = true;
  readonly tickerMarqueeRepeats = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  tickerDurationSec = 45;
  tickerNowLabel = '';
  visibleRefreshing = false;
  issVisibleNow = false;
  /** L'utilisateur a choisi une cible (ne plus forcer ISS / astre visible). */
  private userChoseTarget = false;
  private applyingAutoTarget = false;
  private visiblePlanetIds = new Set<string>();
  private visibleStarIds = new Set<string>();
  private visibleGalaxyIds = new Set<string>();
  private visibleConstellationIds = new Set<string>();
  private visibleSatelliteIds = new Set<string>();
  /** Azimut / élévation live de chaque objet du catalogue (listes de sélection). */
  private catalogSkyDirs: Record<CatalogSkyKind, Map<string, CatalogSkyDir>> = {
    planet: new Map(),
    star: new Map(),
    galaxy: new Map(),
    constellation: new Map(),
    iss: new Map()
  };

  customRaHours = 0;
  customDecDeg = 0;
  customName = '';

  bodyIconClass = 'fa fa-circle';
  bodyColor = '#c1440e';
  bodyLabel = '';

  /** Auto-détection : objets dans la direction du téléphone. */
  autoDetectBusy = false;
  /** Mode live : recalcule en continu l'objet pointé. */
  autoDetectLive = false;
  /** Modale immersive de suivi live. */
  autoDetectModalOpen = false;
  /** Pause : fige l'objet détecté même si le téléphone change de direction. */
  autoDetectPaused = false;
  /** Panneau rafraîchissement (masqué par défaut pour laisser le viseur). */
  autoDetectSettingsOpen = false;
  objectDossierBusy = false;
  objectDossier: ObjectDossier | null = null;
  /** Cached iframe src — must not be rebuilt on each CD cycle or the Sky Window reloads forever. */
  skyMapViewerSrc: SafeResourceUrl | null = null;
  private objectDossierSub: Subscription | null = null;
  private objectDossierKey: string | null = null;
  autoDetectIncludePlanets = true;
  autoDetectIncludeStars = true;
  autoDetectIncludeConstellations = true;
  autoDetectIncludeGalaxies = true;
  autoDetectIncludeIss = true;
  /** Étoiles, galaxies et constellations assez brillantes pour l’œil nu (mag ≤ 6). */
  autoDetectNakedEye = true;
  /** Limite de magnitude à l’œil nu la nuit (plus le nombre est petit, plus c’est brillant). */
  static readonly NAKED_EYE_MAGNITUDE = 6;
  readonly nakedEyeMagnitude = AstroCompassComponent.NAKED_EYE_MAGNITUDE;
  /** Ne garder que les astres de magnitude ≤ cette valeur (plus le nombre est petit, plus c’est brillant). */
  static readonly DEFAULT_MAX_MAGNITUDE = 6;
  maxMagnitude = AstroCompassComponent.DEFAULT_MAX_MAGNITUDE;
  readonly maxMagnitudeMin = 0;
  readonly maxMagnitudeMax = 8;
  readonly maxMagnitudeStep = 1;
  /** Intervalle de rafraîchissement live (200–3000 ms, pas 200). */
  autoDetectIntervalMs = 400;
  readonly autoDetectIntervalMinMs = 200;
  readonly autoDetectIntervalMaxMs = 3000;
  readonly autoDetectIntervalStepMs = 200;
  autoDetectErrorKey: string | null = null;
  autoDetectHits: AutoDetectHit[] = [];
  autoDetectLookAz: number | null = null;
  autoDetectLookEl: number | null = null;
  autoDetectAtMs: number | null = null;
  private autoDetectTimer: ReturnType<typeof setInterval> | null = null;
  private autoDetectCache: Array<Omit<AutoDetectHit, 'separationDeg'>> = [];
  private autoDetectCacheAtMs = 0;
  private autoDetectLastAppliedKey: string | null = null;

  /** Live ISS extras (only when selectedKind === 'iss'). */
  issStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  issLat: number | null = null;
  issLon: number | null = null;
  issAltKm: number | null = null;
  issVelocityKmh: number | null = null;
  issGroundKm: number | null = null;
  issSlantKm: number | null = null;
  private issPasses: IssPassItem[] = [];
  private issPassesLat: number | null = null;
  private issPassesLon: number | null = null;
  private issPassesLoadedAtMs = 0;
  private issLastNetworkRefreshMs = 0;
  private issPassSub: Subscription | null = null;

  /* ------------------------------------------------------------------ */
  /* Observateur (position)                                              */
  /* ------------------------------------------------------------------ */

  lat = 48.8566;
  lon = 2.3522;
  height = 0;
  placeLabel = '';
  userAccuracyM: number | null = null;
  userSource: 'gps' | 'manual' | 'ip' | 'address' | 'map' | null = null;
  geoStatus: 'locating' | 'ready' | 'no-geo' = 'locating';
  locationRefreshing = false;

  addressQuery = '';
  addressResults: AddressSearchResult[] = [];
  loadingAddressSearch = false;
  addressSearchError = '';
  private addressSearchSub: Subscription | null = null;
  private reverseGeocodeSub: Subscription | null = null;
  private altitudeSub: Subscription | null = null;
  private lastAddressResolveAtMs = 0;
  private lastAddressResolveLat: number | null = null;
  private lastAddressResolveLon: number | null = null;
  private lastAltitudeResolveAtMs = 0;
  private lastAltitudeResolveLat: number | null = null;
  private lastAltitudeResolveLon: number | null = null;
  /** Évite d'écraser une altitude saisie manuellement par le DEM. */
  private heightUserLocked = false;

  /* Visibilité (lever / coucher / culmination) */
  currentlyVisible = false;
  alwaysAbove = false;
  alwaysBelow = false;
  nextRiseAt: Date | null = null;
  nextSetAt: Date | null = null;
  culminationAt: Date | null = null;
  culminationAltDeg: number | null = null;
  visibilityDays: VisibilityDay[] = [];
  visibilityHint = '';

  /* ------------------------------------------------------------------ */
  /* Instantané ciel (recomputé ~1 Hz)                                   */
  /* ------------------------------------------------------------------ */

  azimuthDeg: number | null = null;
  elevationDeg: number | null = null;
  raHours: number | null = null;
  decDeg: number | null = null;
  mag: number | null = null;
  phaseFraction: number | null = null;
  phaseAngleDeg: number | null = null;
  geoDistAu: number | null = null;
  helioDistAu: number | null = null;
  geoDistKm: number | null = null;
  /** Distance catalogue (étoiles / galaxies), depuis la Terre ≈ depuis l'observateur. */
  distLy: number | null = null;
  constellationName: string | null = null;
  elongationDeg: number | null = null;
  riseAt: Date | null = null;
  setAt: Date | null = null;
  updatedAtMs: number | null = null;

  /* ------------------------------------------------------------------ */
  /* Capteurs & boussole (port ISS compass, préfixe ac / noms génériques) */
  /* ------------------------------------------------------------------ */

  headingDeg: number | null = null;
  headingAccuracyDeg: number | null = null;
  headingActive = false;
  headingRawDeg: number | null = null;
  headingRef: 'north' | 'cible' = 'north';
  activeCible: DirectionCible | null = null;
  cibleSaving = false;
  cibleError: string | null = null;
  markAddressBusy = false;
  cibleUserAddress: string | null = null;
  cibleUserAddressBusy = false;
  private tracePickMode: 'observer' | 'mark' = 'observer';
  private markAddressSub: Subscription | null = null;
  private userAddressSub: Subscription | null = null;
  private lastCibleUserAddrKey = '';
  northOffsetDeg: number | null = null;
  /**
   * Inclinaison du téléphone (angle du haut de l'appareil depuis l'horizontale).
   * 0° = à plat (écran vers le ciel), 90° = vertical (haut vers le ciel),
   * négatif = haut du téléphone vers le bas.
   * L'élévation de visée ciel (à travers l'écran) = 90° − devicePitchDeg.
   */
  devicePitchDeg: number | null = null;

  calStatus: 'uncalibrated' | 'calibrating' | 'calibrated' = 'uncalibrated';
  calMethod: 'sensor' | 'manual' | 'gps' | 'sun' | 'mouse' | null = null;
  calPersisted = false;
  calSaving = false;
  calSamples = 0;
  readonly calNeededSamples = 8;
  /** Modale des méthodes de recalage du Nord. */
  calModalOpen = false;
  /** Calage souris en cours (clic / glisser sur le cadran). */
  mouseCalDragging = false;
  /** Offset souris prévisualisé, pas encore validé par le bouton. */
  private mouseNorthDraft = false;
  /** Angle visé sur le cadran (0 = haut) pendant le calage souris/tactile. */
  private mouseAimDeg: number | null = null;
  /** Snapshot du calage avant ouverture « Recaler », restauré si annulation. */
  private calBackup: {
    offset: number;
    method: 'sensor' | 'manual' | 'gps' | 'sun' | 'mouse' | null;
    persisted: boolean;
  } | null = null;
  /**
   * Cap virtuel maintenu après un calage souris sans capteurs :
   * les lectures capteur ne doivent pas l'écraser tant que ce mode est actif.
   */
  private mouseVirtualActive = false;

  walkSpeedMps: number | null = null;

  headingSource: 'absolute-sensor' | 'webkit' | 'deviceorientation' | 'magnetometer' | null = null;
  /** Algorithme de cap Nord (interrupteurs d’essai). */
  northHeadingMode: NorthHeadingMode = 'os-yaw';
  northHeadingModePersisted = false;
  readonly northHeadingModeOptions: ReadonlyArray<{
    id: NorthHeadingMode;
    titleKey: string;
    hintKey: string;
  }> = [
    { id: 'os-yaw', titleKey: 'ASTRO_COMPASS.NORTH_MODE_OS_YAW', hintKey: 'ASTRO_COMPASS.NORTH_MODE_OS_YAW_HINT' },
    { id: 'os-mag', titleKey: 'ASTRO_COMPASS.NORTH_MODE_OS_MAG', hintKey: 'ASTRO_COMPASS.NORTH_MODE_OS_MAG_HINT' },
    { id: 'w3c', titleKey: 'ASTRO_COMPASS.NORTH_MODE_W3C', hintKey: 'ASTRO_COMPASS.NORTH_MODE_W3C_HINT' },
    { id: 'tilt-mix', titleKey: 'ASTRO_COMPASS.NORTH_MODE_TILT_MIX', hintKey: 'ASTRO_COMPASS.NORTH_MODE_TILT_MIX_HINT' },
    { id: 'tilt-top', titleKey: 'ASTRO_COMPASS.NORTH_MODE_TILT_TOP', hintKey: 'ASTRO_COMPASS.NORTH_MODE_TILT_TOP_HINT' },
    { id: 'mag', titleKey: 'ASTRO_COMPASS.NORTH_MODE_MAG', hintKey: 'ASTRO_COMPASS.NORTH_MODE_MAG_HINT' },
    { id: 'mag-gyro', titleKey: 'ASTRO_COMPASS.NORTH_MODE_MAG_GYRO', hintKey: 'ASTRO_COMPASS.NORTH_MODE_MAG_GYRO_HINT' }
  ];
  /** Calage figure-8 / hard-iron / fusion gyro (partagé avec la page Nord). */
  readonly northEngine = new CompassNorthEngine();
  /** Copie UI des octants (primitive → détection de changement fiable). */
  octantMask = 0;
  /** Retour d’alignement : silence, bip ou vibration. */
  alignCue: 'off' | 'beep' | 'vibrate' = 'off';
  lookTracker!: CameraLookTracker;
  camLive = false;
  camDenied = false;
  isFullscreen = false;
  isAutoDetectFullscreen = false;
  finderProj: ScreenProjection | null = null;
  finderGuide: FinderTurnGuide | null = null;
  /** Switch viseur : overlay de la trajectoire future de l’objet. */
  finderTrailEnabled = false;
  finderTrailPolylines: string[] = [];
  finderTrailTicks: FinderTrailTick[] = [];
  /** Durée de la trajectoire (min) : satellites vs astres. */
  finderTrailSatMinutes = FINDER_TRAIL_SAT_DEFAULT_MIN;
  finderTrailSkyMinutes = FINDER_TRAIL_SKY_DEFAULT_MIN;
  /** Figure de la constellation sélectionnée (étoiles + traits) dans le viseur. */
  finderConstellationStars: FinderConstellationStar[] = [];
  finderConstellationPolylines: string[] = [];
  finderConstellationJoints: ConstellationSchemaDot[] = [];
  /** Schéma compact de la fiche : astérisme reconnu, sinon figure IAU. */
  constellationSchemaPolylines: string[] = [];
  constellationSchemaDots: ConstellationSchemaDot[] = [];
  private constellationMemberSky: ConstellationMemberSky[] = [];
  private constellationFigureSky: ConstellationFigureSkyPt[][] = [];
  private constellationSchemaBlobUrl: string | null = null;
  northMarked = false;
  southMarked = false;
  sightingMarked = false;
  /** Pause viseur : fige l’objet à l’écran même si le téléphone bouge. */
  finderPoseFrozen = false;
  /** Dernière image caméra (data URL) tant que le viseur ou l’auto-détection est en pause. */
  camFreezeUrl: string | null = null;
  /** Zoom optique réellement appliqué au moment du snapshot. */
  private finderFreezeHwZoom = 1;
  /** Cap / élévation caméra au moment de la pause (le zoom reste actif). */
  private finderPoseCamAz: number | null = null;
  private finderPoseCamEl: number | null = null;
  /** Zoom viseur (1×–8×) : optique si le téléphone le permet, sinon numérique. */
  readonly finderZoomMin = FINDER_ZOOM_MIN;
  readonly finderZoomMax = FINDER_ZOOM_MAX;
  readonly finderZoomStep = FINDER_ZOOM_STEP;
  finderZoom = FINDER_ZOOM_MIN;
  finderDigitalZoom = 1;
  finderVideoTransform = 'scale(1)';
  /** Noms / icônes du viseur : grandissent avec le zoom. */
  finderLabelScale = 1;
  finderPanning = false;
  /** Décalage de visée (°) en pause, pour glisser la vue. */
  private finderPanAz = 0;
  private finderPanEl = 0;
  private finderPanPointerId: number | null = null;
  private finderPanLastX = 0;
  private finderPanLastY = 0;
  private finderPanMoved = false;
  /** Hauteur caméra (px) si l’utilisateur a redimensionné le viseur. */
  camHeightPx: number | null = null;
  private camResizing = false;
  private camResizePointerId: number | null = null;
  private camResizeStartY = 0;
  private camResizeStartH = 0;
  /** True si la pause viseur a elle-même mis l’auto-détection en pause. */
  private finderPosePausedAuto = false;
  helpModalOpen = false;
  objectInfoModalOpen = false;
  finderInfoModalOpen = false;
  /** Clé i18n de l’aide ouverte au tap (mode tactile / mobile). */
  openFactHelpKey: string | null = null;
  dossierSlideshowOpen = false;
  helpFilter = '';
  helpLetterFilter = '';
  readonly helpTerms = ASTRO_HELP_TERMS;
  readonly finderInfoSections: ReadonlyArray<{
    titleKey: string;
    tips: ReadonlyArray<{ icon: string; titleKey: string; hintKey: string }>;
  }> = [
    {
      titleKey: 'ASTRO_COMPASS.FINDER_INFO_SEC_START',
      tips: [
        { icon: 'fa fa-mobile', titleKey: 'ASTRO_COMPASS.FINDER_INFO_START', hintKey: 'ASTRO_COMPASS.FINDER_INFO_START_HINT' },
        { icon: 'fa fa-star', titleKey: 'ASTRO_COMPASS.FINDER_INFO_TARGET', hintKey: 'ASTRO_COMPASS.FINDER_INFO_TARGET_HINT' }
      ]
    },
    {
      titleKey: 'ASTRO_COMPASS.FINDER_INFO_SEC_AIM',
      tips: [
        { icon: 'fa fa-video-camera', titleKey: 'ASTRO_COMPASS.FINDER_INFO_AIM', hintKey: 'ASTRO_COMPASS.FINDER_INFO_AIM_HINT' },
        { icon: 'fa fa-arrows', titleKey: 'ASTRO_COMPASS.FINDER_INFO_GUIDE', hintKey: 'ASTRO_COMPASS.FINDER_INFO_GUIDE_HINT' },
        { icon: 'fa fa-bullseye', titleKey: 'ASTRO_COMPASS.FINDER_INFO_LOCK', hintKey: 'ASTRO_COMPASS.FINDER_INFO_LOCK_HINT' },
        { icon: 'fa fa-volume-up', titleKey: 'ASTRO_COMPASS.FINDER_INFO_CUE', hintKey: 'ASTRO_COMPASS.FINDER_INFO_CUE_HINT' }
      ]
    },
    {
      titleKey: 'ASTRO_COMPASS.FINDER_INFO_SEC_ALIGN',
      tips: [
        { icon: 'fa fa-location-arrow', titleKey: 'ASTRO_COMPASS.FINDER_INFO_NORTH', hintKey: 'ASTRO_COMPASS.FINDER_INFO_NORTH_HINT' },
        { icon: 'fa fa-crosshairs', titleKey: 'ASTRO_COMPASS.FINDER_INFO_SIGHT', hintKey: 'ASTRO_COMPASS.FINDER_INFO_SIGHT_HINT' },
        { icon: 'fa fa-compass', titleKey: 'ASTRO_COMPASS.FINDER_INFO_CAL', hintKey: 'ASTRO_COMPASS.FINDER_INFO_CAL_HINT' }
      ]
    },
    {
      titleKey: 'ASTRO_COMPASS.FINDER_INFO_SEC_TOOLS',
      tips: [
        { icon: 'fa fa-pause', titleKey: 'ASTRO_COMPASS.FINDER_INFO_PAUSE', hintKey: 'ASTRO_COMPASS.FINDER_INFO_PAUSE_HINT' },
        { icon: 'fa fa-long-arrow-right', titleKey: 'ASTRO_COMPASS.FINDER_INFO_TRAIL', hintKey: 'ASTRO_COMPASS.FINDER_INFO_TRAIL_HINT' },
        { icon: 'fa fa-search-plus', titleKey: 'ASTRO_COMPASS.FINDER_INFO_ZOOM', hintKey: 'ASTRO_COMPASS.FINDER_INFO_ZOOM_HINT' },
        { icon: 'fa fa-expand', titleKey: 'ASTRO_COMPASS.FINDER_INFO_FS', hintKey: 'ASTRO_COMPASS.FINDER_INFO_FS_HINT' },
        { icon: 'fa fa-crosshairs', titleKey: 'ASTRO_COMPASS.FINDER_INFO_AUTO', hintKey: 'ASTRO_COMPASS.FINDER_INFO_AUTO_HINT' },
        { icon: 'fa fa-book', titleKey: 'ASTRO_COMPASS.FINDER_INFO_FICHE', hintKey: 'ASTRO_COMPASS.FINDER_INFO_FICHE_HINT' }
      ]
    }
  ];
  private northMarkTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTitleTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTitleTries = 0;
  private sightingMarkTimer: ReturnType<typeof setTimeout> | null = null;
  private camStream: MediaStream | null = null;
  sensorAlpha: number | null = null;
  sensorBeta: number | null = null;
  sensorGamma: number | null = null;
  sensorAbsolute: boolean | null = null;
  sensorWebkitHeading: number | null = null;
  sensorWebkitAccuracy: number | null = null;

  /** Horloge mise en cache pour fraîcheur / Soleil (évite NG0100). */
  nowMs = Date.now();

  readonly bezelDegrees: ReadonlyArray<number> = [
    30, 60, 120, 150, 210, 240, 300, 330
  ];

  private static readonly COMPASS_POINTS: ReadonlyArray<ReadonlyArray<'N' | 'E' | 'S' | 'W'>> = [
    ['N'], ['N', 'N', 'E'], ['N', 'E'], ['E', 'N', 'E'],
    ['E'], ['E', 'S', 'E'], ['S', 'E'], ['S', 'S', 'E'],
    ['S'], ['S', 'S', 'W'], ['S', 'W'], ['W', 'S', 'W'],
    ['W'], ['W', 'N', 'W'], ['N', 'W'], ['N', 'N', 'W']
  ];

  private readonly calMinSpeedMps = 0.6;
  private calAccum: number[] = [];
  private headingInstantDeg: number | null = null;
  private devicePitchInstantDeg: number | null = null;
  private gpsPrev: { lat: number; lon: number; tMs: number } | null = null;

  private geoWatchId: number | null = null;
  private orientationListening = false;
  private orientationEventName: 'deviceorientationabsolute' | 'deviceorientation' | null = null;
  private absSensor: {
    start(): void;
    stop(): void;
    quaternion: ReadonlyArray<number>;
    addEventListener(type: string, listener: (ev: Event) => void): void;
    removeEventListener(type: string, listener: (ev: Event) => void): void;
  } | null = null;
  private absSensorScreenFrame = false;
  private northSensorsStarted = false;
  private motionListening = false;
  private accelFromGeneric = false;
  private gyroFromGeneric = false;
  private liveNorthSensors: GenericSensorLike[] = [];
  private needleUnwrappedDeg = 0;
  private needleInited = false;
  private headingLastPaintMs = 0;
  private calPaintLastMs = 0;
  private pitchLastPaintMs = 0;
  /** Spike en attente de confirmation (anti-sauts Samsung). */
  private headingOutlierPendingDeg: number | null = null;
  /** Buffer pour médiane circulaire du cap. */
  private headingSampleBuf: number[] = [];
  private lastOrientationEvent: DeviceOrientationEvent | null = null;
  private lastMagHeadingInstant: number | null = null;
  private northHeadingModeLoadGen = 0;
  private calLoadPending = false;
  private alignCuePrevYaw = false;
  private alignCuePrevPitch = false;
  private alignCuePrevBoth = false;
  private alignAudioCtx: AudioContext | null = null;
  private static readonly ALIGN_CUE_KEY = 'pat.astro-compass.align-cue';
  private static readonly FINDER_TRAIL_KEY = 'pat.astro-compass.finder-trail';
  private static readonly FINDER_TRAIL_MINUTES_KEY = 'pat.astro-compass.finder-trail-minutes';
  private static readonly FINDER_ZOOM_KEY = 'pat.astro-compass.finder-zoom';
  private static readonly CAM_HEIGHT_KEY = 'pat.astro-compass.cam-height-px';
  private static readonly VISIBLE_ONLY_KEY = 'pat.astro-compass.visible-only';
  private static readonly TICKER_KEY = 'pat.astro-compass.ticker';
  private static readonly MAX_MAGNITUDE_KEY = 'pat.astro-compass.max-magnitude';
  private static readonly TICKER_SPEED_PX_PER_SEC = 80;
  private camZoomCaps: { min: number; max: number } | null = null;
  private finderPinchStartDist = 0;
  private finderPinchStartZoom = FINDER_ZOOM_MIN;
  private finderZoomGesturesBound = false;
  private liveModalEl?: ElementRef<HTMLElement>;
  private liveModalZoomGesturesBound = false;
  private finderStageResizeObs: ResizeObserver | null = null;
  private finderViewportSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onFinderWheelNative = (ev: WheelEvent) => this.onFinderWheel(ev);
  private readonly onFinderTouchStartNative = (ev: TouchEvent) => this.onFinderTouchStart(ev);
  private readonly onFinderTouchMoveNative = (ev: TouchEvent) => this.onFinderTouchMove(ev);
  private readonly onFinderTouchEndNative = (ev: TouchEvent) => this.onFinderTouchEnd(ev);
  private readonly onFinderPointerDownNative = (ev: PointerEvent) => this.onFinderPointerDown(ev);
  private readonly onFinderPointerMoveNative = (ev: PointerEvent) => this.onFinderPointerMove(ev);
  private readonly onFinderPointerUpNative = (ev: PointerEvent) => this.onFinderPointerUp(ev);
  private readonly onLiveModalWheelNative = (ev: WheelEvent) => this.onLiveModalWheel(ev);
  private readonly onLiveModalTouchStartNative = (ev: TouchEvent) => this.onFinderTouchStart(ev);
  private readonly onLiveModalTouchMoveNative = (ev: TouchEvent) => this.onFinderTouchMove(ev);
  private readonly onLiveModalTouchEndNative = (ev: TouchEvent) => this.onFinderTouchEnd(ev);
  private static readonly LAST_TARGET_KEY = 'pat.astro-compass.last-target.v1';
  private static readonly GLOBE_ASTRO_RETURN_SAT_KEY = 'pat.world-globe.astro-return-sat';
  private finderTrailSky: FinderTrailSkyPt[] = [];
  private finderTrailSkyAtMs = 0;
  private finderTrailSkyKey = '';
  /** false pendant un apply auto (défaut visible / live) pour ne pas écraser le choix user. */
  private persistUserTarget = true;
  private lastTargetLoadGen = 0;
  private lastTargetSaveSub: Subscription | null = null;
  private lastPersistedTargetJson: string | null = null;
  private finderTrailLoadGen = 0;
  private finderTrailSaveSub: Subscription | null = null;
  private maxMagnitudeLoadGen = 0;
  private maxMagnitudeSaveSub: Subscription | null = null;
  private alignCueLoadGen = 0;
  private alignCueSaveSub: Subscription | null = null;
  private tickerLoadGen = 0;
  private tickerSaveSub: Subscription | null = null;
  private tickerHalfEl?: HTMLElement;
  private tickerResizeObs?: ResizeObserver;
  private tickerDurationRaf: number | null = null;
  private pendingTickerHalfWidthPx = 0;
  private tickerNowFormatter?: Intl.DateTimeFormat;
  private tickerNowFormatterLang = '';
  private langChangeSub: Subscription | null = null;

  private skyTickTimer: ReturnType<typeof setInterval> | null = null;
  private ipFallbackAttempted = false;

  constructor(
    private readonly api: ApiService,
    private readonly issNow: GlobeIssNowService,
    private readonly satNow: GlobeSatelliteNowService,
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    private readonly hostEl: ElementRef<HTMLElement>,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly keycloak: KeycloakService,
    private readonly sanitizer: DomSanitizer
  ) {
    this.lookTracker = new CameraLookTracker(this.zone, () => this.onLookUpdate());
  }

  ngOnInit(): void {
    this.onStarQueryChange();
    this.onGalaxyQueryChange();
    this.onConstellationQueryChange();
    this.langChangeSub = this.translate.onLangChange.subscribe(() => {
      this.onStarQueryChange();
      this.onGalaxyQueryChange();
      this.onConstellationQueryChange();
      this.relabelCatalogSkyDirs();
      this.tickerNowFormatter = undefined;
      this.tickerNowFormatterLang = '';
      this.refreshTickerNowLabel();
      this.objectDossierKey = null;
      if (this.objectInfoModalOpen || this.objectDossier || this.objectDossierBusy) {
        this.loadObjectDossier();
      }
      this.cdr.markForCheck();
    });
    this.loadAlignCuePref();
    this.loadFinderTrailPref();
    this.loadFinderZoomPref();
    this.loadCamHeightPref();
    this.loadVisibleOnlyPref();
    this.loadTickerPref();
    this.loadMaxMagnitudePref();
    if (!this.hasSatelliteQueryTarget()) {
      this.restoreLastTarget();
    }
    this.hydrateLastTargetFromDb();
    this.applyQueryTarget();
    this.startGeolocation();
    this.hydratePattoolCalFromDb();
    this.loadHeadingRef();
    this.loadActiveCible();
    void this.lookTracker.start(false).then(() => {
      if (this.lookTracker.sensorsOn) {
        void this.startCamera();
      }
      this.cdr.markForCheck();
    });
    this.startSkyTick();
    this.issNow.startBackgroundPrefetch();
    this.refreshVisibleSkyNow(false);
    void this.issNow.refresh(false).then(() => {
      this.refreshVisibleCatalog();
      this.selectDefaultVisibleTarget();
      this.cdr.markForCheck();
    });
    this.satNow.prefetch(ASTRO_SATELLITES.filter(satelliteUsesNetworkTle).map((s) => s.noradId));
    this.cdr.markForCheck();
  }

  ngAfterViewInit(): void {
    this.bindFinderZoomGestures();
    this.bindFinderStageResize();
    if (this.lookTracker.sensorsOn) {
      void this.startCamera();
    }
    this.queueHidePageTitle();
  }

  private queueHidePageTitle(): void {
    this.hideTitleTries = 0;
    this.zone.runOutsideAngular(() => {
      const run = (): void => {
        this.scrollPastPageTitle();
        this.hideTitleTries += 1;
        if (!this.pageTitleIsOffscreen() && this.hideTitleTries < 16) {
          this.hideTitleTimer = setTimeout(run, this.hideTitleTries < 5 ? 40 : 120);
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(run));
    });
  }

  private pageTitleIsOffscreen(): boolean {
    const title = this.hostEl.nativeElement.querySelector('.pat-title') as HTMLElement | null;
    if (!title) {
      return true;
    }
    return title.getBoundingClientRect().bottom <= this.fixedChromeBottom() + 2;
  }

  private scrollPastPageTitle(): void {
    const title = this.hostEl.nativeElement.querySelector('.pat-title') as HTMLElement | null;
    if (!title) {
      return;
    }
    const chromeBottom = this.fixedChromeBottom();
    const need = Math.ceil(title.getBoundingClientRect().bottom - chromeBottom + 6);
    if (need <= 0) {
      return;
    }
    const se = document.scrollingElement || document.documentElement;
    const next = Math.max(0, (se.scrollTop || window.scrollY || 0) + need);
    se.scrollTop = next;
    document.documentElement.scrollTop = next;
    document.body.scrollTop = next;
    window.scrollTo(0, next);
  }

  private fixedChromeBottom(): number {
    let bottom = 0;
    document.querySelectorAll('.navbar.fixed-top, .news-ticker, .currency-ticker, .stock-ticker').forEach((el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.height > 1) {
        bottom = Math.max(bottom, r.bottom);
      }
    });
    return bottom;
  }

  ngOnDestroy(): void {
    if (this.hideTitleTimer != null) {
      clearTimeout(this.hideTitleTimer);
      this.hideTitleTimer = null;
    }
    if (this.northMarkTimer != null) {
      clearTimeout(this.northMarkTimer);
      this.northMarkTimer = null;
    }
    if (this.sightingMarkTimer != null) {
      clearTimeout(this.sightingMarkTimer);
      this.sightingMarkTimer = null;
    }
    this.stopAutoDetectLive();
    this.stopSensors();
    this.stopSkyTick();
    this.closeAlignAudio();
    this.addressSearchSub?.unsubscribe();
    this.reverseGeocodeSub?.unsubscribe();
    this.markAddressSub?.unsubscribe();
    this.userAddressSub?.unsubscribe();
    this.issPassSub?.unsubscribe();
    this.altitudeSub?.unsubscribe();
    this.objectDossierSub?.unsubscribe();
    this.revokeConstellationSchemaBlobUrl();
    this.langChangeSub?.unsubscribe();
    this.tickerSaveSub?.unsubscribe();
    this.tickerResizeObs?.disconnect();
    this.tickerResizeObs = undefined;
    if (this.tickerDurationRaf != null) {
      cancelAnimationFrame(this.tickerDurationRaf);
      this.tickerDurationRaf = null;
    }
    this.unbindFinderZoomGestures();
    this.unbindLiveModalZoomGestures();
    this.unbindFinderStageResize();
    if (this.finderViewportSyncTimer != null) {
      clearTimeout(this.finderViewportSyncTimer);
      this.finderViewportSyncTimer = null;
    }
    this.endCamResize();
    this.writeGlobeReturnSat();
    this.persistLastTarget();
  }

  get finderNeedTap(): boolean {
    return this.lookTracker.needTap;
  }

  get finderDenied(): boolean {
    return this.lookTracker.denied;
  }

  /** Recharge les poses du compte : pas besoin de refaire les 7 visées sur ce téléphone. */
  private hydratePattoolCalFromDb(): void {
    this.api.getDirectionPattoolSamples().subscribe({
      next: (res) => {
        const snaps = (res.samples ?? []).map((s) => snapshotFromPayload(s));
        const local = loadPattoolCal();
        if (snaps.length >= 4 && !sameCalSampleSet(local?.samples, snaps)) {
          persistPattoolCalFromSamples(
            snaps,
            typeof navigator !== 'undefined' ? navigator.userAgent : '',
            local?.mixMode
          );
        }
      },
      error: () => {
        /* hors-ligne ou non connecté : le calibrage local reste */
      }
    });
  }

  async enableFinder(): Promise<void> {
    await this.lookTracker.start(true);
    if (this.lookTracker.sensorsOn) {
      await this.startCamera();
    }
    this.cdr.markForCheck();
  }

  async startCamera(): Promise<void> {
    this.camDenied = false;
    try {
      this.camStream?.getTracks().forEach((t) => t.stop());
      this.camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      await this.attachCameraStream();
    } catch {
      this.camDenied = true;
      this.camLive = false;
    }
    this.cdr.markForCheck();
  }

  private cameraVideoEls(): HTMLVideoElement[] {
    return [this.camEl?.nativeElement, this.camLiveEl?.nativeElement].filter(
      (video): video is HTMLVideoElement => !!video
    );
  }

  private async attachCameraStream(): Promise<void> {
    const videos = this.cameraVideoEls();
    if (!this.camStream || !videos.length) {
      return;
    }
    try {
      for (const video of videos) {
        if (video.srcObject !== this.camStream) {
          video.srcObject = this.camStream;
        }
      }
      this.camLive = true;
      this.refreshCameraZoomCaps();
      if (this.cameraShouldBeFrozen()) {
        this.syncCameraFreeze();
      } else {
        await this.playAttachedCameraVideos();
        this.syncFinderZoomOutputs();
      }
    } catch {
      this.camLive = false;
    }
    this.cdr.markForCheck();
  }

  private async playAttachedCameraVideos(): Promise<void> {
    if (this.cameraShouldBeFrozen()) {
      return;
    }
    for (const video of this.cameraVideoEls()) {
      try {
        await video.play();
      } catch {
        /* un des deux viseurs peut être hors écran */
      }
    }
  }

  stopCamera(): void {
    this.clearFrozenCameraFrame();
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.camStream = null;
    this.camLive = false;
    for (const video of this.cameraVideoEls()) {
      video.srcObject = null;
    }
  }

  private cameraShouldBeFrozen(): boolean {
    return this.finderPoseFrozen || this.autoDetectPaused;
  }

  private currentHardwareZoom(): number {
    const caps = this.camZoomCaps;
    if (!caps) {
      return 1;
    }
    return Math.min(caps.max, Math.max(caps.min, this.finderZoom));
  }

  private captureFrozenCameraFrame(): void {
    const videos = this.cameraVideoEls()
      .filter((video) => video.videoWidth >= 2 && video.readyState >= 2)
      .sort((a, b) => b.videoWidth - a.videoWidth);
    const video = videos[0];
    if (!video) {
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.drawImage(video, 0, 0);
    try {
      this.camFreezeUrl = canvas.toDataURL('image/jpeg', 0.92);
    } catch {
      this.camFreezeUrl = null;
    }
    this.finderFreezeHwZoom = this.currentHardwareZoom();
  }

  private clearFrozenCameraFrame(): void {
    this.camFreezeUrl = null;
    this.finderFreezeHwZoom = 1;
  }

  private syncCameraFreeze(): void {
    if (this.cameraShouldBeFrozen()) {
      if (!this.camFreezeUrl) {
        this.captureFrozenCameraFrame();
      }
      for (const video of this.cameraVideoEls()) {
        video.pause();
      }
      this.syncFinderZoomOutputs();
      this.syncFinderVideoTransform();
      return;
    }
    this.clearFrozenCameraFrame();
    this.syncFinderZoomOutputs();
    void this.playAttachedCameraVideos();
  }

  markFinderNorth(): void {
    if (!this.lookTracker.markCameraAsNorth()) {
      return;
    }
    this.flashCardinalMark('n');
  }

  markFinderSouth(): void {
    if (!this.lookTracker.markCameraAsSouth()) {
      return;
    }
    this.flashCardinalMark('s');
  }

  private flashCardinalMark(kind: 'n' | 's'): void {
    this.northMarked = kind === 'n';
    this.southMarked = kind === 's';
    this.sightingMarked = false;
    if (this.northMarkTimer != null) {
      clearTimeout(this.northMarkTimer);
    }
    this.northMarkTimer = setTimeout(() => {
      this.northMarked = false;
      this.southMarked = false;
      this.northMarkTimer = null;
      this.cdr.markForCheck();
    }, 2500);
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  markExactPosition(): void {
    if (this.azimuthDeg == null || this.elevationDeg == null) {
      return;
    }
    if (!this.lookTracker.markCameraAsTarget(this.azimuthDeg, this.elevationDeg)) {
      return;
    }
    if (this.finderPoseFrozen) {
      this.clearFinderPose(false);
    }
    this.sightingMarked = true;
    this.northMarked = false;
    this.southMarked = false;
    if (this.sightingMarkTimer != null) {
      clearTimeout(this.sightingMarkTimer);
    }
    this.sightingMarkTimer = setTimeout(() => {
      this.sightingMarked = false;
      this.sightingMarkTimer = null;
      this.cdr.markForCheck();
    }, 2500);
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  canMarkExactPosition(): boolean {
    return (
      this.lookTracker.azimuthDeg != null &&
      this.lookTracker.elevationDeg != null &&
      this.azimuthDeg != null &&
      this.elevationDeg != null
    );
  }

  clearFinderNorth(): void {
    this.lookTracker.clearManualNorth();
    this.northMarked = false;
    this.southMarked = false;
    this.sightingMarked = false;
    if (this.northMarkTimer != null) {
      clearTimeout(this.northMarkTimer);
      this.northMarkTimer = null;
    }
    if (this.sightingMarkTimer != null) {
      clearTimeout(this.sightingMarkTimer);
      this.sightingMarkTimer = null;
    }
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  async toggleFinderFullscreen(): Promise<void> {
    await this.toggleElementFullscreen(this.camStage?.nativeElement, 'finder');
  }

  async toggleAutoDetectFullscreen(): Promise<void> {
    await this.toggleElementFullscreen(this.liveModalEl?.nativeElement, 'autodetect');
  }

  private currentFullscreenElement(): Element | null {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  private async exitAnyFullscreen(): Promise<void> {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
    if (!this.currentFullscreenElement()) {
      return;
    }
    if (document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (doc.webkitExitFullscreen) {
      await Promise.resolve(doc.webkitExitFullscreen());
    }
  }

  private async toggleElementFullscreen(
    el: HTMLElement | undefined,
    which: 'finder' | 'autodetect'
  ): Promise<void> {
    if (!el) {
      return;
    }
    const cssOn = which === 'finder' ? this.isFullscreen : this.isAutoDetectFullscreen;
    try {
      const cur = this.currentFullscreenElement();
      if (cur) {
        await this.exitAnyFullscreen();
      } else if (cssOn) {
        if (which === 'finder') {
          this.isFullscreen = false;
        } else {
          this.isAutoDetectFullscreen = false;
        }
        this.cdr.markForCheck();
        this.scheduleFinderViewportSync();
        return;
      } else {
        const req =
          el.requestFullscreen?.bind(el) ??
          (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el);
        if (req) {
          await req();
        } else {
          /* Pas de plein écran vidéo natif : il enlève l’incrustation et le zoom. */
          if (which === 'finder') {
            this.isFullscreen = true;
          } else {
            this.isAutoDetectFullscreen = true;
          }
          this.cdr.markForCheck();
          this.scheduleFinderViewportSync();
          return;
        }
      }
    } catch {
      if (which === 'finder') {
        this.isFullscreen = !this.isFullscreen;
      } else {
        this.isAutoDetectFullscreen = !this.isAutoDetectFullscreen;
      }
      this.cdr.markForCheck();
      this.scheduleFinderViewportSync();
      return;
    }
    this.syncFullscreenFlag();
  }

  @HostListener('document:visibilitychange')
  onPageVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.refreshVisibleSkyNow(true);
    }
  }

  @HostListener('document:keydown.escape')
  onFinderEscape(): void {
    if (this.openFactHelpKey) {
      this.closeFactHelp();
      return;
    }
    if (this.typeHelpOpen) {
      this.closeTypeHelp();
      return;
    }
    if (this.helpModalOpen) {
      this.closeHelpModal();
      return;
    }
    if (this.objectInfoModalOpen) {
      this.closeObjectInfoModal();
      return;
    }
    if (this.isAutoDetectFullscreen && !this.currentFullscreenElement()) {
      this.isAutoDetectFullscreen = false;
      this.cdr.markForCheck();
      this.scheduleFinderViewportSync();
      return;
    }
    if (this.isFullscreen && !this.currentFullscreenElement()) {
      this.isFullscreen = false;
      this.cdr.markForCheck();
      this.scheduleFinderViewportSync();
    }
  }

  openHelpModal(): void {
    this.helpFilter = '';
    this.helpLetterFilter = '';
    this.helpModalOpen = true;
    this.cdr.markForCheck();
  }

  closeHelpModal(): void {
    this.helpModalOpen = false;
    this.helpFilter = '';
    this.helpLetterFilter = '';
    this.cdr.markForCheck();
  }

  openFinderInfoModal(): void {
    this.finderInfoModalOpen = true;
    this.cdr.markForCheck();
  }

  closeFinderInfoModal(): void {
    this.finderInfoModalOpen = false;
    this.cdr.markForCheck();
  }

  openObjectInfoModal(): void {
    this.objectInfoModalOpen = true;
    this.loadObjectDossier();
    this.cdr.markForCheck();
  }

  closeObjectInfoModal(): void {
    this.objectInfoModalOpen = false;
    this.closeFactHelp();
    if (this.autoDetectLive && !this.autoDetectPaused) {
      this.clearObjectDossier();
    }
    this.cdr.markForCheck();
  }

  objectInfoPasses(): IssPassItem[] {
    return this.issPasses;
  }

  objectInfoShowPasses(): boolean {
    return this.selectedKind === 'iss';
  }

  objectInfoMissingGps(): boolean {
    return this.selectedKind === 'iss' && this.geoStatus === 'no-geo';
  }

  formatObjectInfoPassDuration(pass: IssPassItem): string {
    const sec = Math.max(0, Math.round(pass.durationSec || (pass.setAt.getTime() - pass.riseAt.getTime()) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h} h ${m % 60} min`;
    }
    return s > 0 ? `${m} min ${s} s` : `${m} min`;
  }

  objectInfoPassCulmination(pass: IssPassItem): Date | null {
    if (pass.maxAt) {
      return pass.maxAt;
    }
    const mid = pass.riseAt.getTime() + (pass.durationSec * 1000) / 2;
    return Number.isFinite(mid) ? new Date(mid) : null;
  }

  prefersFactTapHelp(): boolean {
    if (typeof window === 'undefined') {
      return this.isMobileDevice();
    }
    const coarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none)').matches;
    return coarse || window.innerWidth <= 768 || this.isMobileDevice();
  }

  onFactTipActivate(helpKey: string, event?: Event): void {
    if (!this.prefersFactTapHelp()) {
      return;
    }
    event?.preventDefault();
    event?.stopPropagation();
    this.openFactHelpKey = this.openFactHelpKey === helpKey ? null : helpKey;
    this.cdr.markForCheck();
  }

  closeFactHelp(): void {
    if (!this.openFactHelpKey) {
      return;
    }
    this.openFactHelpKey = null;
    this.cdr.markForCheck();
  }

  selectedKindLabelKey(): string {
    if (this.selectedKind === 'constellation') {
      return 'ASTRO_COMPASS.KIND_CONSTELLATION';
    }
    if (this.selectedKind === 'planet' || this.selectedKind === 'star' || this.selectedKind === 'galaxy' || this.selectedKind === 'iss') {
      return this.autoDetectKindLabelKey(this.selectedKind);
    }
    return 'ASTRO_COMPASS.KIND_CUSTOM';
  }

  private maybeReloadObjectDossier(): void {
    if (this.autoDetectLive && !this.autoDetectPaused) {
      return;
    }
    this.loadObjectDossier();
  }

  setHelpLetterFilter(letter: string): void {
    this.helpLetterFilter = this.helpLetterFilter === letter ? '' : letter;
    this.cdr.markForCheck();
  }

  helpLetterOptions(): string[] {
    const letters = new Set<string>();
    for (const t of this.helpTerms) {
      letters.add(this.helpTermInitial(t.termKey));
    }
    const locale = this.translate.currentLang || undefined;
    return [...letters].filter(Boolean).sort((a, b) => a.localeCompare(b, locale, { sensitivity: 'base' }));
  }

  filteredHelpTerms(): HelpTerm[] {
    const q = this.helpFilter.trim().toLowerCase();
    const letter = this.helpLetterFilter;
    const list = this.helpTerms.filter((t) => {
      if (letter && this.helpTermInitial(t.termKey) !== letter) {
        return false;
      }
      if (!q) {
        return true;
      }
      const term = String(this.translate.instant(t.termKey)).toLowerCase();
      const def = String(this.translate.instant(t.defKey)).toLowerCase();
      return term.includes(q) || def.includes(q) || t.aliases.toLowerCase().includes(q);
    });
    const locale = this.translate.currentLang || undefined;
    return list.sort((a, b) => {
      const ta = String(this.translate.instant(a.termKey));
      const tb = String(this.translate.instant(b.termKey));
      return ta.localeCompare(tb, locale, { sensitivity: 'base' });
    });
  }

  private helpTermInitial(termKey: string): string {
    const name = String(this.translate.instant(termKey)).trim();
    const raw = name.charAt(0);
    return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase(this.translate.currentLang || undefined);
  }

  @HostListener('document:fullscreenchange')
  @HostListener('document:webkitfullscreenchange')
  onFinderFullscreenChange(): void {
    this.syncFullscreenFlag();
  }

  private syncFullscreenFlag(): void {
    const cur = this.currentFullscreenElement();
    const live = this.liveModalEl?.nativeElement;
    const stage = this.camStage?.nativeElement;
    if (cur === live) {
      this.isAutoDetectFullscreen = true;
      this.isFullscreen = false;
    } else if (cur === stage) {
      this.isFullscreen = true;
      this.isAutoDetectFullscreen = false;
    } else if (!cur) {
      this.isFullscreen = false;
      this.isAutoDetectFullscreen = false;
    }
    this.scheduleFinderViewportSync();
    this.cdr.markForCheck();
  }

  private onLookUpdate(): void {
    const el = this.lookTracker.elevationDeg;
    this.devicePitchDeg = el != null ? 90 - el : null;
    this.applyHeadingReference();
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  cibleGpsText(): string {
    const c = this.activeCible;
    if (c?.userLat == null || c.userLon == null) {
      return '—';
    }
    const acc = c.userAccM != null && Number.isFinite(c.userAccM) ? ` ±${c.userAccM.toFixed(0)} m` : '';
    return `${c.userLat.toFixed(5)}, ${c.userLon.toFixed(5)}${acc}`;
  }

  cibleUserAddressText(): string {
    if (this.cibleUserAddressBusy) {
      return '…';
    }
    return this.cibleUserAddress?.trim() || '—';
  }

  cibleHasMark(): boolean {
    return hasCibleMark(this.activeCible?.markLat, this.activeCible?.markLon);
  }

  cibleMarkGpsText(): string {
    const c = this.activeCible;
    if (!hasCibleMark(c?.markLat, c?.markLon)) {
      return '—';
    }
    const alt = c?.markAltM != null && Number.isFinite(c.markAltM) ? ` · ${Math.round(c.markAltM)} m` : '';
    return `${c!.markLat!.toFixed(5)}, ${c!.markLon!.toFixed(5)}${alt}`;
  }

  cibleMarkAddressText(): string {
    if (this.markAddressBusy) {
      return '…';
    }
    return this.activeCible?.markAddress?.trim() || '—';
  }

  cibleMarkBearingDeg(): number | null {
    const c = this.activeCible;
    return cibleMarkBearingDeg(this.lat, this.lon, c?.markLat, c?.markLon);
  }

  cibleMarkDistanceM(): number | null {
    const c = this.activeCible;
    return cibleMarkDistanceM(this.lat, this.lon, c?.markLat, c?.markLon);
  }

  cibleMarkBearingText(): string {
    const az = this.cibleMarkBearingDeg();
    const dist = this.cibleMarkDistanceM();
    if (az == null) {
      return '—';
    }
    if (dist == null) {
      return `${az.toFixed(0)}°`;
    }
    const distTxt = dist >= 1000 ? `${(dist / 1000).toFixed(dist >= 10000 ? 0 : 1)} km` : `${dist.toFixed(0)} m`;
    return `${az.toFixed(0)}° · ${distTxt}`;
  }

  cibleMarkTooClose(): boolean {
    const m = this.cibleMarkDistanceM();
    return m != null && m < CIBLE_MARK_MIN_DIST_M;
  }

  formatCibleDeg(v: number | null | undefined, signed = false): string {
    if (v == null || !Number.isFinite(v)) {
      return '—';
    }
    const n = Math.round(v * 10) / 10;
    const sign = signed && n > 0 ? '+' : '';
    return `${sign}${n.toFixed(n % 1 === 0 ? 0 : 1)}°`;
  }

  setHeadingRef(ref: 'north' | 'cible'): void {
    if (ref === 'cible' && !this.activeCible) {
      return;
    }
    if (this.headingRef === ref) {
      return;
    }
    this.headingRef = ref;
    this.saveHeadingRef();
    this.applyHeadingReference();
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  private loadHeadingRef(): void {
    try {
      const raw = localStorage.getItem('pat.astro.heading-ref.v1');
      this.headingRef = raw === 'cible' ? 'cible' : 'north';
    } catch {
      this.headingRef = 'north';
    }
  }

  private saveHeadingRef(): void {
    try {
      localStorage.setItem('pat.astro.heading-ref.v1', this.headingRef);
    } catch {
      /* ignore */
    }
  }

  private loadActiveCible(): void {
    this.api.listDirectionCibles().subscribe({
      next: (res) => {
        const list = res.cibles ?? [];
        const wanted = list.find((c) => c.active) ?? list.find((c) => c.id === loadActiveCibleId()) ?? list[0] ?? null;
        this.activeCible = wanted;
        if (wanted?.id) {
          saveActiveCibleId(wanted.id);
        }
        if (this.headingRef === 'cible' && !this.activeCible) {
          this.headingRef = 'north';
        }
        this.applyHeadingReference();
        this.updateFinderProjection();
        this.fillMissingCibleMarkAddress();
        this.resolveCibleUserAddress();
        this.cdr.markForCheck();
      },
      error: () => {
        if (this.headingRef === 'cible') {
          this.headingRef = 'north';
        }
        this.cdr.markForCheck();
      }
    });
  }

  canFreezeFinderPose(): boolean {
    return this.azimuthDeg != null && this.elevationDeg != null && !!this.bodyLabel;
  }

  toggleFinderPose(): void {
    if (this.finderPoseFrozen) {
      this.clearFinderPose(true);
      return;
    }
    if (!this.canFreezeFinderPose()) {
      return;
    }
    this.snapshotFinderPose();
    this.finderPoseFrozen = true;
    this.syncCameraFreeze();
    this.updateFinderProjection();
    if (this.autoDetectLive && !this.autoDetectPaused) {
      this.autoDetectPaused = true;
      this.finderPosePausedAuto = true;
      this.stopAutoDetectTimerOnly();
      this.loadObjectDossier();
    }
    this.cdr.markForCheck();
  }

  private snapshotFinderPose(): void {
    const liveAz = this.lookTracker.azimuthDeg;
    const liveEl = this.lookTracker.elevationDeg;
    const inView = !!this.finderProj?.inView;
    if (inView && liveAz != null && liveEl != null) {
      this.finderPoseCamAz = liveAz;
      this.finderPoseCamEl = liveEl;
    } else if (this.azimuthDeg != null && this.elevationDeg != null) {
      this.finderPoseCamAz = this.azimuthDeg;
      this.finderPoseCamEl = this.elevationDeg;
    } else {
      this.finderPoseCamAz = liveAz;
      this.finderPoseCamEl = liveEl;
    }
    this.finderGuide = null;
    this.resetFinderPan();
  }

  private clearFinderPose(resumeTracking: boolean): void {
    const resumeAuto = this.finderPosePausedAuto;
    this.finderPoseFrozen = false;
    this.finderPoseCamAz = null;
    this.finderPoseCamEl = null;
    this.resetFinderPan();
    this.finderPosePausedAuto = false;
    if (resumeAuto && this.autoDetectModalOpen) {
      this.autoDetectPaused = false;
      this.autoDetectLive = true;
      this.clearObjectDossier();
      this.runAutoDetectPass(false);
      this.restartAutoDetectTimer();
    }
    this.syncCameraFreeze();
    if (resumeTracking) {
      this.updateFinderProjection();
    }
    this.cdr.markForCheck();
  }

  private updateFinderProjection(): void {
    const poseAz = this.finderPoseCamAz;
    const poseEl = this.finderPoseCamEl;
    const frozen = this.finderPoseFrozen && poseAz != null && poseEl != null;
    let camAz = this.lookTracker.azimuthDeg;
    let camEl = this.lookTracker.elevationDeg;
    if (frozen) {
      camAz = this.normalizeDeg(poseAz + this.finderPanAz);
      camEl = this.clampFinderElevation(poseEl + this.finderPanEl);
    }
    if (camAz == null || camEl == null || this.azimuthDeg == null || this.elevationDeg == null) {
      if (this.finderPoseFrozen && this.finderProj) {
        this.finderGuide = null;
        this.syncFinderVideoTransform();
        return;
      }
      this.finderProj = null;
      this.finderGuide = null;
      this.clearFinderTrailScreen();
      this.clearFinderConstellationSkyOverlay();
      this.syncFinderVideoTransform();
      return;
    }
    const fov = this.finderFovDeg();
    this.finderProj = projectCelestialToScreen(
      camAz,
      camEl,
      0,
      this.azimuthDeg,
      this.elevationDeg,
      fov.hfov,
      fov.vfov,
      FINDER_CENTER_SEP_DEG / this.finderZoom
    );
    this.finderGuide = frozen
      ? null
      : computeFinderTurnGuide(
          camAz,
          camEl,
          this.azimuthDeg,
          this.elevationDeg,
          this.finderProj
        );
    this.projectFinderTrail(camAz, camEl, fov.hfov, fov.vfov, frozen);
    this.projectFinderConstellation(camAz, camEl, fov.hfov, fov.vfov);
    this.syncFinderVideoTransform();
  }

  private clearFinderConstellationSkyOverlay(): void {
    this.finderConstellationStars = [];
    this.finderConstellationPolylines = [];
    this.finderConstellationJoints = [];
  }

  private clearFinderConstellationOverlay(): void {
    this.clearFinderConstellationSkyOverlay();
    this.clearConstellationSchema();
  }

  private clearConstellationSchema(): void {
    this.constellationSchemaPolylines = [];
    this.constellationSchemaDots = [];
  }

  get hasConstellationSchema(): boolean {
    return this.selectedKind === 'constellation' && this.constellationSchemaPolylines.length > 0;
  }

  private projectFinderConstellation(
    camAz: number,
    camEl: number,
    hfov: number,
    vfov: number
  ): void {
    if (this.selectedKind !== 'constellation') {
      this.clearFinderConstellationSkyOverlay();
      return;
    }
    const stars: FinderConstellationStar[] = [];
    for (const member of this.constellationMemberSky) {
      const proj = projectCelestialToScreen(camAz, camEl, 0, member.az, member.el, hfov, vfov);
      if (!proj.inFront || proj.xPct < -5 || proj.xPct > 105 || proj.yPct < -5 || proj.yPct > 105) {
        continue;
      }
      stars.push({
        id: member.id,
        name: member.name,
        xPct: proj.xPct,
        yPct: proj.yPct
      });
    }
    const polylines: string[] = [];
    const joints: ConstellationSchemaDot[] = [];
    for (const stroke of this.constellationFigureSky) {
      const raw: Array<{ x: number; y: number; inFront: boolean }> = [];
      for (const pt of stroke) {
        const proj = projectCelestialToScreen(
          camAz,
          camEl,
          0,
          pt.az,
          pt.el,
          hfov,
          vfov,
          undefined,
          false
        );
        raw.push({ x: proj.xPct, y: proj.yPct, inFront: proj.inFront });
      }
      for (let i = 1; i < raw.length; i++) {
        const a = raw[i - 1];
        const b = raw[i];
        if (!a.inFront || !b.inFront) {
          continue;
        }
        const clipped = clipLineToRect(a.x, a.y, b.x, b.y);
        if (!clipped) {
          continue;
        }
        polylines.push(
          `${clipped.x0.toFixed(2)},${clipped.y0.toFixed(2)} ${clipped.x1.toFixed(2)},${clipped.y1.toFixed(2)}`
        );
      }
      for (const p of raw) {
        if (!p.inFront) {
          continue;
        }
        if (p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100) {
          joints.push({ xPct: p.x, yPct: p.y });
        }
      }
    }
    this.finderConstellationStars = stars;
    this.finderConstellationPolylines = polylines;
    this.finderConstellationJoints = joints;
  }

  private fitXyStrokesToBox(
    strokes: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
    flipY: boolean
  ): { polylines: string[]; dots: ConstellationSchemaDot[] } {
    const pad = 16;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke) {
        const y = flipY ? -p.y : p.y;
        if (p.x < minX) minX = p.x;
        if (y < minY) minY = y;
        if (p.x > maxX) maxX = p.x;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return { polylines: [], dots: [] };
    }
    const spanX = Math.max(0.4, maxX - minX);
    const spanY = Math.max(0.4, maxY - minY);
    const inner = 100 - pad * 2;
    const scale = Math.min(inner / spanX, inner / spanY);
    const ox = 50 - ((minX + maxX) / 2) * scale;
    const oy = 50 - ((minY + maxY) / 2) * scale;
    const map = (x: number, y: number): { x: number; y: number } => ({
      x: ox + x * scale,
      y: oy + (flipY ? -y : y) * scale
    });
    const polylines: string[] = [];
    const dots: ConstellationSchemaDot[] = [];
    const seen = new Set<string>();
    for (const stroke of strokes) {
      if (stroke.length < 2) {
        continue;
      }
      polylines.push(
        stroke
          .map((p) => {
            const m = map(p.x, p.y);
            return `${m.x.toFixed(2)},${m.y.toFixed(2)}`;
          })
          .join(' ')
      );
      for (const p of stroke) {
        const m = map(p.x, p.y);
        const key = `${m.x.toFixed(1)},${m.y.toFixed(1)}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        dots.push({ xPct: m.x, yPct: m.y });
      }
    }
    return { polylines, dots };
  }

  get finderTrailMinutes(): number {
    return this.selectedKind === 'iss' ? this.finderTrailSatMinutes : this.finderTrailSkyMinutes;
  }

  get finderTrailMinutesMin(): number {
    return this.selectedKind === 'iss' ? FINDER_TRAIL_SAT_MIN : FINDER_TRAIL_SKY_MIN;
  }

  get finderTrailMinutesMax(): number {
    return this.selectedKind === 'iss' ? FINDER_TRAIL_SAT_MAX : FINDER_TRAIL_SKY_MAX;
  }

  get finderTrailMinutesStep(): number {
    return this.selectedKind === 'iss' ? FINDER_TRAIL_SAT_STEP : FINDER_TRAIL_SKY_STEP;
  }

  get finderTrailShowMaxAsHours(): boolean {
    return this.finderTrailMinutesMax >= 60 && this.finderTrailMinutesMax % 60 === 0;
  }

  get finderTrailMinutesMaxHours(): number {
    return Math.round(this.finderTrailMinutesMax / 60);
  }

  onFinderTrailChange(): void {
    this.persistFinderTrailPref();
    this.finderTrailSkyAtMs = 0;
    this.finderTrailSkyKey = '';
    if (!this.finderTrailEnabled) {
      this.clearFinderTrailScreen();
      this.finderTrailSky = [];
      this.cdr.markForCheck();
      return;
    }
    this.ensureFinderTrailTle();
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  onFinderTrailMinutesChange(raw: number | string): void {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(n)) {
      return;
    }
    if (this.selectedKind === 'iss') {
      this.finderTrailSatMinutes = this.clampFinderTrailSatMinutes(n);
    } else {
      this.finderTrailSkyMinutes = this.clampFinderTrailSkyMinutes(n);
    }
    this.persistFinderTrailMinutesPref();
    this.finderTrailSkyAtMs = 0;
    this.finderTrailSkyKey = '';
    if (this.finderTrailEnabled) {
      this.updateFinderProjection();
    }
    this.cdr.markForCheck();
  }

  private loadFinderTrailPref(): void {
    this.loadFinderTrailMinutesPref();
    this.finderTrailEnabled = this.readUserLocal(AstroCompassComponent.FINDER_TRAIL_KEY) === '1';
    if (this.finderTrailEnabled) {
      this.ensureFinderTrailTle();
    }
    const gen = ++this.finderTrailLoadGen;
    this.api.getAstroFinderTrail().subscribe({
      next: (dto) => {
        if (gen !== this.finderTrailLoadGen) {
          return;
        }
        let applied = false;
        if (dto && typeof dto.enabled === 'boolean') {
          this.applyFinderTrailEnabled(dto.enabled, false);
          applied = true;
        }
        const hasRemoteSat = typeof dto?.satMinutes === 'number' && Number.isFinite(dto.satMinutes);
        const hasRemoteSky = typeof dto?.skyMinutes === 'number' && Number.isFinite(dto.skyMinutes);
        if (hasRemoteSat || hasRemoteSky) {
          this.applyFinderTrailMinutes(
            hasRemoteSat ? dto!.satMinutes : undefined,
            hasRemoteSky ? dto!.skyMinutes : undefined,
            false
          );
          applied = true;
        }
        const missingRemoteMinutes = !hasRemoteSat || !hasRemoteSky;
        const hasLocalMinutes = this.readUserLocal(AstroCompassComponent.FINDER_TRAIL_MINUTES_KEY);
        if ((applied && missingRemoteMinutes) || (!applied && (this.finderTrailEnabled || hasLocalMinutes))) {
          this.saveFinderTrailRemote();
        }
      },
      error: () => {
        /* anonyme / hors-ligne : le localStorage reste */
      }
    });
  }

  private persistFinderTrailPref(): void {
    this.writeUserLocal(AstroCompassComponent.FINDER_TRAIL_KEY, this.finderTrailEnabled ? '1' : '0');
    this.persistFinderTrailMinutesLocal();
    this.saveFinderTrailRemote();
  }

  private applyFinderTrailEnabled(enabled: boolean, persistRemote: boolean): void {
    const changed = this.finderTrailEnabled !== enabled;
    this.finderTrailEnabled = enabled;
    this.writeUserLocal(AstroCompassComponent.FINDER_TRAIL_KEY, enabled ? '1' : '0');
    if (changed) {
      this.finderTrailSkyAtMs = 0;
      this.finderTrailSkyKey = '';
      if (!enabled) {
        this.clearFinderTrailScreen();
        this.finderTrailSky = [];
      } else {
        this.ensureFinderTrailTle();
        this.updateFinderProjection();
      }
      this.cdr.markForCheck();
    }
    if (persistRemote) {
      this.saveFinderTrailRemote();
    }
  }

  private saveFinderTrailRemote(): void {
    this.finderTrailLoadGen++;
    this.finderTrailSaveSub?.unsubscribe();
    this.finderTrailSaveSub = this.api.setAstroFinderTrail({
      enabled: this.finderTrailEnabled,
      satMinutes: this.finderTrailSatMinutes,
      skyMinutes: this.finderTrailSkyMinutes
    }).subscribe({
      error: () => {
        /* hors connexion / anonyme : le localStorage suffit */
      }
    });
  }

  private clampFinderTrailSatMinutes(raw: number): number {
    return Math.max(
      FINDER_TRAIL_SAT_MIN,
      Math.min(FINDER_TRAIL_SAT_MAX, Math.round(raw / FINDER_TRAIL_SAT_STEP) * FINDER_TRAIL_SAT_STEP)
    );
  }

  private clampFinderTrailSkyMinutes(raw: number): number {
    return Math.max(
      FINDER_TRAIL_SKY_MIN,
      Math.min(FINDER_TRAIL_SKY_MAX, Math.round(raw / FINDER_TRAIL_SKY_STEP) * FINDER_TRAIL_SKY_STEP)
    );
  }

  private loadFinderTrailMinutesPref(): void {
    const raw = this.readUserLocal(AstroCompassComponent.FINDER_TRAIL_MINUTES_KEY);
    if (raw == null || raw === '') {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { sat?: unknown; sky?: unknown };
      if (typeof parsed?.sat === 'number' && Number.isFinite(parsed.sat)) {
        this.finderTrailSatMinutes = this.clampFinderTrailSatMinutes(parsed.sat);
      }
      if (typeof parsed?.sky === 'number' && Number.isFinite(parsed.sky)) {
        this.finderTrailSkyMinutes = this.clampFinderTrailSkyMinutes(parsed.sky);
      }
    } catch {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        this.finderTrailSatMinutes = this.clampFinderTrailSatMinutes(n);
        this.finderTrailSkyMinutes = this.clampFinderTrailSkyMinutes(n);
      }
    }
  }

  private persistFinderTrailMinutesPref(): void {
    this.persistFinderTrailMinutesLocal();
    this.saveFinderTrailRemote();
  }

  private persistFinderTrailMinutesLocal(): void {
    this.writeUserLocal(
      AstroCompassComponent.FINDER_TRAIL_MINUTES_KEY,
      JSON.stringify({ sat: this.finderTrailSatMinutes, sky: this.finderTrailSkyMinutes })
    );
  }

  private applyFinderTrailMinutes(
    sat: number | undefined,
    sky: number | undefined,
    persistRemote: boolean
  ): void {
    let changed = false;
    if (typeof sat === 'number' && Number.isFinite(sat)) {
      const next = this.clampFinderTrailSatMinutes(sat);
      if (next !== this.finderTrailSatMinutes) {
        this.finderTrailSatMinutes = next;
        changed = true;
      }
    }
    if (typeof sky === 'number' && Number.isFinite(sky)) {
      const next = this.clampFinderTrailSkyMinutes(sky);
      if (next !== this.finderTrailSkyMinutes) {
        this.finderTrailSkyMinutes = next;
        changed = true;
      }
    }
    this.persistFinderTrailMinutesLocal();
    if (changed) {
      this.finderTrailSkyAtMs = 0;
      this.finderTrailSkyKey = '';
      if (this.finderTrailEnabled) {
        this.updateFinderProjection();
      }
      this.cdr.markForCheck();
    }
    if (persistRemote) {
      this.saveFinderTrailRemote();
    }
  }

  private finderTrailDurationMs(): number {
    return this.finderTrailMinutes * 60_000;
  }

  private finderTrailStepMs(): number {
    const durationMs = this.finderTrailDurationMs();
    if (this.selectedKind === 'iss') {
      return Math.max(FINDER_TRAIL_SAT_STEP_MS, Math.round(durationMs / 75));
    }
    return Math.max(FINDER_TRAIL_SKY_STEP_MS, Math.round(durationMs / 60));
  }

  private finderTrailTickEveryMin(): number {
    const mins = this.finderTrailMinutes;
    if (this.selectedKind === 'iss') {
      return Math.max(2, Math.round(mins / 5));
    }
    return Math.max(15, Math.round(mins / 6));
  }

  private clampMaxMagnitude(raw: number): number {
    return Math.max(
      this.maxMagnitudeMin,
      Math.min(this.maxMagnitudeMax, Math.round(raw / this.maxMagnitudeStep) * this.maxMagnitudeStep)
    );
  }

  private loadMaxMagnitudePref(): void {
    const stored = this.readUserLocal(AstroCompassComponent.MAX_MAGNITUDE_KEY);
    const local = stored == null || stored === '' ? NaN : Number(stored);
    if (Number.isFinite(local)) {
      this.maxMagnitude = this.clampMaxMagnitude(local);
    } else {
      this.maxMagnitude = AstroCompassComponent.DEFAULT_MAX_MAGNITUDE;
    }
    const gen = ++this.maxMagnitudeLoadGen;
    this.api.getAstroMaxMagnitude().subscribe({
      next: (dto) => {
        if (gen !== this.maxMagnitudeLoadGen) {
          return;
        }
        const remote = dto?.maxMagnitude;
        if (typeof remote === 'number' && Number.isFinite(remote)) {
          this.applyMaxMagnitude(remote, false);
        } else if (Number.isFinite(local)) {
          this.saveMaxMagnitudeRemote(this.maxMagnitude);
        }
      },
      error: () => {
        /* anonyme / hors-ligne : le localStorage ou le défaut 5 restent */
      }
    });
  }

  private persistMaxMagnitudePref(): void {
    this.writeUserLocal(AstroCompassComponent.MAX_MAGNITUDE_KEY, String(this.maxMagnitude));
    this.saveMaxMagnitudeRemote(this.maxMagnitude);
  }

  private applyMaxMagnitude(raw: number, persistRemote: boolean): void {
    const next = this.clampMaxMagnitude(raw);
    const changed = this.maxMagnitude !== next;
    this.maxMagnitude = next;
    this.writeUserLocal(AstroCompassComponent.MAX_MAGNITUDE_KEY, String(next));
    if (changed) {
      this.onStarQueryChange();
      this.onAutoDetectFiltersChange();
      this.cdr.markForCheck();
    }
    if (persistRemote) {
      this.saveMaxMagnitudeRemote(next);
    }
  }

  private saveMaxMagnitudeRemote(maxMagnitude: number): void {
    this.maxMagnitudeLoadGen++;
    this.maxMagnitudeSaveSub?.unsubscribe();
    this.maxMagnitudeSaveSub = this.api.setAstroMaxMagnitude(maxMagnitude).subscribe({
      error: () => {
        /* hors connexion / anonyme : le localStorage suffit */
      }
    });
  }

  get finderZoomLabel(): string {
    const z = this.finderZoom;
    const txt = Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1);
    return `${txt}×`;
  }

  finderZoomIn(): void {
    this.setFinderZoom(this.finderZoom + FINDER_ZOOM_STEP, true);
  }

  finderZoomOut(): void {
    this.setFinderZoom(this.finderZoom - FINDER_ZOOM_STEP, true);
  }

  resetFinderZoom(): void {
    this.resetFinderPan();
    this.setFinderZoom(FINDER_ZOOM_MIN, true);
  }

  onFinderZoomSlider(value: number | string): void {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
      return;
    }
    this.setFinderZoom(n, true);
  }

  onFinderWheel(ev: WheelEvent): void {
    if (this.canPanFinderView() && this.isFinderStageEvent(ev) && !ev.ctrlKey && !ev.metaKey) {
      if (this.isFinderPanIgnoreTarget(ev.target)) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const dy = normalizeWheelDeltaPixels(ev);
      let dx = ev.deltaX;
      if (ev.deltaMode === 1) {
        dx *= 16;
      } else if (ev.deltaMode === 2) {
        dx *= typeof window !== 'undefined' ? window.innerHeight : 800;
      }
      if (ev.shiftKey && Math.abs(dx) < 0.5) {
        this.applyFinderPanPixels(-dy, 0);
      } else {
        this.applyFinderPanPixels(dx, dy);
      }
      return;
    }
    if (this.isFinderPanIgnoreTarget(ev.target)) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const next = applyMultiplicativeWheelScale(
      this.finderZoom,
      normalizeWheelDeltaPixels(ev),
      FINDER_ZOOM_MIN,
      FINDER_ZOOM_MAX
    );
    this.setFinderZoom(next, false);
  }

  private onLiveModalWheel(ev: WheelEvent): void {
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest('input, button, label, a, select, textarea')) {
      return;
    }
    this.onFinderWheel(ev);
  }

  private onFinderTouchStart(ev: TouchEvent): void {
    if (ev.touches.length === 2) {
      this.endFinderPan();
      this.finderPinchStartDist = this.touchDistance(ev.touches[0], ev.touches[1]);
      this.finderPinchStartZoom = this.finderZoom;
      return;
    }
    this.finderPinchStartDist = 0;
    if (ev.touches.length === 1) {
      const t = ev.touches[0];
      this.beginFinderPan(t.clientX, t.clientY, ev.target, ev.currentTarget);
    }
  }

  private onFinderTouchMove(ev: TouchEvent): void {
    if (ev.touches.length === 2 && this.finderPinchStartDist >= 8) {
      ev.preventDefault();
      const dist = this.touchDistance(ev.touches[0], ev.touches[1]);
      this.setFinderZoom((this.finderPinchStartZoom * dist) / this.finderPinchStartDist, false, false);
      return;
    }
    if (ev.touches.length === 1 && this.finderPanning) {
      ev.preventDefault();
      this.moveFinderPan(ev.touches[0].clientX, ev.touches[0].clientY);
    }
  }

  private onFinderTouchEnd(ev?: TouchEvent): void {
    if (this.finderPinchStartDist > 0 && (!ev || ev.touches.length < 2)) {
      this.setFinderZoom(this.finderZoom, true);
      this.finderPinchStartDist = 0;
    }
    if (!ev || ev.touches.length === 0) {
      this.endFinderPan();
    }
  }

  private onFinderPointerDown(ev: PointerEvent): void {
    if (ev.pointerType === 'touch' || ev.button !== 0) {
      return;
    }
    if (!this.beginFinderPan(ev.clientX, ev.clientY, ev.target, ev.currentTarget)) {
      return;
    }
    this.finderPanPointerId = ev.pointerId;
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    ev.preventDefault();
  }

  private onFinderPointerMove(ev: PointerEvent): void {
    if (!this.finderPanning || ev.pointerId !== this.finderPanPointerId) {
      return;
    }
    ev.preventDefault();
    this.moveFinderPan(ev.clientX, ev.clientY);
  }

  private onFinderPointerUp(ev: PointerEvent): void {
    if (this.finderPanPointerId == null || ev.pointerId !== this.finderPanPointerId) {
      return;
    }
    this.endFinderPan();
  }

  private touchDistance(a: Touch, b: Touch): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private canPanFinderView(): boolean {
    return this.finderPoseFrozen && this.finderPoseCamAz != null && this.finderPoseCamEl != null;
  }

  private isFinderStageEvent(ev: Event): boolean {
    const stage = this.camStage?.nativeElement;
    if (!stage) {
      return false;
    }
    if (ev.currentTarget === stage) {
      return true;
    }
    const t = ev.target;
    return t instanceof Node && stage.contains(t);
  }

  private isFinderPanIgnoreTarget(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : null;
    if (!el) {
      return false;
    }
    if (el.closest('.ac-finder__obj, .ac-finder__const-star, .ac-finder__trail, .ac-finder__constellation')) {
      return false;
    }
    return !!el.closest(
      'button, input, label, a, select, textarea, .ac-finder__zoom, .ac-finder__cue, .ac-cam-resize'
    );
  }

  private beginFinderPan(
    x: number,
    y: number,
    target: EventTarget | null,
    currentTarget: EventTarget | null
  ): boolean {
    if (!this.canPanFinderView() || this.isFinderPanIgnoreTarget(target)) {
      return false;
    }
    const stage = this.camStage?.nativeElement;
    if (
      !stage ||
      (currentTarget !== stage && !(target instanceof Node && stage.contains(target)))
    ) {
      return false;
    }
    this.finderPanning = true;
    this.finderPanMoved = false;
    this.finderPanLastX = x;
    this.finderPanLastY = y;
    return true;
  }

  private moveFinderPan(x: number, y: number): void {
    if (!this.finderPanning) {
      return;
    }
    const dx = x - this.finderPanLastX;
    const dy = y - this.finderPanLastY;
    if (!this.finderPanMoved && Math.hypot(dx, dy) < 3) {
      return;
    }
    this.finderPanMoved = true;
    this.finderPanLastX = x;
    this.finderPanLastY = y;
    this.applyFinderPanPixels(dx, dy);
  }

  private endFinderPan(): void {
    if (!this.finderPanning && this.finderPanPointerId == null) {
      return;
    }
    this.finderPanning = false;
    this.finderPanPointerId = null;
    this.finderPanMoved = false;
    this.cdr.markForCheck();
  }

  private applyFinderPanPixels(dx: number, dy: number): void {
    if (!this.canPanFinderView() || (!dx && !dy)) {
      return;
    }
    const stage = this.camStage?.nativeElement;
    const w = stage?.clientWidth || 1;
    const h = stage?.clientHeight || 1;
    const fov = this.finderFovDeg();
    const cosEl = Math.max(0.15, Math.cos(((this.finderPoseCamEl ?? 0) * Math.PI) / 180));
    this.finderPanAz += ((-dx / w) * fov.hfov) / cosEl;
    this.finderPanEl += (dy / h) * fov.vfov;
    this.clampFinderPanEl();
    this.updateFinderProjection();
    this.cdr.markForCheck();
  }

  private resetFinderPan(): void {
    this.endFinderPan();
    this.finderPanAz = 0;
    this.finderPanEl = 0;
    this.syncFinderVideoTransform();
  }

  private clampFinderElevation(el: number): number {
    return Math.min(FINDER_PAN_EL_MAX, Math.max(FINDER_PAN_EL_MIN, el));
  }

  private clampFinderPanEl(): void {
    const base = this.finderPoseCamEl ?? 0;
    const min = FINDER_PAN_EL_MIN - base;
    const max = FINDER_PAN_EL_MAX - base;
    this.finderPanEl = Math.min(max, Math.max(min, this.finderPanEl));
  }

  private refreshFinderLabelScale(): void {
    const z = Math.max(FINDER_ZOOM_MIN, this.finderZoom);
    this.finderLabelScale = parseFloat(Math.min(FINDER_LABEL_SCALE_MAX, z).toFixed(3));
  }

  private syncFinderVideoTransform(): void {
    const z = this.finderDigitalZoom;
    if (
      !this.finderPoseFrozen ||
      (Math.abs(this.finderPanAz) < 1e-4 && Math.abs(this.finderPanEl) < 1e-4)
    ) {
      this.finderVideoTransform = `scale(${z})`;
      return;
    }
    const fov = this.finderFovDeg();
    const cosEl = Math.max(0.15, Math.cos(((this.finderPoseCamEl ?? 0) * Math.PI) / 180));
    const tx = ((-this.finderPanAz * cosEl) / Math.max(0.25, fov.hfov)) * 100;
    const ty = (this.finderPanEl / Math.max(0.25, fov.vfov)) * 100;
    this.finderVideoTransform = `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%) scale(${z})`;
  }

  private setFinderZoom(next: number, snap: boolean, persist = true): void {
    let z = Math.min(FINDER_ZOOM_MAX, Math.max(FINDER_ZOOM_MIN, next));
    if (snap) {
      z = Math.round(z / FINDER_ZOOM_STEP) * FINDER_ZOOM_STEP;
    }
    z = parseFloat(z.toFixed(2));
    if (z === this.finderZoom && persist) {
      this.persistFinderZoomPref();
      return;
    }
    this.finderZoom = z;
    this.refreshFinderLabelScale();
    this.syncFinderZoomOutputs();
    this.updateFinderProjection();
    if (persist) {
      this.persistFinderZoomPref();
    }
    this.cdr.markForCheck();
  }

  private syncFinderZoomOutputs(): void {
    if (this.cameraShouldBeFrozen()) {
      const hw = Math.max(1, this.finderFreezeHwZoom);
      this.finderDigitalZoom = this.finderZoom / hw;
      this.syncFinderVideoTransform();
      return;
    }
    const caps = this.camZoomCaps;
    const track = this.camStream?.getVideoTracks()[0];
    if (caps && track) {
      const hw = Math.min(caps.max, Math.max(caps.min, this.finderZoom));
      this.finderDigitalZoom = this.finderZoom / hw;
      void track
        .applyConstraints({ advanced: [{ zoom: hw }] } as unknown as MediaTrackConstraints)
        .catch(() => {
          this.finderDigitalZoom = this.finderZoom;
          this.syncFinderVideoTransform();
          this.cdr.markForCheck();
        });
      return;
    }
    this.finderDigitalZoom = this.finderZoom;
  }

  private refreshCameraZoomCaps(): void {
    try {
      const track = this.camStream?.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & {
        zoom?: number | { min?: number; max?: number };
      }) | undefined;
      const z = caps?.zoom;
      if (z && typeof z === 'object' && Number.isFinite(z.max) && (z.max ?? 0) > (z.min ?? 1)) {
        this.camZoomCaps = { min: z.min ?? 1, max: z.max as number };
        return;
      }
    } catch {
      /* iOS / navigateurs sans zoom capteur */
    }
    this.camZoomCaps = null;
  }

  private bindFinderZoomGestures(): void {
    const el = this.camStage?.nativeElement;
    if (!el || this.finderZoomGesturesBound) {
      return;
    }
    /* capture : en plein écran la vidéo remplit le viseur et avale sinon le pinch. */
    el.addEventListener('wheel', this.onFinderWheelNative, { passive: false, capture: true });
    el.addEventListener('touchstart', this.onFinderTouchStartNative, { passive: true, capture: true });
    el.addEventListener('touchmove', this.onFinderTouchMoveNative, { passive: false, capture: true });
    el.addEventListener('touchend', this.onFinderTouchEndNative, { passive: true, capture: true });
    el.addEventListener('touchcancel', this.onFinderTouchEndNative, { passive: true, capture: true });
    el.addEventListener('pointerdown', this.onFinderPointerDownNative, { capture: true });
    el.addEventListener('pointermove', this.onFinderPointerMoveNative, { capture: true });
    el.addEventListener('pointerup', this.onFinderPointerUpNative, { capture: true });
    el.addEventListener('pointercancel', this.onFinderPointerUpNative, { capture: true });
    this.finderZoomGesturesBound = true;
  }

  private unbindFinderZoomGestures(): void {
    const el = this.camStage?.nativeElement;
    if (!el || !this.finderZoomGesturesBound) {
      return;
    }
    el.removeEventListener('wheel', this.onFinderWheelNative, true);
    el.removeEventListener('touchstart', this.onFinderTouchStartNative, true);
    el.removeEventListener('touchmove', this.onFinderTouchMoveNative, true);
    el.removeEventListener('touchend', this.onFinderTouchEndNative, true);
    el.removeEventListener('touchcancel', this.onFinderTouchEndNative, true);
    el.removeEventListener('pointerdown', this.onFinderPointerDownNative, true);
    el.removeEventListener('pointermove', this.onFinderPointerMoveNative, true);
    el.removeEventListener('pointerup', this.onFinderPointerUpNative, true);
    el.removeEventListener('pointercancel', this.onFinderPointerUpNative, true);
    this.finderZoomGesturesBound = false;
  }

  private bindLiveModalZoomGestures(): void {
    const el = this.liveModalEl?.nativeElement;
    if (!el || this.liveModalZoomGesturesBound) {
      return;
    }
    el.addEventListener('wheel', this.onLiveModalWheelNative, { passive: false, capture: true });
    el.addEventListener('touchstart', this.onLiveModalTouchStartNative, { passive: true, capture: true });
    el.addEventListener('touchmove', this.onLiveModalTouchMoveNative, { passive: false, capture: true });
    el.addEventListener('touchend', this.onLiveModalTouchEndNative, { passive: true, capture: true });
    el.addEventListener('touchcancel', this.onLiveModalTouchEndNative, { passive: true, capture: true });
    this.liveModalZoomGesturesBound = true;
  }

  private unbindLiveModalZoomGestures(): void {
    const el = this.liveModalEl?.nativeElement;
    if (!el || !this.liveModalZoomGesturesBound) {
      return;
    }
    el.removeEventListener('wheel', this.onLiveModalWheelNative, true);
    el.removeEventListener('touchstart', this.onLiveModalTouchStartNative, true);
    el.removeEventListener('touchmove', this.onLiveModalTouchMoveNative, true);
    el.removeEventListener('touchend', this.onLiveModalTouchEndNative, true);
    el.removeEventListener('touchcancel', this.onLiveModalTouchEndNative, true);
    this.liveModalZoomGesturesBound = false;
  }

  private bindFinderStageResize(): void {
    const el = this.camStage?.nativeElement;
    if (!el || this.finderStageResizeObs || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.finderStageResizeObs = new ResizeObserver(() => this.scheduleFinderViewportSync());
    this.finderStageResizeObs.observe(el);
  }

  private unbindFinderStageResize(): void {
    this.finderStageResizeObs?.disconnect();
    this.finderStageResizeObs = null;
  }

  private scheduleFinderViewportSync(): void {
    if (this.finderViewportSyncTimer != null) {
      clearTimeout(this.finderViewportSyncTimer);
    }
    this.finderViewportSyncTimer = setTimeout(() => {
      this.finderViewportSyncTimer = null;
      this.updateFinderProjection();
      this.cdr.markForCheck();
    }, 50);
  }

  private loadFinderZoomPref(): void {
    const stored = this.readUserLocal(AstroCompassComponent.FINDER_ZOOM_KEY);
    const raw = stored == null || stored === '' ? NaN : Number(stored);
    if (Number.isFinite(raw)) {
      this.finderZoom = Math.min(FINDER_ZOOM_MAX, Math.max(FINDER_ZOOM_MIN, raw));
    } else {
      this.finderZoom = FINDER_ZOOM_MIN;
    }
    this.refreshFinderLabelScale();
    this.syncFinderZoomOutputs();
    this.syncFinderVideoTransform();
  }

  private persistFinderZoomPref(): void {
    this.writeUserLocal(AstroCompassComponent.FINDER_ZOOM_KEY, String(this.finderZoom));
  }

  private loadCamHeightPref(): void {
    this.camHeightPx = loadCamHeightPx(this.userLocalKey(AstroCompassComponent.CAM_HEIGHT_KEY))
      ?? loadCamHeightPx(AstroCompassComponent.CAM_HEIGHT_KEY);
  }

  startCamResize(ev: PointerEvent): void {
    if (this.isFullscreen) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const el = this.camStage?.nativeElement;
    if (!el) {
      return;
    }
    this.camResizing = true;
    this.camResizePointerId = ev.pointerId;
    this.camResizeStartY = ev.clientY;
    this.camResizeStartH = el.getBoundingClientRect().height;
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  }

  onCamResizeMove(ev: PointerEvent): void {
    if (!this.camResizing || ev.pointerId !== this.camResizePointerId) {
      return;
    }
    ev.preventDefault();
    this.camHeightPx = clampCamHeightPx(this.camResizeStartH + (ev.clientY - this.camResizeStartY));
    this.cdr.markForCheck();
  }

  endCamResize(ev?: PointerEvent): void {
    if (!this.camResizing) {
      return;
    }
    if (ev && this.camResizePointerId != null && ev.pointerId !== this.camResizePointerId) {
      return;
    }
    this.camResizing = false;
    this.camResizePointerId = null;
    saveCamHeightPx(this.userLocalKey(AstroCompassComponent.CAM_HEIGHT_KEY), this.camHeightPx);
    this.cdr.markForCheck();
  }

  resetCamSize(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.camResizing = false;
    this.camResizePointerId = null;
    this.camHeightPx = null;
    saveCamHeightPx(this.userLocalKey(AstroCompassComponent.CAM_HEIGHT_KEY), null);
    this.cdr.markForCheck();
  }

  private loadVisibleOnlyPref(): void {
    const raw = this.readUserLocal(AstroCompassComponent.VISIBLE_ONLY_KEY);
    if (raw === '0' || raw === '1') {
      this.visibleOnly = raw === '1';
    }
  }

  private persistVisibleOnlyPref(): void {
    this.writeUserLocal(AstroCompassComponent.VISIBLE_ONLY_KEY, this.visibleOnly ? '1' : '0');
  }

  onTickerChange(): void {
    this.persistTickerPref();
    if (this.tickerEnabled) {
      this.refreshTickerNowLabel();
    } else {
      this.tickerResizeObs?.disconnect();
      this.tickerResizeObs = undefined;
    }
    this.cdr.markForCheck();
  }

  tickerHasLiveData(): boolean {
    return !!this.bodyLabel;
  }

  private loadTickerPref(): void {
    const raw = this.readUserLocal(AstroCompassComponent.TICKER_KEY);
    if (raw === '0' || raw === '1') {
      this.tickerEnabled = raw === '1';
    } else {
      this.tickerEnabled = true;
    }
    this.refreshTickerNowLabel();
    const gen = ++this.tickerLoadGen;
    this.api.getAstroTicker().subscribe({
      next: (dto) => {
        if (gen !== this.tickerLoadGen) {
          return;
        }
        if (dto && typeof dto.enabled === 'boolean') {
          this.applyTickerEnabled(dto.enabled, false);
        } else if (raw === '0' || raw === '1') {
          this.saveTickerRemote(this.tickerEnabled);
        }
      },
      error: () => {
        /* anonyme / hors-ligne : le localStorage ou le défaut (activé) restent */
      }
    });
  }

  private persistTickerPref(): void {
    this.writeUserLocal(AstroCompassComponent.TICKER_KEY, this.tickerEnabled ? '1' : '0');
    this.saveTickerRemote(this.tickerEnabled);
  }

  private applyTickerEnabled(enabled: boolean, persistRemote: boolean): void {
    const changed = this.tickerEnabled !== enabled;
    this.tickerEnabled = enabled;
    this.writeUserLocal(AstroCompassComponent.TICKER_KEY, enabled ? '1' : '0');
    if (changed) {
      if (enabled) {
        this.refreshTickerNowLabel();
      }
      this.cdr.markForCheck();
    }
    if (persistRemote) {
      this.saveTickerRemote(enabled);
    }
  }

  private saveTickerRemote(enabled: boolean): void {
    this.tickerLoadGen++;
    this.tickerSaveSub?.unsubscribe();
    this.tickerSaveSub = this.api.setAstroTicker(enabled).subscribe({
      error: () => {
        /* hors connexion / anonyme : le localStorage suffit */
      }
    });
  }

  private refreshTickerNowLabel(): void {
    if (!this.tickerEnabled) {
      return;
    }
    const label = this.formatTickerNowLabel(this.nowMs || Date.now());
    if (label !== this.tickerNowLabel) {
      this.tickerNowLabel = label;
    }
  }

  private formatTickerNowLabel(ms: number): string {
    try {
      const lang = (this.translate.currentLang || 'en').split('-')[0];
      if (lang !== this.tickerNowFormatterLang || !this.tickerNowFormatter) {
        this.tickerNowFormatterLang = lang;
        this.tickerNowFormatter = new Intl.DateTimeFormat(lang, {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
      }
      return this.tickerNowFormatter.format(new Date(ms));
    } catch {
      return '';
    }
  }

  private attachTickerSpeedObserver(): void {
    this.tickerResizeObs?.disconnect();
    this.tickerResizeObs = undefined;
    const el = this.tickerHalfEl;
    if (!el) {
      return;
    }
    if (typeof ResizeObserver === 'undefined') {
      queueMicrotask(() => this.updateTickerDuration(el.getBoundingClientRect().width));
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.tickerResizeObs = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width != null && width > 0) {
          this.scheduleTickerDurationUpdate(width);
        }
      });
      this.tickerResizeObs.observe(el);
    });
  }

  private scheduleTickerDurationUpdate(halfWidthPx: number): void {
    this.pendingTickerHalfWidthPx = halfWidthPx;
    if (this.tickerDurationRaf != null) {
      return;
    }
    this.tickerDurationRaf = requestAnimationFrame(() => {
      this.tickerDurationRaf = null;
      this.updateTickerDuration(this.pendingTickerHalfWidthPx);
    });
  }

  private updateTickerDuration(halfWidthPx: number): void {
    if (!Number.isFinite(halfWidthPx) || halfWidthPx <= 0) {
      return;
    }
    const sec = Math.max(18, halfWidthPx / AstroCompassComponent.TICKER_SPEED_PX_PER_SEC);
    const rounded = Math.round(sec);
    if (Math.abs(rounded - this.tickerDurationSec) < 8) {
      return;
    }
    this.zone.run(() => {
      this.tickerDurationSec = rounded;
      this.cdr.markForCheck();
    });
  }

  private ensureFinderTrailTle(): void {
    if (this.selectedKind !== 'iss') {
      return;
    }
    const sat = this.selectedSatellite;
    if (sat.skipLiveTle) {
      return;
    }
    this.satNow.setObserver(this.lat, this.lon);
    void this.satNow.ensureOption(sat, false).then(() => {
      if (!this.finderTrailEnabled || this.selectedKind !== 'iss' || this.selectedSatelliteId !== sat.id) {
        return;
      }
      this.finderTrailSkyAtMs = 0;
      this.updateFinderProjection();
      this.cdr.markForCheck();
    });
  }

  private clearFinderTrailScreen(): void {
    if (this.finderTrailPolylines.length || this.finderTrailTicks.length) {
      this.finderTrailPolylines = [];
      this.finderTrailTicks = [];
    }
  }

  private projectFinderTrail(
    camAz: number,
    camEl: number,
    hfov: number,
    vfov: number,
    force = false
  ): void {
    if (!this.finderTrailEnabled) {
      this.clearFinderTrailScreen();
      return;
    }
    if (this.finderPoseFrozen && !force) {
      return;
    }
    this.refreshFinderTrailSky();
    if (this.finderTrailSky.length < 2) {
      this.clearFinderTrailScreen();
      return;
    }
    const tickEveryMin = this.finderTrailTickEveryMin();
    const polylines: string[] = [];
    const ticks: FinderTrailTick[] = [];
    let segment: string[] = [];
    let prev: { xPct: number; yPct: number } | null = null;
    const now = Date.now();
    for (const pt of this.finderTrailSky) {
      const proj = projectCelestialToScreen(camAz, camEl, 0, pt.az, pt.el, hfov, vfov);
      const onGlass = proj.inFront && proj.xPct >= -12 && proj.xPct <= 112 && proj.yPct >= -12 && proj.yPct <= 112;
      if (!onGlass) {
        if (segment.length >= 2) {
          polylines.push(segment.join(' '));
        }
        segment = [];
        prev = null;
        continue;
      }
      const jump = prev != null && Math.hypot(proj.xPct - prev.xPct, proj.yPct - prev.yPct) > 42;
      if (jump && segment.length >= 2) {
        polylines.push(segment.join(' '));
        segment = [];
      } else if (jump) {
        segment = [];
      }
      const pair = `${proj.xPct.toFixed(2)},${proj.yPct.toFixed(2)}`;
      segment.push(pair);
      prev = { xPct: proj.xPct, yPct: proj.yPct };
      const min = Math.round((pt.tMs - now) / 60_000);
      if (min >= tickEveryMin && min % tickEveryMin === 0 && proj.inView) {
        if (!ticks.some((t) => t.min === min)) {
          ticks.push({ xPct: proj.xPct, yPct: proj.yPct, min });
        }
      }
    }
    if (segment.length >= 2) {
      polylines.push(segment.join(' '));
    }
    this.finderTrailPolylines = polylines;
    this.finderTrailTicks = ticks;
  }

  private refreshFinderTrailSky(): void {
    const key = this.finderTrailTargetKey();
    const now = Date.now();
    if (
      key === this.finderTrailSkyKey &&
      now - this.finderTrailSkyAtMs < FINDER_TRAIL_SKY_MAX_AGE_MS &&
      this.finderTrailSky.length > 1
    ) {
      return;
    }
    this.finderTrailSkyKey = key;
    this.finderTrailSkyAtMs = now;
    this.finderTrailSky = this.computeFinderTrailSky(now);
  }

  private finderTrailTargetKey(): string {
    const dur = this.finderTrailMinutes;
    if (this.selectedKind === 'iss') {
      return `iss:${this.selectedSatelliteId}:${dur}`;
    }
    if (this.selectedKind === 'planet') {
      return `planet:${this.selectedPlanetId}:${dur}`;
    }
    if (this.selectedKind === 'star') {
      return `star:${this.selectedStarId ?? ''}:${dur}`;
    }
    if (this.selectedKind === 'galaxy') {
      return `galaxy:${this.selectedGalaxyId ?? ''}:${dur}`;
    }
    if (this.selectedKind === 'constellation') {
      return `constellation:${this.selectedConstellationId ?? ''}:${dur}`;
    }
    return `custom:${this.customRaHours}:${this.customDecDeg}:${dur}`;
  }

  private computeFinderTrailSky(nowMs: number): FinderTrailSkyPt[] {
    if (this.azimuthDeg == null || this.elevationDeg == null) {
      return [];
    }
    const out: FinderTrailSkyPt[] = [{ az: this.azimuthDeg, el: this.elevationDeg, tMs: nowMs }];
    if (this.selectedKind === 'iss') {
      return out.concat(this.computeSatelliteTrailSky(nowMs));
    }
    return out.concat(this.computeCelestialTrailSky(nowMs));
  }

  private computeSatelliteTrailSky(nowMs: number): FinderTrailSkyPt[] {
    const sat = this.selectedSatellite;
    const durationMs = this.finderTrailDurationMs();
    const stepMs = this.finderTrailStepMs();
    if (sat.skipLiveTle && !sat.sunEarthL2) {
      return this.computeFixedSkyTrailFromCurrent(nowMs, durationMs, stepMs);
    }
    this.satNow.setObserver(this.lat, this.lon);
    const probe = this.satNow.snapshotForOption(sat, nowMs + stepMs);
    if (!probe) {
      this.ensureFinderTrailTle();
      return [];
    }
    const pts: FinderTrailSkyPt[] = [];
    const end = nowMs + durationMs;
    for (let t = nowMs + stepMs; t <= end; t += stepMs) {
      const azEl = this.satelliteAzElAt(t);
      if (!azEl || azEl.el < -8) {
        if (azEl && azEl.el < -8 && pts.length > 4) {
          break;
        }
        continue;
      }
      pts.push({ az: azEl.az, el: azEl.el, tMs: t });
    }
    return pts;
  }

  private satelliteAzElAt(tMs: number): { az: number; el: number } | null {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return null;
    }
    const sat = this.selectedSatellite;
    const snap = this.satNow.snapshotForOption(sat, tMs);
    if (!snap) {
      return null;
    }
    const h = snap.altKm != null && snap.altKm > 0 ? snap.altKm : sat.defaultAltKm;
    const groundKm = AstroCompassComponent.haversineGreatCircleKm(this.lat, this.lon, snap.lat, snap.lon);
    const el = (AstroCompassComponent.satelliteElevationRad(groundKm / EARTH_RADIUS_KM, h) * 180) / Math.PI;
    const az = AstroCompassComponent.initialBearingDeg(this.lat, this.lon, snap.lat, snap.lon);
    return { az, el };
  }

  private computeCelestialTrailSky(nowMs: number): FinderTrailSkyPt[] {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return [];
    }
    const observer = new Observer(this.lat, this.lon, this.height);
    const planet = this.selectedKind === 'planet' ? findPlanetById(this.selectedPlanetId) : undefined;
    let ra = this.raHours;
    let dec = this.decDeg;
    if (planet == null && (ra == null || dec == null)) {
      return this.computeFixedSkyTrailFromCurrent(nowMs, this.finderTrailDurationMs(), this.finderTrailStepMs());
    }
    const pts: FinderTrailSkyPt[] = [];
    const stepMs = this.finderTrailStepMs();
    const end = nowMs + this.finderTrailDurationMs();
    for (let t = nowMs + stepMs; t <= end; t += stepMs) {
      const date = new Date(t);
      try {
        if (planet) {
          const eq = Equator(planet.body, date, observer, true, true);
          ra = eq.ra;
          dec = eq.dec;
        }
        if (ra == null || dec == null) {
          continue;
        }
        const hor = Horizon(date, observer, ra, dec, 'normal');
        if (hor.altitude < -8) {
          if (pts.length > 3) {
            break;
          }
          continue;
        }
        pts.push({ az: hor.azimuth, el: hor.altitude, tMs: t });
      } catch {
        /* éphéméride indisponible pour cet instant */
      }
    }
    return pts;
  }

  /** Objet lointain sans TLE (ex. JWST) : RA/Déc figés à partir de la visée actuelle. */
  private computeFixedSkyTrailFromCurrent(
    nowMs: number,
    durationMs: number,
    stepMs: number
  ): FinderTrailSkyPt[] {
    if (
      this.azimuthDeg == null ||
      this.elevationDeg == null ||
      !Number.isFinite(this.lat) ||
      !Number.isFinite(this.lon)
    ) {
      return [];
    }
    const eq = AstroCompassComponent.horizontalToEquatorial(
      this.azimuthDeg,
      this.elevationDeg,
      new Date(nowMs),
      this.lat,
      this.lon
    );
    if (!eq) {
      return [];
    }
    const observer = new Observer(this.lat, this.lon, this.height);
    const pts: FinderTrailSkyPt[] = [];
    const end = nowMs + durationMs;
    for (let t = nowMs + stepMs; t <= end; t += stepMs) {
      try {
        const hor = Horizon(new Date(t), observer, eq.raHours, eq.decDeg, 'normal');
        if (hor.altitude < -8) {
          break;
        }
        pts.push({ az: hor.azimuth, el: hor.altitude, tMs: t });
      } catch {
        /* ignore */
      }
    }
    return pts;
  }

  /** Azimut / élévation (Nord → Est) vers AD / Déc. */
  private static horizontalToEquatorial(
    azDeg: number,
    elDeg: number,
    date: Date,
    latDeg: number,
    lonDeg: number
  ): { raHours: number; decDeg: number } | null {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const lat = (latDeg * Math.PI) / 180;
    const sinDec = Math.sin(lat) * Math.sin(el) + Math.cos(lat) * Math.cos(el) * Math.cos(az);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const cosDec = Math.cos(dec);
    if (Math.abs(cosDec) < 1e-8) {
      return { raHours: 0, decDeg: (dec * 180) / Math.PI };
    }
    const sinH = (-Math.sin(az) * Math.cos(el)) / cosDec;
    const cosH = (Math.sin(el) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * cosDec);
    const hourAngleHours = (Math.atan2(sinH, cosH) * 12) / Math.PI;
    let gst: number;
    try {
      gst = SiderealTime(date);
    } catch {
      return null;
    }
    let raHours = gst + lonDeg / 15 - hourAngleHours;
    raHours = ((raHours % 24) + 24) % 24;
    return { raHours, decDeg: (dec * 180) / Math.PI };
  }

  /**
   * Portrait + flux 16:9 en `cover` : le vertical affiché est le petit côté
   * de la vidéo (~38°), pas 64°. Sinon l’astre stagne sous le réticule.
   */
  private finderFovDeg(): { hfov: number; vfov: number } {
    const video = this.camEl?.nativeElement;
    const stage = this.camStage?.nativeElement;
    const base = displayedCameraFovDeg(
      video?.videoWidth || 0,
      video?.videoHeight || 0,
      stage?.clientWidth || video?.clientWidth || 0,
      stage?.clientHeight || video?.clientHeight || 0
    );
    const z = Math.max(FINDER_ZOOM_MIN, this.finderZoom);
    return { hfov: base.hfov / z, vfov: base.vfov / z };
  }

  /* ------------------------------------------------------------------ */
  /* Sélection planète / étoile / coords custom                          */
  /* ------------------------------------------------------------------ */

  selectPlanet(id: string): void {
    const planet = findPlanetById(id);
    if (!planet) {
      return;
    }
    this.noteUserTargetChoice();
    this.selectedKind = 'planet';
    this.selectedPlanetId = id;
    this.selectedStarId = undefined;
    this.selectedGalaxyId = undefined;
    this.selectedConstellationId = undefined;
    this.applyBodyDisplayFromPlanet(planet);
    this.syncTargetAccordionFromSelection();
    this.recomputeSky();
    this.maybeReloadObjectDossier();
    this.persistLastTarget();
    this.cdr.markForCheck();
  }

  selectIss(): void {
    this.selectSatellite('iss');
  }

  selectSatellite(id: string): void {
    const sat = findSatelliteById(id);
    if (!sat) {
      return;
    }
    this.noteUserTargetChoice();
    this.selectedKind = 'iss';
    this.selectedSatelliteId = sat.id;
    this.selectedStarId = undefined;
    this.selectedGalaxyId = undefined;
    this.selectedConstellationId = undefined;
    this.applyBodyDisplayFromSatellite(sat);
    this.syncTargetAccordionFromSelection();
    this.issStatus = 'loading';
    if (sat.useIssLiveFeed) {
      void this.issNow.refresh(true).then(() => {
        if (this.selectedKind === 'iss' && this.selectedSatelliteId === sat.id) {
          this.recomputeSky();
          this.cdr.markForCheck();
        }
      });
      this.refreshIssPasses(true);
    } else if (!sat.skipLiveTle) {
      this.satNow.setObserver(this.lat, this.lon);
      void this.satNow.ensureOption(sat, true).then(() => {
        if (this.selectedKind === 'iss' && this.selectedSatelliteId === sat.id) {
          this.recomputeSky();
          this.cdr.markForCheck();
        }
      });
      this.issPasses = [];
      this.issPassesLoadedAtMs = 0;
      this.riseAt = null;
      this.setAt = null;
    } else {
      this.issPasses = [];
      this.issPassesLoadedAtMs = 0;
      this.riseAt = null;
      this.setAt = null;
    }
    this.recomputeSky();
    this.maybeReloadObjectDossier();
    if (this.finderTrailEnabled) {
      this.finderTrailSkyAtMs = 0;
      this.ensureFinderTrailTle();
    }
    this.persistLastTarget();
    this.cdr.markForCheck();
  }

  get selectedSatellite(): AstroSatelliteOption {
    return findSatelliteById(this.selectedSatelliteId) ?? this.issOption;
  }

  /** Globe 3D : satellites avec position (ISS, TLE, GEO, L2). */
  canOpenWorldGlobeOnSatellite(): boolean {
    if (this.selectedKind !== 'iss') {
      return false;
    }
    return satelliteHasLivePosition(this.selectedSatellite);
  }

  /** Ouvre le globe terrestre centré sur le satellite (ou l’ISS) courant. */
  openWorldGlobeOnSatellite(): void {
    if (!this.canOpenWorldGlobeOnSatellite()) {
      return;
    }
    const id = (this.selectedSatelliteId || 'iss').trim().toLowerCase();
    this.writeGlobeReturnSat(id);
    void this.router.navigate(['/tools/world-globe'], {
      queryParams: { sat: id, autoRotate: '0' }
    });
  }

  selectStar(star: AstroStarOption): void {
    if (!star) {
      return;
    }
    this.noteUserTargetChoice();
    this.selectedKind = 'star';
    this.selectedStarId = star.id;
    this.selectedGalaxyId = undefined;
    this.selectedConstellationId = undefined;
    this.applyBodyDisplayFromStar(star);
    this.syncTargetAccordionFromSelection();
    this.recomputeSky();
    this.onStarQueryChange();
    this.maybeReloadObjectDossier();
    this.persistLastTarget();
    this.cdr.markForCheck();
  }

  selectGalaxy(galaxy: AstroGalaxyOption): void {
    if (!galaxy) {
      return;
    }
    this.noteUserTargetChoice();
    this.selectedKind = 'galaxy';
    this.selectedGalaxyId = galaxy.id;
    this.selectedStarId = undefined;
    this.selectedConstellationId = undefined;
    this.applyBodyDisplayFromGalaxy(galaxy);
    this.syncTargetAccordionFromSelection();
    this.recomputeSky();
    this.onGalaxyQueryChange();
    this.maybeReloadObjectDossier();
    this.persistLastTarget();
    this.cdr.markForCheck();
  }

  constellationDisplayName(item: AstroConstellationOption): string {
    const lang = (this.translate.currentLang || 'fr').toLowerCase();
    return lang.startsWith('fr') ? item.nameFr : item.name;
  }

  isTargetAccordionOpen(id: TargetAccordionId): boolean {
    return this.targetAccordionOpen === id;
  }

  toggleTargetAccordion(id: TargetAccordionId): void {
    this.targetAccordionOpen = this.targetAccordionOpen === id ? null : id;
    this.cdr.markForCheck();
    if (
      this.targetAccordionOpen === 'star' ||
      this.targetAccordionOpen === 'galaxy' ||
      this.targetAccordionOpen === 'constellation'
    ) {
      queueMicrotask(() => this.scrollCatalogSelectionIntoView());
    }
  }

  private scrollCatalogSelectionIntoView(): void {
    const active = this.hostEl.nativeElement.querySelector('.ac-picker__opt--active') as HTMLElement | null;
    active?.scrollIntoView({ block: 'nearest' });
  }

  get typeHelp(): TypeHelpCopy | null {
    return this.typeHelpOpen ? TARGET_TYPE_HELP[this.typeHelpOpen] : null;
  }

  openTypeHelp(id: TargetAccordionId, ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.typeHelpOpen = id;
    this.cdr.markForCheck();
  }

  closeTypeHelp(): void {
    this.typeHelpOpen = null;
    this.cdr.markForCheck();
  }

  private syncTargetAccordionFromSelection(): void {
    if (this.applyingAutoTarget) {
      return;
    }
    this.targetAccordionOpen = this.selectedKind === 'iss' ? 'iss' : this.selectedKind;
  }

  selectConstellation(item: AstroConstellationOption): void {
    if (!item) {
      return;
    }
    this.noteUserTargetChoice();
    this.selectedKind = 'constellation';
    this.selectedConstellationId = item.id;
    this.selectedStarId = undefined;
    this.selectedGalaxyId = undefined;
    this.applyBodyDisplayFromConstellation(item);
    this.buildEquatorialConstellationSchema(item);
    this.syncTargetAccordionFromSelection();
    this.recomputeSky();
    this.onConstellationQueryChange();
    this.maybeReloadObjectDossier();
    this.persistLastTarget();
    this.cdr.markForCheck();
  }

  /**
   * Active / coupe l'auto-détection live : recalcule en continu
   * l'astre / planète / galaxie / ISS pointé(e) par le téléphone.
   */
  toggleAutoDetectLive(): void {
    if (this.autoDetectLive) {
      this.stopAutoDetectLive();
      return;
    }
    this.autoDetectErrorKey = null;
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_LOCATION';
      this.cdr.markForCheck();
      return;
    }
    if (!this.headingActive || this.headingDeg == null) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_HEADING';
      this.cdr.markForCheck();
      return;
    }
    if (this.devicePitchDeg == null) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_PITCH';
      this.cdr.markForCheck();
      return;
    }

    this.autoDetectLive = true;
    this.autoDetectModalOpen = true;
    this.autoDetectPaused = false;
    this.syncCameraFreeze();
    this.autoDetectSettingsOpen = false;
    this.autoDetectBusy = true;
    this.autoDetectLastAppliedKey = null;
    this.autoDetectCache = [];
    this.autoDetectCacheAtMs = 0;
    this.cdr.markForCheck();

    void this.ensureCameraForAutoDetect();
    this.runAutoDetectPass(true);
    this.restartAutoDetectTimer();
  }

  private async ensureCameraForAutoDetect(): Promise<void> {
    if (this.camLive && this.camStream) {
      await this.attachCameraStream();
      return;
    }
    await this.startCamera();
  }

  /** Alias bouton : bascule le mode live. */
  autoDetectSky(): void {
    this.toggleAutoDetectLive();
  }

  closeAutoDetectModal(): void {
    this.clearAutoDetect();
  }

  toggleAutoDetectPause(): void {
    if (!this.autoDetectModalOpen) {
      return;
    }
    if (this.autoDetectPaused) {
      this.autoDetectPaused = false;
      this.autoDetectLive = true;
      this.syncCameraFreeze();
      this.clearObjectDossier();
      this.runAutoDetectPass(false);
      this.restartAutoDetectTimer();
    } else {
      this.autoDetectPaused = true;
      this.syncCameraFreeze();
      this.stopAutoDetectTimerOnly();
      this.loadObjectDossier();
    }
    this.cdr.markForCheck();
  }

  onAutoDetectFiltersChange(): void {
    this.autoDetectCache = [];
    this.autoDetectCacheAtMs = 0;
    this.autoDetectLastAppliedKey = null;
    if (this.autoDetectLive && !this.autoDetectPaused) {
      this.runAutoDetectPass(true);
    }
    this.cdr.markForCheck();
  }

  toggleAutoDetectSettings(): void {
    this.autoDetectSettingsOpen = !this.autoDetectSettingsOpen;
    this.cdr.markForCheck();
  }

  toggleAutoDetectInclude(
    which: 'planets' | 'stars' | 'constellations' | 'galaxies' | 'iss'
  ): void {
    if (which === 'planets') {
      this.autoDetectIncludePlanets = !this.autoDetectIncludePlanets;
    } else if (which === 'stars') {
      this.autoDetectIncludeStars = !this.autoDetectIncludeStars;
    } else if (which === 'constellations') {
      this.autoDetectIncludeConstellations = !this.autoDetectIncludeConstellations;
    } else if (which === 'galaxies') {
      this.autoDetectIncludeGalaxies = !this.autoDetectIncludeGalaxies;
    } else {
      this.autoDetectIncludeIss = !this.autoDetectIncludeIss;
    }
    this.onAutoDetectFiltersChange();
  }

  onMaxMagnitudeChange(raw: number | string): void {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(n)) {
      return;
    }
    this.maxMagnitude = this.clampMaxMagnitude(n);
    this.persistMaxMagnitudePref();
    this.onStarQueryChange();
    this.onAutoDetectFiltersChange();
  }

  private passesMaxMagnitude(mag: number | null | undefined): boolean {
    if (mag == null || !Number.isFinite(mag)) {
      return true;
    }
    return mag <= this.maxMagnitude;
  }

  toggleAutoDetectNakedEye(): void {
    this.autoDetectNakedEye = !this.autoDetectNakedEye;
    this.onAutoDetectFiltersChange();
  }

  onAutoDetectIntervalChange(raw: number | string): void {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(n)) {
      return;
    }
    const stepped =
      Math.round(n / this.autoDetectIntervalStepMs) * this.autoDetectIntervalStepMs;
    this.autoDetectIntervalMs = Math.max(
      this.autoDetectIntervalMinMs,
      Math.min(this.autoDetectIntervalMaxMs, stepped)
    );
    if (this.autoDetectLive && !this.autoDetectPaused) {
      this.restartAutoDetectTimer();
    }
    this.cdr.markForCheck();
  }

  get autoDetectBestHit(): AutoDetectHit | null {
    return this.autoDetectHits.length ? this.autoDetectHits[0] : null;
  }

  get autoDetectOtherHits(): AutoDetectHit[] {
    return this.autoDetectHits.length > 1 ? this.autoDetectHits.slice(1) : [];
  }

  trackAutoDetectHit(_index: number, hit: AutoDetectHit): string {
    return hit.kind + ':' + hit.id;
  }

  get autoDetectIntervalLabel(): string {
    const ms = this.autoDetectIntervalMs;
    if (ms >= 1000) {
      const sec = ms / 1000;
      return Number.isInteger(sec) ? `${sec} s` : `${sec.toFixed(1)} s`;
    }
    return `${ms} ms`;
  }

  /** Position du point cible dans le radar (0–100 %, centre = 50). */
  autoDetectRadarXPercent(): number {
    return this.autoDetectRadarXPercentFor(this.autoDetectBestHit);
  }

  autoDetectRadarYPercent(): number {
    return this.autoDetectRadarYPercentFor(this.autoDetectBestHit);
  }

  autoDetectRadarXPercentFor(hit: AutoDetectHit | null): number {
    if (!hit) {
      return 50;
    }
    return this.autoDetectRadarXForAz(hit.azimuthDeg);
  }

  autoDetectRadarYPercentFor(hit: AutoDetectHit | null): number {
    if (!hit) {
      return 50;
    }
    return this.autoDetectRadarYForEl(hit.elevationDeg);
  }

  private autoDetectRadarXForAz(azimuthDeg: number): number {
    if (this.autoDetectLookAz == null) {
      return 50;
    }
    const dAz = this.circularDiffDeg(azimuthDeg, this.autoDetectLookAz);
    const clamped = Math.max(-AUTO_DETECT_MAX_SEP_DEG, Math.min(AUTO_DETECT_MAX_SEP_DEG, dAz));
    return 50 + (clamped / AUTO_DETECT_MAX_SEP_DEG) * 42;
  }

  private autoDetectRadarYForEl(elevationDeg: number): number {
    if (this.autoDetectLookEl == null) {
      return 50;
    }
    const dEl = elevationDeg - this.autoDetectLookEl;
    const clamped = Math.max(-AUTO_DETECT_MAX_SEP_DEG, Math.min(AUTO_DETECT_MAX_SEP_DEG, dEl));
    return 50 + (clamped / AUTO_DETECT_MAX_SEP_DEG) * 42;
  }

  get autoDetectRadarFigureStrokes(): string[] {
    if (this.autoDetectBestHit?.kind !== 'constellation') {
      return [];
    }
    return this.constellationFigureSky.map((stroke) =>
      stroke
        .map((p) => {
          const x = this.autoDetectRadarXForAz(p.az);
          const y = 100 - this.autoDetectRadarYForEl(p.el);
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(' ')
    );
  }

  get autoDetectRadarFigureDots(): Array<{ x: number; y: number }> {
    if (this.autoDetectBestHit?.kind !== 'constellation') {
      return [];
    }
    return this.constellationMemberSky.map((m) => ({
      x: this.autoDetectRadarXForAz(m.az),
      y: 100 - this.autoDetectRadarYForEl(m.el)
    }));
  }

  autoDetectKindLabelKey(kind: AutoDetectHit['kind']): string {
    if (kind === 'planet') {
      return 'ASTRO_COMPASS.KIND_PLANET';
    }
    if (kind === 'star') {
      return 'ASTRO_COMPASS.KIND_STAR';
    }
    if (kind === 'constellation') {
      return 'ASTRO_COMPASS.KIND_CONSTELLATION';
    }
    if (kind === 'galaxy') {
      return 'ASTRO_COMPASS.KIND_GALAXY';
    }
    return 'ASTRO_COMPASS.KIND_SATELLITE';
  }

  private restartAutoDetectTimer(): void {
    this.stopAutoDetectTimerOnly();
    const ms = this.autoDetectIntervalMs;
    this.zone.runOutsideAngular(() => {
      this.autoDetectTimer = setInterval(() => {
        this.zone.run(() => this.runAutoDetectPass(false));
      }, ms);
    });
  }

  /** Figé le dernier astre vu en auto-détection comme cible du viseur. */
  private commitAutoDetectSelection(): void {
    const hit = this.autoDetectBestHit;
    if (!hit) {
      return;
    }
    this.userChoseTarget = true;
    this.persistUserTarget = true;
    if (!this.isAutoDetectSelected(hit)) {
      this.applyAutoDetectHit(hit);
    } else {
      this.persistLastTarget();
    }
    this.onStarQueryChange();
    this.onGalaxyQueryChange();
    this.refreshVisibleSkyNow(false);
  }

  private stopAutoDetectLive(): void {
    this.commitAutoDetectSelection();
    if (this.isAutoDetectFullscreen) {
      void this.exitAnyFullscreen();
    }
    this.isAutoDetectFullscreen = false;
    this.unbindLiveModalZoomGestures();
    this.autoDetectLive = false;
    this.autoDetectBusy = false;
    this.autoDetectPaused = false;
    this.syncCameraFreeze();
    this.autoDetectSettingsOpen = false;
    this.autoDetectModalOpen = false;
    this.stopAutoDetectTimerOnly();
    this.cdr.markForCheck();
  }

  private stopAutoDetectTimerOnly(): void {
    if (this.autoDetectTimer != null) {
      clearInterval(this.autoDetectTimer);
      this.autoDetectTimer = null;
    }
  }

  private runAutoDetectPass(forceSelect: boolean): void {
    if ((this.autoDetectPaused || this.finderPoseFrozen) && !forceSelect) {
      return;
    }
    if (!this.autoDetectLive && !forceSelect) {
      return;
    }
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_LOCATION';
      this.autoDetectBusy = false;
      return;
    }
    if (!this.headingActive || this.headingDeg == null) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_HEADING';
      this.autoDetectBusy = false;
      return;
    }
    if (this.devicePitchDeg == null) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_PITCH';
      this.autoDetectBusy = false;
      return;
    }

    const lookAz = this.headingDeg;
    const lookEl = this.deviceSkyElevationDeg();
    if (lookEl == null) {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NEED_PITCH';
      this.autoDetectBusy = false;
      return;
    }
    const now = Date.now();

    try {
      if (!this.autoDetectCache.length || now - this.autoDetectCacheAtMs > AUTO_DETECT_CACHE_MS) {
        this.autoDetectCache = this.buildSkyDirectionCache();
        this.autoDetectCacheAtMs = now;
      }

      const hits = this.rankCachedSkyHits(lookAz, lookEl);
      this.autoDetectHits = hits;
      this.autoDetectLookAz = lookAz;
      this.autoDetectLookEl = lookEl;
      this.autoDetectAtMs = now;
      this.autoDetectBusy = false;

      if (!hits.length) {
        this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_NONE';
        this.autoDetectLastAppliedKey = null;
      } else {
        this.autoDetectErrorKey = null;
        const best = hits[0];
        const key = best.kind + ':' + best.id;
        if (forceSelect || key !== this.autoDetectLastAppliedKey) {
          this.autoDetectLastAppliedKey = key;
          this.persistUserTarget = false;
          try {
            this.applyAutoDetectHit(best);
          } finally {
            this.persistUserTarget = true;
          }
        }
      }
    } catch {
      this.autoDetectErrorKey = 'ASTRO_COMPASS.AUTO_ERROR';
      this.autoDetectHits = [];
      this.autoDetectBusy = false;
    }
    this.cdr.markForCheck();
  }

  applyAutoDetectHit(hit: AutoDetectHit): void {
    const key = hit.kind + ':' + hit.id;
    if (this.isAutoDetectSelected(hit)) {
      this.autoDetectLastAppliedKey = key;
      if (this.autoDetectPaused) {
        this.loadObjectDossier();
      }
      return;
    }
    this.autoDetectLastAppliedKey = key;
    if (hit.kind === 'planet') {
      this.selectPlanet(hit.id);
    } else if (hit.kind === 'star') {
      const star = findStarById(hit.id);
      if (star) {
        this.selectStar(star);
      }
    } else if (hit.kind === 'galaxy') {
      const galaxy = findGalaxyById(hit.id);
      if (galaxy) {
        this.selectGalaxy(galaxy);
      }
    } else if (hit.kind === 'constellation') {
      const item = findConstellationById(hit.id);
      if (item) {
        this.selectConstellation(item);
      }
    } else if (hit.kind === 'iss') {
      this.selectSatellite(hit.id);
    }
    if (this.autoDetectPaused) {
      this.loadObjectDossier();
    }
  }

  clearAutoDetect(): void {
    this.stopAutoDetectLive();
    this.autoDetectHits = [];
    this.autoDetectErrorKey = null;
    this.autoDetectLookAz = null;
    this.autoDetectLookEl = null;
    this.autoDetectAtMs = null;
    this.autoDetectCache = [];
    this.autoDetectCacheAtMs = 0;
    this.autoDetectLastAppliedKey = null;
    this.clearObjectDossier();
    this.cdr.markForCheck();
  }

  private scrollAutoDetectIntoView(): void {
    setTimeout(() => {
      try {
        document.getElementById('acAutoDetectPanel')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest'
        });
      } catch {
        /* ignore */
      }
    }, 80);
  }

  isAutoDetectSelected(hit: AutoDetectHit): boolean {
    if (hit.kind === 'planet') {
      return this.selectedKind === 'planet' && this.selectedPlanetId === hit.id;
    }
    if (hit.kind === 'star') {
      return this.selectedKind === 'star' && this.selectedStarId === hit.id;
    }
    if (hit.kind === 'galaxy') {
      return this.selectedKind === 'galaxy' && this.selectedGalaxyId === hit.id;
    }
    if (hit.kind === 'constellation') {
      return this.selectedKind === 'constellation' && this.selectedConstellationId === hit.id;
    }
    return this.selectedKind === 'iss' && this.selectedSatelliteId === hit.id;
  }

  private rankCachedSkyHits(lookAz: number, lookEl: number): AutoDetectHit[] {
    const hits: AutoDetectHit[] = [];
    for (const item of this.autoDetectCache) {
      const separationDeg = AstroCompassComponent.angularSeparationDeg(
        lookAz,
        lookEl,
        item.azimuthDeg,
        item.elevationDeg
      );
      if (separationDeg > AUTO_DETECT_MAX_SEP_DEG) {
        continue;
      }
      hits.push({
        ...item,
        separationDeg: item.kind === 'constellation' ? separationDeg + 3 : separationDeg
      });
    }
    this.injectContainingConstellationHit(hits, lookAz, lookEl);
    hits.sort((a, b) => {
      if (a.separationDeg !== b.separationDeg) {
        return a.separationDeg - b.separationDeg;
      }
      const ma = a.mag ?? 99;
      const mb = b.mag ?? 99;
      return ma - mb;
    });
    return hits.slice(0, AUTO_DETECT_TOP_N);
  }

  /** Positions az/él du catalogue (rafraîchies toutes les ~2.5 s en live). */
  private buildSkyDirectionCache(): Array<Omit<AutoDetectHit, 'separationDeg'>> {
    const date = new Date();
    const observer = new Observer(this.lat, this.lon, this.height);
    const cache: Array<Omit<AutoDetectHit, 'separationDeg'>> = [];

    if (this.autoDetectIncludePlanets) {
    for (const planet of ASTRO_PLANETS) {
      try {
        const eq = Equator(planet.body, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        if (hor.altitude < -2) {
          continue;
        }
        let mag: number | null = null;
        try {
          mag = Illumination(planet.body, date).mag;
        } catch {
          mag = null;
        }
        if (!this.passesMaxMagnitude(mag)) {
          continue;
        }
        cache.push({
          kind: 'planet',
          id: planet.id,
          name: this.translate.instant(planet.labelKey),
          iconClass: planet.iconClass,
          color: planet.color,
          azimuthDeg: hor.azimuth,
          elevationDeg: hor.altitude,
          mag
        });
      } catch {
        /* ignore planet */
      }
    }
    }

    if (this.autoDetectIncludeStars) {
    for (const star of ASTRO_BRIGHT_STARS) {
      if (this.autoDetectNakedEye && !AstroCompassComponent.isNakedEyeAtNight(star.mag)) {
        continue;
      }
      if (!this.passesMaxMagnitude(star.mag)) {
        continue;
      }
      try {
        DefineStar(Body.Star1, star.raHours, star.decDeg, Math.max(1, star.distLy));
        const eq = Equator(Body.Star1, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        if (hor.altitude < -2) {
          continue;
        }
        cache.push({
          kind: 'star',
          id: star.id,
          name: star.name,
          iconClass: star.iconClass,
          color: star.color,
          azimuthDeg: hor.azimuth,
          elevationDeg: hor.altitude,
          mag: star.mag
        });
      } catch {
        /* ignore star */
      }
    }
    }

    if (this.autoDetectIncludeGalaxies) {
    for (const galaxy of ASTRO_GALAXIES) {
      if (this.autoDetectNakedEye && !AstroCompassComponent.isNakedEyeAtNight(galaxy.mag)) {
        continue;
      }
      if (!this.passesMaxMagnitude(galaxy.mag)) {
        continue;
      }
      try {
        DefineStar(Body.Star1, galaxy.raHours, galaxy.decDeg, Math.max(1, galaxy.distLy));
        const eq = Equator(Body.Star1, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        if (hor.altitude < -2) {
          continue;
        }
        cache.push({
          kind: 'galaxy',
          id: galaxy.id,
          name: galaxy.name,
          iconClass: galaxy.iconClass,
          color: galaxy.color,
          azimuthDeg: hor.azimuth,
          elevationDeg: hor.altitude,
          mag: galaxy.mag
        });
      } catch {
        /* ignore galaxy */
      }
    }
    }

    if (this.autoDetectIncludeConstellations) {
      for (const item of ASTRO_CONSTELLATIONS) {
        if (this.autoDetectNakedEye && !AstroCompassComponent.isNakedEyeAtNight(item.mag)) {
          continue;
        }
        if (!this.passesMaxMagnitude(item.mag)) {
          continue;
        }
        const pt = this.skyPointFromRaDec(date, observer, item.raHours, item.decDeg, 100);
        if (!pt || pt.el < -2) {
          continue;
        }
        cache.push({
          kind: 'constellation',
          id: item.id,
          name: this.constellationDisplayName(item),
          iconClass: item.iconClass,
          color: item.color,
          azimuthDeg: pt.az,
          elevationDeg: pt.el,
          mag: item.mag
        });
      }
    }

    if (this.autoDetectIncludeIss) {
      const now = Date.now();
      for (const sat of ASTRO_SATELLITES) {
        let snapLat: number | null = null;
        let snapLon: number | null = null;
        let altKm = sat.defaultAltKm;
        if (sat.useIssLiveFeed) {
          const snap = this.issNow.snapshotForDisplay(now);
          if (!snap) {
            continue;
          }
          snapLat = snap.lat;
          snapLon = snap.lon;
          if (snap.altKm != null && snap.altKm > 0) {
            altKm = snap.altKm;
          }
        } else if (sat.skipLiveTle && !sat.sunEarthL2) {
          continue;
        } else {
          this.satNow.setObserver(this.lat, this.lon);
          const snap = this.satNow.snapshotForOption(sat, now);
          if (!snap) {
            void this.satNow.ensureOption(sat, false);
            continue;
          }
          snapLat = snap.lat;
          snapLon = snap.lon;
          if (snap.altKm != null && snap.altKm > 0) {
            altKm = snap.altKm;
          }
        }
        if (
          !Number.isFinite(this.lat) ||
          !Number.isFinite(this.lon) ||
          snapLat == null ||
          snapLon == null
        ) {
          continue;
        }
        const groundKm = AstroCompassComponent.haversineGreatCircleKm(
          this.lat,
          this.lon,
          snapLat,
          snapLon
        );
        const elevDeg =
          (AstroCompassComponent.satelliteElevationRad(groundKm / EARTH_RADIUS_KM, altKm) * 180) /
          Math.PI;
        if (elevDeg >= -2) {
          const az = AstroCompassComponent.initialBearingDeg(this.lat, this.lon, snapLat, snapLon);
          cache.push({
            kind: 'iss',
            id: sat.id,
            name: this.translate.instant(sat.labelKey),
            iconClass: sat.iconClass,
            color: sat.color,
            azimuthDeg: az,
            elevationDeg: elevDeg,
            mag: null
          });
        }
      }
    }

    return cache;
  }

  /**
   * Ajoute la constellation qui contient la visée, même si son centre est loin.
   * Les astres plus proches que ~7° restent prioritaires.
   */
  private injectContainingConstellationHit(
    hits: AutoDetectHit[],
    lookAz: number,
    lookEl: number
  ): void {
    if (!this.autoDetectIncludeConstellations || lookEl < -2) {
      return;
    }
    const item = this.constellationContainingLook(lookAz, lookEl, new Date());
    if (!item) {
      return;
    }
    if (this.autoDetectNakedEye && !AstroCompassComponent.isNakedEyeAtNight(item.mag)) {
      return;
    }
    if (!this.passesMaxMagnitude(item.mag)) {
      return;
    }
    const existing = hits.find((h) => h.kind === 'constellation' && h.id === item.id);
    if (existing) {
      if (existing.separationDeg > AUTO_DETECT_CONSTELLATION_REGION_SEP_DEG) {
        existing.separationDeg = AUTO_DETECT_CONSTELLATION_REGION_SEP_DEG;
        existing.fromRegion = true;
      }
      return;
    }
    const cached = this.autoDetectCache.find((h) => h.kind === 'constellation' && h.id === item.id);
    const az = cached?.azimuthDeg ?? lookAz;
    const el = cached?.elevationDeg ?? lookEl;
    hits.push({
      kind: 'constellation',
      id: item.id,
      name: this.constellationDisplayName(item),
      iconClass: item.iconClass,
      color: item.color,
      azimuthDeg: az,
      elevationDeg: el,
      mag: item.mag,
      separationDeg: AUTO_DETECT_CONSTELLATION_REGION_SEP_DEG,
      fromRegion: true
    });
  }

  private constellationContainingLook(
    lookAz: number,
    lookEl: number,
    date: Date
  ): AstroConstellationOption | undefined {
    const eq = this.horizonToEquatorial(lookAz, lookEl, date);
    if (!eq) {
      return undefined;
    }
    try {
      const info = Constellation(eq.raHours, eq.decDeg);
      const symbol = (info.symbol || '').trim().toLowerCase();
      if (!symbol) {
        return undefined;
      }
      return ASTRO_CONSTELLATIONS.find(
        (c) => c.iau.toLowerCase() === symbol || c.id === symbol
      );
    } catch {
      return undefined;
    }
  }

  /** Azimut / élévation (Nord → Est) vers RA/Dec apparents. */
  private horizonToEquatorial(
    azDeg: number,
    elDeg: number,
    date: Date
  ): { raHours: number; decDeg: number } | null {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return null;
    }
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const lat = (this.lat * Math.PI) / 180;
    const sinEl = Math.sin(el);
    const cosEl = Math.cos(el);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinDec = sinLat * sinEl + cosLat * cosEl * Math.cos(az);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const cosDec = Math.max(1e-8, Math.cos(dec));
    const sinH = (-Math.sin(az) * cosEl) / cosDec;
    const cosH = (sinEl - sinLat * Math.sin(dec)) / Math.max(1e-8, cosLat * cosDec);
    const haHours = (Math.atan2(sinH, cosH) * 12) / Math.PI;
    let gast: number;
    try {
      gast = SiderealTime(date);
    } catch {
      return null;
    }
    const last = gast + this.lon / 15;
    const raHours = ((last - haHours) % 24 + 24) % 24;
    return { raHours, decDeg: (dec * 180) / Math.PI };
  }

  private static angularSeparationDeg(
    az1Deg: number,
    el1Deg: number,
    az2Deg: number,
    el2Deg: number
  ): number {
    const dAz = ((az2Deg - az1Deg) * Math.PI) / 180;
    const e1 = (el1Deg * Math.PI) / 180;
    const e2 = (el2Deg * Math.PI) / 180;
    const cosC = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(dAz);
    return (Math.acos(Math.max(-1, Math.min(1, cosC))) * 180) / Math.PI;
  }

  onGalaxySelectChange(id: string): void {
    const galaxyId = (id || '').trim();
    if (!galaxyId) {
      if (this.selectedKind === 'galaxy') {
        this.selectedGalaxyId = undefined;
        this.selectFallbackVisibleTarget();
      }
      this.cdr.markForCheck();
      return;
    }
    const galaxy = findGalaxyById(galaxyId) || this.galaxyResults.find((g) => g.id === galaxyId);
    if (galaxy) {
      this.selectGalaxy(galaxy);
    }
  }

  onStarSelectChange(id: string): void {
    const starId = (id || '').trim();
    if (!starId) {
      if (this.selectedKind === 'star') {
        this.selectedStarId = undefined;
        this.selectFallbackVisibleTarget();
      }
      this.cdr.markForCheck();
      return;
    }
    const star = findStarById(starId) || this.starResults.find((s) => s.id === starId);
    if (star) {
      this.selectStar(star);
    }
  }

  onStarQueryChange(): void {
    const base = findStarsByQuery(this.starQuery);
    let list = this.visibleOnly
      ? base.filter((s) => this.visibleStarIds.has(s.id))
      : base;
    list = list.filter((s) => this.passesMaxMagnitude(s.mag));
    // Garder la sélection courante dans la liste (revisit viseur / filtre visibles).
    if (
      this.selectedKind === 'star' &&
      this.selectedStarId &&
      !list.some((s) => s.id === this.selectedStarId)
    ) {
      const current = findStarById(this.selectedStarId);
      if (current) {
        list = [...list, current];
      }
    }
    this.starResults = this.sortCatalogByLabel(list, (s) => s.name);
    this.cdr.markForCheck();
  }

  onGalaxyQueryChange(): void {
    const base = findGalaxiesByQuery(this.galaxyQuery);
    let list = this.visibleOnly
      ? base.filter((g) => this.visibleGalaxyIds.has(g.id))
      : base;
    // Les galaxies du catalogue sont presque toutes plus faibles que l’œil nu :
    // le curseur de magnitude (fait pour les étoiles) ne les masque pas.
    if (
      this.selectedKind === 'galaxy' &&
      this.selectedGalaxyId &&
      !list.some((g) => g.id === this.selectedGalaxyId)
    ) {
      const current = findGalaxyById(this.selectedGalaxyId);
      if (current) {
        list = [...list, current];
      }
    }
    this.galaxyResults = this.sortCatalogByLabel(list, (g) => g.name);
    this.cdr.markForCheck();
  }

  onConstellationSelectChange(id: string): void {
    const constellationId = (id || '').trim();
    if (!constellationId) {
      if (this.selectedKind === 'constellation') {
        this.selectedConstellationId = undefined;
        this.selectFallbackVisibleTarget();
      }
      this.cdr.markForCheck();
      return;
    }
    const item =
      findConstellationById(constellationId) ||
      this.constellationResults.find((c) => c.id === constellationId);
    if (item) {
      this.selectConstellation(item);
    }
  }

  onConstellationQueryChange(): void {
    const base = findConstellationsByQuery(
      this.constellationQuery,
      this.translate.currentLang || 'fr'
    );
    let list = this.visibleOnly
      ? base.filter((c) => this.visibleConstellationIds.has(c.id))
      : base;
    // Une constellation est une région du ciel, pas une étoile : on ne la masque pas
    // avec le curseur de magnitude (qui sert aux étoiles individuelles).
    if (
      this.selectedKind === 'constellation' &&
      this.selectedConstellationId &&
      !list.some((c) => c.id === this.selectedConstellationId)
    ) {
      const current = findConstellationById(this.selectedConstellationId);
      if (current) {
        list = [...list, current];
      }
    }
    this.constellationResults = this.sortCatalogByLabel(list, (c) => this.constellationDisplayName(c));
    this.cdr.markForCheck();
  }

  onVisibleOnlyChange(): void {
    this.persistVisibleOnlyPref();
    if (this.visibleOnly) {
      void this.issNow.refresh(false);
      this.refreshVisibleCatalog();
      this.ensureSelectionStillVisible();
    } else {
      this.onStarQueryChange();
      this.onGalaxyQueryChange();
      this.onConstellationQueryChange();
    }
    this.cdr.markForCheck();
  }

  /** Recalcule tout de suite les cibles au-dessus de l’horizon (ISS comprise). */
  refreshVisibleTargets(): void {
    if (this.visibleRefreshing) {
      return;
    }
    this.visibleRefreshing = true;
    this.refreshVisibleSkyNow(false);
    if (this.visibleOnly) {
      this.ensureSelectionStillVisible();
    }
    this.cdr.markForCheck();
    void this.issNow.refresh(false).then(() => {
      this.refreshVisibleCatalog();
      if (this.visibleOnly) {
        this.ensureSelectionStillVisible();
      }
    }).finally(() => {
      this.visibleRefreshing = false;
      this.cdr.markForCheck();
    });
  }

  /** Si la cible courante n'est plus au-dessus de l'horizon, bascule vers une cible visible. */
  private ensureSelectionStillVisible(): void {
    if (this.selectedKind === 'custom') {
      this.selectFallbackVisibleTarget();
      return;
    }
    if (this.selectedKind === 'iss' && !this.isSatelliteChipVisible(this.selectedSatelliteId)) {
      this.selectFallbackVisibleTarget();
      return;
    }
    if (this.selectedKind === 'planet' && !this.visiblePlanetIds.has(this.selectedPlanetId)) {
      this.selectFallbackVisibleTarget();
      return;
    }
    if (this.selectedKind === 'star' && (!this.selectedStarId || !this.visibleStarIds.has(this.selectedStarId))) {
      this.selectFallbackVisibleTarget();
      return;
    }
    if (this.selectedKind === 'galaxy' && (!this.selectedGalaxyId || !this.visibleGalaxyIds.has(this.selectedGalaxyId))) {
      this.selectFallbackVisibleTarget();
      return;
    }
    if (
      this.selectedKind === 'constellation' &&
      (!this.selectedConstellationId || !this.visibleConstellationIds.has(this.selectedConstellationId))
    ) {
      this.selectFallbackVisibleTarget();
    }
  }

  private noteUserTargetChoice(): void {
    if (!this.applyingAutoTarget) {
      this.userChoseTarget = true;
      if (this.finderPoseFrozen) {
        this.clearFinderPose(false);
      }
    }
  }

  /** Au démarrage : ISS si visible, sinon un astre au-dessus de l'horizon. */
  private selectDefaultVisibleTarget(): void {
    if (this.userChoseTarget) {
      return;
    }
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.applyingAutoTarget = true;
    try {
      this.applyBestVisibleTarget();
    } finally {
      this.applyingAutoTarget = false;
    }
  }

  /** Bascule sur un satellite / planète / étoile / galaxie visible. */
  private selectFallbackVisibleTarget(): void {
    this.applyingAutoTarget = true;
    try {
      this.applyBestVisibleTarget();
    } finally {
      this.applyingAutoTarget = false;
    }
  }

  private static readonly DEFAULT_VISIBLE_PLANETS = [
    'moon',
    'venus',
    'jupiter',
    'saturn',
    'mars',
    'mercury',
    'sun',
    'uranus',
    'neptune',
    'pluto'
  ] as const;

  private applyBestVisibleTarget(): void {
    if (this.visibleSatelliteIds.has('iss')) {
      if (!(this.selectedKind === 'iss' && this.selectedSatelliteId === 'iss')) {
        this.selectSatellite('iss');
      }
      return;
    }
    for (const id of AstroCompassComponent.DEFAULT_VISIBLE_PLANETS) {
      if (this.visiblePlanetIds.has(id)) {
        if (!(this.selectedKind === 'planet' && this.selectedPlanetId === id)) {
          this.selectPlanet(id);
        }
        return;
      }
    }
    const star = ASTRO_BRIGHT_STARS.find((s) => this.visibleStarIds.has(s.id));
    if (star) {
      if (!(this.selectedKind === 'star' && this.selectedStarId === star.id)) {
        this.selectStar(star);
      }
      return;
    }
    const galaxy = ASTRO_GALAXIES.find((g) => this.visibleGalaxyIds.has(g.id));
    if (galaxy) {
      if (!(this.selectedKind === 'galaxy' && this.selectedGalaxyId === galaxy.id)) {
        this.selectGalaxy(galaxy);
      }
      return;
    }
    const constellation = ASTRO_CONSTELLATIONS.find((c) => this.visibleConstellationIds.has(c.id));
    if (constellation) {
      if (!(this.selectedKind === 'constellation' && this.selectedConstellationId === constellation.id)) {
        this.selectConstellation(constellation);
      }
      return;
    }
    const sat = ASTRO_SATELLITES.find((s) => s.id !== 'iss' && this.visibleSatelliteIds.has(s.id));
    if (sat && !(this.selectedKind === 'iss' && this.selectedSatelliteId === sat.id)) {
      this.selectSatellite(sat.id);
    }
  }

  get displayedPlanets(): ReadonlyArray<AstroBodyOption> {
    let list: AstroBodyOption[];
    if (!this.visibleOnly) {
      list = [...this.planets];
    } else {
      list = this.planets.filter((p) => this.visiblePlanetIds.has(p.id));
      if (this.selectedKind === 'planet') {
        const cur = this.planets.find((p) => p.id === this.selectedPlanetId);
        if (cur && !list.some((p) => p.id === cur.id)) {
          list = [...list, cur];
        }
      }
    }
    return this.sortByTranslatedLabel(list);
  }

  get displayedSatellites(): ReadonlyArray<AstroSatelliteOption> {
    let list: AstroSatelliteOption[];
    if (!this.visibleOnly) {
      list = [...this.satellites];
    } else {
      list = this.satellites.filter((s) => this.visibleSatelliteIds.has(s.id));
      if (this.selectedKind === 'iss') {
        const cur = this.satellites.find((s) => s.id === this.selectedSatelliteId);
        if (cur && !list.some((s) => s.id === cur.id)) {
          list = [...list, cur];
        }
      }
    }
    return this.sortByTranslatedLabel(list);
  }

  catalogSkyDir(kind: CatalogSkyKind, id: string | undefined): CatalogSkyDir | null {
    if (!id) {
      return null;
    }
    return this.catalogSkyDirs[kind].get(id) ?? null;
  }

  private catalogLocale(): string {
    return this.translate.currentLang || 'fr';
  }

  private sortCatalogByLabel<T>(items: readonly T[], labelOf: (item: T) => string): T[] {
    const locale = this.catalogLocale();
    return [...items].sort((a, b) =>
      labelOf(a).localeCompare(labelOf(b), locale, { sensitivity: 'base', numeric: true }));
  }

  private sortByTranslatedLabel<T extends { labelKey: string }>(items: readonly T[]): T[] {
    return this.sortCatalogByLabel(items, (item) => this.translate.instant(item.labelKey));
  }

  /** Filtre « visibles seulement » : pas de titre / chips / switch s’il n’y a rien à choisir. */
  get showSatelliteSection(): boolean {
    return !this.visibleOnly || this.displayedSatellites.length > 0;
  }

  get showPlanetSection(): boolean {
    return !this.visibleOnly || this.displayedPlanets.length > 0;
  }

  get showAutoDetectSatelliteFilter(): boolean {
    return this.visibleSatelliteIds.size > 0;
  }

  get showAutoDetectPlanetFilter(): boolean {
    return this.visiblePlanetIds.size > 0;
  }

  get showAutoDetectStarFilter(): boolean {
    return this.visibleStarIds.size > 0;
  }

  get showAutoDetectGalaxyFilter(): boolean {
    return this.visibleGalaxyIds.size > 0;
  }

  get showAutoDetectConstellationFilter(): boolean {
    return true;
  }

  get showAutoDetectNakedEyeFilter(): boolean {
    return (
      this.showAutoDetectStarFilter ||
      this.showAutoDetectGalaxyFilter ||
      this.showAutoDetectConstellationFilter
    );
  }

  get nakedEyeMarkPercent(): number {
    const span = this.maxMagnitudeMax - this.maxMagnitudeMin;
    if (span <= 0) {
      return 0;
    }
    return ((this.nakedEyeMagnitude - this.maxMagnitudeMin) / span) * 100;
  }

  private static isNakedEyeAtNight(mag: number | null | undefined): boolean {
    return mag != null && Number.isFinite(mag) && mag <= AstroCompassComponent.NAKED_EYE_MAGNITUDE;
  }

  /** @deprecated Prefer {@link displayedSatellites}. */
  get showIssChip(): boolean {
    return this.displayedSatellites.length > 0;
  }

  isSatelliteChipVisible(id: string): boolean {
    return this.displayedSatellites.some((s) => s.id === id);
  }

  applyCustomCoords(): void {
    if (!Number.isFinite(this.customRaHours) || !Number.isFinite(this.customDecDeg)) {
      return;
    }
    if (this.customRaHours < 0 || this.customRaHours >= 24) {
      return;
    }
    if (this.customDecDeg < -90 || this.customDecDeg > 90) {
      return;
    }
    this.noteUserTargetChoice();
    this.selectedKind = 'custom';
    this.selectedStarId = undefined;
    this.selectedGalaxyId = undefined;
    this.selectedConstellationId = undefined;
    this.bodyIconClass = 'fa fa-star';
    this.bodyColor = '#a8cfff';
    this.bodyLabel = this.customName.trim() || this.translate.instant('ASTRO_COMPASS.CUSTOM_TARGET');
    this.syncTargetAccordionFromSelection();
    this.recomputeSky();
    this.maybeReloadObjectDossier();
    this.persistLastTarget();
    this.cdr.markForCheck();
  }

  /** Appelé quand l'utilisateur édite lat/lon manuellement. */
  onManualCoordsChange(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.userSource = 'manual';
    this.geoStatus = 'ready';
    this.userAccuracyM = null;
    this.applyObserverPosition(
      this.lat,
      this.lon,
      this.height,
      this.placeLabel || undefined,
      true,
      !this.heightUserLocked
    );
  }

  /** Altitude saisie à la main — ne pas la remplacer par le DEM. */
  onHeightChange(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.heightUserLocked = true;
    this.userSource = this.userSource ?? 'manual';
    this.geoStatus = 'ready';
    this.applyObserverPosition(
      this.lat,
      this.lon,
      this.height,
      this.placeLabel || undefined,
      false,
      false
    );
  }

  searchAddressByQuery(): void {
    (document.activeElement as HTMLElement)?.blur?.();
    const query = this.addressQuery?.trim();
    if (!query) {
      this.addressSearchError = 'ASTRO_COMPASS.ADDRESS_REQUIRED';
      this.addressResults = [];
      return;
    }
    this.addressSearchError = '';
    this.loadingAddressSearch = true;
    this.addressResults = [];
    this.addressSearchSub?.unsubscribe();
    this.addressSearchSub = this.api.geocodeSearch(query).subscribe({
      next: (data: any[]) => {
        this.addressResults = (data || [])
          .map((item: any) => ({
            lat: typeof item.lat === 'number' ? item.lat : parseFloat(item.lat) || 0,
            lon: typeof item.lon === 'number' ? item.lon : parseFloat(item.lon) || 0,
            displayName: String(item.displayName || item.display_name || '').trim()
          }))
          .filter(
            (r) =>
              Number.isFinite(r.lat) &&
              Number.isFinite(r.lon) &&
              r.lat >= -90 &&
              r.lat <= 90 &&
              r.lon >= -180 &&
              r.lon <= 180
          );
        this.loadingAddressSearch = false;
        if (this.addressResults.length === 0) {
          this.addressSearchError = 'ASTRO_COMPASS.ADDRESS_NO_RESULTS';
        } else if (this.addressResults.length === 1) {
          this.selectAddressResult(this.addressResults[0]);
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.addressResults = [];
        this.loadingAddressSearch = false;
        this.addressSearchError = 'ASTRO_COMPASS.ADDRESS_ERROR';
        this.cdr.markForCheck();
      }
    });
  }

  selectAddressResult(result: AddressSearchResult): void {
    if (!result) {
      return;
    }
    this.userSource = 'address';
    this.heightUserLocked = false;
    this.addressQuery = result.displayName || this.addressQuery;
    this.addressResults = [];
    this.addressSearchError = '';
    this.applyObserverPosition(result.lat, result.lon, this.height, result.displayName, true, true);
  }

  openTraceViewerForSelection(): void {
    if (!this.traceViewerModalComponent || !Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    this.tracePickMode = 'observer';
    const label = this.placeLabel || `${this.lat.toFixed(5)}, ${this.lon.toFixed(5)}`;
    this.traceViewerModalComponent.openAtLocation(this.lat, this.lon, label, undefined, true, true);
  }

  openTraceViewerForCibleMark(): void {
    if (!this.traceViewerModalComponent || !this.activeCible) {
      return;
    }
    this.tracePickMode = 'mark';
    const c = this.activeCible;
    const lat = c.markLat ?? this.lat;
    const lon = c.markLon ?? this.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }
    this.traceViewerModalComponent.openAtLocation(lat, lon, c.name, undefined, true, true);
  }

  recalerCibleFromHere(): void {
    const c = this.activeCible;
    const id = c?.id;
    const raw = this.lookTracker?.rawAzimuthDeg ?? this.headingRawDeg;
    if (!id || raw == null || !Number.isFinite(raw)) {
      this.cibleError = 'DIRECTION.TARGET_NEED_SENSORS';
      this.cdr.markForCheck();
      return;
    }
    const ref = this.cibleMarkBearingDeg() ?? c?.refAzimuthDeg ?? this.headingDeg ?? raw;
    this.cibleSaving = true;
    this.cibleError = null;
    this.api
      .recalibrateDirectionCible(id, {
        name: c?.name,
        userLat: this.lat,
        userLon: this.lon,
        phoneHeadingDeg: raw,
        refAzimuthDeg: ref,
        phoneElevationDeg: this.lookTracker?.elevationDeg ?? null,
        markLat: c?.markLat,
        markLon: c?.markLon,
        markAltM: c?.markAltM,
        markAddress: c?.markAddress
      })
      .subscribe({
        next: (saved) => {
          this.cibleSaving = false;
          this.activeCible = saved;
          if (saved.id) {
            saveActiveCibleId(saved.id);
          }
          this.applyHeadingReference();
          this.updateFinderProjection();
          this.resolveCibleUserAddress();
          this.cdr.markForCheck();
        },
        error: () => {
          this.cibleSaving = false;
          this.cibleError = 'DIRECTION.TARGET_SAVE_FAIL';
          this.cdr.markForCheck();
        }
      });
  }

  private resolveCibleUserAddress(): void {
    const c = this.activeCible;
    const lat = c?.userLat;
    const lon = c?.userLon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      this.cibleUserAddress = null;
      this.lastCibleUserAddrKey = '';
      return;
    }
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (key === this.lastCibleUserAddrKey && this.cibleUserAddress) {
      return;
    }
    this.lastCibleUserAddrKey = key;
    this.cibleUserAddressBusy = true;
    this.userAddressSub?.unsubscribe();
    this.userAddressSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res) => {
        this.cibleUserAddress = geocodeDisplayName(res);
        this.cibleUserAddressBusy = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.cibleUserAddressBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  private onCibleMarkSelected(location: { lat: number; lng: number; alt?: number | null }): void {
    const c = this.activeCible;
    const id = c?.id;
    if (!id || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
      return;
    }
    this.cibleSaving = true;
    this.cibleError = null;
    this.markAddressBusy = true;
    this.markAddressSub?.unsubscribe();
    this.markAddressSub = this.api.geocodeReverse(location.lat, location.lng).subscribe({
      next: (res) => {
        this.saveCibleMarkLocation(
          id,
          location,
          geocodeDisplayName(res),
          c?.name || 'cible'
        );
      },
      error: () => {
        this.saveCibleMarkLocation(id, location, null, c?.name || 'cible');
      }
    });
  }

  private saveCibleMarkLocation(
    id: string,
    location: { lat: number; lng: number; alt?: number | null },
    address: string | null,
    name: string
  ): void {
    this.api
      .updateDirectionCible(id, {
        name,
        markLat: location.lat,
        markLon: location.lng,
        markAltM: location.alt != null && Number.isFinite(location.alt) ? location.alt : null,
        markAddress: address
      })
      .subscribe({
        next: (saved) => {
          this.cibleSaving = false;
          this.markAddressBusy = false;
          this.activeCible = saved;
          this.applyHeadingReference();
          this.cdr.markForCheck();
        },
        error: () => {
          this.cibleSaving = false;
          this.markAddressBusy = false;
          this.cibleError = 'DIRECTION.TARGET_SAVE_FAIL';
          this.cdr.markForCheck();
        }
      });
  }

  private fillMissingCibleMarkAddress(): void {
    const c = this.activeCible;
    const id = c?.id;
    if (!id || !hasCibleMark(c?.markLat, c?.markLon) || c?.markAddress?.trim()) {
      return;
    }
    this.markAddressBusy = true;
    this.markAddressSub?.unsubscribe();
    this.markAddressSub = this.api.geocodeReverse(c.markLat!, c.markLon!).subscribe({
      next: (res) => {
        const address = geocodeDisplayName(res);
        this.markAddressBusy = false;
        if (!address) {
          this.cdr.markForCheck();
          return;
        }
        this.api
          .updateDirectionCible(id, {
            name: c.name,
            markLat: c.markLat,
            markLon: c.markLon,
            markAltM: c.markAltM,
            markAddress: address
          })
          .subscribe({
            next: (saved) => {
              this.activeCible = saved;
              this.cdr.markForCheck();
            },
            error: () => this.cdr.markForCheck()
          });
      },
      error: () => {
        this.markAddressBusy = false;
        this.cdr.markForCheck();
      }
    });
  }

  onLocationSelected(location: { lat: number; lng: number; alt?: number | null }): void {
    if (this.tracePickMode === 'mark') {
      this.tracePickMode = 'observer';
      this.onCibleMarkSelected(location);
      return;
    }
    this.userSource = 'map';
    const hasAlt = location.alt != null && Number.isFinite(location.alt);
    if (hasAlt) {
      this.heightUserLocked = false;
    }
    const h = hasAlt ? (location.alt as number) : this.height;
    this.applyObserverPosition(location.lat, location.lng, h, undefined, true, !hasAlt);
  }

  /**
   * Applique une nouvelle position observateur et recalcule tout
   * (ciel + visibilité). Optionnellement reverse-geocode pour le libellé
   * et résolution d'altitude DEM (comme Trace Viewer).
   */
  private applyObserverPosition(
    lat: number,
    lon: number,
    height: number,
    label: string | undefined,
    reverseGeocode: boolean,
    fetchAltitude = false
  ): void {
    this.lat = lat;
    this.lon = lon;
    this.height = height;
    this.geoStatus = 'ready';
    if (label != null && label.trim()) {
      this.placeLabel = label.trim();
    }
    this.recomputeSky();
    this.cdr.markForCheck();
    if (this.selectedKind === 'iss') {
      this.refreshIssPasses(true);
    }
    this.refreshVisibleCatalog();
    this.selectDefaultVisibleTarget();
    if (reverseGeocode) {
      this.resolveAddress(lat, lon);
    }
    if (fetchAltitude && !this.heightUserLocked) {
      this.resolveObserverAltitude(lat, lon, true);
    }
  }

  /** Altitude sol via DEM (même API que Trace Viewer / getAllAltitudes). */
  private resolveObserverAltitude(lat: number, lon: number, force = false): void {
    if (this.heightUserLocked) {
      return;
    }
    const now = Date.now();
    if (!force) {
      const moved =
        this.lastAltitudeResolveLat == null ||
        this.lastAltitudeResolveLon == null ||
        Math.abs(lat - this.lastAltitudeResolveLat) > 0.01 ||
        Math.abs(lon - this.lastAltitudeResolveLon) > 0.01;
      if (!moved && now - this.lastAltitudeResolveAtMs < 60_000) {
        return;
      }
    }
    this.lastAltitudeResolveAtMs = now;
    this.lastAltitudeResolveLat = lat;
    this.lastAltitudeResolveLon = lon;
    this.altitudeSub?.unsubscribe();
    this.altitudeSub = this.api.getAllAltitudes(lat, lon, null).subscribe({
      next: (response: { altitudes?: Array<{ altitude?: number }> }) => {
        const altitude = response?.altitudes?.[0]?.altitude;
        if (typeof altitude !== 'number' || !Number.isFinite(altitude)) {
          return;
        }
        if (this.heightUserLocked) {
          return;
        }
        if (Math.abs(this.lat - lat) > 0.0005 || Math.abs(this.lon - lon) > 0.0005) {
          return;
        }
        this.height = altitude;
        this.recomputeSky();
        if (this.visibleOnly) {
          this.refreshVisibleCatalog();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        /* keep previous height */
      }
    });
  }

  private resolveAddress(lat: number, lon: number): void {
    this.lastAddressResolveAtMs = Date.now();
    this.lastAddressResolveLat = lat;
    this.lastAddressResolveLon = lon;
    this.reverseGeocodeSub?.unsubscribe();
    this.reverseGeocodeSub = this.api.geocodeReverse(lat, lon).subscribe({
      next: (res: any) => {
        const name = String(res?.display_name || res?.displayName || '').trim();
        if (name) {
          this.placeLabel = name;
          if (this.userSource === 'address' || this.userSource === 'map' || this.userSource === 'manual') {
            this.addressQuery = name;
          }
        }
        this.cdr.markForCheck();
      },
      error: () => {
        /* keep previous label */
      }
    });
  }

  /** Reverse-geocode GPS updates, throttled to avoid hammering Nominatim. */
  private maybeResolveAddressFromGps(lat: number, lon: number): void {
    const now = Date.now();
    const moved =
      this.lastAddressResolveLat == null ||
      this.lastAddressResolveLon == null ||
      Math.abs(lat - this.lastAddressResolveLat) > 0.002 ||
      Math.abs(lon - this.lastAddressResolveLon) > 0.002;
    if (!moved && now - this.lastAddressResolveAtMs < 45000) {
      return;
    }
    if (!moved && this.placeLabel) {
      return;
    }
    this.resolveAddress(lat, lon);
  }

  /* ------------------------------------------------------------------ */
  /* Astronomie : azimut, élévation, métadonnées                         */
  /* ------------------------------------------------------------------ */

  recomputeSky(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.clearSkySnapshot();
      return;
    }

    if (this.selectedKind === 'iss') {
      this.constellationMemberSky = [];
      this.constellationFigureSky = [];
      this.clearFinderConstellationOverlay();
      this.recomputeIssSky();
      return;
    }

    const date = new Date();
    const observer = new Observer(this.lat, this.lon, this.height);
    let ra: number;
    let dec: number;
    let bodyForIllum: Body | null = null;
    let isStarLike = false;

    if (this.selectedKind !== 'constellation') {
      this.constellationMemberSky = [];
      this.constellationFigureSky = [];
      this.clearConstellationSchema();
    }

    if (this.selectedKind === 'planet') {
      const planet = findPlanetById(this.selectedPlanetId);
      if (!planet) {
        this.clearSkySnapshot();
        return;
      }
      const eq = Equator(planet.body, date, observer, true, true);
      ra = eq.ra;
      dec = eq.dec;
      bodyForIllum = planet.body;
      this.distLy = null;
      this.applyBodyDisplayFromPlanet(planet);
    } else if (this.selectedKind === 'star') {
      const star = this.selectedStarId ? findStarById(this.selectedStarId) : undefined;
      if (!star) {
        this.clearSkySnapshot();
        return;
      }
      DefineStar(Body.Star1, star.raHours, star.decDeg, Math.max(1, star.distLy));
      const eq = Equator(Body.Star1, date, observer, true, true);
      ra = eq.ra;
      dec = eq.dec;
      isStarLike = true;
      this.distLy = star.distLy;
      this.applyBodyDisplayFromStar(star);
      this.mag = star.mag;
    } else if (this.selectedKind === 'galaxy') {
      const galaxy = this.selectedGalaxyId ? findGalaxyById(this.selectedGalaxyId) : undefined;
      if (!galaxy) {
        this.clearSkySnapshot();
        return;
      }
      DefineStar(Body.Star1, galaxy.raHours, galaxy.decDeg, Math.max(1, galaxy.distLy));
      const eq = Equator(Body.Star1, date, observer, true, true);
      ra = eq.ra;
      dec = eq.dec;
      isStarLike = true;
      this.distLy = galaxy.distLy;
      this.applyBodyDisplayFromGalaxy(galaxy);
      this.mag = galaxy.mag;
    } else if (this.selectedKind === 'constellation') {
      const item = this.selectedConstellationId ? findConstellationById(this.selectedConstellationId) : undefined;
      if (!item) {
        this.clearSkySnapshot();
        this.constellationMemberSky = [];
        this.constellationFigureSky = [];
        this.clearFinderConstellationOverlay();
        return;
      }
      DefineStar(Body.Star1, item.raHours, item.decDeg, 100);
      const eq = Equator(Body.Star1, date, observer, true, true);
      ra = eq.ra;
      dec = eq.dec;
      isStarLike = true;
      this.distLy = null;
      this.applyBodyDisplayFromConstellation(item);
      this.mag = item.mag;
      this.refreshConstellationMemberSky(date, observer, item);
    } else {
      if (!Number.isFinite(this.customRaHours) || !Number.isFinite(this.customDecDeg)) {
        this.clearSkySnapshot();
        return;
      }
      DefineStar(Body.Star1, this.customRaHours, this.customDecDeg, 100);
      const eq = Equator(Body.Star1, date, observer, true, true);
      ra = eq.ra;
      dec = eq.dec;
      isStarLike = true;
      this.distLy = null;
      this.bodyIconClass = 'fa fa-star';
      this.bodyColor = '#a8cfff';
      this.bodyLabel = this.customName.trim() || this.translate.instant('ASTRO_COMPASS.CUSTOM_TARGET');
      this.mag = null;
    }

    const hor = Horizon(date, observer, ra, dec, 'normal');
    this.azimuthDeg = hor.azimuth;
    this.elevationDeg = hor.altitude;
    this.raHours = ra;
    this.decDeg = dec;

    try {
      const cInfo = Constellation(ra, dec);
      this.constellationName = cInfo.name;
    } catch {
      this.constellationName = null;
    }
    if (this.selectedKind === 'constellation' && this.selectedConstellationId) {
      const item = findConstellationById(this.selectedConstellationId);
      if (item) {
        this.constellationName = this.constellationDisplayName(item) + ' · ' + item.iau;
      }
    }

    if (bodyForIllum != null) {
      try {
        const illum = Illumination(bodyForIllum, date);
        this.mag = illum.mag;
        this.phaseFraction = illum.phase_fraction;
        this.phaseAngleDeg = illum.phase_angle;
        this.geoDistAu = illum.geo_dist;
        this.helioDistAu = illum.helio_dist;
        this.geoDistKm = illum.geo_dist * KM_PER_AU;
        this.distLy = illum.geo_dist / AU_PER_LY;
      } catch {
        this.phaseFraction = null;
        this.phaseAngleDeg = null;
        this.geoDistAu = null;
        this.helioDistAu = null;
        this.geoDistKm = null;
        this.distLy = null;
      }

      if (bodyForIllum !== Body.Sun) {
        try {
          const elong = Elongation(bodyForIllum, date);
          this.elongationDeg = elong.elongation;
        } catch {
          this.elongationDeg = null;
        }
      } else {
        this.elongationDeg = null;
      }

      try {
        const rise = SearchRiseSet(bodyForIllum, observer, +1, date, 1);
        const set = SearchRiseSet(bodyForIllum, observer, -1, date, 1);
        this.riseAt = rise?.date ?? null;
        this.setAt = set?.date ?? null;
      } catch {
        this.riseAt = null;
        this.setAt = null;
      }
    } else if (isStarLike) {
      this.phaseFraction = null;
      this.phaseAngleDeg = null;
      this.geoDistAu = this.distLy != null ? this.distLy * AU_PER_LY : null;
      this.helioDistAu = null;
      this.geoDistKm = this.geoDistAu != null ? this.geoDistAu * KM_PER_AU : null;
      this.elongationDeg = null;
      try {
        const rise = SearchRiseSet(Body.Star1, observer, +1, date, 1);
        const set = SearchRiseSet(Body.Star1, observer, -1, date, 1);
        this.riseAt = rise?.date ?? null;
        this.setAt = set?.date ?? null;
      } catch {
        this.riseAt = null;
        this.setAt = null;
      }
    }

    this.updatedAtMs = Date.now();
    this.nowMs = this.updatedAtMs;
    this.recomputeVisibility(date, observer, bodyForIllum, isStarLike);
    this.updateFinderProjection();
  }

  /** Azimut / élévation satellite depuis lat/lon live (ISS feed ou TLE/SGP4). */
  private recomputeIssSky(): void {
    const sat = this.selectedSatellite;
    this.applyBodyDisplayFromSatellite(sat);
    this.raHours = null;
    this.decDeg = null;
    this.mag = null;
    this.phaseFraction = null;
    this.phaseAngleDeg = null;
    this.geoDistAu = null;
    this.helioDistAu = null;
    this.distLy = null;
    this.constellationName = null;
    this.elongationDeg = null;

    const now = Date.now();
    if (sat.useIssLiveFeed) {
      if (now - this.issLastNetworkRefreshMs > ISS_REFRESH_MIN_MS) {
        this.issLastNetworkRefreshMs = now;
        void this.issNow.refresh(false).then(() => {
          if (this.selectedKind === 'iss' && this.selectedSatellite.useIssLiveFeed) {
            this.recomputeIssSky();
            this.cdr.markForCheck();
          }
        });
      }
    } else if (!sat.skipLiveTle && now - this.issLastNetworkRefreshMs > ISS_REFRESH_MIN_MS) {
      this.issLastNetworkRefreshMs = now;
      this.satNow.setObserver(this.lat, this.lon);
      void this.satNow.ensureOption(sat, false).then(() => {
        if (this.selectedKind === 'iss' && this.selectedSatelliteId === sat.id) {
          this.recomputeIssSky();
          this.cdr.markForCheck();
        }
      });
    }

    let snapLat: number | null = null;
    let snapLon: number | null = null;
    let altKm: number | null = null;
    let velocityKmh: number | null = null;

    if (sat.useIssLiveFeed) {
      const snap = this.issNow.snapshotForDisplay(now);
      if (snap) {
        snapLat = snap.lat;
        snapLon = snap.lon;
        altKm = snap.altKm;
        velocityKmh = snap.velocityKmh;
      }
    } else {
      this.satNow.setObserver(this.lat, this.lon);
      const snap = this.satNow.snapshotForOption(sat, now);
      if (snap) {
        snapLat = snap.lat;
        snapLon = snap.lon;
        altKm = snap.altKm;
        velocityKmh = snap.velocityKmh;
      }
    }

    if (snapLat == null || snapLon == null) {
      this.issStatus = this.issStatus === 'error' ? 'error' : 'loading';
      this.issLat = null;
      this.issLon = null;
      this.issAltKm = null;
      this.issVelocityKmh = null;
      this.issGroundKm = null;
      this.issSlantKm = null;
      this.azimuthDeg = null;
      this.elevationDeg = null;
      this.geoDistKm = null;
      if (!sat.useIssLiveFeed) {
        this.riseAt = null;
        this.setAt = null;
      }
      this.updatedAtMs = now;
      this.nowMs = now;
      this.recomputeIssVisibility();
      return;
    }

    const h = altKm != null && altKm > 0 ? altKm : sat.defaultAltKm;
    const groundKm = AstroCompassComponent.haversineGreatCircleKm(
      this.lat,
      this.lon,
      snapLat,
      snapLon
    );
    const gamma = groundKm / EARTH_RADIUS_KM;
    const elevationRad = AstroCompassComponent.satelliteElevationRad(gamma, h);
    const slantKm = AstroCompassComponent.satelliteSlantRangeKm(gamma, h);

    this.issStatus = 'ready';
    this.issLat = snapLat;
    this.issLon = snapLon;
    this.issAltKm = h;
    this.issVelocityKmh = velocityKmh;
    this.issGroundKm = groundKm;
    this.issSlantKm = slantKm;
    this.azimuthDeg = AstroCompassComponent.initialBearingDeg(this.lat, this.lon, snapLat, snapLon);
    this.elevationDeg = (elevationRad * 180) / Math.PI;
    this.geoDistKm = slantKm;
    this.geoDistAu = slantKm / KM_PER_AU;
    this.distLy = this.geoDistAu / AU_PER_LY;
    this.applySatelliteEquatorial(this.azimuthDeg, this.elevationDeg, new Date(now));
    this.updatedAtMs = now;
    this.nowMs = now;
    this.updateFinderProjection();

    if (sat.useIssLiveFeed) {
      this.refreshIssPasses(false);
    } else {
      this.refreshPredictedPasses(sat);
    }
    this.recomputeIssVisibility();
  }

  private recomputeIssVisibility(): void {
    this.currentlyVisible = this.elevationDeg != null && this.elevationDeg > 0;
    this.alwaysAbove = false;
    this.alwaysBelow = false;
    this.nextRiseAt = null;
    this.nextSetAt = null;
    this.culminationAt = null;
    this.culminationAltDeg = null;
    this.visibilityDays = [];
    this.visibilityHint = '';

    if (this.issStatus === 'loading' || this.issStatus === 'idle') {
      this.visibilityHint = 'ASTRO_COMPASS.ISS_WAITING';
      this.riseAt = null;
      this.setAt = null;
      return;
    }
    if (this.issStatus === 'error' && this.azimuthDeg == null) {
      this.visibilityHint = 'ASTRO_COMPASS.ISS_ERROR';
      this.riseAt = null;
      this.setAt = null;
      return;
    }

    this.riseAt = null;
    this.setAt = null;

    const now = Date.now();
    const passes = this.issPasses;
    let current: IssPassItem | null = null;
    let upcoming: IssPassItem | null = null;
    for (const p of passes) {
      const riseMs = p.riseAt.getTime();
      const setMs = p.setAt.getTime();
      if (riseMs <= now && now <= setMs) {
        current = p;
        break;
      }
      if (riseMs > now && !upcoming) {
        upcoming = p;
      }
    }

    if (this.currentlyVisible) {
      this.visibilityHint = 'ASTRO_COMPASS.VIS_NOW_VISIBLE';
      if (current) {
        this.nextSetAt = current.setAt;
        this.setAt = current.setAt;
        this.riseAt = current.riseAt;
        if (current.maxElevationDeg != null) {
          this.culminationAltDeg = current.maxElevationDeg;
          this.culminationAt = new Date(current.riseAt.getTime() + (current.durationSec * 1000) / 2);
        }
      } else if (upcoming) {
        this.nextSetAt = upcoming.setAt;
      }
    } else {
      this.visibilityHint = 'ASTRO_COMPASS.VIS_BELOW';
      if (upcoming) {
        this.nextRiseAt = upcoming.riseAt;
        this.nextSetAt = upcoming.setAt;
        this.riseAt = upcoming.riseAt;
        this.setAt = upcoming.setAt;
        if (upcoming.maxElevationDeg != null) {
          this.culminationAltDeg = upcoming.maxElevationDeg;
          this.culminationAt = new Date(
            upcoming.riseAt.getTime() + (upcoming.durationSec * 1000) / 2
          );
        }
      } else if (passes.length === 0) {
        this.visibilityHint = 'ASTRO_COMPASS.ISS_NO_PASS';
      }
    }

    const byDay = new Map<string, VisibilityDay>();
    for (const p of passes) {
      const key = p.riseAt.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });
      const existing = byDay.get(key);
      if (!existing) {
        byDay.set(key, {
          dayKey: key,
          rise: p.riseAt,
          set: p.setAt,
          transit: new Date(p.riseAt.getTime() + (p.durationSec * 1000) / 2),
          maxAltitudeDeg: p.maxElevationDeg
        });
      }
    }
    this.visibilityDays = Array.from(byDay.values()).slice(0, 5);
  }

  private refreshIssPasses(force: boolean): void {
    if (this.selectedKind !== 'iss') {
      return;
    }
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return;
    }
    const now = Date.now();
    const samePlace =
      this.issPassesLat != null &&
      this.issPassesLon != null &&
      Math.abs(this.issPassesLat - this.lat) < 0.02 &&
      Math.abs(this.issPassesLon - this.lon) < 0.02;
    if (!force && samePlace && now - this.issPassesLoadedAtMs < 5 * 60_000 && this.issPasses.length > 0) {
      return;
    }

    this.issPassSub?.unsubscribe();
    this.issPassSub = this.api.getIssPassesByCoordinates(this.lat, this.lon, 8).subscribe({
      next: (raw: unknown) => {
        this.issPasses = AstroCompassComponent.parseIssPasses(raw);
        this.issPassesLat = this.lat;
        this.issPassesLon = this.lon;
        this.issPassesLoadedAtMs = Date.now();
        if (this.selectedKind === 'iss') {
          this.recomputeIssVisibility();
          this.cdr.markForCheck();
        }
      },
      error: () => {
        if (this.issPasses.length === 0) {
          this.issPasses = [];
        }
        this.cdr.markForCheck();
      }
    });
  }

  private static parseIssPasses(raw: unknown): IssPassItem[] {
    const body = raw as {
      status?: string;
      passes?: { response?: Array<Record<string, unknown>> };
      nextPass?: Record<string, unknown>;
    };
    const list =
      body?.passes?.response ??
      (body?.nextPass ? [body.nextPass] : []);
    if (!Array.isArray(list)) {
      return [];
    }
    const now = Date.now();
    const out: IssPassItem[] = [];
    for (const item of list) {
      if (!item) {
        continue;
      }
      const riseSec =
        typeof item['risetime'] === 'number'
          ? item['risetime']
          : parseInt(String(item['risetime'] ?? ''), 10);
      if (!Number.isFinite(riseSec) || riseSec <= 0) {
        continue;
      }
      const durRaw =
        typeof item['duration'] === 'number'
          ? item['duration']
          : parseInt(String(item['duration'] ?? ''), 10);
      const durationSec = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 600;
      const riseAt = new Date(riseSec * 1000);
      const setAt = new Date(riseAt.getTime() + durationSec * 1000);
      if (setAt.getTime() < now - 60_000) {
        continue;
      }
      const maxElevRaw = item['maxElevation'] ?? item['max_elevation'] ?? item['altitude'];
      const maxElevationDeg =
        typeof maxElevRaw === 'number' && Number.isFinite(maxElevRaw) ? maxElevRaw : null;
      out.push({
        riseAt,
        setAt,
        durationSec,
        maxElevationDeg,
        maxAt: new Date(riseAt.getTime() + (durationSec * 1000) / 2)
      });
    }
    out.sort((a, b) => a.riseAt.getTime() - b.riseAt.getTime());
    return out;
  }

  private refreshPredictedPasses(sat: AstroSatelliteOption): void {
    this.satNow.setObserver(this.lat, this.lon);
    if (!this.satNow.snapshotForOption(sat, Date.now())) {
      return;
    }
    const now = Date.now();
    const samePlace =
      this.issPassesLat != null &&
      this.issPassesLon != null &&
      Math.abs(this.issPassesLat - this.lat) < 0.02 &&
      Math.abs(this.issPassesLon - this.lon) < 0.02;
    if (samePlace && now - this.issPassesLoadedAtMs < 5 * 60_000) {
      return;
    }
    this.issPasses = this.predictSatellitePasses(sat);
    this.issPassesLat = this.lat;
    this.issPassesLon = this.lon;
    this.issPassesLoadedAtMs = now;
  }

  private applySatelliteEquatorial(azDeg: number, elDeg: number, date: Date): void {
    const eq = AstroCompassComponent.horizontalToEquatorial(azDeg, elDeg, date, this.lat, this.lon);
    if (!eq) {
      this.raHours = null;
      this.decDeg = null;
      this.constellationName = null;
      return;
    }
    this.raHours = eq.raHours;
    this.decDeg = eq.decDeg;
    try {
      this.constellationName = Constellation(eq.raHours, eq.decDeg).name;
    } catch {
      this.constellationName = null;
    }
  }

  private predictSatellitePasses(sat: AstroSatelliteOption): IssPassItem[] {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return [];
    }
    this.satNow.setObserver(this.lat, this.lon);
    const startMs = Date.now() - SAT_PASS_LOOKBACK_MS;
    const endMs = Date.now() + SAT_PASS_HORIZON_MS;
    const passes: IssPassItem[] = [];
    let riseMs: number | null = null;
    let maxEl = -90;
    let maxAtMs = startMs;
    let prevEl: number | null = null;
    let prevMs = startMs;
    for (let t = startMs; t <= endMs; t += SAT_PASS_STEP_MS) {
      const snap = this.satNow.snapshotForOption(sat, t);
      if (!snap) {
        continue;
      }
      const h = snap.altKm != null && snap.altKm > 0 ? snap.altKm : sat.defaultAltKm;
      const groundKm = AstroCompassComponent.haversineGreatCircleKm(this.lat, this.lon, snap.lat, snap.lon);
      const el = (AstroCompassComponent.satelliteElevationRad(groundKm / EARTH_RADIUS_KM, h) * 180) / Math.PI;
      if (prevEl != null && prevEl <= 0 && el > 0) {
        riseMs = AstroCompassComponent.interpolateHorizonCrossing(prevMs, prevEl, t, el);
        maxEl = el;
        maxAtMs = t;
      } else if (riseMs != null && el > maxEl) {
        maxEl = el;
        maxAtMs = t;
      }
      if (prevEl != null && prevEl > 0 && el <= 0 && riseMs != null) {
        const setMs = AstroCompassComponent.interpolateHorizonCrossing(prevMs, prevEl, t, el);
        if (setMs > Date.now() - 15_000) {
          passes.push({
            riseAt: new Date(riseMs),
            setAt: new Date(setMs),
            durationSec: Math.max(0, Math.round((setMs - riseMs) / 1000)),
            maxElevationDeg: maxEl,
            maxAt: new Date(maxAtMs)
          });
          if (passes.length >= SAT_PASS_MAX) {
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

  private static interpolateHorizonCrossing(t0: number, el0: number, t1: number, el1: number): number {
    const den = el1 - el0;
    if (Math.abs(den) < 1e-9) {
      return t1;
    }
    const u = Math.min(1, Math.max(0, (0 - el0) / den));
    return t0 + (t1 - t0) * u;
  }

  /**
   * Calcule quand l'astre est / sera visible depuis la position observateur :
   * prochain lever/coucher, culmination, planning sur 3 jours.
   */
  private recomputeVisibility(
    date: Date,
    observer: Observer,
    bodyForIllum: Body | null,
    isStarLike: boolean
  ): void {
    this.currentlyVisible = this.elevationDeg != null && this.elevationDeg > 0;
    this.alwaysAbove = false;
    this.alwaysBelow = false;
    this.nextRiseAt = null;
    this.nextSetAt = null;
    this.culminationAt = null;
    this.culminationAltDeg = null;
    this.visibilityDays = [];
    this.visibilityHint = '';

    const body = bodyForIllum ?? (isStarLike ? Body.Star1 : null);
    if (body == null) {
      return;
    }

    try {
      const nextRise = SearchRiseSet(body, observer, +1, date, 2);
      const nextSet = SearchRiseSet(body, observer, -1, date, 2);
      this.nextRiseAt = nextRise?.date ?? null;
      this.nextSetAt = nextSet?.date ?? null;

      if (this.nextRiseAt == null && this.nextSetAt == null) {
        // Circumpolaire : toujours au-dessus ou toujours sous l'horizon.
        if (this.currentlyVisible) {
          this.alwaysAbove = true;
          this.visibilityHint = 'ASTRO_COMPASS.VIS_ALWAYS_UP';
        } else {
          this.alwaysBelow = true;
          this.visibilityHint = 'ASTRO_COMPASS.VIS_ALWAYS_DOWN';
        }
      } else if (this.currentlyVisible) {
        this.visibilityHint = 'ASTRO_COMPASS.VIS_NOW_VISIBLE';
      } else {
        this.visibilityHint = 'ASTRO_COMPASS.VIS_BELOW';
      }
    } catch {
      this.nextRiseAt = null;
      this.nextSetAt = null;
    }

    try {
      const transit = SearchHourAngle(body, observer, 0, date);
      if (transit?.time?.date) {
        this.culminationAt = transit.time.date;
        this.culminationAltDeg =
          transit.hor && Number.isFinite(transit.hor.altitude) ? transit.hor.altitude : null;
      }
    } catch {
      this.culminationAt = null;
      this.culminationAltDeg = null;
    }

    const days: VisibilityDay[] = [];
    for (let i = 0; i < 3; i++) {
      const dayStart = new Date(date.getTime());
      dayStart.setHours(0, 0, 0, 0);
      dayStart.setDate(dayStart.getDate() + i);
      const dayEnd = new Date(dayStart.getTime() + 36 * 3600 * 1000); // marge pour coucher après minuit
      let rise: Date | null = null;
      let set: Date | null = null;
      let transit: Date | null = null;
      let maxAlt: number | null = null;
      try {
        const r = SearchRiseSet(body, observer, +1, dayStart, 1.5);
        if (r?.date && r.date < dayEnd) {
          rise = r.date;
        }
      } catch {
        /* ignore */
      }
      try {
        const s = SearchRiseSet(body, observer, -1, dayStart, 1.5);
        if (s?.date && s.date < dayEnd) {
          set = s.date;
        }
      } catch {
        /* ignore */
      }
      try {
        const t = SearchHourAngle(body, observer, 0, dayStart);
        if (t?.time?.date && t.time.date >= dayStart && t.time.date < dayEnd) {
          transit = t.time.date;
          maxAlt = t.hor && Number.isFinite(t.hor.altitude) ? t.hor.altitude : null;
        }
      } catch {
        /* ignore */
      }
      days.push({
        dayKey: dayStart.toISOString().slice(0, 10),
        rise,
        set,
        transit,
        maxAltitudeDeg: maxAlt
      });
    }
    this.visibilityDays = days;
  }

  observerDistanceAvailable(): boolean {
    return this.geoDistAu != null || this.distLy != null || this.issSlantKm != null;
  }

  formatLightYears(ly: number): string {
    if (!Number.isFinite(ly) || ly < 0) {
      return '—';
    }
    if (ly === 0) {
      return '0';
    }
    return this.lightDistanceParts(ly).value;
  }

  formatLightYearUnit(ly: number): string {
    if (!Number.isFinite(ly) || ly < 0 || ly === 0) {
      return this.translate.instant('ASTRO_COMPASS.DIST_LY_UNIT');
    }
    const key = this.lightDistanceParts(ly).unitKey;
    if (!key) {
      return '';
    }
    return this.translate.instant('ASTRO_COMPASS.' + key);
  }

  /**
   * Unités entières + reste : s → min+s → h+min → j+h → années+jours → siècles+années.
   */
  private lightDistanceParts(ly: number): { value: string; unitKey: string; travelKey: string } {
    if (ly >= 1_000_000) {
      return {
        value: this.formatLightCount(ly),
        unitKey: 'DIST_LY_UNIT',
        travelKey: 'LIGHT_TRAVEL_Y'
      };
    }
    const totalSeconds = ly * SECONDS_PER_LY;
    if (totalSeconds < 60) {
      return {
        value: this.formatLightCount(totalSeconds),
        unitKey: 'DIST_LS_UNIT',
        travelKey: 'LIGHT_TRAVEL_S'
      };
    }
    const sec = Math.round(totalSeconds);
    const secPerCentury = 100 * SECONDS_PER_LY;
    let rem = sec;
    const centuries = Math.floor(rem / secPerCentury);
    rem %= secPerCentury;
    const years = Math.floor(rem / SECONDS_PER_LY);
    rem %= SECONDS_PER_LY;
    const days = Math.floor(rem / SECONDS_PER_DAY);
    rem %= SECONDS_PER_DAY;
    const hours = Math.floor(rem / 3600);
    rem %= 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    if (centuries > 0) {
      return this.formatLightPairLong(centuries, years, 'c');
    }
    if (years > 0) {
      return this.formatLightPairLong(years, days, 'y');
    }
    if (days > 0) {
      return this.formatLightPairCompact(days, hours, 'd');
    }
    if (hours > 0) {
      return this.formatLightPairCompact(hours, minutes, 'h');
    }
    return this.formatLightPairCompact(minutes, seconds, 'm');
  }

  /** 1 siècle et 50 années / 4 années et 88 jours. */
  private formatLightPairLong(
    major: number,
    minor: number,
    kind: 'c' | 'y'
  ): { value: string; unitKey: string; travelKey: string } {
    if (minor === 0) {
      if (kind === 'c') {
        return {
          value: this.formatLightCount(major),
          unitKey: 'DIST_LC_UNIT',
          travelKey: 'LIGHT_TRAVEL_C'
        };
      }
      return {
        value: this.formatLightCount(major),
        unitKey: 'DIST_LY_UNIT',
        travelKey: 'LIGHT_TRAVEL_Y'
      };
    }
    if (kind === 'c') {
      const century = this.translate.instant(
        major > 1 ? 'ASTRO_COMPASS.DIST_C_MANY' : 'ASTRO_COMPASS.DIST_C_ONE'
      );
      const year = this.translate.instant(
        minor > 1 ? 'ASTRO_COMPASS.DIST_Y_MANY' : 'ASTRO_COMPASS.DIST_Y_ONE'
      );
      return {
        value: this.translate.instant('ASTRO_COMPASS.DIST_CY_VALUE', {
          c: major,
          y: minor,
          century,
          year
        }),
        unitKey: '',
        travelKey: 'LIGHT_TRAVEL_CY'
      };
    }
    const year = this.translate.instant(
      major > 1 ? 'ASTRO_COMPASS.DIST_Y_MANY' : 'ASTRO_COMPASS.DIST_Y_ONE'
    );
    const day = this.translate.instant(
      minor > 1 ? 'ASTRO_COMPASS.DIST_D_MANY' : 'ASTRO_COMPASS.DIST_D_ONE'
    );
    return {
      value: this.translate.instant('ASTRO_COMPASS.DIST_YD_VALUE', {
        y: major,
        d: minor,
        year,
        day
      }),
      unitKey: '',
      travelKey: 'LIGHT_TRAVEL_CY'
    };
  }

  /** 8 min 19 s lum. / 1 h 30 min lum. / 1 j 12 h lum. */
  private formatLightPairCompact(
    major: number,
    minor: number,
    kind: 'd' | 'h' | 'm'
  ): { value: string; unitKey: string; travelKey: string } {
    if (minor === 0) {
      if (kind === 'd') {
        return {
          value: this.formatLightCount(major),
          unitKey: 'DIST_DJ_UNIT',
          travelKey: 'LIGHT_TRAVEL_D'
        };
      }
      if (kind === 'h') {
        return {
          value: this.formatLightCount(major),
          unitKey: 'DIST_LH_UNIT',
          travelKey: 'LIGHT_TRAVEL_H'
        };
      }
      return {
        value: this.formatLightCount(major),
        unitKey: 'DIST_LM_UNIT',
        travelKey: 'LIGHT_TRAVEL_M'
      };
    }
    const key =
      kind === 'd' ? 'DIST_DH_VALUE' : kind === 'h' ? 'DIST_HM_VALUE' : 'DIST_MS_VALUE';
    const params =
      kind === 'd' ? { d: major, h: minor } : kind === 'h' ? { h: major, m: minor } : { m: major, s: minor };
    return {
      value: this.translate.instant('ASTRO_COMPASS.' + key, params),
      unitKey: 'DIST_LUM_SUFFIX',
      travelKey: 'LIGHT_TRAVEL_HM'
    };
  }

  private formatLightCount(n: number): string {
    if (n >= 1_000_000) {
      return (n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' M';
    }
    if (n >= 10_000) {
      return Math.round(n).toLocaleString();
    }
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

  formatAu(au: number): string {
    if (!Number.isFinite(au) || au < 0) {
      return '—';
    }
    if (au >= 1_000_000_000) {
      return (au / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' G';
    }
    if (au >= 1_000_000) {
      return (au / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' M';
    }
    if (au >= 10_000) {
      return Math.round(au).toLocaleString();
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

  formatKm(km: number): string {
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

  formatKmFromAu(au: number): string {
    return this.formatKm(au * KM_PER_AU);
  }

  lightTravelLabel(): string | null {
    let ly = this.distLy;
    if ((ly == null || ly <= 0) && this.geoDistKm != null && this.geoDistKm > 0) {
      ly = this.geoDistKm / (KM_PER_AU * AU_PER_LY);
    }
    if (ly == null || !Number.isFinite(ly) || ly <= 0) {
      return null;
    }
    const seconds = ly * SECONDS_PER_LY;
    if (seconds < 0.05) {
      return null;
    }
    const parts = this.lightDistanceParts(ly);
    return this.translate.instant('ASTRO_COMPASS.' + parts.travelKey, { n: parts.value });
  }

  private loadObjectDossier(): void {
    const wikiLang = wikiContentLang(this.translate);
    const key = this.selectedKind + ':' + this.selectedObjectId() + ':' + wikiLang;
    if (this.objectDossierKey === key && (this.objectDossier || this.objectDossierBusy)) {
      return;
    }
    this.objectDossierSub?.unsubscribe();
    this.setObjectDossier(null);
    this.objectDossierKey = key;
    const lookup = this.resolveObjectLookup();
    if (!lookup) {
      this.objectDossierBusy = false;
      this.cdr.markForCheck();
      return;
    }
    this.objectDossierBusy = true;
    const req = wikiLookupRequest(lookup, wikiLang);

    this.objectDossierSub = forkJoin({
      wiki: this.fetchWikiSummary(req.title, req.lang, req.fallbackTitle, req.fallbackLang, req.search),
      sky: this.api.searchStellariumSkySources(lookup.sky).pipe(catchError(() => of([] as StellariumSkySource[]))),
      skyMap: this.fetchSkyMapPreview(lookup)
    }).subscribe({
      next: ({ wiki, sky, skyMap }) => {
        const hits = Array.isArray(sky) ? sky : sky ? [sky] : [];
        this.setObjectDossier(this.buildObjectDossier(wiki, this.pickSkySource(hits, lookup.sky), skyMap));
        this.objectDossierBusy = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.objectDossierBusy = false;
        this.cdr.markForCheck();
      }
    });
    this.cdr.markForCheck();
  }

  private fetchWikiSummary(
    firstTitle: string,
    firstLang: string,
    fallbackTitle: string,
    fallbackLang: string,
    searchQuery?: string
  ): Observable<WikipediaSummary | null> {
    const query = (searchQuery || firstTitle || fallbackTitle || '').trim();
    return this.api.getWikipediaSummary(firstTitle, firstLang).pipe(
      switchMap((wiki) => {
        if (this.wikiSummaryUsable(wiki)) {
          return of(wiki);
        }
        const sameRequest = firstTitle === fallbackTitle && firstLang === fallbackLang;
        if (sameRequest) {
          return this.searchWikiThenSummary(query, firstLang, fallbackLang);
        }
        return this.api.getWikipediaSummary(fallbackTitle, fallbackLang).pipe(
          switchMap((fallback) =>
            this.wikiSummaryUsable(fallback)
              ? of(fallback)
              : this.searchWikiThenSummary(query, firstLang, fallbackLang)
          ),
          catchError(() => this.searchWikiThenSummary(query, firstLang, fallbackLang))
        );
      }),
      catchError(() => {
        const sameRequest = firstTitle === fallbackTitle && firstLang === fallbackLang;
        if (sameRequest) {
          return this.searchWikiThenSummary(query, firstLang, fallbackLang);
        }
        return this.api.getWikipediaSummary(fallbackTitle, fallbackLang).pipe(
          switchMap((fallback) =>
            this.wikiSummaryUsable(fallback)
              ? of(fallback)
              : this.searchWikiThenSummary(query, firstLang, fallbackLang)
          ),
          catchError(() => this.searchWikiThenSummary(query, firstLang, fallbackLang))
        );
      })
    );
  }

  private searchWikiThenSummary(
    query: string,
    firstLang: string,
    fallbackLang: string
  ): Observable<WikipediaSummary | null> {
    if (!query) {
      return of(null);
    }
    return this.wikiSummaryFromSearch(query, firstLang).pipe(
      switchMap((wiki) => {
        if (this.wikiSummaryUsable(wiki) || firstLang === fallbackLang) {
          return of(this.wikiSummaryUsable(wiki) ? wiki : null);
        }
        return this.wikiSummaryFromSearch(query, fallbackLang);
      }),
      catchError(() =>
        firstLang === fallbackLang ? of(null) : this.wikiSummaryFromSearch(query, fallbackLang)
      )
    );
  }

  private wikiSummaryFromSearch(query: string, lang: string): Observable<WikipediaSummary | null> {
    return this.api.searchWikipedia(query, lang, 8).pipe(
      switchMap((res) => {
        const title = this.pickWikiSearchTitle(res?.pages, query);
        if (!title) {
          return of(null);
        }
        return this.api.getWikipediaSummary(title, lang).pipe(
          map((wiki) => this.wikiSummaryUsable(wiki) ? wiki : null),
          catchError(() => of(null))
        );
      }),
      catchError(() => of(null))
    );
  }

  private pickWikiSearchTitle(pages: WikipediaSearchPage[] | undefined, query: string): string | null {
    if (!pages?.length) {
      return null;
    }
    const astroHint = /galax|n[eé]buleuse|nebula|messier|cluster|amas|étoile|star\b|planète|planet|constellation|satellite|station spatiale|space station|télescope spatial|space telescope|observatoire|observatory|dwarf|naine|quasar|spirale|spiral/i;
    const disambig = /disambiguation|homonymie|topics referred|desambiguaci[oó]n|begriffsklärung|disambigua|неоднозначн|曖昧さ回避|消歧义|توضيح|פירושונים|αποσαφήνιση|बहुविकल्पी/i;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const queryRe = escaped ? new RegExp(escaped, 'i') : null;
    let bestTitle: string | null = null;
    let bestScore = -1;
    for (const page of pages) {
      const title = (page.title || page.key || '').replace(/_/g, ' ').trim();
      if (!title) {
        continue;
      }
      const blob = `${title} ${page.description || ''} ${page.excerpt || ''}`;
      if (disambig.test(blob)) {
        continue;
      }
      let score = 1;
      if (astroHint.test(blob)) {
        score += 6;
      }
      if (queryRe && queryRe.test(title)) {
        score += 3;
      }
      if (score > bestScore) {
        bestScore = score;
        bestTitle = title;
      }
    }
    return bestTitle || pages[0]?.title || null;
  }

  private wikiSummaryUsable(wiki: WikipediaSummary | null | undefined): boolean {
    return !!(wiki && wiki.type !== 'disambiguation' && (wiki.extract || wiki.description || wiki.title));
  }

  private fetchSkyMapPreview(lookup: WikiLookup): Observable<SkyMapPreview | null> {
    if (this.selectedKind === 'iss' || (this.selectedKind === 'planet' && this.selectedPlanetId === 'sun')) {
      return of(null);
    }
    const isPlanet = this.selectedKind === 'planet';
    const constellation =
      this.selectedKind === 'constellation' && this.selectedConstellationId
        ? findConstellationById(this.selectedConstellationId)
        : undefined;
    const centerStar = constellation ? constellationCenterStar(constellation) : undefined;
    const q = isPlanet
      ? ''
      : (
        centerStar?.name ||
        (this.selectedKind === 'constellation' ? '' : lookup.sky || this.bodyLabel) ||
        ''
      ).trim();
    const raHours = isPlanet
      ? this.raHours
      : (centerStar?.raHours ?? constellation?.raHours ?? this.raHours);
    const deDeg = isPlanet
      ? this.decDeg
      : (centerStar?.decDeg ?? constellation?.decDeg ?? this.decDeg);
    if (!q && (raHours == null || deDeg == null)) {
      return of(null);
    }
    let angle: number | undefined;
    if (isPlanet) {
      angle = 3;
    } else if (this.selectedKind === 'star' || this.selectedKind === 'constellation') {
      angle = 0.6;
    } else if (this.selectedKind === 'galaxy') {
      angle = 2.5;
    } else {
      angle = 1.2;
    }
    return this.api.getSkyMapPreview({
      q: q || undefined,
      raHours: raHours ?? undefined,
      deDeg: deDeg ?? undefined,
      angle,
      width: 400,
      height: 400
    }).pipe(
      map((preview) => {
        if (!preview || !centerStar?.name) {
          return preview;
        }
        return { ...preview, name: centerStar.name };
      }),
      catchError(() => of(null))
    );
  }

  private clearObjectDossier(): void {
    this.objectDossierSub?.unsubscribe();
    this.objectDossierSub = null;
    this.setObjectDossier(null);
    this.objectDossierBusy = false;
    this.objectDossierKey = null;
  }

  private selectedObjectId(): string {
    if (this.selectedKind === 'planet') {
      return this.selectedPlanetId;
    }
    if (this.selectedKind === 'star') {
      return this.selectedStarId || '';
    }
    if (this.selectedKind === 'galaxy') {
      return this.selectedGalaxyId || '';
    }
    if (this.selectedKind === 'constellation') {
      return this.selectedConstellationId || '';
    }
    if (this.selectedKind === 'iss') {
      return this.selectedSatelliteId;
    }
    return 'custom';
  }

  private resolveObjectLookup(): WikiLookup | null {
    const key = this.selectedKind + ':' + this.selectedObjectId();
    const mapped = OBJECT_WIKI_LOOKUP[key];
    if (mapped) {
      return mapped;
    }
    if (this.selectedKind === 'star' && this.selectedStarId) {
      const star = findStarById(this.selectedStarId);
      if (!star) {
        return null;
      }
      return { fr: star.name, en: star.name, sky: star.name, search: star.name };
    }
    if (this.selectedKind === 'galaxy' && this.selectedGalaxyId) {
      const galaxy = findGalaxyById(this.selectedGalaxyId);
      if (!galaxy) {
        return null;
      }
      const catalog = this.catalogWikiAndSky(galaxy.aliases, galaxy.name);
      const wiki = catalog?.wikiTitle || galaxy.name;
      const sky = catalog?.skyQuery || galaxy.name;
      const search = [wiki, galaxy.name, catalog?.skyQuery].filter((v, i, a) => !!v && a.indexOf(v) === i).join(' ');
      return { fr: wiki, en: wiki, sky, search };
    }
    if (this.selectedKind === 'constellation' && this.selectedConstellationId) {
      const item = findConstellationById(this.selectedConstellationId);
      if (!item) {
        return null;
      }
      return {
        fr: item.wikiFr,
        en: item.wikiEn,
        sky: item.name,
        search: [item.nameFr, item.name, item.iau, 'constellation'].join(' ')
      };
    }
    if (this.selectedKind === 'iss') {
      const sat = findSatelliteById(this.selectedSatelliteId);
      const label = sat ? this.translate.instant(sat.labelKey) : this.bodyLabel;
      if (!label) {
        return null;
      }
      return { fr: label, en: label, sky: label, search: label + ' satellite' };
    }
    if (this.bodyLabel) {
      return { fr: this.bodyLabel, en: this.bodyLabel, sky: this.bodyLabel };
    }
    return null;
  }

  /**
   * Wikipedia titles like "Andromeda (M31)" 404, and "M31" is a disambiguation page.
   * "Messier 31" / "NGC 224" redirect to the galaxy article. Stellarium needs compact
   * tokens ("M31", "NGC224") — lowercase "m31" or spaced "NGC 224" return nothing.
   */
  private catalogWikiAndSky(
    aliases: string[],
    name: string
  ): { wikiTitle: string; skyQuery: string } | null {
    const tokens = [name, ...aliases];
    for (const raw of tokens) {
      const text = (raw || '').trim();
      const messier = text.match(/^(messier|m)\s*(\d+)$/i);
      if (messier) {
        return { wikiTitle: 'Messier ' + messier[2], skyQuery: 'M' + messier[2] };
      }
      const cat = text.match(/^(ngc|ic|ugc|pgc|ugca)\s*(\d+[a-z]?)$/i);
      if (cat) {
        const prefix = cat[1].toUpperCase();
        return { wikiTitle: prefix + ' ' + cat[2], skyQuery: prefix + cat[2] };
      }
      const special = text.match(/^(lmc|smc|wlm)$/i);
      if (special) {
        const code = special[1].toUpperCase();
        const wiki =
          code === 'LMC' ? 'Large Magellanic Cloud'
            : code === 'SMC' ? 'Small Magellanic Cloud'
              : 'Wolf–Lundmark–Melotte';
        return { wikiTitle: wiki, skyQuery: code };
      }
    }
    return null;
  }

  private pickSkySource(results: StellariumSkySource[], query: string): StellariumSkySource | undefined {
    if (!results.length) {
      return undefined;
    }
    const compact = query.replace(/\s+/g, '').toUpperCase();
    const namesOf = (source: StellariumSkySource): string[] => [
      source.short_name,
      source.match,
      ...(source.names || [])
    ].filter((n): n is string => !!n);
    const matchesQuery = (source: StellariumSkySource): boolean =>
      namesOf(source).some((n) => n.replace(/\s+/g, '').toUpperCase() === compact
        || n.replace(/^(NAME|NORAD|COSPAR)\s+/i, '').replace(/\s+/g, '').toUpperCase() === compact);
    const isSatellite = (source: StellariumSkySource): boolean =>
      source.model === 'tle_satellite' || (source.types || []).includes('Asa');
    if (this.selectedKind === 'iss') {
      const norad = this.selectedSatellite?.noradId;
      const byNorad = norad
        ? results.find((s) => isSatellite(s) && this.asFiniteNumber(s.model_data?.['norad_number']) === norad)
        : undefined;
      if (byNorad) {
        return byNorad;
      }
      const exactSat = results.find((s) => isSatellite(s) && matchesQuery(s));
      if (exactSat) {
        return exactSat;
      }
      return results.find(isSatellite);
    }
    const exact = results.find(matchesQuery);
    if (exact) {
      return exact;
    }
    if (this.selectedKind === 'galaxy') {
      const galaxy = results.find((s) => (s.types || []).includes('G') || s.model === 'dso');
      if (galaxy) {
        return galaxy;
      }
    }
    return results[0];
  }

  private buildObjectDossier(
    wiki: WikipediaSummary | null,
    sky: StellariumSkySource | undefined,
    skyMap: SkyMapPreview | null
  ): ObjectDossier | null {
    const wikiOk = wiki && wiki.type !== 'disambiguation';
    const extract = wikiOk ? wiki.extract?.trim() || null : null;
    const description = wikiOk ? wiki.description?.trim() || null : null;
    const thumbUrl = wiki?.thumbnail?.source || wiki?.originalimage?.source || null;
    const imageUrl = wiki?.originalimage?.source || wiki?.thumbnail?.source || null;
    const wikiUrl = wiki?.content_urls?.desktop?.page || wiki?.content_urls?.mobile?.page || null;
    const wikiTitle = wiki?.title || wiki?.displaytitle || null;
    const wikiLang = wikiOk ? wikiSourceLang(wiki) : null;
    const wikiDir = wikiSourceDir(wikiLang);
    const skyNames = this.dossierSkyNames(sky);
    const skyTypes = this.dossierSkyTypes(sky);
    const vMag = this.asFiniteNumber(sky?.model_data?.Vmag) ?? this.asFiniteNumber(sky?.model_data?.['mag']);
    const bMag = this.asFiniteNumber(sky?.model_data?.Bmag);
    const skyMapCutoutUrl = this.api.skyMapImageSrc(skyMap);
    const skyMapAtlasUrl = skyMap?.atlasUrl || null;
    const skyMapEmbedUrl = this.api.skyMapEmbedSrc(skyMap);
    const skyMapName = skyMap?.name || skyMap?.catalogId || null;
    if (!extract && !description && !thumbUrl && !skyMapCutoutUrl && !skyMapEmbedUrl
        && !skyNames.length && !skyTypes.length && vMag == null && bMag == null) {
      return null;
    }
    return {
      extract, description, thumbUrl, imageUrl, wikiUrl, wikiTitle, wikiLang, wikiDir,
      skyNames, skyTypes, vMag, bMag, skyMapCutoutUrl, skyMapAtlasUrl, skyMapEmbedUrl, skyMapName
    };
  }

  private dossierSkyNames(sky: StellariumSkySource | undefined): string[] {
    const names = (sky?.names || [])
      .map((n) => (n || '').replace(/^NAME\s+/i, '').trim())
      .filter((n) => !!n);
    if (this.selectedKind === 'iss') {
      const norad = this.selectedSatellite?.noradId;
      if (norad) {
        const label = 'NORAD ' + norad;
        if (!names.some((n) => n.replace(/\s+/g, '').toUpperCase() === label.replace(/\s+/g, '').toUpperCase())) {
          names.unshift(label);
        }
      }
    }
    return names.slice(0, 6);
  }

  private dossierSkyTypes(sky: StellariumSkySource | undefined): string[] {
    const types = (sky?.types || []).filter((n) => !!n && n !== 'Asa');
    if (this.selectedKind === 'iss') {
      const satLabel = this.translate.instant('ASTRO_COMPASS.KIND_SATELLITE');
      if (satLabel && !types.includes(satLabel)) {
        types.unshift(satLabel);
      }
    }
    return types.slice(0, 4);
  }

  openDossierImage(): void {
    void this.openObjectSlideshow('wiki');
  }

  openSkyMapImage(): void {
    void this.openObjectSlideshow('skymap');
  }

  dossierHeroPhotoUrl(): string | null {
    return this.objectDossier?.thumbUrl || this.objectDossier?.skyMapCutoutUrl || null;
  }

  private setObjectDossier(dossier: ObjectDossier | null): void {
    this.objectDossier = dossier;
    const url = dossier?.skyMapEmbedUrl;
    this.skyMapViewerSrc = url ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;
  }

  canOpenSkyMapApp(): boolean {
    return !!(this.objectDossier?.skyMapAtlasUrl || this.skyMapAppQuery());
  }

  skyMapAppHref(): string | SafeUrl {
    const query = this.skyMapAppQuery();
    if (isAndroidUserAgent()) {
      return this.sanitizer.bypassSecurityTrustUrl(skyMapAndroidSearchIntent(query));
    }
    return this.objectDossier?.skyMapAtlasUrl || this.skyMapWebFallback(query) || '#';
  }

  skyMapAppTarget(): '_blank' | '_self' {
    return isAndroidUserAgent() ? '_self' : '_blank';
  }

  onSkyMapAppClick(event: MouseEvent): void {
    if (!isAndroidUserAgent()) {
      return;
    }
    event.preventDefault();
    openSkyMapAndroidApp(this.skyMapAppQuery());
  }

  private skyMapAppQuery(): string {
    const lookup = this.resolveObjectLookup();
    if (lookup?.sky) {
      return lookup.sky.trim();
    }
    const names = this.objectDossier?.skyNames || [];
    const catalog = names.find((n) => /^(M|NGC|IC|HD|HR)\s*\d+/i.test(n));
    return (catalog || this.objectDossier?.skyMapName || names[0] || this.bodyLabel || '').trim();
  }

  private skyMapWebFallback(query: string): string {
    const params = new URLSearchParams();
    if (query) {
      params.set('object', query);
    }
    if (Number.isFinite(this.raHours) && Number.isFinite(this.decDeg)) {
      params.set('ra', String(this.raHours));
      params.set('de', String(this.decDeg));
    }
    params.set('zoom', '4');
    params.set('img_source', 'DSS2');
    return 'https://www.sky-map.org/?' + params.toString();
  }

  openConstellationSchemaSlideshow(): void {
    void this.openObjectSlideshow('schema');
  }

  onDossierSlideshowClosed(): void {
    this.dossierSlideshowOpen = false;
    this.cdr.markForCheck();
  }

  private async openObjectSlideshow(focus: 'wiki' | 'schema' | 'skymap'): Promise<void> {
    if (!this.slideshowModalComponent) {
      return;
    }
    const dossier = this.objectDossier;
    const wikiUrl = dossier?.imageUrl || dossier?.thumbUrl || null;
    const title =
      dossier?.wikiTitle || this.bodyLabel || this.translate.instant('ASTRO_COMPASS.OBJECT_INFO_TITLE');
    const sources: SlideshowImageSource[] = [];
    if (wikiUrl) {
      sources.push({
        blobUrl: wikiUrl,
        fileName: this.dossierImageFileName(wikiUrl, title)
      });
    }
    if (dossier?.skyMapCutoutUrl) {
      sources.push({
        blobUrl: dossier.skyMapCutoutUrl,
        fileName: this.dossierImageFileName(dossier.skyMapCutoutUrl, dossier.skyMapName || title)
      });
    }
    const schema = await this.buildConstellationSchemaSlideshowSource();
    if (schema) {
      sources.push(schema);
    }
    if (!sources.length) {
      return;
    }
    let startIndex = 0;
    if (focus === 'skymap' && dossier?.skyMapCutoutUrl) {
      startIndex = wikiUrl ? 1 : 0;
    } else if (focus === 'schema' && schema) {
      startIndex = sources.length - 1;
    }
    this.dossierSlideshowOpen = true;
    this.slideshowModalComponent.open(sources, title, false, 0, undefined, startIndex);
    this.cdr.markForCheck();
  }

  private async buildConstellationSchemaSlideshowSource(): Promise<SlideshowImageSource | null> {
    if (!this.hasConstellationSchema) {
      return null;
    }
    const svg = this.constellationSchemaSvgMarkup();
    const png = await this.svgMarkupToPngBlob(svg, 1200);
    this.revokeConstellationSchemaBlobUrl();
    if (png) {
      const blobUrl = URL.createObjectURL(png);
      this.constellationSchemaBlobUrl = blobUrl;
      return {
        blobUrl,
        blob: png,
        fileName: this.constellationSchemaFileName('png')
      };
    }
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return {
      blobUrl: dataUrl,
      fileName: this.constellationSchemaFileName('svg')
    };
  }

  private constellationSchemaSvgMarkup(): string {
    const color = (this.bodyColor || '#d8b4fe').replace(/[^\w#(),.% -]/g, '');
    const lines = this.constellationSchemaPolylines
      .map(
        (pts) =>
          `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
      )
      .join('');
    const dots = this.constellationSchemaDots
      .map((d) => `<circle cx="${d.xPct}" cy="${d.yPct}" r="2.3" fill="${color}"/>`)
      .join('');
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1200" height="1200">` +
      `<rect width="100" height="100" rx="4" fill="#040812"/>` +
      lines +
      dots +
      `</svg>`
    );
  }

  private svgMarkupToPngBlob(svg: string, size: number): Promise<Blob | null> {
    return new Promise((resolve) => {
      const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            resolve(null);
            return;
          }
          ctx.fillStyle = '#040812';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(url);
            resolve(blob);
          }, 'image/png');
        } catch {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  private constellationSchemaFileName(ext: 'png' | 'svg'): string {
    const base =
      (this.bodyLabel || 'constellation').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') ||
      'constellation';
    return `${base}-schema.${ext}`;
  }

  private revokeConstellationSchemaBlobUrl(): void {
    if (this.constellationSchemaBlobUrl) {
      URL.revokeObjectURL(this.constellationSchemaBlobUrl);
      this.constellationSchemaBlobUrl = null;
    }
  }

  private dossierImageFileName(url: string, title: string): string {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (last && /\.(jpe?g|png|gif|webp|svg|tif{1,2})$/i.test(last)) {
        return last;
      }
    } catch {
      /* ignore */
    }
    const base = title.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || 'object';
    return base + '.jpg';
  }

  private asFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** Durée approximative de la prochaine fenêtre de visibilité (libellé). */
  visibilityDurationLabel(): string | null {
    const rise = this.currentlyVisible ? null : this.nextRiseAt;
    const set = this.nextSetAt;
    const start = rise ?? (this.currentlyVisible ? new Date(this.nowMs) : null);
    if (start == null || set == null || set <= start) {
      return null;
    }
    const mins = Math.round((set.getTime() - start.getTime()) / 60000);
    if (mins < 60) {
      return this.translate.instant('ASTRO_COMPASS.VIS_DURATION_M', { m: mins });
    }
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return this.translate.instant('ASTRO_COMPASS.VIS_DURATION_HM', { h, m });
  }

  formatVisTime(d: Date | null): string {
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

  formatVisClock(d: Date | null): string {
    if (!d) {
      return '—';
    }
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  private clearSkySnapshot(): void {
    this.azimuthDeg = null;
    this.elevationDeg = null;
    this.raHours = null;
    this.decDeg = null;
    this.mag = null;
    this.phaseFraction = null;
    this.phaseAngleDeg = null;
    this.geoDistAu = null;
    this.helioDistAu = null;
    this.geoDistKm = null;
    this.distLy = null;
    this.constellationName = null;
    this.elongationDeg = null;
    this.riseAt = null;
    this.setAt = null;
    this.currentlyVisible = false;
    this.alwaysAbove = false;
    this.alwaysBelow = false;
    this.nextRiseAt = null;
    this.nextSetAt = null;
    this.culminationAt = null;
    this.culminationAltDeg = null;
    this.visibilityDays = [];
    this.visibilityHint = '';
    this.issGroundKm = null;
    this.issSlantKm = null;
  }

  private applyBodyDisplayFromPlanet(planet: AstroBodyOption): void {
    this.bodyIconClass = planet.iconClass;
    this.bodyColor = planet.color;
    this.bodyLabel = this.translate.instant(planet.labelKey);
  }

  private applyBodyDisplayFromStar(star: AstroStarOption): void {
    this.bodyIconClass = star.iconClass;
    this.bodyColor = star.color;
    this.bodyLabel = star.name;
  }

  private applyBodyDisplayFromGalaxy(galaxy: AstroGalaxyOption): void {
    this.bodyIconClass = galaxy.iconClass;
    this.bodyColor = galaxy.color;
    this.bodyLabel = galaxy.name;
  }

  private applyBodyDisplayFromConstellation(item: AstroConstellationOption): void {
    this.bodyIconClass = item.iconClass;
    this.bodyColor = item.color;
    this.bodyLabel = this.constellationDisplayName(item);
  }

  private skyPointFromRaDec(
    date: Date,
    observer: Observer,
    raHours: number,
    decDeg: number,
    distLy = 100
  ): { az: number; el: number } | null {
    try {
      DefineStar(Body.Star1, raHours, decDeg, Math.max(1, distLy));
      const eq = Equator(Body.Star1, date, observer, true, true);
      const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
      return { az: hor.azimuth, el: hor.altitude };
    } catch {
      return null;
    }
  }

  private buildEquatorialConstellationSchema(item: AstroConstellationOption): void {
    const strokes = this.constellationSchemaStrokes(item);
    const mapped: Array<Array<{ x: number; y: number }>> = [];
    const cosDec = Math.max(0.15, Math.cos((item.decDeg * Math.PI) / 180));
    for (const stroke of strokes) {
      const pts = stroke.map(([ra, dec]) => ({
        // East to the left, like a sky chart (SVG Y is flipped in fitXyStrokesToBox).
        x: -this.circularDiffDeg(ra * 15, item.raHours * 15) * cosDec,
        y: dec - item.decDeg
      }));
      if (pts.length >= 2) {
        mapped.push(pts);
      }
    }
    const fitted = this.fitXyStrokesToBox(mapped, true);
    this.constellationSchemaPolylines = fitted.polylines;
    this.constellationSchemaDots = fitted.dots;
  }

  /**
   * Compact card outline: the familiar asterism when we have enough named stars
   * (e.g. the Big Dipper for Ursa Major), otherwise the full IAU stick figure.
   */
  private constellationSchemaStrokes(
    item: AstroConstellationOption
  ): ReadonlyArray<ReadonlyArray<readonly [number, number]>> {
    const asterism = this.constellationAsterismStrokes(item.id);
    if (asterism.length) {
      return asterism;
    }
    return constellationFigureStrokes(item.id);
  }

  private constellationAsterismStrokes(
    id: string
  ): Array<Array<[number, number]>> {
    const lines = constellationStickLines(id);
    const stars = new Set<string>();
    for (const [a, b] of lines) {
      stars.add(a);
      stars.add(b);
    }
    if (stars.size < 5) {
      return [];
    }
    const strokes: Array<Array<[number, number]>> = [];
    for (const [a, b] of lines) {
      const sa = findStarById(a);
      const sb = findStarById(b);
      if (!sa || !sb) {
        continue;
      }
      strokes.push([
        [sa.raHours, sa.decDeg],
        [sb.raHours, sb.decDeg]
      ]);
    }
    return strokes.length ? strokes : [];
  }

  private refreshConstellationMemberSky(
    date: Date,
    observer: Observer,
    item: AstroConstellationOption
  ): void {
    const members: ConstellationMemberSky[] = [];
    for (const star of constellationMemberStars(item.iau, item.id)) {
      const hor = this.skyPointFromRaDec(date, observer, star.raHours, star.decDeg, star.distLy);
      if (!hor) {
        continue;
      }
      members.push({
        id: star.id,
        name: star.name,
        az: hor.az,
        el: hor.el
      });
    }
    this.constellationMemberSky = members;
    const figure: ConstellationFigureSkyPt[][] = [];
    const cache = new Map<string, ConstellationFigureSkyPt>();
    for (const stroke of constellationFigureStrokes(item.id)) {
      const pts: ConstellationFigureSkyPt[] = [];
      for (const [raHours, decDeg] of stroke) {
        const key = `${raHours.toFixed(4)},${decDeg.toFixed(4)}`;
        let pt = cache.get(key);
        if (!pt) {
          const hor = this.skyPointFromRaDec(date, observer, raHours, decDeg);
          if (!hor) {
            continue;
          }
          pt = hor;
          cache.set(key, pt);
        }
        pts.push(pt);
      }
      if (pts.length >= 2) {
        figure.push(pts);
      }
    }
    this.constellationFigureSky = figure;
    this.buildEquatorialConstellationSchema(item);
    try {
      DefineStar(Body.Star1, item.raHours, item.decDeg, 100);
    } catch {
      /* ignore */
    }
  }

  private applyBodyDisplayFromSatellite(sat: AstroSatelliteOption): void {
    this.bodyIconClass = sat.iconClass;
    this.bodyColor = sat.color;
    if (sat.constellation === 'starlink') {
      const pass = this.satNow.starlinkPass();
      if (pass && pass.members.length >= 3) {
        this.bodyLabel = this.translate.instant('ASTRO_COMPASS.BODY_STARLINK_TRAIN', {
          n: pass.members.length
        });
        return;
      }
    }
    this.bodyLabel = this.translate.instant(sat.labelKey);
  }

  /**
   * Recalcule quels corps du catalogue sont au-dessus de l'horizon
   * (pour le filtre « visibles seulement »).
   */
  /** Recalcule tout de suite les astres au-dessus de l’horizon (retour sur la page). */
  private refreshVisibleSkyNow(refreshIss: boolean): void {
    this.nowMs = Date.now();
    this.recomputeSky();
    this.refreshVisibleCatalog();
    if (refreshIss) {
      void this.issNow.refresh(false).then(() => {
        this.refreshVisibleCatalog();
        this.cdr.markForCheck();
      });
    }
    this.cdr.markForCheck();
  }

  private refreshVisibleCatalog(): void {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      this.visiblePlanetIds = new Set();
      this.visibleStarIds = new Set();
      this.visibleGalaxyIds = new Set();
      this.visibleConstellationIds = new Set();
      this.visibleSatelliteIds = new Set();
      this.issVisibleNow = false;
      this.clearCatalogSkyDirs();
      this.onStarQueryChange();
      this.onGalaxyQueryChange();
      this.onConstellationQueryChange();
      return;
    }

    const date = new Date();
    const observer = new Observer(this.lat, this.lon, this.height);
    const planetIds = new Set<string>();
    const starIds = new Set<string>();
    const galaxyIds = new Set<string>();
    const constellationIds = new Set<string>();
    const satelliteIds = new Set<string>();
    this.clearCatalogSkyDirs();

    for (const planet of ASTRO_PLANETS) {
      try {
        const eq = Equator(planet.body, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        this.setCatalogSkyDir('planet', planet.id, hor.azimuth, hor.altitude);
        if (hor.altitude > 0) {
          planetIds.add(planet.id);
        }
      } catch {
        /* ignore body */
      }
    }

    for (const star of ASTRO_BRIGHT_STARS) {
      try {
        DefineStar(Body.Star1, star.raHours, star.decDeg, Math.max(1, star.distLy));
        const eq = Equator(Body.Star1, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        this.setCatalogSkyDir('star', star.id, hor.azimuth, hor.altitude);
        if (hor.altitude > 0) {
          starIds.add(star.id);
        }
      } catch {
        /* ignore star */
      }
    }

    for (const galaxy of ASTRO_GALAXIES) {
      try {
        DefineStar(Body.Star1, galaxy.raHours, galaxy.decDeg, Math.max(1, galaxy.distLy));
        const eq = Equator(Body.Star1, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        this.setCatalogSkyDir('galaxy', galaxy.id, hor.azimuth, hor.altitude);
        if (hor.altitude > 0) {
          galaxyIds.add(galaxy.id);
        }
      } catch {
        /* ignore galaxy */
      }
    }

    for (const item of ASTRO_CONSTELLATIONS) {
      try {
        DefineStar(Body.Star1, item.raHours, item.decDeg, 100);
        const eq = Equator(Body.Star1, date, observer, true, true);
        const hor = Horizon(date, observer, eq.ra, eq.dec, 'normal');
        this.setCatalogSkyDir('constellation', item.id, hor.azimuth, hor.altitude);
        if (hor.altitude > 0) {
          constellationIds.add(item.id);
        }
      } catch {
        /* ignore constellation */
      }
    }

    const now = Date.now();
    for (const sat of ASTRO_SATELLITES) {
      const dir = this.computeSatelliteSkyNow(sat, now);
      if (!dir) {
        continue;
      }
      this.setCatalogSkyDir('iss', sat.id, dir.azimuthDeg, dir.elevationDeg);
      if (dir.elevationDeg > 0) {
        satelliteIds.add(sat.id);
      }
    }

    this.visiblePlanetIds = planetIds;
    this.visibleStarIds = starIds;
    this.visibleGalaxyIds = galaxyIds;
    this.visibleConstellationIds = constellationIds;
    this.visibleSatelliteIds = satelliteIds;
    this.issVisibleNow = satelliteIds.has('iss');
    this.onStarQueryChange();
    this.onGalaxyQueryChange();
    this.onConstellationQueryChange();
  }

  private clearCatalogSkyDirs(): void {
    this.catalogSkyDirs.planet.clear();
    this.catalogSkyDirs.star.clear();
    this.catalogSkyDirs.galaxy.clear();
    this.catalogSkyDirs.constellation.clear();
    this.catalogSkyDirs.iss.clear();
  }

  private setCatalogSkyDir(
    kind: CatalogSkyKind,
    id: string,
    azimuthDeg: number,
    elevationDeg: number
  ): void {
    if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) {
      return;
    }
    this.catalogSkyDirs[kind].set(id, {
      azimuthDeg,
      elevationDeg,
      label: this.formatCatalogSkyDirLabel(azimuthDeg, elevationDeg)
    });
  }

  private relabelCatalogSkyDirs(): void {
    (Object.keys(this.catalogSkyDirs) as CatalogSkyKind[]).forEach((kind) => {
      const map = this.catalogSkyDirs[kind];
      map.forEach((dir, id) => {
        map.set(id, {
          ...dir,
          label: this.formatCatalogSkyDirLabel(dir.azimuthDeg, dir.elevationDeg)
        });
      });
    });
  }

  private formatCatalogSkyDirLabel(azimuthDeg: number, elevationDeg: number): string {
    const az = ((Math.round(azimuthDeg) % 360) + 360) % 360;
    const el = Math.round(elevationDeg);
    const elTxt = el > 0 ? `+${el}°` : `${el}°`;
    return `${this.cardinalLabel(azimuthDeg)} ${az}° / ${elTxt}`;
  }

  private computeSatelliteSkyNow(
    sat: AstroSatelliteOption,
    nowMs = Date.now()
  ): { azimuthDeg: number; elevationDeg: number } | null {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return null;
    }
    if (sat.skipLiveTle && !sat.sunEarthL2) {
      return null;
    }
    let snapLat: number | null = null;
    let snapLon: number | null = null;
    let altKm = sat.defaultAltKm;
    if (sat.useIssLiveFeed) {
      const snap = this.issNow.snapshotForDisplay(nowMs);
      if (!snap) {
        return null;
      }
      snapLat = snap.lat;
      snapLon = snap.lon;
      if (snap.altKm != null && snap.altKm > 0) {
        altKm = snap.altKm;
      }
    } else {
      this.satNow.setObserver(this.lat, this.lon);
      const snap = this.satNow.snapshotForOption(sat, nowMs);
      if (!snap) {
        void this.satNow.ensureOption(sat, false);
        return null;
      }
      snapLat = snap.lat;
      snapLon = snap.lon;
      if (snap.altKm != null && snap.altKm > 0) {
        altKm = snap.altKm;
      }
    }
    if (snapLat == null || snapLon == null) {
      return null;
    }
    const groundKm = AstroCompassComponent.haversineGreatCircleKm(
      this.lat,
      this.lon,
      snapLat,
      snapLon
    );
    const elevationDeg =
      (AstroCompassComponent.satelliteElevationRad(groundKm / EARTH_RADIUS_KM, altKm) * 180) / Math.PI;
    if (!Number.isFinite(elevationDeg)) {
      return null;
    }
    return {
      azimuthDeg: AstroCompassComponent.initialBearingDeg(this.lat, this.lon, snapLat, snapLon),
      elevationDeg
    };
  }

  private computeSatelliteAboveHorizonNow(sat: AstroSatelliteOption, nowMs = Date.now()): boolean {
    const dir = this.computeSatelliteSkyNow(sat, nowMs);
    return dir != null && dir.elevationDeg > 0;
  }

  private computeIssAboveHorizonNow(): boolean {
    return this.computeSatelliteAboveHorizonNow(this.issOption);
  }

  private startSkyTick(): void {
    this.stopSkyTick();
    this.zone.runOutsideAngular(() => {
      this.skyTickTimer = setInterval(() => {
        this.zone.run(() => {
          this.nowMs = Date.now();
          this.recomputeSky();
          this.refreshVisibleCatalog();
          this.selectDefaultVisibleTarget();
          this.refreshTickerNowLabel();
          this.cdr.markForCheck();
        });
      }, 1000);
    });
  }

  private stopSkyTick(): void {
    if (this.skyTickTimer != null) {
      clearInterval(this.skyTickTimer);
      this.skyTickTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Géolocalisation                                                     */
  /* ------------------------------------------------------------------ */

  refreshLocation(): void {
    if (this.locationRefreshing) {
      return;
    }
    this.locationRefreshing = true;
    this.cdr.markForCheck();

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.zone.run(() => {
            this.heightUserLocked = false;
            this.userAccuracyM = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
            this.userSource = 'gps';
            this.placeLabel = '';
            this.applyObserverPosition(
              pos.coords.latitude,
              pos.coords.longitude,
              this.height,
              undefined,
              true,
              true
            );
            this.locationRefreshing = false;
            this.cdr.markForCheck();
          });
        },
        () => {
          this.zone.run(() => {
            this.locationRefreshing = false;
            this.cdr.markForCheck();
          });
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
      );
    } else {
      this.locationRefreshing = false;
      this.cdr.markForCheck();
    }
  }

  private startGeolocation(): void {
    this.geoStatus = 'locating';
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.tryIpLocationFallback();
      return;
    }
    try {
      this.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          this.zone.run(() => {
            // Ne pas écraser une position choisie (adresse / carte / manuel).
            if (
              this.userSource === 'manual' ||
              this.userSource === 'address' ||
              this.userSource === 'map'
            ) {
              this.ingestGpsCourse(pos.coords, pos.timestamp);
              this.cdr.markForCheck();
              return;
            }
            this.lat = pos.coords.latitude;
            this.lon = pos.coords.longitude;
            this.userAccuracyM = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
            this.userSource = 'gps';
            if (this.geoStatus === 'locating' || this.geoStatus === 'no-geo') {
              this.geoStatus = 'ready';
            }
            this.ingestGpsCourse(pos.coords, pos.timestamp);
            this.recomputeSky();
            this.maybeResolveAddressFromGps(pos.coords.latitude, pos.coords.longitude);
            if (!this.heightUserLocked) {
              this.resolveObserverAltitude(pos.coords.latitude, pos.coords.longitude);
            }
            this.cdr.markForCheck();
          });
        },
        () => {
          this.zone.run(() => {
            if (this.userSource !== 'gps') {
              this.tryIpLocationFallback();
            } else if (this.geoStatus === 'locating') {
              this.geoStatus = 'no-geo';
            }
            this.cdr.markForCheck();
          });
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
      );
    } catch {
      this.tryIpLocationFallback();
    }
  }

  private tryIpLocationFallback(): void {
    if (this.ipFallbackAttempted || this.userSource === 'gps') {
      if (this.userSource == null) {
        this.geoStatus = 'no-geo';
      }
      return;
    }
    this.ipFallbackAttempted = true;
    this.api.getLocationByIp().subscribe({
      next: (res) => {
        if (this.userSource === 'gps') {
          return;
        }
        if (
          res?.status === 'success' &&
          Number.isFinite(res.lat) &&
          Number.isFinite(res.lon)
        ) {
          this.userSource = 'ip';
          this.geoStatus = 'ready';
          this.heightUserLocked = false;
          this.applyObserverPosition(
            res.lat as number,
            res.lon as number,
            this.height,
            undefined,
            true,
            true
          );
        } else if (this.userSource == null) {
          this.geoStatus = 'no-geo';
        }
        this.cdr.markForCheck();
      },
      error: () => {
        if (this.userSource == null) {
          this.geoStatus = 'no-geo';
        }
        this.cdr.markForCheck();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Calibration Nord (méthodes dans une modale, validation par bouton) */
  /* ------------------------------------------------------------------ */

  openCalModal(): void {
    if (this.calStatus === 'calibrated' && this.northOffsetDeg != null) {
      this.calBackup = {
        offset: this.northOffsetDeg,
        method: this.calMethod,
        persisted: this.calPersisted
      };
      this.calStatus = 'uncalibrated';
      this.calMethod = null;
      this.mouseNorthDraft = false;
      this.mouseCalDragging = false;
    } else if (this.calMethod === 'mouse') {
      this.calMethod = null;
      this.mouseNorthDraft = false;
      this.mouseCalDragging = false;
      this.mouseVirtualActive = false;
    }
    this.calModalOpen = true;
    this.cdr.markForCheck();
  }

  closeCalModal(): void {
    if (this.calStatus === 'calibrating') {
      this.cancelCalibration();
      return;
    }
    if (this.calStatus === 'uncalibrated' && this.calMethod != null && this.calMethod !== 'mouse') {
      this.calMethod = null;
    }
    this.restoreCalBackupIfNeeded();
    this.calModalOpen = false;
    this.cdr.markForCheck();
  }

  private clearCalBackup(): void {
    this.calBackup = null;
  }

  private restoreCalBackupIfNeeded(): void {
    if (!this.calBackup || this.calStatus === 'calibrated') {
      this.calBackup = null;
      return;
    }
    this.northOffsetDeg = this.calBackup.offset;
    this.calMethod = this.calBackup.method;
    this.calPersisted = this.calBackup.persisted;
    this.calStatus = 'calibrated';
    this.mouseVirtualActive = this.calBackup.method === 'mouse';
    this.mouseNorthDraft = false;
    this.applyNorthOffset();
    this.calBackup = null;
  }

  backCalMethod(): void {
    this.northEngine.cancelCal();
    this.calMethod = null;
    this.calStatus = 'uncalibrated';
    this.calAccum = [];
    this.calSamples = 0;
    this.cdr.markForCheck();
  }

  chooseCalMethod(method: 'sensor' | 'manual' | 'gps' | 'sun' | 'mouse'): void {
    this.clearCalBackup();
    this.calMethod = method;
    this.mouseCalDragging = false;
    this.mouseNorthDraft = false;
    if (method === 'sensor') {
      this.startNordFigure8Cal();
      return;
    } else if (method === 'gps') {
      this.mouseVirtualActive = false;
      this.calStatus = 'calibrating';
      this.calAccum = [];
      this.calSamples = 0;
    } else if (method === 'mouse') {
      // Ferme la modale pour laisser cliquer / glisser sur le cadran.
      this.northOffsetDeg = null;
      this.calPersisted = false;
      this.mouseVirtualActive = false;
      this.calStatus = 'uncalibrated';
      this.calModalOpen = false;
      this.applyNorthOffset();
    } else {
      this.mouseVirtualActive = false;
      this.calStatus = 'uncalibrated';
    }
    this.cdr.markForCheck();
  }

  /** Même calage que la page Nord : figure-8, pause, verrouillage gyro. */
  startNordFigure8Cal(): void {
    this.clearCalBackup();
    this.mouseVirtualActive = false;
    this.mouseCalDragging = false;
    this.mouseNorthDraft = false;
    this.northOffsetDeg = 0;
    this.calMethod = 'sensor';
    this.calStatus = 'calibrating';
    this.calPersisted = false;
    this.calModalOpen = false;
    this.octantMask = 0;
    this.northEngine.startFigure8();
    this.applyNorthOffset();
    this.cdr.markForCheck();
  }

  resetNordFigure8Cal(): void {
    this.northEngine.resetHardIron();
    this.northOffsetDeg = 0;
    this.calMethod = null;
    this.calStatus = 'uncalibrated';
    this.calPersisted = false;
    this.applyNorthOffset();
    this.cdr.markForCheck();
  }

  confirmManualNorth(): void {
    const raw = this.headingInstantDeg ?? this.headingRawDeg;
    if (raw == null) {
      return;
    }
    const offset = this.normalizeDeg(-raw);
    this.northOffsetDeg = offset;
    this.calMethod = 'manual';
    this.calStatus = 'calibrated';
    this.applyNorthOffset();
    this.persistCalibration('manual', offset);
    this.calModalOpen = false;
    this.cdr.markForCheck();
  }

  confirmSunCalibration(): void {
    const az = this.sunAzimuthDeg();
    const raw = this.headingInstantDeg ?? this.headingRawDeg;
    if (az == null || raw == null) {
      return;
    }
    const offset = this.normalizeDeg(az - raw);
    this.northOffsetDeg = offset;
    this.calMethod = 'sun';
    this.calStatus = 'calibrated';
    this.applyNorthOffset();
    this.persistCalibration('sun', offset);
    this.calModalOpen = false;
    this.cdr.markForCheck();
  }

  confirmMouseNorth(): void {
    if (this.northOffsetDeg == null || this.calMethod !== 'mouse') {
      return;
    }
    this.calStatus = 'calibrated';
    this.mouseNorthDraft = false;
    this.mouseCalDragging = false;
    this.mouseAimDeg = null;
    this.persistCalibration('mouse', this.northOffsetDeg);
    this.cdr.markForCheck();
  }

  cancelCalibration(): void {
    this.mouseCalDragging = false;
    this.northEngine.cancelCal();
    if (this.calMethod === 'mouse' && this.mouseNorthDraft && !this.calPersisted) {
      this.northOffsetDeg = null;
      this.mouseVirtualActive = false;
      this.mouseNorthDraft = false;
      this.mouseAimDeg = null;
      this.applyNorthOffset();
    }
    this.calAccum = [];
    this.calSamples = 0;
    this.calModalOpen = false;
    if (this.calBackup) {
      this.restoreCalBackupIfNeeded();
    } else if (this.northOffsetDeg != null && this.calPersisted) {
      this.calStatus = 'calibrated';
    } else {
      this.calStatus = 'uncalibrated';
      this.calMethod = null;
      this.mouseVirtualActive = false;
      this.mouseNorthDraft = false;
    }
    this.cdr.markForCheck();
  }

  restartCalibration(openModal = true): void {
    this.clearCalBackup();
    this.northEngine.cancelCal();
    this.calStatus = 'uncalibrated';
    this.calMethod = null;
    this.northOffsetDeg = null;
    this.calPersisted = false;
    this.calAccum = [];
    this.calSamples = 0;
    this.mouseCalDragging = false;
    this.mouseNorthDraft = false;
    this.mouseVirtualActive = false;
    this.mouseAimDeg = null;
    this.applyNorthOffset();
    this.calModalOpen = openModal;
    this.cdr.markForCheck();
  }

  /** Cadran interactif pour caler le Nord à la souris. */
  isMouseCalMode(): boolean {
    return this.calMethod === 'mouse' && this.calStatus === 'uncalibrated';
  }

  onDialPointerDown(ev: PointerEvent): void {
    if (this.calMethod !== 'mouse' || this.calStatus !== 'uncalibrated') {
      return;
    }
    const dial = ev.currentTarget as HTMLElement | null;
    if (!dial) {
      return;
    }
    dial.setPointerCapture?.(ev.pointerId);
    this.mouseCalDragging = true;
    this.applyMouseNorthFromEvent(ev, dial);
    ev.preventDefault();
  }

  onDialPointerMove(ev: PointerEvent): void {
    if (!this.mouseCalDragging || this.calMethod !== 'mouse' || this.calStatus !== 'uncalibrated') {
      return;
    }
    const dial = ev.currentTarget as HTMLElement | null;
    if (!dial) {
      return;
    }
    this.applyMouseNorthFromEvent(ev, dial);
    ev.preventDefault();
  }

  onDialPointerUp(ev: PointerEvent): void {
    if (!this.mouseCalDragging || this.calMethod !== 'mouse' || this.calStatus !== 'uncalibrated') {
      return;
    }
    const dial = ev.currentTarget as HTMLElement | null;
    if (dial) {
      this.applyMouseNorthFromEvent(ev, dial);
      try {
        dial.releasePointerCapture?.(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
    this.mouseCalDragging = false;
    // Prévisualisation seulement — validation via confirmMouseNorth().
    this.cdr.markForCheck();
    ev.preventDefault();
  }

  /**
   * Angle clic (0 = haut du cadran / lubber, sens horaire) → Nord.
   * Sans capteur : offset = −α avec raw virtuel à 0.
   * Avec capteur : offset = −α − raw.
   */
  private applyMouseNorthFromEvent(ev: PointerEvent, dial: HTMLElement): void {
    const rect = dial.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      return;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = ev.clientX - cx;
    const dy = ev.clientY - cy;
    if (dx * dx + dy * dy < 4) {
      return;
    }
    // 0° = haut, sens horaire (comme la boussole).
    const alphaDeg = this.normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
    this.mouseAimDeg = alphaDeg;
    const sensorRaw =
      this.headingSource != null && !this.mouseVirtualActive
        ? this.headingInstantDeg ?? this.headingRawDeg
        : null;

    if (sensorRaw != null && Number.isFinite(sensorRaw)) {
      this.mouseVirtualActive = false;
      this.northOffsetDeg = this.normalizeDeg(-alphaDeg - sensorRaw);
    } else {
      this.mouseVirtualActive = true;
      this.headingRawDeg = 0;
      this.headingInstantDeg = 0;
      this.headingActive = true;
      this.headingSource = null;
      this.northOffsetDeg = this.normalizeDeg(-alphaDeg);
    }
    this.calMethod = 'mouse';
    this.mouseNorthDraft = true;
    this.applyNorthOffset();
    this.cdr.markForCheck();
  }

  manualReady(): boolean {
    return this.headingActive && (this.headingInstantDeg != null || this.headingRawDeg != null);
  }

  needsCalibration(): boolean {
    return this.headingActive && this.calStatus !== 'calibrated';
  }

  isCalibrated(): boolean {
    return this.calStatus === 'calibrated';
  }

  isAutoSensorMode(): boolean {
    return this.calMethod === 'sensor';
  }

  calProgressPercent(): number {
    if (this.calNeededSamples <= 0) {
      return 0;
    }
    const pct = (this.calSamples / this.calNeededSamples) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  walkingFastEnough(): boolean {
    return this.walkSpeedMps != null && this.walkSpeedMps >= this.calMinSpeedMps;
  }

  showLiveSensorValues(): boolean {
    return (
      this.headingActive &&
      (this.isAutoSensorMode() || (this.calMethod == null && this.isMobileDevice()))
    );
  }

  private loadCalibration(): void {
    this.calLoadPending = true;
    this.api.getIssCompassCalibration().subscribe({
      next: (cal: IssCompassCalibration | null) => {
        this.calLoadPending = false;
        if (cal && this.isKnownCalMethod(cal.method)) {
          if (this.calStatus === 'uncalibrated' && this.calMethod == null) {
            // Sur téléphone : calage souris PC ignoré → Cap appareil (= magnétomètre) = Nord.
            if ((cal.method === 'mouse' || cal.method === 'sensor') && this.isMobileDevice()) {
              this.useMagneticNorthFromSensors(cal.method !== 'sensor');
              this.cdr.markForCheck();
              return;
            }
            const offset = Number.isFinite(cal.northOffsetDeg)
              ? this.normalizeDeg(cal.northOffsetDeg)
              : 0;
            this.northOffsetDeg = offset;
            this.calMethod = cal.method;
            this.calStatus = 'calibrated';
            this.calPersisted = true;
            if (cal.method === 'mouse') {
              // Sans capteur : le cap affiché = offset (raw virtuel 0).
              this.mouseVirtualActive = true;
              this.headingRawDeg = 0;
              this.headingInstantDeg = 0;
              this.headingActive = true;
              this.headingSource = null;
            }
            this.applyNorthOffset();
          }
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.calLoadPending = false;
        this.cdr.markForCheck();
      }
    });
  }

  /**
   * Nord = lecture magnétomètre seule (offset 0).
   * À utiliser sur smartphone quand un ancien calage (souris / manuel) décale la rose.
   */
  useMagneticNorthFromSensors(persist = true): void {
    this.mouseVirtualActive = false;
    this.mouseCalDragging = false;
    this.mouseNorthDraft = false;
    this.mouseAimDeg = null;
    this.northOffsetDeg = 0;
    this.calMethod = 'sensor';
    this.calStatus = 'calibrated';
    this.applyNorthOffset();
    if (persist) {
      this.persistCalibration('sensor', 0);
    } else {
      this.calPersisted = false;
    }
    this.cdr.markForCheck();
  }

  /** Un offset non nul décale le Nord par rapport au magnétomètre. */
  hasNorthOffset(): boolean {
    return this.northOffsetDeg != null && Math.abs(this.circularDiffDeg(this.northOffsetDeg, 0)) > 0.5;
  }

  calMethodLabelKey(): string | null {
    switch (this.calMethod) {
      case 'sensor':
        return 'ASTRO_COMPASS.CAL_METHOD_AUTO';
      case 'manual':
        return 'ASTRO_COMPASS.CAL_METHOD_MANUAL';
      case 'gps':
        return 'ASTRO_COMPASS.CAL_METHOD_GPS';
      case 'sun':
        return 'ASTRO_COMPASS.CAL_METHOD_SUN';
      case 'mouse':
        return 'ASTRO_COMPASS.CAL_METHOD_MOUSE';
      default:
        return null;
    }
  }

  private persistCalibration(
    method: 'sensor' | 'manual' | 'gps' | 'sun' | 'mouse',
    northOffsetDeg: number
  ): void {
    this.calSaving = true;
    this.cdr.markForCheck();
    this.api
      .setIssCompassCalibration({
        method,
        northOffsetDeg: this.normalizeDeg(northOffsetDeg),
        calibratedAt: new Date().toISOString()
      })
      .subscribe({
        next: () => {
          this.zone.run(() => {
            this.calPersisted = true;
            this.calSaving = false;
            this.cdr.markForCheck();
          });
        },
        error: () => {
          this.zone.run(() => {
            this.calPersisted = false;
            this.calSaving = false;
            this.cdr.markForCheck();
          });
        }
      });
  }

  private isKnownCalMethod(
    method: string | null | undefined
  ): method is 'sensor' | 'manual' | 'gps' | 'sun' | 'mouse' {
    return (
      method === 'sensor' ||
      method === 'manual' ||
      method === 'gps' ||
      method === 'sun' ||
      method === 'mouse'
    );
  }

  private ingestGpsCourse(coords: GeolocationCoordinates, timestampMs?: number): void {
    const speed =
      Number.isFinite(coords.speed as number) && (coords.speed as number) >= 0
        ? (coords.speed as number)
        : null;
    this.walkSpeedMps = speed;

    const tMs = Number.isFinite(timestampMs as number) ? (timestampMs as number) : Date.now();
    let course = Number.isFinite(coords.heading as number) ? (coords.heading as number) : null;
    const lat = coords.latitude;
    const lon = coords.longitude;
    const prev = this.gpsPrev;
    if (prev != null && Number.isFinite(lat) && Number.isFinite(lon)) {
      const dtSec = (tMs - prev.tMs) / 1000;
      const distM = AstroCompassComponent.haversineGreatCircleKm(prev.lat, prev.lon, lat, lon) * 1000;
      if (dtSec > 0.4 && dtSec < 8 && distM > 2.5) {
        const derivedSpeed = distM / dtSec;
        if (speed == null || speed < derivedSpeed) {
          this.walkSpeedMps = derivedSpeed;
        }
        if (course == null) {
          course = AstroCompassComponent.initialBearingDeg(prev.lat, prev.lon, lat, lon);
        }
      }
    }
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      this.gpsPrev = { lat, lon, tMs };
    }

    if (this.calStatus !== 'calibrating' || this.calMethod !== 'gps') {
      return;
    }
    const sensorHeading = this.headingInstantDeg ?? this.headingRawDeg;
    const walkSpeed = this.walkSpeedMps;
    if (
      course == null ||
      walkSpeed == null ||
      walkSpeed < this.calMinSpeedMps ||
      sensorHeading == null
    ) {
      return;
    }
    this.calAccum.push(this.normalizeDeg(course - sensorHeading));
    this.calSamples = this.calAccum.length;
    if (this.calSamples >= this.calNeededSamples) {
      const offset = this.circularMeanDeg(this.calAccum);
      this.northOffsetDeg = offset;
      this.calStatus = 'calibrated';
      this.calMethod = 'gps';
      this.calAccum = [];
      this.applyNorthOffset();
      this.persistCalibration('gps', offset);
      this.calModalOpen = false;
      this.cdr.markForCheck();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Orientation appareil (AbsoluteOrientation → webkit → DO)            */
  /* ------------------------------------------------------------------ */

  private async startOrientation(): Promise<void> {
    const doe: any =
      typeof window !== 'undefined' ? (window as any).DeviceOrientationEvent : undefined;
    const dme: any =
      typeof window !== 'undefined' ? (window as any).DeviceMotionEvent : undefined;
    if (doe && typeof doe.requestPermission === 'function') {
      try {
        const res = await doe.requestPermission();
        if (res !== 'granted') {
          return;
        }
      } catch {
        return;
      }
    }
    if (dme && typeof dme.requestPermission === 'function') {
      try {
        await dme.requestPermission();
      } catch {
        /* optional */
      }
    }

    this.startNorthSensors();
    this.startDeviceMotion();

    if (await this.tryStartAbsoluteSensor()) {
      // Abs sensor pour le cap ; DeviceOrientation reste utile pour beta/gamma (inclinaison).
      this.startOrientationListenerOnly();
      return;
    }

    if (!doe) {
      return;
    }
    this.startOrientationListenerOnly();
  }

  /** Écoute DeviceOrientation / Absolute (après permission iOS déjà demandée). */
  private startOrientationListenerOnly(): void {
    if (this.orientationListening) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    const absolute = 'ondeviceorientationabsolute' in window;
    this.orientationEventName = absolute ? 'deviceorientationabsolute' : 'deviceorientation';
    const evtName = this.orientationEventName;
    this.zone.runOutsideAngular(() => {
      window.addEventListener(evtName, this.handleOrientation as EventListener, true);
    });
    this.orientationListening = true;
  }

  private startNorthSensors(): void {
    if (this.northSensorsStarted || typeof window === 'undefined') {
      return;
    }
    this.northSensorsStarted = true;
    this.northEngine.loadPersisted();
    const w = window as unknown as Record<string, unknown>;
    this.tryNorthGeneric(
      w['Magnetometer'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        this.northEngine.hasMag = true;
        this.onNorthMagSample(s.x ?? 0, s.y ?? 0, s.z ?? 0);
      }
    );
    this.tryNorthGeneric(
      w['Accelerometer'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        const x = s.x ?? 0;
        const y = s.y ?? 0;
        const z = s.z ?? 0;
        if (!this.accelFromGeneric) {
          this.northEngine.accel = { x, y, z };
          this.northEngine.hasAccel = true;
          this.accelFromGeneric = true;
        }
        this.onNorthAccelSample(x, y, z);
      }
    );
    this.tryNorthGeneric(
      w['GravitySensor'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        const x = s.x ?? 0;
        const y = s.y ?? 0;
        const z = s.z ?? 0;
        this.northEngine.accel = { x, y, z };
        this.northEngine.hasAccel = true;
        this.accelFromGeneric = true;
        this.onNorthAccelSample(x, y, z);
      }
    );
    this.tryNorthGeneric(
      w['Gyroscope'] as (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
      (s) => {
        this.northEngine.gyro = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
        this.northEngine.hasGyro = true;
        this.gyroFromGeneric = true;
        this.tickNorthGyro();
      }
    );
  }

  private tryNorthGeneric(
    Ctor: (new (opts: { frequency: number }) => GenericSensorLike) | undefined,
    onReading: (s: GenericSensorLike) => void
  ): void {
    if (typeof Ctor !== 'function') {
      return;
    }
    try {
      const sensor = new Ctor({ frequency: NORTH_SENSOR_HZ });
      const reading = (): void => onReading(sensor);
      sensor.addEventListener('reading', reading);
      sensor.addEventListener('error', () => {
        /* ignore */
      });
      sensor.start();
      this.liveNorthSensors.push(sensor);
    } catch {
      /* permission / unsupported */
    }
  }

  private startDeviceMotion(): void {
    if (this.motionListening || typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      window.addEventListener('devicemotion', this.handleDeviceMotion, true);
    });
    this.motionListening = true;
  }

  private handleDeviceMotion = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    if (!this.accelFromGeneric && a?.x != null && a.y != null && a.z != null) {
      this.northEngine.accel = { x: a.x, y: a.y, z: a.z };
      this.northEngine.hasAccel = true;
      this.onNorthAccelSample(a.x, a.y, a.z);
    }
    const r = e.rotationRate;
    if (this.gyroFromGeneric || r?.alpha == null || r.beta == null || r.gamma == null) {
      return;
    }
    const k = Math.PI / 180;
    this.northEngine.gyro = { x: r.beta * k, y: r.gamma * k, z: r.alpha * k };
    this.northEngine.hasGyro = true;
    this.tickNorthGyro();
  };

  private onNorthMagSample(x: number, y: number, z: number): void {
    if (
      this.northEngine.calPhase === 'figure8' &&
      this.northEngine.ingestFigure8Mag(x, y, z)
    ) {
      this.beginSensorSettle();
    }
    this.syncCalOctants();
    const c = this.northEngine.correctMag(x, y, z);
    const heading = this.northEngine.headingFromMagAccel(
      c.x,
      c.y,
      c.z,
      this.currentScreenAngle()
    );
    if (heading != null) {
      this.lastMagHeadingInstant = heading;
      this.publishMagNorthHeading(heading);
    }
    this.paintCalNow();
  }

  private onNorthAccelSample(x: number, y: number, z: number): void {
    this.updatePitchFromAccel();
    if (this.northEngine.calPhase === 'figure8' && this.northEngine.ingestFigure8Accel(x, y, z)) {
      this.beginSensorSettle();
    }
    this.syncCalOctants();
    this.paintCalNow();
  }

  private syncCalOctants(): void {
    this.octantMask = this.northEngine.octantMask;
  }

  isOctantLit(bit: number): boolean {
    return (this.octantMask & (1 << bit)) !== 0;
  }

  private paintCalNow(): void {
    if (this.northEngine.calPhase !== 'figure8' && this.northEngine.calPhase !== 'settle') {
      return;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.calPaintLastMs < 40) {
      return;
    }
    this.calPaintLastMs = now;
    this.zone.run(() => this.cdr.detectChanges());
  }

  private publishMagNorthHeading(raw: number): void {
    if (this.mouseVirtualActive && this.calMethod === 'mouse') {
      return;
    }
    if (!this.usesMagnetometerHeading()) {
      return;
    }
    const locked = this.calStatus === 'calibrated' && this.calMethod === 'sensor';
    const fused = this.northEngine.fuseMagHeading(raw, locked);
    this.headingInstantDeg = fused;
    this.headingRawDeg = fused;
    this.applyNorthOffset();
    this.headingActive = true;
    this.headingSource = 'magnetometer';
    this.sensorAbsolute = true;
    this.scheduleHeadingPaint();
  }

  private tickNorthGyro(): void {
    if (!this.usesGyroFusion()) {
      return;
    }
    const locked = this.calStatus === 'calibrated' && this.calMethod === 'sensor';
    const fused = this.northEngine.tickGyro(locked);
    if (fused == null) {
      return;
    }
    this.headingInstantDeg = fused;
    this.headingRawDeg = fused;
    this.applyNorthOffset();
    this.headingActive = true;
    this.scheduleHeadingPaint();
  }

  private beginSensorSettle(): void {
    if (this.northEngine.calPhase === 'settle') {
      return;
    }
    this.northEngine.beginSettle(
      () => this.finishSensorCal(),
      () => this.scheduleHeadingPaint()
    );
    this.scheduleHeadingPaint();
  }

  private finishSensorCal(): void {
    this.northOffsetDeg = 0;
    this.calMethod = 'sensor';
    this.calStatus = 'calibrated';
    this.applyNorthOffset();
    this.persistCalibration('sensor', 0);
    this.calModalOpen = false;
    this.zone.run(() => this.cdr.markForCheck());
  }

  sensorCalProgressPct(): number {
    return this.northEngine.calProgressPct;
  }

  sensorSettlePercent(): number {
    return Math.max(0, Math.min(100, 100 - this.northEngine.settleRemainMs / 18));
  }

  private scheduleHeadingPaint(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.headingLastPaintMs < HEADING_PAINT_MIN_MS) {
      return;
    }
    this.headingLastPaintMs = now;
    this.zone.run(() => this.cdr.markForCheck());
  }

  usesMagnetometerHeading(): boolean {
    return this.northHeadingMode === 'mag' || this.northHeadingMode === 'mag-gyro';
  }

  usesGyroFusion(): boolean {
    return this.northHeadingMode === 'mag-gyro';
  }

  /** Yaw OS + rappel lent vers le mag s’ils sont d’accord. */
  private blendOsWithMagnetometer(): void {
    if (this.northHeadingMode !== 'os-mag' || this.headingRawDeg == null || this.lastMagHeadingInstant == null) {
      return;
    }
    const diff = Math.abs(this.circularDiffDeg(this.lastMagHeadingInstant, this.headingRawDeg));
    if (diff > OS_MAG_AGREE_DEG) {
      return;
    }
    this.headingRawDeg = this.circularLerpDeg(
      this.headingRawDeg,
      this.lastMagHeadingInstant,
      OS_MAG_PULL
    );
  }

  northHeadingModeTitleKey(): string {
    const opt = this.northHeadingModeOptions.find((o) => o.id === this.northHeadingMode);
    return opt?.titleKey ?? 'ASTRO_COMPASS.NORTH_MODE_OS_YAW';
  }

  setNorthHeadingMode(mode: NorthHeadingMode): void {
    this.northHeadingModeLoadGen++;
    this.applyNorthHeadingMode(mode, true);
  }

  private applyNorthHeadingMode(mode: NorthHeadingMode, persistRemote: boolean): void {
    const changed = this.northHeadingMode !== mode;
    this.northHeadingMode = mode;
    this.writeNorthHeadingModeLocal(mode);
    this.northHeadingModePersisted = true;
    if (changed) {
      this.headingSampleBuf = [];
      this.headingOutlierPendingDeg = null;
      this.headingRawDeg = null;
      this.headingInstantDeg = null;
      this.northEngine.resetFusion();
      if (this.usesMagnetometerHeading()) {
        if (this.lastMagHeadingInstant != null) {
          this.publishMagNorthHeading(this.lastMagHeadingInstant);
        }
      } else if (this.lastOrientationEvent) {
        this.handleOrientation(this.lastOrientationEvent);
      }
    }
    if (persistRemote) {
      this.persistNorthHeadingModeRemote(mode);
    }
    this.cdr.markForCheck();
  }

  private writeNorthHeadingModeLocal(mode: NorthHeadingMode): void {
    this.writeUserLocal(NORTH_HEADING_MODE_KEY, mode);
  }

  private persistNorthHeadingModeRemote(mode: NorthHeadingMode): void {
    this.api.setCompassHeadingMode(mode).subscribe({
      next: () => {
        this.zone.run(() => {
          this.northHeadingModePersisted = true;
          this.cdr.markForCheck();
        });
      },
      error: () => {
        /* hors connexion / anonyme : le localStorage suffit */
      }
    });
  }

  private loadNorthHeadingModePref(): void {
    const raw = this.readUserLocal(NORTH_HEADING_MODE_KEY);
    if (raw && (NORTH_HEADING_MODE_IDS as ReadonlyArray<string>).includes(raw)) {
      this.northHeadingMode = raw as NorthHeadingMode;
      this.northHeadingModePersisted = true;
    }
    const gen = ++this.northHeadingModeLoadGen;
    this.api.getCompassHeadingMode().subscribe({
      next: (dto) => {
        if (gen !== this.northHeadingModeLoadGen) {
          return;
        }
        const mode = dto?.headingMode;
        if (mode && (NORTH_HEADING_MODE_IDS as ReadonlyArray<string>).includes(mode)) {
          this.applyNorthHeadingMode(mode as NorthHeadingMode, false);
        }
      },
      error: () => {
        /* anonyme ou API indisponible : on garde le localStorage */
      }
    });
  }

  private async tryStartAbsoluteSensor(): Promise<boolean> {
    // Galaxy S23 / Chrome Android : privilégier deviceorientationabsolute.
    // AbsoluteOrientationSensor (quaternion) mélange parfois les axes Terre
    // (X=Est / Y=Nord) → cap décalé d'environ 90°. La doc W3C / Chrome pour
    // une boussole Android recommande α absolu : heading ≈ 360 − alpha.
    if (this.isAndroidDevice()) {
      return false;
    }
    const Ctor = typeof window !== 'undefined' ? (window as any).AbsoluteOrientationSensor : null;
    if (typeof Ctor !== 'function') {
      return false;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
        const names = ['accelerometer', 'gyroscope', 'magnetometer'] as const;
        for (const name of names) {
          try {
            const status = await navigator.permissions.query({ name: name as PermissionName });
            if (status.state === 'denied') {
              return false;
            }
          } catch {
            /* PermissionName non reconnu */
          }
        }
      }
      let sensor: any = null;
      let screenFrame = true;
      try {
        sensor = new Ctor({ frequency: ABS_ORIENTATION_HZ, referenceFrame: 'screen' });
      } catch {
        sensor = new Ctor({ frequency: ABS_ORIENTATION_HZ, referenceFrame: 'device' });
        screenFrame = false;
      }
      this.absSensor = sensor;
      this.absSensorScreenFrame = screenFrame;
      sensor.addEventListener('reading', this.handleAbsSensorReading);
      sensor.addEventListener('error', this.handleAbsSensorError);
      sensor.start();
      this.headingSource = 'absolute-sensor';
      this.sensorAbsolute = true;
      return true;
    } catch {
      this.absSensor = null;
      this.absSensorScreenFrame = false;
      return false;
    }
  }

  private handleAbsSensorError = (): void => {
    if (this.absSensor) {
      try {
        this.absSensor.removeEventListener('reading', this.handleAbsSensorReading);
        this.absSensor.removeEventListener('error', this.handleAbsSensorError);
        this.absSensor.stop();
      } catch {
        /* ignore */
      }
      this.absSensor = null;
    }
    if (!this.orientationListening) {
      void this.startOrientationDeviceFallback();
    }
  };

  private async startOrientationDeviceFallback(): Promise<void> {
    this.startOrientationListenerOnly();
  }

  private handleAbsSensorReading = (): void => {
    const sensor = this.absSensor;
    if (!sensor?.quaternion || sensor.quaternion.length < 4) {
      return;
    }
    let heading = this.headingFromAbsoluteQuaternion(sensor.quaternion);
    if (heading == null) {
      return;
    }
    if (!this.absSensorScreenFrame) {
      heading = this.normalizeDeg(heading - this.currentScreenAngle());
    }
    const pitch = this.orientationListening
      ? null
      : this.pitchFromAbsoluteQuaternion(sensor.quaternion);
    this.publishHeading(heading, {
      source: 'absolute-sensor',
      absolute: true,
      alpha: null,
      beta: null,
      gamma: null,
      pitch,
      webkitHeading: null,
      webkitAccuracy: null
    });
  };

  private handleOrientation = (e: DeviceOrientationEvent): void => {
    this.lastOrientationEvent = e;
    const beta = Number.isFinite(e.beta as number) ? (e.beta as number) : null;
    const gamma = Number.isFinite(e.gamma as number) ? (e.gamma as number) : null;
    const pitch = beta != null ? this.devicePitchFromBetaGamma(beta, gamma ?? 0) : null;

    // AbsoluteOrientationSensor gère déjà le cap ; DeviceOrientation sert alors au pitch.
    // Le magnétomètre brut ne doit PAS masquer 360−α / webkit (plus stable).
    if (this.absSensor != null) {
      if (pitch != null) {
        this.publishPitchOnly(pitch, {
          alpha: Number.isFinite(e.alpha as number) ? (e.alpha as number) : null,
          beta,
          gamma
        });
      }
      return;
    }

    const heading = this.deviceHeadingFromEvent(e);
    if (heading == null) {
      if (pitch != null) {
        this.publishPitchOnly(pitch, {
          alpha: Number.isFinite(e.alpha as number) ? (e.alpha as number) : null,
          beta,
          gamma
        });
      }
      return;
    }
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
        : this.orientationEventName === 'deviceorientationabsolute';
    const source = webkitHeading != null ? 'webkit' : 'deviceorientation';
    this.publishHeading(heading, {
      source,
      absolute: isAbsolute,
      alpha: Number.isFinite(e.alpha as number) ? (e.alpha as number) : null,
      beta,
      gamma,
      pitch,
      webkitHeading,
      webkitAccuracy: acc
    });
  };

  private publishHeading(
    heading: number,
    meta: {
      source: 'absolute-sensor' | 'webkit' | 'deviceorientation';
      absolute: boolean;
      alpha: number | null;
      beta: number | null;
      gamma: number | null;
      pitch: number | null;
      webkitHeading: number | null;
      webkitAccuracy: number | null;
    }
  ): void {
    // Calage souris sans capteurs : ne pas laisser le magnétomètre écraser le Nord choisi.
    if (this.mouseVirtualActive && this.calMethod === 'mouse') {
      return;
    }
    // Médiane puis lissage — réduit les sauts Samsung avant le lerp.
    const medianHeading = this.pushHeadingMedian(heading);
    // Sauts isolés > HEADING_OUTLIER_DEG : ignorer jusqu'à confirmation (2 lectures proches).
    let accepted = medianHeading;
    if (this.headingRawDeg != null) {
      const jump = Math.abs(this.circularDiffDeg(medianHeading, this.headingRawDeg));
      if (jump >= HEADING_OUTLIER_DEG) {
        if (
          this.headingOutlierPendingDeg != null &&
          Math.abs(this.circularDiffDeg(medianHeading, this.headingOutlierPendingDeg)) < 18
        ) {
          this.headingOutlierPendingDeg = null;
        } else {
          this.headingOutlierPendingDeg = medianHeading;
          accepted = this.headingRawDeg;
        }
      } else {
        this.headingOutlierPendingDeg = null;
      }
    }
    this.headingInstantDeg = accepted;
    // Cap OS déjà fusionné par le téléphone : lerp doux, pas de 2e intégration gyro.
    this.headingRawDeg =
      this.headingRawDeg == null
        ? accepted
        : this.circularLerpDeg(
            this.headingRawDeg,
            accepted,
            this.headingLerpFactor(this.headingRawDeg, accepted)
          );
    this.blendOsWithMagnetometer();
    this.northEngine.fusedHeading = this.headingRawDeg;
    if (
      this.calMethod === 'sensor' &&
      this.northEngine.calPhase === 'figure8' &&
      this.northEngine.ingestFigure8Heading(accepted)
    ) {
      this.beginSensorSettle();
    }
    this.syncCalOctants();
    this.paintCalNow();
    // Calage souris/tactile en cours : garder le N sur l'angle cliqué malgré le cap live.
    if (this.isMouseCalMode() && this.mouseAimDeg != null && this.headingRawDeg != null) {
      this.northOffsetDeg = this.normalizeDeg(-this.mouseAimDeg - this.headingRawDeg);
    }
    this.applyNorthOffset();
    this.headingAccuracyDeg = meta.webkitAccuracy;
    this.headingActive = true;
    this.headingSource = meta.source;
    this.sensorAlpha = meta.alpha;
    this.sensorBeta = meta.beta;
    this.sensorGamma = meta.gamma;
    this.sensorAbsolute = meta.absolute;
    this.sensorWebkitHeading = meta.webkitHeading;
    this.sensorWebkitAccuracy = meta.webkitAccuracy;
    this.applyDevicePitch(meta.pitch);
    this.scheduleHeadingPaint();
  }

  private publishPitchOnly(
    pitch: number,
    meta: { alpha: number | null; beta: number | null; gamma: number | null }
  ): void {
    if (this.mouseVirtualActive && this.calMethod === 'mouse') {
      return;
    }
    this.sensorAlpha = meta.alpha;
    this.sensorBeta = meta.beta;
    this.sensorGamma = meta.gamma;
    this.applyDevicePitch(pitch);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.pitchLastPaintMs < PITCH_PAINT_MIN_MS) {
      return;
    }
    this.pitchLastPaintMs = now;
    this.zone.run(() => {
      this.cdr.markForCheck();
    });
  }

  /**
   * Lerp adaptatif : filtre fort le bruit / petits sauts (Samsung),
   * suit un vrai virage une fois confirmé.
   */
  private headingLerpFactor(fromDeg: number, toDeg: number): number {
    const mag = Math.abs(this.circularDiffDeg(toDeg, fromDeg));
    if (mag < 0.2) {
      return 0;
    }
    if (mag >= HEADING_LERP_SNAP_DEG) {
      return HEADING_LERP_MAX;
    }
    const t = mag / HEADING_LERP_SNAP_DEG;
    return HEADING_LERP_MIN + (HEADING_LERP_MAX - HEADING_LERP_MIN) * t;
  }

  private applyDevicePitch(pitch: number | null): void {
    if (pitch == null || !Number.isFinite(pitch)) {
      return;
    }
    this.devicePitchInstantDeg = pitch;
    this.devicePitchDeg =
      this.devicePitchDeg == null
        ? pitch
        : this.devicePitchDeg * (1 - PITCH_SMOOTH_ALPHA) + pitch * PITCH_SMOOTH_ALPHA;
    this.tickAlignCue();
  }

  /**
   * Inclinaison signée comme la page Nord :
   * 0° = à plat (écran vers le ciel), + = haut vers le ciel, − = haut vers le sol.
   */
  private updatePitchFromAccel(): void {
    const up = this.northEngine.normalizeVec(
      this.northEngine.accel.x,
      this.northEngine.accel.y,
      this.northEngine.accel.z
    );
    if (!up) {
      return;
    }
    const sa = ((this.currentScreenAngle() % 360) + 360) % 360;
    let topX = 0;
    let topY = 1;
    if (sa === 90) {
      topX = 1;
      topY = 0;
    } else if (sa === 180) {
      topX = 0;
      topY = -1;
    } else if (sa === 270) {
      topX = -1;
      topY = 0;
    }
    const topDotUp = topX * up.x + topY * up.y;
    const pitch = (Math.atan2(topDotUp, up.z) * 180) / Math.PI;
    this.applyDevicePitch(pitch);
  }

  private stopSensors(): void {
    this.lookTracker.stop();
    this.stopCamera();
    this.northEngine.destroy();
    for (const s of this.liveNorthSensors) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    this.liveNorthSensors = [];
    this.northSensorsStarted = false;
    this.accelFromGeneric = false;
    this.gyroFromGeneric = false;

    if (this.motionListening) {
      window.removeEventListener('devicemotion', this.handleDeviceMotion, true);
      this.motionListening = false;
    }

    if (this.geoWatchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(this.geoWatchId);
      } catch {
        /* ignore */
      }
    }
    this.geoWatchId = null;
    this.gpsPrev = null;

    if (this.absSensor) {
      try {
        this.absSensor.removeEventListener('reading', this.handleAbsSensorReading);
        this.absSensor.removeEventListener('error', this.handleAbsSensorError);
        this.absSensor.stop();
      } catch {
        /* ignore */
      }
      this.absSensor = null;
    }

    if (this.orientationListening && this.orientationEventName) {
      window.removeEventListener(
        this.orientationEventName,
        this.handleOrientation as EventListener,
        true
      );
    }
    this.orientationListening = false;
    this.headingActive = false;
    this.resetSensorReadings();
    this.orientationEventName = null;
    this.headingSource = null;
  }

  private resetSensorReadings(): void {
    this.sensorAlpha = null;
    this.sensorBeta = null;
    this.sensorGamma = null;
    this.sensorAbsolute = null;
    this.sensorWebkitHeading = null;
    this.sensorWebkitAccuracy = null;
    this.headingInstantDeg = null;
    this.headingOutlierPendingDeg = null;
    this.headingSampleBuf = [];
    this.devicePitchInstantDeg = null;
    this.devicePitchDeg = null;
  }

  /** Médiane circulaire des derniers caps (anti-bruit). */
  private pushHeadingMedian(heading: number): number {
    this.headingSampleBuf.push(this.normalizeDeg(heading));
    while (this.headingSampleBuf.length > HEADING_MEDIAN_N) {
      this.headingSampleBuf.shift();
    }
    if (this.headingSampleBuf.length < 3) {
      return this.normalizeDeg(heading);
    }
    // Projeter sur un cercle centré sur la dernière valeur pour trier.
    const ref = this.headingSampleBuf[this.headingSampleBuf.length - 1];
    const sorted = this.headingSampleBuf
      .map((d) => this.circularDiffDeg(d, ref))
      .sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    return this.normalizeDeg(ref + mid);
  }

  private applyNorthOffset(): void {
    this.applyHeadingReference();
  }

  private applyHeadingReference(): void {
    const lookAz = this.lookTracker?.azimuthDeg ?? null;
    const raw = this.lookTracker?.rawAzimuthDeg ?? this.headingRawDeg;
    if (this.headingRef === 'cible' && this.activeCible?.phoneHeadingDeg != null && raw != null) {
      const h0 = this.activeCible.phoneHeadingDeg;
      const ref = this.activeCible.refAzimuthDeg ?? 0;
      this.headingDeg = this.normalizeDeg(raw - h0 + ref);
      this.headingActive = true;
      this.tickAlignCue();
      return;
    }
    if (lookAz != null) {
      this.headingDeg = lookAz;
      this.headingActive = true;
      this.tickAlignCue();
      return;
    }
    if (this.headingRawDeg == null) {
      this.headingDeg = null;
      return;
    }
    const offset =
      this.calMethod === 'sensor' || this.calMethod == null ? 0 : (this.northOffsetDeg ?? 0);
    this.headingDeg = this.normalizeDeg(this.headingRawDeg + offset);
    this.tickAlignCue();
  }

  sensorEventName(): string | null {
    if (this.headingSource === 'magnetometer') {
      return 'Magnetometer';
    }
    if (this.headingSource === 'absolute-sensor') {
      return 'AbsoluteOrientationSensor';
    }
    if (this.headingSource === 'webkit') {
      return 'webkitCompassHeading';
    }
    return this.orientationEventName;
  }

  screenAngleDeg(): number | null {
    return this.headingActive ? this.currentScreenAngle() : null;
  }

  /* ------------------------------------------------------------------ */
  /* Affichage boussole (rose, aiguille, consignes)                      */
  /* ------------------------------------------------------------------ */

  roseRotationDeg(): number {
    if (!this.headingActive || this.headingDeg == null) {
      return 0;
    }
    return this.northEngine.unwrapRose(this.headingDeg);
  }

  needleRotationDeg(): number {
    const az = this.azimuthDeg ?? 0;
    const target =
      this.headingActive && this.headingDeg != null
        ? this.normalizeDeg(az - this.headingDeg)
        : az;
    const r = this.northEngine.unwrapAngle(this.needleUnwrappedDeg, target, this.needleInited);
    this.needleUnwrappedDeg = r.value;
    this.needleInited = r.inited;
    return this.needleUnwrappedDeg;
  }

  cardinalLabel(deg: number | null = this.azimuthDeg): string {
    if (deg == null) {
      return '';
    }
    const idx = ((Math.round(deg / 22.5) % 16) + 16) % 16;
    const letters = AstroCompassComponent.COMPASS_POINTS[idx];
    return letters.map((l) => this.translate.instant('ASTRO_COMPASS.DIR_' + l)).join('');
  }

  headingCardinalLabel(): string {
    return this.cardinalLabel(this.headingDeg);
  }

  relativeInstruction(): { key: string; deg: number } | null {
    if (!this.headingActive || this.headingDeg == null || this.azimuthDeg == null) {
      return null;
    }
    const diff = this.circularDiffDeg(this.azimuthDeg, this.headingDeg);
    const mag = Math.abs(diff);
    if (mag <= FACING_THRESHOLD_DEG) {
      // Azimut OK — le message « face à la cible » n'apparaît que si l'inclinaison l'est aussi.
      if (this.isPitchAligned()) {
        return { key: 'ASTRO_COMPASS.FACING', deg: 0 };
      }
      return { key: 'ASTRO_COMPASS.TURN_OK', deg: 0 };
    }
    return {
      key: diff > 0 ? 'ASTRO_COMPASS.TURN_RIGHT' : 'ASTRO_COMPASS.TURN_LEFT',
      deg: Math.round(mag)
    };
  }

  directionArrow(): 'left' | 'right' | 'ok' | null {
    const instr = this.relativeInstruction();
    if (instr == null) {
      return null;
    }
    if (instr.key === 'ASTRO_COMPASS.TURN_LEFT') {
      return 'left';
    }
    if (instr.key === 'ASTRO_COMPASS.TURN_RIGHT') {
      return 'right';
    }
    return 'ok';
  }

  /**
   * Consigne d'inclinaison signée (même convention que la page Nord) :
   * 0° = à plat, + = haut vers le ciel, − = haut vers le sol.
   * delta = cible − actuel : +N° = incliner vers le positif, −N° vers le négatif.
   */
  tiltInstruction(): {
    key: string;
    hintKey: string;
    deg: number;
    delta: string;
    current: string;
    target: string;
  } | null {
    const target = this.targetPhoneTiltDeg();
    const current = this.devicePitchDeg;
    if (target == null || current == null || this.elevationDeg == null || this.elevationDeg < -1) {
      return null;
    }
    const diff = Math.round(target) - Math.round(current);
    const mag = Math.abs(diff);
    if (mag <= PITCH_THRESHOLD_DEG) {
      return {
        key: 'ASTRO_COMPASS.TILT_OK',
        hintKey: '',
        deg: 0,
        delta: this.formatSignedDeg(0),
        current: this.formatSignedDeg(Math.round(current)),
        target: this.formatSignedDeg(Math.round(target))
      };
    }
    return {
      key: diff > 0 ? 'ASTRO_COMPASS.TILT_PLUS' : 'ASTRO_COMPASS.TILT_MINUS',
      hintKey: diff > 0 ? 'ASTRO_COMPASS.TILT_HINT_PLUS' : 'ASTRO_COMPASS.TILT_HINT_MINUS',
      deg: mag,
      delta: this.formatSignedDeg(diff),
      current: this.formatSignedDeg(Math.round(current)),
      target: this.formatSignedDeg(Math.round(target))
    };
  }

  formatSignedDeg(deg: number | null): string {
    if (deg == null || !Number.isFinite(deg)) {
      return '—';
    }
    const n = Math.round(deg);
    return n > 0 ? `+${n}°` : `${n}°`;
  }

  turnDeltaDeg(): number | null {
    if (!this.headingActive || this.headingDeg == null || this.azimuthDeg == null) {
      return null;
    }
    return Math.round(this.circularDiffDeg(this.azimuthDeg, this.headingDeg));
  }

  /** Flèche d’inclinaison : haut = plus vertical (+), bas = plus à plat / vers le sol (−). */
  angleArrow(): 'up' | 'down' | 'ok' | null {
    if (!this.aboveHorizon()) {
      return 'down';
    }
    const tilt = this.tiltInstruction();
    if (tilt == null) {
      if ((this.elevationDeg ?? 0) >= 2) {
        return 'up';
      }
      return null;
    }
    if (tilt.key === 'ASTRO_COMPASS.TILT_OK') {
      return 'ok';
    }
    if (tilt.key === 'ASTRO_COMPASS.TILT_PLUS') {
      return 'up';
    }
    if (tilt.key === 'ASTRO_COMPASS.TILT_MINUS') {
      return 'down';
    }
    return null;
  }

  setAlignCue(mode: 'off' | 'beep' | 'vibrate'): void {
    this.applyAlignCue(mode, true);
    if (mode === 'beep') {
      this.ensureAlignAudio();
    }
    this.cdr.markForCheck();
  }

  private loadAlignCuePref(): void {
    const raw = this.readUserLocal(AstroCompassComponent.ALIGN_CUE_KEY);
    if (raw === 'off' || raw === 'beep' || raw === 'vibrate') {
      this.alignCue = raw;
    }
    const gen = ++this.alignCueLoadGen;
    this.api.getAstroAlignCue().subscribe({
      next: (dto) => {
        if (gen !== this.alignCueLoadGen) {
          return;
        }
        const mode = dto?.mode;
        if (mode === 'off' || mode === 'beep' || mode === 'vibrate') {
          this.applyAlignCue(mode, false);
        } else if (raw === 'off' || raw === 'beep' || raw === 'vibrate') {
          this.saveAlignCueRemote(raw);
        }
      },
      error: () => {
        /* anonyme / hors-ligne : le localStorage reste */
      }
    });
  }

  private applyAlignCue(mode: 'off' | 'beep' | 'vibrate', persistRemote: boolean): void {
    this.alignCue = mode;
    this.writeUserLocal(AstroCompassComponent.ALIGN_CUE_KEY, mode);
    if (persistRemote) {
      this.saveAlignCueRemote(mode);
    }
  }

  private saveAlignCueRemote(mode: 'off' | 'beep' | 'vibrate'): void {
    this.alignCueLoadGen++;
    this.alignCueSaveSub?.unsubscribe();
    this.alignCueSaveSub = this.api.setAstroAlignCue(mode).subscribe({
      error: () => {
        /* hors connexion / anonyme : le localStorage suffit */
      }
    });
  }

  /** Surnom Keycloak ({@code preferred_username}), jamais le {@code sub}. */
  private ownerUsername(): string | null {
    return this.keycloak.getPreferredUsername();
  }

  private userLocalKey(base: string): string {
    const u = this.ownerUsername();
    return u ? `${base}:${u}` : base;
  }

  private readUserLocal(base: string): string | null {
    try {
      const keyed = localStorage.getItem(this.userLocalKey(base));
      if (keyed != null && keyed !== '') {
        return keyed;
      }
      const legacy = localStorage.getItem(base);
      if (legacy == null || legacy === '') {
        return null;
      }
      const u = this.ownerUsername();
      if (u) {
        localStorage.setItem(this.userLocalKey(base), legacy);
      }
      return legacy;
    } catch {
      return null;
    }
  }

  private writeUserLocal(base: string, value: string): void {
    try {
      localStorage.setItem(this.userLocalKey(base), value);
    } catch {
      /* ignore */
    }
  }

  private targetPersistKey(payload: LastAstroTarget): string {
    return JSON.stringify({
      kind: payload.kind,
      id: payload.id ?? null,
      customRaHours: payload.customRaHours ?? null,
      customDecDeg: payload.customDecDeg ?? null,
      customName: payload.customName ?? ''
    });
  }

  private persistLastTarget(): void {
    if (!this.persistUserTarget || this.applyingAutoTarget || !this.userChoseTarget) {
      return;
    }
    const payload = this.currentLastTargetPayload();
    if (!payload) {
      return;
    }
    this.saveLastTarget(payload);
  }

  private saveLastTarget(payload: LastAstroTarget): void {
    this.writeLastTargetLocal(payload);
    const key = this.targetPersistKey(payload);
    if (key === this.lastPersistedTargetJson) {
      return;
    }
    this.lastTargetLoadGen++;
    this.lastTargetSaveSub?.unsubscribe();
    this.lastTargetSaveSub = this.api.setAstroLastTarget(payload).subscribe({
      next: () => {
        this.lastPersistedTargetJson = key;
      },
      error: () => {
        /* hors connexion / anonyme : le localStorage suffit */
      }
    });
  }

  private currentLastTargetPayload(): LastAstroTarget | null {
    const payload: LastAstroTarget = { kind: this.selectedKind };
    if (this.selectedKind === 'planet') {
      payload.id = this.selectedPlanetId;
    } else if (this.selectedKind === 'star') {
      payload.id = this.selectedStarId;
    } else if (this.selectedKind === 'galaxy') {
      payload.id = this.selectedGalaxyId;
    } else if (this.selectedKind === 'constellation') {
      payload.id = this.selectedConstellationId;
    } else if (this.selectedKind === 'iss') {
      payload.id = this.selectedSatelliteId;
    } else {
      payload.customRaHours = this.customRaHours;
      payload.customDecDeg = this.customDecDeg;
      payload.customName = this.customName;
    }
    if (this.selectedKind !== 'custom' && !payload.id) {
      return null;
    }
    return payload;
  }

  private writeLastTargetLocal(payload: LastAstroTarget): void {
    this.writeUserLocal(AstroCompassComponent.LAST_TARGET_KEY, JSON.stringify(payload));
  }

  /** Mémorise le satellite du viseur pour que le globe le recadre au retour. */
  private writeGlobeReturnSat(satId?: string): void {
    const id = (satId || (this.selectedKind === 'iss' ? this.selectedSatelliteId : '') || '')
      .trim()
      .toLowerCase();
    if (!id || !findSatelliteById(id)) {
      return;
    }
    try {
      sessionStorage.setItem(AstroCompassComponent.GLOBE_ASTRO_RETURN_SAT_KEY, id);
    } catch {
      /* ignore */
    }
  }

  private readLastTargetLocal(): LastAstroTarget | null {
    const raw = this.readUserLocal(AstroCompassComponent.LAST_TARGET_KEY);
    if (!raw) {
      return null;
    }
    try {
      const data = JSON.parse(raw) as LastAstroTarget;
      return data?.kind ? data : null;
    } catch {
      return null;
    }
  }

  /** Dernier astre choisi à la main : revient tel quel à l’ouverture du viseur. */
  private restoreLastTarget(): boolean {
    const data = this.readLastTargetLocal();
    if (!data) {
      return false;
    }
    return this.applyLastTarget(data);
  }

  /** Lien globe (et autres) : `?target=hubble` force ce satellite, au-dessus du dernier astre mémorisé. */
  private readQueryTargetId(): string {
    return (this.route.snapshot.queryParamMap.get('target') || '').trim().toLowerCase();
  }

  private hasSatelliteQueryTarget(): boolean {
    const raw = this.readQueryTargetId();
    return !!raw && !!findSatelliteById(raw);
  }

  private applyQueryTarget(): boolean {
    const raw = this.readQueryTargetId();
    if (!raw || !findSatelliteById(raw)) {
      return false;
    }
    this.selectSatellite(raw);
    return true;
  }

  /** Compte connecté : la base gagne ; sinon on pousse le choix local vers Mongo. */
  private hydrateLastTargetFromDb(): void {
    if (this.hasSatelliteQueryTarget()) {
      return;
    }
    const gen = ++this.lastTargetLoadGen;
    const local = this.readLastTargetLocal();
    this.api.getAstroLastTarget().subscribe({
      next: (remote) => {
        if (gen !== this.lastTargetLoadGen) {
          return;
        }
        if (this.autoDetectModalOpen || this.autoDetectLive) {
          return;
        }
        if (remote?.kind) {
          this.applyLastTarget(remote);
          this.writeLastTargetLocal(remote);
          this.lastPersistedTargetJson = this.targetPersistKey(remote);
          this.cdr.markForCheck();
          return;
        }
        if (local) {
          this.saveLastTarget(local);
        }
      },
      error: () => {
        /* anonyme / hors-ligne : le localStorage reste */
      }
    });
  }

  private applyLastTarget(data: LastAstroTarget): boolean {
    if (!data?.kind) {
      return false;
    }
    this.persistUserTarget = false;
    try {
      if (data.kind === 'planet' && data.id && findPlanetById(data.id)) {
        this.selectPlanet(data.id);
        return true;
      }
      if (data.kind === 'star' && data.id) {
        const star = findStarById(data.id);
        if (!star) {
          return false;
        }
        this.selectStar(star);
        return true;
      }
      if (data.kind === 'galaxy' && data.id) {
        const galaxy = findGalaxyById(data.id);
        if (!galaxy) {
          return false;
        }
        this.selectGalaxy(galaxy);
        return true;
      }
      if (data.kind === 'constellation' && data.id) {
        const item = findConstellationById(data.id);
        if (!item) {
          return false;
        }
        this.selectConstellation(item);
        return true;
      }
      if (data.kind === 'iss' && data.id && findSatelliteById(data.id)) {
        this.selectSatellite(data.id);
        return true;
      }
      if (data.kind === 'custom') {
        const ra = Number(data.customRaHours);
        const dec = Number(data.customDecDeg);
        if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 24 || dec < -90 || dec > 90) {
          return false;
        }
        this.customRaHours = ra;
        this.customDecDeg = dec;
        this.customName = typeof data.customName === 'string' ? data.customName : '';
        this.applyCustomCoords();
        return this.selectedKind === 'custom';
      }
      return false;
    } finally {
      this.persistUserTarget = true;
    }
  }

  private tickAlignCue(): void {
    const locked = !!this.finderProj?.centered && this.aboveHorizon();
    if (this.alignCue === 'off') {
      this.alignCuePrevBoth = locked;
      return;
    }
    if (locked && !this.alignCuePrevBoth) {
      this.fireAlignCue(2);
    }
    this.alignCuePrevBoth = locked;
  }

  private fireAlignCue(count: 1 | 2): void {
    if (this.alignCue === 'vibrate') {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(count === 1 ? 90 : [90, 110, 90]);
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (this.alignCue === 'beep') {
      this.playAlignBeeps(count);
    }
  }

  private ensureAlignAudio(): AudioContext | null {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
      return null;
    }
    if (this.alignAudioCtx == null) {
      this.alignAudioCtx = new Ctor();
    }
    const ctx = this.alignAudioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    return ctx;
  }

  private playAlignBeeps(count: 1 | 2): void {
    const ctx = this.ensureAlignAudio();
    if (!ctx) {
      return;
    }
    const beep = (at: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.14, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.13);
    };
    const t0 = ctx.currentTime;
    beep(t0);
    if (count === 2) {
      beep(t0 + 0.2);
    }
  }

  private closeAlignAudio(): void {
    if (this.alignAudioCtx) {
      try {
        void this.alignAudioCtx.close();
      } catch {
        /* ignore */
      }
      this.alignAudioCtx = null;
    }
  }

  /**
   * Inclinaison téléphone attendue pour la cible (0° plat → 90° vertical, négatif = haut en bas).
   * Distincte de l'élévation ciel (0° horizon → 90° zénith) : tilt = 90° − élévation.
   */
  targetPhoneTiltDeg(): number | null {
    if (this.elevationDeg == null) {
      return null;
    }
    return 90 - this.elevationDeg;
  }

  /** Élévation de visée ciel (0° horizon, 90° zénith) depuis l'inclinaison téléphone. */
  deviceSkyElevationDeg(): number | null {
    if (this.devicePitchDeg == null) {
      return null;
    }
    return 90 - this.devicePitchDeg;
  }

  /** Écart consigne − inclinaison actuelle (même unité que la jauge). */
  private phoneTiltErrorDeg(): number | null {
    const target = this.targetPhoneTiltDeg();
    if (target == null || this.devicePitchDeg == null) {
      return null;
    }
    return target - this.devicePitchDeg;
  }

  /** Position 0–100 % sur la jauge −90° (bas) → 0° (milieu) → +90° (haut). */
  devicePitchGaugePercent(): number {
    return this.signedTiltToGaugePercent(this.devicePitchDeg);
  }

  targetPitchGaugePercent(): number {
    return this.signedTiltToGaugePercent(this.targetPhoneTiltDeg());
  }

  pitchFillHeightPct(): number {
    if (this.devicePitchDeg == null) {
      return 0;
    }
    return (Math.min(90, Math.abs(this.devicePitchDeg)) / 90) * 50;
  }

  pitchFillBottomPct(): number {
    if (this.devicePitchDeg == null || this.devicePitchDeg >= 0) {
      return 50;
    }
    return 50 - this.pitchFillHeightPct();
  }

  private signedTiltToGaugePercent(tilt: number | null): number {
    if (tilt == null || !Number.isFinite(tilt)) {
      return 50;
    }
    const p = Math.max(-90, Math.min(90, tilt));
    return ((p + 90) / 180) * 100;
  }

  aboveHorizon(): boolean {
    return this.elevationDeg != null && this.elevationDeg >= -1;
  }

  notVisibleName(): string {
    const n = this.bodyLabel?.trim();
    return n || this.translate.instant('ASTRO_COMPASS.LOOK_THE_OBJECT');
  }

  isPitchAligned(): boolean {
    const err = this.phoneTiltErrorDeg();
    if (err == null || this.elevationDeg == null || this.elevationDeg < -1) {
      // Sans inclinaison (desktop) : on ne bloque pas sur le pitch.
      return this.devicePitchDeg == null;
    }
    return Math.abs(err) <= PITCH_THRESHOLD_DEG;
  }

  isYawAligned(): boolean {
    if (!this.headingActive || this.headingDeg == null || this.azimuthDeg == null) {
      return false;
    }
    return Math.abs(this.circularDiffDeg(this.azimuthDeg, this.headingDeg)) < FACING_THRESHOLD_DEG;
  }

  isFacing(): boolean {
    if (
      !this.headingActive ||
      this.headingDeg == null ||
      this.azimuthDeg == null ||
      this.elevationDeg == null ||
      this.elevationDeg < -1
    ) {
      return false;
    }
    return this.isYawAligned() && this.isPitchAligned();
  }

  updatedAgoLabel(): string | null {
    if (this.updatedAtMs == null) {
      return null;
    }
    const diffSec = Math.max(0, Math.round((this.nowMs - this.updatedAtMs) / 1000));
    if (diffSec < 3) {
      return this.translate.instant('ASTRO_COMPASS.UPDATED_NOW');
    }
    if (diffSec < 60) {
      return this.translate.instant('ASTRO_COMPASS.UPDATED_AGO_S', { s: diffSec });
    }
    const diffMin = Math.round(diffSec / 60);
    return this.translate.instant('ASTRO_COMPASS.UPDATED_AGO_M', { m: diffMin });
  }

  /* ------------------------------------------------------------------ */
  /* Soleil (calibration + NOAA)                                         */
  /* ------------------------------------------------------------------ */

  sunAzimuthDeg(): number | null {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return null;
    }
    const sun = AstroCompassComponent.solarPosition(this.lat, this.lon, new Date(this.nowMs));
    if (sun.elevationDeg < -1) {
      return null;
    }
    return sun.azimuthDeg;
  }

  sunElevationDeg(): number | null {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      return null;
    }
    return AstroCompassComponent.solarPosition(this.lat, this.lon, new Date(this.nowMs)).elevationDeg;
  }

  sunBelowHorizon(): boolean {
    const el = this.sunElevationDeg();
    return el != null && el < -1;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers géométrie / capteurs                                        */
  /* ------------------------------------------------------------------ */

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

  private circularLerpDeg(fromDeg: number, toDeg: number, t: number): number {
    const f = (fromDeg * Math.PI) / 180;
    const to = (toDeg * Math.PI) / 180;
    const x = Math.cos(f) * (1 - t) + Math.cos(to) * t;
    const y = Math.sin(f) * (1 - t) + Math.sin(to) * t;
    return this.normalizeDeg((Math.atan2(y, x) * 180) / Math.PI);
  }

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

  private circularDiffDeg(aDeg: number, bDeg: number): number {
    return ((aDeg - bDeg + 540) % 360) - 180;
  }

  private headingFromAbsoluteQuaternion(q: ReadonlyArray<number>): number | null {
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    if (![x, y, z, w].every((n) => Number.isFinite(n))) {
      return null;
    }
    const topE = 2 * (x * y - z * w);
    const topN = 1 - 2 * (x * x + z * z);
    const backE = -(2 * (x * z + y * w));
    const backN = -(2 * (y * z - x * w));
    const east = topE + backE;
    const north = topN + backN;
    if (east * east + north * north < 1e-8) {
      return null;
    }
    return this.normalizeDeg((Math.atan2(east, north) * 180) / Math.PI);
  }

  /**
   * Inclinaison signée depuis le quaternion AbsoluteOrientationSensor.
   * 0° = à plat, 90° = vertical, négatif = haut du téléphone vers le bas.
   * atan2(haut·up, normale écran·up) : même convention que beta DeviceOrientation.
   */
  private pitchFromAbsoluteQuaternion(q: ReadonlyArray<number>): number | null {
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    if (![x, y, z, w].every((n) => Number.isFinite(n))) {
      return null;
    }
    const yUp = 2 * (y * z + x * w);
    const zUp = 1 - 2 * (x * x + y * y);
    return (Math.atan2(yUp, zUp) * 180) / Math.PI;
  }

  /**
   * Inclinaison signée depuis DeviceOrientation beta/gamma.
   * 0° = à plat (écran vers le ciel), 90° = vertical, négatif = haut vers le bas.
   */
  private devicePitchFromBetaGamma(betaDeg: number, gammaDeg: number): number {
    const b = (betaDeg * Math.PI) / 180;
    const g = (gammaDeg * Math.PI) / 180;
    const yUp = Math.sin(b);
    const zUp = Math.cos(b) * Math.cos(g);
    return (Math.atan2(yUp, zUp) * 180) / Math.PI;
  }

  private deviceHeadingFromEvent(e: DeviceOrientationEvent): number | null {
    if (this.usesMagnetometerHeading()) {
      return null;
    }
    const anyE = e as any;
    const webkitHeading =
      typeof anyE.webkitCompassHeading === 'number' && Number.isFinite(anyE.webkitCompassHeading)
        ? (anyE.webkitCompassHeading as number)
        : null;
    const alpha = e.alpha != null && Number.isFinite(e.alpha) ? e.alpha : null;
    const beta = Number.isFinite(e.beta as number) ? (e.beta as number) : 0;
    const gamma = Number.isFinite(e.gamma as number) ? (e.gamma as number) : 0;
    const screen = this.currentScreenAngle();
    const abs =
      (typeof e.absolute === 'boolean' ? e.absolute : false) ||
      this.orientationEventName === 'deviceorientationabsolute';

    if (this.northHeadingMode === 'os-yaw' || this.northHeadingMode === 'os-mag') {
      if (webkitHeading != null && !this.isAndroidDevice()) {
        return this.normalizeDeg(webkitHeading - screen);
      }
      if (alpha != null && abs) {
        return this.normalizeDeg(360 - alpha - screen);
      }
      if (webkitHeading != null) {
        return this.normalizeDeg(webkitHeading - screen);
      }
      return null;
    }

    if (alpha == null || !abs) {
      if (webkitHeading != null) {
        return this.normalizeDeg(webkitHeading - screen);
      }
      return null;
    }

    if (this.northHeadingMode === 'w3c') {
      return this.compassHeadingW3c(alpha, beta, gamma, screen);
    }
    if (this.northHeadingMode === 'tilt-mix') {
      return this.tiltCompensatedHeadingDeg(alpha, beta, gamma, screen);
    }
    if (this.northHeadingMode === 'tilt-top') {
      return this.tiltTopHeadingDeg(alpha, beta, gamma, screen);
    }
    return null;
  }

  /**
   * Cap boussole (0° = Nord, sens horaire) — formule W3C Device Orientation.
   * https://w3c.github.io/deviceorientation/#compassheading
   * À plat (β/γ ≈ 0) la formule est indéterminée → 360 − α.
   */
  private compassHeadingW3c(
    alphaDeg: number,
    betaDeg: number,
    gammaDeg: number,
    screenAngleDeg: number
  ): number {
    if (
      Math.abs(betaDeg) < HEADING_FLAT_BETA_GAMMA_DEG &&
      Math.abs(gammaDeg) < HEADING_FLAT_BETA_GAMMA_DEG
    ) {
      return this.normalizeDeg(360 - alphaDeg - screenAngleDeg);
    }
    const d2r = Math.PI / 180;
    const x = betaDeg * d2r;
    const y = gammaDeg * d2r;
    const z = alphaDeg * d2r;
    const cX = Math.cos(x);
    const cY = Math.cos(y);
    const cZ = Math.cos(z);
    const sX = Math.sin(x);
    const sY = Math.sin(y);
    const sZ = Math.sin(z);
    // Vecteur « dos appareil » projeté (spec W3C).
    const vx = -cZ * sY - sZ * sX * cY;
    const vy = -sZ * sY + cZ * sX * cY;
    if (vx * vx + vy * vy < 1e-10) {
      return this.normalizeDeg(360 - alphaDeg - screenAngleDeg);
    }
    let heading = Math.atan(vx / vy);
    if (vy < 0) {
      heading += Math.PI;
    } else if (vx < 0) {
      heading += 2 * Math.PI;
    }
    return this.normalizeDeg((heading * 180) / Math.PI - screenAngleDeg);
  }

  /**
   * Cap (0° = Nord magnétique, sens horaire).
   * Axes W3C DeviceOrientation : α autour de Z, β autour de X, γ autour de Y.
   * Repère Terre ENU : X = Est, Y = Nord (pas l'inverse).
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

    // R = Rz(α)·Rx(β)·Ry(γ) — spec W3C.
    // +Y appareil (haut écran) → (Est, Nord)
    const topE = -cB * sA;
    const topN = cA * cB;
    // −Z appareil (dos / visée) → (Est, Nord)
    const backE = -(cA * sG + cG * sA * sB);
    const backN = -(sA * sG - cA * cG * sB);

    const east = topE + backE;
    const north = topN + backN;

    // atan2(Est, Nord) : 0° = Nord, 90° = Est (ne pas inverser Est/Nord).
    const heading = (Math.atan2(east, north) * 180) / Math.PI - screenAngleDeg;
    return this.normalizeDeg(heading);
  }

  /** Cap = direction du haut de l’écran seulement (sans le dos / caméra). */
  private tiltTopHeadingDeg(
    alphaDeg: number,
    betaDeg: number,
    gammaDeg: number,
    screenAngleDeg: number
  ): number {
    void gammaDeg;
    const d2r = Math.PI / 180;
    const a = alphaDeg * d2r;
    const b = betaDeg * d2r;
    const cA = Math.cos(a);
    const sA = Math.sin(a);
    const cB = Math.cos(b);
    const topE = -cB * sA;
    const topN = cA * cB;
    if (topE * topE + topN * topN < 1e-8) {
      return this.normalizeDeg(360 - alphaDeg - screenAngleDeg);
    }
    const heading = (Math.atan2(topE, topN) * 180) / Math.PI - screenAngleDeg;
    return this.normalizeDeg(heading);
  }

  private isAndroidDevice(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Android/i.test(navigator.userAgent);
  }

  private isMobileDevice(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

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

  private static haversineGreatCircleKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = EARTH_RADIUS_KM;
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

  /** Élévation satellite (rad) depuis l'angle géocentrique nadir ↔ observateur. */
  private static satelliteElevationRad(nadirCentralAngleRad: number, altKm: number): number {
    const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(0, altKm));
    const g = nadirCentralAngleRad;
    return Math.atan2(Math.cos(g) - ratio, Math.sin(g));
  }

  private static satelliteSlantRangeKm(nadirCentralAngleRad: number, altKm: number): number {
    const Re = EARTH_RADIUS_KM;
    const R = Re + Math.max(0, altKm);
    const g = nadirCentralAngleRad;
    return Math.sqrt(Re * Re + R * R - 2 * Re * R * Math.cos(g));
  }

  /** Position du Soleil (azimut depuis le Nord, élévation) — algorithme solaire NOAA. */
  private static solarPosition(
    latDeg: number,
    lonDeg: number,
    date: Date
  ): { azimuthDeg: number; elevationDeg: number } {
    const rad = Math.PI / 180;
    const jd = date.getTime() / 86400000 + 2440587.5;
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
      rad;

    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let trueSolarTime = (minutes + eqTime + 4 * lonDeg) % 1440;
    if (trueSolarTime < 0) {
      trueSolarTime += 1440;
    }
    const ha = trueSolarTime / 4 - 180;

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
}
