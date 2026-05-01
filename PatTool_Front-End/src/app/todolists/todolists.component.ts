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
import { QuillModule } from 'ngx-quill';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Subscription, forkJoin, from, of } from 'rxjs';
import { catchError, distinctUntilChanged, finalize, map, switchMap } from 'rxjs/operators';
import {
    TodoItem,
    TodoList,
    TodoListService,
    TodoPriority,
    TodoShareEmailPayload,
    TodoStatus,
    TodoVisibility,
    TodoVisibilityRecipient
} from './todolist.service';
import { FriendsService } from '../services/friends.service';
import { MembersService } from '../services/members.service';
import { KeycloakService } from '../keycloak/keycloak.service';
import { FriendGroup } from '../model/friend';
import { Member } from '../model/member';
import { environment } from '../../environments/environment';
import { CalendarEntry, CalendarService } from '../calendar/calendar.service';

interface OwnerLabel {
    id: string;
    label: string;
    initials: string;
}

interface ListMeta {
    completed: number;
    total: number;
    percent: number;
    overdue: boolean;
    daysUntilDue: number | null;
}

/** One row for agenda / activity pickers in the list editor. */
interface TodolistLinkOption {
    id: string;
    label: string;
}

const VISIBILITY_PRESETS: TodoVisibility[] = ['private', 'friends', 'friendGroups', 'public'];
const STATUS_PRESETS: TodoStatus[] = ['open', 'in_progress', 'done', 'archived'];
const ITEM_STATUS_PRESETS: TodoStatus[] = ['open', 'in_progress', 'done'];
const PRIORITY_PRESETS: TodoPriority[] = ['low', 'normal', 'high'];

/** Each {@code GET /api/calendar/entries} call must stay under the back-end window (~370 days). */
const CALENDAR_ENTRIES_CHUNK_MS = 350 * 24 * 60 * 60 * 1000;

type TodolistSortKey =
    | 'created_desc'
    | 'created_asc'
    | 'name_asc'
    | 'name_desc';

/**
 * Shareable to-do lists. Acts as both index (cards grid) and editor (modal-based create / edit).
 * Anyone in the list visibility group can flip individual item statuses; only the owner can
 * delete a list or change its sharing settings.
 */
