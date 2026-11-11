/**
 * Vue « horloges » de la page Espace-temps : astres proposés, correspondance curseur ↔ altitude,
 * mise en forme des valeurs et dessin (schéma à l'échelle + courbe de l'écart quotidien).
 */
import { DAY_S, LIGHT_SPEED_M_S, clockDrift, schwarzschildRadius } from './espace-temps-physics';

const GM_SUN = 1.32712440018e20;

export interface ClockPreset {
  /** Libellé court affiché sur la courbe. */
  short: string;
  labelKey: string;
  /** Altitude au-dessus de la surface (m). */
  altitude: number;
}

export interface ClockBody {
  id: string;
  labelKey: string;
  /** Paramètre gravitationnel GM (m³/s²). */
  gm: number;
  /** Rayon (m). */
  radius: number;
  color: string;
  presets: ReadonlyArray<ClockPreset>;
}

export const CLOCK_BODIES: ReadonlyArray<ClockBody> = [
  {
    id: 'earth',
    labelKey: 'ESPACE_TEMPS.BODY_EARTH',
    gm: 3.986004418e14,
    radius: 6.371e6,
    color: '#3b82c4',
    presets: [
      { short: 'ISS', labelKey: 'ESPACE_TEMPS.PRESET_ISS', altitude: 408_000 },
      { short: 'GPS', labelKey: 'ESPACE_TEMPS.PRESET_GPS', altitude: 20_200_000 },
      { short: 'GEO', labelKey: 'ESPACE_TEMPS.PRESET_GEO', altitude: 35_786_000 }
    ]
  },
  { id: 'sun', labelKey: 'ESPACE_TEMPS.BODY_SUN', gm: GM_SUN, radius: 6.957e8, color: '#fdb813', presets: [] },
  {
    id: 'white-dwarf',
    labelKey: 'ESPACE_TEMPS.BODY_WHITE_DWARF',
    gm: 1.018 * GM_SUN,
    radius: 5.85e6,
    color: '#dbe7ff',
    presets: []
  },
  {
    id: 'neutron-star',
    labelKey: 'ESPACE_TEMPS.BODY_NEUTRON_STAR',
    gm: 1.4 * GM_SUN,
    radius: 12_000,
    color: '#c4b5fd',
    presets: []
  }
];

/** Altitude maximale du curseur, en rayons de l'astre. */
const ALTITUDE_MAX_RADII = 10;
/** Le curseur est resserré vers les basses altitudes, où l'écart varie le plus vite. */
const SLIDER_POWER = 2.5;

export function sliderToAltitude(slider: number, body: ClockBody): number {
  const s = Math.min(1, Math.max(0, slider));
  return ALTITUDE_MAX_RADII * body.radius * Math.pow(s, SLIDER_POWER);
}

export function altitudeToSlider(altitude: number, body: ClockBody): number {
  const f = Math.min(1, Math.max(0, altitude / (ALTITUDE_MAX_RADII * body.radius)));
  return Math.pow(f, 1 / SLIDER_POWER);
}

const NBSP = '\u00a0';

function trimNumber(value: number, digits: number): string {
  return String(Number(value.toPrecision(digits)));
}

/** Unité adaptée à une durée (s) : ns, µs, ms, s, min, h, puis jours. */
export function durationUnit(absSeconds: number, dayUnit: string): { unit: string; seconds: number } {
  if (absSeconds < 1e-6) {
    return { unit: 'ns', seconds: 1e-9 };
  }
  if (absSeconds < 1e-3) {
    return { unit: 'µs', seconds: 1e-6 };
  }
  if (absSeconds < 1) {
    return { unit: 'ms', seconds: 1e-3 };
  }
  if (absSeconds < 60) {
    return { unit: 's', seconds: 1 };
  }
  if (absSeconds < 3600) {
    return { unit: 'min', seconds: 60 };
  }
  if (absSeconds < DAY_S) {
    return { unit: 'h', seconds: 3600 };
  }
  return { unit: dayUnit, seconds: DAY_S };
}

