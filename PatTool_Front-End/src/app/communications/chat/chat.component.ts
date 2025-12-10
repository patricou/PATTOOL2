// Discussion Component - Replaced Firebase with MongoDB backend
import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { DiscussionService, Discussion, DiscussionMessage } from '../../services/discussion.service';
import { Member } from '../../model/member';
import { MembersService } from '../../services/members.service';
import { Subscription, forkJoin, of, Observable } from 'rxjs';
import { EvenementsService } from '../../services/evenements.service';
import { FriendsService } from '../../services/friends.service';
import { Evenement } from '../../model/evenement';
import { FriendGroup } from '../../model/friend';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { DiscussionModalComponent } from '../discussion-modal/discussion-modal.component';
import { catchError, map, timeout } from 'rxjs/operators';
import { TranslateService } from '@ngx-translate/core';
import { KeycloakService } from '../../keycloak/keycloak.service';

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
  styleUrls: ['./chat.component.css']
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
  public editingMessageId: string | null = null;
  public allEvents: Evenement[] = [];
  public allFriendGroups: FriendGroup[] = [];
  public dataFIlter: string = '';
  public filteredDiscussions: DiscussionItem[] = [];

  @ViewChild('messagesList', { static: false }) messagesList!: ElementRef;
  @ViewChild('fileInput', { static: false }) fileInput!: ElementRef;
  @ViewChild('messageInput', { static: false }) messageInput!: ElementRef;

  private messageSubscription: Subscription | null = null;
  private discussionsSubscription: Subscription | null = null;
  private eventsSubscription: Subscription | null = null;

  constructor(
    private discussionService: DiscussionService,
    public _memberService: MembersService,
    private evenementsService: EvenementsService,
    private friendsService: FriendsService,
    private modalService: NgbModal,
    private translate: TranslateService,
    private keycloakService: KeycloakService
  ) {}

  async ngOnInit() {
    try {
      this.user = this._memberService.getUser();
      console.log('Chat component initialized with user:', this.user);

      // Load all available discussions
      await this.loadAllAvailableDiscussions();
    } catch (error) {
      console.error('Error initializing chat component:', error);
    }
  }


  ngOnDestroy() {
    // Unsubscribe from WebSocket
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
    }
    if (this.discussionsSubscription) {
      this.discussionsSubscription.unsubscribe();
    }
    if (this.eventsSubscription) {
      this.eventsSubscription.unsubscribe();
    }
    // Disconnect WebSocket
    if (this.currentDiscussion?.id) {
      this.discussionService.disconnectWebSocket();
    }
  }

  /**
   * Load all available discussions (from events, friend groups, and general)
   */
  private async loadAllAvailableDiscussions() {
    try {
      this.isLoading = true;
      this.connectionStatus = 'Loading discussions...';
      
      // Load general discussion and friend groups first (fast, don't wait for events)
      // Events will be loaded progressively after initial display
      forkJoin({
        friendGroups: this.friendsService.getFriendGroups().pipe(
          catchError(error => {
            console.error('Error loading friend groups:', error);
            return of([]);
          })
        ),
        generalDiscussion: this.discussionService.getDefaultDiscussion().pipe(
          catchError(error => {
            console.error('Error loading general discussion:', error);
            return of(null);
          })
        )
      }).subscribe({
        next: (results) => {
          this.allFriendGroups = results.friendGroups || [];
          
          // Build initial list with general and friend groups (fast)
          this.availableDiscussions = [];
          
          // Add general discussion immediately
          if (results.generalDiscussion) {
            this.availableDiscussions.push({
              id: results.generalDiscussion.id || '',
              title: results.generalDiscussion.title || 'Discussion Générale',
              type: 'general',
              discussion: results.generalDiscussion
            });
          }
          
          // Add friend group discussions immediately
          this.allFriendGroups.forEach(group => {
            if (group.discussionId && this.canAccessFriendGroup(group)) {
              const discussionItem: DiscussionItem = {
                id: group.discussionId,
                title: `Discussion - ${group.name}`,
                type: 'friendGroup',
                friendGroup: group
              };
              this.availableDiscussions.push(discussionItem);
              // Immediately start loading the full discussion object to get createdBy
              this.loadDiscussionDetailsForItem(discussionItem);
            }
          });
          
          // Stop loading state to show what we have so far (progressive loading)
          this.isLoading = false;
          this.connectionStatus = '';
          
          // Initialize filtered discussions
          this.filteredDiscussions = [...this.availableDiscussions];
          
          // Load details for what we have
          this.loadDiscussionDetails();
          
          // Apply initial filter
          this.applyFilter();
          
          // Now load events asynchronously and add them as they come (progressive loading)
          this.loadEventDiscussions();
        },
        error: (error) => {
          console.error('Error loading discussions:', error);
          this.connectionStatus = 'Error loading discussions';
          this.isLoading = false;
        }
      });
    } catch (error) {
      console.error('Error in loadAllAvailableDiscussions:', error);
      this.connectionStatus = 'Error initializing';
      this.isLoading = false;
    }
  }

  /**
   * Load event discussions asynchronously and add them as they arrive
   */
  private loadEventDiscussions() {
    const events: Evenement[] = [];
    let completed = false;
    let timeoutId: any = null;
    
    // Set a shorter timeout: 5 seconds for faster response
    timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        this.addEventDiscussions(events);
      }
    }, 5000);
    
    this.eventsSubscription = this.evenementsService.streamEvents('*', this.user.id || '', 'all').subscribe({
      next: (streamedEvent) => {
        if (streamedEvent.type === 'event' && streamedEvent.data) {
          // Only add events that have a discussionId
          if (streamedEvent.data.discussionId) {
            // Check for duplicates
            const existingIndex = events.findIndex(e => e.id === streamedEvent.data.id);
            if (existingIndex >= 0) {
              events[existingIndex] = streamedEvent.data;
            } else {
              events.push(streamedEvent.data);
              // Add to discussions immediately as events arrive (progressive loading)
              this.addEventToDiscussions(streamedEvent.data);
            }
          }
        } else if (streamedEvent.type === 'complete') {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (!completed) {
            completed = true;
            this.addEventDiscussions(events);
          }
        }
      },
      error: (error) => {
        if (!completed) {
          completed = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          console.error('Error loading events:', error);
          this.addEventDiscussions(events);
        }
      }
    });
  }

  /**
   * Add a single event to discussions list immediately
   */
  private addEventToDiscussions(event: Evenement) {
    if (!event || !event.id || !event.discussionId) {
      return;
    }
    
    if (this.canSeeEvent(event)) {
      // Check for duplicates
      const existing = this.availableDiscussions.find(d => d.id === event.discussionId);
      if (!existing) {
        this.availableDiscussions.push({
          id: event.discussionId,
          title: `Discussion - ${event.evenementName}`,
          type: 'event',
          event: event
        });
        // Load details asynchronously (don't block)
        this.loadDiscussionDetailsForItem(this.availableDiscussions[this.availableDiscussions.length - 1]);
      }
    }
  }

  /**
   * Add all event discussions at once (used when stream completes)
   */
  private addEventDiscussions(events: Evenement[]) {
    let added = 0;
    events.forEach(event => {
      if (!event || !event.id) {
        return;
      }
      
      if (event.discussionId && this.canSeeEvent(event)) {
        // Check for duplicates
        const existing = this.availableDiscussions.find(d => d.id === event.discussionId);
        if (!existing) {
          this.availableDiscussions.push({
            id: event.discussionId,
            title: `Discussion - ${event.evenementName}`,
            type: 'event',
            event: event
          });
          added++;
        }
      }
    });
    
    console.log(`Added ${added} event discussions (total: ${this.availableDiscussions.length})`);
    
    // Load details for all discussions asynchronously
    this.loadDiscussionDetails();
    
    // Apply filter after adding all events
    this.applyFilter();
  }

  /**
   * Load details (message count, last message date, and full discussion with createdBy) for a single discussion
   */
  private loadDiscussionDetailsForItem(discussionItem: DiscussionItem) {
    // Load both messages and full discussion in parallel
    forkJoin({
      messages: this.discussionService.getMessages(discussionItem.id).pipe(
        catchError(error => {
          console.error(`Error loading messages for discussion ${discussionItem.id}:`, error);
          return of([]);
        })
      ),
      discussion: this.discussionService.getDiscussionById(discussionItem.id).pipe(
        catchError(error => {
          console.error(`Error loading discussion ${discussionItem.id}:`, error);
          return of(null);
        })
      )
    }).pipe(
      map(results => {
        // Update message count and last message date
        const messages = results.messages;
        discussionItem.messageCount = messages.length;
        if (messages.length > 0) {
          const sortedMessages = messages.sort((a, b) => {
            const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
            const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
            return dateB - dateA;
          });
          discussionItem.lastMessageDate = sortedMessages[0].dateTime ? new Date(sortedMessages[0].dateTime) : undefined;
        }
        // Always update discussion object with createdBy - this is critical for owner check
        if (results.discussion) {
          discussionItem.discussion = results.discussion;
          console.log(`Discussion ${discussionItem.id} loaded with owner:`, results.discussion.createdBy?.userName);
        } else {
          console.warn(`Discussion ${discussionItem.id} could not be loaded - owner check will fail`);
        }
        return discussionItem;
      }),
      catchError(error => {
        console.error(`Error in loadDiscussionDetailsForItem for ${discussionItem.id}:`, error);
        return of(discussionItem);
      }),
      timeout(10000) // Increased timeout to 10 seconds
    ).subscribe();
  }

  /**
   * Load details (message count, last message date, and full discussion with createdBy) for each discussion
   * Optimized to load in parallel with timeout
   */
  private loadDiscussionDetails() {
    // Load all discussions in parallel with timeout
    const detailObservables = this.availableDiscussions.map(discussionItem => {
      // Load both messages and full discussion in parallel
      return forkJoin({
        messages: this.discussionService.getMessages(discussionItem.id).pipe(
          catchError(error => {
            console.error(`Error loading messages for discussion ${discussionItem.id}:`, error);
            return of([]);
          })
        ),
        discussion: this.discussionService.getDiscussionById(discussionItem.id).pipe(
          catchError(error => {
            console.error(`Error loading discussion ${discussionItem.id}:`, error);
            return of(null);
          })
        )
      }).pipe(
        map(results => {
          // Update message count and last message date
          const messages = results.messages;
          discussionItem.messageCount = messages.length;
          if (messages.length > 0) {
            // Sort by date and get the last message
            const sortedMessages = messages.sort((a, b) => {
              const dateA = a.dateTime ? new Date(a.dateTime).getTime() : 0;
              const dateB = b.dateTime ? new Date(b.dateTime).getTime() : 0;
              return dateB - dateA; // Newest first
            });
            discussionItem.lastMessageDate = sortedMessages[0].dateTime ? new Date(sortedMessages[0].dateTime) : undefined;
          }
          // Always update discussion object with createdBy - this is critical for owner check
          if (results.discussion) {
            discussionItem.discussion = results.discussion;
            console.log(`Discussion ${discussionItem.id} loaded with owner:`, results.discussion.createdBy?.userName);
          } else {
            console.warn(`Discussion ${discussionItem.id} could not be loaded - owner check will fail`);
          }
          return discussionItem;
        }),
        catchError(error => {
          console.error(`Error in loadDiscussionDetails for ${discussionItem.id}:`, error);
          return of(discussionItem);
        }),
        // Add timeout of 10 seconds per discussion (increased for reliability)
        timeout(10000)
      );
    });

    // Load all in parallel, but don't block UI
    if (detailObservables.length > 0) {
      forkJoin(detailObservables).pipe(
        catchError(error => {
          console.error('Error loading some discussion details:', error);
          return of([]);
        })
      ).subscribe({
        next: (items) => {
          console.log(`All discussion details loaded (${items.length} discussions)`);
          // Verify that discussions have been loaded
          const discussionsWithoutOwner = this.availableDiscussions.filter(d => !d.discussion || !d.discussion.createdBy);
          if (discussionsWithoutOwner.length > 0) {
            console.warn(`${discussionsWithoutOwner.length} discussions missing owner information:`, 
              discussionsWithoutOwner.map(d => d.id));
            // Retry loading for discussions without owner info
            discussionsWithoutOwner.forEach(d => {
              console.log(`Retrying load for discussion ${d.id}`);
              this.loadDiscussionDetailsForItem(d);
            });
          }
        },
        error: (error) => {
          console.error('Error loading discussion details:', error);
        }
      });
    }
  }

  /**
   * Check if user can see an event
   * Note: Backend already filters events by visibility, so if an event is in the list,
   * the user should be able to see it. We only do additional checks for friend groups.
   */
  private canSeeEvent(event: Evenement): boolean {
    if (!event || !this.user || !this.user.id) {
      return false;
    }
    
    // If visibility is a friend group, we need to check if user is in that group
    // For other visibility types (public, private, friends), backend already filtered
    if (event.friendGroupId) {
      const group = this.allFriendGroups.find(g => g.id === event.friendGroupId);
      if (group) {
        return this.canAccessFriendGroup(group);
      }
      // If group not found, assume user can't access (shouldn't happen if backend filtered correctly)
      return false;
    }
    
    // Check if visibility matches a friend group name (legacy support)
    if (event.visibility && 
        event.visibility !== 'public' && 
        event.visibility !== 'private' && 
        event.visibility !== 'friends') {
      const group = this.allFriendGroups.find(g => g.name === event.visibility);
      if (group) {
        return this.canAccessFriendGroup(group);
      }
      // If visibility is a group name but group not found, assume user can't access
      return false;
    }
    
    // For public, private, friends - backend already filtered, so user can see it
    return true;
  }

  /**
   * Check if user can access a friend group (is member or owner)
   */
  private canAccessFriendGroup(group: FriendGroup): boolean {
    if (!group || !this.user || !this.user.id) {
      return false;
    }
    
    // Owner can always access
    if (group.owner && group.owner.id === this.user.id) {
      return true;
    }
    
    // Check if user is a member
    if (group.members && group.members.some(m => m.id === this.user.id)) {
      return true;
    }
    
    // Check if user is authorized
    if (group.authorizedUsers && group.authorizedUsers.some(m => m.id === this.user.id)) {
      return true;
    }
    
    return false;
  }

  /**
   * Apply filter to discussions
   */
  public applyFilter() {
    if (!this.dataFIlter || this.dataFIlter.trim() === '') {
      this.filteredDiscussions = [...this.availableDiscussions];
      return;
    }
    
    const filterLower = this.dataFIlter.toLowerCase().trim();
    this.filteredDiscussions = this.availableDiscussions.filter(discussion => {
      // Filter by title
      if (discussion.title.toLowerCase().includes(filterLower)) {
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
      
      // Filter by author name (for events)
      if (discussion.type === 'event' && discussion.event?.author) {
        const authorName = `${discussion.event.author.firstName} ${discussion.event.author.lastName}`.toLowerCase();
        if (authorName.includes(filterLower)) {
          return true;
        }
      }
      
      return false;
    });
  }

  /**
   * Clear filter
   */
  public clearFilter() {
    this.dataFIlter = '';
    this.applyFilter();
  }

  /**
   * Get all members of a friend group (including owner if not already in members)
   */
  public getGroupMembersList(group: FriendGroup): string[] {
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
   * Get total count of members in a friend group (including owner if not already in members)
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
   * Check if current user has admin role
   */
  hasAdminRole(): boolean {
    return this.keycloakService.hasAdminRole();
  }

  /**
   * Get the owner name of a discussion
   */
  getDiscussionOwnerName(discussionItem: DiscussionItem): string {
    if (!discussionItem) {
      return '';
    }
    
    // Check if discussion has createdBy field
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
   * Check if current user is the owner of a discussion
   */
  isDiscussionOwner(discussionItem: DiscussionItem): boolean {
    if (!this.user || !this.user.userName || !discussionItem) {
      return false;
    }
    
    // Check if discussion has createdBy field
    if (discussionItem.discussion && discussionItem.discussion.createdBy) {
      const isOwner = discussionItem.discussion.createdBy.userName === this.user.userName;
      return isOwner;
    }
    
    // If discussion object is not loaded yet, try to load it
    if (!discussionItem.discussion) {
      console.warn(`Discussion ${discussionItem.id} not loaded yet, attempting to load...`);
      this.loadDiscussionDetailsForItem(discussionItem);
    }
    
    return false;
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
