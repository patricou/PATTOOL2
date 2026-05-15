package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Interroge les API « liste des modèles » des fournisseurs configurés (clés serveur) pour remplir
 * le sélecteur côté client. En cas d’erreur ou de clé absente, renvoie une liste vide : le client
 * conserve ses presets locaux.
 */
@Service
public class AssistantModelsCatalogService {

    private static final Logger log = LoggerFactory.getLogger(AssistantModelsCatalogService.class);

    private final RestTemplate openAiRestTemplate;
    private final RestTemplate anthropicRestTemplate;
    private final RestTemplate geminiRestTemplate;
    private final ObjectMapper objectMapper;

    @Value("${openai.key:}")
    private String openaiKey;

    @Value("${openai.api:https://api.openai.com/v1/chat/completions}")
    private String openaiApiUrl;

    @Value("${anthropic.key:}")
    private String anthropicKey;

    @Value("${anthropic.api:https://api.anthropic.com/v1/messages}")
    private String anthropicApiUrl;

    @Value("${anthropic.version:2023-06-01}")
    private String anthropicVersion;

    @Value("${gemini.key:}")
    private String geminiKey;

    @Value("${gemini.api:https://generativelanguage.googleapis.com/v1beta}")
    private String geminiApiBase;

    public AssistantModelsCatalogService(
            @Qualifier("openAiRestTemplate") RestTemplate openAiRestTemplate,
            @Qualifier("anthropicRestTemplate") RestTemplate anthropicRestTemplate,
            @Qualifier("geminiRestTemplate") RestTemplate geminiRestTemplate,
            ObjectMapper objectMapper) {
        this.openAiRestTemplate = openAiRestTemplate;
        this.anthropicRestTemplate = anthropicRestTemplate;
        this.geminiRestTemplate = geminiRestTemplate;
        this.objectMapper = objectMapper;
    }

    public List<String> listModelIds(String providerSlug) {
        String p = providerSlug == null ? "" : providerSlug.trim().toLowerCase(Locale.ROOT);
        return switch (p) {
            case "openai" -> listOpenAiModelIds();
            case "anthropic" -> listAnthropicModelIds();
            case "gemini" -> listGeminiModelIds();
            default -> List.of();
        };
    }

