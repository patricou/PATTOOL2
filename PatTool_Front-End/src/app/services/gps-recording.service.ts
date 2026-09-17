import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ApiService, GpsFollowPoint, GpsFollowSession } from './api.service';
import { BackgroundPlaybackService } from './background-playback.service';
import {
  GpsOfflinePoint,
  GpsOfflineSession,
  GpsSessionOfflineStore
} from '../gps-track/gps-session-offline.store';
import {
  cumulativeDistancesM,
  elevationGainLoss,
  GpsTrackPt,
  haversineMeters,
  nearestTrackIndex,
  newClientId
} from '../gps-track/gps-geo.util';
import {
  needsMotionPermissionTap,
  requestMotionPermissionIfNeeded
} from '../shared/device-motion-permission.util';

export type GpsFollowStatus = 'idle' | 'recording' | 'paused' | 'finished';

export interface GpsUserFix {
  lat: number;
  lon: number;
  eleM: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  slopePct: number | null;
  slopeDeg: number | null;
  timeMs: number;
}

export interface GpsLiveSnapshot {
  status: GpsFollowStatus;
  online: boolean;
  syncing: boolean;
  pendingSync: number;
  lastSyncError: string | null;
  title: string;
  clientSessionId: string | null;
  mongoId: string | null;
  sourceFileId: string | null;
  sourceFileName: string | null;
  track: GpsTrackPt[];
  recorded: GpsTrackPt[];
  user: GpsUserFix | null;
  nearestIndex: number;
  doneM: number;
  remainingM: number | null;
  plannedDistanceM: number | null;
  plannedAscentM: number | null;
  plannedDescentM: number | null;
  ascentDoneM: number;
  descentDoneM: number;
  durationSec: number;
  altitudeSource: 'gps' | 'baro' | 'none';
  /** Phone pitch relative to the calibrated zero (0° = that pose, 90° = vertical). */
  inclineDeg: number | null;
  inclinePct: number | null;
  inclineNeedsPermission: boolean;
  inclineDenied: boolean;
  /** True after the user sets the current phone pose as 0°. */
  inclineCalibrated: boolean;
  /** Raw pitch (flat = 0°) stored as the user's zero. */
  inclineZeroOffsetDeg: number;
}

const EMPTY: GpsLiveSnapshot = {
  status: 'idle',
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pendingSync: 0,
  lastSyncError: null,
  title: '',
  clientSessionId: null,
  mongoId: null,
  sourceFileId: null,
  sourceFileName: null,
  track: [],
  recorded: [],
  user: null,
  nearestIndex: 0,
  doneM: 0,
  remainingM: null,
  plannedDistanceM: null,
  plannedAscentM: null,
  plannedDescentM: null,
  ascentDoneM: 0,
  descentDoneM: 0,
  durationSec: 0,
  altitudeSource: 'none',
  inclineDeg: null,
  inclinePct: null,
  inclineNeedsPermission: false,
  inclineDenied: false,
  inclineCalibrated: false,
  inclineZeroOffsetDeg: 0
};

const INCLINE_CAL_KEY = 'pat.gps.inclineZero.v1';

function wrapSignedDeg(d: number): number {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}

