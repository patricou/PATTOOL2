package com.pat.service;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.Entities;
import org.jsoup.select.Elements;
import org.jsoup.safety.Safelist;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Sanitizes rich HTML (Quill output) before embedding in PDF XHTML.
 */
public final class RichHtmlSanitizer {

    private static final Pattern RGB_COLOR =
            Pattern.compile(
                    "rgba?\\(\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})(?:\\s*,\\s*[\\d.]+)?\\s*\\)",
                    Pattern.CASE_INSENSITIVE);

    private static final Safelist PDF_SAFELIST =
            Safelist.relaxed()
                    .addTags("span")
                    .addAttributes(":all", "class", "style")
                    .addAttributes("li", "data-list")
                    .addAttributes("img", "src", "alt", "width", "height")
                    .addAttributes("a", "href", "target", "rel")
                    .addProtocols("a", "href", "http", "https", "mailto")
                    .addProtocols("img", "src", "data");

    private RichHtmlSanitizer() {}

    /**
     * Returns a safe HTML fragment (no {@code html}/{@code body} wrapper) suitable for PDF rendering.
     */
    public static String sanitizeForPdf(String html) {
        if (html == null || html.isBlank()) {
            return "";
        }
        String cleaned = Jsoup.clean(html, PDF_SAFELIST);
        Document doc = Jsoup.parseBodyFragment(cleaned);
        normalizeQuillListsForPdf(doc);
        normalizeQuillClassesForPdf(doc);
        for (Element img : doc.select("img")) {
            String safeSrc = AssistantPdfExportService.sanitizeImageDataUrl(img.attr("src"));
            if (safeSrc == null) {
                img.remove();
            } else {
                img.attr("src", safeSrc);
                if (!img.hasAttr("alt")) {
                    img.attr("alt", "");
                }
                img.removeAttr("onerror");
                img.removeAttr("onload");
                normalizeImageDimensionsForPdf(img);
                applyImageAlignmentForPdf(img);
            }
        }
        for (Element a : doc.select("a[href]")) {
            String href = a.attr("href").trim();
            if (href.isEmpty()
                    || href.regionMatches(true, 0, "javascript:", 0, 11)
                    || href.regionMatches(true, 0, "data:", 0, 5)) {
                a.removeAttr("href");
            } else {
                a.attr("rel", "noopener noreferrer");
            }
        }
        for (Element el : doc.select("[style]")) {
            el.attr("style", sanitizeInlineStyle(el.attr("style")));
        }
        for (Element el : doc.select("[style=\"\"]")) {
            el.removeAttr("style");
        }
        Document.OutputSettings out = doc.outputSettings();
        out.syntax(Document.OutputSettings.Syntax.xml);
        out.escapeMode(Entities.EscapeMode.xhtml);
        out.charset("UTF-8");
        return ensureXhtmlVoidElements(doc.body().html());
    }

    /** OpenHTMLToPDF requires XHTML void elements ({@code <img … />}, {@code <br />}). */
    private static String ensureXhtmlVoidElements(String html) {
        if (html == null || html.isEmpty()) {
            return "";
        }
        StringBuilder out = new StringBuilder(html.length() + 32);
        int i = 0;
        while (i < html.length()) {
            int imgStart = indexOfIgnoreCase(html, "<img ", i);
            int brStart = indexOfIgnoreCase(html, "<br", i);
            int next = -1;
            if (imgStart >= 0 && (brStart < 0 || imgStart <= brStart)) {
                next = imgStart;
            } else if (brStart >= 0) {
                next = brStart;
            }
            if (next < 0) {
                out.append(html, i, html.length());
                break;
            }
            out.append(html, i, next);
            int end = html.indexOf('>', next);
            if (end < 0) {
                out.append(html, next, html.length());
                break;
            }
            String tag = html.substring(next, end + 1);
            if (!tag.endsWith("/>")) {
                out.append(tag, 0, tag.length() - 1).append(" />");
            } else {
                out.append(tag);
            }
            i = end + 1;
        }
        return out.toString();
    }

    private static int indexOfIgnoreCase(String haystack, String needle, int from) {
        String lower = haystack.toLowerCase();
        return lower.indexOf(needle.toLowerCase(), from);
    }

