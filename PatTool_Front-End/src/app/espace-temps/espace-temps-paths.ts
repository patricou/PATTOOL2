/**
 * Vue « chemins droits » de la page Espace-temps : deux marcheurs qui avancent droit devant eux sur une
 * surface plate puis sur une sphère de la taille de la Terre, et deux pommes en chute libre.
 */

/** Distance de l'équateur au pôle (km) : c'est la longueur du trajet des marcheurs. */
export const PATH_QUARTER_KM = 10_000;
export const PATH_SEPARATION_MIN_KM = 500;
export const PATH_SEPARATION_MAX_KM = 3000;

const SPHERE_RADIUS_KM = PATH_QUARTER_KM / (Math.PI / 2);
/** Inclinaison de la sphère vers l'observateur (rad), pour voir à la fois l'équateur et le pôle. */
const TILT = 0.5;
/** Distance de départ des pommes au centre de la Terre, en rayons terrestres (très exagérée). */
const APPLE_START_RADII = 2.4;
/** Demi-angle entre les deux pommes, vu du centre de la Terre, pour l'écart maximal. */
const APPLE_HALF_ANGLE_MAX = 0.3;

const COLOR_A = '#7ef0ff';
const COLOR_B = '#ffd27a';
const COLOR_TEXT = '#c8d6ec';

export interface PathsState {
  /** Écart entre les deux marcheurs au départ (km). */
  separation: number;
  /** Avancement, de 0 (départ) à 1 (pôle atteint, pommes au sol). */
  progress: number;
}

export interface PathsLabels {
  flat: string;
  sphere: string;
  apples: string;
  /** Contient {{value}}. */
  gap: string;
  /** Contient {{value}}. */
  gapPercent: string;
  earthCentre: string;
}

/** Écart (km, le long de la surface) entre les marcheurs partis de l'équateur droit vers le nord. */
export function sphereGap(separationKm: number, progress: number): number {
  const lat = (Math.min(1, Math.max(0, progress)) * Math.PI) / 2;
  const dLon = separationKm / SPHERE_RADIUS_KM;
  const cosAngle = Math.sin(lat) ** 2 + Math.cos(lat) ** 2 * Math.cos(dLon);
  return Math.acos(Math.min(1, Math.max(-1, cosAngle))) * SPHERE_RADIUS_KM;
}

/** Distance des pommes au centre de la Terre, en rayons terrestres : chute accélérée jusqu'au sol. */
function appleRadius(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return APPLE_START_RADII - (APPLE_START_RADII - 1) * p * p;
}

/** Écart entre les pommes, en fraction de l'écart de départ : il diminue comme la distance au centre. */
export function appleGapFraction(progress: number): number {
  return appleRadius(progress) / APPLE_START_RADII;
}

/** Distance en km, milliers séparés par une espace insécable. */
export function formatKm(km: number): string {
  return `${String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0km`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Painter = (ctx: CanvasRenderingContext2D, area: Box, separation: number, progress: number, labels: PathsLabels) => void;

export function drawPathsView(ctx: CanvasRenderingContext2D, w: number, h: number, state: PathsState, labels: PathsLabels): void {
  const progress = Math.min(1, Math.max(0, state.progress));
  const wide = w >= 620;
  /* En disposition étroite, les deux dessins du haut sont limités par leur largeur : la hauteur profite aux pommes. */
  const topH = Math.round(h * 0.46);
  const boxes: Box[] = wide
    ? [0, 1, 2].map((i) => ({ x: (i * w) / 3, y: 0, w: w / 3, h }))
    : [
        { x: 0, y: 0, w: w / 2, h: topH },
        { x: w / 2, y: 0, w: w / 2, h: topH },
        { x: 0, y: topH, w, h: h - topH }
      ];
  const captions = [
    labels.gap.replace('{{value}}', formatKm(state.separation)),
    labels.gap.replace('{{value}}', formatKm(sphereGap(state.separation, progress))),
    labels.gapPercent.replace('{{value}}', String(Math.round(appleGapFraction(progress) * 100)))
  ];
  const titles = [labels.flat, labels.sphere, labels.apples];
  const painters: Painter[] = [drawFlat, drawSphere, drawApples];

  boxes.forEach((box, i) => {
    const area: Box = { x: box.x + 6, y: box.y + 26, w: box.w - 12, h: box.h - 52 };
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    painters[i](ctx, area, state.separation, progress, labels);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#f2f6ff';
    ctx.fillText(titles[i], box.x + box.w / 2, box.y + 17);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(captions[i], box.x + box.w / 2, box.y + box.h - 8);
  });

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (wide) {
    ctx.moveTo(w / 3, 0);
    ctx.lineTo(w / 3, h);
    ctx.moveTo((2 * w) / 3, 0);
    ctx.lineTo((2 * w) / 3, h);
  } else {
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, topH);
    ctx.moveTo(0, topH);
    ctx.lineTo(w, topH);
  }
  ctx.stroke();
  ctx.textAlign = 'left';
}

