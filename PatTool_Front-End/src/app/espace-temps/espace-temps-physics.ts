/**
 * Relativité générale pour la page « Espace-temps ».
 *
 * Vue « grille » : métrique de Schwarzschild en unités géométriques (G = c = 1),
 * longueurs en unités de scène, masse M = rs / 2.
 * Vue « pomme » : pesanteur uniforme (coordonnées de Rindler), temps en années,
 * longueurs en années-lumière, donc c = 1.
 */

const YEAR_S = 31_557_600;
const LIGHT_YEAR_M = 9.4607304725808e15;

/** Pesanteur terrestre exprimée en années-lumière par an² (≈ 1,03). */
export const EARTH_GRAVITY_LY_PER_YR2 = (9.80665 * YEAR_S * YEAR_S) / LIGHT_YEAR_M;

/** Rayon de Schwarzschild du Soleil rapporté à son rayon réel. */
export const SUN_COMPACTNESS = 2953 / 695_700_000;

/**
 * Hauteur du diagramme de plongement de la tranche équatoriale.
 * Extérieur : paraboloïde de Flamm. Intérieur : calotte sphérique de la solution
 * de Schwarzschild à densité constante ; les deux se raccordent sans cassure en r = bodyRadius.
 * Valable pour bodyRadius > rs.
 */
export function embeddingHeight(r: number, rs: number, bodyRadius: number): number {
  if (rs <= 1e-9) {
    return 0;
  }
  const rr = Math.max(0, r);
  if (rr >= bodyRadius) {
    return 2 * Math.sqrt(rs * (rr - rs));
  }
  const surface = 2 * Math.sqrt(rs * (bodyRadius - rs));
  const a2 = (bodyRadius * bodyRadius * bodyRadius) / rs;
  const rootSurface = Math.sqrt(a2 - bodyRadius * bodyRadius);
  const rootInside = Math.sqrt(a2 - rr * rr);
  return surface - (bodyRadius * bodyRadius - rr * rr) / (rootSurface + rootInside);
}

/**
 * Rythme d'une horloge immobile à la distance r, rapporté à une horloge très éloignée
 * (1 = temps normal, plus petit = temps ralenti). Valable pour bodyRadius > 9/8 rs.
 */
export function clockRate(r: number, rs: number, bodyRadius: number): number {
  if (rs <= 0) {
    return 1;
  }
  if (r >= bodyRadius) {
    return Math.sqrt(1 - rs / r);
  }
  const surface = Math.sqrt(1 - rs / bodyRadius);
  const inside = Math.sqrt(1 - (rs * r * r) / (bodyRadius * bodyRadius * bodyRadius));
  return 1.5 * surface - 0.5 * inside;
}

export interface OrbitState {
  r: number;
  /** dr/dτ */
  vr: number;
  phi: number;
}

function radialAcceleration(r: number, h: number, m: number, relativistic: boolean): number {
  const r2 = r * r;
  const newton = -m / r2 + (h * h) / (r2 * r);
  return relativistic ? newton - (3 * m * h * h) / (r2 * r2) : newton;
}

/**
 * Avance d'un pas dτ (Runge-Kutta 4) une particule libre de moment cinétique h par unité de masse.
 * relativistic = true : géodésique de Schwarzschild (temps propre) ; false : gravitation de Newton.
 */
export function stepOrbit(s: OrbitState, h: number, m: number, dt: number, relativistic: boolean): OrbitState {
  const acc = (r: number): number => radialAcceleration(r, h, m, relativistic);
  const spin = (r: number): number => h / (r * r);

  const k1r = s.vr;
  const k1v = acc(s.r);
  const k1p = spin(s.r);

  const r2 = s.r + 0.5 * dt * k1r;
  const k2r = s.vr + 0.5 * dt * k1v;
  const k2v = acc(r2);
  const k2p = spin(r2);

  const r3 = s.r + 0.5 * dt * k2r;
  const k3r = s.vr + 0.5 * dt * k2v;
  const k3v = acc(r3);
  const k3p = spin(r3);

  const r4 = s.r + dt * k3r;
  const k4r = s.vr + dt * k3v;
  const k4v = acc(r4);
  const k4p = spin(r4);

  return {
    r: s.r + (dt / 6) * (k1r + 2 * k2r + 2 * k3r + k4r),
    vr: s.vr + (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v),
    phi: s.phi + (dt / 6) * (k1p + 2 * k2p + 2 * k3p + k4p)
  };
}

/** Vitesse tangentielle (h / r) de l'orbite circulaire de Schwarzschild ; NaN en deçà de r = 1,5 rs. */
export function circularSpeed(r: number, rs: number): number {
  const m = rs / 2;
  return r > 3 * m ? Math.sqrt(m / (r - 3 * m)) : NaN;
}

