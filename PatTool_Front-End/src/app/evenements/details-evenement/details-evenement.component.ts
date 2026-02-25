import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, TemplateRef, ElementRef, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule, NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { Observable, Subscription, of, EMPTY } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { SlideshowModalComponent, SlideshowImageSource, SlideshowLocationEvent } from '../../shared/slideshow-modal/slideshow-modal.component';
import { TraceViewerModalComponent } from '../../shared/trace-viewer-modal/trace-viewer-modal.component';
import { DiscussionModalComponent } from '../../communications/discussion-modal/discussion-modal.component';
import { ElementEvenementComponent } from '../element-evenement/element-evenement.component';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

import { Evenement } from '../../model/evenement';
import { Member } from '../../model/member';
import { UploadedFile } from '../../model/uploadedfile';
import { UrlEvent } from '../../model/url-event';
import { Commentary } from '../../model/commentary';
import { DiscussionService, DiscussionMessage } from '../../services/discussion.service';
import { EvenementsService } from '../../services/evenements.service';
import { MembersService } from '../../services/members.service';
import { FileService, ImageDownloadResult } from '../../services/file.service';
import { WindowRefService } from '../../services/window-ref.service';
import { FriendsService } from '../../services/friends.service';
import { VideoCompressionService, CompressionProgress } from '../../services/video-compression.service';
import { VideoUploadProcessingService } from '../../services/video-upload-processing.service';
import { environment } from '../../../environments/environment';
import { FriendGroup } from '../../model/friend';
import { EventColorService } from '../../services/event-color.service';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { CommentaryEditor } from '../../commentary-editor/commentary-editor';

@Component({
  selector: 'app-details-evenement',
  templateUrl: './details-evenement.component.html',
  styleUrls: ['./details-evenement.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    TranslateModule,
    NgbModule,
    SlideshowModalComponent,
    TraceViewerModalComponent,
    DiscussionModalComponent,
    ElementEvenementComponent,
    NavigationButtonsModule,
    CommentaryEditor
  ]
})
export class DetailsEvenementComponent implements OnInit, AfterViewInit, OnDestroy {

  public evenement: Evenement | null = null;
  public user: Member | null = null;
  public loading: boolean = true;
  public error: string | null = null;
  /** Set when backend returns 403 (no access); used to show owner name/email in message */
  public accessDeniedOwnerName: string | null = null;
  public accessDeniedOwnerEmail: string | null = null;
  public accessDeniedEventName: string | null = null;
  public accessDenied: boolean = false;

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
  
  // Cached background image URL to prevent ExpressionChangedAfterItHasBeenCheckedError
  private _backgroundImageUrl: string = 'url("assets/images/images.jpg")';
  public get backgroundImageUrl(): string {
    return this._backgroundImageUrl;
  }

  // Photo gallery properties
  public currentPhotoIndex: number = 0;
  public isPhotoGalleryAutoplay: boolean = true; // Auto-play by default
  private photoGalleryAutoplayInterval: any = null;
  
  // PHOTOFROMFS galleries - one per link
  public photofromfsPhotoItems: Map<string, Array<{
    fileName: string;
    imageUrl: SafeUrl;
    relativePath: string;
  }>> = new Map();
  public photofromfsCurrentPhotoIndex: Map<string, number> = new Map();
  public photofromfsLoading: Map<string, boolean> = new Map();
  public photofromfsAutoplay: Map<string, boolean> = new Map(); // Auto-play by default for each gallery
  private photofromfsAutoplayIntervals: Map<string, any> = new Map();
  
  // Cache for PHOTOFROMFS images (similar to slideshow modal)
  private photofromfsImageCache: Map<string, {
    blobUrl: string;
    blob: Blob;
    safeUrl: SafeUrl;
  }> = new Map();
  private photofromfsLoadingKeys: Set<string> = new Set();
  private photofromfsLoadQueue: Map<string, Array<{
    fileName: string;
    priority: number;
  }>> = new Map();
  
  // Fullscreen properties
  public isFullscreen: boolean = false;
  
  // Image cache for authenticated images
  private imageCache = new Map<string, SafeUrl>();
  
  // Cache for discussion file URLs (blob URLs)
  private discussionFileUrlCache: Map<string, string> = new Map();
  // Store blobs separately to recreate blob URLs if needed
  private discussionFileBlobCache: Map<string, Blob> = new Map();
  // Store deleted image filenames (messageId -> filename) for error display
  private discussionImageErrors: Map<string, string> = new Map();
  // Cache for video URLs (blob URLs)
  private videoUrlCache: Map<string, SafeUrl> = new Map();
  // Track videos that have successfully loaded to avoid false error logs
  private videoLoadSuccess: Set<string> = new Set();
  
  // Track active HTTP subscriptions to cancel them on destroy
  private activeSubscriptions = new Set<Subscription>();
  
  @ViewChild('imageModal') imageModal!: TemplateRef<any>;
  @ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
  @ViewChild('traceViewerModalComponent') traceViewerModalComponent!: TraceViewerModalComponent;
  @ViewChild('commentaryEditor') commentaryEditor: any;
  @ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;
  @ViewChild('qualitySelectionModal') qualitySelectionModal!: TemplateRef<any>;
  @ViewChild('discussionMessagesContainer', { read: ElementRef }) discussionMessagesContainer!: ElementRef;
  @ViewChild('directoryInput') directoryInput!: any;
  @ViewChild('editDirectoryInput') editDirectoryInput!: any;
  @ViewChild('whatsappShareModal', { static: false }) whatsappShareModal!: TemplateRef<any>;
  @ViewChild('shareByEmailModal', { static: false }) shareByEmailModal!: TemplateRef<any>;
  @ViewChild('urlsCard', { read: ElementRef }) urlsCardRef!: ElementRef;

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

