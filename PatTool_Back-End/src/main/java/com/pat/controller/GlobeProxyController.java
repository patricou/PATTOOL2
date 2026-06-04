package com.pat.controller;

import com.pat.service.GlobeProxyService;
import com.pat.service.GlobeProxyService.FetchedImage;
import com.pat.service.GlobeProxyService.PlanetTextureAsset;
import com.pat.service.IssPassLookupService;
import com.pat.service.IssTraceBackgroundScheduler;
import com.pat.service.IssTraceService;
import com.pat.service.IssTraceService.IssTracePointView;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * PatTool HTTP proxy for Earth globe textures, NASA imagery, Natural Earth boundaries, and ISS position
 * (browser does not call third-party hosts directly).
 */
@RestController
@RequestMapping("/api/external/globe")
public class GlobeProxyController {

    private static final Logger log = LoggerFactory.getLogger(GlobeProxyController.class);

    private final GlobeProxyService globeProxyService;
    private final IssTraceService issTraceService;
    private final IssPassLookupService issPassLookupService;
    private final IssTraceBackgroundScheduler issTraceBackgroundScheduler;

    public GlobeProxyController(
            GlobeProxyService globeProxyService,
            IssTraceService issTraceService,
            IssPassLookupService issPassLookupService,
            IssTraceBackgroundScheduler issTraceBackgroundScheduler) {
        this.globeProxyService = globeProxyService;
        this.issTraceService = issTraceService;
        this.issPassLookupService = issPassLookupService;
        this.issTraceBackgroundScheduler = issTraceBackgroundScheduler;
    }

