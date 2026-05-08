package com.pat.controller;

import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantClientConfigDto;
import com.pat.controller.dto.AssistantOpenAiCreditsDto;
import com.pat.controller.dto.AssistantRoutingPreferenceDto;
import com.pat.service.AssistantRoutingPreferenceService;
import com.pat.service.OpenAiBillingService;
import com.pat.service.RoutingAssistantService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
@Validated
public class AssistantController {

    private final RoutingAssistantService routingAssistantService;
    private final OpenAiBillingService openAiBillingService;
    private final AssistantRoutingPreferenceService assistantRoutingPreferenceService;

    public AssistantController(
            RoutingAssistantService routingAssistantService,
            OpenAiBillingService openAiBillingService,
            AssistantRoutingPreferenceService assistantRoutingPreferenceService) {
        this.routingAssistantService = routingAssistantService;
        this.openAiBillingService = openAiBillingService;
        this.assistantRoutingPreferenceService = assistantRoutingPreferenceService;
    }

    /**
     * Fournisseur et modèle configurés pour l’UI (OpenAI : {@code openai.provider} / {@code openai.assistant.model},
     * Anthropic : {@code anthropic.provider-label} / {@code anthropic.model}).
     */
    @GetMapping("/assistant/config")
    public ResponseEntity<AssistantClientConfigDto> assistantClientConfig() {
        String p = routingAssistantService.getConfiguredProviderLabel();
        String m = routingAssistantService.getConfiguredModel();
        String routing = routingAssistantService.getConfiguredRoutingSlug();
        String sub = currentJwtSubject();
        AssistantRoutingPreferenceDto persisted =
                sub != null
                        ? assistantRoutingPreferenceService.findForSubject(sub).orElse(null)
                        : null;
        return ResponseEntity.ok(new AssistantClientConfigDto(
                p.isEmpty() ? null : p,
                m.isEmpty() ? null : m,
                routing.isEmpty() ? null : routing,
                persisted));
    }

    /**
     * Enregistre le fournisseur et le modèle choisis dans l'assistant (collection {@code appParameters},
     * clé {@code assistant.routing.<sub JWT>}).
     */
    @PutMapping("/assistant/routing-preference")
    public ResponseEntity<Void> saveRoutingPreference(@RequestBody @Valid AssistantRoutingPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        assistantRoutingPreferenceService.saveForSubject(sub, body);
        return ResponseEntity.noContent().build();
    }

    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt.getSubject();
    }

    /**
     * Assistant latéral multi-tours : OpenAI (Chat Completions / Responses) ou Anthropic (Messages)
     * selon {@code assistant.provider}.
     */
    @PostMapping("/assistant/chat")
    public ResponseEntity<AssistantChatResponseDto> chat(@RequestBody @Valid AssistantChatRequestDto body) {
        AssistantChatResponseDto result = routingAssistantService.complete(body);
        if (result.error() != null) {
            boolean configMissingKey =
                    result.error().contains("openai.key")
                            || result.error().contains("configurez openai.key")
                            || result.error().contains("anthropic.key")
                            || result.error().contains("configurez anthropic.key");
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
