package com.pat.controller;

import com.pat.controller.dto.PdfConverterDocumentRequest;
import com.pat.repo.CalendarAppointmentRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.PdfConverterDocumentRepository;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.PdfConverterDocument;
import com.pat.service.DiscussionService;
import jakarta.validation.Valid;
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

/**
 * Per-user rich-text PDF drafts (Quill HTML stored in MongoDB).
 * Regular users see and edit only their own documents; {@code Admin} role may access all.
 */
@RestController
@RequestMapping("/api/pdf-converter/documents")
public class PdfConverterRestController {

    @Autowired
    private PdfConverterDocumentRepository repository;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private CalendarAppointmentRepository calendarAppointmentRepository;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @Autowired
    private DiscussionService discussionService;

    @GetMapping
    public ResponseEntity<List<PdfConverterDocument>> list(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        boolean admin = hasAdminRole();
        List<PdfConverterDocument> docs = admin
                ? repository.findAllByOrderByUpdatedAtDesc()
                : repository.findByOwnerMemberIdOrderByUpdatedAtDesc(userId);
        if (admin) {
            docs.forEach(doc -> doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId())));
        }
        return ResponseEntity.ok(docs);
    }

    @GetMapping("/{id}")
    public ResponseEntity<PdfConverterDocument> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<PdfConverterDocument> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        PdfConverterDocument doc = opt.get();
        if (hasAdminRole()) {
            doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId()));
        }
        return ResponseEntity.ok(doc);
    }

    @PostMapping
    public ResponseEntity<PdfConverterDocument> create(
            @Valid @RequestBody PdfConverterDocumentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Date now = new Date();
        PdfConverterDocument doc = new PdfConverterDocument();
        doc.setOwnerMemberId(userId);
        doc.setCreatedAt(now);
        applyEditableFields(doc, body);
        Optional<ResponseEntity<PdfConverterDocument>> linkErr =
                applyValidatedLinks(doc, body.getCalendarAppointmentId(), body.getEvenementId(), userId);
        if (linkErr.isPresent()) {
            return linkErr.get();
        }
        doc.setUpdatedAt(now);
        return ResponseEntity.status(HttpStatus.CREATED).body(repository.save(doc));
    }

    @PutMapping("/{id}")
    public ResponseEntity<PdfConverterDocument> update(
            @PathVariable String id,
            @Valid @RequestBody PdfConverterDocumentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<PdfConverterDocument> opt = findEditable(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        PdfConverterDocument doc = opt.get();
        applyEditableFields(doc, body);
        Optional<ResponseEntity<PdfConverterDocument>> linkErr =
                applyValidatedLinks(doc, body.getCalendarAppointmentId(), body.getEvenementId(), userId);
        if (linkErr.isPresent()) {
            return linkErr.get();
        }
        doc.setUpdatedAt(new Date());
        return ResponseEntity.ok(repository.save(doc));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (hasAdminRole()) {
            if (!repository.existsById(id)) {
                return ResponseEntity.notFound().build();
            }
            repository.deleteById(id);
            return ResponseEntity.noContent().build();
        }
        if (repository.deleteByIdAndOwnerMemberId(id, userId) == 0) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.noContent().build();
    }

    /**
     * Readable if owner/admin, or if the document is linked to an event/appointment the member can access.
     * Mutations still use {@link #findEditable}.
     */
    private Optional<PdfConverterDocument> findAccessible(String id, String userId) {
        if (hasAdminRole()) {
            return repository.findById(id);
        }
        Optional<PdfConverterDocument> owned = repository.findByIdAndOwnerMemberId(id, userId);
        if (owned.isPresent()) {
            return owned;
        }
        Optional<PdfConverterDocument> any = repository.findById(id);
        if (any.isEmpty()) {
            return Optional.empty();
        }
        PdfConverterDocument doc = any.get();
        if (StringUtils.hasText(doc.getEvenementId())
                && discussionService.canUserAccessEventForDetail(doc.getEvenementId().trim(), userId)) {
            return any;
        }
        if (StringUtils.hasText(doc.getCalendarAppointmentId())
                && calendarAppointmentRepository.findAccessibleByIdAndMember(
                        doc.getCalendarAppointmentId().trim(), userId).isPresent()) {
            return any;
        }
        return Optional.empty();
    }

    /** Create/update/delete: owner or Admin only. */
    private Optional<PdfConverterDocument> findEditable(String id, String userId) {
        if (hasAdminRole()) {
            return repository.findById(id);
        }
        return repository.findByIdAndOwnerMemberId(id, userId);
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

    private String resolveOwnerDisplayName(String memberId) {
        if (!StringUtils.hasText(memberId)) {
            return null;
        }
        return membersRepository.findById(memberId)
                .map(this::memberDisplayName)
                .orElse(memberId);
    }

    private String memberDisplayName(Member member) {
        if (StringUtils.hasText(member.getUserName())) {
            return member.getUserName().trim();
        }
        String first = member.getFirstName() != null ? member.getFirstName().trim() : "";
        String last = member.getLastName() != null ? member.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        return StringUtils.hasText(full) ? full : member.getId();
    }

    private void applyEditableFields(PdfConverterDocument doc, PdfConverterDocumentRequest body) {
        doc.setFileName(body.getFileName().trim());
        doc.setHtmlContent(body.getHtmlContent() != null ? body.getHtmlContent() : "");
    }

    /**
     * Validates and sets {@link PdfConverterDocument#getCalendarAppointmentId()} /
     * {@link PdfConverterDocument#getEvenementId()} (mutually exclusive). Multiple documents
     * may point at the same target.
     *
     * @return empty if OK, or a non-2xx response to return from the controller
     */
    private Optional<ResponseEntity<PdfConverterDocument>> applyValidatedLinks(
            PdfConverterDocument doc, String calRaw, String evRaw, String userId) {
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
            doc.setCalendarAppointmentId(calId);
            doc.setEvenementId(null);
            return Optional.empty();
        }
        if (evId != null) {
            if (evenementsRepository.findById(evId).isEmpty()) {
                return Optional.of(ResponseEntity.badRequest().build());
            }
            if (!discussionService.canUserAccessEventForDetail(evId, userId)) {
                return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
            }
            doc.setEvenementId(evId);
            doc.setCalendarAppointmentId(null);
            return Optional.empty();
        }
        doc.setCalendarAppointmentId(null);
        doc.setEvenementId(null);
        return Optional.empty();
    }
}