    @GetMapping("/texture/planets/{name}")
    public ResponseEntity<byte[]> threeJsPlanetTexture(@PathVariable("name") String name) {
        PlanetTextureAsset asset = PlanetTextureAsset.fromPath(name);
        if (asset == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            FetchedImage img = globeProxyService.fetchThreeJsPlanetTexture(asset);
            return cacheableImage(img);
        } catch (Exception e) {
            log.debug("Planet texture {} failed: {}", name, e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/texture/satellite/bmng")
    public ResponseEntity<byte[]> nasaBmngBasemap() {
        try {
            FetchedImage img = globeProxyService.fetchSatelliteBasemap();
            return cacheableImage(img);
        } catch (Exception e) {
            log.debug("BMNG basemap failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /**
     * VIIRS true-colour composite (previous calendar day by default), suitable as a semi-transparent overlay.
     *
     * @param date optional UTC date {@code yyyy-MM-dd}; clamped to the last ~2 weeks server-side.
     */
    @GetMapping("/overlay/gibs/viirs")
    public ResponseEntity<byte[]> gibsViirsOverlay(@RequestParam(value = "date", required = false) String dateIso) {
        try {
            FetchedImage img = globeProxyService.fetchGibsViirsOverlay(dateIso);
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(1, TimeUnit.HOURS).cachePublic())
                    .contentType(img.contentType())
                    .body(img.body());
        } catch (Exception e) {
            log.debug("GIBS VIIRS overlay failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-boundaries-land")
    public ResponseEntity<byte[]> naturalEarth110mLandBoundaries() {
        try {
            byte[] body = globeProxyService.fetchNaturalEarth110mLandBoundaryGeoJson();
            MediaType geoJson =
                    MediaType.parseMediaType("application/geo+json; charset=UTF-8");
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic())
                    .contentType(geoJson)
                    .body(body);
        } catch (Exception e) {
            log.debug("Natural Earth boundaries GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-coastline")
    public ResponseEntity<byte[]> naturalEarth110mCoastline() {
        try {
            byte[] body = globeProxyService.fetchNaturalEarth110mCoastlineGeoJson();
            MediaType geoJson =
                    MediaType.parseMediaType("application/geo+json; charset=UTF-8");
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic())
                    .contentType(geoJson)
                    .body(body);
        } catch (Exception e) {
            log.debug("Natural Earth coastline GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-admin-0-countries")
    public ResponseEntity<byte[]> naturalEarth110mAdmin0Countries() {
        try {
            byte[] body = globeProxyService.fetchNaturalEarth110mAdmin0CountriesGeoJson();
            MediaType geoJson =
                    MediaType.parseMediaType("application/geo+json; charset=UTF-8");
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic())
                    .contentType(geoJson)
                    .body(body);
        } catch (Exception e) {
            log.debug("Natural Earth admin-0 countries GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-geographic-lines")
    public ResponseEntity<byte[]> naturalEarth110mGeographicLines() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth110mGeographicLinesGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth geographic lines GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-rivers-lake-centerlines")
    public ResponseEntity<byte[]> naturalEarth110mRiversLakeCenterlines() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth110mRiversLakeCenterlinesGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth rivers/lakes centerlines GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-50m-rivers-lake-centerlines")
    public ResponseEntity<byte[]> naturalEarth50mRiversLakeCenterlines() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth50mRiversLakeCenterlinesGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth 50m rivers/lakes centerlines GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-lakes")
    public ResponseEntity<byte[]> naturalEarth110mLakes() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth110mLakesGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth lakes GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-10m-lakes")
    public ResponseEntity<byte[]> naturalEarth10mLakes() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth10mLakesGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth 10m lakes GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-glaciated-areas")
    public ResponseEntity<byte[]> naturalEarth110mGlaciatedAreas() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth110mGlaciatedAreasGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth glaciated areas GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-110m-populated-places-simple")
    public ResponseEntity<byte[]> naturalEarth110mPopulatedPlacesSimple() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth110mPopulatedPlacesSimpleGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth populated places GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/geojson/ne-10m-time-zones")
    public ResponseEntity<byte[]> naturalEarth10mTimeZones() {
        try {
            return cacheableGeoJson7d(globeProxyService.fetchNaturalEarth10mTimeZonesGeoJson());
        } catch (Exception e) {
            log.debug("Natural Earth time zones GeoJSON failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /**
     * Next ISS visible passes for a place name (geocoded server-side via Nominatim, passes via Open Notify).
     *
     * @param index optional zero-based geocode candidate when several places match {@code q}
     */
    @GetMapping("/iss/passes-by-place")
    public ResponseEntity<byte[]> issPassesByPlace(
            @RequestParam("q") String placeQuery,
            @RequestParam(value = "n", defaultValue = "5") int passCount,
            @RequestParam(value = "index", required = false) Integer index) {
        try {
            byte[] body = issPassLookupService.lookupByPlace(placeQuery, passCount, index);
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(5, TimeUnit.MINUTES).cachePublic())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
        } catch (Exception e) {
            log.debug("ISS passes-by-place failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /** ISS visible passes for explicit coordinates (Open Notify, proxied). */
    @GetMapping("/iss/passes")
    public ResponseEntity<byte[]> issPasses(
            @RequestParam("lat") double lat,
            @RequestParam("lon") double lon,
            @RequestParam(value = "n", defaultValue = "5") int passCount) {
        try {
            byte[] body = issPassLookupService.lookupByCoordinates(lat, lon, passCount);
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(5, TimeUnit.MINUTES).cachePublic())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
        } catch (Exception e) {
            log.debug("ISS passes failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    @GetMapping("/iss/now")
    public ResponseEntity<byte[]> issNowOpenNotify() {
        try {
            byte[] body = globeProxyService.fetchOpenNotifyIssNow();
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic())
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
        } catch (Exception e) {
            log.debug("Open Notify ISS now failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
        }
    }

    /** Historical ISS ground track stored in MongoDB (retention configured server-side). */
    @GetMapping("/iss/trace")
    public ResponseEntity<IssTraceResponse> issHistoricalTrace() {
        try {
            List<IssTracePointView> points = issTraceService.getTraceForDisplay();
            return ResponseEntity.ok()
                    .cacheControl(CacheControl.maxAge(60, TimeUnit.SECONDS).cachePublic())
                    .body(new IssTraceResponse(
                            points,
                            issTraceService.getRetentionDays(),
                            issTraceService.getSampleIntervalSeconds()));
        } catch (Exception e) {
            log.warn("ISS historical trace read failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /** Persist one ISS sample while the globe overlay is active (deduped server-side). */
    @PostMapping("/iss/trace")
    public ResponseEntity<Void> recordIssTracePoint(@RequestBody IssTraceRecordRequest body) {
        if (body == null || body.latitude() == null || body.longitude() == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            Instant at;
            if (body.recordedAt() != null && !body.recordedAt().isBlank()) {
                try {
                    at = Instant.parse(body.recordedAt());
                } catch (Exception parseEx) {
                    return ResponseEntity.badRequest().build();
                }
            } else {
                at = Instant.now();
            }
            issTraceService.recordPoint(body.latitude(), body.longitude(), at);
            return ResponseEntity.noContent().build();
        } catch (Exception e) {
            log.warn("ISS trace record failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /**
     * Background ISS trace recording (server scheduler, MongoDB flag).
     * When enabled, samples are stored every {@link IssTraceBackgroundScheduler#getBackgroundIntervalMinutes()} minutes
     * even if no user has the globe page open.
     */
    @GetMapping("/iss/trace/background")
    public ResponseEntity<IssTraceBackgroundStatusResponse> issTraceBackgroundStatus() {
        return ResponseEntity.ok(new IssTraceBackgroundStatusResponse(
                issTraceBackgroundScheduler.isBackgroundEnabled(),
                issTraceBackgroundScheduler.getBackgroundIntervalMinutes()));
    }

    @PutMapping("/iss/trace/background")
    public ResponseEntity<IssTraceBackgroundStatusResponse> setIssTraceBackground(
            @RequestBody IssTraceBackgroundToggleRequest body) {
        if (body == null || body.enabled() == null) {
            return ResponseEntity.badRequest().build();
        }
        issTraceBackgroundScheduler.setBackgroundEnabled(body.enabled());
        return ResponseEntity.ok(new IssTraceBackgroundStatusResponse(
                issTraceBackgroundScheduler.isBackgroundEnabled(),
                issTraceBackgroundScheduler.getBackgroundIntervalMinutes()));
    }

    /** Delete all stored ISS trace samples. */
    @DeleteMapping("/iss/trace")
    public ResponseEntity<Void> clearIssHistoricalTrace() {
        try {
            issTraceService.clearAll();
            return ResponseEntity.noContent().build();
        } catch (Exception e) {
            log.warn("ISS trace clear failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    public record IssTraceRecordRequest(Double latitude, Double longitude, String recordedAt) {
    }

    public record IssTraceResponse(List<IssTracePointView> points, int retentionDays, int sampleIntervalSeconds) {
    }

    public record IssTraceBackgroundStatusResponse(boolean enabled, int intervalMinutes) {
    }

    public record IssTraceBackgroundToggleRequest(Boolean enabled) {
    }

    private static ResponseEntity<byte[]> cacheableGeoJson7d(byte[] body) {
        MediaType geoJson = MediaType.parseMediaType("application/geo+json; charset=UTF-8");
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(7, TimeUnit.DAYS).cachePublic())
                .contentType(geoJson)
                .body(body);
    }

    private static ResponseEntity<byte[]> cacheableImage(FetchedImage img) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(6, TimeUnit.HOURS).cachePublic())
                .contentType(img.contentType())
                .body(img.body());
    }
}
