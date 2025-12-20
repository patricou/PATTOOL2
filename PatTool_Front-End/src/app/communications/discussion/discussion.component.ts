// Discussion Component - Reusable component for discussions
import { Component, OnInit, OnDestroy, ViewChild, ElementRef, Input, OnChanges, SimpleChanges, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DiscussionService, Discussion, DiscussionMessage } from '../../services/discussion.service';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';
import { Subscription } from 'rxjs';
import * as piexif from 'piexifjs';

@Component({
  selector: 'app-discussion',
  templateUrl: './discussion.component.html',
  styleUrls: ['./discussion.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule
  ]
})
export class DiscussionComponent implements OnInit, OnDestroy, OnChanges {
  @Input() discussionId: string | null = null; // ID of the discussion to load
  @Input() title: string = ''; // Optional title for the discussion
  @Input() showTitle: boolean = true; // Whether to show the title section

  public messages: DiscussionMessage[] = [];
  public msgVal: string = '';
  public user: Member = new Member("", "", "", "", "", [], "");
  public currentDiscussion: Discussion | null = null;
  public selectedImage: File | null = null;
  public selectedVideo: File | null = null;
  public imagePreview: string | null = null;
  public videoPreview: string | null = null;
  public isLoading: boolean = false;
  public isConnecting: boolean = false;
  public connectionStatus: string = '';
  public showEmojiPicker: boolean = false;
  private shouldScrollToBottom: boolean = true;
  public editingMessageId: string | null = null;
  private imageUrlCache: Map<string, string> = new Map(); // Cache for blob URLs

  @ViewChild('messagesList', { static: false }) messagesList!: ElementRef;
  @ViewChild('fileInput', { static: false }) fileInput!: ElementRef;
  @ViewChild('messageInput', { static: false }) messageInput!: ElementRef;

  private messageSubscription: Subscription | null = null;
  private discussionsSubscription: Subscription | null = null;

  constructor(
    private discussionService: DiscussionService,
    public _memberService: MembersService,
    private cdr: ChangeDetectorRef,
    private translateService: TranslateService
  ) {}

  ngOnInit() {
    try {
      this.user = this._memberService.getUser();
      // Load discussion immediately - no delay needed
      this.loadDiscussion();
    } catch (error) {
      // Don't let errors break the component
    }
  }

  /**
   * Persist log to localStorage so we can see it even after redirect
   */
  private persistLog(message: string, level: string = 'INFO') {
    try {
      const logs = JSON.parse(localStorage.getItem('discussionLogs') || '[]');
      const timestamp = new Date().toISOString();
      logs.push({ timestamp, level, message });
      // Keep only last 100 logs
      if (logs.length > 100) {
        logs.shift();
      }
      localStorage.setItem('discussionLogs', JSON.stringify(logs));
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  /**
   * Get persisted logs - call this method from browser console: 
   * localStorage.getItem('discussionLogs')
   * or
   * JSON.parse(localStorage.getItem('discussionLogs'))
   */
  public static getPersistedLogs(): any[] {
    try {
      return JSON.parse(localStorage.getItem('discussionLogs') || '[]');
    } catch (e) {
      return [];
    }
  }

  /**
   * Clear persisted logs
   */
  public static clearPersistedLogs(): void {
    localStorage.removeItem('discussionLogs');
  }

  /**
   * Display persisted logs in console - can be called from browser console
   */
  public static displayPersistedLogs(): any[] {
    const logs = DiscussionComponent.getPersistedLogs();
    return logs;
  }

  ngOnChanges(changes: SimpleChanges) {
    // Reload discussion if discussionId changes
    if (changes['discussionId'] && !changes['discussionId'].firstChange) {
      this.disconnectWebSocket();
      this.loadDiscussion();
    }
  }

  ngOnDestroy() {
    this.disconnectWebSocket();
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
    }
    if (this.discussionsSubscription) {
      this.discussionsSubscription.unsubscribe();
    }
    // Clean up blob URLs to prevent memory leaks
    this.imageUrlCache.forEach((blobUrl) => {
      if (blobUrl && blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrl);
      }
    });
    this.imageUrlCache.clear();
  }

