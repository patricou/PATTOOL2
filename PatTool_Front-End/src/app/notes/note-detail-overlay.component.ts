import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    OnDestroy,
    OnInit,
    inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { Subscription, from as fromIterable, of } from 'rxjs';
import { catchError, finalize, map, mergeMap, reduce } from 'rxjs/operators';
import {
    Note,
    NotePayload,
    NoteService,
    NoteVisibility,
    NoteVisibilityRecipient
} from './note.service';
import { MembersService } from '../services/members.service';
import { FriendsService } from '../services/friends.service';
import { ImageCompressionService } from '../services/image-compression.service';
import { CalendarEntry, CalendarService } from '../calendar/calendar.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { Member } from '../model/member';
import { FriendGroup } from '../model/friend';

/** Same curated post-it palette as notes.component (duplicated to avoid circular imports). */
const NOTE_COLORS: string[] = [
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
const CALENDAR_ENTRIES_CHUNK_MS = 360 * 24 * 60 * 60 * 1000;
const LINK_PICKER_RANGE_YEARS = 15;

interface NoteLinkOption {
    id: string;
    label: string;
}

@Component({
    selector: 'app-note-detail-overlay',
    standalone: true,
    imports: [CommonModule, FormsModule, TranslateModule],
    templateUrl: './note-detail-overlay.component.html',
    styleUrls: ['./note-detail-overlay.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class NoteDetailOverlayComponent implements OnInit, OnDestroy {
    readonly activeModal = inject(NgbActiveModal);
    private readonly noteService = inject(NoteService);
    private readonly membersService = inject(MembersService);
    private readonly friendsService = inject(FriendsService);
    private readonly imageCompression = inject(ImageCompressionService);
    private readonly calendarService = inject(CalendarService);
    private readonly keycloak = inject(KeycloakService);
    private readonly translate = inject(TranslateService);
    private readonly cdr = inject(ChangeDetectorRef);

    /** Set by {@link NoteDetailOverlayService} before first change detection. */
    noteId = '';

    readonly colorPalette = NOTE_COLORS;
    readonly visibilityPresets = VISIBILITY_PRESETS;
    readonly maxPhotos = MAX_PHOTOS_PER_NOTE;

    note: Note | null = null;
    draft: NotePayload = { title: '', content: '', color: NOTE_COLORS[0] };
    loading = true;
    loadError = false;
    isSaving = false;
    saveError = '';
    currentUserId = '';
    /** Post-it preview first; edit form only after explicit action. */
    editing = false;

    friendGroups: FriendGroup[] = [];
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

    private subs: Subscription[] = [];

    ngOnInit(): void {
        this.subs.push(
            this.membersService.getUserId({ skipGeolocation: true }).subscribe({
                next: (m: Member) => {
                    this.currentUserId = (m.id || '').trim();
                    this.cdr.markForCheck();
                },
                error: () => {
                    this.currentUserId = '';
                }
            })
        );
        this.loadFriendGroups();
        const id = (this.noteId || '').trim();
        if (!id) {
            this.loading = false;
            this.loadError = true;
            return;
        }
        this.subs.push(
            this.noteService.getOne(id).pipe(
                catchError(() => of(null)),
                finalize(() => {
                    this.loading = false;
                    this.cdr.markForCheck();
                })
            ).subscribe(doc => {
                if (!doc?.id) {
                    this.loadError = true;
                    return;
                }
                this.note = doc;
                this.resetDraftFromNote(doc);
                this.editing = false;
                this.cdr.markForCheck();
            })
        );
    }

    ngOnDestroy(): void {
        this.subs.forEach(s => s.unsubscribe());
    }

    isOwner(): boolean {
        return !!this.note?.ownerMemberId && this.note.ownerMemberId === this.currentUserId;
    }

    canEdit(): boolean {
        return this.isOwner() || this.keycloak.hasAdminRole();
    }

    startEditing(): void {
        if (!this.canEdit() || !this.note) {
            return;
        }
        this.resetDraftFromNote(this.note);
        this.saveError = '';
        this.editorRecipientsDetailOpen = false;
        this.editing = true;
        this.refreshEditorRecipients();
        this.loadLinkPickerOptions();
        this.cdr.markForCheck();
    }

    cancelEditing(): void {
        if (this.note) {
            this.resetDraftFromNote(this.note);
        }
        this.saveError = '';
        this.editorRecipientsDetailOpen = false;
        this.editing = false;
        this.cdr.markForCheck();
    }

    photoCount(): number {
        return (this.draft.imageDataUrls || []).filter(Boolean).length;
    }

    pickColor(color: string): void {
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
        if (!groupId) {
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

    canSave(): boolean {
        if (!this.canEdit() || this.isSaving || this.isCompressingPhotos) {
            return false;
        }
        const title = (this.draft.title || '').trim();
        const content = (this.draft.content || '').trim();
        const photos = this.draft.imageDataUrls || [];
        return !!title || !!content || photos.length > 0;
    }

    onPhotosSelected(event: Event): void {
        if (this.isCompressingPhotos) {
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
            this.saveError = this.translate.instant('NOTES.PHOTOS_LIMIT', { max: MAX_PHOTOS_PER_NOTE });
            this.cdr.markForCheck();
            return;
        }
        const toAdd = files.slice(0, remaining);
        if (files.length > remaining) {
            this.saveError = this.translate.instant('NOTES.PHOTOS_LIMIT', { max: MAX_PHOTOS_PER_NOTE });
        }
        const images = toAdd.filter(f => f.type.startsWith('image/'));
        if (images.length === 0) {
            this.saveError = this.translate.instant('NOTES.PHOTO_INVALID');
            this.cdr.markForCheck();
            return;
        }
        if (images.length < toAdd.length) {
            this.saveError = this.translate.instant('NOTES.PHOTO_INVALID');
        }
        void this.addCompressedPhotos(images);
    }

    private async addCompressedPhotos(files: File[]): Promise<void> {
        this.isCompressingPhotos = true;
        this.cdr.markForCheck();
        try {
            for (const file of files) {
                if ((this.draft.imageDataUrls?.length || 0) >= MAX_PHOTOS_PER_NOTE) {
                    this.saveError = this.translate.instant('NOTES.PHOTOS_LIMIT', {
                        max: MAX_PHOTOS_PER_NOTE
                    });
                    break;
                }
                try {
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
                    this.saveError = this.translate.instant('NOTES.PHOTO_COMPRESS_ERROR');
                }
            }
        } finally {
            this.isCompressingPhotos = false;
            this.cdr.markForCheck();
        }
    }

    removePhoto(index: number): void {
        if (!this.draft.imageDataUrls) {
            return;
        }
        this.draft.imageDataUrls.splice(index, 1);
        this.cdr.markForCheck();
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

    save(): void {
        if (!this.canSave() || !this.note?.id) {
            return;
        }
        this.saveError = '';
        if (this.draft.visibility === 'friendGroups'
            && (!this.draft.friendGroupIds || this.draft.friendGroupIds.length === 0)) {
            this.saveError = this.translate.instant('NOTES.GROUP_REQUIRED');
            this.cdr.markForCheck();
            return;
        }
        this.isSaving = true;
        this.cdr.markForCheck();
        const payload: NotePayload = {
            title: (this.draft.title || '').trim() || null,
            content: (this.draft.content || '').trim() || null,
            color: this.draft.color || NOTE_COLORS[0],
            ownerDisplayName: this.draft.ownerDisplayName || null,
            visibility: this.draft.visibility || 'private',
            friendGroupId: this.draft.friendGroupId || null,
            friendGroupIds: this.draft.friendGroupIds || [],
            imageDataUrls: this.draft.imageDataUrls && this.draft.imageDataUrls.length > 0
                ? [...this.draft.imageDataUrls]
                : [],
            calendarAppointmentId: (this.draft.calendarAppointmentId || '').trim() || null,
            evenementId: (this.draft.evenementId || '').trim() || null
        };
        this.subs.push(
            this.noteService.update(this.note.id, payload).pipe(
                catchError(() => {
                    this.saveError = this.translate.instant('NOTES.SAVE_ERROR');
                    return of(null);
                }),
                finalize(() => {
                    this.isSaving = false;
                    this.cdr.markForCheck();
                })
            ).subscribe(saved => {
                if (saved) {
                    this.note = saved;
                    this.resetDraftFromNote(saved);
                    this.editing = false;
                    this.editorRecipientsDetailOpen = false;
                    this.cdr.markForCheck();
                }
            })
        );
    }

    private resetDraftFromNote(doc: Note): void {
        this.draft = {
            title: doc.title || '',
            content: doc.content || '',
            color: doc.color || NOTE_COLORS[0],
            ownerDisplayName: doc.ownerDisplayName || '',
            visibility: doc.visibility || 'private',
            friendGroupId: doc.friendGroupId || null,
            friendGroupIds: doc.friendGroupIds ? [...doc.friendGroupIds] : [],
            imageDataUrls: doc.imageDataUrls ? [...doc.imageDataUrls] : [],
            calendarAppointmentId: doc.calendarAppointmentId || null,
            evenementId: doc.evenementId || null
        };
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
}
