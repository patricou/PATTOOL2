import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, ViewChild, TemplateRef, AfterViewInit, ElementRef, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { QuillModule } from 'ngx-quill';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgbModule, NgbModal, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule } from '@ngx-translate/core';
import { Commentary } from '../model/commentary';
import { Member } from '../model/member';
import Quill from 'quill';

@Component({
  selector: 'app-commentary-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, QuillModule, NgbModule, TranslateModule],
  templateUrl: './commentary-editor.html',
  styleUrl: './commentary-editor.css',
  encapsulation: ViewEncapsulation.None
})
export class CommentaryEditor implements OnInit, OnChanges, AfterViewInit {
  @Input() commentaries: Commentary[] = [];
  @Input() currentUser: Member | null = null;
  @Input() eventId: string = '';
  @Input() eventColor: { r: number; g: number; b: number } | null = null;
  @Input() useCalculatedColorsForModal: boolean = false; // If true, use calculated colors for modal (details-evenement)
  @Input() collapsedByDefault: boolean = false; // If true, commentaries are collapsed by default
  @Input() showAddButton: boolean = true; // If false, hides the add commentary button
  @Output() commentaryAdded = new EventEmitter<Commentary>();
  @Output() commentaryUpdated = new EventEmitter<{ commentId: string; commentary: Commentary }>();
  @Output() commentaryDeleted = new EventEmitter<string>();

  @ViewChild('commentaryModal') commentaryModal!: TemplateRef<any>;

  public editingIndex: number | null = null;
  public modalContent: string = '';
  public modalTitle: string = '';
  public isEditMode: boolean = false;
  public isCollapsed: boolean = false; // Controls collapse state of commentaries list
  private modalRef: NgbModalRef | null = null;
  
  // Color styles for modal
  public modalHeaderStyle: any = {};
  public modalBodyStyle: any = {};
  public modalFooterStyle: any = {};
  public buttonPrimaryStyle: any = {};
  public buttonSuccessStyle: any = {};
  
  // Color styles for commentary list
  public buttonAddStyle: any = {};
  public buttonEditStyle: any = {};
  public buttonDeleteStyle: any = {};
  public commentaryItemStyle: any = {};

  // Quill editor configuration with full toolbar
  public quillModules = {
    toolbar: [
      ['bold', 'italic', 'underline', 'strike'],        // Basic formatting
      ['blockquote', 'code-block'],                     // Blocks
      [{ 'header': [1, 2, 3, 4, 5, 6, false] }],       // Header sizes
      [{ 'list': 'ordered'}, { 'list': 'bullet' }],     // Lists
      [{ 'script': 'sub'}, { 'script': 'super' }],      // Subscript/superscript
      [{ 'indent': '-1'}, { 'indent': '+1' }],          // Indentation
      [{ 'direction': 'rtl' }],                          // Text direction
      [{ 'size': ['small', false, 'large', 'huge'] }],  // Font size
      [{ 'color': [] }, { 'background': [] }],          // Text and background colors
      [{ 'font': [] }],                                  // Font family
      [{ 'align': [] }],                                 // Text alignment
      ['clean'],                                         // Remove formatting
      ['link', 'image', 'video']                         // Media
    ]
  };

  constructor(
    private sanitizer: DomSanitizer,
    private modalService: NgbModal,
    private elementRef: ElementRef
  ) {}

  ngOnInit() {
    // Initialize if needed
    this.updateColorStyles();
    // Set initial collapsed state based on input
    this.isCollapsed = this.collapsedByDefault;
  }

