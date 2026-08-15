import {
  cameraFromEarthToDeviceQuat,
  circularDiff,
  computeFinderTurnGuide,
  projectCelestialToScreen,
  uprightRollDeg
} from './direction-attitude';
import {
  derivePattoolCal,
  sightingOffsetsFromLook,
  snapshotFromPayload,
  type PattoolCalSnapshot
} from './direction-pattool-cal';

/** Poses Galaxy S23 (export 2026-08-14) — 1re série incomplète, 2e et 3e complètes. */
const SAMPLES = [
  { poseId: 'n', expectedAz: 0, expectedEl: 0, quat: [0.7104202552356588, 0.10859117741433423, 0.09785818115246538, 0.6884292218668534] },
  { poseId: 'w', expectedAz: 270, expectedEl: 0, quat: [0.3825236472692375, 0.6139202949769477, 0.5829407226679278, 0.37007788984300516] },
  { poseId: 's', expectedAz: 180, expectedEl: 0, quat: [0.1635734479672466, 0.6858546631274479, 0.691489754865032, 0.15712742314166322] },
  { poseId: 'e', expectedAz: 90, expectedEl: 0, quat: [0.4086060866646299, -0.580066610924002, -0.5746683182009257, 0.4078236345381164] },
  { poseId: 'n', expectedAz: 0, expectedEl: 0, quat: [0.7094873960255105, -0.013204133485363026, -0.0310077367525279, 0.7039117885085652] },
  { poseId: 'w', expectedAz: 270, expectedEl: 0, quat: [0.3924699073992941, 0.5913367266253874, 0.5787980810654292, 0.40159809372672334] },
  { poseId: 's', expectedAz: 180, expectedEl: 0, quat: [0.055225397419530614, -0.7086221823890095, -0.7024034858563016, 0.03786952815930717] },
  { poseId: 'e', expectedAz: 90, expectedEl: 0, quat: [0.40991824932750337, -0.5877542984507113, -0.5787639841974522, 0.38928673765860355] },
  { poseId: 'sky', expectedAz: null, expectedEl: 90, quat: [-0.4408202452383451, 0.891892540155956, -0.09940922304336527, 0.01797260626832199] },
  { poseId: 'ground', expectedAz: null, expectedEl: -90, quat: [0.07095063490132102, -0.05384389552788471, -0.8024995436129454, 0.5899672235154222] },
  { poseId: 'n', expectedAz: 0, expectedEl: 0, quat: [0.7082801478784433, 0.03923554880257175, 0.006073944412650062, 0.7048140967877442] },
  { poseId: 'w', expectedAz: 270, expectedEl: 0, quat: [0.45166134581411893, 0.5380238810991101, 0.5448238313460166, 0.4579293885108017] },
  { poseId: 's', expectedAz: 180, expectedEl: 0, quat: [0.05522312486763864, 0.7081839012320938, 0.7014958223451454, 0.05770251075866103] },
  { poseId: 'e', expectedAz: 90, expectedEl: 0, quat: [0.3360587278401314, -0.6385457301065801, -0.6126477734421385, 0.3224695143754167] },
  { poseId: 'sky', expectedAz: null, expectedEl: 90, quat: [0.2356224306314334, -0.9636051795762012, 0.1262311573743351, 0.0035809196009241695] },
  { poseId: 'ground', expectedAz: null, expectedEl: -90, quat: [0.09195452450784768, -0.03947535503292463, -0.821233684728939, 0.5617484284215579] }
];

function att(quat: number[]) {
  return cameraFromEarthToDeviceQuat({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] });
}

function snaps(): PattoolCalSnapshot[] {
  return SAMPLES.map((s) =>
    snapshotFromPayload({
      poseId: s.poseId,
      expectedAz: s.expectedAz,
      expectedEl: s.expectedEl,
      quat: s.quat
    })
  );
}

