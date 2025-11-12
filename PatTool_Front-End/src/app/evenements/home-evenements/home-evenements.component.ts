import { Component, OnInit, HostListener, ElementRef, AfterViewInit, ViewChild, OnDestroy, TemplateRef } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource } from '../../shared/slideshow-modal/slideshow-modal.component';
import { PhotosSelectorModalComponent, PhotosSelectionResult } from '../../shared/photos-selector-modal/photos-selector-modal.component';
import { Observable, Subscription, fromEvent, firstValueFrom } from 'rxjs';
import { debounceTime, map } from 'rxjs/operators';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
import { Database, ref, push, remove, onValue } from '@angular/fire/database';
import * as JSZip from 'jszip';

import { Evenement } from '../../model/evenement';
import { MembersService } from '../../services/members.service';
import { Member } from '../../model/member';
import { UrlEvent } from '../../model/url-event';
import { UploadedFile } from '../../model/uploadedfile';
import { Router } from '@angular/router';
import { WindowRefService } from '../../services/window-ref.service';
import { FileService } from '../../services/file.service';
import { CommonvaluesService } from '../../services/commonvalues.service';
import { EvenementsService } from '../../services/evenements.service';
import { environment } from '../../../environments/environment';

interface EventColorUpdate {
	eventId: string;
	color: { r: number; g: number; b: number };
}

@Component({
	selector: 'home-evenements',
	templateUrl: './home-evenements.component.html',
	styleUrls: ['./home-evenements.component.css']
})
export class HomeEvenementsComponent implements OnInit, AfterViewInit, OnDestroy {

	public evenements: Evenement[] = [];
	public user: Member = new Member("", "", "", "", "", [], "");
	public pageNumber: number = this._commonValuesService.getPageNumber();
	public elementsByPage: number = this._commonValuesService.getElementsByPage();
	public dataFIlter: string = this._commonValuesService.getDataFilter();
	public filteredTotal: number = 0;
	public averageColor!: string;
	public averageTextColor!: string;
	public averageBorderColor!: string;
	public averageGradient!: string;
	public isCompactView: boolean = false;
	public controlsCollapsed: boolean = false;
	public isMobile: boolean = false;
	public eventThumbnails: Map<string, SafeUrl> = new Map();
	public nativeWindow: any;
	public selectedEventPhotos: string[] = [];
	public selectedEvent: Evenement = new Evenement(new Member("", "", "", "", "", [], ""), new Date(), "", new Date(), new Date(), new Date(), "", "", [], new Date(), "", "", [], "", "", "", "", 0, 0, "", [], []);
	public selectedEventName: string = '';
	public selectedImageUrl: SafeUrl | string = '';
	public selectedImageAlt: string = '';
	public selectedUser: Member | null = null;
	public msgVal: string = '';
	public items: Observable<any> = new Observable();
	public selectedFiles: File[] = [];
	public API_URL4FILE: string = environment.API_URL4FILE;
	// Upload logs
	public uploadLogs: string[] = [];
	public isUploading: boolean = false;
	public isLoadingNextPage: boolean = false;
	public hasMoreEvents: boolean = true;
	private readonly defaultAverageColor: string = 'rgba(73, 80, 87, 0.12)';
	private readonly defaultAverageTextColor: string = '#343a40';
	private readonly defaultAverageBorderColor: string = 'rgba(52, 58, 64, 0.65)';
	private eventColors: Map<string, { r: number; g: number; b: number }> = new Map();
	public titleOnlyView: boolean = false;
	@ViewChild('searchterm')
	public searchterm!: ElementRef;
	@ViewChild('photosModal') photosModal!: TemplateRef<any>;
	@ViewChild('imageModal') imageModal!: TemplateRef<any>;
	@ViewChild('urlsModal') urlsModal!: TemplateRef<any>;
	@ViewChild('chatModal') chatModal!: TemplateRef<any>;
	@ViewChild('jsonModal') jsonModal!: TemplateRef<any>;
	@ViewChild('userModal') userModal!: TemplateRef<any>;
	@ViewChild('commentsModal') commentsModal!: TemplateRef<any>;
	@ViewChild('filesModal') filesModal!: TemplateRef<any>;
	@ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;
	@ViewChild('logContent') logContent: any;
	@ViewChild('chatMessagesContainer') chatMessagesContainer!: ElementRef;
	@ViewChild('photosSelectorModalComponent') photosSelectorModalComponent!: PhotosSelectorModalComponent;
	@ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
	@ViewChild('infiniteScrollAnchor') infiniteScrollAnchor?: ElementRef<HTMLDivElement>;
	private eventsSubscription?: Subscription;
	private intersectionObserver?: IntersectionObserver;
	private feedRequestToken = 0;
	private prefetchTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private readonly prefetchThresholdMultiplier = 2;

	constructor(private _evenementsService: EvenementsService,
		private _memberService: MembersService,
		private _fileService: FileService,
		private _router: Router,
		private _commonValuesService: CommonvaluesService,
		private sanitizer: DomSanitizer,
		private winRef: WindowRefService,
		private modalService: NgbModal,
		private translateService: TranslateService,
		private database: Database) {
		this.nativeWindow = winRef.getNativeWindow();
		this.averageColor = this.defaultAverageColor;
		this.averageTextColor = this.defaultAverageTextColor;
		this.averageBorderColor = this.defaultAverageBorderColor;
		this.averageGradient = this.buildGradientFromColor(this.defaultAverageColor);
	}