  ngAfterViewInit() {
    // Quill styles should be loaded via angular.json or styles.css
    // This is just a fallback check
    // Ensure colors are applied after view init
    this.updateColorStyles();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['commentaries']) {
      // Reset editing state when commentaries change
      this.editingIndex = null;
    }
    if (changes['eventColor']) {
      this.updateColorStyles();
    }
    if (changes['collapsedByDefault']) {
      // Update collapsed state when input changes
      this.isCollapsed = this.collapsedByDefault;
    }
  }
  
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
  }
  
  private updateColorStyles() {
    if (this.eventColor) {
      const color = this.eventColor;
      const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
      const isBright = brightness > 128;
      
      // Calculate inverse text color
      const textColor = isBright ? 'rgb(2, 6, 23)' : 'rgb(255, 255, 255)';
      const textColorSecondary = isBright ? 'rgb(40, 50, 70)' : 'rgb(220, 220, 220)';
      
      // Create color variants
      // Base color
      const baseColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
      
      // Lighter variant for backgrounds (increase brightness by 20-30%)
      const lighterR = Math.min(255, color.r + (isBright ? 20 : 30));
      const lighterG = Math.min(255, color.g + (isBright ? 20 : 30));
      const lighterB = Math.min(255, color.b + (isBright ? 20 : 30));
      const lighterColor = `rgb(${lighterR}, ${lighterG}, ${lighterB})`;
      
      // Very light variant for subtle backgrounds (increase brightness by 40-50%)
      const veryLightRModal = Math.min(255, color.r + (isBright ? 40 : 50));
      const veryLightGModal = Math.min(255, color.g + (isBright ? 40 : 50));
      const veryLightBModal = Math.min(255, color.b + (isBright ? 40 : 50));
      const veryLightColor = `rgb(${veryLightRModal}, ${veryLightGModal}, ${veryLightBModal})`;
      
      // Darker variant for borders and accents (decrease brightness by 15-20%)
      const darkerR = Math.max(0, color.r - (isBright ? 20 : 15));
      const darkerG = Math.max(0, color.g - (isBright ? 20 : 15));
      const darkerB = Math.max(0, color.b - (isBright ? 20 : 15));
      const darkerColor = `rgb(${darkerR}, ${darkerG}, ${darkerB})`;
      
      // Medium variant for hover states
      const mediumR = isBright ? Math.max(0, color.r - 10) : Math.min(255, color.r + 15);
      const mediumG = isBright ? Math.max(0, color.g - 10) : Math.min(255, color.g + 15);
      const mediumB = isBright ? Math.max(0, color.b - 10) : Math.min(255, color.b + 15);
      const mediumColor = `rgb(${mediumR}, ${mediumG}, ${mediumB})`;
      
      // Transparent variants
      const bgColorTransparent = `rgba(${color.r}, ${color.g}, ${color.b}, 0.85)`;
      const bgColorSemiTransparent = `rgba(${color.r}, ${color.g}, ${color.b}, 0.15)`;
      const bgColorVeryLight = `rgba(${color.r}, ${color.g}, ${color.b}, 0.08)`;
      
      // Modal header - use calculated colors if useCalculatedColorsForModal is true, otherwise white
      if (this.useCalculatedColorsForModal) {
        // Use calculated colors for modal (details-evenement)
        const bgColorTransparent = `rgba(${color.r}, ${color.g}, ${color.b}, 0.85)`;
        this.modalHeaderStyle = {
          'background': `linear-gradient(135deg, ${bgColorTransparent} 0%, ${lighterColor} 100%)`,
          'background-color': bgColorTransparent,
          'color': textColor,
          'border-bottom': `2px solid ${darkerColor}`
        };
        
        this.modalBodyStyle = {
          'background-color': bgColorVeryLight,
          'background': `linear-gradient(to bottom, ${bgColorSemiTransparent} 0%, ${bgColorVeryLight} 100%)`,
          'color': textColor
        };
        
        this.modalFooterStyle = {
          'background-color': bgColorSemiTransparent,
          'background': `linear-gradient(to top, ${bgColorSemiTransparent} 0%, ${bgColorVeryLight} 100%)`,
          'border-top': `1px solid ${darkerColor}`
        };
      } else {
        // Default: blue header background with white text (except for details-evenement)
        this.modalHeaderStyle = {
          'background-color': '#007bff',
          'color': '#ffffff',
          'border-bottom': '2px solid #0056b3'
        };
        
        this.modalBodyStyle = {
          'background-color': '#ffffff',
          'color': '#000000'
        };
        
        this.modalFooterStyle = {
          'background-color': '#f8f9fa',
          'border-top': '1px solid #e0e0e0'
        };
      }
      
      // Buttons - use base color with hover variants
      this.buttonPrimaryStyle = {
        'background-color': baseColor,
        'border-color': darkerColor,
        'color': textColor,
        'transition': 'all 0.3s ease'
      };
      
      // Success button - use green for save button in modal
      this.buttonSuccessStyle = {
        'background-color': '#28a745',
        'border-color': '#28a745',
        'color': '#ffffff',
        'transition': 'all 0.3s ease'
      };
      
      // Styles for commentary list buttons
      this.buttonAddStyle = {
        'background-color': baseColor,
        'border-color': darkerColor,
        'color': textColor,
        'transition': 'all 0.3s ease'
      };
      
      // Edit button - use a lighter variant
      const editR = Math.min(255, color.r + (isBright ? 10 : 20));
      const editG = Math.min(255, color.g + (isBright ? 10 : 20));
      const editB = Math.min(255, color.b + (isBright ? 10 : 20));
      const editColor = `rgb(${editR}, ${editG}, ${editB})`;
      
      this.buttonEditStyle = {
        'border-color': editColor,
        'color': editColor,
        'transition': 'all 0.3s ease'
      };
      
      // Delete button - use a red variant based on color
      const deleteR = isBright ? Math.max(0, color.r - 40) : Math.min(255, color.r + 40);
      const deleteG = isBright ? Math.max(0, color.g - 60) : Math.min(255, color.g + 20);
      const deleteB = isBright ? Math.max(0, color.b - 60) : Math.min(255, color.b + 20);
      const deleteColor = `rgb(${deleteR}, ${deleteG}, ${deleteB})`;
      
      this.buttonDeleteStyle = {
        'border-color': deleteColor,
        'color': deleteColor,
        'transition': 'all 0.3s ease'
      };
      
      // Set CSS variables for commentary content styling
      const lightR = Math.min(255, color.r + (isBright ? 50 : 60));
      const lightG = Math.min(255, color.g + (isBright ? 50 : 60));
      const lightB = Math.min(255, color.b + (isBright ? 50 : 60));
      const lightBgColor = `rgba(${lightR}, ${lightG}, ${lightB}, 0.15)`;
      
      const darkR = Math.max(0, color.r - (isBright ? 40 : 30));
      const darkG = Math.max(0, color.g - (isBright ? 40 : 30));
      const darkB = Math.max(0, color.b - (isBright ? 40 : 30));
      const darkTextColor = `rgb(${darkR}, ${darkG}, ${darkB})`;
      
      // Very light background for commentary items - make it more visible
      const veryLightR = Math.min(255, color.r + (isBright ? 70 : 80));
      const veryLightG = Math.min(255, color.g + (isBright ? 70 : 80));
      const veryLightB = Math.min(255, color.b + (isBright ? 70 : 80));
      const veryLightBgColor = `rgba(${veryLightR}, ${veryLightG}, ${veryLightB}, 0.4)`;
      const veryLightBgHover = `rgba(${veryLightR}, ${veryLightG}, ${veryLightB}, 0.5)`;
      
      // Dark text color for commentary items - make it darker for better contrast
      const itemDarkR = Math.max(0, color.r - (isBright ? 60 : 50));
      const itemDarkG = Math.max(0, color.g - (isBright ? 60 : 50));
      const itemDarkB = Math.max(0, color.b - (isBright ? 60 : 50));
      const itemDarkTextColor = `rgb(${itemDarkR}, ${itemDarkG}, ${itemDarkB})`;
      
      // Commentary item style - removed, using CSS variables like other cards
      this.commentaryItemStyle = {};
      
      // Apply CSS variables to the component's host element for modal only
      // For commentary items, we use global CSS variables from applyEventColor()
      if (this.elementRef && this.elementRef.nativeElement) {
        const hostElement = this.elementRef.nativeElement as HTMLElement;
        hostElement.style.setProperty('--commentary-light-bg', lightBgColor);
        hostElement.style.setProperty('--commentary-dark-text', darkTextColor);
      }
      
      // Also set on document root as fallback for modal
      if (typeof document !== 'undefined') {
        const style = document.documentElement.style;
        style.setProperty('--commentary-light-bg', lightBgColor);
        style.setProperty('--commentary-dark-text', darkTextColor);
      }
    } else {
      // Default styles - Modal header blue, body white with black text
      this.modalHeaderStyle = {
        'background-color': '#007bff',
        'color': '#ffffff',
        'border-bottom': '2px solid #0056b3'
      };
      
      this.modalBodyStyle = {
        'background-color': '#ffffff',
        'color': '#000000'
      };
      
      this.modalFooterStyle = {
        'background-color': '#f8f9fa',
        'border-top': '1px solid #e0e0e0'
      };
      
      this.buttonPrimaryStyle = {};
      this.buttonSuccessStyle = {
        'background-color': '#28a745',
        'border-color': '#28a745',
        'color': '#ffffff',
        'transition': 'all 0.3s ease'
      };
      this.buttonAddStyle = {};
      this.buttonEditStyle = {};
      this.buttonDeleteStyle = {};
      this.commentaryItemStyle = {};
      
      // Set default CSS variables
      if (typeof document !== 'undefined') {
        const style = document.documentElement.style;
        style.setProperty('--commentary-light-bg', 'rgba(240, 240, 240, 0.15)');
        style.setProperty('--commentary-dark-text', 'rgb(40, 40, 40)');
        style.setProperty('--commentary-item-bg', 'rgba(248, 249, 250, 1)');
        style.setProperty('--commentary-item-bg-hover', 'rgba(233, 236, 239, 1)');
        style.setProperty('--commentary-item-text', 'rgb(40, 40, 40)');
      }
    }
  }

  isOwner(commentary: Commentary): boolean {
    if (!this.currentUser || !commentary) {
      return false;
    }
    return commentary.commentOwner === this.currentUser.userName;
  }

  openAddModal() {
    this.isEditMode = false;
    this.editingIndex = null;
    this.modalTitle = 'Nouveau commentaire';
    this.modalContent = '';
    this.openModal();
  }

  openEditModal(index: number) {
    if (index < 0 || index >= this.commentaries.length) {
      return;
    }
    const commentary = this.commentaries[index];
    if (!this.isOwner(commentary)) {
      return;
    }
    this.isEditMode = true;
    this.editingIndex = index;
    this.modalTitle = 'Modifier le commentaire';
    this.modalContent = commentary.commentary;
    this.openModal();
  }

  private openModal() {
    if (!this.commentaryModal) {
      console.error('Commentary modal template not found');
      return;
    }

    // Save scroll position before opening modal
    const savedScrollY = window.scrollY || window.pageYOffset || 
      document.documentElement.scrollTop || 
      document.body.scrollTop || 0;

    // Open the modal
    this.modalRef = this.modalService.open(this.commentaryModal, {
      size: 'lg',
      centered: true,
      backdrop: 'static',
      keyboard: false,
      windowClass: 'commentary-modal'
    });

    // Apply white border to modal content after opening
    setTimeout(() => {
      // Try multiple selectors to find the modal content
      let modalElement = document.querySelector('.modal.commentary-modal.show .modal-content') as HTMLElement;
      if (!modalElement) {
        modalElement = document.querySelector('.commentary-modal.show .modal-content') as HTMLElement;
      }
      if (!modalElement) {
        modalElement = document.querySelector('.modal.show .commentary-modal .modal-content') as HTMLElement;
      }
      if (!modalElement && this.modalRef) {
        // Try to get element from modalRef
        const modalElementRef = (this.modalRef as any).componentInstance?.elementRef?.nativeElement?.querySelector('.modal-content');
        if (modalElementRef) {
          modalElement = modalElementRef;
        }
      }
      if (modalElement) {
        modalElement.style.setProperty('border', '4px solid #ffffff', 'important');
        modalElement.style.setProperty('border-width', '4px', 'important');
        modalElement.style.setProperty('border-style', 'solid', 'important');
        modalElement.style.setProperty('border-color', '#ffffff', 'important');
        modalElement.style.setProperty('border-radius', '8px', 'important');
        modalElement.style.setProperty('overflow', 'hidden', 'important');
      }
    }, 200);

    // Restore scroll when modal closes
    this.modalRef.result.finally(() => {
      this.modalRef = null;
      // Restore scroll position
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.scrollTo(0, savedScrollY);
        });
      });
    }).catch(() => {
      this.modalRef = null;
      // Restore scroll position on dismissal
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.scrollTo(0, savedScrollY);
        });
      });
    });
  }

  saveModal() {
    if (!this.modalContent || this.modalContent.trim() === '') {
      alert('Le commentaire ne peut pas être vide');
      return;
    }

    if (this.isEditMode && this.editingIndex !== null) {
      // Update existing commentary
      const commentary = this.commentaries[this.editingIndex];
      const updatedCommentary = new Commentary(
        commentary.commentOwner,
        this.modalContent.trim(),
        commentary.dateCreation,
        commentary.id // Preserve the ID
      );

      // For create mode (no eventId), use index as temporary ID
      if (!commentary.id && !this.eventId) {
        // Generate a temporary ID based on index and timestamp
        const tempId = 'temp_' + this.editingIndex + '_' + Date.now();
        updatedCommentary.id = tempId;
        this.commentaryUpdated.emit({
          commentId: tempId,
          commentary: updatedCommentary
        });
      } else if (!commentary.id) {
        console.error('Cannot update commentary without ID');
        alert('Erreur : le commentaire n\'a pas d\'ID');
        return;
      } else {
        this.commentaryUpdated.emit({
          commentId: commentary.id,
          commentary: updatedCommentary
        });
      }
    } else {
      // Create new commentary
      const newCommentary = new Commentary(
        this.currentUser?.userName || '',
        this.modalContent.trim(),
        new Date()
      );

      this.commentaryAdded.emit(newCommentary);
    }

    // Close modal
    if (this.modalRef) {
      this.modalRef.close();
    }
  }

  cancelModal() {
    if (this.modalRef) {
      this.modalRef.dismiss();
    }
  }

  deleteCommentary(index: number) {
    if (index < 0 || index >= this.commentaries.length) {
      return;
    }
    const commentary = this.commentaries[index];
    if (!this.isOwner(commentary)) {
      return;
    }

    if (confirm('Êtes-vous sûr de vouloir supprimer ce commentaire ?')) {
      // Emit the commentary ID if available, or use index for create mode
      if (commentary.id) {
        this.commentaryDeleted.emit(commentary.id);
      } else if (!this.eventId) {
        // For create mode (no eventId), use index as temporary ID
        const tempId = 'temp_' + index + '_' + Date.now();
        this.commentaryDeleted.emit(tempId);
      } else {
        console.error('Cannot delete commentary without ID');
        alert('Erreur : le commentaire n\'a pas d\'ID');
      }
    }
  }

  getSafeHtml(html: string): SafeHtml {
    if (!html) {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }

    const color = this.eventColor;
    if (!color) {
      return this.sanitizer.bypassSecurityTrustHtml(html);
    }

    // Calculate color variants
    const brightness = (0.299 * color.r + 0.587 * color.g + 0.114 * color.b);
    const isBright = brightness > 128;
    
    // Light variant for background (increase brightness by 50-60%)
    const lightR = Math.min(255, color.r + (isBright ? 50 : 60));
    const lightG = Math.min(255, color.g + (isBright ? 50 : 60));
    const lightB = Math.min(255, color.b + (isBright ? 50 : 60));
    const lightBgColor = `rgba(${lightR}, ${lightG}, ${lightB}, 0.15)`;
    
    // Dark variant for text (decrease brightness by 30-40%)
    const darkR = Math.max(0, color.r - (isBright ? 40 : 30));
    const darkG = Math.max(0, color.g - (isBright ? 40 : 30));
    const darkB = Math.max(0, color.b - (isBright ? 40 : 30));
    const darkTextColor = `rgb(${darkR}, ${darkG}, ${darkB})`;

    // Process HTML string to replace background styles
    let processedHtml = html;
    
    // Replace background colors/styles in style attributes
    processedHtml = processedHtml.replace(
      /style\s*=\s*["']([^"']*)["']/gi,
      (match, styleContent) => {
        // Remove existing background-related styles
        let newStyle = styleContent
          .replace(/background[^:;]*:\s*[^;]*;?/gi, '')
          .replace(/background-color[^:;]*:\s*[^;]*;?/gi, '')
          .replace(/background-image[^:;]*:\s*[^;]*;?/gi, '')
          .trim();
        
        // Add new light background color
        if (newStyle && !newStyle.endsWith(';')) {
          newStyle += ';';
        }
        newStyle = `background-color: ${lightBgColor}; ${newStyle}`.trim();
        
        // Add dark text color if not present
        if (!newStyle.includes('color:')) {
          newStyle += ` color: ${darkTextColor};`;
        } else {
          // Replace existing color if it's a light color
          newStyle = newStyle.replace(
            /color\s*:\s*[^;]*/gi,
            (colorMatch: string) => {
              const colorValue = colorMatch.split(':')[1]?.trim() || '';
              // Check if it's a light color (white, light colors, or high RGB values)
              if (colorValue.includes('255') || 
                  colorValue.toLowerCase().includes('white') ||
                  colorValue.toLowerCase().includes('light') ||
                  colorValue.match(/rgba?\([^)]*255[^)]*\)/i)) {
                return `color: ${darkTextColor}`;
              }
              return colorMatch;
            }
          );
        }
        
        return `style="${newStyle}"`;
      }
    );
    
    // Add style to elements without style attribute that might have background
    // This is a fallback for elements that might have background set via classes
    // We'll handle this via CSS instead
    
    return this.sanitizer.bypassSecurityTrustHtml(processedHtml);
  }

  formatDate(date: Date): string {
    if (!date) {
      return '';
    }
    const d = new Date(date);
    return d.toLocaleDateString('fr-FR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}
