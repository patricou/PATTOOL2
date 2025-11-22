import { Component, OnInit, HostListener, ElementRef, AfterViewInit, ViewChild, ViewChildren, QueryList, OnDestroy, TemplateRef, ChangeDetectorRef } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource } from '../../shared/slideshow-modal/slideshow-modal.component';
import { PhotosSelectorModalComponent, PhotosSelectionResult } from '../../shared/photos-selector-modal/photos-selector-modal.component';
import { Observable, Subscription, fromEvent, firstValueFrom, forkJoin, of } from 'rxjs';
import { debounceTime, map, mergeMap, catchError } from 'rxjs/operators';
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
import { ElementEvenementComponent } from '../element-evenement/element-evenement.component';

interface EventColorUpdate {
	eventId: string;
	color: { r: number; g: number; b: number };
}

interface LoadingEventInfo {
	eventId: string;
	cardLoadStart: number;
	cardLoadEnd?: number;
	thumbnailLoadStart?: number;
	thumbnailLoadEnd?: number;
}

@Component({
	selector: 'home-evenements',
	templateUrl: './home-evenements.component.html',
	styleUrls: ['./home-evenements.component.css'],
})
export class HomeEvenementsComponent implements OnInit, AfterViewInit, OnDestroy {

	public evenements: Evenement[] = [];
	private visibleEvenements: Evenement[] = [];
	private bufferedEvenements: Evenement[] = [];
	private allLoadedEvenements: Evenement[] = [];
	private readonly INITIAL_VISIBLE_COUNT: number = 8; // Afficher 8 cards d'abord
	private readonly SCROLL_INCREMENT: number = 8; // Afficher 8 cards supplémentaires à chaque scroll
	private readonly BUFFER_SIZE: number = 12; // Cache de 12 cards avec thumbnails
	private readonly MIN_BUFFER_SIZE: number = 12; // Toujours maintenir 12 cards en cache
	private readonly CACHE_TRIGGER_THRESHOLD: number = 9; // Trigger load when cache drops below 9
	private readonly TOTAL_ELEMENTS_PER_PAGE: number = this.INITIAL_VISIBLE_COUNT + this.BUFFER_SIZE; // 8 + 12 = 20
	public cardsReady: boolean = false;
	public isLoading: boolean = false; // État de chargement pour le spinner
	public user: Member = new Member("", "", "", "", "", [], "");
	public pageNumber: number = this._commonValuesService.getPageNumber();
	public elementsByPage: number = this.TOTAL_ELEMENTS_PER_PAGE; // Synchronisé avec visible + cache
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
	public debugInfoCollapsed: boolean = true; // Debug info panel collapsed by default
	public cachedMemoryUsage: string = 'N/A'; // Cached memory usage to prevent change detection errors
	public cachedMemoryUsagePercent: number = 0; // Cached memory usage percentage
	public cachedCardLoadTime: number = 0; // Cached card load time to prevent change detection errors
	public cachedThumbnailLoadTime: number = 0; // Cached thumbnail load time to prevent change detection errors
	@ViewChildren('searchterm')
	public searchterms!: QueryList<ElementRef>;
	@ViewChildren('patCard') patCards!: QueryList<ElementRef>;
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
	@ViewChild('cardsContainer', { static: false }) cardsContainer?: ElementRef<HTMLDivElement>;
	private eventsSubscription?: Subscription;
	private searchSubscriptions: Subscription[] = [];
	private allSubscriptions: Subscription[] = []; // Track all subscriptions for cleanup
	private intersectionObserver?: IntersectionObserver;
	private feedRequestToken = 0;
	private prefetchTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private readonly prefetchThresholdMultiplier = 2;
	private updateAverageColorTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private lastAverageRgb: { r: number; g: number; b: number } | null = null;
	private shouldBlockScroll: boolean = false;
	private scrollCheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private pollIntervalId: ReturnType<typeof setInterval> | null = null;
	private firebaseUnsubscribe?: () => void;
	private activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
	private debugInfoUpdateInterval?: ReturnType<typeof setInterval>;
	private loadingEvents: Map<string, LoadingEventInfo> = new Map(); // Track events being loaded with timestamps
	private isLoadingMoreFromBuffer: boolean = false; // Prevent multiple simultaneous calls to loadMoreFromBuffer
	private loadMoreFromBufferTimeoutId: ReturnType<typeof setTimeout> | null = null; // Debounce timer for loadMoreFromBuffer

	constructor(private _evenementsService: EvenementsService,
		private _memberService: MembersService,
		private _fileService: FileService,
		private _router: Router,
		private _commonValuesService: CommonvaluesService,
		private sanitizer: DomSanitizer,
		private winRef: WindowRefService,
		private modalService: NgbModal,
		private translateService: TranslateService,
		private database: Database,
		private cdr: ChangeDetectorRef) {
		this.nativeWindow = winRef.getNativeWindow();
		this.averageColor = this.defaultAverageColor;
		this.averageTextColor = this.defaultAverageTextColor;
		this.averageBorderColor = this.defaultAverageBorderColor;
		this.averageGradient = this.buildGradientFromColor(this.defaultAverageColor);
	}

	ngOnInit() {
		this.user = this._memberService.getUser();
		this.cardsReady = false;
		
		// Reset pageNumber to 0 at startup to ensure clean state
		// This prevents issues where the service might have an old page number
		this.pageNumber = 0;
		this._commonValuesService.setPageNumber(0);
		
		// Initialize cached memory usage and load times
		this.updateCachedMemoryUsage();
		
		// Start real-time updates for debug info panel when visible
		this.startDebugInfoUpdates();
		
		// Check if we need to load a specific event first (when returning from update)
		const storedDataStr = sessionStorage.getItem('lastViewedEventData');
		const storedEventId = sessionStorage.getItem('lastViewedEventId');
		const eventId = storedDataStr ? (() => {
			try {
				const data = JSON.parse(storedDataStr);
				return data.eventId;
			} catch (e) {
				return null;
			}
		})() : storedEventId;
		
		// Always reset first to ensure clean state
		this.resetAndLoadEvents();
		
		// After reset, load specific event if needed (this will be handled in resetAndLoadEvents)
		if (eventId) {
			// Block scrolling until cards are ready
			this.shouldBlockScroll = true;
			this.blockPageScroll();
			// Load the specific event first, but after reset
			// Note: resetAndLoadEvents will preserve it if it exists
			this.loadAndDisplayEventFirst(eventId);
		}
		
		this.updateResponsiveState(this.nativeWindow.innerWidth);
		// Initialize controls collapsed state based on screen size
		if (this.isMobile) {
			this.controlsCollapsed = true;
		}
		
	}

	private startDebugInfoUpdates(): void {
		// Clear any existing interval
		if (this.debugInfoUpdateInterval) {
			clearInterval(this.debugInfoUpdateInterval);
			this.debugInfoUpdateInterval = undefined;
		}
		
		// Update debug info in real-time every 100ms (0.1 second) when panel is visible
		// Use detectChanges for immediate updates of all debug information
		this.debugInfoUpdateInterval = setInterval(() => {
			if (!this.debugInfoCollapsed) {
				// Update cached memory usage asynchronously to prevent change detection errors
				this.updateCachedMemoryUsage();
				// Clean up unused thumbnails periodically
				this.cleanupUnusedThumbnails();
				// Force immediate change detection for real-time updates
				this.cdr.detectChanges();
			}
		}, 100);
	}
	
	// Update cached memory usage values asynchronously
	private updateCachedMemoryUsage(): void {
		// Check if performance.memory is available (Chrome/Edge)
		if (this.nativeWindow.performance && (this.nativeWindow.performance as any).memory) {
			const memory = (this.nativeWindow.performance as any).memory;
			const usedMB = (memory.usedJSHeapSize / 1048576).toFixed(2);
			const totalMB = (memory.totalJSHeapSize / 1048576).toFixed(2);
			const limitMB = (memory.jsHeapSizeLimit / 1048576).toFixed(2);
			this.cachedMemoryUsage = `${usedMB} MB / ${totalMB} MB (limite: ${limitMB} MB)`;
			this.cachedMemoryUsagePercent = Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100);
		} else if ((this.nativeWindow.navigator as any).deviceMemory) {
			// Fallback: try to estimate from navigator.deviceMemory if available
			const deviceMemory = (this.nativeWindow.navigator as any).deviceMemory;
			this.cachedMemoryUsage = `N/A (RAM: ${deviceMemory} GB)`;
			this.cachedMemoryUsagePercent = 0;
		} else {
			this.cachedMemoryUsage = 'N/A';
			this.cachedMemoryUsagePercent = 0;
		}
		