	ngOnInit() {
		this.user = this._memberService.getUser();
		this.resetAndLoadEvents();
		
		this.updateResponsiveState(this.nativeWindow.innerWidth);
		// Initialize controls collapsed state based on screen size
		if (this.isMobile) {
			this.controlsCollapsed = true;
		}
		
		// Scroll to top when component loads
		this.scrollToTop();
	}

	@HostListener('window:resize', ['$event'])
	onWindowResize(event: UIEvent): void {
		const width = (event.target as Window)?.innerWidth ?? this.nativeWindow.innerWidth;
		this.updateResponsiveState(width);
	}

	private updateResponsiveState(width: number): void {
		const wasMobile = this.isMobile;
		this.isMobile = width <= 767;
		if (wasMobile && !this.isMobile && this.controlsCollapsed) {
			this.controlsCollapsed = false;
		}
	}

	ngAfterViewInit() {
		// used to not have to press enter when filter
		const eventObservable = fromEvent(this.searchterm.nativeElement, 'input')
			.pipe(debounceTime(700));

		eventObservable.subscribe(
			((data: any) => {
				this.pageNumber = 0;
				this._commonValuesService.setPageNumber(this.pageNumber);
				this.dataFIlter = data.target.value;
				this._commonValuesService.setDataFilter(this.dataFIlter);
				this.resetAndLoadEvents();
			}),
			((err: any) => console.error(err)),
			() => console.log('complete')
		)
		this.setupInfiniteScrollObserver();
	}

	private waitForNonEmptyValue(): Promise<void> {
		return new Promise<void>((resolve) => {
			const checkValue = () => {
				if (this.user.id !== "") {
					resolve();
				} else {
					let now = new Date();
					// console.log("This.user.id is still empty " + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds() + '.' + now.getMilliseconds());
					setTimeout(checkValue, 100); // Appeler checkValue de manière récursive après 100ms
				}
			};
			checkValue(); // Déclencher la première vérification
		});
	}

