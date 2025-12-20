import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModule, NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { DiscussionService, DiscussionStatistics } from '../../services/discussion.service';
import { MembersService } from '../../services/members.service';
import { Member } from '../../model/member';

@Component({
  selector: 'app-discussion-statistics-modal',
  templateUrl: './discussion-statistics-modal.component.html',
  styleUrls: ['./discussion-statistics-modal.component.css'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgbModule,
    TranslateModule
  ]
})
export class DiscussionStatisticsModalComponent implements OnInit {
  statistics: DiscussionStatistics[] = [];
  allStatistics: DiscussionStatistics[] = []; // Store all statistics for filtering
  allUsers: Member[] = [];
  selectedUserId: string | null = null;
  isLoading: boolean = true;
  isLoadingUsers: boolean = false;
  error: string | null = null;

  constructor(
    public activeModal: NgbActiveModal,
    private discussionService: DiscussionService,
    private membersService: MembersService,
    private translate: TranslateService
  ) {}

  ngOnInit() {
    this.loadUsers();
    this.loadStatistics();
  }

  loadUsers() {
    this.isLoadingUsers = true;
    // Get all users from the statistics (they will be loaded when statistics load)
    // Or we can load them separately if there's an endpoint
    this.isLoadingUsers = false;
  }

  loadStatistics(userId?: string) {
    this.isLoading = true;
    this.error = null;
    
    this.discussionService.getDiscussionStatistics(userId).subscribe({
      next: (stats) => {
        this.statistics = stats;
        if (!userId) {
          // Store all statistics when loading all users
          this.allStatistics = stats;
          // Extract unique users from statistics for the filter dropdown and sort them
          this.allUsers = stats.map(s => new Member(
            s.userId,
            '', // addressEmail
            s.firstName || '', // firstName
            s.lastName || '', // lastName
            s.userName, // userName
            [], // roles (array)
            '' // keycloakId
          )).sort((a, b) => {
            // Sort by username (case-insensitive)
            const nameA = (a.userName || '').toLowerCase();
            const nameB = (b.userName || '').toLowerCase();
            return nameA.localeCompare(nameB);
          });
        }
        this.isLoading = false;
      },
      error: (error) => {
        console.error('Error loading discussion statistics:', error);
        this.error = this.translate.instant('STATISTICS.ERROR');
        this.isLoading = false;
      }
    });
  }

  onUserFilterChange() {
    if (this.selectedUserId) {
      this.loadStatistics(this.selectedUserId);
    } else {
      // Show all users
      this.statistics = [...this.allStatistics];
    }
  }

  clearFilter() {
    this.selectedUserId = null;
    this.statistics = [...this.allStatistics];
  }

  close() {
    this.activeModal.close();
  }

  getAccessReasonLabel(reason: string): string {
    // Check if reason contains a colon (format: "type:GroupName")
    if (reason.includes(':')) {
      const [type, groupName] = reason.split(':', 2);
      let baseLabel = '';
      switch(type) {
        case 'group_owner':
          baseLabel = this.translate.instant('STATISTICS.GROUP_OWNER');
          break;
        case 'group_member':
          baseLabel = this.translate.instant('STATISTICS.GROUP_MEMBER');
          break;
        case 'group_authorized':
          baseLabel = this.translate.instant('STATISTICS.GROUP_AUTHORIZED');
          break;
        default:
          baseLabel = type;
      }
      return `${baseLabel} (${groupName})`;
    }
    
    // Simple labels for reasons without group names
    switch(reason) {
      case 'creator':
        return this.translate.instant('STATISTICS.CREATOR');
      case 'general':
        return this.translate.instant('STATISTICS.GENERAL_DISCUSSION');
      case 'event_owner':
        return this.translate.instant('STATISTICS.EVENT_OWNER');
      case 'public':
        return this.translate.instant('STATISTICS.PUBLIC_EVENT');
      case 'friend_of_author':
        return this.translate.instant('STATISTICS.FRIEND_OF_AUTHOR');
      case 'group_owner':
        return this.translate.instant('STATISTICS.GROUP_OWNER');
      case 'group_member':
        return this.translate.instant('STATISTICS.GROUP_MEMBER');
      case 'group_authorized':
        return this.translate.instant('STATISTICS.GROUP_AUTHORIZED');
      default:
        return reason;
    }
  }
}

