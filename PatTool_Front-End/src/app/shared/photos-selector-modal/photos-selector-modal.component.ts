import { Component, OnInit, Input, Output, EventEmitter, ViewChild, TemplateRef } from '@angular/core';
import { Router } from '@angular/router';
import { NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateService } from '@ngx-translate/core';
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
  styleUrls: ['./photos-selector-modal.component.css']
})
export class PhotosSelectorModalComponent implements OnInit {
  @Input() evenement!: Evenement;
  @Input() includeUploadedChoice: boolean = false;
  @Input() user!: Member;
  
  @Output() selectionConfirmed = new EventEmitter<PhotosSelectionResult>();
  @Output() closed = new EventEmitter<void>();
  
  @ViewChild('photosSelectorModal') photosSelectorModal!: TemplateRef<any>;
  
  public selectedFsLink: string = '';
  public fsCompressionEnabled: boolean = true;
  private modalRef?: NgbModalRef;
  
  // Scroll position preservation - using CSS lock method
  private savedScrollPosition: number = 0;

  constructor(
    private modalService: NgbModal,
    private translateService: TranslateService,
    private router: Router
  ) {}

  ngOnInit(): void {
    // Initialize default selection
    this.initializeDefaultSelection();
  }

  public open(): void {
    if (!this.evenement) {
      console.warn('No event provided to photos selector');
      return;
    }

    // Reset selection
    this.selectedFsLink = '';
    this.fsCompressionEnabled = true;
    this.initializeDefaultSelection();

    if (!this.photosSelectorModal) {
      console.warn('Photos selector modal template not found');
      return;
    }

    // Lock scroll position before opening modal (prevents any movement)
    this.lockScrollPosition();
    
    this.modalRef = this.modalService.open(this.photosSelectorModal, {
      centered: true,
      size: 'lg',
      windowClass: 'fs-selector-modal',
      backdrop: 'static',
      keyboard: false
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
      // Then restore scroll position ONCE after a delay
      this.unlockScrollPosition();
      this.closed.emit();
    }).catch(() => {
      // Unblock scroll first
      this.unblockPageScroll();
      // Then restore scroll position ONCE after a delay
      this.unlockScrollPosition();
      this.closed.emit();
    });
  }

  public close(): void {
    if (this.modalRef) {
      this.modalRef.close();
    }
    // Unblock scroll first
    this.unblockPageScroll();
    // Then restore scroll position ONCE after a delay
    this.unlockScrollPosition();
  }

  public confirmSelection(modalRef?: any): void {
    if (!this.selectedFsLink) {
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

    if (modalRef) {
      modalRef.close();
    } else if (this.modalRef) {
      this.modalRef.close();
    }
  }

  private initializeDefaultSelection(): void {
    if (!this.evenement) {
      return;
    }

    const fsLinks = this.getPhotoFromFsLinks();
    const webLinks = this.getPhotosUrlLinks();

    // Default selection priority: uploaded (if requested and available) -> first FS link -> first web photos link
    if (this.includeUploadedChoice && this.hasImageFiles()) {
      this.selectedFsLink = '__UPLOADED__';
    } else if (fsLinks.length > 0) {
      this.selectedFsLink = fsLinks[0].link;
    } else if (webLinks.length > 0) {
      this.selectedFsLink = 'PHOTOS:' + webLinks[0].link;
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
    if (!this.evenement || !this.evenement.fileUploadeds) return false;
    return this.evenement.fileUploadeds.some(file => this.isImageFile(file.fileName));
  }

  public getImageFilesCount(): number {
    if (!this.evenement || !this.evenement.fileUploadeds) return 0;
    return this.evenement.fileUploadeds.filter(file => this.isImageFile(file.fileName)).length;
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
    this.savedScrollPosition = window.scrollY || window.pageYOffset || 
                               document.documentElement.scrollTop || 
                               document.body.scrollTop || 0;
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

