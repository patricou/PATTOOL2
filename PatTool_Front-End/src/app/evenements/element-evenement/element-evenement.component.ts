import { Component, OnInit, OnDestroy, Input, Output, ViewChild, EventEmitter, AfterViewInit, OnChanges, SimpleChanges, TemplateRef, ElementRef, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { NgbModule, NgbModal, NgbRatingConfig } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SlideshowModalComponent, SlideshowImageSource, SlideshowLocationEvent } from '../../shared/slideshow-modal/slideshow-modal.component';
import { VideoshowModalComponent, VideoshowVideoSource } from '../../shared/videoshow-modal/videoshow-modal.component';
import { PhotosSelectorModalComponent, PhotosSelectionResult } from '../../shared/photos-selector-modal/photos-selector-modal.component';
import { TraceViewerModalComponent } from '../../shared/trace-viewer-modal/trace-viewer-modal.component';
// Removed ng2-file-upload - using native HTML file input
import * as JSZip from 'jszip';

import { Observable, firstValueFrom, Subscription, of } from 'rxjs';
import { map, take, catchError } from 'rxjs/operators';
import { UploadedFile } from '../../model/uploadedfile';
import { Member } from '../../model/member';
import { Evenement } from '../../model/evenement';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { environment } from '../../../environments/environment';
import { WindowRefService } from '../../services/window-ref.service';
import { FileService, ImageDownloadResult } from '../../services/file.service';
import { VideoCompressionService, CompressionProgress } from '../../services/video-compression.service';
import { EvenementsService } from '../../services/evenements.service';
import { FriendsService } from '../../services/friends.service';
import { FriendGroup } from '../../model/friend';
import { DiscussionModalComponent } from '../../communications/discussion-modal/discussion-modal.component';
import { DiscussionService } from '../../services/discussion.service';
import { EventColorService } from '../../services/event-color.service';
import { CommentaryEditor } from '../../commentary-editor/commentary-editor';

@Component({
	selector: 'element-evenement',
	standalone: true,
	imports: [
		CommonModule,
		FormsModule,
		RouterModule,
		TranslateModule,
		NgbModule,
		SlideshowModalComponent,
		VideoshowModalComponent,
		PhotosSelectorModalComponent,
		TraceViewerModalComponent,
		DiscussionModalComponent,
		CommentaryEditor
	],
	templateUrl: './element-evenement.component.html',
	styleUrls: ['./element-evenement.component.css'],
	providers: [NgbRatingConfig]
})
export class ElementEvenementComponent implements OnInit, AfterViewInit, OnDestroy, OnChanges {

	public selectedFiles: File[] = [];
	public API_URL: string = environment.API_URL;
	public API_URL4FILE: string = environment.API_URL4FILE;
	public showParticipantsList: boolean = false;
	// Upload logs
	public uploadLogs: string[] = [];
	public isUploading: boolean = false;
	public uploadLogsModalRef: any = null;
	// Video compression quality selection
	public selectedCompressionQuality: 'low' | 'medium' | 'high' | 'very-high' | 'original' = 'very-high';
	public showQualitySelection: boolean = false;
	public pendingVideoFiles: File[] = [];
	public videoCountForModal: number = 0;
	private qualityModalRef: any = null;
	// Image compression settings
	public compressImages: boolean = true; // Default: compress images
	public imageCountForModal: number = 0;
	@ViewChild('imageCompressionModal') imageCompressionModal!: TemplateRef<any>;
	private imageCompressionModalRef: any = null;
	// Evaluate rating
	public currentRate: number = 0;
	public safePhotosUrl: SafeUrl = {} as SafeUrl;
	// Native Window
	public nativeWindow: any;
	// Thumbnail image
	public thumbnailUrl: any = ElementEvenementComponent.getDefaultPlaceholderImageUrl();
	public selectedUser: Member | null = null;
	// Friend groups for visibility (now received as @Input from parent)
	// Visibility options for modal
	public visibilityOptions: Array<{value: string, label: string, friendGroupId?: string}> = [];
	// Type options for modal
	public typeOptions: Array<{value: string, label: string}> = [];
	// Dominant color for title background
	public titleBackgroundColor: string = 'rgba(255, 255, 255, 0.6)';
	// Inverse color for title border
	public titleBorderColor: string = 'rgba(0, 0, 0, 0.8)';
	// Average color for description background (pure color from photo)
	public descriptionBackgroundColor: string = 'rgba(255, 255, 255, 1)';
	// RGB values of calculated color
	public calculatedRgbValues: string = 'RGB(255, 255, 255)';
	// Dominant color RGB values for gradient calculations
	public dominantR: number = 128;
	public dominantG: number = 128;
	public dominantB: number = 128;

	public isSlideshowActive: boolean = false;
	public currentSlideshowIndex: number = 0;
	public slideshowImages: string[] = [];
	public slideshowInterval: any;
	
	// Card slideshow state
	public isCardSlideshowActive: boolean = false;
	public cardSlideshowPaused: boolean = false;
	public cardSlideImages: string[] = [];
	public cardSlideFileNames: string[] = [];
	public currentCardSlideIndex: number = 0;
	public currentCardSlideImage: string = '';
	private cardSlideshowInterval: any;
	private cardSlideshowSubscriptions: Subscription[] = [];
	private allSubscriptions: Subscription[] = []; // Track all subscriptions for cleanup
	private pollIntervalId: ReturnType<typeof setInterval> | null = null;
	private activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
	private fullscreenListeners: Array<{ element: Document | HTMLElement; event: string; handler: () => void }> = [];
	private imageLoadHandlers: Array<{ element: HTMLImageElement; handler: () => void }> = []; // Track image load handlers for cleanup
	public isFullscreen: boolean = false;
	private keyboardListener?: (event: KeyboardEvent) => void;
	private isSlideshowModalOpen: boolean = false;
	private lastKeyPressTime: number = 0;
	private lastKeyCode: number = 0;

	// Zoom state for slideshow
	public slideshowZoom: number = 1;
	public slideshowTranslateX: number = 0;
	public slideshowTranslateY: number = 0;
	public isDraggingSlideshow: boolean = false;
	private hasDraggedSlideshow: boolean = false;
	private dragStartX: number = 0;
	private dragStartY: number = 0;
	private dragOrigX: number = 0;
	private dragOrigY: number = 0;
	
	// Touch state for mobile gestures
	private touchStartDistance: number = 0;
	private touchStartZoom: number = 1;
	private lastTouchDistance: number = 0;
	private touchStartX: number = 0;
	private touchStartY: number = 0;
	private isPinching: boolean = false;
	private initialTouches: Touch[] = [];
	private pinchStartTranslateX: number = 0;
	private pinchStartTranslateY: number = 0;

	@ViewChild('slideshowContainer') slideshowContainerRef!: ElementRef;
	@ViewChild('slideshowImgEl') slideshowImgElRef!: ElementRef<HTMLImageElement>;
	@ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
	@ViewChild('videoshowModalComponent') videoshowModalComponent!: VideoshowModalComponent;
	@ViewChild('traceViewerModalComponent') traceViewerModalComponent!: TraceViewerModalComponent;
	@ViewChild('thumbnailImage', { static: false }) thumbnailImageRef!: ElementRef<HTMLImageElement>;
	@ViewChild('cardSlideImage', { static: false }) cardSlideImageRef!: ElementRef<HTMLImageElement>;

	// FS Photos slideshow loading control
	private fsSlideshowLoadingActive: boolean = false;
	private fsSlideshowSubs: Subscription[] = [];
	
	// Scroll position preservation for component modals
	private savedScrollPosition: number = 0;
	private scrollRestoreFunction: (() => void) | null = null;
	
	// File thumbnails cache
	private fileThumbnailsCache: Map<string, SafeUrl> = new Map();
	private fileThumbnailsLoading: Set<string> = new Set();
	
	// Video thumbnails cache
	private videoThumbnailsCache: Map<string, SafeUrl> = new Map();
	private videoThumbnailsLoading: Set<string> = new Set();
	private solidColorCache: Map<number, string> = new Map();
	private buttonGradientCache: Map<string, string> = new Map();
	private fileBadgeColorCache: Map<string, string> = new Map();
	private fileBadgeTextColorCache: Map<string, string> = new Map();
	private fileBadgeComponentsCache: Map<string, { r: number; g: number; b: number }> = new Map();
	private photoFrameStylesCache: { [key: string]: string } | null = null;
	private photoImageStylesCache: { [key: string]: string } | null = null;
	private photoBorderColorCache: string | null = null;
	// Portrait image handling
	private isThumbnailPortrait: boolean = false;
	private thumbnailImageWidth: number = 0;
	private thumbnailDisplayedWidth: number = 0;
	private cardBackgroundGradientCache: string | null = null;
	private filesListGradientCache: string | null = null;
	private statusBadgeGradientCache: string | null = null;
	private visibilityBadgeGradientCache: string | null = null;
	private downloadAllButtonGradientCache: string | null = null;
	private ratingBadgeGradientCache: string | null = null;
	private footerButtonStylesCache: Map<string, { [key: string]: string }> = new Map();
	private tooltipMutationObserver?: MutationObserver;
	private tooltipShowListener?: () => void;
	private tooltipShownListener?: () => void;
	private tooltipDocClickListener?: (event: MouseEvent) => void;

	// Loading time tracking
	private componentInitStartTime: number = 0;
	private componentInitEndTime: number = 0;
	private thumbnailLoadStartTime: number = 0;
	private thumbnailLoadEndTime: number = 0;
	private thumbnailImageLoadEndTime: number = 0; // When image actually displays
	private fileThumbnailsLoadTimes: Map<string, { start: number; end: number; fileName: string; displayed: boolean }> = new Map();
	private cardSlideshowLoadTimes: Map<string, { start: number; end: number; fileName: string; displayed: boolean }> = new Map();
	private colorDetectionStartTime: number = 0;
	private colorDetectionEndTime: number = 0;
	public loadingStats: {
		componentInit: number;
		thumbnailLoad: number;
		colorDetection: number;
		fileThumbnails: Array<{ fileName: string; loadTime: number }>;
		cardSlideshowImages: Array<{ fileName: string; loadTime: number }>;
		totalFiles: number;
		totalCardSlideshowImages: number;
		averageFileThumbnailTime: number;
		averageCardSlideshowTime: number;
		totalLoadTime: number;
	} = {
		componentInit: 0,
		thumbnailLoad: 0,
		colorDetection: 0,
		fileThumbnails: [],
		cardSlideshowImages: [],
		totalFiles: 0,
		totalCardSlideshowImages: 0,
		averageFileThumbnailTime: 0,
		averageCardSlideshowTime: 0,
		totalLoadTime: 0
	};

	private eventTypeLabels: { [key: string]: string } = {
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
		'17': 'EVENTCREATION.TYPE.FAMILY'
	};

	@ViewChild('jsonModal')
	public jsonModal!: TemplateRef<any>;
	@ViewChild('photosSelectorModalComponent') photosSelectorModalComponent!: PhotosSelectorModalComponent;
	@ViewChild('commentsModal') commentsModal!: TemplateRef<any>;
	@ViewChild('userModal') userModal!: TemplateRef<any>;
	@ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;
	@ViewChild('qualitySelectionModal') qualitySelectionModal!: TemplateRef<any>;
	@ViewChild('loadingStatsModal') loadingStatsModal!: TemplateRef<any>;
	@ViewChild('visibilityModal') visibilityModal!: TemplateRef<any>;
	@ViewChild('typeModal') typeModal!: TemplateRef<any>;
	@ViewChild('logContent') logContent: any;

