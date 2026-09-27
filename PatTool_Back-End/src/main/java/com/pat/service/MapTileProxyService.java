package com.pat.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
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
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Proxies public raster map tiles (GPS 3D textures and offline basemap packs).
 * Only the catalogue below is fetched — not an open URL proxy.
 */
@Service
public class MapTileProxyService {

    private static final Logger log = LoggerFactory.getLogger(MapTileProxyService.class);

    private static final Map<String, List<String>> TEMPLATES = Map.ofEntries(
            Map.entry("osm", List.of("https://tile.openstreetmap.org/{z}/{x}/{y}.png")),
            Map.entry("osm-standard", List.of("https://tile.openstreetmap.org/{z}/{x}/{y}.png")),
            Map.entry("voyager", List.of("https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png")),
            Map.entry("osm-fr", List.of(
                    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                    "https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png")),
            Map.entry("esri-imagery", List.of(
                    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}")),
            Map.entry("opentopomap", List.of("https://a.tile.opentopomap.org/{z}/{x}/{y}.png")),
            Map.entry("ign-plan", List.of(wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "normal", "image/png"))),
            Map.entry("ign-topo", List.of(wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "normal", "image/png"))),
            Map.entry("ign-classic", List.of(
                    wmts("IGNF_CARTES_SCAN-REGIONAL", "SCANREG", "image/jpeg"),
                    wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "normal", "image/png"))),
            Map.entry("ign-ortho", List.of(wmts("ORTHOIMAGERY.ORTHOPHOTOS", "normal", "image/jpeg"))),
            Map.entry("ign-cadastre", List.of(wmts("CADASTRALPARCELS.PARCELLAIRE_EXPRESS", "normal", "image/png"))),
            Map.entry("ign-limites", List.of(wmts("LIMITES_ADMINISTRATIVES_EXPRESS.LATEST", "normal", "image/png"))),
            Map.entry("ign-relief", List.of(wmts("ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES", "normal", "image/png"))),
            Map.entry("ign-routes", List.of(wmts("TRANSPORTNETWORKS.ROADS", "normal", "image/png"))),
            Map.entry("ign-maps", List.of(wmts("GEOGRAPHICALGRIDSYSTEMS.MAPS", "normal", "image/jpeg"))),
            Map.entry("ign-scan-regional", List.of(wmts("IGNF_CARTES_SCAN-REGIONAL", "SCANREG", "image/jpeg"))),
            Map.entry("cyclosm", List.of("https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png")),
            Map.entry("swisstopo-pixelkarte", List.of(
                    "https://wmts0.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg")),
            Map.entry("swisstopo-swissimage", List.of(
                    "https://wmts0.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"))
    );

    private final RestTemplate restTemplate;
    private final String thunderforestApiKey;

    public MapTileProxyService(
            RestTemplate restTemplate,
            @Value("${thunderforest.api.key:}") String thunderforestApiKey) {
        this.restTemplate = restTemplate;
        this.thunderforestApiKey = thunderforestApiKey == null ? "" : thunderforestApiKey.trim();
    }

    public ResponseEntity<byte[]> getTile(String style, int z, int x, int y) {
        return getTile(style, 0, z, x, y);
    }

    public ResponseEntity<byte[]> getTile(String style, int part, int z, int x, int y) {
        String safeStyle = style == null || style.isBlank() ? "voyager" : style.trim().toLowerCase(Locale.ROOT);
        if (z < 0 || z > 19 || x < 0 || y < 0) {
            return ResponseEntity.badRequest().build();
        }
        int n = 1 << z;
        if (x >= n || y >= n) {
            return ResponseEntity.badRequest().build();
        }
        List<String> templates = templatesFor(safeStyle);
        if (templates == null || templates.isEmpty()) {
            return ResponseEntity.badRequest().build();
        }
        if (part < 0 || part >= templates.size()) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        }
        String url = fill(templates.get(part), z, x, y);
        ResponseEntity<byte[]> fetched = fetchImage(url, safeStyle, z, x, y);
        if (fetched.getStatusCode().is2xxSuccessful()) {
            return fetched;
        }
        if (("voyager".equals(safeStyle) || "osm".equals(safeStyle)) && !"osm".equals(safeStyle)) {
            String osmUrl = "https://tile.openstreetmap.org/" + z + "/" + x + "/" + y + ".png";
            ResponseEntity<byte[]> osm = fetchImage(osmUrl, "osm", z, x, y);
            if (osm.getStatusCode().is2xxSuccessful()) {
                return osm;
            }
        }
        return fetched;
    }

    private List<String> templatesFor(String style) {
        if ("opencyclemap".equals(style) || "thunderforest-outdoors".equals(style)) {
            if (thunderforestApiKey.isEmpty()) {
                return List.of();
            }
            String kind = "opencyclemap".equals(style) ? "cycle" : "outdoors";
            return List.of("https://a.tile.thunderforest.com/" + kind + "/{z}/{x}/{y}.png?apikey=" + thunderforestApiKey);
        }
        return TEMPLATES.get(style);
    }

    private static String wmts(String layer, String style, String format) {
        return "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&TILEMATRIXSET=PM"
                + "&LAYER=" + layer
                + "&STYLE=" + style.replace(" ", "%20")
                + "&FORMAT=" + format.replace("/", "%2F")
                + "&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}";
    }

    private static String fill(String template, int z, int x, int y) {
        return template
                .replace("{z}", Integer.toString(z))
                .replace("{x}", Integer.toString(x))
                .replace("{y}", Integer.toString(y));
    }

    private ResponseEntity<byte[]> fetchImage(String url, String style, int z, int x, int y) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set(HttpHeaders.USER_AGENT, "PatTool-MapTileProxy/1.0 (GPS 3D nav; contact via patrickdeschamps.com)");
            headers.set(HttpHeaders.ACCEPT, "image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5");
            headers.set(HttpHeaders.REFERER, "https://www.patrickdeschamps.com/");

            ResponseEntity<byte[]> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    byte[].class
            );
            byte[] body = response.getBody();
            if (!response.getStatusCode().is2xxSuccessful() || body == null || body.length == 0) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            HttpHeaders out = new HttpHeaders();
            MediaType contentType = response.getHeaders().getContentType();
            out.setContentType(contentType != null ? contentType : MediaType.IMAGE_PNG);
            out.setCacheControl(CacheControl.maxAge(Duration.ofHours(6)).cachePublic());
            return new ResponseEntity<>(body, out, HttpStatus.OK);
        } catch (HttpClientErrorException e) {
            log.debug("Map tile HTTP {} (style={}, z={}, x={}, y={})", e.getStatusCode(), style, z, x, y);
            return ResponseEntity.status(e.getStatusCode()).build();
        } catch (Exception e) {
            log.debug("Map tile fetch failed (style={}, z={}, x={}, y={}): {}", style, z, x, y, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }
}
