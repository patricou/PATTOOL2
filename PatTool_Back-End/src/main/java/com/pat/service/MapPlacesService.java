package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.config.RestTemplateConfig;
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
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;

/**
 * Monuments, sights and airfields for the trace viewer.
 * Public Overpass mirrors reject or empty-answer browser calls, so the query runs here.
 */
@Service
public class MapPlacesService {

    private static final Logger log = LoggerFactory.getLogger(MapPlacesService.class);
    private static final String USER_AGENT = "PatTool/1.0 (map places; https://www.patrickdeschamps.com)";
    private static final int MAX_BYTES = 2_000_000;
    private static final double MAX_LON_SPAN = 1.0;
    private static final double MAX_LAT_SPAN = 0.8;
    private static final String[] TAGS = {
            "name", "name:fr", "name:en", "ref", "historic", "tourism", "aeroway",
            "wikidata", "wikipedia", "wikimedia_commons", "image"
    };

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final List<String> overpassUrls;

    public MapPlacesService(
            @Qualifier(RestTemplateConfig.RELIEF_FINDER_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper,
            @Value("${map.places.overpass-urls:https://overpass.openstreetmap.fr/api/interpreter,https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter}")
                    String overpassUrlsCsv) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.overpassUrls = parseCsv(overpassUrlsCsv);
    }

    public JsonNode places(double south, double west, double north, double east) {
        if (!boxOk(south, west, north, east)) {
            return empty();
        }
        String query = query(south, west, north, east);
        for (String url : overpassUrls) {
            try {
                JsonNode parsed = post(url, query);
                if (usable(parsed)) {
                    return slim(parsed);
                }
                log.debug("Overpass {} skipped (empty or stale database)", url);
            } catch (Exception e) {
                log.debug("Overpass {} failed: {}", url, e.toString());
            }
        }
        return empty();
    }

    private JsonNode post(String url, String query) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, USER_AGENT);
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        HttpEntity<String> entity = new HttpEntity<>(
                "data=" + URLEncoder.encode(query, StandardCharsets.UTF_8), headers);
        ResponseEntity<byte[]> response = restTemplate.exchange(url, HttpMethod.POST, entity, byte[].class);
        byte[] body = response.getBody();
        if (body == null || body.length == 0 || body.length > MAX_BYTES) {
            return null;
        }
        return objectMapper.readTree(body);
    }

    /** A live mirror stamps an ISO time. A broken one answers 200 with a token like "118637" and no elements. */
    private static boolean usable(JsonNode root) {
        if (root == null || !root.path("elements").isArray()) {
            return false;
        }
        String stamp = root.path("osm3s").path("timestamp_osm_base").asText("");
        return stamp.length() >= 20 && stamp.charAt(4) == '-' && stamp.charAt(10) == 'T';
    }

    private ObjectNode slim(JsonNode root) {
        ObjectNode out = objectMapper.createObjectNode();
        ArrayNode elements = out.putArray("elements");
        for (JsonNode element : root.path("elements")) {
            if (elements.size() >= 120) {
                break;
            }
            ObjectNode row = elements.addObject();
            if (element.hasNonNull("lat")) {
                row.put("lat", element.path("lat").asDouble());
            }
            if (element.hasNonNull("lon")) {
                row.put("lon", element.path("lon").asDouble());
            }
            JsonNode center = element.path("center");
            if (center.hasNonNull("lat") && center.hasNonNull("lon")) {
                ObjectNode c = row.putObject("center");
                c.put("lat", center.path("lat").asDouble());
                c.put("lon", center.path("lon").asDouble());
            }
            ObjectNode tags = row.putObject("tags");
            JsonNode source = element.path("tags");
            for (String key : TAGS) {
                if (source.hasNonNull(key)) {
                    tags.put(key, source.path(key).asText());
                }
            }
        }
        return out;
    }

    private ObjectNode empty() {
        ObjectNode out = objectMapper.createObjectNode();
        out.putArray("elements");
        return out;
    }

    private static boolean boxOk(double south, double west, double north, double east) {
        return Double.isFinite(south) && Double.isFinite(west) && Double.isFinite(north) && Double.isFinite(east)
                && south >= -85 && north <= 85 && west >= -180 && east <= 180
                && north > south && east > west
                && east - west <= MAX_LON_SPAN && north - south <= MAX_LAT_SPAN;
    }

    private static String query(double south, double west, double north, double east) {
        String box = String.format(Locale.US, "(%.5f,%.5f,%.5f,%.5f)", south, west, north, east);
        return """
                [out:json][timeout:18];
                (
                  node["historic"~"^(monument|memorial|castle|ruins|archaeological_site|fort|monastery|battlefield|manor|palace|city_gate)$"]%s;
                  node["tourism"~"^(attraction|museum|viewpoint|gallery)$"]%s;
                  node["aeroway"~"^(aerodrome|heliport)$"]%s;
                  way["aeroway"~"^(aerodrome|heliport)$"]%s;
                );
                out center 120;
                """.formatted(box, box, box, box);
    }

    private static List<String> parseCsv(String csv) {
        if (csv == null || csv.isBlank()) {
            return List.of("https://overpass.openstreetmap.fr/api/interpreter");
        }
        return java.util.Arrays.stream(csv.split(","))
                .map(String::trim)
                .filter(part -> !part.isEmpty())
                .toList();
    }
}
