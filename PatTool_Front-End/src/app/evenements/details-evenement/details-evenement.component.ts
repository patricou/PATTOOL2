import { Component, OnInit, OnDestroy, ViewChild, TemplateRef, ElementRef } from '@angular/core';
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
import { EvenementsService } from '../../services/evenements.service';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { WindowRefService } from '../../services/window-ref.service';
import { environment } from '../../../environments/environment';

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

  // Carousel properties
  public currentSlide: number = 0;
  public autoPlay: boolean = false;
  private autoPlayInterval: any = null;
  
  // Fullscreen properties
  public isFullscreen: boolean = false;
  
  // Image cache for authenticated images
  private imageCache = new Map<string, SafeUrl>();
  
  // Track active HTTP subscriptions to cancel them on destroy
  private activeSubscriptions = new Set<Subscription>();
  
  @ViewChild('imageModal') imageModal!: TemplateRef<any>;
  @ViewChild('slideshowModal') slideshowModal!: TemplateRef<any>;
  @ViewChild('slideshowContainer') slideshowContainerRef!: ElementRef;
  @ViewChild('slideshowImgEl') slideshowImgElRef!: ElementRef<HTMLImageElement>;

  // Slideshow properties
  public isSlideshowActive: boolean = false;
  public currentSlideshowIndex: number = 0;
  public slideshowImages: string[] = [];
  public slideshowInterval: any;
  private isSlideshowModalOpen: boolean = false;
  private keyboardListener?: (event: KeyboardEvent) => void;
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

  // FS Photos download control
  private fsDownloadsActive: boolean = false;
  private fsActiveSubs: Subscription[] = [];
  private fsQueue: string[] = [];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private sanitizer: DomSanitizer,
    private translateService: TranslateService,
    private evenementsService: EvenementsService,
    private membersService: MembersService,
    private fileService: FileService,
    private winRef: WindowRefService,
    private modalService: NgbModal
  ) {
    this.nativeWindow = winRef.getNativeWindow();
  }

  ngOnInit(): void {
    this.loadEventDetails();
  }

  ngOnDestroy(): void {
    this.stopAutoPlay();
    this.stopSlideshow();
    this.cancelFsDownloads();
    this.removeKeyboardListener();
    
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
    
    // Clean up slideshow blob URLs
    this.slideshowImages.forEach(url => {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    this.slideshowImages = [];
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
      },
      error: (error: any) => {
        console.error('Error loading event:', error);
        this.error = 'Erreur lors du chargement de l\'événement';
        this.loading = false;
      }
    });
  }

  // Prepare photo gallery with comments overlay
  private preparePhotoGallery(): void {
    if (!this.evenement || !this.evenement.fileUploadeds) {
      return;
    }

    const imageFiles = this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
    
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
        // Set default image on error
        const defaultUrl = this.sanitizer.bypassSecurityTrustUrl("assets/images/images.jpg");
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
      '1': 'EVENTCREATION.TYPE.VTT'
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
      this.openImageModal(uploadedFile.fieldId, uploadedFile.fileName);
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
            backdrop: true,
            keyboard: true,
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

  // Carousel navigation methods
  public nextSlide(): void {
    if (this.photoItemsList.length > 0) {
      this.currentSlide = (this.currentSlide + 1) % this.photoItemsList.length;
    }
  }

  public previousSlide(): void {
    if (this.photoItemsList.length > 0) {
      this.currentSlide = this.currentSlide === 0 ? this.photoItemsList.length - 1 : this.currentSlide - 1;
    }
  }

  public goToSlide(index: number): void {
    if (index >= 0 && index < this.photoItemsList.length) {
      this.currentSlide = index;
    }
  }

  // Auto-play methods
  public toggleAutoPlay(): void {
    this.autoPlay = !this.autoPlay;
    
    if (this.autoPlay) {
      this.startAutoPlay();
    } else {
      this.stopAutoPlay();
    }
  }

  private startAutoPlay(): void {
    if (this.photoItemsList.length <= 1) {
      return; // Don't auto-play if there's only one image or no images
    }
    
    this.stopAutoPlay(); // Clear any existing interval
    
    this.autoPlayInterval = setInterval(() => {
      this.nextSlide();
    }, 3000); // Change slide every 3 seconds
  }

  private stopAutoPlay(): void {
    if (this.autoPlayInterval) {
      clearInterval(this.autoPlayInterval);
      this.autoPlayInterval = null;
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
      target.src = 'assets/images/images.jpg'; // Fallback image
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
      {id: "WEBSITE", label: "EVENTHOME.URL_TYPE_WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]}
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
    
    const urlEventTypes = [
      {id: "MAP", aliases: ["CARTE", "CARTA", "KARTE", "MAPA", "地图", "خريطة"]},
      {id: "DOCUMENTATION", aliases: ["DOC", "DOCUMENT", "DOCS", "文档", "وثائق"]},
      {id: "OTHER", aliases: ["AUTRE", "OTRO", "ANDERE", "其他", "أخرى"]},
      {id: "PHOTOS", aliases: ["PHOTO", "PHOTOS", "IMAGES", "PICTURES", "照片", "صور"]},
      {id: "PHOTOFROMFS", aliases: ["PHOTO FS", "PHOTO FROM FS", "DISK PHOTO", "FICHIER"]},
      {id: "VIDEO", aliases: ["VIDEO", "VIDÉO", "YOUTUBE", "VIMEO"]},
      {id: "WEBSITE", aliases: ["SITE", "WEB", "SITIO", "网站", "موقع"]}
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
    
    return type ? type.id : 'OTHER';
  }

  // Get sorted type keys for consistent display order
  public getSortedTypeKeys(): string[] {
    const grouped = this.getGroupedUrlEvents();
    const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'VIDEO', 'PHOTOS', 'PHOTOFROMFS', 'Photos', 'OTHER'];
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

  public getPhotoFromFsLinks(): UrlEvent[] {
    if (!this.evenement || !this.evenement.urlEvents) return [];
    return this.evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOFROMFS');
  }

  public openFsPhotosDiaporama(relativePath: string): void {
    this.slideshowImages = [];
    this.currentSlideshowIndex = 0;
    // ensure slideshow starts paused
    if (this.slideshowInterval) { clearInterval(this.slideshowInterval); this.slideshowInterval = null; }
    this.isSlideshowActive = false;
    this.fsDownloadsActive = true;
    // cleanup any previous subscriptions
    this.cancelFsDownloads();
    this.fsDownloadsActive = true;
    // First, list images
    const subscription = this.fileService.listImagesFromDisk(relativePath).subscribe({
      next: (fileNames: string[]) => {
        // Open the modal immediately (will show loader until images arrive)
        const modalRef = this.modalService.open(this.slideshowModal, { size: 'xl', centered: true, windowClass: 'slideshow-modal-wide' });

        if (!fileNames || fileNames.length === 0) {
          return;
        }
        // Limit concurrent downloads for faster first paint
        this.loadImagesWithConcurrency(relativePath, fileNames, 4);

        // Setup keyboard listener after modal is opened
        setTimeout(() => {
          this.setupKeyboardListener();
        }, 0);

        // Cleanup and cancel downloads when modal closes
        modalRef.result.finally(() => {
          this.cancelFsDownloads();
          this.removeKeyboardListener();
          try { this.slideshowImages.forEach(url => URL.revokeObjectURL(url)); } catch {}
        });
      },
      error: () => {
        // Open modal anyway to show empty state/error
        const modalRef = this.modalService.open(this.slideshowModal, { size: 'xl', centered: true, windowClass: 'slideshow-modal-wide' });
        setTimeout(() => {
          this.setupKeyboardListener();
        }, 0);
        modalRef.result.finally(() => {
          this.removeKeyboardListener();
        });
      }
    });
    this.trackSubscription(subscription);
  }

  private loadImagesWithConcurrency(relativePath: string, fileNames: string[], concurrency: number): void {
    this.fsQueue = [...fileNames];
    let active = 0;

    const next = () => {
      if (!this.fsDownloadsActive) { return; }
      while (this.fsDownloadsActive && active < concurrency && this.fsQueue.length > 0) {
        const name = this.fsQueue.shift() as string;
        active++;
        const sub = this.fileService.getImageFromDisk(relativePath, name).subscribe({
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

  // =========================
  // Slideshow methods
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

  public onSlideshowClose(cRef: any): void {
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    } catch {}
    this.cancelFsDownloads();
    this.removeKeyboardListener();
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
  }

  // Setup keyboard listener for arrow keys navigation
  private setupKeyboardListener(): void {
    this.isSlideshowModalOpen = true;
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
    this.isSlideshowModalOpen = false;
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

}