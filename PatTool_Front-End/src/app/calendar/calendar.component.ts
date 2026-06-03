import {
    AfterViewInit,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    HostListener,
    OnDestroy,
    OnInit,
    TemplateRef,
    ViewChild,
    inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal, NgbModal, NgbModalModule } from '@ng-bootstrap/ng-bootstrap';
import { TodoListDetailOverlayService } from '../todolists/todo-list-detail-overlay.service';
import { FullCalendarComponent, FullCalendarModule } from '@fullcalendar/angular';
import {
    CalendarOptions,
    DateSelectArg,
    DayCellContentArg,
    EventClickArg,
    EventContentArg,
    EventInput,
    EventMountArg,
    LocaleInput
} from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import arLocale from '@fullcalendar/core/locales/ar';
import deLocale from '@fullcalendar/core/locales/de';
import elLocale from '@fullcalendar/core/locales/el';
import enGbLocale from '@fullcalendar/core/locales/en-gb';
import esLocale from '@fullcalendar/core/locales/es';
import frLocale from '@fullcalendar/core/locales/fr';
import heLocale from '@fullcalendar/core/locales/he';
import hiLocale from '@fullcalendar/core/locales/hi';
import itLocale from '@fullcalendar/core/locales/it';
import jaLocale from '@fullcalendar/core/locales/ja';
import ruLocale from '@fullcalendar/core/locales/ru';
import zhCnLocale from '@fullcalendar/core/locales/zh-cn';
import { catchError, finalize, map, switchMap, take } from 'rxjs/operators';
import { forkJoin, Observable, of, Subscription } from 'rxjs';
import { KeycloakService } from '../keycloak/keycloak.service';
import { FileService } from '../services/file.service';
import { FriendsService } from '../services/friends.service';
import { MembersService } from '../services/members.service';
import { EvenementsService } from '../services/evenements.service';
import { FriendGroup } from '../model/friend';
import { Member } from '../model/member';
import {
    CalendarEntry,
    CalendarAppointmentPayload,
    CalendarService,
    CalendarVisibilityRecipient
} from './calendar.service';
import { CALENDAR_HELP_TEXT_EN, CALENDAR_HELP_TEXT_FR } from './calendar-help-text';
import { NagerPublicHoliday, PublicHolidayService } from './public-holiday.service';
import { SaintCalendarId, SaintDayOption, SaintOfDayService, SAINT_CALENDAR_STORAGE } from './saint-of-day.service';
import { TodoList, TodoListService } from '../todolists/todolist.service';

const HOLIDAY_COUNTRY_STORAGE = 'pat-tool-calendar-holiday-country';
const HOLIDAY_NAMES_MODE_STORAGE = 'pat-tool-calendar-holiday-names-mode';
/** Parallel thumbnail downloads (preview size) — faster than sequential stagger. */
const CAL_THUMB_MAX_CONCURRENT = 12;
const CAL_THUMB_PREVIEW_MAX_EDGE = 96;

type AppointmentVisibilityPreset = 'private' | 'public' | 'friends' | 'friendGroups';

/** Résumé affiché dans la modale « détail » (clic sur une entrée). */
interface MobileCalendarEntryDetail {
    kind: 'ACTIVITY' | 'APPOINTMENT' | 'PUBLIC_HOLIDAY';
    kindI18nKey: string;
    eventId: string;
    headline: string;
    detailText: string;
    /** RDV : seul le propriétaire peut envoyer le mail de rappel. */
    appointmentCanSendReminder?: boolean;
    /** Activité : utilisateur connecté avec une adresse e-mail (envoi des détails à soi-même). */
    activityCanSendDetailsMail?: boolean;
    /** When a to-do list is linked to this calendar row (appointment or activity). */
    todoListId?: string | null;
}

@Component({
    selector: 'app-calendar',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterModule, TranslateModule, NgbModalModule, FullCalendarModule],
    templateUrl: './calendar.component.html',
    styleUrls: ['./calendar.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    providers: [EvenementsService]
})
export class CalendarComponent implements OnInit, OnDestroy, AfterViewInit {

    @ViewChild('appointmentModal') appointmentModal!: TemplateRef<unknown>;
    @ViewChild('calendarHelpModal') calendarHelpModal!: TemplateRef<unknown>;
    @ViewChild('mobileEntryDetailModal') mobileEntryDetailModal!: TemplateRef<unknown>;
    @ViewChild('fc') fullCalendar!: FullCalendarComponent;

    /** Texte d’aide FR / EN (un seul affiché selon la langue UI). */
    readonly calendarHelpFr = CALENDAR_HELP_TEXT_FR;
    readonly calendarHelpEn = CALENDAR_HELP_TEXT_EN;

    /** Titre modale Aide : « Aide » si UI française, sinon « Help ». */
    get calendarHelpModalTitle(): string {
        return this.isCalendarHelpFrench() ? 'Aide' : 'Help';
    }

    /** Corps modale : français si langue UI = français, sinon anglais. */
    get calendarHelpModalBody(): string {
        return this.isCalendarHelpFrench() ? this.calendarHelpFr : this.calendarHelpEn;
    }

    private isCalendarHelpFrench(): boolean {
        const raw = (this.translate.currentLang || '').trim().toLowerCase().replace(/_/g, '-');
        const primary = raw.split('-')[0] || '';
        return primary === 'fr';
    }

    private calendarService = inject(CalendarService);
    private publicHolidayService = inject(PublicHolidayService);
    private friendsService = inject(FriendsService);
    private membersService = inject(MembersService);
    private keycloak = inject(KeycloakService);
    private translate = inject(TranslateService);
    private modal = inject(NgbModal);
    private router = inject(Router);
    private fileService = inject(FileService);
    private cdr = inject(ChangeDetectorRef);
    private evenementsService = inject(EvenementsService);
    private todoListService = inject(TodoListService);
    private todoListOverlay = inject(TodoListDetailOverlayService);
    private saintOfDayService = inject(SaintOfDayService);

    private thumbnailBlobUrls = new Map<string, string>();
    private thumbnailLoadsInFlight = new Set<string>();
    private thumbnailLoadQueue: string[] = [];
    private thumbnailLoadsActive = 0;
    /** File IDs still needed for the last merged calendar range (avoids revoking blobs during a refetch / render). */
    private thumbnailNeededIds = new Set<string>();
    /** fileId → calendar event ids (O(1) thumb apply instead of scanning all events). */
    private thumbFileIdToEventIds = new Map<string, string[]>();
    private langChangeSub?: Subscription;
    private layoutResizeTimer?: ReturnType<typeof setTimeout>;

    /** Évite double ouverture si {@code select} et {@code dateClick} se déclenchent de près (mobile). */
    private lastNewAppointmentModalOpenedAt = 0;

    /** Spinner jusqu’à ce que FullCalendar ait peint les entrées agenda (pas seulement la réponse HTTP). */
    calendarGridLoading = true;
    private pendingEntriesPaintToken = 0;
    private entriesReadyPaintToken = 0;
    /** Nombre d’activités + RDV attendus pour le fetch en cours (-1 = inconnu). */
    private pendingExpectedAgendaCount = -1;
    /** Miniatures activité encore à charger avant de masquer le spinner. */
    private pendingThumbIdsForPaint = new Set<string>();
    private gridLoadingOffTimer?: ReturnType<typeof setTimeout>;
    /** Libellés pour le rendu DOM natif des pastilles (évite le template Angular par événement). */
    calMongoEntryHint = '';
    calTodoListBtnHint = '';

    calendarOptions!: CalendarOptions;
    errorMessage = '';
    reminderMailSuccessMessage = '';
    reminderMailErrorMessage = '';
    reminderMailLoading = false;
    visibilityRecipientsShown = false;
    visibilityRecipientsLoading = false;
    visibilityRecipientsList: CalendarVisibilityRecipient[] = [];
    /** Activité (événement) : panneau « qui a accès » (API even/.../access-users). */
    eventAccessUsersShown = false;
    eventAccessUsersLoading = false;
    eventAccessUsersList: Member[] = [];
    eventAccessUsersErrorMessage = '';
    editingId: string | null = null;
    formTitle = '';
    formNotes = '';
    formStart = '';
    formEnd = '';
    formVisibilityPreset: AppointmentVisibilityPreset = 'private';
    /** Ids de groupes lorsque {@code formVisibilityPreset} vaut {@code friendGroups}. */
    formVisibilityGroupIds: string[] = [];
    friendGroups: FriendGroup[] = [];
    /** Copie triée pour le template (évite un tri à chaque cycle de détection). */
    friendGroupsSorted: FriendGroup[] = [];
    currentMemberId = '';
    appointmentCanEdit = true;

    /** Owner’s lists for linking a personal appointment to a to-do list. */
    appointmentOwnedTodoLists: TodoList[] = [];
    appointmentTodoListsLoading = false;
    /** Selected list id, or empty string for none. */
    appointmentLinkedTodoListId = '';
    appointmentLinkedTodoListIdInitial = '';

    /** Pays pour les jours fériés (API Nager.Date), défaut France. */
    holidayCountryCode = 'FR';
    holidayCountries: { key: string; name: string }[] = [];

    /** Si true, le pays vient du localStorage (choix utilisateur) — on n’écrase pas avec la géoloc IP. */
    private holidayCountryLockedFromStorage = false;

    /**
     * Libellés des jours fériés Nager : true = {@code localName} (langue du pays), false = langue du programme (traduction UI).
     * Par défaut : langue du programme ; le localStorage {@code pat-tool-calendar-holiday-names-mode} peut forcer {@code country}.
     */
    holidayNamesUseCountryLanguage = false;

    /** Recherche de saint → navigation directe vers le jour correspondant. */
    saintSearchQuery = '';
    saintSearchOpen = false;
    filteredSaintOptions: SaintDayOption[] = [];
    saintSearchActiveIndex: number | null = null;
    private saintSearchCloseTimer?: ReturnType<typeof setTimeout>;

    /** Calendrier des saints : liturgique romain ou traditionnel français. */
    saintCalendarId: SaintCalendarId = 'traditional';

    /** Largeur ≤768px : pastille titre sur 2 lignes max à partir du libellé complet. */
    calendarMobileUi = false;

    /** Modale mobile : entrée sélectionnée (clic sur une pastille). */
    mobileEntryDetail: MobileCalendarEntryDetail | null = null;

    /** Conserve l’événement FullCalendar pour « Modifier le RDV » après fermeture de la modale détail. */
    private mobileEntryClickArg: EventClickArg | null = null;

