package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.util.StringUtils;

import java.util.Locale;
import java.util.Set;

/**
 * Shared seller / address / publication-date fields stored on listings and in cache.
 */
final class FoncierListingMeta {

    private static final Set<String> GENERIC_SELLERS = Set.of(
            "agence professionnelle",
            "professional",
            "agence",
            "pro",
            "particulier",
            "individual",
            "private"
    );

    private FoncierListingMeta() {
    }

    static void putOffer(ObjectNode item, String seller, String sellerType, String network, JsonNode... published) {
        if (isPrivate(sellerType)) {
            item.put("sellerType", "private");
        } else if (isAgency(sellerType) || StringUtils.hasText(seller) || StringUtils.hasText(network)) {
            item.put("sellerType", "agency");
        }
        if (StringUtils.hasText(seller) && !isGeneric(seller) && !isPrivate(sellerType)) {
            item.put("seller", seller.trim());
        }
        if (StringUtils.hasText(network) && !isGeneric(network)) {
            String trimmed = network.trim();
            if (!trimmed.equalsIgnoreCase(FoncierGeoService.text(item.get("seller")))) {
                item.put("sellerNetwork", trimmed);
            }
        }
        putPublishedAt(item, published);
    }

    static void putPublishedAt(ObjectNode item, JsonNode... nodes) {
        for (JsonNode node : nodes) {
            String value = FoncierGeoService.text(node);
            if (StringUtils.hasText(value)) {
                item.put("publishedAt", value.trim());
                return;
            }
        }
    }

    static void putAddress(ObjectNode item, JsonNode row, String city, String zip) {
        String street = streetOf(row);
        if (!StringUtils.hasText(street)) {
            return;
        }
        String address = street.trim();
        if (StringUtils.hasText(city) && !address.toLowerCase(Locale.ROOT).contains(city.toLowerCase(Locale.ROOT))) {
            address = address + ", " + (StringUtils.hasText(zip) ? zip + " " : "") + city;
        }
        item.put("address", address);
    }

    static String usableSeller(String... candidates) {
        for (String raw : candidates) {
            if (StringUtils.hasText(raw) && !isGeneric(raw)) {
                return raw.trim();
            }
        }
        return "";
    }

    static boolean isPrivate(String sellerType) {
        if (!StringUtils.hasText(sellerType)) {
            return false;
        }
        String key = sellerType.trim().toLowerCase(Locale.ROOT);
        return key.equals("private")
                || key.equals("particulier")
                || key.equals("individual")
                || key.equals("0");
    }

    static boolean isAgency(String sellerType) {
        if (!StringUtils.hasText(sellerType)) {
            return false;
        }
        String key = sellerType.trim().toLowerCase(Locale.ROOT);
        return key.equals("agency")
                || key.equals("pro")
                || key.equals("professionnel")
                || key.equals("1");
    }

    private static boolean isGeneric(String value) {
        return GENERIC_SELLERS.contains(value.trim().toLowerCase(Locale.ROOT));
    }

    private static String streetOf(JsonNode row) {
        if (row == null || !row.isObject()) {
            return "";
        }
        String street = FoncierGeoService.text(first(row,
                "address", "adresse", "street", "street_address", "streetAddress", "full_address"));
        if (StringUtils.hasText(street)) {
            return street;
        }
        JsonNode location = row.get("location");
        if (location != null && location.isObject()) {
            return FoncierGeoService.text(first(location, "address", "adresse", "street"));
        }
        return "";
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
}