    private List<String> listOpenAiModelIds() {
        if (openaiKey == null || openaiKey.isBlank()) {
            return List.of();
        }
        String url = openAiModelsEndpoint();
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setBearerAuth(openaiKey.trim());
            ResponseEntity<String> res =
                    openAiRestTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!res.getStatusCode().is2xxSuccessful() || res.getBody() == null) {
                return List.of();
            }
            JsonNode root = objectMapper.readTree(res.getBody());
            JsonNode data = root.get("data");
            if (data == null || !data.isArray()) {
                return List.of();
            }
            Set<String> ids = new LinkedHashSet<>();
            for (JsonNode n : data) {
                JsonNode idNode = n.get("id");
                if (idNode == null || !idNode.isTextual()) {
                    continue;
                }
                String id = idNode.asText().trim();
                if (isOpenAiChatLikeModelId(id)) {
                    ids.add(id);
                }
            }
            return new ArrayList<>(ids);
        } catch (RestClientException e) {
            log.debug("OpenAI models list failed: {}", e.getMessage());
            return List.of();
        } catch (Exception e) {
            log.debug("OpenAI models list parse failed: {}", e.getMessage());
            return List.of();
        }
    }

    /** Garde-fous pour éviter embeddings, audio, images, modération, etc. */
    static boolean isOpenAiChatLikeModelId(String id) {
        if (id == null || id.isBlank()) {
            return false;
        }
        String s = id.trim().toLowerCase(Locale.ROOT);
        if (s.startsWith("ft:")) {
            return false;
        }
        if (s.contains("embedding")) {
            return false;
        }
        if (s.contains("whisper")) {
            return false;
        }
        if (s.contains("dall-e") || s.contains("dall_e")) {
            return false;
        }
        if (s.contains("moderation")) {
            return false;
        }
        if (s.startsWith("tts-") || s.contains("-tts-")) {
            return false;
        }
        if (s.contains("transcribe")) {
            return false;
        }
        if (s.contains("realtime")) {
            return false;
        }
        if (s.contains("davinci") || s.contains("babbage") || s.contains("curie")) {
            return false;
        }
        if (s.startsWith("gpt-") || s.startsWith("chatgpt-")) {
            return true;
        }
        return s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4");
    }

    private String openAiModelsEndpoint() {
        String u = openaiApiUrl == null ? "" : openaiApiUrl.trim();
        if (u.isEmpty()) {
            return "https://api.openai.com/v1/models";
        }
        try {
            UriComponentsBuilder b = UriComponentsBuilder.fromHttpUrl(u);
            String path = b.build().getPath();
            if (path == null || path.isEmpty()) {
                b.replacePath("/v1/models");
            } else if (path.endsWith("/chat/completions")) {
                b.replacePath(
                        path.substring(0, path.length() - "/chat/completions".length()) + "/models");
            } else if (path.endsWith("/responses")) {
                b.replacePath(path.substring(0, path.length() - "/responses".length()) + "/models");
            } else if (!path.endsWith("/models")) {
                int i = path.indexOf("/v1/");
                if (i >= 0) {
                    b.replacePath(path.substring(0, i + "/v1".length()) + "/models");
                } else {
                    b.replacePath("/v1/models");
                }
            }
            return b.build().encode().toUriString();
        } catch (Exception e) {
            log.debug("openai.api parse failed ({}), defaulting to /v1/models", e.getMessage());
            return "https://api.openai.com/v1/models";
        }
    }

    private List<String> listAnthropicModelIds() {
        if (anthropicKey == null || anthropicKey.isBlank()) {
            return List.of();
        }
        String baseUrl = anthropicModelsEndpoint();
        try {
            Set<String> ids = new LinkedHashSet<>();
            String afterId = null;
            for (int guard = 0; guard < 50; guard++) {
                UriComponentsBuilder ub = UriComponentsBuilder.fromHttpUrl(baseUrl).queryParam("limit", 1000);
                if (afterId != null && !afterId.isEmpty()) {
                    ub.queryParam("after_id", afterId);
                }
                String url = ub.build().encode().toUriString();
                HttpHeaders headers = new HttpHeaders();
                headers.set("x-api-key", anthropicKey.trim());
                headers.set("anthropic-version", anthropicVersion != null ? anthropicVersion.trim() : "2023-06-01");
                ResponseEntity<String> res =
                        anthropicRestTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
                if (!res.getStatusCode().is2xxSuccessful() || res.getBody() == null) {
                    break;
                }
                JsonNode root = objectMapper.readTree(res.getBody());
                JsonNode data = root.get("data");
                if (data != null && data.isArray()) {
                    for (JsonNode n : data) {
                        JsonNode idNode = n.get("id");
                        if (idNode != null && idNode.isTextual()) {
                            String id = idNode.asText().trim();
                            if (!id.isEmpty()) {
                                ids.add(id);
                            }
                        }
                    }
                }
                JsonNode hasMore = root.get("has_more");
                JsonNode lastId = root.get("last_id");
                boolean more = hasMore != null && hasMore.isBoolean() && hasMore.booleanValue();
                String last = lastId != null && lastId.isTextual() ? lastId.asText().trim() : "";
                if (!more || last.isEmpty()) {
                    break;
                }
                afterId = last;
            }
            return new ArrayList<>(ids);
        } catch (RestClientException e) {
            log.debug("Anthropic models list failed: {}", e.getMessage());
            return List.of();
        } catch (Exception e) {
            log.debug("Anthropic models list parse failed: {}", e.getMessage());
            return List.of();
        }
    }

    private String anthropicModelsEndpoint() {
        String u = anthropicApiUrl == null ? "" : anthropicApiUrl.trim();
        if (u.endsWith("/messages")) {
            return u.substring(0, u.length() - "/messages".length()) + "/models";
        }
        return "https://api.anthropic.com/v1/models";
    }

    private List<String> listGeminiModelIds() {
        if (geminiKey == null || geminiKey.isBlank()) {
            return List.of();
        }
        String base = geminiApiBase == null ? "" : geminiApiBase.trim();
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        try {
            Set<String> ids = new LinkedHashSet<>();
            String pageToken = null;
            for (int guard = 0; guard < 50; guard++) {
                UriComponentsBuilder ub =
                        UriComponentsBuilder.fromHttpUrl(base + "/models")
                                .queryParam("key", geminiKey.trim())
                                .queryParam("pageSize", 100);
                if (pageToken != null && !pageToken.isEmpty()) {
                    ub.queryParam("pageToken", pageToken);
                }
                String url = ub.build().encode().toUriString();
                ResponseEntity<String> res = geminiRestTemplate.exchange(url, HttpMethod.GET, HttpEntity.EMPTY, String.class);
                if (!res.getStatusCode().is2xxSuccessful() || res.getBody() == null) {
                    break;
                }
                JsonNode root = objectMapper.readTree(res.getBody());
                JsonNode models = root.get("models");
                if (models != null && models.isArray()) {
                    for (JsonNode n : models) {
                        JsonNode nameNode = n.get("name");
                        if (nameNode == null || !nameNode.isTextual()) {
                            continue;
                        }
                        String raw = nameNode.asText().trim();
                        if (raw.startsWith("models/")) {
                            raw = raw.substring("models/".length());
                        }
                        if (raw.isEmpty()) {
                            continue;
                        }
                        if (geminiSupportsGenerateContent(n)) {
                            ids.add(raw);
                        }
                    }
                }
                JsonNode next = root.get("nextPageToken");
                pageToken = next != null && next.isTextual() ? next.asText().trim() : null;
                if (pageToken == null || pageToken.isEmpty()) {
                    break;
                }
            }
            return new ArrayList<>(ids);
        } catch (RestClientException e) {
            log.debug("Gemini models list failed: {}", e.getMessage());
            return List.of();
        } catch (Exception e) {
            log.debug("Gemini models list parse failed: {}", e.getMessage());
            return List.of();
        }
    }

    private static boolean geminiSupportsGenerateContent(JsonNode modelNode) {
        JsonNode methods = modelNode.get("supportedGenerationMethods");
        if (methods != null && methods.isArray()) {
            for (JsonNode m : methods) {
                if (m.isTextual() && "generateContent".equals(m.asText())) {
                    return true;
                }
            }
            return false;
        }
        return true;
    }
}
