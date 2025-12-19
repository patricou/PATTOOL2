import { Component, OnInit, OnDestroy, ViewChild, TemplateRef, ElementRef, ChangeDetectorRef } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource, SlideshowLocationEvent } from '../../shared/slideshow-modal/slideshow-modal.component';
import { TraceViewerModalComponent } from '../../shared/trace-viewer-modal/trace-viewer-modal.component';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { Observable, Subscription, of, EMPTY } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';

import { Evenement } from '../../model/evenement';
import { Member } from '../../model/member';
import { UploadedFile } from '../../model/uploadedfile';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { DiscussionService, DiscussionMessage } from '../../services/discussion.service';
import { DiscussionModalComponent } from '../../communications/discussion-modal/discussion-modal.component';
import { EvenementsService } from '../../services/evenements.service';
import { MembersService } from '../../services/members.service';
import { FileService, ImageDownloadResult } from '../../services/file.service';
import { WindowRefService } from '../../services/window-ref.service';
import { FriendsService } from '../../services/friends.service';
import { VideoCompressionService, CompressionProgress } from '../../services/video-compression.service';
import { environment } from '../../../environments/environment';
import { ElementEvenementComponent } from '../element-evenement/element-evenement.component';
import { FriendGroup } from '../../model/friend';
import { EventColorService } from '../../services/event-color.service';
import { KeycloakService } from '../../keycloak/keycloak.service';

@Component({
  selector: 'app-details-evenement',
  templateUrl: './details-evenement.component.html',
  styleUrls: ['./details-evenement.component.css']
})
export class DetailsEvenementComponent implements OnInit, OnDestroy {

  public evenement: Evenement | null = null;
  public user: Member | null = null;
  public loading: boolean = true;
  public error: string | null = null;
  
  // API URLs
  public API_URL: string = environment.API_URL;
  public API_URL4FILE: string = environment.API_URL4FILE;
  
  // Native Window
  public nativeWindow: any;
  
  // Image modal properties
  public selectedImageUrl: string = '';
  public selectedImageAlt: string = '';
  
  // Photo gallery with comments overlay
  public photoItems: Array<{
    file: UploadedFile;
    imageUrl: SafeUrl;
    comments: Commentary[];
  }> = [];

  // Getter for photoItems to ensure TypeScript recognition
  public get photoItemsList(): Array<{
    file: UploadedFile;
    imageUrl: SafeUrl;
    comments: Commentary[];
  }> {
    return this.photoItems;
  }

  // Photo gallery properties
  public currentPhotoIndex: number = 0;
  
  // Fullscreen properties
  public isFullscreen: boolean = false;
  
  // Image cache for authenticated images
  private imageCache = new Map<string, SafeUrl>();
  
  // Cache for discussion file URLs (blob URLs)
  private discussionFileUrlCache: Map<string, string> = new Map();
  // Store blobs separately to recreate blob URLs if needed
  private discussionFileBlobCache: Map<string, Blob> = new Map();
  // Cache for video URLs (blob URLs)
  private videoUrlCache: Map<string, SafeUrl> = new Map();
  // Track videos that have successfully loaded to avoid false error logs
  private videoLoadSuccess: Set<string> = new Set();
  
  // Track active HTTP subscriptions to cancel them on destroy
  private activeSubscriptions = new Set<Subscription>();
  
  @ViewChild('imageModal') imageModal!: TemplateRef<any>;
  @ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
  @ViewChild('traceViewerModalComponent') traceViewerModalComponent!: TraceViewerModalComponent;
  @ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;
  @ViewChild('qualitySelectionModal') qualitySelectionModal!: TemplateRef<any>;
  @ViewChild('discussionMessagesContainer', { read: ElementRef }) discussionMessagesContainer!: ElementRef;
  @ViewChild('directoryInput') directoryInput!: any;
  @ViewChild('editDirectoryInput') editDirectoryInput!: any;

  // Slideshow properties (now handled by SlideshowModalComponent - kept for backward compatibility but not used)

  // FS Photos download control
  private fsDownloadsActive: boolean = false;
  private fsActiveSubs: Subscription[] = [];
  private fsQueue: string[] = [];
  
  // FS Slideshow loading control
  private fsSlideshowLoadingActive: boolean = false;
  private fsSlideshowSubs: Subscription[] = [];

  // Friend groups for WhatsApp links
  public friendGroups: FriendGroup[] = [];
  private friendGroupsLoaded: boolean = false;


  // Discussion messages
  public discussionMessages: DiscussionMessage[] = [];
  public isLoadingDiscussion: boolean = false;
  public discussionError: string | null = null;
  
  // Video URLs for display
  public videoUrls: Map<string, SafeUrl> = new Map();
  
  // File upload properties
  public selectedFiles: File[] = [];
  public uploadLogs: string[] = [];
  public isUploading: boolean = false;
  public selectedCompressionQuality: 'low' | 'medium' | 'high' = 'high';
  public showQualitySelection: boolean = false;
  public pendingVideoFiles: File[] = [];
  public videoCountForModal: number = 0;
  private qualityModalRef: any = null;
  private activeTimeouts = new Set<any>();
  @ViewChild('logContent') logContent!: ElementRef;

  // ==============================
  // URL Events (Links) management
  // ==============================

