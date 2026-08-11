import { Injectable, inject } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { NoteDetailOverlayComponent } from './note-detail-overlay.component';

/**
 * Opens a note in a modal above the current route (event fiche, calendar, photo wall, etc.).
 */
@Injectable({ providedIn: 'root' })
export class NoteDetailOverlayService {
    private readonly modal = inject(NgbModal);

    open(noteId: string): void {
        const id = (noteId || '').trim();
        if (!id) {
            return;
        }
        const ref = this.modal.open(NoteDetailOverlayComponent, {
            size: 'lg',
            scrollable: true,
            centered: true,
            container: 'body',
            backdrop: 'static',
            windowClass: 'notes-modal'
        });
        ref.componentInstance.noteId = id;
    }
}
