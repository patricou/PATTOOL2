import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, Input, Output, EventEmitter, TemplateRef, ChangeDetectorRef, NgZone } from '@angular/core';
import { HttpHeaders } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { FileService } from '../../services/file.service';
import { Observable, Subscription, Subject } from 'rxjs';
import { map, takeUntil, finalize } from 'rxjs/operators';

// Export interface for use in parent components
export interface VideoshowVideoSource {
  // Either provide a fileId to load from FileService, or a direct blob URL
  fileId?: string;
  blobUrl?: string;
  blob?: Blob; // Optional: store the original blob to avoid CSP issues
  fileName?: string; // Optional: file name for display
  // For filesystem videos
  relativePath?: string; // Optional: relative path for filesystem videos
  patMetadata?: PatMetadata;
}

interface PatMetadata {
  originalSizeBytes?: number;
  originalSizeKilobytes?: number;
  rawHeaderValue?: string;
}

@Component({
  selector: 'app-videoshow-modal',
  templateUrl: './videoshow-modal.component.html',
  styleUrls: ['./videoshow-modal.component.css']
})
export class VideoshowModalComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() videos: VideoshowVideoSource[] = [];
  @Input() eventName: string = '';
  @Input() loadFromFileService: boolean = false; // If true, use fileId to load videos via FileService
  
  @Output() closed = new EventEmitter<void>();
  
  @ViewChild('videoshowModal') videoshowModal!: TemplateRef<any>;
  @ViewChild('videoshowContainer') videoshowContainerRef!: ElementRef;
  @ViewChild('videoshowVideoEl') videoshowVideoElRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('thumbnailsStrip') thumbnailsStripRef!: ElementRef<HTMLElement>;
  
  // Videoshow state
  public videoshowVideos: string[] = [];
  private videoshowBlobs: Map<string, Blob> = new Map(); // Store original blobs by URL
  public currentVideoshowIndex: number = 0;
  public isFullscreen: boolean = false;
  private modalRef?: NgbModalRef;
  
  // Keyboard listener
  private keyboardListener?: (event: KeyboardEvent) => void;
  private isVideoshowModalOpen: boolean = false;
  
  // Video playback state
  public isPlaying: boolean = false;
  public currentTime: number = 0;
  public duration: number = 0;
  public volume: number = 1;
  public isMuted: boolean = false;
  
  // Info panel visibility
  public showInfoPanel: boolean = false;
  
  // Thumbnails strip visibility
  public showThumbnails: boolean = true;
  private userToggledThumbnails: boolean = false;
  
  // Video quality
  public selectedQuality: 'auto' | 'high' | 'medium' | 'low' = 'low';
  public availableQualities: string[] = ['auto', 'high', 'medium', 'low'];
  
  // Fullscreen listener handler (stored for cleanup)
  private fullscreenChangeHandler?: () => void;
  
  // Resize listener handler (stored for cleanup)
  private resizeHandler?: () => void;
  
  // Video loading control
  private videoLoadActive: boolean = true;
  private videoLoadingSubs: Subscription[] = [];
  private cancelVideoLoadsSubject!: Subject<void>;
  private videoLoadQueue: Array<{videoSource: VideoshowVideoSource, videoIndex: number, priority: number}> = [];
  private activeVideoLoads: number = 0;
  private maxConcurrentVideoLoads: number = 3; // Lower than images since videos are larger
  private videoCache: Map<string, {objectUrl: string, blob: Blob, metadata?: PatMetadata}> = new Map();
  private loadingVideoKeys: Set<string> = new Set();
  private pendingVideoLoads: Map<string, number[]> = new Map();
  
  // Thumbnails
  public thumbnails: string[] = [];
  public isLoadingThumbnails: boolean = false;
  private loadingThumbnailVideoIndices: Set<number> = new Set();
  private thumbnailBlobs: Map<string, Blob> = new Map();
  private videoUrlToThumbnailIndex: Map<string, number> = new Map();
  private videoshowIndexToVideoIndex: Map<number, number> = new Map();
  
  // Video file names
  private videoFileNames: Map<string, string> = new Map();
  private videoPatMetadata: Map<string, PatMetadata> = new Map();
  
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
  }
  
  ngOnDestroy(): void {
    this.cleanupAllMemory();
  }
  
  // Centralized method to clean up all memory used by the videoshow
  private cleanupAllMemory(): void {
    // Remove fullscreen class from body
    document.body.classList.remove('videoshow-fullscreen-active');
    
    // Stop video playback
    this.stopVideo();
    
    // Cancel all downloads
    this.cancelVideoLoads();
    
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
    
    // Clean up video blob URLs
    this.videoshowBlobs.forEach((blob, url) => {
      try {
        if (url && typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        // Ignore errors
      }
    });
    this.videoshowBlobs.clear();
    this.videoshowVideos = [];
    
    // Remove listeners
    this.removeKeyboardListener();
    this.removeResizeListener();
    this.removeFullscreenListener();
    
    // Clear caches
    this.videoCache.clear();
    this.loadingVideoKeys.clear();
    this.pendingVideoLoads.clear();
    this.videoFileNames.clear();
    this.videoPatMetadata.clear();
  }
  
  // Setup fullscreen listener
  private setupFullscreenListener(): void {
    this.removeFullscreenListener();
    
    this.fullscreenChangeHandler = () => {
      this.ngZone.run(() => {
        const isFullscreen = !!(document.fullscreenElement || 
          (document as any).webkitFullscreenElement || 
          (document as any).mozFullScreenElement || 
          (document as any).msFullscreenElement);
        
        if (isFullscreen) {
          document.body.classList.add('videoshow-fullscreen-active');
          this.isFullscreen = true;
        } else {
          document.body.classList.remove('videoshow-fullscreen-active');
          this.isFullscreen = false;
        }
        this.cdr.detectChanges();
      });
    };
    
    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('mozfullscreenchange', this.fullscreenChangeHandler);
    document.addEventListener('MSFullscreenChange', this.fullscreenChangeHandler);
  }
  
  private removeFullscreenListener(): void {
    if (this.fullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('webkitfullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('mozfullscreenchange', this.fullscreenChangeHandler);
      document.removeEventListener('MSFullscreenChange', this.fullscreenChangeHandler);
      this.fullscreenChangeHandler = undefined;
    }
  }
  
  // Setup resize listener
  private setupResizeListener(): void {
    this.removeResizeListener();
    this.resizeHandler = () => {
      this.ngZone.run(() => {
        // Handle resize if needed
        this.cdr.detectChanges();
      });
    };
    window.addEventListener('resize', this.resizeHandler);
  }
  
  private removeResizeListener(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
  }
  
  // Cancel all video loading subscriptions
  private cancelVideoLoads(): void {
    this.videoLoadActive = false;
    
    if (this.cancelVideoLoadsSubject) {
      this.cancelVideoLoadsSubject.next();
    }
    
    this.videoLoadingSubs.forEach((s) => { 
      if (s && !s.closed) { 
        s.unsubscribe(); 
      } 
    }); 
    this.videoLoadingSubs = [];
  }
  
  // Open the videoshow modal
  public open(videos: VideoshowVideoSource[], eventName: string = '', loadFromFileService: boolean = false, retryCount: number = 0): void {
    if (!videos) {
      videos = [];
    }
    
    if (retryCount > 10) {
      return;
    }
    
    this.videos = videos;
    this.eventName = eventName;
    this.loadFromFileService = loadFromFileService;
    
    // Initialize videoshow state
    this.videoshowVideos = [];
    this.videoshowBlobs.clear();
    this.currentVideoshowIndex = 0;
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.showThumbnails = videos.length > 1;
    this.userToggledThumbnails = false;
    this.videoLoadActive = true;
    this.videoLoadQueue = [];
    this.activeVideoLoads = 0;
    this.videoCache.clear();
    this.loadingVideoKeys.clear();
    this.pendingVideoLoads.clear();
    this.cancelVideoLoadsSubject = new Subject<void>();
    
    // Ensure ViewChild is available
    if (!this.videoshowModal) {
      setTimeout(() => {
        this.open(videos, eventName, loadFromFileService, retryCount + 1);
      }, 100);
      return;
    }
    
    // Close any existing modal first
    if (this.modalRef) {
      try {
        this.modalRef.close();
      } catch (e) {
        // Ignore errors
      }
      this.modalRef = undefined;
    }
    
    // Remove any existing keyboard listener
    this.removeKeyboardListener();
    
    // Open the modal
    try {
      this.modalRef = this.modalService.open(this.videoshowModal, { 
        size: 'xl', 
        centered: true,
        backdrop: 'static',
        keyboard: false,
        windowClass: 'modal-smooth-animation videoshow-modal-wide'
      });
      
      this.isVideoshowModalOpen = true;
      
      // Setup keyboard listener after modal is opened
      setTimeout(() => {
        this.setupKeyboardListener();
        this.setupResizeListener();
        
        // Center the active thumbnail after modal is fully rendered
        setTimeout(() => {
          this.scrollToActiveThumbnail();
        }, 300);
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
      
      // Load videos
      if (videos.length > 0) {
        this.thumbnails = new Array(videos.length).fill('');
        this.loadVideos();
      }
    } catch (error) {
      if (retryCount < 3) {
        setTimeout(() => {
          this.open(videos, eventName, loadFromFileService, retryCount + 1);
        }, 200);
      }
    }
  }
  
  // Queue video loading
  private queueVideoLoad(videoSource: VideoshowVideoSource, videoIndex: number, priority: number = 0): void {
    if (this.videoLoadQueue.some(item => item.videoIndex === videoIndex)) {
      return;
    }
    
    this.videoLoadQueue.push({ videoSource, videoIndex, priority });
    this.videoLoadQueue.sort((a, b) => a.priority - b.priority);
    this.processVideoLoadQueue();
  }
  
  // Get unique key for a video source
  private getVideoCacheKey(videoSource: VideoshowVideoSource): string | null {
    let baseKey: string | null = null;
    if (videoSource.fileId) {
      baseKey = `fileId:${videoSource.fileId}`;
    } else if (videoSource.relativePath && videoSource.fileName) {
      baseKey = `disk:${videoSource.relativePath}/${videoSource.fileName}`;
    } else if (videoSource.blobUrl) {
      baseKey = `blob:${videoSource.blobUrl}`;
    }
    
    if (!baseKey) {
      return null;
    }
    
    // Include quality in cache key to cache different qualities separately
    return `${baseKey}_quality_${this.selectedQuality}`;
  }
  
  // Process video load queue
  private processVideoLoadQueue(): void {
    while (this.activeVideoLoads < this.maxConcurrentVideoLoads && 
           this.videoLoadQueue.length > 0 && 
           this.videoLoadActive) {
      const item = this.videoLoadQueue.shift();
      if (!item) break;
      
      const { videoSource, videoIndex } = item;
      const cacheKey = this.getVideoCacheKey(videoSource);
      
      // Check if video is already cached
      if (cacheKey && this.videoCache.has(cacheKey)) {
        const cached = this.videoCache.get(cacheKey)!;
        this.handleVideoLoaded(cached.objectUrl, cached.blob, videoIndex, cached.metadata);
        this.processVideoLoadQueue();
        continue;
      }
      
      // Check if video is already loading
      if (cacheKey && this.loadingVideoKeys.has(cacheKey)) {
        if (!this.pendingVideoLoads.has(cacheKey)) {
          this.pendingVideoLoads.set(cacheKey, []);
        }
        this.pendingVideoLoads.get(cacheKey)!.push(videoIndex);
        this.processVideoLoadQueue();
        continue;
      }
      
      this.activeVideoLoads++;
      
      if (cacheKey) {
        this.loadingVideoKeys.add(cacheKey);
      }
      
      const startRequest = () => {
        if (this.loadFromFileService && videoSource.fileId) {
          // Use quality parameter when loading video
          const subscription = this.fileService.getVideoWithMetadata(videoSource.fileId, this.selectedQuality).pipe(
            takeUntil(this.cancelVideoLoadsSubject),
            map((res) => {
              // Try to detect MIME type from buffer, fallback to filename
              let mimeType = this.detectVideoMimeType(res.buffer);
              if (mimeType === 'video/mp4' && videoSource.fileName) {
                // If detection failed, try filename-based detection
                const filenameType = this.detectVideoMimeTypeFromFilename(videoSource.fileName);
                if (filenameType !== 'video/mp4' || videoSource.fileName.toLowerCase().endsWith('.mp4')) {
                  mimeType = filenameType;
                }
              }
              const blob = new Blob([res.buffer], { type: mimeType });
              const objectUrl = URL.createObjectURL(blob);
              this.videoshowBlobs.set(objectUrl, blob);
              this.assignVideoFileName(videoIndex, objectUrl);
              const metadata = res.metadata ?? this.parsePatMetadataFromHeaders(res.headers);
              if (metadata) {
                videoSource.patMetadata = metadata;
              }
              
              if (cacheKey) {
                this.videoCache.set(cacheKey, { objectUrl, blob, metadata });
                this.loadingVideoKeys.delete(cacheKey);
                
                // Handle pending loads for same video
                const pending = this.pendingVideoLoads.get(cacheKey);
                if (pending) {
                  pending.forEach(idx => {
                    this.handleVideoLoaded(objectUrl, blob, idx, metadata);
                  });
                  this.pendingVideoLoads.delete(cacheKey);
                }
              }
              
              return { objectUrl, blob, metadata };
            }),
            finalize(() => {
              this.activeVideoLoads--;
              this.processVideoLoadQueue();
            })
          ).subscribe({
            next: (result) => {
              this.handleVideoLoaded(result.objectUrl, result.blob, videoIndex, result.metadata);
            },
            error: (error) => {
              console.error('Error loading video:', error);
              this.activeVideoLoads--;
              this.processVideoLoadQueue();
            }
          });
          
          this.videoLoadingSubs.push(subscription);
        } else if (videoSource.blobUrl) {
          // Use provided blob URL
          const blob = videoSource.blob || this.videoshowBlobs.get(videoSource.blobUrl);
          if (blob) {
            const objectUrl = videoSource.blobUrl;
            this.videoshowBlobs.set(objectUrl, blob);
            this.assignVideoFileName(videoIndex, objectUrl);
            
            if (cacheKey) {
              this.videoCache.set(cacheKey, { objectUrl, blob, metadata: videoSource.patMetadata });
              this.loadingVideoKeys.delete(cacheKey);
            }
            
            this.handleVideoLoaded(objectUrl, blob, videoIndex, videoSource.patMetadata);
            this.activeVideoLoads--;
            this.processVideoLoadQueue();
          }
        } else if (videoSource.blob) {
          // Create blob URL from provided blob
          const objectUrl = URL.createObjectURL(videoSource.blob);
          this.videoshowBlobs.set(objectUrl, videoSource.blob);
          this.assignVideoFileName(videoIndex, objectUrl);
          
          if (cacheKey) {
            this.videoCache.set(cacheKey, { objectUrl, blob: videoSource.blob, metadata: videoSource.patMetadata });
            this.loadingVideoKeys.delete(cacheKey);
          }
          
          this.handleVideoLoaded(objectUrl, videoSource.blob, videoIndex, videoSource.patMetadata);
          this.activeVideoLoads--;
          this.processVideoLoadQueue();
        }
      };
      
      startRequest();
    }
  }
  
  // Handle video loaded
  private handleVideoLoaded(objectUrl: string, blob: Blob, videoIndex: number, metadata?: PatMetadata): void {
    if (videoIndex >= this.videoshowVideos.length) {
      // Extend array if needed
      const newLength = videoIndex + 1;
      this.videoshowVideos = [...this.videoshowVideos, ...new Array(newLength - this.videoshowVideos.length).fill('')];
    }
    
    this.videoshowVideos[videoIndex] = objectUrl;
    
    if (metadata) {
      this.videoPatMetadata.set(objectUrl, metadata);
    }
    
    // If this is the current video, update the video element
    if (videoIndex === this.currentVideoshowIndex && this.videoshowVideoElRef) {
      this.ngZone.run(() => {
        this.cdr.detectChanges();
        // Video will load automatically via src binding
      });
    }
    
    this.cdr.detectChanges();
  }
  
  // Load all videos
  private loadVideos(): void {
    this.videos.forEach((videoSource, index) => {
      this.queueVideoLoad(videoSource, index, index === this.currentVideoshowIndex ? 0 : 1);
    });
  }
  
  // Add videos dynamically
  public addVideos(newVideos: VideoshowVideoSource[]): void {
    const startIndex = this.videos.length;
    this.videos = [...this.videos, ...newVideos];
    
    // Extend thumbnails array
    this.thumbnails = [...this.thumbnails, ...new Array(newVideos.length).fill('')];
    
    // Queue new videos with lower priority
    newVideos.forEach((videoSource, index) => {
      this.queueVideoLoad(videoSource, startIndex + index, 2);
    });
  }
  
  // Detect video MIME type from buffer content
  private detectVideoMimeType(buffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(buffer);
    
    if (uint8Array.length < 12) {
      return 'video/mp4'; // Default fallback
    }
    
    // Check for MP4 (ftyp box at offset 4)
    if (uint8Array[4] === 0x66 && uint8Array[5] === 0x74 && 
        uint8Array[6] === 0x79 && uint8Array[7] === 0x70) {
      return 'video/mp4';
    }
    
    // Check for WebM (EBML header)
    if (uint8Array[0] === 0x1A && uint8Array[1] === 0x45 && 
        uint8Array[2] === 0xDF && uint8Array[3] === 0xA3) {
      return 'video/webm';
    }
    
    // Check for AVI (RIFF header)
    if (uint8Array[0] === 0x52 && uint8Array[1] === 0x49 && 
        uint8Array[2] === 0x46 && uint8Array[3] === 0x46 &&
        uint8Array[8] === 0x41 && uint8Array[9] === 0x56 && 
        uint8Array[10] === 0x49 && uint8Array[11] === 0x20) {
      return 'video/x-msvideo'; // AVI
    }
    
    // Check for MOV/QuickTime (ftyp at offset 4)
    if (uint8Array[4] === 0x66 && uint8Array[5] === 0x74 && 
        uint8Array[6] === 0x79 && uint8Array[7] === 0x70) {
      // Check for QuickTime brand
      const brand = String.fromCharCode(uint8Array[8], uint8Array[9], uint8Array[10], uint8Array[11]);
      if (brand === 'qt  ' || brand === 'mov ') {
        return 'video/quicktime';
      }
      return 'video/mp4';
    }
    
    // Default to MP4 (most compatible)
    return 'video/mp4';
  }
  
  // Detect video MIME type from filename (fallback)
  private detectVideoMimeTypeFromFilename(filename: string): string {
    if (!filename) return 'video/mp4';
    
    const ext = filename.toLowerCase();
    if (ext.endsWith('.mp4')) return 'video/mp4';
    if (ext.endsWith('.webm')) return 'video/webm';
    if (ext.endsWith('.ogg') || ext.endsWith('.ogv')) return 'video/ogg';
    if (ext.endsWith('.mov')) return 'video/quicktime';
    if (ext.endsWith('.avi')) return 'video/x-msvideo';
    if (ext.endsWith('.mkv')) return 'video/x-matroska';
    if (ext.endsWith('.flv')) return 'video/x-flv';
    if (ext.endsWith('.wmv')) return 'video/x-ms-wmv';
    if (ext.endsWith('.m4v')) return 'video/x-m4v';
    if (ext.endsWith('.3gp')) return 'video/3gpp';
    
    return 'video/mp4'; // Default
  }
  
  // Parse PAT metadata from headers
  private parsePatMetadataFromHeaders(headers: HttpHeaders): PatMetadata | undefined {
    const patHeader = headers.get('X-Pat-Metadata');
    if (!patHeader) {
      return undefined;
    }
    
    try {
      const metadata: PatMetadata = {};
      const parts = patHeader.split(';');
      
      parts.forEach(part => {
        const [key, value] = part.split('=');
        if (key && value) {
          const trimmedKey = key.trim();
          const trimmedValue = value.trim();
          
          if (trimmedKey === 'originalSizeBytes') {
            metadata.originalSizeBytes = parseInt(trimmedValue, 10);
            metadata.originalSizeKilobytes = Math.round(metadata.originalSizeBytes! / 1024);
          } else if (trimmedKey === 'rawHeaderValue') {
            metadata.rawHeaderValue = trimmedValue;
          }
        }
      });
      
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    } catch (error) {
      return undefined;
    }
  }
  
  // Assign video file name
  private assignVideoFileName(videoIndex: number, objectUrl: string): void {
    const videoSource = this.videos[videoIndex];
    if (videoSource && videoSource.fileName) {
      this.videoFileNames.set(objectUrl, videoSource.fileName);
    }
  }
  
  // Get current video
  public getCurrentVideoshowVideo(): string {
    if (this.videoshowVideos.length === 0 || this.currentVideoshowIndex >= this.videoshowVideos.length) {
      return '';
    }
    return this.videoshowVideos[this.currentVideoshowIndex] || '';
  }
  
  // Get current video file name
  public getCurrentVideoFileName(): string {
    const currentUrl = this.getCurrentVideoshowVideo();
    return this.videoFileNames.get(currentUrl) || '';
  }
  
  // Change video quality
  public changeQuality(quality: 'auto' | 'high' | 'medium' | 'low'): void {
    if (this.selectedQuality === quality) {
      return; // No change needed
    }
    
    this.selectedQuality = quality;
    
    // Reload current video with new quality
    if (this.videoshowVideos.length > 0 && this.videos && this.currentVideoshowIndex < this.videos.length) {
      const currentVideo = this.videos[this.currentVideoshowIndex];
      if (currentVideo && currentVideo.fileId) {
        // Stop current video
        this.stopVideo();
        
        // Clear current video from cache to force reload
        const currentUrl = this.getCurrentVideoshowVideo();
        this.videoshowVideos[this.currentVideoshowIndex] = '';
        
        // Clear cache for this fileId with all quality variants
        const cacheKeysToDelete: string[] = [];
        const baseKey = currentVideo.fileId || 
                       (currentVideo.relativePath && currentVideo.fileName 
                         ? `${currentVideo.relativePath}/${currentVideo.fileName}` 
                         : currentVideo.blobUrl || '');
        
        if (baseKey) {
          this.videoCache.forEach((value, key) => {
            if (key.startsWith(baseKey + '_quality_')) {
              cacheKeysToDelete.push(key);
            }
          });
          cacheKeysToDelete.forEach(key => this.videoCache.delete(key));
        }
        
        // Also clear from loading keys
        cacheKeysToDelete.forEach(key => this.loadingVideoKeys.delete(key));
        
        // Reload video with new quality
        this.queueVideoLoad(currentVideo, this.currentVideoshowIndex, 0);
      }
    }
  }
  
  // Get quality label for display
  public getQualityLabel(quality: string): string {
    switch(quality) {
      case 'auto': return 'EVENTELEM.QUALITY_AUTO';
      case 'high': return 'EVENTELEM.QUALITY_HIGH';
      case 'medium': return 'EVENTELEM.QUALITY_MEDIUM';
      case 'low': return 'EVENTELEM.QUALITY_LOW';
      default: return 'EVENTELEM.QUALITY_AUTO';
    }
  }
  
  // Navigation
  public previousVideo(): void {
    if (this.videoshowVideos.length <= 1) return;
    
    this.stopVideo();
    this.currentVideoshowIndex = (this.currentVideoshowIndex - 1 + this.videoshowVideos.length) % this.videoshowVideos.length;
    this.scrollToActiveThumbnail();
    this.cdr.detectChanges();
  }
  
  public nextVideo(): void {
    if (this.videoshowVideos.length <= 1) return;
    
    this.stopVideo();
    this.currentVideoshowIndex = (this.currentVideoshowIndex + 1) % this.videoshowVideos.length;
    this.scrollToActiveThumbnail();
    this.cdr.detectChanges();
  }
  
  // Helper method to get video element
  private getVideoElement(): HTMLVideoElement | null {
    // Try ViewChild first
    if (this.videoshowVideoElRef?.nativeElement) {
      return this.videoshowVideoElRef.nativeElement;
    }
    // Fallback to querySelector
    const video = document.querySelector('.videoshow-video') as HTMLVideoElement;
    return video || null;
  }
  
  // Video controls
  public playPause(): void {
    const video = this.getVideoElement();
    if (!video) {
      return;
    }
    
    if (video.paused) {
      video.play().then(() => {
        this.isPlaying = true;
        this.cdr.detectChanges();
      }).catch(err => {
        console.error('Error playing video:', err);
        this.isPlaying = false;
        this.cdr.detectChanges();
      });
    } else {
      video.pause();
      this.isPlaying = false;
      this.cdr.detectChanges();
    }
  }
  
  public stopVideo(): void {
    const video = this.getVideoElement();
    if (!video) {
      console.warn('Video element not found');
      return;
    }
    
    video.pause();
    video.currentTime = 0;
    this.isPlaying = false;
    this.currentTime = 0;
    this.cdr.detectChanges();
  }
  
  public setVolume(volume: number): void {
    const video = this.getVideoElement();
    if (!video) {
      console.warn('Video element not found');
      return;
    }
    
    this.volume = Math.max(0, Math.min(1, volume));
    video.volume = this.volume;
    this.isMuted = this.volume === 0;
    video.muted = this.isMuted;
    this.cdr.detectChanges();
  }
  
  public toggleMute(): void {
    const video = this.getVideoElement();
    if (!video) {
      console.warn('Video element not found');
      return;
    }
    
    this.isMuted = !this.isMuted;
    video.muted = this.isMuted;
    this.cdr.detectChanges();
  }
  
  public seekTo(time: number): void {
    const video = this.getVideoElement();
    if (!video) {
      console.warn('Video element not found');
      return;
    }
    
    video.currentTime = Math.max(0, Math.min(this.duration, time));
    this.cdr.detectChanges();
  }
  
  // Video event handlers
  public onVideoLoadedMetadata(): void {
    const video = this.getVideoElement();
    if (!video) return;
    
    this.duration = video.duration;
    this.cdr.detectChanges();
  }
  
  public onVideoTimeUpdate(): void {
    const video = this.getVideoElement();
    if (!video) return;
    
    this.currentTime = video.currentTime;
    this.cdr.detectChanges();
  }
  
  public onVideoPlay(): void {
    this.isPlaying = true;
    this.cdr.detectChanges();
  }
  
  public onVideoPause(): void {
    this.isPlaying = false;
    this.cdr.detectChanges();
  }
  
  public onVideoEnded(): void {
    this.isPlaying = false;
    this.currentTime = 0;
    // Auto-play next video if available
    if (this.videoshowVideos.length > 1) {
      this.nextVideo();
    }
    this.cdr.detectChanges();
  }
  
  // Fullscreen
  public toggleFullscreen(): void {
    // Check current fullscreen state directly from document (more reliable than this.isFullscreen)
    const isCurrentlyFullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
      (document as any).mozFullScreenElement || (document as any).msFullscreenElement);
    
    // Get the video element directly (like the native fullscreen button does)
    const video = this.getVideoElement();
    
    if (!video) {
      return;
    }
    
    if (!isCurrentlyFullscreen) {
      // Enter fullscreen - use the video element itself (like native controls do)
      const requestFullscreen = (video as any).requestFullscreen ||
                               (video as any).webkitRequestFullscreen ||
                               (video as any).webkitEnterFullscreen ||
                               (video as any).mozRequestFullScreen ||
                               (video as any).msRequestFullscreen;
      
      if (requestFullscreen) {
        const promise = requestFullscreen.call(video);
        if (promise && promise.catch) {
          promise.catch((err: any) => {
            console.error('Error entering fullscreen:', err);
            // Fallback: try with container if video fails
            this.tryFullscreenWithContainer();
          });
        }
      } else {
        // Fallback: try with container
        this.tryFullscreenWithContainer();
      }
    } else {
      // Exit fullscreen
      const exitFullscreen = document.exitFullscreen ||
                            (document as any).webkitExitFullscreen ||
                            (document as any).mozCancelFullScreen ||
                            (document as any).msExitFullscreen;
      
      if (exitFullscreen) {
        exitFullscreen.call(document).catch((err: any) => {
          console.error('Error exiting fullscreen:', err);
        });
      }
    }
  }
  
  // Fallback method to try fullscreen with container
  private tryFullscreenWithContainer(): void {
    let videoshowContainer: HTMLElement | null = null;
    if (this.videoshowContainerRef?.nativeElement) {
      videoshowContainer = this.videoshowContainerRef.nativeElement;
    } else {
      videoshowContainer = document.querySelector('.videoshow-container') as HTMLElement;
    }
    
    if (!videoshowContainer) {
      return;
    }
    
    const requestFullscreen = (videoshowContainer as any).requestFullscreen ||
                             (videoshowContainer as any).webkitRequestFullscreen ||
                             (videoshowContainer as any).mozRequestFullScreen ||
                             (videoshowContainer as any).msRequestFullscreen;
    
    if (requestFullscreen) {
      const promise = requestFullscreen.call(videoshowContainer);
      if (promise && promise.catch) {
        promise.catch((err: any) => {
          console.error('Error entering fullscreen with container:', err);
        });
      }
    }
  }
  
  // Info panel
  public toggleInfoPanel(): void {
    this.showInfoPanel = !this.showInfoPanel;
    this.cdr.detectChanges();
  }
  
  // Thumbnails
  public toggleThumbnails(): void {
    this.showThumbnails = !this.showThumbnails;
    this.userToggledThumbnails = true;
    this.cdr.detectChanges();
  }
  
  public isCurrentThumbnail(index: number): boolean {
    return index === this.currentVideoshowIndex;
  }
  
  public onThumbnailClick(index: number): void {
    if (index === this.currentVideoshowIndex) return;
    
    this.stopVideo();
    this.currentVideoshowIndex = index;
    this.scrollToActiveThumbnail();
    this.cdr.detectChanges();
  }
  
  public getThumbnailUrl(index: number): string {
    // For now, return empty - thumbnails can be generated later
    return this.thumbnails[index] || '';
  }
  
  private scrollToActiveThumbnail(): void {
    if (!this.thumbnailsStripRef || !this.showThumbnails) return;
    
    setTimeout(() => {
      const strip = this.thumbnailsStripRef.nativeElement;
      const activeThumbnail = strip.querySelector(`.thumbnail-item.active`);
      if (activeThumbnail) {
        activeThumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, 100);
  }
  
  // Keyboard listener
  private setupKeyboardListener(): void {
    this.removeKeyboardListener();
    
    this.keyboardListener = (event: KeyboardEvent) => {
      if (!this.isVideoshowModalOpen || !this.modalRef) {
        return;
      }
      
      const target = event.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      
      const modalElement = document.querySelector('.modal.show');
      const isOurModal = modalElement && modalElement.querySelector('.videoshow-header') !== null;
      
      if (!isOurModal) {
        return;
      }
      
      // Handle keyboard shortcuts
      if (event.key === 'ArrowLeft' || event.keyCode === 37) {
        event.preventDefault();
        this.previousVideo();
      } else if (event.key === 'ArrowRight' || event.keyCode === 39) {
        event.preventDefault();
        this.nextVideo();
      } else if (event.key === ' ' || event.keyCode === 32) {
        event.preventDefault();
        this.playPause();
      } else if (event.key === 'p' || event.key === 'P' || event.keyCode === 80) {
        event.preventDefault();
        this.toggleFullscreen();
      } else if (event.key === 'i' || event.key === 'I' || event.keyCode === 73) {
        event.preventDefault();
        this.toggleInfoPanel();
      } else if (event.key === 't' || event.key === 'T' || event.keyCode === 84) {
        event.preventDefault();
        this.toggleThumbnails();
      } else if (event.key === 'Escape' || event.keyCode === 27) {
        if (this.isFullscreen) {
          event.preventDefault();
          this.toggleFullscreen();
        }
      }
    };
    
    document.addEventListener('keydown', this.keyboardListener);
  }
  
  private removeKeyboardListener(): void {
    if (this.keyboardListener) {
      document.removeEventListener('keydown', this.keyboardListener);
      this.keyboardListener = undefined;
    }
  }
  
  // Close modal
  public onVideoshowClose(closeFn: () => void): void {
    this.stopVideo();
    closeFn();
  }
  
  // Format time
  public formatTime(seconds: number): string {
    if (isNaN(seconds)) return '0:00';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
  
  // Get video metadata
  public getVideoMetadata(): PatMetadata | undefined {
    const currentUrl = this.getCurrentVideoshowVideo();
    return this.videoPatMetadata.get(currentUrl);
  }
  
  // Check if mobile device
  public isMobileDevice(): boolean {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }
  
  // Handle thumbnail error
  public onThumbnailError(event: any): void {
    // Handle thumbnail load error if needed
    console.warn('Thumbnail load error:', event);
  }
}

