import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { ApiService } from './api.service';

export interface YoutubeEqBand {
  hz: number;
  label: string;
}

export type YoutubeEqSourceKind = 'none' | 'media' | 'capture';

export interface YoutubeEqualizerSettings {
  enabled: boolean;
  bypass: boolean;
  preamp: number;
  bass: number;
  mid: number;
  treble: number;
  presence: number;
  loudness: number;
  bands: number[];
  volume: number;
  balance: number;
  stereoWidth: number;
  compressor: boolean;
  compressorThreshold: number;
  compressorRatio: number;
  compressorAttack: number;
  compressorRelease: number;
  limiter: boolean;
  reverb: number;
  echo: number;
  echoTime: number;
  chorus: number;
  drive: number;
  highpass: number;
  lowpass: number;
  preset: string;
}

export interface YoutubeEqPreset {
  id: string;
  labelKey: string;
  bass: number;
  mid: number;
  treble: number;
  presence: number;
  bands: number[];
}

const BAND_COUNT = 10;

export const YOUTUBE_EQ_BANDS: YoutubeEqBand[] = [
  { hz: 32, label: '32' },
  { hz: 64, label: '64' },
  { hz: 125, label: '125' },
  { hz: 250, label: '250' },
  { hz: 500, label: '500' },
  { hz: 1000, label: '1k' },
  { hz: 2000, label: '2k' },
  { hz: 4000, label: '4k' },
  { hz: 8000, label: '8k' },
  { hz: 16000, label: '16k' }
];

export const YOUTUBE_EQ_PRESETS: YoutubeEqPreset[] = [
  { id: 'flat', labelKey: 'YOUTUBE.EQ.PRESET_FLAT', bass: 0, mid: 0, treble: 0, presence: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', labelKey: 'YOUTUBE.EQ.PRESET_BASS', bass: 8, mid: -1, treble: 0, presence: 0, bands: [8, 6, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', labelKey: 'YOUTUBE.EQ.PRESET_TREBLE', bass: 0, mid: 0, treble: 8, presence: 3, bands: [0, 0, 0, 0, 0, 1, 3, 5, 7, 8] },
  { id: 'vocal', labelKey: 'YOUTUBE.EQ.PRESET_VOCAL', bass: -2, mid: 5, treble: 1, presence: 4, bands: [-2, -3, -2, 1, 4, 5, 4, 2, 0, -2] },
  { id: 'rock', labelKey: 'YOUTUBE.EQ.PRESET_ROCK', bass: 5, mid: 0, treble: 4, presence: 2, bands: [5, 4, 3, 1, -1, 1, 3, 4, 4, 5] },
  { id: 'pop', labelKey: 'YOUTUBE.EQ.PRESET_POP', bass: 2, mid: 2, treble: 3, presence: 1, bands: [-1, 2, 4, 4, 2, -1, -2, -1, 2, 3] },
  { id: 'jazz', labelKey: 'YOUTUBE.EQ.PRESET_JAZZ', bass: 3, mid: -1, treble: 3, presence: 1, bands: [4, 3, 1, 2, -2, -2, 0, 2, 3, 4] },
  { id: 'classical', labelKey: 'YOUTUBE.EQ.PRESET_CLASSICAL', bass: 4, mid: -1, treble: 3, presence: 0, bands: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4] },
  { id: 'electronic', labelKey: 'YOUTUBE.EQ.PRESET_ELECTRONIC', bass: 6, mid: -1, treble: 4, presence: 2, bands: [6, 5, 1, 0, -2, 2, 1, 2, 4, 5] },
  { id: 'acoustic', labelKey: 'YOUTUBE.EQ.PRESET_ACOUSTIC', bass: 3, mid: 2, treble: 2, presence: 2, bands: [4, 3, 2, 1, 2, 3, 3, 3, 2, 2] },
  { id: 'hiphop', labelKey: 'YOUTUBE.EQ.PRESET_HIPHOP', bass: 7, mid: -1, treble: 3, presence: 1, bands: [7, 6, 2, 1, -1, -1, 1, 2, 3, 4] },
  { id: 'movie', labelKey: 'YOUTUBE.EQ.PRESET_MOVIE', bass: 3, mid: 1, treble: 3, presence: 2, bands: [3, 2, 0, 0, 1, 2, 3, 2, 4, 3] },
  { id: 'podcast', labelKey: 'YOUTUBE.EQ.PRESET_PODCAST', bass: -3, mid: 6, treble: 0, presence: 3, bands: [-2, -3, 0, 4, 6, 5, 3, 1, -1, -3] },
  { id: 'night', labelKey: 'YOUTUBE.EQ.PRESET_NIGHT', bass: -4, mid: 1, treble: -2, presence: 0, bands: [-4, -3, -2, 0, 1, 2, 1, 0, -2, -4] }
];

