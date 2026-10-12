export interface MotifEl {
  k: 'c' | 'l' | 'p' | 'r' | 'e';
  c: string;
  a?: number;
  b?: number;
  r?: number;
  w?: number;
  h?: number;
  rx?: number;
  ry?: number;
  x2?: number;
  y2?: number;
  d?: string;
  t?: string;
}

function pt(i: number, n: number, radius: number): { x: number; y: number } {
  const rad = ((i * (360 / n) - 90) * Math.PI) / 180;
  return {
    x: +(100 + radius * Math.cos(rad)).toFixed(2),
    y: +(100 + radius * Math.sin(rad)).toFixed(2)
  };
}

function arc(i: number, n: number, radius: number, gapDeg: number): string {
  const step = 360 / n;
  const a0 = ((i * step - 90 + gapDeg) * Math.PI) / 180;
  const a1 = (((i + 1) * step - 90 - gapDeg) * Math.PI) / 180;
  const xy = (a: number) =>
    `${(100 + radius * Math.cos(a)).toFixed(2)} ${(100 + radius * Math.sin(a)).toFixed(2)}`;
  return `M${xy(a0)} A${radius} ${radius} 0 0 1 ${xy(a1)}`;
}

function wedge(i: number, n: number, inner: number, outer: number, gapDeg: number): string {
  const step = 360 / n;
  const a0 = ((i * step - 90 + gapDeg) * Math.PI) / 180;
  const a1 = (((i + 1) * step - 90 - gapDeg) * Math.PI) / 180;
  const xy = (r: number, a: number) =>
    `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  return `M${xy(inner, a0)} L${xy(outer, a0)} A${outer} ${outer} 0 0 1 ${xy(outer, a1)} L${xy(inner, a1)} A${inner} ${inner} 0 0 0 ${xy(inner, a0)} Z`;
}

function buildMotifs(): Record<string, MotifEl[]> {
  const marine: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 80 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 66 }
  ];
  for (let i = 0; i < 24; i++) {
    const p = pt(i, 24, 73);
    marine.push({ k: 'c', c: i % 6 === 0 ? 'card' : 'dot', a: p.x, b: p.y, r: i % 6 === 0 ? 2.4 : 1.15 });
  }

  const rail: MotifEl[] = [];
  for (let i = 0; i < 12; i++) {
    const major = i % 3 === 0;
    rail.push({
      k: 'r', c: 'baton', a: major ? 98.2 : 98.8, b: major ? 14 : 18,
      w: major ? 3.6 : 2.4, h: major ? 20 : 12, rx: 0.3,
      t: `rotate(${i * 30} 100 100)`
    });
  }

  const metro: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 78 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 72 }
  ];
  for (let i = 0; i < 4; i++) {
    metro.push({
      k: 'p', c: 'petal',
      d: 'M100 16 C108 30 114 36 100 48 C86 36 92 30 100 16 Z',
      t: `rotate(${i * 90} 100 100)`
    });
  }

  const obsidian: MotifEl[] = [
    { k: 'c', c: 'moon', a: 100, b: 58, r: 14 },
    { k: 'p', c: 'shade', d: 'M100 46 A12 12 0 1 0 100 70 A8 8 0 1 1 100 46 Z' }
  ];

  const sakura: MotifEl[] = [];
  for (let h = 0; h < 12; h++) {
    const c = pt(h, 12, 68);
    for (let p = 0; p < 5; p++) {
      const a = ((p * 72 - 90) * Math.PI) / 180;
      sakura.push({
        k: 'c', c: 'petal',
        a: +(c.x + 3.2 * Math.cos(a)).toFixed(2),
        b: +(c.y + 3.2 * Math.sin(a)).toFixed(2),
        r: 2.1
      });
    }
    sakura.push({ k: 'c', c: 'pistil', a: c.x, b: c.y, r: 1.15 });
  }

  const desert: MotifEl[] = [{ k: 'c', c: 'sun', a: 100, b: 100, r: 28 }];
  for (let i = 0; i < 36; i++) {
    const inner = pt(i, 36, i % 3 === 0 ? 34 : 50);
    const outer = pt(i, 36, 82);
    desert.push({ k: 'l', c: 'ray', a: inner.x, b: inner.y, x2: outer.x, y2: outer.y });
  }

  const abyss: MotifEl[] = [];
  for (let i = 0; i < 48; i++) {
    const rad = ((i * 24 - 90) * Math.PI) / 180;
    const radius = 20 + i * 1.25;
    const bright = i % 8 === 0;
    abyss.push({
      k: 'c', c: bright ? 'glowdot' : 'dot',
      a: +(100 + radius * Math.cos(rad)).toFixed(2),
      b: +(100 + radius * Math.sin(rad)).toFixed(2),
      r: bright ? 2.2 : 0.85
    });
  }

  const arcade: MotifEl[] = [
    { k: 'l', c: 'grid', a: 28, b: 100, x2: 172, y2: 100 },
    { k: 'l', c: 'grid', a: 100, b: 28, x2: 100, y2: 172 }
  ];
  for (let i = 0; i < 12; i++) {
    const p = pt(i, 12, 72);
    arcade.push({ k: 'r', c: 'pixel', a: p.x - 3.2, b: p.y - 3.2, w: 6.4, h: 6.4 });
  }

  const cathedral: MotifEl[] = [];
  for (let i = 0; i < 12; i++) {
    cathedral.push({ k: 'p', c: 'glass', d: wedge(i, 12, 58, 84, 1.1) });
  }

  const radar: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 28 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 46 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 64 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 80 },
    { k: 'l', c: 'grid', a: 22, b: 100, x2: 178, y2: 100 },
    { k: 'l', c: 'grid', a: 100, b: 22, x2: 100, y2: 178 }
  ];
  [[40, -20], [55, 40], [70, 110], [48, 200], [76, 250], [34, 310]].forEach(([radius, deg]) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    radar.push({
      k: 'c', c: 'blip',
      a: +(100 + radius * Math.cos(rad)).toFixed(2),
      b: +(100 + radius * Math.sin(rad)).toFixed(2),
      r: 1.8
    });
  });

  const marble: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 80 },
    { k: 'p', c: 'vein', d: 'M28 78 C70 36 96 128 168 74' },
    { k: 'p', c: 'vein', d: 'M36 132 C88 96 112 150 174 118' },
    { k: 'p', c: 'vein', d: 'M52 48 C96 92 78 40 154 58' }
  ];

  const ink: MotifEl[] = [
    { k: 'p', c: 'enso', d: 'M100 26 A74 74 0 1 1 88 34' }
  ];
  for (let i = 0; i < 12; i++) {
    const a = pt(i, 12, 62);
    const b = pt(i + 0.08, 12, 80);
    ink.push({ k: 'l', c: 'brush', a: a.x, b: a.y, x2: b.x, y2: b.y });
  }

  const circuit: MotifEl[] = [];
  for (let i = 0; i < 12; i++) {
    const a = pt(i, 12, 70);
    const b = pt(i + 1, 12, 70);
    circuit.push({ k: 'c', c: 'pad', a: a.x, b: a.y, r: 2.4 });
    circuit.push({ k: 'l', c: 'trace', a: a.x, b: a.y, x2: b.x, y2: a.y });
    circuit.push({ k: 'l', c: 'trace', a: b.x, b: a.y, x2: b.x, y2: b.y });
  }

  const lunar: MotifEl[] = [
    { k: 'c', c: 'crater', a: 78, b: 70, r: 10 },
    { k: 'c', c: 'crater', a: 124, b: 64, r: 6 },
    { k: 'c', c: 'crater', a: 112, b: 108, r: 8 },
    { k: 'c', c: 'crater', a: 70, b: 118, r: 5 },
    { k: 'c', c: 'crater', a: 138, b: 126, r: 4 },
    { k: 'c', c: 'crater', a: 92, b: 140, r: 3.2 }
  ];

  const flame: MotifEl[] = [{ k: 'c', c: 'ember', a: 100, b: 100, r: 34 }];
  for (let i = 0; i < 12; i++) {
    const tip = pt(i, 12, 76);
    const left = pt(i - 0.42, 12, 50);
    const right = pt(i + 0.42, 12, 50);
    flame.push({ k: 'p', c: 'tongue', d: `M${tip.x} ${tip.y} L${left.x} ${left.y} L${right.x} ${right.y} Z` });
  }

  const prism: MotifEl[] = [];
  for (let i = 0; i < 12; i++) {
    prism.push({ k: 'p', c: 'arc', d: arc(i, 12, 76, 2.2) });
  }

  const aviator: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 76 },
    { k: 'p', c: 'marker', d: 'M100 14 L109 32 L91 32 Z' }
  ];
  for (let i = 1; i < 12; i++) {
    aviator.push({
      k: 'r', c: 'baton', a: 98.7, b: 18, w: 2.6, h: 12, rx: 0.2,
      t: `rotate(${i * 30} 100 100)`
    });
  }

  const forest: MotifEl[] = [];
  for (let i = 0; i < 12; i++) {
    forest.push({
      k: 'p', c: 'leaf',
      d: 'M100 18 C110 34 108 48 100 52 C92 48 90 34 100 18 Z',
      t: `rotate(${i * 30} 100 100)`
    });
  }

  const chess: MotifEl[] = [];
  for (let i = 0; i < 8; i++) {
    chess.push({ k: 'p', c: i % 2 === 0 ? 'lite' : 'dark', d: wedge(i, 8, 6, 40, 0.2) });
  }
  chess.push({ k: 'c', c: 'ring', a: 100, b: 100, r: 40 });

  const orbit: MotifEl[] = [
    { k: 'e', c: 'orbit', a: 100, b: 100, rx: 74, ry: 28, t: 'rotate(18 100 100)' },
    { k: 'e', c: 'orbit', a: 100, b: 100, rx: 70, ry: 24, t: 'rotate(78 100 100)' },
    { k: 'e', c: 'orbit', a: 100, b: 100, rx: 66, ry: 20, t: 'rotate(132 100 100)' },
    { k: 'c', c: 'planet', a: 162, b: 92, r: 3.2 },
    { k: 'c', c: 'planet alt', a: 62, b: 128, r: 2.4 },
    { k: 'c', c: 'planet far', a: 126, b: 42, r: 2 }
  ];

  const ripple: MotifEl[] = [];
  for (let i = 0; i < 6; i++) {
    ripple.push({ k: 'c', c: 'ring', a: 108, b: 86, r: 16 + i * 12 });
  }

  const gears: MotifEl[] = [];
  [{ cx: 100, cy: 70, r: 26, teeth: 12 }, { cx: 64, cy: 126, r: 20, teeth: 10 }, { cx: 136, cy: 126, r: 20, teeth: 10 }]
    .forEach((gear) => {
      gears.push({ k: 'c', c: 'ring', a: gear.cx, b: gear.cy, r: gear.r });
      gears.push({ k: 'c', c: 'dot', a: gear.cx, b: gear.cy, r: 3 });
      for (let t = 0; t < gear.teeth; t++) {
        gears.push({
          k: 'r', c: 'baton',
          a: gear.cx - 2, b: gear.cy - gear.r - 5, w: 4, h: 6, rx: 0.4,
          t: `rotate(${t * (360 / gear.teeth)} ${gear.cx} ${gear.cy})`
        });
      }
    });

  const compass: MotifEl[] = [
    { k: 'p', c: 'rose', d: 'M100 22 L108 92 L100 84 L92 92 Z M100 178 L108 108 L100 116 L92 108 Z M22 100 L92 92 L84 100 L92 108 Z M178 100 L108 92 L116 100 L108 108 Z' },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 46 },
    { k: 'c', c: 'card', a: 100, b: 100, r: 3.2 }
  ];
  for (let i = 0; i < 8; i++) {
    const p = pt(i, 8, 74);
    compass.push({ k: 'c', c: i % 2 === 0 ? 'card' : 'dot', a: p.x, b: p.y, r: i % 2 === 0 ? 2.2 : 1.2 });
  }

  const vinyl: MotifEl[] = [{ k: 'c', c: 'label', a: 100, b: 100, r: 24 }];
  for (let i = 0; i < 8; i++) {
    vinyl.push({ k: 'c', c: 'groove', a: 100, b: 100, r: 32 + i * 6 });
  }

  const eclipse: MotifEl[] = [
    { k: 'c', c: 'disk', a: 78, b: 100, r: 42 },
    { k: 'c', c: 'bite', a: 118, b: 100, r: 42 }
  ];

  const ecg: MotifEl[] = [
    { k: 'p', c: 'pulse', d: 'M18 104 H46 L54 104 L62 70 L72 132 L82 88 L92 104 H168 L176 78 L184 104' },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 78 }
  ];

  const fan: MotifEl[] = [];
  for (let i = 0; i < 16; i++) {
    fan.push({ k: 'p', c: i % 2 === 0 ? 'lite' : 'dark', d: wedge(i, 16, 28, 82, 0.6) });
  }

  const labyrinth: MotifEl[] = [];
  for (let i = 0; i < 12; i++) {
    const radius = 22 + i * 5;
    const start = i * 32;
    const a0 = ((start - 90) * Math.PI) / 180;
    const a1 = ((start + 78 - 90) * Math.PI) / 180;
    const xy = (a: number) =>
      `${(100 + radius * Math.cos(a)).toFixed(2)} ${(100 + radius * Math.sin(a)).toFixed(2)}`;
    labyrinth.push({ k: 'p', c: 'trace', d: `M${xy(a0)} A${radius} ${radius} 0 0 1 ${xy(a1)}` });
  }

  const hybridNight: MotifEl[] = [
    { k: 'c', c: 'moon', a: 100, b: 118, r: 16 },
    { k: 'p', c: 'shade', d: 'M100 104 A14 14 0 1 0 100 132 A9 9 0 1 1 100 104 Z' },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 78 }
  ];

  const hybridChrono: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 58, r: 16 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 78 }
  ];
  for (let i = 0; i < 12; i++) {
    hybridChrono.push({
      k: 'r', c: 'baton', a: 99, b: 16, w: 2, h: 8,
      t: `rotate(${i * 30} 100 100)`
    });
  }

  const hybridRadar: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 30 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 52 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 74 },
    { k: 'l', c: 'grid', a: 26, b: 100, x2: 174, y2: 100 },
    { k: 'l', c: 'grid', a: 100, b: 26, x2: 100, y2: 174 }
  ];

  const hybridSakura: MotifEl[] = [];
  for (let h = 0; h < 8; h++) {
    const c = pt(h, 8, 62);
    for (let p = 0; p < 5; p++) {
      const a = ((p * 72 - 90) * Math.PI) / 180;
      hybridSakura.push({
        k: 'c', c: 'petal',
        a: +(c.x + 3.4 * Math.cos(a)).toFixed(2),
        b: +(c.y + 3.4 * Math.sin(a)).toFixed(2),
        r: 2.2
      });
    }
    hybridSakura.push({ k: 'c', c: 'pistil', a: c.x, b: c.y, r: 1.1 });
  }

  const hybridOrbit: MotifEl[] = [
    { k: 'e', c: 'orbit', a: 100, b: 100, rx: 72, ry: 26, t: 'rotate(24 100 100)' },
    { k: 'e', c: 'orbit', a: 100, b: 100, rx: 64, ry: 20, t: 'rotate(100 100 100)' },
    { k: 'c', c: 'planet', a: 158, b: 86, r: 3 },
    { k: 'c', c: 'planet alt', a: 58, b: 122, r: 2.2 }
  ];

  const hybridDeco: MotifEl[] = [
    { k: 'c', c: 'ring', a: 100, b: 100, r: 80 },
    { k: 'c', c: 'ring', a: 100, b: 100, r: 72 }
  ];
  for (let i = 0; i < 12; i++) {
    hybridDeco.push({
      k: 'p', c: i % 3 === 0 ? 'card' : 'petal',
      d: 'M100 16 L104 30 L100 26 L96 30 Z',
      t: `rotate(${i * 30} 100 100)`
    });
  }

  return {
    marine, rail, metro, obsidian, sakura, desert, abyss, arcade, cathedral, radar,
    marble, ink, circuit, lunar, flame, prism, aviator, forest, chess, orbit,
    ripple, gears, compass, vinyl, eclipse, ecg, fan, labyrinth,
    'hybrid-night': hybridNight,
    'hybrid-chrono': hybridChrono,
    'hybrid-radar': hybridRadar,
    'hybrid-sakura': hybridSakura,
    'hybrid-orbit': hybridOrbit,
    'hybrid-deco': hybridDeco
  };
}

export const CLOCK_MOTIFS: Record<string, MotifEl[]> = buildMotifs();
export const NO_MOTIF: MotifEl[] = [];
