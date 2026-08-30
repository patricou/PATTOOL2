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
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URI;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * ChercherTrouver listings — API key stays server-side.
 */
@Service
public class FoncierChercherTrouverProxyService {

    private static final Logger log = LoggerFactory.getLogger(FoncierChercherTrouverProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (foncier; https://www.patrickdeschamps.com)";
    /** Free tier: 1 request/second. */
    private static final long MIN_INTERVAL_MS = 1100L;
    private final Object paceLock = new Object();
    private long lastCallMs;

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final FoncierGeoService geoService;

    @Value("${app.foncier.chercher-trouver.api-base:https://cherchertrouver.immo}")
    private String apiBase;

    @Value("${app.foncier.chercher-trouver.api-key:}")
    private String apiKey;

    public FoncierChercherTrouverProxyService(
            RestTemplate restTemplate,
            ObjectMapper objectMapper,
            FoncierGeoService geoService) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.geoService = geoService;
    }

    public boolean isConfigured() {
        return StringUtils.hasText(apiKey);
    }

    public JsonNode listings(
            String query,
            String type,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Integer surfaceMax,
            Integer page,
            String codeInsee,
            Integer radiusKm) {
        if (!isConfigured()) {
            throw new IllegalStateException("not_configured");
        }
        int p = page == null || page < 1 ? 1 : Math.min(page, 50);
        int radius = FoncierGeoService.clampRadiusKm(radiusKm);
        if (radius > 0) {
            return listingsAround(query, type, priceMin, priceMax, surfaceMin, surfaceMax, p, codeInsee, radius);
        }
        UriComponentsBuilder builder = annoncesBuilder(p);
        PlaceFilter place = applyPlace(builder, query, codeInsee);
        applyListingFilters(builder, type, priceMin, priceMax, surfaceMin, surfaceMax);
        JsonNode raw = fetchJson(builder.build().encode().toUri(), "annonces");
        return mapListings(p, raw, place, false, true);
    }

    private JsonNode listingsAround(
            String query,
            String type,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Integer surfaceMax,
            int page,
            String codeInsee,
            int radius) {
        ArrayNode merged = objectMapper.createArrayNode();
        ObjectNode center = geoService.centerOf(codeInsee, query);
        if (center == null || !center.has("lat") || !center.has("lon")) {
            UriComponentsBuilder local = annoncesBuilder(1);
            PlaceFilter communePlace = applyPlace(local, query, codeInsee);
            applyListingFilters(local, type, priceMin, priceMax, surfaceMin, surfaceMax);
            addUnique(merged, mapListings(1, fetchJson(local.build().encode().toUri(), "annonces"),
                    communePlace, false, true));
            return pageOf(merged, page);
        }

        double lat = center.get("lat").asDouble();
        double lon = center.get("lon").asDouble();
        FoncierGeoService.GeoBbox box = FoncierGeoService.bboxAround(lat, lon, radius);
        UriComponentsBuilder map = UriComponentsBuilder
                .fromHttpUrl(trimBase(apiBase) + "/api/v1/annonces/map")
                .queryParam("transaction", "vente");
        applyListingFilters(map, type, priceMin, priceMax, surfaceMin, surfaceMax);
        String mapUrl = map.build().encode().toUriString() + "&bbox=" + box.chercherTrouver();
        JsonNode mapPage = mapListings(1, fetchJson(URI.create(mapUrl), "annonces-map"),
                PlaceFilter.around(lat, lon, radius), false, false);
        addUnique(merged, mapPage);
        int fromMap = merged.size();

        UriComponentsBuilder local = annoncesBuilder(1);
        PlaceFilter communePlace = applyPlace(local, query, codeInsee);
        applyListingFilters(local, type, priceMin, priceMax, surfaceMin, surfaceMax);
        addUnique(merged, mapListings(1, fetchJson(local.build().encode().toUri(), "annonces"),
                communePlace, false, true));

        if (fromMap == 0) {
            List<String> originZips = geoService.zipcodesOf(center);
            String skip = originZips.isEmpty() ? "" : originZips.get(0);
            int extra = 0;
            for (String zip : geoService.postalCodesNear(lat, lon, radius, skip)) {
                if (extra >= 8) {
                    break;
                }
                UriComponentsBuilder around = annoncesBuilder(1);
                around.queryParam("cp", zip);
                applyListingFilters(around, type, priceMin, priceMax, surfaceMin, surfaceMax);
                addUnique(merged, mapListings(1, fetchJson(around.build().encode().toUri(), "annonces-near"),
                        PlaceFilter.none(), false, true));
                extra++;
            }
            log.info("ChercherTrouver radius {} km around {}/{}: map=0 nearbyCp={} merged={}",
                    radius, FoncierGeoService.text(center.get("nom")), codeInsee, extra, merged.size());
        } else {
            log.info("ChercherTrouver radius {} km around {}/{}: map={} merged={}",
                    radius, FoncierGeoService.text(center.get("nom")), codeInsee, fromMap, merged.size());
        }

        return pageOf(merged, page);
    }

    private UriComponentsBuilder annoncesBuilder(int page) {
        return UriComponentsBuilder
                .fromHttpUrl(trimBase(apiBase) + "/api/v1/annonces")
                .queryParam("page", page)
                .queryParam("page_size", 20)
                .queryParam("transaction", "vente");
    }

    private void applyListingFilters(
            UriComponentsBuilder builder,
            String type,
            Integer priceMin,
            Integer priceMax,
            Integer surfaceMin,
            Integer surfaceMax) {
        String mappedType = mapType(type);
        if (StringUtils.hasText(mappedType)) {
            builder.queryParam("type", mappedType);
        }
        if (priceMin != null && priceMin > 0) {
            builder.queryParam("prix_min", priceMin);
        }
        if (priceMax != null && priceMax > 0) {
            builder.queryParam("prix_max", priceMax);
        }
        if (surfaceMin != null && surfaceMin > 0) {
            builder.queryParam("surface_min", surfaceMin);
        }
        if (surfaceMax != null && surfaceMax > 0) {
            builder.queryParam("surface_max", surfaceMax);
        }
    }

    private void addUnique(ArrayNode target, JsonNode page) {
        JsonNode items = page == null ? null : page.get("items");
        if (items == null || !items.isArray()) {
            return;
        }
        for (JsonNode item : items) {
            if (item == null || !item.isObject()) {
                continue;
            }
            String id = FoncierGeoService.text(item.get("id"));
            boolean seen = false;
            if (StringUtils.hasText(id)) {
                for (JsonNode existing : target) {
                    if (id.equals(FoncierGeoService.text(existing.get("id")))) {
                        seen = true;
                        break;
                    }
                }
            }
            if (!seen) {
                target.add(item);
            }
        }
    }

    private JsonNode pageOf(ArrayNode merged, int page) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", true);
        root.put("page", page);
        root.put("count", merged.size());
        int from = Math.max(0, (page - 1) * 20);
        int to = Math.min(from + 20, merged.size());
        ArrayNode items = objectMapper.createArrayNode();
        for (int i = from; i < to; i++) {
            items.add(merged.get(i));
        }
        root.set("items", items);
        root.put("hasNext", to < merged.size());
        return root;
    }

