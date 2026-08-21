import {
  attitudeFromLookAndTop,
  cameraFromEarthToDeviceQuat,
  cameraElevationFromBetaGamma,
  cameraElevationFromGravity,
  circularDiff,
  circularMeanDeg,
  computeFinderTurnGuide,
  displayedCameraFovDeg,
  GyroMagComplementary,
  projectCelestialToScreen,
  uprightRollDeg,
  wrapSignedDeg,
  type CameraAttitude
} from './direction-attitude';
import {
  MANUAL_AZ_OFFSET_KEY,
  PATTOOL_CAL_KEY,
  canonicalizeLookCal,
  composeLookAzimuth,
  composeLookElevation,
  derivePattoolCal,
  derivePattoolCalMixed,
  patchLookOffsets,
  persistPattoolCalFromSamples,
  sightingOffsetsFromLook,
  snapshotFromPayload,
  snapshotsFromExport,
  usableCalSeries,
  type PattoolCalDerived,
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
    expect(derived!.elSource).toBe('attitude');
  });

  it('ignores a ground pose still aimed at the sky so elSign stays +1', () => {
    const cardinalSky = [SAMPLES[10], SAMPLES[11], SAMPLES[12], SAMPLES[13], SAMPLES[14]];
    const samples = [
      ...cardinalSky.map((s) => snapshotFromPayload(s)),
      snapshotFromPayload({
        poseId: 'ground',
        expectedAz: null,
        expectedEl: -90,
        quat: SAMPLES[14].quat,
        accel: { x: -0.15, y: -0.11, z: -9.8 }
      })
    ];
    const derived = derivePattoolCal(samples);
    expect(derived).toBeTruthy();
    expect(derived!.elSign).toBe(1);
  });

  it('prefers gravity elevation when accel matches the poses', () => {
    const samples = snaps().map((s) =>
      snapshotFromPayload({
        poseId: s.poseId,
        expectedAz: s.expectedAz,
        expectedEl: s.expectedEl,
        quat: s.quat,
        accel:
          s.poseId === 'sky'
            ? { x: 0, y: 0, z: -9.81 }
            : s.poseId === 'ground'
              ? { x: 0, y: 0, z: 9.81 }
              : { x: 0, y: 9.81, z: 0 }
      })
    );
    const derived = derivePattoolCal(samples);
    expect(derived!.elSource).toBe('gravity');
    expect(Math.abs(derived!.elOffsetDeg ?? 0)).toBeLessThan(5);
  });
});

describe('snapshotsFromExport', () => {
  it('keeps every session from the file', () => {
    const main = snaps().map((s) =>
      snapshotFromPayload({
        sessionId: 'sess-big',
        poseId: s.poseId,
        expectedAz: s.expectedAz,
        expectedEl: s.expectedEl,
        quat: s.quat
      })
    );
    const stray = snapshotFromPayload({
      sessionId: 'sess-tiny',
      poseId: 'n',
      expectedAz: 0,
      expectedEl: 0,
      quat: SAMPLES[0].quat
    });
    const out = snapshotsFromExport({ samples: [...main, stray] });
    expect(out.length).toBe(main.length + 1);
    expect(out.filter((s) => s.sessionId === 'sess-tiny').length).toBe(1);
  });
});

describe('derivePattoolCalMixed', () => {
  const seriesA = SAMPLES.slice(4, 10).map((s) =>
    snapshotFromPayload({
      ...s,
      sessionId: 'a',
      capturedAt: '2026-08-14T10:00:00.000Z'
    })
  );
  const seriesB = SAMPLES.slice(10, 16).map((s) =>
    snapshotFromPayload({
      ...s,
      sessionId: 'b',
      capturedAt: '2026-08-14T12:00:00.000Z'
    })
  );
  const stray = snapshotFromPayload({
    sessionId: 'c',
    poseId: 'n',
    expectedAz: 0,
    expectedEl: 0,
    quat: SAMPLES[0].quat,
    capturedAt: '2026-08-14T13:00:00.000Z'
  });

  it('counts two usable series and ignores a stray pose', () => {
    expect(usableCalSeries([...seriesA, ...seriesB, stray]).length).toBe(2);
  });

  it('uses the later series in latest mode', () => {
    const last = derivePattoolCal(seriesB)!;
    const mixed = derivePattoolCalMixed([...seriesA, ...seriesB, stray], 'latest')!;
    expect(mixed.azOffsetDeg).toBe(last.azOffsetDeg);
    expect(mixed.elSign).toBe(last.elSign);
  });

  it('averages azimuth offsets of the usable series', () => {
    const a = derivePattoolCal(seriesA)!;
    const b = derivePattoolCal(seriesB)!;
    const mixed = derivePattoolCalMixed([...seriesA, ...seriesB, stray], 'average')!;
    const expectAvg = Math.round(wrapSignedDeg(circularMeanDeg([a.azOffsetDeg, b.azOffsetDeg])));
    expect(mixed.azOffsetDeg).toBe(expectAvg);
  });
});

