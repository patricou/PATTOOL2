package com.pat.controller;

import com.pat.controller.dto.CodeChatTurnDto;
import com.pat.controller.dto.CodeProjectFileDto;
import com.pat.controller.dto.CodeProjectRequest;
import com.pat.controller.dto.CodeRepoAnalyzeRequest;
import com.pat.controller.dto.CodeRepoAnalyzeResponse;
import com.pat.controller.dto.CodeRepoBrowseRequest;
import com.pat.controller.dto.CodeRepoSearchRequest;
import com.pat.repo.CodeProjectRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.domain.CodeChatTurn;
import com.pat.repo.domain.CodeProject;
import com.pat.repo.domain.CodeProjectFile;
import com.pat.repo.domain.Member;
import com.pat.service.CodeRepoNaturalSearchService;
import com.pat.service.CodeRepoWorldService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Optional;

/**
 * Per-user coding projects stored in MongoDB, plus public GitHub/GitLab file fetch for review.
 */
@RestController
@RequestMapping("/api/code-workbench")
public class CodeWorkbenchRestController {

    private static final int MAX_STORED_CHARS = 4_000_000;

    private final CodeProjectRepository repository;
    private final MembersRepository membersRepository;
    private final CodeRepoWorldService codeRepoWorldService;
    private final CodeRepoNaturalSearchService codeRepoNaturalSearchService;

    public CodeWorkbenchRestController(
            CodeProjectRepository repository,
            MembersRepository membersRepository,
            CodeRepoWorldService codeRepoWorldService,
            CodeRepoNaturalSearchService codeRepoNaturalSearchService) {
        this.repository = repository;
        this.membersRepository = membersRepository;
        this.codeRepoWorldService = codeRepoWorldService;
        this.codeRepoNaturalSearchService = codeRepoNaturalSearchService;
    }

