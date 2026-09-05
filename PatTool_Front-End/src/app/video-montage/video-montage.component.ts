import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, forkJoin, from, of } from 'rxjs';
import { catchError, finalize, map, mergeMap, reduce, switchMap, take } from 'rxjs/operators';

import { CalendarEntry, CalendarService } from '../calendar/calendar.service';
import { EvenementsService } from '../services/evenements.service';
import { FileService } from '../services/file.service';
import { ApiService, TvRecording } from '../services/api.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { MembersService } from '../services/members.service';
import { PhotoTimelineService, TimelinePhoto } from '../services/photo-timeline.service';
import { environment } from '../../environments/environment';
import {
  VideoMontageClip,
  VideoMontageProject,
  VideoMontageService
} from './video-montage.service';
import { VideoMontageRenderService } from './video-montage-render.service';

interface LocalExportResult {
  fileName: string;
  byteLength: number;
  blob?: Blob;
  mimeType?: string;
  fileId?: string;
  attachedToEvent?: boolean;
}

interface ActivityOption {
  id: string;
  label: string;
  start: Date;
}

interface LibraryItem {
  kind: 'photo' | 'video' | 'recording';
  fileId: string;
  fileName: string;
  fileType: string;
  title: string;
  evenementId?: string;
  recordingId?: string;
  durationSec?: number;
  thumbUrl?: string | null;
}

interface TimelineItem extends VideoMontageClip {
  uiId: string;
  thumbUrl?: string | null;
  sourceDurationSec?: number;
}

const CALENDAR_CHUNK_MS = 360 * 24 * 60 * 60 * 1000;
const ACTIVITY_RANGE_YEARS = 12;
const DEFAULT_PHOTO_SEC = 3;
const IMAGE_NAME_RE = /\.(jpe?g|png|gif|webp|bmp|heic|avif|tif|tiff)$/i;
const VIDEO_NAME_RE = /\.(mp4|webm|ogg|ogv|mov|avi|mkv|m4v|3gp)$/i;

@Component({
  selector: 'app-video-montage',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  providers: [EvenementsService, PhotoTimelineService],
  templateUrl: './video-montage.component.html',
  styleUrls: ['./video-montage.component.css']
})
export class VideoMontageComponent implements OnDestroy {
  private readonly montageService = inject(VideoMontageService);
  private readonly renderService = inject(VideoMontageRenderService);
  private readonly calendarService = inject(CalendarService);
  private readonly evenementsService = inject(EvenementsService);
  private readonly fileService = inject(FileService);
  private readonly api = inject(ApiService);
  private readonly keycloak = inject(KeycloakService);
  private readonly membersService = inject(MembersService);
  private readonly photoTimeline = inject(PhotoTimelineService);
  private readonly ngZone = inject(NgZone);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly route = inject(ActivatedRoute);

  @ViewChild('previewVideo') previewVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('trimVideo') trimVideo?: ElementRef<HTMLVideoElement>;

  projects: VideoMontageProject[] = [];
  currentProjectId: string | null = null;
  title = '';
  libraryTab: 'activities' | 'recordings' = 'activities';
  activities: ActivityOption[] = [];
  filteredActivities: ActivityOption[] = [];
  activityFilter = '';
  selectedEventId: string | null = null;
  libraryPhotos: LibraryItem[] = [];
  libraryVideos: LibraryItem[] = [];
  recordings: LibraryItem[] = [];
  timeline: TimelineItem[] = [];
  photoDefaultDurationSec = DEFAULT_PHOTO_SEC;
  width = 1280;
  height = 720;
  attachToEvent = false;
  exportClipIndex = 0;
  exportClipCount = 0;

  loadingProjects = false;
  loadingProject = false;
  loadingActivities = false;
  loadingMedia = false;
  loadingRecordings = false;
  saving = false;
  deleting = false;
  exporting = false;
  previewPlaying = false;

  errorKey = '';
  messageKey = '';
  exportResult: LocalExportResult | null = null;
  accessToken = '';
  private exportAbort: AbortController | null = null;

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewIndex = 0;
  private previewPlayGen = 0;
  private objectUrls: string[] = [];
  private previewBlobUrls: string[] = [];
  private thumbCache = new Map<string, string>();
  private mediaLoadGen = 0;
  private alive = true;
  private downloadTimers: ReturnType<typeof setTimeout>[] = [];
  private pendingDownloadUrls: string[] = [];
  private previewListeners: AbortController | null = null;
  previewPhotoUrl: string | null = null;
  previewVideoUrl: string | null = null;
  previewKind: 'photo' | 'video' | null = null;
  previewTitle = '';

  musicFileName = '';
  musicVolume = 0.7;
  musicLoop = true;
  keepSourceAudio = false;
  private musicObjectUrl: string | null = null;
  private musicBuffer: ArrayBuffer | null = null;
  private previewMusic: HTMLAudioElement | null = null;

