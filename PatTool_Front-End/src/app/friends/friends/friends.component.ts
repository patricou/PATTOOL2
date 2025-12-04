import { Component, OnInit } from '@angular/core';
import { Member } from '../../model/member';
import { FriendRequest, FriendRequestStatus, Friend } from '../../model/friend';
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
  public activeTab: 'users' | 'requests' | 'friends' = 'users';
  public loading: boolean = false;
  public errorMessage: string = '';

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

  setActiveTab(tab: 'users' | 'requests' | 'friends') {
    this.activeTab = tab;
    this.searchFilter = ''; // Clear search when switching tabs
  }
}

