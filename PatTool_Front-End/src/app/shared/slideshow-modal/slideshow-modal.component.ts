import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, Input, Output, EventEmitter, TemplateRef, ChangeDetectorRef, NgZone } from '@angular/core';
import { WheelNonPassiveDirective } from './wheel-non-passive.directive';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpHeaders } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl, SafeHtml } from '@angular/platform-browser';
import { NgbModule, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FileService } from '../../services/file.service';
import { Observable, Subscription, Subject } from 'rxjs';
import { map, takeUntil, finalize } from 'rxjs/operators';
// Note: panzoom library is available but we'll keep using custom implementation for now
// import panzoom from 'panzoom';
declare var EXIF: {
  getData(img: any, callback: () => void): void;
  getAllTags(img: any): any;
  getTag(img: any, tag: string): any;
};

// Export interface for use in parent components
export interface SlideshowImageSource {
  // Either provide a fileId to load from FileService, or a direct blob URL
  fileId?: string;
  blobUrl?: string;
  blob?: Blob; // Optional: store the original blob to avoid CSP issues
  fileName?: string; // Optional: file name for display in EXIF modal
  // For filesystem images
  relativePath?: string; // Optional: relative path for filesystem images
  compressFs?: boolean; // Optional: whether filesystem images were requested with compression
  patMetadata?: PatMetadata;
}

export interface SlideshowLocationEvent {
  lat: number;
  lng: number;
  label?: string;
  eventColor?: { r: number; g: number; b: number };
}

interface PatMetadata {
  originalSizeBytes?: number;
  originalSizeKilobytes?: number;
  rawHeaderValue?: string;
}

