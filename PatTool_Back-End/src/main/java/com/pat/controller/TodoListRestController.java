package com.pat.controller;

import com.pat.controller.dto.CalendarVisibilityRecipientDTO;
import com.pat.controller.dto.TodoListAssignmentRequest;
import com.pat.controller.dto.TodoListRequest;
import com.pat.repo.CalendarAppointmentRepository;
import com.pat.repo.EvenementsRepository;
import com.pat.repo.MembersRepository;
import com.pat.repo.TodoListRepository;
import com.pat.repo.domain.Member;
import com.pat.repo.domain.TodoItem;
import com.pat.repo.domain.TodoList;
import com.pat.service.DiscussionService;
import com.pat.service.TodoListVisibilityService;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.*;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Shareable to-do lists. Lists are created and edited by their owner; visibility (private,
 * friends, friend groups, public) controls who else may read them. Each list contains
 * embedded {@link TodoItem}s with their own status, due date and assignee.
 */
@RestController
@RequestMapping("/api/todolists")
public class TodoListRestController {

    /** Hard cap on the inline cover image. ~600 KB after base64 expansion. */
    private static final int MAX_IMAGE_DATA_URL_LENGTH = 800_000;

    private static final Logger log = LoggerFactory.getLogger(TodoListRestController.class);

    @Autowired
    private TodoListRepository todoListRepository;

    @Autowired
    private TodoListVisibilityService todoListVisibilityService;

    @Autowired
    private MailController mailController;

    @Autowired
    private MembersRepository membersRepository;

    @Autowired
    private CalendarAppointmentRepository calendarAppointmentRepository;

    @Autowired
    private EvenementsRepository evenementsRepository;

    @Autowired
    private DiscussionService discussionService;