function dummyAtt(azimuthDeg: number, elevationDeg = 0): CameraAttitude {
  return {
    azimuthDeg,
    elevationDeg,
    rollDeg: 0,
    lookEast: 0,
    lookNorth: 1,
    lookUp: 0
  };
}

describe('attitudeFromLookAndTop pitch (flat → vertical)', () => {
  const rightEast = { x: 1, y: 0, z: 0 };

  function pitch(lookSign: 1 | -1, thetaDeg: number) {
    const t = (thetaDeg * Math.PI) / 180;
    const top = { x: 0, y: Math.cos(t), z: Math.sin(t) };
    const zScreen = { x: 0, y: -Math.sin(t), z: Math.cos(t) };
    const look = {
      x: lookSign * zScreen.x,
      y: lookSign * zScreen.y,
      z: lookSign * zScreen.z
    };
    return attitudeFromLookAndTop(look, top, rightEast);
  }

  it('keeps North while pitching with rear camera −Z', () => {
    for (const theta of [0, 7, 8, 15, 30, 45, 60, 75, 82, 83, 90]) {
      const a = pitch(-1, theta)!;
      expect(Math.abs(circularDiff(a.azimuthDeg, 0)))
        .withContext(`θ=${theta}`)
        .toBeLessThan(8);
    }
  });

  it('keeps North while pitching even if look is +Z (screen), the astro-compass bug', () => {
    for (const theta of [0, 7, 8, 15, 30, 45, 60, 75, 82, 83, 90]) {
      const a = pitch(1, theta)!;
      expect(Math.abs(circularDiff(a.azimuthDeg, 0)))
        .withContext(`θ=${theta}`)
        .toBeLessThan(8);
    }
  });

  it('does not flip North→South ~8° before vertical when top horizontal is noisy', () => {
    const t = (82 * Math.PI) / 180;
    const look = { x: 0, y: Math.sin(t), z: -Math.cos(t) };
    const topNoisy = { x: 0.02, y: -0.12, z: Math.sin(t) };
    const a = attitudeFromLookAndTop(look, topNoisy, rightEast)!;
    expect(Math.abs(circularDiff(a.azimuthDeg, 0))).toBeLessThan(8);
  });
});

describe('GyroMagComplementary', () => {
  const up = { x: 0, y: 9.81, z: 0 };
  const gyro = { x: 0, y: 0, z: 0 };

  it('relocks to magnetometer North after an OS quaternion drift', () => {
    const fusion = new GyroMagComplementary();
    const mag = dummyAtt(0);
    let t = 1_000;
    expect(fusion.tick(gyro, up, mag, dummyAtt(0), t).azimuthDeg).toBeCloseTo(0, 0);
    t += 20;
    fusion.tick(gyro, up, mag, dummyAtt(35), t);
    let az = 35;
    for (let i = 0; i < 4; i++) {
      t += 80;
      az = fusion.tick(gyro, up, mag, dummyAtt(35), t).azimuthDeg;
    }
    expect(az).toBeCloseTo(0, 0);
  });
});

describe('cameraElevationFromGravity / beta', () => {
  it('is nadir when the screen faces the sky', () => {
    expect(cameraElevationFromGravity({ x: 0, y: 0, z: 9.81 })).toBeCloseTo(-90, 0);
    expect(cameraElevationFromBetaGamma(0, 0)).toBeCloseTo(-90, 0);
  });

  it('is horizon when the phone is upright', () => {
    expect(cameraElevationFromGravity({ x: 0, y: 9.81, z: 0 })).toBeCloseTo(0, 0);
    expect(cameraElevationFromBetaGamma(90, 0)).toBeCloseTo(0, 0);
  });

  it('is zenith when the rear camera faces the sky', () => {
    expect(cameraElevationFromGravity({ x: 0, y: 0, z: -9.81 })).toBeCloseTo(90, 0);
    expect(cameraElevationFromBetaGamma(180, 0)).toBeCloseTo(90, 0);
  });

  it('rises when tilting from the horizon toward the zenith', () => {
    const horizon = cameraElevationFromBetaGamma(90, 0);
    const towardSky = cameraElevationFromBetaGamma(135, 0);
    expect(horizon).toBeCloseTo(0, 0);
    expect(towardSky).toBeCloseTo(45, 0);
    expect(towardSky).toBeGreaterThan(horizon + 20);
  });

  it('drops from zenith to 45° when beta wraps past ±180 (the finder jump)', () => {
    expect(cameraElevationFromBetaGamma(180, 0)).toBeCloseTo(90, 0);
    expect(cameraElevationFromBetaGamma(-135, 0)).toBeCloseTo(45, 0);
  });
});

