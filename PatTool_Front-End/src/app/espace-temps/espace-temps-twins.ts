/**
 * Vue « jumeaux » de la page Espace-temps : schéma d'espace-temps (temps terrestre en abscisse,
 * distance en ordonnée) d'un aller-retour à vitesse constante. Unités : années et années-lumière, c = 1.
 */
import { movingClockRate } from './espace-temps-physics';

/** Durée de l'aller-retour, mesurée sur Terre (années). */
export const TWIN_TRIP_YEARS = 10;
export const TWIN_SPEED_MAX = 0.99;

const HALF_TRIP = TWIN_TRIP_YEARS / 2;
const DISTANCE_MAX = 5.5;
const DISTANCE_MIN = -0.45;

const COLOR_EARTH = '#c9a36a';
const COLOR_TRAVELLER = '#7ef0ff';
const COLOR_LIGHT = '#ffd27a';
const COLOR_TEXT = '#c8d6ec';

export interface TwinsState {
  /** Vitesse du voyageur, en fraction de c. */
  speed: number;
  /** Temps écoulé sur Terre depuis le départ (années). */
  time: number;
}

export interface TwinsLabels {
  earth: string;
  traveller: string;
  light: string;
  turnaround: string;
  axisTime: string;
  axisDistance: string;
}

/** Distance du voyageur à la Terre (années-lumière) au temps terrestre t. */
export function travellerDistance(speed: number, t: number): number {
  return speed * (t <= HALF_TRIP ? t : Math.max(0, TWIN_TRIP_YEARS - t));
}

/** Années vécues par le voyageur quand il s'en est écoulé t sur Terre. */
export function travellerAge(speed: number, t: number): number {
  return t * movingClockRate(speed);
}

export function drawTwinsView(ctx: CanvasRenderingContext2D, w: number, h: number, state: TwinsState, labels: TwinsLabels): void {
  const padL = 50;
  const padR = 14;
  const padT = 16;
  const padB = 40;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const v = Math.min(TWIN_SPEED_MAX, Math.max(0, state.speed));
  const rate = movingClockRate(v);
  const now = Math.min(TWIN_TRIP_YEARS, Math.max(0, state.time));
  const px = (t: number): number => padL + (t / TWIN_TRIP_YEARS) * plotW;
  const py = (d: number): number => padT + ((DISTANCE_MAX - d) / (DISTANCE_MAX - DISTANCE_MIN)) * plotH;
  const dot = (x: number, y: number, radius: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  /** Trajet du voyageur de 0 à tMax, coudé au demi-tour. */
  const traceTraveller = (tMax: number): void => {
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    if (tMax > HALF_TRIP) {
      ctx.lineTo(px(HALF_TRIP), py(travellerDistance(v, HALF_TRIP)));
    }
    ctx.lineTo(px(tMax), py(travellerDistance(v, tMax)));
    ctx.stroke();
  };

  /* Quadrillage : une ligne par année et par année-lumière. */
  ctx.font = '11px sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(126, 200, 255, 0.14)';
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let t = 0; t <= TWIN_TRIP_YEARS; t++) {
    ctx.beginPath();
    ctx.moveTo(px(t), padT);
    ctx.lineTo(px(t), padT + plotH);
    ctx.stroke();
    if (t % 2 === 0) {
      ctx.fillText(String(t), px(t), padT + plotH + 15);
    }
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let d = 0; d <= 5; d++) {
    ctx.beginPath();
    ctx.moveTo(padL, py(d));
    ctx.lineTo(padL + plotW, py(d));
    ctx.stroke();
    ctx.fillText(String(d), padL - 7, py(d));
  }

  /* La lumière : la pente que rien ne peut dépasser. */
  ctx.strokeStyle = 'rgba(255, 210, 122, 0.6)';
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  ctx.lineTo(px(HALF_TRIP), py(HALF_TRIP));
  ctx.lineTo(px(TWIN_TRIP_YEARS), py(0));
  ctx.stroke();
  ctx.setLineDash([]);

  /* Trajets complets, estompés, puis partie déjà parcourue. */
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(201, 163, 106, 0.35)';
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  ctx.lineTo(px(TWIN_TRIP_YEARS), py(0));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(126, 240, 255, 0.3)';
  traceTraveller(TWIN_TRIP_YEARS);

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = COLOR_EARTH;
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  ctx.lineTo(px(now), py(0));
  ctx.stroke();
  ctx.strokeStyle = COLOR_TRAVELLER;
  traceTraveller(now);

  if (v > 0.03) {
    ctx.fillStyle = COLOR_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    /* Assez haut pour laisser la place au numéro d'une année qui tomberait sur le demi-tour. */
    ctx.fillText(labels.turnaround, px(HALF_TRIP), py(travellerDistance(v, HALF_TRIP)) - 21);
  }

  /* Un point par année vécue : chaque jumeau compte les siennes. */
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let year = 1; year <= now + 1e-9; year++) {
    dot(px(year), py(0), 3.5, '#e3c595');
    ctx.fillText(String(year), px(year), py(0) + 15);
  }
  for (let year = 1; year / rate <= now + 1e-9; year++) {
    const t = year / rate;
    const x = px(t);
    const y = py(travellerDistance(v, t));
    dot(x, y, 3.5, '#c9faff');
    ctx.fillText(String(year), x, y - 8);
  }

  dot(px(now), py(0), 6, COLOR_EARTH);
  dot(px(now), py(travellerDistance(v, now)), 6, COLOR_TRAVELLER);

  /* Légende, dans le coin que la lumière elle-même ne peut pas atteindre. */
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const legendX = padL + 10;
  let legendY = padT + 12;
  for (const [text, color] of [
    [labels.earth, COLOR_EARTH],
    [labels.traveller, COLOR_TRAVELLER]
  ]) {
    dot(legendX + 5, legendY, 5, color);
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(text, legendX + 17, legendY);
    legendY += 17;
  }
  ctx.strokeStyle = COLOR_LIGHT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(legendX - 2, legendY);
  ctx.lineTo(legendX + 12, legendY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLOR_TEXT;
  ctx.fillText(labels.light, legendX + 17, legendY);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL + 0.5, padT);
  ctx.lineTo(padL + 0.5, padT + plotH + 0.5);
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();

  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(labels.axisTime, padL + plotW / 2, h - 8);
  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(labels.axisDistance, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}
