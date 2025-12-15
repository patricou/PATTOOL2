import { Component, OnInit, OnDestroy, ViewChild, TemplateRef, ElementRef, ChangeDetectorRef } from '@angular/core';
import { SlideshowModalComponent, SlideshowImageSource } from '../../shared/slideshow-modal/slideshow-modal.component';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { Observable, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
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
  
  // Track active HTTP subscriptions to cancel them on destroy
  private activeSubscriptions = new Set<Subscription>();
  
  @ViewChild('imageModal') imageModal!: TemplateRef<any>;
  @ViewChild('slideshowModalComponent') slideshowModalComponent!: SlideshowModalComponent;
  @ViewChild('uploadLogsModal') uploadLogsModal!: TemplateRef<any>;

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
    private cdr: ChangeDetectorRef
  ) {
    this.nativeWindow = winRef.getNativeWindow();
  }

  ngOnInit(): void {
    this.loadFriendGroups();
    this.loadEventDetails();
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
        // This ensures members are displayed correctly when friend groups load asynchronously
      },
      error: (error) => {
        console.error('Error loading friend groups:', error);
        this.friendGroups = [];
        this.friendGroupsLoaded = true;
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
        this.preparePhotoGallery();
        this.loading = false;
        // Load discussion messages if discussionId exists
        if (evenement.discussionId) {
          this.loadDiscussionMessages();
        }
      },
      error: (error: any) => {
        console.error('Error loading event:', error);
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
    return this.evenement.members.slice(0, 5);
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
    if (!friendGroup?.members) {
      return [];
    }
    return friendGroup.members.slice(0, 5);
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

  // Check if the event's friend group has a WhatsApp link
  public hasFriendGroupWhatsAppLink(): boolean {
    if (!this.evenement || !this.evenement.friendGroupId) {
      return false;
    }
    const group = this.friendGroups.find(g => g.id === this.evenement!.friendGroupId);
    return !!(group?.whatsappLink && group.whatsappLink.trim().length > 0);
  }

  // Get the WhatsApp link for the event's friend group
  public getFriendGroupWhatsAppLink(): string | undefined {
    if (!this.evenement || !this.evenement.friendGroupId) {
      return undefined;
    }
    const group = this.friendGroups.find(g => g.id === this.evenement!.friendGroupId);
    return group?.whatsappLink;
  }

  // Open WhatsApp link for the friend group
  public openFriendGroupWhatsAppLink(): void {
    const whatsappLink = this.getFriendGroupWhatsAppLink();
    if (whatsappLink) {
      window.open(whatsappLink, '_blank');
    }
  }

  // Open discussion if available
  public openDiscussion(): void {
    if (!this.evenement?.discussionId) {
      console.warn('No discussion ID available');
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

    const subscription = this.discussionService.getMessages(this.evenement.discussionId).subscribe({
      next: (messages: DiscussionMessage[]) => {
        this.discussionMessages = messages || [];
        this.isLoadingDiscussion = false;
        // Load images for messages that have images
        this.loadDiscussionMessageImages();
      },
      error: (error: any) => {
        // If it's a 401, the interceptor will redirect to login
        // Don't set error message as user will be redirected
        if (error?.status === 401) {
          this.isLoadingDiscussion = false;
          // Interceptor will handle redirect, just return
          return;
        }
        console.error('Error loading discussion messages:', error);
        this.discussionError = 'Error loading discussion';
        this.isLoadingDiscussion = false;
        this.discussionMessages = [];
      }
    });
    this.trackSubscription(subscription);
  }

  // Load images for discussion messages
  private loadDiscussionMessageImages(): void {
    if (!this.evenement?.discussionId) {
      return;
    }

    const discussionId = this.evenement.discussionId;

    this.discussionMessages.forEach((message) => {
      if (message.imageUrl) {
        // Extract the real filename from imageUrl (format: /api/discussions/files/{discussionId}/images/{realFilename})
        const urlParts = message.imageUrl.split('/');
        const realFilename = urlParts.length > 0 ? urlParts[urlParts.length - 1] : null;
        
        if (!realFilename) {
          return;
        }
        
        const cacheKey = `${discussionId}/images/${realFilename}`;
        
        // Skip if already cached
        if (this.discussionFileUrlCache.has(cacheKey)) {
          return;
        }

        // Load image with authentication using the real filename from URL
        const subscription = this.discussionService.getFileUrl(discussionId, 'images', realFilename).subscribe({
          next: (blobUrl: string) => {
            this.discussionFileUrlCache.set(cacheKey, blobUrl);
            // Trigger change detection to update the view
            this.cdr.detectChanges();
          },
          error: (error) => {
            // Don't log 401/404 errors as they will trigger redirect via interceptor or are expected
            // Only log other errors to avoid console spam
            if (error?.status !== 401 && error?.status !== 404) {
              console.error('Error loading discussion image:', error);
            }
            // Don't throw or propagate the error to avoid triggering redirects
          }
        });
        this.trackSubscription(subscription);
      }
      
      if (message.videoUrl) {
        // Extract the real filename from videoUrl (format: /api/discussions/files/{discussionId}/videos/{realFilename})
        const urlParts = message.videoUrl.split('/');
        const realFilename = urlParts.length > 0 ? urlParts[urlParts.length - 1] : null;
        
        if (!realFilename) {
          return;
        }
        
        const cacheKey = `${discussionId}/videos/${realFilename}`;
        
        // Skip if already cached
        if (this.discussionFileUrlCache.has(cacheKey)) {
          return;
        }

        // Load video with authentication using the real filename from URL
        const subscription = this.discussionService.getFileUrl(discussionId, 'videos', realFilename).subscribe({
          next: (blobUrl: string) => {
            this.discussionFileUrlCache.set(cacheKey, blobUrl);
            // Trigger change detection to update the view
            this.cdr.detectChanges();
          },
          error: (error) => {
            // Don't log 401/404 errors as they will trigger redirect via interceptor or are expected
            // Only log other errors to avoid console spam
            if (error?.status !== 401 && error?.status !== 404) {
              console.error('Error loading discussion video:', error);
            }
            // Don't throw or propagate the error to avoid triggering redirects
          }
        });
        this.trackSubscription(subscription);
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

  // Get discussion file URL (returns blob URL with authentication)
  // filename can be either the actual filename or imageFileName from message
  // If imageUrl is provided, extract the real filename from it
  public getDiscussionFileUrl(filename: string, subfolder: 'images' | 'videos', imageUrl?: string): string {
    if (!this.evenement?.discussionId || !filename) {
      return '';
    }

    // If imageUrl is provided, extract the real filename from the URL
    // The URL format is: /api/discussions/files/{discussionId}/{subfolder}/{realFilename}
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
    const subscription = this.discussionService.getFileUrl(this.evenement.discussionId, subfolder, realFilename).subscribe({
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
    this.trackSubscription(subscription);

    return '';
  }
  
  // Check if discussion file URL is available in cache
  // filename can be either the actual filename or imageFileName from message
  // If imageUrl is provided, extract the real filename from it
  public hasDiscussionFileUrl(filename: string, subfolder: 'images' | 'videos', imageUrl?: string): boolean {
    if (!this.evenement?.discussionId || !filename) {
      return false;
    }
    
    // If imageUrl is provided, extract the real filename from the URL
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

  // Open image in modal
  public openImageInModal(imageUrl: string): void {
    if (!imageUrl) return;
    // You can implement image modal here or use existing slideshow modal
    window.open(imageUrl, '_blank');
  }

  // Add rating plus
  public addRatePlus(): void {
    if (!this.evenement) return;
    
    this.evenement.ratingPlus = (this.evenement.ratingPlus || 0) + 1;
    
    const subscription = this.evenementsService.putEvenement(this.evenement).subscribe({
      next: () => {
        // Rating updated successfully
        console.log('Rating plus added');
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
        console.log('Rating minus added');
      },
      error: (error: any) => {
        console.error('Error updating rating:', error);
        // Revert the change on error
        this.evenement!.ratingMinus = Math.max(0, (this.evenement!.ratingMinus || 0) - 1);
      }
    });
    this.trackSubscription(subscription);
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

  // Handle image error
  public onImageError(event: any): void {
    const target = event.target as HTMLImageElement;
    if (target) {
      target.src = ElementEvenementComponent.getDefaultPlaceholderImageUrl(); // Fallback image
    }
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

  // Open PDF in new tab (same method as element-evenement)
  public openPdfInPage(pdfFile: UploadedFile): void {
    console.log('Opening PDF file:', pdfFile.fileName, 'with ID:', pdfFile.fieldId);
    const subscription = this.getFileBlobUrl(pdfFile.fieldId).subscribe({
      next: (blob: any) => {
        this.activeSubscriptions.delete(subscription);
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
      },
      error: (error) => {
        this.activeSubscriptions.delete(subscription);
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error loading PDF file:', error);
        }
      }
    });
    this.trackSubscription(subscription);
  }

  // Download PDF file (same method as element-evenement)
  public downloadPdf(pdfFile: UploadedFile): void {
    console.log('Downloading PDF file:', pdfFile.fileName, 'with ID:', pdfFile.fieldId);
    const subscription = this.getFileBlobUrl(pdfFile.fieldId).subscribe({
      next: (blob: any) => {
        this.activeSubscriptions.delete(subscription);
        console.log('Blob received for download:', blob);
        
        // Create a new blob with proper MIME type for PDF
        const pdfBlob = new Blob([blob], { type: 'application/pdf' });
        
        // Create object URL for the blob
        const objectUrl = URL.createObjectURL(pdfBlob);
        console.log('Object URL created for download:', objectUrl);
        
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
        this.activeSubscriptions.delete(subscription);
        if (error.name !== 'AbortError' && error.status !== 0) {
          console.error('Error downloading PDF file:', error);
        }
      }
    });
    this.trackSubscription(subscription);
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
        console.log('URL copied to clipboard');
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
    this.slideshowModalComponent.open([imageSource], this.evenement.evenementName, true);
  }

  public openFsPhotosDiaporama(relativePath: string, compress: boolean = true): void {
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
    const formData = new FormData();
    processedFiles.forEach(file => {
      formData.append('files', file);
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
          try {
            const fileCount = response?.length || processedFiles.length;
            this.addSuccessLog(`✅ Upload successful! ${fileCount} file(s) processed`);
            
            // The response should contain the uploaded file information directly
            this.handleUploadResponse(response);
            
            // Reset file input
            const fileInput = document.querySelector(`input[id="file-upload-input-${this.evenement!.id}"]`) as HTMLInputElement;
            if (fileInput) {
              fileInput.value = '';
            }
            
            // Reset selected files
            this.selectedFiles = [];
            
            // Reload event to get updated file list
            this.loadEventDetails();
            
            setTimeout(() => {
              this.isUploading = false;
            }, 1000);
          } catch (error) {
            console.error('Error processing upload response:', error);
            this.addErrorLog(`❌ Error processing upload response`);
            setTimeout(() => {
              this.isUploading = false;
            }, 1000);
          }
        },
        error: (error) => {
          console.error('File upload error:', error);
          
          let errorMessage = "Error uploading files.";
          if (error.status === 403) {
            errorMessage = "Access denied. You don't have permission to upload files.";
          } else if (error.status === 413) {
            errorMessage = "File too large. Please select smaller files.";
          } else if (error.status === 0) {
            errorMessage = "Network error. Please check your connection.";
          }
          
          this.addErrorLog(`❌ Upload error: ${errorMessage}`);
          
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
      console.error('Error processing upload response:', error);
      this.createUploadedFileEntries();
    }
  }

  private addUploadedFilesToEvent(uploadedFilesData: any[]): void {
    if (!this.evenement) return;
    
    let hasThumbnailFile = false;
    let thumbnailFile: UploadedFile | null = null;
    
    if (!this.evenement.fileUploadeds) {
      this.evenement.fileUploadeds = [];
    }
    
    for (let fileData of uploadedFilesData) {
      const uploadedFile = new UploadedFile(
        fileData.fieldId || fileData.id || this.generateFileId(),
        fileData.fileName || fileData.name,
        fileData.fileType || fileData.type || 'unknown',
        this.user!
      );
      
      if (uploadedFile.fileName && uploadedFile.fileName.toLowerCase().includes('thumbnail')) {
        hasThumbnailFile = true;
        thumbnailFile = uploadedFile;
      }
      
      const existingFile = this.evenement.fileUploadeds.find(f => f.fieldId === uploadedFile.fieldId);
      if (!existingFile) {
        this.evenement.fileUploadeds.push(uploadedFile);
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
        }
      });
      
      const subscription = this.evenementsService.putEvenement(this.evenement).subscribe({
        next: () => {
          this.loadEventDetails();
        },
        error: (error) => {
          console.error('Error updating event:', error);
        }
      });
      this.trackSubscription(subscription);
    } else {
      this.loadEventDetails();
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
      
      const subscription = this.evenementsService.putEvenement(this.evenement).subscribe({
        next: () => {
          this.loadEventDetails();
        },
        error: (error) => {
          console.error('Error updating event:', error);
        }
      });
      this.trackSubscription(subscription);
    } else {
      this.loadEventDetails();
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
      this.selectedCompressionQuality = 'high';
      this.videoCountForModal = videoCount;
      
      const choice = prompt(
        this.translateService.instant('EVENTELEM.COMPRESSION_QUALITY_TITLE', { count: videoCount }) + '\n' +
        '1. ' + this.translateService.instant('EVENTELEM.COMPRESSION_QUALITY_LOW') + '\n' +
        '2. ' + this.translateService.instant('EVENTELEM.COMPRESSION_QUALITY_MEDIUM') + '\n' +
        '3. ' + this.translateService.instant('EVENTELEM.COMPRESSION_QUALITY_HIGH') + '\n\n' +
        this.translateService.instant('EVENTELEM.COMPRESSION_QUALITY_PROMPT')
      );
      
      if (choice === '1') resolve('low');
      else if (choice === '2') resolve('medium');
      else if (choice === '3') resolve('high');
      else resolve(null);
    });
  }

  private isVideoFile(fileName: string): boolean {
    if (!fileName) return false;
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.3gp'];
    const lowerFileName = fileName.toLowerCase();
    return videoExtensions.some(ext => lowerFileName.endsWith(ext));
  }

  // =========================
  // Slideshow methods (now handled by SlideshowModalComponent)
  // =========================

}