package com.pat.controller;

import com.pat.controller.dto.OdsEditorDocumentRequest;
import com.pat.repo.MembersRepository;
import com.pat.repo.OdsEditorDocumentRepository;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.OdsEditorDocument;
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
 * Per-user OpenDocument Spreadsheet (.ods) documents stored in MongoDB.
 * Regular users see and edit only their own documents; {@code Admin} role may access all.
 */
@RestController
@RequestMapping("/api/ods-editor/documents")
public class OdsEditorRestController {

    @Autowired
    private OdsEditorDocumentRepository repository;

    @Autowired
    private MembersRepository membersRepository;

    @GetMapping
    public ResponseEntity<List<OdsEditorDocument>> list(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        boolean admin = hasAdminRole();
        List<OdsEditorDocument> docs = admin
                ? repository.findAllByOrderByUpdatedAtDesc()
                : repository.findByOwnerMemberIdOrderByUpdatedAtDesc(userId);
        if (admin) {
            docs.forEach(doc -> doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId())));
        }
        docs.forEach(this::stripContentForList);
        return ResponseEntity.ok(docs);
    }

    @GetMapping("/{id}")
    public ResponseEntity<OdsEditorDocument> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<OdsEditorDocument> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        OdsEditorDocument doc = opt.get();
        if (hasAdminRole()) {
            doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId()));
        }
        return ResponseEntity.ok(doc);
    }

    @PostMapping
    public ResponseEntity<OdsEditorDocument> create(
            @Valid @RequestBody OdsEditorDocumentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Date now = new Date();
        OdsEditorDocument doc = new OdsEditorDocument();
        doc.setOwnerMemberId(userId);
        doc.setCreatedAt(now);
        applyEditableFields(doc, body);
        doc.setUpdatedAt(now);
        return ResponseEntity.status(HttpStatus.CREATED).body(repository.save(doc));
    }

    @PutMapping("/{id}")
    public ResponseEntity<OdsEditorDocument> update(
            @PathVariable String id,
            @Valid @RequestBody OdsEditorDocumentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<OdsEditorDocument> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        OdsEditorDocument doc = opt.get();
        applyEditableFields(doc, body);
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

    private Optional<OdsEditorDocument> findAccessible(String id, String userId) {
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

    private void applyEditableFields(OdsEditorDocument doc, OdsEditorDocumentRequest body) {
        doc.setFileName(body.getFileName().trim());
        doc.setOdsContentBase64(body.getOdsContentBase64());
    }

    /** List responses omit heavy Base64 payload; full content is loaded via GET /{id}. */
    private void stripContentForList(OdsEditorDocument doc) {
        doc.setOdsContentBase64(null);
    }
}
