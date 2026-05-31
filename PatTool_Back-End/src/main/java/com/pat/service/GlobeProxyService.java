package com.pat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pat.config.RestTemplateConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;

/**
 * Proxies fixed allow-listed globe imagery URLs (Three.js sample textures, NASA BMNG, NASA GIBS WMS),
 * optional Natural Earth boundary GeoJSON and ISS position feeds —
 * browsers call PatTool only, not upstream hosts directly.
 */
@Service
public class GlobeProxyService {

    private static final Logger log = LoggerFactory.getLogger(GlobeProxyService.class);
    private static final int MAX_BYTES_TEXTURE = 14 * 1024 * 1024;
    private static final int MAX_BYTES_GEOJSON = 5 * 1024 * 1024;
    private static final int MAX_BYTES_ISS_FEED = 32 * 1024;
    private static final String UA = "PATTOOL-GlobeProxy/1.0";

    private static final Map<PlanetTextureAsset, String> THREE_JS_PLANET_URLS;

    static {
        String base = "https://threejs.org/examples/textures/planets/";
        THREE_JS_PLANET_URLS = new EnumMap<>(PlanetTextureAsset.class);
        THREE_JS_PLANET_URLS.put(PlanetTextureAsset.ATMOS, base + "earth_atmos_2048.jpg");
        THREE_JS_PLANET_URLS.put(PlanetTextureAsset.SPECULAR, base + "earth_specular_2048.jpg");
        THREE_JS_PLANET_URLS.put(PlanetTextureAsset.NORMAL, base + "earth_normal_2048.jpg");
        THREE_JS_PLANET_URLS.put(PlanetTextureAsset.CLOUDS, base + "earth_clouds_1024.png");
    }

    private static final String NASA_BMNG_JPG =
            "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg";

    /** Public-domain land-boundary linework (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_BOUNDARIES_LAND_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_boundary_lines_land.geojson";

    /** Shoreline linework coast / land-ocean boundary (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_COASTLINE_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_coastline.geojson";

    /** Admin-0 country polygons with {@code LABEL_X}/{@code LABEL_Y} and multilingual names (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_ADMIN_0_COUNTRIES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_countries.geojson";

    /** Equator, tropics, polar circles (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_GEOGRAPHIC_LINES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_geographic_lines.geojson";

    /** Rivers / lake centerlines (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_RIVERS_LAKE_CENTERLINES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_rivers_lake_centerlines.geojson";

    /** Rivers / lake centerlines (Natural Earth 50m; much richer than 110m, under {@link #MAX_BYTES_GEOJSON}). */
    private static final String NATURAL_EARTH_50M_RIVERS_LAKE_CENTERLINES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_rivers_lake_centerlines.geojson";

    /** Lake polygons (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_LAKES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_lakes.geojson";

    /** Lake polygons (Natural Earth 10m; incl. Léman et lacs régionaux — sous {@link #MAX_BYTES_GEOJSON}). */
    private static final String NATURAL_EARTH_10M_LAKES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_lakes.geojson";

    /** Glaciers / ice sheets (Natural Earth 110m). */
    private static final String NATURAL_EARTH_110M_GLACIATED_AREAS_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_glaciated_areas.geojson";

    /** City / town points (Natural Earth 110m simplified). */
    private static final String NATURAL_EARTH_110M_POPULATED_PLACES_SIMPLE_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_populated_places_simple.geojson";

    /** No IANA 110m release : use 10m time zones (under {@link #MAX_BYTES_GEOJSON}). */
    private static final String NATURAL_EARTH_10M_TIME_ZONES_GEOJSON =
            "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_time_zones.geojson";

    private static final String OPEN_NOTIFY_ISS_NOW_JSON = "https://api.open-notify.org/iss-now.json";

    /** NORAD 25544 = ISS ; JSON with {@code latitude} / {@code longitude} (degrees). */
    private static final String WHERE_THE_ISS_AT_ISS_JSON = "https://api.wheretheiss.at/v1/satellites/25544";

    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    public GlobeProxyService(
            @Qualifier(RestTemplateConfig.GLOBE_PROXY_REST_TEMPLATE) RestTemplate globeProxyRestTemplate,
            ObjectMapper objectMapper) {
        this.restTemplate = globeProxyRestTemplate;
        this.objectMapper = objectMapper;
    }

