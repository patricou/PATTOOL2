import {
  sampleHorizonEl,
  silhouetteFillPath,
  silhouetteScreenPoints,
  silhouetteStrokePath,
  projectVisiblePeaks
} from './relief-horizon';
import type { ReliefHorizon, ReliefPeak } from './relief-horizon';

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

  it('keeps one vertical label when two peaks share nearly the same azimuth', () => {
    const high: ReliefPeak = {
      name: 'Mont Blanc',
      lat: 45.83,
      lon: 6.86,
      eleM: 4808,
      azDeg: 90,
      elDeg: 8,
      distKm: 40,
      visible: true
    };
    const low: ReliefPeak = {
      ...high,
      name: 'Hill',
      eleM: 1200,
      azDeg: 91,
      elDeg: 4
    };
    const labels = projectVisiblePeaks([high, low], 90, 0, 60, 40);
    expect(labels.length).toBe(1);
    expect(labels[0].peak.name).toBe('Mont Blanc');
  });

  it('omits peaks hidden behind the DEM horizon', () => {
    const hidden: ReliefPeak = {
      name: 'Hidden',
      lat: 46,
      lon: 7,
      eleM: 3000,
      azDeg: 10,
      elDeg: 5,
      distKm: 20,
      visible: false
    };
    expect(projectVisiblePeaks([hidden], 10, 0, 60, 40).length).toBe(0);
  });
});
