import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, Input, Output, EventEmitter, TemplateRef, ChangeDetectorRef } from '@angular/core';
import { HttpHeaders } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
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

interface PatMetadata {
  originalSizeBytes?: number;
  originalSizeKilobytes?: number;
  rawHeaderValue?: string;
}

@Component({
  selector: 'app-slideshow-modal',
  templateUrl: './slideshow-modal.component.html',
  styleUrls: ['./slideshow-modal.component.css']
})
export class SlideshowModalComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() images: SlideshowImageSource[] = [];
  @Input() eventName: string = '';
  @Input() loadFromFileService: boolean = false; // If true, use fileId to load images via FileService
  
  @Output() closed = new EventEmitter<void>();
  
  @ViewChild('slideshowModal') slideshowModal!: TemplateRef<any>;
  @ViewChild('slideshowContainer') slideshowContainerRef!: ElementRef;
  @ViewChild('slideshowImgEl') slideshowImgElRef!: ElementRef<HTMLImageElement>;
  @ViewChild('exifModal') exifModal!: TemplateRef<any>;
  @ViewChild('thumbnailsStrip') thumbnailsStripRef!: ElementRef<HTMLElement>;
  
  // Slideshow state
  public slideshowImages: string[] = [];
  private slideshowBlobs: Map<string, Blob> = new Map(); // Store original blobs by URL
  public currentSlideshowIndex: number = 0;
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
  
  // Double-click detection for zoom out
  private lastClickTime: number = 0;
  private clickTimeout?: any;
  
  // Rectangle selection for right-click zoom
  public isSelectingRectangle: boolean = false;
  public selectionRectX: number = 0;
  public selectionRectY: number = 0;
  public selectionRectWidth: number = 0;
  public selectionRectHeight: number = 0;
  private selectionStartX: number = 0;
  private selectionStartY: number = 0;
  private selectionMouseMoveHandler?: (event: MouseEvent) => void;
  private selectionMouseUpHandler?: (event: MouseEvent) => void;
  
  // Getters pour le template (assurer une taille minimale pour l'affichage)
  public get displaySelectionWidth(): number {
    return Math.max(1, this.selectionRectWidth);
  }
  
  public get displaySelectionHeight(): number {
    return Math.max(1, this.selectionRectHeight);
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
  
  // FS Photos download control
  private fsDownloadsActive: boolean = false;
  private fsActiveSubs: Subscription[] = [];
  private fsQueue: string[] = [];
  
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

  // Filesystem image variants tracking
  private filesystemImageVariants: Map<number, {
    compressedUrl?: string;
    originalUrl?: string;
    compressedMetadata?: PatMetadata;
    originalMetadata?: PatMetadata;
    currentVariant: 'compressed' | 'original';
  }> = new Map();
  private filesystemVariantLoading: Set<number> = new Set();
  
  constructor(
    private cdr: ChangeDetectorRef,
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
  }
  
  ngOnDestroy(): void {
    this.cleanupAllMemory();
  }
  
  // Centralized method to clean up all memory used by the slideshow
  // This method is idempotent - safe to call multiple times
  private cleanupAllMemory(): void {
    // Remove fullscreen class from body
    document.body.classList.remove('slideshow-fullscreen-active');
    
    // Remove selection listeners
    this.removeSelectionListeners();
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
  public open(images: SlideshowImageSource[], eventName: string = '', loadFromFileService: boolean = false, retryCount: number = 0): void {
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
    
    // Initialize slideshow state
    this.slideshowImages = [];
    this.slideshowBlobs.clear();
    this.exifDataCache.clear();
    this.imageFileNames.clear();
    this.currentSlideshowIndex = 0;
    this.isSlideshowActive = false;
    this.currentImageFileName = '';
    this.resetSlideshowZoom();
    this.hasSavedPosition = false;
    this.showMapView = false;
    this.currentImageLocation = null;
    this.currentMapUrl = null;
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
      
      // Setup keyboard listener after modal is opened
      setTimeout(() => {
        this.setupKeyboardListener();
        this.setupResizeListener();
        this.updateContainerDimensions();
        // Center the active thumbnail after modal is fully rendered (multiple attempts to ensure it works)
        setTimeout(() => {
          this.scrollToActiveThumbnail();
        }, 300);
        setTimeout(() => {
          this.scrollToActiveThumbnail();
        }, 600);
      }, 100);
      
      // Handle modal close event
      this.modalRef.result.then(
        () => {
          this.cleanupAllMemory();
          this.closed.emit();
        },
        () => {
          this.cleanupAllMemory();
          this.closed.emit();
        }
      );
      
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
    const slideshowIndex = this.slideshowImages.length;
    this.slideshowImages.push(objectUrl);

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

    if (this.slideshowImages.length > 1 && !this.showThumbnails && !this.userToggledThumbnails) {
      this.showThumbnails = true;
    }
    
    // Reset zoom when first image loads
    if (this.slideshowImages.length === 1) {
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
      
      // Skip if already loading or loaded
      if (this.loadingThumbnailImageIndices.has(imageIndex) || this.thumbnails[imageIndex]) {
        continue;
      }
      
      // Mark as loading
      this.loadingThumbnailImageIndices.add(imageIndex);
      this.activeThumbnailGenerations++;
      this.isLoadingThumbnails = true;
      
      // Generate thumbnail (completely independent from image loading)
      this.generateThumbnailFromBlob(blob).then(
        (thumbnailUrl) => {
          if (this.thumbnailGenerationActive) {
            this.thumbnails[imageIndex] = thumbnailUrl;
            this.loadingThumbnailImageIndices.delete(imageIndex);
            this.activeThumbnailGenerations--;
            this.cdr.detectChanges();
            // Process next in queue (non-blocking)
            setTimeout(() => {
              if (this.thumbnailGenerationActive) {
                this.processThumbnailGenerationQueue();
              }
            }, 0);
          }
        },
        (error) => {
          if (this.thumbnailGenerationActive) {
            this.thumbnails[imageIndex] = '';
            this.loadingThumbnailImageIndices.delete(imageIndex);
            this.activeThumbnailGenerations--;
            this.cdr.detectChanges();
            // Process next in queue (non-blocking)
            setTimeout(() => {
              if (this.thumbnailGenerationActive) {
                this.processThumbnailGenerationQueue();
              }
            }, 0);
          }
        }
      );
    }
    
    // Mark loading as complete if queue is empty and no active generations
    if (this.thumbnailGenerationQueue.length === 0 && this.activeThumbnailGenerations === 0) {
      this.isLoadingThumbnails = false;
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
        // Update container dimensions when fullscreen changes
        this.updateContainerDimensions();
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
  
  // Update container dimensions (called when container size changes)
  private updateContainerDimensions(): void {
    try {
      const container = this.slideshowContainerRef?.nativeElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          this.containerWidth = Math.round(rect.width);
          this.containerHeight = Math.round(rect.height);
          
          // Also update image dimensions and other info
          this.updateImageDimensions();
        }
      }
    } catch (error) {
      // Silently ignore errors
    }
  }
  
  // Handle image load event
  public onImageLoad(): void {
    // Update dimensions when image loads
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 100);
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
        // Image not loaded yet, try again later
        setTimeout(() => this.updateImageDimensions(), 100);
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
  // Zoom is calculated based on visible container viewport, not full image
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
      
      // Get the image's base display size (before any zoom transform)
      // This is what's currently visible in the container viewport
      const imgBaseWidth = imgEl.clientWidth || imgEl.naturalWidth || 1;
      const imgBaseHeight = imgEl.clientHeight || imgEl.naturalHeight || 1;
      
      // Calculate zoom needed so the visible portion of the image fits the container
      // Zoom is relative to what's visible in the container, not the full image
      const fillZoom = Math.max(cw / imgBaseWidth, ch / imgBaseHeight);
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
    event.preventDefault();
    // Use actual deltaY value for linear zoom (normalized to reasonable scale)
    const delta = event.deltaY / 20; // Normalize to make scroll speed reasonable
    
    // Dynamic step: proportionnel au niveau de zoom actuel
    // Plus le zoom est élevé, plus le pas est grand (plus rapide)
    // Formule: step = baseStep * (1 + current * multiplier)
    // Cela donne: petit pas à zoom faible, grand pas à zoom élevé
    const baseStep = 0.1; // Pas de base modéré pour petit zoom
    const multiplier = 0.2; // Multiplicateur augmenté pour progression plus rapide dès le début
    const dynamicStep = baseStep * (1 + current * multiplier);
    
    // Limiter le pas entre minStep et maxStep pour éviter des valeurs trop extrêmes
    const minStep = 0.1; // Pas minimum modéré pour petit zoom
    const maxStep = 5.0; // Augmenté encore plus pour permettre des pas très grands à zoom très élevé
    const step = Math.max(minStep, Math.min(maxStep, dynamicStep));
    
    let next = current - delta * step; // wheel up -> zoom in
    if (next < minZoom) next = minZoom;
    if (next > maxZoom) next = maxZoom;
    return parseFloat(next.toFixed(2));
  }
  
  public onWheelSlideshow(event: WheelEvent): void {
    if (this.showMapView) {
      return;
    }
    const minZoom = this.getMinSlideshowZoom();
    const oldZoom = this.slideshowZoom;
    this.slideshowZoom = this.applyWheelZoom(event, this.slideshowZoom, minZoom);
    
    // Always zoom on the center of the visible image
    if (this.slideshowZoom <= minZoom) {
      // Reset to center if at minimum zoom
      this.slideshowTranslateX = 0;
      this.slideshowTranslateY = 0;
    } else {
      // Zoom on center
      this.zoomOnCenter(this.slideshowZoom, oldZoom);
    }
    
    this.clampSlideshowTranslation();
    // Recalculate image dimensions after zoom change - use setTimeout to ensure DOM is updated
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 0);
  }
  
  public resetSlideshowZoom(): void { 
    this.slideshowZoom = Math.max(1, this.getMinSlideshowZoom()); 
    this.slideshowTranslateX = 0; 
    this.slideshowTranslateY = 0;
    // Recalculate dimensions when resetting zoom - use setTimeout to ensure DOM is updated
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 0);
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
    this.slideshowZoom = Math.max(minZoom, parseFloat((this.slideshowZoom - 0.5).toFixed(2))); 
    
    // Si on atteint le zoom minimum, recentrer l'image
    if (this.slideshowZoom <= minZoom) {
      this.slideshowTranslateX = 0;
      this.slideshowTranslateY = 0;
    } else {
      // Always zoom on the center of the visible image
      this.zoomOnCenter(this.slideshowZoom, oldZoom);
    }
    
    this.clampSlideshowTranslation();
    // Recalculate image dimensions after zoom change - use setTimeout to ensure DOM is updated
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 0);
  }
  
  // Dézoom agressif pour le double-clic
  private zoomOutSlideshowAggressive(): void {
    const minZoom = this.getMinSlideshowZoom();
    const oldZoom = this.slideshowZoom;
    
    // Dézoomer de 3.5 lors du double-clic
    this.slideshowZoom = Math.max(minZoom, parseFloat((this.slideshowZoom - 3.5).toFixed(2)));
    
    // Si on atteint le zoom minimum, recentrer l'image
    if (this.slideshowZoom <= minZoom) {
      this.slideshowTranslateX = 0;
      this.slideshowTranslateY = 0;
    } else {
      // Always zoom on the center of the visible image
      this.zoomOnCenter(this.slideshowZoom, oldZoom);
    }
    
    this.clampSlideshowTranslation();
    // Recalculate image dimensions after zoom change - use setTimeout to ensure DOM is updated
    setTimeout(() => {
      this.updateImageDimensions();
      this.updateContainerDimensions();
    }, 0);
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
    if (canDrag) { try { event.preventDefault(); event.stopPropagation(); } catch {} }
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragOrigX = this.slideshowTranslateX;
    this.dragOrigY = this.slideshowTranslateY;
  }
  
  public onSlideshowMouseMove(event: MouseEvent): void {
    if (this.showMapView) {
      return;
    }
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
            // Update container dimensions
            this.containerWidth = Math.round(rect.width);
            this.containerHeight = Math.round(rect.height);
            
            // Update image dimensions
            this.updateImageDimensions();
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
              this.containerWidth = Math.round(parentRect.width);
              this.containerHeight = Math.round(parentRect.height);
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
        
        // Force change detection
        this.cdr.detectChanges();
      }
      return;
    }
    
    if (!this.isDraggingSlideshow) return;
    try { event.preventDefault(); event.stopPropagation(); } catch {}
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    this.slideshowTranslateX = this.dragOrigX + dx;
    this.slideshowTranslateY = this.dragOrigY + dy;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.hasDraggedSlideshow = true;
    this.clampSlideshowTranslation();
    // Recalculate visible portion after dragging
    setTimeout(() => {
      this.calculateVisibleImagePortion();
    }, 0);
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
    
    this.isDraggingSlideshow = false;
  }
  
  public onSlideshowMouseLeave(): void {
    if (this.showMapView) {
      return;
    }
    // Ne pas annuler la sélection si la souris sort du container
    // (les listeners globaux continueront de capturer les événements)
    // Seulement annuler si on n'est pas en train de sélectionner
    if (!this.isSelectingRectangle) {
      this.isDraggingSlideshow = false;
    }
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
  
  public onSlideshowImageClick(): void {
    // Ignore click if it was a drag
    if (this.hasDraggedSlideshow) { 
      this.hasDraggedSlideshow = false; 
      return; 
    }
    
    const currentTime = Date.now();
    const timeSinceLastClick = currentTime - this.lastClickTime;
    
    // Si c'est un double-clic (2 clics en moins de 300ms)
    if (timeSinceLastClick < 300 && timeSinceLastClick > 0) {
      // Annuler le timeout du simple clic s'il existe
      if (this.clickTimeout) {
        clearTimeout(this.clickTimeout);
        this.clickTimeout = undefined;
      }
      
      // Dézoomer
      this.zoomOutSlideshowAggressive();
      
      // Réinitialiser le temps du dernier clic
      this.lastClickTime = 0;
    } else {
      // Premier clic ou clic après le délai
      this.lastClickTime = currentTime;
      
      // Annuler le timeout précédent s'il existe
      if (this.clickTimeout) {
        clearTimeout(this.clickTimeout);
      }
      
      // Attendre pour voir si c'est un double-clic
      this.clickTimeout = setTimeout(() => {
        // Si aucun deuxième clic n'est arrivé, ne rien faire
        this.clickTimeout = undefined;
      }, 300);
    }
  }
  
  private clampSlideshowTranslation(): void {
    try {
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
      try { touchEvent.preventDefault(); touchEvent.stopPropagation(); } catch {}
      this.isPinching = true;
      this.isDraggingSlideshow = false;
      const touch1 = touchEvent.touches[0];
      const touch2 = touchEvent.touches[1];
      this.touchStartDistance = this.getTouchDistance(touch1, touch2);
      this.touchStartZoom = this.slideshowZoom;
      this.lastTouchDistance = this.touchStartDistance;
      this.initialTouches = [touch1, touch2];
      this.pinchStartTranslateX = this.slideshowTranslateX;
      this.pinchStartTranslateY = this.slideshowTranslateY;
      
      const center = this.getTouchCenter(touch1, touch2);
      const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        this.touchStartX = center.x - rect.left;
        this.touchStartY = center.y - rect.top;
      }
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
      this.slideshowTranslateX = this.dragOrigX + dx;
      this.slideshowTranslateY = this.dragOrigY + dy;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.hasDraggedSlideshow = true;
      this.clampSlideshowTranslation();
    } else if (touchEvent.touches.length === 2 && this.isPinching) {
      try { touchEvent.preventDefault(); touchEvent.stopPropagation(); } catch {}
      const touch1 = touchEvent.touches[0];
      const touch2 = touchEvent.touches[1];
      const currentDistance = this.getTouchDistance(touch1, touch2);
      
      if (this.touchStartDistance > 0) {
        const scale = currentDistance / this.touchStartDistance;
        let newZoom = this.touchStartZoom * scale;
        
        const minZoom = this.getMinSlideshowZoom();
        const maxZoom = 100;
        newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
        
        const previousZoom = this.slideshowZoom;
        this.slideshowZoom = parseFloat(newZoom.toFixed(2));
        
        // Recalculate image dimensions immediately after zoom change
        this.updateImageDimensions();
        this.updateContainerDimensions();
        
        // Si on atteint le zoom minimum, recentrer l'image
        if (this.slideshowZoom <= minZoom) {
          this.slideshowTranslateX = 0;
          this.slideshowTranslateY = 0;
        } else if (this.slideshowZoom > minZoom) {
          const container = this.slideshowContainerRef?.nativeElement as HTMLElement;
          const imgEl = this.slideshowImgElRef?.nativeElement as HTMLImageElement;
          if (container && imgEl) {
            const rect = container.getBoundingClientRect();
            const currentPinchCenterX = (touch1.clientX + touch2.clientX) / 2 - rect.left;
            const currentPinchCenterY = (touch1.clientY + touch2.clientY) / 2 - rect.top;
            
            const initialPinchCenterX = this.touchStartX;
            const initialPinchCenterY = this.touchStartY;
            
            const zoomChange = this.slideshowZoom / this.touchStartZoom;
            
            this.slideshowTranslateX = initialPinchCenterX - (initialPinchCenterX - this.pinchStartTranslateX) * zoomChange;
            this.slideshowTranslateY = initialPinchCenterY - (initialPinchCenterY - this.pinchStartTranslateY) * zoomChange;
          }
        }
        
        this.lastTouchDistance = currentDistance;
        this.clampSlideshowTranslation();
        // Recalculate again after clamping
        this.updateImageDimensions();
      }
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
      this.isDraggingSlideshow = false;
      this.isPinching = false;
      this.initialTouches = [];
      this.touchStartDistance = 0;
      this.lastTouchDistance = 0;
      this.pinchStartTranslateX = 0;
      this.pinchStartTranslateY = 0;
    } else if (touchEvent.touches.length === 1 && this.isPinching) {
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
      const currentKeyCode = event.keyCode || (event.key === 'ArrowLeft' ? 37 : event.key === 'ArrowRight' ? 39 : 0);
      
      // Debounce: ignore if same key pressed within 50ms (to prevent double triggering)
      // Reduced from 100ms to allow faster navigation
      if (currentKeyCode === this.lastKeyCode && currentTime - this.lastKeyPressTime < 50) {
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
      } else if (event.key === 'p' || event.key === 'P' || event.keyCode === 80) {
        // P : activer/désactiver le plein écran
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 80;
        this.toggleFullscreen();
      } else if (event.key === 'g' || event.key === 'G' || event.keyCode === 71) {
        // G : afficher/masquer la grille
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 71;
        this.toggleGrid();
      } else if (event.key === 't' || event.key === 'T' || event.keyCode === 84) {
        // T : afficher/masquer les thumbnails
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 84;
        this.toggleThumbnails();
      } else if (event.key === 'e' || event.key === 'E' || event.keyCode === 69) {
        if (!this.currentImageLocation) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.lastKeyPressTime = currentTime;
        this.lastKeyCode = 69;
        this.toggleMapView();
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
      } else if (event.key === 'Escape' || event.keyCode === 27) {
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
      return '';
    }
    return this.slideshowImages[this.currentSlideshowIndex];
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
        this.filesystemVariantLoading.delete(imageIndex);
        this.cdr.detectChanges();
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
        console.error('Error loading filesystem image variant:', error);
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
    
    const slideshowContainer = document.querySelector('.slideshow-container');
    const slideshowImageWrapper = document.querySelector('.slideshow-image-wrapper');
    const imageElement = slideshowContainer || slideshowImageWrapper;
    if (!imageElement) return;
    
    if (!isCurrentlyFullscreen) {
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
  }
  
  // FS Downloads cleanup
  private cancelFsDownloads(): void {
    this.fsDownloadsActive = false;
    try { this.fsActiveSubs.forEach(s => { if (s && !s.closed) { s.unsubscribe(); } }); } catch {}
    this.fsActiveSubs = [];
    this.fsQueue = [];
  }
  
  // EXIF Info methods
  public showExifInfo(): void {
    if (!this.exifModal) {
      return;
    }
    
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (!currentImageUrl) {
      return;
    }
    
    // Get current image file name for modal title
    this.currentImageFileName = this.imageFileNames.get(currentImageUrl) || '';
    
    // Check if EXIF data is already cached
    const cachedExifData = this.exifDataCache.get(currentImageUrl);
    if (cachedExifData) {
      // Use cached data immediately
      this.exifData = cachedExifData;
      this.isLoadingExif = false;
      this.logExifDataForCurrentImage('show-exif-cache');
      
      // Open modal with cached data
      const exifModalRef = this.modalService.open(this.exifModal, {
        size: 'lg',
        centered: true,
        backdrop: 'static',
        keyboard: false,
        windowClass: 'exif-modal-tall'
      });
      return;
    }
    
    // If not cached, load it
    this.isLoadingExif = true;
    this.exifData = [];
    
    // Open modal immediately
    const exifModalRef = this.modalService.open(this.exifModal, {
      size: 'lg',
      centered: true,
      backdrop: 'static',
      keyboard: false,
      windowClass: 'exif-modal-tall'
    });
    
    // Load EXIF data (will use stored blob, no network request)
    this.loadExifData().then(() => {
      // Cache the EXIF data for future use
      if (this.exifData.length > 0) {
        this.exifDataCache.set(currentImageUrl, [...this.exifData]);
      }
      this.isLoadingExif = false;
      this.logExifDataForCurrentImage('show-exif-loaded');
    }).catch((error) => {
      this.isLoadingExif = false;
    });
  }
  
  // Toggle info panel visibility
  public toggleInfoPanel(): void {
    this.showInfoPanel = !this.showInfoPanel;
    
    // If showing the panel, load EXIF data if not already cached
    if (this.showInfoPanel) {
      this.loadExifDataForInfoPanel();
    }
  }
  
  public toggleMapView(): void {
    if (!this.currentImageLocation) {
      this.showMapView = false;
      return;
    }
    
    this.showMapView = !this.showMapView;
    
    if (this.showMapView) {
      this.isSelectingRectangle = false;
      this.isDraggingSlideshow = false;
      this.removeSelectionListeners();
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
  }
  
  public toggleThumbnails(): void {
    if (this.slideshowImages.length <= 1) {
      return;
    }
    this.userToggledThumbnails = true;
    this.showThumbnails = !this.showThumbnails;
    
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

    if (currentUrl !== newUrl) {
      this.slideshowImages[this.currentSlideshowIndex] = newUrl;
    }

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

    if (currentUrl !== newUrl) {
      if (this.imageLocations.has(currentUrl)) {
        const location = this.imageLocations.get(currentUrl)!;
        this.imageLocations.set(newUrl, { ...location });
      }
      if (this.mapUrlCache.has(currentUrl)) {
        this.mapUrlCache.set(newUrl, this.mapUrlCache.get(currentUrl)!);
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
      setTimeout(() => this.loadExifDataForInfoPanel(), 100);
    }

    this.cdr.detectChanges();
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
        title: 'Partager une image',
        text: 'Partager cette image',
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
            title: 'Partager une image',
            text: 'Partager cette image',
            url: dataUrl
          };
          
          if (!navigator.canShare || navigator.canShare(urlShareData)) {
            await navigator.share(urlShareData);
            return; // Success
          }
        } catch (error) {
          console.warn('Could not convert blob to data URL for sharing:', error);
        }
      } else {
        // For non-blob URLs, try sharing the URL directly
        const urlShareData = {
          title: 'Partager une image',
          text: 'Partager cette image',
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
      
      // Other errors - log and fallback to download
      console.error('Error sharing image:', error);
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
          console.error('Error fetching image for download:', error);
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
      console.error('Error downloading image:', error);
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
        this.isLoadingExif = false;
        this.logExifDataForCurrentImage('info-panel-cache');
      } else {
        // Load EXIF data
        this.isLoadingExif = true;
        this.exifData = [];
        this.loadExifData().then(() => {
          this.isLoadingExif = false;
          this.logExifDataForCurrentImage('info-panel-loaded');
        }).catch((error) => {
          console.error('Error loading EXIF data:', error);
          this.isLoadingExif = false;
        });
      }
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
    
    // Double-check cache (should not happen since showExifInfo checks first, but safety check)
    const cachedExifData = this.exifDataCache.get(currentImageUrl);
    if (cachedExifData) {
      // Check if file size is already in cache
      const hasFileSize = cachedExifData.some(item => 
        item.label === this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE')
      );
      
      if (hasFileSize) {
        // Cache is complete, use it
        this.exifData = cachedExifData;
        this.logExifDataForCurrentImage('load-exif-cache');
        return;
      } else {
        // Cache exists but missing file size - we'll add it below
        this.exifData = [...cachedExifData];
      }
    }
    
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
        // For blob URLs without stored blob, try to fetch the blob from the URL
        // This is allowed for blob URLs and allows us to get the file size
        try {
          const response = await fetch(currentImageUrl);
          blob = await response.blob();
        } catch (error) {
          console.warn('Blob URL found but could not fetch blob:', error);
          blob = null;
        }
      } else {
        // For regular URLs (HTTP/HTTPS), fetch if blob is not stored
        // Only fetch as last resort (should rarely happen)
        try {
          const response = await fetch(currentImageUrl);
          blob = await response.blob();
        } catch (error) {
          console.error('Error fetching image:', error);
          blob = null;
        }
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
        await this.readExifFromBlob(blob);
        
        // Update cache with complete data including file size
        if (currentImageUrl && this.exifData.length > 0) {
          this.exifDataCache.set(currentImageUrl, [...this.exifData]);
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
              console.warn('Could not fetch file size from HEAD request:', error);
            }
          }
        }
        
        // Try reading EXIF from image element as last resort (for non-blob URLs)
        if (!currentImageUrl.startsWith('blob:') && imgEl && imgEl.src) {
          await this.readExifFromImageElement(imgEl);
        }
      }
      
    } catch (error) {
      console.error('Error loading EXIF data:', error);
    }

    this.logExifDataForCurrentImage('load-exif-complete');
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

    if (typeof console.log === 'function') {
      console.log('[Slideshow EXIF]', summary);
    }

    if (this.exifData && this.exifData.length > 0) {
      if (typeof console.table === 'function') {
        console.table(
          this.exifData.map(item => ({
            label: item.label,
            value: item.value
          }))
        );
      } else if (typeof console.log === 'function') {
        this.exifData.forEach(item => {
          console.log(`${item.label}:`, item.value);
        });
      }
    } else if (typeof console.log === 'function') {
      console.log('No EXIF data available for this image.');
    }

    const metadata = this.imagePatMetadata.get(currentImageUrl);
    if (metadata && typeof console.log === 'function') {
      console.log('PAT metadata:', metadata);
    }
  }
  
  private async readExifFromBlob(blob: Blob, imageUrl?: string): Promise<void> {
    return new Promise((resolve) => {
      // Use FileReader to read blob as data URL to avoid CSP violations
      const reader = new FileReader();
      
      reader.onload = (e: any) => {
        const dataUrl = e.target.result;
        
        // Create a temporary image element to use with EXIF.js
        const img = new Image();
        
        img.onload = () => {
          try {
            EXIF.getData(img as any, () => {
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
                console.error('Error processing EXIF data:', error);
              }
              resolve();
            });
          } catch (error) {
            console.error('Error reading EXIF data:', error);
            resolve();
          }
        };
        
        img.onerror = (error) => {
          console.error('Error loading image from data URL:', error);
          resolve();
        };
        
        // Set src after setting up event handlers
        img.src = dataUrl;
      };
      
      reader.onerror = (error) => {
        console.error('Error reading blob:', error);
        resolve();
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
      // Don't set crossOrigin as it may trigger CSP checks
      const img = new Image();
      
      img.onload = () => {
        try {
          EXIF.getData(img as any, () => {
            try {
              const exifData = EXIF.getAllTags(img as any);
              this.processExifData(exifData);
            } catch (error) {
              console.error('Error processing EXIF data:', error);
            }
            resolve();
          });
        } catch (error) {
          console.error('Error reading EXIF data from blob URL:', error);
          resolve();
        }
      };
      
      img.onerror = (error) => {
        console.error('Error loading image from blob URL for EXIF reading:', error);
        resolve();
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
      
      // Create a new image with the same src for EXIF reading
      const img = new Image();
      
      img.onload = () => {
        try {
          EXIF.getData(img as any, () => {
            try {
              const exifData = EXIF.getAllTags(img as any);
              this.processExifData(exifData);
            } catch (error) {
              console.error('Error processing EXIF data:', error);
            }
            resolve();
          });
        } catch (error) {
          console.error('Error reading EXIF data from image element:', error);
          resolve();
        }
      };
      
      img.onerror = () => {
        resolve();
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
          console.error('Error processing EXIF data:', error);
        }
      });
    } catch (error) {
      console.error('Error reading EXIF data from image element:', error);
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

    const patOriginalSize = this.getOriginalSizeFromPatMetadata(exifData.UserComment, imageUrlToUse);
    if (patOriginalSize) {
      const originalSizeLabel = this.translateService.instant('EVENTELEM.EXIF_ORIGINAL_FILE_SIZE');
      if (!targetArray.some(item => item.label === originalSizeLabel)) {
        targetArray.push({
          label: originalSizeLabel,
          value: patOriginalSize
        });
      }
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
      this.currentImageLocation = { ...location };
      this.currentMapUrl = this.mapUrlCache.get(imageUrl) || null;
      if (this.showMapView) {
        this.cdr.detectChanges();
      }
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
    // Prevent default vertical scroll
    event.preventDefault();
    event.stopPropagation();
    
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
    let scrollAmount = 0;
    if (event.deltaMode === 0) {
      // Pixels mode - use delta directly (deltaY is already in pixels)
      scrollAmount = scrollDelta;
    } else if (event.deltaMode === 1) {
      // Lines mode - convert to pixels (typically ~20px per line)
      scrollAmount = scrollDelta * 20;
    } else {
      // Pages mode - use container width
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
}