describe('camera look from AbsoluteOrientationSensor quaternion', () => {
  it('does not stick azimuth at 0° for the four cardinals', () => {
    const cardinals = SAMPLES.filter((s) => s.expectedAz != null);
    for (const s of cardinals) {
      const a = att(s.quat)!;
      expect(Math.abs(circularDiff(a.azimuthDeg, s.expectedAz!))).toBeLessThan(45);
      expect(Math.abs(a.elevationDeg)).toBeLessThan(8);
    }
  });

  it('points near zenith / nadir for sky and ground', () => {
    for (const s of SAMPLES.filter((x) => x.expectedAz == null)) {
      const a = att(s.quat)!;
      expect(a.elevationDeg * Math.sign(s.expectedEl)).toBeGreaterThan(70);
    }
  });

  it('does not report an upside-down roll when pointing at the sky', () => {
    for (const s of SAMPLES.filter((x) => x.poseId === 'sky')) {
      const a = att(s.quat)!;
      expect(Math.abs(a.rollDeg)).toBeLessThan(90);
    }
  });

  it('looks along −Z : horizon poses have |lookUp| small, north has lookNorth > 0', () => {
    const n = att(SAMPLES[10].quat)!;
    expect(n.lookNorth).toBeGreaterThan(0.9);
    expect(Math.abs(n.lookUp)).toBeLessThan(0.1);
    const sky = att(SAMPLES[8].quat)!;
    expect(sky.lookUp).toBeGreaterThan(0.9);
    const ground = att(SAMPLES[9].quat)!;
    expect(ground.lookUp).toBeLessThan(-0.9);
  });

  it('conjugating the quaternion loses yaw (legacy bug)', () => {
    const west = SAMPLES.find((s) => s.poseId === 'w' && s.expectedAz === 270)!;
    const good = cameraFromEarthToDeviceQuat(
      { x: west.quat[0], y: west.quat[1], z: west.quat[2], w: west.quat[3] },
      { conjugateQuat: false }
    )!;
    const bad = cameraFromEarthToDeviceQuat(
      { x: west.quat[0], y: west.quat[1], z: west.quat[2], w: west.quat[3] },
      { conjugateQuat: true }
    )!;
    expect(Math.abs(circularDiff(good.azimuthDeg, 270))).toBeLessThan(30);
    expect(Math.abs(circularDiff(bad.azimuthDeg, 270))).toBeGreaterThan(60);
  });

  it('derives quat / no-conjugate / rear-camera from the 16 poses', () => {
    const derived = derivePattoolCal(snaps());
    expect(derived).toBeTruthy();
    expect(derived!.family).toBe('quat');
    expect(derived!.conjugateQuat).toBeFalse();
    expect(derived!.cameraMinusZ).toBeTrue();
    expect(derived!.elSign).toBe(1);
    expect(derived!.meanErrDeg).toBeLessThan(20);
  });
});

describe('uprightRollDeg', () => {
  it('keeps a normal bank unchanged', () => {
    expect(uprightRollDeg(12)).toBeCloseTo(12, 5);
    expect(uprightRollDeg(-25)).toBeCloseTo(-25, 5);
  });

  it('folds the zenith 180° flip back to a small roll', () => {
    expect(uprightRollDeg(176.7)).toBeCloseTo(-3.3, 5);
    expect(uprightRollDeg(-177)).toBeCloseTo(3, 5);
  });
});

describe('projectCelestialToScreen', () => {
  it('places a matching target at the center', () => {
    const p = projectCelestialToScreen(40, 30, 0, 40, 30);
    expect(p.inView).toBeTrue();
    expect(p.centered).toBeTrue();
    expect(p.xPct).toBeCloseTo(50, 0);
    expect(p.yPct).toBeCloseTo(50, 0);
  });

  it('puts the object below the reticle when the camera points above it', () => {
    const p = projectCelestialToScreen(40, 45, 0, 40, 30);
    expect(p.inView).toBeTrue();
    expect(p.yPct).toBeGreaterThan(58);
    expect(p.xPct).toBeCloseTo(50, 0);
  });

  it('puts the object above the reticle when the camera points below it', () => {
    const p = projectCelestialToScreen(40, 15, 0, 40, 30);
    expect(p.inView).toBeTrue();
    expect(p.yPct).toBeLessThan(42);
  });

  it('does not invert up/down when the raw sky roll is ~180°', () => {
    const p = projectCelestialToScreen(40, 45, 176.7, 40, 30);
    expect(p.yPct).toBeGreaterThan(58);
  });

  it('hides a target behind the camera', () => {
    const p = projectCelestialToScreen(0, 20, 0, 180, 20);
    expect(p.inView).toBeFalse();
    expect(p.inFront).toBeFalse();
  });
});

describe('computeFinderTurnGuide', () => {
  it('asks to turn right and tilt up when the target is off-screen that way', () => {
    const g = computeFinderTurnGuide(0, 10, 40, 35, null);
    expect(g).toBeTruthy();
    expect(g!.right).toBeTrue();
    expect(g!.left).toBeFalse();
    expect(g!.up).toBeTrue();
    expect(g!.down).toBeFalse();
    expect(g!.ok).toBeFalse();
    expect(g!.yawDeg).toBe(40);
    expect(g!.pitchDeg).toBe(25);
  });

  it('uses screen position when the object is in view', () => {
    const proj = projectCelestialToScreen(0, 20, 0, 12, 8);
    expect(proj.inView).toBeTrue();
    const g = computeFinderTurnGuide(0, 20, 12, 8, proj);
    expect(g!.right).toBeTrue();
    expect(g!.down).toBeTrue();
  });

  it('is ok when the object is centered', () => {
    const proj = projectCelestialToScreen(40, 30, 0, 40, 30);
    const g = computeFinderTurnGuide(40, 30, 40, 30, proj);
    expect(g!.ok).toBeTrue();
    expect(g!.left || g!.right || g!.up || g!.down).toBeFalse();
  });
});

describe('sightingOffsetsFromLook', () => {
  it('zeros the residual so published look matches the target', () => {
    const off = sightingOffsetsFromLook(80, 20, 95, 28, 5);
    expect(off.azOffsetDeg).toBe(10);
    expect(off.elOffsetDeg).toBe(8);
  });
});
