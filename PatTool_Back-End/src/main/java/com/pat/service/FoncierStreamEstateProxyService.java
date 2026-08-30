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

/**
 * Stream Estate listings — API key stays server-side.
 */
@Service
public class FoncierStreamEstateProxyService {

    private static final Logger log = LoggerFactory.getLogger(FoncierStreamEstateProxyService.class);
    private static final String USER_AGENT = "PatTool/1.0 (foncier; https://www.patrickdeschamps.com)";

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final FoncierGeoService geoService;

    @Value("${app.foncier.stream-estate.api-base:https://api.stream.estate}")
    private String apiBase;

    @Value("${app.foncier.stream-estate.api-key:}")
    private String apiKey;

    public FoncierStreamEstateProxyService(
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
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromHttpUrl(trimBase(apiBase) + "/documents/properties")
                .queryParam("transactionType", 0)
                .queryParam("itemsPerPage", 20)
                .queryParam("page", p)
                .queryParam("orderByUpdatedAt", "desc");
        Integer propertyType = mapType(type);
        if (propertyType != null) {
            builder.queryParam("propertyTypes[]", propertyType);
        }
        if (priceMin != null && priceMin > 0) {
            builder.queryParam("budgetMin", priceMin);
        }
        if (priceMax != null && priceMax > 0) {
            builder.queryParam("budgetMax", priceMax);
        }
        if (surfaceMin != null && surfaceMin > 0) {
            builder.queryParam("surfaceMin", surfaceMin);
        }
        if (surfaceMax != null && surfaceMax > 0) {
            builder.queryParam("surfaceMax", surfaceMax);
        }
        if (radius > 0) {
            ObjectNode center = geoService.centerOf(codeInsee, query);
            if (center != null && center.has("lat") && center.has("lon")) {
                builder.queryParam("lat", center.get("lat").asDouble());
                builder.queryParam("lon", center.get("lon").asDouble());
                builder.queryParam("radius", radius);
            } else {
                applyPlace(builder, query, codeInsee);
            }
        } else {
            applyPlace(builder, query, codeInsee);
        }
        JsonNode raw = fetchJson(toApiUri(builder), "listings");
        return mapListings(p, raw);
    }

    private void applyPlace(UriComponentsBuilder builder, String query, String codeInsee) {
        if (StringUtils.hasText(codeInsee) && codeInsee.trim().matches("\\d{5}")) {
            builder.queryParam("includedInseeCodes[]", codeInsee.trim());
            return;
        }
        if (!StringUtils.hasText(query)) {
            return;
        }
        String trimmed = query.trim();
        if (trimmed.matches("\\d{5}")) {
            builder.queryParam("includedZipcodes[]", trimmed);
            return;
        }
        ObjectNode commune = geoService.resolveCommune(trimmed);
        if (commune != null) {
            String insee = FoncierGeoService.text(commune.get("code"));
            if (StringUtils.hasText(insee)) {
                builder.queryParam("includedInseeCodes[]", insee);
                return;
            }
            List<String> zips = geoService.zipcodesOf(commune);
            if (!zips.isEmpty()) {
                builder.queryParam("includedZipcodes[]", zips.get(0));
            }
        }
    }

