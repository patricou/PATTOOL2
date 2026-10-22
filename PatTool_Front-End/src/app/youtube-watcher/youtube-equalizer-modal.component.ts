import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import {
  YoutubeEqualizerService,
  YoutubeEqualizerSettings,
  YoutubeEqBand,
  YoutubeEqPreset,
  YoutubeEqSourceKind
} from '../services/youtube-equalizer.service';

export type YoutubeEqTheme = 'youtube' | 'tv' | 'radio' | 'videoshow';
/** Cabinet chosen on the radio or TV page. */
export type YoutubeEqCabinet =
  | 'classic'
  | 'artdeco'
  | 'synthwave'
  | 'spaceage'
  | 'military'
  | 'steampunk'
  | 'aurora'
  | 'noir'
  | 'bamboo'
  | 'porcelain'
  | 'carbon'
  | 'candy'
  | 'espace'
  | 'kanizsa'
  | 'cafewall'
  | 'penrose'
  | 'scintille'
  | 'barber';

type SpectrumShape = 'bars' | 'curve' | 'line' | 'dots';
type SpectrumPalette = 'skin' | 'rainbow' | 'fire' | 'ocean' | 'violet' | 'gold';

@Component({
  selector: 'app-youtube-equalizer-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule],
  templateUrl: './youtube-equalizer-modal.component.html',
  styleUrls: ['./youtube-equalizer-modal.component.css']
})
export class YoutubeEqualizerModalComponent implements OnDestroy {
  private static readonly SPECTRUM_KEY = 'pattool.eq.spectrum.view';
  @Input() captureBlocked = false;
  @Input() hasYoutubeVideo = false;
  /** youtube = tab-capture hints; media = TV / radio / file video. */
  @Input() variant: 'youtube' | 'media' = 'youtube';
  /** Header color: matches the page that opened the equalizer. */
  @Input() theme: YoutubeEqTheme = 'youtube';
  /** Radio / TV cabinet. The equalizer uses this skin when the page has one. */
  @Input() cabinet: YoutubeEqCabinet | '' = '';

  @ViewChild('eqModal') eqModal?: TemplateRef<unknown>;
  @ViewChild('spectrum') spectrumRef?: ElementRef<HTMLCanvasElement>;

  settings: YoutubeEqualizerSettings = this.eq.settings;
  sourceKind: YoutubeEqSourceKind = 'none';
  captureError = '';
  captureBusy = false;
  showAdvanced = false;
  hasUserPreset = this.eq.hasUserPreset;
  presetSaved = false;

  readonly bands: YoutubeEqBand[] = this.eq.bands;
  readonly presets: YoutubeEqPreset[] = this.eq.presets;
  readonly spectrumShapes = ['bars', 'curve', 'line', 'dots'] as const;
  readonly spectrumPalettes: { id: SpectrumPalette; swatch: string }[] = [
    { id: 'skin', swatch: 'linear-gradient(135deg, #dbeafe, #2563eb)' },
    { id: 'rainbow', swatch: 'linear-gradient(90deg, #ff4d4d, #ffe14d, #3dff8a, #3db7ff, #c44dff)' },
    { id: 'fire', swatch: 'linear-gradient(90deg, #ffd15a, #ff6a00, #ff1f1f)' },
    { id: 'ocean', swatch: 'linear-gradient(90deg, #08345c, #1aa0ff, #7af6ff)' },
    { id: 'violet', swatch: 'linear-gradient(90deg, #6d28d9, #f0abfc)' },
    { id: 'gold', swatch: 'linear-gradient(90deg, #fff1a8, #e0a106)' }
  ];
  spectrumShape: SpectrumShape = 'bars';
  spectrumPalette: SpectrumPalette = 'skin';
  private presetSavedTimer: ReturnType<typeof setTimeout> | undefined;

  private modalRef: NgbModalRef | null = null;
  private readonly subs: Subscription[] = [];
  private raf = 0;
  private visualizing = false;

