package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantToolFlagsDto;
import com.pat.controller.dto.AssistantTurnDto;
import com.pat.service.assistant.AssistantMessageSupport;
import com.pat.service.assistant.AssistantMessageSupport.ResolvedImage;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class OpenAiAssistantService {

    private static final Logger log = LoggerFactory.getLogger(OpenAiAssistantService.class);

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

    /** Si vide, dérivé de {@code openai.api} ({@code …/chat/completions} → {@code …/responses}). */
    @Value("${openai.responses.api:}")
    private String responsesApiUrl;

    @Value("${openai.mcp.server-label:}")
    private String mcpServerLabel;

    @Value("${openai.mcp.server-url:}")
    private String mcpServerUrl;

    @Value("${openai.mcp.authorization:}")
    private String mcpAuthorization;

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

        if (useResponsesTools(request)) {
            String mcpErr = validateMcpConfig(request.tools());
            if (mcpErr != null) {
                return AssistantChatResponseDto.err(mcpErr);
            }
            return completeWithResponses(request, turns, imageAttach.dataUrl(), requestModel);
        }

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
            AssistantChatResponseDto parsed = parseOpenAiResponse(response.getBody(), requestModel);
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

    private static boolean useResponsesTools(AssistantChatRequestDto request) {
        AssistantToolFlagsDto t = request.tools();
        if (t == null) {
            return false;
        }
        return Boolean.TRUE.equals(t.webSearch())
                || Boolean.TRUE.equals(t.imageGeneration())
                || Boolean.TRUE.equals(t.mcp());
    }

    private String validateMcpConfig(AssistantToolFlagsDto tools) {
        if (tools == null || !Boolean.TRUE.equals(tools.mcp())) {
            return null;
        }
        if (mcpServerLabel == null || mcpServerLabel.isBlank()
                || mcpServerUrl == null || mcpServerUrl.isBlank()) {
            return "MCP activé : renseignez openai.mcp.server-label et openai.mcp.server-url côté serveur.";
        }
        return null;
    }

    private String resolveResponsesApiUrl() {
        if (responsesApiUrl != null && !responsesApiUrl.isBlank()) {
            return responsesApiUrl.trim();
        }
        if (apiUrl == null || apiUrl.isBlank()) {
            return "https://api.openai.com/v1/responses";
        }
        String base = apiUrl.trim();
        String suffix = "/chat/completions";
        if (base.endsWith(suffix)) {
            return base.substring(0, base.length() - suffix.length()) + "/responses";
        }
        return "https://api.openai.com/v1/responses";
    }

    private AssistantChatResponseDto completeWithResponses(
            AssistantChatRequestDto request, List<AssistantTurnDto> turns, String imageDataUrl, String requestModel) {
        AssistantToolFlagsDto flags = request.tools();
        List<Map<String, Object>> tools = new ArrayList<>();
        List<String> include = new ArrayList<>();
        if (Boolean.TRUE.equals(flags.webSearch())) {
            tools.add(Map.of("type", "web_search"));
            include.add("web_search_call.action.sources");
            include.add("web_search_call.results");
        }
        if (Boolean.TRUE.equals(flags.imageGeneration())) {
            tools.add(Map.of("type", "image_generation"));
        }
        if (Boolean.TRUE.equals(flags.mcp())) {
            Map<String, Object> mcp = new HashMap<>();
            mcp.put("type", "mcp");
            mcp.put("server_label", mcpServerLabel.trim());
            mcp.put("server_url", mcpServerUrl.trim());
            if (mcpAuthorization != null && !mcpAuthorization.isBlank()) {
                mcp.put("authorization", mcpAuthorization.trim());
            }
            tools.add(mcp);
        }

        List<Map<String, Object>> input = new ArrayList<>();
        int lastIdx = turns.size() - 1;
        for (int i = 0; i < turns.size(); i++) {
            AssistantTurnDto t = turns.get(i);
            if (imageDataUrl != null && i == lastIdx && "user".equals(t.role())) {
                List<Map<String, Object>> parts = new ArrayList<>();
                parts.add(Map.of("type", "input_text", "text", t.content()));
                parts.add(Map.of("type", "input_image", "image_url", imageDataUrl));
                Map<String, Object> msg = new HashMap<>();
                msg.put("role", "user");
                msg.put("content", parts);
                input.add(msg);
            } else {
                input.add(Map.of("role", t.role(), "content", t.content()));
            }
        }

        Map<String, Object> body = new HashMap<>();
        body.put("model", requestModel);
        body.put("input", input);
        body.put("max_output_tokens", maxTokens);
        body.put("tool_choice", "auto");
        body.put("tools", tools);
        body.put("store", false);
        body.put("parallel_tool_calls", true);
        if (request.system() != null && !request.system().isBlank()) {
            body.put("instructions", request.system().trim());
        }
        if (!include.isEmpty()) {
            body.put("include", include);
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(apiKey.trim());

        try {
            long startNs = System.nanoTime();
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<String> response =
                    restTemplate.exchange(
                            resolveResponsesApiUrl(), HttpMethod.POST, entity, String.class);
            int elapsedMs =
                    (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            AssistantChatResponseDto parsed = parseResponsesApiResponse(response.getBody(), requestModel);
            if (parsed.error() != null) {
                log.warn("OpenAI Responses API carries error payload: {}", parsed.error());
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
            log.warn("OpenAI Responses API error: {} — {}", e.getStatusCode(), e.getResponseBodyAsString());
            String hint = shortErrorHint(e.getResponseBodyAsString());
            return AssistantChatResponseDto.err(
                    "Erreur du fournisseur IA (Responses, " + e.getStatusCode().value() + ")"
                            + (hint != null ? ": " + hint : "."));
        } catch (ResourceAccessException e) {
            log.warn("OpenAI Responses API I/O error: {}", e.getMessage());
            Throwable cause = e.getCause();
            if (cause instanceof java.net.SocketTimeoutException) {
                return AssistantChatResponseDto.err(
                        "Délai d’attente dépassé (API Responses). Augmentez openai.http.read-timeout-seconds si besoin.");
            }
            return AssistantChatResponseDto.err(
                    "Impossible de joindre le fournisseur IA (Responses). Réessayez plus tard.");
        } catch (Exception e) {
            log.error("OpenAI Responses request failed", e);
            return AssistantChatResponseDto.err("Erreur technique lors de l’appel Responses.");
        }
    }

    /** Modèle envoyé à l’API pour ce tour (priorité au champ {@code model} du corps de requête REST). */
    private String resolveRequestModel(AssistantChatRequestDto request) {
        if (request != null && request.model() != null && !request.model().isBlank()) {
            return request.model().trim();
        }
        return model != null ? model.trim() : "";
    }

    private AssistantChatResponseDto parseResponsesApiResponse(String json, String modelFallback) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA (Responses).");
        }
        try {
            JsonNode root = objectMapper.readTree(json);
            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                return AssistantChatResponseDto.err(err.path("message").asText("Erreur OpenAI"));
            }
            String status = root.path("status").asText("");
            if (!"completed".equals(status)) {
                String reason = root.path("incomplete_details").path("reason").asText("");
                String extra =
                        reason.isEmpty()
                                ? "statut « " + status + " »"
                                : "statut « " + status + " » (" + reason + ")";
                return AssistantChatResponseDto.err(
                        "Réponse non terminée côté OpenAI (" + extra + "). Réessayez.");
            }

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
            Set<String> citationUrls = new LinkedHashSet<>();
            JsonNode output = root.get("output");
            if (output != null && output.isArray()) {
                for (JsonNode item : output) {
                    String type = item.path("type").asText("");
                    if ("message".equals(type)) {
                        appendMessageOutput(item, text, citationUrls);
                    } else if ("image_generation_call".equals(type)) {
                        appendImageGenerationOutput(item, text);
                    }
                }
            }

            if (text.isEmpty()) {
                return AssistantChatResponseDto.err("Réponse Responses sans texte exploitable.");
            }
            if (!citationUrls.isEmpty()) {
                text.append("\n\n---\n**Sources :**\n");
                for (String url : citationUrls) {
                    text.append("- ").append(url).append("\n");
                }
            }

            String prov =
                    assistantProviderLabel != null && !assistantProviderLabel.isBlank()
                            ? assistantProviderLabel.trim()
                            : "OpenAI";
            return AssistantChatResponseDto.ok(
                    id, modelUsed, prov, "assistant", text.toString().trim(), inTok, outTok);
        } catch (Exception e) {
            log.warn("Failed to parse OpenAI Responses JSON", e);
            return AssistantChatResponseDto.err("Impossible d’interpréter la réponse Responses.");
        }
    }

    private void appendMessageOutput(JsonNode item, StringBuilder text, Set<String> citationUrls) {
        JsonNode content = item.get("content");
        if (content != null && content.isTextual()) {
            String plain = content.asText("").trim();
            if (!plain.isEmpty()) {
                if (!text.isEmpty()) {
                    text.append("\n\n");
                }
                text.append(plain);
            }
            return;
        }
        if (content == null || !content.isArray()) {
            return;
        }
        for (JsonNode part : content) {
            String pType = part.path("type").asText("");
            if ("output_text".equals(pType) || "text".equals(pType)) {
                String t = openAiTextNodeToPlain(part.get("text"));
                if (!t.isEmpty()) {
                    if (!text.isEmpty()) {
                        text.append("\n\n");
                    }
                    text.append(t);
                }
                JsonNode annotations = part.get("annotations");
                if (annotations != null && annotations.isArray()) {
                    for (JsonNode ann : annotations) {
                        if ("url_citation".equals(ann.path("type").asText(""))) {
                            String u = ann.path("url").asText("").trim();
                            if (!u.isEmpty()) {
                                citationUrls.add(u);
                            }
                        }
                    }
                }
            } else if ("refusal".equals(pType)) {
                String r = part.path("refusal").asText("").trim();
                if (!r.isEmpty()) {
                    if (!text.isEmpty()) {
                        text.append("\n\n");
                    }
                    text.append(r);
                }
            }
        }
    }

    private void appendImageGenerationOutput(JsonNode item, StringBuilder text) {
        if (!"completed".equals(item.path("status").asText(""))) {
            return;
        }
        String b64 = item.path("result").asText("");
        if (b64 == null || b64.isBlank()) {
            return;
        }
        String dataUrl = b64.startsWith("data:") ? b64 : "data:image/png;base64," + b64;
        if (!text.isEmpty()) {
            text.append("\n\n");
        }
        text.append("![Image générée](").append(dataUrl).append(")");
    }

    private AssistantChatResponseDto parseOpenAiResponse(String json, String modelFallback) {
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

            if ((content == null || content.isBlank())
                    && outTok != null
                    && outTok > 0) {
                log.warn(
                        "OpenAI Chat Completions: usage reports {} completion tokens but extracted assistant content is empty (check message.content shape for this model).",
                        outTok);
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

    /**
     * Texte affichable dans {@code choices[].message} pour Chat Completions.
     * Quand {@code content} est un tableau de fragments ({@code type}/{@code text}), {@link JsonNode#asText()}
     * renvoie une chaîne vide : les jetons comptent dans {@code usage} mais l’UI PatTool affichait « vide ».
     */
    private static String extractChatCompletionsAssistantText(JsonNode message) {
        if (message == null || message.isNull()) {
            return "";
        }
        JsonNode refusal = message.get("refusal");
        if (refusal != null && refusal.isTextual()) {
            String r = refusal.asText("").trim();
            if (!r.isEmpty()) {
                return r;
            }
        }
        JsonNode contentNode = message.get("content");
        if (contentNode == null || contentNode.isNull()) {
            return "";
        }
        if (contentNode.isTextual()) {
            return contentNode.asText("");
        }
        if (contentNode.isObject()) {
            return extractOpenAiMessageContentPartText(contentNode);
        }
        if (contentNode.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode part : contentNode) {
                String t = extractOpenAiMessageContentPartText(part);
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

    /**
     * Extrait le texte d’un fragment {@code content[]} du message assistant (Chat Completions).
     * Le champ {@code text} peut être une chaîne ou un objet ({@code value}, etc.) selon les modèles / versions d’API.
     */
    private static String extractOpenAiMessageContentPartText(JsonNode part) {
        if (part == null || part.isNull()) {
            return "";
        }
        if (part.isTextual()) {
            return part.asText("").trim();
        }
        String fromText = openAiTextNodeToPlain(part.get("text"));
        if (!fromText.isEmpty()) {
            return fromText;
        }
        return openAiTextNodeToPlain(part.get("content"));
    }

    /** Normalise le nœud {@code text} d’OpenAI (string ou objet) vers une chaîne affichable. */
    private static String openAiTextNodeToPlain(JsonNode textNode) {
        if (textNode == null || textNode.isNull()) {
            return "";
        }
        if (textNode.isTextual()) {
            return textNode.asText("").trim();
        }
        if (textNode.isNumber()) {
            return textNode.asText().trim();
        }
        if (textNode.isObject()) {
            String v = textNode.path("value").asText("").trim();
            if (!v.isEmpty()) {
                return v;
            }
            v = textNode.path("text").asText("").trim();
            if (!v.isEmpty()) {
                return v;
            }
        }
        if (textNode.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode n : textNode) {
                String t = openAiTextNodeToPlain(n);
                if (!t.isEmpty()) {
                    if (!sb.isEmpty()) {
                        sb.append("\n\n");
                    }
                    sb.append(t);
                }
            }
            return sb.toString().trim();
        }
        return "";
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
