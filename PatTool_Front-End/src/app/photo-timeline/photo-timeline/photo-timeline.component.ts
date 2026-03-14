import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener, TemplateRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from '../../shared/slideshow-modal/slideshow-modal.module';
import { SlideshowModalComponent, SlideshowImageSource, SlideshowAddToDbEvent } from '../../shared/slideshow-modal/slideshow-modal.component';
import { VideoshowModalModule } from '../../shared/videoshow-modal/videoshow-modal.module';
import { VideoshowModalComponent, VideoshowVideoSource } from '../../shared/videoshow-modal/videoshow-modal.component';
import { PhotoTimelineService, TimelineResponse, TimelineGroup, TimelinePhoto, FsPhotoLink } from '../../services/photo-timeline.service';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { Subscription } from 'rxjs';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { environment } from '../../../environments/environment';

const BUFFER_AHEAD = 3;
/** Hauteur approximative d'un bloc événement (px) pour précharger 3 événements en avance. */
const EVENT_BLOCK_HEIGHT_PX = 500;
const PREFETCH_EVENTS_AHEAD = 3;

export interface GroupMediaItem {
    type: 'photo' | 'video';
    item: TimelinePhoto;
    photoIndex?: number; // index parmi les photos uniquement (pour le slideshow)
}
const SCROLL_THRESHOLD_PX = Math.max(400, PREFETCH_EVENTS_AHEAD * EVENT_BLOCK_HEIGHT_PX);

@Component({
    selector: 'app-photo-timeline',
    templateUrl: './photo-timeline.component.html',
    styleUrls: ['./photo-timeline.component.css'],
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        RouterModule,
        TranslateModule,
        NgbModule,
        NavigationButtonsModule,
        SlideshowModalModule,
        VideoshowModalModule
    ]
})
export class PhotoTimelineComponent implements OnInit, OnDestroy {

    @ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
    @ViewChild('videoshowModalComponent') videoshowModalComponent!: VideoshowModalComponent;
    @ViewChild('scrollSentinel') scrollSentinel!: ElementRef;
    @ViewChild('imageCompressionModal') imageCompressionModal!: TemplateRef<any>;

    visibleGroups: TimelineGroup[] = [];
    bufferedGroups: TimelineGroup[] = [];
    bufferedVideoGroups: TimelineGroup[] = [];
    onThisDay: TimelinePhoto[] = [];

    isLoading = true;
    isFetching = false;
    isFetchingVideos = false;
    errorMessage = '';
    searchFilter = '';
    hasMore = true;
    hasMoreVideos = true;

    compressImages = true;
    isUploading = false;
    uploadMessage = '';
    uploadSuccess = false;

    thumbnailCache: Map<string, string> = new Map();
    loadingThumbnails: Set<string> = new Set();
    videoUrlCache: Map<string, string> = new Map();
    videoSafeUrlCache: Map<string, SafeUrl> = new Map(); // même instance SafeUrl pour éviter rechargements
    loadingVideos: Set<string> = new Set();

    private userId = '';
    private nextPage = 0;
    private nextPageVideos = 0;
    private subscriptions: Subscription[] = [];
    private waitInterval: any;
    private intersectionObserver: IntersectionObserver | null = null;
    private imageCompressionModalRef: NgbModalRef | null = null;
    private currentFsSlideshowEventId = '';
    /** True when at least one photo was added to DB during the current slideshow session; used to refresh timeline on close */
    private addedPhotoToDbDuringSlideshow = false;
    /** Set to true in ngOnDestroy so pending setTimeout/async callbacks can no-op and avoid memory leaks */
    private destroyed = false;

    constructor(
        private photoTimelineService: PhotoTimelineService,
        private membersService: MembersService,
        private fileService: FileService,
        private modalService: NgbModal,
        private translate: TranslateService,
        private cdr: ChangeDetectorRef,
        private sanitizer: DomSanitizer
    ) {}

