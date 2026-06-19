package com.pat.service.assistant;

import com.pat.controller.dto.AssistantPdfExportTurnDto;

import java.text.Normalizer;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** Nom de fichier PDF export assistant ({@code pat-assistant-<résumé>-<horodatage>.pdf}). */
public final class AssistantPdfFilenameSupport {

    private static final int SUMMARY_WORDS = 8;
    private static final int SLUG_MAX_LEN = 80;
    private static final Pattern NON_ASCII_SLUG = Pattern.compile("[^a-z0-9]+");
    private static final Pattern MARKDOWN_FENCE = Pattern.compile("```[\\s\\S]*?```");
    private static final Pattern MARKDOWN_INLINE_CODE = Pattern.compile("`[^`]+`");
    private static final Pattern MARKDOWN_IMAGE = Pattern.compile("!\\[[^\\]]*\\]\\([^)]*\\)");
    private static final Pattern MARKDOWN_LINK = Pattern.compile("\\[([^\\]]*)\\]\\([^)]*\\)");
    private static final Pattern MARKDOWN_CHARS = Pattern.compile("[#*_~>|]");

    private AssistantPdfFilenameSupport() {}

    public static String buildFilename(List<AssistantPdfExportTurnDto> turns) {
        String ts =
                DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")
                        .withZone(ZoneId.systemDefault())
                        .format(Instant.now());
        String slug = questionSlugFromTurns(turns);
        if (slug != null && !slug.isBlank()) {
            return "pat-assistant-" + slug + "-" + ts + ".pdf";
        }
        return "pat-assistant-" + ts + ".pdf";
    }

    static String questionSlugFromTurns(List<AssistantPdfExportTurnDto> turns) {
        if (turns == null) {
            return "";
        }
        for (AssistantPdfExportTurnDto turn : turns) {
            if (turn == null || turn.content() == null || turn.content().isBlank()) {
                continue;
            }
            if (!"user".equals(turn.role())) {
                continue;
            }
            return slugFromPlainText(plainTextForSlug(turn.content()), SUMMARY_WORDS);
        }
        return "";
    }

    static String plainTextForSlug(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        String s = raw.trim();
        s = MARKDOWN_FENCE.matcher(s).replaceAll(" ");
        s = MARKDOWN_INLINE_CODE.matcher(s).replaceAll(" ");
        s = MARKDOWN_IMAGE.matcher(s).replaceAll(" ");
        s = MARKDOWN_LINK.matcher(s).replaceAll("$1");
        s = MARKDOWN_CHARS.matcher(s).replaceAll(" ");
        s = s.replaceAll("\\s+", " ").trim();
        return s;
    }

    static String slugFromPlainText(String plain, int maxWords) {
        if (plain == null || plain.isBlank() || maxWords <= 0) {
            return "";
        }
        String[] parts = plain.split("\\s+");
        StringBuilder sb = new StringBuilder();
        int count = 0;
        for (String part : parts) {
            if (part == null || part.isBlank()) {
                continue;
            }
            if (count > 0) {
                sb.append('-');
            }
            sb.append(part.trim());
            count++;
            if (count >= maxWords) {
                break;
            }
        }
        if (sb.isEmpty()) {
            return "";
        }
        String slug =
                Normalizer.normalize(sb.toString().toLowerCase(Locale.ROOT), Normalizer.Form.NFD)
                        .replaceAll("\\p{M}+", "");
        slug = NON_ASCII_SLUG.matcher(slug).replaceAll("-");
        slug = slug.replaceAll("-+", "-").replaceAll("^-|-$", "");
        if (slug.length() > SLUG_MAX_LEN) {
            slug = slug.substring(0, SLUG_MAX_LEN).replaceAll("-+$", "");
        }
        return slug;
    }
}