    /** Quill bullet lists use {@code ol > li[data-list=bullet]} — convert to {@code ul} for PDF. */
    private static void normalizeQuillListsForPdf(Document doc) {
        for (Element ol : doc.select("ol")) {
            Elements items = ol.select("> li");
            if (items.isEmpty()) {
                continue;
            }
            boolean allBullet = true;
            for (Element li : items) {
                if (!"bullet".equalsIgnoreCase(li.attr("data-list"))) {
                    allBullet = false;
                }
                li.removeAttr("data-list");
            }
            if (allBullet) {
                ol.tagName("ul");
            }
        }
        for (Element li : doc.select("li[data-list]")) {
            li.removeAttr("data-list");
        }
    }

    /**
     * Quill stores many formats as CSS classes ({@code ql-indent-*}, {@code ql-size-*}, …).
     * OpenHTMLToPDF does not load Quill stylesheets — inline them instead.
     */
    private static void normalizeQuillClassesForPdf(Document doc) {
        for (Element el : doc.select("[class]")) {
            String classes = el.className();
            if (classes.isBlank()) {
                continue;
            }
            StringBuilder style = new StringBuilder(sanitizeInlineStyle(el.attr("style")));

            if (classes.contains("ql-align-center")) {
                appendStyleDecl(style, "text-align", "center");
            } else if (classes.contains("ql-align-right")) {
                appendStyleDecl(style, "text-align", "right");
            } else if (classes.contains("ql-align-justify")) {
                appendStyleDecl(style, "text-align", "justify");
            }

            if (classes.contains("ql-direction-rtl")) {
                appendStyleDecl(style, "direction", "rtl");
            }

            for (int level = 1; level <= 9; level++) {
                if (classes.contains("ql-indent-" + level)) {
                    appendStyleDecl(style, "padding-left", (3 * level) + "em");
                    break;
                }
            }

            if (classes.contains("ql-size-small")) {
                appendStyleDecl(style, "font-size", "0.75em");
            } else if (classes.contains("ql-size-large")) {
                appendStyleDecl(style, "font-size", "1.5em");
            } else if (classes.contains("ql-size-huge")) {
                appendStyleDecl(style, "font-size", "2.5em");
            }

            if (classes.contains("ql-font-serif")) {
                appendStyleDecl(style, "font-family", "Georgia, 'Times New Roman', serif");
            } else if (classes.contains("ql-font-monospace")) {
                appendStyleDecl(style, "font-family", "Monaco, 'Courier New', monospace");
            }

            if (style.length() > 0) {
                el.attr("style", style.toString());
            }
        }
    }

    /** Keeps Quill / rich-text properties that OpenHTMLToPDF can render. */
    private static boolean isAllowedInlineProperty(String prop) {
        return switch (prop) {
            case "color",
                    "background-color",
                    "text-align",
                    "direction",
                    "font-size",
                    "font-family",
                    "font-weight",
                    "font-style",
                    "text-decoration",
                    "line-height",
                    "vertical-align",
                    "white-space",
                    "width",
                    "height",
                    "max-width",
                    "display",
                    "padding-left",
                    "padding-right",
                    "padding-top",
                    "padding-bottom",
                    "margin-left",
                    "margin-right",
                    "border-left",
                    "border-left-width",
                    "border-left-style",
                    "border-left-color" -> true;
            default -> false;
        };
    }

    /** Keeps only safe presentation hints Quill may emit inline or via class conversion. */
    private static String sanitizeInlineStyle(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        StringBuilder kept = new StringBuilder();
        for (String part : raw.split(";")) {
            String decl = part.trim();
            if (decl.isEmpty()) {
                continue;
            }
            int colon = decl.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String prop = decl.substring(0, colon).trim().toLowerCase();
            String value = decl.substring(colon + 1).trim();
            if (value.isEmpty() || value.contains("url(") || value.contains("expression(")) {
                continue;
            }
            if ("background".equals(prop) && !value.contains("gradient")) {
                prop = "background-color";
            }
            if (prop.startsWith("border-left")) {
                if ("border-left-color".equals(prop)) {
                    value = normalizeCssColor(value);
                }
            } else if ("color".equals(prop) || "background-color".equals(prop)) {
                value = normalizeCssColor(value);
            }
            if (isAllowedInlineProperty(prop)) {
                if (kept.length() > 0) {
                    kept.append("; ");
                }
                kept.append(prop).append(": ").append(value);
            }
        }
        return kept.toString();
    }

