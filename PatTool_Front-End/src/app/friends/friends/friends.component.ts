import { Component, OnInit } from '@angular/core';
import { Member } from '../../model/member';
import { FriendRequest, FriendRequestStatus, Friend, FriendGroup } from '../../model/friend';
import { FriendsService } from '../../services/friends.service';
import { MembersService } from '../../services/members.service';
import { TranslateService } from '@ngx-translate/core';

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
  public activeTab: 'users' | 'requests' | 'friends' | 'groups' = 'users';
  public loading: boolean = false;
  public errorMessage: string = '';
  public inviteEmail: string = '';
  public checkingEmail: boolean = false;
  public emailExists: boolean = false;
  public emailCheckResult: { exists: boolean; memberId?: string; userName?: string } | null = null;
  public sendingInvite: boolean = false;
  
  // Friend groups management
  public friendGroups: FriendGroup[] = [];
  public newGroupName: string = '';
  public selectedGroupMembers: string[] = [];
  public isCreatingGroup: boolean = false;
  public editingGroupId: string | null = null;
  public editingGroupName: string = '';
  public editingGroupMembers: string[] = [];
  // Authorized users management
  public managingAuthorizedUsersGroupId: string | null = null;
  public selectedAuthorizedUsers: string[] = [];

  constructor(
    private _friendsService: FriendsService,
    private _memberService: MembersService,
    private _translateService: TranslateService
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

    // Load all users
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

    // Load pending requests (incoming)
    this._friendsService.getPendingRequests().subscribe(
      requests => {
        this.pendingRequests = requests;
      },
      error => {
        console.error('Error loading pending requests:', error);
      }
    );

    // Load sent requests (outgoing)
    this._friendsService.getSentRequests().subscribe(
      requests => {
        this.sentRequests = requests;
      },
      error => {
        console.error('Error loading sent requests:', error);
      }
    );

    // Load friends
    this._friendsService.getFriends().subscribe(
      friends => {
        this.friends = friends;
      },
      error => {
        console.error('Error loading friends:', error);
      }
    );

    // Load friend groups
    this._friendsService.getFriendGroups().subscribe(
      groups => {
        this.friendGroups = groups;
      },
      error => {
        console.error('Error loading friend groups:', error);
      }
    );
  }

  sendFriendRequest(userId: string) {
    this.loading = true;
    this._friendsService.sendFriendRequest(userId).subscribe(
      request => {
        this.loadData(); // Reload data
        this.loading = false;
      },
      error => {
        console.error('Error sending friend request:', error);
        this.errorMessage = 'Error sending friend request';
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

  getFilteredUsers(): Member[] {
    if (!this.searchFilter || !this.searchFilter.trim()) {
      return this.allUsers;
    }

    const searchTerm = this.searchFilter.toLowerCase().trim();
    return this.allUsers.filter(user => {
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

  getOtherUser(friend: Friend): Member {
    if (friend.user1.id === this.currentUser.id) {
      return friend.user2;
    }
    return friend.user1;
  }

  setActiveTab(tab: 'users' | 'requests' | 'friends' | 'groups') {
    this.activeTab = tab;
    this.searchFilter = ''; // Clear search when switching tabs
    this.inviteEmail = ''; // Clear invite email
    this.emailCheckResult = null;
    this.emailExists = false;
    if (tab === 'groups') {
      this.loadFriendGroups();
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

  // Friend Groups Management Methods
  loadFriendGroups() {
    this.loading = true;
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
  }

  cancelEditingGroup() {
    this.editingGroupId = null;
    this.editingGroupName = '';
    this.editingGroupMembers = [];
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
      this.editingGroupMembers
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
}

