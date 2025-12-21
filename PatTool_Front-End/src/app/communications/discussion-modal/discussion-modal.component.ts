// Discussion Modal Component - Opens discussion in a modal
import { Component, Input, OnInit, OnDestroy, ViewChild, AfterViewInit, ElementRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgbModule, NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { DiscussionComponent } from '../discussion/discussion.component';

@Component({
  selector: 'app-discussion-modal',
  templateUrl: './discussion-modal.component.html',
  styleUrls: ['./discussion-modal.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    NgbModule,
    DiscussionComponent
  ]
})
export class DiscussionModalComponent implements OnInit, OnDestroy, AfterViewInit {
  @Input() discussionId: string | null = null;
  @Input() title: string = 'Discussion';
  @Input() eventColor?: { r: number; g: number; b: number };
  @ViewChild(DiscussionComponent) discussionComponent!: DiscussionComponent;
  
  private observer?: MutationObserver;
  private colorApplied: boolean = false;
  
  // Local properties to avoid ExpressionChangedAfterItHasBeenCheckedError
  public connectionStatus: string = '';
  public isConnecting: boolean = false;
  public isLoading: boolean = false;
  private statusCheckInterval?: any;
  private pendingTimeouts: any[] = []; // Track all setTimeout calls for cleanup
  private isDestroyed: boolean = false; // Flag to prevent operations after destruction

  constructor(public activeModal: NgbActiveModal, private elementRef: ElementRef, private cdr: ChangeDetectorRef) {}

  ngOnInit() {
    // Modal is initialized - give it a moment to fully render
    // The DiscussionComponent will handle its own initialization
    
    // Use MutationObserver to detect when modal is added to DOM
    if (this.eventColor) {
      this.setupColorObserver();
      
      // Also try immediately and with delays
      this.addTimeout(() => {
        if (!this.isDestroyed) {
          this.applyEventColorToModal();
        }
      }, 50);
      this.addTimeout(() => {
        if (!this.isDestroyed) {
          this.applyEventColorToModal();
        }
      }, 200);
      this.addTimeout(() => {
        if (!this.isDestroyed) {
          this.applyEventColorToModal();
        }
      }, 500);
    }
  }

  ngAfterViewInit() {
    // Apply event color after view is initialized
    if (this.eventColor) {
      this.addTimeout(() => {
        if (!this.isDestroyed) {
          this.applyEventColorToModal();
        }
      }, 100);
      this.addTimeout(() => {
        if (!this.isDestroyed) {
          this.applyEventColorToModal();
        }
      }, 300);
      this.addTimeout(() => {
        if (!this.isDestroyed) {
          this.applyEventColorToModal();
        }
      }, 600);
    }
    
    // Always apply Fermer button color regardless of event color
    this.addTimeout(() => {
      if (!this.isDestroyed) {
        this.applyFermerButtonColor();
      }
    }, 200);
    this.addTimeout(() => {
      if (!this.isDestroyed) {
        this.applyFermerButtonColor();
      }
    }, 500);
    
    // Defer initialization to next tick to avoid ExpressionChangedAfterItHasBeenCheckedError
    // This ensures the DiscussionComponent has fully initialized before we read its properties
    this.addTimeout(() => {
      if (this.isDestroyed) return;
      
      // Initialize local properties if discussionComponent is available
      if (this.discussionComponent) {
        this.connectionStatus = this.discussionComponent.connectionStatus || '';
        this.isConnecting = this.discussionComponent.isConnecting || false;
        this.isLoading = this.discussionComponent.isLoading || false;
        // Mark for check to update the view
        this.cdr.markForCheck();
      }
      
      // Start polling for connection status changes
      // This avoids ExpressionChangedAfterItHasBeenCheckedError by updating
      // local properties asynchronously
      this.startStatusPolling();
    }, 0);
  }

  private startStatusPolling() {
    // Poll every 200ms to check for status changes
    // This ensures we catch changes without triggering ExpressionChangedAfterItHasBeenCheckedError
    // The polling is lightweight and only updates when values actually change
    this.statusCheckInterval = setInterval(() => {
      if (this.isDestroyed) {
        return;
      }
      
      if (this.discussionComponent) {
        const newStatus = this.discussionComponent.connectionStatus || '';
        const newIsConnecting = this.discussionComponent.isConnecting || false;
        const newIsLoading = this.discussionComponent.isLoading || false;
        
        // Only update if values have changed
        if (this.connectionStatus !== newStatus || 
            this.isConnecting !== newIsConnecting || 
            this.isLoading !== newIsLoading) {
          // Update values in the next tick to avoid ExpressionChangedAfterItHasBeenCheckedError
          this.addTimeout(() => {
            if (!this.isDestroyed) {
              this.connectionStatus = newStatus;
              this.isConnecting = newIsConnecting;
              this.isLoading = newIsLoading;
              // Use markForCheck instead of detectChanges to avoid triggering change detection during check
              this.cdr.markForCheck();
            }
          }, 0);
        }
      }
    }, 200);
  }
  
  /**
   * Helper method to track and manage setTimeout calls
   */
  private addTimeout(callback: () => void, delay: number): void {
    const timeoutId = setTimeout(callback, delay);
    this.pendingTimeouts.push(timeoutId);
  }

  ngOnDestroy() {
    // Mark as destroyed to prevent any further operations
    this.isDestroyed = true;
    
    // Clean up observer
    if (this.observer) {
      this.observer.disconnect();
      this.observer = undefined;
    }
    
    // Clean up status polling interval
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = undefined;
    }
    
    // Clear all pending timeouts
    this.pendingTimeouts.forEach(timeoutId => {
      clearTimeout(timeoutId);
    });
    this.pendingTimeouts = [];
  }

  private setupColorObserver(): void {
    // Observe body for modal addition
    this.observer = new MutationObserver((mutations) => {
      if (!this.colorApplied && this.eventColor) {
        const modalFound = this.findAndApplyColor();
        if (modalFound) {
          this.colorApplied = true;
          // Keep observing for a bit in case modal is re-rendered
          this.addTimeout(() => {
            if (!this.isDestroyed && this.observer) {
              this.observer.disconnect();
              this.observer = undefined;
            }
          }, 2000);
        }
      }
    });

    // Start observing
    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private findAndApplyColor(): boolean {
    return this.applyEventColorToModal();
  }

  close() {
    this.activeModal.close();
  }

  refreshDiscussion() {
    if (this.discussionComponent) {
      // Reload the discussion
      this.discussionComponent.loadDiscussion();
    }
  }

  // Apply event color to modal styling (public for external calls)
  public applyEventColorToModal(): boolean {
    if (this.isDestroyed || !this.eventColor) {
      return false;
    }
    
    const color = this.eventColor;
    // Calculate brightness to determine if we need lighter or darker variants
    const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
    const isBright = brightness > 128;
    
    // Header background - use gradient based on event color
    const headerBgR = Math.min(255, color.r + 20);
    const headerBgG = Math.min(255, color.g + 20);
    const headerBgB = Math.min(255, color.b + 20);
    const headerBg2R = Math.max(0, color.r - 10);
    const headerBg2G = Math.max(0, color.g - 10);
    const headerBg2B = Math.max(0, color.b - 10);
    const headerBorderR = Math.max(0, color.r - 15);
    const headerBorderG = Math.max(0, color.g - 15);
    const headerBorderB = Math.max(0, color.b - 15);
    
    // Header text color - inverse based on brightness
    const headerTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
    
    // Footer background - use darker variant of event color
    const footerBgR = Math.max(0, color.r - 30);
    const footerBgG = Math.max(0, color.g - 30);
    const footerBgB = Math.max(0, color.b - 30);
    const footerBorderR = Math.max(0, color.r - 20);
    const footerBorderG = Math.max(0, color.g - 20);
    const footerBorderB = Math.max(0, color.b - 20);
    
    // Footer button colors - use event color with adjustments
    const footerButtonBorderR = Math.min(255, color.r + 20);
    const footerButtonBorderG = Math.min(255, color.g + 20);
    const footerButtonBorderB = Math.min(255, color.b + 20);
    const footerButtonTextColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
    const footerButtonHoverBgR = Math.min(255, color.r + 30);
    const footerButtonHoverBgG = Math.min(255, color.g + 30);
    const footerButtonHoverBgB = Math.min(255, color.b + 30);
    
    // Border color - use event color
    const borderColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
    
    // Try to find modal element - check all possible locations
    let modalElement: HTMLElement | null = null;
    
    // Try various selectors
    const selectors = [
      '.discussion-modal-window .modal-content',
      '.discussion-maximized-modal .modal-content',
      '.modal.show .discussion-modal-window .modal-content',
      '.modal.show .discussion-maximized-modal .modal-content',
      '.modal.show .modal-content',
      '.modal-content.discussion-modal-window',
      '.modal-content.discussion-maximized-modal'
    ];
    
    for (const selector of selectors) {
      modalElement = document.querySelector(selector) as HTMLElement;
      if (modalElement) {
        break;
      }
    }
    
    // If still not found, try to find any modal with our header/footer
    if (!modalElement) {
      const allModals = document.querySelectorAll('.modal-content');
      for (let i = 0; i < allModals.length; i++) {
        const modal = allModals[i] as HTMLElement;
        const header = modal.querySelector('.modal-header');
        const footer = modal.querySelector('.modal-footer');
        if (header && footer) {
          modalElement = modal;
          break;
        }
      }
    }
    
    if (modalElement && document.body.contains(modalElement)) {
      try {
        // Apply CSS variables
        modalElement.style.setProperty('--discussion-header-bg', `linear-gradient(135deg, rgb(${headerBgR}, ${headerBgG}, ${headerBgB}) 0%, rgb(${headerBg2R}, ${headerBg2G}, ${headerBg2B}) 100%)`);
        modalElement.style.setProperty('--discussion-header-text', headerTextColor);
        modalElement.style.setProperty('--discussion-header-border', `rgb(${headerBorderR}, ${headerBorderG}, ${headerBorderB})`);
        modalElement.style.setProperty('--discussion-footer-bg', `rgb(${footerBgR}, ${footerBgG}, ${footerBgB})`);
        modalElement.style.setProperty('--discussion-footer-border', `rgb(${footerBorderR}, ${footerBorderG}, ${footerBorderB})`);
        modalElement.style.setProperty('--discussion-footer-button-border', `rgba(${footerButtonBorderR}, ${footerButtonBorderG}, ${footerButtonBorderB}, 0.5)`);
        modalElement.style.setProperty('--discussion-footer-button-text', footerButtonTextColor);
        modalElement.style.setProperty('--discussion-footer-button-hover-bg', `rgba(${footerButtonHoverBgR}, ${footerButtonHoverBgG}, ${footerButtonHoverBgB}, 0.2)`);
        modalElement.style.setProperty('--discussion-border', borderColor);
        
        // Apply directly to header and footer elements (more reliable)
        const headerElement = modalElement.querySelector('.modal-header') as HTMLElement;
        if (headerElement && document.body.contains(headerElement)) {
          headerElement.style.background = `linear-gradient(135deg, rgb(${headerBgR}, ${headerBgG}, ${headerBgB}) 0%, rgb(${headerBg2R}, ${headerBg2G}, ${headerBg2B}) 100%)`;
          headerElement.style.borderBottomColor = `rgb(${headerBorderR}, ${headerBorderG}, ${headerBorderB})`;
          const titleElement = headerElement.querySelector('.modal-title') as HTMLElement;
          if (titleElement && document.body.contains(titleElement)) {
            titleElement.style.color = headerTextColor;
          }
          const closeButton = headerElement.querySelector('.btn-close') as HTMLElement;
          if (closeButton && document.body.contains(closeButton)) {
            closeButton.style.color = headerTextColor;
          }
        }
        
        const footerElement = modalElement.querySelector('.modal-footer') as HTMLElement;
        if (footerElement && document.body.contains(footerElement)) {
          footerElement.style.background = `rgb(${footerBgR}, ${footerBgG}, ${footerBgB})`;
          footerElement.style.borderTopColor = `rgb(${footerBorderR}, ${footerBorderG}, ${footerBorderB})`;
          
          // Apply button styles
          const buttons = footerElement.querySelectorAll('.btn');
          buttons.forEach(btn => {
            const btnElement = btn as HTMLElement;
            if (btnElement && document.body.contains(btnElement)) {
              // Don't apply event color to btn-secondary (Fermer button) - use gray instead
              if (btnElement.classList.contains('btn-secondary') || btnElement.classList.contains('btn-fermer')) {
                btnElement.style.backgroundColor = '#6c757d';
                btnElement.style.background = '#6c757d';
                btnElement.style.borderColor = '#6c757d';
                btnElement.style.color = '#ffffff';
              } else {
                btnElement.style.borderColor = `rgba(${footerButtonBorderR}, ${footerButtonBorderG}, ${footerButtonBorderB}, 0.5)`;
                btnElement.style.color = footerButtonTextColor;
              }
            }
          });
          
          // Also apply gray color to btn-secondary specifically after a delay to ensure it overrides
          this.addTimeout(() => {
            if (this.isDestroyed) return;
            // Re-check that footerElement still exists in DOM
            if (footerElement && document.body.contains(footerElement)) {
              const fermerButton = footerElement.querySelector('.btn-secondary, .btn-fermer') as HTMLElement;
              if (fermerButton && document.body.contains(fermerButton)) {
                fermerButton.style.backgroundColor = '#6c757d';
                fermerButton.style.background = '#6c757d';
                fermerButton.style.borderColor = '#6c757d';
                fermerButton.style.color = '#ffffff';
              }
            }
          }, 100);
        }
        
        // Apply border to modal content
        modalElement.style.borderColor = borderColor;
        modalElement.style.borderWidth = '4px';
        modalElement.style.borderStyle = 'solid';
        
        return true;
      } catch (error) {
        // Silently fail if element is no longer in DOM
        return false;
      }
    }
    
    return false;
  }

  // Apply gray color to Fermer button
  private applyFermerButtonColor(): void {
    if (this.isDestroyed) {
      return;
    }
    
    // Try to find modal footer element
    const selectors = [
      '.discussion-modal-window .modal-footer',
      '.discussion-maximized-modal .modal-footer',
      '.modal.show .discussion-modal-window .modal-footer',
      '.modal.show .discussion-maximized-modal .modal-footer',
      '.modal.show .modal-footer'
    ];
    
    let footerElement: HTMLElement | null = null;
    for (const selector of selectors) {
      footerElement = document.querySelector(selector) as HTMLElement;
      if (footerElement) {
        break;
      }
    }
    
    // If still not found, try to find any modal footer
    if (!footerElement) {
      const allFooters = document.querySelectorAll('.modal-footer');
      for (let i = 0; i < allFooters.length; i++) {
        const footer = allFooters[i] as HTMLElement;
        const fermerButton = footer.querySelector('.btn-secondary, .btn-fermer');
        if (fermerButton) {
          footerElement = footer;
          break;
        }
      }
    }
    
    if (footerElement && document.body.contains(footerElement)) {
      try {
        const fermerButton = footerElement.querySelector('.btn-secondary, .btn-fermer') as HTMLElement;
        if (fermerButton && document.body.contains(fermerButton)) {
          fermerButton.style.backgroundColor = '#6c757d';
          fermerButton.style.background = '#6c757d';
          fermerButton.style.borderColor = '#6c757d';
          fermerButton.style.color = '#ffffff';
          
          // Also set hover state
          const mouseEnterHandler = () => {
            if (!this.isDestroyed && fermerButton && document.body.contains(fermerButton)) {
              fermerButton.style.backgroundColor = '#5a6268';
              fermerButton.style.background = '#5a6268';
              fermerButton.style.borderColor = '#545b62';
            }
          };
          const mouseLeaveHandler = () => {
            if (!this.isDestroyed && fermerButton && document.body.contains(fermerButton)) {
              fermerButton.style.backgroundColor = '#6c757d';
              fermerButton.style.background = '#6c757d';
              fermerButton.style.borderColor = '#6c757d';
            }
          };
          
          fermerButton.addEventListener('mouseenter', mouseEnterHandler);
          fermerButton.addEventListener('mouseleave', mouseLeaveHandler);
        }
      } catch (error) {
        // Silently fail if element is no longer in DOM
      }
    }
  }
}

