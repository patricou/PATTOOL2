package com.pat.controller;

import com.pat.controller.dto.CompassCalibrationDto;
import com.pat.controller.dto.FlightStateDto;
import com.pat.controller.dto.FlightTrackDto;
import com.pat.controller.dto.FlightTrackingPreferenceDto;
import com.pat.service.CompassCalibrationService;
import com.pat.service.FlightTrackingPreferenceService;
import com.pat.service.OpenSkyService;
import com.pat.service.OpenSkyUnavailableException;
import com.pat.service.GlobeProxyService;
import com.pat.service.GlobeProxyService.FetchedImage;
import com.pat.service.GlobeProxyService.PlanetTextureAsset;
import com.pat.service.IssPassAlertService;
import com.pat.service.IssPassAlertService.AlertConfig;
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
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
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
import java.util.Optional;
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
    private final IssPassAlertService issPassAlertService;
    private final CompassCalibrationService compassCalibrationService;
    private final OpenSkyService openSkyService;
    private final FlightTrackingPreferenceService flightTrackingPreferenceService;

    public GlobeProxyController(
            GlobeProxyService globeProxyService,
            IssTraceService issTraceService,
            IssPassLookupService issPassLookupService,
            IssTraceBackgroundScheduler issTraceBackgroundScheduler,
            IssPassAlertService issPassAlertService,
            CompassCalibrationService compassCalibrationService,
            OpenSkyService openSkyService,
            FlightTrackingPreferenceService flightTrackingPreferenceService) {
        this.globeProxyService = globeProxyService;
        this.issTraceService = issTraceService;
        this.issPassLookupService = issPassLookupService;
        this.issTraceBackgroundScheduler = issTraceBackgroundScheduler;
        this.issPassAlertService = issPassAlertService;
        this.compassCalibrationService = compassCalibrationService;
        this.openSkyService = openSkyService;
        this.flightTrackingPreferenceService = flightTrackingPreferenceService;
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

    /**
     * Display point-count limit for the historical ISS trace (MongoDB flag).
     * When enabled (default), {@link #issHistoricalTrace()} returns at most
     * {@link IssTraceService#getLimitedDisplayPoints()} points; when disabled, every stored point is returned.
     */
    @GetMapping("/iss/trace/display-limit")
    public ResponseEntity<IssTraceDisplayLimitResponse> issTraceDisplayLimitStatus() {
        return ResponseEntity.ok(new IssTraceDisplayLimitResponse(
                issTraceService.isDisplayLimitEnabled(),
                issTraceService.getLimitedDisplayPoints()));
    }

    @PutMapping("/iss/trace/display-limit")
    public ResponseEntity<IssTraceDisplayLimitResponse> setIssTraceDisplayLimit(
            @RequestBody IssTraceDisplayLimitToggleRequest body) {
        if (body == null || body.enabled() == null) {
            return ResponseEntity.badRequest().build();
        }
        issTraceService.setDisplayLimitEnabled(body.enabled());
        return ResponseEntity.ok(new IssTraceDisplayLimitResponse(
                issTraceService.isDisplayLimitEnabled(),
                issTraceService.getLimitedDisplayPoints()));
    }

    /**
     * Current ISS visible-pass e-mail alert configuration (place watched, recipient, quality threshold).
     */
    @GetMapping("/iss/alert")
    public ResponseEntity<AlertConfig> issAlertConfig() {
        return ResponseEntity.ok(issPassAlertService.getConfig());
    }

    /**
     * Update the ISS alert configuration. When {@code place} changes it is geocoded server-side
     * (Nominatim) and the resolved coordinates are stored.
     */
    @PutMapping("/iss/alert")
    public ResponseEntity<?> setIssAlertConfig(@RequestBody IssAlertConfigRequest body) {
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            AlertConfig updated = issPassAlertService.updateConfig(
                    body.enabled(), body.email(), body.place(), body.minQuality());
            return ResponseEntity.ok(updated);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(new IssAlertErrorResponse(e.getMessage()));
        } catch (Exception e) {
            log.warn("ISS alert config update failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(new IssAlertErrorResponse("update_failed"));
        }
    }

    /** Send a test alert e-mail for the next upcoming visible pass over the configured place. */
    @PostMapping("/iss/alert/test")
    public ResponseEntity<IssAlertTestResponse> sendIssAlertTest() {
        String status = issPassAlertService.sendTestForNextPass();
        boolean ok = "sent".equals(status);
        return ResponseEntity.ok(new IssAlertTestResponse(ok, status));
    }

    /**
     * Calage du Nord de la boussole ISS de l'utilisateur courant (par {@code sub} JWT).
     * Renvoie 204 (No Content) si aucun calage n'est mémorisé ou si l'appel est anonyme :
     * la boussole repart alors « non calée ».
     */
    @GetMapping("/iss/compass/calibration")
    public ResponseEntity<CompassCalibrationDto> getCompassCalibration() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.noContent().build();
        }
        return compassCalibrationService.findForSubject(sub)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /**
     * Mémorise le calage du Nord choisi par l'utilisateur (méthode capteurs ou manuelle),
     * de sorte qu'il n'ait pas à recaler à chaque ouverture de la boussole.
     */
    @PutMapping("/iss/compass/calibration")
    public ResponseEntity<CompassCalibrationDto> setCompassCalibration(@RequestBody CompassCalibrationDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            CompassCalibrationDto saved = compassCalibrationService.saveForSubject(sub, body);
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        } catch (Exception e) {
            log.warn("Compass calibration save failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /** Oublie le calage du Nord mémorisé pour l'utilisateur courant. */
    @DeleteMapping("/iss/compass/calibration")
    public ResponseEntity<Void> deleteCompassCalibration() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        compassCalibrationService.deleteForSubject(sub);
        return ResponseEntity.noContent().build();
    }

    /* ===================================================================== */
    /* Flight tracking (OpenSky Network): current state + per-user preference. */
    /* ===================================================================== */

    /**
     * Current flight state via OpenSky. {@code mode=callsign} (callsign / flight number) or
     * {@code mode=icao24} (hex address). Returns 404 if the flight is not found / not reachable,
     * 400 if the request is invalid.
     */
    @GetMapping("/flight/state")
    public ResponseEntity<FlightStateDto> flightState(
            @RequestParam("mode") String mode,
            @RequestParam("q") String query) {
        String normalizedMode = mode == null ? "" : mode.trim().toLowerCase(java.util.Locale.ROOT);
        if (query == null || query.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        Optional<FlightStateDto> state;
        switch (normalizedMode) {
            case "icao24" -> {
                if (!OpenSkyService.isValidIcao24(query)) {
                    return ResponseEntity.badRequest().build();
                }
                try {
                    state = openSkyService.fetchByIcao24(query);
                } catch (OpenSkyUnavailableException e) {
                    return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
                }
            }
            case "callsign" -> {
                if (!OpenSkyService.isValidCallsign(query)) {
                    return ResponseEntity.badRequest().build();
                }
                try {
                    state = openSkyService.fetchByCallsign(query);
                } catch (OpenSkyUnavailableException e) {
                    return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
                }
            }
            default -> {
                return ResponseEntity.badRequest().build();
            }
        }
        return state
                .map(dto -> ResponseEntity.ok()
                        .cacheControl(CacheControl.noStore())
                        .body(dto))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Full flight trajectory (OpenSky {@code /tracks/all}) from departure to arrival.
     * {@code time=0} (default): live track if the flight is in progress.
     */
    @GetMapping("/flight/track")
    public ResponseEntity<FlightTrackDto> flightTrack(
            @RequestParam("icao24") String icao24,
            @RequestParam(value = "time", defaultValue = "0") long time) {
        if (!OpenSkyService.isValidIcao24(icao24)) {
            return ResponseEntity.badRequest().build();
        }
        return openSkyService.fetchTrackByIcao24(icao24, time)
                .map(dto -> ResponseEntity.ok()
                        .cacheControl(CacheControl.noStore())
                        .body(dto))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Last flight tracked by the current user (JWT {@code sub}).
     * Returns 204 (No Content) if nothing is stored or the call is anonymous.
     */
    @GetMapping("/flight/tracking")
    public ResponseEntity<FlightTrackingPreferenceDto> getFlightTracking() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.noContent().build();
        }
        return flightTrackingPreferenceService.findForSubject(sub)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** Stores the last tracked flight (mode + callsign/hex + interval) for the current user. */
    @PutMapping("/flight/tracking")
    public ResponseEntity<FlightTrackingPreferenceDto> setFlightTracking(
            @RequestBody FlightTrackingPreferenceDto body) {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (body == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            FlightTrackingPreferenceDto saved = flightTrackingPreferenceService.saveForSubject(sub, body);
            return ResponseEntity.ok(saved);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        } catch (Exception e) {
            log.warn("Flight tracking save failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    /** Clears the stored last tracked flight for the current user. */
    @DeleteMapping("/flight/tracking")
    public ResponseEntity<Void> deleteFlightTracking() {
        String sub = currentJwtSubject();
        if (sub == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        flightTrackingPreferenceService.deleteForSubject(sub);
        return ResponseEntity.noContent().build();
    }

    /** Identifiant ({@code sub}) de l'utilisateur Keycloak courant, ou {@code null} si anonyme. */
    private static String currentJwtSubject() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        return jwt.getSubject();
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

    public record IssTraceDisplayLimitResponse(boolean enabled, int maxPoints) {
    }

    public record IssTraceDisplayLimitToggleRequest(Boolean enabled) {
    }

    public record IssAlertConfigRequest(Boolean enabled, String email, String place, String minQuality) {
    }

    public record IssAlertErrorResponse(String error) {
    }

    public record IssAlertTestResponse(boolean ok, String status) {
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