  trimOpen = false;
  trimItem: LibraryItem | null = null;
  trimEditIndex: number | null = null;
  trimStart = 0;
  trimEnd = 8;
  trimSourceDuration = 0;

  readonly resolutions: Array<{ w: number; h: number; labelKey: string }> = [
    { w: 1280, h: 720, labelKey: 'VIDEO_MONTAGE.RES_720' },
    { w: 1920, h: 1080, labelKey: 'VIDEO_MONTAGE.RES_1080' }
  ];

  constructor() {
    this.title = this.translate.instant('VIDEO_MONTAGE.DEFAULT_TITLE');
    from(this.keycloak.getToken())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (token) => {
          this.accessToken = token || '';
        },
        error: () => {
          this.accessToken = '';
        }
      });
    this.loadProjects();
    this.loadActivities();
    this.loadRecordings();
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const eventId = (params.get('event') || '').trim();
      if (eventId) {
        this.selectedEventId = eventId;
        this.attachToEvent = true;
        this.loadEventMedia(eventId);
      }
    });
  }

  ngOnDestroy(): void {
    this.alive = false;
    this.exportAbort?.abort();
    this.stopPreview();
    this.closeTrim();
    this.clearMusic();
    this.revokeObjectUrls();
    this.revokePreviewBlobs();
    for (const t of this.downloadTimers) {
      clearTimeout(t);
    }
    this.downloadTimers = [];
    for (const url of this.pendingDownloadUrls) {
      URL.revokeObjectURL(url);
    }
    this.pendingDownloadUrls = [];
  }

  get totalDurationSec(): number {
    return this.timeline.reduce((sum, clip) => sum + this.clipDuration(clip), 0);
  }

  get selectedActivityLabel(): string {
    const found = this.activities.find((a) => a.id === this.selectedEventId);
    return found?.label || '';
  }

  get canExport(): boolean {
    return this.timeline.length > 0 && !this.busy && this.renderService.isSupported();
  }

  get busy(): boolean {
    return this.loadingProject || this.saving || this.deleting || this.exporting;
  }

  get busyKey(): string {
    if (this.exporting) {
      return 'VIDEO_MONTAGE.EXPORTING';
    }
    if (this.saving) {
      return 'VIDEO_MONTAGE.SAVING';
    }
    if (this.deleting) {
      return 'VIDEO_MONTAGE.DELETING';
    }
    if (this.loadingProject) {
      return 'VIDEO_MONTAGE.LOADING_PROJECT';
    }
    return 'VIDEO_MONTAGE.LOADING';
  }

  onProjectSelected(id: string): void {
    if (!id) {
      this.newProject();
      return;
    }
    this.loadingProject = true;
    this.clearFeedback();
    this.montageService
      .getOne(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          if (!this.loadingMedia) {
            this.loadingProject = false;
          }
        })
      )
      .subscribe({
        next: (doc) => this.applyProject(doc),
        error: () => {
          this.errorKey = 'VIDEO_MONTAGE.ERR_LOAD';
        }
      });
  }

  newProject(): void {
    this.stopPreview();
    this.currentProjectId = null;
    this.title = this.translate.instant('VIDEO_MONTAGE.DEFAULT_TITLE');
    this.timeline = [];
    this.exportResult = null;
    this.photoDefaultDurationSec = DEFAULT_PHOTO_SEC;
    this.width = 1280;
    this.height = 720;
    this.clearMusic();
    this.clearFeedback();
  }

  saveProject(): void {
    const body: VideoMontageProject = {
      title: (this.title || '').trim() || this.translate.instant('VIDEO_MONTAGE.DEFAULT_TITLE'),
      evenementId: this.selectedEventId,
      clips: this.timeline.map((c) => this.toPersistClip(c)),
      width: this.width,
      height: this.height,
      photoDefaultDurationSec: this.photoDefaultDurationSec
    };
    this.saving = true;
    this.clearFeedback();
    const req$ = this.currentProjectId
      ? this.montageService.update(this.currentProjectId, body)
      : this.montageService.create(body);
    req$
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.saving = false;
        })
      )
      .subscribe({
        next: (doc) => {
          this.currentProjectId = doc.id || null;
          this.messageKey = 'VIDEO_MONTAGE.SAVED';
          this.loadProjects();
        },
        error: () => {
          this.errorKey = 'VIDEO_MONTAGE.ERR_SAVE';
        }
      });
  }

  deleteProject(): void {
    if (!this.currentProjectId) {
      return;
    }
    if (!window.confirm(this.translate.instant('VIDEO_MONTAGE.CONFIRM_DELETE'))) {
      return;
    }
    this.deleting = true;
    this.clearFeedback();
    this.montageService
      .delete(this.currentProjectId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.deleting = false;
        })
      )
      .subscribe({
        next: () => {
          this.messageKey = 'VIDEO_MONTAGE.DELETED';
          this.newProject();
          this.loadProjects();
        },
        error: () => {
          this.errorKey = 'VIDEO_MONTAGE.ERR_DELETE';
        }
      });
  }

  onActivityFilterChange(): void {
    const q = this.activityFilter.trim().toLocaleLowerCase();
    this.filteredActivities = !q
      ? this.activities
      : this.activities.filter((a) => a.label.toLocaleLowerCase().includes(q));
  }

  selectActivity(id: string): void {
    this.selectedEventId = id || null;
    this.libraryPhotos = [];
    this.libraryVideos = [];
    if (id) {
      this.loadEventMedia(id);
    }
  }

  addLibraryItem(item: LibraryItem): void {
    if (item.kind !== 'photo') {
      this.openTrim(item);
      return;
    }
    if (this.timeline.some((c) => c.fileId === item.fileId && c.kind === 'photo')) {
      return;
    }
    this.timeline.push(this.toTimelineItem(item));
    this.exportResult = null;
  }

  addAll(items: LibraryItem[]): void {
    for (const item of items) {
      this.addLibraryItem(item);
    }
  }

  removeClip(index: number): void {
    this.timeline.splice(index, 1);
    this.exportResult = null;
  }

  moveClip(index: number, delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= this.timeline.length) {
      return;
    }
    const [item] = this.timeline.splice(index, 1);
    this.timeline.splice(next, 0, item);
  }

  onClipDragStart(event: DragEvent, index: number): void {
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  onClipDrop(event: DragEvent, targetIndex: number): void {
    event.preventDefault();
    const raw = event.dataTransfer?.getData('text/plain');
    const from = raw != null ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(from) || from === targetIndex) {
      return;
    }
    const [item] = this.timeline.splice(from, 1);
    const insertAt = from < targetIndex ? targetIndex - 1 : targetIndex;
    this.timeline.splice(insertAt, 0, item);
  }

  clipDuration(clip: VideoMontageClip): number {
    const d = clip.durationSec;
    if (d != null && d > 0) {
      return d;
    }
    return clip.kind === 'photo' ? this.photoDefaultDurationSec : 1;
  }

  formatClock(sec: number): string {
    const totalTenths = Math.round(Math.max(0, sec || 0) * 10);
    const m = Math.floor(totalTenths / 600);
    const rem = totalTenths % 600;
    const whole = Math.floor(rem / 10);
    const tenth = rem % 10;
    return `${m}:${whole.toString().padStart(2, '0')}.${tenth}`;
  }

  get trimMax(): number {
    return Math.max(this.trimSourceDuration || 0, this.trimEnd, 0.5);
  }

  clipEnd(clip: TimelineItem): number {
    return (clip.startSec || 0) + this.clipDuration(clip);
  }

  openTrim(item: LibraryItem, editIndex: number | null = null): void {
    this.trimItem = item;
    this.trimEditIndex = editIndex;
    if (editIndex != null) {
      const clip = this.timeline[editIndex];
      this.trimStart = clip.startSec || 0;
      this.trimEnd = this.clipEnd(clip);
      this.trimSourceDuration = clip.sourceDurationSec || item.durationSec || this.trimEnd;
    } else {
      this.trimStart = 0;
      this.trimSourceDuration = item.durationSec || 0;
      this.trimEnd = item.durationSec && item.durationSec > 0.5 ? item.durationSec : 8;
    }
    this.trimOpen = true;
  }

  openTrimForClip(index: number): void {
    const clip = this.timeline[index];
    this.openTrim(
      {
        kind: clip.kind,
        fileId: clip.fileId,
        fileName: clip.fileName || '',
        fileType: clip.fileType || '',
        title: clip.title || clip.fileName || '',
        evenementId: clip.evenementId || undefined,
        recordingId: clip.recordingId || undefined,
        durationSec: clip.sourceDurationSec || this.clipEnd(clip)
      },
      index
    );
  }

  closeTrim(): void {
    this.releaseMediaElement(this.trimVideo?.nativeElement);
    this.trimOpen = false;
    this.trimItem = null;
    this.trimEditIndex = null;
  }

  onTrimMetadata(ev?: Event): void {
    const video = (ev?.target as HTMLVideoElement) || this.trimVideo?.nativeElement;
    const dur = video?.duration;
    if (!dur || !Number.isFinite(dur) || dur <= 0) {
      return;
    }
    this.trimSourceDuration = dur;
    if (this.trimEditIndex == null) {
      this.trimStart = 0;
      this.trimEnd = dur;
    } else {
      this.trimEnd = Math.min(this.trimEnd, dur);
      this.trimStart = Math.min(this.trimStart, Math.max(0, dur - 0.5));
    }
  }

  onTrimStart(value: number | string): void {
    const v = Number(value);
    this.trimStart = Math.max(0, Math.min(v, this.trimEnd - 0.4));
    this.seekTrim(this.trimStart);
  }

  onTrimEnd(value: number | string): void {
    const v = Number(value);
    const max = this.trimMax;
    this.trimEnd = Math.max(this.trimStart + 0.4, Math.min(v, max));
    this.seekTrim(this.trimEnd);
  }

  confirmTrim(): void {
    if (!this.trimItem || this.trimEnd - this.trimStart < 0.4) {
      return;
    }
    const start = this.trimStart;
    const duration = this.trimEnd - this.trimStart;
    if (this.trimEditIndex != null) {
      const clip = this.timeline[this.trimEditIndex];
      clip.startSec = start;
      clip.durationSec = duration;
      clip.sourceDurationSec = this.trimSourceDuration || clip.sourceDurationSec;
    } else {
      const item = this.toTimelineItem(this.trimItem);
      item.startSec = start;
      item.durationSec = duration;
      item.sourceDurationSec = this.trimSourceDuration || this.trimItem.durationSec;
      this.timeline.push(item);
    }
    this.exportResult = null;
    this.closeTrim();
  }

  onMusicFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.clearMusic(false);
    this.musicFileName = file.name;
    this.musicObjectUrl = URL.createObjectURL(file);
    void file.arrayBuffer().then((buf) => {
      if (!this.alive) {
        return;
      }
      this.musicBuffer = buf;
    });
  }

  clearMusic(resetName = true): void {
    this.stopPreviewMusic();
    if (this.musicObjectUrl) {
      URL.revokeObjectURL(this.musicObjectUrl);
    }
    this.musicObjectUrl = null;
    this.musicBuffer = null;
    if (resetName) {
      this.musicFileName = '';
    }
  }

  formatDuration(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${r.toString().padStart(2, '0')}` : `${r}s`;
  }

  private seekTrim(time: number): void {
    const video = this.trimVideo?.nativeElement;
    if (!video || !Number.isFinite(time)) {
      return;
    }
    try {
      video.currentTime = time;
    } catch {
      // metadata not ready
    }
  }

  private startPreviewMusic(): void {
    this.stopPreviewMusic();
    if (!this.musicObjectUrl) {
      return;
    }
    const audio = new Audio(this.musicObjectUrl);
    audio.loop = this.musicLoop;
    audio.volume = Math.max(0, Math.min(1, this.musicVolume));
    void audio.play().catch(() => undefined);
    this.previewMusic = audio;
  }

  private stopPreviewMusic(): void {
    if (!this.previewMusic) {
      return;
    }
    this.releaseMediaElement(this.previewMusic);
    this.previewMusic = null;
  }

  setResolution(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  playPreview(): void {
    if (!this.timeline.length) {
      return;
    }
    this.stopPreview();
    this.previewPlaying = true;
    this.previewIndex = 0;
    this.startPreviewMusic();
    this.playClipAt(0);
  }

  stopPreview(): void {
    this.previewPlayGen++;
    this.previewPlaying = false;
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewListeners?.abort();
    this.previewListeners = null;
    this.resetPreviewVideo();
    this.stopPreviewMusic();
    this.revokePreviewBlobs();
    this.previewKind = null;
    this.previewPhotoUrl = null;
    this.previewVideoUrl = null;
    this.previewTitle = '';
  }

  exportMontage(): void {
    if (!this.canExport) {
      return;
    }
    this.stopPreview();
    this.exporting = true;
    this.clearFeedback();
    this.exportResult = null;
    this.exportClipIndex = 0;
    this.exportClipCount = this.timeline.length;
    this.exportAbort?.abort();
    const abort = new AbortController();
    this.exportAbort = abort;
    const title = (this.title || '').trim() || this.translate.instant('VIDEO_MONTAGE.DEFAULT_TITLE');
    const clips = this.timeline.map((c) => this.toPersistClip(c));
    void this.renderService
      .render({
        title,
        width: this.width,
        height: this.height,
        clips,
        keepSourceAudio: this.keepSourceAudio,
        music: this.musicBuffer
          ? {
              buffer: this.musicBuffer.slice(0),
              volume: this.musicVolume,
              loop: this.musicLoop
            }
          : undefined,
        signal: abort.signal,
        onProgress: (current, total) => {
          this.ngZone.run(() => {
            this.exportClipIndex = current;
            this.exportClipCount = total;
          });
        }
      })
      .then(async (rendered) => {
        if (abort.signal.aborted) {
          return;
        }
        await this.ngZone.run(async () => {
          let attached = false;
          if (this.attachToEvent && this.selectedEventId) {
            attached = await this.uploadToEvent(rendered.blob, rendered.fileName);
          }
          this.exportResult = {
            fileName: rendered.fileName,
            byteLength: rendered.blob.size,
            blob: rendered.blob,
            mimeType: rendered.mimeType,
            attachedToEvent: attached
          };
          this.messageKey = attached ? 'VIDEO_MONTAGE.EXPORT_ATTACHED' : 'VIDEO_MONTAGE.EXPORT_DONE';
          this.downloadBlob(rendered.blob, rendered.fileName);
        });
      })
      .catch((err: unknown) => {
        this.ngZone.run(() => {
          if (abort.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          this.errorKey =
            (err as { message?: string })?.message === 'unsupported'
              ? 'VIDEO_MONTAGE.ERR_EXPORT_UNSUPPORTED'
              : 'VIDEO_MONTAGE.ERR_EXPORT';
        });
      })
      .finally(() => {
        this.ngZone.run(() => {
          if (this.exportAbort === abort) {
            this.exportAbort = null;
          }
          this.exporting = false;
          this.exportClipIndex = 0;
        });
      });
  }

  downloadExport(): void {
    const result = this.exportResult;
    if (!result) {
      return;
    }
    if (result.blob) {
      this.downloadBlob(result.blob, result.fileName);
      return;
    }
    if (!result.fileId) {
      return;
    }
    this.fileService.getVideoWithMetadata(result.fileId, 'high').pipe(take(1), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        const blob = new Blob([res.buffer], { type: result.mimeType || 'video/mp4' });
        this.downloadBlob(blob, result.fileName || 'montage.mp4');
      },
      error: () => {
        this.errorKey = 'VIDEO_MONTAGE.ERR_DOWNLOAD';
      }
    });
  }

  playbackUrl(fileId: string, quality: 'high' | 'low' = 'high'): string {
    const url = `${environment.API_URL}video/${fileId}`;
    const params = new URLSearchParams();
    params.set('quality', quality);
    if (this.accessToken) {
      params.set('access_token', this.accessToken);
    }
    return `${url}?${params.toString()}`;
  }

  trackByUiId(_index: number, item: TimelineItem): string {
    return item.uiId;
  }

  trackByFileId(_index: number, item: LibraryItem): string {
    return item.fileId;
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    this.pendingDownloadUrls.push(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'montage.webm';
    a.click();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      this.pendingDownloadUrls = this.pendingDownloadUrls.filter((u) => u !== url);
    }, 30_000);
    this.downloadTimers.push(timer);
  }

  private async uploadToEvent(blob: Blob, fileName: string): Promise<boolean> {
    const eventId = this.selectedEventId;
    if (!eventId) {
      return false;
    }
    try {
      const user = await firstValueFrom(this.membersService.getUserId({ skipGeolocation: true }));
      if (!user?.id) {
        return false;
      }
      const file = new File([blob], fileName, { type: blob.type || 'video/webm' });
      const form = new FormData();
      form.append('file', file, file.name);
      const uploadUrl = `${environment.API_URL4FILE}/${user.id}/${eventId}`;
      await firstValueFrom(this.fileService.postFileToUrl(form, user, uploadUrl));
      return true;
    } catch {
      return false;
    }
  }

  private loadProjects(): void {
    this.loadingProjects = true;
    this.montageService
      .list()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.loadingProjects = false;
        })
      )
      .subscribe({
        next: (docs) => {
          this.projects = docs || [];
        },
        error: () => {
          this.projects = [];
        }
      });
  }

  private loadActivities(): void {
    this.loadingActivities = true;
    const rangeFrom = new Date();
    rangeFrom.setFullYear(rangeFrom.getFullYear() - ACTIVITY_RANGE_YEARS);
    const rangeTo = new Date();
    rangeTo.setFullYear(rangeTo.getFullYear() + 1);
    const chunks: Array<{ start: Date; end: Date }> = [];
    let cursor = rangeFrom.getTime();
    const endMs = rangeTo.getTime();
    while (cursor < endMs) {
      const next = Math.min(cursor + CALENDAR_CHUNK_MS, endMs);
      chunks.push({ start: new Date(cursor), end: new Date(next) });
      cursor = next;
    }
    from(chunks)
      .pipe(
        mergeMap(
          (ch) =>
            this.calendarService.getEntries(ch.start, ch.end).pipe(
              map((rows) => rows || []),
              catchError(() => of([] as CalendarEntry[]))
            ),
          4
        ),
        reduce((acc, rows) => {
          for (const e of rows) {
            if (e.kind === 'ACTIVITY' && e.id) {
              acc.set(e.id, e);
            }
          }
          return acc;
        }, new Map<string, CalendarEntry>()),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.loadingActivities = false;
        })
      )
      .subscribe({
        next: (merged) => {
          this.activities = Array.from(merged.values())
            .map((e) => ({
              id: e.id,
              label: this.formatActivityLabel(e),
              start: new Date(e.start)
            }))
            .sort((a, b) => b.start.getTime() - a.start.getTime());
          this.filteredActivities = this.activities;
        },
        error: () => {
          this.activities = [];
          this.filteredActivities = [];
        }
      });
  }

  private loadEventMedia(eventId: string): void {
    const gen = ++this.mediaLoadGen;
    this.loadingMedia = true;
    this.libraryPhotos = [];
    this.libraryVideos = [];
    this.membersService
      .getUserId({ skipGeolocation: true })
      .pipe(
        switchMap((user) =>
          forkJoin({
            timeline: this.photoTimeline.getTimeline(user.id, 0, 1, undefined, undefined, eventId).pipe(
              catchError(() => of({ groups: [] as Array<{ eventId?: string; photos?: TimelinePhoto[]; videos?: TimelinePhoto[] }> }))
            ),
            files: this.evenementsService.getEventFiles(eventId).pipe(catchError(() => of([] as any[])))
          })
        ),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          if (gen === this.mediaLoadGen) {
            this.loadingMedia = false;
            this.loadingProject = false;
          }
        })
      )
      .subscribe({
        next: ({ timeline, files }) => {
          if (gen !== this.mediaLoadGen) {
            return;
          }
          const group =
            (timeline.groups || []).find((g) => g.eventId === eventId) || timeline.groups?.[0] || null;
          const photos = new Map<string, LibraryItem>();
          const videos = new Map<string, LibraryItem>();
          for (const photo of group?.photos || []) {
            this.addGridPhoto(photos, photo, eventId);
          }
          for (const video of group?.videos || []) {
            this.addGridVideo(videos, video, eventId);
          }
          for (const f of files || []) {
            const fileId = String(f.fieldId || f.fileId || '').trim();
            const fileName = String(f.fileName || f.displayName || '').trim();
            const fileType = String(f.fileType || '').trim();
            if (!fileId || this.isYoutube(fileId, fileType)) {
              continue;
            }
            if (this.isImage(fileName, fileType)) {
              this.putLibraryItem(photos, {
                kind: 'photo',
                fileId,
                fileName,
                fileType,
                title: fileName,
                evenementId: eventId
              });
            } else if (this.isVideo(fileName, fileType)) {
              this.putLibraryItem(videos, {
                kind: 'video',
                fileId,
                fileName,
                fileType,
                title: fileName,
                evenementId: eventId
              });
            }
          }
          const photoList = Array.from(photos.values()).sort((a, b) =>
            a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' })
          );
          this.libraryPhotos = photoList;
          this.libraryVideos = Array.from(videos.values());
          const keep = new Set(photoList.map((p) => p.fileId));
          for (const clip of this.timeline) {
            if (clip.fileId) {
              keep.add(clip.fileId);
            }
          }
          this.pruneThumbCache(keep);
          for (const item of photoList) {
            this.ensureThumb(item);
          }
        },
        error: () => {
          if (gen === this.mediaLoadGen) {
            this.errorKey = 'VIDEO_MONTAGE.ERR_MEDIA';
          }
        }
      });
  }

  private addGridPhoto(target: Map<string, LibraryItem>, photo: TimelinePhoto, eventId: string): void {
    const fileId = String(photo.fileId || '').trim();
    if (!fileId || photo.youtubeVideoId || this.isYoutube(fileId, photo.fileType || '')) {
      return;
    }
    this.putLibraryItem(target, {
      kind: 'photo',
      fileId,
      fileName: photo.fileName || '',
      fileType: photo.fileType || '',
      title: photo.fileName || '',
      evenementId: eventId
    });
  }

  private addGridVideo(target: Map<string, LibraryItem>, video: TimelinePhoto, eventId: string): void {
    const fileId = String(video.fileId || '').trim();
    if (!fileId || video.youtubeVideoId || video.externalUrl || this.isYoutube(fileId, video.fileType || '')) {
      return;
    }
    this.putLibraryItem(target, {
      kind: 'video',
      fileId,
      fileName: video.fileName || '',
      fileType: video.fileType || 'video/mp4',
      title: video.fileName || '',
      evenementId: eventId
    });
  }

  private putLibraryItem(target: Map<string, LibraryItem>, item: LibraryItem): void {
    if (!item.fileId || target.has(item.fileId)) {
      return;
    }
    target.set(item.fileId, item);
  }

  private loadRecordings(): void {
    this.loadingRecordings = true;
    this.api
      .getTvRecordings()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => {
          this.loadingRecordings = false;
        })
      )
      .subscribe({
        next: (rows) => {
          this.recordings = (rows || [])
            .filter((r) => r.status === 'DONE' && r.gridFsFileId)
            .map((r) => this.recordingToItem(r));
        },
        error: () => {
          this.recordings = [];
        }
      });
  }

  private recordingToItem(r: TvRecording): LibraryItem {
    return {
      kind: 'recording',
      fileId: r.gridFsFileId || '',
      fileName: r.fileName || `${r.channelName || 'TV'}.webm`,
      fileType: r.contentType || 'video/webm',
      title: r.channelName || r.fileName || 'TV',
      recordingId: r.id,
      durationSec: r.actualDurationSec || r.durationSec || 30
    };
  }

  private ensureThumb(item: LibraryItem): void {
    const cached = this.thumbCache.get(item.fileId);
    if (cached) {
      item.thumbUrl = cached;
      return;
    }
    this.fileService.getFileWallPreview(item.fileId, 320).pipe(take(1), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (buf) => {
        if (!this.alive) {
          return;
        }
        const url = URL.createObjectURL(new Blob([buf], { type: item.fileType || 'image/jpeg' }));
        this.objectUrls.push(url);
        this.thumbCache.set(item.fileId, url);
        item.thumbUrl = url;
        const onTimeline = this.timeline.find((c) => c.fileId === item.fileId);
        if (onTimeline) {
          onTimeline.thumbUrl = url;
        }
      },
      error: () => {
        item.thumbUrl = null;
      }
    });
  }

  private applyProject(doc: VideoMontageProject): void {
    this.currentProjectId = doc.id || null;
    this.title = doc.title || this.translate.instant('VIDEO_MONTAGE.DEFAULT_TITLE');
    this.selectedEventId = doc.evenementId || null;
    this.width = doc.width || 1280;
    this.height = doc.height || 720;
    this.photoDefaultDurationSec = doc.photoDefaultDurationSec || DEFAULT_PHOTO_SEC;
    this.timeline = (doc.clips || []).map((c) => {
      const item = this.toTimelineItem({
        kind: c.kind,
        fileId: c.fileId,
        fileName: c.fileName || '',
        fileType: c.fileType || '',
        title: c.title || c.fileName || '',
        evenementId: c.evenementId || undefined,
        recordingId: c.recordingId || undefined,
        durationSec: c.durationSec || undefined
      });
      item.startSec = c.startSec || 0;
      item.durationSec = c.durationSec || item.durationSec;
      item.sourceDurationSec = (c.startSec || 0) + (c.durationSec || item.durationSec || 0);
      if (item.kind === 'photo') {
        this.ensureThumb({
          kind: 'photo',
          fileId: item.fileId,
          fileName: item.fileName || '',
          fileType: item.fileType || '',
          title: item.title || ''
        });
      }
      return item;
    });
    if (this.selectedEventId) {
      this.loadEventMedia(this.selectedEventId);
    }
    this.exportResult = doc.outputGridFsFileId
      ? {
          fileId: doc.outputGridFsFileId,
          fileName: doc.outputFileName || 'montage.webm',
          byteLength: doc.outputByteLength || 0
        }
      : null;
  }

  private toTimelineItem(item: LibraryItem): TimelineItem {
    return {
      uiId: `${item.kind}-${item.fileId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: item.kind,
      fileId: item.fileId,
      evenementId: item.evenementId || null,
      recordingId: item.recordingId || null,
      fileName: item.fileName,
      fileType: item.fileType,
      title: item.title,
      durationSec: item.kind === 'photo' ? this.photoDefaultDurationSec : item.durationSec || 8,
      startSec: 0,
      thumbUrl: item.thumbUrl || this.thumbCache.get(item.fileId) || null,
      sourceDurationSec: item.durationSec
    };
  }

  private toPersistClip(clip: TimelineItem): VideoMontageClip {
    return {
      kind: clip.kind,
      fileId: clip.fileId,
      evenementId: clip.evenementId || null,
      recordingId: clip.recordingId || null,
      fileName: clip.fileName,
      fileType: clip.fileType,
      title: clip.title,
      durationSec: this.clipDuration(clip),
      startSec: clip.startSec || 0
    };
  }

  private playClipAt(index: number): void {
    if (!this.previewPlaying || index >= this.timeline.length) {
      this.stopPreview();
      return;
    }
    const gen = this.previewPlayGen;
    const clip = this.timeline[index];
    this.previewIndex = index;
    this.previewTitle = clip.title || clip.fileName || '';
    const durationMs = this.clipDuration(clip) * 1000;
    if (clip.kind === 'photo') {
      this.pausePreviewVideo();
      this.previewKind = 'photo';
      this.previewVideoUrl = null;
      this.revokePreviewBlobs();
      this.previewPhotoUrl = clip.thumbUrl || this.thumbCache.get(clip.fileId) || null;
      if (!this.previewPhotoUrl) {
        this.fileService.getFileWallPreview(clip.fileId, 960).pipe(take(1), takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (buf) => {
            if (gen !== this.previewPlayGen || !this.alive) {
              return;
            }
            const url = URL.createObjectURL(new Blob([buf], { type: clip.fileType || 'image/jpeg' }));
            this.previewBlobUrls.push(url);
            this.previewPhotoUrl = url;
          }
        });
      }
      this.previewTimer = setTimeout(() => this.playClipAt(index + 1), durationMs);
      return;
    }
    this.startPreviewVideo(clip, durationMs, index, gen);
  }

  private pausePreviewVideo(): void {
    const video = this.previewVideo?.nativeElement;
    if (video && !video.paused) {
      video.pause();
    }
  }

  private resetPreviewVideo(): void {
    this.releaseMediaElement(this.previewVideo?.nativeElement);
  }

  private releaseMediaElement(el?: HTMLMediaElement | null): void {
    if (!el) {
      return;
    }
    try {
      el.pause();
    } catch {
      // ignore
    }
    el.removeAttribute('src');
    el.srcObject = null;
    try {
      el.load();
    } catch {
      // ignore
    }
  }

  private pruneThumbCache(keepIds: Set<string>): void {
    for (const [id, url] of [...this.thumbCache.entries()]) {
      if (keepIds.has(id)) {
        continue;
      }
      URL.revokeObjectURL(url);
      this.thumbCache.delete(id);
      const idx = this.objectUrls.indexOf(url);
      if (idx >= 0) {
        this.objectUrls.splice(idx, 1);
      }
    }
  }

  private revokePreviewBlobs(): void {
    for (const url of this.previewBlobUrls) {
      URL.revokeObjectURL(url);
    }
    this.previewBlobUrls = [];
  }

  private startPreviewVideo(clip: TimelineItem, durationMs: number, index: number, gen: number): void {
    this.previewKind = 'video';
    this.previewPhotoUrl = null;
    const url = this.playbackUrl(clip.fileId);
    this.previewVideoUrl = url;
    this.cdr.detectChanges();
    const video = this.previewVideo?.nativeElement;
    if (!video) {
      this.previewTimer = setTimeout(() => {
        if (gen === this.previewPlayGen && this.previewPlaying) {
          this.startPreviewVideo(clip, durationMs, index, gen);
        }
      }, 50);
      return;
    }
    this.previewListeners?.abort();
    const listeners = new AbortController();
    this.previewListeners = listeners;
    const signal = listeners.signal;
    video.muted = true;
    const start = clip.startSec || 0;
    const playNow = () => {
      if (gen !== this.previewPlayGen || !this.previewPlaying) {
        return;
      }
      void video.play().catch(() => {
        video.muted = true;
        void video.play().catch(() => undefined);
      });
    };
    const begin = () => {
      if (gen !== this.previewPlayGen || !this.previewPlaying) {
        return;
      }
      if (start > 0.05) {
        video.addEventListener('seeked', () => playNow(), { once: true, signal });
        try {
          video.currentTime = start;
        } catch {
          playNow();
        }
        return;
      }
      playNow();
    };
    if (video.getAttribute('src') !== url) {
      video.src = url;
      video.load();
    }
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      begin();
    } else {
      video.addEventListener('loadedmetadata', begin, { once: true, signal });
      video.addEventListener(
        'error',
        () => {
          if (gen === this.previewPlayGen && this.previewPlaying) {
            this.playClipAt(index + 1);
          }
        },
        { once: true, signal }
      );
    }
    this.previewTimer = setTimeout(() => {
      if (gen !== this.previewPlayGen) {
        return;
      }
      video.pause();
      this.playClipAt(index + 1);
    }, durationMs);
  }

  private formatActivityLabel(e: CalendarEntry): string {
    const d = e.start ? new Date(e.start) : null;
    const datePart = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : '';
    return datePart ? `${e.title} — ${datePart}` : e.title;
  }

  private isYoutube(fileId: string, fileType: string): boolean {
    return fileType.toLowerCase() === 'video/youtube' || fileId.startsWith('yt:');
  }

  private isImage(fileName: string, fileType: string): boolean {
    if (fileType.toLowerCase().startsWith('image/')) {
      return true;
    }
    return IMAGE_NAME_RE.test(fileName);
  }

  private isVideo(fileName: string, fileType: string): boolean {
    const t = fileType.toLowerCase();
    if (t.startsWith('video/') && t !== 'video/youtube') {
      return true;
    }
    return VIDEO_NAME_RE.test(fileName);
  }

  private clearFeedback(): void {
    this.errorKey = '';
    this.messageKey = '';
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this.objectUrls = [];
    this.thumbCache.clear();
  }
}
