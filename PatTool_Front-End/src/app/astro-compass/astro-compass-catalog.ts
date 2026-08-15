import { Body } from 'astronomy-engine';

/** Target kind for the celestial compass. */
export type AstroTargetKind = 'planet' | 'star' | 'galaxy' | 'custom' | 'iss';

export interface AstroBodyOption {
  id: string;
  kind: 'planet';
  body: Body;
  labelKey: string;
  /** Font Awesome class (without color). */
  iconClass: string;
  /** Accent color for needle / chips. */
  color: string;
}

/**
 * Earth-orbit (or cis-lunar) spacecraft tracked via live lat/lon / TLE.
 * {@code kind} stays {@code 'iss'} for historical selection plumbing (satellite mode).
 */
export interface AstroSatelliteOption {
  id: string;
  kind: 'iss';
  /** NORAD catalog number (CelesTrak / SGP4). */
  noradId: number;
  labelKey: string;
  iconClass: string;
  color: string;
  /** Fallback altitude (km) if SGP4 height is missing. */
  defaultAltKm: number;
  /**
   * When true, prefer the dedicated ISS live feed (WhereTheISS / Open Notify)
   * and ISS pass predictions instead of TLE-only.
   */
  useIssLiveFeed?: boolean;
  /**
   * When true, skip TLE / SGP4 (e.g. JWST at L2 — no useful two-line elements).
   */
  skipLiveTle?: boolean;
}

/** Human-made spacecraft with public TLEs (CelesTrak). */
export const ASTRO_SATELLITES: ReadonlyArray<AstroSatelliteOption> = [
  {
    id: 'iss',
    kind: 'iss',
    noradId: 25544,
    labelKey: 'ASTRO_COMPASS.BODY_ISS',
    iconClass: 'fa fa-space-shuttle',
    color: '#7ec8ff',
    defaultAltKm: 420,
    useIssLiveFeed: true
  },
  {
    id: 'tiangong',
    kind: 'iss',
    noradId: 48274,
    labelKey: 'ASTRO_COMPASS.BODY_TIANGONG',
    iconClass: 'fa fa-space-shuttle',
    color: '#ffb347',
    defaultAltKm: 390
  },
  {
    id: 'hubble',
    kind: 'iss',
    noradId: 20580,
    labelKey: 'ASTRO_COMPASS.BODY_HUBBLE',
    iconClass: 'fa fa-eye',
    color: '#c4b5fd',
    defaultAltKm: 540
  },
  {
    id: 'jwst',
    kind: 'iss',
    noradId: 50463,
    labelKey: 'ASTRO_COMPASS.BODY_JWST',
    iconClass: 'fa fa-star',
    color: '#f9a8d4',
    defaultAltKm: 1_500_000,
    skipLiveTle: true
  },
  {
    id: 'terra',
    kind: 'iss',
    noradId: 25994,
    labelKey: 'ASTRO_COMPASS.BODY_TERRA',
    iconClass: 'fa fa-globe',
    color: '#86efac',
    defaultAltKm: 705
  },
  {
    id: 'aqua',
    kind: 'iss',
    noradId: 27424,
    labelKey: 'ASTRO_COMPASS.BODY_AQUA',
    iconClass: 'fa fa-tint',
    color: '#67e8f9',
    defaultAltKm: 705
  },
  {
    id: 'landsat8',
    kind: 'iss',
    noradId: 39084,
    labelKey: 'ASTRO_COMPASS.BODY_LANDSAT8',
    iconClass: 'fa fa-map',
    color: '#fde047',
    defaultAltKm: 705
  },
  {
    id: 'landsat9',
    kind: 'iss',
    noradId: 49260,
    labelKey: 'ASTRO_COMPASS.BODY_LANDSAT9',
    iconClass: 'fa fa-map',
    color: '#fbbf24',
    defaultAltKm: 705
  },
  {
    id: 'sentinel2a',
    kind: 'iss',
    noradId: 40697,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL2A',
    iconClass: 'fa fa-leaf',
    color: '#4ade80',
    defaultAltKm: 786
  },
  {
    id: 'sentinel2b',
    kind: 'iss',
    noradId: 42063,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL2B',
    iconClass: 'fa fa-leaf',
    color: '#22c55e',
    defaultAltKm: 786
  },
  {
    id: 'noaa20',
    kind: 'iss',
    noradId: 43013,
    labelKey: 'ASTRO_COMPASS.BODY_NOAA20',
    iconClass: 'fa fa-cloud',
    color: '#93c5fd',
    defaultAltKm: 825
  },
  {
    id: 'noaa21',
    kind: 'iss',
    noradId: 54226,
    labelKey: 'ASTRO_COMPASS.BODY_NOAA21',
    iconClass: 'fa fa-cloud',
    color: '#60a5fa',
    defaultAltKm: 833
  },
  {
    id: 'suominpp',
    kind: 'iss',
    noradId: 37849,
    labelKey: 'ASTRO_COMPASS.BODY_SUOMINPP',
    iconClass: 'fa fa-cloud',
    color: '#818cf8',
    defaultAltKm: 833
  },
  {
    id: 'aura',
    kind: 'iss',
    noradId: 28376,
    labelKey: 'ASTRO_COMPASS.BODY_AURA',
    iconClass: 'fa fa-circle',
    color: '#f472b6',
    defaultAltKm: 705
  },
  {
    id: 'sentinel1a',
    kind: 'iss',
    noradId: 39634,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL1A',
    iconClass: 'fa fa-crosshairs',
    color: '#fb7185',
    defaultAltKm: 693
  },
  {
    id: 'sentinel1c',
    kind: 'iss',
    noradId: 62261,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL1C',
    iconClass: 'fa fa-crosshairs',
    color: '#f43f5e',
    defaultAltKm: 693
  },
  {
    id: 'sentinel2c',
    kind: 'iss',
    noradId: 60989,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL2C',
    iconClass: 'fa fa-leaf',
    color: '#16a34a',
    defaultAltKm: 786
  },
  {
    id: 'sentinel3a',
    kind: 'iss',
    noradId: 41335,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL3A',
    iconClass: 'fa fa-globe',
    color: '#38bdf8',
    defaultAltKm: 814
  },
  {
    id: 'sentinel3b',
    kind: 'iss',
    noradId: 43437,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL3B',
    iconClass: 'fa fa-globe',
    color: '#0ea5e9',
    defaultAltKm: 814
  },
  {
    id: 'sentinel5p',
    kind: 'iss',
    noradId: 42969,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL5P',
    iconClass: 'fa fa-cloud',
    color: '#a78bfa',
    defaultAltKm: 824
  },
  {
    id: 'sentinel6',
    kind: 'iss',
    noradId: 46984,
    labelKey: 'ASTRO_COMPASS.BODY_SENTINEL6',
    iconClass: 'fa fa-arrows-v',
    color: '#6366f1',
    defaultAltKm: 1336
  },
  {
    id: 'metopb',
    kind: 'iss',
    noradId: 38771,
    labelKey: 'ASTRO_COMPASS.BODY_METOPB',
    iconClass: 'fa fa-cloud',
    color: '#34d399',
    defaultAltKm: 817
  },
  {
    id: 'metopc',
    kind: 'iss',
    noradId: 43689,
    labelKey: 'ASTRO_COMPASS.BODY_METOPC',
    iconClass: 'fa fa-cloud',
    color: '#2dd4bf',
    defaultAltKm: 817
  },
  {
    id: 'gpm',
    kind: 'iss',
    noradId: 40376,
    labelKey: 'ASTRO_COMPASS.BODY_GPM',
    iconClass: 'fa fa-tint',
    color: '#f97316',
    defaultAltKm: 407
  },
  {
    id: 'swift',
    kind: 'iss',
    noradId: 28485,
    labelKey: 'ASTRO_COMPASS.BODY_SWIFT',
    iconClass: 'fa fa-bolt',
    color: '#e879f9',
    defaultAltKm: 550
  },
  {
    id: 'fermi',
    kind: 'iss',
    noradId: 33053,
    labelKey: 'ASTRO_COMPASS.BODY_FERMI',
    iconClass: 'fa fa-star-o',
    color: '#c084fc',
    defaultAltKm: 535
  }
];

/** @deprecated Prefer {@link ASTRO_SATELLITES}[0] / {@link findSatelliteById}('iss'). */
export const ASTRO_ISS: AstroSatelliteOption = ASTRO_SATELLITES[0];

export function findSatelliteById(id: string): AstroSatelliteOption | undefined {
  return ASTRO_SATELLITES.find((s) => s.id === id);
}

export function findSatelliteByNoradId(noradId: number): AstroSatelliteOption | undefined {
  return ASTRO_SATELLITES.find((s) => s.noradId === noradId);
}

/** Fixed-sky object (star or deep-sky) aimed via RA/Dec + DefineStar. */
export interface AstroFixedSkyOption {
  id: string;
  kind: 'star' | 'galaxy';
  /** Common name (English). */
  name: string;
  /** Alternate search tokens (lowercase). */
  aliases: string[];
  /** J2000 right ascension in hours [0, 24). */
  raHours: number;
  /** J2000 declination in degrees. */
  decDeg: number;
  /** Distance in light-years (≥ 1 for astronomy-engine DefineStar). */
  distLy: number;
  /** Apparent magnitude (approx.). */
  mag: number;
  constellation?: string;
  iconClass: string;
  color: string;
}

export type AstroStarOption = AstroFixedSkyOption & { kind: 'star' };
export type AstroGalaxyOption = AstroFixedSkyOption & { kind: 'galaxy' };

/** Solar-system bodies (observer is on Earth → Earth itself is omitted). */
export const ASTRO_PLANETS: ReadonlyArray<AstroBodyOption> = [
  { id: 'sun', kind: 'planet', body: Body.Sun, labelKey: 'ASTRO_COMPASS.BODY_SUN', iconClass: 'fa fa-sun-o', color: '#fdb813' },
  { id: 'moon', kind: 'planet', body: Body.Moon, labelKey: 'ASTRO_COMPASS.BODY_MOON', iconClass: 'fa fa-moon-o', color: '#dcdcdc' },
  { id: 'mercury', kind: 'planet', body: Body.Mercury, labelKey: 'ASTRO_COMPASS.BODY_MERCURY', iconClass: 'fa fa-circle', color: '#b5b5b5' },
  { id: 'venus', kind: 'planet', body: Body.Venus, labelKey: 'ASTRO_COMPASS.BODY_VENUS', iconClass: 'fa fa-circle', color: '#e6c87c' },
  { id: 'mars', kind: 'planet', body: Body.Mars, labelKey: 'ASTRO_COMPASS.BODY_MARS', iconClass: 'fa fa-circle', color: '#c1440e' },
  { id: 'jupiter', kind: 'planet', body: Body.Jupiter, labelKey: 'ASTRO_COMPASS.BODY_JUPITER', iconClass: 'fa fa-circle', color: '#d8ca9d' },
  { id: 'saturn', kind: 'planet', body: Body.Saturn, labelKey: 'ASTRO_COMPASS.BODY_SATURN', iconClass: 'fa fa-circle', color: '#fad5a5' },
  { id: 'uranus', kind: 'planet', body: Body.Uranus, labelKey: 'ASTRO_COMPASS.BODY_URANUS', iconClass: 'fa fa-circle', color: '#7de3f0' },
  { id: 'neptune', kind: 'planet', body: Body.Neptune, labelKey: 'ASTRO_COMPASS.BODY_NEPTUNE', iconClass: 'fa fa-circle', color: '#5b5ddf' },
  { id: 'pluto', kind: 'planet', body: Body.Pluto, labelKey: 'ASTRO_COMPASS.BODY_PLUTO', iconClass: 'fa fa-circle', color: '#c9c5bc' }
];

