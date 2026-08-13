/**
 * Déclinaison magnétique (WMM2020, degrés 1–4 + variation séculaire).
 * Suffisant pour convertir Nord magnétique → Nord vrai (~1°) hors pôles.
 *
 * D &gt; 0 : le Nord magnétique est à l’est du Nord géographique.
 * Cap vrai = cap magnétique + D.
 */

interface HarmonicTerm {
  readonly n: number;
  readonly m: number;
  readonly g: number;
  readonly h: number;
  readonly gSv: number;
  readonly hSv: number;
}

/** Coefficients WMM-2020 (nT / nT·an⁻¹), époque 2020.0. */
const WMM2020: readonly HarmonicTerm[] = [
  { n: 1, m: 0, g: -29404.5, h: 0.0, gSv: 6.7, hSv: 0.0 },
  { n: 1, m: 1, g: -1450.7, h: 4652.9, gSv: 7.7, hSv: -25.1 },
  { n: 2, m: 0, g: -2500.0, h: 0.0, gSv: -11.5, hSv: 0.0 },
  { n: 2, m: 1, g: 2982.0, h: -2991.6, gSv: -7.2, hSv: -30.2 },
  { n: 2, m: 2, g: 1676.8, h: -734.8, gSv: -2.1, hSv: -23.9 },
  { n: 3, m: 0, g: 1363.9, h: 0.0, gSv: 2.8, hSv: 0.0 },
  { n: 3, m: 1, g: -2381.0, h: -82.2, gSv: -6.2, hSv: 5.7 },
  { n: 3, m: 2, g: 1236.2, h: 241.8, gSv: 3.4, hSv: -1.0 },
  { n: 3, m: 3, g: 525.7, h: -542.9, gSv: -12.2, hSv: 1.1 },
  { n: 4, m: 0, g: 903.1, h: 0.0, gSv: -1.1, hSv: 0.0 },
  { n: 4, m: 1, g: 809.4, h: 282.0, gSv: -1.6, hSv: 0.2 },
  { n: 4, m: 2, g: 86.2, h: -158.4, gSv: -6.0, hSv: 6.9 },
  { n: 4, m: 3, g: -309.4, h: 199.8, gSv: 5.4, hSv: 3.7 },
  { n: 4, m: 4, g: 47.9, h: -350.1, gSv: -5.5, hSv: -5.6 }
];

const WMM_EPOCH = 2020.0;

export interface MagneticField {
  /** Déclinaison, degrés (est positif). */
  declinationDeg: number;
  /** Intensité horizontale, nT. */
  horizontalNt: number;
  /** Intensité totale, nT. */
  totalNt: number;
}

export function magneticFieldAt(
  latDeg: number,
  lonDeg: number,
  date: Date = new Date()
): MagneticField | null {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return null;
  }
  const lat = Math.max(-89.999, Math.min(89.999, latDeg));
  const lon = ((lonDeg + 540) % 360) - 180;
  const year =
    date.getUTCFullYear() +
    (date.getUTCMonth() + (date.getUTCDate() - 0.5) / 30.437) / 12;
  const dt = year - WMM_EPOCH;

  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const ct = sinLat;
  const st = Math.max(1e-8, cosLat);

  const p: number[][] = [];
  const dp: number[][] = [];
  for (let n = 0; n <= 4; n++) {
    p[n] = [];
    dp[n] = [];
    for (let m = 0; m <= n; m++) {
      p[n][m] = 0;
      dp[n][m] = 0;
    }
  }
  p[0][0] = 1;
  p[1][0] = ct;
  p[1][1] = st;
  dp[0][0] = 0;
  dp[1][0] = -st;
  dp[1][1] = ct;
  for (let n = 2; n <= 4; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        p[n][m] = st * p[n - 1][m - 1];
        dp[n][m] = st * dp[n - 1][m - 1] + ct * p[n - 1][m - 1];
      } else if (m === n - 1) {
        p[n][m] = ct * p[n - 1][m];
        dp[n][m] = ct * dp[n - 1][m] - st * p[n - 1][m];
      } else {
        const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        p[n][m] = ct * p[n - 1][m] - k * p[n - 2][m];
        dp[n][m] = ct * dp[n - 1][m] - st * p[n - 1][m] - k * dp[n - 2][m];
      }
    }
  }

  let bx = 0;
  let by = 0;
  let bz = 0;
  for (const term of WMM2020) {
    const g = term.g + term.gSv * dt;
    const h = term.h + term.hSv * dt;
    const { n, m } = term;
    const n1 = n + 1;
    const cosm = Math.cos(m * lonRad);
    const sinm = Math.sin(m * lonRad);
    const pn = p[n][m];
    const dpn = dp[n][m];
    bx += n1 * (g * cosm + h * sinm) * pn;
    by += m * (g * sinm - h * cosm) * pn;
    bz -= (g * cosm + h * sinm) * dpn;
  }

  const x = -bz;
  const y = by / st;
  const z = -bx;
  const horizontal = Math.hypot(x, y);
  if (horizontal < 1e-6) {
    return null;
  }
  let decl = (Math.atan2(y, x) * 180) / Math.PI;
  if (decl > 180) {
    decl -= 360;
  }
  if (decl <= -180) {
    decl += 360;
  }
  return {
    declinationDeg: decl,
    horizontalNt: horizontal,
    totalNt: Math.hypot(x, y, z)
  };
}

export function magneticDeclinationDeg(
  latDeg: number,
  lonDeg: number,
  date: Date = new Date()
): number | null {
  return magneticFieldAt(latDeg, lonDeg, date)?.declinationDeg ?? null;
}
