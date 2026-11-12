/**
 * Vue « ascenseur d'Einstein » de la page Espace-temps : une cabine sur une planète et une cabine
 * dans une fusée, avec une bille lâchée et un éclat de lumière qui traverse. Schéma sans unités :
 * tout se ramène à un déplacement vertical ½ a t², identique pour la pesanteur et pour l'accélération.
 */

/** Chute, en hauteurs de cabine, à la fin d'un cycle quand le curseur est au maximum. */
const DROP = 0.5;
const EMIT_HEIGHT = 0.2;
const BALL_X = 0.7;
const STEPS = 40;

export interface LiftState {
  /** Pesanteur de la planète = accélération de la fusée, de 0 à 1. */
  strength: number;
  /** true : cabine en chute libre et moteur éteint ; false : cabine posée au sol et moteur allumé. */
  free: boolean;
  /** true : vu de l'extérieur ; false : vu depuis la cabine. */
  outside: boolean;
  /** Avancement du cycle, de 0 (bille lâchée, éclat émis) à 1. */
  progress: number;
  /** Temps réel (s), pour faire vaciller la flamme. */
  time: number;
}

export interface LiftLabels {
  planet: string;
  rocket: string;
  onGround: string;
  falling: string;
  engineOn: string;
  engineOff: string;
}

/** Fraction décimale pseudo-aléatoire mais fixe, pour semer les étoiles. */
function scatter(seed: number): number {
  const s = Math.sin(seed) * 43758.5453;
  return s - Math.floor(s);
}

