// Discussion Component - Reusable component for discussions
import { Component, OnInit, OnDestroy, ViewChild, ElementRef, Input, OnChanges, SimpleChanges, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DiscussionService, Discussion, DiscussionMessage } from '../../services/discussion.service';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';
import { Subscription, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
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
  public isImageProcessing: boolean = false; // Indique si une image est en cours de traitement (lecture/compression)
  private shouldScrollToBottom: boolean = true;
  public editingMessageId: string | null = null;
  private imageUrlCache: Map<string, string> = new Map(); // Cache for blob URLs
  public cacheUpdateCounter: number = 0; // Counter to trigger change detection when cache updates (public for template)

  @ViewChild('messagesList', { static: false }) messagesList!: ElementRef;
  @ViewChild('fileInput', { static: false }) fileInput!: ElementRef;
  @ViewChild('messageInput', { static: false }) messageInput!: ElementRef;

  private messageSubscription: Subscription | null = null;
  private discussionsSubscription: Subscription | null = null;
  private resizeObserver: ResizeObserver | null = null;
  
  // Memory leak prevention: track all subscriptions and resources
  private destroy$ = new Subject<void>();
  private allSubscriptions: Subscription[] = [];
  private activeTimeouts: ReturnType<typeof setTimeout>[] = [];
  private imageLoadListeners: Array<{element: HTMLImageElement, loadHandler: () => void, errorHandler: () => void}> = [];
  private activeFileReaders: FileReader[] = [];

  constructor(
    private discussionService: DiscussionService,
    public _memberService: MembersService,
    private cdr: ChangeDetectorRef,
    private translateService: TranslateService,
    private ngZone: NgZone
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
    // Complete destroy subject to unsubscribe from all takeUntil subscriptions
    this.destroy$.next();
    this.destroy$.complete();
    
    this.disconnectWebSocket();
    
    // Unsubscribe from all tracked subscriptions
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
    }
    if (this.discussionsSubscription) {
      this.discussionsSubscription.unsubscribe();
    }
    this.allSubscriptions.forEach(sub => {
      if (!sub.closed) {
        sub.unsubscribe();
      }
    });
    this.allSubscriptions = [];
    
    // Clean up ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // Clean up image event listeners
    this.imageLoadListeners.forEach(({ element, loadHandler, errorHandler }) => {
      try {
        element.removeEventListener('load', loadHandler);
        element.removeEventListener('error', errorHandler);
      } catch (e) {
        // Ignore errors if element is already removed
      }
    });
    this.imageLoadListeners = [];
    
    // Clean up FileReader instances
    this.activeFileReaders.forEach(reader => {
      try {
        reader.abort();
      } catch (e) {
        // Ignore errors
      }
    });
    this.activeFileReaders = [];
    
    // Clean up all timeouts
    this.activeTimeouts.forEach(timeoutId => {
      clearTimeout(timeoutId);
    });
    this.activeTimeouts = [];
    
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
    const sub = this.discussionService.getAllDiscussions()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
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
    this.allSubscriptions.push(sub);
  }

  /**
   * Create a default discussion
   */
  private createDefaultDiscussion() {
    this.connectionStatus = 'Creating default discussion...';
    const sub = this.discussionService.createDiscussion('Global Discussion')
      .pipe(takeUntil(this.destroy$))
      .subscribe({
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
    this.allSubscriptions.push(sub);
  }

  /**
   * Load messages for the current discussion
   */
  private loadMessages() {
    if (!this.currentDiscussion?.id) {
      this.isLoading = false; // Ensure loading is false if no discussion ID
      return;
    }

    const sub = this.discussionService.getMessages(this.currentDiscussion.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (messages) => {
          // Convert dateTime strings to Date objects if needed
          messages.forEach(message => {
            if (message.dateTime && typeof message.dateTime === 'string') {
              message.dateTime = new Date(message.dateTime);
            }
          });
          
          // Sort messages by date (oldest first, newest at bottom)
          const sortedMessages = messages.sort((a, b) => {
            const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
            const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
            return dateA - dateB; // Oldest first (ascending order)
          });
          
          // Use setTimeout to defer the assignment to avoid ExpressionChangedAfterItHasBeenCheckedError
          const timeoutId = setTimeout(() => {
            if (this.messagesList?.nativeElement) { // Check component still exists
              this.messages = sortedMessages;
              
              // Load images for messages that have images
              this.loadMessageImages();
              
              this.scrollToBottom();
              // IMPORTANT: Set isLoading to false after messages are loaded
              this.isLoading = false;
              
              // Trigger change detection
              this.cdr.detectChanges();
            }
            // Remove from active timeouts
            const index = this.activeTimeouts.indexOf(timeoutId);
            if (index > -1) {
              this.activeTimeouts.splice(index, 1);
            }
          }, 0);
          this.activeTimeouts.push(timeoutId);
        },
        error: (error) => {
          // Don't let errors break the component
          this.isLoading = false;
        }
      });
    this.allSubscriptions.push(sub);
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
      // Extract filename from URL - handle both relative and absolute URLs
      let filename = message.imageUrl.split('/').pop() || '';
      // Remove query parameters if any
      if (filename.includes('?')) {
        filename = filename.split('?')[0];
      }
      if (!filename) {
        console.warn('Could not extract filename from imageUrl:', message.imageUrl);
        return;
      }
      
      const cacheKey = `${discussionId}/images/${filename}`;
      
      // Skip if already cached
      if (this.imageUrlCache.has(cacheKey)) {
        console.log('Image already cached:', cacheKey);
        return;
      }

      // Load image with authentication
      const sub = this.discussionService.getFileUrl(discussionId, 'images', filename)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (blobUrl: string) => {
            if (this.messagesList?.nativeElement) { // Check component still exists
              this.imageUrlCache.set(cacheKey, blobUrl);
              // Increment counter to trigger change detection - do this BEFORE setTimeout
              this.cacheUpdateCounter++;
              // Use setTimeout to ensure change detection runs after cache update
              const timeoutId1 = setTimeout(() => {
                if (this.messagesList?.nativeElement) {
                  this.ngZone.run(() => {
                    // Force change detection and mark for check
                    this.cdr.markForCheck();
                    this.cdr.detectChanges();
                    // Force another change detection cycle to ensure template re-evaluates
                    const timeoutId2 = setTimeout(() => {
                      if (this.messagesList?.nativeElement) {
                        this.ngZone.run(() => {
                          // Increment counter again to force another change detection cycle
                          this.cacheUpdateCounter++;
                          this.cdr.detectChanges();
                          // Scroll to bottom after image is loaded and rendered
                          this.scrollToBottom();
                        });
                      }
                      const index = this.activeTimeouts.indexOf(timeoutId2);
                      if (index > -1) {
                        this.activeTimeouts.splice(index, 1);
                      }
                    }, 100);
                    this.activeTimeouts.push(timeoutId2);
                  });
                }
                const index = this.activeTimeouts.indexOf(timeoutId1);
                if (index > -1) {
                  this.activeTimeouts.splice(index, 1);
                }
              }, 0);
              this.activeTimeouts.push(timeoutId1);
            }
          },
          error: (error) => {
            console.error('Error loading image:', filename, error);
            // Still trigger change detection to show error state
            const timeoutId = setTimeout(() => {
              if (this.messagesList?.nativeElement) {
                this.ngZone.run(() => {
                  this.cdr.detectChanges();
                });
              }
              const index = this.activeTimeouts.indexOf(timeoutId);
              if (index > -1) {
                this.activeTimeouts.splice(index, 1);
              }
            }, 0);
            this.activeTimeouts.push(timeoutId);
          }
        });
      this.allSubscriptions.push(sub);
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
      const sub = this.discussionService.getFileUrl(discussionId, 'videos', filename)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (blobUrl: string) => {
            if (this.messagesList?.nativeElement) { // Check component still exists
              this.imageUrlCache.set(cacheKey, blobUrl);
              // Trigger change detection to update the view (so hasFileUrl() returns true)
              this.ngZone.run(() => {
                this.cdr.detectChanges();
              });
            }
          },
          error: (error) => {
            console.error('Error loading video:', error);
            // Still trigger change detection to show error state
            if (this.messagesList?.nativeElement) {
              this.ngZone.run(() => {
                this.cdr.detectChanges();
              });
            }
          }
        });
      this.allSubscriptions.push(sub);
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
        const sub = this.discussionService.getFileUrl(discussionId, 'images', filename)
          .pipe(takeUntil(this.destroy$))
          .subscribe({
            next: (blobUrl: string) => {
              if (this.messagesList?.nativeElement) { // Check component still exists
                this.imageUrlCache.set(cacheKey, blobUrl);
                // Trigger change detection to update the view
                this.cdr.detectChanges();
              }
            },
            error: (error) => {
              console.error('Error loading image:', error);
            }
          });
        this.allSubscriptions.push(sub);
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
        const sub = this.discussionService.getFileUrl(discussionId, 'videos', filename)
          .pipe(takeUntil(this.destroy$))
          .subscribe({
            next: (blobUrl: string) => {
              if (this.messagesList?.nativeElement) { // Check component still exists
                this.imageUrlCache.set(cacheKey, blobUrl);
                // Trigger change detection to update the view
                this.cdr.detectChanges();
              }
            },
            error: (error) => {
              console.error('Error loading video:', error);
            }
          });
        this.allSubscriptions.push(sub);
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
          this.cdr.detectChanges();
        } else if (data.action === 'update' && data.message) {
          // Update existing message
          const updatedMessage = data.message as DiscussionMessage;
          // Convert dateTime string to Date object if needed
          if (updatedMessage.dateTime && typeof updatedMessage.dateTime === 'string') {
            updatedMessage.dateTime = new Date(updatedMessage.dateTime);
          }
          const index = this.messages.findIndex(m => m.id === updatedMessage.id);
          if (index !== -1) {
            this.messages[index] = updatedMessage;
            // Create new array reference to trigger change detection
            this.messages = [...this.messages];
            this.cdr.detectChanges();
          }
        } else if (data.message) {
          // Add new message - run in Angular zone to ensure change detection
          this.ngZone.run(() => {
            const message = data.message as DiscussionMessage;
            // Convert dateTime string to Date object if needed
            if (message.dateTime && typeof message.dateTime === 'string') {
              message.dateTime = new Date(message.dateTime);
            }
            // Check if message already exists
            const existingMessage = this.messages.find(m => m.id === message.id);
            if (!existingMessage) {
              this.messages.push(message);
              // Keep messages sorted (oldest first, newest at bottom)
              this.messages.sort((a, b) => {
                const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
                const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
                return dateA - dateB; // Oldest first
              });
              // Create new array reference to trigger change detection
              this.messages = [...this.messages];
              // Load image/video for the new message if it has one
              this.loadMessageImage(message);
              // Trigger change detection
              this.cdr.detectChanges();
              // Scroll to bottom after a brief delay to ensure DOM is updated
              const timeoutId = setTimeout(() => {
                if (this.messagesList?.nativeElement) {
                  this.scrollToBottom();
                }
                const index = this.activeTimeouts.indexOf(timeoutId);
                if (index > -1) {
                  this.activeTimeouts.splice(index, 1);
                }
              }, 10);
              this.activeTimeouts.push(timeoutId);
            }
          });
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
    const timeoutId = setTimeout(() => {
      if (this.messagesList?.nativeElement && this.isConnecting) { // Check component still exists
        this.isConnecting = false;
        this.connectionStatus = 'Connection timeout - messages may not update in real-time';
      }
      const index = this.activeTimeouts.indexOf(timeoutId);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 10000);
    this.activeTimeouts.push(timeoutId);
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
          const sub = this.discussionService.updateMessage(
            this.currentDiscussion!.id!,
            this.editingMessageId!,
            messageText
          )
            .pipe(takeUntil(this.destroy$))
            .subscribe({
            next: (updatedMessage) => {
              // Convert dateTime string to Date object if needed
              if (updatedMessage.dateTime && typeof updatedMessage.dateTime === 'string') {
                updatedMessage.dateTime = new Date(updatedMessage.dateTime);
              }
              // Update the message in the list
              const index = this.messages.findIndex(m => m.id === updatedMessage.id);
              if (index !== -1) {
                this.messages[index] = updatedMessage;
              }
              this.msgVal = '';
              this.editingMessageId = null;
              this.clearFileSelection();
              this.isLoading = false;
              this.cdr.detectChanges();
              resolve();
            },
            error: (error) => {
              alert('Error updating message: ' + (error.message || error));
              this.isLoading = false;
              this.cdr.detectChanges();
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
              this.isImageProcessing = true;
              this.cdr.detectChanges();
              imageToSend = await this.compressImageToTargetSize(this.selectedImage, 300 * 1024);
              this.isImageProcessing = false;
              this.cdr.detectChanges();
            } else {
              imageToSend = this.selectedImage;
            }
          } catch (error) {
            console.error('Error compressing image:', error);
            this.isImageProcessing = false;
            this.cdr.detectChanges();
            // Use original image if compression fails
            imageToSend = this.selectedImage;
          }
        }

        await new Promise<void>((resolve, reject) => {
          const sub = this.discussionService.addMessage(
            this.currentDiscussion!.id!,
            messageText,
            imageToSend,
            this.selectedVideo || undefined
          )
            .pipe(takeUntil(this.destroy$))
            .subscribe({
            next: (message) => {
              // Convert dateTime string to Date object if needed
              if (message.dateTime && typeof message.dateTime === 'string') {
                message.dateTime = new Date(message.dateTime);
              }
              // Message will be added via WebSocket, but we can add it immediately for better UX
              const existingMessage = this.messages.find(m => m.id === message.id);
              if (!existingMessage) {
                this.messages.push(message);
                // Keep messages sorted (oldest first, newest at bottom)
                this.messages.sort((a, b) => {
                  const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
                  const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
                  return dateA - dateB; // Oldest first
                });
                // Create new array reference to trigger change detection
                this.messages = [...this.messages];
                this.cdr.detectChanges();
                // Use requestAnimationFrame for smooth scrolling
                requestAnimationFrame(() => {
                  this.scrollToBottom();
                });
              }
              this.msgVal = '';
              this.clearFileSelection();
              this.isLoading = false;
              this.cdr.detectChanges();
              resolve();
            },
            error: (error) => {
              alert('Error sending message: ' + (error.message || error));
              this.isLoading = false;
              this.cdr.detectChanges();
              reject(error);
            }
          });
          this.allSubscriptions.push(sub);
        });
      }
    } catch (error) {
      // Silent error handling
      this.isLoading = false;
      this.cdr.detectChanges();
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
    const timeoutId = setTimeout(() => {
      if (this.messageInput?.nativeElement) {
        this.messageInput.nativeElement.focus();
        this.messageInput.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      const index = this.activeTimeouts.indexOf(timeoutId);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 100);
    this.activeTimeouts.push(timeoutId);
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
      const sub = this.discussionService.deleteMessage(this.currentDiscussion.id, message.id)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: () => {
            // Message will be removed via WebSocket
            if (this.messagesList?.nativeElement) { // Check component still exists
              this.messages = this.messages.filter(m => m.id !== message.id);
            }
          },
          error: (error) => {
            alert('Error deleting message: ' + (error.message || error));
          }
        });
      this.allSubscriptions.push(sub);
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
    this.isImageProcessing = true;
    this.cdr.detectChanges();
    
    const reader = new FileReader();
    this.activeFileReaders.push(reader);
    
    reader.onload = (e) => {
      // Use setTimeout to defer the update to avoid ExpressionChangedAfterItHasBeenCheckedError
      const timeoutId = setTimeout(() => {
        if (this.fileInput?.nativeElement) { // Check component still exists
          this.ngZone.run(() => {
            this.imagePreview = e.target?.result as string;
            this.isImageProcessing = false;
            this.cdr.detectChanges();
          });
        }
        // Remove from active timeouts
        const index = this.activeTimeouts.indexOf(timeoutId);
        if (index > -1) {
          this.activeTimeouts.splice(index, 1);
        }
        // Remove from active file readers
        const readerIndex = this.activeFileReaders.indexOf(reader);
        if (readerIndex > -1) {
          this.activeFileReaders.splice(readerIndex, 1);
        }
      }, 0);
      this.activeTimeouts.push(timeoutId);
    };
    
    reader.onerror = () => {
      this.isImageProcessing = false;
      this.cdr.detectChanges();
      // Remove from active file readers on error
      const readerIndex = this.activeFileReaders.indexOf(reader);
      if (readerIndex > -1) {
        this.activeFileReaders.splice(readerIndex, 1);
      }
    };
    
    reader.readAsDataURL(file);
  }

  /**
   * Create video preview
   */
  private createVideoPreview(file: File) {
    const reader = new FileReader();
    this.activeFileReaders.push(reader);
    
    reader.onload = (e) => {
      // Use setTimeout to defer the update to avoid ExpressionChangedAfterItHasBeenCheckedError
      const timeoutId = setTimeout(() => {
        if (this.fileInput?.nativeElement) { // Check component still exists
          this.ngZone.run(() => {
            this.videoPreview = e.target?.result as string;
            this.cdr.detectChanges();
          });
        }
        // Remove from active timeouts
        const index = this.activeTimeouts.indexOf(timeoutId);
        if (index > -1) {
          this.activeTimeouts.splice(index, 1);
        }
        // Remove from active file readers
        const readerIndex = this.activeFileReaders.indexOf(reader);
        if (readerIndex > -1) {
          this.activeFileReaders.splice(readerIndex, 1);
        }
      }, 0);
      this.activeTimeouts.push(timeoutId);
    };
    
    reader.onerror = () => {
      // Remove from active file readers on error
      const readerIndex = this.activeFileReaders.indexOf(reader);
      if (readerIndex > -1) {
        this.activeFileReaders.splice(readerIndex, 1);
      }
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
    this.isImageProcessing = false;
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
    const sub = this.discussionService.getFileUrl(this.currentDiscussion.id, subfolder, filename)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (blobUrl: string) => {
          if (this.messagesList?.nativeElement) { // Check component still exists
            this.imageUrlCache.set(cacheKey, blobUrl);
            // Increment counter to trigger change detection
            this.cacheUpdateCounter++;
            // Trigger change detection to update the view
            this.cdr.detectChanges();
          }
        },
        error: (error) => {
          console.error('Error loading file:', error);
        }
      });
    this.allSubscriptions.push(sub);

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
      // Remove query parameters if any
      if (filename.includes('?')) {
        filename = filename.split('?')[0];
      }
      if (!filename) return false;
      cacheKey = `${this.currentDiscussion.id}/images/${filename}`;
    } else if (!isImage && message.videoUrl) {
      filename = message.videoUrl.split('/').pop() || '';
      // Remove query parameters if any
      if (filename.includes('?')) {
        filename = filename.split('?')[0];
      }
      if (!filename) return false;
      cacheKey = `${this.currentDiscussion.id}/videos/${filename}`;
    } else {
      return false;
    }

    // Access cacheUpdateCounter FIRST to ensure change detection tracks this method
    // This ensures Angular knows to re-evaluate when cacheUpdateCounter changes
    const counter = this.cacheUpdateCounter;
    const hasUrl = this.imageUrlCache.has(cacheKey);
    
    // Return the result (counter is accessed to trigger change detection)
    return hasUrl;
  }

  /**
   * Scroll to bottom of messages
   */
  private scrollToBottom() {
    if (!this.messagesList || !this.messagesList.nativeElement) {
      return;
    }
    
    const element = this.messagesList.nativeElement;
    
    // Function to perform the scroll
    const doScroll = () => {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    };
    
    // Use requestAnimationFrame for smooth scrolling
    requestAnimationFrame(() => {
      doScroll();
    });
    
    // Also try after short delays to catch any late DOM updates (especially when images load)
    const timeoutId1 = setTimeout(() => {
      if (this.messagesList?.nativeElement) {
        doScroll();
      }
      const index = this.activeTimeouts.indexOf(timeoutId1);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 100);
    this.activeTimeouts.push(timeoutId1);
    
    const timeoutId2 = setTimeout(() => {
      if (this.messagesList?.nativeElement) {
        doScroll();
      }
      const index = this.activeTimeouts.indexOf(timeoutId2);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 300);
    this.activeTimeouts.push(timeoutId2);
    
    const timeoutId3 = setTimeout(() => {
      if (this.messagesList?.nativeElement) {
        doScroll();
      }
      const index = this.activeTimeouts.indexOf(timeoutId3);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 500);
    this.activeTimeouts.push(timeoutId3);
    
    // Setup ResizeObserver to scroll when content height changes (e.g., when images load)
    // Disconnect existing observer before creating a new one
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        // Only scroll if user is near the bottom (within 100px)
        const element = this.messagesList?.nativeElement;
        if (element && this.messagesList?.nativeElement) { // Check component still exists
          const isNearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
          if (isNearBottom) {
            doScroll();
          }
        }
      });
      this.resizeObserver.observe(element);
    }
    
    // Also scroll when images finish loading
    // Wait for all images in the messages list to load
    const timeoutId4 = setTimeout(() => {
      if (!this.messagesList?.nativeElement) {
        return; // Component destroyed
      }
      
      const images = element.querySelectorAll('img');
      let loadedCount = 0;
      const totalImages = images.length;
      
      if (totalImages === 0) {
        // No images, scroll immediately
        doScroll();
        const index = this.activeTimeouts.indexOf(timeoutId4);
        if (index > -1) {
          this.activeTimeouts.splice(index, 1);
        }
        return;
      }
      
      images.forEach((img: HTMLImageElement) => {
        if (img.complete) {
          loadedCount++;
          if (loadedCount === totalImages) {
            doScroll();
          }
        } else {
          const loadHandler = () => {
            if (this.messagesList?.nativeElement) { // Check component still exists
              loadedCount++;
              doScroll(); // Scroll after each image loads
              if (loadedCount === totalImages) {
                doScroll(); // Final scroll when all images are loaded
              }
            }
          };
          
          const errorHandler = () => {
            if (this.messagesList?.nativeElement) { // Check component still exists
              loadedCount++;
              doScroll(); // Scroll even if image fails to load
              if (loadedCount === totalImages) {
                doScroll();
              }
            }
          };
          
          img.addEventListener('load', loadHandler, { once: true });
          img.addEventListener('error', errorHandler, { once: true });
          
          // Track listeners for cleanup
          this.imageLoadListeners.push({ element: img, loadHandler, errorHandler });
        }
      });
      
      // Fallback: scroll after 2 seconds even if images haven't loaded
      const timeoutId5 = setTimeout(() => {
        if (this.messagesList?.nativeElement) {
          doScroll();
        }
        const index = this.activeTimeouts.indexOf(timeoutId5);
        if (index > -1) {
          this.activeTimeouts.splice(index, 1);
        }
      }, 2000);
      this.activeTimeouts.push(timeoutId5);
      
      const index = this.activeTimeouts.indexOf(timeoutId4);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 50);
    this.activeTimeouts.push(timeoutId4);
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
    const timeoutId = setTimeout(() => {
      if (this.messageInput?.nativeElement) {
        this.messageInput.nativeElement.focus();
        // Set cursor at end
        const length = this.messageInput.nativeElement.value.length;
        this.messageInput.nativeElement.setSelectionRange(length, length);
      }
      const index = this.activeTimeouts.indexOf(timeoutId);
      if (index > -1) {
        this.activeTimeouts.splice(index, 1);
      }
    }, 50);
    this.activeTimeouts.push(timeoutId);
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

