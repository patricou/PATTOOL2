package com.pat.controller;

import com.pat.controller.dto.VideoMontageExportRequest;
import com.pat.controller.dto.VideoMontageExportResponse;
import com.pat.controller.dto.VideoMontageProjectRequest;
import com.pat.repo.MembersRepository;
import com.pat.repo.VideoMontageProjectRepository;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.VideoMontageProject;
import com.pat.service.VideoMontageService;
import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;

import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Saved montage timelines and FFmpeg export. Owner is the {@code user-id} header.
 */
@RestController
@RequestMapping("/api/video-montage")
public class VideoMontageRestController {

    @Autowired
    private VideoMontageProjectRepository repository;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private VideoMontageService videoMontageService;

    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("enabled", videoMontageService.isMontageEnabled());
        body.put("ffmpegAvailable", videoMontageService.isFFmpegAvailable());
        return ResponseEntity.ok(body);
    }

    @GetMapping("/projects")
    public ResponseEntity<List<VideoMontageProject>> list(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        boolean admin = hasAdminRole();
        List<VideoMontageProject> docs = admin
                ? repository.findAllByOrderByUpdatedAtDesc()
                : repository.findByOwnerMemberIdOrderByUpdatedAtDesc(userId);
        if (admin) {
            docs.forEach(doc -> doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId())));
        }
        return ResponseEntity.ok(docs);
    }

    @GetMapping("/projects/{id}")
    public ResponseEntity<VideoMontageProject> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<VideoMontageProject> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        VideoMontageProject doc = opt.get();
        if (hasAdminRole()) {
            doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId()));
        }
        return ResponseEntity.ok(doc);
    }

    @PostMapping("/projects")
    public ResponseEntity<VideoMontageProject> create(
            @Valid @RequestBody VideoMontageProjectRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Date now = new Date();
        VideoMontageProject doc = new VideoMontageProject();
        doc.setOwnerMemberId(userId);
        doc.setCreatedAt(now);
        applyEditableFields(doc, body);
        doc.setUpdatedAt(now);
        return ResponseEntity.status(HttpStatus.CREATED).body(repository.save(doc));
    }

    @PutMapping("/projects/{id}")
    public ResponseEntity<VideoMontageProject> update(
            @PathVariable String id,
            @Valid @RequestBody VideoMontageProjectRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<VideoMontageProject> opt = findEditable(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        VideoMontageProject doc = opt.get();
        applyEditableFields(doc, body);
        doc.setUpdatedAt(new Date());
        return ResponseEntity.ok(repository.save(doc));
    }

    @DeleteMapping("/projects/{id}")
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

    @PostMapping("/export")
    public ResponseEntity<?> export(
            @Valid @RequestBody VideoMontageExportRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        String jwtSubject = currentJwtSubject();
        if (!StringUtils.hasText(jwtSubject)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        try {
            VideoMontageExportResponse result = videoMontageService.export(userId, jwtSubject, body);
            return ResponseEntity.ok(result);
        } catch (SecurityException e) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", e.getMessage()));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (IllegalStateException e) {
            String code = e.getMessage() != null ? e.getMessage() : "export_failed";
            HttpStatus status = "montage_busy".equals(code) ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.CONFLICT;
            if ("ffmpeg_unavailable".equals(code) || "montage_disabled".equals(code)) {
                status = HttpStatus.SERVICE_UNAVAILABLE;
            }
            return ResponseEntity.status(status).body(Map.of("error", code));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", "export_failed"));
        }
    }

    private void applyEditableFields(VideoMontageProject doc, VideoMontageProjectRequest body) {
        doc.setTitle(body.getTitle().trim());
        doc.setEvenementId(StringUtils.hasText(body.getEvenementId()) ? body.getEvenementId().trim() : null);
        doc.setClips(body.getClips());
        doc.setWidth(body.getWidth());
        doc.setHeight(body.getHeight());
        doc.setPhotoDefaultDurationSec(body.getPhotoDefaultDurationSec());
    }

    private Optional<VideoMontageProject> findAccessible(String id, String userId) {
        if (hasAdminRole()) {
            return repository.findById(id);
        }
        return repository.findByIdAndOwnerMemberId(id, userId);
    }

    private Optional<VideoMontageProject> findEditable(String id, String userId) {
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

    private static String currentJwtSubject() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof Jwt jwt) {
            return jwt.getSubject();
        }
        return null;
    }
}