    public enum PlanetTextureAsset {
        ATMOS(MediaType.IMAGE_JPEG),
        SPECULAR(MediaType.IMAGE_JPEG),
        NORMAL(MediaType.IMAGE_JPEG),
        CLOUDS(MediaType.IMAGE_PNG);

        private final MediaType mediaType;

        PlanetTextureAsset(MediaType mediaType) {
            this.mediaType = mediaType;
        }

        public MediaType getMediaType() {
            return mediaType;
        }

        public static PlanetTextureAsset fromPath(String name) {
            if (name == null) {
                return null;
            }
            switch (name.trim().toLowerCase()) {
                case "atmos":
                    return ATMOS;
                case "specular":
                    return SPECULAR;
                case "normal":
                    return NORMAL;
                case "clouds":
                    return CLOUDS;
                default:
                    return null;
            }
        }
    }

    public record FetchedImage(byte[] body, MediaType contentType) {}

    public FetchedImage fetchThreeJsPlanetTexture(PlanetTextureAsset asset) {
        String url = THREE_JS_PLANET_URLS.get(asset);
        if (url == null) {
            throw new IllegalArgumentException("Unknown planet texture asset");
        }
        byte[] bytes = fetchBytes(url, MAX_BYTES_TEXTURE);
        return new FetchedImage(bytes, asset.getMediaType());
    }

    public FetchedImage fetchSatelliteBasemap() {
        byte[] bytes = fetchBytes(NASA_BMNG_JPG, MAX_BYTES_TEXTURE);
        return new FetchedImage(bytes, MediaType.IMAGE_JPEG);
    }

    /**
     * NASA GIBS WMS true-colour composite (VIIRS SNPP), EPSG:4326 plate carrée.
     *
     * @param dateIso optional {@code yyyy-MM-dd} (UTC calendar day). If null or invalid, defaults to yesterday UTC.
     */
    public FetchedImage fetchGibsViirsOverlay(String dateIso) {
        LocalDate d = parseOrYesterday(dateIso);
        String time = d.format(DateTimeFormatter.ISO_LOCAL_DATE);
        String url = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
                + "?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap"
                + "&LAYERS=VIIRS_SNPP_CorrectedReflectance_TrueColor"
                + "&STYLES="
                + "&SRS=EPSG:4326"
                + "&BBOX=-180,-90,180,90"
                + "&WIDTH=2048&HEIGHT=1024"
                + "&FORMAT=image/jpeg"
                + "&TIME=" + time;
        byte[] bytes = fetchBytes(url, MAX_BYTES_TEXTURE);
        return new FetchedImage(bytes, MediaType.IMAGE_JPEG);
    }

