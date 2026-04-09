import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ViewChildren, QueryList, ElementRef, HostListener, TemplateRef, ChangeDetectorRef } from '@angular/core';
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

const BUFFER_AHEAD = 3;
/** Nombre de groupes (activités) à charger par requête API. */
const PAGE_SIZE = 12;
/** Nombre d'activités affichées dès l'ouverture (comme home-evenements affiche 8 cartes). */
const INITIAL_VISIBLE_GROUPS = 8;
/** Hauteur approximative d'un bloc événement (px) pour précharger 3 événements en avance. */
const EVENT_BLOCK_HEIGHT_PX = 500;
const PREFETCH_EVENTS_AHEAD = 3;

export interface GroupMediaItem {
    type: 'photo' | 'video';
    item: TimelinePhoto;
    photoIndex?: number; // index parmi les photos uniquement (pour le slideshow)
}
const SCROLL_THRESHOLD_PX = Math.max(400, PREFETCH_EVENTS_AHEAD * EVENT_BLOCK_HEIGHT_PX);
/** Longest side (px) for server-generated wall thumbnails (?maxEdge=). */
const WALL_THUMB_MAX_EDGE = 400;
/** Max concurrent wall media HTTP fetches (thumbs + inline videos) to avoid stampedes. */
const WALL_MEDIA_MAX_PARALLEL = 12;