/** Vitesse tangentielle (h / r) à partir de laquelle la particule n'est plus liée. */
export function escapeSpeed(r: number, rs: number): number {
  return r > rs ? Math.sqrt(rs / (r - rs)) : NaN;
}

const FLAT_G = 1e-6;

function sinhOverG(g: number, t: number): number {
  return g < FLAT_G ? t : Math.sinh(g * t) / g;
}

function coshMinusOneOverG(g: number, t: number): number {
  return g < FLAT_G ? 0.5 * g * t * t : (Math.cosh(g * t) - 1) / g;
}

export interface DiagramPoint {
  time: number;
  height: number;
}

/**
 * Événement repéré par le sol (temps t de l'horloge du sol, hauteur z) exprimé dans le repère
 * en chute libre qui était immobile par rapport au sol à t = 0.
 */
export function groundFrameToFreeFall(g: number, t: number, z: number): DiagramPoint {
  return {
    time: z * Math.sinh(g * t) + sinhOverG(g, t),
    height: z * Math.cosh(g * t) + coshMinusOneOverG(g, t)
  };
}

/** Hauteur, vue du sol, d'une pomme lâchée sans vitesse de la hauteur z0 à t = 0. */
export function appleHeight(g: number, t: number, z0: number): number {
  const c = Math.cosh(g * t);
  return z0 / c - coshMinusOneOverG(g, t) / c;
}

/** Temps écoulé sur la montre de la pomme quand l'horloge du sol indique t. */
export function appleProperTime(g: number, t: number, z0: number): number {
  const th = Math.tanh(g * t);
  return z0 * th + (g < FLAT_G ? t : th / g);
}

/** Temps écoulé sur une horloge fixée à la hauteur z quand l'horloge du sol indique t. */
export function fixedClockTime(g: number, t: number, z: number): number {
  return (1 + g * z) * t;
}

/** Instant (horloge du sol) où la pomme touche le sol ; infini sans pesanteur. */
export function impactTime(g: number, z0: number): number {
  return g < FLAT_G ? Infinity : Math.acosh(1 + g * z0) / g;
}

/* ---------- Vue « horloges » : unités SI ---------- */

export const LIGHT_SPEED_M_S = 299_792_458;
export const DAY_S = 86_400;

/** Rayon de Schwarzschild (m) d'un astre de paramètre gravitationnel GM (m³/s²). */
export function schwarzschildRadius(gm: number): number {
  return (2 * gm) / (LIGHT_SPEED_M_S * LIGHT_SPEED_M_S);
}

export interface ClockDrift {
  /** Effet de l'altitude seule (positif : l'horloge haute avance). */
  altitude: number;
  /** Effet de la vitesse orbitale (négatif : l'horloge haute retarde) ; 0 pour une horloge immobile. */
  speed: number;
  total: number;
}

/**
 * Écart de rythme entre une horloge à la distance r du centre et une horloge posée à la surface
 * (rayon bodyRadius) d'un astre sphérique sans rotation, en fraction du temps écoulé au sol.
 * orbiting = true : orbite circulaire (rythme √(1 − 1,5 rs/r)) ; false : horloge immobile (√(1 − rs/r)).
 * Les différences sont écrites sous forme conjuguée pour rester exactes quand rs/r ≈ 1e-10.
 */
export function clockDrift(rs: number, bodyRadius: number, r: number, orbiting: boolean): ClockDrift {
  const surface = Math.sqrt(1 - rs / bodyRadius);
  const still = Math.sqrt(1 - rs / r);
  const altitude = (rs / bodyRadius - rs / r) / (still + surface) / surface;
  let speed = 0;
  if (orbiting) {
    const moving = Math.sqrt(1 - (1.5 * rs) / r);
    speed = (-0.5 * rs) / r / (moving + still) / surface;
  }
  return { altitude, speed, total: altitude + speed };
}

/** Vitesse (m/s) d'une orbite circulaire de rayon r, mesurée par un observateur immobile sur place. */
export function orbitalSpeed(rs: number, r: number): number {
  return LIGHT_SPEED_M_S * Math.sqrt(rs / 2 / (r - rs));
}

/* ---------- Vue « lumière » : unités géométriques, comme la vue « grille » ---------- */

/** Distance de visée en deçà de laquelle un trou noir capture la lumière : (3√3 / 2) rs. */
export function criticalImpactParameter(rs: number): number {
  return 1.5 * Math.sqrt(3) * rs;
}

export interface LightRay {
  x: number[];
  y: number[];
  /** Temps mesuré par un observateur lointain, 0 au départ du rayon. */
  t: number[];
  fate: 'escaped' | 'absorbed';
}