  /**
   * Load discussion by ID or use default
   */
  public loadDiscussion() {
    try {
      if (this.discussionId) {
        // Load specific discussion by ID
        this.loadDiscussionById(this.discussionId);
      } else {
        // Load default discussion
        this.loadOrCreateDefaultDiscussion();
      }
    } catch (error) {
      // Don't let errors break the component
      this.isLoading = false;
      this.connectionStatus = 'Error loading discussion';
    }
  }

  /**
   * Load a specific discussion by ID
   */
  private loadDiscussionById(id: string) {
    this.isLoading = true;
    this.connectionStatus = 'Loading discussion...';
    
    this.discussionsSubscription = this.discussionService.getDiscussionById(id).subscribe({
      next: (discussion) => {
        if (discussion && discussion.id) {
          this.currentDiscussion = discussion;
          this.loadMessages();
          this.connectWebSocket();
        } else {
          this.connectionStatus = 'Discussion not found';
          this.isLoading = false;
        }
      },
      error: (error) => {
        this.connectionStatus = 'Error loading discussion';
        this.isLoading = false;
      }
    });
  }

  /**
   * Load or create the default discussion
   */
  private async loadOrCreateDefaultDiscussion() {
    try {
      this.isLoading = true;
      this.connectionStatus = 'Loading Discussion Generale...';
      
      // Try to get the default discussion first
      this.discussionsSubscription = this.discussionService.getDefaultDiscussion().subscribe({
        next: (discussion: Discussion) => {
          if (discussion && discussion.id) {
            this.currentDiscussion = discussion;
            this.loadMessages();
            // Connect WebSocket immediately - no delay needed
            // Note: isLoading will be set to false in loadMessages() after messages are loaded
            this.connectWebSocket();
          } else {
            // If default discussion not found, try to get all discussions as fallback
            this.fallbackToFirstDiscussion();
          }
          // Don't set isLoading = false here - let loadMessages() or fallbackToFirstDiscussion() handle it
        },
        error: (error: any) => {
          // If it's a 401, the interceptor will redirect to login, so don't try fallback
          if (error?.status === 401) {
            this.isLoading = false;
            return;
          }
          
          // Fallback: try to get all discussions (like the old code did)
          this.fallbackToFirstDiscussion();
        }
      });
    } catch (error) {
      // Fallback: try to get all discussions
      this.fallbackToFirstDiscussion();
    }
  }

  /**
   * Fallback method: get all discussions and use the first one, or create a new one
   */
  private fallbackToFirstDiscussion() {
    this.connectionStatus = 'Loading discussions...';
    this.discussionService.getAllDiscussions().subscribe({
      next: (discussions) => {
        if (discussions.length > 0) {
          this.currentDiscussion = discussions[0];
          this.loadMessages();
          // Connect WebSocket after messages are loaded
          this.connectWebSocket();
        } else {
          // Create a new default discussion
          this.createDefaultDiscussion();
        }
        this.isLoading = false;
      },
      error: (error) => {
        this.connectionStatus = 'Error loading discussions';
        // Try to create a default discussion anyway
        this.createDefaultDiscussion();
        this.isLoading = false;
      }
    });
  }

  /**
   * Create a default discussion
   */
  private createDefaultDiscussion() {
    this.connectionStatus = 'Creating default discussion...';
    this.discussionService.createDiscussion('Global Discussion').subscribe({
      next: (discussion) => {
        this.currentDiscussion = discussion;
        this.loadMessages();
        // Connect WebSocket after messages are loaded
        // Note: isLoading will be set to false in loadMessages() after messages are loaded
        this.connectWebSocket();
      },
      error: (error) => {
        this.connectionStatus = 'Error creating discussion';
        this.isLoading = false; // Ensure loading is false on error
        alert('Error creating discussion: ' + (error.message || error));
      }
    });
  }

