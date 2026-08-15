package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Proxy for Wikipedia REST search and summaries (read-only). The browser never
 * calls wikipedia.org directly (CSP {@code connect-src} is limited to this API).
 * A missing page is a normal empty result, not a 502.
 */
@Service
public class WikiProxyService {

    private static final Logger log = LoggerFactory.getLogger(WikiProxyService.class);
    private static final Pattern SAFE_TITLE = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{Z}_]{1,160}$");
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");
    private static final Set<String> SAFE_LANGS = Set.of(
            "fr", "en", "de", "es", "it", "ru", "ja", "zh", "ar", "he", "el", "hi"
    );
    private static final String USER_AGENT = "PatTool/1.0 (wikipedia helper; https://www.patrickdeschamps.com)";
    private static final int DEFAULT_SEARCH_LIMIT = 10;
    private static final int MAX_SEARCH_LIMIT = 20;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    public WikiProxyService(RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public JsonNode search(String query, String lang, Integer limit) {
        String trimmed = query == null ? "" : query.trim();
        String code = normalizeLang(lang);
        int n = clampLimit(limit);
        if (!StringUtils.hasText(trimmed)) {
            return emptySearch(trimmed, code);
        }
        if (!SAFE_TITLE.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_query");
        }
        String encoded = URLEncoder.encode(trimmed, StandardCharsets.UTF_8).replace("+", "%20");
        String url = "https://" + code + ".wikipedia.org/w/rest.php/v1/search/page?q=" + encoded + "&limit=" + n;
        JsonNode raw = fetchJson(url, "search " + trimmed, code);
        return mapSearch(trimmed, code, raw);
    }

    public JsonNode fetchSummary(String title, String lang) {
        String trimmed = title == null ? "" : title.trim();
        if (!SAFE_TITLE.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_title");
        }
        String code = normalizeLang(lang);
        JsonNode first = fetchOne(trimmed, code);
        if (isUsable(first)) {
            return first;
        }
        if (!"en".equals(code)) {
            JsonNode fallback = fetchOne(trimmed, "en");
            if (isUsable(fallback)) {
                return fallback;
            }
        }
        return objectMapper.createObjectNode();
    }

    private JsonNode fetchOne(String title, String code) {
        String encoded = URLEncoder.encode(title.replace(' ', '_'), StandardCharsets.UTF_8).replace("+", "%20");
        String url = "https://" + code + ".wikipedia.org/api/rest_v1/page/summary/" + encoded;
        return fetchJson(url, title, code);
    }

    private JsonNode fetchJson(String url, String label, String code) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set("Api-User-Agent", USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    String.class
            );
            String body = response.getBody();
            if (!StringUtils.hasText(body)) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (HttpStatusCodeException e) {
            if (e.getStatusCode() == HttpStatus.NOT_FOUND) {
                log.debug("Wikipedia page missing for {} ({}): {}", label, code, e.getStatusCode());
                return objectMapper.nullNode();
            }
            log.warn("Wikipedia HTTP {} for {} ({}): {}", e.getStatusCode().value(), label, code, e.getMessage());
            return objectMapper.nullNode();
        } catch (RestClientException e) {
            log.warn("Wikipedia unavailable for {} ({}): {}", label, code, e.getMessage());
            return objectMapper.nullNode();
        } catch (Exception e) {
            log.warn("Wikipedia parse failed for {} ({}): {}", label, code, e.getMessage());
            return objectMapper.nullNode();
        }
    }

    private JsonNode mapSearch(String query, String lang, JsonNode raw) {
        var root = objectMapper.createObjectNode();
        root.put("query", query);
        root.put("lang", lang);
        var pages = objectMapper.createArrayNode();
        root.set("pages", pages);
        if (raw == null || !raw.isObject()) {
            return root;
        }
        JsonNode list = raw.get("pages");
        if (list == null || !list.isArray()) {
            return root;
        }
        for (JsonNode page : list) {
            if (page == null || !page.isObject()) {
                continue;
            }
            var item = objectMapper.createObjectNode();
            if (page.has("id") && page.get("id").canConvertToInt()) {
                item.put("id", page.get("id").asInt());
            }
            putText(item, "key", page.get("key"));
            putText(item, "title", page.get("title"));
            item.put("excerpt", stripHtml(textOrEmpty(page.get("excerpt"))));
            putText(item, "description", page.get("description"));
            String thumb = thumbnailUrl(page.get("thumbnail"));
            if (StringUtils.hasText(thumb)) {
                item.put("thumbnailUrl", thumb);
            }
            if (item.has("title") || item.has("key")) {
                pages.add(item);
            }
        }
        return root;
    }

    private JsonNode emptySearch(String query, String lang) {
        var root = objectMapper.createObjectNode();
        root.put("query", query);
        root.put("lang", lang);
        root.set("pages", objectMapper.createArrayNode());
        return root;
    }

    private static void putText(ObjectNode target, String field, JsonNode node) {
        String value = textOrEmpty(node);
        if (StringUtils.hasText(value)) {
            target.put(field, value);
        }
    }

    private static String textOrEmpty(JsonNode node) {
        return node != null && node.isTextual() ? node.asText() : "";
    }

    private static String stripHtml(String html) {
        if (!StringUtils.hasText(html)) {
            return "";
        }
        return HTML_TAG.matcher(html)
                .replaceAll("")
                .replace("&quot;", "\"")
                .replace("&#039;", "'")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&nbsp;", " ")
                .trim();
    }

    private static String thumbnailUrl(JsonNode thumbnail) {
        if (thumbnail == null || !thumbnail.isObject()) {
            return "";
        }
        String url = textOrEmpty(thumbnail.get("url"));
        if (!StringUtils.hasText(url)) {
            url = textOrEmpty(thumbnail.get("source"));
        }
        if (url.startsWith("//")) {
            return "https:" + url;
        }
        return url;
    }

    private static int clampLimit(Integer limit) {
        if (limit == null) {
            return DEFAULT_SEARCH_LIMIT;
        }
        return Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit));
    }

    private static boolean isUsable(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode() || !node.isObject()) {
            return false;
        }
        JsonNode extract = node.get("extract");
        JsonNode description = node.get("description");
        JsonNode title = node.get("title");
        return (extract != null && extract.isTextual() && StringUtils.hasText(extract.asText()))
                || (description != null && description.isTextual() && StringUtils.hasText(description.asText()))
                || (title != null && title.isTextual() && StringUtils.hasText(title.asText()));
    }

    private static String normalizeLang(String lang) {
        if (!StringUtils.hasText(lang)) {
            return "fr";
        }
        String code = lang.trim().toLowerCase(Locale.ROOT);
        if (code.startsWith("jp")) {
            code = "ja";
        } else if (code.startsWith("cn")) {
            code = "zh";
        } else if (code.startsWith("in")) {
            code = "hi";
        }
        if (code.length() > 2) {
            code = code.substring(0, 2);
        }
        return SAFE_LANGS.contains(code) ? code : "en";
    }
}