/**
 * Rayon lumineux partant de (startX, b) vers les x croissants, autour d'une masse placée à l'origine :
 * géodésique nulle de Schwarzschild (Runge-Kutta 4 en paramètre affine, E = 1, moment cinétique −b).
 * Le rayon s'arrête à absorbRadius (surface de l'étoile, ou juste au-dessus de l'horizon) ou à exitRadius.
 */
export function traceLightRay(b: number, rs: number, absorbRadius: number, startX: number, exitRadius: number): LightRay {
  const ray: LightRay = { x: [], y: [], t: [], fate: 'escaped' };
  if (rs <= 1e-9) {
    const endX = Math.sqrt(Math.max(0, exitRadius * exitRadius - b * b));
    for (let x = startX; x < endX; x += 2) {
      ray.x.push(x);
      ray.y.push(b);
      ray.t.push(x - startX);
    }
    ray.x.push(endX);
    ray.y.push(b);
    ray.t.push(endX - startX);
    return ray;
  }

  const l2 = b * b;
  let r = Math.hypot(startX, b);
  let phi = Math.atan2(b, startX);
  let t = 0;
  let vr = -Math.sqrt(Math.max(0, 1 - ((1 - rs / r) * l2) / (r * r)));
  const acc = (q: number): number => l2 / (q * q * q) - (1.5 * rs * l2) / (q * q * q * q);
  const spin = (q: number): number => -b / (q * q);
  const clock = (q: number): number => 1 / (1 - rs / q);

  for (let i = 0; i < 8000; i++) {
    ray.x.push(r * Math.cos(phi));
    ray.y.push(r * Math.sin(phi));
    ray.t.push(t);
    if (r <= absorbRadius) {
      ray.fate = 'absorbed';
      break;
    }
    if (r >= exitRadius && vr > 0) {
      break;
    }
    const d = Math.min(0.4, Math.max(0.02, 0.03 * r));

    const k1r = vr;
    const k1v = acc(r);
    const q2 = Math.max(r + 0.5 * d * k1r, absorbRadius * 0.999);
    const k2r = vr + 0.5 * d * k1v;
    const k2v = acc(q2);
    const q3 = Math.max(r + 0.5 * d * k2r, absorbRadius * 0.999);
    const k3r = vr + 0.5 * d * k2v;
    const k3v = acc(q3);
    const q4 = Math.max(r + d * k3r, absorbRadius * 0.999);
    const k4r = vr + d * k3v;
    const k4v = acc(q4);

    phi += (d / 6) * (spin(r) + 2 * spin(q2) + 2 * spin(q3) + spin(q4));
    t += (d / 6) * (clock(r) + 2 * clock(q2) + 2 * clock(q3) + clock(q4));
    vr += (d / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    r = Math.max(r + (d / 6) * (k1r + 2 * k2r + 2 * k3r + k4r), absorbRadius * 0.999);
  }
  return ray;
}

export interface LightDeflection {
  /** Le rayon n'est pas ressorti : absorbé par l'astre ou capturé par le trou noir. */
  captured: boolean;
  /** Angle de déviation (rad) entre la direction d'arrivée et la direction de sortie. */
  angle: number;
}

/**
 * Déviation totale d'un rayon venu de l'infini avec la distance de visée b :
 * intégration de u'' + u = 1,5 rs u² (u = 1/r) depuis u = 0 jusqu'au retour à u = 0.
 */
export function lightDeflection(b: number, rs: number, absorbRadius: number): LightDeflection {
  if (rs <= 0) {
    return { captured: false, angle: 0 };
  }
  const uMax = 1 / Math.max(absorbRadius, rs);
  const dPhi = 0.001;
  const maxSteps = Math.ceil((40 * Math.PI) / dPhi);
  const acc = (u: number): number => 1.5 * rs * u * u - u;
  let u = 0;
  let du = 1 / b;
  for (let i = 0; i < maxSteps; i++) {
    const k1u = du;
    const k1d = acc(u);
    const k2u = du + 0.5 * dPhi * k1d;
    const k2d = acc(u + 0.5 * dPhi * k1u);
    const k3u = du + 0.5 * dPhi * k2d;
    const k3d = acc(u + 0.5 * dPhi * k2u);
    const k4u = du + dPhi * k3d;
    const k4d = acc(u + dPhi * k3u);
    const next = u + (dPhi / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
    du += (dPhi / 6) * (k1d + 2 * k2d + 2 * k3d + k4d);
    if (next >= uMax) {
      return { captured: true, angle: NaN };
    }
    if (next <= 0) {
      const phiEnd = (i + u / (u - next)) * dPhi;
      return { captured: false, angle: phiEnd - Math.PI };
    }
    u = next;
  }
  return { captured: true, angle: NaN };
}
