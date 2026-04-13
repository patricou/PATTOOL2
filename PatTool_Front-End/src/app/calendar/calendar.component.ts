import {
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
import { Router, RouterModule } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbModal, NgbModalModule } from '@ng-bootstrap/ng-bootstrap';
import { FullCalendarComponent, FullCalendarModule } from '@fullcalendar/angular';
import { CalendarOptions, DateSelectArg, EventClickArg, EventInput, LocaleInput } from '@fullcalendar/core';
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
import { catchError, finalize, map } from 'rxjs/operators';
import { forkJoin, of } from 'rxjs';
import { KeycloakService } from '../keycloak/keycloak.service';
import { FileService } from '../services/file.service';
import { FriendsService } from '../services/friends.service';
import { MembersService } from '../services/members.service';
import { FriendGroup } from '../model/friend';
import { CalendarEntry, CalendarAppointmentPayload, CalendarService } from './calendar.service';
import { CALENDAR_HELP_TEXT_EN, CALENDAR_HELP_TEXT_FR } from './calendar-help-text';
import { NagerPublicHoliday, PublicHolidayService } from './public-holiday.service';

const HOLIDAY_COUNTRY_STORAGE = 'pat-tool-calendar-holiday-country';
const HOLIDAY_NAMES_MODE_STORAGE = 'pat-tool-calendar-holiday-names-mode';

@Component({
    selector: 'app-calendar',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterModule, TranslateModule, NgbModalModule, FullCalendarModule],
    templateUrl: './calendar.component.html',
    styleUrls: ['./calendar.component.css']
})
export class CalendarComponent implements OnInit, OnDestroy {

    @ViewChild('appointmentModal') appointmentModal!: TemplateRef<unknown>;
    @ViewChild('calendarHelpModal') calendarHelpModal!: TemplateRef<unknown>;
    @ViewChild('fc') fullCalendar!: FullCalendarComponent;

    /** Textes d’aide (FR / EN) pour la modale — hors ngx-translate. */
    readonly calendarHelpFr = CALENDAR_HELP_TEXT_FR;
    readonly calendarHelpEn = CALENDAR_HELP_TEXT_EN;

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

    private thumbnailBlobUrls = new Map<string, string>();
    private thumbnailLoadsInFlight = new Set<string>();

    /** Détecte double-clic sur une activité pour ouvrir le mur (un simple clic ne navigue plus). */
    private lastActivityClick: { id: string; t: number } | null = null;

    /** Évite double ouverture si {@code select} et {@code dateClick} se déclenchent de près (mobile). */
    private lastNewAppointmentModalOpenedAt = 0;