  // Share by email modal
  public shareByEmailModalRef: any = null;
  public shareByEmailPatToolSelected: string[] = [];
  /** Set des emails sélectionnés (pour lookup O(1) dans le template, évite indexOf à chaque CD). */
  public shareByEmailPatToolSelectedSet: Set<string> = new Set();
  public shareByEmailExternalEmails: string = '';
  public shareByEmailMessage: string = '';
  public shareByEmailMailLang: string = 'fr';
  /** code = langue mail, flagCode = code pays ISO pour flag-icons (fi fi-xx) */
  public shareByEmailMailLangOptions: { code: string; labelKey: string; flagCode: string }[] = [
    { code: 'fr', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_FR', flagCode: 'fr' },
    { code: 'en', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_EN', flagCode: 'gb' },
    { code: 'de', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_DE', flagCode: 'de' },
    { code: 'es', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_ES', flagCode: 'es' },
    { code: 'it', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_IT', flagCode: 'it' },
    { code: 'el', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_EL', flagCode: 'gr' },
    { code: 'he', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_HE', flagCode: 'il' },
    { code: 'jp', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_JP', flagCode: 'jp' },
    { code: 'ru', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_RU', flagCode: 'ru' },
    { code: 'cn', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_CN', flagCode: 'cn' },
    { code: 'ar', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_AR', flagCode: 'sa' },
    { code: 'in', labelKey: 'EVENTELEM.SHARE_MAIL_LANG_IN', flagCode: 'in' }
  ];
  public shareByEmailAllMembers: Member[] = [];
  public shareByEmailLoading: boolean = false;
  public shareByEmailSending: boolean = false;
  public shareByEmailError: string | null = null;
  public shareByEmailSuccess: string | null = null;

  /** Option de langue du mail actuellement sélectionnée (pour afficher drapeau + libellé). */
  public getShareByEmailMailLangOption(): { code: string; labelKey: string; flagCode: string } | undefined {
    return this.shareByEmailMailLangOptions.find(o => o.code === this.shareByEmailMailLang) ?? this.shareByEmailMailLangOptions[0];
  }

  /** Nombre total d'adresses email sélectionnées (PatTool + adresses libres). */
  public get shareByEmailRecipientCount(): number {
    const patCount = (this.shareByEmailPatToolSelected || []).length;
    const external = (this.shareByEmailExternalEmails || '')
      .split(/[\s,;]+/)
      .map((e: string) => e.trim())
      .filter((e: string) => e.length > 0);
    return patCount + external.length;
  }

  /** trackBy pour la liste des utilisateurs dans la modale partage par mail (performance). */
  public trackByShareByEmailMemberId(_index: number, m: Member): string {
    return m.id ?? m.addressEmail ?? '';
  }

  // Event access users
  public eventAccessUsers: Member[] = [];
  public isLoadingEventAccessUsers: boolean = false;
  public isEventAccessUsersExpanded: boolean = false;

  // Discussion messages
  public discussionMessages: DiscussionMessage[] = [];
  public isLoadingDiscussion: boolean = false;
  public discussionError: string | null = null;
  
  // Video URLs for display
  public videoUrls: Map<string, SafeUrl> = new Map();
  // Video file sizes (in bytes)
  private videoFileSizes: Map<string, number> = new Map();
  
  // File upload properties
  public selectedFiles: File[] = [];
  public uploadLogs: string[] = [];
  public isUploading: boolean = false;
  public selectedCompressionQuality: 'low' | 'medium' | 'high' | 'very-high' | 'original' = 'very-high';
  public showQualitySelection: boolean = false;
  public pendingVideoFiles: File[] = [];
  public videoCountForModal: number = 0;
  private qualityModalRef: any = null;
  // Image compression settings
  public compressImages: boolean = true; // Default: compress images
  public imageCountForModal: number = 0;
  @ViewChild('imageCompressionModal') imageCompressionModal!: TemplateRef<any>;
  private imageCompressionModalRef: any = null;
  private activeTimeouts = new Set<any>();
  private activeIntervals = new Set<any>();
  @ViewChild('logContent') logContent!: ElementRef;
  
  // WhatsApp share properties
  public whatsappShareMessage: string = '';
  private whatsappShareModalRef: any = null;
  
  // Route subscription for cleanup
  private routeParamsSubscription?: Subscription;

  // Guard to avoid multiple simultaneous dominant color recalculations
  private recalculatingEventColor = false;
  
  // Fullscreen event listeners for cleanup
  private fullscreenHandlers: Array<{ event: string; handler: () => void }> = [];

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
    private videoUploadProcessingService: VideoUploadProcessingService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private eventColorService: EventColorService,
    private keycloakService: KeycloakService
  ) {
    this.nativeWindow = winRef.getNativeWindow();
  }

  ngOnInit(): void {
    const eventId = this.route.snapshot.paramMap.get('id');
    
    // Reset scroll position to top for non-mobile mode
    if (window.innerWidth >= 769) {
      // Reset body and html scroll
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      // Reset artistic-event-page scroll after view init
      const timeoutId = setTimeout(() => {
        const pageElement = document.querySelector('.artistic-event-page') as HTMLElement;
        if (pageElement) {
          pageElement.scrollTop = 0;
        }
      }, 0);
      this.trackTimeout(timeoutId);
    }
    
    try {
      // Display any stored errors from previous page load
      this.displayStoredErrors();
      
      // Get color from service and apply it first
      try {
        this.applyEventColor();
      } catch (colorError) {
        console.error('[DETAILS-EVENEMENT] Error applying event color in ngOnInit:', colorError);
        // Don't let color errors prevent initialization
      }
      
      // Load event first; loadFriendGroups is called only after event loads successfully (in loadEventDetails)
      // so that a 401 from friend groups does not redirect before we can show 403 "ask owner" message
      try {
        this.loadEventDetails();
      } catch (eventError) {
        console.error('[DETAILS-EVENEMENT] Error loading event details:', eventError);
        // Set error state but don't navigate
        this.error = this.translateService.instant('EVENTELEM.ERROR_LOADING_EVENT') || 'Error loading event';
        this.loading = false;
      }
    } catch (initError) {
      // Catch any unexpected errors during initialization
      console.error('[DETAILS-EVENEMENT] Unexpected error in ngOnInit:', initError);
      this.error = this.translateService.instant('EVENTELEM.ERROR_LOADING_EVENT') || 'Error initializing page';
      this.loading = false;
      // Don't navigate - stay on page to show error
    }
  }

  ngAfterViewInit(): void {
    // Reset scroll position to top for non-mobile mode after view is initialized
    if (window.innerWidth >= 769) {
      const timeoutId = setTimeout(() => {
        // Reset body and html scroll
        document.body.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        // Reset artistic-event-page scroll
        const pageElement = document.querySelector('.artistic-event-page') as HTMLElement;
        if (pageElement) {
          pageElement.scrollTop = 0;
        }
      }, 100);
      this.trackTimeout(timeoutId);
    }
  }

  // Get color from service and apply it to buttons and all text
  private applyEventColor(): void {
    // Unsubscribe previous subscription if exists
    if (this.routeParamsSubscription) {
      this.routeParamsSubscription.unsubscribe();
    }
    
    this.routeParamsSubscription = this.route.params.subscribe(params => {
      const eventId = params['id'];
      if (eventId) {
        let color = this.eventColorService.getEventColor(eventId);
        // If color not found, try with evenementName as fallback
        if (!color && this.evenement?.evenementName) {
          color = this.eventColorService.getEventColor(this.evenement.evenementName);
        }
        if (color) {
          // Single lightened color for all card backgrounds (same as getLightenedCalculatedColor)
          const lightenFactor = 0.35;
          const c = {
            r: Math.round(color.r + (255 - color.r) * lightenFactor),
            g: Math.round(color.g + (255 - color.g) * lightenFactor),
            b: Math.round(color.b + (255 - color.b) * lightenFactor)
          };

          // Brightness from lightened color for text/UI
          const brightness = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
          const isBright = brightness > 128;
          
          const badgeTitleColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
          document.documentElement.style.setProperty('--badge-title-color', badgeTitleColor);
          
          const primaryTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
          document.documentElement.style.setProperty('--text-color-primary', primaryTextColor);
          
          const lightTextColor = isBright ? 'rgb(10, 20, 35)' : 'rgb(245, 245, 245)';
          document.documentElement.style.setProperty('--text-color-light', lightTextColor);
          
          const darkTextColor = isBright ? 'rgb(60, 70, 90)' : 'rgb(200, 200, 200)';
          document.documentElement.style.setProperty('--text-color-dark', darkTextColor);
          
          const veryLightTextColor = isBright ? 'rgb(40, 50, 70)' : 'rgb(220, 220, 220)';
          document.documentElement.style.setProperty('--text-color-very-light', veryLightTextColor);
          
          const veryDarkTextColor = isBright ? 'rgb(100, 110, 130)' : 'rgb(150, 150, 150)';
          document.documentElement.style.setProperty('--text-color-very-dark', veryDarkTextColor);
          
          document.documentElement.style.setProperty('--btn-text-color', `rgb(${c.r}, ${c.g}, ${c.b})`);
          
          const selectSelectedBg = `rgba(${c.r}, ${c.g}, ${c.b}, 0.8)`;
          const selectDropdownBg = `rgba(${Math.max(0, c.r - 50)}, ${Math.max(0, c.g - 50)}, ${Math.max(0, c.b - 50)}, 0.85)`;
          const selectTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
          document.documentElement.style.setProperty('--select-selected-bg', selectSelectedBg);
          document.documentElement.style.setProperty('--select-dropdown-bg', selectDropdownBg);
          document.documentElement.style.setProperty('--select-text-color', selectTextColor);
          document.documentElement.style.setProperty('--select-selected-bg-shadow', `rgba(${c.r}, ${c.g}, ${c.b}, 0.15)`);
          
          // Card backgrounds: only the lightened color, no opacities
          document.documentElement.style.setProperty('--color-light', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-light-border', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-medium', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-medium-border', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-dark', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-dark-border', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-very-light', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-very-light-border', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-original-light', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-original-medium', `rgb(${c.r}, ${c.g}, ${c.b})`);
          document.documentElement.style.setProperty('--color-original-dark', `rgb(${c.r}, ${c.g}, ${c.b})`);
          // Card header gradient (lighter -> darker)
          const headerStartR = Math.min(255, c.r + 45);
          const headerStartG = Math.min(255, c.g + 45);
          const headerStartB = Math.min(255, c.b + 45);
          const headerEndR = Math.max(0, c.r - 25);
          const headerEndG = Math.max(0, c.g - 25);
          const headerEndB = Math.max(0, c.b - 25);
          document.documentElement.style.setProperty('--card-header-gradient-start', `rgb(${headerStartR}, ${headerStartG}, ${headerStartB})`);
          document.documentElement.style.setProperty('--card-header-gradient-end', `rgb(${headerEndR}, ${headerEndG}, ${headerEndB})`);
          // Event title gradient
          document.documentElement.style.setProperty('--event-title-gradient-start', `rgb(${headerStartR}, ${headerStartG}, ${headerStartB})`);
          document.documentElement.style.setProperty('--event-title-gradient-end', `rgb(${headerEndR}, ${headerEndG}, ${headerEndB})`);
          // Action bar (boutons): gradient from calculated color to lightened
          document.documentElement.style.setProperty('--action-bar-gradient-start', `rgb(${color.r}, ${color.g}, ${color.b})`);
          document.documentElement.style.setProperty('--action-bar-gradient-end', `rgb(${c.r}, ${c.g}, ${c.b})`);
        } else {
          // Set default colors if no color is found (no opacities)
          document.documentElement.style.setProperty('--text-color-primary', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--text-color-dark', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--color-light', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--color-medium', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--color-dark', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--color-very-light', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--card-header-gradient-start', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--card-header-gradient-end', 'rgb(240, 240, 240)');
          document.documentElement.style.setProperty('--event-title-gradient-start', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--event-title-gradient-end', 'rgb(240, 240, 240)');
          document.documentElement.style.setProperty('--action-bar-gradient-start', 'rgb(255, 255, 255)');
          document.documentElement.style.setProperty('--action-bar-gradient-end', 'rgb(240, 240, 240)');
          // Recalculate color from event image and cache it, then re-apply
          this.recalculateAndCacheEventColor(eventId);
        }
      }
    });
  }

  /**
   * Get the first available image fieldId for dominant color extraction (thumbnail or first image in fileUploadeds).
   */
  private getFirstImageFieldId(): string | null {
    if (!this.evenement) {
      return null;
    }
    if (this.evenement.thumbnail?.fieldId && this.isImageFile(this.evenement.thumbnail.fileName || '')) {
      return this.evenement.thumbnail.fieldId;
    }
    const imageFiles = (this.evenement.fileUploadeds || []).filter(f => this.isImageFile(f.fileName || ''));
    return imageFiles[0]?.fieldId ?? null;
  }

  /**
   * Extract dominant color from an image using canvas (same approach as element-evenement).
   */
  private extractDominantColorFromImage(img: HTMLImageElement): { r: number; g: number; b: number } | null {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return null;
      }
      const maxSize = 200;
      const imgWidth = img.naturalWidth || img.width;
      const imgHeight = img.naturalHeight || img.height;
      let canvasWidth = imgWidth;
      let canvasHeight = imgHeight;
      if (imgWidth > maxSize || imgHeight > maxSize) {
        const scale = Math.min(maxSize / imgWidth, maxSize / imgHeight);
        canvasWidth = Math.floor(imgWidth * scale);
        canvasHeight = Math.floor(imgHeight * scale);
      }
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
      const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
      const pixels = imageData.data;
      const pixelStep = 80;
      let r = 0, g = 0, b = 0;
      let pixelCount = 0;
      for (let i = 0; i < pixels.length; i += pixelStep) {
        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
        pixelCount++;
      }
      if (pixelCount === 0) {
        return null;
      }
      const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
      return {
        r: clamp(r / pixelCount),
        g: clamp(g / pixelCount),
        b: clamp(b / pixelCount)
      };
    } catch {
      return null;
    }
  }

  /**
   * When the event color is not in the service (e.g. direct navigation to details), recalculate it from the first event image and cache it.
   */
  private recalculateAndCacheEventColor(eventId: string): void {
    if (!this.evenement || this.recalculatingEventColor) {
      return;
    }
    const imageFieldId = this.getFirstImageFieldId();
    if (!imageFieldId) {
      return;
    }
    this.recalculatingEventColor = true;
    const subscription = this.fileService.getFile(imageFieldId).pipe(
      catchError(() => {
        this.recalculatingEventColor = false;
        return EMPTY;
      }),
      map((res: unknown) => {
        const blob = res instanceof Blob ? res : new Blob([res as BlobPart], { type: 'application/octet-stream' });
        return URL.createObjectURL(blob);
      })
    ).subscribe({
      next: (objectUrl: string) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const color = this.extractDominantColorFromImage(img);
            URL.revokeObjectURL(objectUrl);
            // Only cache and apply if still on the same event (user may have navigated away)
            if (color && this.evenement && (this.evenement.id === eventId || this.evenement.evenementName === eventId)) {
              this.eventColorService.setEventColor(eventId, color);
              if (this.evenement.evenementName) {
                this.eventColorService.setEventColor(this.evenement.evenementName, color);
              }
              this.applyEventColor();
              this.cdr.markForCheck();
            }
          } finally {
            this.recalculatingEventColor = false;
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          this.recalculatingEventColor = false;
        };
        img.src = objectUrl;
      },
      error: () => {
        this.recalculatingEventColor = false;
      }
    });
    this.activeSubscriptions.add(subscription);
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
      
      // Check for discussion errors (filter out 404 errors as they are expected)
      const discussionError = localStorage.getItem('last_discussion_error');
      if (discussionError) {
        const errorData = JSON.parse(discussionError);
        // Only include non-404 errors (404 = file not found, which is normal)
        if (errorData.status !== 404) {
          errors.push({ type: 'Discussion File Error', ...errorData });
        } else {
          // Clean up 404 error from localStorage
          try {
            localStorage.removeItem('last_discussion_error');
          } catch (e) {
            // Ignore storage errors
          }
        }
      }
      
      // Check for discussion image errors history (filter out 404/401/403 errors as they are expected)
      const discussionImageErrors = localStorage.getItem('discussion_image_errors');
      if (discussionImageErrors) {
        const history = JSON.parse(discussionImageErrors);
        // Filter out 404/401/403 errors (file not found or auth issues are normal)
        const significantErrors = history.filter((err: any) => 
          err.status !== 404 && err.status !== 401 && err.status !== 403
        );
        if (significantErrors.length > 0) {
          errors.push({ type: 'Discussion Image Errors History', count: significantErrors.length, errors: significantErrors });
        }
        // Clean up localStorage by removing filtered errors from history
        if (significantErrors.length !== history.length) {
          try {
            if (significantErrors.length === 0) {
              // Remove the key entirely if no significant errors remain
              localStorage.removeItem('discussion_image_errors');
            } else {
              localStorage.setItem('discussion_image_errors', JSON.stringify(significantErrors));
            }
          } catch (e) {
            // Ignore storage errors
          }
        }
      }
      
      // Check for discussion video errors history (filter out 404/401/403 errors as they are expected)
      const discussionVideoErrors = localStorage.getItem('discussion_video_errors');
      if (discussionVideoErrors) {
        const history = JSON.parse(discussionVideoErrors);
        // Filter out 404/401/403 errors (file not found or auth issues are normal)
        const significantErrors = history.filter((err: any) => 
          err.status !== 404 && err.status !== 401 && err.status !== 403
        );
        if (significantErrors.length > 0) {
          errors.push({ type: 'Discussion Video Errors History', count: significantErrors.length, errors: significantErrors });
        }
        // Clean up localStorage by removing filtered errors from history
        if (significantErrors.length !== history.length) {
          try {
            if (significantErrors.length === 0) {
              // Remove the key entirely if no significant errors remain
              localStorage.removeItem('discussion_video_errors');
            } else {
              localStorage.setItem('discussion_video_errors', JSON.stringify(significantErrors));
            }
          } catch (e) {
            // Ignore storage errors
          }
        }
      }
      
      // Check for discussion messages errors (filter out 401/403 as they're handled by interceptor)
      const discussionMessagesError = localStorage.getItem('last_discussion_messages_error');
      if (discussionMessagesError) {
        const errorData = JSON.parse(discussionMessagesError);
        // Only include non-auth errors (401/403 are handled by interceptor and shouldn't cause navigation)
        if (errorData.status !== 401 && errorData.status !== 403) {
          errors.push({ type: 'Discussion Messages Error', ...errorData });
        } else {
          // Clean up auth errors from localStorage as they're expected
          try {
            localStorage.removeItem('last_discussion_messages_error');
          } catch (e) {
            // Ignore storage errors
          }
        }
      }
      
      // Check for event load errors (filter out 401/403 as they're handled by interceptor)
      // Don't let stored event errors cause navigation - they're from previous loads
      const eventError = localStorage.getItem('last_event_error');
      if (eventError) {
        const errorData = JSON.parse(eventError);
        // Only log non-auth errors (401/403 are handled by interceptor)
        // Don't set this.error from stored errors - only from current load
        if (errorData.status !== 401 && errorData.status !== 403) {
          errors.push({ type: 'Event Load Error (from previous load)', ...errorData });
        } else {
          // Clean up auth errors from localStorage as they're expected
          try {
            localStorage.removeItem('last_event_error');
          } catch (e) {
            // Ignore storage errors
          }
        }
      }
      
      // Check for video error history
      const videoErrorHistory = localStorage.getItem('video_error_history');
      if (videoErrorHistory) {
        const history = JSON.parse(videoErrorHistory);
        if (history.length > 0) {
          errors.push({ type: 'Video Error History', count: history.length, errors: history });
        }
      }
      
      // Display all errors in console once (but don't let them affect navigation)
      // These are just informational - they won't cause the page to redirect
      if (errors.length > 0) {
        console.group('🔴 ERRORS FROM PREVIOUS PAGE LOAD (stored in localStorage) - These are informational only and won\'t cause navigation');
        errors.forEach((error, index) => {
          console.error(`[${index + 1}] ${error.type}:`, error);
        });
        console.groupEnd();
        // Clear stored errors after showing once so they don't reappear on every visit
        try {
          localStorage.removeItem('last_event_error');
          localStorage.removeItem('last_discussion_messages_error');
        } catch (e) {
          // Ignore storage errors
        }
      }
      
      // IMPORTANT: This method only displays errors - it does NOT set this.error or navigate
      // Navigation is only triggered by actual HTTP errors during loadEventDetails()
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
    // ============================================
    // COMPREHENSIVE MEMORY CLEANUP
    // ============================================
    // This method ensures all resources are properly released when the component is destroyed
    // to prevent memory leaks and ensure clean component lifecycle management.
    
    this.cancelFsDownloads();
    this.onSlideshowClosed();
    
    // Unsubscribe route params subscription
    if (this.routeParamsSubscription && !this.routeParamsSubscription.closed) {
      this.routeParamsSubscription.unsubscribe();
    }
    
    // Remove fullscreen event listeners
    this.fullscreenHandlers.forEach(({ event, handler }) => {
      document.removeEventListener(event, handler);
    });
    this.fullscreenHandlers = [];
    
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
    this.videoFileSizes.clear();
    this.videoLoadSuccess.clear();
    
    // Stop all autoplay intervals
    this.stopPhotoGalleryAutoplay();
    this.photofromfsAutoplayIntervals.forEach((interval) => {
      if (interval) {
        clearInterval(interval);
        this.activeIntervals.delete(interval);
      }
    });
    this.photofromfsAutoplayIntervals.clear();
    
    // Also clear photoGalleryAutoplayInterval if it exists
    if (this.photoGalleryAutoplayInterval) {
      clearInterval(this.photoGalleryAutoplayInterval);
      this.activeIntervals.delete(this.photoGalleryAutoplayInterval);
      this.photoGalleryAutoplayInterval = null;
    }
    
    // Clean up PHOTOFROMFS image cache
    this.photofromfsImageCache.forEach((cached) => {
      if (cached.blobUrl && cached.blobUrl.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(cached.blobUrl);
        } catch (e) {
          // Ignore errors when revoking
        }
      }
    });
    this.photofromfsImageCache.clear();
    this.photofromfsLoadingKeys.clear();
    this.photofromfsLoadQueue.clear();
    
    // Clean up PHOTOFROMFS photo items blob URLs
    this.photofromfsPhotoItems.forEach((items, relativePath) => {
      items.forEach((item) => {
        const url = (item.imageUrl as any)?.changingThisBreaksApplicationSecurity;
        if (url && url.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(url);
          } catch (e) {
            // Ignore errors when revoking
          }
        }
      });
    });
    this.photofromfsPhotoItems.clear();
    this.photofromfsCurrentPhotoIndex.clear();
    this.photofromfsLoading.clear();
    this.photofromfsAutoplay.clear();
    
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
    
    // Clear grid packing cache
    this.cardPositionsCache.clear();
    this.processedCards.clear();
    this.gridOccupancy = [];
    
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
    
    // Clear intervals
    this.activeIntervals.forEach((interval: any) => {
      if (interval) {
        clearInterval(interval);
      }
    });
    this.activeIntervals.clear();
    
    // Clear error and loading states
    this.error = null;
    this.accessDenied = false;
    this.accessDeniedOwnerName = null;
    this.accessDeniedOwnerEmail = null;
    this.accessDeniedEventName = null;
    this.loading = true;
    
    // Reset photo gallery
    this.currentPhotoIndex = 0;
    this.isFullscreen = false;
    
    // Close any open modals
    if (this.qualityModalRef) {
      try {
        this.qualityModalRef.close();
      } catch (e) {
        // Ignore errors
      }
      this.qualityModalRef = null;
    }
    
    if (this.imageCompressionModalRef) {
      try {
        this.imageCompressionModalRef.close();
      } catch (e) {
        // Ignore errors
      }
      this.imageCompressionModalRef = null;
    }
    
    // Clear ViewChild references (Angular will handle these, but we can null them for clarity)
    this.slideshowModalComponent = null as any;
    this.traceViewerModalComponent = null as any;
    this.commentaryEditor = null;
    this.discussionMessagesContainer = null as any;
    
    // Clear event access users
    this.eventAccessUsers = [];
    this.isLoadingEventAccessUsers = false;
    this.isEventAccessUsersExpanded = false;
  }

  private loadEventDetails(): void {
    try {
      const eventId = this.route.snapshot.paramMap.get('id');
      
      if (!eventId) {
        console.error('[loadEventDetails] Missing event ID in route parameters');
        this.error = this.translateService.instant('EVENTELEM.MISSING_EVENT_ID');
        this.loading = false;
        // Don't navigate - show error instead
        return;
      }

      // Load current user
      try {
        this.user = this.membersService.getUser();
      } catch (userError) {
        console.error('[loadEventDetails] Error getting user:', userError);
        // Continue anyway - user might be null but we can still try to load event
      }

    // Load event details
    const subscription = this.evenementsService.getEvenement(eventId).subscribe({
      next: (evenement: Evenement) => {
        try {
          this.evenement = evenement;

          // Re-apply event color after event is loaded to ensure it's available
          try {
            this.applyEventColor();
          } catch (colorError) {
            console.error('Error applying event color:', colorError);
          }

          // Load friend groups only after event loaded (avoids 401 from friend groups redirecting before 403 message)
          try {
            this.loadFriendGroups();
          } catch (friendError) {
            console.error('Error loading friend groups:', friendError);
          }

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

          // Prepare photo gallery with error handling
          try {
            this.preparePhotoGallery();
          } catch (photoError) {
            console.error('Error preparing photo gallery:', photoError);
            // Don't let photo gallery errors prevent page from loading
          }

          // Update background image after photo gallery is prepared
          const t1 = setTimeout(() => {
            try {
              this.updateBackgroundImageUrl();
            } catch (bgError) {
              console.error('Error updating background image:', bgError);
            }
          }, 0);
          this.trackTimeout(t1);

          this.loading = false;

          // Reset grid packing algorithm for optimal card placement
          try {
            this.resetGridPacking();
          } catch (gridError) {
            console.error('Error resetting grid:', gridError);
            // Don't let grid errors prevent page from loading
          }

          // Initialize grid after reset to prepare for card placement
          // Note: initializeGrid() will be called automatically by getCardGridPosition when needed
          
          // Load video URLs with a small delay to ensure authentication is ready
          const t2 = setTimeout(() => {
            try {
              this.loadVideoUrls();
            } catch (videoError) {
              console.error('Error loading video URLs:', videoError);
            }
          }, 100);
          this.trackTimeout(t2);

          // Load discussion messages if discussionId exists
          if (evenement.discussionId) {
            try {
              this.loadDiscussionMessages();
            } catch (discussionError) {
              console.error('Error loading discussion messages:', discussionError);
              // Don't let discussion errors prevent page from loading or cause navigation
            }
          }

          // Load event access users
          try {
            this.loadEventAccessUsers();
          } catch (accessError) {
            console.error('Error loading event access users:', accessError);
            // Don't let access user errors prevent page from loading or cause navigation
          }
        } catch (mainError) {
          // Catch any unexpected errors in the main next handler
          console.error('Unexpected error in event load success handler:', mainError);
          // Set error state but don't navigate - let user see the error
          this.error = this.translateService.instant('EVENTELEM.ERROR_LOADING_EVENT') || 'Error loading event details';
          this.loading = false;
          // Don't navigate - stay on page to show error
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
        
        // Handle 403 Forbidden - user doesn't have access: show "ask owner" message with owner name/email
        if (error?.status === 403) {
          const body = error?.error;
          this.accessDenied = true;
          this.accessDeniedOwnerName = (body?.ownerName != null && String(body.ownerName).trim()) ? String(body.ownerName).trim() : null;
          this.accessDeniedOwnerEmail = (body?.ownerEmail != null && String(body.ownerEmail).trim()) ? String(body.ownerEmail).trim() : null;
          this.accessDeniedEventName = (body?.eventName != null && String(body.eventName).trim()) ? String(body.eventName).trim() : null;
          this.error = ''; // Message is rendered in template with translate pipe so it follows current language
          this.loading = false;
          return;
        }
        
        // Handle status 0 errors (network/CORS issues)
        if (error?.status === 0 || error?.status === null) {
          const apiBase = (environment && (environment as any).API_URL) || 'http://localhost:8000/api/';
          console.error(
            'Network error (status 0): Backend unreachable or CORS. Ensure the backend is running at',
            apiBase.replace(/\/api\/?$/, ''),
            '— e.g. start the Spring Boot app (PatTool_Back-End).'
          );
          this.error = this.translateService.instant('EVENTELEM.ERROR_CONNECTING');
        } else if (error?.status === 404) {
          this.error = this.translateService.instant('EVENTELEM.EVENT_NOT_FOUND');
        } else {
          this.error = this.translateService.instant('EVENTELEM.ERROR_LOADING_EVENT');
        }
        this.loading = false;
      }
    });
    
      // Track the subscription to ensure proper cleanup
      this.trackSubscription(subscription);
    } catch (loadError) {
      // Catch any synchronous errors in loadEventDetails
      console.error('[loadEventDetails] Unexpected error:', loadError);
      this.error = this.translateService.instant('EVENTELEM.ERROR_LOADING_EVENT') || 'Error loading event';
      this.loading = false;
      // Don't navigate - stay on page to show error
    }
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

  /** Opens the add-link form with type "WEBSITE" and scrolls to the URLs card. */
  public startAddWebLink(): void {
    if (!this.user) {
      this.user = this.membersService.getUser();
    }
    this.isAddingUrlEvent = true;
    this.newUrlEvent = new UrlEvent("WEBSITE", new Date(), this.user?.userName || "", "", "");
    this.cdr.detectChanges();
    const scrollTimeout = setTimeout(() => {
      this.urlsCardRef?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
    this.trackTimeout(scrollTimeout);
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
      alert(this.translateService.instant('EVENTELEM.UNAUTHORIZED_DELETE_LINK'));
      return;
    }

    if (!confirm(this.translateService.instant('EVENTHOME.DELETE_LINK_CONFIRM') || 'Supprimer ce lien ?')) {
      return;
    }

    this.evenement.urlEvents.splice(idx, 1);
    this.persistEventChanges();
  }

  /** Open link in a new browser window/tab */
  public openUrlInNewWindow(url: string): void {
    if (!url || !url.trim()) return;
    this.nativeWindow?.open(url.trim(), '_blank', 'noopener,noreferrer');
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
      alert(this.translateService.instant('EVENTELEM.UNAUTHORIZED_DELETE_COMMENTARY'));
      return;
    }

    if (!confirm(this.translateService.instant('EVENTHOME.DELETE_COMMENTARY_CONFIRM') || 'Supprimer ce commentaire ?')) {
      return;
    }

    this.evenement.commentaries.splice(index, 1);
    this.persistEventChanges();
  }

  // New methods for CommentaryEditor component
  public onCommentaryAdded(commentary: Commentary): void {
    if (!this.evenement || !this.evenement.id) return;
    
    const sub = this.evenementsService.addCommentary(this.evenement.id, commentary).subscribe({
      next: (updatedEvent) => {
        if (updatedEvent && updatedEvent.commentaries) {
          this.evenement!.commentaries = updatedEvent.commentaries;
        }
      },
      error: (error) => {
        console.error('Error adding commentary:', error);
        alert(this.translateService.instant('EVENTELEM.ERROR_ADDING_COMMENTARY'));
      }
    });
    this.trackSubscription(sub);
  }

  public onCommentaryUpdated(event: { commentId: string; commentary: Commentary }): void {
    if (!this.evenement || !this.evenement.id) return;
    
    const sub = this.evenementsService.updateCommentary(this.evenement.id, event.commentId, event.commentary).subscribe({
      next: (updatedEvent) => {
        if (updatedEvent && updatedEvent.commentaries) {
          this.evenement!.commentaries = updatedEvent.commentaries;
        }
      },
      error: (error) => {
        console.error('Error updating commentary:', error);
        alert(this.translateService.instant('EVENTELEM.ERROR_UPDATING_COMMENTARY'));
      }
    });
    this.trackSubscription(sub);
  }

  public onCommentaryDeleted(commentId: string): void {
    if (!this.evenement || !this.evenement.id) return;
    
    const sub = this.evenementsService.deleteCommentary(this.evenement.id, commentId).subscribe({
      next: (updatedEvent) => {
        if (updatedEvent && updatedEvent.commentaries) {
          this.evenement!.commentaries = updatedEvent.commentaries;
        }
      },
      error: (error) => {
        console.error('Error deleting commentary:', error);
        alert(this.translateService.instant('EVENTELEM.ERROR_DELETING_COMMENTARY'));
      }
    });
    this.trackSubscription(sub);
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
    
    // Update background image after photo items are created (but before async loading)
    this.updateBackgroundImageUrl();
    
    // Load images with authentication
    imageFiles.forEach(file => {
      this.loadImageFromFile(file.fieldId);
    });

    // Start autoplay for photo gallery if enabled
    // Wait a bit for images to start loading, then start autoplay
    if (imageFiles.length > 1) {
      setTimeout(() => {
        if (this.isPhotoGalleryAutoplay && this.photoItemsList.length > 1) {
          this.startPhotoGalleryAutoplay();
        }
      }, 1000);
    }

    // Load PHOTOFROMFS images
    this.loadAllPhotofromfsImages();
  }

  // Load images for all PHOTOFROMFS links
  private loadAllPhotofromfsImages(): void {
    if (!this.evenement) {
      return;
    }

    const photofromfsLinks = this.getPhotoFromFsUrlEvents();
    photofromfsLinks.forEach(urlEvent => {
      if (urlEvent.link) {
        this.loadPhotofromfsImages(urlEvent.link);
      }
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
          // Update background image if this is the first photo or thumbnail
          // Use setTimeout to defer to next change detection cycle
          setTimeout(() => {
            this.updateBackgroundImageUrl();
            this.cdr.markForCheck();
          }, 0);
          
          // Start autoplay when first few images are loaded (progressive start)
          const loadedCount = this.photoItems.filter(item => {
            const url = (item.imageUrl as any)?.changingThisBreaksApplicationSecurity;
            return url && url.startsWith('blob:');
          }).length;
          
          if (loadedCount >= 2 && this.isPhotoGalleryAutoplay && !this.photoGalleryAutoplayInterval && this.photoItems.length > 1) {
            this.startPhotoGalleryAutoplay();
          }
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
          // Use markForCheck to schedule change detection for next cycle
          this.cdr.markForCheck();
              // Use markForCheck to schedule change detection for next cycle
              this.cdr.markForCheck();
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
          // Use markForCheck to schedule change detection for next cycle
          this.cdr.markForCheck();
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

  // Open WhatsApp link for the friend group (legacy method - kept for backward compatibility)
  public openFriendGroupWhatsAppLinkLegacy(): void {
    const whatsappLink = this.getFriendGroupWhatsAppLink();
    if (whatsappLink) {
      this.winRef.getNativeWindow().open(whatsappLink, '_blank');
    }
  }

  // Get visibility display text (for friend groups)
  public getVisibilityDisplayText(): string {
    if (!this.evenement) {
      return '';
    }
    
    // Check if visibility is friend groups mode
    if (this.evenement.visibility === 'friendGroups') {
      const groupNames = this.getEventFriendGroupNames();
      if (groupNames.length > 0) {
        return groupNames.join(', ');
      }
    }
    
    // If visibility is a friend group name (old format - not public, private, or friends), return it as-is
    if (this.evenement.visibility && 
        this.evenement.visibility !== 'public' && 
        this.evenement.visibility !== 'private' && 
        this.evenement.visibility !== 'friends' &&
        this.evenement.visibility !== 'friendGroups') {
      return this.evenement.visibility;
    }
    
    // Fallback to visibility value
    return this.evenement.visibility || '';
  }

  // Get all friend groups for this event
  public getEventFriendGroups(): FriendGroup[] {
    if (!this.evenement) {
      return [];
    }
    
    const groups: FriendGroup[] = [];
    
    // Get all group IDs from the event
    const groupIds: string[] = [];
    
    // Check new format: friendGroupIds (list of group IDs)
    if (this.evenement.friendGroupIds && this.evenement.friendGroupIds.length > 0) {
      groupIds.push(...this.evenement.friendGroupIds);
    }
    // Check old format: friendGroupId (single group ID) - for backward compatibility
    else if (this.evenement.friendGroupId) {
      groupIds.push(this.evenement.friendGroupId);
    }
    
    // Get all groups for all group IDs
    for (const groupId of groupIds) {
      const group = this.friendGroups.find(g => g.id === groupId);
      if (group) {
        groups.push(group);
      }
    }
    
    return groups;
  }

  // Get all friend group names for this event
  public getEventFriendGroupNames(): string[] {
    return this.getEventFriendGroups().map(g => g.name);
  }

  // Open WhatsApp link for a specific friend group
  public openFriendGroupWhatsAppLink(group: FriendGroup): void {
    if (group.whatsappLink && group.whatsappLink.trim().length > 0) {
      this.winRef.getNativeWindow().open(group.whatsappLink, '_blank');
    }
  }

  // Load event access users
  private loadEventAccessUsers(): void {
    if (!this.evenement?.id) {
      return;
    }
    
    this.isLoadingEventAccessUsers = true;
    this.eventAccessUsers = [];
    this.isEventAccessUsersExpanded = false;
    // Mark for check to prevent ExpressionChangedAfterItHasBeenCheckedError
    this.cdr.markForCheck();
    
    const subscription = this.evenementsService.getEventAccessUsers(this.evenement.id).subscribe({
      next: (users: any[]) => {
        // Convert response to Member objects
        this.eventAccessUsers = users.map((user: any) => {
          // Convert roles from string to array if needed
          let rolesArray: string[] = [];
          if (user.roles) {
            if (typeof user.roles === 'string') {
              rolesArray = user.roles.split(',').map((r: string) => r.trim()).filter((r: string) => r.length > 0);
            } else if (Array.isArray(user.roles)) {
              rolesArray = user.roles;
            }
          }
          return new Member(
            user.id || '',
            user.addressEmail || '',
            user.firstName || '',
            user.lastName || '',
            user.userName || '',
            rolesArray,
            user.keycloakId || '',
            user.registrationDate ? new Date(user.registrationDate) : undefined,
            user.lastConnectionDate ? new Date(user.lastConnectionDate) : undefined,
            user.locale || undefined,
            user.whatsappLink || undefined,
            user.visible !== undefined ? user.visible : true
          );
        });
        this.isLoadingEventAccessUsers = false;
        // Mark for check to prevent ExpressionChangedAfterItHasBeenCheckedError
        this.cdr.markForCheck();
      },
      error: (error) => {
        // Log error but don't let it affect the page display
        // 403 errors are expected if user doesn't have permission to view access users
        // Don't navigate away or show error - just silently fail
        if (error?.status !== 403 && error?.status !== 401) {
          console.error('Error loading event access users:', error);
        }
        this.eventAccessUsers = [];
        this.isLoadingEventAccessUsers = false;
        // Mark for check to prevent ExpressionChangedAfterItHasBeenCheckedError
        this.cdr.markForCheck();
        // Don't propagate error - this is a non-critical feature
      }
    });
    
    this.activeSubscriptions.add(subscription);
  }

  // Toggle event access users expanded/collapsed
  public toggleEventAccessUsersExpanded(): void {
    this.isEventAccessUsersExpanded = !this.isEventAccessUsersExpanded;
    // Mark for check to prevent ExpressionChangedAfterItHasBeenCheckedError
    this.cdr.markForCheck();
  }

  // Open user WhatsApp link
  public openUserWhatsAppLink(user: Member): void {
    if (user.whatsappLink) {
      this.winRef.getNativeWindow().open(user.whatsappLink, '_blank');
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
      
      // Reload discussion messages when modal is closed
      const closedSubscription = modalRef.closed.subscribe(() => {
        this.loadDiscussionMessages();
        this.cdr.markForCheck();
      });
      this.trackSubscription(closedSubscription);
    } catch (error) {
      console.error('Error opening discussion modal:', error);
    }
  }

  // Open discussion if available, create it if it doesn't exist
  public openDiscussion(): void {
    if (!this.evenement) {
      return;
    }

    // If discussion doesn't exist, create it first
    if (!this.evenement.discussionId) {
      const discussionTitle = this.evenement.evenementName || 'Discussion';
      const createSub = this.discussionService.createDiscussion(discussionTitle).subscribe({
        next: (discussion) => {
          if (discussion && discussion.id) {
            const discussionId = discussion.id;
            this.evenement!.discussionId = discussionId;
            const putSub = this.evenementsService.putEvenement(this.evenement!).subscribe({
              next: () => {
                // Now open the discussion modal
                this.openDiscussionModal(discussionId);
              },
              error: (error) => {
                console.error('Error updating event with discussionId:', error);
                const errorMessage = error?.error?.message || error?.message || '';
                // Check if it's the PHOTOFROMFS authorization error
                if (errorMessage.includes('Photo from File System') || errorMessage.includes('PHOTOFROMFS')) {
                  // This is expected - user doesn't have permission to update events with PHOTOFROMFS links
                  // But they can still create and use discussions
                  // The discussion is created and works, we just can't persist the link in the event
                  console.warn('Discussion created successfully (ID: ' + discussionId + ') but cannot be linked to event due to PHOTOFROMFS permissions. Discussion is still usable.');
                  // Revert the local change since update failed
                  this.evenement!.discussionId = undefined;
                  // Still open the modal - the discussion exists and works independently
                  this.openDiscussionModal(discussionId);
                } else {
                  // Other error - show alert but still try to use the discussion
                  const fullErrorMessage = errorMessage || 'Erreur lors de la mise à jour de l\'événement';
                  console.warn('Error linking discussion to event:', fullErrorMessage);
                  // Revert the local change since update failed
                  this.evenement!.discussionId = undefined;
                  // Still open the modal - the discussion exists and works
                  this.openDiscussionModal(discussionId);
                }
              }
            });
            this.trackSubscription(putSub);
          } else {
            const errorMsg = 'Erreur: La discussion n\'a pas pu être créée (aucun ID retourné)';
            console.error(errorMsg);
            alert(errorMsg);
          }
        },
        error: (error) => {
          console.error('Error creating discussion:', error);
          const errorMessage = error?.error?.message || error?.message || this.translateService.instant('COMMUN.ERROR');
          const errorDetails = error?.error?.error || error?.statusText || '';
          const baseMessage = this.translateService.instant('EVENTELEM.ERROR_CREATING_DISCUSSION');
          alert(baseMessage + ':\n' + errorMessage + (errorDetails ? '\n' + errorDetails : ''));
        }
      });
      this.trackSubscription(createSub);
    } else {
      // Discussion exists, open it directly
      this.openDiscussionModal(this.evenement.discussionId);
    }
  }

  // Helper method to open the discussion modal
  private openDiscussionModal(discussionId: string): void {
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
        modalRef.componentInstance.discussionId = discussionId;
        modalRef.componentInstance.title = this.evenement!.evenementName || 'Discussion';
        
        // Get event color for modal styling
        const eventId = this.evenement!.id || '';
        const eventColor = this.eventColorService.getEventColor(eventId);
        if (eventColor) {
          modalRef.componentInstance.eventColor = eventColor;
          // Force color application after a short delay to ensure modal is rendered
          const timeoutId = setTimeout(() => {
            if (modalRef.componentInstance) {
              modalRef.componentInstance.applyEventColorToModal();
            }
          }, 300);
          this.trackTimeout(timeoutId);
        }
      } else {
        const errorMsg = 'Erreur: Impossible d\'ouvrir la fenêtre de discussion';
        console.error(errorMsg);
        alert(errorMsg);
      }
      
      // Reload discussion messages when modal is closed
      const closedSubscription = modalRef.closed.subscribe(() => {
        this.loadDiscussionMessages();
        this.cdr.markForCheck();
      });
      this.trackSubscription(closedSubscription);
    } catch (error: any) {
      console.error('Error opening discussion modal:', error);
      const errorMessage = error?.message || this.translateService.instant('EVENTELEM.ERROR_OPENING_DISCUSSION');
      alert(this.translateService.instant('COMMUN.ERROR') + ': ' + errorMessage);
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
        
        // Handle 403 Forbidden - user doesn't have access to discussion
        // Don't show error, just silently fail (discussion card won't show)
        if (error?.status === 403 || error?.status === 401) {
          this.isLoadingDiscussion = false;
          this.discussionMessages = [];
          this.discussionError = null; // Don't show error for permission issues
          return EMPTY;
        }
        
        // Return empty to prevent redirects for other errors
        this.discussionError = this.translateService.instant('EVENTELEM.ERROR_LOADING_DISCUSSION');
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
            
            // If 404 error, store the filename for error message display
            if (error?.status === 404 && message.id) {
              this.discussionImageErrors.set(message.id, realFilename);
              this.cdr.detectChanges();
            }
            
            // Only store significant errors in localStorage
            // 404 = file not found (expected), 401/403 = auth issues (handled by interceptor)
            // These shouldn't pollute error logs or cause navigation
            if (error?.status !== 404 && error?.status !== 401 && error?.status !== 403) {
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
              
              // Log to console with detailed info for significant errors
              console.error('[DISCUSSION IMAGE LOAD ERROR]', errorInfo);
            }
            
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
            
            // Only store significant errors in localStorage
            // 404 = file not found (expected), 401/403 = auth issues (handled by interceptor)
            // These shouldn't pollute error logs or cause navigation
            if (error?.status !== 404 && error?.status !== 401 && error?.status !== 403) {
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
              
              // Log to console with detailed info for significant errors
              console.error('[DISCUSSION VIDEO LOAD ERROR]', errorInfo);
            }
            
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

  // Handle discussion video loaded
  public onDiscussionVideoLoaded(event: any): void {
    const videoElement = event.target as HTMLVideoElement;
    if (videoElement) {
      videoElement.muted = true; // Ensure muted
      videoElement.play().catch((error) => {
        // Autoplay was prevented - this is normal in some browsers
        // User will need to click play manually
      });
    }
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
    // Use pipe(catchError) to prevent errors from reaching the interceptor and causing redirects
    const subscription = this.discussionService.getFileUrl(this.evenement.discussionId, subfolder, realFilename).pipe(
      catchError((error) => {
        // Catch ALL errors in the pipe to prevent interceptor from redirecting
        // 404 errors are expected (file not found), 401/403 are auth issues handled by interceptor
        // Don't log 404/401/403 errors to avoid console spam
        if (error?.status !== 401 && error?.status !== 404 && error?.status !== 403) {
          console.error('Error loading discussion file:', error);
        }
        // Return empty to prevent error propagation and redirects
        return EMPTY;
      })
    ).subscribe({
      next: (blobUrl: string) => {
        this.discussionFileUrlCache.set(cacheKey, blobUrl);
        // Trigger change detection to update the view
        this.cdr.detectChanges();
      },
      error: (error) => {
        // Should not reach here as errors are caught in pipe
        // But just in case, handle silently
        if (error?.status !== 401 && error?.status !== 404 && error?.status !== 403) {
          console.error('Unexpected error in discussion file subscription:', error);
        }
      }
    });
    
    // Track subscription to ensure proper cleanup
    this.trackSubscription(subscription);

    return '';
  }

  // Check if discussion image has an error (404 - file deleted)
  public hasDiscussionImageError(messageId?: string): boolean {
    return messageId ? this.discussionImageErrors.has(messageId) : false;
  }

  // Get deleted image filename for error message
  public getDeletedImageFilename(messageId?: string): string {
    return messageId ? (this.discussionImageErrors.get(messageId) || '') : '';
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
    // Use pipe(catchError) to prevent errors from reaching the interceptor and causing redirects
    const subscription = this.discussionService.getFileUrl(discussionId, 'images', filename).pipe(
      catchError((error) => {
        // Catch ALL errors in the pipe to prevent interceptor from redirecting
        // 404 errors are expected (file not found), 401/403 are auth issues
        if (error?.status !== 401 && error?.status !== 404 && error?.status !== 403) {
          console.error('Error loading discussion image:', error);
        }
        // Resolve with undefined and return empty to prevent error propagation
        resolve(undefined);
        return EMPTY;
      })
    ).subscribe({
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
        // Should not reach here as errors are caught in pipe
        // But just in case, handle silently
        if (error?.status !== 401 && error?.status !== 404 && error?.status !== 403) {
          console.error('Unexpected error in discussion image subscription:', error);
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
    return this._backgroundImageUrl;
  }
  
  // Update background image URL (called when event or photo gallery changes)
  private updateBackgroundImageUrl(): void {
    if (!this.evenement) {
      this._backgroundImageUrl = 'url("assets/images/images.jpg")';
      return;
    }
    
    // Use thumbnail if available
    if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
      const thumbnailUrl = this.getImageUrl(this.evenement.thumbnail.fieldId);
      const url = (thumbnailUrl as any).changingThisBreaksApplicationSecurity || String(thumbnailUrl);
      if (url && url !== 'assets/images/images.jpg') {
        this._backgroundImageUrl = `url("${url}")`;
        return;
      }
    }
    
    // Use first photo if available
    if (this.photoItemsList && this.photoItemsList.length > 0) {
      const firstPhoto = this.photoItemsList[0];
      const photoUrl = firstPhoto.imageUrl;
      const url = (photoUrl as any).changingThisBreaksApplicationSecurity || String(photoUrl);
      if (url && url !== 'assets/images/images.jpg') {
        this._backgroundImageUrl = `url("${url}")`;
        return;
      }
    }
    
    // Default fallback
    this._backgroundImageUrl = 'url("assets/images/images.jpg")';
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

  private trackTimeout(timeoutId: any): void {
    this.activeTimeouts.add(timeoutId);
  }

  private trackInterval(intervalId: any): void {
    this.activeIntervals.add(intervalId);
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
          alert(this.translateService.instant('EVENTELEM.ERROR_LOADING_PDF'));
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
          alert(this.translateService.instant('EVENTELEM.ERROR_LOADING_IMAGE'));
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
    // This method should ONLY be called by user interaction (button click)
    // Never call this automatically - always show errors instead of navigating away
    this.router.navigate(['/even']);
  }

  /**
   * Returns a mailto: URL to open the user's email client to contact the activity owner (when access denied).
   * Subject includes the activity name; body is pre-filled with "Bonjour &lt;prénom organisateur&gt;" and signed by requester first + last name.
   */
  public getMailToOwnerUrl(): string {
    if (!this.accessDeniedOwnerEmail) {
      return 'mailto:';
    }
    const subjectKey = this.accessDeniedEventName
      ? 'EVENTELEM.SEND_EMAIL_TO_OWNER_SUBJECT_WITH_NAME'
      : 'EVENTELEM.SEND_EMAIL_TO_OWNER_SUBJECT';
    const subject = this.translateService.instant(subjectKey, { eventName: this.accessDeniedEventName || '' });
    const ownerFirstName = this.accessDeniedOwnerName
      ? (this.accessDeniedOwnerName.trim().split(/\s+/)[0] || this.accessDeniedOwnerName.trim())
      : '';
    let requesterFullName = '';
    try {
      if (KeycloakService.auth?.authz?.tokenParsed) {
        const member = this.keycloakService.getUserAsMember();
        requesterFullName = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
      }
    } catch (_) {
      // Not logged in or token not available
    }
    const body = this.translateService.instant('EVENTELEM.SEND_EMAIL_TO_OWNER_BODY', {
      eventName: this.accessDeniedEventName || '',
      ownerFirstName,
      requesterFullName
    });
    const encodedSubject = encodeURIComponent(subject);
    const encodedBody = encodeURIComponent(body);
    return `mailto:${encodeURIComponent(this.accessDeniedOwnerEmail)}?subject=${encodedSubject}&body=${encodedBody}`;
  }

  /**
   * Opens the default email client to send a message to the activity owner (when access denied).
   */
  public openMailToOwner(): void {
    const url = this.getMailToOwnerUrl();
    if (url !== 'mailto:') {
      window.open(url, '_blank');
    }
  }

  // Check if current user is the owner of the event
  public isEventOwner(): boolean {
    if (!this.user || !this.evenement || !this.evenement.author) {
      return false;
    }
    return this.user.userName?.toLowerCase() === this.evenement.author.userName?.toLowerCase();
  }

  // Navigate to update event page
  public navigateToUpdateEvent(): void {
    if (this.evenement && this.evenement.id) {
      this.router.navigate(['/updeven', this.evenement.id]);
    }
  }

  // Open WhatsApp share modal
  public shareOnWhatsApp(): void {
    if (!this.evenement || !this.evenement.id) {
      return;
    }
    
    // Set default message inviting to see the activity
    this.whatsappShareMessage = this.translateService.instant('EVENTELEM.DEFAULT_SHARE_MESSAGE');
    
    // Open modal
    if (this.whatsappShareModal) {
      this.whatsappShareModalRef = this.modalService.open(this.whatsappShareModal, {
        size: 'lg',
        centered: true,
        windowClass: 'whatsapp-share-modal'
      });
    }
  }

  // Get main event image URL
  public getMainEventImageUrl(): SafeUrl {
    if (!this.evenement) {
      return this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
    }
    
    // Use thumbnail if available
    if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
      return this.getImageUrl(this.evenement.thumbnail.fieldId);
    }
    
    // Use first photo if available
    if (this.photoItemsList && this.photoItemsList.length > 0) {
      return this.photoItemsList[0].imageUrl;
    }
    
    // Default fallback
    return this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
  }

  // Get main event image URL as string (for sharing)
  public getMainEventImageUrlString(): string {
    if (!this.evenement) {
      return '';
    }
    
    // Use thumbnail if available
    if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
      return `${this.API_URL4FILE}/file/${this.evenement.thumbnail.fieldId}`;
    }
    
    // Use first photo if available
    if (this.photoItemsList && this.photoItemsList.length > 0) {
      const firstPhoto = this.photoItemsList[0];
      if (firstPhoto.file && firstPhoto.file.fieldId) {
        return `${this.API_URL4FILE}/file/${firstPhoto.file.fieldId}`;
      }
    }
    
    return '';
  }

  // Get event URL
  public getEventUrl(): string {
    if (!this.evenement || !this.evenement.id) {
      return '';
    }
    return window.location.origin + '/#' + this.router.url;
  }

  // Confirm WhatsApp share
  public async confirmWhatsAppShare(): Promise<void> {
    if (!this.evenement || !this.evenement.id) {
      return;
    }
    
    // Get the current URL
    const currentUrl = window.location.origin + '/#' + this.router.url;
    
    // Get image fieldId if available
    let imageFieldId: string | null = null;
    if (this.evenement.thumbnail && this.evenement.thumbnail.fieldId) {
      imageFieldId = this.evenement.thumbnail.fieldId;
    } else if (this.photoItemsList && this.photoItemsList.length > 0) {
      imageFieldId = this.photoItemsList[0].file.fieldId;
    }
    
    // Build the message with clickable title
    // In WhatsApp, URLs are automatically clickable when properly formatted
    // Format: Title in bold, then clickable URL on separate line, then optional message
    let message = `*${this.evenement.evenementName || 'Activité'}*\n\n`;
    // Ensure URL is on its own line with proper spacing for WhatsApp Web to detect it as clickable
    message += `${currentUrl}\n\n`;
    
    // Add optional user message
    if (this.whatsappShareMessage && this.whatsappShareMessage.trim()) {
      message += `${this.whatsappShareMessage.trim()}`;
    }
    
    // Try to use Web Share API first (supports images on mobile)
    // This allows sharing image and text together in the same message
    if (navigator.share && imageFieldId) {
      try {
        // Get image blob using authenticated file service
        const imageBlob = await new Promise<Blob | null>((resolve) => {
          const sub = this.fileService.getFile(imageFieldId!).subscribe({
            next: (res: any) => {
              // Try to detect MIME type from response or default to jpeg
              let mimeType = 'image/jpeg';
              if (res instanceof Blob && res.type) {
                mimeType = res.type;
              }
              const blob = new Blob([res], { type: mimeType });
              resolve(blob);
            },
            error: (error) => {
              console.log('Error fetching image for share:', error);
              resolve(null);
            }
          });
          this.trackSubscription(sub);
          // Timeout after 5 seconds
          const timeoutId = setTimeout(() => {
            if (!sub.closed) {
              sub.unsubscribe();
              resolve(null);
            }
          }, 5000);
          this.trackTimeout(timeoutId);
        });
        
        if (imageBlob) {
          // Determine file extension from MIME type
          let extension = 'jpg';
          if (imageBlob.type.includes('png')) extension = 'png';
          else if (imageBlob.type.includes('gif')) extension = 'gif';
          else if (imageBlob.type.includes('webp')) extension = 'webp';
          
          const fileName = `event-image.${extension}`;
          const file = new File([imageBlob], fileName, { type: imageBlob.type });
          
          // Try to share with image and text together
          // The image will appear first, then the text message
          if (navigator.canShare && navigator.canShare({ files: [file], text: message })) {
            await navigator.share({
              title: this.evenement.evenementName || 'Activité',
              text: message,
              files: [file]
            });
            
            // Close modal
            if (this.whatsappShareModalRef) {
              this.whatsappShareModalRef.close();
              this.whatsappShareModalRef = null;
            }
            return;
          }
        }
      } catch (shareError) {
        console.log('Web Share API failed, falling back to wa.me:', shareError);
        // Fall through to wa.me method
      }
    }
    
    // Fallback to wa.me (standard WhatsApp share)
    // Ensure URL is on its own line for better clickability in WhatsApp Web
    // The URL will create a preview if the page has Open Graph meta tags
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    
    // Close modal
    if (this.whatsappShareModalRef) {
      this.whatsappShareModalRef.close();
      this.whatsappShareModalRef = null;
    }
    
    // Open WhatsApp in a new window/tab
    window.open(whatsappUrl, '_blank');
  }

  // Cancel WhatsApp share
  public cancelWhatsAppShare(): void {
    this.whatsappShareMessage = '';
    if (this.whatsappShareModalRef) {
      this.whatsappShareModalRef.close();
      this.whatsappShareModalRef = null;
    }
  }

  // --- Share by Email ---
  public openShareByEmailModal(): void {
    this.shareByEmailPatToolSelected = (this.eventAccessUsers || [])
      .map(m => m.addressEmail)
      .filter((email): email is string => !!email && email.trim().length > 0);
    this.syncShareByEmailSelectedSet();
    this.shareByEmailExternalEmails = '';
    this.shareByEmailMessage = '';
    this.shareByEmailError = null;
    this.shareByEmailSuccess = null;
    this.shareByEmailAllMembers = [];
    this.shareByEmailLoading = true;
    // Langue du mail par défaut = langue de l'appli (celle choisie dans le menu principal)
    const appLang = this.translateService.currentLang || this.translateService.defaultLang || 'fr';
    const supported = this.shareByEmailMailLangOptions.map(o => o.code);
    this.shareByEmailMailLang = supported.includes(appLang) ? appLang : 'fr';
    this.cdr.markForCheck();
    const sub = this.membersService.getListMembers().subscribe({
      next: (members: Member[]) => {
        const visibleOnly = (members || []).filter(m => m.visible !== false);
        this.shareByEmailAllMembers = visibleOnly.slice().sort((a, b) => {
          const cmpFirst = (a.firstName || '').toLowerCase().localeCompare((b.firstName || '').toLowerCase());
          if (cmpFirst !== 0) return cmpFirst;
          return (a.lastName || '').toLowerCase().localeCompare((b.lastName || '').toLowerCase());
        });
        this.shareByEmailLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.shareByEmailLoading = false;
        this.shareByEmailError = this.translateService.instant('EVENTELEM.SHARE_MAIL_LOAD_ERROR');
        this.cdr.markForCheck();
      }
    });
    this.activeSubscriptions.add(sub);
    if (this.shareByEmailModal) {
      this.shareByEmailModalRef = this.modalService.open(this.shareByEmailModal, {
        size: 'lg',
        centered: true,
        windowClass: 'share-by-email-modal'
      });
    }
  }

  public closeShareByEmailModal(): void {
    if (this.shareByEmailModalRef) {
      this.shareByEmailModalRef.close();
      this.shareByEmailModalRef = null;
    }
  }

  public toggleShareByEmailUser(email: string): void {
    const idx = this.shareByEmailPatToolSelected.indexOf(email);
    if (idx === -1) {
      this.shareByEmailPatToolSelected = [...this.shareByEmailPatToolSelected, email];
    } else {
      this.shareByEmailPatToolSelected = this.shareByEmailPatToolSelected.filter(e => e !== email);
    }
    this.syncShareByEmailSelectedSet();
  }

  private syncShareByEmailSelectedSet(): void {
    this.shareByEmailPatToolSelectedSet = new Set(this.shareByEmailPatToolSelected || []);
  }

  /** Select all users who have access to the activity. */
  public shareByEmailSelectAllWithAccess(): void {
    const accessEmails = (this.eventAccessUsers || [])
      .map(m => m.addressEmail)
      .filter((email): email is string => !!email && email.trim().length > 0);
    this.shareByEmailPatToolSelected = [...new Set([...this.shareByEmailPatToolSelected, ...accessEmails])];
    this.syncShareByEmailSelectedSet();
    this.cdr.markForCheck();
  }

  /** Deselect all PatTool users. */
  public shareByEmailDeselectAll(): void {
    this.shareByEmailPatToolSelected = [];
    this.syncShareByEmailSelectedSet();
    this.cdr.markForCheck();
  }

  public getShareByEmailHeaderStyle(): { [key: string]: string } {
    const color = this.getLightenedCalculatedColor();
    if (!color) {
      return { backgroundColor: '#0d6efd' };
    }
    return {
      backgroundColor: `rgb(${color.r}, ${color.g}, ${color.b})`
    };
  }

  public sendShareByEmail(): void {
    if (!this.evenement?.id) return;
    const emails: string[] = [...this.shareByEmailPatToolSelected];
    const external = (this.shareByEmailExternalEmails || '')
      .split(/[\s,;]+/)
      .map(e => e.trim())
      .filter(e => e.length > 0);
    emails.push(...external);
    emails.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (emails.length === 0) {
      this.shareByEmailError = this.translateService.instant('EVENTELEM.SHARE_MAIL_NO_RECIPIENTS');
      this.cdr.markForCheck();
      return;
    }
    this.shareByEmailError = null;
    this.shareByEmailSuccess = null;
    this.shareByEmailSending = true;
    this.cdr.markForCheck();
    const color = this.getLightenedCalculatedColor() || undefined;
    const eventUrl = this.getEventUrl() || undefined;
    const eventTypeLabel = this.evenement.type != null
      ? this.translateService.instant(this.getEventTypeLabel(this.evenement.type))
      : undefined;
    const senderName = this.user
      ? [this.user.firstName, this.user.lastName].filter(Boolean).join(' ').trim() || this.user.userName || this.user.addressEmail || ''
      : '';
    const sub = this.evenementsService.shareEventByEmail(
      this.evenement.id,
      emails,
      this.shareByEmailMessage || undefined,
      color ? { r: color.r, g: color.g, b: color.b } : undefined,
      eventUrl,
      eventTypeLabel,
      senderName || undefined,
      this.shareByEmailMailLang || 'fr'
    ).subscribe({
      next: (res) => {
        this.shareByEmailSending = false;
        this.shareByEmailSuccess = this.translateService.instant('EVENTELEM.SHARE_MAIL_SENT', { sent: res.sent, total: res.total });
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.shareByEmailSending = false;
        this.shareByEmailError = err?.error?.error || err?.message || this.translateService.instant('EVENTELEM.SHARE_MAIL_SEND_ERROR');
        this.cdr.markForCheck();
      }
    });
    this.activeSubscriptions.add(sub);
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
    
    // Force play() programmatically to ensure video starts
    const videoElement = event.target as HTMLVideoElement;
    if (videoElement) {
      videoElement.muted = true; // Ensure muted
      videoElement.play().catch((error) => {
        // Autoplay was prevented - this is normal in some browsers
        // User will need to click play manually
      });
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

  // Get sorted type keys for consistent display order (excluding PHOTOFROMFS)
  public getSortedTypeKeys(): string[] {
    const grouped = this.getGroupedUrlEvents();
    const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'VIDEO', 'PHOTOS', 'OTHER'];
    return typeOrder.filter(type => grouped[type] && grouped[type].length > 0);
  }

  // Get PHOTOFROMFS links only
  public getPhotoFromFsUrlEvents(): UrlEvent[] {
    if (!this.evenement || !this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
      return [];
    }
    return this.evenement.urlEvents.filter(urlEvent => this.isPhotoFromFs(urlEvent));
  }

  // Get count of non-PHOTOFROMFS links for URLs card
  public getNonPhotoFromFsUrlEventsCount(): number {
    if (!this.evenement || !this.evenement.urlEvents || this.evenement.urlEvents.length === 0) {
      return 0;
    }
    return this.evenement.urlEvents.filter(urlEvent => !this.isPhotoFromFs(urlEvent)).length;
  }

  // Get photo items for a specific PHOTOFROMFS link
  public getPhotofromfsPhotoItems(relativePath: string): Array<{
    fileName: string;
    imageUrl: SafeUrl;
    relativePath: string;
  }> {
    return this.photofromfsPhotoItems.get(relativePath) || [];
  }

  // Get current photo index for a specific PHOTOFROMFS link
  public getPhotofromfsCurrentPhotoIndex(relativePath: string): number {
    return this.photofromfsCurrentPhotoIndex.get(relativePath) || 0;
  }

  // Check if a PHOTOFROMFS link is loading
  public isPhotofromfsLoading(relativePath: string): boolean {
    return this.photofromfsLoading.get(relativePath) || false;
  }

  // Get cache key for PHOTOFROMFS images (same format as slideshow modal)
  private getPhotofromfsCacheKey(relativePath: string, fileName: string, compress: boolean): string {
    const compressKey = compress ? ':compressed' : ':original';
    return `disk:${relativePath}/${fileName}${compressKey}`;
  }

  // Load images from file system for a specific PHOTOFROMFS link with cache and streaming (like slideshow)
  public loadPhotofromfsImages(relativePath: string, compress: boolean = true): void {
    if (!relativePath || this.photofromfsLoading.get(relativePath)) {
      return;
    }

    // Initialize if not exists
    if (!this.photofromfsPhotoItems.has(relativePath)) {
      this.photofromfsPhotoItems.set(relativePath, []);
      this.photofromfsCurrentPhotoIndex.set(relativePath, 0);
    }

    this.photofromfsLoading.set(relativePath, true);

    // List images from disk
    const listSub = this.fileService.listImagesFromDisk(relativePath).subscribe({
      next: (fileNames: string[]) => {
        if (!fileNames || fileNames.length === 0) {
          this.photofromfsLoading.set(relativePath, false);
          return;
        }

        // Mark loading as false immediately so gallery can display
        this.photofromfsLoading.set(relativePath, false);
        
        // Create placeholder entries for all images immediately (for faster UI update)
        const placeholderImages: Array<{
          fileName: string;
          imageUrl: SafeUrl;
          relativePath: string;
        }> = fileNames.map(fileName => ({
          fileName: fileName,
          imageUrl: this.sanitizer.bypassSecurityTrustUrl(''), // Empty placeholder
          relativePath: relativePath
        }));
        
        this.photofromfsPhotoItems.set(relativePath, placeholderImages);
        this.cdr.markForCheck();

        // Streaming order: index 0 first (visible slide), then 1, 2, 3... like slideshow
        const orderedItems = fileNames.map((fileName, index) => ({ fileName, index }));
        const maxConcurrent = 12;
        let active = 0;
        let queueIndex = 0; // Next index to load (0 = first image, load alone; then 1,2,...)

        const updateItemAtIndex = (fileName: string, imageItem: { fileName: string; imageUrl: SafeUrl; relativePath: string }) => {
          const currentItems = this.photofromfsPhotoItems.get(relativePath) || [];
          const idx = currentItems.findIndex(item => item.fileName === fileName);
          if (idx >= 0) {
            currentItems[idx] = imageItem;
          } else {
            currentItems.push(imageItem);
          }
          this.photofromfsPhotoItems.set(relativePath, [...currentItems]);
          this.cdr.detectChanges();
        };

        const maybeStartAutoplay = () => {
          const currentItems = this.photofromfsPhotoItems.get(relativePath) || [];
          const loadedCount = currentItems.filter(item => {
            const url = (item.imageUrl as any)?.changingThisBreaksApplicationSecurity;
            return url && url.startsWith('blob:') && url.length > 5;
          }).length;
          if (loadedCount >= 2 && !this.photofromfsAutoplayIntervals.has(relativePath)) {
            if (!this.photofromfsAutoplay.has(relativePath)) {
              this.photofromfsAutoplay.set(relativePath, true);
            }
            if (this.photofromfsAutoplay.get(relativePath)) {
              this.startPhotofromfsAutoplay(relativePath);
            }
          }
        };

        const loadOne = (item: { fileName: string; index: number }, onComplete: () => void) => {
          const { fileName } = item;
          const cacheKey = this.getPhotofromfsCacheKey(relativePath, fileName, compress);
          
          if (this.photofromfsImageCache.has(cacheKey)) {
            const cached = this.photofromfsImageCache.get(cacheKey)!;
            const imageItem = { fileName, imageUrl: cached.safeUrl, relativePath };
            updateItemAtIndex(fileName, imageItem);
            maybeStartAutoplay();
            onComplete();
            return;
          }
          if (this.photofromfsLoadingKeys.has(cacheKey)) {
            onComplete();
            return;
          }

          this.photofromfsLoadingKeys.add(cacheKey);
          const imageSub = this.fileService.getImageFromDiskWithMetadata(relativePath, fileName, compress).subscribe({
            next: (result: ImageDownloadResult) => {
              const blob = new Blob([result.buffer], { type: 'image/*' });
              const url = URL.createObjectURL(blob);
              const safeUrl = this.sanitizer.bypassSecurityTrustUrl(url);
              this.photofromfsImageCache.set(cacheKey, { blobUrl: url, blob, safeUrl });
              const imageItem = { fileName, imageUrl: safeUrl, relativePath };
              updateItemAtIndex(fileName, imageItem);
              maybeStartAutoplay();
            },
            error: (err) => {
              console.error('Error loading image:', fileName, err);
              this.photofromfsLoadingKeys.delete(cacheKey);
            },
            complete: () => {
              this.photofromfsLoadingKeys.delete(cacheKey);
              onComplete();
            }
          });
          this.trackSubscription(imageSub);
        };

        // Phase 1: load first image alone (streaming: visible slide appears as soon as possible)
        const runQueue = () => {
          while (active < maxConcurrent && queueIndex < orderedItems.length) {
            const item = orderedItems[queueIndex];
            queueIndex++;
            active++;
            loadOne(item, () => {
              active--;
              if (active === 0 && queueIndex >= orderedItems.length) {
                this.photofromfsLoading.set(relativePath, false);
                this.cdr.markForCheck();
                const currentItems = this.photofromfsPhotoItems.get(relativePath) || [];
                if (currentItems.length > 1 && !this.photofromfsAutoplayIntervals.has(relativePath)) {
                  if (!this.photofromfsAutoplay.has(relativePath)) {
                    this.photofromfsAutoplay.set(relativePath, true);
                  }
                  if (this.photofromfsAutoplay.get(relativePath)) {
                    this.startPhotofromfsAutoplay(relativePath);
                  }
                }
              } else {
                runQueue();
              }
            });
          }
        };

        // Load first image alone first; when done, start the rest with concurrency
        if (orderedItems.length === 0) {
          this.photofromfsLoading.set(relativePath, false);
          this.cdr.markForCheck();
          return;
        }
        loadOne(orderedItems[0], () => {
          queueIndex = 1; // already loaded index 0
          if (queueIndex >= orderedItems.length) {
            // Only one image: we're done
            this.photofromfsLoading.set(relativePath, false);
            this.cdr.markForCheck();
          } else {
            runQueue();
          }
        });
      },
      error: (error) => {
        console.error('Error listing images from disk:', error);
        this.photofromfsLoading.set(relativePath, false);
      }
    });

    this.trackSubscription(listSub);
  }

  // Navigation methods for PHOTOFROMFS galleries
  public nextPhotofromfsPhoto(relativePath: string): void {
    const items = this.getPhotofromfsPhotoItems(relativePath);
    if (items.length > 0) {
      const currentIndex = this.getPhotofromfsCurrentPhotoIndex(relativePath);
      const newIndex = (currentIndex + 1) % items.length;
      this.photofromfsCurrentPhotoIndex.set(relativePath, newIndex);
    }
  }

  public prevPhotofromfsPhoto(relativePath: string): void {
    const items = this.getPhotofromfsPhotoItems(relativePath);
    if (items.length > 0) {
      const currentIndex = this.getPhotofromfsCurrentPhotoIndex(relativePath);
      const newIndex = currentIndex === 0 ? items.length - 1 : currentIndex - 1;
      this.photofromfsCurrentPhotoIndex.set(relativePath, newIndex);
    }
  }

  public goToPhotofromfsPhoto(relativePath: string, index: number): void {
    const items = this.getPhotofromfsPhotoItems(relativePath);
    if (index >= 0 && index < items.length) {
      this.photofromfsCurrentPhotoIndex.set(relativePath, index);
    }
  }

  // Open maximized slideshow for a specific PHOTOFROMFS link
  public openPhotofromfsMaximized(relativePath: string, startIndex: number = 0): void {
    // Use the existing openFsPhotosDiaporama method which handles the slideshow properly
    this.openFsPhotosDiaporama(relativePath, true, startIndex);
  }

  // Check if photo indicators should be displayed (limit to avoid too many dots)
  public shouldShowPhotoIndicators(count: number): boolean {
    return count > 1; // Show indicators if more than 1 photo (removed 20 limit for now)
  }

  // Autoplay methods for main photo gallery
  public startPhotoGalleryAutoplay(): void {
    this.stopPhotoGalleryAutoplay();
    if (this.photoItemsList.length <= 1) {
      return;
    }
    
    // Check if we have at least one loaded image
    const hasLoadedImages = this.photoItemsList.some(item => {
      const url = (item.imageUrl as any)?.changingThisBreaksApplicationSecurity;
      return url && url.startsWith('blob:');
    });
    
    if (!hasLoadedImages) {
      // Wait a bit for images to load, then try again
      setTimeout(() => {
        if (this.isPhotoGalleryAutoplay && this.photoItemsList.length > 1) {
          this.startPhotoGalleryAutoplay();
        }
      }, 500);
      return;
    }
    
    this.isPhotoGalleryAutoplay = true;
    this.photoGalleryAutoplayInterval = setInterval(() => {
      if (this.photoItemsList.length > 1) {
        this.nextPhoto();
        this.cdr.markForCheck();
      } else {
        this.stopPhotoGalleryAutoplay();
      }
    }, 3000); // Change photo every 3 seconds
    this.trackInterval(this.photoGalleryAutoplayInterval);
  }

  public stopPhotoGalleryAutoplay(): void {
    this.isPhotoGalleryAutoplay = false;
    if (this.photoGalleryAutoplayInterval) {
      clearInterval(this.photoGalleryAutoplayInterval);
      this.photoGalleryAutoplayInterval = null;
    }
  }

  public togglePhotoGalleryAutoplay(): void {
    if (this.isPhotoGalleryAutoplay) {
      this.stopPhotoGalleryAutoplay();
    } else {
      this.startPhotoGalleryAutoplay();
    }
  }

  // Autoplay methods for PHOTOFROMFS galleries
  public startPhotofromfsAutoplay(relativePath: string): void {
    this.stopPhotofromfsAutoplay(relativePath);
    const items = this.getPhotofromfsPhotoItems(relativePath);
    if (items.length <= 1) {
      return;
    }
    
    // Check if we have at least one loaded image
    const hasLoadedImages = items.some(item => {
      const url = (item.imageUrl as any)?.changingThisBreaksApplicationSecurity;
      return url && url.startsWith('blob:') && url.length > 5; // Not empty placeholder
    });
    
    if (!hasLoadedImages) {
      // Wait a bit for images to load, then try again
      setTimeout(() => {
        const currentItems = this.getPhotofromfsPhotoItems(relativePath);
        const isAutoplay = this.photofromfsAutoplay.get(relativePath) ?? true;
        if (isAutoplay && currentItems.length > 1) {
          this.startPhotofromfsAutoplay(relativePath);
        }
      }, 500);
      return;
    }
    
    this.photofromfsAutoplay.set(relativePath, true);
    const interval = setInterval(() => {
      const currentItems = this.getPhotofromfsPhotoItems(relativePath);
      if (currentItems.length > 1) {
        this.nextPhotofromfsPhoto(relativePath);
        this.cdr.markForCheck();
      } else {
        this.stopPhotofromfsAutoplay(relativePath);
      }
    }, 3000); // Change photo every 3 seconds
    this.trackInterval(interval);
    
    this.photofromfsAutoplayIntervals.set(relativePath, interval);
    this.trackInterval(interval);
  }

  public stopPhotofromfsAutoplay(relativePath: string): void {
    this.photofromfsAutoplay.set(relativePath, false);
    const interval = this.photofromfsAutoplayIntervals.get(relativePath);
    if (interval) {
      clearInterval(interval);
      this.photofromfsAutoplayIntervals.delete(relativePath);
    }
  }

  public togglePhotofromfsAutoplay(relativePath: string): void {
    const isAutoplay = this.photofromfsAutoplay.get(relativePath) ?? true;
    if (isAutoplay) {
      this.stopPhotofromfsAutoplay(relativePath);
    } else {
      this.startPhotofromfsAutoplay(relativePath);
    }
  }

  public isPhotofromfsAutoplay(relativePath: string): boolean {
    return this.photofromfsAutoplay.get(relativePath) ?? true;
  }

  // Check if a PHOTOFROMFS image is loaded (has valid blob URL)
  public hasPhotofromfsImageLoaded(imageUrl: SafeUrl): boolean {
    if (!imageUrl) return false;
    const url = (imageUrl as any)?.changingThisBreaksApplicationSecurity;
    return url && url.startsWith('blob:') && url.length > 5;
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

  public getCardLayoutClasses(cardId: 'discussion' | 'photos' | 'urls' | 'comments' | 'pdfs' | 'tracks' | 'upload' | 'description' | 'visibility' | 'type' | 'notes' | 'rating'): string[] {
    const urlsCount = this.evenement?.urlEvents?.length || 0;
    const commentsCount = this.getEventComments().length;
    const photosCount = this.photoItemsList?.length || 0;
    const pdfCount = this.getPdfFiles().length;
    const trackCount = this.getTrackFiles().length;

    switch (cardId) {
      case 'photos': {
        // photos are very visual -> keep large and centered
        // Optimize rowSpan for better interlocking: use even numbers when possible
        const rowSpan = photosCount > 10 ? 4 : (photosCount > 6 ? 3 : 2);
        const colSpan = 2;
        return [this.spanRowClass(rowSpan), this.spanColClass(colSpan)];
      }
      case 'discussion': {
        // discussion benefits from space and should be centered
        // Optimize rowSpan for better interlocking
        const rowSpan = this.discussionMessages.length > 10 ? 4 : (this.discussionMessages.length > 6 ? 3 : 2);
        const colSpan = 2;
        return [this.spanRowClass(rowSpan), this.spanColClass(colSpan)];
      }
      case 'urls': {
        // Optimize size for better fitting: use rowSpan 2 for better interlocking
        const rowSpan = urlsCount === 0 ? 1 : (urlsCount <= 3 ? 2 : (urlsCount <= 6 ? 2 : 3));
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'comments': {
        // Comments card always takes double width (2 columns)
        const rowSpan = commentsCount <= 2 ? 2 : (commentsCount <= 6 ? 2 : (commentsCount <= 10 ? 3 : 3));
        return [this.spanRowClass(rowSpan), this.spanColClass(2)];
      }
      case 'description': {
        // description card - always double width (2 columns)
        const descriptionLength = this.evenement?.comments?.length || 0;
        const rowSpan = descriptionLength > 200 ? 2 : 1;
        return [this.spanRowClass(rowSpan), this.spanColClass(2)];
      }
      case 'visibility': {
        // visibility card - small, but may need more space if has members
        const hasMembers = this.hasEventMembers() || (this.evenement?.friendGroupId && this.getCurrentFriendGroup()?.members && this.getCurrentFriendGroup()!.members.length > 0);
        const rowSpan = hasMembers ? 2 : 1;
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'type': {
        // type card - small to medium based on number of info items
        const infoItemsCount = [this.evenement?.type, this.evenement?.status, this.evenement?.diffculty, this.evenement?.startLocation, this.evenement?.durationEstimation].filter(Boolean).length;
        const rowSpan = infoItemsCount > 3 ? 2 : 1;
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'notes': {
        // notes card - optimize for better fitting
        const notesLength = this.evenement?.notes?.length || 0;
        const rowSpan = notesLength > 300 ? 3 : (notesLength > 150 ? 2 : 2);
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'rating': {
        // rating card - small
        return [this.spanRowClass(1), this.spanColClass(1)];
      }
      case 'pdfs': {
        // Use rowSpan 2 for better interlocking with other cards
        const rowSpan = pdfCount <= 2 ? 2 : (pdfCount <= 4 ? 2 : 3);
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'tracks': {
        // Use rowSpan 2 for better interlocking with other cards
        const rowSpan = trackCount <= 2 ? 2 : (trackCount <= 4 ? 2 : 3);
        return [this.spanRowClass(rowSpan), this.spanColClass(1)];
      }
      case 'upload': {
        return [this.spanRowClass(1), this.spanColClass(1)];
      }
      default:
        return [];
    }
  }

  // Grid packing algorithm - tracks occupied cells
  private gridOccupancy: boolean[][] = [];
  private maxColumns = 4; // Typical number of columns in the grid (auto-fit creates ~4 columns on most screens)
  private processedCards: Set<string> = new Set();

  // Cache for card positions to ensure deterministic placement
  private cardPositionsCache: Map<string, { gridRow?: string, gridColumn?: string }> = new Map();

  /**
   * Get optimal grid position for a card to minimize gaps
   * Uses best-fit algorithm to fill existing gaps before creating new rows
   * Returns CSS grid-row and grid-column values
   */
  public getCardGridPosition(cardId: 'discussion' | 'photos' | 'urls' | 'comments' | 'pdfs' | 'tracks' | 'upload' | 'description' | 'visibility' | 'type' | 'notes' | 'rating'): { gridRow?: string, gridColumn?: string } {
    // First row cards are fixed - let CSS handle first row
    if (cardId === 'description' || cardId === 'visibility' || cardId === 'type' || cardId === 'rating') {
      return {};
    }

    // Check cache first to ensure deterministic placement
    if (this.cardPositionsCache.has(cardId)) {
      return this.cardPositionsCache.get(cardId)!;
    }

    // Initialize grid if not already initialized
    if (this.gridOccupancy.length === 0) {
      this.initializeGrid();
    }

    // Get card layout to determine spans
    const layoutClasses = this.getCardLayoutClasses(cardId);
    const rowSpan = this.getRowSpanFromClasses(layoutClasses);
    const colSpan = this.getColSpanFromClasses(layoutClasses);

    // Find best position using the algorithm
    const position = this.findBestPosition(rowSpan, colSpan);

    if (position) {
      // Mark cells as occupied
      this.markCellsOccupied(position.row, position.col, rowSpan, colSpan);
      
      // Create CSS grid position values (CSS grid is 1-indexed, and we need to handle spans)
      const gridRow = `${position.row} / ${position.row + rowSpan}`;
      const gridColumn = `${position.col} / ${position.col + colSpan}`;
      
      const result = { gridRow, gridColumn };
      
      // Cache the result for deterministic placement
      this.cardPositionsCache.set(cardId, result);
      this.processedCards.add(cardId);
      
      return result;
    }

    // Fallback: return empty (let CSS handle it if algorithm can't find a position)
    return {};
  }

  /**
   * Initialize grid occupancy - first row is occupied by the first-row-cards-container
   * which spans all columns (grid-column: 1 / -1) and occupies row 1 (grid-row: 1)
   * The first-row-cards-container is a nested grid containing description, visibility, type, rating
   * 
   * Note: The first-row-cards-container is explicitly set to grid-row: 1 in CSS, so it occupies
   * only one logical grid row. However, its visual height might be taller based on content.
   * For our algorithm, we mark row 0 (CSS grid row 1) as occupied, and cards will be placed
   * starting from row 2 (index 1 in our tracking).
   */
  private initializeGrid(): void {
    this.gridOccupancy = [];
    this.processedCards.clear();
    
    // Mark row 0 (CSS grid row 1) as fully occupied by first-row-cards-container
    // This container spans all columns (grid-column: 1 / -1) so we mark all columns in row 0
    const firstRow = new Array(this.maxColumns).fill(true);
    this.gridOccupancy.push(firstRow);
    
    // Cards will be placed starting from row 2 (index 1 in our tracking, row 2 in CSS grid)
    // The algorithm's findBestPosition starts from row 1 (index 1), which corresponds to CSS grid row 2
  }

  /**
   * Find the best position for a card using improved best-fit algorithm
   * Prioritizes filling existing gaps over creating new rows
   * Aggressively searches for the highest possible position
   */
  private findBestPosition(rowSpan: number, colSpan: number): { row: number, col: number } | null {
    const candidates: Array<{ row: number, col: number, score: number }> = [];
    
    // Calculate how many columns are actually used (to avoid creating too many columns)
    const actualMaxCol = Math.min(this.maxColumns, this.getMaxUsedColumn() + colSpan + 2);
    
    // Aggressively search ALL possible positions, starting from the top
    // Search much more extensively - up to 20 rows or current max + 5
    const searchLimit = Math.max(this.gridOccupancy.length + 5, 20);
    for (let row = 1; row < searchLimit; row++) {
      // Ensure we have enough rows
      while (this.gridOccupancy.length <= row + rowSpan - 1) {
        this.gridOccupancy.push(new Array(this.maxColumns).fill(false));
      }

      // Try each column position
      // For large cards (colSpan > 1), prefer center positions
      // For small cards, prefer leftmost positions to fill gaps
      // Calculate center based on actual grid width (typically 4 columns)
      const gridWidth = Math.max(actualMaxCol, 4); // Assume at least 4 columns
      const centerCol = Math.floor((gridWidth - colSpan) / 2); // Center position for the card
      
      // Create column order: for large cards, start from center; for small, start from left
      const colOrder: number[] = [];
      if (colSpan > 1) {
        // Large cards: prefer center, then spread outward
        for (let offset = 0; offset <= Math.max(centerCol, actualMaxCol - centerCol); offset++) {
          if (centerCol - offset >= 0 && centerCol - offset + colSpan <= actualMaxCol) {
            colOrder.push(centerCol - offset);
          }
          if (offset > 0 && centerCol + offset + colSpan <= actualMaxCol) {
            colOrder.push(centerCol + offset);
          }
        }
      } else {
        // Small cards: left to right (fill gaps from left)
        for (let col = 0; col <= actualMaxCol - colSpan; col++) {
          colOrder.push(col);
        }
      }

      for (const col of colOrder) {
        if (this.canPlaceCard(row, col, rowSpan, colSpan)) {
          // Score calculation prioritizing positions directly below existing cards:
          // - Has card directly above = MUCH better (biggest priority)
          // - Lower row = better (fills gaps higher up)
          // - Existing row (not new) = better (fills gaps)
          // - For large cards: center position = better
          // - For small cards: leftmost = better
          // - Prefer positions that are adjacent to existing cards (fills gaps better)
          const isExistingRow = row < this.gridOccupancy.length;
          const hasAdjacentCard = this.hasAdjacentCard(row, col, colSpan);
          const hasCardAbove = this.hasCardDirectlyAbove(row, col, colSpan);
          
          // Base row score - MUCH higher weight for lower rows (remonter les cartes)
          // Lower row number = much better score
          const rowScore = row * 100; // Increased from 10 to 100 to prioritize height
          
          // Penalty for new rows (but less important than row position)
          const newRowPenalty = isExistingRow ? 0 : 200; // Reduced from 500
          
          // MASSIVE bonus for cards directly below another card (negative = better)
          const belowCardBonus = hasCardAbove ? -2000 : 0; // Increased from -1000
          
          // Bonus for adjacent cards (helps fill gaps)
          const adjacencyBonus = hasAdjacentCard ? -100 : 0; // Increased from -50
          
          // Center bonus for large cards (less important than height)
          let centerBonus = 0;
          if (colSpan > 1) {
            const distanceFromCenter = Math.abs(col - (centerCol - Math.floor(colSpan / 2)));
            centerBonus = -distanceFromCenter * 2; // Reduced from 5 (height is more important)
          } else {
            // For small cards, prefer leftmost (but less important than height)
            centerBonus = col * 0.5; // Reduced weight
          }
          
          // Calculate distance from nearest card above (closer = much better)
          const distanceFromAbove = this.getDistanceFromCardAbove(row, col, colSpan);
          const proximityBonus = -distanceFromAbove * 50; // Increased from 20 (closer = much better)
          
          // Additional bonus: if this fills a gap between existing cards
          const fillsGap = this.fillsGapBetweenCards(row, col, colSpan);
          const gapFillingBonus = fillsGap ? -300 : 0;
          
          const score = rowScore + newRowPenalty + belowCardBonus + adjacencyBonus + centerBonus + proximityBonus + gapFillingBonus;
          candidates.push({ row: row + 1, col: col + 1, score }); // +1 because grid is 1-indexed
        }
      }
    }

    // If no position found in existing rows, try new rows (but minimize and prefer closest to top)
    if (candidates.length === 0) {
      const startRow = Math.max(this.gridOccupancy.length, 2);
      for (let row = startRow; row < startRow + 3; row++) { // Only try 3 new rows max
        while (this.gridOccupancy.length <= row + rowSpan - 1) {
          this.gridOccupancy.push(new Array(this.maxColumns).fill(false));
        }

        // Calculate center for large cards
        const gridWidth = Math.max(actualMaxCol, 4);
        const centerCol = Math.floor((gridWidth - colSpan) / 2);
        
        // Create column order (same logic as above)
        const colOrder: number[] = [];
        if (colSpan > 1) {
          for (let offset = 0; offset <= Math.max(centerCol, actualMaxCol - centerCol); offset++) {
            if (centerCol - offset >= 0 && centerCol - offset + colSpan <= actualMaxCol) {
              colOrder.push(centerCol - offset);
            }
            if (offset > 0 && centerCol + offset + colSpan <= actualMaxCol) {
              colOrder.push(centerCol + offset);
            }
          }
        } else {
          for (let col = 0; col <= actualMaxCol - colSpan; col++) {
            colOrder.push(col);
          }
        }

        for (const col of colOrder) {
          if (this.canPlaceCard(row, col, rowSpan, colSpan)) {
            // Even for new rows, use the same improved scoring
            const isExistingRow = row < this.gridOccupancy.length;
            const hasAdjacentCard = this.hasAdjacentCard(row, col, colSpan);
            const hasCardAbove = this.hasCardDirectlyAbove(row, col, colSpan);
            const distanceFromAbove = this.getDistanceFromCardAbove(row, col, colSpan);
            const fillsGap = this.fillsGapBetweenCards(row, col, colSpan);
            
            const rowScore = row * 100; // Same high weight for height
            const newRowPenalty = isExistingRow ? 0 : 200;
            const belowCardBonus = hasCardAbove ? -2000 : 0;
            const adjacencyBonus = hasAdjacentCard ? -100 : 0;
            const proximityBonus = -distanceFromAbove * 50;
            const gapFillingBonus = fillsGap ? -300 : 0;
            
            let centerBonus = 0;
            if (colSpan > 1) {
              const distanceFromCenter = Math.abs(col - (centerCol - Math.floor(colSpan / 2)));
              centerBonus = -distanceFromCenter * 2;
            } else {
              centerBonus = col * 0.5;
            }
            
            const score = rowScore + newRowPenalty + belowCardBonus + adjacencyBonus + proximityBonus + gapFillingBonus + centerBonus;
            candidates.push({ row: row + 1, col: col + 1, score });
          }
        }
      }
    }

    // Sort by score (best first) and return the best position
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.score - b.score);
      return { row: candidates[0].row, col: candidates[0].col };
    }

    return null;
  }

  /**
   * Check if there's an adjacent card (helps fill gaps better)
   */
  private hasAdjacentCard(row: number, col: number, colSpan: number): boolean {
    if (row >= this.gridOccupancy.length) return false;
    
    // Check left side
    if (col > 0 && this.gridOccupancy[row][col - 1]) return true;
    
    // Check right side
    if (col + colSpan < this.maxColumns && this.gridOccupancy[row][col + colSpan]) return true;
    
    return false;
  }

  /**
   * Check if there's a card directly above this position
   * This is the most important factor for minimizing gaps
   */
  private hasCardDirectlyAbove(row: number, col: number, colSpan: number): boolean {
    if (row <= 0) return false; // Can't be above row 0
    
    // Check if any cell in the row above, in the same column range, is occupied
    for (let c = col; c < col + colSpan; c++) {
      if (row - 1 < this.gridOccupancy.length && this.gridOccupancy[row - 1][c]) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Calculate the distance from the nearest card above
   * Returns 0 if directly below, or number of empty rows between
   */
  private getDistanceFromCardAbove(row: number, col: number, colSpan: number): number {
    if (row <= 0) return 999; // No card above possible
    
    // Search upward for the nearest card
    for (let r = row - 1; r >= 0; r--) {
      // Check if any cell in this row, in the same column range, is occupied
      for (let c = col; c < col + colSpan; c++) {
        if (r < this.gridOccupancy.length && this.gridOccupancy[r][c]) {
          return row - r - 1; // Distance in rows
        }
      }
    }
    
    return 999; // No card found above
  }

  /**
   * Check if this position fills a gap between existing cards
   * (cards on both sides or above and below)
   */
  private fillsGapBetweenCards(row: number, col: number, colSpan: number): boolean {
    // Check if there are cards on both left and right sides
    const hasLeftCard = col > 0 && row < this.gridOccupancy.length && this.gridOccupancy[row][col - 1];
    const hasRightCard = col + colSpan < this.maxColumns && row < this.gridOccupancy.length && this.gridOccupancy[row][col + colSpan];
    
    // Check if there are cards above and below
    const hasCardAbove = this.hasCardDirectlyAbove(row, col, colSpan);
    const hasCardBelow = row + 1 < this.gridOccupancy.length && 
                         this.gridOccupancy[row + 1] && 
                         this.gridOccupancy[row + 1].some((occupied, c) => c >= col && c < col + colSpan && occupied);
    
    return (hasLeftCard && hasRightCard) || (hasCardAbove && hasCardBelow);
  }

  /**
   * Get the maximum column index that's actually used
   */
  private getMaxUsedColumn(): number {
    let maxCol = 0;
    for (let row = 0; row < this.gridOccupancy.length; row++) {
      for (let col = this.maxColumns - 1; col >= 0; col--) {
        if (this.gridOccupancy[row][col]) {
          maxCol = Math.max(maxCol, col + 1);
          break;
        }
      }
    }
    return maxCol;
  }

  /**
   * Check if a card can be placed at the given position
   */
  private canPlaceCard(startRow: number, startCol: number, rowSpan: number, colSpan: number): boolean {
    for (let r = startRow; r < startRow + rowSpan; r++) {
      if (r >= this.gridOccupancy.length) {
        // New row, it's free
        continue;
      }
      for (let c = startCol; c < startCol + colSpan; c++) {
        if (this.gridOccupancy[r][c]) {
          return false; // Cell is occupied
        }
      }
    }
    return true;
  }

  /**
   * Mark cells as occupied
   */
  private markCellsOccupied(startRow: number, startCol: number, rowSpan: number, colSpan: number): void {
    for (let r = startRow - 1; r < startRow - 1 + rowSpan; r++) { // -1 because grid is 1-indexed
      while (this.gridOccupancy.length <= r) {
        this.gridOccupancy.push(new Array(this.maxColumns).fill(false));
      }
      for (let c = startCol - 1; c < startCol - 1 + colSpan; c++) { // -1 because grid is 1-indexed
        this.gridOccupancy[r][c] = true;
      }
    }
  }

  /**
   * Extract row span from layout classes
   */
  private getRowSpanFromClasses(layout: string[]): number {
    for (const cls of layout) {
      const match = cls.match(/span-row-(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return 1;
  }

  /**
   * Extract column span from layout classes
   */
  private getColSpanFromClasses(layout: string[]): number {
    for (const cls of layout) {
      const match = cls.match(/span-col-(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
    return 1;
  }

  /**
   * Reset grid when data changes (call this when event loads)
   */
  public resetGridPacking(): void {
    this.gridOccupancy = [];
    this.processedCards.clear();
    this.cardPositionsCache.clear();
  }

  public getCardOrder(cardId: 'discussion' | 'photos' | 'urls' | 'comments' | 'pdfs' | 'tracks' | 'upload' | 'description' | 'visibility' | 'type' | 'notes' | 'rating'): number {
    // Smaller number = earlier placement; grid-auto-flow:dense will pack.
    const photosCount = this.photoItemsList?.length || 0;
    const urlsCount = this.evenement?.urlEvents?.length || 0;
    const commentsCount = this.getEventComments().length;

    switch (cardId) {
      case 'description':
        return this.evenement?.comments ? 1 : 99;
      case 'visibility':
        return 1;
      case 'type':
        return 1;
      case 'rating':
        return 1;
      case 'upload':
        return 5; // Place upload card on second row, right after first row cards
      case 'notes':
        return this.evenement?.notes ? 10 : 99;
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
      case 'tracks':
        return this.getTrackFiles().length > 0 ? 56 : 96;
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
      alert(this.translateService.instant('EVENTELEM.UNAUTHORIZED_DELETE_FILE'));
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

        // If deleted file was a video, remove cached URL and size
        if (this.videoUrls.has(fieldId)) {
          this.videoUrls.delete(fieldId);
        }
        if (this.videoUrlCache.has(fieldId)) {
          this.videoUrlCache.delete(fieldId);
        }
        if (this.videoFileSizes.has(fieldId)) {
          this.videoFileSizes.delete(fieldId);
        }

        // Trigger UI refresh
        this.cdr.detectChanges();
      },
      error: (error: any) => {
        console.error('Error deleting file from MongoDB:', error);
        alert(this.translateService.instant('EVENTELEM.ERROR_DELETING_FILE'));
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

  // Get track files (GPX, KML, etc.)
  public getTrackFiles(): UploadedFile[] {
    if (!this.evenement?.fileUploadeds) {
      return [];
    }
    return this.evenement.fileUploadeds.filter(file => {
      const fileName = file.fileName.toLowerCase();
      return fileName.endsWith('.gpx') || 
             fileName.endsWith('.kml') || 
             fileName.endsWith('.kmz') ||
             fileName.endsWith('.gdb') ||
             fileName.endsWith('.tcx');
    });
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
      
      // Check cache first - but still load size if not available
      if (this.videoUrlCache.has(file.fieldId) && this.videoFileSizes.has(file.fieldId)) {
        const cachedUrl = this.videoUrlCache.get(file.fieldId);
        if (cachedUrl) {
          this.videoUrls.set(file.fieldId, cachedUrl);
          this.cdr.detectChanges();
        }
        return;
      }
      
      // Load video with metadata to get file size from headers
      // Use catchError in pipe to prevent errors from triggering redirects
      this.fileService.getFileWithMetadata(file.fieldId).pipe(
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
        next: (result: ImageDownloadResult) => {
          const blob = new Blob([result.buffer]);
          if (!blob || blob.size === 0) {
            return;
          }
          
          // Get file size from headers (Content-Length) or blob size
          let fileSize = blob.size;
          const contentLength = result.headers.get('Content-Length');
          if (contentLength) {
            const parsedSize = parseInt(contentLength, 10);
            if (!isNaN(parsedSize) && parsedSize > 0) {
              fileSize = parsedSize;
            }
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
          // Store file size (use Content-Length from headers if available, otherwise blob size)
          this.videoFileSizes.set(file.fieldId, fileSize);
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

  // Format file size in bytes to human-readable format
  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  // Get formatted video file size
  public getVideoFileSize(videoFile: UploadedFile): string | null {
    if (!videoFile?.fieldId) {
      return null;
    }
    const size = this.videoFileSizes.get(videoFile.fieldId);
    if (size === undefined || size === null) {
      return null;
    }
    return this.formatFileSize(size);
  }

  // Open PDF in new tab (same method as element-evenement)
  public openPdfInPage(pdfFile: UploadedFile): void {
    const sub = this.getFileBlobUrl(pdfFile.fieldId).subscribe({
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
        const revokeId = setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 10000);
        this.trackTimeout(revokeId);
      },
      error: (error) => {
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error loading PDF file:', error);
        }
      }
    });
    this.trackSubscription(sub);
  }

  // Get icon for track file type
  public getTrackFileIcon(fileName: string): string {
    const lowerFileName = fileName.toLowerCase();
    if (lowerFileName.endsWith('.gpx')) {
      return 'fa-map-signs';
    } else if (lowerFileName.endsWith('.kml') || lowerFileName.endsWith('.kmz')) {
      return 'fa-map-pin';
    } else if (lowerFileName.endsWith('.gdb')) {
      return 'fa-database';
    } else if (lowerFileName.endsWith('.tcx')) {
      return 'fa-file-code-o';
    }
    return 'fa-map-marker';
  }

  // Open track file in trace viewer
  public openTrackFile(trackFile: UploadedFile): void {
    if (!trackFile?.fieldId || !this.traceViewerModalComponent) {
      return;
    }

    // Get event color if available
    const eventColor = this.getCalculatedColor();

    // Open trace viewer with file
    this.traceViewerModalComponent.openFromFile(trackFile.fieldId, trackFile.fileName, eventColor || undefined);
  }

  // Download track file
  public downloadTrackFile(trackFile: UploadedFile): void {
    if (!trackFile?.fieldId) {
      return;
    }

    const sub = this.getFileBlobUrl(trackFile.fieldId).subscribe({
      next: (blob: any) => {
        // Create object URL for the blob
        const objectUrl = URL.createObjectURL(blob);
        
        // Create a temporary anchor element for download
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = trackFile.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up the URL after a delay
        const revokeId = setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 100);
        this.trackTimeout(revokeId);
      },
      error: (error) => {
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error downloading track file:', error);
        }
      }
    });
    this.trackSubscription(sub);
  }

  // Download PDF file (same method as element-evenement)
  public downloadPdf(pdfFile: UploadedFile): void {
    const sub = this.getFileBlobUrl(pdfFile.fieldId).subscribe({
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
        const revokeId = setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 1000);
        this.trackTimeout(revokeId);
      },
      error: (error) => {
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error downloading PDF file:', error);
        }
      }
    });
    this.trackSubscription(sub);
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

    // Store handlers for cleanup
    const events = [
      { event: 'fullscreenchange', handler: handleFullscreenChange },
      { event: 'webkitfullscreenchange', handler: handleFullscreenChange },
      { event: 'mozfullscreenchange', handler: handleFullscreenChange },
      { event: 'MSFullscreenChange', handler: handleFullscreenChange }
    ];
    
    events.forEach(({ event, handler }) => {
      document.addEventListener(event, handler);
      this.fullscreenHandlers.push({ event, handler });
    });
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
    
    // Pass startIndex to open method
    this.slideshowModalComponent.open(imageSources, this.evenement.evenementName, true, 0, eventColor || undefined, startIndex);
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

  // Get styles for event title with calculated color background (couleur éclaircie comme le badge)
  public getEventTitleStyles(): { [key: string]: string } {
    if (!this.evenement) {
      return {};
    }

    const eventColor = this.getLightenedCalculatedColor();
    if (!eventColor) {
      return {
        'background-color': 'rgba(40, 167, 69, 0.6)',
        'color': '#ffffff',
        'padding': '0.5rem 1rem',
        'border-radius': '8px',
        'display': 'inline-block'
      };
    }

    const brightness = (0.299 * eventColor.r + 0.587 * eventColor.g + 0.114 * eventColor.b);
    const isBright = brightness > 128;
    const textColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';

    return {
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

  /** Returns a lightened version of the calculated event color for badges/title display. */
  public getLightenedCalculatedColor(): { r: number; g: number; b: number } | null {
    const color = this.getCalculatedColor();
    if (!color) {
      return null;
    }
    const factor = 0.35; // blend toward white (0 = no change, 1 = full white)
    return {
      r: Math.round(color.r + (255 - color.r) * factor),
      g: Math.round(color.g + (255 - color.g) * factor),
      b: Math.round(color.b + (255 - color.b) * factor)
    };
  }

  // Calculate if background is light or dark to determine text color
  public isBackgroundLight(): boolean {
    const color = this.getCalculatedColor();
    if (!color) {
      // Default: background is dark (with brightness filter and dark overlay)
      return false;
    }

    // Calculate brightness (0-255) using relative luminance formula
    // The background has brightness(0.6) filter and rgba(0, 0, 0, 0.35) overlay
    // So we need to account for these darkening effects
    const baseBrightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
    // Apply brightness filter (0.6) and dark overlay (0.35 opacity black)
    // The overlay reduces brightness: new = old * (1 - overlay_opacity) + black * overlay_opacity
    // Since black is 0, it becomes: new = old * (1 - 0.35) = old * 0.65
    const adjustedBrightness = baseBrightness * 0.6 * 0.65;
    
    // If adjusted brightness is above 100 (lowered threshold for dark backgrounds), consider it light
    // But given the darkening effects, most backgrounds will be dark
    return adjustedBrightness > 100;
  }

  // Get text color class based on background brightness (when no calculated color, use black text and icons)
  public getTextColorClass(): string {
    if (!this.getCalculatedColor()) {
      return 'text-light-mode';
    }
    return this.isBackgroundLight() ? 'text-dark-mode' : 'text-light-mode';
  }

  // Get styles for color badge (couleur éclaircie pour l’affichage)
  public getColorBadgeStyles(): { [key: string]: string } {
    const color = this.getLightenedCalculatedColor();
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

  // Get styles for comments card - removed, using CSS variables like other cards
  public getCommentsCardStyles(): { [key: string]: string } {
    return {};
  }

  // Get styles for comments card header - removed, using CSS variables like other cards
  public getCommentsHeaderStyles(): { [key: string]: string } {
    return {};
  }

  // Get styles for comments card body - removed, using CSS variables like other cards
  public getCommentsBodyStyles(): { [key: string]: string } {
    return {};
  }

  // Get styles for comments add button
  public getCommentsAddButtonStyle(): { [key: string]: string } {
    const color = this.getCalculatedColor();
    if (!color) {
      return {};
    }

    const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
    const isBright = brightness > 128;
    const textColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
    
    return {
      'background-color': `rgba(${color.r}, ${color.g}, ${color.b}, 0.8)`,
      'border-color': `rgba(${color.r}, ${color.g}, ${color.b}, 0.9)`,
      'color': textColor
    };
  }

  // Open add commentary modal
  public openAddCommentary(): void {
    // Access the commentary editor component and trigger add modal
    if (this.commentaryEditor) {
      this.commentaryEditor.openAddModal();
    }
  }

  public openFsPhotosDiaporama(relativePath: string, compress: boolean = true, startIndex: number = 0): void {
    // Open slideshow modal immediately with empty array - images will be loaded dynamically
    if (!this.slideshowModalComponent || !this.evenement) {
      console.error('Slideshow modal component or event not available');
      return;
    }
    
    // Reset slideshow loading state
    this.fsSlideshowLoadingActive = true;
    
    // Get event color for slideshow styling
    const eventColor = this.getCalculatedColor();
    
    // Open modal immediately with empty array, but set startIndex for when images are loaded
    this.slideshowModalComponent.open([], this.evenement.evenementName, false, 0, eventColor || undefined, startIndex);
    
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
    
    // Ask user if they want to compress images
    if (imageFiles.length > 0) {
      this.imageCountForModal = imageFiles.length;
      this.compressImages = true; // Reset to default
      const shouldCompress = await this.askForImageCompression(imageFiles.length);
      if (shouldCompress === null) {
        // User cancelled, stop upload
        this.isUploading = false;
        if (modalRef) {
          modalRef.close();
        }
        return;
      }
      this.compressImages = shouldCompress;
    }
    
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

    // Process video compression if needed using shared service
    const videoFiles = this.selectedFiles.filter(file => this.videoUploadProcessingService.isVideoFile(file.name));
    let processedFiles: File[] = [];
    
    try {
      if (videoFiles.length > 0 && this.videoCompressionService.isSupported()) {
        // Add timeout to prevent hanging if modal doesn't respond
        const qualityPromise = this.askForCompressionQuality(videoFiles.length);
        const quality = await this.videoUploadProcessingService.withQualityTimeout(
          qualityPromise,
          this.qualityModalRef,
          () => this.addLog(`⚠️ Compression quality selection timed out, uploading original files`)
        );
        
        // Process videos using shared service
        const result = await this.videoUploadProcessingService.processVideoFiles(
          this.selectedFiles,
          quality,
          (message: string) => this.addLog(message)
        );
        
        processedFiles = result.files;
        
        // Log any errors from processing
        result.errors.forEach(error => {
          this.addErrorLog(`❌ ${error}`);
        });
      } else {
        processedFiles.push(...this.selectedFiles);
        if (videoFiles.length > 0 && !this.videoCompressionService.isSupported()) {
          this.addLog(`⚠️ Video compression not supported in this browser, uploading original files`);
        }
      }
    } catch (error: any) {
      // If anything goes wrong in the compression flow, fall back to uploading original files
      console.error('Error in video compression flow:', error);
      this.addLog(`⚠️ Error in compression process: ${error?.message || 'Unknown error'}. Uploading original files.`);
      processedFiles = [...this.selectedFiles];
    }

    // Safety check: ensure we have files to upload
    if (processedFiles.length === 0) {
      this.addErrorLog(`❌ No files to upload. This should not happen.`);
      this.isUploading = false;
      if (modalRef) {
        modalRef.close();
      }
      return;
    }
    
    // Build the correct upload URL with user ID and event ID
    const uploadUrl = `${this.API_URL4FILE}/${this.user.id}/${this.evenement.id}`;
    
    // Create FormData
    // IMPORTANT: Backend expects 'file' (singular), not 'files' (plural)
    const formData = new FormData();
    processedFiles.forEach(file => {
      formData.append('file', file);
    });
    
    // Add allowOriginal parameter (true if we don't want to compress images)
    // allowOriginal=true means: allow original file without compression
    // allowOriginal=false (default) means: compress images
    if (imageFiles.length > 0) {
      formData.append('allowOriginal', (!this.compressImages).toString());
    }

    // Subscribe to upload logs
    if (sessionId) {
      let lastLogCount = 0;
      const pollIntervalId = setInterval(() => {
        const logSubscription = this.fileService.getUploadLogs(sessionId).subscribe(
          (serverLogs: string[]) => {
            // Ensure the callback runs in Angular zone for proper change detection
            this.ngZone.run(() => {
              if (serverLogs.length > lastLogCount) {
                for (let i = lastLogCount; i < serverLogs.length; i++) {
                  this.addLog(serverLogs[i]);
                }
                lastLogCount = serverLogs.length;
              }
            });
          },
          (error) => {
            console.error('Error receiving upload logs:', error);
          }
        );
        this.trackSubscription(logSubscription);
      }, 1000); // Poll every second
      this.trackInterval(pollIntervalId);
      
      // Clear interval when upload completes
      const cleanupTimeout = setTimeout(() => {
        clearInterval(pollIntervalId);
        this.activeIntervals.delete(pollIntervalId);
      }, 300000); // Stop after 5 minutes
      this.trackTimeout(cleanupTimeout);
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
                      // Update background image after photo gallery is updated
                      // Use setTimeout to defer to next change detection cycle
                      // This prevents ExpressionChangedAfterItHasBeenCheckedError
                      setTimeout(() => {
                        this.updateBackgroundImageUrl();
                        this.cdr.markForCheck();
                      }, 0);
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
                      // Use setTimeout to ensure change detection runs after async image loading
                      setTimeout(() => {
                        this.cdr.markForCheck();
                      }, 0);
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
          this.trackTimeout(cleanupTimeout);
          
          // Store timeout to clean up if needed
          const emptyTimeout = setTimeout(() => {
            // Cleanup after timeout
          }, 600);
          this.trackTimeout(emptyTimeout);
        },
        error: (error: any) => {
          let errorMessage = this.translateService.instant('EVENTELEM.ERROR_UPLOADING');
          
          if (error.status === 0) {
            errorMessage = this.translateService.instant('EVENTELEM.ERROR_CONNECTING');
          } else if (error.status === 401) {
            errorMessage = this.translateService.instant('EVENTELEM.ERROR_AUTHENTICATION');
            // Log error before any potential redirect
            this.addErrorLog(`❌ Upload error: ${errorMessage} (Status: ${error.status})`);
            // Don't redirect here - let interceptor handle it
            // But don't continue processing
            setTimeout(() => {
              this.isUploading = false;
            }, 1000);
            return;
          } else if (error.status === 403) {
            errorMessage = this.translateService.instant('EVENTELEM.ERROR_ACCESS_DENIED');
          } else if (error.status === 413) {
            errorMessage = this.translateService.instant('EVENTELEM.ERROR_FILE_TOO_LARGE');
          } else if (error.status >= 500) {
            errorMessage = this.translateService.instant('EVENTELEM.ERROR_SERVER');
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
    // Ensure we're in Angular zone
    this.ngZone.run(() => {
      this.uploadLogs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
      
      // Force change detection to update the view in real-time
      this.cdr.detectChanges();
      
      // Use requestAnimationFrame for smoother UI updates
      requestAnimationFrame(() => {
        if (this.logContent && this.logContent.nativeElement) {
          const container = this.logContent.nativeElement;
          container.scrollTop = 0;
        }
      });
    });
  }

  private addSuccessLog(message: string): void {
    this.uploadLogs.unshift(`SUCCESS: [${new Date().toLocaleTimeString()}] ${message}`);
    
    // Force change detection to update the view in real-time
    this.cdr.detectChanges();
    
    setTimeout(() => {
      if (this.logContent && this.logContent.nativeElement) {
        const container = this.logContent.nativeElement;
        container.scrollTop = 0;
      }
    }, 0);
  }

  private addErrorLog(message: string): void {
    // Ensure we're in Angular zone
    this.ngZone.run(() => {
      this.uploadLogs.unshift(`ERROR: [${new Date().toLocaleTimeString()}] ${message}`);
      
      // Force change detection to update the view in real-time
      this.cdr.detectChanges();
      
      // Use requestAnimationFrame for smoother UI updates
      requestAnimationFrame(() => {
        if (this.logContent && this.logContent.nativeElement) {
          const container = this.logContent.nativeElement;
          container.scrollTop = 0;
        }
      });
    });
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

  private askForCompressionQuality(videoCount: number): Promise<'low' | 'medium' | 'high' | 'very-high' | 'original' | null> {
    return new Promise((resolve) => {
      this.selectedCompressionQuality = 'very-high'; // Default to very high quality
      this.videoCountForModal = videoCount; // Used by template

      if (this.qualitySelectionModal) {
        this.qualityModalRef = this.modalService.open(this.qualitySelectionModal, {
          centered: true,
          backdrop: 'static',
          keyboard: false,
          size: 'md',
          windowClass: 'compression-quality-modal'
        });

        this.qualityModalRef.result.then(
          (result: 'low' | 'medium' | 'high' | 'very-high' | 'original') => {
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
          `3. Haute (grande taille)\n` +
          `4. Très haute (qualité élevée, peu de compression)\n` +
          `5. Originale (pas de compression, qualité maximale)\n\n` +
          `Entrez 1, 2, 3, 4 ou 5:`
        );

        if (choice === '1') resolve('low');
        else if (choice === '2') resolve('medium');
        else if (choice === '3') resolve('high');
        else if (choice === '4') resolve('very-high');
        else if (choice === '5') resolve('original');
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
  
  private askForImageCompression(imageCount: number): Promise<boolean | null> {
    return new Promise((resolve) => {
      this.compressImages = true; // Default to compression enabled
      this.imageCountForModal = imageCount;

      if (this.imageCompressionModal) {
        this.imageCompressionModalRef = this.modalService.open(this.imageCompressionModal, {
          centered: true,
          backdrop: 'static',
          keyboard: false,
          size: 'md',
          windowClass: 'compression-quality-modal'
        });

        this.imageCompressionModalRef.result.then(
          (result: boolean) => {
            this.imageCompressionModalRef = null;
            resolve(result);
          },
          () => {
            this.imageCompressionModalRef = null;
            resolve(null); // dismissed
          }
        );
      } else {
        // Fallback
        const choice = confirm(
          this.translateService.instant('EVENTELEM.IMAGE_COMPRESSION_QUESTION', { count: imageCount })
        );
        resolve(choice);
      }
    });
  }

  public confirmImageCompression(): void {
    if (this.imageCompressionModalRef) {
      this.imageCompressionModalRef.close(this.compressImages);
    }
  }

  public cancelImageCompression(): void {
    if (this.imageCompressionModalRef) {
      this.imageCompressionModalRef.dismiss();
    }
  }

  // =========================
  // Slideshow methods (now handled by SlideshowModalComponent)
  // =========================

}