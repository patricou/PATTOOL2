import { Component, OnInit, HostListener, ElementRef, AfterViewInit, ViewChild, ViewChildren, QueryList, OnDestroy, TemplateRef, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource } from '../../shared/slideshow-modal/slideshow-modal.component';
import { PhotosSelectorModalComponent, PhotosSelectionResult } from '../../shared/photos-selector-modal/photos-selector-modal.component';
import { Observable, Subscription, fromEvent, firstValueFrom, forkJoin, of, Subject } from 'rxjs';
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
import { EvenementsService, StreamedEvent } from '../../services/evenements.service';
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
	changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomeEvenementsComponent implements OnInit, AfterViewInit, OnDestroy {

	public evenements: Evenement[] = []; // Events currently displayed (max 8 at a time, then +8 on scroll)
	private allStreamedEvents: Evenement[] = []; // Buffer for all streamed events
	public cardsReady: boolean = false;
	public isLoading: boolean = false; // État de chargement
	public user: Member = new Member("", "", "", "", "", [], "");
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
	private readonly CARDS_PER_PAGE = 8; // Number of cards to display at once
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
	private thumbnailLoadQueue: Subject<Evenement> = new Subject<Evenement>(); // Queue for batching thumbnail loads
	private thumbnailLoadQueueSubscription?: Subscription;
	private thumbnailObserver?: IntersectionObserver; // Observer for lazy loading visible thumbnails
	private readonly THUMBNAIL_BATCH_SIZE = 5; // Load thumbnails in smaller batches of 5 to reduce handler time
	private readonly THUMBNAIL_BATCH_DELAY = 200; // Increased delay in ms to batch thumbnail loads
	private readonly THUMBNAIL_PREFETCH_DISTANCE = 200; // Prefetch thumbnails 200px before viewport
	private readonly THUMBNAIL_BATCH_INTERVAL = 100; // Delay between batches in ms
	private pendingThumbnailLoads: Set<string> = new Set(); // Track thumbnails currently being loaded
	private pendingCardLoadEnds: Set<string> = new Set(); // Track cards waiting for loadEnd mark
	private cardLoadEndBatchTimeout: ReturnType<typeof setTimeout> | null = null;
	private changeDetectionScheduled: boolean = false; // Flag to prevent multiple change detection calls
	private pendingChangeDetection: boolean = false; // Flag to track if change detection is needed

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
		// Use markForCheck with OnPush for better performance
		this.debugInfoUpdateInterval = setInterval(() => {
			if (!this.debugInfoCollapsed) {
				// Update cached memory usage asynchronously to prevent change detection errors
				this.updateCachedMemoryUsage();
				// Clean up unused thumbnails periodically
				this.cleanupUnusedThumbnails();
				// Schedule change detection for real-time updates
				this.scheduleChangeDetection();
			}
		}, 100);
	}
	
	// Update cached memory usage values asynchronously
	// Optimized change detection scheduling - batches multiple calls
	private scheduleChangeDetection(): void {
		if (this.changeDetectionScheduled) {
			this.pendingChangeDetection = true;
			return;
		}
		
		this.changeDetectionScheduled = true;
		this.pendingChangeDetection = false;
		
		requestAnimationFrame(() => {
			this.cdr.markForCheck();
			this.changeDetectionScheduled = false;
			
			// If there was a pending change detection, schedule another one
			if (this.pendingChangeDetection) {
				this.scheduleChangeDetection();
			}
		});
	}

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
			// Only calculate time if cardLoadEnd is defined (loading is complete)
			// Otherwise, don't update to prevent continuously increasing time
			if (first.cardLoadEnd) {
				this.cachedCardLoadTime = first.cardLoadEnd - first.cardLoadStart;
			} else {
				// Card is still loading - calculate current elapsed time but only if we want to show it
				// For now, keep the last known value or 0 to prevent continuous increase
				if (this.cachedCardLoadTime === 0) {
					// Only update once when loading starts, then wait for cardLoadEnd
					this.cachedCardLoadTime = Date.now() - first.cardLoadStart;
				}
				// Don't update again until cardLoadEnd is set
			}
		} else {
			this.cachedCardLoadTime = 0;
		}
		
		// Update thumbnail load time
		if (first && first.thumbnailLoadStart) {
			// Only calculate time if thumbnailLoadEnd is defined (loading is complete)
			if (first.thumbnailLoadEnd) {
				this.cachedThumbnailLoadTime = first.thumbnailLoadEnd - first.thumbnailLoadStart;
			} else {
				// Thumbnail is still loading - keep last known value or 0
				if (this.cachedThumbnailLoadTime === 0) {
					// Only update once when loading starts
					this.cachedThumbnailLoadTime = Date.now() - first.thumbnailLoadStart;
				}
			}
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
		this.initializeThumbnailBatchLoader();
		this.setupThumbnailLazyLoading();
		
		// Écouter les changements des cards pour déclencher l'animation
				this.patCards.changes.subscribe(() => {
					if (this.patCards.length > 0 && !this.cardsReady) {
						// Use requestAnimationFrame for better performance, then do DOM operations
						requestAnimationFrame(() => {
							this.cardsReady = true;
							this.scheduleChangeDetection();
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
		this.isLoading = true;
		// Disconnect observer before reset
		this.disconnectInfiniteScrollObserver();
		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}
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
		this.allStreamedEvents = []; // Clear streamed events buffer
		this.loadingEvents.clear(); // Clear loading events set
		if (firstEvent) {
			// Keep the first event that was loaded for return
			this.allStreamedEvents = [firstEvent];
			this.evenements = [firstEvent];
		}
		
		this.filteredTotal = 0;
		this.resetColorAggregation();
		// Don't set up observer here - wait until after cards are rendered
		this.loadInitialEvents();
	}

	private loadInitialEvents(): void {
		// Use streaming instead of pagination
		this.loadEventsStream();
	}

	private loadEventsStream(): void {
		// Don't check isLoadingNextPage here - it's only for scroll loading
		// This is the initial load, so we use isLoading instead

		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}

		const requestToken = this.feedRequestToken;
		const rawFilter = (this.dataFIlter ?? "").trim();
		const searchString = rawFilter === "" ? "*" : rawFilter;

		// Only set isLoading for initial load, not isLoadingNextPage
		this.isLoading = true;
		this.isLoadingNextPage = false; // Not loading next page, this is initial load

		this.waitForNonEmptyValue().then(() => {
			if (requestToken !== this.feedRequestToken) {
				return;
			}
			this.eventsSubscription?.unsubscribe();
			
			// Stream all events
			const subscription = this._evenementsService
				.streamEvents(searchString, this.user.id)
				.subscribe({
					next: (streamedEvent: StreamedEvent) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						
						if (streamedEvent.type === 'total') {
							// Total count received
							this.filteredTotal = streamedEvent.data as number;
							this.scheduleChangeDetection();
						} else if (streamedEvent.type === 'event') {
							// New event received - add it to the buffer
							const newEvent = streamedEvent.data as Evenement;
							const newEventId = newEvent.id || this.getEventKey(newEvent);
							
							// Skip if already in buffer
							if (this.allStreamedEvents.some(e => {
								const eId = e.id || this.getEventKey(e);
								return eId === newEventId;
							})) {
								return;
							}
							
							// Add event to buffer
							this.allStreamedEvents.push(newEvent);
							
							// Display only first 8 events (or less if not enough)
							this.updateDisplayedEvents();
							
							// Batch change detection for better performance
							this.scheduleChangeDetection();
						} else if (streamedEvent.type === 'complete') {
							// Streaming complete - ensure first 8 events are displayed
							this.updateDisplayedEvents();
							this.isLoadingNextPage = false;
							this.isLoading = false;
							this.hasMoreEvents = this.evenements.length < this.allStreamedEvents.length;
							this.unblockPageScroll();
							
							// Mark card load end after cards are rendered
							setTimeout(() => {
								this.evenements.forEach(e => {
									const eId = e.id || this.getEventKey(e);
									if (eId) {
										const loadingInfo = this.loadingEvents.get(eId);
										if (loadingInfo && !loadingInfo.cardLoadEnd) {
											loadingInfo.cardLoadEnd = Date.now();
											// Only delete if thumbnail is also loaded or doesn't exist
											if (loadingInfo.thumbnailLoadEnd || !loadingInfo.thumbnailLoadStart) {
												this.loadingEvents.delete(eId);
											}
										}
									}
								});
								this.scheduleChangeDetection();
							}, 300);
							
							// Clean up unused thumbnails
							this.cleanupUnusedThumbnails();
							
							// Wait for cards to be in DOM
							setTimeout(() => {
								if (this.patCards && this.patCards.length > 0) {
									this.cardsReady = true;
									this.scheduleChangeDetection();
									this.unblockPageScroll();
									this.shouldBlockScroll = false;
								} else {
									setTimeout(() => {
										this.cardsReady = true;
										this.scheduleChangeDetection();
										this.unblockPageScroll();
										this.shouldBlockScroll = false;
									}, 100);
								}
							}, 150);
							
							// Reconnect observer after streaming completes to enable scroll loading
							// Wait a bit longer to ensure DOM is updated and anchor is rendered
							setTimeout(() => {
								console.log('Streaming complete, setting up observer', { 
									displayed: this.evenements.length, 
									total: this.allStreamedEvents.length,
									hasMore: this.evenements.length < this.allStreamedEvents.length
								});
								// Force setup of observer - retry multiple times if needed
								let retryCount = 0;
								const maxRetries = 5;
								const trySetupObserver = () => {
									if (this.infiniteScrollAnchor?.nativeElement) {
										this.setupInfiniteScrollObserver();
										console.log('Observer set up successfully');
									} else if (retryCount < maxRetries) {
										retryCount++;
										setTimeout(trySetupObserver, 200);
									} else {
										console.warn('Failed to set up observer after', maxRetries, 'retries');
									}
								};
								trySetupObserver();
								this.observeThumbnailElements();
							}, 400);
							
							// Use scheduleChangeDetection instead of detectChanges for better performance
							this.scheduleChangeDetection();
						}
					},
					error: (err: any) => {
						if (requestToken !== this.feedRequestToken) {
							return;
						}
						console.error("Error when getting Events", err);
						this.isLoadingNextPage = false;
						this.isLoading = false;
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
		
		// Check in displayed events
		return this.evenements.some(e => {
			const eId = e.id || this.getEventKey(e);
			return eId === eventId;
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

		// Observer to load next 8 events when scrolling
		this.intersectionObserver = new IntersectionObserver((entries) => {
			entries.forEach(entry => {
				if (entry.isIntersecting) {
					const displayedCount = this.evenements.length;
					const totalCount = this.allStreamedEvents.length;
					
					if (displayedCount < totalCount) {
						// Load next 8 events from buffer
						this.loadNextPage();
					}
				}
			});
		}, {
			root: null,
			rootMargin: '200px', // Start loading 200px before reaching the anchor
			threshold: 0
		});

		try {
			this.intersectionObserver.observe(anchor);
			console.log('IntersectionObserver setup complete, observing anchor');
		} catch (error) {
			console.error('Error setting up IntersectionObserver:', error);
		}
	}

	private checkScrollPosition(): void {
		// No longer needed - using IntersectionObserver
	}

	// Update displayed events to show only first CARDS_PER_PAGE events
	private updateDisplayedEvents(): void {
		const currentCount = this.evenements.length;
		const targetCount = Math.min(this.CARDS_PER_PAGE, this.allStreamedEvents.length);
		
		// Only update if we need to add more events (not remove)
		if (currentCount < targetCount) {
			// Add new events from buffer
			const newEvents = this.allStreamedEvents.slice(currentCount, targetCount);
			newEvents.forEach(event => {
				if (!this.isEventAlreadyLoaded(event)) {
					this.evenements.push(event);
					// Load thumbnail for new event
					const eId = event.id || this.getEventKey(event);
					if (eId) {
						const loadingInfo: LoadingEventInfo = {
							eventId: eId,
							cardLoadStart: Date.now()
						};
						this.loadingEvents.set(eId, loadingInfo);
						// Queue card load end to be processed in batch
						this.pendingCardLoadEnds.add(eId);
						this.scheduleCardLoadEndBatch();
					}
					this.queueThumbnailLoad(event);
					// Load file thumbnails for displayed events
					this.loadFileThumbnails(event);
				}
			});
			// Batch change detection for better performance
			this.scheduleChangeDetection();
			
			// Re-observe thumbnail elements after new events are added to DOM
			// Use setTimeout to ensure DOM is updated
			setTimeout(() => {
				this.observeThumbnailElements();
			}, 100);
		}
	}

	// Load next 8 events when scrolling
	private loadNextPage(): void {
		if (this.isLoadingNextPage) {
			console.log('Already loading, skipping');
			return;
		}
		
		const currentCount = this.evenements.length;
		const totalCount = this.allStreamedEvents.length;
		
		if (currentCount >= totalCount) {
			console.log('No more events to load', { currentCount, totalCount });
			this.hasMoreEvents = false;
			return;
		}
		
		this.isLoadingNextPage = true;
		
		// Load next 8 events
		const nextEvents = this.allStreamedEvents.slice(currentCount, currentCount + this.CARDS_PER_PAGE);
		
		if (nextEvents.length === 0) {
			console.log('No next events found');
			this.isLoadingNextPage = false;
			this.hasMoreEvents = false;
			return;
		}
		
		// Add all next events
		nextEvents.forEach(event => {
			const eventId = event.id || this.getEventKey(event);
		if (!this.isEventAlreadyLoaded(event)) {
			this.evenements.push(event);
			
			// Load thumbnail for new event
				if (eventId) {
					const loadingInfo: LoadingEventInfo = {
						eventId: eventId,
						cardLoadStart: Date.now()
					};
					this.loadingEvents.set(eventId, loadingInfo);
					// Queue card load end to be processed in batch
					this.pendingCardLoadEnds.add(eventId);
					this.scheduleCardLoadEndBatch();
				}
				this.queueThumbnailLoad(event);
				// Load file thumbnails for displayed events
				this.loadFileThumbnails(event);
			} else {
				console.log('✗ Event already loaded:', eventId);
			}
		});
		
		// Update hasMoreEvents
		this.hasMoreEvents = this.evenements.length < this.allStreamedEvents.length;
		
		this.isLoadingNextPage = false;
		// Use scheduleChangeDetection for better performance with OnPush
		this.scheduleChangeDetection();
		
		// Re-observe after a short delay
		setTimeout(() => {
			if (this.infiniteScrollAnchor && this.infiniteScrollAnchor.nativeElement && this.intersectionObserver) {
				try {
					// Disconnect and reconnect to reset observer
					this.intersectionObserver.disconnect();
					this.intersectionObserver.observe(this.infiniteScrollAnchor.nativeElement);
				} catch (error) {
					console.error('Error re-observing anchor:', error);
				}
			}
		}, 200);
	}

	// Removed all cache and pagination methods - no longer needed with streaming

	private disconnectInfiniteScrollObserver(): void {
		if (this.intersectionObserver) {
			this.intersectionObserver.disconnect();
			this.intersectionObserver = undefined;
		}
	}

	// Removed schedulePrefetchIfNeeded and tryLoadNextIfAnchorVisible - no longer needed with streaming

	public onEventColorUpdate(update: EventColorUpdate): void {
		if (!update || !update.eventId) {
			return;
		}
		if (!this.isEventVisible(update.eventId)) {
			return;
		}
		// Stocker les couleurs des cartes pour le debug
		this.eventColors.set(update.eventId, update.color);
		
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

	public getEventKey(evenement: Evenement | null | undefined): string {
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
		
		// Use scheduleChangeDetection for better performance
		this.scheduleChangeDetection();
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
		const eventId = evenement.id || this.getEventKey(evenement);
		if (!eventId) {
			const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
			return defaultUrl;
		}
		
		// Vérifier si on a déjà cette thumbnail en cache
		if (this.eventThumbnails.has(eventId)) {
			const cachedUrl = this.eventThumbnails.get(eventId);
			if (cachedUrl) {
				// Vérifier si c'est une vraie image chargée (blob) ou juste l'image par défaut
				if (typeof cachedUrl === 'object' && 'changingThisBreaksApplicationSecurity' in cachedUrl) {
					const url = cachedUrl['changingThisBreaksApplicationSecurity'];
					if (url && typeof url === 'string' && url.startsWith('blob:')) {
						return cachedUrl; // Vraie image chargée
					}
				} else if (typeof cachedUrl === 'string' && cachedUrl.startsWith('blob:')) {
					return cachedUrl; // Vraie image chargée
				}
				// Sinon, c'est l'image par défaut, on continue pour vérifier si on peut charger
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
					this.eventThumbnails.set(eventId, cachedThumbnail);
					return cachedThumbnail;
				}
			}
			
			// Déclencher le chargement via la queue (batch loading)
			if (!this.pendingThumbnailLoads.has(eventId)) {
				this.queueThumbnailLoad(evenement);
			}
		}
		
		// Toujours retourner l'image par défaut en attendant le chargement
		const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
		// Ne pas écraser si on a déjà une image par défaut
		if (!this.eventThumbnails.has(eventId)) {
			this.eventThumbnails.set(eventId, defaultUrl);
		}
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
								// Batch change detection
								this.scheduleChangeDetection();
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
								// Batch change detection
								this.scheduleChangeDetection();
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
					// Batch change detection
					this.scheduleChangeDetection();
				}
			}
		});
		
		// Load thumbnails with concurrency limit to avoid overwhelming the browser
		if (thumbnailLoadRequests.length > 0) {
			// Process requests in smaller chunks to avoid blocking
			const CONCURRENT_LIMIT = 3; // Load max 3 thumbnails at a time
			let currentIndex = 0;
			
			const processNextBatch = () => {
				const batch = thumbnailLoadRequests.slice(currentIndex, currentIndex + CONCURRENT_LIMIT);
				currentIndex += CONCURRENT_LIMIT;
				
				if (batch.length === 0) return;
				
				// Use requestIdleCallback if available, otherwise setTimeout
				const scheduleNext = () => {
					if (currentIndex < thumbnailLoadRequests.length) {
						setTimeout(processNextBatch, 50); // Small delay between batches
					}
				};
				
				if ('requestIdleCallback' in window) {
					(window as any).requestIdleCallback(() => {
						forkJoin(batch).subscribe({
							next: (results) => {
								// Process results asynchronously
								Promise.resolve().then(() => {
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
									}
									// Trigger change detection
									this.scheduleChangeDetection();
									scheduleNext();
								});
							},
							error: (error) => {
								console.error('Error loading thumbnail batch:', error);
								this.scheduleChangeDetection();
								scheduleNext();
							}
						});
					}, { timeout: 1000 });
				} else {
					// Fallback to setTimeout
					setTimeout(() => {
						forkJoin(batch).subscribe({
							next: (results) => {
								Promise.resolve().then(() => {
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
									}
									// Trigger change detection
									this.scheduleChangeDetection();
									scheduleNext();
								});
							},
							error: (error) => {
								console.error('Error loading thumbnail batch:', error);
								this.scheduleChangeDetection();
								scheduleNext();
							}
						});
					}, 0);
				}
			};
			
			// Start processing
			processNextBatch();
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
							// Batch change detection
							this.scheduleChangeDetection();
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
						// Batch change detection
						this.scheduleChangeDetection();
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
						// Batch change detection
						this.scheduleChangeDetection();
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
						// Batch change detection
						this.scheduleChangeDetection();
					}
				}
			}
		});
		this.allSubscriptions.push(thumbnailSubscription);
	}

	// Initialize batch loader for thumbnails - groups thumbnail loads to reduce server load
	private initializeThumbnailBatchLoader(): void {
		let batchBuffer: Evenement[] = [];
		let batchTimeout: ReturnType<typeof setTimeout> | null = null;
		
		const processBatch = () => {
			if (batchBuffer.length === 0) return;
			
			const batch = [...batchBuffer];
			batchBuffer = [];
			
			// Process in batches of THUMBNAIL_BATCH_SIZE
			const batches: Evenement[][] = [];
			for (let i = 0; i < batch.length; i += this.THUMBNAIL_BATCH_SIZE) {
				batches.push(batch.slice(i, i + this.THUMBNAIL_BATCH_SIZE));
			}
			
			// Load batches sequentially with delays to avoid blocking the main thread
			batches.forEach((subBatch, index) => {
				setTimeout(() => {
					// Use requestIdleCallback if available, otherwise requestAnimationFrame
					const scheduleLoad = (callback: () => void) => {
						if ('requestIdleCallback' in window) {
							(window as any).requestIdleCallback(callback, { timeout: 1000 });
						} else {
							requestAnimationFrame(callback);
						}
					};
					
					scheduleLoad(() => {
						// Load thumbnails asynchronously to avoid blocking
						Promise.resolve().then(() => {
							this.loadThumbnailsInParallel(subBatch, true);
							// Remove from pending after loading starts
							subBatch.forEach(event => {
								const eventId = event.id || this.getEventKey(event);
								if (eventId) {
									this.pendingThumbnailLoads.delete(eventId);
								}
							});
						});
					});
				}, index * this.THUMBNAIL_BATCH_INTERVAL); // Increased delay between batches
			});
		};
		
		this.thumbnailLoadQueueSubscription = this.thumbnailLoadQueue.subscribe((event: Evenement) => {
			batchBuffer.push(event);
			
			// Clear existing timeout
			if (batchTimeout) {
				clearTimeout(batchTimeout);
			}
			
			// Process batch after delay using requestAnimationFrame for better performance
			batchTimeout = setTimeout(() => {
				requestAnimationFrame(() => {
					processBatch();
				});
				batchTimeout = null;
			}, this.THUMBNAIL_BATCH_DELAY);
		});
		
		this.allSubscriptions.push(this.thumbnailLoadQueueSubscription);
	}

	// Queue an event's thumbnail for batch loading
	private queueThumbnailLoad(event: Evenement): void {
		const eventId = event.id || this.getEventKey(event);
		if (!eventId || this.pendingThumbnailLoads.has(eventId)) {
			return; // Already queued or loading
		}
		
		// Check if already cached
		if (this.eventThumbnails.has(eventId)) {
			const cached = this.eventThumbnails.get(eventId);
			if (cached && typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
				const url = cached['changingThisBreaksApplicationSecurity'];
				if (url && typeof url === 'string' && url.startsWith('blob:')) {
					return; // Already loaded
				}
			}
		}
		
		this.pendingThumbnailLoads.add(eventId);
		this.thumbnailLoadQueue.next(event);
	}

	// Schedule batch processing of card load end events
	private scheduleCardLoadEndBatch(): void {
		// Clear existing timeout
		if (this.cardLoadEndBatchTimeout) {
			clearTimeout(this.cardLoadEndBatchTimeout);
		}

		// Process batch after a short delay to allow multiple cards to be queued
		this.cardLoadEndBatchTimeout = setTimeout(() => {
			if (this.pendingCardLoadEnds.size === 0) {
				this.cardLoadEndBatchTimeout = null;
				return;
			}

			// Process all pending card load ends
			const pendingIds = Array.from(this.pendingCardLoadEnds);
			this.pendingCardLoadEnds.clear();

			// Mark card load end for all pending events
			pendingIds.forEach(eventId => {
				const loadingInfo = this.loadingEvents.get(eventId);
				if (loadingInfo && !loadingInfo.cardLoadEnd) {
					loadingInfo.cardLoadEnd = Date.now();
					// Only delete if thumbnail is also loaded or doesn't exist
					if (loadingInfo.thumbnailLoadEnd || !loadingInfo.thumbnailLoadStart) {
						this.loadingEvents.delete(eventId);
					}
				}
			});

			this.cardLoadEndBatchTimeout = null;
			this.scheduleChangeDetection();
		}, 300); // Same delay as used in the existing card load end marking
	}

	// Setup IntersectionObserver for lazy loading visible thumbnails
	private setupThumbnailLazyLoading(): void {
		if (!('IntersectionObserver' in window)) {
			return; // Not supported
		}
		
		this.thumbnailObserver = new IntersectionObserver((entries) => {
			const eventsToLoad: Evenement[] = [];
			
			entries.forEach(entry => {
				if (entry.isIntersecting) {
					const element = entry.target as HTMLElement;
					const eventId = element.getAttribute('data-event-id');
					if (eventId) {
						const event = this.evenements.find(e => (e.id || this.getEventKey(e)) === eventId);
						if (event && !this.eventThumbnails.has(eventId)) {
							// Check if not already a blob URL (loaded)
							const cached = this.eventThumbnails.get(eventId);
							if (!cached) {
								// No cached thumbnail, need to load
								eventsToLoad.push(event);
							} else if (typeof cached === 'object' && 'changingThisBreaksApplicationSecurity' in cached) {
								const url = cached['changingThisBreaksApplicationSecurity'];
								if (!url || (typeof url === 'string' && !url.startsWith('blob:'))) {
									eventsToLoad.push(event);
								}
							} else if (typeof cached === 'string' && !cached.startsWith('blob:')) {
								// Default image, need to load real thumbnail
								eventsToLoad.push(event);
							}
						}
					}
				}
			});
			
			// Load visible thumbnails
			if (eventsToLoad.length > 0) {
				this.loadThumbnailsInParallel(eventsToLoad, true);
			}
		}, {
			rootMargin: `${this.THUMBNAIL_PREFETCH_DISTANCE}px`, // Prefetch before entering viewport
			threshold: 0.01
		});
		
		// Observe all card elements after a short delay to ensure DOM is ready
		setTimeout(() => {
			this.observeThumbnailElements();
		}, 200);
	}

	// Observe thumbnail elements for lazy loading
	private observeThumbnailElements(): void {
		if (!this.thumbnailObserver) return;
		
		// Observe all card containers and images with data-event-id
		const elementsToObserve = document.querySelectorAll('[data-event-id]');
		elementsToObserve.forEach(element => {
			// For card containers, observe the first image inside
			if (element.classList.contains('pat-card')) {
				const img = element.querySelector('img');
				if (img) {
					this.thumbnailObserver?.observe(img);
				} else {
					// Fallback: observe the card container itself
					this.thumbnailObserver?.observe(element);
				}
			} else {
				// Direct image observation
				this.thumbnailObserver?.observe(element);
			}
		});
	}

	// Disconnect thumbnail observer
	private disconnectThumbnailObserver(): void {
		if (this.thumbnailObserver) {
			this.thumbnailObserver.disconnect();
			this.thumbnailObserver = undefined;
		}
		this.pendingThumbnailLoads.clear();
	}

	// Removed preloadThumbnailsForBufferedEvents - thumbnails are loaded directly with events in streaming

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
				const storageData = {
					eventId: eventId,
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
				this.scheduleChangeDetection();
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
		
		// Clean up previous Firebase subscription if exists
		if (this.firebaseUnsubscribe) {
			this.firebaseUnsubscribe();
			this.firebaseUnsubscribe = undefined;
		}
		
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
			
			// Store unsubscribe function for cleanup
			this.firebaseUnsubscribe = unsubscribe;
			
			// Retourner la fonction de nettoyage
			return () => unsubscribe();
		});
		
		// Utiliser la même configuration que dans element-evenement
		const modalRef = this.modalService.open(this.chatModal, { backdrop: 'static', keyboard: false });
		
		// Clean up Firebase subscription when modal is closed
		modalRef.result.finally(() => {
			if (this.firebaseUnsubscribe) {
				this.firebaseUnsubscribe();
				this.firebaseUnsubscribe = undefined;
			}
		}).catch(() => {
			// Modal dismissed - cleanup already handled in finally
		});
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
		
		// Clean up poll interval
		if (this.pollIntervalId) {
			clearInterval(this.pollIntervalId);
			this.pollIntervalId = null;
		}
		
		// Unsubscribe from all subscriptions
		this.eventsSubscription?.unsubscribe();
		this.searchSubscriptions.forEach(sub => sub.unsubscribe());
		this.searchSubscriptions = [];
		this.allSubscriptions.forEach(sub => {
			if (!sub.closed) {
				sub.unsubscribe();
			}
		});
		this.allSubscriptions = [];
		this.thumbnailLoadQueueSubscription?.unsubscribe();
		this.thumbnailLoadQueue.complete();
		
		// Disconnect observers
		this.disconnectThumbnailObserver();
		this.disconnectInfiniteScrollObserver();
		
		// Clean up Firebase unsubscribe
		if (this.firebaseUnsubscribe) {
			this.firebaseUnsubscribe();
			this.firebaseUnsubscribe = undefined;
		}
		
		// Clean up all timeouts
		if (this.prefetchTimeoutId) {
			clearTimeout(this.prefetchTimeoutId);
			this.prefetchTimeoutId = null;
		}
		if (this.scrollCheckTimeoutId) {
			clearTimeout(this.scrollCheckTimeoutId);
			this.scrollCheckTimeoutId = null;
		}
		if (this.updateAverageColorTimeoutId) {
			clearTimeout(this.updateAverageColorTimeoutId);
			this.updateAverageColorTimeoutId = null;
		}
		if (this.cardLoadEndBatchTimeout) {
			clearTimeout(this.cardLoadEndBatchTimeout);
			this.cardLoadEndBatchTimeout = null;
		}
		
		// Clean up active timeouts Set
		this.activeTimeouts.forEach(timeoutId => {
			clearTimeout(timeoutId);
		});
		this.activeTimeouts.clear();
		
		// Clean up Maps and Sets
		this.loadingEvents.clear();
		this.eventColors.clear();
		this.pendingThumbnailLoads.clear();
		this.pendingCardLoadEnds.clear();
		
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
		
		// Clean up static caches from ElementEvenementComponent
		// Collect all fieldIds and eventIds currently displayed
		const keepEventIds = new Set<string>();
		const keepFieldIds = new Set<string>();
		this.evenements.forEach(e => {
			const eId = e.id || this.getEventKey(e);
			if (eId) {
				keepEventIds.add(eId);
				// Collect fieldIds from thumbnail files
				if (e.fileUploadeds) {
					e.fileUploadeds.forEach(file => {
						if (file.fileName && file.fileName.indexOf('thumbnail') !== -1 && file.fieldId) {
							keepFieldIds.add(file.fieldId);
						}
					});
				}
			}
		});
		
		// Clean up static caches, keeping only what's currently displayed
		if (keepFieldIds.size > 0) {
			ElementEvenementComponent.cleanupUnusedCaches(keepFieldIds);
		} else {
			// If no events displayed, clean all (component is being destroyed)
			ElementEvenementComponent.cleanupUnusedCaches(new Set<string>());
		}
		ElementEvenementComponent.cleanupUnusedThumbnailCache(keepEventIds);
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
	// Get visible events count (cards currently displayed)
	public getVisibleEventsCount(): number {
		return this.evenements.length;
	}
	
	// Get streamed events count (total events in buffer)
	public getStreamedEventsCount(): number {
		return this.allStreamedEvents.length;
	}
	
	// Get loading events count
	public getLoadingEventsCount(): number {
		return this.loadingEvents.size;
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
	
	// Get cached thumbnails count - now counts all thumbnails since there's no buffer
	public getCachedThumbnailsCount(): number {
		return this.eventThumbnails.size;
	}
	
	// Get file thumbnails cache count
	public getFileThumbnailsCacheCount(): number {
		return this.fileThumbnailsCache.size;
	}
	
	// Get pending thumbnail loads count
	public getPendingThumbnailLoadsCount(): number {
		return this.pendingThumbnailLoads.size;
	}
	
	// Get event colors cache count
	public getEventColorsCacheCount(): number {
		return this.eventColors.size;
	}
	
	// Get all streamed events buffer size
	public getAllStreamedEventsCount(): number {
		return this.allStreamedEvents.length;
	}
	
	// Get loading events map size
	public getLoadingEventsMapSize(): number {
		return this.loadingEvents.size;
	}
	
	// Clean up thumbnails that are no longer needed
	private cleanupUnusedThumbnails(): void {
		// Get all event IDs that should keep thumbnails
		const keepEventIds = new Set<string>();
		const keepFieldIds = new Set<string>(); // Field IDs to keep (from displayed events)
		
		// Add displayed events (only currently visible events)
		this.evenements.forEach(e => {
			const eId = e.id || this.getEventKey(e);
			if (eId) {
				keepEventIds.add(eId);
				// Also collect field IDs from thumbnail files in displayed events
				if (e.fileUploadeds) {
					e.fileUploadeds.forEach(file => {
						if (file.fileName && file.fileName.indexOf('thumbnail') !== -1 && file.fieldId) {
							keepFieldIds.add(file.fieldId);
						}
					});
				}
			}
		});
		
		// Remove thumbnails that are not in the keep list (local cache)
		const thumbnailsToRemove: string[] = [];
		this.eventThumbnails.forEach((url, eventId) => {
			if (!keepEventIds.has(eventId)) {
				thumbnailsToRemove.push(eventId);
			}
		});
		
		// Remove unused thumbnails and revoke blob URLs (local cache)
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
		
		// Clean up static caches (blobUrlCache, blobCache, thumbnailCache) from ElementEvenementComponent
		// Only keep entries that are still in use by displayed events
		this.cleanupStaticThumbnailCaches(keepEventIds, keepFieldIds);
		
		// Force change detection to update debug panel
		if (thumbnailsToRemove.length > 0) {
			this.scheduleChangeDetection();
		}
	}
	
	// Clean up static thumbnail caches from ElementEvenementComponent
	private cleanupStaticThumbnailCaches(keepEventIds: Set<string>, keepFieldIds: Set<string>): void {
		// Clean up thumbnailCache - remove entries for events not displayed
		ElementEvenementComponent.cleanupUnusedThumbnailCache(keepEventIds);
		
		// Clean up blobUrlCache and blobCache - remove entries for fieldIds not in use
		// But only if we have fieldIds to check (if no events displayed, we might want to keep some for next load)
		if (keepFieldIds.size > 0) {
			ElementEvenementComponent.cleanupUnusedCaches(keepFieldIds);
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
