package com.pat.service.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Extrait le libellé utilisateur d’une réponse JSON d’erreur HTTP des APIs OpenAI, Anthropic, Google
 * ou Mistral ({@code error.message}, {@code message} à la racine, {@code detail}).
 */
public final class AssistantHttpErrorParser {

    /** Garde-fou taille (réponses déraisonnablement grosses → pas d’extraction). */
    private static final int MAX_RESPONSE_BODY_CHARS = 200_000;

    private AssistantHttpErrorParser() {}

    /**
     * @return {@code error.message} si présent, sinon {@code null}
     */
    public static String providerMessageOrNull(ObjectMapper mapper, String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return null;
        }
        if (responseBody.length() > MAX_RESPONSE_BODY_CHARS) {
            return null;
        }
        try {
            JsonNode root = mapper.readTree(responseBody);

            String mistralRoot = extractMistralRootMessage(root);
            if (mistralRoot != null) {
                return mistralRoot;
            }

            String detail = extractDetailMessage(root.get("detail"));
            if (detail != null) {
                return detail;
            }

            JsonNode err = root.get("error");
            if (err != null && !err.isNull()) {
                if (err.isObject() && err.has("message")) {
                    String m = err.path("message").asText("");
                    if (!m.isBlank()) {
                        return m.trim();
                    }
                }
                if (err.isTextual()) {
                    String t = err.asText("").trim();
                    return t.isEmpty() ? null : t;
                }
            }
        } catch (Exception ignored) {
            // ignore
        }
        return null;
    }

    /** Mistral : {@code {"object":"error","message":"…"}} à la racine. */
    private static String extractMistralRootMessage(JsonNode root) {
        if (root == null || !root.isObject()) {
            return null;
        }
        JsonNode objectNode = root.get("object");
        if (objectNode == null || !"error".equals(objectNode.asText(""))) {
            return null;
        }
        String m = root.path("message").asText("").trim();
        return m.isEmpty() ? null : m;
    }

    /** FastAPI / Mistral : {@code detail} textuel ou liste de validation. */
    private static String extractDetailMessage(JsonNode detail) {
        if (detail == null || detail.isNull()) {
            return null;
        }
        if (detail.isTextual()) {
            String t = detail.asText("").trim();
            return t.isEmpty() ? null : t;
        }
        if (detail.isArray() && !detail.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode item : detail) {
                if (item == null || item.isNull()) {
                    continue;
                }
                String part = item.path("msg").asText("").trim();
                if (part.isEmpty()) {
                    part = item.asText("").trim();
                }
                if (part.isEmpty()) {
                    continue;
                }
                if (!sb.isEmpty()) {
                    sb.append(' ');
                }
                sb.append(part);
            }
            String joined = sb.toString().trim();
            return joined.isEmpty() ? null : joined;
        }
        return null;
    }
}
