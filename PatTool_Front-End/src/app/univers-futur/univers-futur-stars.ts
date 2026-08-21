/** Bright-star space motions (Hipparcos / SIMBAD). pmRA is μ_α cos δ in mas/yr. */

export interface FutureStar {
  readonly id: string;
  readonly name: string;
  readonly raHours: number;
  readonly decDeg: number;
  readonly distLy: number;
  readonly mag: number;
  readonly pmRaMasYr: number;
  readonly pmDecMasYr: number;
  readonly rvKmS: number;
  readonly color: string;
  readonly constellation: string;
}

export const FUTURE_STARS: readonly FutureStar[] = [
  { id: 'sirius', name: 'Sirius', raHours: 6.7525, decDeg: -16.7161, distLy: 8.6, mag: -1.46, pmRaMasYr: -546.01, pmDecMasYr: -1223.07, rvKmS: -5.5, color: '#a8cfff', constellation: 'CMa' },
  { id: 'canopus', name: 'Canopus', raHours: 6.3992, decDeg: -52.6957, distLy: 310, mag: -0.74, pmRaMasYr: 19.93, pmDecMasYr: 23.24, rvKmS: 20.3, color: '#ffe9b0', constellation: 'Car' },
  { id: 'rigil-kentaurus', name: 'α Cen', raHours: 14.6601, decDeg: -60.8356, distLy: 4.37, mag: -0.27, pmRaMasYr: -3679.25, pmDecMasYr: 473.67, rvKmS: -21.4, color: '#ffe4b5', constellation: 'Cen' },
  { id: 'arcturus', name: 'Arcturus', raHours: 14.2610, decDeg: 19.1824, distLy: 36.7, mag: -0.05, pmRaMasYr: -1093.39, pmDecMasYr: -2000.06, rvKmS: -5.2, color: '#ffb347', constellation: 'Boo' },
  { id: 'vega', name: 'Vega', raHours: 18.6156, decDeg: 38.7837, distLy: 25.0, mag: 0.03, pmRaMasYr: 200.94, pmDecMasYr: 286.23, rvKmS: -13.9, color: '#cfe8ff', constellation: 'Lyr' },
  { id: 'capella', name: 'Capella', raHours: 5.2782, decDeg: 45.9980, distLy: 42.9, mag: 0.08, pmRaMasYr: 75.52, pmDecMasYr: -427.13, rvKmS: 30.2, color: '#ffe4a8', constellation: 'Aur' },
  { id: 'rigel', name: 'Rigel', raHours: 5.2423, decDeg: -8.2016, distLy: 860, mag: 0.13, pmRaMasYr: 1.31, pmDecMasYr: 0.50, rvKmS: 17.8, color: '#a8d4ff', constellation: 'Ori' },
  { id: 'procyon', name: 'Procyon', raHours: 7.6550, decDeg: 5.2250, distLy: 11.5, mag: 0.34, pmRaMasYr: -714.59, pmDecMasYr: -1036.80, rvKmS: -3.2, color: '#fff0c8', constellation: 'CMi' },
  { id: 'achernar', name: 'Achernar', raHours: 1.6286, decDeg: -57.2368, distLy: 139, mag: 0.46, pmRaMasYr: 87.00, pmDecMasYr: -38.24, rvKmS: 16, color: '#b0d8ff', constellation: 'Eri' },
  { id: 'betelgeuse', name: 'Betelgeuse', raHours: 5.9195, decDeg: 7.4071, distLy: 640, mag: 0.50, pmRaMasYr: 27.54, pmDecMasYr: 11.30, rvKmS: 21.9, color: '#ff7a4a', constellation: 'Ori' },
  { id: 'hadar', name: 'Hadar', raHours: 14.0637, decDeg: -60.3730, distLy: 390, mag: 0.61, pmRaMasYr: -33.27, pmDecMasYr: -23.16, rvKmS: 5.9, color: '#a8c8ff', constellation: 'Cen' },
  { id: 'altair', name: 'Altair', raHours: 19.8464, decDeg: 8.8683, distLy: 16.7, mag: 0.76, pmRaMasYr: 536.23, pmDecMasYr: 385.29, rvKmS: -26.1, color: '#fff5d6', constellation: 'Aql' },
  { id: 'acrux', name: 'Acrux', raHours: 12.4433, decDeg: -63.0991, distLy: 320, mag: 0.77, pmRaMasYr: -35.83, pmDecMasYr: -14.86, rvKmS: -11.2, color: '#a8c8ff', constellation: 'Cru' },
  { id: 'aldebaran', name: 'Aldebaran', raHours: 4.5987, decDeg: 16.5093, distLy: 65.3, mag: 0.86, pmRaMasYr: 63.22, pmDecMasYr: -188.94, rvKmS: 54.3, color: '#ff9a4a', constellation: 'Tau' },
  { id: 'antares', name: 'Antares', raHours: 16.4901, decDeg: -26.4320, distLy: 550, mag: 0.96, pmRaMasYr: -12.11, pmDecMasYr: -23.30, rvKmS: -3.4, color: '#ff6b4a', constellation: 'Sco' },
  { id: 'spica', name: 'Spica', raHours: 13.4199, decDeg: -11.1613, distLy: 250, mag: 0.97, pmRaMasYr: -42.35, pmDecMasYr: -30.67, rvKmS: 1.0, color: '#b0c8ff', constellation: 'Vir' },
  { id: 'pollux', name: 'Pollux', raHours: 7.7553, decDeg: 28.0262, distLy: 33.8, mag: 1.14, pmRaMasYr: -626.55, pmDecMasYr: -45.95, rvKmS: 3.23, color: '#ffb86b', constellation: 'Gem' },
  { id: 'fomalhaut', name: 'Fomalhaut', raHours: 22.9608, decDeg: -29.6222, distLy: 25.1, mag: 1.16, pmRaMasYr: 328.95, pmDecMasYr: -164.67, rvKmS: 6.5, color: '#fff8e0', constellation: 'PsA' },
  { id: 'deneb', name: 'Deneb', raHours: 20.6905, decDeg: 45.2803, distLy: 2600, mag: 1.25, pmRaMasYr: 1.56, pmDecMasYr: 1.55, rvKmS: -4.9, color: '#cfe0ff', constellation: 'Cyg' },
  { id: 'mimosa', name: 'Mimosa', raHours: 12.7954, decDeg: -59.6888, distLy: 280, mag: 1.25, pmRaMasYr: -48.24, pmDecMasYr: -12.82, rvKmS: 15.6, color: '#a8c8ff', constellation: 'Cru' },
  { id: 'regulus', name: 'Regulus', raHours: 10.1395, decDeg: 11.9672, distLy: 79.3, mag: 1.35, pmRaMasYr: -248.73, pmDecMasYr: 5.59, rvKmS: 5.9, color: '#c8dcff', constellation: 'Leo' },
  { id: 'adhara', name: 'Adhara', raHours: 6.9770, decDeg: -28.9721, distLy: 430, mag: 1.50, pmRaMasYr: 2.65, pmDecMasYr: 2.27, rvKmS: 27.3, color: '#a8d0ff', constellation: 'CMa' },
  { id: 'castor', name: 'Castor', raHours: 7.5766, decDeg: 31.8883, distLy: 51, mag: 1.58, pmRaMasYr: -191.45, pmDecMasYr: -145.19, rvKmS: 5.4, color: '#dce8ff', constellation: 'Gem' },
  { id: 'gacrux', name: 'Gacrux', raHours: 12.5194, decDeg: -57.1132, distLy: 88, mag: 1.63, pmRaMasYr: 28.23, pmDecMasYr: -265.08, rvKmS: 20.6, color: '#ff8a6b', constellation: 'Cru' },
  { id: 'shaula', name: 'Shaula', raHours: 17.5601, decDeg: -37.1038, distLy: 570, mag: 1.63, pmRaMasYr: -8.90, pmDecMasYr: -29.95, rvKmS: -3.0, color: '#b0d0ff', constellation: 'Sco' },
  { id: 'bellatrix', name: 'Bellatrix', raHours: 5.4189, decDeg: 6.3497, distLy: 250, mag: 1.64, pmRaMasYr: -8.11, pmDecMasYr: -12.88, rvKmS: 18.2, color: '#a8c8ff', constellation: 'Ori' },
  { id: 'elnath', name: 'Elnath', raHours: 5.4382, decDeg: 28.6075, distLy: 134, mag: 1.65, pmRaMasYr: 22.76, pmDecMasYr: -173.58, rvKmS: 9.2, color: '#c8dcff', constellation: 'Tau' },
  { id: 'alnilam', name: 'Alnilam', raHours: 5.6036, decDeg: -1.2019, distLy: 2000, mag: 1.69, pmRaMasYr: 1.49, pmDecMasYr: -1.06, rvKmS: 27.3, color: '#a8c8ff', constellation: 'Ori' },
  { id: 'alnitak', name: 'Alnitak', raHours: 5.6793, decDeg: -1.9426, distLy: 1260, mag: 1.74, pmRaMasYr: 3.19, pmDecMasYr: 2.03, rvKmS: 18.5, color: '#a8c8ff', constellation: 'Ori' },
  { id: 'alioth', name: 'Alioth', raHours: 12.9004, decDeg: 55.9598, distLy: 81, mag: 1.77, pmRaMasYr: 111.91, pmDecMasYr: -8.24, rvKmS: -9.3, color: '#cfe0ff', constellation: 'UMa' },
  { id: 'dubhe', name: 'Dubhe', raHours: 11.0621, decDeg: 61.7510, distLy: 123, mag: 1.79, pmRaMasYr: -134.11, pmDecMasYr: -34.70, rvKmS: -9.4, color: '#ffb86b', constellation: 'UMa' },
  { id: 'polaris', name: 'Polaris', raHours: 2.5303, decDeg: 89.2641, distLy: 433, mag: 1.98, pmRaMasYr: 44.48, pmDecMasYr: -11.85, rvKmS: -17, color: '#ffe9c0', constellation: 'UMi' },
  { id: 'mizar', name: 'Mizar', raHours: 13.3987, decDeg: 54.9254, distLy: 83, mag: 2.23, pmRaMasYr: 119.01, pmDecMasYr: -25.97, rvKmS: -6.3, color: '#cfe0ff', constellation: 'UMa' },
  { id: 'alkaid', name: 'Alkaid', raHours: 13.7923, decDeg: 49.3133, distLy: 104, mag: 1.86, pmRaMasYr: -121.17, pmDecMasYr: -14.91, rvKmS: -13.4, color: '#a8c8ff', constellation: 'UMa' },
  { id: 'merak', name: 'Merak', raHours: 11.0307, decDeg: 56.3824, distLy: 80, mag: 2.37, pmRaMasYr: 81.43, pmDecMasYr: 33.43, rvKmS: -12.0, color: '#cfe0ff', constellation: 'UMa' },
  { id: 'phecda', name: 'Phecda', raHours: 11.8972, decDeg: 53.6948, distLy: 84, mag: 2.44, pmRaMasYr: 107.50, pmDecMasYr: 11.16, rvKmS: -12.6, color: '#cfe0ff', constellation: 'UMa' },
  { id: 'megrez', name: 'Megrez', raHours: 12.2571, decDeg: 57.0326, distLy: 81, mag: 3.31, pmRaMasYr: 103.56, pmDecMasYr: 7.86, rvKmS: -13.5, color: '#cfe0ff', constellation: 'UMa' },
  { id: 'mintaka', name: 'Mintaka', raHours: 5.5334, decDeg: -0.2991, distLy: 1200, mag: 2.23, pmRaMasYr: 0.64, pmDecMasYr: -0.69, rvKmS: 18.5, color: '#a8c8ff', constellation: 'Ori' },
  { id: 'saiph', name: 'Saiph', raHours: 5.7959, decDeg: -9.6696, distLy: 650, mag: 2.06, pmRaMasYr: 1.51, pmDecMasYr: -1.20, rvKmS: 20.5, color: '#a8c8ff', constellation: 'Ori' },
  { id: 'denebola', name: 'Denebola', raHours: 11.8177, decDeg: 14.5721, distLy: 36, mag: 2.14, pmRaMasYr: -497.68, pmDecMasYr: -114.67, rvKmS: -0.2, color: '#fff8e0', constellation: 'Leo' },
  { id: 'alpheratz', name: 'Alpheratz', raHours: 0.1398, decDeg: 29.0904, distLy: 97, mag: 2.06, pmRaMasYr: 135.68, pmDecMasYr: -162.95, rvKmS: -11.7, color: '#c8dcff', constellation: 'And' },
  { id: 'schedar', name: 'Schedar', raHours: 0.6751, decDeg: 56.5373, distLy: 228, mag: 2.23, pmRaMasYr: 50.36, pmDecMasYr: -32.17, rvKmS: -4.3, color: '#ffb86b', constellation: 'Cas' },
  { id: 'caph', name: 'Caph', raHours: 0.1528, decDeg: 59.1498, distLy: 54, mag: 2.27, pmRaMasYr: 523.39, pmDecMasYr: -179.84, rvKmS: 11.3, color: '#fff0d8', constellation: 'Cas' },
  { id: 'mirach', name: 'Mirach', raHours: 1.1622, decDeg: 35.6206, distLy: 197, mag: 2.06, pmRaMasYr: 175.90, pmDecMasYr: -112.20, rvKmS: 0.3, color: '#ff8a6b', constellation: 'And' },
  { id: 'almach', name: 'Almach', raHours: 2.0640, decDeg: 42.3297, distLy: 350, mag: 2.10, pmRaMasYr: 43.08, pmDecMasYr: -50.85, rvKmS: -11.7, color: '#ffb86b', constellation: 'And' },
  { id: 'markab', name: 'Markab', raHours: 23.0793, decDeg: 15.2053, distLy: 133, mag: 2.49, pmRaMasYr: 60.40, pmDecMasYr: -41.30, rvKmS: -2.2, color: '#c8dcff', constellation: 'Peg' },
  { id: 'scheat', name: 'Scheat', raHours: 23.0629, decDeg: 28.0828, distLy: 196, mag: 2.42, pmRaMasYr: 187.65, pmDecMasYr: 137.46, rvKmS: 8.7, color: '#ff8a6b', constellation: 'Peg' },
  { id: 'enif', name: 'Enif', raHours: 21.7364, decDeg: 9.8750, distLy: 690, mag: 2.39, pmRaMasYr: 30.02, pmDecMasYr: 1.24, rvKmS: 3.4, color: '#ff9a4a', constellation: 'Peg' },
  { id: 'kochab', name: 'Kochab', raHours: 14.8451, decDeg: 74.1555, distLy: 131, mag: 2.08, pmRaMasYr: -32.29, pmDecMasYr: 11.91, rvKmS: 16.8, color: '#ffb86b', constellation: 'UMi' },
  { id: 'navi', name: 'Navi', raHours: 0.9451, decDeg: 60.7167, distLy: 550, mag: 2.47, pmRaMasYr: 25.17, pmDecMasYr: -3.92, rvKmS: -7.0, color: '#c8dcff', constellation: 'Cas' },
  { id: 'rasalhague', name: 'Rasalhague', raHours: 17.5822, decDeg: 12.5600, distLy: 49, mag: 2.08, pmRaMasYr: 108.07, pmDecMasYr: -221.57, rvKmS: 11.7, color: '#fff0d8', constellation: 'Oph' },
  { id: 'hamal', name: 'Hamal', raHours: 2.1195, decDeg: 23.4624, distLy: 66, mag: 2.00, pmRaMasYr: 188.55, pmDecMasYr: -148.08, rvKmS: 14.2, color: '#ffb86b', constellation: 'Ari' },
  { id: 'etamin', name: 'Eltanin', raHours: 17.9434, decDeg: 51.4889, distLy: 154, mag: 2.23, pmRaMasYr: -8.48, pmDecMasYr: -22.79, rvKmS: -28.0, color: '#ffb86b', constellation: 'Dra' },
  { id: 'thuban', name: 'Thuban', raHours: 14.0732, decDeg: 64.3758, distLy: 303, mag: 3.67, pmRaMasYr: -56.34, pmDecMasYr: 17.21, rvKmS: -13.7, color: '#cfe0ff', constellation: 'Dra' },
  { id: 'albireo', name: 'Albireo', raHours: 19.5120, decDeg: 27.9597, distLy: 430, mag: 3.08, pmRaMasYr: -7.02, pmDecMasYr: -5.90, rvKmS: -24.0, color: '#ffb86b', constellation: 'Cyg' },
  { id: 'algieba', name: 'Algieba', raHours: 10.3329, decDeg: 19.8415, distLy: 130, mag: 2.08, pmRaMasYr: 304.30, pmDecMasYr: -154.28, rvKmS: -36.2, color: '#ffb86b', constellation: 'Leo' },
  { id: 'barnard', name: "Barnard's Star", raHours: 17.9637, decDeg: 4.6934, distLy: 5.96, mag: 9.54, pmRaMasYr: -801.55, pmDecMasYr: 10362.54, rvKmS: -110.5, color: '#ff8a5a', constellation: 'Oph' }
];

