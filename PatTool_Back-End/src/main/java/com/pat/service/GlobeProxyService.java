package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.EnumMap;
import java.util.Map;

/**
 * Proxies fixed allow-listed globe imagery URLs (Three.js sample textures, NASA BMNG, NASA GIBS WMS)
 * so the browser talks only to PatTool and not to third-party hosts.
 */
@Service
public class GlobeProxyService {

    private static final Logger log = LoggerFactory.getLogger(GlobeProxyService.class);
    private static final int MAX_BYTES_TEXTURE = 14 * 1024 * 1024;
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

    private final RestTemplate restTemplate;

    public GlobeProxyService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
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