@Component({
  selector: 'app-slideshow-modal',
  templateUrl: './slideshow-modal.component.html',
  styleUrls: ['./slideshow-modal.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgbModule,
    TranslateModule,
    WheelNonPassiveDirective
  ]
})
export class SlideshowModalComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() images: SlideshowImageSource[] = [];
  @Input() eventName: string = '';
  @Input() loadFromFileService: boolean = false; // If true, use fileId to load images via FileService
  
  @Output() closed = new EventEmitter<void>();
  @Output() openLocationInTrace = new EventEmitter<SlideshowLocationEvent>();
  
  // Event color for styling
  private eventColor: { r: number; g: number; b: number } | null = null;
  
  @ViewChild('slideshowModal') slideshowModal!: TemplateRef<any>;
  @ViewChild('slideshowContainer') slideshowContainerRef!: ElementRef;
  @ViewChild('slideshowImgEl') slideshowImgElRef!: ElementRef<HTMLImageElement>;
  @ViewChild('thumbnailsStrip') thumbnailsStripRef!: ElementRef<HTMLElement>;
  
  // Slideshow state
  public slideshowImages: string[] = [];
  private slideshowBlobs: Map<string, Blob> = new Map(); // Store original blobs by URL
  public currentSlideshowIndex: number = 0;
  private pendingStartIndex: number | null = null; // Store startIndex when opening with empty array
  public isSlideshowActive: boolean = false;
  public slideshowInterval: any;
  public isFullscreen: boolean = false;
  private modalRef?: NgbModalRef;
  
  // Keyboard listener
  private keyboardListener?: (event: KeyboardEvent) => void;
  private isSlideshowModalOpen: boolean = false;
  private lastKeyPressTime: number = 0;
  private lastKeyCode: number = 0;
  
  // Zoom state
  public slideshowZoom: number = 1;
  public slideshowTranslateX: number = 0;
  public slideshowTranslateY: number = 0;
  public isDraggingSlideshow: boolean = false;
  
  // Cursor position for display
  public cursorX: number = 0;
  public cursorY: number = 0;
  
  // Container dimensions for display
  public containerWidth: number = 0;
  public containerHeight: number = 0;
  
  // Image dimensions for display
  public imageNaturalWidth: number = 0;
  public imageNaturalHeight: number = 0;
  public imageDisplayWidth: number = 0;
  public imageDisplayHeight: number = 0;
  public imageZoomedWidth: number = 0;
  public imageZoomedHeight: number = 0;
  public minZoom: number = 1;
  public translateX: number = 0;
  public translateY: number = 0;
  
  // Visible portion of image (what part of original image is displayed)
  public visibleImageOriginX: number = 0;
  public visibleImageOriginY: number = 0;
  public visibleImageWidth: number = 0;
  public visibleImageHeight: number = 0;
  
  // Saved cursor position (when clicking on image)
  public savedCursorX: number = 0;
  public savedCursorY: number = 0;
  public hasSavedPosition: boolean = false;
  
  // Info panel visibility
  public showInfoPanel: boolean = false;
  
  // Background color derived from current image average color
  public slideshowBackgroundColor: string = 'black';
  public slideshowBackgroundImageUrl: string = '';
  
  // Cached current image URL to avoid multiple calls to getCurrentSlideshowImage()
  public currentSlideshowImageUrl: string = '';
  
  // Flag to track when switching variants (same image, different quality)
  // Used to skip expensive background color recalculation
  private isSwitchingVariant: boolean = false;
  
  // Grid overlay visibility
  public showGrid: boolean = false;
  
  // Thumbnails strip visibility
  public showThumbnails: boolean = true;
  private userToggledThumbnails: boolean = false;
  
  private hasDraggedSlideshow: boolean = false;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private dragOrigX: number = 0;
  private dragOrigY: number = 0;
  private mouseUpX: number = 0;
  private mouseUpY: number = 0;
  
  // Double-click detection for zoom out
  private lastClickTime: number = 0;
  private clickTimeout?: any;
  private pendingZoomClick?: { event: MouseEvent, zoomApplied: boolean };
  
  // Rectangle selection for right-click zoom
  public isSelectingRectangle: boolean = false;
  public selectionRectX: number = 0;
  public selectionRectY: number = 0;
  public selectionRectWidth: number = 0;
  public selectionRectHeight: number = 0;
  private selectionStartX: number = 0;
  private selectionStartY: number = 0;
  
  // Coordonnées des doigts pour affichage debug mobile
  public touch1X: number = 0;
  public touch1Y: number = 0;
  public touch2X: number = 0;
  public touch2Y: number = 0;
  public showTouchCoordinates: boolean = false;
  
  // Debug mode
  public showDebug: boolean = false;
  private selectionMouseMoveHandler?: (event: MouseEvent) => void;
  private selectionMouseUpHandler?: (event: MouseEvent) => void;
  
  // Global drag handlers
  private dragMouseMoveHandler?: (event: MouseEvent) => void;
  private dragMouseUpHandler?: (event: MouseEvent) => void;
  
  // Getters pour le template (assurer une taille minimale pour l'affichage)
  public get displaySelectionWidth(): number {
    // Ne pas afficher le rectangle si la taille est trop petite (moins de 5 pixels)
    if (isNaN(this.selectionRectWidth) || this.selectionRectWidth < 5) {
      return 0;
    }
    return this.selectionRectWidth;
  }
  
  public get displaySelectionHeight(): number {
    // Ne pas afficher le rectangle si la taille est trop petite (moins de 5 pixels)
    if (isNaN(this.selectionRectHeight) || this.selectionRectHeight < 5) {
      return 0;
    }
    return this.selectionRectHeight;
  }
  
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
  
  // Fullscreen listener handler (stored for cleanup)
  private fullscreenChangeHandler?: () => void;
  
  // Track if we want to prevent fullscreen exit (when Escape is pressed to reset zoom)
  private preventFullscreenExit: boolean = false;
  
  // Fullscreen element escape handler (to prevent fullscreen exit)
  private fullscreenEscapeHandler?: (event: KeyboardEvent) => void;
  
  // Resize listener handler (stored for cleanup)
  private resizeHandler?: () => void;
  
  // Thumbnails wheel event handler (stored for cleanup)
  private thumbnailsWheelHandler?: (event: WheelEvent) => void;
  // Modal body wheel event handler to prevent background scrolling
  private modalBodyWheelHandler?: EventListener;
  
  // Programmatic event handlers to suppress passive event listener warnings
  private slideshowTouchStartHandler?: (event: TouchEvent) => void;
  private slideshowTouchMoveHandler?: (event: TouchEvent) => void;
  private slideshowWheelHandler?: (event: WheelEvent) => void;
  
  // Focus management handler to prevent focus on aria-hidden elements
  private focusManagementHandler?: () => void;
  
  // MutationObserver to detect when Bootstrap adds aria-hidden to app-root
  private ariaHiddenObserver?: MutationObserver;
  
  // Cache for DOM queries to avoid repeated expensive lookups
  private cachedAppRoot: HTMLElement | null = null;
  private cachedModal: Element | null = null;
  private focusFixInProgress: boolean = false;
  
  // Debounce timers for expensive dimension updates
  private dimensionUpdateTimer: any = null;
  private pendingDimensionUpdate: boolean = false;
  
  // Flag to prevent background color update during zoom operations
  private isZooming: boolean = false;
  
  // Throttling for mousemove handler to improve performance
  private mouseMoveRafId: number | null = null;
  private pendingMouseMove: MouseEvent | null = null;
  
  // Throttling for touchmove handler to improve performance
  private touchMoveRafId: number | null = null;
  private pendingTouchMove: TouchEvent | null = null;
  private selectionChangeDetectionRafId: number | null = null;
  private dragChangeDetectionRafId: number | null = null;
  private visiblePortionUpdateTimer: any = null;
  
  // FS Photos download control
  private fsDownloadsActive: boolean = false;
  private fsActiveSubs: Subscription[] = [];
  private fsQueue: string[] = [];
  
  // MutationObserver to watch for Bootstrap adding scroll-blocking styles
  private scrollUnblockObserver?: MutationObserver;
  
  // Scroll position preservation - save element position instead of scroll
  private savedScrollPosition: number = 0;
  private savedElementId: string | null = null;
  private savedElementRect: { top: number; left: number } | null = null; // Save element position relative to viewport
  private scrollRestoreAttempted: boolean = false; // Track if we've already attempted scroll restore
  
  // Image loading control
  private imageLoadActive: boolean = true;
  private imageLoadingSubs: Subscription[] = [];
  private cancelImageLoadsSubject!: Subject<void>;
  private imageLoadQueue: Array<{imageSource: SlideshowImageSource, imageIndex: number, priority: number}> = []; // Queue for image loading
  private activeImageLoads: number = 0; // Number of images currently being loaded
  private maxConcurrentImageLoads: number = 48 ; // Maximum concurrent image loads (increased for faster loading)
  private imageCache: Map<string, {objectUrl: string, blob: Blob, metadata?: PatMetadata}> = new Map(); // Cache to avoid loading same image multiple times (key: fileId or relativePath+fileName)
  private loadingImageKeys: Set<string> = new Set(); // Track which image keys are currently loading
  private pendingImageLoads: Map<string, number[]> = new Map(); // Track pending image indices waiting for same image to load (key -> array of imageIndex)
  
  // EXIF data
  public exifData: Array<{label: string, value: string}> = [];
  public isLoadingExif: boolean = false;
  public currentImageFileName: string = ''; // Current image file name for EXIF modal title
  private exifDataCache: Map<string, Array<{label: string, value: string}>> = new Map(); // Cache EXIF data by image URL
  private imageFileNames: Map<string, string> = new Map(); // Store file names by image URL
  private imagePatMetadata: Map<string, PatMetadata> = new Map();
  
  // Thumbnails
  public thumbnails: string[] = []; // Array of thumbnail blob URLs, indexed by slideshowImages index
  public isLoadingThumbnails: boolean = false;
  private loadingThumbnailImageIndices: Set<number> = new Set(); // Track which image indices are currently loading (by this.images index)
  private pendingThumbnailImageIndices: Set<number> = new Set(); // Track indices that are pending loading state update (to prevent duplicates)
  private thumbnailBlobs: Map<string, Blob> = new Map(); // Store thumbnail blobs by thumbnail URL
  private imageUrlToThumbnailIndex: Map<string, number> = new Map(); // Map image URL to its index in this.images
  private slideshowIndexToImageIndex: Map<number, number> = new Map(); // Map slideshowImages index to this.images index
  private thumbnailGenerationQueue: Array<{imageIndex: number, blob: Blob, priority: number}> = []; // Queue for thumbnail generation
  private activeThumbnailGenerations: number = 0; // Number of thumbnails currently being generated
  private maxConcurrentThumbnailGenerations: number = 8; // Maximum concurrent thumbnail generations (increased for faster loading)
  private thumbnailBlobStorage: Map<number, Blob> = new Map(); // Store blobs for thumbnail generation by imageIndex (decoupled from image loading)
  private thumbnailGenerationActive: boolean = true; // Control thumbnail generation independently
  private thumbnailGenerationInterval?: any; // Interval for independent thumbnail generation process
  
  // Map view state
  public showMapView: boolean = false;
  public currentImageLocation: { lat: number; lng: number } | null = null;
  public currentMapUrl: SafeResourceUrl | null = null;
  private imageLocations: Map<string, { lat: number; lng: number }> = new Map();
  private mapUrlCache: Map<string, SafeResourceUrl> = new Map();
  public locationViewMode: 'google' | 'trace' = 'google';
  private traceViewerOpen: boolean = false;

  // Filesystem image variants tracking
  private filesystemImageVariants: Map<number, {
    compressedUrl?: string;
    originalUrl?: string;
    compressedMetadata?: PatMetadata;
    originalMetadata?: PatMetadata;
    currentVariant: 'compressed' | 'original';
  }> = new Map();
  private filesystemVariantLoading: Set<number> = new Set();
  private filesystemOriginalPrefetching: Set<number> = new Set();
  
  constructor(
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private modalService: NgbModal,
    private translateService: TranslateService,
    private fileService: FileService,
    private sanitizer: DomSanitizer
  ) {}
  
  ngOnInit(): void {
    this.setupFullscreenListener();
  }
  
  ngAfterViewInit(): void {
    // ViewChild is now available
    // Setup thumbnails wheel listener after view initialization
    this.setupThumbnailsWheelListenerRenderer();
    // Setup programmatic event listeners to suppress passive event warnings
    this.setupProgrammaticEventListeners();
  }
  
  ngOnDestroy(): void {
    this.cleanupAllMemory();
    this.removeScrollUnblockObserver();
    // Unblock scroll first
    this.unblockPageScroll();
    // Then restore scroll position
    this.unlockScrollPosition();
  }
  
  // Centralized method to clean up all memory used by the slideshow
  // This method is idempotent - safe to call multiple times
  private cleanupAllMemory(): void {
    // Remove fullscreen class from body
    document.body.classList.remove('slideshow-fullscreen-active');
    
    // Remove selection listeners
    this.removeSelectionListeners();
    // Remove drag listeners
    this.removeDragListeners();
    // Stop slideshow and timers
    this.stopSlideshow();
    
    // Cancel all downloads
    this.cancelFsDownloads();
    
    // Cancel all image loading subscriptions
    this.cancelImageLoads();
    
    // Clean up thumbnail blob URLs
    this.thumbnailBlobs.forEach((blob, url) => {
      try {
        if (url && typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        // Ignore errors
      }
    });
    this.thumbnailBlobs.clear();
    this.thumbnails = [];
    
    // Stop independent thumbnail generation process
    this.stopIndependentThumbnailGeneration();
    // Clean up thumbnail generation queue
    this.thumbnailGenerationQueue = [];
    this.activeThumbnailGenerations = 0;
    this.thumbnailBlobStorage.clear();
    this.thumbnailGenerationActive = false;
    
    // Clean up image load queue
    this.imageLoadQueue = [];
    this.activeImageLoads = 0;
    
    // Complete the cancel subject
    if (this.cancelImageLoadsSubject) {
      try {
        this.cancelImageLoadsSubject.complete();
      } catch (error) {
        // Subject may already be completed
      }
    }
    
    // Remove all event listeners
    this.removeKeyboardListener();
    this.removeFullscreenListener();
    this.removeResizeListener();
    this.removeThumbnailsWheelListener();
    this.removeModalBodyWheelListener();
    this.removeProgrammaticEventListeners();
    this.removeFocusMonitoring();
    
    // Clear dimension update timers
    if (this.dimensionUpdateTimer) {
      cancelAnimationFrame(this.dimensionUpdateTimer);
      this.dimensionUpdateTimer = null;
    }
    this.pendingDimensionUpdate = false;
    
    // Clean up mousemove throttling
    if (this.mouseMoveRafId !== null) {
      cancelAnimationFrame(this.mouseMoveRafId);
      this.mouseMoveRafId = null;
    }
    this.pendingMouseMove = null;
    
    // Clean up touchmove throttling
    if (this.touchMoveRafId !== null) {
      cancelAnimationFrame(this.touchMoveRafId);
      this.touchMoveRafId = null;
    }
    this.pendingTouchMove = null;
    
    // Clean up selection change detection throttling
    if (this.selectionChangeDetectionRafId !== null) {
      cancelAnimationFrame(this.selectionChangeDetectionRafId);
      this.selectionChangeDetectionRafId = null;
    }
    
    // Clean up drag change detection throttling
    if (this.dragChangeDetectionRafId !== null) {
      cancelAnimationFrame(this.dragChangeDetectionRafId);
      this.dragChangeDetectionRafId = null;
    }
    
    // Clean up visible portion update timer
    if (this.visiblePortionUpdateTimer) {
      clearTimeout(this.visiblePortionUpdateTimer);
      this.visiblePortionUpdateTimer = null;
    }
    
    // Revoke all blob URLs to free memory (critical for memory cleanup)
    // Make a copy of the array to avoid issues if it's modified during iteration
    const urlsToRevoke = [...this.slideshowImages];
    urlsToRevoke.forEach(url => {
      try {
        if (url && typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        // Ignore errors when revoking URLs (may already be revoked)
        // This can happen if cleanup is called multiple times
      }
    });
    
    // Revoke all blob URLs stored in slideshowBlobs Map (keys are URLs)
    this.slideshowBlobs.forEach((blob, url) => {
      try {
        if (url && typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        // Ignore errors when revoking URLs (may already be revoked)
      }
    });
    
    // Revoke all blob URLs stored in imageCache Map
    this.imageCache.forEach((cacheEntry, cacheKey) => {
      try {
        if (cacheEntry.objectUrl && typeof cacheEntry.objectUrl === 'string' && cacheEntry.objectUrl.startsWith('blob:')) {
          URL.revokeObjectURL(cacheEntry.objectUrl);
        }
      } catch (error) {
        // Ignore errors when revoking URLs (may already be revoked)
      }
    });
    
    // Revoke additional filesystem variant URLs not currently in slideshowImages
    this.filesystemImageVariants.forEach(variants => {
      if (variants.compressedUrl) {
        try {
          if (variants.compressedUrl.startsWith('blob:')) {
            URL.revokeObjectURL(variants.compressedUrl);
          }
        } catch {}
      }
      if (variants.originalUrl) {
        try {
          if (variants.originalUrl.startsWith('blob:')) {
            URL.revokeObjectURL(variants.originalUrl);
          }
        } catch {}
      }
    });
    
    // Clear all arrays and maps to release references
    this.slideshowImages = [];
    this.slideshowBlobs.clear();
    this.exifDataCache.clear();
    this.imageUrlToThumbnailIndex.clear();
    this.slideshowIndexToImageIndex.clear();
    this.imageCache.clear();
    this.loadingImageKeys.clear();
    this.imagePatMetadata.clear();
    this.imageLocations.clear();
    this.mapUrlCache.clear();
    this.filesystemVariantLoading.clear();
    this.filesystemOriginalPrefetching.clear();
    this.filesystemImageVariants.clear();
    this.currentImageLocation = null;
    this.currentMapUrl = null;
    this.showMapView = false;
    
    // Reset info panel state
    this.showInfoPanel = false;
    this.showThumbnails = true;
    this.userToggledThumbnails = false;
    this.exifData = [];
    this.isLoadingExif = false;
    this.imageFileNames.clear();
    this.currentImageFileName = '';
    
    // Reset all state variables
    this.currentSlideshowIndex = 0;
    this.pendingStartIndex = null;
    this.currentSlideshowImageUrl = ''; // Explicitly clear cached current image URL
    this.isSlideshowActive = false;
    this.resetSlideshowZoom();
    this.isSlideshowModalOpen = false;
    
    // Clean up double-click timeout
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
      this.clickTimeout = undefined;
    }
    this.lastClickTime = 0;
    
    // Note: Don't set modalRef to undefined here as it may still be in use
    // It will be cleared when the modal actually closes
  }
  
  // Cancel all image loading subscriptions
  private cancelImageLoads(): void {
    this.imageLoadActive = false;
    
    // Emit the cancel signal to stop all ongoing HTTP requests
    if (this.cancelImageLoadsSubject) {
      this.cancelImageLoadsSubject.next();
    }
    
    // Unsubscribe from all subscriptions
    this.imageLoadingSubs.forEach((s) => { 
      if (s && !s.closed) { 
        s.unsubscribe(); 
      } 
    }); 
    this.imageLoadingSubs = [];
  }
  
  // Open the slideshow modal
  public open(images: SlideshowImageSource[], eventName: string = '', loadFromFileService: boolean = false, retryCount: number = 0, eventColor?: { r: number; g: number; b: number }, startIndex: number = 0): void {
    // Allow opening with empty array for dynamic loading
    if (!images) {
      images = [];
    }
    
    // Prevent infinite retry loop
    if (retryCount > 10) {
      return;
    }
    
    this.images = images;
    this.eventName = eventName;
    this.loadFromFileService = loadFromFileService;
    
    // Store event color if provided
    if (eventColor) {
      this.eventColor = eventColor;
      this.applyEventColorToSlideshow();
    } else {
      this.eventColor = null;
      this.resetSlideshowColors();
    }
    
    // Initialize slideshow state
    this.slideshowImages = [];
    this.slideshowBlobs.clear();
    this.exifDataCache.clear();
    this.imageFileNames.clear();
    // Set starting index if provided and valid
    if (images.length > 0) {
      // If images are provided, set index immediately
      this.currentSlideshowIndex = (startIndex >= 0 && startIndex < images.length) ? startIndex : 0;
      this.pendingStartIndex = null;
    } else {
      // If no images yet (dynamic loading), store the startIndex for later
      this.currentSlideshowIndex = 0;
      this.pendingStartIndex = (startIndex >= 0) ? startIndex : null;
    }
    this.currentSlideshowImageUrl = ''; // Explicitly clear cached current image URL
    this.isSlideshowActive = false;
    this.currentImageFileName = '';
    this.resetSlideshowZoom();
    this.hasSavedPosition = false;
    this.showMapView = false;
    this.currentImageLocation = null;
    this.currentMapUrl = null;
    this.locationViewMode = 'google';
    this.showThumbnails = images.length > 1;
    this.userToggledThumbnails = false;
    this.imageLoadActive = true;
    // Initialize queues
    this.imageLoadQueue = [];
    this.activeImageLoads = 0;
    this.thumbnailGenerationQueue = [];
    this.activeThumbnailGenerations = 0;
    this.thumbnailBlobStorage.clear();
    this.thumbnailGenerationActive = true;
    // Start independent thumbnail generation process
    this.startIndependentThumbnailGeneration();
    this.imageCache.clear();
    this.loadingImageKeys.clear();
    this.pendingImageLoads.clear();
    this.imageLocations.clear();
    this.mapUrlCache.clear();
    this.filesystemVariantLoading.clear();
    this.filesystemImageVariants.clear();
    // Create a new cancel subject for this session
    this.cancelImageLoadsSubject = new Subject<void>();
    
    // Ensure ViewChild is available (use setTimeout to ensure it's initialized)
    if (!this.slideshowModal) {
      setTimeout(() => {
        this.open(images, eventName, loadFromFileService, retryCount + 1);
      }, 100);
      return;
    }
    
    // Close any existing modal first to prevent duplicates
    if (this.modalRef) {
      try {
        this.modalRef.close();
      } catch (e) {
        // Ignore errors when closing
      }
      this.modalRef = undefined;
    }
    
    // Remove any existing keyboard listener
    this.removeKeyboardListener();
    
    // Lock scroll position before opening modal (prevents any movement)
    this.lockScrollPosition();
    
    // CRITICAL: Blur any focused elements BEFORE opening the modal
    // This prevents the accessibility warning when Bootstrap adds aria-hidden to app-root
    const activeElement = document.activeElement as HTMLElement;
    if (activeElement && activeElement !== document.body) {
      // Blur synchronously before modal opens
      try {
        if (typeof (activeElement as any).blur === 'function') {
          (activeElement as any).blur();
        }
      } catch (e) {
        // Ignore blur errors
      }
    }
    
    // Don't block body scroll - allow scrolling in both normal and mobile mode
    
      // Open the modal immediately
      try {
      this.modalRef = this.modalService.open(this.slideshowModal, { 
        size: 'xl', 
        centered: true,
        backdrop: 'static',
        keyboard: false,
        windowClass: 'modal-smooth-animation slideshow-modal-wide'
      });
      
      // Set flag that modal is open
      this.isSlideshowModalOpen = true;
      this.lastKeyPressTime = 0;
      this.lastKeyCode = 0;
      
      // Immediately blur any focused elements in app-root after modal opens
      // This is a backup in case the synchronous blur above didn't work
      requestAnimationFrame(() => {
        const activeElementAfter = document.activeElement as HTMLElement;
        const appRoot = document.querySelector('app-root') as HTMLElement;
        const modal = document.querySelector('.modal.show');
        
        if (activeElementAfter && appRoot && modal && activeElementAfter !== document.body) {
          // If active element is in app-root but not in modal, blur it immediately
          if (appRoot.contains(activeElementAfter) && !modal.contains(activeElementAfter)) {
            if (typeof (activeElementAfter as any).blur === 'function') {
              (activeElementAfter as any).blur();
            }
          }
        }
      });
      
      // Setup keyboard listener after modal is opened
      // Use requestAnimationFrame instead of setTimeout for better performance
      requestAnimationFrame(() => {
        this.setupKeyboardListener();
        this.setupResizeListener();
        this.setupThumbnailsWheelListenerRenderer();
        
        // Fix accessibility: Remove focus from elements outside modal that have aria-hidden
        // This prevents the "Blocked aria-hidden on an element because its descendant retained focus" error
        this.fixFocusManagement();
        // Setup continuous focus monitoring
        this.setupFocusMonitoring();
        
        // Use a single requestAnimationFrame for DOM updates (batched)
        requestAnimationFrame(() => {
          this.updateContainerDimensions();
          // Apply event color after modal is rendered
          if (this.eventColor) {
            this.applyEventColorToSlideshow();
          }
          // Center the active thumbnail after modal is fully rendered
          this.scrollToActiveThumbnail();
        });
      });
      
      // Handle modal close event
      this.modalRef.result.finally(() => {
        // Cleanup memory first
        this.cleanupAllMemory();
        // Unblock scroll immediately (synchronous, no delays)
        this.unblockPageScroll();
        // Then restore scroll position after DOM is stable
        // Use requestAnimationFrame to ensure DOM updates are complete
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.unlockScrollPosition();
          });
        });
        this.closed.emit();
      }).catch(() => {
        // Cleanup memory first
        this.cleanupAllMemory();
        // Unblock scroll immediately (synchronous, no delays)
        this.unblockPageScroll();
        // Then restore scroll position after DOM is stable
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.unlockScrollPosition();
          });
        });
        this.closed.emit();
      });
      
      // Load images (will be empty array if loading dynamically)
      if (images.length > 0) {
        // Initialize thumbnails array
        this.thumbnails = new Array(images.length).fill('');
        // Load main images (thumbnails will be generated automatically when images load)
        this.loadImages();
      }
    } catch (error) {
      // Retry once more if there's an error
      if (retryCount < 3) {
        setTimeout(() => {
          this.open(images, eventName, loadFromFileService, retryCount + 1);
        }, 200);
      }
    }
  }
  
  // Queue image loading for parallel processing
  private queueImageLoad(imageSource: SlideshowImageSource, imageIndex: number, priority: number = 0): void {
    // Skip if already in queue or already loaded
    if (this.imageLoadQueue.some(item => item.imageIndex === imageIndex)) {
      return;
    }
    
    // Add to queue with priority (lower number = higher priority)
    this.imageLoadQueue.push({ imageSource, imageIndex, priority });
    
    // Sort queue by priority (lower priority number first)
    this.imageLoadQueue.sort((a, b) => a.priority - b.priority);
    
    // Process queue
    this.processImageLoadQueue();
  }
  
  // Get unique key for an image source to use as cache key
  private getImageCacheKey(imageSource: SlideshowImageSource): string | null {
    if (imageSource.fileId) {
      return `fileId:${imageSource.fileId}`;
    } else if (imageSource.relativePath && imageSource.fileName) {
      const compressKey = imageSource.compressFs ? ':compressed' : '';
      return `disk:${imageSource.relativePath}/${imageSource.fileName}${compressKey}`;
    } else if (imageSource.blobUrl) {
      return `blob:${imageSource.blobUrl}`;
    }
    return null;
  }

  private getFilesystemCacheKey(relativePath: string, fileName: string, compress: boolean): string {
    const compressKey = compress ? ':compressed' : '';
    return `disk:${relativePath}/${fileName}${compressKey}`;
  }
  
  // Process image load queue with parallel execution
  private processImageLoadQueue(): void {
    // Process up to maxConcurrentImageLoads images at once
    while (this.activeImageLoads < this.maxConcurrentImageLoads && 
           this.imageLoadQueue.length > 0 && 
           this.imageLoadActive) {
      const item = this.imageLoadQueue.shift();
      if (!item) break;
      
      const { imageSource, imageIndex } = item;
      const cacheKey = this.getImageCacheKey(imageSource);
      
      // Check if image is already cached
      if (cacheKey && this.imageCache.has(cacheKey)) {
        const cached = this.imageCache.get(cacheKey)!;
        this.handleImageLoaded(cached.objectUrl, cached.blob, imageIndex, cached.metadata);
        // Process next in queue (no need to increment activeImageLoads for cached images)
        this.processImageLoadQueue();
        continue;
      }
      
      // Check if image is already loading
      if (cacheKey && this.loadingImageKeys.has(cacheKey)) {
        // Add this imageIndex to pending list - it will be handled when the first load finishes
        if (!this.pendingImageLoads.has(cacheKey)) {
          this.pendingImageLoads.set(cacheKey, []);
        }
        this.pendingImageLoads.get(cacheKey)!.push(imageIndex);
        // Process next in queue (no need to increment activeImageLoads for pending images)
        this.processImageLoadQueue();
        continue;
      }
      
      // Increment counter BEFORE starting the request
      this.activeImageLoads++;
      
      if (cacheKey) {
        this.loadingImageKeys.add(cacheKey);
      }
      
      // Start the request immediately (don't wait)
      const startRequest = () => {
        if (this.loadFromFileService && imageSource.fileId) {
          // Load from MongoDB via FileService
          const subscription = this.fileService.getFileWithMetadata(imageSource.fileId).pipe(
            takeUntil(this.cancelImageLoadsSubject),
            map((res) => {
              const mimeType = this.detectImageMimeType(res.buffer);
              const blob = new Blob([res.buffer], { type: mimeType });
              const objectUrl = URL.createObjectURL(blob);
              this.slideshowBlobs.set(objectUrl, blob);
              this.assignImageFileName(imageIndex, objectUrl);
              const metadata = res.metadata ?? this.parsePatMetadataFromHeaders(res.headers);
              if (metadata) {
                imageSource.patMetadata = metadata;
              }
              // Cache the image
              if (cacheKey) {
                this.imageCache.set(cacheKey, { objectUrl, blob, metadata });
                this.loadingImageKeys.delete(cacheKey);
              }
              return { objectUrl, blob, imageIndex, cacheKey, metadata };
            })
          ).subscribe(
            ({ objectUrl, blob, imageIndex, cacheKey, metadata }) => {
              if (!this.imageLoadActive) {
                this.activeImageLoads--;
                return;
              }
              // Handle cached image (will also handle pending indices)
              if (cacheKey) {
                this.handleCachedImageLoaded(cacheKey, objectUrl, blob, imageIndex, metadata);
              } else {
                this.handleImageLoaded(objectUrl, blob, imageIndex, metadata);
              }
              this.activeImageLoads--;
              // Process next in queue immediately
              this.processImageLoadQueue();
            },
            (error) => {
              if (cacheKey) {
                this.loadingImageKeys.delete(cacheKey);
                this.pendingImageLoads.delete(cacheKey);
              }
              this.activeImageLoads--;
              // Process next in queue immediately
              this.processImageLoadQueue();
            }
          );
          this.imageLoadingSubs.push(subscription);
        } else if (imageSource.relativePath && imageSource.fileName && !imageSource.blobUrl) {
          // Load from filesystem
          const subscription = this.fileService.getImageFromDiskWithMetadata(imageSource.relativePath, imageSource.fileName, !!imageSource.compressFs).pipe(
            takeUntil(this.cancelImageLoadsSubject),
            map((res) => {
              const mimeType = this.detectImageMimeTypeFromFileName(imageSource.fileName || 'image.jpg');
              const blob = new Blob([res.buffer], { type: mimeType });
              const objectUrl = URL.createObjectURL(blob);
              this.slideshowBlobs.set(objectUrl, blob);
              this.assignImageFileName(imageIndex, objectUrl);
              const metadata = res.metadata ?? this.parsePatMetadataFromHeaders(res.headers);
              if (metadata) {
                imageSource.patMetadata = metadata;
              }
              // Cache the image
              if (cacheKey) {
                this.imageCache.set(cacheKey, { objectUrl, blob, metadata });
                this.loadingImageKeys.delete(cacheKey);
              }
              return { objectUrl, blob, imageIndex, cacheKey, metadata };
            })
          ).subscribe(
            ({ objectUrl, blob, imageIndex, cacheKey, metadata }) => {
              if (!this.imageLoadActive) {
                this.activeImageLoads--;
                return;
              }
              // Handle cached image (will also handle pending indices)
              if (cacheKey) {
                this.handleCachedImageLoaded(cacheKey, objectUrl, blob, imageIndex, metadata);
              } else {
                this.handleImageLoaded(objectUrl, blob, imageIndex, metadata);
              }
              this.activeImageLoads--;
              // Process next in queue immediately
              this.processImageLoadQueue();
            },
            (error) => {
              if (cacheKey) {
                this.loadingImageKeys.delete(cacheKey);
                this.pendingImageLoads.delete(cacheKey);
              }
              this.activeImageLoads--;
              // Process next in queue immediately
              this.processImageLoadQueue();
            }
          );
          this.imageLoadingSubs.push(subscription);
        } else if (imageSource.blobUrl) {
          // Use provided blob URL directly
          // Check if already cached
          if (cacheKey && this.imageCache.has(cacheKey)) {
            const cached = this.imageCache.get(cacheKey)!;
            this.handleCachedImageLoaded(cacheKey, cached.objectUrl, cached.blob, imageIndex, cached.metadata);
            // Process next in queue (no need to increment activeImageLoads for cached images)
            this.processImageLoadQueue();
          } else {
            // Blob URLs are instant, so we don't need to increment activeImageLoads here
            // (it was already incremented before startRequest)
            if (imageSource.blob) {
              this.slideshowBlobs.set(imageSource.blobUrl, imageSource.blob);
              this.assignImageFileName(imageIndex, imageSource.blobUrl);
              if (imageSource.patMetadata) {
                this.imagePatMetadata.set(imageSource.blobUrl, imageSource.patMetadata);
              }
              // Cache the image
              if (cacheKey) {
                this.imageCache.set(cacheKey, { objectUrl: imageSource.blobUrl, blob: imageSource.blob, metadata: imageSource.patMetadata });
              }
            }
            if (cacheKey) {
              this.loadingImageKeys.delete(cacheKey);
            }
            this.handleImageLoaded(imageSource.blobUrl, imageSource.blob || null, imageIndex, imageSource.patMetadata);
            // Decrement counter since blob URL is instant
            this.activeImageLoads--;
            // Process next in queue
            this.processImageLoadQueue();
          }
        } else {
          // No valid source, skip
          if (cacheKey) {
            this.loadingImageKeys.delete(cacheKey);
          }
          this.activeImageLoads--;
          this.processImageLoadQueue();
        }
      };
      
      // Start request immediately (non-blocking)
      startRequest();
    }
  }
  
  // Handle image loaded - add to slideshow (thumbnail generation is decoupled)
  private handleImageLoaded(objectUrl: string, blob: Blob | null, imageIndex: number, metadata?: PatMetadata): void {
    // Insert image at its correct position in the sorted order (imageIndex)
    // This ensures images appear in the correct order even if they load asynchronously
    const slideshowIndex = imageIndex;
    if (slideshowIndex < this.slideshowImages.length) {
      this.slideshowImages[slideshowIndex] = objectUrl;
    } else {
      // Fallback: if array wasn't pre-allocated, extend it
      while (this.slideshowImages.length <= slideshowIndex) {
        this.slideshowImages.push('');
      }
      this.slideshowImages[slideshowIndex] = objectUrl;
    }

    this.assignImageFileName(imageIndex, objectUrl);

    const imageSource = this.images[imageIndex];
    const effectiveMetadata = metadata ?? imageSource?.patMetadata;

    if (imageSource && imageSource.relativePath && imageSource.fileName) {
      const variantType: 'compressed' | 'original' = imageSource.compressFs === false ? 'original' : 'compressed';
      let variants = this.filesystemImageVariants.get(imageIndex);
      if (!variants) {
        variants = { currentVariant: variantType };
        this.filesystemImageVariants.set(imageIndex, variants);
      }
      if (variantType === 'original') {
        variants.originalUrl = objectUrl;
        if (effectiveMetadata) {
          variants.originalMetadata = effectiveMetadata;
        }
      } else {
        variants.compressedUrl = objectUrl;
        if (effectiveMetadata) {
          variants.compressedMetadata = effectiveMetadata;
        }
      }
      if (!variants.currentVariant) {
        variants.currentVariant = variantType;
      }
      if (this.filesystemVariantLoading.has(imageIndex)) {
        this.filesystemVariantLoading.delete(imageIndex);
      }
    } else {
      this.filesystemImageVariants.delete(imageIndex);
      this.filesystemVariantLoading.delete(imageIndex);
    }

    if (effectiveMetadata) {
      this.imagePatMetadata.set(objectUrl, effectiveMetadata);
    }
    
    // Map slideshowImages index to this.images index
    this.slideshowIndexToImageIndex.set(slideshowIndex, imageIndex);
    this.imageUrlToThumbnailIndex.set(objectUrl, imageIndex);
    
    // Store blob for thumbnail generation (completely decoupled - will be processed by independent process)
    if (blob) {
      this.thumbnailBlobStorage.set(imageIndex, blob);
      // NO thumbnail generation here - it's completely decoupled and handled by independent process
    }
    
    // Pre-load EXIF data in background (non-blocking)
    if (blob) {
      this.preloadExifData(objectUrl, blob).catch(() => {
        // Silently fail if EXIF loading fails
      });
    }

    // Count actually loaded images (non-empty strings)
    const loadedImagesCount = this.slideshowImages.filter(url => url && url !== '').length;
    
    // Update showThumbnails in next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
    // Double-check userToggledThumbnails inside setTimeout to prevent race condition with toggleThumbnails()
    if (loadedImagesCount > 1 && !this.showThumbnails && !this.userToggledThumbnails) {
      setTimeout(() => {
        // Re-check userToggledThumbnails to prevent race condition if user toggled thumbnails during setTimeout delay
        if (!this.userToggledThumbnails && !this.showThumbnails) {
          this.showThumbnails = true;
        }
      }, 0);
    }
    
    // Update current image URL if this is the current image
    if (imageIndex === this.currentSlideshowIndex) {
      this.updateCurrentSlideshowImageUrl();
      // Ensure the view updates immediately so the first (or current) image is shown as soon as it's available
      this.cdr.detectChanges();
    }
    
    // If we have a pending startIndex and this is the image at that index, navigate to it
    if (this.pendingStartIndex !== null && imageIndex === this.pendingStartIndex) {
      this.currentSlideshowIndex = this.pendingStartIndex;
      this.updateCurrentSlideshowImageUrl();
      this.pendingStartIndex = null; // Clear pending index
      this.cdr.detectChanges();
    }
    
    // Reset zoom when first image loads
    if (loadedImagesCount === 1 && imageIndex === 0) {
      setTimeout(() => {
        this.resetSlideshowZoom();
        this.updateContainerDimensions();
        setTimeout(() => {
          this.updateImageDimensions();
          this.updateContainerDimensions();
        }, 200);
      }, 100);
    }
    
    this.cdr.detectChanges();
  }

  private assignImageFileName(imageIndex: number, objectUrl: string): void {
    if (!objectUrl) {
      return;
    }

    const existingName = this.imageFileNames.get(objectUrl);
    if (existingName && existingName.length > 0) {
      return;
    }

    const imageSource = this.images[imageIndex];
    if (!imageSource) {
      return;
    }

    let fileName = imageSource.fileName;

    if (!fileName && imageSource.relativePath) {
      const pathSegments = imageSource.relativePath.split(/[\\\/]/).filter(segment => !!segment);
      if (pathSegments.length > 0) {
        fileName = pathSegments[pathSegments.length - 1];
      }
    }

    if (!fileName && imageSource.blobUrl) {
      try {
        const url = new URL(imageSource.blobUrl);
        fileName = url.pathname.split('/').pop() || '';
      } catch (_) {
        // Ignore invalid URL parsing for blob URLs
      }
    }

    if (!fileName && imageSource.fileId) {
      fileName = imageSource.fileId;
    }

    if (!fileName || fileName.trim().length === 0) {
      fileName = 'image.jpg';
    }

    this.imageFileNames.set(objectUrl, fileName);
  }
  
  // Handle cached image loaded - reuse cached image for multiple indices
  private handleCachedImageLoaded(cacheKey: string, objectUrl: string, blob: Blob, imageIndex: number, metadata?: PatMetadata): void {
    // Handle the main image index
    this.handleImageLoaded(objectUrl, blob, imageIndex, metadata);
    
    // Handle all pending image indices waiting for this same image
    const pendingIndices = this.pendingImageLoads.get(cacheKey);
    if (pendingIndices && pendingIndices.length > 0) {
      pendingIndices.forEach(pendingIndex => {
        this.handleImageLoaded(objectUrl, blob, pendingIndex, metadata);
      });
      this.pendingImageLoads.delete(cacheKey);
    }
  }
  
  // Load images into slideshow
  private loadImages(): void {
    if (!this.images || this.images.length === 0) {
      return;
    }
    
    // Initialize thumbnails array
    this.thumbnails = new Array(this.images.length).fill('');
    
    // Pre-allocate slideshowImages array to maintain correct order
    // Images will be inserted at their correct index position, not appended
    this.slideshowImages = new Array(this.images.length).fill('');
    
    // Queue all images for loading with priority (first images loaded first)
    this.images.forEach((imageSource, imageIndex) => {
      if (!imageSource) return;
      
      // Priority: first 10 images have highest priority (0-9), then others (100+)
      const priority = imageIndex < 10 ? imageIndex : imageIndex + 100;
      
      if (this.loadFromFileService && imageSource.fileId) {
        this.queueImageLoad(imageSource, imageIndex, priority);
      } else if (imageSource.relativePath && imageSource.fileName && !imageSource.blobUrl) {
        this.queueImageLoad(imageSource, imageIndex, priority);
      } else if (imageSource.blobUrl) {
        // For blob URLs, handle immediately (no network request needed)
        this.handleImageLoaded(imageSource.blobUrl, imageSource.blob || null, imageIndex, imageSource.patMetadata);
      }
    });
    
    // Reset zoom when images are loaded (for blob URLs loaded immediately)
    if (this.slideshowImages.length > 0) {
      setTimeout(() => {
        this.resetSlideshowZoom();
        this.updateContainerDimensions();
        setTimeout(() => {
          this.updateImageDimensions();
          this.updateContainerDimensions();
        }, 200);
      }, 100);
    }
  }
  
  // Method to add images dynamically (for progressive loading)
  public addImages(newImages: SlideshowImageSource[]): void {
    if (!newImages || newImages.length === 0) {
      return;
    }
    
    const startIndex = this.images.length;
    
    // Extend slideshowImages array to accommodate new images
    const newLength = startIndex + newImages.length;
    while (this.slideshowImages.length < newLength) {
      this.slideshowImages.push('');
    }
    // Extend thumbnails array as well
    while (this.thumbnails.length < newLength) {
      this.thumbnails.push('');
    }
    
    newImages.forEach((imageSource, relativeIndex) => {
      const imageIndex = startIndex + relativeIndex;
      this.images.push(imageSource);
      
      if (imageSource.blobUrl && !this.slideshowImages.includes(imageSource.blobUrl)) {
        // Use provided blob URL directly (no network request needed)
        if (imageSource.blob) {
          this.slideshowBlobs.set(imageSource.blobUrl, imageSource.blob);
        }
        this.handleImageLoaded(imageSource.blobUrl, imageSource.blob || null, imageIndex, imageSource.patMetadata);
      } else if (imageSource.fileId && this.loadFromFileService && this.imageLoadActive) {
        // Queue for loading via FileService
        const priority = imageIndex + 1000; // Lower priority for dynamically added images
        this.queueImageLoad(imageSource, imageIndex, priority);
      } else if (imageSource.relativePath && imageSource.fileName && !imageSource.blobUrl) {
        // Queue for loading from filesystem
        const priority = imageIndex + 1000; // Lower priority for dynamically added images
        this.queueImageLoad(imageSource, imageIndex, priority);
      }
    });
  }
  
  // Queue thumbnail generation for parallel processing (completely decoupled from image loading)
  private queueThumbnailGeneration(imageIndex: number, blob: Blob | null, priority: number = 0): void {
    // Skip if already in queue or already loaded
    if (this.thumbnailGenerationQueue.some(item => item.imageIndex === imageIndex) ||
        this.loadingThumbnailImageIndices.has(imageIndex) ||
        this.thumbnails[imageIndex]) {
      return;
    }
    
    // If blob not provided, try to get it from storage
    if (!blob) {
      blob = this.thumbnailBlobStorage.get(imageIndex) || null;
      if (!blob) {
        // Blob not available yet, skip for now (will be queued when image loads)
        return;
      }
    }
    
    // Ensure thumbnails array is large enough
    while (this.thumbnails.length <= imageIndex) {
      this.thumbnails.push('');
    }
    
    // Add to queue with priority (lower number = higher priority)
    this.thumbnailGenerationQueue.push({ imageIndex, blob: blob!, priority });
    
    // Sort queue by priority (lower priority number first)
    this.thumbnailGenerationQueue.sort((a, b) => a.priority - b.priority);
    
    // Process queue (non-blocking, independent from image loading)
    setTimeout(() => {
      if (this.thumbnailGenerationActive) {
        this.processThumbnailGenerationQueue();
      }
    }, 0);
  }
  
  // Start independent thumbnail generation process (completely decoupled from image loading)
  private startIndependentThumbnailGeneration(): void {
    // Stop any existing interval
    this.stopIndependentThumbnailGeneration();
    
    // Start periodic process to generate thumbnails independently
    this.thumbnailGenerationInterval = setInterval(() => {
      if (!this.thumbnailGenerationActive) {
        this.stopIndependentThumbnailGeneration();
        return;
      }
      
      // Process stored blobs for thumbnail generation (completely independent from image loading)
      this.thumbnailBlobStorage.forEach((blob, imageIndex) => {
        // Only queue if not already generated, not loading, and not in queue
        if (!this.thumbnails[imageIndex] && 
            !this.loadingThumbnailImageIndices.has(imageIndex) &&
            !this.thumbnailGenerationQueue.some(item => item.imageIndex === imageIndex)) {
          // Priority: first images have higher priority, but much lower than image loading
          const thumbnailPriority = imageIndex < 15 ? imageIndex + 10000 : imageIndex + 20000;
          this.queueThumbnailGeneration(imageIndex, blob, thumbnailPriority);
        }
      });
    }, 100); // Check every 100ms for new blobs to process
  }
  
  // Stop independent thumbnail generation process
  private stopIndependentThumbnailGeneration(): void {
    if (this.thumbnailGenerationInterval) {
      clearInterval(this.thumbnailGenerationInterval);
      this.thumbnailGenerationInterval = undefined;
    }
  }
  
  // Process thumbnail generation queue with parallel execution (completely independent from image loading)
  private processThumbnailGenerationQueue(): void {
    // Only process if thumbnail generation is active
    if (!this.thumbnailGenerationActive) {
      return;
    }
    
    // Process up to maxConcurrentThumbnailGenerations thumbnails at once
    while (this.activeThumbnailGenerations < this.maxConcurrentThumbnailGenerations && 
           this.thumbnailGenerationQueue.length > 0 &&
           this.thumbnailGenerationActive) {
      const item = this.thumbnailGenerationQueue.shift();
      if (!item) break;
      
      const { imageIndex, blob } = item;
      
      // Skip if already loading, pending, or loaded
      if (this.loadingThumbnailImageIndices.has(imageIndex) || 
          this.pendingThumbnailImageIndices.has(imageIndex) || 
          this.thumbnails[imageIndex]) {
        continue;
      }
      
      // Mark as pending synchronously to prevent duplicates, but defer actual Set update
      // to avoid ExpressionChangedAfterItHasBeenCheckedError
      this.pendingThumbnailImageIndices.add(imageIndex);
      
      // Defer loading state updates to next change detection cycle
      setTimeout(() => {
        this.ngZone.run(() => {
          this.pendingThumbnailImageIndices.delete(imageIndex);
          this.loadingThumbnailImageIndices.add(imageIndex);
          this.activeThumbnailGenerations++;
          this.isLoadingThumbnails = true;
          this.cdr.markForCheck();
        });
      }, 0);
      
      // Generate thumbnail (completely independent from image loading)
      this.generateThumbnailFromBlob(blob).then(
        (thumbnailUrl) => {
          if (this.thumbnailGenerationActive) {
            // Defer updates to next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
            this.ngZone.run(() => {
              this.thumbnails[imageIndex] = thumbnailUrl;
              this.loadingThumbnailImageIndices.delete(imageIndex);
              this.activeThumbnailGenerations--;
              this.cdr.markForCheck();
              // Process next in queue (non-blocking)
              setTimeout(() => {
                if (this.thumbnailGenerationActive) {
                  this.processThumbnailGenerationQueue();
                }
              }, 0);
            });
          }
        },
        (error) => {
          if (this.thumbnailGenerationActive) {
            // Defer updates to next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
            this.ngZone.run(() => {
              this.thumbnails[imageIndex] = '';
              this.loadingThumbnailImageIndices.delete(imageIndex);
              this.activeThumbnailGenerations--;
              this.cdr.markForCheck();
              // Process next in queue (non-blocking)
              setTimeout(() => {
                if (this.thumbnailGenerationActive) {
                  this.processThumbnailGenerationQueue();
                }
              }, 0);
            });
          }
        }
      );
    }
    
    // Mark loading as complete if queue is empty and no active generations
    // Defer to next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
    if (this.thumbnailGenerationQueue.length === 0 && this.activeThumbnailGenerations === 0) {
      setTimeout(() => {
        this.ngZone.run(() => {
          this.isLoadingThumbnails = false;
          this.cdr.markForCheck();
        });
      }, 0);
    }
  }
  
  // Generate thumbnail from blob using canvas (client-side)
  private generateThumbnailFromBlob(blob: Blob, maxWidth: number = 200, maxHeight: number = 200): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      
      img.onload = () => {
        try {
          // Calculate thumbnail dimensions maintaining aspect ratio
          let width = img.width;
          let height = img.height;
          
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = width * ratio;
            height = height * ratio;
          }
          
          // Create canvas and draw resized image
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Could not get canvas context'));
            return;
          }
          
          // Use high-quality image rendering
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          
          // Draw image on canvas
          ctx.drawImage(img, 0, 0, width, height);
          
          // Convert canvas to blob
          canvas.toBlob((thumbnailBlob) => {
            URL.revokeObjectURL(objectUrl);
            
            if (thumbnailBlob) {
              const thumbnailUrl = URL.createObjectURL(thumbnailBlob);
              this.thumbnailBlobs.set(thumbnailUrl, thumbnailBlob);
              resolve(thumbnailUrl);
            } else {
              reject(new Error('Failed to create thumbnail blob'));
            }
          }, 'image/jpeg', 0.7); // Use JPEG with 0.7 quality for smaller file size
        } catch (error) {
          URL.revokeObjectURL(objectUrl);
          reject(error);
        }
      };
      
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Failed to load image for thumbnail generation'));
      };
      
      img.src = objectUrl;
    });
  }
  
  // Setup fullscreen listener
  private setupFullscreenListener(): void {
    // Remove existing listener if any
    this.removeFullscreenListener();
    
    this.fullscreenChangeHandler = () => {
      const wasFullscreen = this.isFullscreen;
      this.isFullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
        (document as any).mozFullScreenElement || (document as any).msFullscreenElement);
      
      // Add/remove fullscreen class to body for CSS targeting
      if (this.isFullscreen) {
        document.body.classList.add('slideshow-fullscreen-active');
        // Force thumbnails to be visible in fullscreen
        setTimeout(() => {
          const thumbnailsStrip = document.querySelector('.thumbnails-strip') as HTMLElement;
          if (thumbnailsStrip && this.showThumbnails) {
            thumbnailsStrip.style.display = 'block';
            thumbnailsStrip.style.visibility = 'visible';
            thumbnailsStrip.style.opacity = '1';
            thumbnailsStrip.style.position = 'fixed';
            thumbnailsStrip.style.bottom = '70px';
            thumbnailsStrip.style.left = '0';
            thumbnailsStrip.style.right = '0';
            thumbnailsStrip.style.width = '100vw';
            thumbnailsStrip.style.maxWidth = '100vw';
            thumbnailsStrip.style.zIndex = '100'; // Much lower than shortcuts (2000000) so shortcuts appear in front
            thumbnailsStrip.style.background = 'rgba(255, 255, 255, 0.3)'; /* Blanc transparent */
            thumbnailsStrip.style.border = '2px solid rgba(0, 0, 0, 0.5)'; /* Bord noir */
            thumbnailsStrip.style.pointerEvents = 'auto';
          }
        }, 100);
      } else {
        document.body.classList.remove('slideshow-fullscreen-active');
        // Reset thumbnails styles when exiting fullscreen
        setTimeout(() => {
          const thumbnailsStrip = document.querySelector('.thumbnails-strip') as HTMLElement;
          if (thumbnailsStrip) {
            thumbnailsStrip.style.position = '';
            thumbnailsStrip.style.bottom = '';
            thumbnailsStrip.style.left = '';
            thumbnailsStrip.style.right = '';
            thumbnailsStrip.style.width = '';
            thumbnailsStrip.style.maxWidth = '';
            thumbnailsStrip.style.zIndex = '';
            thumbnailsStrip.style.background = '';
            thumbnailsStrip.style.border = '';
            thumbnailsStrip.style.pointerEvents = '';
          }
        }, 100);
      }
      
      // Si on était en plein écran et qu'on vient de sortir, et qu'on veut empêcher la sortie
      // alors on rétablit le plein écran immédiatement
      if (wasFullscreen && !this.isFullscreen && this.preventFullscreenExit) {
        this.preventFullscreenExit = false;
        // Rétablir le plein écran immédiatement avec requestAnimationFrame pour plus de réactivité
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                             document.querySelector('.slideshow-image-wrapper') as HTMLElement;
            if (container && !this.isFullscreen) {
              try {
                if (container.requestFullscreen) {
                  container.requestFullscreen().catch(() => {});
                } else if ((container as any).webkitRequestFullscreen) {
                  (container as any).webkitRequestFullscreen();
                } else if ((container as any).mozRequestFullScreen) {
                  (container as any).mozRequestFullScreen();
                } else if ((container as any).msRequestFullscreen) {
                  (container as any).msRequestFullscreen();
                }
              } catch (error) {
              }
            }
          });
        });
      } else {
        // Calculer le point de l'image qui est actuellement au centre AVANT le changement
        const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
        if (!container || this.slideshowZoom <= 1) {
          this.updateContainerDimensions();
          return;
        }
        
        const oldRect = container.getBoundingClientRect();
        const oldCenterX = oldRect.width / 2;
        const oldCenterY = oldRect.height / 2;
        const oldZoom = this.slideshowZoom;
        
        // Calculer le point de l'image qui est au centre actuellement
        // En utilisant la même logique que zoomOnPoint
        const pointRelativeToCenterX = oldCenterX - oldCenterX; // = 0 (point au centre)
        const pointRelativeToCenterY = oldCenterY - oldCenterY; // = 0 (point au centre)
        const imagePointX = (pointRelativeToCenterX - this.slideshowTranslateX) / oldZoom;
        const imagePointY = (pointRelativeToCenterY - this.slideshowTranslateY) / oldZoom;
        
        // Update container dimensions when fullscreen changes
        this.updateContainerDimensions();
        
        // Après le changement, utiliser zoomOnPoint pour maintenir le même point au nouveau centre
        setTimeout(() => {
          if (container && this.slideshowZoom > 1) {
            const newRect = container.getBoundingClientRect();
            const newCenterX = newRect.width / 2;
            const newCenterY = newRect.height / 2;
            
            // Utiliser zoomOnPoint pour maintenir le même point de l'image au nouveau centre
            // On passe le même zoom avant et après pour maintenir le point
            this.zoomOnPoint(oldZoom, newCenterX, newCenterY, oldZoom);
            
            // Clamper la translation si nécessaire
            this.clampSlideshowTranslation();
            this.cdr.detectChanges();
          }
        }, 150);
      }
      
      // Ajouter/retirer le listener Escape sur l'élément en plein écran
      this.setupFullscreenEscapeHandler();
    };
    
    // Setup fullscreen escape handler on the fullscreen element
    this.setupFullscreenEscapeHandler();
    
    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('mozfullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('MSFullscreenChange', this.fullscreenChangeHandler);
  }
  
  // Recalculer la translation pour maintenir le point central visible au même endroit
  // Update container dimensions (called when container size changes)
  // Debounced to avoid too many expensive getBoundingClientRect calls
  private updateContainerDimensions(): void {
    // Clear existing timer
    if (this.dimensionUpdateTimer) {
      cancelAnimationFrame(this.dimensionUpdateTimer);
    }
    
    // Mark that an update is pending
    this.pendingDimensionUpdate = true;
    
    // Debounce the actual update (use requestAnimationFrame for better batching)
    this.dimensionUpdateTimer = requestAnimationFrame(() => {
      this.dimensionUpdateTimer = null;
      
      if (!this.pendingDimensionUpdate) {
        return;
      }
      
      this.pendingDimensionUpdate = false;
      
      try {
        const container = this.slideshowContainerRef?.nativeElement;
        if (container) {
          const rect = container.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            this.containerWidth = Math.round(rect.width);
            this.containerHeight = Math.round(rect.height);
            
            // Also update image dimensions and other info - but don't call it here as it will
            // trigger another getBoundingClientRect, just update container dimensions only
            // updateImageDimensions() will be called separately when needed
          }
        }
      } catch (error) {
        // Silently ignore errors
      }
    });
  }
  
  // Handle image load event
  public onImageLoad(): void {
    // Update dimensions when image loads - use requestAnimationFrame for better performance
    requestAnimationFrame(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
      this.slideshowBackgroundImageUrl = this.getCurrentSlideshowImage();
      // Update blurred background image
      this.updateBackgroundImageStyle();
    });
    
    // Skip background color update if we're just switching variants (same image, different quality)
    // This prevents expensive recalculation when it's not needed
    const wasSwitchingVariant = this.isSwitchingVariant;
    this.isSwitchingVariant = false; // Reset flag after image loads
    
    // Defer background color calculation completely outside requestAnimationFrame
    // This expensive operation (canvas operations) should not block rendering
    // Only update if not currently zooming and not switching variants
    if (!this.isZooming && !wasSwitchingVariant) {
      // Use requestIdleCallback if available (runs when browser is idle, truly non-blocking)
      // Fallback to setTimeout with significant delay to ensure it doesn't block rendering
      if (typeof (window as any).requestIdleCallback === 'function') {
        (window as any).requestIdleCallback(() => {
          this.updateAverageBackgroundColor();
        }, { timeout: 2000 });
      } else {
        // Fallback: use setTimeout with longer delay to push way out
        // This ensures the image renders completely before expensive operation
        setTimeout(() => {
          this.updateAverageBackgroundColor();
        }, 500);
      }
    }
    
    // Ensure programmatic event listeners are set up when image loads
    this.setupProgrammaticEventListeners();
  }

  private updateAverageBackgroundColor(): void {
    try {
      // Ne pas recalculer la couleur de fond pendant le zoom
      if (this.isZooming) {
        return;
      }
      
      if (this.showMapView) {
        // If showing map view, keep default/darker background
        // Defer update to avoid ExpressionChangedAfterItHasBeenCheckedError
        this.ngZone.runOutsideAngular(() => {
          setTimeout(() => {
            this.ngZone.run(() => {
              this.slideshowBackgroundColor = 'black';
              this.cdr.markForCheck();
            });
          }, 0);
        });
        return;
      }
      const imgEl = this.slideshowImgElRef?.nativeElement;
      if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0 || imgEl.naturalHeight === 0) {
        return;
      }
      // Run the expensive canvas operations outside Angular zone
      // DO NOT use requestAnimationFrame for the expensive work - it blocks rendering!
      // Do the work synchronously or in setTimeout, then use requestAnimationFrame only for the final update
      this.ngZone.runOutsideAngular(() => {
        // Use setTimeout to push expensive work out of the current frame
        // This prevents blocking the requestAnimationFrame handler
        setTimeout(() => {
          // Preserve aspect ratio; scale longest side to target (further reduced for better performance)
          const targetMax = 40; // Reduced from 80 to 40 for much faster processing
          const iw = imgEl.naturalWidth;
          const ih = imgEl.naturalHeight;
          const scale = Math.min(targetMax / Math.max(iw, ih), 1);
          const tw = Math.max(1, Math.round(iw * scale));
          const th = Math.max(1, Math.round(ih * scale));
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            return;
          }
          canvas.width = tw;
          canvas.height = th;
          ctx.drawImage(imgEl, 0, 0, tw, th);
          const imageData = ctx.getImageData(0, 0, tw, th);
          const data = imageData.data;
          let r = 0, g = 0, b = 0, count = 0;
          
          // Sample every 32nd pixel for maximum performance (reduced from 16)
          // This reduces processing time significantly while still getting acceptable results
          for (let i = 0; i < data.length; i += 32) {
            const alpha = data[i + 3];
            // Skip nearly transparent pixels to avoid background bleed
            if (alpha < 250) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
          
          // Now use requestAnimationFrame ONLY for the final Angular update (not the expensive work)
          requestAnimationFrame(() => {
            this.ngZone.run(() => {
              if (count > 0) {
                const avgR = Math.round(r / count);
                const avgG = Math.round(g / count);
                const avgB = Math.round(b / count);
                this.slideshowBackgroundColor = `rgb(${avgR}, ${avgG}, ${avgB})`;
              } else {
                this.slideshowBackgroundColor = 'black';
              }
              this.cdr.markForCheck();
            });
          });
        }, 0);
      });
    } catch {
      // In case of CORS-tainted canvas or other errors, fallback gracefully to transparent
      // so the blurred image background (if any) can show through.
      // Defer update to avoid ExpressionChangedAfterItHasBeenCheckedError
      this.ngZone.runOutsideAngular(() => {
        setTimeout(() => {
          this.ngZone.run(() => {
            this.slideshowBackgroundColor = 'transparent';
            this.cdr.markForCheck();
          });
        }, 0);
      });
    }
  }
  
  // Update CSS variable for blurred background image
  private updateBackgroundImageStyle(): void {
    const container = this.slideshowContainerRef?.nativeElement;
    if (container && this.currentSlideshowImageUrl) {
      container.style.setProperty('--slideshow-bg-image', `url(${this.currentSlideshowImageUrl})`);
    } else if (container) {
      container.style.setProperty('--slideshow-bg-image', 'none');
    }
  }

  // Update all image-related dimensions for display
  private updateImageDimensions(): void {
    try {
      if (this.showMapView) {
        this.resetAllDimensions();
        return;
      }
      
      // Check if modal is open first
      if (!this.isSlideshowModalOpen || !this.modalRef) {
        // Modal not open, don't try to update dimensions
        return;
      }
      
      // Try to get elements - use ViewChild if available, otherwise query DOM directly
      let imgEl: HTMLImageElement | null = null;
      let container: HTMLElement | null = null;
      
      if (this.slideshowImgElRef?.nativeElement) {
        imgEl = this.slideshowImgElRef.nativeElement as HTMLImageElement;
      } else {
        // Fallback: query DOM directly
        imgEl = document.querySelector('.slideshow-image') as HTMLImageElement;
      }
      
      if (this.slideshowContainerRef?.nativeElement) {
        container = this.slideshowContainerRef.nativeElement as HTMLElement;
      } else {
        // Fallback: query DOM directly
        container = document.querySelector('.slideshow-image-wrapper') as HTMLElement;
      }
      
      if (!imgEl || !container) {
        this.resetAllDimensions();
        return;
      }
      
      // Get natural dimensions (original image size)
      const naturalW = imgEl.naturalWidth || 0;
      const naturalH = imgEl.naturalHeight || 0;
      
      if (naturalW === 0 || naturalH === 0) {
        // Image not loaded yet, try again later - use requestAnimationFrame instead of setTimeout
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.updateImageDimensions();
          });
        });
        return;
      }
      
      this.imageNaturalWidth = naturalW;
      this.imageNaturalHeight = naturalH;
      
      // Get container dimensions
      const containerRect = container.getBoundingClientRect();
      const containerW = containerRect.width || 1;
      const containerH = containerRect.height || 1;
      
      // Calculate how the image is fitted to container (before zoom)
      // Image is fitted to fill container while maintaining aspect ratio
      const containerAspect = containerW / containerH;
      const imageAspect = naturalW / naturalH;
      
      let baseDisplayW: number;
      let baseDisplayH: number;
      
      if (imageAspect > containerAspect) {
        // Image is wider - fit to width
        baseDisplayW = containerW;
        baseDisplayH = containerW / imageAspect;
      } else {
        // Image is taller - fit to height
        baseDisplayH = containerH;
        baseDisplayW = containerH * imageAspect;
      }
      
      this.imageDisplayWidth = Math.round(baseDisplayW);
      this.imageDisplayHeight = Math.round(baseDisplayH);
      
      // Get zoomed size
      this.imageZoomedWidth = Math.round(baseDisplayW * this.slideshowZoom);
      this.imageZoomedHeight = Math.round(baseDisplayH * this.slideshowZoom);
      
      // Update min zoom
      this.minZoom = this.getMinSlideshowZoom();
      
      // Update translation values
      this.translateX = Math.round(this.slideshowTranslateX);
      this.translateY = Math.round(this.slideshowTranslateY);
      
      // Calculate visible portion of image (what part of original image is displayed)
      this.calculateVisibleImagePortion();
    } catch (error) {
      this.resetAllDimensions();
    }
  }
  
  // Reset all dimension values to 0
  private resetAllDimensions(): void {
    this.imageNaturalWidth = 0;
    this.imageNaturalHeight = 0;
    this.imageDisplayWidth = 0;
    this.imageDisplayHeight = 0;
    this.imageZoomedWidth = 0;
    this.imageZoomedHeight = 0;
    this.visibleImageOriginX = 0;
    this.visibleImageOriginY = 0;
    this.visibleImageWidth = 0;
    this.visibleImageHeight = 0;
  }
  
  // Calculate what portion of the original image is currently visible
  private calculateVisibleImagePortion(): void {
    try {
      if (this.showMapView) {
        this.visibleImageOriginX = 0;
        this.visibleImageOriginY = 0;
        this.visibleImageWidth = 0;
        this.visibleImageHeight = 0;
        return;
      }
      
      // Try to get elements - use ViewChild if available, otherwise query DOM directly
      let imgEl: HTMLImageElement | null = null;
      let container: HTMLElement | null = null;
      
      if (this.slideshowImgElRef?.nativeElement) {
        imgEl = this.slideshowImgElRef.nativeElement as HTMLImageElement;
      } else {
        // Fallback: query DOM directly
        imgEl = document.querySelector('.slideshow-image') as HTMLImageElement;
      }
      
      if (this.slideshowContainerRef?.nativeElement) {
        container = this.slideshowContainerRef.nativeElement as HTMLElement;
      } else {
        // Fallback: query DOM directly
        container = document.querySelector('.slideshow-image-wrapper') as HTMLElement;
      }
      
      if (!container || !imgEl) {
        this.visibleImageOriginX = 0;
        this.visibleImageOriginY = 0;
        this.visibleImageWidth = 0;
        this.visibleImageHeight = 0;
        return;
      }
      
      // Get natural image dimensions (original image size)
      const naturalW = imgEl.naturalWidth || 0;
      const naturalH = imgEl.naturalHeight || 0;
      
      if (naturalW === 0 || naturalH === 0) {
        this.visibleImageOriginX = 0;
        this.visibleImageOriginY = 0;
        this.visibleImageWidth = 0;
        this.visibleImageHeight = 0;
        return;
      }
      
      // Get container dimensions
      const containerRect = container.getBoundingClientRect();
      const containerW = containerRect.width || 1;
      const containerH = containerRect.height || 1;
      
      // Use the calculated display dimensions from updateImageDimensions
      const imgBaseW = this.imageDisplayWidth || 1;
      const imgBaseH = this.imageDisplayHeight || 1;
      
      // Scale factor from natural to display size
      const scaleX = imgBaseW / naturalW;
      const scaleY = imgBaseH / naturalH;
      
      // Container center
      const containerCenterX = containerW / 2;
      const containerCenterY = containerH / 2;
      
      // Visible area in container is (0,0) to (containerW, containerH)
      // In zoomed image coordinates (relative to image center):
      const visibleLeftZoomed = -containerCenterX - this.slideshowTranslateX;
      const visibleTopZoomed = -containerCenterY - this.slideshowTranslateY;
      const visibleRightZoomed = containerCenterX - this.slideshowTranslateX;
      const visibleBottomZoomed = containerCenterY - this.slideshowTranslateY;
      
      // Convert to display coordinates (divide by zoom)
      const imgDisplayCenterX = imgBaseW / 2;
      const imgDisplayCenterY = imgBaseH / 2;
      
      const originXDisplay = imgDisplayCenterX + (visibleLeftZoomed / this.slideshowZoom);
      const originYDisplay = imgDisplayCenterY + (visibleTopZoomed / this.slideshowZoom);
      const visibleWDisplay = (visibleRightZoomed - visibleLeftZoomed) / this.slideshowZoom;
      const visibleHDisplay = (visibleBottomZoomed - visibleTopZoomed) / this.slideshowZoom;
      
      // Convert from display coordinates to natural image coordinates
      const originX = originXDisplay / scaleX;
      const originY = originYDisplay / scaleY;
      const visibleW = visibleWDisplay / scaleX;
      const visibleH = visibleHDisplay / scaleY;
      
      // Clamp to natural image bounds
      this.visibleImageOriginX = Math.max(0, Math.min(naturalW, Math.round(originX)));
      this.visibleImageOriginY = Math.max(0, Math.min(naturalH, Math.round(originY)));
      this.visibleImageWidth = Math.max(0, Math.min(naturalW - this.visibleImageOriginX, Math.round(visibleW)));
      this.visibleImageHeight = Math.max(0, Math.min(naturalH - this.visibleImageOriginY, Math.round(visibleH)));
    } catch (error) {
      this.visibleImageOriginX = 0;
      this.visibleImageOriginY = 0;
      this.visibleImageWidth = 0;
      this.visibleImageHeight = 0;
    }
  }
  
  // Setup resize listener
  private setupResizeListener(): void {
    // Remove existing listener if any
    this.removeResizeListener();
    
    this.resizeHandler = () => {
      this.updateContainerDimensions();
    };
    
    window.addEventListener('resize', this.resizeHandler);
  }
  
  // Remove resize listener
  private removeResizeListener(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
  }
  
  // Fix focus management to prevent accessibility issues
  // When modal opens, Bootstrap sets aria-hidden on app-root, but elements outside modal may retain focus
  private fixFocusManagement(): void {
    // Prevent multiple simultaneous calls
    if (this.focusFixInProgress) {
      return;
    }
    
    try {
      this.focusFixInProgress = true;
      
      // Use cached modal or query once
      if (!this.cachedModal) {
        this.cachedModal = document.querySelector('.modal.show');
      }
      const modal = this.cachedModal;
      if (!modal) {
        this.focusFixInProgress = false;
        return;
      }
      
      // Use cached app-root or query once
      if (!this.cachedAppRoot) {
        this.cachedAppRoot = document.querySelector('app-root') as HTMLElement;
      }
      const appRoot = this.cachedAppRoot;
      if (!appRoot || appRoot.getAttribute('aria-hidden') !== 'true') {
        this.focusFixInProgress = false;
        return;
      }
      
      const activeElement = document.activeElement as HTMLElement;
      if (!activeElement) {
        this.focusFixInProgress = false;
        return;
      }
      
      // Check if element is inside the modal (which should not have aria-hidden)
      if (modal.contains(activeElement)) {
        // Element is inside modal, which is fine - don't blur it
        this.focusFixInProgress = false;
        return;
      }
      
      // Check if the active element is inside app-root (which has aria-hidden="true")
      if (appRoot.contains(activeElement)) {
        // Blur the element to remove focus immediately
        if (typeof (activeElement as any).blur === 'function') {
          (activeElement as any).blur();
        }
        
        // Move focus to the modal's close button or first focusable element in modal
        // Do this synchronously to avoid delays
        this.moveFocusToModal();
        this.focusFixInProgress = false;
        return;
      }
      
      this.focusFixInProgress = false;
    } catch (error) {
      this.focusFixInProgress = false;
      // Ignore errors in focus management
    }
  }
  
  // Setup continuous focus monitoring to catch focus events on aria-hidden elements
  private setupFocusMonitoring(): void {
    // Remove existing handler if any
    this.removeFocusMonitoring();
    
    // Reset cache
    this.cachedAppRoot = null;
    this.cachedModal = null;
    this.focusFixInProgress = false;
    
    // Create handler that checks focus on focusin events (capture phase to catch early)
    this.focusManagementHandler = () => {
      // Prevent multiple simultaneous calls
      if (this.focusFixInProgress) {
        return;
      }
      
      // Use requestAnimationFrame for better performance (batches with browser rendering)
      requestAnimationFrame(() => {
        this.fixFocusManagement();
      });
    };
    
    // Listen to focusin event in capture phase to catch all focus changes
    document.addEventListener('focusin', this.focusManagementHandler, true);
    
    // Setup MutationObserver to watch for aria-hidden being added to app-root
    this.setupAriaHiddenObserver();
  }
  
  // Setup MutationObserver to detect when Bootstrap adds aria-hidden to app-root
  private setupAriaHiddenObserver(): void {
    // Remove existing observer if any
    this.removeAriaHiddenObserver();
    
    const appRoot = document.querySelector('app-root') as HTMLElement;
    if (!appRoot) {
      // Retry after a short delay if app-root is not yet available
      setTimeout(() => this.setupAriaHiddenObserver(), 100);
      return;
    }
    
    // Cache app-root
    this.cachedAppRoot = appRoot;
    
    // Create observer to watch for aria-hidden attribute changes
    this.ariaHiddenObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'aria-hidden') {
          const target = mutation.target as HTMLElement;
          if (target === appRoot && target.getAttribute('aria-hidden') === 'true') {
            // Bootstrap just added aria-hidden to app-root, immediately blur any focused elements
            // Do this synchronously to prevent the warning
            const activeElement = document.activeElement as HTMLElement;
            if (activeElement && activeElement !== document.body) {
              // Check if element is in app-root but not in modal
              const modal = document.querySelector('.modal.show');
              if (!modal || !modal.contains(activeElement)) {
                if (appRoot.contains(activeElement)) {
                  // Blur immediately and synchronously (no requestAnimationFrame delay)
                  if (typeof (activeElement as any).blur === 'function') {
                    (activeElement as any).blur();
                  }
                  // Move focus to modal synchronously to avoid delays
                  this.moveFocusToModal();
                }
              }
            }
          }
        }
      }
    });
    
    // Start observing app-root for attribute changes
    this.ariaHiddenObserver.observe(appRoot, {
      attributes: true,
      attributeFilter: ['aria-hidden']
    });
  }
  
  // Move focus to the modal's first focusable element
  private moveFocusToModal(): void {
    // Use cached modal
    if (!this.cachedModal) {
      this.cachedModal = document.querySelector('.modal.show');
    }
    const modal = this.cachedModal;
    if (!modal) {
      return;
    }
    
    // Try close button first
    const closeButton = modal.querySelector('.slideshow-header button[aria-label="Close"]') as HTMLElement;
    if (closeButton) {
      closeButton.focus();
      return;
    }
    
    // Fallback: find first focusable element in modal
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    if (focusableElements.length > 0) {
      (focusableElements[0] as HTMLElement).focus();
    }
  }
  
  // Remove aria-hidden observer
  private removeAriaHiddenObserver(): void {
    if (this.ariaHiddenObserver) {
      this.ariaHiddenObserver.disconnect();
      this.ariaHiddenObserver = undefined;
    }
  }
  
  // Remove focus monitoring handler
  private removeFocusMonitoring(): void {
    if (this.focusManagementHandler) {
      document.removeEventListener('focusin', this.focusManagementHandler, true);
      this.focusManagementHandler = undefined;
    }
    this.removeAriaHiddenObserver();
    
    // Clear cache
    this.cachedAppRoot = null;
    this.cachedModal = null;
    this.focusFixInProgress = false;
  }
  
  // Setup escape handler on fullscreen element
  private setupFullscreenEscapeHandler(): void {
    // Remove existing handler first
    this.removeFullscreenEscapeHandler();
    
    if (!this.isFullscreen) {
      return;
    }
    
    // Get the fullscreen element
    const fullscreenElement = document.fullscreenElement || 
                              (document as any).webkitFullscreenElement || 
                              (document as any).mozFullScreenElement || 
                              (document as any).msFullscreenElement;
    
    if (!fullscreenElement) {
      return;
    }
    
    // Add escape handler directly on the fullscreen element
    this.fullscreenEscapeHandler = (event: KeyboardEvent) => {
      if ((event.key === 'Escape' || event.keyCode === 27)) {
        // En plein écran : Escape sort du plein écran (pas de réinitialisation du zoom)
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.toggleFullscreen();
      }
    };
    
    fullscreenElement.addEventListener('keydown', this.fullscreenEscapeHandler, { capture: true, passive: false });
  }
  
  // Remove fullscreen escape handler
  private removeFullscreenEscapeHandler(): void {
    if (this.fullscreenEscapeHandler) {
      const fullscreenElement = document.fullscreenElement || 
                                (document as any).webkitFullscreenElement || 
                                (document as any).mozFullScreenElement || 
                                (document as any).msFullscreenElement;
      
      if (fullscreenElement) {
        fullscreenElement.removeEventListener('keydown', this.fullscreenEscapeHandler, { capture: true });
      }
      this.fullscreenEscapeHandler = undefined;
    }
  }
  
  // Remove fullscreen listeners
  private removeFullscreenListener(): void {
    if (this.fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('mozfullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('MSFullscreenChange', this.fullscreenChangeHandler);
      this.fullscreenChangeHandler = undefined;
    }
    this.removeFullscreenEscapeHandler();
  }
  
  // Get minimum zoom level - ensures image never becomes smaller than its container
  // Always uses visible container dimensions (works in both windowed and fullscreen modes)
  // Zoom is calculated based on natural image dimensions to ensure correct calculation for portrait images
  public getMinSlideshowZoom(): number {
    try {
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
      const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
      if (!container || !imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return 1;
      
      // Use getBoundingClientRect() to get the actual visible dimensions of the container
      // This ensures we always use the visible window dimensions, not fullscreen dimensions
      const containerRect = container.getBoundingClientRect();
      const cw = containerRect.width || container.clientWidth || 1;
      const ch = containerRect.height || container.clientHeight || 1;
      
      // Use natural dimensions (actual image size) for accurate calculation
      // This is critical for portrait images where rendered size might be different
      const imgNaturalWidth = imgEl.naturalWidth || 1;
      const imgNaturalHeight = imgEl.naturalHeight || 1;
      
      // Calculate the aspect ratios
      const containerAspect = cw / ch;
      const imageAspect = imgNaturalWidth / imgNaturalHeight;
      
      // Calculate zoom needed to fit the image in the container
      // For landscape images (imageAspect > containerAspect), width is limiting factor
      // For portrait images (imageAspect < containerAspect), height is limiting factor
      let fillZoom: number;
      if (imageAspect > containerAspect) {
        // Landscape: fit to width
        fillZoom = cw / imgNaturalWidth;
      } else {
        // Portrait: fit to height
        fillZoom = ch / imgNaturalHeight;
      }
      
      // Minimum zoom should never be less than 1 (never zoom out beyond original size)
      return Math.max(1, fillZoom);
    } catch { return 1; }
  }
  
  // Get the visible image area in the container (what portion of image is currently visible)
  private getVisibleImageArea(): { width: number; height: number; offsetX: number; offsetY: number } {
    try {
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
      const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
      if (!container || !imgEl) {
        return { width: 0, height: 0, offsetX: 0, offsetY: 0 };
      }
      
      const containerRect = container.getBoundingClientRect();
      const imgRect = imgEl.getBoundingClientRect();
      
      // Calculate what portion of the image is visible in the container
      const visibleWidth = Math.min(containerRect.width, imgRect.width);
      const visibleHeight = Math.min(containerRect.height, imgRect.height);
      
      // Calculate offset (how much of image is outside container)
      const offsetX = Math.max(0, (imgRect.width - containerRect.width) / 2);
      const offsetY = Math.max(0, (imgRect.height - containerRect.height) / 2);
      
      return {
        width: visibleWidth,
        height: visibleHeight,
        offsetX: offsetX,
        offsetY: offsetY
      };
    } catch {
      return { width: 0, height: 0, offsetX: 0, offsetY: 0 };
    }
  }
  
  // Apply wheel zoom with dynamic step based on current zoom level
  // Small step for small zoom, large step for large zoom
  private applyWheelZoom(event: WheelEvent, current: number, minZoom: number, maxZoom: number = 100): number {
    // preventDefault() est déjà fait dans onWheelSlideshow, pas besoin de le refaire ici
    // Ne pas faire stopPropagation() ici pour éviter de bloquer d'autres handlers
    
    // Utiliser deltaY avec une normalisation plus précise
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages
    let delta = 0;
    if (event.deltaMode === 0) {
      // Pixels mode - utiliser directement avec un facteur de normalisation
      delta = event.deltaY / 100; // Facteur réduit pour un zoom plus fluide
    } else if (event.deltaMode === 1) {
      // Lines mode - multiplier par un facteur
      delta = event.deltaY / 3; // Environ 3 lignes = 1 unité de zoom
    } else {
      // Pages mode - multiplier par un facteur plus grand
      delta = event.deltaY / 0.5; // 0.5 page = 1 unité de zoom
    }
    
    // Dynamic step: proportionnel au niveau de zoom actuel
    // Plus le zoom est élevé, plus le pas est grand (plus rapide)
    // Formule: step = baseStep * (1 + current * multiplier)
    // Cela donne: petit pas à zoom faible, grand pas à zoom élevé
    const baseStep = 0.5; // Pas de base augmenté pour zoom plus réactif
    const multiplier = 0.1; // Multiplicateur réduit pour un zoom plus progressif
    const dynamicStep = baseStep * (1 + current * multiplier);
    
    // Limiter le pas entre minStep et maxStep pour éviter des valeurs trop extrêmes
    const minStep = 0.3; // Pas minimum pour zoom visible
    const maxStep = 3.0; // Pas maximum réduit pour éviter les sauts trop grands
    const step = Math.max(minStep, Math.min(maxStep, dynamicStep));
    
    // Calculer le nouveau zoom avec le delta et le step
    let next = current - delta * step; // wheel up (deltaY négatif) -> zoom in, wheel down (deltaY positif) -> zoom out
    if (next < minZoom) next = minZoom;
    if (next > maxZoom) next = maxZoom;
    return parseFloat(next.toFixed(2));
  }
  
  public onWheelSlideshow(event: WheelEvent): void {
    if (this.showMapView) {
      return;
    }
    
    // Empêcher le comportement par défaut (scroll de la page)
    // Mais ne PAS faire stopPropagation() ici car d'autres handlers peuvent avoir besoin de l'événement
    event.preventDefault();
    
    // Marquer qu'on est en train de zoomer pour éviter le recalcul de la couleur de fond
    this.isZooming = true;
    
    const minZoom = this.getMinSlideshowZoom();
    const oldZoom = this.slideshowZoom;
    const newZoom = this.applyWheelZoom(event, this.slideshowZoom, minZoom);
    
    // Check if the new zoom is at or below minimum zoom (with small epsilon for floating point comparison)
    const epsilon = 0.01;
    const isAtMinZoom = newZoom <= minZoom + epsilon;
    
    if (isAtMinZoom) {
      // When at minimum zoom, use the same reset logic as pressing "R" key
      // This ensures zoom out matches the "R" key reset behavior
      this.resetSlideshowZoom();
    } else {
      this.slideshowZoom = newZoom;
      
      // Zoomer sur le point de la souris au lieu du centre
      // Utiliser le container en cache si disponible pour éviter getBoundingClientRect() à chaque fois
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          const mouseX = event.clientX - rect.left;
          const mouseY = event.clientY - rect.top;
          // Zoomer sur le point de la souris
          this.zoomOnPoint(newZoom, mouseX, mouseY, oldZoom);
        } else {
          // Fallback: zoomer sur le centre si on ne peut pas obtenir les coordonnées
          this.zoomOnCenter(newZoom, oldZoom);
        }
      } else {
        // Fallback: zoomer sur le centre si le container n'est pas disponible
        this.zoomOnCenter(newZoom, oldZoom);
      }
      
      // Only clamp translation when not at minimum zoom
      this.clampSlideshowTranslation();
      
      // Force change detection immédiatement pour une réactivité maximale
      this.cdr.detectChanges();
      
      // Recalculate image dimensions after zoom change - utiliser requestAnimationFrame pour une meilleure performance
      // Ne pas appeler updateImageDimensions à chaque wheel event pour éviter la surcharge
      // Utiliser un debounce pour les mises à jour de dimensions
      if (!this.pendingDimensionUpdate) {
        this.pendingDimensionUpdate = true;
        requestAnimationFrame(() => {
          this.updateImageDimensions();
          this.updateContainerDimensions();
          this.pendingDimensionUpdate = false;
          // Réinitialiser le flag de zoom après un court délai pour permettre les mises à jour normales
          setTimeout(() => {
            this.isZooming = false;
          }, 100);
        });
      } else {
        // Si une mise à jour est déjà en cours, réinitialiser le flag après un délai
        setTimeout(() => {
          this.isZooming = false;
        }, 100);
      }
    }
  }
  
  public resetSlideshowZoom(): void { 
    // Set zoom to 1 to show the full image (not zoomed in)
    this.slideshowZoom = 1; 
    this.slideshowTranslateX = 0; 
    this.slideshowTranslateY = 0;
    // Force change detection to apply changes immediately (same behavior as button click)
    this.cdr.detectChanges();
    // Recalculate dimensions when resetting zoom - use setTimeout to ensure DOM is updated
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 0);
  }
  
  // Apply event color to slideshow styling
  private applyEventColorToSlideshow(): void {
    if (!this.eventColor) {
      return;
    }
    
    const color = this.eventColor;
    // Calculate brightness to determine if we need lighter or darker variants
    const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
    const isBright = brightness > 128;
    
    // Header background - use gradient based on event color
    const headerBgR = Math.min(255, color.r + 20);
    const headerBgG = Math.min(255, color.g + 20);
    const headerBgB = Math.min(255, color.b + 20);
    const headerBg2R = Math.max(0, color.r - 10);
    const headerBg2G = Math.max(0, color.g - 10);
    const headerBg2B = Math.max(0, color.b - 10);
    
    // Header text color - inverse based on brightness
    const headerTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
    
    // Button colors - use event color with adjustments
    const buttonBorderR = Math.min(255, color.r + 30);
    const buttonBorderG = Math.min(255, color.g + 30);
    const buttonBorderB = Math.min(255, color.b + 30);
    const buttonTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
    const buttonHoverBgR = Math.min(255, color.r + 40);
    const buttonHoverBgG = Math.min(255, color.g + 40);
    const buttonHoverBgB = Math.min(255, color.b + 40);
    
    // Border color - use event color
    const borderColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
    
    // Footer background - use darker variant of event color
    const footerBgR = Math.max(0, color.r - 30);
    const footerBgG = Math.max(0, color.g - 30);
    const footerBgB = Math.max(0, color.b - 30);
    const footerBorderR = Math.max(0, color.r - 20);
    const footerBorderG = Math.max(0, color.g - 20);
    const footerBorderB = Math.max(0, color.b - 20);
    
    // Footer button colors - use event color with adjustments
    const footerButtonBgR = Math.min(255, color.r + 10);
    const footerButtonBgG = Math.min(255, color.g + 10);
    const footerButtonBgB = Math.min(255, color.b + 10);
    const footerButtonBorderR = Math.min(255, color.r + 20);
    const footerButtonBorderG = Math.min(255, color.g + 20);
    const footerButtonBorderB = Math.min(255, color.b + 20);
    const footerButtonTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
    const footerButtonHoverBgR = Math.min(255, color.r + 30);
    const footerButtonHoverBgG = Math.min(255, color.g + 30);
    const footerButtonHoverBgB = Math.min(255, color.b + 30);
    
    // Apply CSS variables to the modal element - try multiple selectors for compatibility
    // Try multiple times with different selectors and delays to ensure modal is in DOM
    const applyColors = (attempt: number = 0) => {
      let modalElement = document.querySelector('.modal.show .modal-content.slideshow-modal-wide') as HTMLElement;
      if (!modalElement) {
        modalElement = document.querySelector('.modal.show .modal-content') as HTMLElement;
      }
      if (!modalElement) {
        modalElement = document.querySelector('.slideshow-modal-wide .modal-content') as HTMLElement;
      }
      if (!modalElement && this.modalRef) {
        // Try to get element from modalRef
        const modalElementRef = (this.modalRef as any).componentInstance?.elementRef?.nativeElement?.querySelector('.modal-content');
        if (modalElementRef) {
          modalElement = modalElementRef;
        }
      }
      
      if (modalElement) {
        modalElement.style.setProperty('--slideshow-header-bg', `linear-gradient(135deg, rgb(${headerBgR}, ${headerBgG}, ${headerBgB}) 0%, rgb(${headerBg2R}, ${headerBg2G}, ${headerBg2B}) 100%)`);
        modalElement.style.setProperty('--slideshow-header-text', headerTextColor);
        modalElement.style.setProperty('--slideshow-button-border', `rgb(${buttonBorderR}, ${buttonBorderG}, ${buttonBorderB})`);
        modalElement.style.setProperty('--slideshow-button-text', buttonTextColor);
        modalElement.style.setProperty('--slideshow-button-hover-bg', `rgba(${buttonHoverBgR}, ${buttonHoverBgG}, ${buttonHoverBgB}, 0.2)`);
        modalElement.style.setProperty('--slideshow-border', borderColor);
        
        // Footer colors
        modalElement.style.setProperty('--slideshow-footer-bg', `rgb(${footerBgR}, ${footerBgG}, ${footerBgB})`);
        modalElement.style.setProperty('--slideshow-footer-border', `rgb(${footerBorderR}, ${footerBorderG}, ${footerBorderB})`);
        modalElement.style.setProperty('--slideshow-footer-button-bg', `rgba(${footerButtonBgR}, ${footerButtonBgG}, ${footerButtonBgB}, 0.3)`);
        modalElement.style.setProperty('--slideshow-footer-button-border', `rgba(${footerButtonBorderR}, ${footerButtonBorderG}, ${footerButtonBorderB}, 0.5)`);
        modalElement.style.setProperty('--slideshow-footer-button-text', footerButtonTextColor);
        modalElement.style.setProperty('--slideshow-footer-button-hover-bg', `rgba(${footerButtonHoverBgR}, ${footerButtonHoverBgG}, ${footerButtonHoverBgB}, 0.2)`);
      } else if (attempt < 5) {
        // Retry if modal not found yet
        setTimeout(() => applyColors(attempt + 1), 50 * (attempt + 1));
      }
    };
    
    applyColors();
  }
  
  // Reset slideshow colors to default
  private resetSlideshowColors(): void {
    let modalElement = document.querySelector('.modal.show .modal-content.slideshow-modal-wide') as HTMLElement;
    if (!modalElement) {
      modalElement = document.querySelector('.modal.show .modal-content') as HTMLElement;
    }
    if (!modalElement) {
      modalElement = document.querySelector('.slideshow-modal-wide .modal-content') as HTMLElement;
    }
    if (modalElement) {
      modalElement.style.removeProperty('--slideshow-header-bg');
      modalElement.style.removeProperty('--slideshow-header-text');
      modalElement.style.removeProperty('--slideshow-button-border');
      modalElement.style.removeProperty('--slideshow-button-text');
      modalElement.style.removeProperty('--slideshow-button-hover-bg');
      modalElement.style.removeProperty('--slideshow-border');
      modalElement.style.removeProperty('--slideshow-footer-bg');
      modalElement.style.removeProperty('--slideshow-footer-border');
      modalElement.style.removeProperty('--slideshow-footer-button-bg');
      modalElement.style.removeProperty('--slideshow-footer-button-border');
      modalElement.style.removeProperty('--slideshow-footer-button-text');
      modalElement.style.removeProperty('--slideshow-footer-button-hover-bg');
    }
  }
  
  // Helper function to center image on the saved point (container coordinates)
  private centerOnRecalculatedPoint(): void {
    if (!this.hasSavedPosition) {
      return;
    }
    
    // Try multiple ways to get the container
    let container = this.slideshowContainerRef?.nativeElement as HTMLElement;
    if (!container) {
      container = document.querySelector('.slideshow-image-wrapper') as HTMLElement;
    }
    if (!container) {
      const modalBody = document.querySelector('.slideshow-body');
      if (modalBody) {
        container = modalBody.querySelector('.slideshow-image-wrapper') as HTMLElement;
      }
    }
    
    if (!container) return;
    
    try {
      const rect = container.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      
      const containerCenterX = rect.width / 2;
      const containerCenterY = rect.height / 2;
      
      // Convert saved point (container coordinates) to relative to center
      const pointRelativeToCenterX = this.savedCursorX - containerCenterX;
      const pointRelativeToCenterY = this.savedCursorY - containerCenterY;
      
      // Find what image point corresponds to the saved container point
      const imagePointX = (pointRelativeToCenterX - this.slideshowTranslateX) / this.slideshowZoom;
      const imagePointY = (pointRelativeToCenterY - this.slideshowTranslateY) / this.slideshowZoom;
      
      // Center on that image point: translate = -imagePoint * zoom
      this.slideshowTranslateX = -imagePointX * this.slideshowZoom;
      this.slideshowTranslateY = -imagePointY * this.slideshowZoom;
      
      this.clampSlideshowTranslation();
    } catch (error) {
    }
  }
  
  // Helper function to zoom on a specific point (always centers on container center)
  // Always uses visible container dimensions (works in both windowed and fullscreen modes)
  private zoomOnPoint(newZoom: number, pointX: number, pointY: number, oldZoom: number): void {
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                     document.querySelector('.slideshow-image-wrapper') as HTMLElement;
    if (!container) return;
    
    // Use getBoundingClientRect() to get the actual visible dimensions of the container
    const rect = container.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    
    const containerCenterX = rect.width / 2;
    const containerCenterY = rect.height / 2;
    
    // For zooming on center: pointX and pointY should be container center
    // But we accept them as parameters for flexibility
    const zoomPointX = pointX;
    const zoomPointY = pointY;
    
    // Convert zoom point to relative to container center
    const pointRelativeToCenterX = zoomPointX - containerCenterX;
    const pointRelativeToCenterY = zoomPointY - containerCenterY;
    
    // Find the image point that corresponds to this container point at old zoom
    // With transform-origin center: containerPoint = center + translate + imagePoint * zoom
    // So: imagePoint = (containerPoint - center - translate) / zoom
    const imagePointX = (pointRelativeToCenterX - this.slideshowTranslateX) / oldZoom;
    const imagePointY = (pointRelativeToCenterY - this.slideshowTranslateY) / oldZoom;
    
    // After zoom, we want this image point to stay at the same container position
    // newTranslate = pointRelativeToCenter - imagePoint * newZoom
    this.slideshowTranslateX = pointRelativeToCenterX - imagePointX * newZoom;
    this.slideshowTranslateY = pointRelativeToCenterY - imagePointY * newZoom;
  }
  
  // Helper to zoom on container center (always centers on visible center)
  private zoomOnCenter(newZoom: number, oldZoom: number): void {
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                     document.querySelector('.slideshow-image-wrapper') as HTMLElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    
    const containerCenterX = rect.width / 2;
    const containerCenterY = rect.height / 2;
    
    this.zoomOnPoint(newZoom, containerCenterX, containerCenterY, oldZoom);
  }
  
  public zoomInSlideshow(): void { 
    const oldZoom = this.slideshowZoom;
    this.slideshowZoom = Math.min(100, parseFloat((this.slideshowZoom + 0.5).toFixed(2))); 
    
    // Always zoom on the center of the visible image
    this.zoomOnCenter(this.slideshowZoom, oldZoom);
    
    this.clampSlideshowTranslation();
    // Recalculate image dimensions after zoom change - use setTimeout to ensure DOM is updated
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 0);
  }
  
  public zoomOutSlideshow(): void { 
    const minZoom = this.getMinSlideshowZoom();
    const oldZoom = this.slideshowZoom;
    const newZoom = Math.max(minZoom, parseFloat((this.slideshowZoom - 0.5).toFixed(2))); 
    
    // Check if the new zoom is at or below minimum zoom (with small epsilon for floating point comparison)
    const epsilon = 0.01;
    const isAtMinZoom = newZoom <= minZoom + epsilon;
    
    if (isAtMinZoom) {
      // When at minimum zoom, use the same reset logic as pressing "R" key
      // This ensures zoom out matches the "R" key reset behavior
      this.resetSlideshowZoom();
    } else {
      this.slideshowZoom = newZoom;
      // Always zoom on the center of the visible image
      this.zoomOnCenter(this.slideshowZoom, oldZoom);
      // Only clamp translation when not at minimum zoom
      this.clampSlideshowTranslation();
      
      // Recalculate image dimensions after zoom change - use setTimeout to ensure DOM is updated
      setTimeout(() => {
        this.updateImageDimensions();
        this.updateContainerDimensions();
      }, 0);
    }
  }
  
  // Dézoom agressif pour le double-clic
  private zoomOutSlideshowAggressive(): void {
    const minZoom = this.getMinSlideshowZoom();
    const oldZoom = this.slideshowZoom;
    
    // Dézoomer de 3.5 lors du double-clic
    const newZoom = Math.max(minZoom, parseFloat((this.slideshowZoom - 3.5).toFixed(2)));
    
    // Check if the new zoom is at or below minimum zoom (with small epsilon for floating point comparison)
    const epsilon = 0.01;
    const isAtMinZoom = newZoom <= minZoom + epsilon;
    
    if (isAtMinZoom) {
      // When at minimum zoom, use the same reset logic as pressing "R" key
      // This ensures zoom out matches the "R" key reset behavior
      this.resetSlideshowZoom();
    } else {
      this.slideshowZoom = newZoom;
      // Always zoom on the center of the visible image
      this.zoomOnCenter(this.slideshowZoom, oldZoom);
      // Only clamp translation when not at minimum zoom
      this.clampSlideshowTranslation();
      
      // Recalculate image dimensions after zoom change - use setTimeout to ensure DOM is updated
      setTimeout(() => {
        this.updateImageDimensions();
        this.updateContainerDimensions();
      }, 0);
    }
  }
  
  // Drag handlers
  public onSlideshowMouseDown(event: MouseEvent): void {
    if (this.showMapView) {
      return;
    }
    // Clic droit : démarrer la sélection rectangulaire
    if (event.button === 2) {
      event.preventDefault(); // Empêcher le menu contextuel
      event.stopPropagation();
      // Utiliser le container pour avoir les coordonnées correctes
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                       document.querySelector('.slideshow-image-wrapper') as HTMLElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        // Calculer les coordonnées par rapport au container
        this.selectionStartX = event.clientX - rect.left;
        this.selectionStartY = event.clientY - rect.top;
        this.isSelectingRectangle = true;
        this.selectionRectX = this.selectionStartX;
        this.selectionRectY = this.selectionStartY;
        this.selectionRectWidth = 0;
        this.selectionRectHeight = 0;
        
        // Ajouter des listeners globaux pour capturer le mousemove et mouseup même si la souris sort du container
        this.setupSelectionListeners();
      }
      return;
    }
    
    // Clic gauche : drag normal
    const canDrag = this.slideshowZoom > this.getMinSlideshowZoom();
    this.isDraggingSlideshow = canDrag;
    this.hasDraggedSlideshow = false;
    // Empêcher la propagation si on peut drag pour éviter que le click interfère
    if (canDrag) { 
      try { 
        event.preventDefault(); 
        event.stopPropagation(); 
      } catch {} 
      // Setup global listeners pour que le drag fonctionne même si la souris sort de l'image/container
      this.setupDragListeners();
    }
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragOrigX = this.slideshowTranslateX;
    this.dragOrigY = this.slideshowTranslateY;
  }
  
  public onSlideshowMouseMove(event: MouseEvent): void {
    if (this.showMapView) {
      return;
    }
    
    // Store the event for throttled processing
    this.pendingMouseMove = event;
    
    // Throttle mousemove handler using requestAnimationFrame to improve performance
    if (this.mouseMoveRafId === null) {
      this.mouseMoveRafId = requestAnimationFrame(() => {
        this.mouseMoveRafId = null;
        const evt = this.pendingMouseMove;
        if (!evt) return;
        this.pendingMouseMove = null;
        this.processMouseMove(evt);
      });
    }
  }
  
  private processMouseMove(event: MouseEvent): void {
    // Always update cursor position relative to the container (not the image)
    if (event) {
      try {
        // Always use the container reference, not currentTarget (which might be the image)
        const container = this.slideshowContainerRef?.nativeElement;
        if (container) {
          const rect = container.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            this.cursorX = Math.max(0, Math.round(x));
            this.cursorY = Math.max(0, Math.round(y));
            // Update container dimensions (only update if changed to avoid unnecessary DOM reads)
            const newWidth = Math.round(rect.width);
            const newHeight = Math.round(rect.height);
            if (this.containerWidth !== newWidth || this.containerHeight !== newHeight) {
              this.containerWidth = newWidth;
              this.containerHeight = newHeight;
            }
            
            // Do NOT call updateImageDimensions() here - it's too expensive for mousemove
            // It should only be called when dimensions actually change (zoom, resize, etc.)
          } else {
            // Fallback: if rect is not valid, try direct calculation
            this.cursorX = Math.round(event.clientX);
            this.cursorY = Math.round(event.clientY);
          }
        } else {
          // If container not found, try to get it from the event target's parent
          const target = event.target as HTMLElement;
          if (target && target.parentElement) {
            const parentRect = target.parentElement.getBoundingClientRect();
            if (parentRect) {
              this.cursorX = Math.max(0, Math.round(event.clientX - parentRect.left));
              this.cursorY = Math.max(0, Math.round(event.clientY - parentRect.top));
              const newWidth = Math.round(parentRect.width);
              const newHeight = Math.round(parentRect.height);
              if (this.containerWidth !== newWidth || this.containerHeight !== newHeight) {
                this.containerWidth = newWidth;
                this.containerHeight = newHeight;
              }
            }
          }
        }
      } catch (error) {
      }
    }
    
    // Gérer le dessin du rectangle de sélection (clic droit)
    if (this.isSelectingRectangle) {
      event.preventDefault();
      event.stopPropagation();
      // Utiliser le même container que dans onSlideshowMouseDown
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                       document.querySelector('.slideshow-image-wrapper') as HTMLElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        const currentX = event.clientX - rect.left;
        const currentY = event.clientY - rect.top;
        
        // Calculer les coordonnées du rectangle (peut aller dans n'importe quelle direction)
        this.selectionRectX = Math.min(this.selectionStartX, currentX);
        this.selectionRectY = Math.min(this.selectionStartY, currentY);
        this.selectionRectWidth = Math.abs(currentX - this.selectionStartX);
        this.selectionRectHeight = Math.abs(currentY - this.selectionStartY);
        
        // Throttle change detection using requestAnimationFrame to avoid excessive calls
        if (this.selectionChangeDetectionRafId === null) {
          this.selectionChangeDetectionRafId = requestAnimationFrame(() => {
            this.selectionChangeDetectionRafId = null;
            this.cdr.detectChanges();
          });
        }
      }
      return;
    }
    
    if (!this.isDraggingSlideshow) return;
    try { event.preventDefault(); event.stopPropagation(); } catch {}
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    this.slideshowTranslateX = this.dragOrigX + dx;
    this.slideshowTranslateY = this.dragOrigY + dy;
    // Ne plus définir hasDraggedSlideshow ici - on le fera dans mouseup basé sur la distance totale
    this.clampSlideshowTranslation();
    
    // Throttle change detection using requestAnimationFrame to avoid ExpressionChangedAfterItHasBeenCheckedError
    if (this.dragChangeDetectionRafId === null) {
      this.dragChangeDetectionRafId = requestAnimationFrame(() => {
        this.dragChangeDetectionRafId = null;
        this.cdr.markForCheck();
      });
    }
    
    // Debounce visible portion calculation to avoid excessive calls during dragging
    if (this.visiblePortionUpdateTimer) {
      clearTimeout(this.visiblePortionUpdateTimer);
    }
    this.visiblePortionUpdateTimer = setTimeout(() => {
      this.visiblePortionUpdateTimer = null;
      this.calculateVisibleImagePortion();
    }, 16); // ~60fps, only recalculate every 16ms
  }
  
  public onSlideshowMouseEnter(event: MouseEvent): void {
    if (this.showMapView) {
      return;
    }
    // Update cursor position when mouse enters
    if (event) {
      this.onSlideshowMouseMove(event);
    }
  }
  
  // Setup global listeners for rectangle selection (so it works even if mouse leaves container)
  private setupSelectionListeners(): void {
    // Remove existing listeners if any
    this.removeSelectionListeners();
    
    this.selectionMouseMoveHandler = (event: MouseEvent) => {
      if (this.isSelectingRectangle) {
        this.onSlideshowMouseMove(event);
      }
    };
    
    this.selectionMouseUpHandler = (event: MouseEvent) => {
      if (this.isSelectingRectangle) {
        this.onSlideshowMouseUp(event);
        this.removeSelectionListeners();
      }
    };
    
    // Add listeners to document to capture events even if mouse leaves container
    document.addEventListener('mousemove', this.selectionMouseMoveHandler, true);
    document.addEventListener('mouseup', this.selectionMouseUpHandler, true);
  }
  
  // Remove global listeners for rectangle selection
  private removeSelectionListeners(): void {
    if (this.selectionMouseMoveHandler) {
      document.removeEventListener('mousemove', this.selectionMouseMoveHandler, true);
      this.selectionMouseMoveHandler = undefined;
    }
    if (this.selectionMouseUpHandler) {
      document.removeEventListener('mouseup', this.selectionMouseUpHandler, true);
      this.selectionMouseUpHandler = undefined;
    }
  }
  
  // Setup global listeners for drag (so it works even if mouse leaves container/image)
  private setupDragListeners(): void {
    // Remove existing listeners if any
    this.removeDragListeners();
    
    this.dragMouseMoveHandler = (event: MouseEvent) => {
      if (this.isDraggingSlideshow) {
        this.onSlideshowMouseMove(event);
      }
    };
    
    this.dragMouseUpHandler = (event: MouseEvent) => {
      if (this.isDraggingSlideshow) {
        this.onSlideshowMouseUp(event);
        this.removeDragListeners();
      }
    };
    
    // Add listeners to document to capture events even if mouse leaves container/image
    document.addEventListener('mousemove', this.dragMouseMoveHandler, true);
    document.addEventListener('mouseup', this.dragMouseUpHandler, true);
  }
  
  // Remove global listeners for drag
  private removeDragListeners(): void {
    if (this.dragMouseMoveHandler) {
      document.removeEventListener('mousemove', this.dragMouseMoveHandler, true);
      this.dragMouseMoveHandler = undefined;
    }
    if (this.dragMouseUpHandler) {
      document.removeEventListener('mouseup', this.dragMouseUpHandler, true);
      this.dragMouseUpHandler = undefined;
    }
  }
  
  public onSlideshowMouseUp(event?: MouseEvent): void {
    if (this.showMapView && !this.isSelectingRectangle) {
      return;
    }
    // Si on était en train de sélectionner un rectangle (clic droit)
    if (this.isSelectingRectangle) {
      // Toujours traiter le mouseup si on était en train de sélectionner
      // (peu importe le bouton, car on a commencé avec le bouton droit)
      this.isSelectingRectangle = false;
      this.removeSelectionListeners();
      
      // Vérifier que le rectangle a une taille minimale
      if (this.selectionRectWidth > 10 && this.selectionRectHeight > 10) {
        // Zoomer sur la zone sélectionnée
        this.zoomOnSelectionRect();
      }
      
      // Réinitialiser le rectangle
      this.selectionRectWidth = 0;
      this.selectionRectHeight = 0;
      return;
    }
    
    // Calculer la distance totale parcourue entre mousedown et mouseup
    if (event && this.isDraggingSlideshow) {
      this.mouseUpX = event.clientX;
      this.mouseUpY = event.clientY;
      const totalDx = this.mouseUpX - this.dragStartX;
      const totalDy = this.mouseUpY - this.dragStartY;
      const totalDistance = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
      
      // Considérer que c'est un drag seulement si la distance totale est > 10 pixels
      // Cela évite que de petits tremblements de la souris soient considérés comme un drag
      if (totalDistance > 10) {
        this.hasDraggedSlideshow = true;
      } else {
        this.hasDraggedSlideshow = false;
      }
    }
    
    // Clean up drag change detection throttling
    if (this.dragChangeDetectionRafId !== null) {
      cancelAnimationFrame(this.dragChangeDetectionRafId);
      this.dragChangeDetectionRafId = null;
    }
    
    // Remove global drag listeners
    this.removeDragListeners();
    this.isDraggingSlideshow = false;
  }
  
  public onSlideshowMouseLeave(): void {
    if (this.showMapView) {
      return;
    }
    // Ne pas annuler la sélection ou le drag si la souris sort du container
    // (les listeners globaux continueront de capturer les événements)
    // Keep cursor position visible when mouse leaves
  }
  
  // Zoomer sur la zone rectangulaire sélectionnée
  private zoomOnSelectionRect(): void {
    try {
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                       document.querySelector('.slideshow-image-wrapper') as HTMLElement;
      
      if (!container) {
        return;
      }
      
      const containerRect = container.getBoundingClientRect();
      const containerW = containerRect.width || 1;
      const containerH = containerRect.height || 1;
      
      // Vérifier que le rectangle a une taille valide
      if (this.selectionRectWidth <= 0 || this.selectionRectHeight <= 0) {
        return;
      }
      
      // Centre du rectangle de sélection dans le container (en coordonnées du container)
      const selectionCenterX = this.selectionRectX + this.selectionRectWidth / 2;
      const selectionCenterY = this.selectionRectY + this.selectionRectHeight / 2;
      
      // Calculer le zoom nécessaire pour que la zone sélectionnée remplisse le container
      // Le rectangle représente une portion du container, on veut zoomer pour qu'il remplisse tout le container
      const zoomRatioX = containerW / this.selectionRectWidth;
      const zoomRatioY = containerH / this.selectionRectHeight;
      // Prendre le ratio minimum pour garder les proportions
      const zoomMultiplier = Math.min(zoomRatioX, zoomRatioY);
      
      // Calculer le nouveau zoom en multipliant le zoom actuel
      const oldZoom = this.slideshowZoom;
      const newZoom = oldZoom * zoomMultiplier;
      
      // Limiter le zoom minimum et maximum
      const minZoom = this.getMinSlideshowZoom();
      const maxZoom = 100;
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
      
      // Utiliser zoomOnPoint pour zoomer sur le centre du rectangle de sélection
      // Cela va automatiquement ajuster le translate pour garder le point de zoom au même endroit
      this.zoomOnPoint(clampedZoom, selectionCenterX, selectionCenterY, oldZoom);
      
      // Appliquer le zoom
      this.slideshowZoom = clampedZoom;
      
      // Clamp translation pour s'assurer que l'image reste dans les limites
      this.clampSlideshowTranslation();
      
      // Force change detection
      this.cdr.detectChanges();
      
      // Update dimensions
      setTimeout(() => {
        this.updateImageDimensions();
        this.updateContainerDimensions();
      }, 0);
    } catch (error) {
    }
  }
  
  // Gestionnaire de click sur le container (fallback si le click sur l'image ne se déclenche pas)
  public onSlideshowContainerClick(event: MouseEvent): void {
    // Ne traiter que si le click n'est pas sur l'image elle-même
    const target = event.target as HTMLElement;
    if (target && target.tagName === 'IMG' && target.classList.contains('slideshow-image')) {
      // Le click sur l'image sera géré par onSlideshowImageClick
      return;
    }
    
    // Si le click est sur le container (pas sur l'image), traiter comme un click sur l'image
    // mais seulement si on n'était pas en train de drag
    if (!this.hasDraggedSlideshow && !this.showMapView) {
      this.onSlideshowImageClick(event);
    }
  }
  
  public onSlideshowImageClick(event: MouseEvent): void {
    // Empêcher la propagation pour éviter que le container ne traite aussi le click
    event.stopPropagation();
    
    // Ignore click if it was a drag
    if (this.hasDraggedSlideshow) { 
      this.hasDraggedSlideshow = false; 
      return; 
    }
    
    const currentTime = Date.now();
    const timeSinceLastClick = currentTime - this.lastClickTime;
    
    // Si c'est un double-clic (2 clics en moins de 300ms)
    if (timeSinceLastClick < 300 && timeSinceLastClick > 0 && this.pendingZoomClick) {
      // Annuler le timeout du simple clic s'il existe
      if (this.clickTimeout) {
        clearTimeout(this.clickTimeout);
        this.clickTimeout = undefined;
      }
      
      // Annuler le zoom précédent si il a été appliqué
      if (this.pendingZoomClick.zoomApplied) {
        this.undoLastZoom();
      }
      
      // Dézoomer
      this.zoomOutSlideshowAggressive();
      
      // Réinitialiser le temps du dernier clic et le zoom en attente
      this.lastClickTime = 0;
      this.pendingZoomClick = undefined;
    } else {
      // Premier clic ou clic après le délai
      this.lastClickTime = currentTime;
      
      // Annuler le timeout précédent s'il existe
      if (this.clickTimeout) {
        clearTimeout(this.clickTimeout);
      }
      
      // Sauvegarder les informations du clic pour pouvoir annuler le zoom si c'est un double-clic
      const oldZoom = this.slideshowZoom;
      const oldTranslateX = this.slideshowTranslateX;
      const oldTranslateY = this.slideshowTranslateY;
      
      // Zoomer immédiatement sur le point cliqué
      const zoomed = this.zoomOnClickPoint(event);
      
      // Sauvegarder l'état pour pouvoir annuler si c'est un double-clic
      this.pendingZoomClick = {
        event: event,
        zoomApplied: zoomed
      };
      
      // Si le zoom a été appliqué, sauvegarder l'état précédent pour pouvoir annuler
      if (zoomed) {
        // Stocker l'état précédent dans l'objet pour pouvoir annuler
        (this.pendingZoomClick as any).oldZoom = oldZoom;
        (this.pendingZoomClick as any).oldTranslateX = oldTranslateX;
        (this.pendingZoomClick as any).oldTranslateY = oldTranslateY;
      }
      
      // Attendre pour voir si c'est un double-clic
      this.clickTimeout = setTimeout(() => {
        // Si aucun deuxième clic n'est arrivé, le zoom reste appliqué
        this.clickTimeout = undefined;
        this.pendingZoomClick = undefined;
      }, 300);
    }
  }
  
  // Annuler le dernier zoom appliqué
  private undoLastZoom(): void {
    if (this.pendingZoomClick && (this.pendingZoomClick as any).oldZoom !== undefined) {
      this.slideshowZoom = (this.pendingZoomClick as any).oldZoom;
      this.slideshowTranslateX = (this.pendingZoomClick as any).oldTranslateX;
      this.slideshowTranslateY = (this.pendingZoomClick as any).oldTranslateY;
      
      // Recalculer les dimensions
      setTimeout(() => {
        this.updateImageDimensions();
      }, 0);
    }
  }
  
  // Zoom on the clicked point
  // Returns true if zoom was applied, false otherwise
  private zoomOnClickPoint(event: MouseEvent): boolean {
    // Ne zoomer que si on n'est pas déjà au zoom maximum ou minimum
    const minZoom = this.getMinSlideshowZoom();
    const maxZoom = 100;
    
    // Si on est déjà au zoom maximum, ne rien faire
    if (this.slideshowZoom >= maxZoom) {
      return false;
    }
    
    // Obtenir les coordonnées du clic par rapport au container
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement ||
                     document.querySelector('.slideshow-image-wrapper') as HTMLElement;
    if (!container) return false;
    
    const rect = container.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    
    // Calculer le nouveau zoom (augmenter de 0.5 ou jusqu'au maximum)
    const oldZoom = this.slideshowZoom;
    const newZoom = Math.min(maxZoom, parseFloat((this.slideshowZoom + 0.5).toFixed(2)));
    
    // Si le zoom n'a pas changé, ne rien faire
    if (newZoom === oldZoom) {
      return false;
    }
    
    // Zoomer sur le point cliqué
    this.slideshowZoom = newZoom;
    this.zoomOnPoint(newZoom, clickX, clickY, oldZoom);
    
    // Recalculer les dimensions après le changement de zoom
    setTimeout(() => {
      this.updateImageDimensions();
    }, 0);
    
    return true;
  }
  
  private clampSlideshowTranslation(): void {
    try {
      // If at minimum zoom, force translation to 0,0 and return early
      const minZoom = this.getMinSlideshowZoom();
      const epsilon = 0.01;
      const isAtMinZoom = Math.abs(this.slideshowZoom - minZoom) < epsilon || this.slideshowZoom <= minZoom;
      
      if (isAtMinZoom) {
        this.slideshowTranslateX = 0;
        this.slideshowTranslateY = 0;
        // Still update dimensions and visible portion for consistency
        this.updateImageDimensions();
        this.calculateVisibleImagePortion();
        return;
      }
      
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
      const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
      if (!container || !imgEl) return;
      
      // Use getBoundingClientRect() to get the actual visible dimensions of the container
      // This ensures we always use the visible window dimensions, not fullscreen dimensions
      const containerRect = container.getBoundingClientRect();
      const cw = containerRect.width || container.clientWidth || 1;
      const ch = containerRect.height || container.clientHeight || 1;
      
      // Get the image's base display size (before zoom transform)
      // This represents what's visible in the container viewport
      const imgBaseWidth = imgEl.clientWidth || 1;
      const imgBaseHeight = imgEl.clientHeight || 1;
      
      // Calculate zoomed size based on visible area in container
      const iw = imgBaseWidth * this.slideshowZoom;
      const ih = imgBaseHeight * this.slideshowZoom;
      const maxX = Math.max(0, (iw - cw) / 2);
      const maxY = Math.max(0, (ih - ch) / 2);
      if (this.slideshowTranslateX > maxX) this.slideshowTranslateX = maxX;
      if (this.slideshowTranslateX < -maxX) this.slideshowTranslateX = -maxX;
      if (this.slideshowTranslateY > maxY) this.slideshowTranslateY = maxY;
      if (this.slideshowTranslateY < -maxY) this.slideshowTranslateY = -maxY;
      
      // Update image dimensions display
      this.updateImageDimensions();
    } catch (error) {
      // Try to update dimensions even on error
      this.updateImageDimensions();
    }
    
    // Always recalculate visible portion when translation changes
    this.calculateVisibleImagePortion();
  }
  
  // Touch handlers
  private getTouchDistance(touch1: Touch, touch2: Touch): number {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  private getTouchCenter(touch1: Touch, touch2: Touch): { x: number; y: number } {
    // Use clientX/clientY (viewport coordinates) for consistency
    // getBoundingClientRect() also uses viewport coordinates, so this ensures consistency
    // This is the most reliable approach for modal-based UI where scroll is typically disabled
    return {
      x: (touch1.clientX + touch2.clientX) / 2,
      y: (touch1.clientY + touch2.clientY) / 2
    };
  }
  
  public onSlideshowTouchStart(event: TouchEvent | Event): void {
    if (this.showMapView) {
      return;
    }
    const touchEvent = event as TouchEvent;
    if (!touchEvent || typeof touchEvent.touches === 'undefined') {
      return;
    }
    if (touchEvent.touches.length === 1) {
      const touch = touchEvent.touches[0];
      const canDrag = this.slideshowZoom > this.getMinSlideshowZoom();
      this.isDraggingSlideshow = canDrag;
      this.hasDraggedSlideshow = false;
      if (canDrag) {
        try { touchEvent.preventDefault(); touchEvent.stopPropagation(); } catch {}
      }
      this.touchStartX = touch.clientX;
      this.touchStartY = touch.clientY;
      this.dragStartX = touch.clientX;
      this.dragStartY = touch.clientY;
      this.dragOrigX = this.slideshowTranslateX;
      this.dragOrigY = this.slideshowTranslateY;
      this.isPinching = false;
    } else if (touchEvent.touches.length === 2) {
      // Initialiser le pinch zoom
      this.isPinching = true;
      this.isDraggingSlideshow = false;
      try { touchEvent.preventDefault(); touchEvent.stopPropagation(); } catch {}
      
      const touch1 = touchEvent.touches[0];
      const touch2 = touchEvent.touches[1];
      
      // Sauvegarder la distance initiale et le zoom de départ
      this.touchStartDistance = this.getTouchDistance(touch1, touch2);
      this.touchStartZoom = this.slideshowZoom;
      this.initialTouches = [touch1, touch2];
    }
  }
  
  public onSlideshowTouchMove(event: TouchEvent | Event): void {
    if (this.showMapView) {
      return;
    }
    const touchEvent = event as TouchEvent;
    if (!touchEvent || typeof touchEvent.touches === 'undefined') {
      return;
    }
    
    if (touchEvent.touches.length === 1 && !this.isPinching) {
      if (!this.isDraggingSlideshow) return;
      const touch = touchEvent.touches[0];
      try { touchEvent.preventDefault(); touchEvent.stopPropagation(); } catch {}
      const dx = touch.clientX - this.dragStartX;
      const dy = touch.clientY - this.dragStartY;
      
      // Calculer les nouvelles valeurs
      const newTranslateX = this.dragOrigX + dx;
      const newTranslateY = this.dragOrigY + dy;
      
      // Mettre à jour les valeurs
      this.slideshowTranslateX = newTranslateX;
      this.slideshowTranslateY = newTranslateY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) this.hasDraggedSlideshow = true;
      this.clampSlideshowTranslation();
      
      // Mettre à jour directement le DOM pour une fluidité maximale
      // Cela évite le cycle de détection de changement d'Angular
      const imgElement = this.slideshowImgElRef?.nativeElement;
      if (imgElement) {
        const transform = `translate3d(${this.slideshowTranslateX}px, ${this.slideshowTranslateY}px, 0) scale(${this.slideshowZoom})`;
        imgElement.style.transform = transform;
      }
    } else if (touchEvent.touches.length === 2) {
      // Zoom pinch avec deux doigts
      this.isDraggingSlideshow = false;
      try { touchEvent.preventDefault(); touchEvent.stopPropagation(); } catch {}
      
      const touch1 = touchEvent.touches[0];
      const touch2 = touchEvent.touches[1];
      const currentDistance = this.getTouchDistance(touch1, touch2);
      
      // Si c'est le début du pinch, initialiser
      if (this.touchStartDistance === 0) {
        this.touchStartDistance = currentDistance;
        this.touchStartZoom = this.slideshowZoom;
      }
      
      // Calculer le nouveau zoom basé sur le ratio de distance
      if (this.touchStartDistance > 0 && currentDistance > 0) {
        const zoomRatio = currentDistance / this.touchStartDistance;
        let newZoom = this.touchStartZoom * zoomRatio;
        
        const minZoom = this.getMinSlideshowZoom();
        const maxZoom = 100;
        newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
        
        // Zoomer sur le centre de l'image visible (comme sur PC)
        const oldZoom = this.slideshowZoom;
        this.slideshowZoom = newZoom;
        
        if (this.slideshowZoom <= minZoom) {
          // Reset to center if at minimum zoom
          this.slideshowTranslateX = 0;
          this.slideshowTranslateY = 0;
        } else {
          // Zoom on center (comme onWheelSlideshow)
          this.zoomOnCenter(this.slideshowZoom, oldZoom);
        }
        
        // Clamp translation to ensure image stays within bounds
        this.clampSlideshowTranslation();
        
        // Update display
        this.ngZone.run(() => {
          this.cdr.detectChanges();
        });
      }
      this.lastTouchDistance = currentDistance;
    }
  }
  
  public onSlideshowTouchEnd(event: TouchEvent | Event): void {
    if (this.showMapView) {
      return;
    }
    const touchEvent = event as TouchEvent;
    if (!touchEvent || typeof touchEvent.touches === 'undefined') {
      return;
    }
    if (touchEvent.touches.length === 0) {
      // Cacher les coordonnées
      this.ngZone.run(() => {
        this.showTouchCoordinates = false;
        this.touch1X = 0;
        this.touch1Y = 0;
        this.touch2X = 0;
        this.touch2Y = 0;
        this.cdr.detectChanges();
      });
      
      this.isDraggingSlideshow = false;
      this.isPinching = false;
      this.initialTouches = [];
      this.touchStartDistance = 0;
      this.lastTouchDistance = 0;
      this.pinchStartTranslateX = 0;
      this.pinchStartTranslateY = 0;
    } else if (touchEvent.touches.length === 1) {
      // Un doigt reste
      
      this.isPinching = false;
      const touch = touchEvent.touches[0];
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
  
  // Keyboard listener
  private setupKeyboardListener(): void {
    // Remove any existing listener first
    this.removeKeyboardListener();
    
    this.keyboardListener = (event: KeyboardEvent) => {
      // Vérifier d'abord si on est en plein écran et que Escape est pressé
      // Il faut le faire AVANT toutes les autres vérifications pour empêcher la propagation
      const isFullscreenActive = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
        (document as any).mozFullScreenElement || (document as any).msFullscreenElement);
      
      // R ou Home : réinitialiser le zoom (fonctionne en mode fenêtre ET en plein écran)
      if (event.key === 'r' || event.key === 'R' || event.keyCode === 82 || event.key === 'Home' || event.keyCode === 36) {
        // R ou Home : réinitialiser le zoom
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.resetSlideshowZoom();
        return;
      }
      
      if ((event.key === 'Escape' || event.keyCode === 27) && isFullscreenActive) {
        // En plein écran : Escape sort du plein écran
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.toggleFullscreen();
        return;
      }
      
      // Only handle if our modal is open
      if (!this.isSlideshowModalOpen || !this.modalRef) {
        return;
      }
      
      // Check if target is an input or textarea to avoid interfering with form inputs
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      
      // Check if our specific modal is open by checking for slideshow-header class
      const modalElement = document.querySelector('.modal.show');
      
      // Verify this is our slideshow modal by checking for slideshow-header class
      const isOurModal = modalElement && modalElement.querySelector('.slideshow-header') !== null;
      
      // Allow if our modal is open OR if we're in fullscreen
      if (!isOurModal && !isFullscreenActive) {
        return;
      }
      
      // In fullscreen, we still want to handle the keys
      if (modalElement && !modalElement.contains(target) && !isFullscreenActive && !isOurModal) {
        return;
      }
      
      const currentTime = Date.now();
      // Calculate currentKeyCode properly for all keys (not just arrows)
      let currentKeyCode = event.keyCode || 0;
      if (!currentKeyCode && event.key) {
        // Fallback: map event.key to keyCode if keyCode is not available
        const keyMap: { [key: string]: number } = {
          'ArrowLeft': 37, 'ArrowRight': 39, 'ArrowUp': 38, 'ArrowDown': 40,
          's': 83, 'S': 83, 'i': 73, 'I': 73, 'd': 68, 'D': 68,
          'p': 80, 'P': 80, 'g': 71, 'G': 71, 'h': 72, 'H': 72,
          'e': 69, 'E': 69, 'o': 79, 'O': 79, 'r': 82, 'R': 82,
          'f': 70, 'F': 70, 'c': 67, 'C': 67, 'Escape': 27, 'Home': 36
        };
        currentKeyCode = keyMap[event.key] || 0;
      }
      
      // Handle 'E' key first (before debounce) for maximum reactivity like button click
      if (event.key === 'e' || event.key === 'E' || event.keyCode === 69) {
        if (this.traceViewerOpen) {
          return;
        }
        if (!this.currentImageLocation) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 69;
        // Execute in Angular zone for immediate change detection, matching button click behavior
        this.ngZone.run(() => {
          this.handleLocationAction();
          // Force immediate change detection for instant UI update
          this.cdr.detectChanges();
        });
        return; // Exit early for maximum reactivity
      }
      
      // Debounce: ignore if same key pressed within 50ms (to prevent double triggering)
      // Reduced from 100ms to allow faster navigation
      // Note: 'E' key is handled above before debounce for maximum reactivity
      if (currentKeyCode && currentKeyCode === this.lastKeyCode && currentTime - this.lastKeyPressTime < 50) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      
      // Handle arrow keys for navigation
      if (event.key === 'ArrowLeft' || event.keyCode === 37) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 37;
        this.previousImage();
        return; // Exit early after handling
      } else if (event.key === 'ArrowRight' || event.keyCode === 39) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 39;
        this.nextImage();
        return; // Exit early after handling
      } else if (event.key === 's' || event.key === 'S' || event.keyCode === 83) {
        // S : démarrer/arrêter le slideshow
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 83;
        this.toggleSlideshowWithMessage();
      } else if (event.key === 'i' || event.key === 'I' || event.keyCode === 73) {
        // I : afficher/masquer le panneau d'informations
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 73;
        this.toggleInfoPanel();
      } else if (event.key === 'd' || event.key === 'D' || event.keyCode === 68) {
        // D : activer/désactiver le mode debug
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 68;
        this.toggleDebug();
        return;
      } else if (event.key === 'p' || event.key === 'P' || event.keyCode === 80) {
        // P : partager l'image
        if (this.slideshowImages.length === 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 80;
        this.shareImage();
      } else if (event.key === 'g' || event.key === 'G' || event.keyCode === 71) {
        // G : afficher/masquer la grille
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 71;
        this.toggleGrid();
      } else if (event.key === 'h' || event.key === 'H' || event.keyCode === 72) {
        // H : afficher/masquer les thumbnails
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 72;
        this.toggleThumbnails();
        return; // Exit early after handling
      } else if (event.key === 'o' || event.key === 'O' || event.keyCode === 79) {
        if (!this.shouldShowFilesystemToggleButton() || this.isFilesystemToggleDisabled()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 79;
        this.toggleFilesystemImageQuality();
      } else if (event.key === 'f' || event.key === 'F' || event.keyCode === 70) {
        // F : activer/désactiver le plein écran
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 70;
        this.toggleFullscreen();
      } else if (event.key === 'c' || event.key === 'C' || event.keyCode === 67) {
        // C : fermer le slideshow
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 67;
        this.onSlideshowClose();
      } else if (event.key === 'Escape' || event.keyCode === 27) {
        if (this.traceViewerOpen) {
          return;
        }
        // En mode fenêtre : Escape réinitialise le zoom
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.resetSlideshowZoom();
      } else if (event.key === 'r' || event.key === 'R' || event.keyCode === 82 || event.key === 'Home' || event.keyCode === 36) {
        // R ou Home : réinitialiser le zoom (fonctionne aussi en mode fenêtre)
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.resetSlideshowZoom();
        return; // Exit early after handling
      }
    };
    
    // Use capture phase with keydown only (to avoid double triggering)
    // Capture phase avec highest priority to intercept Escape before browser default behavior
    window.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
    document.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
    // Also listen on document.body with highest priority
    if (document.body) {
      document.body.addEventListener('keydown', this.keyboardListener, { capture: true, passive: false });
    }
  }
  
  private removeKeyboardListener(): void {
    if (this.keyboardListener) {
      window.removeEventListener('keydown', this.keyboardListener, { capture: true });
      document.removeEventListener('keydown', this.keyboardListener, { capture: true });
      if (document.body) {
        document.body.removeEventListener('keydown', this.keyboardListener, { capture: true });
      }
      this.keyboardListener = undefined;
    }
  }
  
  // Navigation
  public nextImage(): void {
    if (this.slideshowImages.length === 0) return;
    const currentZoom = this.slideshowZoom;
    const currentTranslateX = this.slideshowTranslateX;
    const currentTranslateY = this.slideshowTranslateY;
    this.currentSlideshowIndex = (this.currentSlideshowIndex + 1) % this.slideshowImages.length;
    this.updateCurrentSlideshowImageUrl();
    this.updateCurrentImageLocation();
    // Reset saved position when changing image
    this.hasSavedPosition = false;
    // Scroll to center active thumbnail (with delay to ensure DOM update)
    setTimeout(() => {
      this.scrollToActiveThumbnail();
    }, 50);
    setTimeout(() => {
      // Si le slideshow est en lecture automatique, conserver le zoom
      if (this.isSlideshowActive) {
        this.slideshowZoom = currentZoom;
        this.slideshowTranslateX = currentTranslateX;
        this.slideshowTranslateY = currentTranslateY;
        this.clampSlideshowTranslation();
      } else {
        // Sinon, réinitialiser le zoom lors de la navigation manuelle
        this.resetSlideshowZoom();
        this.updateImageDimensions();
      }
        // Wait for image to load after src change - try multiple times
        setTimeout(() => {
          this.updateImageDimensions();
          // Try again after a longer delay in case image is still loading
          setTimeout(() => {
            this.updateImageDimensions();
          }, 200);
        }, 100);
        
        // If info panel is visible, reload EXIF data for new image
        if (this.showInfoPanel) {
          setTimeout(() => {
            this.loadExifDataForInfoPanel();
          }, 100);
        }
      }, 0);
    }
  
    public previousImage(): void {
    if (this.slideshowImages.length === 0) return;
    const currentZoom = this.slideshowZoom;
    const currentTranslateX = this.slideshowTranslateX;
    const currentTranslateY = this.slideshowTranslateY;
    this.currentSlideshowIndex = (this.currentSlideshowIndex - 1 + this.slideshowImages.length) % this.slideshowImages.length;
    this.updateCurrentSlideshowImageUrl();
    this.updateCurrentImageLocation();
    // Reset saved position when changing image
    this.hasSavedPosition = false;
    // Scroll to center active thumbnail (with delay to ensure DOM update)
    setTimeout(() => {
      this.scrollToActiveThumbnail();
    }, 50);
    setTimeout(() => {
      // Si le slideshow est en lecture automatique, conserver le zoom
      if (this.isSlideshowActive) {
        this.slideshowZoom = currentZoom;
        this.slideshowTranslateX = currentTranslateX;
        this.slideshowTranslateY = currentTranslateY;
        this.clampSlideshowTranslation();
      } else {
        // Sinon, réinitialiser le zoom lors de la navigation manuelle
        this.resetSlideshowZoom();
        this.updateImageDimensions();
      }
      // Wait for image to load after src change - try multiple times
      setTimeout(() => {
        this.updateImageDimensions();
        // Try again after a longer delay in case image is still loading
        setTimeout(() => {
          this.updateImageDimensions();
        }, 200);
      }, 100);
      
      // If info panel is visible, reload EXIF data for new image
      if (this.showInfoPanel) {
        setTimeout(() => {
          this.loadExifDataForInfoPanel();
        }, 100);
      }
    }, 0);
  }
  
  public getCurrentSlideshowImage(): string {
    if (this.slideshowImages.length === 0 || this.currentSlideshowIndex >= this.slideshowImages.length) {
      this.currentSlideshowImageUrl = '';
      return '';
    }
    const url = this.slideshowImages[this.currentSlideshowIndex];
    // Update cached URL when accessed
    if (this.currentSlideshowImageUrl !== url) {
      this.currentSlideshowImageUrl = url;
    }
    return url;
  }
  
  // Update cached current image URL - call this whenever currentSlideshowIndex changes
  private updateCurrentSlideshowImageUrl(): void {
    if (this.slideshowImages.length === 0 || this.currentSlideshowIndex >= this.slideshowImages.length) {
      this.currentSlideshowImageUrl = '';
    } else {
      this.currentSlideshowImageUrl = this.slideshowImages[this.currentSlideshowIndex] || '';
    }
    // Update blurred background image when URL changes
    this.updateBackgroundImageStyle();
  }

  // Check if current image is loading (for fileId-based images)
  public isCurrentImageLoading(): boolean {
    if (this.slideshowImages.length === 0 || this.currentSlideshowIndex >= this.slideshowImages.length) {
      return false;
    }
    
    const currentImageUrl = this.getCurrentSlideshowImage();
    // If current image URL is empty, it's loading
    if (!currentImageUrl || currentImageUrl.trim() === '') {
      return true;
    }
    
    // Check if the current image is in the loading set
    if (this.images && this.images.length > this.currentSlideshowIndex) {
      const currentImageSource = this.images[this.currentSlideshowIndex];
      if (currentImageSource) {
        const cacheKey = this.getImageCacheKey(currentImageSource);
        if (cacheKey && this.loadingImageKeys.has(cacheKey)) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  public getCurrentImageFileName(): string {
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (!currentImageUrl) {
      return '';
    }
    return this.imageFileNames.get(currentImageUrl) || '';
  }

  public shouldShowFilesystemToggleButton(): boolean {
    const imageIndex = this.slideshowIndexToImageIndex.get(this.currentSlideshowIndex);
    if (imageIndex === undefined) {
      return false;
    }
    const imageSource = this.images[imageIndex];
    return !!(imageSource && imageSource.relativePath && imageSource.fileName);
  }

  public isCurrentFilesystemVariantLoading(): boolean {
    const imageIndex = this.slideshowIndexToImageIndex.get(this.currentSlideshowIndex);
    if (imageIndex === undefined) {
      return false;
    }
    return this.filesystemVariantLoading.has(imageIndex);
  }

  public isFilesystemToggleDisabled(): boolean {
    const imageIndex = this.slideshowIndexToImageIndex.get(this.currentSlideshowIndex);
    if (imageIndex === undefined) {
      return false;
    }
    const imageSource = this.images[imageIndex];
    if (!imageSource || !imageSource.relativePath || !imageSource.fileName) {
      return true;
    }
    return this.filesystemVariantLoading.has(imageIndex);
  }

  public getFilesystemToggleLabelKey(): string {
    const imageIndex = this.slideshowIndexToImageIndex.get(this.currentSlideshowIndex);
    if (imageIndex === undefined) {
      return 'EVENTELEM.ORIGINAL_PHOTO';
    }
    const variants = this.filesystemImageVariants.get(imageIndex);
    const isCurrentlyOriginal = variants
      ? variants.currentVariant === 'original'
      : this.images[imageIndex]?.compressFs === false;
    return isCurrentlyOriginal ? 'EVENTELEM.COMPRESSED_PHOTO' : 'EVENTELEM.ORIGINAL_PHOTO';
  }

  public toggleFilesystemImageQuality(): void {
    const imageIndex = this.slideshowIndexToImageIndex.get(this.currentSlideshowIndex);
    if (imageIndex === undefined) {
      return;
    }

    const imageSource = this.images[imageIndex];
    if (!imageSource || !imageSource.relativePath || !imageSource.fileName) {
      return;
    }

    let variants = this.filesystemImageVariants.get(imageIndex);
    if (!variants) {
      const initialVariant: 'compressed' | 'original' = imageSource.compressFs === false ? 'original' : 'compressed';
      variants = { currentVariant: initialVariant };
      this.filesystemImageVariants.set(imageIndex, variants);
    }

    const currentVariant = variants.currentVariant ?? (imageSource.compressFs === false ? 'original' : 'compressed');
    const targetVariant: 'compressed' | 'original' = currentVariant === 'original' ? 'compressed' : 'original';

    if (this.filesystemVariantLoading.has(imageIndex)) {
      return;
    }

    const previousZoom = this.slideshowZoom;
    const previousTranslateX = this.slideshowTranslateX;
    const previousTranslateY = this.slideshowTranslateY;

    if (targetVariant === 'original' && variants.originalUrl) {
      this.applyFilesystemVariant(
        variants.originalUrl,
        this.slideshowBlobs.get(variants.originalUrl) || null,
        imageIndex,
        imageSource,
        previousZoom,
        previousTranslateX,
        previousTranslateY,
        variants.originalMetadata,
        targetVariant
      );
      return;
    }

    if (targetVariant === 'compressed' && variants.compressedUrl) {
      this.applyFilesystemVariant(
        variants.compressedUrl,
        this.slideshowBlobs.get(variants.compressedUrl) || null,
        imageIndex,
        imageSource,
        previousZoom,
        previousTranslateX,
        previousTranslateY,
        variants.compressedMetadata,
        targetVariant
      );
      return;
    }

    const compressFlag = targetVariant === 'compressed';
    this.filesystemVariantLoading.add(imageIndex);
    this.cdr.detectChanges();

    const request$ = this.fileService.getImageFromDiskWithMetadata(
      imageSource.relativePath,
      imageSource.fileName,
      compressFlag
    ).pipe(
      takeUntil(this.cancelImageLoadsSubject),
      map((res) => {
        const mimeType = this.detectImageMimeTypeFromFileName(imageSource.fileName || 'image.jpg');
        const blob = new Blob([res.buffer], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        this.slideshowBlobs.set(objectUrl, blob);
        const metadata = res.metadata ?? this.parsePatMetadataFromHeaders(res.headers);
        const cacheKey = this.getFilesystemCacheKey(imageSource.relativePath!, imageSource.fileName!, compressFlag);
        if (cacheKey) {
          this.imageCache.set(cacheKey, { objectUrl, blob, metadata });
          this.loadingImageKeys.delete(cacheKey);
        }
        return { objectUrl, blob, metadata };
      }),
      finalize(() => {
        // Don't clear loading flag here - wait for image to actually render
        // The loading flag will be cleared in continueApplyFilesystemVariant after image renders
      })
    );

    const subscription = request$.subscribe({
      next: ({ objectUrl, blob, metadata }) => {
        if (targetVariant === 'original') {
          variants!.originalUrl = objectUrl;
          if (metadata) {
            variants!.originalMetadata = metadata;
          }
        } else {
          variants!.compressedUrl = objectUrl;
          if (metadata) {
            variants!.compressedMetadata = metadata;
          }
        }
        this.applyFilesystemVariant(
          objectUrl,
          blob,
          imageIndex,
          imageSource,
          previousZoom,
          previousTranslateX,
          previousTranslateY,
          metadata,
          targetVariant
        );
      },
      error: (error) => {
      }
    });

    this.imageLoadingSubs.push(subscription);
  }
  
  // Slideshow controls
  public startSlideshow(): void {
    if (this.slideshowImages.length <= 1) return;
    
    this.stopSlideshow();
    
    this.slideshowInterval = setInterval(() => {
      this.nextImage();
    }, 3000);
    this.isSlideshowActive = true;
  }
  
  public stopSlideshow(): void {
    if (this.slideshowInterval) {
      clearInterval(this.slideshowInterval);
      this.slideshowInterval = null;
    }
    this.isSlideshowActive = false;
  }
  
  public toggleSlideshow(): void {
    if (this.isSlideshowActive) {
      this.stopSlideshow();
    } else {
      this.startSlideshow();
    }
  }
  
  public toggleSlideshowWithMessage(): void {
    const wasActive = this.isSlideshowActive;
    this.toggleSlideshow();
    
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
  
  // Fullscreen
  public toggleFullscreen(): void {
    // Check current fullscreen state directly from document (more reliable than this.isFullscreen)
    const isCurrentlyFullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement || (document as any).msFullscreenElement);

    // Use the component's container (parent of #slideshowContainer = .slideshow-image-wrapper).
    // requestFullscreen on the .slideshow-container so the whole slide area goes truly fullscreen;
    // querySelector can return a wrong instance if multiple modals exist in DOM.
    const wrapper = this.slideshowContainerRef?.nativeElement as HTMLElement;
    const container = wrapper?.parentElement as HTMLElement; // .slideshow-container
    const elementToFullscreen = container || wrapper;
    if (!elementToFullscreen) return;

    if (!isCurrentlyFullscreen) {
      // Enter fullscreen: request on the container so the slide area fills the whole screen
      const el = elementToFullscreen as any;
      if (el.requestFullscreen) {
        el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else if (el.mozRequestFullScreen) {
        el.mozRequestFullScreen();
      } else if (el.msRequestFullscreen) {
        el.msRequestFullscreen();
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
  
  // Close handler
  public onSlideshowClose(cRef?: any): void {
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    } catch {}
    
    // Remove fullscreen class from body
    document.body.classList.remove('slideshow-fullscreen-active');
    
    // Close modal - this will trigger modalRef.result handlers which will cleanup memory
    if (this.modalRef) {
      this.modalRef.close();
    }
    try { if (typeof cRef === 'function') { cRef('Close click'); } } catch {}
    // Don't use dismissAll() as it closes all modals including parent modals (like files modal)
    // The modalRef.close() above is sufficient to close only this slideshow modal
    
    // Note: cleanupAllMemory() will be called automatically by modalRef.result handlers
    // No need to call it here to avoid double cleanup
    
    // Unblock scroll immediately (removes Bootstrap blocking)
    this.unblockPageScroll();
    
    // Unlock scroll position will be called by modalRef.result handlers after modal is fully closed
    // Don't call it here to avoid race conditions
  }
  
  // FS Downloads cleanup
  private cancelFsDownloads(): void {
    this.fsDownloadsActive = false;
    try { this.fsActiveSubs.forEach(s => { if (s && !s.closed) { s.unsubscribe(); } }); } catch {}
    this.fsActiveSubs = [];
    this.fsQueue = [];
  }
  
  // Toggle info panel visibility
  public toggleInfoPanel(): void {
    this.showInfoPanel = !this.showInfoPanel;
    
    // Force immediate change detection for instant response
    this.cdr.detectChanges();
    
    // If showing the panel, load EXIF data if not already cached
    if (this.showInfoPanel) {
      this.loadExifDataForInfoPanel();
    }
  }
  
  // Check if device is mobile
  public isMobileDevice(): boolean {
    if (typeof window === 'undefined') return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (window.innerWidth <= 768);
  }
  
  public toggleDebug(): void {
    this.showDebug = !this.showDebug;
    if (this.showDebug) {
      // Force update of dimensions when debug is enabled
      this.updateContainerDimensions();
      this.updateImageDimensions();
    }
  }
  
  // Debug helper functions
  public getImageCenterX(): number {
    // With transform-origin center, the center of the container is (0,0) in transform coordinates
    // The point of the image that is at the center of the visible area
    // Formula: imagePoint = (containerCenter - translate) / zoom
    // But since containerCenter = 0 in transform coordinates, it's: imagePoint = -translate / zoom
    // This gives us the image point in image coordinates (relative to image center)
    // To get it in container coordinates, we need to account for the image's display size
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
    const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
    if (!container || !imgEl) return 0;
    
    const rect = container.getBoundingClientRect();
    const containerCenterX = rect.width / 2;
    
    // The image point at center in image coordinates (relative to image center)
    const imagePointX = -this.slideshowTranslateX / this.slideshowZoom;
    
    // Convert to container coordinates: containerCenter + imagePoint * zoom
    return containerCenterX + imagePointX * this.slideshowZoom;
  }
  
  public getImageCenterY(): number {
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
    const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
    if (!container || !imgEl) return 0;
    
    const rect = container.getBoundingClientRect();
    const containerCenterY = rect.height / 2;
    
    // The image point at center in image coordinates (relative to image center)
    const imagePointY = -this.slideshowTranslateY / this.slideshowZoom;
    
    // Convert to container coordinates: containerCenter + imagePoint * zoom
    return containerCenterY + imagePointY * this.slideshowZoom;
  }
  
  public getContainerCenterX(): number {
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    return rect.width / 2;
  }
  
  public getContainerCenterY(): number {
    const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
    if (!container) return 0;
    const rect = container.getBoundingClientRect();
    return rect.height / 2;
  }
  
  // Get the image point (in image coordinates) that is currently at the center of the visible area
  public getVisibleImageCenterPointX(): number {
    // With transform-origin center: imagePoint = -translate / zoom
    // This gives the image point relative to the image center
    return -this.slideshowTranslateX / this.slideshowZoom;
  }
  
  public getVisibleImageCenterPointY(): number {
    return -this.slideshowTranslateY / this.slideshowZoom;
  }
  
  public getLocationButtonLabel(): string {
    if (this.locationViewMode === 'trace') {
      return this.translateService.instant('EVENTELEM.OPEN_TRACE_VIEWER');
    }
    // If map is showing, show "Photo" to switch back to photo view
    // If photo is showing, show "Google Maps" to switch to map view
    if (this.showMapView) {
      return this.translateService.instant('EVENTELEM.SEE_PHOTO');
    }
    return this.translateService.instant('EVENTELEM.LOCATION_VIEW_GOOGLE');
  }


  public getLocationButtonIconClass(): string {
    if (this.locationViewMode === 'trace') {
      return 'fa-map-signs';
    }
    return this.showMapView ? 'fa-picture-o' : 'fa-map-marker';
  }

  public setLocationViewMode(mode: 'google' | 'trace'): void {
    if (this.locationViewMode === mode) {
      return;
    }
    this.locationViewMode = mode;
    if (mode === 'trace' && this.showMapView) {
      this.showMapView = false;
      setTimeout(() => {
        this.updateImageDimensions();
        this.updateContainerDimensions();
      }, 0);
    }
  }

  public toggleLocationViewMode(): void {
    // Toggle between google and trace
    const newMode = this.locationViewMode === 'google' ? 'trace' : 'google';
    this.setLocationViewMode(newMode);
  }


  public handleLocationAction(event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
    if (!this.currentImageLocation) {
      return;
    }
    if (this.locationViewMode === 'trace') {
      this.emitTraceViewerLocation();
      return;
    }
    this.toggleMapView();
  }

  private emitTraceViewerLocation(): void {
    if (!this.currentImageLocation) {
      return;
    }
    const fileName = this.getCurrentImageFileName();
    const label = fileName && fileName.trim().length > 0
      ? fileName
      : this.translateService.instant('EVENTELEM.SEE_LOCATION');
    this.openLocationInTrace.emit({
      lat: this.currentImageLocation.lat,
      lng: this.currentImageLocation.lng,
      label,
      eventColor: this.eventColor || undefined
    });
  }

  public toggleMapView(): void {
    if (!this.currentImageLocation) {
      this.showMapView = false;
      this.cdr.detectChanges();
      return;
    }
    
    this.showMapView = !this.showMapView;
    
    if (this.showMapView) {
      this.isSelectingRectangle = false;
      this.isDraggingSlideshow = false;
      this.removeSelectionListeners();
      this.removeDragListeners();
      if (this.currentImageLocation && !this.currentMapUrl) {
        const currentImageUrl = this.getCurrentSlideshowImage();
        if (currentImageUrl) {
          if (!this.mapUrlCache.has(currentImageUrl)) {
            this.mapUrlCache.set(
              currentImageUrl,
              this.buildMapUrl(this.currentImageLocation.lat, this.currentImageLocation.lng)
            );
          }
          this.currentMapUrl = this.mapUrlCache.get(currentImageUrl) || null;
        } else {
          this.currentMapUrl = this.buildMapUrl(this.currentImageLocation.lat, this.currentImageLocation.lng);
        }
      }
      this.resetAllDimensions();
    } else {
      setTimeout(() => {
        this.updateImageDimensions();
        this.updateContainerDimensions();
      }, 0);
    }
    
    // Force immediate change detection for instant UI update, especially important in fullscreen mode
    this.cdr.detectChanges();
  }

  public setTraceViewerOpen(isOpen: boolean): void {
    this.traceViewerOpen = isOpen;
    // When trace viewer closes, reapply slideshow colors if slideshow is still open
    // and reset location view mode to google to show "Photo" button
    if (!isOpen) {
      this.locationViewMode = 'google';
      this.showMapView = false;
      if (this.eventColor && this.modalRef) {
        setTimeout(() => {
          this.applyEventColorToSlideshow();
        }, 100);
      }
    }
  }
  
  public toggleThumbnails(): void {
    // Count actually loaded images (non-empty strings)
    const loadedImagesCount = this.slideshowImages.filter(url => url && url !== '').length;
    if (loadedImagesCount <= 1) {
      return;
    }
    // Set userToggledThumbnails BEFORE toggling to prevent race condition with automatic thumbnail showing
    this.userToggledThumbnails = true;
    // Toggle showThumbnails immediately (same behavior as button click)
    this.showThumbnails = !this.showThumbnails;
    
    // Force change detection to avoid ExpressionChangedAfterItHasBeenCheckedError
    this.cdr.detectChanges();
    
    // Scroll to active thumbnail when showing thumbnails again
    // Styles are now handled by [ngStyle] binding, so they apply immediately on render
    if (this.showThumbnails) {
      setTimeout(() => {
        this.scrollToActiveThumbnail();
      }, 100);
    }
  }
  
  public toggleGrid(): void {
    this.showGrid = !this.showGrid;
    // Force immediate change detection for instant response
    this.cdr.detectChanges();
  }
  
  // Get inline styles for thumbnails in fullscreen mode
  public getThumbnailsFullscreenStyle(): { [key: string]: string } {
    return {
      'position': 'fixed',
      'top': 'auto',
      'bottom': '70px',
      'left': '0',
      'right': '0',
      'width': '100vw',
      'max-width': '100vw',
      'z-index': '100', // Much lower than shortcuts (2000000) so shortcuts appear in front
      'background': 'transparent',
      'pointer-events': 'auto',
      'max-height': '120px'
    };
  }

  private applyFilesystemVariant(
    newUrl: string,
    blob: Blob | null,
    imageIndex: number,
    imageSource: SlideshowImageSource,
    previousZoom: number,
    previousTranslateX: number,
    previousTranslateY: number,
    metadata: PatMetadata | undefined,
    variant: 'compressed' | 'original'
  ): void {
    if (!newUrl) {
      return;
    }

    const currentUrl = this.slideshowImages[this.currentSlideshowIndex];
    if (!currentUrl) {
      return;
    }

    if (blob) {
      this.slideshowBlobs.set(newUrl, blob);
    }

    const fileName = this.imageFileNames.get(currentUrl) || imageSource?.fileName || '';

    // Preload the new image and wait for it to be ready before switching
    if (currentUrl !== newUrl) {
      // Set flag to skip background color update (same image, different quality)
      this.isSwitchingVariant = true;
      
      let variantApplied = false;
      const imgEl = this.slideshowImgElRef?.nativeElement;
      
      const applyVariantOnce = () => {
        if (variantApplied) return;
        variantApplied = true;
        this.continueApplyFilesystemVariant(newUrl, blob, imageIndex, imageSource, previousZoom, previousTranslateX, previousTranslateY, metadata, variant, fileName, currentUrl);
      };
      
      // Preload the image first
      const preloadImage = new Image();
      preloadImage.onload = () => {
        // Image is preloaded and ready
        // Now update the DOM and wait for it to actually render before clearing loading state
        this.slideshowImages[this.currentSlideshowIndex] = newUrl;
        this.updateCurrentSlideshowImageUrl();
        this.cdr.detectChanges();
        
        // Wait for the actual DOM img element to load and render the new src
        // This ensures the image is visible before we clear the loading state
        if (imgEl) {
          const oldSrc = imgEl.src; // Store old src to detect when it changes
          let loadHandlerAttached = false;
          
          const onDomImageLoad = () => {
            // Verify the src has actually changed to the new URL
            if (imgEl.src !== oldSrc && imgEl.complete && imgEl.naturalWidth > 0) {
              if (loadHandlerAttached) {
                imgEl.removeEventListener('load', onDomImageLoad);
                loadHandlerAttached = false;
              }
              // Image loaded in DOM, wait for it to be painted (double RAF)
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  // Now it should be fully rendered, safe to clear loading and continue
                  if (!variantApplied) {
                    applyVariantOnce();
                  }
                });
              });
            }
          };
          
          // Set up load listener BEFORE Angular updates the src (so we catch the load event)
          imgEl.addEventListener('load', onDomImageLoad);
          loadHandlerAttached = true;
          
          // Wait a bit for Angular to update the src binding, then check
          setTimeout(() => {
            // Check if src changed and image is loaded
            if (imgEl.src !== oldSrc && imgEl.complete && imgEl.naturalWidth > 0) {
              // Already loaded, but still wait for rendering
              if (loadHandlerAttached) {
                imgEl.removeEventListener('load', onDomImageLoad);
                loadHandlerAttached = false;
              }
              // Wait for rendering with double RAF
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (!variantApplied) {
                    applyVariantOnce();
                  }
                });
              });
            }
          }, 100); // Give Angular time to update the src binding
          
          // Fallback: if it takes too long, proceed anyway (max 1.5 seconds)
          setTimeout(() => {
            if (loadHandlerAttached) {
              imgEl.removeEventListener('load', onDomImageLoad);
              loadHandlerAttached = false;
            }
            if (!variantApplied) {
              applyVariantOnce();
            }
          }, 1500);
        } else {
          // No DOM element, continue anyway
          applyVariantOnce();
        }
      };
      
      preloadImage.onerror = () => {
        // Preload failed, still switch (fallback)
        this.slideshowImages[this.currentSlideshowIndex] = newUrl;
        this.updateCurrentSlideshowImageUrl();
        this.cdr.detectChanges();
        applyVariantOnce();
      };
      
      preloadImage.src = newUrl;
      
      // Fallback timeout - if preload takes too long, proceed anyway
      setTimeout(() => {
        if (!variantApplied) {
          this.slideshowImages[this.currentSlideshowIndex] = newUrl;
          this.updateCurrentSlideshowImageUrl();
          this.cdr.detectChanges();
          applyVariantOnce();
        }
      }, 200);
      return;
    }
    
    // If URLs are the same, reset flag (no variant switch)
    this.isSwitchingVariant = false;
    
    // If URLs are the same, continue normally
    this.continueApplyFilesystemVariant(newUrl, blob, imageIndex, imageSource, previousZoom, previousTranslateX, previousTranslateY, metadata, variant, fileName, currentUrl);
  }

  private continueApplyFilesystemVariant(
    newUrl: string,
    blob: Blob | null,
    imageIndex: number,
    imageSource: SlideshowImageSource,
    previousZoom: number,
    previousTranslateX: number,
    previousTranslateY: number,
    metadata: PatMetadata | undefined,
    variant: 'compressed' | 'original',
    fileName: string,
    oldUrl: string
  ): void {
    // Clear loading flag now that the image is confirmed rendered
    // (This is called from applyVariantOnce which waits for DOM rendering)
    this.filesystemVariantLoading.delete(imageIndex);
    this.cdr.detectChanges();

    if (fileName) {
      this.imageFileNames.set(newUrl, fileName);
    }

    this.imageUrlToThumbnailIndex.set(newUrl, imageIndex);
    this.slideshowIndexToImageIndex.set(this.currentSlideshowIndex, imageIndex);
    this.currentImageFileName = fileName || '';

    const metadataToStore = metadata ?? imageSource?.patMetadata;
    if (metadataToStore) {
      this.imagePatMetadata.set(newUrl, metadataToStore);
      if (imageSource) {
        imageSource.patMetadata = metadataToStore;
      }
    }

    let variants = this.filesystemImageVariants.get(imageIndex);
    if (!variants && imageSource && imageSource.relativePath && imageSource.fileName) {
      variants = { currentVariant: variant };
      this.filesystemImageVariants.set(imageIndex, variants);
    }
    if (variants) {
      variants.currentVariant = variant;
      if (variant === 'original') {
        variants.originalUrl = newUrl;
        if (metadataToStore) {
          variants.originalMetadata = metadataToStore;
        }
      } else {
        variants.compressedUrl = newUrl;
        if (metadataToStore) {
          variants.compressedMetadata = metadataToStore;
        }
      }
    }

    if (variant === 'compressed') {
      this.prefetchFilesystemOriginalVariant(imageIndex, imageSource, variants);
    }

    // Copy location/map data from old URL to new URL
    if (oldUrl && oldUrl !== newUrl) {
      if (this.imageLocations.has(oldUrl)) {
        const location = this.imageLocations.get(oldUrl)!;
        this.imageLocations.set(newUrl, { ...location });
      }
      if (this.mapUrlCache.has(oldUrl)) {
        this.mapUrlCache.set(newUrl, this.mapUrlCache.get(oldUrl)!);
      }
    }

    this.updateCurrentImageLocation();

    this.slideshowZoom = previousZoom;
    this.slideshowTranslateX = previousTranslateX;
    this.slideshowTranslateY = previousTranslateY;
    this.clampSlideshowTranslation();

    if (imageSource) {
      imageSource.compressFs = variant === 'compressed';
    }

    if (this.showInfoPanel) {
      // Réinitialiser l'état EXIF avant de charger les nouvelles données
      this.isLoadingExif = false;
      this.exifData = [];
      
      // Si on a le blob, on peut charger les EXIF immédiatement
      if (blob) {
        // Vérifier d'abord le cache
        const cachedExifData = this.exifDataCache.get(newUrl);
        if (cachedExifData && cachedExifData.length > 0) {
          // Utiliser les données en cache
          this.exifData = cachedExifData;
          this.sortExifDataForDisplay();
          this.isLoadingExif = false;
          this.cdr.detectChanges();
        } else {
          // Charger les EXIF depuis le blob
          this.isLoadingExif = true;
          this.cdr.detectChanges();
          
          // Précharger en arrière-plan pour le cache
          this.preloadExifData(newUrl, blob).catch(() => {
            // Ignorer les erreurs de préchargement
          });
          
          // Charger pour l'affichage
          this.loadExifData().then(() => {
            if (this.getCurrentSlideshowImage() === newUrl) {
              this.isLoadingExif = false;
              this.cdr.detectChanges();
            } else {
              this.isLoadingExif = false;
              this.exifData = [];
            }
          }).catch(() => {
            if (this.getCurrentSlideshowImage() === newUrl) {
              this.isLoadingExif = false;
              this.cdr.detectChanges();
            }
          });
        }
      } else {
        // Pas de blob disponible, attendre que l'image soit chargée dans le DOM
        const imgEl = this.slideshowImgElRef?.nativeElement;
        if (imgEl) {
          // Vérifier que l'URL de l'image correspond à la nouvelle URL
          const checkImageLoaded = (): boolean => {
            return imgEl.src === newUrl && imgEl.complete && imgEl.naturalWidth > 0;
          };
          
          if (checkImageLoaded()) {
            // L'image est déjà chargée avec la nouvelle URL
            setTimeout(() => this.loadExifDataForInfoPanel(), 100);
          } else {
            // Attendre que l'image se charge avec la nouvelle URL
            let loadTimeoutId: any = null;
            const onImageLoad = () => {
              if (checkImageLoaded()) {
                imgEl.removeEventListener('load', onImageLoad);
                if (loadTimeoutId) {
                  clearTimeout(loadTimeoutId);
                }
                setTimeout(() => this.loadExifDataForInfoPanel(), 100);
              }
            };
            imgEl.addEventListener('load', onImageLoad);
            
            // Timeout de sécurité réduit
            loadTimeoutId = setTimeout(() => {
              imgEl.removeEventListener('load', onImageLoad);
              if (checkImageLoaded()) {
                this.loadExifDataForInfoPanel();
              } else {
                // Si l'image n'est toujours pas chargée, essayer quand même
                this.loadExifDataForInfoPanel();
              }
            }, 2000);
          }
        } else {
          // Pas d'élément image, essayer quand même après un court délai
          setTimeout(() => this.loadExifDataForInfoPanel(), 200);
        }
      }
    }

    this.cdr.detectChanges();
  }

  private prefetchFilesystemOriginalVariant(
    imageIndex: number,
    imageSource: SlideshowImageSource,
    variants?: {
      compressedUrl?: string;
      originalUrl?: string;
      compressedMetadata?: PatMetadata;
      originalMetadata?: PatMetadata;
      currentVariant: 'compressed' | 'original';
    }
  ): void {
    if (!imageSource || !imageSource.relativePath || !imageSource.fileName) {
      return;
    }

    if (imageSource.compressFs === false) {
      return;
    }

    const existingVariants = variants ?? this.filesystemImageVariants.get(imageIndex);
    if (existingVariants && existingVariants.originalUrl) {
      return;
    }

    if (this.filesystemOriginalPrefetching.has(imageIndex)) {
      return;
    }

    const originalCacheKey = this.getFilesystemCacheKey(imageSource.relativePath, imageSource.fileName, false);
    if (originalCacheKey && this.imageCache.has(originalCacheKey)) {
      const cached = this.imageCache.get(originalCacheKey)!;
      let variantsToUpdate = existingVariants;
      if (!variantsToUpdate) {
        variantsToUpdate = { currentVariant: 'compressed' };
        this.filesystemImageVariants.set(imageIndex, variantsToUpdate);
      }
      variantsToUpdate.originalUrl = cached.objectUrl;
      if (cached.metadata) {
        variantsToUpdate.originalMetadata = cached.metadata;
      }
      if (cached.blob) {
        this.slideshowBlobs.set(cached.objectUrl, cached.blob);
      }
      return;
    }

    if (!this.cancelImageLoadsSubject) {
      this.cancelImageLoadsSubject = new Subject<void>();
    }

    this.filesystemOriginalPrefetching.add(imageIndex);

    const request$ = this.fileService.getImageFromDiskWithMetadata(
      imageSource.relativePath,
      imageSource.fileName,
      false
    ).pipe(
      takeUntil(this.cancelImageLoadsSubject),
      map((res) => {
        const mimeType = this.detectImageMimeTypeFromFileName(imageSource.fileName || 'image.jpg');
        const blob = new Blob([res.buffer], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        const metadata = res.metadata ?? this.parsePatMetadataFromHeaders(res.headers);
        return { objectUrl, blob, metadata };
      }),
      finalize(() => {
        this.filesystemOriginalPrefetching.delete(imageIndex);
      })
    );

    const subscription = request$.subscribe({
      next: ({ objectUrl, blob, metadata }) => {
        let variantsToUpdate = variants ?? this.filesystemImageVariants.get(imageIndex);
        if (!variantsToUpdate) {
          variantsToUpdate = { currentVariant: 'compressed' };
          this.filesystemImageVariants.set(imageIndex, variantsToUpdate);
        }
        variantsToUpdate.originalUrl = objectUrl;
        if (metadata) {
          variantsToUpdate.originalMetadata = metadata;
        }
        this.slideshowBlobs.set(objectUrl, blob);
        if (originalCacheKey) {
          this.imageCache.set(originalCacheKey, { objectUrl, blob, metadata });
        }
        // If the currently displayed image corresponds to this imageIndex and we are still on compressed,
        // automatically switch to the original variant once it is available.
        const currentMappedIndex = this.slideshowIndexToImageIndex.get(this.currentSlideshowIndex);
        if (currentMappedIndex === imageIndex && variantsToUpdate.currentVariant === 'compressed') {
          const previousZoom = this.slideshowZoom;
          const previousTranslateX = this.slideshowTranslateX;
          const previousTranslateY = this.slideshowTranslateY;
          this.applyFilesystemVariant(
            objectUrl,
            blob,
            imageIndex,
            imageSource,
            previousZoom,
            previousTranslateX,
            previousTranslateY,
            metadata,
            'original'
          );
        }
      },
      error: (error) => {
      }
    });

    this.imageLoadingSubs.push(subscription);
  }
  
  // Capture la partie visible de l'image zoomée dans un canvas et retourne un blob
  private async captureVisibleImagePortion(imageBlob: Blob): Promise<Blob | null> {
    try {
      // Vérifier si l'image est zoomée
      const minZoom = this.getMinSlideshowZoom();
      if (this.slideshowZoom <= minZoom || this.showMapView) {
        // Pas de zoom ou vue carte, retourner l'image originale
        return null;
      }
      
      // Calculer la portion visible
      this.calculateVisibleImagePortion();
      
      if (this.visibleImageWidth <= 0 || this.visibleImageHeight <= 0) {
        return null;
      }
      
      // Créer une image à partir du blob
      const img = new Image();
      const imageUrl = URL.createObjectURL(imageBlob);
      
      return new Promise<Blob | null>((resolve, reject) => {
        img.onload = () => {
          try {
            // Créer un canvas pour capturer la portion visible
            const canvas = document.createElement('canvas');
            canvas.width = this.visibleImageWidth;
            canvas.height = this.visibleImageHeight;
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
              URL.revokeObjectURL(imageUrl);
              resolve(null);
              return;
            }
            
            // Dessiner la portion visible de l'image sur le canvas
            ctx.drawImage(
              img,
              this.visibleImageOriginX,
              this.visibleImageOriginY,
              this.visibleImageWidth,
              this.visibleImageHeight,
              0,
              0,
              this.visibleImageWidth,
              this.visibleImageHeight
            );
            
            // Convertir le canvas en blob
            canvas.toBlob((blob) => {
              URL.revokeObjectURL(imageUrl);
              resolve(blob);
            }, imageBlob.type || 'image/jpeg', 0.95);
          } catch (error) {
            URL.revokeObjectURL(imageUrl);
            resolve(null);
          }
        };
        
        img.onerror = () => {
          URL.revokeObjectURL(imageUrl);
          resolve(null);
        };
        
        img.src = imageUrl;
      });
    } catch (error) {
      return null;
    }
  }
  
  // Share image via Web Share API (WhatsApp, etc.)
  public async shareImage(): Promise<void> {
    try {
      const currentImageUrl = this.getCurrentSlideshowImage();
      if (!currentImageUrl) {
        return;
      }
      
      // Check if Web Share API is available
      // On desktop (PC), Web Share API is usually not available, so we download directly
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      
      if (!navigator.share) {
        // Web Share API not available (typically on desktop)
        // Always download on desktop
        this.downloadImage();
        return;
      }
      
      // Get the blob for the current image
      let blob = this.slideshowBlobs.get(currentImageUrl);
      
      // If blob is not in cache, fetch it
      if (!blob) {
        try {
          const response = await fetch(currentImageUrl);
          blob = await response.blob();
          // Cache it for future use
          if (blob) {
            this.slideshowBlobs.set(currentImageUrl, blob);
          }
        } catch (error) {
          // Fallback to download
          this.downloadImage();
          return;
        }
      }
      
      if (!blob) {
        // Fallback to download
        this.downloadImage();
        return;
      }
      
      // Capturer la partie visible si l'image est zoomée
      const visibleBlob = await this.captureVisibleImagePortion(blob);
      if (visibleBlob) {
        blob = visibleBlob;
      }
      
      // Get file name if available
      const fileName = this.imageFileNames.get(currentImageUrl) || 'image.jpg';
      
      // Ensure proper MIME type - detect if not set or incorrect
      let mimeType = blob.type || 'image/jpeg';
      if (!mimeType.startsWith('image/')) {
        // Try to detect from file extension or default to jpeg
        const ext = fileName.toLowerCase().split('.').pop();
        if (ext === 'png') {
          mimeType = 'image/png';
        } else if (ext === 'gif') {
          mimeType = 'image/gif';
        } else if (ext === 'webp') {
          mimeType = 'image/webp';
        } else {
          mimeType = 'image/jpeg';
        }
      }
      
      // Create a new Blob with the correct MIME type if needed
      if (blob.type !== mimeType) {
        blob = new Blob([blob], { type: mimeType });
      }
      
      // Create a File object from the blob with proper MIME type
      const file = new File([blob], fileName, { type: mimeType });
      
      // Prepare share data with file
      const shareData: any = {
        files: [file]
      };
      
      // Try to share files (Web Share API Level 2)
      // On mobile devices, file sharing should be supported even if canShare returns false
      // So we'll try to share directly on mobile, and only check canShare as a safety check
      // isMobile is already declared at the beginning of the function
      
      // On mobile, always try to share files first (even if canShare says no)
      // Desktop browsers need canShare check
      if (isMobile || (navigator.canShare && navigator.canShare(shareData))) {
        try {
          // Share the file - this should show native share dialog on mobile
          await navigator.share(shareData);
          return; // Success, exit early
        } catch (shareError: any) {
          // If sharing fails with AbortError (user cancelled), don't show download
          if (shareError.name === 'AbortError') {
            return;
          }
          // For other errors, continue to URL sharing fallback
          // Only log non-mobile errors to avoid console spam
          if (!isMobile) {
          }
        }
      }
      
      // If file sharing is not supported, try URL sharing as fallback
      // But only if we can create a data URL (for blob URLs)
      if (currentImageUrl.startsWith('blob:')) {
        try {
          // Convert blob to data URL for sharing
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          
          const urlShareData = {
            url: dataUrl
          };
          
          if (!navigator.canShare || navigator.canShare(urlShareData)) {
            await navigator.share(urlShareData);
            return; // Success
          }
        } catch (error) {
        }
      } else {
        // For non-blob URLs, try sharing the URL directly
        const urlShareData = {
          url: currentImageUrl
        };
        
        if (!navigator.canShare || navigator.canShare(urlShareData)) {
          await navigator.share(urlShareData);
          return; // Success
        }
      }
      
      // If all sharing methods fail, fallback to download
      this.downloadImage();
      
    } catch (error: any) {
      // User cancelled sharing (AbortError) - don't show download dialog
      if (error.name === 'AbortError') {
        // User cancelled, do nothing
        return;
      }
      
      // Other errors - fallback to download
      this.downloadImage();
    }
  }
  
  // Download image as fallback when share is not available
  private async downloadImage(): Promise<void> {
    try {
      const currentImageUrl = this.getCurrentSlideshowImage();
      if (!currentImageUrl) {
        return;
      }
      
      // Get blob from cache or fetch it
      let blob = this.slideshowBlobs.get(currentImageUrl);
      
      // If blob is not in cache, fetch it
      if (!blob) {
        try {
          const response = await fetch(currentImageUrl);
          blob = await response.blob();
          // Cache it for future use
          if (blob) {
            this.slideshowBlobs.set(currentImageUrl, blob);
          }
        } catch (error) {
          // Fallback: try to download directly via link (may open in new tab)
          const link = document.createElement('a');
          link.href = currentImageUrl;
          link.download = this.imageFileNames.get(currentImageUrl) || 'image.jpg';
          link.target = '_blank';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          return;
        }
      }
      
      if (blob) {
        // Capturer la partie visible si l'image est zoomée
        const visibleBlob = await this.captureVisibleImagePortion(blob);
        if (visibleBlob) {
          blob = visibleBlob;
        }
        
        // Use blob to create download link
        const fileName = this.imageFileNames.get(currentImageUrl) || 'image.jpg';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.style.display = 'none'; // Hide the link
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // Revoke the URL after a delay to allow download to start
        setTimeout(() => URL.revokeObjectURL(url), 100);
      }
    } catch (error) {
    }
  }
  
  // Load EXIF data for info panel (used when panel is shown or image changes)
  private loadExifDataForInfoPanel(): void {
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (currentImageUrl) {
      const cachedExifData = this.exifDataCache.get(currentImageUrl);
      if (cachedExifData) {
        // Use cached data
        this.exifData = cachedExifData;
        this.sortExifDataForDisplay();
        this.isLoadingExif = false;
        this.logExifDataForCurrentImage('info-panel-cache');
      } else {
        // Load EXIF data
        this.isLoadingExif = true;
        this.exifData = [];
        
        // Stocker l'URL pour laquelle on charge les EXIF pour vérifier qu'elle n'a pas changé
        const loadingForUrl = currentImageUrl;
        
        // Timeout de sécurité pour éviter un chargement infini (réduit à 5 secondes)
        const timeoutId = setTimeout(() => {
          if (this.isLoadingExif && this.getCurrentSlideshowImage() === loadingForUrl) {
            this.isLoadingExif = false;
            // Si aucune donnée EXIF n'a été chargée, afficher le message "pas de données"
            if (!this.exifData || this.exifData.length === 0) {
              this.exifData = [];
            }
            // Mettre à jour le cache même vide pour éviter les tentatives infinies
            if (currentImageUrl) {
              this.exifDataCache.set(currentImageUrl, [...this.exifData]);
            }
          }
        }, 4500); // Timeout de 4.5 secondes (légèrement supérieur au timeout de loadExifData qui est de 4s)
        
        this.loadExifData().then(() => {
          clearTimeout(timeoutId);
          // Vérifier que l'image n'a pas changé pendant le chargement
          if (this.getCurrentSlideshowImage() === loadingForUrl) {
            // Check if PAT metadata is now available and add it if missing
            const originalSizeLabel = this.translateService.instant('EVENTELEM.EXIF_ORIGINAL_FILE_SIZE');
            if (!this.exifData.some(item => item.label === originalSizeLabel)) {
              let meta = this.imagePatMetadata.get(loadingForUrl);
              let formatted = meta ? this.formatPatMetadata(meta) : null;
              
              // If not found, try to get from filesystem variants cache
              if (!formatted) {
                const imageIndex = this.imageUrlToThumbnailIndex.get(loadingForUrl);
                if (imageIndex !== undefined) {
                  const variants = this.filesystemImageVariants.get(imageIndex);
                  if (variants && variants.originalMetadata) {
                    formatted = this.formatPatMetadata(variants.originalMetadata);
                  }
                }
              }
              
              if (formatted) {
                this.exifData.push({
                  label: originalSizeLabel,
                  value: formatted
                });
                this.sortExifDataForDisplay();
                // Update cache with the new data
                if (loadingForUrl && this.exifData.length > 0) {
                  this.exifDataCache.set(loadingForUrl, [...this.exifData]);
                }
                this.cdr.markForCheck();
              }
            }
            
            this.isLoadingExif = false;
            this.logExifDataForCurrentImage('info-panel-loaded');
          } else {
            // L'image a changé, réinitialiser l'état
            this.isLoadingExif = false;
            this.exifData = [];
          }
        }).catch((error) => {
          clearTimeout(timeoutId);
          // Vérifier que l'image n'a pas changé pendant le chargement
          if (this.getCurrentSlideshowImage() === loadingForUrl) {
            this.isLoadingExif = false;
          }
        });
        
        // Also check for PAT metadata after a short delay in case it becomes available later
        setTimeout(() => {
          if (this.getCurrentSlideshowImage() === loadingForUrl && !this.isLoadingExif) {
            const originalSizeLabel = this.translateService.instant('EVENTELEM.EXIF_ORIGINAL_FILE_SIZE');
            if (!this.exifData.some(item => item.label === originalSizeLabel)) {
              let meta = this.imagePatMetadata.get(loadingForUrl);
              let formatted = meta ? this.formatPatMetadata(meta) : null;
              
              // If not found, try to get from filesystem variants cache
              if (!formatted) {
                const imageIndex = this.imageUrlToThumbnailIndex.get(loadingForUrl);
                if (imageIndex !== undefined) {
                  const variants = this.filesystemImageVariants.get(imageIndex);
                  if (variants && variants.originalMetadata) {
                    formatted = this.formatPatMetadata(variants.originalMetadata);
                  }
                }
              }
              
              if (formatted) {
                this.exifData.push({
                  label: originalSizeLabel,
                  value: formatted
                });
                this.sortExifDataForDisplay();
                // Update cache with the new data
                if (loadingForUrl && this.exifData.length > 0) {
                  this.exifDataCache.set(loadingForUrl, [...this.exifData]);
                }
                this.cdr.markForCheck();
              }
            }
          }
        }, 500); // Check again after 500ms in case metadata arrives late
      }
    } else {
      // Pas d'URL, réinitialiser l'état
      this.isLoadingExif = false;
      this.exifData = [];
    }
  }
  
  // Pre-load EXIF data in background when image is loaded
  private async preloadExifData(imageUrl: string, blob: Blob): Promise<void> {
    // Check if already cached or loading is cancelled
    if (!this.imageLoadActive || this.exifDataCache.has(imageUrl)) {
      return;
    }
    
    try {
      // Read EXIF from blob without UI blocking
      await this.readExifFromBlob(blob, imageUrl);
    } catch (error) {
      // Silently fail - we'll try again when user requests EXIF info
    }
  }
  
  private async loadExifData(): Promise<void> {
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (!currentImageUrl) {
      return;
    }
    
    // Double-check cache (safety check)
    const cachedExifData = this.exifDataCache.get(currentImageUrl);
    if (cachedExifData) {
      // Check if file size is already in cache
      const hasFileSize = cachedExifData.some(item => 
        item.label === this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE')
      );
      
      if (hasFileSize) {
        // Cache is complete, use it
        this.exifData = cachedExifData;
        this.sortExifDataForDisplay();
        this.logExifDataForCurrentImage('load-exif-cache');
        return;
      } else {
        // Cache exists but missing file size - we'll add it below
        this.exifData = [...cachedExifData];
      }
    }
    
    // Timeout global pour s'assurer que la fonction se résout toujours
    const globalTimeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 4000); // Timeout de 4 secondes au total
    });
    
    const loadPromise = (async () => {
      try {
        // Get image dimensions from the img element
        const imgEl = this.slideshowImgElRef?.nativeElement;
      if (imgEl && imgEl.complete) {
        this.exifData.push({
          label: this.translateService.instant('EVENTELEM.EXIF_WIDTH'),
          value: `${imgEl.naturalWidth} px`
        });
        this.exifData.push({
          label: this.translateService.instant('EVENTELEM.EXIF_HEIGHT'),
          value: `${imgEl.naturalHeight} px`
        });
      }
      
      // Get blob from stored blobs (NO network request - we always store blobs when loading images)
      let blob: Blob | null = null;
      
      // First, try to get stored blob (works for both blob URLs and could work for regular URLs if stored)
      const storedBlob = this.slideshowBlobs.get(currentImageUrl);
      if (storedBlob) {
        blob = storedBlob;
      } else if (currentImageUrl.startsWith('blob:')) {
        // Pour les blob URLs, si le blob n'est pas stocké, on essaiera de lire depuis l'élément image
        // Do not fetch blob: URLs again — this would create a duplicate blob request in DevTools.
        blob = null;
      } else {
        // For http(s) URLs, avoid downloading the body here; we'll try a HEAD below for size/mime.
        blob = null;
      }
      
      // Add file size and MIME type if we have the blob
      if (blob) {
        // Check if file size is already in exifData (from cache)
        const hasFileSize = this.exifData.some(item => 
          item.label === this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE')
        );
        const hasMimeType = this.exifData.some(item => 
          item.label === this.translateService.instant('EVENTELEM.EXIF_MIME_TYPE')
        );
        
        if (!hasFileSize) {
          this.exifData.push({
            label: this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE'),
            value: this.formatFileSize(blob.size)
          });
        }
        if (!hasMimeType) {
          this.exifData.push({
            label: this.translateService.instant('EVENTELEM.EXIF_MIME_TYPE'),
            value: blob.type || 'image/jpeg'
          });
        }
        // Read EXIF from blob (will add EXIF data, not duplicate file size/mime)
        try {
          await this.readExifFromBlob(blob);
        } catch (error) {
          // Si la lecture depuis le blob échoue, essayer depuis l'élément image
          if (imgEl && imgEl.src === currentImageUrl && imgEl.complete && imgEl.naturalWidth > 0) {
            try {
              await this.readExifFromImageElement(imgEl);
            } catch (error2) {
              // Ignorer l'erreur
            }
          }
        }
      } else {
        // If we don't have the blob, try to get file size from HEAD request for HTTP/HTTPS URLs
        if (!currentImageUrl.startsWith('blob:')) {
          const fileSizeLabel = this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE');
          const mimeTypeLabel = this.translateService.instant('EVENTELEM.EXIF_MIME_TYPE');
          const hasFileSize = this.exifData.some(item => item.label === fileSizeLabel);
          const hasMimeType = this.exifData.some(item => item.label === mimeTypeLabel);
          
          if (!hasFileSize || !hasMimeType) {
            try {
              const headResponse = await fetch(currentImageUrl, { method: 'HEAD' });
              const contentLength = headResponse.headers.get('Content-Length');
              if (contentLength && !hasFileSize) {
                this.exifData.push({
                  label: fileSizeLabel,
                  value: this.formatFileSize(parseInt(contentLength, 10))
                });
              }
              const contentType = headResponse.headers.get('Content-Type');
              if (contentType && !hasMimeType) {
                this.exifData.push({
                  label: mimeTypeLabel,
                  value: contentType
                });
              }
              
              // Update cache with complete data including file size
              if (currentImageUrl && this.exifData.length > 0) {
                this.exifDataCache.set(currentImageUrl, [...this.exifData]);
              }
            } catch (error) {
            }
          }
        }
        
        // Try reading EXIF from image element as last resort
        // For blob URLs without stored blob, or for non-blob URLs
        if (imgEl && imgEl.src) {
          // Vérifier que l'URL de l'image correspond à l'URL courante
          if (imgEl.src === currentImageUrl) {
            // Pour les blob URLs, attendre que l'image soit chargée avant de lire les EXIF
            if (currentImageUrl.startsWith('blob:')) {
              if (imgEl.complete && imgEl.naturalWidth > 0) {
                // L'image est chargée, on peut lire les EXIF
                try {
                  await Promise.race([
                    this.readExifFromImageElement(imgEl),
                    new Promise<void>((resolve) => setTimeout(() => resolve(), 3000))
                  ]);
                } catch (error) {
                  // Ignorer l'erreur
                }
              } else {
                // Attendre que l'image se charge (avec timeout)
                try {
                  await Promise.race([
                    new Promise<void>((resolve) => {
                      const onLoad = () => {
                        imgEl.removeEventListener('load', onLoad);
                        this.readExifFromImageElement(imgEl).then(() => resolve()).catch(() => resolve());
                      };
                      imgEl.addEventListener('load', onLoad);
                      // Timeout de sécurité
                      setTimeout(() => {
                        imgEl.removeEventListener('load', onLoad);
                        resolve();
                      }, 2000);
                    }),
                    new Promise<void>((resolve) => setTimeout(() => resolve(), 3000))
                  ]);
                } catch (error) {
                  // Ignorer l'erreur
                }
              }
            } else {
              // Pour les URLs non-blob, essayer directement
              try {
                await Promise.race([
                  this.readExifFromImageElement(imgEl),
                  new Promise<void>((resolve) => setTimeout(() => resolve(), 3000))
                ]);
              } catch (error) {
                // Ignorer l'erreur
              }
            }
          }
        }
        
        // Sort EXIF entries for consistent display
        this.sortExifDataForDisplay();
        
        // Update cache even if we only have partial data (to avoid infinite retries)
        if (currentImageUrl && this.exifData.length > 0) {
          this.exifDataCache.set(currentImageUrl, [...this.exifData]);
        }
      } // Fin du else
      
      // Ensure "original size before compression" is shown if available via backend metadata
      // This check is done AFTER all EXIF reading attempts, so it works even if blob is not available
      const originalSizeLabel = this.translateService.instant('EVENTELEM.EXIF_ORIGINAL_FILE_SIZE');
      if (!this.exifData.some(item => item.label === originalSizeLabel)) {
        // Try to get metadata from imagePatMetadata map
        let meta = this.imagePatMetadata.get(currentImageUrl);
        let formatted = meta ? this.formatPatMetadata(meta) : null;
        
        // If not found, try to get from filesystem variants cache
        if (!formatted) {
          const imageIndex = this.imageUrlToThumbnailIndex.get(currentImageUrl);
          if (imageIndex !== undefined) {
            const variants = this.filesystemImageVariants.get(imageIndex);
            if (variants && variants.originalMetadata) {
              formatted = this.formatPatMetadata(variants.originalMetadata);
            }
          }
        }
        
        if (formatted) {
          this.exifData.push({
            label: originalSizeLabel,
            value: formatted
          });
          // Re-sort after adding original size
          this.sortExifDataForDisplay();
          // Update cache with the new data
          if (currentImageUrl && this.exifData.length > 0) {
            this.exifDataCache.set(currentImageUrl, [...this.exifData]);
          }
        }
      }
      } catch (error) {
        // En cas d'erreur, s'assurer qu'on a au moins les dimensions si disponibles
        const imgEl = this.slideshowImgElRef?.nativeElement;
        if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
          const hasWidth = this.exifData.some(item => 
            item.label === this.translateService.instant('EVENTELEM.EXIF_WIDTH')
          );
          const hasHeight = this.exifData.some(item => 
            item.label === this.translateService.instant('EVENTELEM.EXIF_HEIGHT')
          );
          if (!hasWidth) {
            this.exifData.push({
              label: this.translateService.instant('EVENTELEM.EXIF_WIDTH'),
              value: `${imgEl.naturalWidth} px`
            });
          }
          if (!hasHeight) {
            this.exifData.push({
              label: this.translateService.instant('EVENTELEM.EXIF_HEIGHT'),
              value: `${imgEl.naturalHeight} px`
            });
          }
          this.sortExifDataForDisplay();
        }
        // Mettre à jour le cache même en cas d'erreur pour éviter les tentatives infinies
        if (currentImageUrl) {
          this.exifDataCache.set(currentImageUrl, [...this.exifData]);
        }
      }
    })();
    
    // Utiliser Promise.race pour s'assurer qu'on se résout toujours, même en cas de timeout
    await Promise.race([loadPromise, globalTimeout]);

    this.logExifDataForCurrentImage('load-exif-complete');
  }

  // Keep EXIF entries sorted by label for better readability
  private sortExifDataForDisplay(): void {
    if (Array.isArray(this.exifData)) {
      const fileSizeLabel = this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE');
      const originalSizeLabel = this.translateService.instant('EVENTELEM.EXIF_ORIGINAL_FILE_SIZE');
      const gpsLabel = this.translateService.instant('EVENTELEM.EXIF_GPS');
      const altitudeLabel = this.translateService.instant('EVENTELEM.EXIF_ALTITUDE');
      
      const weightOf = (label: string): number => {
        if (label === fileSizeLabel) return 10;            // 1) Current file size
        if (label === originalSizeLabel) return 11;        // 2) Original size before compression (immediately after)
        if (label === gpsLabel) return 20;                 // 3) GPS coordinates
        if (label === altitudeLabel) return 21;             // 4) Altitude (immediately after GPS)
        return 100;                                        // Others come after, alphabetically
      };
      
      this.exifData.sort((a, b) => {
        const la = (a?.label || '').toString();
        const lb = (b?.label || '').toString();
        const wa = weightOf(la);
        const wb = weightOf(lb);
        if (wa !== wb) return wa - wb;
        return la.localeCompare(lb);
      });
      
      // Hard position guarantee: ensure "Original size" is immediately after "File size"
      const idxFile = this.exifData.findIndex(it => (it?.label || '') === fileSizeLabel);
      const idxOriginal = this.exifData.findIndex(it => (it?.label || '') === originalSizeLabel);
      if (idxFile !== -1 && idxOriginal !== -1 && idxOriginal !== idxFile + 1) {
        const [originalItem] = this.exifData.splice(idxOriginal, 1);
        this.exifData.splice(idxFile + 1, 0, originalItem);
      }
      
      // Hard position guarantee: ensure "Altitude" is immediately after "GPS"
      const idxGps = this.exifData.findIndex(it => (it?.label || '') === gpsLabel);
      const idxAltitude = this.exifData.findIndex(it => (it?.label || '') === altitudeLabel);
      if (idxGps !== -1 && idxAltitude !== -1 && idxAltitude !== idxGps + 1) {
        const [altitudeItem] = this.exifData.splice(idxAltitude, 1);
        this.exifData.splice(idxGps + 1, 0, altitudeItem);
      }
    }
  }

  private logExifDataForCurrentImage(context: string): void {
    if (typeof console === 'undefined' || !console) {
      return;
    }

    const currentImageUrl = this.getCurrentSlideshowImage();
    if (!currentImageUrl) {
      return;
    }

    const fileName =
      this.currentImageFileName ||
      this.imageFileNames.get(currentImageUrl) ||
      'image.jpg';

    const summary = {
      context,
      fileName,
      imageUrl: currentImageUrl,
      exifItemCount: this.exifData?.length || 0
    };

  }
  
  private async readExifFromBlob(blob: Blob, imageUrl?: string): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 3000); // Timeout de 3 secondes pour éviter un chargement infini
      
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve();
        }
      };
      
      // Use FileReader to read blob as data URL to avoid CSP violations
      const reader = new FileReader();
      
      reader.onload = (e: any) => {
        const dataUrl = e.target.result;
        
        // Create a temporary image element to use with EXIF.js
        const img = new Image();
        
        img.onload = () => {
          try {
            // Ajouter un timeout supplémentaire pour EXIF.getData
            const exifTimeoutId = setTimeout(() => {
              safeResolve();
            }, 2000); // Timeout de 2 secondes pour EXIF.getData
            
            EXIF.getData(img as any, () => {
              clearTimeout(exifTimeoutId);
              try {
                const exifData = EXIF.getAllTags(img as any);
                
                // Process EXIF data into display format
                const processedData: Array<{label: string, value: string}> = [];
                
                // Always add file size and MIME type first (since we have the blob)
                // But only if not already present in target array
                const fileSizeLabel = this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE');
                const mimeTypeLabel = this.translateService.instant('EVENTELEM.EXIF_MIME_TYPE');
                
                // For caching (preloading): always add file size and MIME type
                // For direct use (loadExifData): check if already present in this.exifData
                const shouldAddFileSize = imageUrl || !this.exifData.some(item => item.label === fileSizeLabel);
                const shouldAddMimeType = imageUrl || !this.exifData.some(item => item.label === mimeTypeLabel);
                
                if (shouldAddFileSize) {
                  processedData.push({
                    label: fileSizeLabel,
                    value: this.formatFileSize(blob.size)
                  });
                }
                if (shouldAddMimeType) {
                  processedData.push({
                    label: mimeTypeLabel,
                    value: blob.type || 'image/jpeg'
                  });
                }
                
                // Then add EXIF metadata
                this.processExifDataIntoArray(exifData, processedData, imageUrl);
                
                // Cache the processed data if imageUrl is provided (for preloading)
                if (imageUrl && processedData.length > 0) {
                  this.exifDataCache.set(imageUrl, processedData);
                }
                
                // If called from loadExifData (user requested), add to existing data
                if (!imageUrl) {
                  this.exifData.push(...processedData);
                }
              } catch (error) {
              }
              safeResolve();
            });
          } catch (error) {
            safeResolve();
          }
        };
        
        img.onerror = (error) => {
          safeResolve();
        };
        
        // Set src after setting up event handlers
        img.src = dataUrl;
      };
      
      reader.onerror = (error) => {
        safeResolve();
      };
      
      // Read blob as data URL
      reader.readAsDataURL(blob);
    });
  }
  
  // Read EXIF from blob URL by creating a new image (avoids CSP violation)
  // Note: This creates a new image element which may trigger CSP checks
  // Should only be used as fallback when blob is not stored
  private async readExifFromBlobUrl(blobUrl: string): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 3000); // Timeout de 3 secondes pour éviter un chargement infini
      
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve();
        }
      };
      
      // Don't set crossOrigin as it may trigger CSP checks
      const img = new Image();
      
      img.onload = () => {
        try {
          // Ajouter un timeout supplémentaire pour EXIF.getData
          const exifTimeoutId = setTimeout(() => {
            safeResolve();
          }, 3000);
          
          EXIF.getData(img as any, () => {
            clearTimeout(exifTimeoutId);
            try {
              const exifData = EXIF.getAllTags(img as any);
              this.processExifData(exifData);
            } catch (error) {
            }
            safeResolve();
          });
        } catch (error) {
          safeResolve();
        }
      };
      
      img.onerror = (error) => {
        safeResolve();
      };
      
      // Set src after setting up event handlers
      img.src = blobUrl;
    });
  }
  
  // Read EXIF data directly from image element (avoids CSP violation)
  private async readExifFromImageElement(imgEl: HTMLImageElement | null | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (!imgEl) {
        resolve();
        return;
      }
      
      // Always use the src from the image element to ensure EXIF.js can read it
      const imgSrc = imgEl.src;
      if (!imgSrc) {
        resolve();
        return;
      }
      
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 3000); // Timeout de 3 secondes pour éviter un chargement infini
      
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve();
        }
      };
      
      // Create a new image with the same src for EXIF reading
      const img = new Image();
      
      img.onload = () => {
        try {
          // Ajouter un timeout supplémentaire pour EXIF.getData
          const exifTimeoutId = setTimeout(() => {
            safeResolve();
          }, 3000);
          
          EXIF.getData(img as any, () => {
            clearTimeout(exifTimeoutId);
            try {
              const exifData = EXIF.getAllTags(img as any);
              this.processExifData(exifData);
            } catch (error) {
            }
            safeResolve();
          });
        } catch (error) {
          safeResolve();
        }
      };
      
      img.onerror = () => {
        safeResolve();
      };
      
      img.src = imgSrc;
    });
  }
  
  // Read EXIF data synchronously from image element
  private readExifFromImageElementSync(imgEl: HTMLImageElement): void {
    try {
      EXIF.getData(imgEl as any, () => {
        try {
          const exifData = EXIF.getAllTags(imgEl as any);
          this.processExifData(exifData);
        } catch (error) {
        }
      });
    } catch (error) {
    }
  }
  
  // Process EXIF data and add to display array (for direct UI update)
  private processExifData(exifData: any): void {
    if (!exifData) {
      return;
    }
    const currentImageUrl = this.getCurrentSlideshowImage();
    this.processExifDataIntoArray(exifData, this.exifData, currentImageUrl || undefined);
  }
  
  // Process EXIF data into a provided array (reusable for caching)
  private processExifDataIntoArray(exifData: any, targetArray: Array<{label: string, value: string}>, imageUrl?: string): void {
    if (!exifData) {
      return;
    }
    
    const imageUrlToUse = imageUrl || this.getCurrentSlideshowImage();
    
    // Camera info
    if (exifData.Make) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_MAKE'),
        value: exifData.Make
      });
    }
    if (exifData.Model) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_MODEL'),
        value: exifData.Model
      });
    }
    
    // Date/Time
    if (exifData.DateTime) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_DATE_TIME'),
        value: exifData.DateTime
      });
    }
    if (exifData.DateTimeOriginal) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_DATE_TIME_ORIGINAL'),
        value: exifData.DateTimeOriginal
      });
    }
    
    // Camera settings
    if (exifData.ExposureTime) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_EXPOSURE_TIME'),
        value: `1/${Math.round(1 / exifData.ExposureTime)}s`
      });
    }
    if (exifData.FNumber) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_F_NUMBER'),
        value: `f/${exifData.FNumber}`
      });
    }
    if (exifData.ISOSpeedRatings) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_ISO'),
        value: `ISO ${exifData.ISOSpeedRatings}`
      });
    }
    if (exifData.FocalLength) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_FOCAL_LENGTH'),
        value: `${exifData.FocalLength} mm`
      });
    }
    
    // Flash
    if (exifData.Flash !== undefined) {
      const flashValue = exifData.Flash === 0 ? 
        this.translateService.instant('EVENTELEM.EXIF_FLASH_NO') : 
        this.translateService.instant('EVENTELEM.EXIF_FLASH_YES');
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_FLASH'),
        value: flashValue
      });
    }
    
    // Software
    if (exifData.Software) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_SOFTWARE'),
        value: exifData.Software
      });
    }
    
    // Orientation
    if (exifData.Orientation) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_ORIENTATION'),
        value: exifData.Orientation.toString()
      });
    }
    
    // GPS Info
    if (Array.isArray(exifData.GPSLatitude) && Array.isArray(exifData.GPSLongitude)) {
      const lat = this.convertDMSToDD(exifData.GPSLatitude, exifData.GPSLatitudeRef);
      const lon = this.convertDMSToDD(exifData.GPSLongitude, exifData.GPSLongitudeRef);
      const gpsLabel = this.translateService.instant('EVENTELEM.EXIF_GPS');
      const gpsValue = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      
      if (!targetArray.some(item => item.label === gpsLabel)) {
        targetArray.push({
          label: gpsLabel,
          value: gpsValue
        });
      }
      
      if (imageUrlToUse) {
        this.setImageLocation(imageUrlToUse, lat, lon);
      }
    }
    
    // GPS Altitude
    if (exifData.GPSAltitude !== undefined && exifData.GPSAltitude !== null) {
      const altitudeLabel = this.translateService.instant('EVENTELEM.EXIF_ALTITUDE');
      // GPSAltitude is typically stored as a rational number (numerator/denominator)
      // If it's already a number, use it directly; otherwise convert from rational
      let altitudeMeters: number;
      if (typeof exifData.GPSAltitude === 'number') {
        altitudeMeters = exifData.GPSAltitude;
      } else if (Array.isArray(exifData.GPSAltitude) && exifData.GPSAltitude.length >= 2) {
        // Rational number format: [numerator, denominator]
        altitudeMeters = exifData.GPSAltitude[0] / exifData.GPSAltitude[1];
      } else {
        altitudeMeters = parseFloat(exifData.GPSAltitude);
      }
      
      // GPSAltitudeRef: 0 = above sea level, 1 = below sea level
      const isBelowSeaLevel = exifData.GPSAltitudeRef === 1;
      const altitudeValue = isBelowSeaLevel 
        ? `-${altitudeMeters.toFixed(2)} m`
        : `${altitudeMeters.toFixed(2)} m`;
      
      if (!targetArray.some(item => item.label === altitudeLabel)) {
        targetArray.push({
          label: altitudeLabel,
          value: altitudeValue
        });
      }
    }
    
    // EXIF dimensions (if different from image dimensions)
    if (exifData.PixelXDimension) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_PIXEL_WIDTH'),
        value: `${exifData.PixelXDimension} px`
      });
    }
    if (exifData.PixelYDimension) {
      targetArray.push({
        label: this.translateService.instant('EVENTELEM.EXIF_PIXEL_HEIGHT'),
        value: `${exifData.PixelYDimension} px`
      });
    }

    // Original size (before compression) - multiple fallbacks:
    // 1) PAT values embedded in EXIF UserComment (backend may inject)
    // 2) Metadata captured from response headers for the current URL
    // 3) Filesystem variants cache: if current image is a compressed filesystem variant,
    //    read size from the stored original variant metadata
    const originalSizeLabel = this.translateService.instant('EVENTELEM.EXIF_ORIGINAL_FILE_SIZE');
    let originalSizeValue = this.getOriginalSizeFromPatMetadata(exifData.UserComment, imageUrlToUse);
    
    if (!originalSizeValue && imageUrlToUse) {
      // Try reading from filesystem variants cache (covers compressed photos)
      const imageIndex = this.imageUrlToThumbnailIndex.get(imageUrlToUse);
      if (imageIndex !== undefined) {
        const variants = this.filesystemImageVariants.get(imageIndex);
        if (variants && variants.originalMetadata) {
          const formatted = this.formatPatMetadata(variants.originalMetadata);
          if (formatted) {
            originalSizeValue = formatted;
          }
        }
      }
    }
    
    if (originalSizeValue && !targetArray.some(item => item.label === originalSizeLabel)) {
      targetArray.push({
        label: originalSizeLabel,
        value: originalSizeValue
      });
    }
    
  }
  
  private setImageLocation(imageUrl: string, lat: number, lng: number): void {
    if (!imageUrl) {
      return;
    }
    
    const location = { lat, lng };
    this.imageLocations.set(imageUrl, location);
    
    if (!this.mapUrlCache.has(imageUrl)) {
      this.mapUrlCache.set(imageUrl, this.buildMapUrl(lat, lng));
    }
    
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (currentImageUrl && currentImageUrl === imageUrl) {
      // Use setTimeout to avoid ExpressionChangedAfterItHasBeenCheckedError
      setTimeout(() => {
        this.currentImageLocation = { ...location };
        this.currentMapUrl = this.mapUrlCache.get(imageUrl) || null;
        this.cdr.markForCheck();
      }, 0);
    }
  }
  
  private buildMapUrl(lat: number, lng: number, zoom: number = 15): SafeResourceUrl {
    const url = `https://www.google.com/maps?q=${lat},${lng}&z=${zoom}&output=embed`;
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }
  
  private updateCurrentImageLocation(): void {
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (currentImageUrl && this.imageLocations.has(currentImageUrl)) {
      const location = this.imageLocations.get(currentImageUrl)!;
      this.currentImageLocation = { ...location };
      if (!this.mapUrlCache.has(currentImageUrl)) {
        this.mapUrlCache.set(currentImageUrl, this.buildMapUrl(location.lat, location.lng));
      }
      this.currentMapUrl = this.mapUrlCache.get(currentImageUrl) || null;
    } else {
      this.currentImageLocation = null;
      this.currentMapUrl = null;
      if (this.showMapView) {
        this.showMapView = false;
      }
    }
    // Mark for change detection to avoid ExpressionChangedAfterItHasBeenCheckedError
    this.cdr.markForCheck();
  }
  
  private convertDMSToDD(dms: number[], ref: string): number {
    let dd = dms[0] + dms[1] / 60 + dms[2] / (60 * 60);
    if (ref === 'S' || ref === 'W') {
      dd = dd * -1;
    }
    return dd;
  }
  
  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  private parsePatMetadataFromHeaders(headers: HttpHeaders | null | undefined): PatMetadata | undefined {
    if (!headers) {
      return undefined;
    }

    const metadata: PatMetadata = {};

    const originalSizeHeader = headers.get('X-Pat-Image-Size-Before');
    if (originalSizeHeader) {
      const parsed = parseInt(originalSizeHeader, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        metadata.originalSizeBytes = parsed;
        metadata.originalSizeKilobytes = Math.max(1, Math.round(parsed / 1024));
      }
    }

    const patHeader = headers.get('X-Pat-Exif');
    if (patHeader) {
      const values = this.extractPatValuesFromString(patHeader);
      if (values.bytes) {
        metadata.originalSizeBytes = values.bytes;
      }
      if (values.kb) {
        metadata.originalSizeKilobytes = values.kb;
      }
      metadata.rawHeaderValue = patHeader;
    }

    if (metadata.originalSizeBytes || metadata.originalSizeKilobytes) {
      return metadata;
    }
    return undefined;
  }

  private extractPatValuesFromString(source: string): { bytes?: number; kb?: number } {
    if (!source) {
      return {};
    }
    const result: { bytes?: number; kb?: number } = {};
    const bytesMatch = source.match(/PatOriginalFileSizeBytes=(\d+)/i);
    const kbMatch = source.match(/PatOriginalFileSizeKB=(\d+)/i);

    if (bytesMatch) {
      const parsed = parseInt(bytesMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.bytes = parsed;
      }
    }
    if (kbMatch) {
      const parsed = parseInt(kbMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.kb = parsed;
      }
    }
    return result;
  }

  private formatPatMetadata(metadata?: PatMetadata): string | null {
    if (!metadata) {
      return null;
    }

    const bytesValue = metadata.originalSizeBytes || (metadata.originalSizeKilobytes ? metadata.originalSizeKilobytes * 1024 : undefined);
    if (!bytesValue || !Number.isFinite(bytesValue) || bytesValue <= 0) {
      return null;
    }

    const locale = this.translateService?.currentLang || undefined;
    const readableSize = this.formatFileSize(bytesValue);
    const details: string[] = [`${bytesValue.toLocaleString(locale as string | undefined)} B`];

    if (metadata.originalSizeKilobytes && Number.isFinite(metadata.originalSizeKilobytes) && metadata.originalSizeKilobytes > 0) {
      details.push(`${metadata.originalSizeKilobytes.toLocaleString(locale as string | undefined)} KB`);
    }

    return `${readableSize} (${details.join(' · ')})`;
  }

  private getOriginalSizeFromPatMetadata(userComment: any, imageUrl?: string): string | null {
    const normalizedComment = this.normalizeUserComment(userComment);
    if (normalizedComment) {
      const values = this.extractPatValuesFromString(normalizedComment);
      let bytesValue = values.bytes;
      if ((!bytesValue || bytesValue <= 0) && values.kb && values.kb > 0) {
        bytesValue = values.kb * 1024;
      }
      if (bytesValue && bytesValue > 0) {
        return this.formatPatMetadata({ originalSizeBytes: bytesValue, originalSizeKilobytes: values.kb });
      }
    }

    if (imageUrl) {
      const storedMetadata = this.imagePatMetadata.get(imageUrl);
      const formatted = this.formatPatMetadata(storedMetadata);
      if (formatted) {
        return formatted;
      }
    }

    return null;
  }

  private normalizeUserComment(userComment: any): string | null {
    if (!userComment) {
      return null;
    }

    let rawValue: string | null = null;

    if (typeof userComment === 'string') {
      rawValue = userComment;
    } else if (Array.isArray(userComment)) {
      try {
        rawValue = String.fromCharCode(...userComment);
      } catch {
        rawValue = null;
      }
    } else if (userComment instanceof Uint8Array) {
      try {
        rawValue = new TextDecoder('utf-8').decode(userComment);
      } catch {
        rawValue = null;
      }
    } else if (typeof userComment === 'object' && userComment !== null && typeof userComment.toString === 'function') {
      rawValue = userComment.toString();
    }

    if (!rawValue) {
      return null;
    }

    rawValue = rawValue.replace(/\u0000/g, '').trim();

    if (rawValue.startsWith('ASCII')) {
      rawValue = rawValue.substring(5).replace(/^\u0000+/, '');
    } else if (rawValue.startsWith('UNICODE')) {
      rawValue = rawValue.substring(7).replace(/^\u0000+/, '');
    }

    rawValue = rawValue.trim();
    return rawValue.length > 0 ? rawValue : null;
  }
  
  // Check if a specific thumbnail is loading (by slideshow index)
  public isThumbnailLoading(slideshowIndex: number): boolean {
    // Convert slideshow index to image index
    const imageIndex = this.slideshowIndexToImageIndex.get(slideshowIndex);
    if (imageIndex === undefined) {
      return false;
    }
    // Check if this image index is loading
    return this.loadingThumbnailImageIndices.has(imageIndex);
  }
  
  // Handle thumbnail click - change to that image
  public onThumbnailClick(index: number): void {
    if (index >= 0 && index < this.slideshowImages.length) {
      this.currentSlideshowIndex = index;
      this.updateCurrentSlideshowImageUrl();
      this.updateCurrentImageLocation();
      // Scroll to center active thumbnail (with delay to ensure DOM update)
      setTimeout(() => {
        this.scrollToActiveThumbnail();
      }, 50);
      this.resetSlideshowZoom();
      this.updateContainerDimensions();
      setTimeout(() => {
        this.updateImageDimensions();
        this.updateContainerDimensions();
        if (this.showInfoPanel) {
          // Delay EXIF reload slightly to allow the new image to render
          setTimeout(() => this.loadExifDataForInfoPanel(), 50);
        }
      }, 100);
    }
  }
  
  // Handle mouse wheel on thumbnails strip to scroll horizontally
  public onThumbnailsWheel(event: WheelEvent): void {
    // Prevent default scrolling behavior immediately
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    
    // Get the thumbnails strip container
    let scrollableContainer: HTMLElement | null = null;
    
    if (this.thumbnailsStripRef && this.thumbnailsStripRef.nativeElement) {
      scrollableContainer = this.thumbnailsStripRef.nativeElement;
    } else {
      // Fallback: query DOM directly
      scrollableContainer = document.querySelector('.thumbnails-strip') as HTMLElement;
    }
    
    if (!scrollableContainer) {
      return;
    }
    
    // Get current scroll position
    const currentScroll = scrollableContainer.scrollLeft;
    
    // Calculate scroll delta (use deltaY for vertical wheel, deltaX for horizontal wheel)
    // Use deltaY for vertical wheel movement, convert to horizontal scroll
    const scrollDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    
    // Adjust scroll speed based on delta mode
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages
    // Multiply by speed factor to make scrolling faster (2.5x for more responsive scrolling)
    const scrollSpeedFactor = 2.5;
    let scrollAmount = 0;
    if (event.deltaMode === 0) {
      // Pixels mode - use delta directly (deltaY is already in pixels), then multiply by speed factor
      scrollAmount = scrollDelta * scrollSpeedFactor;
    } else if (event.deltaMode === 1) {
      // Lines mode - convert to pixels (typically ~20px per line), then multiply by speed factor
      scrollAmount = scrollDelta * 20 * scrollSpeedFactor;
    } else {
      // Pages mode - use container width (already large, keep original)
      scrollAmount = scrollDelta > 0 ? scrollableContainer.clientWidth * 0.8 : -scrollableContainer.clientWidth * 0.8;
    }
    
    // Calculate new scroll position
    const newScroll = currentScroll + scrollAmount; // Inversé : ajouter au lieu de soustraire pour inverser le sens
    
    // Clamp scroll position to valid range
    const maxScroll = scrollableContainer.scrollWidth - scrollableContainer.clientWidth;
    const clampedScroll = Math.max(0, Math.min(newScroll, maxScroll));
    
    // Apply scroll with smooth behavior
    scrollableContainer.scrollTo({
      left: clampedScroll,
      behavior: 'auto' // Use 'auto' for instant scroll on wheel, not 'smooth'
    });
  }
  
  // Setup thumbnails wheel event listener programmatically (with explicit non-passive handling)
  private setupThumbnailsWheelListener(): void {
    // Remove existing listeners
    this.removeThumbnailsWheelListener();
    this.removeModalBodyWheelListener();
    
    // Use setTimeout to ensure the thumbnails strip element is available in the DOM
    setTimeout(() => {
      // First, setup listener on modal body to block ALL wheel events from propagating to background
      const modalBody = document.querySelector('.slideshow-body');
      if (modalBody && !this.modalBodyWheelHandler) {
        this.modalBodyWheelHandler = (event: Event) => {
          const wheelEvent = event as WheelEvent;
          // Check if event is over thumbnails strip
          if (this.thumbnailsStripRef && this.thumbnailsStripRef.nativeElement) {
            const containerRect = this.thumbnailsStripRef.nativeElement.getBoundingClientRect();
            const isOverThumbnails = wheelEvent.clientX >= containerRect.left && 
                                     wheelEvent.clientX <= containerRect.right &&
                                     wheelEvent.clientY >= containerRect.top && 
                                     wheelEvent.clientY <= containerRect.bottom;
            
            if (isOverThumbnails) {
              // Let thumbnails handler take care of it, but prevent default on modal body level too
              wheelEvent.preventDefault();
              wheelEvent.stopPropagation();
              return;
            }
          }
          
          // For all other wheel events in modal, prevent default to stop background scrolling
          // BUT allow vertical scrolling if needed (only block if over image area)
          if (this.slideshowContainerRef && this.slideshowContainerRef.nativeElement) {
            const containerRect = this.slideshowContainerRef.nativeElement.getBoundingClientRect();
            const isOverImage = wheelEvent.clientX >= containerRect.left && 
                               wheelEvent.clientX <= containerRect.right &&
                               wheelEvent.clientY >= containerRect.top && 
                               wheelEvent.clientY <= containerRect.bottom;
            if (isOverImage) {
              // Over image area - prevent default to stop background scrolling
              // BUT do NOT stop propagation - let the image wheel handler receive the event
              // The image wheel handler will handle zoom
              wheelEvent.preventDefault();
              // Ne PAS faire stopPropagation() ici pour permettre au handler de l'image de recevoir l'événement
            }
          }
        };
        modalBody.addEventListener('wheel', this.modalBodyWheelHandler as EventListener, { passive: false, capture: true });
      }
      
      // Then setup listener on thumbnails strip itself
      if (this.thumbnailsStripRef && this.thumbnailsStripRef.nativeElement) {
        const element = this.thumbnailsStripRef.nativeElement;
        
        // Create handler that wraps the method call
        // IMPORTANT: Call preventDefault and stopPropagation IMMEDIATELY to prevent background scrolling
        this.thumbnailsWheelHandler = (event: WheelEvent) => {
          // Always prevent default and stop propagation for thumbnails wheel events
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          
          // Then call the actual handler
          this.onThumbnailsWheel(event);
        };
        
        // Add event listener with capture: true to catch events early in capture phase
        // This ensures we prevent default BEFORE other listeners can handle the event
        // Using { passive: false, capture: true } to be explicit about the behavior
        element.addEventListener('wheel', this.thumbnailsWheelHandler, { passive: false, capture: true });
      }
    }, 100);
  }
  
  // Remove thumbnails wheel event listener
  private removeThumbnailsWheelListener(): void {
    if (this.thumbnailsWheelHandler && this.thumbnailsStripRef && this.thumbnailsStripRef.nativeElement) {
      // Must use same options (capture: true) when removing
      this.thumbnailsStripRef.nativeElement.removeEventListener('wheel', this.thumbnailsWheelHandler, { capture: true });
      this.thumbnailsWheelHandler = undefined;
    }
  }
  
  // Remove modal body wheel event listener
  private removeModalBodyWheelListener(): void {
    if (this.modalBodyWheelHandler) {
      const modalBody = document.querySelector('.slideshow-body');
      if (modalBody) {
        modalBody.removeEventListener('wheel', this.modalBodyWheelHandler as EventListener, { capture: true });
      }
      this.modalBodyWheelHandler = undefined;
    }
  }
  
  // Setup thumbnails wheel listener with passive: false to ensure preventDefault works
  private setupThumbnailsWheelListenerRenderer(): void {
    // Remove existing listener if any
    this.removeThumbnailsWheelListener();
    
    // Use setTimeout to ensure the thumbnails strip element is available in the DOM
    setTimeout(() => {
      if (this.thumbnailsStripRef && this.thumbnailsStripRef.nativeElement) {
        const element = this.thumbnailsStripRef.nativeElement;
        
        // Create handler that wraps the method call
        this.thumbnailsWheelHandler = (event: WheelEvent) => {
          // Prevent default scrolling behavior immediately
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          // Then call the actual handler
          this.onThumbnailsWheel(event);
        };
        
        // Use addEventListener directly with passive: false to ensure preventDefault works
        element.addEventListener('wheel', this.thumbnailsWheelHandler, { passive: false, capture: true });
      }
    }, 0);
  }
  
  // Setup programmatic event listeners to suppress passive event warnings
  private setupProgrammaticEventListeners(): void {
    // Use setTimeout to ensure ViewChild references are available
    setTimeout(() => {
      // Setup touch event listeners on slideshow container
      if (this.slideshowContainerRef && this.slideshowContainerRef.nativeElement) {
        const container = this.slideshowContainerRef.nativeElement;
        
        // Remove existing handlers if they exist (handles element recreation)
        if (this.slideshowTouchStartHandler) {
          container.removeEventListener('touchstart', this.slideshowTouchStartHandler);
        }
        if (this.slideshowTouchMoveHandler) {
          container.removeEventListener('touchmove', this.slideshowTouchMoveHandler);
        }
        
        // Touch start handler
        this.slideshowTouchStartHandler = (event: TouchEvent) => {
          this.onSlideshowTouchStart(event);
        };
        container.addEventListener('touchstart', this.slideshowTouchStartHandler, { passive: false });
        
        // Touch move handler - traiter directement sans ngZone.run pour meilleure performance
        // Les valeurs seront mises à jour et Angular les détectera automatiquement
        this.slideshowTouchMoveHandler = (event: TouchEvent) => {
          this.onSlideshowTouchMove(event);
        };
        container.addEventListener('touchmove', this.slideshowTouchMoveHandler, { passive: false });
      }
      
      // Setup wheel event listener on slideshow image
      if (this.slideshowImgElRef && this.slideshowImgElRef.nativeElement) {
        const imgElement = this.slideshowImgElRef.nativeElement;
        
        // Remove existing handler if it exists (handles element recreation)
        if (this.slideshowWheelHandler) {
          imgElement.removeEventListener('wheel', this.slideshowWheelHandler);
        }
        
        this.slideshowWheelHandler = (event: WheelEvent) => {
          this.onWheelSlideshow(event);
        };
        imgElement.addEventListener('wheel', this.slideshowWheelHandler, { passive: false });
      }
    }, 0);
  }
  
  // Remove programmatic event listeners
  private removeProgrammaticEventListeners(): void {
    // Remove touch event listeners
    if (this.slideshowContainerRef && this.slideshowContainerRef.nativeElement) {
      const container = this.slideshowContainerRef.nativeElement;
      
      if (this.slideshowTouchStartHandler) {
        container.removeEventListener('touchstart', this.slideshowTouchStartHandler);
        this.slideshowTouchStartHandler = undefined;
      }
      
      if (this.slideshowTouchMoveHandler) {
        container.removeEventListener('touchmove', this.slideshowTouchMoveHandler);
        this.slideshowTouchMoveHandler = undefined;
      }
    }
    
    // Remove wheel event listener
    if (this.slideshowImgElRef && this.slideshowImgElRef.nativeElement) {
      const imgElement = this.slideshowImgElRef.nativeElement;
      
      if (this.slideshowWheelHandler) {
        imgElement.removeEventListener('wheel', this.slideshowWheelHandler);
        this.slideshowWheelHandler = undefined;
      }
    }
  }
  
  // Scroll thumbnail container to center the active thumbnail
  private scrollToActiveThumbnail(): void {
    // Use setTimeout to ensure DOM is updated and ViewChild is available
    setTimeout(() => {
      // Try ViewChild first, then fallback to DOM query
      let scrollableContainer: HTMLElement | null = null;
      let thumbnailsContainer: HTMLElement | null = null;
      
      if (this.thumbnailsStripRef && this.thumbnailsStripRef.nativeElement) {
        scrollableContainer = this.thumbnailsStripRef.nativeElement;
        thumbnailsContainer = scrollableContainer.querySelector('.thumbnails-container');
      } else {
        // Fallback: query DOM directly
        const thumbnailsStrip = document.querySelector('.thumbnails-strip') as HTMLElement;
        if (thumbnailsStrip) {
          scrollableContainer = thumbnailsStrip;
          thumbnailsContainer = thumbnailsStrip.querySelector('.thumbnails-container') as HTMLElement;
        }
      }
      
      if (!scrollableContainer || !thumbnailsContainer) {
        // Retry after a longer delay if container not found
        setTimeout(() => this.scrollToActiveThumbnail(), 100);
        return;
      }
      
      const thumbnailItems = thumbnailsContainer.querySelectorAll('.thumbnail-item');
      
      if (thumbnailItems.length === 0 || this.currentSlideshowIndex < 0 || this.currentSlideshowIndex >= thumbnailItems.length) {
        return;
      }
      
      const activeThumbnail = thumbnailItems[this.currentSlideshowIndex] as HTMLElement;
      if (!activeThumbnail) {
        return;
      }
      
      // Get scrollable container dimensions (the one with overflow-x: auto)
      const scrollableWidth = scrollableContainer.clientWidth;
      const scrollableScrollWidth = scrollableContainer.scrollWidth;
      
      // Get thumbnail position - offsetLeft is relative to thumbnails-container
      // But we need position relative to scrollable container (thumbnails-strip)
      // Get the position of thumbnails-container relative to scrollable container
      const containerRect = scrollableContainer.getBoundingClientRect();
      const thumbnailsContainerRect = thumbnailsContainer.getBoundingClientRect();
      const activeThumbnailRect = activeThumbnail.getBoundingClientRect();
      
      // Calculate thumbnail position relative to scrollable container
      const thumbnailLeftRelativeToScrollable = activeThumbnailRect.left - containerRect.left + scrollableContainer.scrollLeft;
      const thumbnailWidth = activeThumbnail.offsetWidth;
      
      // Calculate scroll position to center the active thumbnail
      // Center = thumbnail center - scrollable container center
      const thumbnailCenter = thumbnailLeftRelativeToScrollable + (thumbnailWidth / 2);
      const scrollableCenter = scrollableWidth / 2;
      const scrollLeft = thumbnailCenter - scrollableCenter;
      
      // Clamp scroll position to valid range
      const maxScroll = Math.max(0, scrollableScrollWidth - scrollableWidth);
      const clampedScroll = Math.max(0, Math.min(scrollLeft, maxScroll));
      
      // Only scroll if content is wider than container
      if (scrollableScrollWidth > scrollableWidth) {
        // Smooth scroll to center (scroll on the scrollable container, not the inner container)
        // Use both scrollTo and scrollLeft for better browser compatibility
        if (scrollableContainer.scrollTo) {
          scrollableContainer.scrollTo({
            left: clampedScroll,
            behavior: 'smooth'
          });
        } else {
          // Fallback for older browsers
          scrollableContainer.scrollLeft = clampedScroll;
        }
      }
    }, 100); // Delay to ensure DOM is updated
  }
  
  // Get thumbnail URL for an index (index is in slideshowImages array)
  public getThumbnailUrl(slideshowIndex: number): string {
    // Get the corresponding image index in this.images
    const imageIndex = this.slideshowIndexToImageIndex.get(slideshowIndex);
    if (imageIndex !== undefined && imageIndex >= 0 && imageIndex < this.thumbnails.length && this.thumbnails[imageIndex]) {
      return this.thumbnails[imageIndex];
    }
    return ''; // Return empty string if no thumbnail
  }
  
  // Check if thumbnail is current image
  public isCurrentThumbnail(index: number): boolean {
    return index === this.currentSlideshowIndex;
  }
  
  // Handle thumbnail image error
  public onThumbnailError(event: Event): void {
    const target = event.target as HTMLElement;
    if (target) {
      target.style.display = 'none';
    }
  }

  // Detect image MIME type from ArrayBuffer data
  private detectImageMimeTypeFromFileName(fileName: string): string {
    if (!fileName) {
      return 'image/jpeg';
    }
    
    const ext = fileName.toLowerCase().split('.').pop();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'bmp':
        return 'image/bmp';
      case 'svg':
        return 'image/svg+xml';
      default:
        return 'image/jpeg';
    }
  }
  
  private detectImageMimeType(data: ArrayBuffer | Blob | any): string {
    // If it's already a Blob with a type, use it
    if (data instanceof Blob && data.type && data.type.startsWith('image/')) {
      return data.type;
    }
    
    // Try to detect from magic bytes (first few bytes of the file)
    try {
      const arrayBuffer = data instanceof ArrayBuffer ? data : (data instanceof Blob ? null : data);
      if (arrayBuffer && arrayBuffer.byteLength >= 4) {
        const uint8Array = new Uint8Array(arrayBuffer, 0, 4);
        
        // JPEG: FF D8 FF
        if (uint8Array[0] === 0xFF && uint8Array[1] === 0xD8 && uint8Array[2] === 0xFF) {
          return 'image/jpeg';
        }
        
        // PNG: 89 50 4E 47
        if (uint8Array[0] === 0x89 && uint8Array[1] === 0x50 && uint8Array[2] === 0x4E && uint8Array[3] === 0x47) {
          return 'image/png';
        }
        
        // GIF: 47 49 46 38
        if (uint8Array[0] === 0x47 && uint8Array[1] === 0x49 && uint8Array[2] === 0x46 && uint8Array[3] === 0x38) {
          return 'image/gif';
        }
        
        // WebP: RIFF ... WEBP
        if (uint8Array.length >= 12) {
          const header = String.fromCharCode.apply(null, Array.from(uint8Array.slice(0, 12)));
          if (header.startsWith('RIFF') && header.includes('WEBP')) {
            return 'image/webp';
          }
        }
      }
    } catch (error) {
      // Ignore MIME type detection errors
    }
    
    // Default to JPEG as it's the most common format for photos with EXIF
    return 'image/jpeg';
  }
  
  // Block page scrolling - DISABLED: No longer blocking scroll
  private blockPageScroll(): void {
    // Scroll blocking removed - allow scrolling in both normal and mobile mode
    // Do nothing
  }
  
  // Setup observer to prevent Bootstrap from blocking scroll
  private setupScrollUnblockObserver(): void {
    this.removeScrollUnblockObserver();
    
    this.scrollUnblockObserver = new MutationObserver(() => {
      // If Bootstrap adds modal-open class or overflow:hidden, remove it immediately
      if (document.body && document.body.classList.contains('modal-open')) {
        // Don't remove the class if modal is actually open, but ensure overflow is not hidden
        if (document.body.style.overflow === 'hidden') {
          document.body.style.setProperty('overflow', 'auto', 'important');
        }
        if (document.body.style.overflowY === 'hidden') {
          document.body.style.setProperty('overflow-y', 'auto', 'important');
        }
      }
      
      // Also check documentElement
      if (document.documentElement.style.overflow === 'hidden') {
        document.documentElement.style.setProperty('overflow', 'auto', 'important');
      }
      if (document.documentElement.style.overflowY === 'hidden') {
        document.documentElement.style.setProperty('overflow-y', 'auto', 'important');
      }
    });
    
    // Observe body and html for attribute and style changes
    if (document.body) {
      this.scrollUnblockObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        subtree: false
      });
    }
    if (document.documentElement) {
      this.scrollUnblockObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        subtree: false
      });
    }
  }
  
  // Remove the scroll unblock observer
  private removeScrollUnblockObserver(): void {
    if (this.scrollUnblockObserver) {
      this.scrollUnblockObserver.disconnect();
      this.scrollUnblockObserver = undefined;
    }
  }
  
  // Save scroll position - simple save, no DOM manipulation
  private lockScrollPosition(): void {
    // Reset restore flag when opening modal
    this.scrollRestoreAttempted = false;
    
    // Save scroll position BEFORE any modal operations
    // On mobile, prefer pageYOffset and documentElement.scrollTop (more reliable)
    const isMobile = this.isMobileDevice();
    if (isMobile) {
      // Mobile: use multiple fallbacks as different browsers report scroll differently
      this.savedScrollPosition = window.pageYOffset || 
                                 document.documentElement.scrollTop || 
                                 document.body.scrollTop || 
                                 window.scrollY || 0;
    } else {
      // Desktop: standard order
      this.savedScrollPosition = window.scrollY || window.pageYOffset || 
                                 document.documentElement.scrollTop || 
                                 document.body.scrollTop || 0;
    }
    
    // Reset saved element data
    this.savedElementId = null;
    this.savedElementRect = null;
    
    // Also try to find and save the card element position
    // Look for the card-wrapper that's currently in viewport center or near scroll position
    const viewportCenter = window.innerHeight / 2;
    const scrollY = this.savedScrollPosition;
    const viewportTop = scrollY;
    const viewportBottom = scrollY + window.innerHeight;
    
    // Find card-wrapper elements - also try element-evenement if card-wrapper not found
    const cardSelectors = ['.card-wrapper', 'element-evenement', '[class*="card"]'];
    let closestCard: HTMLElement | null = null;
    let closestDistance = Infinity;
    
    for (const selector of cardSelectors) {
      const cards = document.querySelectorAll(selector);
      cards.forEach((card) => {
        const htmlCard = card as HTMLElement;
        if (!htmlCard) return;
        
        const rect = htmlCard.getBoundingClientRect();
        const cardTop = rect.top + scrollY;
        const cardCenter = cardTop + (rect.height / 2);
        
        // Check if card is in viewport or close to it
        const cardInViewport = rect.top >= 0 && rect.top <= window.innerHeight;
        const cardNearViewport = rect.top >= -100 && rect.top <= window.innerHeight + 100;
        
        if (cardInViewport || cardNearViewport) {
          const distance = Math.abs(rect.top - (viewportCenter - scrollY));
          if (distance < closestDistance) {
            closestDistance = distance;
            closestCard = htmlCard;
          }
        }
      });
      
      // If we found a card, stop searching
      if (closestCard) break;
    }
    
    // Save the closest card element and its position relative to viewport
    if (closestCard) {
      const cardElement = closestCard as HTMLElement;
      const rect = cardElement.getBoundingClientRect();
      
      // Save element position relative to viewport (this is more reliable than absolute position)
      this.savedElementRect = {
        top: rect.top,
        left: rect.left
      };
      
      // Save element ID for later retrieval
      if (!cardElement.id) {
        this.savedElementId = `scroll-restore-${Date.now()}`;
        cardElement.id = this.savedElementId;
      } else {
        this.savedElementId = cardElement.id;
      }
    }
  }
  
  // Restore scroll position - single smooth restore after Bootstrap cleanup
  private unlockScrollPosition(): void {
    // Prevent multiple restore attempts
    if (this.scrollRestoreAttempted) {
      return;
    }
    
    // Mark as attempted immediately to prevent any duplicate calls
    this.scrollRestoreAttempted = true;
    
    const scrollY = this.savedScrollPosition;
    const savedElementId = this.savedElementId;
    const savedElementRect = this.savedElementRect;
    
    // Single restore function - execute once after DOM is stable
    const performRestore = () => {
      const isMobile = this.isMobileDevice();
      
      // Get current scroll position (different order for mobile)
      const getCurrentScrollY = () => {
        if (isMobile) {
          return window.pageYOffset || 
                 document.documentElement.scrollTop || 
                 document.body.scrollTop || 
                 window.scrollY || 0;
        } else {
          return window.scrollY || window.pageYOffset || 
                 document.documentElement.scrollTop || 
                 document.body.scrollTop || 0;
        }
      };
      
      // Try to scroll to saved element first (more reliable)
      if (savedElementId && savedElementRect) {
        const element = document.getElementById(savedElementId);
        if (element) {
          // Get current element position relative to document
          const currentRect = element.getBoundingClientRect();
          const currentScrollY = getCurrentScrollY();
          
          // Calculate target scroll position to restore the element to its original viewport position
          const targetScrollY = currentScrollY + currentRect.top - savedElementRect.top;
          
          // Apply scroll directly in a single operation (no multiple calls)
          // Use scrollTo as the primary method (single call, most reliable)
          const finalScrollY = Math.max(0, targetScrollY);
          
          // On mobile, also set scrollTop directly as fallback
          if (isMobile) {
            document.documentElement.scrollTop = finalScrollY;
            document.body.scrollTop = finalScrollY;
          }
          
          window.scrollTo({
            top: finalScrollY,
            left: 0,
            behavior: 'auto'
          });
          
          return;
        }
      }
      
      // Fallback: restore to saved scroll position
      const finalScrollY = Math.max(0, scrollY);
      
      // On mobile, also set scrollTop directly as fallback
      if (isMobile) {
        document.documentElement.scrollTop = finalScrollY;
        document.body.scrollTop = finalScrollY;
      }
      
      window.scrollTo({
        top: finalScrollY,
        left: 0,
        behavior: 'auto'
      });
    };
    
    // Wait for Bootstrap cleanup to complete, then restore in single operation
    // Use a simple delay instead of recursive checks to avoid multiple restores
    const checkAndRestore = () => {
      const isModalOpen = document.body && document.body.classList.contains('modal-open');
      const hasBackdrop = document.querySelector('.modal-backdrop') !== null;
      
      if (isModalOpen || hasBackdrop) {
        // Bootstrap still cleaning up, wait one more frame
        requestAnimationFrame(checkAndRestore);
      } else {
        // Bootstrap cleanup complete, restore scroll in a single frame
        requestAnimationFrame(() => {
          requestAnimationFrame(performRestore);
        });
      }
    };
    
    // Start checking after a brief delay to let Bootstrap start cleanup
    requestAnimationFrame(() => {
      requestAnimationFrame(checkAndRestore);
    });
  }
  
  // Unblock page scrolling - Ensure no scroll blocking remains
  private unblockPageScroll(): void {
    // Single cleanup function - execute once synchronously
    if (document.body) {
      document.body.classList.remove('modal-open');
      document.body.classList.remove('slideshow-fullscreen-active');
      
      // Remove any modal backdrop that might still be present
      const backdrops = document.querySelectorAll('.modal-backdrop');
      backdrops.forEach(backdrop => {
        if (backdrop && backdrop.parentNode) {
          backdrop.parentNode.removeChild(backdrop);
        }
      });
      
      // Force remove all scroll-blocking styles with !important
      document.body.style.setProperty('overflow', 'auto', 'important');
      document.body.style.setProperty('overflow-x', 'auto', 'important');
      document.body.style.setProperty('overflow-y', 'auto', 'important');
      document.body.style.removeProperty('position');
      document.body.style.removeProperty('height');
      document.body.style.removeProperty('width');
      document.body.style.removeProperty('touch-action');
      document.body.style.removeProperty('padding-right');
      
      // On mobile, ensure touch scrolling is enabled
      if (this.isMobileDevice()) {
        document.body.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
        document.body.style.setProperty('touch-action', 'pan-y pinch-zoom', 'important');
      }
    }
    
    if (document.documentElement) {
      document.documentElement.style.setProperty('overflow', 'auto', 'important');
      document.documentElement.style.setProperty('overflow-x', 'auto', 'important');
      document.documentElement.style.setProperty('overflow-y', 'auto', 'important');
      document.documentElement.style.removeProperty('position');
      document.documentElement.style.removeProperty('height');
      document.documentElement.style.removeProperty('touch-action');
      
      // On mobile, ensure touch scrolling is enabled on documentElement too
      if (this.isMobileDevice()) {
        document.documentElement.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
        document.documentElement.style.setProperty('touch-action', 'pan-y pinch-zoom', 'important');
      }
    }
  }
}