export interface SkyPoint {
  readonly raHours: number;
  readonly decDeg: number;
  readonly distLy: number;
}

const DEG2RAD = Math.PI / 180;
const KM_S_TO_LY_YR = 1 / 299792.458;
const PC_PER_LY = 1 / 3.261563777;
/** Tangential speed (km/s) = 4.74 × μ("/yr) × d(pc). */
const VT_FACTOR = 4.74047;

function equatorialXyz(raHours: number, decDeg: number, distLy: number): [number, number, number] {
  const ra = raHours * 15 * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const cdec = Math.cos(dec);
  return [distLy * cdec * Math.cos(ra), distLy * cdec * Math.sin(ra), distLy * Math.sin(dec)];
}

/**
 * True 3D position after `years` (no light delay). Linear space motion;
 * realistic for ≲ 10⁵ yr; galactic orbit dominates far beyond that.
 */
export function starPositionAt(star: FutureStar, years: number): SkyPoint {
  const [x0, y0, z0] = equatorialXyz(star.raHours, star.decDeg, star.distLy);
  const ra = star.raHours * 15 * DEG2RAD;
  const dec = star.decDeg * DEG2RAD;
  const dPc = Math.max(star.distLy * PC_PER_LY, 0.1);
  const vRa = VT_FACTOR * (star.pmRaMasYr / 1000) * dPc;
  const vDec = VT_FACTOR * (star.pmDecMasYr / 1000) * dPc;
  const vr = star.rvKmS;
  const cdec = Math.cos(dec);
  const sdec = Math.sin(dec);
  const cra = Math.cos(ra);
  const sra = Math.sin(ra);
  const vx = vr * cdec * cra - vRa * sra - vDec * sdec * cra;
  const vy = vr * cdec * sra + vRa * cra - vDec * sdec * sra;
  const vz = vr * sdec + vDec * cdec;
  const k = years * KM_S_TO_LY_YR;
  const x = x0 + vx * k;
  const y = y0 + vy * k;
  const z = z0 + vz * k;
  const dist = Math.sqrt(x * x + y * y + z * z);
  const ra2 = Math.atan2(y, x);
  const dec2 = Math.asin(Math.max(-1, Math.min(1, z / Math.max(dist, 1e-9))));
  let raHours = ra2 / DEG2RAD / 15;
  if (raHours < 0) {
    raHours += 24;
  }
  return { raHours, decDeg: dec2 / DEG2RAD, distLy: dist };
}

export function nearestStar(raHours: number, decDeg: number, maxDeg = 0.18): FutureStar | undefined {
  const ra = raHours * 15 * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  let best: FutureStar | undefined;
  let bestD = maxDeg * DEG2RAD;
  for (const s of FUTURE_STARS) {
    const ra2 = s.raHours * 15 * DEG2RAD;
    let dRa = ra2 - ra;
    while (dRa > Math.PI) {
      dRa -= 2 * Math.PI;
    }
    while (dRa < -Math.PI) {
      dRa += 2 * Math.PI;
    }
    const dDec = s.decDeg * DEG2RAD - dec;
    const ang = Math.sqrt((dRa * Math.cos(dec)) ** 2 + dDec ** 2);
    if (ang < bestD) {
      bestD = ang;
      best = s;
    }
  }
  return best;
}

export function figurePointAt(raHours: number, decDeg: number, years: number): SkyPoint {
  const star = nearestStar(raHours, decDeg);
  if (!star) {
    return { raHours, decDeg, distLy: 100 };
  }
  return starPositionAt(star, years);
}
