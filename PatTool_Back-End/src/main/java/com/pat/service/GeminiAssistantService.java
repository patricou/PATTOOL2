package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantChatRequestDto;
import com.pat.controller.dto.AssistantChatResponseDto;
import com.pat.controller.dto.AssistantToolFlagsDto;
import com.pat.controller.dto.AssistantTurnDto;
import com.pat.service.assistant.AssistantHttpErrorParser;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Assistant via l’API REST {@code generateContent} de Google Gemini
 * (<a href="https://ai.google.dev/api/rest">docs</a>).
 * Recherche web : outil {@code google_search} (modèles récents) avec repli automatique sur
 * {@code google_search_retrieval} pour les modèles type Gemini&nbsp;1.5 (voir
 * {@code gemini.web-search-legacy-model-prefixes}) ou si l’API renvoie une erreur 400 incitant à l’ancien outil.
 * Images : modèle dédié (voir {@code gemini.image-generation-model}) et {@code responseModalities}.
 * MCP reste réservé au fournisseur OpenAI.
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

    @Value("${gemini.max-output-tokens:16384}")
    private int maxOutputTokens;

    @Value("${gemini.provider-label:Google}")
    private String assistantProviderLabel;

    /** Modèle utilisé lorsque la génération d’images est demandée (texte + image). */
    @Value("${gemini.image-generation-model:gemini-2.5-flash-image}")
    private String imageGenerationModel;

    /**
     * Préfixes de {@code model} (insensible à la casse) pour lesquels on envoie directement
     * {@code google_search_retrieval} au lieu de {@code google_search}, afin d’éviter un 400 inutile
     * sur les modèles Gemini&nbsp;1.5 / 1.0.
     */
    @Value("${gemini.web-search-legacy-model-prefixes:gemini-1.5,gemini-1.0}")
    private String webSearchLegacyModelPrefixesRaw;

    /**
     * Gemini 2.5+ peut réserver une part du budget à une phase « pensée » ; un budget trop strict sur
     * {@link #maxOutputTokens} laisse très peu voire aucun jeton au texte affiché. Valeur&nbsp;{@code -1}&nbsp;= ne pas envoyer {@code thinkingConfig}.
     *
     * @see #applyThinkingBudgetIfApplicable(Map, String)
     */
    @Value("${gemini.thinking-budget:0}")
    private int geminiThinkingBudget;

    public GeminiAssistantService(
            @Qualifier("geminiRestTemplate") RestTemplate restTemplate,
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

    /** {@code gemini.image-generation-model} pour l’UI (non sensible). */
    public String getImageGenerationModel() {
        return imageGenerationModel != null ? imageGenerationModel.trim() : "";
    }

    public AssistantChatResponseDto complete(AssistantChatRequestDto request) {
        if (apiKey == null || apiKey.isBlank()) {
            log.error("Gemini API key is not configured (gemini.key).");
            return AssistantChatResponseDto.err(
                    "Assistant indisponible : configurez gemini.key côté serveur.");
        }

        AssistantToolFlagsDto tf = request.tools();
        if (tf != null && Boolean.TRUE.equals(tf.mcp())) {
            return AssistantChatResponseDto.err(
                    "L’accès MCP (API Responses OpenAI) n’est disponible qu’avec le fournisseur OpenAI "
                            + "(assistant.provider=openai). Décochez MCP ou changez de fournisseur.");
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

        boolean wantWeb = tf != null && Boolean.TRUE.equals(tf.webSearch());
        boolean wantImage = tf != null && Boolean.TRUE.equals(tf.imageGeneration());

        String requestModel = resolveRequestModel(request);
        String effectiveModel = resolveEffectiveModel(requestModel, wantImage);
        String url = buildGenerateContentUrl(effectiveModel);

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
        applyThinkingBudgetIfApplicable(genCfg, effectiveModel);
        if (wantImage) {
            genCfg.put("responseModalities", List.of("TEXT", "IMAGE"));
        }
        body.put("generationConfig", genCfg);

        if (wantWeb) {
            applyGeminiWebSearchTools(body, effectiveModel);
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                long startNs = System.nanoTime();
                HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);
                ResponseEntity<String> response =
                        restTemplate.exchange(url, HttpMethod.POST, entity, String.class);
                int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
                AssistantChatResponseDto parsed = parseGeminiResponse(response.getBody(), effectiveModel);
                if (parsed.error() != null) {
                    log.debug("Gemini response carries error payload: {}", parsed.error());
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
                String errBody = e.getResponseBodyAsString();
                if (wantWeb
                        && attempt == 0
                        && e.getStatusCode().value() == 400
                        && bodyUsesModernGoogleSearchTool(body)
                        && shouldFallbackToGoogleSearchRetrieval(errBody)) {
                    body.put("tools", List.of(legacyGoogleSearchRetrievalTool()));
                    log.debug("Gemini web search: retry with google_search_retrieval after API 400");
                    continue;
                }
                log.debug("Gemini API error: {} — {}", e.getStatusCode(), errBody);
                String msg = AssistantHttpErrorParser.providerMessageOrNull(objectMapper, errBody);
                if (msg != null && !msg.isBlank()) {
                    return AssistantChatResponseDto.err(msg);
                }
                return AssistantChatResponseDto.err(
                        "Erreur du fournisseur IA (" + e.getStatusCode().value() + ").");
            } catch (ResourceAccessException e) {
                log.debug("Gemini API I/O error: {}", e.getMessage());
                Throwable cause = e.getCause();
                if (cause instanceof java.net.SocketTimeoutException) {
                    return AssistantChatResponseDto.err(
                            "Délai d’attente dépassé en lisant la réponse Gemini. "
                                    + "Augmentez gemini.http.read-timeout-seconds si besoin. Réessayez.");
                }
                return AssistantChatResponseDto.err(
                        "Impossible de joindre le fournisseur IA (Gemini). Réessayez plus tard.");
            } catch (Exception e) {
                log.error("Gemini assistant request failed", e);
                return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant (Gemini).");
            }
        }
        return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant (Gemini).");
    }

    private void applyGeminiWebSearchTools(Map<String, Object> body, String effectiveModel) {
        if (webSearchUsesLegacyModel(effectiveModel)) {
            body.put("tools", List.of(legacyGoogleSearchRetrievalTool()));
        } else {
            body.put("tools", List.of(Map.of("google_search", Map.of())));
        }
    }

    private boolean webSearchUsesLegacyModel(String modelId) {
        String raw = webSearchLegacyModelPrefixesRaw;
        if (raw == null || raw.isBlank()) {
            return false;
        }
        String m = modelId != null ? modelId.trim().toLowerCase(Locale.ROOT) : "";
        if (m.isEmpty()) {
            return false;
        }
        for (String part : raw.split(",")) {
            String prefix = part.trim().toLowerCase(Locale.ROOT);
            if (!prefix.isEmpty() && m.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Outil grounding des modèles Gemini&nbsp;1.5 (et assimilés) : {@code dynamic_retrieval_config.mode}
     * {@code MODE_DYNAMIC} correspond au comportement « recherche si pertinent » côté API.
     */
    private static Map<String, Object> legacyGoogleSearchRetrievalTool() {
        Map<String, Object> dynamicCfg = new HashMap<>();
        dynamicCfg.put("mode", "MODE_DYNAMIC");
        Map<String, Object> retrieval = new HashMap<>();
        retrieval.put("dynamic_retrieval_config", dynamicCfg);
        return Map.of("google_search_retrieval", retrieval);
    }

    private static boolean bodyUsesModernGoogleSearchTool(Map<String, Object> body) {
        Object toolsObj = body.get("tools");
        if (!(toolsObj instanceof List<?> list) || list.isEmpty()) {
            return false;
        }
        Object first = list.get(0);
        if (!(first instanceof Map<?, ?> m)) {
            return false;
        }
        return m.containsKey("google_search");
    }

    /**
     * Détecte les réponses 400 indiquant que l’API attend {@code google_search_retrieval} plutôt que
     * {@code google_search} (ex. certains modèles 1.x), en évitant le faux positif
     * « Please use google_search … instead of google_search_retrieval » (cas inverse, modèles 2.x).
     */
    private static boolean shouldFallbackToGoogleSearchRetrieval(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return false;
        }
        String s = responseBody.toLowerCase(Locale.ROOT);
        if (s.contains("please use google_search field instead of google_search_retrieval")) {
            return false;
        }
        if (s.contains("use google_search field instead of google_search_retrieval")) {
            return false;
        }
        if (s.contains("please use google_search_retrieval")) {
            return true;
        }
        if (s.contains("google_search_retrieval field instead of google_search")) {
            return true;
        }
        if (s.contains("use google_search_retrieval instead")) {
            return true;
        }
        // Corps d'erreur JSON parfois du type Unknown name "google_search" dans tools (modèles legacy)
        return s.contains("unknown name \"google_search\"") && s.contains("tools");
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

    private String resolveRequestModel(AssistantChatRequestDto request) {
        if (request != null && request.model() != null && !request.model().isBlank()) {
            return request.model().trim();
        }
        return model != null ? model.trim() : "";
    }

    /**
     * Pour la génération d’images, utilise {@link #imageGenerationModel} ; sinon le modèle conversation.
     */
    private String resolveEffectiveModel(String chatModel, boolean wantImage) {
        if (!wantImage) {
            return chatModel;
        }
        String img = imageGenerationModel != null ? imageGenerationModel.trim() : "";
        if (!img.isEmpty()) {
            return img;
        }
        return chatModel != null ? chatModel : "";
    }

    /**
     * Les modèles Gemini « thinking » peuvent être bridés&nbsp;: sans {@code thinkingBudget=0}, le même
     * plafond {@code maxOutputTokens} sert souvent aussi au raisonnement interne et le texte affiché se
     * retrouve tronqué après très peu de jetons. Une valeur&nbsp;{@code -1}&nbsp;désactive l’envoi de
     * {@code thinkingConfig} (laisser le comportement Google par défaut).
     */
    private void applyThinkingBudgetIfApplicable(Map<String, Object> genCfg, String effectiveModel) {
        if (geminiThinkingBudget < 0 || genCfg == null || effectiveModel == null || effectiveModel.isBlank()) {
            return;
        }
        if (!geminiModelLikelySupportsThinkingBudget(effectiveModel.trim())) {
            return;
        }
        genCfg.put("thinkingConfig", Map.of("thinkingBudget", geminiThinkingBudget));
    }

    /** Heuristique : famille 2.5+/3 où le paramètre est documenté dans l’API Google. */
    private static boolean geminiModelLikelySupportsThinkingBudget(String modelId) {
        String m = modelId.trim().replace('_', '-').toLowerCase(Locale.ROOT);
        // retirer préfixe "models/" au cas où
        if (m.startsWith("models/")) {
            m = m.substring("models/".length());
        }
        return m.contains("gemini-2.5")
                || m.contains("gemini-3")
                || m.contains("gemini-2-6")
                || m.contains("2.5-flash")
                || m.contains("2.5-pro");
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
            Integer thoughtsTok = null;
            JsonNode usage = root.get("usageMetadata");
            if (usage != null && !usage.isNull()) {
                if (usage.has("promptTokenCount")) {
                    inTok = usage.get("promptTokenCount").asInt();
                }
                if (usage.has("candidatesTokenCount")) {
                    outTok = usage.get("candidatesTokenCount").asInt();
                }
                if (usage.has("thoughtsTokenCount")) {
                    thoughtsTok = usage.get("thoughtsTokenCount").asInt();
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
                    } else {
                        appendGeminiInlineImageMarkdown(part, text);
                    }
                }
            }

            appendGeminiGroundingSources(first, text);

            if (text.isEmpty()) {
                if ("MAX_TOKENS".equals(finish) || "OTHER".equals(finish)) {
                    return AssistantChatResponseDto.err(
                            "Réponse Gemini vide ou tronquée (finishReason="
                                    + finish
                                    + "). Augmentez gemini.max-output-tokens sur le serveur ; pour Gemini"
                                    + " 2.5+, conservez gemini.thinking-budget=0 (défaut) afin de réserver le"
                                    + " budget au texte affiché.");
                }
                return AssistantChatResponseDto.err(
                        "Réponse Gemini sans texte exploitable"
                                + (finish.isEmpty() ? "." : " (finishReason=" + finish + ")."));
            }

            String trimmed = text.toString().trim();
            if ("MAX_TOKENS".equals(finish)) {
                log.warn(
                        "Gemini MAX_TOKENS with non-empty text (truncated): candidatesTokenCount={}"
                                + " thoughtsTokenCount={} promptTokenCount={} maxOutputTokens={} model={}",
                        outTok,
                        thoughtsTok,
                        inTok,
                        maxOutputTokens,
                        modelFallback);
                trimmed =
                        trimmed
                                + "\n\n---\n*Réponse **tronquée** (`finishReason=MAX_TOKENS`). Côté serveur :"
                                + " augmentez `gemini.max-output-tokens`. Avec Gemini **2.5+**, laissez"
                                + " `gemini.thinking-budget=0` (défaut `PatTool`) pour limiter la phase"
                                + " « pensée » et libérer des jetons pour le texte visible.*";
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
                    trimmed,
                    inTok,
                    outTok);
        } catch (Exception e) {
            log.error("Failed to parse Gemini JSON", e);
            return AssistantChatResponseDto.err(
                    "Impossible d’interpréter la réponse du fournisseur IA (Gemini).");
        }
    }

    /** Inline image in {@code generateContent} (REST camelCase ou snake_case). */
    private static void appendGeminiInlineImageMarkdown(JsonNode part, StringBuilder text) {
        JsonNode inline = part.get("inlineData");
        if (inline == null || inline.isNull()) {
            inline = part.get("inline_data");
        }
        if (inline == null || inline.isNull()) {
            return;
        }
        String mime = inline.path("mimeType").asText("");
        if (mime.isEmpty()) {
            mime = inline.path("mime_type").asText("");
        }
        if (mime.isEmpty()) {
            mime = "image/png";
        }
        String b64 = inline.path("data").asText("");
        if (b64.isEmpty()) {
            return;
        }
        if (!text.isEmpty()) {
            text.append("\n\n");
        }
        text.append("![Generated](")
                .append("data:")
                .append(mime)
                .append(";base64,")
                .append(b64)
                .append(")");
    }

    private static void appendGeminiGroundingSources(JsonNode candidate, StringBuilder text) {
        JsonNode gm = candidate.get("groundingMetadata");
        if (gm == null || gm.isNull()) {
            return;
        }
        JsonNode chunks = gm.get("groundingChunks");
        if (chunks == null || !chunks.isArray()) {
            return;
        }
        Set<String> urls = new LinkedHashSet<>();
        for (JsonNode ch : chunks) {
            JsonNode web = ch.get("web");
            if (web != null && !web.isNull()) {
                String uri = web.path("uri").asText("").trim();
                if (!uri.isEmpty()) {
                    urls.add(uri);
                }
            }
        }
        if (urls.isEmpty()) {
            return;
        }
        if (!text.isEmpty()) {
            text.append("\n\n");
        }
        text.append("**Sources :**\n");
        for (String u : urls) {
            text.append("- ").append(u).append('\n');
        }
    }

}
