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

import java.net.URI;
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
    private static final Pattern SAFE_TITLE = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{S}\\p{Z}_]{1,160}$");
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

    /**
     * Summary in {@code lang} when Wikipedia has that edition, otherwise the
     * article in the language the source actually provides (English, then French).
     */
    public JsonNode fetchSummary(String title, String lang) {
        String trimmed = title == null ? "" : title.trim();
        if (!SAFE_TITLE.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_title");
        }
        String want = normalizeLang(lang);

        // Prefer the user's language via EN interlanguage links: English titles
        // like "Mars" collide on other wikis (disambiguation / unrelated pages).
        // French uses catalogue titles already disambiguated (Mars_(planète)).
        if (!"en".equals(want) && !"fr".equals(want)) {
            JsonNode localized = fetchViaLanglink(trimmed, "en", want);
            if (isUsable(localized)) {
                return localized;
            }
        }

        JsonNode direct = fetchOne(trimmed, want);
        if (isUsable(direct)) {
            return direct;
        }

        if (!"fr".equals(want)) {
            JsonNode fromFrench = fetchViaLanglink(trimmed, "fr", want);
            if (isUsable(fromFrench)) {
                return fromFrench;
            }
        }

        if (!"en".equals(want)) {
            JsonNode english = fetchOne(trimmed, "en");
            if (isUsable(english)) {
                return english;
            }
            JsonNode englishFromFr = fetchViaLanglink(trimmed, "fr", "en");
            if (isUsable(englishFromFr)) {
                return englishFromFr;
            }
        }

        if (!"fr".equals(want)) {
            JsonNode french = fetchOne(trimmed, "fr");
            if (isUsable(french)) {
                return french;
            }
            JsonNode frenchFromEn = fetchViaLanglink(trimmed, "en", "fr");
            if (isUsable(frenchFromEn)) {
                return frenchFromEn;
            }
        }

        return objectMapper.createObjectNode();
    }

    private JsonNode fetchOne(String title, String code) {
        String encoded = encodeTitle(title);
        String url = "https://" + code + ".wikipedia.org/api/rest_v1/page/summary/" + encoded;
        return fetchJson(url, title, code);
    }

    /**
     * RestTemplate.exchange(String) re-encodes the URL. Titles with parentheses or
     * accents then become {@code %2528} / {@code %25C3} and Wikipedia REST answers
     * {@code 403 {"type":"Internal error"}}. Pass a prebuilt {@link URI} instead.
     */
    private JsonNode fetchJson(String url, String label, String code) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
            headers.set("Api-User-Agent", USER_AGENT);
            headers.set(HttpHeaders.ACCEPT, "application/json");
            ResponseEntity<String> response = restTemplate.exchange(
                    URI.create(url),
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
            if (isExpectedMiss(e)) {
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

    private JsonNode fetchViaLanglink(String title, String fromLang, String toLang) {
        String resolved = resolveLangTitle(title, fromLang, toLang);
        if (!StringUtils.hasText(resolved)) {
            return objectMapper.nullNode();
        }
        return fetchOne(resolved, toLang);
    }

    private String resolveLangTitle(String title, String fromLang, String toLang) {
        if (!StringUtils.hasText(title) || !StringUtils.hasText(fromLang) || !StringUtils.hasText(toLang)
                || fromLang.equals(toLang)) {
            return "";
        }
        String url = "https://" + fromLang + ".wikipedia.org/w/api.php?action=query&format=json&formatversion=2"
                + "&redirects=1&prop=langlinks&lllang=" + toLang + "&titles=" + encodeTitle(title);
        JsonNode raw = fetchJson(url, "langlinks " + title, fromLang);
        if (raw == null || !raw.isObject()) {
            return "";
        }
        JsonNode pages = raw.path("query").path("pages");
        if (!pages.isArray() || pages.isEmpty()) {
            return "";
        }
        JsonNode page = pages.get(0);
        if (page == null || page.path("missing").asBoolean(false)) {
            return "";
        }
        JsonNode links = page.get("langlinks");
        if (links == null || !links.isArray()) {
            return "";
        }
        for (JsonNode link : links) {
            if (link != null && toLang.equals(textOrEmpty(link.get("lang")))) {
                String resolved = textOrEmpty(link.get("title")).replace(' ', '_');
                if (StringUtils.hasText(resolved)) {
                    return resolved;
                }
            }
        }
        return "";
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

    private static String encodeTitle(String title) {
        return URLEncoder.encode(title.replace(' ', '_'), StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static boolean isExpectedMiss(HttpStatusCodeException e) {
        if (e.getStatusCode().isSameCodeAs(HttpStatus.NOT_FOUND)) {
            return true;
        }
        if (!e.getStatusCode().isSameCodeAs(HttpStatus.FORBIDDEN)) {
            return false;
        }
        String body = e.getResponseBodyAsString();
        return StringUtils.hasText(body) && body.contains("\"type\":\"Internal error\"");
    }

    private static boolean isUsable(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode() || !node.isObject() || node.isEmpty()) {
            return false;
        }
        if ("disambiguation".equalsIgnoreCase(textOrEmpty(node.get("type")))) {
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
