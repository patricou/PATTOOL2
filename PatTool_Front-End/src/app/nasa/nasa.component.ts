import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';

import {
  ApiService,
  NasaApod,
  NasaEpic,
  NasaEpicImage,
  NasaMars,
  NasaMarsPhoto,
  NasaNeoFeed
} from '../services/api.service';
import { SlideshowImageSource, SlideshowModalComponent } from '../shared/slideshow-modal/slideshow-modal.component';

type NasaTab = 'apod' | 'epic' | 'mars' | 'neo';

@Component({
  selector: 'app-nasa',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, SlideshowModalComponent],
  templateUrl: './nasa.component.html',
  styleUrls: ['./nasa.component.css']
})
export class NasaComponent implements OnInit, OnDestroy {

  activeTab: NasaTab = 'apod';

  apodDate = '';
  apod: NasaApod | null = null;
  apodEmbed: SafeResourceUrl | null = null;
  apodLoading = false;
  apodError = '';

  epicDate = '';
  epic: NasaEpic | null = null;
  epicLoading = false;
  epicError = '';

  readonly rovers = ['curiosity', 'perseverance', 'opportunity', 'spirit'];
  readonly camerasByRover: Record<string, string[]> = {
    curiosity: ['FHAZ', 'RHAZ', 'MAST', 'CHEMCAM', 'MAHLI', 'MARDI', 'NAVCAM'],
    perseverance: ['NAVCAM_LEFT', 'NAVCAM_RIGHT', 'MCZ_LEFT', 'MCZ_RIGHT', 'FRONT_HAZCAM_LEFT_A', 'FRONT_HAZCAM_RIGHT_A', 'REAR_HAZCAM_LEFT', 'REAR_HAZCAM_RIGHT', 'SHERLOC_WATSON'],
    opportunity: ['FHAZ', 'RHAZ', 'NAVCAM', 'PANCAM', 'MINITES'],
    spirit: ['FHAZ', 'RHAZ', 'NAVCAM', 'PANCAM', 'MINITES']
  };
  rover = 'curiosity';
  marsDate = '';
  marsSol = '';
  marsCamera = '';
  marsPage = 1;
  mars: NasaMars | null = null;
  marsLoading = false;
  marsError = '';

  neoStart = '';
  neoEnd = '';
  neo: NasaNeoFeed | null = null;
  neoLoading = false;
  neoError = '';

  private apodSeq = 0;
  private epicSeq = 0;
  private marsSeq = 0;
  private neoSeq = 0;
  private apodSub?: Subscription;
  private epicSub?: Subscription;
  private marsSub?: Subscription;
  private neoSub?: Subscription;
  private apodTriedYesterday = false;

  @ViewChild('slideshowModalComponent') private slideshowModalComponent?: SlideshowModalComponent;

  constructor(
    private api: ApiService,
    private sanitizer: DomSanitizer,
    private translate: TranslateService
  ) {}

  ngOnInit(): void {
    const today = this.todayIso();
    this.apodDate = today;
    this.epicDate = '';
    this.neoStart = today;
    this.neoEnd = today;
    this.loadApod();
  }

  ngOnDestroy(): void {
    this.apodSub?.unsubscribe();
    this.epicSub?.unsubscribe();
    this.marsSub?.unsubscribe();
    this.neoSub?.unsubscribe();
  }

  selectTab(tab: NasaTab): void {
    this.activeTab = tab;
    if (tab === 'epic' && !this.epic && !this.epicLoading) {
      this.loadEpic();
    }
    if (tab === 'mars' && !this.mars && !this.marsLoading) {
      this.loadMars();
    }
    if (tab === 'neo' && !this.neo && !this.neoLoading) {
      this.loadNeo();
    }
  }

  loadToday(): void {
    this.apodTriedYesterday = false;
    this.apodDate = this.todayIso();
    this.loadApod();
  }

  searchApod(): void {
    this.apodTriedYesterday = false;
    this.loadApod();
  }

