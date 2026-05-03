package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantTurnDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class OpenAiAssistantService {

    private static final Logger log = LoggerFactory.getLogger(OpenAiAssistantService.class);

    private static final int MAX_TURNS = 40;
    private static final int MAX_CONTENT_CHARS = 120_000;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${openai.key:}")
    private String apiKey;

    @Value("${openai.api}")
    private String apiUrl;

    @Value("${openai.assistant.model}")
    private String model;

    @Value("${openai.assistant.max-tokens}")
    private int maxTokens;

    @Value("${openai.provider:OpenAI}")
    private String assistantProviderLabel;

    public OpenAiAssistantService(
            @Qualifier("openAiRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    /** Valeur {@code openai.provider} pour l’UI (non sensible). */
    public String getConfiguredProviderLabel() {
        return assistantProviderLabel != null ? assistantProviderLabel.trim() : "";
    }

    /** Valeur {@code openai.assistant.model} pour l’UI (non sensible). */
    public String getConfiguredModel() {
        return model != null ? model.trim() : "";
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        if (apiKey == null || apiKey.isBlank()) {
            log.warn("OpenAI API key is not configured for assistant (openai.key).");
            return AssistantChatResponseDto.err(
                    "Assistant indisponible : configurez openai.key côté serveur (même clé que PatGPT si besoin).");
        }

        List<AssistantTurnDto> turns = trimTurns(request.messages());
        if (turns.isEmpty()) {
            return AssistantChatResponseDto.err("Aucun message valide à envoyer.");
        }

        long totalChars = turns.stream().mapToLong(t -> t.content() != null ? t.content().length() : 0).sum();
        if (request.system() != null && !request.system().isBlank()) {
            totalChars += request.system().trim().length();
        }
        if (totalChars > MAX_CONTENT_CHARS) {
            return AssistantChatResponseDto.err(
                    "Conversation trop longue pour un seul envoi. Effacez l’historique ou raccourcissez les messages.");
        }

        List<Map<String, String>> chatMessages = new ArrayList<>();
        if (request.system() != null && !request.system().isBlank()) {
            chatMessages.add(Map.of("role", "system", "content", request.system().trim()));
        }
        for (AssistantTurnDto t : turns) {
            chatMessages.add(Map.of("role", t.role(), "content", t.content()));
        }

        Map<String, Object> body = new HashMap<>();
        body.put("model", model);
        body.put("messages", chatMessages);
        body.put("max_completion_tokens", maxTokens);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(apiKey.trim());

        try {
            long startNs = System.nanoTime();
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<String> response =
                    restTemplate.exchange(apiUrl, HttpMethod.POST, entity, String.class);
            int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            AssistantChatResponseDto parsed = parseOpenAiResponse(response.getBody());
            if (parsed.error() != null) {
                log.warn("OpenAI response carries error payload: {}", parsed.error());
                return AssistantChatResponseDto.err(parsed.error());
            }
            return AssistantChatResponseDto.okTimed(
                    parsed.id(),
                    parsed.model(),
                    parsed.provider(),
                    parsed.role(),
                    parsed.content(),
                    parsed.inputTokens(),
                    parsed.outputTokens(),
                    elapsedMs);
        } catch (HttpStatusCodeException e) {
            log.warn("OpenAI API error: {} — {}", e.getStatusCode(), e.getResponseBodyAsString());
            String hint = shortErrorHint(e.getResponseBodyAsString());
            return AssistantChatResponseDto.err(
                    "Erreur du fournisseur IA (" + e.getStatusCode().value() + ")"
                            + (hint != null ? ": " + hint : "."));
        } catch (ResourceAccessException e) {
            log.warn("OpenAI API I/O error: {}", e.getMessage());
            Throwable cause = e.getCause();
            if (cause instanceof java.net.SocketTimeoutException) {
                return AssistantChatResponseDto.err(
                        "Délai d’attente dépassé en lisant la réponse du fournisseur IA. "
                                + "Les modèles lents peuvent nécessiter d’augmenter openai.http.read-timeout-seconds "
                                + "(valeur actuelle en secondes dans application.properties). Réessayez.");
            }
            return AssistantChatResponseDto.err(
                    "Impossible de joindre le fournisseur IA (réseau ou coupure). Réessayez plus tard.");
        } catch (Exception e) {
            log.error("OpenAI assistant request failed", e);
            return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant.");
        }
    }

    private static List<AssistantTurnDto> trimTurns(List<AssistantTurnDto> messages) {
        List<AssistantTurnDto> out = new ArrayList<>();
        int from = Math.max(0, messages.size() - MAX_TURNS);
        for (int i = from; i < messages.size(); i++) {
            AssistantTurnDto t = messages.get(i);
            if (t == null || t.role() == null || t.content() == null) {
                continue;
            }
            String role = t.role().trim().toLowerCase();
            if (!"user".equals(role) && !"assistant".equals(role)) {
                continue;
            }
            String content = t.content().trim();
            if (content.isEmpty()) {
                continue;
            }
            out.add(new AssistantTurnDto(role, content));
        }
        return out;
    }

    private AssistantChatResponseDto parseOpenAiResponse(String json) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA.");
        }
        try {
            JsonNode root = objectMapper.readTree(json);

            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                String msg = err.path("message").asText("Erreur OpenAI");
                return AssistantChatResponseDto.err(msg);
            }

            JsonNode choices = root.get("choices");
            if (choices == null || !choices.isArray() || choices.size() == 0) {
                return AssistantChatResponseDto.err("Réponse OpenAI sans contenu exploitable.");
            }

            JsonNode message = choices.get(0).path("message");
            String role = message.path("role").asText("assistant");
            String content = message.path("content").asText("");

            String id = root.path("id").asText("");
            String modelUsed = root.path("model").asText(model);
            Integer inTok = null;
            Integer outTok = null;
            JsonNode usage = root.get("usage");
            if (usage != null && !usage.isNull()) {
                if (usage.has("prompt_tokens")) {
                    inTok = usage.get("prompt_tokens").asInt();
                }
                if (usage.has("completion_tokens")) {
                    outTok = usage.get("completion_tokens").asInt();
                }
            }

            return AssistantChatResponseDto.ok(
                    id,
                    modelUsed,
                    assistantProviderLabel != null && !assistantProviderLabel.isBlank()
                            ? assistantProviderLabel.trim()
                            : "OpenAI",
                    role,
                    content,
                    inTok,
                    outTok);
        } catch (Exception e) {
            log.warn("Failed to parse OpenAI JSON", e);
            return AssistantChatResponseDto.err("Impossible d’interpréter la réponse du fournisseur IA.");
        }
    }

    private String shortErrorHint(String responseBody) {
        if (responseBody == null || responseBody.length() > 2000) {
            return null;
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode err = root.get("error");
            if (err != null && err.has("message")) {
                return err.get("message").asText(null);
            }
        } catch (Exception ignored) {
            // ignore
        }
        return null;
    }
}
