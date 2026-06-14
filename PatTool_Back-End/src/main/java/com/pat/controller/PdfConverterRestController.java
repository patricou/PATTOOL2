package com.pat.controller;

import com.pat.controller.dto.PdfConverterDocumentRequest;
import com.pat.repo.PdfConverterDocumentRepository;
import com.pat.repo.domain.PdfConverterDocument;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;

import java.util.Date;
import java.util.List;
import java.util.Optional;

/**
 * Per-user rich-text PDF drafts (Quill HTML stored in MongoDB).
 */
@RestController
@RequestMapping("/api/pdf-converter/documents")
public class PdfConverterRestController {

    @Autowired
    private PdfConverterDocumentRepository repository;

    @GetMapping
    public ResponseEntity<List<PdfConverterDocument>> list(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        return ResponseEntity.ok(repository.findByOwnerMemberIdOrderByUpdatedAtDesc(userId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<PdfConverterDocument> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<PdfConverterDocument> opt = repository.findByIdAndOwnerMemberId(id, userId);
        return opt.map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
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
        Optional<PdfConverterDocument> opt = repository.findByIdAndOwnerMemberId(id, userId);
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
        if (repository.deleteByIdAndOwnerMemberId(id, userId) == 0) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.noContent().build();
    }

    private void applyEditableFields(PdfConverterDocument doc, PdfConverterDocumentRequest body) {
        doc.setFileName(body.getFileName().trim());
        doc.setHtmlContent(body.getHtmlContent() != null ? body.getHtmlContent() : "");
    }
}