/** Tiny looping silent WAV to keep the mobile tab alive in the background. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

@Injectable({ providedIn: 'root' })
export class GpsRecordingService implements OnDestroy {
  readonly snapshot$ = new BehaviorSubject<GpsLiveSnapshot>({ ...EMPTY });

  private readonly store = new GpsSessionOfflineStore();
  private watchId: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private keepAlive: HTMLAudioElement | null = null;
  private baroSensor: { stop?: () => void } | null = null;
  private baroAltitudeM: number | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private restoring = false;
  private unsynced: GpsFollowPoint[] = [];
  private recordedPoints: GpsTrackPt[] = [];
  private lastRecorded: GpsTrackPt | null = null;
  private lastRecordedAt = 0;
  private lastFixAt = 0;
  private movingSinceMs: number | null = null;
  private pausedAccumSec = 0;
  private resumeStartsNewSegment = false;
  private slopeWindow: Array<{ lat: number; lon: number; ele: number; t: number }> = [];
  private cumDist: number[] = [];
  private orientationListening = false;
  private inclineSmoothed: number | null = null;
  private inclineZeroOffsetDeg = 0;
  private inclineCalibrated = false;
  private pendingInclineCalibrate = false;
  private lastInclinePatchAt = 0;
  private lastInclineShownDeg: number | null = null;
  private readonly onOrientation = (e: DeviceOrientationEvent): void => {
    this.ngZone.run(() => this.handleOrientation(e));
  };
  private readonly onOnline = (): void => {
    this.patch({ online: true });
    void this.flushSync();
  };
  private readonly onOffline = (): void => this.patch({ online: false });
  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible' && this.snapshot$.value.status === 'recording') {
      void this.requestWakeLock();
      this.ensureKeepAliveAudio();
      void this.flushSync();
    }
  };

  constructor(
    private readonly api: ApiService,
    private readonly ngZone: NgZone,
    private readonly backgroundPlayback: BackgroundPlaybackService
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
      document.addEventListener('visibilitychange', this.onVisible);
    }
    this.loadInclineCal();
    void this.restoreFromIndexedDb();
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    this.teardownWatch();
    this.stopKeepAliveAudio();
    void this.releaseWakeLock();
    this.stopBaro();
    this.stopOrientation();
    this.clearTimers();
  }

  get snapshot(): GpsLiveSnapshot {
    return this.snapshot$.value;
  }

  setTrack(opts: {
    points: GpsTrackPt[];
    title?: string;
    sourceType?: 'import' | 'file' | 'session';
    sourceFileId?: string | null;
    sourceFileName?: string | null;
    plannedAscentM?: number | null;
    plannedDescentM?: number | null;
    resetRecording?: boolean;
  }): void {
    const points = (opts.points || []).filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
    );
    this.cumDist = cumulativeDistancesM(points);
    const plannedDistanceM = this.cumDist.length ? this.cumDist[this.cumDist.length - 1] : null;
    const elev = elevationGainLoss(points);
    const reset = opts.resetRecording !== false;
    if (reset) {
      this.recordedPoints = [];
      this.lastRecorded = null;
      this.lastRecordedAt = 0;
      this.unsynced = [];
      this.pausedAccumSec = 0;
      this.movingSinceMs = null;
      this.slopeWindow = [];
    }
    const clientSessionId = reset || !this.snapshot.clientSessionId
      ? newClientId()
      : this.snapshot.clientSessionId;
    this.patch({
      status: reset ? 'idle' : this.snapshot.status,
      title: (opts.title || opts.sourceFileName || 'GPS').trim(),
      clientSessionId,
      mongoId: reset ? null : this.snapshot.mongoId,
      sourceFileId: opts.sourceFileId || null,
      sourceFileName: opts.sourceFileName || null,
      track: points,
      recorded: reset ? [] : this.recordedPoints.slice(),
      plannedDistanceM,
      plannedAscentM: opts.plannedAscentM ?? (elev.gainM || null),
      plannedDescentM: opts.plannedDescentM ?? (elev.lossM || null),
      doneM: 0,
      remainingM: plannedDistanceM,
      ascentDoneM: reset ? 0 : this.snapshot.ascentDoneM,
      descentDoneM: reset ? 0 : this.snapshot.descentDoneM,
      durationSec: reset ? 0 : this.snapshot.durationSec,
      nearestIndex: 0
    });
    void this.persistSession();
    void this.flushSync();
  }

  loadRemoteSession(session: GpsFollowSession): void {
    const points: GpsTrackPt[] = (session.plannedTrack || []).map((c) => ({
      lat: c[0],
      lon: c[1],
      eleM: c.length >= 3 && Number.isFinite(c[2]) ? c[2] : null
    }));
    const recorded: GpsTrackPt[] = (session.recordedPoints || []).map((p) => ({
      lat: p.lat,
      lon: p.lon,
      eleM: p.eleM ?? null,
      gapBefore: p.gapBefore === true
    }));
    this.recordedPoints = recorded;
    this.lastRecorded = recorded.length ? recorded[recorded.length - 1] : null;
    this.lastRecordedAt = 0;
    this.unsynced = [];
    this.cumDist = cumulativeDistancesM(points);
    const status = session.status === 'recording' ? 'paused' : (session.status || 'idle');
    this.pausedAccumSec = session.durationSec || 0;
    this.movingSinceMs = null;
    this.resumeStartsNewSegment = status === 'paused';
    this.patch({
      status,
      title: session.title || 'GPS',
      clientSessionId: session.clientSessionId,
      mongoId: session.id || null,
      sourceFileId: session.sourceFileId || null,
      sourceFileName: session.sourceFileName || null,
      track: points,
      recorded: recorded.slice(),
      plannedDistanceM: session.plannedDistanceM ?? (this.cumDist.at(-1) ?? null),
      plannedAscentM: session.plannedAscentM ?? null,
      plannedDescentM: session.plannedDescentM ?? null,
      doneM: session.doneM || 0,
      remainingM: session.remainingM ?? null,
      ascentDoneM: session.ascentDoneM || 0,
      descentDoneM: session.descentDoneM || 0,
      durationSec: session.durationSec || 0,
      nearestIndex: 0
    });
    void this.persistSession();
  }

  clearTrack(): void {
    this.stopRecording(true);
    this.recordedPoints = [];
    this.lastRecorded = null;
    this.unsynced = [];
    this.cumDist = [];
    this.patch({
      ...EMPTY,
      online: navigator.onLine,
      user: this.snapshot.user,
      inclineDeg: this.snapshot.inclineDeg,
      inclinePct: this.snapshot.inclinePct,
      inclineNeedsPermission: this.snapshot.inclineNeedsPermission,
      inclineDenied: this.snapshot.inclineDenied,
      inclineCalibrated: this.inclineCalibrated,
      inclineZeroOffsetDeg: this.inclineZeroOffsetDeg
    });
  }

  /** Current phone pose becomes 0°. Call from a tap so iOS can unlock the sensor. */
  async calibrateInclineZero(): Promise<void> {
    await this.enableInclineFromUserGesture();
    if (this.inclineSmoothed != null && Number.isFinite(this.inclineSmoothed)) {
      this.applyInclineZero(this.inclineSmoothed);
      return;
    }
    this.pendingInclineCalibrate = true;
  }

  resetInclineCalibration(): void {
    this.pendingInclineCalibrate = false;
    this.inclineZeroOffsetDeg = 0;
    this.inclineCalibrated = false;
    this.lastInclineShownDeg = null;
    this.persistInclineCal();
    this.publishInclineFromSmoothed();
  }

  ensureLocationWatch(): void {
    this.startGeolocation();
    this.startBaro();
    if (this.orientationListening || this.snapshot.inclineDenied) {
      return;
    }
    if (needsMotionPermissionTap()) {
      this.patch({ inclineNeedsPermission: true });
    } else {
      this.startOrientation();
    }
  }

  stopLocationWatchIfIdle(): void {
    const st = this.snapshot.status;
    if (st === 'recording' || st === 'paused') {
      return;
    }
    this.teardownWatch();
    this.stopBaro();
    this.stopOrientation();
  }

  /** Call from a tap (Start / dedicated button) so iOS can unlock DeviceOrientation. */
  async enableInclineFromUserGesture(): Promise<void> {
    if (needsMotionPermissionTap()) {
      const result = await requestMotionPermissionIfNeeded();
      if (result === 'denied') {
        this.patch({ inclineDenied: true, inclineNeedsPermission: false });
        return;
      }
      this.patch({ inclineDenied: false, inclineNeedsPermission: false });
    }
    this.startOrientation();
  }

  async startRecording(): Promise<void> {
    if (!this.snapshot.clientSessionId) {
      this.patch({ clientSessionId: newClientId() });
    }
    if (this.snapshot.status !== 'paused') {
      this.pausedAccumSec = this.snapshot.durationSec || 0;
    }
    this.movingSinceMs = Date.now();
    this.patch({ status: 'recording', lastSyncError: null });
    await this.enableInclineFromUserGesture();
    this.ensureLocationWatch();
    this.ensureKeepAliveAudio();
    await this.requestWakeLock();
    this.startTimers();
    await this.persistSession();
    void this.flushSync();
  }

  async pauseRecording(): Promise<void> {
    if (this.snapshot.status !== 'recording') {
      return;
    }
    this.pausedAccumSec = this.currentDurationSec();
    this.movingSinceMs = null;
    this.resumeStartsNewSegment = true;
    this.patch({ status: 'paused', durationSec: this.pausedAccumSec });
    this.clearTimers();
    this.stopKeepAliveAudio();
    void this.releaseWakeLock();
    await this.persistSession();
    void this.flushSync();
  }

  async stopRecording(silent = false): Promise<void> {
    const wasActive = this.snapshot.status === 'recording' || this.snapshot.status === 'paused';
    this.pausedAccumSec = this.currentDurationSec();
    this.movingSinceMs = null;
    this.resumeStartsNewSegment = false;
    this.patch({
      status: wasActive ? 'finished' : this.snapshot.status,
      durationSec: this.pausedAccumSec
    });
    this.clearTimers();
    this.stopKeepAliveAudio();
    void this.releaseWakeLock();
    if (!silent) {
      await this.persistSession();
      await this.flushSync();
    }
  }

  isBusy(): boolean {
    const st = this.snapshot.status;
    return st === 'recording' || st === 'paused';
  }

  private async restoreFromIndexedDb(): Promise<void> {
    this.restoring = true;
    try {
      const { session, points } = await this.store.loadActive();
      if (!session) {
        return;
      }
      this.recordedPoints = points.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        eleM: p.eleM ?? null,
        gapBefore: p.gapBefore === true
      }));
      this.lastRecorded = this.recordedPoints.at(-1) || null;
      this.lastRecordedAt = points.at(-1)?.timeMs || 0;
      this.unsynced = this.store.unsyncedFrom(points);
      this.cumDist = cumulativeDistancesM(session.plannedTrack || []);
      const status: GpsFollowStatus = session.status === 'recording' ? 'paused' : session.status;
      this.pausedAccumSec = session.durationSec || 0;
      this.resumeStartsNewSegment = status === 'paused';
      this.patch({
        status,
        title: session.title,
        clientSessionId: session.clientSessionId,
        mongoId: session.mongoId || null,
        sourceFileId: session.sourceFileId || null,
        sourceFileName: session.sourceFileName || null,
        track: session.plannedTrack || [],
        recorded: this.recordedPoints.slice(),
        plannedDistanceM: session.plannedDistanceM,
        plannedAscentM: session.plannedAscentM,
        plannedDescentM: session.plannedDescentM,
        doneM: session.doneM || 0,
        remainingM: session.remainingM,
        ascentDoneM: session.ascentDoneM || 0,
        descentDoneM: session.descentDoneM || 0,
        durationSec: session.durationSec || 0,
        pendingSync: this.unsynced.length
      });
      if (this.unsynced.length && navigator.onLine) {
        void this.flushSync();
      }
    } finally {
      this.restoring = false;
    }
  }

  private startGeolocation(): void {
    if (this.watchId != null || typeof navigator === 'undefined' || !navigator.geolocation) {
      return;
    }
    this.ngZone.runOutsideAngular(() => {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.ngZone.run(() => this.onPosition(pos)),
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
      );
    });
  }

  private teardownWatch(): void {
    if (this.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private startBaro(): void {
    if (this.baroSensor || typeof window === 'undefined') {
      return;
    }
    const Ctor = (window as unknown as { AbsoluteAltitudeSensor?: new (opts: { frequency: number }) => {
      start: () => void;
      stop: () => void;
      altitude?: number;
      addEventListener: (type: string, fn: () => void) => void;
    } }).AbsoluteAltitudeSensor;
    if (!Ctor) {
      return;
    }
    try {
      const sensor = new Ctor({ frequency: 2 });
      sensor.addEventListener('reading', () => {
        const alt = sensor.altitude;
        if (typeof alt === 'number' && Number.isFinite(alt)) {
          this.baroAltitudeM = alt;
        }
      });
      sensor.start();
      this.baroSensor = sensor;
    } catch {
      this.baroSensor = null;
    }
  }

  private stopBaro(): void {
    try {
      this.baroSensor?.stop?.();
    } catch {
      /* ignore */
    }
    this.baroSensor = null;
  }

  private startOrientation(): void {
    if (this.orientationListening || typeof window === 'undefined') {
      return;
    }
    if (!('DeviceOrientationEvent' in window)) {
      return;
    }
    this.orientationListening = true;
    window.addEventListener('deviceorientation', this.onOrientation, true);
    window.addEventListener('deviceorientationabsolute', this.onOrientation, true);
  }

  private stopOrientation(): void {
    if (!this.orientationListening || typeof window === 'undefined') {
      return;
    }
    window.removeEventListener('deviceorientation', this.onOrientation, true);
    window.removeEventListener('deviceorientationabsolute', this.onOrientation, true);
    this.orientationListening = false;
  }

  /**
   * Pitch from horizontal: 0° = flat (screen up), 90° = upright.
   * Same convention as the Nord / astro-compass inclinometer.
   */
  private devicePitchFromBetaGamma(betaDeg: number, gammaDeg: number): number {
    const b = (betaDeg * Math.PI) / 180;
    const g = (gammaDeg * Math.PI) / 180;
    const yUp = Math.sin(b);
    const zUp = Math.cos(b) * Math.cos(g);
    return (Math.atan2(yUp, zUp) * 180) / Math.PI;
  }

  private handleOrientation(e: DeviceOrientationEvent): void {
    const beta = Number.isFinite(e.beta as number) ? (e.beta as number) : null;
    const gamma = Number.isFinite(e.gamma as number) ? (e.gamma as number) : 0;
    if (beta == null) {
      return;
    }
    const raw = this.devicePitchFromBetaGamma(beta, gamma);
    if (!Number.isFinite(raw)) {
      return;
    }
    const a = 0.22;
    this.inclineSmoothed =
      this.inclineSmoothed == null ? raw : this.inclineSmoothed * (1 - a) + raw * a;
    if (this.pendingInclineCalibrate) {
      this.pendingInclineCalibrate = false;
      this.applyInclineZero(this.inclineSmoothed);
      return;
    }
    this.publishInclineFromSmoothed();
  }

  private applyInclineZero(rawDeg: number): void {
    this.inclineZeroOffsetDeg = rawDeg;
    this.inclineCalibrated = true;
    this.persistInclineCal();
    this.lastInclineShownDeg = null;
    this.publishInclineFromSmoothed();
  }

  private publishInclineFromSmoothed(): void {
    if (this.inclineSmoothed == null || !Number.isFinite(this.inclineSmoothed)) {
      this.patch({
        inclineCalibrated: this.inclineCalibrated,
        inclineZeroOffsetDeg: this.inclineZeroOffsetDeg
      });
      return;
    }
    const deg = wrapSignedDeg(this.inclineSmoothed - this.inclineZeroOffsetDeg);
    const rad = (deg * Math.PI) / 180;
    let pct = Math.tan(rad) * 100;
    if (!Number.isFinite(pct) || Math.abs(pct) > 800) {
      pct = deg >= 0 ? 800 : -800;
    }
    const shown = Math.round(deg * 10) / 10;
    const now = Date.now();
    if (
      this.lastInclineShownDeg != null &&
      Math.abs(shown - this.lastInclineShownDeg) < 0.15 &&
      now - this.lastInclinePatchAt < 180
    ) {
      return;
    }
    this.lastInclineShownDeg = shown;
    this.lastInclinePatchAt = now;
    this.patch({
      inclineDeg: deg,
      inclinePct: pct,
      inclineNeedsPermission: false,
      inclineDenied: false,
      inclineCalibrated: this.inclineCalibrated,
      inclineZeroOffsetDeg: this.inclineZeroOffsetDeg
    });
  }

  private loadInclineCal(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      const raw = localStorage.getItem(INCLINE_CAL_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as { offsetDeg?: number; calibrated?: boolean };
      if (typeof parsed.offsetDeg === 'number' && Number.isFinite(parsed.offsetDeg) && parsed.calibrated) {
        this.inclineZeroOffsetDeg = parsed.offsetDeg;
        this.inclineCalibrated = true;
        this.patch({
          inclineCalibrated: true,
          inclineZeroOffsetDeg: this.inclineZeroOffsetDeg
        });
      }
    } catch {
      /* ignore */
    }
  }

  private persistInclineCal(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      if (!this.inclineCalibrated) {
        localStorage.removeItem(INCLINE_CAL_KEY);
        return;
      }
      localStorage.setItem(
        INCLINE_CAL_KEY,
        JSON.stringify({ offsetDeg: this.inclineZeroOffsetDeg, calibrated: true })
      );
    } catch {
      /* ignore */
    }
  }

  private onPosition(pos: GeolocationPosition): void {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const gpsEle = pos.coords.altitude != null && Number.isFinite(pos.coords.altitude)
      ? pos.coords.altitude
      : null;
    const baro = this.baroAltitudeM;
    const eleM = baro != null ? baro : gpsEle;
    const altitudeSource: GpsLiveSnapshot['altitudeSource'] =
      baro != null ? 'baro' : gpsEle != null ? 'gps' : 'none';
    const speedKmh = pos.coords.speed != null && pos.coords.speed >= 0
      ? pos.coords.speed * 3.6
      : this.estimateSpeedKmh(lat, lon, pos.timestamp);
    const headingDeg = pos.coords.heading != null && Number.isFinite(pos.coords.heading)
      ? pos.coords.heading
      : null;
    const accuracyM = pos.coords.accuracy != null && Number.isFinite(pos.coords.accuracy)
      ? pos.coords.accuracy
      : null;
    const slope = this.updateSlope(lat, lon, eleM, pos.timestamp);
    const user: GpsUserFix = {
      lat,
      lon,
      eleM,
      speedKmh,
      headingDeg,
      accuracyM,
      slopePct: slope.pct,
      slopeDeg: slope.deg,
      timeMs: pos.timestamp
    };
    this.lastFixAt = pos.timestamp;
    const snap = this.applyProgress(user);
    this.patch({
      user,
      altitudeSource,
      nearestIndex: snap.nearestIndex,
      doneM: snap.doneM,
      remainingM: snap.remainingM,
      ascentDoneM: snap.ascentDoneM,
      descentDoneM: snap.descentDoneM,
      recorded: this.recordedPoints.slice()
    });

    if (this.snapshot.status === 'recording') {
      this.appendRecordedPoint(user);
    }
  }

  private estimateSpeedKmh(lat: number, lon: number, t: number): number | null {
    const prev = this.snapshot.user;
    if (!prev || !t || !this.lastFixAt || t <= this.lastFixAt) {
      return prev?.speedKmh ?? null;
    }
    const dt = (t - this.lastFixAt) / 1000;
    if (dt < 0.4 || dt > 15) {
      return prev.speedKmh;
    }
    const d = haversineMeters(prev.lat, prev.lon, lat, lon);
    return (d / dt) * 3.6;
  }

  private updateSlope(
    lat: number,
    lon: number,
    eleM: number | null,
    t: number
  ): { pct: number | null; deg: number | null } {
    if (eleM == null || !Number.isFinite(eleM)) {
      return { pct: this.snapshot.user?.slopePct ?? null, deg: this.snapshot.user?.slopeDeg ?? null };
    }
    this.slopeWindow.push({ lat, lon, ele: eleM, t });
    while (this.slopeWindow.length > 40) {
      this.slopeWindow.shift();
    }
    const first = this.slopeWindow[0];
    const last = this.slopeWindow[this.slopeWindow.length - 1];
    let dist = 0;
    for (let i = 1; i < this.slopeWindow.length; i++) {
      dist += haversineMeters(
        this.slopeWindow[i - 1].lat,
        this.slopeWindow[i - 1].lon,
        this.slopeWindow[i].lat,
        this.slopeWindow[i].lon
      );
    }
    if (dist < 8) {
      return { pct: this.snapshot.user?.slopePct ?? null, deg: this.snapshot.user?.slopeDeg ?? null };
    }
    const rise = last.ele - first.ele;
    const pct = (rise / dist) * 100;
    const deg = (Math.atan(rise / dist) * 180) / Math.PI;
    return { pct, deg };
  }

  private applyProgress(user: GpsUserFix): {
    nearestIndex: number;
    doneM: number;
    remainingM: number | null;
    ascentDoneM: number;
    descentDoneM: number;
  } {
    const track = this.snapshot.track;
    let nearestIndex = 0;
    let doneM = 0;
    let remainingM: number | null = this.snapshot.plannedDistanceM;
    if (track.length >= 2 && this.cumDist.length) {
      nearestIndex = nearestTrackIndex(track, user.lat, user.lon);
      doneM = this.cumDist[nearestIndex] || 0;
      const total = this.cumDist[this.cumDist.length - 1] || 0;
      remainingM = Math.max(0, total - doneM);
      const along = track.slice(0, nearestIndex + 1);
      const elevTrack = elevationGainLoss(along);
      if (this.recordedPoints.length < 2) {
        return {
          nearestIndex,
          doneM,
          remainingM,
          ascentDoneM: elevTrack.gainM,
          descentDoneM: elevTrack.lossM
        };
      }
    }
    const elevRec = elevationGainLoss(this.recordedPoints);
    if (track.length < 2) {
      doneM = 0;
      for (let i = 1; i < this.recordedPoints.length; i++) {
        if (this.recordedPoints[i].gapBefore) {
          continue;
        }
        doneM += haversineMeters(
          this.recordedPoints[i - 1].lat,
          this.recordedPoints[i - 1].lon,
          this.recordedPoints[i].lat,
          this.recordedPoints[i].lon
        );
      }
      remainingM = null;
    }
    return {
      nearestIndex,
      doneM,
      remainingM,
      ascentDoneM: elevRec.gainM,
      descentDoneM: elevRec.lossM
    };
  }

  private appendRecordedPoint(user: GpsUserFix): void {
    const prev = this.lastRecorded;
    if (prev) {
      const d = haversineMeters(prev.lat, prev.lon, user.lat, user.lon);
      const dt = this.lastRecordedAt ? user.timeMs - this.lastRecordedAt : 9999;
      if (d < 2.5 && dt < 4000) {
        return;
      }
      if (d > 800) {
        /* GPS jump — still store, but do not inflate D+ from a teleport. */
      }
    }
    const clientPointId = newClientId();
    const rec: GpsTrackPt = {
      lat: user.lat,
      lon: user.lon,
      eleM: user.eleM,
      gapBefore: this.resumeStartsNewSegment || undefined
    };
    this.resumeStartsNewSegment = false;
    this.recordedPoints.push(rec);
    this.lastRecorded = rec;
    this.lastRecordedAt = user.timeMs;
    if (this.recordedPoints.length > 25000) {
      this.recordedPoints.splice(0, this.recordedPoints.length - 25000);
    }
    const point: GpsFollowPoint = {
      clientPointId,
      lat: user.lat,
      lon: user.lon,
      eleM: user.eleM,
      timeMs: user.timeMs,
      speedKmh: user.speedKmh,
      accuracyM: user.accuracyM,
      slopePct: user.slopePct,
      gapBefore: rec.gapBefore === true
    };
    this.unsynced.push(point);
    const offline: GpsOfflinePoint = {
      ...point,
      clientPointId,
      clientSessionId: this.snapshot.clientSessionId || '',
      synced: false
    };
    void this.store.addPoints([offline]);
    this.patch({ pendingSync: this.unsynced.length, recorded: this.recordedPoints.slice() });
    if (this.unsynced.length >= 8 && navigator.onLine) {
      void this.flushSync();
    }
  }

  private startTimers(): void {
    this.clearTimers();
    this.durationTimer = setInterval(() => {
      if (this.snapshot.status === 'recording') {
        this.patch({ durationSec: this.currentDurationSec() });
      }
    }, 1000);
    this.syncTimer = setInterval(() => {
      if (navigator.onLine) {
        void this.flushSync();
      }
    }, 12000);
  }

  private clearTimers(): void {
    if (this.durationTimer != null) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.syncTimer != null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private currentDurationSec(): number {
    if (this.snapshot.status !== 'recording' || this.movingSinceMs == null) {
      return this.pausedAccumSec;
    }
    return this.pausedAccumSec + (Date.now() - this.movingSinceMs) / 1000;
  }

  async flushSync(): Promise<void> {
    const snap = this.snapshot;
    if (!snap.clientSessionId || this.restoring || snap.syncing) {
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }
    if (snap.status === 'idle' && !snap.track.length && !this.unsynced.length && !this.recordedPoints.length) {
      return;
    }
    this.patch({ syncing: true, lastSyncError: null });
    const batch = this.unsynced.slice(0, 4000);
    try {
      const body = this.store.toApiSession(this.toOfflineSession(), batch);
      const saved = await new Promise<GpsFollowSession>((resolve, reject) => {
        this.api.syncGpsSession(body).subscribe({ next: resolve, error: reject });
      });
      const ids = batch.map((p) => p.clientPointId).filter((id): id is string => !!id);
      this.unsynced = this.unsynced.filter((p) => !ids.includes(p.clientPointId || ''));
      await this.store.markSynced(ids);
      this.patch({
        mongoId: saved.id || snap.mongoId,
        pendingSync: this.unsynced.length,
        syncing: false,
        lastSyncError: null
      });
      await this.persistSession();
    } catch {
      this.patch({
        syncing: false,
        lastSyncError: 'GPS.SYNC_ERROR',
        pendingSync: this.unsynced.length
      });
    }
  }

  private toOfflineSession(): GpsOfflineSession {
    const s = this.snapshot;
    return {
      clientSessionId: s.clientSessionId || newClientId(),
      mongoId: s.mongoId,
      title: s.title || 'GPS',
      sourceType: s.sourceFileId ? 'file' : 'import',
      sourceFileId: s.sourceFileId,
      sourceFileName: s.sourceFileName,
      status: s.status,
      plannedTrack: s.track,
      plannedDistanceM: s.plannedDistanceM,
      plannedAscentM: s.plannedAscentM,
      plannedDescentM: s.plannedDescentM,
      doneM: s.doneM,
      remainingM: s.remainingM,
      ascentDoneM: s.ascentDoneM,
      descentDoneM: s.descentDoneM,
      durationSec: this.currentDurationSec(),
      startedAtMs: s.status === 'idle' ? null : Date.now() - this.currentDurationSec() * 1000,
      finishedAtMs: s.status === 'finished' ? Date.now() : null,
      updatedAtMs: Date.now()
    };
  }

  private async persistSession(): Promise<void> {
    if (!this.snapshot.clientSessionId) {
      return;
    }
    await this.store.saveSession(this.toOfflineSession());
  }

  private async requestWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } };
      this.wakeLock = (await nav.wakeLock?.request('screen')) || null;
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  private ensureKeepAliveAudio(): void {
    if (typeof Audio === 'undefined') {
      return;
    }
    if (!this.keepAlive) {
      const el = new Audio(SILENT_WAV);
      el.loop = true;
      el.setAttribute('title', 'PATTOOL GPS');
      el.setAttribute('data-pat-media-title', 'PATTOOL GPS');
      this.backgroundPlayback.watchMedia(el);
      this.keepAlive = el;
    }
    const p = this.keepAlive.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => undefined);
    }
  }

  private stopKeepAliveAudio(): void {
    if (!this.keepAlive) {
      return;
    }
    try {
      this.keepAlive.pause();
    } catch {
      /* ignore */
    }
  }

  private patch(partial: Partial<GpsLiveSnapshot>): void {
    this.snapshot$.next({ ...this.snapshot$.value, ...partial });
  }
}

type WakeLockSentinel = { release: () => Promise<void> };