    ngOnInit(): void {
        this.waitForUser();
    }

    ngOnDestroy(): void {
        this.destroyed = true;
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];
        this.fsSlideshowSubs.forEach(s => { if (s && !s.closed) s.unsubscribe(); });
        this.fsSlideshowSubs = [];
        if (this.waitInterval) {
            clearInterval(this.waitInterval);
            this.waitInterval = null;
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        this.thumbnailCache.forEach(url => {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
        this.thumbnailCache.clear();
        this.loadingThumbnails.clear();
        this.videoUrlCache.forEach(url => {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
        this.videoUrlCache.clear();
        this.videoSafeUrlCache.clear();
        this.loadingVideos.clear();
    }

    private waitForUser(): void {
        this.waitInterval = setInterval(() => {
            const user = this.membersService.getUser();
            if (user && user.id) {
                clearInterval(this.waitInterval);
                this.userId = user.id;
                this.startStreaming();
            }
        }, 200);
    }

    loadTimeline(): void {
        this.isLoading = true;
        this.errorMessage = '';
        this.nextPage = 0;
        this.nextPageVideos = 0;
        this.visibleGroups = [];
        this.bufferedGroups = [];
        this.bufferedVideoGroups = [];
        this.hasMore = true;
        this.hasMoreVideos = true;
        this.onThisDay = [];
        this.startStreaming();
    }

    private startStreaming(): void {
        this.fetchNext();
        this.fetchNextVideos();
        this.loadOnThisDay();
    }

    private loadOnThisDay(): void {
        const sub = this.photoTimelineService.getOnThisDay(this.userId).subscribe({
            next: (photos) => { this.onThisDay = photos || []; },
            error: () => { this.onThisDay = []; }
        });
        this.subscriptions.push(sub);
    }

    private fetchNext(): void {
        if (this.isFetching || !this.hasMore) return;
        this.isFetching = true;

        const sub = this.photoTimelineService.getTimeline(this.userId, this.nextPage, 1).subscribe({
            next: (response: TimelineResponse) => {
                // Defer state updates to next tick to avoid ExpressionChangedAfterItHasBeenCheckedError (NG0100)
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.isFetching = false;
                    this.hasMore = response.hasMore;
                    this.nextPage = response.page + 1;

                    if (response.groups.length > 0) {
                        this.bufferedGroups.push(response.groups[0]);
                        if (this.visibleGroups.length === 0) {
                            this.revealMore();
                        }
                    } else if (this.isLoading && !response.hasMore && this.bufferedVideoGroups.length === 0) {
                        this.isLoading = false;
                        setTimeout(() => { if (!this.destroyed) this.setupIntersectionObserver(); }, 50);
                    }

                    if (this.hasMore && this.bufferedGroups.length < BUFFER_AHEAD) {
                        this.fetchNext();
                    }
                    if (this.hasMoreVideos && this.bufferedVideoGroups.length < BUFFER_AHEAD) {
                        this.fetchNextVideos();
                    }
                    this.cdr.markForCheck();
                }, 0);
            },
            error: (err) => {
                console.error('Error loading photo timeline:', err);
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.isFetching = false;
                    if (this.isLoading) {
                        this.errorMessage = 'Error loading photos';
                        this.isLoading = false;
                    }
                    this.cdr.markForCheck();
                }, 0);
            }
        });
        this.subscriptions.push(sub);
    }

