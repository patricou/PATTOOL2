package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantPdfExportTurnDto(
        @NotBlank @Pattern(regexp = "user|assistant") String role,
        /** Texte utilisateur ou équivalent Markdown pour une réponse assistant. */
        @Size(max = 500_000) String content,
        Boolean hasImage,
        /** Data URL image (data:image/...), ou null — utilisé si {@link #embeddedImageDataUrls} est vide / absent. */
        @Size(max = 16_000_000) String imageDataUrl,
        /** Images à intégrer au PDF (data:image/...;base64,...), ordre conservé. */
        List<String> embeddedImageDataUrls,
        /** Ligne déjà localisée côté client (ex. « Modèle : OpenAI · gpt-4o »). */
        @Size(max = 2000) String providerModelLine,
        /** Ligne stats/jetons déjà localisée côté client. */
        @Size(max = 2000) String statsLine) {}
