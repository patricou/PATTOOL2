package com.pat.controller;

import com.pat.controller.dto.PdfConverterDocumentRequest;
import com.pat.repo.MembersRepository;
import com.pat.repo.PdfConverterDocumentRepository;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.PdfConverterDocument;
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
        Optional<PdfConverterDocument> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        PdfConverterDocument doc = opt.get();
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

    private Optional<PdfConverterDocument> findAccessible(String id, String userId) {
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
}
