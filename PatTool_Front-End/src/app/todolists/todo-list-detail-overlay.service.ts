import { Injectable, inject } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { TodoListDetailOverlayComponent } from './todo-list-detail-overlay.component';

/**
 * Opens the to-do list detail view in a modal above the current route (calendar, events wall, etc.).
 */
@Injectable({ providedIn: 'root' })
export class TodoListDetailOverlayService {
    private readonly modal = inject(NgbModal);

    open(listId: string): void {
        const id = (listId || '').trim();
        if (!id) {
            return;
        }
        const ref = this.modal.open(TodoListDetailOverlayComponent, {
            size: 'lg',
            scrollable: true,
            centered: true,
            container: 'body',
            windowClass: 'todolists-modal'
        });
        ref.componentInstance.listId = id;
    }
}
