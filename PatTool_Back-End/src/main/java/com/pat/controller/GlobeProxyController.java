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
 * PatTool HTTP proxy for Earth globe textures and NASA imagery (no direct browser calls to third parties).
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

    private static ResponseEntity<byte[]> cacheableImage(FetchedImage img) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.maxAge(6, TimeUnit.HOURS).cachePublic())
                .contentType(img.contentType())
                .body(img.body());
    }
}
