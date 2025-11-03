import { Component, OnInit, Input, Output, ViewChild, EventEmitter, AfterViewInit, TemplateRef, ElementRef } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource } from '../../shared/slideshow-modal/slideshow-modal.component';
import { PhotosSelectorModalComponent, PhotosSelectionResult } from '../../shared/photos-selector-modal/photos-selector-modal.component';
import { DomSanitizer, SafeResourceUrl, SafeUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
// Removed ng2-file-upload - using native HTML file input
import { NgbModal, ModalDismissReasons, NgbRatingConfig, NgbTooltip } from '@ng-bootstrap/ng-bootstrap';
import { Database, ref, push, remove, onValue, serverTimestamp } from '@angular/fire/database';
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
import { FileService } from '../../services/file.service';

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
	// For firebase items
	public items: Observable<any[]> = new Observable();
	public msgVal: string = '';
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
	// Gradient for title background (same method as description)
	public titleBackgroundGradient: string = 'linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(225, 225, 225, 0.6) 100%)';
	// Inverse color for title border
	public titleBorderColor: string = 'rgba(0, 0, 0, 0.8)';
	// Average color for description background (pure color from photo)
	public descriptionBackgroundColor: string = 'rgba(255, 255, 255, 1)';
	// Gradient for description background
	public descriptionBackgroundGradient: string = 'linear-gradient(135deg, rgba(255, 255, 255, 1) 0%, rgba(225, 225, 225, 1) 100%)';
	// RGB values of calculated color
	public calculatedRgbValues: string = 'RGB(255, 255, 255)';
	// Dominant color RGB values for gradient calculations
	public dominantR: number = 128;
	public dominantG: number = 128;
	public dominantB: number = 128;
	// Gradient for button backgrounds based on dominant color
	public buttonGradient: string = 'linear-gradient(135deg, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.6) 100%)';
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
	@ViewChild('thumbnailImage', { static: false }) thumbnailImageRef!: ElementRef<HTMLImageElement>;
	@ViewChild('cardSlideImage', { static: false }) cardSlideImageRef!: ElementRef<HTMLImageElement>;

	// FS Photos download control
	private fsDownloadsActive: boolean = false;
	private fsActiveSubs: Subscription[] = [];
	private fsQueue: string[] = [];
	
	// FS Photos slideshow loading control
	private fsSlideshowLoadingActive: boolean = false;
	private fsSlideshowSubs: Subscription[] = [];

	@ViewChild('jsonModal')
	public jsonModal!: TemplateRef<any>;
	@ViewChild('photosSelectorModalComponent') photosSelectorModalComponent!: PhotosSelectorModalComponent;
	@ViewChild('commentsModal') commentsModal!: TemplateRef<any>;
	@ViewChild('userModal') userModal!: TemplateRef<any>;
	@ViewChild('chatMessagesContainer') chatMessagesContainer!: ElementRef;
	@ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;
	@ViewChild('logContent') logContent: any;

	@Input()
	evenement: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);

	@Input()
	user: Member = new Member("", "", "", "", "", [], "");

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

	constructor(
		private sanitizer: DomSanitizer,
		private _router: Router,
		private modalService: NgbModal,
		private database: Database,
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
            this.openFsPhotosDiaporama(fsLinks[0].link);
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
            this.openFsPhotosDiaporama(result.value);
        }
    }

	private openFsPhotosDiaporama(relativePath: string): void {
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
				const maxConcurrent = 4;
				let active = 0;
				const queue = [...fileNames];
				
				const loadNext = () => {
					if (!this.fsSlideshowLoadingActive || active >= maxConcurrent || queue.length === 0) {
						return;
					}
					
					const fileName = queue.shift() as string;
					active++;
					
					const imageSub = this._fileService.getImageFromDisk(relativePath, fileName).subscribe({
						next: (buffer: ArrayBuffer) => {
							if (!this.fsSlideshowLoadingActive) return;
							
							const blob = new Blob([buffer], { type: 'image/*' });
							const url = URL.createObjectURL(blob);
							const imageSource: SlideshowImageSource = { blobUrl: url, fileId: undefined, blob: blob, fileName: fileName };
							
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
	}

	private loadImagesWithConcurrency(relativePath: string, fileNames: string[], concurrency: number): void {
		this.fsQueue = [...fileNames];
		let active = 0;

		const next = () => {
			if (!this.fsDownloadsActive) { return; }
			while (this.fsDownloadsActive && active < concurrency && this.fsQueue.length > 0) {
				const name = this.fsQueue.shift() as string;
				active++;
				const sub = this._fileService.getImageFromDisk(relativePath, name).subscribe({
					next: (buffer: ArrayBuffer) => {
						const blob = new Blob([buffer], { type: 'image/*' });
						const url = URL.createObjectURL(blob);
						this.slideshowImages.push(url);
					},
					error: () => {
						// ignore failed image
					},
					complete: () => {
						active--;
						next();
					}
				});
				this.fsActiveSubs.push(sub);
			}
		};

		next();
	}

	private cancelFsDownloads(): void {
		this.fsDownloadsActive = false;
		try { this.fsActiveSubs.forEach(s => { if (s && !s.closed) { s.unsubscribe(); } }); } catch {}
		this.fsActiveSubs = [];
		this.fsQueue = [];
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

	public onSlideshowClose(cRef: any): void {
		try {
			if (document.fullscreenElement) {
				document.exitFullscreen().catch(() => {});
			}
		} catch {}
		this.cancelFsDownloads();
		try { if (typeof cRef === 'function') { cRef('Close click'); } } catch {}
		try { this.modalService.dismissAll(); } catch {}
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
		
		// for the firebase : create a reference with evenement.id as name 
		const messagesRef = ref(this.database, this.evenement.id);
		this.items = new Observable(observer => {
			const unsubscribe = onValue(messagesRef, (snapshot) => {
				const messages: any[] = [];
				snapshot.forEach((childSnapshot) => {
					messages.push({
						id: childSnapshot.key,
						...childSnapshot.val()
					});
				});
				// Trier les messages par date/heure (plus récents en premier)
				messages.sort((a, b) => {
					// Utiliser la propriété 'priority' qui est définie comme 0 - Date.now()
					// Plus la valeur est négative, plus le message est récent
					return a.priority - b.priority;
				});
				observer.next(messages);
			}, (error) => {
				observer.error(error);
			});
			
			return () => unsubscribe();
		});
		// Call Thumbnail Image function
		this.setThumbnailImage();
		
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
		if (this.evenement.fileUploadeds.length != 0) {
			this.evenement.fileUploadeds.map(fileUploaded => {
				if (fileUploaded.fileName.indexOf('thumbnail') !== -1) {
					// Use getFile for display (with image resizing)
					this._fileService.getFile(fileUploaded.fieldId).pipe(
						map((res: any) => {
							let blob = new Blob([res], { type: 'application/octet-stream' });
							let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
							return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
						})
					).subscribe((safeUrl: SafeUrl) => {
						this.thumbnailUrl = safeUrl;
						// Detect dominant color after image loads
						setTimeout(() => {
							this.detectDominantColor();
						}, 100);
					});
				}
			}
			)
		} else {
			// Reset to default color if no thumbnail
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			this.titleBackgroundGradient = 'linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(225, 225, 225, 0.6) 100%)';
			this.titleBorderColor = 'rgba(0, 0, 0, 0.8)';
			this.descriptionBackgroundColor = 'rgba(255, 255, 255, 1)';
			this.descriptionBackgroundGradient = 'linear-gradient(135deg, rgba(255, 255, 255, 1) 0%, rgba(225, 225, 225, 1) 100%)';
			this.calculatedRgbValues = 'RGB(255, 255, 255)';
			this.dominantR = 128;
			this.dominantG = 128;
			this.dominantB = 128;
			this.buttonGradient = 'linear-gradient(135deg, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.6) 100%)';
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
	

	// Process image to extract dominant color from top portion
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

			// Sample the top portion of the image (top 30%)
			const sampleHeight = Math.floor(canvas.height * 0.3);
			const sampleWidth = canvas.width;

			// Get image data from top portion
			const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
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
				
				// Calculate a darker version for title gradient (increased gradient intensity)
				const darkerR = Math.max(0, r - 60);
				const darkerG = Math.max(0, g - 60);
				const darkerB = Math.max(0, b - 60);
				this.titleBackgroundGradient = `linear-gradient(135deg, rgba(${r}, ${g}, ${b}, 0.6) 0%, rgba(${darkerR}, ${darkerG}, ${darkerB}, 0.6) 100%)`;
				
				// Store the average color for description background (pure color, full opacity)
				this.descriptionBackgroundColor = `rgba(${r}, ${g}, ${b}, 1)`;
				
				// Calculate a darker version for description gradient (increased gradient intensity)
				this.descriptionBackgroundGradient = `linear-gradient(135deg, rgba(${r}, ${g}, ${b}, 1) 0%, rgba(${darkerR}, ${darkerG}, ${darkerB}, 1) 100%)`;
				
				// Calculate brightness to determine base color for text and border
				// Using luminance formula: 0.299*R + 0.587*G + 0.114*B
				const brightness = (0.299 * r + 0.587 * g + 0.114 * b);
				
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
				
				// Calculate button gradient based on dominant color
				this.calculateButtonGradient(r, g, b);
				
			}
		} catch (error) {
			console.error('Error detecting dominant color:', error);
			// Fallback to default color
			this.titleBackgroundColor = 'rgba(255, 255, 255, 0.6)';
			this.titleBorderColor = 'rgba(0, 0, 0, 0.8)';
			this.dominantR = 128;
			this.dominantG = 128;
			this.dominantB = 128;
			this.buttonGradient = 'linear-gradient(135deg, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.6) 100%)';
		}
	}
	
	// Calculate button gradient based on dominant color
	private calculateButtonGradient(r: number, g: number, b: number): void {
		// This is now a generic method - individual gradients are calculated per button
		// Keeping for backward compatibility
		this.buttonGradient = this.getButtonGradientForType('default', r, g, b);
	}
	
	// Get gradient for a specific button type - basé uniquement sur la couleur calculée
	public getButtonGradientForType(buttonType: string, r: number, g: number, b: number): string {
		// Dégradé uniforme pour tous les boutons, basé uniquement sur la couleur calculée de l'image
		// Lighter version for start, darker for end
		const lighterR = Math.min(255, r + 50);
		const lighterG = Math.min(255, g + 50);
		const lighterB = Math.min(255, b + 50);
		
		const darkerR = Math.max(0, r - 60);
		const darkerG = Math.max(0, g - 60);
		const darkerB = Math.max(0, b - 60);
		
		// Use high opacity for stronger gradients
		return `linear-gradient(135deg, rgba(${lighterR}, ${lighterG}, ${lighterB}, 1) 0%, rgba(${darkerR}, ${darkerG}, ${darkerB}, 1) 100%)`;
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
		// Use MutationObserver to detect when modals are added to DOM
		const observer = new MutationObserver((mutations) => {
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
		observer.observe(document.body, {
			childList: true,
			subtree: true
		});
		
		// Also listen for modal show events using DOM events
		document.addEventListener('show.bs.modal', () => {
			this.forceCloseTooltips();
		}, true);
		
		document.addEventListener('shown.bs.modal', () => {
			this.forceCloseTooltips();
		}, true);
		
		// Listen for any click events that might open modals or overlays
		document.addEventListener('click', (event: MouseEvent) => {
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
		}, true);
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
		this.modalService.open(content, { size: 'lg', centered: true });
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
	// for modal chat
	public closeResult: string = "";

	public open(content: any) {
		this.forceCloseTooltips();
		this.modalService.open(content).result.then((result) => {
			this.closeResult = `Closed with: ${result}`;
		}, (reason) => {
			this.closeResult = `Dismissed ${this.getDismissReason(reason)}`;
		});
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
			this.modalService.open(this.jsonModal, { size: 'lg' }).result.then((result) => {
				this.closeResult = `JSON modal closed with: ${result}`;
			}, (reason) => {
				this.closeResult = `JSON modal dismissed ${this.getDismissReason(reason)}`;
			});
		} else {
			console.error('JSON modal template not found');
		}
	}

	// Get event as formatted JSON
	public getEventAsJson(): string {
		return JSON.stringify(this.evenement, null, 2);
	}

	public getDismissReason(reason: any): string {
		if (reason === ModalDismissReasons.ESC) {
			return 'by pressing ESC';
		} else if (reason === ModalDismissReasons.BACKDROP_CLICK) {
			return 'by clicking on a backdrop';
		} else {
			return `with: ${reason}`;
		}
	}

	async Send() {     
		const messagesRef = ref(this.database, this.evenement.id);
		await push(messagesRef, {
			'message': this.msgVal,
			'date': new Date().toISOString(),
			'user': {
				firstName: this.user.firstName,
				lastName: this.user.lastName,
				userName: this.user.userName
			},
			'priority': 0 - Date.now()
		});
		this.msgVal = '';
		// Faire défiler vers le bas après l'envoi
		setTimeout(() => this.scrollToBottom(), 100);
	}

	private scrollToBottom(): void {
		if (this.chatMessagesContainer) {
			const element = this.chatMessagesContainer.nativeElement;
			element.scrollTop = element.scrollHeight;
		}
	}


	public async deleteMessage(item: any) {
		const messageRef = ref(this.database, this.evenement.id + '/' + item.id);
		await remove(messageRef);
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
			this.titleBackgroundGradient = 'linear-gradient(135deg, rgba(255, 255, 255, 0.6) 0%, rgba(225, 225, 225, 0.6) 100%)';
			this.titleBorderColor = 'rgba(0, 0, 0, 0.8)';
			this.descriptionBackgroundColor = 'rgba(255, 255, 255, 1)';
			this.descriptionBackgroundGradient = 'linear-gradient(135deg, rgba(255, 255, 255, 1) 0%, rgba(225, 225, 225, 1) 100%)';
			this.calculatedRgbValues = 'RGB(255, 255, 255)';
			// Try to detect color from default image
			setTimeout(() => {
				this.detectDominantColor();
			}, 100);
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
		const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'PHOTOS', 'Photos', 'OTHER'];
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

	// Handle file click based on file type
	public handleFileClick(uploadedFile: UploadedFile): void {
		if (this.isImageFile(uploadedFile.fileName)) {
			this.openSingleImageInSlideshow(uploadedFile.fieldId, uploadedFile.fileName);
		} else if (this.isPdfFile(uploadedFile.fileName)) {
			this.openPdfFile(uploadedFile.fieldId, uploadedFile.fileName);
		}
	}

	// Get appropriate tooltip for file
	public getFileTooltip(fileName: string): string | null {
		if (this.isImageFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_VIEW');
		} else if (this.isPdfFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_OPEN_PDF');
		}
		return null;
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

	
	ngOnDestroy() {
		// Stop card slideshow if active
		this.stopCardSlideshow();
		
		// Nettoyer les URLs blob pour éviter les fuites mémoire
		if (this.thumbnailUrl && typeof this.thumbnailUrl === 'object' && 'changingThisBreaksApplicationSecurity' in this.thumbnailUrl) {
			try {
				const url = this.thumbnailUrl['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					this.nativeWindow.URL.revokeObjectURL(url);
				}
			} catch (error) {
				console.warn('Error cleaning up blob URL:', error);
			}
		}
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
			backdrop: true,
			keyboard: true,
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
			backdrop: true,
			keyboard: true,
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
