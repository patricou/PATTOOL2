/**
 * Vue « horloge de lumière » de la page Espace-temps : une horloge immobile et la même en mouvement,
 * vues depuis le quai, puis le partage de la vitesse entre l'espace et le temps.
 * Unités : c = 1 et écart entre les miroirs = 1, donc un tic (aller-retour) dure 2 pour l'horloge immobile.
 */
import { movingClockRate } from './espace-temps-physics';

export const LIGHT_CLOCK_SPEED_MAX = 0.98;

/** Durée (temps du quai) du trajet de lumière gardé à l'écran derrière l'horloge en mouvement. */
const TRAIL_TIME = 14;
/** Longueur de la piste, en écarts de miroirs : assez pour voir une montée complète à la vitesse maximale. */
const TRACK_LENGTHS = 7;
const ROW_EXTRA = 52;

export interface LightClockState {
  /** Vitesse de l'horloge en mouvement, en fraction de c. */
  speed: number;
  /** Temps écoulé sur le quai. */
  time: number;
}

export interface LightClockLabels {
  still: string;
  moving: string;
  ticks: string;
  dialSpace: string;
  dialTime: string;
}

export function lightClockTicks(time: number, speed: number): { still: number; moving: number } {
  return { still: Math.floor(time / 2), moving: Math.floor((time * movingClockRate(speed)) / 2) };
}

/** Hauteur de l'éclat entre les miroirs (0 en bas, 1 en haut) après un trajet vertical cumulé `path`. */
function bounce(path: number): number {
  const p = path % 2;
  return p < 1 ? p : 2 - p;
}

export function drawLightClockView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: LightClockState,
  labels: LightClockLabels
): void {
  const v = Math.min(LIGHT_CLOCK_SPEED_MAX, Math.max(0, state.speed));
  const rate = movingClockRate(v);
  const ticks = lightClockTicks(state.time, v);

  const trackX = 28;
  const trackW = w - 2 * trackX;
  const gap = Math.max(24, Math.min(h * 0.29 - ROW_EXTRA, trackW / TRACK_LENGTHS));
  const rowH = gap + ROW_EXTRA;
  const halfW = Math.max(10, gap * 0.28);
  const startX = trackX + halfW + 6;

  const drawClock = (x: number, yTop: number, mirrorHalf: number, height: number): void => {
    const yBot = yTop + gap;
    ctx.strokeStyle = 'rgba(159, 180, 216, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - mirrorHalf, yTop);
    ctx.lineTo(x - mirrorHalf, yBot);
    ctx.moveTo(x + mirrorHalf, yTop);
    ctx.lineTo(x + mirrorHalf, yBot);
    ctx.stroke();
    ctx.strokeStyle = '#9fb4d8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - mirrorHalf, yTop);
    ctx.lineTo(x + mirrorHalf, yTop);
    ctx.moveTo(x - mirrorHalf, yBot);
    ctx.lineTo(x + mirrorHalf, yBot);
    ctx.stroke();
    const y = yBot - height * gap;
    ctx.fillStyle = 'rgba(255, 232, 160, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff6d6';
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  };
  const rowLabel = (text: string, count: number, top: number): void => {
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f2f6ff';
    ctx.fillText(`${text} : ${count} ${labels.ticks}`, trackX, top + 20);
  };

  /* Horloge immobile. */
  const stillTop = 34;
  rowLabel(labels.still, ticks.still, 0);
  ctx.strokeStyle = 'rgba(255, 232, 160, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(startX, stillTop);
  ctx.lineTo(startX, stillTop + gap);
  ctx.stroke();
  drawClock(startX, stillTop, halfW, bounce(state.time));

  /* Horloge en mouvement : elle traverse la piste, puis repart du bord gauche. */
  const movingTop = rowH + 34;
  const movingBot = movingTop + gap;
  rowLabel(labels.moving, ticks.moving, rowH);
  const trackUnits = (trackW - 2 * (halfW + 6)) / gap;
  ctx.strokeStyle = 'rgba(200, 214, 236, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(trackX, movingBot + 9);
  ctx.lineTo(trackX + trackW, movingBot + 9);
  for (let x = startX; x <= trackX + trackW; x += gap) {
    ctx.moveTo(x, movingBot + 9);
    ctx.lineTo(x, movingBot + 14);
  }
  ctx.stroke();

  const moves = v >= 0.002;
  const pass = moves ? Math.floor((v * state.time) / trackUnits) : 0;
  const xAt = (t: number): number => (moves ? startX + (v * t - pass * trackUnits) * gap : startX);
  const yAt = (t: number): number => movingBot - bounce(rate * t) * gap;
  const from = moves ? Math.max((pass * trackUnits) / v, state.time - TRAIL_TIME) : Math.max(0, state.time - TRAIL_TIME);
  ctx.strokeStyle = 'rgba(255, 232, 160, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(xAt(from), yAt(from));
  /* Le trajet est fait de segments droits : un sommet à chaque rebond sur un miroir. */
  for (let n = Math.floor(rate * from) + 1; n / rate < state.time; n++) {
    ctx.lineTo(xAt(n / rate), yAt(n / rate));
  }
  ctx.lineTo(xAt(state.time), yAt(state.time));
  ctx.stroke();
  /* Raccourcie dans le sens du mouvement (contraction des longueurs). */
  drawClock(xAt(state.time), movingTop, Math.max(3, halfW * rate), bounce(rate * state.time));

  /* Cadran : la flèche a toujours la même longueur. */
  const bandTop = 2 * rowH + 4;
  const radius = Math.min(h - bandTop - 62, w - 170, 210);
  if (radius < 40) {
    return;
  }
  const ox = (w - radius) / 2 + 10;
  const oy = h - 36;
  const tipX = ox + v * radius;
  const tipY = oy - rate * radius;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ox, oy - radius - 14);
  ctx.lineTo(ox, oy);
  ctx.lineTo(ox + radius + 14, oy);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(126, 200, 255, 0.4)';
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.arc(ox, oy, radius, -Math.PI / 2, 0);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(126, 240, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX, oy);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(ox, tipY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#7ef0ff';
  ctx.fillStyle = '#7ef0ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  const angle = Math.atan2(tipY - oy, tipX - ox);
  ctx.beginPath();
  ctx.moveTo(tipX + 6 * Math.cos(angle), tipY + 6 * Math.sin(angle));
  ctx.lineTo(tipX + 9 * Math.cos(angle + 2.5), tipY + 9 * Math.sin(angle + 2.5));
  ctx.lineTo(tipX + 9 * Math.cos(angle - 2.5), tipY + 9 * Math.sin(angle - 2.5));
  ctx.closePath();
  ctx.fill();

  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#e8f4ff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(v * 100)} %`, Math.max(tipX, ox + 14), oy + 14);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round(rate * 100)} %`, ox - 7, Math.min(tipY, oy - 8));
  ctx.fillStyle = '#c8d6ec';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(labels.dialSpace, ox + radius / 2, oy + 29);
  ctx.save();
  ctx.translate(ox - 48, oy - radius / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(labels.dialTime, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}
