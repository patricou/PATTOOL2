package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import com.pat.config.RestTemplateConfig;

import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Swiss place lookup via geo.admin.ch (communes and NPA).
 */
@Service
public class FoncierSuisseGeoService {

    private static final Logger log = LoggerFactory.getLogger(FoncierSuisseGeoService.class);
    private static final String USER_AGENT = "PatTool/1.0 (foncier-suisse; https://www.patrickdeschamps.com)";
    private static final int MAX_QUERY_LEN = 80;
    private static final int MAX_RESULTS = 8;
    private static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");
    private static final Pattern NPA = Pattern.compile("\\b(\\d{4})\\b");
    private static final Pattern CANTON = Pattern.compile("\\(([A-Z]{2})\\)\\s*$");
    private static final Pattern ZIP_LABEL = Pattern.compile("^(\\d{4})\\s*[-–]\\s*(.+)$");

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${app.foncier.geo-ch.api-base:https://api3.geo.admin.ch}")
    private String geoApiBase;

    public FoncierSuisseGeoService(
            @Qualifier(RestTemplateConfig.FONCIER_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public JsonNode searchPlaces(String query) {
        String trimmed = query == null ? "" : query.trim();
        ObjectNode root = objectMapper.createObjectNode();
        root.put("query", trimmed);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        if (!StringUtils.hasText(trimmed) || trimmed.length() < 2 || trimmed.length() > MAX_QUERY_LEN) {
            return root;
        }
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase(geoApiBase) + "/rest/services/api/SearchServer")
                .queryParam("searchText", trimmed)
                .queryParam("type", "locations")
                .queryParam("origins", "gg25,zipcode")
                .queryParam("sr", "4326")
                .queryParam("limit", MAX_RESULTS)
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "places " + trimmed);
        JsonNode results = raw == null ? null : raw.get("results");
        if (results == null || !results.isArray()) {
            return root;
        }
        for (JsonNode result : results) {
            ObjectNode item = mapPlace(result);
            if (item != null) {
                items.add(item);
            }
            if (items.size() >= MAX_RESULTS) {
                break;
            }
        }
        return root;
    }

    public ObjectNode geocode(String query, String postcode) {
        String q = query == null ? "" : query.trim();
        if (StringUtils.hasText(postcode) && StringUtils.hasText(q) && !q.contains(postcode.trim())) {
            q = postcode.trim() + " " + q;
        }
        JsonNode search = searchPlaces(q);
        JsonNode items = search.get("items");
        if (items != null && items.isArray() && items.size() > 0 && items.get(0).isObject()) {
            ObjectNode first = (ObjectNode) items.get(0);
            ObjectNode hit = objectMapper.createObjectNode();
            if (first.has("lat") && first.has("lon")) {
                hit.put("lat", first.get("lat").asDouble());
                hit.put("lon", first.get("lon").asDouble());
            }
            hit.put("label", FoncierGeoService.text(first.get("nom")));
            return hit.has("lat") ? hit : null;
        }
        return null;
    }

    private ObjectNode mapPlace(JsonNode result) {
        if (result == null || !result.isObject()) {
            return null;
        }
        JsonNode attrs = result.get("attrs");
        if (attrs == null || !attrs.isObject()) {
            return null;
        }
        String label = stripHtml(FoncierGeoService.text(attrs.get("label")));
        String detail = FoncierGeoService.text(attrs.get("detail"));
        if (!StringUtils.hasText(label) && !StringUtils.hasText(detail)) {
            return null;
        }
        String nom = communeName(label);
        if (!StringUtils.hasText(nom)) {
            nom = StringUtils.hasText(label) ? label : detail;
        }
        nom = FoncierImmoswipeProxyService.canonicalCity(nom);
        ObjectNode item = objectMapper.createObjectNode();
        String featureId = FoncierGeoService.text(attrs.get("featureId"));
        String npa = firstNpa(detail, label);
        item.put("code", StringUtils.hasText(featureId) ? featureId : npa);
        item.put("nom", nom);
        String canton = cantonOf(label);
        if (StringUtils.hasText(canton)) {
            item.put("departement", canton);
            item.put("departementCode", canton);
        }
        ArrayNode zips = objectMapper.createArrayNode();
        if (StringUtils.hasText(npa)) {
            zips.add(npa);
        }
        item.set("codesPostaux", zips);
        Double lat = number(attrs, "lat", "y");
        Double lon = number(attrs, "lon", "lng", "x");
        if (lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
            item.put("lat", lat);
            item.put("lon", lon);
        }
        return item;
    }

    private static String communeName(String label) {
        if (!StringUtils.hasText(label)) {
            return "";
        }
        String cleaned = label.trim();
        Matcher zip = ZIP_LABEL.matcher(cleaned);
        if (zip.matches()) {
            cleaned = zip.group(2).trim();
        }
        int paren = cleaned.lastIndexOf(" (");
        if (paren > 0 && cleaned.endsWith(")")) {
            return cleaned.substring(0, paren).trim();
        }
        return cleaned;
    }

    private static String cantonOf(String label) {
        if (!StringUtils.hasText(label)) {
            return "";
        }
        Matcher matcher = CANTON.matcher(label.trim());
        return matcher.find() ? matcher.group(1) : "";
    }

    private static String firstNpa(String... texts) {
        for (String text : texts) {
            if (!StringUtils.hasText(text)) {
                continue;
            }
            Matcher matcher = NPA.matcher(text);
            if (matcher.find()) {
                return matcher.group(1);
            }
        }
        return "";
    }

    private static String stripHtml(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        return HTML_TAG.matcher(raw).replaceAll("").trim();
    }

    private static Double number(JsonNode node, String... keys) {
        for (String key : keys) {
            JsonNode value = node.get(key);
            if (value != null && value.isNumber()) {
                return value.asDouble();
            }
            if (value != null && value.isTextual()) {
                try {
                    return Double.parseDouble(value.asText().trim());
                } catch (NumberFormatException ignored) {
                    // next key
                }
            }
        }
        return null;
    }

    private JsonNode fetchJson(URI uri, String label) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "application/json");
        headers.set("User-Agent", USER_AGENT);
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || !StringUtils.hasText(response.getBody())) {
                log.warn("geo.admin.ch {} failed: HTTP {}", label, response.getStatusCode());
                return null;
            }
            return objectMapper.readTree(response.getBody());
        } catch (RestClientException ex) {
            log.warn("geo.admin.ch {} failed: {}", label, ex.getMessage());
            return null;
        } catch (Exception ex) {
            log.warn("geo.admin.ch {} parse failed: {}", label, ex.getMessage());
            return null;
        }
    }

    private static String trimBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://api3.geo.admin.ch";
        }
        return base.trim().replaceAll("/+$", "");
    }
}
