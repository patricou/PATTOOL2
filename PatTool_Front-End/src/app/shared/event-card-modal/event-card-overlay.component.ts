import { Component, Input, Output, EventEmitter, ChangeDetectorRef, OnDestroy, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { EvenementsService } from '../../services/evenements.service';
import { MembersService } from '../../services/members.service';
import { FileService } from '../../services/file.service';
import { Evenement } from '../../model/evenement';
import { Member } from '../../model/member';
import { ElementEvenementComponent } from '../../evenements/element-evenement/element-evenement.component';

/**
 * In-page overlay for "Fiche événement" (no NgbModal) to avoid ng-bootstrap teardown errors on close.
 */
@Component({
    selector: 'app-event-card-overlay',
    standalone: true,
    imports: [CommonModule, TranslateModule, ElementEvenementComponent],
    template: `
        <div class="event-card-overlay-backdrop" (click)="close()" role="button" [attr.aria-label]="'COMMUN.CLOSE' | translate"></div>
        <div class="event-card-overlay-panel" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
            <div class="event-card-overlay-header">
                <h5 class="event-card-overlay-title">{{ 'PHOTO_TIMELINE.EVENT_CARD' | translate }}</h5>
                <button type="button" class="btn-close" (click)="close()" [attr.aria-label]="'COMMUN.CLOSE' | translate"></button>
            </div>
            <div class="event-card-overlay-body">
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
        </div>
    `,
    styles: [`
        :host {
            position: fixed;
            inset: 0;
            z-index: 1050;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
            box-sizing: border-box;
        }
        .event-card-overlay-backdrop {
            position: absolute;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            cursor: pointer;
        }
        .event-card-overlay-panel {
            position: relative;
            z-index: 1;
            width: 100%;
            max-width: 420px;
            background: #fff;
            border-radius: 0.5rem;
            box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.15);
            max-height: 85vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .event-card-overlay-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 1rem;
            border-bottom: 1px solid #dee2e6;
            flex-shrink: 0;
        }
        .event-card-overlay-title { margin: 0; font-size: 1.1rem; }
        .event-card-overlay-body {
            padding: 0;
            overflow: auto;
            max-height: 80vh;
            flex: 1;
            min-height: 0;
        }
        .event-card-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.25rem;
            min-height: 80px;
        }
        .event-card-wrapper { padding: 0; }
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
export class EventCardOverlayComponent implements OnDestroy, OnChanges {
    private evenementsService = inject(EvenementsService);
    private membersService = inject(MembersService);
    private fileService = inject(FileService);
    private sanitizer = inject(DomSanitizer);
    private cdr = inject(ChangeDetectorRef);

    @Input() eventId: string | null = null;
    @Output() closed = new EventEmitter<void>();

    evenement: Evenement | null = null;
    user: Member | null = null;
    loading = true;
    error: string | null = null;

    private destroyed = false;
    private subscriptions: Subscription[] = [];

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['eventId'] && this.eventId) {
            this.subscriptions.forEach(s => { if (s && !s.closed) s.unsubscribe(); });
            this.subscriptions = [];
            this.loading = true;
            this.error = null;
            this.evenement = null;
            this.loadEvent();
        }
    }

    ngOnDestroy(): void {
        this.cleanup();
    }

    private cleanup(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.subscriptions.forEach(s => { if (s && !s.closed) s.unsubscribe(); });
        this.subscriptions = [];
    }

    close(): void {
        this.cleanup();
        this.closed.emit();
    }

    /** Call when eventId is set (e.g. from parent after view init). */
    loadEvent(): void {
        const id = this.eventId;
        if (!id) {
            this.loading = false;
            this.error = 'ID d\'événement manquant.';
            this.cdr.markForCheck();
            return;
        }
        this.user = this.membersService.getUser();
        const sub = this.evenementsService.getEvenement(id).subscribe({
            next: (ev) => this.onEventLoaded(ev),
            error: (err) => {
                if (this.destroyed) return;
                this.loading = false;
                this.error = err?.error?.message || err?.message || 'Erreur lors du chargement de l\'événement.';
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(sub);
    }

    private onEventLoaded(ev: Evenement): void {
        const thumb = ev?.thumbnail as { fieldId?: string; fileName?: string } | undefined;
        const fieldId = thumb?.fieldId;
        if (!fieldId) {
            this.evenement = ev;
            this.loading = false;
            this.cdr.markForCheck();
            return;
        }
        if (ElementEvenementComponent.isThumbnailCached(fieldId)) {
            this.evenement = ev;
            this.loading = false;
            this.cdr.markForCheck();
            return;
        }
        const fileSub = this.fileService.getFile(fieldId).subscribe({
            next: (arrayBuffer) => {
                if (this.destroyed) return;
                const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
                const fileName = thumb?.fileName;
                if (fileName && fileName.toLowerCase().includes('thumbnail')) {
                    ElementEvenementComponent.setCachedBlob(fieldId, blob);
                }
                const objectUrl = URL.createObjectURL(blob);
                const safeUrl = this.sanitizer.bypassSecurityTrustUrl(objectUrl);
                ElementEvenementComponent.setCachedThumbnail(fieldId, safeUrl);
                this.evenement = ev;
                this.loading = false;
                this.cdr.markForCheck();
            },
            error: () => {
                if (this.destroyed) return;
                this.evenement = ev;
                this.loading = false;
                this.cdr.markForCheck();
            }
        });
        this.subscriptions.push(fileSub);
    }
}