  /**
   * Load messages for the current discussion
   */
  private loadMessages() {
    if (!this.currentDiscussion?.id) {
      this.isLoading = false; // Ensure loading is false if no discussion ID
      return;
    }

    this.discussionService.getMessages(this.currentDiscussion.id).subscribe({
      next: (messages) => {
        // Convert dateTime strings to Date objects if needed
        messages.forEach(message => {
          if (message.dateTime && typeof message.dateTime === 'string') {
            message.dateTime = new Date(message.dateTime);
          }
        });
        
        // Sort messages by date (oldest first, newest at bottom)
        this.messages = messages.sort((a, b) => {
          const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
          const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
          return dateA - dateB; // Oldest first (ascending order)
        });
        
        // Load images for messages that have images
        this.loadMessageImages();
        
        this.scrollToBottom();
        // IMPORTANT: Set isLoading to false after messages are loaded
        this.isLoading = false;
      },
      error: (error) => {
        // Don't let errors break the component
        this.isLoading = false;
      }
    });
  }

  /**
   * Load image/video for a single message
   */
  private loadMessageImage(message: DiscussionMessage) {
    if (!this.currentDiscussion?.id) {
      return;
    }

    const discussionId = this.currentDiscussion.id;

    if (message.imageUrl) {
      const filename = message.imageUrl.split('/').pop() || '';
      if (!filename) return;
      
      const cacheKey = `${discussionId}/images/${filename}`;
      
      // Skip if already cached
      if (this.imageUrlCache.has(cacheKey)) {
        return;
      }

      // Load image with authentication
      this.discussionService.getFileUrl(discussionId, 'images', filename).subscribe({
        next: (blobUrl: string) => {
          this.imageUrlCache.set(cacheKey, blobUrl);
        },
        error: (error) => {
          console.error('Error loading image:', error);
        }
      });
    }
    
    if (message.videoUrl) {
      const filename = message.videoUrl.split('/').pop() || '';
      if (!filename) return;
      
      const cacheKey = `${discussionId}/videos/${filename}`;
      
      // Skip if already cached
      if (this.imageUrlCache.has(cacheKey)) {
        return;
      }

      // Load video with authentication
      this.discussionService.getFileUrl(discussionId, 'videos', filename).subscribe({
        next: (blobUrl: string) => {
          this.imageUrlCache.set(cacheKey, blobUrl);
        },
        error: (error) => {
          console.error('Error loading video:', error);
        }
      });
    }
  }

  /**
   * Load images for messages that have images
   */
  private loadMessageImages() {
    if (!this.currentDiscussion?.id) {
      return;
    }

    const discussionId = this.currentDiscussion.id;

    this.messages.forEach((message) => {
      if (message.imageUrl) {
        const filename = message.imageUrl.split('/').pop() || '';
        if (!filename) return;
        
        const cacheKey = `${discussionId}/images/${filename}`;
        
        // Skip if already cached
        if (this.imageUrlCache.has(cacheKey)) {
          return;
        }

        // Load image with authentication
        this.discussionService.getFileUrl(discussionId, 'images', filename).subscribe({
          next: (blobUrl: string) => {
            this.imageUrlCache.set(cacheKey, blobUrl);
            // Trigger change detection to update the view
            this.cdr.detectChanges();
          },
          error: (error) => {
            console.error('Error loading image:', error);
          }
        });
      }
      
      if (message.videoUrl) {
        const filename = message.videoUrl.split('/').pop() || '';
        if (!filename) return;
        
        const cacheKey = `${discussionId}/videos/${filename}`;
        
        // Skip if already cached
        if (this.imageUrlCache.has(cacheKey)) {
          return;
        }

        // Load video with authentication
        this.discussionService.getFileUrl(discussionId, 'videos', filename).subscribe({
          next: (blobUrl: string) => {
            this.imageUrlCache.set(cacheKey, blobUrl);
            // Trigger change detection to update the view
            this.cdr.detectChanges();
          },
          error: (error) => {
            console.error('Error loading video:', error);
          }
        });
      }
    });
  }

