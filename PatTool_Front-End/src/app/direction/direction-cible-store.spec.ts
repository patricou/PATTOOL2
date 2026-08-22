import { circularDiff } from './direction-attitude';
import {
  CIBLE_MARK_MIN_DIST_M,
  cibleImpliedGeoHeadingDeg,
  cibleMarkBearingDeg,
  cibleMarkDistanceM,
  hasCibleMark
} from './direction-cible-store';

describe('cible mark GPS', () => {
  it('rejects incomplete coordinates', () => {
    expect(hasCibleMark(null, 6)).toBe(false);
    expect(hasCibleMark(46, null)).toBe(false);
    expect(cibleMarkBearingDeg(46, 6, null, 6.1)).toBeNull();
    expect(cibleMarkDistanceM(46, 6, 46.01, null)).toBeNull();
  });

  it('computes eastward bearing and distance from a nearby mark', () => {
    const az = cibleMarkBearingDeg(46, 6, 46, 6.02);
    const dist = cibleMarkDistanceM(46, 6, 46, 6.02);
    expect(az).not.toBeNull();
    expect(Math.abs(circularDiff(az!, 90))).toBeLessThan(2);
    expect(dist).toBeGreaterThan(1400);
    expect(dist).toBeLessThan(1700);
    expect(dist!).toBeGreaterThan(CIBLE_MARK_MIN_DIST_M);
  });

  it('maps sensor heading back to the GPS azimuth after a lock', () => {
    const rawAtLock = 40;
    const ref = 120;
    expect(cibleImpliedGeoHeadingDeg(rawAtLock, rawAtLock, ref)).toBe(120);
    expect(cibleImpliedGeoHeadingDeg(70, rawAtLock, ref)).toBe(150);
  });
});
