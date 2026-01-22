import { Component, OnInit, OnChanges, SimpleChanges, Input, Output, EventEmitter, ViewChild, TemplateRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { NgbModule, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Evenement } from '../../model/evenement';
import { Member } from '../../model/member';
import { UrlEvent } from '../../model/url-event';

export interface PhotosSelectionResult {
  type: 'uploaded' | 'fs' | 'web';
  value: string; // For 'fs' and 'web', this is the link/path
  compressFs?: boolean; // Applicable when type === 'fs'
}

@Component({
  selector: 'app-photos-selector-modal',
  templateUrl: './photos-selector-modal.component.html',
  styleUrls: ['./photos-selector-modal.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    NgbModule,
    TranslateModule
  ]
})
export class PhotosSelectorModalComponent implements OnInit, OnChanges {
  @Input() evenement!: Evenement;
  @Input() includeUploadedChoice: boolean = false;
  @Input() user!: Member;
  
  @Output() selectionConfirmed = new EventEmitter<PhotosSelectionResult>();
  @Output() closed = new EventEmitter<void>();
  
  @ViewChild('photosSelectorModal') photosSelectorModal!: TemplateRef<any>;
  
  public selectedFsLink: string = '';
  public fsCompressionEnabled: boolean = true;
  private modalRef?: NgbModalRef;
  
  // Cached values to avoid ExpressionChangedAfterItHasBeenCheckedError
  private _hasImageFiles: boolean = false;
  private _imageFilesCount: number = 0;
  
  // Scroll position preservation - using CSS lock method
  private savedScrollPosition: number = 0;
  // Store the ORIGINAL scroll position (before any modal was opened)
  // This is used when reopening the modal after closing slideshow
  private originalScrollPosition: number = 0;

  // Section expansion state management
  private expandedSections: Map<string, boolean> = new Map();

  // Toggle expanded state for a section
  public toggleSectionExpansion(sectionKey: string): void {
    // Don't allow collapsing the "uploaded" section (Diaporama des Photos)
    if (sectionKey === 'uploaded') {
      return;
    }
    const currentState = this.expandedSections.get(sectionKey) || false;
    this.expandedSections.set(sectionKey, !currentState);
  }

  // Check if a section is expanded
  public isSectionExpanded(sectionKey: string): boolean {
    // Always expand the "uploaded" section (Diaporama des Photos)
    if (sectionKey === 'uploaded') {
      return true;
    }
    
    // If user has explicitly toggled the section, use that state
    if (this.expandedSections.has(sectionKey)) {
      return this.expandedSections.get(sectionKey) || false;
    }
    
    // Check if section has less than 4 elements - if so, expand by default
    const elementCount = this.getSectionElementCount(sectionKey);
    if (elementCount > 0 && elementCount < 4) {
      return true;
    }
    
    return false;
  }

  // Get the number of elements in a section
  private getSectionElementCount(sectionKey: string): number {
    if (!this.evenement) return 0;
    
    switch (sectionKey) {
      case 'uploaded':
        return this.getImageFilesCount();
      case 'filesystem':
        return this.getPhotoFromFsLinks().length;
      case 'web':
        return this.getPhotosUrlLinks().length;
      default:
        return 0;
    }
  }

  constructor(
    private modalService: NgbModal,
    private translateService: TranslateService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Update cache immediately
    this.updateImageFilesCache();
    
    // Defer initialization to next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      this.initializeDefaultSelection();
    }, 0);
  }

  ngOnChanges(changes: SimpleChanges): void {
    // When evenement data changes (e.g., files are loaded), update cache and check selection
    if (changes['evenement']) {
      // Update cache immediately (synchronous, before change detection)
      this.updateImageFilesCache();
      
      // Defer to next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
      setTimeout(() => {
        if (!changes['evenement'].firstChange) {
          this.checkAndSelectSingleOption();
        } else {
          // On first change, initialize default selection
          this.initializeDefaultSelection();
        }
        // Mark for check to ensure template updates reflect the changes
        this.cdr.markForCheck();
      }, 0);
    }
  }

  public open(): void {
    if (!this.evenement) {
      console.warn('No event provided to photos selector');
      return;
    }

    // Update cache immediately (before modal opens)
    this.updateImageFilesCache();

    // Reset selection
    this.selectedFsLink = '';
    this.fsCompressionEnabled = true;
    
    // Initialize default selection - defer to next change detection cycle to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      this.initializeDefaultSelection();
      // Refresh cache again in case files were loaded between opening and this timeout
      this.updateImageFilesCache();
      this.cdr.markForCheck();
    }, 0);

    if (!this.photosSelectorModal) {
      console.warn('Photos selector modal template not found');
      return;
    }

    // Save scroll position before opening modal
    // If this is the first time opening (originalScrollPosition is 0), save it as original
    // Otherwise, reuse the original position to maintain consistency
    const currentScrollY = window.scrollY || window.pageYOffset || 
                          document.documentElement.scrollTop || 
                          document.body.scrollTop || 0;
    
    // If we have a saved original position, use it (we're reopening after slideshow)
    // Otherwise, save current position as original (first time opening)
    if (this.originalScrollPosition > 0) {
      // Reopening after slideshow - use the original position
      this.savedScrollPosition = this.originalScrollPosition;
    } else {
      // First time opening - save as original
      this.originalScrollPosition = currentScrollY;
      this.savedScrollPosition = currentScrollY;
    }
    
    this.modalRef = this.modalService.open(this.photosSelectorModal, {
      centered: true,
      size: 'lg',
      windowClass: 'fs-selector-modal',
      backdrop: 'static',
      keyboard: false
    });
    
    // Immediately maintain scroll position after modal opens to prevent any movement
    // This is especially important when reopening after closing slideshow
    // Use the saved original position (or current if reopening)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Always restore to the original saved position
        window.scrollTo(0, this.savedScrollPosition);
        document.documentElement.scrollTop = this.savedScrollPosition;
        document.body.scrollTop = this.savedScrollPosition;
        
        // Also check after a delay in case slideshow restoration was still in progress
        setTimeout(() => {
          window.scrollTo(0, this.savedScrollPosition);
          document.documentElement.scrollTop = this.savedScrollPosition;
          document.body.scrollTop = this.savedScrollPosition;
        }, 400); // Wait longer than slideshow restoration (300ms) to ensure it's complete
      });
    });

    // Apply fixed width after modal is opened (multiple attempts to ensure it's applied)
    const applyWidth = () => {
      // Try multiple selectors to find the modal dialog
      const selectors = [
        '.fs-selector-modal.modal-dialog',
        '.modal-dialog.fs-selector-modal',
        '.modal.show .fs-selector-modal.modal-dialog',
        '.modal.show .modal-dialog.fs-selector-modal'
      ];
      
      let modalElement: HTMLElement | null = null;
      for (const selector of selectors) {
        modalElement = document.querySelector(selector) as HTMLElement;
        if (modalElement) break;
      }
      
      if (modalElement) {
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
          modalElement.style.maxWidth = '95%';
          modalElement.style.width = '95%';
        } else {
          modalElement.style.maxWidth = '600px';
          modalElement.style.width = '600px';
        }
        modalElement.style.marginLeft = 'auto';
        modalElement.style.marginRight = 'auto';
        modalElement.style.minWidth = '280px';
        modalElement.style.padding = '0';
        modalElement.style.boxSizing = 'border-box';
        
        // Also add a custom attribute to help CSS targeting
        modalElement.setAttribute('data-fs-selector-modal', 'true');
      }
    };

    // Try multiple times to ensure the modal is rendered and styles are applied
    setTimeout(applyWidth, 0);
    setTimeout(applyWidth, 10);
    setTimeout(applyWidth, 50);
    setTimeout(applyWidth, 100);
    setTimeout(applyWidth, 200);

    this.modalRef.result.finally(() => {
      // Unblock scroll first
      this.unblockPageScroll();
      // Don't restore scroll position here - keep originalScrollPosition for potential reopen
      // Only clear it when modal is really closed (not when slideshow is opened from it)
      // The scroll will be restored when the modal is actually closed for good
      this.closed.emit();
    }).catch(() => {
      // Unblock scroll first
      this.unblockPageScroll();
      // Don't restore scroll position here - keep originalScrollPosition for potential reopen
      this.closed.emit();
    });

    // Check and auto-select if there's only one option after modal is opened
    // Use setTimeout to ensure modal is fully rendered and data might be loaded
    // Also defer to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      // Refresh cache in case files were loaded asynchronously
      this.updateImageFilesCache();
      this.checkAndSelectSingleOption();
      this.cdr.markForCheck();
    }, 100);
    
    // Also check again after a longer delay in case files are still loading
    setTimeout(() => {
      // Refresh cache again in case files finished loading
      this.updateImageFilesCache();
      this.checkAndSelectSingleOption();
      this.cdr.markForCheck();
    }, 500);
  }

  public close(): void {
    if (this.modalRef) {
      this.modalRef.close();
    }
    // Unblock scroll first
    this.unblockPageScroll();
    // Restore scroll position ONCE after a delay
    this.unlockScrollPosition();
    // Clear original position when modal is really closed
    this.originalScrollPosition = 0;
  }

  public confirmSelection(modalRef?: any): void {
    // Validate that a selection has been made
    if (!this.selectedFsLink || typeof this.selectedFsLink !== 'string' || this.selectedFsLink.trim() === '') {
      // Show alert to user that they must select an option
      let message = 'Veuillez sélectionner une option avant de continuer.';
      try {
        const translated = this.translateService.instant('EVENTELEM.PHOTOS_SELECTION_REQUIRED');
        // If translation exists and is different from the key, use it
        if (translated && translated !== 'EVENTELEM.PHOTOS_SELECTION_REQUIRED') {
          message = translated;
        }
      } catch (e) {
        // Use default message if translation fails
      }
      alert(message);
      return;
    }

    let result: PhotosSelectionResult;

    if (this.selectedFsLink === '__UPLOADED__') {
      result = { type: 'uploaded', value: '' };
    } else if (this.selectedFsLink.startsWith('PHOTOS:')) {
      const url = this.selectedFsLink.substring('PHOTOS:'.length);
      result = { type: 'web', value: url };
    } else {
      result = { type: 'fs', value: this.selectedFsLink, compressFs: this.fsCompressionEnabled };
    }

    this.selectionConfirmed.emit(result);

    // Don't close the modal here - let the parent component close it
    // This prevents scroll restoration until the slideshow (or other action) is done
    // The originalScrollPosition will be preserved for when the modal is reopened
  }

  // Check if a valid selection has been made
  public hasValidSelection(): boolean {
    if (!this.selectedFsLink) {
      return false;
    }
    if (typeof this.selectedFsLink !== 'string') {
      return false;
    }
    return this.selectedFsLink.trim() !== '';
  }

  // Check if any photo options are available
  public hasAnyPhotoOptions(): boolean {
    return this.hasImageFiles() || 
           this.getPhotoFromFsLinks().length > 0 || 
           this.getPhotosUrlLinks().length > 0;
  }

  // Get message when no photos are available
  public getNoPhotosAvailableMessage(): string {
    try {
      const translated = this.translateService.instant('EVENTELEM.NO_PHOTOS_AVAILABLE');
      // If translation exists and is different from the key, use it
      if (translated && translated !== 'EVENTELEM.NO_PHOTOS_AVAILABLE') {
        return translated;
      }
    } catch (e) {
      // Use default message if translation fails
    }
    return 'Aucune photo disponible pour cet événement.';
  }

  // Count total number of photo options available
  private getTotalPhotoOptionsCount(): number {
    let count = 0;
    if (this.includeUploadedChoice && this.hasImageFiles()) {
      count += 1; // Uploaded photos count as 1 option
    }
    count += this.getPhotoFromFsLinks().length;
    count += this.getPhotosUrlLinks().length;
    return count;
  }

  // Check if there's only one option and automatically select it
  public checkAndSelectSingleOption(): void {
    if (!this.evenement) {
      return;
    }

    const totalOptions = this.getTotalPhotoOptionsCount();
    
    // If there's exactly one option and nothing is selected yet, select it automatically
    if (totalOptions === 1 && (!this.selectedFsLink || this.selectedFsLink.trim() === '')) {
      this.initializeDefaultSelection();
    }
  }

  private initializeDefaultSelection(): void {
    if (!this.evenement) {
      return;
    }

    const fsLinks = this.getPhotoFromFsLinks();
    const webLinks = this.getPhotosUrlLinks();

    // Default selection priority: first FS link -> first web photos link -> uploaded photos (if includeUploadedChoice is true)
    if (fsLinks.length > 0) {
      this.selectedFsLink = fsLinks[0].link;
    } else if (webLinks.length > 0) {
      this.selectedFsLink = 'PHOTOS:' + webLinks[0].link;
    } else if (this.includeUploadedChoice && this.hasImageFiles()) {
      this.selectedFsLink = '__UPLOADED__';
    }
  }

  // Helper methods to access event data
  public getPhotoFromFsLinks(): UrlEvent[] {
    if (!this.evenement || !this.evenement.urlEvents) return [];
    return this.evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOFROMFS');
  }

  public getPhotosUrlLinks(): UrlEvent[] {
    if (!this.evenement || !this.evenement.urlEvents) return [];
    return this.evenement.urlEvents.filter(u => (u.typeUrl || '').toUpperCase().trim() === 'PHOTOS');
  }

  public hasImageFiles(): boolean {
    return this._hasImageFiles;
  }

  public getImageFilesCount(): number {
    return this._imageFilesCount;
  }
  
  // Update cached values - call this when evenement data changes
  private updateImageFilesCache(): void {
    if (!this.evenement || !this.evenement.fileUploadeds) {
      this._hasImageFiles = false;
      this._imageFilesCount = 0;
      return;
    }
    const imageFiles = this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName));
    this._hasImageFiles = imageFiles.length > 0;
    this._imageFilesCount = imageFiles.length;
  }

  // Public method to refresh cache - call this when files are loaded asynchronously
  public refreshCache(): void {
    this.updateImageFilesCache();
    this.cdr.markForCheck();
  }

  private isImageFile(fileName: string): boolean {
    if (!fileName) return false;
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
    const lowerFileName = fileName.toLowerCase();
    return imageExtensions.some(ext => lowerFileName.endsWith(ext));
  }

  public isAuthor(): boolean {
    if (!this.evenement || !this.user) return false;
    return this.evenement.author.userName.toLowerCase() === this.user.userName.toLowerCase();
  }
  
  // Save scroll position (simple - no locking)
  private lockScrollPosition(): void {
    // Simply save the current scroll position
    // Don't modify DOM - let Bootstrap handle modal normally
    // Wait a bit to ensure any pending scroll restoration from previous modal (like slideshow) is complete
    // This is important when reopening "Selection de Photos" right after closing slideshow
    const capturePosition = () => {
      this.savedScrollPosition = window.scrollY || window.pageYOffset || 
                                 document.documentElement.scrollTop || 
                                 document.body.scrollTop || 0;
    };
    
    // Capture immediately
    capturePosition();
    
    // Also capture after a short delay to catch any delayed scroll restoration from previous modal
    // The slideshow uses a 300ms delay, so we wait slightly longer (350ms) to ensure it's complete
    setTimeout(capturePosition, 350);
  }
  
  // Restore scroll position - single smooth restore after Bootstrap cleanup
  private unlockScrollPosition(): void {
    const scrollY = this.savedScrollPosition;
    
    // Single restore function - restore once after Bootstrap is completely done
    const restoreScroll = () => {
      // Restore to saved scroll position - single smooth operation
      window.scrollTo({
        top: scrollY,
        left: 0,
        behavior: 'auto' // Instant, no animation to avoid jumps
      });
      if (document.documentElement) {
        document.documentElement.scrollTop = scrollY;
      }
      if (document.body) {
        document.body.scrollTop = scrollY;
      }
    };
    
    // Wait for Bootstrap to finish all cleanup, then restore ONCE
    // Use requestAnimationFrame to ensure DOM is ready, then restore
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Restore after Bootstrap cleanup is complete
        setTimeout(restoreScroll, 300);
      });
    });
  }
  
  // Unblock page scrolling (cleanup any remaining styles)
  private unblockPageScroll(): void {
    if (document.body) {
      document.body.style.overflow = '';
      document.body.style.overflowX = '';
      document.body.style.overflowY = '';
      document.body.style.position = '';
      document.body.style.height = '';
    }
    if (document.documentElement) {
      document.documentElement.style.overflow = '';
      document.documentElement.style.overflowX = '';
      document.documentElement.style.overflowY = '';
    }
  }
}