describe('patricou 2026-08-15 capture', () => {
  it('reads the horizon from gravity on the North pose', () => {
    expect(cameraElevationFromGravity({ x: -0.275, y: 9.721, z: -1.037 })).toBeCloseTo(6, 0);
  });

  it('reads about 43° on the 45° tilt pose', () => {
    expect(cameraElevationFromGravity({ x: -0.138, y: 7.209, z: -6.621 })).toBeCloseTo(43, 0);
  });

  it('agrees with gravity on the averaged zenith quaternion', () => {
    expect(cameraElevationFromGravity({ x: -0.285, y: -0.374, z: -9.796 })).toBeGreaterThan(85);
    const att = cameraFromEarthToDeviceQuat({
      x: -0.5763392382602275,
      y: 0.8169783651513143,
      z: 0.010545444602493924,
      w: 0.016377634580194124
    });
    expect(att).toBeTruthy();
    expect(att!.elevationDeg).toBeGreaterThan(85);
  });

  it('shows the live HUD lagged at 77° while gravity was already ~87°', () => {
    const liveEl =
      (Math.atan2(0.9757316013270391, Math.hypot(0.16329343420647446, -0.14588727332028906)) * 180) /
      Math.PI;
    expect(liveEl).toBeCloseTo(77, 0);
  });

  it('detects the Ground pose was still aimed at the sky', () => {
    const g = cameraElevationFromGravity({ x: -0.15, y: -0.11, z: -9.8 });
    expect(g).toBeGreaterThan(80);
    expect(Math.abs((g ?? 0) - -90)).toBeGreaterThan(35);
  });
});

describe('displayedCameraFovDeg', () => {
  it('uses the short side of a landscape stream as portrait VFOV after cover crop', () => {
    const fov = displayedCameraFovDeg(1280, 720, 360, 640);
    expect(fov.vfov).toBeLessThan(45);
    expect(fov.vfov).toBeGreaterThan(32);
    expect(fov.hfov).toBeLessThan(fov.vfov);
  });

  it('uses the sensor wide axis as VFOV when the video is already portrait', () => {
    const fov = displayedCameraFovDeg(720, 1280, 360, 640);
    expect(fov.vfov).toBeCloseTo(64, 0);
    expect(fov.hfov).toBeLessThan(45);
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

  it('moves further below the reticle when the displayed VFOV is the 16:9 short side', () => {
    const wide = projectCelestialToScreen(40, 58, 0, 40, 43, 38, 64);
    const cover = projectCelestialToScreen(40, 58, 0, 40, 43, 22, 39);
    expect(cover.yPct).toBeGreaterThan(wide.yPct + 8);
    expect(cover.yPct).toBeGreaterThan(68);
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

const LOOK_CAL: PattoolCalDerived = {
  family: 'quat',
  conjugateQuat: false,
  cameraMinusZ: true,
  azOffsetDeg: 20,
  elSign: 1,
  meanErrDeg: 0,
  elSource: 'gravity',
  elOffsetDeg: 5
};

describe('composeLookAzimuth / composeLookElevation', () => {
  it('wraps past 360 with a single offset', () => {
    expect(composeLookAzimuth(350, LOOK_CAL)).toBe(10);
    expect(composeLookElevation(12, LOOK_CAL)).toBe(17);
  });

  it('does not stack a second offset on an already composed heading', () => {
    const published = composeLookAzimuth(350, LOOK_CAL);
    expect(composeLookAzimuth(published, { ...LOOK_CAL, azOffsetDeg: 0 })).toBe(10);
  });
});

describe('canonicalizeLookCal', () => {
  afterEach(() => {
    localStorage.removeItem(PATTOOL_CAL_KEY);
    localStorage.removeItem(MANUAL_AZ_OFFSET_KEY);
    localStorage.removeItem('pat.direction.el-offset.v1');
  });

  it('folds leftover manual Nord into derived when there are no poses', () => {
    localStorage.setItem(MANUAL_AZ_OFFSET_KEY, '15');
    const file = canonicalizeLookCal();
    expect(file?.derived.azOffsetDeg).toBe(15);
    expect(localStorage.getItem(MANUAL_AZ_OFFSET_KEY)).toBeNull();
  });

  it('keeps a Nord/slider patch when poses exist and leftover manuals are gone', () => {
    persistPattoolCalFromSamples(snaps(), 'test-ua');
    patchLookOffsets({ azOffsetDeg: 33 });
    const file = canonicalizeLookCal();
    expect(file?.derived.azOffsetDeg).toBe(33);
  });

  it('drops stacked leftover manual when poses exist', () => {
    const fromPoses = persistPattoolCalFromSamples(snaps(), 'test-ua');
    expect(fromPoses).toBeTruthy();
    localStorage.setItem(MANUAL_AZ_OFFSET_KEY, '25');
    const file = canonicalizeLookCal();
    expect(file?.derived.azOffsetDeg).toBe(fromPoses!.derived.azOffsetDeg);
    expect(localStorage.getItem(MANUAL_AZ_OFFSET_KEY)).toBeNull();
  });
});
