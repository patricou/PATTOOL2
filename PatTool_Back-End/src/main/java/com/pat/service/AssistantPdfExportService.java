package com.pat.service;

import com.openhtmltopdf.pdfboxout.PdfRendererBuilder;
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
import java.util.List;

/**
 * Export PDF de l’historique assistant : Markdown (réponses) et texte brut (utilisateur),
 * mise en page A4 via OpenHTMLToPDF (pas de rendu navigateur).
 */
@Service
public class AssistantPdfExportService {

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
        String you = HtmlUtils.htmlEscape(req.youLabel());
        String assistant = HtmlUtils.htmlEscape(req.assistantLabel());
        String escTitle = HtmlUtils.htmlEscape(title);
        String escExported = HtmlUtils.htmlEscape(exportedAt);

        StringBuilder body = new StringBuilder(64_000);
        body.append("<h1 class=\"doc-title\">").append(escTitle).append("</h1>");
        if (!escExported.isEmpty()) {
            body.append("<p class=\"doc-meta\">").append(escExported).append("</p>");
        }

        for (AssistantPdfExportTurnDto turn : req.turns()) {
            boolean user = "user".equals(turn.role());
            body.append("<div class=\"conv-bubble conv-bubble--").append(user ? "user" : "assistant").append("\">");
            body.append("<div class=\"conv-bubble-head\">");
            body.append("<span class=\"conv-badge conv-badge--").append(user ? "user" : "assistant").append("\">");
            body.append(user ? "U" : "A");
            body.append("</span>");
            body.append("<span class=\"conv-bubble-label\">").append(user ? you : assistant).append("</span>");
            body.append("</div>");
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
                + PDF_STYLES
                + "\n]]></style>\n</head><body>\n"
                + body
                + "\n</body></html>";
    }

    private void appendUserTurn(StringBuilder body, AssistantPdfExportTurnDto turn) {
        body.append("<div class=\"user-block\">");
        String c = turn.content() != null ? turn.content() : "";
        String trimmed = c.trim();
        if (!trimmed.isEmpty()) {
            body.append("<p class=\"user-text\">").append(HtmlUtils.htmlEscape(c)).append("</p>");
        } else if (!hasRenderableUserImage(turn)) {
            body.append("<p class=\"user-text\">—</p>");
        }
        appendPdfEmbeddedImages(body, turn, true);
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

    /** Ajoute les images d’un tour : liste {@code embeddedImageDataUrls}, sinon repli {@code imageDataUrl}. */
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
     * Limite les src d’images aux data URLs image sans caractères dangereux pour le XML/HTML.
     */
    static String sanitizeImageDataUrl(String url) {
        if (url == null) {
            return null;
        }
        String t = url.trim();
        if (t.length() > 16_000_000 || !t.startsWith("data:image/")) {
            return null;
        }
        if (t.contains("\"") || t.contains("<") || t.contains(">") || t.contains("\n") || t.contains("\r")) {
            return null;
        }
        int comma = t.indexOf(',');
        if (comma < 12 || comma > 120) {
            return null;
        }
        String meta = t.substring(5, comma);
        if (!meta.contains(";base64")) {
            return null;
        }
        return t;
    }

    private static final String PDF_STYLES = """
            @page { size: A4; margin: 14mm; }
            body {
              font-family: sans-serif;
              font-size: 10pt;
              line-height: 1.38;
              color: #334155;
              word-wrap: break-word;
            }
            h1.doc-title {
              font-size: 15pt;
              font-weight: 700;
              color: #0f172a;
              margin: 0 0 4pt 0;
              padding-bottom: 3pt;
              border-bottom: 1.5pt solid rgba(37,99,235,.25);
            }
            p.doc-meta { font-size: 8.5pt; color: #64748b; margin: 0 0 10pt 0; }
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
            div.md h1 { font-size: 12pt; color: #0f172a; border-bottom: 1px solid rgba(37,99,235,.2); padding-bottom: 2pt; }
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
            """;
}