  /**
   * Connect to WebSocket for real-time updates
   */
  private connectWebSocket() {
    if (!this.currentDiscussion?.id) {
      return;
    }

    // Check if already connected - if so, set status immediately
    // Otherwise, show "Connecting" status
    if (this.discussionService.isConnected()) {
      // Already connected, set status immediately
      this.isConnecting = false;
      this.connectionStatus = 'Connected';
    } else {
      // Not connected yet, show connecting status
      this.isConnecting = true;
      this.connectionStatus = 'Connecting';
    }

    // Subscribe to real-time messages FIRST, before connecting
    this.messageSubscription = this.discussionService.getMessageObservable().subscribe({
      next: (data) => {
        // Handle status updates - they may not have discussionId, so check action first
        if (data.action === 'status') {
          // Status messages apply to current discussion if discussionId matches or is undefined
          if (data.discussionId && data.discussionId !== this.currentDiscussion?.id) {
            return;
          }
          
          this.connectionStatus = data.status;
          if (data.status === 'Connected') {
            this.isConnecting = false;
          } else if (data.status.includes('error') || data.status.includes('timeout') || data.status === 'Disconnected') {
            this.isConnecting = false;
          } else if (data.status === 'Connecting' || data.status.startsWith('Reconnecting')) {
            // If status is "Connecting" or "Reconnecting...", ensure isConnecting is true
            this.isConnecting = true;
          }
          return; // Status messages handled, don't process further
        }
        
        // Only process other messages for the current discussion
        if (data.discussionId !== this.currentDiscussion?.id) {
          return;
        }

        // Handle other message actions
        if (data.action === 'delete') {
          // Remove deleted message
          this.messages = this.messages.filter(msg => msg.id !== data.messageId);
        } else if (data.action === 'update' && data.message) {
          // Update existing message
          const updatedMessage = data.message as DiscussionMessage;
          const index = this.messages.findIndex(m => m.id === updatedMessage.id);
          if (index !== -1) {
            this.messages[index] = updatedMessage;
          }
        } else if (data.message) {
          // Add new message
          const message = data.message as DiscussionMessage;
          // Check if message already exists
          if (!this.messages.find(m => m.id === message.id)) {
            this.messages.push(message);
            // Keep messages sorted (oldest first, newest at bottom)
            this.messages.sort((a, b) => {
              const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
              const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
              return dateA - dateB; // Oldest first
            });
            // Load image/video for the new message if it has one
            this.loadMessageImage(message);
            this.scrollToBottom();
          }
        }
      },
      error: (error) => {
        this.isConnecting = false;
        this.connectionStatus = 'Connection error';
      }
    });

    // Connect to WebSocket AFTER subscribing to messages
    this.discussionService.connectWebSocket(this.currentDiscussion.id);

    // Timeout after 10 seconds if still connecting
    setTimeout(() => {
      if (this.isConnecting) {
        this.isConnecting = false;
        this.connectionStatus = 'Connection timeout - messages may not update in real-time';
      }
    }, 10000);
  }

  /**
   * Disconnect from WebSocket
   */
  private disconnectWebSocket() {
    if (this.currentDiscussion?.id) {
      this.discussionService.disconnectWebSocket();
    }
  }

