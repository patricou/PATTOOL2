package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.pat.controller.dto.StellariumConfigDto;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.util.UriComponentsBuilder;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Server-side proxy for <a href="https://stellarium-web.org">Stellarium Web</a> public APIs:
 * <ul>
 *   <li>Noctua Sky object catalogue — {@code api.noctuasky.com}</li>
 *   <li>Stellarium freegeoip fallback — {@code freegeoip.stellarium.org}</li>
 * </ul>
 * The browser never calls these hosts directly.
 */
@Service
public class StellariumProxyService {

    private static final Logger log = LoggerFactory.getLogger(StellariumProxyService.class);

    private static final Pattern SAFE_SKY_QUERY = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{Z}]{1,80}$");
    private static final Pattern SAFE_SKY_NAME = Pattern.compile("^[\\p{L}\\p{N}\\p{P}\\p{Z}+\\-]{1,120}$");

    private static final double DEFAULT_LAT = 48.8566;
    private static final double DEFAULT_LON = 2.3522;
    private static final String DEFAULT_PLACE = "Paris";

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final IpGeolocationService ipGeolocationService;
    private final GeocodeService geocodeService;

    @Value("${app.stellarium.web-base:https://stellarium-web.org}")
    private String stellariumWebBase;

    @Value("${app.stellarium.noctuasky-api-base:https://api.noctuasky.com/api/v1}")
    private String noctuaSkyApiBase;

    @Value("${app.stellarium.freegeoip-base:https://freegeoip.stellarium.org}")
    private String freeGeoIpBase;

    @Value("${app.stellarium.patool-viewer-base:}")
    private String patoolViewerBase;

    public StellariumProxyService(
            RestTemplate restTemplate,
            ObjectMapper objectMapper,
            IpGeolocationService ipGeolocationService,
            GeocodeService geocodeService) {
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
        this.ipGeolocationService = ipGeolocationService;
        this.geocodeService = geocodeService;
    }

    public StellariumConfigDto buildConfig(HttpServletRequest request, Double lat, Double lon) {
        ResolvedLocation location = resolveLocation(request, lat, lon);
        String embedUrl = buildEmbedUrl(location.lat(), location.lon());
        String viewerUrl = buildViewerUrl(request, location.lat(), location.lon());
        return new StellariumConfigDto(location.lat(), location.lon(), location.placeLabel(), embedUrl, viewerUrl);
    }

    public String buildViewerHtml(double lat, double lon) {
        double clampedLat = clampLat(lat);
        double clampedLon = clampLon(lon);
        String embedUrl = buildEmbedUrl(clampedLat, clampedLon);
        return """
                <!DOCTYPE html>
                <html lang="fr">
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1">
                  <title>Stellarium Web — carte du ciel</title>
                  <style>
                    html, body { margin: 0; padding: 0; width: 100%%; height: 100%%; overflow: hidden; background: #000; }
                    iframe { display: block; width: 100%%; height: 100%%; border: 0; }
                  </style>
                </head>
                <body>
                  <iframe src="%s" title="Stellarium Web" allow="geolocation; fullscreen" loading="eager"></iframe>
                </body>
                </html>
                """.formatted(embedUrl);
    }

    public JsonNode searchSkySources(String query) {
        String trimmed = query == null ? "" : query.trim();
        if (!SAFE_SKY_QUERY.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_query");
        }
        String url = UriComponentsBuilder
                .fromHttpUrl(normalizeBase(noctuaSkyApiBase) + "/skysources/")
                .queryParam("q", trimmed)
                .toUriString();
        return fetchJson(url);
    }

    public JsonNode skySourceByName(String name) {
        String trimmed = name == null ? "" : name.trim();
        if (!SAFE_SKY_NAME.matcher(trimmed).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invalid_name");
        }
        String encoded = URLEncoder.encode(trimmed, StandardCharsets.UTF_8).replace("+", "%20");
        String url = normalizeBase(noctuaSkyApiBase) + "/skysources/name/" + encoded;
        return fetchJson(url);
    }

    private ResolvedLocation resolveLocation(HttpServletRequest request, Double lat, Double lon) {
        if (lat != null && lon != null && isValidCoordinate(lat, lon)) {
            String label = reverseGeocodeLabel(lat, lon);
            return new ResolvedLocation(clampLat(lat), clampLon(lon), label);
        }

        String clientIp = extractClientIp(request);
        IpGeolocationService.CoordinatesInfo coords = ipGeolocationService.getCoordinates(clientIp);
        if (coords != null && coords.getLatitude() != null && coords.getLongitude() != null) {
            double resolvedLat = clampLat(coords.getLatitude());
            double resolvedLon = clampLon(coords.getLongitude());
            String label = reverseGeocodeLabel(resolvedLat, resolvedLon);
            return new ResolvedLocation(resolvedLat, resolvedLon, label);
        }

        ResolvedLocation fromStellariumGeo = fetchStellariumFreeGeoIp();
        if (fromStellariumGeo != null) {
            return fromStellariumGeo;
        }

        return new ResolvedLocation(DEFAULT_LAT, DEFAULT_LON, DEFAULT_PLACE);
    }

    private ResolvedLocation fetchStellariumFreeGeoIp() {
        try {
            String url = normalizeBase(freeGeoIpBase) + "/json/";
            JsonNode body = fetchJson(url);
            if (body == null || body.isMissingNode()) {
                return null;
            }
            JsonNode latNode = body.get("latitude");
            JsonNode lonNode = body.get("longitude");
            if (latNode == null || lonNode == null || !latNode.isNumber() || !lonNode.isNumber()) {
                return null;
            }
            double lat = clampLat(latNode.asDouble());
            double lon = clampLon(lonNode.asDouble());
            String city = textOrNull(body, "city");
            String country = textOrNull(body, "country_name");
            String label = buildPlaceLabel(city, country, lat, lon);
            return new ResolvedLocation(lat, lon, label);
        } catch (Exception e) {
            log.debug("Stellarium freegeoip lookup failed: {}", e.getMessage());
            return null;
        }
    }

    private String reverseGeocodeLabel(double lat, double lon) {
        try {
            var response = geocodeService.reverse(lat, lon);
            if (response != null) {
                Object displayName = response.get("display_name");
                if (displayName instanceof String s && StringUtils.hasText(s)) {
                    return s;
                }
            }
        } catch (Exception e) {
            log.debug("Reverse geocode for stellarium viewer failed: {}", e.getMessage());
        }
        return String.format(Locale.ROOT, "Lat %.4f°, Lon %.4f°", lat, lon);
    }

    private String buildEmbedUrl(double lat, double lon) {
        return UriComponentsBuilder
                .fromHttpUrl(normalizeBase(stellariumWebBase))
                .queryParam("lat", formatCoord(lat))
                .queryParam("lng", formatCoord(lon))
                .build()
                .encode()
                .toUriString();
    }

    private String buildViewerUrl(HttpServletRequest request, double lat, double lon) {
        String base = patoolViewerBase;
        if (!StringUtils.hasText(base)) {
            base = resolveRequestBase(request) + "/api/external/stellarium/viewer";
        }
        return UriComponentsBuilder
                .fromHttpUrl(normalizeBase(base))
                .queryParam("lat", formatCoord(lat))
                .queryParam("lon", formatCoord(lon))
                .build()
                .encode()
                .toUriString();
    }

    private static String resolveRequestBase(HttpServletRequest request) {
        String scheme = request.getScheme();
        String host = request.getServerName();
        int port = request.getServerPort();
        boolean defaultPort = ("http".equalsIgnoreCase(scheme) && port == 80)
                || ("https".equalsIgnoreCase(scheme) && port == 443);
        return defaultPort ? scheme + "://" + host : scheme + "://" + host + ":" + port;
    }

    private JsonNode fetchJson(String url) {
        try {
            String body = restTemplate.getForObject(url, String.class);
            if (body == null || body.isBlank()) {
                return objectMapper.nullNode();
            }
            return objectMapper.readTree(body);
        } catch (RestClientException e) {
            log.debug("Stellarium proxy fetch failed for {}: {}", url, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_unavailable");
        } catch (Exception e) {
            log.debug("Stellarium proxy parse failed for {}: {}", url, e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "upstream_invalid");
        }
    }

    private static String extractClientIp(HttpServletRequest request) {
        String ipAddress = request.getHeader("X-Forwarded-For");
        if (ipAddress == null || ipAddress.isBlank()) {
            return request.getRemoteAddr();
        }
        int comma = ipAddress.indexOf(',');
        return comma > 0 ? ipAddress.substring(0, comma).trim() : ipAddress.trim();
    }

    private static boolean isValidCoordinate(double lat, double lon) {
        return lat >= -90.0 && lat <= 90.0 && lon >= -180.0 && lon <= 180.0;
    }

    private static double clampLat(double lat) {
        return Math.max(-90.0, Math.min(90.0, lat));
    }

    private static double clampLon(double lon) {
        return Math.max(-180.0, Math.min(180.0, lon));
    }

    private static String formatCoord(double value) {
        return String.format(Locale.ROOT, "%.6f", value);
    }

    private static String normalizeBase(String base) {
        if (base == null) {
            return "";
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) {
            return null;
        }
        String text = value.asText(null);
        return StringUtils.hasText(text) ? text : null;
    }

    private static String buildPlaceLabel(String city, String country, double lat, double lon) {
        if (StringUtils.hasText(city) && StringUtils.hasText(country)) {
            return city + ", " + country;
        }
        if (StringUtils.hasText(city)) {
            return city;
        }
        if (StringUtils.hasText(country)) {
            return country;
        }
        return String.format(Locale.ROOT, "Lat %.4f°, Lon %.4f°", lat, lon);
    }

    private record ResolvedLocation(double lat, double lon, String placeLabel) {}
}
