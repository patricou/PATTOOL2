import {
  circularDiff,
  displayedCameraFovDeg,
  normalizeDeg,
  projectCelestialToScreen
} from '../direction/direction-attitude';

export interface ReliefPeak {
  name: string;
  lat: number;
  lon: number;
  eleM: number;
  azDeg: number;
  elDeg: number;
  distKm: number;
  visible: boolean;
}

export interface ReliefHorizon {
  lat: number;
  lon: number;
  observerAltM: number;
  radiusKm: number;
  stepDeg: number;
  zoom: number;
  horizonElDeg: number[];
  horizonDistM: number[];
  peaks: ReliefPeak[];
  demSource?: string;
  peakSource?: string;
}

export interface ScreenPt {
  x: number;
  y: number;
}

export function sampleHorizonEl(horizonElDeg: number[], azDeg: number, stepDeg: number): number {
  const n = horizonElDeg.length;
  if (n < 2 || !(stepDeg > 0)) {
    return 0;
  }
  const x = normalizeDeg(azDeg) / stepDeg;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const t = x - Math.floor(x);
  const a = horizonElDeg[i0] ?? 0;
  const b = horizonElDeg[i1] ?? a;
  return a * (1 - t) + b * t;
}

export function silhouetteScreenPoints(
  horizon: ReliefHorizon,
  camAz: number,
  camEl: number,
  hfov: number,
  vfov: number
): ScreenPt[] {
  const half = hfov * 0.55 + 2;
  const pts: ScreenPt[] = [];
  const step = Math.max(0.25, horizon.stepDeg);
  for (let d = -half; d <= half + 1e-6; d += step) {
    const az = normalizeDeg(camAz + d);
    const el = sampleHorizonEl(horizon.horizonElDeg, az, horizon.stepDeg);
    const p = projectCelestialToScreen(camAz, camEl, 0, az, el, hfov, vfov, 2.8, false);
    pts.push({ x: p.xPct, y: p.yPct });
  }
  return pts;
}

export function silhouetteFillPath(pts: ScreenPt[]): string {
  if (pts.length < 2) {
    return '';
  }
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i].x.toFixed(2)},${pts[i].y.toFixed(2)}`;
  }
  d += `L${pts[pts.length - 1].x.toFixed(2)},112 L${pts[0].x.toFixed(2)},112 Z`;
  return d;
}

export function silhouetteStrokePath(pts: ScreenPt[]): string {
  if (pts.length < 2) {
    return '';
  }
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    d += `L${pts[i].x.toFixed(2)},${pts[i].y.toFixed(2)}`;
  }
  return d;
}

export function panoramaPath(horizonElDeg: number[], minEl = -8, maxEl = 28): string {
  const n = horizonElDeg.length;
  if (n < 2) {
    return '';
  }
  const span = Math.max(4, maxEl - minEl);
  const y = (el: number) => 100 - ((Math.max(minEl, Math.min(maxEl, el)) - minEl) / span) * 100;
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = (i / n) * 100;
    const yy = y(horizonElDeg[i] ?? 0);
    d += i === 0 ? `M${x.toFixed(2)},${yy.toFixed(2)}` : `L${x.toFixed(2)},${yy.toFixed(2)}`;
  }
  d += 'L100,100 L0,100 Z';
  return d;
}

export interface PeakLabel {
  peak: ReliefPeak;
  xPct: number;
  yPct: number;
  inView: boolean;
}

export function projectVisiblePeaks(
  peaks: ReliefPeak[],
  camAz: number,
  camEl: number,
  hfov: number,
  vfov: number,
  maxLabels = 16
): PeakLabel[] {
  const vis = peaks.filter((p) => p.visible);
  const ranked = vis.slice().sort((a, b) => {
    const da = Math.abs(circularDiff(a.azDeg, camAz));
    const db = Math.abs(circularDiff(b.azDeg, camAz));
    const inA = da < hfov * 0.6 ? 1 : 0;
    const inB = db < hfov * 0.6 ? 1 : 0;
    if (inA !== inB) {
      return inB - inA;
    }
    return b.eleM - a.eleM || a.distKm - b.distKm;
  });
  const out: PeakLabel[] = [];
  for (const peak of ranked) {
    const p = projectCelestialToScreen(camAz, camEl, 0, peak.azDeg, peak.elDeg, hfov, vfov, 2.8, true);
    if (!p.inFront) {
      continue;
    }
    if (out.some((o) => Math.hypot(o.xPct - p.xPct, o.yPct - p.yPct) < 7)) {
      continue;
    }
    out.push({ peak, xPct: p.xPct, yPct: p.yPct, inView: p.inView });
    if (out.length >= maxLabels) {
      break;
    }
  }
  return out;
}

export function displayedFov(
  video: HTMLVideoElement | undefined,
  stage: HTMLElement | undefined
): { hfov: number; vfov: number } {
  return displayedCameraFovDeg(
    video?.videoWidth || 0,
    video?.videoHeight || 0,
    stage?.clientWidth || video?.clientWidth || 0,
    stage?.clientHeight || video?.clientHeight || 0
  );
}
