package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Commune lookup via geo.api.gouv.fr (INSEE code, postal codes).
 */
@Service
public class FoncierGeoService {

    private static final Logger log = LoggerFactory.getLogger(FoncierGeoService.class);
    private static final String USER_AGENT = "PatTool/1.0 (foncier; https://www.patrickdeschamps.com)";
    private static final int MAX_QUERY_LEN = 80;
    private static final int MAX_RESULTS = 8;
    private static final String COMMUNE_FIELDS = "nom,code,codesPostaux,population,departement,centre";
    private static final String BAN_BASE = "https://api-adresse.data.gouv.fr";
    private static final int BAN_CACHE_MAX = 256;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final Map<String, ObjectNode> banCache = new ConcurrentHashMap<>();
    private final Map<String, ObjectNode> inseeCache = new ConcurrentHashMap<>();
    private final Map<String, List<ObjectNode>> departmentCommunesCache = new ConcurrentHashMap<>();
    private final Map<String, List<String>> departmentCodesNearCache = new ConcurrentHashMap<>();

    @Value("${app.foncier.geo.api-base:https://geo.api.gouv.fr}")
    private String geoApiBase;

    public FoncierGeoService(RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public JsonNode searchCommunes(String query) {
        String trimmed = query == null ? "" : query.trim();
        ObjectNode root = objectMapper.createObjectNode();
        root.put("query", trimmed);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        if (!StringUtils.hasText(trimmed) || trimmed.length() < 2 || trimmed.length() > MAX_QUERY_LEN) {
            return root;
        }
        if (trimmed.matches("\\d{5}")) {
            addUniqueCommune(items, communeByInsee(trimmed));
            JsonNode byZip = fetchJson(UriComponentsBuilder.fromHttpUrl(trimBase(geoApiBase) + "/communes")
                    .queryParam("codePostal", trimmed)
                    .queryParam("fields", COMMUNE_FIELDS)
                    .queryParam("boost", "population")
                    .queryParam("limit", MAX_RESULTS)
                    .build()
                    .encode()
                    .toUri(), "codePostal " + trimmed);
            addCommunes(items, byZip);
            return root;
        }
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase(geoApiBase) + "/communes")
                .queryParam("nom", trimmed)
                .queryParam("fields", COMMUNE_FIELDS)
                .queryParam("boost", "population")
                .queryParam("limit", MAX_RESULTS)
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "communes " + trimmed);
        addCommunes(items, raw);
        return root;
    }

    public ObjectNode communeByInsee(String codeInsee) {
        if (codeInsee == null || !codeInsee.trim().matches("\\d{5}")) {
            return null;
        }
        String key = codeInsee.trim();
        ObjectNode cached = inseeCache.get(key);
        if (cached != null) {
            return cached.deepCopy();
        }
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase(geoApiBase) + "/communes/" + key)
                .queryParam("fields", COMMUNE_FIELDS)
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "insee " + key);
        ObjectNode mapped = mapCommune(raw);
        if (mapped != null) {
            inseeCache.put(key, mapped);
        }
        return mapped == null ? null : mapped.deepCopy();
    }

    public ObjectNode resolveCommune(String query) {
        if (!StringUtils.hasText(query)) {
            return null;
        }
        String trimmed = query.trim();
        if (trimmed.matches("\\d{5}")) {
            URI uri = UriComponentsBuilder.fromHttpUrl(trimBase(geoApiBase) + "/communes")
                    .queryParam("codePostal", trimmed)
                    .queryParam("fields", COMMUNE_FIELDS)
                    .queryParam("boost", "population")
                    .queryParam("limit", 1)
                    .build()
                    .encode()
                    .toUri();
            JsonNode raw = fetchJson(uri, "codePostal " + trimmed);
            if (raw != null && raw.isArray() && raw.size() > 0) {
                return mapCommune(raw.get(0));
            }
        }
        JsonNode search = searchCommunes(trimmed);
        JsonNode items = search.get("items");
        if (items != null && items.isArray() && items.size() > 0 && items.get(0).isObject()) {
            return (ObjectNode) items.get(0);
        }
        return null;
    }

    public ObjectNode mapCommune(JsonNode node) {
        if (node == null || !node.isObject()) {
            return null;
        }
        String code = text(node.get("code"));
        String nom = text(node.get("nom"));
        if (!StringUtils.hasText(code) || !StringUtils.hasText(nom)) {
            return null;
        }
        ObjectNode item = objectMapper.createObjectNode();
        item.put("code", code);
        item.put("nom", nom);
        JsonNode dept = node.get("departement");
        if (dept != null && dept.isObject()) {
            item.put("departement", text(dept.get("nom")));
            item.put("departementCode", text(dept.get("code")));
        }
        if (node.has("population") && node.get("population").canConvertToInt()) {
            item.put("population", node.get("population").asInt());
        }
        ArrayNode zips = objectMapper.createArrayNode();
        JsonNode codesPostaux = node.get("codesPostaux");
        if (codesPostaux != null && codesPostaux.isArray()) {
            for (JsonNode zip : codesPostaux) {
                String value = text(zip);
                if (StringUtils.hasText(value)) {
                    zips.add(value);
                }
            }
        }
        item.set("codesPostaux", zips);
        copyCoordinates(item, node.get("centre"));
        copyCoordinates(item, node);
        return item;
    }

    private void addCommunes(ArrayNode items, JsonNode raw) {
        if (raw == null || !raw.isArray()) {
            return;
        }
        for (JsonNode node : raw) {
            addUniqueCommune(items, mapCommune(node));
        }
    }

    private void addUniqueCommune(ArrayNode items, ObjectNode item) {
        if (items == null || item == null) {
            return;
        }
        String code = text(item.get("code"));
        if (!StringUtils.hasText(code)) {
            return;
        }
        for (JsonNode existing : items) {
            if (code.equals(text(existing.get("code")))) {
                return;
            }
        }
        items.add(item);
    }

    public ObjectNode geocodeBan(String query, String postcode) {
        String q = query == null ? "" : query.trim();
        if (!StringUtils.hasText(q) || q.length() > 160) {
            return null;
        }
        String zip = postcode == null ? "" : postcode.trim();
        String cacheKey = (q + "|" + zip).toLowerCase();
        ObjectNode cached = banCache.get(cacheKey);
        if (cached != null) {
            return cached.deepCopy();
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(BAN_BASE + "/search/")
                .queryParam("q", q)
                .queryParam("limit", 1)
                .queryParam("autocomplete", 0);
        if (zip.matches("\\d{5}")) {
            builder.queryParam("postcode", zip);
        }
        JsonNode raw = fetchJson(builder.build().encode().toUri(), "ban " + q);
        if (raw == null || !raw.isObject()) {
            return null;
        }
        JsonNode features = raw.get("features");
        if (features == null || !features.isArray() || features.size() == 0) {
            return null;
        }
        JsonNode feature = features.get(0);
        ObjectNode hit = objectMapper.createObjectNode();
        if (!copyCoordinates(hit, feature)) {
            return null;
        }
        JsonNode props = feature.get("properties");
        if (props != null && props.isObject()) {
            String label = text(props.get("label"));
            if (StringUtils.hasText(label)) {
                hit.put("label", label);
            }
        }
        if (banCache.size() >= BAN_CACHE_MAX) {
            banCache.clear();
        }
        banCache.put(cacheKey, hit.deepCopy());
        return hit;
    }

    public boolean copyCoordinates(ObjectNode target, JsonNode source) {
        if (target == null || source == null || source.isNull()) {
            return false;
        }
        if (target.has("lat") && target.has("lon")) {
            return true;
        }
        if (source.isObject()) {
            Double lat = firstNumber(source, "lat", "latitude");
            Double lon = firstNumber(source, "lon", "lng", "longitude");
            if (lat != null && lon != null && validLatLon(lat, lon)) {
                target.put("lat", lat);
                target.put("lon", lon);
                return true;
            }
            if (copyCoordinates(target, source.get("location"))
                    || copyCoordinates(target, source.get("locations"))
                    || copyCoordinates(target, source.get("geo"))
                    || copyCoordinates(target, source.get("coordinates"))
                    || copyCoordinates(target, source.get("geometry"))
                    || copyCoordinates(target, source.get("geom"))) {
                return true;
            }
        }
        if (source.isArray() && source.size() >= 2 && source.get(0).isNumber() && source.get(1).isNumber()) {
            double a = source.get(0).asDouble();
            double b = source.get(1).asDouble();
            if (validLatLon(b, a)) {
                target.put("lat", b);
                target.put("lon", a);
                return true;
            }
            if (validLatLon(a, b)) {
                target.put("lat", a);
                target.put("lon", b);
                return true;
            }
        }
        return false;
    }

    public void applyCoordinates(ObjectNode item, JsonNode row, String fallbackQuery, String postcode) {
        if (item == null) {
            return;
        }
        if (copyCoordinates(item, row)) {
            return;
        }
        ObjectNode ban = geocodeBan(fallbackQuery, postcode);
        if (ban != null) {
            item.put("lat", ban.get("lat").asDouble());
            item.put("lon", ban.get("lon").asDouble());
        }
    }

    private static Double firstNumber(JsonNode node, String... fields) {
        for (String field : fields) {
            JsonNode value = node.get(field);
            if (value == null || value.isNull()) {
                continue;
            }
            if (value.isNumber()) {
                return value.asDouble();
            }
            if (value.isTextual()) {
                try {
                    return Double.parseDouble(value.asText().replace(",", ".").trim());
                } catch (NumberFormatException ignored) {
                    // skip
                }
            }
        }
        return null;
    }

    private static boolean validLatLon(double lat, double lon) {
        return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && (lat != 0 || lon != 0);
    }

    public static int clampRadiusKm(Integer radiusKm) {
        if (radiusKm == null || radiusKm <= 0) {
            return 0;
        }
        return Math.min(50, Math.max(1, radiusKm));
    }

    public ObjectNode centerOf(String codeInsee, String query) {
        ObjectNode commune = StringUtils.hasText(codeInsee) && codeInsee.trim().matches("\\d{5}")
                ? communeByInsee(codeInsee.trim())
                : resolveCommune(query);
        if (commune == null) {
            return null;
        }
        if (commune.has("lat") && commune.has("lon")) {
            return commune;
        }
        String zip = "";
        List<String> zips = zipcodesOf(commune);
        if (!zips.isEmpty()) {
            zip = zips.get(0);
        }
        ObjectNode ban = geocodeBan(text(commune.get("nom")), zip);
        if (ban != null) {
            commune.put("lat", ban.get("lat").asDouble());
            commune.put("lon", ban.get("lon").asDouble());
        }
        return commune;
    }

    /**
     * INSEE department codes that intersect the circle (center + bounding-box corners).
     */
    public List<String> departmentCodesNear(double lat, double lon, double radiusKm) {
        double radius = Math.max(0.5, Math.min(radiusKm, 50));
        String cacheKey = Math.round(lat * 1000) + ":" + Math.round(lon * 1000) + ":" + Math.round(radius);
        List<String> cached = departmentCodesNearCache.get(cacheKey);
        if (cached != null) {
            return cached;
        }
        Set<String> deptCodes = new LinkedHashSet<>();
        GeoBbox box = bboxAround(lat, lon, radius);
        addDept(deptCodes, communeAt(lat, lon));
        addDept(deptCodes, communeAt(box.south, box.west));
        addDept(deptCodes, communeAt(box.south, box.east));
        addDept(deptCodes, communeAt(box.north, box.west));
        addDept(deptCodes, communeAt(box.north, box.east));
        List<String> out = new ArrayList<>(deptCodes);
        if (!out.isEmpty()) {
            departmentCodesNearCache.put(cacheKey, List.copyOf(out));
        }
        return out;
    }

    /**
     * Communes whose centre is within {@code radiusKm}.
     * geo.api.gouv.fr {@code /communes?lat=&lon=} only returns the commune containing
     * the point — {@code dist} is ignored — so we load department lists and filter.
     */
    public List<ObjectNode> communesNear(double lat, double lon, int radiusKm) {
        List<ObjectNode> out = new ArrayList<>();
        double radius = Math.max(1, Math.min(radiusKm, 50));
        Set<String> deptCodes = new LinkedHashSet<>(departmentCodesNear(lat, lon, radius));
        ObjectNode here = communeAt(lat, lon);
        if (deptCodes.isEmpty() && here != null) {
            out.add(here);
            return out;
        }
        for (String dept : deptCodes) {
            for (ObjectNode commune : communesOfDepartment(dept)) {
                if (commune == null || !commune.has("lat") || !commune.has("lon")) {
                    continue;
                }
                if (distanceKm(lat, lon, commune.get("lat").asDouble(), commune.get("lon").asDouble())
                        <= radius + 0.3) {
                    out.add(commune);
                }
            }
        }
        return out;
    }

    public List<String> postalCodesNear(double lat, double lon, int radiusKm, String excludeZip) {
        LinkedHashSet<String> zips = new LinkedHashSet<>();
        String skip = excludeZip == null ? "" : excludeZip.trim();
        for (ObjectNode commune : communesNear(lat, lon, radiusKm)) {
            for (String zip : zipcodesOf(commune)) {
                if (!zip.isEmpty() && !zip.equals(skip)) {
                    zips.add(zip);
                }
            }
        }
        return new ArrayList<>(zips);
    }

    private ObjectNode communeAt(double lat, double lon) {
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase(geoApiBase) + "/communes")
                .queryParam("lat", lat)
                .queryParam("lon", lon)
                .queryParam("fields", COMMUNE_FIELDS)
                .queryParam("limit", 1)
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "communeAt " + lat + "," + lon);
        if (raw == null || !raw.isArray() || raw.size() == 0) {
            return null;
        }
        return mapCommune(raw.get(0));
    }

    private List<ObjectNode> communesOfDepartment(String deptCode) {
        if (!StringUtils.hasText(deptCode)) {
            return List.of();
        }
        List<ObjectNode> cached = departmentCommunesCache.get(deptCode);
        if (cached != null) {
            return cached;
        }
        URI uri = UriComponentsBuilder
                .fromHttpUrl(trimBase(geoApiBase) + "/departements/" + deptCode + "/communes")
                .queryParam("fields", COMMUNE_FIELDS)
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "dept " + deptCode);
        List<ObjectNode> list = new ArrayList<>();
        if (raw == null || !raw.isArray()) {
            return list;
        }
        for (JsonNode node : raw) {
            ObjectNode item = mapCommune(node);
            if (item == null) {
                continue;
            }
            if (!item.has("departementCode")) {
                item.put("departementCode", deptCode);
            }
            list.add(item);
        }
        if (!list.isEmpty()) {
            departmentCommunesCache.put(deptCode, list);
        }
        return list;
    }

    private static void addDept(Set<String> deptCodes, ObjectNode commune) {
        if (commune == null) {
            return;
        }
        String code = text(commune.get("departementCode"));
        if (StringUtils.hasText(code)) {
            deptCodes.add(code);
        }
    }

    public static GeoBbox bboxAround(double lat, double lon, double radiusKm) {
        double r = Math.max(0.5, Math.min(radiusKm, 50));
        double dLat = r / 111.32;
        double cos = Math.cos(Math.toRadians(lat));
        double dLon = r / (111.32 * Math.max(0.2, Math.abs(cos)));
        return new GeoBbox(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
    }

    public static double distanceKm(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371.0;
        double p1 = Math.toRadians(lat1);
        double p2 = Math.toRadians(lat2);
        double dp = Math.toRadians(lat2 - lat1);
        double dl = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2)
                + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    public static final class GeoBbox {
        public final double south;
        public final double west;
        public final double north;
        public final double east;

        public GeoBbox(double south, double west, double north, double east) {
            this.south = south;
            this.west = west;
            this.north = north;
            this.east = east;
        }

        /** Cerema / DVF+ : min_lon,min_lat,max_lon,max_lat */
        public String cerema() {
            return west + "," + south + "," + east + "," + north;
        }

        /** ChercherTrouver : sud,ouest,nord,est */
        public String chercherTrouver() {
            return south + "," + west + "," + north + "," + east;
        }
    }

    public List<String> zipcodesOf(JsonNode commune) {
        List<String> zips = new ArrayList<>();
        if (commune == null) {
            return zips;
        }
        JsonNode codes = commune.get("codesPostaux");
        if (codes != null && codes.isArray()) {
            for (JsonNode zip : codes) {
                String value = text(zip);
                if (StringUtils.hasText(value)) {
                    zips.add(value);
                }
            }
        }
        return zips;
    }

    private JsonNode fetchJson(URI uri, String label) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "application/json");
        headers.set("User-Agent", USER_AGENT);
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || !StringUtils.hasText(response.getBody())) {
                log.warn("Foncier geo {} failed: HTTP {}", label, response.getStatusCode());
                return null;
            }
            return objectMapper.readTree(response.getBody());
        } catch (RestClientException ex) {
            log.warn("Foncier geo {} error: {}", label, ex.getMessage());
            return null;
        } catch (Exception ex) {
            log.warn("Foncier geo {} parse error: {}", label, ex.getMessage());
            return null;
        }
    }

    private static String trimBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://geo.api.gouv.fr";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    static String text(JsonNode node) {
        if (node == null || node.isNull()) {
            return "";
        }
        if (node.isTextual()) {
            return node.asText().trim();
        }
        if (node.isNumber()) {
            return node.asText();
        }
        return "";
    }
}
