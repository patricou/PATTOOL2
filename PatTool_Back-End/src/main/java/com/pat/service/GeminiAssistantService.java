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
import org.springframework.web.util.UriComponentsBuilder;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Assistant via l’API REST {@code generateContent} de Google Gemini
 * (<a href="https://ai.google.dev/api/rest">docs</a>).
 * Pas d’équivalent Responses (recherche web / MCP côté serveur OpenAI) : désactivez ces options ou
 * utilisez {@code assistant.provider=openai}.
 */
@Service
public class GeminiAssistantService {

    private static final Logger log = LoggerFactory.getLogger(GeminiAssistantService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${gemini.key:}")
    private String apiKey;

    @Value("${gemini.api:https://generativelanguage.googleapis.com/v1beta}")
    private String apiBase;

    @Value("${gemini.model:gemini-2.0-flash}")
    private String model;

    @Value("${gemini.max-output-tokens:8192}")
    private int maxOutputTokens;

    @Value("${gemini.provider-label:Google}")
    private String assistantProviderLabel;

    public GeminiAssistantService(
            @Qualifier("openAiRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    /** {@code gemini.provider-label} pour l’UI (non sensible). */
    public String getConfiguredProviderLabel() {
        return assistantProviderLabel != null ? assistantProviderLabel.trim() : "";
    }

    /** {@code gemini.model} pour l’UI (non sensible). */
    public String getConfiguredModel() {
        return model != null ? model.trim() : "";
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        if (apiKey == null || apiKey.isBlank()) {
            log.warn("Gemini API key is not configured (gemini.key).");
            return AssistantChatResponseDto.err(
                    "Assistant indisponible : configurez gemini.key côté serveur.");
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
        String url = buildGenerateContentUrl(requestModel);

        List<Map<String, Object>> contents = new ArrayList<>();
        int lastIdx = turns.size() - 1;
        DecodedImage image = resolved.decoded();
        for (int i = 0; i < turns.size(); i++) {
            AssistantTurnDto t = turns.get(i);
            String gemRole = "assistant".equals(t.role()) ? "model" : "user";
            if (image != null
                    && image.bytes() != null
                    && i == lastIdx
                    && "user".equals(t.role())) {
                contents.add(Map.of("role", gemRole, "parts", geminiVisionParts(t.content(), image)));
            } else {
                contents.add(
                        Map.of(
                                "role",
                                gemRole,
                                "parts",
                                List.of(Map.of("text", t.content() != null ? t.content() : ""))));
            }
        }

        Map<String, Object> body = new HashMap<>();
        body.put("contents", contents);
        if (request.system() != null && !request.system().isBlank()) {
            body.put(
                    "system_instruction",
                    Map.of("parts", List.of(Map.of("text", request.system().trim()))));
        }
        Map<String, Object> genCfg = new HashMap<>();
        genCfg.put("maxOutputTokens", maxOutputTokens);
        body.put("generationConfig", genCfg);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        try {
            long startNs = System.nanoTime();
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<String> response =
                    restTemplate.exchange(url, HttpMethod.POST, entity, String.class);
            int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            AssistantChatResponseDto parsed = parseGeminiResponse(response.getBody(), requestModel);
            if (parsed.error() != null) {
                log.warn("Gemini response carries error payload: {}", parsed.error());
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
            log.warn("Gemini API error: {} — {}", e.getStatusCode(), e.getResponseBodyAsString());
            String hint = shortErrorHint(e.getResponseBodyAsString());
            return AssistantChatResponseDto.err(
                    "Erreur du fournisseur IA (" + e.getStatusCode().value() + ")"
                            + (hint != null ? ": " + hint : "."));
        } catch (ResourceAccessException e) {
            log.warn("Gemini API I/O error: {}", e.getMessage());
            Throwable cause = e.getCause();
            if (cause instanceof java.net.SocketTimeoutException) {
                return AssistantChatResponseDto.err(
                        "Délai d’attente dépassé en lisant la réponse Gemini. "
                                + "Augmentez openai.http.read-timeout-seconds si besoin. Réessayez.");
            }
            return AssistantChatResponseDto.err(
                    "Impossible de joindre le fournisseur IA (Gemini). Réessayez plus tard.");
        } catch (Exception e) {
            log.error("Gemini assistant request failed", e);
            return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant (Gemini).");
        }
    }

    private String buildGenerateContentUrl(String modelId) {
        String base = apiBase != null ? apiBase.trim() : "https://generativelanguage.googleapis.com/v1beta";
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        String mid = modelId != null ? modelId.trim() : "gemini-2.0-flash";
        return UriComponentsBuilder.fromUriString(base + "/models/" + mid + ":generateContent")
                .queryParam("key", apiKey.trim())
                .encode()
                .build()
                .toUriString();
    }

    private List<Map<String, Object>> geminiVisionParts(String userText, DecodedImage image) {
        List<Map<String, Object>> parts = new ArrayList<>();
        Map<String, Object> blob = new HashMap<>();
        blob.put("mime_type", image.mediaType());
        blob.put("data", java.util.Base64.getEncoder().encodeToString(image.bytes()));
        parts.add(Map.of("inline_data", blob));
        parts.add(Map.of("text", userText != null ? userText : ""));
        return parts;
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

    private AssistantChatResponseDto parseGeminiResponse(String json, String modelFallback) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA (Gemini).");
        }
        try {
            JsonNode root = objectMapper.readTree(json);

            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                String msg = err.path("message").asText("Erreur Gemini");
                return AssistantChatResponseDto.err(msg);
            }

            JsonNode promptFb = root.get("promptFeedback");
            if (promptFb != null && !promptFb.isNull()) {
                String block = promptFb.path("blockReason").asText("");
                if (block != null && !block.isBlank() && !"BLOCK_REASON_UNSPECIFIED".equals(block)) {
                    return AssistantChatResponseDto.err(
                            "Requête Gemini bloquée (promptFeedback=" + block + ").");
                }
            }

            JsonNode cands = root.get("candidates");
            if (cands == null || !cands.isArray() || cands.isEmpty()) {
                return AssistantChatResponseDto.err(
                        "Réponse Gemini sans candidat (contenu filtré ou quota dépassé).");
            }

            JsonNode first = cands.get(0);
            String finish = first.path("finishReason").asText("");
            if ("SAFETY".equals(finish) || "BLOCKLIST".equals(finish)) {
                return AssistantChatResponseDto.err(
                        "Réponse Gemini bloquée pour raisons de sécurité (finishReason=" + finish + ").");
            }

            Integer inTok = null;
            Integer outTok = null;
            JsonNode usage = root.get("usageMetadata");
            if (usage != null && !usage.isNull()) {
                if (usage.has("promptTokenCount")) {
                    inTok = usage.get("promptTokenCount").asInt();
                }
                if (usage.has("candidatesTokenCount")) {
                    outTok = usage.get("candidatesTokenCount").asInt();
                }
            }

            StringBuilder text = new StringBuilder();
            JsonNode content = first.get("content");
            JsonNode parts = content != null ? content.get("parts") : null;
            if (parts != null && parts.isArray()) {
                for (JsonNode part : parts) {
                    if (part.has("text")) {
                        String txt = part.path("text").asText("");
                        if (!txt.isEmpty()) {
                            if (!text.isEmpty()) {
                                text.append("\n\n");
                            }
                            text.append(txt);
                        }
                    }
                }
            }

            if (text.isEmpty()) {
                if ("MAX_TOKENS".equals(finish) || "OTHER".equals(finish)) {
                    return AssistantChatResponseDto.err(
                            "Réponse Gemini vide ou tronquée (finishReason="
                                    + finish
                                    + "). Augmentez gemini.max-output-tokens si besoin.");
                }
                return AssistantChatResponseDto.err(
                        "Réponse Gemini sans texte exploitable"
                                + (finish.isEmpty() ? "." : " (finishReason=" + finish + ")."));
            }

            String prov =
                    assistantProviderLabel != null && !assistantProviderLabel.isBlank()
                            ? assistantProviderLabel.trim()
                            : "Google";
            String modelUsed = modelFallback;
            return AssistantChatResponseDto.ok(
                    /* id */ "",
                    modelUsed,
                    prov,
                    "assistant",
                    text.toString().trim(),
                    inTok,
                    outTok);
        } catch (Exception e) {
            log.warn("Failed to parse Gemini JSON", e);
            return AssistantChatResponseDto.err(
                    "Impossible d’interpréter la réponse du fournisseur IA (Gemini).");
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
