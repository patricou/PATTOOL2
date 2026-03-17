import { Component, inject, Input, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { NgbActiveModal, NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule } from '@ngx-translate/core';
import { EvenementsService } from '../../services/evenements.service';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { Evenement } from '../../model/evenement';
import { Member } from '../../model/member';
import { ElementEvenementComponent } from '../../evenements/element-evenement/element-evenement.component';

@Component({
    selector: 'app-event-card-modal',
    standalone: true,
    imports: [CommonModule, NgbModule, TranslateModule, ElementEvenementComponent],
    template: `
        <div class="modal-header py-2">
            <h5 class="modal-title">{{ 'PHOTO_TIMELINE.EVENT_CARD' | translate }}</h5>
            <button type="button" class="btn-close" (click)="activeModal.dismiss()" [attr.aria-label]="'COMMUN.CLOSE' | translate"></button>
        </div>
        <div class="modal-body p-0 overflow-auto event-card-modal-body">
            <div *ngIf="loading" class="event-card-loading">
                <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
                <span class="ms-2">{{ 'COMMUN.LOADING' | translate }}...</span>
            </div>
            <div *ngIf="error" class="alert alert-danger m-3">{{ error }}</div>
            <div class="event-card-wrapper" *ngIf="evenement && user && !loading">
                <element-evenement class="card"
                    [evenement]="evenement"
                    [user]="user"
                    [titleOnly]="false">
                </element-evenement>
            </div>
        </div>
    `,
    styles: [`
        .event-card-modal-body { max-height: 80vh; }
        .event-card-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.25rem;
            min-height: 80px;
        }
        .event-card-wrapper {
            padding: 0;
        }
        .event-card-wrapper :host::ng-deep element-evenement.card {
            display: block;
            border-radius: 16px;
            border: 1px solid rgba(15, 23, 42, 0.08);
            box-shadow: 0 12px 28px rgba(15, 23, 42, 0.12);
            overflow: hidden;
        }
    `],
    providers: [EvenementsService]
})
export class EventCardModalComponent {
    activeModal = inject(NgbActiveModal);
    private evenementsService = inject(EvenementsService);
    private membersService = inject(MembersService);
    private fileService = inject(FileService);
    private sanitizer = inject(DomSanitizer);
    private cdr = inject(ChangeDetectorRef);

    /** Set by the opener after modalService.open(EventCardModalComponent) */
    @Input() eventId: string | null = null;

    evenement: Evenement | null = null;
    user: Member | null = null;
    loading = true;
    error: string | null = null;

    /** Call after setting eventId from the opener, or when eventId is set via input. */
    loadEvent(): void {
        const id = this.eventId;
        if (!id) {
            this.applyStateUpdate(() => {
                this.loading = false;
                this.error = 'ID d\'événement manquant.';
            });
            return;
        }
        this.user = this.membersService.getUser();
        this.evenementsService.getEvenement(id).subscribe({
            next: (ev) => this.onEventLoaded(ev),
            error: (err) => {
                this.applyStateUpdate(() => {
                    this.loading = false;
                    this.error = err?.error?.message || err?.message || 'Erreur lors du chargement de l\'événement.';
                });
            }
        });
    }

    /** Once we have the event, preload thumbnail so the photo appears immediately when the card is shown. */
    private onEventLoaded(ev: Evenement): void {
        const thumb = ev?.thumbnail as { fieldId?: string; fileName?: string } | undefined;
        const fieldId = thumb?.fieldId;
        if (!fieldId) {
            this.applyStateUpdate(() => {
                this.evenement = ev;
                this.loading = false;
            });
            return;
        }
        if (ElementEvenementComponent.isThumbnailCached(fieldId)) {
            this.applyStateUpdate(() => {
                this.evenement = ev;
                this.loading = false;
            });
            return;
        }
        this.fileService.getFile(fieldId).subscribe({
            next: (arrayBuffer) => {
                const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
                const fileName = thumb?.fileName;
                if (fileName && fileName.toLowerCase().includes('thumbnail')) {
                    ElementEvenementComponent.setCachedBlob(fieldId, blob);
                }
                const objectUrl = URL.createObjectURL(blob);
                const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
                ElementEvenementComponent.setCachedThumbnail(fieldId, safeUrl);
                this.applyStateUpdate(() => {
                    this.evenement = ev;
                    this.loading = false;
                });
            },
            error: () => {
                this.applyStateUpdate(() => {
                    this.evenement = ev;
                    this.loading = false;
                });
            }
        });
    }

    /** Run state updates in the next tick to avoid ExpressionChangedAfterItHasBeenCheckedError. */
    private applyStateUpdate(update: () => void): void {
        setTimeout(() => {
            update();
            this.cdr.markForCheck();
        }, 0);
    }
}
