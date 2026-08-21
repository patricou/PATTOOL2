/** Planck 2018-ish flat ΛCDM. H0 in km/s/Mpc. */
export interface CosmoParams {
  readonly H0: number;
  readonly Om: number;
  readonly Ol: number;
  readonly Or: number;
}

export const LCDM: CosmoParams = {
  H0: 67.4,
  Om: 0.315,
  Ol: 0.685,
  Or: 9.0e-5
};

/**
 * Closed matter-dominated toy model (no dark energy).
 * Used only as a contrast: recollapse to a point (Big Crunch).
 */
export const BIG_CRUNCH: CosmoParams = {
  H0: 67.4,
  Om: 1.85,
  Ol: 0,
  Or: 9.0e-5
};

export type CosmoScenario = 'lcdm' | 'crunch';

export function paramsFor(scenario: CosmoScenario): CosmoParams {
  return scenario === 'crunch' ? BIG_CRUNCH : LCDM;
}

export function curvatureOk(p: CosmoParams): number {
  return 1 - p.Om - p.Ol - p.Or;
}

/** 1 / (1 km s⁻¹ Mpc⁻¹) in Gyr. */
const MPC_S_PER_KM_GYR = 977.79222168;

export function h0PerGyr(p: CosmoParams): number {
  return p.H0 / MPC_S_PER_KM_GYR;
}

/** E(a) = H(a)/H0. Clamped ≥ 0. */
export function hubbleE(a: number, p: CosmoParams): number {
  const aa = Math.max(a, 1e-8);
  const inner = p.Om / (aa * aa * aa) + p.Or / (aa * aa * aa * aa) + p.Ol + curvatureOk(p) / (aa * aa);
  return Math.sqrt(Math.max(inner, 0));
}

export interface CosmoSample {
  readonly tGyr: number;
  readonly a: number;
  /** +1 expanding, −1 contracting. */
  readonly sign: 1 | -1;
}

export interface CosmoTimeline {
  readonly params: CosmoParams;
  readonly samples: readonly CosmoSample[];
  /** Age of the universe at a = 1 (Gyr). */
  readonly ageNowGyr: number;
  /** Absolute time of recollapse, or Infinity. */
  readonly crunchGyr: number;
  readonly aMax: number;
}

function dadt(a: number, sign: 1 | -1, p: CosmoParams): number {
  return sign * h0PerGyr(p) * a * hubbleE(a, p);
}

function integrateTimeline(p: CosmoParams): CosmoTimeline {
  const samples: CosmoSample[] = [];
  let a = 1e-4;
  let t = 0;
  let sign: 1 | -1 = 1;
  let aMax = a;
  let ageNowGyr = 13.8;
  let foundNow = false;
  let crunchGyr = Number.POSITIVE_INFINITY;

  const nSteps = 9000;
  const aTargetEnd = 400;
  const tMax = 160;

  for (let i = 0; i < nSteps; i++) {
    samples.push({ tGyr: t, a, sign });
    if (a > aMax) {
      aMax = a;
    }
    if (!foundNow && a >= 1) {
      ageNowGyr = t;
      foundNow = true;
    }

    const e = hubbleE(a, p);
    if (sign === 1 && a > 1.05 && e < 0.04) {
      sign = -1;
    }

    const deriv = dadt(a, sign, p);
    const dt = Math.min(0.05, Math.max(2e-4, 0.012 / Math.max(Math.abs(deriv), 1e-6)));
    let nextA = a + deriv * dt;
    if (sign === -1 && nextA > a) {
      nextA = a - Math.abs(deriv) * dt;
    }
    if (nextA < 1e-6) {
      nextA = 1e-6;
    }
    t += dt;
    a = nextA;

    if (sign === -1 && a < 8e-4 && t > ageNowGyr) {
      crunchGyr = t;
      samples.push({ tGyr: t, a: Math.max(a, 1e-6), sign });
      break;
    }
    if (t > tMax || a > aTargetEnd) {
      break;
    }
  }

  if (!foundNow) {
    ageNowGyr = samples[samples.length - 1]?.tGyr ?? 13.8;
  }

  return { params: p, samples, ageNowGyr, crunchGyr, aMax };
}

const cache = new Map<CosmoScenario, CosmoTimeline>();

export function timelineFor(scenario: CosmoScenario): CosmoTimeline {
  let tl = cache.get(scenario);
  if (!tl) {
    tl = integrateTimeline(paramsFor(scenario));
    cache.set(scenario, tl);
  }
  return tl;
}

export function scaleFactorAt(timeline: CosmoTimeline, yearsFromNow: number): number {
  const tAbs = timeline.ageNowGyr + yearsFromNow / 1e9;
  const s = timeline.samples;
  if (s.length === 0) {
    return 1;
  }
  if (tAbs <= s[0].tGyr) {
    return s[0].a;
  }
  if (tAbs >= s[s.length - 1].tGyr) {
    return s[s.length - 1].a;
  }
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].tGyr <= tAbs) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const a = s[lo];
  const b = s[hi];
  const u = (tAbs - a.tGyr) / Math.max(b.tGyr - a.tGyr, 1e-12);
  return a.a + (b.a - a.a) * u;
}

export function hubbleAtScale(a: number, p: CosmoParams): number {
  return p.H0 * hubbleE(a, p);
}

export interface CosmoState {
  readonly yearsFromNow: number;
  readonly a: number;
  readonly H: number;
  readonly ageGyr: number;
  readonly expanding: boolean;
  readonly crunchGyr: number;
  readonly yearsToCrunch: number | null;
  readonly recollapsed: boolean;
}

export function stateAt(scenario: CosmoScenario, yearsFromNow: number): CosmoState {
  const tl = timelineFor(scenario);
  const a = scaleFactorAt(tl, yearsFromNow);
  const ageGyr = tl.ageNowGyr + yearsFromNow / 1e9;
  const H = hubbleAtScale(a, tl.params);
  const recollapsed = Number.isFinite(tl.crunchGyr) && ageGyr >= tl.crunchGyr - 0.05;
  const expanding = !recollapsed && a >= 0.02 && H > 0.05;
  const yearsToCrunch =
    Number.isFinite(tl.crunchGyr) && ageGyr < tl.crunchGyr
      ? (tl.crunchGyr - ageGyr) * 1e9
      : Number.isFinite(tl.crunchGyr)
        ? 0
        : null;
  return {
    yearsFromNow,
    a,
    H,
    ageGyr,
    expanding: expanding && yearsToCrunch !== 0,
    crunchGyr: tl.crunchGyr,
    yearsToCrunch,
    recollapsed
  };
}

/** Proper distance at time t from present proper distance d0 (same units). */
export function properDistance(d0: number, a: number): number {
  return d0 * a;
}