  public urlEventTypes: {id: string, label: string}[] = [
    {id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE"},
    {id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION"},
    {id: "FICHE", label: "EVENTHOME.URL_TYPE_FICHE"},
    {id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER"},
    {id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS"},
    {id: "PHOTOFROMFS", label: "EVENTHOME.URL_TYPE_PHOTOFROMFS"},
    {id: "VIDEO", label: "EVENTHOME.URL_TYPE_VIDEO"},
    {id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE"},
    {id: "WHATSAPP", label: "EVENTHOME.URL_TYPE_WHATSAPP"}
  ];

  public newUrlEvent: UrlEvent = new UrlEvent("", new Date(), "", "", "");
  public isAddingUrlEvent: boolean = false;
  public editingUrlEvent: UrlEvent = new UrlEvent("", new Date(), "", "", "");
  public editingUrlEventIndex: number = -1;

  // ==============================
  // Commentaries management
  // ==============================

  public newCommentary: Commentary = new Commentary("", "", new Date());
  public isAddingCommentary: boolean = false;
  public editingCommentaryIndex: number = -1;
  public editingCommentary: Commentary = new Commentary("", "", new Date());

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private translateService: TranslateService,
    private evenementsService: EvenementsService,
    private membersService: MembersService,
    private fileService: FileService,
    private winRef: WindowRefService,
    private modalService: NgbModal,
    private friendsService: FriendsService,
    private discussionService: DiscussionService,
    private videoCompressionService: VideoCompressionService,
    private cdr: ChangeDetectorRef,
    private eventColorService: EventColorService,
    private keycloakService: KeycloakService
  ) {
    this.nativeWindow = winRef.getNativeWindow();
  }

  ngOnInit(): void {
    // Display any stored errors from previous page load
    this.displayStoredErrors();
    
    this.loadFriendGroups();
    this.loadEventDetails();
    
    // Get color from service and apply it
    this.applyEventColor();
  }

  // Get color from service and apply it to buttons and all text
  private applyEventColor(): void {
    this.route.params.subscribe(params => {
      const eventId = params['id'];
      if (eventId) {
        const color = this.eventColorService.getEventColor(eventId);
        if (color) {
          // Calculate brightness to determine if we need lighter or darker variants
          // Using luminance formula: 0.299*R + 0.587*G + 0.114*B
          const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
          const isBright = brightness > 128;
          
          // Inverse color for badges and card titles (white if dark, dark if bright)
          const badgeTitleColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
          document.documentElement.style.setProperty('--badge-title-color', badgeTitleColor);
          
          // Inverse colors for all text based on brightness for better visibility
          // If calculated color is bright, use dark text; if dark, use light text
          // Primary text (main content, titles, headers)
          const primaryTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
          document.documentElement.style.setProperty('--text-color-primary', primaryTextColor);
          
          // Light variant (for emphasis, important text like event title, description)
          const lightTextColor = isBright ? 'rgb(10, 20, 35)' : 'rgb(245, 245, 245)';
          document.documentElement.style.setProperty('--text-color-light', lightTextColor);
          
          // Dark variant (for secondary text, labels) - slightly less contrast
          const darkTextColor = isBright ? 'rgb(60, 70, 90)' : 'rgb(200, 200, 200)';
          document.documentElement.style.setProperty('--text-color-dark', darkTextColor);
          
          // Very light variant (for subtle text, empty states) - medium contrast
          const veryLightTextColor = isBright ? 'rgb(40, 50, 70)' : 'rgb(220, 220, 220)';
          document.documentElement.style.setProperty('--text-color-very-light', veryLightTextColor);
          
          // Very dark variant (for low contrast text like empty stars) - lower contrast
          const veryDarkTextColor = isBright ? 'rgb(100, 110, 130)' : 'rgb(150, 150, 150)';
          document.documentElement.style.setProperty('--text-color-very-dark', veryDarkTextColor);
          
          // Button text color - use the calculated color for buttons (they have their own background)
          document.documentElement.style.setProperty('--btn-text-color', `rgb(${color.r}, ${color.g}, ${color.b})`);
          
          // Dropdown select colors based on calculated color
          // Selected option background (the highlighted blue item)
          const selectSelectedBg = `rgba(${color.r}, ${color.g}, ${color.b}, 0.8)`;
          // Dropdown background (unselected options - the grey background)
          const selectDropdownBg = `rgba(${Math.max(0, color.r - 50)}, ${Math.max(0, color.g - 50)}, ${Math.max(0, color.b - 50)}, 0.85)`;
          // Text color for options (reuse brightness and isBright already calculated above)
          const selectTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
          
          document.documentElement.style.setProperty('--select-selected-bg', selectSelectedBg);
          document.documentElement.style.setProperty('--select-dropdown-bg', selectDropdownBg);
          document.documentElement.style.setProperty('--select-text-color', selectTextColor);
          // Box-shadow color for focus state
          const selectSelectedBgShadow = `rgba(${color.r}, ${color.g}, ${color.b}, 0.15)`;
          document.documentElement.style.setProperty('--select-selected-bg-shadow', selectSelectedBgShadow);
        }
      }
    });
  }

  // Display stored errors from localStorage
  private displayStoredErrors(): void {
    try {
      const errors: any[] = [];
      
      // Check for video errors
      const videoError = localStorage.getItem('last_video_error');
      if (videoError) {
        errors.push({ type: 'Video Load Error', ...JSON.parse(videoError) });
      }
      
      // Check for image errors
      const imageError = localStorage.getItem('last_image_error');
      if (imageError) {
        errors.push({ type: 'Image Load Error', ...JSON.parse(imageError) });
      }
      
      // Check for discussion errors
      const discussionError = localStorage.getItem('last_discussion_error');
      if (discussionError) {
        errors.push({ type: 'Discussion File Error', ...JSON.parse(discussionError) });
      }
      
      // Check for discussion image errors history
      const discussionImageErrors = localStorage.getItem('discussion_image_errors');
      if (discussionImageErrors) {
        const history = JSON.parse(discussionImageErrors);
        if (history.length > 0) {
          errors.push({ type: 'Discussion Image Errors History', count: history.length, errors: history });
        }
      }
      
      // Check for discussion video errors history
      const discussionVideoErrors = localStorage.getItem('discussion_video_errors');
      if (discussionVideoErrors) {
        const history = JSON.parse(discussionVideoErrors);
        if (history.length > 0) {
          errors.push({ type: 'Discussion Video Errors History', count: history.length, errors: history });
        }
      }
      
      // Check for discussion messages errors
      const discussionMessagesError = localStorage.getItem('last_discussion_messages_error');
      if (discussionMessagesError) {
        errors.push({ type: 'Discussion Messages Error', ...JSON.parse(discussionMessagesError) });
      }
      
      // Check for event load errors
      const eventError = localStorage.getItem('last_event_error');
      if (eventError) {
        errors.push({ type: 'Event Load Error', ...JSON.parse(eventError) });
      }
      
      // Check for video error history
      const videoErrorHistory = localStorage.getItem('video_error_history');
      if (videoErrorHistory) {
        const history = JSON.parse(videoErrorHistory);
        if (history.length > 0) {
          errors.push({ type: 'Video Error History', count: history.length, errors: history });
        }
      }
      
      // Display all errors in console
      if (errors.length > 0) {
        console.group('🔴 ERRORS FROM PREVIOUS PAGE LOAD (stored in localStorage)');
        errors.forEach((error, index) => {
          console.error(`[${index + 1}] ${error.type}:`, error);
        });
        console.groupEnd();
      }
    } catch (e) {
      // Ignore errors in error display
    }
  }

  // Load friend groups for WhatsApp links
  private loadFriendGroups(): void {
    if (this.friendGroupsLoaded) {
      return;
    }
    
    const subscription = this.friendsService.getFriendGroups().subscribe({
      next: (groups: FriendGroup[]) => {
        this.friendGroups = groups || [];
        this.friendGroupsLoaded = true;
        // Force change detection to update the view when friend groups load
        // This ensures members and WhatsApp links are displayed correctly when friend groups load asynchronously
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading friend groups:', error);
        this.friendGroups = [];
        this.friendGroupsLoaded = true;
        this.cdr.detectChanges();
      }
    });
    this.trackSubscription(subscription);
  }

  ngOnDestroy(): void {
    this.cancelFsDownloads();
    this.onSlideshowClosed();
    
    // Cancel all active HTTP subscriptions to prevent backend errors when connection is closed
    this.activeSubscriptions.forEach(sub => {
      if (sub && !sub.closed) {
        sub.unsubscribe();
      }
    });
    this.activeSubscriptions.clear();
    
    // Clean up all object URLs to prevent memory leaks
    this.imageCache.forEach((safeUrl) => {
      const url = (safeUrl as any).changingThisBreaksApplicationSecurity;
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    this.imageCache.clear();
    
    // Clean up discussion file URLs
    this.discussionFileUrlCache.forEach((blobUrl) => {
      if (blobUrl && blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrl);
      }
    });
    this.discussionFileUrlCache.clear();
    this.discussionFileBlobCache.clear();
    
    // Clean up video URLs
    this.videoUrlCache.forEach((safeUrl) => {
      const url = (safeUrl as any).changingThisBreaksApplicationSecurity;
      if (url && url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          // Ignore errors when revoking
        }
      }
    });
    this.videoUrlCache.clear();
    this.videoUrls.clear();
    this.videoLoadSuccess.clear();
    
    // Clean up photo items blob URLs
    this.photoItems.forEach((item) => {
      const url = (item.imageUrl as any).changingThisBreaksApplicationSecurity;
      if (url && url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          // Ignore errors when revoking
        }
      }
    });
    
    // Clear all data arrays and objects
    this.photoItems = [];
    this.discussionMessages = [];
    this.isLoadingDiscussion = false;
    this.discussionError = null;
    this.evenement = null;
    this.user = null;
    this.friendGroups = [];
    this.friendGroupsLoaded = false;
    
    // Clear upload related data
    this.selectedFiles = [];
    this.uploadLogs = [];
    this.isUploading = false;
    this.pendingVideoFiles = [];
    this.videoCountForModal = 0;
    
    // Clear FS subscriptions
    this.fsActiveSubs.forEach(sub => {
      if (sub && !sub.closed) {
        sub.unsubscribe();
      }
    });
    this.fsActiveSubs = [];
    this.fsSlideshowSubs.forEach(sub => {
      if (sub && !sub.closed) {
        sub.unsubscribe();
      }
    });
    this.fsSlideshowSubs = [];
    this.fsQueue = [];
    this.fsDownloadsActive = false;
    this.fsSlideshowLoadingActive = false;
    
    // Clear timeouts
    this.activeTimeouts.forEach(timeout => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    this.activeTimeouts.clear();
    
    // Clear error and loading states
    this.error = null;
    this.loading = true;
    
    // Reset photo gallery
    this.currentPhotoIndex = 0;
    this.isFullscreen = false;
  }

  private loadEventDetails(): void {
    const eventId = this.route.snapshot.paramMap.get('id');
    
    if (!eventId) {
      this.error = 'ID d\'événement manquant';
      this.loading = false;
      return;
    }

    // Load current user
    this.user = this.membersService.getUser();

    // Load event details
    this.evenementsService.getEvenement(eventId).subscribe({
      next: (evenement: Evenement) => {
        this.evenement = evenement;

        // Ensure arrays exist so we can add links/comments from the details view
        if (!this.evenement.urlEvents) {
          this.evenement.urlEvents = [];
        }
        if (!this.evenement.commentaries) {
          this.evenement.commentaries = [];
        }

        // Initialize "new" forms with current user
        this.newUrlEvent = new UrlEvent("", new Date(), this.user?.userName || "", "", "");
        this.newCommentary = new Commentary(this.user?.userName || "", "", new Date());

        this.preparePhotoGallery();
        this.loading = false;
        // Load video URLs with a small delay to ensure authentication is ready
        // This prevents 401 errors that could trigger redirects
        setTimeout(() => {
          this.loadVideoUrls();
        }, 100);
        // Load discussion messages if discussionId exists
        if (evenement.discussionId) {
          this.loadDiscussionMessages();
        }
      },
      error: (error: any) => {
        // Log to localStorage FIRST so it persists even if redirect happens
        const errorInfo = {
          type: 'event_load_error',
          status: error?.status,
          statusText: error?.statusText,
          message: error?.message,
          url: error?.url,
          timestamp: new Date().toISOString(),
          fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        };
        
        try {
          localStorage.setItem('last_event_error', JSON.stringify(errorInfo));
        } catch (e) {
          // Ignore storage errors
        }
        
        console.error('[EVENT LOAD ERROR]', errorInfo);
        
        // If it's a 401, the interceptor will redirect to login
        // Don't set error message as user will be redirected
        if (error?.status === 401) {
          // Interceptor will handle redirect, just return
          return;
        }
        this.error = 'Erreur lors du chargement de l\'événement';
        this.loading = false;
      }
    });
  }

  // ==============================
  // Persist changes (links/comments)
  // ==============================

  private persistEventChanges(): void {
    if (!this.evenement) {
      return;
    }

    const subscription = this.evenementsService.putEvenement(this.evenement).subscribe({
      next: () => {
        // Keep user on details page; UI already updated optimistically
      },
      error: (err: any) => {
        if (err?.status === 403) {
          alert(this.translateService.instant('EVENTUPDT.PHOTOFROMFS_UNAUTHORIZED_UPDATE'));
        } else {
          alert(this.translateService.instant('COMMUN.ERROR') || 'Erreur');
        }
        // Reload event to restore server state if needed
        this.loadEventDetails();
      }
    });

    this.activeSubscriptions.add(subscription);
  }

  // ==============================
  // URL Events (Links) CRUD
  // ==============================

  public getAvailableUrlEventTypes(): {id: string, label: string}[] {
    if (this.keycloakService.hasFileSystemRole()) {
      return this.urlEventTypes;
    }
    return this.urlEventTypes.filter(type => type.id !== 'PHOTOFROMFS');
  }

  public getSortedUrlEventTypes(): {id: string, label: string}[] {
    return [...this.getAvailableUrlEventTypes()].sort((a, b) =>
      this.translateService.instant(a.label).localeCompare(this.translateService.instant(b.label))
    );
  }

  private canCreatePhotoFromFsLink(): boolean {
    return this.keycloakService.hasFileSystemRole();
  }

  public canEditUrlEvent(urlEvent: UrlEvent): boolean {
    return !!this.user?.userName && !!urlEvent?.owner &&
      this.user.userName.toLowerCase() === urlEvent.owner.toLowerCase();
  }

  public canDeleteUrlEvent(urlEvent: UrlEvent): boolean {
    return this.canEditUrlEvent(urlEvent);
  }

  public startAddUrlEvent(): void {
    if (!this.user) {
      this.user = this.membersService.getUser();
    }
    this.isAddingUrlEvent = true;
    this.newUrlEvent = new UrlEvent("", new Date(), this.user?.userName || "", "", "");
  }

  public cancelAddUrlEvent(): void {
    this.isAddingUrlEvent = false;
    this.newUrlEvent = new UrlEvent("", new Date(), this.user?.userName || "", "", "");
  }

  public addUrlEvent(): void {
    if (!this.evenement) return;
    if (!this.evenement.urlEvents) this.evenement.urlEvents = [];

    const typeUrl = (this.newUrlEvent.typeUrl || '').trim();
    const link = (this.newUrlEvent.link || '').trim();
    if (!typeUrl || !link) return;

    const normalizedType = typeUrl.toUpperCase();
    let linkValue = link;
    if (normalizedType === 'PHOTOFROMFS') {
      if (!this.canCreatePhotoFromFsLink()) {
        alert(this.translateService.instant('EVENTUPDT.PHOTOFROMFS_UNAUTHORIZED'));
        return;
      }
      linkValue = this.addYearPrefixIfNeeded(linkValue);
    }

    const urlEvent = new UrlEvent(
      typeUrl,
      new Date(),
      this.user?.userName || this.newUrlEvent.owner || '',
      linkValue,
      (this.newUrlEvent.urlDescription || '').trim()
    );

    this.evenement.urlEvents.push(urlEvent);
    this.persistEventChanges();
    this.cancelAddUrlEvent();
  }

  public startEditUrlEvent(urlEvent: UrlEvent): void {
    if (!this.evenement?.urlEvents) return;
    const idx = this.evenement.urlEvents.indexOf(urlEvent);
    if (idx < 0) return;

    this.editingUrlEventIndex = idx;
    this.editingUrlEvent = new UrlEvent(
      urlEvent.typeUrl,
      urlEvent.dateCreation,
      urlEvent.owner,
      urlEvent.link,
      urlEvent.urlDescription
    );
  }

  public cancelEditUrlEvent(): void {
    this.editingUrlEventIndex = -1;
    this.editingUrlEvent = new UrlEvent("", new Date(), "", "", "");
  }

  public saveUrlEventEdit(): void {
    if (!this.evenement?.urlEvents) return;
    if (this.editingUrlEventIndex < 0 || this.editingUrlEventIndex >= this.evenement.urlEvents.length) return;

    const typeUrl = (this.editingUrlEvent.typeUrl || '').trim();
    const link = (this.editingUrlEvent.link || '').trim();
    if (!typeUrl || !link) return;

    const normalizedType = typeUrl.toUpperCase();
    let linkValue = link;
    if (normalizedType === 'PHOTOFROMFS') {
      if (!this.canCreatePhotoFromFsLink()) {
        alert(this.translateService.instant('EVENTUPDT.PHOTOFROMFS_UNAUTHORIZED'));
        return;
      }
      linkValue = this.addYearPrefixIfNeeded(linkValue);
    }

    const original = this.evenement.urlEvents[this.editingUrlEventIndex];
    original.typeUrl = typeUrl;
    original.link = linkValue;
    original.urlDescription = (this.editingUrlEvent.urlDescription || '').trim();

    this.persistEventChanges();
    this.cancelEditUrlEvent();
  }

  public removeUrlEvent(urlEvent: UrlEvent): void {
    if (!this.evenement?.urlEvents) return;
    const idx = this.evenement.urlEvents.indexOf(urlEvent);
    if (idx < 0) return;

    if (!this.canDeleteUrlEvent(urlEvent)) {
      alert("Vous n'avez pas l'autorisation de supprimer ce lien.");
      return;
    }

    if (!confirm(this.translateService.instant('EVENTHOME.DELETE_LINK_CONFIRM') || 'Supprimer ce lien ?')) {
      return;
    }

    this.evenement.urlEvents.splice(idx, 1);
    this.persistEventChanges();
  }

  public onNewLinkInputChange(value: string): void {
    this.newUrlEvent.link = value;
    const isPhotoFromFs = (this.newUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS';
    if (isPhotoFromFs && value && value.length >= 4) {
      const processed = this.addYearPrefixIfNeeded(value);
      if (processed !== value) {
        setTimeout(() => {
          this.newUrlEvent.link = processed;
        }, 0);
      }
    }
  }

  public onNewLinkBlur(): void {
    const isPhotoFromFs = (this.newUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS';
    if (isPhotoFromFs && this.newUrlEvent.link) {
      this.newUrlEvent.link = this.addYearPrefixIfNeeded(this.newUrlEvent.link);
    }
  }

  public onEditLinkInputChange(value: string): void {
    this.editingUrlEvent.link = value;
    const isPhotoFromFs = (this.editingUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS';
    if (isPhotoFromFs && value && value.length >= 4) {
      const processed = this.addYearPrefixIfNeeded(value);
      if (processed !== value) {
        setTimeout(() => {
          this.editingUrlEvent.link = processed;
        }, 0);
      }
    }
  }

  public onEditLinkBlur(): void {
    const isPhotoFromFs = (this.editingUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS';
    if (isPhotoFromFs && this.editingUrlEvent.link) {
      this.editingUrlEvent.link = this.addYearPrefixIfNeeded(this.editingUrlEvent.link);
    }
  }

  public async selectDirectory(): Promise<void> {
    if ('showDirectoryPicker' in window) {
      try {
        const directoryHandle = await (window as any).showDirectoryPicker();
        const dirName = directoryHandle.name;
        if ((this.newUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS') {
          this.newUrlEvent.link = this.addYearPrefixIfNeeded(dirName);
        } else {
          this.newUrlEvent.link = dirName;
        }
        return;
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          console.error('Error selecting directory:', error);
        }
      }
    }

    if (this.directoryInput?.nativeElement) {
      this.directoryInput.nativeElement.click();
    }
  }

  public onDirectorySelected(event: any): void {
    const files: FileList = event?.target?.files;
    const directoryPath = this.resolveDirectoryPathFromSelection(files);
    if (directoryPath) {
      if ((this.newUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS') {
        this.newUrlEvent.link = this.addYearPrefixIfNeeded(directoryPath);
      } else {
        this.newUrlEvent.link = directoryPath;
      }
    }

    if (event?.target) {
      event.target.value = '';
    }
  }

  public async selectDirectoryForEdit(): Promise<void> {
    if ('showDirectoryPicker' in window) {
      try {
        const directoryHandle = await (window as any).showDirectoryPicker();
        const dirName = directoryHandle.name;
        if ((this.editingUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS') {
          this.editingUrlEvent.link = this.addYearPrefixIfNeeded(dirName);
        } else {
          this.editingUrlEvent.link = dirName;
        }
        return;
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          console.error('Error selecting directory:', error);
        }
      }
    }

    if (this.editDirectoryInput?.nativeElement) {
      this.editDirectoryInput.nativeElement.click();
    }
  }

  public onDirectorySelectedForEdit(event: any): void {
    const files: FileList = event?.target?.files;
    const directoryPath = this.resolveDirectoryPathFromSelection(files);
    if (directoryPath) {
      if ((this.editingUrlEvent.typeUrl || '').trim().toUpperCase() === 'PHOTOFROMFS') {
        this.editingUrlEvent.link = this.addYearPrefixIfNeeded(directoryPath);
      } else {
        this.editingUrlEvent.link = directoryPath;
      }
    }

    if (event?.target) {
      event.target.value = '';
    }
  }

  private addYearPrefixIfNeeded(link: string): string {
    if (!link) return link;
    const trimmedLink = link.trim();
    if (trimmedLink.length < 4) return trimmedLink;

    const firstFour = trimmedLink.substring(0, 4);
    const isYear = /^\d{4}$/.test(firstFour);
    if (isYear) {
      const year = parseInt(firstFour, 10);
      if (year >= 1900 && year <= 2100) {
        const yearWithSlash = firstFour + '/';
        const yearWithBackslash = firstFour + '\\';
        const doubleYear = firstFour + '/' + firstFour;

        if (!trimmedLink.startsWith(yearWithSlash) &&
            !trimmedLink.startsWith(yearWithBackslash) &&
            !trimmedLink.startsWith(doubleYear)) {
          return firstFour + '/' + trimmedLink;
        }
      }
    }

    return trimmedLink;
  }

  // ==============================
  // Helpers: directory path from folder selection (PHOTOFROMFS)
  // Copied from update-evenement to keep identical behavior.
  // ==============================

  private resolveDirectoryPathFromSelection(files: FileList | null | undefined): string {
    if (!files || files.length === 0) {
      return '';
    }

    const fullPath = this.extractFullPathFromFiles(files);
    if (fullPath) {
      return fullPath;
    }

    const relativePath = this.extractRelativeDirectoryFromFiles(files);
    return this.finalizePath(relativePath);
  }

  private extractFullPathFromFiles(files: FileList): string {
    const fileArray = Array.from(files) as any[];

    if (fileArray.length === 0) {
      return '';
    }

    const candidates = fileArray.filter(file => !!(file?.path || file?.mozFullPath));
    if (candidates.length === 0) {
      return '';
    }

    const firstFile = candidates[0];
    const rawFilePath: string = firstFile.path || firstFile.mozFullPath;
    if (!rawFilePath) {
      return '';
    }

    const normalizedFilePath = this.normalizePath(rawFilePath);
    const relativePaths = this.getRelativePaths(fileArray);
    const relativeDirectory = this.getRelativeDirectoryPrefix(relativePaths);
    const firstRelative = this.normalizePath(firstFile.webkitRelativePath || firstFile.name || '');

    let basePath = this.stripSuffix(normalizedFilePath, firstRelative);
    if (!basePath) {
      basePath = this.stripFilenameFromPath(normalizedFilePath);
    }

    if (relativeDirectory) {
      const combined = this.joinPaths(basePath, relativeDirectory);
      return this.finalizePath(combined);
    }

    return this.finalizePath(basePath);
  }

  private getRelativePaths(files: any[]): string[] {
    return files
      .map(file => this.normalizePath(file?.webkitRelativePath || file?.relativePath || file?.name || ''))
      .filter(path => !!path);
  }

  private getRelativeDirectoryPrefix(paths: string[]): string {
    if (paths.length === 0) {
      return '';
    }

    const splitPaths = paths.map(path => path.split('/').filter(segment => segment.length > 0));
    const firstPathParts = splitPaths[0];
    let minLength = firstPathParts.length;

    for (let i = 1; i < splitPaths.length; i++) {
      minLength = Math.min(minLength, splitPaths[i].length);
    }

    const commonParts: string[] = [];

    for (let i = 0; i < minLength; i++) {
      const segment = firstPathParts[i];
      const allMatch = splitPaths.every(parts => parts[i] === segment);
      if (allMatch) {
        commonParts.push(segment);
      } else {
        break;
      }
    }

    // Avoid returning the filename when only one file is present
    if (commonParts.length === firstPathParts.length) {
      commonParts.pop();
    }

    return commonParts.join('/');
  }

  private extractRelativeDirectoryFromFiles(files: FileList): string {
    const relativePaths = this.getRelativePaths(Array.from(files) as any[]);
    const relativeDirectory = this.getRelativeDirectoryPrefix(relativePaths);
    return this.normalizePath(relativeDirectory);
  }

  private stripFilenameFromPath(pathWithFile: string): string {
    if (!pathWithFile) {
      return '';
    }

    const normalized = this.normalizePath(pathWithFile);
    const lastSlash = normalized.lastIndexOf('/');

    if (lastSlash === -1) {
      return normalized;
    }

    return normalized.substring(0, lastSlash);
  }

  private stripSuffix(value: string, suffix: string): string {
    if (!value || !suffix) {
      return value;
    }

    if (!value.endsWith(suffix)) {
      return value;
    }

    return value.substring(0, value.length - suffix.length);
  }

  private normalizePath(path: string): string {
    if (!path) {
      return '';
    }

    const isUnc = path.startsWith('\\\\') || path.startsWith('//');
    let normalized = path.replace(/\\/g, '/');

    if (isUnc) {
      normalized = '//' + normalized.replace(/^\/+/, '');
    } else {
      normalized = normalized.replace(/\/{2,}/g, '/');
    }

    return normalized;
  }

  private joinPaths(base: string, relative: string): string {
    const normalizedBase = this.normalizePath(base).replace(/\/+$/, '');
    const normalizedRelative = this.normalizePath(relative).replace(/^\/+/, '');

    if (!normalizedRelative) {
      return normalizedBase;
    }

    if (!normalizedBase) {
      return normalizedRelative;
    }

    if (normalizedBase.endsWith(':')) {
      return `${normalizedBase}/${normalizedRelative}`;
    }

    return `${normalizedBase}/${normalizedRelative}`;
  }

  private finalizePath(path: string): string {
    if (!path) {
      return '';
    }

    const normalized = this.normalizePath(path);

    if (this.isWindowsPlatform()) {
      if (normalized.startsWith('//')) {
        return '\\\\' + normalized.substring(2).replace(/\//g, '\\');
      }

      return normalized.replace(/\//g, '\\');
    }

    return normalized;
  }

  private isWindowsPlatform(): boolean {
    if (typeof navigator === 'undefined' || !navigator) {
      return false;
    }

    const platform = (navigator as any).userAgentData?.platform || navigator.platform || '';
    return platform.toLowerCase().includes('win');
  }

  // ==============================
  // Commentaries CRUD
  // ==============================

  public canEditCommentary(commentary: Commentary): boolean {
    return !!this.user?.userName && !!commentary?.commentOwner &&
      this.user.userName.toLowerCase() === commentary.commentOwner.toLowerCase();
  }

  public canDeleteCommentary(commentary: Commentary): boolean {
    return this.canEditCommentary(commentary);
  }

  public startAddCommentary(): void {
    if (!this.user) {
      this.user = this.membersService.getUser();
    }
    this.isAddingCommentary = true;
    this.newCommentary = new Commentary(this.user?.userName || "", "", new Date());
  }

  public cancelAddCommentary(): void {
    this.isAddingCommentary = false;
    this.newCommentary = new Commentary(this.user?.userName || "", "", new Date());
  }

  public addCommentary(): void {
    if (!this.evenement) return;
    if (!this.evenement.commentaries) this.evenement.commentaries = [];
    const text = (this.newCommentary.commentary || '').trim();
    if (!text) return;

    const commentary = new Commentary(this.user?.userName || this.newCommentary.commentOwner || '', text, new Date());
    this.evenement.commentaries.push(commentary);
    this.persistEventChanges();
    this.cancelAddCommentary();
  }

  public startEditCommentary(index: number): void {
    if (!this.evenement?.commentaries) return;
    if (index < 0 || index >= this.evenement.commentaries.length) return;

    this.editingCommentaryIndex = index;
    const c = this.evenement.commentaries[index];
    this.editingCommentary = new Commentary(c.commentOwner, c.commentary, c.dateCreation);
  }

  public cancelEditCommentary(): void {
    this.editingCommentaryIndex = -1;
    this.editingCommentary = new Commentary("", "", new Date());
  }

  public saveCommentaryEdit(index: number): void {
    if (!this.evenement?.commentaries) return;
    if (index < 0 || index >= this.evenement.commentaries.length) return;

    const text = (this.editingCommentary.commentary || '').trim();
    if (!text) return;

    this.evenement.commentaries[index].commentary = text;
    this.persistEventChanges();
    this.cancelEditCommentary();
  }

  public deleteCommentary(index: number): void {
    if (!this.evenement?.commentaries) return;
    if (index < 0 || index >= this.evenement.commentaries.length) return;

    const c = this.evenement.commentaries[index];
    if (!this.canDeleteCommentary(c)) {
      alert("Vous n'avez pas l'autorisation de supprimer ce commentaire.");
      return;
    }

    if (!confirm(this.translateService.instant('EVENTHOME.DELETE_COMMENTARY_CONFIRM') || 'Supprimer ce commentaire ?')) {
      return;
    }

    this.evenement.commentaries.splice(index, 1);
    this.persistEventChanges();
  }

  // Prepare photo gallery with comments overlay
  private preparePhotoGallery(): void {
    if (!this.evenement) {
      return;
    }

    // Start with image files from fileUploadeds
    const imageFiles = (this.evenement.fileUploadeds || []).filter(file => this.isImageFile(file.fileName));
    
    // Check if thumbnail exists and is not already in fileUploadeds
    if (this.evenement.thumbnail && 
        this.evenement.thumbnail.fieldId && 
        this.isImageFile(this.evenement.thumbnail.fileName)) {
      // Check if thumbnail is already in fileUploadeds by comparing fieldId
      const isThumbnailInFileUploadeds = imageFiles.some(
        file => file.fieldId === this.evenement!.thumbnail!.fieldId
      );
      
      // If thumbnail is not in fileUploadeds, add it to the beginning of the list
      if (!isThumbnailInFileUploadeds) {
        imageFiles.unshift(this.evenement.thumbnail);
      }
    }
    
    this.photoItems = imageFiles.map(file => ({
      file: file,
      imageUrl: this.getImageUrl(file.fieldId),
      comments: this.getCommentsForFile(file.fieldId)
    }));
    
    // Load images with authentication
    imageFiles.forEach(file => {
      this.loadImageFromFile(file.fieldId);
    });
  }

  // Load image with authentication
  private loadImageFromFile(fileId: string): void {
    const subscription = this.fileService.getFile(fileId).pipe(
      catchError((error) => {
        // Catch ALL errors in the pipe to prevent interceptor from redirecting
        // Log to localStorage FIRST (before console) so it persists even after redirect
        const errorInfo = {
          type: 'image_load_error',
          fileId: fileId,
          status: error?.status,
          statusText: error?.statusText,
          message: error?.message,
          url: error?.url,
          timestamp: new Date().toISOString(),
          fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        };
        
        try {
          localStorage.setItem('last_image_error', JSON.stringify(errorInfo));
        } catch (e) {
          // Ignore storage errors
        }
        
        // Log to console with detailed info
        console.error('[IMAGE LOAD ERROR]', errorInfo);
        
        // Return empty to prevent any redirects
        return EMPTY;
      }),
      map((res: any) => {
        const blob = new Blob([res], { type: 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
      })
    ).subscribe({
      next: (safeUrl: SafeUrl) => {
        // Remove subscription from active set once completed
        this.activeSubscriptions.delete(subscription);
        
        this.imageCache.set(fileId, safeUrl);
        // Update the photoItems with the loaded image
        const photoItem = this.photoItems.find(item => item.file.fieldId === fileId);
        if (photoItem) {
          photoItem.imageUrl = safeUrl;
        }
      },
      error: (error) => {
        // Remove subscription from active set on error
        this.activeSubscriptions.delete(subscription);
          
          // If it's a 401, don't propagate - interceptor will handle redirect
          if (error?.status === 401) {
            // Don't log or propagate - just use default image
            const defaultUrl = ElementEvenementComponent.getDefaultPlaceholderImage(this.sanitizer);
            this.imageCache.set(fileId, defaultUrl);
            const photoItem = this.photoItems.find(item => item.file.fieldId === fileId);
            if (photoItem) {
              photoItem.imageUrl = defaultUrl;
            }
            return;
          }
        
        // Ignore errors caused by cancellation (common when closing modal)
        if (error.name === 'AbortError' || error.status === 0) {
          return; // Silently ignore cancellation errors
        }
        
        console.error('Error loading image:', error);
        // Set default image on error (using cached version)
        const defaultUrl = ElementEvenementComponent.getDefaultPlaceholderImage(this.sanitizer);
        this.imageCache.set(fileId, defaultUrl);
        const photoItem = this.photoItems.find(item => item.file.fieldId === fileId);
        if (photoItem) {
          photoItem.imageUrl = defaultUrl;
        }
      }
    });
    
    // Track this subscription for cleanup
    this.activeSubscriptions.add(subscription);
  }

  // Get image URL (with cache)
  public getImageUrl(fileId: string): SafeUrl {
    if (this.imageCache.has(fileId)) {
      return this.imageCache.get(fileId)!;
    }
    
    // Return default image while loading
    const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
    this.imageCache.set(fileId, defaultUrl);
    return defaultUrl;
  }

  // Get first 5 members for display
  public getFirstMembers(): Member[] {
    if (!this.evenement || !this.evenement.members || !Array.isArray(this.evenement.members)) {
      return [];
    }
    return this.evenement.members
      .filter(member => {
        // Check member exists first before accessing properties
        if (!member || member === null || member === undefined) {
          return false;
        }
        // Then check firstName property exists
        return member.firstName != null && member.firstName !== undefined;
      })
      .slice(0, 5);
  }

  // Get remaining members count
  public getRemainingMembersCount(): number {
    if (!this.evenement || !this.evenement.members || !Array.isArray(this.evenement.members) || this.evenement.members.length <= 5) {
      return 0;
    }
    return this.evenement.members.length - 5;
  }
  
  // Check if event has members
  public hasEventMembers(): boolean {
    return !!(this.evenement?.members && Array.isArray(this.evenement.members) && this.evenement.members.length > 0);
  }

  // Get current friend group
  public getCurrentFriendGroup(): FriendGroup | undefined {
    if (!this.evenement?.friendGroupId || !this.friendGroups) {
      return undefined;
    }
    return this.friendGroups.find(g => g.id === this.evenement!.friendGroupId);
  }

  // Get first friend group members
  public getFirstFriendGroupMembers(): Member[] {
    const friendGroup = this.getCurrentFriendGroup();
    if (!friendGroup?.members || !Array.isArray(friendGroup.members)) {
      return [];
    }
    return friendGroup.members
      .filter(member => {
        // Check member exists first before accessing properties
        if (!member || member === null || member === undefined) {
          return false;
        }
        // Then check firstName property exists
        return member.firstName != null && member.firstName !== undefined;
      })
      .slice(0, 5);
  }

  // Get remaining friend group members count
  public getRemainingFriendGroupMembersCount(): number {
    const friendGroup = this.getCurrentFriendGroup();
    if (!friendGroup?.members) {
      return 0;
    }
    return Math.max(0, friendGroup.members.length - 5);
  }

  // Check if visibility is a friend group
  public isFriendGroupVisibility(): boolean {
    return !!(this.evenement?.friendGroupId && this.getCurrentFriendGroup());
  }

  // Get the event's friend group
  public getEventFriendGroup(): FriendGroup | undefined {
    if (!this.friendGroups || this.friendGroups.length === 0) {
      return undefined;
    }
    
    // First, try to find by friendGroupId
    if (this.evenement?.friendGroupId) {
      const groupById = this.friendGroups.find(g => g.id === this.evenement!.friendGroupId);
      if (groupById) {
        return groupById;
      }
    }
    
    // Fallback: try to find by visibility (if visibility is a friend group name)
    if (this.evenement?.visibility && this.evenement.visibility !== 'public' && 
        this.evenement.visibility !== 'private' && this.evenement.visibility !== 'friends') {
      const groupByVisibility = this.friendGroups.find(g => g.name === this.evenement!.visibility);
      if (groupByVisibility) {
        return groupByVisibility;
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

  // Open discussion maximized
  public openDiscussionMaximized(): void {
    if (!this.evenement?.discussionId) {
      return;
    }

    try {
      const modalRef = this.modalService.open(DiscussionModalComponent, {
        size: 'xl',
        centered: true,
        backdrop: 'static',
        keyboard: true,
        windowClass: 'discussion-maximized-modal',
        scrollable: true
      });
      
      if (modalRef && modalRef.componentInstance) {
        modalRef.componentInstance.discussionId = this.evenement.discussionId;
        modalRef.componentInstance.title = this.evenement.evenementName || 'Discussion';
        
        // Get event color for modal styling
        const eventId = this.evenement.id || '';
        const eventColor = this.eventColorService.getEventColor(eventId);
        if (eventColor) {
          modalRef.componentInstance.eventColor = eventColor;
        }
      }
    } catch (error) {
      console.error('Error opening discussion modal:', error);
    }
  }

  // Open discussion if available
  public openDiscussion(): void {
    if (!this.evenement?.discussionId) {
      return;
    }

    try {
      const modalRef = this.modalService.open(DiscussionModalComponent, {
        size: 'lg',
        centered: true,
        backdrop: 'static',
        keyboard: true,
        windowClass: 'discussion-modal-window'
      });
      
      if (modalRef && modalRef.componentInstance) {
        // Set the discussion ID and title
        modalRef.componentInstance.discussionId = this.evenement.discussionId;
        modalRef.componentInstance.title = this.evenement.evenementName || 'Discussion';
        
        // Get event color for modal styling
        const eventId = this.evenement.id || '';
        const eventColor = this.eventColorService.getEventColor(eventId);
        if (eventColor) {
          modalRef.componentInstance.eventColor = eventColor;
          // Force color application after a short delay to ensure modal is rendered
          setTimeout(() => {
            if (modalRef.componentInstance) {
              modalRef.componentInstance.applyEventColorToModal();
            }
          }, 300);
        }
      } else {
        console.error('Failed to open discussion modal - modalRef or componentInstance is null');
      }
    } catch (error) {
      console.error('Error opening discussion modal:', error);
    }
  }

  // Check if discussion is available
  public hasDiscussion(): boolean {
    return !!(this.evenement?.discussionId);
  }

  // Load discussion messages
  private loadDiscussionMessages(): void {
    if (!this.evenement?.discussionId || this.isLoadingDiscussion) {
      return;
    }

    this.isLoadingDiscussion = true;
    this.discussionError = null;

    this.discussionService.getMessages(this.evenement.discussionId).pipe(
      catchError((error) => {
        // Log to localStorage FIRST so it persists even if redirect happens
        const errorInfo = {
          type: 'discussion_messages_error',
          discussionId: this.evenement?.discussionId,
          status: error?.status,
          statusText: error?.statusText,
          message: error?.message,
          url: error?.url,
          timestamp: new Date().toISOString(),
          fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        };
        
        try {
          localStorage.setItem('last_discussion_messages_error', JSON.stringify(errorInfo));
        } catch (e) {
          // Ignore storage errors
        }
        
        console.error('[DISCUSSION MESSAGES ERROR]', errorInfo);
        
        // Return empty to prevent redirects
        this.discussionError = 'Error loading discussion';
        this.isLoadingDiscussion = false;
        this.discussionMessages = [];
        return EMPTY;
      })
    ).subscribe({
      next: (messages: DiscussionMessage[]) => {
        this.discussionMessages = messages || [];
        this.isLoadingDiscussion = false;
        // Load images for messages that have images
        this.loadDiscussionMessageImages();
        // Scroll to bottom after messages are loaded
        setTimeout(() => this.scrollDiscussionToBottom(), 100);
      },
      error: (error: any) => {
        // Should not reach here as errors are caught in pipe
        // But just in case, handle silently
        this.isLoadingDiscussion = false;
        this.discussionMessages = [];
      }
    });
  }

  // Load images for discussion messages
  private loadDiscussionMessageImages(): void {
    if (!this.evenement?.discussionId) {
      return;
    }

    const discussionId = this.evenement.discussionId;

    this.discussionMessages.forEach((message) => {
      if (message.imageUrl) {
        // ALWAYS extract filename from imageUrl first (it contains the real filename with timestamp)
        // The backend saves files as {timestamp}_{originalFilename}, so imageUrl has the correct name
        // imageFileName only contains the original filename without timestamp
        let realFilename: string | undefined = undefined;
        
        if (message.imageUrl) {
          // Extract the real filename from imageUrl (format: /api/discussions/files/{discussionId}/images/{timestamp}_{realFilename})
        const urlParts = message.imageUrl.split('/');
          realFilename = urlParts.length > 0 ? urlParts[urlParts.length - 1] : undefined;
        }
        
        // Fallback to imageFileName only if imageUrl extraction failed
        if (!realFilename && message.imageFileName) {
          realFilename = message.imageFileName;
        }
        
        if (!realFilename) {
          return;
        }
        
        const cacheKey = `${discussionId}/images/${realFilename}`;
        
        // Skip if already cached
        if (this.discussionFileUrlCache.has(cacheKey)) {
          this.cdr.detectChanges();
          return;
        }

        // Load image with authentication using the real filename from URL
        this.discussionService.getFileUrl(discussionId, 'images', realFilename).pipe(
          catchError((error) => {
            // Catch ALL errors in the pipe to prevent interceptor from redirecting
            // Log to localStorage FIRST (before console) so it persists even after redirect
            const errorInfo = {
              type: 'discussion_image_error',
              filename: realFilename,
              discussionId: discussionId,
              status: error?.status,
              statusText: error?.statusText,
              message: error?.message,
              url: error?.url,
              timestamp: new Date().toISOString(),
              fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
            };
            
            try {
              localStorage.setItem('last_discussion_error', JSON.stringify(errorInfo));
              // Also append to an array to keep history
              const errorHistory = JSON.parse(localStorage.getItem('discussion_image_errors') || '[]');
              errorHistory.push(errorInfo);
              // Keep only last 50 errors
              if (errorHistory.length > 50) {
                errorHistory.shift();
              }
              localStorage.setItem('discussion_image_errors', JSON.stringify(errorHistory));
            } catch (e) {
              // Ignore storage errors
            }
            
            // Log to console with detailed info
            console.error('[DISCUSSION IMAGE LOAD ERROR]', errorInfo);
            
            // Return empty to prevent any redirects
            return EMPTY;
          })
        ).subscribe({
          next: (blobUrl: string) => {
            if (blobUrl) {
            this.discussionFileUrlCache.set(cacheKey, blobUrl);
              // Also fetch and store the blob for slideshow use
              fetch(blobUrl)
                .then(response => response.blob())
                .then(blob => {
                  this.discussionFileBlobCache.set(cacheKey, blob);
                })
                .catch(error => {
                  // Silently fail - blob URL will be re-fetched if needed
                });
            // Trigger change detection to update the view
            this.cdr.detectChanges();
            // Scroll to bottom after image is loaded
            setTimeout(() => this.scrollDiscussionToBottom(), 50);
            }
          },
          error: (error) => {
            // Should not reach here as errors are caught in pipe
            // But just in case, handle silently
          }
        });
      }
      
      if (message.videoUrl) {
        // ALWAYS extract filename from videoUrl first (it contains the real filename with timestamp)
        // The backend saves files as {timestamp}_{originalFilename}, so videoUrl has the correct name
        // videoFileName only contains the original filename without timestamp
        let realFilename: string | undefined = undefined;
        
        if (message.videoUrl) {
          // Extract the real filename from videoUrl (format: /api/discussions/files/{discussionId}/videos/{timestamp}_{realFilename})
        const urlParts = message.videoUrl.split('/');
          realFilename = urlParts.length > 0 ? urlParts[urlParts.length - 1] : undefined;
        }
        
        // Fallback to videoFileName only if videoUrl extraction failed
        if (!realFilename && message.videoFileName) {
          realFilename = message.videoFileName;
        }
        
        if (!realFilename) {
          return;
        }
        
        const cacheKey = `${discussionId}/videos/${realFilename}`;
        
        // Skip if already cached
        if (this.discussionFileUrlCache.has(cacheKey)) {
          this.cdr.detectChanges();
          return;
        }

        // Load video with authentication using the real filename from URL
        this.discussionService.getFileUrl(discussionId, 'videos', realFilename).pipe(
          catchError((error) => {
            // Catch ALL errors in the pipe to prevent interceptor from redirecting
            // Log to localStorage FIRST (before console) so it persists even after redirect
            const errorInfo = {
              type: 'discussion_video_error',
              filename: realFilename,
              discussionId: discussionId,
              status: error?.status,
              statusText: error?.statusText,
              message: error?.message,
              url: error?.url,
              timestamp: new Date().toISOString(),
              fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
            };
            
            try {
              localStorage.setItem('last_discussion_error', JSON.stringify(errorInfo));
              // Also append to an array to keep history
              const errorHistory = JSON.parse(localStorage.getItem('discussion_video_errors') || '[]');
              errorHistory.push(errorInfo);
              // Keep only last 50 errors
              if (errorHistory.length > 50) {
                errorHistory.shift();
              }
              localStorage.setItem('discussion_video_errors', JSON.stringify(errorHistory));
            } catch (e) {
              // Ignore storage errors
            }
            
            // Log to console with detailed info
            console.error('[DISCUSSION VIDEO LOAD ERROR]', errorInfo);
            
            // Return empty to prevent any redirects
            return EMPTY;
          })
        ).subscribe({
          next: (blobUrl: string) => {
            if (blobUrl) {
            this.discussionFileUrlCache.set(cacheKey, blobUrl);
            // Trigger change detection to update the view
            this.cdr.detectChanges();
            // Scroll to bottom after video is loaded
            setTimeout(() => this.scrollDiscussionToBottom(), 50);
            }
          },
          error: (error) => {
            // Should not reach here as errors are caught in pipe
            // But just in case, handle silently
          }
        });
      }
    });
  }

  // Scroll discussion messages container to bottom
  private scrollDiscussionToBottom(): void {
    // Use requestAnimationFrame to ensure DOM is updated
    requestAnimationFrame(() => {
      if (this.discussionMessagesContainer?.nativeElement) {
        const container = this.discussionMessagesContainer.nativeElement;
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  // Format discussion message date
  public formatDiscussionDate(date: Date | undefined): string {
    if (!date) return '';
    
    const messageDate = new Date(date);
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
    
    return messageDate.toLocaleString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // True if the discussion message was authored by the current user (for left/right alignment)
  public isOwnDiscussionMessage(message: DiscussionMessage | null | undefined): boolean {
    const current = this.user?.userName;
    const author = message?.author?.userName;
    if (!current || !author) {
      return false;
    }
    return current.toLowerCase() === author.toLowerCase();
  }

  // Get discussion file URL (returns blob URL with authentication)
  // IMPORTANT: Always use imageUrl to extract the real filename (contains timestamp)
  // The backend saves files as {timestamp}_{originalFilename}, so imageUrl has the correct name
  // imageFileName only contains the original filename without timestamp
  // If imageUrl is provided, extract the real filename from it (PRIORITY)
  public getDiscussionFileUrl(filename: string, subfolder: 'images' | 'videos', imageUrl?: string): string {
    if (!this.evenement?.discussionId || !filename) {
      return '';
    }

    // ALWAYS extract filename from imageUrl first (it contains the real filename with timestamp)
    // The URL format is: /api/discussions/files/{discussionId}/{subfolder}/{timestamp}_{realFilename}
    let realFilename = filename;
    if (imageUrl) {
      const urlParts = imageUrl.split('/');
      if (urlParts.length > 0) {
        realFilename = urlParts[urlParts.length - 1];
      }
    }

    const cacheKey = `${this.evenement.discussionId}/${subfolder}/${realFilename}`;

    // Check cache first
    if (this.discussionFileUrlCache.has(cacheKey)) {
      return this.discussionFileUrlCache.get(cacheKey)!;
    }

    // If not in cache, trigger loading (will be cached when ready)
    this.discussionService.getFileUrl(this.evenement.discussionId, subfolder, realFilename).subscribe({
      next: (blobUrl: string) => {
        this.discussionFileUrlCache.set(cacheKey, blobUrl);
        // Trigger change detection to update the view
        this.cdr.detectChanges();
      },
      error: (error) => {
        // Don't log 401/404 errors as they will trigger redirect via interceptor or are expected
        // Only log other errors to avoid console spam
        if (error?.status !== 401 && error?.status !== 404) {
          console.error('Error loading discussion file:', error);
        }
        // Don't throw or propagate the error to avoid triggering redirects
      }
    });

    return '';
  }
  
  // Check if discussion file URL is available in cache
  // IMPORTANT: Always use imageUrl to extract the real filename (contains timestamp)
  // The backend saves files as {timestamp}_{originalFilename}, so imageUrl has the correct name
  // imageFileName only contains the original filename without timestamp
  // If imageUrl is provided, extract the real filename from it (PRIORITY)
  public hasDiscussionFileUrl(filename: string, subfolder: 'images' | 'videos', imageUrl?: string): boolean {
    if (!this.evenement?.discussionId || !filename) {
      return false;
    }
    
    // ALWAYS extract filename from imageUrl first (it contains the real filename with timestamp)
    // The URL format is: /api/discussions/files/{discussionId}/{subfolder}/{timestamp}_{realFilename}
    let realFilename = filename;
    if (imageUrl) {
      const urlParts = imageUrl.split('/');
      if (urlParts.length > 0) {
        realFilename = urlParts[urlParts.length - 1];
      }
    }
    
    const cacheKey = `${this.evenement.discussionId}/${subfolder}/${realFilename}`;
    return this.discussionFileUrlCache.has(cacheKey);
  }

  // Open image in modal - now opens slideshow with all discussion images
  public openImageInModal(clickedMessage: DiscussionMessage): void {
    if (!clickedMessage || !this.evenement?.discussionId || !this.slideshowModalComponent) {
      return;
    }

    // Collect all discussion messages that have images
    const imageMessages = this.discussionMessages.filter(msg => msg.imageUrl);
    
    if (imageMessages.length === 0) {
      return;
    }

    // Find the clicked image index
    let clickedIndex = 0;
    const discussionId = this.evenement.discussionId;
    
    // Prepare image sources and find clicked index
    const imageSourcesPromises = imageMessages.map(async (message, index) => {
      if (!message.imageUrl || !message.imageFileName) {
        return null;
      }

      // Extract real filename from imageUrl
      const urlParts = message.imageUrl.split('/');
      const realFilename = urlParts.length > 0 ? urlParts[urlParts.length - 1] : message.imageFileName;
      
      const cacheKey = `${discussionId}/images/${realFilename}`;
      
      // Check if this is the clicked message
      if (message === clickedMessage) {
        clickedIndex = index;
      }

      // Get or fetch blob - always create fresh blob URL from stored blob
      let blob: Blob | undefined;

      // Check if blob is cached
      if (this.discussionFileBlobCache.has(cacheKey)) {
        blob = this.discussionFileBlobCache.get(cacheKey);
      } else {
        // Need to fetch the image and store the blob
        blob = await this.fetchDiscussionImageBlob(discussionId, realFilename, cacheKey);
      }

      // Ensure we have a valid blob before creating URL
      if (!blob) {
        return null;
      }

      // At this point, TypeScript knows blob is defined, but we'll be explicit
      const validBlob: Blob = blob;

      // Always create a fresh blob URL from the blob object
      // This ensures the URL is valid even if previous URLs expired
      const blobUrl = URL.createObjectURL(validBlob);

      return {
        blobUrl: blobUrl,
        blob: validBlob, // Store the blob so slideshow can recreate URL if needed
        fileName: message.imageFileName || realFilename
      } as SlideshowImageSource;
    });

    // Wait for all images to be prepared
    Promise.all(imageSourcesPromises).then(imageSources => {
      const validImageSources = imageSources.filter((source): source is SlideshowImageSource => source !== null);
      
      if (validImageSources.length === 0) {
        return;
      }

      // Get event color for slideshow styling
      const eventColor = this.getCalculatedColor();
      
      // Open slideshow with all discussion images
      this.slideshowModalComponent.open(validImageSources, this.evenement!.evenementName, false, 0, eventColor || undefined);
      
      // Set the clicked image as the starting image
      // Use setTimeout to ensure slideshow is fully initialized
      setTimeout(() => {
        if (clickedIndex >= 0 && clickedIndex < validImageSources.length && this.slideshowModalComponent) {
          this.slideshowModalComponent.onThumbnailClick(clickedIndex);
        }
      }, 100);
    });
  }

  // Fetch discussion image blob (returns Promise<Blob | undefined>)
  private async fetchDiscussionImageBlob(discussionId: string, filename: string, cacheKey: string): Promise<Blob | undefined> {
    return new Promise((resolve) => {
      // Always fetch fresh from the service to ensure we have a valid blob
      // Don't try to reuse expired blob URLs
      this.fetchNewDiscussionImageBlob(discussionId, filename, cacheKey, resolve);
    });
  }

  // Helper to fetch a new discussion image blob
  private fetchNewDiscussionImageBlob(discussionId: string, filename: string, cacheKey: string, resolve: (blob: Blob | undefined) => void): void {
    const subscription = this.discussionService.getFileUrl(discussionId, 'images', filename).subscribe({
      next: (blobUrl: string) => {
        // Get the blob from the blob URL
        fetch(blobUrl)
          .then(response => {
            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.blob();
          })
          .then(blob => {
            // Store blob in cache (this is what we really need)
            this.discussionFileBlobCache.set(cacheKey, blob);
            // Also update URL cache for display purposes, but we'll recreate URLs from blobs when needed
            this.discussionFileUrlCache.set(cacheKey, blobUrl);
            resolve(blob);
          })
          .catch(error => {
            console.error('Error fetching blob from URL:', error);
            // If fetch fails, try to get blob from service again
            // This handles cases where blob URL expired immediately
            resolve(undefined);
          });
      },
      error: (error) => {
        if (error?.status !== 401 && error?.status !== 404) {
          console.error('Error loading discussion image:', error);
        }
        resolve(undefined);
      }
    });
    this.trackSubscription(subscription);
  }

  // Add rating plus
  public addRatePlus(): void {
    if (!this.evenement) return;
    
    this.evenement.ratingPlus = (this.evenement.ratingPlus || 0) + 1;
    
    const subscription = this.evenementsService.putEvenement(this.evenement).subscribe({
      next: () => {
        // Rating updated successfully
      },
      error: (error: any) => {
        console.error('Error updating rating:', error);
        // Revert the change on error
        this.evenement!.ratingPlus = Math.max(0, (this.evenement!.ratingPlus || 0) - 1);
      }
    });
    this.trackSubscription(subscription);
  }

  // Add rating minus
  public addRateMinus(): void {
    if (!this.evenement) return;
    
    this.evenement.ratingMinus = (this.evenement.ratingMinus || 0) + 1;
    
    const subscription = this.evenementsService.putEvenement(this.evenement).subscribe({
      next: () => {
        // Rating updated successfully
      },
      error: (error: any) => {
        console.error('Error updating rating:', error);
        // Revert the change on error
        this.evenement!.ratingMinus = Math.max(0, (this.evenement!.ratingMinus || 0) - 1);
      }
    });
    this.trackSubscription(subscription);
  }

  // Calculate overall rating (0-5 stars) based on ratingPlus and ratingMinus
  public getOverallRating(): number {
    if (!this.evenement) return 0;
    
    const plus = this.evenement.ratingPlus || 0;
    const minus = this.evenement.ratingMinus || 0;
    const total = plus + minus;
    
    if (total === 0) return 0;
    
    // Calculate rating: (plus / total) * 5 stars
    // This gives a 0-5 star rating based on the ratio of positive to total votes
    const rating = (plus / total) * 5;
    return Math.min(5, Math.max(0, rating));
  }

  // Get star rating array for display (5 stars, each can be 1, 0.5, or 0)
  public getStarRating(): number[] {
    const overallRating = this.getOverallRating();
    const stars: number[] = [];
    
    for (let i = 0; i < 5; i++) {
      const starValue = overallRating - i;
      if (starValue >= 1) {
        stars.push(1); // Full star
      } else if (starValue >= 0.5) {
        stars.push(0.5); // Half star
      } else {
        stars.push(0); // Empty star
      }
    }
    
    return stars;
  }

  // Get main background image URL for artistic display
  public getMainBackgroundImage(): string {
    if (!this.evenement) {
      return 'url("assets/images/images.jpg")';
    }
    
    // Use thumbnail if available
    if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
      const thumbnailUrl = this.getImageUrl(this.evenement.thumbnail.fieldId);
      const url = (thumbnailUrl as any).changingThisBreaksApplicationSecurity || String(thumbnailUrl);
      if (url && url !== 'assets/images/images.jpg') {
        return `url("${url}")`;
      }
    }
    
    // Use first photo if available
    if (this.photoItemsList && this.photoItemsList.length > 0) {
      const firstPhoto = this.photoItemsList[0];
      const photoUrl = firstPhoto.imageUrl;
      const url = (photoUrl as any).changingThisBreaksApplicationSecurity || String(photoUrl);
      if (url && url !== 'assets/images/images.jpg') {
        return `url("${url}")`;
      }
    }
    
    // Default fallback
    return 'url("assets/images/images.jpg")';
  }


  // Helper to build color string
  private buildColorString(r: number, g: number, b: number, alpha: number = 1): string {
    const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
    const clampedAlpha = Math.max(0, Math.min(1, alpha));
    return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${clampedAlpha})`;
  }

  // Get comments related to a specific file (you might need to implement this logic)
  private getCommentsForFile(fileId: string): Commentary[] {
    if (!this.evenement || !this.evenement.commentaries) {
      return [];
    }
    
    // For now, return all comments - you might want to filter by fileId if you have that relationship
    return this.evenement.commentaries;
  }

  // Get the file url with the bearer token for authentication
  // Returns original file
  public getFileBlobUrl(fileId: string): Observable<any> {
    return this.fileService.getFile(fileId).pipe(
      map((res: any) => {
        const blob = new Blob([res], { type: 'application/octet-stream' });
        return blob;
      })
    );
  }
  
  // Helper method to track and cancel subscriptions
  private trackSubscription(subscription: Subscription): void {
    this.activeSubscriptions.add(subscription);
    subscription.add(() => {
      this.activeSubscriptions.delete(subscription);
    });
  }

  // Format event date with time
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

  // Get event type label
  public getEventTypeLabel(type: string): string {
    const typeMap: { [key: string]: string } = {
      '11': 'EVENTCREATION.TYPE.DOCUMENTS',
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
    
    return typeMap[type] || 'EVENTCREATION.TYPE.OTHER';
  }

  // Get difficulty label
  public getDifficultyLabel(difficulty: string): string {
    const difficultyMap: { [key: string]: string } = {
      '0': 'EVENTCREATION.DIFF.NA',
      '1': 'EVENTCREATION.DIFF.0',
      '2': 'EVENTCREATION.DIFF.1',
      '3': 'EVENTCREATION.DIFF.2',
      '4': 'EVENTCREATION.DIFF.3',
      '5': 'EVENTCREATION.DIFF.4'
    };
    
    return difficultyMap[difficulty] || 'EVENTCREATION.DIFF.NA';
  }

  // Check if file is an image based on extension
  public isImageFile(fileName: string): boolean {
    if (!fileName) return false;
    
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
    const lowerFileName = fileName.toLowerCase();
    
    return imageExtensions.some(ext => lowerFileName.endsWith(ext));
  }

  // Check if file is a video based on extension
  public isVideoFile(fileName: string): boolean {
    if (!fileName) return false;
    
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'];
    const lowerFileName = fileName.toLowerCase();
    
    return videoExtensions.some(ext => lowerFileName.endsWith(ext));
  }

  // Check if file is a PDF based on extension
  public isPdfFile(fileName: string): boolean {
    if (!fileName) return false;
    
    const lowerFileName = fileName.toLowerCase();
    return lowerFileName.endsWith('.pdf');
  }

  // Download file
  public downloadFile(fileId: string, fileName: string): void {
    const subscription = this.getFileBlobUrl(fileId).subscribe({
      next: (blob: any) => {
        this.activeSubscriptions.delete(subscription);
        // IE11 & Edge
        if ((navigator as any).msSaveBlob) {
          (navigator as any).msSaveBlob(blob, fileName);
        } else {
          const natw = this.nativeWindow;
          // In FF link must be added to DOM to be clicked
          const link = natw.document.createElement('a');
          const objectUrl = natw.URL.createObjectURL(blob);
          link.href = objectUrl;
          link.setAttribute('download', fileName);
          natw.document.body.appendChild(link);
          link.click();
          
          // Remove the link after a delay
          setTimeout(() => {
            natw.document.body.removeChild(link);
            natw.URL.revokeObjectURL(objectUrl);
          }, 5000);
        }
      },
      error: (error) => {
        this.activeSubscriptions.delete(subscription);
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error downloading file:', error);
        }
      }
    });
    this.trackSubscription(subscription);
  }

  // Open PDF file in new tab
  public openPdfFile(fileId: string, fileName: string): void {
    const subscription = this.getFileBlobUrl(fileId).subscribe({
      next: (blob: any) => {
        this.activeSubscriptions.delete(subscription);
        // Create a new blob with proper MIME type for PDF
        const pdfBlob = new Blob([blob], { type: 'application/pdf' });
        
        // Create object URL for the blob
        const objectUrl = URL.createObjectURL(pdfBlob);
        
        // Open PDF in new tab
        const newWindow = window.open(objectUrl, '_blank', 'width=1200,height=800,scrollbars=yes,resizable=yes,toolbar=yes,menubar=yes');
        
        // Focus the new window
        if (newWindow) {
          newWindow.focus();
        }
        
        // Clean up the URL after a delay
        setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 10000);
      },
      error: (error) => {
        this.activeSubscriptions.delete(subscription);
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error loading PDF file:', error);
          alert('Erreur lors du chargement du fichier PDF');
        }
      }
    });
    this.trackSubscription(subscription);
  }

  // Handle file click based on file type
  public handleFileClick(uploadedFile: UploadedFile): void {
    if (this.isImageFile(uploadedFile.fileName)) {
      this.openSingleImageInSlideshow(uploadedFile.fieldId, uploadedFile.fileName);
    } else if (this.isPdfFile(uploadedFile.fileName)) {
      this.openPdfFile(uploadedFile.fieldId, uploadedFile.fileName);
    } else {
      // For other files, download them
      this.downloadFile(uploadedFile.fieldId, uploadedFile.fileName);
    }
  }

  // Open image modal
  public openImageModal(fileId: string, fileName: string): void {
    this.setupFullscreenListener();
    const subscription = this.getFileBlobUrl(fileId).subscribe({
      next: (blob: any) => {
        this.activeSubscriptions.delete(subscription);
        const objectUrl = URL.createObjectURL(blob);
        this.selectedImageUrl = objectUrl;
        this.selectedImageAlt = fileName;
        
        if (this.imageModal) {
          this.modalService.open(this.imageModal, { 
            size: 'xl', 
            centered: true,
            backdrop: 'static',
            keyboard: false,
            animation: true,
            windowClass: 'modal-image-fullscreen'
          }).result.then(
            () => {},
            () => {}
          );
        }
      },
      error: (error) => {
        this.activeSubscriptions.delete(subscription);
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error loading image:', error);
          alert('Erreur lors du chargement de l\'image');
        }
      }
    });
    this.trackSubscription(subscription);
  }

  // Photo gallery navigation
  public nextPhoto(): void {
    if (this.photoItemsList.length > 0) {
      this.currentPhotoIndex = (this.currentPhotoIndex + 1) % this.photoItemsList.length;
    }
  }

  public prevPhoto(): void {
    if (this.photoItemsList.length > 0) {
      this.currentPhotoIndex = this.currentPhotoIndex === 0 ? this.photoItemsList.length - 1 : this.currentPhotoIndex - 1;
    }
  }

  public goToPhoto(index: number): void {
    if (index >= 0 && index < this.photoItemsList.length) {
      this.currentPhotoIndex = index;
    }
  }

  // Navigate back
  public goBack(): void {
    this.router.navigate(['/even']);
  }

  // Handle image load - detect portrait orientation
  public onImageLoad(event: any): void {
    const target = event.target as HTMLImageElement;
    if (target) {
      const naturalHeight = target.naturalHeight;
      const naturalWidth = target.naturalWidth;
      
      // If image is portrait (height > width), add class to constrain height
      if (naturalHeight > naturalWidth) {
        target.classList.add('portrait-image');
        // Also add class to parent frame
        const frame = target.closest('.photo-frame');
        if (frame) {
          frame.classList.add('portrait-frame');
        }
      }
    }
  }

  // Handle image error
  public onImageError(event: any): void {
    const target = event.target as HTMLImageElement;
    if (target) {
      target.src = ElementEvenementComponent.getDefaultPlaceholderImageUrl(); // Fallback image
    }
  }

  // Handle video successfully loaded
  public onVideoLoaded(event: any, videoFile: UploadedFile): void {
    // Mark this video as successfully loaded
    if (videoFile?.fieldId) {
      this.videoLoadSuccess.add(videoFile.fieldId);
    }
  }

  // Handle video loading errors
  public onVideoError(event: any, videoFile: UploadedFile): void {
    const videoElement = event.target as HTMLVideoElement;
    
    if (!videoElement || !videoFile?.fieldId) {
      return;
    }
    
    // If video already loaded successfully, ignore this error (might be a false positive)
    if (this.videoLoadSuccess.has(videoFile.fieldId)) {
      return;
    }
    
    // Check if video URL is actually available in our cache
    // If not, the video element shouldn't have been rendered (hasVideoUrl check)
    // But if it was, don't log error - it's just waiting for the URL to load
    if (!this.hasVideoUrl(videoFile)) {
      // Video URL not loaded yet - don't log error, it will load when ready
      return;
    }
    
    // Check if video has a valid source - if src is empty or invalid, it might just be loading
    const videoSrc = videoElement.src || videoElement.currentSrc;
    if (!videoSrc || videoSrc === '' || videoSrc === window.location.href) {
      // No valid source yet - might be waiting for blob URL to be set
      // Don't log error yet, wait a bit for the source to be set
      setTimeout(() => {
        // Check again after delay
        if (videoElement && !this.videoLoadSuccess.has(videoFile.fieldId)) {
          const delayedSrc = videoElement.src || videoElement.currentSrc;
          const delayedNetworkState = videoElement.networkState;
          
          // Only log if still no source and in error state AND we have the URL in cache
          if (this.hasVideoUrl(videoFile) && 
              (!delayedSrc || delayedSrc === '' || delayedSrc === window.location.href) && 
              delayedNetworkState === 3) {
            console.error('Error loading video - no source found:', videoFile.fileName);
          }
        }
      }, 1000);
      return;
    }
    
    // Check if this is actually an error or just a loading issue
    // networkState values:
    // 0 = NETWORK_EMPTY - no data loaded yet (initial state)
    // 1 = NETWORK_IDLE - loaded and ready
    // 2 = NETWORK_LOADING - currently loading
    // 3 = NETWORK_NO_SOURCE - no source found (actual error)
    
    const networkState = videoElement.networkState;
    
    // Only log if it's a real error (no source found) AND we have a valid src
    // Don't log if it's just initializing (NETWORK_EMPTY) or still loading
    if (networkState === 3) { // NETWORK_NO_SOURCE
      // Wait a bit to see if video recovers or loads successfully
      // This handles timing issues where blob URL hasn't loaded yet
      setTimeout(() => {
        // Check if video loaded successfully in the meantime
        if (this.videoLoadSuccess.has(videoFile.fieldId)) {
          return; // Video loaded successfully - don't log
        }
        
        if (!videoElement) {
          return;
        }
        
        const finalNetworkState = videoElement.networkState;
        const finalSrc = videoElement.src || videoElement.currentSrc;
        const readyState = videoElement.readyState;
        
        // Only log if:
        // 1. Still in error state after delay
        // 2. We have a valid src (meaning it tried to load but failed)
        // 3. Video has no data loaded (readyState === 0 means HAVE_NOTHING)
        // 4. Video hasn't been marked as successfully loaded
        if (finalNetworkState === 3 && 
            finalSrc && finalSrc !== '' && finalSrc !== window.location.href &&
            readyState === 0) { // HAVE_NOTHING - no data loaded at all
          // This is likely a real error - no data loaded
          console.error('Error loading video - no source found:', videoFile.fileName);
        }
        // If readyState > 0, it means some data was loaded, so video is working - don't log
      }, 3000); // Wait 3 seconds to give blob URL time to load
    } else if (networkState === 2) { // NETWORK_LOADING
      // Still loading - might be a temporary issue, wait a bit before logging
      // Use a timeout to check if it eventually fails
      setTimeout(() => {
        // Check again after delay - if still in error state and not marked as successful, it's a real error
        if (videoElement && videoElement.networkState === 3 && !this.videoLoadSuccess.has(videoFile.fieldId)) {
          const finalSrc = videoElement.src || videoElement.currentSrc;
          if (finalSrc && finalSrc !== '' && finalSrc !== window.location.href) {
            console.error('Error loading video after retry:', videoFile.fileName);
          }
        }
        // If video loaded successfully in the meantime, it will be in videoLoadSuccess set - don't log
      }, 3000);
    }
    // If networkState is 0 (NETWORK_EMPTY) or 1 (NETWORK_IDLE), don't log - it's either initializing or loaded successfully
  }

  // Get URL type label
  public getUrlTypeLabel(typeId: string): string {
    const normalizedType = typeId?.trim().toUpperCase() || 'OTHER';
    
    const urlEventTypes = [
      {id: "MAP", label: "EVENTHOME.URL_TYPE_CARTE", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
      {id: "DOCUMENTATION", label: "EVENTHOME.URL_TYPE_DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
      {id: "OTHER", label: "EVENTHOME.URL_TYPE_OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]},
      {id: "PHOTOS", label: "EVENTHOME.URL_TYPE_PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
      {id: "PHOTOFROMFS", label: "EVENTHOME.URL_TYPE_PHOTOFROMFS", aliases: ["PHOTO FS", "PHOTO FROM FS", "DISK PHOTO", "FICHIER"]},
      {id: "VIDEO", label: "EVENTHOME.URL_TYPE_VIDEO", aliases: ["VIDEO", "VIDÉO", "YOUTUBE", "VIMEO"]},
      {id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]},
      {id: "WHATSAPP", label: "EVENTHOME.URL_TYPE_WHATSAPP", aliases: ["WA", "WHATS", "واتساب"]}
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

  // Get URL event icon based on urlEvent object
  public getUrlEventIcon(urlEvent: any): string {
    if (!urlEvent || !urlEvent.typeUrl) {
      return 'fa fa-external-link';
    }
    return this.getUrlTypeIcon(urlEvent.typeUrl);
  }

  // Get URL type icon
  public getUrlTypeIcon(typeId: string): string {
    const normalizedType = typeId?.trim().toUpperCase() || 'OTHER';
    
    // Check for MAP - handle both "MAP" and "CARTE" (French)
    if (normalizedType === 'MAP' || normalizedType === 'CARTE') {
      return 'fa fa-map';
    }
    
    // Check for WEBSITE aliases
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
    return 'fa fa-folder';
  }

  // Group URLs by type for better display
  public getGroupedUrlEvents(): { [key: string]: any[] } {
    if (!this.evenement || !this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
      return {};
    }
    
    return this.evenement.urlEvents.reduce((groups: { [key: string]: any[] }, urlEvent) => {
      const normalizedType = this.normalizeTypeForGrouping(urlEvent.typeUrl || 'OTHER');
      if (!groups[normalizedType]) {
        groups[normalizedType] = [];
      }
      groups[normalizedType].push(urlEvent);
      return groups;
    }, {});
  }

  // Normalize type for grouping
  private normalizeTypeForGrouping(typeId: string): string {
    const normalizedType = typeId?.trim().toUpperCase() || 'OTHER';
    
    // Order matters: more specific types should be checked first
    const urlEventTypes = [
      {id: "PHOTOFROMFS", aliases: ["PHOTO FS", "PHOTO FROM FS", "DISK PHOTO", "FICHIER"]}, // Check PHOTOFROMFS before PHOTOS
      {id: "MAP", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
      {id: "DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
      {id: "PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
      {id: "VIDEO", aliases: ["VIDEO", "VIDÉO", "YOUTUBE", "VIMEO"]},
      {id: "WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]},
      {id: "OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]}
    ];
    
    // Search first by exact ID
    let type = urlEventTypes.find(t => t.id === normalizedType);
    
    // If not found, search in aliases (exact match)
    if (!type) {
      type = urlEventTypes.find(t => 
        t.aliases.some(alias => alias.toUpperCase() === normalizedType)
      );
    }
    
    // If still not found, search for partial match (check more specific types first)
    if (!type) {
      // Check if normalizedType contains any type ID or alias
      for (const urlType of urlEventTypes) {
        // Check if normalizedType contains the type ID
        if (normalizedType.includes(urlType.id) || urlType.id.includes(normalizedType)) {
          type = urlType;
          break;
        }
        // Check if normalizedType contains any alias
        if (urlType.aliases.some(alias => 
          normalizedType.includes(alias.toUpperCase()) || 
          alias.toUpperCase().includes(normalizedType)
        )) {
          type = urlType;
          break;
        }
      }
    }
    
    return type ? type.id : 'OTHER';
  }

  // Get sorted type keys for consistent display order
  public getSortedTypeKeys(): string[] {
    const grouped = this.getGroupedUrlEvents();
    const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'VIDEO', 'PHOTOS', 'PHOTOFROMFS', 'OTHER'];
    return typeOrder.filter(type => grouped[type] && grouped[type].length > 0);
  }

  // Format commentary date
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

  // Get event comments sorted by date
  public getEventComments(): Commentary[] {
    if (!this.evenement || !this.evenement.commentaries || this.evenement.commentaries.length === 0) {
      return [];
    }
    
    // Sort comments by creation date descending (most recent first)
    return this.evenement.commentaries.sort((a, b) => {
      const dateA = new Date(a.dateCreation).getTime();
      const dateB = new Date(b.dateCreation).getTime();
      return dateB - dateA;
    });
  }

  // Dynamic sizing for the comments card (grid-row span)
  public getCommentsCardSpanClass(): string {
    const count = this.getEventComments().length;
    if (count <= 0) return 'comments-span-1';
    if (count <= 2) return 'comments-span-1';
    if (count <= 6) return 'comments-span-2';
    return 'comments-span-3';
  }

  // ==============================
  // "Smart" layout helpers for grid packing
  // (order + row/col span) based on content.
  // ==============================

  private clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  }

  private spanRowClass(span: number): string {
    return `span-row-${this.clamp(span, 1, 3)}`;
  }

  private spanColClass(span: number): string {
    return `span-col-${this.clamp(span, 1, 2)}`;
  }

  public getCardLayoutClasses(cardId: 'discussion' | 'photos' | 'urls' | 'comments' | 'pdfs' | 'upload'): string[] {
    const urlsCount = this.evenement?.urlEvents?.length || 0;
    const commentsCount = this.getEventComments().length;
    const photosCount = this.photoItemsList?.length || 0;
    const pdfCount = this.getPdfFiles().length;

    switch (cardId) {
      case 'photos': {
        // photos are very visual -> keep large; more photos => bigger
        const rowSpan = photosCount > 8 ? 3 : 2;
        const colSpan = 2;
        return [this.spanRowClass(rowSpan), this.spanColClass(colSpan)];
      }
      case 'discussion': {
        // discussion benefits from space; if a lot of messages, keep large
        const rowSpan = this.discussionMessages.length > 6 ? 3 : 2;
        const colSpan = 2;
        return [this.spanRowClass(rowSpan), this.spanColClass(colSpan)];
      }
      case 'urls': {
        // few links -> small; many -> bigger
        const rowSpan = urlsCount === 0 ? 1 : (urlsCount <= 4 ? 1 : 2);
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'comments': {
        // few comments -> small; many -> bigger
        const rowSpan = commentsCount <= 2 ? 1 : (commentsCount <= 6 ? 2 : 3);
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'pdfs': {
        const rowSpan = pdfCount <= 2 ? 1 : 2;
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'upload': {
        return [this.spanRowClass(1), this.spanColClass(1)];
      }
      default:
        return [];
    }
  }

  public getCardOrder(cardId: 'discussion' | 'photos' | 'urls' | 'comments' | 'pdfs' | 'upload'): number {
    // Smaller number = earlier placement; grid-auto-flow:dense will pack.
    const photosCount = this.photoItemsList?.length || 0;
    const urlsCount = this.evenement?.urlEvents?.length || 0;
    const commentsCount = this.getEventComments().length;

    switch (cardId) {
      case 'photos':
        return photosCount > 0 ? 20 : 80;
      case 'discussion':
        return this.hasDiscussion() ? 25 : 90;
      case 'urls':
        return urlsCount > 0 ? 40 : 85;
      case 'comments':
        return commentsCount > 0 ? 45 : 88;
      case 'pdfs':
        return this.getPdfFiles().length > 0 ? 55 : 95;
      case 'upload':
        return 70;
      default:
        return 99;
    }
  }

  // Get non-image files
  public getNonImageFiles(): UploadedFile[] {
    if (!this.evenement || !this.evenement.fileUploadeds) {
      return [];
    }
    
    return this.evenement.fileUploadeds.filter(file => !this.isImageFile(file.fileName));
  }

  // Website content management
  private expandedWebsites = new Set<string>();
  private websiteMetadata = new Map<string, {title: string, description: string}>();

  // Toggle website content display
  public toggleWebsiteContent(url: string): void {
    if (this.expandedWebsites.has(url)) {
      this.expandedWebsites.delete(url);
    } else {
      this.expandedWebsites.add(url);
    }
  }

  // Get website title - always returns translated value
  public getWebsiteTitle(url: string): string {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.replace('www.', '');
      return hostname.charAt(0).toUpperCase() + hostname.slice(1);
    } catch (error) {
      return this.translateService.instant('EVENTELEM.WEBSITE_TITLE');
    }
  }

  // Get website description - always returns translated value
  public getWebsiteDescription(url: string): string {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.replace('www.', '');
      return `${this.translateService.instant('EVENTELEM.WEBSITE_OF')} ${hostname}`;
    } catch (error) {
      return this.translateService.instant('EVENTELEM.WEBSITE_LINK_DESCRIPTION');
    }
  }

  // Check if website is expanded
  public isWebsiteExpanded(url: string): boolean {
    return this.expandedWebsites.has(url);
  }

  // PDF Documents Management

  // Get PDF files
  public getPdfFiles(): UploadedFile[] {
    if (!this.evenement?.fileUploadeds) {
      return [];
    }
    return this.evenement.fileUploadeds.filter(file => 
      file.fileName.toLowerCase().endsWith('.pdf')
    );
  }

  // Check if current user is the uploader/owner of a file
  public isFileOwner(uploaderMember?: Member | null): boolean {
    return !!this.user?.userName && !!uploaderMember?.userName &&
      this.user.userName.toLowerCase() === uploaderMember.userName.toLowerCase();
  }

  // Extract a displayable upload/creation date from an uploaded file (backend fields vary)
  public getUploadedFileDate(file: any): any | null {
    if (!file) return null;
    return (
      file.dateCreation ||
      file.uploadDate ||
      file.dateUpload ||
      file.createdAt ||
      file.created_on ||
      null
    );
  }

  // Delete an uploaded file linked to the event (same flow as element-evenement)
  public delFile(fieldId: string): void {
    if (!this.evenement || !this.user) {
      return;
    }

    const fileToDelete = this.evenement.fileUploadeds?.find(f => f.fieldId === fieldId);
    if (!fileToDelete) {
      return;
    }

    // Permission guard (UI already hides button, but keep a hard check)
    if (!this.isFileOwner(fileToDelete.uploaderMember)) {
      alert("Vous n'avez pas l'autorisation de supprimer ce fichier.");
      return;
    }

    const confirmMsg =
      this.translateService.instant('EVENTELEM.DELETEFILE_CONFIRM') ||
      this.translateService.instant('EVENTELEM.DELETEFILE') ||
      'Supprimer ce fichier ?';

    if (!confirm(confirmMsg)) {
      return;
    }

    const evenementToUpdate: any = { ...this.evenement };
    evenementToUpdate.fileUploadeds = (this.evenement.fileUploadeds || []).filter(f => f.fieldId !== fieldId);

    const updateSubscription = this.fileService.updateFile(evenementToUpdate, this.user).subscribe({
      next: () => {
        // Update local state
        this.evenement!.fileUploadeds = evenementToUpdate.fileUploadeds;

        // If deleted file was a video, remove cached URL
        if (this.videoUrls.has(fieldId)) {
          this.videoUrls.delete(fieldId);
        }
        if (this.videoUrlCache.has(fieldId)) {
          this.videoUrlCache.delete(fieldId);
        }

        // Trigger UI refresh
        this.cdr.detectChanges();
      },
      error: (error: any) => {
        console.error('Error deleting file from MongoDB:', error);
        alert('Error deleting file from database. Please try again.');
      }
    });

    this.activeSubscriptions.add(updateSubscription);
  }

  // Get video files
  public getVideoFiles(): UploadedFile[] {
    if (!this.evenement?.fileUploadeds) {
      return [];
    }
    return this.evenement.fileUploadeds.filter(file => this.isVideoFile(file.fileName));
  }

  // Load all video URLs
  private loadVideoUrls(): void {
    const videoFiles = this.getVideoFiles();
    
    if (videoFiles.length === 0) {
      return;
    }
    
    videoFiles.forEach((file) => {
      if (!file?.fieldId) {
        return;
      }
      
      // Check cache first
      if (this.videoUrlCache.has(file.fieldId)) {
        const cachedUrl = this.videoUrlCache.get(file.fieldId);
        if (cachedUrl) {
          this.videoUrls.set(file.fieldId, cachedUrl);
          this.cdr.detectChanges();
        }
        return;
      }
      
      // Load video and create blob URL with correct MIME type
      // Use catchError in pipe to prevent errors from triggering redirects
      this.fileService.getFile(file.fieldId).pipe(
        catchError((error) => {
          // Catch ALL errors in the pipe to prevent interceptor from redirecting
          // Log to localStorage FIRST (before console) so it persists even after redirect
          const errorInfo = {
            type: 'video_load_error',
            fileName: file.fileName,
            fieldId: file.fieldId,
            status: error?.status,
            statusText: error?.statusText,
            message: error?.message,
            url: error?.url,
            timestamp: new Date().toISOString(),
            fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
          };
          
          try {
            localStorage.setItem('last_video_error', JSON.stringify(errorInfo));
            // Also append to an array to keep history
            const errorHistory = JSON.parse(localStorage.getItem('video_error_history') || '[]');
            errorHistory.push(errorInfo);
            // Keep only last 20 errors
            if (errorHistory.length > 20) {
              errorHistory.shift();
            }
            localStorage.setItem('video_error_history', JSON.stringify(errorHistory));
          } catch (e) {
            // Ignore storage errors
          }
          
          // Log to console with detailed info
          console.error('[VIDEO LOAD ERROR]', errorInfo);
          
          // Return empty to prevent any redirects
          // Videos will just not load, which is better than redirecting
          return EMPTY;
        })
      ).subscribe({
        next: (blob: Blob) => {
          if (!blob || blob.size === 0) {
            return;
          }
          
          // Determine video MIME type from file extension
          let videoType = 'video/mp4'; // default
          const fileName = file.fileName.toLowerCase();
          if (fileName.endsWith('.webm')) {
            videoType = 'video/webm';
          } else if (fileName.endsWith('.ogg') || fileName.endsWith('.ogv')) {
            videoType = 'video/ogg';
          } else if (fileName.endsWith('.mov')) {
            videoType = 'video/quicktime';
          } else if (fileName.endsWith('.avi')) {
            videoType = 'video/x-msvideo';
          } else if (fileName.endsWith('.wmv')) {
            videoType = 'video/x-ms-wmv';
          } else if (fileName.endsWith('.flv')) {
            videoType = 'video/x-flv';
          } else if (fileName.endsWith('.mkv')) {
            videoType = 'video/x-matroska';
          } else if (fileName.endsWith('.m4v') || fileName.endsWith('.3gp')) {
            videoType = 'video/mp4';
          }
          
          // Create a new blob with the correct MIME type if the current type is wrong
          let videoBlob = blob;
          if (blob.type !== videoType && (blob.type === 'application/octet-stream' || !blob.type)) {
            videoBlob = new Blob([blob], { type: videoType });
          }
          
          const blobUrl = URL.createObjectURL(videoBlob);
          const safeUrl = this.sanitizer.bypassSecurityTrustUrl(blobUrl);
          this.videoUrlCache.set(file.fieldId, safeUrl);
          this.videoUrls.set(file.fieldId, safeUrl);
          this.cdr.detectChanges();
        },
        error: (error) => {
          // Only non-401 errors reach here (401s are caught in pipe)
          // Ignore cancellation errors
          if (error.name === 'AbortError' || error.status === 0) {
            return;
          }
        }
      });
    });
  }

  // Get video URL for playback (from loaded URLs)
  public getVideoUrl(file: UploadedFile): SafeUrl {
    if (!file?.fieldId) {
      return this.sanitizer.bypassSecurityTrustUrl('');
    }
    
    // Return from loaded URLs map
    return this.videoUrls.get(file.fieldId) || this.sanitizer.bypassSecurityTrustUrl('');
  }

  // Check if video URL is available
  public hasVideoUrl(file: UploadedFile): boolean {
    if (!file?.fieldId) {
      return false;
    }
    return this.videoUrls.has(file.fieldId);
  }

  // Open PDF in new tab (same method as element-evenement)
  public openPdfInPage(pdfFile: UploadedFile): void {
    this.getFileBlobUrl(pdfFile.fieldId).subscribe({
      next: (blob: any) => {
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
      },
      error: (error) => {
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error loading PDF file:', error);
        }
      }
    });
  }

  // Download PDF file (same method as element-evenement)
  public downloadPdf(pdfFile: UploadedFile): void {
    this.getFileBlobUrl(pdfFile.fieldId).subscribe({
      next: (blob: any) => {
        // Create a new blob with proper MIME type for PDF
        const pdfBlob = new Blob([blob], { type: 'application/pdf' });
        
        // Create object URL for the blob
        const objectUrl = URL.createObjectURL(pdfBlob);
        
        // Create a temporary anchor element for download
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = pdfFile.fileName;
        link.style.display = 'none';
        
        // Append to body, click, and remove
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up the URL after a delay
        setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 1000);
      },
      error: (error) => {
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error downloading PDF file:', error);
        }
      }
    });
  }

  // Get file URL for download
  public getFileUrl(file: UploadedFile): string {
    return `${environment.API_URL4FILE}/${file.fileName}`;
  }

  // Copy URL to clipboard
  public copyUrlToClipboard(url: string): void {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        // You could add a toast notification here
      });
    } else {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
  }

  public sendEmail(email: string): void {
    window.open(`mailto:${email}`, '_blank');
  }

  // Toggle fullscreen mode (same as element-evenement - works for both image modal and slideshow)
  public toggleFullscreen(): void {
    // Use slideshow-container to include both image and controls (same as element-evenement)
    const slideshowContainer = document.querySelector('.slideshow-container');
    const slideshowImageWrapper = document.querySelector('.slideshow-image-wrapper');
    const imageElement = slideshowContainer || slideshowImageWrapper || document.querySelector('.modal-image');
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

  // =========================
  // Photo From FS integration
  // =========================

  // Open a single image in slideshow modal
  // Open all photos in maximized slideshow
  public openPhotosMaximized(startIndex: number = 0): void {
    if (!this.slideshowModalComponent || !this.evenement || this.photoItemsList.length === 0) {
      return;
    }
    
    // Convert photoItems to SlideshowImageSource array
    const imageSources: SlideshowImageSource[] = this.photoItemsList.map(photoItem => ({
      fileId: photoItem.file.fieldId,
      blobUrl: undefined,
      fileName: photoItem.file.fileName
    }));
    
    // Get event color for slideshow styling
    const eventColor = this.getCalculatedColor();
    
    this.slideshowModalComponent.open(imageSources, this.evenement.evenementName, true, 0, eventColor || undefined);
    
    // Set the starting image index if provided
    if (startIndex >= 0 && startIndex < imageSources.length) {
      setTimeout(() => {
        if (this.slideshowModalComponent) {
          this.slideshowModalComponent.onThumbnailClick(startIndex);
        }
      }, 100);
    }
  }

  public openSingleImageInSlideshow(fileId: string, fileName: string): void {
    if (!this.slideshowModalComponent || !this.evenement) {
      console.error('Slideshow modal component or event not available');
      return;
    }
    
    // Prepare image source for the clicked image
    const imageSource: SlideshowImageSource = {
      fileId: fileId,
      blobUrl: undefined,
      fileName: fileName
    };

    // Open the slideshow modal with just this one image
    // Get event color for slideshow styling
    const eventColor = this.getCalculatedColor();
    
    this.slideshowModalComponent.open([imageSource], this.evenement.evenementName, true, 0, eventColor || undefined);
  }

  // Check if URL event is PHOTOFROMFS type
  public isPhotoFromFs(urlEvent: UrlEvent): boolean {
    return (urlEvent.typeUrl || '').toUpperCase().trim() === 'PHOTOFROMFS';
  }

  // Get styles for event title with calculated color background
  public getEventTitleStyles(): { [key: string]: string } {
    if (!this.evenement) {
      return {};
    }

    const eventId = this.evenement.id || '';
    let eventColor = this.eventColorService.getEventColor(eventId);
    
    // If color not found, try with evenementName as fallback
    if (!eventColor && this.evenement.evenementName) {
      eventColor = this.eventColorService.getEventColor(this.evenement.evenementName);
    }

    if (!eventColor) {
      // Default styles if no color found
      return {
        'background-color': 'rgba(40, 167, 69, 0.6)',
        'color': '#ffffff',
        'padding': '0.5rem 1rem',
        'border-radius': '8px',
        'display': 'inline-block'
      };
    }

    // Calculate brightness to determine text color
    const brightness = (0.299 * eventColor.r + 0.587 * eventColor.g + 0.114 * eventColor.b);
    const isBright = brightness > 128;
    const textColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';

    // Create gradient background with event color
    const bgR1 = Math.min(255, eventColor.r + 20);
    const bgG1 = Math.min(255, eventColor.g + 20);
    const bgB1 = Math.min(255, eventColor.b + 20);
    const bgR2 = Math.max(0, eventColor.r - 10);
    const bgG2 = Math.max(0, eventColor.g - 10);
    const bgB2 = Math.max(0, eventColor.b - 10);

    return {
      'background': `linear-gradient(135deg, rgba(${bgR1}, ${bgG1}, ${bgB1}, 0.8) 0%, rgba(${bgR2}, ${bgG2}, ${bgB2}, 0.8) 100%)`,
      'color': textColor,
      'padding': '0.5rem 1rem',
      'border-radius': '8px',
      'display': 'inline-block',
      'box-shadow': `0 2px 8px rgba(${eventColor.r}, ${eventColor.g}, ${eventColor.b}, 0.3)`
    };
  }

  // Get calculated color for display
  public getCalculatedColor(): { r: number; g: number; b: number } | null {
    if (!this.evenement) {
      return null;
    }

    const eventId = this.evenement.id || '';
    let eventColor = this.eventColorService.getEventColor(eventId);
    
    // If color not found, try with evenementName as fallback
    if (!eventColor && this.evenement.evenementName) {
      eventColor = this.eventColorService.getEventColor(this.evenement.evenementName);
    }

    return eventColor;
  }

  // Get styles for color badge
  public getColorBadgeStyles(): { [key: string]: string } {
    const color = this.getCalculatedColor();
    if (!color) {
      return {};
    }

    // Calculate brightness to determine text color
    const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
    const isBright = brightness > 128;
    const textColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';

    return {
      'background-color': `rgba(${color.r}, ${color.g}, ${color.b}, 0.9)`,
      'color': textColor,
      'padding': '0.25rem 0.5rem',
      'border-radius': '4px',
      'font-size': '0.75rem',
      'font-weight': '600',
      'margin-left': '0.75rem',
      'display': 'inline-block',
      'vertical-align': 'middle'
    };
  }

  public openFsPhotosDiaporama(relativePath: string, compress: boolean = true): void {
    // Open slideshow modal immediately with empty array - images will be loaded dynamically
    if (!this.slideshowModalComponent || !this.evenement) {
      console.error('Slideshow modal component or event not available');
      return;
    }
    
    // Reset slideshow loading state
    this.fsSlideshowLoadingActive = true;
    
    // Get event color for slideshow styling
    const eventColor = this.getCalculatedColor();
    
    // Open modal immediately with empty array
    this.slideshowModalComponent.open([], this.evenement.evenementName, false, 0, eventColor || undefined);
    
    // Then list and load images dynamically
    const listSub = this.fileService.listImagesFromDisk(relativePath).subscribe({
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
          
          const imageSub = this.fileService.getImageFromDiskWithMetadata(relativePath, fileName, compress).subscribe({
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
          this.trackSubscription(imageSub);
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
    this.trackSubscription(listSub);
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
    const eventColor = event.eventColor || this.getCalculatedColor();

    if (this.slideshowModalComponent) {
      this.slideshowModalComponent.setTraceViewerOpen(true);
    }

    if (this.traceViewerModalComponent) {
      this.traceViewerModalComponent.openAtLocation(event.lat, event.lng, label, eventColor || undefined);
    }
  }

  public onTraceViewerClosed(): void {
    if (this.slideshowModalComponent) {
      this.slideshowModalComponent.setTraceViewerOpen(false);
    }
  }

  private cancelFsDownloads(): void {
    this.fsDownloadsActive = false;
    try { this.fsActiveSubs.forEach(s => { if (s && !s.closed) { s.unsubscribe(); } }); } catch {}
    this.fsActiveSubs = [];
    this.fsQueue = [];
  }

  // =========================
  // File Upload Methods
  // =========================

  public onFileSelected(event: any): void {
    const files: FileList = event.target.files;
    if (files && files.length > 0) {
      this.selectedFiles = Array.from(files);
      this.uploadFiles();
    }
  }

  private async uploadFiles(): Promise<void> {
    if (this.selectedFiles.length === 0 || !this.evenement || !this.user) {
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
      const imageFile = imageFiles[0];
      const useAsThumbnail = confirm(
        this.translateService.instant('EVENTELEM.USE_AS_THUMBNAIL', { fileName: imageFile.name })
      );
      
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

    // Process video compression if needed
    const videoFiles = this.selectedFiles.filter(file => this.isVideoFile(file.name));
    
    let processedFiles: File[] = [];
    
    if (videoFiles.length > 0 && this.videoCompressionService.isSupported()) {
      const quality = await this.askForCompressionQuality(videoFiles.length);
      
      if (quality === null) {
        this.addLog(`⚠️ Compression cancelled, uploading original files`);
        processedFiles.push(...this.selectedFiles);
      } else {
        this.addLog(`🎬 Found ${videoFiles.length} video file(s) - Compressing with ${quality} quality...`);
        
        // Compress videos
        for (let i = 0; i < this.selectedFiles.length; i++) {
          const file = this.selectedFiles[i];
          
          if (this.isVideoFile(file.name)) {
            try {
              this.addLog(`🎥 Compressing video ${i + 1}/${videoFiles.length}: ${file.name}...`);
              
              const compressedBlob = await this.videoCompressionService.compressVideo(file, quality, (progress: CompressionProgress) => {
                this.addLog(`   ${progress.message}`);
              });
              
              // Create a new File from the compressed blob
              const compressedFile = new File([compressedBlob], file.name, { type: 'video/mp4' });
              processedFiles.push(compressedFile);
              this.addLog(`✅ Compressed: ${file.name}`);
            } catch (error) {
              console.error('Compression error:', error);
              this.addLog(`⚠️ Compression not available for this format. Using original file.`);
              processedFiles.push(file);
            }
          } else {
            processedFiles.push(file);
          }
        }
      }
    } else {
      processedFiles.push(...this.selectedFiles);
      if (videoFiles.length > 0 && !this.videoCompressionService.isSupported()) {
        this.addLog(`⚠️ Video compression not supported in this browser, uploading original files`);
      }
    }

    // Build the correct upload URL with user ID and event ID
    const uploadUrl = `${this.API_URL4FILE}/${this.user.id}/${this.evenement.id}`;
    
    // Create FormData
    // IMPORTANT: Backend expects 'file' (singular), not 'files' (plural)
    const formData = new FormData();
    processedFiles.forEach(file => {
      formData.append('file', file);
    });

    // Subscribe to upload logs
    if (sessionId) {
      let lastLogCount = 0;
      const pollIntervalId = setInterval(() => {
        const logSubscription = this.fileService.getUploadLogs(sessionId).subscribe(
          (serverLogs: string[]) => {
            if (serverLogs.length > lastLogCount) {
              for (let i = lastLogCount; i < serverLogs.length; i++) {
                this.addLog(serverLogs[i]);
              }
              lastLogCount = serverLogs.length;
            }
          },
          (error) => {
            console.error('Error receiving upload logs:', error);
          }
        );
        this.trackSubscription(logSubscription);
      }, 1000); // Poll every second
      
      // Clear interval when upload completes
      setTimeout(() => {
        clearInterval(pollIntervalId);
      }, 300000); // Stop after 5 minutes
    }

    // Upload files
    const uploadSubscription = this.fileService.postFileToUrl(formData, this.user, uploadUrl, sessionId)
      .subscribe({
        next: (response: any) => {
          // Wait a bit for final logs (matching element-evenement pattern)
          const cleanupTimeout = setTimeout(() => {
          try {
              const fileCount = Array.isArray(response) ? response.length : (response ? 1 : processedFiles.length);
            this.addSuccessLog(`✅ Upload successful! ${fileCount} file(s) processed`);
            
            // The response should contain the uploaded file information directly
              // Files are already saved to database by the upload endpoint
            this.handleUploadResponse(response);
            
            // Reset file input
            const fileInput = document.querySelector(`input[id="file-upload-input-${this.evenement!.id}"]`) as HTMLInputElement;
            if (fileInput) {
              fileInput.value = '';
            }
            
            // Reset selected files
            this.selectedFiles = [];
            
              // Reload event from database to get the latest files
              // This ensures we have the most up-to-date data after upload
              const eventId = this.evenement!.id;
            
              // Use a small delay to ensure backend has finished saving
            setTimeout(() => {
                const reloadSubscription = this.evenementsService.getEvenement(eventId).subscribe({
                  next: (updatedEvent: Evenement) => {
                    this.evenement = updatedEvent;
                    
                    // Update photo gallery and video URLs with new files
                    try {
                      this.preparePhotoGallery();
                      this.loadVideoUrls();
              this.isUploading = false;
                      this.addSuccessLog(`✅ Files are now visible in the event (${updatedEvent.fileUploadeds?.length || 0} total files)`);
                    } catch (uiError) {
                      this.addErrorLog(`❌ Error updating UI: ${uiError}`);
                      this.isUploading = false;
                    }
                  },
                  error: (reloadError) => {
                    // Don't redirect on 401 - just log and continue with response data
                    if (reloadError?.status === 401) {
                      this.addErrorLog('⚠️ Could not reload event (authentication issue), but files were uploaded');
                    } else {
                      this.addErrorLog(`⚠️ Could not reload event: ${reloadError?.message || 'Unknown error'}`);
                    }
                    
                    // Fallback: try to update UI with response data anyway
                    try {
                      this.preparePhotoGallery();
                      this.loadVideoUrls();
                      this.isUploading = false;
                    } catch (uiError) {
                      this.isUploading = false;
                    }
                  }
                });
                this.trackSubscription(reloadSubscription);
              }, 500); // Small delay to ensure backend has finished saving
          } catch (error) {
            this.addErrorLog(`❌ CRITICAL ERROR processing upload response: ${error}`);
            setTimeout(() => {
              this.isUploading = false;
            }, 1000);
          }
          }, 500); // Wait 500ms for final logs (matching element-evenement)
          
          // Store timeout to clean up if needed
          setTimeout(() => {
            // Cleanup after timeout
          }, 600);
        },
        error: (error: any) => {
          let errorMessage = "Error uploading files.";
          
          if (error.status === 0) {
            errorMessage = "Unable to connect to server. Please check that the backend service is running.";
          } else if (error.status === 401) {
            errorMessage = "Authentication failed. Please log in again.";
            // Log error before any potential redirect
            this.addErrorLog(`❌ Upload error: ${errorMessage} (Status: ${error.status})`);
            // Don't redirect here - let interceptor handle it
            // But don't continue processing
            setTimeout(() => {
              this.isUploading = false;
            }, 1000);
            return;
          } else if (error.status === 403) {
            errorMessage = "Access denied. You don't have permission to upload files.";
          } else if (error.status === 413) {
            errorMessage = "File too large. Please select smaller files.";
          } else if (error.status >= 500) {
            errorMessage = "Server error. Please try again later.";
          } else if (error.error && error.error.message) {
            errorMessage = error.error.message;
          }
          
          this.addErrorLog(`❌ Upload error: ${errorMessage} (Status: ${error.status || 'unknown'})`);
          
          setTimeout(() => {
            this.isUploading = false;
          }, 1000);
        }
      });
    this.trackSubscription(uploadSubscription);
  }

  private addLog(message: string): void {
    this.uploadLogs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
    
    setTimeout(() => {
      if (this.logContent && this.logContent.nativeElement) {
        const container = this.logContent.nativeElement;
        container.scrollTop = 0;
      }
    }, 0);
  }

  private addSuccessLog(message: string): void {
    this.uploadLogs.unshift(`SUCCESS: [${new Date().toLocaleTimeString()}] ${message}`);
    
    setTimeout(() => {
      if (this.logContent && this.logContent.nativeElement) {
        const container = this.logContent.nativeElement;
        container.scrollTop = 0;
      }
    }, 0);
  }

  private addErrorLog(message: string): void {
    this.uploadLogs.unshift(`ERROR: [${new Date().toLocaleTimeString()}] ${message}`);
    
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
      if (response && Array.isArray(response)) {
        this.addUploadedFilesToEvent(response);
      } else if (response && (response.uploadedFiles || response.files)) {
        const uploadedFiles = response.uploadedFiles || response.files;
        this.addUploadedFilesToEvent(uploadedFiles);
      } else if (response && response.fieldId) {
        this.addUploadedFilesToEvent([response]);
      } else {
        this.createUploadedFileEntries();
      }
    } catch (error) {
      this.addErrorLog(`❌ CRITICAL ERROR in handleUploadResponse: ${error}`);
      // Don't call createUploadedFileEntries on error - it might cause more issues
      // The files are already uploaded, we just couldn't process the response
    }
  }

  private addUploadedFilesToEvent(uploadedFilesData: any[]): void {
    try {
      if (!this.evenement) {
        return;
      }
      
      if (!Array.isArray(uploadedFilesData)) {
        return;
      }
    
    let hasThumbnailFile = false;
    let thumbnailFile: UploadedFile | null = null;
      let hasModifiedFiles = false;
    
    if (!this.evenement.fileUploadeds) {
      this.evenement.fileUploadeds = [];
    }
    
    for (let fileData of uploadedFilesData) {
        try {
      const uploadedFile = new UploadedFile(
        fileData.fieldId || fileData.id || this.generateFileId(),
        fileData.fileName || fileData.name,
        fileData.fileType || fileData.type || 'unknown',
        this.user!
      );

      // Preserve backend metadata if present (not typed on UploadedFile model)
      (uploadedFile as any).dateCreation = fileData.dateCreation || (uploadedFile as any).dateCreation;
      (uploadedFile as any).uploadDate = fileData.uploadDate || fileData.uploadedAt || (uploadedFile as any).uploadDate;
      (uploadedFile as any).dateUpload = fileData.dateUpload || (uploadedFile as any).dateUpload;
      (uploadedFile as any).createdAt = fileData.createdAt || (uploadedFile as any).createdAt;
      
      if (uploadedFile.fileName && uploadedFile.fileName.toLowerCase().includes('thumbnail')) {
        hasThumbnailFile = true;
        thumbnailFile = uploadedFile;
      }
      
      const existingFile = this.evenement.fileUploadeds.find(f => f.fieldId === uploadedFile.fieldId);
      if (!existingFile) {
        this.evenement.fileUploadeds.push(uploadedFile);
          }
        } catch (fileError) {
          // Silently skip invalid file data
      }
    }
    
    if (hasThumbnailFile && thumbnailFile) {
      this.evenement.thumbnail = thumbnailFile;
      
      this.evenement.fileUploadeds.forEach(fileUploaded => {
        const isNewFile = uploadedFilesData.some(f => 
          (f.fieldId || f.id) === fileUploaded.fieldId
        );
        
        if (!isNewFile && fileUploaded.fileName && fileUploaded.fileName.toLowerCase().includes('thumbnail')) {
          const newName = fileUploaded.fileName.replace(/thumbnail/gi, '').replace(/\s+/g, '');
          fileUploaded.fileName = newName;
            hasModifiedFiles = true;
          }
        });
      }
      
      // Files are already saved to database by the upload endpoint
      // We don't need to call putEvenement - the upload endpoint already saved everything
      // Just update the UI to reflect the new files
      try {
        this.preparePhotoGallery();
        this.loadVideoUrls();
      } catch (uiError) {
        throw uiError; // Re-throw to be caught by outer try-catch
      }
    } catch (error) {
      this.addErrorLog(`❌ CRITICAL ERROR in addUploadedFilesToEvent: ${error}`);
      // Don't re-throw - we want to continue even if UI update fails
    }
  }

  private createUploadedFileEntries(): void {
    if (!this.evenement) return;
    
    let hasThumbnailFile = false;
    const newUploadedFiles: UploadedFile[] = [];
    
    if (!this.evenement.fileUploadeds) {
      this.evenement.fileUploadeds = [];
    }
    
    for (let file of this.selectedFiles) {
      const uploadedFile = new UploadedFile(
        this.generateFileId(),
        file.name,
        file.type || 'unknown',
        this.user!
      );
      
      if (uploadedFile.fileName && uploadedFile.fileName.toLowerCase().includes('thumbnail')) {
        hasThumbnailFile = true;
      }
      
      const existingFile = this.evenement.fileUploadeds.find(f => f.fileName === uploadedFile.fileName);
      if (!existingFile) {
        this.evenement.fileUploadeds.push(uploadedFile);
        newUploadedFiles.push(uploadedFile);
      }
    }
    
    if (hasThumbnailFile) {
      this.evenement.fileUploadeds.forEach(fileUploaded => {
        const isNewFile = newUploadedFiles.some(f => f.fieldId === fileUploaded.fieldId);
        
        if (!isNewFile && fileUploaded.fileName && fileUploaded.fileName.toLowerCase().includes('thumbnail')) {
          const newName = fileUploaded.fileName.replace(/thumbnail/gi, '').replace(/\s+/g, '');
          fileUploaded.fileName = newName;
        }
      });
      
      // Files are already saved to database by the upload endpoint
      // We don't need to call putEvenement - the upload endpoint already saved everything
      // Just update the UI to reflect the new files
      this.preparePhotoGallery();
      this.loadVideoUrls();
    } else {
      // Update photo gallery and video URLs with new files
      this.preparePhotoGallery();
      this.loadVideoUrls();
    }
  }

  private generateFileId(): string {
    return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  private isImageFileByMimeType(file: File): boolean {
    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml'];
    return imageTypes.includes(file.type.toLowerCase());
  }

  private addThumbnailToFileName(originalName: string): string {
    const lastDotIndex = originalName.lastIndexOf('.');
    
    if (lastDotIndex === -1) {
      return originalName + '_thumbnail';
    }
    
    const nameWithoutExtension = originalName.substring(0, lastDotIndex);
    const extension = originalName.substring(lastDotIndex);
    
    const middleIndex = Math.floor(nameWithoutExtension.length / 2);
    const modifiedName = nameWithoutExtension.substring(0, middleIndex) + 
                         'thumbnail' + 
                         nameWithoutExtension.substring(middleIndex) + 
                         extension;
    
    return modifiedName;
  }

  private askForCompressionQuality(videoCount: number): Promise<'low' | 'medium' | 'high' | null> {
    return new Promise((resolve) => {
      this.selectedCompressionQuality = 'high'; // Default to best quality
      this.videoCountForModal = videoCount; // Used by template

      if (this.qualitySelectionModal) {
        this.qualityModalRef = this.modalService.open(this.qualitySelectionModal, {
          centered: true,
          backdrop: 'static',
          keyboard: false,
          size: 'md'
        });

        this.qualityModalRef.result.then(
          (result: 'low' | 'medium' | 'high') => {
            this.qualityModalRef = null;
            resolve(result);
          },
          () => {
            this.qualityModalRef = null;
            resolve(null); // dismissed
          }
        );
      } else {
        // Fallback (should not happen once template exists)
        const choice = prompt(
          `Choisissez la qualité de compression pour ${videoCount} vidéo(s):\n` +
          `1. Basse (petite taille)\n` +
          `2. Moyenne (taille moyenne)\n` +
          `3. Haute (grande taille)\n\n` +
          `Entrez 1, 2 ou 3:`
        );

        if (choice === '1') resolve('low');
        else if (choice === '2') resolve('medium');
        else if (choice === '3') resolve('high');
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


  // =========================
  // Slideshow methods (now handled by SlideshowModalComponent)
  // =========================

}