    /** OpenHTMLToPDF renders hex more reliably than rgb()/rgba(). */
    private static String normalizeCssColor(String value) {
        if (value == null || value.isBlank()) {
            return value;
        }
        String trimmed = value.trim();
        Matcher rgb = RGB_COLOR.matcher(trimmed);
        if (rgb.matches()) {
            int r = clampColorComponent(rgb.group(1));
            int g = clampColorComponent(rgb.group(2));
            int b = clampColorComponent(rgb.group(3));
            return String.format("#%02x%02x%02x", r, g, b);
        }
        return trimmed;
    }

    private static int clampColorComponent(String component) {
        int value = Integer.parseInt(component);
        return Math.max(0, Math.min(255, value));
    }

    /** OpenHTMLToPDF renders explicit sizes more reliably from inline CSS than bare attributes. */
    private static void normalizeImageDimensionsForPdf(Element img) {
        String widthAttr = img.attr("width").trim();
        String heightAttr = img.attr("height").trim();
        StringBuilder style = new StringBuilder(sanitizeInlineStyle(img.attr("style")));
        if (!widthAttr.matches("\\d+")) {
            widthAttr = extractPxFromStyle(style.toString(), "width");
        }
        if (!heightAttr.matches("\\d+")) {
            heightAttr = extractPxFromStyle(style.toString(), "height");
        }
        if (widthAttr.matches("\\d+")) {
            appendStyleDecl(style, "width", widthAttr + "px");
            if (heightAttr.matches("\\d+")) {
                appendStyleDecl(style, "height", heightAttr + "px");
            } else {
                appendStyleDecl(style, "height", "auto");
            }
            appendStyleDecl(style, "max-width", "100%");
        }
        if (style.length() > 0) {
            img.attr("style", style.toString());
        }
    }

    /** Margin auto on the img itself — OpenHTMLToPDF handles this more reliably than text-align on parent. */
    private static void applyImageAlignmentForPdf(Element img) {
        Element parent = img.parent();
        if (parent == null) {
            return;
        }
        String cls = parent.className();
        StringBuilder style = new StringBuilder(sanitizeInlineStyle(img.attr("style")));
        if (cls.contains("ql-align-center")) {
            appendStyleDecl(style, "display", "block");
            appendStyleDecl(style, "margin-left", "auto");
            appendStyleDecl(style, "margin-right", "auto");
        } else if (cls.contains("ql-align-right")) {
            appendStyleDecl(style, "display", "block");
            appendStyleDecl(style, "margin-left", "auto");
            appendStyleDecl(style, "margin-right", "0");
        }
        if (style.length() > 0) {
            img.attr("style", style.toString());
        }
    }

    private static String extractPxFromStyle(String style, String prop) {
        if (style == null || style.isBlank()) {
            return "";
        }
        String prefix = prop.toLowerCase() + ":";
        for (String part : style.split(";")) {
            String decl = part.trim();
            if (!decl.toLowerCase().startsWith(prefix)) {
                continue;
            }
            String value = decl.substring(decl.indexOf(':') + 1).trim();
            if (value.endsWith("px")) {
                String num = value.substring(0, value.length() - 2).trim();
                if (num.matches("\\d+(?:\\.\\d+)?")) {
                    return String.valueOf(Math.round(Double.parseDouble(num)));
                }
            }
        }
        return "";
    }

    private static void appendStyleDecl(StringBuilder style, String prop, String value) {
        if (value == null || value.isBlank()) {
            return;
        }
        String needle = prop.toLowerCase() + ":";
        if (style.indexOf(needle) >= 0) {
            return;
        }
        if (style.length() > 0) {
            style.append("; ");
        }
        style.append(prop).append(": ").append(value);
    }
}
