package com.pat.controller;

import com.pat.controller.dto.CalendarVisibilityRecipientDTO;
import com.pat.controller.dto.NoteRequest;
import com.pat.repo.CalendarAppointmentRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.NoteRepository;
import com.pat.repo.domain.Note;
import com.pat.service.DiscussionService;
import com.pat.service.NoteVisibilityService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;

import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Sticky notes with TodoList-style visibility. Anyone in the visibility group may read a note;
 * only the owner (or {@code Admin}) may create / update / delete. Optional GPS is stored at creation.
 */
@RestController
@RequestMapping("/api/notes")
public class NoteRestController {

    private static final int MAX_TITLE_LENGTH = 200;
    private static final int MAX_CONTENT_LENGTH = 8_000;
    private static final int MAX_DISPLAY_NAME_LENGTH = 200;
    /** Hard cap per photo (~600 KB after base64 expansion), same as to-do list covers. */
    private static final int MAX_IMAGE_DATA_URL_LENGTH = 800_000;
    private static final int MAX_IMAGES_PER_NOTE = 5;
    private static final String DEFAULT_COLOR = "#ffe066";
    private static final Pattern HEX_COLOR = Pattern.compile("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$");

    @Autowired
    private NoteRepository noteRepository;

    @Autowired
    private NoteVisibilityService noteVisibilityService;

    @Autowired
    private CalendarAppointmentRepository calendarAppointmentRepository;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @Autowired
    private DiscussionService discussionService;

