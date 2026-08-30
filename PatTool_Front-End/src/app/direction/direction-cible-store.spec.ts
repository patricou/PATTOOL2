import { circularDiff } from './direction-attitude';
import {
  CIBLE_MARK_MIN_DIST_M,
  cibleImpliedGeoHeadingDeg,
  cibleLockDeltaDeg,
  cibleMarkBearingDeg,
  cibleMarkDistanceM,
  cibleSensorHeadingFacingMark,
  cibleViewfinderHeadingDeg,
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

  it('keeps the rose needle on the sensor heading when facing the mark', () => {
    expect(cibleSensorHeadingFacingMark(40, 120, null)).toBe(40);
    expect(cibleSensorHeadingFacingMark(40, 120, 120)).toBe(40);
    expect(cibleSensorHeadingFacingMark(40, 120, 150)).toBe(70);
  });

  it('treats the live GPS bearing as the aligned heading after a walk', () => {
    expect(cibleLockDeltaDeg(40, 40, 120, 120)).toBe(0);
    expect(cibleLockDeltaDeg(70, 40, 120, 150)).toBe(0);
    expect(cibleLockDeltaDeg(40, 40, 120, 150)).not.toBe(0);
  });

  it('keeps the Nord heading when a GPS mark exists, even with a map-time magnetometer lock', () => {
    const heading = cibleViewfinderHeadingDeg({
      hasMark: true,
      nordHeadingDeg: 240,
      rawHeadingDeg: 10,
      lockedHeadingDeg: 10,
      lockedRefAzimuthDeg: 184,
      liveMarkBearingDeg: 240
    });
    expect(heading).toBe(240);
  });

  it('falls back to the magnetometer lock only without a mark', () => {
    const heading = cibleViewfinderHeadingDeg({
      hasMark: false,
      nordHeadingDeg: 240,
      rawHeadingDeg: 10,
      lockedHeadingDeg: 10,
      lockedRefAzimuthDeg: 184
    });
    expect(heading).toBe(184);
  });
});
