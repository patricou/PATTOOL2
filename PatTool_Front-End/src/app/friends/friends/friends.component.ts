import { Component, OnInit, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbDropdown, NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Member } from '../../model/member';
import { FriendRequest, FriendRequestStatus, Friend, FriendGroup } from '../../model/friend';
import { FriendsService } from '../../services/friends.service';
import { MembersService } from '../../services/members.service';
import { DiscussionModalComponent } from '../../communications/discussion-modal/discussion-modal.component';
import { DiscussionService } from '../../services/discussion.service';
import { KeycloakService } from '../../keycloak/keycloak.service';
import { NavigationButtonsModule } from '../../shared/navigation-buttons/navigation-buttons.module';

@Component({
  selector: 'app-friends',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgbModule,
    TranslateModule,
    DiscussionModalComponent,
    NavigationButtonsModule
  ],
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
  public activeTab: 'users' | 'requests' | 'friends' | 'groups' | 'myuser' = 'users';
  public selectedFriendIndex: number | null = null;
  public sortOption: 'dateCreation' | 'firstName' | 'lastName' | 'lastConnection' = 'dateCreation';
  public sortOptionFriends: 'dateCreation' | 'firstName' | 'lastName' = 'dateCreation';
  
  // WhatsApp link editing for current user
  public editingMyWhatsappLink: boolean = false;
  public myWhatsappLink: string = '';
  public selectedCountryCode: string = '+33'; // Default to France
  public loading: boolean = false;
  
  // Country codes with flags (using flag-icons library like in language menu)
  public countryCodes: Array<{code: string, flag: string, name: string}> = [
    {code: '+33', flag: 'fr', name: 'France'},
    {code: '+1', flag: 'us', name: 'USA/Canada'},
    {code: '+44', flag: 'gb', name: 'UK'},
    {code: '+49', flag: 'de', name: 'Germany'},
    {code: '+39', flag: 'it', name: 'Italy'},
    {code: '+34', flag: 'es', name: 'Spain'},
    {code: '+32', flag: 'be', name: 'Belgium'},
    {code: '+41', flag: 'ch', name: 'Switzerland'},
    {code: '+31', flag: 'nl', name: 'Netherlands'},
    {code: '+351', flag: 'pt', name: 'Portugal'},
    {code: '+212', flag: 'ma', name: 'Morocco'},
    {code: '+213', flag: 'dz', name: 'Algeria'},
    {code: '+216', flag: 'tn', name: 'Tunisia'},
    {code: '+221', flag: 'sn', name: 'Senegal'},
    {code: '+225', flag: 'ci', name: 'Ivory Coast'},
    {code: '+229', flag: 'bj', name: 'Benin'},
    {code: '+226', flag: 'bf', name: 'Burkina Faso'},
    {code: '+227', flag: 'ne', name: 'Niger'},
    {code: '+228', flag: 'tg', name: 'Togo'},
    {code: '+230', flag: 'mu', name: 'Mauritius'},
    {code: '+242', flag: 'cg', name: 'Congo'},
    {code: '+243', flag: 'cd', name: 'DRC'},
    {code: '+237', flag: 'cm', name: 'Cameroon'},
    {code: '+235', flag: 'td', name: 'Chad'},
    {code: '+236', flag: 'cf', name: 'CAR'},
    {code: '+240', flag: 'gq', name: 'Equatorial Guinea'},
    {code: '+241', flag: 'ga', name: 'Gabon'},
    {code: '+250', flag: 'rw', name: 'Rwanda'},
    {code: '+251', flag: 'et', name: 'Ethiopia'},
    {code: '+254', flag: 'ke', name: 'Kenya'},
    {code: '+255', flag: 'tz', name: 'Tanzania'},
    {code: '+256', flag: 'ug', name: 'Uganda'},
    {code: '+257', flag: 'bi', name: 'Burundi'},
    {code: '+258', flag: 'mz', name: 'Mozambique'},
    {code: '+260', flag: 'zm', name: 'Zambia'},
    {code: '+261', flag: 'mg', name: 'Madagascar'},
    {code: '+262', flag: 're', name: 'Réunion'},
    {code: '+269', flag: 'km', name: 'Comoros'},
    {code: '+7', flag: 'ru', name: 'Russia'},
    {code: '+86', flag: 'cn', name: 'China'},
    {code: '+81', flag: 'jp', name: 'Japan'},
    {code: '+82', flag: 'kr', name: 'South Korea'},
    {code: '+91', flag: 'in', name: 'India'},
    {code: '+61', flag: 'au', name: 'Australia'},
    {code: '+64', flag: 'nz', name: 'New Zealand'},
    {code: '+55', flag: 'br', name: 'Brazil'},
    {code: '+52', flag: 'mx', name: 'Mexico'},
    {code: '+54', flag: 'ar', name: 'Argentina'},
    {code: '+56', flag: 'cl', name: 'Chile'},
    {code: '+57', flag: 'co', name: 'Colombia'},
    {code: '+51', flag: 'pe', name: 'Peru'},
    {code: '+20', flag: 'eg', name: 'Egypt'},
    {code: '+27', flag: 'za', name: 'South Africa'},
    {code: '+90', flag: 'tr', name: 'Turkey'},
    {code: '+966', flag: 'sa', name: 'Saudi Arabia'},
    {code: '+971', flag: 'ae', name: 'UAE'},
    {code: '+972', flag: 'il', name: 'Israel'},
    {code: '+961', flag: 'lb', name: 'Lebanon'},
    {code: '+962', flag: 'jo', name: 'Jordan'},
    {code: '+974', flag: 'qa', name: 'Qatar'},
    {code: '+965', flag: 'kw', name: 'Kuwait'},
    {code: '+973', flag: 'bh', name: 'Bahrain'},
    {code: '+968', flag: 'om', name: 'Oman'},
    {code: '+60', flag: 'my', name: 'Malaysia'},
    {code: '+65', flag: 'sg', name: 'Singapore'},
    {code: '+66', flag: 'th', name: 'Thailand'},
    {code: '+62', flag: 'id', name: 'Indonesia'},
    {code: '+63', flag: 'ph', name: 'Philippines'},
    {code: '+84', flag: 'vn', name: 'Vietnam'},
    {code: '+880', flag: 'bd', name: 'Bangladesh'},
    {code: '+92', flag: 'pk', name: 'Pakistan'},
    {code: '+94', flag: 'lk', name: 'Sri Lanka'},
    {code: '+95', flag: 'mm', name: 'Myanmar'},
    {code: '+353', flag: 'ie', name: 'Ireland'},
    {code: '+46', flag: 'se', name: 'Sweden'},
    {code: '+47', flag: 'no', name: 'Norway'},
    {code: '+45', flag: 'dk', name: 'Denmark'},
    {code: '+358', flag: 'fi', name: 'Finland'},
    {code: '+48', flag: 'pl', name: 'Poland'},
    {code: '+420', flag: 'cz', name: 'Czech Republic'},
    {code: '+36', flag: 'hu', name: 'Hungary'},
    {code: '+40', flag: 'ro', name: 'Romania'},
    {code: '+30', flag: 'gr', name: 'Greece'},
    {code: '+380', flag: 'ua', name: 'Ukraine'},
    {code: '+7', flag: 'kz', name: 'Kazakhstan'},
  ];
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
  
  // Admin user selection and update
  public selectedUserForUpdate: Member | null = null;
  public editingSelectedUser: boolean = false;
  public selectedUserWhatsappLink: string = '';
  public selectedUserCountryCode: string = '+33'; // Default to France
  public availableLocales: string[] = ['ar', 'cn', 'de', 'el', 'en', 'es', 'fr', 'he', 'it', 'jp', 'ru'];
  public selectedUserFriends: Friend[] = []; // Friends of the selected user (for admin view)
  public adminModeCollapsed: boolean = true; // Admin mode section collapsed by default
  // Store original values to prevent overwriting with admin values
  private originalSelectedUserRoles: string[] = [];
  private originalSelectedUserKeycloakId: string = '';
  private originalSelectedUserRegistrationDate: Date | undefined = undefined;
  private originalSelectedUserLastConnectionDate: Date | undefined = undefined;

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
      // Initialize country code from existing WhatsApp link
      this.initializeCountryCodeFromLink();
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
    
    // If it's already an array, return it (filter out uma_authorization and empty roles)
    if (Array.isArray(roles)) {
      return roles.filter((r: string) => {
        if (!r || r.trim().length === 0) return false;
        const roleLower = r.toLowerCase().trim();
        // Filter out uma_authorization and um_authorization
        return roleLower !== 'uma_authorization' && roleLower !== 'um_authorization';
      });
    }
    
    // If it's a string (comma-separated), parse it (filter out uma_authorization and um_authorization)
    if (typeof roles === 'string' && roles.trim().length > 0) {
      return roles.split(',').map((r: string) => r.trim()).filter((r: string) => {
        if (r.length === 0) return false;
        const roleLower = r.toLowerCase().trim();
        // Filter out uma_authorization and um_authorization
        return roleLower !== 'uma_authorization' && roleLower !== 'um_authorization';
      });
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
    
    // Sort according to selected option
    return filtered.sort((a, b) => {
      switch (this.sortOption) {
        case 'dateCreation': {
          // Sort by registration date (newest first), then by last name if date is not available
          if (a.registrationDate && b.registrationDate) {
            const dateA = new Date(a.registrationDate).getTime();
            const dateB = new Date(b.registrationDate).getTime();
            if (dateA !== dateB) {
              return dateB - dateA; // Newest first
            }
          } else if (a.registrationDate) {
            return -1; // a has date, b doesn't - a comes first
          } else if (b.registrationDate) {
            return 1; // b has date, a doesn't - b comes first
          }
          // If neither has date, fall through to last name sort
          const lastNameA = (a.lastName || '').toLowerCase().trim();
          const lastNameB = (b.lastName || '').toLowerCase().trim();
          if (lastNameA !== lastNameB) {
            return lastNameA.localeCompare(lastNameB);
          }
          // If last names are equal, sort by first name
          const firstNameA = (a.firstName || '').toLowerCase().trim();
          const firstNameB = (b.firstName || '').toLowerCase().trim();
          return firstNameA.localeCompare(firstNameB);
        }
          
        case 'firstName': {
          // Sort by first name
          const firstNameA = (a.firstName || '').toLowerCase().trim();
          const firstNameB = (b.firstName || '').toLowerCase().trim();
          if (firstNameA !== firstNameB) {
            return firstNameA.localeCompare(firstNameB);
          }
          // If first names are equal, sort by last name
          const lastNameA = (a.lastName || '').toLowerCase().trim();
          const lastNameB = (b.lastName || '').toLowerCase().trim();
          return lastNameA.localeCompare(lastNameB);
        }
          
        case 'lastName': {
          // Sort by last name
          const lastNameA = (a.lastName || '').toLowerCase().trim();
          const lastNameB = (b.lastName || '').toLowerCase().trim();
          if (lastNameA !== lastNameB) {
            return lastNameA.localeCompare(lastNameB);
          }
          // If last names are equal, sort by first name
          const firstNameA = (a.firstName || '').toLowerCase().trim();
          const firstNameB = (b.firstName || '').toLowerCase().trim();
          return firstNameA.localeCompare(firstNameB);
        }
          
        case 'lastConnection': {
          // Sort by last connection date (most recent first), then by last name if date is not available
          if (a.lastConnectionDate && b.lastConnectionDate) {
            const dateA = new Date(a.lastConnectionDate).getTime();
            const dateB = new Date(b.lastConnectionDate).getTime();
            if (dateA !== dateB) {
              return dateB - dateA; // Most recent first
            }
          } else if (a.lastConnectionDate) {
            return -1; // a has date, b doesn't - a comes first
          } else if (b.lastConnectionDate) {
            return 1; // b has date, a doesn't - b comes first
          }
          // If neither has date, fall through to last name sort
          const lastNameA = (a.lastName || '').toLowerCase().trim();
          const lastNameB = (b.lastName || '').toLowerCase().trim();
          if (lastNameA !== lastNameB) {
            return lastNameA.localeCompare(lastNameB);
          }
          // If last names are equal, sort by first name
          const firstNameA = (a.firstName || '').toLowerCase().trim();
          const firstNameB = (b.firstName || '').toLowerCase().trim();
          return firstNameA.localeCompare(firstNameB);
        }
          
        default: {
          // Default: sort by last name
          const lastNameA = (a.lastName || '').toLowerCase().trim();
          const lastNameB = (b.lastName || '').toLowerCase().trim();
          return lastNameA.localeCompare(lastNameB);
        }
      }
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
    // Sort according to selected option
    return [...this.friends].sort((a, b) => {
      const userA = this.getOtherUser(a);
      const userB = this.getOtherUser(b);
      
      switch (this.sortOptionFriends) {
        case 'dateCreation': {
          // Sort by registration date (newest first), then by last name if date is not available
          if (userA.registrationDate && userB.registrationDate) {
            const dateA = new Date(userA.registrationDate).getTime();
            const dateB = new Date(userB.registrationDate).getTime();
            if (dateA !== dateB) {
              return dateB - dateA; // Newest first
            }
          } else if (userA.registrationDate) {
            return -1; // a has date, b doesn't - a comes first
          } else if (userB.registrationDate) {
            return 1; // b has date, a doesn't - b comes first
          }
          // If neither has date, fall through to last name sort
          const lastNameA = (userA.lastName || '').toLowerCase().trim();
          const lastNameB = (userB.lastName || '').toLowerCase().trim();
          if (lastNameA !== lastNameB) {
            return lastNameA.localeCompare(lastNameB);
          }
          // If last names are equal, sort by first name
          const firstNameA = (userA.firstName || '').toLowerCase().trim();
          const firstNameB = (userB.firstName || '').toLowerCase().trim();
          return firstNameA.localeCompare(firstNameB);
        }
          
        case 'firstName': {
          // Sort by first name
          const firstNameA = (userA.firstName || '').toLowerCase().trim();
          const firstNameB = (userB.firstName || '').toLowerCase().trim();
          if (firstNameA !== firstNameB) {
            return firstNameA.localeCompare(firstNameB);
          }
          // If first names are equal, sort by last name
          const lastNameA = (userA.lastName || '').toLowerCase().trim();
          const lastNameB = (userB.lastName || '').toLowerCase().trim();
          return lastNameA.localeCompare(lastNameB);
        }
          
        case 'lastName': {
          // Sort by last name
          const lastNameA = (userA.lastName || '').toLowerCase().trim();
          const lastNameB = (userB.lastName || '').toLowerCase().trim();
          if (lastNameA !== lastNameB) {
            return lastNameA.localeCompare(lastNameB);
          }
          // If last names are equal, sort by first name
          const firstNameA = (userA.firstName || '').toLowerCase().trim();
          const firstNameB = (userB.firstName || '').toLowerCase().trim();
          return firstNameA.localeCompare(firstNameB);
        }
          
        default: {
          // Default: sort by last name
          const lastNameA = (userA.lastName || '').toLowerCase().trim();
          const lastNameB = (userB.lastName || '').toLowerCase().trim();
          return lastNameA.localeCompare(lastNameB);
        }
      }
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
    // Determine the reference user (selected user for admin, or current user)
    const referenceUser = (this.hasAdminRole() && this.selectedUserForUpdate && this.editingSelectedUser) 
      ? this.selectedUserForUpdate 
      : this.currentUser;
    
    // Use the appropriate friends list
    const friendsToUse = (this.hasAdminRole() && this.selectedUserForUpdate && this.editingSelectedUser)
      ? this.selectedUserFriends
      : this.friends;
    
    const directFriendIds = new Set(friendsToUse.map(f => {
      const otherUser = this.getOtherUserFromFriend(f, referenceUser);
      return otherUser.id;
    }));
    
    const groupMembersMap = new Map<string, { member: Member, groups: string[] }>();
    
    for (const group of this.friendGroups) {
      if (!group || !group.members) continue;
      
      const currentUserInGroup = (group.members && group.members.some(m => m && m.id === referenceUser.id)) || 
                                 (group.owner && group.owner.id === referenceUser.id) ||
                                 (group.authorizedUsers && group.authorizedUsers.some(u => u && u.id === referenceUser.id));
      
      if (!currentUserInGroup) continue;
      
      // Helper function to add a member to the map without duplicates
      const addMemberToMap = (member: Member, groupName: string) => {
        if (!member || member.id === referenceUser.id || directFriendIds.has(member.id)) {
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
    // Determine the reference user (selected user for admin, or current user)
    const referenceUser = (this.hasAdminRole() && this.selectedUserForUpdate && this.editingSelectedUser) 
      ? this.selectedUserForUpdate 
      : this.currentUser;
    
    const otherUser = this.getOtherUserFromFriend(friend, referenceUser);
    const otherUserId = otherUser.id;
    const groups: string[] = [];

    // Check if we're both members of any friend groups
    for (const group of this.friendGroups) {
      if (!group || !group.members) continue;
      
      const referenceUserInGroup = (group.members && group.members.some(m => m && m.id === referenceUser.id)) || 
                                   (group.owner && group.owner.id === referenceUser.id) ||
                                   (group.authorizedUsers && group.authorizedUsers.some(u => u && u.id === referenceUser.id));
      const otherUserInGroup = (group.members && group.members.some(m => m && m.id === otherUserId)) || 
                               (group.owner && group.owner.id === otherUserId) ||
                               (group.authorizedUsers && group.authorizedUsers.some(u => u && u.id === otherUserId));
      
      if (referenceUserInGroup && otherUserInGroup && group.name) {
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
      case 'myuser':
        // No data loading needed for myuser tab, ensure loading is false
        this.loading = false;
        this.cdr.detectChanges();
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
    this._friendsService.getAllUsers().subscribe({
      next: (users) => {
        // Filter out current user
        this.allUsers = users.filter(u => u.id !== this.currentUser.id);
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading users:', error);
        this.errorMessage = 'Error loading users';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
    
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
    this._friendsService.getPendingRequests().subscribe({
      next: (requests) => {
        this.pendingRequests = requests;
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading pending requests:', error);
        this.errorMessage = 'Error loading pending requests';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadFriends() {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.getFriends().subscribe({
      next: (friends) => {
        this.friends = friends;
        // Load statuses for all friends
        this.loadFriendStatuses();
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading friends:', error);
        this.errorMessage = 'Error loading friends';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  /**
   * Load status for all users (in All Users tab)
   */
  /**
   * Load status for all users (batch request - single API call)
   */
  loadUserStatuses() {
    this._friendsService.getAllUsersStatus().subscribe(
      statusMap => {
        // Update all statuses from the batch response
        statusMap.forEach((status, userId) => {
          this.userStatuses.set(userId, status);
        });
        // Trigger change detection to update the UI
        this.cdr.detectChanges();
      },
      error => {
        console.error('Error loading all users status:', error);
        // Initialize all users with offline status on error
        this.allUsers.forEach(user => {
          if (user && user.id && !this.userStatuses.has(user.id)) {
            this.userStatuses.set(user.id, { online: false, status: 'offline' });
          }
        });
        this.cdr.detectChanges();
      }
    );
  }

  /**
   * Load status for all friends (uses the same batch request)
   * This method is kept for compatibility but now relies on loadUserStatuses
   */
  loadFriendStatuses() {
    // Statuses are already loaded by loadUserStatuses() which loads all users
    // This method is kept for compatibility but doesn't need to do anything
    // as all statuses are already loaded in userStatuses map
  }

  /**
   * Refresh connection status for all users
   */
  refreshConnectionStatus() {
    this.loadUserStatuses();
  }

  /**
   * Get user online status from Keycloak
   */
  getUserOnlineStatus(userId: string): { online: boolean; status: string } {
    if (!userId) {
      return { online: false, status: 'offline' };
    }
    const status = this.userStatuses.get(userId);
    if (!status) {
      // If status not found, return offline
      return { online: false, status: 'offline' };
    }
    return status;
  }

  loadFriendGroups() {
    this.loading = true;
    this.errorMessage = '';
    this._friendsService.getFriendGroups().subscribe({
      next: (groups) => {
        this.friendGroups = groups;
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading friend groups:', error);
        this.errorMessage = 'Error loading friend groups';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
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
    let detectedCode = '+33'; // Default to France
    if (this.currentUser.whatsappLink) {
      // Extract number from https://wa.me/XXXXXXXXXX format
      const match = this.currentUser.whatsappLink.match(/wa\.me\/([0-9]+)/);
      if (match && match[1]) {
        const fullNumber = match[1];
        // Try to detect country code (sort by length descending to match longer codes first)
        const sortedCodes = [...this.countryCodes].sort((a, b) => b.code.length - a.code.length);
        for (const country of sortedCodes) {
          const codeDigits = country.code.substring(1); // Remove + from code
          if (fullNumber.startsWith(codeDigits)) {
            detectedCode = country.code;
            phoneNumber = fullNumber.substring(codeDigits.length); // Remove country code
            break;
          }
        }
        // If no code detected, use full number
        if (phoneNumber === '') {
          phoneNumber = fullNumber;
        }
      } else {
        // If it's already just a number, use it
        phoneNumber = this.currentUser.whatsappLink.replace(/[^0-9]/g, '');
      }
    }
    this.myWhatsappLink = phoneNumber;
    this.selectedCountryCode = detectedCode;
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
    
    // Remove leading + if present (shouldn't happen but just in case)
    if (phoneNumber.startsWith('+')) {
      phoneNumber = phoneNumber.substring(1);
    }
    
    // Validate phone number
    if (!this.isValidPhoneNumber(phoneNumber)) {
      this.errorMessage = this._translateService.instant('FRIENDS.INVALID_PHONE_NUMBER');
      return;
    }
    
    // Combine country code with phone number (remove + from country code)
    const countryCodeDigits = this.selectedCountryCode.substring(1); // Remove +
    const fullPhoneNumber = countryCodeDigits + phoneNumber;
    
    // Build WhatsApp link with https://wa.me/ prefix
    const whatsappLink = `https://wa.me/${fullPhoneNumber}`;
    
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
   * Update visibility for current user
   */
  updateVisibility(visible: boolean) {
    if (!this.currentUser || !this.currentUser.id) {
      this.errorMessage = this._translateService.instant('FRIENDS.ERROR_USER_NOT_LOADED');
      return;
    }
    
    this.loading = true;
    this._friendsService.updateMemberVisibility(this.currentUser.id, visible).subscribe(
      (updatedMember) => {
        // Update the current user
        this.currentUser = updatedMember;
        // Also update the user in the MembersService
        this._memberService.setUser(updatedMember);
        // Force change detection to update the view
        this.cdr.detectChanges();
        this.loading = false;
        this.errorMessage = '';
      },
      error => {
        console.error('Error updating visibility:', error);
        this.errorMessage = 'Error updating visibility';
        this.loading = false;
      }
    );
  }
  
  /**
   * Update visibility for selected user (admin only)
   */
  updateSelectedUserVisibility(visible: boolean) {
    if (!this.selectedUserForUpdate || !this.selectedUserForUpdate.id) {
      this.errorMessage = 'No user selected';
      return;
    }
    
    if (!this.hasAdminRole()) {
      this.errorMessage = 'Only admins can update other users\' visibility';
      return;
    }
    
    this.loading = true;
    this._friendsService.updateMemberVisibility(this.selectedUserForUpdate.id, visible).subscribe(
      (updatedMember) => {
        // Update the selected user
        this.selectedUserForUpdate = updatedMember;
        // Also update in allUsers array
        const index = this.allUsers.findIndex(u => u.id === updatedMember.id);
        if (index !== -1) {
          this.allUsers[index] = updatedMember;
        }
        // Force change detection to update the view
        this.cdr.detectChanges();
        this.loading = false;
        this.errorMessage = '';
      },
      error => {
        console.error('Error updating visibility:', error);
        this.errorMessage = 'Error updating visibility';
        this.loading = false;
      }
    );
  }
  
  /**
   * Get current user visibility (defaults to true)
   */
  getCurrentUserVisibility(): boolean {
    return this.currentUser?.visible !== undefined ? this.currentUser.visible : true;
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

  /**
   * Initialize country code from existing WhatsApp link or user locale
   */
  private initializeCountryCodeFromLink() {
    if (this.currentUser.whatsappLink) {
      // Extract number from https://wa.me/XXXXXXXXXX format
      const match = this.currentUser.whatsappLink.match(/wa\.me\/([0-9]+)/);
      if (match && match[1]) {
        const fullNumber = match[1];
        // Try to detect country code (sort by length descending to match longer codes first)
        const sortedCodes = [...this.countryCodes].sort((a, b) => b.code.length - a.code.length);
        for (const country of sortedCodes) {
          const codeDigits = country.code.substring(1); // Remove + from code
          if (fullNumber.startsWith(codeDigits)) {
            this.selectedCountryCode = country.code;
            return;
          }
        }
      }
    }
    // Try to detect from user locale
    if (this.currentUser.locale) {
      const localeToCountryCode: {[key: string]: string} = {
        'fr': '+33', 'en': '+1', 'es': '+34', 'de': '+49', 'it': '+39',
        'ar': '+212', 'cn': '+86', 'jp': '+81', 'ru': '+7', 'he': '+972',
        'el': '+30', 'pt': '+351', 'nl': '+31', 'be': '+32', 'ch': '+41'
      };
      const langCode = this.currentUser.locale.toLowerCase().substring(0, 2);
      if (localeToCountryCode[langCode]) {
        this.selectedCountryCode = localeToCountryCode[langCode];
        return;
      }
    }
    // Default to France if no link or code not detected
    this.selectedCountryCode = '+33';
  }

  /**
   * Get the selected country object
   */
  getSelectedCountry(): {code: string, flag: string, name: string} | undefined {
    return this.countryCodes.find(c => c.code === this.selectedCountryCode);
  }

  /**
   * Select a country code and close the dropdown
   */
  selectCountryCode(code: string, dropdown: NgbDropdown) {
    this.selectedCountryCode = code;
    if (dropdown) {
      dropdown.close();
    }
    // Trigger change detection
    this.cdr.detectChanges();
  }

  /**
   * Admin: Select a user to update
   */
  onUserSelectedForUpdate(userId: string | null) {
    if (!userId || userId === '' || userId === null) {
      this.selectedUserForUpdate = null;
      this.editingSelectedUser = false;
      this.selectedUserWhatsappLink = '';
      this.selectedUserCountryCode = '+33';
      this.selectedUserFriends = [];
      this.originalSelectedUserRoles = [];
      this.originalSelectedUserKeycloakId = '';
      this.originalSelectedUserRegistrationDate = undefined;
      this.originalSelectedUserLastConnectionDate = undefined;
      return;
    }
    // Open admin mode section when selecting a user
    this.adminModeCollapsed = false;
    const user = this.allUsers.find(u => u.id === userId);
    if (user) {
      // Store original values to prevent overwriting with admin values
      this.originalSelectedUserRoles = [...(user.roles || [])];
      this.originalSelectedUserKeycloakId = user.keycloakId || '';
      this.originalSelectedUserRegistrationDate = user.registrationDate;
      this.originalSelectedUserLastConnectionDate = user.lastConnectionDate;
      
      // Create a copy to avoid modifying the original
      this.selectedUserForUpdate = new Member(
        user.id,
        user.addressEmail,
        user.firstName,
        user.lastName,
        user.userName,
        [...(user.roles || [])],
        user.keycloakId,
        user.registrationDate,
        user.lastConnectionDate,
        user.locale,
        user.whatsappLink,
        user.visible !== undefined ? user.visible : true
      );
      this.editingSelectedUser = true;
      
      // Load friends of the selected user
      this.loadSelectedUserFriends(user.id);
      
      // Initialize WhatsApp link fields
      if (user.whatsappLink) {
        const phoneNumber = this.getPhoneNumberFromLink(user.whatsappLink);
        this.selectedUserWhatsappLink = phoneNumber;
        // Extract country code from link or default
        const countryCodeMatch = user.whatsappLink.match(/https:\/\/wa\.me\/(\d+)/);
        if (countryCodeMatch && countryCodeMatch[1]) {
          const fullNumber = countryCodeMatch[1];
          // Try to find matching country code
          const matchedCountry = this.countryCodes.find(c => fullNumber.startsWith(c.code.replace('+', '')));
          if (matchedCountry) {
            this.selectedUserCountryCode = matchedCountry.code;
            this.selectedUserWhatsappLink = fullNumber.substring(matchedCountry.code.replace('+', '').length);
          } else {
            this.selectedUserCountryCode = '+33';
            this.selectedUserWhatsappLink = phoneNumber;
          }
        } else {
          this.selectedUserCountryCode = '+33';
          this.selectedUserWhatsappLink = phoneNumber;
        }
      } else {
        this.selectedUserWhatsappLink = '';
        this.selectedUserCountryCode = '+33';
      }
    } else {
      this.selectedUserForUpdate = null;
      this.editingSelectedUser = false;
      this.selectedUserWhatsappLink = '';
      this.selectedUserCountryCode = '+33';
      this.originalSelectedUserRoles = [];
      this.originalSelectedUserKeycloakId = '';
      this.originalSelectedUserRegistrationDate = undefined;
      this.originalSelectedUserLastConnectionDate = undefined;
    }
  }

  /**
   * Admin: Save updated user
   */
  saveUpdatedUser() {
    if (!this.selectedUserForUpdate) {
      return;
    }
    
    // CRITICAL FIX: Preserve original values to prevent admin values from being applied to selected user
    // Restore the original values before sending the update
    this.selectedUserForUpdate.roles = [...this.originalSelectedUserRoles];
    // Preserve keycloakId, registrationDate, and lastConnectionDate (should never be changed by admin)
    this.selectedUserForUpdate.keycloakId = this.originalSelectedUserKeycloakId;
    this.selectedUserForUpdate.registrationDate = this.originalSelectedUserRegistrationDate;
    this.selectedUserForUpdate.lastConnectionDate = this.originalSelectedUserLastConnectionDate;
    
    // Build WhatsApp link if phone number is provided
    if (this.selectedUserWhatsappLink && this.selectedUserWhatsappLink.trim()) {
      const countryCode = this.selectedUserCountryCode.replace('+', '');
      const phoneNumber = this.selectedUserWhatsappLink.replace(/\D/g, ''); // Remove non-digits
      this.selectedUserForUpdate.whatsappLink = `https://wa.me/${countryCode}${phoneNumber}`;
    } else {
      this.selectedUserForUpdate.whatsappLink = undefined;
    }
    
    this.loading = true;
    this._friendsService.updateMember(this.selectedUserForUpdate).subscribe(
      updatedUser => {
        // Update in allUsers array
        const index = this.allUsers.findIndex(u => u.id === updatedUser.id);
        if (index !== -1) {
          this.allUsers[index] = updatedUser;
        }
        // If it's the current user, update currentUser too
        if (updatedUser.id === this.currentUser.id) {
          this.currentUser = updatedUser;
        }
        this.loading = false;
        this.editingSelectedUser = false;
        // Reset selected user to return to current user view
        this.selectedUserForUpdate = null;
        this.selectedUserFriends = [];
        this.selectedUserWhatsappLink = '';
        this.selectedUserCountryCode = '+33';
        this.originalSelectedUserRoles = [];
        this.originalSelectedUserKeycloakId = '';
        this.originalSelectedUserRegistrationDate = undefined;
        this.originalSelectedUserLastConnectionDate = undefined;
        this.loadData(); // Reload all data to refresh
      },
      error => {
        console.error('Error updating user:', error);
        this.errorMessage = 'Error updating user';
        this.loading = false;
      }
    );
  }

  /**
   * Admin: Cancel editing selected user
   */
  cancelEditingSelectedUser() {
    this.selectedUserForUpdate = null;
    this.editingSelectedUser = false;
    this.selectedUserWhatsappLink = '';
    this.selectedUserCountryCode = '+33';
    this.selectedUserFriends = [];
    this.originalSelectedUserRoles = [];
    this.originalSelectedUserKeycloakId = '';
    this.originalSelectedUserRegistrationDate = undefined;
    this.originalSelectedUserLastConnectionDate = undefined;
  }

  /**
   * Load friends of the selected user (for admin view)
   */
  loadSelectedUserFriends(userId: string) {
    if (!this.hasAdminRole()) {
      this.selectedUserFriends = [];
      return;
    }
    
    this.loading = true;
    this._friendsService.getFriendsForUser(userId).subscribe(
      friends => {
        this.selectedUserFriends = friends;
        this.loading = false;
      },
      error => {
        console.error('Error loading friends for selected user:', error);
        this.selectedUserFriends = [];
        this.loading = false;
      }
    );
  }

  /**
   * Get friends to display in the grid (current user's friends or selected user's friends for admin)
   */
  getFriendsForDisplay(): Friend[] {
    if (this.hasAdminRole() && this.selectedUserForUpdate && this.editingSelectedUser) {
      return this.selectedUserFriends;
    }
    return this.friends;
  }

  /**
   * Get sorted friends for display
   */
  getSortedFriendsForDisplay(): Friend[] {
    const friendsToSort = this.getFriendsForDisplay();
    const referenceUser = (this.hasAdminRole() && this.selectedUserForUpdate && this.editingSelectedUser) ? this.selectedUserForUpdate : this.currentUser;
    
    // Filter out invalid friends (where we can't determine the other user)
    const validFriends = friendsToSort.filter(friend => {
      const otherUser = this.getOtherUserFromFriend(friend, referenceUser);
      return otherUser && otherUser.id && (otherUser.firstName || otherUser.lastName || otherUser.userName);
    });
    
    return [...validFriends].sort((a, b) => {
      const userA = this.getOtherUserFromFriend(a, referenceUser);
      const userB = this.getOtherUserFromFriend(b, referenceUser);
      
      // Sort by firstName first
      if (userA.firstName && userB.firstName) {
        const firstNameCompare = userA.firstName.localeCompare(userB.firstName);
        if (firstNameCompare !== 0) return firstNameCompare;
      } else if (userA.firstName) return -1;
      else if (userB.firstName) return 1;
      
      // Then by lastName
      if (userA.lastName && userB.lastName) {
        const lastNameCompare = userA.lastName.localeCompare(userB.lastName);
        if (lastNameCompare !== 0) return lastNameCompare;
      } else if (userA.lastName) return -1;
      else if (userB.lastName) return 1;
      
      // Finally by userName
      if (userA.userName && userB.userName) {
        return userA.userName.localeCompare(userB.userName);
      } else if (userA.userName) return -1;
      else if (userB.userName) return 1;
      
      return 0;
    });
  }

  /**
   * Get the other user from a friend relationship, given a reference user
   */
  getOtherUserFromFriend(friend: Friend, referenceUser: Member): Member {
    if (!friend || !referenceUser || !referenceUser.id) {
      return new Member('', '', '', '', '', [], '');
    }
    
    // Check if referenceUser is user1
    if (friend.user1 && friend.user1.id && friend.user1.id === referenceUser.id) {
      return friend.user2 && friend.user2.id ? friend.user2 : new Member('', '', '', '', '', [], '');
    }
    
    // Check if referenceUser is user2
    if (friend.user2 && friend.user2.id && friend.user2.id === referenceUser.id) {
      return friend.user1 && friend.user1.id ? friend.user1 : new Member('', '', '', '', '', [], '');
    }
    
    // If referenceUser is neither user1 nor user2, this shouldn't happen in normal flow
    // But return the first available user as fallback
    if (friend.user1 && friend.user1.id) {
      return friend.user1;
    }
    if (friend.user2 && friend.user2.id) {
      return friend.user2;
    }
    
    return new Member('', '', '', '', '', [], '');
  }

  /**
   * Get sorted users for admin select box (sorted by firstName, then lastName, then userName)
   */
  getSortedUsersForAdmin(): Member[] {
    return [...this.allUsers].sort((a, b) => {
      // Sort by firstName first
      if (a.firstName && b.firstName) {
        const firstNameCompare = a.firstName.localeCompare(b.firstName);
        if (firstNameCompare !== 0) return firstNameCompare;
      } else if (a.firstName) return -1;
      else if (b.firstName) return 1;
      
      // Then by lastName
      if (a.lastName && b.lastName) {
        const lastNameCompare = a.lastName.localeCompare(b.lastName);
        if (lastNameCompare !== 0) return lastNameCompare;
      } else if (a.lastName) return -1;
      else if (b.lastName) return 1;
      
      // Finally by userName
      if (a.userName && b.userName) {
        return a.userName.localeCompare(b.userName);
      } else if (a.userName) return -1;
      else if (b.userName) return 1;
      
      return 0;
    });
  }

  /**
   * Get the selected country object for admin form
   */
  getSelectedCountryForAdmin(): {code: string, flag: string, name: string} | undefined {
    return this.countryCodes.find(c => c.code === this.selectedUserCountryCode);
  }

  /**
   * Select a country code for admin form and close the dropdown
   */
  selectCountryCodeForAdmin(code: string, dropdown: NgbDropdown) {
    this.selectedUserCountryCode = code;
    if (dropdown) {
      dropdown.close();
    }
    // Trigger change detection
    this.cdr.detectChanges();
  }

  /**
   * Get translated role name
   */
  getTranslatedRole(role: string): string {
    if (!role) return role;
    const roleKey = 'FRIENDS.ROLE_' + role.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const translated = this._translateService.instant(roleKey);
    // If translation doesn't exist, return the original role
    return translated !== roleKey ? translated : role;
  }

  /**
   * Filter out uma_authorization and um_authorization roles
   */
  getFilteredRoles(roles: string[] | undefined): string[] {
    if (!roles || !Array.isArray(roles)) {
      return [];
    }
    return roles.filter((r: string) => {
      if (!r || r.trim().length === 0) return false;
      const roleLower = r.toLowerCase().trim();
      // Filter out uma_authorization and um_authorization
      return roleLower !== 'uma_authorization' && roleLower !== 'um_authorization';
    });
  }
}

