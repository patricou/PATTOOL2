package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantToolFlagsDto;
import com.pat.controller.dto.AssistantTurnDto;
import com.pat.service.assistant.AssistantMessageSupport;
import com.pat.service.assistant.AssistantMessageSupport.DecodedImage;
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
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Assistant latéral via l’API Messages Anthropic (<a href="https://docs.anthropic.com/">docs</a>).
 * Pas d’équivalent à l’API Responses OpenAI (recherche web / image MCP côté serveur) :
 * désactivez ces options dans l’UI ou utilisez {@code assistant.provider=openai}.
 */
@Service
public class AnthropicAssistantService {

    private static final Logger log = LoggerFactory.getLogger(AnthropicAssistantService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${anthropic.key:}")
    private String apiKey;

    @Value("${anthropic.api:https://api.anthropic.com/v1/messages}")
    private String apiUrl;

    @Value("${anthropic.model:claude-sonnet-4-6}")
    private String model;

    @Value("${anthropic.max-tokens:8192}")
    private int maxTokens;

    @Value("${anthropic.provider-label:Anthropic}")
    private String assistantProviderLabel;

    @Value("${anthropic.version:2023-06-01}")
    private String anthropicVersion;

    public AnthropicAssistantService(
            @Qualifier("openAiRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    /** Valeur {@code anthropic.provider-label} pour l’UI (non sensible). */
    public String getConfiguredProviderLabel() {
        return assistantProviderLabel != null ? assistantProviderLabel.trim() : "";
    }

    /** Valeur {@code anthropic.model} pour l’UI (non sensible). */
    public String getConfiguredModel() {
        return model != null ? model.trim() : "";
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        if (apiKey == null || apiKey.isBlank()) {
            log.warn("Anthropic API key is not configured (anthropic.key).");
            return AssistantChatResponseDto.err(
                    "Assistant indisponible : configurez anthropic.key côté serveur.");
        }

        if (hasOpenAiOnlyTools(request)) {
            return AssistantChatResponseDto.err(
                    "La recherche web, la génération d’images pilotée par Responses et MCP ne sont disponibles "
                            + "qu’avec le fournisseur OpenAI (assistant.provider=openai). "
                            + "Décochez ces options ou basculez vers OpenAI.");
        }

        List<AssistantTurnDto> turns = AssistantMessageSupport.trimTurns(request.messages());
        if (turns.isEmpty()) {
            return AssistantChatResponseDto.err("Aucun message valide à envoyer.");
        }

        ResolvedImage resolved =
                AssistantMessageSupport.resolveAttachedImage(request.attachedImage(), turns);
        if (resolved.error() != null) {
            return AssistantChatResponseDto.err(resolved.error());
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

        List<Map<String, Object>> messages = new ArrayList<>();
        int lastIdx = turns.size() - 1;
        DecodedImage image = resolved.decoded();
        for (int i = 0; i < turns.size(); i++) {
            AssistantTurnDto t = turns.get(i);
            if (image != null
                    && image.bytes() != null
                    && i == lastIdx
                    && "user".equals(t.role())) {
                messages.add(Map.of("role", t.role(), "content", anthropicVisionBlocks(t.content(), image)));
            } else {
                messages.add(Map.of("role", t.role(), "content", t.content()));
            }
        }

        Map<String, Object> body = new HashMap<>();
        body.put("model", requestModel);
        body.put("max_tokens", maxTokens);
        body.put("messages", messages);
        if (request.system() != null && !request.system().isBlank()) {
            body.put("system", request.system().trim());
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("x-api-key", apiKey.trim());
        headers.set("anthropic-version", anthropicVersion != null ? anthropicVersion.trim() : "2023-06-01");

        try {
            long startNs = System.nanoTime();
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<String> response =
                    restTemplate.exchange(apiUrl.trim(), HttpMethod.POST, entity, String.class);
            int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            AssistantChatResponseDto parsed = parseAnthropicResponse(response.getBody(), requestModel);
            if (parsed.error() != null) {
                log.warn("Anthropic response carries error payload: {}", parsed.error());
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
            log.warn("Anthropic API error: {} — {}", e.getStatusCode(), e.getResponseBodyAsString());
            String hint = shortErrorHint(e.getResponseBodyAsString());
            return AssistantChatResponseDto.err(
                    "Erreur du fournisseur IA (" + e.getStatusCode().value() + ")"
                            + (hint != null ? ": " + hint : "."));
        } catch (ResourceAccessException e) {
            log.warn("Anthropic API I/O error: {}", e.getMessage());
            Throwable cause = e.getCause();
            if (cause instanceof java.net.SocketTimeoutException) {
                return AssistantChatResponseDto.err(
                        "Délai d’attente dépassé en lisant la réponse Anthropic. "
                                + "Augmentez openai.http.read-timeout-seconds si besoin. Réessayez.");
            }
            return AssistantChatResponseDto.err(
                    "Impossible de joindre le fournisseur IA (Anthropic). Réessayez plus tard.");
        } catch (Exception e) {
            log.error("Anthropic assistant request failed", e);
            return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant (Anthropic).");
        }
    }

    private List<Map<String, Object>> anthropicVisionBlocks(String userText, DecodedImage image) {
        Map<String, Object> imgBlock = new HashMap<>();
        imgBlock.put("type", "image");
        Map<String, Object> source = new HashMap<>();
        source.put("type", "base64");
        source.put("media_type", image.mediaType());
        source.put("data", Base64.getEncoder().encodeToString(image.bytes()));
        imgBlock.put("source", source);
        return List.of(
                imgBlock,
                Map.of(
                        "type",
                        "text",
                        "text",
                        userText != null ? userText : ""));
    }

    private static boolean hasOpenAiOnlyTools(AssistantChatRequestDto request) {
        AssistantToolFlagsDto t = request.tools();
        if (t == null) {
            return false;
        }
        return Boolean.TRUE.equals(t.webSearch())
                || Boolean.TRUE.equals(t.imageGeneration())
                || Boolean.TRUE.equals(t.mcp());
    }

    private String resolveRequestModel(AssistantChatRequestDto request) {
        if (request != null && request.model() != null && !request.model().isBlank()) {
            return request.model().trim();
        }
        return model != null ? model.trim() : "";
    }

    private AssistantChatResponseDto parseAnthropicResponse(String json, String modelFallback) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA (Anthropic).");
        }
        try {
            JsonNode root = objectMapper.readTree(json);

            JsonNode topErrType = root.get("type");
            if (topErrType != null && "error".equals(topErrType.asText())) {
                JsonNode err = root.get("error");
                String msg =
                        err != null && !err.isNull()
                                ? err.path("message").asText("Erreur Anthropic")
                                : "Erreur Anthropic";
                return AssistantChatResponseDto.err(msg);
            }

            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                String msg = err.path("message").asText("Erreur Anthropic");
                return AssistantChatResponseDto.err(msg);
            }

            JsonNode stopReason = root.get("stop_reason");

            String id = root.path("id").asText("");
            String modelUsed = root.path("model").asText(modelFallback);
            Integer inTok = null;
            Integer outTok = null;
            JsonNode usage = root.get("usage");
            if (usage != null && !usage.isNull()) {
                if (usage.has("input_tokens")) {
                    inTok = usage.get("input_tokens").asInt();
                }
                if (usage.has("output_tokens")) {
                    outTok = usage.get("output_tokens").asInt();
                }
            }

            StringBuilder text = new StringBuilder();
            JsonNode content = root.get("content");
            if (content != null && content.isArray()) {
                for (JsonNode block : content) {
                    String bType = block.path("type").asText("");
                    if ("text".equals(bType)) {
                        String txt = block.path("text").asText("");
                        if (!txt.isEmpty()) {
                            if (!text.isEmpty()) {
                                text.append("\n\n");
                            }
                            text.append(txt);
                        }
                    } else if ("tool_use".equals(bType)) {
                        String name = block.path("name").asText("outil");
                        String useId = block.path("id").asText("");
                        if (!text.isEmpty()) {
                            text.append("\n\n");
                        }
                        text.append("[Appel outil ").append(name);
                        if (!useId.isEmpty()) {
                            text.append(" ").append(useId);
                        }
                        text.append(" — non exécuté côté PatTool]");
                    }
                    //thinking, etc. : ignorés pour l’affichage brut
                }
            }

            if (text.isEmpty()) {
                String reason =
                        stopReason != null && !stopReason.isNull()
                                ? stopReason.asText("")
                                : "";
                if ("max_tokens".equals(reason)) {
                    return AssistantChatResponseDto.err(
                            "Réponse Anthropic vide (probable limite max_tokens="
                                    + maxTokens
                                    + "). Augmentez anthropic.max-tokens dans application.properties.");
                }
                return AssistantChatResponseDto.err(
                        "Réponse Anthropic sans texte exploitable"
                                + (reason.isEmpty() ? "." : " (stop_reason=" + reason + ")."));
            }

            String prov =
                    assistantProviderLabel != null && !assistantProviderLabel.isBlank()
                            ? assistantProviderLabel.trim()
                            : "Anthropic";
            AssistantChatResponseDto ok =
                    AssistantChatResponseDto.ok(
                            id,
                            modelUsed,
                            prov,
                            "assistant",
                            text.toString().trim(),
                            inTok,
                            outTok);
            return ok;
        } catch (Exception e) {
            log.warn("Failed to parse Anthropic JSON", e);
            return AssistantChatResponseDto.err(
                    "Impossible d’interpréter la réponse du fournisseur IA (Anthropic).");
        }
    }

    private String shortErrorHint(String responseBody) {
        if (responseBody == null || responseBody.length() > 2000) {
            return null;
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode errNode = root.get("error");
            if (errNode != null && errNode.has("message")) {
                return errNode.get("message").asText(null);
            }
            JsonNode errObj = root.path("error");
            if (!errObj.isMissingNode() && errObj.has("message")) {
                return errObj.get("message").asText(null);
            }
        } catch (Exception ignored) {
            // ignore
        }
        return null;
    }
}
