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

@Component({
  selector: 'app-youtube-equalizer-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NgbModule],
  templateUrl: './youtube-equalizer-modal.component.html',
  styleUrls: ['./youtube-equalizer-modal.component.css']
})
export class YoutubeEqualizerModalComponent implements OnDestroy {
  @Input() captureBlocked = false;
  @Input() hasYoutubeVideo = false;
  /** youtube = tab-capture hints; media = TV / radio / file video. */
  @Input() variant: 'youtube' | 'media' = 'youtube';
  /** Header color: matches the page that opened the equalizer. */
  @Input() theme: YoutubeEqTheme = 'youtube';

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
      windowClass: 'yt-eq-modal',
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

  private onModalClosed(): void {
    this.stopVisualizer();
    this.modalRef = null;
  }

  private startVisualizer(): void {
    this.stopVisualizer();
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
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20, 8, 8, 0.92)';
    ctx.fillRect(0, 0, w, h);
    if (!analyser) {
      return;
    }
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const barCount = 48;
    const gap = 2;
    const barW = (w - gap * (barCount - 1)) / barCount;
    const step = Math.max(1, Math.floor(bins.length / barCount));
    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += bins[i * step + j] || 0;
      }
      const mag = sum / step / 255;
      const bh = Math.max(2, mag * h);
      const x = i * (barW + gap);
      const y = h - bh;
      const gradient = ctx.createLinearGradient(0, y, 0, h);
      gradient.addColorStop(0, '#ff6b6b');
      gradient.addColorStop(0.45, '#ff0000');
      gradient.addColorStop(1, '#7a0000');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barW, bh);
    }
  }
}
