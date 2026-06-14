package com.pat.service;

import com.openhtmltopdf.pdfboxout.PdfRendererBuilder;
import com.openhtmltopdf.util.XRLog;
import com.pat.controller.dto.AssistantPdfExportRequestDto;
import com.pat.controller.dto.AssistantPdfExportTurnDto;
import com.vladsch.flexmark.ext.autolink.AutolinkExtension;
import com.vladsch.flexmark.ext.gfm.strikethrough.StrikethroughExtension;
import com.vladsch.flexmark.ext.tables.TablesExtension;
import com.vladsch.flexmark.html.HtmlRenderer;
import com.vladsch.flexmark.parser.Parser;
import com.vladsch.flexmark.util.data.MutableDataSet;
import org.springframework.stereotype.Service;
import org.springframework.web.util.HtmlUtils;

import java.io.ByteArrayOutputStream;
import java.util.List;

/**
 * PDF export for assistant history and rich-text documents: Markdown (assistant replies) and
 * plain or Quill HTML (user content), A4 layout via OpenHTMLToPDF (not browser rendering).
 */
@Service
public class AssistantPdfExportService {

    static {
        XRLog.setLoggingEnabled(false);
    }

    private final Parser markdownParser;
    private final HtmlRenderer markdownHtml;

    public AssistantPdfExportService() {
        MutableDataSet opts = new MutableDataSet();
        opts.set(
                Parser.EXTENSIONS,
                List.of(TablesExtension.create(), StrikethroughExtension.create(), AutolinkExtension.create()));
        this.markdownParser = Parser.builder(opts).build();
        this.markdownHtml = HtmlRenderer.builder(opts).escapeHtml(true).build();
    }

