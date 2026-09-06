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
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

import com.pat.config.RestTemplateConfig;

import java.net.URI;
import java.text.Normalizer;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Immoswipe Swiss listings — OpenAPI at https://ai.immoswipe.ch/openapi.json (no API key).
 */
@Service
public class FoncierImmoswipeProxyService {

    private static final Logger log = LoggerFactory.getLogger(FoncierImmoswipeProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (foncier-suisse; https://www.patrickdeschamps.com)";
    private static final int PAGE_SIZE = 20;
    private static final Set<String> PRICE_TYPES = Set.of("rent", "sell", "serviced");
    private static final Set<String> LOCALES = Set.of("en", "de");
    /** Immoswipe matches official local spellings (Zürich, Genève), not English/ASCII aliases. */
    private static final Map<String, String> CITY_ALIASES = Map.ofEntries(
            Map.entry("zurich", "Zürich"),
            Map.entry("zuerich", "Zürich"),
            Map.entry("geneva", "Genève"),
            Map.entry("geneve", "Genève"),
            Map.entry("genf", "Genève"),
            Map.entry("berne", "Bern"),
            Map.entry("bale", "Basel"),
            Map.entry("basle", "Basel"),
            Map.entry("lucerne", "Luzern"),
            Map.entry("saint-gall", "St. Gallen"),
            Map.entry("saint gall", "St. Gallen"),
            Map.entry("st-gallen", "St. Gallen"),
            Map.entry("st gallen", "St. Gallen"),
            Map.entry("sankt gallen", "St. Gallen"),
            Map.entry("neuchatel", "Neuchâtel"),
            Map.entry("neuenburg", "Neuchâtel"),
            Map.entry("coire", "Chur"),
            Map.entry("sitten", "Sion"),
            Map.entry("freiburg", "Fribourg"),
            Map.entry("koeniz", "Köniz")
    );

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${app.foncier.immoswipe.api-base:https://ai.immoswipe.ch}")
    private String apiBase;

    public FoncierImmoswipeProxyService(
            @Qualifier(RestTemplateConfig.FONCIER_REST_TEMPLATE) RestTemplate restTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public JsonNode search(
            String city,
            String priceType,
            Integer priceMin,
            Integer priceMax,
            Integer roomsMin,
            Integer surfaceMin,
            Integer page,
            String locale) {
        int p = page == null || page < 1 ? 1 : Math.min(page, 50);
        String deal = normalizePriceType(priceType);
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/search")
                .queryParam("per_page", PAGE_SIZE)
                .queryParam("page", p)
                .queryParam("locale", normalizeLocale(locale));
        if (StringUtils.hasText(city)) {
            builder.queryParam("city", canonicalCity(city));
        }
        if (StringUtils.hasText(deal)) {
            builder.queryParam("price_type", deal);
        }
        if (priceMin != null && priceMin > 0) {
            builder.queryParam("sell".equals(deal) ? "min_sales_price" : "min_monthly_price", priceMin);
        }
        if (priceMax != null && priceMax > 0) {
            builder.queryParam("sell".equals(deal) ? "max_sales_price" : "max_monthly_price", priceMax);
        }
        if (roomsMin != null && roomsMin > 0) {
            builder.queryParam("min_rooms", roomsMin);
        }
        if (surfaceMin != null && surfaceMin > 0) {
            builder.queryParam("min_sqm", surfaceMin);
        }
        JsonNode raw = fetchJson(builder.build().encode().toUri(), "search");
        return mapSearchPage(p, raw);
    }

    public JsonNode popular(String locale) {
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/listings/popular")
                .queryParam("locale", normalizeLocale(locale))
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "popular");
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", true);
        root.put("page", 1);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        JsonNode listings = raw == null ? null : raw.get("listings");
        if (listings != null && listings.isArray()) {
            for (JsonNode listing : listings) {
                ObjectNode item = mapListing(listing);
                if (item != null) {
                    items.add(item);
                }
            }
        }
        root.put("count", items.size());
        root.put("hasNext", false);
        return root;
    }

    public JsonNode listingDetail(String id, String locale) {
        if (!StringUtils.hasText(id)) {
            return null;
        }
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/listings/" + id.trim())
                .queryParam("locale", normalizeLocale(locale))
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "detail " + id);
        ObjectNode mapped = mapListing(raw);
        if (mapped == null) {
            return raw;
        }
        return mapped;
    }

    public JsonNode similar(String id, String locale) {
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/listings/" + id.trim() + "/similar")
                .queryParam("locale", normalizeLocale(locale))
                .build()
                .encode()
                .toUri();
        JsonNode raw = fetchJson(uri, "similar " + id);
        return mapListingArray(raw == null ? null : raw.get("listings"));
    }

    public JsonNode chances(
            String location,
            String rooms,
            String budget,
            String household,
            String timeframe,
            String income,
            String workplace,
            String locationType,
            String locale) {
        if (!StringUtils.hasText(location) || !StringUtils.hasText(rooms)
                || !StringUtils.hasText(budget) || !StringUtils.hasText(household)
                || !StringUtils.hasText(timeframe)) {
            throw new IllegalArgumentException("missing_params");
        }
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/chances")
                .queryParam("location", canonicalCity(location))
                .queryParam("rooms", rooms.trim())
                .queryParam("budget", budget.trim())
                .queryParam("household", household.trim())
                .queryParam("timeframe", timeframe.trim())
                .queryParam("locale", normalizeLocale(locale));
        if (StringUtils.hasText(income)) {
            builder.queryParam("income", income.trim());
        }
        if (StringUtils.hasText(workplace)) {
            builder.queryParam("workplace_address", workplace.trim());
        }
        if (StringUtils.hasText(locationType)) {
            builder.queryParam("location_type", locationType.trim());
        }
        JsonNode raw = fetchJson(builder.build().encode().toUri(), "chances");
        return raw == null ? objectMapper.createObjectNode() : raw;
    }

    public JsonNode guides(String query, String locale) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/guides")
                .queryParam("locale", normalizeLocale(locale));
        if (StringUtils.hasText(query)) {
            builder.queryParam("query", query.trim());
        }
        JsonNode raw = fetchJson(builder.build().encode().toUri(), "guides");
        return raw == null ? objectMapper.createObjectNode().set("guides", objectMapper.createArrayNode()) : raw;
    }

    public JsonNode guide(String slug, String locale) {
        if (!StringUtils.hasText(slug)) {
            return null;
        }
        URI uri = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/guides/" + slug.trim())
                .queryParam("locale", normalizeLocale(locale))
                .build()
                .encode()
                .toUri();
        return fetchJson(uri, "guide " + slug);
    }

    public JsonNode faqs(String searchBy, String role, String locale) {
        UriComponentsBuilder builder = UriComponentsBuilder.fromHttpUrl(trimBase() + "/api/faqs")
                .queryParam("locale", normalizeLocale(locale));
        if (StringUtils.hasText(searchBy)) {
            builder.queryParam("search_by", searchBy.trim());
        }
        if (StringUtils.hasText(role)) {
            builder.queryParam("role", role.trim());
        }
        JsonNode raw = fetchJson(builder.build().encode().toUri(), "faqs");
        return raw == null ? objectMapper.createObjectNode().set("faqs", objectMapper.createArrayNode()) : raw;
    }

    private JsonNode mapSearchPage(int page, JsonNode raw) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", true);
        root.put("page", page);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        int total = 0;
        boolean hasNext = false;
        JsonNode listings = null;
        if (raw != null && raw.isObject()) {
            JsonNode pagination = raw.get("pagination");
            if (pagination != null && pagination.isObject()) {
                if (pagination.path("total_count").canConvertToInt()) {
                    total = pagination.get("total_count").asInt();
                }
                hasNext = pagination.path("has_next_page").asBoolean(false);
            }
            listings = raw.get("listings");
        }
        if (listings != null && listings.isArray()) {
            for (JsonNode listing : listings) {
                ObjectNode item = mapListing(listing);
                if (item != null) {
                    items.add(item);
                }
            }
        }
        if (total <= 0) {
            total = items.size();
        }
        root.put("count", total);
        root.put("hasNext", hasNext || (items.size() >= PAGE_SIZE && total > page * PAGE_SIZE));
        return root;
    }

