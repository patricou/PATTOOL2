package com.pat.controller;

import com.pat.controller.dto.CalendarAppointmentRequest;
import com.pat.controller.dto.CalendarEntryDTO;
import com.pat.controller.dto.CalendarReminderMailResult;
import com.pat.controller.dto.CalendarVisibilityPreviewRequest;
import com.pat.controller.dto.CalendarVisibilityRecipientDTO;
import com.pat.repo.CalendarAppointmentRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.domain.CalendarAppointment;
import com.pat.repo.domain.Evenement;
import com.pat.repo.domain.FileUploaded;
import com.pat.service.CalendarAppointmentReminderMailService;
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
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/calendar")
public class CalendarRestController {

    private static final long MAX_RANGE_MS = TimeUnit.DAYS.toMillis(370);

    @Autowired
    private CalendarAppointmentRepository calendarAppointmentRepository;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @Autowired
    private CalendarAppointmentReminderMailService calendarAppointmentReminderMailService;

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
            row.setNotes(StringUtils.hasText(ev.getComments()) ? ev.getComments().trim() : null);
            FileUploaded thumb = ev.getThumbnail();
            if (thumb != null && StringUtils.hasText(thumb.getFieldId())) {
                row.setThumbnailFileId(thumb.getFieldId());
            }
            out.add(row);
        }

        String appointmentAccessUserId = null;
        if (loggedIn && StringUtils.hasText(userId)) {
            appointmentAccessUserId = userId;
        } else if (!loggedIn) {
            appointmentAccessUserId = null;
        }
        if (appointmentAccessUserId != null || !loggedIn) {
            List<CalendarAppointment> appointments = calendarAppointmentRepository
                    .findAccessibleOverlappingRange(from, to, appointmentAccessUserId);
            for (CalendarAppointment a : appointments) {
                CalendarEntryDTO row = new CalendarEntryDTO();
                row.setKind(CalendarEntryDTO.KIND_APPOINTMENT);
                row.setId(a.getId());
                row.setTitle(a.getTitle());
                row.setStart(a.getStartDate());
                row.setEnd(a.getEndDate());
                row.setNotes(a.getNotes());
                row.setThumbnailFileId(null);
                row.setOwnerMemberId(a.getOwnerMemberId());
                row.setVisibility(a.getVisibility());
                row.setFriendGroupId(a.getFriendGroupId());
                row.setFriendGroupIds(a.getFriendGroupIds());
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
        applyAppointmentSharing(a, body);
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
        applyAppointmentSharing(a, body);
        return ResponseEntity.ok(calendarAppointmentRepository.save(a));
    }

    /**
     * Sends the same reminder e-mails as the morning job (owner + visibility recipients) for this
     * appointment. Only the owner may trigger it.
     */
    @PostMapping("/appointments/{id}/reminder-mail")
    public ResponseEntity<CalendarReminderMailResult> sendAppointmentReminderMail(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<CalendarAppointment> existing = calendarAppointmentRepository.findByIdAndOwnerMemberId(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        CalendarAppointment fresh = calendarAppointmentRepository.findById(id).orElse(existing.get());
        CalendarReminderMailResult result = calendarAppointmentReminderMailService.sendReminderForAppointment(fresh);
        return ResponseEntity.ok(result);
    }

    /**
     * Who can see this saved appointment (owner + visibility). Owner or any member who may see the appointment
     * (same access as calendar entries) may query.
     */
    @GetMapping("/appointments/{id}/visibility-recipients")
    public ResponseEntity<List<CalendarVisibilityRecipientDTO>> listVisibilityRecipients(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<CalendarAppointment> loaded = calendarAppointmentRepository.findById(id);
        if (loaded.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        boolean owner = calendarAppointmentRepository.findByIdAndOwnerMemberId(id, userId).isPresent();
        if (!owner) {
            if (calendarAppointmentRepository.findAccessibleByIdAndMember(id, userId).isEmpty()) {
                return ResponseEntity.notFound().build();
            }
        }
        return ResponseEntity.ok(calendarAppointmentReminderMailService.listVisibilityRecipients(loaded.get()));
    }

    /**
     * Same as {@link #listVisibilityRecipients} for a new appointment (form not saved yet).
     */
    @PostMapping("/appointments/visibility-recipients-preview")
    public ResponseEntity<List<CalendarVisibilityRecipientDTO>> previewVisibilityRecipients(
            @RequestBody(required = false) CalendarVisibilityPreviewRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        CalendarAppointment probe = new CalendarAppointment();
        probe.setOwnerMemberId(userId);
        if (body == null) {
            applySharingFields(probe, null, null, null);
        } else {
            applySharingFields(probe, body.getVisibility(), body.getFriendGroupId(), body.getFriendGroupIds());
        }
        return ResponseEntity.ok(calendarAppointmentReminderMailService.listVisibilityRecipients(probe));
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

    private void applyAppointmentSharing(CalendarAppointment entity, CalendarAppointmentRequest body) {
        applySharingFields(entity, body.getVisibility(), body.getFriendGroupId(), body.getFriendGroupIds());
    }

    private void applySharingFields(CalendarAppointment entity, String visibilityRaw, String friendGroupIdRaw,
            List<String> friendGroupIdsRaw) {
        if (!StringUtils.hasText(visibilityRaw)) {
            entity.setVisibility("private");
        } else {
            entity.setVisibility(visibilityRaw.trim());
        }
        String v = entity.getVisibility();
        if ("public".equals(v) || "private".equals(v) || "friends".equals(v)) {
            entity.setFriendGroupId(null);
            entity.setFriendGroupIds(null);
            return;
        }
        if ("friendGroups".equals(v)) {
            List<String> ids = normalizeIdList(friendGroupIdsRaw);
            if (!ids.isEmpty()) {
                entity.setFriendGroupIds(ids);
                entity.setFriendGroupId(ids.get(0));
            } else if (StringUtils.hasText(friendGroupIdRaw)) {
                String one = friendGroupIdRaw.trim();
                entity.setFriendGroupId(one);
                entity.setFriendGroupIds(List.of(one));
            } else {
                entity.setVisibility("private");
                entity.setFriendGroupId(null);
                entity.setFriendGroupIds(null);
            }
            return;
        }
        if (StringUtils.hasText(friendGroupIdRaw)) {
            entity.setFriendGroupId(friendGroupIdRaw.trim());
        } else {
            entity.setFriendGroupId(null);
        }
        entity.setFriendGroupIds(null);
    }

    private static List<String> normalizeIdList(List<String> ids) {
        if (ids == null) {
            return List.of();
        }
        return ids.stream()
                .filter(StringUtils::hasText)
                .map(String::trim)
                .distinct()
                .collect(Collectors.toList());
    }
}
