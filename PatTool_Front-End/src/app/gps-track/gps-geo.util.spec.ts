import { bearingDeg, trackHeadingAt } from './gps-geo.util';

describe('gps-geo heading', () => {
  it('gives ~90° for an eastward segment', () => {
    expect(Math.abs(bearingDeg(46, 6, 46, 6.02) - 90)).toBeLessThan(2);
  });

  it('skips a duplicated start point and follows the eastbound track', () => {
    const heading = trackHeadingAt(
      [
        { lat: 46, lon: 6 },
        { lat: 46, lon: 6 },
        { lat: 46, lon: 6.001 }
      ],
      0,
      20
    );
    expect(heading).not.toBeNull();
    expect(Math.abs(heading! - 90)).toBeLessThan(5);
  });

  it('reads the heading a few metres ahead on the track', () => {
    const heading = trackHeadingAt(
      [
        { lat: 46, lon: 6 },
        { lat: 46.001, lon: 6 },
        { lat: 46.002, lon: 6 }
      ],
      0
    );
    expect(heading).not.toBeNull();
    expect(Math.abs(heading! - 0)).toBeLessThan(2);
  });
});