    calendarOptions!: CalendarOptions;
    errorMessage = '';
    reminderMailSuccessMessage = '';
    reminderMailErrorMessage = '';
    reminderMailLoading = false;
    editingId: string | null = null;
    formTitle = '';
    formNotes = '';
    formStart = '';
    formEnd = '';
    /** public | private | friends | fg:{groupId} */
    formVisibilityValue = 'private';
    friendGroups: FriendGroup[] = [];
    currentMemberId = '';
    appointmentCanEdit = true;

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
        this.calendarOptions = this.buildCalendarOptions();
        this.loadFriendGroupsForCalendar();
        this.translate.onLangChange.subscribe(() => {
            const api = this.fullCalendar?.getApi();
            if (api) {
                api.setOption('locale', this.pickLocale());
                api.refetchEvents();
            }
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
            windowClass: 'calendar-help-modal'
        });
    }

    showHolidayIcon(arg: { event: { extendedProps: Record<string, unknown> } }): boolean {
        return arg.event.extendedProps['kind'] === 'PUBLIC_HOLIDAY';
    }

    /** Rendez-vous issus de la collection MongoDB {@code calendar_appointments} uniquement (pas les activités ni les fériés). */
    showMongoEntryIcon(arg: { event: { extendedProps: Record<string, unknown> } }): boolean {
        return arg.event.extendedProps['kind'] === 'APPOINTMENT';
    }

    /**
     * Infobulle native sur la ligne d’événement : texte complet (titre, horaires, notes ; férié pays + international).
     */
    calendarEventTooltip(arg: unknown): string | null {
        const ev = (arg as { event?: { title?: string; extendedProps?: Record<string, unknown> } })?.event;
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

    ngOnDestroy(): void {
        this.revokeThumbnailBlobs();
    }

    isAuthenticated(): boolean {
        return this.keycloak.getAuth().authenticated;
    }

    /** Friend groups sorted by name for the visibility dropdown. */
    get sortedFriendGroups(): FriendGroup[] {
        return [...this.friendGroups].sort((a, b) => {
            const na = (a.name || '').toLowerCase();
            const nb = (b.name || '').toLowerCase();
            return na.localeCompare(nb, 'fr', { sensitivity: 'base' });
        });
    }

    friendGroupOptionValue(g: FriendGroup): string {
        return g?.id ? `fg:${g.id}` : '';
    }

    /** Thumbnail in custom event template (blob after load). */
    eventThumbSrc(arg: { event: { extendedProps: Record<string, unknown> } }): string | null {
        const id = (arg.event.extendedProps['thumbnailFileId'] as string | undefined)?.trim();
        if (!id) {
            return null;
        }
        return this.thumbnailBlobUrls.get(id) ?? null;
    }

    /** Personal appointment without activity thumbnail: show calendar glyph in the cell. */
    showAppointmentIcon(arg: { event: { extendedProps: Record<string, unknown> } }): boolean {
        const kind = arg.event.extendedProps['kind'] as string | undefined;
        if (kind !== 'APPOINTMENT') {
            return false;
        }
        return !this.eventThumbSrc(arg);
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

    /**
     * Heure de début dans la cellule (hors événements multi-jours).
     * {@code timeText} de FullCalendar si présent, sinon format local de {@code event.start}.
     */
    eventTimeLabel(arg: unknown): string {
        const a = arg as {
            timeText?: string;
            event?: { start?: Date | string | null; end?: Date | string | null; allDay?: boolean };
        };
        const ev = a.event;
        if (!ev || ev.allDay || !ev.start) {
            return '';
        }
        if (this.eventSpansMultipleLocalDays(ev.start, ev.end)) {
            return '';
        }
        const tt = a.timeText?.trim();
        if (tt) {
            return tt;
        }
        const s = ev.start;
        const d = s instanceof Date ? s : new Date(s);
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

    sendAppointmentReminderMail(): void {
        if (!this.editingId || !this.appointmentCanEdit || this.reminderMailLoading) {
            return;
        }
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
        this.reminderMailLoading = true;
        this.calendarService.sendAppointmentReminderMail(this.editingId).pipe(
            finalize(() => {
                this.reminderMailLoading = false;
                this.cdr.markForCheck();
            })
        ).subscribe({
            next: r => {
                this.reminderMailErrorMessage = '';
                this.reminderMailSuccessMessage = this.translate.instant('CALENDAR.REMINDER_MAIL_OK', {
                    sent: r.emailsSent,
                    skipped: r.skippedNoEmail
                });
            },
            error: () => {
                this.reminderMailSuccessMessage = '';
                this.reminderMailErrorMessage = 'CALENDAR.REMINDER_MAIL_ERROR';
            }
        });
    }

    saveAppointment(): void {
        if (!this.appointmentCanEdit) {
            return;
        }
        const start = new Date(this.formStart);
        const end = this.clampEndToSameLocalDay(start, new Date(this.formEnd));
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
        req.subscribe({
            next: () => {
                this.errorMessage = '';
                this.reminderMailSuccessMessage = '';
                this.reminderMailErrorMessage = '';
                this.modal.dismissAll();
                this.fullCalendar?.getApi().refetchEvents();
            },
            error: () => {
                this.errorMessage = 'CALENDAR.SAVE_ERROR';
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
            dayMaxEvents: true,
            nowIndicator: true,
            slotMinTime: '06:00:00',
            slotMaxTime: '22:00:00',
            scrollTime: '08:00:00',
            height: 'auto',
            contentHeight: 640,
            allDaySlot: true,
            events: (info, successCallback, failureCallback) => {
                this.errorMessage = '';
                const years = this.yearsOverlapping(info.start, info.end);
                const rawCc = (this.holidayCountryCode || 'FR').trim().toUpperCase();
                const cc = /^[A-Z]{2}$/.test(rawCc) ? rawCc : 'FR';
                const uiLangForHolidays =
                    this.holidayNamesUseCountryLanguage
                        ? undefined
                        : (this.translate.currentLang || '').trim().toLowerCase() || undefined;
                const holiday$ =
                    years.length > 0
                        ? forkJoin(
                              years.map(y =>
                                  this.publicHolidayService.getPublicHolidays(y, cc, uiLangForHolidays)
                              )
                          ).pipe(map(arrays => arrays.flat()))
                        : of([] as NagerPublicHoliday[]);
                forkJoin({
                    entries: this.calendarService.getEntries(info.start, info.end),
                    holidays: holiday$
                }).subscribe({
                    next: ({ entries, holidays }) => {
                        this.revokeThumbnailBlobs();
                        this.scheduleActivityThumbnailLoads(entries);
                        const merged = [
                            ...this.mapEntriesToEvents(entries),
                            ...this.mapPublicHolidaysToEvents(holidays, cc)
                        ];
                        successCallback(merged);
                    },
                    error: () => {
                        this.errorMessage = 'CALENDAR.LOAD_ERROR';
                        failureCallback(new Error('calendar load'));
                    }
                });
            },
            eventClick: (arg: EventClickArg) => this.onEventClick(arg),
            select: (arg: DateSelectArg) => this.onCalendarSelect(arg),
            dateClick: (arg) => this.onCalendarDateClick(arg)
        };
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
        this.formVisibilityValue = 'private';
        this.appointmentCanEdit = true;
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
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
        this.modal.open(this.appointmentModal, {
            size: 'md',
            windowClass: 'calendar-appointment-modal',
            scrollable: true,
            centered: true,
            container: 'body'
        });
    }

    private openAppointmentModalImmediate(): void {
        this.modal.open(this.appointmentModal, {
            size: 'md',
            windowClass: 'calendar-appointment-modal',
            scrollable: true,
            centered: true,
            container: 'body'
        });
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

    /** Fond coloré sur le HTML custom (FullCalendar ne remplit pas toujours l’intérieur du template). */
    calendarRowBg(arg: { event: { extendedProps: Record<string, unknown> } }): string {
        const v = arg.event.extendedProps['calBg'] as string | undefined;
        return v?.trim() ? v : 'transparent';
    }

    /** Accent gauche (bordure) pour que la couleur se lise même en vue compacte. */
    calendarRowBorderLeft(arg: { event: { extendedProps: Record<string, unknown> } }): string {
        const b = arg.event.extendedProps['calBorder'] as string | undefined;
        if (!b?.trim()) {
            return '3px solid transparent';
        }
        return `4px solid ${b}`;
    }

    private onEventClick(arg: EventClickArg): void {
        const kind = arg.event.extendedProps['kind'] as string | undefined;
        if (kind === 'PUBLIC_HOLIDAY') {
            return;
        }
        if (kind === 'ACTIVITY') {
            arg.jsEvent.preventDefault();
            const id = arg.event.id;
            const now = Date.now();
            if (
                this.lastActivityClick &&
                this.lastActivityClick.id === id &&
                now - this.lastActivityClick.t < 550
            ) {
                this.lastActivityClick = null;
                this.router.navigate(['/photos'], { queryParams: { eventId: id } });
            } else {
                this.lastActivityClick = { id, t: now };
            }
            return;
        } else if (kind === 'APPOINTMENT' && this.isAuthenticated()) {
            this.membersService.getUserId({ skipGeolocation: true }).subscribe({
                next: m => {
                    this.currentMemberId = (m.id || '').trim();
                    this.reminderMailSuccessMessage = '';
                    this.reminderMailErrorMessage = '';
                    const ext = arg.event.extendedProps;
                    const owner = String(ext['ownerMemberId'] ?? '').trim();
                    this.editingId = arg.event.id;
                    this.formTitle = arg.event.title;
                    this.formNotes = (ext['notes'] as string) || '';
                    this.formStart = this.toDatetimeLocal(arg.event.start!);
                    this.formEnd = this.toDatetimeLocal(arg.event.end!);
                    this.syncVisibilityFormFromExtendedProps(ext);
                    this.appointmentCanEdit =
                        this.currentMemberId.length > 0 && owner.length > 0 && owner === this.currentMemberId;
                    this.openAppointmentModalImmediate();
                    this.cdr.markForCheck();
                },
                error: () => {
                    this.errorMessage = 'CALENDAR.SAVE_ERROR';
                }
            });
        }
    }

    private onCalendarSelect(arg: DateSelectArg): void {
        if (!this.isAuthenticated()) {
            return;
        }
        this.editingId = null;
        this.formTitle = '';
        this.formNotes = '';
        this.formVisibilityValue = 'private';
        this.appointmentCanEdit = true;
        this.reminderMailSuccessMessage = '';
        this.reminderMailErrorMessage = '';
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
    private formatEventRangeForTooltip(startIso: string, endIso: string): string {
        const s = new Date(startIso);
        const e = new Date(endIso);
        if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
            return '';
        }
        const loc = (this.translate.currentLang || 'fr').replace('_', '-');
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
                const d = s.toLocaleDateString(loc, dateParts);
                const t0 = s.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
                const t1 = e.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
                return `${d} · ${t0} – ${t1}`;
            }
            const both: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
            return `${s.toLocaleString(loc, both)} — ${e.toLocaleString(loc, both)}`;
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
        return entries.map(e => {
            const colors =
                e.kind === 'APPOINTMENT'
                    ? this.appointmentColorsFromSchedule(e.start, e.end)
                    : this.activityColorsFromSchedule(e.start, e.end);
            const titleLine = (e.title || '').trim() || '—';
            const rangeLine = this.formatEventRangeForTooltip(e.start, e.end);
            const notesLine = (e.notes || '').trim();
            const kindLabel =
                e.kind === 'APPOINTMENT'
                    ? this.translate.instant('CALENDAR.KIND_APPOINTMENT')
                    : this.translate.instant('CALENDAR.KIND_ACTIVITY');
            const eventTooltip = [kindLabel + ': ' + titleLine, rangeLine, notesLine].filter(s => s.length > 0).join('\n');
            const ext: Record<string, unknown> = {
                kind: e.kind,
                thumbnailFileId: e.thumbnailFileId ?? null,
                notes: e.notes ?? null,
                calBg: colors.backgroundColor,
                calBorder: colors.borderColor,
                eventTooltip
            };
            if (e.kind === 'APPOINTMENT') {
                ext['ownerMemberId'] = e.ownerMemberId ?? null;
                ext['visibility'] = e.visibility ?? null;
                ext['friendGroupId'] = e.friendGroupId ?? null;
                ext['friendGroupIds'] = e.friendGroupIds ?? null;
            }
            return {
                id: e.id,
                title: e.title,
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

    private mapPublicHolidaysToEvents(rows: NagerPublicHoliday[], countryCode: string): EventInput[] {
        const seen = new Set<string>();
        const out: EventInput[] = [];
        const cc = countryCode.toUpperCase();
        for (const h of rows) {
            const key = `${h.date}|${(h.name || '').trim()}|${(h.localName || '').trim()}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const local = (h.localName || '').trim();
            const en = (h.name || '').trim();
            const tr = (h.translatedName || '').trim();
            const title = this.holidayNamesUseCountryLanguage
                ? (local || en || '').trim() || '—'
                : (tr || en || local || '').trim() || '—';
            let holidayTip: string;
            if (this.holidayNamesUseCountryLanguage) {
                holidayTip = local && en && local !== en ? `${local} — ${en}` : local || en || title;
            } else {
                const parts: string[] = [];
                const add = (s: string) => {
                    const x = s.trim();
                    if (x && !parts.includes(x)) {
                        parts.push(x);
                    }
                };
                add(tr);
                add(title);
                add(local);
                add(en);
                holidayTip = parts.join(' — ');
            }
            const dateLine = this.formatAllDayDateForTooltip(h.date);
            const eventTooltip = [this.translate.instant('CALENDAR.KIND_PUBLIC_HOLIDAY'), dateLine, holidayTip]
                .map(s => (typeof s === 'string' ? s.trim() : ''))
                .filter(s => s.length > 0)
                .join('\n');
            out.push({
                id: `holiday-${cc}-${h.date}`,
                title,
                start: h.date,
                allDay: true,
                editable: false,
                extendedProps: {
                    kind: 'PUBLIC_HOLIDAY',
                    calBg: '#fff3e0',
                    calBorder: '#cc8f00',
                    enName: h.name,
                    eventTooltip
                },
                backgroundColor: '#fff3e0',
                borderColor: '#cc8f00',
                textColor: '#4a3500',
                classNames: ['pat-cal-holiday']
            });
        }
        return out;
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
    }

    private scheduleActivityThumbnailLoads(entries: CalendarEntry[]): void {
        if (!this.isAuthenticated()) {
            return;
        }
        const ids = new Set<string>();
        for (const e of entries) {
            if (e.kind === 'ACTIVITY' && e.thumbnailFileId?.trim()) {
                ids.add(e.thumbnailFileId.trim());
            }
        }
        for (const fileId of ids) {
            this.ensureThumbnailLoaded(fileId);
        }
    }

    private ensureThumbnailLoaded(fileId: string): void {
        if (this.thumbnailBlobUrls.has(fileId) || this.thumbnailLoadsInFlight.has(fileId)) {
            return;
        }
        this.thumbnailLoadsInFlight.add(fileId);
        this.fileService.getFile(fileId).pipe(
            catchError(() => of(null)),
            finalize(() => this.thumbnailLoadsInFlight.delete(fileId))
        ).subscribe(res => {
            if (res) {
                const blob = new Blob([res], { type: 'application/octet-stream' });
                this.thumbnailBlobUrls.set(fileId, URL.createObjectURL(blob));
                this.fullCalendar?.getApi().render();
                this.cdr.markForCheck();
            }
        });
    }

    private loadFriendGroupsForCalendar(): void {
        if (!this.isAuthenticated()) {
            this.friendGroups = [];
            return;
        }
        this.friendsService.getFriendGroups().subscribe({
            next: groups => {
                this.friendGroups = groups || [];
                this.cdr.markForCheck();
            },
            error: () => {
                this.friendGroups = [];
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

    private syncVisibilityFormFromExtendedProps(ext: Record<string, unknown>): void {
        const vis = String(ext['visibility'] ?? '').trim();
        const fgId = String(ext['friendGroupId'] ?? '').trim();
        const fgIds = ext['friendGroupIds'] as string[] | undefined;
        if (!vis || vis === 'private') {
            this.formVisibilityValue = 'private';
            return;
        }
        if (vis === 'public') {
            this.formVisibilityValue = 'public';
            return;
        }
        if (vis === 'friends') {
            this.formVisibilityValue = 'friends';
            return;
        }
        if (vis === 'friendGroups' && fgIds && fgIds.length > 0) {
            this.formVisibilityValue = `fg:${String(fgIds[0]).trim()}`;
            return;
        }
        if (fgId) {
            this.formVisibilityValue = `fg:${fgId}`;
            return;
        }
        const byName = this.friendGroups.find(g => g.name === vis);
        if (byName?.id) {
            this.formVisibilityValue = `fg:${byName.id}`;
            return;
        }
        this.formVisibilityValue = 'private';
    }

    private buildAppointmentVisibilityPayload(): Pick<
        CalendarAppointmentPayload,
        'visibility' | 'friendGroupId' | 'friendGroupIds'
    > {
        const v = (this.formVisibilityValue || 'private').trim();
        if (v === 'public' || v === 'private' || v === 'friends') {
            return { visibility: v, friendGroupId: null, friendGroupIds: null };
        }
        if (v.startsWith('fg:')) {
            const id = v.slice(3).trim();
            const g = this.friendGroups.find(x => x.id === id);
            if (g?.name) {
                return {
                    visibility: g.name,
                    friendGroupId: g.id,
                    friendGroupIds: null
                };
            }
        }
        return { visibility: 'private', friendGroupId: null, friendGroupIds: null };
    }

    appointmentVisibilityReadOnlyLabel(): string {
        const v = (this.formVisibilityValue || 'private').trim();
        if (v === 'public') {
            return this.translate.instant('EVENTCREATION.PUBLIC');
        }
        if (v === 'private') {
            return this.translate.instant('EVENTCREATION.PRIVATE');
        }
        if (v === 'friends') {
            return this.translate.instant('EVENTCREATION.FRIENDS');
        }
        if (v.startsWith('fg:')) {
            const id = v.slice(3).trim();
            const g = this.friendGroups.find(x => x.id === id);
            return g?.name || this.translate.instant('CALENDAR.VISIBILITY_GROUP_FALLBACK');
        }
        return this.translate.instant('EVENTCREATION.PRIVATE');
    }

    private toDatetimeLocal(d: Date): string {
        const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
}