/** Durée sur 3 chiffres significatifs avec son unité ; signed ajoute « + » ou « − ». */
export function formatDuration(seconds: number, dayUnit: string, signed: boolean): string {
  const abs = Math.abs(seconds);
  if (abs < 1e-13) {
    return `0${NBSP}s`;
  }
  const { unit, seconds: size } = durationUnit(abs, dayUnit);
  const sign = !signed ? '' : seconds > 0 ? '+' : '−';
  return `${sign}${trimNumber(abs / size, 3)}${NBSP}${unit}`;
}

/** Distance en km (ou en m sous 1 km), milliers séparés par une espace. */
export function formatDistance(meters: number): string {
  const km = meters / 1000;
  if (km < 1) {
    return `${Math.round(meters)}${NBSP}m`;
  }
  if (km < 100) {
    return `${trimNumber(km, 3)}${NBSP}km`;
  }
  return `${String(Math.round(km)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}${NBSP}km`;
}

/** Vitesse en km/s, suivie de sa fraction de la vitesse de la lumière dès qu'elle dépasse 1 %. */
export function formatSpeed(metersPerSecond: number): string {
  const kmS = metersPerSecond / 1000;
  const text =
    kmS < 1000
      ? `${trimNumber(kmS, 3)}${NBSP}km/s`
      : `${String(Math.round(kmS)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}${NBSP}km/s`;
  const fraction = metersPerSecond / LIGHT_SPEED_M_S;
  return fraction >= 0.01 ? `${text} (${trimNumber(fraction, 2)}${NBSP}c)` : text;
}

export interface ClocksViewState {
  body: ClockBody;
  /** Position du curseur d'altitude, 0 à 1. */
  slider: number;
  orbiting: boolean;
  /** Angle du satellite sur le schéma (rad). */
  satAngle: number;
}

export interface ClocksViewLabels {
  ground: string;
  high: string;
  altitudeEffect: string;
  speedEffect: string;
  total: string;
  axisAltitude: string;
  /** Contient {{unit}}, remplacé par l'unité choisie pour l'axe. */
  axisDrift: string;
  captionGround: string;
  captionGap: string;
  dayUnit: string;
}

const COLOR_GROUND = '#c9a36a';
const COLOR_HIGH = '#7ec8ff';
const COLOR_ALTITUDE = '#7ec8ff';
const COLOR_SPEED = '#ff6b6b';
const COLOR_TOTAL = '#ffffff';
const COLOR_TEXT = '#c8d6ec';

export function drawClocksView(ctx: CanvasRenderingContext2D, w: number, h: number, state: ClocksViewState, labels: ClocksViewLabels): void {
  const wide = w >= 620 && w > h * 1.15;
  if (wide) {
    const sceneW = Math.round(w * 0.4);
    drawScene(ctx, 0, 0, sceneW, h, state, labels);
    drawGraph(ctx, sceneW, 0, w - sceneW, h, state, labels);
  } else {
    const sceneH = Math.round(h * 0.44);
    drawScene(ctx, 0, 0, w, sceneH, state, labels);
    drawGraph(ctx, 0, sceneH, w, h - sceneH, state, labels);
  }
}