const STORAGE_KEY = 'pattool.youtube.equalizer';
const USER_PRESET_KEY = 'pattool.youtube.equalizer.user';
const DB_MIN = -12;
const DB_MAX = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function cloneSettings(s: YoutubeEqualizerSettings): YoutubeEqualizerSettings {
  return { ...s, bands: [...(s.bands || [])] };
}

function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 256;
  const curve = new Float32Array(n) as Float32Array<ArrayBuffer>;
  const k = Math.max(0, amount) * 80;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = k < 0.0001 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function defaultSettings(): YoutubeEqualizerSettings {
  return {
    enabled: true,
    bypass: false,
    preamp: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    presence: 0,
    loudness: 0,
    bands: YOUTUBE_EQ_BANDS.map(() => 0),
    volume: 1,
    balance: 0,
    stereoWidth: 1,
    compressor: false,
    compressorThreshold: -18,
    compressorRatio: 4,
    compressorAttack: 0.012,
    compressorRelease: 0.18,
    limiter: true,
    reverb: 0,
    echo: 0,
    echoTime: 0.28,
    chorus: 0,
    drive: 0,
    highpass: 20,
    lowpass: 20000,
    preset: 'flat'
  };
}

@Injectable({ providedIn: 'root' })
export class YoutubeEqualizerService {
  readonly bands = YOUTUBE_EQ_BANDS;
  readonly presets = YOUTUBE_EQ_PRESETS;

  constructor(
    private ngZone: NgZone,
    private translate: TranslateService,
    private api: ApiService
  ) {
    this.hydrateFromServer();
  }

  private readonly settingsSubject = new BehaviorSubject<YoutubeEqualizerSettings>(this.loadSettings());
  readonly settings$ = this.settingsSubject.asObservable();

  private readonly userPresetSubject = new BehaviorSubject<YoutubeEqualizerSettings | null>(this.loadUserPreset());
  readonly userPreset$ = this.userPresetSubject.asObservable();

  private readonly sourceKindSubject = new BehaviorSubject<YoutubeEqSourceKind>('none');
  readonly sourceKind$ = this.sourceKindSubject.asObservable();

  private readonly captureErrorSubject = new BehaviorSubject<string>('');
  readonly captureError$ = this.captureErrorSubject.asObservable();

  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private bypassGain: GainNode | null = null;
  private processedGain: GainNode | null = null;
  private preamp: GainNode | null = null;
  private bassFilter: BiquadFilterNode | null = null;
  private midFilter: BiquadFilterNode | null = null;
  private trebleFilter: BiquadFilterNode | null = null;
  private presenceFilter: BiquadFilterNode | null = null;
  private loudBassFilter: BiquadFilterNode | null = null;
  private loudTrebleFilter: BiquadFilterNode | null = null;
  private bandFilters: BiquadFilterNode[] = [];
  private panner: StereoPannerNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private reverbDelay: DelayNode | null = null;
  private reverbFeedback: GainNode | null = null;
  private reverbWet: GainNode | null = null;
  private echoDelay: DelayNode | null = null;
  private echoFeedback: GainNode | null = null;
  private echoWet: GainNode | null = null;
  private chorusDelay: DelayNode | null = null;
  private chorusLfo: OscillatorNode | null = null;
  private chorusDepth: GainNode | null = null;
  private chorusWet: GainNode | null = null;
  private highpassFilter: BiquadFilterNode | null = null;
  private lowpassFilter: BiquadFilterNode | null = null;
  private driveShaper: WaveShaperNode | null = null;
  private driveDry: GainNode | null = null;
  private driveWet: GainNode | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private outputDest: MediaStreamAudioDestinationNode | null = null;
  private outputWindow: Window | null = null;
  private closingOutputWindow = false;
  private outputWatch: ReturnType<typeof setInterval> | undefined;