  loadApod(): void {
    const seq = ++this.apodSeq;
    this.apodLoading = true;
    this.apodError = '';
    this.apodSub?.unsubscribe();
    this.apodSub = this.api.getNasaApod(this.apodDate || undefined).subscribe({
      next: (apod) => {
        if (seq !== this.apodSeq) {
          return;
        }
        this.apod = apod;
        this.apodEmbed = this.videoEmbed(apod);
        this.apodLoading = false;
        this.apodTriedYesterday = false;
      },
      error: (err: HttpErrorResponse) => {
        if (seq !== this.apodSeq) {
          return;
        }
        if (!this.apodTriedYesterday && this.isNotFound(err) && this.apodDate === this.todayIso()) {
          this.apodTriedYesterday = true;
          this.apodDate = this.shiftIso(this.apodDate, -1);
          this.loadApod();
          return;
        }
        this.apod = null;
        this.apodEmbed = null;
        this.apodLoading = false;
        this.apodError = this.errorKey(err);
      }
    });
  }

  loadLatestEpic(): void {
    this.epicDate = '';
    this.loadEpic();
  }

  loadEpic(): void {
    const seq = ++this.epicSeq;
    this.epicLoading = true;
    this.epicError = '';
    this.epicSub?.unsubscribe();
    this.epicSub = this.api.getNasaEpic(this.epicDate || undefined).subscribe({
      next: (epic) => {
        if (seq !== this.epicSeq) {
          return;
        }
        this.epic = epic;
        this.epicLoading = false;
      },
      error: (err: HttpErrorResponse) => {
        if (seq !== this.epicSeq) {
          return;
        }
        this.epic = null;
        this.epicLoading = false;
        this.epicError = this.errorKey(err);
      }
    });
  }

  epicSrc(date: string, name: string): string {
    return this.api.nasaEpicImageUrl(date, name);
  }

  openApodSlideshow(): void {
    const apod = this.apod;
    const url = apod?.mediaType === 'image' ? (apod.hdUrl || apod.url) : apod?.thumbnailUrl;
    if (!apod || !url) {
      return;
    }
    this.openSlideshow([{ blobUrl: url, fileName: this.fileName(apod.title, 'jpg') }], apod.title, 0);
  }

  openEpicSlideshow(startIndex: number): void {
    const images = this.epic?.images ?? [];
    if (!images.length) {
      return;
    }
    const sources = images.map((image) => ({
      blobUrl: this.epicSrc(image.date, image.image),
      fileName: this.epicFileName(image)
    }));
    const day = this.epic?.date || images[0].date;
    const title = day
      ? `${this.translate.instant('NASA.TAB_EPIC')} · ${day}`
      : this.translate.instant('NASA.TAB_EPIC');
    this.openSlideshow(sources, title, startIndex);
  }

  openMarsSlideshow(startIndex: number): void {
    const photos = this.mars?.photos ?? [];
    if (!photos.length) {
      return;
    }
    const sources = photos.map((photo) => ({
      blobUrl: photo.imageUrl,
      fileName: this.marsFileName(photo)
    }));
    this.openSlideshow(sources, this.roverLabel(this.mars?.rover || this.rover), startIndex);
  }

  onRoverChange(): void {
    this.marsCamera = '';
    this.marsPage = 1;
    this.loadMars();
  }

  loadMars(page = 1): void {
    const seq = ++this.marsSeq;
    this.marsPage = page;
    this.marsLoading = true;
    this.marsError = '';
    const sol = this.marsDate ? undefined : this.solValue();
    this.marsSub?.unsubscribe();
    this.marsSub = this.api.getNasaMars(this.rover, sol, this.marsCamera || undefined, page, this.marsDate || undefined).subscribe({
      next: (mars) => {
        if (seq !== this.marsSeq) {
          return;
        }
        this.mars = mars;
        this.marsLoading = false;
      },
      error: (err: HttpErrorResponse) => {
        if (seq !== this.marsSeq) {
          return;
        }
        this.mars = null;
        this.marsLoading = false;
        this.marsError = this.errorKey(err);
      }
    });
  }

