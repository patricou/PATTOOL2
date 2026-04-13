import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ViewChildren, QueryList, ElementRef, HostListener, TemplateRef, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';
import { SlideshowModalModule } from '../../shared/slideshow-modal/slideshow-modal.module';
import { SlideshowModalComponent, SlideshowImageSource, SlideshowAddToDbEvent, SlideshowLocationEvent } from '../../shared/slideshow-modal/slideshow-modal.component';
import { TraceViewerModalComponent } from '../../shared/trace-viewer-modal/trace-viewer-modal.component';
import { VideoshowModalModule } from '../../shared/videoshow-modal/videoshow-modal.module';
import { VideoshowModalComponent, VideoshowVideoSource } from '../../shared/videoshow-modal/videoshow-modal.component';
import { PhotoTimelineService, TimelineResponse, TimelineGroup, TimelinePhoto, FsPhotoLink } from '../../services/photo-timeline.service';
import { EventCardOverlayComponent } from '../../shared/event-card-modal/event-card-overlay.component';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { FriendsService } from '../../services/friends.service';
import { FriendGroup } from '../../model/friend';
import { NgbModal, NgbModalRef, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { VideoCompressionService } from '../../services/video-compression.service';
import { VideoUploadProcessingService } from '../../services/video-upload-processing.service';
import { forkJoin, of, Subscription } from 'rxjs';
import { map, distinctUntilChanged, catchError, take, switchMap, finalize } from 'rxjs/operators';
import { DomSanitizer, SafeUrl, SafeStyle } from '@angular/platform-browser';
import { environment } from '../../../environments/environment';
import { EvenementsService } from '../../services/evenements.service';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { DiscussionService } from '../../services/discussion.service';
import { EventColorService } from '../../services/event-color.service';
import { DiscussionModalComponent } from '../../communications/discussion-modal/discussion-modal.component';
import { CommentaryEditor } from '../../commentary-editor/commentary-editor';
import { Evenement } from '../../model/evenement';
import { Commentary } from '../../model/commentary';
import { Member } from '../../model/member';
import { ScaleRowToFitDirective } from './scale-row-to-fit.directive';
import { computeTrackStatsFromFileContent } from '../track-route-stats.util';
import { getEventTypeFaIconSuffix } from '../../shared/event-type-icon.util';

const BUFFER_AHEAD = 3;
/** Number of groups (activities) to load per API request. */
const PAGE_SIZE = 12;
/** Number of activities shown on open (same as home-evenements showing 8 cards). */
const INITIAL_VISIBLE_GROUPS = 8;
/** Approximate height of an event block (px) to preload 3 events ahead. */
const EVENT_BLOCK_HEIGHT_PX = 500;
const PREFETCH_EVENTS_AHEAD = 3;

export interface GroupMediaItem {
    type: 'photo' | 'video';
    item: TimelinePhoto;
    photoIndex?: number; // index among photos only (for the slideshow)
}
const SCROLL_THRESHOLD_PX = Math.max(400, PREFETCH_EVENTS_AHEAD * EVENT_BLOCK_HEIGHT_PX);
/** Max longest side (px) for server wall previews; must stay in sync with API clamp in FileRestController / file.service. */
const WALL_THUMB_MAX_EDGE_CAP = 2048;
/** Max concurrent wall media HTTP fetches (thumbs + inline videos) to avoid stampedes. */
const WALL_MEDIA_MAX_PARALLEL = 12;

/**
 * Longest side for wall thumbnails: masonry tiles are column-wide, but portrait photos are often
 * much taller than the column — the longest on-screen edge must drive resolution, not width alone.
 */
function getAdaptiveThumbMaxEdge(): number {
    if (typeof window === 'undefined') {
        return 1024;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3.5);

    let columnCss: number;
    if (w <= 480) {
        columnCss = Math.max(220, w - 20);
    } else if (w <= 768) {
        columnCss = Math.max(240, (w - 28) / 2 + 32);
    } else if (w <= 1200) {
        columnCss = Math.max(280, (w - 36) / 3 + 28);
    } else {
        columnCss = Math.max(300, (w - 44) / 4 + 28);
    }

    // Portrait / tall tiles: longest displayed side often ≈ column × aspect; bound by viewport height.
    const tallTileGuess = Math.min(h * 0.82, columnCss * 3.6);
    const approxCssMaxEdge = Math.max(columnCss, tallTileGuess);

    const requested = Math.ceil(approxCssMaxEdge * dpr);
    return Math.min(WALL_THUMB_MAX_EDGE_CAP, Math.max(480, requested));
}

/** Returns the max concurrent fetch parallelism adapted to the network connection quality. */
function getAdaptiveMaxParallel(): number {
    const conn = (navigator as any)?.connection;
    if (!conn) return WALL_MEDIA_MAX_PARALLEL;
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return 3;
    if (conn.effectiveType === '3g') return 6;
    return WALL_MEDIA_MAX_PARALLEL;
}
/** First-screen thumbnail preload per group (rest via IntersectionObserver, like home-evenements lazy batches). */
const WALL_PRELOAD_THUMBS_FIRST_SCREEN = 10;
const WALL_PRELOAD_THUMBS_AFTER = 6;

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
        VideoshowModalModule,
        TraceViewerModalComponent,
        EventCardOverlayComponent,
        ScaleRowToFitDirective,
        CommentaryEditor
    ]
})
export class PhotoTimelineComponent implements OnInit, OnDestroy, AfterViewInit {

    @ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
    @ViewChild('traceViewerModalComponent') traceViewerModalComponent!: TraceViewerModalComponent;
    @ViewChild('videoshowModalComponent') videoshowModalComponent!: VideoshowModalComponent;
    @ViewChild('scrollSentinel') scrollSentinel!: ElementRef;
    @ViewChild('imageCompressionModal') imageCompressionModal!: TemplateRef<any>;
    @ViewChild('wallUploadLogsModal') wallUploadLogsModal!: TemplateRef<any>;
    @ViewChild('wallQualitySelectionModal') wallQualitySelectionModal!: TemplateRef<any>;
    @ViewChild('wallUploadLogContent') wallUploadLogContent?: ElementRef<HTMLElement>;
    @ViewChild('wallWhatsappShareModal') wallWhatsappShareModal!: TemplateRef<any>;
    @ViewChild('wallShareByEmailModal') wallShareByEmailModal!: TemplateRef<any>;
    @ViewChild('wallEventAccessUsersModal') wallEventAccessUsersModal!: TemplateRef<any>;
    @ViewChild('wallCommentaryEditor') wallCommentaryEditor?: CommentaryEditor;

    /** Loaded on demand when opening « Commentaires » from the wall (same editor as détail événement). */
    wallCommentaryEvent: Evenement | null = null;
    /** Masonry wall videos: playback only when visible in the viewport. */
    @ViewChildren('wallTimelineVideo', { read: ElementRef }) wallTimelineVideos!: QueryList<ElementRef<HTMLVideoElement>>;

    visibleGroups: TimelineGroup[] = [];
    bufferedGroups: TimelineGroup[] = [];
    bufferedVideoGroups: TimelineGroup[] = [];
    onThisDay: TimelinePhoto[] = [];

    isLoading = true;
    isFetching = false;
    isFetchingVideos = false;
    errorMessage = '';
    searchFilter = '';
    /** Visibility filter: 'all', 'public', 'private', 'friends', or friend group id (same as home-evenements). */
    selectedVisibilityFilter = 'all';
    friendGroups: FriendGroup[] = [];
    hasMore = true;
    hasMoreVideos = true;

    compressImages = true;
    /** Image compression modal: count shown in translated message (slideshow + mur). */
    imageCountForModal = 1;
    isUploading = false;
    /** True while a multi-file wall upload (with progress modal) is running — overlay wording. */
    wallBulkFileUploadActive = false;
    uploadMessage = '';
    uploadSuccess = false;

    /** Mur : upload multi-fichiers (même accept que détail événement). */
    wallUploadLogs: string[] = [];
    wallUploadLogsModalRef: NgbModalRef | null = null;
    wallUploadLastError: string | null = null;
    wallUploadLastErrorDetail = '';
    wallUploadPollIntervalId: ReturnType<typeof setInterval> | null = null;
    /** Dernière requête getUploadLogs du polling mur (une seule à la fois, évite d’empiler des centaines de Subscription). */
    private wallUploadLogsPollSub: Subscription | null = null;
    videoCountForModal = 0;
    selectedCompressionQuality: 'low' | 'medium' | 'high' | 'very-high' | 'original' = 'very-high';
    private qualityModalRef: NgbModalRef | null = null;

    thumbnailCache: Map<string, string> = new Map();
    /** Parsed distance / D+ for Mongo-backed tracks (photo wall table), keyed by GridFS id. */
    wallTrackStats: Map<string, {
        loading: boolean;
        error?: boolean;
        distanceKm: number | null;
        elevationGainM: number | null;
        /** From trace file (GPX time, TCX Time, …), ISO string */
        fileDateIso: string | null;
    }> = new Map();
    /** Tri du tableau des traces GPS (clé = eventId). */
    private wallTrackTableSort = new Map<string, {
        col: 'name' | 'file' | 'owner' | 'date' | 'km' | 'elev';
        asc: boolean;
    }>();
    /** Tableau traces : déplié = toutes les lignes ; sinon une seule (clé = eventId). */
    private wallTrackTableExpanded = new Map<string, boolean>();
    /** Tri du tableau des PDF (clé = eventId). */
    private wallPdfTableSort = new Map<string, {
        col: 'name' | 'file' | 'owner';
        asc: boolean;
    }>();
    /** Tableau PDF : déplié = toutes les lignes ; sinon une seule (clé = eventId). */
    private wallPdfTableExpanded = new Map<string, boolean>();
    loadingThumbnails: Set<string> = new Set();
    videoUrlCache: Map<string, string> = new Map();
    videoSafeUrlCache: Map<string, SafeUrl> = new Map(); // same SafeUrl instance to avoid reloads
    loadingVideos: Set<string> = new Set();

    userId = '';
    private nextPage = 0;
    private nextPageVideos = 0;
    private subscriptions: Subscription[] = [];
    private intersectionObserver: IntersectionObserver | null = null;
    private wallVideoIntersectionObserver: IntersectionObserver | null = null;
    private wallVideoQuerySub: Subscription | null = null;
    /** Loads masonry photos / videos only when near the viewport. */
    private wallMediaObserver: IntersectionObserver | null = null;
    private wallFetchActive = 0;
    private wallFetchQueue: Array<() => void> = [];
    /** Debounce handle: batches rapid markForCheck() calls from thumbnail/video load callbacks into one CD cycle. */
    private cdrScheduleId: ReturnType<typeof setTimeout> | null = null;
    /** WeakMap cache so getGroupMedia() does not rebuild arrays on every Angular CD cycle. */
    private groupMediaCache = new WeakMap<TimelineGroup, GroupMediaItem[]>();
    private imageCompressionModalRef: NgbModalRef | null = null;
    private currentFsSlideshowEventId = '';
    /** True when at least one photo was added to DB during the current slideshow session; used to refresh timeline on close */
    private addedPhotoToDbDuringSlideshow = false;
    /** Set to true in ngOnDestroy so pending setTimeout/async callbacks can no-op and avoid memory leaks */
    private destroyed = false;
    /** Incremented on each full wall reset so stale HTTP / fetch callbacks do not mutate state or retain blobs. */
    private timelineLoadGeneration = 0;
    /** After first photo-timeline response is handled, start on-this-day (avoids competing with wall thumbnails on the shared fetch queue). */
    private onThisDayApiScheduled = false;
    /**
     * Home-evenements opens a single stream and displays cards as they arrive; here we avoid launching
     * two heavy Mongo queries (photos + videos-only) in parallel at cold start.
     */
    private videoTimelineFetchStarted = false;
    private searchDebounceId: ReturnType<typeof setTimeout> | null = null;
    /** When set, timeline shows only photos/videos for this event (from query param eventId). */
    filterEventId: string | undefined;

    /** Photo wall: sharing (owner only), same flow as event detail */
    shareWallContextGroup: TimelineGroup | null = null;

