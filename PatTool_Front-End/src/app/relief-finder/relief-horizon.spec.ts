import {
  sampleHorizonEl,
  silhouetteFillPath,
  silhouetteScreenPoints,
  silhouetteStrokePath
} from './relief-horizon';
import type { ReliefHorizon } from './relief-horizon';

function dummyHorizon(els: number[], step = 1): ReliefHorizon {
  return {
    lat: 46,
    lon: 6,
    observerAltM: 400,
    radiusKm: 60,
    stepDeg: step,
    zoom: 9,
    horizonElDeg: els,
    horizonDistM: els.map(() => 10000),
    peaks: []
  };
}

describe('relief-horizon', () => {
  it('interpolates between adjacent azimuth samples', () => {
    const els = [0, 10, 0, 0];
    expect(sampleHorizonEl(els, 0, 90)).toBeCloseTo(0, 5);
    expect(sampleHorizonEl(els, 45, 90)).toBeCloseTo(5, 5);
    expect(sampleHorizonEl(els, 90, 90)).toBeCloseTo(10, 5);
  });

  it('wraps azimuth 360° to 0°', () => {
    const els = [4, 0, 0, 8];
    expect(sampleHorizonEl(els, 360, 90)).toBeCloseTo(4, 5);
  });

  it('builds a closed fill path from screen points', () => {
    const h = dummyHorizon(Array.from({ length: 360 }, () => 2));
    const pts = silhouetteScreenPoints(h, 0, 0, 60, 40);
    const fill = silhouetteFillPath(pts);
    const stroke = silhouetteStrokePath(pts);
    expect(pts.length).toBeGreaterThan(10);
    expect(fill.startsWith('M')).toBeTrue();
    expect(fill.endsWith('Z')).toBeTrue();
    expect(stroke.startsWith('M')).toBeTrue();
    expect(stroke.includes('Z')).toBeFalse();
  });
});