    ngOnInit(): void {
        try {
            const mode = localStorage.getItem(HOLIDAY_NAMES_MODE_STORAGE)?.trim().toLowerCase();
            if (mode === 'country') {
                this.holidayNamesUseCountryLanguage = true;
            } else if (mode === 'app') {
                this.holidayNamesUseCountryLanguage = false;
            }
        } catch {
            /* ignore */
        }
        try {
            const stored = localStorage.getItem(HOLIDAY_COUNTRY_STORAGE)?.trim();
            if (stored) {
                const up = stored.toUpperCase();
                if (/^[A-Z]{2}$/.test(up)) {
                    this.holidayCountryCode = up;
                    this.holidayCountryLockedFromStorage = true;
                }
            }
        } catch {
            /* ignore */
        }
        this.saintCalendarId = this.saintOfDayService.readStoredCalendarId();
        this.calendarOptions = this.buildCalendarOptions();
        this.calendarMobileUi = this.isCalendarMobileViewport();
        if (this.isAuthenticated()) {
            this.calendarService.prewarmAuthHeaders();
        }
        this.refreshCalendarEventUiStrings();
        this.loadFriendGroupsForCalendar();
        this.reloadSaintCalendarData();
        this.langChangeSub = this.translate.onLangChange.subscribe(() => {
            this.refreshCalendarEventUiStrings();
            this.saintSearchQuery = '';
            this.saintSearchOpen = false;
            this.saintSearchActiveIndex = null;
            this.reloadSaintCalendarData(() => {
                const api = this.fullCalendar?.getApi();
                if (api) {
                    api.setOption('locale', this.pickLocale());
                    api.refetchEvents();
                }
            });
        });
        this.publicHolidayService.getAvailableCountries().subscribe(list => {
            const valid = [...list].filter(c => c.key && /^[A-Za-z]{2}$/.test(c.key));
            if (valid.length > 0) {
                this.holidayCountries = valid.sort((a, b) =>
                    a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
                );
            } else {
                this.holidayCountries = [
                    { key: 'FR', name: 'France' },
                    { key: 'DE', name: 'Germany' },
                    { key: 'ES', name: 'Spain' },
                    { key: 'IT', name: 'Italy' },
                    { key: 'BE', name: 'Belgium' },
                    { key: 'CH', name: 'Switzerland' },
                    { key: 'GB', name: 'United Kingdom' },
                    { key: 'US', name: 'United States' }
                ];
            }
            const inList = (cc: string) => this.holidayCountries.some(c => c.key === cc);
            const finish = () => {
                if (!inList(this.holidayCountryCode)) {
                    this.holidayCountryCode = 'FR';
                }
                this.cdr.markForCheck();
                queueMicrotask(() => this.fullCalendar?.getApi()?.refetchEvents());
            };

            if (this.holidayCountryLockedFromStorage) {
                finish();
                return;
            }

            this.publicHolidayService.getClientCountryCode().subscribe(apiCc => {
                let pick = 'FR';
                if (apiCc && inList(apiCc)) {
                    pick = apiCc;
                } else {
                    const nav = this.guessCountryFromNavigatorLocale();
                    if (nav && inList(nav)) {
                        pick = nav;
                    }
                }
                this.holidayCountryCode = pick;
                finish();
            });
        });
    }

    /** Ex. {@code fr-CH} → CH ; sans région → null. */
    private guessCountryFromNavigatorLocale(): string | null {
        try {
            const lang = (typeof navigator !== 'undefined' ? navigator.language : '')?.trim() || '';
            const m = lang.match(/[-_]([A-Za-z]{2})$/);
            if (!m) {
                return null;
            }
            return m[1].toUpperCase();
        } catch {
            return null;
        }
    }

    onHolidayCountryChange(): void {
        const raw = (this.holidayCountryCode || 'FR').trim().toUpperCase();
        this.holidayCountryCode = /^[A-Z]{2}$/.test(raw) ? raw : 'FR';
        try {
            localStorage.setItem(HOLIDAY_COUNTRY_STORAGE, this.holidayCountryCode);
        } catch {
            /* ignore */
        }
        this.fullCalendar?.getApi().refetchEvents();
    }

    onHolidayNamesModeChange(): void {
        try {
            localStorage.setItem(
                HOLIDAY_NAMES_MODE_STORAGE,
                this.holidayNamesUseCountryLanguage ? 'country' : 'app'
            );
        } catch {
            /* ignore */
        }
        this.fullCalendar?.getApi().refetchEvents();
        this.cdr.markForCheck();
    }

    openCalendarHelp(): void {
        this.modal.open(this.calendarHelpModal, {
            size: 'lg',
            scrollable: true,
            centered: true,
            container: 'body',
            windowClass: 'calendar-help-modal pat-cal-agenda-modal-buttons'
        });
    }

    /**
     * Heure affichée dans la cellule : {@code timeText} FullCalendar si présent, sinon valeur précalculée
     * (évite allocations et formatage à chaque cycle de détection).
     */
    patCalCellTimeLabel(arg: { timeText?: string; event?: { extendedProps?: Record<string, unknown> } }): string {
        const tt = arg?.timeText?.trim();
        if (tt) {
            return tt;
        }
        const v = arg?.event?.extendedProps?.['cellTimeLabel'];
        return typeof v === 'string' ? v : '';
    }

    /** Titre d’infobulle (champs déjà calculés sur l’événement). */
    patCalTooltip(arg: { event?: { title?: string; extendedProps?: Record<string, unknown> } }): string | null {
        const ev = arg?.event;
        if (!ev) {
            return null;
        }
        const raw = ev.extendedProps?.['eventTooltip'];
        if (typeof raw === 'string' && raw.trim().length > 0) {
            return raw.trim();
        }
        const title = (ev.title || '').trim();
        return title.length > 0 ? title : null;
    }

    ngAfterViewInit(): void {
        queueMicrotask(() => this.applyCalendarLayoutForViewport());
    }

    @HostListener('window:resize')
    onCalendarWindowResize(): void {
        if (this.layoutResizeTimer !== undefined) {
            clearTimeout(this.layoutResizeTimer);
        }
        this.layoutResizeTimer = setTimeout(() => {
            this.layoutResizeTimer = undefined;
            this.applyCalendarLayoutForViewport();
        }, 150);
    }

    @HostListener('document:click', ['$event'])
    onSaintSearchDocumentClick(event: MouseEvent): void {
        const target = event.target;
        if (!(target instanceof Element) || target.closest('.pat-cal-saint-search')) {
            return;
        }
        if (this.saintSearchOpen) {
            this.saintSearchOpen = false;
            this.saintSearchActiveIndex = null;
            this.cdr.markForCheck();
        }
    }

    refreshSaintSearchOptions(): void {
        this.filteredSaintOptions = this.saintOfDayService.filterOptions(this.saintSearchQuery);
    }

    onSaintCalendarChange(): void {
        try {
            localStorage.setItem(SAINT_CALENDAR_STORAGE, this.saintCalendarId);
        } catch {
            /* ignore */
        }
        this.saintSearchQuery = '';
        this.saintSearchOpen = false;
        this.saintSearchActiveIndex = null;
        this.reloadSaintCalendarData();
    }

    private reloadSaintCalendarData(afterRender?: () => void): void {
        this.saintOfDayService.load(this.saintCalendarId).subscribe(() => {
            this.refreshSaintSearchOptions();
            this.fullCalendar?.getApi()?.render();
            afterRender?.();
            this.cdr.markForCheck();
        });
    }

    onSaintSearchQueryChange(): void {
        this.saintSearchOpen = true;
        this.saintSearchActiveIndex = null;
        this.refreshSaintSearchOptions();
    }

    onSaintSearchFocus(): void {
        if (this.saintSearchCloseTimer !== undefined) {
            clearTimeout(this.saintSearchCloseTimer);
            this.saintSearchCloseTimer = undefined;
        }
        this.saintSearchOpen = true;
        this.refreshSaintSearchOptions();
    }

    onSaintSearchBlur(): void {
        this.saintSearchCloseTimer = setTimeout(() => {
            this.saintSearchOpen = false;
            this.saintSearchActiveIndex = null;
            this.cdr.markForCheck();
        }, 160);
    }

    goToSaintDay(opt: SaintDayOption): void {
        const api = this.fullCalendar?.getApi();
        if (!api) {
            return;
        }
        const year = api.getDate().getFullYear();
        const date = this.saintOfDayService.dateFromOption(opt, year);
        api.gotoDate(date);
        if (api.view.type !== 'dayGridMonth') {
            api.changeView('dayGridMonth');
        }
        this.saintSearchQuery = opt.name;
        this.saintSearchOpen = false;
        this.saintSearchActiveIndex = null;
        this.cdr.markForCheck();
    }