	@Input()
	evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], [], undefined);

	@Input()
	user: Member = new Member("", "", "", "", "", [], "");

	@Input()
	titleOnly: boolean = false;

	@Input()
	friendGroups: FriendGroup[] = [];

	@Output()
	addMember: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	delMember: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	delEvenement: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	updateEvenement: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	updateFileUploaded: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	openPhotosModal: EventEmitter<Evenement> = new EventEmitter<Evenement>();

	@Output()
	colorComputed: EventEmitter<{ eventId: string; color: { r: number; g: number; b: number } }> = new EventEmitter();
	
	@Output()
	storeEventForReturn: EventEmitter<string> = new EventEmitter<string>();
	
	@Output()
	cardReady: EventEmitter<string> = new EventEmitter<string>();
	
	// Store event ID before navigation - emit to parent so it can calculate page
	public storeEventIdForReturn(): void {
		if (this.evenement && this.evenement.id) {
			// Emit to parent so it can calculate page number
			this.storeEventForReturn.emit(this.evenement.id);
		}
	}
	
	// Emit card ready event when thumbnail is successfully set
	private emitCardReady(): void {
		const eventId = this.evenement?.id || this.evenement?.evenementName || '';
		if (eventId) {
			// Use setTimeout to ensure this runs after Angular's change detection cycle
			setTimeout(() => {
				this.cardReady.emit(eventId);
				// Files will be loaded on-demand when buttons are clicked
			}, 0);
		}
	}
	
	constructor(
		private sanitizer: DomSanitizer,
		private _router: Router,
		private modalService: NgbModal,
		private ratingConfig: NgbRatingConfig,
		private _fileService: FileService,
		private winRef: WindowRefService,
		private translateService: TranslateService,
		private videoCompressionService: VideoCompressionService,
		private _evenementsService: EvenementsService,
		private _friendsService: FriendsService,
		private _discussionService: DiscussionService,
		private eventColorService: EventColorService,
		private cdr: ChangeDetectorRef,
		private ngZone: NgZone
	) {
		// Rating config 
		this.ratingConfig.max = 10;
		this.ratingConfig.readonly = true;
		this.nativeWindow = winRef.getNativeWindow();
	}

	private static readonly thumbnailCache: Map<string, {
		thumbnailUrl: SafeUrl | string;
		dominant: { r: number; g: number; b: number };
		titleBackground: string;
		titleBorder: string;
		descriptionBackground: string;
		signature: string;
	}> = new Map();

	// Static cache for blob URLs to prevent them from being revoked
	// This ensures blob URLs remain valid across component destruction/recreation
	private static readonly blobUrlCache: Map<string, SafeUrl> = new Map();
	
	// Static cache for Blob objects to allow recreating blob URLs if they're revoked
	// This prevents ERR_FILE_NOT_FOUND errors by storing the original Blob
	private static readonly blobCache: Map<string, Blob> = new Map();
	
	// Static cache for the default placeholder image - loaded once and reused across all components
	// This prevents multiple HTTP requests for the same default image
	private static defaultPlaceholderImage: SafeUrl | null = null;
	private static defaultPlaceholderImageUrl: string = "assets/images/images.jpg";
	
	// Static set to track files currently being loaded (to prevent duplicate concurrent requests)
	private static readonly filesLoading: Set<string> = new Set();

	// Global queue for image loading to prevent all 8 cards from loading images simultaneously
	private static imageLoadingQueue: Array<() => void> = [];
	private static isProcessingImageQueue: boolean = false;
	private static readonly MAX_CONCURRENT_IMAGE_LOADS = 2; // Load 2 images at a time
	private static currentImageLoads: number = 0;

	// Public static method to check if a file is already cached (to avoid duplicate requests)
	public static isThumbnailCached(fileId: string): boolean {
		return ElementEvenementComponent.blobUrlCache.has(fileId);
	}
	
	// Public static method to check if a file is currently being loaded
	public static isFileLoading(fileId: string): boolean {
		return ElementEvenementComponent.filesLoading.has(fileId);
	}
	
	// Public static method to mark a file as loading
	public static setFileLoading(fileId: string): void {
		ElementEvenementComponent.filesLoading.add(fileId);
	}
	
	// Public static method to mark a file as no longer loading
	public static clearFileLoading(fileId: string): void {
		ElementEvenementComponent.filesLoading.delete(fileId);
	}

	// Public static method to get cached thumbnail URL
	public static getCachedThumbnail(fileId: string): SafeUrl | undefined {
		return ElementEvenementComponent.blobUrlCache.get(fileId);
	}

	// Public static method to cache a thumbnail URL (for sharing cache between components)
	public static setCachedThumbnail(fileId: string, safeUrl: SafeUrl): void {
		ElementEvenementComponent.blobUrlCache.set(fileId, safeUrl);
	}
	
	// Public static method to cache a blob (only for thumbnails)
	public static setCachedBlob(fileId: string, blob: Blob): void {
		ElementEvenementComponent.blobCache.set(fileId, blob);
	}
	
	// Public static method to get cached thumbnails count
	public static getCachedThumbnailsCount(): number {
		return ElementEvenementComponent.blobUrlCache.size;
	}
	
	// Public static method to get count of files currently loading
	public static getPendingFileThumbnailLoadsCount(): number {
		return ElementEvenementComponent.filesLoading.size;
	}
	
	// Public static method to cleanup unused caches (called from home-evenements)
	public static cleanupUnusedCaches(keepFieldIds: Set<string>): void {
		// Clean up blobUrlCache - remove entries for fieldIds not in use
		const blobUrlCacheEntriesToRemove: string[] = [];
		ElementEvenementComponent.blobUrlCache.forEach((blobUrl, fieldId) => {
			if (!keepFieldIds.has(fieldId)) {
				blobUrlCacheEntriesToRemove.push(fieldId);
			}
		});
		
		// Clean up blobCache - remove entries for fieldIds not in use
		const blobCacheEntriesToRemove: string[] = [];
		ElementEvenementComponent.blobCache.forEach((blob, fieldId) => {
			if (!keepFieldIds.has(fieldId)) {
				blobCacheEntriesToRemove.push(fieldId);
			}
		});
		
		// Remove unused blob URLs and revoke them
		blobUrlCacheEntriesToRemove.forEach(fieldId => {
			const blobUrl = ElementEvenementComponent.blobUrlCache.get(fieldId);
			if (blobUrl && typeof blobUrl === 'object' && 'changingThisBreaksApplicationSecurity' in blobUrl) {
				const url = blobUrl['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					try {
						URL.revokeObjectURL(url);
					} catch (e) {
						// Ignore errors
					}
				}
			}
			ElementEvenementComponent.blobUrlCache.delete(fieldId);
		});
		
		// Remove unused blobs from cache (they will be garbage collected)
		blobCacheEntriesToRemove.forEach(fieldId => {
			ElementEvenementComponent.blobCache.delete(fieldId);
		});
	}
	
	// Public static method to cleanup unused thumbnail cache entries
	public static cleanupUnusedThumbnailCache(keepEventIds: Set<string>): void {
		const entriesToRemove: string[] = [];
		ElementEvenementComponent.thumbnailCache.forEach((cached, cacheKey) => {
			if (!keepEventIds.has(cacheKey)) {
				entriesToRemove.push(cacheKey);
			}
		});
		
		entriesToRemove.forEach(cacheKey => {
			ElementEvenementComponent.thumbnailCache.delete(cacheKey);
		});
	}
	
	// Public static method to get blob cache size
	public static getBlobCacheSize(): number {
		return ElementEvenementComponent.blobCache.size;
	}
	
	// Public static method to get the default placeholder image (cached, loaded only once)
	// This ensures the default image is loaded only once from the backend, not once per component
	public static getDefaultPlaceholderImage(sanitizer: DomSanitizer): SafeUrl {
		if (!ElementEvenementComponent.defaultPlaceholderImage) {
			ElementEvenementComponent.defaultPlaceholderImage = 
				sanitizer.bypassSecurityTrustUrl(ElementEvenementComponent.defaultPlaceholderImageUrl);
		}
		return ElementEvenementComponent.defaultPlaceholderImage;
	}
	
	// Public static method to get the default placeholder image URL string (for direct use)
	public static getDefaultPlaceholderImageUrl(): string {
		return ElementEvenementComponent.defaultPlaceholderImageUrl;
	}

	// =========================
	// Photo From FS integration
	// =========================

	public getPhotoFromFsLinks(): UrlEvent[] {
		if (!this.evenement || !this.evenement.urlEvents) return [];
		return this.evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOFROMFS');
	}

	public getPhotosUrlLinks(): UrlEvent[] {
		if (!this.evenement || !this.evenement.urlEvents) return [];
		return this.evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOS');
	}

	public getPhotoFromFsCount(): number {
		return this.getPhotoFromFsLinks().length;
	}

	public getTotalPhotosCount(): number {
		// Each photo source counts as 1, regardless of how many photos it contains
		let count = 0;
		// Uploaded photos: count as 1 if any exist
		if (this.hasImageFiles()) {
			count += 1;
		}
		// Each FS link counts as 1
		count += this.getPhotoFromFsCount();
		// Each web photo link counts as 1
		count += this.getPhotosUrlLinks().length;
		// If thumbnail exists, add 1
		if (this.evenement.thumbnail) {
			count += 1;
		}
		// If fileUploadeds has items, remove 1 (thumbnail is already counted in fileUploadeds)
		if (this.evenement.fileUploadeds && this.evenement.fileUploadeds.length > 0) {
			count -= 1;
		}
		return count;
	}

    public openFsPhotosSelector(includeUploadedChoice: boolean = false): void {
        this.forceCloseTooltips();
        const fsLinks = this.getPhotoFromFsLinks();
        const webLinks = this.getPhotosUrlLinks();
        const hasAnyLinks = (fsLinks.length + webLinks.length) > 0;

        // If includeUploadedChoice is true, always open modal (even if files are still loading)
        if (includeUploadedChoice) {
            // Use the new photos selector modal component
            if (this.photosSelectorModalComponent) {
                this.photosSelectorModalComponent.evenement = this.evenement;
                this.photosSelectorModalComponent.includeUploadedChoice = includeUploadedChoice;
                this.photosSelectorModalComponent.user = this.user;
                this.photosSelectorModalComponent.open();
            }
            return;
        }
        
        // If not including uploaded choice, check if we have links
        if (!hasAnyLinks) {
            return;
        }
        if (fsLinks.length === 1 && webLinks.length === 0) {
            this.openFsPhotosDiaporama(fsLinks[0].link, true);
            return;
        }
        
        // Use the new photos selector modal component
        if (this.photosSelectorModalComponent) {
            this.photosSelectorModalComponent.evenement = this.evenement;
            this.photosSelectorModalComponent.includeUploadedChoice = includeUploadedChoice;
            this.photosSelectorModalComponent.user = this.user;
            this.photosSelectorModalComponent.open();
        }
    }

    public onPhotosSelectionConfirmed(result: PhotosSelectionResult): void {
        // Close the photos selector modal before opening slideshow
        // This preserves the original scroll position in the modal component
        if (this.photosSelectorModalComponent && (this.photosSelectorModalComponent as any).modalRef) {
            (this.photosSelectorModalComponent as any).modalRef.close();
        }
        
        if (result.type === 'uploaded') {
            this.openSlideshow();
        } else if (result.type === 'web') {
            try { this.winRef.getNativeWindow().open(result.value, '_blank'); } catch {}
        } else if (result.type === 'fs') {
            this.openFsPhotosDiaporama(result.value, result.compressFs !== false);
        }
    }

    private openFsPhotosDiaporama(relativePath: string, compress: boolean = true): void {
		this.forceCloseTooltips();
		// Open slideshow modal immediately with empty array - images will be loaded dynamically
		if (!this.slideshowModalComponent || !this.evenement) {
			console.error('Slideshow modal component or event not available');
			return;
		}
		
		// Reset slideshow loading state
		this.fsSlideshowLoadingActive = true;
		
		// Get event color for slideshow
		let eventColor = this.evenement?.id ? this.eventColorService.getEventColor(this.evenement.id) : null;
		if (!eventColor && this.evenement?.evenementName) {
			eventColor = this.eventColorService.getEventColor(this.evenement.evenementName);
		}
		
		// Get scroll position - prefer the original position from PhotosSelectorModalComponent if available
		// This ensures consistency when reopening "Sélection de Photos" after slideshow
		let savedScrollY: number;
		const photosSelector = this.photosSelectorModalComponent as any;
		if (photosSelector && photosSelector.originalScrollPosition && photosSelector.originalScrollPosition > 0) {
			// Use the original position from PhotosSelectorModalComponent
			savedScrollY = photosSelector.originalScrollPosition;
			this.savedScrollPosition = savedScrollY;
		} else {
			// No PhotosSelectorModalComponent position available, use current scroll
			savedScrollY = window.scrollY || window.pageYOffset || 
				document.documentElement.scrollTop || 
				document.body.scrollTop || 0;
			this.savedScrollPosition = savedScrollY;
		}
		
		// Block scroll and save position
		if (document.body) {
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.top = `-${savedScrollY}px`;
			document.body.style.width = '100%';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
		
		// Store restore function - use same logic as PhotosSelectorModalComponent for consistency
		this.scrollRestoreFunction = () => {
			// First unblock scroll immediately - clean all styles
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after Bootstrap cleanup is complete
			const restoreScroll = () => {
				// Restore to saved scroll position - single smooth operation
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto' // Instant, no animation to avoid jumps
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			// Wait for Bootstrap to finish all cleanup, then restore ONCE
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore after Bootstrap cleanup is complete
					setTimeout(restoreScroll, 300);
				});
			});
		};
		
		// Open modal immediately with empty array
		this.slideshowModalComponent.open([], this.evenement.evenementName, false, 0, eventColor || undefined);
		
		// Immediately maintain scroll position after modal opens to prevent any movement
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				// Restore scroll position in case Bootstrap tried to scroll
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
				// Ensure body position is maintained
				if (document.body) {
					document.body.style.top = `-${savedScrollY}px`;
				}
			});
		});
		
		// Then list and load images dynamically
        const listSub = this._fileService.listImagesFromDisk(relativePath).subscribe({
            next: (fileNames: string[]) => {
                if (!fileNames || fileNames.length === 0 || !this.fsSlideshowLoadingActive) {
                    return;
                }
				
				// Load images with concurrency and add them dynamically
				const maxConcurrent = 12;
				let active = 0;
				const queue = [...fileNames];
				
				const loadNext = () => {
					if (!this.fsSlideshowLoadingActive || active >= maxConcurrent || queue.length === 0) {
						return;
					}
					
					const fileName = queue.shift() as string;
					active++;
					
                    const imageSub = this._fileService.getImageFromDiskWithMetadata(relativePath, fileName, compress).subscribe({
						next: (result: ImageDownloadResult) => {
							if (!this.fsSlideshowLoadingActive) return;
							
							const blob = new Blob([result.buffer], { type: 'image/*' });
							const url = URL.createObjectURL(blob);
                            const patMetadata = result.metadata ? {
                                originalSizeBytes: result.metadata.originalSizeBytes,
                                originalSizeKilobytes: result.metadata.originalSizeKilobytes,
                                rawHeaderValue: result.metadata.rawHeaderValue
                            } : undefined;
							const imageSource: SlideshowImageSource = { 
								blobUrl: url, 
								fileId: undefined, 
								blob: blob, 
								fileName: fileName,
                                relativePath: relativePath,
                                compressFs: compress,
                                patMetadata: patMetadata
							};
							
							// Add image dynamically to the already open slideshow
							if (this.slideshowModalComponent && this.fsSlideshowLoadingActive) {
								this.slideshowModalComponent.addImages([imageSource]);
							}
						},
						error: (error) => {
							console.error('Error loading image:', fileName, error);
						},
						complete: () => {
							active--;
							if (this.fsSlideshowLoadingActive) {
								loadNext();
							}
						}
					});
					this.fsSlideshowSubs.push(imageSub);
					this.allSubscriptions.push(imageSub);
				};
				
				// Start loading images
				for (let i = 0; i < maxConcurrent && queue.length > 0 && this.fsSlideshowLoadingActive; i++) {
					loadNext();
				}
            },
            error: (error) => {
                console.error('Error listing images from disk:', error);
            }
        });
		this.fsSlideshowSubs.push(listSub);
		this.allSubscriptions.push(listSub);
	}

	public onSlideshowClosed(): void {
		this.fsSlideshowLoadingActive = false;
		this.fsSlideshowSubs.forEach(sub => {
			if (sub && !sub.closed) {
				sub.unsubscribe();
			}
		});
		this.fsSlideshowSubs = [];
		
		// Check if PhotosSelectorModalComponent is still open (has modalRef)
		// If it is, don't restore scroll as it manages scroll itself
		const isPhotosSelectorOpen = this.photosSelectorModalComponent && 
			(this.photosSelectorModalComponent as any).modalRef && 
			document.querySelector('.modal.show:has(.photos-selector-header)');
		
		// Only restore scroll if PhotosSelectorModalComponent is not open
		// The slideshow modal will also try to restore scroll, so we need to prevent it and use our position
		if (!isPhotosSelectorOpen && this.scrollRestoreFunction) {
			// Prevent slideshow modal from restoring by setting scrollRestoreAttempted flag
			if (this.slideshowModalComponent) {
				const slideshowComponent = this.slideshowModalComponent as any;
				if (slideshowComponent.scrollRestoreAttempted !== undefined) {
					slideshowComponent.scrollRestoreAttempted = true; // Prevent slideshow's restore
				}
				// Also set its saved position to match ours so if it does restore, it uses the right position
				if (slideshowComponent.savedScrollPosition !== undefined) {
					slideshowComponent.savedScrollPosition = this.savedScrollPosition;
				}
			}
			
			// Wait for Bootstrap and slideshow modal cleanup to complete, then restore
			setTimeout(() => {
				if (this.scrollRestoreFunction) {
					this.scrollRestoreFunction();
					this.scrollRestoreFunction = null;
				}
				// Additional restore to ensure correct position (in case slideshow modal still restored)
				if (this.savedScrollPosition > 0) {
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							setTimeout(() => {
								window.scrollTo({
									top: this.savedScrollPosition,
									left: 0,
									behavior: 'auto'
								});
								if (document.documentElement) {
									document.documentElement.scrollTop = this.savedScrollPosition;
								}
								if (document.body) {
									document.body.scrollTop = this.savedScrollPosition;
								}
							}, 100);
						});
					});
				}
			}, 100); // Short delay to let cleanup start
		} else if (isPhotosSelectorOpen && this.scrollRestoreFunction) {
			// Clear the restore function but don't execute it - PhotosSelectorModalComponent will handle scroll
			this.scrollRestoreFunction = null;
		}
		
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.setTraceViewerOpen(false);
		}
	}

	public onVideoshowClosed(): void {
		// Handle videoshow modal close if needed
		// Similar cleanup can be added here if needed in the future
		
		// Restore scroll position
		if (this.scrollRestoreFunction) {
			this.scrollRestoreFunction();
			this.scrollRestoreFunction = null;
		}
	}

	public onSlideshowLocationInTrace(event: SlideshowLocationEvent): void {
		if (!event || typeof event.lat !== 'number' || typeof event.lng !== 'number') {
			return;
		}

		const labelParts: string[] = [];
		if (this.evenement?.evenementName) {
			labelParts.push(this.evenement.evenementName);
		}
		if (event.label) {
			labelParts.push(event.label);
		}

		const label = labelParts.length > 0
			? labelParts.join(' • ')
			: this.translateService.instant('EVENTELEM.SEE_LOCATION');

		// Use event color from slideshow if available, otherwise get from service
		let finalEventColor: { r: number; g: number; b: number } | undefined = event.eventColor;
		if (!finalEventColor) {
			const eventColor = this.evenement?.id ? this.eventColorService.getEventColor(this.evenement.id) : null;
			if (eventColor) {
				finalEventColor = eventColor;
			} else if (this.evenement?.evenementName) {
				const nameColor = this.eventColorService.getEventColor(this.evenement.evenementName);
				if (nameColor) {
					finalEventColor = nameColor;
				}
			}
		}

		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.setTraceViewerOpen(true);
		}

		if (this.traceViewerModalComponent) {
			// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
			// CSS will handle blocking scroll via styles.css rule
			const savedScrollY = window.scrollY || window.pageYOffset || 
				document.documentElement.scrollTop || 
				document.body.scrollTop || 0;
			this.savedScrollPosition = savedScrollY;
			
			this.traceViewerModalComponent.openAtLocation(event.lat, event.lng, label, finalEventColor);
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo(0, savedScrollY);
					document.documentElement.scrollTop = savedScrollY;
					document.body.scrollTop = savedScrollY;
				});
			});
			
			// Store restore function
			this.scrollRestoreFunction = () => {
				// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.overflowX = '';
					document.body.style.overflowY = '';
					document.body.style.position = '';
					document.body.style.height = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
					document.documentElement.style.overflowX = '';
					document.documentElement.style.overflowY = '';
				}
				
				// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
				const restoreScroll = () => {
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
				};
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						setTimeout(restoreScroll, 300);
					});
				});
			};
		}
	}

	public onTraceViewerClosed(): void {
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.setTraceViewerOpen(false);
		}
		
		// Restore scroll position
		if (this.scrollRestoreFunction) {
			this.scrollRestoreFunction();
			this.scrollRestoreFunction = null;
		}
	}

	// Unified photos opener (uploaded photos or FS photos)
	public openPhotos(): void {
		this.forceCloseTooltips();
		
		// ALWAYS open the photos selector modal first, regardless of photo count
		// This ensures the user always sees the "Selection de Photo" modal
		this.openFsPhotosSelector(true);
		
		// Load files in background if not already loaded (non-blocking)
		if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
			this.loadFilesForSlideshow();
		}
	}
	
	// Open photos when files are already loaded
	private openPhotosWithFiles(): void {
		const hasFs = this.getPhotoFromFsCount() > 0;
		const hasPhotosWeb = this.getPhotosUrlLinks().length > 0;
		const hasUploaded = this.hasImageFiles(); // This checks for image files only

		if ((hasFs || hasPhotosWeb) && hasUploaded) {
			this.openFsPhotosSelector(true);
			return;
		}
		if (hasFs || hasPhotosWeb) {
			this.openFsPhotosSelector(false);
			return;
		}
		if (hasUploaded) {
			// Double check: make sure we have image files before opening slideshow
			const imageFiles = this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
			if (imageFiles.length > 0) {
				this.openSlideshow();
			} else {
				// No images found, show message
				alert('Aucune image trouvée dans cet événement.');
			}
		} else {
			// No images at all
			alert('Aucune image trouvée dans cet événement.');
		}
	}
	
	// Load files asynchronously for slideshow
	private loadFilesForSlideshow(): void {
		if (!this.evenement || !this.evenement.id || !this._evenementsService) {
			return;
		}
		
		// Stream files using Server-Sent Events (SSE)
		this._evenementsService.streamEventFiles(this.evenement.id).subscribe({
			next: (streamedFile) => {
				if (streamedFile.type === 'file') {
					// File received - add to array
					const file = streamedFile.data as UploadedFile;
					if (!this.evenement.fileUploadeds) {
						this.evenement.fileUploadeds = [];
					}
					this.evenement.fileUploadeds.push(file);
					// Trigger change detection for photos selector modal if it's open
					if (this.photosSelectorModalComponent) {
						setTimeout(() => {
							this.photosSelectorModalComponent.checkAndSelectSingleOption();
						}, 100);
					}
				} else if (streamedFile.type === 'complete') {
					// All files loaded - check if we need to auto-select in modal
					if (this.photosSelectorModalComponent) {
						setTimeout(() => {
							this.photosSelectorModalComponent.checkAndSelectSingleOption();
						}, 100);
					}
					// All files loaded - now open photos
					this.openPhotosWithFiles();
				}
			},
			error: (error) => {
				console.error('Error loading files for slideshow:', error);
				alert('Erreur lors du chargement des fichiers.');
			}
		});
	}

	// =========================
	// Zoom handlers (slideshow only)
	// =========================

	public getMinSlideshowZoom(): number {
		try {
			const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
			const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
			if (!container || !imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return 0.5;
			const cw = container.clientWidth || 1;
			const ch = container.clientHeight || 1;
			const iw = imgEl.naturalWidth;
			const ih = imgEl.naturalHeight;
			return Math.max(cw / iw, ch / ih);
		} catch { return 0.5; }
	}

	private applyWheelZoom(event: WheelEvent, current: number, minZoom: number, maxZoom: number = 5): number {
		event.preventDefault();
		// Use actual deltaY value for linear zoom (normalized to reasonable scale)
		const delta = event.deltaY / 50; // Normalize to make scroll speed reasonable (faster zoom)
		const step = 0.08; // Step for faster zoom while maintaining linearity
		let next = current - delta * step; // wheel up -> zoom in
		if (next < minZoom) next = minZoom;
		if (next > maxZoom) next = maxZoom;
		return parseFloat(next.toFixed(2));
	}

	public onWheelSlideshow(event: WheelEvent): void {
		const minZoom = this.getMinSlideshowZoom();
		this.slideshowZoom = this.applyWheelZoom(event, this.slideshowZoom, minZoom);
		this.clampSlideshowTranslation();
	}

	public resetSlideshowZoom(): void { this.slideshowZoom = Math.max(1, this.getMinSlideshowZoom()); this.slideshowTranslateX = 0; this.slideshowTranslateY = 0; }
	public zoomInSlideshow(): void { this.slideshowZoom = Math.min(5, parseFloat((this.slideshowZoom + 0.1).toFixed(2))); }
	public zoomOutSlideshow(): void { this.slideshowZoom = Math.max(this.getMinSlideshowZoom(), parseFloat((this.slideshowZoom - 0.1).toFixed(2))); this.clampSlideshowTranslation(); }

	// Drag handlers for Slideshow modal
	public onSlideshowMouseDown(event: MouseEvent): void {
		const canDrag = this.slideshowZoom > this.getMinSlideshowZoom();
		this.isDraggingSlideshow = canDrag;
		this.hasDraggedSlideshow = false;
		if (canDrag) { try { event.preventDefault(); event.stopPropagation(); } catch {} }
		this.dragStartX = event.clientX;
		this.dragStartY = event.clientY;
		this.dragOrigX = this.slideshowTranslateX;
		this.dragOrigY = this.slideshowTranslateY;
	}

	public onSlideshowMouseMove(event: MouseEvent): void {
		if (!this.isDraggingSlideshow) return;
		try { event.preventDefault(); event.stopPropagation(); } catch {}
		const dx = event.clientX - this.dragStartX;
		const dy = event.clientY - this.dragStartY;
		this.slideshowTranslateX = this.dragOrigX + dx;
		this.slideshowTranslateY = this.dragOrigY + dy;
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.hasDraggedSlideshow = true;
		this.clampSlideshowTranslation();
	}

	public onSlideshowMouseUp(): void {
		this.isDraggingSlideshow = false;
	}

	public onSlideshowImageClick(): void {
		// Ignore click if it was a drag
		if (this.hasDraggedSlideshow) { this.hasDraggedSlideshow = false; return; }
		this.toggleSlideshowWithMessage();
	}

	private clampSlideshowTranslation(): void {
		try {
			const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
			const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
			if (!container || !imgEl) return;
			const cw = container.clientWidth;
			const ch = container.clientHeight;
			const iw = imgEl.clientWidth * this.slideshowZoom;
			const ih = imgEl.clientHeight * this.slideshowZoom;
			const maxX = Math.max(0, (iw - cw) / 2);
			const maxY = Math.max(0, (ih - ch) / 2);
			if (this.slideshowTranslateX > maxX) this.slideshowTranslateX = maxX;
			if (this.slideshowTranslateX < -maxX) this.slideshowTranslateX = -maxX;
			if (this.slideshowTranslateY > maxY) this.slideshowTranslateY = maxY;
			if (this.slideshowTranslateY < -maxY) this.slideshowTranslateY = -maxY;
		} catch {}
	}

	// Helper function to calculate distance between two touches
	private getTouchDistance(touch1: Touch, touch2: Touch): number {
		const dx = touch1.clientX - touch2.clientX;
		const dy = touch1.clientY - touch2.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	// Helper function to get center point between two touches
	private getTouchCenter(touch1: Touch, touch2: Touch): { x: number; y: number } {
		return {
			x: (touch1.clientX + touch2.clientX) / 2,
			y: (touch1.clientY + touch2.clientY) / 2
		};
	}

	// Touch handlers for Slideshow modal - Mobile support
	public onSlideshowTouchStart(event: TouchEvent): void {
		if (event.touches.length === 1) {
			// Single touch - start drag
			const touch = event.touches[0];
			const canDrag = this.slideshowZoom > this.getMinSlideshowZoom();
			this.isDraggingSlideshow = canDrag;
			this.hasDraggedSlideshow = false;
			if (canDrag) {
				try { event.preventDefault(); event.stopPropagation(); } catch {}
			}
			this.touchStartX = touch.clientX;
			this.touchStartY = touch.clientY;
			this.dragStartX = touch.clientX;
			this.dragStartY = touch.clientY;
			this.dragOrigX = this.slideshowTranslateX;
			this.dragOrigY = this.slideshowTranslateY;
			this.isPinching = false;
		} else if (event.touches.length === 2) {
			// Two touches - start pinch zoom
			try { event.preventDefault(); event.stopPropagation(); } catch {}
			this.isPinching = true;
			this.isDraggingSlideshow = false;
			const touch1 = event.touches[0];
			const touch2 = event.touches[1];
			this.touchStartDistance = this.getTouchDistance(touch1, touch2);
			this.touchStartZoom = this.slideshowZoom;
			this.lastTouchDistance = this.touchStartDistance;
			this.initialTouches = [touch1, touch2];
			this.pinchStartTranslateX = this.slideshowTranslateX;
			this.pinchStartTranslateY = this.slideshowTranslateY;
			
			// Store the center point for zoom origin
			const center = this.getTouchCenter(touch1, touch2);
			const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
			if (container) {
				const rect = container.getBoundingClientRect();
				this.touchStartX = center.x - rect.left;
				this.touchStartY = center.y - rect.top;
			}
		}
	}

	public onSlideshowTouchMove(event: TouchEvent): void {
		if (event.touches.length === 1 && !this.isPinching) {
			// Single touch - drag
			if (!this.isDraggingSlideshow) return;
			const touch = event.touches[0];
			try { event.preventDefault(); event.stopPropagation(); } catch {}
			const dx = touch.clientX - this.dragStartX;
			const dy = touch.clientY - this.dragStartY;
			this.slideshowTranslateX = this.dragOrigX + dx;
			this.slideshowTranslateY = this.dragOrigY + dy;
			if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.hasDraggedSlideshow = true;
			this.clampSlideshowTranslation();
		} else if (event.touches.length === 2 && this.isPinching) {
			// Two touches - pinch zoom
			try { event.preventDefault(); event.stopPropagation(); } catch {}
			const touch1 = event.touches[0];
			const touch2 = event.touches[1];
			const currentDistance = this.getTouchDistance(touch1, touch2);
			
			if (this.touchStartDistance > 0) {
				// Calculate zoom factor based on distance change
				const scale = currentDistance / this.touchStartDistance;
				let newZoom = this.touchStartZoom * scale;
				
				// Apply min/max zoom constraints
				const minZoom = this.getMinSlideshowZoom();
				const maxZoom = 5;
				newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
				
				this.slideshowZoom = parseFloat(newZoom.toFixed(2));
				
				// Adjust translation to keep zoom centered on pinch point
				if (this.slideshowZoom > minZoom) {
					const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
					const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
					if (container && imgEl) {
						const rect = container.getBoundingClientRect();
						const currentPinchCenterX = (touch1.clientX + touch2.clientX) / 2 - rect.left;
						const currentPinchCenterY = (touch1.clientY + touch2.clientY) / 2 - rect.top;
						
						// Get initial pinch center point
						const initialPinchCenterX = this.touchStartX;
						const initialPinchCenterY = this.touchStartY;
						
						// Calculate zoom change factor
						const zoomChange = this.slideshowZoom / this.touchStartZoom;
						
						// Calculate the new translation to zoom around the initial pinch point
						// Formula: newTranslate = pinchCenter - (pinchCenter - oldTranslate) * zoomChange
						this.slideshowTranslateX = initialPinchCenterX - (initialPinchCenterX - this.pinchStartTranslateX) * zoomChange;
						this.slideshowTranslateY = initialPinchCenterY - (initialPinchCenterY - this.pinchStartTranslateY) * zoomChange;
					}
				}
				
				this.lastTouchDistance = currentDistance;
				this.clampSlideshowTranslation();
			}
		}
	}

	public onSlideshowTouchEnd(event: TouchEvent): void {
		if (event.touches.length === 0) {
			// All touches ended
			this.isDraggingSlideshow = false;
			this.isPinching = false;
			this.initialTouches = [];
			this.touchStartDistance = 0;
			this.lastTouchDistance = 0;
			this.pinchStartTranslateX = 0;
			this.pinchStartTranslateY = 0;
		} else if (event.touches.length === 1 && this.isPinching) {
			// One touch lifted during pinch - switch to drag mode
			this.isPinching = false;
			const touch = event.touches[0];
			this.isDraggingSlideshow = this.slideshowZoom > this.getMinSlideshowZoom();
			if (this.isDraggingSlideshow) {
				this.touchStartX = touch.clientX;
				this.touchStartY = touch.clientY;
				this.dragStartX = touch.clientX;
				this.dragStartY = touch.clientY;
				this.dragOrigX = this.slideshowTranslateX;
				this.dragOrigY = this.slideshowTranslateY;
			}
			this.pinchStartTranslateX = 0;
			this.pinchStartTranslateY = 0;
		}
	}

	ngOnInit() {
		// Track component initialization start time
		this.componentInitStartTime = performance.now();
		
		// init the rate 
		this.currentRate = 0;
		if (this.evenement.ratingMinus != null) {
			let rateClick = this.evenement.ratingMinus + this.evenement.ratingPlus;
			if (rateClick !== 0) {
				this.currentRate = (this.evenement.ratingPlus) / rateClick * 10;
			}
		}
		
		
		// sanitize the photoUrl
		// Call Thumbnail Image function
		// Use cache if available (now handles blob URLs correctly)
		// Try loading immediately first
		this.thumbnailLoadStartTime = performance.now();
		this.loadThumbnail();
		
		// Mark component initialization as complete after a short delay to allow view to initialize
		setTimeout(() => {
			if (this.componentInitEndTime === 0) {
				this.componentInitEndTime = performance.now();
			}
		}, 100);
		
		// Also try after delays in case fileUploadeds is populated later
		// This handles cases where we return from update page
		setTimeout(() => {
			// Check if thumbnail is still default or invalid
			if (!this.thumbnailUrl || this.thumbnailUrl === "assets/images/images.jpg" || 
				(typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl)) {
				const url = typeof this.thumbnailUrl === 'object' ? 
					this.thumbnailUrl['changingThisBreaksApplicationSecurity'] : this.thumbnailUrl;
				if (!url || url === "assets/images/images.jpg") {
					// Thumbnail not loaded yet, try again
					this.loadThumbnail();
				}
			}
		}, 300);
		
		setTimeout(() => {
			// Final check - if still default, try one more time
			if (!this.thumbnailUrl || this.thumbnailUrl === "assets/images/images.jpg" || 
				(typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl)) {
				const url = typeof this.thumbnailUrl === 'object' ? 
					this.thumbnailUrl['changingThisBreaksApplicationSecurity'] : this.thumbnailUrl;
				if (!url || url === "assets/images/images.jpg") {
					this.loadThumbnail();
				}
			}
		}, 600);
		
		// Initialize commentaries if not present
		this.initializeCommentaries();
		
		// Setup tooltip auto-close on modal open
		this.setupTooltipAutoClose();
		
		// Friend groups are now passed as @Input from parent component to avoid redundant API calls
		// If not provided, initialize as empty array
		if (!this.friendGroups) {
			this.friendGroups = [];
		}
	}
	
	ngOnChanges(changes: SimpleChanges): void {
		// If the evenement input changes (e.g., after an update), reload the thumbnail
		if (changes['evenement']) {
			if (changes['evenement'].firstChange) {
				// First change is handled in ngOnInit
				return;
			}
			
			const previousEvenement = changes['evenement'].previousValue;
			const currentEvenement = changes['evenement'].currentValue;
			
			// Check if event ID is the same (same event, just updated)
			if (previousEvenement && currentEvenement) {
				const prevId = previousEvenement.id || previousEvenement.evenementName;
				const currId = currentEvenement.id || currentEvenement.evenementName;
				
				if (prevId === currId && currId) {
					// Event was updated - reload thumbnail to reflect any changes
					// Delay to ensure fileUploadeds is populated
					setTimeout(() => {
						this.loadThumbnail();
					}, 150);
					
					// Files will be loaded on-demand when buttons are clicked
				}
			}
		}
	}
	
	// Centralized method to load thumbnail
	private loadThumbnail(): void {
		const signature = this.getThumbnailSignature();
		// Try to apply cached styles first - pass signature but it will be lenient for blob URLs
		// This allows using cache even if signature changed (e.g., fieldId changed after update)
		if (!this.applyCachedStyles(signature)) {
			// If cache doesn't work, try to load from fileUploadeds
			this.setThumbnailImage();
		}
		// Note: applyCachedStyles now handles blob URL validation internally
	}
	
	// Handle thumbnail image error (e.g., blob URL revoked)
	public onThumbnailError(event: any): void {
		const img = event.target as HTMLImageElement;
		if (!img || !img.src) {
			return;
		}
		
		// Check if it's a blob URL that failed
		if (img.src.startsWith('blob:')) {
			// Blob URL is invalid (probably revoked), try to recreate from cached Blob first
			const thumbnailFile = this.evenement.thumbnail;
			
			if (thumbnailFile && thumbnailFile.fieldId) {
				const cachedBlob = ElementEvenementComponent.blobCache.get(thumbnailFile.fieldId);
				if (cachedBlob) {
					// Try to recreate blob URL from cached Blob
					try {
						const objectUrl = this.nativeWindow.URL.createObjectURL(cachedBlob);
						const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
						// Update blob URL cache with new URL
						ElementEvenementComponent.blobUrlCache.set(thumbnailFile.fieldId, safeUrl);
						this.thumbnailUrl = safeUrl;
						// Update thumbnail cache
						this.cacheCurrentStyles(this.getThumbnailSignature());
						return; // Successfully recreated from cached Blob
					} catch (error) {
						// Failed to recreate, will reload from server below
					}
				}
				
				// Remove invalid blob URL from cache
				const currentBlobUrl = this.thumbnailUrl;
				if (currentBlobUrl && typeof currentBlobUrl === 'object' && 
					'changingThisBreaksApplicationSecurity' in currentBlobUrl) {
					const url = currentBlobUrl['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						// Remove invalid blob URL from cache (keep Blob in blobCache for potential reuse)
						ElementEvenementComponent.blobUrlCache.delete(thumbnailFile.fieldId);
						// Also remove from thumbnailCache
						const cacheKey = this.getCacheKey();
						if (cacheKey) {
							ElementEvenementComponent.thumbnailCache.delete(cacheKey);
						}
					}
				}
			}
			
			// Reset to default and reload from server
			this.thumbnailUrl = ElementEvenementComponent.getDefaultPlaceholderImage(this.sanitizer);
			// Reload thumbnail from server
			setTimeout(() => {
				this.setThumbnailImage();
			}, 100);
		}
	}
	
	public onFileSelected(event: any): void {
		const files: FileList = event.target.files;
		if (files && files.length > 0) {
			this.selectedFiles = Array.from(files);
			this.uploadFiles();
		}
	}

	private async uploadFiles(): Promise<void> {
		if (this.selectedFiles.length === 0) {
			return;
		}

		this.isUploading = true;
		this.uploadLogs = [];
		
		// Open upload logs modal
		if (this.uploadLogsModal) {
			const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
			
			// Block body scroll
			if (document.body) {
				document.body.style.overflow = 'hidden';
				document.body.style.position = 'fixed';
				document.body.style.top = `-${savedScrollY}px`;
				document.body.style.width = '100%';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = 'hidden';
			}
			
			this.uploadLogsModalRef = this.modalService.open(this.uploadLogsModal, {
				centered: true,
				backdrop: 'static',
				keyboard: false,
				size: 'xl',
				windowClass: 'upload-logs-modal'
			});
			
			// Restore scroll when modal closes
			this.uploadLogsModalRef.result.finally(() => {
				// Use requestAnimationFrame to ensure DOM updates are complete
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (document.body) {
							document.body.style.overflow = '';
							document.body.style.overflowX = '';
							document.body.style.overflowY = '';
							document.body.style.position = '';
							document.body.style.top = '';
							document.body.style.width = '';
							document.body.style.height = '';
						}
						if (document.documentElement) {
							document.documentElement.style.overflow = '';
							document.documentElement.style.overflowX = '';
							document.documentElement.style.overflowY = '';
						}
						// Remove modal-open class if Bootstrap added it
						document.body.classList.remove('modal-open');
						document.documentElement.classList.remove('modal-open');
						// Restore scroll position
						setTimeout(() => {
							window.scrollTo({
								top: savedScrollY,
								left: 0,
								behavior: 'auto'
							});
							if (document.documentElement) {
								document.documentElement.scrollTop = savedScrollY;
							}
							if (document.body) {
								document.body.scrollTop = savedScrollY;
							}
						}, 100);
					});
				});
			}).catch(() => {
				// Use requestAnimationFrame to ensure DOM updates are complete
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (document.body) {
							document.body.style.overflow = '';
							document.body.style.overflowX = '';
							document.body.style.overflowY = '';
							document.body.style.position = '';
							document.body.style.top = '';
							document.body.style.width = '';
							document.body.style.height = '';
						}
						if (document.documentElement) {
							document.documentElement.style.overflow = '';
							document.documentElement.style.overflowX = '';
							document.documentElement.style.overflowY = '';
						}
						// Remove modal-open class if Bootstrap added it
						document.body.classList.remove('modal-open');
						document.documentElement.classList.remove('modal-open');
						// Restore scroll position
						setTimeout(() => {
							window.scrollTo({
								top: savedScrollY,
								left: 0,
								behavior: 'auto'
							});
							if (document.documentElement) {
								document.documentElement.scrollTop = savedScrollY;
							}
							if (document.body) {
								document.body.scrollTop = savedScrollY;
							}
						}, 100);
					});
				});
			});
			// Force change detection after modal opens to ensure ViewChild is initialized
			setTimeout(() => {
				this.cdr.detectChanges();
			}, 100);
			
			// Clean up modal reference when it's closed
			this.uploadLogsModalRef.result.finally(() => {
				this.uploadLogsModalRef = null;
			});
		}
		
		// Generate session ID
		const sessionId = this.generateSessionId();
		
		// Initialize logs
		this.addLog(`📤 Starting upload of ${this.selectedFiles.length} file(s)...`);

		// Check if any of the selected files are images
		const imageFiles = this.selectedFiles.filter(file => this.isImageFileByMimeType(file));
		
		// Ask user if they want to compress images
		if (imageFiles.length > 0) {
			this.imageCountForModal = imageFiles.length;
			this.compressImages = true; // Reset to default
			const shouldCompress = await this.askForImageCompression(imageFiles.length);
			if (shouldCompress === null) {
				// User cancelled, stop upload
				this.isUploading = false;
				if (this.uploadLogsModalRef) {
					this.uploadLogsModalRef.close();
					this.uploadLogsModalRef = null;
				}
				return;
			}
			this.compressImages = shouldCompress;
		}
		
		// Only ask for thumbnail if there's exactly ONE file selected
		if (imageFiles.length > 0 && this.selectedFiles.length === 1) {
			// Ask user if they want to use the image as activity thumbnail
			const imageFile = imageFiles[0]; // Use first image file
			const useAsThumbnail = confirm(`Voulez-vous utiliser "${imageFile.name}" comme image de cette activité ?`);
			
			if (useAsThumbnail) {
				// Modify the filename to add "thumbnail" in the middle
				const modifiedFileName = this.addThumbnailToFileName(imageFile.name);
				
				// Create a new File object with the modified name
				const modifiedFile = new File([imageFile], modifiedFileName, { type: imageFile.type });
				
				// Replace the original file in the array
				const fileIndex = this.selectedFiles.indexOf(imageFile);
				this.selectedFiles[fileIndex] = modifiedFile;
			}
		}

		// Check for video files and ask for quality if needed
		const processedFiles: File[] = [];
		const videoFiles = this.selectedFiles.filter(file => this.isVideoFile(file.name));
		
		if (videoFiles.length > 0 && this.videoCompressionService.isSupported()) {
			// Ask user for compression quality
			const quality = await this.askForCompressionQuality(videoFiles.length);
			
			if (quality === null) {
				// User cancelled, use original files
				this.addLog(`⚠️ Compression cancelled, uploading original files`);
				processedFiles.push(...this.selectedFiles);
			} else {
				this.addLog(`🎬 Found ${videoFiles.length} video file(s) - Compressing with ${quality} quality...`);
				this.addLog(`ℹ️ Compression will continue even if you switch tabs or minimize the window.`);
				
				for (let i = 0; i < this.selectedFiles.length; i++) {
					const file = this.selectedFiles[i];
					
					if (this.isVideoFile(file.name)) {
						try {
							this.addLog(`🎥 Compressing video ${i + 1}/${videoFiles.length}: ${file.name}...`);
							
							const compressedBlob = await this.videoCompressionService.compressVideo(
								file,
								quality,
								(progress: CompressionProgress) => {
									// Ensure the callback runs in Angular zone for proper change detection
									this.ngZone.run(() => {
										// Update logs with compression progress
										this.addLog(`   ${progress.message}`);
									});
								}
							);
							
							// Check if compression actually happened (blob size should be different or format changed)
							const isAviOrMov = file.name.toLowerCase().endsWith('.avi') || file.name.toLowerCase().endsWith('.mov');
							const formatChanged = isAviOrMov && (compressedBlob.type.includes('webm') || compressedBlob.type.includes('mp4'));
							
							// If compression failed (same size and no format change for AVI/MOV), use original
							if (!formatChanged && compressedBlob.size >= file.size * 0.95) {
								// Compression didn't really happen (probably error was caught and original returned)
								this.addLog(`⚠️ Compression not available for this format. Using original file.`);
								processedFiles.push(file);
							} else {
								// Create a new File from the compressed Blob
								// Use original filename but note that format may have changed (AVI/MOV -> WebM/MP4)
								const outputFilename = (compressedBlob as any).name || file.name;
								const compressedFile = new File(
									[compressedBlob],
									outputFilename,
									{ type: compressedBlob.type || file.type }
								);
								
								processedFiles.push(compressedFile);
								
								const reduction = ((1 - compressedBlob.size / file.size) * 100).toFixed(1);
								this.addLog(`✅ Video compressed: ${this.formatFileSize(file.size)} → ${this.formatFileSize(compressedBlob.size)} (${reduction}% reduction)`);
							}
							
						} catch (error: any) {
							this.addErrorLog(`❌ Error compressing video ${file.name}: ${error.message}`);
							// Use original file if compression fails
							processedFiles.push(file);
							this.addLog(`📤 Original file will be uploaded as-is.`);
						}
					} else {
						// Non-video files: add as-is
						processedFiles.push(file);
					}
				}
			}
		} else {
			// No video files or compression not supported: use files as-is
			processedFiles.push(...this.selectedFiles);
			if (videoFiles.length > 0 && !this.videoCompressionService.isSupported()) {
				this.addLog(`⚠️ Video compression not supported in this browser, uploading original files`);
			}
		}

		const formData = new FormData();
		for (let file of processedFiles) {
			formData.append('file', file, file.name);
		}
		
		// Add sessionId to FormData
		if (sessionId) {
			formData.append('sessionId', sessionId);
		}
		
		// Add allowOriginal parameter (true if we don't want to compress images)
		// allowOriginal=true means: allow original file without compression
		// allowOriginal=false (default) means: compress images
		if (imageFiles.length > 0) {
			formData.append('allowOriginal', (!this.compressImages).toString());
		}

		// Build the correct upload URL with user ID and event ID
		const uploadUrl = `${this.API_URL4FILE}/${this.user.id}/${this.evenement.id}`;

		// Clear any existing poll interval
		if (this.pollIntervalId) {
			clearInterval(this.pollIntervalId);
			this.pollIntervalId = null;
		}
		
		// Start polling for server logs
		let lastLogCount = 0;
		this.pollIntervalId = setInterval(() => {
			const logSubscription = this._fileService.getUploadLogs(sessionId).subscribe(
				(serverLogs: string[]) => {
					// Ensure the callback runs in Angular zone for proper change detection
					this.ngZone.run(() => {
						if (serverLogs.length > lastLogCount) {
							// New logs available
							for (let i = lastLogCount; i < serverLogs.length; i++) {
								this.addLog(serverLogs[i]);
							}
							lastLogCount = serverLogs.length;
						}
					});
				},
				(error: any) => {
					console.error('Error fetching logs:', error);
				}
			);
			this.allSubscriptions.push(logSubscription);
		}, 500); // Poll every 500ms

		const uploadSubscription = this._fileService.postFileToUrl(formData, this.user, uploadUrl, sessionId)
			.subscribe({
				next: (response: any) => {
					
					// Wait a bit for final logs
						const cleanupTimeout = setTimeout(() => {
							if (this.pollIntervalId) {
								clearInterval(this.pollIntervalId);
								this.pollIntervalId = null;
							}
							
							const fileCount = Array.isArray(response) ? response.length : 1;
							this.addSuccessLog(`✅ Upload successful! ${fileCount} file(s) processed`);
							
							// The response should contain the uploaded file information directly
							this.handleUploadResponse(response);
							
							// Clear selected files
							this.selectedFiles = [];
							// Reset file input for this specific event
							const fileInput = document.querySelector(`input[id="file-upload-input-${this.evenement.id}"]`) as HTMLInputElement;
							if (fileInput) {
								fileInput.value = '';
							}
							
							const refreshTimeout = setTimeout(() => {
								this.isUploading = false;
								// Don't close modal automatically, let user close it manually
							}, 1000);
							this.activeTimeouts.add(refreshTimeout);
							setTimeout(() => this.activeTimeouts.delete(refreshTimeout), 1100);
						}, 500);
						this.activeTimeouts.add(cleanupTimeout);
						setTimeout(() => this.activeTimeouts.delete(cleanupTimeout), 600);
				},
				error: (error: any) => {
					console.error('File upload error:', error);
					if (this.pollIntervalId) {
						clearInterval(this.pollIntervalId);
						this.pollIntervalId = null;
					}
					
					let errorMessage = "Error uploading files.";
					
					if (error.status === 0) {
						errorMessage = "Unable to connect to server. Please check that the backend service is running.";
					} else if (error.status === 401) {
						errorMessage = "Authentication failed. Please log in again.";
					} else if (error.status === 403) {
						errorMessage = "Access denied. You don't have permission to upload files.";
					} else if (error.status >= 500) {
						errorMessage = "Server error. Please try again later.";
					} else if (error.error && error.error.message) {
						errorMessage = error.error.message;
					}
					
					this.addErrorLog(`❌ Upload error: ${errorMessage}`);
					
					const errorTimeout = setTimeout(() => {
						this.isUploading = false;
						// Don't close modal automatically, let user close it manually
					}, 1000);
					this.activeTimeouts.add(errorTimeout);
					setTimeout(() => this.activeTimeouts.delete(errorTimeout), 1100);
				}
			});
		this.allSubscriptions.push(uploadSubscription);
	}

	private addLog(message: string): void {
		this.uploadLogs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
		
		// Force change detection to update the view immediately
		this.cdr.detectChanges();
		
		// Auto-scroll to top to show latest log
		setTimeout(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		}, 0);
	}

	private formatFileSize(bytes: number): string {
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	/**
	 * Ask user for video compression quality
	 */
	private askForCompressionQuality(videoCount: number): Promise<'low' | 'medium' | 'high' | 'very-high' | 'original' | null> {
		return new Promise((resolve) => {
			this.selectedCompressionQuality = 'very-high'; // Default to very high quality
			this.videoCountForModal = videoCount; // Store for template
			
			if (this.qualitySelectionModal) {
				const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
				
				// Block body scroll
				if (document.body) {
					document.body.style.overflow = 'hidden';
					document.body.style.position = 'fixed';
					document.body.style.top = `-${savedScrollY}px`;
					document.body.style.width = '100%';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = 'hidden';
				}
				
				this.qualityModalRef = this.modalService.open(this.qualitySelectionModal, {
					centered: true,
					backdrop: 'static',
					keyboard: false,
					size: 'md',
					windowClass: 'compression-quality-modal'
				});
				
				// Restore scroll when modal closes
				this.qualityModalRef.result.finally(() => {
					if (document.body) {
						document.body.style.overflow = '';
						document.body.style.position = '';
						document.body.style.top = '';
						document.body.style.width = '';
					}
					if (document.documentElement) {
						document.documentElement.style.overflow = '';
					}
					window.scrollTo(0, savedScrollY);
				}).catch(() => {
					if (document.body) {
						document.body.style.overflow = '';
						document.body.style.position = '';
						document.body.style.top = '';
						document.body.style.width = '';
					}
					if (document.documentElement) {
						document.documentElement.style.overflow = '';
					}
					window.scrollTo(0, savedScrollY);
				});

				// Handle result
				this.qualityModalRef.result.then(
					(result: 'low' | 'medium' | 'high' | 'very-high' | 'original') => {
						this.qualityModalRef = null;
						resolve(result);
					},
					() => {
						this.qualityModalRef = null;
						resolve(null); // User dismissed
					}
				);
			} else {
				// Fallback to simple prompt
				const choice = prompt(
					`Choisissez la qualité de compression pour ${videoCount} vidéo(s):\n` +
					`1. Basse (petite taille)\n` +
					`2. Moyenne (taille moyenne)\n` +
					`3. Haute (grande taille)\n` +
					`4. Très haute (qualité élevée, peu de compression)\n` +
					`5. Originale (pas de compression, qualité maximale)\n\n` +
					`Entrez 1, 2, 3, 4 ou 5:`
				);
				
				if (choice === '1') resolve('low');
				else if (choice === '2') resolve('medium');
				else if (choice === '3') resolve('high');
				else if (choice === '4') resolve('very-high');
				else if (choice === '5') resolve('original');
				else resolve(null);
			}
		});
	}

	public confirmQualitySelection(): void {
		if (this.qualityModalRef) {
			this.qualityModalRef.close(this.selectedCompressionQuality);
		}
	}

	public cancelQualitySelection(): void {
		if (this.qualityModalRef) {
			this.qualityModalRef.dismiss();
		}
	}
	
	private askForImageCompression(imageCount: number): Promise<boolean | null> {
		return new Promise((resolve) => {
			this.compressImages = true; // Default to compression enabled
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
						resolve(null); // dismissed
					}
				);
			} else {
				// Fallback
				const choice = confirm(
					this.translateService.instant('EVENTELEM.IMAGE_COMPRESSION_QUESTION', { count: imageCount })
				);
				resolve(choice);
			}
		});
	}

	public confirmImageCompression(): void {
		if (this.imageCompressionModalRef) {
			this.imageCompressionModalRef.close(this.compressImages);
		}
	}

	public cancelImageCompression(): void {
		if (this.imageCompressionModalRef) {
			this.imageCompressionModalRef.dismiss();
		}
	}

	private addSuccessLog(message: string): void {
		this.uploadLogs.unshift(`SUCCESS: [${new Date().toLocaleTimeString()}] ${message}`);
		
		// Force change detection to update the view immediately
		this.cdr.detectChanges();
		
		// Auto-scroll to top to show latest log
		const scrollTimeout = setTimeout(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		}, 0);
		this.activeTimeouts.add(scrollTimeout);
		setTimeout(() => this.activeTimeouts.delete(scrollTimeout), 100);
	}

	private addErrorLog(message: string): void {
		this.uploadLogs.unshift(`ERROR: [${new Date().toLocaleTimeString()}] ${message}`);
		
		// Force change detection to update the view immediately
		this.cdr.detectChanges();
		
		// Auto-scroll to top to show latest log
		const scrollTimeout = setTimeout(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		}, 0);
		this.activeTimeouts.add(scrollTimeout);
		setTimeout(() => this.activeTimeouts.delete(scrollTimeout), 100);
	}

	private generateSessionId(): string {
		return 'upload-' + Date.now() + '-' + Math.random().toString(36).substring(7);
	}

	public closeUploadLogsModal(): void {
		if (this.uploadLogsModalRef) {
			this.uploadLogsModalRef.close();
			this.uploadLogsModalRef = null;
		}
	}

	private handleUploadResponse(response: any): void {
		try {
			// The response from database upload should contain the uploaded file information
			if (response && Array.isArray(response)) {
				// Response is directly an array of uploaded files
				this.addUploadedFilesToEvent(response);
			} else if (response && (response.uploadedFiles || response.files)) {
				// Response contains uploaded files in a property
				const uploadedFiles = response.uploadedFiles || response.files;
				this.addUploadedFilesToEvent(uploadedFiles);
			} else if (response && response.fieldId) {
				// Response is a single uploaded file object
				this.addUploadedFilesToEvent([response]);
			} else {
				// Fallback: create uploaded file entries based on selected files
				this.createUploadedFileEntries();
			}
		} catch (error) {
			console.error('Error processing upload response:', error);
			// Fallback: create uploaded file entries based on selected files
			this.createUploadedFileEntries();
		}
	}

	private addUploadedFilesToEvent(uploadedFilesData: any[]): void {
		// CRITICAL FIX: After logout/login, the event object might have an outdated fileUploadeds array.
		// Instead of just adding new files to the local array (which could be incomplete), 
		// we need to reload the event from the server to ensure we have the complete file list.
		// This prevents the issue where uploading a file after login would overwrite existing files
		// when the event is saved (because the local fileUploadeds array was incomplete).
		
		if (!this.evenement || !this.evenement.id) {
			console.error('Cannot reload event: event or event.id is missing');
			return;
		}
		
		// Reload the event from the server to get the complete fileUploadeds array
		// This ensures we have all files, not just the ones that were in the local (potentially outdated) array
		this._evenementsService.getEvenement(this.evenement.id).subscribe({
			next: (updatedEvent: Evenement) => {
				// Update the local event object with the fresh data from the server
				// This ensures fileUploadeds contains ALL files, including the newly uploaded ones
				Object.assign(this.evenement, updatedEvent);
				
				console.log(`Event reloaded after upload. Total files: ${this.evenement.fileUploadeds?.length || 0}`);
				
				// Check if any of the uploaded files is a thumbnail
				let hasThumbnailFile = false;
				let thumbnailFile: UploadedFile | null = null;
				
				for (let fileData of uploadedFilesData) {
					const uploadedFile = new UploadedFile(
						fileData.fieldId || fileData.id || this.generateFileId(),
						fileData.fileName || fileData.name,
						fileData.fileType || fileData.type || 'unknown',
						this.user
					);
					
					// Check if this file contains "thumbnail" in its name
					if (uploadedFile.fileName && uploadedFile.fileName.toLowerCase().includes('thumbnail')) {
						hasThumbnailFile = true;
						thumbnailFile = uploadedFile;
					}
				}
				
				// If a thumbnail file was uploaded, ensure it's set as thumbnail
				if (hasThumbnailFile && thumbnailFile) {
					// The backend should have already set the thumbnail, but verify it's correct
					if (!this.evenement.thumbnail || this.evenement.thumbnail.fieldId !== thumbnailFile.fieldId) {
						this.evenement.thumbnail = thumbnailFile;
					}
					
					// Force reload of the card with the new thumbnail
					setTimeout(() => {
						this.invalidateThumbnailCache();
						this.reloadEventCard();
					}, 100);
				}
				
				// Emit update to parent component to refresh the view
				this.updateEvenement.emit(this.evenement);
			},
			error: (error) => {
				console.error('Error reloading event after upload:', error);
				// Fallback: at least add the new files to the local array
				// This is not ideal but better than losing the new files
				if (!this.evenement.fileUploadeds) {
					this.evenement.fileUploadeds = [];
				}
				
				for (let fileData of uploadedFilesData) {
					const uploadedFile = new UploadedFile(
						fileData.fieldId || fileData.id || this.generateFileId(),
						fileData.fileName || fileData.name,
						fileData.fileType || fileData.type || 'unknown',
						this.user
					);
					
					const existingFile = this.evenement.fileUploadeds.find(f => f.fieldId === uploadedFile.fieldId);
					if (!existingFile) {
						this.evenement.fileUploadeds.push(uploadedFile);
					}
				}
				
				this.updateEvenement.emit(this.evenement);
			}
		});
	}

	private createUploadedFileEntries(): void {
		// Fallback method: create uploaded file entries based on selected files
		// CRITICAL FIX: Same issue as addUploadedFilesToEvent - need to reload from server
		// to ensure we have the complete fileUploadeds array after logout/login
		
		if (!this.evenement || !this.evenement.id) {
			console.error('Cannot reload event: event or event.id is missing');
			return;
		}
		
		// Reload the event from the server to get the complete fileUploadeds array
		this._evenementsService.getEvenement(this.evenement.id).subscribe({
			next: (updatedEvent: Evenement) => {
				// Update the local event object with the fresh data from the server
				Object.assign(this.evenement, updatedEvent);
				
				console.log(`Event reloaded after upload (fallback). Total files: ${this.evenement.fileUploadeds?.length || 0}`);
				
				// Check if any of the selected files is a thumbnail
				let hasThumbnailFile = false;
				for (let file of this.selectedFiles) {
					if (file.name && file.name.toLowerCase().includes('thumbnail')) {
						hasThumbnailFile = true;
						break;
					}
				}
				
				// If a thumbnail file was uploaded, reload the card
				if (hasThumbnailFile) {
					setTimeout(() => {
						this.invalidateThumbnailCache();
						this.reloadEventCard();
					}, 100);
				}
				
				// Emit update to parent component
				this.updateEvenement.emit(this.evenement);
			},
			error: (error) => {
				console.error('Error reloading event after upload (fallback):', error);
				// Fallback: at least try to add files based on selected files
				// This is not ideal but better than nothing
				if (!this.evenement.fileUploadeds) {
					this.evenement.fileUploadeds = [];
				}
				
				for (let file of this.selectedFiles) {
					const uploadedFile = new UploadedFile(
						this.generateFileId(),
						file.name,
						file.type || 'unknown',
						this.user
					);
					
					const existingFile = this.evenement.fileUploadeds.find(f => f.fileName === uploadedFile.fileName);
					if (!existingFile) {
						this.evenement.fileUploadeds.push(uploadedFile);
					}
				}
				
				this.updateEvenement.emit(this.evenement);
			}
		});
	}

	private generateFileId(): string {
		// Generate a unique file ID (you might want to use a proper UUID generator)
		return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
	}
	// Load thumbnail image from server (extracted for queue processing)
	private loadThumbnailImage(fieldId: string, fileName: string | undefined): void {
		// Load and cache the blob URL
		this._fileService.getFile(fieldId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				// Only cache blobs for files with "thumbnail" in the name
				// Store the Blob in cache for potential recreation later (only for thumbnails)
				if (fileName && fileName.toLowerCase().includes('thumbnail')) {
					ElementEvenementComponent.blobCache.set(fieldId, blob);
				}
				let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
				return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
			})
		).subscribe({
			next: (safeUrl: SafeUrl) => {
				// Mark as no longer loading
				ElementEvenementComponent.clearFileLoading(fieldId);
				// Track thumbnail blob URL creation time (not display time - that's tracked in detectDominantColor)
				this.thumbnailLoadEndTime = performance.now();
				// Cache the blob URL so it persists across component destruction
				ElementEvenementComponent.blobUrlCache.set(fieldId, safeUrl);
				this.thumbnailUrl = safeUrl;
				// Update thumbnail cache with new data
				this.cacheCurrentStyles(this.getThumbnailSignature());
				// Emit card ready event for immediate change detection
				this.emitCardReady();
				// Detect dominant color after image loads (this will track when image actually displays)
				const colorTimeout = setTimeout(() => {
					this.detectDominantColor();
				}, 100);
				this.activeTimeouts.add(colorTimeout);
				setTimeout(() => this.activeTimeouts.delete(colorTimeout), 200);
				
				// Notify queue that this image load is complete
				ElementEvenementComponent.onImageLoadComplete();
			},
			error: (error) => {
				// Mark as no longer loading even on error
				ElementEvenementComponent.clearFileLoading(fieldId);
				// Try to use cached thumbnail as fallback
				this.tryUseCachedThumbnailFallback();
				
				// Notify queue that this image load is complete (even on error)
				ElementEvenementComponent.onImageLoadComplete();
			}
		});
	}

	// Set image thumbnail - USE GETFILE for display (with resizing)
	public setThumbnailImage() {
		// Reset portrait detection when thumbnail changes
		this.isThumbnailPortrait = false;
		this.thumbnailImageWidth = 0;
		this.thumbnailDisplayedWidth = 0;
		this.photoFrameStylesCache = null;
		
		const signature = this.getThumbnailSignature();
		if (this.applyCachedStyles(signature)) {
			return;
		}

		// Use the thumbnail field directly (set when file with "thumbnail" in name is uploaded)
		const thumbnailFile = this.evenement.thumbnail;
		
		if (thumbnailFile && thumbnailFile.fieldId) {
			// Check if already cached in shared cache (to avoid duplicate backend request)
			if (ElementEvenementComponent.isThumbnailCached(thumbnailFile.fieldId)) {
				const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(thumbnailFile.fieldId);
				if (cachedThumbnail) {
					// Track thumbnail blob URL creation time (not display time - that's tracked in detectDominantColor)
					this.thumbnailLoadEndTime = performance.now();
					// Reuse cached thumbnail
					this.thumbnailUrl = cachedThumbnail;
					// Update thumbnail cache to ensure it's up to date
					this.cacheCurrentStyles(this.getThumbnailSignature());
					// Emit card ready event for immediate change detection
					this.emitCardReady();
					// Detect dominant color after image loads (this will track when image actually displays)
					const colorTimeout = setTimeout(() => {
						this.detectDominantColor();
					}, 100);
					this.activeTimeouts.add(colorTimeout);
					setTimeout(() => this.activeTimeouts.delete(colorTimeout), 200);
					return; // Use cached thumbnail
				}
			}
			
			// Check if file is currently being loaded (to prevent duplicate concurrent requests)
			if (ElementEvenementComponent.isFileLoading(thumbnailFile.fieldId) || this.fileThumbnailsLoading.has(thumbnailFile.fieldId)) {
				// File is already being loaded, wait for it to complete
				// We'll set up a listener or just return and let the other load complete
				// The thumbnail will be updated when the other load completes
				return;
			}
			
			// Check if we have the Blob in cache but URL was revoked
			const cachedBlob = ElementEvenementComponent.blobCache.get(thumbnailFile.fieldId);
			if (cachedBlob) {
				// Recreate blob URL from cached Blob
				try {
					// Track thumbnail blob URL creation time (not display time - that's tracked in detectDominantColor)
					this.thumbnailLoadEndTime = performance.now();
					const objectUrl = this.nativeWindow.URL.createObjectURL(cachedBlob);
					const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
					// Update both caches
					ElementEvenementComponent.blobUrlCache.set(thumbnailFile.fieldId, safeUrl);
					this.thumbnailUrl = safeUrl;
					// Update thumbnail cache with new data
					this.cacheCurrentStyles(this.getThumbnailSignature());
					// Emit card ready event for immediate change detection
					this.emitCardReady();
					// Detect dominant color after image loads (this will track when image actually displays)
					const colorTimeout = setTimeout(() => {
						this.detectDominantColor();
					}, 100);
					this.activeTimeouts.add(colorTimeout);
					setTimeout(() => this.activeTimeouts.delete(colorTimeout), 200);
					return; // Successfully recreated from cached Blob
				} catch (error) {
					// Continue to load from server below
				}
			}
			
			// Mark as loading to prevent duplicate requests
			ElementEvenementComponent.setFileLoading(thumbnailFile.fieldId);
			
			// Queue image loading to prevent all 8 cards from loading simultaneously
			// This ensures cards render immediately while images load progressively
			ElementEvenementComponent.enqueueImageLoad(() => {
				this.loadThumbnailImage(thumbnailFile.fieldId, thumbnailFile.fileName);
			});
			return; // Exit early, image will load via queue
		} else {
			// fileUploadeds is empty or not populated yet - try to use cached thumbnail
			// This can happen when coming back from update before fileUploadeds is populated
			const cacheKey = this.getCacheKey();
			if (cacheKey) {
				const cached = ElementEvenementComponent.thumbnailCache.get(cacheKey);
				if (cached && cached.thumbnailUrl && cached.thumbnailUrl !== "assets/images/images.jpg") {
					// Try to use cached thumbnail if available
					if (typeof cached.thumbnailUrl === 'object' && 
						'changingThisBreaksApplicationSecurity' in cached.thumbnailUrl) {
						const url = cached.thumbnailUrl['changingThisBreaksApplicationSecurity'];
						if (url && typeof url === 'string' && url.startsWith('blob:')) {
							// Check if blob URL exists in cache
							for (const blobUrl of ElementEvenementComponent.blobUrlCache.values()) {
								if (blobUrl === cached.thumbnailUrl) {
									this.thumbnailUrl = blobUrl;
									this.dominantR = cached.dominant.r;
									this.dominantG = cached.dominant.g;
									this.dominantB = cached.dominant.b;
									this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
									this.titleBackgroundColor = cached.titleBackground;
									this.titleBorderColor = cached.titleBorder;
									this.descriptionBackgroundColor = cached.descriptionBackground;
									this.invalidateColorCaches();
									this.emitDominantColor();
									// Emit card ready event for immediate change detection
									this.emitCardReady();
									return; // Successfully used cached thumbnail
								}
							}
						} else {
							// Not a blob URL, use it directly
							this.thumbnailUrl = cached.thumbnailUrl;
							this.dominantR = cached.dominant.r;
							this.dominantG = cached.dominant.g;
							this.dominantB = cached.dominant.b;
							this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
							this.titleBackgroundColor = cached.titleBackground;
							this.titleBorderColor = cached.titleBorder;
							this.descriptionBackgroundColor = cached.descriptionBackground;
							this.invalidateColorCaches();
							this.emitDominantColor();
							// Emit card ready event for immediate change detection
							this.emitCardReady();
							return;
						}
					}
				}
			}
			
			// Reset to default color if no thumbnail found and no cached version available
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			// Use unified inverse text color for default (medium brightness = bright, so dark text)
			this.titleBorderColor = 'rgba(2, 6, 23, 0.95)';
			this.descriptionBackgroundColor = 'rgba(255, 255, 255, 1)';
			this.calculatedRgbValues = 'RGB(255, 255, 255)';
			this.dominantR = 128;
			this.dominantG = 128;
			this.dominantB = 128;
			this.invalidateColorCaches();
			this.emitDominantColor();
			this.cacheCurrentStyles(signature);
		}
	}
	
	// Try to use cached thumbnail as fallback when thumbnail file can't be loaded
	private tryUseCachedThumbnailFallback(): void {
		const cacheKey = this.getCacheKey();
		if (cacheKey) {
			const cached = ElementEvenementComponent.thumbnailCache.get(cacheKey);
			if (cached && cached.thumbnailUrl && cached.thumbnailUrl !== "assets/images/images.jpg") {
				// Check if cached blob URL is still valid by looking for it in blobUrlCache
				if (typeof cached.thumbnailUrl === 'object' && 
					'changingThisBreaksApplicationSecurity' in cached.thumbnailUrl) {
					const url = cached.thumbnailUrl['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						// Look for matching blob URL in cache
						for (const blobUrl of ElementEvenementComponent.blobUrlCache.values()) {
							if (blobUrl === cached.thumbnailUrl) {
								this.thumbnailUrl = blobUrl;
								this.dominantR = cached.dominant.r;
								this.dominantG = cached.dominant.g;
								this.dominantB = cached.dominant.b;
								this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
								this.titleBackgroundColor = cached.titleBackground;
								this.titleBorderColor = cached.titleBorder;
								this.descriptionBackgroundColor = cached.descriptionBackground;
								this.invalidateColorCaches();
								this.emitDominantColor();
								// Emit card ready event for immediate change detection
								this.emitCardReady();
								return; // Successfully used cached thumbnail
							}
						}
					}
				}
			}
		}
	}

	// Detect dominant color from the top portion of the thumbnail image
	public detectDominantColor(): void {
		// This is called when the image load event fires, so the image is now displayed
		// Track thumbnail image display time (when image actually shows)
		if (this.thumbnailImageLoadEndTime === 0) {
			this.thumbnailImageLoadEndTime = performance.now();
			// Emit card ready event when image actually loads - this ensures parent knows card is visible
			this.emitCardReady();
		}
		
		// Track color detection start time
		if (this.colorDetectionStartTime === 0) {
			this.colorDetectionStartTime = performance.now();
		}
		
		// Perform color calculation asynchronously to avoid blocking card rendering
		// Small delay ensures image is in DOM, calculation is already optimized and non-blocking
		setTimeout(() => {
			this.performColorCalculation();
		}, 10);
	}

	// Enqueue image loading to prevent all cards from loading simultaneously
	private static enqueueImageLoad(loadFn: () => void): void {
		ElementEvenementComponent.imageLoadingQueue.push(loadFn);
		ElementEvenementComponent.processImageQueue();
	}

	// Process image loading queue (load 2 images at a time to balance speed and performance)
	private static processImageQueue(): void {
		// If already at max concurrent loads or queue is empty, return
		if (ElementEvenementComponent.currentImageLoads >= ElementEvenementComponent.MAX_CONCURRENT_IMAGE_LOADS || 
			ElementEvenementComponent.imageLoadingQueue.length === 0) {
			return;
		}

		// Process next image load
		const loadFn = ElementEvenementComponent.imageLoadingQueue.shift();
		if (loadFn) {
			ElementEvenementComponent.currentImageLoads++;
			
			// Execute the image load
			try {
				loadFn();
			} catch (error) {
				console.error('Error in image loading queue:', error);
				ElementEvenementComponent.currentImageLoads--;
				// Process next item
				setTimeout(() => ElementEvenementComponent.processImageQueue(), 0);
			}
		}
	}

	// Called when an image load completes (success or error)
	public static onImageLoadComplete(): void {
		ElementEvenementComponent.currentImageLoads = Math.max(0, ElementEvenementComponent.currentImageLoads - 1);
		// Process next image in queue
		setTimeout(() => ElementEvenementComponent.processImageQueue(), 50);
	}

	// Perform the actual color calculation
	private performColorCalculation(): void {
		// Small delay to ensure image is in DOM
		setTimeout(() => {
			if (!this.thumbnailImageRef || !this.thumbnailImageRef.nativeElement) {
				return;
			}

			const img = this.thumbnailImageRef.nativeElement;
			
			// Check if image is loaded
			if (!img.complete || img.naturalWidth === 0) {
				// Wait for image to load - use addEventListener instead of onload for proper cleanup
				const loadHandler = () => {
					if (this.thumbnailImageRef?.nativeElement) { // Check component still exists
						// Detect portrait orientation
						this.detectPortraitOrientation(img);
						this.processImageColor(img);
						// Track color detection end time
						this.colorDetectionEndTime = performance.now();
						// Emit card ready when image actually loads
						if (this.thumbnailImageLoadEndTime === 0) {
							this.thumbnailImageLoadEndTime = performance.now();
							this.emitCardReady();
						}
					}
					// Remove listener after use
					img.removeEventListener('load', loadHandler);
					const index = this.imageLoadHandlers.findIndex(h => h.element === img && h.handler === loadHandler);
					if (index > -1) {
						this.imageLoadHandlers.splice(index, 1);
					}
				};
				img.addEventListener('load', loadHandler, { once: true });
				// Track handler for cleanup
				if (!this.imageLoadHandlers) {
					this.imageLoadHandlers = [];
				}
				this.imageLoadHandlers.push({ element: img, handler: loadHandler });
				return;
			}

			// Detect portrait orientation
			this.detectPortraitOrientation(img);
			this.processImageColor(img);
			// Track color detection end time
			this.colorDetectionEndTime = performance.now();
		}, 10); // Small delay to ensure image is in DOM
	}

	// Detect if thumbnail image is portrait and store dimensions
	private detectPortraitOrientation(img: HTMLImageElement): void {
		if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) {
			this.isThumbnailPortrait = false;
			this.thumbnailImageWidth = 0;
			this.thumbnailDisplayedWidth = 0;
			// Invalidate frame styles cache to recalculate
			this.photoFrameStylesCache = null;
			return;
		}

		// Check if image is portrait (height > width)
		const isPortrait = img.naturalHeight > img.naturalWidth;
		const imageWidth = img.naturalWidth;
		
		// Get displayed width after a short delay to ensure image is laid out
		setTimeout(() => {
			if (img.offsetWidth > 0) {
				const displayedWidth = img.offsetWidth;
				if (this.thumbnailDisplayedWidth !== displayedWidth) {
					this.thumbnailDisplayedWidth = displayedWidth;
					// Invalidate frame styles cache to recalculate with actual displayed width
					this.photoFrameStylesCache = null;
				}
			}
		}, 100);
		
		// Only update if orientation changed
		if (this.isThumbnailPortrait !== isPortrait || this.thumbnailImageWidth !== imageWidth) {
			this.isThumbnailPortrait = isPortrait;
			this.thumbnailImageWidth = imageWidth;
			// Invalidate frame styles cache to recalculate with new dimensions
			this.photoFrameStylesCache = null;
		}
	}

	// Detect dominant color from the current slideshow image
	public detectDominantColorFromSlideshow(): void {
		// This is called when the card slide image load event fires, so the image is now displayed
		// Track card slideshow image display time
		if (this.currentCardSlideIndex >= 0 && this.currentCardSlideIndex < this.cardSlideFileNames.length) {
			const currentFileName = this.cardSlideFileNames[this.currentCardSlideIndex];
			// Find the load time entry for this image
			this.cardSlideshowLoadTimes.forEach((value, fileId) => {
				if (value.fileName === currentFileName && !value.displayed) {
					value.end = performance.now();
					value.displayed = true;
				}
			});
		}
		
		// Wait a bit for the image to be in the DOM
		setTimeout(() => {
			if (!this.cardSlideImageRef || !this.cardSlideImageRef.nativeElement) {
				return;
			}

			const img = this.cardSlideImageRef.nativeElement;
			
			// Check if image is loaded
			if (!img.complete || img.naturalWidth === 0) {
				// Use addEventListener instead of onload for proper cleanup
				const loadHandler = () => {
					if (this.cardSlideImageRef?.nativeElement) { // Check component still exists
						this.processImageColor(img);
					}
					// Remove listener after use
					img.removeEventListener('load', loadHandler);
					const index = this.imageLoadHandlers.findIndex(h => h.element === img && h.handler === loadHandler);
					if (index > -1) {
						this.imageLoadHandlers.splice(index, 1);
					}
				};
				img.addEventListener('load', loadHandler, { once: true });
				// Track handler for cleanup
				this.imageLoadHandlers.push({ element: img, handler: loadHandler });
				return;
			}

			this.processImageColor(img);
		}, 200);
	}
	
	private emitDominantColor(): void {
		const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value ?? 0)));
		const eventKey = this.evenement ? (this.evenement.id || this.evenement.evenementName || '') : '';

		if (!eventKey) {
			return;
		}

		const color = {
			r: clamp(this.dominantR),
			g: clamp(this.dominantG),
			b: clamp(this.dominantB)
		};

		// Store color in service for details-evenement to use
		if (this.evenement?.id) {
			this.eventColorService.setEventColor(this.evenement.id, color);
		}

		this.colorComputed.emit({
			eventId: eventKey,
			color: color
		});
	}


	private invalidateColorCaches(): void {
		this.solidColorCache.clear();
		this.buttonGradientCache.clear();
		this.fileBadgeColorCache.clear();
		this.fileBadgeTextColorCache.clear();
		this.fileBadgeComponentsCache.clear();
		this.photoFrameStylesCache = null;
		this.photoImageStylesCache = null;
		this.photoBorderColorCache = null;
		this.cardBackgroundGradientCache = null;
		this.filesListGradientCache = null;
		this.statusBadgeGradientCache = null;
		this.visibilityBadgeGradientCache = null;
		this.downloadAllButtonGradientCache = null;
		this.ratingBadgeGradientCache = null;
		this.footerButtonStylesCache.clear();
	}

	// Process image to extract dominant color from top portion or full image
	// Made async to prevent blocking the main thread
	private processImageColor(img: HTMLImageElement): void {
		// Process immediately since we're already in the queue (one at a time)
		// No need for additional deferring as queue handles sequencing
		this.processImageColorSync(img);
	}

	// Synchronous color processing (called after deferring to avoid blocking)
	private processImageColorSync(img: HTMLImageElement): void {
		try {
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			
			if (!ctx) {
				return;
			}

			// Optimize: Limit canvas size to reduce processing time significantly
			// Use max 200px width/height for color calculation (more than sufficient for accurate color)
			// Smaller = much faster processing, especially for large images
			const maxSize = 200;
			const imgWidth = img.naturalWidth || img.width;
			const imgHeight = img.naturalHeight || img.height;
			
			let canvasWidth = imgWidth;
			let canvasHeight = imgHeight;
			
			// Scale down if image is too large (most images will be scaled down)
			if (imgWidth > maxSize || imgHeight > maxSize) {
				const scale = Math.min(maxSize / imgWidth, maxSize / imgHeight);
				canvasWidth = Math.floor(imgWidth * scale);
				canvasHeight = Math.floor(imgHeight * scale);
			}

			// Set canvas size (smaller = faster processing)
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;

			// Draw image to canvas (scaled down for faster processing)
			ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

			// Get image data from canvas
			const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
			const pixels = imageData.data;

			// Process pixels in chunks to avoid blocking
			this.processPixelsChunked(pixels);
		} catch (error) {
			console.error('Error detecting dominant color:', error);
			// Fallback to default color
			this.setDefaultColors();
		}
	}

	// Process pixels in chunks to avoid blocking the main thread
	private processPixelsChunked(pixels: Uint8ClampedArray): void {
		const chunkSize = 50000; // Process 50k pixels at a time
		let r = 0, g = 0, b = 0;
		let pixelCount = 0;
		let i = 0;
		
		// Sample every 20th pixel for better performance (RGBA = 4 bytes, so i += 80)
		// With 200px max canvas, this samples ~1000 pixels which is more than enough for accurate color
		const pixelStep = 80; // Every 20th pixel (20 * 4 bytes RGBA)
		
		const processChunk = () => {
			const end = Math.min(i + chunkSize, pixels.length);
			
			// Sample pixels with larger step for faster processing
			for (; i < end; i += pixelStep) {
				r += pixels[i];
				g += pixels[i + 1];
				b += pixels[i + 2];
				pixelCount++;
			}
			
			if (i < pixels.length) {
				// More to process: schedule next chunk with minimal delay
				setTimeout(processChunk, 0);
			} else {
				// Done: calculate final colors
				this.finalizeColorCalculation(r, g, b, pixelCount);
			}
		};
		
		// Start processing
		if (pixels.length < chunkSize * 2) {
			// Small image: process immediately
			for (i = 0; i < pixels.length; i += pixelStep) {
				r += pixels[i];
				g += pixels[i + 1];
				b += pixels[i + 2];
				pixelCount++;
			}
			this.finalizeColorCalculation(r, g, b, pixelCount);
		} else {
			// Large image: process in chunks
			processChunk();
		}
	}

	// Finalize color calculation and update component
	private finalizeColorCalculation(r: number, g: number, b: number, pixelCount: number): void {
		if (pixelCount > 0) {
			r = Math.floor(r / pixelCount);
			g = Math.floor(g / pixelCount);
			b = Math.floor(b / pixelCount);
			
			// Store RGB values for gradient calculations
			this.dominantR = r;
			this.dominantG = g;
			this.dominantB = b;

			// Store RGB values as string
			this.calculatedRgbValues = `RGB(${r}, ${g}, ${b})`;

			// Use the dominant color with 60% opacity for background
			this.titleBackgroundColor = `rgba(${r}, ${g}, ${b}, 0.6)`;
			
			// Calculate brightness to determine base color for text and border
			// Using luminance formula: 0.299*R + 0.587*G + 0.114*B
			const brightness = (0.299 * r + 0.587 * g + 0.114 * b);
			
			const bgAlpha = brightness > 150 ? 0.72 : 0.68;
			this.descriptionBackgroundColor = this.buildColorString(
				this.adjustColorComponent(r, -22),
				this.adjustColorComponent(g, -22),
				this.adjustColorComponent(b, -22),
				bgAlpha
			);

			// Use unified inverse text color logic based on dominant color brightness
			const dominantBrightness = this.getColorBrightness(this.dominantR, this.dominantG, this.dominantB);
			const isBright = dominantBrightness > 175;
			if (isBright) {
				// Dark text for bright background: #020617 -> rgba(2, 6, 23, 0.95)
				this.titleBorderColor = 'rgba(2, 6, 23, 0.95)';
			} else {
				// Light gray text for dark background: #e8e8e8 -> rgba(232, 232, 232, 0.95)
				this.titleBorderColor = 'rgba(232, 232, 232, 0.95)';
			}
		}
		
		this.invalidateColorCaches();
		this.emitDominantColor();
		this.cacheCurrentStyles(this.getThumbnailSignature());
	}

	// Set default colors (fallback)
	private setDefaultColors(): void {
		this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
		this.descriptionBackgroundColor = 'rgba(255, 255, 255, 1)';
		// Use unified inverse text color for default (medium brightness = bright, so dark text)
		this.titleBorderColor = 'rgba(2, 6, 23, 0.95)';
		this.dominantR = 128;
		this.dominantG = 128;
		this.dominantB = 128;
		this.invalidateColorCaches();
		this.emitDominantColor();
		this.cacheCurrentStyles();
	}

	private buildColorString(r: number, g: number, b: number, alpha: number = 1): string {
		const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
		const clampedAlpha = Math.max(0, Math.min(1, alpha));
		return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${clampedAlpha})`;
	}

	private getCacheKey(): string | null {
		if (!this.evenement) {
			return null;
		}
		return this.evenement.id || this.evenement.evenementName || null;
	}
	
	private getThumbnailSignature(): string {
		if (!this.evenement || !this.evenement.thumbnail) {
			return 'no-thumbnail';
		}
		return this.evenement.thumbnail.fieldId || 'no-thumbnail';
	}

	private applyCachedStyles(expectedSignature?: string): boolean {
		const cacheKey = this.getCacheKey();
		if (!cacheKey) {
			return false;
		}
		const cached = ElementEvenementComponent.thumbnailCache.get(cacheKey);
		if (!cached) {
			return false;
		}

		// For blob URLs, verify they're still in the persistent cache
		// Even if signature doesn't match, try to use the cached blob URL if it exists
		if (cached.thumbnailUrl && typeof cached.thumbnailUrl === 'object' && 
			'changingThisBreaksApplicationSecurity' in cached.thumbnailUrl) {
			const url = cached.thumbnailUrl['changingThisBreaksApplicationSecurity'];
			if (url && typeof url === 'string' && url.startsWith('blob:')) {
				// Use the thumbnail field directly to get its fieldId
				const thumbnailFile = this.evenement.thumbnail;
				
				// Always try to recreate blob URL from cached Blob first (even if blob URL exists)
				// This ensures the blob URL is always valid and prevents ERR_FILE_NOT_FOUND
				if (thumbnailFile && thumbnailFile.fieldId) {
					const cachedBlob = ElementEvenementComponent.blobCache.get(thumbnailFile.fieldId);
					if (cachedBlob) {
						// Recreate blob URL from cached Blob to ensure it's valid
						try {
							const objectUrl = this.nativeWindow.URL.createObjectURL(cachedBlob);
							const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
							// Update cache with new blob URL
							ElementEvenementComponent.blobUrlCache.set(thumbnailFile.fieldId, safeUrl);
							// Use the recreated blob URL
							this.thumbnailUrl = safeUrl;
							this.dominantR = cached.dominant.r;
							this.dominantG = cached.dominant.g;
							this.dominantB = cached.dominant.b;
							this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
							this.titleBackgroundColor = cached.titleBackground;
							this.titleBorderColor = cached.titleBorder;
							this.descriptionBackgroundColor = cached.descriptionBackground;
							this.invalidateColorCaches();
							this.emitDominantColor();
							return true;
						} catch (error) {
							// Failed to recreate, will try other methods below
						}
					}
					
					// If Blob not found, try to use cached blob URL if it exists
					const cachedBlobUrl = ElementEvenementComponent.blobUrlCache.get(thumbnailFile.fieldId);
					if (cachedBlobUrl) {
						// Use cached blob URL (but it might be revoked - will be handled by error handler)
						this.thumbnailUrl = cachedBlobUrl;
						this.dominantR = cached.dominant.r;
						this.dominantG = cached.dominant.g;
						this.dominantB = cached.dominant.b;
						this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
						this.titleBackgroundColor = cached.titleBackground;
						this.titleBorderColor = cached.titleBorder;
						this.descriptionBackgroundColor = cached.descriptionBackground;
						this.invalidateColorCaches();
						this.emitDominantColor();
						return true;
					}
				}
				
				// If no thumbnail file found yet, try to find blob URL in cache by matching URLs
				for (const [fieldId, blobUrl] of ElementEvenementComponent.blobUrlCache.entries()) {
					if (blobUrl === cached.thumbnailUrl) {
						// Found matching blob URL - check if we have the Blob to recreate URL
						const cachedBlob = ElementEvenementComponent.blobCache.get(fieldId);
						if (cachedBlob) {
							// Recreate blob URL from cached Blob
							try {
								const objectUrl = this.nativeWindow.URL.createObjectURL(cachedBlob);
								const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
								ElementEvenementComponent.blobUrlCache.set(fieldId, safeUrl);
								this.thumbnailUrl = safeUrl;
							} catch (error) {
								// Failed to recreate, use cached URL (might fail, error handler will deal with it)
								this.thumbnailUrl = blobUrl;
							}
						} else {
							// No Blob cache, use cached URL (might be revoked)
							this.thumbnailUrl = blobUrl;
						}
						
						this.dominantR = cached.dominant.r;
						this.dominantG = cached.dominant.g;
						this.dominantB = cached.dominant.b;
						this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
						this.titleBackgroundColor = cached.titleBackground;
						this.titleBorderColor = cached.titleBorder;
						this.descriptionBackgroundColor = cached.descriptionBackground;
						this.invalidateColorCaches();
						this.emitDominantColor();
						return true;
					}
				}
				
				// Blob URL not found in cache - it may have been revoked
				return false;
			}
		}

		// Not a blob URL, use it directly (e.g., default image)
		// Only use if signature matches (to avoid using wrong cached data)
		if (expectedSignature && cached.signature !== expectedSignature) {
			return false;
		}

		this.thumbnailUrl = cached.thumbnailUrl;
		this.dominantR = cached.dominant.r;
		this.dominantG = cached.dominant.g;
		this.dominantB = cached.dominant.b;
		this.calculatedRgbValues = `RGB(${this.dominantR}, ${this.dominantG}, ${this.dominantB})`;
		this.titleBackgroundColor = cached.titleBackground;
		this.titleBorderColor = cached.titleBorder;
		this.descriptionBackgroundColor = cached.descriptionBackground;
		this.invalidateColorCaches();
		this.emitDominantColor();
		return true;
	}

	private cacheCurrentStyles(signature?: string): void {
		const cacheKey = this.getCacheKey();
		if (!cacheKey) {
			return;
		}
		ElementEvenementComponent.thumbnailCache.set(cacheKey, {
			thumbnailUrl: this.thumbnailUrl,
			dominant: { r: this.dominantR, g: this.dominantG, b: this.dominantB },
			titleBackground: this.titleBackgroundColor,
			titleBorder: this.titleBorderColor,
			descriptionBackground: this.descriptionBackgroundColor,
			signature: signature ?? this.getThumbnailSignature()
		});
	}

	public getSolidColor(alpha: number = 1): string {
		const normalizedAlpha = Number.isFinite(alpha) ? alpha : 1;
		const key = Math.max(0, Math.min(1, Math.round(normalizedAlpha * 1000) / 1000));
		if (!this.solidColorCache.has(key)) {
			this.solidColorCache.set(key, this.buildColorString(this.dominantR, this.dominantG, this.dominantB, key));
		}
		return this.solidColorCache.get(key) as string;
	}

	// Helper method to extract URL string from thumbnailUrl (handles both string and SafeUrl)
	private getThumbnailUrlString(): string | null {
		if (!this.thumbnailUrl) {
			return null;
		}
		if (typeof this.thumbnailUrl === 'string') {
			return this.thumbnailUrl;
		}
		if (typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl) {
			return this.thumbnailUrl['changingThisBreaksApplicationSecurity'] as string;
		}
		return null;
	}

	public getPhotoFrameStyles(): { [key: string]: string } {
		if (!this.photoFrameStylesCache) {
			const baseStyles: { [key: string]: string } = {
				position: 'relative',
				backgroundColor: this.getSolidColor(0.35),
				borderRadius: '8px',
				padding: '7px 7px 0 7px',
				boxShadow: 'none',
				boxSizing: 'border-box',
				overflow: 'hidden'
			};

			// Add blurred background image if thumbnail URL is available
			const thumbnailUrlStr = this.getThumbnailUrlString();
			if (thumbnailUrlStr && thumbnailUrlStr !== 'assets/images/images.jpg') {
				// Use CSS custom property so the pseudo-element can access it
				baseStyles['--thumbnail-bg-image'] = `url(${thumbnailUrlStr})`;
			}

			// Set fixed aspect ratio for all images to ensure same height
			// Using aspect-ratio 16:9 for consistent sizing
			baseStyles['aspect-ratio'] = '16 / 9';
			baseStyles['display'] = 'flex';
			baseStyles['align-items'] = 'center';
			baseStyles['justify-content'] = 'center';

			this.photoFrameStylesCache = baseStyles;
		}
		return this.photoFrameStylesCache;
	}

	private getPhotoBorderColor(): string {
		if (!this.photoBorderColorCache) {
			const { r, g, b } = this.getAdjustedDominantColor(-45);
			this.photoBorderColorCache = this.buildColorString(r, g, b, 0.9);
		}
		return this.photoBorderColorCache;
	}

	public getPhotoImageStyles(): { [key: string]: string } {
		if (!this.photoImageStylesCache) {
			const borderColor = this.getPhotoBorderColor();
			this.photoImageStylesCache = {
				border: `6px solid ${borderColor}`,
				borderRadius: 'inherit',
				backgroundColor: 'transparent',
				padding: '0',
				boxSizing: 'border-box',
				width: '100%',
				height: '100%',
				objectFit: 'contain' // Ensure entire image is visible and fits within container
			};
		}
		
		return this.photoImageStylesCache;
	}
	
	// Get color for a specific button type - based only on calculated color
	public getButtonGradientForType(_buttonType: string, r: number, g: number, b: number): string {
		const cacheKey = `${_buttonType}|${r}|${g}|${b}`;
		let cached = this.buttonGradientCache.get(cacheKey);
		if (!cached) {
			cached = this.buildColorString(r, g, b, 0.85);
			this.buttonGradientCache.set(cacheKey, cached);
		}
		return cached;
	}

	private buildAdjustedColor(delta: number, alpha: number = 1): string {
		return this.buildColorString(
			this.adjustColorComponent(this.dominantR, delta),
			this.adjustColorComponent(this.dominantG, delta),
			this.adjustColorComponent(this.dominantB, delta),
			alpha
		);
	}

	public getFooterButtonStyles(buttonType: string): { [key: string]: string } {
		const cacheKey = `${buttonType}|${this.dominantR}|${this.dominantG}|${this.dominantB}`;
		let cached = this.footerButtonStylesCache.get(cacheKey);

		if (!cached) {
			const baseColor = this.getButtonGradientForType(buttonType, this.dominantR, this.dominantG, this.dominantB);
			const brightness = this.getColorBrightness(this.dominantR, this.dominantG, this.dominantB);
			const isBright = brightness > 175;

			const textColor = this.getInverseTextColor();
			const borderColor = this.getInverseTextColor();
			const hoverBrightness = isBright ? 0.82 : 1.24;
			const activeBrightness = isBright ? 0.78 : 1.32;
			const shadowColor = isBright ? 'rgba(15, 23, 42, 0.32)' : 'rgba(15, 23, 42, 0.42)';

			cached = {
				'background-color': baseColor,
				'color': textColor,
				'border-color': borderColor,
				'--btn-bg': baseColor,
				'--btn-color': textColor,
				'--btn-border-color': borderColor,
				'--btn-hover-brightness': hoverBrightness.toString(),
				'--btn-active-brightness': activeBrightness.toString(),
				'--btn-shadow-color': shadowColor
			};

			this.footerButtonStylesCache.set(cacheKey, cached);
		}

		return cached;
	}
	
	// Solid color for files list - based on calculated color
	public getFilesListGradient(): string {
		if (!this.filesListGradientCache) {
			this.filesListGradientCache = this.getSolidColor(0.1);
		}
		return this.filesListGradientCache;
	}

	public getEventTypeLabel(type: string | number): string {
		const key = String(type);
		const labelKey = this.eventTypeLabels[key];
		return labelKey ? this.translateService.instant(labelKey) : key;
	}

	private adjustColorComponent(value: number, delta: number): number {
		return Math.max(0, Math.min(255, Math.round(value + delta)));
	}

	private getAdjustedDominantColor(delta: number): { r: number; g: number; b: number } {
		return {
			r: this.adjustColorComponent(this.dominantR, delta),
			g: this.adjustColorComponent(this.dominantG, delta),
			b: this.adjustColorComponent(this.dominantB, delta)
		};
	}

	private getColorBrightness(r: number, g: number, b: number): number {
		return 0.299 * r + 0.587 * g + 0.114 * b;
	}

	public getCardBackgroundGradient(): string {
		if (!this.cardBackgroundGradientCache) {
			// Use solid color instead of gradient
			this.cardBackgroundGradientCache = this.getSolidColor(0.9);
		}
		return this.cardBackgroundGradientCache;
	}
	
	// Get gradient for status badges - based on calculated color
	public getStatusBadgeGradient(): string {
		if (!this.statusBadgeGradientCache) {
			this.statusBadgeGradientCache = this.getButtonGradientForType('status', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.statusBadgeGradientCache;
	}
	
	// Couleur pour les boutons d’action de fichiers
	public getFileActionButtonGradient(): string {
		return this.getSolidColor(0.9);
	}

	private getFileTypeKey(fileName: string): 'image' | 'video' | 'pdf' | 'track' | 'other' {
		if (this.isImageFile(fileName)) {
			return 'image';
		}
		if (this.isVideoFile(fileName)) {
			return 'video';
		}
		if (this.isPdfFile(fileName)) {
			return 'pdf';
		}
		if (this.isTrackFile(fileName)) {
			return 'track';
		}
		return 'other';
	}

	private getFileBadgeColorComponents(fileName: string): { r: number; g: number; b: number } {
		const cacheKey = fileName || '';
		const existing = this.fileBadgeComponentsCache.get(cacheKey);
		if (existing) {
			return existing;
		}

		const typeKey = this.getFileTypeKey(fileName);
		let r = this.dominantR;
		let g = this.dominantG;
		let b = this.dominantB;

		switch (typeKey) {
			case 'image':
				r = this.adjustColorComponent(r, 45);
				g = this.adjustColorComponent(g, 45);
				b = this.adjustColorComponent(b, 45);
				break;
			case 'video':
				r = this.adjustColorComponent(r, 30);
				g = this.adjustColorComponent(g, -20);
				b = this.adjustColorComponent(b, 30);
				break;
			case 'pdf':
				r = this.adjustColorComponent(r, -50);
				g = this.adjustColorComponent(g, -50);
				b = this.adjustColorComponent(b, -50);
				break;
			default:
				r = this.adjustColorComponent(r, 10);
				g = this.adjustColorComponent(g, 10);
				b = this.adjustColorComponent(b, 10);
		}

		const components = { r, g, b };
		this.fileBadgeComponentsCache.set(cacheKey, components);
		return components;
	}

	// Couleur pour les badges de fichiers en fonction du type
	public getFileBadgeColor(fileName: string): string {
		const cacheKey = fileName || '';
		let cached = this.fileBadgeColorCache.get(cacheKey);
		if (!cached) {
			const { r, g, b } = this.getFileBadgeColorComponents(fileName);
			cached = this.buildColorString(r, g, b, 0.88);
			this.fileBadgeColorCache.set(cacheKey, cached);
		}
		return cached;
	}

	public getFileBadgeTextColor(fileName: string): string {
		// Use unified method based on dominant color
		return this.getInverseTextColor();
	}

	public getParticipantButtonStyles(isRemove: boolean): { [key: string]: string } {
		return {
			'background-color': this.getParticipantButtonBackground(isRemove),
			'border-color': this.getParticipantButtonBorder(isRemove),
			'border-width': '2px',
			'border-style': 'solid',
			'color': this.getParticipantButtonTextColor(isRemove)
		};
	}

	private getParticipantButtonBackground(isRemove: boolean): string {
		const delta = isRemove ? -70 : 55;
		const { r, g, b } = this.getAdjustedDominantColor(delta);
		return this.buildColorString(r, g, b, 0.92);
	}

	private getParticipantButtonBorder(isRemove: boolean): string {
		// Use unified method based on dominant color
		return this.getInverseTextColor();
	}

	private getParticipantButtonTextColor(isRemove: boolean): string {
		// Use unified method based on dominant color
		return this.getInverseTextColor();
	}

	public getParticipantBadgeStyles(): { [key: string]: string } {
		return {
			'background-color': this.getParticipantBadgeColor(),
			'border-color': this.getParticipantBadgeBorderColor(),
			'border-width': '2px',
			'border-style': 'solid',
			'color': this.getParticipantBadgeTextColor()
		};
	}

	private getParticipantBadgeColor(): string {
		const { r, g, b } = this.getAdjustedDominantColor(35);
		return this.buildColorString(r, g, b, 0.9);
	}

	private getParticipantBadgeBorderColor(): string {
		// Use unified method based on dominant color
		return this.getInverseTextColor();
	}

	private getParticipantBadgeTextColor(): string {
		// Use unified method based on dominant color
		return this.getInverseTextColor();
	}

	// Get gradient for visibility badges - based on calculated color
	public getVisibilityBadgeGradient(): string {
		if (!this.visibilityBadgeGradientCache) {
			this.visibilityBadgeGradientCache = this.getButtonGradientForType('visibility', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.visibilityBadgeGradientCache;
	}
	
	// Single unified method to get inverse text color based on dominant color brightness
	// Returns dark color if background is bright, light gray if background is dark
	public getInverseTextColor(): string {
		const brightness = this.getColorBrightness(this.dominantR, this.dominantG, this.dominantB);
		const isBright = brightness > 150;
		return isBright ? '#020617' : '#e8e8e8';
	}
	
	// Get inverse background color (opposite of text color)
	public getInverseBackgroundColor(): string {
		const brightness = this.getColorBrightness(this.dominantR, this.dominantG, this.dominantB);
		const isBright = brightness > 150;
		return isBright ? '#e8e8e8' : '#020617';
	}
	
	// Get inverse background color with 70% transparency
	public getInverseBackgroundColorTransparent(): string {
		const brightness = this.getColorBrightness(this.dominantR, this.dominantG, this.dominantB);
		const isBright = brightness > 150;
		// Return rgba with 0.3 opacity (70% transparent)
		return isBright ? 'rgba(232, 232, 232, 0.3)' : 'rgba(2, 6, 23, 0.3)';
	}
	
	// Get text color for badges - uses unified method
	public getBadgeTextColor(): string {
		return this.getInverseTextColor();
	}
	
	// Get text color for status badges
	public getStatusBadgeTextColor(): string {
		return this.getInverseTextColor();
	}
	
	// Get text color for visibility badges
	public getVisibilityBadgeTextColor(): string {
		return this.getInverseTextColor();
	}
	
	// Get text color for rating badges
	public getRatingBadgeTextColor(): string {
		return this.getInverseTextColor();
	}
	
	// Get styles for WhatsApp button - matching footer buttons styling
	public getWhatsAppButtonStyles(): { [key: string]: string } {
		const baseColor = this.getVisibilityBadgeGradient();
		const brightness = this.getColorBrightness(this.dominantR, this.dominantG, this.dominantB);
		const isBright = brightness > 175;
		
		const textColor = this.getInverseTextColor();
		const borderColor = this.getInverseTextColor();
		const hoverBrightness = isBright ? 0.82 : 1.24;
		const activeBrightness = isBright ? 0.78 : 1.32;
		const shadowColor = isBright ? 'rgba(15, 23, 42, 0.32)' : 'rgba(15, 23, 42, 0.42)';
		
		return {
			'background-color': baseColor,
			'color': textColor,
			'border-color': borderColor,
			'--btn-bg': baseColor,
			'--btn-color': textColor,
			'--btn-border-color': borderColor,
			'--btn-hover-brightness': hoverBrightness.toString(),
			'--btn-active-brightness': activeBrightness.toString(),
			'--btn-shadow-color': shadowColor
		};
	}

	// Get visibility display text (for friend groups, shows the group name)
	public getVisibilityDisplayText(): string {
		// If visibility is a friend group name (not public, private, or friends), return it as-is
		if (this.evenement.visibility && 
		    this.evenement.visibility !== 'public' && 
		    this.evenement.visibility !== 'private' && 
		    this.evenement.visibility !== 'friends') {
			return this.evenement.visibility;
		}
		// Fallback to visibility value
		return this.evenement.visibility || '';
	}
	
	// Get the friend group for this event (if it has a friendGroupId or visibility matches a group name)
	public getEventFriendGroup(): FriendGroup | undefined {
		if (!this.friendGroups || this.friendGroups.length === 0) {
			return undefined;
		}
		
		// First, try to find by friendGroupId
		if (this.evenement.friendGroupId) {
			const groupById = this.friendGroups.find(g => g.id === this.evenement.friendGroupId);
			if (groupById) {
				return groupById;
			}
		}
		
		// If not found by ID, try to find by visibility (which might be the group name)
		if (this.evenement.visibility && this.evenement.visibility !== 'public' && this.evenement.visibility !== 'private' && this.evenement.visibility !== 'friends') {
			const groupByName = this.friendGroups.find(g => g.name === this.evenement.visibility);
			if (groupByName) {
				return groupByName;
			}
		}
		
		return undefined;
	}
	
	// Check if the event's friend group has a WhatsApp link
	public hasFriendGroupWhatsAppLink(): boolean {
		if (!this.friendGroups || this.friendGroups.length === 0) {
			return false;
		}
		
		const group = this.getEventFriendGroup();
		if (!group) {
			return false;
		}
		
		return !!(group.whatsappLink && group.whatsappLink.trim().length > 0);
	}
	
	// Get the WhatsApp link for the event's friend group
	public getFriendGroupWhatsAppLink(): string | undefined {
		const group = this.getEventFriendGroup();
		return group?.whatsappLink;
	}
	
	// Open WhatsApp link for the friend group
	public openFriendGroupWhatsAppLink(): void {
		const whatsappLink = this.getFriendGroupWhatsAppLink();
		if (whatsappLink) {
			window.open(whatsappLink, '_blank');
		}
	}
	
	// Get gradient for download all button - based on calculated color
	public getDownloadAllButtonGradient(): string {
		if (!this.downloadAllButtonGradientCache) {
			this.downloadAllButtonGradientCache = this.getButtonGradientForType('download', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.downloadAllButtonGradientCache;
	}
	
	// Get gradient for rating badges - based on calculated color
	public getRatingBadgeGradient(): string {
		if (!this.ratingBadgeGradientCache) {
			this.ratingBadgeGradientCache = this.getButtonGradientForType('rating', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.ratingBadgeGradientCache;
	}
	// Detect color after view is initialized
	ngAfterViewInit() {
		// Track component initialization end time (when view is ready)
		if (this.componentInitEndTime === 0) {
			this.componentInitEndTime = performance.now();
		}
		
		// Verify thumbnail is loaded after view init
		// This helps when coming back from update page
		setTimeout(() => {
			if (!this.thumbnailUrl || this.thumbnailUrl === "assets/images/images.jpg" || 
				(typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl)) {
				const url = typeof this.thumbnailUrl === 'object' ? 
					this.thumbnailUrl['changingThisBreaksApplicationSecurity'] : this.thumbnailUrl;
				if (!url || url === "assets/images/images.jpg") {
					// Thumbnail not loaded, try again now that view is initialized
					this.loadThumbnail();
				}
			}
		}, 200);
		// Try to detect color if image is already loaded
		setTimeout(() => {
			if (this.thumbnailImageRef && this.thumbnailImageRef.nativeElement) {
				const img = this.thumbnailImageRef.nativeElement;
				if (img.complete && img.naturalWidth > 0) {
					this.detectDominantColor();
				}
			}
		}, 300);
	}
	
	// Setup automatic tooltip closing when modals or overlays appear
	private setupTooltipAutoClose(): void {
		if (this.tooltipMutationObserver) {
			return;
		}

		// Use MutationObserver to detect when modals are added to DOM
		this.tooltipMutationObserver = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				mutation.addedNodes.forEach((node) => {
					if (node.nodeType === 1) { // Element node
						const element = node as HTMLElement;
						// Check if it's a modal or modal backdrop
						if (element.classList && (
							element.classList.contains('modal') ||
							element.classList.contains('modal-backdrop') ||
							element.querySelector && element.querySelector('.modal')
						)) {
							// Close all tooltips when modal appears
							setTimeout(() => this.forceCloseTooltips(), 0);
						}
					}
				});
			});
		});
		
		// Observe body for modal additions
		this.tooltipMutationObserver.observe(document.body, {
			childList: true,
			subtree: true
		});
		
		// Also listen for modal show events using DOM events
		this.tooltipShowListener = () => {
			this.forceCloseTooltips();
		};
		document.addEventListener('show.bs.modal', this.tooltipShowListener, true);
		
		this.tooltipShownListener = () => {
			this.forceCloseTooltips();
		};
		document.addEventListener('shown.bs.modal', this.tooltipShownListener, true);
		
		// Listen for any click events that might open modals or overlays
		this.tooltipDocClickListener = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			// Check if click is on a button that might open a modal
			if (target && (
				target.closest('button') ||
				target.closest('a') ||
				target.closest('[ngbTooltip]')
			)) {
				// Small delay to let modal start opening
				setTimeout(() => {
					if (document.querySelector('.modal.show') || document.querySelector('.modal-backdrop')) {
						this.forceCloseTooltips();
					}
				}, 10);
			}
		};
		document.addEventListener('click', this.tooltipDocClickListener, true);
	}
	// delete a file uploaded linked to the evenement, update the evenement
	delFile(fieldId: string) {
		// Find the file being deleted to check if it contains "thumbnail"
		const fileToDelete = this.evenement.fileUploadeds.find(fileUploaded => fileUploaded.fieldId === fieldId);
		
		// Prevent deletion of thumbnail files
		if (fileToDelete && fileToDelete.fileName && fileToDelete.fileName.toLowerCase().includes('thumbnail')) {
			alert(this.translateService.instant('EVENTELEM.CANNOT_DELETE_THUMBNAIL'));
			return;
		}
		
		if (confirm(this.translateService.instant('EVENTELEM.DELETEFILE_CONFIRM'))) {
			// Create a copy of the evenement without the file to delete
			const evenementToUpdate = { ...this.evenement };
			evenementToUpdate.fileUploadeds = this.evenement.fileUploadeds.filter(fileUploaded => !(fileUploaded.fieldId == fieldId));
			
			// Call backend to delete the file from MongoDB GridFS
			const updateSubscription = this._fileService.updateFile(evenementToUpdate, this.user).subscribe({
				next: (updatedEvenement) => {
					// Update the local evenement with the response
					this.evenement.fileUploadeds = evenementToUpdate.fileUploadeds;
					this.updateFileUploaded.emit(this.evenement);
				},
				error: (error) => {
					console.error('Error deleting file from MongoDB:', error);
					alert(this.translateService.instant('EVENTELEM.DELETE_FILE_ERROR'));
					// Revert the local change on error
					// The file list will be restored when the component refreshes
				}
			});
			this.allSubscriptions.push(updateSubscription);
		}
	}

	// check if urlEvents are available
	public isUrlEventsAvailable(): boolean {
		if (!this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
			return false;
		}
		// Exclude photo-related links (PHOTOS and PHOTOFROMFS)
		return this.evenement.urlEvents.some(u => {
			const type = (u.typeUrl || '').toUpperCase().trim();
			return type !== 'PHOTOS' && type !== 'PHOTOFROMFS';
		});
	}

	// get count of urlEvents (excluding photo-related links)
	public getUrlEventsCount(): number {
		if (!this.evenement.urlEvents) {
			return 0;
		}
		// Exclude photo-related links (PHOTOS and PHOTOFROMFS)
		return this.evenement.urlEvents.filter(u => {
			const type = (u.typeUrl || '').toUpperCase().trim();
			return type !== 'PHOTOS' && type !== 'PHOTOFROMFS';
		}).length;
	}

	// Helper method to block scroll and preserve position when opening modals
	private openModalWithScrollPreservation(content: any, options: any = {}) {
		// Save current scroll position
		const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
		
		// Block body scroll to prevent page from scrolling
		if (document.body) {
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.top = `-${savedScrollY}px`;
			document.body.style.width = '100%';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
		
		// Open the modal
		const modalRef = this.modalService.open(content, options);
		
		// Restore scroll when modal closes
		modalRef.result.finally(() => {
			// Restore body styles
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
			}
			
			// Restore scroll position
			window.scrollTo(0, savedScrollY);
			document.documentElement.scrollTop = savedScrollY;
		}).catch(() => {
			// Also restore on dismissal
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
			}
			window.scrollTo(0, savedScrollY);
			document.documentElement.scrollTop = savedScrollY;
		});
		
		return modalRef;
	}
	
	// Helper method to block scroll for component modals (slideshow, videoshow, traceviewer)
	private blockScrollForComponentModal(): () => void {
		// Save current scroll position
		const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
		
		// Block body scroll to prevent page from scrolling
		if (document.body) {
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.top = `-${savedScrollY}px`;
			document.body.style.width = '100%';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
		
		// Return cleanup function
		return () => {
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
			}
			window.scrollTo(0, savedScrollY);
			document.documentElement.scrollTop = savedScrollY;
		};
	}

	// open URLs modal
	public openUrlsModal(content: any) {
		this.forceCloseTooltips();
		
		// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
		// Don't modify DOM - let Bootstrap handle modal normally
		// CSS will handle blocking scroll via styles.css rule
		const savedScrollY = window.scrollY || window.pageYOffset || 
			document.documentElement.scrollTop || 
			document.body.scrollTop || 0;
		
		// Open the modal - CSS will block scroll automatically
		const modalRef = this.modalService.open(content, { 
			size: 'lg', 
			centered: true, 
			backdrop: 'static', 
			keyboard: false,
			windowClass: 'urls-modal'
		});
		
		// Immediately maintain scroll position after modal opens to prevent any movement
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				// Restore scroll position in case Bootstrap tried to scroll
				window.scrollTo(0, savedScrollY);
				document.documentElement.scrollTop = savedScrollY;
				document.body.scrollTop = savedScrollY;
			});
		});
		
		// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
		modalRef.result.finally(() => {
			// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		}).catch(() => {
			// Also restore on dismissal
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		});
	}

	// open Discussion modal
	public openDiscussionModal(discussionId?: string) {
		this.forceCloseTooltips();
		
		// Get or create discussion for this event
		const eventDiscussionId = this.evenement.discussionId || discussionId;
		const discussionTitle = this.translateService.instant('DISCUSSION.TITLE') + ' - ' + this.evenement.evenementName;
		
		// Get or create the discussion
		this._discussionService.getOrCreateDiscussion(eventDiscussionId, discussionTitle).subscribe({
			next: (discussion) => {
				// Update the event's discussionId if:
				// 1. The event doesn't have a discussionId yet (first time creation), OR
				// 2. The discussion ID is different from what we tried to get (meaning a new one was created because the old one didn't exist - 404 case)
				// This condition handles both scenarios:
				// - First time: this.evenement.discussionId is null/undefined, discussion.id is new ID → condition is true
				// - Replacement: this.evenement.discussionId is old invalid ID, discussion.id is new ID → condition is true
				if (discussion.id && (this.evenement.discussionId !== discussion.id)) {
					const oldDiscussionId = this.evenement.discussionId;
					// Preserve friendGroupId to ensure friend group events maintain their visibility settings
					const preservedFriendGroupId = this.evenement.friendGroupId;
					this.evenement.discussionId = discussion.id;
					console.log('Updating event discussionId:', oldDiscussionId, '→', discussion.id);
					if (preservedFriendGroupId) {
						console.log('Preserving friendGroupId:', preservedFriendGroupId);
					}
					
					// Update the event in the backend
					// Note: The entire event object is sent, which includes friendGroupId, so it will be preserved
					this._evenementsService.putEvenement(this.evenement).subscribe({
						next: () => {
							console.log('Event discussionId saved to backend:', discussion.id);
							// After successful save, fetch the updated event from backend to ensure cache is synchronized
							// This ensures both the local component cache and parent component cache are updated
							if (this.evenement.id) {
								this._evenementsService.getEvenement(this.evenement.id).subscribe({
									next: (updatedEvent) => {
										// Update the local event object with the fetched data
										// This ensures the cache in the parent component is also updated (since event is passed by reference)
										// The updated event includes all fields including friendGroupId, so friend group visibility is preserved
										Object.assign(this.evenement, updatedEvent);
										console.log('Event cache synchronized with backend. discussionId:', updatedEvent.discussionId, 
											updatedEvent.friendGroupId ? 'friendGroupId: ' + updatedEvent.friendGroupId : '');
									},
									error: (error) => {
										console.error('Error fetching updated event after save:', error);
									}
								});
							}
						},
						error: (error) => {
							console.error('Error saving discussionId to event:', error);
							// Revert the local change if save failed
							this.evenement.discussionId = oldDiscussionId || undefined;
							// friendGroupId is preserved in the original object, no need to revert it
						}
					});
				}
				
				// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
				// CSS will handle blocking scroll via styles.css rule
				const savedScrollY = window.scrollY || window.pageYOffset || 
					document.documentElement.scrollTop || 
					document.body.scrollTop || 0;
				
				// Open the modal - CSS will block scroll automatically
				const modalRef = this.modalService.open(DiscussionModalComponent, { 
					size: 'lg', 
					centered: true, 
					backdrop: 'static', 
					keyboard: true,
					windowClass: 'discussion-modal-window'
				});
				
				// Immediately maintain scroll position after modal opens to prevent any movement
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						// Restore scroll position in case Bootstrap tried to scroll
						window.scrollTo(0, savedScrollY);
						document.documentElement.scrollTop = savedScrollY;
						document.body.scrollTop = savedScrollY;
					});
				});
				
				// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
				modalRef.result.finally(() => {
					// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
					if (document.body) {
						document.body.style.overflow = '';
						document.body.style.overflowX = '';
						document.body.style.overflowY = '';
						document.body.style.position = '';
						document.body.style.height = '';
					}
					if (document.documentElement) {
						document.documentElement.style.overflow = '';
						document.documentElement.style.overflowX = '';
						document.documentElement.style.overflowY = '';
					}
					
					// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
					const restoreScroll = () => {
						window.scrollTo({
							top: savedScrollY,
							left: 0,
							behavior: 'auto'
						});
						if (document.documentElement) {
							document.documentElement.scrollTop = savedScrollY;
						}
						if (document.body) {
							document.body.scrollTop = savedScrollY;
						}
					};
					
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							setTimeout(restoreScroll, 300);
						});
					});
				}).catch(() => {
					// Also restore on dismissal
					if (document.body) {
						document.body.style.overflow = '';
						document.body.style.overflowX = '';
						document.body.style.overflowY = '';
						document.body.style.position = '';
						document.body.style.height = '';
					}
					if (document.documentElement) {
						document.documentElement.style.overflow = '';
						document.documentElement.style.overflowX = '';
						document.documentElement.style.overflowY = '';
					}
					
					const restoreScroll = () => {
						window.scrollTo({
							top: savedScrollY,
							left: 0,
							behavior: 'auto'
						});
						if (document.documentElement) {
							document.documentElement.scrollTop = savedScrollY;
						}
						if (document.body) {
							document.body.scrollTop = savedScrollY;
						}
					};
					
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							setTimeout(restoreScroll, 300);
						});
					});
				});
				
				modalRef.componentInstance.discussionId = discussion.id || null;
				modalRef.componentInstance.title = discussionTitle;
			},
			error: (error) => {
				console.error('Error getting or creating discussion:', error);
				// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
				// CSS will handle blocking scroll via styles.css rule
				const savedScrollY = window.scrollY || window.pageYOffset || 
					document.documentElement.scrollTop || 
					document.body.scrollTop || 0;
				
				// Still open modal with null discussionId (will load default)
				const modalRef = this.modalService.open(DiscussionModalComponent, { 
					size: 'lg', 
					centered: true, 
					backdrop: 'static', 
					keyboard: true,
					windowClass: 'discussion-modal-window'
				});
				
				// Immediately maintain scroll position after modal opens to prevent any movement
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						// Restore scroll position in case Bootstrap tried to scroll
						window.scrollTo(0, savedScrollY);
						document.documentElement.scrollTop = savedScrollY;
						document.body.scrollTop = savedScrollY;
					});
				});
				
				// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
				modalRef.result.finally(() => {
					// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
					if (document.body) {
						document.body.style.overflow = '';
						document.body.style.overflowX = '';
						document.body.style.overflowY = '';
						document.body.style.position = '';
						document.body.style.height = '';
					}
					if (document.documentElement) {
						document.documentElement.style.overflow = '';
						document.documentElement.style.overflowX = '';
						document.documentElement.style.overflowY = '';
					}
					
					// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
					const restoreScroll = () => {
						window.scrollTo({
							top: savedScrollY,
							left: 0,
							behavior: 'auto'
						});
						if (document.documentElement) {
							document.documentElement.scrollTop = savedScrollY;
						}
						if (document.body) {
							document.body.scrollTop = savedScrollY;
						}
					};
					
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							setTimeout(restoreScroll, 300);
						});
					});
				}).catch(() => {
					// Also restore on dismissal
					if (document.body) {
						document.body.style.overflow = '';
						document.body.style.overflowX = '';
						document.body.style.overflowY = '';
						document.body.style.position = '';
						document.body.style.height = '';
					}
					if (document.documentElement) {
						document.documentElement.style.overflow = '';
						document.documentElement.style.overflowX = '';
						document.documentElement.style.overflowY = '';
					}
					
					const restoreScroll = () => {
						window.scrollTo({
							top: savedScrollY,
							left: 0,
							behavior: 'auto'
						});
						if (document.documentElement) {
							document.documentElement.scrollTop = savedScrollY;
						}
						if (document.body) {
							document.body.scrollTop = savedScrollY;
						}
					};
					
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							setTimeout(restoreScroll, 300);
						});
					});
				});
				modalRef.componentInstance.discussionId = null;
				modalRef.componentInstance.title = discussionTitle;
			}
		});
	}
	// call the modal window for del confirmation
	public deleteEvenement() {
		// Count associated data
		const fileCount = this.evenement.fileUploadeds ? this.evenement.fileUploadeds.length : 0;
		const urlCount = this.evenement.urlEvents ? this.evenement.urlEvents.length : 0;
		const commentaryCount = this.evenement.commentaries ? this.evenement.commentaries.length : 0;
		
		// Build detailed confirmation message
		let confirmMessage = this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_MESSAGE') + '\n\n';
		
		if (fileCount > 0) {
			confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_FILES', { count: fileCount }) + '\n';
		}
		if (urlCount > 0) {
			confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_URLS', { count: urlCount }) + '\n';
		}
		if (commentaryCount > 0) {
			confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_COMMENTARIES', { count: commentaryCount }) + '\n';
		}
		
		// Always mention chat messages regardless of count
		confirmMessage += this.translateService.instant('EVENTELEM.DELETE_EVENT_CONFIRM_CHAT');
		
		if (confirm(confirmMessage)) {
			this.delEvenement.emit(this.evenement);
		}
	}
	// add the user as member
	public addMemberClick() {
		// Show participants section when clicking add member
		this.showParticipantsSection();
		// Only add if not already a participant
		if (!this.isParticipant()) {
			this.addMember.emit(this.evenement);
		}
	};
	// del the user as member
	public delMemberClick() {
		this.delMember.emit(this.evenement);
	};
	// Change Status
	public changeStatusEvent(status: string) {
		// Only allow status changes if user is the owner
		if (!this.isAuthor()) {
			console.warn("Only the owner can change the status of an event");
			return;
		}
		
		if (status == "Closed") {
			this.evenement.status = "Cancel"
		} else
			if (status == "Cancel") {
				this.evenement.status = "Open"
			}
			else
				this.evenement.status = "Closed"

		this.updateEvenement.emit(this.evenement);
	};

	public isAuthor(): boolean {
		// i don't search by Id becoze sometimes the page can be diaplyed after the id is filled 
		// as it is completed by the id becoming from Mlab with an observable in membersService.completeMemberId()
		return this.evenement.author.userName.toLowerCase() == this.user.userName.toLowerCase();
	}

	public isParticipant(): boolean {
		let b: boolean = false;
		this.evenement.members.forEach(member => {
			if (member.userName.toLowerCase() == this.user.userName.toLowerCase()) { b = true };
		}
		);
		return b;
	}

	public toggleParticipantsList(): void {
		this.showParticipantsList = !this.showParticipantsList;
	}
	
	// Show participants section (used when clicking add member button)
	public showParticipantsSection(): void {
		this.showParticipantsList = true;
	}

	public isLoadingFiles: boolean = false;
	private fileStreamSubscription: Subscription | null = null;
	
	public onFilesButtonClick(content: any): void {
		this.openFilesModal(content);
	}
	
	public openFilesModal(content: any): void {
		this.forceCloseTooltips();
		
		if (!this.evenement || !this.evenement.id) {
			console.error('Invalid event in openFilesModal');
			return;
		}
		
		// Cancel any existing file stream subscription to avoid conflicts
		if (this.fileStreamSubscription) {
			this.fileStreamSubscription.unsubscribe();
			this.fileStreamSubscription = null;
		}
		
		// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
		// Don't modify DOM - let Bootstrap handle modal normally
		// CSS will handle blocking scroll via styles.css rule for .files-management-modal
		const savedScrollY = window.scrollY || window.pageYOffset || 
			document.documentElement.scrollTop || 
			document.body.scrollTop || 0;
		
		// Open the modal - CSS will block scroll automatically (like PhotosSelectorModalComponent)
		const modalRef = this.modalService.open(content, { 
			size: 'xl', 
			centered: true, 
			backdrop: 'static', 
			keyboard: false,
			windowClass: 'files-management-modal'
		});
		
		// Immediately maintain scroll position after modal opens to prevent any movement
		// This ensures home-evenement doesn't move when modal opens
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				// Restore scroll position in case Bootstrap tried to scroll
				window.scrollTo(0, savedScrollY);
				document.documentElement.scrollTop = savedScrollY;
				document.body.scrollTop = savedScrollY;
			});
		});
		
		// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
		modalRef.result.finally(() => {
			// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
			const restoreScroll = () => {
				// Restore to saved scroll position - single smooth operation
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto' // Instant, no animation to avoid jumps
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			// Wait for Bootstrap to finish all cleanup, then restore ONCE
			// Use requestAnimationFrame to ensure DOM is ready, then restore
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore after Bootstrap cleanup is complete
					setTimeout(restoreScroll, 300);
				});
			});
		}).catch(() => {
			// Also restore on dismissal
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after a delay
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		});
		
		// Clean up subscription when modal is closed
		modalRef.result.finally(() => {
			if (this.fileStreamSubscription) {
				this.fileStreamSubscription.unsubscribe();
				this.fileStreamSubscription = null;
			}
		}).catch(() => {
			// Modal was dismissed, subscription already cleaned up
		});
		
		// Always reload files from the database to ensure we have the latest data
		// This fixes the issue where new files added after the event was loaded don't appear
		// Use setTimeout to defer the change to avoid ExpressionChangedAfterItHasBeenCheckedError
		setTimeout(() => {
			this.isLoadingFiles = true;
			this.cdr.markForCheck();
		}, 0);
		
		// Wait for modal to be fully rendered before initializing array and starting file load
		setTimeout(() => {
			// Clear existing files and initialize empty array after modal is rendered
			// This ensures we always get fresh data from the database
			if (!this.evenement.fileUploadeds) {
				this.evenement.fileUploadeds = [];
			} else {
				// Clear the array but keep the reference for Angular change detection
				this.evenement.fileUploadeds.length = 0;
			}
			// Defer change detection to next cycle to prevent ExpressionChangedAfterItHasBeenCheckedError
			setTimeout(() => {
				this.cdr.markForCheck();
			}, 0);
			
			if (!this._evenementsService) {
				console.error('_evenementsService is not available!');
				this.isLoadingFiles = false;
				return;
			}
			
			// Stream files using Server-Sent Events (SSE) - files appear as database finds them
			this.fileStreamSubscription = this._evenementsService.streamEventFiles(this.evenement.id).subscribe({
				next: (streamedFile) => {
					if (streamedFile.type === 'total') {
						// Total count received - can be used for progress indication
						const totalCount = streamedFile.data as number;
						// If total is 0, hide loading immediately
						if (totalCount === 0) {
							setTimeout(() => {
								this.isLoadingFiles = false;
								this.cdr.markForCheck();
							}, 0);
						}
					} else if (streamedFile.type === 'file') {
						// File received from database - display it immediately
						const file = streamedFile.data as UploadedFile;
						
						// Ensure array exists
						if (!this.evenement.fileUploadeds) {
							this.evenement.fileUploadeds = [];
						}
						
						// Check if file already exists (avoid duplicates)
						const exists = this.evenement.fileUploadeds.some(f => 
							f.fieldId === file.fieldId || 
							(f.fileName === file.fileName && f.fieldId === file.fieldId)
						);
						
						if (!exists) {
							// Add file to the array immediately (Angular change detection will update the view)
							this.evenement.fileUploadeds.push(file);
							
							// Defer change detection to next cycle to prevent ExpressionChangedAfterItHasBeenCheckedError
							setTimeout(() => {
								this.cdr.markForCheck();
							}, 0);
							
						// Load thumbnail for this file immediately (non-blocking, async)
						// This starts the thumbnail download in parallel without blocking the UI
						if (this.isImageFile(file.fileName)) {
							this.loadFileThumbnail(file);
						} else if (this.isVideoFile(file.fileName)) {
							this.loadVideoThumbnail(file);
						}
						}
					} else if (streamedFile.type === 'complete') {
						// All files have been streamed
						setTimeout(() => {
							this.isLoadingFiles = false;
							this.cdr.markForCheck();
						}, 0);
						console.log(`Completed streaming ${this.evenement.fileUploadeds.length} files for event ${this.evenement.id}`);
						// Auto-expand types with less than 4 elements
						setTimeout(() => {
							this.autoExpandFileTypesWithLessThanFour();
						}, 100);
					} else if (streamedFile.type === 'error') {
						// Error received from server
						console.error('Error from server:', streamedFile.data);
						setTimeout(() => {
							this.isLoadingFiles = false;
							this.cdr.markForCheck();
						}, 0);
					}
				},
				error: (error) => {
					console.error('Error streaming files for event', this.evenement.id, ':', error);
					// Fallback to non-streaming endpoint if streaming fails
					if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
						console.log('Streaming failed, trying fallback endpoint...');
						this.loadFilesFallback();
					} else {
						setTimeout(() => {
							this.isLoadingFiles = false;
							this.cdr.markForCheck();
						}, 0);
					}
				},
				complete: () => {
					// Stream completed - ensure loading is hidden
					setTimeout(() => {
						this.isLoadingFiles = false;
						this.cdr.markForCheck();
					}, 0);
					// Auto-expand types with less than 4 elements
					setTimeout(() => {
						this.autoExpandFileTypesWithLessThanFour();
					}, 100);
				}
			});
		}, 100); // Small delay to ensure modal is fully rendered
	}
	
	// Fallback method to load files using non-streaming endpoint
	private loadFilesFallback(): void {
		if (!this._evenementsService || !this.evenement || !this.evenement.id) {
			setTimeout(() => {
				this.isLoadingFiles = false;
				this.cdr.markForCheck();
			}, 0);
			return;
		}
		
		this._evenementsService.getEventFiles(this.evenement.id).subscribe({
			next: (files: UploadedFile[]) => {
				if (files && files.length > 0) {
					// Ensure array exists
					if (!this.evenement.fileUploadeds) {
						this.evenement.fileUploadeds = [];
					} else {
						this.evenement.fileUploadeds.length = 0;
					}
					
					// Add all files
					files.forEach(file => {
						this.evenement.fileUploadeds.push(file);
						if (this.isImageFile(file.fileName)) {
							this.loadFileThumbnail(file);
						} else if (this.isVideoFile(file.fileName)) {
							this.loadVideoThumbnail(file);
						}
					});
					
					// Defer change detection to next cycle to prevent ExpressionChangedAfterItHasBeenCheckedError
					setTimeout(() => {
						this.cdr.markForCheck();
					}, 0);
					
					console.log(`Loaded ${files.length} files via fallback endpoint for event ${this.evenement.id}`);
					setTimeout(() => {
						this.isLoadingFiles = false;
						this.cdr.markForCheck();
					}, 0);
					
					// Auto-expand types with less than 4 elements
					setTimeout(() => {
						this.autoExpandFileTypesWithLessThanFour();
					}, 100);
				} else {
					console.log(`No files found for event ${this.evenement.id} via fallback endpoint`);
					setTimeout(() => {
						this.isLoadingFiles = false;
						this.cdr.markForCheck();
					}, 0);
				}
			},
			error: (error) => {
				console.error('Error loading files via fallback endpoint:', error);
				setTimeout(() => {
					this.isLoadingFiles = false;
					this.cdr.markForCheck();
				}, 0);
			}
		});
	}
	
	// Load thumbnail for a single file
	private loadFileThumbnail(file: UploadedFile): void {
		if (!file || !this.isImageFile(file.fileName) || !file.fileName) {
			return;
		}
		
		// Skip if already cached or loading
		if (this.fileThumbnailsCache.has(file.fieldId) || this.fileThumbnailsLoading.has(file.fieldId)) {
			return;
		}
		
		// Check if already cached in shared cache
		if (ElementEvenementComponent.isThumbnailCached(file.fieldId)) {
			const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(file.fieldId);
			if (cachedThumbnail) {
				this.fileThumbnailsCache.set(file.fieldId, cachedThumbnail);
				return;
			}
		}
		
		// Check if file is currently being loaded
		if (ElementEvenementComponent.isFileLoading(file.fieldId) || this.fileThumbnailsLoading.has(file.fieldId)) {
			return;
		}
		
		// Mark as loading
		this.fileThumbnailsLoading.add(file.fieldId);
		ElementEvenementComponent.setFileLoading(file.fieldId);
		
		// Track loading start time
		const loadStartTime = performance.now();
		this.fileThumbnailsLoadTimes.set(file.fieldId, { start: loadStartTime, end: 0, fileName: file.fileName, displayed: false });
		
		// Load the file and create thumbnail URL
		this._fileService.getFile(file.fieldId).pipe(
			take(1),
			catchError(error => {
				console.error(`Error loading thumbnail for file ${file.fileName}:`, error);
				this.fileThumbnailsLoading.delete(file.fieldId);
				ElementEvenementComponent.clearFileLoading(file.fieldId);
				return of(null);
			})
		).subscribe({
			next: (blob: Blob | null) => {
				if (blob) {
					// Determine MIME type from file extension for proper image display
					const mimeType = this.getImageMimeType(file.fileName);
					const typedBlob = new Blob([blob], { type: mimeType || 'image/jpeg' });
					const objectUrl = this.nativeWindow.URL.createObjectURL(typedBlob);
					const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
					
					this.fileThumbnailsCache.set(file.fieldId, safeUrl);
					ElementEvenementComponent.setCachedThumbnail(file.fieldId, safeUrl);
					
					// Track loading end time
					const loadEndTime = performance.now();
					const loadTime = loadEndTime - loadStartTime;
					const loadTimeData = this.fileThumbnailsLoadTimes.get(file.fieldId);
					if (loadTimeData) {
						loadTimeData.end = loadEndTime;
						loadTimeData.displayed = true;
					}
				}
				this.fileThumbnailsLoading.delete(file.fieldId);
				ElementEvenementComponent.clearFileLoading(file.fieldId);
			}
		});
	}
	
	// Load thumbnails for all image files
	private loadFileThumbnails(): void {
		if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
			return;
		}
		
		// Filter all image files and load their thumbnails
		const imageFiles = this.evenement.fileUploadeds.filter(file => 
			this.isImageFile(file.fileName) && 
			file.fileName
		);
		
		imageFiles.forEach(file => {
			// Skip if already cached or loading
			if (this.fileThumbnailsCache.has(file.fieldId) || this.fileThumbnailsLoading.has(file.fieldId)) {
				return;
			}
			
			// Check if already cached in shared cache (to avoid duplicate backend request)
			if (ElementEvenementComponent.isThumbnailCached(file.fieldId)) {
				const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(file.fieldId);
				if (cachedThumbnail) {
					// Reuse cached thumbnail from shared cache
					this.fileThumbnailsCache.set(file.fieldId, cachedThumbnail);
					return;
				}
			}
			
			// Check if file is currently being loaded (to prevent duplicate concurrent requests)
			if (ElementEvenementComponent.isFileLoading(file.fieldId) || this.fileThumbnailsLoading.has(file.fieldId)) {
				// File is already being loaded, skip
				return;
			}
			
			// Mark as loading in both local and shared state
			this.fileThumbnailsLoading.add(file.fieldId);
			ElementEvenementComponent.setFileLoading(file.fieldId);
			
			// Track loading start time
			const loadStartTime = performance.now();
			this.fileThumbnailsLoadTimes.set(file.fieldId, { start: loadStartTime, end: 0, fileName: file.fileName, displayed: false });
			
			// Load the file and create thumbnail URL
			this._fileService.getFile(file.fieldId).pipe(
				map((res: any) => {
					// Determine MIME type from file extension for proper image display
					const mimeType = this.getImageMimeType(file.fileName);
					const blob = new Blob([res], { type: mimeType || 'image/jpeg' });
					const objectUrl = this.nativeWindow.URL.createObjectURL(blob);
					return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
				})
			).subscribe({
				next: (safeUrl: SafeUrl) => {
					this.fileThumbnailsCache.set(file.fieldId, safeUrl);
					this.fileThumbnailsLoading.delete(file.fieldId);
					ElementEvenementComponent.clearFileLoading(file.fieldId);
					// Also cache in shared cache to prevent duplicate requests
					ElementEvenementComponent.setCachedThumbnail(file.fieldId, safeUrl);
					// Image display time will be tracked in onFileThumbnailLoaded() when the load event fires
				},
				error: (error) => {
					console.error('Error loading thumbnail for file:', file.fileName, error);
					this.fileThumbnailsLoading.delete(file.fieldId);
					ElementEvenementComponent.clearFileLoading(file.fieldId);
					// Track loading end time even on error
					const loadEndTime = performance.now();
					const loadTime = this.fileThumbnailsLoadTimes.get(file.fieldId);
					if (loadTime) {
						loadTime.end = loadEndTime;
						loadTime.displayed = true;
					}
				}
			});
		});
	}
	
	// Get thumbnail URL for a file (returns cached value or null)
	public getFileThumbnail(fileId: string): SafeUrl | null {
		return this.fileThumbnailsCache.get(fileId) || null;
	}
	
	// Check if thumbnail is loading
	public isThumbnailLoading(fileId: string): boolean {
		return this.fileThumbnailsLoading.has(fileId);
	}

	public isAnyFiles(): boolean {
		return this.evenement.fileUploadeds.length > 0;
	}

	public hasImageFiles(): boolean {
		return this.evenement.fileUploadeds.some(file => this.isImageFile(file.fileName));
	}

	public getImageFilesCount(): number {
		return this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName)).length;
	}

	public isFileOwner(member: Member): boolean {
		let b: boolean = false;
		b = this.user.id == member.id
		return b;
	}
	public open(content: any) {
		this.forceCloseTooltips();
		this.openModalWithScrollPreservation(content, { size: 'lg', centered: true, backdrop: 'static', keyboard: false });
	}

	// Open photo in new tab
	public openPhotoInNewTab(photoUrl: string) {
		this.nativeWindow.open(photoUrl, '_blank');
	}

	hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}

	// Track when file thumbnail is actually displayed
	public onFileThumbnailLoaded(fileId: string): void {
		const loadTime = this.fileThumbnailsLoadTimes.get(fileId);
		if (loadTime && !loadTime.displayed) {
			loadTime.end = performance.now();
			loadTime.displayed = true;
		}
	}

	// Get video thumbnail URL (returns cached value or null)
	// Use ChangeDetectorRef to avoid ExpressionChangedAfterItHasBeenCheckedError
	public getVideoThumbnail(fileId: string): SafeUrl | null {
		const thumbnail = this.videoThumbnailsCache.get(fileId);
		if (thumbnail) {
			return thumbnail;
		}
		// Return null if not cached - this prevents change detection issues
		return null;
	}

	// Check if video thumbnail is loading
	public isVideoThumbnailLoading(fileId: string): boolean {
		return this.videoThumbnailsLoading.has(fileId);
	}

	// Load video thumbnail by capturing a frame from the video
	private loadVideoThumbnail(file: UploadedFile): void {
		if (!file || !this.isVideoFile(file.fileName) || !file.fileName) {
			return;
		}
		
		// Skip if already cached or loading
		if (this.videoThumbnailsCache.has(file.fieldId) || this.videoThumbnailsLoading.has(file.fieldId)) {
			return;
		}

		// Mark as loading
		this.videoThumbnailsLoading.add(file.fieldId);

		// Load the video file
		this._fileService.getFile(file.fieldId).pipe(
			take(1),
			map((res: any) => {
				if (!res) return null;
				// Create a Blob from the response with video MIME type
				// Determine MIME type from file extension
				const mimeType = this.getVideoMimeType(file.fileName);
				return new Blob([res], { type: mimeType || 'video/mp4' });
			}),
			catchError(error => {
				console.error(`Error loading video thumbnail for file ${file.fileName}:`, error);
				this.videoThumbnailsLoading.delete(file.fieldId);
				return of(null);
			})
		).subscribe({
			next: (blob: Blob | null) => {
				if (blob) {
					// Create video element to capture frame
					this.captureVideoFrame(blob, file.fieldId);
				} else {
					this.videoThumbnailsLoading.delete(file.fieldId);
				}
			},
			error: (error) => {
				this.videoThumbnailsLoading.delete(file.fieldId);
			}
		});
	}

	// Capture a frame from video to use as thumbnail
	private captureVideoFrame(blob: Blob, fileId: string): void {
		const video = document.createElement('video');
		const url = this.nativeWindow.URL.createObjectURL(blob);
		video.src = url;
		video.preload = 'metadata'; // Only load metadata, not the entire video
		video.currentTime = 0.1; // Seek to 0.1 second (faster than 1 second)
		video.muted = true;
		video.playsInline = true;

		// Try to capture frame as soon as metadata is loaded
		video.addEventListener('loadedmetadata', () => {
			// Try to seek to a small time to get first frame
			video.currentTime = 0.1;
		}, { once: true });

		video.addEventListener('seeked', () => {
			// Frame is ready after seeking
			if (video.readyState >= 2) {
				this.drawVideoFrame(video, fileId, url);
			}
		}, { once: true });

		// Fallback: if seeked doesn't fire, try loadeddata
		video.addEventListener('loadeddata', () => {
			// Ensure video has loaded enough data
			if (video.readyState >= 2 && video.currentTime >= 0.09) {
				this.drawVideoFrame(video, fileId, url);
			} else {
				video.addEventListener('canplay', () => {
					this.drawVideoFrame(video, fileId, url);
				}, { once: true });
			}
		}, { once: true });

		video.addEventListener('error', () => {
			this.nativeWindow.URL.revokeObjectURL(url);
			const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
			// Use setTimeout to update in next change detection cycle
			setTimeout(() => {
				this.videoThumbnailsCache.set(fileId, defaultUrl);
				this.videoThumbnailsLoading.delete(fileId);
				this.cdr.markForCheck();
			}, 0);
		}, { once: true });

		// Load the video
		video.load();
	}

	// Draw video frame to canvas and create thumbnail
	private drawVideoFrame(video: HTMLVideoElement, fileId: string, blobUrl: string): void {
		// Defer heavy processing to avoid blocking the seeked event handler
		requestAnimationFrame(() => {
			try {
				// Limit thumbnail size for performance (max 200x200px)
				const maxThumbnailSize = 200;
				const videoWidth = video.videoWidth || 320;
				const videoHeight = video.videoHeight || 240;
				
				// Calculate thumbnail dimensions maintaining aspect ratio
				let thumbnailWidth = videoWidth;
				let thumbnailHeight = videoHeight;
				if (videoWidth > maxThumbnailSize || videoHeight > maxThumbnailSize) {
					const ratio = Math.min(maxThumbnailSize / videoWidth, maxThumbnailSize / videoHeight);
					thumbnailWidth = Math.floor(videoWidth * ratio);
					thumbnailHeight = Math.floor(videoHeight * ratio);
				}

				const canvas = document.createElement('canvas');
				canvas.width = thumbnailWidth;
				canvas.height = thumbnailHeight;

				const ctx = canvas.getContext('2d', { willReadFrequently: false });
				if (ctx) {
					// Use faster image rendering settings for thumbnails
					ctx.imageSmoothingEnabled = true;
					ctx.imageSmoothingQuality = 'low'; // Faster than 'high'
					ctx.drawImage(video, 0, 0, thumbnailWidth, thumbnailHeight);
					
					// Convert canvas to blob URL with lower quality for faster processing
					// Use 0.7 quality instead of 0.8 for better performance
					canvas.toBlob((blob) => {
						this.nativeWindow.URL.revokeObjectURL(blobUrl); // Clean up video blob URL
						
						if (blob) {
							const thumbnailUrl = this.nativeWindow.URL.createObjectURL(blob);
							const safeUrl = this.sanitizer.bypassSecurityTrustUrl(thumbnailUrl);
							// Use setTimeout to update in next change detection cycle
							setTimeout(() => {
								this.videoThumbnailsCache.set(fileId, safeUrl);
								this.videoThumbnailsLoading.delete(fileId);
								this.cdr.markForCheck();
							}, 0);
						} else {
							const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
							// Use setTimeout to update in next change detection cycle
							setTimeout(() => {
								this.videoThumbnailsCache.set(fileId, defaultUrl);
								this.videoThumbnailsLoading.delete(fileId);
								this.cdr.markForCheck();
							}, 0);
						}
					}, 'image/jpeg', 0.7); // Lower quality for faster processing
				} else {
					this.nativeWindow.URL.revokeObjectURL(blobUrl);
					const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
					// Use setTimeout to update in next change detection cycle
					setTimeout(() => {
						this.videoThumbnailsCache.set(fileId, defaultUrl);
						this.videoThumbnailsLoading.delete(fileId);
						this.cdr.markForCheck();
					}, 0);
				}
			} catch (error) {
				this.nativeWindow.URL.revokeObjectURL(blobUrl);
				const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
				// Use setTimeout to update in next change detection cycle
				setTimeout(() => {
					this.videoThumbnailsCache.set(fileId, defaultUrl);
					this.videoThumbnailsLoading.delete(fileId);
					this.cdr.markForCheck();
				}, 0);
			}
		});
	}

	// Open JSON modal
	public openJsonModal() {
		this.forceCloseTooltips();
		
		if (this.jsonModal) {
			this.openModalWithScrollPreservation(this.jsonModal, { size: 'lg', backdrop: 'static', keyboard: false });
		} else {
			console.error('JSON modal template not found');
		}
	}

	// Get event as formatted JSON
	public getEventAsJson(): string {
		return JSON.stringify(this.evenement, null, 2);
	}

	// Rate functions
	public addRatePlus() {
		this.evenement.ratingPlus = this.evenement.ratingPlus + 1;
		this.currentRate = (this.evenement.ratingPlus) / (this.evenement.ratingMinus + this.evenement.ratingPlus) * 10;
		this.updateEvenement.emit(this.evenement);
	};
	public addRateMinus() {
		this.evenement.ratingMinus = this.evenement.ratingMinus + 1;
		this.currentRate = (this.evenement.ratingPlus) / (this.evenement.ratingMinus + this.evenement.ratingPlus) * 10;
		this.updateEvenement.emit(this.evenement);
	}
	// Get the file url with the bearer token for authentication
	// Returns original file
	public getFileBlobUrl(fileId: string): Observable<any> {
		return this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				// Note: HttpClient returns the body directly, not as res._body
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		);
	}
	// Open window when click on associate button
	public openWindows(fileId: string, fileName: string) {
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			//IE11 & Edge
			if ((navigator as any).msSaveBlob) {
				(navigator as any).msSaveBlob(blob, fileName);
			} else {
				let natw = this.nativeWindow;
				//In FF link must be added to DOM to be clicked
				let link = natw.document.createElement('a');
				let objectUrl = natw.URL.createObjectURL(blob);
				link.href = objectUrl;
				// this method allow to give a name to the file
				link.setAttribute('download', fileName);
				natw.document.body.appendChild(link);
				link.click();
				setTimeout(function () {
					natw.document.body.removeChild(link);
					natw.URL.revokeObjectURL(objectUrl);
				}, 5000);
			}
		}
		);
	}

	// Download all files from the event as a single ZIP file
	public async downloadAllFiles(): Promise<void> {
		if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
			alert('Aucun fichier à télécharger');
			return;
		}

		// Show loading message
		const loadingMessage = `Téléchargement de ${this.evenement.fileUploadeds.length} fichier(s)...`;
		
		try {
			// Create a new ZIP file
			const zip = new JSZip();
			let successCount = 0;
			
			// Download all files and add them to the ZIP
			const downloadPromises = this.evenement.fileUploadeds.map(async (file) => {
				try {
					const blob = await firstValueFrom(this.getFileBlobUrl(file.fieldId));
					zip.file(file.fileName, blob);
					successCount++;
				} catch (error) {
					console.error(`Error fetching file ${file.fileName}:`, error);
				}
			});
			
			// Wait for all files to be added to the ZIP
			await Promise.all(downloadPromises);
			
			if (successCount === 0) {
				alert('Aucun fichier n\'a pu être téléchargé');
				return;
			}
			
			// Generate the ZIP file
			const zipBlob = await zip.generateAsync({ type: 'blob' });
			
			// Create a download link and trigger download
			const zipFileName = `${this.evenement.evenementName}_files_${new Date().getTime()}.zip`;
			const url = window.URL.createObjectURL(zipBlob);
			const link = document.createElement('a');
			link.href = url;
			link.download = zipFileName;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Error creating ZIP file:', error);
			alert('Erreur lors de la création du fichier ZIP');
		}
	}


	// Add "thumbnail" to the middle of the filename
	private addThumbnailToFileName(originalName: string): string {
		const lastDotIndex = originalName.lastIndexOf('.');
		
		if (lastDotIndex === -1) {
			// No extension found, just add thumbnail at the end
			return originalName + '_thumbnail';
		}
		
		const nameWithoutExtension = originalName.substring(0, lastDotIndex);
		const extension = originalName.substring(lastDotIndex);
		
		// Add thumbnail in the middle of the name
		const middleIndex = Math.floor(nameWithoutExtension.length / 2);
		const modifiedName = nameWithoutExtension.substring(0, middleIndex) + 
							 'thumbnail' + 
							 nameWithoutExtension.substring(middleIndex) + 
							 extension;
		
		return modifiedName;
	}

	private ensureThumbnailInFileName(fileName: string): string {
		if (!fileName) {
			return fileName;
		}
		if (fileName.toLowerCase().includes('thumbnail')) {
			return fileName;
		}
		return this.addThumbnailToFileName(fileName);
	}

	private stripThumbnailFromFileName(fileName: string): string {
		if (!fileName) {
			return fileName;
		}

		const lastDotIndex = fileName.lastIndexOf('.');
		const extension = lastDotIndex >= 0 ? fileName.substring(lastDotIndex) : '';
		const baseName = lastDotIndex >= 0 ? fileName.substring(0, lastDotIndex) : fileName;

		let sanitizedBase = baseName.replace(/thumbnail/gi, '');

		// Clean up duplicate separators or trailing separators left by removal
		sanitizedBase = sanitizedBase
			.replace(/\s{2,}/g, ' ')
			.replace(/__+/g, '_')
			.replace(/--+/g, '-')
			.replace(/[_\-\s]+\./g, '.')
			.replace(/(^[\s._-]+|[\s._-]+$)/g, '');

		if (!sanitizedBase) {
			sanitizedBase = 'file';
		}

		return sanitizedBase + extension;
	}

	private removeThumbnailFromOtherFiles(excludedFieldId: string): boolean {
		if (!this.evenement || !this.evenement.fileUploadeds) {
			return false;
		}

		let modified = false;
		this.evenement.fileUploadeds.forEach(file => {
			if (
				file.fieldId !== excludedFieldId &&
				file.fileName &&
				file.fileName.toLowerCase().includes('thumbnail')
			) {
				const newName = this.stripThumbnailFromFileName(file.fileName);
				if (newName !== file.fileName) {
					file.fileName = newName;
					modified = true;
				}
			}
		});
		return modified;
	}

	public setFileAsThumbnail(uploadedFile: UploadedFile): void {
		if (
			!uploadedFile ||
			!this.evenement ||
			!this.evenement.fileUploadeds ||
			!this.isImageFile(uploadedFile.fileName)
		) {
			return;
		}

		let hasChanges = false;

		const updatedName = this.ensureThumbnailInFileName(uploadedFile.fileName);
		if (updatedName !== uploadedFile.fileName) {
			uploadedFile.fileName = updatedName;
			hasChanges = true;
		}

		if (this.removeThumbnailFromOtherFiles(uploadedFile.fieldId)) {
			hasChanges = true;
		}

		// Set the file as thumbnail in the thumbnail field
		this.evenement.thumbnail = uploadedFile;
		hasChanges = true;

		if (hasChanges) {
			// Invalidate cache immediately to prepare for reload
			this.invalidateThumbnailCache();
			
			// Save the event to update fileUploadeds and thumbnail field on backend
			this._evenementsService.put4FileEvenement(this.evenement).subscribe({
				next: (updatedEvent: Evenement) => {
					// Update local event with response from server
					if (updatedEvent) {
						// Update all fields from server response
						this.evenement = updatedEvent;
						// Ensure thumbnail is set from server response (backend should have set it based on file name)
						if (updatedEvent.thumbnail) {
							this.evenement.thumbnail = updatedEvent.thumbnail;
						} else {
							// Backend should have set it, but if not, use the file we just set
							// Find the thumbnail file in fileUploadeds
							const thumbnailInFiles = this.evenement.fileUploadeds.find(f => 
								f.fileName && f.fileName.toLowerCase().includes('thumbnail')
							);
							if (thumbnailInFiles) {
								this.evenement.thumbnail = thumbnailInFiles;
							}
						}
					}
					// Force reload by directly loading the thumbnail image
					// Use setTimeout to ensure DOM is ready and cache is cleared
					setTimeout(() => {
						const thumbnailFile = this.evenement.thumbnail;
						if (thumbnailFile && thumbnailFile.fieldId) {
							// Directly load the image, bypassing cache
							this.loadThumbnailImage(thumbnailFile.fieldId, thumbnailFile.fileName);
						} else {
							// No thumbnail, reset to default
							this.thumbnailUrl = ElementEvenementComponent.getDefaultPlaceholderImage(this.sanitizer);
							this.reloadEventCard();
						}
					}, 150);
				},
				error: (error: any) => {
					console.error('Error updating event thumbnail:', error);
					// Still reload the card even if save failed (local changes)
					setTimeout(() => {
						const thumbnailFile = this.evenement.thumbnail;
						if (thumbnailFile && thumbnailFile.fieldId) {
							// Directly load the image even if save failed
							this.loadThumbnailImage(thumbnailFile.fieldId, thumbnailFile.fileName);
						} else {
							this.reloadEventCard();
						}
					}, 150);
				}
			});
		}
	}

	public isThumbnailFile(uploadedFile: UploadedFile | null | undefined): boolean {
		const name = uploadedFile && uploadedFile.fileName ? uploadedFile.fileName.toLowerCase() : '';
		return name.includes('thumbnail');
	}

	// Invalidate thumbnail cache to force reload
	private invalidateThumbnailCache(): void {
		const cacheKey = this.getCacheKey();
		if (cacheKey) {
			ElementEvenementComponent.thumbnailCache.delete(cacheKey);
		}
		// Clear blob URL cache for current thumbnail if exists
		if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
			ElementEvenementComponent.blobUrlCache.delete(this.evenement.thumbnail.fieldId);
			// Also clear loading state
			ElementEvenementComponent.clearFileLoading(this.evenement.thumbnail.fieldId);
		}
		// Also clear blob cache to force reload from server
		if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
			ElementEvenementComponent.blobCache.delete(this.evenement.thumbnail.fieldId);
		}
		// Reset thumbnail URL to force reload
		this.thumbnailUrl = ElementEvenementComponent.getDefaultPlaceholderImage(this.sanitizer);
		// Reset portrait detection
		this.isThumbnailPortrait = false;
		this.thumbnailImageWidth = 0;
		this.thumbnailDisplayedWidth = 0;
	}

	// Reload the event card thumbnail when a thumbnail file is uploaded/deleted
	private reloadEventCard(): void {
		// Invalidate cache first to ensure fresh load
		this.invalidateThumbnailCache();
		
		// Use the thumbnail field directly
		const thumbnailFile = this.evenement.thumbnail;
		
		if (thumbnailFile && thumbnailFile.fieldId) {
			// Small delay to ensure cache is cleared before reloading
			setTimeout(() => {
				// Force reload by directly loading the thumbnail image
				// Don't use setThumbnailImage() as it checks cache first
				// Instead, directly load the image
				this.loadThumbnailImage(thumbnailFile.fieldId, thumbnailFile.fileName);
			}, 100);
		} else {
			// Reset to default image if no thumbnail file exists
			this.thumbnailUrl = ElementEvenementComponent.getDefaultPlaceholderImage(this.sanitizer);
			// Reset to default color
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			// Use unified inverse text color for default (medium brightness = bright, so dark text)
			this.titleBorderColor = 'rgba(2, 6, 23, 0.95)';
			this.descriptionBackgroundColor = 'rgba(255, 255, 255, 1)';
			this.calculatedRgbValues = 'RGB(255, 255, 255)';
			// Try to detect color from default image
			setTimeout(() => {
				this.detectDominantColor();
			}, 100);
			this.invalidateColorCaches();
		}
		
		// Emit an event to the parent component to update the event data
		this.updateEvenement.emit(this.evenement);
	}

	getUrlTypeLabel(typeId: string): string {
		// Normaliser le type en supprimant les espaces et en convertissant en majuscules
		const normalizedType = typeId?.trim().toUpperCase() || 'OTHER';
		
		const urlEventTypes = [
			{id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
			{id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
			{id: "FICHE", label: "EVENTHOME.URL_TYPE_FICHE", aliases: ["FICHE", "SHEET", "FICHA", "BLATT", "シート", "表格", "نشرة"]},
			{id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]},
			{id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
			{id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]}
		];
		
		// Search first by exact ID
		let type = urlEventTypes.find(t => t.id === normalizedType);
		
		// If not found, search in aliases
		if (!type) {
			type = urlEventTypes.find(t => 
				t.aliases.some(alias => alias.toUpperCase() === normalizedType)
			);
		}
		
		// If still not found, search for partial match
		if (!type) {
			type = urlEventTypes.find(t => 
				t.id.includes(normalizedType) || 
				normalizedType.includes(t.id) ||
				t.aliases.some(alias => 
					alias.includes(normalizedType) || 
					normalizedType.includes(alias)
				)
			);
		}
		
		return type ? type.label : normalizedType;
	}

	// Get URL event icon based on type
	public getUrlEventIcon(urlEvent: any): string {
		if (!urlEvent || !urlEvent.typeUrl) {
			return 'fa fa-external-link';
		}
		
		const normalizedType = urlEvent.typeUrl.trim().toUpperCase();
		
		// Check for MAP
		if (normalizedType === 'MAP' || normalizedType === 'CARTE') {
			return 'fa fa-map';
		}
		
		// Check for WEBSITE
		if (normalizedType === 'WEBSITE' || normalizedType === 'SITE' || normalizedType === 'WEB') {
			return 'fa fa-globe';
		}
		
		// Check for DOCUMENTATION
		if (normalizedType === 'DOCUMENTATION' || normalizedType === 'DOC') {
			return 'fa fa-file-alt';
		}
		
		// Check for PHOTOS
		if (normalizedType === 'PHOTOS' || normalizedType === 'PHOTO') {
			return 'fa fa-images';
		}
		
		// Check for PHOTOFROMFS
		if (normalizedType === 'PHOTOFROMFS') {
			return 'fa fa-image';
		}
		
		// Check for VIDEO
		if (normalizedType === 'VIDEO' || normalizedType === 'VIDÉO' || normalizedType === 'YOUTUBE' || normalizedType === 'VIMEO') {
			return 'fa fa-video-camera';
		}
		
		// Check for WHATSAPP
		if (normalizedType === 'WHATSAPP' || normalizedType === 'WA') {
			return 'fa fa-whatsapp';
		}
		
		// Default
		return 'fa fa-external-link';
	}

	// Group URLs by type for better display
	public getGroupedUrlEvents(): { [key: string]: any[] } {
		if (!this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
			return {};
		}
		
		// Filter out photo-related links (PHOTOS and PHOTOFROMFS)
		const nonPhotoUrls = this.evenement.urlEvents.filter(u => {
			const type = (u.typeUrl || '').toUpperCase().trim();
			return type !== 'PHOTOS' && type !== 'PHOTOFROMFS';
		});
		
		return nonPhotoUrls.reduce((groups: { [key: string]: any[] }, urlEvent) => {
			// Normalize type for grouping
			const normalizedType = this.normalizeTypeForGrouping(urlEvent.typeUrl || 'OTHER');
			if (!groups[normalizedType]) {
				groups[normalizedType] = [];
			}
			groups[normalizedType].push(urlEvent);
			return groups;
		}, {});
	}

	// Normalize type for grouping (uses same logic as getUrlTypeLabel)
	private normalizeTypeForGrouping(typeId: string): string {
		const normalizedType = typeId?.trim().toUpperCase() || 'OTHER';
		
		const urlEventTypes = [
			{id: "MAP", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
			{id: "DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
			{id: "FICHE", aliases: ["FICHE", "SHEET", "FICHA", "BLATT", "シート", "表格", "نشرة"]},
			{id: "OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]},
			{id: "PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
			{id: "WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]}
		];
		
		// Chercher d'abord par ID exact
		let type = urlEventTypes.find(t => t.id === normalizedType);
		
		// Si pas trouvé, chercher dans les alias
		if (!type) {
			type = urlEventTypes.find(t => 
				t.aliases.some(alias => alias.toUpperCase() === normalizedType)
			);
		}
		
		// Si toujours pas trouvé, chercher une correspondance partielle
		if (!type) {
			type = urlEventTypes.find(t => 
				t.id.includes(normalizedType) || 
				normalizedType.includes(t.id) ||
				t.aliases.some(alias => 
					alias.includes(normalizedType) || 
					normalizedType.includes(alias)
				)
			);
		}
		
		return type ? type.id : 'OTHER';
	}

	// Get sorted type keys for consistent display order
	public getSortedTypeKeys(): string[] {
		const grouped = this.getGroupedUrlEvents();
		const typeOrder = ['MAP', 'DOCUMENTATION', 'FICHE', 'WEBSITE', 'PHOTOS', 'Photos', 'OTHER'];
		return typeOrder.filter(type => grouped[type] && grouped[type].length > 0);
	}

	// File grouping methods
	public getGroupedFiles(): { [key: string]: any[] } {
		if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
			return {};
		}
		
		return this.evenement.fileUploadeds.reduce((groups: { [key: string]: any[] }, file) => {
			const typeKey = this.getFileTypeKey(file.fileName || '');
			if (!groups[typeKey]) {
				groups[typeKey] = [];
			}
			groups[typeKey].push(file);
			return groups;
		}, {});
	}

	// Get sorted file type keys for consistent display order
	public getSortedFileTypeKeys(): string[] {
		const grouped = this.getGroupedFiles();
		const typeOrder = ['image', 'video', 'pdf', 'track', 'other'];
		return typeOrder.filter(type => grouped[type] && grouped[type].length > 0);
	}

	// Get translated label for file type
	public getFileTypeLabel(typeKey: string): string {
		const labels: { [key: string]: string } = {
			'image': 'EVENTELEM.FILE_TYPE_IMAGE',
			'video': 'EVENTELEM.FILE_TYPE_VIDEO',
			'pdf': 'EVENTELEM.FILE_TYPE_PDF',
			'track': 'EVENTELEM.FILE_TYPE_TRACK',
			'other': 'EVENTELEM.FILE_TYPE_OTHER'
		};
		return labels[typeKey] || 'EVENTELEM.FILE_TYPE_OTHER';
	}

	// File type expansion state management
	private expandedFileTypes: Map<string, boolean> = new Map();

	// Toggle expanded state for a file type
	public toggleFileTypeExpansion(typeKey: string): void {
		const currentState = this.expandedFileTypes.get(typeKey) || false;
		this.expandedFileTypes.set(typeKey, !currentState);
	}

	// Check if a file type is expanded
	public isFileTypeExpanded(typeKey: string): boolean {
		return this.expandedFileTypes.get(typeKey) || false;
	}

	// Auto-expand file types that have less than 4 elements
	private autoExpandFileTypesWithLessThanFour(): void {
		// Use requestAnimationFrame to ensure this runs after render to avoid ExpressionChangedAfterItHasBeenCheckedError
		requestAnimationFrame(() => {
			const groupedFiles = this.getGroupedFiles();
			const typeKeys = this.getSortedFileTypeKeys();
			
			// Only modify state if there are actual changes
			let hasChanges = false;
			typeKeys.forEach(typeKey => {
				const files = groupedFiles[typeKey];
				if (files && files.length > 0 && files.length < 4) {
					// Only set if not already expanded to avoid unnecessary changes
					if (!this.expandedFileTypes.get(typeKey)) {
						this.expandedFileTypes.set(typeKey, true);
						hasChanges = true;
					}
				}
			});
			
			// Mark for change detection on next cycle only if there were changes
			if (hasChanges) {
				this.cdr.markForCheck();
			}
		});
	}

	// Commentary management methods
	public newCommentary: Commentary = new Commentary("", "", new Date());
	public isAddingCommentary: boolean = false;

	// Initialize commentaries if not present
	public initializeCommentaries(): void {
		if (!this.evenement.commentaries) {
			this.evenement.commentaries = [];
		}
	}

	// Add a new commentary
	public addCommentary(): void {
		if (this.newCommentary.commentary && this.newCommentary.commentary.trim() !== '') {
			// Create a new Commentary instance
			const commentary = new Commentary(
				this.user.userName, // Use current user as owner
				this.newCommentary.commentary.trim(),
				new Date() // Use current date
			);
			
			this.initializeCommentaries();
			this.evenement.commentaries.push(commentary);
			
			// Reset the form
			this.newCommentary = new Commentary("", "", new Date());
			this.isAddingCommentary = false;
			
			// Emit update event to save changes
			this.updateEvenement.emit(this.evenement);
		}
	}

	// Cancel adding commentary
	public cancelAddCommentary(): void {
		this.newCommentary = new Commentary("", "", new Date());
		this.isAddingCommentary = false;
	}

	// Delete a commentary
	public deleteCommentary(index: number): void {
		if (confirm("Are you sure you want to delete this commentary?")) {
			if (index >= 0 && index < this.evenement.commentaries.length) {
				this.evenement.commentaries.splice(index, 1);
				this.updateEvenement.emit(this.evenement);
			}
		}
	}

	// Check if user can delete commentary (only owner of the commentary)
	public canDeleteCommentary(commentary: Commentary): boolean {
		return this.user.userName.toLowerCase() === commentary.commentOwner.toLowerCase();
	}

	// Format date for display
	public formatCommentaryDate(date: Date): string {
		if (!date) return '';
		
		const commentaryDate = new Date(date);
		
		// Map current language to appropriate locale
		const currentLang = this.translateService.currentLang || 'fr';
		const localeMap: { [key: string]: string } = {
			'fr': 'fr-FR',
			'en': 'en-US',
			'es': 'es-ES',
			'de': 'de-DE',
			'it': 'it-IT',
			'ru': 'ru-RU',
			'jp': 'ja-JP',
			'cn': 'zh-CN',
			'ar': 'ar-SA',
			'el': 'el-GR',
			'he': 'he-IL',
			'in': 'hi-IN'
		};
		
		const locale = localeMap[currentLang] || 'fr-FR';
		
		// Format date and time according to selected language locale
		return commentaryDate.toLocaleString(locale, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Format event date with locale
	public formatEventDate(date: Date): string {
		if (!date) return '';
		
		const eventDate = new Date(date);
		
		// Map current language to appropriate locale
		const currentLang = this.translateService.currentLang || 'fr';
		const localeMap: { [key: string]: string } = {
			'fr': 'fr-FR',
			'en': 'en-US',
			'es': 'es-ES',
			'de': 'de-DE',
			'it': 'it-IT',
			'ru': 'ru-RU',
			'jp': 'ja-JP',
			'cn': 'zh-CN',
			'ar': 'ar-SA',
			'el': 'el-GR',
			'he': 'he-IL',
			'in': 'hi-IN'
		};
		
		const locale = localeMap[currentLang] || 'fr-FR';
		
		// Format date according to selected language locale
		return eventDate.toLocaleDateString(locale, {
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		});
	}

	// Format event date with time for card view
	public formatEventDateTime(date: Date, time: string): string {
		if (!date) return '';
		
		const eventDate = new Date(date);
		
		// Map current language to appropriate locale
		const currentLang = this.translateService.currentLang || 'fr';
		const localeMap: { [key: string]: string } = {
			'fr': 'fr-FR',
			'en': 'en-US',
			'es': 'es-ES',
			'de': 'de-DE',
			'it': 'it-IT',
			'ru': 'ru-RU',
			'jp': 'ja-JP',
			'cn': 'zh-CN',
			'ar': 'ar-SA',
			'el': 'el-GR',
			'he': 'he-IL',
			'in': 'hi-IN'
		};
		
		const locale = localeMap[currentLang] || 'fr-FR';
		
		// Format date according to selected language locale
		const formattedDate = eventDate.toLocaleDateString(locale, {
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		});
		
		// Extract time from date if startHour is empty
		let timeToDisplay = time;
		if (!timeToDisplay || timeToDisplay.trim() === '') {
			timeToDisplay = eventDate.toLocaleTimeString(locale, {
				hour: '2-digit',
				minute: '2-digit'
			});
		}
		
		// Add time if it exists
		if (timeToDisplay && timeToDisplay.trim() !== '') {
			return `${formattedDate} ${this.translateService.instant('COMMUN.AT')} ${timeToDisplay}`;
		}
		
		return formattedDate;
	}

	// Get event thumbnail (similar to home-evenements)
	public getEventThumbnail(): SafeUrl {
		// Return the current thumbnailUrl which is already a SafeUrl
		return this.thumbnailUrl;
	}

	// Check if file is an image based on extension
	public isImageFile(fileName: string): boolean {
		if (!fileName) return false;
		
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
		const lowerFileName = fileName.toLowerCase();
		
		return imageExtensions.some(ext => lowerFileName.endsWith(ext));
	}

	// Get MIME type for image files based on extension
	private getImageMimeType(fileName: string): string {
		if (!fileName) return 'image/jpeg';
		
		const lowerFileName = fileName.toLowerCase();
		if (lowerFileName.endsWith('.jpg') || lowerFileName.endsWith('.jpeg')) {
			return 'image/jpeg';
		} else if (lowerFileName.endsWith('.png')) {
			return 'image/png';
		} else if (lowerFileName.endsWith('.gif')) {
			return 'image/gif';
		} else if (lowerFileName.endsWith('.bmp')) {
			return 'image/bmp';
		} else if (lowerFileName.endsWith('.webp')) {
			return 'image/webp';
		} else if (lowerFileName.endsWith('.svg')) {
			return 'image/svg+xml';
		}
		return 'image/jpeg';
	}

	private getVideoMimeType(fileName: string): string {
		if (!fileName) return 'video/mp4';
		
		const lowerFileName = fileName.toLowerCase();
		if (lowerFileName.endsWith('.mp4')) {
			return 'video/mp4';
		} else if (lowerFileName.endsWith('.webm')) {
			return 'video/webm';
		} else if (lowerFileName.endsWith('.ogg') || lowerFileName.endsWith('.ogv')) {
			return 'video/ogg';
		} else if (lowerFileName.endsWith('.mov')) {
			return 'video/quicktime';
		} else if (lowerFileName.endsWith('.avi')) {
			return 'video/x-msvideo';
		} else if (lowerFileName.endsWith('.mkv')) {
			return 'video/x-matroska';
		} else if (lowerFileName.endsWith('.flv')) {
			return 'video/x-flv';
		} else if (lowerFileName.endsWith('.wmv')) {
			return 'video/x-ms-wmv';
		} else if (lowerFileName.endsWith('.m4v')) {
			return 'video/x-m4v';
		} else if (lowerFileName.endsWith('.3gp')) {
			return 'video/3gpp';
		}
		return 'video/mp4';
	}

	// Check if file is a PDF based on extension
	public isPdfFile(fileName: string): boolean {
		if (!fileName) return false;
		
		const lowerFileName = fileName.toLowerCase();
		return lowerFileName.endsWith('.pdf');
	}

	// Check if file is a GPS track (GPX, KML, GeoJSON, TCX)
	public isTrackFile(fileName: string): boolean {
		if (!fileName) return false;

		const trackExtensions = ['.gpx', '.kml', '.geojson', '.tcx'];
		const lowerFileName = fileName.toLowerCase();
		return trackExtensions.some(ext => lowerFileName.endsWith(ext));
	}

	// Check if file is a video based on extension
	public isVideoFile(fileName: string): boolean {
		if (!fileName) return false;
		
		const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'];
		const lowerFileName = fileName.toLowerCase();
		
		return videoExtensions.some(ext => lowerFileName.endsWith(ext));
	}

	// Handle file click based on file type
	public handleFileClick(uploadedFile: UploadedFile): void {
		if (this.isImageFile(uploadedFile.fileName)) {
			this.openSingleImageInSlideshow(uploadedFile.fieldId, uploadedFile.fileName);
		} else if (this.isVideoFile(uploadedFile.fileName)) {
			this.openSingleVideoInVideoshow(uploadedFile.fieldId, uploadedFile.fileName);
		} else if (this.isPdfFile(uploadedFile.fileName)) {
			this.openPdfFile(uploadedFile.fieldId, uploadedFile.fileName);
		} else if (this.isTrackFile(uploadedFile.fileName)) {
			this.openTrackFile(uploadedFile);
		}
	}

	// Get appropriate tooltip for file
	public getFileTooltip(fileName: string): string | null {
		if (this.isImageFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_VIEW');
		} else if (this.isVideoFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_VIEW_VIDEO') || 'Click to view video';
		} else if (this.isPdfFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_OPEN_PDF');
		} else if (this.isTrackFile(fileName)) {
			return this.translateService.instant('EVENTELEM.VIEW_TRACK');
		}
		return null;
	}

	public openTrackFile(uploadedFile: UploadedFile): void {
		if (!uploadedFile || !uploadedFile.fieldId) {
			return;
		}

		this.forceCloseTooltips();

		if (this.traceViewerModalComponent) {
			// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
			// CSS will handle blocking scroll via styles.css rule
			const savedScrollY = window.scrollY || window.pageYOffset || 
				document.documentElement.scrollTop || 
				document.body.scrollTop || 0;
			this.savedScrollPosition = savedScrollY;
			
			this.traceViewerModalComponent.openFromFile(uploadedFile.fieldId, uploadedFile.fileName);
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo(0, savedScrollY);
					document.documentElement.scrollTop = savedScrollY;
					document.body.scrollTop = savedScrollY;
				});
			});
			
			// Store restore function
			this.scrollRestoreFunction = () => {
				// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.overflowX = '';
					document.body.style.overflowY = '';
					document.body.style.position = '';
					document.body.style.height = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
					document.documentElement.style.overflowX = '';
					document.documentElement.style.overflowY = '';
				}
				
				// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
				const restoreScroll = () => {
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
				};
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						setTimeout(restoreScroll, 300);
					});
				});
			};
		} else {
			console.warn('Track viewer modal component is not available');
		}
	}

	// Open PDF file in new tab
	public openPdfFile(fileId: string, fileName: string): void {
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			// Create a new blob with proper MIME type for PDF
			const pdfBlob = new Blob([blob], { type: 'application/pdf' });
			
			// Create object URL for the blob
			const objectUrl = URL.createObjectURL(pdfBlob);
			
			// Open PDF in new tab with optimized parameters
			const newWindow = window.open(objectUrl, '_blank', 'width=1200,height=800,scrollbars=yes,resizable=yes,toolbar=yes,menubar=yes');
			
			// Focus the new window
			if (newWindow) {
				newWindow.focus();
			}
			
			// Clean up the URL after a delay to allow the browser to load it
			setTimeout(() => {
				URL.revokeObjectURL(objectUrl);
			}, 10000);
		}, (error) => {
			alert('Erreur lors du chargement du fichier PDF');
		});
	}

	// Check if a File object is an image based on MIME type
	private isImageFileByMimeType(file: File): boolean {
		const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'];
		return imageTypes.includes(file.type.toLowerCase());
	}

	// Truncate file name to 15 characters for display
	public getTruncatedFileName(fileName: string, maxLength: number = 15): string {
		if (!fileName) return '';
		if (fileName.length <= maxLength) return fileName;
		// Keep extension if possible
		const lastDotIndex = fileName.lastIndexOf('.');
		if (lastDotIndex > 0) {
			const nameWithoutExt = fileName.substring(0, lastDotIndex);
			const extension = fileName.substring(lastDotIndex);
			// If extension is short enough, keep it
			if (extension.length < maxLength - 3) {
				const truncatedName = nameWithoutExt.substring(0, maxLength - extension.length - 3) + '...';
				return truncatedName + extension;
			}
		}
		return fileName.substring(0, maxLength - 3) + '...';
	}

	// Truncate URL for display while keeping start and end visible
	public getTruncatedUrl(link: string, maxLength: number = 30): string {
		if (!link) return '';
		if (link.length <= maxLength) return link;

		const ellipsis = '...';
		const available = maxLength - ellipsis.length;

		if (available <= 0) {
			return ellipsis;
		}

		const startLength = Math.ceil(available / 2);
		const endLength = Math.floor(available / 2);

		const start = link.substring(0, startLength);
		const end = link.substring(link.length - endLength);
		return `${start}${ellipsis}${end}`;
	}

	
	ngOnDestroy() {
		// Stop card slideshow if active
		this.stopCardSlideshow();
		
		// Stop main slideshow if active
		if (this.slideshowInterval) {
			clearInterval(this.slideshowInterval);
			this.slideshowInterval = null;
		}
		
		// Remove keyboard listener
		this.removeKeyboardListener();
		
		// Clean up polling interval
		if (this.pollIntervalId) {
			clearInterval(this.pollIntervalId);
			this.pollIntervalId = null;
		}
		
		// Clean up all timeouts
		this.activeTimeouts.forEach(timeoutId => {
			clearTimeout(timeoutId);
		});
		this.activeTimeouts.clear();
		
		// Unsubscribe from all subscriptions
		this.allSubscriptions.forEach(sub => {
			if (!sub.closed) {
				sub.unsubscribe();
			}
		});
		this.allSubscriptions = [];
		
		// Unsubscribe from card slideshow subscriptions
		this.cardSlideshowSubscriptions.forEach(sub => {
			if (!sub.closed) {
				sub.unsubscribe();
			}
		});
		this.cardSlideshowSubscriptions = [];
		
		// Unsubscribe from FS slideshow subscriptions
		this.fsSlideshowSubs.forEach(sub => {
			if (!sub.closed) {
				sub.unsubscribe();
			}
		});
		this.fsSlideshowSubs = [];
		
		// Clean up fullscreen event listeners
		this.fullscreenListeners.forEach(listener => {
			listener.element.removeEventListener(listener.event, listener.handler);
		});
		this.fullscreenListeners = [];
		
		// Clean up image load handlers
		this.imageLoadHandlers.forEach(({ element, handler }) => {
			try {
				element.removeEventListener('load', handler);
			} catch (e) {
				// Ignore errors if element is already removed
			}
		});
		this.imageLoadHandlers = [];
		
		// Don't revoke blob URLs if they're in the persistent cache
		// This allows them to be reused when components are recreated
		if (this.thumbnailUrl && typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl) {
			try {
				const url = this.thumbnailUrl['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					// Check if this blob URL is in the persistent cache
					const thumbnailFile = this.evenement.thumbnail;
					if (thumbnailFile && thumbnailFile.fieldId) {
						const cachedBlobUrl = ElementEvenementComponent.blobUrlCache.get(thumbnailFile.fieldId);
						// Only revoke if it's not in the persistent cache
						if (cachedBlobUrl !== this.thumbnailUrl) {
							this.nativeWindow.URL.revokeObjectURL(url);
						}
						// If it is in cache, keep it for reuse
					} else {
						// No thumbnail file found, safe to revoke
						this.nativeWindow.URL.revokeObjectURL(url);
					}
				}
			} catch (error) {
			}
		}
		
		// Clean up file thumbnails cache
		this.fileThumbnailsCache.forEach((safeUrl) => {
			try {
				if (safeUrl && typeof safeUrl === 'object' && 'changingThisBreaksApplicationSecurity' in safeUrl) {
					const url = safeUrl['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						this.nativeWindow.URL.revokeObjectURL(url);
					}
				}
			} catch (error) {
				console.warn('Error cleaning up file thumbnail blob URL:', error);
			}
		});
		this.fileThumbnailsCache.clear();
		this.fileThumbnailsLoading.clear();

		// Clean up video thumbnails cache
		this.videoThumbnailsCache.forEach((safeUrl) => {
			try {
				if (safeUrl && typeof safeUrl === 'object' && 'changingThisBreaksApplicationSecurity' in safeUrl) {
					const url = safeUrl['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						this.nativeWindow.URL.revokeObjectURL(url);
					}
				}
			} catch (error) {
				console.warn('Error cleaning up video thumbnail blob URL:', error);
			}
		});
		this.videoThumbnailsCache.clear();
		this.videoThumbnailsLoading.clear();
		
		// Clean up card slide images blob URLs
		this.cardSlideImages.forEach(blobUrl => {
			try {
				if (blobUrl && typeof blobUrl === 'string' && blobUrl.startsWith('blob:')) {
					URL.revokeObjectURL(blobUrl);
				}
			} catch (error) {
				console.warn('Error cleaning up card slide blob URL:', error);
			}
		});
		this.cardSlideImages = [];
		this.cardSlideFileNames = [];

		if (this.tooltipMutationObserver) {
			this.tooltipMutationObserver.disconnect();
			this.tooltipMutationObserver = undefined;
		}
		if (this.tooltipShowListener) {
			document.removeEventListener('show.bs.modal', this.tooltipShowListener, true);
			this.tooltipShowListener = undefined;
		}
		if (this.tooltipShownListener) {
			document.removeEventListener('shown.bs.modal', this.tooltipShownListener, true);
			this.tooltipShownListener = undefined;
		}
		if (this.tooltipDocClickListener) {
			document.removeEventListener('click', this.tooltipDocClickListener, true);
			this.tooltipDocClickListener = undefined;
		}
		
		// Clear all caches
		this.buttonGradientCache.clear();
		this.fileBadgeColorCache.clear();
		this.fileBadgeTextColorCache.clear();
		this.fileBadgeComponentsCache.clear();
		this.solidColorCache.clear();
		this.footerButtonStylesCache.clear();
		this.photoFrameStylesCache = null;
		this.photoImageStylesCache = null;
		this.photoBorderColorCache = null;
		
		// Clear arrays to free memory
		this.selectedFiles = [];
		this.uploadLogs = [];
		this.slideshowImages = [];
		this.pendingVideoFiles = [];
		this.cardBackgroundGradientCache = null;
		this.filesListGradientCache = null;
		this.statusBadgeGradientCache = null;
		this.visibilityBadgeGradientCache = null;
		this.downloadAllButtonGradientCache = null;
		this.ratingBadgeGradientCache = null;
		this.solidColorCache.clear();
	}

	public hasComments(): boolean {
		return this.evenement.commentaries && this.evenement.commentaries.length > 0;
	}

	public getCommentsCount(): number {
		return this.evenement.commentaries ? this.evenement.commentaries.length : 0;
	}

	public getFilesCount(): number {
		// Return the count from evenement.fileUploadeds
		let count = this.evenement.fileUploadeds ? this.evenement.fileUploadeds.length : 0;
		// If thumbnail exists, add 1
		if (this.evenement.thumbnail) {
			count += 1;
		}
		// If fileUploadeds has items, remove 1 (thumbnail is already counted in fileUploadeds)
		if (this.evenement.fileUploadeds && this.evenement.fileUploadeds.length > 0) {
			count -= 1;
		}
		return count;
	}

	// Safe getter for fileUploadeds length to prevent ExpressionChangedAfterItHasBeenCheckedError
	public getFileUploadedsLength(): number {
		return this.evenement?.fileUploadeds?.length || 0;
	}

	public getEventComments(): any[] {
		if (!this.evenement.commentaries || this.evenement.commentaries.length === 0) {
			return [];
		}
		
		// Sort comments by creation date descending (newest first)
		return this.evenement.commentaries.sort((a, b) => {
			const dateA = new Date(a.dateCreation).getTime();
			const dateB = new Date(b.dateCreation).getTime();
			return dateB - dateA;
		});
	}

	// New methods for CommentaryEditor component
	public onCommentaryAdded(commentary: Commentary): void {
		if (!this.evenement || !this.evenement.id) return;
		
		this._evenementsService.addCommentary(this.evenement.id, commentary).subscribe({
			next: (updatedEvent) => {
				if (updatedEvent && updatedEvent.commentaries) {
					this.evenement.commentaries = updatedEvent.commentaries;
					this.updateEvenement.emit(this.evenement);
				}
			},
			error: (error) => {
				console.error('Error adding commentary:', error);
				alert('Erreur lors de l\'ajout du commentaire');
			}
		});
	}

	public onCommentaryUpdated(event: { commentId: string; commentary: Commentary }): void {
		if (!this.evenement || !this.evenement.id) return;
		
		this._evenementsService.updateCommentary(this.evenement.id, event.commentId, event.commentary).subscribe({
			next: (updatedEvent) => {
				if (updatedEvent && updatedEvent.commentaries) {
					this.evenement.commentaries = updatedEvent.commentaries;
					this.updateEvenement.emit(this.evenement);
				}
			},
			error: (error) => {
				console.error('Error updating commentary:', error);
				alert('Erreur lors de la modification du commentaire');
			}
		});
	}

	public onCommentaryDeleted(commentId: string): void {
		if (!this.evenement || !this.evenement.id) return;
		
		this._evenementsService.deleteCommentary(this.evenement.id, commentId).subscribe({
			next: (updatedEvent) => {
				if (updatedEvent && updatedEvent.commentaries) {
					this.evenement.commentaries = updatedEvent.commentaries;
					this.updateEvenement.emit(this.evenement);
				}
			},
			error: (error) => {
				console.error('Error deleting commentary:', error);
				alert('Erreur lors de la suppression du commentaire');
			}
		});
	}

	// Get calculated color for commentary editor
	public getCalculatedColor(): { r: number; g: number; b: number } | null {
		// First try to get from EventColorService
		let eventColor = this.evenement?.id ? this.eventColorService.getEventColor(this.evenement.id) : null;
		if (!eventColor && this.evenement?.evenementName) {
			eventColor = this.eventColorService.getEventColor(this.evenement.evenementName);
		}
		
		// If not found, use dominant color from image
		if (!eventColor && (this.dominantR !== 128 || this.dominantG !== 128 || this.dominantB !== 128)) {
			return { r: this.dominantR, g: this.dominantG, b: this.dominantB };
		}
		
		return eventColor;
	}

	public openCommentsModal(): void {
		this.forceCloseTooltips();
		
		// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
		// Don't modify DOM - let Bootstrap handle modal normally
		// CSS will handle blocking scroll via styles.css rule
		const savedScrollY = window.scrollY || window.pageYOffset || 
			document.documentElement.scrollTop || 
			document.body.scrollTop || 0;
		
		// Open the modal - CSS will block scroll automatically
		const modalRef = this.modalService.open(this.commentsModal, { 
			size: 'lg',
			backdrop: 'static',
			keyboard: false,
			animation: true,
			centered: true,
			windowClass: 'comments-modal'
		});
		
		// Apply white border to modal content after opening
		setTimeout(() => {
			// Try multiple selectors to find the modal content
			let modalElement = document.querySelector('.modal.comments-modal.show .modal-content') as HTMLElement;
			if (!modalElement) {
				modalElement = document.querySelector('.comments-modal.show .modal-content') as HTMLElement;
			}
			if (!modalElement) {
				modalElement = document.querySelector('.modal.show .comments-modal .modal-content') as HTMLElement;
			}
			if (!modalElement && modalRef) {
				// Try to get element from modalRef
				const modalElementRef = (modalRef as any).componentInstance?.elementRef?.nativeElement?.querySelector('.modal-content');
				if (modalElementRef) {
					modalElement = modalElementRef;
				}
			}
			if (modalElement) {
				modalElement.style.setProperty('border', '4px solid #ffffff', 'important');
				modalElement.style.setProperty('border-width', '4px', 'important');
				modalElement.style.setProperty('border-style', 'solid', 'important');
				modalElement.style.setProperty('border-color', '#ffffff', 'important');
				modalElement.style.setProperty('border-radius', '8px', 'important');
				modalElement.style.setProperty('overflow', 'hidden', 'important');
			}
		}, 200);
		
		// Immediately maintain scroll position after modal opens to prevent any movement
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				// Restore scroll position in case Bootstrap tried to scroll
				window.scrollTo(0, savedScrollY);
				document.documentElement.scrollTop = savedScrollY;
				document.body.scrollTop = savedScrollY;
			});
		});
		
		// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
		modalRef.result.finally(() => {
			// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		}).catch(() => {
			// Also restore on dismissal
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		});
	}

	// Collect and display loading stats
	public collectAndDisplayLoadingStats(): void {
		this.forceCloseTooltips();
		
		// Calculate component initialization time (from start to when view is ready)
		const componentInitTime = (this.componentInitStartTime > 0 && this.componentInitEndTime > 0) ? 
			(this.componentInitEndTime - this.componentInitStartTime) : 0;
		
		// Calculate thumbnail load time (from start to when image is actually displayed)
		// Use thumbnailImageLoadEndTime if available (when image actually displays), otherwise use thumbnailLoadEndTime
		const thumbnailDisplayTime = this.thumbnailImageLoadEndTime > 0 ? 
			this.thumbnailImageLoadEndTime : this.thumbnailLoadEndTime;
		const thumbnailLoadTime = (this.thumbnailLoadStartTime > 0 && thumbnailDisplayTime > 0) ? 
			(thumbnailDisplayTime - this.thumbnailLoadStartTime) : 0;
		
		// Calculate color detection time
		const colorDetectionTime = (this.colorDetectionStartTime > 0 && this.colorDetectionEndTime > 0) ? 
			(this.colorDetectionEndTime - this.colorDetectionStartTime) : 0;
		
		// Collect file thumbnail load times (only those that are actually displayed)
		const fileThumbnails: Array<{ fileName: string; loadTime: number }> = [];
		this.fileThumbnailsLoadTimes.forEach((value, fileId) => {
			if (value.end > 0 && value.displayed) {
				const loadTime = value.end - value.start;
				fileThumbnails.push({ fileName: value.fileName, loadTime: loadTime });
			}
		});
		
		// Collect card slideshow image load times (only those that are actually displayed)
		const cardSlideshowImages: Array<{ fileName: string; loadTime: number }> = [];
		this.cardSlideshowLoadTimes.forEach((value, fileId) => {
			if (value.end > 0 && value.displayed) {
				const loadTime = value.end - value.start;
				cardSlideshowImages.push({ fileName: value.fileName, loadTime: loadTime });
			}
		});
		
		// Calculate averages
		const averageFileThumbnailTime = fileThumbnails.length > 0 ? 
			fileThumbnails.reduce((sum, item) => sum + item.loadTime, 0) / fileThumbnails.length : 0;
		
		const averageCardSlideshowTime = cardSlideshowImages.length > 0 ? 
			cardSlideshowImages.reduce((sum, item) => sum + item.loadTime, 0) / cardSlideshowImages.length : 0;
		
		// Calculate total load time (from component init to when all elements are displayed)
		// Use the latest display time among all elements
		let latestDisplayTime = this.componentInitEndTime > 0 ? this.componentInitEndTime : 0;
		if (this.thumbnailImageLoadEndTime > 0 && this.thumbnailImageLoadEndTime > latestDisplayTime) {
			latestDisplayTime = this.thumbnailImageLoadEndTime;
		}
		this.fileThumbnailsLoadTimes.forEach((value, fileId) => {
			if (value.displayed && value.end > latestDisplayTime) {
				latestDisplayTime = value.end;
			}
		});
		this.cardSlideshowLoadTimes.forEach((value, fileId) => {
			if (value.displayed && value.end > latestDisplayTime) {
				latestDisplayTime = value.end;
			}
		});
		
		const totalLoadTime = (this.componentInitStartTime > 0 && latestDisplayTime > 0) ? 
			(latestDisplayTime - this.componentInitStartTime) : 0;
		
		// Update loading stats
		this.loadingStats = {
			componentInit: componentInitTime,
			thumbnailLoad: thumbnailLoadTime,
			colorDetection: colorDetectionTime,
			fileThumbnails: fileThumbnails.sort((a, b) => b.loadTime - a.loadTime), // Sort by load time descending
			cardSlideshowImages: cardSlideshowImages.sort((a, b) => b.loadTime - a.loadTime), // Sort by load time descending
			totalFiles: fileThumbnails.length,
			totalCardSlideshowImages: cardSlideshowImages.length,
			averageFileThumbnailTime: averageFileThumbnailTime,
			averageCardSlideshowTime: averageCardSlideshowTime,
			totalLoadTime: totalLoadTime
		};
		
		// Open the modal
		if (this.loadingStatsModal) {
			const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
			
			// Block body scroll
			if (document.body) {
				document.body.style.overflow = 'hidden';
				document.body.style.position = 'fixed';
				document.body.style.top = `-${savedScrollY}px`;
				document.body.style.width = '100%';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = 'hidden';
			}
			
			const modalRef = this.modalService.open(this.loadingStatsModal, {
				size: 'lg',
				centered: true,
				backdrop: 'static',
				keyboard: false,
				animation: true
			});
			
			// Restore scroll when modal closes
			modalRef.result.finally(() => {
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.position = '';
					document.body.style.top = '';
					document.body.style.width = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
				}
				window.scrollTo(0, savedScrollY);
			}).catch(() => {
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.position = '';
					document.body.style.top = '';
					document.body.style.width = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
				}
				window.scrollTo(0, savedScrollY);
			});
		}
	}
	
	// Format time in milliseconds to readable string
	public formatTime(ms: number): string {
		if (ms < 1000) {
			return `${ms.toFixed(2)} ms`;
		} else {
			return `${(ms / 1000).toFixed(2)} s`;
		}
	}

	// Get current card load time in milliseconds
	public getCurrentCardLoadTime(): number {
		// Calculate total load time (from component init to when all elements are displayed)
		let latestDisplayTime = this.componentInitEndTime > 0 ? this.componentInitEndTime : 0;
		if (this.thumbnailImageLoadEndTime > 0 && this.thumbnailImageLoadEndTime > latestDisplayTime) {
			latestDisplayTime = this.thumbnailImageLoadEndTime;
		}
		this.fileThumbnailsLoadTimes.forEach((value, fileId) => {
			if (value.displayed && value.end > latestDisplayTime) {
				latestDisplayTime = value.end;
			}
		});
		this.cardSlideshowLoadTimes.forEach((value, fileId) => {
			if (value.displayed && value.end > latestDisplayTime) {
				latestDisplayTime = value.end;
			}
		});
		
		if (this.componentInitStartTime > 0 && latestDisplayTime > 0) {
			return latestDisplayTime - this.componentInitStartTime;
		}
		return 0;
	}

	// Format time for card display (always in ms)
	public formatTimeForCard(ms: number): string {
		return `${Math.round(ms)} ms`;
	}

	// Get the maximum load time for file thumbnails
	public getMaxFileThumbnailTime(): number {
		if (this.loadingStats.fileThumbnails.length === 0) {
			return 0;
		}
		return Math.max(...this.loadingStats.fileThumbnails.map(f => f.loadTime));
	}

	// Get the maximum load time for card slideshow images
	public getMaxCardSlideshowTime(): number {
		if (this.loadingStats.cardSlideshowImages.length === 0) {
			return 0;
		}
		return Math.max(...this.loadingStats.cardSlideshowImages.map(i => i.loadTime));
	}

	// Get the slowest operation in summary
	public getSlowestSummaryOperation(): string {
		const times = {
			'componentInit': this.loadingStats.componentInit,
			'thumbnailLoad': this.loadingStats.thumbnailLoad,
			'colorDetection': this.loadingStats.colorDetection
		};
		
		let maxTime = 0;
		let slowestOp = '';
		for (const [key, value] of Object.entries(times)) {
			if (value > maxTime) {
				maxTime = value;
				slowestOp = key;
			}
		}
		return slowestOp;
	}

	public openUserModal(user: Member): void {
		this.forceCloseTooltips();
		this.selectedUser = user;
		if (!this.userModal) {
			return;
		}

		const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
		
		// Block body scroll
		if (document.body) {
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.top = `-${savedScrollY}px`;
			document.body.style.width = '100%';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
		
		const modalRef = this.modalService.open(this.userModal, {
			size: 'md',
			centered: true,
			backdrop: 'static',
			keyboard: false,
			animation: true
		});
		
		// Restore scroll when modal closes
		modalRef.result.finally(() => {
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
			}
			window.scrollTo(0, savedScrollY);
		}).catch(() => {
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
			}
			window.scrollTo(0, savedScrollY);
		});
	}

	public sendEmail(email: string): void {
		window.open(`mailto:${email}`, '_blank');
	}

	// Listen to fullscreen events
	private setupFullscreenListener(): void {
		// Clean up existing listeners first
		this.fullscreenListeners.forEach(listener => {
			listener.element.removeEventListener(listener.event, listener.handler);
		});
		this.fullscreenListeners = [];
		
		const handleFullscreenChange = () => {
			this.isFullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
				(document as any).mozFullScreenElement || (document as any).msFullscreenElement);
		};

		const events = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
		events.forEach(eventName => {
			document.addEventListener(eventName, handleFullscreenChange);
			this.fullscreenListeners.push({ element: document, event: eventName, handler: handleFullscreenChange });
		});
	}

	// Open slideshow modal with all images from this card
	public openSlideshow(): void {
		this.forceCloseTooltips();
		
		// Filter to get ONLY image files - exclude videos and other file types
		const imageFiles = this.evenement.fileUploadeds.filter(file => {
			const fileName = file.fileName;
			// Must be an image file
			if (!this.isImageFile(fileName)) {
				return false;
			}
			// Must NOT be a video file (double check)
			if (this.isVideoFile(fileName)) {
				return false;
			}
			return true;
		});
		
		if (imageFiles.length === 0) {
			alert('Aucune image trouvée dans cet événement.');
			return;
		}

		// Prepare image sources for the slideshow component
		const imageSources: SlideshowImageSource[] = imageFiles.map(file => ({
			fileId: file.fieldId,
			blobUrl: undefined,
			fileName: file.fileName
		}));

		// Get event color for slideshow
		let eventColor = this.evenement?.id ? this.eventColorService.getEventColor(this.evenement.id) : null;
		if (!eventColor && this.evenement?.evenementName) {
			eventColor = this.eventColorService.getEventColor(this.evenement.evenementName);
		}

		// Get scroll position - prefer the original position from PhotosSelectorModalComponent if available
		// This ensures consistency when reopening "Sélection de Photos" after slideshow
		let savedScrollY: number;
		const photosSelector = this.photosSelectorModalComponent as any;
		if (photosSelector && photosSelector.originalScrollPosition && photosSelector.originalScrollPosition > 0) {
			// Use the original position from PhotosSelectorModalComponent
			savedScrollY = photosSelector.originalScrollPosition;
			this.savedScrollPosition = savedScrollY;
		} else {
			// No PhotosSelectorModalComponent position available, use current scroll
			savedScrollY = window.scrollY || window.pageYOffset || 
				document.documentElement.scrollTop || 
				document.body.scrollTop || 0;
			this.savedScrollPosition = savedScrollY;
		}
		
		// Block scroll and save position
		if (document.body) {
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.top = `-${savedScrollY}px`;
			document.body.style.width = '100%';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
		
		// Store restore function - use same logic as PhotosSelectorModalComponent for consistency
		this.scrollRestoreFunction = () => {
			// First unblock scroll immediately - clean all styles
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after Bootstrap cleanup is complete
			const restoreScroll = () => {
				// Restore to saved scroll position - single smooth operation
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto' // Instant, no animation to avoid jumps
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			// Wait for Bootstrap to finish all cleanup, then restore ONCE
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore after Bootstrap cleanup is complete
					setTimeout(restoreScroll, 300);
				});
			});
		};
		
		// Open the slideshow modal immediately - images will be loaded dynamically
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.open(imageSources, this.evenement.evenementName, true, 0, eventColor || undefined);
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
					// Ensure body position is maintained
					if (document.body) {
						document.body.style.top = `-${savedScrollY}px`;
					}
				});
			});
		} else {
		}
	}

	// Open a single image in slideshow modal
	public openSingleImageInSlideshow(fileId: string, fileName: string): void {
		this.forceCloseTooltips();
		
		// Prepare image source for the clicked image
		const imageSource: SlideshowImageSource = {
			fileId: fileId,
			blobUrl: undefined,
			fileName: fileName
		};

		// Get event color for slideshow
		let eventColor = this.evenement?.id ? this.eventColorService.getEventColor(this.evenement.id) : null;
		if (!eventColor && this.evenement?.evenementName) {
			eventColor = this.eventColorService.getEventColor(this.evenement.evenementName);
		}

		// Block scroll and save position
		const savedScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
		this.savedScrollPosition = savedScrollY;
		
		if (document.body) {
			document.body.style.overflow = 'hidden';
			document.body.style.position = 'fixed';
			document.body.style.top = `-${savedScrollY}px`;
			document.body.style.width = '100%';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
		
		// Store restore function
		this.scrollRestoreFunction = () => {
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.position = '';
				document.body.style.top = '';
				document.body.style.width = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
			}
			window.scrollTo(0, savedScrollY);
		};
		
		// Open the slideshow modal with just this one image
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.open([imageSource], this.evenement.evenementName, true, 0, eventColor || undefined);
		} else {
			console.error('Slideshow modal component not available');
		}
	}

	// Open videoshow modal with all videos from this card
	public openVideoshow(): void {
		this.forceCloseTooltips();
		// Filter to get only video files
		const videoFiles = this.evenement.fileUploadeds.filter(file => this.isVideoFile(file.fileName));
		
		if (videoFiles.length === 0) {
			alert('Aucune vidéo trouvée dans cet événement.');
			return;
		}

		// Prepare video sources for the videoshow component
		const videoSources: VideoshowVideoSource[] = videoFiles.map(file => ({
			fileId: file.fieldId,
			blobUrl: undefined,
			fileName: file.fileName
		}));

		// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
		// CSS will handle blocking scroll via styles.css rule
		const savedScrollY = window.scrollY || window.pageYOffset || 
			document.documentElement.scrollTop || 
			document.body.scrollTop || 0;
		this.savedScrollPosition = savedScrollY;
		
		// Open the videoshow modal immediately - videos will be loaded dynamically
		if (this.videoshowModalComponent) {
			this.videoshowModalComponent.open(videoSources, this.evenement.evenementName, true);
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo(0, savedScrollY);
					document.documentElement.scrollTop = savedScrollY;
					document.body.scrollTop = savedScrollY;
				});
			});
		}
		
		// Store restore function
		this.scrollRestoreFunction = () => {
			// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		};
	}

	// Open a single video in videoshow modal
	public openSingleVideoInVideoshow(fileId: string, fileName: string): void {
		this.forceCloseTooltips();
		
		// Prepare video source for the clicked video
		const videoSource: VideoshowVideoSource = {
			fileId: fileId,
			blobUrl: undefined,
			fileName: fileName
		};

		// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
		// CSS will handle blocking scroll via styles.css rule
		const savedScrollY = window.scrollY || window.pageYOffset || 
			document.documentElement.scrollTop || 
			document.body.scrollTop || 0;
		this.savedScrollPosition = savedScrollY;
		
		// Open the videoshow modal with just this one video
		if (this.videoshowModalComponent) {
			this.videoshowModalComponent.open([videoSource], this.evenement.evenementName, true);
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo(0, savedScrollY);
					document.documentElement.scrollTop = savedScrollY;
					document.body.scrollTop = savedScrollY;
				});
			});
		}
		
		// Store restore function
		this.scrollRestoreFunction = () => {
			// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
			if (document.body) {
				document.body.style.overflow = '';
				document.body.style.overflowX = '';
				document.body.style.overflowY = '';
				document.body.style.position = '';
				document.body.style.height = '';
			}
			if (document.documentElement) {
				document.documentElement.style.overflow = '';
				document.documentElement.style.overflowX = '';
				document.documentElement.style.overflowY = '';
			}
			
			// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
			const restoreScroll = () => {
				window.scrollTo({
					top: savedScrollY,
					left: 0,
					behavior: 'auto'
				});
				if (document.documentElement) {
					document.documentElement.scrollTop = savedScrollY;
				}
				if (document.body) {
					document.body.scrollTop = savedScrollY;
				}
			};
			
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					setTimeout(restoreScroll, 300);
				});
			});
		};
	}

	// Start automatic slideshow
	public startSlideshow(): void {
		// Change image every 3 seconds
		this.slideshowInterval = setInterval(() => {
			this.nextImage();
		}, 3000);
	}

	// Stop slideshow
	public stopSlideshow(): void {
		if (this.slideshowInterval) {
			clearInterval(this.slideshowInterval);
			this.slideshowInterval = null;
		}
		this.isSlideshowActive = false;
		
		// Cleanup blob URLs to prevent memory leaks
		this.slideshowImages.forEach(url => {
			if (url.startsWith('blob:')) {
				URL.revokeObjectURL(url);
			}
		});
		this.slideshowImages = [];
	}

	// ============ CARD SLIDESHOW METHODS ============
	
	// Start card slideshow
	public startCardSlideshow(): void {
		// Filter to get only image files
		const imageFiles = this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
		
		if (imageFiles.length === 0) {
			alert('Aucune image trouvée dans cet événement.');
			return;
		}
		
		// Cancel any existing subscriptions
		this.cancelCardSlideshowSubscriptions();
		
		// Load all images from DB
		const maxConcurrent = 4;
		let active = 0;
		const queue = [...imageFiles];
		
		const loadNext = () => {
			if (active >= maxConcurrent || queue.length === 0) {
				return;
			}
			
			const file = queue.shift() as UploadedFile;
			active++;
			
			if (file.fieldId) {
				// Track card slideshow image loading start time
				const loadStartTime = performance.now();
				this.cardSlideshowLoadTimes.set(file.fieldId, { start: loadStartTime, end: 0, fileName: file.fileName, displayed: false });
				
				const sub = this._fileService.getFile(file.fieldId).subscribe({
					next: (buffer: ArrayBuffer) => {
						const blob = new Blob([buffer], { type: 'image/*' });
						const url = URL.createObjectURL(blob);
						this.cardSlideImages.push(url);
						this.cardSlideFileNames.push(file.fileName);
						
					// Display first image immediately and start autoplay
					if (this.cardSlideImages.length === 1) {
						this.currentCardSlideImage = url;
						this.isCardSlideshowActive = true;
						this.cardSlideshowPaused = false; // Start playing
						this.startCardAutoplay(); // Start autoplay immediately
					}
					
					// Track when image is actually displayed (not just when blob URL is created)
					// The detectDominantColorFromSlideshow is called when image loads, so we'll track there
					},
					error: (error) => {
						console.error('Error loading image:', file.fileName, error);
					},
					complete: () => {
						active--;
						if (queue.length > 0) {
							loadNext();
						}
					}
				});
				this.cardSlideshowSubscriptions.push(sub);
			}
		};
		
		for (let i = 0; i < maxConcurrent && queue.length > 0; i++) {
			loadNext();
		}
	}
	
	// Start autoplay for card slideshow
	private startCardAutoplay(): void {
		this.cardSlideshowPaused = false;
		this.cardSlideshowInterval = setInterval(() => {
			this.nextCardSlide();
		}, 3000);
	}
	
	// Toggle pause/play for card slideshow
	public toggleCardSlideshowPause(): void {
		this.cardSlideshowPaused = !this.cardSlideshowPaused;
		
		if (this.cardSlideshowPaused) {
			// Pause
			if (this.cardSlideshowInterval) {
				clearInterval(this.cardSlideshowInterval);
				this.cardSlideshowInterval = null;
			}
		} else {
			// Resume
			this.startCardAutoplay();
		}
	}
	
	// Stop card slideshow
	public stopCardSlideshow(): void {
		this.cancelCardSlideshowSubscriptions();
		
		if (this.cardSlideshowInterval) {
			clearInterval(this.cardSlideshowInterval);
			this.cardSlideshowInterval = null;
		}
		
		this.isCardSlideshowActive = false;
		this.cardSlideshowPaused = false;
		this.currentCardSlideIndex = 0;
		this.currentCardSlideImage = '';
		
		// Cleanup blob URLs
		this.cardSlideImages.forEach(url => {
			if (url.startsWith('blob:')) {
				URL.revokeObjectURL(url);
			}
		});
		this.cardSlideImages = [];
		this.cardSlideFileNames = [];
	}

	// Get current slide file name
	public getCurrentCardSlideFileName(): string {
		if (this.currentCardSlideIndex >= 0 && this.currentCardSlideIndex < this.cardSlideFileNames.length) {
			return this.cardSlideFileNames[this.currentCardSlideIndex];
		}
		return '';
	}
	
	// Go to next card slide
	public nextCardSlide(): void {
		if (this.cardSlideImages.length === 0) return;
		this.currentCardSlideIndex = (this.currentCardSlideIndex + 1) % this.cardSlideImages.length;
		this.currentCardSlideImage = this.cardSlideImages[this.currentCardSlideIndex];
		// Recalculate color from new image after a short delay to ensure image is loaded
		setTimeout(() => {
			this.detectDominantColorFromSlideshow();
		}, 100);
	}
	
	// Go to previous card slide
	public previousCardSlide(): void {
		if (this.cardSlideImages.length === 0) return;
		this.currentCardSlideIndex = (this.currentCardSlideIndex - 1 + this.cardSlideImages.length) % this.cardSlideImages.length;
		this.currentCardSlideImage = this.cardSlideImages[this.currentCardSlideIndex];
		// Recalculate color from new image after a short delay to ensure image is loaded
		setTimeout(() => {
			this.detectDominantColorFromSlideshow();
		}, 100);
	}
	
	// Cancel all card slideshow subscriptions
	private cancelCardSlideshowSubscriptions(): void {
		this.cardSlideshowSubscriptions.forEach(sub => sub.unsubscribe());
		this.cardSlideshowSubscriptions = [];
	}

	// Setup keyboard listener for arrow keys navigation
	private setupKeyboardListener(): void {
		this.keyboardListener = (event: KeyboardEvent) => {
			// Only handle if modal is open
			if (!this.isSlideshowModalOpen) {
				return;
			}
			
			// Check if target is not an input or textarea to avoid interfering with form inputs
			const target = event.target as HTMLElement;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
				return;
			}
			
			// Check if modal is open OR if we're in fullscreen mode
			const modal = document.querySelector('.modal.show');
			const isFullscreenActive = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
				(document as any).mozFullScreenElement || (document as any).msFullscreenElement);
			
			// Allow if modal is open OR if we're in fullscreen (modal might not have .show class in fullscreen)
			if (!modal && !isFullscreenActive) {
				return;
			}
			
			// In fullscreen, we still want to handle the keys even if modal doesn't contain target
			if (modal && !modal.contains(target) && !isFullscreenActive) {
				return;
			}
			
			const currentTime = Date.now();
			const currentKeyCode = event.keyCode || (event.key === 'ArrowLeft' ? 37 : event.key === 'ArrowRight' ? 39 : 0);
			
			// Debounce: ignore if same key pressed within 100ms (to prevent double triggering)
			if (currentKeyCode === this.lastKeyCode && currentTime - this.lastKeyPressTime < 100) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				return;
			}
			
			if (event.key === 'ArrowLeft' || event.keyCode === 37) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				this.lastKeyPressTime = currentTime;
				this.lastKeyCode = 37;
				this.previousImage();
			} else if (event.key === 'ArrowRight' || event.keyCode === 39) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				this.lastKeyPressTime = currentTime;
				this.lastKeyCode = 39;
				this.nextImage();
			}
		};
		
		// Use capture phase with keydown only (to avoid double triggering)
		window.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
		document.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
	}

	// Remove keyboard listener
	private removeKeyboardListener(): void {
		if (this.keyboardListener) {
			window.removeEventListener('keydown', this.keyboardListener, { capture: true });
			document.removeEventListener('keydown', this.keyboardListener, { capture: true });
			this.keyboardListener = undefined;
		}
	}

	// Navigate to next image
	public nextImage(): void {
		if (this.slideshowImages.length === 0) return;
		this.currentSlideshowIndex = (this.currentSlideshowIndex + 1) % this.slideshowImages.length;
		setTimeout(() => this.resetSlideshowZoom(), 0);
	}

	// Navigate to previous image
	public previousImage(): void {
		if (this.slideshowImages.length === 0) return;
		this.currentSlideshowIndex = (this.currentSlideshowIndex - 1 + this.slideshowImages.length) % this.slideshowImages.length;
		setTimeout(() => this.resetSlideshowZoom(), 0);
	}

	// Get current slideshow image URL
	public getCurrentSlideshowImage(): string {
		if (this.slideshowImages.length === 0 || this.currentSlideshowIndex >= this.slideshowImages.length) {
			return '';
		}
		return this.slideshowImages[this.currentSlideshowIndex];
	}

	// Toggle slideshow play/pause
	public toggleSlideshow(): void {
		if (this.isSlideshowActive) {
			// Just stop the interval, don't cleanup images
			if (this.slideshowInterval) {
				clearInterval(this.slideshowInterval);
				this.slideshowInterval = null;
			}
			this.isSlideshowActive = false;
		} else {
			this.startSlideshow();
			this.isSlideshowActive = true;
		}
	}

	// Toggle slideshow with message
	public toggleSlideshowWithMessage(): void {
		// Store current state before toggling
		const wasActive = this.isSlideshowActive;
		this.toggleSlideshow();
		
		// Show message based on the NEW state (opposite of the old state)
		if (wasActive) {
			this.showSlideshowMessage('EVENTELEM.SLIDESHOW_PAUSED');
		} else {
			this.showSlideshowMessage('EVENTELEM.SLIDESHOW_PLAYING');
		}
	}

	private showSlideshowMessage(translationKey: string): void {
		this.translateService.get(translationKey).subscribe((translation: string) => {
			const toast = document.createElement('div');
			toast.textContent = translation;
			toast.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); color: white; padding: 10px 20px; border-radius: 5px; z-index: 9999; font-size: 16px;';
			document.body.appendChild(toast);
			setTimeout(() => {
				toast.remove();
			}, 2000);
		});
	}

	// Toggle fullscreen mode
	public toggleFullscreen(): void {
		// Use slideshow-container to include both image and controls
		const slideshowContainer = document.querySelector('.slideshow-container');
		const slideshowImageWrapper = document.querySelector('.slideshow-image-wrapper');
		const imageElement = slideshowContainer || slideshowImageWrapper;
		if (!imageElement) return;

		if (!this.isFullscreen) {
			// Enter fullscreen
			if ((imageElement as any).requestFullscreen) {
				(imageElement as any).requestFullscreen();
			} else if ((imageElement as any).webkitRequestFullscreen) {
				(imageElement as any).webkitRequestFullscreen();
			} else if ((imageElement as any).mozRequestFullScreen) {
				(imageElement as any).mozRequestFullScreen();
			} else if ((imageElement as any).msRequestFullscreen) {
				(imageElement as any).msRequestFullscreen();
			}
		} else {
			// Exit fullscreen
			if (document.exitFullscreen) {
				document.exitFullscreen();
			} else if ((document as any).webkitExitFullscreen) {
				(document as any).webkitExitFullscreen();
			} else if ((document as any).mozCancelFullScreen) {
				(document as any).mozCancelFullScreen();
			} else if ((document as any).msExitFullscreen) {
				(document as any).msExitFullscreen();
			}
		}
	}


	// Force close all tooltips when mouse leaves an element
	public forceCloseTooltips(): void {
		try {
			// Find all tooltip elements in the DOM (NgBootstrap creates .tooltip elements)
			const tooltipElements = document.querySelectorAll('.tooltip');
			tooltipElements.forEach((tooltip: any) => {
				if (tooltip && tooltip.parentNode) {
					// Hide the tooltip first
					if (tooltip.style) {
						tooltip.style.display = 'none';
						tooltip.style.visibility = 'hidden';
						tooltip.style.opacity = '0';
					}
					// Remove classes that indicate tooltip is open
					tooltip.classList.remove('show', 'bs-tooltip-auto', 'bs-tooltip-top', 'bs-tooltip-bottom', 
						'bs-tooltip-left', 'bs-tooltip-right', 'fade', 'in');
					// Remove from DOM after hiding
					setTimeout(() => {
						if (tooltip.parentNode) {
							tooltip.parentNode.removeChild(tooltip);
						}
					}, 100);
				}
			});
			
			// Remove tooltip-related classes from body
			document.body.classList.remove('tooltip-open', 'tooltip-shown');
			
			// Remove any tooltip backdrop elements
			const tooltipBackdrops = document.querySelectorAll('.tooltip-backdrop');
			tooltipBackdrops.forEach((backdrop: any) => {
				if (backdrop && backdrop.parentNode) {
					backdrop.parentNode.removeChild(backdrop);
				}
			});
			
			// Also remove tooltip arrow elements
			const tooltipArrows = document.querySelectorAll('.tooltip-arrow');
			tooltipArrows.forEach((arrow: any) => {
				if (arrow && arrow.parentNode) {
					arrow.parentNode.removeChild(arrow);
				}
			});
			
			// Dispatch a custom event to close any programmatic tooltips
			const closeEvent = new Event('tooltip-close', { bubbles: true, cancelable: true });
			document.dispatchEvent(closeEvent);
		} catch (error) {
			// Silently fail if there's an error closing tooltips
			console.warn('Error closing tooltips:', error);
		}
	}

	// Handle mouse leave on elements with tooltips
	public onTooltipMouseLeave(event: MouseEvent): void {
		// Force close tooltips immediately when mouse leaves
		// Use requestAnimationFrame to ensure it happens after NgBootstrap's own handlers
		requestAnimationFrame(() => {
			this.forceCloseTooltips();
		});
	}
	
	// Friend groups are now passed as @Input from parent component to avoid redundant API calls
	// This method is kept for backward compatibility but should not be called
	// @deprecated Use @Input() friendGroups instead
	private loadFriendGroups(): void {
		console.warn('loadFriendGroups() is deprecated. Friend groups should be passed as @Input from parent component.');
		const sub = this._friendsService.getFriendGroups().subscribe(
			groups => {
				if (groups && Array.isArray(groups)) {
					this.friendGroups = groups;
				} else {
					this.friendGroups = [];
				}
			},
			error => {
				console.error('Error loading friend groups:', error);
				this.friendGroups = []; // Initialize as empty array on error
			}
		);
		this.allSubscriptions.push(sub);
	}
	
	// Check if user is authorized to use a friend group (owner or authorized user)
	private isAuthorizedForGroup(group: FriendGroup): boolean {
		if (!group || !this.user) {
			return false;
		}
		// Check if user is the owner
		if (group.owner && group.owner.userName && 
			group.owner.userName.toLowerCase() === this.user.userName.toLowerCase()) {
			return true;
		}
		// Check if user is in authorizedUsers list
		if (group.authorizedUsers && Array.isArray(group.authorizedUsers)) {
			return group.authorizedUsers.some(u => 
				u && u.userName && u.userName.toLowerCase() === this.user.userName.toLowerCase()
			);
		}
		return false;
	}

	// Change visibility (for author or authorized user of the selected group)
	public changeVisibility(newVisibility: string, friendGroupId?: string): void {
		// Allow if user is the author
		if (this.isAuthor()) {
			this.evenement.visibility = newVisibility;
			if (friendGroupId) {
				this.evenement.friendGroupId = friendGroupId;
			} else {
				this.evenement.friendGroupId = undefined;
			}
			this.updateEvenement.emit(this.evenement);
			return;
		}
		
		// Allow if user is authorized for the selected group
		if (friendGroupId) {
			const selectedGroup = this.friendGroups.find(g => g.id === friendGroupId);
			if (selectedGroup && this.isAuthorizedForGroup(selectedGroup)) {
				this.evenement.visibility = newVisibility;
				this.evenement.friendGroupId = friendGroupId;
				this.updateEvenement.emit(this.evenement);
				return;
			}
		}
		
		// Not authorized
		console.warn("User is not authorized to change visibility");
	}
	
	// Get available visibility options
	public getVisibilityOptions(): Array<{value: string, label: string, friendGroupId?: string}> {
		try {
			const options: Array<{value: string, label: string, friendGroupId?: string}> = [
				{ value: 'public', label: this.translateService.instant('EVENTCREATION.PUBLIC') },
				{ value: 'private', label: this.translateService.instant('EVENTCREATION.PRIVATE') },
				{ value: 'friends', label: this.translateService.instant('EVENTCREATION.FRIENDS') }
			];
			
			// Add friend groups where user is owner or authorized
			if (this.friendGroups && Array.isArray(this.friendGroups)) {
				this.friendGroups.forEach(group => {
					if (group && group.name && group.id && this.isAuthorizedForGroup(group)) {
						options.push({
							value: group.name,
							label: group.name,
							friendGroupId: group.id
						});
					}
				});
			}
			
			return options;
		} catch (error) {
			console.error('Error getting visibility options:', error);
			// Return basic options on error
			return [
				{ value: 'public', label: 'Public' },
				{ value: 'private', label: 'Private' },
				{ value: 'friends', label: 'Friends' }
			];
		}
	}
	
	// Check if user can change visibility (author or authorized for current group)
	public canChangeVisibility(): boolean {
		// Author can always change visibility
		if (this.isAuthor()) {
			return true;
		}
		
		// Check if user is authorized for the current group
		if (this.evenement.friendGroupId) {
			const currentGroup = this.friendGroups.find(g => g.id === this.evenement.friendGroupId);
			if (currentGroup && this.isAuthorizedForGroup(currentGroup)) {
				return true;
			}
		}
		
		return false;
	}

	// Open visibility selection modal
	public openVisibilityModal(): void {
		// Allow if user is author or authorized for current group
		if (!this.canChangeVisibility()) {
			return;
		}
		
		try {
			this.forceCloseTooltips();
			
			// Prepare visibility options before opening modal
			this.visibilityOptions = this.getVisibilityOptions();
			
			if (!this.visibilityModal) {
				console.error('Visibility modal template not found');
				return;
			}
			
			// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
			// Don't modify DOM - let Bootstrap handle modal normally
			// CSS will handle blocking scroll via styles.css rule
			const savedScrollY = window.scrollY || window.pageYOffset || 
				document.documentElement.scrollTop || 
				document.body.scrollTop || 0;
			
			// Open the modal - CSS will block scroll automatically
			const modalRef = this.modalService.open(this.visibilityModal, { 
				size: 'md', 
				centered: true, 
				backdrop: 'static', 
				keyboard: false,
				windowClass: 'visibility-modal'
			});
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo(0, savedScrollY);
					document.documentElement.scrollTop = savedScrollY;
					document.body.scrollTop = savedScrollY;
				});
			});
			
			// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
			modalRef.result.finally(() => {
				// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.overflowX = '';
					document.body.style.overflowY = '';
					document.body.style.position = '';
					document.body.style.height = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
					document.documentElement.style.overflowX = '';
					document.documentElement.style.overflowY = '';
				}
				
				// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
				const restoreScroll = () => {
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
				};
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						setTimeout(restoreScroll, 300);
					});
				});
			}).catch(() => {
				// Also restore on dismissal
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.overflowX = '';
					document.body.style.overflowY = '';
					document.body.style.position = '';
					document.body.style.height = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
					document.documentElement.style.overflowX = '';
					document.documentElement.style.overflowY = '';
				}
				
				const restoreScroll = () => {
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
				};
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						setTimeout(restoreScroll, 300);
					});
				});
			});
		} catch (error) {
			console.error('Error opening visibility modal:', error);
		}
	}
	
	// Handle visibility selection
	public onVisibilitySelected(option: {value: string, label: string, friendGroupId?: string}): void {
		this.changeVisibility(option.value, option.friendGroupId);
	}
	
	// Get sorted event types for modal
	public getSortedEventTypes(): {value: string, label: string}[] {
		const eventTypes: {value: string, label: string}[] = [
			{ value: "1", label: this.eventTypeLabels['1'] },
			{ value: "2", label: this.eventTypeLabels['2'] },
			{ value: "3", label: this.eventTypeLabels['3'] },
			{ value: "4", label: this.eventTypeLabels['4'] },
			{ value: "5", label: this.eventTypeLabels['5'] },
			{ value: "6", label: this.eventTypeLabels['6'] },
			{ value: "7", label: this.eventTypeLabels['7'] },
			{ value: "8", label: this.eventTypeLabels['8'] },
			{ value: "9", label: this.eventTypeLabels['9'] },
			{ value: "10", label: this.eventTypeLabels['10'] },
			{ value: "11", label: this.eventTypeLabels['11'] },
			{ value: "12", label: this.eventTypeLabels['12'] },
			{ value: "13", label: this.eventTypeLabels['13'] },
			{ value: "14", label: this.eventTypeLabels['14'] },
			{ value: "15", label: this.eventTypeLabels['15'] },
			{ value: "16", label: this.eventTypeLabels['16'] },
			{ value: "17", label: this.eventTypeLabels['17'] }
		];
		
		// Sort by translated label
		return eventTypes.sort((a, b) =>
			this.translateService.instant(a.label).localeCompare(this.translateService.instant(b.label))
		);
	}
	
	// Open type change modal
	public openTypeModal(): void {
		if (!this.isAuthor()) {
			return;
		}
		
		try {
			this.forceCloseTooltips();
			
			// Prepare type options before opening modal
			this.typeOptions = this.getSortedEventTypes();
			
			if (!this.typeModal) {
				console.error('Type modal template not found');
				return;
			}
			
			// Save scroll position BEFORE opening modal (like PhotosSelectorModalComponent)
			// Don't modify DOM - let Bootstrap handle modal normally
			// CSS will handle blocking scroll via styles.css rule
			const savedScrollY = window.scrollY || window.pageYOffset || 
				document.documentElement.scrollTop || 
				document.body.scrollTop || 0;
			
			// Open the modal - CSS will block scroll automatically
			const modalRef = this.modalService.open(this.typeModal, { 
				size: 'md', 
				centered: true, 
				backdrop: 'static', 
				keyboard: false,
				windowClass: 'type-modal'
			});
			
			// Immediately maintain scroll position after modal opens to prevent any movement
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Restore scroll position in case Bootstrap tried to scroll
					window.scrollTo(0, savedScrollY);
					document.documentElement.scrollTop = savedScrollY;
					document.body.scrollTop = savedScrollY;
				});
			});
			
			// Restore scroll when modal closes (exactly like PhotosSelectorModalComponent)
			modalRef.result.finally(() => {
				// First unblock scroll (like PhotosSelectorModalComponent.unblockPageScroll)
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.overflowX = '';
					document.body.style.overflowY = '';
					document.body.style.position = '';
					document.body.style.height = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
					document.documentElement.style.overflowX = '';
					document.documentElement.style.overflowY = '';
				}
				
				// Then restore scroll position ONCE after a delay (like PhotosSelectorModalComponent.unlockScrollPosition)
				const restoreScroll = () => {
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
				};
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						setTimeout(restoreScroll, 300);
					});
				});
			}).catch(() => {
				// Also restore on dismissal
				if (document.body) {
					document.body.style.overflow = '';
					document.body.style.overflowX = '';
					document.body.style.overflowY = '';
					document.body.style.position = '';
					document.body.style.height = '';
				}
				if (document.documentElement) {
					document.documentElement.style.overflow = '';
					document.documentElement.style.overflowX = '';
					document.documentElement.style.overflowY = '';
				}
				
				const restoreScroll = () => {
					window.scrollTo({
						top: savedScrollY,
						left: 0,
						behavior: 'auto'
					});
					if (document.documentElement) {
						document.documentElement.scrollTop = savedScrollY;
					}
					if (document.body) {
						document.body.scrollTop = savedScrollY;
					}
				};
				
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						setTimeout(restoreScroll, 300);
					});
				});
			});
		} catch (error) {
			console.error('Error opening type modal:', error);
		}
	}
	
	// Handle type selection
	public onTypeSelected(type: {value: string, label: string}): void {
		this.changeType(type.value);
	}
	
	// Change event type
	public changeType(newType: string): void {
		if (!this.isAuthor()) {
			return;
		}
		
		this.evenement.type = newType;
		this.updateEvenement.emit(this.evenement);
	}
}

