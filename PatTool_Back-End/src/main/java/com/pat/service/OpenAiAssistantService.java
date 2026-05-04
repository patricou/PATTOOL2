package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantAttachedImageDto;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantToolFlagsDto;
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
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class OpenAiAssistantService {

    private static final Logger log = LoggerFactory.getLogger(OpenAiAssistantService.class);

    private static final int MAX_TURNS = 40;
    private static final int MAX_CONTENT_CHARS = 120_000;
    private static final int MAX_IMAGE_DECODED_BYTES = 8 * 1024 * 1024;

    private static final Set<String> ALLOWED_IMAGE_MIMES =
            Set.of("image/jpeg", "image/png", "image/gif", "image/webp");

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

        List<AssistantTurnDto> turns = trimTurns(request.messages());
        if (turns.isEmpty()) {
            return AssistantChatResponseDto.err("Aucun message valide à envoyer.");
        }

        ImageAttachResult imageAttach = resolveAttachedImage(request.attachedImage(), turns);
        if (imageAttach.error() != null) {
            return AssistantChatResponseDto.err(imageAttach.error());
        }

        long totalChars = turns.stream().mapToLong(t -> t.content() != null ? t.content().length() : 0).sum();
        if (request.system() != null && !request.system().isBlank()) {
            totalChars += request.system().trim().length();
        }
        if (totalChars > MAX_CONTENT_CHARS) {
            return AssistantChatResponseDto.err(
                    "Conversation trop longue pour un seul envoi. Effacez l’historique ou raccourcissez les messages.");
        }

        if (useResponsesTools(request)) {
            String mcpErr = validateMcpConfig(request.tools());
            if (mcpErr != null) {
                return AssistantChatResponseDto.err(mcpErr);
            }
            return completeWithResponses(request, turns, imageAttach.dataUrl());
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

    private record ImageAttachResult(String dataUrl, String error) {
        static ImageAttachResult none() {
            return new ImageAttachResult(null, null);
        }

        static ImageAttachResult ok(String dataUrl) {
            return new ImageAttachResult(dataUrl, null);
        }

        static ImageAttachResult err(String message) {
            return new ImageAttachResult(null, message);
        }
    }

    private ImageAttachResult resolveAttachedImage(
            AssistantAttachedImageDto attached, List<AssistantTurnDto> turns) {
        if (attached == null) {
            return ImageAttachResult.none();
        }
        if (turns.isEmpty() || !"user".equals(turns.get(turns.size() - 1).role())) {
            return ImageAttachResult.err(
                    "Une image ne peut être analysée qu’avec un message utilisateur en dernier.");
        }
        String mimeRaw = attached.mimeType();
        String b64Raw = attached.base64();
        if (mimeRaw == null || mimeRaw.isBlank() || b64Raw == null || b64Raw.isBlank()) {
            return ImageAttachResult.err("Image jointe incomplète (mimeType ou base64 manquant).");
        }
        String mime = mimeRaw.trim().toLowerCase();
        String b64 = b64Raw.strip().replaceAll("\\s+", "");
        String useMime = mime;
        if (b64.startsWith("data:")) {
            int comma = b64.indexOf(',');
            if (comma < 6) {
                return ImageAttachResult.err("Image jointe : data URL invalide.");
            }
            String header = b64.substring(5, comma);
            int semi = header.indexOf(';');
            String declared =
                    semi > 0 ? header.substring(0, semi).trim().toLowerCase() : header.trim().toLowerCase();
            if (!declared.isEmpty() && ALLOWED_IMAGE_MIMES.contains(declared)) {
                useMime = declared;
            }
            b64 = b64.substring(comma + 1).replaceAll("\\s+", "");
        }
        if (!ALLOWED_IMAGE_MIMES.contains(useMime)) {
            return ImageAttachResult.err(
                    "Format d’image non pris en charge. Utilisez JPEG, PNG, GIF ou WebP.");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            return ImageAttachResult.err("Encodage base64 de l’image invalide.");
        }
        if (decoded.length == 0) {
            return ImageAttachResult.err("Image jointe vide.");
        }
        if (decoded.length > MAX_IMAGE_DECODED_BYTES) {
            return ImageAttachResult.err(
                    "Image trop volumineuse (max "
                            + (MAX_IMAGE_DECODED_BYTES / (1024 * 1024))
                            + " Mo après décodage).");
        }
        String dataUrl =
                "data:"
                        + useMime
                        + ";base64,"
                        + Base64.getEncoder().encodeToString(decoded);
        return ImageAttachResult.ok(dataUrl);
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
            AssistantChatRequestDto request, List<AssistantTurnDto> turns, String imageDataUrl) {
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
        body.put("model", model);
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
            AssistantChatResponseDto parsed = parseResponsesApiResponse(response.getBody());
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

    private AssistantChatResponseDto parseResponsesApiResponse(String json) {
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
            String modelUsed = root.path("model").asText(model);
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
        if (content == null || !content.isArray()) {
            return;
        }
        for (JsonNode part : content) {
            String pType = part.path("type").asText("");
            if ("output_text".equals(pType)) {
                String t = part.path("text").asText("");
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