export function drawLiftView(ctx: CanvasRenderingContext2D, w: number, h: number, state: LiftState, labels: LiftLabels): void {
  const colW = w / 2;
  const top = 26;
  const bottom = h - 24;
  const areaH = bottom - top;
  const cabH = Math.min(areaH / 2.4, (colW - 30) / 0.9);
  const cabW = cabH * 0.9;
  const baseTop = top + (areaH - cabH) / 2;
  const strength = Math.min(1, Math.max(0, state.strength));
  const u = Math.min(1, Math.max(0, state.progress));
  /** Déplacement ½ a t² pour une accélération d'intensité 1, à l'avancement p. */
  const shift = (p: number): number => strength * DROP * cabH * p * p;

  for (let col = 0; col < 2; col++) {
    const planet = col === 0;
    const left = col * colW;
    const cx = left + colW / 2;
    /* Accélérations vues de l'extérieur, vers le haut : cabine, puis bille et lumière. */
    const cabinAcc = planet ? (state.free ? -1 : 0) : state.free ? 0 : 1;
    const objectAcc = planet ? -1 : 0;
    /** Hauteur gagnée par la cabine, puis par la bille et la lumière, dans le point de vue choisi. */
    const cabinUp = (p: number): number => (state.outside ? cabinAcc * shift(p) : 0);
    const objectUp = (p: number): number => (objectAcc - (state.outside ? 0 : cabinAcc)) * shift(p);
    /** Hauteur gagnée par le décor (fixe vu de l'extérieur). */
    const sceneryUp = state.outside ? 0 : -cabinAcc * shift(u);
    const cabTop = baseTop - cabinUp(u);
    const cabLeft = cx - cabW / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 4, colW, h - top + 4);
    ctx.clip();

    if (planet) {
      /* Gaine graduée et sol. */
      const railL = cabLeft - 10;
      const railR = cabLeft + cabW + 10;
      const step = cabH / 3;
      ctx.strokeStyle = 'rgba(200, 214, 236, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(railL, 0);
      ctx.lineTo(railL, h);
      ctx.moveTo(railR, 0);
      ctx.lineTo(railR, h);
      for (let j = -14; j <= 6; j++) {
        const y = baseTop + cabH + j * step - sceneryUp;
        ctx.moveTo(railL - 8, y);
        ctx.lineTo(railL, y);
        ctx.moveTo(railR, y);
        ctx.lineTo(railR + 8, y);
      }
      ctx.stroke();
      const groundY = baseTop + cabH + (state.free ? 0.53 * cabH : 0) - sceneryUp;
      ctx.fillStyle = '#3a2c1a';
      ctx.fillRect(left, groundY, colW, h - groundY);
      ctx.strokeStyle = '#c9a36a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(left, groundY);
      ctx.lineTo(left + colW, groundY);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      const span = h + 2 * DROP * cabH;
      for (let j = 1; j <= 30; j++) {
        const x = left + scatter(j * 12.9898) * colW;
        const y = scatter(j * 78.233) * span - DROP * cabH - sceneryUp;
        ctx.fillRect(x, y, 1.5, 1.5);
      }
      /* Coiffe, et flamme quand le moteur pousse. */
      ctx.fillStyle = '#16213d';
      ctx.strokeStyle = '#9fb4d8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cabLeft, cabTop);
      ctx.lineTo(cx, cabTop - 0.18 * cabH);
      ctx.lineTo(cabLeft + cabW, cabTop);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (!state.free && strength > 0.01) {
        const flame = cabH * (0.06 + 0.12 * strength) * (1 + 0.12 * Math.sin(state.time * 34));
        const flameTop = cabTop + cabH + 3;
        const glow = ctx.createLinearGradient(0, flameTop, 0, flameTop + flame);
        glow.addColorStop(0, '#fff3c4');
        glow.addColorStop(1, 'rgba(255, 110, 40, 0.15)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.moveTo(cx - cabW * 0.2, flameTop);
        ctx.lineTo(cx + cabW * 0.2, flameTop);
        ctx.lineTo(cx, flameTop + flame);
        ctx.closePath();
        ctx.fill();
      }
    }

    /* Cabine. */
    ctx.fillStyle = '#0d1528';
    ctx.strokeStyle = '#9fb4d8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(cabLeft, cabTop, cabW, cabH);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cabLeft, cabTop + cabH);
    ctx.lineTo(cabLeft + cabW, cabTop + cabH);
    ctx.stroke();

    /* Repère horizontal fixé à la cabine, à la hauteur de la lampe. */
    const lampY = cabTop + EMIT_HEIGHT * cabH;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(cabLeft, lampY);
    ctx.lineTo(cabLeft + cabW, lampY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd27a';
    ctx.fillRect(cabLeft - 3, lampY - 5, 6, 10);

    /* Éclat de lumière : il traverse la cabine pendant le cycle. */
    const startY = baseTop + EMIT_HEIGHT * cabH;
    ctx.strokeStyle = '#ffe8a0';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let j = 0; j <= STEPS; j++) {
      const p = (u * j) / STEPS;
      const x = cabLeft + p * cabW;
      const y = startY - objectUp(p);
      if (j === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.fillStyle = '#fff6d6';
    ctx.beginPath();
    ctx.arc(cabLeft + u * cabW, startY - objectUp(u), 4, 0, Math.PI * 2);
    ctx.fill();

    /* Bille lâchée sans vitesse. */
    const ballX = cabLeft + BALL_X * cabW;
    ctx.fillStyle = 'rgba(255, 82, 82, 0.55)';
    for (let j = 0; j < STEPS; j += 4) {
      ctx.beginPath();
      ctx.arc(ballX, startY - objectUp((u * j) / STEPS), 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ff5252';
    ctx.beginPath();
    ctx.arc(ballX, startY - objectUp(u), Math.max(5, cabH * 0.035), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#f2f6ff';
    ctx.fillText(planet ? labels.planet : labels.rocket, cx, 16);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#c8d6ec';
    const status = planet ? (state.free ? labels.falling : labels.onGround) : state.free ? labels.engineOff : labels.engineOn;
    ctx.fillText(status, cx, h - 8);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(colW, 0);
  ctx.lineTo(colW, h);
  ctx.stroke();
  ctx.textAlign = 'left';
}