/** Returns the thumbnail max-edge adapted to the current viewport width (mobile = smaller = faster). */
function getAdaptiveThumbMaxEdge(): number {
    if (typeof window === 'undefined') return WALL_THUMB_MAX_EDGE;
    const w = window.innerWidth;
    if (w <= 480) return 180;
    if (w <= 768) return 260;
    return WALL_THUMB_MAX_EDGE;
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
    @ViewChild('wallWhatsappShareModal') wallWhatsappShareModal!: TemplateRef<any>;
    @ViewChild('wallShareByEmailModal') wallShareByEmailModal!: TemplateRef<any>;
    @ViewChild('wallEventAccessUsersModal') wallEventAccessUsersModal!: TemplateRef<any>;
    @ViewChild('wallCommentaryEditor') wallCommentaryEditor?: CommentaryEditor;

    /** Loaded on demand when opening « Commentaires » from the wall (same editor as détail événement). */
    wallCommentaryEvent: Evenement | null = null;
    /** Vidéos du mur masonry : lecture seulement quand visibles (viewport). */
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
     * Home-evenements n’ouvre qu’un flux puis affiche les cartes au fil de l’eau ; ici on évite de lancer en parallèle
     * deux grosses requêtes Mongo (photos + vidéos-only) au cold start.
     */
    private videoTimelineFetchStarted = false;
    private searchDebounceId: ReturnType<typeof setTimeout> | null = null;
    /** When set, timeline shows only photos/videos for this event (from query param eventId). */
    filterEventId: string | undefined;

    /** Mur de photos : partage (propriétaire uniquement), même flux que détail événement */
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

    /** Modale « utilisateurs ayant accès » (clic sur badge visibilité), même API que détail événement */
    wallEventAccessUsers: Member[] = [];
    wallEventAccessLoading = false;
    wallEventAccessContextGroup: TimelineGroup | null = null;
    private wallEventAccessModalRef: NgbModalRef | null = null;
    /** Incrémenté à chaque clic badge ; ignore les réponses HTTP obsolètes (évite double ouverture). */
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
        private keycloakService: KeycloakService
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

    /** Ré-enregistre toutes les vidéos du mur auprès de l’observer (liste masonry dynamique). */
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
     * Démarre le mur dès que l’id membre est disponible (sans attendre le GPS, comme links).
     * Évite le setInterval(200 ms) qui retardait systématiquement le premier chargement.
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

    /** Liste des badges de visibilité à afficher (un ou plusieurs groupes possibles). */
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
        // Une seule requête timeline au départ ; la timeline « vidéos seules » démarre après la 1ʳᵉ réponse
        // photos (comme la home qui n’ouvre pas deux backends lourds en même temps au premier écran).
        this.fetchNext();
    }

    /** Démarre getVideoTimeline une fois la première page photos reçue (ou en cas d’erreur photos). */
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
                // Différer pour éviter NG0100 sur *ngIf="onThisDay.length > 0" (même cycle que la 1re vérif du template)
                setTimeout(() => {
                    if (this.destroyed || gen !== this.timelineLoadGeneration) return;
                    this.onThisDay = photos || [];
                    this.cdr.markForCheck();
                    // Miniatures OTD : IntersectionObserver uniquement (pas de boucle loadThumbnail) pour ne pas
                    // saturer la file partagée avec le mur (WALL_MEDIA_MAX_PARALLEL).
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
     * Révèle des groupes jusqu'à INITIAL_VISIBLE_GROUPS au premier chargement,
     * pour afficher plusieurs activités dès l'ouverture (comme home-evenements).
     */
    private revealInitialBatch(): void {
        while (this.visibleGroups.length < INITIAL_VISIBLE_GROUPS &&
               (this.bufferedGroups.length > 0 || this.bufferedVideoGroups.length > 0)) {
            this.revealMore();
        }
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

    /** Groupes visibles ; le filtre est appliqué côté backend via le paramètre search. */
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
     * Recharge photos/vidéos d'un seul événement (API timeline filtrée par eventId), sans recharger tout le mur.
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
        if (photoGroup && (photoGroup.photos?.length ?? 0) > 0) {
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

    /** Média d'un groupe : photos et vidéos en parallèle (entrelacés), pas les vidéos en premier. */
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
        return null;
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
                    this.scheduleCdr();
                },
                error: () => {
                    if (this.destroyed) return;
                    this.loadingVideos.delete(id);
                    this.scheduleCdr();
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
                    if (this.destroyed || gen !== this.timelineLoadGeneration) {
                        this.loadingThumbnails.delete(photo.fileId);
                        return;
                    }
                    const blob = new Blob([data], { type: 'image/jpeg' });
                    const url = URL.createObjectURL(blob);
                    this.thumbnailCache.set(photo.fileId, url);
                    this.loadingThumbnails.delete(photo.fileId);
                    this.scheduleCdr();
                },
                error: () => {
                    if (this.destroyed) return;
                    this.loadingThumbnails.delete(photo.fileId);
                    this.scheduleCdr();
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
     * Démarre le fetch des miniatures tout de suite pour les groupes révélés, sans attendre l’IntersectionObserver
     * (sinon délai d’une frame + callback observer avant la 1ʳᵉ requête HTTP).
     * Les vidéos restent chargées à la demande (observer) pour éviter de télécharger des fichiers lourds hors viewport.
     */
    private preloadThumbnailsForGroup(group: TimelineGroup): void {
        const photos = group.photos || [];
        const isFirstScreen = this.visibleGroups.length <= INITIAL_VISIBLE_GROUPS;
        // Peu de requêtes immédiates : le reste passe par IntersectionObserver (comme les cartes home).
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

    /** Ouvre la fiche événement en overlay (sans NgbModal pour éviter les erreurs removeChild à la fermeture). */
    eventIdForCard: string | null = null;
    openEventCardModal(group: TimelineGroup): void {
        this.eventIdForCard = group.eventId;
    }
    closeEventCardOverlay(): void {
        this.eventIdForCard = null;
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

    /** True when the signed-in user owns this timeline group (same rule as détail événement / add-to-DB). */
    isTimelineGroupOwner(group: TimelineGroup): boolean {
        const user = this.membersService.getUser();
        if (!user?.userName || !group?.ownerUserName) {
            return false;
        }
        return user.userName.toLowerCase() === group.ownerUserName.toLowerCase();
    }

    /** Seul PHOTOFROMFS (ou type absent = legacy) ouvre le diaporama depuis le disque. */
    isPhotoWallFsFromDiskLink(link: FsPhotoLink): boolean {
        const t = (link.typeUrl || '').trim().toUpperCase();
        return t === '' || t === 'PHOTOFROMFS';
    }

    /** Icônes Font Awesome 4, alignées sur la page détail événement. */
    getPhotoWallLinkIcon(link: FsPhotoLink): string {
        if (this.isPhotoWallFsFromDiskLink(link)) {
            return 'fa-desktop';
        }
        const t = (link.typeUrl || '').trim().toUpperCase() || 'OTHER';
        if (t === 'MAP' || t === 'CARTE') return 'fa-map-marker';
        if (t === 'WEBSITE' || t === 'SITE' || t === 'WEB') return 'fa-globe';
        if (t === 'DOCUMENTATION' || t === 'DOC' || t === 'FICHE') return 'fa-file-text';
        if (t === 'PHOTOS' || t === 'PHOTO') return 'fa-picture-o';
        if (t === 'VIDEO' || t === 'VIDÉO' || t === 'YOUTUBE' || t === 'VIMEO') return 'fa-video-camera';
        if (t === 'WHATSAPP' || t === 'WA') return 'fa-whatsapp';
        if (t === 'TRACK' || t === 'TRACE' || t === 'GPX') return 'fa-road';
        return 'fa-external-link';
    }

    /** Clic footer : diaporama disque uniquement pour PHOTOFROMFS ; trace Mongo → viewer ; sinon nouvel onglet. */
    onPhotoWallFooterLinkClick(fsLink: FsPhotoLink, group: TimelineGroup): void {
        const t = (fsLink.typeUrl || '').trim().toUpperCase();
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
            'Fiche': 'fa-file-text-o',
            '18': 'fa-film',
            '19': 'fa-music'
        };
        return icons[type] || 'fa-calendar';
    }

    /** Note courante (0–10) à partir des likes/dislikes de l'événement. */
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

    /** Lien partagé (WhatsApp, e-mail) : mur de photos filtré sur l’activité, pas la fiche détail événement. */
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
     * Clic sur le badge de visibilité du mur : liste des utilisateurs pouvant voir l’événement (comme element-evenement).
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
     * Ne pas utiliser routerLink dans la modale : la navigation immédiate casse le teardown ng-bootstrap (removeChild sur null).
     * On ferme d’abord la modale, puis on navigue quand la promesse du modal est terminée.
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
                /* déjà démontée */
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

    /** Commentaires : charge l'événement puis ouvre la même modale Quill que le détail. */
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

    /** Discussion live : même flux que détail événement. */
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