		// Update cached load times to prevent change detection errors
		this.updateCachedLoadTimes();
	}
	
	// Update cached load times asynchronously
	private updateCachedLoadTimes(): void {
		// Update card load time
		const first = this.loadingEvents.values().next().value;
		if (first && first.cardLoadStart) {
			const end = first.cardLoadEnd || Date.now();
			this.cachedCardLoadTime = end - first.cardLoadStart;
		} else {
			this.cachedCardLoadTime = 0;
		}
		
		// Update thumbnail load time
		if (first && first.thumbnailLoadStart) {
			const end = first.thumbnailLoadEnd || Date.now();
			this.cachedThumbnailLoadTime = end - first.thumbnailLoadStart;
		} else {
			this.cachedThumbnailLoadTime = 0;
		}
	}

	@HostListener('window:resize', ['$event'])
	onWindowResize(event: UIEvent): void {
		const width = (event.target as Window)?.innerWidth ?? this.nativeWindow.innerWidth;
		this.updateResponsiveState(width);
	}

	@HostListener('window:scroll', ['$event'])
	onWindowScroll(event: Event): void {
		// Remove scroll listener - we use IntersectionObserver only for smooth scrolling
		// This prevents conflicts and ensures smooth infinite scroll
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
		// Listen to both mobile and desktop inputs
		this.searchterms.changes.subscribe(() => {
			this.setupSearchInputs();
		});
		this.setupSearchInputs();
		this.setupInfiniteScrollObserver();
		
		// Écouter les changements des cards pour déclencher l'animation
				this.patCards.changes.subscribe(() => {
					if (this.patCards.length > 0 && !this.cardsReady) {
						// Use requestAnimationFrame for better performance, then do DOM operations
						requestAnimationFrame(() => {
							this.cardsReady = true;
							this.cdr.markForCheck();
							// Always unblock scrolling once cards are ready
							this.unblockPageScroll();
							this.shouldBlockScroll = false;
							// Check for stored card to scroll to after cards are ready
							// Use another requestAnimationFrame for scroll operations
							requestAnimationFrame(() => {
								this.checkAndScrollToStoredCard();
							});
						});
					} else if (this.patCards.length > 0 && this.cardsReady) {
						// Cards are already ready, always unblock scrolling
						this.unblockPageScroll();
						this.shouldBlockScroll = false;
						// Cards are already ready, check for stored card
						this.checkAndScrollToStoredCard();
					}
				});
		
		// Also check after a delay in case cards are already loaded
		setTimeout(() => {
			if (this.patCards && this.patCards.length > 0) {
				// Always unblock scrolling if cards are loaded
				this.unblockPageScroll();
				this.shouldBlockScroll = false;
				this.checkAndScrollToStoredCard();
			}
		}, 1500);
		
		// Final guarantee: always unblock scroll after 3 seconds maximum
		// This ensures scroll is never permanently blocked
		setTimeout(() => {
			this.unblockPageScroll();
			this.shouldBlockScroll = false;
		}, 3000);
	}

	private setupSearchInputs(): void {
		// Unsubscribe from previous subscriptions
		this.searchSubscriptions.forEach(sub => sub.unsubscribe());
		this.searchSubscriptions = [];

		this.searchterms.forEach((searchtermRef: ElementRef) => {
			if (searchtermRef && searchtermRef.nativeElement) {
				// Reduce debounceTime from 700ms to 300ms for better responsiveness
				// With [(ngModel)], text appears immediately in the input
				const eventObservable = fromEvent(searchtermRef.nativeElement, 'input')
					.pipe(debounceTime(300));

				const subscription = eventObservable.subscribe(
					((data: any) => {
						// With [(ngModel)], dataFIlter is already updated automatically
						// Just synchronize with the service and trigger filtering
						const filterValue = this.dataFIlter; // Already updated by ngModel
						this._commonValuesService.setDataFilter(filterValue);
						
						// Reset and reload events with the new filter
						this.pageNumber = 0;
						this._commonValuesService.setPageNumber(this.pageNumber);
						this.resetAndLoadEvents();
					}),
					((err: any) => console.error(err))
				);
				this.searchSubscriptions.push(subscription);
			}
		});
	}

	private waitForNonEmptyValue(): Promise<void> {
		return new Promise<void>((resolve) => {
			const checkValue = () => {
				if (this.user.id !== "") {
					resolve();
				} else {
					setTimeout(checkValue, 100);
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
		this.isLoading = true; // Activer le spinner
		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}
		// Force reset pageNumber to 0 and clear service
		this.pageNumber = 0;
		this._commonValuesService.setPageNumber(0);
		// Synchroniser elementsByPage avec le total à charger (visible + cache)
		this.elementsByPage = this.TOTAL_ELEMENTS_PER_PAGE;
		this._commonValuesService.setElementsByPage(this.elementsByPage);
		
		// Preserve first event if it was loaded for return navigation
		const storedDataStr = sessionStorage.getItem('lastViewedEventData');
		const storedEventId = sessionStorage.getItem('lastViewedEventId');
		const eventId = storedDataStr ? (() => {
			try {
				const data = JSON.parse(storedDataStr);
				return data.eventId;
			} catch (e) {
				return null;
			}
		})() : storedEventId;
		
		const firstEvent = this.evenements.length > 0 && eventId && 
			(this.evenements[0].id === eventId || this.getEventKey(this.evenements[0]) === eventId) 
			? this.evenements[0] : null;
		this.evenements = [];
		this.visibleEvenements = [];
		this.bufferedEvenements = [];
		this.allLoadedEvenements = [];
		this.loadingEvents.clear(); // Clear loading events set
		this.isLoadingMoreFromBuffer = false; // Reset flag on reset
		if (firstEvent) {
			// Keep the first event that was loaded for return
			this.evenements = [firstEvent];
		}
		
		this.filteredTotal = 0;
		this.resetColorAggregation();
		if (this.infiniteScrollAnchor?.nativeElement) {
			this.setupInfiniteScrollObserver();
		}
		this.loadInitialEvents();
	}

	private loadInitialEvents(): void {
		if (this.isLoadingNextPage) {
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
		this.isLoading = true; // Activer le spinner

		this.waitForNonEmptyValue().then(() => {
			if (requestToken !== this.feedRequestToken) {
				return;
			}
			this.eventsSubscription?.unsubscribe();
			
			// Charger initial visible count + buffer size (8 + 12 = 20 events)
			// Utiliser elementsByPage qui est synchronisé avec TOTAL_ELEMENTS_PER_PAGE
			const totalToLoad = this.elementsByPage; // = INITIAL_VISIBLE_COUNT + BUFFER_SIZE = 20
			const subscription = this._evenementsService
				.getEvents(searchString, pageToLoad, totalToLoad, this.user.id)
				.subscribe({
					next: (res: any) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						const newEvents: Evenement[] = res?.content ?? [];

						this.isLoadingNextPage = false;
						this.isLoading = false; // Désactiver le spinner
						this.cardsReady = false;
						// Ensure scroll is unblocked after loading
						this.unblockPageScroll();
						
						// Get first event if exists (special event for return navigation)
						const firstEvt = this.evenements.length > 0 ? this.evenements[0] : null;
						const firstEventId = firstEvt ? (firstEvt.id || this.getEventKey(firstEvt)) : null;
						
						// Filter out the first event from new events if it exists, and any duplicates
						let filteredNewEvents = firstEventId ? 
							newEvents.filter(e => {
								const eId = e.id || this.getEventKey(e);
								return eId !== firstEventId;
							}) : 
							newEvents;
						
						// Also filter out any events that are already loaded (additional safety check)
						filteredNewEvents = filteredNewEvents.filter(e => !this.isEventAlreadyLoaded(e));
						
						// Store all loaded events (excluding first event which is already in evenements)
						this.allLoadedEvenements = filteredNewEvents;
						
						// Split into visible and buffer
						// Visible events: first INITIAL_VISIBLE_COUNT (8 cards)
						this.visibleEvenements = this.allLoadedEvenements.slice(0, this.INITIAL_VISIBLE_COUNT);
						// Buffered events: next BUFFER_SIZE (12 cards)
						this.bufferedEvenements = this.allLoadedEvenements.slice(
							this.INITIAL_VISIBLE_COUNT, 
							this.INITIAL_VISIBLE_COUNT + this.BUFFER_SIZE
						);
						
						// Mark initial visible events as loading with timestamps
						this.visibleEvenements.forEach(e => {
							const eId = e.id || this.getEventKey(e);
							if (eId) {
								this.loadingEvents.set(eId, {
									eventId: eId,
									cardLoadStart: Date.now()
								});
							}
						});
						
						// Load all thumbnails in parallel for better performance
						this.loadThumbnailsInParallel(this.visibleEvenements, true);
						
						// Combine visible with first event if exists (avoid duplication)
						if (firstEvt) {
							// Make sure firstEvt is not already in visibleEvenements
							const firstEvtInVisible = this.visibleEvenements.some(e => {
								const eId = e.id || this.getEventKey(e);
								return eId === firstEventId;
							});
							
							if (!firstEvtInVisible) {
								this.evenements = [firstEvt, ...this.visibleEvenements];
							} else {
								// First event already in visible, don't duplicate
								this.evenements = this.visibleEvenements;
							}
						} else {
							this.evenements = this.visibleEvenements;
						}
						
						// Mark card load end after cards are rendered (with a small delay for animation)
						setTimeout(() => {
							this.visibleEvenements.forEach(e => {
								const eId = e.id || this.getEventKey(e);
								if (eId) {
									const loadingInfo = this.loadingEvents.get(eId);
									if (loadingInfo) {
										loadingInfo.cardLoadEnd = Date.now();
										// Keep in map until thumbnail is also loaded
										if (loadingInfo.thumbnailLoadEnd || !loadingInfo.thumbnailLoadStart) {
											// Thumbnail already loaded or not needed, remove from loading
											this.loadingEvents.delete(eId);
										}
										this.cdr.markForCheck();
									}
								}
							});
						}, 500); // 500ms delay to show loading indicator
						
						// Preload thumbnails for buffered events immediately
						// This ensures all 12 buffer cards have thumbnails ready for smooth display
						// No setTimeout, load immediately
						this.preloadThumbnailsForBufferedEvents();
						
						// Clean up unused thumbnails after loading initial events
						this.cleanupUnusedThumbnails();
						
						// After loading initial events, ensure buffer is at maximum size
						// Trigger load when cache drops below trigger threshold (8)
						if (this.bufferedEvenements.length < this.CACHE_TRIGGER_THRESHOLD && 
						    this.hasMoreEvents && 
						    !this.isLoadingNextPage) {
							// Load immediately to maintain cache at maximum (up to 12)
							this.loadNextPage();
						}
						
						// Update page number
						const firstEvtCount = this.evenements.length > 0 && this.evenements[0] ? 1 : 0;
						this.filteredTotal = res?.page?.totalElements ?? (this.allLoadedEvenements.length + firstEvtCount);
						const totalPages = res?.page?.totalPages ?? null;
						
						// For initial load, always use page 0 (first page)
						// Don't trust server page number for initial load as it might be incorrect
						if (pageToLoad === 0) {
							this.pageNumber = 1; // Display as page 1 (but we're on page 0 internally)
							this._commonValuesService.setPageNumber(0);
						} else {
							// For subsequent loads, use server response
							const currentPageFromResponse = res?.page?.number ?? pageToLoad;
							this.pageNumber = currentPageFromResponse + 1;
							this._commonValuesService.setPageNumber(currentPageFromResponse);
						}

						// Check if we need to load more from server
						if (this.allLoadedEvenements.length < totalToLoad) {
							this.hasMoreEvents = false;
						} else if (totalPages !== null) {
							this.hasMoreEvents = this.pageNumber < totalPages;
						} else {
							this.hasMoreEvents = newEvents.length >= totalToLoad;
						}

						if (!this.hasMoreEvents && this.bufferedEvenements.length === 0) {
							this.disconnectInfiniteScrollObserver();
						}
						
						// Forcer la détection de changements
						this.cdr.detectChanges();
						
						// Setup observer immediately after events are loaded
						requestAnimationFrame(() => {
							this.setupInfiniteScrollObserver();
							// Ne PAS charger immédiatement après le chargement initial
							// Attendre que l'utilisateur scrolle vraiment
							// L'IntersectionObserver se chargera de déclencher le chargement quand nécessaire
						});
						
					// Attendre que les cards soient vraiment dans le DOM
					setTimeout(() => {
						if (this.patCards && this.patCards.length > 0) {
							this.cardsReady = true;
							this.cdr.markForCheck();
							// Always unblock scrolling once cards are ready
							this.unblockPageScroll();
							this.shouldBlockScroll = false;
						} else {
							// Si pas encore de cards, réessayer
							setTimeout(() => {
								this.cardsReady = true;
								this.cdr.markForCheck();
								// Always unblock scrolling once cards are ready
								this.unblockPageScroll();
								this.shouldBlockScroll = false;
							}, 100);
						}
					}, 150);
					},
					error: (err: any) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						console.error("Error when getting Events", err);
						this.isLoadingNextPage = false;
						this.isLoading = false; // Désactiver le spinner en cas d'erreur
						this.hasMoreEvents = false;
						// Always unblock scrolling on error
						this.unblockPageScroll();
					}
				});
			this.eventsSubscription = subscription;
			this.allSubscriptions.push(subscription);
		}).catch((err) => {
			// Only reset flags if this is still the current request
			if (requestToken === this.feedRequestToken) {
				console.error("Error while waiting for user value", err);
				this.isLoadingNextPage = false;
				this.isLoading = false; // Désactiver le spinner en cas d'erreur
				this.hasMoreEvents = false;
				// Always unblock scrolling on error
				this.unblockPageScroll();
			}
		});
	}

	private isEventAlreadyLoaded(event: Evenement): boolean {
		const eventId = event.id || this.getEventKey(event);
		if (!eventId) return false;
		
		// Check in all loaded events
		const inAllLoaded = this.allLoadedEvenements.some(e => {
			const eId = e.id || this.getEventKey(e);
			return eId === eventId;
		});
		
		if (inAllLoaded) return true;
		
		// Check in visible events
		const inVisible = this.visibleEvenements.some(e => {
			const eId = e.id || this.getEventKey(e);
			return eId === eventId;
		});
		
		if (inVisible) return true;
		
		// Check in buffered events
		const inBuffered = this.bufferedEvenements.some(e => {
			const eId = e.id || this.getEventKey(e);
			return eId === eventId;
		});
		
		if (inBuffered) return true;
		
		// Check in displayed events (first event special case)
		if (this.evenements.length > 0) {
			const firstEvtId = this.evenements[0].id || this.getEventKey(this.evenements[0]);
			if (firstEvtId === eventId) return true;
		}
		
		return false;
	}

	private loadNextPage(): void {
		if (!this.hasMoreEvents) {
			return;
		}
		
		// Check if we're really loading - if flag is true but no active subscription, reset it
		if (this.isLoadingNextPage) {
			if (!this.eventsSubscription || this.eventsSubscription.closed) {
				console.warn('isLoadingNextPage is true but no active subscription - resetting flag');
				this.isLoadingNextPage = false;
				this.isLoading = false;
			} else {
				// Really loading, don't start another one
				return;
			}
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
		this.isLoading = true; // Activer le spinner
		// Ensure scroll is unblocked when loading next page
		this.unblockPageScroll();
		
		// Safety timeout: if loading takes more than 30 seconds, reset the flag
		let loadingTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			if (this.isLoadingNextPage) {
				console.warn('Loading timeout: resetting isLoadingNextPage flag');
				this.isLoadingNextPage = false;
				this.isLoading = false;
			}
			loadingTimeout = null;
		}, 30000);

		this.waitForNonEmptyValue().then(() => {
			if (requestToken !== this.feedRequestToken) {
				// Request token changed, reset flags and return
				this.isLoadingNextPage = false;
				this.isLoading = false;
				if (loadingTimeout) {
					clearTimeout(loadingTimeout);
					loadingTimeout = null;
				}
				return;
			}
			// Unsubscribe previous subscription if still active
			if (this.eventsSubscription && !this.eventsSubscription.closed) {
				this.eventsSubscription.unsubscribe();
			}
			
			// Calculate how many events to load to reach MIN_BUFFER_SIZE (12)
			// Always maintain exactly 12 events in cache
			const currentBufferSize = this.bufferedEvenements.length;
			const eventsToLoad = Math.max(0, this.MIN_BUFFER_SIZE - currentBufferSize);
			
			// If we already have enough in cache, don't load
			if (eventsToLoad === 0) {
				this.isLoadingNextPage = false;
				this.isLoading = false;
				return;
			}
			
			// Load only what's needed to fill cache to 12
			const subscription = this._evenementsService
				.getEvents(searchString, pageToLoad, eventsToLoad, this.user.id)
				.subscribe({
					next: (res: any) => {
						if (requestToken !== this.feedRequestToken) {
							// Request token changed, reset flags and return
							if (loadingTimeout) {
								clearTimeout(loadingTimeout);
								loadingTimeout = null;
							}
							this.isLoadingNextPage = false;
							this.isLoading = false;
							return;
						}
						const newEvents: Evenement[] = res?.content ?? [];

						if (loadingTimeout) {
							clearTimeout(loadingTimeout);
							loadingTimeout = null;
						}
						this.isLoadingNextPage = false;
						this.isLoading = false; // Désactiver le spinner
						// Ensure scroll is unblocked after loading
						this.unblockPageScroll();
						
						// Filter out events that are already loaded to avoid duplicates
						const uniqueNewEvents = newEvents.filter(e => !this.isEventAlreadyLoaded(e));
						
						// Add new events to all loaded and buffer
						if (uniqueNewEvents.length > 0) {
							this.allLoadedEvenements = [...this.allLoadedEvenements, ...uniqueNewEvents];
							this.bufferedEvenements = [...this.bufferedEvenements, ...uniqueNewEvents];
							
						// Preload thumbnails for newly buffered events (immediately)
						// This ensures all cache cards have their thumbnails ready
						this.preloadThumbnailsForBufferedEvents();
						
						// Clean up unused thumbnails after loading new events
						this.cleanupUnusedThumbnails();
						} else if (newEvents.length > 0) {
							// All new events were duplicates, skipping...
						}

						const firstEvtCount = this.evenements.length > 0 && this.evenements[0] ? 1 : 0;
						this.filteredTotal = res?.page?.totalElements ?? (this.allLoadedEvenements.length + firstEvtCount);
						const totalPages = res?.page?.totalPages ?? null;
						
						// For loadNextPage, pageNumber should represent the last page we loaded
						// Since we're loading the next page after pageToLoad, update accordingly
						// But don't trust server response - use our internal tracking
						// pageToLoad is the page we just requested, so after loading it, we're on that page
						this.pageNumber = pageToLoad + 1; // Display as 1-based (page 1, 2, 3...)
						this._commonValuesService.setPageNumber(pageToLoad); // Store as 0-based internally

						if (newEvents.length === 0) {
							this.hasMoreEvents = false;
						} else if (totalPages !== null) {
							this.hasMoreEvents = this.pageNumber < totalPages;
						} else {
							this.hasMoreEvents = newEvents.length >= eventsToLoad;
						}

						if (!this.hasMoreEvents && this.bufferedEvenements.length === 0) {
							this.disconnectInfiniteScrollObserver();
						}
						
						// ALWAYS maintain MIN_BUFFER_SIZE (12) cards in cache with thumbnails
						// Trigger load when cache drops below trigger threshold (8)
						if (this.bufferedEvenements.length < this.CACHE_TRIGGER_THRESHOLD && 
						    this.hasMoreEvents && 
						    !this.isLoadingNextPage) {
							// Load immediately to maintain cache at maximum (up to 12)
							this.loadNextPage();
						}
						
						// Ensure observer is still active after loading new events (immediately)
						requestAnimationFrame(() => {
							this.setupInfiniteScrollObserver();
							// IntersectionObserver will handle triggering loading when needed
							// DO NOT call loadMoreFromBuffer here - let the observer handle it
							// This prevents multiple rapid calls
						});
					},
					error: (err: any) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						if (loadingTimeout) {
							clearTimeout(loadingTimeout);
							loadingTimeout = null;
						}
						console.error("Error when getting Events", err);
						this.isLoadingNextPage = false;
						this.isLoading = false; // Désactiver le spinner en cas d'erreur
						this.hasMoreEvents = false;
						// Always unblock scrolling on error
						this.unblockPageScroll();
					},
					complete: () => {
						// Handle completion - if no value was emitted, reset flags
						if (requestToken === this.feedRequestToken && this.isLoadingNextPage) {
							if (loadingTimeout) {
								clearTimeout(loadingTimeout);
								loadingTimeout = null;
							}
							console.warn('Subscription completed without emitting - resetting flags');
							this.isLoadingNextPage = false;
							this.isLoading = false;
							this.unblockPageScroll();
						}
					}
				});
			this.eventsSubscription = subscription;
			this.allSubscriptions.push(subscription);
		}).catch((err) => {
			console.error("Error while waiting for user value", err);
			this.isLoadingNextPage = false;
			this.isLoading = false; // Désactiver le spinner en cas d'erreur
			this.hasMoreEvents = false;
			// Always unblock scrolling on error
			this.unblockPageScroll();
		});
	}

	private setupInfiniteScrollObserver(): void {
		this.disconnectInfiniteScrollObserver();

		// Check immediately if anchor is available
		if (!this.infiniteScrollAnchor || !this.infiniteScrollAnchor.nativeElement) {
			// Retry after a short delay if anchor is not ready
			setTimeout(() => this.setupInfiniteScrollObserver(), 100);
			return;
		}

		const anchor = this.infiniteScrollAnchor.nativeElement;

		// Create IntersectionObserver with optimal settings for smooth scrolling
		this.intersectionObserver = new IntersectionObserver((entries) => {
			entries.forEach(entry => {
				if (entry.isIntersecting) {
					// Only load more if cards are ready (initial load complete)
					// This prevents loading at startup before initial cards are displayed
					if (this.cardsReady && !this.isLoadingMoreFromBuffer) {
						// Always try to load more from buffer when anchor is visible
						// This will display cached items even if a page load is in progress
						// The function itself will check if it should trigger a new page load
						this.loadMoreFromBuffer();
					}
				}
			});
		}, {
			root: null,
			rootMargin: '2000px 0px 0px 0px', // Trigger 2000px before anchor is visible for much earlier loading
			threshold: [0] // Single threshold for faster detection
		});

		try {
			this.intersectionObserver.observe(anchor);
		} catch (error) {
			console.error('Error setting up IntersectionObserver:', error);
		}
	}

	private checkScrollPosition(): void {
		// Simplified: just ensure observer is set up, it will handle loading automatically
		if (!this.intersectionObserver && this.infiniteScrollAnchor?.nativeElement) {
			this.setupInfiniteScrollObserver();
		}
		
		// Also check if we have cached items that should be displayed
		// This ensures cached items are shown even if observer hasn't triggered yet
		// Only if cards are ready (don't trigger during initial load)
		if (this.cardsReady && !this.isLoadingMoreFromBuffer && this.bufferedEvenements.length > 0 && this.hasMoreEvents) {
			// Check if we're near the bottom of the page
			const scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
			const windowHeight = window.innerHeight;
			const documentHeight = document.documentElement.scrollHeight;
			
			// If we're within 3000px of the bottom, load more from buffer
			if (documentHeight - (scrollPosition + windowHeight) < 3000) {
				this.loadMoreFromBuffer();
			}
		}
	}

	private loadMoreFromBuffer(): void {
		// Prevent multiple simultaneous calls - CHECK FLAG FIRST (before any other check)
		if (this.isLoadingMoreFromBuffer) {
			return;
		}
		
		// Don't load more if cards are not ready yet (initial load still in progress)
		if (!this.cardsReady) {
			return;
		}
		
		// Clear any pending debounce timer
		if (this.loadMoreFromBufferTimeoutId) {
			clearTimeout(this.loadMoreFromBufferTimeoutId);
			this.loadMoreFromBufferTimeoutId = null;
		}
		
		// Set flag IMMEDIATELY to prevent other calls from entering
		// This must be the FIRST thing we do after checks
		this.isLoadingMoreFromBuffer = true;
		
		// Disconnect observer temporarily to prevent it from triggering again during load
		this.disconnectInfiniteScrollObserver();
		
		// PRIORITY 1: Display cache cards immediately (don't wait for anything)
		// Move events from buffer to visible for smooth infinite scroll
		// This happens FIRST, even if cache filling is in progress
		if (this.bufferedEvenements.length > 0) {
			// Move events from buffer to visible (4 at a time for smooth loading)
			const eventsToMove = this.bufferedEvenements.splice(0, this.SCROLL_INCREMENT);
			
			// Get first event if exists (special event for return navigation)
			const firstEvent = this.evenements.length > 0 && this.evenements[0] ? 
				this.evenements[0] : null;
			const firstEventId = firstEvent ? (firstEvent.id || this.getEventKey(firstEvent)) : null;
			
			// Filter out first event and any duplicates from events to move
			let filteredEventsToMove = firstEventId ? 
				eventsToMove.filter(e => {
					const eId = e.id || this.getEventKey(e);
					return eId !== firstEventId;
				}) : 
				eventsToMove;
			
			// Also filter out events that are already in visible to avoid duplicates
			filteredEventsToMove = filteredEventsToMove.filter(e => {
				const eId = e.id || this.getEventKey(e);
				return !this.visibleEvenements.some(visible => {
					const visibleId = visible.id || this.getEventKey(visible);
					return visibleId === eId;
				});
			});
			
			// Mark events as loading before adding to visible with timestamps
			filteredEventsToMove.forEach(e => {
				const eId = e.id || this.getEventKey(e);
				if (eId) {
					this.loadingEvents.set(eId, {
						eventId: eId,
						cardLoadStart: Date.now()
					});
				}
			});
			
			// Load all thumbnails in parallel for better performance
			this.loadThumbnailsInParallel(filteredEventsToMove, true);
			
			// Add filtered events to visible
			this.visibleEvenements = [...this.visibleEvenements, ...filteredEventsToMove];
			
			// Combine visible with first event if exists (avoid duplication)
			if (firstEvent) {
				// Make sure firstEvent is not already in visibleEvenements
				const firstEvtInVisible = this.visibleEvenements.some(e => {
					const eId = e.id || this.getEventKey(e);
					return eId === firstEventId;
				});
				
				if (!firstEvtInVisible) {
					this.evenements = [firstEvent, ...this.visibleEvenements];
				} else {
					// First event already in visible, don't duplicate
					this.evenements = this.visibleEvenements;
				}
			} else {
				this.evenements = this.visibleEvenements;
			}
			
			// DISPLAY IMMEDIATELY the cards (synchronous change detection)
			// Priority: display happens first, no waiting
			this.cdr.detectChanges();
			
			// Mark card load end after cards are rendered (with a small delay for animation)
			setTimeout(() => {
				filteredEventsToMove.forEach(e => {
					const eId = e.id || this.getEventKey(e);
					if (eId) {
						const loadingInfo = this.loadingEvents.get(eId);
						if (loadingInfo) {
							loadingInfo.cardLoadEnd = Date.now();
							// Keep in map until thumbnail is also loaded
							if (loadingInfo.thumbnailLoadEnd || !loadingInfo.thumbnailLoadStart) {
								// Thumbnail already loaded or not needed, remove from loading
								this.loadingEvents.delete(eId);
							}
							this.cdr.markForCheck();
						}
					}
				});
				
				// Reset flag after cards are fully rendered
				// This prevents multiple rapid calls
				this.isLoadingMoreFromBuffer = false;
				
				// Re-setup observer after flag is reset to prevent immediate re-triggering
				// Use a longer delay to ensure DOM is fully updated and prevent rapid re-triggering
				setTimeout(() => {
					this.setupInfiniteScrollObserver();
				}, 500); // Additional delay after flag reset to prevent rapid re-triggering
			}, 1500); // 1500ms delay to show loading indicator and prevent rapid calls
		} else {
			// Buffer is empty - reset flag after a delay and re-setup observer to detect when to load
			setTimeout(() => {
				this.isLoadingMoreFromBuffer = false;
				setTimeout(() => {
					this.setupInfiniteScrollObserver();
				}, 500);
			}, 1500); // Delay to prevent rapid re-triggering
		}
		
		// Clean up unused thumbnails after moving events
		this.cleanupUnusedThumbnails();
		
		// PRIORITY 2: Fill cache in parallel (non-blocking, happens after display)
		// Calculate buffer state after the move
		const bufferAfterMove = this.bufferedEvenements.length;
		
		// Fill cache in parallel - don't block display, just start loading
		// It's OK if display is faster than cache filling - they work independently
		// Cache will be filled in background while user continues scrolling
		// Trigger load when cache drops below trigger threshold (8)
		if (bufferAfterMove < this.CACHE_TRIGGER_THRESHOLD && this.hasMoreEvents) {
			// If buffer is completely empty and we're not loading, force a load
			// This handles the case where isLoadingNextPage might be stuck
			if (bufferAfterMove === 0 && !this.isLoadingNextPage) {
				this.isLoadingNextPage = true;
				this.loadNextPage();
			} else if (bufferAfterMove > 0 && !this.isLoadingNextPage) {
				// Buffer has some items but not enough - load more to fill it
				this.isLoadingNextPage = true;
				this.loadNextPage();
			} else if (bufferAfterMove === 0 && this.isLoadingNextPage) {
				// Buffer is empty but isLoadingNextPage is true - might be stuck
				// Check if we have an active subscription - if not, reset and load
				if (!this.eventsSubscription || this.eventsSubscription.closed) {
					console.warn('isLoadingNextPage is true but no active subscription - resetting and loading');
					this.isLoadingNextPage = false;
					this.isLoading = false;
					this.isLoadingNextPage = true;
					this.loadNextPage();
				}
			}
		}
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

		// Prefetch if buffer is getting low
		if (this.bufferedEvenements.length < this.INITIAL_VISIBLE_COUNT) {
			if (this.prefetchTimeoutId) {
				return;
			}

			this.prefetchTimeoutId = setTimeout(() => {
				this.prefetchTimeoutId = null;
				this.loadNextPage();
			}, 0);
		}
	}

	private tryLoadNextIfAnchorVisible(): void {
		// Don't load if cards are not ready yet (initial load still in progress)
		if (!this.cardsReady) {
			return;
		}
		
		if (!this.infiniteScrollAnchor?.nativeElement) {
			return;
		}

		requestAnimationFrame(() => {
			if (!this.infiniteScrollAnchor?.nativeElement) {
				return;
			}
			if (this.infiniteScrollAnchor.nativeElement.getBoundingClientRect().top <= (this.nativeWindow?.innerHeight ?? document.documentElement.clientHeight ?? 0)) {
				if (!this.isLoadingMoreFromBuffer) {
					this.loadMoreFromBuffer();
				}
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
		// Ne plus stocker les couleurs des cartes - on n'utilise plus la moyenne
		// this.eventColors.set(update.eventId, update.color);
		
		// Ne plus mettre à jour la couleur moyenne - utiliser toujours les couleurs par défaut
		// Plus besoin de débouncer car on ne calcule plus la moyenne
	}

	private resetColorAggregation(): void {
		this.eventColors.clear();
		this.lastAverageRgb = null;
		// Annuler le timeout en cours s'il existe
		if (this.updateAverageColorTimeoutId) {
			clearTimeout(this.updateAverageColorTimeoutId);
			this.updateAverageColorTimeoutId = null;
		}
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
		// Ne plus calculer la moyenne des couleurs des cartes - utiliser toujours les couleurs par défaut
		// Ne mettre à jour que si nécessaire
		if (this.lastAverageRgb !== null) {
			this.lastAverageRgb = null;
		}
		
		const newGradient = this.buildGradientFromColor(this.defaultAverageColor);
		this.averageColor = this.defaultAverageColor;
		this.averageTextColor = this.defaultAverageTextColor;
		this.averageBorderColor = this.defaultAverageBorderColor;
		this.averageGradient = newGradient;
		
		// Utiliser markForCheck au lieu de detectChanges pour éviter l'erreur
		this.cdr.markForCheck();
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
		evenement.members.push(this.user);
		this._evenementsService.putEvenement(evenement).subscribe(
			() => {},
			(err: any) => alert("Error when deleting participant " + err));
	}

	public delMemberInEvent(evenement: Evenement) {
		evenement.members = evenement.members.filter(memb => !(memb.id == this.user.id));
		this._evenementsService.putEvenement(evenement).subscribe(
			() => {},
			(err: any) => alert("Error when deleting participant " + err));
	}

	public async delEvent(evenement: Evenement) {
		// Delete Firebase chat messages first
		try {
			const messagesRef = ref(this.database, evenement.id);
			await remove(messagesRef);
		} catch (error) {
			console.error("Error deleting Firebase chat messages:", error);
		}
		
		// Then delete the event from backend
		this._evenementsService.delEvenement(evenement.id)
			.subscribe(
				(res: any) => {  //  update evenements for screen update			
					this.resetAndLoadEvents();
				},
				(err: any) => {
					console.error("Del evenement error : " + err);
					alert("Issue when deleting the event : " + err);
				}
			);
	}

	public updEvent(evenement: Evenement) {
		this._evenementsService.putEvenement(evenement)
			.subscribe(
				() => {},
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
			const thumbnailSubscription = this._fileService.getFile(file.fieldId).pipe(
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
			this.allSubscriptions.push(thumbnailSubscription);
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
		// Modal photos is kept for compatibility but photosUrl field has been removed
		// The modal will show "No photos available" message
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
		this.selectedEvent = evenement;
		this.selectedEventName = evenement.evenementName;
		
		this.modalService.open(this.urlsModal, { 
			size: 'lg',
			backdrop: 'static',
			keyboard: false,
			animation: true,
			centered: true
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
			.subscribe(
				() => {},
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
		// No need to clear cache - blob URLs are now persisted in static cache
		// The cache will be used automatically when components are recreated
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
			// Check if already cached in element-evenement shared cache first
			if (ElementEvenementComponent.isThumbnailCached(thumbnailFile.fieldId)) {
				const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(thumbnailFile.fieldId);
				if (cachedThumbnail) {
					// Reuse cached thumbnail from element-evenement component
					this.eventThumbnails.set(evenement.id, cachedThumbnail);
					return cachedThumbnail;
				}
			}
			
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

	// Start loading thumbnail for an event (called in parallel for multiple events)
	private startThumbnailLoad(evenement: Evenement, eventId: string): void {
		// Find a file with "thumbnail" in the name
		const thumbnailFile = evenement.fileUploadeds?.find(file => 
			file.fileName && file.fileName.toLowerCase().includes('thumbnail')
		);
		
		if (thumbnailFile) {
			// Mark thumbnail load start
			const loadingInfo = this.loadingEvents.get(eventId);
			if (loadingInfo) {
				loadingInfo.thumbnailLoadStart = Date.now();
			}
			
			// Load thumbnail
			this.loadThumbnailFromFile(eventId, thumbnailFile.fieldId, true);
		} else {
			// No thumbnail, mark as complete immediately
			const loadingInfo = this.loadingEvents.get(eventId);
			if (loadingInfo) {
				loadingInfo.thumbnailLoadStart = Date.now();
				loadingInfo.thumbnailLoadEnd = Date.now();
				// If card is also loaded, remove from loading
				if (loadingInfo.cardLoadEnd) {
					this.loadingEvents.delete(eventId);
				}
			}
		}
	}
	
	// Load multiple thumbnails in parallel (optimized for performance)
	private loadThumbnailsInParallel(events: Evenement[], trackLoading: boolean = false): void {
		const thumbnailLoadRequests: Observable<{eventId: string, safeUrl: SafeUrl}>[] = [];
		const eventsWithoutThumbnails: {event: Evenement, eventId: string}[] = [];
		
		events.forEach(evenement => {
			const eventId = evenement.id || this.getEventKey(evenement);
			if (!eventId) return;
			
			// Mark thumbnail load start if tracking
			if (trackLoading) {
				const loadingInfo = this.loadingEvents.get(eventId);
				if (loadingInfo) {
					loadingInfo.thumbnailLoadStart = Date.now();
				}
			}
			
			// Check if already cached
			if (this.eventThumbnails.has(eventId)) {
				const cached = this.eventThumbnails.get(eventId);
				if (cached && typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
					const url = cached['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						// Already loaded, mark as complete
						if (trackLoading) {
							const loadingInfo = this.loadingEvents.get(eventId);
							if (loadingInfo) {
								loadingInfo.thumbnailLoadEnd = Date.now();
								if (loadingInfo.cardLoadEnd) {
									this.loadingEvents.delete(eventId);
								}
								this.cdr.markForCheck();
							}
						}
						return;
					}
				}
			}
			
			// Find a file with "thumbnail" in the name
			const thumbnailFile = evenement.fileUploadeds?.find(file => 
				file.fileName && file.fileName.toLowerCase().includes('thumbnail')
			);
			
			if (thumbnailFile) {
				// Check if already cached in element-evenement shared cache
				if (ElementEvenementComponent.isThumbnailCached(thumbnailFile.fieldId)) {
					const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(thumbnailFile.fieldId);
					if (cachedThumbnail) {
						// Use cached thumbnail immediately
						this.eventThumbnails.set(eventId, cachedThumbnail);
						if (trackLoading) {
							const loadingInfo = this.loadingEvents.get(eventId);
							if (loadingInfo) {
								loadingInfo.thumbnailLoadEnd = Date.now();
								if (loadingInfo.cardLoadEnd) {
									this.loadingEvents.delete(eventId);
								}
								this.cdr.markForCheck();
							}
						}
						return;
					}
				}
				
				// Create load request
				const loadRequest = this._fileService.getFile(thumbnailFile.fieldId).pipe(
					map((res: any) => {
						const blob = new Blob([res], { type: 'application/octet-stream' });
						const objectUrl = this.nativeWindow.URL.createObjectURL(blob);
						const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
						
						// Cache in both places
						this.eventThumbnails.set(eventId, safeUrl);
						ElementEvenementComponent.setCachedThumbnail(thumbnailFile.fieldId, safeUrl);
						
						return { eventId, safeUrl };
					}),
					catchError((error: any) => {
						console.error('Error loading thumbnail for event:', eventId, error);
						// Use default image on error
						const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
						this.eventThumbnails.set(eventId, defaultUrl);
						return of({ eventId, safeUrl: defaultUrl });
					})
				);
				
				thumbnailLoadRequests.push(loadRequest);
			} else {
				// No thumbnail, use default image immediately
				eventsWithoutThumbnails.push({ event: evenement, eventId });
			}
		});
		
		// Set default images immediately for events without thumbnails
		eventsWithoutThumbnails.forEach(({ eventId }) => {
			const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
			this.eventThumbnails.set(eventId, defaultUrl);
			if (trackLoading) {
				const loadingInfo = this.loadingEvents.get(eventId);
				if (loadingInfo) {
					loadingInfo.thumbnailLoadStart = Date.now();
					loadingInfo.thumbnailLoadEnd = Date.now();
					if (loadingInfo.cardLoadEnd) {
						this.loadingEvents.delete(eventId);
					}
					this.cdr.markForCheck();
				}
			}
		});
		
		// Load all thumbnails in parallel using forkJoin
		if (thumbnailLoadRequests.length > 0) {
			const parallelLoadSubscription = forkJoin(thumbnailLoadRequests).subscribe({
				next: (results) => {
					// All thumbnails loaded successfully
					if (trackLoading) {
						results.forEach(({ eventId }) => {
							const loadingInfo = this.loadingEvents.get(eventId);
							if (loadingInfo) {
								loadingInfo.thumbnailLoadEnd = Date.now();
								if (loadingInfo.cardLoadEnd) {
									this.loadingEvents.delete(eventId);
								}
							}
						});
						this.cdr.markForCheck();
					}
				},
				error: (error) => {
					console.error('Error loading thumbnails in parallel:', error);
				}
			});
			this.allSubscriptions.push(parallelLoadSubscription);
		}
	}

	private loadThumbnailFromFile(eventId: string, fileId: string, trackLoading: boolean = false): void {
		// Check if already cached in home-evenements cache
		if (this.eventThumbnails.has(eventId)) {
			const cached = this.eventThumbnails.get(eventId);
			if (cached && typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
				const url = cached['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					// Already loaded, mark as complete
					if (trackLoading) {
						const loadingInfo = this.loadingEvents.get(eventId);
						if (loadingInfo) {
							loadingInfo.thumbnailLoadEnd = Date.now();
							// If card is also loaded, remove from loading
							if (loadingInfo.cardLoadEnd) {
								this.loadingEvents.delete(eventId);
							}
							this.cdr.markForCheck();
						}
					}
					return; // Already loaded
				}
			}
		}
		
		// Check if already cached in element-evenement shared cache (to avoid duplicate backend request)
		if (ElementEvenementComponent.isThumbnailCached(fileId)) {
			const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(fileId);
			if (cachedThumbnail) {
				// Reuse cached thumbnail from element-evenement component
				this.eventThumbnails.set(eventId, cachedThumbnail);
				// Mark as complete
				if (trackLoading) {
					const loadingInfo = this.loadingEvents.get(eventId);
					if (loadingInfo) {
						loadingInfo.thumbnailLoadEnd = Date.now();
						// If card is also loaded, remove from loading
						if (loadingInfo.cardLoadEnd) {
							this.loadingEvents.delete(eventId);
						}
						this.cdr.markForCheck();
					}
				}
				return;
			}
		}
		
		const thumbnailSubscription = this._fileService.getFile(fileId).pipe(
			map((res: any) => {
				let blob = new Blob([res], { type: 'application/octet-stream' });
				return blob;
			})
		).subscribe({
			next: (blob: any) => {
				let objectUrl = this.nativeWindow.URL.createObjectURL(blob);
				let safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
				
				// Mettre à jour l'URL dans le cache des événements
				this.eventThumbnails.set(eventId, safeUrl);
				
				// Also cache in element-evenement shared cache to prevent duplicate requests
				ElementEvenementComponent.setCachedThumbnail(fileId, safeUrl);
				
				// Mark thumbnail load end
				if (trackLoading) {
					const loadingInfo = this.loadingEvents.get(eventId);
					if (loadingInfo) {
						loadingInfo.thumbnailLoadEnd = Date.now();
						// If card is also loaded, remove from loading
						if (loadingInfo.cardLoadEnd) {
							this.loadingEvents.delete(eventId);
						}
						this.cdr.markForCheck();
					}
				}
				
				// Ne pas révoquer l'URL blob immédiatement - la garder en mémoire
				// L'URL sera automatiquement révoquée quand le composant sera détruit
			},
			error: (error: any) => {
				console.error('Error loading thumbnail for event:', eventId, error);
				// En cas d'erreur, utiliser l'image par défaut
				this.eventThumbnails.set(eventId, this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg"));
				// Mark thumbnail load end even on error
				if (trackLoading) {
					const loadingInfo = this.loadingEvents.get(eventId);
					if (loadingInfo) {
						loadingInfo.thumbnailLoadEnd = Date.now();
						// If card is also loaded, remove from loading
						if (loadingInfo.cardLoadEnd) {
							this.loadingEvents.delete(eventId);
						}
						this.cdr.markForCheck();
					}
				}
			}
		});
		this.allSubscriptions.push(thumbnailSubscription);
	}

	private preloadThumbnailsForBufferedEvents(): void {
		// Preload thumbnails for buffered events in parallel (all at once for maximum speed)
		// This ensures all 12 buffer cards have thumbnails ready
		const eventsToLoad = this.bufferedEvenements.filter(evenement => {
			if (!evenement || !evenement.id) return false;
			
			// Skip if already cached
			if (this.eventThumbnails.has(evenement.id)) {
				const cached = this.eventThumbnails.get(evenement.id);
				if (cached && typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
					const url = cached['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						return false; // Already loaded
					}
				}
			}
			return true;
		});
		
		if (eventsToLoad.length === 0) {
			// All thumbnails already loaded, check if buffer needs replenishing
			// Trigger load when cache drops below trigger threshold (8)
			if (this.bufferedEvenements.length < this.CACHE_TRIGGER_THRESHOLD && 
			    this.hasMoreEvents && 
			    !this.isLoadingNextPage) {
				this.loadNextPage();
			}
			return;
		}
		
		// Prepare thumbnail load requests (all in parallel)
		const thumbnailLoadRequests: Observable<{eventId: string, safeUrl: SafeUrl}>[] = [];
		
		eventsToLoad.forEach(evenement => {
			const eventId = evenement.id || this.getEventKey(evenement);
			if (!eventId) return;
			
			// Find a file with "thumbnail" in the name
			const thumbnailFile = evenement.fileUploadeds?.find(file => 
				file.fileName && file.fileName.toLowerCase().includes('thumbnail')
			);
			
			if (thumbnailFile) {
				// Check if already cached in element-evenement shared cache
				if (ElementEvenementComponent.isThumbnailCached(thumbnailFile.fieldId)) {
					const cachedThumbnail = ElementEvenementComponent.getCachedThumbnail(thumbnailFile.fieldId);
					if (cachedThumbnail) {
						// Use cached thumbnail immediately
						this.eventThumbnails.set(eventId, cachedThumbnail);
						return;
					}
				}
				
				// Create load request
				const loadRequest = this._fileService.getFile(thumbnailFile.fieldId).pipe(
					map((res: any) => {
						const blob = new Blob([res], { type: 'application/octet-stream' });
						const objectUrl = this.nativeWindow.URL.createObjectURL(blob);
						const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
						
						// Cache in both places
						this.eventThumbnails.set(eventId, safeUrl);
						ElementEvenementComponent.setCachedThumbnail(thumbnailFile.fieldId, safeUrl);
						
						return { eventId, safeUrl };
					}),
					catchError((error: any) => {
						console.error('Error loading thumbnail for event:', eventId, error);
						// Use default image on error
						const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
						this.eventThumbnails.set(eventId, defaultUrl);
						return of({ eventId, safeUrl: defaultUrl });
					})
				);
				
				thumbnailLoadRequests.push(loadRequest);
			} else {
				// No thumbnail, use default image immediately
				const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
				this.eventThumbnails.set(eventId, defaultUrl);
			}
		});
		
		// Load all thumbnails in parallel using forkJoin
		if (thumbnailLoadRequests.length > 0) {
			const parallelLoadSubscription = forkJoin(thumbnailLoadRequests).subscribe({
				next: (results) => {
					// All thumbnails loaded successfully
					// Force change detection to update debug panel
					this.cdr.markForCheck();
				},
				error: (error) => {
					console.error('Error loading thumbnails in parallel:', error);
				}
			});
			this.allSubscriptions.push(parallelLoadSubscription);
		}
		
		// After preloading thumbnails, check if buffer needs to be replenished
		// Ensure we always maintain MIN_BUFFER_SIZE cards with thumbnails loaded
		// Trigger load when cache drops below trigger threshold (8)
		if (this.bufferedEvenements.length < this.CACHE_TRIGGER_THRESHOLD && 
		    this.hasMoreEvents && 
		    !this.isLoadingNextPage) {
			// Load immediately to maintain cache at maximum
			this.loadNextPage();
		}
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
		// Store the event ID and page info before navigating
		this.storeEventIdForReturn(evenement.id);
		// Navigation vers la page de détails de l'événement
		this._router.navigate(['/details-evenement', evenement.id]);
	}
	
	// Store event ID and page number when navigating away from a card
	public storeEventIdForReturn(eventId: string): void {
		if (eventId) {
			// Find the index of the event in the current array
			const eventIndex = this.evenements.findIndex(e => 
				e.id === eventId || this.getEventKey(e) === eventId
			);
			
			if (eventIndex >= 0) {
				// Calculate which page this event is on (0-based)
				const pageNumber = Math.floor(eventIndex / this.elementsByPage);
				const storageData = {
					eventId: eventId,
					pageNumber: pageNumber,
					eventIndex: eventIndex,
					filter: this.dataFIlter || ''
				};
				sessionStorage.setItem('lastViewedEventData', JSON.stringify(storageData));
			} else {
				// If not found in current array, just store the ID
				sessionStorage.setItem('lastViewedEventId', eventId);
			}
		}
	}
	
	// Check for stored event ID (called after cards are loaded)
	private checkAndScrollToStoredCard(): void {
		// Method kept for compatibility but does nothing
	}
	
	// Load specific event and place it at the first position
	private loadAndDisplayEventFirst(eventId: string): void {
		// Clear stored data immediately
		sessionStorage.removeItem('lastViewedEventData');
		sessionStorage.removeItem('lastViewedEventId');
		
		// Fetch the specific event from backend
		this._evenementsService.getEvenement(eventId).subscribe({
			next: (evenement: Evenement) => {
				// Add event at first position (array might be empty at this point)
				if (this.evenements.length === 0) {
					this.evenements = [evenement];
				} else {
					// Check if event already exists in the array
					const existingIndex = this.evenements.findIndex(e => 
						e.id === evenement.id || this.getEventKey(e) === eventId
					);
					
					if (existingIndex >= 0) {
						// Event already in array, move it to first position
						const event = this.evenements[existingIndex];
						this.evenements.splice(existingIndex, 1);
						this.evenements.unshift(event);
					} else {
						// Event not in array, add it at first position
						this.evenements.unshift(evenement);
					}
				}
				
				// Force change detection
				this.cdr.detectChanges();
			},
			error: (error: any) => {
				console.error('Error loading event for first position:', error);
			}
		});
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
		// Unblock scrolling if it was blocked
		if (this.shouldBlockScroll) {
			this.unblockPageScroll();
			this.shouldBlockScroll = false;
		}
		
		// Clear debug info update interval
		if (this.debugInfoUpdateInterval) {
			clearInterval(this.debugInfoUpdateInterval);
			this.debugInfoUpdateInterval = undefined;
		}
		
		this.eventsSubscription?.unsubscribe();
		this.searchSubscriptions.forEach(sub => sub.unsubscribe());
		this.searchSubscriptions = [];
		this.disconnectInfiniteScrollObserver();
		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}
		if (this.scrollCheckTimeoutId) {
			clearTimeout(this.scrollCheckTimeoutId);
			this.scrollCheckTimeoutId = null;
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
	
	// Block page scrolling
	private blockPageScroll(): void {
		if (document.body) {
			document.body.style.overflow = 'hidden';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = 'hidden';
		}
	}
	
	// Unblock page scrolling
	private unblockPageScroll(): void {
		if (document.body) {
			document.body.style.overflow = '';
		}
		if (document.documentElement) {
			document.documentElement.style.overflow = '';
		}
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

	private currentEventForPhotosSelector: Evenement | null = null;
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
		const listImagesSubscription = this._fileService.listImagesFromDisk(relativePath).subscribe({
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
		this.allSubscriptions.push(listImagesSubscription);
		this.allSubscriptions.push(listImagesSubscription);
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
		this.getFileBlobUrl(fileId).subscribe((blob: any) => {
			const pdfBlob = new Blob([blob], { type: 'application/pdf' });
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
	
	// Get loading events text with fallback
	public getLoadingEventsText(): string {
		const translated = this.translateService.instant('EVENTHOME.LOADING_EVENTS');
		return translated !== 'EVENTHOME.LOADING_EVENTS' ? translated : 'Chargement des événements...';
	}
	
	// Get loading more text with fallback
	public getLoadingMoreText(): string {
		const translated = this.translateService.instant('EVENTHOME.LOADING_MORE');
		return translated !== 'EVENTHOME.LOADING_MORE' ? translated : 'Chargement...';
	}
	
	// Get visible events count (ce qui est réellement affiché dans le template)
	public getVisibleEventsCount(): number {
		return this.evenements.length; // Retourne ce qui est réellement affiché
	}
	
	// Get visible events count (without first special event)
	public getVisibleEventsCountWithoutFirst(): number {
		return this.visibleEvenements.length;
	}
	
	// Get buffered events count
	public getBufferedEventsCount(): number {
		return this.bufferedEvenements.length;
	}
	
	// Get all loaded events count
	public getAllLoadedEventsCount(): number {
		return this.allLoadedEvenements.length;
	}
	
	// Get scroll increment value
	public getScrollIncrement(): number {
		return this.SCROLL_INCREMENT;
	}
	
	// Get buffer size
	public getBufferSize(): number {
		return this.BUFFER_SIZE;
	}
	
	// Check if an event is currently loading
	public isEventLoading(evenement: Evenement): boolean {
		const eventId = evenement.id || this.getEventKey(evenement);
		return eventId ? this.loadingEvents.has(eventId) : false;
	}
	
	// Get loading events count
	public getLoadingEventsCount(): number {
		return this.loadingEvents.size;
	}
	
	// Get loading events info (for debug panel)
	public getLoadingEventsInfo(): LoadingEventInfo[] {
		return Array.from(this.loadingEvents.values());
	}
	
	// Get first loading event ID (for debug panel)
	public getFirstLoadingEventId(): string {
		const first = this.loadingEvents.values().next().value;
		return first ? first.eventId : '';
	}
	
	// Get card load time for first loading event - returns cached value to prevent change detection errors
	public getCardLoadTime(): number {
		return this.cachedCardLoadTime;
	}
	
	// Get thumbnail load time for first loading event - returns cached value to prevent change detection errors
	public getThumbnailLoadTime(): number {
		return this.cachedThumbnailLoadTime;
	}
	
	// Get memory usage (in MB) - returns cached value to prevent change detection errors
	public getMemoryUsage(): string {
		return this.cachedMemoryUsage;
	}
	
	// Get memory usage percentage (0-100) - returns cached value to prevent change detection errors
	public getMemoryUsagePercent(): number {
		return this.cachedMemoryUsagePercent;
	}
	
	// Get cached thumbnails count (only for cards currently in buffer cache, not visible ones)
	public getCachedThumbnailsCount(): number {
		// Count thumbnails only for events in the buffer (cache), not visible ones
		let count = 0;
		
		this.bufferedEvenements.forEach(e => {
			const eId = e.id || this.getEventKey(e);
			if (eId) {
				// Check if thumbnail exists in local cache for this buffered event
				if (this.eventThumbnails.has(eId)) {
					const cached = this.eventThumbnails.get(eId);
					if (cached && typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
						const url = cached['changingThisBreaksApplicationSecurity'];
						if (url && typeof url === 'string' && (url.startsWith('blob:') || url.includes('images.jpg'))) {
							count++;
						}
					}
				}
			}
		});
		
		return count;
	}
	
	// Clean up thumbnails that are no longer needed (not in visible or buffer)
	private cleanupUnusedThumbnails(): void {
		// Get all event IDs that should keep thumbnails
		const keepEventIds = new Set<string>();
		
		// Add visible events (need thumbnails for display)
		this.visibleEvenements.forEach(e => {
			const eId = e.id || this.getEventKey(e);
			if (eId) keepEventIds.add(eId);
		});
		
		// Add buffered events (need thumbnails for cache)
		this.bufferedEvenements.forEach(e => {
			const eId = e.id || this.getEventKey(e);
			if (eId) keepEventIds.add(eId);
		});
		
		// Add displayed events (may include first special event)
		this.evenements.forEach(e => {
			const eId = e.id || this.getEventKey(e);
			if (eId) keepEventIds.add(eId);
		});
		
		// Remove thumbnails that are not in the keep list
		const thumbnailsToRemove: string[] = [];
		this.eventThumbnails.forEach((url, eventId) => {
			if (!keepEventIds.has(eventId)) {
				thumbnailsToRemove.push(eventId);
			}
		});
		
		// Remove unused thumbnails and revoke blob URLs
		thumbnailsToRemove.forEach(eventId => {
			const cached = this.eventThumbnails.get(eventId);
			if (cached && typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
				const url = cached['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					try {
						this.nativeWindow.URL.revokeObjectURL(url);
					} catch (e) {
						// Ignore errors
					}
				}
			}
			this.eventThumbnails.delete(eventId);
		});
		
		// Force change detection to update debug panel
		if (thumbnailsToRemove.length > 0) {
			this.cdr.markForCheck();
		}
	}
	
	// Download all files from the event as a single ZIP file
	public async downloadAllFilesForEvent(evenement: Evenement): Promise<void> {
		if (!evenement.fileUploadeds || evenement.fileUploadeds.length === 0) {
			alert('Aucun fichier à télécharger');
			return;
		}

		try {
			// Create a new ZIP file
			const zip = new JSZip();
			let successCount = 0;
			
			// Download all files and add them to the ZIP
			const downloadPromises = evenement.fileUploadeds.map(async (file) => {
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
			
			const zipBlob = await zip.generateAsync({ type: 'blob' });
			
			const zipFileName = `${evenement.evenementName}_files_${new Date().getTime()}.zip`;
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
	
	public onFileSelected(event: any, evenement: Evenement): void {
		const files: FileList = event.target.files;
		if (files && files.length > 0) {
			this.selectedFiles = Array.from(files);
			this.uploadFiles(evenement);
		}
	}

	private uploadFiles(evenement: Evenement): void {
		if (this.selectedFiles.length === 0) {
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
						this.handleUploadResponse(response, evenement);
						
						// Clear selected files
						this.selectedFiles = [];
						// Reset file input for this specific event
						const fileInput = document.querySelector(`input[id="file-upload-input-${evenement.id}"]`) as HTMLInputElement;
						if (fileInput) {
							fileInput.value = '';
						}
						
						// Use requestAnimationFrame to avoid blocking the main thread
						// Split the work: first update UI state, then reload events
						requestAnimationFrame(() => {
							this.isUploading = false;
							// Don't close modal automatically, let user close it manually
							// Refresh the events list after a short delay to allow UI to update
							const refreshTimeout = setTimeout(() => {
								this.resetAndLoadEvents();
							}, 100);
							this.activeTimeouts.add(refreshTimeout);
							setTimeout(() => this.activeTimeouts.delete(refreshTimeout), 200);
						});
					}, 500);
					this.activeTimeouts.add(cleanupTimeout);
					setTimeout(() => this.activeTimeouts.delete(cleanupTimeout), 600);
				},
				error: (error: any) => {
					if (this.pollIntervalId) {
						clearInterval(this.pollIntervalId);
						this.pollIntervalId = null;
					}
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
		
		// Auto-scroll to top to show latest log - use requestAnimationFrame for better performance
		requestAnimationFrame(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		});
	}

	private addSuccessLog(message: string): void {
		this.uploadLogs.unshift(`SUCCESS: [${new Date().toLocaleTimeString()}] ${message}`);
		
		// Auto-scroll to top to show latest log - use requestAnimationFrame for better performance
		requestAnimationFrame(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		});
	}

	private addErrorLog(message: string): void {
		this.uploadLogs.unshift(`ERROR: [${new Date().toLocaleTimeString()}] ${message}`);
		
		// Auto-scroll to top to show latest log - use requestAnimationFrame for better performance
		requestAnimationFrame(() => {
			if (this.logContent && this.logContent.nativeElement) {
				const container = this.logContent.nativeElement;
				container.scrollTop = 0;
			}
		});
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
		return 'file_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
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