	private resetAndLoadEvents(): void {
		this.feedRequestToken++;
		this.eventsSubscription?.unsubscribe();
		this.isLoadingNextPage = false;
		this.hasMoreEvents = true;
		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}
		this.pageNumber = 0;
		this._commonValuesService.setPageNumber(this.pageNumber);
		this._commonValuesService.setElementsByPage(this.elementsByPage);
		this.evenements = [];
		this.filteredTotal = 0;
		this.resetColorAggregation();
		if (this.infiniteScrollAnchor?.nativeElement) {
			this.setupInfiniteScrollObserver();
		}
		this.loadNextPage();
	}

	private loadNextPage(): void {
		if (this.isLoadingNextPage || !this.hasMoreEvents) {
			return;
		}

		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}

		const requestToken = this.feedRequestToken;
		const pageToLoad = this.pageNumber;
		const rawFilter = (this.dataFIlter ?? "").trim();
		const searchString = rawFilter === "" ? "*" : rawFilter;

		this.isLoadingNextPage = true;

		this.waitForNonEmptyValue().then(() => {
			if (requestToken !== this.feedRequestToken) {
				return;
			}
			this.eventsSubscription?.unsubscribe();
			const subscription = this._evenementsService
				.getEvents(searchString, pageToLoad, this.elementsByPage, this.user.id)
				.subscribe({
					next: (res: any) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						const newEvents: Evenement[] = res?.content ?? [];

						if (pageToLoad === 0) {
							this.evenements = newEvents;
						} else {
							this.evenements = [...this.evenements, ...newEvents];
						}

						this.filteredTotal = res?.page?.totalElements ?? this.evenements.length;
						const currentPageFromResponse = res?.page?.number ?? pageToLoad;
						const totalPages = res?.page?.totalPages ?? null;

						this.pageNumber = currentPageFromResponse + 1;
						this._commonValuesService.setPageNumber(currentPageFromResponse);

						if (newEvents.length === 0) {
							this.hasMoreEvents = false;
						} else if (totalPages !== null) {
							this.hasMoreEvents = this.pageNumber < totalPages;
						} else {
							this.hasMoreEvents = newEvents.length === this.elementsByPage;
						}

						if (!this.hasMoreEvents) {
							this.disconnectInfiniteScrollObserver();
						}

						this.isLoadingNextPage = false;
						this.schedulePrefetchIfNeeded();
						this.tryLoadNextIfAnchorVisible();
					},
					error: (err: any) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						console.error("Error when getting Events", err);
						this.isLoadingNextPage = false;
						this.hasMoreEvents = false;
					}
				});
			this.eventsSubscription = subscription;
		}).catch((err) => {
			console.error("Error while waiting for user value", err);
			this.isLoadingNextPage = false;
			this.hasMoreEvents = false;
		});
	}

	private setupInfiniteScrollObserver(): void {
		if (!this.infiniteScrollAnchor) {
			return;
		}

		this.disconnectInfiniteScrollObserver();

		this.intersectionObserver = new IntersectionObserver((entries) => {
			entries.forEach(entry => {
				if (entry.isIntersecting) {
					this.loadNextPage();
				}
			});
		}, {
			root: null,
			rootMargin: '0px 0px 45% 0px',
			threshold: 0
		});

		this.intersectionObserver.observe(this.infiniteScrollAnchor.nativeElement);
	}

	private disconnectInfiniteScrollObserver(): void {
		if (this.intersectionObserver) {
			this.intersectionObserver.disconnect();
			this.intersectionObserver = undefined;
		}
	}

	private schedulePrefetchIfNeeded(): void {
		if (!this.hasMoreEvents || this.isLoadingNextPage) {
			return;
		}

		const target = this.prefetchThresholdMultiplier * this.elementsByPage;
		if (this.evenements.length >= target) {
			return;
		}

		if (this.prefetchTimeoutId) {
			return;
		}

		this.prefetchTimeoutId = setTimeout(() => {
			this.prefetchTimeoutId = null;
			this.loadNextPage();
		}, 0);
	}

	private tryLoadNextIfAnchorVisible(): void {
		if (!this.hasMoreEvents || this.isLoadingNextPage || !this.infiniteScrollAnchor?.nativeElement) {
			return;
		}

		requestAnimationFrame(() => {
			if (!this.hasMoreEvents || this.isLoadingNextPage || !this.infiniteScrollAnchor?.nativeElement) {
				return;
			}
			if (this.infiniteScrollAnchor.nativeElement.getBoundingClientRect().top <= (this.nativeWindow?.innerHeight ?? document.documentElement.clientHeight ?? 0)) {
				this.loadNextPage();
			}
		});
	}

	public onEventColorUpdate(update: EventColorUpdate): void {
		if (!update || !update.eventId) {
			return;
		}
		if (!this.isEventVisible(update.eventId)) {
			return;
		}
		this.eventColors.set(update.eventId, update.color);
		this.updateAverageColor();
	}

	private resetColorAggregation(): void {
		this.eventColors.clear();
		this.updateAverageColor();
	}

	private isEventVisible(eventId: string): boolean {
		return this.evenements?.some(evenement => this.getEventKey(evenement) === eventId) ?? false;
	}

	private getEventKey(evenement: Evenement | null | undefined): string {
		if (!evenement) {
			return '';
		}
		return evenement.id || evenement.evenementName || '';
	}

	public trackEvent = (index: number, evenement: Evenement): string => {
		const key = this.getEventKey(evenement);
		return key !== '' ? key : index.toString();
	};

	private updateAverageColor(): void {
		if (this.eventColors.size === 0) {
			this.averageColor = this.defaultAverageColor;
			this.averageTextColor = this.defaultAverageTextColor;
			this.averageBorderColor = this.defaultAverageBorderColor;
			this.averageGradient = this.buildGradientFromColor(this.defaultAverageColor);
			return;
		}

		let totalR = 0;
		let totalG = 0;
		let totalB = 0;

		this.eventColors.forEach(({ r, g, b }) => {
			totalR += r;
			totalG += g;
			totalB += b;
		});

		const count = this.eventColors.size;
		const avgR = Math.round(totalR / count);
		const avgG = Math.round(totalG / count);
		const avgB = Math.round(totalB / count);

		const baseColor = this.buildRgba(avgR, avgG, avgB, 0.24);
		this.averageColor = baseColor;

		this.averageTextColor = this.buildDarkerShade(avgR, avgG, avgB, 0.55, 0.92);
		this.averageBorderColor = this.buildDarkerShade(avgR, avgG, avgB, 0.45, 0.95);
		this.averageGradient = this.buildGradientFromColor(baseColor);
	}

	private buildRgba(r: number, g: number, b: number, alpha: number = 1): string {
		const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value ?? 0)));
		const clampedAlpha = Math.max(0, Math.min(1, alpha));
		return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${clampedAlpha})`;
	}

	private buildDarkerShade(r: number, g: number, b: number, factor: number, alpha: number = 1): string {
		const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value ?? 0)));
		const clampedFactor = Math.max(0, Math.min(1, factor));
		const clampedAlpha = Math.max(0, Math.min(1, alpha));
		const darken = (channel: number) => clamp(channel * clampedFactor);
		return `rgba(${darken(r)}, ${darken(g)}, ${darken(b)}, ${clampedAlpha})`;
	}

	private buildGradientFromColor(baseRgba: string): string {
		if (!baseRgba) {
			return this.defaultAverageColor;
		}
		const rgbaMatch = baseRgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/);
		if (!rgbaMatch) {
			return baseRgba;
		}
		const [, rStr, gStr, bStr, aStr] = rgbaMatch;
		const r = parseInt(rStr, 10);
		const g = parseInt(gStr, 10);
		const b = parseInt(bStr, 10);
		const a = parseFloat(aStr);

		const lighter = this.buildRgba(
			Math.min(255, Math.round(r + (255 - r) * 0.35)),
			Math.min(255, Math.round(g + (255 - g) * 0.35)),
			Math.min(255, Math.round(b + (255 - b) * 0.35)),
			Math.max(0, Math.min(1, a + (1 - a) * 0.15))
		);
		const darker = this.buildRgba(
			Math.max(0, Math.round(r * 0.85)),
			Math.max(0, Math.round(g * 0.85)),
			Math.max(0, Math.round(b * 0.85)),
			Math.max(0, Math.min(1, a * 0.9))
		);

		return `linear-gradient(165deg, ${lighter} 0%, ${baseRgba} 35%, ${darker} 100%)`;
	}

	public addMemberInEvent(evenement: Evenement) {
		//console.log("addMemberInEvent " + JSON.stringify(evenement));
		// put the user logged in the venemen as member
		evenement.members.push(this.user);
		// save the evenement ( does an Update )
		this._evenementsService.putEvenement(evenement).subscribe(
			(res: any) => // console.log("I participe return ok " ),
				(err: any) => alert("Error when deleting participant " + err));
	}

	public delMemberInEvent(evenement: Evenement) {
		//console.log("delMemberInEvent " + JSON.stringify(evenement));
		// put the user logged in the venemen as member    
		let members: Member[] = evenement.members;
		// remove the member
		evenement.members = members.filter(memb => !(memb.id == this.user.id));
		// save the evenement ( does an Update )
		this._evenementsService.putEvenement(evenement).subscribe(
			(res: any) => // console.log("I don't participe in evenement ok "),
				(err: any) => alert("Error when deleting participant " + err));
	}

	public async delEvent(evenement: Evenement) {
		// Delete Firebase chat messages first
		try {
			const messagesRef = ref(this.database, evenement.id);
			await remove(messagesRef);
			console.log("Firebase chat messages deleted for event: " + evenement.id);
		} catch (error) {
			console.error("Error deleting Firebase chat messages:", error);
			// Continue with event deletion even if Firebase deletion fails
		}
		
		// Then delete the event from backend
		this._evenementsService.delEvenement(evenement.id)
			.subscribe(
				(res: any) => {  //  update evenements for screen update			
					this.resetAndLoadEvents();
				},
				(err: any) => {
					console.log("Del evenement error : " + err);
					alert("Issue when deleting the event : " + err);
				}
			);
	}

	public updEvent(evenement: Evenement) {
		this._evenementsService.putEvenement(evenement)
			.subscribe((resp: any) => // console.log("Update Status OK "),
				(err: any) => alert("Update Status Error : " + err));
	}

	public changeStatusEvent(evenement: Evenement) {
		if (evenement.status == "Closed") {
			evenement.status = "Cancel"
		} else if (evenement.status == "Cancel") {
			evenement.status = "Open"
		} else {
			evenement.status = "Closed"
		}
		this.updEvent(evenement);
	}

	// Méthodes pour les actions des événements dans la vue compacte
	public isAuthor(evenement: Evenement): boolean {
		return evenement.author.userName == this.user.userName;
	}

	public isParticipant(evenement: Evenement): boolean {
		return evenement.members.some(member => member.userName == this.user.userName);
	}



	public isAnyFiles(evenement: Evenement): boolean {
		return evenement.fileUploadeds && evenement.fileUploadeds.length > 0;
	}

	public deleteEvenement(evenement: Evenement) {
		// Count associated data
		const fileCount = evenement.fileUploadeds ? evenement.fileUploadeds.length : 0;
		const urlCount = evenement.urlEvents ? evenement.urlEvents.length : 0;
		const commentaryCount = evenement.commentaries ? evenement.commentaries.length : 0;
		
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
			this.delEvent(evenement);
		}
	}

	public toggleFileList(evenement: Evenement) {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		// Load thumbnails when modal opens
		this.loadFileThumbnails(evenement);
		
		this.modalService.open(this.filesModal, { 
			size: 'lg',
			backdrop: 'static',
			keyboard: false,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('Files modal closed with:', result);
		}, (reason) => {
			console.log('Files modal dismissed:', reason);
		});
	}
	
	// Load thumbnails for all image files
	private loadFileThumbnails(evenement: Evenement): void {
		if (!evenement.fileUploadeds || evenement.fileUploadeds.length === 0) {
			return;
		}
		
		// Filter image files and load their thumbnails
		const imageFiles = evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
		
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

	public openPhotosModal(evenement: Evenement) {
		// Ouvrir le modal des photos pour l'événement
		console.log('Opening photos modal for event:', evenement.evenementName);
		
		// No photos available since photosUrl field has been removed
		console.log('No photos available - photosUrl field has been removed');
	}

	public openPhotoInNewTab(url: string) {
		this.nativeWindow.open(url, '_blank');
	}

	public isUrlEventsAvailable(evenement: Evenement): boolean {
		if (!evenement.urlEvents || evenement.urlEvents.length === 0) {
			return false;
		}
		// Exclude photo-related links (PHOTOS and PHOTOFROMFS)
		return evenement.urlEvents.some(u => {
			const type = (u.typeUrl || '').toUpperCase().trim();
			return type !== 'PHOTOS' && type !== 'PHOTOFROMFS';
		});
	}

	public getUrlEventsCount(evenement: Evenement): number {
		if (!evenement.urlEvents) {
			return 0;
		}
		// Exclude photo-related links (PHOTOS and PHOTOFROMFS)
		return evenement.urlEvents.filter(u => {
			const type = (u.typeUrl || '').toUpperCase().trim();
			return type !== 'PHOTOS' && type !== 'PHOTOFROMFS';
		}).length;
	}

	public openUrlsModal(evenement: Evenement) {
		console.log('Opening URLs modal for event:', evenement.evenementName);
		console.log('UrlEvents data:', evenement.urlEvents);
		
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		this.modalService.open(this.urlsModal, { 
			size: 'lg',
			backdrop: 'static',
			keyboard: false,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('URLs modal closed with:', result);
		}, (reason) => {
			console.log('URLs modal dismissed:', reason);
		});
	}

	public getUrlTypeLabel(typeUrl: string): string {
		// Normaliser le type en supprimant les espaces et en convertissant en majuscules
		const normalizedType = typeUrl?.trim().toUpperCase() || 'OTHER';
		
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
	public getGroupedUrlEvents(evenement: Evenement): { [key: string]: any[] } {
		if (!evenement.urlEvents || evenement.urlEvents.length === 0) {
			return {};
		}
		
		// Filter out photo-related links (PHOTOS and PHOTOFROMFS)
		const nonPhotoUrls = evenement.urlEvents.filter(u => {
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
	public getSortedTypeKeys(evenement: Evenement): string[] {
		const grouped = this.getGroupedUrlEvents(evenement);
		const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'PHOTOS', 'Photos', 'OTHER'];
		return typeOrder.filter(type => grouped[type] && grouped[type].length > 0);
	}

	public updateFileUploadedInEvent(evenement: Evenement) {
		this._evenementsService.put4FileEvenement(evenement)
			.subscribe((resp: any) => // console.log("Delete file OK "),
				(err: any) => alert("Delete File Error : " + err));
	}
	public clearFilter() {
		this.dataFIlter = "";
		this._commonValuesService.setDataFilter(this.dataFIlter);
		this.resetAndLoadEvents();
		this.scrollToTop();
	}

	// Méthodes pour la vue compacte
	public toggleControlsCollapse(): void {
		this.controlsCollapsed = !this.controlsCollapsed;
	}

	public toggleViewMode() {
		this.isCompactView = !this.isCompactView;
	}


	public getEventThumbnail(evenement: Evenement): SafeUrl {
		// Vérifier si on a déjà cette thumbnail en cache
		if (this.eventThumbnails.has(evenement.id)) {
			const cachedUrl = this.eventThumbnails.get(evenement.id);
			if (cachedUrl) {
				return cachedUrl;
			}
		}

		// Chercher un fichier avec "thumbnail" dans le nom
		const thumbnailFile = evenement.fileUploadeds?.find(file => 
			file.fileName && file.fileName.toLowerCase().includes('thumbnail')
		);
		
		if (thumbnailFile) {
			// Charger l'image via le service de fichiers pour l'authentification
			this.loadThumbnailFromFile(evenement.id, thumbnailFile.fieldId);
			// Retourner l'image par défaut en attendant le chargement
			const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
			this.eventThumbnails.set(evenement.id, defaultUrl);
			return defaultUrl;
		}
		
		const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
		this.eventThumbnails.set(evenement.id, defaultUrl);
		return defaultUrl;
	}

	private loadThumbnailFromFile(eventId: string, fileId: string): void {
		this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		).subscribe((blob: any) => {
			let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
			let safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
			
			// Mettre à jour l'URL dans le cache des événements
			this.eventThumbnails.set(eventId, safeUrl);
			
			// Ne pas révoquer l'URL blob immédiatement - la garder en mémoire
			// L'URL sera automatiquement révoquée quand le composant sera détruit
		}, (error: any) => {
			console.error('Error loading thumbnail for event:', eventId, error);
			// En cas d'erreur, utiliser l'image par défaut
			this.eventThumbnails.set(eventId, this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg"));
		});
	}

	public formatEventDate(date: Date): string {
		if (!date) return '';
		
		const eventDate = new Date(date);
		const now = new Date();
		const diffTime = eventDate.getTime() - now.getTime();
		const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
		
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
		
		if (diffDays === 0) {
			return this.translateService.instant('COMMUN.TODAY') + ` <em>(${formattedDate})</em>`;
		} else if (diffDays === 1) {
			return this.translateService.instant('COMMUN.TOMORROW') + ` <em>(${formattedDate})</em>`;
		} else if (diffDays === -1) {
			return this.translateService.instant('COMMUN.YESTERDAY') + ` <em>(${formattedDate})</em>`;
		} else if (diffDays > 0) {
			return this.translateService.instant('COMMUN.IN_DAYS', { days: diffDays }) + ` <em>(${formattedDate})</em>`;
		} else {
			return this.translateService.instant('COMMUN.DAYS_AGO', { days: Math.abs(diffDays) }) + ` <em>(${formattedDate})</em>`;
		}
	}

	public openEventDetails(evenement: Evenement) {
		// Navigation vers la page de détails de l'événement
		this._router.navigate(['/details-evenement', evenement.id]);
	}

	public onImageError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.src = "assets/images/images.jpg";
		}
	}

	public hideImageOnError(event: any) {
		const target = event.target as HTMLImageElement;
		if (target) {
			target.style.display = 'none';
		}
	}

	// Méthodes pour le chat - utilisant la même logique que element-evenement
	public openChatModal(evenement: Evenement) {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		// Utiliser Firebase comme dans element-evenement
		const messagesRef = ref(this.database, evenement.id);
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
				console.error('Error loading messages:', error);
				observer.error(error);
			});
			
			// Retourner la fonction de nettoyage
			return () => unsubscribe();
		});
		
		// Utiliser la même configuration que dans element-evenement
		this.modalService.open(this.chatModal, { backdrop: 'static', keyboard: false });
	}

	public async Send() {
		if (this.msgVal.trim() !== '') {
			const messagesRef = ref(this.database, this.selectedEvent.id);
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
	}

	private scrollToBottom(): void {
		if (this.chatMessagesContainer) {
			const element = this.chatMessagesContainer.nativeElement;
			element.scrollTop = element.scrollHeight;
		}
	}

	public async deleteMessage(item: any) {
		const messageRef = ref(this.database, this.selectedEvent.id + '/' + item.id);
		await remove(messageRef);
	}

	ngOnDestroy() {
		this.eventsSubscription?.unsubscribe();
		this.disconnectInfiniteScrollObserver();
		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}
		// Nettoyer toutes les URLs blob pour éviter les fuites mémoire
		this.eventThumbnails.forEach((safeUrl, eventId) => {
			try {
				// SafeUrl peut être un objet, on doit extraire la valeur string
				const url = safeUrl && typeof safeUrl === 'object' && 'changingThisBreaksApplicationSecurity' in safeUrl 
					? safeUrl['changingThisBreaksApplicationSecurity'] 
					: safeUrl as string;
				
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					this.nativeWindow.URL.revokeObjectURL(url);
				}
			} catch (error) {
				// Ignorer les erreurs lors du nettoyage
				console.warn('Error cleaning up blob URL:', error);
			}
		});
		this.eventThumbnails.clear();
		
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
	}
	
	// Scroll to top of the page
	private scrollToTop(): void {
		this.nativeWindow.scrollTo(0, 0);
	}
	
	// Open image modal for large display
	openImageModal(imageUrl: SafeUrl, imageAlt: string): void {
		this.selectedImageUrl = imageUrl;
		this.selectedImageAlt = imageAlt;
		
		if (!this.imageModal) {
			return;
		}
		
		this.modalService.open(this.imageModal, { 
			size: 'lg', 
			centered: true,
			backdrop: 'static',
			keyboard: false,
			animation: false,
			windowClass: 'modal-smooth-animation'
		});
	}

	public showEventJson(evenement: Evenement): void {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		this.modalService.open(this.jsonModal, { 
			size: 'lg',
			backdrop: 'static',
			keyboard: false,
			animation: true,
			centered: true
		}).result.then((result) => {
			console.log('JSON modal closed with:', result);
		}, (reason) => {
			console.log('JSON modal dismissed:', reason);
		});
	}

	public getFormattedEventJson(): string {
		if (this.selectedEvent) {
			return JSON.stringify(this.selectedEvent, null, 2);
		}
		return '';
	}

	public hasComments(evenement: Evenement): boolean {
		return evenement.commentaries && evenement.commentaries.length > 0;
	}

	public getCommentsCount(evenement: Evenement): number {
		return evenement.commentaries ? evenement.commentaries.length : 0;
	}

	public getFilesCount(evenement: Evenement): number {
		return evenement.fileUploadeds ? evenement.fileUploadeds.length : 0;
	}

	public getEventComments(evenement: Evenement): any[] {
		if (!evenement.commentaries || evenement.commentaries.length === 0) {
			return [];
		}
		
		// Trier les commentaires par date de création décroissante (plus récent en premier)
		return evenement.commentaries.sort((a, b) => {
			const dateA = new Date(a.dateCreation).getTime();
			const dateB = new Date(b.dateCreation).getTime();
			return dateB - dateA;
		});
	}

	public openCommentsModal(evenement: Evenement): void {
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
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

	// Photo selection - now handled by PhotosSelectorModalComponent
	private currentEventForPhotosSelector: Evenement | null = null;

	// File thumbnails cache
	private fileThumbnailsCache: Map<string, SafeUrl> = new Map();
	private fileThumbnailsLoading: Set<string> = new Set();

	// Check if file is an image based on extension
	public isImageFile(fileName: string): boolean {
		if (!fileName) return false;
		
		const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
		const lowerFileName = fileName.toLowerCase();
		
		return imageExtensions.some(ext => lowerFileName.endsWith(ext));
	}

	// Check if event has image files
	public hasImageFiles(evenement: Evenement): boolean {
		return evenement.fileUploadeds && evenement.fileUploadeds.some(file => this.isImageFile(file.fileName));
	}

	// Get count of image files
	public getImageFilesCount(evenement: Evenement): number {
		if (!evenement.fileUploadeds) return 0;
		return evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName)).length;
	}

	// =========================
	// Photo From FS integration
	// =========================

	public getPhotoFromFsLinks(evenement: Evenement): UrlEvent[] {
		if (!evenement || !evenement.urlEvents) return [];
		return evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOFROMFS');
	}

	public getPhotosUrlLinks(evenement: Evenement): UrlEvent[] {
		if (!evenement || !evenement.urlEvents) return [];
		return evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOS');
	}

	public getPhotoFromFsCount(evenement: Evenement): number {
		return this.getPhotoFromFsLinks(evenement).length;
	}

	public getTotalPhotosCount(evenement: Evenement): number {
		// Each photo source counts as 1, regardless of how many photos it contains
		let count = 0;
		// Photos uploadées: count as 1 if any exist
		if (this.hasImageFiles(evenement)) {
			count += 1;
		}
		// Each FS link counts as 1
		count += this.getPhotoFromFsCount(evenement);
		// Each web photo link counts as 1
		count += this.getPhotosUrlLinks(evenement).length;
		return count;
	}

	public openFsPhotosSelector(evenement: Evenement, includeUploadedChoice: boolean = false): void {
		const fsLinks = this.getPhotoFromFsLinks(evenement);
		const webLinks = this.getPhotosUrlLinks(evenement);
		const hasAnyLinks = (fsLinks.length + webLinks.length) > 0;

		if (!includeUploadedChoice && !hasAnyLinks) {
			return;
		}
		if (!includeUploadedChoice && fsLinks.length === 1 && webLinks.length === 0) {
			this.openFsPhotosDiaporama(evenement, fsLinks[0].link, true);
			return;
		}
		
		// Use the new photos selector modal component
		if (this.photosSelectorModalComponent) {
			this.currentEventForPhotosSelector = evenement;
			this.photosSelectorModalComponent.evenement = evenement;
			this.photosSelectorModalComponent.includeUploadedChoice = includeUploadedChoice;
			this.photosSelectorModalComponent.open();
		}
	}

	public onPhotosSelectionConfirmed(result: PhotosSelectionResult): void {
		if (!this.currentEventForPhotosSelector) return;
		const evenement = this.currentEventForPhotosSelector;
		this.currentEventForPhotosSelector = null; // Reset after use
		
		if (result.type === 'uploaded') {
			this.openSlideshow(evenement);
		} else if (result.type === 'web') {
			try { this.winRef.getNativeWindow().open(result.value, '_blank'); } catch {}
		} else if (result.type === 'fs') {
			this.openFsPhotosDiaporama(evenement, result.value, result.compressFs !== false);
		}
	}

	private openFsPhotosDiaporama(evenement: Evenement, relativePath: string, compress: boolean = true): void {
		// Open slideshow modal immediately with empty array - images will be loaded dynamically
		if (!this.slideshowModalComponent) {
			console.error('Slideshow modal component not available');
			return;
		}
		
		// Open modal immediately with empty array
		this.slideshowModalComponent.open([], evenement.evenementName, false);
		
		// Then list and load images dynamically
		this._fileService.listImagesFromDisk(relativePath).subscribe({
			next: (fileNames: string[]) => {
				if (!fileNames || fileNames.length === 0) {
					return;
				}
				
				// Delegate loading to the slideshow component queue (higher concurrency, built-in caching)
				const imageSources: SlideshowImageSource[] = fileNames.map((fileName: string) => ({
					fileId: undefined,
					blobUrl: undefined,
					fileName,
					relativePath,
					compressFs: compress
				}));

				if (this.slideshowModalComponent && imageSources.length > 0) {
					this.slideshowModalComponent.addImages(imageSources);
				}
			},
			error: (error) => {
				console.error('Error listing images from disk:', error);
			}
		});
	}
	// Unified photos opener (uploaded photos or FS photos)
	public openPhotos(evenement: Evenement): void {
		const hasFs = this.getPhotoFromFsCount(evenement) > 0;
		const hasPhotosWeb = this.getPhotosUrlLinks(evenement).length > 0;
		const hasUploaded = this.hasImageFiles(evenement);

		if ((hasFs || hasPhotosWeb) && hasUploaded) {
			this.openFsPhotosSelector(evenement, true);
			return;
		}
		if (hasFs || hasPhotosWeb) {
			this.openFsPhotosSelector(evenement, false);
			return;
		}
		if (hasUploaded) {
			this.openSlideshow(evenement);
		}
	}

	// Open slideshow modal with all images from this event
	public openSlideshow(evenement: Evenement): void {
		// Filter to get only image files
		const imageFiles = evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
		
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
			this.slideshowModalComponent.open(imageSources, evenement.evenementName, true);
		}
	}

	// Open a single image in slideshow modal
	public openSingleImageInSlideshow(fileId: string, fileName: string, eventName: string = ''): void {
		if (!this.slideshowModalComponent) {
			console.error('Slideshow modal component not available');
			return;
		}
		
		// Prepare image source for the clicked image
		const imageSource: SlideshowImageSource = {
			fileId: fileId,
			blobUrl: undefined,
			fileName: fileName
		};

		// Open the slideshow modal with just this one image
		this.slideshowModalComponent.open([imageSource], eventName, true);
	}

	// =========================
	// Slideshow methods (now handled by SlideshowModalComponent)
	// =========================
	
	// =========================
	// File Management Methods
	// =========================
	
	// Get the file url with the bearer token for authentication
	public getFileBlobUrl(fileId: string): Observable<any> {
		return this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		);
	}
	
	// Open window when click on download button
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
		});
	}
	
	// Delete a file uploaded linked to the evenement
	public delFile(fieldId: string) {
		if (confirm("Are you sure you want to delete the file ? ")) {
			if (!this.selectedEvent || !this.selectedEvent.fileUploadeds) {
				return;
			}
			
			// Find the file being deleted
			const fileToDelete = this.selectedEvent.fileUploadeds.find(fileUploaded => fileUploaded.fieldId === fieldId);
			
			if (fileToDelete) {
				// Remove the file from the list
				this.selectedEvent.fileUploadeds = this.selectedEvent.fileUploadeds.filter(fileUploaded => !(fileUploaded.fieldId == fieldId));
				this.updateFileUploadedInEvent(this.selectedEvent);
				// Refresh the events list
				this.resetAndLoadEvents();
			}
		}
	}
	
	// Check if user is file owner
	public isFileOwner(member: Member): boolean {
		return this.user.id == member.id;
	}
	
	// Check if file is a PDF based on extension
	public isPdfFile(fileName: string): boolean {
		if (!fileName) return false;
		const lowerFileName = fileName.toLowerCase();
		return lowerFileName.endsWith('.pdf');
	}
	
	// Handle file click based on file type
	public handleFileClick(uploadedFile: any, eventName: string = ''): void {
		if (this.isImageFile(uploadedFile.fileName)) {
			this.openSingleImageInSlideshow(uploadedFile.fieldId, uploadedFile.fileName, eventName);
		} else if (this.isPdfFile(uploadedFile.fileName)) {
			this.openPdfFile(uploadedFile.fieldId, uploadedFile.fileName);
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
	
	// Open file image in modal
	public openFileImageModal(fileId: string, fileName: string): void {
		// Use getFile for display (with image resizing)
		this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return URL.createObjectURL(blob);
			})
		).subscribe((objectUrl: string) => {
			// Set the image URL and alt text
			this.selectedImageUrl = objectUrl;
			this.selectedImageAlt = fileName;
			
			if (!this.imageModal) {
				return;
			}
			
			// Open the modal
			this.modalService.open(this.imageModal, { 
				size: 'lg', 
				centered: true,
				backdrop: 'static',
				keyboard: false,
				animation: false,
				windowClass: 'modal-smooth-animation'
			});
		}, (error) => {
			console.error('Error loading file:', error);
			alert('Erreur lors du chargement du fichier');
		});
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
	
	// Get appropriate tooltip for file
	public getFileTooltip(fileName: string): string | null {
		if (this.isImageFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_VIEW');
		} else if (this.isPdfFile(fileName)) {
			return this.translateService.instant('EVENTELEM.CLICK_TO_OPEN_PDF');
		}
		return null;
	}
	
	// Download all files from the event as a single ZIP file
	public async downloadAllFilesForEvent(evenement: Evenement): Promise<void> {
		if (!evenement.fileUploadeds || evenement.fileUploadeds.length === 0) {
			alert('Aucun fichier à télécharger');
			return;
		}

		// Show loading message
		const loadingMessage = `Téléchargement de ${evenement.fileUploadeds.length} fichier(s)...`;
		
		console.log('Starting download of all files:', evenement.fileUploadeds.length);
		
		try {
			// Create a new ZIP file
			const zip = new JSZip();
			let successCount = 0;
			
			// Download all files and add them to the ZIP
			const downloadPromises = evenement.fileUploadeds.map(async (file) => {
				try {
					console.log(`Fetching file: ${file.fileName}`);
					const blob = await firstValueFrom(this.getFileBlobUrl(file.fieldId));
					zip.file(file.fileName, blob);
					successCount++;
					console.log(`Added to ZIP: ${file.fileName} (${successCount}/${evenement.fileUploadeds.length})`);
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
			const zipFileName = `${evenement.evenementName}_files_${new Date().getTime()}.zip`;
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
	
	// =========================
	// File Upload Methods
	// =========================
	
	public onFileSelected(event: any, evenement: Evenement): void {
		const files: FileList = event.target.files;
		if (files && files.length > 0) {
			this.selectedFiles = Array.from(files);
			this.uploadFiles(evenement);
		}
	}

	private uploadFiles(evenement: Evenement): void {
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
		const uploadUrl = `${this.API_URL4FILE}/${this.user.id}/${evenement.id}`;

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
						this.handleUploadResponse(response, evenement);
						
						// Clear selected files
						this.selectedFiles = [];
						// Reset file input for this specific event
						const fileInput = document.querySelector(`input[id="file-upload-input-${evenement.id}"]`) as HTMLInputElement;
						if (fileInput) {
							fileInput.value = '';
						}
						
						setTimeout(() => {
							this.isUploading = false;
							// Don't close modal automatically, let user close it manually
							// Refresh the events list
							this.resetAndLoadEvents();
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

	private handleUploadResponse(response: any, evenement: Evenement): void {
		try {
			// The response from database upload should contain the uploaded file information
			if (response && Array.isArray(response)) {
				// Response is directly an array of uploaded files
				this.addUploadedFilesToEvent(response, evenement);
			} else if (response && (response.uploadedFiles || response.files)) {
				// Response contains uploaded files in a property
				const uploadedFiles = response.uploadedFiles || response.files;
				this.addUploadedFilesToEvent(uploadedFiles, evenement);
			} else if (response && response.fieldId) {
				// Response is a single uploaded file object
				this.addUploadedFilesToEvent([response], evenement);
			} else {
				// Fallback: create uploaded file entries based on selected files
				console.log('No file information in response, creating entries from selected files');
				this.createUploadedFileEntries(evenement);
			}
		} catch (error) {
			console.error('Error processing upload response:', error);
			// Fallback: create uploaded file entries based on selected files
			this.createUploadedFileEntries(evenement);
		}
	}

	private addUploadedFilesToEvent(uploadedFilesData: any[], evenement: Evenement): void {
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
			}
			
			// Add to event's file list if not already present
			if (!evenement.fileUploadeds) {
				evenement.fileUploadeds = [];
			}
			const existingFile = evenement.fileUploadeds.find(f => f.fieldId === uploadedFile.fieldId);
			if (!existingFile) {
				evenement.fileUploadeds.push(uploadedFile);
			}
		}
		
		// Update the event in database
		this.updateFileUploadedInEvent(evenement);
	}

	private createUploadedFileEntries(evenement: Evenement): void {
		const newUploadedFiles: any[] = [];
		
		for (let file of this.selectedFiles) {
			const uploadedFile = new UploadedFile(
				this.generateFileId(),
				file.name,
				file.type || 'unknown',
				this.user
			);
			
			if (!evenement.fileUploadeds) {
				evenement.fileUploadeds = [];
			}
			const existingFile = evenement.fileUploadeds.find(f => f.fileName === uploadedFile.fileName);
			if (!existingFile) {
				evenement.fileUploadeds.push(uploadedFile);
				newUploadedFiles.push(uploadedFile);
			}
		}
		
		// Update the event in database
		this.updateFileUploadedInEvent(evenement);
	}

	private generateFileId(): string {
		return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
	}

	// Check if a File object is an image based on MIME type
	private isImageFileByMimeType(file: File): boolean {
		const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'];
		return imageTypes.includes(file.type.toLowerCase());
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
}
