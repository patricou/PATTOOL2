import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { Member } from '../../model/member';
import { FriendRequest, FriendRequestStatus, Friend, FriendGroup } from '../../model/friend';
import { FriendsService } from '../../services/friends.service';
import { MembersService } from '../../services/members.service';
import { TranslateService } from '@ngx-translate/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { DiscussionModalComponent } from '../../communications/discussion-modal/discussion-modal.component';
import { DiscussionService } from '../../services/discussion.service';
import { KeycloakService } from '../../keycloak/keycloak.service';

@Component({
  selector: 'app-friends',
  templateUrl: './friends.component.html',
  styleUrls: ['./friends.component.css']
})
export class FriendsComponent implements OnInit {

  public allUsers: Member[] = [];
  public friends: Friend[] = [];
  public pendingRequests: FriendRequest[] = [];
  public sentRequests: FriendRequest[] = [];
  public currentUser: Member = new Member("", "", "", "", "", [], "");
  public searchFilter: string = '';
  public activeTab: 'users' | 'requests' | 'friends' | 'groups' | 'myuser' = 'myuser';
  public selectedFriendIndex: number | null = null;
  
  // WhatsApp link editing for current user
  public editingMyWhatsappLink: boolean = false;
  public myWhatsappLink: string = '';
  public detectedCountryCode: string = ''; // Country code for flag display
  public loading: boolean = false;
  public errorMessage: string = '';
  public inviteEmail: string = '';
  public checkingEmail: boolean = false;
  public emailExists: boolean = false;
  public emailCheckResult: { exists: boolean; memberId?: string; userName?: string } | null = null;
  public sendingInvite: boolean = false;
  public showCustomMessagePrompt: boolean = false;
  public customMessage: string = '';
  public showCustomMessageInput: boolean = false;
  // For friend requests (per user)
  public friendRequestMessagePrompts: Map<string, boolean> = new Map(); // userId -> show prompt
  public friendRequestMessageInputs: Map<string, boolean> = new Map(); // userId -> show input
  public friendRequestMessages: Map<string, string> = new Map(); // userId -> message
  
  // Friend groups management
  public friendGroups: FriendGroup[] = [];
  public newGroupName: string = '';
  public selectedGroupMembers: string[] = [];
  public isCreatingGroup: boolean = false;
  public editingGroupId: string | null = null;
  public editingGroupName: string = '';
  public editingGroupMembers: string[] = [];
  public editingGroupWhatsappLink: string = '';
  // Authorized users management
  public managingAuthorizedUsersGroupId: string | null = null;
  public selectedAuthorizedUsers: string[] = [];
  // User statuses (online/offline from Keycloak)
  public userStatuses: Map<string, { online: boolean; status: string }> = new Map();
  
  // WhatsApp link editing - separate for each user
  public editingWhatsappLinks: Map<string, 'user1' | 'user2' | null> = new Map(); // friendId -> which user is editing (null if not editing)
  public whatsappLinks: { [key: string]: string } = {}; // friendId -> whatsapp link value being edited

  constructor(
    private _friendsService: FriendsService,
    private _memberService: MembersService,
    private _translateService: TranslateService,
    private modalService: NgbModal,
    private _discussionService: DiscussionService,
    private cdr: ChangeDetectorRef,
    private _keycloakService: KeycloakService
  ) { }

  ngOnInit() {
    this.currentUser = this._memberService.getUser();
    
    // Wait for user ID to be set
    this.waitForNonEmptyValue().then(() => {
      this.loadData();
    });
  }

