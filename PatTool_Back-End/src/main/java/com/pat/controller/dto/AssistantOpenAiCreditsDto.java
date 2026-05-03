package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Synthèse des crédits API OpenAI ({@code dashboard/billing/credit_grants}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AssistantOpenAiCreditsDto(
        boolean ok,
        Double totalAvailableUsd,
        Double totalGrantedUsd,
        Double totalUsedUsd,
        String message
) {

    public static AssistantOpenAiCreditsDto success(Double available, Double granted, Double used) {
        return new AssistantOpenAiCreditsDto(true, available, granted, used, null);
    }

    public static AssistantOpenAiCreditsDto failure(String message) {
        return new AssistantOpenAiCreditsDto(false, null, null, null, message);
    }
}
