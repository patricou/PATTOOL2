import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    OnDestroy,
    OnInit,
    inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Subscription, from, of } from 'rxjs';
import { catchError, finalize, map, switchMap } from 'rxjs/operators';
import { TodoItem, TodoList, TodoListService, TodoStatus, TodoVisibilityRecipient } from './todolist.service';
import { FriendsService } from '../services/friends.service';
import { MembersService } from '../services/members.service';
import { Member } from '../model/member';
import { FriendGroup } from '../model/friend';
import { KeycloakService } from '../keycloak/keycloak.service';
import { environment } from '../../environments/environment';
import { buildTodolistShareLink } from '../shared/share-deep-link.util';

interface ListMeta {
    completed: number;
    total: number;
    percent: number;
    overdue: boolean;
    daysUntilDue: number | null;
}

interface OwnerLabel {
    id: string;
    label: string;
    initials: string;
}

@Component({
    selector: 'app-todo-list-detail-overlay',
    standalone: true,
    imports: [CommonModule, TranslateModule],
    templateUrl: './todo-list-detail-overlay.component.html',
    styleUrls: ['./todo-list-detail-overlay.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class TodoListDetailOverlayComponent implements OnInit, OnDestroy {
    readonly activeModal = inject(NgbActiveModal);
    private readonly todoService = inject(TodoListService);
    private readonly translate = inject(TranslateService);
    private readonly sanitizer = inject(DomSanitizer);
    private readonly http = inject(HttpClient);
    private readonly keycloak = inject(KeycloakService);
    private readonly friendsService = inject(FriendsService);
    private readonly membersService = inject(MembersService);
    private readonly router = inject(Router);
    private readonly cdr = inject(ChangeDetectorRef);

    /** Set by {@link TodoListDetailOverlayService} before first change detection. */
    listId = '';

    list: TodoList | null = null;
    loading = true;
    loadError = false;
    currentUserId = '';
    friendGroups: FriendGroup[] = [];
    reminderSending = false;
    reminderFeedback = '';
    reminderFeedbackOk = false;
    private ownerCache = new Map<string, OwnerLabel>();
    private detailsAssigneeMap = new Map<string, string>();
    private subs: Subscription[] = [];
    private recipientsCache: TodoVisibilityRecipient[] = [];

    ngOnInit(): void {
        this.subs.push(
            this.friendsService.getFriendGroups().pipe(catchError(() => of([] as FriendGroup[]))).subscribe(groups => {
                this.friendGroups = (groups || []).slice().sort((a, b) =>
                    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
                );
                this.cdr.markForCheck();
            })
        );
        this.subs.push(
            this.membersService.getUserId({ skipGeolocation: true }).subscribe({
                next: m => {
                    this.currentUserId = (m.id || '').trim();
                    this.cdr.markForCheck();
                },
                error: () => {
                    this.currentUserId = '';
                }
            })
        );
        const id = (this.listId || '').trim();
        if (!id) {
            this.loading = false;
            this.loadError = true;
            return;
        }
        this.subs.push(
            this.todoService.getOne(id).pipe(
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
                this.list = JSON.parse(JSON.stringify(doc)) as TodoList;
                this.fetchOwnerLabelForList();
                this.fetchRecipients();
                this.cdr.markForCheck();
            })
        );
    }

    ngOnDestroy(): void {
        this.subs.forEach(s => s.unsubscribe());
    }

    safeHtml(value?: string | null): SafeHtml {
        if (!value) {
            return '';
        }
        return this.sanitizer.bypassSecurityTrustHtml(value);
    }

    metaFor(list: TodoList | null): ListMeta {
        if (!list) {
            return { completed: 0, total: 0, percent: 0, overdue: false, daysUntilDue: null };
        }
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
        return { completed, total, percent, overdue, daysUntilDue };
    }

    ownerLabelFor(list: TodoList): string {
        if (!list.ownerMemberId) {
            return '';
        }
        return this.ownerCache.get(list.ownerMemberId)?.label || list.ownerMemberId.slice(0, 8);
    }

    isOwner(list: TodoList | null): boolean {
        return !!(list && list.ownerMemberId && list.ownerMemberId === this.currentUserId);
    }

    statusBadgeClass(status?: string): string {
        switch (status) {
            case 'done':
                return 'badge bg-success';
            case 'in_progress':
                return 'badge bg-warning text-dark';
            case 'archived':
                return 'badge bg-secondary';
            default:
                return 'badge bg-primary';
        }
    }

    visibilityIcon(v?: string): string {
        switch (v) {
            case 'public':
                return 'fa-globe';
            case 'friends':
                return 'fa-users';
            case 'friendGroups':
                return 'fa-user-circle';
            case 'private':
                return 'fa-lock';
            default:
                return 'fa-user-circle';
        }
    }

    visibilityLabelKey(v?: string): string {
        switch (v) {
            case 'public':
                return 'TODOLISTS.VISIBILITY.PUBLIC';
            case 'friends':
                return 'TODOLISTS.VISIBILITY.FRIENDS';
            case 'friendGroups':
                return 'TODOLISTS.VISIBILITY.FRIEND_GROUPS';
            case 'private':
                return 'TODOLISTS.VISIBILITY.PRIVATE';
            default:
                return 'TODOLISTS.VISIBILITY.PRIVATE';
        }
    }

    visibilityDisplay(list: TodoList | null): string {
        if (!list) {
            return '';
        }
        if (list.visibility === 'friendGroups') {
            const ids =
                list.friendGroupIds && list.friendGroupIds.length > 0
                    ? list.friendGroupIds
                    : list.friendGroupId
                      ? [list.friendGroupId]
                      : [];
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

    formatDate(value?: string | null): string {
        if (!value) {
            return '';
        }
        try {
            const d = new Date(value);
            const lang = this.translate.currentLang || 'en';
            return d.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: '2-digit' });
        } catch {
            return value;
        }
    }

    formatDateTime(value?: string | null): string {
        if (!value) {
            return '';
        }
        try {
            const d = new Date(value);
            const lang = this.translate.currentLang || 'en';
            return d.toLocaleString(lang, {
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return value;
        }
    }

    assigneeLabel(memberId?: string | null): string {
        if (!memberId) {
            return '';
        }
        return this.detailsAssigneeMap.get(memberId) || memberId.slice(0, 8);
    }

    trackById<T extends { id?: string }>(_: number, item: T): string {
        return item.id || '';
    }

    toggleItemStatus(list: TodoList, item: TodoItem): void {
        if (!list.id || !item.id) {
            return;
        }
        const next: TodoStatus = item.status === 'done' ? 'open' : 'done';
        item.status = next;
        item.completedAt = next === 'done' ? new Date().toISOString() : null;
        this.subs.push(
            this.todoService.updateItemStatus(list.id, item.id, next).subscribe({
                next: updated => {
                    this.list = updated;
                    this.cdr.markForCheck();
                },
                error: () => {
                    item.status = next === 'done' ? 'open' : 'done';
                    item.completedAt = null;
                    this.cdr.markForCheck();
                }
            })
        );
    }

    goToTodolistsPage(): void {
        const id = this.list?.id;
        this.activeModal.close();
        if (id) {
            void this.router.navigate(['/todolists'], { queryParams: { list: id } });
        } else {
            void this.router.navigate(['/todolists']);
        }
    }

    hasLinkedActivity(list: TodoList | null | undefined): boolean {
        return !!(list?.evenementId || '').trim();
    }

    openLinkedActivityPhotoWall(): void {
        const eventId = (this.list?.evenementId || '').trim();
        if (!eventId) {
            return;
        }
        this.activeModal.close();
        void this.router.navigate(['/photos'], { queryParams: { eventId } });
    }

    private fetchRecipients(): void {
        const id = this.list?.id;
        if (!id) {
            return;
        }
        this.subs.push(
            this.todoService.getVisibilityRecipients(id).pipe(catchError(() => of([] as TodoVisibilityRecipient[]))).subscribe(rs => {
                const rows = rs || [];
                const m = new Map<string, string>();
                for (const r of rows) {
                    m.set(r.memberId, r.displayName || r.userName || r.memberId);
                }
                this.detailsAssigneeMap = m;
                this.recipientsCache = rows;
                const owner = rows.find(r => r.memberId === this.list?.ownerMemberId);
                if (owner && this.list?.ownerMemberId) {
                    this.ownerCache.set(this.list.ownerMemberId, {
                        id: this.list.ownerMemberId,
                        label: owner.displayName || owner.userName || this.list.ownerMemberId.slice(0, 8),
                        initials: '?'
                    });
                }
                this.cdr.markForCheck();
            })
        );
    }

    /**
     * Quick reminder from the overlay: e-mail to the assignee (when known), or WhatsApp text
     * listing that person's open tasks on this list.
     */
    remindItem(item: TodoItem, channel: 'email' | 'whatsapp'): void {
        const list = this.list;
        if (!list?.id || !item?.id) {
            return;
        }
        this.reminderFeedback = '';
        if (channel === 'whatsapp') {
            const text = this.composeReminderWhatsApp(list, item);
            window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
            this.reminderFeedbackOk = true;
            this.reminderFeedback = this.translate.instant('TODOLISTS.SHARE.WHATSAPP_OPENED');
            this.cdr.markForCheck();
            return;
        }
        const assigneeId = (item.assigneeMemberId || '').trim();
        const recipient = assigneeId
            ? this.recipientsCache.find(r => r.memberId === assigneeId)
            : undefined;
        if (!assigneeId || !recipient?.hasEmail) {
            this.reminderFeedbackOk = false;
            this.reminderFeedback = this.translate.instant(
                assigneeId ? 'TODOLISTS.SHARE.NO_EMAIL_FOR' : 'TODOLISTS.REMINDER.NEED_ASSIGNEE_OR_PAGE'
            );
            this.cdr.markForCheck();
            return;
        }
        const assigneeName = this.assigneeLabel(assigneeId);
        const customMessage = this.translate.instant(
            'TODOLISTS.REMINDER.DEFAULT_MESSAGE_FOR',
            { name: list.name, assignee: assigneeName, task: item.title || '' }
        );
        this.reminderSending = true;
        this.subs.push(
            this.todoService.sendReminderEmail(list.id, {
                itemId: item.id,
                toMemberIds: [assigneeId],
                customMessage,
                mailLang: this.translate.currentLang || 'en',
                listUrl: this.buildTodolistDeepLink(list.id, { publicLink: true })
            }).pipe(
                finalize(() => {
                    this.reminderSending = false;
                    this.cdr.markForCheck();
                })
            ).subscribe({
                next: resp => {
                    this.reminderFeedbackOk = true;
                    this.reminderFeedback = this.translate.instant('TODOLISTS.REMINDER.SENT_OK', {
                        sent: resp.sent,
                        total: resp.total
                    });
                },
                error: () => {
                    this.reminderFeedbackOk = false;
                    this.reminderFeedback = this.translate.instant('TODOLISTS.REMINDER.SEND_ERROR');
                }
            })
        );
    }

    private composeReminderWhatsApp(list: TodoList, focus: TodoItem): string {
        const assigneeId = (focus.assigneeMemberId || '').trim();
        const assigneeName = assigneeId ? this.assigneeLabel(assigneeId) : '';
        const items = this.reminderTasks(list, focus);
        const deepLink = (list.id || '').trim()
            ? this.buildTodolistDeepLink(list.id!, { publicLink: true })
            : '';
        const lines: string[] = [];
        lines.push(this.translate.instant(
            assigneeName ? 'TODOLISTS.REMINDER.DEFAULT_MESSAGE_FOR' : 'TODOLISTS.REMINDER.DEFAULT_MESSAGE',
            { name: list.name, assignee: assigneeName, task: focus.title || '' }
        ));
        lines.push('');
        lines.push(`*${list.name}*`);
        lines.push('');
        const descPlain = this.clipPlain(this.htmlToPlain(list.description), 450);
        if (descPlain) {
            lines.push(descPlain);
            lines.push('');
        }
        lines.push(this.translate.instant('TODOLISTS.REMINDER.WHATSAPP_TASKS_HEADER'));
        for (const it of items) {
            const mark = it.status === 'done' ? '☑' : '☐';
            lines.push(`${mark} ${(it.title || '').trim() || '—'}`);
        }
        let text = lines.join('\n');
        if (text.length > 3000) {
            text = text.slice(0, 2960) + '\n…';
        }
        if (deepLink) {
            text += `\n\n${this.translate.instant('TODOLISTS.SHARE.OPEN_IN_PATTOOL')}\n${deepLink}`;
        }
        return text;
    }

    private clipPlain(s: string, max: number): string {
        if (!s || s.length <= max) {
            return s;
        }
        return s.slice(0, Math.max(0, max - 1)) + '…';
    }

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
            .replace(/&#39;/g, "'")
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private reminderTasks(list: TodoList, focus: TodoItem): TodoItem[] {
        const items = list.items || [];
        const assigneeId = (focus.assigneeMemberId || '').trim();
        if (assigneeId) {
            const pending = items.filter(
                it => it.assigneeMemberId === assigneeId && it.status !== 'done'
            );
            if (pending.length > 0) {
                return pending;
            }
        }
        const match = items.find(it => it.id && it.id === focus.id);
        return match ? [match] : [focus];
    }

    private buildTodolistDeepLink(listId: string, opts?: { publicLink?: boolean }): string {
        return buildTodolistShareLink(listId, opts);
    }

    private fetchOwnerLabelForList(): void {
        const list = this.list;
        const ownerId = list?.ownerMemberId;
        if (!ownerId || this.ownerCache.has(ownerId)) {
            return;
        }
        this.subs.push(
            from(this.keycloak.getToken())
                .pipe(
                    map(token =>
                        new HttpHeaders({
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            Authorization: token ? 'Bearer ' + token : ''
                        })
                    ),
                    switchMap(headers =>
                        this.http.get<Member>(`${environment.API_URL}memb/${ownerId}`, { headers }).pipe(
                            map(m => ({ member: m })),
                            catchError(() => of({ member: null as Member | null }))
                        )
                    )
                )
                .subscribe(({ member }) => {
                    this.ownerCache.set(ownerId, this.toOwnerLabel(ownerId, member));
                    this.cdr.markForCheck();
                })
        );
    }

    private toOwnerLabel(id: string, member: Member | null): OwnerLabel {
        if (!member) {
            return { id, label: id.slice(0, 8), initials: '?' };
        }
        const first = (member.firstName || '').trim();
        const last = (member.lastName || '').trim();
        const full = (first + ' ' + last).trim();
        const label = full || (member.userName || '').trim() || id.slice(0, 8);
        const initials =
            (first.charAt(0) + last.charAt(0)).toUpperCase() ||
            (member.userName || '?').charAt(0).toUpperCase();
        return { id, label, initials };
    }
}
