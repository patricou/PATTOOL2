import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

const ROSE_CX = 100;
const ROSE_CY = 100;

function rosePolar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [ROSE_CX + Math.cos(a) * r, ROSE_CY + Math.sin(a) * r];
}

function roseTickPath(step: number, r0: number, r1: number): string {
  let d = '';
  for (let deg = 0; deg < 360; deg += step) {
    const [x0, y0] = rosePolar(r0, deg);
    const [x1, y1] = rosePolar(r1, deg);
    d += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d;
}

function roseKite(deg: number, outer: number, waist: number, tail: number, halfW: number): string {
  const a = ((deg - 90) * Math.PI) / 180;
  const p = a + Math.PI / 2;
  const [tx, ty] = rosePolar(outer, deg);
  const [bx, by] = rosePolar(tail, deg);
  const wx = ROSE_CX + Math.cos(a) * waist;
  const wy = ROSE_CY + Math.sin(a) * waist;
  const lx = wx + Math.cos(p) * halfW;
  const ly = wy + Math.sin(p) * halfW;
  const rx = wx - Math.cos(p) * halfW;
  const ry = wy - Math.sin(p) * halfW;
  return `${tx.toFixed(2)},${ty.toFixed(2)} ${lx.toFixed(2)},${ly.toFixed(2)} ${bx.toFixed(2)},${by.toFixed(2)} ${rx.toFixed(2)},${ry.toFixed(2)}`;
}

type RoseKiteKind = 'n' | 'cardinal' | 'inter' | 'half' | 'quarter';

function roseKiteList(): { points: string; kind: RoseKiteKind }[] {
  const quarter: { points: string; kind: RoseKiteKind }[] = [];
  const half: { points: string; kind: RoseKiteKind }[] = [];
  const inter: { points: string; kind: RoseKiteKind }[] = [];
  const cardinal: { points: string; kind: RoseKiteKind }[] = [];
  const north: { points: string; kind: RoseKiteKind }[] = [];
  for (let i = 0; i < 32; i++) {
    const deg = i * 11.25;
    if (i % 8 === 0) {
      const kite = {
        points: roseKite(deg, 40.5, 15.5, 3.8, 6.1),
        kind: (deg === 0 ? 'n' : 'cardinal') as RoseKiteKind
      };
      (deg === 0 ? north : cardinal).push(kite);
    } else if (i % 4 === 0) {
      inter.push({ points: roseKite(deg, 34.5, 14.5, 5, 4.3), kind: 'inter' });
    } else if (i % 2 === 0) {
      half.push({ points: roseKite(deg, 26.5, 13, 6, 2.7), kind: 'half' });
    } else {
      quarter.push({ points: roseKite(deg, 20.5, 12, 7, 1.7), kind: 'quarter' });
    }
  }
  return [...quarter, ...half, ...inter, ...cardinal, ...north];
}

type RoseLblKind = 'n' | 'card' | 'inter' | 'deg' | 'deg-major';

interface RoseLbl {
  x: number;
  y: number;
  deg: number;
  label: string;
  kind: RoseLblKind;
  font: number;
}

function roseLbl(deg: number, r: number, label: string, kind: RoseLblKind, font: number): RoseLbl {
  const [x, y] = rosePolar(r, deg);
  return { x: +x.toFixed(2), y: +y.toFixed(2), deg, label, kind, font };
}

const ROSE_CARD_LABELS: RoseLbl[] = [
  roseLbl(0, 71.2, 'N', 'n', 16.5),
  roseLbl(90, 71.2, 'E', 'card', 14.5),
  roseLbl(180, 71.2, 'S', 'card', 14.5),
  roseLbl(270, 71.2, 'O', 'card', 14.5),
  roseLbl(45, 66.4, 'NE', 'inter', 7.4),
  roseLbl(135, 66.4, 'SE', 'inter', 7.4),
  roseLbl(225, 66.4, 'SO', 'inter', 7.4),
  roseLbl(315, 66.4, 'NO', 'inter', 7.4)
];
const ROSE_DEG_LABELS: RoseLbl[] = Array.from({ length: 36 }, (_, i) => i * 10)
  .filter((d) => d !== 0 && d !== 90 && d !== 180 && d !== 270)
  .map((d) => roseLbl(d, 80.6, String(d), d % 30 === 0 ? 'deg-major' : 'deg', d % 30 === 0 ? 6.6 : 5.6));
const ROSE_DOTS = Array.from({ length: 24 }, (_, i) => {
  const [x, y] = rosePolar(63.5, i * 15);
  return { x, y };
});

let roseUid = 0;

@Component({
  selector: 'app-compass-rose',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './compass-rose.component.html',
  styleUrls: ['./compass-rose.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'compass-rose',
    '[class.compass-rose--overlay]': 'variant === "overlay"',
    '[class.compass-rose--stage]': 'variant === "stage"'
  }
})
export class CompassRoseComponent {
  /** Card rotation in degrees (unwrapped). Letters stay upright via `uprightDeg`. */
  @Input() rotationDeg = 0;
  /** overlay: camera visor; stage: standalone instrument (page Nord). */
  @Input() variant: 'overlay' | 'stage' = 'overlay';
  /** Azimut géographique du repère (0 = Nord). Affiche une 2ᵉ flèche. */
  @Input() markAzimuthDeg: number | null = null;

  readonly uid = `cr${++roseUid}`;
  readonly roseTick1 = roseTickPath(1, 90.1, 93.7);
  readonly roseTick5 = roseTickPath(5, 88.0, 93.9);
  readonly roseTick10 = roseTickPath(10, 85.4, 94.3);
  readonly roseTick30 = roseTickPath(30, 82.2, 95.1);
  readonly roseTickInner = roseTickPath(5, 57.4, 61.4);
  readonly roseTickInnerMajor = roseTickPath(30, 55.6, 61.8);
  readonly roseKites = roseKiteList();
  readonly roseCardLabels = ROSE_CARD_LABELS;
  readonly roseDegLabels = ROSE_DEG_LABELS;
  readonly roseDots = ROSE_DOTS;

  uprightDeg(): number {
    return -this.rotationDeg;
  }

  hasMarkNeedle(): boolean {
    return this.markAzimuthDeg != null && Number.isFinite(this.markAzimuthDeg);
  }

  markKitePoints(): string {
    return roseKite(this.markAzimuthDeg ?? 0, 46.5, 16.2, 3.2, 5.6);
  }

  markLabel(): RoseLbl {
    return roseLbl(this.markAzimuthDeg ?? 0, 54.2, 'R', 'n', 9.2);
  }
}
