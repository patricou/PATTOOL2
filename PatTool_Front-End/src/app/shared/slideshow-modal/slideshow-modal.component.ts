import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, Input, Output, EventEmitter, TemplateRef } from '@angular/core';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { FileService } from '../../services/file.service';
import { Observable, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
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
  
  // FS Photos download control
  private fsDownloadsActive: boolean = false;
  private fsActiveSubs: Subscription[] = [];
  private fsQueue: string[] = [];
  
  // EXIF data
  public exifData: Array<{label: string, value: string}> = [];
  public isLoadingExif: boolean = false;
  
  constructor(
    private modalService: NgbModal,
    private translateService: TranslateService,
    private fileService: FileService
  ) {}
  
  ngOnInit(): void {
    this.setupFullscreenListener();
  }
  
  ngAfterViewInit(): void {
    // ViewChild is now available
  }
  
  ngOnDestroy(): void {
    this.stopSlideshow();
    this.cancelFsDownloads();
    this.removeKeyboardListener();
    
    // Clean up blob URLs
    this.slideshowImages.forEach(url => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    this.slideshowImages = [];
    this.slideshowBlobs.clear();
  }
  
  // Open the slideshow modal
  public open(images: SlideshowImageSource[], eventName: string = '', loadFromFileService: boolean = false, retryCount: number = 0): void {
    // Allow opening with empty array for dynamic loading
    if (!images) {
      images = [];
    }
    
    // Prevent infinite retry loop
    if (retryCount > 10) {
      console.error('Failed to open slideshow modal after multiple retries. ViewChild may not be initialized.');
      return;
    }
    
    this.images = images;
    this.eventName = eventName;
    this.loadFromFileService = loadFromFileService;
    
    // Initialize slideshow state
    this.slideshowImages = [];
    this.slideshowBlobs.clear();
    this.currentSlideshowIndex = 0;
    this.isSlideshowActive = false;
    this.resetSlideshowZoom();
    
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
        backdrop: true,
        keyboard: true,
        windowClass: 'modal-smooth-animation slideshow-modal-wide'
      });
      
      // Set flag that modal is open
      this.isSlideshowModalOpen = true;
      this.lastKeyPressTime = 0;
      this.lastKeyCode = 0;
      
      // Setup keyboard listener after modal is opened
      setTimeout(() => {
        this.setupKeyboardListener();
      }, 100);
      
      // Handle modal close event
      this.modalRef.result.then(
        () => {
          this.isSlideshowModalOpen = false;
          this.stopSlideshow();
          this.removeKeyboardListener();
          this.closed.emit();
        },
        () => {
          this.isSlideshowModalOpen = false;
          this.stopSlideshow();
          this.removeKeyboardListener();
          this.closed.emit();
        }
      );
      
      // Load images (will be empty array if loading dynamically)
      if (images.length > 0) {
        this.loadImages();
      }
    } catch (error) {
      console.error('Error opening slideshow modal:', error);
      // Retry once more if there's an error
      if (retryCount < 3) {
        setTimeout(() => {
          this.open(images, eventName, loadFromFileService, retryCount + 1);
        }, 200);
      }
    }
  }
  
  // Load images into slideshow
  private loadImages(): void {
    if (!this.images || this.images.length === 0) {
      return;
    }
    
    if (this.loadFromFileService) {
      // Load images via FileService
      this.images.forEach((imageSource) => {
        if (imageSource.fileId) {
          this.fileService.getFile(imageSource.fileId).pipe(
            map((res: any) => {
              // Try to detect MIME type from fileId or use a default image type
              // This is important for EXIF.js to work correctly
              const mimeType = this.detectImageMimeType(res);
              const blob = new Blob([res], { type: mimeType });
              const objectUrl = URL.createObjectURL(blob);
              // Store the blob for later use (e.g., EXIF reading)
              this.slideshowBlobs.set(objectUrl, blob);
              return objectUrl;
            })
          ).subscribe((objectUrl: string) => {
            this.slideshowImages.push(objectUrl);
            // Reset zoom when first image loads
            if (this.slideshowImages.length === 1) {
              setTimeout(() => this.resetSlideshowZoom(), 100);
            }
          }, (error) => {
            console.error('Error loading image for slideshow:', error);
          });
        }
      });
    } else {
      // Use provided blob URLs directly
      this.images.forEach((imageSource) => {
        if (imageSource.blobUrl) {
          this.slideshowImages.push(imageSource.blobUrl);
        }
      });
      // Reset zoom when images are loaded
      if (this.slideshowImages.length > 0) {
        setTimeout(() => this.resetSlideshowZoom(), 100);
      }
    }
  }
  
  // Method to add images dynamically (for progressive loading)
  public addImages(newImages: SlideshowImageSource[]): void {
    if (!newImages || newImages.length === 0) {
      return;
    }
    
    newImages.forEach((imageSource) => {
      if (imageSource.blobUrl && !this.slideshowImages.includes(imageSource.blobUrl)) {
        this.slideshowImages.push(imageSource.blobUrl);
      } else if (imageSource.fileId && this.loadFromFileService) {
        // Load via FileService if needed
        this.fileService.getFile(imageSource.fileId).pipe(
          map((res: any) => {
            // Try to detect MIME type for better EXIF support
            const mimeType = this.detectImageMimeType(res);
            const blob = new Blob([res], { type: mimeType });
            const objectUrl = URL.createObjectURL(blob);
            // Store the blob for later use (e.g., EXIF reading)
            this.slideshowBlobs.set(objectUrl, blob);
            return objectUrl;
          })
        ).subscribe((objectUrl: string) => {
          if (!this.slideshowImages.includes(objectUrl)) {
            this.slideshowImages.push(objectUrl);
          }
        }, (error) => {
          console.error('Error loading image for slideshow:', error);
        });
      }
    });
  }
  
  // Setup fullscreen listener
  private setupFullscreenListener(): void {
    const handleFullscreenChange = () => {
      this.isFullscreen = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
        (document as any).mozFullScreenElement || (document as any).msFullscreenElement);
    };
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
  }
  
  // Get minimum zoom level
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
  
  // Apply wheel zoom
  private applyWheelZoom(event: WheelEvent, current: number, minZoom: number, maxZoom: number = 5): number {
    event.preventDefault();
    const delta = Math.sign(event.deltaY);
    const step = 0.1;
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
  
  public resetSlideshowZoom(): void { 
    this.slideshowZoom = Math.max(1, this.getMinSlideshowZoom()); 
    this.slideshowTranslateX = 0; 
    this.slideshowTranslateY = 0; 
  }
  
  public zoomInSlideshow(): void { 
    this.slideshowZoom = Math.min(5, parseFloat((this.slideshowZoom + 0.1).toFixed(2))); 
  }
  
  public zoomOutSlideshow(): void { 
    this.slideshowZoom = Math.max(this.getMinSlideshowZoom(), parseFloat((this.slideshowZoom - 0.1).toFixed(2))); 
    this.clampSlideshowTranslation(); 
  }
  
  // Drag handlers
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
  
  public onSlideshowTouchStart(event: TouchEvent): void {
    if (event.touches.length === 1) {
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
      try { event.preventDefault(); event.stopPropagation(); } catch {}
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      const currentDistance = this.getTouchDistance(touch1, touch2);
      
      if (this.touchStartDistance > 0) {
        const scale = currentDistance / this.touchStartDistance;
        let newZoom = this.touchStartZoom * scale;
        
        const minZoom = this.getMinSlideshowZoom();
        const maxZoom = 5;
        newZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
        
        this.slideshowZoom = parseFloat(newZoom.toFixed(2));
        
        if (this.slideshowZoom > minZoom) {
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
      }
    }
  }
  
  public onSlideshowTouchEnd(event: TouchEvent): void {
    if (event.touches.length === 0) {
      this.isDraggingSlideshow = false;
      this.isPinching = false;
      this.initialTouches = [];
      this.touchStartDistance = 0;
      this.lastTouchDistance = 0;
      this.pinchStartTranslateX = 0;
      this.pinchStartTranslateY = 0;
    } else if (event.touches.length === 1 && this.isPinching) {
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
  
  // Keyboard listener
  private setupKeyboardListener(): void {
    // Remove any existing listener first
    this.removeKeyboardListener();
    
    this.keyboardListener = (event: KeyboardEvent) => {
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
      const isFullscreenActive = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || 
        (document as any).mozFullScreenElement || (document as any).msFullscreenElement);
      
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
  
  private removeKeyboardListener(): void {
    if (this.keyboardListener) {
      window.removeEventListener('keydown', this.keyboardListener, { capture: true });
      document.removeEventListener('keydown', this.keyboardListener, { capture: true });
      this.keyboardListener = undefined;
    }
  }
  
  // Navigation
  public nextImage(): void {
    if (this.slideshowImages.length === 0) return;
    this.currentSlideshowIndex = (this.currentSlideshowIndex + 1) % this.slideshowImages.length;
    setTimeout(() => this.resetSlideshowZoom(), 0);
  }
  
  public previousImage(): void {
    if (this.slideshowImages.length === 0) return;
    this.currentSlideshowIndex = (this.currentSlideshowIndex - 1 + this.slideshowImages.length) % this.slideshowImages.length;
    setTimeout(() => this.resetSlideshowZoom(), 0);
  }
  
  public getCurrentSlideshowImage(): string {
    if (this.slideshowImages.length === 0 || this.currentSlideshowIndex >= this.slideshowImages.length) {
      return '';
    }
    return this.slideshowImages[this.currentSlideshowIndex];
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
    const slideshowContainer = document.querySelector('.slideshow-container');
    const slideshowImageWrapper = document.querySelector('.slideshow-image-wrapper');
    const imageElement = slideshowContainer || slideshowImageWrapper;
    if (!imageElement) return;
    
    if (!this.isFullscreen) {
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
    this.removeKeyboardListener();
    this.cancelFsDownloads();
    if (this.modalRef) {
      this.modalRef.close();
    }
    try { if (typeof cRef === 'function') { cRef('Close click'); } } catch {}
    try { this.modalService.dismissAll(); } catch {}
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
      console.warn('EXIF modal template not found');
      return;
    }
    
    this.isLoadingExif = true;
    this.exifData = [];
    
    // Open modal immediately
    const exifModalRef = this.modalService.open(this.exifModal, {
      size: 'lg',
      centered: true
    });
    
    // Load EXIF data
    this.loadExifData().then(() => {
      this.isLoadingExif = false;
    }).catch((error) => {
      console.error('Error loading EXIF data:', error);
      this.isLoadingExif = false;
    });
  }
  
  private async loadExifData(): Promise<void> {
    const currentImageUrl = this.getCurrentSlideshowImage();
    if (!currentImageUrl) {
      return;
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
      
      // Get blob from image without using fetch (to avoid CSP violation)
      let blob: Blob | null = null;
      if (currentImageUrl.startsWith('blob:')) {
        // For blob URLs, get the stored blob (avoids CSP violation)
        const storedBlob = this.slideshowBlobs.get(currentImageUrl);
        if (storedBlob) {
          blob = storedBlob;
        } else {
          // If blob not stored, we'll use the image element directly (no fetch/XHR needed)
          // This avoids CSP violation because we're not making a network request
          blob = null; // Will use image element directly
        }
      } else {
        // For regular URLs, we can fetch them (they're allowed by CSP)
        try {
          const response = await fetch(currentImageUrl);
          blob = await response.blob();
        } catch (error) {
          console.error('Error fetching image:', error);
          blob = null; // Fallback to using image element directly
        }
      }
      
      // Add file size and MIME type if we have the blob
      if (blob) {
        this.exifData.push({
          label: this.translateService.instant('EVENTELEM.EXIF_FILE_SIZE'),
          value: this.formatFileSize(blob.size)
        });
        this.exifData.push({
          label: this.translateService.instant('EVENTELEM.EXIF_MIME_TYPE'),
          value: blob.type || 'image/jpeg'
        });
        // Read EXIF from blob
        await this.readExifFromBlob(blob);
      } else {
        // If we don't have the blob, try to read EXIF from blob URL directly
        if (currentImageUrl.startsWith('blob:')) {
          await this.readExifFromBlobUrl(currentImageUrl);
        } else if (imgEl && imgEl.src) {
          await this.readExifFromImageElement(imgEl);
        } else {
          // Last resort: try reading from blob URL even if we don't have imgEl
          if (currentImageUrl) {
            await this.readExifFromBlobUrl(currentImageUrl);
          }
        }
      }
      
    } catch (error) {
      console.error('Error loading EXIF data:', error);
    }
  }
  
  private async readExifFromBlob(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      // Create a temporary image element to use with EXIF.js
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      
      img.onload = () => {
        try {
          EXIF.getData(img as any, () => {
            try {
              const exifData = EXIF.getAllTags(img as any);
              // Use the shared method to process EXIF data
              this.processExifData(exifData);
            } catch (error) {
              console.error('Error processing EXIF data:', error);
            }
            URL.revokeObjectURL(objectUrl);
            resolve();
          });
        } catch (error) {
          console.error('Error reading EXIF data:', error);
          URL.revokeObjectURL(objectUrl);
          resolve();
        }
      };
      
      img.onerror = (error) => {
        console.error('Error loading image from blob:', error);
        URL.revokeObjectURL(objectUrl);
        resolve();
      };
      
      // Set src after setting up event handlers
      img.src = objectUrl;
    });
  }
  
  // Read EXIF from blob URL by creating a new image (avoids CSP violation)
  private async readExifFromBlobUrl(blobUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
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
      img.crossOrigin = 'anonymous';
      
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
  
  // Process EXIF data and add to display array
  private processExifData(exifData: any): void {
    if (!exifData) {
      return;
    }
    
    // Camera info
    if (exifData.Make) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_MAKE'),
        value: exifData.Make
      });
    }
    if (exifData.Model) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_MODEL'),
        value: exifData.Model
      });
    }
    
    // Date/Time
    if (exifData.DateTime) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_DATE_TIME'),
        value: exifData.DateTime
      });
    }
    if (exifData.DateTimeOriginal) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_DATE_TIME_ORIGINAL'),
        value: exifData.DateTimeOriginal
      });
    }
    
    // Camera settings
    if (exifData.ExposureTime) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_EXPOSURE_TIME'),
        value: `1/${Math.round(1 / exifData.ExposureTime)}s`
      });
    }
    if (exifData.FNumber) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_F_NUMBER'),
        value: `f/${exifData.FNumber}`
      });
    }
    if (exifData.ISOSpeedRatings) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_ISO'),
        value: `ISO ${exifData.ISOSpeedRatings}`
      });
    }
    if (exifData.FocalLength) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_FOCAL_LENGTH'),
        value: `${exifData.FocalLength} mm`
      });
    }
    
    // Flash
    if (exifData.Flash !== undefined) {
      const flashValue = exifData.Flash === 0 ? 
        this.translateService.instant('EVENTELEM.EXIF_FLASH_NO') : 
        this.translateService.instant('EVENTELEM.EXIF_FLASH_YES');
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_FLASH'),
        value: flashValue
      });
    }
    
    // Software
    if (exifData.Software) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_SOFTWARE'),
        value: exifData.Software
      });
    }
    
    // Orientation
    if (exifData.Orientation) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_ORIENTATION'),
        value: exifData.Orientation.toString()
      });
    }
    
    // GPS Info
    if (exifData.GPSLatitude && exifData.GPSLongitude) {
      const lat = this.convertDMSToDD(exifData.GPSLatitude, exifData.GPSLatitudeRef);
      const lon = this.convertDMSToDD(exifData.GPSLongitude, exifData.GPSLongitudeRef);
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_GPS'),
        value: `${lat.toFixed(6)}, ${lon.toFixed(6)}`
      });
    }
    
    // EXIF dimensions (if different from image dimensions)
    if (exifData.PixelXDimension) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_PIXEL_WIDTH'),
        value: `${exifData.PixelXDimension} px`
      });
    }
    if (exifData.PixelYDimension) {
      this.exifData.push({
        label: this.translateService.instant('EVENTELEM.EXIF_PIXEL_HEIGHT'),
        value: `${exifData.PixelYDimension} px`
      });
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
  
  // Detect image MIME type from ArrayBuffer data
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