  private mediaSource: MediaElementAudioSourceNode | null = null;
  private mediaElement: HTMLMediaElement | null = null;
  private readonly mediaSourceCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private streamSource: MediaStreamAudioSourceNode | null = null;
  private captureStream: MediaStream | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private hydratingFromServer = false;
  private serverPersistSub: { unsubscribe(): void } | null = null;
  private readonly onCaptureEnded = (): void => this.stopTabCapture();

  get settings(): YoutubeEqualizerSettings {
    return this.settingsSubject.value;
  }

  get sourceKind(): YoutubeEqSourceKind {
    return this.sourceKindSubject.value;
  }

  get captureError(): string {
    return this.captureErrorSubject.value;
  }

  get isLive(): boolean {
    return this.sourceKindSubject.value !== 'none';
  }

  get hasUserPreset(): boolean {
    return !!this.userPresetSubject.value;
  }

  private emitSource(kind: YoutubeEqSourceKind): void {
    this.ngZone.run(() => this.sourceKindSubject.next(kind));
  }

  private emitCaptureError(key: string): void {
    this.ngZone.run(() => this.captureErrorSubject.next(key));
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  async resume(): Promise<void> {
    const ctx = this.ensureGraph();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    this.bindOutputWindow();
  }

  patch(partial: Partial<YoutubeEqualizerSettings>, markCustom = true): void {
    const next: YoutubeEqualizerSettings = {
      ...this.settings,
      ...partial,
      bands: partial.bands ? this.normalizeBands(partial.bands) : this.settings.bands
    };
    if (markCustom && this.touchesTone(partial)) {
      next.preset = 'custom';
    }
    this.settingsSubject.next(next);
    try {
      this.ensureGraph();
    } catch {
      /* AudioContext unavailable */
    }
    this.applySettings(next);
    this.schedulePersist();
  }

  applyPreset(id: string): void {
    if (id === 'mine') {
      this.applyUserPreset();
      return;
    }
    const preset = YOUTUBE_EQ_PRESETS.find((item) => item.id === id);
    if (!preset) {
      return;
    }
    this.patch(
      {
        preset: preset.id,
        bass: preset.bass,
        mid: preset.mid,
        treble: preset.treble,
        presence: preset.presence,
        bands: [...preset.bands]
      },
      false
    );
  }

  applyUserPreset(): void {
    const saved = this.userPresetSubject.value;
    if (!saved) {
      return;
    }
    this.patch({ ...cloneSettings(saved), preset: 'mine' }, false);
  }

  saveUserPreset(): void {
    const snap = cloneSettings(this.settings);
    snap.preset = 'mine';
    this.userPresetSubject.next(snap);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(USER_PRESET_KEY, JSON.stringify(snap));
      } catch {
        /* ignore */
      }
    }
    this.patch({ preset: 'mine' }, false);
  }

  reset(): void {
    const current = this.settings;
    this.settingsSubject.next({
      ...defaultSettings(),
      enabled: current.enabled,
      volume: current.volume
    });
    this.applySettings(this.settings);
    this.schedulePersist();
  }

  setBand(index: number, value: number): void {
    if (index < 0 || index >= BAND_COUNT) {
      return;
    }
    const bands = [...this.settings.bands];
    bands[index] = clamp(Number(value) || 0, DB_MIN, DB_MAX);
    this.patch({ bands });
  }

  attachMediaElement(el: HTMLMediaElement): void {
    if (!el) {
      return;
    }
    this.emitCaptureError('');
    const ctx = this.ensureGraph();
    this.disconnectStreamSource();
    if (this.mediaElement && this.mediaElement !== el && this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        /* ignore */
      }
    }
    const cached = this.mediaSourceCache.get(el);
    if (cached) {
      this.mediaSource = cached;
      this.mediaElement = el;
      try {
        cached.disconnect();
      } catch {
        /* ignore */
      }
      cached.connect(this.input!);
      this.routeAnalyser('media');
      this.emitSource('media');
      this.applySettings(this.settings);
      void this.resume();
      return;
    }
    if (this.mediaElement === el && this.mediaSource) {
      this.routeAnalyser('media');
      this.emitSource('media');
      this.applySettings(this.settings);
      void this.resume();
      return;
    }
    this.disconnectMediaSource();
    try {
      const src = ctx.createMediaElementSource(el);
      this.mediaSourceCache.set(el, src);
      this.mediaSource = src;
      this.mediaElement = el;
      src.connect(this.input!);
      this.routeAnalyser('media');
      this.emitSource('media');
      this.applySettings(this.settings);
      void this.resume();
    } catch {
      this.mediaSource = null;
      this.mediaElement = null;
      this.emitSource('none');
    }
  }

  detachMediaElement(el?: HTMLMediaElement): void {
    if (el && this.mediaElement && el !== this.mediaElement) {
      return;
    }
    this.disconnectMediaSource();
    if (this.streamSource) {
      this.emitSource('capture');
      return;
    }
    this.emitSource('none');
  }

  async startTabCapture(): Promise<boolean> {
    this.emitCaptureError('');
    const outputWin = this.openOutputWindow();
    if (!outputWin) {
      this.emitCaptureError('YOUTUBE.EQ.CAPTURE_POPUP');
      return false;
    }
    if (this.streamSource && this.captureStream?.getAudioTracks().some((t) => t.readyState === 'live')) {
      this.routeAnalyser('capture');
      this.emitSource('capture');
      this.bindOutputWindow();
      await this.resume();
      return true;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      this.closeOutputWindow();
      this.emitCaptureError('YOUTUBE.EQ.CAPTURE_UNAVAILABLE');
      return false;
    }
    this.disconnectStreamSource();
    const ctx = this.ensureGraph();
    this.routeAnalyser('capture');
    this.bindOutputWindow();
    void this.resume();
    try {
      const captureOpts: DisplayMediaStreamOptions & {
        preferCurrentTab?: boolean;
        selfBrowserSurface?: string;
        surfaceSwitching?: string;
        monitorTypeSurfaces?: string;
        systemAudio?: string;
        controller?: { setFocusBehavior(behavior: string): void };
      } = {
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: true
        } as MediaTrackConstraints,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
        systemAudio: 'include'
      };
      const ControllerCtor = (
        window as unknown as {
          CaptureController?: new () => { setFocusBehavior(behavior: string): void };
        }
      ).CaptureController;
      if (ControllerCtor) {
        const controller = new ControllerCtor();
        captureOpts.controller = controller;
        try {
          controller.setFocusBehavior('no-focus-change');
        } catch {
          /* ignore */
        }
      }
      const stream = await navigator.mediaDevices.getDisplayMedia(captureOpts);
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        this.closeOutputWindow();
        this.emitCaptureError('YOUTUBE.EQ.CAPTURE_NO_AUDIO');
        return false;
      }
      audioTracks.forEach((track) => {
        track.addEventListener('ended', this.onCaptureEnded);
      });
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', this.onCaptureEnded);
      });
      this.captureStream = stream;
      this.disconnectMediaSource();
      this.streamSource = ctx.createMediaStreamSource(stream);
      this.streamSource.connect(this.input!);
      this.routeAnalyser('capture');
      this.emitSource('capture');
      this.applySettings(this.settings);
      this.bindOutputWindow();
      await this.resume();
      return true;
    } catch {
      this.stopTabCapture();
      this.emitCaptureError('YOUTUBE.EQ.CAPTURE_DENIED');
      return false;
    }
  }

  stopTabCapture(): void {
    this.closeOutputWindow();
    this.disconnectStreamSource();
    if (this.mediaSource) {
      this.routeAnalyser('media');
      this.emitSource('media');
      return;
    }
    if (this.sourceKindSubject.value === 'capture') {
      this.emitSource('none');
    }
  }

  release(): void {
    this.stopTabCapture();
    this.disconnectMediaSource();
    this.emitSource('none');
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistNow();
    this.closeOutputWindow();
    if (this.ctx) {
      void this.ctx.suspend();
    }
  }

  private ensureGraph(): AudioContext {
    if (this.ctx && this.input && this.analyser) {
      if (!this.outputDest) {
        this.ensureProcessedDestination();
      }
      return this.ctx;
    }
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      throw new Error('AudioContext unavailable');
    }
    const ctx = new Ctor();
    const input = ctx.createGain();
    const bypassGain = ctx.createGain();
    const processedGain = ctx.createGain();
    const preamp = ctx.createGain();
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 120;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;
    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 8000;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 4500;
    presence.Q.value = 0.9;
    const loudBass = ctx.createBiquadFilter();
    loudBass.type = 'lowshelf';
    loudBass.frequency.value = 90;
    const loudTreble = ctx.createBiquadFilter();
    loudTreble.type = 'highshelf';
    loudTreble.frequency.value = 10000;

    const bandFilters = YOUTUBE_EQ_BANDS.map((band) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = band.hz;
      filter.Q.value = 1.4;
      return filter;
    });

    const panner = ctx.createStereoPanner();
    const compressor = ctx.createDynamicsCompressor();
    const limiter = ctx.createDynamicsCompressor();
    limiter.knee.value = 0;
    const reverbDelay = ctx.createDelay(1);
    reverbDelay.delayTime.value = 0.09;
    const reverbFeedback = ctx.createGain();
    const reverbWet = ctx.createGain();
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    const sum = ctx.createGain();
    const widthMix = ctx.createGain();

    input.connect(bypassGain);
    input.connect(preamp);
    preamp.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(presence);
    presence.connect(loudBass);
    loudBass.connect(loudTreble);
    let node: AudioNode = loudTreble;
    for (const filter of bandFilters) {
      node.connect(filter);
      node = filter;
    }
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 20;
    highpass.Q.value = 0.7;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 20000;
    lowpass.Q.value = 0.7;
    const driveIn = ctx.createGain();
    const driveShaper = ctx.createWaveShaper();
    driveShaper.curve = makeDriveCurve(0);
    driveShaper.oversample = '2x';
    const driveDry = ctx.createGain();
    const driveWet = ctx.createGain();
    const driveMix = ctx.createGain();
    node.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(driveIn);
    driveIn.connect(driveDry);
    driveIn.connect(driveShaper);
    driveShaper.connect(driveWet);
    driveDry.connect(driveMix);
    driveWet.connect(driveMix);
    driveMix.connect(panner);
    panner.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(processedGain);
    limiter.connect(reverbDelay);
    reverbDelay.connect(reverbFeedback);
    reverbFeedback.connect(reverbDelay);
    reverbDelay.connect(reverbWet);
    reverbWet.connect(sum);
    const echoDelay = ctx.createDelay(1.5);
    echoDelay.delayTime.value = 0.28;
    const echoFeedback = ctx.createGain();
    const echoWet = ctx.createGain();
    limiter.connect(echoDelay);
    echoDelay.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoDelay.connect(echoWet);
    echoWet.connect(sum);
    const chorusDelay = ctx.createDelay(0.05);
    chorusDelay.delayTime.value = 0.018;
    const chorusLfo = ctx.createOscillator();
    chorusLfo.type = 'sine';
    chorusLfo.frequency.value = 1.2;
    const chorusDepth = ctx.createGain();
    chorusDepth.gain.value = 0.004;
    chorusLfo.connect(chorusDepth);
    chorusDepth.connect(chorusDelay.delayTime);
    const chorusWet = ctx.createGain();
    limiter.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    chorusWet.connect(sum);
    chorusLfo.start();
    processedGain.connect(sum);
    bypassGain.connect(sum);
    sum.connect(widthMix);
    widthMix.connect(master);
    master.connect(analyser);
    const outputDest = ctx.createMediaStreamDestination();

    this.ctx = ctx;
    this.input = input;
    this.bypassGain = bypassGain;
    this.processedGain = processedGain;
    this.preamp = preamp;
    this.bassFilter = bass;
    this.midFilter = mid;
    this.trebleFilter = treble;
    this.presenceFilter = presence;
    this.loudBassFilter = loudBass;
    this.loudTrebleFilter = loudTreble;
    this.bandFilters = bandFilters;
    this.panner = panner;
    this.compressor = compressor;
    this.limiter = limiter;
    this.reverbDelay = reverbDelay;
    this.reverbFeedback = reverbFeedback;
    this.reverbWet = reverbWet;
    this.echoDelay = echoDelay;
    this.echoFeedback = echoFeedback;
    this.echoWet = echoWet;
    this.chorusDelay = chorusDelay;
    this.chorusLfo = chorusLfo;
    this.chorusDepth = chorusDepth;
    this.chorusWet = chorusWet;
    this.highpassFilter = highpass;
    this.lowpassFilter = lowpass;
    this.driveShaper = driveShaper;
    this.driveDry = driveDry;
    this.driveWet = driveWet;
    this.master = master;
    this.analyser = analyser;
    this.outputDest = outputDest;
    this.routeAnalyser(this.sourceKindSubject.value === 'capture' ? 'capture' : 'media');
    this.applySettings(this.settings);
    return ctx;
  }

  private routeAnalyser(kind: YoutubeEqSourceKind): void {
    if (!this.ctx || !this.analyser) {
      return;
    }
    try {
      this.analyser.disconnect();
    } catch {
      /* ignore */
    }
    if (kind === 'capture') {
      if (!this.outputDest) {
        this.outputDest = this.ctx.createMediaStreamDestination();
      }
      this.analyser.connect(this.outputDest);
      return;
    }
    this.analyser.connect(this.ctx.destination);
  }

  private ensureProcessedDestination(): void {
    if (!this.ctx || !this.analyser || this.outputDest) {
      return;
    }
    this.outputDest = this.ctx.createMediaStreamDestination();
    if (this.sourceKindSubject.value === 'capture') {
      this.routeAnalyser('capture');
    }
  }

  private openOutputWindow(): Window | null {
    if (typeof window === 'undefined') {
      return null;
    }
    if (this.outputWindow && !this.outputWindow.closed) {
      try {
        this.outputWindow.focus();
      } catch {
        /* ignore */
      }
      this.watchOutputWindow();
      return this.outputWindow;
    }
    const win = window.open(
      '',
      'pattool-youtube-eq',
      'popup=yes,width=440,height=220,resizable=yes,scrollbars=no,status=no'
    );
    if (!win) {
      return null;
    }
    this.outputWindow = win;
    this.fillOutputWindow(win);
    this.watchOutputWindow();
    return win;
  }

  private fillOutputWindow(win: Window): void {
    const title = this.translate.instant('YOUTUBE.EQ.OUTPUT_TITLE');
    const hint = this.translate.instant('YOUTUBE.EQ.OUTPUT_HINT');
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; background: #140808; color: #f1f1f1; font-family: Segoe UI, sans-serif; }
    body { padding: 14px 16px; }
    h1 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 0 0 12px; font-size: 13px; color: #d0d0d0; line-height: 1.35; }
    audio { width: 100%; }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(title)}</h1>
  <p>${this.escapeHtml(hint)}</p>
  <audio id="eq-out" autoplay controls playsinline></audio>
  <script>
    (function () {
      var a = document.getElementById('eq-out');
      if (!a) return;
      var play = function () { a.play().catch(function () {}); };
      a.addEventListener('canplay', play);
      document.addEventListener('click', play);
      play();
    })();
  </script>
