package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantPdfExportTurnDto(
        @NotBlank @Pattern(regexp = "user|assistant") String role,
        /** User plain text or assistant Markdown body. */
        @Size(max = 5_000_000) String content,
        Boolean hasImage,
        /** Image data URL ({@code data:image/...}), or null — used when {@link #embeddedImageDataUrls} is empty or absent. */
        @Size(max = 16_000_000) String imageDataUrl,
        /** Images embedded in the PDF ({@code data:image/...;base64,...}), order preserved. */
        List<String> embeddedImageDataUrls,
        /** Client-localized line (e.g. "Model: OpenAI · gpt-4o"). */
        @Size(max = 2000) String providerModelLine,
        /** Client-localized stats/tokens line. */
        @Size(max = 2000) String statsLine,
        /** When true, {@link #content} is Quill HTML (sanitized server-side) instead of plain text. */
        Boolean contentHtml) {}
