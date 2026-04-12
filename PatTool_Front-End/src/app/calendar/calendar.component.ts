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
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';
import { KeycloakService } from '../keycloak/keycloak.service';
import { FileService } from '../services/file.service';
import { CalendarEntry, CalendarAppointmentPayload, CalendarService } from './calendar.service';

@Component({
    selector: 'app-calendar',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterModule, TranslateModule, NgbModalModule, FullCalendarModule],
    templateUrl: './calendar.component.html',
    styleUrls: ['./calendar.component.css']
})
export class CalendarComponent implements OnInit, OnDestroy {

    @ViewChild('appointmentModal') appointmentModal!: TemplateRef<unknown>;
    @ViewChild('fc') fullCalendar!: FullCalendarComponent;

    private calendarService = inject(CalendarService);
    private keycloak = inject(KeycloakService);
    private translate = inject(TranslateService);
    private modal = inject(NgbModal);
    private router = inject(Router);
    private fileService = inject(FileService);
    private cdr = inject(ChangeDetectorRef);

    private thumbnailBlobUrls = new Map<string, string>();
    private thumbnailLoadsInFlight = new Set<string>();

    calendarOptions!: CalendarOptions;
    errorMessage = '';
    editingId: string | null = null;
    formTitle = '';
    formNotes = '';
    formStart = '';
    formEnd = '';

    ngOnInit(): void {
        this.calendarOptions = this.buildCalendarOptions();
        this.translate.onLangChange.subscribe(() => {
            const api = this.fullCalendar?.getApi();
            if (api) {
                api.setOption('locale', this.pickLocale());
            }
        });
    }

    ngOnDestroy(): void {
        this.revokeThumbnailBlobs();
    }

    isAuthenticated(): boolean {
        return this.keycloak.getAuth().authenticated;
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

    saveAppointment(): void {
        const start = new Date(this.formStart);
        const end = this.clampEndToSameLocalDay(start, new Date(this.formEnd));
        const payload: CalendarAppointmentPayload = {
            title: this.formTitle.trim(),
            notes: this.formNotes.trim() || null,
            startDate: start.toISOString(),
            endDate: end.toISOString()
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
                this.modal.dismissAll();
                this.fullCalendar?.getApi().refetchEvents();
            },
            error: () => {
                this.errorMessage = 'CALENDAR.SAVE_ERROR';
            }
        });
    }

    deleteEditingAppointment(): void {
        if (!this.editingId) {
            return;
        }
        this.calendarService.deleteAppointment(this.editingId).subscribe({
            next: () => {
                this.errorMessage = '';
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
                this.calendarService.getEntries(info.start, info.end).subscribe({
                    next: rows => {
                        this.revokeThumbnailBlobs();
                        this.scheduleActivityThumbnailLoads(rows);
                        successCallback(this.mapEntriesToEvents(rows));
                    },
                    error: () => {
                        this.errorMessage = 'CALENDAR.LOAD_ERROR';
                        failureCallback(new Error('calendar load'));
                    }
                });
            },
            eventClick: (arg: EventClickArg) => this.onEventClick(arg),
            select: (arg: DateSelectArg) => this.onCalendarSelect(arg)
        };
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
        const kind = arg.event.extendedProps['kind'] as string;
        if (kind === 'ACTIVITY') {
            this.router.navigate(['/photos'], { queryParams: { eventId: arg.event.id } });
        } else if (kind === 'APPOINTMENT' && this.isAuthenticated()) {
            this.editingId = arg.event.id;
            this.formTitle = arg.event.title;
            this.formNotes = (arg.event.extendedProps['notes'] as string) || '';
            this.formStart = this.toDatetimeLocal(arg.event.start!);
            this.formEnd = this.toDatetimeLocal(arg.event.end!);
            this.modal.open(this.appointmentModal, { size: 'md', windowClass: 'calendar-appointment-modal' });
        }
    }

    private onCalendarSelect(arg: DateSelectArg): void {
        if (!this.isAuthenticated()) {
            return;
        }
        this.editingId = null;
        this.formTitle = '';
        this.formNotes = '';
        const start = arg.start;
        const end = this.clampEndToSameLocalDay(start, arg.end);
        this.formStart = this.toDatetimeLocal(start);
        this.formEnd = this.toDatetimeLocal(end);
        this.modal.open(this.appointmentModal, { size: 'md', windowClass: 'calendar-appointment-modal' });
        this.fullCalendar?.getApi().unselect();
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

    private mapEntriesToEvents(entries: CalendarEntry[]): EventInput[] {
        return entries.map(e => {
            const colors =
                e.kind === 'APPOINTMENT'
                    ? this.appointmentColorsFromSchedule(e.start, e.end)
                    : this.activityColorsFromSchedule(e.start, e.end);
            return {
                id: e.id,
                title: e.title,
                start: e.start,
                end: e.end,
                allDay: false,
                extendedProps: {
                    kind: e.kind,
                    thumbnailFileId: e.thumbnailFileId ?? null,
                    notes: e.notes ?? null,
                    calBg: colors.backgroundColor,
                    calBorder: colors.borderColor
                },
                backgroundColor: colors.backgroundColor,
                borderColor: colors.borderColor,
                textColor: '#2a3138'
            };
        });
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

    private toDatetimeLocal(d: Date): string {
        const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
}