/** Astre, horloge au sol et horloge en altitude, à l'échelle. */
function drawScene(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, state: ClocksViewState, labels: ClocksViewLabels): void {
  const captionH = 44;
  const cx = x + w / 2;
  const cy = y + (h - captionH) / 2 + 4;
  const radii = 1 + sliderToAltitude(state.slider, state.body) / state.body.radius;
  const avail = Math.max(30, Math.min(w, h - captionH) / 2 - 22);
  const bodyPx = avail / Math.max(radii * 1.12, 2.2);
  const highPx = bodyPx * radii;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (state.orbiting) {
    ctx.strokeStyle = 'rgba(126, 200, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, highPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const glow = ctx.createRadialGradient(cx - bodyPx * 0.3, cy - bodyPx * 0.3, bodyPx * 0.1, cx, cy, bodyPx);
  glow.addColorStop(0, '#ffffff');
  glow.addColorStop(0.25, state.body.color);
  glow.addColorStop(1, state.body.color);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, bodyPx, 0, Math.PI * 2);
  ctx.fill();

  const groundX = cx;
  const groundY = cy - bodyPx;
  const angle = state.orbiting ? state.satAngle : -Math.PI / 2;
  const highX = cx + highPx * Math.cos(angle);
  const highY = cy + highPx * Math.sin(angle);

  if (!state.orbiting) {
    ctx.strokeStyle = 'rgba(200, 214, 236, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(groundX, groundY);
    ctx.lineTo(highX, highY);
    ctx.stroke();
  }

  ctx.fillStyle = COLOR_GROUND;
  ctx.beginPath();
  ctx.arc(groundX, groundY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#05070f';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = COLOR_HIGH;
  ctx.beginPath();
  ctx.arc(highX, highY, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#e3c595';
  ctx.fillText(labels.ground, groundX - 10, groundY - 2);
  /* Libellé du côté extérieur de l'orbite, sauf s'il devait sortir du cadre. */
  const highW = ctx.measureText(labels.high).width;
  let highOnRight = highX >= cx;
  if (highOnRight && highX + 11 + highW > x + w - 4) {
    highOnRight = false;
  } else if (!highOnRight && highX - 11 - highW < x + 4) {
    highOnRight = true;
  }
  ctx.textAlign = highOnRight ? 'left' : 'right';
  ctx.fillStyle = '#a9dcff';
  ctx.fillText(labels.high, highX + (highOnRight ? 11 : -11), highY - 2);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText(labels.captionGround, cx, y + h - 26);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(labels.captionGap, cx, y + h - 8);
  ctx.restore();
  ctx.textAlign = 'left';
}

function niceStep(span: number, targetTicks: number): number {
  const raw = span / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Écart quotidien en fonction de l'altitude : effet de l'altitude, effet de la vitesse et total. */
function drawGraph(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, state: ClocksViewState, labels: ClocksViewLabels): void {
  const padL = 58;
  const padR = 16;
  const padT = 34;
  const padB = 42;
  const plotX = x + padL;
  const plotY = y + padT;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  if (plotW < 40 || plotH < 40) {
    return;
  }
  const body = state.body;
  const rs = schwarzschildRadius(body.gm);
  const n = 140;
  const altitudePart: number[] = [];
  const speedPart: number[] = [];
  const total: number[] = [];
  let min = 0;
  let max = 0;
  for (let i = 0; i <= n; i++) {
    const d = clockDrift(rs, body.radius, body.radius + sliderToAltitude(i / n, body), state.orbiting);
    altitudePart.push(d.altitude * DAY_S);
    speedPart.push(d.speed * DAY_S);
    total.push(d.total * DAY_S);
    min = Math.min(min, d.altitude * DAY_S, d.speed * DAY_S, d.total * DAY_S);
    max = Math.max(max, d.altitude * DAY_S, d.speed * DAY_S, d.total * DAY_S);
  }
  const span = max - min || 1;
  min -= span * 0.06;
  max += span * 0.08;
  const { unit, seconds: unitSize } = durationUnit(Math.max(Math.abs(min), Math.abs(max)), labels.dayUnit);
  const px = (s: number): number => plotX + s * plotW;
  const py = (v: number): number => plotY + ((max - v) / (max - min)) * plotH;

  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';

  /* Graduations verticales, dans l'unité de l'axe. */
  const step = niceStep((max - min) / unitSize, 5) * unitSize;
  ctx.textAlign = 'right';
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    const yy = py(v);
    const zero = Math.abs(v) < step * 1e-6;
    ctx.strokeStyle = zero ? 'rgba(255, 255, 255, 0.45)' : 'rgba(126, 200, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, yy);
    ctx.lineTo(plotX + plotW, yy);
    ctx.stroke();
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(zero ? '0' : trimNumber(v / unitSize, 3), plotX - 7, yy);
  }

  /* Graduations horizontales : altitudes rondes, espacées d'au moins 54 px. */
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const maxAltitude = sliderToAltitude(1, body);
  const candidates: number[] = [];
  for (let e = Math.floor(Math.log10(maxAltitude)); e >= Math.floor(Math.log10(maxAltitude)) - 3; e--) {
    for (const m of [5, 2, 1]) {
      const v = m * Math.pow(10, e);
      if (v >= 1000 && v <= maxAltitude) {
        candidates.push(v);
      }
    }
  }
  const placed: number[] = [plotX];
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText('0', plotX, plotY + plotH + 15);
  for (const altitude of candidates) {
    const xx = px(altitudeToSlider(altitude, body));
    if (placed.every((p) => Math.abs(p - xx) >= 54) && xx <= plotX + plotW - 12) {
      placed.push(xx);
      ctx.strokeStyle = 'rgba(126, 200, 255, 0.12)';
      ctx.beginPath();
      ctx.moveTo(xx, plotY);
      ctx.lineTo(xx, plotY + plotH);
      ctx.stroke();
      ctx.fillText(formatDistance(altitude).replace(/\u00a0km$/, ''), xx, plotY + plotH + 15);
    }
  }

  /* Repères ISS / GPS / géostationnaire. */
  for (const preset of body.presets) {
    const xx = px(altitudeToSlider(preset.altitude, body));
    ctx.strokeStyle = 'rgba(255, 210, 122, 0.4)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(xx, plotY + 12);
    ctx.lineTo(xx, plotY + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd27a';
    ctx.fillText(preset.short, xx, plotY + 9);
  }

  const trace = (values: number[], color: string, width: number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    values.forEach((v, i) => {
      if (i === 0) {
        ctx.moveTo(px(i / n), py(v));
      } else {
        ctx.lineTo(px(i / n), py(v));
      }
    });
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();
  trace(altitudePart, COLOR_ALTITUDE, state.orbiting ? 1.6 : 2.4);
  if (state.orbiting) {
    trace(speedPart, COLOR_SPEED, 1.6);
    trace(total, COLOR_TOTAL, 2.4);
  }
  ctx.restore();

  /* Altitude courante. */
  const here = clockDrift(rs, body.radius, body.radius + sliderToAltitude(state.slider, body), state.orbiting);
  const hereX = px(Math.min(1, Math.max(0, state.slider)));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hereX, plotY);
  ctx.lineTo(hereX, plotY + plotH);
  ctx.stroke();
  const mark = (value: number, color: string, radius: number): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hereX, py(value * DAY_S), radius, 0, Math.PI * 2);
    ctx.fill();
  };
  mark(here.altitude, COLOR_ALTITUDE, state.orbiting ? 3.5 : 5);
  if (state.orbiting) {
    mark(here.speed, COLOR_SPEED, 3.5);
    mark(here.total, COLOR_TOTAL, 5);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.beginPath();
  ctx.moveTo(plotX + 0.5, plotY);
  ctx.lineTo(plotX + 0.5, plotY + plotH + 0.5);
  ctx.lineTo(plotX + plotW, plotY + plotH + 0.5);
  ctx.stroke();

  /* Légende, au-dessus du tracé. */
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const entries: Array<[string, string]> = state.orbiting
    ? [[labels.altitudeEffect, COLOR_ALTITUDE], [labels.speedEffect, COLOR_SPEED], [labels.total, COLOR_TOTAL]]
    : [[labels.altitudeEffect, COLOR_ALTITUDE]];
  let legendX = x + 10;
  const legendY = y + 14;
  for (const [text, color] of entries) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 16, legendY);
    ctx.stroke();
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(text, legendX + 21, legendY);
    legendX += 21 + ctx.measureText(text).width + 16;
  }

  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(labels.axisAltitude, plotX + plotW / 2, y + h - 8);
  ctx.save();
  ctx.translate(x + 13, plotY + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(labels.axisDrift.replace('{{unit}}', unit), 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}
