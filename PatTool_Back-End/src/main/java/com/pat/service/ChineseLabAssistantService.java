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
import java.util.Locale;
import java.util.Map;

/**
 * Assistants chinois en Chat Completions compatible OpenAI : DeepSeek, Qwen (DashScope international),
 * GLM (Z.ai) et Kimi (Moonshot). MCP, recherche web et génération d’images PatTool restent sur les
 * autres fournisseurs.
 */
@Service
public class ChineseLabAssistantService {

    private static final Logger log = LoggerFactory.getLogger(ChineseLabAssistantService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${deepseek.key:}")
    private String deepseekKey;

    @Value("${deepseek.api:https://api.deepseek.com/chat/completions}")
    private String deepseekApi;

    @Value("${deepseek.model:deepseek-v4-pro}")
    private String deepseekModel;

    @Value("${deepseek.max-tokens:8192}")
    private int deepseekMaxTokens;

    @Value("${deepseek.provider-label:DeepSeek}")
    private String deepseekLabel;

    @Value("${qwen.key:}")
    private String qwenKey;

    @Value("${qwen.api:https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions}")
    private String qwenApi;

    @Value("${qwen.model:qwen3.8-max}")
    private String qwenModel;

    @Value("${qwen.max-tokens:8192}")
    private int qwenMaxTokens;

    @Value("${qwen.provider-label:Qwen}")
    private String qwenLabel;

    @Value("${glm.key:}")
    private String glmKey;

    @Value("${glm.api:https://api.z.ai/api/paas/v4/chat/completions}")
    private String glmApi;

    @Value("${glm.model:glm-5.3}")
    private String glmModel;

    @Value("${glm.max-tokens:8192}")
    private int glmMaxTokens;

    @Value("${glm.provider-label:GLM}")
    private String glmLabel;

    @Value("${kimi.key:}")
    private String kimiKey;

    @Value("${kimi.api:https://api.moonshot.ai/v1/chat/completions}")
    private String kimiApi;

    @Value("${kimi.model:kimi-k3.1-pro}")
    private String kimiModel;

    @Value("${kimi.max-tokens:8192}")
    private int kimiMaxTokens;

    @Value("${kimi.provider-label:Kimi}")
    private String kimiLabel;

    public ChineseLabAssistantService(
            @Qualifier("chineseLabRestTemplate") RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public static boolean isChineseLab(String slug) {
        return labOf(slug) != null;
    }

    public String getConfiguredProviderLabel(String slug) {
        Lab lab = labOf(slug);
        if (lab == null) {
            return "";
        }
        String label = switch (lab) {
            case DEEPSEEK -> deepseekLabel;
            case QWEN -> qwenLabel;
            case GLM -> glmLabel;
            case KIMI -> kimiLabel;
        };
        return label != null ? label.trim() : "";
    }

    public String getConfiguredModel(String slug) {
        Lab lab = labOf(slug);
        if (lab == null) {
            return "";
        }
        String model = switch (lab) {
            case DEEPSEEK -> deepseekModel;
            case QWEN -> qwenModel;
            case GLM -> glmModel;
            case KIMI -> kimiModel;
        };
        return model != null ? model.trim() : "";
    }

    public String apiKey(String slug) {
        Lab lab = labOf(slug);
        if (lab == null) {
            return "";
        }
        String key = switch (lab) {
            case DEEPSEEK -> deepseekKey;
            case QWEN -> qwenKey;
            case GLM -> glmKey;
            case KIMI -> kimiKey;
        };
        return key != null ? key.trim() : "";
    }

    public String apiUrl(String slug) {
        Lab lab = labOf(slug);
        if (lab == null) {
            return "";
        }
        String url = switch (lab) {
            case DEEPSEEK -> deepseekApi;
            case QWEN -> qwenApi;
            case GLM -> glmApi;
            case KIMI -> kimiApi;
        };
        return url != null ? url.trim() : "";
    }

    public AssistantChatResponseDto complete(String slug, AssistantChatRequestDto request) {
        Lab lab = labOf(slug);
        if (lab == null) {
            return AssistantChatResponseDto.err("Fournisseur chinois inconnu.");
        }
        String key = apiKey(slug);
        if (key.isEmpty()) {
            log.error("{} API key is not configured.", lab.display);
            return AssistantChatResponseDto.err(
                    "Assistant indisponible : configurez " + lab.propertyPrefix + ".key côté serveur.");
        }

        AssistantToolFlagsDto tf = request.tools();
        if (tf != null && Boolean.TRUE.equals(tf.mcp())) {
            return AssistantChatResponseDto.err(
                    "L’accès MCP n’est disponible qu’avec le fournisseur OpenAI. Décochez MCP ou changez de fournisseur.");
        }
        if (tf != null && Boolean.TRUE.equals(tf.imageGeneration())) {
            return AssistantChatResponseDto.err(
                    "La génération d’images n’est pas disponible avec " + lab.display
                            + ". Utilisez OpenAI ou Gemini, ou décochez l’option.");
        }
        if (tf != null && Boolean.TRUE.equals(tf.webSearch())) {
            return AssistantChatResponseDto.err(
                    "La recherche web PatTool n’est pas disponible avec " + lab.display + ". Décochez l’option.");
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

        String requestModel = resolveRequestModel(request, slug);
        if (requestModel.isBlank()) {
            return AssistantChatResponseDto.err(
                    "Modèle " + lab.display + " non configuré. Renseignez " + lab.propertyPrefix
                            + ".model côté serveur ou choisissez un modèle.");
        }
        if (imageAttach.dataUrl() != null && !isVisionModel(slug, requestModel)) {
            return AssistantChatResponseDto.err(
                    "Ce modèle " + lab.display + " ne prend pas en charge l’analyse d’images. "
                            + lab.visionHint);
        }

        List<Object> chatMessages = buildChatCompletionMessages(turns, imageAttach, request.system());
        Map<String, Object> body = new HashMap<>();
        body.put("model", requestModel);
        body.put("messages", chatMessages);
        body.put("max_tokens", maxTokens(lab));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(key);

        try {
            long startNs = System.nanoTime();
            ResponseEntity<String> response =
                    restTemplate.exchange(apiUrl(slug), HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
            int elapsedMs = (int) Math.min((System.nanoTime() - startNs) / 1_000_000L, Integer.MAX_VALUE);
            AssistantChatResponseDto parsed = parseChatCompletionsResponse(response.getBody(), requestModel, lab);
            if (parsed.error() != null) {
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
            log.warn("{} API error: {} — {}", lab.display, e.getStatusCode(), shorten(e.getResponseBodyAsString(), 800));
            String msg = AssistantHttpErrorParser.providerMessageOrNull(objectMapper, e.getResponseBodyAsString());
            if (msg != null && !msg.isBlank()) {
                return AssistantChatResponseDto.err(msg);
            }
            return AssistantChatResponseDto.err("Erreur du fournisseur IA (" + e.getStatusCode().value() + ").");
        } catch (ResourceAccessException e) {
            log.debug("{} API I/O error: {}", lab.display, e.getMessage());
            if (e.getCause() instanceof java.net.SocketTimeoutException) {
                return AssistantChatResponseDto.err(
                        "Délai d’attente dépassé en lisant la réponse " + lab.display + ". Réessayez.");
            }
            return AssistantChatResponseDto.err(
                    "Impossible de joindre le fournisseur IA (" + lab.display + "). Réessayez plus tard.");
        } catch (Exception e) {
            log.error("{} assistant request failed", lab.display, e);
            return AssistantChatResponseDto.err("Erreur technique lors de l’appel à l’assistant (" + lab.display + ").");
        }
    }

    static boolean isVisionModel(String slug, String modelId) {
        if (modelId == null || modelId.isBlank() || labOf(slug) == null) {
            return false;
        }
        String s = modelId.trim().toLowerCase(Locale.ROOT);
        if (s.contains("embed") || s.contains("tts") || s.contains("asr")) {
            return false;
        }
        return switch (labOf(slug)) {
            case DEEPSEEK -> s.contains("v4.1") || s.contains("vision") || s.contains("-vl");
            case QWEN -> s.contains("-vl") || s.contains("omni") || s.contains("vision");
            case GLM -> s.contains("flash") || s.contains("vision") || s.contains("-v");
            case KIMI -> s.startsWith("kimi-k3");
        };
    }

    private int maxTokens(Lab lab) {
        int n = switch (lab) {
            case DEEPSEEK -> deepseekMaxTokens;
            case QWEN -> qwenMaxTokens;
            case GLM -> glmMaxTokens;
            case KIMI -> kimiMaxTokens;
        };
        return n > 0 ? n : 8192;
    }

    private String resolveRequestModel(AssistantChatRequestDto request, String slug) {
        if (request != null && request.model() != null && !request.model().isBlank()) {
            return request.model().trim();
        }
        return getConfiguredModel(slug);
    }

    private List<Object> buildChatCompletionMessages(
            List<AssistantTurnDto> turns, ResolvedImage imageAttach, String system) {
        List<Object> chatMessages = new ArrayList<>();
        if (system != null && !system.isBlank()) {
            chatMessages.add(Map.of("role", "system", "content", system.trim()));
        }
        int lastIdx = turns.size() - 1;
        for (int i = 0; i < turns.size(); i++) {
            AssistantTurnDto t = turns.get(i);
            if (imageAttach.dataUrl() != null && i == lastIdx && "user".equals(t.role())) {
                List<Map<String, Object>> parts = new ArrayList<>();
                parts.add(Map.of("type", "text", "text", t.content()));
                parts.add(Map.of("type", "image_url", "image_url", Map.of("url", imageAttach.dataUrl())));
                Map<String, Object> msg = new HashMap<>();
                msg.put("role", "user");
                msg.put("content", parts);
                chatMessages.add(msg);
            } else {
                chatMessages.add(Map.of("role", t.role(), "content", t.content()));
            }
        }
        return chatMessages;
    }

    private AssistantChatResponseDto parseChatCompletionsResponse(String json, String modelFallback, Lab lab) {
        if (json == null || json.isBlank()) {
            return AssistantChatResponseDto.err("Réponse vide du fournisseur IA (" + lab.display + ").");
        }
        try {
            JsonNode root = objectMapper.readTree(json);
            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                return AssistantChatResponseDto.err(err.path("message").asText("Erreur " + lab.display));
            }
            JsonNode choices = root.get("choices");
            if (choices == null || !choices.isArray() || choices.isEmpty()) {
                return AssistantChatResponseDto.err("Réponse " + lab.display + " sans contenu exploitable.");
            }
            JsonNode message = choices.get(0).path("message");
            String role = message.path("role").asText("assistant");
            String content = extractText(message);
            if (content.isBlank() && !choices.get(0).path("text").asText("").isBlank()) {
                content = choices.get(0).path("text").asText("").trim();
            }
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
            String label = getConfiguredProviderLabel(lab.name().toLowerCase(Locale.ROOT));
            if (label.isBlank()) {
                label = lab.display;
            }
            return AssistantChatResponseDto.ok(
                    root.path("id").asText(""),
                    root.path("model").asText(modelFallback),
                    label,
                    role,
                    content,
                    inTok,
                    outTok);
        } catch (Exception e) {
            log.error("Failed to parse {} JSON", lab.display, e);
            return AssistantChatResponseDto.err(
                    "Impossible d’interpréter la réponse du fournisseur IA (" + lab.display + ").");
        }
    }

    private static String extractText(JsonNode message) {
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
        if (!contentNode.isArray()) {
            return "";
        }
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

    private static String shorten(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private static Lab labOf(String slug) {
        if (slug == null || slug.isBlank()) {
            return null;
        }
        return switch (slug.trim().toLowerCase(Locale.ROOT)) {
            case "deepseek" -> Lab.DEEPSEEK;
            case "qwen", "alibaba" -> Lab.QWEN;
            case "glm", "zhipu", "zai" -> Lab.GLM;
            case "kimi", "moonshot" -> Lab.KIMI;
            default -> null;
        };
    }

    private enum Lab {
        DEEPSEEK("DeepSeek", "deepseek", "Choisissez deepseek-v4.1-flash (vision)."),
        QWEN("Qwen", "qwen", "Choisissez un modèle Qwen-VL ou Omni."),
        GLM("GLM", "glm", "Choisissez glm-5.3-flash (vision)."),
        KIMI("Kimi", "kimi", "Choisissez kimi-k3.1-pro ou kimi-k3.");

        final String display;
        final String propertyPrefix;
        final String visionHint;

        Lab(String display, String propertyPrefix, String visionHint) {
            this.display = display;
            this.propertyPrefix = propertyPrefix;
            this.visionHint = visionHint;
        }
    }
}
