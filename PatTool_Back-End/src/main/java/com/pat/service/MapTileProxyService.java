package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;
import java.util.Set;

/**
 * Proxies public raster map tiles for the GPS 3D view (avoids browser CORS / CSP connect-src issues
 * with Three.js TextureLoader).
 */
@Service
public class MapTileProxyService {

    private static final Logger log = LoggerFactory.getLogger(MapTileProxyService.class);

    private static final Set<String> ALLOWED_STYLES = Set.of("voyager", "osm");

    private final RestTemplate restTemplate;

    public MapTileProxyService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public ResponseEntity<byte[]> getTile(String style, int z, int x, int y) {
        String safeStyle = style == null || style.isBlank() ? "voyager" : style.trim().toLowerCase();
        if (!ALLOWED_STYLES.contains(safeStyle)) {
            return ResponseEntity.badRequest().build();
        }
        if (z < 0 || z > 19 || x < 0 || y < 0) {
            return ResponseEntity.badRequest().build();
        }
        int n = 1 << z;
        if (x >= n || y >= n) {
            return ResponseEntity.badRequest().build();
        }

        String url = switch (safeStyle) {
            case "osm" -> "https://tile.openstreetmap.org/" + z + "/" + x + "/" + y + ".png";
            default -> "https://a.basemaps.cartocdn.com/rastertiles/voyager/" + z + "/" + x + "/" + y + ".png";
        };

        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, "PatTool-MapTileProxy/1.0 (GPS 3D nav; contact via patrickdeschamps.com)");
            headers.set(HttpHeaders.ACCEPT, "image/png,image/*;q=0.8,*/*;q=0.5");

            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    byte[].class
            );
            byte[] body = response.getBody();
            if (body == null || body.length == 0) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            HttpHeaders out = new HttpHeaders();
            MediaType contentType = response.getHeaders().getContentType();
            out.setContentType(contentType != null ? contentType : MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (HttpClientErrorException e) {
            return ResponseEntity.status(e.getStatusCode()).build();
        } catch (Exception e) {
            log.debug("Map tile fetch failed (style={}, z={}, x={}, y={}): {}", safeStyle, z, x, y, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }
}