    onSaintSearchKeydown(event: KeyboardEvent): void {
        if (!this.saintSearchOpen) {
            return;
        }
        const count = this.filteredSaintOptions.length;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!count) {
                return;
            }
            this.saintSearchActiveIndex = this.saintSearchActiveIndex === null
                ? 0
                : Math.min(this.saintSearchActiveIndex + 1, count - 1);
            this.cdr.markForCheck();
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (!count) {
                return;
            }
            this.saintSearchActiveIndex = this.saintSearchActiveIndex === null
                ? count - 1
                : Math.max(this.saintSearchActiveIndex - 1, 0);
            this.cdr.markForCheck();
            return;
        }
        if (event.key === 'Enter') {
            const pick = this.saintSearchActiveIndex !== null
                ? this.filteredSaintOptions[this.saintSearchActiveIndex]
                : (count === 1 ? this.filteredSaintOptions[0] : undefined);
            if (pick) {
                event.preventDefault();
                this.goToSaintDay(pick);
            }
            return;
        }
        if (event.key === 'Escape') {
            this.saintSearchOpen = false;
            this.saintSearchActiveIndex = null;
            this.cdr.markForCheck();
        }
    }

    /** Largeur ≤ 768px : même logique que les media queries du template agenda. */
    private isCalendarMobileViewport(): boolean {
        if (typeof window === 'undefined') {
            return false;
        }
        return window.innerWidth <= 768;
    }

    /**
     * Vue mois mobile : {@code dayMaxEvents: false} évite les pastilles « point » (souvent limitées à l’heure).
     * Desktop : comportement compact d’origine.
     */
    private applyCalendarLayoutForViewport(): void {
        this.calendarMobileUi = this.isCalendarMobileViewport();
        const api = this.fullCalendar?.getApi();
        if (api) {
            api.setOption('dayMaxEvents', this.calendarMobileUi ? false : true);
        }
        this.cdr.markForCheck();
    }

    ngOnDestroy(): void {
        if (this.layoutResizeTimer !== undefined) {
            clearTimeout(this.layoutResizeTimer);
            this.layoutResizeTimer = undefined;
        }
        if (this.gridLoadingOffTimer !== undefined) {
            clearTimeout(this.gridLoadingOffTimer);
            this.gridLoadingOffTimer = undefined;
        }
        if (this.saintSearchCloseTimer !== undefined) {
            clearTimeout(this.saintSearchCloseTimer);
            this.saintSearchCloseTimer = undefined;
        }
        this.langChangeSub?.unsubscribe();
        this.langChangeSub = undefined;
        this.revokeThumbnailBlobs();
    }

    isAuthenticated(): boolean {
        return this.keycloak.getAuth().authenticated;
    }

    /**
     * Opens the linked to-do list in a modal above the calendar (no navigation).
     * @param parentModal When set, closed/dismissed before opening the overlay (avoids stacked modals).
     * @param closeParent {@code close} or {@code dismiss} — matches previous anchor behaviour per modal.
     */
    openTodoListOverlay(
        listId: string | null | undefined,
        parentModal?: NgbActiveModal,
        closeParent: 'close' | 'dismiss' | 'none' = 'none'
    ): void {
        const id = (listId || '').trim();
        if (!id) {
            return;
        }
        const open = (): void => {
            this.todoListOverlay.open(id);
        };
        if (parentModal && closeParent === 'close') {
            parentModal.close();
            setTimeout(open, 0);
            return;
        }
        if (parentModal && closeParent === 'dismiss') {
            parentModal.dismiss();
            setTimeout(open, 0);
            return;
        }
        open();
    }

    private rebuildFriendGroupsSorted(): void {
        this.friendGroupsSorted = [...this.friendGroups].sort((a, b) => {
            const na = (a.name || '').toLowerCase();
            const nb = (b.name || '').toLowerCase();
            return na.localeCompare(nb, 'fr', { sensitivity: 'base' });
        });
    }

    trackByFriendGroupId(_index: number, g: FriendGroup): string {
        return (g.id || '').trim() || String(_index);
    }

    /** Nom d’utilisateur affiché après le libellé dans « qui peut voir ce RDV » (vide si déjà utilisé comme libellé seul). */
    visibilityRecipientUsername(r: CalendarVisibilityRecipient): string {
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

    /** True si début et fin ne sont pas le même jour (local) — pas d’heure affichée dans ce cas. */
    private eventSpansMultipleLocalDays(
        start: Date | string | null | undefined,
        end: Date | string | null | undefined
    ): boolean {
        if (!start || !end) {
            return false;
        }
        const s = start instanceof Date ? start : new Date(start);
        const e = end instanceof Date ? end : new Date(end);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
            return false;
        }
        const s0 = new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime();
        const e0 = new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime();
        return e0 > s0;
    }

    /** Heure dans la cellule (hors multi-jours), précalculée au chargement des entrées. */
    private computeCellTimeLabelForEntry(startIso: string, endIso: string): string {
        if (this.eventSpansMultipleLocalDays(startIso, endIso)) {
            return '';
        }
        const d = new Date(startIso);
        if (Number.isNaN(d.getTime())) {
            return '';
        }
        const loc = (this.translate.currentLang || 'fr').replace('_', '-');
        try {
            return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
        } catch {
            return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        }
    }

    loadVisibilityRecipients(): void {
        if (this.visibilityRecipientsLoading) {
            return;
        }
        const savedId = (this.editingId || '').trim();
        if (!savedId && !this.appointmentCanEdit) {
            return;
        }
        this.visibilityRecipientsShown = true;
        this.visibilityRecipientsLoading = true;
        this.visibilityRecipientsList = [];
        this.reminderMailErrorMessage = '';
        const vis = this.buildAppointmentVisibilityPayload();
        const previewBody = {
            visibility: vis.visibility,
            friendGroupId: vis.friendGroupId ?? null,
            friendGroupIds: vis.friendGroupIds ?? null
        };
        const req = savedId
            ? this.calendarService.getVisibilityRecipients(savedId)
            : this.calendarService.previewVisibilityRecipients(previewBody);
        req.pipe(
            finalize(() => {
                this.visibilityRecipientsLoading = false;
                this.cdr.markForCheck();
            })
        ).subscribe({
            next: rows => {
                this.visibilityRecipientsList = rows || [];
            },
            error: () => {
                this.visibilityRecipientsList = [];
                this.reminderMailErrorMessage = 'CALENDAR.VISIBILITY_RECIPIENTS_ERROR';
            }
        });
    }

    hideVisibilityRecipientsPanel(): void {
        this.visibilityRecipientsShown = false;
    }

    hideEventAccessUsersPanel(): void {
        this.eventAccessUsersShown = false;
    }

    /** Membres ayant accès à l’activité (modale détail), même API que le mur. */
    loadEventAccessUsersFromEntryDetail(): void {
        const id =
            this.mobileEntryDetail?.kind === 'ACTIVITY' ? (this.mobileEntryDetail.eventId || '').trim() : '';
        if (!id || !this.isAuthenticated() || this.eventAccessUsersLoading) {
            return;
        }
        this.eventAccessUsersShown = true;
        this.eventAccessUsersLoading = true;
        this.eventAccessUsersList = [];
        this.eventAccessUsersErrorMessage = '';
        this.evenementsService
            .getEventAccessUsers(id)
            .pipe(
                take(1),
                finalize(() => {
                    this.eventAccessUsersLoading = false;
                    this.cdr.markForCheck();
                })
            )
            .subscribe({
                next: users => {
                    this.eventAccessUsersList = this.mapAccessUsersApiResponse(users || []);
                },
                error: () => {
                    this.eventAccessUsersList = [];
                    this.eventAccessUsersErrorMessage = 'CALENDAR.VISIBILITY_RECIPIENTS_ERROR';
                }
            });
    }

    eventAccessUserDisplayName(u: Member): string {
        const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
        return name || (u.userName || '').trim() || (u.id || '').trim() || '—';
    }

    trackByEventAccessUserId(_index: number, u: Member): string {
        return (u.id || '').trim() || String(_index);
    }

    private mapAccessUsersApiResponse(users: any[]): Member[] {
        return (users || []).map((user: any) => {
            let rolesArray: string[] = [];
            if (user.roles) {
                if (typeof user.roles === 'string') {
                    rolesArray = user.roles
                        .split(',')
                        .map((r: string) => r.trim())
                        .filter((r: string) => r.length > 0);
                } else if (Array.isArray(user.roles)) {
                    rolesArray = user.roles;
                }
            }
            return new Member(
                user.id || '',
                user.addressEmail || '',
                user.firstName || '',
                user.lastName || '',
                user.userName || '',
                rolesArray,
                user.keycloakId || '',
                user.registrationDate ? new Date(user.registrationDate) : undefined,
                user.lastConnectionDate ? new Date(user.lastConnectionDate) : undefined,
                user.locale || undefined,
                user.whatsappLink || undefined,
                user.visible !== undefined ? user.visible : true
            );
        });
    }

    /** Liste « qui peut voir ce RDV » depuis la modale détail (RDV déjà enregistré). */
    loadVisibilityRecipientsFromEntryDetail(): void {
        const id = this.mobileEntryDetail?.kind === 'APPOINTMENT' ? (this.mobileEntryDetail.eventId || '').trim() : '';
        if (!id || !this.isAuthenticated() || this.visibilityRecipientsLoading) {
            return;
        }
        this.visibilityRecipientsShown = true;
        this.visibilityRecipientsLoading = true;
        this.visibilityRecipientsList = [];
        this.reminderMailErrorMessage = '';
        this.calendarService
            .getVisibilityRecipients(id)
            .pipe(
                finalize(() => {
                    this.visibilityRecipientsLoading = false;
                    this.cdr.markForCheck();
                })
            )
            .subscribe({
                next: rows => {
                    this.visibilityRecipientsList = rows || [];
                },
                error: () => {
                    this.visibilityRecipientsList = [];
                    this.reminderMailErrorMessage = 'CALENDAR.VISIBILITY_RECIPIENTS_ERROR';
                }
            });
    }

    /** Rappel par mail depuis la modale « détail ». */
    sendMobileEntryAppointmentReminderMail(): void {
        const d = this.mobileEntryDetail;
        if (d?.kind !== 'APPOINTMENT' || !d.appointmentCanSendReminder) {
            return;
        }
        this.invokeSendAppointmentReminderMail(d.eventId, true);
    }

    private invokeSendAppointmentReminderMail(appointmentId: string | null | undefined, allowed: boolean): void {
        const id = (appointmentId ?? '').trim();
        if (!id || !allowed || this.reminderMailLoading) {
            return;
        }
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
        this.reminderMailLoading = true;
        this.calendarService.sendAppointmentReminderMail(id).pipe(
            finalize(() => {
                this.reminderMailLoading = false;
                this.cdr.markForCheck();
            })
        ).subscribe({
            next: r => {
                this.reminderMailErrorMessage = '';
                if (r.skippedNoEmail > 0) {
                    this.reminderMailSuccessMessage = this.translate.instant('CALENDAR.REMINDER_MAIL_OK_WITH_SKIPPED', {
                        sent: r.emailsSent,
                        skipped: r.skippedNoEmail
                    });
                } else {
                    this.reminderMailSuccessMessage = this.translate.instant('CALENDAR.REMINDER_MAIL_OK', {
                        sent: r.emailsSent
                    });
                }
            },
            error: () => {
                this.reminderMailSuccessMessage = '';
                this.reminderMailErrorMessage = 'CALENDAR.REMINDER_MAIL_ERROR';
            }
        });
    }

    /**
     * Envoie un e-mail (API partage existante) à l’adresse du membre connecté avec les détails de l’activité
     * (HTML généré côté serveur, lien vers le mur).
     */
    sendActivityDetailsMailToSelf(): void {
        const d = this.mobileEntryDetail;
        const evId = d?.kind === 'ACTIVITY' ? d.eventId : '';
        if (!evId || !d?.activityCanSendDetailsMail || this.reminderMailLoading) {
            return;
        }
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
        this.reminderMailLoading = true;
        this.cdr.markForCheck();
        this.membersService.getUserId({ skipGeolocation: true }).pipe(take(1)).subscribe({
            next: member => {
                const email = (member.addressEmail || '').trim();
                if (!email) {
                    this.reminderMailLoading = false;
                    this.reminderMailErrorMessage = 'CALENDAR.ACTIVITY_DETAILS_MAIL_NO_EMAIL';
                    this.cdr.markForCheck();
                    return;
                }
                const origin = typeof window !== 'undefined' ? window.location.origin : '';
                const eventUrl = `${origin}/#/photos?eventId=${encodeURIComponent(evId)}`;
                const senderParts = [member.firstName, member.lastName].filter(x => !!(x || '').trim());
                const mergedSender = senderParts.join(' ').trim() || (member.userName || '').trim();
                const senderName = mergedSender.length > 0 ? mergedSender : undefined;
                const mailLang = (this.translate.currentLang || 'fr').trim();
                this.evenementsService
                    .shareEventByEmail(evId, [email], undefined, undefined, eventUrl, undefined, senderName, mailLang)
                    .pipe(
                        finalize(() => {
                            this.reminderMailLoading = false;
                            this.cdr.markForCheck();
                        })
                    )
                    .subscribe({
                        next: r => {
                            this.reminderMailErrorMessage = '';
                            if (r.sent > 0) {
                                this.reminderMailSuccessMessage = this.translate.instant(
                                    'CALENDAR.ACTIVITY_DETAILS_MAIL_OK',
                                    { sent: r.sent }
                                );
                            } else {
                                this.reminderMailSuccessMessage = '';
                                this.reminderMailErrorMessage = 'CALENDAR.ACTIVITY_DETAILS_MAIL_ERROR';
                            }
                        },
                        error: () => {
                            this.reminderMailSuccessMessage = '';
                            this.reminderMailErrorMessage = 'CALENDAR.ACTIVITY_DETAILS_MAIL_ERROR';
                        }
                    });
            },
            error: () => {
                this.reminderMailLoading = false;
                this.reminderMailErrorMessage = 'CALENDAR.ACTIVITY_DETAILS_MAIL_ERROR';
                this.cdr.markForCheck();
            }
        });
    }

    saveAppointment(): void {
        if (!this.appointmentCanEdit) {
            return;
        }
        const start = new Date(this.formStart);
        const end = new Date(this.formEnd);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            this.errorMessage = 'CALENDAR.SAVE_ERROR';
            this.cdr.markForCheck();
            return;
        }
        if (end.getTime() <= start.getTime()) {
            this.errorMessage = 'CALENDAR.SAVE_ERROR';
            this.cdr.markForCheck();
            return;
        }
        const vis = this.buildAppointmentVisibilityPayload();
        const payload: CalendarAppointmentPayload = {
            title: this.formTitle.trim(),
            notes: this.formNotes.trim() || null,
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            ...vis
        };
        this.formEnd = this.toDatetimeLocal(end);
        if (!payload.title) {
            return;
        }
        const req = this.editingId
            ? this.calendarService.updateAppointment(this.editingId, payload)
            : this.calendarService.createAppointment(payload);
        req.pipe(switchMap(res => this.applyAppointmentTodoListLink$(this.resolveSavedAppointmentId(res)))).subscribe({
            next: () => {
                this.errorMessage = '';
                this.reminderMailSuccessMessage = '';
                this.reminderMailErrorMessage = '';
                this.visibilityRecipientsShown = false;
                this.visibilityRecipientsList = [];
                this.modal.dismissAll();
                this.fullCalendar?.getApi().refetchEvents();
            },
            error: () => {
                this.errorMessage = 'CALENDAR.SAVE_ERROR';
                this.cdr.markForCheck();
            }
        });
    }

    private resolveSavedAppointmentId(res: { id?: string }): string {
        const fromEdit = (this.editingId || '').trim();
        if (fromEdit) {
            return fromEdit;
        }
        return ((res && res.id) || '').trim();
    }

    private applyAppointmentTodoListLink$(appointmentId: string): Observable<unknown> {
        const desired = (this.appointmentLinkedTodoListId || '').trim();
        const prev = (this.appointmentLinkedTodoListIdInitial || '').trim();
        if (!appointmentId) {
            return of(null);
        }
        if (desired === prev) {
            return of(null);
        }
        if (!desired) {
            if (!prev) {
                return of(null);
            }
            return this.todoListService.patchAssignment(prev, { calendarAppointmentId: null, evenementId: null });
        }
        return this.todoListService.patchAssignment(desired, {
            calendarAppointmentId: appointmentId,
            evenementId: null
        });
    }

    private loadAppointmentTodoListsForModal(): void {
        if (!this.isAuthenticated() || !this.appointmentCanEdit) {
            this.appointmentOwnedTodoLists = [];
            this.appointmentTodoListsLoading = false;
            this.cdr.markForCheck();
            return;
        }
        this.appointmentTodoListsLoading = true;
        this.cdr.markForCheck();
        this.membersService
            .getUserId({ skipGeolocation: true })
            .pipe(
                switchMap(m => {
                    this.currentMemberId = (m.id || '').trim();
                    return this.todoListService.listAccessible();
                })
            )
            .subscribe({
                next: lists => {
                    const uid = (this.currentMemberId || '').trim();
                    this.appointmentOwnedTodoLists = (lists || []).filter(
                        l => (l.ownerMemberId || '').trim() === uid && (l.id || '').trim().length > 0
                    );
                    this.appointmentTodoListsLoading = false;
                    this.cdr.markForCheck();
                },
                error: () => {
                    this.appointmentOwnedTodoLists = [];
                    this.appointmentTodoListsLoading = false;
                    this.cdr.markForCheck();
                }
            });
    }

    deleteEditingAppointment(): void {
        if (!this.editingId || !this.appointmentCanEdit) {
            return;
        }
        this.calendarService.deleteAppointment(this.editingId).subscribe({
            next: () => {
                this.errorMessage = '';
                this.reminderMailSuccessMessage = '';
                this.reminderMailErrorMessage = '';
                this.visibilityRecipientsShown = false;
                this.visibilityRecipientsList = [];
                this.modal.dismissAll();
                this.fullCalendar?.getApi().refetchEvents();
            },
            error: () => {
                this.errorMessage = 'CALENDAR.SAVE_ERROR';
            }
        });
    }

    private buildCalendarOptions(): CalendarOptions {
        return {
            plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
            initialView: 'dayGridMonth',
            headerToolbar: {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek'
            },
            locale: this.pickLocale(),
            firstDay: 1,
            weekends: true,
            editable: false,
            selectable: this.isAuthenticated(),
            selectMirror: true,
            longPressDelay: 280,
            selectLongPressDelay: 280,
            dayMaxEvents: !this.isCalendarMobileViewport(),
            nowIndicator: true,
            slotMinTime: '06:00:00',
            slotMaxTime: '22:00:00',
            scrollTime: '08:00:00',
            height: 'auto',
            contentHeight: undefined,
            allDaySlot: true,
            /*
             * Deux sources : les entrées API s’affichent dès qu’elles arrivent (sans attendre Nager),
             * les jours fériés se superposent ensuite. + cache des fériés côté PublicHolidayService.
             */
            eventContent: (arg: EventContentArg) => this.renderCalendarEventContent(arg),
            eventDidMount: (arg: EventMountArg) => this.onCalendarEventDidMount(arg),
            eventsSet: () => this.onCalendarEventsSet(),
            eventSources: [
                (info, successCallback, failureCallback) => {
                    const fetchToken = this.onCalendarEntriesFetchStart();
                    this.calendarService.getEntries(info.start, info.end).subscribe({
                        next: entries => {
                            if (fetchToken !== this.pendingEntriesPaintToken) {
                                return;
                            }
                            this.errorMessage = '';
                            this.applyThumbnailNeededIdsFromEntries(entries);
                            this.rebuildThumbEventIndex(entries);
                            this.pendingExpectedAgendaCount = entries.length;
                            this.rebuildPendingThumbIdsForPaint(entries);
                            this.entriesReadyPaintToken = fetchToken;
                            successCallback(this.mapEntriesToEvents(entries));
                            this.scheduleActivityThumbnailLoads(entries);
                            this.tryCompleteCalendarEntriesPaint();
                            this.cdr.markForCheck();
                        },
                        error: () => {
                            if (fetchToken === this.pendingEntriesPaintToken) {
                                this.onCalendarEntriesFetchFailed();
                            }
                            this.errorMessage = 'CALENDAR.LOAD_ERROR';
                            this.cdr.markForCheck();
                            failureCallback(new Error('calendar entries'));
                        }
                    });
                },
                (info, successCallback, _failureCallback) => {
                    const rawCc = (this.holidayCountryCode || 'FR').trim().toUpperCase();
                    const cc = /^[A-Z]{2}$/.test(rawCc) ? rawCc : 'FR';
                    this.holidaysForCalendarRange$(info.start, info.end).subscribe({
                        next: holidays => {
                            successCallback(this.mapPublicHolidaysToEvents(holidays, cc));
                            this.cdr.markForCheck();
                        },
                        error: () => {
                            successCallback([]);
                            this.cdr.markForCheck();
                        }
                    });
                }
            ],
            dayCellContent: (arg: DayCellContentArg) => this.formatDayCellContent(arg),
            eventClick: (arg: EventClickArg) => this.onEventClick(arg),
            select: (arg: DateSelectArg) => this.onCalendarSelect(arg),
            dateClick: (arg) => this.onCalendarDateClick(arg)
        };
    }

    private formatDayCellContent(arg: DayCellContentArg): { html: string } {
        const num = arg.dayNumberText;
        const badgeClass = `pat-cal-day-num badge${arg.isToday ? ' pat-cal-day-num--today' : ''}`;
        if (arg.view.type !== 'dayGridMonth') {
            return { html: num };
        }
        const saint = this.saintOfDayService.getName(arg.date);
        if (!saint) {
            return {
                html: `<div class="pat-cal-day-header pat-cal-day-header--solo"><span class="${badgeClass} pat-cal-day-num--solo">${num}</span></div>`
            };
        }
        const safe = this.escapeHtml(saint);
        return {
            html: `<div class="pat-cal-day-header"><em class="pat-cal-saint" title="${safe}">${safe}</em><span class="${badgeClass}">${num}</span></div>`
        };
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Sur mobile, un tap sur un jour (vue mois / liste) n’ouvre pas toujours {@code select} : on crée le RDV via {@code dateClick}.
     */
    private onCalendarDateClick(arg: { date: Date; allDay: boolean }): void {
        if (!this.isAuthenticated()) {
            return;
        }
        let start: Date;
        let end: Date;
        if (arg.allDay) {
            const d = arg.date;
            start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0, 0);
            end = this.clampEndToSameLocalDay(start, new Date(start.getTime() + 60 * 60 * 1000));
        } else {
            start = new Date(arg.date);
            end = new Date(start.getTime() + 60 * 60 * 1000);
        }
        this.editingId = null;
        this.formTitle = '';
        this.formNotes = '';
        this.appointmentLinkedTodoListId = '';
        this.appointmentLinkedTodoListIdInitial = '';
        this.resetAppointmentVisibilityForm();
        this.appointmentCanEdit = true;
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
        this.visibilityRecipientsShown = false;
        this.visibilityRecipientsList = [];
        this.formStart = this.toDatetimeLocal(start);
        this.formEnd = this.toDatetimeLocal(end);
        this.openAppointmentModalDebounced();
        this.cdr.markForCheck();
    }

    private openAppointmentModalDebounced(): void {
        const now = Date.now();
        if (now - this.lastNewAppointmentModalOpenedAt < 400) {
            return;
        }
        this.lastNewAppointmentModalOpenedAt = now;
        this.errorMessage = '';
        this.modal.open(this.appointmentModal, {
            size: 'md',
            windowClass: 'calendar-appointment-modal pat-cal-agenda-modal-buttons',
            scrollable: true,
            centered: true,
            container: 'body'
        });
        this.loadAppointmentTodoListsForModal();
    }

    private openAppointmentModalImmediate(): void {
        this.errorMessage = '';
        this.modal.open(this.appointmentModal, {
            size: 'md',
            windowClass: 'calendar-appointment-modal pat-cal-agenda-modal-buttons',
            scrollable: true,
            centered: true,
            container: 'body'
        });
        this.loadAppointmentTodoListsForModal();
    }

    /** 0–1 : heure locale de début dans la journée (détermine la teinte). */
    private dayFractionFromStart(startIso: string): number {
        const d = new Date(startIso);
        const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
        return Math.min(1, Math.max(0, minutes / (24 * 60)));
    }

    /**
     * 0–1 : « poids » visuel lié à la durée et à l’étalement sur plusieurs jours
     * (barre plus longue / plus haute sur le calendrier → couleur un peu plus marquée).
     */
    private visualWeightFromRange(startIso: string, endIso: string): number {
        const start = new Date(startIso);
        const end = new Date(endIso);
        const ms = Math.max(0, end.getTime() - start.getTime());
        const hours = Math.max(0.25, ms / 3600000);
        const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
        const endMid = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
        const daySpan = Math.max(1, Math.round((endMid - startMid) / 86400000) + 1);
        const hNorm = Math.min(1, hours / 6);
        const dNorm = Math.min(1, daySpan / 8);
        return Math.min(1, Math.max(hNorm, dNorm));
    }

    /** Activités : teinte selon l’heure de début ; intensité pastel selon durée / nombre de jours. */
    private activityColorsFromSchedule(startIso: string, endIso: string): { backgroundColor: string; borderColor: string } {
        const t = this.dayFractionFromStart(startIso);
        const w = this.visualWeightFromRange(startIso, endIso);
        const hue = t * 360;
        const sat = 36 + w * 16;
        const satB = 34 + w * 18;
        const lBg = 91 - w * 6;
        const lBd = 76 - w * 12;
        return {
            backgroundColor: `hsl(${hue} ${sat}% ${lBg}%)`,
            borderColor: `hsl(${hue} ${satB}% ${lBd}%)`
        };
    }

    /** RDV : plage bleu–sarcelle déplacée selon l’heure ; intensité selon durée / jours. */
    private appointmentColorsFromSchedule(startIso: string, endIso: string): { backgroundColor: string; borderColor: string } {
        const t = this.dayFractionFromStart(startIso);
        const w = this.visualWeightFromRange(startIso, endIso);
        const hue = 196 + t * 64;
        const sat = 44 + w * 14;
        const satB = 42 + w * 16;
        const lBg = 86 - w * 7;
        const lBd = 52 - w * 14;
        return {
            backgroundColor: `hsl(${hue} ${sat}% ${lBg}%)`,
            borderColor: `hsl(${hue} ${satB}% ${lBd}%)`
        };
    }

    private onEventClick(arg: EventClickArg): void {
        arg.jsEvent?.preventDefault?.();
        this.openEntryDetailModal(arg);
    }

    /** Modale détail : toutes les infos (texte = même contenu que l’infobulle). */
    private openEntryDetailModal(arg: EventClickArg): void {
        const rawKind = (arg.event.extendedProps?.['kind'] as string) || '';
        const kind: MobileCalendarEntryDetail['kind'] =
            rawKind === 'ACTIVITY' || rawKind === 'APPOINTMENT' || rawKind === 'PUBLIC_HOLIDAY'
                ? rawKind
                : 'ACTIVITY';
        const kindI18nKey =
            kind === 'ACTIVITY'
                ? 'CALENDAR.KIND_ACTIVITY'
                : kind === 'APPOINTMENT'
                  ? 'CALENDAR.KIND_APPOINTMENT'
                  : 'CALENDAR.KIND_PUBLIC_HOLIDAY';
        const headline = ((arg.event.title ?? '') as string).trim() || '—';
        const detailText =
            this.patCalTooltip({ event: arg.event })?.trim() ||
            headline;
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
        this.hideVisibilityRecipientsPanel();
        this.visibilityRecipientsList = [];
        this.hideEventAccessUsersPanel();
        this.eventAccessUsersList = [];
        this.eventAccessUsersErrorMessage = '';
        let appointmentCanSendReminder: boolean | undefined;
        let activityCanSendDetailsMail: boolean | undefined;
        if (kind === 'APPOINTMENT' && this.isAuthenticated()) {
            const owner = String(arg.event.extendedProps?.['ownerMemberId'] ?? '').trim();
            appointmentCanSendReminder =
                owner.length > 0 &&
                this.currentMemberId.length > 0 &&
                owner === this.currentMemberId;
            if (owner.length > 0) {
                this.membersService.getUserId({ skipGeolocation: true }).subscribe({
                    next: m => {
                        this.currentMemberId = (m.id || '').trim();
                        const can = owner === this.currentMemberId;
                        if (
                            this.mobileEntryDetail?.eventId === arg.event.id &&
                            this.mobileEntryDetail.kind === 'APPOINTMENT'
                        ) {
                            this.mobileEntryDetail = { ...this.mobileEntryDetail, appointmentCanSendReminder: can };
                            this.cdr.markForCheck();
                        }
                    },
                    error: () => {
                        /* garde appointmentCanSendReminder tel quel */
                    }
                });
            }
        }
        if (kind === 'ACTIVITY' && this.isAuthenticated()) {
            activityCanSendDetailsMail = false;
            this.membersService.getUserId({ skipGeolocation: true }).subscribe({
                next: m => {
                    const has = !!(m.addressEmail || '').trim();
                    if (
                        this.mobileEntryDetail?.eventId === arg.event.id &&
                        this.mobileEntryDetail.kind === 'ACTIVITY'
                    ) {
                        this.mobileEntryDetail = { ...this.mobileEntryDetail, activityCanSendDetailsMail: has };
                        this.cdr.markForCheck();
                    }
                },
                error: () => {
                    /* inchangé */
                }
            });
        }
        this.mobileEntryClickArg = arg;
        const extTodo = String(arg.event.extendedProps?.['todoListId'] ?? '').trim();
        this.mobileEntryDetail = {
            kind,
            kindI18nKey,
            eventId: arg.event.id,
            headline,
            detailText,
            appointmentCanSendReminder,
            activityCanSendDetailsMail,
            todoListId: extTodo || null
        };
        this.cdr.markForCheck();
        const ref = this.modal.open(this.mobileEntryDetailModal, {
            size: 'lg',
            scrollable: true,
            centered: true,
            container: 'body',
            windowClass: 'calendar-mobile-entry-detail-modal pat-cal-agenda-modal-buttons'
        });
        ref.result
            .then(
                () => undefined,
                () => undefined
            )
            .finally(() => {
                this.mobileEntryDetail = null;
                this.mobileEntryClickArg = null;
                this.hideVisibilityRecipientsPanel();
                this.visibilityRecipientsList = [];
                this.hideEventAccessUsersPanel();
                this.eventAccessUsersList = [];
                this.eventAccessUsersErrorMessage = '';
                this.cdr.markForCheck();
            });
    }

    openMobileEntryInPhotoWall(modal: NgbActiveModal): void {
        const id = this.mobileEntryDetail?.eventId;
        modal.close('photo-wall');
        if (id) {
            this.router.navigate(['/photos'], { queryParams: { eventId: id } });
        }
    }

    openMobileEntryAppointmentEditor(modal: NgbActiveModal): void {
        const saved = this.mobileEntryClickArg;
        modal.close('edit-appointment');
        if (saved && this.isAuthenticated()) {
            queueMicrotask(() => this.openAppointmentEditorFromEvent(saved));
        }
    }

    private openAppointmentEditorFromEvent(arg: EventClickArg): void {
        this.membersService.getUserId({ skipGeolocation: true }).subscribe({
            next: m => {
                this.currentMemberId = (m.id || '').trim();
                this.reminderMailSuccessMessage = '';
                this.reminderMailErrorMessage = '';
                this.visibilityRecipientsShown = false;
                this.visibilityRecipientsList = [];
                this.hideEventAccessUsersPanel();
                this.eventAccessUsersList = [];
                this.eventAccessUsersErrorMessage = '';
                const ext = arg.event.extendedProps;
                const owner = String(ext['ownerMemberId'] ?? '').trim();
                this.editingId = arg.event.id;
                this.formTitle = arg.event.title as string;
                this.formNotes = (ext['notes'] as string) || '';
                const startEv = arg.event.start!;
                const startD = startEv instanceof Date ? startEv : new Date(startEv);
                const endRaw = arg.event.end;
                const endD =
                    endRaw != null
                        ? endRaw instanceof Date
                            ? endRaw
                            : new Date(endRaw)
                        : new Date(startD.getTime() + 60 * 60 * 1000);
                this.formStart = this.toDatetimeLocal(startD);
                this.formEnd = this.toDatetimeLocal(endD);
                this.syncVisibilityFormFromExtendedProps(ext);
                const tl = String(ext['todoListId'] ?? '').trim();
                this.appointmentLinkedTodoListId = tl;
                this.appointmentLinkedTodoListIdInitial = tl;
                this.appointmentCanEdit =
                    this.currentMemberId.length > 0 && owner.length > 0 && owner === this.currentMemberId;
                this.loadAppointmentTodoListsForModal();
                this.openAppointmentModalImmediate();
                this.cdr.markForCheck();
            },
            error: () => {
                this.errorMessage = 'CALENDAR.SAVE_ERROR';
            }
        });
    }

    private onCalendarSelect(arg: DateSelectArg): void {
        if (!this.isAuthenticated()) {
            return;
        }
        this.editingId = null;
        this.formTitle = '';
        this.formNotes = '';
        this.appointmentLinkedTodoListId = '';
        this.appointmentLinkedTodoListIdInitial = '';
        this.resetAppointmentVisibilityForm();
        this.appointmentCanEdit = true;
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
        this.visibilityRecipientsShown = false;
        this.visibilityRecipientsList = [];
        const start = arg.start;
        const end = this.clampEndToSameLocalDay(start, arg.end);
        this.formStart = this.toDatetimeLocal(start);
        this.formEnd = this.toDatetimeLocal(end);
        this.openAppointmentModalDebounced();
        this.fullCalendar?.getApi().unselect();
        this.cdr.markForCheck();
    }

    /**
     * Nouveau RDV : fin sur le même jour calendaire (local) que le début.
     * Si la sélection traverse plusieurs jours, on garde l’heure de fin sur le jour de début quand c’est possible, sinon +1 h.
     */
    private clampEndToSameLocalDay(start: Date, end: Date): Date {
        const sy = start.getFullYear();
        const sm = start.getMonth();
        const sd = start.getDate();
        const startOfDay = new Date(sy, sm, sd).getTime();
        const nextDay = new Date(sy, sm, sd + 1).getTime();
        const tEnd = end.getTime();

        if (tEnd > start.getTime() && tEnd < nextDay && tEnd >= startOfDay) {
            return end;
        }

        const candidate = new Date(
            sy,
            sm,
            sd,
            end.getHours(),
            end.getMinutes(),
            end.getSeconds(),
            end.getMilliseconds()
        );

        if (candidate.getTime() > start.getTime() && candidate.getTime() < nextDay) {
            return candidate;
        }

        const plus1h = new Date(start.getTime() + 60 * 60 * 1000);
        if (plus1h.getTime() < nextDay) {
            return plus1h;
        }
        return new Date(nextDay - 1);
    }

    /** Plage horaire lisible pour l’infobulle (langue UI). */
    private formatEventRangeForTooltip(startIso: string, endIso: string, loc?: string): string {
        const s = new Date(startIso);
        const e = new Date(endIso);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
            return '';
        }
        const locale = loc ?? (this.translate.currentLang || 'fr').replace('_', '-');
        try {
            const sameDay =
                s.getFullYear() === e.getFullYear() &&
                s.getMonth() === e.getMonth() &&
                s.getDate() === e.getDate();
            if (sameDay) {
                const dateParts: Intl.DateTimeFormatOptions = {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                };
                const d = s.toLocaleDateString(locale, dateParts);
                const t0 = s.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                const t1 = e.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                return `${d} · ${t0} – ${t1}`;
            }
            const both: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
            return `${s.toLocaleString(locale, both)} — ${e.toLocaleString(locale, both)}`;
        } catch {
            return `${s.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })} — ${e.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}`;
        }
    }

    /** Date d’un jour férié tout-journée (YYYY-MM-DD) pour l’infobulle. */
    private formatAllDayDateForTooltip(ymd: string): string {
        const d = new Date(`${ymd}T12:00:00`);
        if (Number.isNaN(d.getTime())) {
            return '';
        }
        const loc = (this.translate.currentLang || 'fr').replace('_', '-');
        try {
            return d.toLocaleDateString(loc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        } catch {
            return d.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        }
    }

    private mapEntriesToEvents(entries: CalendarEntry[]): EventInput[] {
        const kindAppointment = this.translate.instant('CALENDAR.KIND_APPOINTMENT');
        const kindActivity = this.translate.instant('CALENDAR.KIND_ACTIVITY');
        const loc = (this.translate.currentLang || 'fr').replace('_', '-');
        return entries.map(e => {
            const colors =
                e.kind === 'APPOINTMENT'
                    ? this.appointmentColorsFromSchedule(e.start, e.end)
                    : this.activityColorsFromSchedule(e.start, e.end);
            const titleLine = (e.title || '').trim() || '—';
            const rangeLine = this.formatEventRangeForTooltip(e.start, e.end, loc);
            const notesLine = (e.notes || '').trim();
            const kindLabel = e.kind === 'APPOINTMENT' ? kindAppointment : kindActivity;
            const eventTooltip = [kindLabel + ': ' + titleLine, rangeLine, notesLine].filter(s => s.length > 0).join('\n');
            const tid = (e.thumbnailFileId || '').trim();
            const thumbCached = tid ? this.thumbnailBlobUrls.get(tid) : undefined;
            const ext: Record<string, unknown> = {
                kind: e.kind,
                thumbnailFileId: e.thumbnailFileId ?? null,
                notes: e.notes ?? null,
                calBg: colors.backgroundColor,
                calBorder: colors.borderColor,
                displayBorderLeft: `4px solid ${colors.borderColor}`,
                cellTimeLabel: this.computeCellTimeLabelForEntry(e.start, e.end),
                eventTooltip
            };
            if (thumbCached) {
                ext['thumbSrc'] = thumbCached;
            }
            if (e.kind === 'APPOINTMENT') {
                ext['ownerMemberId'] = e.ownerMemberId ?? null;
                ext['visibility'] = e.visibility ?? null;
                ext['friendGroupId'] = e.friendGroupId ?? null;
                ext['friendGroupIds'] = e.friendGroupIds ?? null;
            }
            if ((e.todoListId || '').trim()) {
                ext['todoListId'] = (e.todoListId || '').trim();
            } else {
                ext['todoListId'] = null;
            }
            return {
                id: e.id,
                title: titleLine,
                start: e.start,
                end: e.end,
                allDay: false,
                extendedProps: ext,
                backgroundColor: colors.backgroundColor,
                borderColor: colors.borderColor,
                textColor: '#2a3138'
            };
        });
    }

    private yearsOverlapping(start: Date, end: Date): number[] {
        const y0 = start.getFullYear();
        const y1 = end.getFullYear();
        const out: number[] = [];
        for (let y = y0; y <= y1; y++) {
            out.push(y);
        }
        return out;
    }

    private holidaysForCalendarRange$(start: Date, end: Date): Observable<NagerPublicHoliday[]> {
        const years = this.yearsOverlapping(start, end);
        const rawCc = (this.holidayCountryCode || 'FR').trim().toUpperCase();
        const cc = /^[A-Z]{2}$/.test(rawCc) ? rawCc : 'FR';
        const uiLangForHolidays =
            this.holidayNamesUseCountryLanguage
                ? undefined
                : (this.translate.currentLang || '').trim().toLowerCase() || undefined;
        if (years.length === 0) {
            return of([] as NagerPublicHoliday[]);
        }
        return forkJoin(
            years.map(y => this.publicHolidayService.getPublicHolidays(y, cc, uiLangForHolidays))
        ).pipe(map(arrays => arrays.flat()));
    }

    private mapPublicHolidaysToEvents(rows: NagerPublicHoliday[], countryCode: string): EventInput[] {
        const seen = new Set<string>();
        const out: EventInput[] = [];
        const cc = countryCode.toUpperCase();
        const kindHolidayLabel = this.translate.instant('CALENDAR.KIND_PUBLIC_HOLIDAY');
        for (const h of rows) {
            const key = this.holidayDedupeKey(h);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const local = (h.localName || '').trim();
            const en = (h.name || '').trim();
            const tr = (h.translatedName || '').trim();
            const baseTitle = this.holidayNamesUseCountryLanguage
                ? (local || en || '').trim() || '—'
                : (tr || en || local || '').trim() || '—';
            let holidayTip: string;
            if (this.holidayNamesUseCountryLanguage) {
                holidayTip = local && en && local !== en ? `${local} — ${en}` : local || en || baseTitle;
            } else {
                const parts: string[] = [];
                const add = (s: string) => {
                    const x = s.trim();
                    if (x && !parts.includes(x)) {
                        parts.push(x);
                    }
                };
                add(tr);
                add(baseTitle);
                add(local);
                add(en);
                holidayTip = parts.join(' — ');
            }
            const dateLine = this.formatAllDayDateForTooltip(h.date);
            const metaLines = this.holidayMetaTooltipLines(h);
            const eventTooltip = [
                kindHolidayLabel,
                dateLine,
                holidayTip,
                ...metaLines
            ]
                .map(s => (typeof s === 'string' ? s.trim() : ''))
                .filter(s => s.length > 0)
                .join('\n');
            const colors = this.holidayEventColors(h);
            const holidayKindKey = this.holidayShortKindI18nKey(h);
            let holidayKindLabel = '';
            if (holidayKindKey) {
                const t = this.translate.instant(holidayKindKey).trim();
                if (t.length > 0 && !t.startsWith('CALENDAR.')) {
                    holidayKindLabel = t;
                }
            }
            out.push({
                id: this.holidayStableEventId(cc, h),
                title: baseTitle,
                start: h.date,
                allDay: true,
                editable: false,
                extendedProps: {
                    kind: 'PUBLIC_HOLIDAY',
                    calBg: colors.bg,
                    calBorder: colors.border,
                    displayBorderLeft: `4px solid ${colors.border}`,
                    cellTimeLabel: '',
                    enName: h.name,
                    eventTooltip,
                    ...(holidayKindLabel ? { holidayKindLabel } : {}),
                    ...(holidayKindKey ? { holidayKindKey } : {})
                },
                backgroundColor: colors.bg,
                borderColor: colors.border,
                textColor: colors.text,
                classNames: ['pat-cal-holiday']
            });
        }
        return out;
    }

    /**
     * Nager peut renvoyer plusieurs lignes pour la même date (ex. 1er mai en Suisse : férié légal dans certains cantons,
     * simple commémoration ailleurs). La clé inclut types + cantons pour ne pas les fusionner à tort.
     */
    private holidayDedupeKey(h: NagerPublicHoliday): string {
        const types = (h.types ?? []).slice().sort().join(',');
        const counties = (h.counties ?? []).slice().sort().join(',');
        const g = h.global ? '1' : '0';
        return `${h.date}|${(h.name || '').trim()}|${(h.localName || '').trim()}|${types}|${g}|${counties}`;
    }

    private holidayStableEventId(cc: string, h: NagerPublicHoliday): string {
        const key = this.holidayDedupeKey(h);
        let h0 = 0;
        for (let i = 0; i < key.length; i++) {
            h0 = (Math.imul(31, h0) + key.charCodeAt(i)) | 0;
        }
        return `holiday-${cc}-${h.date}-${(h0 >>> 0).toString(16)}`;
    }

    private holidayHasType(h: NagerPublicHoliday, type: string): boolean {
        return (h.types ?? []).includes(type);
    }

    private holidayMetaTooltipLines(h: NagerPublicHoliday): string[] {
        const lines: string[] = [];
        const helpKey = this.holidayPrimaryHelpKey(h);
        if (helpKey) {
            const t = this.translate.instant(helpKey).trim();
            if (t.length > 0 && !t.startsWith('CALENDAR.')) {
                lines.push(t);
            }
        }
        if (h.global) {
            const s = this.translate.instant('CALENDAR.HOLIDAY_SCOPE_GLOBAL').trim();
            if (s.length > 0 && !s.startsWith('CALENDAR.')) {
                lines.push(s);
            }
        } else if (h.counties && h.counties.length > 0) {
            const max = 18;
            const list = h.counties.slice(0, max).join(', ');
            const more = h.counties.length > max ? '…' : '';
            const s = this.translate.instant('CALENDAR.HOLIDAY_SCOPE_REGIONS', { list: list + more }).trim();
            if (s.length > 0 && !s.startsWith('CALENDAR.')) {
                lines.push(s);
            }
        }
        return lines;
    }

    private holidayPrimaryHelpKey(h: NagerPublicHoliday): string | null {
        if (this.holidayHasType(h, 'Public')) {
            return 'CALENDAR.HOLIDAY_TYPE_HELP_PUBLIC';
        }
        if (this.holidayHasType(h, 'Observance')) {
            return 'CALENDAR.HOLIDAY_TYPE_HELP_OBSERVANCE';
        }
        if (this.holidayHasType(h, 'Bank')) {
            return 'CALENDAR.HOLIDAY_TYPE_HELP_BANK';
        }
        return null;
    }

    /** Libellé court (ligne sous le titre) : férié / pas férié / banque / etc. */
    private holidayShortKindI18nKey(h: NagerPublicHoliday): string | null {
        if (this.holidayHasType(h, 'Public')) {
            return 'CALENDAR.HOLIDAY_KIND_PUBLIC';
        }
        if (this.holidayHasType(h, 'Observance')) {
            return 'CALENDAR.HOLIDAY_KIND_OBSERVANCE';
        }
        if (this.holidayHasType(h, 'Bank')) {
            return 'CALENDAR.HOLIDAY_KIND_BANK';
        }
        if (this.holidayHasType(h, 'School')) {
            return 'CALENDAR.HOLIDAY_KIND_SCHOOL';
        }
        if (this.holidayHasType(h, 'Authorities')) {
            return 'CALENDAR.HOLIDAY_KIND_AUTHORITIES';
        }
        if (this.holidayHasType(h, 'Optional')) {
            return 'CALENDAR.HOLIDAY_KIND_OPTIONAL';
        }
        return null;
    }

    /** Couleurs : orange pour férié légal (Public), teinte plus froide pour seule commémoration / autres. */
    private holidayEventColors(h: NagerPublicHoliday): { bg: string; border: string; text: string } {
        if (this.holidayHasType(h, 'Public')) {
            return { bg: '#fff3e0', border: '#cc8f00', text: '#4a3500' };
        }
        if (this.holidayHasType(h, 'Observance')) {
            return { bg: '#eef2ff', border: '#6366f1', text: '#312e81' };
        }
        return { bg: '#f1f5f9', border: '#64748b', text: '#334155' };
    }

    private pickLocale(): LocaleInput {
        const raw = (this.translate.currentLang || 'fr').toLowerCase();
        if (raw === 'cn' || raw.startsWith('zh')) {
            return zhCnLocale;
        }
        if (raw === 'jp' || raw === 'ja') {
            return jaLocale;
        }
        const code = raw.slice(0, 2);
        const map: Record<string, LocaleInput> = {
            fr: frLocale,
            en: enGbLocale,
            de: deLocale,
            es: esLocale,
            it: itLocale,
            ar: arLocale,
            ru: ruLocale,
            el: elLocale,
            he: heLocale,
            in: hiLocale,
            hi: hiLocale
        };
        return map[code] ?? frLocale;
    }

    private revokeThumbnailBlobs(): void {
        for (const url of this.thumbnailBlobUrls.values()) {
            if (url.startsWith('blob:')) {
                URL.revokeObjectURL(url);
            }
        }
        this.thumbnailBlobUrls.clear();
        this.thumbnailLoadsInFlight.clear();
        this.thumbnailLoadQueue = [];
        this.thumbnailLoadsActive = 0;
        this.thumbnailNeededIds.clear();
        this.thumbFileIdToEventIds.clear();
    }

    private rebuildThumbEventIndex(entries: CalendarEntry[]): void {
        const map = new Map<string, string[]>();
        for (const e of entries) {
            if (e.kind !== 'ACTIVITY') {
                continue;
            }
            const fid = (e.thumbnailFileId || '').trim();
            const eid = (e.id || '').trim();
            if (!fid || !eid) {
                continue;
            }
            const list = map.get(fid);
            if (list) {
                list.push(eid);
            } else {
                map.set(fid, [eid]);
            }
        }
        this.thumbFileIdToEventIds = map;
    }

    /** Drop blob URLs for thumbnails no longer in range; keep URLs still needed (prevents NG0100 when FC refetches during render). */
    private applyThumbnailNeededIdsFromEntries(entries: CalendarEntry[]): void {
        const needed = new Set<string>();
        for (const e of entries) {
            if (e.kind === 'ACTIVITY' && e.thumbnailFileId?.trim()) {
                needed.add(e.thumbnailFileId.trim());
            }
        }
        this.thumbnailNeededIds = needed;
        if (this.thumbnailLoadQueue.length > 0) {
            this.thumbnailLoadQueue = this.thumbnailLoadQueue.filter(id => needed.has(id));
        }
        for (const id of [...this.thumbnailBlobUrls.keys()]) {
            if (!needed.has(id)) {
                const url = this.thumbnailBlobUrls.get(id);
                if (url?.startsWith('blob:')) {
                    URL.revokeObjectURL(url);
                }
                this.thumbnailBlobUrls.delete(id);
            }
        }
    }

    private scheduleActivityThumbnailLoads(entries: CalendarEntry[]): void {
        if (!this.isAuthenticated()) {
            return;
        }
        const pending = new Set<string>();
        for (const e of entries) {
            if (e.kind === 'ACTIVITY' && e.thumbnailFileId?.trim()) {
                pending.add(e.thumbnailFileId.trim());
            }
        }
        for (const fileId of pending) {
            if (this.thumbnailBlobUrls.has(fileId) || this.thumbnailLoadsInFlight.has(fileId)) {
                continue;
            }
            if (!this.thumbnailLoadQueue.includes(fileId)) {
                this.thumbnailLoadQueue.push(fileId);
            }
        }
        this.drainThumbnailLoadQueue();
    }

    private drainThumbnailLoadQueue(): void {
        while (
            this.thumbnailLoadsActive < CAL_THUMB_MAX_CONCURRENT &&
            this.thumbnailLoadQueue.length > 0
        ) {
            const fileId = this.thumbnailLoadQueue.shift()!;
            if (
                this.thumbnailBlobUrls.has(fileId) ||
                this.thumbnailLoadsInFlight.has(fileId) ||
                !this.thumbnailNeededIds.has(fileId)
            ) {
                continue;
            }
            this.ensureThumbnailLoaded(fileId);
        }
    }

    private ensureThumbnailLoaded(fileId: string): void {
        if (this.thumbnailBlobUrls.has(fileId) || this.thumbnailLoadsInFlight.has(fileId)) {
            return;
        }
        this.thumbnailLoadsInFlight.add(fileId);
        this.thumbnailLoadsActive++;
        this.fileService.getFileWallPreview(fileId, CAL_THUMB_PREVIEW_MAX_EDGE).pipe(
            catchError(() => of(null)),
            finalize(() => {
                this.thumbnailLoadsInFlight.delete(fileId);
                this.thumbnailLoadsActive = Math.max(0, this.thumbnailLoadsActive - 1);
                this.pendingThumbIdsForPaint.delete(fileId);
                this.tryCompleteCalendarEntriesPaint();
                this.drainThumbnailLoadQueue();
            })
        ).subscribe(res => {
            if (!res || !this.thumbnailNeededIds.has(fileId)) {
                return;
            }
            const blob = new Blob([res], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            this.thumbnailBlobUrls.set(fileId, url);
            this.applyThumbSrcToEvents(fileId, url);
        });
    }

    private applyThumbSrcToEvents(fileId: string, url: string): void {
        const api = this.fullCalendar?.getApi();
        if (!api) {
            return;
        }
        const eventIds = this.thumbFileIdToEventIds.get(fileId);
        if (eventIds?.length) {
            for (const id of eventIds) {
                const ev = api.getEventById(id);
                if (ev) {
                    ev.setExtendedProp('thumbSrc', url);
                }
            }
            return;
        }
        for (const ev of api.getEvents()) {
            const tid = String(ev.extendedProps['thumbnailFileId'] ?? '').trim();
            if (tid === fileId) {
                ev.setExtendedProp('thumbSrc', url);
            }
        }
    }

    private refreshCalendarEventUiStrings(): void {
        this.calMongoEntryHint = this.translate.instant('CALENDAR.MONGODB_ENTRY_HINT');
        this.calTodoListBtnHint = this.translate.instant('EVENTELEM.TODO_LIST_BUTTON_HINT');
    }

    /** @returns token to match against {@link onCalendarEventsSet} after paint. */
    private onCalendarEntriesFetchStart(): number {
        if (this.gridLoadingOffTimer !== undefined) {
            clearTimeout(this.gridLoadingOffTimer);
            this.gridLoadingOffTimer = undefined;
        }
        const token = ++this.pendingEntriesPaintToken;
        this.entriesReadyPaintToken = 0;
        this.pendingExpectedAgendaCount = -1;
        this.pendingThumbIdsForPaint.clear();
        this.calendarGridLoading = true;
        this.cdr.markForCheck();
        return token;
    }

    private onCalendarEntriesFetchFailed(): void {
        if (this.gridLoadingOffTimer !== undefined) {
            clearTimeout(this.gridLoadingOffTimer);
            this.gridLoadingOffTimer = undefined;
        }
        this.pendingEntriesPaintToken = 0;
        this.entriesReadyPaintToken = 0;
        this.pendingExpectedAgendaCount = -1;
        this.pendingThumbIdsForPaint.clear();
        this.calendarGridLoading = false;
        this.cdr.markForCheck();
    }

    private onCalendarEventsSet(): void {
        this.tryCompleteCalendarEntriesPaint();
    }

    private rebuildPendingThumbIdsForPaint(entries: CalendarEntry[]): void {
        this.pendingThumbIdsForPaint.clear();
        if (!this.isAuthenticated()) {
            return;
        }
        for (const e of entries) {
            if (e.kind !== 'ACTIVITY') {
                continue;
            }
            const fileId = (e.thumbnailFileId || '').trim();
            if (!fileId || this.thumbnailBlobUrls.has(fileId)) {
                continue;
            }
            this.pendingThumbIdsForPaint.add(fileId);
        }
    }

    private countAgendaEventsInStore(): number {
        const api = this.fullCalendar?.getApi();
        if (!api) {
            return 0;
        }
        return api.getEvents().filter(ev => {
            const kind = String(ev.extendedProps['kind'] ?? '');
            return kind === 'ACTIVITY' || kind === 'APPOINTMENT';
        }).length;
    }

    /**
     * Masque le spinner seulement quand toutes les activités + RDV sont dans FullCalendar
     * et que les miniatures activité en attente sont chargées (ou absentes).
     */
    private tryCompleteCalendarEntriesPaint(): void {
        const token = this.pendingEntriesPaintToken;
        if (token === 0 || this.entriesReadyPaintToken !== token) {
            return;
        }
        if (this.pendingExpectedAgendaCount < 0) {
            return;
        }
        if (this.countAgendaEventsInStore() !== this.pendingExpectedAgendaCount) {
            return;
        }
        if (this.pendingThumbIdsForPaint.size > 0) {
            return;
        }
        this.pendingEntriesPaintToken = 0;
        this.scheduleGridLoadingOffAfterPaint();
    }

    private scheduleGridLoadingOffAfterPaint(): void {
        const finish = () => {
            this.calendarGridLoading = false;
            this.cdr.markForCheck();
        };
        if (typeof requestAnimationFrame === 'undefined') {
            finish();
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.gridLoadingOffTimer !== undefined) {
                    clearTimeout(this.gridLoadingOffTimer);
                }
                this.gridLoadingOffTimer = setTimeout(() => {
                    this.gridLoadingOffTimer = undefined;
                    finish();
                }, 0);
            });
        });
    }

    private renderCalendarEventContent(arg: EventContentArg): { domNodes: Node[] } {
        const ev = arg.event;
        const ext = ev.extendedProps as Record<string, unknown>;
        const kind = String(ext['kind'] ?? '');

        const root = document.createElement('div');
        root.className =
            'fc-event-custom pat-cal-event-root w-100 min-w-0 px-1 rounded-1 d-flex flex-row align-items-start gap-1';
        const tooltip = String(ext['eventTooltip'] ?? ev.title ?? '').trim();
        if (tooltip) {
            root.title = tooltip;
        }
        root.style.backgroundColor = String(ext['calBg'] ?? 'transparent');
        root.style.borderLeft = String(ext['displayBorderLeft'] ?? '3px solid transparent');

        if (kind === 'APPOINTMENT') {
            const mongoIcon = document.createElement('i');
            mongoIcon.className = 'fa fa-exclamation-triangle fc-event-mongo-icon flex-shrink-0';
            mongoIcon.setAttribute('role', 'img');
            mongoIcon.title = this.calMongoEntryHint;
            mongoIcon.setAttribute('aria-label', this.calMongoEntryHint);
            root.appendChild(mongoIcon);
        } else if (kind === 'PUBLIC_HOLIDAY') {
            const flag = document.createElement('i');
            flag.className = 'fa fa-flag fc-event-holiday-icon flex-shrink-0';
            flag.setAttribute('aria-hidden', 'true');
            root.appendChild(flag);
        }

        const thumbSrc = String(ext['thumbSrc'] ?? '').trim();
        if (thumbSrc) {
            const img = document.createElement('img');
            img.src = thumbSrc;
            img.className = 'fc-event-thumb flex-shrink-0';
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.width = 22;
            img.height = 22;
            Object.assign(img.style, {
                width: '22px',
                height: '22px',
                maxWidth: '22px',
                maxHeight: '22px',
                objectFit: 'cover',
                flexShrink: '0'
            });
            root.appendChild(img);
        } else if (kind === 'APPOINTMENT') {
            const apptIcon = document.createElement('i');
            apptIcon.className = 'fa fa-calendar-check-o fc-event-appointment-icon flex-shrink-0';
            apptIcon.setAttribute('aria-hidden', 'true');
            root.appendChild(apptIcon);
        }

        const stack = document.createElement('div');
        stack.className = 'pat-cal-event-stack flex-grow-1 min-w-0';
        const oneflow = document.createElement('div');
        oneflow.className = 'pat-cal-event-oneflow';

        const cellTime =
            String(ext['cellTimeLabel'] ?? '').trim() || (arg.timeText || '').trim();
        if (cellTime) {
            const timeEl = document.createElement('span');
            timeEl.className = 'fc-event-time text-nowrap fw-semibold';
            timeEl.textContent = cellTime;
            oneflow.appendChild(timeEl);
        }

        const body = document.createElement('span');
        body.className =
            kind === 'PUBLIC_HOLIDAY'
                ? 'pat-cal-event-body lh-sm pat-cal-event-body--holiday'
                : 'pat-cal-event-body lh-sm';
        const titleLine = document.createElement('span');
        titleLine.className = 'pat-cal-event-title-line';

        if (kind === 'PUBLIC_HOLIDAY') {
            const kindLabel = String(ext['holidayKindLabel'] ?? '').trim();
            if (kindLabel) {
                const prefix = document.createElement('span');
                prefix.className = 'pat-cal-holiday-kind-prefix text-muted me-1';
                prefix.textContent = kindLabel;
                titleLine.appendChild(prefix);
            }
            const nameSpan = document.createElement('span');
            nameSpan.className = 'pat-cal-event-holiday-name';
            nameSpan.textContent = ev.title || '';
            titleLine.appendChild(nameSpan);
        } else {
            titleLine.textContent = ev.title || '';
        }
        body.appendChild(titleLine);
        oneflow.appendChild(body);
        stack.appendChild(oneflow);
        root.appendChild(stack);

        const todoListId = String(ext['todoListId'] ?? '').trim();
        if (this.isAuthenticated() && todoListId) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className =
                'fc-event-todolist-link flex-shrink-0 ms-1 text-decoration-none bg-transparent border-0';
            btn.title = this.calTodoListBtnHint;
            btn.setAttribute('aria-label', this.calTodoListBtnHint);
            btn.dataset['todoListId'] = todoListId;
            const tasksIcon = document.createElement('i');
            tasksIcon.className = 'fa fa-tasks';
            tasksIcon.setAttribute('aria-hidden', 'true');
            btn.appendChild(tasksIcon);
            root.appendChild(btn);
        }

        return { domNodes: [root] };
    }

    private onCalendarEventDidMount(arg: EventMountArg): void {
        const kind = String(arg.event.extendedProps['kind'] ?? '');
        if (kind === 'ACTIVITY' || kind === 'APPOINTMENT') {
            this.tryCompleteCalendarEntriesPaint();
        }
        const btn = arg.el.querySelector('.fc-event-todolist-link') as HTMLButtonElement | null;
        if (!btn || btn.dataset['patBound'] === '1') {
            return;
        }
        const listId = (btn.dataset['todoListId'] || '').trim();
        if (!listId) {
            return;
        }
        btn.dataset['patBound'] = '1';
        btn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            this.openTodoListOverlay(listId);
        });
    }

    private loadFriendGroupsForCalendar(): void {
        if (!this.isAuthenticated()) {
            this.friendGroups = [];
            this.rebuildFriendGroupsSorted();
            return;
        }
        this.friendsService.getFriendGroups().subscribe({
            next: groups => {
                this.friendGroups = groups || [];
                this.rebuildFriendGroupsSorted();
                this.cdr.markForCheck();
            },
            error: () => {
                this.friendGroups = [];
                this.rebuildFriendGroupsSorted();
            }
        });
        this.membersService.getUserId({ skipGeolocation: true }).subscribe({
            next: m => {
                this.currentMemberId = (m.id || '').trim();
                this.cdr.markForCheck();
            },
            error: () => {
                this.currentMemberId = '';
            }
        });
    }

    private resetAppointmentVisibilityForm(): void {
        this.formVisibilityPreset = 'private';
        this.formVisibilityGroupIds = [];
    }

    onAppointmentVisibilityPresetChange(): void {
        if (this.formVisibilityPreset !== 'friendGroups') {
            this.formVisibilityGroupIds = [];
        }
        this.cdr.markForCheck();
    }

    onAppointmentVisibilityGroupToggle(groupId: string, checked: boolean): void {
        const id = (groupId || '').trim();
        if (!id) {
            return;
        }
        const set = new Set(this.formVisibilityGroupIds.map(x => x.trim()).filter(Boolean));
        if (checked) {
            set.add(id);
        } else {
            set.delete(id);
        }
        this.formVisibilityGroupIds = [...set];
        this.cdr.markForCheck();
    }

    appointmentVisibilityGroupChecked(groupId: string | undefined): boolean {
        const id = (groupId || '').trim();
        return id.length > 0 && this.formVisibilityGroupIds.some(x => x.trim() === id);
    }

    private syncVisibilityFormFromExtendedProps(ext: Record<string, unknown>): void {
        const vis = String(ext['visibility'] ?? '').trim();
        const fgId = String(ext['friendGroupId'] ?? '').trim();
        const fgIds = ext['friendGroupIds'] as string[] | undefined;
        if (!vis || vis === 'private') {
            this.resetAppointmentVisibilityForm();
            return;
        }
        if (vis === 'public') {
            this.formVisibilityPreset = 'public';
            this.formVisibilityGroupIds = [];
            return;
        }
        if (vis === 'friends') {
            this.formVisibilityPreset = 'friends';
            this.formVisibilityGroupIds = [];
            return;
        }
        if (vis === 'friendGroups') {
            const ids = this.normalizeAppointmentGroupIdList(fgIds);
            this.formVisibilityPreset = 'friendGroups';
            this.formVisibilityGroupIds = ids.length > 0 ? ids : fgId ? [fgId] : [];
            return;
        }
        if (fgId) {
            this.formVisibilityPreset = 'friendGroups';
            this.formVisibilityGroupIds = [fgId];
            return;
        }
        const byName = this.friendGroups.find(g => g.name === vis);
        if (byName?.id) {
            this.formVisibilityPreset = 'friendGroups';
            this.formVisibilityGroupIds = [byName.id];
            return;
        }
        this.resetAppointmentVisibilityForm();
    }

    private buildAppointmentVisibilityPayload(): Pick<
        CalendarAppointmentPayload,
        'visibility' | 'friendGroupId' | 'friendGroupIds'
    > {
        const preset = this.formVisibilityPreset;
        if (preset === 'public' || preset === 'private' || preset === 'friends') {
            return { visibility: preset, friendGroupId: null, friendGroupIds: null };
        }
        if (preset === 'friendGroups') {
            const known = this.knownFriendGroupIdsForPayload(this.formVisibilityGroupIds);
            if (known.length === 0) {
                return { visibility: 'private', friendGroupId: null, friendGroupIds: null };
            }
            return {
                visibility: 'friendGroups',
                friendGroupId: known[0],
                friendGroupIds: known
            };
        }
        return { visibility: 'private', friendGroupId: null, friendGroupIds: null };
    }

    appointmentVisibilityReadOnlyLabel(): string {
        const preset = this.formVisibilityPreset;
        if (preset === 'public') {
            return this.translate.instant('EVENTCREATION.PUBLIC');
        }
        if (preset === 'private') {
            return this.translate.instant('EVENTCREATION.PRIVATE');
        }
        if (preset === 'friends') {
            return this.translate.instant('EVENTCREATION.FRIENDS');
        }
        if (preset === 'friendGroups') {
            const names = this.formVisibilityGroupIds
                .map(id => this.friendGroups.find(x => x.id === id)?.name)
                .filter((n): n is string => !!(n || '').trim());
            if (names.length === 0) {
                return this.translate.instant('CALENDAR.VISIBILITY_GROUP_FALLBACK');
            }
            return names.join(', ');
        }
        return this.translate.instant('EVENTCREATION.PRIVATE');
    }

    private normalizeAppointmentGroupIdList(raw: string[] | undefined | null): string[] {
        if (!raw || raw.length === 0) {
            return [];
        }
        const out: string[] = [];
        const seen = new Set<string>();
        for (const x of raw) {
            const id = String(x ?? '').trim();
            if (id && !seen.has(id)) {
                seen.add(id);
                out.push(id);
            }
        }
        return out;
    }

    /** Ids connus (chargés dans {@code friendGroups}), ordre stable pour l’API. */
    private knownFriendGroupIdsForPayload(ids: string[]): string[] {
        const known = new Set(this.friendGroups.map(g => (g.id || '').trim()).filter(Boolean));
        const picked = ids.map(x => x.trim()).filter(id => id && known.has(id));
        const order = new Map(this.friendGroupsSorted.map((g, i) => [(g.id || '').trim(), i]));
        return [...new Set(picked)].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
    }

    private toDatetimeLocal(d: Date): string {
        const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
}
