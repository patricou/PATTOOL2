// Discussion Component - Replaced Firebase with MongoDB backend
import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModule, NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { Subscription, forkJoin, of, Observable, Subject } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { DiscussionService, Discussion, DiscussionMessage, StreamedDiscussion, DiscussionItem as StreamDiscussionItem } from '../../services/discussion.service';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';
import { EvenementsService } from '../../services/evenements.service';
import { FriendsService } from '../../services/friends.service';
import { Evenement } from '../../model/evenement';
import { FriendGroup } from '../../model/friend';
import { DiscussionModalComponent } from '../discussion-modal/discussion-modal.component';
import { DiscussionStatisticsModalComponent } from '../discussion-statistics-modal/discussion-statistics-modal.component';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { Router } from '@angular/router';

export interface DiscussionItem {
  id: string;
  title: string;
  type: 'general' | 'event' | 'friendGroup';
  event?: Evenement;
  friendGroup?: FriendGroup;
  discussion?: Discussion;
  lastMessageDate?: Date;
  messageCount?: number;
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NgbModule,
    NavigationButtonsModule,
    DiscussionModalComponent,
    DiscussionStatisticsModalComponent
  ]
})
export class ChatComponent implements OnInit, OnDestroy {

  public messages: DiscussionMessage[] = [];
  public msgVal: string = '';
  public user: Member = new Member("", "", "", "", "", [], "");
  public currentDiscussion: Discussion | null = null;
  public discussions: Discussion[] = [];
  public availableDiscussions: DiscussionItem[] = [];
  public selectedImage: File | null = null;
  public selectedVideo: File | null = null;
  public imagePreview: string | null = null;
  public videoPreview: string | null = null;
  public isLoading: boolean = false;
  public isConnecting: boolean = false;
  public connectionStatus: string = '';
  public showEmojiPicker: boolean = false;
  private shouldScrollToBottom: boolean = true;
  private imageUrlCache: Map<string, string> = new Map(); // Cache for blob URLs
  public editingMessageId: string | null = null;
  public allFriendGroups: FriendGroup[] = [];
  public dataFIlter: string = '';
  public filteredDiscussions: DiscussionItem[] = [];
  public sortBy: 'creationDate' | 'lastMessageDate' | 'title' | 'type' = 'lastMessageDate';
  public sortDirection: 'asc' | 'desc' = 'desc';
  // Cache for computed values to avoid method calls in template
  private ownerNameCache: Map<string, string> = new Map();
  private memberListCache: Map<string, string[]> = new Map();
  private memberCountCache: Map<string, number> = new Map();
  private isOwnerCache: Map<string, boolean> = new Map();
  private hasAdminRoleCache: boolean | null = null;
  // Debounce filter input for better performance
  private filterSubject: Subject<string> = new Subject<string>();
  private filterSubscription: Subscription | null = null;
  // Pre-computed properties for template optimization
  public hasAdminRoleValue: boolean = false;
  /** Precomputed sort keys — avoids Date parsing inside Array.sort comparator. */
  private sortKeyCache = new Map<string, { c: number; l: number; t: string; ty: string }>();
  private friendGroupIdsInList = new Set<string>();

  @ViewChild('messagesList', { static: false }) messagesList!: ElementRef;
  @ViewChild('fileInput', { static: false }) fileInput!: ElementRef;
  @ViewChild('messageInput', { static: false }) messageInput!: ElementRef;

  private messageSubscription: Subscription | null = null;
  private discussionsSubscription: Subscription | null = null;
  private isLoadingDiscussions: boolean = false; // Prevent duplicate requests
  /** Coalesce SSE updates to one sort + CD cycle per animation frame (avoids O(n²) sorts). */
  private streamUiRafId: number | null = null;

