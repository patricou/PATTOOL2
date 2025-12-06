// Discussion Component - Reusable component for discussions
import { Component, OnInit, OnDestroy, ViewChild, ElementRef, Input, OnChanges, SimpleChanges } from '@angular/core';
import { DiscussionService, Discussion, DiscussionMessage } from '../../services/discussion.service';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-discussion',
  templateUrl: './discussion.component.html',
  styleUrls: ['./discussion.component.css']
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

  @ViewChild('messagesList', { static: false }) messagesList!: ElementRef;
  @ViewChild('fileInput', { static: false }) fileInput!: ElementRef;
  @ViewChild('messageInput', { static: false }) messageInput!: ElementRef;

  private messageSubscription: Subscription | null = null;
  private discussionsSubscription: Subscription | null = null;

  constructor(
    private discussionService: DiscussionService,
    public _memberService: MembersService
  ) {}

  ngOnInit() {
    const logMsg = '[DiscussionComponent] ngOnInit - Component initializing';
    console.log(logMsg);
    this.persistLog(logMsg);
    
    try {
      this.user = this._memberService.getUser();
      const userMsg = `[DiscussionComponent] ngOnInit - User: ${this.user?.userName}`;
      console.log(userMsg);
      this.persistLog(userMsg);
      
      const idMsg = `[DiscussionComponent] ngOnInit - discussionId input: ${this.discussionId}`;
      console.log(idMsg);
      this.persistLog(idMsg);
      
      // Load discussion immediately - no delay needed
      const loadMsg = '[DiscussionComponent] ngOnInit - Starting loadDiscussion';
      console.log(loadMsg);
      this.persistLog(loadMsg);
      
      this.loadDiscussion();
    } catch (error) {
      const errorMsg = `[DiscussionComponent] ngOnInit - Error during initialization: ${error}`;
      console.error(errorMsg);
      this.persistLog(errorMsg, 'ERROR');
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
    console.group('📋 Discussion Component Logs');
    logs.forEach((log: any) => {
      const style = log.level === 'ERROR' ? 'color: red' : log.level === 'WARN' ? 'color: orange' : 'color: blue';
      console.log(`%c[${log.level}] ${log.timestamp}`, style, log.message);
    });
    console.groupEnd();
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
  }

  /**
   * Load discussion by ID or use default
   */
  private loadDiscussion() {
    const msg = '[DiscussionComponent] loadDiscussion - Called';
    console.log(msg);
    this.persistLog(msg);
    
    const idMsg = `[DiscussionComponent] loadDiscussion - discussionId: ${this.discussionId}`;
    console.log(idMsg);
    this.persistLog(idMsg);
    
    try {
      if (this.discussionId) {
        // Load specific discussion by ID
        const loadMsg = '[DiscussionComponent] loadDiscussion - Loading specific discussion by ID';
        console.log(loadMsg);
        this.persistLog(loadMsg);
        this.loadDiscussionById(this.discussionId);
      } else {
        // Load default discussion
        const defaultMsg = '[DiscussionComponent] loadDiscussion - Loading default discussion';
        console.log(defaultMsg);
        this.persistLog(defaultMsg);
        this.loadOrCreateDefaultDiscussion();
      }
    } catch (error) {
      const errorMsg = `[DiscussionComponent] loadDiscussion - Error in loadDiscussion: ${error}`;
      console.error(errorMsg);
      this.persistLog(errorMsg, 'ERROR');
      // Don't let errors break the component
      this.isLoading = false;
      this.connectionStatus = 'Error loading discussion';
    }
  }

  /**
   * Load a specific discussion by ID
   */
  private loadDiscussionById(id: string) {
    console.log('[DiscussionComponent] loadDiscussionById - Starting, ID:', id);
    this.isLoading = true;
    this.connectionStatus = 'Loading discussion...';
    
    this.discussionsSubscription = this.discussionService.getDiscussionById(id).subscribe({
      next: (discussion) => {
        console.log('[DiscussionComponent] loadDiscussionById - Received discussion:', discussion);
        if (discussion && discussion.id) {
          console.log('[DiscussionComponent] loadDiscussionById - Discussion loaded, ID:', discussion.id);
          this.currentDiscussion = discussion;
          this.loadMessages();
          console.log('[DiscussionComponent] loadDiscussionById - Calling connectWebSocket');
          this.connectWebSocket();
        } else {
          console.warn('[DiscussionComponent] loadDiscussionById - Discussion not found or invalid');
          this.connectionStatus = 'Discussion not found';
          this.isLoading = false;
        }
      },
      error: (error) => {
        console.error('[DiscussionComponent] loadDiscussionById - Error loading discussion:', error);
        this.connectionStatus = 'Error loading discussion';
        this.isLoading = false;
      }
    });
  }

  /**
   * Load or create the default discussion
   */
  private async loadOrCreateDefaultDiscussion() {
    console.log('[DiscussionComponent] loadOrCreateDefaultDiscussion - Starting');
    try {
      this.isLoading = true;
      this.connectionStatus = 'Loading Discussion Generale...';
      
      // Try to get the default discussion first
      console.log('[DiscussionComponent] loadOrCreateDefaultDiscussion - Calling getDefaultDiscussion()');
      this.discussionsSubscription = this.discussionService.getDefaultDiscussion().subscribe({
        next: (discussion: Discussion) => {
          const msg = `[DiscussionComponent] loadOrCreateDefaultDiscussion - Received discussion: ${JSON.stringify(discussion)}`;
          console.log(msg);
          this.persistLog(msg);
          
          if (discussion && discussion.id) {
            const loadedMsg = `[DiscussionComponent] loadOrCreateDefaultDiscussion - Discussion loaded, ID: ${discussion.id}`;
            console.log(loadedMsg);
            this.persistLog(loadedMsg);
            this.currentDiscussion = discussion;
            this.loadMessages();
            // Connect WebSocket immediately - no delay needed
            // Note: isLoading will be set to false in loadMessages() after messages are loaded
            const connectMsg = '[DiscussionComponent] loadOrCreateDefaultDiscussion - Calling connectWebSocket';
            console.log(connectMsg);
            this.persistLog(connectMsg);
            this.connectWebSocket();
          } else {
            const warnMsg = '[DiscussionComponent] loadOrCreateDefaultDiscussion - Discussion not found or invalid, falling back';
            console.warn(warnMsg);
            this.persistLog(warnMsg, 'WARN');
            // If default discussion not found, try to get all discussions as fallback
            this.fallbackToFirstDiscussion();
          }
          // Don't set isLoading = false here - let loadMessages() or fallbackToFirstDiscussion() handle it
        },
        error: (error: any) => {
          const errorMsg = `[DiscussionComponent] loadOrCreateDefaultDiscussion - Error loading default discussion: ${error?.status || 'unknown'} - ${error?.message || error}`;
          console.error(errorMsg);
          this.persistLog(errorMsg, 'ERROR');
          
          // If it's a 401, the interceptor will redirect to login, so don't try fallback
          if (error?.status === 401) {
            const authMsg = '[DiscussionComponent] loadOrCreateDefaultDiscussion - 401 Unauthorized - will be redirected to login';
            console.error(authMsg);
            this.persistLog(authMsg, 'ERROR');
            this.isLoading = false;
            return;
          }
          
          // Fallback: try to get all discussions (like the old code did)
          this.fallbackToFirstDiscussion();
        }
      });
    } catch (error) {
      console.error('[DiscussionComponent] loadOrCreateDefaultDiscussion - Exception caught:', error);
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
        console.error('Error loading discussions:', error);
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
        console.error('Error creating default discussion:', error);
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
        // Sort messages by date (oldest first, newest at bottom)
        this.messages = messages.sort((a, b) => {
          const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
          const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
          return dateA - dateB; // Oldest first (ascending order)
        });
        this.scrollToBottom();
        // IMPORTANT: Set isLoading to false after messages are loaded
        this.isLoading = false;
        console.log('[DiscussionComponent] loadMessages - Messages loaded, isLoading set to false');
      },
      error: (error) => {
        console.error('[DiscussionComponent] loadMessages - Error loading messages:', error);
        // Don't let errors break the component - just log them
        this.isLoading = false;
      }
    });
  }

  /**
   * Connect to WebSocket for real-time updates
   */
  private connectWebSocket() {
    console.log('[DiscussionComponent] connectWebSocket - Called');
    console.log('[DiscussionComponent] connectWebSocket - currentDiscussion:', this.currentDiscussion);
    console.log('[DiscussionComponent] connectWebSocket - currentDiscussion?.id:', this.currentDiscussion?.id);
    
    if (!this.currentDiscussion?.id) {
      console.warn('[DiscussionComponent] connectWebSocket - No discussion ID, aborting');
      return;
    }

    console.log('[DiscussionComponent] connectWebSocket - Discussion ID found:', this.currentDiscussion.id);
    this.isConnecting = true;
    this.connectionStatus = 'Connecting';

    // Subscribe to real-time messages FIRST, before connecting
    console.log('[DiscussionComponent] connectWebSocket - Subscribing to message observable');
    this.messageSubscription = this.discussionService.getMessageObservable().subscribe({
      next: (data) => {
        console.log('[DiscussionComponent] connectWebSocket - Message received:', data);
        
        // Handle status updates - they may not have discussionId, so check action first
        if (data.action === 'status') {
          // Status messages apply to current discussion if discussionId matches or is undefined
          if (data.discussionId && data.discussionId !== this.currentDiscussion?.id) {
            console.log('[DiscussionComponent] connectWebSocket - Status for different discussion, ignoring. Expected:', this.currentDiscussion?.id, 'Got:', data.discussionId);
            return;
          }
          
          console.log('[DiscussionComponent] connectWebSocket - Status update:', data.status);
          this.connectionStatus = data.status;
          if (data.status === 'Connected') {
            console.log('[DiscussionComponent] connectWebSocket - Connected successfully!');
            this.isConnecting = false;
          } else if (data.status.includes('error') || data.status.includes('timeout') || data.status === 'Disconnected') {
            console.warn('[DiscussionComponent] connectWebSocket - Connection error/timeout:', data.status);
            this.isConnecting = false;
          }
          return; // Status messages handled, don't process further
        }
        
        // Only process other messages for the current discussion
        if (data.discussionId !== this.currentDiscussion?.id) {
          console.log('[DiscussionComponent] connectWebSocket - Message for different discussion, ignoring. Expected:', this.currentDiscussion?.id, 'Got:', data.discussionId);
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
            this.scrollToBottom();
          }
        }
      },
      error: (error) => {
        console.error('[DiscussionComponent] connectWebSocket - Observable error:', error);
        this.isConnecting = false;
        this.connectionStatus = 'Connection error';
      }
    });

    // Connect to WebSocket AFTER subscribing to messages
    console.log('[DiscussionComponent] connectWebSocket - Calling discussionService.connectWebSocket with ID:', this.currentDiscussion.id);
    this.discussionService.connectWebSocket(this.currentDiscussion.id);
    console.log('[DiscussionComponent] connectWebSocket - connectWebSocket call completed');

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
              console.error('Error updating message:', error);
              alert('Error updating message: ' + (error.message || error));
              this.isLoading = false;
              reject(error);
            }
          });
        });
      } else {
        // Create new message
        await new Promise<void>((resolve, reject) => {
          this.discussionService.addMessage(
            this.currentDiscussion!.id!,
            messageText,
            this.selectedImage || undefined,
            this.selectedVideo || undefined
          ).subscribe({
            next: (message) => {
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
              console.error('Error sending message:', error);
              alert('Error sending message: ' + (error.message || error));
              this.isLoading = false;
              reject(error);
            }
          });
        });
      }
    } catch (error) {
      console.error('Error in Send:', error);
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
          console.error('Error deleting message:', error);
          alert('Error deleting message: ' + (error.message || error));
        }
      });
    } catch (error) {
      console.error('Error in deleteMessage:', error);
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
   * Get file URL for display
   */
  getFileUrl(message: DiscussionMessage, isImage: boolean): string {
    if (!this.currentDiscussion?.id) {
      return '';
    }

    if (isImage && message.imageUrl) {
      // Extract filename from URL
      const filename = message.imageUrl.split('/').pop() || '';
      return this.discussionService.getFileUrl(this.currentDiscussion.id, 'images', filename);
    } else if (!isImage && message.videoUrl) {
      // Extract filename from URL
      const filename = message.videoUrl.split('/').pop() || '';
      return this.discussionService.getFileUrl(this.currentDiscussion.id, 'videos', filename);
    }
    return '';
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
    console.log('Inserting emoji:', emoji);
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
}