    /** Natural Earth 110m administrative boundary lines (land), UTF-8 GeoJSON. */
    public byte[] fetchNaturalEarth110mLandBoundaryGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_BOUNDARIES_LAND_GEOJSON, MAX_BYTES_GEOJSON);
    }

    /** Natural Earth 110m coastline (land-ocean boundary), UTF-8 GeoJSON. */
    public byte[] fetchNaturalEarth110mCoastlineGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_COASTLINE_GEOJSON, MAX_BYTES_GEOJSON);
    }

    /** Natural Earth admin-0 countries polygons with label coordinates; UTF-8 GeoJSON (under proxy size cap). */
    public byte[] fetchNaturalEarth110mAdmin0CountriesGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_ADMIN_0_COUNTRIES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth110mGeographicLinesGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_GEOGRAPHIC_LINES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth110mRiversLakeCenterlinesGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_RIVERS_LAKE_CENTERLINES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    /** Hydrology linework at 1:50m scale (many more rivers than 110m). */
    public byte[] fetchNaturalEarth50mRiversLakeCenterlinesGeoJson() {
        return fetchBytes(NATURAL_EARTH_50M_RIVERS_LAKE_CENTERLINES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth110mLakesGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_LAKES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth10mLakesGeoJson() {
        return fetchBytes(NATURAL_EARTH_10M_LAKES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth110mGlaciatedAreasGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_GLACIATED_AREAS_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth110mPopulatedPlacesSimpleGeoJson() {
        return fetchBytes(NATURAL_EARTH_110M_POPULATED_PLACES_SIMPLE_GEOJSON, MAX_BYTES_GEOJSON);
    }

    public byte[] fetchNaturalEarth10mTimeZonesGeoJson() {
        return fetchBytes(NATURAL_EARTH_10M_TIME_ZONES_GEOJSON, MAX_BYTES_GEOJSON);
    }

    /**
     * JSON compatible with Open Notify {@code iss-now} ({@code message}, {@code iss_position}, {@code timestamp}).
     * Tries Open Notify first ; if it fails, uses Where The ISS At and maps the payload to the same shape.
     */
    public byte[] fetchOpenNotifyIssNow() {
        try {
            byte[] wtia = fetchBytes(WHERE_THE_ISS_AT_ISS_JSON, MAX_BYTES_ISS_FEED);
            return mapWhereTheIssAtToOpenNotifyCompatibleJson(wtia);
        } catch (IllegalStateException primary) {
            log.info("Globe ISS: wheretheiss.at failed ({}); trying Open Notify.", primary.getMessage());
            try {
                return fetchBytes(OPEN_NOTIFY_ISS_NOW_JSON, MAX_BYTES_ISS_FEED);
            } catch (IllegalStateException secondary) {
                log.warn("Globe ISS: Open Notify fallback failed ({})", secondary.getMessage());
                throw primary;
            }
        }
    }

    private byte[] mapWhereTheIssAtToOpenNotifyCompatibleJson(byte[] wtiaPayload) {
        try {
            JsonNode root = objectMapper.readTree(wtiaPayload);
            if (!root.has("latitude") || !root.has("longitude")) {
                throw new IllegalStateException("WhereTheISS.at JSON missing latitude/longitude");
            }
            double lat = root.get("latitude").asDouble(Double.NaN);
            double lon = root.get("longitude").asDouble(Double.NaN);
            if (!Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90.0 || Math.abs(lon) > 180.0) {
                throw new IllegalStateException("WhereTheISS.at invalid coordinates: " + lat + ", " + lon);
            }
            ObjectNode out = objectMapper.createObjectNode();
            out.put("message", "success");
            ObjectNode pos = objectMapper.createObjectNode();
            pos.put("latitude", String.format(Locale.US, "%.6f", lat));
            pos.put("longitude", String.format(Locale.US, "%.6f", lon));
            if (root.has("altitude")) {
                double altKm = root.get("altitude").asDouble(Double.NaN);
                if (Double.isFinite(altKm) && altKm >= 0.0 && altKm <= 2000.0) {
                    pos.put("altitude_km", String.format(Locale.US, "%.2f", altKm));
                }
            }
            if (root.has("velocity")) {
                double velKmh = root.get("velocity").asDouble(Double.NaN);
                if (Double.isFinite(velKmh) && velKmh >= 0.0 && velKmh <= 50000.0) {
                    pos.put("velocity_kmh", String.format(Locale.US, "%.1f", velKmh));
                }
            }
            out.set("iss_position", pos);
            out.put("timestamp", Instant.now().getEpochSecond());
            return objectMapper.writeValueAsBytes(out);
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("ISS fallback JSON mapping failed: " + e.getMessage(), e);
        }
    }

    private static LocalDate parseOrYesterday(String dateIso) {
        if (dateIso == null || dateIso.isBlank()) {
            return LocalDate.now(java.time.ZoneOffset.UTC).minusDays(1);
        }
        try {
            LocalDate parsed = LocalDate.parse(dateIso.trim(), DateTimeFormatter.ISO_LOCAL_DATE);
            LocalDate earliest = LocalDate.now(java.time.ZoneOffset.UTC).minusDays(14);
            LocalDate latest = LocalDate.now(java.time.ZoneOffset.UTC);
            if (parsed.isBefore(earliest)) {
                return earliest;
            }
            if (parsed.isAfter(latest)) {
                return latest.minusDays(1);
            }
            return parsed;
        } catch (DateTimeParseException e) {
            return LocalDate.now(java.time.ZoneOffset.UTC).minusDays(1);
        }
    }

    private byte[] fetchBytes(String url, int maxBytes) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.USER_AGENT, UA);
        headers.set(HttpHeaders.ACCEPT, "*/*");
        try {
            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    byte[].class
            );
            if (!response.getStatusCode().is2xxSuccessful()) {
                throw new IllegalStateException("Upstream HTTP " + response.getStatusCode());
            }
            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                throw new IllegalStateException("Empty upstream body");
            }
            if (body.length > maxBytes) {
                throw new IllegalStateException("Upstream payload too large: " + body.length);
            }
            return body;
        } catch (RestClientException e) {
            log.warn("Globe proxy fetch failed for {}: {}", url, e.getMessage());
            throw new IllegalStateException("Upstream fetch failed: " + e.getMessage(), e);
        }
    }
}
