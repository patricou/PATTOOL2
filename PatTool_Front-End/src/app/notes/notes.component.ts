import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    OnDestroy,
    OnInit,
    TemplateRef,
    ViewChild,
    inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModal, NgbModalModule, NgbModalRef } from '@ng-bootstrap/ng-bootstrap';
import { Subscription, from as fromIterable, of } from 'rxjs';
import { catchError, finalize, map, mergeMap, reduce, take } from 'rxjs/operators';
import { Router, ActivatedRoute } from '@angular/router';
import {
    Note,
    NotePayload,
    NoteService,
    NoteVisibility,
    NoteVisibilityRecipient
} from './note.service';
import { MembersService } from '../services/members.service';
import { PositionService } from '../services/position.service';
import { FriendsService } from '../services/friends.service';
import { ImageCompressionService } from '../services/image-compression.service';
import { CalendarEntry, CalendarService } from '../calendar/calendar.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Member } from '../model/member';
import { FriendGroup } from '../model/friend';

/** Curated post-it palette — warm sticky-note colours. */
export const NOTE_COLORS: string[] = [
    '#ffe066', // yellow
    '#ffadad', // coral pink
    '#ffd6a5', // peach
    '#caffbf', // mint
    '#9bf6ff', // sky
    '#bdb2ff', // lavender
    '#ffc6ff', // lilac
    '#fdffb6', // pale lemon
    '#a0c4ff', // soft blue
    '#ffc8dd'  // rose
];

const VISIBILITY_PRESETS: NoteVisibility[] = ['private', 'friends', 'friendGroups', 'public'];
const MAX_PHOTOS_PER_NOTE = 5;

/** Each {@code GET /api/calendar/entries} call must stay under the back-end window (~370 days). */
const CALENDAR_ENTRIES_CHUNK_MS = 360 * 24 * 60 * 60 * 1000;
/** How far back/forward to load for activity / appointment link pickers. */
const LINK_PICKER_RANGE_YEARS = 15;

interface NoteLinkOption {
    id: string;
    label: string;
}

/**
 * Sticky notes board with TodoList-style sharing. Owners create / edit / delete;
 * friends and friend-group members can view notes shared with them.
 */