  constructor(
    readonly eq: YoutubeEqualizerService,
    private modalService: NgbModal,
    private cdr: ChangeDetectorRef
  ) {
    this.readSpectrumView();
    this.subs.push(
      this.eq.settings$.subscribe((s) => {
        this.settings = s;
        this.cdr.markForCheck();
      }),
      this.eq.sourceKind$.subscribe((kind) => {
        this.sourceKind = kind;
        this.cdr.markForCheck();
      }),
      this.eq.captureError$.subscribe((err) => {
        this.captureError = err;
        this.cdr.markForCheck();
      }),
      this.eq.userPreset$.subscribe((saved) => {
        this.hasUserPreset = !!saved;
        this.cdr.markForCheck();
      })
    );
  }

  ngOnDestroy(): void {
    this.stopVisualizer();
    if (this.presetSavedTimer !== undefined) {
      clearTimeout(this.presetSavedTimer);
    }
    this.subs.forEach((s) => s.unsubscribe());
    try {
      this.modalRef?.dismiss();
    } catch {
      /* ignore */
    }
    this.modalRef = null;
  }

  get isOpen(): boolean {
    return !!this.modalRef;
  }

  open(): void {
    if (!this.eqModal || this.modalRef) {
      return;
    }
    void this.eq.resume();
    this.modalRef = this.modalService.open(this.eqModal, {
      size: 'xl',
      centered: true,
      scrollable: true,
      windowClass: `yt-eq-modal yt-eq-skin-${this.theme}`,
      backdropClass: 'yt-eq-modal-backdrop',
      modalDialogClass: 'yt-eq-modal-dialog'
    });
    this.modalRef.dismissed.subscribe(() => this.onModalClosed());
    this.modalRef.closed.subscribe(() => this.onModalClosed());
    setTimeout(() => this.startVisualizer(), 80);
  }

  close(): void {
    try {
      this.modalRef?.dismiss();
    } catch {
      /* ignore */
    }
  }

  formatDb(value: number): string {
    const n = Math.round((Number(value) || 0) * 10) / 10;
    return `${n > 0 ? '+' : ''}${n}`;
  }

  onNumber(key: keyof YoutubeEqualizerSettings, value: number | string): void {
    this.eq.patch({ [key]: Number(value) } as Partial<YoutubeEqualizerSettings>);
  }

  onToggle(key: 'enabled' | 'bypass' | 'compressor' | 'limiter', value: boolean): void {
    this.eq.patch({ [key]: value });
  }

  onBand(index: number, value: number | string): void {
    this.eq.setBand(index, Number(value));
  }

  onPreset(id: string): void {
    this.eq.applyPreset(id);
  }

  onSavePreset(): void {
    this.eq.saveUserPreset();
    this.presetSaved = true;
    if (this.presetSavedTimer !== undefined) {
      clearTimeout(this.presetSavedTimer);
    }
    this.presetSavedTimer = setTimeout(() => {
      this.presetSaved = false;
      this.cdr.markForCheck();
    }, 1800);
  }

  async onCapture(): Promise<void> {
    if (this.captureBlocked || this.captureBusy) {
      return;
    }
    this.captureBusy = true;
    try {
      await this.eq.startTabCapture();
    } finally {
      this.captureBusy = false;
      this.cdr.markForCheck();
    }
  }

  onStopCapture(): void {
    this.eq.stopTabCapture();
  }

  setSpectrumShape(shape: SpectrumShape): void {
    this.spectrumShape = shape;
    this.writeSpectrumView();
  }

  setSpectrumPalette(palette: SpectrumPalette): void {
    this.spectrumPalette = palette;
    this.writeSpectrumView();
  }

