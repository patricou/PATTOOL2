/**
 * Vue « lumière et trou noir » de la page Espace-temps : rayons lumineux déviés par une masse,
 * vus de dessus. Unités de scène, comme la vue « grille ».
 */
import { LightRay, traceLightRay } from './espace-temps-physics';

export const LIGHT_STAR_RADIUS = 6;
export const LIGHT_RS_MAX = 12;
/** Compacité maximale d'une étoile en équilibre (limite de Buchdahl : rayon > 9/8 rs). */
export const LIGHT_COLLAPSE_RS = (8 / 9) * LIGHT_STAR_RADIUS;
export const LIGHT_AIM_MIN = 0.5;
export const LIGHT_AIM_MAX = 48;

/** En dessous, la masse est traitée comme nulle (rayons droits, pas d'astre). */
const NO_MASS = 0.02;
const RAY_SPACING = 4;
/** Intervalle, en temps lointain, entre deux éclats de lumière sur un même rayon. */
const PULSE_PERIOD = 16;

export function lightEffectiveRs(rs: number): number {
  return rs < NO_MASS ? 0 : rs;
}

export function isBlackHole(rs: number): boolean {
  return rs > LIGHT_COLLAPSE_RS;
}

/** Rayon auquel la lumière est arrêtée : surface de l'étoile, ou juste au-dessus de l'horizon. */
export function lightAbsorbRadius(rs: number): number {
  if (lightEffectiveRs(rs) === 0) {
    return 0;
  }
  return isBlackHole(rs) ? rs * 1.01 : LIGHT_STAR_RADIUS;
}

export interface LightViewState {
  rs: number;
  /** Distance de visée du rayon suivi. */
  aim: number;
  /** Temps d'animation, en temps lointain. */
  time: number;
}

export interface LightViewLabels {
  horizon: string;
  photonSphere: string;
}

/** Garde les rayons tracés tant que la masse et le cadrage ne changent pas. */
export class LightRayCache {
  private key = '';
  private aimKey = '';
  private rays: LightRay[] = [];
  private impact: number[] = [];
  private aimRay?: LightRay;

  get(rs: number, aim: number, halfW: number, halfH: number): { rays: LightRay[]; impact: number[]; aimRay: LightRay } {
    const mass = lightEffectiveRs(rs);
    const absorb = lightAbsorbRadius(rs);
    const startX = -(halfW + 14);
    const exit = Math.hypot(halfW, halfH) + 14;
    const bMax = Math.ceil(halfH / RAY_SPACING) * RAY_SPACING + RAY_SPACING;
    const key = `${mass}|${startX.toFixed(1)}|${exit.toFixed(1)}|${bMax}`;
    if (key !== this.key) {
      this.key = key;
      this.aimKey = '';
      this.rays = [];
      this.impact = [];
      for (let b = -bMax; b <= bMax; b += RAY_SPACING) {
        this.impact.push(b);
        this.rays.push(traceLightRay(b, mass, absorb, startX, exit));
      }
    }
    const aimKey = `${key}|${aim}`;
    if (aimKey !== this.aimKey || !this.aimRay) {
      this.aimKey = aimKey;
      this.aimRay = traceLightRay(aim, mass, absorb, startX, exit);
    }
    return { rays: this.rays, impact: this.impact, aimRay: this.aimRay };
  }
}

export function drawLightView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: LightViewState,
  labels: LightViewLabels,
  cache: LightRayCache
): void {
  /* Cadre : 150 × 96 unités en paysage, 100 × 150 en portrait. */
  const scale = Math.max(Math.min(w / 150, h / 96), Math.min(w / 100, h / 150));
  const halfW = w / 2 / scale;
  const halfH = h / 2 / scale;
  const sx = (x: number): number => w / 2 + x * scale;
  const sy = (y: number): number => h / 2 - y * scale;
  const mass = lightEffectiveRs(state.rs);
  const hole = isBlackHole(state.rs);
  const { rays, impact, aimRay } = cache.get(state.rs, state.aim, halfW, halfH);

  const tracePath = (ray: LightRay): void => {
    ctx.beginPath();
    for (let i = 0; i < ray.x.length; i++) {
      if (i === 0) {
        ctx.moveTo(sx(ray.x[i]), sy(ray.y[i]));
      } else {
        ctx.lineTo(sx(ray.x[i]), sy(ray.y[i]));
      }
    }
    ctx.stroke();
  };
  /** Éclats de lumière partis du bord gauche à intervalles réguliers, placés selon le temps lointain. */
  const drawPulses = (ray: LightRay, radius: number, color: string): void => {
    const last = ray.t.length - 1;
    ctx.fillStyle = color;
    let i = 0;
    for (let target = state.time % PULSE_PERIOD; target <= ray.t[last]; target += PULSE_PERIOD) {
      while (i < last - 1 && ray.t[i + 1] < target) {
        i++;
      }
      const dt = ray.t[i + 1] - ray.t[i];
      const f = dt > 0 ? Math.min(1, Math.max(0, (target - ray.t[i]) / dt)) : 0;
      ctx.beginPath();
      ctx.arc(sx(ray.x[i] + (ray.x[i + 1] - ray.x[i]) * f), sy(ray.y[i] + (ray.y[i + 1] - ray.y[i]) * f), radius, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* Trajets sans masse, pour comparer. */
  if (mass > 0) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    for (const b of impact) {
      ctx.beginPath();
      ctx.moveTo(0, sy(b));
      ctx.lineTo(w, sy(b));
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(126, 240, 255, 0.45)';
    ctx.beginPath();
    ctx.moveTo(0, sy(state.aim));
    ctx.lineTo(w, sy(state.aim));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2;
  for (const ray of rays) {
    ctx.strokeStyle = ray.fate === 'absorbed' ? 'rgba(255, 130, 100, 0.62)' : 'rgba(255, 232, 160, 0.55)';
    tracePath(ray);
  }
  for (const ray of rays) {
    drawPulses(ray, 1.9, '#fff6d6');
  }

  ctx.strokeStyle = '#7ef0ff';
  ctx.lineWidth = 2.4;
  tracePath(aimRay);
  drawPulses(aimRay, 3.2, '#c9faff');

  if (mass === 0) {
    return;
  }
  const cx = sx(0);
  const cy = sy(0);
  if (hole) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5 * state.rs * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(cx, cy, state.rs * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 170, 110, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (ctx.measureText(labels.horizon).width < 2 * state.rs * scale - 8) {
      ctx.fillStyle = 'rgba(255, 200, 160, 0.95)';
      ctx.fillText(labels.horizon, cx, cy);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(232, 244, 255, 0.85)';
    ctx.fillText(labels.photonSphere, cx, cy - 1.5 * state.rs * scale - 6);
    ctx.textAlign = 'left';
  } else {
    const radius = LIGHT_STAR_RADIUS * scale;
    const glow = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.1, cx, cy, radius);
    glow.addColorStop(0, '#fff3c4');
    glow.addColorStop(1, '#ffb52e');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
