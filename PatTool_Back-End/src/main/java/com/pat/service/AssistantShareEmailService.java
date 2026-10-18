package com.pat.service;

import com.pat.controller.MailController;
import com.pat.controller.dto.AssistantPdfExportRequestDto;
import com.pat.controller.dto.AssistantPdfExportTurnDto;
import com.pat.controller.dto.AssistantShareEmailRequestDto;
import com.pat.repo.domain.Member;
import com.pat.service.assistant.AssistantPdfFilenameSupport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.util.HtmlUtils;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Shares the assistant conversation by e-mail: Markdown replies rendered as HTML, generated / attached
 * images inline ({@code cid:}), and optionally the same PDF as the export button as an attachment.
 * Recipients are restricted to the current user and their friends ({@link FriendsService#resolveFriendShareEmails}).
 */
@Service
public class AssistantShareEmailService {

    private static final Logger log = LoggerFactory.getLogger(AssistantShareEmailService.class);

    /** Above this total, further images are left to the PDF attachment only. */
    private static final long MAX_INLINE_IMAGES_BYTES = 10L * 1024 * 1024;
    private static final int SUBJECT_EXCERPT_MAX = 80;

    private final AssistantPdfExportService pdfExportService;
    private final FriendsService friendsService;
    private final MailController mailController;

    public AssistantShareEmailService(
            AssistantPdfExportService pdfExportService,
            FriendsService friendsService,
            MailController mailController) {
        this.pdfExportService = pdfExportService;
        this.friendsService = friendsService;
        this.mailController = mailController;
    }

    /** Result counts returned to the client. */
    public record ShareResult(int sent, int skipped, int total) {}

    /**
     * @throws IllegalArgumentException {@code not_friend:<id>} when a recipient is neither the sender nor a friend
     */
    public ShareResult share(Member sender, AssistantShareEmailRequestDto req) {
        List<String> emails = friendsService.resolveFriendShareEmails(sender, req.toMemberIds(), null);
        Map<String, String> t = messages(req.mailLang());
        AssistantPdfExportRequestDto conv = req.conversation();
        String senderName = senderLabel(sender);

        List<SmtpMailSender.MailPart> inlines = new ArrayList<>();
        boolean attachPdf = !Boolean.FALSE.equals(req.attachPdf());
        String html = buildHtml(conv, t, senderName, req.customMessage(), attachPdf, inlines);
        String plain = buildPlainText(conv, t, senderName, req.customMessage(), attachPdf);

        List<SmtpMailSender.MailPart> attachments = new ArrayList<>();
        String pdfName = AssistantPdfFilenameSupport.buildFilename(conv.turns());
        String txtName = pdfName.endsWith(".pdf")
                ? pdfName.substring(0, pdfName.length() - 4) + ".txt"
                : pdfName + ".txt";
        attachments.add(new SmtpMailSender.MailPart(
                txtName, plain.getBytes(StandardCharsets.UTF_8), "text/plain; charset=UTF-8"));
        if (attachPdf) {
            byte[] pdf = pdfExportService.buildPdf(conv);
            attachments.add(new SmtpMailSender.MailPart(pdfName, pdf, "application/pdf"));
        }

        String subject = buildSubject(conv.turns(), t);
        String bcc = mailController.getMailSentTo();
        int sent = 0;
        int skipped = 0;
        for (String email : emails) {
            String trimmed = email != null ? email.trim() : "";
            if (trimmed.isEmpty() || !mailController.isValidEmail(trimmed)) {
                skipped++;
                continue;
            }
            try {
                mailController.sendMailToRecipientWithParts(trimmed, subject, plain, html, inlines, attachments, bcc);
                sent++;
            } catch (Exception e) {
                log.error("Failed to send assistant conversation to {}: {}", trimmed, e.getMessage(), e);
                skipped++;
            }
        }
        return new ShareResult(sent, skipped, emails.size());
    }

    private String buildHtml(
            AssistantPdfExportRequestDto conv,
            Map<String, String> t,
            String senderName,
            String customMessage,
            boolean attachPdf,
            List<SmtpMailSender.MailPart> inlines) {
        String you = conv.youLabel() != null ? conv.youLabel().trim() : "";
        String assistant = conv.assistantLabel() != null ? conv.assistantLabel().trim() : "";
        long inlineBytes = 0;
        boolean imagesOmitted = false;

        StringBuilder turnsHtml = new StringBuilder(32_000);
        for (AssistantPdfExportTurnDto turn : conv.turns()) {
            boolean user = "user".equals(turn.role());
            String label = user ? you : assistant;
            turnsHtml.append("<div style='")
                    .append(user
                            ? "background:#eff6ff;border:1px solid #93c5fd;"
                            : "background:#ffffff;border:1px solid #cbd5e1;")
                    .append("border-radius:10px;padding:12px 14px;margin:0 0 12px 0;'>");
            if (!label.isEmpty()) {
                turnsHtml.append("<div style='font-weight:700;color:#0f172a;margin:0 0 6px 0;'>")
                        .append(HtmlUtils.htmlEscape(label))
                        .append("</div>");
            }
            if (!user && StringUtils.hasText(turn.providerModelLine())) {
                turnsHtml.append("<div style='font-size:12px;color:#374151;margin:0 0 2px 0;'>")
                        .append(HtmlUtils.htmlEscape(turn.providerModelLine()))
                        .append("</div>");
            }
            if (!user && StringUtils.hasText(turn.statsLine())) {
                turnsHtml.append("<div style='font-size:11px;color:#64748b;margin:0 0 6px 0;'>")
                        .append(HtmlUtils.htmlEscape(turn.statsLine()))
                        .append("</div>");
            }
            turnsHtml.append("<div class='md'>").append(turnBodyHtml(turn, user)).append("</div>");

            for (String raw : turnImages(turn)) {
                DecodedImage img = decodeDataUrl(raw);
                if (img == null) {
                    continue;
                }
                if (inlineBytes + img.bytes.length > MAX_INLINE_IMAGES_BYTES) {
                    imagesOmitted = true;
                    continue;
                }
                inlineBytes += img.bytes.length;
                String cid = "assistantImg" + inlines.size();
                inlines.add(new SmtpMailSender.MailPart(cid, img.bytes, img.contentType));
                turnsHtml.append("<img src='cid:").append(cid)
                        .append("' alt='' style='display:block;max-width:100%;height:auto;margin:8px 0 0 0;border-radius:6px;'/>");
            }
            turnsHtml.append("</div>");
        }

        StringBuilder sb = new StringBuilder(turnsHtml.length() + 4_000);
        sb.append("<!DOCTYPE html><html><head><meta charset='UTF-8'><style>")
                .append(EMAIL_MD_STYLES)
                .append("</style></head>")
                .append("<body style='margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#334155;'>")
                .append("<div style='max-width:760px;margin:0 auto;padding:20px;'>")
                .append("<div style='background:linear-gradient(135deg,#2563eb,#4f46e5);color:#ffffff;border-radius:10px 10px 0 0;padding:16px 20px;'>")
                .append("<div style='font-size:20px;font-weight:700;'>")
                .append(HtmlUtils.htmlEscape(conv.title() != null && !conv.title().isBlank() ? conv.title() : "PatTool Assistant"))
                .append("</div>");
        if (StringUtils.hasText(conv.exportedAt())) {
            sb.append("<div style='font-size:12px;opacity:0.9;margin-top:4px;'>")
                    .append(HtmlUtils.htmlEscape(conv.exportedAt()))
                    .append("</div>");
        }
        sb.append("</div>")
                .append("<div style='background:#ffffff;border-radius:0 0 10px 10px;padding:18px 20px;'>")
                .append("<p style='margin:0 0 14px 0;'>")
                .append(HtmlUtils.htmlEscape(String.format(Locale.ROOT, t.get("INTRO"), senderName)))
                .append("</p>");
        if (StringUtils.hasText(customMessage)) {
            sb.append("<div style='background:#fefce8;border-left:4px solid #eab308;padding:10px 12px;margin:0 0 16px 0;white-space:pre-wrap;'>")
                    .append(HtmlUtils.htmlEscape(customMessage.trim()))
                    .append("</div>");
        }
        sb.append(turnsHtml);
        sb.append("<p style='font-size:13px;color:#475569;margin:14px 0 0 0;'>")
                .append(HtmlUtils.htmlEscape(t.get("TXT_NOTE")))
                .append("</p>");
        if (attachPdf) {
            sb.append("<p style='font-size:13px;color:#475569;margin:8px 0 0 0;'>")
                    .append(HtmlUtils.htmlEscape(t.get("PDF_NOTE")))
                    .append("</p>");
        }
        if (imagesOmitted) {
            sb.append("<p style='font-size:13px;color:#b45309;margin:8px 0 0 0;'>")
                    .append(HtmlUtils.htmlEscape(t.get(attachPdf ? "IMAGES_OMITTED_PDF" : "IMAGES_OMITTED")))
                    .append("</p>");
        }
        sb.append("<div style='font-size:12px;color:#94a3b8;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:10px;'>")
                .append(HtmlUtils.htmlEscape(t.get("FOOTER")))
                .append("</div></div></div></body></html>");
        return sb.toString();
    }

    private String turnBodyHtml(AssistantPdfExportTurnDto turn, boolean user) {
        String content = turn.content() != null ? turn.content() : "";
        if (!user) {
            return pdfExportService.markdownToHtmlFragment(content);
        }
        if (content.isBlank()) {
            return "";
        }
        if (Boolean.TRUE.equals(turn.contentHtml())) {
            return RichHtmlSanitizer.sanitizeForPdf(content.trim());
        }
        return "<p style='white-space:pre-wrap;margin:0;'>" + HtmlUtils.htmlEscape(content.trim()) + "</p>";
    }

    private static List<String> turnImages(AssistantPdfExportTurnDto turn) {
        List<String> out = new ArrayList<>();
        if (turn.embeddedImageDataUrls() != null) {
            for (String raw : turn.embeddedImageDataUrls()) {
                if (raw != null && !raw.isBlank()) {
                    out.add(raw);
                }
            }
        }
        if (out.isEmpty() && turn.imageDataUrl() != null && !turn.imageDataUrl().isBlank()) {
            out.add(turn.imageDataUrl());
        }
        return out;
    }

    private String buildPlainText(
            AssistantPdfExportRequestDto conv,
            Map<String, String> t,
            String senderName,
            String customMessage,
            boolean attachPdf) {
        String you = conv.youLabel() != null ? conv.youLabel().trim() : "";
        String assistant = conv.assistantLabel() != null ? conv.assistantLabel().trim() : "";
        StringBuilder sb = new StringBuilder(16_000);
        sb.append(String.format(Locale.ROOT, t.get("INTRO"), senderName)).append("\n\n");
        if (StringUtils.hasText(customMessage)) {
            sb.append(customMessage.trim()).append("\n\n");
        }
        for (AssistantPdfExportTurnDto turn : conv.turns()) {
            boolean user = "user".equals(turn.role());
            String label = user ? you : assistant;
            sb.append("----------------------------------------\n");
            if (!label.isEmpty()) {
                sb.append(label).append('\n');
            }
            if (!user && StringUtils.hasText(turn.providerModelLine())) {
                sb.append(turn.providerModelLine().trim()).append('\n');
            }
            String content = turn.content() != null ? turn.content().trim() : "";
            if (Boolean.TRUE.equals(turn.contentHtml())) {
                content = content.replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").trim();
            }
            sb.append(content.isEmpty() ? "—" : content).append("\n\n");
        }
        sb.append(t.get("TXT_NOTE")).append("\n");
        if (attachPdf) {
            sb.append(t.get("PDF_NOTE")).append("\n");
        }
        sb.append("\n");
        sb.append(t.get("FOOTER"));
        return sb.toString();
    }

    private static String buildSubject(List<AssistantPdfExportTurnDto> turns, Map<String, String> t) {
        String base = "PatTool – " + t.get("SUBJECT");
        if (turns == null) {
            return base;
        }
        for (AssistantPdfExportTurnDto turn : turns) {
            if (turn == null || !"user".equals(turn.role()) || turn.content() == null) {
                continue;
            }
            String raw = Boolean.TRUE.equals(turn.contentHtml())
                    ? turn.content().replaceAll("<[^>]+>", " ")
                    : turn.content();
            String excerpt = AssistantPdfFilenameSupport.plainTextForSlug(raw);
            if (excerpt.isEmpty()) {
                continue;
            }
            if (excerpt.length() > SUBJECT_EXCERPT_MAX) {
                excerpt = excerpt.substring(0, SUBJECT_EXCERPT_MAX).trim() + "…";
            }
            return base + " : " + excerpt;
        }
        return base;
    }

    private static String senderLabel(Member m) {
        String first = StringUtils.hasText(m.getFirstName()) ? m.getFirstName().trim() : "";
        String last = StringUtils.hasText(m.getLastName()) ? m.getLastName().trim() : "";
        String full = (first + " " + last).trim();
        if (!full.isEmpty()) {
            return full;
        }
        return StringUtils.hasText(m.getUserName()) ? m.getUserName().trim() : "PatTool";
    }

    private record DecodedImage(byte[] bytes, String contentType) {}

    private static DecodedImage decodeDataUrl(String raw) {
        String url = AssistantPdfExportService.sanitizeImageDataUrl(raw);
        if (url == null) {
            return null;
        }
        int comma = url.indexOf(',');
        int semi = url.indexOf(';');
        if (semi < 0 || semi > comma) {
            return null;
        }
        try {
            byte[] bytes = Base64.getDecoder().decode(url.substring(comma + 1));
            return bytes.length == 0 ? null : new DecodedImage(bytes, url.substring(5, semi));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Fixed phrases of the mail ({@code fr} or English fallback); conversation labels come localized from the client. */
    private static Map<String, String> messages(String mailLang) {
        boolean fr = mailLang != null && mailLang.trim().toLowerCase(Locale.ROOT).startsWith("fr");
        Map<String, String> m = new LinkedHashMap<>();
        if (fr) {
            m.put("SUBJECT", "Assistant");
            m.put("INTRO", "%s vous partage une conversation avec l’Assistant PatTool.");
            m.put("TXT_NOTE", "Le texte intégral de la conversation est aussi joint au format texte (.txt).");
            m.put("PDF_NOTE", "La conversation complète (avec les images) est jointe au format PDF.");
            m.put("IMAGES_OMITTED_PDF", "Certaines images ne sont pas affichées ici : voir le PDF joint.");
            m.put("IMAGES_OMITTED", "Certaines images sont trop volumineuses pour être affichées dans ce message.");
            m.put("FOOTER", "Envoyé via PatTool");
        } else {
            m.put("SUBJECT", "Assistant");
            m.put("INTRO", "%s shared a PatTool Assistant conversation with you.");
            m.put("TXT_NOTE", "The full conversation text is also attached as a plain-text file (.txt).");
            m.put("PDF_NOTE", "The full conversation (with images) is attached as a PDF.");
            m.put("IMAGES_OMITTED_PDF", "Some images are not shown here: see the attached PDF.");
            m.put("IMAGES_OMITTED", "Some images are too large to be shown in this message.");
            m.put("FOOTER", "Sent via PatTool");
        }
        return m;
    }

    private static final String EMAIL_MD_STYLES = """
            .md { font-size:14px; line-height:1.5; color:#334155; }
            .md p { margin:0 0 8px 0; }
            .md h1, .md h2, .md h3, .md h4 { color:#1e293b; margin:10px 0 6px 0; line-height:1.25; }
            .md h1 { font-size:20px; } .md h2 { font-size:18px; } .md h3 { font-size:16px; } .md h4 { font-size:15px; }
            .md ul, .md ol { margin:4px 0 8px 0; padding-left:22px; }
            .md li { margin:2px 0; }
            .md blockquote { margin:6px 0; padding:6px 10px; border-left:3px solid #60a5fa; background:#eff6ff; color:#1e40af; }
            .md pre { background:#0f172a; color:#e2e8f0; padding:8px 10px; border-radius:4px; white-space:pre-wrap; font-size:12px; }
            .md code { font-family:Consolas,Monaco,monospace; background:#ede9fe; color:#5b21b6; padding:1px 3px; border-radius:3px; font-size:0.92em; }
            .md pre code { background:transparent; color:inherit; padding:0; }
            .md table { border-collapse:collapse; width:100%; margin:6px 0 8px 0; font-size:13px; }
            .md th, .md td { border:1px solid #e2e8f0; padding:4px 6px; text-align:left; vertical-align:top; }
            .md th { background:#2563eb; color:#ffffff; }
            .md a { color:#2563eb; }
            .md img { max-width:100%; height:auto; }
            """;
}
