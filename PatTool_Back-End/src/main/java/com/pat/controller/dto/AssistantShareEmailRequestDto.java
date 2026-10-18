package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Body for {@code POST /api/assistant/share-email}: recipients (current user or friends only), optional
 * message, and the conversation in the same shape as the PDF export.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AssistantShareEmailRequestDto(
        @NotEmpty @Size(max = 50) List<String> toMemberIds,
        @Size(max = 4000) String customMessage,
        @Size(max = 10) String mailLang,
        Boolean attachPdf,
        @NotNull @Valid AssistantPdfExportRequestDto conversation) {}