  private readSpectrumView(): void {
    try {
      const raw = localStorage.getItem(YoutubeEqualizerModalComponent.SPECTRUM_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as { shape?: string; palette?: string };
      if (parsed.shape && (this.spectrumShapes as readonly string[]).includes(parsed.shape)) {
        this.spectrumShape = parsed.shape as SpectrumShape;
      }
      if (this.spectrumPalettes.some((item) => item.id === parsed.palette)) {
        this.spectrumPalette = parsed.palette as SpectrumPalette;
      }
    } catch {
      /* ignore */
    }
  }

  private writeSpectrumView(): void {
    try {
      localStorage.setItem(
        YoutubeEqualizerModalComponent.SPECTRUM_KEY,
        JSON.stringify({ shape: this.spectrumShape, palette: this.spectrumPalette })
      );
    } catch {
      /* ignore */
    }
  }

  private onModalClosed(): void {
    this.stopVisualizer();
    this.modalRef = null;
  }

  private startVisualizer(): void {
    this.stopVisualizer();
    const analyser = this.eq.getAnalyser();
    if (analyser) {
      if (analyser.fftSize !== 2048) {
        analyser.fftSize = 2048;
      }
      analyser.smoothingTimeConstant = 0.42;
      analyser.minDecibels = -75;
      analyser.maxDecibels = -18;
    }
    this.visualizing = true;
    const tick = () => {
      if (!this.visualizing) {
        return;
      }
      this.drawSpectrum();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopVisualizer(): void {
    this.visualizing = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private drawSpectrum(): void {
    const canvas = this.spectrumRef?.nativeElement;
    const analyser = this.eq.getAnalyser();
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    const displayW = Math.max(1, Math.floor(canvas.clientWidth));
    const displayH = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== displayW || canvas.height !== displayH) {
      canvas.width = displayW;
      canvas.height = displayH;
    }
    const w = canvas.width;
    const h = canvas.height;
    const skin = getComputedStyle(canvas);
    const pick = (name: string, fallback: string) => skin.getPropertyValue(name).trim() || fallback;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pick('--eq-spectrum-fill', 'rgba(20, 8, 8, 0.92)');
    ctx.fillRect(0, 0, w, h);
    if (!analyser) {
      return;
    }
    const barHi = pick('--eq-bar-hi', '#ff6b6b');
    const barMid = pick('--eq-bar-mid', '#ff0000');
    const barLo = pick('--eq-bar-lo', '#7a0000');
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const count = 48;
    const mags = this.magnitudes(bins, count, analyser.context.sampleRate);
    if (this.spectrumShape === 'bars') {
      this.drawBars(ctx, mags, w, h, barHi, barMid, barLo);
      return;
    }
    if (this.spectrumShape === 'dots') {
      this.drawDots(ctx, mags, w, h, barHi, barMid, barLo);
      return;
    }
    this.drawCurve(ctx, mags, w, h, barHi, barMid, barLo, this.spectrumShape === 'curve');
  }

  private magnitudes(bins: Uint8Array, count: number, sampleRate: number): number[] {
    const fftSize = bins.length * 2;
    const nyquist = sampleRate / 2;
    const minHz = 45;
    const maxHz = Math.min(nyquist * 0.9, 12000);
    const logMin = Math.log(minHz);
    const logMax = Math.log(Math.max(minHz + 1, maxHz));
    const mags: number[] = [];
    for (let i = 0; i < count; i++) {
      const startHz = Math.exp(logMin + ((logMax - logMin) * i) / count);
      const endHz = Math.exp(logMin + ((logMax - logMin) * (i + 1)) / count);
      const startBin = Math.max(1, Math.floor((startHz * fftSize) / sampleRate));
      const endBin = Math.min(bins.length - 1, Math.max(startBin, Math.ceil((endHz * fftSize) / sampleRate)));
      let energy = 0;
      let n = 0;
      for (let b = startBin; b <= endBin; b++) {
        const v = (bins[b] || 0) / 255;
        energy += v * v;
        n++;
      }
      mags.push(Math.sqrt(energy / Math.max(1, n)));
    }
    return mags;
  }

  private tone(index: number, count: number, hi: string, mid: string, lo: string): { top: string; bottom: string } {
    if (this.spectrumPalette === 'skin') {
      return { top: hi, bottom: lo || mid };
    }
    const t = index / Math.max(1, count - 1);
    let hue = 210;
    if (this.spectrumPalette === 'rainbow') {
      hue = t * 280;
    } else if (this.spectrumPalette === 'fire') {
      hue = 46 - t * 40;
    } else if (this.spectrumPalette === 'ocean') {
      hue = 198 + t * 34;
    } else if (this.spectrumPalette === 'violet') {
      hue = 268 + t * 46;
    } else if (this.spectrumPalette === 'gold') {
      hue = 48 - t * 8;
    }
    return {
      top: `hsl(${hue}, 92%, 72%)`,
      bottom: `hsl(${hue}, 92%, 36%)`
    };
  }

  private horizontalPaint(
    ctx: CanvasRenderingContext2D,
    count: number,
    w: number,
    hi: string,
    mid: string,
    lo: string
  ): CanvasGradient {
    const paint = ctx.createLinearGradient(0, 0, w, 0);
    const stops = Math.min(count, 12);
    for (let i = 0; i < stops; i++) {
      paint.addColorStop(i / (stops - 1), this.tone(i, stops, hi, mid, lo).top);
    }
    return paint;
  }

  private levelHeight(mag: number, h: number): number {
    const ceiling = Math.max(4, h - 3);
    return Math.max(2, Math.min(1, mag) * ceiling);
  }

  private drawBars(
    ctx: CanvasRenderingContext2D,
    mags: number[],
    w: number,
    h: number,
    hi: string,
    mid: string,
    lo: string
  ): void {
    const gap = 2;
    const barW = (w - gap * (mags.length - 1)) / mags.length;
    mags.forEach((mag, i) => {
      const bh = this.levelHeight(mag, h);
      const x = i * (barW + gap);
      const y = h - bh;
      const tone = this.tone(i, mags.length, hi, mid, lo);
      const gradient = ctx.createLinearGradient(0, y, 0, h);
      gradient.addColorStop(0, tone.top);
      gradient.addColorStop(0.45, this.spectrumPalette === 'skin' ? mid : tone.top);
      gradient.addColorStop(1, tone.bottom);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barW, bh);
    });
  }

  private drawDots(
    ctx: CanvasRenderingContext2D,
    mags: number[],
    w: number,
    h: number,
    hi: string,
    mid: string,
    lo: string
  ): void {
    mags.forEach((mag, i) => {
      const x = ((i + 0.5) / mags.length) * w;
      const y = h - this.levelHeight(mag, h);
      const tone = this.tone(i, mags.length, hi, mid, lo);
      ctx.beginPath();
      ctx.fillStyle = tone.top;
      ctx.arc(x, y, 2.2 + mag * 3.4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  private drawCurve(
    ctx: CanvasRenderingContext2D,
    mags: number[],
    w: number,
    h: number,
    hi: string,
    mid: string,
    lo: string,
    filled: boolean
  ): void {
    if (!mags.length) {
      return;
    }
    const points = mags.map((mag, i) => ({
      x: ((i + 0.5) / mags.length) * w,
      y: h - this.levelHeight(mag, h)
    }));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const cx = (prev.x + cur.x) / 2;
      const cy = (prev.y + cur.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cx, cy);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    if (filled) {
      ctx.lineTo(points[points.length - 1].x, h);
      ctx.lineTo(points[0].x, h);
      ctx.closePath();
      const fill = this.spectrumPalette === 'skin'
        ? ctx.createLinearGradient(0, 0, 0, h)
        : this.horizontalPaint(ctx, mags.length, w, hi, mid, lo);
      if (this.spectrumPalette === 'skin') {
        (fill as CanvasGradient).addColorStop(0, hi);
        (fill as CanvasGradient).addColorStop(0.5, mid);
        (fill as CanvasGradient).addColorStop(1, lo);
      }
      ctx.fillStyle = fill;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const cx = (prev.x + cur.x) / 2;
      const cy = (prev.y + cur.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cx, cy);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = this.horizontalPaint(ctx, mags.length, w, hi, mid, lo);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