  private waitForNonEmptyValue(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkValue = () => {
        if (this.currentUser.id !== "") {
          resolve();
        } else {
          setTimeout(checkValue, 100);
        }
      };
      checkValue();
    });
  }

  loadData() {
    this.loading = true;
    this.errorMessage = '';

    // Refresh currentUser from service to ensure we have the latest data including whatsappLink
    const serviceUser = this._memberService.getUser();
    if (serviceUser && serviceUser.id === this.currentUser.id) {
      this.currentUser = serviceUser;
      console.log('CurrentUser refreshed from service - whatsappLink:', this.currentUser.whatsappLink);
    }

    let completedRequests = 0;
    const totalRequests = 5;

    const checkComplete = () => {
      completedRequests++;
      if (completedRequests >= totalRequests) {
        this.loading = false;
      }
    };

    // Load all users
    this._friendsService.getAllUsers().subscribe(
      users => {
        // Filter out current user
        this.allUsers = users.filter(u => u.id !== this.currentUser.id);
        // Load statuses for all users
        this.loadUserStatuses();
        checkComplete();
      },
      error => {
        console.error('Error loading users:', error);
        this.errorMessage = 'Error loading users';
        checkComplete();
      }
    );

    // Load pending requests (incoming)
    this._friendsService.getPendingRequests().subscribe(
      requests => {
        this.pendingRequests = requests;
        checkComplete();
      },
      error => {
        console.error('Error loading pending requests:', error);
        checkComplete();
      }
    );

    // Load sent requests (outgoing)
    this._friendsService.getSentRequests().subscribe(
      requests => {
        this.sentRequests = requests;
        checkComplete();
      },
      error => {
        console.error('Error loading sent requests:', error);
        checkComplete();
      }
    );

    // Load friends
    this._friendsService.getFriends().subscribe(
      friends => {
        this.friends = friends;
        // Load statuses for all friends
        this.loadFriendStatuses();
        checkComplete();
      },
      error => {
        console.error('Error loading friends:', error);
        checkComplete();
      }
    );

    // Load friend groups
    this._friendsService.getFriendGroups().subscribe(
      groups => {
        this.friendGroups = groups;
        checkComplete();
      },
      error => {
        console.error('Error loading friend groups:', error);
        checkComplete();
      }
    );
  }

  sendFriendRequest(userId: string) {
    // If we haven't asked about custom message yet, ask first
    if (!this.friendRequestMessagePrompts.get(userId) && !this.friendRequestMessageInputs.get(userId)) {
      this.friendRequestMessagePrompts.set(userId, true);
      return;
    }

    // If user is in custom message input mode but hasn't entered a message, don't proceed
    if (this.friendRequestMessageInputs.get(userId) && !this.friendRequestMessages.get(userId)?.trim()) {
      return;
    }

    // Proceed with sending friend request
    const message = this.friendRequestMessageInputs.get(userId) ? 
      (this.friendRequestMessages.get(userId)?.trim() || undefined) : undefined;
    
    this.loading = true;
    this._friendsService.sendFriendRequest(userId, message).subscribe(
      request => {
        // Clear message state for this user
        this.friendRequestMessagePrompts.delete(userId);
        this.friendRequestMessageInputs.delete(userId);
        this.friendRequestMessages.delete(userId);
        this.loadAllUsers(); // Reload only users
        this.loading = false;
      },
      error => {
        console.error('Error sending friend request:', error);
        this.errorMessage = 'Error sending friend request';
        this.loading = false;
      }
    );
  }

  cancelSentRequest(userId: string) {
    // Find the sent request for this user
    const sentRequest = this.sentRequests.find(r => r.recipient.id === userId);
    if (sentRequest) {
      this.loading = true;
      // Use rejectFriendRequest to cancel our own sent request
      this._friendsService.rejectFriendRequest(sentRequest.id).subscribe(
        () => {
          this.loadAllUsers(); // Reload only users
          this.loading = false;
        },
        error => {
          console.error('Error canceling sent request:', error);
          this.errorMessage = 'Error canceling sent request';
          this.loading = false;
        }
      );
    }
  }

  resendFriendRequest(userId: string) {
    // If we haven't asked about custom message yet, ask first
    if (!this.friendRequestMessagePrompts.get(userId) && !this.friendRequestMessageInputs.get(userId)) {
      // Pre-fill with existing message if available
      const sentRequest = this.sentRequests.find(r => r.recipient.id === userId);
      if (sentRequest && sentRequest.message) {
        this.friendRequestMessages.set(userId, sentRequest.message);
      }
      this.friendRequestMessagePrompts.set(userId, true);
      return;
    }

    // If user is in custom message input mode but hasn't entered a message, don't proceed
    if (this.friendRequestMessageInputs.get(userId) && !this.friendRequestMessages.get(userId)?.trim()) {
      return;
    }

    // Proceed with resending friend request
    const message = this.friendRequestMessageInputs.get(userId) ? 
      (this.friendRequestMessages.get(userId)?.trim() || undefined) : undefined;
    
    // Simply send the request - the backend will update the existing one if it exists
    // This is simpler and more efficient than canceling then sending
    this.loading = true;
    this._friendsService.sendFriendRequest(userId, message).subscribe(
      request => {
        // Clear message state for this user
        this.friendRequestMessagePrompts.delete(userId);
        this.friendRequestMessageInputs.delete(userId);
        this.friendRequestMessages.delete(userId);
        this.loadAllUsers(); // Reload only users
        this.loading = false;
      },
      error => {
        console.error('Error resending friend request:', error);
        this.errorMessage = 'Error resending friend request';
        this.loading = false;
      }
    );
  }

  approveRequest(requestId: string) {
    this.loading = true;
    this._friendsService.approveFriendRequest(requestId).subscribe(
      friend => {
        this.loadData(); // Reload data
        this.loading = false;
      },
      error => {
        console.error('Error approving request:', error);
        this.errorMessage = 'Error approving friend request';
        this.loading = false;
      }
    );
  }

  rejectRequest(requestId: string) {
    this.loading = true;
    this._friendsService.rejectFriendRequest(requestId).subscribe(
      () => {
        this.loadData(); // Reload data
        this.loading = false;
      },
      error => {
        console.error('Error rejecting request:', error);
        this.errorMessage = 'Error rejecting friend request';
        this.loading = false;
      }
    );
  }

  removeFriend(friendId: string) {
    if (confirm('Are you sure you want to remove this friend?')) {
      this.loading = true;
      this._friendsService.removeFriend(friendId).subscribe(
        () => {
          this.loadData(); // Reload data
          this.loading = false;
        },
        error => {
          console.error('Error removing friend:', error);
          this.errorMessage = 'Error removing friend';
          this.loading = false;
        }
      );
    }
  }

  getUserStatus(user: Member): 'friend' | 'pending' | 'sent' | 'none' {
    // Check if user is a friend
    const isFriend = this.friends.some(f => 
      (f.user1.id === user.id && f.user2.id === this.currentUser.id) ||
      (f.user2.id === user.id && f.user1.id === this.currentUser.id)
    );
    if (isFriend) return 'friend';

    // Check if there's a pending request from this user
    const hasPendingRequest = this.pendingRequests.some(r => r.requester.id === user.id);
    if (hasPendingRequest) return 'pending';

    // Check if we sent a request to this user
    const hasSentRequest = this.sentRequests.some(r => r.recipient.id === user.id);
    if (hasSentRequest) return 'sent';

    return 'none';
  }

  getSentRequestDate(user: Member): Date | null {
    const sentRequest = this.sentRequests.find(r => r.recipient.id === user.id);
    return sentRequest?.requestDate || null;
  }

  getFriendshipDate(user: Member): Date | null {
    const friendship = this.friends.find(f => 
      (f.user1.id === user.id && f.user2.id === this.currentUser.id) ||
      (f.user2.id === user.id && f.user1.id === this.currentUser.id)
    );
    return friendship?.friendshipDate || null;
  }

  /**
   * Get user roles as an array (parse from comma-separated string if needed)
   * @param user The user member
   * @return Array of role names, or empty array if no roles
   */
  getUserRoles(user: Member): string[] {
    if (!user) {
      return [];
    }
    
    // Check if roles exist (could be string from backend or array)
    const roles = (user as any).roles;
    
    if (!roles) {
      return [];
    }
    
    // If it's already an array, return it
    if (Array.isArray(roles)) {
      return roles.filter((r: string) => r && r.trim().length > 0);
    }
    
    // If it's a string (comma-separated), parse it
    if (typeof roles === 'string' && roles.trim().length > 0) {
      return roles.split(',').map((r: string) => r.trim()).filter((r: string) => r.length > 0);
    }
    
    return [];
  }

  /**
   * Get badge color class based on role
   * @param role The role name
   * @return Badge color class (bg-danger for admin, bg-success for user, bg-primary for others)
   */
  getRoleTagClass(role: string): string {
    if (!role) {
      return 'role-tag-default';
    }
    
    const roleLower = role.toLowerCase().trim();
    
    // Admin role: red tag
    if (roleLower === 'admin' || roleLower === 'administrator') {
      return 'role-tag-admin';
    }
    
    // User role: green tag
    if (roleLower === 'user') {
      return 'role-tag-user';
    }
    
    // All other roles: blue tag
    return 'role-tag-default';
  }

  getFilteredUsers(): Member[] {
    let filtered = [...this.allUsers];
    
    if (this.searchFilter && this.searchFilter.trim()) {
      const searchTerm = this.searchFilter.toLowerCase().trim();
      filtered = this.allUsers.filter(user => {
        const firstName = (user.firstName || '').toLowerCase();
        const lastName = (user.lastName || '').toLowerCase();
        const userName = (user.userName || '').toLowerCase();
        const email = (user.addressEmail || '').toLowerCase();

        return firstName.includes(searchTerm) ||
               lastName.includes(searchTerm) ||
               userName.includes(searchTerm) ||
               email.includes(searchTerm);
      });
    }
    
    // Sort by name (firstName + lastName)
    return filtered.sort((a, b) => {
      const nameA = ((a.firstName || '') + ' ' + (a.lastName || '')).toLowerCase().trim();
      const nameB = ((b.firstName || '') + ' ' + (b.lastName || '')).toLowerCase().trim();
      return nameA.localeCompare(nameB);
    });
  }

  getFilteredGroups(): FriendGroup[] {
    let filtered = [...this.friendGroups];
    
    if (this.searchFilter && this.searchFilter.trim()) {
      const searchTerm = this.searchFilter.toLowerCase().trim();
      filtered = this.friendGroups.filter(group => {
        const groupName = (group.name || '').toLowerCase();
        const ownerName = group.owner ? 
          ((group.owner.firstName || '') + ' ' + (group.owner.lastName || '') + ' ' + (group.owner.userName || '')).toLowerCase() : '';
        const memberNames = (group.members || [])
          .map(m => `${m.firstName || ''} ${m.lastName || ''} ${m.userName || ''}`)
          .join(' ')
          .toLowerCase();

        return groupName.includes(searchTerm) ||
               ownerName.includes(searchTerm) ||
               memberNames.includes(searchTerm);
      });
    }
    
    // Sort by group name
    return filtered.sort((a, b) => {
      const nameA = (a.name || '').toLowerCase().trim();
      const nameB = (b.name || '').toLowerCase().trim();
      return nameA.localeCompare(nameB);
    });
  }
  
  getSortedPendingRequests(): FriendRequest[] {
    // Sort by requester name (firstName + lastName)
    return [...this.pendingRequests].sort((a, b) => {
      const nameA = ((a.requester.firstName || '') + ' ' + (a.requester.lastName || '')).toLowerCase().trim();
      const nameB = ((b.requester.firstName || '') + ' ' + (b.requester.lastName || '')).toLowerCase().trim();
      return nameA.localeCompare(nameB);
    });
  }
  
  getSortedFriends(): Friend[] {
    // Sort by other user's name (firstName + lastName)
    return [...this.friends].sort((a, b) => {
      const userA = this.getOtherUser(a);
      const userB = this.getOtherUser(b);
      const nameA = ((userA.firstName || '') + ' ' + (userA.lastName || '')).toLowerCase().trim();
      const nameB = ((userB.firstName || '') + ' ' + (userB.lastName || '')).toLowerCase().trim();
      return nameA.localeCompare(nameB);
    });
  }

  getOtherUser(friend: Friend): Member {
    if (friend.user1.id === this.currentUser.id) {
      return friend.user2;
    }
    return friend.user1;
  }

  /**
   * Get friendship origin information for a friend
   * Returns an object with type ('direct' | 'both') and group names if applicable
   * Note: We only show direct friends, so type can only be 'direct' or 'both' (direct + groups)
   */
  /**
   * Get all members from friend groups who are not direct friends
   */
  getGroupMembersNotFriends(): Array<{ member: Member, groups: string[] }> {
    const directFriendIds = new Set(this.friends.map(f => {
      const otherUser = this.getOtherUser(f);
      return otherUser.id;
    }));
    
    const groupMembersMap = new Map<string, { member: Member, groups: string[] }>();
    
    for (const group of this.friendGroups) {
      if (!group || !group.members) continue;
      
      const currentUserInGroup = (group.members && group.members.some(m => m && m.id === this.currentUser.id)) || 
                                 (group.owner && group.owner.id === this.currentUser.id) ||
                                 (group.authorizedUsers && group.authorizedUsers.some(u => u && u.id === this.currentUser.id));
      
      if (!currentUserInGroup) continue;
      
      // Helper function to add a member to the map without duplicates
      const addMemberToMap = (member: Member, groupName: string) => {
        if (!member || member.id === this.currentUser.id || directFriendIds.has(member.id)) {
          return;
        }
        const existing = groupMembersMap.get(member.id);
        if (existing) {
          // Only add if group name is not already in the list
          if (!existing.groups.includes(groupName)) {
            existing.groups.push(groupName);
          }
        } else {
          groupMembersMap.set(member.id, { member: member, groups: [groupName] });
        }
      };
      
      // Add owner if not current user and not a direct friend
      if (group.owner) {
        addMemberToMap(group.owner, group.name);
      }
      
      // Add members if not current user and not a direct friend
      if (group.members) {
        for (const member of group.members) {
          addMemberToMap(member, group.name);
        }
      }
      
      // Add authorized users if not current user and not a direct friend
      if (group.authorizedUsers) {
        for (const authorizedUser of group.authorizedUsers) {
          addMemberToMap(authorizedUser, group.name);
        }
      }
    }
    
    return Array.from(groupMembersMap.values()).sort((a, b) => {
      const nameA = ((a.member.firstName || '') + ' ' + (a.member.lastName || '')).toLowerCase().trim();
      const nameB = ((b.member.firstName || '') + ' ' + (b.member.lastName || '')).toLowerCase().trim();
      return nameA.localeCompare(nameB);
    });
  }

  getFriendshipOrigin(friend: Friend): { type: 'direct' | 'both', groups?: string[] } {
    const otherUserId = this.getOtherUser(friend).id;
    const groups: string[] = [];

    // Check if we're both members of any friend groups
    for (const group of this.friendGroups) {
      if (!group || !group.members) continue;
      
      const currentUserInGroup = (group.members && group.members.some(m => m && m.id === this.currentUser.id)) || 
                                 (group.owner && group.owner.id === this.currentUser.id) ||
                                 (group.authorizedUsers && group.authorizedUsers.some(u => u && u.id === this.currentUser.id));
      const otherUserInGroup = (group.members && group.members.some(m => m && m.id === otherUserId)) || 
                               (group.owner && group.owner.id === otherUserId) ||
                               (group.authorizedUsers && group.authorizedUsers.some(u => u && u.id === otherUserId));
      
      if (currentUserInGroup && otherUserInGroup && group.name) {
        groups.push(group.name);
      }
    }

    // Since we only display direct friends, type can only be 'direct' or 'both'
    if (groups.length > 0) {
      // We have a direct friendship AND groups in common
      return { type: 'both', groups: groups };
    }
    // Only direct friendship (no common groups)
    return { type: 'direct' };
  }

  setActiveTab(tab: 'users' | 'requests' | 'friends' | 'groups' | 'myuser') {
    this.activeTab = tab;
    this.searchFilter = ''; // Clear search when switching tabs
    this.inviteEmail = ''; // Clear invite email
    this.emailCheckResult = null;
    this.emailExists = false;
    this.showCustomMessagePrompt = false;
    this.showCustomMessageInput = false;
    this.customMessage = '';
    // Clear friend request message states
    this.friendRequestMessagePrompts.clear();
    this.friendRequestMessageInputs.clear();
    this.friendRequestMessages.clear();
    // Refresh only the data for the selected tab
    switch(tab) {
      case 'users':
        this.loadAllUsers();
        break;
      case 'requests':
        this.loadPendingRequests();
        break;
      case 'friends':
        this.loadFriends();
        break;
      case 'groups':
        this.loadFriendGroups();
        break;
    }
  }

  checkEmailExists() {
    if (!this.inviteEmail || !this.inviteEmail.trim()) {
      return;
    }

    const email = this.inviteEmail.trim();
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      this.errorMessage = 'Please enter a valid email address';
      return;
    }

    this.checkingEmail = true;
    this.errorMessage = '';
    this.emailCheckResult = null;
    this.emailExists = false;

    this._friendsService.checkEmail(email).subscribe(
      result => {
        this.emailCheckResult = result;
        this.emailExists = result.exists;
        this.checkingEmail = false;
      },
      error => {
        console.error('Error checking email:', error);
        this.errorMessage = 'Error checking email address';
        this.checkingEmail = false;
      }
    );
  }

  sendInvitation() {
    if (!this.inviteEmail || !this.inviteEmail.trim()) {
      return;
    }

    // If we haven't asked about custom message yet, ask first
    if (!this.showCustomMessagePrompt && !this.showCustomMessageInput) {
      this.showCustomMessagePrompt = true;
      return;
    }

    // If user is in custom message input mode but hasn't entered a message, don't proceed
    if (this.showCustomMessageInput && !this.customMessage.trim()) {
      return;
    }

    // Proceed with sending invitation
    const email = this.inviteEmail.trim();
    const message = this.showCustomMessageInput ? (this.customMessage.trim() || undefined) : undefined;
    this.sendingInvite = true;
    this.errorMessage = '';

    this._friendsService.sendInvitation(email, message).subscribe(
      result => {
        this.sendingInvite = false;
        this.inviteEmail = '';
        this.emailCheckResult = null;
        this.emailExists = false;
        this.showCustomMessagePrompt = false;
        this.showCustomMessageInput = false;
        this.customMessage = '';
        alert(this._translateService.instant('FRIENDS.INVITATION_SENT'));
      },
      error => {
        console.error('Error sending invitation:', error);
        if (error.error && error.error.error === 'Email already registered') {
          this.errorMessage = this._translateService.instant('FRIENDS.EMAIL_ALREADY_REGISTERED');
        } else {
          this.errorMessage = this._translateService.instant('FRIENDS.INVITATION_ERROR');
        }
        this.sendingInvite = false;
      }
    );
  }

  confirmAddCustomMessage() {
    this.showCustomMessageInput = true;
    this.showCustomMessagePrompt = false;
  }

  skipCustomMessage() {
    this.showCustomMessageInput = false;
    this.showCustomMessagePrompt = false;
    this.customMessage = '';
    // Proceed with sending invitation without custom message
    const email = this.inviteEmail.trim();
    this.sendingInvite = true;
    this.errorMessage = '';

    this._friendsService.sendInvitation(email).subscribe(
      result => {
        this.sendingInvite = false;
        this.inviteEmail = '';
        this.emailCheckResult = null;
        this.emailExists = false;
        alert(this._translateService.instant('FRIENDS.INVITATION_SENT'));
      },
      error => {
        console.error('Error sending invitation:', error);
        if (error.error && error.error.error === 'Email already registered') {
          this.errorMessage = this._translateService.instant('FRIENDS.EMAIL_ALREADY_REGISTERED');
        } else {
          this.errorMessage = this._translateService.instant('FRIENDS.INVITATION_ERROR');
        }
        this.sendingInvite = false;
      }
    );
  }

  cancelCustomMessage() {
    this.showCustomMessagePrompt = false;
    this.showCustomMessageInput = false;
    this.customMessage = '';
  }

  confirmAddFriendRequestMessage(userId: string) {
    this.friendRequestMessageInputs.set(userId, true);
    this.friendRequestMessagePrompts.set(userId, false);
  }

  skipFriendRequestMessage(userId: string) {
    this.friendRequestMessageInputs.set(userId, false);
    this.friendRequestMessagePrompts.set(userId, false);
    this.friendRequestMessages.delete(userId);
    // Proceed with sending friend request without custom message
    const message = undefined;
    this.loading = true;
    this._friendsService.sendFriendRequest(userId, message).subscribe(
      request => {
        this.loadAllUsers(); // Reload only users
        this.loading = false;
      },
      error => {
        console.error('Error sending friend request:', error);
        this.errorMessage = 'Error sending friend request';
        this.loading = false;
      }
    );
  }

  cancelFriendRequestMessage(userId: string) {
    this.friendRequestMessagePrompts.delete(userId);
    this.friendRequestMessageInputs.delete(userId);
    this.friendRequestMessages.delete(userId);
  }

  getFriendRequestMessage(userId: string): string {
    return this.friendRequestMessages.get(userId) || '';
  }

  setFriendRequestMessage(userId: string, message: string) {
    this.friendRequestMessages.set(userId, message);
  }

  // Friend Groups Management Methods
  loadAllUsers() {
    this.loading = true;
    this.errorMessage = '';
    
    // Load users
    this._friendsService.getAllUsers().subscribe(
      users => {
        // Filter out current user
        this.allUsers = users.filter(u => u.id !== this.currentUser.id);
        this.loading = false;
      },
      error => {
        console.error('Error loading users:', error);
        this.errorMessage = 'Error loading users';
        this.loading = false;
      }
    );
    
    // Also load sent requests to determine user status
    this._friendsService.getSentRequests().subscribe(
      requests => {
        this.sentRequests = requests;
      },
      error => {
        console.error('Error loading sent requests:', error);
      }
    );
    
    // Also load pending requests to determine user status
    this._friendsService.getPendingRequests().subscribe(
      requests => {
        this.pendingRequests = requests;
      },
      error => {
        console.error('Error loading pending requests:', error);
      }
    );
    
    // Also load friends to determine user status
    this._friendsService.getFriends().subscribe(
      friends => {
        this.friends = friends;
      },
      error => {
        console.error('Error loading friends:', error);
      }
    );
  }

  loadPendingRequests() {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.getPendingRequests().subscribe(
      requests => {
        this.pendingRequests = requests;
        this.loading = false;
      },
      error => {
        console.error('Error loading pending requests:', error);
        this.errorMessage = 'Error loading pending requests';
        this.loading = false;
      }
    );
  }

  loadFriends() {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.getFriends().subscribe(
      friends => {
        this.friends = friends;
        // Load statuses for all friends
        this.loadFriendStatuses();
        this.loading = false;
      },
      error => {
        console.error('Error loading friends:', error);
        this.errorMessage = 'Error loading friends';
        this.loading = false;
      }
    );
  }

  /**
   * Load status for all users (in All Users tab)
   */
  loadUserStatuses() {
    this.allUsers.forEach(user => {
      if (user && user.id) {
        // Initialize with offline status immediately so it shows up right away
        if (!this.userStatuses.has(user.id)) {
          this.userStatuses.set(user.id, { online: false, status: 'offline' });
        }
        
        this._friendsService.getUserStatus(user.id).subscribe(
          status => {
            this.userStatuses.set(user.id, status);
            // Trigger change detection to update the UI
            this.cdr.detectChanges();
          },
          error => {
            // Set default status on error
            this.userStatuses.set(user.id, { online: false, status: 'offline' });
            // Trigger change detection to update the UI
            this.cdr.detectChanges();
          }
        );
      }
    });
    // Trigger change detection after initializing all statuses
    this.cdr.detectChanges();
  }

  /**
   * Load status for all friends
   */
  loadFriendStatuses() {
    this.friends.forEach(friend => {
      const otherUser = this.getOtherUser(friend);
      if (otherUser && otherUser.id) {
        // Initialize with offline status immediately so it shows up right away
        if (!this.userStatuses.has(otherUser.id)) {
          this.userStatuses.set(otherUser.id, { online: false, status: 'offline' });
        }
        
        this._friendsService.getUserStatus(otherUser.id).subscribe(
          status => {
            this.userStatuses.set(otherUser.id, status);
            // Trigger change detection to update the UI
            this.cdr.detectChanges();
          },
          error => {
            // Set default status on error
            this.userStatuses.set(otherUser.id, { online: false, status: 'offline' });
            // Trigger change detection to update the UI
            this.cdr.detectChanges();
          }
        );
      }
    });
    // Trigger change detection after initializing all statuses
    this.cdr.detectChanges();
  }

  /**
   * Get user online status from Keycloak
   */
  getUserOnlineStatus(userId: string): { online: boolean; status: string } {
    if (!userId) {
      return { online: false, status: 'offline' };
    }
    const status = this.userStatuses.get(userId) || { online: false, status: 'offline' };
    return status;
  }

  loadFriendGroups() {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.getFriendGroups().subscribe(
      groups => {
        this.friendGroups = groups;
        this.loading = false;
      },
      error => {
        console.error('Error loading friend groups:', error);
        this.errorMessage = 'Error loading friend groups';
        this.loading = false;
      }
    );
  }

  startCreatingGroup() {
    this.isCreatingGroup = true;
    this.newGroupName = '';
    this.selectedGroupMembers = [];
  }

  cancelCreatingGroup() {
    this.isCreatingGroup = false;
    this.newGroupName = '';
    this.selectedGroupMembers = [];
  }

  toggleGroupMember(friendId: string) {
    const index = this.selectedGroupMembers.indexOf(friendId);
    if (index > -1) {
      this.selectedGroupMembers.splice(index, 1);
    } else {
      this.selectedGroupMembers.push(friendId);
    }
  }

  isMemberSelected(friendId: string): boolean {
    return this.selectedGroupMembers.includes(friendId);
  }

  createFriendGroup() {
    if (!this.newGroupName || !this.newGroupName.trim()) {
      this.errorMessage = 'Please enter a group name';
      return;
    }

    if (this.selectedGroupMembers.length === 0) {
      this.errorMessage = 'Please select at least one friend';
      return;
    }

    this.loading = true;
    this.errorMessage = '';
    this._friendsService.createFriendGroup(this.newGroupName.trim(), this.selectedGroupMembers).subscribe(
      group => {
        this.loadFriendGroups();
        this.cancelCreatingGroup();
        this.loading = false;
      },
      error => {
        console.error('Error creating friend group:', error);
        this.errorMessage = 'Error creating friend group';
        this.loading = false;
      }
    );
  }

  startEditingGroup(group: FriendGroup) {
    this.editingGroupId = group.id;
    this.editingGroupName = group.name;
    this.editingGroupMembers = group.members.map(m => m.id);
    this.editingGroupWhatsappLink = group.whatsappLink || '';
  }

  cancelEditingGroup() {
    this.editingGroupId = null;
    this.editingGroupName = '';
    this.editingGroupMembers = [];
    this.editingGroupWhatsappLink = '';
  }

  toggleEditingGroupMember(friendId: string) {
    const index = this.editingGroupMembers.indexOf(friendId);
    if (index > -1) {
      this.editingGroupMembers.splice(index, 1);
    } else {
      this.editingGroupMembers.push(friendId);
    }
  }

  isEditingMemberSelected(friendId: string): boolean {
    return this.editingGroupMembers.includes(friendId);
  }

  updateFriendGroup() {
    if (!this.editingGroupId) return;

    if (!this.editingGroupName || !this.editingGroupName.trim()) {
      this.errorMessage = 'Please enter a group name';
      return;
    }

    if (this.editingGroupMembers.length === 0) {
      this.errorMessage = 'Please select at least one friend';
      return;
    }

    this.loading = true;
    this.errorMessage = '';
    this._friendsService.updateFriendGroup(
      this.editingGroupId,
      this.editingGroupName.trim(),
      this.editingGroupMembers,
      undefined, // discussionId - preserve existing
      this.editingGroupWhatsappLink.trim() || undefined // whatsappLink
    ).subscribe(
      group => {
        this.loadFriendGroups();
        this.cancelEditingGroup();
        this.loading = false;
      },
      error => {
        console.error('Error updating friend group:', error);
        this.errorMessage = 'Error updating friend group';
        this.loading = false;
      }
    );
  }

  deleteFriendGroup(groupId: string) {
    if (confirm('Are you sure you want to delete this friend group?')) {
      this.loading = true;
      this._friendsService.deleteFriendGroup(groupId).subscribe(
        () => {
          this.loadFriendGroups();
          this.loading = false;
        },
        error => {
          console.error('Error deleting friend group:', error);
          this.errorMessage = 'Error deleting friend group';
          this.loading = false;
        }
      );
    }
  }

  getFriendById(friendId: string): Member | null {
    for (const friend of this.friends) {
      if (friend.user1.id === friendId && friend.user1.id !== this.currentUser.id) {
        return friend.user1;
      }
      if (friend.user2.id === friendId && friend.user2.id !== this.currentUser.id) {
        return friend.user2;
      }
    }
    return null;
  }

  getGroupMemberNames(group: FriendGroup): string {
    return group.members.map(m => `${m.firstName} ${m.lastName}`).join(', ');
  }

  // Check if current user is the owner of a group
  isGroupOwner(group: FriendGroup): boolean {
    return group.owner && group.owner.id === this.currentUser.id;
  }

  // Check if current user is authorized (but not owner)
  isGroupAuthorized(group: FriendGroup): boolean {
    if (this.isGroupOwner(group)) {
      return false;
    }
    return !!(group.authorizedUsers && group.authorizedUsers.some(u => u.id === this.currentUser.id));
  }

  // Check if current user is a member (but not owner and not authorized)
  isGroupMember(group: FriendGroup): boolean {
    if (this.isGroupOwner(group) || this.isGroupAuthorized(group)) {
      return false;
    }
    return !!(group.members && group.members.some(m => m.id === this.currentUser.id));
  }

  // Start managing authorized users for a group
  startManagingAuthorizedUsers(group: FriendGroup) {
    if (!this.isGroupOwner(group)) {
      return;
    }
    this.managingAuthorizedUsersGroupId = group.id;
    this.selectedAuthorizedUsers = (group.authorizedUsers || []).map(u => u.id);
  }

  // Cancel managing authorized users
  cancelManagingAuthorizedUsers() {
    this.managingAuthorizedUsersGroupId = null;
    this.selectedAuthorizedUsers = [];
  }

  // Open discussion modal for a friend group
  openDiscussionModal(group: FriendGroup, discussionId?: string) {
    try {
      // Get or create discussion for this friend group
      const groupDiscussionId = group.discussionId || discussionId;
      const discussionTitle = 'Discussion - ' + group.name;
      
      // Get or create the discussion
      this._discussionService.getOrCreateDiscussion(groupDiscussionId, discussionTitle).subscribe({
        next: (discussion) => {
          try {
            // Update the group's discussionId if:
            // 1. The group doesn't have a discussionId yet (first time creation), OR
            // 2. The discussion ID is different from what we tried to get (meaning a new one was created because the old one didn't exist - 404 case)
            // This condition handles both scenarios:
            // - First time: group.discussionId is null/undefined, discussion.id is new ID → condition is true
            // - Replacement: group.discussionId is old invalid ID, discussion.id is new ID → condition is true
            // Open modal FIRST, then update group in background
            // This ensures the modal opens immediately even if update fails
            this.openDiscussionModalInternal(discussion, discussionTitle);
            
            // Update the group's discussionId if needed (do this in background)
            if (discussion.id && (group.discussionId !== discussion.id)) {
              const oldDiscussionId = group.discussionId;
              group.discussionId = discussion.id;
              
              // Safely map members to IDs, filtering out any invalid members
              const memberIds = (group.members || [])
                .filter(m => m && m.id)
                .map(m => m.id);
              
              if (!group.id) {
                return;
              }
              
              // Update the group in the backend (in background, don't block modal)
              // Note: We only update the discussionId, so we pass the existing members
              // The backend will automatically add the owner if not present
              this._friendsService.updateFriendGroup(
                group.id,
                group.name || '',
                memberIds,
                discussion.id,
                group.whatsappLink // preserve whatsappLink
              ).subscribe({
                next: (updatedGroup) => {
              // Update the local group object with the fetched data
              // This ensures the cache in the component is synchronized with the backend
              const groupIndex = this.friendGroups.findIndex(g => g.id === group.id);
              
              if (groupIndex !== -1) {
                // Replace the entire group object in the array to ensure all properties are updated
                // Create a new array reference to trigger Angular change detection
                this.friendGroups = [
                  ...this.friendGroups.slice(0, groupIndex),
                  updatedGroup,
                  ...this.friendGroups.slice(groupIndex + 1)
                ];
                // Also update the passed group object reference
                group.id = updatedGroup.id;
                group.name = updatedGroup.name;
                group.members = updatedGroup.members;
                group.owner = updatedGroup.owner;
                group.creationDate = updatedGroup.creationDate;
                group.authorizedUsers = updatedGroup.authorizedUsers;
                group.discussionId = updatedGroup.discussionId;
              } else {
                // If group not found in array, update the passed group object directly
                group.id = updatedGroup.id;
                group.name = updatedGroup.name;
                group.members = updatedGroup.members;
                group.owner = updatedGroup.owner;
                group.creationDate = updatedGroup.creationDate;
                group.authorizedUsers = updatedGroup.authorizedUsers;
                group.discussionId = updatedGroup.discussionId;
              }
              
              // As an additional safeguard, reload the specific group from backend to ensure cache is fully synchronized
              if (group.id) {
                this._friendsService.getFriendGroup(group.id).subscribe({
                  next: (reloadedGroup) => {
                    const reloadedIndex = this.friendGroups.findIndex(g => g.id === group.id);
                    if (reloadedIndex !== -1) {
                      // Create a new array reference to trigger Angular change detection
                      this.friendGroups = [
                        ...this.friendGroups.slice(0, reloadedIndex),
                        reloadedGroup,
                        ...this.friendGroups.slice(reloadedIndex + 1)
                      ];
                      // Update the passed group object
                      group.id = reloadedGroup.id;
                      group.name = reloadedGroup.name;
                      group.members = reloadedGroup.members;
                      group.owner = reloadedGroup.owner;
                      group.creationDate = reloadedGroup.creationDate;
                      group.authorizedUsers = reloadedGroup.authorizedUsers;
                      group.discussionId = reloadedGroup.discussionId;
                    }
                  },
                  error: (error) => {
                    // Silent error handling
                  }
                });
              }
                },
                error: (error) => {
                  // Revert the local change if save failed
                  group.discussionId = oldDiscussionId || undefined;
                }
              });
            }
            // If no update needed, modal was already opened above
          } catch (error) {
            // Still try to open modal with the discussion
            this.openDiscussionModalInternal(discussion, discussionTitle);
          }
        },
        error: (error) => {
          // Still open modal with null discussionId (will load default)
          this.openDiscussionModalInternal(null, discussionTitle);
        }
      });
    } catch (error) {
      // Try to open modal anyway
      const discussionTitle = 'Discussion - ' + (group?.name || 'Groupe');
      this.openDiscussionModalInternal(null, discussionTitle);
    }
  }

  // Helper method to open discussion modal (prevents code duplication and ensures modal always opens)
  private openDiscussionModalInternal(discussion: any, title: string) {
    try {
      const modalRef = this.modalService.open(DiscussionModalComponent, { 
        size: 'lg', 
        centered: true, 
        backdrop: 'static', 
        keyboard: true,
        windowClass: 'discussion-modal-window'
      });
      
      modalRef.componentInstance.discussionId = discussion?.id || null;
      modalRef.componentInstance.title = title;
    } catch (error) {
      // Silent error handling
    }
  }

  // Toggle authorized user selection
  toggleAuthorizedUser(friendId: string) {
    const index = this.selectedAuthorizedUsers.indexOf(friendId);
    if (index > -1) {
      this.selectedAuthorizedUsers.splice(index, 1);
    } else {
      this.selectedAuthorizedUsers.push(friendId);
    }
  }

  // Check if friend is selected as authorized user
  isAuthorizedUserSelected(friendId: string): boolean {
    return this.selectedAuthorizedUsers.includes(friendId);
  }

  // Check if user is already authorized
  isUserAuthorized(group: FriendGroup, userId: string): boolean {
    return !!(group.authorizedUsers && group.authorizedUsers.some(u => u.id === userId));
  }

  // Save authorized users
  saveAuthorizedUsers() {
    if (!this.managingAuthorizedUsersGroupId) {
      return;
    }

    const group = this.friendGroups.find(g => g.id === this.managingAuthorizedUsersGroupId);
    if (!group || !this.isGroupOwner(group)) {
      return;
    }

    // Get currently authorized users
    const currentAuthorizedUserIds = (group.authorizedUsers || []).map(u => u.id);
    
    // Find users to add (in selected but not in current)
    const usersToAdd = this.selectedAuthorizedUsers.filter(id => !currentAuthorizedUserIds.includes(id));
    
    // Find users to remove (in current but not in selected)
    const usersToRemove = currentAuthorizedUserIds.filter(id => !this.selectedAuthorizedUsers.includes(id));

    this.loading = true;
    this.errorMessage = '';

    // Process all changes
    const operations: Promise<any>[] = [];
    
    usersToAdd.forEach(userId => {
      operations.push(
        this._friendsService.authorizeUserForGroup(this.managingAuthorizedUsersGroupId!, userId).toPromise()
      );
    });
    
    usersToRemove.forEach(userId => {
      operations.push(
        this._friendsService.unauthorizeUserForGroup(this.managingAuthorizedUsersGroupId!, userId).toPromise()
      );
    });

    Promise.all(operations).then(() => {
      this.loadFriendGroups();
      this.cancelManagingAuthorizedUsers();
      this.loading = false;
    }).catch(error => {
      console.error('Error managing authorized users:', error);
      this.errorMessage = 'Error managing authorized users';
      this.loading = false;
    });
  }

  // Authorize a single user
  authorizeUser(groupId: string, userId: string) {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.authorizeUserForGroup(groupId, userId).subscribe(
      () => {
        this.loadFriendGroups();
        this.loading = false;
      },
      error => {
        console.error('Error authorizing user:', error);
        this.errorMessage = 'Error authorizing user';
        this.loading = false;
      }
    );
  }

  // Unauthorize a single user
  unauthorizeUser(groupId: string, userId: string) {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.unauthorizeUserForGroup(groupId, userId).subscribe(
      () => {
        this.loadFriendGroups();
        this.loading = false;
      },
      error => {
        console.error('Error unauthorizing user:', error);
        this.errorMessage = 'Error unauthorizing user';
        this.loading = false;
      }
    );
  }

  /**
   * Check if current user has admin role
   * @returns true if user has Admin role, false otherwise
   */
  public hasAdminRole(): boolean {
    return this._keycloakService.hasAdminRole();
  }

  /**
   * Open WhatsApp link (for friend groups or individual friends)
   */
  public openWhatsAppLink(urlOrGroup: string | FriendGroup): void {
    let url: string | null = null;
    if (typeof urlOrGroup === 'string') {
      url = urlOrGroup;
    } else if (urlOrGroup && urlOrGroup.whatsappLink) {
      url = urlOrGroup.whatsappLink;
    }
    
    if (url && url.trim().length > 0) {
      window.open(url, '_blank');
    }
  }

  /**
   * Check if group has a WhatsApp link
   */
  public hasWhatsAppLink(group: FriendGroup): boolean {
    return !!(group.whatsappLink && group.whatsappLink.trim().length > 0);
  }


  /**
   * Start editing WhatsApp link for a friend (for a specific user: user1 or user2)
   */
  startEditingWhatsappLink(friendId: string, userType: 'user1' | 'user2') {
    const friend = this.friends.find(f => f.id === friendId);
    if (friend) {
      // Extract phone number from WhatsApp link if it exists
      let phoneNumber = '';
      const member = userType === 'user1' ? friend.user1 : friend.user2;
      const whatsappLink = member?.whatsappLink;
      if (whatsappLink) {
        // Extract number from https://wa.me/XXXXXXXXXX format
        const match = whatsappLink.match(/wa\.me\/([0-9]+)/);
        if (match && match[1]) {
          phoneNumber = match[1];
        } else {
          // If it's already just a number, use it
          phoneNumber = whatsappLink.replace(/[^0-9]/g, '');
        }
      }
      this.whatsappLinks[friendId] = phoneNumber;
      this.editingWhatsappLinks.set(friendId, userType);
    }
  }

  /**
   * Cancel editing WhatsApp link
   */
  cancelEditingWhatsappLink(friendId: string) {
    this.editingWhatsappLinks.delete(friendId);
    delete this.whatsappLinks[friendId];
  }

  /**
   * Check if editing WhatsApp link for a specific user
   */
  isEditingWhatsappLink(friendId: string, userType: 'user1' | 'user2'): boolean {
    return this.editingWhatsappLinks.get(friendId) === userType;
  }

  /**
   * Validate phone number (only digits)
   */
  isValidPhoneNumber(phoneNumber: string | undefined): boolean {
    if (!phoneNumber || phoneNumber.trim().length === 0) {
      return false;
    }
    // Only digits allowed
    return /^[0-9]+$/.test(phoneNumber.trim());
  }

  /**
   * Handle keypress to allow only numbers
   */
  onPhoneNumberKeyPress(event: KeyboardEvent): boolean {
    const char = String.fromCharCode(event.which || event.keyCode);
    // Allow only digits
    if (!/[0-9]/.test(char)) {
      event.preventDefault();
      return false;
    }
    return true;
  }

  /**
   * Save WhatsApp link for a friend (for the specified user type)
   */
  saveWhatsappLink(friendId: string) {
    const friend = this.friends.find(f => f.id === friendId);
    if (!friend) return;

    const editingUserType = this.editingWhatsappLinks.get(friendId);
    if (!editingUserType) return;

    // Verify that the current user is only updating their own WhatsApp link
    const isUser1 = friend.user1.id === this.currentUser.id;
    const isUser2 = friend.user2.id === this.currentUser.id;
    
    if (!isUser1 && !isUser2) {
      this.errorMessage = this._translateService.instant('FRIENDS.UNAUTHORIZED_WHATSAPP_UPDATE');
      return;
    }
    
    // Verify that the user is editing their own link
    if ((editingUserType === 'user1' && !isUser1) || (editingUserType === 'user2' && !isUser2)) {
      this.errorMessage = this._translateService.instant('FRIENDS.UNAUTHORIZED_WHATSAPP_UPDATE');
      return;
    }

    let phoneNumber = (this.whatsappLinks[friendId] || '').trim();
    
    // Remove leading "00" if present
    if (phoneNumber.startsWith('00')) {
      phoneNumber = phoneNumber.substring(2);
    }
    
    // Validate phone number
    if (!this.isValidPhoneNumber(phoneNumber)) {
      this.errorMessage = this._translateService.instant('FRIENDS.INVALID_PHONE_NUMBER');
      return;
    }
    
    // Get the member ID to update
    const memberId = editingUserType === 'user1' ? friend.user1.id : friend.user2.id;

    // Build WhatsApp link with https://wa.me/ prefix
    const whatsappLink = `https://wa.me/${phoneNumber}`;
    
    this.loading = true;
    this._friendsService.updateMemberWhatsappLink(memberId, whatsappLink).subscribe(
      (updatedMember) => {
        // Update the member in the friend object
        const index = this.friends.findIndex(f => f.id === friendId);
        if (index !== -1) {
          if (editingUserType === 'user1') {
            this.friends[index].user1 = updatedMember;
          } else {
            this.friends[index].user2 = updatedMember;
          }
        }
        this.cancelEditingWhatsappLink(friendId);
        this.loading = false;
        this.errorMessage = '';
      },
      error => {
        console.error('Error updating WhatsApp link:', error);
        this.errorMessage = this._translateService.instant('FRIENDS.WHATSAPP_UPDATE_ERROR');
        this.loading = false;
      }
    );
  }

  /**
   * Get WhatsApp link for a specific user in a friendship
   */
  getWhatsappLink(friend: Friend, userType: 'user1' | 'user2'): string | undefined {
    const member = userType === 'user1' ? friend.user1 : friend.user2;
    return member?.whatsappLink;
  }

  /**
   * Check if current user is user1 or user2 in a friendship
   */
  getCurrentUserType(friend: Friend): 'user1' | 'user2' | null {
    if (friend.user1.id === this.currentUser.id) return 'user1';
    if (friend.user2.id === this.currentUser.id) return 'user2';
    return null;
  }

  /**
   * Start editing WhatsApp link for current user
   */
  startEditingMyWhatsappLink() {
    // Extract phone number from WhatsApp link if it exists
    let phoneNumber = '';
    if (this.currentUser.whatsappLink) {
      // Extract number from https://wa.me/XXXXXXXXXX format
      const match = this.currentUser.whatsappLink.match(/wa\.me\/([0-9]+)/);
      if (match && match[1]) {
        phoneNumber = match[1];
      } else {
        // If it's already just a number, use it
        phoneNumber = this.currentUser.whatsappLink.replace(/[^0-9]/g, '');
      }
    }
    this.myWhatsappLink = phoneNumber;
    this.editingMyWhatsappLink = true;
  }

  /**
   * Cancel editing WhatsApp link for current user
   */
  cancelEditingMyWhatsappLink() {
    this.editingMyWhatsappLink = false;
    this.myWhatsappLink = '';
  }

  /**
   * Save WhatsApp link for current user
   */
  saveMyWhatsappLink() {
    if (!this.currentUser || !this.currentUser.id) {
      this.errorMessage = this._translateService.instant('FRIENDS.ERROR_USER_NOT_LOADED');
      return;
    }
    
    let phoneNumber = (this.myWhatsappLink || '').trim();
    
    // Remove leading "00" if present
    if (phoneNumber.startsWith('00')) {
      phoneNumber = phoneNumber.substring(2);
    }
    
    // Validate phone number
    if (!this.isValidPhoneNumber(phoneNumber)) {
      this.errorMessage = this._translateService.instant('FRIENDS.INVALID_PHONE_NUMBER');
      return;
    }
    
    // Build WhatsApp link with https://wa.me/ prefix
    const whatsappLink = `https://wa.me/${phoneNumber}`;
    
    this.loading = true;
    this._friendsService.updateMemberWhatsappLink(this.currentUser.id, whatsappLink).subscribe(
      (updatedMember) => {
        // Update the current user
        this.currentUser = updatedMember;
        // Also update the user in the MembersService
        this._memberService.setUser(updatedMember);
        // Force change detection to update the view
        this.cdr.detectChanges();
        this.cancelEditingMyWhatsappLink();
        this.loading = false;
        this.errorMessage = '';
      },
      error => {
        console.error('Error updating WhatsApp link:', error);
        this.errorMessage = this._translateService.instant('FRIENDS.WHATSAPP_UPDATE_ERROR');
        this.loading = false;
      }
    );
  }

  /**
   * Extract phone number from WhatsApp link
   */
  getPhoneNumberFromLink(whatsappLink: string): string {
    if (!whatsappLink) return '';
    // Extract number from https://wa.me/XXXXXXXXXX format
    const match = whatsappLink.match(/wa\.me\/([0-9]+)/);
    if (match && match[1]) {
      return match[1];
    }
    // If it's already just a number, return it
    return whatsappLink.replace(/[^0-9]/g, '');
  }
}

