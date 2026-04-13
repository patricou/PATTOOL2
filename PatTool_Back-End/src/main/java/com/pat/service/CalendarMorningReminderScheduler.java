package com.pat.service;

import com.pat.controller.dto.CalendarReminderMailResult;
import com.pat.repo.CalendarAppointmentRepository;
import com.pat.repo.domain.CalendarAppointment;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Date;
import java.util.List;

/**
 * Daily trigger at 08:00 (configurable) — delegates e-mail content to
 * {@link CalendarAppointmentReminderMailService}.
 */
@Service
public class CalendarMorningReminderScheduler {

    private static final Logger log = LoggerFactory.getLogger(CalendarMorningReminderScheduler.class);

    @Autowired
    private CalendarAppointmentRepository calendarAppointmentRepository;

    @Autowired
    private CalendarAppointmentReminderMailService calendarAppointmentReminderMailService;

    @Value("${app.calendar.morning-reminder.enabled:true}")
    private boolean enabled;

    @Value("${app.calendar.morning-reminder.zone:Europe/Paris}")
    private String zoneId;

    @Scheduled(
            cron = "${app.calendar.morning-reminder.cron:0 0 8 * * ?}",
            zone = "${app.calendar.morning-reminder.zone:Europe/Paris}"
    )
    public void sendMorningReminders() {
        if (!enabled) {
            log.debug("Calendar morning reminder skipped (app.calendar.morning-reminder.enabled=false)");
            return;
        }

        ZoneId zone = CalendarAppointmentReminderMailService.parseZone(zoneId);
        ZonedDateTime startOfDay = LocalDate.now(zone).atStartOfDay(zone);
        ZonedDateTime endOfDay = startOfDay.plusDays(1).minusNanos(1);
        Date from = Date.from(startOfDay.toInstant());
        Date to = Date.from(endOfDay.toInstant());

        List<CalendarAppointment> all = calendarAppointmentRepository.findAllOverlappingRange(from, to);
        if (all.isEmpty()) {
            log.debug("Calendar morning reminder: no appointments overlapping {}", startOfDay.toLocalDate());
            return;
        }

        CalendarReminderMailResult result = calendarAppointmentReminderMailService
                .sendDigestsForAppointmentsOnCalendarDay(all, startOfDay);

        log.info("Calendar morning reminder: {} recipient(s) e-mailed, {} without e-mail, {} appointment row(s), day={} ({})",
                result.getEmailsSent(), result.getSkippedNoEmail(), all.size(), startOfDay.toLocalDate(), zone.getId());
    }
}