  constructor(
    private discussionService: DiscussionService,
    public _memberService: MembersService,
    private evenementsService: EvenementsService,
    private friendsService: FriendsService,
    private modalService: NgbModal,
    private translate: TranslateService,
    private keycloakService: KeycloakService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    try {
      this.user = this._memberService.getUser();
      
      // Initialize admin role cache
      this.hasAdminRoleCache = this.keycloakService.hasAdminRole();
      this.hasAdminRoleValue = this.hasAdminRoleCache; // Pre-compute for template

      // Setup filter debouncing (300ms delay for better performance)
      this.filterSubscription = this.filterSubject.pipe(
        debounceTime(300),
        distinctUntilChanged()
      ).subscribe(filterValue => {
        this.dataFIlter = filterValue;
        this.applyFilter();
      });

      // Load all available discussions
      await this.loadAllAvailableDiscussions();
    } catch (error) {
      console.error('Error initializing chat component:', error);
    }
  }


  ngOnDestroy() {
    // Clean up blob URLs to prevent memory leaks
    this.imageUrlCache.forEach((blobUrl) => {
      if (blobUrl && blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrl);
      }
    });
    this.imageUrlCache.clear();
    // Clear discussion caches
    this.clearDiscussionCache();
    // Unsubscribe from filter debounce
    if (this.filterSubscription) {
      this.filterSubscription.unsubscribe();
      this.filterSubscription = null;
    }
    // Unsubscribe from WebSocket
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
    }
    if (this.discussionsSubscription) {
      this.discussionsSubscription.unsubscribe();
    }
    this.cancelScheduledDiscussionStreamUi();
    // Disconnect WebSocket
    if (this.currentDiscussion?.id) {
      this.discussionService.disconnectWebSocket();
    }
  }

  /**
   * Load all available discussions (from events, friend groups, and general)
   * Uses the new backend endpoint that handles all validation and filtering
   * STREAMING: Displays discussions incrementally as they're processed
   * OPTIMIZATION: Prevents duplicate requests
   */
  private async loadAllAvailableDiscussions() {
    // Prevent duplicate requests
    if (this.isLoadingDiscussions) {
      return;
    }
    
    try {
      this.isLoadingDiscussions = true;
      this.isLoading = true;
      this.connectionStatus = 'Loading discussions...';
      
      // Initialize empty arrays for reactive display
      this.availableDiscussions = [];
      this.filteredDiscussions = [];
      this.allFriendGroups = [];
      this.friendGroupIdsInList.clear();
      // Clear cache when reloading
      this.clearDiscussionCache();
      
      // Use SSE streaming endpoint - discussions arrive as they're processed (truly reactive)
      this.discussionService.streamAccessibleDiscussions().pipe(
        catchError(error => {
          this.cancelScheduledDiscussionStreamUi();
          console.error('Error streaming discussions:', error);
          this.connectionStatus = 'Error loading discussions';
          this.isLoading = false;
          const errorEvent: StreamedDiscussion = { type: 'error', data: null };
          return of(errorEvent);
        })
      ).subscribe({
        next: (streamed: StreamedDiscussion) => {
          if (streamed.type === 'discussions' && streamed.data.length > 0) {
            this.ingestDiscussionsFromStream(streamed.data);
          } else if (streamed.type === 'complete') {
            this.cancelScheduledDiscussionStreamUi();
            // All discussions loaded - they're already sorted as they arrived
            this.isLoading = false;
            this.connectionStatus = '';
            
            // Ensure filter is applied at the end (applyFilter also applies sorting)
            this.applyFilter();
            // Trigger change detection once at the end
            this.cdr.markForCheck();
          } else if (streamed.type === 'error') {
            this.cancelScheduledDiscussionStreamUi();
            this.isLoading = false;
            this.isLoadingDiscussions = false;
            this.connectionStatus = 'Error loading discussions';
          }
        },
        error: (error) => {
          this.cancelScheduledDiscussionStreamUi();
          console.error('Error in discussion stream:', error);
          this.isLoading = false;
          this.isLoadingDiscussions = false;
          this.connectionStatus = 'Error loading discussions';
        },
        complete: () => {
          this.isLoadingDiscussions = false;
        }
      });
    } catch (error) {
      console.error('Error in loadAllAvailableDiscussions:', error);
      this.connectionStatus = 'Error initializing';
      this.isLoading = false;
      this.isLoadingDiscussions = false;
    }
  }

  private cancelScheduledDiscussionStreamUi(): void {
    if (this.streamUiRafId !== null) {
      cancelAnimationFrame(this.streamUiRafId);
      this.streamUiRafId = null;
    }
  }

  private scheduleDiscussionStreamUiUpdate(): void {
    if (this.streamUiRafId !== null) {
      return;
    }
    this.streamUiRafId = requestAnimationFrame(() => {
      this.streamUiRafId = null;
      if (!this.dataFIlter || this.dataFIlter.trim() === '') {
        this.filteredDiscussions = this.applySort([...this.availableDiscussions]);
      }
      this.cdr.markForCheck();
    });
  }

  private ingestDiscussionsFromStream(rows: StreamDiscussionItem[]): void {
    const hadNone = this.availableDiscussions.length === 0;
    for (const row of rows) {
      const discussionItem: DiscussionItem = {
        id: row.id,
        title: row.title,
        type: row.type,
        discussion: row.discussion,
        event: row.event as Evenement | undefined,
        friendGroup: row.friendGroup as FriendGroup | undefined,
        messageCount: row.messageCount,
        lastMessageDate: row.lastMessageDate
      };
      this.cacheDiscussionValues(discussionItem);
      this.availableDiscussions.push(discussionItem);
      const gid = discussionItem.friendGroup?.id;
      if (gid && !this.friendGroupIdsInList.has(gid)) {
        this.friendGroupIdsInList.add(gid);
        this.allFriendGroups.push(discussionItem.friendGroup!);
      }
    }
    if (hadNone && this.availableDiscussions.length > 0) {
      this.isLoading = false;
      this.connectionStatus = '';
    }
    if (!this.dataFIlter || this.dataFIlter.trim() === '') {
      if (hadNone) {
        this.filteredDiscussions = this.applySort([...this.availableDiscussions]);
      } else {
        this.scheduleDiscussionStreamUiUpdate();
      }
    }
    this.cdr.markForCheck();
  }

  private buildSortKeys(item: DiscussionItem): { c: number; l: number; t: string; ty: string } {
    return {
      c: item.discussion?.creationDate ? new Date(item.discussion.creationDate).getTime() : 0,
      l: item.lastMessageDate != null ? new Date(item.lastMessageDate).getTime() : 0,
      t: (item.title || '').toLowerCase(),
      ty: item.type || ''
    };
  }

  /**
   * Cache computed values for a discussion to avoid method calls in template
   */
  private cacheDiscussionValues(discussionItem: DiscussionItem): void {
    // Cache owner name
    const ownerName = this.computeOwnerName(discussionItem);
    if (ownerName) {
      this.ownerNameCache.set(discussionItem.id, ownerName);
    }
    
    // Cache member list and count for friend groups
    if (discussionItem.type === 'friendGroup' && discussionItem.friendGroup) {
      const memberList = this.computeGroupMembersList(discussionItem.friendGroup);
      this.memberListCache.set(discussionItem.id, memberList);
      this.memberCountCache.set(discussionItem.id, memberList.length);
    }
    
    // Cache isOwner check
    const isOwner = this.computeIsDiscussionOwner(discussionItem);
    this.isOwnerCache.set(discussionItem.id, isOwner);

    this.sortKeyCache.set(discussionItem.id, this.buildSortKeys(discussionItem));
  }

  /**
   * Clear cache when discussions are reloaded
   */
  private clearDiscussionCache(): void {
    this.ownerNameCache.clear();
    this.memberListCache.clear();
    this.memberCountCache.clear();
    this.isOwnerCache.clear();
    this.sortKeyCache.clear();
    this.hasAdminRoleCache = this.keycloakService.hasAdminRole();
    this.hasAdminRoleValue = this.hasAdminRoleCache;
  }

  /**
   * Compute owner name (extracted from method for caching)
   */
  private computeOwnerName(discussionItem: DiscussionItem): string {
    if (!discussionItem) {
      return '';
    }
    
    if (discussionItem.discussion && discussionItem.discussion.createdBy) {
      const owner = discussionItem.discussion.createdBy;
      if (owner.firstName && owner.lastName) {
        return `${owner.firstName} ${owner.lastName} (${owner.userName || ''})`;
      } else if (owner.userName) {
        return owner.userName;
      }
    }
    
    return '';
  }

  /**
   * Compute group members list (extracted from method for caching)
   */
  private computeGroupMembersList(group: FriendGroup): string[] {
    if (!group) {
      return [];
    }
    
    const membersList: Member[] = [];
    
    // Add owner if not already in members
    if (group.owner) {
      const ownerInMembers = group.members && group.members.some(m => m.id === group.owner.id);
      if (!ownerInMembers) {
        membersList.push(group.owner);
      }
    }
    
    // Add all members
    if (group.members && group.members.length > 0) {
      membersList.push(...group.members);
    }
    
    // Format as "firstName lastName (userName)"
    return membersList.map(member => 
      `${member.firstName} ${member.lastName} (${member.userName})`
    );
  }

  /**
   * Compute isDiscussionOwner (extracted from method for caching)
   */
  private computeIsDiscussionOwner(discussionItem: DiscussionItem): boolean {
    if (!this.user || !this.user.userName || !discussionItem) {
      return false;
    }
    
    if (discussionItem.discussion && discussionItem.discussion.createdBy) {
      return discussionItem.discussion.createdBy.userName === this.user.userName;
    }
    
    return false;
  }

  /**
   * Apply filter to discussions
   * OPTIMIZED: Uses debounced input and efficient filtering
   */
  public applyFilter() {
    let discussions: DiscussionItem[] = [];
    
    if (!this.dataFIlter || this.dataFIlter.trim() === '') {
      discussions = [...this.availableDiscussions];
    } else {
      const filterLower = this.dataFIlter.toLowerCase().trim();
      // Pre-compute filter checks to avoid repeated method calls
      discussions = this.availableDiscussions.filter(discussion => {
        // Filter by title (most common case, check first)
        if (discussion.title && discussion.title.toLowerCase().includes(filterLower)) {
          return true;
        }
        
        // Filter by event name
        if (discussion.type === 'event' && discussion.event?.evenementName?.toLowerCase().includes(filterLower)) {
          return true;
        }
        
        // Filter by friend group name
        if (discussion.type === 'friendGroup' && discussion.friendGroup?.name?.toLowerCase().includes(filterLower)) {
          return true;
        }
        
        // Filter by author name (for events) - more expensive, check last
        if (discussion.type === 'event' && discussion.event?.author) {
          const firstName = discussion.event.author.firstName || '';
          const lastName = discussion.event.author.lastName || '';
          const authorName = `${firstName} ${lastName}`.toLowerCase();
          if (authorName.includes(filterLower)) {
            return true;
          }
        }
        
        return false;
      });
    }
    
    // Apply sorting
    this.filteredDiscussions = this.applySort(discussions);
    this.cdr.markForCheck();
  }

  /**
   * Apply sorting to discussions
   */
  private applySort(discussions: DiscussionItem[]): DiscussionItem[] {
    const sorted = [...discussions];
    const sb = this.sortBy;
    const dir = this.sortDirection === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
      const ka = this.sortKeyCache.get(a.id) ?? this.buildSortKeys(a);
      const kb = this.sortKeyCache.get(b.id) ?? this.buildSortKeys(b);
      let comparison = 0;
      switch (sb) {
        case 'creationDate':
          comparison = ka.c - kb.c;
          break;
        case 'lastMessageDate':
          comparison = ka.l - kb.l;
          break;
        case 'title':
          comparison = ka.t.localeCompare(kb.t);
          break;
        case 'type':
          comparison = ka.ty.localeCompare(kb.ty);
          break;
      }
      return comparison * dir;
    });

    return sorted;
  }

  /**
   * On sort change
   */
  public onSortChange(sortBy: 'creationDate' | 'lastMessageDate' | 'title' | 'type') {
    // Toggle direction if clicking the same sort option, otherwise set to desc
    if (this.sortBy === sortBy) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortBy = sortBy;
      this.sortDirection = 'desc';
    }
    this.applyFilter();
  }

  /**
   * On filter input change - debounced for performance
   */
  public onFilterChange(value: string) {
    this.filterSubject.next(value);
  }

  /**
   * Clear filter
   */
  public clearFilter() {
    this.dataFIlter = '';
    this.filterSubject.next('');
  }

  /**
   * Get all members of a friend group (including owner if not already in members)
   * Uses cache for performance - call getGroupMembersListCached for cached version
   */
  public getGroupMembersList(group: FriendGroup): string[] {
    return this.computeGroupMembersList(group);
  }

  /**
   * Get cached member list for a discussion
   */
  public getGroupMembersListCached(discussionId: string): string[] {
    return this.memberListCache.get(discussionId) || [];
  }

  /**
   * Get total count of members in a friend group (including owner if not already in members)
   * Uses cache for performance - call getGroupMembersCountCached for cached version
   */
  public getGroupMembersCount(group: FriendGroup): number {
    if (!group) {
      return 0;
    }
    
    let count = group.members ? group.members.length : 0;
    
    // Add owner if not already in members
    if (group.owner) {
      const ownerInMembers = group.members && group.members.some(m => m.id === group.owner.id);
      if (!ownerInMembers) {
        count++;
      }
    }
    
    return count;
  }

  /**
   * Get cached member count for a discussion
   */
  public getGroupMembersCountCached(discussionId: string): number {
    return this.memberCountCache.get(discussionId) || 0;
  }

  /**
   * Check if visibility is a standard value (public, private, friends)
   */
  public isStandardVisibility(visibility: string): boolean {
    if (!visibility) {
      return false;
    }
    return visibility === 'public' || visibility === 'private' || visibility === 'friends';
  }

  /**
   * Get visibility label (returns translation key for standard values)
   */
  public getVisibilityLabel(visibility: string): string {
    if (!visibility) {
      return '';
    }
    
    // Check if it's a standard visibility (public, private, friends)
    if (visibility === 'public') {
      return 'EVENTCREATION.PUBLIC';
    } else if (visibility === 'private') {
      return 'EVENTCREATION.PRIVATE';
    } else if (visibility === 'friends') {
      return 'EVENTCREATION.FRIENDS';
    }
    
    // Should not reach here if used with isStandardVisibility check
    return visibility;
  }

  /**
   * Get status label (returns translation key)
   * Status values in database are: "Open", "Closed", "Cancel"
   */
  public getStatusLabel(status: string): string {
    if (!status) {
      return '';
    }
    
    // Map status to translation keys
    // Status values are stored as "Open", "Closed", "Cancel" (with capital letter)
    const statusTrimmed = status.trim();
    const statusLower = statusTrimmed.toLowerCase();
    
    // Check for "Open" (exact match or lowercase)
    // Status values in database are: "Open", "Closed", "Cancel" (with capital letter)
    if (statusTrimmed === 'Open' || statusTrimmed === 'OPEN' || statusLower === 'open' || statusLower === 'ouvert') {
      return 'COMMUN.STATUSOPEN';
    } 
    // Check for "Closed" (exact match or lowercase variations)
    else if (statusTrimmed === 'Closed' || statusTrimmed === 'CLOSED' || 
             statusLower === 'closed' || statusLower === 'close' || statusLower === 'fermé' || statusLower === 'ferme') {
      return 'COMMUN.STATUSCLOSE';
    } 
    // Check for "Cancel" (exact match or lowercase variations)
    else if (statusTrimmed === 'Cancel' || statusTrimmed === 'CANCEL' || 
             statusLower === 'cancel' || statusLower === 'cancelled' || statusLower === 'annulé' || statusLower === 'annule') {
      return 'COMMUN.STATUSCANCEL';
    }
    
    // Return status as is if no translation found (will be displayed as-is)
    return status;
  }

  /**
   * Handle card click - only open modal for non-friendGroup discussions
   */
  public handleCardClick(discussionItem: DiscussionItem) {
    // For friend groups, don't open on card click (use button instead)
    if (discussionItem.type !== 'friendGroup') {
      this.openDiscussionModal(discussionItem);
    }
  }

  /**
   * Open discussion modal
   */
  public openDiscussionModal(discussionItem: DiscussionItem) {
    const modalRef = this.modalService.open(DiscussionModalComponent, {
      size: 'lg',
      centered: true,
      backdrop: 'static',
      keyboard: true,
      windowClass: 'discussion-modal-window'
    });
    
    modalRef.componentInstance.discussionId = discussionItem.id;
    modalRef.componentInstance.title = discussionItem.title;
  }

  /**
   * Load messages for the current discussion
   */
  private loadMessages() {
    if (!this.currentDiscussion?.id) {
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
      },
      error: (error) => {
        console.error('Error loading messages:', error);
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

    this.isConnecting = true;
    this.connectionStatus = 'Connecting';

    // Subscribe to real-time messages FIRST, before connecting
    this.messageSubscription = this.discussionService.getMessageObservable().subscribe({
      next: (data) => {
        // Handle status updates
        if (data.action === 'status') {
          this.connectionStatus = data.status;
          if (data.status === 'Connected') {
            this.isConnecting = false;
          } else if (data.status.includes('error') || data.status.includes('timeout') || data.status === 'Disconnected') {
            this.isConnecting = false;
          }
        } else if (data.action === 'delete') {
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
        console.error('WebSocket error:', error);
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
    const subfolder = isImage ? 'images' : 'videos';
    this.discussionService.getFileUrl(this.currentDiscussion.id, subfolder, filename).subscribe({
      next: (blobUrl: string) => {
        this.imageUrlCache.set(cacheKey, blobUrl);
      },
      error: (error) => {
        console.error('Error loading file:', error);
      }
    });

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
  trackByMessageId(index: number, item: DiscussionMessage): string {
    return item.id || index.toString();
  }

  /**
   * Check if message is from current user
   */
  isOwnMessage(message: DiscussionMessage): boolean {
    return message.author?.userName === this.user.userName;
  }

  /**
   * Check if current user has admin role (uses cache for performance)
   */
  hasAdminRole(): boolean {
    if (this.hasAdminRoleCache === null) {
      this.hasAdminRoleCache = this.keycloakService.hasAdminRole();
    }
    return this.hasAdminRoleCache;
  }

  /**
   * Track by function for ngFor to prevent unnecessary DOM recreation
   */
  trackByDiscussionId(index: number, item: DiscussionItem): string {
    return item.id;
  }

  /**
   * Open statistics modal (Admin only)
   */
  openStatisticsModal() {
    const modalRef = this.modalService.open(DiscussionStatisticsModalComponent, {
      size: 'xl',
      centered: true,
      backdrop: 'static',
      windowClass: 'discussion-statistics-modal'
    });
  }

  /**
   * Get the owner name of a discussion (uses cache for performance)
   */
  getDiscussionOwnerName(discussionItem: DiscussionItem): string {
    if (!discussionItem) {
      return '';
    }
    
    // Return cached value if available
    const cached = this.ownerNameCache.get(discussionItem.id);
    if (cached !== undefined) {
      return cached;
    }
    
    // Fallback to computation (shouldn't happen if cache is populated correctly)
    return this.computeOwnerName(discussionItem);
  }

  /**
   * Check if current user is the owner of a discussion (uses cache for performance)
   */
  isDiscussionOwner(discussionItem: DiscussionItem): boolean {
    if (!this.user || !this.user.userName || !discussionItem) {
      return false;
    }
    
    // Return cached value if available
    const cached = this.isOwnerCache.get(discussionItem.id);
    if (cached !== undefined) {
      return cached;
    }
    
    // Fallback to computation (shouldn't happen if cache is populated correctly)
    return this.computeIsDiscussionOwner(discussionItem);
  }

  /**
   * Delete a discussion
   */
  async deleteDiscussion(discussionItem: DiscussionItem, event: Event) {
    // Prevent the card click event from firing
    event.stopPropagation();
    
    if (!discussionItem || !discussionItem.id) {
      return;
    }

    // Check if discussion has messages
    const hasMessages = discussionItem.messageCount && discussionItem.messageCount > 0;
    
    // Build confirmation message based on whether there are messages
    let confirmMessage: string;
    if (hasMessages) {
      const messageCount = discussionItem.messageCount || 0;
      // Get translated confirmation message with message count
      confirmMessage = this.translate.instant('CHAT.CONFIRM_DELETE_WITH_MESSAGES', { count: messageCount });
    } else {
      // Get translated confirmation message for empty discussion
      confirmMessage = this.translate.instant('CHAT.CONFIRM_DELETE_EMPTY');
    }

    // Confirm deletion
    if (!confirm(confirmMessage)) {
      return;
    }

    try {
      this.isLoading = true;
      
      // First, delete the discussion
      await new Promise<void>((resolve, reject) => {
        this.discussionService.deleteDiscussion(discussionItem.id).subscribe({
          next: async () => {
            // After successful deletion, update the associated event or friend group
            try {
              if (discussionItem.type === 'event' && discussionItem.event) {
                // Update event to remove discussionId
                // Need to explicitly set to null (not undefined) so it's included in JSON
                const event = { ...discussionItem.event };
                event.discussionId = null as any; // Set to null so it's serialized in JSON
                await new Promise<void>((eventResolve, eventReject) => {
                  this.evenementsService.putEvenement(event).subscribe({
                    next: () => {
                      console.log(`Event ${event.id} updated: discussionId removed`);
                      eventResolve();
                    },
                    error: (eventError) => {
                      console.error('Error updating event after discussion deletion:', eventError);
                      // Don't fail the whole operation if event update fails
                      eventResolve();
                    }
                  });
                });
              } else if (discussionItem.type === 'friendGroup' && discussionItem.friendGroup) {
                // Update friend group to remove discussionId
                const group = discussionItem.friendGroup;
                const memberIds = group.members ? group.members.map(m => m.id || '').filter(id => id) : [];
                // Pass undefined to clear discussionId (backend will handle it)
                await new Promise<void>((groupResolve, groupReject) => {
                  this.friendsService.updateFriendGroup(group.id, group.name, memberIds, undefined).subscribe({
                    next: () => {
                      console.log(`Friend group ${group.id} updated: discussionId removed`);
                      groupResolve();
                    },
                    error: (groupError) => {
                      console.error('Error updating friend group after discussion deletion:', groupError);
                      // Don't fail the whole operation if group update fails
                      groupResolve();
                    }
                  });
                });
              }
            } catch (updateError) {
              console.error('Error updating associated entity:', updateError);
              // Continue even if update fails
            }
            
            // Remove the discussion from the list
            this.availableDiscussions = this.availableDiscussions.filter(d => d.id !== discussionItem.id);
            this.filteredDiscussions = this.filteredDiscussions.filter(d => d.id !== discussionItem.id);
            // Clear cached values for deleted discussion
            this.ownerNameCache.delete(discussionItem.id);
            this.memberListCache.delete(discussionItem.id);
            this.memberCountCache.delete(discussionItem.id);
            this.isOwnerCache.delete(discussionItem.id);
            this.isLoading = false;
            resolve();
          },
          error: (error) => {
            console.error('Error deleting discussion:', error);
            alert('Error deleting discussion: ' + (error.message || error));
            this.isLoading = false;
            reject(error);
          }
        });
      });
    } catch (error) {
      console.error('Error in deleteDiscussion:', error);
      this.isLoading = false;
    }
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
   * Check if friend group has a WhatsApp link
   */
  hasWhatsAppLink(group: FriendGroup | undefined): boolean {
    return !!(group && group.whatsappLink && group.whatsappLink.trim().length > 0);
  }

  /**
   * Navigate to event details page
   */
  navigateToEventDetails(discussionItem: DiscussionItem, event: Event): void {
    event.stopPropagation();
    if (discussionItem.type === 'event' && discussionItem.event && discussionItem.event.id) {
      this.router.navigate(['/details-evenement', discussionItem.event.id]);
    }
  }

  openWhatsAppLink(group: FriendGroup | undefined): void {
    if (group && group.whatsappLink) {
      window.open(group.whatsappLink, '_blank');
    }
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
