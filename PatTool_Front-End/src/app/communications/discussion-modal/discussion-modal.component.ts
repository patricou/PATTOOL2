// Discussion Modal Component - Opens discussion in a modal
import { Component, Input, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { DiscussionComponent } from '../discussion/discussion.component';

@Component({
  selector: 'app-discussion-modal',
  templateUrl: './discussion-modal.component.html',
  styleUrls: ['./discussion-modal.component.css']
})
export class DiscussionModalComponent implements OnInit, OnDestroy {
  @Input() discussionId: string | null = null;
  @Input() title: string = 'Discussion';
  @ViewChild(DiscussionComponent) discussionComponent!: DiscussionComponent;

  constructor(public activeModal: NgbActiveModal) {}

  ngOnInit() {
    // Modal is initialized - give it a moment to fully render
    // The DiscussionComponent will handle its own initialization
  }

  ngOnDestroy() {
    // The DiscussionComponent will handle its own cleanup in ngOnDestroy
    // No additional cleanup needed here
  }

  close() {
    this.activeModal.close();
  }

  refreshDiscussion() {
    if (this.discussionComponent) {
      // Reload the discussion
      this.discussionComponent.loadDiscussion();
    }
  }
}

