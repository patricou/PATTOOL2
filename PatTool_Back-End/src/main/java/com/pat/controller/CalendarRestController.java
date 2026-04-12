package com.pat.controller;

import com.pat.controller.dto.CalendarAppointmentRequest;
import com.pat.controller.dto.CalendarEntryDTO;
import com.pat.repo.CalendarAppointmentRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.domain.CalendarAppointment;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api/calendar")
public class CalendarRestController {

    private static final long MAX_RANGE_MS = TimeUnit.DAYS.toMillis(370);

    @Autowired
    private CalendarAppointmentRepository calendarAppointmentRepository;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @GetMapping("/entries")
    public ResponseEntity<List<CalendarEntryDTO>> entries(
            @RequestParam("from") @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Date from,
            @RequestParam("to") @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Date to,
            @RequestHeader(value = "user-id", required = false) String userId,
            Authentication authentication) {

        if (from == null || to == null || from.after(to) || (to.getTime() - from.getTime()) > MAX_RANGE_MS) {
            return ResponseEntity.badRequest().build();
        }

        boolean loggedIn = authentication != null
                && authentication.isAuthenticated()
                && !(authentication instanceof AnonymousAuthenticationToken);
        String appointmentOwnerId = loggedIn && StringUtils.hasText(userId) ? userId : null;

        /*
         * Activités : même logique d’accès que la liste / stream (EvenementsRepositoryImpl.buildAccessCriteria).
         * Sans JWT valide, ignorer tout user-id client : sinon un visiteur pourrait usurper un id et voir
         * amis / groupes / propres activités d’un autre membre.
         */
        String effectiveUserIdForEvents = loggedIn && StringUtils.hasText(userId) ? userId : null;

        List<CalendarEntryDTO> out = new ArrayList<>();

        List<Evenement> events = evenementsRepository.findAccessibleOverlappingRange(from, to, effectiveUserIdForEvents);
        for (Evenement ev : events) {
            CalendarEntryDTO row = new CalendarEntryDTO();
            row.setKind(CalendarEntryDTO.KIND_ACTIVITY);
            row.setId(ev.getId());
            row.setTitle(ev.getEvenementName());
            row.setStart(ev.getBeginEventDate());
            row.setEnd(ev.getEndEventDate());
            row.setNotes(null);
            FileUploaded thumb = ev.getThumbnail();
            if (thumb != null && StringUtils.hasText(thumb.getFieldId())) {
                row.setThumbnailFileId(thumb.getFieldId());
            }
            out.add(row);
        }

        if (StringUtils.hasText(appointmentOwnerId)) {
            List<CalendarAppointment> mine = calendarAppointmentRepository
                    .findByOwnerMemberIdAndStartDateBeforeAndEndDateAfter(appointmentOwnerId, to, from);
            for (CalendarAppointment a : mine) {
                CalendarEntryDTO row = new CalendarEntryDTO();
                row.setKind(CalendarEntryDTO.KIND_APPOINTMENT);
                row.setId(a.getId());
                row.setTitle(a.getTitle());
                row.setStart(a.getStartDate());
                row.setEnd(a.getEndDate());
                row.setNotes(a.getNotes());
                row.setThumbnailFileId(null);
                out.add(row);
            }
        }

        out.sort(Comparator.comparing(CalendarEntryDTO::getStart, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(CalendarEntryDTO::getKind));

        return ResponseEntity.ok(out);
    }

    @PostMapping("/appointments")
    public ResponseEntity<CalendarAppointment> createAppointment(
            @Valid @RequestBody CalendarAppointmentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (body.getStartDate().after(body.getEndDate())) {
            return ResponseEntity.badRequest().build();
        }
        CalendarAppointment a = new CalendarAppointment();
        a.setOwnerMemberId(userId);
        a.setTitle(body.getTitle().trim());
        a.setNotes(body.getNotes() != null ? body.getNotes().trim() : null);
        a.setStartDate(body.getStartDate());
        a.setEndDate(body.getEndDate());
        a.setCreatedAt(new Date());
        CalendarAppointment saved = calendarAppointmentRepository.save(a);
        return ResponseEntity.status(HttpStatus.CREATED).body(saved);
    }

    @PutMapping("/appointments/{id}")
    public ResponseEntity<CalendarAppointment> updateAppointment(
            @PathVariable String id,
            @Valid @RequestBody CalendarAppointmentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (body.getStartDate().after(body.getEndDate())) {
            return ResponseEntity.badRequest().build();
        }
        Optional<CalendarAppointment> existing = calendarAppointmentRepository.findByIdAndOwnerMemberId(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        CalendarAppointment a = existing.get();
        a.setTitle(body.getTitle().trim());
        a.setNotes(body.getNotes() != null ? body.getNotes().trim() : null);
        a.setStartDate(body.getStartDate());
        a.setEndDate(body.getEndDate());
        return ResponseEntity.ok(calendarAppointmentRepository.save(a));
    }

    @DeleteMapping("/appointments/{id}")
    public ResponseEntity<Void> deleteAppointment(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<CalendarAppointment> existing = calendarAppointmentRepository.findByIdAndOwnerMemberId(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        calendarAppointmentRepository.delete(existing.get());
        return ResponseEntity.noContent().build();
    }
}