  /**
   * Send a message
   */
  async Send() {
    if (!this.currentDiscussion?.id) {
      return;
    }

    const messageText = this.msgVal.trim();
    if (!messageText && !this.selectedImage && !this.selectedVideo) {
      return;
    }

    try {
      this.isLoading = true;
      
      // If editing a message, update it instead of creating a new one
      if (this.editingMessageId) {
        await new Promise<void>((resolve, reject) => {
          this.discussionService.updateMessage(
            this.currentDiscussion!.id!,
            this.editingMessageId!,
            messageText
          ).subscribe({
            next: (updatedMessage) => {
              // Update the message in the list
              const index = this.messages.findIndex(m => m.id === updatedMessage.id);
              if (index !== -1) {
                this.messages[index] = updatedMessage;
              }
              this.msgVal = '';
              this.editingMessageId = null;
              this.clearFileSelection();
              this.isLoading = false;
              resolve();
            },
            error: (error) => {
              alert('Error updating message: ' + (error.message || error));
              this.isLoading = false;
              reject(error);
            }
          });
        });
      } else {
        // Create new message
        // Compress image if needed before sending
        let imageToSend: File | undefined = undefined;
        if (this.selectedImage) {
          try {
            // Compress image to ~300KB if it's larger than that
            if (this.selectedImage.size > 300 * 1024) {
              imageToSend = await this.compressImageToTargetSize(this.selectedImage, 300 * 1024);
              console.log('Image compressed for discussion:', this.selectedImage.name, 
                'Original:', this.formatFileSize(this.selectedImage.size), 
                'Compressed:', this.formatFileSize(imageToSend.size));
            } else {
              imageToSend = this.selectedImage;
            }
          } catch (error) {
            console.error('Error compressing image:', error);
            // Use original image if compression fails
            imageToSend = this.selectedImage;
          }
        }

        await new Promise<void>((resolve, reject) => {
          this.discussionService.addMessage(
            this.currentDiscussion!.id!,
            messageText,
            imageToSend,
            this.selectedVideo || undefined
          ).subscribe({
            next: (message) => {
              // Convert dateTime string to Date object if needed
              if (message.dateTime && typeof message.dateTime === 'string') {
                message.dateTime = new Date(message.dateTime);
              }
              // Message will be added via WebSocket, but we can add it immediately for better UX
              if (!this.messages.find(m => m.id === message.id)) {
                this.messages.push(message);
                // Keep messages sorted (oldest first, newest at bottom)
                this.messages.sort((a, b) => {
                  const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
                  const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
                  return dateA - dateB; // Oldest first
                });
                this.scrollToBottom();
              }
              this.msgVal = '';
              this.clearFileSelection();
              this.isLoading = false;
              resolve();
            },
            error: (error) => {
              alert('Error sending message: ' + (error.message || error));
              this.isLoading = false;
              reject(error);
            }
          });
        });
      }
    } catch (error) {
      // Silent error handling
    }
  }

  /**
   * Edit a message
   */
  editMessage(message: DiscussionMessage) {
    if (!this.currentDiscussion?.id || !message.id) {
      return;
    }

    // Set the message to edit mode
    this.msgVal = message.message || '';
    this.editingMessageId = message.id;
    
    // Scroll to input box
    setTimeout(() => {
      if (this.messageInput) {
        this.messageInput.nativeElement.focus();
        this.messageInput.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }

  /**
   * Cancel editing a message
   */
  cancelEdit() {
    this.msgVal = '';
    this.editingMessageId = null;
    if (this.messageInput) {
      this.messageInput.nativeElement.focus();
    }
  }

  /**
   * Format message time to display date and time (dd mmm yyyy, HH:mm)
   */
  formatMessageTime(dateTime: Date | string | undefined): string {
    if (!dateTime) {
      return '';
    }
    
    const date = typeof dateTime === 'string' ? new Date(dateTime) : dateTime;
    if (isNaN(date.getTime())) {
      return '';
    }
    
    // Use the current language for formatting
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
      'in': 'hi-IN', // Hindi
      'el': 'el-GR', // Greek
      'he': 'he-IL'  // Hebrew
    };
    const locale = localeMap[currentLang] || 'fr-FR';
    
    // Format as dd mmm yyyy, HH:mm
    const options: Intl.DateTimeFormatOptions = {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false // Use 24-hour format
    };
    
    return date.toLocaleString(locale, options);
  }

  /**
   * Delete a message
   */
  async deleteMessage(message: DiscussionMessage) {
    if (!this.currentDiscussion?.id || !message.id) {
      return;
    }

    if (!confirm('Are you sure you want to delete this message?')) {
      return;
    }

    try {
      this.discussionService.deleteMessage(this.currentDiscussion.id, message.id).subscribe({
        next: () => {
          // Message will be removed via WebSocket
          this.messages = this.messages.filter(m => m.id !== message.id);
        },
        error: (error) => {
          alert('Error deleting message: ' + (error.message || error));
        }
      });
    } catch (error) {
      // Silent error handling
    }
  }

  /**
   * Trigger file input click
   */
  triggerFileInput() {
    if (this.fileInput && this.fileInput.nativeElement) {
      this.fileInput.nativeElement.click();
    }
  }

  /**
   * Handle file selection
   */
  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      const fileType = file.type;

      if (fileType.startsWith('image/')) {
        this.selectedImage = file;
        this.selectedVideo = null;
        this.videoPreview = null;
        this.createImagePreview(file);
      } else if (fileType.startsWith('video/')) {
        this.selectedVideo = file;
        this.selectedImage = null;
        this.imagePreview = null;
        this.createVideoPreview(file);
      } else {
        alert('Please select an image or video file');
        this.clearFileSelection();
      }
    }
  }