    public byte[] buildPdf(AssistantPdfExportRequestDto req) {
        String html = buildXhtml(req);
        try (ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(2_000_000, html.length() * 2))) {
            PdfRendererBuilder builder = new PdfRendererBuilder();
            builder.useFastMode();
            builder.withHtmlContent(html, null);
            builder.toStream(out);
            builder.run();
            return out.toByteArray();
        } catch (Exception e) {
            throw new IllegalStateException("PDF generation failed", e);
        }
    }

    private String buildXhtml(AssistantPdfExportRequestDto req) {
        String title = req.title() != null && !req.title().isBlank() ? req.title() : "PatTool Assistant";
        String exportedAt =
                req.exportedAt() != null && !req.exportedAt().isBlank() ? req.exportedAt() : "";
        String you = req.youLabel() != null ? HtmlUtils.htmlEscape(req.youLabel()).trim() : "";
        String assistant = req.assistantLabel() != null ? HtmlUtils.htmlEscape(req.assistantLabel()).trim() : "";
        String escTitle = HtmlUtils.htmlEscape(title);
        boolean showFooter = showPdfFooter(req);

        StringBuilder body = new StringBuilder(64_000);
        if (showFooter) {
            appendRunningPdfFooter(body, escTitle, exportedAt, req);
        }

        boolean plainDocument = you.isEmpty() && assistant.isEmpty();

        for (AssistantPdfExportTurnDto turn : req.turns()) {
            boolean user = "user".equals(turn.role());
            String bubbleKind =
                    plainDocument ? "document" : (user ? "user" : "assistant");
            body.append("<div class=\"conv-bubble conv-bubble--").append(bubbleKind).append("\">");
            String label = user ? you : assistant;
            if (!label.isEmpty()) {
                body.append("<div class=\"conv-bubble-head\">");
                body.append("<span class=\"conv-badge conv-badge--").append(user ? "user" : "assistant").append("\">");
                body.append(user ? "U" : "A");
                body.append("</span>");
                body.append("<span class=\"conv-bubble-label\">").append(label).append("</span>");
                body.append("</div>");
            }
            body.append("<div class=\"conv-bubble-body\">");
            if (user) {
                appendUserTurn(body, turn);
            } else {
                appendAssistantTurn(body, turn);
            }
            body.append("</div></div>");
        }

        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" "
                + "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">\n"
                + "<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"fr\" lang=\"fr\">\n<head>\n"
                + "<meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\"/>\n"
                + "<style type=\"text/css\"><![CDATA[\n"
                + resolvePdfStyles(showFooter)
                + "\n]]></style>\n</head><body>\n"
                + body
                + "\n</body></html>";
    }

    private static boolean showPdfFooter(AssistantPdfExportRequestDto req) {
        return req.showFooter() == null || Boolean.TRUE.equals(req.showFooter());
    }

    private static String resolvePdfStyles(boolean showFooter) {
        return (showFooter ? PDF_PAGE_WITH_FOOTER + PDF_FOOTER_RULES : PDF_PAGE_NO_FOOTER) + PDF_CONTENT_STYLES;
    }

    /** Running footer (first children of body) — repeated on every page by OpenHTMLToPDF. */
    private void appendRunningPdfFooter(
            StringBuilder body,
            String escTitle,
            String exportedAt,
            AssistantPdfExportRequestDto req) {
        body.append("<div class=\"pdf-footer-left\">");
        body.append("<span class=\"pdf-footer-doc-name\">").append(escTitle).append("</span>");
        if (exportedAt != null && !exportedAt.isBlank()) {
            body.append("<span class=\"pdf-footer-date\">")
                    .append(HtmlUtils.htmlEscape(exportedAt.trim()))
                    .append("</span>");
        }
        body.append("</div>");
        body.append("<div class=\"pdf-footer-right\">")
                .append(buildFooterUserLine(req))
                .append("</div>");
    }

    private String buildFooterUserLine(AssistantPdfExportRequestDto req) {
        StringBuilder line = new StringBuilder();
        appendFooterPart(line, req.authorUserName());
        String fullName = joinNonBlank(" ", req.authorFirstName(), req.authorLastName());
        appendFooterPart(line, fullName);
        return line.toString();
    }

    private void appendFooterPart(StringBuilder line, String raw) {
        if (raw == null || raw.isBlank()) {
            return;
        }
        if (line.length() > 0) {
            line.append(" · ");
        }
        line.append(HtmlUtils.htmlEscape(raw.trim()));
    }

    private static String joinNonBlank(String sep, String... parts) {
        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            if (part == null || part.isBlank()) {
                continue;
            }
            if (out.length() > 0) {
                out.append(sep);
            }
            out.append(part.trim());
        }
        return out.toString();
    }

    private void appendUserTurn(StringBuilder body, AssistantPdfExportTurnDto turn) {
        body.append("<div class=\"user-block\">");
        String c = turn.content() != null ? turn.content() : "";
        String trimmed = c.trim();
        boolean richHtml = Boolean.TRUE.equals(turn.contentHtml());
        if (!trimmed.isEmpty()) {
            if (richHtml) {
                String safe = RichHtmlSanitizer.sanitizeForPdf(trimmed);
                if (safe.isBlank()) {
                    body.append("<p class=\"user-text\">—</p>");
                } else {
                    body.append("<div class=\"user-html\">").append(safe).append("</div>");
                }
            } else {
                body.append("<p class=\"user-text\">").append(HtmlUtils.htmlEscape(c)).append("</p>");
            }
        } else if (!hasRenderableUserImage(turn)) {
            body.append("<p class=\"user-text\">—</p>");
        }
        if (!richHtml) {
            appendPdfEmbeddedImages(body, turn, true);
        }
        body.append("</div>");
    }

    private boolean hasRenderableUserImage(AssistantPdfExportTurnDto turn) {
        List<String> embedded = turn.embeddedImageDataUrls();
        if (embedded != null) {
            for (String raw : embedded) {
                if (sanitizeImageDataUrl(raw) != null) {
                    return true;
                }
            }
        }
        return sanitizeImageDataUrl(turn.imageDataUrl()) != null;
    }

    /** Appends turn images: {@code embeddedImageDataUrls} list, or fallback {@code imageDataUrl}. */
    private void appendPdfEmbeddedImages(StringBuilder body, AssistantPdfExportTurnDto turn, boolean userTurn) {
        String imgClass = userTurn ? "pdf-msg-img pdf-msg-img--user" : "pdf-msg-img pdf-msg-img--assistant";
        boolean usedEmbedded = false;
        List<String> embedded = turn.embeddedImageDataUrls();
        if (embedded != null) {
            for (String raw : embedded) {
                String img = sanitizeImageDataUrl(raw);
                if (img != null) {
                    body.append("<img class=\"")
                            .append(imgClass)
                            .append("\" src=\"")
                            .append(img)
                            .append("\" alt=\"\" />");
                    usedEmbedded = true;
                }
            }
        }
        if (!usedEmbedded) {
            String legacy = sanitizeImageDataUrl(turn.imageDataUrl());
            if (legacy != null) {
                body.append("<img class=\"")
                        .append(imgClass)
                        .append("\" src=\"")
                        .append(legacy)
                        .append("\" alt=\"\" />");
            }
        }
    }

    private void appendAssistantTurn(StringBuilder body, AssistantPdfExportTurnDto turn) {
        if (turn.providerModelLine() != null && !turn.providerModelLine().isBlank()) {
            body.append("<p class=\"provider\">")
                    .append(HtmlUtils.htmlEscape(turn.providerModelLine()))
                    .append("</p>");
        }
        if (turn.statsLine() != null && !turn.statsLine().isBlank()) {
            body.append("<p class=\"stats\">")
                    .append(HtmlUtils.htmlEscape(turn.statsLine()))
                    .append("</p>");
        }
        body.append("<div class=\"md\">").append(markdownToHtmlFragment(turn.content())).append("</div>");
        appendPdfEmbeddedImages(body, turn, false);
    }

    private String markdownToHtmlFragment(String md) {
        if (md == null || md.isBlank()) {
            return "<p>—</p>";
        }
        try {
            return markdownHtml.render(markdownParser.parse(md));
        } catch (Exception e) {
            return "<p>" + HtmlUtils.htmlEscape(md) + "</p>";
        }
    }

    /**
     * Restricts image {@code src} to safe image data URLs without characters that break XML/HTML.
     */
    static String sanitizeImageDataUrl(String url) {
        if (url == null) {
            return null;
        }
        String t = url.trim();
        if (t.length() > 16_000_000 || !t.startsWith("data:image/")) {
            return null;
        }
        int comma = t.indexOf(',');
        if (comma < 12 || comma > 120) {
            return null;
        }
        String meta = t.substring(5, comma);
        if (!meta.toLowerCase().contains(";base64")) {
            return null;
        }
        String payload = t.substring(comma + 1).replaceAll("\\s+", "");
        if (payload.isEmpty()) {
            return null;
        }
        String rebuilt = t.substring(0, comma + 1) + payload;
        if (rebuilt.contains("\"") || rebuilt.contains("<") || rebuilt.contains(">")) {
            return null;
        }
        return rebuilt;
    }

    private static final String PDF_PAGE_WITH_FOOTER = """
            @page {
              size: A4;
              margin: 14mm 14mm 20mm 14mm;
              @bottom-left {
                content: element(pdf-footer-left);
                vertical-align: top;
                border-top: 0.5pt solid #94a3b8;
                padding-top: 4pt;
                font-size: 7pt;
                color: #64748b;
              }
              @bottom-center {
                content: counter(page) " / " counter(pages);
                vertical-align: top;
                border-top: 0.5pt solid #94a3b8;
                padding-top: 4pt;
                font-size: 7pt;
                color: #64748b;
                text-align: center;
              }
              @bottom-right {
                content: element(pdf-footer-right);
                vertical-align: top;
                border-top: 0.5pt solid #94a3b8;
                padding-top: 4pt;
                font-size: 7pt;
                color: #64748b;
                text-align: right;
              }
            }
            """;

    private static final String PDF_PAGE_NO_FOOTER = """
            @page {
              size: A4;
              margin: 14mm 14mm 16mm 14mm;
              @bottom-center {
                content: counter(page) " / " counter(pages);
                vertical-align: top;
                font-size: 7pt;
                color: #64748b;
                text-align: center;
              }
            }
            """;

    private static final String PDF_FOOTER_RULES = """
            div.pdf-footer-left {
              position: running(pdf-footer-left);
              font-size: 7pt;
              color: #64748b;
            }
            span.pdf-footer-doc-name {
              display: block;
              font-weight: 600;
              color: #475569;
            }
            span.pdf-footer-date {
              display: block;
              margin-top: 1pt;
              font-size: 6.5pt;
            }
            div.pdf-footer-right {
              position: running(pdf-footer-right);
              font-size: 7pt;
              color: #64748b;
              text-align: right;
              width: 100%;
            }
            """;

    private static final String PDF_CONTENT_STYLES = """
            body {
              font-family: sans-serif;
              font-size: 10pt;
              line-height: 1.38;
              color: #334155;
              word-wrap: break-word;
            }
            div.conv-bubble {
              border-radius: 10px;
              padding: 8pt 10pt;
              margin: 0 0 10pt 0;
              border: 1px solid #e2e8f0;
              page-break-inside: avoid;
            }
            div.conv-bubble--user {
              background: #eff6ff;
              border-color: #93c5fd;
            }
            div.conv-bubble--assistant {
              background: #ffffff;
              border-color: #cbd5e1;
            }
            div.conv-bubble--document {
              background: transparent;
              border: none;
              border-radius: 0;
              padding: 0;
              margin: 0;
            }
            div.conv-bubble-head {
              margin: 0 0 5pt 0;
              padding: 0;
            }
            span.conv-badge {
              display: inline-block;
              width: 12pt;
              height: 12pt;
              line-height: 12pt;
              text-align: center;
              border-radius: 50%;
              font-size: 6.5pt;
              font-weight: 700;
              color: #ffffff;
              margin-right: 5pt;
              vertical-align: middle;
            }
            span.conv-badge--user { background: #2563eb; }
            span.conv-badge--assistant { background: #475569; }
            span.conv-bubble-label {
              font-size: 9.5pt;
              font-weight: 700;
              color: #0f172a;
              vertical-align: middle;
            }
            div.conv-bubble-body { margin: 0; padding: 0; }
            p.provider { font-size: 8.8pt; color: #374151; margin: 0 0 2pt 0; font-weight: 500; }
            p.stats { font-size: 8.2pt; color: #64748b; margin: 0 0 5pt 0; }
            div.user-block { margin-top: 2pt; }
            p.user-text { white-space: pre-wrap; margin: 0 0 5pt 0; }
            img.pdf-msg-img {
              max-width: 100%;
              height: auto;
              display: block;
              margin: 6pt 0 0 0;
              border-radius: 4pt;
            }
            div.md { font-size: 10pt; }
            div.md > :first-child { margin-top: 0; }
            div.md p { margin: 0 0 5pt 0; orphans: 2; widows: 2; }
            div.md h1, div.md h2, div.md h3, div.md h4, div.md h5, div.md h6 {
              font-weight: 700;
              line-height: 1.25;
              color: #1e293b;
              page-break-after: avoid;
              margin: 6pt 0 3pt 0;
            }
            div.md h1 { font-size: 12pt; color: #0f172a; border-bottom: 1px solid #d3e0fb; padding-bottom: 2pt; }
            div.md h2 { font-size: 11pt; color: #1e3a8a; }
            div.md h3 { font-size: 10.2pt; color: #334155; }
            div.md h4 { font-size: 10pt; }
            div.md strong { font-weight: 700; color: #0f172a; }
            div.md ul, div.md ol { margin: 3pt 0 5pt 0; padding-left: 14pt; }
            div.md li { margin: 2pt 0; }
            div.md blockquote {
              margin: 5pt 0;
              padding: 4pt 8pt;
              border-left: 2pt solid #60a5fa;
              background: #eff6ff;
              color: #1e40af;
            }
            div.md pre {
              margin: 5pt 0;
              padding: 5pt 7pt;
              font-size: 8.5pt;
              line-height: 1.35;
              color: #e2e8f0;
              background: #0f172a;
              border: 1px solid #334155;
              border-radius: 3pt;
              white-space: pre-wrap;
              page-break-inside: avoid;
            }
            div.md code {
              font-family: monospace;
              font-size: 0.9em;
              font-weight: 600;
              color: #5b21b6;
              background: #ede9fe;
              padding: 0.5pt 2pt;
              border-radius: 2pt;
            }
            div.md pre code {
              font-family: monospace;
              font-size: inherit;
              font-weight: 400;
              color: inherit;
              background: transparent;
              padding: 0;
            }
            div.md table {
              width: 100%;
              border-collapse: collapse;
              margin: 5pt 0 6pt 0;
              font-size: 9pt;
              table-layout: fixed;
            }
            div.md th, div.md td {
              border: 1px solid #e2e8f0;
              padding: 3pt 4pt;
              text-align: left;
              vertical-align: top;
            }
            div.md thead tr { background: #2563eb; color: #fff; }
            div.md hr { border: none; border-top: 1px solid #cbd5e1; margin: 6pt 0; }
            div.md a { color: #2563eb; text-decoration: underline; }
            div.md img { max-width: 100%; height: auto; display: block; margin: 5pt 0; }
            div.user-html { font-size: 10pt; color: #1e293b; line-height: 1.38; }
            div.user-html > :first-child { margin-top: 0; }
            div.user-html p { margin: 0 0 5pt 0; orphans: 2; widows: 2; }
            div.user-html h1 { font-size: 2em; margin: 0.67em 0; font-weight: 700; }
            div.user-html h2 { font-size: 1.5em; margin: 0.75em 0; font-weight: 700; }
            div.user-html h3 { font-size: 1.17em; margin: 0.83em 0; font-weight: 700; }
            div.user-html h4 { font-size: 1em; margin: 1.12em 0; font-weight: 700; }
            div.user-html h5 { font-size: 0.83em; margin: 1.5em 0; font-weight: 700; }
            div.user-html h6 { font-size: 0.67em; margin: 1.67em 0; font-weight: 700; }
            div.user-html strong, div.user-html b { font-weight: 700; }
            div.user-html em, div.user-html i { font-style: italic; }
            div.user-html u { text-decoration: underline; }
            div.user-html s, div.user-html strike { text-decoration: line-through; }
            div.user-html sub { vertical-align: sub; font-size: smaller; }
            div.user-html sup { vertical-align: super; font-size: smaller; }
            div.user-html ul, div.user-html ol { margin: 3pt 0 5pt 0; padding-left: 18pt; }
            div.user-html ul { list-style-type: disc; }
            div.user-html ol { list-style-type: decimal; }
            div.user-html li { margin: 2pt 0; }
            div.user-html blockquote {
              margin: 5pt 0;
              padding: 4pt 8pt 4pt 10pt;
              border-left: 3pt solid #cbd5e1;
            }
            div.user-html pre, div.user-html pre.ql-syntax {
              margin: 5pt 0;
              padding: 5pt 7pt;
              font-family: Monaco, 'Courier New', monospace;
              font-size: 8.5pt;
              line-height: 1.35;
              white-space: pre-wrap;
              page-break-inside: avoid;
            }
            div.user-html code {
              font-family: Monaco, 'Courier New', monospace;
              font-size: 0.9em;
            }
            div.user-html img {
              max-width: 100%;
              height: auto;
              display: block;
              margin: 6pt 0;
            }
            div.user-html .ql-align-center img,
            div.user-html .ql-align-right img {
              margin-left: auto;
              margin-right: auto;
            }
            div.user-html .ql-align-right img {
              margin-left: auto;
              margin-right: 0;
            }
            div.user-html a { text-decoration: underline; }
            div.user-html .ql-align-center { text-align: center; }
            div.user-html .ql-align-right { text-align: right; }
            div.user-html .ql-align-justify { text-align: justify; }
            div.user-html .ql-direction-rtl { direction: rtl; }
            div.user-html .ql-indent-1 { padding-left: 3em; }
            div.user-html .ql-indent-2 { padding-left: 6em; }
            div.user-html .ql-indent-3 { padding-left: 9em; }
            div.user-html .ql-indent-4 { padding-left: 12em; }
            div.user-html .ql-indent-5 { padding-left: 15em; }
            div.user-html .ql-indent-6 { padding-left: 18em; }
            div.user-html .ql-indent-7 { padding-left: 21em; }
            div.user-html .ql-indent-8 { padding-left: 24em; }
            div.user-html .ql-indent-9 { padding-left: 27em; }
            div.user-html .ql-size-small { font-size: 0.75em; }
            div.user-html .ql-size-large { font-size: 1.5em; }
            div.user-html .ql-size-huge { font-size: 2.5em; }
            div.user-html .ql-font-serif { font-family: Georgia, 'Times New Roman', serif; }
            div.user-html .ql-font-monospace { font-family: Monaco, 'Courier New', monospace; }
            """;
}