/**
 * Bright-star catalog (J2000). Distances are approximate; used for DefineStar.
 * Names/aliases support FR/EN search.
 */
export const ASTRO_BRIGHT_STARS: ReadonlyArray<AstroStarOption> = [
  { id: 'sirius', kind: 'star', name: 'Sirius', aliases: ['alpha canis majoris', 'α cma'], raHours: 6.7525, decDeg: -16.7161, distLy: 8.6, mag: -1.46, constellation: 'CMa', iconClass: 'fa fa-star', color: '#a8cfff' },
  { id: 'canopus', kind: 'star', name: 'Canopus', aliases: ['alpha carinae', 'α car'], raHours: 6.3992, decDeg: -52.6957, distLy: 310, mag: -0.74, constellation: 'Car', iconClass: 'fa fa-star', color: '#ffe9b0' },
  { id: 'rigil-kentaurus', kind: 'star', name: 'Rigil Kentaurus', aliases: ['alpha centauri', 'α cen', 'proxima centauri', 'toliman'], raHours: 14.6601, decDeg: -60.8356, distLy: 4.37, mag: -0.27, constellation: 'Cen', iconClass: 'fa fa-star', color: '#ffe4b5' },
  { id: 'arcturus', kind: 'star', name: 'Arcturus', aliases: ['alpha bootis', 'α boo'], raHours: 14.2610, decDeg: 19.1824, distLy: 36.7, mag: -0.05, constellation: 'Boo', iconClass: 'fa fa-star', color: '#ffb347' },
  { id: 'vega', kind: 'star', name: 'Vega', aliases: ['alpha lyrae', 'α lyr', 'véga'], raHours: 18.6156, decDeg: 38.7837, distLy: 25.0, mag: 0.03, constellation: 'Lyr', iconClass: 'fa fa-star', color: '#cfe8ff' },
  { id: 'capella', kind: 'star', name: 'Capella', aliases: ['alpha aurigae', 'α aur'], raHours: 5.2782, decDeg: 45.9980, distLy: 42.9, mag: 0.08, constellation: 'Aur', iconClass: 'fa fa-star', color: '#ffe4a8' },
  { id: 'rigel', kind: 'star', name: 'Rigel', aliases: ['beta orionis', 'β ori'], raHours: 5.2423, decDeg: -8.2016, distLy: 860, mag: 0.13, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8d4ff' },
  { id: 'procyon', kind: 'star', name: 'Procyon', aliases: ['alpha canis minoris', 'α cmi'], raHours: 7.6550, decDeg: 5.2250, distLy: 11.5, mag: 0.34, constellation: 'CMi', iconClass: 'fa fa-star', color: '#fff0c8' },
  { id: 'achernar', kind: 'star', name: 'Achernar', aliases: ['alpha eridani', 'α eri'], raHours: 1.6286, decDeg: -57.2368, distLy: 139, mag: 0.46, constellation: 'Eri', iconClass: 'fa fa-star', color: '#b0d8ff' },
  { id: 'betelgeuse', kind: 'star', name: 'Betelgeuse', aliases: ['alpha orionis', 'α ori', 'bételgeuse'], raHours: 5.9195, decDeg: 7.4071, distLy: 640, mag: 0.50, constellation: 'Ori', iconClass: 'fa fa-star', color: '#ff7a4a' },
  { id: 'hadar', kind: 'star', name: 'Hadar', aliases: ['beta centauri', 'β cen', 'agena'], raHours: 14.0637, decDeg: -60.3730, distLy: 390, mag: 0.61, constellation: 'Cen', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'altair', kind: 'star', name: 'Altair', aliases: ['alpha aquilae', 'α aql'], raHours: 19.8464, decDeg: 8.8683, distLy: 16.7, mag: 0.76, constellation: 'Aql', iconClass: 'fa fa-star', color: '#fff5d6' },
  { id: 'acrux', kind: 'star', name: 'Acrux', aliases: ['alpha crucis', 'α cru'], raHours: 12.4433, decDeg: -63.0991, distLy: 320, mag: 0.77, constellation: 'Cru', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'aldebaran', kind: 'star', name: 'Aldebaran', aliases: ['alpha tauri', 'α tau', 'aldébaran'], raHours: 4.5987, decDeg: 16.5093, distLy: 65.3, mag: 0.86, constellation: 'Tau', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'antares', kind: 'star', name: 'Antares', aliases: ['alpha scorpii', 'α sco', 'antares'], raHours: 16.4901, decDeg: -26.4320, distLy: 550, mag: 0.96, constellation: 'Sco', iconClass: 'fa fa-star', color: '#ff6b4a' },
  { id: 'spica', kind: 'star', name: 'Spica', aliases: ['alpha virginis', 'α vir'], raHours: 13.4199, decDeg: -11.1613, distLy: 250, mag: 0.97, constellation: 'Vir', iconClass: 'fa fa-star', color: '#b0c8ff' },
  { id: 'pollux', kind: 'star', name: 'Pollux', aliases: ['beta geminorum', 'β gem'], raHours: 7.7553, decDeg: 28.0262, distLy: 33.8, mag: 1.14, constellation: 'Gem', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'fomalhaut', kind: 'star', name: 'Fomalhaut', aliases: ['alpha piscis austrini', 'α psa'], raHours: 22.9608, decDeg: -29.6222, distLy: 25.1, mag: 1.16, constellation: 'PsA', iconClass: 'fa fa-star', color: '#fff8e0' },
  { id: 'deneb', kind: 'star', name: 'Deneb', aliases: ['alpha cygni', 'α cyg'], raHours: 20.6905, decDeg: 45.2803, distLy: 2600, mag: 1.25, constellation: 'Cyg', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'mimosa', kind: 'star', name: 'Mimosa', aliases: ['beta crucis', 'β cru', 'becrux'], raHours: 12.7954, decDeg: -59.6888, distLy: 280, mag: 1.25, constellation: 'Cru', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'regulus', kind: 'star', name: 'Regulus', aliases: ['alpha leonis', 'α leo'], raHours: 10.1395, decDeg: 11.9672, distLy: 79.3, mag: 1.35, constellation: 'Leo', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'adhara', kind: 'star', name: 'Adhara', aliases: ['epsilon canis majoris', 'ε cma'], raHours: 6.9770, decDeg: -28.9721, distLy: 430, mag: 1.50, constellation: 'CMa', iconClass: 'fa fa-star', color: '#a8d0ff' },
  { id: 'castor', kind: 'star', name: 'Castor', aliases: ['alpha geminorum', 'α gem'], raHours: 7.5766, decDeg: 31.8883, distLy: 51, mag: 1.58, constellation: 'Gem', iconClass: 'fa fa-star', color: '#dce8ff' },
  { id: 'gacrux', kind: 'star', name: 'Gacrux', aliases: ['gamma crucis', 'γ cru'], raHours: 12.5194, decDeg: -57.1132, distLy: 88, mag: 1.63, constellation: 'Cru', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'shaula', kind: 'star', name: 'Shaula', aliases: ['lambda scorpii', 'λ sco'], raHours: 17.5601, decDeg: -37.1038, distLy: 570, mag: 1.63, constellation: 'Sco', iconClass: 'fa fa-star', color: '#b0d0ff' },
  { id: 'bellatrix', kind: 'star', name: 'Bellatrix', aliases: ['gamma orionis', 'γ ori'], raHours: 5.4189, decDeg: 6.3497, distLy: 250, mag: 1.64, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'elnath', kind: 'star', name: 'Elnath', aliases: ['beta tauri', 'β tau'], raHours: 5.4382, decDeg: 28.6075, distLy: 134, mag: 1.65, constellation: 'Tau', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'miaplacidus', kind: 'star', name: 'Miaplacidus', aliases: ['beta carinae', 'β car'], raHours: 9.2199, decDeg: -69.7172, distLy: 113, mag: 1.67, constellation: 'Car', iconClass: 'fa fa-star', color: '#fff0d0' },
  { id: 'alnilam', kind: 'star', name: 'Alnilam', aliases: ['epsilon orionis', 'ε ori'], raHours: 5.6036, decDeg: -1.2019, distLy: 2000, mag: 1.69, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'alnitak', kind: 'star', name: 'Alnitak', aliases: ['zeta orionis', 'ζ ori'], raHours: 5.6793, decDeg: -1.9426, distLy: 1260, mag: 1.74, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'alioth', kind: 'star', name: 'Alioth', aliases: ['epsilon ursae majoris', 'ε uma'], raHours: 12.9004, decDeg: 55.9598, distLy: 81, mag: 1.77, constellation: 'UMa', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'dubhe', kind: 'star', name: 'Dubhe', aliases: ['alpha ursae majoris', 'α uma'], raHours: 11.0621, decDeg: 61.7510, distLy: 123, mag: 1.79, constellation: 'UMa', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'mirfak', kind: 'star', name: 'Mirfak', aliases: ['alpha persei', 'α per'], raHours: 3.4054, decDeg: 49.8612, distLy: 510, mag: 1.79, constellation: 'Per', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'wezen', kind: 'star', name: 'Wezen', aliases: ['delta canis majoris', 'δ cma'], raHours: 7.1399, decDeg: -26.3932, distLy: 1800, mag: 1.83, constellation: 'CMa', iconClass: 'fa fa-star', color: '#ffe4b0' },
  { id: 'sadr', kind: 'star', name: 'Sadr', aliases: ['gamma cygni', 'γ cyg'], raHours: 20.3705, decDeg: 40.2567, distLy: 1800, mag: 2.20, constellation: 'Cyg', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'polaris', kind: 'star', name: 'Polaris', aliases: ['alpha ursae minoris', 'α umi', 'etoile polaire', 'étoile polaire', 'north star'], raHours: 2.5303, decDeg: 89.2641, distLy: 433, mag: 1.98, constellation: 'UMi', iconClass: 'fa fa-star', color: '#ffe9c0' },
  { id: 'mizar', kind: 'star', name: 'Mizar', aliases: ['zeta ursae majoris', 'ζ uma'], raHours: 13.3987, decDeg: 54.9254, distLy: 83, mag: 2.23, constellation: 'UMa', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'algol', kind: 'star', name: 'Algol', aliases: ['beta persei', 'β per'], raHours: 3.1361, decDeg: 40.9556, distLy: 90, mag: 2.12, constellation: 'Per', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'alphecca', kind: 'star', name: 'Alphecca', aliases: ['alpha coronae borealis', 'α crb', 'gemma'], raHours: 15.5781, decDeg: 26.7149, distLy: 75, mag: 2.23, constellation: 'CrB', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'denebola', kind: 'star', name: 'Denebola', aliases: ['beta leonis', 'β leo'], raHours: 11.8177, decDeg: 14.5721, distLy: 36, mag: 2.14, constellation: 'Leo', iconClass: 'fa fa-star', color: '#fff8e0' },
  // Extra bright / well-known stars
  { id: 'alpheratz', kind: 'star', name: 'Alpheratz', aliases: ['alpha andromedae', 'α and', 'sirrah'], raHours: 0.1398, decDeg: 29.0904, distLy: 97, mag: 2.06, constellation: 'And', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'schedar', kind: 'star', name: 'Schedar', aliases: ['alpha cassiopeiae', 'α cas', 'shedir'], raHours: 0.6751, decDeg: 56.5373, distLy: 228, mag: 2.23, constellation: 'Cas', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'caph', kind: 'star', name: 'Caph', aliases: ['beta cassiopeiae', 'β cas'], raHours: 0.1528, decDeg: 59.1498, distLy: 54, mag: 2.27, constellation: 'Cas', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'mirach', kind: 'star', name: 'Mirach', aliases: ['beta andromedae', 'β and'], raHours: 1.1622, decDeg: 35.6206, distLy: 197, mag: 2.06, constellation: 'And', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'hamal', kind: 'star', name: 'Hamal', aliases: ['alpha arietis', 'α ari'], raHours: 2.1195, decDeg: 23.4624, distLy: 66, mag: 2.00, constellation: 'Ari', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'menkar', kind: 'star', name: 'Menkar', aliases: ['alpha ceti', 'α cet'], raHours: 3.0380, decDeg: 4.0897, distLy: 249, mag: 2.53, constellation: 'Cet', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'almach', kind: 'star', name: 'Almach', aliases: ['gamma andromedae', 'γ and'], raHours: 2.0640, decDeg: 42.3297, distLy: 350, mag: 2.10, constellation: 'And', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'avior', kind: 'star', name: 'Avior', aliases: ['epsilon carinae', 'ε car'], raHours: 8.3752, decDeg: -59.5095, distLy: 630, mag: 1.86, constellation: 'Car', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'suhail', kind: 'star', name: 'Suhail', aliases: ['lambda velorum', 'λ vel'], raHours: 9.1333, decDeg: -43.4326, distLy: 545, mag: 2.21, constellation: 'Vel', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'markab', kind: 'star', name: 'Markab', aliases: ['alpha pegasi', 'α peg'], raHours: 23.0793, decDeg: 15.2053, distLy: 133, mag: 2.49, constellation: 'Peg', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'scheat', kind: 'star', name: 'Scheat', aliases: ['beta pegasi', 'β peg'], raHours: 23.0629, decDeg: 28.0828, distLy: 196, mag: 2.42, constellation: 'Peg', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'enif', kind: 'star', name: 'Enif', aliases: ['epsilon pegasi', 'ε peg'], raHours: 21.7364, decDeg: 9.8750, distLy: 690, mag: 2.39, constellation: 'Peg', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'kaus-australis', kind: 'star', name: 'Kaus Australis', aliases: ['epsilon sagittarii', 'ε sgr'], raHours: 18.4029, decDeg: -34.3843, distLy: 143, mag: 1.85, constellation: 'Sgr', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'nunki', kind: 'star', name: 'Nunki', aliases: ['sigma sagittarii', 'σ sgr'], raHours: 18.9211, decDeg: -26.2967, distLy: 228, mag: 2.05, constellation: 'Sgr', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'rasalhague', kind: 'star', name: 'Rasalhague', aliases: ['alpha ophiuchi', 'α oph'], raHours: 17.5822, decDeg: 12.5600, distLy: 49, mag: 2.08, constellation: 'Oph', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'unukalhai', kind: 'star', name: 'Unukalhai', aliases: ['alpha serpentis', 'α ser', 'unuk'], raHours: 15.7378, decDeg: 6.4256, distLy: 74, mag: 2.63, constellation: 'Ser', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'kochab', kind: 'star', name: 'Kochab', aliases: ['beta ursae minoris', 'β umi'], raHours: 14.8451, decDeg: 74.1555, distLy: 131, mag: 2.08, constellation: 'UMi', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'phecda', kind: 'star', name: 'Phecda', aliases: ['gamma ursae majoris', 'γ uma', 'phad'], raHours: 11.8972, decDeg: 53.6948, distLy: 84, mag: 2.44, constellation: 'UMa', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'megrez', kind: 'star', name: 'Megrez', aliases: ['delta ursae majoris', 'δ uma'], raHours: 12.2571, decDeg: 57.0326, distLy: 81, mag: 3.31, constellation: 'UMa', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'alkaid', kind: 'star', name: 'Alkaid', aliases: ['eta ursae majoris', 'η uma', 'benetnash'], raHours: 13.7923, decDeg: 49.3133, distLy: 104, mag: 1.86, constellation: 'UMa', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'merak', kind: 'star', name: 'Merak', aliases: ['beta ursae majoris', 'β uma'], raHours: 11.0307, decDeg: 56.3824, distLy: 80, mag: 2.37, constellation: 'UMa', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'navi', kind: 'star', name: 'Navi', aliases: ['gamma cassiopeiae', 'γ cas', 'tsih'], raHours: 0.9451, decDeg: 60.7167, distLy: 550, mag: 2.47, constellation: 'Cas', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'mintaka', kind: 'star', name: 'Mintaka', aliases: ['delta orionis', 'δ ori'], raHours: 5.5334, decDeg: -0.2991, distLy: 1200, mag: 2.23, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'saiph', kind: 'star', name: 'Saiph', aliases: ['kappa orionis', 'κ ori'], raHours: 5.7959, decDeg: -9.6696, distLy: 650, mag: 2.06, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'alphard', kind: 'star', name: 'Alphard', aliases: ['alpha hydrae', 'α hya'], raHours: 9.4598, decDeg: -8.6586, distLy: 177, mag: 1.98, constellation: 'Hya', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'zubeneschamali', kind: 'star', name: 'Zubeneschamali', aliases: ['beta librae', 'β lib'], raHours: 15.2835, decDeg: -9.3829, distLy: 185, mag: 2.61, constellation: 'Lib', iconClass: 'fa fa-star', color: '#b0ffc8' },
  { id: 'zubenelgenubi', kind: 'star', name: 'Zubenelgenubi', aliases: ['alpha librae', 'α lib'], raHours: 14.8479, decDeg: -16.0419, distLy: 77, mag: 2.75, constellation: 'Lib', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'algieba', kind: 'star', name: 'Algieba', aliases: ['gamma leonis', 'γ leo'], raHours: 10.3329, decDeg: 19.8415, distLy: 130, mag: 2.08, constellation: 'Leo', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'rasalhague2', kind: 'star', name: 'Cebalrai', aliases: ['beta ophiuchi', 'β oph', 'cheleb'], raHours: 17.7246, decDeg: 4.5671, distLy: 82, mag: 2.76, constellation: 'Oph', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'etamin', kind: 'star', name: 'Eltanin', aliases: ['gamma draconis', 'γ dra', 'etamin'], raHours: 17.9434, decDeg: 51.4889, distLy: 154, mag: 2.23, constellation: 'Dra', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'thuban', kind: 'star', name: 'Thuban', aliases: ['alpha draconis', 'α dra'], raHours: 14.0732, decDeg: 64.3758, distLy: 303, mag: 3.67, constellation: 'Dra', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'albireo', kind: 'star', name: 'Albireo', aliases: ['beta cygni', 'β cyg'], raHours: 19.5120, decDeg: 27.9597, distLy: 430, mag: 3.08, constellation: 'Cyg', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'ain', kind: 'star', name: 'Ain', aliases: ['epsilon tauri', 'ε tau', 'oin'], raHours: 4.4777, decDeg: 19.1804, distLy: 155, mag: 3.53, constellation: 'Tau', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'algorab', kind: 'star', name: 'Algorab', aliases: ['delta corvi', 'δ crv'], raHours: 12.4978, decDeg: -16.5154, distLy: 87, mag: 2.95, constellation: 'Crv', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'gienah', kind: 'star', name: 'Gienah', aliases: ['gamma corvi', 'γ crv'], raHours: 12.2634, decDeg: -17.5425, distLy: 154, mag: 2.59, constellation: 'Crv', iconClass: 'fa fa-star', color: '#c8dcff' },
  // More named / navigational stars
  { id: 'mirzam', kind: 'star', name: 'Mirzam', aliases: ['beta canis majoris', 'β cma'], raHours: 6.3783, decDeg: -17.9559, distLy: 490, mag: 1.98, constellation: 'CMa', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'naos', kind: 'star', name: 'Naos', aliases: ['zeta puppis', 'ζ pup'], raHours: 8.0597, decDeg: -40.0031, distLy: 1080, mag: 2.21, constellation: 'Pup', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'regor', kind: 'star', name: 'Regor', aliases: ['gamma velorum', 'γ vel', 'suhail al muhlif'], raHours: 8.1589, decDeg: -47.3366, distLy: 1100, mag: 1.78, constellation: 'Vel', iconClass: 'fa fa-star', color: '#a8d0ff' },
  { id: 'alsephina', kind: 'star', name: 'Alsephina', aliases: ['delta velorum', 'δ vel'], raHours: 8.7451, decDeg: -54.7084, distLy: 80, mag: 1.96, constellation: 'Vel', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'aspidiske', kind: 'star', name: 'Aspidiske', aliases: ['iota carinae', 'ι car', 'turais'], raHours: 9.2850, decDeg: -59.2752, distLy: 690, mag: 2.21, constellation: 'Car', iconClass: 'fa fa-star', color: '#fff0d0' },
  { id: 'delta-cru', kind: 'star', name: 'Imai', aliases: ['delta crucis', 'δ cru'], raHours: 12.2524, decDeg: -58.7489, distLy: 345, mag: 2.79, constellation: 'Cru', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'ginan', kind: 'star', name: 'Ginan', aliases: ['epsilon crucis', 'ε cru'], raHours: 12.3553, decDeg: -60.4024, distLy: 230, mag: 3.59, constellation: 'Cru', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'atria', kind: 'star', name: 'Atria', aliases: ['alpha trianguli australis', 'α tra'], raHours: 16.8111, decDeg: -69.0277, distLy: 390, mag: 1.91, constellation: 'TrA', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'peacock', kind: 'star', name: 'Peacock', aliases: ['alpha pavonis', 'α pav'], raHours: 20.4275, decDeg: -56.7351, distLy: 180, mag: 1.94, constellation: 'Pav', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'alnair', kind: 'star', name: 'Alnair', aliases: ['alpha gruis', 'α gru'], raHours: 22.1372, decDeg: -46.9610, distLy: 101, mag: 1.74, constellation: 'Gru', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'ankaa', kind: 'star', name: 'Ankaa', aliases: ['alpha phoenicis', 'α phe'], raHours: 0.4380, decDeg: -42.3059, distLy: 85, mag: 2.40, constellation: 'Phe', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'diphda', kind: 'star', name: 'Diphda', aliases: ['beta ceti', 'β cet', 'deneb kaitos'], raHours: 0.7265, decDeg: -17.9866, distLy: 96, mag: 2.04, constellation: 'Cet', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'acamar', kind: 'star', name: 'Acamar', aliases: ['theta eridani', 'θ eri'], raHours: 2.9710, decDeg: -40.3047, distLy: 161, mag: 2.88, constellation: 'Eri', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'menkent', kind: 'star', name: 'Menkent', aliases: ['theta centauri', 'θ cen'], raHours: 14.1114, decDeg: -36.3719, distLy: 61, mag: 2.06, constellation: 'Cen', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'phact', kind: 'star', name: 'Phact', aliases: ['alpha columbae', 'α col'], raHours: 5.6608, decDeg: -34.0741, distLy: 268, mag: 2.65, constellation: 'Col', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'wazen', kind: 'star', name: 'Wazn', aliases: ['beta columbae', 'β col'], raHours: 5.8493, decDeg: -35.7603, distLy: 87, mag: 3.12, constellation: 'Col', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'dschubba', kind: 'star', name: 'Dschubba', aliases: ['delta scorpii', 'δ sco'], raHours: 16.0056, decDeg: -22.6217, distLy: 400, mag: 2.32, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'acrab', kind: 'star', name: 'Acrab', aliases: ['beta scorpii', 'β sco', 'graffias'], raHours: 16.0906, decDeg: -19.8056, distLy: 400, mag: 2.62, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'sargas', kind: 'star', name: 'Sargas', aliases: ['theta scorpii', 'θ sco'], raHours: 17.6217, decDeg: -42.9978, distLy: 270, mag: 1.87, constellation: 'Sco', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'lesath', kind: 'star', name: 'Lesath', aliases: ['upsilon scorpii', 'υ sco'], raHours: 17.5122, decDeg: -37.2958, distLy: 580, mag: 2.69, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'kaus-media', kind: 'star', name: 'Kaus Media', aliases: ['delta sagittarii', 'δ sgr'], raHours: 18.3495, decDeg: -29.8281, distLy: 350, mag: 2.70, constellation: 'Sgr', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'kaus-borealis', kind: 'star', name: 'Kaus Borealis', aliases: ['lambda sagittarii', 'λ sgr'], raHours: 18.4668, decDeg: -25.4217, distLy: 78, mag: 2.81, constellation: 'Sgr', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'ascella', kind: 'star', name: 'Ascella', aliases: ['zeta sagittarii', 'ζ sgr'], raHours: 19.0435, decDeg: -29.8801, distLy: 89, mag: 2.60, constellation: 'Sgr', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'sabik', kind: 'star', name: 'Sabik', aliases: ['eta ophiuchi', 'η oph'], raHours: 17.1728, decDeg: -15.7244, distLy: 88, mag: 2.43, constellation: 'Oph', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'rasalgethi', kind: 'star', name: 'Rasalgethi', aliases: ['alpha herculis', 'α her'], raHours: 17.2441, decDeg: 14.3903, distLy: 360, mag: 3.06, constellation: 'Her', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'kornephoros', kind: 'star', name: 'Kornephoros', aliases: ['beta herculis', 'β her'], raHours: 16.5035, decDeg: 21.4897, distLy: 139, mag: 2.77, constellation: 'Her', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'izar', kind: 'star', name: 'Izar', aliases: ['epsilon bootis', 'ε boo', 'pulcherrima'], raHours: 14.7498, decDeg: 27.0742, distLy: 202, mag: 2.37, constellation: 'Boo', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'muphrid', kind: 'star', name: 'Muphrid', aliases: ['eta bootis', 'η boo'], raHours: 13.9114, decDeg: 18.3977, distLy: 37, mag: 2.68, constellation: 'Boo', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'seginus', kind: 'star', name: 'Seginus', aliases: ['gamma bootis', 'γ boo'], raHours: 14.5306, decDeg: 38.3083, distLy: 87, mag: 3.03, constellation: 'Boo', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'nekkar', kind: 'star', name: 'Nekkar', aliases: ['beta bootis', 'β boo'], raHours: 15.0324, decDeg: 40.3906, distLy: 225, mag: 3.49, constellation: 'Boo', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'cor-caroli', kind: 'star', name: 'Cor Caroli', aliases: ['alpha canum venaticorum', 'α cvn'], raHours: 12.9338, decDeg: 38.3183, distLy: 110, mag: 2.89, constellation: 'CVn', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'tarazed', kind: 'star', name: 'Tarazed', aliases: ['gamma aquilae', 'γ aql'], raHours: 19.7703, decDeg: 10.6133, distLy: 460, mag: 2.72, constellation: 'Aql', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'alshain', kind: 'star', name: 'Alshain', aliases: ['beta aquilae', 'β aql'], raHours: 19.9219, decDeg: 6.4067, distLy: 45, mag: 3.71, constellation: 'Aql', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'sheliak', kind: 'star', name: 'Sheliak', aliases: ['beta lyrae', 'β lyr'], raHours: 18.8347, decDeg: 33.3628, distLy: 960, mag: 3.45, constellation: 'Lyr', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'sulafat', kind: 'star', name: 'Sulafat', aliases: ['gamma lyrae', 'γ lyr'], raHours: 18.9827, decDeg: 32.6897, distLy: 620, mag: 3.25, constellation: 'Lyr', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'sadalmelik', kind: 'star', name: 'Sadalmelik', aliases: ['alpha aquarii', 'α aqr'], raHours: 22.0964, decDeg: -0.3194, distLy: 520, mag: 2.95, constellation: 'Aqr', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'sadalsuud', kind: 'star', name: 'Sadalsuud', aliases: ['beta aquarii', 'β aqr'], raHours: 21.5259, decDeg: -5.5711, distLy: 540, mag: 2.90, constellation: 'Aqr', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'skat', kind: 'star', name: 'Skat', aliases: ['delta aquarii', 'δ aqr'], raHours: 22.9108, decDeg: -15.8208, distLy: 160, mag: 3.27, constellation: 'Aqr', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'algenib', kind: 'star', name: 'Algenib', aliases: ['gamma pegasi', 'γ peg'], raHours: 0.2206, decDeg: 15.1836, distLy: 390, mag: 2.84, constellation: 'Peg', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'matar', kind: 'star', name: 'Matar', aliases: ['eta pegasi', 'η peg'], raHours: 22.7167, decDeg: 30.2214, distLy: 215, mag: 2.94, constellation: 'Peg', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'ruchbah', kind: 'star', name: 'Ruchbah', aliases: ['delta cassiopeiae', 'δ cas'], raHours: 1.4302, decDeg: 60.2353, distLy: 99, mag: 2.68, constellation: 'Cas', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'segin', kind: 'star', name: 'Segin', aliases: ['epsilon cassiopeiae', 'ε cas'], raHours: 1.9066, decDeg: 63.6701, distLy: 440, mag: 3.38, constellation: 'Cas', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'alcyone', kind: 'star', name: 'Alcyone', aliases: ['eta tauri', 'η tau', 'pleiades'], raHours: 3.7904, decDeg: 24.1051, distLy: 440, mag: 2.87, constellation: 'Tau', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'atlas', kind: 'star', name: 'Atlas', aliases: ['27 tauri', 'pleiades atlas'], raHours: 3.8194, decDeg: 24.0533, distLy: 380, mag: 3.63, constellation: 'Tau', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'electra', kind: 'star', name: 'Electra', aliases: ['17 tauri', 'pleiades electra'], raHours: 3.7411, decDeg: 24.1133, distLy: 400, mag: 3.70, constellation: 'Tau', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'maia', kind: 'star', name: 'Maia', aliases: ['20 tauri', 'pleiades maia'], raHours: 3.7583, decDeg: 24.3678, distLy: 360, mag: 3.87, constellation: 'Tau', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'menaile', kind: 'star', name: 'Menkalinan', aliases: ['beta aurigae', 'β aur'], raHours: 5.9919, decDeg: 44.9474, distLy: 81, mag: 1.90, constellation: 'Aur', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'hassaleh', kind: 'star', name: 'Hassaleh', aliases: ['iota aurigae', 'ι aur', 'kabdhilinan'], raHours: 4.9499, decDeg: 33.1661, distLy: 490, mag: 2.69, constellation: 'Aur', iconClass: 'fa fa-star', color: '#ff9a4a' },
  { id: 'almaaz', kind: 'star', name: 'Almaaz', aliases: ['epsilon aurigae', 'ε aur'], raHours: 5.0328, decDeg: 43.8233, distLy: 2000, mag: 2.99, constellation: 'Aur', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'alhena', kind: 'star', name: 'Alhena', aliases: ['gamma geminorum', 'γ gem'], raHours: 6.6286, decDeg: 16.3993, distLy: 109, mag: 1.93, constellation: 'Gem', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'wasat', kind: 'star', name: 'Wasat', aliases: ['delta geminorum', 'δ gem'], raHours: 7.3354, decDeg: 21.9823, distLy: 59, mag: 3.53, constellation: 'Gem', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'mebsuta', kind: 'star', name: 'Mebsuta', aliases: ['epsilon geminorum', 'ε gem'], raHours: 6.7322, decDeg: 25.1311, distLy: 840, mag: 2.98, constellation: 'Gem', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'tejat', kind: 'star', name: 'Tejat', aliases: ['mu geminorum', 'μ gem', 'tejat posterior'], raHours: 6.3827, decDeg: 22.5067, distLy: 230, mag: 2.88, constellation: 'Gem', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'propus', kind: 'star', name: 'Propus', aliases: ['eta geminorum', 'η gem', 'tejat prior'], raHours: 6.2480, decDeg: 22.5067, distLy: 380, mag: 3.28, constellation: 'Gem', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'zavijava', kind: 'star', name: 'Zavijava', aliases: ['beta virginis', 'β vir'], raHours: 11.8451, decDeg: 1.7647, distLy: 36, mag: 3.60, constellation: 'Vir', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'porrima', kind: 'star', name: 'Porrima', aliases: ['gamma virginis', 'γ vir'], raHours: 12.6943, decDeg: -1.4494, distLy: 38, mag: 2.74, constellation: 'Vir', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'vindemiatrix', kind: 'star', name: 'Vindemiatrix', aliases: ['epsilon virginis', 'ε vir'], raHours: 13.0363, decDeg: 10.9591, distLy: 102, mag: 2.83, constellation: 'Vir', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'heze', kind: 'star', name: 'Heze', aliases: ['zeta virginis', 'ζ vir'], raHours: 13.5786, decDeg: -0.5958, distLy: 74, mag: 3.38, constellation: 'Vir', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'zostma', kind: 'star', name: 'Zosma', aliases: ['delta leonis', 'δ leo'], raHours: 11.2351, decDeg: 20.5237, distLy: 58, mag: 2.56, constellation: 'Leo', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'chertan', kind: 'star', name: 'Chertan', aliases: ['theta leonis', 'θ leo', 'cox'], raHours: 11.2372, decDeg: 15.4297, distLy: 165, mag: 3.33, constellation: 'Leo', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'alterf', kind: 'star', name: 'Alterf', aliases: ['lambda leonis', 'λ leo'], raHours: 9.5286, decDeg: 22.9681, distLy: 320, mag: 4.32, constellation: 'Leo', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'rasalas', kind: 'star', name: 'Rasalas', aliases: ['mu leonis', 'μ leo'], raHours: 9.8794, decDeg: 26.0069, distLy: 124, mag: 3.88, constellation: 'Leo', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'adhafera', kind: 'star', name: 'Adhafera', aliases: ['zeta leonis', 'ζ leo'], raHours: 10.2787, decDeg: 23.4173, distLy: 274, mag: 3.44, constellation: 'Leo', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'alula-borealis', kind: 'star', name: 'Alula Borealis', aliases: ['nu ursae majoris', 'ν uma'], raHours: 11.3070, decDeg: 33.0942, distLy: 400, mag: 3.49, constellation: 'UMa', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'alula-australis', kind: 'star', name: 'Alula Australis', aliases: ['xi ursae majoris', 'ξ uma'], raHours: 11.3033, decDeg: 31.5292, distLy: 29, mag: 3.79, constellation: 'UMa', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'talitha', kind: 'star', name: 'Talitha', aliases: ['iota ursae majoris', 'ι uma'], raHours: 8.9869, decDeg: 48.0418, distLy: 48, mag: 3.14, constellation: 'UMa', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'tania-borealis', kind: 'star', name: 'Tania Borealis', aliases: ['lambda ursae majoris', 'λ uma'], raHours: 10.2847, decDeg: 42.9144, distLy: 134, mag: 3.45, constellation: 'UMa', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'tania-australis', kind: 'star', name: 'Tania Australis', aliases: ['mu ursae majoris', 'μ uma'], raHours: 10.3722, decDeg: 41.4994, distLy: 230, mag: 3.06, constellation: 'UMa', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'alcor', kind: 'star', name: 'Alcor', aliases: ['80 ursae majoris', 'g uma'], raHours: 13.4202, decDeg: 54.9878, distLy: 82, mag: 3.99, constellation: 'UMa', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'yildun', kind: 'star', name: 'Yildun', aliases: ['delta ursae minoris', 'δ umi'], raHours: 17.5369, decDeg: 86.5864, distLy: 183, mag: 4.35, constellation: 'UMi', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'pherkad', kind: 'star', name: 'Pherkad', aliases: ['gamma ursae minoris', 'γ umi'], raHours: 15.3456, decDeg: 71.8342, distLy: 480, mag: 3.05, constellation: 'UMi', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'rastaban', kind: 'star', name: 'Rastaban', aliases: ['beta draconis', 'β dra', 'alwaid'], raHours: 17.5072, decDeg: 52.3014, distLy: 380, mag: 2.79, constellation: 'Dra', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'aldhibah', kind: 'star', name: 'Aldhibah', aliases: ['zeta draconis', 'ζ dra'], raHours: 17.1467, decDeg: 65.7156, distLy: 340, mag: 3.17, constellation: 'Dra', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'ed-asich', kind: 'star', name: 'Edasich', aliases: ['iota draconis', 'ι dra'], raHours: 15.4155, decDeg: 58.9664, distLy: 101, mag: 3.29, constellation: 'Dra', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'gianfar', kind: 'star', name: 'Gianfar', aliases: ['lambda draconis', 'λ dra'], raHours: 11.5234, decDeg: 69.3311, distLy: 330, mag: 3.84, constellation: 'Dra', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'arrakis', kind: 'star', name: 'Arrakis', aliases: ['mu draconis', 'μ dra'], raHours: 17.0856, decDeg: 54.4703, distLy: 88, mag: 4.91, constellation: 'Dra', iconClass: 'fa fa-star', color: '#cfe0ff' },
  { id: 'unuk', kind: 'star', name: 'Alya', aliases: ['theta serpentis', 'θ ser'], raHours: 18.9367, decDeg: 4.2033, distLy: 132, mag: 4.62, constellation: 'Ser', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'cujam', kind: 'star', name: 'Cujam', aliases: ['omega herculis', 'ω her'], raHours: 16.4233, decDeg: 14.0717, distLy: 250, mag: 4.57, constellation: 'Her', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'marsic', kind: 'star', name: 'Marsic', aliases: ['kappa herculis', 'κ her'], raHours: 16.1344, decDeg: 17.0044, distLy: 390, mag: 4.25, constellation: 'Her', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'sarin', kind: 'star', name: 'Sarin', aliases: ['delta herculis', 'δ her'], raHours: 17.2505, decDeg: 24.8394, distLy: 75, mag: 3.14, constellation: 'Her', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'maasym', kind: 'star', name: 'Maasym', aliases: ['lambda herculis', 'λ her'], raHours: 17.5036, decDeg: 26.1103, distLy: 370, mag: 4.41, constellation: 'Her', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'proxima', kind: 'star', name: 'Proxima Centauri', aliases: ['proxima', 'alpha centauri c', 'v645 cen'], raHours: 14.4956, decDeg: -62.6794, distLy: 4.24, mag: 11.13, constellation: 'Cen', iconClass: 'fa fa-star', color: '#ff6b4a' },
  { id: 'barnard', kind: 'star', name: "Barnard's Star", aliases: ['barnard', 'vj 21185', 'etoile de barnard'], raHours: 17.9637, decDeg: 4.6933, distLy: 5.96, mag: 9.54, constellation: 'Oph', iconClass: 'fa fa-star', color: '#ff6b4a' },
  { id: '61-cygni', kind: 'star', name: '61 Cygni', aliases: ['61 cyg', 'bessel star', 'flying star'], raHours: 21.1133, decDeg: 38.7486, distLy: 11.4, mag: 5.20, constellation: 'Cyg', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'mira', kind: 'star', name: 'Mira', aliases: ['omicron ceti', 'ο cet', 'merveilleuse'], raHours: 2.3224, decDeg: -2.9775, distLy: 300, mag: 3.50, constellation: 'Cet', iconClass: 'fa fa-star', color: '#ff7a4a' },
  { id: 'garnet-star', kind: 'star', name: 'Garnet Star', aliases: ['mu cephei', 'μ cep', 'herschel garnet'], raHours: 21.7233, decDeg: 58.7828, distLy: 2800, mag: 4.08, constellation: 'Cep', iconClass: 'fa fa-star', color: '#ff4a3a' },
  { id: 'alderamin', kind: 'star', name: 'Alderamin', aliases: ['alpha cephei', 'α cep'], raHours: 21.3097, decDeg: 62.5856, distLy: 49, mag: 2.45, constellation: 'Cep', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'alfirk', kind: 'star', name: 'Alfirk', aliases: ['beta cephei', 'β cep'], raHours: 21.4775, decDeg: 70.5607, distLy: 690, mag: 3.23, constellation: 'Cep', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'errrai', kind: 'star', name: 'Errai', aliases: ['gamma cephei', 'γ cep', 'errai'], raHours: 23.6558, decDeg: 77.6325, distLy: 45, mag: 3.21, constellation: 'Cep', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'dabih', kind: 'star', name: 'Dabih', aliases: ['beta capricorni', 'β cap'], raHours: 20.3508, decDeg: -14.7814, distLy: 340, mag: 3.08, constellation: 'Cap', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'deneb-algedi', kind: 'star', name: 'Deneb Algedi', aliases: ['delta capricorni', 'δ cap'], raHours: 21.7844, decDeg: -16.1272, distLy: 39, mag: 2.85, constellation: 'Cap', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'nashira', kind: 'star', name: 'Nashira', aliases: ['gamma capricorni', 'γ cap'], raHours: 21.6683, decDeg: -16.6623, distLy: 139, mag: 3.68, constellation: 'Cap', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'giedi', kind: 'star', name: 'Algedi', aliases: ['alpha capricorni', 'α cap', 'giedi'], raHours: 20.2942, decDeg: -12.5072, distLy: 100, mag: 3.58, constellation: 'Cap', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'albali', kind: 'star', name: 'Albali', aliases: ['epsilon aquarii', 'ε aqr'], raHours: 20.7956, decDeg: -9.4956, distLy: 208, mag: 3.77, constellation: 'Aqr', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'situla', kind: 'star', name: 'Situla', aliases: ['kappa aquarii', 'κ aqr'], raHours: 22.6217, decDeg: -4.2308, distLy: 214, mag: 5.03, constellation: 'Aqr', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'ancha', kind: 'star', name: 'Ancha', aliases: ['theta aquarii', 'θ aqr'], raHours: 22.2806, decDeg: -7.7831, distLy: 191, mag: 4.16, constellation: 'Aqr', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'homam', kind: 'star', name: 'Homam', aliases: ['zeta pegasi', 'ζ peg'], raHours: 22.6867, decDeg: 10.8300, distLy: 204, mag: 3.40, constellation: 'Peg', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'biham', kind: 'star', name: 'Biham', aliases: ['theta pegasi', 'θ peg', 'baham'], raHours: 22.1697, decDeg: 6.1978, distLy: 97, mag: 3.53, constellation: 'Peg', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'sadalbari', kind: 'star', name: 'Sadalbari', aliases: ['mu pegasi', 'μ peg'], raHours: 22.8333, decDeg: 24.6014, distLy: 106, mag: 3.51, constellation: 'Peg', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'furud', kind: 'star', name: 'Furud', aliases: ['zeta canis majoris', 'ζ cma'], raHours: 6.3385, decDeg: -30.0634, distLy: 360, mag: 3.02, constellation: 'CMa', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'muliphein', kind: 'star', name: 'Muliphein', aliases: ['gamma canis majoris', 'γ cma'], raHours: 7.2472, decDeg: -15.6333, distLy: 440, mag: 4.11, constellation: 'CMa', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'aludra', kind: 'star', name: 'Aludra', aliases: ['eta canis majoris', 'η cma'], raHours: 7.4016, decDeg: -29.3031, distLy: 2000, mag: 2.45, constellation: 'CMa', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'markeb', kind: 'star', name: 'Markeb', aliases: ['kappa velorum', 'κ vel'], raHours: 9.3686, decDeg: -55.0107, distLy: 540, mag: 2.50, constellation: 'Vel', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'tureis', kind: 'star', name: 'Tureis', aliases: ['rho puppis', 'ρ pup'], raHours: 8.1257, decDeg: -24.3044, distLy: 64, mag: 2.83, constellation: 'Pup', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'asmidiske', kind: 'star', name: 'Asmidiske', aliases: ['xi puppis', 'ξ pup'], raHours: 7.8216, decDeg: -24.8597, distLy: 1200, mag: 3.35, constellation: 'Pup', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'tiaki', kind: 'star', name: 'Tiaki', aliases: ['beta gruis', 'β gru'], raHours: 22.7111, decDeg: -46.8847, distLy: 177, mag: 2.07, constellation: 'Gru', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'aldhanab', kind: 'star', name: 'Aldhanab', aliases: ['gamma gruis', 'γ gru'], raHours: 21.8986, decDeg: -37.3647, distLy: 211, mag: 3.00, constellation: 'Gru', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'muhlifain', kind: 'star', name: 'Muhlifain', aliases: ['gamma centauri', 'γ cen'], raHours: 12.6920, decDeg: -48.9597, distLy: 130, mag: 2.20, constellation: 'Cen', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'ke-kwan', kind: 'star', name: 'Ke Kwan', aliases: ['kappa centauri', 'κ cen'], raHours: 14.9867, decDeg: -42.1042, distLy: 380, mag: 3.13, constellation: 'Cen', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'yed-prior', kind: 'star', name: 'Yed Prior', aliases: ['delta ophiuchi', 'δ oph'], raHours: 16.2391, decDeg: -3.6944, distLy: 170, mag: 2.74, constellation: 'Oph', iconClass: 'fa fa-star', color: '#ff8a6b' },
  { id: 'yed-posterior', kind: 'star', name: 'Yed Posterior', aliases: ['epsilon ophiuchi', 'ε oph'], raHours: 16.3053, decDeg: -4.6925, distLy: 108, mag: 3.24, constellation: 'Oph', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'han', kind: 'star', name: 'Han', aliases: ['zeta ophiuchi', 'ζ oph'], raHours: 16.6193, decDeg: -10.5672, distLy: 366, mag: 2.56, constellation: 'Oph', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'marfik', kind: 'star', name: 'Marfik', aliases: ['lambda ophiuchi', 'λ oph'], raHours: 16.5150, decDeg: 1.9836, distLy: 170, mag: 3.82, constellation: 'Oph', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'girtab', kind: 'star', name: 'Girtab', aliases: ['kappa scorpii', 'κ sco'], raHours: 17.7081, decDeg: -39.0297, distLy: 460, mag: 2.39, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'jabhah', kind: 'star', name: 'Jabbah', aliases: ['nu scorpii', 'ν sco'], raHours: 16.1997, decDeg: -19.4606, distLy: 440, mag: 4.00, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'fang', kind: 'star', name: 'Fang', aliases: ['pi scorpii', 'π sco'], raHours: 15.9828, decDeg: -26.1142, distLy: 590, mag: 2.89, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'alniyat', kind: 'star', name: 'Alniyat', aliases: ['sigma scorpii', 'σ sco'], raHours: 16.3531, decDeg: -25.5928, distLy: 570, mag: 2.89, constellation: 'Sco', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'zeta-tau', kind: 'star', name: 'Tianguan', aliases: ['zeta tauri', 'ζ tau'], raHours: 5.6276, decDeg: 21.1425, distLy: 440, mag: 2.97, constellation: 'Tau', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'lambda-ori', kind: 'star', name: 'Meissa', aliases: ['lambda orionis', 'λ ori', 'hesa'], raHours: 5.5878, decDeg: 9.9342, distLy: 1100, mag: 3.39, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'hatysa', kind: 'star', name: 'Hatysa', aliases: ['iota orionis', 'ι ori', 'nair al saif'], raHours: 5.5917, decDeg: -5.9094, distLy: 1300, mag: 2.77, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'tabit', kind: 'star', name: 'Tabit', aliases: ['pi3 orionis', 'π3 ori'], raHours: 4.8164, decDeg: 6.9611, distLy: 26, mag: 3.19, constellation: 'Ori', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'thabit', kind: 'star', name: 'Thabit', aliases: ['upsilon orionis', 'υ ori'], raHours: 5.5306, decDeg: -7.3017, distLy: 1500, mag: 4.62, constellation: 'Ori', iconClass: 'fa fa-star', color: '#a8c8ff' },
  { id: 'cursa', kind: 'star', name: 'Cursa', aliases: ['beta eridani', 'β eri'], raHours: 5.1308, decDeg: -5.0864, distLy: 89, mag: 2.79, constellation: 'Eri', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'zibal', kind: 'star', name: 'Zibal', aliases: ['zeta eridani', 'ζ eri'], raHours: 3.2636, decDeg: -8.8197, distLy: 110, mag: 4.80, constellation: 'Eri', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'azha', kind: 'star', name: 'Azha', aliases: ['eta eridani', 'η eri'], raHours: 2.9408, decDeg: -8.8981, distLy: 137, mag: 3.89, constellation: 'Eri', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'beid', kind: 'star', name: 'Beid', aliases: ['omicron1 eridani', 'ο1 eri'], raHours: 4.2411, decDeg: -6.8378, distLy: 120, mag: 4.04, constellation: 'Eri', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'keid', kind: 'star', name: 'Keid', aliases: ['omicron2 eridani', 'ο2 eri', '40 eridani'], raHours: 4.2508, decDeg: -7.6528, distLy: 16.3, mag: 4.43, constellation: 'Eri', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'ran', kind: 'star', name: 'Ran', aliases: ['epsilon eridani', 'ε eri', 'ran'], raHours: 3.5488, decDeg: -9.4583, distLy: 10.5, mag: 3.73, constellation: 'Eri', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'achird', kind: 'star', name: 'Achird', aliases: ['eta cassiopeiae', 'η cas'], raHours: 0.8208, decDeg: 57.8153, distLy: 19.4, mag: 3.46, constellation: 'Cas', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'marfak', kind: 'star', name: 'Marfak', aliases: ['theta cassiopeiae', 'θ cas'], raHours: 1.1833, decDeg: 55.1497, distLy: 137, mag: 4.33, constellation: 'Cas', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'castula', kind: 'star', name: 'Castula', aliases: ['upsilon2 cassiopeiae', 'υ2 cas'], raHours: 0.8964, decDeg: 59.1797, distLy: 200, mag: 4.62, constellation: 'Cas', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'titawin', kind: 'star', name: 'Titawin', aliases: ['upsilon andromedae', 'υ and'], raHours: 1.6133, decDeg: 41.4056, distLy: 44, mag: 4.09, constellation: 'And', iconClass: 'fa fa-star', color: '#ffe0a8' },
  { id: 'adhil', kind: 'star', name: 'Adhil', aliases: ['xi andromedae', 'ξ and'], raHours: 1.3694, decDeg: 45.5308, distLy: 200, mag: 4.87, constellation: 'And', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'nembus', kind: 'star', name: 'Nembus', aliases: ['51 andromedae', 'υ per'], raHours: 1.6306, decDeg: 48.6283, distLy: 177, mag: 3.59, constellation: 'And', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'mesarthim', kind: 'star', name: 'Mesarthim', aliases: ['gamma arietis', 'γ ari'], raHours: 1.9106, decDeg: 19.2939, distLy: 164, mag: 3.86, constellation: 'Ari', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'sharatan', kind: 'star', name: 'Sharatan', aliases: ['beta arietis', 'β ari'], raHours: 1.9108, decDeg: 20.8081, distLy: 60, mag: 2.64, constellation: 'Ari', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'bharani', kind: 'star', name: 'Bharani', aliases: ['41 arietis', 'c ari'], raHours: 2.8328, decDeg: 27.2603, distLy: 160, mag: 3.61, constellation: 'Ari', iconClass: 'fa fa-star', color: '#c8dcff' },
  { id: 'baten-kaitos', kind: 'star', name: 'Baten Kaitos', aliases: ['zeta ceti', 'ζ cet'], raHours: 1.8577, decDeg: -10.3342, distLy: 235, mag: 3.74, constellation: 'Cet', iconClass: 'fa fa-star', color: '#ffb86b' },
  { id: 'kaffaljidhma', kind: 'star', name: 'Kaffaljidhma', aliases: ['gamma ceti', 'γ cet'], raHours: 2.7217, decDeg: 3.2361, distLy: 82, mag: 3.47, constellation: 'Cet', iconClass: 'fa fa-star', color: '#fff0d8' },
  { id: 'dheneb', kind: 'star', name: 'Dheneb', aliases: ['eta ceti', 'η cet'], raHours: 1.1431, decDeg: -10.1822, distLy: 124, mag: 3.46, constellation: 'Cet', iconClass: 'fa fa-star', color: '#ffb86b' }
];

/**
 * Bright / famous galaxies (J2000). Treated like fixed RA/Dec targets via DefineStar.
 * Apparent magnitudes are integrated (visual); distances approximate.
 */
export const ASTRO_GALAXIES: ReadonlyArray<AstroGalaxyOption> = [
  { id: 'm31', kind: 'galaxy', name: 'Andromeda (M31)', aliases: ['m31', 'ngc 224', 'andromede', 'andromède', 'great andromeda'], raHours: 0.7123, decDeg: 41.2692, distLy: 2_540_000, mag: 3.44, constellation: 'And', iconClass: 'fa fa-circle-o', color: '#c9b6ff' },
  { id: 'm33', kind: 'galaxy', name: 'Triangulum (M33)', aliases: ['m33', 'ngc 598', 'triangle', 'pinwheel triangulum'], raHours: 1.5642, decDeg: 30.6602, distLy: 2_730_000, mag: 5.72, constellation: 'Tri', iconClass: 'fa fa-circle-o', color: '#a8d4ff' },
  { id: 'lmc', kind: 'galaxy', name: 'Large Magellanic Cloud', aliases: ['lmc', 'grand nuage de magellan', 'nubecula major'], raHours: 5.3928, decDeg: -69.7561, distLy: 163_000, mag: 0.9, constellation: 'Dor', iconClass: 'fa fa-circle-o', color: '#ffe4b5' },
  { id: 'smc', kind: 'galaxy', name: 'Small Magellanic Cloud', aliases: ['smc', 'petit nuage de magellan', 'nubecula minor'], raHours: 0.8781, decDeg: -72.8359, distLy: 200_000, mag: 2.7, constellation: 'Tuc', iconClass: 'fa fa-circle-o', color: '#ffe9c0' },
  { id: 'm51', kind: 'galaxy', name: 'Whirlpool (M51)', aliases: ['m51', 'ngc 5194', 'tourbillon', 'whirlpool'], raHours: 13.4978, decDeg: 47.1952, distLy: 23_000_000, mag: 8.4, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#b8c8ff' },
  { id: 'm81', kind: 'galaxy', name: "Bode's Galaxy (M81)", aliases: ['m81', 'ngc 3031', 'bode', 'galaxie de bode'], raHours: 9.9264, decDeg: 69.0653, distLy: 12_000_000, mag: 6.94, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#d4c4ff' },
  { id: 'm82', kind: 'galaxy', name: 'Cigar Galaxy (M82)', aliases: ['m82', 'ngc 3034', 'cigare', 'cigar'], raHours: 9.9307, decDeg: 69.6797, distLy: 12_000_000, mag: 8.41, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#ffb0a0' },
  { id: 'm101', kind: 'galaxy', name: 'Pinwheel (M101)', aliases: ['m101', 'ngc 5457', 'moulinet', 'pinwheel'], raHours: 14.0535, decDeg: 54.3488, distLy: 21_000_000, mag: 7.86, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#cfe0ff' },
  { id: 'm104', kind: 'galaxy', name: 'Sombrero (M104)', aliases: ['m104', 'ngc 4594', 'sombrero'], raHours: 12.6660, decDeg: -11.6231, distLy: 29_300_000, mag: 8.0, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#e8d0a8' },
  { id: 'm64', kind: 'galaxy', name: 'Black Eye (M64)', aliases: ['m64', 'ngc 4826', 'oeil noir', 'œil noir', 'sleeping beauty'], raHours: 12.9445, decDeg: 21.6831, distLy: 17_000_000, mag: 8.52, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#d8b8ff' },
  { id: 'm87', kind: 'galaxy', name: 'Virgo A (M87)', aliases: ['m87', 'ngc 4486', 'virgo a'], raHours: 12.5137, decDeg: 12.3911, distLy: 53_500_000, mag: 8.63, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#b0a8ff' },
  { id: 'm94', kind: 'galaxy', name: "Cat's Eye Galaxy (M94)", aliases: ['m94', 'ngc 4736', 'oeil de chat'], raHours: 12.8481, decDeg: 41.1206, distLy: 16_000_000, mag: 8.24, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#ffd0a8' },
  { id: 'ngc253', kind: 'galaxy', name: 'Sculptor Galaxy (NGC 253)', aliases: ['ngc 253', 'sculptor', 'silver coin', 'galaxie du sculpteur'], raHours: 0.7927, decDeg: -25.2882, distLy: 11_400_000, mag: 7.2, constellation: 'Scl', iconClass: 'fa fa-circle-o', color: '#e0c8a0' },
  { id: 'cen-a', kind: 'galaxy', name: 'Centaurus A', aliases: ['ngc 5128', 'centaurus a', 'cen a'], raHours: 13.4247, decDeg: -43.0191, distLy: 12_000_000, mag: 6.84, constellation: 'Cen', iconClass: 'fa fa-circle-o', color: '#ffc8a0' },
  { id: 'm110', kind: 'galaxy', name: 'M110', aliases: ['m110', 'ngc 205', 'andromeda companion'], raHours: 0.6728, decDeg: 41.6853, distLy: 2_690_000, mag: 8.07, constellation: 'And', iconClass: 'fa fa-circle-o', color: '#c0b0e8' },
  { id: 'm32', kind: 'galaxy', name: 'M32', aliases: ['m32', 'ngc 221'], raHours: 0.7113, decDeg: 40.8653, distLy: 2_490_000, mag: 8.08, constellation: 'And', iconClass: 'fa fa-circle-o', color: '#b8a8e0' },
  { id: 'ngc2403', kind: 'galaxy', name: 'NGC 2403', aliases: ['ngc 2403', 'caldwell 7'], raHours: 7.6156, decDeg: 65.6025, distLy: 8_000_000, mag: 8.4, constellation: 'Cam', iconClass: 'fa fa-circle-o', color: '#c8d8ff' },
  { id: 'm83', kind: 'galaxy', name: 'Southern Pinwheel (M83)', aliases: ['m83', 'ngc 5236', 'southern pinwheel'], raHours: 13.6167, decDeg: -29.8658, distLy: 15_000_000, mag: 7.54, constellation: 'Hya', iconClass: 'fa fa-circle-o', color: '#ffe0b0' },
  { id: 'm74', kind: 'galaxy', name: 'Phantom Galaxy (M74)', aliases: ['m74', 'ngc 628', 'phantom'], raHours: 1.6117, decDeg: 15.7836, distLy: 30_000_000, mag: 9.46, constellation: 'Psc', iconClass: 'fa fa-circle-o', color: '#a8c8ff' },
  { id: 'm77', kind: 'galaxy', name: 'Cetus A (M77)', aliases: ['m77', 'ngc 1068', 'cetus a'], raHours: 2.7113, decDeg: -0.0133, distLy: 47_000_000, mag: 8.87, constellation: 'Cet', iconClass: 'fa fa-circle-o', color: '#d0b8ff' },
  { id: 'm66', kind: 'galaxy', name: 'M66', aliases: ['m66', 'ngc 3627', 'leo triplet'], raHours: 11.3367, decDeg: 12.9917, distLy: 36_000_000, mag: 8.92, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#ffc8a8' },
  { id: 'm65', kind: 'galaxy', name: 'M65', aliases: ['m65', 'ngc 3623'], raHours: 11.3136, decDeg: 13.0922, distLy: 35_000_000, mag: 9.33, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#ffd0b0' },
  { id: 'ngc891', kind: 'galaxy', name: 'NGC 891', aliases: ['ngc 891', 'caldwell 23', 'silver needle'], raHours: 2.3756, decDeg: 42.3492, distLy: 30_000_000, mag: 9.9, constellation: 'And', iconClass: 'fa fa-circle-o', color: '#d8c8e8' },
  { id: 'ic1101', kind: 'galaxy', name: 'IC 1101', aliases: ['ic 1101', 'ugc 9752'], raHours: 15.1797, decDeg: 5.7444, distLy: 1_045_000_000, mag: 14.7, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#a090c8' },
  { id: 'm63', kind: 'galaxy', name: 'Sunflower (M63)', aliases: ['m63', 'ngc 5055', 'tournesol', 'sunflower'], raHours: 13.2637, decDeg: 42.0294, distLy: 37_000_000, mag: 8.59, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#ffd080' },
  { id: 'm106', kind: 'galaxy', name: 'M106', aliases: ['m106', 'ngc 4258'], raHours: 12.3160, decDeg: 47.3039, distLy: 23_500_000, mag: 8.41, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#c8d0ff' },
  { id: 'm108', kind: 'galaxy', name: 'M108', aliases: ['m108', 'ngc 3556', 'surfboard'], raHours: 11.1917, decDeg: 55.6742, distLy: 46_000_000, mag: 9.87, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#d0c8e8' },
  { id: 'm109', kind: 'galaxy', name: 'M109', aliases: ['m109', 'ngc 3992'], raHours: 11.9600, decDeg: 53.3744, distLy: 83_000_000, mag: 9.84, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#c8d8ff' },
  { id: 'm95', kind: 'galaxy', name: 'M95', aliases: ['m95', 'ngc 3351'], raHours: 10.7328, decDeg: 11.7036, distLy: 33_000_000, mag: 9.73, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#ffd0a8' },
  { id: 'm96', kind: 'galaxy', name: 'M96', aliases: ['m96', 'ngc 3368'], raHours: 10.7789, decDeg: 11.8194, distLy: 31_000_000, mag: 9.25, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#ffc8a0' },
  { id: 'm105', kind: 'galaxy', name: 'M105', aliases: ['m105', 'ngc 3379'], raHours: 10.7964, decDeg: 12.5814, distLy: 32_000_000, mag: 9.76, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#d0b8ff' },
  { id: 'm49', kind: 'galaxy', name: 'M49', aliases: ['m49', 'ngc 4472'], raHours: 12.4964, decDeg: 8.0006, distLy: 56_000_000, mag: 8.40, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#c0b0e8' },
  { id: 'm58', kind: 'galaxy', name: 'M58', aliases: ['m58', 'ngc 4579'], raHours: 12.6283, decDeg: 11.8239, distLy: 62_000_000, mag: 9.66, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#d0c8ff' },
  { id: 'm59', kind: 'galaxy', name: 'M59', aliases: ['m59', 'ngc 4621'], raHours: 12.7006, decDeg: 11.6469, distLy: 60_000_000, mag: 9.57, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#b8a8e0' },
  { id: 'm60', kind: 'galaxy', name: 'M60', aliases: ['m60', 'ngc 4649'], raHours: 12.7281, decDeg: 11.5525, distLy: 55_000_000, mag: 8.83, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#c8b8f0' },
  { id: 'm61', kind: 'galaxy', name: 'M61', aliases: ['m61', 'ngc 4303'], raHours: 12.3642, decDeg: 4.4736, distLy: 52_500_000, mag: 9.65, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#cfe0ff' },
  { id: 'm84', kind: 'galaxy', name: 'M84', aliases: ['m84', 'ngc 4374'], raHours: 12.4194, decDeg: 12.8867, distLy: 55_000_000, mag: 9.15, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#b0a8d8' },
  { id: 'm85', kind: 'galaxy', name: 'M85', aliases: ['m85', 'ngc 4382'], raHours: 12.4231, decDeg: 18.1914, distLy: 60_000_000, mag: 9.15, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#d0c0e8' },
  { id: 'm86', kind: 'galaxy', name: 'M86', aliases: ['m86', 'ngc 4406'], raHours: 12.4367, decDeg: 12.9461, distLy: 52_000_000, mag: 8.90, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#b8b0e0' },
  { id: 'm88', kind: 'galaxy', name: 'M88', aliases: ['m88', 'ngc 4501'], raHours: 12.5333, decDeg: 14.4203, distLy: 47_000_000, mag: 9.62, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#c8d0ff' },
  { id: 'm89', kind: 'galaxy', name: 'M89', aliases: ['m89', 'ngc 4552'], raHours: 12.5947, decDeg: 12.5564, distLy: 50_000_000, mag: 9.75, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#c0b0e0' },
  { id: 'm90', kind: 'galaxy', name: 'M90', aliases: ['m90', 'ngc 4569'], raHours: 12.6133, decDeg: 13.1628, distLy: 59_000_000, mag: 9.54, constellation: 'Vir', iconClass: 'fa fa-circle-o', color: '#d0c8e8' },
  { id: 'm91', kind: 'galaxy', name: 'M91', aliases: ['m91', 'ngc 4548'], raHours: 12.5911, decDeg: 14.4961, distLy: 63_000_000, mag: 10.19, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#c8c0e8' },
  { id: 'm98', kind: 'galaxy', name: 'M98', aliases: ['m98', 'ngc 4192'], raHours: 12.2303, decDeg: 14.9039, distLy: 44_000_000, mag: 10.14, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#d0d8ff' },
  { id: 'm99', kind: 'galaxy', name: 'M99', aliases: ['m99', 'ngc 4254', 'comae pinwheel'], raHours: 12.3142, decDeg: 14.4164, distLy: 50_000_000, mag: 9.87, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#cfe0ff' },
  { id: 'm100', kind: 'galaxy', name: 'M100', aliases: ['m100', 'ngc 4321'], raHours: 12.3814, decDeg: 15.8225, distLy: 55_000_000, mag: 9.35, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#c8d8ff' },
  { id: 'ngc4565', kind: 'galaxy', name: 'Needle Galaxy (NGC 4565)', aliases: ['ngc 4565', 'caldwell 38', 'aiguille', 'needle'], raHours: 12.6067, decDeg: 25.9881, distLy: 40_000_000, mag: 9.60, constellation: 'Com', iconClass: 'fa fa-circle-o', color: '#e0d0b0' },
  { id: 'ngc4631', kind: 'galaxy', name: 'Whale Galaxy (NGC 4631)', aliases: ['ngc 4631', 'caldwell 32', 'whale', 'baleine'], raHours: 12.7047, decDeg: 32.5417, distLy: 25_000_000, mag: 9.00, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#e8d0a8' },
  { id: 'ngc3115', kind: 'galaxy', name: 'Spindle Galaxy (NGC 3115)', aliases: ['ngc 3115', 'caldwell 53', 'spindle'], raHours: 10.0853, decDeg: -7.7186, distLy: 32_000_000, mag: 8.90, constellation: 'Sex', iconClass: 'fa fa-circle-o', color: '#d8c8a8' },
  { id: 'ngc7331', kind: 'galaxy', name: 'NGC 7331', aliases: ['ngc 7331', 'caldwell 30'], raHours: 22.6186, decDeg: 34.4158, distLy: 40_000_000, mag: 9.48, constellation: 'Peg', iconClass: 'fa fa-circle-o', color: '#c8d0e8' },
  { id: 'ngc6946', kind: 'galaxy', name: 'Fireworks Galaxy (NGC 6946)', aliases: ['ngc 6946', 'caldwell 12', 'fireworks', 'feu dartifice'], raHours: 20.5819, decDeg: 60.1539, distLy: 22_500_000, mag: 8.90, constellation: 'Cyg', iconClass: 'fa fa-circle-o', color: '#ffb090' },
  { id: 'ngc1300', kind: 'galaxy', name: 'NGC 1300', aliases: ['ngc 1300'], raHours: 3.3308, decDeg: -19.4111, distLy: 61_000_000, mag: 10.40, constellation: 'Eri', iconClass: 'fa fa-circle-o', color: '#cfe0ff' },
  { id: 'ngc1365', kind: 'galaxy', name: 'Great Barred Spiral (NGC 1365)', aliases: ['ngc 1365', 'fornax spiral'], raHours: 3.5603, decDeg: -36.1406, distLy: 56_000_000, mag: 9.50, constellation: 'For', iconClass: 'fa fa-circle-o', color: '#ffe0b0' },
  { id: 'ngc1316', kind: 'galaxy', name: 'Fornax A (NGC 1316)', aliases: ['ngc 1316', 'fornax a'], raHours: 3.3775, decDeg: -37.2083, distLy: 62_000_000, mag: 8.20, constellation: 'For', iconClass: 'fa fa-circle-o', color: '#e0c8a0' },
  { id: 'ngc55', kind: 'galaxy', name: 'NGC 55', aliases: ['ngc 55', 'caldwell 72'], raHours: 0.2481, decDeg: -39.1967, distLy: 6_500_000, mag: 7.90, constellation: 'Scl', iconClass: 'fa fa-circle-o', color: '#e8d0a8' },
  { id: 'ngc300', kind: 'galaxy', name: 'NGC 300', aliases: ['ngc 300', 'caldwell 70'], raHours: 0.9128, decDeg: -37.6844, distLy: 6_100_000, mag: 8.13, constellation: 'Scl', iconClass: 'fa fa-circle-o', color: '#d8c8b0' },
  { id: 'ngc247', kind: 'galaxy', name: 'NGC 247', aliases: ['ngc 247', 'caldwell 62'], raHours: 0.7847, decDeg: -20.7603, distLy: 11_100_000, mag: 8.90, constellation: 'Cet', iconClass: 'fa fa-circle-o', color: '#d0c8b8' },
  { id: 'ngc4945', kind: 'galaxy', name: 'NGC 4945', aliases: ['ngc 4945', 'caldwell 83'], raHours: 13.0889, decDeg: -49.4683, distLy: 13_000_000, mag: 8.60, constellation: 'Cen', iconClass: 'fa fa-circle-o', color: '#e0c0a0' },
  { id: 'ngc5128-companion', kind: 'galaxy', name: 'Antennae (NGC 4038/9)', aliases: ['ngc 4038', 'ngc 4039', 'antennae', 'antennes'], raHours: 12.0306, decDeg: -18.8681, distLy: 45_000_000, mag: 10.30, constellation: 'Crv', iconClass: 'fa fa-circle-o', color: '#ffc8a0' },
  { id: 'ngc5195', kind: 'galaxy', name: 'NGC 5195', aliases: ['ngc 5195', 'm51 companion', 'whirlpool companion'], raHours: 13.4994, decDeg: 47.2661, distLy: 25_000_000, mag: 9.55, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#b0b8e0' },
  { id: 'ic342', kind: 'galaxy', name: 'IC 342', aliases: ['ic 342', 'caldwell 5', 'hidden galaxy'], raHours: 3.7800, decDeg: 68.0964, distLy: 10_700_000, mag: 8.40, constellation: 'Cam', iconClass: 'fa fa-circle-o', color: '#c8d8ff' },
  { id: 'ngc6822', kind: 'galaxy', name: "Barnard's Galaxy (NGC 6822)", aliases: ['ngc 6822', 'caldwell 57', 'barnard galaxy'], raHours: 19.7481, decDeg: -14.8031, distLy: 1_600_000, mag: 8.80, constellation: 'Sgr', iconClass: 'fa fa-circle-o', color: '#ffe4b5' },
  { id: 'wlm', kind: 'galaxy', name: 'Wolf–Lundmark–Melotte', aliases: ['wlm', 'ddo 221', 'ugca 444'], raHours: 0.0331, decDeg: -15.4608, distLy: 3_040_000, mag: 10.90, constellation: 'Cet', iconClass: 'fa fa-circle-o', color: '#d0c8b0' },
  { id: 'ngc147', kind: 'galaxy', name: 'NGC 147', aliases: ['ngc 147', 'caldwell 17'], raHours: 0.5533, decDeg: 48.5083, distLy: 2_580_000, mag: 9.50, constellation: 'Cas', iconClass: 'fa fa-circle-o', color: '#c0b0d8' },
  { id: 'ngc185', kind: 'galaxy', name: 'NGC 185', aliases: ['ngc 185', 'caldwell 18'], raHours: 0.6497, decDeg: 48.3375, distLy: 2_050_000, mag: 9.20, constellation: 'Cas', iconClass: 'fa fa-circle-o', color: '#b8a8d0' },
  { id: 'm102', kind: 'galaxy', name: 'Spindle (M102 / NGC 5866)', aliases: ['m102', 'ngc 5866', 'caldwell 15'], raHours: 15.1081, decDeg: 55.7631, distLy: 50_000_000, mag: 9.89, constellation: 'Dra', iconClass: 'fa fa-circle-o', color: '#d8c8a8' },
  { id: 'ngc5907', kind: 'galaxy', name: 'NGC 5907', aliases: ['ngc 5907', 'splinter galaxy', 'knife edge'], raHours: 15.2658, decDeg: 56.3294, distLy: 53_000_000, mag: 10.40, constellation: 'Dra', iconClass: 'fa fa-circle-o', color: '#e0d0b0' },
  { id: 'cartwheel', kind: 'galaxy', name: 'Cartwheel Galaxy', aliases: ['eso 350-40', 'cartwheel', 'roue de chariot'], raHours: 0.6228, decDeg: -33.7156, distLy: 500_000_000, mag: 14.30, constellation: 'Scl', iconClass: 'fa fa-circle-o', color: '#a8c8ff' },
  { id: 'hoag', kind: 'galaxy', name: "Hoag's Object", aliases: ['hoag', 'prc d-51'], raHours: 15.2881, decDeg: 21.5858, distLy: 600_000_000, mag: 15.20, constellation: 'Ser', iconClass: 'fa fa-circle-o', color: '#b0c0ff' },
  { id: 'circinus', kind: 'galaxy', name: 'Circinus Galaxy', aliases: ['eso 97-g13', 'circinus'], raHours: 14.2211, decDeg: -65.3392, distLy: 13_000_000, mag: 10.60, constellation: 'Cir', iconClass: 'fa fa-circle-o', color: '#ffc8a0' },
  { id: 'maffei1', kind: 'galaxy', name: 'Maffei 1', aliases: ['maffei 1', 'ugca 34'], raHours: 2.6053, decDeg: 59.6056, distLy: 9_800_000, mag: 11.10, constellation: 'Cas', iconClass: 'fa fa-circle-o', color: '#c0b0c8' },
  { id: 'maffei2', kind: 'galaxy', name: 'Maffei 2', aliases: ['maffei 2', 'ugca 39'], raHours: 2.6972, decDeg: 59.6042, distLy: 9_800_000, mag: 12.50, constellation: 'Cas', iconClass: 'fa fa-circle-o', color: '#b8a8c0' },
  { id: 'leo-i', kind: 'galaxy', name: 'Leo I', aliases: ['leo i', 'ugc 5470', 'regulus dwarf'], raHours: 10.1397, decDeg: 12.3064, distLy: 820_000, mag: 11.20, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#d8c8b0' },
  { id: 'fornax-dwarf', kind: 'galaxy', name: 'Fornax Dwarf', aliases: ['fornax dwarf', 'eso 356-04'], raHours: 2.6667, decDeg: -34.4492, distLy: 460_000, mag: 7.40, constellation: 'For', iconClass: 'fa fa-circle-o', color: '#e0d0b0' },
  { id: 'sculptor-dwarf', kind: 'galaxy', name: 'Sculptor Dwarf', aliases: ['sculptor dwarf', 'eso 351-30'], raHours: 1.0028, decDeg: -33.7092, distLy: 290_000, mag: 8.60, constellation: 'Scl', iconClass: 'fa fa-circle-o', color: '#d8c8a8' },
  { id: 'ngc1232', kind: 'galaxy', name: 'NGC 1232', aliases: ['ngc 1232'], raHours: 3.1647, decDeg: -20.5781, distLy: 61_000_000, mag: 9.90, constellation: 'Eri', iconClass: 'fa fa-circle-o', color: '#cfe0ff' },
  { id: 'ngc4656', kind: 'galaxy', name: 'Hockey Stick (NGC 4656)', aliases: ['ngc 4656', 'hockey stick', 'crowbar'], raHours: 12.7333, decDeg: 32.1681, distLy: 25_000_000, mag: 10.50, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#e0d0a8' },
  { id: 'ngc3628', kind: 'galaxy', name: 'NGC 3628', aliases: ['ngc 3628', 'hamburger galaxy', 'leo triplet'], raHours: 11.3358, decDeg: 13.5892, distLy: 35_000_000, mag: 9.48, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#e8d0a8' },
  { id: 'ngc2903', kind: 'galaxy', name: 'NGC 2903', aliases: ['ngc 2903'], raHours: 9.5333, decDeg: 21.5011, distLy: 30_000_000, mag: 8.90, constellation: 'Leo', iconClass: 'fa fa-circle-o', color: '#ffd0a8' },
  { id: 'ngc3184', kind: 'galaxy', name: 'NGC 3184', aliases: ['ngc 3184'], raHours: 10.3047, decDeg: 41.4244, distLy: 36_000_000, mag: 9.80, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#c8d8ff' },
  { id: 'ngc4449', kind: 'galaxy', name: 'NGC 4449', aliases: ['ngc 4449', 'caldwell 21'], raHours: 12.4694, decDeg: 44.0936, distLy: 12_500_000, mag: 9.40, constellation: 'CVn', iconClass: 'fa fa-circle-o', color: '#ffe0b0' },
  { id: 'ngc3077', kind: 'galaxy', name: 'NGC 3077', aliases: ['ngc 3077'], raHours: 10.0553, decDeg: 68.7333, distLy: 12_500_000, mag: 9.90, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#ffc8a0' },
  { id: 'ngc2976', kind: 'galaxy', name: 'NGC 2976', aliases: ['ngc 2976'], raHours: 9.7856, decDeg: 67.9150, distLy: 11_600_000, mag: 10.20, constellation: 'UMa', iconClass: 'fa fa-circle-o', color: '#d0c8b0' },
  { id: 'ic1613', kind: 'galaxy', name: 'IC 1613', aliases: ['ic 1613', 'caldwell 51'], raHours: 1.0786, decDeg: 2.1181, distLy: 2_380_000, mag: 9.20, constellation: 'Cet', iconClass: 'fa fa-circle-o', color: '#ffe4b5' },
  { id: 'ngc3109', kind: 'galaxy', name: 'NGC 3109', aliases: ['ngc 3109'], raHours: 10.0514, decDeg: -26.1589, distLy: 4_300_000, mag: 9.90, constellation: 'Hya', iconClass: 'fa fa-circle-o', color: '#e0d0b0' },
  { id: 'sextans-a', kind: 'galaxy', name: 'Sextans A', aliases: ['sextans a', 'ugca 205'], raHours: 10.1833, decDeg: -4.6931, distLy: 4_300_000, mag: 11.50, constellation: 'Sex', iconClass: 'fa fa-circle-o', color: '#d8c8b0' },
  { id: 'ngc7793', kind: 'galaxy', name: 'NGC 7793', aliases: ['ngc 7793'], raHours: 23.9644, decDeg: -32.5911, distLy: 12_700_000, mag: 9.00, constellation: 'Scl', iconClass: 'fa fa-circle-o', color: '#e0d0a8' }
];

function matchesFixedSkyQuery(obj: AstroFixedSkyOption, q: string): boolean {
  if (obj.name.toLowerCase().includes(q) || obj.id.includes(q)) {
    return true;
  }
  if (obj.constellation && obj.constellation.toLowerCase().includes(q)) {
    return true;
  }
  return obj.aliases.some((a) => a.toLowerCase().includes(q));
}

function sortFixedSkyByName<T extends AstroFixedSkyOption>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function findStarsByQuery(query: string): AstroStarOption[] {
  const q = query.trim().toLowerCase();
  const list = !q
    ? [...ASTRO_BRIGHT_STARS]
    : ASTRO_BRIGHT_STARS.filter((s) => matchesFixedSkyQuery(s, q));
  return sortFixedSkyByName(list);
}

export function findGalaxiesByQuery(query: string): AstroGalaxyOption[] {
  const q = query.trim().toLowerCase();
  const list = !q
    ? [...ASTRO_GALAXIES]
    : ASTRO_GALAXIES.filter((g) => matchesFixedSkyQuery(g, q));
  return sortFixedSkyByName(list);
}

export function findPlanetById(id: string): AstroBodyOption | undefined {
  return ASTRO_PLANETS.find((p) => p.id === id);
}

export function findStarById(id: string): AstroStarOption | undefined {
  return ASTRO_BRIGHT_STARS.find((s) => s.id === id);
}

export function findGalaxyById(id: string): AstroGalaxyOption | undefined {
  return ASTRO_GALAXIES.find((g) => g.id === id);
}