    private JsonNode mapListingArray(JsonNode listings) {
        ObjectNode root = objectMapper.createObjectNode();
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        if (listings != null && listings.isArray()) {
            for (JsonNode listing : listings) {
                ObjectNode item = mapListing(listing);
                if (item != null) {
                    items.add(item);
                }
            }
        }
        root.put("count", items.size());
        return root;
    }

    private ObjectNode mapListing(JsonNode row) {
        if (row == null || !row.isObject()) {
            return null;
        }
        ObjectNode item = objectMapper.createObjectNode();
        JsonNode id = first(row, "id", "external_id");
        if (id != null && id.isNumber()) {
            item.put("id", String.valueOf(id.asLong()));
        } else {
            putText(item, "id", id);
        }
        putText(item, "title", first(row, "title", "subtitle"));
        JsonNode deal = row.get("deal");
        String priceType = deal != null && deal.isObject() ? FoncierGeoService.text(deal.get("price_type")) : "";
        if (StringUtils.hasText(priceType)) {
            item.put("type", priceType);
            item.put("priceType", priceType);
        }
        Double price = null;
        if (deal != null && deal.isObject()) {
            if ("sell".equals(priceType)) {
                price = number(deal, "price_sale", "price_monthly");
            } else {
                price = number(deal, "price_monthly", "price_sale");
            }
        }
        if (price != null) {
            item.put("price", price);
        }
        JsonNode location = row.get("location");
        String city = "";
        String zip = "";
        if (location != null && location.isObject()) {
            city = FoncierGeoService.text(first(location, "city"));
            zip = FoncierGeoService.text(first(location, "postal_code", "zipcode"));
            putText(item, "city", location.get("city"));
            putText(item, "zipcode", first(location, "postal_code", "zipcode"));
            Double lat = number(location, "lat", "latitude");
            Double lon = number(location, "lng", "lon", "longitude");
            if (lat != null && lon != null) {
                item.put("lat", lat);
                item.put("lon", lon);
            }
            String street = FoncierGeoService.text(location.get("street"));
            if (StringUtils.hasText(street)) {
                String address = street;
                if (StringUtils.hasText(zip) || StringUtils.hasText(city)) {
                    address = street + ", " + (StringUtils.hasText(zip) ? zip + " " : "") + city;
                }
                item.put("address", address.trim());
            } else if (StringUtils.hasText(city)) {
                item.put("address", (StringUtils.hasText(zip) ? zip + " " : "") + city);
            }
        }
        JsonNode attributes = row.get("attributes");
        Double surface = null;
        if (attributes != null && attributes.isObject()) {
            putNumber(item, "rooms", first(attributes, "rooms"));
            surface = number(attributes, "size_sqm", "surface");
            if (surface != null) {
                item.put("surface", surface);
            }
            if (attributes.path("furnished").asBoolean(false)) {
                item.put("furnished", true);
            }
        }
        if (price != null && surface != null && surface > 0) {
            item.put("pricePerM2", Math.round(price / surface));
        }
        JsonNode media = row.get("media");
        if (media != null && media.isObject()) {
            putText(item, "photo", first(media, "image_url"));
            if (!item.has("photo")) {
                JsonNode gallery = media.get("gallery");
                if (gallery != null && gallery.isArray() && gallery.size() > 0) {
                    putText(item, "photo", gallery.get(0));
                }
            }
        }
        JsonNode links = row.get("links");
        if (links != null && links.isObject()) {
            putText(item, "url", first(links, "detail_url", "share_url"));
        }
        JsonNode provider = row.get("provider");
        if (provider != null && provider.isObject()) {
            String name = FoncierGeoService.text(provider.get("name"));
            String type = FoncierGeoService.text(provider.get("type"));
            if (StringUtils.hasText(name)) {
                item.put("seller", name);
            }
            if ("private".equalsIgnoreCase(type)) {
                item.put("sellerType", "private");
            } else if (StringUtils.hasText(name) || "agency".equalsIgnoreCase(type)) {
                item.put("sellerType", "agency");
            }
        }
        item.put("source", "Immoswipe");
        if (!item.has("title") && !item.has("price") && !item.has("city")) {
            return null;
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
                log.warn("Immoswipe {} failed: HTTP {}", label, response.getStatusCode());
                throw new IllegalStateException("upstream_unavailable");
            }
            return objectMapper.readTree(response.getBody());
        } catch (HttpStatusCodeException ex) {
            int status = ex.getStatusCode().value();
            log.warn("Immoswipe {} failed: HTTP {}", label, status);
            if (status == 404) {
                return null;
            }
            throw new IllegalStateException("upstream_unavailable");
        } catch (IllegalStateException ex) {
            throw ex;
        } catch (RestClientException ex) {
            log.warn("Immoswipe {} failed: {}", label, ex.getMessage());
            throw new IllegalStateException("upstream_unavailable");
        } catch (Exception ex) {
            log.warn("Immoswipe {} parse failed: {}", label, ex.getMessage());
            throw new IllegalStateException("upstream_unavailable");
        }
    }

    static String canonicalCity(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "";
        }
        String city = raw.trim();
        int paren = city.lastIndexOf(" (");
        if (paren > 0 && city.endsWith(")")) {
            city = city.substring(0, paren).trim();
        }
        String folded = foldCityKey(city);
        return CITY_ALIASES.getOrDefault(folded, city);
    }

    private static String foldCityKey(String city) {
        String nfd = Normalizer.normalize(city, Normalizer.Form.NFD);
        return nfd.replaceAll("\\p{M}+", "")
                .toLowerCase(Locale.ROOT)
                .replace('.', ' ')
                .replace('-', ' ')
                .trim()
                .replaceAll("\\s+", " ");
    }

    private static String normalizePriceType(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "rent";
        }
        String key = raw.trim().toLowerCase(Locale.ROOT);
        return PRICE_TYPES.contains(key) ? key : "rent";
    }

    private static String normalizeLocale(String raw) {
        if (!StringUtils.hasText(raw)) {
            return "en";
        }
        String key = raw.trim().toLowerCase(Locale.ROOT);
        if (key.startsWith("de")) {
            return "de";
        }
        return LOCALES.contains(key) ? key : "en";
    }

    private static JsonNode first(JsonNode node, String... keys) {
        if (node == null || !node.isObject()) {
            return null;
        }
        for (String key : keys) {
            JsonNode value = node.get(key);
            if (value != null && !value.isNull() && !(value.isTextual() && value.asText().isBlank())) {
                return value;
            }
        }
        return null;
    }

    private static Double number(JsonNode node, String... keys) {
        JsonNode value = first(node, keys);
        if (value == null) {
            return null;
        }
        if (value.isNumber()) {
            return value.asDouble();
        }
        if (value.isTextual()) {
            try {
                return Double.parseDouble(value.asText().replace("'", "").replace(" ", "").trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static void putText(ObjectNode item, String field, JsonNode node) {
        String value = FoncierGeoService.text(node);
        if (StringUtils.hasText(value)) {
            item.put(field, value.trim());
        }
    }

    private static void putNumber(ObjectNode item, String field, JsonNode node) {
        if (node == null || node.isNull()) {
            return;
        }
        if (node.isNumber()) {
            item.put(field, node.asDouble());
            return;
        }
        if (node.isTextual()) {
            try {
                item.put(field, Double.parseDouble(node.asText().replace("'", "").replace(" ", "").trim()));
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
    }

    private String trimBase() {
        if (!StringUtils.hasText(apiBase)) {
            return "https://ai.immoswipe.ch";
        }
        return apiBase.trim().replaceAll("/+$", "");
    }
}