    @GetMapping
    public ResponseEntity<List<Note>> listAccessible(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        return ResponseEntity.ok(noteRepository.findAccessibleByMember(userId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Note> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<Note> opt = noteRepository.findAccessibleByIdAndMember(id, userId);
        return opt.map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<Note> create(
            @RequestBody NoteRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (body == null || !hasUsableContent(body)) {
            return ResponseEntity.badRequest().build();
        }
        if (!validImages(body.getImageDataUrls())) {
            return ResponseEntity.badRequest().build();
        }
        Note note = new Note();
        note.setOwnerMemberId(userId);
        note.setCreatedAt(new Date());
        applyEditableFields(note, body, true);
        Optional<ResponseEntity<Note>> linkErr =
                applyValidatedLinks(note, body.getCalendarAppointmentId(), body.getEvenementId(), userId);
        if (linkErr.isPresent()) {
            return linkErr.get();
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(noteRepository.save(note));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Note> update(
            @PathVariable String id,
            @RequestBody NoteRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (body == null || !hasUsableContent(body)) {
            return ResponseEntity.badRequest().build();
        }
        if (!validImages(body.getImageDataUrls())) {
            return ResponseEntity.badRequest().build();
        }
        Optional<Note> existing = findEditable(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        Note note = existing.get();
        applyEditableFields(note, body, false);
        Optional<ResponseEntity<Note>> linkErr =
                applyValidatedLinks(note, body.getCalendarAppointmentId(), body.getEvenementId(), userId);
        if (linkErr.isPresent()) {
            return linkErr.get();
        }
        return ResponseEntity.ok(noteRepository.save(note));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<Note> existing = findEditable(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        noteRepository.delete(existing.get());
        return ResponseEntity.noContent().build();
    }

    /** Members who would be able to see this note (owner + visibility recipients). */
    @GetMapping("/{id}/visibility-recipients")
    public ResponseEntity<List<CalendarVisibilityRecipientDTO>> listVisibilityRecipients(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<Note> opt = noteRepository.findAccessibleByIdAndMember(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(noteVisibilityService.listVisibilityRecipients(opt.get()));
    }

    /** Same as {@link #listVisibilityRecipients} but for an unsaved (form) note. */
    @PostMapping("/visibility-recipients-preview")
    public ResponseEntity<List<CalendarVisibilityRecipientDTO>> previewVisibilityRecipients(
            @RequestBody(required = false) NoteRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Note probe = new Note();
        probe.setOwnerMemberId(userId);
        if (body == null) {
            applySharingFields(probe, null, null, null);
        } else {
            applySharingFields(probe, body.getVisibility(), body.getFriendGroupId(), body.getFriendGroupIds());
        }
        return ResponseEntity.ok(noteVisibilityService.listVisibilityRecipients(probe));
    }

    private void applyEditableFields(Note note, NoteRequest body, boolean isCreate) {
        note.setTitle(trimTo(body.getTitle(), MAX_TITLE_LENGTH));
        note.setContent(trimTo(body.getContent(), MAX_CONTENT_LENGTH));
        note.setColor(normalizeColor(body.getColor()));
        note.setImageDataUrls(normalizeImages(body.getImageDataUrls()));
        applySharingFields(note, body.getVisibility(), body.getFriendGroupId(), body.getFriendGroupIds());
        note.setUpdatedAt(new Date());

        if (isCreate) {
            if (StringUtils.hasText(body.getOwnerDisplayName())) {
                note.setOwnerDisplayName(trimTo(body.getOwnerDisplayName(), MAX_DISPLAY_NAME_LENGTH));
            }
            if (body.getLatitude() != null && body.getLongitude() != null
                    && isValidLat(body.getLatitude()) && isValidLon(body.getLongitude())) {
                note.setLatitude(body.getLatitude());
                note.setLongitude(body.getLongitude());
                if (body.getGpsAccuracy() != null && body.getGpsAccuracy() >= 0) {
                    note.setGpsAccuracy(body.getGpsAccuracy());
                }
            }
        }
    }

    /** Create/update/delete: owner or Admin only. */
    private Optional<Note> findEditable(String id, String userId) {
        if (hasAdminRole()) {
            return noteRepository.findById(id);
        }
        return noteRepository.findByIdAndOwnerMemberId(id, userId);
    }

    private boolean hasAdminRole() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(authority -> authority.equalsIgnoreCase("ROLE_Admin")
                        || authority.equalsIgnoreCase("ROLE_admin"));
    }

    /**
     * Validates and sets {@link Note#getCalendarAppointmentId()} / {@link Note#getEvenementId()}
     * (mutually exclusive). Multiple notes may point at the same target.
     *
     * @return empty if OK, or a non-2xx response to return from the controller
     */
    private Optional<ResponseEntity<Note>> applyValidatedLinks(Note note, String calRaw, String evRaw,
            String userId) {
        String calId = StringUtils.hasText(calRaw) ? calRaw.trim() : null;
        String evId = StringUtils.hasText(evRaw) ? evRaw.trim() : null;
        if (calId != null && evId != null) {
            return Optional.of(ResponseEntity.badRequest().build());
        }
        if (calId != null) {
            if (calendarAppointmentRepository.findById(calId).isEmpty()) {
                return Optional.of(ResponseEntity.badRequest().build());
            }
            if (calendarAppointmentRepository.findAccessibleByIdAndMember(calId, userId).isEmpty()) {
                return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
            }
            note.setCalendarAppointmentId(calId);
            note.setEvenementId(null);
            return Optional.empty();
        }
        if (evId != null) {
            if (evenementsRepository.findById(evId).isEmpty()) {
                return Optional.of(ResponseEntity.badRequest().build());
            }
            if (!discussionService.canUserAccessEventForDetail(evId, userId)) {
                return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
            }
            note.setEvenementId(evId);
            note.setCalendarAppointmentId(null);
            return Optional.empty();
        }
        note.setCalendarAppointmentId(null);
        note.setEvenementId(null);
        return Optional.empty();
    }

    private void applySharingFields(Note entity, String visibilityRaw, String friendGroupIdRaw,
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

    private static boolean hasUsableContent(NoteRequest body) {
        if (StringUtils.hasText(body.getTitle()) || StringUtils.hasText(body.getContent())) {
            return true;
        }
        List<String> images = body.getImageDataUrls();
        if (images == null || images.isEmpty()) {
            return false;
        }
        return images.stream().anyMatch(StringUtils::hasText);
    }

    private static boolean validImages(List<String> images) {
        if (images == null || images.isEmpty()) {
            return true;
        }
        if (images.size() > MAX_IMAGES_PER_NOTE) {
            return false;
        }
        for (String dataUrl : images) {
            if (!StringUtils.hasText(dataUrl)) {
                continue;
            }
            if (!dataUrl.startsWith("data:image/")) {
                return false;
            }
            if (dataUrl.length() > MAX_IMAGE_DATA_URL_LENGTH) {
                return false;
            }
        }
        return true;
    }

    private static List<String> normalizeImages(List<String> images) {
        if (images == null || images.isEmpty()) {
            return null;
        }
        List<String> out = images.stream()
                .filter(StringUtils::hasText)
                .map(String::trim)
                .limit(MAX_IMAGES_PER_NOTE)
                .collect(Collectors.toList());
        return out.isEmpty() ? null : out;
    }

    private static String normalizeColor(String color) {
        if (StringUtils.hasText(color) && HEX_COLOR.matcher(color.trim()).matches()) {
            return color.trim().toLowerCase();
        }
        return DEFAULT_COLOR;
    }

    private static boolean isValidLat(double lat) {
        return lat >= -90.0 && lat <= 90.0;
    }

    private static boolean isValidLon(double lon) {
        return lon >= -180.0 && lon <= 180.0;
    }

    private static String trimTo(String value, int max) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.length() > max) {
            return trimmed.substring(0, max);
        }
        return trimmed;
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