@Component({
    selector: 'app-todolists',
    standalone: true,
    imports: [CommonModule, FormsModule, TranslateModule, NgbModalModule, QuillModule],
    templateUrl: './todolists.component.html',
    styleUrls: ['./todolists.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class TodolistsComponent implements OnInit, OnDestroy {

    @ViewChild('editModal') editModal!: TemplateRef<unknown>;
    @ViewChild('detailsModal') detailsModal!: TemplateRef<unknown>;
    @ViewChild('shareModal') shareModal!: TemplateRef<unknown>;

    private todoService = inject(TodoListService);
    private friendsService = inject(FriendsService);
    private membersService = inject(MembersService);
    private keycloak = inject(KeycloakService);
    private translate = inject(TranslateService);
    private modal = inject(NgbModal);
    private cdr = inject(ChangeDetectorRef);
    private http = inject(HttpClient);
    private sanitizer = inject(DomSanitizer);
    private route = inject(ActivatedRoute);
    private calendarService = inject(CalendarService);

    /** Same toolbar as the commentary editor used by events: full font / colour / size / etc. */
    readonly quillModules: Record<string, unknown> = {
        toolbar: [
            ['bold', 'italic', 'underline', 'strike'],
            ['blockquote', 'code-block'],
            [{ header: [1, 2, 3, 4, 5, 6, false] }],
            [{ list: 'ordered' }, { list: 'bullet' }],
            [{ script: 'sub' }, { script: 'super' }],
            [{ indent: '-1' }, { indent: '+1' }],
            [{ direction: 'rtl' }],
            [{ size: ['small', false, 'large', 'huge'] }],
            [{ color: [] }, { background: [] }],
            [{ font: [] }],
            [{ align: [] }],
            ['clean'],
            ['link']
        ]
    };

    /** Trust HTML produced by Quill so the details view renders the formatting back. */
    safeHtml(value?: string | null): SafeHtml {
        if (!value) {
            return '';
        }
        return this.sanitizer.bypassSecurityTrustHtml(value);
    }

    /**
     * Strip Quill's empty-paragraph artefact ({@code <p><br></p>}) from an HTML value so
     * the caller can quickly know whether the user actually entered content.
     */
    private isHtmlEmpty(value?: string | null): boolean {
        if (!value) {
            return true;
        }
        const stripped = value
            .replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, '')
            .trim();
        return stripped.length === 0;
    }

    readonly visibilityPresets = VISIBILITY_PRESETS;
    readonly statusPresets = STATUS_PRESETS;
    readonly itemStatusPresets = ITEM_STATUS_PRESETS;
    readonly priorityPresets = PRIORITY_PRESETS;

    lists: TodoList[] = [];
    metaById = new Map<string, ListMeta>();
    ownerCache = new Map<string, OwnerLabel>();
    currentUserId = '';

    isLoading = false;
    errorMessage = '';

    friendGroups: FriendGroup[] = [];

    // Editor state
    editing: TodoList = this.blankList();
    isNew = true;
    editorErrorMessage = '';
    editorSaving = false;
    editorRecipients: TodoVisibilityRecipient[] = [];
    editorRecipientsLoading = false;
    /** Expanded panel listing members who can see the list (preview from current editor fields). */
    editorRecipientsDetailOpen = false;
    private editorModalRef: NgbModalRef | null = null;

    // Details state
    detailsList: TodoList | null = null;
    detailsRecipients: TodoVisibilityRecipient[] = [];
    detailsAssigneeMap = new Map<string, string>();
    private detailsModalRef: NgbModalRef | null = null;

    // Share state
    shareList: TodoList | null = null;
    shareMode: 'email' | 'whatsapp' = 'email';
    shareRecipients: TodoVisibilityRecipient[] = [];
    shareSelectedMemberIds = new Set<string>();
    shareExtraEmails = '';
    shareCustomMessage = '';
    shareSending = false;
    shareErrorMessage = '';
    shareSuccessMessage = '';
    shareRecipientsLoading = false;
    private shareModalRef: NgbModalRef | null = null;

    // Filter state
    statusFilter: '' | TodoStatus = '';
    searchTerm = '';
    /** Display order on the grid (after search / status filters). */
    listSortKey: TodolistSortKey = 'created_desc';

    /** Agenda / activity rows for linking (owner editor only). */
    linkPickerAppointments: TodolistLinkOption[] = [];
    linkPickerActivities: TodolistLinkOption[] = [];
    linkPickerLoading = false;
    linkPickerError = false;

    private subs: Subscription[] = [];

    ngOnInit(): void {
        this.subs.push(this.membersService.getUserId({ skipGeolocation: true }).subscribe({
            next: m => {
                this.currentUserId = m.id || '';
                this.loadFriendGroups();
                this.refreshLists();
                this.subscribeTodoListDeepLink();
            },
            error: () => {
                this.refreshLists();
                this.subscribeTodoListDeepLink();
            }
        }));
    }

    /**
     * Ouvre la modale détail quand l’URL contient {@code ?list=<id>} (lien partagé par e-mail / WhatsApp).
     * Compatible {@link HashLocationStrategy}: {@code #/todolists?list=…}.
     */
    private subscribeTodoListDeepLink(): void {
        this.subs.push(this.route.queryParams.pipe(
            map(p => {
                const v = p['list'];
                if (typeof v === 'string') {
                    return v.trim();
                }
                if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
                    return v[0].trim();
                }
                return '';
            }),
            distinctUntilChanged()
        ).subscribe(listId => {
            if (listId) {
                this.tryOpenListFromDeepLink(listId);
            }
        }));
    }

    private tryOpenListFromDeepLink(listId: string): void {
        if (!listId) {
            return;
        }
        const local = this.lists.find(l => l.id === listId);
        if (local) {
            this.openDetails(local);
            return;
        }
        this.subs.push(this.todoService.getOne(listId).pipe(
            catchError(() => of(null as TodoList | null))
        ).subscribe(full => {
            if (!full?.id) {
                return;
            }
            if (!this.lists.some(l => l.id === full.id)) {
                this.lists = [full, ...this.lists];
                this.recomputeMeta();
                this.fetchOwnerLabels();
            }
            this.openDetails(full);
            this.cdr.markForCheck();
        }));
    }

    /**
     * Lien pour e-mail / WhatsApp : page statique sans {@code #}, car WhatsApp (entre autres)
     * ne rend souvent pas cliquables les URL dont le fragment contient la route Angular.
     * {@code todolist-link.html} redirige vers {@code #/todolists?list=…}.
     */
    private buildTodolistDeepLink(listId: string): string {
        const u = new URL(window.location.href);
        let path = u.pathname || '/';
        if (path.length > 1 && path.endsWith('/')) {
            path = path.slice(0, -1);
        }
        const marker = '/assets/todolist-link.html';
        const at = path.indexOf(marker);
        let basePath: string;
        if (at >= 0) {
            basePath = path.substring(0, at);
        } else if (path === '/') {
            basePath = '';
        } else if (path.endsWith('/index.html')) {
            basePath = path.slice(0, -'/index.html'.length);
            if (basePath === '/') {
                basePath = '';
            }
        } else {
            basePath = path;
        }
        return `${u.origin}${basePath}/assets/todolist-link.html?list=${encodeURIComponent(listId)}`;
    }

    ngOnDestroy(): void {
        this.subs.forEach(s => s.unsubscribe());
    }

    // ---------- Loading -----------------------------------------------------

    refreshLists(): void {
        this.isLoading = true;
        this.errorMessage = '';
        this.subs.push(this.todoService.listAccessible().pipe(
            finalize(() => {
                this.isLoading = false;
                this.cdr.markForCheck();
            })
        ).subscribe({
            next: lists => {
                this.lists = lists || [];
                this.recomputeMeta();
                this.fetchOwnerLabels();
            },
            error: () => {
                this.errorMessage = this.translate.instant('TODOLISTS.LOAD_ERROR');
            }
        }));
    }

    private loadFriendGroups(): void {
        this.subs.push(this.friendsService.getFriendGroups().pipe(
            catchError(() => of([] as FriendGroup[]))
        ).subscribe(groups => {
            this.friendGroups = (groups || []).slice().sort((a, b) =>
                (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
            this.cdr.markForCheck();
        }));
    }

    private recomputeMeta(): void {
        const map = new Map<string, ListMeta>();
        for (const list of this.lists) {
            const items = list.items || [];
            const total = items.length;
            const completed = items.filter(i => i.status === 'done').length;
            const percent = total === 0 ? 0 : Math.round((completed / total) * 100);
            let daysUntilDue: number | null = null;
            let overdue = false;
            if (list.dueDate) {
                const due = new Date(list.dueDate).getTime();
                const now = Date.now();
                daysUntilDue = Math.ceil((due - now) / (24 * 3600 * 1000));
                overdue = due < now && list.status !== 'done' && list.status !== 'archived';
            }
            map.set(list.id || '', { completed, total, percent, overdue, daysUntilDue });
        }
        this.metaById = map;
    }

    /**
     * Resolves owner display labels for every visible list.
     * Issues {@code GET /api/memb/{id}} per id (reusing the Keycloak bearer token),
     * caching results so re-renders don't refetch.
     */
    private fetchOwnerLabels(): void {
        const ids = new Set<string>();
        for (const list of this.lists) {
            if (list.ownerMemberId) {
                ids.add(list.ownerMemberId);
            }
        }
        const missing = Array.from(ids).filter(id => !this.ownerCache.has(id));
        if (missing.length === 0) {
            return;
        }
        from(this.keycloak.getToken()).pipe(
            map(token => new HttpHeaders({
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: token ? 'Bearer ' + token : ''
            })),
            switchMap(headers => forkJoin(missing.map(id =>
                this.http.get<Member>(`${environment.API_URL}memb/${id}`, { headers }).pipe(
                    map(m => ({ id, member: m })),
                    catchError(() => of({ id, member: null as Member | null }))
                )
            ))),
            catchError(() => of([] as Array<{ id: string; member: Member | null }>))
        ).subscribe(results => {
            for (const r of results) {
                this.ownerCache.set(r.id, this.toOwnerLabel(r.id, r.member));
            }
            this.cdr.markForCheck();
        });
    }

    private toOwnerLabel(id: string, member: Member | null): OwnerLabel {
        if (!member) {
            return { id, label: id.slice(0, 8), initials: '?' };
        }
        const first = (member.firstName || '').trim();
        const last = (member.lastName || '').trim();
        const full = (first + ' ' + last).trim();
        const label = full || (member.userName || '').trim() || id.slice(0, 8);
        const initials = (first.charAt(0) + last.charAt(0)).toUpperCase()
            || (member.userName || '?').charAt(0).toUpperCase();
        return { id, label, initials };
    }

    // ---------- Filtering ---------------------------------------------------

    get filteredLists(): TodoList[] {
        const term = this.searchTerm.trim().toLowerCase();
        const stripTags = (s?: string | null) => (s || '').replace(/<[^>]+>/g, ' ').toLowerCase();
        const filtered = this.lists.filter(l => {
            if (this.statusFilter && l.status !== this.statusFilter) {
                return false;
            }
            if (term) {
                const inName = (l.name || '').toLowerCase().includes(term);
                const inDesc = stripTags(l.description).includes(term);
                const inItems = (l.items || []).some(it =>
                    (it.title || '').toLowerCase().includes(term)
                    || stripTags(it.description).includes(term));
                return inName || inDesc || inItems;
            }
            return true;
        });

        const time = (l: TodoList) => {
            const t = l.createdAt ? new Date(l.createdAt).getTime() : 0;
            return Number.isNaN(t) ? 0 : t;
        };

        return filtered.slice().sort((a, b) => {
            switch (this.listSortKey) {
                case 'name_asc':
                    return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
                case 'name_desc':
                    return (b.name || '').localeCompare(a.name || '', undefined, { sensitivity: 'base' });
                case 'created_asc':
                    return time(a) - time(b);
                case 'created_desc':
                default:
                    return time(b) - time(a);
            }
        });
    }

    // ---------- Owner / labels helpers --------------------------------------

    ownerLabelFor(list: TodoList): string {
        if (!list.ownerMemberId) {
            return '';
        }
        return this.ownerCache.get(list.ownerMemberId)?.label || list.ownerMemberId.slice(0, 8);
    }

    ownerInitialsFor(list: TodoList): string {
        if (!list.ownerMemberId) {
            return '?';
        }
        return this.ownerCache.get(list.ownerMemberId)?.initials || '?';
    }

    isOwner(list: TodoList | null): boolean {
        return !!(list && list.ownerMemberId && list.ownerMemberId === this.currentUserId);
    }

    metaFor(list: TodoList): ListMeta {
        return this.metaById.get(list.id || '') || { completed: 0, total: 0, percent: 0, overdue: false, daysUntilDue: null };
    }

    statusBadgeClass(status?: TodoStatus | string): string {
        switch (status) {
            case 'done': return 'badge bg-success';
            case 'in_progress': return 'badge bg-warning text-dark';
            case 'archived': return 'badge bg-secondary';
            default: return 'badge bg-primary';
        }
    }

    visibilityIcon(v?: string): string {
        switch (v) {
            case 'public': return 'fa-globe';
            case 'friends': return 'fa-users';
            case 'friendGroups': return 'fa-user-circle';
            case 'private': return 'fa-lock';
            default: return 'fa-user-circle';
        }
    }

    visibilityLabelKey(v?: string): string {
        switch (v) {
            case 'public': return 'TODOLISTS.VISIBILITY.PUBLIC';
            case 'friends': return 'TODOLISTS.VISIBILITY.FRIENDS';
            case 'friendGroups': return 'TODOLISTS.VISIBILITY.FRIEND_GROUPS';
            case 'private': return 'TODOLISTS.VISIBILITY.PRIVATE';
            default: return 'TODOLISTS.VISIBILITY.PRIVATE';
        }
    }

    /**
     * Display label for the visibility chip / line. When the list is shared with
     * specific friend groups we list their names instead of the generic
     * "Friend groups" label.
     */
    visibilityDisplay(list: TodoList | null): string {
        if (!list) {
            return '';
        }
        if (list.visibility === 'friendGroups') {
            const ids = list.friendGroupIds && list.friendGroupIds.length > 0
                ? list.friendGroupIds
                : (list.friendGroupId ? [list.friendGroupId] : []);
            if (ids.length > 0 && this.friendGroups.length > 0) {
                const names = ids
                    .map(id => this.friendGroups.find(g => g.id === id)?.name)
                    .filter((n): n is string => !!n && n.trim().length > 0);
                if (names.length > 0) {
                    return names.join(', ');
                }
            }
        }
        return this.translate.instant(this.visibilityLabelKey(list.visibility));
    }

    // ---------- Editor (create / edit) --------------------------------------

    openCreate(): void {
        this.editing = this.blankList();
        this.editing.ownerMemberId = this.currentUserId;
        this.isNew = true;
        this.editorErrorMessage = '';
        this.editorRecipients = [];
        this.editorRecipientsDetailOpen = false;
        this.editorModalRef = this.modal.open(this.editModal, {
            size: 'lg',
            scrollable: true,
            windowClass: 'todolists-modal',
            modalDialogClass: 'todolists-editor-dialog'
        });
        this.refreshEditorRecipients();
        this.loadLinkPickerOptions();
    }

    openEdit(list: TodoList): void {
        this.editing = JSON.parse(JSON.stringify(list)) as TodoList;
        this.editing.items = (this.editing.items || []).map(it => ({ ...it }));
        this.isNew = false;
        this.editorErrorMessage = '';
        this.editorRecipients = [];
        this.editorRecipientsDetailOpen = false;
        this.editorModalRef = this.modal.open(this.editModal, {
            size: 'lg',
            scrollable: true,
            windowClass: 'todolists-modal',
            modalDialogClass: 'todolists-editor-dialog'
        });
        this.refreshEditorRecipients();
        this.loadLinkPickerOptions();
    }

    addItem(): void {
        const items = this.editing.items || [];
        items.push({
            title: '',
            status: 'open',
            priority: 'normal',
            description: ''
        });
        this.editing.items = items;
    }

    removeItem(index: number): void {
        if (!this.editing.items) return;
        this.editing.items.splice(index, 1);
    }

    onCoverFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files && input.files[0];
        if (!file) {
            return;
        }
        if (!file.type.startsWith('image/')) {
            this.editorErrorMessage = this.translate.instant('TODOLISTS.IMAGE_INVALID');
            return;
        }
        // Compress in-browser via canvas; max 1280 wide, JPEG q=0.8.
        const img = new Image();
        const reader = new FileReader();
        reader.onload = ev => {
            img.onload = () => {
                const maxW = 1280;
                const ratio = Math.min(1, maxW / img.width);
                const w = Math.round(img.width * ratio);
                const h = Math.round(img.height * ratio);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return;
                }
                ctx.drawImage(img, 0, 0, w, h);
                this.editing.imageDataUrl = canvas.toDataURL('image/jpeg', 0.8);
                this.cdr.markForCheck();
            };
            img.src = ev.target?.result as string;
        };
        reader.readAsDataURL(file);
        input.value = '';
    }

    clearCoverImage(): void {
        this.editing.imageDataUrl = null;
    }

    refreshEditorRecipients(): void {
        this.editorRecipientsLoading = true;
        this.subs.push(this.todoService.previewVisibilityRecipients({
            visibility: this.editing.visibility,
            friendGroupId: this.editing.friendGroupId,
            friendGroupIds: this.editing.friendGroupIds
        }).pipe(
            finalize(() => {
                this.editorRecipientsLoading = false;
                this.cdr.markForCheck();
            }),
            catchError(() => of([] as TodoVisibilityRecipient[]))
        ).subscribe(rs => {
            this.editorRecipients = rs || [];
            // Drop assignees that are no longer in the visibility group.
            const valid = new Set(this.editorRecipients.map(r => r.memberId));
            valid.add(this.currentUserId);
            for (const item of this.editing.items || []) {
                if (item.assigneeMemberId && !valid.has(item.assigneeMemberId)) {
                    item.assigneeMemberId = null;
                }
            }
        }));
    }

    onVisibilityChange(): void {
        if (this.editing.visibility !== 'friendGroups') {
            this.editing.friendGroupIds = [];
            this.editing.friendGroupId = null;
        }
        this.refreshEditorRecipients();
    }

    /** Toggle the panel that lists members who can see the list (server preview of current visibility). */
    toggleEditorRecipientsDetail(): void {
        this.editorRecipientsDetailOpen = !this.editorRecipientsDetailOpen;
        if (this.editorRecipientsDetailOpen) {
            this.refreshEditorRecipients();
        }
        this.cdr.markForCheck();
    }

    /** Same idea as calendar visibility panel: hide @username when it duplicates display name. */
    editorRecipientUsername(r: TodoVisibilityRecipient): string {
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

    toggleFriendGroupSelection(groupId: string): void {
        const ids = new Set(this.editing.friendGroupIds || []);
        if (ids.has(groupId)) {
            ids.delete(groupId);
        } else {
            ids.add(groupId);
        }
        this.editing.friendGroupIds = Array.from(ids);
        this.editing.friendGroupId = this.editing.friendGroupIds[0] || null;
        this.refreshEditorRecipients();
    }

    isFriendGroupSelected(groupId: string): boolean {
        return (this.editing.friendGroupIds || []).includes(groupId);
    }

    saveEditor(): void {
        const trimmedName = (this.editing.name || '').trim();
        if (!trimmedName) {
            this.editorErrorMessage = this.translate.instant('TODOLISTS.NAME_REQUIRED');
            return;
        }
        if (this.editing.visibility === 'friendGroups'
            && (!this.editing.friendGroupIds || this.editing.friendGroupIds.length === 0)) {
            this.editorErrorMessage = this.translate.instant('TODOLISTS.GROUP_REQUIRED');
            return;
        }
        // Strip empty items, normalise rich-text descriptions (Quill emits "<p><br></p>" for blank).
        this.editing.items = (this.editing.items || [])
            .filter(it => (it.title || '').trim().length > 0)
            .map(it => ({
                ...it,
                title: it.title.trim(),
                description: this.isHtmlEmpty(it.description) ? null : (it.description || '').trim(),
                priority: it.priority || 'normal',
                status: it.status || 'open'
            }));
        this.editing.name = trimmedName;
        this.editing.description = this.isHtmlEmpty(this.editing.description) ? null : (this.editing.description || '').trim();
        this.editing.status = this.editing.status || 'open';
        this.editing.visibility = this.editing.visibility || 'private';

        this.editorSaving = true;
        const payload = { ...this.editing, linkTargetsProvided: true } as TodoList & { linkTargetsProvided: boolean };
        const obs = this.isNew
            ? this.todoService.create(payload as TodoList)
            : this.todoService.update(this.editing.id || '', payload as TodoList);
        this.subs.push(obs.pipe(
            finalize(() => {
                this.editorSaving = false;
                this.cdr.markForCheck();
            })
        ).subscribe({
            next: () => {
                this.editorModalRef?.close();
                this.refreshLists();
            },
            error: () => {
                this.editorErrorMessage = this.translate.instant('TODOLISTS.SAVE_ERROR');
            }
        }));
    }

    cancelEditor(): void {
        this.editorModalRef?.dismiss();
    }

    deleteList(list: TodoList): void {
        if (!list.id || !this.isOwner(list)) {
            return;
        }
        const ok = window.confirm(this.translate.instant('TODOLISTS.CONFIRM_DELETE', { name: list.name }));
        if (!ok) return;
        this.subs.push(this.todoService.delete(list.id).subscribe({
            next: () => this.refreshLists()
        }));
    }

    // ---------- Details modal -----------------------------------------------

    openDetails(list: TodoList): void {
        this.detailsList = JSON.parse(JSON.stringify(list)) as TodoList;
        this.detailsRecipients = [];
        this.detailsAssigneeMap = new Map();
        this.detailsModalRef = this.modal.open(this.detailsModal, {
            size: 'lg',
            scrollable: true,
            windowClass: 'todolists-modal'
        });
        if (list.id) {
            this.subs.push(this.todoService.getVisibilityRecipients(list.id).pipe(
                catchError(() => of([] as TodoVisibilityRecipient[]))
            ).subscribe(rs => {
                this.detailsRecipients = rs || [];
                const m = new Map<string, string>();
                for (const r of rs || []) {
                    m.set(r.memberId, r.displayName || r.userName || r.memberId);
                }
                this.detailsAssigneeMap = m;
                this.cdr.markForCheck();
            }));
        }
    }

    assigneeLabel(memberId?: string | null): string {
        if (!memberId) return '';
        return this.detailsAssigneeMap.get(memberId) || memberId.slice(0, 8);
    }

    toggleItemStatus(list: TodoList, item: TodoItem): void {
        if (!list.id || !item.id) {
            return;
        }
        const next: TodoStatus = item.status === 'done' ? 'open' : 'done';
        item.status = next;
        item.completedAt = next === 'done' ? new Date().toISOString() : null;
        this.subs.push(this.todoService.updateItemStatus(list.id, item.id, next).subscribe({
            next: updated => {
                // Replace in our cache so card progress reflects reality
                const idx = this.lists.findIndex(l => l.id === updated.id);
                if (idx >= 0) {
                    this.lists[idx] = updated;
                }
                this.detailsList = updated;
                this.recomputeMeta();
                this.cdr.markForCheck();
            },
            error: () => {
                // Revert
                item.status = next === 'done' ? 'open' : 'done';
                item.completedAt = null;
                this.cdr.markForCheck();
            }
        }));
    }

    closeDetails(): void {
        this.detailsModalRef?.dismiss();
    }

    editFromDetails(): void {
        if (!this.detailsList) return;
        this.detailsModalRef?.close();
        this.openEdit(this.detailsList);
    }

    // ---------- Sharing (email / WhatsApp) ----------------------------------

    openShare(list: TodoList, mode: 'email' | 'whatsapp' = 'email'): void {
        this.shareMode = mode;
        this.shareSelectedMemberIds = new Set<string>();
        this.shareExtraEmails = '';
        this.shareCustomMessage = this.translate.instant('TODOLISTS.SHARE.DEFAULT_MESSAGE', { name: list.name });
        this.shareErrorMessage = '';
        this.shareSuccessMessage = '';
        this.shareRecipients = [];
        // Card row may be stale; always reload the full document so tasks are present for e-mail / WhatsApp.
        this.shareList = { ...list, items: [...(list.items || [])] };
        this.shareModalRef = this.modal.open(this.shareModal, {
            size: 'lg',
            scrollable: true,
            windowClass: 'todolists-modal'
        });
        if (!list.id) {
            return;
        }
        this.shareRecipientsLoading = true;
        this.subs.push(
            forkJoin({
                full: this.todoService.getOne(list.id).pipe(catchError(() => of(list))),
                recipients: this.todoService.getVisibilityRecipients(list.id).pipe(
                    catchError(() => of([] as TodoVisibilityRecipient[]))
                )
            }).pipe(
                finalize(() => {
                    this.shareRecipientsLoading = false;
                    this.cdr.markForCheck();
                })
            ).subscribe(({ full, recipients }) => {
                this.shareList = full;
                const byId = new Map<string, TodoVisibilityRecipient>();
                for (const r of recipients || []) {
                    if (r?.memberId) {
                        byId.set(r.memberId, r);
                    }
                }
                // Back-end inclut déjà le propriétaire ; on conserve tout le monde (y compris vous)
                // pour pouvoir vous envoyer le partage par e-mail.
                this.shareRecipients = Array.from(byId.values()).sort((a, b) =>
                    (a.displayName || '').localeCompare(b.displayName || '', undefined, { sensitivity: 'base' })
                );
                // Pré-sélection : membres avec e-mail sauf soi (le propriétaire peut se cocher manuellement).
                this.shareSelectedMemberIds = new Set(
                    this.shareRecipients
                        .filter(r => r.hasEmail && r.memberId !== this.currentUserId)
                        .map(r => r.memberId)
                );
            })
        );
    }

    setShareMode(mode: 'email' | 'whatsapp'): void {
        this.shareMode = mode;
        this.shareErrorMessage = '';
        this.shareSuccessMessage = '';
    }

    toggleShareRecipient(memberId: string): void {
        if (this.shareSelectedMemberIds.has(memberId)) {
            this.shareSelectedMemberIds.delete(memberId);
        } else {
            this.shareSelectedMemberIds.add(memberId);
        }
    }

    isShareRecipientSelected(memberId: string): boolean {
        return this.shareSelectedMemberIds.has(memberId);
    }

    /** Indique si ce destinataire PatTool est le propriétaire de la liste partagée. */
    isShareRecipientOwner(r: TodoVisibilityRecipient): boolean {
        return !!this.shareList?.ownerMemberId && this.shareList.ownerMemberId === r.memberId;
    }

    /** Send the share e-mail. The back-end resolves member emails without exposing them. */
    sendShareEmail(): void {
        if (!this.shareList || !this.shareList.id) {
            return;
        }
        const extra = this.shareExtraEmails
            .split(/[,;\s]+/)
            .map(e => e.trim())
            .filter(e => e.length > 0);
        const memberIds = Array.from(this.shareSelectedMemberIds);
        if (extra.length === 0 && memberIds.length === 0) {
            this.shareErrorMessage = this.translate.instant('TODOLISTS.SHARE.NO_RECIPIENT');
            return;
        }
        const payload: TodoShareEmailPayload = {
            toEmails: extra,
            toMemberIds: memberIds,
            customMessage: (this.shareCustomMessage || '').trim(),
            mailLang: this.translate.currentLang || 'en',
            listUrl: this.buildTodolistDeepLink(this.shareList.id)
        };
        this.shareSending = true;
        this.shareErrorMessage = '';
        this.shareSuccessMessage = '';
        this.subs.push(this.todoService.shareByEmail(this.shareList.id, payload).pipe(
            finalize(() => {
                this.shareSending = false;
                this.cdr.markForCheck();
            })
        ).subscribe({
            next: resp => {
                this.shareSuccessMessage = this.translate.instant('TODOLISTS.SHARE.SENT_OK',
                    { sent: resp.sent, total: resp.total });
            },
            error: () => {
                this.shareErrorMessage = this.translate.instant('TODOLISTS.SHARE.SEND_ERROR');
            }
        }));
    }

    /**
     * Share to WhatsApp.
     *
     * Sur mobile, {@link Navigator#canShare} renvoie souvent {@code false} pour
     * {@code { files, text }} alors que {@link Navigator#share} fonctionne : on appelle
     * donc {@code share()} sans se fier uniquement à {@code canShare}. Si texte+fichier
     * échoue, on retente avec la photo seule (légende à coller manuellement si besoin).
     * Ensuite partage texte seul ou {@code wa.me} (sans image).
     */
    async sendShareWhatsApp(): Promise<void> {
        if (!this.shareList) {
            return;
        }
        const list = this.shareList;
        const text = this.composeWhatsAppMessage(list);
        const markOpened = (msgKey: 'TODOLISTS.SHARE.WHATSAPP_OPENED' | 'TODOLISTS.SHARE.WHATSAPP_IMAGE_ONLY' = 'TODOLISTS.SHARE.WHATSAPP_OPENED'): void => {
            this.shareSuccessMessage = this.translate.instant(msgKey);
            this.cdr.markForCheck();
        };

        const nav = window.navigator as Navigator & {
            share?: (data: ShareData & { files?: File[] }) => Promise<void>;
        };

        const invokeShare = async (data: ShareData & { files?: File[] }): Promise<'ok' | 'cancel' | 'fail'> => {
            if (typeof nav.share !== 'function') {
                return 'fail';
            }
            try {
                await nav.share(data);
                return 'ok';
            } catch (err) {
                if ((err as DOMException)?.name === 'AbortError') {
                    return 'cancel';
                }
                return 'fail';
            }
        };

        if (list.imageDataUrl && typeof nav.share === 'function') {
            const file = await this.dataUrlToFile(list.imageDataUrl, this.fileNameFor(list));
            if (file) {
                let out = await invokeShare({ title: list.name || undefined, text, files: [file] });
                if (out === 'ok') {
                    markOpened();
                    return;
                }
                if (out === 'cancel') {
                    return;
                }
                out = await invokeShare({ title: list.name || undefined, files: [file] });
                if (out === 'ok') {
                    markOpened('TODOLISTS.SHARE.WHATSAPP_IMAGE_ONLY');
                    return;
                }
                if (out === 'cancel') {
                    return;
                }
            }
        }

        if (typeof nav.share === 'function') {
            const out = await invokeShare({ title: list.name || undefined, text });
            if (out === 'ok') {
                markOpened();
                return;
            }
            if (out === 'cancel') {
                return;
            }
        }

        const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
        markOpened();
    }

    /**
     * Parse {@code data:…;base64,…} and return MIME + payload (no whitespace in base64).
     */
    private parseDataUrlBase64(dataUrl: string): { mime: string; base64: string } | null {
        const s = dataUrl.trim();
        const comma = s.indexOf(',');
        if (comma < 0 || !s.startsWith('data:')) {
            return null;
        }
        const header = s.slice(5, comma);
        const lower = header.toLowerCase();
        const b64Marker = ';base64';
        const idx = lower.indexOf(b64Marker);
        if (idx < 0) {
            return null;
        }
        const mime = (header.slice(0, idx).split(';')[0] || 'image/jpeg').trim() || 'image/jpeg';
        const base64 = s.slice(comma + 1).replace(/\s/g, '');
        return base64.length ? { mime, base64 } : null;
    }

    /** Convert a {@code data:image/...;base64,...} URL to an actual {@code File}. */
    private async dataUrlToFile(dataUrl: string, fileName: string): Promise<File | null> {
        const parsed = this.parseDataUrlBase64(dataUrl);
        if (!parsed) {
            return null;
        }
        const { mime, base64 } = parsed;
        let blob: Blob | null = null;
        try {
            const resp = await fetch(dataUrl.trim());
            const b = await resp.blob();
            const t = b.type && b.type !== 'application/octet-stream' ? b.type : mime;
            blob = t === b.type ? b : new Blob([await b.arrayBuffer()], { type: t });
        } catch {
            blob = null;
        }
        if (!blob) {
            try {
                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                blob = new Blob([bytes], { type: mime });
            } catch {
                return null;
            }
        }
        const ext = mime.includes('png') ? 'png'
                  : mime.includes('webp') ? 'webp'
                  : mime.includes('gif') ? 'gif'
                  : 'jpg';
        const type = blob.type || mime;
        try {
            return new File([blob], `${fileName}.${ext}`, { type });
        } catch {
            return null;
        }
    }

    private fileNameFor(list: TodoList): string {
        return (list.name || 'todolist')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40) || 'todolist';
    }

    closeShare(): void {
        this.shareModalRef?.dismiss();
        this.shareList = null;
    }

    /** Tasks shown in the share modal preview (after {@link #openShare} refresh). */
    shareTasksForPreview(): TodoItem[] {
        return this.shareList?.items ?? [];
    }

    /** One-line plain preview of the list description in the share summary. */
    shareDescriptionPreview(list: TodoList): string {
        return this.clipPlain(this.htmlToPlain(list.description), 220);
    }

    /**
     * WhatsApp / Web Share text: list description right after the title, then tasks, then meta.
     * The whole string is still clipped for {@code wa.me} length limits.
     */
    private composeWhatsAppMessage(list: TodoList): string {
        const lines: string[] = [];
        if (this.shareCustomMessage?.trim()) {
            lines.push(this.clipPlain(this.shareCustomMessage.trim(), 480));
            lines.push('');
        }
        lines.push(`*${list.name}*`);
        const descPlain = this.clipPlain(this.htmlToPlain(list.description), 450);
        if (descPlain) {
            lines.push(descPlain);
        }
        lines.push('');
        lines.push(this.underlinePlain(this.translate.instant('TODOLISTS.SHARE.WHATSAPP_TASKS_HEADER')));
        const items = list.items || [];
        if (items.length === 0) {
            lines.push(this.translate.instant('TODOLISTS.SHARE.TASKS_NONE'));
        } else {
            for (const it of items) {
                const mark = it.status === 'done' ? '☑' : '☐';
                const titleRaw = (it.title || '').trim() || '—';
                const titleSafe = titleRaw.replace(/\*/g, '').replace(/_/g, '');
                const title = this.clipPlain(titleSafe, 220);
                // Gras WhatsApp (*…*) + soulignement combiné (U+0332) sur le titre.
                let row = `${mark} *${this.underlinePlain(title)}*`;
                if (it.dueDate) {
                    row += ` · ${this.formatDate(it.dueDate)}`;
                }
                lines.push(row);
                const idesc = this.clipPlain(this.htmlToPlain(it.description), 140);
                if (idesc) {
                    lines.push(`   ${idesc}`);
                }
            }
        }
        lines.push('');
        const meta = this.metaFor(list);
        if (meta.total > 0) {
            lines.push(`📋 ${meta.completed}/${meta.total} (${meta.percent}%)`);
        }
        if (list.dueDate) {
            lines.push(`📅 ${this.formatDate(list.dueDate)}`);
        }
        const joined = lines.join('\n');
        const linkSuffix = list.id
            ? `\n\n${this.translate.instant('TODOLISTS.SHARE.OPEN_IN_PATTOOL')}\n${this.buildTodolistDeepLink(list.id)}`
            : '';
        const reserved = linkSuffix.length + 80;
        const maxBody = Math.max(400, 3200 - reserved);
        return this.clipForWhatsApp(joined, maxBody) + linkSuffix;
    }

    private clipPlain(s: string, max: number): string {
        if (!s || s.length <= max) {
            return s;
        }
        return s.slice(0, Math.max(0, max - 1)) + '…';
    }

    /** Caractère combiné U+0332 après chaque glyphe pour un effet souligné en texte brut (WhatsApp, etc.). */
    private underlinePlain(text: string): string {
        if (!text) {
            return '';
        }
        return [...text].join('\u0332') + '\u0332';
    }

    /** Stay under typical {@code wa.me} / browser limits so the encoded URL is not truncated. */
    private clipForWhatsApp(text: string, maxLen = 3200): string {
        if (text.length <= maxLen) {
            return text;
        }
        return text.slice(0, maxLen - 40) + '\n…\n' + this.translate.instant('TODOLISTS.SHARE.WHATSAPP_TRUNCATED');
    }

    /** Strip HTML tags and decode common entities so the WhatsApp body stays plain text. */
    private htmlToPlain(html?: string | null): string {
        if (!html) {
            return '';
        }
        return html
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<li[^>]*>/gi, '• ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, '\'')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // ---------- Helpers -----------------------------------------------------

    formatDate(value?: string | null): string {
        if (!value) return '';
        try {
            const d = new Date(value);
            const lang = this.translate.currentLang || 'en';
            return d.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: '2-digit' });
        } catch {
            return value;
        }
    }

    formatDateTime(value?: string | null): string {
        if (!value) return '';
        try {
            const d = new Date(value);
            const lang = this.translate.currentLang || 'en';
            return d.toLocaleString(lang, {
                year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch {
            return value;
        }
    }

    /** Convert ISO Date -> "yyyy-MM-dd" suitable for &lt;input type="date"&gt;. */
    toDateInput(value?: string | null): string {
        if (!value) return '';
        const d = new Date(value);
        if (isNaN(d.getTime())) return '';
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${m}-${day}`;
    }

    fromDateInput(value: string): string | null {
        if (!value) return null;
        const d = new Date(value + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    onListDueDateInput(value: string): void {
        this.editing.dueDate = this.fromDateInput(value);
    }

    onItemDueDateInput(item: TodoItem, value: string): void {
        item.dueDate = this.fromDateInput(value);
    }

    onAppointmentLinkSelect(value: string): void {
        const v = (value || '').trim();
        this.editing.calendarAppointmentId = v.length > 0 ? v : null;
        if (v.length > 0) {
            this.editing.evenementId = null;
        }
        this.cdr.markForCheck();
    }

    onActivityLinkSelect(value: string): void {
        const v = (value || '').trim();
        this.editing.evenementId = v.length > 0 ? v : null;
        if (v.length > 0) {
            this.editing.calendarAppointmentId = null;
        }
        this.cdr.markForCheck();
    }

    private loadLinkPickerOptions(): void {
        if (!this.isOwner(this.editing)) {
            this.linkPickerAppointments = [];
            this.linkPickerActivities = [];
            return;
        }
        this.linkPickerLoading = true;
        this.linkPickerError = false;
        this.cdr.markForCheck();
        const from = new Date();
        from.setFullYear(from.getFullYear() - 3);
        const to = new Date();
        to.setFullYear(to.getFullYear() + 3);
        const chunks = this.buildCalendarEntryChunks(from, to);
        if (chunks.length === 0) {
            this.linkPickerLoading = false;
            this.linkPickerAppointments = [];
            this.linkPickerActivities = [];
            this.ensureStaleLinkOptions();
            this.cdr.markForCheck();
            return;
        }
        const requests = chunks.map(ch => this.calendarService.getEntries(ch.start, ch.end));
        this.subs.push(
            forkJoin(requests).pipe(
                map(parts => {
                    const merged = new Map<string, CalendarEntry>();
                    for (const part of parts) {
                        for (const e of part || []) {
                            merged.set(`${e.kind}:${e.id}`, e);
                        }
                    }
                    return Array.from(merged.values());
                }),
                finalize(() => {
                    this.linkPickerLoading = false;
                    this.cdr.markForCheck();
                })
            ).subscribe({
                next: rows => {
                    const list = rows || [];
                    const appts = list
                        .filter(e => e.kind === 'APPOINTMENT')
                        .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
                        .map(e => ({ id: e.id, label: this.formatCalendarEntryLabel(e) }));
                    const acts = list
                        .filter(e => e.kind === 'ACTIVITY')
                        .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
                        .map(e => ({ id: e.id, label: this.formatCalendarEntryLabel(e) }));
                    this.linkPickerAppointments = appts;
                    this.linkPickerActivities = acts;
                    this.ensureStaleLinkOptions();
                    this.cdr.markForCheck();
                },
                error: () => {
                    this.linkPickerAppointments = [];
                    this.linkPickerActivities = [];
                    this.linkPickerError = true;
                    this.ensureStaleLinkOptions();
                    this.cdr.markForCheck();
                }
            })
        );
    }

    /** Splits [from, to] into windows accepted by {@code /api/calendar/entries} (max ~370 days each). */
    private buildCalendarEntryChunks(from: Date, to: Date): { start: Date; end: Date }[] {
        const out: { start: Date; end: Date }[] = [];
        const t0 = from.getTime();
        const t1 = to.getTime();
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

    /**
     * If the list already references an id outside the loaded window (or load failed), keep a
     * single synthetic option so the select still shows something meaningful.
     */
    private ensureStaleLinkOptions(): void {
        const apId = (this.editing.calendarAppointmentId || '').trim();
        if (apId && !this.linkPickerAppointments.some(o => o.id === apId)) {
            this.linkPickerAppointments = [
                {
                    id: apId,
                    label: this.translate.instant('TODOLISTS.LINK_STALE_APPOINTMENT', { id: apId })
                },
                ...this.linkPickerAppointments
            ];
        }
        const evId = (this.editing.evenementId || '').trim();
        if (evId && !this.linkPickerActivities.some(o => o.id === evId)) {
            this.linkPickerActivities = [
                {
                    id: evId,
                    label: this.translate.instant('TODOLISTS.LINK_STALE_ACTIVITY', { id: evId })
                },
                ...this.linkPickerActivities
            ];
        }
    }

    private blankList(): TodoList {
        return {
            name: '',
            description: '',
            imageDataUrl: null,
            dueDate: null,
            status: 'open',
            visibility: 'private',
            friendGroupIds: [],
            calendarAppointmentId: null,
            evenementId: null,
            items: []
        };
    }

    trackById<T extends { id?: string }>(_: number, item: T): string {
        return item.id || '';
    }

    trackByIndex(index: number): number {
        return index;
    }
}