    private JsonNode mapListings(int page, JsonNode raw) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("configured", true);
        root.put("page", page);
        root.put("count", 0);
        ArrayNode items = objectMapper.createArrayNode();
        root.set("items", items);
        if (raw == null || raw.isNull()) {
            return root;
        }
        JsonNode members = null;
        if (raw.isArray()) {
            members = raw;
            root.put("count", raw.size());
        } else if (raw.isObject()) {
            if (raw.has("hydra:totalItems") && raw.get("hydra:totalItems").canConvertToInt()) {
                root.put("count", raw.get("hydra:totalItems").asInt());
            } else if (raw.has("totalItems") && raw.get("totalItems").canConvertToInt()) {
                root.put("count", raw.get("totalItems").asInt());
            } else if (raw.has("total") && raw.get("total").canConvertToInt()) {
                root.put("count", raw.get("total").asInt());
            }
            members = first(raw, "hydra:member", "member", "items", "data", "results");
        }
        if (members == null || !members.isArray()) {
            log.warn("Stream Estate listings: unexpected payload ({})", raw.getNodeType());
            return root;
        }
        int mapped = 0;
        for (JsonNode member : members) {
            ObjectNode item = mapProperty(member);
            if (item != null) {
                items.add(item);
                mapped++;
            }
        }
        if (root.get("count").asInt() == 0) {
            root.put("count", items.size());
        }
        root.put("hasNext", items.size() >= 20 && root.get("count").asInt() > page * 20);
        log.info("Stream Estate listings: rawMembers={} mapped={} total={}", members.size(), mapped, root.get("count").asInt());
        return root;
    }

    private ObjectNode mapProperty(JsonNode row) {
        if (row == null || !row.isObject()) {
            return null;
        }
        ObjectNode item = objectMapper.createObjectNode();
        putText(item, "id", first(row, "uuid", "@id"));
        putText(item, "title", row.get("title"));
        putNumber(item, "price", row.get("price"));
        putNumber(item, "pricePerM2", first(row, "pricePerMeter", "pricePerM2"));
        putNumber(item, "surface", row.get("surface"));
        putNumber(item, "rooms", first(row, "room", "rooms"));
        putNumber(item, "bedrooms", first(row, "bedroom", "bedrooms"));
        putNumber(item, "landSurface", row.get("landSurface"));
        item.put("type", propertyTypeLabel(row.get("propertyType")));
        JsonNode city = row.get("city");
        if (city != null && city.isObject()) {
            putText(item, "city", first(city, "name", "originalName"));
            putText(item, "zipcode", first(city, "zipcode", "postalCode"));
            putInsee(item, first(city, "insee", "codeInsee"));
        }
        String cityName = FoncierGeoService.text(item.get("city"));
        String zip = FoncierGeoService.text(item.get("zipcode"));
        String place = (StringUtils.hasText(zip) ? zip + " " : "") + cityName;
        geoService.copyCoordinates(item, row.get("locations"));
        geoService.applyCoordinates(item, row, place, zip);
        if (city != null) {
            geoService.copyCoordinates(item, city.get("locations"));
            geoService.copyCoordinates(item, city);
        }
        JsonNode adverts = row.get("adverts");
        JsonNode advert = adverts != null && adverts.isArray() && adverts.size() > 0 ? adverts.get(0) : null;
        JsonNode publisher = null;
        JsonNode contact = null;
        if (advert != null && advert.isObject()) {
            putText(item, "url", advert.get("url"));
            JsonNode energy = advert.get("energy");
            if (energy != null && energy.isObject()) {
                putText(item, "dpe", energy.get("category"));
            }
            publisher = advert.get("publisher");
            contact = advert.get("contact");
            if (publisher != null && publisher.isObject()) {
                putText(item, "source", publisher.get("name"));
            }
            if (!item.has("title")) {
                putText(item, "title", advert.get("title"));
            }
            if (!item.has("price")) {
                putNumber(item, "price", advert.get("price"));
            }
            FoncierListingMeta.putAddress(item, advert, cityName, zip);
        }
        FoncierListingMeta.putAddress(item, row, cityName, zip);
        applyOfferMeta(item, row, advert, publisher, contact);
        JsonNode pictures = first(row, "pictures", "picturesRemote");
        if (pictures != null && pictures.isArray() && pictures.size() > 0) {
            JsonNode photo = pictures.get(0);
            if (photo != null && photo.isObject()) {
                putText(item, "photo", first(photo, "url", "src", "href"));
            } else {
                putText(item, "photo", photo);
            }
        }
        if (!item.has("title") && !item.has("price") && !item.has("city")) {
            return null;
        }
        return item;
    }

    private static void applyOfferMeta(
            ObjectNode item,
            JsonNode row,
            JsonNode advert,
            JsonNode publisher,
            JsonNode contact) {
        boolean privateSeller = isPrivatePublisher(publisher, row.get("publisherTypes"));
        String agency = "";
        String person = "";
        if (contact != null && contact.isObject()) {
            agency = FoncierGeoService.text(contact.get("agency"));
            person = FoncierGeoService.text(contact.get("name"));
        }
        String publisherName = publisher != null && publisher.isObject()
                ? FoncierGeoService.text(publisher.get("name"))
                : "";
        String seller = privateSeller
                ? ""
                : FoncierListingMeta.usableSeller(person, agency, publisherName.length() > 3 ? publisherName : "");
        String sellerType = "";
        if (privateSeller) {
            sellerType = "private";
        } else if (StringUtils.hasText(seller)
                || (publisher != null && publisher.isObject() && publisher.path("type").asInt(-1) == 1)
                || hasAgencyPublisherType(row.get("publisherTypes"))) {
            sellerType = "agency";
        }
        JsonNode advertCreated = advert != null ? advert.get("createdAt") : null;
        JsonNode advertUpdated = advert != null ? advert.get("updatedAt") : null;
        if (StringUtils.hasText(sellerType) || StringUtils.hasText(seller)) {
            FoncierListingMeta.putOffer(item, seller, sellerType, "", advertCreated, row.get("createdAt"), advertUpdated, row.get("updatedAt"));
        } else {
            FoncierListingMeta.putPublishedAt(item, advertCreated, row.get("createdAt"), advertUpdated, row.get("updatedAt"));
        }
    }

    private static boolean hasAgencyPublisherType(JsonNode publisherTypes) {
        if (publisherTypes == null || !publisherTypes.isArray()) {
            return false;
        }
        for (JsonNode type : publisherTypes) {
            if (type.asInt(-1) == 1) {
                return true;
            }
        }
        return false;
    }

    private static boolean isPrivatePublisher(JsonNode publisher, JsonNode publisherTypes) {
        if (publisher != null && publisher.isObject() && publisher.has("type") && publisher.get("type").asInt(-1) == 0) {
            return true;
        }
        if (publisherTypes == null || !publisherTypes.isArray() || publisherTypes.size() == 0) {
            return false;
        }
        boolean hasPrivate = false;
        boolean hasAgency = false;
        for (JsonNode type : publisherTypes) {
            int value = type.asInt(-1);
            if (value == 0) {
                hasPrivate = true;
            }
            if (value == 1) {
                hasAgency = true;
            }
        }
        return hasPrivate && !hasAgency;
    }

    private JsonNode fetchJson(URI uri, String label) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Accept", "application/json");
        headers.set("User-Agent", USER_AGENT);
        headers.set("X-API-KEY", apiKey);
        try {
            ResponseEntity<String> response = restTemplate.exchange(
                    uri, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            if (!response.getStatusCode().is2xxSuccessful() || !StringUtils.hasText(response.getBody())) {
                log.warn("Stream Estate {} failed: HTTP {}", label, response.getStatusCode());
                return null;
            }
            return objectMapper.readTree(response.getBody());
        } catch (HttpStatusCodeException ex) {
            int status = ex.getStatusCode().value();
            String body = ex.getResponseBodyAsString();
            log.warn("Stream Estate {} HTTP {}: {}", label, status, ex.getStatusText());
            if (status == 401) {
                throw new IllegalStateException("invalid_key");
            }
            if (status == 403) {
                if (body != null && body.toLowerCase(Locale.ROOT).contains("insufficient credits")) {
                    throw new IllegalStateException("insufficient_credits");
                }
                throw new IllegalStateException("forbidden");
            }
            if (ex.getStatusCode().is5xxServerError()) {
                throw new IllegalStateException("upstream_unavailable");
            }
            return null;
        } catch (RestClientException ex) {
            log.warn("Stream Estate {} error: {}", label, ex.getMessage());
            return null;
        } catch (IllegalStateException ex) {
            throw ex;
        } catch (Exception ex) {
            log.warn("Stream Estate {} parse error: {}", label, ex.getMessage());
            return null;
        }
    }

    private static Integer mapType(String type) {
        if (!StringUtils.hasText(type)) {
            return null;
        }
        return switch (type.trim().toLowerCase(Locale.ROOT)) {
            case "appartement", "apartment", "0" -> 0;
            case "maison", "house", "1" -> 1;
            case "terrain", "land", "5" -> 5;
            default -> null;
        };
    }

    private static String propertyTypeLabel(JsonNode node) {
        if (node == null || node.isNull()) {
            return "";
        }
        if (!node.canConvertToInt() && !node.isTextual()) {
            return "";
        }
        int value;
        try {
            value = node.isNumber() ? node.asInt() : Integer.parseInt(node.asText().trim());
        } catch (NumberFormatException ex) {
            return node.isTextual() ? node.asText().trim() : "";
        }
        return switch (value) {
            case 0 -> "Appartement";
            case 1 -> "Maison";
            case 2 -> "Immeuble";
            case 3 -> "Parking";
            case 4 -> "Bureau";
            case 5 -> "Terrain";
            case 6 -> "Commerce";
            default -> "";
        };
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
            return;
        }
        if (node.isTextual()) {
            try {
                target.put(field, Double.parseDouble(node.asText().replace(" ", "").replace(",", ".")));
            } catch (NumberFormatException ignored) {
                // skip
            }
        }
    }

    private static void putInsee(ObjectNode target, JsonNode node) {
        String raw = FoncierGeoService.text(node);
        if (!StringUtils.hasText(raw)) {
            return;
        }
        String digits = raw.replaceAll("\\D", "");
        if (digits.isEmpty()) {
            target.put("insee", raw);
            return;
        }
        target.put("insee", digits.length() >= 5 ? digits.substring(0, 5) : "0".repeat(5 - digits.length()) + digits);
    }

    /**
     * Stream Estate is API Platform: {@code includedInseeCodes[]} must keep the brackets.
     */
    private static URI toApiUri(UriComponentsBuilder builder) {
        String encoded = builder.build().encode().toUriString();
        return URI.create(encoded.replace("%5B", "[").replace("%5D", "]"));
    }

    private static String trimBase(String base) {
        if (!StringUtils.hasText(base)) {
            return "https://api.stream.estate";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }
}
