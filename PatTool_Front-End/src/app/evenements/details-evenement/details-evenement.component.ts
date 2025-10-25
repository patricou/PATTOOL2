import { Component, OnInit, ViewChild, TemplateRef } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { Observable } from 'rxjs';
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
export class DetailsEvenementComponent implements OnInit {

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
  
  // Image cache for authenticated images
  private imageCache = new Map<string, SafeUrl>();
  
  @ViewChild('imageModal') imageModal!: TemplateRef<any>;

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
    this.fileService.getFile(fileId).pipe(
      map((res: any) => {
        const blob = new Blob([res], { type: 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        return this.sanitizer.bypassSecurityTrustUrl(objectUrl);
      })
    ).subscribe({
      next: (safeUrl: SafeUrl) => {
        this.imageCache.set(fileId, safeUrl);
        // Update the photoItems with the loaded image
        const photoItem = this.photoItems.find(item => item.file.fieldId === fileId);
        if (photoItem) {
          photoItem.imageUrl = safeUrl;
        }
      },
      error: (error) => {
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
  public getFileBlobUrl(fileId: string): Observable<any> {
    return this.fileService.getFile(fileId).pipe(
      map((res: any) => {
        const blob = new Blob([res], { type: 'application/octet-stream' });
        return blob;
      })
    );
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
      'he': 'he-IL'
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
    this.getFileBlobUrl(fileId).subscribe((blob: any) => {
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
    });
  }

  // Open PDF file in new tab
  public openPdfFile(fileId: string, fileName: string): void {
    this.getFileBlobUrl(fileId).subscribe((blob: any) => {
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
    }, (error) => {
      console.error('Error loading PDF file:', error);
      alert('Erreur lors du chargement du fichier PDF');
    });
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
    this.getFileBlobUrl(fileId).subscribe((blob: any) => {
      const objectUrl = URL.createObjectURL(blob);
      this.selectedImageUrl = objectUrl;
      this.selectedImageAlt = fileName;
      
      if (this.imageModal) {
        this.modalService.open(this.imageModal, { 
          size: 'xl', 
          centered: true,
          backdrop: true,
          keyboard: true,
          animation: true
        });
      }
    }, (error) => {
      console.error('Error loading image:', error);
      alert('Erreur lors du chargement de l\'image');
    });
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
    const typeOrder = ['MAP', 'DOCUMENTATION', 'WEBSITE', 'PHOTOS', 'Photos', 'OTHER'];
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
      'he': 'he-IL'
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
    this.getFileBlobUrl(pdfFile.fieldId).subscribe((blob: any) => {
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
    });
  }

  // Download PDF file (same method as element-evenement)
  public downloadPdf(pdfFile: UploadedFile): void {
    console.log('Downloading PDF file:', pdfFile.fileName, 'with ID:', pdfFile.fieldId);
    this.getFileBlobUrl(pdfFile.fieldId).subscribe((blob: any) => {
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
    }, (error) => {
      console.error('Error downloading PDF file:', error);
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
}