    @GetMapping
    public ResponseEntity<List<TodoList>> listAccessible(
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        return ResponseEntity.ok(todoListRepository.findAccessibleByMember(userId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<TodoList> getOne(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<TodoList> opt = todoListRepository.findAccessibleByIdAndMember(id, userId);
        return opt.map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<TodoList> create(
            @Valid @RequestBody TodoListRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (!validImage(body.getImageDataUrl())) {
            return ResponseEntity.badRequest().build();
        }
        TodoList list = new TodoList();
        list.setOwnerMemberId(userId);
        list.setCreatedAt(new Date());
        applyEditableFields(list, body);
        Optional<ResponseEntity<TodoList>> linkErr = applyLinkFieldsIfNeeded(list, body, userId);
        if (linkErr.isPresent()) {
            return linkErr.get();
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(todoListRepository.save(list));
    }

    @PutMapping("/{id}")
    public ResponseEntity<TodoList> update(
            @PathVariable String id,
            @Valid @RequestBody TodoListRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (!validImage(body.getImageDataUrl())) {
            return ResponseEntity.badRequest().build();
        }
        Optional<TodoList> existing = todoListRepository.findByIdAndOwnerMemberId(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        TodoList list = existing.get();
        applyEditableFields(list, body);
        Optional<ResponseEntity<TodoList>> linkErr = applyLinkFieldsIfNeeded(list, body, userId);
        if (linkErr.isPresent()) {
            return linkErr.get();
        }
        return ResponseEntity.ok(todoListRepository.save(list));
    }

    /**
     * Link this list (owner only) to a calendar appointment or an activity, or clear both.
     * Any previous list attached to the same appointment or event is unlinked automatically.
     */
    @PatchMapping("/{id}/assignment")
    public ResponseEntity<TodoList> patchAssignment(
            @PathVariable String id,
            @RequestBody TodoListAssignmentRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<TodoList> existing = todoListRepository.findByIdAndOwnerMemberId(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        TodoList list = existing.get();
        Optional<ResponseEntity<TodoList>> err = applyValidatedLinks(list, body.getCalendarAppointmentId(),
                body.getEvenementId(), userId);
        if (err.isPresent()) {
            return err.get();
        }
        list.setUpdatedAt(new Date());
        return ResponseEntity.ok(todoListRepository.save(list));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<TodoList> existing = todoListRepository.findByIdAndOwnerMemberId(id, userId);
        if (existing.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        todoListRepository.delete(existing.get());
        return ResponseEntity.noContent().build();
    }

    /**
     * Toggle a single embedded item's status. Anyone in the visibility group may flip an
     * item state (typical use case: my friend ticks off her own task).
     */
    @PatchMapping("/{id}/items/{itemId}/status")
    public ResponseEntity<TodoList> updateItemStatus(
            @PathVariable String id,
            @PathVariable String itemId,
            @RequestParam("status") String status,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (!StringUtils.hasText(status)) {
            return ResponseEntity.badRequest().build();
        }
        Optional<TodoList> opt = todoListRepository.findAccessibleByIdAndMember(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        TodoList list = opt.get();
        TodoItem target = null;
        if (list.getItems() != null) {
            for (TodoItem it : list.getItems()) {
                if (itemId.equals(it.getId())) {
                    target = it;
                    break;
                }
            }
        }
        if (target == null) {
            return ResponseEntity.notFound().build();
        }
        target.setStatus(status.trim());
        if (TodoList.STATUS_DONE.equals(target.getStatus())) {
            target.setCompletedAt(new Date());
        } else {
            target.setCompletedAt(null);
        }
        list.setUpdatedAt(new Date());
        return ResponseEntity.ok(todoListRepository.save(list));
    }

    /** Members who would be able to see this list (owner + visibility recipients). */
    @GetMapping("/{id}/visibility-recipients")
    public ResponseEntity<List<CalendarVisibilityRecipientDTO>> listVisibilityRecipients(
            @PathVariable String id,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<TodoList> opt = todoListRepository.findAccessibleByIdAndMember(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(todoListVisibilityService.listVisibilityRecipients(opt.get()));
    }

    /** Same as {@link #listVisibilityRecipients} but for an unsaved (form) list. */
    @PostMapping("/visibility-recipients-preview")
    public ResponseEntity<List<CalendarVisibilityRecipientDTO>> previewVisibilityRecipients(
            @RequestBody(required = false) TodoListRequest body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        TodoList probe = new TodoList();
        probe.setOwnerMemberId(userId);
        if (body == null) {
            applySharingFields(probe, null, null, null);
        } else {
            applySharingFields(probe, body.getVisibility(), body.getFriendGroupId(), body.getFriendGroupIds());
        }
        return ResponseEntity.ok(todoListVisibilityService.listVisibilityRecipients(probe));
    }

    /**
     * Share a to-do list by e-mail. Body fields:
     * <ul>
     *     <li>{@code toEmails}: required, list of recipients</li>
     *     <li>{@code customMessage}: optional free-text added to the e-mail body</li>
     *     <li>{@code mailLang}: optional UI language for fixed phrases in the mail body ({@code fr} or
     *     {@code en}; any other value falls back to English)</li>
     *     <li>{@code senderName}: optional display name shown in the footer</li>
     *     <li>{@code listUrl}: optional deep link back to the front-end view</li>
     * </ul>
     * Anyone with read access to the list may share it.
     */
    @PostMapping(value = "/{id}/share-email")
    public ResponseEntity<Map<String, Object>> shareByEmail(
            @PathVariable String id,
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = "user-id", required = false) String userId) {
        if (!StringUtils.hasText(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        Optional<TodoList> opt = todoListRepository.findAccessibleByIdAndMember(id, userId);
        if (opt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        TodoList list = opt.get();
        // MongoDB may deserialize a missing "items" field as null; normalise so the mail template
        // always runs the task block.
        if (list.getItems() == null) {
            list.setItems(new ArrayList<>());
        }

        @SuppressWarnings("unchecked")
        List<String> toEmails = (List<String>) body.get("toEmails");
        @SuppressWarnings("unchecked")
        List<String> toMemberIds = (List<String>) body.get("toMemberIds");
        // Resolve emails from member ids: caller never has to know the underlying address.
        List<String> resolved = new ArrayList<>();
        if (toEmails != null) {
            resolved.addAll(toEmails);
        }
        if (toMemberIds != null) {
            for (String mid : toMemberIds) {
                if (!StringUtils.hasText(mid)) continue;
                membersRepository.findById(mid).ifPresent(member -> {
                    if (StringUtils.hasText(member.getAddressEmail())) {
                        resolved.add(member.getAddressEmail());
                    }
                });
            }
        }
        if (resolved.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "toEmails or toMemberIds is required"));
        }
        toEmails = resolved;
        String customMessage = body.get("customMessage") != null ? body.get("customMessage").toString() : "";
        String senderName = body.get("senderName") != null ? body.get("senderName").toString().trim() : null;
        if (senderName == null || senderName.isEmpty()) {
            senderName = resolveSenderName(userId);
        }
        String mailLang = body.get("mailLang") != null ? body.get("mailLang").toString().trim() : "fr";
        if (mailLang.isEmpty()) {
            mailLang = "fr";
        }
        String listUrl = body.get("listUrl") != null ? body.get("listUrl").toString().trim() : null;
        if (listUrl != null && listUrl.isEmpty()) {
            listUrl = null;
        }

        DecodedImage cover = decodeDataUrl(list.getImageDataUrl());
        boolean hasInlineImage = cover != null;

        String ownerLabel = membersRepository.findById(list.getOwnerMemberId())
                .map(this::organizerLabel)
                .orElse(list.getOwnerMemberId());
        String htmlBody = generateShareTodoEmailHtml(mailLang, list, customMessage, ownerLabel,
                hasInlineImage, listUrl, senderName);
        String plainText = buildShareTodoPlainText(mailLang, list, customMessage, ownerLabel, senderName, listUrl);
        String subject = "PatTool – " + (StringUtils.hasText(list.getName()) ? list.getName() : "To-do list");
        String bcc = mailController.getMailSentTo();

        int sent = 0;
        int skipped = 0;
        for (String email : toEmails) {
            String trimmed = email != null ? email.trim() : "";
            if (trimmed.isEmpty() || !mailController.isValidEmail(trimmed)) {
                skipped++;
                continue;
            }
            try {
                if (hasInlineImage && cover != null) {
                    ByteArrayResource resource = new ByteArrayResource(cover.bytes);
                    mailController.sendMailToRecipientWithInline(trimmed, subject, htmlBody, plainText,
                            "todoListImage", resource, cover.contentType, bcc);
                } else {
                    mailController.sendMailToRecipientPlainAndHtml(trimmed, subject, plainText, htmlBody, bcc);
                }
                sent++;
            } catch (Exception e) {
                log.error("Failed to send to-do list share to {}: {}", trimmed, e.getMessage(), e);
                skipped++;
            }
        }
        return ResponseEntity.ok(Map.of("sent", sent, "skipped", skipped, "total", toEmails.size()));
    }

    private String resolveSenderName(String userId) {
        return membersRepository.findById(userId).map(this::organizerLabel).orElse("PatTool");
    }

    private String organizerLabel(Member m) {
        if (m == null) {
            return "";
        }
        String first = StringUtils.hasText(m.getFirstName()) ? m.getFirstName().trim() : "";
        String last = StringUtils.hasText(m.getLastName()) ? m.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        if (StringUtils.hasText(full)) {
            return full;
        }
        if (StringUtils.hasText(m.getUserName())) {
            return m.getUserName().trim();
        }
        return m.getId();
    }

    /** Holds bytes + MIME type extracted from a {@code data:image/...;base64,...} URL. */
    private static final class DecodedImage {
        final byte[] bytes;
        final String contentType;
        DecodedImage(byte[] bytes, String contentType) {
            this.bytes = bytes;
            this.contentType = contentType;
        }
    }

    private DecodedImage decodeDataUrl(String dataUrl) {
        if (!StringUtils.hasText(dataUrl) || !dataUrl.startsWith("data:")) {
            return null;
        }
        int comma = dataUrl.indexOf(',');
        if (comma <= 0) {
            return null;
        }
        String header = dataUrl.substring(5, comma);
        String payload = dataUrl.substring(comma + 1);
        if (!header.contains(";base64")) {
            return null;
        }
        String contentType = header.substring(0, header.indexOf(';'));
        if (!StringUtils.hasText(contentType)) {
            contentType = "image/jpeg";
        }
        try {
            byte[] bytes = Base64.getDecoder().decode(payload);
            return new DecodedImage(bytes, contentType);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private String generateShareTodoEmailHtml(String mailLang, TodoList list, String customMessage,
            String ownerLabel, boolean hasInlineImage, String listUrl, String senderName) {
        Map<String, String> t = todoEmailMessages(mailLang);
        SimpleDateFormat sdfDate = new SimpleDateFormat("dd/MM/yyyy");
        StringBuilder sb = new StringBuilder();
        sb.append("<!DOCTYPE html><html><head><meta charset='utf-8'><style>")
          .append("body{font-family:Helvetica,Arial,sans-serif;margin:0;background:#f4f6fb;color:#2c3e50;}")
          .append(".wrap{max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(40,60,90,0.08);}")
          .append(".header{padding:18px 22px;background:linear-gradient(135deg,#4a90e2 0%,#7d54f2 100%);color:#fff;}")
          .append(".header h1{margin:0 0 2px 0;font-size:20px;font-weight:600;}")
          .append(".header-list-desc{margin:0;padding:0;font-size:15px;font-weight:400;line-height:1.45;color:rgba(255,255,255,0.96);}")
          .append(".header-list-desc p{margin:2px 0 0 0;}")
          .append(".header-list-desc, .header-list-desc p, .header-list-desc span, .header-list-desc li{color:rgba(255,255,255,0.96) !important;}")
          .append(".cover img{width:100%;display:block;max-height:320px;object-fit:cover;}")
          .append(".content{padding:18px 22px;}")
          .append(".info{margin:6px 0;font-size:14px;}")
          .append(".info b{color:#495057;}")
          .append(".desc{margin:14px 0;color:#495057;font-size:14px;white-space:pre-wrap;}")
          .append(".custom{margin:14px 0;padding:12px 14px;border-left:3px solid #7d54f2;background:#f3effe;color:#34325c;border-radius:6px;}")
          .append("table.task-table{width:100%;border-collapse:collapse;margin:14px 0;}")
          .append("table.task-table td{font-size:14px;padding:8px 6px;border-bottom:1px solid #eef1f6;vertical-align:top;}")
          .append("table.task-table tr.done td{color:#6c757d;text-decoration:line-through;}")
          .append("table.task-table td strong{font-weight:700;}")
          .append("table.task-table td strong u{text-decoration:underline;}")
          .append(".cta{margin:18px 0;text-align:center;}")
          .append(".cta a{display:inline-block;padding:10px 22px;background:#4a90e2;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;}")
          .append(".footer{padding:12px 22px;background:#f8fafd;color:#6c757d;font-size:12px;text-align:center;}")
          .append(".badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;background:#e0eaff;color:#2a5fb5;margin-left:6px;}")
          .append(".progress{height:10px;background:#eef1f6;border-radius:999px;overflow:hidden;margin:8px 0 14px;}")
          .append(".progress > span{display:block;height:100%;background:linear-gradient(90deg,#4a90e2,#7d54f2);}")
          .append("table.task-table td.item-desc{padding:4px 6px 10px 28px;color:#6c757d;font-size:12px;border-bottom:1px solid #eef1f6;}")
          .append("</style></head><body><div class='wrap'>");

        sb.append("<div class='header'><h1>")
          .append(escapeHtml(StringUtils.hasText(list.getName()) ? list.getName() : t.get("LIST_FALLBACK")))
          .append("</h1>");
        if (StringUtils.hasText(list.getDescription())) {
            sb.append("<div class='header-list-desc'>").append(list.getDescription()).append("</div>");
        }
        sb.append("</div>");

        if (hasInlineImage) {
            sb.append("<div class='cover'><img src='cid:todoListImage' alt=''></div>");
        }

        sb.append("<div class='content'>");

        if (StringUtils.hasText(customMessage)) {
            sb.append("<div class='custom'>")
              .append(escapeHtml(customMessage).replace("\n", "<br>"))
              .append("</div>");
        }

        sb.append("<div class='info'><b>").append(escapeHtml(t.get("OWNER")))
          .append(":</b> ").append(escapeHtml(ownerLabel)).append("</div>");

        if (list.getCreatedAt() != null) {
            sb.append("<div class='info'><b>").append(escapeHtml(t.get("CREATED_AT")))
              .append(":</b> ").append(sdfDate.format(list.getCreatedAt())).append("</div>");
        }
        if (list.getDueDate() != null) {
            sb.append("<div class='info'><b>").append(escapeHtml(t.get("DUE_DATE")))
              .append(":</b> ").append(sdfDate.format(list.getDueDate())).append("</div>");
        }
        if (StringUtils.hasText(list.getStatus())) {
            sb.append("<div class='info'><b>").append(escapeHtml(t.get("STATUS")))
              .append(":</b> ").append(escapeHtml(statusLabel(list.getStatus(), t))).append("</div>");
        }

        List<TodoItem> items = list.getItems();
        if (items != null && !items.isEmpty()) {
            int done = 0;
            for (TodoItem it : items) {
                if (TodoList.STATUS_DONE.equals(it.getStatus())) {
                    done++;
                }
            }
            int percent = items.isEmpty() ? 0 : (int) Math.round((done * 100.0) / items.size());
            sb.append("<div class='info'><b><u>").append(escapeHtml(t.get("TASKS")))
              .append("</u></b>: ").append(done).append(" / ").append(items.size())
              .append(" (").append(percent).append("%)</div>");
            sb.append("<div class='progress'><span style='width:").append(percent).append("%'></span></div>");
            // Use a table instead of <ul>: many webmail clients strip or collapse list markup next to
            // rich HTML descriptions; tables are the usual HTML-email pattern for reliable rendering.
            sb.append("<table class='task-table' role='presentation' width='100%' cellpadding='0' cellspacing='0'>");
            for (TodoItem it : items) {
                boolean isDone = TodoList.STATUS_DONE.equals(it.getStatus());
                sb.append("<tr").append(isDone ? " class='done'" : "").append("><td>");
                sb.append(isDone ? "&#9745;&nbsp;" : "&#9744;&nbsp;");
                sb.append("<strong><u>")
                  .append(escapeHtml(StringUtils.hasText(it.getTitle()) ? it.getTitle() : "—"))
                  .append("</u></strong>");
                if (it.getDueDate() != null) {
                    sb.append(" <span class='badge'>").append(sdfDate.format(it.getDueDate())).append("</span>");
                }
                if (StringUtils.hasText(it.getPriority()) && !"normal".equals(it.getPriority())) {
                    sb.append(" <span class='badge'>").append(escapeHtml(it.getPriority())).append("</span>");
                }
                if (StringUtils.hasText(it.getAssigneeMemberId())) {
                    String assignee = membersRepository.findById(it.getAssigneeMemberId())
                            .map(this::organizerLabel)
                            .orElse(null);
                    if (StringUtils.hasText(assignee)) {
                        sb.append(" <span class='badge'>@").append(escapeHtml(assignee)).append("</span>");
                    }
                }
                sb.append("</td></tr>");
                if (StringUtils.hasText(it.getDescription())) {
                    sb.append("<tr").append(isDone ? " class='done'" : "").append("><td class='item-desc'>")
                      .append(it.getDescription())
                      .append("</td></tr>");
                }
            }
            sb.append("</table>");
        } else {
            sb.append("<div class='info'><b><u>").append(escapeHtml(t.get("TASKS")))
              .append("</u></b>: <span style='color:#6c757d'>").append(escapeHtml(t.get("NO_TASKS")))
              .append("</span></div>");
        }

        if (StringUtils.hasText(listUrl)) {
            sb.append("<div class='cta'><a href='").append(escapeHtml(listUrl)).append("'>")
              .append(escapeHtml(t.get("VIEW_LIST"))).append("</a></div>");
        }

        sb.append("</div>");

        if (StringUtils.hasText(senderName)) {
            sb.append("<div class='footer'>")
              .append(escapeHtml(String.format(t.get("SENT_BY"), senderName)))
              .append("</div>");
        } else {
            sb.append("<div class='footer'>").append(escapeHtml(t.get("SENT_VIA"))).append("</div>");
        }

        sb.append("</div></body></html>");
        return sb.toString();
    }

    private String statusLabel(String status, Map<String, String> t) {
        if (status == null) return "";
        switch (status) {
            case TodoList.STATUS_OPEN: return t.get("STATUS_OPEN");
            case TodoList.STATUS_IN_PROGRESS: return t.get("STATUS_IN_PROGRESS");
            case TodoList.STATUS_DONE: return t.get("STATUS_DONE");
            case TodoList.STATUS_ARCHIVED: return t.get("STATUS_ARCHIVED");
            default: return status;
        }
    }

    private String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    /** Combining low line (U+0332) after each character for a plain-text “underline” in mail/WhatsApp-like clients. */
    private String underlinePlain(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        StringBuilder b = new StringBuilder(s.length() * 2);
        for (int i = 0; i < s.length(); i++) {
            b.append(s.charAt(i)).append('\u0332');
        }
        return b.toString();
    }

    private String htmlToPlainText(String html) {
        if (html == null) return "";
        return html.replaceAll("(?i)<br\\s*/?>", "\n")
                .replaceAll("(?i)</p>", "\n\n")
                .replaceAll("(?i)</li>", "\n")
                .replaceAll("(?i)</?[a-z][^>]*>", "")
                .replaceAll("&nbsp;", " ")
                .replaceAll("&amp;", "&")
                .replaceAll("&lt;", "<")
                .replaceAll("&gt;", ">")
                .replaceAll("&quot;", "\"")
                .replaceAll("&#39;", "'")
                .replaceAll("\n{3,}", "\n\n")
                .trim();
    }

    /**
     * Plain-text body for the share e-mail so clients that do not render HTML still show
     * every task line by line (the HTML-to-text conversion of the rich template was easy to lose).
     */
    private String buildShareTodoPlainText(String mailLang, TodoList list, String customMessage,
            String ownerLabel, String senderName, String listUrl) {
        Map<String, String> t = todoEmailMessages(mailLang);
        SimpleDateFormat sdfDate = new SimpleDateFormat("dd/MM/yyyy");
        StringBuilder sb = new StringBuilder();
        if (StringUtils.hasText(customMessage)) {
            sb.append(customMessage.trim()).append("\n\n");
        }
        sb.append(StringUtils.hasText(list.getName()) ? list.getName() : t.get("LIST_FALLBACK"));
        if (StringUtils.hasText(list.getDescription())) {
            sb.append("\n").append(htmlToPlainText(list.getDescription()));
        }
        sb.append("\n---\n");
        sb.append(t.get("OWNER")).append(": ").append(ownerLabel).append("\n");
        if (list.getCreatedAt() != null) {
            sb.append(t.get("CREATED_AT")).append(": ").append(sdfDate.format(list.getCreatedAt())).append("\n");
        }
        if (list.getDueDate() != null) {
            sb.append(t.get("DUE_DATE")).append(": ").append(sdfDate.format(list.getDueDate())).append("\n");
        }
        if (StringUtils.hasText(list.getStatus())) {
            sb.append(t.get("STATUS")).append(": ").append(statusLabel(list.getStatus(), t)).append("\n");
        }
        List<TodoItem> items = list.getItems();
        sb.append("\n").append(underlinePlain(t.get("TASKS"))).append("\n");
        if (items == null || items.isEmpty()) {
            sb.append("  ").append(t.get("NO_TASKS")).append("\n");
        } else {
            int n = 1;
            for (TodoItem it : items) {
                boolean isDone = TodoList.STATUS_DONE.equals(it.getStatus());
                String title = StringUtils.hasText(it.getTitle()) ? it.getTitle().trim() : "—";
                String titlePlain = title.replace("*", "").replace("_", "");
                sb.append("  ").append(n++).append(". ").append(isDone ? "[x]" : "[ ]")
                  .append(" **").append(underlinePlain(titlePlain)).append("**");
                if (it.getDueDate() != null) {
                    sb.append(" (").append(sdfDate.format(it.getDueDate())).append(")");
                }
                if (StringUtils.hasText(it.getPriority()) && !"normal".equals(it.getPriority())) {
                    sb.append(" [").append(it.getPriority()).append("]");
                }
                if (StringUtils.hasText(it.getAssigneeMemberId())) {
                    String assignee = membersRepository.findById(it.getAssigneeMemberId())
                            .map(this::organizerLabel)
                            .orElse(null);
                    if (StringUtils.hasText(assignee)) {
                        sb.append(" @").append(assignee);
                    }
                }
                sb.append("\n");
                if (StringUtils.hasText(it.getDescription())) {
                    String oneLine = htmlToPlainText(it.getDescription()).replace("\n", " ").trim();
                    if (StringUtils.hasText(oneLine)) {
                        sb.append("      ").append(oneLine).append("\n");
                    }
                }
            }
        }
        if (StringUtils.hasText(listUrl)) {
            sb.append("\n").append(t.get("VIEW_LIST")).append(":\n").append(listUrl.trim()).append("\n");
        }
        sb.append("\n---\n");
        if (StringUtils.hasText(senderName)) {
            sb.append(String.format(Locale.ROOT, t.get("SENT_BY"), senderName));
        } else {
            sb.append(t.get("SENT_VIA"));
        }
        sb.append("\n");
        return sb.toString();
    }

    /**
     * Translations for the share e-mail (kept inline rather than in a dedicated class because
     * the set of keys is small and tightly coupled to this template).
     */
    private static final Map<String, Map<String, String>> TODO_EMAIL_MESSAGES = new HashMap<>();

    private static Map<String, String> todoLang(String owner, String created, String due, String status, String tasks,
            String view, String sentBy, String sentVia, String fallback,
            String open, String inProgress, String done, String archived, String noTasks) {
        Map<String, String> m = new HashMap<>();
        m.put("OWNER", owner);
        m.put("CREATED_AT", created);
        m.put("DUE_DATE", due);
        m.put("STATUS", status);
        m.put("TASKS", tasks);
        m.put("VIEW_LIST", view);
        m.put("SENT_BY", sentBy);
        m.put("SENT_VIA", sentVia);
        m.put("LIST_FALLBACK", fallback);
        m.put("STATUS_OPEN", open);
        m.put("STATUS_IN_PROGRESS", inProgress);
        m.put("STATUS_DONE", done);
        m.put("STATUS_ARCHIVED", archived);
        m.put("NO_TASKS", noTasks);
        return m;
    }

    static {
        TODO_EMAIL_MESSAGES.put("fr", todoLang(
                "Propriétaire", "Créée le", "Échéance", "Statut", "Tâches",
                "Ouvrir dans PatTool",
                "Cet e-mail a été envoyé par %s via PatTool.",
                "Cet e-mail a été envoyé via PatTool.",
                "Liste de tâches",
                "Ouverte", "En cours", "Terminée", "Archivée",
                "Aucune tâche dans cette liste."));
        TODO_EMAIL_MESSAGES.put("en", todoLang(
                "Owner", "Created on", "Due date", "Status", "Tasks",
                "Open in PatTool",
                "This email was sent by %s via PatTool.",
                "This email was sent via PatTool.",
                "To-do list",
                "Open", "In progress", "Done", "Archived",
                "No tasks in this list."));
    }

    /**
     * Share-mail UI strings: only French and English are maintained; any other {@code mailLang}
     * falls back to English.
     */
    private Map<String, String> todoEmailMessages(String lang) {
        if (lang == null) {
            return TODO_EMAIL_MESSAGES.get("en");
        }
        String code = lang.toLowerCase(Locale.ROOT);
        if (code.startsWith("fr")) {
            return TODO_EMAIL_MESSAGES.get("fr");
        }
        return TODO_EMAIL_MESSAGES.get("en");
    }

    private Optional<ResponseEntity<TodoList>> applyLinkFieldsIfNeeded(TodoList list, TodoListRequest body, String userId) {
        boolean isCreate = !StringUtils.hasText(list.getId());
        if (!isCreate && !Boolean.TRUE.equals(body.getLinkTargetsProvided())) {
            return Optional.empty();
        }
        return applyValidatedLinks(list, body.getCalendarAppointmentId(), body.getEvenementId(), userId);
    }

    /**
     * Validates and sets {@link TodoList#getCalendarAppointmentId()} / {@link TodoList#getEvenementId()}
     * (mutually exclusive). Detaches any other list currently pointing at the same target.
     *
     * @return empty if OK, or a non-2xx response to return from the controller
     */
    private Optional<ResponseEntity<TodoList>> applyValidatedLinks(TodoList list, String calRaw, String evRaw,
            String userId) {
        String calId = StringUtils.hasText(calRaw) ? calRaw.trim() : null;
        String evId = StringUtils.hasText(evRaw) ? evRaw.trim() : null;
        if (calId != null && evId != null) {
            return Optional.of(ResponseEntity.badRequest().build());
        }
        String listId = list.getId();
        if (calId != null) {
            if (calendarAppointmentRepository.findById(calId).isEmpty()) {
                return Optional.of(ResponseEntity.badRequest().build());
            }
            if (calendarAppointmentRepository.findAccessibleByIdAndMember(calId, userId).isEmpty()) {
                return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
            }
            detachOtherListFromAppointment(calId, listId);
            list.setCalendarAppointmentId(calId);
            list.setEvenementId(null);
            return Optional.empty();
        }
        if (evId != null) {
            if (evenementsRepository.findById(evId).isEmpty()) {
                return Optional.of(ResponseEntity.badRequest().build());
            }
            if (!discussionService.canUserAccessEventForDetail(evId, userId)) {
                return Optional.of(ResponseEntity.status(HttpStatus.FORBIDDEN).build());
            }
            detachOtherListFromEvenement(evId, listId);
            list.setEvenementId(evId);
            list.setCalendarAppointmentId(null);
            return Optional.empty();
        }
        list.setCalendarAppointmentId(null);
        list.setEvenementId(null);
        return Optional.empty();
    }

    private void detachOtherListFromAppointment(String appointmentId, String exceptListId) {
        todoListRepository.findFirstByCalendarAppointmentId(appointmentId).ifPresent(other -> {
            if (exceptListId == null || !exceptListId.equals(other.getId())) {
                other.setCalendarAppointmentId(null);
                todoListRepository.save(other);
            }
        });
    }

    private void detachOtherListFromEvenement(String evenementId, String exceptListId) {
        todoListRepository.findFirstByEvenementId(evenementId).ifPresent(other -> {
            if (exceptListId == null || !exceptListId.equals(other.getId())) {
                other.setEvenementId(null);
                todoListRepository.save(other);
            }
        });
    }

    private void applyEditableFields(TodoList list, TodoListRequest body) {
        list.setName(body.getName().trim());
        list.setDescription(body.getDescription() != null ? body.getDescription().trim() : null);
        list.setImageDataUrl(StringUtils.hasText(body.getImageDataUrl()) ? body.getImageDataUrl() : null);
        list.setDueDate(body.getDueDate());
        list.setStatus(StringUtils.hasText(body.getStatus()) ? body.getStatus().trim() : TodoList.STATUS_OPEN);
        list.setUpdatedAt(new Date());
        applySharingFields(list, body.getVisibility(), body.getFriendGroupId(), body.getFriendGroupIds());
        list.setItems(applyItems(body.getItems()));
    }

    private List<TodoItem> applyItems(List<TodoListRequest.TodoItemPayload> payload) {
        if (payload == null) {
            return new ArrayList<>();
        }
        List<TodoItem> items = new ArrayList<>();
        for (TodoListRequest.TodoItemPayload p : payload) {
            if (p == null || !StringUtils.hasText(p.getTitle())) {
                continue;
            }
            TodoItem it = new TodoItem();
            it.setId(StringUtils.hasText(p.getId()) ? p.getId() : UUID.randomUUID().toString());
            it.setTitle(p.getTitle().trim());
            it.setDescription(p.getDescription() != null ? p.getDescription().trim() : null);
            it.setStatus(StringUtils.hasText(p.getStatus()) ? p.getStatus().trim() : TodoList.STATUS_OPEN);
            it.setDueDate(p.getDueDate());
            it.setAssigneeMemberId(StringUtils.hasText(p.getAssigneeMemberId())
                    ? p.getAssigneeMemberId().trim() : null);
            it.setPriority(StringUtils.hasText(p.getPriority()) ? p.getPriority().trim() : "normal");
            it.setCompletedAt(TodoList.STATUS_DONE.equals(it.getStatus())
                    ? (p.getCompletedAt() != null ? p.getCompletedAt() : new Date())
                    : null);
            items.add(it);
        }
        return items;
    }

    private void applySharingFields(TodoList entity, String visibilityRaw, String friendGroupIdRaw,
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

    private static boolean validImage(String dataUrl) {
        if (!StringUtils.hasText(dataUrl)) {
            return true;
        }
        if (!dataUrl.startsWith("data:image/")) {
            return false;
        }
        return dataUrl.length() <= MAX_IMAGE_DATA_URL_LENGTH;
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
