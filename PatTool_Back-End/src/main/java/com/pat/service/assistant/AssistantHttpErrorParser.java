package com.pat.service.assistant;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Extrait le libellé utilisateur d’une réponse JSON d’erreur HTTP des APIs OpenAI / Anthropic / Google.
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
}
