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
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Cerema DVF+ open data — past property sales (no API key).
 */
@Service
public class FoncierCeremaProxyService {

    private static final Logger log = LoggerFactory.getLogger(FoncierCeremaProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (foncier; https://www.patrickdeschamps.com)";
    private static final int DEFAULT_PAGE_SIZE = 40;
    private static final int MAX_PAGE_SIZE = 80;
    private static final Set<String> TYPE_LOCALS = Set.of("maison", "appartement", "local", "dependance");

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final FoncierGeoService geoService;

    @Value("${app.foncier.cerema.api-base:https://apidf-preprod.cerema.fr}")
    private String apiBase;

    public FoncierCeremaProxyService(
            @Qualifier(RestTemplateConfig.FONCIER_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper,
            FoncierGeoService geoService) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.geoService = geoService;
    }

    public JsonNode mutations(
            String codeInsee,
            String typeLocal,
            Integer page,
            Integer pageSize,
            Integer radiusKm,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Double lat,
            Double lon) {
        String insee = codeInsee == null ? "" : codeInsee.trim();
        int radius = FoncierGeoService.clampRadiusKm(radiusKm);
        boolean aroundPoint = radius > 0
                && lat != null && lon != null
                && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
        if (!aroundPoint && !insee.matches("\\d{5}")) {
            throw new IllegalArgumentException("invalid_insee");
        }
        String type = normalizeType(typeLocal);
        int p = page == null || page < 1 ? 1 : Math.min(page, 200);
        int size = pageSize == null ? DEFAULT_PAGE_SIZE : Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);

        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(trimBase(apiBase) + "/dvf_opendata/mutations/")
                .queryParam("page", p)
                .queryParam("page_size", size);
        URI primary = null;
        URI inseeFallback = insee.matches("\\d{5}")
                ? UriComponentsBuilder.fromHttpUrl(trimBase(apiBase) + "/dvf_opendata/mutations/")
                    .queryParam("page", p)
                    .queryParam("page_size", size)
                    .queryParam("code_insee", insee)
                    .build().encode().toUri()
                : null;
        if (aroundPoint) {
            FoncierGeoService.GeoBbox box = FoncierGeoService.bboxAround(lat, lon, radius);
            primary = builder.queryParam("in_bbox", box.cerema()).build().encode().toUri();
        } else {
            ObjectNode center = radius > 0 ? geoService.centerOf(insee, null) : null;
            if (radius > 0 && center != null && center.has("lat") && center.has("lon")) {
                FoncierGeoService.GeoBbox box = FoncierGeoService.bboxAround(
                        center.get("lat").asDouble(), center.get("lon").asDouble(), radius);
                primary = builder.queryParam("in_bbox", box.cerema()).build().encode().toUri();
            } else if (inseeFallback != null) {
                primary = inseeFallback;
                inseeFallback = null;
            }
        }
        if (primary == null) {
            throw new IllegalArgumentException("invalid_insee");
        }
        JsonNode raw = fetchJson(primary, "mutations " + (aroundPoint ? (lat + "," + lon) : insee));
        if (raw == null && inseeFallback != null && !inseeFallback.equals(primary)) {
            log.warn("Cerema bbox failed, falling back to code_insee {}", insee);
            raw = fetchJson(inseeFallback, "mutations " + insee);
        }
        if (raw == null) {
            throw new IllegalStateException("upstream_unavailable");
        }
        return mapMutations(insee, type, p, size, raw, priceMin, priceMax, surfaceMin);
    }

    private JsonNode mapMutations(
            String insee,
            String type,
            int page,
            int pageSize,
            JsonNode raw,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("codeInsee", insee);
        root.put("typeLocal", type);
        root.put("page", page);
        root.put("pageSize", pageSize);
        root.put("count", 0);
        root.put("hasNext", false);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        JsonNode results = collectionOf(raw);
        if (results == null) {
            return root;
        }
        if (raw != null && raw.isObject()) {
            root.put("count", intOr(raw.get("count"), results.size()));
            root.put("hasNext", StringUtils.hasText(FoncierGeoService.text(raw.get("next"))));
        } else {
            root.put("count", results.size());
        }
        ObjectNode commune = geoService.communeByInsee(insee);
        for (JsonNode row : results) {
            if (row != null && row.isObject() && row.has("properties") && row.get("properties").isObject()) {
                row = row.get("properties");
            }
            ObjectNode item = mapMutation(row, commune);
            if (item != null && matchesType(item, type) && matchesBudget(item, priceMin, priceMax, surfaceMin)) {
                items.add(item);
            }
        }
        return root;
    }

    private ObjectNode mapMutation(JsonNode row, ObjectNode commune) {
        if (row == null || !row.isObject()) {
            return null;
        }
        ObjectNode item = objectMapper.createObjectNode();
        putText(item, "id", first(row, "idmutation", "id"));
        putText(item, "date", first(row, "datemut", "date_mutation", "date"));
        putText(item, "nature", first(row, "libnatmut", "nature_mutation"));
        putText(item, "typeLocal", first(row, "libtyploc", "type_local", "libtypbien"));
        String address = firstAddress(row);
        String city = commune == null ? "" : FoncierGeoService.text(commune.get("nom"));
        String zip = "";
        List<String> zips = geoService.zipcodesOf(commune);
        if (!zips.isEmpty()) {
            zip = zips.get(0);
        }
        if (!StringUtils.hasText(zip)) {
            zip = FoncierGeoService.text(first(row, "l_codpost", "code_postal"));
        }
        if (StringUtils.hasText(address) && StringUtils.hasText(city) && !address.toLowerCase(Locale.ROOT).contains(city.toLowerCase(Locale.ROOT))) {
            address = address + ", " + (StringUtils.hasText(zip) ? zip + " " : "") + city;
        } else if (!StringUtils.hasText(address) && StringUtils.hasText(city)) {
            address = (StringUtils.hasText(zip) ? zip + " " : "") + city;
        }
        if (StringUtils.hasText(address)) {
            item.put("address", address);
        }
        putText(item, "insee", first(row, "codinsee", "code_insee", "l_codinsee"));
        if (!item.has("insee") && commune != null) {
            putText(item, "insee", commune.get("code"));
        }
        if (StringUtils.hasText(city)) {
            item.put("city", city);
        }
        if (StringUtils.hasText(zip)) {
            item.put("zipcode", zip);
        }
        if (looksLikeStreet(address)) {
            geoService.applyCoordinates(item, row, address, zip);
        } else {
            geoService.copyCoordinates(item, row);
        }
        if (commune != null && (!item.has("lat") || !item.has("lon"))) {
            geoService.copyCoordinates(item, commune);
        }
        putNumber(item, "price", first(row, "valeurfonc", "valeur_fonciere"));
        putNumber(item, "surface", first(row, "sbati", "surface_reelle_bati", "sbatmai"));
        putNumber(item, "rooms", first(row, "nbpprinc", "nombre_pieces_principales"));
        putNumber(item, "landSurface", first(row, "sterr", "surface_terrain"));
        Double price = item.has("price") ? item.get("price").asDouble() : null;
        Double surface = item.has("surface") ? item.get("surface").asDouble() : null;
        if (price != null && surface != null && surface > 0) {
            item.put("pricePerM2", BigDecimal.valueOf(price / surface)
                    .setScale(0, RoundingMode.HALF_UP).intValue());
        }
        return item;
    }

    private JsonNode fetchJson(URI uri, String label) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "application/json");
        headers.set("User-Agent", USER_AGENT);
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || !StringUtils.hasText(response.getBody())) {
                log.warn("Cerema {} failed: HTTP {}", label, response.getStatusCode());
                return null;
            }
            return objectMapper.readTree(response.getBody());
        } catch (HttpStatusCodeException ex) {
            log.warn("Cerema {} HTTP {}: {}", label, ex.getStatusCode(), ex.getStatusText());
            return null;
        } catch (RestClientException ex) {
            log.warn("Cerema {} error: {}", label, ex.getMessage());
            return null;
        } catch (Exception ex) {
            log.warn("Cerema {} parse error: {}", label, ex.getMessage());
            return null;
        }
    }

    private static String normalizeType(String typeLocal) {
        if (!StringUtils.hasText(typeLocal)) {
            return "";
        }
        String key = typeLocal.trim().toLowerCase(Locale.ROOT)
                .replace("dépendance", "dependance")
                .replace("dependance", "dependance");
        return TYPE_LOCALS.contains(key) ? key : "";
    }

    private static boolean matchesType(ObjectNode item, String type) {
        if (!StringUtils.hasText(type)) {
            return true;
        }
        String local = FoncierGeoService.text(item.get("typeLocal")).toLowerCase(Locale.ROOT);
        return local.contains(type);
    }

    private static boolean matchesBudget(ObjectNode item, Integer priceMin, Integer priceMax, Integer surfaceMin) {
        if (priceMin != null && item.has("price") && item.get("price").asDouble() < priceMin) {
            return false;
        }
        if (priceMax != null && item.has("price") && item.get("price").asDouble() > priceMax) {
            return false;
        }
        if (surfaceMin != null && item.has("surface") && item.get("surface").asDouble() < surfaceMin) {
            return false;
        }
        return true;
    }

    private static JsonNode collectionOf(JsonNode raw) {
        if (raw == null || raw.isNull()) {
            return null;
        }
        if (raw.isArray()) {
            return raw;
        }
        if (!raw.isObject()) {
            return null;
        }
        JsonNode list = first(raw, "results", "mutations", "items", "features", "hydra:member", "member");
        return list != null && list.isArray() ? list : null;
    }

    private static JsonNode first(JsonNode row, String... fields) {
        for (String field : fields) {
            JsonNode node = row.get(field);
            if (node != null && !node.isNull()) {
                return node;
            }
        }
        return null;
    }

    private static boolean looksLikeStreet(String address) {
        if (!StringUtils.hasText(address)) {
            return false;
        }
        String lower = address.toLowerCase(Locale.ROOT);
        return address.matches(".*\\d.*")
                || lower.matches(".*(rue|avenue|av\\.|boulevard|bd\\.|chemin|impasse|place|all[eé]e|route|quai).*");
    }

    private static String firstAddress(JsonNode row) {
        String composed = FoncierGeoService.text(first(row, "l_adresse", "adresse"));
        if (StringUtils.hasText(composed)) {
            return composed;
        }
        String num = FoncierGeoService.text(first(row, "numero_voie", "l_numvoie"));
        String voie = FoncierGeoService.text(first(row, "voie", "l_voie", "nom_voie"));
        String parts = (num + " " + voie).trim();
        return parts;
    }

    private static void putText(ObjectNode target, String field, JsonNode node) {
        String value = FoncierGeoService.text(node);
        if (StringUtils.hasText(value)) {
            target.put(field, value);
        }
    }

    private static void putNumber(ObjectNode target, String field, JsonNode node) {
        if (node == null || node.isNull()) {
            return;
        }
        if (node.isNumber()) {
            target.put(field, node.asDouble());
        } else if (node.isTextual()) {
            try {
                target.put(field, Double.parseDouble(node.asText().replace(",", ".").replace(" ", "")));
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
    }

    private static int intOr(JsonNode node, int fallback) {
        if (node != null && node.canConvertToInt()) {
            return node.asInt();
        }
        return fallback;
    }

    private static String trimBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://apidf-preprod.cerema.fr";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }
}