    /** Per-event refresh: eventIds with an in-flight timeline refetch */
    private readonly refreshingGroupEventIds = new Set<string>();
    wallWhatsappShareMessage = '';
    private wallWhatsappShareModalRef: NgbModalRef | null = null;
    private wallShareByEmailModalRef: NgbModalRef | null = null;
    wallShareByEmailPatToolSelected: string[] = [];
    wallShareByEmailPatToolSelectedSet = new Set<string>();
    wallShareByEmailExternalEmails = '';
    wallShareByEmailMessage = '';
    wallShareByEmailMailLang = 'fr';
    wallShareByEmailMailLangOptions: { code: string; labelKey: string; flagCode: string }[] = [
        { code: 'fr', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_FR', flagCode: 'fr' },
        { code: 'en', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_EN', flagCode: 'gb' },
        { code: 'de', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_DE', flagCode: 'de' },
        { code: 'es', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_ES', flagCode: 'es' },
        { code: 'it', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_IT', flagCode: 'it' },
        { code: 'el', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_EL', flagCode: 'gr' },
        { code: 'he', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_HE', flagCode: 'il' },
        { code: 'jp', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_JP', flagCode: 'jp' },
        { code: 'ru', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_RU', flagCode: 'ru' },
        { code: 'cn', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_CN', flagCode: 'cn' },
        { code: 'ar', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_AR', flagCode: 'sa' },
        { code: 'in', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_IN', flagCode: 'in' }
    ];
    wallShareByEmailAllMembers: Member[] = [];
    wallShareByEmailLoading = false;
    wallShareByEmailSending = false;
    wallShareByEmailError: string | null = null;
    wallShareByEmailSuccess: string | null = null;
    wallShareEmailEventAccessUsers: Member[] = [];

    /** "Users with access" modal (click on visibility badge), same API as event detail */
    wallEventAccessUsers: Member[] = [];
    wallEventAccessLoading = false;
    wallEventAccessContextGroup: TimelineGroup | null = null;
    private wallEventAccessModalRef: NgbModalRef | null = null;
    /** Incremented on each badge click; ignores stale HTTP responses (prevents double-open). */
    private wallEventAccessLoadSeq = 0;
    private wallEventAccessOpenTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private photoTimelineService: PhotoTimelineService,
        private membersService: MembersService,
        private fileService: FileService,
        private friendsService: FriendsService,
        private evenementsService: EvenementsService,
        private discussionService: DiscussionService,
        private eventColorService: EventColorService,
        private modalService: NgbModal,
        private translate: TranslateService,
        private cdr: ChangeDetectorRef,
        private sanitizer: DomSanitizer,
        private route: ActivatedRoute,
        private router: Router,
        private keycloakService: KeycloakService,
        private ngZone: NgZone,
        private videoCompressionService: VideoCompressionService,
        private videoUploadProcessingService: VideoUploadProcessingService
    ) {}

    ngOnInit(): void {
        this.waitForUser();
        // React to query param changes (e.g. "View all events" clears eventId) so the timeline reloads
        const paramSub = this.route.queryParamMap.pipe(
            map(q => q.get('eventId')),
            map(id => (id != null && id.trim() !== '') ? id.trim() : undefined),
            distinctUntilChanged()
        ).subscribe(eventId => {
            if (this.filterEventId === eventId) return;
            this.filterEventId = eventId;
            if (this.userId) {
                this.loadTimeline();
            }
            this.cdr.markForCheck();
        });
        this.subscriptions.push(paramSub);
    }

    ngOnDestroy(): void {
        this.destroyed = true;
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];
        this.fsSlideshowSubs.forEach(s => { if (s && !s.closed) s.unsubscribe(); });
        this.fsSlideshowSubs = [];
        if (this.searchDebounceId != null) {
            clearTimeout(this.searchDebounceId);
            this.searchDebounceId = null;
        }
        if (this.cdrScheduleId != null) {
            clearTimeout(this.cdrScheduleId);
            this.cdrScheduleId = null;
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        if (this.imageCompressionModalRef) {
            try { this.imageCompressionModalRef.dismiss(); } catch (_) {}
            this.imageCompressionModalRef = null;
        }
        this.stopWallUploadLogPolling();
        if (this.qualityModalRef) {
            try { this.qualityModalRef.dismiss(); } catch (_) {}
            this.qualityModalRef = null;
        }
        if (this.wallUploadLogsModalRef) {
            try { this.wallUploadLogsModalRef.dismiss(); } catch (_) {}
            this.wallUploadLogsModalRef = null;
        }
        if (this.wallWhatsappShareModalRef) {
            try { this.wallWhatsappShareModalRef.dismiss(); } catch (_) {}
            this.wallWhatsappShareModalRef = null;
        }
        if (this.wallShareByEmailModalRef) {
            try { this.wallShareByEmailModalRef.dismiss(); } catch (_) {}
            this.wallShareByEmailModalRef = null;
        }
        if (this.wallEventAccessModalRef) {
            try { this.wallEventAccessModalRef.dismiss(); } catch (_) {}
            this.wallEventAccessModalRef = null;
        }
        if (this.wallEventAccessOpenTimer != null) {
            clearTimeout(this.wallEventAccessOpenTimer);
            this.wallEventAccessOpenTimer = null;
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
        if (this.wallVideoIntersectionObserver) {
            this.wallVideoIntersectionObserver.disconnect();
            this.wallVideoIntersectionObserver = null;
        }
        if (this.wallVideoQuerySub) {
            this.wallVideoQuerySub.unsubscribe();
            this.wallVideoQuerySub = null;
        }
        if (this.wallMediaObserver) {
            this.wallMediaObserver.disconnect();
            this.wallMediaObserver = null;
        }
        this.wallFetchQueue = [];
    }

    ngAfterViewInit(): void {
        this.wallVideoIntersectionObserver = new IntersectionObserver(
            (entries) => {
                if (this.destroyed) return;
                for (const entry of entries) {
                    const v = entry.target as HTMLVideoElement;
                    if (entry.isIntersecting) {
                        v.play().catch(() => { /* autoplay / politiques navigateur */ });
                    } else if (document.fullscreenElement !== v && document.pictureInPictureElement !== v) {
                        v.pause();
                    }
                }
            },
            { root: null, rootMargin: '0px', threshold: 0.15 }
        );
        this.observeWallTimelineVideos();
        this.wallVideoQuerySub = this.wallTimelineVideos.changes.subscribe(() => this.observeWallTimelineVideos());
    }

    /** Re-registers all wall videos with the observer (dynamic masonry list). */
    private observeWallTimelineVideos(): void {
        if (this.destroyed || !this.wallVideoIntersectionObserver) return;
        this.wallVideoIntersectionObserver.disconnect();
        this.wallTimelineVideos.forEach((ref) => {
            this.wallVideoIntersectionObserver!.observe(ref.nativeElement);
        });
    }

    /**
     * Batches rapid markForCheck() calls (one per thumbnail) into a single CD cycle.
     * Without this, loading 10 thumbnails in parallel triggers 10 full Angular CD passes.
     */
    private scheduleCdr(): void {
        if (this.cdrScheduleId !== null) return;
        this.cdrScheduleId = setTimeout(() => {
            this.cdrScheduleId = null;
            if (!this.destroyed) this.cdr.markForCheck();
        }, 50);
    }

    /**
     * Writes wall thumbnail / video blob caches outside the Angular zone so Zone does not emit an
     * extra ApplicationRef notification that races with dev-mode checkNoChanges (NG0100 on [src] /
     * getThumbnailUrl). CD is then requested explicitly via {@link scheduleCdr}.
     */
    private commitWallMediaCachesAndScheduleCdr(fn: () => void): void {
        if (this.destroyed) return;
        this.ngZone.runOutsideAngular(() => {
            if (this.destroyed) return;
            fn();
        });
        if (this.destroyed) return;
        this.ngZone.run(() => this.scheduleCdr());
    }

    /**
     * Starts the wall as soon as the member id is available (without waiting for GPS, like links).
     * Avoids the setInterval(200 ms) that was systematically delaying the first load.
     */
    private waitForUser(): void {
        const eventId = this.route.snapshot.queryParamMap.get('eventId');
        this.filterEventId = (eventId != null && eventId.trim() !== '') ? eventId.trim() : undefined;

        this.keycloakService.getToken().then(() => {}).catch(() => {});

        const user = this.membersService.getUser();
        if (user?.id) {
            this.userId = user.id;
            this.loadFriendGroups();
            this.startStreaming();
            return;
        }

        const sub = this.membersService.getUserId({ skipGeolocation: true }).pipe(take(1)).subscribe({
            next: (member) => {
                if (this.destroyed) return;
                if (!member?.id) {
                    this.isLoading = false;
                    this.errorMessage = 'Error loading photos';
                    this.cdr.markForCheck();
                    return;
                }
                this.userId = member.id;
                this.loadFriendGroups();
                this.startStreaming();
                this.cdr.markForCheck();
            },
            error: () => {
                if (this.destroyed) return;
                this.isLoading = false;
                this.errorMessage = 'Error loading photos';
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
    }

    private loadFriendGroups(): void {
        const sub = this.friendsService.getFriendGroups().subscribe({
            next: (groups) => {
                if (this.destroyed) return;
                this.friendGroups = groups && Array.isArray(groups) ? groups : [];
                this.cdr.markForCheck();
            },
            error: () => { this.friendGroups = []; }
        });
        this.subscriptions.push(sub);
    }

    /** Sorted friend groups for the visibility filter dropdown (same as home-evenements). */
    getSortedFriendGroups(): FriendGroup[] {
        if (!this.friendGroups?.length) return [];
        return [...this.friendGroups].sort((a, b) =>
            (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())
        );
    }

    onVisibilityFilterChange(): void {
        this.loadTimeline();
    }

    /** List of visibility badges to display (one or more groups possible). */
    getVisibilityBadges(group: TimelineGroup): Array<{ text: string; badgeClass: string }> {
        const result: Array<{ text: string; badgeClass: string }> = [];
        const v = group.visibility;
        if (!v && !group.friendGroupIds?.length && !group.friendGroupId) return result;

        if (v === 'public') {
            result.push({ text: this.translate.instant('EVENTCREATION.PUBLIC'), badgeClass: 'bg-success' });
            return result;
        }
        if (v === 'private') {
            result.push({ text: this.translate.instant('EVENTCREATION.PRIVATE'), badgeClass: 'bg-warning text-dark' });
            return result;
        }
        if (v === 'friends') {
            result.push({ text: this.translate.instant('EVENTCREATION.FRIENDS'), badgeClass: 'bg-info' });
            return result;
        }

        const seenIds = new Set<string>();
        if (group.friendGroupIds?.length && this.friendGroups?.length) {
            for (const id of group.friendGroupIds) {
                if (seenIds.has(id)) continue;
                seenIds.add(id);
                const g = this.friendGroups.find(f => f.id === id);
                result.push({ text: g?.name || id, badgeClass: 'bg-primary' });
            }
        }
        if (group.friendGroupId && !seenIds.has(group.friendGroupId)) {
            seenIds.add(group.friendGroupId);
            const g = this.friendGroups?.find(f => f.id === group.friendGroupId);
            result.push({ text: g?.name || group.friendGroupId, badgeClass: 'bg-primary' });
        }
        if (result.length === 0 && v && v !== 'public' && v !== 'private' && v !== 'friends') {
            result.push({ text: v, badgeClass: 'bg-primary' });
        }
        return result;
    }

    loadTimeline(): void {
        this.timelineLoadGeneration++;
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
        this.onThisDayApiScheduled = false;
        this.videoTimelineFetchStarted = false;
        this.resetWallMediaObserverForTimelineReload();
        this.wallFetchQueue = [];
        const prevThumbUrls = new Map(this.thumbnailCache);
        const prevVideoUrls = new Map(this.videoUrlCache);
        this.thumbnailCache.clear();
        this.wallTrackStats.clear();
        this.wallTrackTableSort.clear();
        this.wallTrackTableExpanded.clear();
        this.wallPdfTableSort.clear();
        this.wallPdfTableExpanded.clear();
        this.videoUrlCache.clear();
        this.videoSafeUrlCache.clear();
        this.loadingThumbnails.clear();
        this.loadingVideos.clear();
        requestAnimationFrame(() => {
            this.revokeBlobUrlsInMap(prevThumbUrls);
            this.revokeBlobUrlsInMap(prevVideoUrls);
        });
        this.startStreaming();
    }

    private resetWallMediaObserverForTimelineReload(): void {
        if (this.wallMediaObserver) {
            this.wallMediaObserver.disconnect();
            this.wallMediaObserver = null;
        }
    }

    private revokeBlobUrlsInMap(idToUrl: Map<string, string>): void {
        idToUrl.forEach(url => {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
    }

    /** Prune closed subscriptions from the tracking array to avoid unbounded growth. */
    private pruneClosedSubscriptions(): void {
        if (this.subscriptions.length > 50) {
            this.subscriptions = this.subscriptions.filter(s => !s.closed);
        }
    }

    private startStreaming(): void {
        // Single timeline request at startup; the "videos only" timeline starts after the first photo response
        // (same as home which doesn’t open two heavy backends simultaneously at the first screen).
        this.fetchNext();
    }

    /** Starts getVideoTimeline once the first photo page is received (or on photo error). */
    private scheduleVideoTimelineFetchOnce(): void {
        if (this.destroyed || this.videoTimelineFetchStarted) {
            return;
        }
        this.videoTimelineFetchStarted = true;
        this.fetchNextVideos();
    }

    private loadOnThisDay(): void {
        const visibility = this.selectedVisibilityFilter.trim() !== 'all' ? this.selectedVisibilityFilter : undefined;
        const gen = this.timelineLoadGeneration;
        const sub = this.photoTimelineService.getOnThisDay(this.userId, visibility).subscribe({
            next: (photos) => {
                // Defer to avoid NG0100 on *ngIf="onThisDay.length > 0" (same cycle as the first template check)
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.onThisDay = photos || [];
                    this.cdr.markForCheck();
                    // OTD thumbnails: IntersectionObserver only (no loadThumbnail loop) to avoid
                    // saturating the shared queue with the wall (WALL_MEDIA_MAX_PARALLEL).
                    setTimeout(() => { if (!this.destroyed) this.scanWallMediaHosts(); }, 0);
                }, 0);
            },
            error: () => {
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.onThisDay = [];
                    this.cdr.markForCheck();
                }, 0);
            }
        });
        this.subscriptions.push(sub);
    }

    private fetchNext(): void {
        if (this.isFetching || !this.hasMore) return;
        this.isFetching = true;

        const search = this.searchFilter.trim() || undefined;
        const visibility = this.selectedVisibilityFilter.trim() !== 'all' ? this.selectedVisibilityFilter : undefined;
        const gen = this.timelineLoadGeneration;
        const pageSize = PAGE_SIZE;
        const sub = this.photoTimelineService.getTimeline(this.userId, this.nextPage, pageSize, search, visibility, this.filterEventId).subscribe({
            next: (response: TimelineResponse) => {
                // Defer state updates to next tick to avoid ExpressionChangedAfterItHasBeenCheckedError (NG0100)
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.isFetching = false;
                    this.hasMore = response.hasMore;
                    this.nextPage = response.page + 1;
                    this.scheduleVideoTimelineFetchOnce();

                    if (response.groups.length > 0) {
                        response.groups.forEach(g => this.bufferedGroups.push(g));
                        this.revealInitialBatch();
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
                    if (!this.filterEventId && !this.onThisDayApiScheduled) {
                        this.onThisDayApiScheduled = true;
                        this.loadOnThisDay();
                    }
                    this.cdr.markForCheck();
                }, 0);
            },
            error: (err) => {
                console.error('Error loading photo timeline:', err);
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.isFetching = false;
                    this.scheduleVideoTimelineFetchOnce();
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

        const search = this.searchFilter.trim() || undefined;
        const visibility = this.selectedVisibilityFilter.trim() !== 'all' ? this.selectedVisibilityFilter : undefined;
        const gen = this.timelineLoadGeneration;
        const pageSize = PAGE_SIZE;
        const sub = this.photoTimelineService.getVideoTimeline(this.userId, this.nextPageVideos, pageSize, search, visibility, this.filterEventId).subscribe({
            next: (response: TimelineResponse) => {
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.isFetchingVideos = false;
                    this.hasMoreVideos = response.hasMore;
                    this.nextPageVideos = response.page + 1;

                    if (response.groups.length > 0) {
                        response.groups.forEach(g => this.bufferedVideoGroups.push(g));
                        this.revealInitialBatch();
                    }

                    if (this.hasMoreVideos && this.bufferedVideoGroups.length < BUFFER_AHEAD) {
                        this.fetchNextVideos();
                    }
                    this.cdr.markForCheck();
                }, 0);
            },
            error: () => {
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.isFetchingVideos = false;
                    this.cdr.markForCheck();
                }, 0);
            }
        });
        this.subscriptions.push(sub);
    }

    /**
     * Reveals groups up to INITIAL_VISIBLE_GROUPS on first load,
     * to display several activities immediately on open (same as home-evenements).
     */
    private revealInitialBatch(): void {
        while (this.visibleGroups.length < INITIAL_VISIBLE_GROUPS &&
               (this.bufferedGroups.length > 0 || this.bufferedVideoGroups.length > 0)) {
            this.revealMore();
        }
    }

    /**
     * Reveals one group (oldest by date) from the photo/video buffers,
     * normalizes it if it is a video-only group, and adds it to visibleGroups.
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
        this.requestWallTrackStatsForGroup(group);
        if (this.visibleGroups.length === 1) {
            this.isLoading = false;
            setTimeout(() => { if (!this.destroyed) this.setupIntersectionObserver(); }, 50);
        }

        if (this.hasMore && this.bufferedGroups.length < BUFFER_AHEAD) this.fetchNext();
        if (this.hasMoreVideos && this.bufferedVideoGroups.length < BUFFER_AHEAD) this.fetchNextVideos();
        setTimeout(() => { if (!this.destroyed) this.setupIntersectionObserver(); }, 50);
        setTimeout(() => { if (!this.destroyed) this.scanWallMediaHosts(); }, 0);
    }

    private setupIntersectionObserver(): void {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }

        if (!this.scrollSentinel?.nativeElement) return;
        if (!this.hasMore && this.bufferedGroups.length === 0 && !this.hasMoreVideos && this.bufferedVideoGroups.length === 0) return;

        this.intersectionObserver = new IntersectionObserver(
            (entries) => {
                // Defer: observe() can call this synchronously; revealMore → preload → Http can emit sync → NG0100.
                setTimeout(() => {
                    if (this.destroyed) return;
                    if (entries[0].isIntersecting && (this.bufferedGroups.length > 0 || this.hasMore || this.bufferedVideoGroups.length > 0 || this.hasMoreVideos)) {
                        this.revealMore();
                    }
                }, 0);
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
            setTimeout(() => {
                if (this.destroyed) return;
                if (this.bufferedGroups.length === 0 && !this.hasMore && this.bufferedVideoGroups.length === 0 && !this.hasMoreVideos) return;
                this.revealMore();
            }, 0);
        }
    }

    /** Visible groups; filtering is applied server-side via the search parameter. */
    get filteredGroups(): TimelineGroup[] {
        return this.visibleGroups;
    }

    onFilterChange(): void {
        if (this.searchDebounceId != null) {
            clearTimeout(this.searchDebounceId);
        }
        this.searchDebounceId = setTimeout(() => {
            this.searchDebounceId = null;
            if (!this.destroyed) {
                this.loadTimeline();
            }
        }, 400);
    }

    clearFilter(): void {
        this.searchFilter = '';
        if (this.searchDebounceId != null) {
            clearTimeout(this.searchDebounceId);
            this.searchDebounceId = null;
        }
        this.loadTimeline();
    }

    isTimelineGroupRefreshing(group: TimelineGroup): boolean {
        return !!(group?.eventId && this.refreshingGroupEventIds.has(group.eventId));
    }

    /**
     * Reloads photos/videos for a single event (timeline API filtered by eventId), without reloading the whole wall.
     */
    refreshTimelineGroup(group: TimelineGroup): void {
        const eventId = group?.eventId;
        if (!eventId || this.refreshingGroupEventIds.has(eventId)) return;

        this.refreshingGroupEventIds.add(eventId);
        this.cdr.markForCheck();

        const search = this.searchFilter.trim() || undefined;
        const visibility = this.selectedVisibilityFilter.trim() !== 'all' ? this.selectedVisibilityFilter : undefined;
        const size = 200;
        const emptyRes = (): TimelineResponse => ({
            groups: [],
            totalPhotos: 0,
            totalGroups: 0,
            page: 0,
            pageSize: size,
            hasMore: false,
            onThisDay: []
        });

        const sub = forkJoin({
            photos: this.photoTimelineService
                .getTimeline(this.userId, 0, size, search, visibility, eventId)
                .pipe(catchError(() => of(emptyRes()))),
            videos: this.photoTimelineService
                .getVideoTimeline(this.userId, 0, size, search, visibility, eventId)
                .pipe(catchError(() => of(emptyRes())))
        }).subscribe({
            next: ({ photos, videos }) => {
                if (this.destroyed) return;
                const idx = this.visibleGroups.findIndex(g => g.eventId === eventId);
                if (idx >= 0) {
                    const updated = this.mergeRefetchedTimelineGroup(photos, videos, eventId, group);
                    this.visibleGroups = [
                        ...this.visibleGroups.slice(0, idx),
                        updated,
                        ...this.visibleGroups.slice(idx + 1)
                    ];
                    this.preloadThumbnailsForGroup(updated);
                    this.requestWallTrackStatsForGroup(updated);
                }
                this.refreshingGroupEventIds.delete(eventId);
                this.cdr.markForCheck();
            },
            error: () => {
                if (this.destroyed) return;
                this.refreshingGroupEventIds.delete(eventId);
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
    }

    private mergeRefetchedTimelineGroup(
        photoRes: TimelineResponse,
        videoRes: TimelineResponse,
        eventId: string,
        fallback: TimelineGroup
    ): TimelineGroup {
        const pick = (res: TimelineResponse) =>
            res.groups?.find(g => g.eventId === eventId) ?? res.groups?.[0];

        const photoGroup = pick(photoRes);
        const photoHasWallContent =
            (photoGroup?.photos?.length ?? 0) > 0
            || (photoGroup?.fsPhotoLinks?.length ?? 0) > 0;
        if (photoGroup && photoHasWallContent) {
            return { ...photoGroup };
        }

        const videoGroup = pick(videoRes);
        if (videoGroup && (videoGroup.photos?.length ?? 0) > 0) {
            return {
                ...videoGroup,
                photos: [],
                videos: videoGroup.photos || [],
                fsPhotoLinks: videoGroup.fsPhotoLinks || []
            };
        }

        return {
            ...fallback,
            photos: [],
            videos: [],
            fsPhotoLinks: photoGroup?.fsPhotoLinks ?? fallback.fsPhotoLinks ?? []
        };
    }

    /** Group media: photos and videos interleaved, not videos first. */
    getGroupMedia(group: TimelineGroup): GroupMediaItem[] {
        const cached = this.groupMediaCache.get(group);
        if (cached) return cached;

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
        this.groupMediaCache.set(group, list);
        return list;
    }

    private isVideoFile(fileName: string): boolean {
        if (!fileName) return false;
        const lower = fileName.toLowerCase();
        const ext = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.m4v', '.3gp'];
        return ext.some(e => lower.endsWith(e));
    }

    getThumbnailUrl(photo: TimelinePhoto): string | null {
        return this.thumbnailCache.get(photo.fileId) ?? null;
    }

    /** Read-only: safe URL is always written with blob URL in {@link loadVideoUrl} (no lazy fill here — avoids NG0100). */
    getVideoUrl(video: TimelinePhoto): SafeUrl | null {
        return this.videoSafeUrlCache.get(video.fileId) ?? null;
    }

    private acquireWallFetchSlot(job: () => void): void {
        if (this.destroyed) return;
        if (this.wallFetchActive < getAdaptiveMaxParallel()) {
            this.wallFetchActive++;
            job();
        } else {
            this.wallFetchQueue.push(job);
        }
    }

    private releaseWallFetchSlot(): void {
        if (this.destroyed) {
            this.wallFetchActive = Math.max(0, this.wallFetchActive - 1);
            return;
        }
        this.wallFetchActive--;
        while (this.wallFetchActive < getAdaptiveMaxParallel() && this.wallFetchQueue.length > 0) {
            const next = this.wallFetchQueue.shift()!;
            this.wallFetchActive++;
            next();
        }
        this.pruneClosedSubscriptions();
    }

    private loadVideoUrl(video: TimelinePhoto): void {
        const id = video.fileId;
        if (this.videoUrlCache.has(id) || this.loadingVideos.has(id)) {
            return;
        }
        this.loadingVideos.add(id);
        this.acquireWallFetchSlot(() => {
            const gen = this.timelineLoadGeneration;
            const sub = this.fileService.getFile(id).pipe(
                finalize(() => this.releaseWallFetchSlot())
            ).subscribe({
                next: (data: ArrayBuffer) => {
                    this.commitWallMediaCachesAndScheduleCdr(() => {
                        if (this.destroyed || gen !== this.timelineLoadGeneration) {
                            this.loadingVideos.delete(id);
                            return;
                        }
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
                    });
                },
                error: () => {
                    this.commitWallMediaCachesAndScheduleCdr(() => {
                        if (this.destroyed) return;
                        this.loadingVideos.delete(id);
                    });
                }
            });
            this.subscriptions.push(sub);
        });
    }

    private loadThumbnail(photo: TimelinePhoto): void {
        if (this.loadingThumbnails.has(photo.fileId) || this.thumbnailCache.has(photo.fileId)) {
            return;
        }
        this.loadingThumbnails.add(photo.fileId);
        this.acquireWallFetchSlot(() => {
            const gen = this.timelineLoadGeneration;
            const sub = this.fileService.getFileWallPreview(photo.fileId, getAdaptiveThumbMaxEdge()).pipe(
                finalize(() => this.releaseWallFetchSlot())
            ).subscribe({
                next: (data: ArrayBuffer) => {
                    this.commitWallMediaCachesAndScheduleCdr(() => {
                        if (this.destroyed || gen !== this.timelineLoadGeneration) {
                            this.loadingThumbnails.delete(photo.fileId);
                            return;
                        }
                        const blob = new Blob([data], { type: 'image/jpeg' });
                        const url = URL.createObjectURL(blob);
                        this.thumbnailCache.set(photo.fileId, url);
                        this.loadingThumbnails.delete(photo.fileId);
                    });
                },
                error: () => {
                    this.commitWallMediaCachesAndScheduleCdr(() => {
                        if (this.destroyed) return;
                        this.loadingThumbnails.delete(photo.fileId);
                    });
                }
            });
            this.subscriptions.push(sub);
        });
    }

    private ensureWallMediaObserver(): void {
        if (this.destroyed || this.wallMediaObserver) {
            return;
        }
        this.wallMediaObserver = new IntersectionObserver(
            (entries) => {
                // Defer: observe() can deliver callbacks synchronously while Angular is still checking
                // bindings — a sync HTTP emit would flip *ngIf="!getVideoUrl(...)" and trigger NG0100.
                setTimeout(() => {
                    if (this.destroyed) return;
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        const el = entry.target as HTMLElement;
                        const fid = el.dataset['fileId']?.trim();
                        const ft = el.dataset['fileType']?.trim();
                        this.wallMediaObserver?.unobserve(el);
                        if (!fid) continue;
                        if (el.classList.contains('wall-video-file-host')) {
                            this.loadWallVideo(fid, ft || 'video/mp4');
                        } else {
                            this.loadWallThumbnail(fid, ft || 'image/jpeg');
                        }
                    }
                }, 0);
            },
            { root: null, rootMargin: '500px', threshold: 0.01 }
        );
    }

    private scanWallMediaHosts(): void {
        if (this.destroyed || typeof document === 'undefined') return;
        this.ensureWallMediaObserver();
        if (!this.wallMediaObserver) return;
        const sel =
            '.wall-photo-thumb-host[data-file-id]:not([data-wall-media-observed]),' +
            '.wall-video-file-host[data-file-id]:not([data-wall-media-observed])';
        document.querySelectorAll(sel).forEach((el) => {
            el.setAttribute('data-wall-media-observed', '1');
            this.wallMediaObserver!.observe(el);
        });
    }

    private loadWallThumbnail(fileId: string, fileType: string): void {
        if (!fileId || this.thumbnailCache.has(fileId) || this.loadingThumbnails.has(fileId)) {
            return;
        }
        const photo = {
            fileId,
            fileName: '',
            fileType: fileType || 'image/jpeg',
            uploaderName: '',
            eventId: '',
            eventName: '',
            eventType: '',
            eventDate: ''
        } as TimelinePhoto;
        this.loadThumbnail(photo);
    }

    private loadWallVideo(fileId: string, fileType: string): void {
        if (!fileId || this.videoUrlCache.has(fileId) || this.loadingVideos.has(fileId)) {
            return;
        }
        const video = {
            fileId,
            fileName: '',
            fileType: fileType || 'video/mp4',
            uploaderName: '',
            eventId: '',
            eventName: '',
            eventType: '',
            eventDate: ''
        } as TimelinePhoto;
        this.loadVideoUrl(video);
    }

    /**
     * Starts thumbnail fetching immediately for revealed groups, without waiting for IntersectionObserver
     * (otherwise there is a one-frame delay + observer callback before the first HTTP request).
     * Videos remain loaded on demand (observer) to avoid downloading large files outside the viewport.
     */
    private preloadThumbnailsForGroup(group: TimelineGroup): void {
        const photos = group.photos || [];
        const isFirstScreen = this.visibleGroups.length <= INITIAL_VISIBLE_GROUPS;
        // Few immediate requests: the rest go through IntersectionObserver (like home cards).
        const limit = isFirstScreen
            ? Math.min(photos.length, WALL_PRELOAD_THUMBS_FIRST_SCREEN)
            : Math.min(photos.length, WALL_PRELOAD_THUMBS_AFTER);
        for (let i = 0; i < limit; i++) {
            this.loadThumbnail(photos[i]);
        }
        setTimeout(() => { if (!this.destroyed) this.scanWallMediaHosts(); }, 0);
    }

    /** Returns the first photo's thumbnail URL for the group, or null. Used as background image for the group container. */
    getGroupThumbnailUrl(group: TimelineGroup): string | null {
        const first = (group.photos && group.photos.length > 0) ? group.photos[0] : null;
        return first ? this.getThumbnailUrl(first) : null;
    }

    /** Safe style for background-image (thumbnail) on the group container. */
    getGroupThumbnailStyle(group: TimelineGroup): SafeStyle | null {
        const url = this.getGroupThumbnailUrl(group);
        if (!url) return null;
        const escaped = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return this.sanitizer.bypassSecurityTrustStyle(`background-image: url("${escaped}");`);
    }

    openSlideshow(group: TimelineGroup, startIndex: number): void {
        if (!this.slideshowModalComponent) return;
        const images: SlideshowImageSource[] = group.photos.map(p => ({
            fileId: p.fileId,
            fileName: p.fileName
        }));
        this.slideshowModalComponent.open(images, group.eventName, true, 0, undefined, startIndex);
    }

    /** Opens the event card in an overlay (without NgbModal to avoid removeChild errors on close). */
    eventIdForCard: string | null = null;
    openEventCardModal(group: TimelineGroup): void {
        this.eventIdForCard = group.eventId;
    }
    closeEventCardOverlay(): void {
        this.eventIdForCard = null;
    }

    /** Opens the video in the player modal (photo wall). */
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

    /** True when the signed-in user owns this timeline group (same rule as détail événement / add-to-DB). */
    isTimelineGroupOwner(group: TimelineGroup): boolean {
        const user = this.membersService.getUser();
        if (!user?.userName || !group?.ownerUserName) {
            return false;
        }
        return user.userName.toLowerCase() === group.ownerUserName.toLowerCase();
    }

    /** Only PHOTOFROMFS (or absent type = legacy) opens the slideshow from disk. */
    isPhotoWallFsFromDiskLink(link: FsPhotoLink): boolean {
        const t = (link.typeUrl || '').trim().toUpperCase();
        return t === '' || t === 'PHOTOFROMFS';
    }

    /** GPX/KML/… stored in GridFS (opens trace viewer); shown in the wall track table, not as a badge. */
    isMongoTrackLink(link: FsPhotoLink): boolean {
        const t = (link.typeUrl || '').trim().toUpperCase();
        const id = (link.fieldId || '').trim();
        if (!id) {
            return false;
        }
        return t === 'TRACK' || t === 'TRACE' || t === 'GPX';
    }

    /** PDF déposé sur l’activité (GridFS) : tableau mur, pas badge. */
    isMongoWallPdfLink(link: FsPhotoLink): boolean {
        const t = (link.typeUrl || '').trim().toUpperCase();
        const id = (link.fieldId || '').trim();
        if (!id || t !== 'PDF') {
            return false;
        }
        return true;
    }

    getGroupMongoTrackLinks(group: TimelineGroup): FsPhotoLink[] {
        if (!group?.fsPhotoLinks?.length) {
            return [];
        }
        return group.fsPhotoLinks.filter(l => this.isMongoTrackLink(l));
    }

    getGroupWallPdfLinks(group: TimelineGroup): FsPhotoLink[] {
        if (!group?.fsPhotoLinks?.length) {
            return [];
        }
        return group.fsPhotoLinks.filter(l => this.isMongoWallPdfLink(l));
    }

    /** PDF triés pour le tableau (état par événement). */
    getSortedWallPdfLinks(group: TimelineGroup): FsPhotoLink[] {
        const list = this.getGroupWallPdfLinks(group);
        if (list.length <= 1) {
            return list;
        }
        const evId = group?.eventId || '';
        const cur = this.wallPdfTableSort.get(evId) ?? { col: 'name' as const, asc: true };
        const mul = cur.asc ? 1 : -1;
        const copy = [...list];
        copy.sort((a, b) => {
            const c = mul * this.compareWallPdfRows(a, b, cur.col);
            if (c !== 0) {
                return c;
            }
            return (a.fieldId || '').localeCompare(b.fieldId || '');
        });
        return copy;
    }

    getDisplayedWallPdfLinks(group: TimelineGroup): FsPhotoLink[] {
        const sorted = this.getSortedWallPdfLinks(group);
        if (sorted.length <= 1) {
            return sorted;
        }
        if (this.isWallPdfTableExpanded(group)) {
            return sorted;
        }
        return sorted.slice(0, 1);
    }

    isWallPdfTableExpanded(group: TimelineGroup): boolean {
        return this.wallPdfTableExpanded.get(group?.eventId || '') === true;
    }

    wallPdfTableHasMultipleRows(group: TimelineGroup): boolean {
        return this.getGroupWallPdfLinks(group).length > 1;
    }

    onWallPdfTableToggleExpand(group: TimelineGroup, ev?: Event): void {
        ev?.stopPropagation();
        const id = group?.eventId || '';
        if (!id) {
            return;
        }
        const next = !this.isWallPdfTableExpanded(group);
        this.wallPdfTableExpanded.set(id, next);
        this.scheduleCdr();
    }

    getWallPdfTableSort(group: TimelineGroup): {
        col: 'name' | 'file' | 'owner';
        asc: boolean;
    } {
        return this.wallPdfTableSort.get(group?.eventId || '') ?? { col: 'name', asc: true };
    }

    onWallPdfSortClick(group: TimelineGroup, col: 'name' | 'file' | 'owner', ev?: Event): void {
        ev?.stopPropagation();
        const id = group?.eventId || '';
        const prev = this.wallPdfTableSort.get(id) ?? { col: 'name' as const, asc: true };
        const asc = prev.col === col ? !prev.asc : true;
        this.wallPdfTableSort.set(id, { col, asc });
        this.scheduleCdr();
    }

    wallPdfSortIconClass(group: TimelineGroup, col: 'name' | 'file' | 'owner'): string {
        const s = this.getWallPdfTableSort(group);
        if (s.col !== col) {
            return 'fa fa-sort opacity-50';
        }
        return s.asc ? 'fa fa-sort-asc' : 'fa fa-sort-desc';
    }

    private compareWallPdfRows(a: FsPhotoLink, b: FsPhotoLink, col: 'name' | 'file' | 'owner'): number {
        switch (col) {
            case 'name':
                return (a.description || a.path).localeCompare(b.description || b.path, undefined, { sensitivity: 'base' });
            case 'file':
                return (a.path || '').localeCompare(b.path || '', undefined, { sensitivity: 'base' });
            case 'owner':
                return (a.uploaderUserName || '').localeCompare(b.uploaderUserName || '', undefined, { sensitivity: 'base' });
            default:
                return 0;
        }
    }

    /** Traces triées pour le tableau (état par événement). */
    getSortedMongoTrackLinks(group: TimelineGroup): FsPhotoLink[] {
        const list = this.getGroupMongoTrackLinks(group);
        if (list.length <= 1) {
            return list;
        }
        const evId = group?.eventId || '';
        const cur = this.wallTrackTableSort.get(evId) ?? { col: 'date' as const, asc: false };
        const mul = cur.asc ? 1 : -1;
        const copy = [...list];
        copy.sort((a, b) => {
            const c = cur.col === 'date'
                ? this.compareWallTrackDate(a, b, cur.asc)
                : mul * this.compareWallTrackRows(a, b, cur.col);
            if (c !== 0) {
                return c;
            }
            return (a.fieldId || '').localeCompare(b.fieldId || '');
        });
        return copy;
    }

    /** Lignes affichées : par défaut la plus récente seule ; déplié = liste complète triée. */
    getDisplayedMongoTrackLinks(group: TimelineGroup): FsPhotoLink[] {
        const sorted = this.getSortedMongoTrackLinks(group);
        if (sorted.length <= 1) {
            return sorted;
        }
        if (this.isWallTrackTableExpanded(group)) {
            return sorted;
        }
        return sorted.slice(0, 1);
    }

    isWallTrackTableExpanded(group: TimelineGroup): boolean {
        return this.wallTrackTableExpanded.get(group?.eventId || '') === true;
    }

    wallTrackTableHasMultipleRows(group: TimelineGroup): boolean {
        return this.getGroupMongoTrackLinks(group).length > 1;
    }

    onWallTrackTableToggleExpand(group: TimelineGroup, ev?: Event): void {
        ev?.stopPropagation();
        const id = group?.eventId || '';
        if (!id) {
            return;
        }
        const next = !this.isWallTrackTableExpanded(group);
        this.wallTrackTableExpanded.set(id, next);
        this.scheduleCdr();
    }

    getWallTrackTableSort(group: TimelineGroup): {
        col: 'name' | 'file' | 'owner' | 'date' | 'km' | 'elev';
        asc: boolean;
    } {
        return this.wallTrackTableSort.get(group?.eventId || '') ?? { col: 'date', asc: false };
    }

    onWallTrackSortClick(group: TimelineGroup, col: 'name' | 'file' | 'owner' | 'date' | 'km' | 'elev', ev?: Event): void {
        ev?.stopPropagation();
        const id = group?.eventId || '';
        const prev = this.wallTrackTableSort.get(id) ?? { col: 'date', asc: false };
        const asc = prev.col === col ? !prev.asc : true;
        this.wallTrackTableSort.set(id, { col, asc });
        this.scheduleCdr();
    }

    wallTrackSortIconClass(group: TimelineGroup, col: 'name' | 'file' | 'owner' | 'date' | 'km' | 'elev'): string {
        const s = this.getWallTrackTableSort(group);
        if (s.col !== col) {
            return 'fa fa-sort opacity-50';
        }
        return s.asc ? 'fa fa-sort-asc' : 'fa fa-sort-desc';
    }

    /**
     * Tri par date : sans date en dernier ; asc = ancien d’abord, asc = false = récent d’abord.
     */
    private compareWallTrackDate(a: FsPhotoLink, b: FsPhotoLink, asc: boolean): number {
        const am = this.getTrackSortDateMs(a);
        const bm = this.getTrackSortDateMs(b);
        const aMiss = am === Number.POSITIVE_INFINITY;
        const bMiss = bm === Number.POSITIVE_INFINITY;
        if (aMiss && bMiss) {
            return 0;
        }
        if (aMiss) {
            return 1;
        }
        if (bMiss) {
            return -1;
        }
        const diff = am - bm;
        return asc ? diff : -diff;
    }

    private compareWallTrackRows(a: FsPhotoLink, b: FsPhotoLink, col: 'name' | 'file' | 'owner' | 'km' | 'elev'): number {
        switch (col) {
            case 'name':
                return (a.description || a.path).localeCompare(b.description || b.path, undefined, { sensitivity: 'base' });
            case 'file':
                return (a.path || '').localeCompare(b.path || '', undefined, { sensitivity: 'base' });
            case 'owner':
                return (a.uploaderUserName || '').localeCompare(b.uploaderUserName || '', undefined, { sensitivity: 'base' });
            case 'km':
                return this.getTrackSortKm(a) - this.getTrackSortKm(b);
            case 'elev':
                return this.getTrackSortElev(a) - this.getTrackSortElev(b);
            default:
                return 0;
        }
    }

    private getTrackSortDateMs(tr: FsPhotoLink): number {
        if (this.isManualTrackActivityDateSet(tr)) {
            const t = (tr.manualActivityDate || '').trim();
            const ms = new Date(t.includes('T') ? t : `${t}T12:00:00`).getTime();
            return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
        }
        const iso = this.getWallTrackStat(tr.fieldId)?.fileDateIso;
        if (!iso) {
            return Number.POSITIVE_INFINITY;
        }
        const ms = new Date(iso).getTime();
        return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
    }

    private getTrackSortKm(tr: FsPhotoLink): number {
        if (this.isManualTrackDistanceSet(tr)) {
            return Number(tr.manualDistanceKm);
        }
        const st = this.getWallTrackStat(tr.fieldId);
        if (!st || st.loading) {
            return Number.POSITIVE_INFINITY;
        }
        if (st.error || st.distanceKm == null || !Number.isFinite(st.distanceKm)) {
            return Number.POSITIVE_INFINITY;
        }
        return st.distanceKm;
    }

    private getTrackSortElev(tr: FsPhotoLink): number {
        if (this.isManualTrackElevationSet(tr)) {
            return Number(tr.manualElevationGainM);
        }
        const st = this.getWallTrackStat(tr.fieldId);
        if (!st || st.loading) {
            return Number.POSITIVE_INFINITY;
        }
        if (st.error || st.elevationGainM == null || !Number.isFinite(st.elevationGainM)) {
            return Number.POSITIVE_INFINITY;
        }
        return st.elevationGainM;
    }

    /** Footer badges: all links except Mongo-backed tracks and PDFs (those use the tables). */
    getGroupBadgeLinks(group: TimelineGroup): FsPhotoLink[] {
        if (!group?.fsPhotoLinks?.length) {
            return [];
        }
        return group.fsPhotoLinks.filter(l => !this.isMongoTrackLink(l) && !this.isMongoWallPdfLink(l));
    }

    trackByTrackFieldId(_index: number, link: FsPhotoLink): string {
        return (link.fieldId || '').trim() || link.path;
    }

    getWallTrackStat(fieldId: string | undefined | null): {
        loading: boolean;
        error?: boolean;
        distanceKm: number | null;
        elevationGainM: number | null;
        fileDateIso: string | null;
    } | undefined {
        const id = (fieldId || '').trim();
        if (!id) {
            return undefined;
        }
        return this.wallTrackStats.get(id);
    }

    formatWallTrackKm(km: number | null | undefined): string {
        if (km == null || !Number.isFinite(km)) {
            return '—';
        }
        if (km <= 0) {
            return '-';
        }
        return `${km} km`;
    }

    formatWallTrackDplus(m: number | null | undefined): string {
        if (m == null || !Number.isFinite(m)) {
            return '—';
        }
        if (m <= 0) {
            return '-';
        }
        return `${m} m`;
    }

    /** Date read from the trace file (not the activity event date). */
    formatWallTrackFileDate(iso: string | null | undefined): string {
        if (!iso) {
            return '—';
        }
        return this.formatEventDate(iso);
    }

    /** Date saisie à la main (yyyy-MM-dd) ou ISO. */
    formatWallTrackManualDate(s: string | null | undefined): string {
        const t = (s || '').trim();
        if (!t) {
            return '—';
        }
        const iso = t.includes('T') ? t : `${t}T12:00:00`;
        return this.formatEventDate(iso);
    }

    isManualTrackDistanceSet(tr: FsPhotoLink): boolean {
        return tr.manualDistanceKm != null && Number.isFinite(Number(tr.manualDistanceKm));
    }

    isManualTrackElevationSet(tr: FsPhotoLink): boolean {
        return tr.manualElevationGainM != null && Number.isFinite(Number(tr.manualElevationGainM));
    }

    isManualTrackActivityDateSet(tr: FsPhotoLink): boolean {
        return !!(tr.manualActivityDate || '').trim();
    }

    /** Les trois valeurs sont renseignées : pas de téléchargement du fichier pour les stats. */
    private isTrackStatsFullyManual(tr: FsPhotoLink): boolean {
        return this.isManualTrackDistanceSet(tr)
            && this.isManualTrackElevationSet(tr)
            && this.isManualTrackActivityDateSet(tr);
    }

    private requestWallTrackStatsForGroup(group: TimelineGroup): void {
        const tracks = this.getGroupMongoTrackLinks(group);
        if (!tracks.length) {
            return;
        }
        const gen = this.timelineLoadGeneration;
        for (const link of tracks) {
            const id = (link.fieldId || '').trim();
            if (!id || this.wallTrackStats.has(id)) {
                continue;
            }
            if (this.isTrackStatsFullyManual(link)) {
                const dStr = (link.manualActivityDate || '').trim();
                const fileDateIso = dStr
                    ? new Date(dStr.includes('T') ? dStr : `${dStr}T12:00:00`).toISOString()
                    : null;
                this.wallTrackStats.set(id, {
                    loading: false,
                    distanceKm: Number(link.manualDistanceKm),
                    elevationGainM: Math.round(Number(link.manualElevationGainM)),
                    fileDateIso
                });
                continue;
            }
            this.wallTrackStats.set(id, {
                loading: true,
                distanceKm: null,
                elevationGainM: null,
                fileDateIso: null
            });
            const fileName = (link.path || '').trim() || 'track.gpx';
            const sub = this.fileService.getFile(id).subscribe({
                next: (buffer: ArrayBuffer) => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) {
                        return;
                    }
                    try {
                        const text = new TextDecoder('utf-8').decode(buffer);
                        const stats = computeTrackStatsFromFileContent(fileName, text);
                        const dManual = (link.manualActivityDate || '').trim();
                        const fileDateIso = dManual
                            ? new Date(dManual.includes('T') ? dManual : `${dManual}T12:00:00`).toISOString()
                            : stats.fileDateIso;
                        this.wallTrackStats.set(id, {
                            loading: false,
                            distanceKm: this.isManualTrackDistanceSet(link)
                                ? Number(link.manualDistanceKm)
                                : stats.distanceKm,
                            elevationGainM: this.isManualTrackElevationSet(link)
                                ? Math.round(Number(link.manualElevationGainM))
                                : stats.elevationGainM,
                            fileDateIso
                        });
                    } catch {
                        this.wallTrackStats.set(id, {
                            loading: false,
                            error: true,
                            distanceKm: null,
                            elevationGainM: null,
                            fileDateIso: null
                        });
                    }
                    this.scheduleCdr();
                },
                error: () => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) {
                        return;
                    }
                    this.wallTrackStats.set(id, {
                        loading: false,
                        error: true,
                        distanceKm: null,
                        elevationGainM: null,
                        fileDateIso: null
                    });
                    this.scheduleCdr();
                }
            });
            this.subscriptions.push(sub);
        }
        this.scheduleCdr();
    }

    /** Font Awesome 4 icons, aligned with the event detail page. */
    getPhotoWallLinkIcon(link: FsPhotoLink): string {
        if (this.isPhotoWallFsFromDiskLink(link)) {
            return 'fa-desktop';
        }
        const t = (link.typeUrl || '').trim().toUpperCase() || 'OTHER';
        if (t === 'PDF') return 'fa-file-pdf-o';
        if (t === 'MAP' || t === 'CARTE') return 'fa-map-marker';
        if (t === 'WEBSITE' || t === 'SITE' || t === 'WEB') return 'fa-globe';
        if (t === 'DOCUMENTATION' || t === 'DOC' || t === 'FICHE') return 'fa-file-text';
        if (t === 'PHOTOS' || t === 'PHOTO') return 'fa-picture-o';
        if (t === 'VIDEO' || t === 'VIDÉO' || t === 'YOUTUBE' || t === 'VIMEO') return 'fa-video-camera';
        if (t === 'WHATSAPP' || t === 'WA') return 'fa-whatsapp';
        if (t === 'TRACK' || t === 'TRACE' || t === 'GPX') return 'fa-road';
        return 'fa-external-link';
    }

    /**
     * Libellé court d’action (clé i18n PHOTO_TIMELINE.*) pour les badges sous le mur.
     */
    getPhotoWallLinkActionLabelKey(link: FsPhotoLink): string {
        if (this.isPhotoWallFsFromDiskLink(link)) {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_DISK_PHOTOS';
        }
        const t = (link.typeUrl || '').trim().toUpperCase() || 'OTHER';
        const path = (link.path || '').trim().toLowerCase();
        if (t === 'PDF') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_PDF';
        }
        if (t === 'TRACK' || t === 'TRACE' || t === 'GPX') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_TRACE';
        }
        if (t === 'MAP' || t === 'CARTE') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_MAP';
        }
        if (t === 'WEBSITE' || t === 'SITE' || t === 'WEB') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_WEBSITE';
        }
        if (t === 'VIDEO' || t === 'VIDÉO' || t === 'YOUTUBE' || t === 'VIMEO') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_VIDEO';
        }
        if (t === 'WHATSAPP' || t === 'WA') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_WHATSAPP';
        }
        if (t === 'PHOTOS' || t === 'PHOTO') {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_PHOTO_GALLERY';
        }
        if (t === 'DOCUMENTATION' || t === 'DOC' || t === 'FICHE') {
            return path.endsWith('.pdf') ? 'PHOTO_TIMELINE.LINK_ACTION_OPEN_PDF' : 'PHOTO_TIMELINE.LINK_ACTION_OPEN_DOCUMENT';
        }
        if (path.endsWith('.pdf')) {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_PDF';
        }
        if (path.startsWith('http://') || path.startsWith('https://')) {
            return 'PHOTO_TIMELINE.LINK_ACTION_OPEN_LINK';
        }
        return 'PHOTO_TIMELINE.LINK_ACTION_OPEN';
    }

    /** Footer click: disk slideshow only for PHOTOFROMFS; Mongo track → viewer; PDF → blob; otherwise new tab. */
    onPhotoWallFooterLinkClick(fsLink: FsPhotoLink, group: TimelineGroup): void {
        const t = (fsLink.typeUrl || '').trim().toUpperCase();
        if (t === 'PDF' && (fsLink.fieldId || '').trim()) {
            this.openWallPdfInNewTab(fsLink);
            return;
        }
        if ((t === 'TRACK' || t === 'TRACE' || t === 'GPX') && fsLink.fieldId) {
            const pathPart = (fsLink.path || '').trim();
            const descPart = (fsLink.description || '').trim();
            const fileName = pathPart || descPart || 'track';
            const displayTitle = descPart && descPart !== pathPart ? descPart : undefined;
            if (this.traceViewerModalComponent) {
                this.traceViewerModalComponent.openFromFile(fsLink.fieldId, fileName, undefined, displayTitle);
            }
            return;
        }
        if (this.isPhotoWallFsFromDiskLink(fsLink)) {
            this.openFsSlideshow(fsLink, group);
            return;
        }
        const url = (fsLink.path || '').trim();
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
    }

    /** Ouvre un PDF GridFS dans un nouvel onglet (même principe que le détail événement). */
    private openWallPdfInNewTab(fsLink: FsPhotoLink): void {
        const id = (fsLink.fieldId || '').trim();
        if (!id) {
            return;
        }
        const fileName = (fsLink.path || '').trim() || 'document.pdf';
        const sub = this.fileService.getFile(id).subscribe({
            next: (buffer: ArrayBuffer) => {
                if (this.destroyed) {
                    return;
                }
                try {
                    const pdfBlob = new Blob([buffer], { type: 'application/pdf' });
                    const objectUrl = URL.createObjectURL(pdfBlob);
                    const newWindow = window.open(objectUrl, '_blank', 'width=1200,height=800,scrollbars=yes,resizable=yes,toolbar=yes,menubar=yes');
                    if (newWindow) {
                        newWindow.focus();
                    }
                    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
                } catch (e) {
                    console.error('Wall PDF open failed', e);
                    alert(this.translate.instant('EVENTELEM.ERROR_LOADING_PDF'));
                }
            },
            error: (err) => {
                console.error('Wall PDF load failed', err);
                alert(this.translate.instant('EVENTELEM.ERROR_LOADING_PDF'));
            }
        });
        this.subscriptions.push(sub);
    }

    /** Télécharge un PDF lié au mur (GridFS). */
    onWallPdfFileDownloadClick(pdf: FsPhotoLink, ev?: Event): void {
        ev?.stopPropagation();
        const id = (pdf.fieldId || '').trim();
        if (!id) {
            return;
        }
        const fileName = (pdf.path || '').trim() || 'document.pdf';
        const sub = this.fileService.getFile(id).subscribe({
            next: (buffer: ArrayBuffer) => {
                const blob = new Blob([buffer], { type: 'application/pdf' });
                if ((navigator as any).msSaveBlob) {
                    (navigator as any).msSaveBlob(blob, fileName);
                    return;
                }
                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
            },
            error: (err) => console.error('Wall PDF download failed', err)
        });
        this.subscriptions.push(sub);
    }

    /** Télécharge le fichier trace (GridFS) depuis l’API fichier. */
    onWallTrackFileDownloadClick(tr: FsPhotoLink, ev?: Event): void {
        ev?.stopPropagation();
        const id = (tr.fieldId || '').trim();
        if (!id) {
            return;
        }
        const fileName = (tr.path || '').trim() || 'track.gpx';
        const sub = this.fileService.getFile(id).subscribe({
            next: (buffer: ArrayBuffer) => {
                const blob = new Blob([buffer], { type: 'application/octet-stream' });
                if ((navigator as any).msSaveBlob) {
                    (navigator as any).msSaveBlob(blob, fileName);
                    return;
                }
                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
            },
            error: (err) => console.error('Wall track download failed', err)
        });
        this.subscriptions.push(sub);
    }

    openFsSlideshow(fsLink: FsPhotoLink, group: TimelineGroup): void {
        if (!this.slideshowModalComponent) return;

        const eventId = group.eventId;
        const eventName = group.eventName;
        const canAddToDb = this.isTimelineGroupOwner(group);

        this.fsSlideshowLoadingActive = true;
        this.currentFsSlideshowEventId = eventId;
        this.slideshowModalComponent.open([], eventName, false, 0, undefined, 0, eventId, canAddToDb);

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

    /** Opens the trace viewer at the photo location when user clicks "Open in trace" from the slideshow. */
    onSlideshowLocationInTrace(event: SlideshowLocationEvent): void {
        if (!event || typeof event.lat !== 'number' || typeof event.lng !== 'number') return;
        const label = event.label?.trim()
            ? event.label
            : this.translate.instant('EVENTELEM.SEE_LOCATION');
        if (this.slideshowModalComponent) {
            this.slideshowModalComponent.setTraceViewerOpen(true);
        }
        if (this.traceViewerModalComponent) {
            this.traceViewerModalComponent.openAtLocation(event.lat, event.lng, label, event.eventColor);
        }
    }

    onTraceViewerClosed(): void {
        if (this.slideshowModalComponent) {
            this.slideshowModalComponent.setTraceViewerOpen(false);
        }
    }

    onAddToDb(event: SlideshowAddToDbEvent): void {
        this.askForImageCompression(1).then(shouldCompress => {
            if (shouldCompress === null) return;
            // Switch ON (compress) → shouldCompress=true → allowOriginal=false → backend compresses
            this.uploadImageToEvent(event.blob, event.fileName, event.eventId, !shouldCompress);
        });
    }

    /** Mur : même `accept` que le détail événement — tout visiteur qui voit le mur a déjà accès côté API. */
    onWallGroupFilesSelected(event: Event, group: TimelineGroup): void {
        const input = event.target as HTMLInputElement;
        const files = input?.files;
        if (!files?.length || !group?.eventId || !this.userId) {
            if (input) input.value = '';
            return;
        }
        const list = Array.from(files);
        void this.runWallGroupFilesUpload(group, list).finally(() => {
            if (input) input.value = '';
        });
    }

    private async runWallGroupFilesUpload(group: TimelineGroup, initialFiles: File[]): Promise<void> {
        const user = this.membersService.getUser();
        if (!user?.id || !group.eventId || initialFiles.length === 0) {
            return;
        }

        let workingFiles = [...initialFiles];
        /* Ne pas mettre isUploading avant les modales : l’overlay global recouvre la compression image / qualité vidéo. */
        this.wallUploadLogs = [];
        this.wallUploadLastError = null;
        this.wallUploadLastErrorDetail = '';

        let logsModal: NgbModalRef | null = null;
        if (this.wallUploadLogsModal) {
            logsModal = this.modalService.open(this.wallUploadLogsModal, {
                centered: true,
                backdrop: 'static',
                keyboard: false,
                size: 'xl',
                windowClass: 'upload-logs-modal'
            });
            this.wallUploadLogsModalRef = logsModal;
            logsModal.result.finally(() => {
                this.wallUploadLogsModalRef = null;
            }).catch(() => {});
        }

        const sessionId = this.generateWallUploadSessionId();
        this.addWallUploadLog(`📤 Starting upload of ${workingFiles.length} file(s)...`);

        const imageFiles = workingFiles.filter(f => this.isWallImageFileByMimeType(f));
        if (imageFiles.length > 0) {
            this.compressImages = true;
            const shouldCompress = await this.askForImageCompression(imageFiles.length);
            if (shouldCompress === null) {
                this.finishWallUploadCancelled(logsModal);
                return;
            }
            this.compressImages = shouldCompress;
        }

        if (imageFiles.length > 0 && workingFiles.length === 1) {
            const imageFile = imageFiles[0];
            const useAsThumbnail = confirm(
                this.translate.instant('EVENTELEM.USE_AS_THUMBNAIL', { fileName: imageFile.name })
            );
            if (useAsThumbnail) {
                const modified = new File(
                    [imageFile],
                    this.addThumbnailToWallFileName(imageFile.name),
                    { type: imageFile.type }
                );
                workingFiles = [modified];
            }
        }

        let processedFiles: File[] = [];
        const videoFiles = workingFiles.filter(f => this.videoUploadProcessingService.isVideoFile(f.name));
        try {
            if (videoFiles.length > 0 && this.videoCompressionService.isSupported()) {
                const qualityPromise = this.askWallCompressionQuality(videoFiles.length);
                const quality = await this.videoUploadProcessingService.withQualityTimeout(
                    qualityPromise,
                    this.qualityModalRef,
                    () => this.addWallUploadLog('⚠️ Compression quality selection timed out, uploading original files')
                );
                this.isUploading = true;
                this.wallBulkFileUploadActive = true;
                this.cdr.markForCheck();
                const result = await this.videoUploadProcessingService.processVideoFiles(
                    workingFiles,
                    quality,
                    (message: string) => this.addWallUploadLog(message)
                );
                processedFiles = result.files;
                result.errors.forEach(err => this.addWallUploadErrorLog(`❌ ${err}`));
            } else {
                processedFiles = [...workingFiles];
                if (videoFiles.length > 0 && !this.videoCompressionService.isSupported()) {
                    this.addWallUploadLog('⚠️ Video compression not supported in this browser, uploading original files');
                }
            }
        } catch (e: any) {
            console.error('Wall video compression flow:', e);
            this.addWallUploadLog(`⚠️ Error in compression process: ${e?.message || 'Unknown error'}. Uploading original files.`);
            processedFiles = [...workingFiles];
        }

        if (processedFiles.length === 0) {
            this.addWallUploadErrorLog('❌ No files to upload.');
            this.isUploading = false;
            this.wallBulkFileUploadActive = false;
            this.stopWallUploadLogPolling();
            this.cdr.markForCheck();
            return;
        }

        this.isUploading = true;
        this.wallBulkFileUploadActive = true;
        this.cdr.markForCheck();

        const formData = new FormData();
        processedFiles.forEach(file => formData.append('file', file, file.name));
        formData.append('sessionId', sessionId);
        if (imageFiles.length > 0) {
            formData.append('allowOriginal', (!this.compressImages).toString());
        }

        const uploadUrl = `${environment.API_URL4FILE}/${user.id}/${group.eventId}`;

        this.stopWallUploadLogPolling();
        let lastLogCount = 0;
        let consecutiveErrors = 0;
        this.wallUploadPollIntervalId = setInterval(() => {
            if (consecutiveErrors >= 5) {
                this.stopWallUploadLogPolling();
                return;
            }
            this.wallUploadLogsPollSub?.unsubscribe();
            this.wallUploadLogsPollSub = this.fileService.getUploadLogs(sessionId).pipe(take(1)).subscribe({
                next: (serverLogs: string[]) => {
                    consecutiveErrors = 0;
                    this.ngZone.run(() => {
                        if (serverLogs.length > lastLogCount) {
                            for (let i = lastLogCount; i < serverLogs.length; i++) {
                                this.addWallUploadLog(serverLogs[i]);
                            }
                            lastLogCount = serverLogs.length;
                        }
                    });
                },
                error: () => {
                    consecutiveErrors++;
                }
            });
        }, 1500);

        const uploadSub = this.fileService.postFileToUrl(formData, user, uploadUrl, sessionId).subscribe({
            next: () => {
                setTimeout(() => {
                    if (this.destroyed) return;
                    this.stopWallUploadLogPolling();
                    const fileCount = processedFiles.length;
                    this.addWallUploadSuccessLog(`✅ Upload successful! ${fileCount} file(s) processed`);
                    this.refreshTimelineGroup(group);
                    this.isUploading = false;
                    this.wallBulkFileUploadActive = false;
                    this.cdr.markForCheck();
                }, 500);
            },
            error: (err: any) => {
                this.stopWallUploadLogPolling();
                const uploadError = err?.headers?.get('X-Upload-Error');
                let errorMessage = this.translate.instant('EVENTELEM.ERROR_UPLOADING');
                if (err?.status === 0) {
                    errorMessage = this.translate.instant('EVENTELEM.ERROR_CONNECTING');
                } else if (err?.status === 401) {
                    errorMessage = this.translate.instant('EVENTELEM.ERROR_AUTHENTICATION');
                } else if (err?.status === 403) {
                    errorMessage = this.translate.instant('EVENTELEM.ERROR_ACCESS_DENIED');
                } else if (err?.status === 413) {
                    errorMessage = this.translate.instant('EVENTELEM.ERROR_FILE_TOO_LARGE');
                } else if (err?.status === 507) {
                    errorMessage = uploadError || this.translate.instant('EVENTELEM.ERROR_UPLOADING');
                } else if (err?.status >= 500) {
                    errorMessage = this.translate.instant('EVENTELEM.ERROR_SERVER');
                } else if (err?.error?.message) {
                    errorMessage = err.error.message;
                }
                if (uploadError && !String(errorMessage).includes(uploadError)) {
                    errorMessage += ` (${uploadError})`;
                }
                this.addWallUploadErrorLog(`❌ Upload error: ${errorMessage}`);
                this.wallUploadLastError = errorMessage;
                this.wallUploadLastErrorDetail = `HTTP ${err?.status || '?'} ${err?.statusText || ''}`;
                this.isUploading = false;
                this.wallBulkFileUploadActive = false;
                this.ngZone.run(() => this.cdr.detectChanges());
            }
        });
        this.subscriptions.push(uploadSub);
    }

    private finishWallUploadCancelled(logsModal: NgbModalRef | null): void {
        this.stopWallUploadLogPolling();
        this.isUploading = false;
        this.wallBulkFileUploadActive = false;
        if (logsModal) {
            try { logsModal.close(); } catch (_) {}
        }
        this.wallUploadLogsModalRef = null;
        this.cdr.markForCheck();
    }

    closeWallUploadLogsModal(): void {
        if (this.wallUploadLogsModalRef) {
            try { this.wallUploadLogsModalRef.close(); } catch (_) {}
            this.wallUploadLogsModalRef = null;
        }
    }

    clearWallUploadLastError(): void {
        this.wallUploadLastError = null;
        this.wallUploadLastErrorDetail = '';
    }

    private generateWallUploadSessionId(): string {
        return 'upload-' + Date.now() + '-' + Math.random().toString(36).substring(7);
    }

    private stopWallUploadLogPolling(): void {
        if (this.wallUploadPollIntervalId != null) {
            clearInterval(this.wallUploadPollIntervalId);
            this.wallUploadPollIntervalId = null;
        }
        if (this.wallUploadLogsPollSub) {
            this.wallUploadLogsPollSub.unsubscribe();
            this.wallUploadLogsPollSub = null;
        }
    }

    private addWallUploadLog(message: string): void {
        this.ngZone.run(() => {
            this.wallUploadLogs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
            this.cdr.detectChanges();
            requestAnimationFrame(() => {
                const el = this.wallUploadLogContent?.nativeElement;
                if (el) el.scrollTop = 0;
            });
        });
    }

    private addWallUploadSuccessLog(message: string): void {
        this.wallUploadLogs.unshift(`SUCCESS: [${new Date().toLocaleTimeString()}] ${message}`);
        this.cdr.detectChanges();
        requestAnimationFrame(() => {
            const el = this.wallUploadLogContent?.nativeElement;
            if (el) el.scrollTop = 0;
        });
    }

    private addWallUploadErrorLog(message: string): void {
        this.ngZone.run(() => {
            this.wallUploadLogs.unshift(`ERROR: [${new Date().toLocaleTimeString()}] ${message}`);
            this.cdr.detectChanges();
            requestAnimationFrame(() => {
                const el = this.wallUploadLogContent?.nativeElement;
                if (el) el.scrollTop = 0;
            });
        });
    }

    private isWallImageFileByMimeType(file: File): boolean {
        const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'];
        return imageTypes.includes((file.type || '').toLowerCase());
    }

    private addThumbnailToWallFileName(originalName: string): string {
        const lastDotIndex = originalName.lastIndexOf('.');
        if (lastDotIndex === -1) {
            return originalName + '_thumbnail';
        }
        const nameWithoutExtension = originalName.substring(0, lastDotIndex);
        const extension = originalName.substring(lastDotIndex);
        const middleIndex = Math.floor(nameWithoutExtension.length / 2);
        return nameWithoutExtension.substring(0, middleIndex) +
            'thumbnail' +
            nameWithoutExtension.substring(middleIndex) +
            extension;
    }

    private askWallCompressionQuality(videoCount: number): Promise<'low' | 'medium' | 'high' | 'very-high' | 'original' | null> {
        return new Promise(resolve => {
            this.selectedCompressionQuality = 'very-high';
            this.videoCountForModal = videoCount;
            if (this.wallQualitySelectionModal) {
                this.qualityModalRef = this.modalService.open(this.wallQualitySelectionModal, {
                    centered: true,
                    backdrop: 'static',
                    keyboard: false,
                    size: 'md',
                    windowClass: 'compression-quality-modal'
                });
                this.qualityModalRef.result.then(
                    (result: 'low' | 'medium' | 'high' | 'very-high' | 'original') => {
                        this.qualityModalRef = null;
                        resolve(result);
                    },
                    () => {
                        this.qualityModalRef = null;
                        resolve(null);
                    }
                );
            } else {
                resolve('very-high');
            }
        });
    }

    confirmWallQualitySelection(): void {
        if (this.qualityModalRef) {
            this.qualityModalRef.close(this.selectedCompressionQuality);
        }
    }

    cancelWallQualitySelection(): void {
        if (this.qualityModalRef) {
            this.qualityModalRef.dismiss();
        }
    }

    private askForImageCompression(imageCount: number): Promise<boolean | null> {
        return new Promise((resolve) => {
            this.compressImages = true;
            this.imageCountForModal = imageCount;

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
                const choice = confirm(
                    this.translate.instant('EVENTELEM.IMAGE_COMPRESSION_MESSAGE', { count: imageCount })
                );
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

    /** Icône FA 4.7 pour le type d’activité (même logique que la carte `element-evenement`). */
    getEventTypeIcon(type: string | undefined | null): string {
        return getEventTypeFaIconSuffix(type);
    }

    /** Current rating (0–10) computed from the event's likes/dislikes. */
    getGroupCurrentRate(group: TimelineGroup): number {
        const plus = group.ratingPlus ?? 0;
        const minus = group.ratingMinus ?? 0;
        const total = plus + minus;
        if (!total) {
            return 0;
        }
        return (plus / total) * 10;
    }

    onTimelineRatePlus(group: TimelineGroup, ev: Event): void {
        ev.stopPropagation();
        this.rateTimelineEvent(group, true);
    }

    onTimelineRateMinus(group: TimelineGroup, ev: Event): void {
        ev.stopPropagation();
        this.rateTimelineEvent(group, false);
    }

    private rateTimelineEvent(group: TimelineGroup, isPlus: boolean): void {
        const eventId = group?.eventId;
        if (!eventId) {
            return;
        }
        const sub = this.evenementsService.getEvenement(eventId).pipe(
            take(1),
            switchMap(e => {
                if (!e) {
                    return of(null);
                }
                if (isPlus) {
                    e.ratingPlus = (e.ratingPlus || 0) + 1;
                } else {
                    e.ratingMinus = (e.ratingMinus || 0) + 1;
                }
                return this.evenementsService.putEvenement(e).pipe(
                    map(() => e)
                );
            })
        ).subscribe({
            next: updated => {
                if (!updated) {
                    return;
                }
                group.ratingPlus = updated.ratingPlus ?? 0;
                group.ratingMinus = updated.ratingMinus ?? 0;
                this.cdr.markForCheck();
            },
            error: err => {
                console.error('Error updating event rating from photo timeline:', err);
            }
        });
        this.subscriptions.push(sub);
    }

    trackByIndex(index: number): number {
        return index;
    }

    /** Format owner as "FirstName LastName (userName)" or "(userName)" if no names. */
    getOwnerDisplay(group: TimelineGroup): string {
        if (!group?.ownerUserName) return '';
        const first = (group.ownerFirstName || '').trim();
        const last = (group.ownerLastName || '').trim();
        const names = [first, last].filter(Boolean).join(' ');
        return names ? `${names} (${group.ownerUserName})` : group.ownerUserName;
    }

    /** Shared link (WhatsApp, email): photo wall filtered to the activity, not the event detail page. */
    getWallShareEventUrl(): string {
        const g = this.shareWallContextGroup;
        if (!g?.eventId) return '';
        const id = encodeURIComponent(g.eventId.trim());
        return `${window.location.origin}/#/photos?eventId=${id}`;
    }

    getWallShareMainImageUrl(): SafeUrl {
        const g = this.shareWallContextGroup;
        if (!g?.photos?.length) {
            return this.sanitizer.bypassSecurityTrustUrl('assets/images/images.jpg');
        }
        const first = g.photos[0];
        const thumb = this.getThumbnailUrl(first);
        if (thumb) {
            return this.sanitizer.bypassSecurityTrustUrl(thumb);
        }
        return this.sanitizer.bypassSecurityTrustUrl('assets/images/images.jpg');
    }

    private wallShareFirstImageFieldId(): string | null {
        const g = this.shareWallContextGroup;
        const id = g?.photos?.[0]?.fileId;
        return id && id.trim() ? id.trim() : null;
    }

    wallShareOnWhatsApp(group: TimelineGroup): void {
        if (!group.eventId) return;
        this.shareWallContextGroup = group;
        this.wallWhatsappShareMessage = this.translate.instant('EVENTELEM.DEFAULT_SHARE_MESSAGE');
        if (this.wallWhatsappShareModal) {
            this.wallWhatsappShareModalRef = this.modalService.open(this.wallWhatsappShareModal, {
                size: 'lg',
                centered: true,
                windowClass: 'whatsapp-share-modal'
            });
        }
        this.cdr.markForCheck();
    }

    wallCancelWhatsAppShare(): void {
        this.wallWhatsappShareMessage = '';
        if (this.wallWhatsappShareModalRef) {
            this.wallWhatsappShareModalRef.close();
            this.wallWhatsappShareModalRef = null;
        }
    }

    async wallConfirmWhatsAppShare(): Promise<void> {
        const g = this.shareWallContextGroup;
        if (!g?.eventId) return;

        const eventUrl = this.getWallShareEventUrl();
        let message = `*${g.eventName || 'Activité'}*\n\n${eventUrl}\n\n`;
        if (this.wallWhatsappShareMessage?.trim()) {
            message += this.wallWhatsappShareMessage.trim();
        }

        const imageFieldId = this.wallShareFirstImageFieldId();

        if (navigator.share && imageFieldId) {
            try {
                const imageBlob = await new Promise<Blob | null>((resolve) => {
                    const sub = this.fileService.getFile(imageFieldId).subscribe({
                        next: (res: any) => {
                            let mimeType = 'image/jpeg';
                            if (res instanceof Blob && res.type) {
                                mimeType = res.type;
                            }
                            resolve(new Blob([res], { type: mimeType }));
                        },
                        error: () => resolve(null)
                    });
                    this.subscriptions.push(sub);
                    setTimeout(() => {
                        if (!sub.closed) {
                            sub.unsubscribe();
                            resolve(null);
                        }
                    }, 5000);
                });

                if (imageBlob) {
                    let extension = 'jpg';
                    if (imageBlob.type.includes('png')) extension = 'png';
                    else if (imageBlob.type.includes('gif')) extension = 'gif';
                    else if (imageBlob.type.includes('webp')) extension = 'webp';

                    const fileName = `event-image.${extension}`;
                    const file = new File([imageBlob], fileName, { type: imageBlob.type });

                    if (navigator.canShare && navigator.canShare({ files: [file], text: message })) {
                        await navigator.share({
                            title: g.eventName || 'Activité',
                            text: message,
                            files: [file]
                        });
                        this.wallCancelWhatsAppShare();
                        return;
                    }
                }
            } catch {
                // fall through to wa.me
            }
        }

        const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
        if (this.wallWhatsappShareModalRef) {
            this.wallWhatsappShareModalRef.close();
            this.wallWhatsappShareModalRef = null;
        }
        window.open(whatsappUrl, '_blank');
    }

    getWallShareByEmailMailLangOption(): { code: string; labelKey: string; flagCode: string } | undefined {
        return this.wallShareByEmailMailLangOptions.find(o => o.code === this.wallShareByEmailMailLang)
            ?? this.wallShareByEmailMailLangOptions[0];
    }

    get wallShareByEmailRecipientCount(): number {
        const patCount = (this.wallShareByEmailPatToolSelected || []).length;
        const external = (this.wallShareByEmailExternalEmails || '')
            .split(/[\s,;]+/)
            .map((e: string) => e.trim())
            .filter((e: string) => e.length > 0);
        return patCount + external.length;
    }

    wallTrackByShareByEmailMemberId(_index: number, m: Member): string {
        return m.id ?? m.addressEmail ?? '';
    }

    wallOpenShareByEmailModal(group: TimelineGroup): void {
        if (!group.eventId) return;
        this.shareWallContextGroup = group;
        this.wallShareByEmailExternalEmails = '';
        this.wallShareByEmailMessage = '';
        this.wallShareByEmailError = null;
        this.wallShareByEmailSuccess = null;
        this.wallShareEmailEventAccessUsers = [];
        this.wallShareByEmailPatToolSelected = [];
        this.wallSyncShareByEmailSelectedSet();
        this.wallShareByEmailLoading = true;
        const appLang = this.translate.currentLang || this.translate.defaultLang || 'fr';
        const supported = this.wallShareByEmailMailLangOptions.map(o => o.code);
        this.wallShareByEmailMailLang = supported.includes(appLang) ? appLang : 'fr';

        if (this.wallShareByEmailModal) {
            this.wallShareByEmailModalRef = this.modalService.open(this.wallShareByEmailModal, {
                size: 'lg',
                centered: true,
                windowClass: 'share-by-email-modal'
            });
        }

        const sub = forkJoin({
            access: this.evenementsService.getEventAccessUsers(group.eventId).pipe(catchError(() => of([] as any[]))),
            members: this.membersService.getListMembers().pipe(catchError(() => of([] as Member[])))
        }).subscribe({
            next: ({ access, members }) => {
                this.wallShareEmailEventAccessUsers = this.wallMapAccessUsersToMembers(access);
                this.wallShareByEmailPatToolSelected = this.wallShareEmailEventAccessUsers
                    .map(m => m.addressEmail)
                    .filter((email): email is string => !!email && email.trim().length > 0);
                this.wallSyncShareByEmailSelectedSet();
                const visibleOnly = (members || []).filter(m => m.visible !== false);
                this.wallShareByEmailAllMembers = visibleOnly.slice().sort((a, b) => {
                    const cmpFirst = (a.firstName || '').toLowerCase().localeCompare((b.firstName || '').toLowerCase());
                    if (cmpFirst !== 0) return cmpFirst;
                    return (a.lastName || '').toLowerCase().localeCompare((b.lastName || '').toLowerCase());
                });
                this.wallShareByEmailLoading = false;
                this.cdr.markForCheck();
            },
            error: () => {
                this.wallShareByEmailLoading = false;
                this.wallShareByEmailError = this.translate.instant('EVENTELEM.SHARE_MAIL_LOAD_ERROR');
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
        this.cdr.markForCheck();
    }

    wallCloseShareByEmailModal(): void {
        if (this.wallShareByEmailModalRef) {
            this.wallShareByEmailModalRef.close();
            this.wallShareByEmailModalRef = null;
        }
    }

    wallToggleShareByEmailUser(email: string): void {
        const idx = this.wallShareByEmailPatToolSelected.indexOf(email);
        if (idx === -1) {
            this.wallShareByEmailPatToolSelected = [...this.wallShareByEmailPatToolSelected, email];
        } else {
            this.wallShareByEmailPatToolSelected = this.wallShareByEmailPatToolSelected.filter(e => e !== email);
        }
        this.wallSyncShareByEmailSelectedSet();
    }

    private wallSyncShareByEmailSelectedSet(): void {
        this.wallShareByEmailPatToolSelectedSet = new Set(this.wallShareByEmailPatToolSelected || []);
    }

    wallShareByEmailSelectAllWithAccess(): void {
        const accessEmails = (this.wallShareEmailEventAccessUsers || [])
            .map(m => m.addressEmail)
            .filter((email): email is string => !!email && email.trim().length > 0);
        this.wallShareByEmailPatToolSelected = [...new Set([...this.wallShareByEmailPatToolSelected, ...accessEmails])];
        this.wallSyncShareByEmailSelectedSet();
        this.cdr.markForCheck();
    }

    wallShareByEmailDeselectAll(): void {
        this.wallShareByEmailPatToolSelected = [];
        this.wallSyncShareByEmailSelectedSet();
        this.cdr.markForCheck();
    }

    getWallShareByEmailHeaderStyle(): { [key: string]: string } {
        return { backgroundColor: '#0d6efd' };
    }

    wallSendShareByEmail(): void {
        const g = this.shareWallContextGroup;
        if (!g?.eventId) return;

        const emails: string[] = [...this.wallShareByEmailPatToolSelected];
        const external = (this.wallShareByEmailExternalEmails || '')
            .split(/[\s,;]+/)
            .map(e => e.trim())
            .filter(e => e.length > 0);
        emails.push(...external);
        emails.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        if (emails.length === 0) {
            this.wallShareByEmailError = this.translate.instant('EVENTELEM.SHARE_MAIL_NO_RECIPIENTS');
            this.cdr.markForCheck();
            return;
        }
        this.wallShareByEmailError = null;
        this.wallShareByEmailSuccess = null;
        this.wallShareByEmailSending = true;
        this.cdr.markForCheck();

        const eventUrl = this.getWallShareEventUrl() || undefined;
        const eventTypeLabel = g.eventType != null
            ? this.translate.instant(this.wallGetEventTypeLabelKey(g.eventType))
            : undefined;
        const user = this.membersService.getUser();
        const senderName = user
            ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.userName || user.addressEmail || ''
            : '';

        const sub = this.evenementsService.shareEventByEmail(
            g.eventId,
            emails,
            this.wallShareByEmailMessage || undefined,
            undefined,
            eventUrl,
            eventTypeLabel,
            senderName || undefined,
            this.wallShareByEmailMailLang || 'fr'
        ).subscribe({
            next: (res) => {
                this.wallShareByEmailSending = false;
                this.wallShareByEmailSuccess = this.translate.instant('EVENTELEM.SHARE_MAIL_SENT', { sent: res.sent, total: res.total });
                this.cdr.markForCheck();
            },
            error: (err) => {
                this.wallShareByEmailSending = false;
                this.wallShareByEmailError = err?.error?.error || err?.message || this.translate.instant('EVENTELEM.SHARE_MAIL_SEND_ERROR');
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
    }

    private wallGetEventTypeLabelKey(type: string): string {
        const typeMap: { [key: string]: string } = {
            '11': 'EVENTCREATION.TYPE.DOCUMENTS',
            '12': 'EVENTCREATION.TYPE.FICHE',
            '3': 'EVENTCREATION.TYPE.RUN',
            '6': 'EVENTCREATION.TYPE.PARTY',
            '4': 'EVENTCREATION.TYPE.WALK',
            '10': 'EVENTCREATION.TYPE.PHOTOS',
            '9': 'EVENTCREATION.TYPE.RANDO',
            '2': 'EVENTCREATION.TYPE.SKI',
            '7': 'EVENTCREATION.TYPE.VACATION',
            '5': 'EVENTCREATION.TYPE.BIKE',
            '8': 'EVENTCREATION.TYPE.TRAVEL',
            '1': 'EVENTCREATION.TYPE.VTT',
            '13': 'EVENTCREATION.TYPE.WINE',
            '14': 'EVENTCREATION.TYPE.OTHER',
            '15': 'EVENTCREATION.TYPE.VISIT',
            '16': 'EVENTCREATION.TYPE.WORK',
            '17': 'EVENTCREATION.TYPE.FAMILY',
            '18': 'EVENTCREATION.TYPE.CINEMA',
            '19': 'EVENTCREATION.TYPE.MUSIQUE'
        };
        return typeMap[type] || 'EVENTCREATION.TYPE.OTHER';
    }

    /**
     * Click on the wall visibility badge: list of users who can see the event (same as element-evenement).
     */
    wallShowEventAccessUsers(group: TimelineGroup, ev?: Event): void {
        if (ev) {
            ev.stopPropagation();
            ev.preventDefault();
        }
        if (!group?.eventId) {
            return;
        }
        const seq = ++this.wallEventAccessLoadSeq;
        this.wallEventAccessContextGroup = group;
        this.wallEventAccessLoading = true;
        this.wallEventAccessUsers = [];
        this.cdr.markForCheck();

        const sub = this.evenementsService.getEventAccessUsers(group.eventId).pipe(take(1)).subscribe({
            next: (users: any[]) => {
                if (seq !== this.wallEventAccessLoadSeq) {
                    return;
                }
                this.wallEventAccessUsers = this.wallMapAccessUsersToMembers(users || []);
                this.wallEventAccessLoading = false;
                this.wallOpenEventAccessUsersModal();
                this.cdr.markForCheck();
            },
            error: () => {
                if (seq !== this.wallEventAccessLoadSeq) {
                    return;
                }
                this.wallEventAccessUsers = [];
                this.wallEventAccessLoading = false;
                this.wallOpenEventAccessUsersModal();
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
    }

    wallAccessModalHeaderSuffix(): string {
        const g = this.wallEventAccessContextGroup;
        if (!g) return '';
        const v = (g.visibility || '').trim().toLowerCase();
        if (v === 'public' || v === 'private' || v === 'friends') {
            return '';
        }
        const badges = this.getVisibilityBadges(g);
        if (badges.length === 0) return '';
        return badges.map(b => b.text).join(', ');
    }

    wallOpenUserWhatsAppFromAccessModal(user: Member): void {
        const url = user?.whatsappLink?.trim();
        if (url) {
            window.open(url, '_blank');
        }
    }

    wallTrackByAccessUserId(_index: number, u: Member): string {
        return u.id || u.addressEmail || '';
    }

    /**
     * Do not use routerLink inside the modal: immediate navigation breaks ng-bootstrap teardown (removeChild on null).
     * Close the modal first, then navigate once the modal promise is settled.
     */
    wallNavigateToEventDetailFromAccessModal(eventId: string | undefined, ev: Event): void {
        ev.preventDefault();
        ev.stopPropagation();
        if (!eventId) {
            return;
        }
        const target = ['/details-evenement', eventId] as const;
        const ref = this.wallEventAccessModalRef;
        if (ref) {
            ref.result.finally(() => {
                void this.router.navigate(target);
            });
            try {
                ref.dismiss('navigate-detail');
            } catch {
                void this.router.navigate(target);
            }
        } else {
            void this.router.navigate(target);
        }
    }

    private wallOpenEventAccessUsersModal(): void {
        if (!this.wallEventAccessUsersModal) {
            return;
        }

        const doOpen = () => {
            if (!this.wallEventAccessUsersModal) {
                return;
            }
            const modalRef = this.modalService.open(this.wallEventAccessUsersModal, {
                size: 'lg',
                centered: true,
                backdrop: 'static',
                keyboard: true,
                animation: true
            });
            this.wallEventAccessModalRef = modalRef;
            modalRef.result.finally(() => {
                if (this.wallEventAccessModalRef === modalRef) {
                    this.wallEventAccessModalRef = null;
                }
            });
        };

        const prev = this.wallEventAccessModalRef;
        if (prev) {
            try {
                prev.dismiss();
            } catch (_) {
                /* already unmounted */
            }
            if (this.wallEventAccessOpenTimer != null) {
                clearTimeout(this.wallEventAccessOpenTimer);
            }
            this.wallEventAccessOpenTimer = setTimeout(() => {
                this.wallEventAccessOpenTimer = null;
                doOpen();
            }, 0);
        } else {
            doOpen();
        }
    }

    /** Comments: loads the event then opens the same Quill modal as the event detail. */
    openWallCommentary(group: TimelineGroup): void {
        if (!group?.eventId) {
            return;
        }
        const sub = this.evenementsService.getEvenement(group.eventId).pipe(take(1)).subscribe({
            next: (ev) => {
                this.wallCommentaryEvent = ev;
                if (!ev.commentaries) {
                    ev.commentaries = [];
                }
                this.cdr.detectChanges();
                setTimeout(() => this.wallCommentaryEditor?.openAddOrEditFirstOwned(), 0);
            },
            error: (err) => {
                console.error('Photo wall: load event for commentary', err);
                const msg = err?.error?.message || err?.message || '';
                alert(this.translate.instant('COMMUN.ERROR') + (msg ? ': ' + msg : ''));
            }
        });
        this.subscriptions.push(sub);
    }

    getWallCommentaryCurrentUser(): Member {
        return this.membersService.getUser();
    }

    getWallCommentaryEventColor(): { r: number; g: number; b: number } | null {
        const ev = this.wallCommentaryEvent;
        if (!ev) {
            return null;
        }
        return this.eventColorService.getEventColor(ev.id || '')
            || this.eventColorService.getEventColor(ev.evenementName || '')
            || null;
    }

    onWallCommentaryAdded(commentary: Commentary): void {
        const ev = this.wallCommentaryEvent;
        if (!ev?.id) {
            return;
        }
        const sub = this.evenementsService.addCommentary(ev.id, commentary).subscribe({
            next: (updated) => {
                if (updated?.commentaries) {
                    ev.commentaries = updated.commentaries;
                }
                this.cdr.markForCheck();
            },
            error: () => alert(this.translate.instant('EVENTELEM.ERROR_ADDING_COMMENTARY'))
        });
        this.subscriptions.push(sub);
    }

    onWallCommentaryUpdated(evt: { commentId: string; commentary: Commentary }): void {
        const ev = this.wallCommentaryEvent;
        if (!ev?.id) {
            return;
        }
        const sub = this.evenementsService.updateCommentary(ev.id, evt.commentId, evt.commentary).subscribe({
            next: (updated) => {
                if (updated?.commentaries) {
                    ev.commentaries = updated.commentaries;
                }
                this.cdr.markForCheck();
            },
            error: () => alert(this.translate.instant('EVENTELEM.ERROR_UPDATING_COMMENTARY'))
        });
        this.subscriptions.push(sub);
    }

    onWallCommentaryDeleted(commentId: string): void {
        const ev = this.wallCommentaryEvent;
        if (!ev?.id) {
            return;
        }
        const sub = this.evenementsService.deleteCommentary(ev.id, commentId).subscribe({
            next: (updated) => {
                if (updated?.commentaries) {
                    ev.commentaries = updated.commentaries;
                }
                this.cdr.markForCheck();
            },
            error: () => alert(this.translate.instant('EVENTELEM.ERROR_DELETING_COMMENTARY'))
        });
        this.subscriptions.push(sub);
    }

    /** Live discussion: same flow as event detail. */
    openWallDiscussion(group: TimelineGroup): void {
        if (!group?.eventId) {
            return;
        }
        const sub = this.evenementsService.getEvenement(group.eventId).pipe(take(1)).subscribe({
            next: (ev) => this.wallOpenDiscussionForLoadedEvent(ev),
            error: (err) => {
                console.error('Photo wall: load event for discussion', err);
                const msg = err?.error?.message || err?.message || '';
                alert(this.translate.instant('COMMUN.ERROR') + (msg ? ': ' + msg : ''));
            }
        });
        this.subscriptions.push(sub);
    }

    private wallOpenDiscussionForLoadedEvent(evenement: Evenement): void {
        if (!evenement.discussionId) {
            const discussionTitle = evenement.evenementName || 'Discussion';
            const createSub = this.discussionService.createDiscussion(discussionTitle).subscribe({
                next: (discussion) => {
                    if (discussion?.id) {
                        const discussionId = discussion.id;
                        evenement.discussionId = discussionId;
                        const putSub = this.evenementsService.putEvenement(evenement).subscribe({
                            next: () => this.wallOpenDiscussionModal(discussionId, evenement),
                            error: (error: any) => {
                                const errorMessage = String(error?.error?.message || error?.message || '');
                                if (errorMessage.includes('Photo from File System') || errorMessage.includes('PHOTOFROMFS')) {
                                    evenement.discussionId = undefined;
                                } else {
                                    evenement.discussionId = undefined;
                                }
                                this.wallOpenDiscussionModal(discussionId, evenement);
                            }
                        });
                        this.subscriptions.push(putSub);
                    } else {
                        alert(this.translate.instant('EVENTELEM.ERROR_CREATING_DISCUSSION'));
                    }
                },
                error: (error) => {
                    console.error('Error creating discussion:', error);
                    const errorMessage = error?.error?.message || error?.message || this.translate.instant('COMMUN.ERROR');
                    alert(this.translate.instant('EVENTELEM.ERROR_CREATING_DISCUSSION') + ':\n' + errorMessage);
                }
            });
            this.subscriptions.push(createSub);
        } else {
            this.wallOpenDiscussionModal(evenement.discussionId, evenement);
        }
    }

    private wallOpenDiscussionModal(discussionId: string, evenement: Evenement): void {
        try {
            const modalRef = this.modalService.open(DiscussionModalComponent, {
                size: 'lg',
                centered: true,
                backdrop: 'static',
                keyboard: true,
                windowClass: 'discussion-modal-window'
            });
            if (modalRef?.componentInstance) {
                modalRef.componentInstance.discussionId = discussionId;
                modalRef.componentInstance.title = evenement.evenementName || 'Discussion';
                const eventColor = this.eventColorService.getEventColor(evenement.id || '');
                if (eventColor) {
                    modalRef.componentInstance.eventColor = eventColor;
                }
                setTimeout(() => {
                    modalRef.componentInstance?.applyEventColorToModal();
                }, 300);
            }
            const closedSub = modalRef.closed.subscribe(() => this.cdr.markForCheck());
            this.subscriptions.push(closedSub);
        } catch (e) {
            console.error('Error opening discussion modal from photo wall', e);
            alert(this.translate.instant('EVENTELEM.ERROR_OPENING_DISCUSSION'));
        }
    }

    private wallMapAccessUsersToMembers(users: any[]): Member[] {
        return (users || []).map((user: any) => {
            let rolesArray: string[] = [];
            if (user.roles) {
                if (typeof user.roles === 'string') {
                    rolesArray = user.roles.split(',').map((r: string) => r.trim()).filter((r: string) => r.length > 0);
                } else if (Array.isArray(user.roles)) {
                    rolesArray = user.roles;
                }
            }
            return new Member(
                user.id || '',
                user.addressEmail || '',
                user.firstName || '',
                user.lastName || '',
                user.userName || '',
                rolesArray,
                user.keycloakId || '',
                user.registrationDate ? new Date(user.registrationDate) : undefined,
                user.lastConnectionDate ? new Date(user.lastConnectionDate) : undefined,
                user.locale || undefined,
                user.whatsappLink || undefined,
                user.visible !== undefined ? user.visible : true
            );
        });
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

    trackByFsLink(_index: number, link: FsPhotoLink): string {
        return `${link.typeUrl || ''}::${link.fieldId || ''}::${link.path}::${link.description || ''}`;
    }
}