  /**
   * Create image preview
   */
  private createImagePreview(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      this.imagePreview = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  /**
   * Create video preview
   */
  private createVideoPreview(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      this.videoPreview = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  /**
   * Clear file selection
   */
  clearFileSelection() {
    this.selectedImage = null;
    this.selectedVideo = null;
    this.imagePreview = null;
    this.videoPreview = null;
    if (this.fileInput) {
      this.fileInput.nativeElement.value = '';
    }
  }

  /**
   * Get file URL for display (returns blob URL with authentication)
   */
  getFileUrl(message: DiscussionMessage, isImage: boolean): string {
    if (!this.currentDiscussion?.id) {
      return '';
    }

    let cacheKey = '';
    let filename = '';

    if (isImage && message.imageUrl) {
      // Extract filename from URL
      filename = message.imageUrl.split('/').pop() || '';
      if (!filename) return '';
      cacheKey = `${this.currentDiscussion.id}/images/${filename}`;
    } else if (!isImage && message.videoUrl) {
      // Extract filename from URL
      filename = message.videoUrl.split('/').pop() || '';
      if (!filename) return '';
      cacheKey = `${this.currentDiscussion.id}/videos/${filename}`;
    } else {
      return '';
    }

    // Check cache first
    if (this.imageUrlCache.has(cacheKey)) {
      return this.imageUrlCache.get(cacheKey)!;
    }

    // If not in cache, trigger loading (will be cached when ready)
    // This will be called again when the cache is updated
    const subfolder = isImage ? 'images' : 'videos';
    this.discussionService.getFileUrl(this.currentDiscussion.id, subfolder, filename).subscribe({
      next: (blobUrl: string) => {
        this.imageUrlCache.set(cacheKey, blobUrl);
        // Trigger change detection to update the view
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading file:', error);
      }
    });

    return '';
  }

  /**
   * Check if file URL is available in cache
   */
  hasFileUrl(message: DiscussionMessage, isImage: boolean): boolean {
    if (!this.currentDiscussion?.id) {
      return false;
    }

    let cacheKey = '';
    let filename = '';

    if (isImage && message.imageUrl) {
      filename = message.imageUrl.split('/').pop() || '';
      if (!filename) return false;
      cacheKey = `${this.currentDiscussion.id}/images/${filename}`;
    } else if (!isImage && message.videoUrl) {
      filename = message.videoUrl.split('/').pop() || '';
      if (!filename) return false;
      cacheKey = `${this.currentDiscussion.id}/videos/${filename}`;
    } else {
      return false;
    }

    return this.imageUrlCache.has(cacheKey);
  }

  /**
   * Scroll to bottom of messages
   */
  private scrollToBottom() {
    if (!this.messagesList || !this.messagesList.nativeElement) {
      return;
    }
    
    const element = this.messagesList.nativeElement;
    
    // Use requestAnimationFrame for smooth scrolling
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    
    // Also try after a short delay to catch any late DOM updates
    setTimeout(() => {
      if (this.messagesList && this.messagesList.nativeElement) {
        this.messagesList.nativeElement.scrollTop = this.messagesList.nativeElement.scrollHeight;
      }
    }, 100);
  }

  /**
   * Track by function for ngFor
   */
  public trackByMessageId(index: number, item: DiscussionMessage): string {
    return item.id || index.toString();
  }

  /**
   * Check if message is from current user
   */
  isOwnMessage(message: DiscussionMessage): boolean {
    return message.author?.userName === this.user.userName;
  }

  /**
   * Hide image on error
   */
  hideImageOnError(event: Event) {
    const target = event.target as HTMLImageElement;
    if (target) {
      target.style.display = 'none';
    }
  }

  /**
   * Hide video on error
   */
  hideVideoOnError(event: Event) {
    const target = event.target as HTMLVideoElement;
    if (target) {
      target.style.display = 'none';
    }
  }

  /**
   * Toggle emoji picker
   */
  toggleEmojiPicker() {
    this.showEmojiPicker = !this.showEmojiPicker;
  }

  /**
   * Insert emoji into message
   */
  insertEmoji(emoji: string) {
    if (this.msgVal === undefined || this.msgVal === null) {
      this.msgVal = '';
    }
    this.msgVal = (this.msgVal || '') + emoji;
    this.showEmojiPicker = false;
    // Trigger change detection
    setTimeout(() => {
      if (this.messageInput && this.messageInput.nativeElement) {
        this.messageInput.nativeElement.focus();
        // Set cursor at end
        const length = this.messageInput.nativeElement.value.length;
        this.messageInput.nativeElement.setSelectionRange(length, length);
      }
    }, 50);
  }

  /**
   * Common emojis to display
   */
  getCommonEmojis(): string[] {
    return [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
      '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
      '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩',
      '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣',
      '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
      '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗',
      '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯',
      '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐',
      '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈',
      '👋', '🤚', '🖐', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
      '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
      '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
      '🙏', '✍️', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃',
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️',
      '✝️', '☪️', '🕉', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐',
      '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐',
      '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳',
      '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️',
      '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️',
      '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️',
      '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❓', '❕',
      '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️',
      '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠',
      'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🈳', '🈂️', '🛂',
      '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '🚻', '🚮', '🎦', '📶',
      '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒',
      '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣',
      '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸', '⏯',
      '⏹', '⏺', '⏭', '⏮', '⏩', '⏪', '⏫', '⏬', '◀️', '🔼',
      '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️',
      '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃',
      '🎵', '🎶', '➕', '➖', '➗', '✖️', '💲', '💱', '™️', '©️',
      '®️', '〰️', '➰', '➿', '🔚', '🔙', '🔛', '🔜', '🔝', '✔️',
      '☑️', '🔘', '⚪', '⚫', '🔴', '🔵', '🟠', '🟡', '🟢', '🟣',
      '🟤', '⬛', '⬜', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫',
      '🔳', '🔲', '▪️', '▫️', '◾', '◽', '◼️', '◻️', '🟥', '🟧',
      '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜', '🔈', '🔇', '🔉',
      '🔊', '🔔', '🔕', '📣', '📢', '💬', '💭', '🗯', '♠️', '♣️',
      '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓', '🕔',
      '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛', '🕜', '🕝', '🕞',
      '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '🕧'
    ];
  }

  /**
   * Format file size for display
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Compress image to target size (in bytes)
   */
  private async compressImageToTargetSize(file: File, targetSizeBytes: number): Promise<File> {
    return new Promise((resolve, reject) => {
      // Check if file is JPEG (EXIF is mainly in JPEG files)
      const isJPEG = file.type === 'image/jpeg' || file.type === 'image/jpg' || 
                     file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
      
      // Extract EXIF data if JPEG
      let exifData: any = null;
      if (isJPEG) {
        const exifReader = new FileReader();
        exifReader.onload = (exifEvent: any) => {
          try {
            const exifString = exifEvent.target.result;
            exifData = piexif.load(exifString);
          } catch (exifError) {
            exifData = null;
          }
          this.performImageCompression(file, targetSizeBytes, exifData, resolve, reject);
        };
        exifReader.onerror = () => {
          this.performImageCompression(file, targetSizeBytes, null, resolve, reject);
        };
        exifReader.readAsBinaryString(file);
      } else {
        this.performImageCompression(file, targetSizeBytes, null, resolve, reject);
      }
    });
  }

  /**
   * Perform image compression
   */
  private performImageCompression(
    file: File, 
    targetSizeBytes: number, 
    exifData: any, 
    resolve: (file: File) => void, 
    reject: (error: Error) => void
  ): void {
    const reader = new FileReader();
    
    reader.onload = (e: any) => {
      const img = new Image();
      
      img.onload = () => {
        let quality = 0.9;
        let minQuality = 0.1;
        let maxQuality = 0.95;
        let attempts = 0;
        const maxAttempts = 10;
        const isJPEG = file.type === 'image/jpeg' || file.type === 'image/jpg' || 
                       file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
        
        const displayedW = img.width;
        const displayedH = img.height;
        
        const processBlobWithEXIF = (blob: Blob, q: number, callback: (finalBlob: Blob) => void): void => {
          if (isJPEG && exifData) {
            try {
              const blobReader = new FileReader();
              blobReader.onload = (blobEvent: any) => {
                try {
                  const binaryString = blobEvent.target.result;
                  const modifiedExifData = JSON.parse(JSON.stringify(exifData));
                  if (modifiedExifData['0th']) {
                    modifiedExifData['0th'][piexif.ImageIFD.Orientation] = 1;
                  }
                  const exifString = piexif.dump(modifiedExifData);
                  const newBinaryString = piexif.insert(exifString, binaryString);
                  const byteArray = new Uint8Array(newBinaryString.length);
                  for (let i = 0; i < newBinaryString.length; i++) {
                    byteArray[i] = newBinaryString.charCodeAt(i);
                  }
                  const finalBlob = new Blob([byteArray], { type: file.type });
                  callback(finalBlob);
                } catch (exifInsertError) {
                  callback(blob);
                }
              };
              blobReader.onerror = () => callback(blob);
              blobReader.readAsBinaryString(blob);
            } catch (exifError) {
              callback(blob);
            }
          } else {
            callback(blob);
          }
        };
        
        const tryCompress = (q: number): void => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          if (!ctx) {
            reject(new Error('Could not get canvas context'));
            return;
          }
          
          const sourceWidth = displayedW;
          const sourceHeight = displayedH;
          const maxDimension = 1920;
          
          let finalWidth = sourceWidth;
          let finalHeight = sourceHeight;
          if (sourceWidth > maxDimension || sourceHeight > maxDimension) {
            if (sourceWidth > sourceHeight) {
              finalHeight = (sourceHeight / sourceWidth) * maxDimension;
              finalWidth = maxDimension;
            } else {
              finalWidth = (sourceWidth / sourceHeight) * maxDimension;
              finalHeight = maxDimension;
            }
          }
          
          canvas.width = finalWidth;
          canvas.height = finalHeight;
          ctx.clearRect(0, 0, finalWidth, finalHeight);
          ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
          
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error('Failed to create blob'));
              return;
            }
            
            processBlobWithEXIF(blob, q, (finalBlob) => {
              attempts++;
              
              if (finalBlob.size <= targetSizeBytes * 1.1 || attempts >= maxAttempts) {
                const compressedFile = new File([finalBlob], file.name, {
                  type: file.type,
                  lastModified: Date.now()
                });
                resolve(compressedFile);
                return;
              }
              
              if (finalBlob.size > targetSizeBytes) {
                maxQuality = q;
                const newQuality = (q + minQuality) / 2;
                if (Math.abs(newQuality - q) < 0.01 || newQuality <= minQuality) {
                  const compressedFile = new File([finalBlob], file.name, {
                    type: file.type,
                    lastModified: Date.now()
                  });
                  resolve(compressedFile);
                  return;
                }
                tryCompress(newQuality);
              } else {
                minQuality = q;
                const newQuality = (q + maxQuality) / 2;
                if (Math.abs(newQuality - q) < 0.01 || newQuality >= maxQuality) {
                  const compressedFile = new File([finalBlob], file.name, {
                    type: file.type,
                    lastModified: Date.now()
                  });
                  resolve(compressedFile);
                  return;
                }
                tryCompress(newQuality);
              }
            });
          }, file.type, q);
        };
        
        tryCompress(quality);
      };
      
      img.onerror = () => {
        reject(new Error('Failed to load image'));
      };
      
      img.src = e.target.result as string;
    };
    
    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    
    reader.readAsDataURL(file);
  }
}