    private fetchNextVideos(): void {
        if (this.isFetchingVideos || !this.hasMoreVideos) return;
        this.isFetchingVideos = true;

        const sub = this.photoTimelineService.getVideoTimeline(this.userId, this.nextPageVideos, 1).subscribe({
            next: (response: TimelineResponse) => {
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.isFetchingVideos = false;
                    this.hasMoreVideos = response.hasMore;
                    this.nextPageVideos = response.page + 1;

                    if (response.groups.length > 0) {
                        this.bufferedVideoGroups.push(response.groups[0]);
                        if (this.visibleGroups.length === 0) {
                            this.revealMore();
                        }
                    }

                    if (this.hasMoreVideos && this.bufferedVideoGroups.length < BUFFER_AHEAD) {
                        this.fetchNextVideos();
                    }
                    this.cdr.markForCheck();
                }, 0);
            },
            error: () => {
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.isFetchingVideos = false;
                    this.cdr.markForCheck();
                }, 0);
            }
        });
        this.subscriptions.push(sub);
    }

    /**
     * Révèle un groupe (le plus ancien par date) depuis les buffers photo/vidéo,
     * le normalise si c'est un groupe vidéo seul, et le met dans visibleGroups.
     */
    private revealMore(): void {
        if (this.bufferedGroups.length === 0 && this.bufferedVideoGroups.length === 0 &&
            !this.hasMore && !this.hasMoreVideos) return;

        const gPhoto = this.bufferedGroups[0];
        const gVideo = this.bufferedVideoGroups[0];
        const datePhoto = gPhoto?.eventDate ? new Date(gPhoto.eventDate).getTime() : Infinity;
        const dateVideo = gVideo?.eventDate ? new Date(gVideo.eventDate).getTime() : Infinity;

        let group: TimelineGroup;
        if (gVideo != null && (gPhoto == null || dateVideo <= datePhoto)) {
            this.bufferedVideoGroups.splice(0, 1);
            group = { ...gVideo, photos: [], videos: gVideo.photos || [] };
        } else if (gPhoto != null) {
            this.bufferedGroups.splice(0, 1);
            group = gPhoto;
        } else {
            return;
        }

        this.visibleGroups.push(group);
        this.preloadThumbnailsForGroup(group);
        if (this.visibleGroups.length === 1) {
            this.isLoading = false;
            setTimeout(() => { if (!this.destroyed) this.setupIntersectionObserver(); }, 50);
        }

        if (this.hasMore && this.bufferedGroups.length < BUFFER_AHEAD) this.fetchNext();
        if (this.hasMoreVideos && this.bufferedVideoGroups.length < BUFFER_AHEAD) this.fetchNextVideos();
        setTimeout(() => { if (!this.destroyed) this.setupIntersectionObserver(); }, 50);
    }

    private setupIntersectionObserver(): void {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }

        if (!this.scrollSentinel?.nativeElement) return;
        if (!this.hasMore && this.bufferedGroups.length === 0 && !this.hasMoreVideos && this.bufferedVideoGroups.length === 0) return;

        this.intersectionObserver = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && (this.bufferedGroups.length > 0 || this.hasMore || this.bufferedVideoGroups.length > 0 || this.hasMoreVideos)) {
                    this.revealMore();
                }
            },
            { rootMargin: `${SCROLL_THRESHOLD_PX}px` }
        );

        this.intersectionObserver.observe(this.scrollSentinel.nativeElement);
    }

    @HostListener('window:scroll')
    onWindowScroll(): void {
        if (this.bufferedGroups.length === 0 && !this.hasMore && this.bufferedVideoGroups.length === 0 && !this.hasMoreVideos) return;

        const scrollPosition = window.innerHeight + window.scrollY;
        const documentHeight = document.documentElement.scrollHeight;

        if (documentHeight - scrollPosition < SCROLL_THRESHOLD_PX) {
            this.revealMore();
        }
    }

    get filteredGroups(): TimelineGroup[] {
        const filter = this.searchFilter.toLowerCase().trim();
        if (!filter) return this.visibleGroups;
        return this.visibleGroups.filter(g =>
            g.eventName.toLowerCase().includes(filter) ||
            (g.eventType && g.eventType.toLowerCase().includes(filter))
        );
    }

    onFilterChange(): void {
        // filteredGroups is a getter, re-evaluated automatically
    }

    clearFilter(): void {
        this.searchFilter = '';
    }

    /** Média d'un groupe : photos et vidéos en parallèle (entrelacés), pas les vidéos en premier. */
    getGroupMedia(group: TimelineGroup): GroupMediaItem[] {
        const photos = group.photos || [];
        const videos = group.videos || [];
        const list: GroupMediaItem[] = [];
        let photoIndex = 0;
        const maxLen = Math.max(photos.length, videos.length);
        for (let i = 0; i < maxLen; i++) {
            if (photos[i]) {
                list.push({ type: 'photo', item: photos[i], photoIndex: photoIndex++ });
            }
            if (videos[i]) {
                list.push({ type: 'video', item: videos[i] });
            }
        }
        return list;
    }

    private isVideoFile(fileName: string): boolean {
        if (!fileName) return false;
        const lower = fileName.toLowerCase();
        const ext = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.m4v', '.3gp'];
        return ext.some(e => lower.endsWith(e));
    }

    getThumbnailUrl(photo: TimelinePhoto): string | null {
        if (this.thumbnailCache.has(photo.fileId)) {
            return this.thumbnailCache.get(photo.fileId)!;
        }
        if (!this.loadingThumbnails.has(photo.fileId)) {
            this.loadThumbnail(photo);
        }
        return null;
    }

    getVideoUrl(video: TimelinePhoto): SafeUrl | null {
        const id = video.fileId;
        if (this.videoSafeUrlCache.has(id)) {
            return this.videoSafeUrlCache.get(id)!;
        }
        if (this.videoUrlCache.has(id)) {
            const url = this.videoUrlCache.get(id)!;
            const safe = this.sanitizer.bypassSecurityTrustUrl(url);
            this.videoSafeUrlCache.set(id, safe);
            return safe;
        }
        if (!this.loadingVideos.has(id)) {
            this.loadVideoUrl(video);
        }
        return null;
    }

    private loadVideoUrl(video: TimelinePhoto): void {
        const id = video.fileId;
        if (this.videoUrlCache.has(id) || this.loadingVideos.has(id)) {
            return;
        }
        this.loadingVideos.add(id);
        const sub = this.fileService.getFile(id).subscribe({
            next: (data: ArrayBuffer) => {
                if (this.destroyed) return;
                if (this.videoUrlCache.has(id)) {
                    this.loadingVideos.delete(id);
                    return;
                }
                const blob = new Blob([data], { type: video.fileType || 'video/mp4' });
                const url = URL.createObjectURL(blob);
                this.videoUrlCache.set(id, url);
                const safe = this.sanitizer.bypassSecurityTrustUrl(url);
                this.videoSafeUrlCache.set(id, safe);
                this.loadingVideos.delete(id);
                this.cdr.markForCheck();
            },
            error: () => {
                this.loadingVideos.delete(id);
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
    }

    private loadThumbnail(photo: TimelinePhoto): void {
        this.loadingThumbnails.add(photo.fileId);
        const sub = this.fileService.getFile(photo.fileId).subscribe({
            next: (data: ArrayBuffer) => {
                const blob = new Blob([data], { type: photo.fileType });
                const url = URL.createObjectURL(blob);
                this.thumbnailCache.set(photo.fileId, url);
                this.loadingThumbnails.delete(photo.fileId);
            },
            error: () => {
                this.loadingThumbnails.delete(photo.fileId);
            }
        });
        this.subscriptions.push(sub);
    }

    private preloadThumbnailsForGroup(group: TimelineGroup): void {
        for (const photo of group.photos || []) {
            this.getThumbnailUrl(photo);
        }
        for (const video of group.videos || []) {
            this.getVideoUrl(video);
        }
    }

    openSlideshow(group: TimelineGroup, startIndex: number): void {
        if (!this.slideshowModalComponent) return;
        const images: SlideshowImageSource[] = group.photos.map(p => ({
            fileId: p.fileId,
            fileName: p.fileName
        }));
        this.slideshowModalComponent.open(images, group.eventName, true, 0, undefined, startIndex);
    }

    /** Ouvre la vidéo dans le modal lecteur (mur de photos). */
    openVideoInVideoshow(fileId: string, fileName: string, eventName: string): void {
        if (!this.videoshowModalComponent) return;
        const source: VideoshowVideoSource = { fileId, fileName };
        this.videoshowModalComponent.open([source], eventName || '', true);
    }

    openOnThisDaySlideshow(index: number): void {
        if (!this.slideshowModalComponent) return;
        const images: SlideshowImageSource[] = this.onThisDay.map(p => ({
            fileId: p.fileId,
            fileName: p.fileName
        }));
        this.slideshowModalComponent.open(images, this.translate.instant('PHOTO_TIMELINE.ON_THIS_DAY'), true, 0, undefined, index);
    }

    private fsSlideshowLoadingActive = false;
    private fsSlideshowSubs: Subscription[] = [];

    openFsSlideshow(fsLink: FsPhotoLink, eventName: string, eventId: string): void {
        if (!this.slideshowModalComponent) return;

        this.fsSlideshowLoadingActive = true;
        this.currentFsSlideshowEventId = eventId;
        this.slideshowModalComponent.open([], eventName, false, 0, undefined, 0, eventId);

        const listSub = this.fileService.listImagesFromDisk(fsLink.path).subscribe({
            next: (fileNames: string[]) => {
                if (!fileNames || fileNames.length === 0 || !this.fsSlideshowLoadingActive) return;

                const imageSources: SlideshowImageSource[] = fileNames.map(fileName => ({
                    fileId: undefined,
                    blobUrl: undefined,
                    fileName,
                    relativePath: fsLink.path,
                    compressFs: true
                }));

                if (this.slideshowModalComponent && this.fsSlideshowLoadingActive) {
                    this.slideshowModalComponent.addImages(imageSources);
                }
            },
            error: (err) => {
                console.error('Error listing FS images:', err);
            }
        });
        this.fsSlideshowSubs.push(listSub);
        this.subscriptions.push(listSub);
    }

    onSlideshowClosed(): void {
        this.fsSlideshowLoadingActive = false;
        this.currentFsSlideshowEventId = '';
        this.fsSlideshowSubs.forEach(s => { if (s && !s.closed) s.unsubscribe(); });
        this.fsSlideshowSubs = [];
        // Refresh timeline so newly added photo(s) appear immediately in the wall
        if (this.addedPhotoToDbDuringSlideshow) {
            this.addedPhotoToDbDuringSlideshow = false;
            this.loadTimeline();
        }
    }

    onAddToDb(event: SlideshowAddToDbEvent): void {
        this.askForImageCompression().then(shouldCompress => {
            if (shouldCompress === null) return;
            // Switch ON (compress) → shouldCompress=true → allowOriginal=false → backend compresses
            this.uploadImageToEvent(event.blob, event.fileName, event.eventId, !shouldCompress);
        });
    }

    private askForImageCompression(): Promise<boolean | null> {
        return new Promise((resolve) => {
            this.compressImages = true;

            if (this.imageCompressionModal) {
                this.imageCompressionModalRef = this.modalService.open(this.imageCompressionModal, {
                    centered: true,
                    backdrop: 'static',
                    keyboard: false,
                    size: 'md',
                    windowClass: 'compression-quality-modal'
                });

                this.imageCompressionModalRef.result.then(
                    (result: boolean) => {
                        this.imageCompressionModalRef = null;
                        resolve(result);
                    },
                    () => {
                        this.imageCompressionModalRef = null;
                        resolve(null);
                    }
                );
            } else {
                const choice = confirm(this.translate.instant('EVENTELEM.IMAGE_COMPRESSION_MESSAGE', { count: 1 }));
                resolve(choice);
            }
        });
    }

    confirmImageCompression(): void {
        if (this.imageCompressionModalRef) {
            this.imageCompressionModalRef.close(this.compressImages);
        }
    }

    cancelImageCompression(): void {
        if (this.imageCompressionModalRef) {
            this.imageCompressionModalRef.dismiss();
        }
    }

    private uploadImageToEvent(blob: Blob, fileName: string, eventId: string, allowOriginal: boolean): void {
        this.isUploading = true;
        this.uploadMessage = '';
        this.uploadSuccess = false;

        const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
        const formData = new FormData();
        formData.append('file', file, file.name);
        // allowOriginal=false when switch ON → backend compresses image before storing in MongoDB
        formData.append('allowOriginal', allowOriginal.toString());

        const user = this.membersService.getUser();
        const uploadUrl = `${environment.API_URL4FILE}/${user.id}/${eventId}`;

        const sub = this.fileService.postFileToUrl(formData, user, uploadUrl).subscribe({
            next: () => {
                this.addedPhotoToDbDuringSlideshow = true;
                const message = this.translate.instant('PHOTO_TIMELINE.UPLOAD_SUCCESS', { fileName });
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.isUploading = false;
                    this.uploadSuccess = true;
                    this.uploadMessage = message;
                    this.cdr.markForCheck();
                    setTimeout(() => {
                        if (this.destroyed) return;
                        this.uploadMessage = '';
                        this.uploadSuccess = false;
                        this.cdr.markForCheck();
                    }, 4000);
                }, 0);
            },
            error: (err) => {
                console.error('Error uploading image to DB:', err);
                const uploadError = err?.headers?.get('X-Upload-Error');
                let detail = '';
                if (err?.status === 0) {
                    detail = ' (server connection lost — may be out of memory or disk full)';
                } else if (err?.status === 507) {
                    detail = uploadError ? ` (${uploadError})` : ' (storage full)';
                } else if (uploadError) {
                    detail = ` (${uploadError})`;
                }
                const message = this.translate.instant('PHOTO_TIMELINE.UPLOAD_ERROR') + detail;
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.isUploading = false;
                    this.uploadMessage = message;
                    this.cdr.markForCheck();
                    setTimeout(() => {
                        if (this.destroyed) return;
                        this.uploadMessage = '';
                        this.cdr.markForCheck();
                    }, 8000);
                }, 0);
            }
        });
        this.subscriptions.push(sub);
    }

    formatEventDate(dateStr: string): string {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleDateString(this.translate.currentLang || 'fr', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    getYearFromDate(dateStr: string): number {
        if (!dateStr) return 0;
        return new Date(dateStr).getFullYear();
    }

    getEventTypeIcon(type: string): string {
        const icons: { [key: string]: string } = {
            'Vtt': 'fa-bicycle',
            'Running': 'fa-running',
            'Walk': 'fa-walking',
            'Ski': 'fa-snowflake-o',
            'Bike': 'fa-bicycle',
            'Party': 'fa-glass',
            'Vacation': 'fa-plane',
            'Travel': 'fa-globe',
            'Hiking': 'fa-tree',
            'Rando': 'fa-tree',
            'Photos': 'fa-camera',
            'Documents': 'fa-file-text',
            'Wine': 'fa-glass',
            'Other': 'fa-star',
            'Visit': 'fa-map-marker',
            'Work': 'fa-briefcase',
            'Family': 'fa-home',
            'Fiche': 'fa-file-text-o'
        };
        return icons[type] || 'fa-calendar';
    }

    trackByGroupId(index: number, group: TimelineGroup): string {
        return group.eventId;
    }

    trackByPhotoId(index: number, photo: TimelinePhoto): string {
        return photo.fileId;
    }

    trackByMediaId(index: number, media: GroupMediaItem): string {
        return media.item.fileId;
    }
}