</body>
</html>`;
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  private bindOutputWindow(): void {
    const win = this.outputWindow;
    if (!win || win.closed || !this.outputDest) {
      return;
    }
    const audio = win.document.getElementById('eq-out') as HTMLAudioElement | null;
    if (!audio) {
      return;
    }
    if (audio.srcObject !== this.outputDest.stream) {
      audio.srcObject = this.outputDest.stream;
    }
    audio.muted = false;
    audio.volume = 1;
    const play = audio.play();
    if (play && typeof play.catch === 'function') {
      play.catch(() => {
        /* user can press play on the popup controls */
      });
    }
  }

  private watchOutputWindow(): void {
    if (this.outputWatch !== undefined) {
      clearInterval(this.outputWatch);
    }
    this.outputWatch = setInterval(() => {
      if (!this.outputWindow || this.outputWindow.closed) {
        if (this.outputWatch !== undefined) {
          clearInterval(this.outputWatch);
          this.outputWatch = undefined;
        }
        if (!this.closingOutputWindow && this.sourceKindSubject.value === 'capture') {
          this.ngZone.run(() => this.stopTabCapture());
        }
      }
    }, 700);
  }

  private closeOutputWindow(): void {
    if (this.closingOutputWindow) {
      return;
    }
    this.closingOutputWindow = true;
    if (this.outputWatch !== undefined) {
      clearInterval(this.outputWatch);
      this.outputWatch = undefined;
    }
    const win = this.outputWindow;
    this.outputWindow = null;
    if (win && !win.closed) {
      try {
        const audio = win.document.getElementById('eq-out') as HTMLAudioElement | null;
        if (audio) {
          audio.pause();
          audio.srcObject = null;
        }
        win.close();
      } catch {
        /* ignore */
      }
    }
    this.closingOutputWindow = false;
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private applySettings(s: YoutubeEqualizerSettings): void {
    if (!this.ctx || !this.preamp) {
      return;
    }
    const now = this.ctx.currentTime;
    const bypass = !s.enabled || s.bypass;
    this.setGain(this.bypassGain, bypass ? 1 : 0, now);
    this.setGain(this.processedGain, bypass ? 0 : 1, now);
    this.setGain(this.preamp, dbToGain(clamp(s.preamp, DB_MIN, DB_MAX)), now);
    this.setFilterGain(this.bassFilter, clamp(s.bass, DB_MIN, DB_MAX), now);
    this.setFilterGain(this.midFilter, clamp(s.mid, DB_MIN, DB_MAX), now);
    this.setFilterGain(this.trebleFilter, clamp(s.treble, DB_MIN, DB_MAX), now);
    this.setFilterGain(this.presenceFilter, clamp(s.presence, DB_MIN, DB_MAX), now);
    const loud = clamp(s.loudness, 0, 12);
    this.setFilterGain(this.loudBassFilter, loud, now);
    this.setFilterGain(this.loudTrebleFilter, loud * 0.55, now);
    this.bandFilters.forEach((filter, i) => {
      this.setFilterGain(filter, clamp(s.bands[i] ?? 0, DB_MIN, DB_MAX), now);
    });
    if (this.panner) {
      this.setNumber(this.panner.pan, clamp(s.balance, -1, 1), now);
    }
    if (this.compressor) {
      if (s.compressor) {
        this.setNumber(this.compressor.threshold, clamp(s.compressorThreshold, -60, 0), now);
        this.setNumber(this.compressor.ratio, clamp(s.compressorRatio, 1, 20), now);
        this.setNumber(this.compressor.attack, clamp(s.compressorAttack, 0.001, 0.2), now);
        this.setNumber(this.compressor.release, clamp(s.compressorRelease, 0.02, 1), now);
        this.setNumber(this.compressor.knee, 6, now);
      } else {
        this.setNumber(this.compressor.threshold, 0, now);
        this.setNumber(this.compressor.ratio, 1, now);
        this.setNumber(this.compressor.knee, 0, now);
      }
    }
    if (this.limiter) {
      if (s.limiter) {
        this.setNumber(this.limiter.threshold, -1.2, now);
        this.setNumber(this.limiter.ratio, 20, now);
        this.setNumber(this.limiter.attack, 0.003, now);
        this.setNumber(this.limiter.release, 0.08, now);
      } else {
        this.setNumber(this.limiter.threshold, 0, now);
        this.setNumber(this.limiter.ratio, 1, now);
      }
    }
    const wet = clamp(s.reverb, 0, 1);
    this.setGain(this.reverbWet, wet * 0.42, now);
    this.setGain(this.reverbFeedback, wet * 0.28, now);
    const echo = clamp(s.echo, 0, 1);
    this.setGain(this.echoWet, echo * 0.55, now);
    this.setGain(this.echoFeedback, echo * 0.42, now);
    if (this.echoDelay) {
      this.setNumber(this.echoDelay.delayTime, clamp(s.echoTime, 0.08, 0.7), now);
    }
    const chorus = clamp(s.chorus, 0, 1);
    this.setGain(this.chorusWet, chorus * 0.45, now);
    if (this.chorusDepth) {
      this.setNumber(this.chorusDepth.gain, 0.002 + chorus * 0.008, now);
    }
    const drive = clamp(s.drive, 0, 1);
    this.setGain(this.driveWet, drive, now);
    this.setGain(this.driveDry, 1 - drive * 0.72, now);
    if (this.driveShaper) {
      this.driveShaper.curve = makeDriveCurve(drive);
    }
    if (this.highpassFilter) {
      this.setNumber(this.highpassFilter.frequency, clamp(s.highpass, 20, 400), now);
    }
    if (this.lowpassFilter) {
      this.setNumber(this.lowpassFilter.frequency, clamp(s.lowpass, 1500, 20000), now);
    }
    this.setGain(this.master, clamp(s.volume, 0, 1.5), now);
  }

  private setGain(node: GainNode | null, value: number, when: number): void {
    this.setNumber(node?.gain, value, when);
  }

  private setFilterGain(node: BiquadFilterNode | null, db: number, when: number): void {
    this.setNumber(node?.gain, db, when);
  }

  private setNumber(param: AudioParam | undefined, value: number, when: number): void {
    if (!param) {
      return;
    }
    try {
      param.cancelScheduledValues(when);
      param.setValueAtTime(value, when);
    } catch {
      param.value = value;
    }
  }

  private disconnectMediaSource(): void {
    if (this.mediaSource) {
      try {
        this.mediaSource.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.mediaSource = null;
    this.mediaElement = null;
  }

  private disconnectStreamSource(): void {
    if (this.streamSource) {
      try {
        this.streamSource.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.streamSource = null;
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((track) => {
        track.removeEventListener('ended', this.onCaptureEnded);
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
    }
    this.captureStream = null;
  }

  private touchesTone(partial: Partial<YoutubeEqualizerSettings>): boolean {
    return (
      partial.bass != null ||
      partial.mid != null ||
      partial.treble != null ||
      partial.presence != null ||
      partial.bands != null ||
      partial.loudness != null ||
      partial.echo != null ||
      partial.echoTime != null ||
      partial.chorus != null ||
      partial.drive != null ||
      partial.highpass != null ||
      partial.lowpass != null ||
      partial.reverb != null
    );
  }

  private normalizeBands(bands: number[]): number[] {
    const next = YOUTUBE_EQ_BANDS.map((_, i) => clamp(Number(bands[i]) || 0, DB_MIN, DB_MAX));
    return next;
  }

  private loadSettings(): YoutubeEqualizerSettings {
    return this.mergeSettings(this.readLocalJson(STORAGE_KEY));
  }

  private loadUserPreset(): YoutubeEqualizerSettings | null {
    const parsed = this.readLocalJson(USER_PRESET_KEY);
    if (!parsed) {
      return null;
    }
    return { ...this.mergeSettings(parsed), preset: 'mine' };
  }

  private mergeSettings(parsed: Partial<YoutubeEqualizerSettings> | null | undefined): YoutubeEqualizerSettings {
    const base = defaultSettings();
    if (!parsed) {
      return base;
    }
    return {
      ...base,
      ...parsed,
      bands: this.normalizeBands(parsed.bands || base.bands),
      volume: clamp(Number(parsed.volume ?? 1), 0, 1.5),
      balance: clamp(Number(parsed.balance ?? 0), -1, 1),
      stereoWidth: clamp(Number(parsed.stereoWidth ?? 1), 0, 2),
      echo: clamp(Number(parsed.echo ?? 0), 0, 1),
      echoTime: clamp(Number(parsed.echoTime ?? 0.28), 0.08, 0.7),
      chorus: clamp(Number(parsed.chorus ?? 0), 0, 1),
      drive: clamp(Number(parsed.drive ?? 0), 0, 1),
      highpass: clamp(Number(parsed.highpass ?? 20), 20, 400),
      lowpass: clamp(Number(parsed.lowpass ?? 20000), 1500, 20000)
    };
  }

  private readLocalJson(key: string): Partial<YoutubeEqualizerSettings> | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as Partial<YoutubeEqualizerSettings>;
    } catch {
      return null;
    }
  }

  private hydrateFromServer(): void {
    this.hydratingFromServer = true;
    this.api.getAudioEqualizerPreference().subscribe({
      next: (pref) => {
        const dbSettings = pref?.settings
          ? this.mergeSettings(pref.settings as Partial<YoutubeEqualizerSettings>)
          : null;
        const dbPreset = pref?.userPreset
          ? { ...this.mergeSettings(pref.userPreset as Partial<YoutubeEqualizerSettings>), preset: 'mine' }
          : null;
        if (dbSettings) {
          this.settingsSubject.next(dbSettings);
          this.applySettings(dbSettings);
        }
        if (dbPreset) {
          this.userPresetSubject.next(dbPreset);
        }
        this.writeLocal(STORAGE_KEY, this.settings);
        if (this.userPresetSubject.value) {
          this.writeLocal(USER_PRESET_KEY, this.userPresetSubject.value);
        }
        this.hydratingFromServer = false;
        if (!dbSettings && !dbPreset && (this.readLocalJson(STORAGE_KEY) || this.readLocalJson(USER_PRESET_KEY))) {
          this.persistToServer();
        }
      },
      error: () => {
        this.hydratingFromServer = false;
      }
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 250);
  }

  private persistNow(): void {
    this.writeLocal(STORAGE_KEY, this.settings);
    if (this.userPresetSubject.value) {
      this.writeLocal(USER_PRESET_KEY, this.userPresetSubject.value);
    }
    this.persistToServer();
  }

  private persistToServer(): void {
    if (this.hydratingFromServer) {
      return;
    }
    this.serverPersistSub?.unsubscribe();
    this.serverPersistSub = this.api
      .saveAudioEqualizerPreference({
        settings: this.settings,
        userPreset: this.userPresetSubject.value
      })
      .subscribe({
        error: () => {
          /* stay on localStorage if the user is offline or logged out */
        }
      });
  }

  private writeLocal(key: string, value: YoutubeEqualizerSettings): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }
}
