package com.pat.service;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AssistantModelsCatalogServiceTest {

    @Test
    void keepsNovember2026ChatIdsAndDropsRetiredAliases() {
        List<String> mistral =
                AssistantModelsCatalogService.retainCurrentAssistantModelIds(
                        "mistral",
                        List.of(
                                "mistral-large-latest",
                                "mistral-medium-3-5",
                                "mistral-medium",
                                "codestral-latest",
                                "codestral-2508",
                                "mistral-large-4",
                                "ministral-8b-2512"));
        assertEquals(List.of("codestral-2508", "mistral-large-4", "ministral-8b-2512"), mistral);

        assertTrue(
                AssistantModelsCatalogService.retainCurrentAssistantModelIds(
                                "anthropic", List.of("claude-fable-5-2", "claude-fable-5-1", "claude-opus-4-8"))
                        .contains("claude-fable-5-2"));
        assertFalse(
                AssistantModelsCatalogService.retainCurrentAssistantModelIds(
                                "anthropic", List.of("claude-fable-5-1"))
                        .contains("claude-fable-5-1"));
        assertEquals(
                List.of("gemini-4-carbon"),
                AssistantModelsCatalogService.retainCurrentAssistantModelIds(
                        "gemini", List.of("gemini-2.5-flash", "gemini-4-carbon", "gemini-3.8-flash-tts")));
        assertTrue(
                AssistantModelsCatalogService.retainCurrentAssistantModelIds("openai", List.of("gpt-6-astra"))
                        .contains("gpt-6-astra"));
        assertTrue(
                AssistantModelsCatalogService.retainCurrentAssistantModelIds("openai", List.of("gpt-6-cyber"))
                        .isEmpty());
        assertTrue(
                AssistantModelsCatalogService.retainCurrentAssistantModelIds("spacexai", List.of("grok-latest"))
                        .isEmpty());
        assertEquals(
                List.of("grok-4.7"),
                AssistantModelsCatalogService.retainCurrentAssistantModelIds("spacexai", List.of("grok-4.7")));
    }
}
