package com.pat.controller;

import com.pat.service.GlobeProxyService;
import com.pat.service.GlobeProxyService.FetchedImage;
import com.pat.service.GlobeProxyService.PlanetTextureAsset;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

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

    public GlobeProxyController(GlobeProxyService globeProxyService) {
        this.globeProxyService = globeProxyService;
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