    @GetMapping("/projects")
    public ResponseEntity<List<CodeProject>> list(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        boolean admin = hasAdminRole();
        List<CodeProject> docs = admin
                ? repository.findAllByOrderByUpdatedAtDesc()
                : repository.findByOwnerMemberIdOrderByUpdatedAtDesc(userId);
        if (admin) {
            docs.forEach(doc -> doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId())));
        }
        docs.forEach(this::stripHeavyForList);
        return ResponseEntity.ok(docs);
    }

    @GetMapping("/projects/{id}")
    public ResponseEntity<CodeProject> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<CodeProject> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        CodeProject doc = opt.get();
        if (hasAdminRole()) {
            doc.setOwnerDisplayName(resolveOwnerDisplayName(doc.getOwnerMemberId()));
        }
        return ResponseEntity.ok(doc);
    }

    @PostMapping("/projects")
    public ResponseEntity<CodeProject> create(
            @Valid @RequestBody CodeProjectRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Date now = new Date();
        CodeProject doc = new CodeProject();
        doc.setOwnerMemberId(userId);
        doc.setCreatedAt(now);
        try {
            applyEditableFields(doc, body);
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().build();
        }
        doc.setUpdatedAt(now);
        return ResponseEntity.status(HttpStatus.CREATED).body(repository.save(doc));
    }

    @PutMapping("/projects/{id}")
    public ResponseEntity<CodeProject> update(
            @PathVariable String id,
            @Valid @RequestBody CodeProjectRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<CodeProject> opt = findAccessible(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        CodeProject doc = opt.get();
        try {
            applyEditableFields(doc, body);
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().build();
        }
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

    @PostMapping("/repo/analyze")
    public ResponseEntity<?> analyzeRepo(@Valid @RequestBody CodeRepoAnalyzeRequest body) {
        try {
            CodeRepoAnalyzeResponse res = codeRepoWorldService.analyze(body.getUrl(), body.getBranch());
            return ResponseEntity.ok(res);
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(errorBody(ex.getMessage()));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(errorBody(ex.getMessage()));
        }
    }

    @PostMapping("/repo/search")
    public ResponseEntity<?> searchRepos(@Valid @RequestBody CodeRepoSearchRequest body) {
        try {
            if (Boolean.TRUE.equals(body.getNaturalLanguage())) {
                return ResponseEntity.ok(codeRepoNaturalSearchService.search(
                        body.getQuery(),
                        body.getHost(),
                        body.getPage(),
                        body.getProvider(),
                        body.getModel()));
            }
            return ResponseEntity.ok(codeRepoWorldService.search(body.getQuery(), body.getHost(), body.getPage()));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(errorBody(ex.getMessage()));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(errorBody(ex.getMessage()));
        }
    }

    @PostMapping("/repo/tree")
    public ResponseEntity<?> repoTree(@Valid @RequestBody CodeRepoBrowseRequest body) {
        try {
            return ResponseEntity.ok(codeRepoWorldService.listTree(body.getUrl(), body.getBranch(), body.getPath()));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(errorBody(ex.getMessage()));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(errorBody(ex.getMessage()));
        }
    }

    @PostMapping("/repo/tree-index")
    public ResponseEntity<?> repoTreeIndex(@Valid @RequestBody CodeRepoBrowseRequest body) {
        try {
            return ResponseEntity.ok(codeRepoWorldService.treeIndex(body.getUrl(), body.getBranch()));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(errorBody(ex.getMessage()));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(errorBody(ex.getMessage()));
        }
    }

    @PostMapping("/repo/file")
    public ResponseEntity<?> repoFile(@Valid @RequestBody CodeRepoBrowseRequest body) {
        try {
            return ResponseEntity.ok(codeRepoWorldService.readFile(body.getUrl(), body.getBranch(), body.getPath()));
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(errorBody(ex.getMessage()));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(errorBody(ex.getMessage()));
        }
    }

    private Optional<CodeProject> findAccessible(String id, String userId) {
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

    private void applyEditableFields(CodeProject doc, CodeProjectRequest body) {
        doc.setName(body.getName().trim());
        doc.setDescription(trimToNull(body.getDescription()));
        doc.setLanguage(trimToNull(body.getLanguage()));
        doc.setRepoUrl(trimToNull(body.getRepoUrl()));
        doc.setProvider(trimToNull(body.getProvider()));
        doc.setModel(trimToNull(body.getModel()));
        List<CodeProjectFile> files = new ArrayList<>();
        int chars = 0;
        if (body.getFiles() != null) {
            for (CodeProjectFileDto f : body.getFiles()) {
                if (f == null || !StringUtils.hasText(f.getPath())) {
                    continue;
                }
                CodeProjectFile file = new CodeProjectFile();
                file.setPath(f.getPath().trim());
                String content = f.getContent() != null ? f.getContent() : "";
                chars += content.length();
                if (chars > MAX_STORED_CHARS) {
                    throw new IllegalArgumentException("Project is too large to persist");
                }
                file.setContent(content);
                file.setLanguage(trimToNull(f.getLanguage()));
                files.add(file);
            }
        }
        doc.setFiles(files);
        List<CodeChatTurn> turns = new ArrayList<>();
        if (body.getChatTurns() != null) {
            List<CodeChatTurnDto> src = body.getChatTurns();
            int from = Math.max(0, src.size() - 60);
            for (int i = from; i < src.size(); i++) {
                CodeChatTurnDto t = src.get(i);
                if (t == null || !StringUtils.hasText(t.getRole()) || !StringUtils.hasText(t.getContent())) {
                    continue;
                }
                String role = t.getRole().trim().toLowerCase();
                if (!"user".equals(role) && !"assistant".equals(role)) {
                    continue;
                }
                CodeChatTurn turn = new CodeChatTurn();
                turn.setRole(role);
                turn.setContent(t.getContent());
                turns.add(turn);
            }
        }
        doc.setChatTurns(turns);
    }

    private void stripHeavyForList(CodeProject doc) {
        if (doc.getFiles() != null) {
            for (CodeProjectFile f : doc.getFiles()) {
                f.setContent(null);
            }
        }
        doc.setChatTurns(new ArrayList<>());
    }

    private static String trimToNull(String v) {
        if (!StringUtils.hasText(v)) {
            return null;
        }
        String t = v.trim();
        return t.isEmpty() ? null : t;
    }

    private static java.util.Map<String, String> errorBody(String message) {
        return java.util.Map.of("error", message != null ? message : "error");
    }
}
