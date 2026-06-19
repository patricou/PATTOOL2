package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantToolFlagsDto;
import com.pat.controller.dto.AssistantTurnDto;
import com.pat.service.assistant.AssistantHttpErrorParser;
import com.pat.service.assistant.AssistantMessageSupport;
import com.pat.service.assistant.AssistantMessageSupport.ResolvedImage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Assistant via l’API Mistral Chat Completions (<a href="https://docs.mistral.ai/">docs</a>),
 * compatible OpenAI. Recherche web : outil {@code web_search}. MCP et génération d’images
 * type Responses restent réservés au fournisseur OpenAI.
 */
@Service
public class MistralAssistantService {

    private static final Logger log = LoggerFactory.getLogger(MistralAssistantService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${mistral.key:}")
    private String apiKey;

    @Value("${mistral.api:https://api.mistral.ai/v1/chat/completions}")
    private String apiUrl;

    @Value("${mistral.model:mistral-large-latest}")
    private String model;

    @Value("${mistral.max-tokens:8192}")
    private int maxTokens;

    @Value("${mistral.provider-label:Mistral}")
    private String assistantProviderLabel;

    public MistralAssistantService(
            @Qualifier("mistralRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    /** Valeur {@code mistral.provider-label} pour l’UI (non sensible). */
    public String getConfiguredProviderLabel() {
        return assistantProviderLabel != null ? assistantProviderLabel.trim() : "";
    }

    /** Valeur {@code mistral.model} pour l’UI (non sensible). */
    public String getConfiguredModel() {
        return model != null ? model.trim() : "";
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        if (apiKey == null || apiKey.isBlank()) {
            log.error("Mistral API key is not configured (mistral.key).");
            return AssistantChatResponseDto.err(
                    "Assistant indisponible : configurez mistral.key côté serveur.");
        }

        AssistantToolFlagsDto tf = request.tools();
        if (tf != null && Boolean.TRUE.equals(tf.mcp())) {
            return AssistantChatResponseDto.err(
                    "L’accès MCP (API Responses OpenAI) n’est disponible qu’avec le fournisseur OpenAI "
                            + "(assistant.provider=openai). Décochez MCP ou changez de fournisseur.");
        }
        if (tf != null && Boolean.TRUE.equals(tf.imageGeneration())) {
            return AssistantChatResponseDto.err(
                    "La génération d’images pilotée par PatTool (API Responses) n’est pas disponible "
                            + "avec Mistral. Utilisez OpenAI ou Gemini, ou décochez l’option.");
        }

        List<AssistantTurnDto> turns = AssistantMessageSupport.trimTurns(request.messages());
        if (turns.isEmpty()) {
            return AssistantChatResponseDto.err("Aucun message valide à envoyer.");
        }

        ResolvedImage imageAttach =
                AssistantMessageSupport.resolveAttachedImage(request.attachedImage(), turns);
        if (imageAttach.error() != null) {
            return AssistantChatResponseDto.err(imageAttach.error());
        }

        long totalChars = turns.stream().mapToLong(t -> t.content() != null ? t.content().length() : 0).sum();
        if (request.system() != null && !request.system().isBlank()) {
            totalChars += request.system().trim().length();
        }
        if (totalChars > AssistantMessageSupport.MAX_CONTENT_CHARS) {
            return AssistantChatResponseDto.err(
                    "Conversation trop longue pour un seul envoi. Effacez l’historique ou raccourcissez les messages.");
        }

        String requestModel = resolveRequestModel(request);

        List<Object> chatMessages = new ArrayList<>();
        if (request.system() != null && !request.system().isBlank()) {
            chatMessages.add(Map.of("role", "system", "content", request.system().trim()));
        }
        int lastIdx = turns.size() - 1;
        for (int i = 0; i < turns.size(); i++) {
            AssistantTurnDto t = turns.get(i);
            if (imageAttach.dataUrl() != null && i == lastIdx && "user".equals(t.role())) {
                List<Map<String, Object>> parts = new ArrayList<>();
                parts.add(Map.of("type", "text", "text", t.content()));
                parts.add(
                        Map.of(
                                "type",
                                "image_url",
                                "image_url",
                                Map.of("url", imageAttach.dataUrl())));
                Map<String, Object> msg = new HashMap<>();
                msg.put("role", "user");
                msg.put("content", parts);
                chatMessages.add(msg);
            } else {
                chatMessages.add(Map.of("role", t.role(), "content", t.content()));
            }
        }

        Map<String, Object> body = new HashMap<>();
        body.put("model", requestModel);
        body.put("messages", chatMessages);
        body.put("max_tokens", maxTokens);

        if (tf != null && Boolean.TRUE.equals(tf.webSearch())) {
            body.put("tools", List.of(Map.of("type", "web_search")));
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(apiKey.trim());

        try {
            long startNs = System.nanoTime();
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<String> response =
                    restTemplate.exchange(apiUrl.trim(), HttpMethod.POST, entity, String.class);
            int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            AssistantChatResponseDto parsed = parseChatCompletionsResponse(response.getBody(), requestModel);
            if (parsed.error() != null) {
                log.debug("Mistral response carries error payload: {}", parsed.error());
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
            log.debug("Mistral API error: {} — {}", e.getStatusCode(), e.getResponseBodyAsString());
            String msg = AssistantHttpErrorParser.providerMessageOrNull(objectMapper, e.getResponseBodyAsString());
            if (msg != null && !msg.isBlank()) {
                return AssistantChatResponseDto.err(msg);
            }
            return AssistantChatResponseDto.err(
                    "Erreur du fournisseur IA (" + e.getStatusCode().value() + ").");
        } catch (ResourceAccessException e) {
            log.debug("Mistral API I/O error: {}", e.getMessage());
            Throwable cause = e.getCause();
            if (cause instanceof java.net.SocketTimeoutException) {
                return AssistantChatResponseDto.err(
                        "Délai d’attente dépassé en lisant la réponse Mistral. "
                                + "Augmentez mistral.http.read-timeout-seconds si besoin. Réessayez.");
            }
            return AssistantChatResponseDto.err(
                    "Impossible de joindre le fournisseur IA (Mistral). Réessayez plus tard.");
        } catch (Exception e) {
            log.error("Mistral assistant request failed", e);
            return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant (Mistral).");
        }
    }

    private String resolveRequestModel(AssistantChatRequestDto request) {
        if (request != null && request.model() != null && !request.model().isBlank()) {
            return request.model().trim();
        }
        return model != null ? model.trim() : "";
    }

    private AssistantChatResponseDto parseChatCompletionsResponse(String json, String modelFallback) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA (Mistral).");
        }
        try {
            JsonNode root = objectMapper.readTree(json);

            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                String msg = err.path("message").asText("Erreur Mistral");
                return AssistantChatResponseDto.err(msg);
            }

            JsonNode choices = root.get("choices");
            if (choices == null || !choices.isArray() || choices.isEmpty()) {
                return AssistantChatResponseDto.err("Réponse Mistral sans contenu exploitable.");
            }

            JsonNode message = choices.get(0).path("message");
            String role = message.path("role").asText("assistant");
            String content = extractChatCompletionsAssistantText(message);
            if (content.isBlank() && !choices.get(0).path("text").asText("").isBlank()) {
                content = choices.get(0).path("text").asText("").trim();
            }

            String id = root.path("id").asText("");
            String modelUsed = root.path("model").asText(modelFallback);
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

            String prov =
                    assistantProviderLabel != null && !assistantProviderLabel.isBlank()
                            ? assistantProviderLabel.trim()
                            : "Mistral";
            return AssistantChatResponseDto.ok(
                    id, modelUsed, prov, role, content, inTok, outTok);
        } catch (Exception e) {
            log.error("Failed to parse Mistral JSON", e);
            return AssistantChatResponseDto.err(
                    "Impossible d’interpréter la réponse du fournisseur IA (Mistral).");
        }
    }

    private static String extractChatCompletionsAssistantText(JsonNode message) {
        if (message == null || message.isNull()) {
            return "";
        }
        JsonNode contentNode = message.get("content");
        if (contentNode == null || contentNode.isNull()) {
            return "";
        }
        if (contentNode.isTextual()) {
            return contentNode.asText("");
        }
        if (contentNode.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode part : contentNode) {
                String t = part.path("text").asText("").trim();
                if (t.isEmpty()) {
                    t = part.asText("").trim();
                }
                if (t.isEmpty()) {
                    continue;
                }
                if (!sb.isEmpty()) {
                    sb.append("\n\n");
                }
                sb.append(t);
            }
            return sb.toString();
        }
        return contentNode.asText("");
    }
}