@Component({
    selector: 'app-notes',
    standalone: true,
    imports: [CommonModule, FormsModule, TranslateModule, NgbModalModule],
    templateUrl: './notes.component.html',
    styleUrls: ['./notes.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class NotesComponent implements OnInit, OnDestroy {

    @ViewChild('editModal') editModal!: TemplateRef<unknown>;
    @ViewChild('photoModal') photoModal!: TemplateRef<unknown>;

    private noteService = inject(NoteService);
    private membersService = inject(MembersService);
    private positionService = inject(PositionService);
    private friendsService = inject(FriendsService);
    private imageCompression = inject(ImageCompressionService);
    private calendarService = inject(CalendarService);
    private keycloak = inject(KeycloakService);
    private router = inject(Router);
    private route = inject(ActivatedRoute);
    private translate = inject(TranslateService);
    private modal = inject(NgbModal);
    private cdr = inject(ChangeDetectorRef);

    readonly colorPalette = NOTE_COLORS;
    readonly visibilityPresets = VISIBILITY_PRESETS;
    readonly maxPhotos = MAX_PHOTOS_PER_NOTE;

    notes: Note[] = [];
    filteredNotes: Note[] = [];
    searchTerm = '';
    /** Deep-link filter from agenda / photo wall / event fiche. */
    linkFilterEventId: string | null = null;
    linkFilterAppointmentId: string | null = null;
    pendingOpenNoteId: string | null = null;
    isLoading = false;
    isSaving = false;
    errorMessage = '';
    editorErrorMessage = '';
    currentUserId = '';
    currentDisplayName = '';
    friendGroups: FriendGroup[] = [];

    draft: NotePayload = this.emptyDraft();
    editingId: string | null = null;
    /** True when viewing a note shared by someone else (no save / delete). */
    readOnly = false;
    capturingGps = false;
    draftHasGps = false;
    isCompressingPhotos = false;

    editorRecipients: NoteVisibilityRecipient[] = [];
    editorRecipientsLoading = false;
    editorRecipientsDetailOpen = false;

    linkPickerAppointments: NoteLinkOption[] = [];
    linkPickerActivities: NoteLinkOption[] = [];
    filteredLinkPickerAppointments: NoteLinkOption[] = [];
    filteredLinkPickerActivities: NoteLinkOption[] = [];
    linkPickerLoading = false;
    linkPickerError = false;
    linkPickerActivityFilter = '';
    linkPickerAppointmentFilter = '';

    /** Lightbox gallery state. */
    photoGallery: string[] = [];
    photoGalleryIndex = 0;

    private modalRef: NgbModalRef | null = null;
    private photoModalRef: NgbModalRef | null = null;
    private subs: Subscription[] = [];

    ngOnInit(): void {
        this.subs.push(this.route.queryParamMap.subscribe(params => {
            this.linkFilterEventId = (params.get('eventId') || '').trim() || null;
            this.linkFilterAppointmentId = (params.get('appointmentId') || '').trim() || null;
            this.pendingOpenNoteId = (params.get('noteId') || '').trim() || null;
            this.applyFilter();
            this.tryOpenPendingNote();
            this.cdr.markForCheck();
        }));
        this.subs.push(this.membersService.getUserId({ skipGeolocation: true }).subscribe({
            next: (m: Member) => {
                this.currentUserId = m.id || '';
                this.currentDisplayName = this.buildDisplayName(m);
                this.loadFriendGroups();
                this.refreshNotes();
            },
            error: () => {
                this.errorMessage = this.translate.instant('NOTES.LOAD_ERROR');
                this.cdr.markForCheck();
            }
        }));
    }

    ngOnDestroy(): void {
        this.subs.forEach(s => s.unsubscribe());
        this.photoModalRef?.dismiss();
        this.modalRef?.dismiss();
    }

    refreshNotes(): void {
        this.isLoading = true;
        this.errorMessage = '';
        this.cdr.markForCheck();
        this.subs.push(this.noteService.listAccessible().pipe(
            catchError(() => {
                this.errorMessage = this.translate.instant('NOTES.LOAD_ERROR');
                return of([] as Note[]);
            }),
            finalize(() => {
                this.isLoading = false;
                this.cdr.markForCheck();
            })
        ).subscribe(list => {
            this.notes = list || [];
            this.applyFilter();
            this.tryOpenPendingNote();
        }));
    }

    clearLinkFilter(): void {
        this.linkFilterEventId = null;
        this.linkFilterAppointmentId = null;
        this.pendingOpenNoteId = null;
        void this.router.navigate(['/notes'], { queryParams: {} });
        this.applyFilter();
    }

    hasLinkFilter(): boolean {
        return !!(this.linkFilterEventId || this.linkFilterAppointmentId);
    }

    onSearchChange(): void {
        this.applyFilter();
    }

    isOwner(note: Note | null | undefined): boolean {
        return !!note?.ownerMemberId && note.ownerMemberId === this.currentUserId;
    }

    /** Owner or Keycloak Admin may edit / delete. */
    canEdit(note: Note | null | undefined): boolean {
        return this.isOwner(note) || this.keycloak.hasAdminRole();
    }

    openCreate(): void {
        this.editingId = null;
        this.readOnly = false;
        this.editorErrorMessage = '';
        this.editorRecipientsDetailOpen = false;
        this.draft = this.emptyDraft();
        this.draft.color = this.randomColor();
        this.draft.ownerDisplayName = this.currentDisplayName;
        this.draftHasGps = false;
        this.capturingGps = true;
        this.refreshEditorRecipients();
        this.loadLinkPickerOptions();
        this.cdr.markForCheck();
        this.modalRef = this.modal.open(this.editModal, {
            size: 'lg',
            centered: true,
            backdrop: 'static',
            windowClass: 'notes-modal'
        });
        this.positionService.getGpsPosition().pipe(take(1)).subscribe(coords => {
            this.capturingGps = false;
            if (coords) {
                this.draft.latitude = coords.latitude;
                this.draft.longitude = coords.longitude;
                this.draftHasGps = true;
            }
            this.cdr.markForCheck();
        });
    }

    openEdit(note: Note, event?: Event): void {
        event?.stopPropagation();
        this.editingId = note.id || null;
        this.readOnly = !this.canEdit(note);
        this.editorErrorMessage = '';
        this.editorRecipientsDetailOpen = false;
        this.draft = {
            title: note.title || '',
            content: note.content || '',
            color: note.color || NOTE_COLORS[0],
            ownerDisplayName: note.ownerDisplayName || this.currentDisplayName,
            visibility: note.visibility || 'private',
            friendGroupId: note.friendGroupId || null,
            friendGroupIds: note.friendGroupIds ? [...note.friendGroupIds] : [],
            imageDataUrls: note.imageDataUrls ? [...note.imageDataUrls] : [],
            calendarAppointmentId: note.calendarAppointmentId || null,
            evenementId: note.evenementId || null
        };
        this.draftHasGps = note.latitude != null && note.longitude != null;
        this.draft.latitude = note.latitude;
        this.draft.longitude = note.longitude;
        this.capturingGps = false;
        if (!this.readOnly) {
            this.refreshEditorRecipients();
            this.loadLinkPickerOptions();
        }
        this.cdr.markForCheck();
        this.modalRef = this.modal.open(this.editModal, {
            size: 'lg',
            centered: true,
            backdrop: 'static',
            windowClass: 'notes-modal'
        });
    }

    closeModal(): void {
        this.modalRef?.dismiss();
        this.modalRef = null;
    }

    pickColor(color: string): void {
        if (this.readOnly) {
            return;
        }
        this.draft.color = color;
        this.cdr.markForCheck();
    }

    onVisibilityChange(): void {
        if (this.draft.visibility !== 'friendGroups') {
            this.draft.friendGroupIds = [];
            this.draft.friendGroupId = null;
        }
        this.refreshEditorRecipients();
        this.cdr.markForCheck();
    }

    toggleFriendGroupSelection(groupId: string): void {
        if (this.readOnly || !groupId) {
            return;
        }
        const ids = new Set(this.draft.friendGroupIds || []);
        if (ids.has(groupId)) {
            ids.delete(groupId);
        } else {
            ids.add(groupId);
        }
        this.draft.friendGroupIds = Array.from(ids);
        this.draft.friendGroupId = this.draft.friendGroupIds[0] || null;
        this.refreshEditorRecipients();
        this.cdr.markForCheck();
    }

    isFriendGroupSelected(groupId: string): boolean {
        return (this.draft.friendGroupIds || []).includes(groupId);
    }

    refreshEditorRecipients(): void {
        this.editorRecipientsLoading = true;
        this.cdr.markForCheck();
        this.subs.push(this.noteService.previewVisibilityRecipients({
            visibility: this.draft.visibility,
            friendGroupId: this.draft.friendGroupId,
            friendGroupIds: this.draft.friendGroupIds
        }).pipe(
            finalize(() => {
                this.editorRecipientsLoading = false;
                this.cdr.markForCheck();
            }),
            catchError(() => of([] as NoteVisibilityRecipient[]))
        ).subscribe(rs => {
            this.editorRecipients = rs || [];
        }));
    }

    toggleEditorRecipientsDetail(): void {
        this.editorRecipientsDetailOpen = !this.editorRecipientsDetailOpen;
        if (this.editorRecipientsDetailOpen) {
            this.refreshEditorRecipients();
        }
        this.cdr.markForCheck();
    }

    editorRecipientUsername(r: NoteVisibilityRecipient): string {
        const u = (r.userName ?? '').trim();
        if (!u) {
            return '';
        }
        const label = (r.displayName ?? '').trim();
        if (label && u.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0) {
            return '';
        }
        return u;
    }

    visibilityIcon(v?: string): string {
        switch (v) {
            case 'public': return 'fa-globe';
            case 'friends': return 'fa-users';
            case 'friendGroups': return 'fa-user-circle';
            case 'private': return 'fa-lock';
            default: return 'fa-lock';
        }
    }

    visibilityLabelKey(v?: string): string {
        switch (v) {
            case 'public': return 'NOTES.VISIBILITY.PUBLIC';
            case 'friends': return 'NOTES.VISIBILITY.FRIENDS';
            case 'friendGroups': return 'NOTES.VISIBILITY.FRIEND_GROUPS';
            case 'private': return 'NOTES.VISIBILITY.PRIVATE';
            default: return 'NOTES.VISIBILITY.PRIVATE';
        }
    }

    visibilityDisplay(note: Note | null): string {
        if (!note) {
            return '';
        }
        if (note.visibility === 'friendGroups') {
            const ids = note.friendGroupIds && note.friendGroupIds.length > 0
                ? note.friendGroupIds
                : (note.friendGroupId ? [note.friendGroupId] : []);
            if (ids.length > 0 && this.friendGroups.length > 0) {
                const names = ids
                    .map(id => this.friendGroups.find(g => g.id === id)?.name)
                    .filter((n): n is string => !!n);
                if (names.length > 0) {
                    return names.join(', ');
                }
            }
        }
        return this.translate.instant(this.visibilityLabelKey(note.visibility));
    }

    canSave(): boolean {
        if (this.readOnly || this.isSaving || this.isCompressingPhotos) {
            return false;
        }
        const title = (this.draft.title || '').trim();
        const content = (this.draft.content || '').trim();
        const photos = this.draft.imageDataUrls || [];
        return !!title || !!content || photos.length > 0;
    }

    photoCount(note: Note | NotePayload | null | undefined): number {
        return note?.imageDataUrls?.length || 0;
    }

    onPhotosSelected(event: Event): void {
        if (this.readOnly || this.isCompressingPhotos) {
            return;
        }
        const input = event.target as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        if (files.length === 0) {
            return;
        }
        const current = this.draft.imageDataUrls ? [...this.draft.imageDataUrls] : [];
        const remaining = MAX_PHOTOS_PER_NOTE - current.length;
        if (remaining <= 0) {
            this.editorErrorMessage = this.translate.instant('NOTES.PHOTOS_LIMIT', { max: MAX_PHOTOS_PER_NOTE });
            this.cdr.markForCheck();
            return;
        }
        const toAdd = files.slice(0, remaining);
        if (files.length > remaining) {
            this.editorErrorMessage = this.translate.instant('NOTES.PHOTOS_LIMIT', { max: MAX_PHOTOS_PER_NOTE });
        }
        const images = toAdd.filter(f => f.type.startsWith('image/'));
        if (images.length === 0) {
            this.editorErrorMessage = this.translate.instant('NOTES.PHOTO_INVALID');
            this.cdr.markForCheck();
            return;
        }
        if (images.length < toAdd.length) {
            this.editorErrorMessage = this.translate.instant('NOTES.PHOTO_INVALID');
        }
        void this.addCompressedPhotos(images);
    }

    private async addCompressedPhotos(files: File[]): Promise<void> {
        this.isCompressingPhotos = true;
        this.cdr.markForCheck();
        try {
            for (const file of files) {
                if ((this.draft.imageDataUrls?.length || 0) >= MAX_PHOTOS_PER_NOTE) {
                    this.editorErrorMessage = this.translate.instant('NOTES.PHOTOS_LIMIT', {
                        max: MAX_PHOTOS_PER_NOTE
                    });
                    break;
                }
                try {
                    // Same default as file upload: ~300 KB, max edge 1920 px.
                    const dataUrl = await this.imageCompression.compressToJpegDataUrl(file);
                    if (!dataUrl) {
                        continue;
                    }
                    if (!this.draft.imageDataUrls) {
                        this.draft.imageDataUrls = [];
                    }
                    if (this.draft.imageDataUrls.length >= MAX_PHOTOS_PER_NOTE) {
                        break;
                    }
                    this.draft.imageDataUrls = [...this.draft.imageDataUrls, dataUrl];
                    this.cdr.markForCheck();
                } catch {
                    this.editorErrorMessage = this.translate.instant('NOTES.PHOTO_COMPRESS_ERROR');
                }
            }
        } finally {
            this.isCompressingPhotos = false;
            this.cdr.markForCheck();
        }
    }

    removePhoto(index: number): void {
        if (this.readOnly || !this.draft.imageDataUrls) {
            return;
        }
        this.draft.imageDataUrls.splice(index, 1);
        this.cdr.markForCheck();
    }

    openNotePhotos(note: Note, index: number, event?: Event): void {
        const gallery = note.imageDataUrls || [];
        const src = gallery[index] || gallery[0];
        if (!src) {
            return;
        }
        this.openPhotoPreview(src, event, gallery);
    }

    openPhotoPreview(dataUrl: string, event?: Event, gallery?: string[] | null): void {
        event?.stopPropagation();
        if (!dataUrl) {
            return;
        }
        const list = (gallery && gallery.length > 0)
            ? gallery.filter(Boolean)
            : (this.draft.imageDataUrls || []).filter(Boolean);
        this.photoGallery = list.length > 0 ? list : [dataUrl];
        const idx = this.photoGallery.indexOf(dataUrl);
        this.photoGalleryIndex = idx >= 0 ? idx : 0;
        this.photoModalRef?.dismiss();
        this.photoModalRef = this.modal.open(this.photoModal, {
            size: 'xl',
            centered: true,
            windowClass: 'notes-photo-lightbox-window'
        });
        this.cdr.markForCheck();
    }

    closePhotoPreview(): void {
        this.photoModalRef?.dismiss();
        this.photoModalRef = null;
    }

    get currentPhoto(): string {
        return this.photoGallery[this.photoGalleryIndex] || '';
    }

    get hasPrevPhoto(): boolean {
        return this.photoGalleryIndex > 0;
    }

    get hasNextPhoto(): boolean {
        return this.photoGalleryIndex < this.photoGallery.length - 1;
    }

    prevPhoto(event?: Event): void {
        event?.stopPropagation();
        if (this.hasPrevPhoto) {
            this.photoGalleryIndex -= 1;
            this.cdr.markForCheck();
        }
    }

    nextPhoto(event?: Event): void {
        event?.stopPropagation();
        if (this.hasNextPhoto) {
            this.photoGalleryIndex += 1;
            this.cdr.markForCheck();
        }
    }

    save(): void {
        if (!this.canSave()) {
            return;
        }
        this.editorErrorMessage = '';
        if (this.draft.visibility === 'friendGroups'
            && (!this.draft.friendGroupIds || this.draft.friendGroupIds.length === 0)) {
            this.editorErrorMessage = this.translate.instant('NOTES.GROUP_REQUIRED');
            this.cdr.markForCheck();
            return;
        }

        this.isSaving = true;
        this.errorMessage = '';
        this.cdr.markForCheck();

        const payload: NotePayload = {
            title: (this.draft.title || '').trim() || null,
            content: (this.draft.content || '').trim() || null,
            color: this.draft.color || NOTE_COLORS[0],
            ownerDisplayName: this.draft.ownerDisplayName || this.currentDisplayName,
            visibility: this.draft.visibility || 'private',
            friendGroupId: this.draft.friendGroupId || null,
            friendGroupIds: this.draft.friendGroupIds || [],
            imageDataUrls: this.draft.imageDataUrls && this.draft.imageDataUrls.length > 0
                ? [...this.draft.imageDataUrls]
                : [],
            calendarAppointmentId: (this.draft.calendarAppointmentId || '').trim() || null,
            evenementId: (this.draft.evenementId || '').trim() || null
        };

        if (!this.editingId) {
            payload.latitude = this.draft.latitude ?? null;
            payload.longitude = this.draft.longitude ?? null;
            payload.gpsAccuracy = this.draft.gpsAccuracy ?? null;
        }

        const req$ = this.editingId
            ? this.noteService.update(this.editingId, payload)
            : this.noteService.create(payload);

        this.subs.push(req$.pipe(
            catchError(() => {
                this.errorMessage = this.translate.instant('NOTES.SAVE_ERROR');
                return of(null);
            }),
            finalize(() => {
                this.isSaving = false;
                this.cdr.markForCheck();
            })
        ).subscribe(saved => {
            if (saved) {
                this.closeModal();
                this.refreshNotes();
            }
        }));
    }

    deleteNote(note: Note, event?: Event): void {
        event?.stopPropagation();
        if (!note.id || !this.canEdit(note)) {
            return;
        }
        const ok = window.confirm(this.translate.instant('NOTES.DELETE_CONFIRM'));
        if (!ok) {
            return;
        }
        this.subs.push(this.noteService.delete(note.id).pipe(
            catchError(() => {
                this.errorMessage = this.translate.instant('NOTES.DELETE_ERROR');
                this.cdr.markForCheck();
                return of('error' as const);
            })
        ).subscribe(res => {
            if (res !== 'error') {
                this.notes = this.notes.filter(n => n.id !== note.id);
                this.applyFilter();
                this.cdr.markForCheck();
            }
        }));
    }

    trackById(_index: number, note: Note): string {
        return note.id || String(_index);
    }

    formatDate(value?: string): string {
        if (!value) {
            return '';
        }
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) {
            return '';
        }
        return d.toLocaleString();
    }

    formatCoords(note: Note): string {
        if (note.latitude == null || note.longitude == null) {
            return '';
        }
        return `${note.latitude.toFixed(5)}, ${note.longitude.toFixed(5)}`;
    }

    mapsUrl(note: Note): string | null {
        if (note.latitude == null || note.longitude == null) {
            return null;
        }
        return `https://www.openstreetmap.org/?mlat=${note.latitude}&mlon=${note.longitude}#map=16/${note.latitude}/${note.longitude}`;
    }

    hasLinkedActivity(note: Note | NotePayload | null | undefined): boolean {
        return !!(note?.evenementId || '').trim();
    }

    hasLinkedAppointment(note: Note | NotePayload | null | undefined): boolean {
        return !!(note?.calendarAppointmentId || '').trim();
    }

    openLinkedActivityPhotoWall(note: Note | NotePayload | null | undefined, event?: Event): void {
        event?.stopPropagation();
        const eventId = (note?.evenementId || '').trim();
        if (!eventId) {
            return;
        }
        this.closeModal();
        void this.router.navigate(['/photos'], { queryParams: { eventId } });
    }

    onAppointmentLinkSelect(value: string): void {
        const v = (value || '').trim();
        this.draft.calendarAppointmentId = v.length > 0 ? v : null;
        if (v.length > 0) {
            this.draft.evenementId = null;
            this.linkPickerActivityFilter = '';
            this.refreshFilteredLinkPickers();
        }
        this.cdr.markForCheck();
    }

    onActivityLinkSelect(value: string): void {
        const v = (value || '').trim();
        this.draft.evenementId = v.length > 0 ? v : null;
        if (v.length > 0) {
            this.draft.calendarAppointmentId = null;
            this.linkPickerAppointmentFilter = '';
            this.refreshFilteredLinkPickers();
        }
        this.cdr.markForCheck();
    }

    onLinkPickerActivityFilterChange(value: string): void {
        this.linkPickerActivityFilter = value || '';
        this.refreshFilteredLinkPickers();
        this.cdr.markForCheck();
    }

    onLinkPickerAppointmentFilterChange(value: string): void {
        this.linkPickerAppointmentFilter = value || '';
        this.refreshFilteredLinkPickers();
        this.cdr.markForCheck();
    }

    linkPickerSelectSize(filteredCount: number): number {
        const rows = filteredCount + 1;
        if (rows <= 1) {
            return 2;
        }
        return Math.min(5, rows);
    }

    private refreshFilteredLinkPickers(): void {
        this.filteredLinkPickerActivities = this.filterLinkOptions(
            this.linkPickerActivities,
            this.linkPickerActivityFilter,
            this.draft.evenementId
        );
        this.filteredLinkPickerAppointments = this.filterLinkOptions(
            this.linkPickerAppointments,
            this.linkPickerAppointmentFilter,
            this.draft.calendarAppointmentId
        );
    }

    private filterLinkOptions(
        options: NoteLinkOption[],
        filter: string,
        selectedId: string | null | undefined
    ): NoteLinkOption[] {
        const q = (filter || '').trim().toLocaleLowerCase();
        const selected = (selectedId || '').trim();
        if (!q) {
            return options;
        }
        const matched = options.filter(o => (o.label || '').toLocaleLowerCase().includes(q));
        if (selected && !matched.some(o => o.id === selected)) {
            const keep = options.find(o => o.id === selected);
            if (keep) {
                return [keep, ...matched];
            }
        }
        return matched;
    }

    private loadLinkPickerOptions(): void {
        if (this.readOnly) {
            this.linkPickerAppointments = [];
            this.linkPickerActivities = [];
            this.linkPickerActivityFilter = '';
            this.linkPickerAppointmentFilter = '';
            this.refreshFilteredLinkPickers();
            return;
        }
        this.linkPickerLoading = true;
        this.linkPickerError = false;
        this.linkPickerActivityFilter = '';
        this.linkPickerAppointmentFilter = '';
        this.cdr.markForCheck();
        const rangeFrom = new Date();
        rangeFrom.setFullYear(rangeFrom.getFullYear() - LINK_PICKER_RANGE_YEARS);
        const rangeTo = new Date();
        rangeTo.setFullYear(rangeTo.getFullYear() + LINK_PICKER_RANGE_YEARS);
        const chunks = this.buildCalendarEntryChunks(rangeFrom, rangeTo);
        if (chunks.length === 0) {
            this.linkPickerLoading = false;
            this.linkPickerAppointments = [];
            this.linkPickerActivities = [];
            this.ensureStaleLinkOptions();
            this.refreshFilteredLinkPickers();
            this.cdr.markForCheck();
            return;
        }
        this.subs.push(
            fromIterable(chunks).pipe(
                mergeMap(
                    (ch: { start: Date; end: Date }) => this.calendarService.getEntries(ch.start, ch.end).pipe(
                        map(rows => ({ ok: true as const, rows: rows || [] })),
                        catchError(() => of({ ok: false as const, rows: [] as CalendarEntry[] }))
                    ),
                    4
                ),
                reduce(
                    (acc, part) => {
                        if (part.ok) {
                            acc.okCount++;
                        }
                        acc.partCount++;
                        for (const e of part.rows) {
                            acc.merged.set(`${e.kind}:${e.id}`, e);
                        }
                        return acc;
                    },
                    {
                        merged: new Map<string, CalendarEntry>(),
                        okCount: 0,
                        partCount: 0
                    }
                ),
                finalize(() => {
                    this.linkPickerLoading = false;
                    this.cdr.markForCheck();
                })
            ).subscribe({
                next: ({ merged, okCount, partCount }) => {
                    const list = Array.from(merged.values());
                    this.linkPickerAppointments = list
                        .filter(e => e.kind === 'APPOINTMENT')
                        .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
                        .map(e => ({ id: e.id, label: this.formatCalendarEntryLabel(e) }));
                    this.linkPickerActivities = list
                        .filter(e => e.kind === 'ACTIVITY')
                        .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
                        .map(e => ({ id: e.id, label: this.formatCalendarEntryLabel(e) }));
                    this.linkPickerError = partCount > 0 && okCount === 0;
                    this.ensureStaleLinkOptions();
                    this.refreshFilteredLinkPickers();
                    this.cdr.markForCheck();
                },
                error: () => {
                    this.linkPickerAppointments = [];
                    this.linkPickerActivities = [];
                    this.linkPickerError = true;
                    this.ensureStaleLinkOptions();
                    this.refreshFilteredLinkPickers();
                    this.cdr.markForCheck();
                }
            })
        );
    }

    private buildCalendarEntryChunks(rangeStart: Date, rangeEnd: Date): { start: Date; end: Date }[] {
        const out: { start: Date; end: Date }[] = [];
        const t0 = rangeStart.getTime();
        const t1 = rangeEnd.getTime();
        if (!(t1 > t0)) {
            return out;
        }
        let cur = t0;
        while (cur < t1) {
            const end = Math.min(cur + CALENDAR_ENTRIES_CHUNK_MS, t1);
            out.push({ start: new Date(cur), end: new Date(end) });
            cur = end;
        }
        return out;
    }

    private formatCalendarEntryLabel(e: CalendarEntry): string {
        const title = (e.title || '').trim() || '—';
        const start = new Date(e.start);
        if (Number.isNaN(start.getTime())) {
            return title;
        }
        const rawLang = (this.translate.currentLang || 'fr').trim().replace(/_/g, '-');
        const primary = rawLang.split('-')[0] || 'fr';
        try {
            const d = start.toLocaleString(rawLang, { dateStyle: 'medium', timeStyle: 'short' });
            return `${title} · ${d}`;
        } catch {
            try {
                const d = start.toLocaleString(primary, { dateStyle: 'medium', timeStyle: 'short' });
                return `${title} · ${d}`;
            } catch {
                return `${title} · ${start.toISOString()}`;
            }
        }
    }

    private ensureStaleLinkOptions(): void {
        const apId = (this.draft.calendarAppointmentId || '').trim();
        if (apId && !this.linkPickerAppointments.some(o => o.id === apId)) {
            this.linkPickerAppointments = [
                {
                    id: apId,
                    label: this.translate.instant('NOTES.LINK_STALE_APPOINTMENT', { id: apId })
                },
                ...this.linkPickerAppointments
            ];
        }
        const evId = (this.draft.evenementId || '').trim();
        if (evId && !this.linkPickerActivities.some(o => o.id === evId)) {
            this.linkPickerActivities = [
                {
                    id: evId,
                    label: this.translate.instant('NOTES.LINK_STALE_ACTIVITY', { id: evId })
                },
                ...this.linkPickerActivities
            ];
        }
    }

    rotationClass(note: Note): string {
        const seed = (note.id || note.title || 'x').charCodeAt(0) + (note.id?.length || 0);
        const idx = Math.abs(seed) % 5;
        return `notes-postit--tilt${idx}`;
    }

    private loadFriendGroups(): void {
        this.subs.push(this.friendsService.getFriendGroups().pipe(
            catchError(() => of([] as FriendGroup[]))
        ).subscribe(groups => {
            this.friendGroups = (groups || []).slice().sort((a, b) =>
                (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
            );
            this.cdr.markForCheck();
        }));
    }

    private applyFilter(): void {
        const q = (this.searchTerm || '').trim().toLowerCase();
        let list = [...this.notes];
        if (this.linkFilterEventId) {
            list = list.filter(n => (n.evenementId || '').trim() === this.linkFilterEventId);
        } else if (this.linkFilterAppointmentId) {
            list = list.filter(n => (n.calendarAppointmentId || '').trim() === this.linkFilterAppointmentId);
        }
        if (q) {
            list = list.filter(n => {
                const hay = `${n.title || ''} ${n.content || ''} ${n.ownerDisplayName || ''}`.toLowerCase();
                return hay.includes(q);
            });
        }
        this.filteredNotes = list;
        this.cdr.markForCheck();
    }

    private tryOpenPendingNote(): void {
        const id = (this.pendingOpenNoteId || '').trim();
        if (!id || !this.notes.length) {
            return;
        }
        const note = this.notes.find(n => (n.id || '').trim() === id);
        if (!note) {
            return;
        }
        this.pendingOpenNoteId = null;
        this.openEdit(note);
    }

    private emptyDraft(): NotePayload {
        return {
            title: '',
            content: '',
            color: NOTE_COLORS[0],
            latitude: null,
            longitude: null,
            gpsAccuracy: null,
            ownerDisplayName: '',
            visibility: 'private',
            friendGroupId: null,
            friendGroupIds: [],
            imageDataUrls: [],
            calendarAppointmentId: null,
            evenementId: null
        };
    }

    private randomColor(): string {
        return NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];
    }

    private buildDisplayName(m: Member): string {
        const full = `${m.firstName || ''} ${m.lastName || ''}`.trim();
        if (full) {
            return full;
        }
        return m.userName || m.addressEmail || '';
    }
}