    private PlaceFilter applyPlace(UriComponentsBuilder builder, String query, String codeInsee) {
        if (StringUtils.hasText(codeInsee) && codeInsee.trim().matches("\\d{5}")) {
            ObjectNode commune = geoService.communeByInsee(codeInsee.trim());
            List<String> zips = geoService.zipcodesOf(commune);
            String city = commune == null ? "" : FoncierGeoService.text(commune.get("nom"));
            if (!zips.isEmpty()) {
                builder.queryParam("cp", zips.get(0));
                return new PlaceFilter(zips.get(0), city);
            }
            if (StringUtils.hasText(city)) {
                builder.queryParam("ville", city);
                return new PlaceFilter("", city);
            }
        }
        if (!StringUtils.hasText(query)) {
            return PlaceFilter.none();
        }
        String trimmed = query.trim();
        if (trimmed.matches("\\d{5}")) {
            builder.queryParam("cp", trimmed);
            return new PlaceFilter(trimmed, "");
        }
        builder.queryParam("ville", trimmed);
        return new PlaceFilter("", trimmed);
    }

    private JsonNode mapListings(int page, JsonNode raw, PlaceFilter place, boolean slicePage, boolean geocodeMissing) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", true);
        root.put("page", page);
        root.put("count", 0);
        root.put("hasNext", false);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        JsonNode list = collectionOf(raw);
        if (list == null) {
            return root;
        }
        ArrayNode matched = objectMapper.createArrayNode();
        for (JsonNode row : list) {
            ObjectNode item = mapListing(row, geocodeMissing);
            if (item != null && place.matches(item)) {
                matched.add(item);
            }
        }
        int from = slicePage ? Math.max(0, (page - 1) * 20) : 0;
        int to = slicePage ? Math.min(from + 20, matched.size()) : matched.size();
        for (int i = from; i < to; i++) {
            items.add(matched.get(i));
        }
        if (!slicePage && raw.has("total") && raw.get("total").canConvertToInt() && place.isEmpty()) {
            root.put("count", raw.get("total").asInt());
        } else {
            root.put("count", slicePage ? matched.size() : items.size());
        }
        if (slicePage) {
            root.put("hasNext", to < matched.size());
        } else {
            boolean more = raw.has("has_more") && raw.get("has_more").asBoolean();
            root.put("hasNext", items.size() >= 20 && (place.isEmpty() || more));
        }
        return root;
    }

    private ObjectNode mapListing(JsonNode row, boolean geocodeMissing) {
        if (row == null || !row.isObject()) {
            return null;
        }
        ObjectNode item = objectMapper.createObjectNode();
        putText(item, "id", first(row, "reference", "id"));
        putText(item, "title", first(row, "title", "titre"));
        putNumber(item, "price", first(row, "price", "prix"));
        putNumber(item, "pricePerM2", first(row, "price_per_m2", "prix_m2"));
        putNumber(item, "surface", first(row, "surface"));
        putNumber(item, "rooms", first(row, "rooms", "pieces"));
        putText(item, "city", first(row, "city", "ville"));
        putText(item, "zipcode", first(row, "postal_code", "zipcode", "code_postal", "cp"));
        String cityName = FoncierGeoService.text(item.get("city"));
        String zip = FoncierGeoService.text(item.get("zipcode"));
        if (geocodeMissing) {
            String place = (StringUtils.hasText(zip) ? zip + " " : "") + cityName;
            geoService.applyCoordinates(item, row, place, zip);
        } else {
            geoService.copyCoordinates(item, row);
        }
        putText(item, "dpe", first(row, "dpe"));
        putText(item, "type", first(row, "type"));
        putText(item, "url", first(row, "external_url", "url", "source_url", "lien"));
        putText(item, "source", first(row, "source", "portail"));
        FoncierListingMeta.putAddress(item, row, cityName, zip);
        String sellerType = FoncierGeoService.text(first(row, "seller_type"));
        String seller = FoncierListingMeta.usableSeller(FoncierGeoService.text(first(row, "seller_name")));
        String network = FoncierGeoService.text(first(row, "real_estate_network", "network"));
        FoncierListingMeta.putOffer(item, seller, sellerType, network, first(row, "published_at", "updated_at", "created_at"));
        JsonNode photos = first(row, "images", "photos");
        if (photos != null && photos.isArray() && photos.size() > 0) {
            putText(item, "photo", photos.get(0));
        } else {
            putText(item, "photo", first(row, "photo", "image"));
        }
        return item.has("title") || item.has("price") ? item : null;
    }

    private JsonNode fetchJson(URI uri, String label) {
        return fetchJson(uri, label, true);
    }

    private JsonNode fetchJson(URI uri, String label, boolean retryOnRateLimit) {
        pace();
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "application/json");
        headers.set("User-Agent", USER_AGENT);
        headers.set("X-Api-Key", apiKey);
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || !StringUtils.hasText(response.getBody())) {
                log.warn("ChercherTrouver {} failed: HTTP {}", label, response.getStatusCode());
                return null;
            }
            return objectMapper.readTree(response.getBody());
        } catch (HttpStatusCodeException ex) {
            int status = ex.getStatusCode().value();
            log.warn("ChercherTrouver {} HTTP {}: {}", label, ex.getStatusCode(), ex.getStatusText());
            if (status == 401 || status == 403) {
                throw new IllegalStateException("invalid_key");
            }
            if (status == 429 && retryOnRateLimit) {
                sleepQuietly(retryAfterMs(ex));
                return fetchJson(uri, label, false);
            }
            if (ex.getStatusCode().is5xxServerError()) {
                throw new IllegalStateException("upstream_unavailable");
            }
            return null;
        } catch (RestClientException ex) {
            log.warn("ChercherTrouver {} error: {}", label, ex.getMessage());
            return null;
        } catch (IllegalStateException ex) {
            throw ex;
        } catch (Exception ex) {
            log.warn("ChercherTrouver {} parse error: {}", label, ex.getMessage());
            return null;
        }
    }

    private void pace() {
        synchronized (paceLock) {
            long wait = MIN_INTERVAL_MS - (System.currentTimeMillis() - lastCallMs);
            if (lastCallMs > 0 && wait > 0) {
                sleepQuietly(wait);
            }
            lastCallMs = System.currentTimeMillis();
        }
    }

    private int retryAfterMs(HttpStatusCodeException ex) {
        try {
            if (ex.getResponseHeaders() != null) {
                String header = ex.getResponseHeaders().getFirst("Retry-After");
                if (StringUtils.hasText(header) && header.matches("\\d+")) {
                    return (int) Math.min(5000L, Integer.parseInt(header.trim()) * 1000L);
                }
            }
            if (StringUtils.hasText(ex.getResponseBodyAsString())) {
                JsonNode body = objectMapper.readTree(ex.getResponseBodyAsString());
                if (body.has("retry_after_seconds") && body.get("retry_after_seconds").canConvertToInt()) {
                    return (int) Math.min(5000L, body.get("retry_after_seconds").asInt() * 1000L);
                }
            }
        } catch (Exception ignored) {
            // default below
        }
        return 1200;
    }

    private static void sleepQuietly(long ms) {
        try {
            TimeUnit.MILLISECONDS.sleep(Math.max(200L, ms));
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }

    private static String mapType(String type) {
        if (!StringUtils.hasText(type)) {
            return "";
        }
        return switch (type.trim().toLowerCase(Locale.ROOT)) {
            case "appartement", "apartment", "0" -> "Appartement";
            case "maison", "house", "1" -> "Maison";
            case "terrain", "land", "5" -> "Terrain";
            default -> "";
        };
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
        JsonNode list = first(raw, "items", "results", "annonces", "data", "hydra:member", "member");
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
        }
    }

    private static String trimBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://cherchertrouver.immo";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static final class PlaceFilter {
        private final String zip;
        private final String city;
        private final Double lat;
        private final Double lon;
        private final Double radiusKm;

        private PlaceFilter(String zip, String city) {
            this(zip, city, null, null, null);
        }

        private PlaceFilter(String zip, String city, Double lat, Double lon, Double radiusKm) {
            this.zip = zip == null ? "" : zip.trim();
            this.city = city == null ? "" : city.trim();
            this.lat = lat;
            this.lon = lon;
            this.radiusKm = radiusKm;
        }

        static PlaceFilter none() {
            return new PlaceFilter("", "");
        }

        static PlaceFilter around(double lat, double lon, double radiusKm) {
            return new PlaceFilter("", "", lat, lon, radiusKm);
        }

        boolean isEmpty() {
            return zip.isEmpty() && city.isEmpty() && lat == null;
        }

        boolean isCircle() {
            return lat != null && lon != null && radiusKm != null;
        }

        boolean matches(ObjectNode item) {
            if (isCircle()) {
                if (item == null || !item.has("lat") || !item.has("lon")) {
                    return true;
                }
                return FoncierGeoService.distanceKm(
                        lat, lon, item.get("lat").asDouble(), item.get("lon").asDouble())
                        <= radiusKm + 0.2;
            }
            if (isEmpty()) {
                return true;
            }
            String itemZip = FoncierGeoService.text(item.get("zipcode"));
            String itemCity = FoncierGeoService.text(item.get("city"));
            if (!zip.isEmpty() && zip.equals(itemZip)) {
                return true;
            }
            if (!city.isEmpty() && city.equalsIgnoreCase(itemCity)) {
                return zip.isEmpty() || itemZip.isEmpty() || zip.equals(itemZip);
            }
            return false;
        }
    }
}
