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
import org.springframework.web.util.UriComponentsBuilder;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Assistant via l’API Mistral Chat Completions (<a href="https://docs.mistral.ai/">docs</a>),
 * compatible OpenAI. Recherche web : API {@code /v1/conversations} avec l’outil {@code web_search}
 * (non supporté sur {@code /v1/chat/completions}, qui n’accepte que les outils {@code function}).
 * MCP et génération d’images type Responses restent réservés au fournisseur OpenAI.
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
        if (requestModel.isBlank()) {
            return AssistantChatResponseDto.err(
                    "Modèle Mistral non configuré. Renseignez mistral.model côté serveur ou choisissez un modèle.");
        }

        if (imageAttach.dataUrl() != null && !isMistralVisionModel(requestModel)) {
            return AssistantChatResponseDto.err(
                    "Ce modèle Mistral ne prend pas en charge l’analyse d’images. "
                            + "Choisissez pixtral-large-latest (ou un modèle Pixtral).");
        }

        boolean wantWeb = tf != null && Boolean.TRUE.equals(tf.webSearch());
        if (wantWeb) {
            return completeWithConversations(request, turns, imageAttach, requestModel);
        }

        List<Object> chatMessages = buildChatCompletionMessages(turns, imageAttach, request.system());
        Map<String, Object> body = new HashMap<>();
        body.put("model", requestModel);
        body.put("messages", chatMessages);
        body.put("max_tokens", maxTokens);

        return postMistralJson(
                apiUrl.trim(),
                body,
                requestModel,
                (json, modelFallback, elapsedMs) -> {
                    AssistantChatResponseDto parsed = parseChatCompletionsResponse(json, modelFallback);
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
                });
    }

    /**
     * Recherche web Mistral : {@code POST /v1/conversations} (built-in {@code web_search}).
     * {@code /v1/chat/completions} n’accepte que les outils {@code function} → 400 si {@code web_search}.
     */
    private AssistantChatResponseDto completeWithConversations(
            AssistantChatRequestDto request,
            List<AssistantTurnDto> turns,
            ResolvedImage imageAttach,
            String requestModel) {
        List<Object> inputs = buildConversationInputs(turns, imageAttach);
        Map<String, Object> body = new HashMap<>();
        body.put("model", requestModel);
        body.put("inputs", inputs);
        body.put("tools", List.of(Map.of("type", "web_search")));
        body.put("completion_args", Map.of("max_tokens", maxTokens));
        if (request.system() != null && !request.system().isBlank()) {
            body.put("instructions", request.system().trim());
        }

        return postMistralJson(
                resolveConversationsApiUrl(),
                body,
                requestModel,
                (json, modelFallback, elapsedMs) -> {
                    AssistantChatResponseDto parsed = parseConversationsResponse(json, modelFallback);
                    if (parsed.error() != null) {
                        log.debug("Mistral conversations response carries error payload: {}", parsed.error());
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
                });
    }

    @FunctionalInterface
    private interface MistralResponseParser {
        AssistantChatResponseDto parse(String json, String modelFallback, int elapsedMs);
    }

    private AssistantChatResponseDto postMistralJson(
            String url, Map<String, Object> body, String modelFallback, MistralResponseParser parser) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(apiKey.trim());

        try {
            long startNs = System.nanoTime();
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<String> response =
                    restTemplate.exchange(url, HttpMethod.POST, entity, String.class);
            int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            return parser.parse(response.getBody(), modelFallback, elapsedMs);
        } catch (HttpStatusCodeException e) {
            log.warn("Mistral API error: {} — {}", e.getStatusCode(), shorten(e.getResponseBodyAsString(), 800));
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

    private static String shorten(String s, int max) {
        if (s == null) {
            return "";
        }
        if (s.length() <= max) {
            return s;
        }
        return s.substring(0, max) + "…";
    }

    private List<Object> buildChatCompletionMessages(
            List<AssistantTurnDto> turns, ResolvedImage imageAttach, String system) {
        List<Object> chatMessages = new ArrayList<>();
        if (system != null && !system.isBlank()) {
            chatMessages.add(Map.of("role", "system", "content", system.trim()));
        }
        appendTurnMessages(chatMessages, turns, imageAttach, false);
        return chatMessages;
    }

    private List<Object> buildConversationInputs(List<AssistantTurnDto> turns, ResolvedImage imageAttach) {
        List<Object> inputs = new ArrayList<>();
        appendTurnMessages(inputs, turns, imageAttach, true);
        return inputs;
    }

    private void appendTurnMessages(
            List<Object> out,
            List<AssistantTurnDto> turns,
            ResolvedImage imageAttach,
            boolean conversationApi) {
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
                out.add(msg);
            } else if (conversationApi && "assistant".equals(t.role())) {
                out.add(Map.of("role", "assistant", "content", t.content()));
            } else {
                out.add(Map.of("role", t.role(), "content", t.content()));
            }
        }
    }

    private static boolean isMistralVisionModel(String modelId) {
        if (modelId == null || modelId.isBlank()) {
            return false;
        }
        String s = modelId.trim().toLowerCase(Locale.ROOT);
        return s.startsWith("pixtral-") || s.contains("pixtral");
    }

    private String resolveConversationsApiUrl() {
        String u = apiUrl == null ? "" : apiUrl.trim();
        if (u.isEmpty()) {
            return "https://api.mistral.ai/v1/conversations";
        }
        try {
            UriComponentsBuilder b = UriComponentsBuilder.fromHttpUrl(u);
            String path = b.build().getPath();
            if (path == null || path.isEmpty()) {
                b.replacePath("/v1/conversations");
            } else if (path.endsWith("/chat/completions")) {
                b.replacePath(
                        path.substring(0, path.length() - "/chat/completions".length()) + "/conversations");
            } else if (!path.endsWith("/conversations")) {
                int i = path.indexOf("/v1/");
                if (i >= 0) {
                    b.replacePath(path.substring(0, i + "/v1".length()) + "/conversations");
                } else {
                    b.replacePath("/v1/conversations");
                }
            }
            return b.build().encode().toUriString();
        } catch (Exception e) {
            log.debug("mistral.api parse failed ({}), defaulting to /v1/conversations", e.getMessage());
            return "https://api.mistral.ai/v1/conversations";
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

    private AssistantChatResponseDto parseConversationsResponse(String json, String modelFallback) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA (Mistral).");
        }
        try {
            JsonNode root = objectMapper.readTree(json);

            JsonNode outputs = root.get("outputs");
            if (outputs == null || !outputs.isArray() || outputs.isEmpty()) {
                return AssistantChatResponseDto.err("Réponse Mistral (conversations) sans contenu exploitable.");
            }

            StringBuilder content = new StringBuilder();
            String modelUsed = modelFallback;
            for (JsonNode output : outputs) {
                if (!"message.output".equals(output.path("type").asText(""))) {
                    continue;
                }
                String model = output.path("model").asText("").trim();
                if (!model.isEmpty()) {
                    modelUsed = model;
                }
                appendConversationText(content, output.get("content"));
            }

            if (content.isEmpty()) {
                return AssistantChatResponseDto.err("Réponse Mistral (conversations) sans texte assistant.");
            }

            String id = root.path("conversation_id").asText("");
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
            return AssistantChatResponseDto.ok(id, modelUsed, prov, "assistant", content.toString(), inTok, outTok);
        } catch (Exception e) {
            log.error("Failed to parse Mistral conversations JSON", e);
            return AssistantChatResponseDto.err(
                    "Impossible d’interpréter la réponse du fournisseur IA (Mistral).");
        }
    }

    private static void appendConversationText(StringBuilder sb, JsonNode contentNode) {
        if (contentNode == null || contentNode.isNull()) {
            return;
        }
        if (contentNode.isTextual()) {
            appendTextPart(sb, contentNode.asText(""));
            return;
        }
        if (contentNode.isArray()) {
            for (JsonNode part : contentNode) {
                if (part == null || part.isNull()) {
                    continue;
                }
                String type = part.path("type").asText("");
                if ("text".equals(type) || part.has("text")) {
                    appendTextPart(sb, part.path("text").asText(""));
                }
            }
        }
    }

    private static void appendTextPart(StringBuilder sb, String text) {
        String t = text != null ? text.trim() : "";
        if (t.isEmpty()) {
            return;
        }
        if (!sb.isEmpty()) {
            sb.append("\n\n");
        }
        sb.append(t);
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
