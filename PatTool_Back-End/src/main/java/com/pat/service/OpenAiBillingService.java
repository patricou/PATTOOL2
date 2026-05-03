package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.AssistantOpenAiCreditsDto;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

/**
 * Lecture du solde prépayé / crédits via l’API OpenAI (<a href=
 * "https://api.openai.com/v1/dashboard/billing/credit_grants">credit_grants</a>).
 * Avec une clé API « secret » classique (serveur), OpenAI renvoie souvent 403 : cet endpoint
 * est réservé aux appels type session navigateur. Dans ce cas on renvoie un message explicite
 * plutôt qu’une erreur opaque.
 */
@Service
public class OpenAiBillingService {

    private static final Logger log = LoggerFactory.getLogger(OpenAiBillingService.class);

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${openai.key:}")
    private String apiKey;

    @Value("${openai.billing.credit-grants-url}")
    private String creditGrantsUrl;

    public OpenAiBillingService(RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public AssistantOpenAiCreditsDto fetchCreditsSummary() {
        if (apiKey == null || apiKey.isBlank()) {
            return AssistantOpenAiCreditsDto.failure(
                    "Aucune clé OpenAI configurée (openai.key).");
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(apiKey.trim());
        HttpEntity<Void> entity = new HttpEntity<>(headers);
        try {
            ResponseEntity<String> response =
                    restTemplate.exchange(creditGrantsUrl.trim(), HttpMethod.GET, entity, String.class);
            String body = response.getBody();
            if (body == null || body.isBlank()) {
                return AssistantOpenAiCreditsDto.failure("Réponse vide de l’API crédits OpenAI.");
            }
            JsonNode root = objectMapper.readTree(body);

            JsonNode err = root.get("error");
            if (err != null && err.isObject()) {
                String msg = err.path("message").asText("Erreur OpenAI billing");
                return AssistantOpenAiCreditsDto.failure(msg);
            }

            if ("credit_summary".equals(root.path("object").asText())) {
                double granted = root.path("total_granted").asDouble(Double.NaN);
                double used = root.path("total_used").asDouble(Double.NaN);
                double avail = root.path("total_available").asDouble(Double.NaN);
                if (!Double.isNaN(avail) || !Double.isNaN(used) || !Double.isNaN(granted)) {
                    Double g = Double.isNaN(granted) ? null : granted;
                    Double u = Double.isNaN(used) ? null : used;
                    Double a = Double.isNaN(avail) ? null : avail;
                    return AssistantOpenAiCreditsDto.success(a, g, u);
                }
            }

            log.debug("credit_grants body unexpected shape: {}",
                    body.length() > 500 ? body.substring(0, 500) : body);
            return AssistantOpenAiCreditsDto.failure(
                    "Réponse OpenAI crédits non reconnue. Vérifiez votre clé / organisation ou la doc billing.");
        } catch (HttpStatusCodeException e) {
            String responseBody = e.getResponseBodyAsString();
            if (e.getStatusCode().value() == 403
                    && isCreditGrantsForbiddenForSecretKey(responseBody)) {
                log.info(
                        "OpenAI credit_grants: 403 for secret API key (OpenAI requires a browser session key for this endpoint).");
                return AssistantOpenAiCreditsDto.failure(
                        "Solde non synchronisable avec une clé API secrète (serveur). Consultez votre facturation sur https://platform.openai.com/account/billing");
            }
            log.warn("OpenAI credit_grants HTTP {} — {}", e.getStatusCode(),
                    shorten(responseBody, 400));
            String hint = this.shortErrorHint(responseBody);
            return AssistantOpenAiCreditsDto.failure(
                    "Crédits indisponibles (" + e.getStatusCode().value() + ")"
                            + (hint != null ? " : " + hint : "."));
        } catch (Exception e) {
            log.warn("Failed to fetch OpenAI credits", e);
            return AssistantOpenAiCreditsDto.failure(
                    "Impossible de joindre l’API des crédits OpenAI.");
        }
    }

    /**
     * Réponse 403 typique lorsque la clé est une API key « secret » (sk-…)
     * au lieu d’une session key navigateur.
     */
    private static boolean isCreditGrantsForbiddenForSecretKey(String responseBody) {
        if (responseBody == null || responseBody.isBlank()) {
            return false;
        }
        String lower = responseBody.toLowerCase();
        return lower.contains("credit_grants")
                && (lower.contains("session key")
                        || lower.contains("made with a session key")
                        || lower.contains("following key type: secret"));
    }

    private String shortErrorHint(String responseBody) {
        if (responseBody == null || responseBody.length() > 2400) {
            return null;
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode err = root.get("error");
            if (err != null && err.has("message")) {
                String m = err.get("message").asText(null);
                return m != null && !m.isBlank() ? m : null;
            }
        } catch (Exception ignored) {
            /* ignore */
        }
        return null;
    }

    private static String shorten(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }
}
