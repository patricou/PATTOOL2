import { Component, OnInit, Input, Output, ViewChild, EventEmitter, AfterViewInit, TemplateRef, ElementRef } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource, SlideshowLocationEvent } from '../../shared/slideshow-modal/slideshow-modal.component';
import { PhotosSelectorModalComponent, PhotosSelectionResult } from '../../shared/photos-selector-modal/photos-selector-modal.component';
import { TraceViewerModalComponent } from '../../shared/trace-viewer-modal/trace-viewer-modal.component';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
// Removed ng2-file-upload - using native HTML file input
import { NgbModal, NgbRatingConfig, NgbTooltip } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import * as JSZip from 'jszip';

import { Observable, firstValueFrom, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
import { UploadedFile } from '../../model/uploadedfile';
import { Member } from '../../model/member';
import { Evenement } from '../../model/evenement';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { environment } from '../../../environments/environment';
import { WindowRefService } from '../../services/window-ref.service';
import { FileService, ImageDownloadResult } from '../../services/file.service';

@Component({
	selector: 'element-evenement',
	templateUrl: './element-evenement.component.html',
	styleUrls: ['./element-evenement.component.css'],
	providers: [NgbRatingConfig]
})
export class ElementEvenementComponent implements OnInit, AfterViewInit {

	public selectedFiles: File[] = [];
	public API_URL: string = environment.API_URL;
	public API_URL4FILE: string = environment.API_URL4FILE;
	public showParticipantsList: boolean = false;
	public showFilesList: boolean = false;
	// Upload logs
	public uploadLogs: string[] = [];
	public isUploading: boolean = false;
	// Evaluate rating
	public currentRate: number = 0;
	public safePhotosUrl: SafeUrl = {} as SafeUrl;
	// Native Window
	public nativeWindow: any;
	// Thumbnail image
	public thumbnailUrl: any = "assets/images/images.jpg";
	public selectedUser: Member | null = null;
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
	// Color calculation mode: true = full image, false = top 30%
	public useFullImageForColor: boolean = false;

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
	@ViewChild('traceViewerModalComponent') traceViewerModalComponent!: TraceViewerModalComponent;
	@ViewChild('thumbnailImage', { static: false }) thumbnailImageRef!: ElementRef<HTMLImageElement>;
	@ViewChild('cardSlideImage', { static: false }) cardSlideImageRef!: ElementRef<HTMLImageElement>;

	// FS Photos slideshow loading control
	private fsSlideshowLoadingActive: boolean = false;
	private fsSlideshowSubs: Subscription[] = [];
	
	// File thumbnails cache
	private fileThumbnailsCache: Map<string, SafeUrl> = new Map();
	private fileThumbnailsLoading: Set<string> = new Set();
	private solidColorCache: Map<number, string> = new Map();
	private buttonGradientCache: Map<string, string> = new Map();
	private fileBadgeColorCache: Map<string, string> = new Map();
	private fileBadgeTextColorCache: Map<string, string> = new Map();
	private fileBadgeComponentsCache: Map<string, { r: number; g: number; b: number }> = new Map();
	private photoFrameStylesCache: { [key: string]: string } | null = null;
	private photoImageStylesCache: { [key: string]: string } | null = null;
	private photoBorderColorCache: string | null = null;
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
		'1': 'EVENTCREATION.TYPE.VTT'
	};

	@ViewChild('jsonModal')
	public jsonModal!: TemplateRef<any>;
	@ViewChild('photosSelectorModalComponent') photosSelectorModalComponent!: PhotosSelectorModalComponent;
	@ViewChild('commentsModal') commentsModal!: TemplateRef<any>;
	@ViewChild('userModal') userModal!: TemplateRef<any>;
	@ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;
	@ViewChild('logContent') logContent: any;

	@Input()
	evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);

	@Input()
	user: Member = new Member("", "", "", "", "", [], "");

	@Input()
	titleOnly: boolean = false;

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

	constructor(
		private sanitizer: DomSanitizer,
		private _router: Router,
		private modalService: NgbModal,
		private ratingConfig: NgbRatingConfig,
		private _fileService: FileService,
		private winRef: WindowRefService,
		private translateService: TranslateService
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
		// Photos uploadées: count as 1 if any exist
		if (this.hasImageFiles()) {
			count += 1;
		}
		// Each FS link counts as 1
		count += this.getPhotoFromFsCount();
		// Each web photo link counts as 1
		count += this.getPhotosUrlLinks().length;
		return count;
	}

    public openFsPhotosSelector(includeUploadedChoice: boolean = false): void {
        this.forceCloseTooltips();
        const fsLinks = this.getPhotoFromFsLinks();
        const webLinks = this.getPhotosUrlLinks();
        const hasAnyLinks = (fsLinks.length + webLinks.length) > 0;

        if (!includeUploadedChoice && !hasAnyLinks) {
            return;
        }
        if (!includeUploadedChoice && fsLinks.length === 1 && webLinks.length === 0) {
            this.openFsPhotosDiaporama(fsLinks[0].link, true);
            return;
        }
        
        // Use the new photos selector modal component
        if (this.photosSelectorModalComponent) {
            this.photosSelectorModalComponent.evenement = this.evenement;
            this.photosSelectorModalComponent.includeUploadedChoice = includeUploadedChoice;
            this.photosSelectorModalComponent.open();
        }
    }

    public onPhotosSelectionConfirmed(result: PhotosSelectionResult): void {
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
		
		// Open modal immediately with empty array
		this.slideshowModalComponent.open([], this.evenement.evenementName, false);
		
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
	}

	public onSlideshowClosed(): void {
		this.fsSlideshowLoadingActive = false;
		this.fsSlideshowSubs.forEach(sub => {
			if (sub && !sub.closed) {
				sub.unsubscribe();
			}
		});
		this.fsSlideshowSubs = [];
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.setTraceViewerOpen(false);
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

		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.setTraceViewerOpen(true);
		}

		if (this.traceViewerModalComponent) {
			this.traceViewerModalComponent.openAtLocation(event.lat, event.lng, label);
		}
	}

	public onTraceViewerClosed(): void {
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.setTraceViewerOpen(false);
		}
	}

	// Unified photos opener (uploaded photos or FS photos)
	public openPhotos(): void {
		this.forceCloseTooltips();
		const hasFs = this.getPhotoFromFsCount() > 0;
		const hasPhotosWeb = this.getPhotosUrlLinks().length > 0;
		const hasUploaded = this.hasImageFiles();

		if ((hasFs || hasPhotosWeb) && hasUploaded) {
			this.openFsPhotosSelector(true);
			return;
		}
		if (hasFs || hasPhotosWeb) {
			this.openFsPhotosSelector(false);
			return;
		}
		if (hasUploaded) {
			this.openSlideshow();
		}
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
		if (!this.applyCachedStyles(this.getThumbnailSignature())) {
			this.setThumbnailImage();
		}
		
		// Initialize commentaries if not present
		this.initializeCommentaries();
		
		// Setup tooltip auto-close on modal open
		this.setupTooltipAutoClose();
	}
	
	public onFileSelected(event: any): void {
		const files: FileList = event.target.files;
		if (files && files.length > 0) {
			this.selectedFiles = Array.from(files);
			this.uploadFiles();
		}
	}

	private uploadFiles(): void {
		if (this.selectedFiles.length === 0) {
			console.log('No files to upload');
			return;
		}

		this.isUploading = true;
		this.uploadLogs = [];
		
		// Open upload logs modal
		let modalRef: any;
		if (this.uploadLogsModal) {
			modalRef = this.modalService.open(this.uploadLogsModal, {
				centered: true,
				backdrop: 'static',
				keyboard: false,
				size: 'xl',
				windowClass: 'upload-logs-modal'
			});
		}
		
		// Generate session ID
		const sessionId = this.generateSessionId();
		
		// Initialize logs
		this.addLog(`📤 Starting upload of ${this.selectedFiles.length} file(s)...`);

		// Check if any of the selected files are images
		const imageFiles = this.selectedFiles.filter(file => this.isImageFileByMimeType(file));
		
		// Only ask for thumbnail if there's exactly ONE file selected
		if (imageFiles.length > 0 && this.selectedFiles.length === 1) {
			// Ask user if they want to use the image as activity thumbnail
			const imageFile = imageFiles[0]; // Use first image file
			const useAsThumbnail = confirm(`Voulez-vous utiliser "${imageFile.name}" comme image de cette activité ?`);
			
			if (useAsThumbnail) {
				// Modify the filename to add "thumbnail" in the middle
				const modifiedFileName = this.addThumbnailToFileName(imageFile.name);
				// console.log("Modified filename:", modifiedFileName);
				
				// Create a new File object with the modified name
				const modifiedFile = new File([imageFile], modifiedFileName, { type: imageFile.type });
				
				// Replace the original file in the array
				const fileIndex = this.selectedFiles.indexOf(imageFile);
				this.selectedFiles[fileIndex] = modifiedFile;
			}
		}

		const formData = new FormData();
		for (let file of this.selectedFiles) {
			formData.append('file', file, file.name);
		}
		
		// Add sessionId to FormData
		if (sessionId) {
			formData.append('sessionId', sessionId);
		}

		// Build the correct upload URL with user ID and event ID
		const uploadUrl = `${this.API_URL4FILE}/${this.user.id}/${this.evenement.id}`;

		// Start polling for server logs
		let lastLogCount = 0;
		const pollInterval = setInterval(() => {
			this._fileService.getUploadLogs(sessionId).subscribe(
				(serverLogs: string[]) => {
					if (serverLogs.length > lastLogCount) {
						// New logs available
						for (let i = lastLogCount; i < serverLogs.length; i++) {
							this.addLog(serverLogs[i]);
						}
						lastLogCount = serverLogs.length;
					}
				},
				(error: any) => {
					console.error('Error fetching logs:', error);
				}
			);
		}, 500); // Poll every 500ms

		this._fileService.postFileToUrl(formData, this.user, uploadUrl, sessionId)
			.subscribe({
				next: (response: any) => {
					
					// Wait a bit for final logs
						setTimeout(() => {
							clearInterval(pollInterval);
							
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
							
						setTimeout(() => {
							this.isUploading = false;
							// Don't close modal automatically, let user close it manually
						}, 1000);
						}, 500);
				},
				error: (error: any) => {
					clearInterval(pollInterval);
					console.error('File upload error:', error);
					
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
					
					setTimeout(() => {
						this.isUploading = false;
						// Don't close modal automatically, let user close it manually
					}, 1000);
				}
			});
	}

	private addLog(message: string): void {
		this.uploadLogs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
		
		// Auto-scroll to top to show latest log
		setTimeout(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		}, 0);
	}

	private addSuccessLog(message: string): void {
		this.uploadLogs.unshift(`SUCCESS: [${new Date().toLocaleTimeString()}] ${message}`);
		
		// Auto-scroll to top to show latest log
		setTimeout(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		}, 0);
	}

	private addErrorLog(message: string): void {
		this.uploadLogs.unshift(`ERROR: [${new Date().toLocaleTimeString()}] ${message}`);
		
		// Auto-scroll to top to show latest log
		setTimeout(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		}, 0);
	}

	private generateSessionId(): string {
		return 'upload-' + Date.now() + '-' + Math.random().toString(36).substring(7);
	}

	private handleUploadResponse(response: any): void {
		try {
			// console.log('Processing upload response:', response);
			
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
				console.log('No file information in response, creating entries from selected files');
				this.createUploadedFileEntries();
			}
		} catch (error) {
			console.error('Error processing upload response:', error);
			// Fallback: create uploaded file entries based on selected files
			this.createUploadedFileEntries();
		}
	}

	private addUploadedFilesToEvent(uploadedFilesData: any[]): void {
		let hasThumbnailFile = false;
		
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
				// console.log('Thumbnail file detected:', uploadedFile.fileName);
			}
			
			// Add to event's file list if not already present
			const existingFile = this.evenement.fileUploadeds.find(f => f.fieldId === uploadedFile.fieldId);
			if (!existingFile) {
				this.evenement.fileUploadeds.push(uploadedFile);
			}
		}
		
		// If a thumbnail file was uploaded, remove "thumbnail" from old files and update
		if (hasThumbnailFile) {
			// console.log('Thumbnail file uploaded, cleaning up old thumbnails...');
			
			// Remove "thumbnail" from any old thumbnail files
			let hasModifiedFiles = false;
			this.evenement.fileUploadeds.forEach(fileUploaded => {
				// Skip the newly uploaded file
				const isNewFile = uploadedFilesData.some(f => 
					(f.fieldId || f.id) === fileUploaded.fieldId
				);
				
				// If not the new file and contains "thumbnail", clean it up
				if (!isNewFile && fileUploaded.fileName && fileUploaded.fileName.toLowerCase().includes('thumbnail')) {
					const newName = fileUploaded.fileName.replace(/thumbnail/gi, '').replace(/\s+/g, '');
					// console.log(`Removing thumbnail from old file: ${fileUploaded.fileName} → ${newName}`);
					fileUploaded.fileName = newName;
					hasModifiedFiles = true;
				}
			});
			
			// Update the event in database if we modified any file names
			if (hasModifiedFiles) {
				// console.log('Updating event with cleaned file names...');
				this.updateEvenement.emit(this.evenement);
			}
			
			this.reloadEventCard();
		}
		
		// Don't emit update event since the database upload already updated the event
		// this.updateFileUploaded.emit(this.evenement);
	}

	private createUploadedFileEntries(): void {
		// Fallback method: create uploaded file entries based on selected files
		let hasThumbnailFile = false;
		const newUploadedFiles: UploadedFile[] = [];
		
		for (let file of this.selectedFiles) {
			const uploadedFile = new UploadedFile(
				this.generateFileId(),
				file.name,
				file.type || 'unknown',
				this.user
			);
			
			// Check if this file contains "thumbnail" in its name
			if (uploadedFile.fileName && uploadedFile.fileName.toLowerCase().includes('thumbnail')) {
				hasThumbnailFile = true;
				console.log('Thumbnail file detected in fallback:', uploadedFile.fileName);
			}
			
			// Add to event's file list if not already present
			const existingFile = this.evenement.fileUploadeds.find(f => f.fileName === uploadedFile.fileName);
			if (!existingFile) {
				this.evenement.fileUploadeds.push(uploadedFile);
				newUploadedFiles.push(uploadedFile);
			}
		}
		
		// If a thumbnail file was uploaded, remove "thumbnail" from old files and update
		if (hasThumbnailFile) {
			console.log('Thumbnail file uploaded in fallback, cleaning up old thumbnails...');
			
			// Remove "thumbnail" from any old thumbnail files
			let hasModifiedFiles = false;
			this.evenement.fileUploadeds.forEach(fileUploaded => {
				// Skip the newly uploaded files
				const isNewFile = newUploadedFiles.some(f => f.fieldId === fileUploaded.fieldId);
				
				// If not a new file and contains "thumbnail", clean it up
				if (!isNewFile && fileUploaded.fileName && fileUploaded.fileName.toLowerCase().includes('thumbnail')) {
					const newName = fileUploaded.fileName.replace(/thumbnail/gi, '').replace(/\s+/g, '');
					console.log(`Removing thumbnail from old file: ${fileUploaded.fileName} → ${newName}`);
					fileUploaded.fileName = newName;
					hasModifiedFiles = true;
				}
			});
			
			// Update the event in database if we modified any file names
			if (hasModifiedFiles) {
				console.log('Updating event with cleaned file names...');
				this.updateEvenement.emit(this.evenement);
			}
			
			this.reloadEventCard();
		}
		
		// Don't emit update event since the database upload already updated the event
		// this.updateFileUploaded.emit(this.evenement);
	}

	private generateFileId(): string {
		// Generate a unique file ID (you might want to use a proper UUID generator)
		return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
	}
	// Set image thumbnail - USE GETFILE for display (with resizing)
	public setThumbnailImage() {
		const signature = this.getThumbnailSignature();
		if (this.applyCachedStyles(signature)) {
			return;
		}

		if (this.evenement.fileUploadeds.length != 0) {
			this.evenement.fileUploadeds.map(fileUploaded => {
				if (fileUploaded.fileName.indexOf('thumbnail') !== -1) {
					// Check if we have a cached blob URL for this file
					const cachedBlobUrl = ElementEvenementComponent.blobUrlCache.get(fileUploaded.fieldId);
					if (cachedBlobUrl) {
						// Reuse cached blob URL
						this.thumbnailUrl = cachedBlobUrl;
						// Detect dominant color after image loads
						setTimeout(() => {
							this.detectDominantColor();
						}, 100);
					} else {
						// Load and cache the blob URL
						this._fileService.getFile(fileUploaded.fieldId).pipe(
							map((res: any) => {
								let blob = new Blob([res], { type: 'application/octet-stream' });
								let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
								return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
							})
						).subscribe((safeUrl: SafeUrl) => {
							// Cache the blob URL so it persists across component destruction
							ElementEvenementComponent.blobUrlCache.set(fileUploaded.fieldId, safeUrl);
							this.thumbnailUrl = safeUrl;
							// Detect dominant color after image loads
							setTimeout(() => {
								this.detectDominantColor();
							}, 100);
						});
					}
				}
			}
			)
		} else {
			// Reset to default color if no thumbnail
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			this.titleBorderColor = 'rgba(0, 0, 0, 0.8)';
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

	// Detect dominant color from the top portion of the thumbnail image
	public detectDominantColor(): void {
		// Wait a bit for the image to be in the DOM
		setTimeout(() => {
			if (!this.thumbnailImageRef || !this.thumbnailImageRef.nativeElement) {
				return;
			}

			const img = this.thumbnailImageRef.nativeElement;
			
			// Check if image is loaded
			if (!img.complete || img.naturalWidth === 0) {
				// Wait for image to load
				img.onload = () => {
					this.processImageColor(img);
				};
				return;
			}

			this.processImageColor(img);
		}, 200);
	}

	// Detect dominant color from the current slideshow image
	public detectDominantColorFromSlideshow(): void {
		// Wait a bit for the image to be in the DOM
		setTimeout(() => {
			if (!this.cardSlideImageRef || !this.cardSlideImageRef.nativeElement) {
				return;
			}

			const img = this.cardSlideImageRef.nativeElement;
			
			// Check if image is loaded
			if (!img.complete || img.naturalWidth === 0) {
				// Wait for image to load
				img.onload = () => {
					this.processImageColor(img);
				};
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

		this.colorComputed.emit({
			eventId: eventKey,
			color: {
				r: clamp(this.dominantR),
				g: clamp(this.dominantG),
				b: clamp(this.dominantB)
			}
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
	private processImageColor(img: HTMLImageElement): void {
		try {
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d');
			
			if (!ctx) {
				return;
			}

			// Set canvas size to match image
			canvas.width = img.naturalWidth || img.width;
			canvas.height = img.naturalHeight || img.height;

			// Draw image to canvas
			ctx.drawImage(img, 0, 0);

			// Determine sample area based on mode
			let sampleHeight: number;
			let sampleWidth: number;
			let startX: number = 0;
			let startY: number = 0;

			if (this.useFullImageForColor) {
				// Sample the full image
				sampleHeight = canvas.height;
				sampleWidth = canvas.width;
			} else {
				// Sample the top portion of the image (top 30%)
				sampleHeight = Math.floor(canvas.height * 0.3);
				sampleWidth = canvas.width;
			}

			// Get image data from selected portion
			const imageData = ctx.getImageData(startX, startY, sampleWidth, sampleHeight);
			const pixels = imageData.data;

			// Calculate average color
			let r = 0, g = 0, b = 0;
			let pixelCount = 0;

			// Sample every 10th pixel for performance
			for (let i = 0; i < pixels.length; i += 40) { // RGBA = 4 bytes, skip 10 pixels
				r += pixels[i];
				g += pixels[i + 1];
				b += pixels[i + 2];
				pixelCount++;
			}

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

				// Start with white or black as base, then tint with the average color
				// Mix 82% base color (white/black) with 18% average color for a subtle tint
				let tintR: number, tintG: number, tintB: number;
				
				if (brightness < 128) {
					// Dark image: use white as base, tinted with average color
					tintR = Math.floor(255 * 0.82 + r * 0.18);
					tintG = Math.floor(255 * 0.82 + g * 0.18);
					tintB = Math.floor(255 * 0.82 + b * 0.18);
				} else {
					// Light image: use black as base, tinted with average color
					tintR = Math.floor(0 * 0.82 + r * 0.18);
					tintG = Math.floor(0 * 0.82 + g * 0.18);
					tintB = Math.floor(0 * 0.82 + b * 0.18);
				}
				
				// Use the lightly tinted color for border and text
				this.titleBorderColor = `rgba(${tintR}, ${tintG}, ${tintB}, 0.95)`;
				
			}
			this.invalidateColorCaches();
			this.emitDominantColor();
			this.cacheCurrentStyles(this.getThumbnailSignature());
		} catch (error) {
			console.error('Error detecting dominant color:', error);
			// Fallback to default color
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			this.descriptionBackgroundColor = 'rgba(255, 255, 255, 1)';
			this.titleBorderColor = 'rgba(0, 0, 0, 0.8)';
			this.dominantR = 128;
			this.dominantG = 128;
			this.dominantB = 128;
			this.invalidateColorCaches();
			this.emitDominantColor();
			this.cacheCurrentStyles();
		}
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
		if (!this.evenement || !this.evenement.fileUploadeds) {
			return 'no-thumbnail';
		}
		const thumbnailFile = this.evenement.fileUploadeds.find(file => file.fileName && file.fileName.indexOf('thumbnail') !== -1);
		return thumbnailFile ? thumbnailFile.fieldId : 'no-thumbnail';
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

		if (expectedSignature && cached.signature !== expectedSignature) {
			return false;
		}

		// For blob URLs, verify they're still in the persistent cache
		if (cached.thumbnailUrl && typeof cached.thumbnailUrl === 'object' && 
			'changingThisBreaksApplicationSecurity' in cached.thumbnailUrl) {
			const url = cached.thumbnailUrl['changingThisBreaksApplicationSecurity'];
			if (url && typeof url === 'string' && url.startsWith('blob:')) {
				// Check if this blob URL is still in our persistent cache
				// Find the fileId that corresponds to this blob URL
				const thumbnailFile = this.evenement.fileUploadeds?.find(file => 
					file.fileName && file.fileName.indexOf('thumbnail') !== -1
				);
				if (thumbnailFile) {
					const cachedBlobUrl = ElementEvenementComponent.blobUrlCache.get(thumbnailFile.fieldId);
					if (cachedBlobUrl && cachedBlobUrl === cached.thumbnailUrl) {
						// Blob URL is still in cache, use it
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
				// Blob URL not in persistent cache, don't use cached styles
				return false;
			}
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

	public getPhotoFrameStyles(): { [key: string]: string } {
		if (!this.photoFrameStylesCache) {
			this.photoFrameStylesCache = {
				position: 'relative',
				backgroundColor: this.getSolidColor(0.35),
				borderRadius: '8px',
				padding: '7px 7px 0 7px',
				boxShadow: 'none',
				boxSizing: 'border-box'
			};
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
				boxSizing: 'border-box'
			};
		}
		return this.photoImageStylesCache;
	}
	
	// Get color for a specific button type - basé uniquement sur la couleur calculée
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

			const textColor = isBright ? '#020617' : '#fdfcff';
			const borderColor = this.buildAdjustedColor(isBright ? -145 : 140, 0.97);
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
	
	// Solid color for files list - basé sur la couleur calculée
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
			const r = this.dominantR;
			const g = this.dominantG;
			const b = this.dominantB;

			const lightR = this.adjustColorComponent(r, 110);
			const lightG = this.adjustColorComponent(g, 110);
			const lightB = this.adjustColorComponent(b, 110);

			const darkR = this.adjustColorComponent(r, -120);
			const darkG = this.adjustColorComponent(g, -120);
			const darkB = this.adjustColorComponent(b, -120);

			const startColor = `rgba(${lightR}, ${lightG}, ${lightB}, 0.9)`;
			const endColor = `rgba(${darkR}, ${darkG}, ${darkB}, 0.95)`;

			this.cardBackgroundGradientCache = `linear-gradient(155deg, ${startColor}, ${endColor})`;
		}
		return this.cardBackgroundGradientCache;
	}
	
	// Get gradient for status badges - basé sur la couleur calculée
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

	private getFileTypeKey(fileName: string): 'image' | 'pdf' | 'other' {
		if (this.isImageFile(fileName)) {
			return 'image';
		}
		if (this.isPdfFile(fileName)) {
			return 'pdf';
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
		const cacheKey = fileName || '';
		let cached = this.fileBadgeTextColorCache.get(cacheKey);
		if (!cached) {
			const { r, g, b } = this.getFileBadgeColorComponents(fileName);
			const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
			cached = brightness > 160 ? 'rgba(0, 0, 0, 0.85)' : 'white';
			this.fileBadgeTextColorCache.set(cacheKey, cached);
		}
		return cached;
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
		const delta = isRemove ? -40 : 75;
		const { r, g, b } = this.getAdjustedDominantColor(delta);
		return this.buildColorString(r, g, b, 1);
	}

	private getParticipantButtonTextColor(isRemove: boolean): string {
		const delta = isRemove ? -70 : 55;
		const { r, g, b } = this.getAdjustedDominantColor(delta);
		return this.getColorBrightness(r, g, b) > 160 ? 'rgba(0, 0, 0, 0.85)' : 'white';
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
		const { r, g, b } = this.getAdjustedDominantColor(55);
		return this.buildColorString(r, g, b, 1);
	}

	private getParticipantBadgeTextColor(): string {
		const { r, g, b } = this.getAdjustedDominantColor(35);
		return this.getColorBrightness(r, g, b) > 160 ? 'rgba(0, 0, 0, 0.85)' : 'white';
	}

	// Get gradient for visibility badges - basé sur la couleur calculée
	public getVisibilityBadgeGradient(): string {
		if (!this.visibilityBadgeGradientCache) {
			this.visibilityBadgeGradientCache = this.getButtonGradientForType('visibility', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.visibilityBadgeGradientCache;
	}
	
	// Get gradient for download all button - basé sur la couleur calculée
	public getDownloadAllButtonGradient(): string {
		if (!this.downloadAllButtonGradientCache) {
			this.downloadAllButtonGradientCache = this.getButtonGradientForType('download', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.downloadAllButtonGradientCache;
	}
	
	// Get gradient for rating badges - basé sur la couleur calculée
	public getRatingBadgeGradient(): string {
		if (!this.ratingBadgeGradientCache) {
			this.ratingBadgeGradientCache = this.getButtonGradientForType('rating', this.dominantR, this.dominantG, this.dominantB);
		}
		return this.ratingBadgeGradientCache;
	}
	// Detect color after view is initialized
	ngAfterViewInit() {
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
		//console.log("File Id : " + fieldId);
		if (confirm("Are you sure you want to delete the file ? ")) {
			// Find the file being deleted to check if it contains "thumbnail"
			const fileToDelete = this.evenement.fileUploadeds.find(fileUploaded => fileUploaded.fieldId === fieldId);
			let isThumbnailFile = false;
			
			if (fileToDelete && fileToDelete.fileName && fileToDelete.fileName.toLowerCase().includes('thumbnail')) {
				isThumbnailFile = true;
				console.log('Thumbnail file being deleted:', fileToDelete.fileName);
			}
			
			// Remove the file from the list
			this.evenement.fileUploadeds = this.evenement.fileUploadeds.filter(fileUploaded => !(fileUploaded.fieldId == fieldId));
			this.updateFileUploaded.emit(this.evenement);
			
			// If a thumbnail file was deleted, reload the card
			if (isThumbnailFile) {
				console.log('Thumbnail file deleted, reloading card...');
				this.reloadEventCard();
			}
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

	// open URLs modal
	public openUrlsModal(content: any) {
		this.forceCloseTooltips();
		this.modalService.open(content, { size: 'lg', centered: true, backdrop: 'static', keyboard: false });
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
		
		// Always mention chat messages (Firebase) regardless of count
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

	public isAnyParticpants(): boolean {
		return this.evenement.members.length > 0;
	}

	public toggleParticipantsList(): void {
		this.showParticipantsList = !this.showParticipantsList;
	}
	
	// Show participants section (used when clicking add member button)
	public showParticipantsSection(): void {
		this.showParticipantsList = true;
	}

	public toggleFilesList(): void {
		this.showFilesList = !this.showFilesList;
		// Load thumbnails when list is opened
		if (this.showFilesList) {
			this.loadFileThumbnails();
		}
	}
	
	// Load thumbnails for all image files
	private loadFileThumbnails(): void {
		if (!this.evenement.fileUploadeds || this.evenement.fileUploadeds.length === 0) {
			return;
		}
		
		// Filter image files and load their thumbnails
		const imageFiles = this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
		
		imageFiles.forEach(file => {
			// Skip if already cached or loading
			if (this.fileThumbnailsCache.has(file.fieldId) || this.fileThumbnailsLoading.has(file.fieldId)) {
				return;
			}
			
			// Mark as loading
			this.fileThumbnailsLoading.add(file.fieldId);
			
			// Load the file and create thumbnail URL
			this._fileService.getFile(file.fieldId).pipe(
				map((res: any) => {
					const blob = new Blob([res], { type: 'application/octet-stream' });
					const objectUrl = this.nativeWindow.URL.createObjectURL(blob);
					return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
				})
			).subscribe({
				next: (safeUrl: SafeUrl) => {
					this.fileThumbnailsCache.set(file.fieldId, safeUrl);
					this.fileThumbnailsLoading.delete(file.fieldId);
				},
				error: (error) => {
					console.error('Error loading thumbnail for file:', file.fileName, error);
					this.fileThumbnailsLoading.delete(file.fieldId);
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
		this.modalService.open(content, { size: 'lg', centered: true, backdrop: 'static', keyboard: false });
	}

	// Open photos modal from parent component
	public openPhotosModalFromParent() {
		console.log("Opening photos modal for event:", this.evenement.evenementName);
		this.openPhotosModal.emit(this.evenement);
	}

	// Open photo in new tab
	public openPhotoInNewTab(photoUrl: string) {
		console.log("Opening photo in new tab:", photoUrl);
		this.nativeWindow.open(photoUrl, '_blank');
	}

	hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}

	// Open JSON modal
	public openJsonModal() {
		console.log("Opening JSON modal for event:", this.evenement.evenementName);
		this.forceCloseTooltips();
		
		if (this.jsonModal) {
			this.modalService.open(this.jsonModal, { size: 'lg', backdrop: 'static', keyboard: false });
		} else {
			console.error('JSON modal template not found');
		}
	}

	// Get event as formatted JSON
	public getEventAsJson(): string {
		return JSON.stringify(this.evenement, null, 2);
	}

	// for file list toogle
	public tfl: boolean = true;
	public toogleFileListe() {
		this.tfl = !this.tfl;
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
				// remove the 				
				setTimeout(function () {
					natw.document.body.removeChild(link);
					natw.URL.revokeObjectURL(objectUrl);
				}, 5000);
			}
			//this.nativeWindow.open(objectUrl);
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
		
		console.log('Starting download of all files:', this.evenement.fileUploadeds.length);
		
		try {
			// Create a new ZIP file
			const zip = new JSZip();
			let successCount = 0;
			
			// Download all files and add them to the ZIP
			const downloadPromises = this.evenement.fileUploadeds.map(async (file) => {
				try {
					console.log(`Fetching file: ${file.fileName}`);
					const blob = await firstValueFrom(this.getFileBlobUrl(file.fieldId));
					zip.file(file.fileName, blob);
					successCount++;
					console.log(`Added to ZIP: ${file.fileName} (${successCount}/${this.evenement.fileUploadeds.length})`);
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
			console.log('Generating ZIP file...');
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
			
			console.log(`ZIP file downloaded successfully with ${successCount} file(s)`);
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

		if (hasChanges) {
			this.reloadEventCard();
		}
	}

	public isThumbnailFile(uploadedFile: UploadedFile | null | undefined): boolean {
		const name = uploadedFile && uploadedFile.fileName ? uploadedFile.fileName.toLowerCase() : '';
		return name.includes('thumbnail');
	}

	// Reload the event card thumbnail when a thumbnail file is uploaded/deleted
	private reloadEventCard(): void {
		// console.log('Reloading thumbnail for event:', this.evenement.evenementName);
		
		// Find the thumbnail file in the uploaded files
		const thumbnailFile = this.evenement.fileUploadeds.find(file => 
			file.fileName && file.fileName.toLowerCase().includes('thumbnail')
		);
		
		if (thumbnailFile) {
			// console.log('Found thumbnail file:', thumbnailFile.fileName);
			// Update the thumbnail URL to force refresh
			this.setThumbnailImage();
		} else {
			// console.log('No thumbnail file found, using default image');
			// Reset to default image if no thumbnail file exists
			this.thumbnailUrl = "assets/images/images.jpg";
			// Reset to default color
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			this.titleBorderColor = 'rgba(0, 0, 0, 0.8)';
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
		
		return type ? type.label : normalizedType;
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
			// Normaliser le type pour le regroupement
			const normalizedType = this.normalizeTypeForGrouping(urlEvent.typeUrl || 'OTHER');
			if (!groups[normalizedType]) {
				groups[normalizedType] = [];
			}
			groups[normalizedType].push(urlEvent);
			return groups;
		}, {});
	}

	// Normaliser le type pour le regroupement (utilise la même logique que getUrlTypeLabel)
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
		
		// Mapper la langue actuelle à la locale appropriée
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
		
		// Formater la date et l'heure selon la locale de la langue sélectionnée
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
		
		// Mapper la langue actuelle à la locale appropriée
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
		
		// Formater la date selon la locale de la langue sélectionnée
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
		
		// Mapper la langue actuelle à la locale appropriée
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
		
		// Formater la date selon la locale de la langue sélectionnée
		const formattedDate = eventDate.toLocaleDateString(locale, {
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		});
		
		// Extraire l'heure de la date si startHour est vide
		let timeToDisplay = time;
		if (!timeToDisplay || timeToDisplay.trim() === '') {
			timeToDisplay = eventDate.toLocaleTimeString(locale, {
				hour: '2-digit',
				minute: '2-digit'
			});
		}
		
		// Ajouter l'heure si elle existe
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

	// Handle file click based on file type
	public handleFileClick(uploadedFile: UploadedFile): void {
		if (this.isImageFile(uploadedFile.fileName)) {
			this.openSingleImageInSlideshow(uploadedFile.fieldId, uploadedFile.fileName);
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
			this.traceViewerModalComponent.openFromFile(uploadedFile.fieldId, uploadedFile.fileName);
		} else {
			console.warn('Track viewer modal component is not available');
		}
	}

	// Open PDF file in new tab
	public openPdfFile(fileId: string, fileName: string): void {
		console.log('Opening PDF file:', fileName, 'with ID:', fileId);
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			console.log('Blob received:', blob);
			
			// Create a new blob with proper MIME type for PDF
			const pdfBlob = new Blob([blob], { type: 'application/pdf' });
			
			// Create object URL for the blob
			const objectUrl = URL.createObjectURL(pdfBlob);
			console.log('Object URL created:', objectUrl);
			
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
			console.error('Error loading PDF file:', error);
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
		
		// Don't revoke blob URLs if they're in the persistent cache
		// This allows them to be reused when components are recreated
		if (this.thumbnailUrl && typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl) {
			try {
				const url = this.thumbnailUrl['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					// Check if this blob URL is in the persistent cache
					const thumbnailFile = this.evenement.fileUploadeds?.find(file => 
						file.fileName && file.fileName.indexOf('thumbnail') !== -1
					);
					if (thumbnailFile) {
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
				console.warn('Error cleaning up blob URL:', error);
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
		this.solidColorCache.clear();
	}

	public hasComments(): boolean {
		return this.evenement.commentaries && this.evenement.commentaries.length > 0;
	}

	public getCommentsCount(): number {
		return this.evenement.commentaries ? this.evenement.commentaries.length : 0;
	}

	public getFilesCount(): number {
		return this.evenement.fileUploadeds ? this.evenement.fileUploadeds.length : 0;
	}

	public getEventComments(): any[] {
		if (!this.evenement.commentaries || this.evenement.commentaries.length === 0) {
			return [];
		}
		
		// Trier les commentaires par date de création décroissante (plus récent en premier)
		return this.evenement.commentaries.sort((a, b) => {
			const dateA = new Date(a.dateCreation).getTime();
			const dateB = new Date(b.dateCreation).getTime();
			return dateB - dateA;
		});
	}

	public openCommentsModal(): void {
		this.forceCloseTooltips();
		this.modalService.open(this.commentsModal, { 
			size: 'lg',
			backdrop: 'static',
			keyboard: false,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('Comments modal closed with:', result);
		}, (reason) => {
			console.log('Comments modal dismissed:', reason);
		});
	}

	public openUserModal(user: Member): void {
		this.forceCloseTooltips();
		this.selectedUser = user;
		if (!this.userModal) {
			return;
		}

		this.modalService.open(this.userModal, {
			size: 'md',
			centered: true,
			backdrop: 'static',
			keyboard: false,
			animation: true
		});
	}

	public sendEmail(email: string): void {
		window.open(`mailto:${email}`, '_blank');
	}

	// Listen to fullscreen events
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

	// Open slideshow modal with all images from this card
	public openSlideshow(): void {
		this.forceCloseTooltips();
		// Filter to get only image files
		const imageFiles = this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
		
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

		// Open the slideshow modal immediately - images will be loaded dynamically
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.open(imageSources, this.evenement.evenementName, true);
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

		// Open the slideshow modal with just this one image
		if (this.slideshowModalComponent) {
			this.slideshowModalComponent.open([imageSource], this.evenement.evenementName, true);
		}
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

	// Toggle color calculation mode (full image vs top 30%)
	public toggleColorCalculationMode(): void {
		this.useFullImageForColor = !this.useFullImageForColor;
		
		// Force immediate recalculation with new mode
		// Use a small delay to ensure the mode change is processed
		setTimeout(() => {
			// Recalculate color for thumbnail image
			if (this.thumbnailImageRef && this.thumbnailImageRef.nativeElement) {
				const img = this.thumbnailImageRef.nativeElement;
				// Check if image is loaded
				if (img.complete && img.naturalWidth > 0) {
					// Force recalculation immediately using the existing method
					this.processImageColor(img);
				} else {
					// Wait for image to load then recalculate
					img.onload = () => {
						this.processImageColor(img);
					};
				}
			}
			
			// Also recalculate if slideshow is active
			if (this.isCardSlideshowActive && this.cardSlideImageRef && this.cardSlideImageRef.nativeElement) {
				const img = this.cardSlideImageRef.nativeElement;
				if (img.complete && img.naturalWidth > 0) {
					// Force recalculation immediately using the existing method
					this.processImageColor(img);
				} else {
					// Wait for image to load then recalculate
					img.onload = () => {
						this.processImageColor(img);
					};
				}
			}
		}, 50);
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
}

