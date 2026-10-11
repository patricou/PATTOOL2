package com.pat.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RichHtmlSanitizerTest {

    @Test
    void stripsScriptsAndKeepsQuillFormatting() {
        String cleaned = RichHtmlSanitizer.sanitizeStoredHtml(
                "<p><strong>ok</strong></p><script>alert(1)</script>"
                        + "<a href=\"javascript:alert(1)\">x</a>"
                        + "<img src=\"data:text/html,<script>alert(1)</script>\">");
        assertTrue(cleaned.contains("<strong>ok</strong>"));
        assertFalse(cleaned.toLowerCase().contains("<script"));
        assertFalse(cleaned.toLowerCase().contains("javascript:"));
        assertFalse(cleaned.toLowerCase().contains("data:text/html"));
    }
}