  loadNeo(): void {
    if (!this.neoStart || !this.neoEnd) {
      this.neoError = 'NASA.ERROR';
      return;
    }
    const seq = ++this.neoSeq;
    this.neoLoading = true;
    this.neoError = '';
    this.neoSub?.unsubscribe();
    this.neoSub = this.api.getNasaNeo(this.neoStart, this.neoEnd).subscribe({
      next: (neo) => {
        if (seq !== this.neoSeq) {
          return;
        }
        this.neo = neo;
        this.neoLoading = false;
      },
      error: (err: HttpErrorResponse) => {
        if (seq !== this.neoSeq) {
          return;
        }
        this.neo = null;
        this.neoLoading = false;
        this.neoError = this.errorKey(err);
      }
    });
  }

  cameras(): string[] {
    return this.camerasByRover[this.rover] ?? [];
  }

  hasSol(): boolean {
    return this.solValue() != null;
  }

  hasMarsPage(): boolean {
    return !!this.marsDate || this.hasSol();
  }

  roverLabel(rover: string): string {
    return rover.charAt(0).toUpperCase() + rover.slice(1);
  }

  private openSlideshow(sources: SlideshowImageSource[], title: string, startIndex: number): void {
    if (!sources.length) {
      return;
    }
    if (!this.slideshowModalComponent) {
      setTimeout(() => this.openSlideshow(sources, title, startIndex), 0);
      return;
    }
    const index = Math.min(Math.max(startIndex, 0), sources.length - 1);
    this.slideshowModalComponent.open(sources, title, false, 0, undefined, index);
  }

  private epicFileName(image: NasaEpicImage): string {
    const stamp = [image.date, image.time].filter(Boolean).join(' ');
    return this.fileName(stamp || image.image, 'png');
  }

  private marsFileName(photo: NasaMarsPhoto): string {
    const stamp = [photo.camera, photo.earthDate || String(photo.id)].filter(Boolean).join('-');
    return this.fileName(stamp || 'mars', 'jpg');
  }

  private fileName(label: string, extension: string): string {
    const safe = label.replace(/[^\w.\- ]+/g, ' ').trim().slice(0, 80) || 'nasa';
    return safe.toLowerCase().endsWith('.' + extension) ? safe : `${safe}.${extension}`;
  }

  private solValue(): number | undefined {
    const raw = String(this.marsSol ?? '').trim();
    if (!raw) {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  }

  private videoEmbed(apod: NasaApod): SafeResourceUrl | null {
    if (apod.mediaType !== 'video' || !apod.url) {
      return null;
    }
    const embed = this.toEmbedUrl(apod.url);
    return embed ? this.sanitizer.bypassSecurityTrustResourceUrl(embed) : null;
  }

  private toEmbedUrl(raw: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (parsed.pathname.startsWith('/embed/')) {
        const id = parsed.pathname.slice('/embed/'.length).split('/')[0];
        return this.youtubeEmbed(id);
      }
      return this.youtubeEmbed(parsed.searchParams.get('v'));
    }
    if (host === 'youtu.be') {
      return this.youtubeEmbed(parsed.pathname.replace(/^\//, '').split('/')[0]);
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const id = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
      return /^\d{5,12}$/.test(id) ? 'https://player.vimeo.com/video/' + id : null;
    }
    return null;
  }

  private youtubeEmbed(id: string | null): string | null {
    if (!id || !/^[\w-]{6,20}$/.test(id)) {
      return null;
    }
    return 'https://www.youtube-nocookie.com/embed/' + id;
  }

  private errorKey(err: HttpErrorResponse): string {
    const code = err?.error?.code;
    if (err?.status === 429 || code === 'quota') {
      return 'NASA.ERROR_QUOTA';
    }
    if (err?.status === 404 || code === 'not_found') {
      return 'NASA.ERROR_NOT_FOUND';
    }
    if (err?.status === 400 || code === 'bad_request') {
      return 'NASA.ERROR_BAD_REQUEST';
    }
    return 'NASA.ERROR';
  }

  private isNotFound(err: HttpErrorResponse): boolean {
    return err?.status === 404 || err?.error?.code === 'not_found';
  }

  private todayIso(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  private shiftIso(iso: string, days: number): string {
    const date = new Date(iso + 'T12:00:00');
    date.setDate(date.getDate() + days);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }
}
