package com.pat.controller;

import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantClientConfigDto;
import com.pat.controller.dto.AssistantOpenAiCreditsDto;
import com.pat.service.OpenAiAssistantService;
import com.pat.service.OpenAiBillingService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
@Validated
public class AssistantController {

    private final OpenAiAssistantService openAiAssistantService;
    private final OpenAiBillingService openAiBillingService;

    public AssistantController(
            OpenAiAssistantService openAiAssistantService,
            OpenAiBillingService openAiBillingService) {
        this.openAiAssistantService = openAiAssistantService;
        this.openAiBillingService = openAiBillingService;
    }

    /**
     * Fournisseur et modèle configurés ({@code openai.provider}, {@code openai.assistant.model}) pour l’affichage dans l’UI.
     */
    @GetMapping("/assistant/config")
    public ResponseEntity<AssistantClientConfigDto> assistantClientConfig() {
        String p = openAiAssistantService.getConfiguredProviderLabel();
        String m = openAiAssistantService.getConfiguredModel();
        return ResponseEntity.ok(new AssistantClientConfigDto(
                p.isEmpty() ? null : p,
                m.isEmpty() ? null : m));
    }

    /**
     * Assistant latéral multi-tours (OpenAI Chat Completions). Même clé {@code openai.key} que PatGPT.
     */
    @PostMapping("/assistant/chat")
    public ResponseEntity<AssistantChatResponseDto> chat(@RequestBody @Valid AssistantChatRequestDto body) {
        AssistantChatResponseDto result = openAiAssistantService.complete(body);
        if (result.error() != null) {
            boolean configMissingKey =
                    result.error().contains("openai.key")
                            || result.error().contains("configurez openai.key");
            HttpStatus status = configMissingKey ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY;
            return ResponseEntity.status(status).body(result);
        }
        return ResponseEntity.ok(result);
    }

    /**
     * Solde crédits API (prépayé) si exposé par OpenAI pour la clé {@code openai.key}.
     */
    @GetMapping("/assistant/openai/credits")
    public ResponseEntity<AssistantOpenAiCreditsDto> openAiCredits() {
        return ResponseEntity.ok(openAiBillingService.fetchCreditsSummary());
    }
}