function walker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#05070f';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** Surface plate vue de dessus, à la même échelle verticale que le trajet sur la sphère. */
function drawFlat(ctx: CanvasRenderingContext2D, area: Box, separation: number, progress: number): void {
  const scale = (area.h - 16) / PATH_QUARTER_KM;
  const cx = area.x + area.w / 2;
  const startY = area.y + area.h - 8;
  const cell = 1000 * scale;

  ctx.strokeStyle = 'rgba(126, 200, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = cx - Math.ceil(area.w / 2 / cell) * cell; x <= area.x + area.w; x += cell) {
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
  }
  for (let y = startY; y >= area.y; y -= cell) {
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.w, y);
  }
  ctx.stroke();

  const half = (separation / 2) * scale;
  const nowY = startY - progress * PATH_QUARTER_KM * scale;
  const lanes: Array<[number, string]> = [
    [cx - half, COLOR_A],
    [cx + half, COLOR_B]
  ];
  for (const [x, color] of lanes) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, startY - PATH_QUARTER_KM * scale);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, nowY);
    ctx.stroke();
    walker(ctx, x, nowY, color);
  }
}

/** Sphère en projection orthographique, inclinée vers l'observateur. */
function drawSphere(ctx: CanvasRenderingContext2D, area: Box, separation: number, progress: number): void {
  const radius = Math.min(area.w / 2 - 8, area.h / 2 - 4);
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const project = (lon: number, lat: number): { x: number; y: number; front: boolean } => {
    const x = Math.cos(lat) * Math.sin(lon);
    const y = Math.sin(lat);
    const z = Math.cos(lat) * Math.cos(lon);
    return {
      x: cx + radius * x,
      y: cy - radius * (y * Math.cos(TILT) - z * Math.sin(TILT)),
      front: y * Math.sin(TILT) + z * Math.cos(TILT) >= 0
    };
  };
  /** Trace la partie visible d'une courbe donnée par ses points (longitude, latitude). */
  const trace = (points: Array<[number, number]>): void => {
    ctx.beginPath();
    let drawing = false;
    for (const [lon, lat] of points) {
      const p = project(lon, lat);
      if (!p.front) {
        drawing = false;
      } else if (drawing) {
        ctx.lineTo(p.x, p.y);
      } else {
        ctx.moveTo(p.x, p.y);
        drawing = true;
      }
    }
    ctx.stroke();
  };
  const range = (from: number, to: number, count: number): number[] =>
    Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
  const deg = Math.PI / 180;

  const shade = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.35, radius * 0.1, cx, cy, radius);
  shade.addColorStop(0, '#234a85');
  shade.addColorStop(1, '#0a1630');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(126, 200, 255, 0.22)';
  for (let lon = -180; lon < 180; lon += 30) {
    trace(range(-90, 90, 60).map((lat): [number, number] => [lon * deg, lat * deg]));
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    ctx.strokeStyle = lat === 0 ? 'rgba(126, 200, 255, 0.6)' : 'rgba(126, 200, 255, 0.22)';
    trace(range(-180, 180, 90).map((lon): [number, number] => [lon * deg, lat * deg]));
  }

  const halfLon = separation / SPHERE_RADIUS_KM / 2;
  const latNow = (progress * Math.PI) / 2;
  const meridians: Array<[number, string]> = [
    [-halfLon, COLOR_A],
    [halfLon, COLOR_B]
  ];
  for (const [lon, color] of meridians) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1.5;
    trace(range(0, Math.PI / 2, 30).map((lat): [number, number] => [lon, lat]));
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.5;
    trace(range(0, latNow, 30).map((lat): [number, number] => [lon, lat]));
  }
  const a = project(-halfLon, latNow);
  const b = project(halfLon, latNow);
  walker(ctx, a.x, a.y, COLOR_A);
  walker(ctx, b.x, b.y, COLOR_B);
}

/** Deux pommes lâchées côte à côte : chacune tombe droit vers le centre de la Terre. */
function drawApples(ctx: CanvasRenderingContext2D, area: Box, separation: number, progress: number, labels: PathsLabels): void {
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h * 0.93;
  const earth = area.h * 0.34;
  const halfAngle = (separation / PATH_SEPARATION_MAX_KM) * APPLE_HALF_ANGLE_MAX;
  const at = (side: number, radii: number): { x: number; y: number } => ({
    x: cx + side * radii * earth * Math.sin(halfAngle),
    y: cy - radii * earth * Math.cos(halfAngle)
  });

  const shade = ctx.createRadialGradient(cx - earth * 0.3, cy - earth * 0.5, earth * 0.1, cx, cy, earth);
  shade.addColorStop(0, '#3b82c4');
  shade.addColorStop(1, '#12305c');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(cx, cy, earth, 0, Math.PI * 2);
  ctx.fill();

  const now = appleRadius(progress);
  for (const side of [-1, 1]) {
    const start = at(side, APPLE_START_RADII);
    const here = at(side, now);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(here.x, here.y);
    ctx.stroke();
    walker(ctx, here.x, here.y, '#ff5252');
  }

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8f4ff';
  ctx.fillText(labels.earthCentre, cx + 7, cy - 1);
}
